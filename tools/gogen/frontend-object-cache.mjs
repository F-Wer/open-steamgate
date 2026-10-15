import {artifactLowering, storedProvenance, inheritStoredProvenance, provenanceOf, recordingProvenance} from "./frontend-provenance.mjs";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";
// Portable class lowerings. The registry still parses/checks normally; replay
// verifies the program inputs and ordering before applying cached IR effects.
import {createHash, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {artifactDigestOf} from "./frontend-artifact-digests.mjs";
import {sourceKeys} from "./frontend-source-key.mjs";

const here = import.meta.dirname, home = resolve(here, "../..");
const automatic = new WeakMap();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const walk = (dir) => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
let identity;
export function toolIdentity() {
  if (identity) return identity;
  const hash = createHash("sha256").update("gogen-object-cache-2");
  // Actual tool sources, locks and installed builds define the compiler.
  // Repository commits (including docs-only ones) do not change its identity.
  for (const file of walk(join(home, "tools")).filter((f) => /\.(mjs|ts|cjs|json)$/.test(f))) {
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
// Bound cache validation well below V8's Set limit; oversized lowerings compile normally.
const PORTABLE_NODE_BUDGET = 1 << 20;
export function portable(value) {
  return portableWithin(value, new Set());
}
function portableWithin(value, seen) {
  const stack = [{values: [value].values()}];
  try {
    while (stack.length) {
      const frame = stack.at(-1), next = frame.values.next();
      if (next.done) { stack.pop(); continue; }
      if (frame.map) {
        const [key, value] = next.value;
        if (key !== null && typeof key === "object") return false;
        stack.push({values: [key, value].values()});
        continue;
      }
      const value = next.value;
      if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) continue;
      if (typeof value !== "object") return false;
      if (seen.has(value)) continue;
      if (seen.size >= PORTABLE_NODE_BUDGET) return false;
      seen.add(value);
      if (value instanceof Map) stack.push({values: [...value].values(), map: true});
      else if (value instanceof Set) stack.push({values: [...value].values()});
      else {
        if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
        stack.push({values: Object.values(value).values()});
      }
    }
    return true;
  } catch { return false; } // An unreadable value must not break compilation either.
}

const primitiveArgument = (a) => a === null || ["undefined", "string", "number", "boolean"].includes(typeof a);

// Rechecking the same input twice without an intervening write adds no guard.
// Nested mutations already refuse replay; writes validate the compacted result.
export function compactLowering(value) {
  if (!value.replay) return value;
  const seen = new Map(), ops = [], argumentsSeen = new Set();
  for (const op of value.replay.ops) {
    if (op.kind === "assign" || op.kind === "effect") seen.delete(op.key);
    else {
      // Refuse registry instances before JSON can expand their shared graphs.
      // Share the bounded walk across all reads, including discarded duplicates;
      // all-primitive arguments are cheap to serialize and spend no budget.
      if (!(op.args ?? []).every(primitiveArgument) && !portableWithin(op.args, argumentsSeen)) throw new TypeError("Non-portable replay arguments");
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

// Every registry edit names a new version directory, so old ones pile up (a
// one-class edit doubled a 386 MiB cache). Keep the newest few, by the time a
// compile last opened them, and never one opened within the last hour: two
// shards with different registries may share a root and run side by side.
// A directory removed under a running compile is a miss for it, not an error:
// reads fall back to lowering and writes recreate the directory. Each victim
// is stat'ed again and renamed away before the recursive delete, so one that
// another compile touched meanwhile survives; the window left is that rename.
const KEEP_VERSIONS = Math.max(1, Number(process.env.GOGEN_CACHE_KEEP_VERSIONS) || 4);
const RECENT_MS = 60 * 60 * 1000, TOUCH_MS = 10 * 60 * 1000;
const touch = (dir) => { try { const now = new Date(); utimesSync(dir, now, now); } catch { /* Not written yet. */ } };
function pruneVersions(root, current) {
  try {
    const versions = readdirSync(root, {withFileTypes: true})
      .filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name) && e.name !== current)
      .map((e) => ({name: e.name, used: statSync(join(root, e.name)).mtimeMs}))
      .sort((a, b) => b.used - a.used);
    for (const {name} of versions.slice(KEEP_VERSIONS - 1)) try {
      const dir = join(root, name);
      if (Date.now() - statSync(dir).mtimeMs <= RECENT_MS) continue;
      const trash = join(root, `.pruned-${randomUUID()}`);
      renameSync(dir, trash);
      rmSync(trash, {recursive: true, force: true});
    } catch { /* Gone already, or in use again. */ }
    for (const e of readdirSync(root)) if (e.startsWith(".pruned-")) rmSync(join(root, e), {recursive: true, force: true});
  } catch { /* Cache housekeeping must not change compilation. */ }
}

export function objectCache(registry, root) {
  if (!root) return;
  // Test-only. No other environment variable may enable weakened cache keys.
  const faultSpec = process.env.GOGEN_CACHE_ORACLE_FAULT;
  const fault = faultSpec === "fingerprint-location-only" ? undefined
    : faultSpec === "no-version,fingerprint-location-only" ? "no-version" : faultSpec;
  const drop = fault?.startsWith("drop:") ? new RegExp(fault.slice(5)) : undefined;
  if (fault && !["no-version", "sorted-files"].includes(fault) && !drop)
    throw new Error(`unknown GOGEN_CACHE_ORACLE_FAULT: ${fault}`);
  const objects = new Map(), byName = new Map();
  for (const obj of registry.getObjects()) {
    const key = `${obj.getType()} ${obj.getName().toUpperCase()}`;
    // Macro collection keeps the first definition in registry input order.
    // Sorting these files would hide an order edit even from the global guard.
    const sources = obj.getFiles().map((f) => [f.getFilename(), f.getRaw()]);
    if (fault === "sorted-files") sources.sort(([a], [b]) => a.localeCompare(b));
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
  // Test-only fault injection: demonstrate that the oracle detects semantic
  // dependencies missing from source words / lowering-time getObject reads.
  // Never enable this outside cache-oracle tests.
  const version = digest(JSON.stringify([toolIdentity(), registry.getConfig().get(),
    fault === "no-version" || drop ? [] : semanticInputs]));
  const sourceKey = sourceKeys(objects, byName, version, drop);
  // Opening marks the version used, and so does a hit every few minutes, so
  // a long warm run that writes nothing is not taken for an abandoned one.
  let touched = Date.now();
  touch(join(root, version));
  pruneVersions(root, version);
  const location = (owner, name, selection = "") => join(root, version, digest(`${owner}:${name}:${selection}`) + ".bin");
  const selection = (program) => digest(JSON.stringify([...program.wanted]));
  const wholeSelection = (value) => value.replay?.ops.some((op) => op.key === "wanted"
    && (op.kind === "measure" || (op.kind === "read" && !op.method)));
  const pending = [];
  const cache = {
    begin() { pending.length = 0; },
    read(owner, name, program) {
      // Keep a separate variant only when lowering read the complete closure.
      // Membership-only transcripts remain reusable across different shards.
      for (const variant of ["", selection(program)]) try {
        const bytes = readFileSync(location(owner, name, variant));
        const payload = bytes.subarray(65);
        if (bytes.subarray(0, 64).toString() !== digest(payload)) continue;
        const entry = deserialize(inflateRawSync(payload));
        if (entry.key === sourceKey(owner, entry.reads) && portable(entry.value)) {
          if (Date.now() - touched > TOUCH_MS) { touched = Date.now(); touch(join(root, version)); }
          return entry.value;
        }
      } catch { /* Missing, partial or incompatible cache: lower normally. */ }
    },
    record(lower) {
      const reads = new Set(), original = registry.getObject;
      const descriptor = Object.getOwnPropertyDescriptor(registry, "getObject");
      registry.getObject = function(type, name) {
        const value = original.call(this, type, name);
        const key = type && name && `${type.toUpperCase()} ${name.toUpperCase()}`;
        if (key && !drop?.test(key)) reads.add(key);
        return value;
      };
      try { return {value: lower(), reads: [...reads]}; }
      finally {
        if (descriptor) Object.defineProperty(registry, "getObject", descriptor);
        else delete registry.getObject;
      }
    },
    write(owner, value, reads, program) {
      if (!recordingProvenance() || !program.reg) { cache.persist({owner, value, reads, program}); return; }
      // Freeze the lowering now, as the old immediate writer did. Later owners
      // may mutate shared IR/effect values before final provenance is available.
      try {
        value = compactLowering(value);
        if (!portable(value)) return;
        value = structuredClone(value);
      } catch { return; }
      pending.push({owner, value, reads: [...reads], program: {wanted: new Set(program.wanted)}});
    },
    finish(program) {
      if (!pending.length) return;
      const manifests = provenanceOf(program, {internal: true});
      const fileOwners = new Map([...registry.getObjects()].flatMap((o) => o.getFiles().map((f) => [f.getFilename(), `${o.getType()} ${o.getName().toUpperCase()}`])));
      const owners = new Set(fileOwners.values());
      for (const entry of pending.splice(0)) {
        const manifest = manifests.get(entry.owner), keys = new Set();
        for (const hit of manifest?.hits ?? []) for (const result of hit.result) {
          const key = owners.has(result) ? result : fileOwners.get(result);
          if (key) keys.add(key);
        }
        const dependencies = [...keys].sort().map((key) => [key, artifactDigestOf(registry, key)]);
        const ownerDigest = artifactDigestOf(registry, entry.owner);
        entry.metadata = {format: "gogen-dependency-digests-1", owner: entry.owner, entry: entry.value.name,
          artifactDigest: ownerDigest,
          dependencyDigests: Object.fromEntries(dependencies),
          provenanceComplete: !!manifest && manifest.unknownScans.length === 0
            && !!ownerDigest && dependencies.every(([, digest]) => !!digest)};
        cache.persist(entry);
      }
    },
    persist({owner, value, reads, program, metadata}) {
      // Repeated reads can exceed the budget before compaction. A transcript
      // with unserializable arguments must still fall back to ordinary lowering.
      try { value = compactLowering(value); } catch { return; }
      if (!portable(value)) return;
      const file = location(owner, value.name, wholeSelection(value) ? selection(program) : ""), temp = `${file}.${randomUUID()}.pending`;
      try {
        mkdirSync(join(root, version), {recursive: true});
        const payload = deflateRawSync(serialize({key: sourceKey(owner, reads), reads, ...(metadata ? {metadata} : {}), value}), {level: 1});
        writeFileSync(temp, Buffer.concat([Buffer.from(digest(payload) + "\n"), payload]));
        renameSync(temp, file);
      } catch { /* Cache availability must not change compilation. */ }
      finally { try { rmSync(temp, {force: true}); } catch { /* Unavailable root. */ } }
    },
  };
  return cache;
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
  session.disk?.begin();
}

function suppliedKey(program, owner) {
  return JSON.stringify([...program.supplied].filter(([k]) => k.startsWith(`${owner}=>`)).map(([k, v]) => [k, [...v]]));
}

export const compileDiskClass = artifactLowering(function compileDiskClass(ctx, obj, lower, session) {
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
    inheritStoredProvenance(program.reg, obj, cached.provenance);
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
    entry.provenance = storedProvenance(program.reg, obj);
    const {file: ignoredFile, structure: ignoredStructure, ...portable} = entry;
    session.disk.write(owner, {...portable, name: key}, reads, program);
  }
  return value;
});
