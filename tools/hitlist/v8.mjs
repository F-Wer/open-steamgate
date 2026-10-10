// SPDX-License-Identifier: MIT
export function parseV8(p) {
  if (!Array.isArray(p.nodes) || !Array.isArray(p.samples)) throw new Error("invalid V8 CPU profile");
  const nodes = new Map(p.nodes.map(n => [n.id, n])), parents = new Map();
  for (const n of p.nodes) for (const child of n.children ?? []) {
    if (parents.has(child)) throw new Error("V8 node has multiple parents");
    parents.set(child, n.id);
  }
  const duration = p.endTime - p.startTime;
  if (!Number.isFinite(duration) || duration < 0) throw new Error("invalid V8 profile duration");
  if (p.timeDeltas && (p.timeDeltas.length !== p.samples.length || p.timeDeltas.some(n => !Number.isFinite(n) || n < 0))) {
    throw new Error("invalid V8 timeDeltas");
  }
  const samples = p.samples.map((id, index) => {
    const frames = [], seen = new Set();
    while (id !== undefined) {
      if (seen.has(id)) throw new Error("cycle in V8 profile");
      seen.add(id);
      const n = nodes.get(id);
      if (!n) throw new Error("unknown V8 sample node");
      const f = n.callFrame;
      frames.push({name: f.functionName, file: f.url, line: f.lineNumber + 1});
      id = parents.get(id);
    }
    return {frames, labels: {}, weight: p.timeDeltas?.[index] ?? 1, samples: 1};
  });
  return {format: "v8", durationSeconds: duration / 1e6,
    metric: {type: "cpu", unit: p.timeDeltas ? "microseconds" : "count"}, samples};
}
