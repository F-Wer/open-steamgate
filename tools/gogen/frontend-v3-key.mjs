// Schema v3 semantic keys. Only ARTIFACT closure nodes enter this format;
// source words, scheduling inventories and final-output dispatch do not.
import {createHash} from "node:crypto";
import {artifactDigestOf, canonical} from "./frontend-artifact-digests.mjs";
import {inputSnapshot} from "./frontend-inventory.mjs";
import {querySpec, queryAnswer, supportedQuery, queryEvaluator} from "./frontend-v3-queries.mjs";
import {auditedBookkeeping, provenanceGraph} from "./frontend-provenance.mjs";
export const encoded = (v) => JSON.stringify(canonical(v));
export const hashV3 = (v) => createHash("sha256").update(encoded(v)).digest("hex");
export const replayGuards = (value) => value.replay.ops.filter((op) => ["read", "measure"].includes(op.kind));

// Borrowed definitions can come through program maps, bypassing named registry
// reads. The fingerprint's owning artifact is still a semantic dependency.
export function borrowedOwners(value) {
  const owners = new Set();
  for (const op of value.replay?.ops ?? []) if (op.kind === "read" && op.value !== undefined) {
    JSON.parse(op.value, (_, v) => { if (v?.definition && v.owner) owners.add(v.owner); return v; });
  }
  return owners;
}

export function keyComputer(reg, namespace, program) {
  const inventory = inputSnapshot(reg), answers = new Map(), rawHashes = new Map();
  const sources = new Map([...inventory.objects.values()].flatMap((e) => e.sources).map((s) => [s.name, s]));
  const specifications = new WeakMap(), queryValues = new WeakMap(), guards = new WeakMap();
  const evaluate = queryEvaluator(program);
  const trace = provenanceGraph(reg), currentIssues = new Map();
  const fault = process.env.GOGEN_CACHE_SHADOW_FAULT;
  const drop = fault?.startsWith("drop-dependency:") ? new RegExp(fault.slice(16)) : undefined;
  if (fault && !drop && !["ignore-miss", "unknown-complete"].includes(fault) && !fault.startsWith("ignore-query:"))
    throw new Error(`unknown GOGEN_CACHE_SHADOW_FAULT: ${fault}`);
  const digest = (key, current, graph) => {
    if (drop?.test(key)) return "FAULT-OMITTED";
    if (!current) return graph.nodes[key]?.digest ?? null;
    return artifactDigestOf(reg, key);
  };
  const raw = (name) => {
    if (!rawHashes.has(name)) {
      const source = sources.get(name);
      rawHashes.set(name, source ? hashV3(["raw-file", source.name, source.raw]) : null);
    }
    return rawHashes.get(name);
  };
  // A provider's rows are shared by many entry closures. Hash and re-evaluate
  // each shared query node once, rather than serializing it again per consumer.
  const queryValue = (graph, q, current) => {
    if (!queryValues.has(graph)) queryValues.set(graph, [new WeakMap(), new WeakMap()]);
    const cache = queryValues.get(graph)[Number(current)];
    if (cache.has(q)) return cache.get(q);
    if (!specifications.has(q)) {
      const spec = querySpec(q);
      specifications.set(q, {spec, id: hashV3(["gogen-query-id-3", spec])});
    }
    const {spec, id} = specifications.get(q);
    let answer = queryAnswer(q);
    if (current && fault !== `ignore-query:${q.kind}`) {
      if (!answers.has(id)) answers.set(id, auditedBookkeeping("v3-current-query", () => evaluate(q)));
      answer = answers.get(id);
    }
    const providers = [], rawFiles = [];
    for (const identity of [...answer.result, ...answer.providers ?? []]) {
      if (typeof identity !== "string") continue;
      if (inventory.objects.has(identity) || graph.nodes[identity]) {
        const d = digest(identity, current, graph);
        if (!d) throw new Error(`missing-digest:${identity}`);
        providers.push([identity, d]);
      } else if (inventory.fileOwners.has(identity) || Object.hasOwn(graph.rawFiles ?? {}, identity)) {
        const d = current ? raw(identity) : graph.rawFiles?.[identity];
        if (!d) throw new Error(`missing-raw-hash:${identity}`);
        rawFiles.push([identity, d]); providers.push(["raw-file", identity, d]);
      } else if (q.kind === "getFileByName" && answer.result.length) throw new Error(`missing-raw-hash:${identity}`);
    }
    const result = {spec, id, rawFiles, hash: hashV3(["gogen-query-answer-3", spec,
      answer.result.length ? answer : {...answer, missing: "MISSING"}, providers])};
    cache.set(q, result);
    return result;
  };
  return (graph, root, value, {current = false} = {}) => {
    const dependencies = new Map(), queries = new Map(), rawFiles = new Map(), seen = new Set();
    const fail = (reason) => { throw new Error(reason); };
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = graph.nodes[id];
      if (!node) fail(`missing-artifact:${id}`);
      if (drop?.test(node.owner)) return;
      if (current && fault !== "unknown-complete") {
        if (!currentIssues.has(node.owner)) {
          const rows = [...trace?.global.queries.values() ?? [], ...trace?.artifacts.get(node.owner)?.queries.values() ?? []];
          const unknown = rows.find((q) => q.role === "artifact" && q.kind === "unknown-scan");
          currentIssues.set(node.owner, unknown ? `current-unknown-scan:${node.owner}:${unknown.args.join("/")}` : undefined);
        }
        if (currentIssues.get(node.owner)) fail(currentIssues.get(node.owner));
      }
      const d = digest(node.owner, current, graph);
      if (!d) fail(`missing-digest:${node.owner}`);
      dependencies.set(node.owner, d);
      for (const q of node.rows) {
        if (q.role !== "artifact") continue;
        if (fault === "unknown-complete" && q.kind === "unknown-scan") continue;
        if (!supportedQuery(q)) fail(`${q.kind === "unknown-scan" ? "unknown-scan" : "unsupported-query"}:${q.args.join("/") || q.kind}`);
        if (fault === "ignore-miss" && !q.result.length) continue;
        const resolved = queryValue(graph, q, current);
        if (queries.has(resolved.id) && queries.get(resolved.id).hash !== resolved.hash) fail(`unstable-query:${q.kind}`);
        queries.set(resolved.id, resolved);
        for (const [name, d] of resolved.rawFiles) rawFiles.set(name, d);
      }
      for (const edge of node.dependencies) visit(edge);
    };
    try {
      visit(root);
      for (const owner of borrowedOwners(value)) {
        visit(owner);
      }
      const sort = (m) => [...m].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (!guards.has(value)) guards.set(value, hashV3(["gogen-replay-guards-3", replayGuards(value)]));
      const parts = {owner: graph.nodes[root].owner, name: value.name,
        dependencies: sort(dependencies), rawFiles: sort(rawFiles), queries: sort(queries).map(([id, v]) => [id, v.hash]),
        supplied: value.supplied ?? null, guards: guards.get(value)};
      return {complete: true, key: hashV3(["gogen-entry-key-3", namespace, parts]), parts, queries};
    } catch (error) { return {complete: false, reason: error.message}; }
  };
}

export function mismatchReason(saved, current) {
  const before = saved.parts, after = current.parts;
  for (const kind of ["dependencies", "rawFiles"]) {
    const now = new Map(after[kind]);
    for (const [id, digest] of before[kind]) if (now.get(id) !== digest) return `${kind === "dependencies" ? "dependency" : "raw-file"}:${id}`;
  }
  for (let i = 0; i < before.queries.length; i++) if (encoded(before.queries[i]) !== encoded(after.queries[i])) {
    const q = saved.queries.get(before.queries[i][0]).spec; return `query:${q.kind}(${q.args.join(",")})`;
  }
  return "key-mismatch";
}

export function graphRawFiles(graph, reg) {
  const snapshot = inputSnapshot(reg);
  graph.rawFiles = Object.fromEntries([...snapshot.objects.values()].flatMap((e) => e.sources)
    .map((s) => [s.name, hashV3(["raw-file", s.name, s.raw])]));
  return graph;
}
