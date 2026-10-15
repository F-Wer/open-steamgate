// Observational candidates only. Production object-cache read() never consults
// this namespace. A missing/corrupt/racing index is an ordinary shadow miss.
import {mkdirSync, readFileSync, writeFileSync, renameSync, rmSync} from "node:fs";
import {join} from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {keyComputer, hashV3, mismatchReason, borrowedOwners} from "./frontend-v3-key.mjs";
import {recordLowering, replayLowering, copyReplayProgram} from "./frontend-replay.mjs";
import {auditedBookkeeping, auditBuiltArtifacts} from "./frontend-provenance.mjs";
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const KEEP_CANDIDATES = 4;
const encode = (v) => JSON.stringify(v, (_, x) => x instanceof Map ? {map: [...x]} : x instanceof Set ? {set: [...x]} : x);
function write(file, bytes) {
  const temp = `${file}.${randomUUID()}.pending`;
  try { writeFileSync(temp, bytes); renameSync(temp, file); }
  finally { rmSync(temp, {force: true}); }
}
function pack(value) {
  const bytes = deflateRawSync(serialize(value), {level: 1});
  return Buffer.concat([Buffer.from(checksum(bytes) + "\n"), bytes]);
}
function unpack(file) {
  const bytes = readFileSync(file), payload = bytes.subarray(65);
  if (bytes[64] !== 10 || bytes.subarray(0, 64).toString() !== checksum(payload)) throw new Error("bad v3 checksum");
  return deserialize(inflateRawSync(payload));
}
export function shadowCache(reg, root, namespace, portable) {
  // Namespace/tool identity and key/query indexes are needed only on a miss.
  let namespaceValue, directory;
  const namespaceOf = () => namespaceValue ??= typeof namespace === "function" ? namespace() : namespace;
  const dir = () => directory ??= join(root, "v3", namespaceOf());
  const graphs = new Map();
  let compute, stats;
  const computer = (program) => compute ??= keyComputer(reg, namespaceOf(), program);
  const entryDir = (owner, name) => join(dir(), hashV3([owner, name]));
  const index = (location) => {
    const keys = JSON.parse(readFileSync(join(location, "index.json"), "utf8"));
    if (!Array.isArray(keys) || keys.length > KEEP_CANDIDATES || keys.some((k) => !validHash(k))) throw new Error("bad v3 index");
    return keys;
  };
  const graphOf = (id) => {
    if (!validHash(id)) throw new Error("bad v3 graph id");
    if (!graphs.has(id)) {
      const bytes = readFileSync(join(dir(), `${id}.provenance`));
      if (checksum(bytes) !== id) throw new Error("bad v3 graph checksum");
      graphs.set(id, deserialize(inflateRawSync(bytes)));
    }
    return graphs.get(id);
  };
  const begin = (program, attach = true) => {
    if (!stats) {
      stats = {entries: [], recomputeMs: 0, validated: 0, disagreements: 0};
    }
    if (attach) program.frontendCounts.shadowV3 = stats;
  };
  return {
    reset() { stats = undefined; compute = undefined; },
    probe(owner, name, program) {
      begin(program);
      const row = {name, wouldReuseV3: false, actuallyLowered: false, reason: "no-candidate"};
      const refuse = (reason) => { if (row.reason === "no-candidate") row.reason = reason; };
      stats.entries.push(row);
      const start = performance.now();
      try {
        const location = entryDir(owner, name);
        for (const key of index(location)) {
          let candidate, graph, value;
          try {
            candidate = unpack(join(location, `${key}.bin`));
            graph = graphOf(candidate.graph);
            value = deserialize(candidate.valueBytes);
            if (value.name !== name || graph.nodes[candidate.root]?.owner !== owner || candidate.key !== key) continue;
            if (!portable(value)) { refuse("nonportable-candidate"); continue; }
          } catch { refuse("corrupt-candidate"); continue; }
          // Recompute completeness from the graph, never trust a persisted bit.
          const saved = computer(program)(graph, candidate.root, value);
          if (!saved.complete || saved.key !== key) { refuse(saved.reason ?? "corrupt-key"); continue; }
          row.complete = true;
          const current = computer(program)(graph, candidate.root, value, {current: true});
          if (auditBuiltArtifacts(reg)) { refuse("audit-built-artifact"); break; }
          if (!current.complete) { refuse(current.reason); continue; }
          if (current.key !== key) { refuse(mismatchReason(saved, current)); continue; }
          const trial = copyReplayProgram(program);
          if (value.supplied !== suppliedGuard(program, name) || !auditedBookkeeping("v3-shadow-replay-validation", () => replayLowering(trial, value.replay))) {
            refuse("replay-refused"); continue;
          }
          row.wouldReuseV3 = true; row.currentComplete = true; row.reason = "would-reuse-v3"; row.key = key;
          return {row, value, trial};
        }
      } catch { /* Unavailable cache is a miss. */ }
      finally { stats.recomputeMs += performance.now() - start; }
      return {row};
    },
    validate(prediction, ctx, obj, lower) {
      if (!prediction.value || process.env.GOGEN_CACHE_SHADOW_VALIDATE !== "1") return;
      const cold = copyReplayProgram(ctx.program);
      // A real lowering at the exact class seam, with isolated top-level
      // collections. It contributes no observations to production provenance.
      const recorded = auditedBookkeeping("v3-shadow-cold-validation", () => recordLowering(cold,
        (tracked) => lower({...ctx, program: tracked}, obj)));
      const entry = prediction.value, expected = prediction.trial;
      Object.assign(expected, entry.current);
      const written = new Set([...entry.replay.written, ...recorded.replay?.written ?? []]);
      const effects = (p) => [...written].sort().map((k) => [k, p[k]]);
      const operations = (r) => r?.ops.filter((op) => ["assign", "effect"].includes(op.kind));
      // Compare IR bytes, ordered write/effect bytes and the resulting values.
      const equal = !!recorded.replay && encode(entry.ir) === encode(recorded.ir)
        && encode(operations(entry.replay)) === encode(operations(recorded.replay))
        && encode(effects(expected)) === encode(effects(cold));
      stats.validated++;
      if (!equal) {
        stats.disagreements++;
        throw new Error(`SHADOW V3 DISAGREEMENT: ${entry.name} (IR/effects differ from cold lowering)`);
      }
    },
    finish(graph, entries, program) {
      begin(program, false);
      if (auditBuiltArtifacts(reg)) {
        stats.persistenceRefused = "audit-built-artifact";
        for (const row of stats.entries) {
          row.currentComplete = false; row.completenessReason = "audit-built-artifact";
        }
        return;
      }
      const bytes = deflateRawSync(serialize(graph), {level: 4}), graphHash = checksum(bytes);
      try { mkdirSync(dir(), {recursive: true}); write(join(dir(), `${graphHash}.provenance`), bytes); }
      catch { return; }
      for (const entry of entries) {
        const value = deserialize(entry.valueBytes), root = `lowering:${entry.owner}`;
        const result = computer(program)(graph, root, value);
        const row = stats.entries.findLast((r) => r.name === value.name);
        if (row) { row.currentComplete = result.complete; row.completenessReason = result.reason; }
        if (!result.complete) continue;
        const location = entryDir(entry.owner, value.name);
        try {
          mkdirSync(location, {recursive: true});
          write(join(location, `${result.key}.bin`), pack({key: result.key, graph: graphHash, root, valueBytes: entry.valueBytes}));
          let previous = [];
          try { previous = index(location); } catch { /* First observation or corrupt index. */ }
          const keys = [result.key, ...previous.filter((k) => k !== result.key)].slice(0, KEEP_CANDIDATES);
          write(join(location, "index.json"), JSON.stringify(keys));
          for (const key of previous) if (!keys.includes(key)) rmSync(join(location, `${key}.bin`), {force: true});
        } catch { /* Observational persistence cannot break compilation. */ }
      }
    },
  };
}
export function suppliedGuard(program, owner) {
  return JSON.stringify([...program.supplied].filter(([k]) => k.startsWith(`${owner}=>`)).map(([k, v]) => [k, [...v]]));
}
export {borrowedOwners};
