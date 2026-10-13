import {recordLowering, replayLowering} from "./frontend-replay.mjs";
// Portable class lowerings. The registry still parses/checks normally; replay
// verifies the program inputs and ordering before applying cached IR effects.
import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {sourceKeys} from "./frontend-source-key.mjs";

const here = import.meta.dirname, home = resolve(here, "../..");
const automatic = new WeakMap();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const walk = (dir) => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
let identity;
function toolIdentity() {
  if (identity) return identity;
  const hash = createHash("sha256").update("gogen-object-cache-2");
  // Include the requested git tree identity and OSG pin, plus actual sources:
  // a development edit must not reuse an entry made before the edit.
  try {
    for (const args of [["rev-parse", "HEAD"], ["rev-parse", "HEAD:tools/gogen"]])
      hash.update(execFileSync("git", args, {cwd: home, encoding: "utf8", stdio: "pipe"}).trim());
  } catch { hash.update("unversioned"); }
  for (const file of [...walk(here), ...readdirSync(join(home, "tools")).filter((f) => /\.(mjs|ts)$/.test(f)).map((f) => join(home, "tools", f))]
    .filter((f) => /\.(mjs|ts)$/.test(f)).sort()) {
    hash.update(file.slice(home.length)); hash.update(readFileSync(file));
  }
  for (const name of ["package-lock.json", "libs.lock.json"]) if (existsSync(join(home, name))) hash.update(readFileSync(join(home, name)));
  const require = createRequire(import.meta.url);
  const tr = require.resolve("@abaplint/transpiler/package.json");
  for (const path of [tr, createRequire(tr).resolve("@abaplint/core/package.json")]) {
    hash.update(readFileSync(path));
    for (const file of walk(join(path, "..", "build"))) { hash.update(file.slice(path.length)); hash.update(readFileSync(file)); }
  }
  return identity = hash.digest("hex");
}

// Preserve only data that can be replayed against a different registry. In
// particular, abaplint type identities in anonymous-structure keys are unsafe.
function portable(value, seen = new Set()) {
  if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (value instanceof Map) return [...value].every(([k, v]) => (k === null || typeof k !== "object") && portable(k, seen) && portable(v, seen));
  if (value instanceof Set) return [...value].every((v) => portable(v, seen));
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.values(value).every((v) => portable(v, seen));
}

// Rechecking the same input twice without an intervening write adds no guard.
// Compact only portable transcripts; nested mutations already refuse replay.
export function compactLowering(value) {
  if (!value.replay) return value;
  const seen = new Map(), ops = [];
  for (const op of value.replay.ops) {
    if (op.kind === "assign" || op.kind === "effect") seen.delete(op.key);
    else {
      if (!seen.has(op.key)) seen.set(op.key, new Map());
      const reads = seen.get(op.key), access = JSON.stringify([op.kind, op.method, op.args]);
      if (!reads.has(access)) reads.set(access, new Set());
      if (reads.get(access).has(op.value)) continue;
      reads.get(access).add(op.value);
    }
    ops.push(op);
  }
  return {...value, replay: {...value.replay, ops}};
}

export function cacheSession(session, registry, cacheDir) {
  if (!cacheDir) { if (session) delete session.cacheDir; return session; }
  if (!session) {
    session = automatic.get(registry);
    if (!session) automatic.set(registry, session = {});
  }
  session.cacheDir = resolve(cacheDir);
  return session;
}

export function objectCache(registry, root) {
  if (!root) return;
  const objects = new Map(), byName = new Map();
  for (const obj of registry.getObjects()) {
    const key = `${obj.getType()} ${obj.getName().toUpperCase()}`;
    const sources = obj.getFiles().map((f) => [f.getFilename(), f.getRaw()]).sort(([a], [b]) => a.localeCompare(b));
    const words = new Set(sources.flatMap(([, raw]) => raw.toUpperCase().match(/(?:\/[A-Z0-9_]+\/)?[A-Z_][A-Z0-9_]*/g) ?? []));
    objects.set(key, {hash: digest(JSON.stringify(sources)), words});
    if (!byName.has(obj.getName().toUpperCase())) byName.set(obj.getName().toUpperCase(), []);
    byName.get(obj.getName().toUpperCase()).push(key);
  }
  // Lowering reads parsed definitions/structures whose semantic inputs may
  // already have been resolved by abaplint (macros, includes, type pools).
  // A getObject transcript alone cannot recover those prior reads. Guard
  // every such artifact with all registry sources, including ordering and
  // absent objects; never infer independence from the main file's text.
  const semanticInputs = [...objects].map(([k, v]) => [k, v.hash]);
  const version = digest(JSON.stringify([toolIdentity(), registry.getConfig().get(), semanticInputs]));
  const sourceKey = sourceKeys(objects, byName, version);
  const location = (owner, name, selection = "") => join(root, version, digest(`${owner}:${name}:${selection}`) + ".bin");
  const selection = (program) => digest(JSON.stringify([...program.wanted]));
  const wholeSelection = (value) => value.replay?.ops.some((op) => op.key === "wanted"
    && (op.kind === "measure" || (op.kind === "read" && !op.method)));
  return {
    read(owner, name, program) {
      // Keep a separate variant only when lowering read the complete closure.
      // Membership-only transcripts remain reusable across different shards.
      for (const variant of ["", selection(program)]) try {
        const bytes = readFileSync(location(owner, name, variant));
        const payload = bytes.subarray(65);
        if (bytes.subarray(0, 64).toString() !== digest(payload)) continue;
        const entry = deserialize(inflateRawSync(payload));
        if (entry.key === sourceKey(owner, entry.reads) && portable(entry.value)) return entry.value;
      } catch { /* Missing, partial or incompatible cache: lower normally. */ }
    },
    record(lower) {
      const reads = new Set(), original = registry.getObject;
      registry.getObject = function(type, name) {
        const value = original.call(this, type, name);
        if (type && name) reads.add(`${type.toUpperCase()} ${name.toUpperCase()}`);
        return value;
      };
      try { return {value: lower(), reads: [...reads]}; }
      finally { registry.getObject = original; }
    },
    write(owner, value, reads, program) {
      if (!portable(value)) return;
      value = compactLowering(value);
      const file = location(owner, value.name, wholeSelection(value) ? selection(program) : ""), temp = `${file}.${randomUUID()}.pending`;
      try {
        mkdirSync(join(root, version), {recursive: true});
        const payload = deflateRawSync(serialize({key: sourceKey(owner, reads), reads, value}), {level: 1});
        writeFileSync(temp, Buffer.concat([Buffer.from(digest(payload) + "\n"), payload]));
        renameSync(temp, file);
      } catch { /* Cache availability must not change compilation. */ }
      finally { try { rmSync(temp, {force: true}); } catch { /* Unavailable root. */ } }
    },
  };
}

const current = new Set(["currentClass", "currentOwner", "currentTypes"]);
export function prepareDiskSession(session, registry) {
  if (!session) return;
  // Non-ABAP artifacts can remain dirty after parse(). File identity and
  // immutable Config identity detect actual edits without clearing a valid
  // session on every closure round because of those unrelated artifacts.
  const files = [...registry.getObjects()].flatMap((o) => o.getFiles());
  if (session.registry !== registry || session.config !== registry.getConfig()
      || files.length !== session.files?.length || files.some((f, i) => f !== session.files[i])) {
    const cacheDir = session.cacheDir;
    for (const key of Object.keys(session)) delete session[key];
    Object.assign(session, {registry, config: registry.getConfig(), files, classes: new Map()});
    if (cacheDir) Object.assign(session, {cacheDir, diskRoot: cacheDir, disk: objectCache(registry, cacheDir)});
  }
  if (session.diskRoot !== session.cacheDir) {
    session.classes.clear();
    if (!session.cacheDir) {
      delete session.diskRoot;
      delete session.disk;
      return;
    }
    session.diskRoot = session.cacheDir;
    session.disk = objectCache(registry, session.cacheDir);
  }
}

function suppliedKey(program, owner) {
  return JSON.stringify([...program.supplied].filter(([k]) => k.startsWith(`${owner}=>`)).map(([k, v]) => [k, [...v]]));
}

export function compileDiskClass(ctx, obj, lower, session) {
  const program = ctx.program;
  const counts = program.frontendCounts;
  const file = obj.getMainABAPFile();
  const key = obj.getName().toUpperCase();
  const owner = `${obj.obj?.getType?.() ?? obj.getType?.() ?? "CLAS"} ${obj.owner ?? key}`;
  let cached = session?.classes.get(key);
  const replay = (entry) => entry && entry.file === file && entry.structure === file.getStructure()
    && entry.supplied === suppliedKey(program, key) && entry.replay && replayLowering(program, entry.replay);
  let valid = replay(cached);
  if (!valid) {
    const stored = session?.disk?.read(owner, key, program);
    cached = stored?.name === key ? {...stored, file, structure: file.getStructure()} : undefined;
    valid = replay(cached);
  }
  if (valid) {
    Object.assign(program, cached.current);
    counts.reused++;
    counts.reusedClasses.push(key);
    session?.classes.set(key, cached);
    return cached.ir;
  }
  counts.lowered++;
  counts.loweredClasses.push(key);
  session?.classes.delete(key);
  const run = () => {
    const recorded = session ? recordLowering(program, (tracked) => lower({...ctx, program: tracked}, obj)) : undefined;
    const ir = recorded ? recorded.ir : lower(ctx, obj);
    if (recorded?.replay) session.classes.set(key, {file, structure: file.getStructure(), ir,
      replay: recorded.replay, supplied: suppliedKey(program, key),
      current: Object.fromEntries([...current].map((k) => [k, program[k]]))});
    return ir;
  };
  if (!session?.disk) return run();
  const {value, reads} = session.disk.record(run);
  const entry = session.classes.get(key);
  if (entry) {
    const {file: ignoredFile, structure: ignoredStructure, ...portable} = entry;
    session.disk.write(owner, {...portable, name: key}, reads, program);
  }
  return value;
}
