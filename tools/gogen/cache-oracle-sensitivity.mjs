// Slower local negative controls, separate from the CI equality run.
import {writeFileSync} from "node:fs";
import {syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {sensitivityFault, notCovered} from "./cache-oracle-coverage.mjs";

export function runSensitivity(runOracle, {classes = 4, seed = 719, lineModes = [false, true],
  report, onResult = () => {}} = {}) {
  const started = performance.now(), rows = [];
  const save = () => {
    const result = {mode: "sensitivity", classes, seed, lineModes, rows,
      covered: rows.filter((r) => r.mismatch).length,
      notCovered: rows.filter((r) => !r.mismatch),
      mismatches: rows.reduce((n, r) => n + r.mismatches, 0),
      runtimeMs: Math.round(performance.now() - started)};
    if (report) writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
    return result;
  };
  for (const mutation of syntheticCorpus({classes, seed}).mutations) {
    const fault = sensitivityFault(mutation.kind);
    const result = runOracle({classes, seed, lineModes,
      scenarios: [{name: mutation.kind, steps: [mutation]}],
      env: {...process.env, GOGEN_CACHE_ORACLE_FAULT: fault}});
    const row = {kind: mutation.kind, fault, mismatch: result.mismatches > 0,
      mismatches: result.mismatches,
      differingArtifacts: [...new Set(result.rows.flatMap((r) => r.differences.artifacts))],
      differingClasses: [...new Set(result.rows.flatMap((r) => r.differences.classes))], observations: result.rows, runtimeMs: result.runtimeMs,
      ...(!result.mismatches ? {status: "not covered", reason: notCovered[mutation.kind]} : {status: "covered"})};
    rows.push(row); onResult(row); save();
    if (!row.mismatch && !row.reason) throw new Error(`sensitivity regression: ${mutation.kind} under ${fault} produced no MISMATCH`);
  }
  return save();
}
