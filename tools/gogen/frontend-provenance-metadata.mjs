// Store the artifact graph once. Entries reference their own root; inspection
// alone expands closures. No class serializes another class's lowering trace.
import {provenanceGraph} from "./frontend-provenance.mjs";
import {artifactDigestOf} from "./frontend-artifact-digests.mjs";
import {inputSnapshot} from "./frontend-inventory.mjs";

export function dependencyGraph(reg, roots, extraArtifacts = []) {
  const trace = provenanceGraph(reg) ?? {artifacts: new Map(), lowerings: new Map(), global: {queries: new Map()}}, inventory = inputSnapshot(reg), nodes = {};
  const identity = (key) => inventory.objects.has(key) ? key : inventory.fileOwners.get(key);
  const build = (key, lowering = false) => {
    const id = lowering ? `lowering:${key}` : key;
    if (nodes[id]) return id;
    const entry = (lowering ? trace.lowerings : trace.artifacts).get(key);
    const node = nodes[id] = {owner: key, digest: artifactDigestOf(reg, key), dependencies: [], rows: []};
    if (!entry) node.rows.push({role: "artifact", artifact: key, phase: lowering ? "lowering" : "artifact-read", kind: "unknown-scan", args: [lowering ? "lowering-built-before-recording" : "artifact-built-before-recording"], result: []});
    if (lowering) node.dependencies.push(build(key));
    const dependencies = new Set(entry?.edges);
    for (const row of [...entry?.queries.values() ?? [], ...trace.global.queries.values()]) {
      node.rows.push(row);
      for (const result of [...row.result, ...row.providers ?? []]) {
        const provider = identity(result);
        if (provider && provider !== key) dependencies.add(provider);
      }
    }
    for (const dependency of [...dependencies].sort()) node.dependencies.push(build(dependency));
    return id;
  };
  for (const root of roots) build(root, true);
  for (const key of extraArtifacts) build(key);
  return {format: "gogen-provenance-graph-1", nodes};
}

export function expandDependencyMetadata(metadata, graph) {
  const seen = new Set(), dependencyDigests = {};
  let provenanceComplete = true;
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = graph?.nodes[id];
    if (!node) { provenanceComplete = false; return; }
    dependencyDigests[node.owner] = node.digest;
    if (!node.digest || node.rows.some((q) => q.kind === "unknown-scan")) provenanceComplete = false;
    node.dependencies.forEach(visit);
  };
  visit(metadata.root);
  return {...metadata, dependencyDigests, provenanceComplete};
}
