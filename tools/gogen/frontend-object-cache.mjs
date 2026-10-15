import {artifactLowering, storedProvenance, inheritStoredProvenance, recordingProvenance} from "./frontend-provenance.mjs";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";
// Portable class lowerings. The registry still parses/checks normally; replay
// verifies the program inputs and ordering before applying cached IR effects.
import {createHash, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {dependencyGraph} from "./frontend-provenance-metadata.mjs";
import {inputSnapshot} from "./frontend-inventory.mjs";
import {sourceKeys} from "./frontend-source-key.mjs";
import {shadowCache, borrowedOwners} from "./frontend-v3-shadow.mjs";
import {hashV3, graphRawFiles} from "./frontend-v3-key.mjs";

const here = import.meta.dirname, home = resolve(here, "../..");
const automatic = new WeakMap();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const walk = (dir) => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const identities = new Map();
let sharedIdentity;
export function toolIdentity(sourceIndependent = false) {
  if (identities.has(sourceIndependent)) return identities.get(sourceIndependent);
  if (!sharedIdentity) {
    const hash = createHash("sha256").update("gogen-object-cache-tool-3");
    const fileHash = (name, file) => hash.update(JSON.stringify([name, digest(readFileSync(file))]));
    // Actual tool sources, locks and installed builds define the compiler.
    // Repository commits (including docs-only ones) do not change its identity.
    for (const file of walk(join(home, "tools")).filter((f) => /\.(mjs|ts|cjs|json)$/.test(f))) {
      fileHash(file.slice(home.length), file);
    }
    if (existsSync(join(home, "package-lock.json"))) fileHash("package-lock.json", join(home, "package-lock.json"));
    const require = createRequire(import.meta.url);
    const tr = require.resolve("@abaplint/transpiler/package.json");
    for (const path of [tr, createRequire(tr).resolve("@abaplint/core/package.json")]) {
      fileHash("installed-package", path);
      for (const file of walk(join(path, "..", "build"))) fileHash(file.slice(path.length), file);
    }
    sharedIdentity = hash.update(JSON.stringify([process.versions.node, process.versions.v8])).digest("hex");
  }
  // Both variants share actual file hashes: the lazy v3 identity never walks
  // the tools/installed builds again. Source pins remain per-artifact in v3.
  const pins = !sourceIndependent && existsSync(join(home, "libs.lock.json"))
    ? digest(readFileSync(join(home, "libs.lock.json"))) : null;
  const identity = digest(JSON.stringify([sharedIdentity, pins]));
  identities.set(sourceIndependent, identity); return identity;
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
  // AUDITED cache inventory: source guards, never semantic dependencies.
  for (const [key, {obj, dependency, sources: inputs}] of inputSnapshot(registry).objects) {
    // Macro collection keeps the first definition in registry input order.
    // Sorting these files would hide an order edit even from the global guard.
    const sources = inputs.map((s) => [s.name, s.raw]);
    if (fault === "sorted-files") sources.sort(([a], [b]) => a.localeCompare(b));
    const words = new Set(sources.flatMap(([, raw]) => raw.toUpperCase().match(/(?:\/[A-Z0-9_]+\/)?[A-Z_][A-Z0-9_]*/g) ?? []));
    objects.set(key, {hash: digest(JSON.stringify(sources)), words, dependency});
    if (!byName.has(obj.getName().toUpperCase())) byName.set(obj.getName().toUpperCase(), []);
    byName.get(obj.getName().toUpperCase()).push(key);
  }
  // Lowering reads parsed definitions/structures whose semantic inputs may
  // already have been resolved by abaplint (macros, includes, type pools).
  // A getObject transcript alone cannot recover those prior reads. Guard
  // every such artifact with all registry sources, including ordering and
  // absent objects; never infer independence from the main file's text.
  const semanticInputs = [...objects].map(([k, v]) => [k, v.dependency, v.hash]);
  // Test-only fault injection: demonstrate that the oracle detects semantic
  // dependencies missing from source words / lowering-time getObject reads.
  // Never enable this outside cache-oracle tests.
  // This content certificate names the generation directory. JSON framing
  // binds ordered effective object/role/file/raw-text hashes to config/tools;
  // it uses the loaded snapshot, never a stat or a separate disk scan. A new
  // domain ignores old generations without changing their payload format.
  // Selection and supplied/program state still pass replay guards. Source
  // positions stay in the IR for both emission line modes.
  const version = digest(JSON.stringify(["gogen-global-content-1", toolIdentity(), registry.getConfig().get(),
    fault === "no-version" || drop ? [] : semanticInputs]));
  const sourceKey = sourceKeys(objects, byName, version, drop);
  const shadow = recordingProvenance() ? shadowCache(registry, root,
    () => hashV3(["gogen-entry-3", toolIdentity(true), registry.getConfig().get()]), portable) : undefined;
  // Opening marks the version used, and so does a hit every few minutes, so
  // a long warm run that writes nothing is not taken for an abandoned one.
  let touched = Date.now();
  touch(join(root, version));
  pruneVersions(root, version);
  const location = (owner, name, selection = "") => join(root, version, digest(`${owner}:${name}:${selection}`) + ".bin");
  const selection = (program) => digest(JSON.stringify([...program.wanted]));
  const wholeSelection = (value) => value.replay?.ops.some((op) => op.key === "wanted"
    && (op.kind === "measure" || (op.kind === "read" && !op.method)));
  const pending = [], provenanceGraphs = new Map();
  const cache = {
    shadow,
    begin() { pending.length = 0; shadow?.reset(); },
    read(owner, name, program) {
      // Keep a separate variant only when lowering read the complete closure.
      // Membership-only transcripts remain reusable across different shards.
      for (const variant of ["", selection(program)]) try {
        const bytes = readFileSync(location(owner, name, variant));
        const payload = bytes.subarray(65);
        if (bytes.subarray(0, 64).toString() !== digest(payload)) continue;
        const entry = deserialize(inflateRawSync(payload));
        if (entry.valueBytes) entry.value = {...deserialize(entry.valueBytes), ...entry.value};
        if (entry.metadata?.graph) {
          const id = entry.metadata.graph;
          if (!provenanceGraphs.has(id)) {
            const graphBytes = readFileSync(join(root, version, `${id}.provenance`));
            if (digest(graphBytes) !== id) continue;
            provenanceGraphs.set(id, deserialize(inflateRawSync(graphBytes)));
          }
          const nodes = provenanceGraphs.get(id).nodes;
          const own = nodes[owner], lowering = nodes[entry.metadata.root];
          if (!own || !lowering) continue;
          entry.value.provenance = {rows: [...own.rows, ...lowering.rows],
            edges: [...new Set([...own.dependencies, ...lowering.dependencies].filter((k) => k !== owner))]};
        }
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
      // Freeze the lowering graph once into immutable bytes. Finalized guards
      // are appended to an envelope, without cloning/serializing that graph again.
      try {
        value = compactLowering(value);
        if (!portable(value)) return false;
        const {provenance, ...payload} = value;
        pending.push({owner, value: {name: value.name}, valueBytes: serialize(payload),
          reads: [...reads], variant: wholeSelection(value) ? selection(program) : ""});
        return true;
      } catch { return false; } // Non-portable lowerings compile normally.
    },
    finish(program) {
      if (!pending.length) return;
      const graph = dependencyGraph(registry, pending.map((e) => e.owner),
        shadow ? pending.flatMap((e) => [...borrowedOwners(deserialize(e.valueBytes))]) : []);
      if (shadow) graphRawFiles(graph, registry);
      shadow?.finish(graph, pending, program);
      // Shared rows compress better with a modest extra pass (a few ms per
      // compile); entry payloads and the recording-off path keep level 1.
      const bytes = deflateRawSync(serialize(graph), {level: 4}), graphHash = digest(bytes);
      const graphFile = join(root, version, `${graphHash}.provenance`);
      try {
        mkdirSync(join(root, version), {recursive: true});
        const temp = `${graphFile}.${randomUUID()}.pending`;
        try { writeFileSync(temp, bytes); renameSync(temp, graphFile); }
        finally { rmSync(temp, {force: true}); }
      } catch { pending.length = 0; return; }
      for (const entry of pending.splice(0)) {
        entry.metadata = {format: "gogen-dependency-digests-2", owner: entry.owner, entry: entry.value.name,
          artifactDigest: graph.nodes[entry.owner]?.digest ?? null, graph: graphHash, root: `lowering:${entry.owner}`};
        cache.persist(entry);
      }
    },
    persist({owner, value, valueBytes, reads, program, metadata, variant}) {
      // Repeated reads can exceed the budget before compaction. A transcript
      // with unserializable arguments must still fall back to ordinary lowering.
      if (!valueBytes) {
        try { value = compactLowering(value); } catch { return; }
        if (!portable(value)) return;
      }
      const file = location(owner, value.name, variant ?? (wholeSelection(value) ? selection(program) : "")), temp = `${file}.${randomUUID()}.pending`;
      try {
        mkdirSync(join(root, version), {recursive: true});
        const payload = deflateRawSync(serialize({key: sourceKey(owner, reads), reads, ...(metadata ? {metadata} : {}), ...(valueBytes ? {valueBytes} : {}), value}), {level: 1});
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
    if (cacheDir) Object.assign(session, {cacheDir, diskRoot: cacheDir, diskRecording: recordingProvenance(), disk: objectCache(registry, cacheDir)});
  }
  if (session.diskRoot !== session.cacheDir || (session.cacheDir && session.diskRecording !== recordingProvenance())) {
    session.classes.clear();
    if (!session.cacheDir) {
      delete session.diskRoot;
      delete session.disk;
      return;
    }
    session.diskRoot = session.cacheDir;
    session.diskRecording = recordingProvenance();
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
  // Exhaustive mode deliberately checks even global hits against a separate
  // cold lowering. Ordinary compilation only pays for v3 after replay misses.
  let prediction = (process.env.GOGEN_CACHE_SHADOW_VALIDATE === "1" || process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE === "1")
    ? session?.disk?.shadow?.probe(owner, key, program) : undefined;
  if (prediction) session.disk.shadow.validate(prediction, ctx, obj, lower);
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
    if (prediction && !prediction.row.wouldReuseV3) {
      prediction.row.currentComplete = false;
      prediction.row.completenessReason = "no-validated-v3-candidate";
    }
    return cached.ir;
  }
  if (!prediction) {
    prediction = session?.disk?.shadow?.probe(owner, key, program);
    if (prediction) session.disk.shadow.validate(prediction, ctx, obj, lower);
  }
  counts.lowered++;
  if (prediction) prediction.row.actuallyLowered = true;
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
    const persisted = session.disk.write(owner, {...portable, name: key}, reads, program);
    if (prediction && !persisted) {
      prediction.row.currentComplete = false; prediction.row.completenessReason = "nonportable-lowering";
    }
  } else if (prediction) {
    prediction.row.currentComplete = false; prediction.row.completenessReason = "unrecordable-lowering";
  }
  return value;
});
