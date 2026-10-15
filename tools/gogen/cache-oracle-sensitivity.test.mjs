import {test} from "node:test";
import assert from "node:assert/strict";
import {runSensitivity} from "./cache-oracle.mjs";
import {syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {notCovered} from "./cache-oracle-coverage.mjs";

test("local sensitivity matrix: every supported row detects its dedicated fault", {timeout: 240_000}, () => {
  const result = runSensitivity();
  assert.deepEqual(result.rows.map((r) => r.kind), syntheticCorpus({classes: 4}).mutations.map((m) => m.kind));
  for (const row of result.rows) {
    if (notCovered[row.kind]) assert.equal(row.reason, notCovered[row.kind], `${row.kind}: update the documented coverage when it changes`);
    else assert.ok(row.mismatch, `${row.kind} must produce at least one MISMATCH under ${row.fault}`);
  }
  console.log(JSON.stringify({covered: result.covered, notCovered: result.notCovered.length,
    mismatches: result.mismatches, runtimeMs: result.runtimeMs}));
});
