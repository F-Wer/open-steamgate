import {test} from "node:test";
import assert from "node:assert/strict";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {artifactDifferences, assertDdicRun} from "./cache-oracle-capture.mjs";
import {home} from "./home.mjs";
import {compareArtifacts, runOracle, syntheticCorpus} from "./cache-oracle.mjs";
import {objectCache} from "./frontend-object-cache.mjs";
import {sensitivityFault, notCovered, uncacheableFeatures} from "./cache-oracle-coverage.mjs";

test("artifact comparison reports the first byte offset, including UTF-8 and missing artifacts", () => {
  assert.deepEqual(compareArtifacts({artifacts: {go: "éx"}}, {artifacts: {go: "éy"}}),
    {equal: false, artifact: "go", offset: 2, warmBytes: 3, coldBytes: 3});
  assert.equal(compareArtifacts({artifacts: {}}, {artifacts: {missing: "[]"}}).equal, false);
  for (const key of ["emitGo", "emitJs", "broken", "skipped", "partial", "diagnostics", "missing", "tables"])
    assert.equal(compareArtifacts({artifacts: {[key]: "a"}}, {artifacts: {[key]: "b"}}).artifact, key);
});

test("coverage evidence names every differing artifact and consumer; DDIC refusals fail", () => {
  const before = {artifacts: {emitGo: "a", tables: "old"}, classArtifacts: {ZCL_DDIC: "same"}};
  const after = {artifacts: {emitGo: "b", tables: "new"}, classArtifacts: {ZCL_DDIC: "same"}};
  assert.deepEqual(artifactDifferences(before, after), {artifacts: ["emitGo", "tables"], classes: []});
  const lowered = {classArtifacts: {ZCL_DDIC: JSON.stringify({methods: [{name: "RUN"}]})},
    artifacts: {broken: "[]", skipped: "[]", partial: "[]"}};
  assert.doesNotThrow(() => assertDdicRun(lowered));
  assert.throws(() => assertDdicRun({...lowered, artifacts: {...lowered.artifacts, skipped: '["ZCL_DDIC=>RUN: UnknownType"]'}}));
  assert.throws(() => assertDdicRun({...lowered, classArtifacts: {}}));
});

test("seeded corpus and serialized edits reproduce exactly", () => {
  const a = syntheticCorpus({classes: 8, seed: 719});
  assert.deepEqual(a, syntheticCorpus({classes: 8, seed: 719}));
  assert.notDeepEqual(a.files, syntheticCorpus({classes: 8, seed: 720}).files);
  assert.deepEqual(JSON.parse(JSON.stringify(a.mutations)), a.mutations);
  const kinds = new Set(a.mutations.map((m) => m.kind));
  for (const kind of kinds) assert.ok(sensitivityFault(kind), `${kind} needs a dedicated fault`);
  for (const kind of Object.keys(notCovered)) assert.ok(kinds.has(kind), `${kind} is a stale coverage exception`);
});

test("CI oracle: every mutation, multi-edit and revert; lines enabled and disabled", {timeout: 180_000}, () => {
  const result = runOracle({classes: 8, seed: 719});
  assert.equal(result.mismatches, 0, JSON.stringify(result.rows.filter((r) => !r.equal)));
  assert.equal(result.rows.length, (syntheticCorpus({classes: 8}).mutations.length + 4) * 2);
  for (const row of result.rows) {
    // Reverting restores the original global digest and can reuse the prime.
    if (row.kind !== "revert-to-original") assert.equal(row.reused, 0, `${row.kind}, noline=${row.noline}`);
    else assert.ok(row.reused > 0, "a return to the original source version reuses its entries");
    assert.ok(row.lowered + row.reused > 8, "fixtures and controls must actually be compiled");
  }
  for (const row of result.summaries) {
    assert.ok(row.reused >= 8, "unchanged disk entries must reuse");
    assert.deepEqual(row.featureCoverage.filter((f) => !f.reused).map((f) => f.name).sort(), Object.keys(uncacheableFeatures).sort());
  }
  console.log(JSON.stringify({mode: "CI", mutationAttempts: result.mutationAttempts,
    mutationsRun: result.mutationsRun, mismatches: result.mismatches, runtimeMs: result.runtimeMs}));
});

test("test-only no-version fault produces a real warm/cold pool mismatch", {timeout: 30_000}, () => {
  const mutation = syntheticCorpus({classes: 4}).mutations.find((m) => m.kind === "pool-type");
  const result = runOracle({classes: 4, seed: 719, scenarios: [{name: "pool-fault", steps: [mutation]}],
    env: {...process.env, GOGEN_CACHE_ORACLE_FAULT: "no-version"}});
  assert.equal(result.mismatches, 2, "the oracle must fail in both source-line modes when the global guard is disabled");
  for (const row of result.rows) {
    assert.equal(row.artifact, "emitGo");
    assert.ok(row.offset > 0);
    assert.ok(row.reusedClasses.includes("ZCL_POOL_IMPLICIT"));
  }
});

test("oracle faults preserve drop regex quantifiers containing commas and reject unknown combinations", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-faults-")), previous = process.env.GOGEN_CACHE_ORACLE_FAULT;
  const registry = {getObjects: () => [], getConfig: () => ({get: () => ({})}), getObject: () => undefined};
  try {
    process.env.GOGEN_CACHE_ORACLE_FAULT = "drop:^TYPE Z[A-Z]{1,4}$";
    const cache = objectCache(registry, dir);
    assert.deepEqual(cache.record(() => registry.getObject("TYPE", "ZAB")).reads, []);
    for (const fault of ["fingerprint-location-only", "no-version,fingerprint-location-only"]) {
      process.env.GOGEN_CACHE_ORACLE_FAULT = fault;
      assert.doesNotThrow(() => objectCache(registry, dir));
    }
    for (const fault of ["no-version,sorted-files", "unknown", "drop:["]) {
      process.env.GOGEN_CACHE_ORACLE_FAULT = fault;
      assert.throws(() => objectCache(registry, dir));
    }
  } finally {
    if (previous === undefined) delete process.env.GOGEN_CACHE_ORACLE_FAULT; else process.env.GOGEN_CACHE_ORACLE_FAULT = previous;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("docs-only Git commits preserve tool identity; tool content changes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-identity-"));
  const git = (...args) => execFileSync("git", args, {cwd: dir, encoding: "utf8", stdio: "pipe"});
  try {
    // An isolated checkout tests real commits and real file hashing without
    // changing the builder's HEAD or touching shared installed builds.
    cpSync(join(home, "tools"), join(dir, "tools"), {recursive: true});
    for (const name of ["package-lock.json", "libs.lock.json"]) cpSync(join(home, name), join(dir, name));
    symlinkSync(join(home, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, "docs")); writeFileSync(join(dir, "docs", "identity.md"), "initial\n");
    git("init", "--quiet");
    git("add", "tools/gogen/frontend-object-cache.mjs", "docs/identity.md");
    const commit = (message) => git("-c", "user.name=Alice V.", "-c", "user.email=ooisee@gmail.com", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", message);
    commit("identity baseline");
    let count = 0;
    const identity = () => execFileSync(process.execPath, ["--input-type=module", "-e", `
      import {objectCache} from ${JSON.stringify(pathToFileURL(join(dir, "tools/gogen/frontend-object-cache.mjs")).href)};
      import {readdirSync} from 'node:fs';
      const root = ${JSON.stringify(join(dir, "cache-"))} + ${++count};
      const registry = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
      const cache = objectCache(registry, root);
      cache.write('CLAS IDENTITY', {name: 'IDENTITY', ir: {}}, [], {wanted: new Set(['IDENTITY'])});
      console.log(readdirSync(root)[0]);
    `], {cwd: dir, encoding: "utf8"}).trim();
    const before = identity();
    writeFileSync(join(dir, "docs", "identity.md"), "docs edit\n");
    git("add", "docs/identity.md"); commit("docs only");
    assert.equal(identity(), before, "HEAD and the Git tree must not enter compiler identity");
    const tool = join(dir, "tools/gogen/frontend-source-key.mjs");
    writeFileSync(tool, readFileSync(tool, "utf8") + "\n// tool identity test edit\n");
    assert.notEqual(identity(), before, "working-tree tool contents must enter compiler identity");
    const nested = join(dir, "tools", "future-frontend-dependency"); mkdirSync(nested);
    for (const extension of ["mjs", "ts", "cjs", "json"]) {
      const previous = identity();
      writeFileSync(join(nested, `module.${extension}`), extension === "json" ? "{}\n" : "// future module\n");
      assert.notEqual(identity(), previous, `nested tools/**/*.${extension} must enter compiler identity`);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
