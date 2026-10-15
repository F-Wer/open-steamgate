import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {artifactDigestsOf, artifactDigestStats, prepareArtifactDigests, definitionFingerprint, canonical} from "./frontend-artifact-digests.mjs";
import {objectCache} from "./frontend-object-cache.mjs";
import {cacheDigestMetadata} from "./frontend-artifact-digests-cli.mjs";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";
import {provenanceOf, recordProvenance} from "./frontend-provenance.mjs";
import {orderedRegistry, artifactsOf, compareArtifacts} from "./cache-oracle-capture.mjs";
import {classSource} from "./cache-oracle-corpus.mjs";
import {syntheticCorpus, runOracle} from "./cache-oracle.mjs";
const scratch = (run) => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-digests-"));
  try { return run(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
};
const corpus = (dir) => {
  const c = syntheticCorpus({classes: 4});
  for (const [name, raw] of Object.entries(c.files)) writeFileSync(join(dir, name), raw);
  return c;
};
const build = (dir, c, options = {}) => compileProgram({folders: [dir], objects: c.objects, tolerant: true, ...options});

test("resolved hashes propagate hidden pool and DDIC changes into unchanged scopes and definitions", () => scratch((dir) => {
  const c = corpus(dir), first = build(dir, c), before = artifactDigestsOf(first);
  assert.equal(artifactDigestStats(first).objects, [...first.reg.getObjects()].length);
  assert.deepEqual(artifactDigestStats(first).errors, {});
  assert.ok([...before.values()].every((d) => /^[a-f0-9]{64}$/.test(d)));
  writeFileSync(join(dir, "zorc.type.abap"), c.files["zorc.type.abap"].replace("TYPE i", "TYPE int8"));
  writeFileSync(join(dir, "zoracle_num.doma.xml"), c.files["zoracle_num.doma.xml"].replace("INT4", "INT8"));
  const after = artifactDigestsOf(build(dir, c));
  for (const key of ["CLAS ZCL_POOL_IMPLICIT", "CLAS ZCL_POOL_EXPLICIT", "TABL ZORACLE_TAB", "DTEL ZORACLE_NUM", "CLAS ZCL_DDIC"])
    assert.notEqual(after.get(key), before.get(key), key);
  assert.equal(after.get("CLAS ZCL_CONTROL_0001"), before.get("CLAS ZCL_CONTROL_0001"));
  // Keep owners unchanged: only their DTEL's domain length/scale changes.
  writeFileSync(join(dir, "zcl_shape.clas.abap"), `CLASS zcl_shape DEFINITION PUBLIC.
PUBLIC SECTION. DATA value TYPE zoracle_num.
EVENTS changed EXPORTING VALUE(value) TYPE zoracle_num.
ENDCLASS. CLASS zcl_shape IMPLEMENTATION. ENDCLASS.`);
  writeFileSync(join(dir, "zif_shape.intf.abap"), `INTERFACE zif_shape PUBLIC.
METHODS run IMPORTING value TYPE zoracle_num. ENDINTERFACE.`);
  const unchanged = [];
  for (const [datatype, field, oldValue, newValue] of [
    ["CHAR", "LENG", "000010", "000020"], ["DEC", "DECIMALS", "000002", "000004"],
  ]) {
    const domain = c.files["zoracle_num.doma.xml"].replace("INT4", datatype)
      .replace("</DD01V>", "<DECIMALS>000002</DECIMALS></DD01V>");
    writeFileSync(join(dir, "zoracle_num.doma.xml"), domain);
    const original = artifactDigestsOf(build(dir, c));
    writeFileSync(join(dir, "zoracle_num.doma.xml"), domain.replace(`<${field}>${oldValue}`, `<${field}>${newValue}`));
    const edited = artifactDigestsOf(build(dir, c));
    for (const key of ["CLAS ZCL_SHAPE", "INTF ZIF_SHAPE"])
      if (edited.get(key) === original.get(key)) unchanged.push(`${datatype} ${field}: ${key}`);
  }
  assert.deepEqual(unchanged, [], "resolved owner digests must change for length and scale edits");
}));

test("expanded macro text and virtual positions change an unchanged consumer digest", () => scratch((dir) => {
  const c = corpus(dir), before = artifactDigestsOf(build(dir, c));
  const file = "zoracle_macros.prog.abap";
  writeFileSync(join(dir, file), c.files[file].replace("rv = 7", "rv = 9"));
  const changed = artifactDigestsOf(build(dir, c));
  assert.notEqual(changed.get("CLAS ZCL_INCLUDE_MACRO"), before.get("CLAS ZCL_INCLUDE_MACRO"));
  writeFileSync(join(dir, file), "\n" + c.files[file]);
  const movedProgram = build(dir, c), moved = artifactDigestsOf(movedProgram);
  // Core assigns virtual positions at the macro CALL site, not provider rows.
  assert.equal(moved.get("CLAS ZCL_INCLUDE_MACRO"), before.get("CLAS ZCL_INCLUDE_MACRO"));
  assert.notEqual(moved.get("PROG ZORACLE_MACROS"), before.get("PROG ZORACLE_MACROS"));
  const expanded = movedProgram.reg.getObject("CLAS", "ZCL_INCLUDE_MACRO").getMainABAPFile().getStatements()
    .find((s) => s.concatTokens().startsWith("rv ="));
  expanded.getFirstToken().getStart().vcol++;
  prepareArtifactDigests(movedProgram.reg);
  assert.notEqual(artifactDigestsOf(movedProgram).get("CLAS ZCL_INCLUDE_MACRO"), moved.get("CLAS ZCL_INCLUDE_MACRO"));
}));

test("projection includes resolved types, defaults, constants, visibility, aliases, inheritance and events without source edits", () => scratch((dir) => {
  const c = corpus(dir), p = build(dir, c), reg = p.reg;
  const probe = (key, change) => {
    const before = artifactDigestsOf(reg).get(key);
    change(); prepareArtifactDigests(reg);
    assert.notEqual(artifactDigestsOf(reg).get(key), before, key);
    assert.deepEqual(artifactDigestStats(reg).errors, {});
  };
  const def = reg.getObject("CLAS", "ZCL_DEFAULTS").getDefinition();
  probe("CLAS ZCL_DEFAULTS", () => { def.getAttributes().getConstants()[0].value = "123"; });
  probe("CLAS ZCL_DEFAULTS", () => { def.getAttributes().getConstants()[0].visibility = "private"; });
  const params = [...def.getMethodDefinitions().getAll()][0].getParameters();
  probe("CLAS ZCL_DEFAULTS", () => { params.defaults.IV.getFirstToken().str = "9"; });
  probe("CLAS ZCL_CHILD", () => { reg.getObject("CLAS", "ZCL_CHILD").getDefinition().superClass = "ZCL_PARENT_OTHER"; });
  probe("CLAS ZCL_INTERFACE", () => { reg.getObject("CLAS", "ZCL_INTERFACE").getDefinition().getAliases()[0].component = "ZIF_ORACLE~OTHER"; });
  probe("CLAS ZCL_EVENTS", () => { reg.getObject("CLAS", "ZCL_EVENTS").getDefinition().getEvents()[0].is_static = true; });
  const method = reg.getObject("CLAS", "ZCL_POOL_IMPLICIT").syntaxResult.spaghetti.getTop().getChildren()[0].getChildren()[0];
  probe("CLAS ZCL_POOL_IMPLICIT", () => { method.getData().vars.EXTRA = params.getAll()[0]; });
}));

test("borrowed global definition checks semantics at the same coordinates and memoizes repeated fingerprints", () => scratch((dir) => {
  const c = corpus(dir);
  const state = (p) => ({reg: p.reg, definitions: new Map([["borrowed", p.reg.getObject("CLAS", "ZCL_BORROW_PROVIDER").getDefinition()]])});
  const first = build(dir, c), a = state(first), d = a.definitions.get("borrowed");
  assert.equal(artifactDigestStats(first), undefined, "uncached compile does no digest work");
  const cached = recordLowering(a, (p) => p.definitions.get("borrowed").getAttributes().getConstants()[0].getValue());
  assert.ok(cached.replay);
  const stats = artifactDigestStats(first);
  assert.equal(stats.objects, 1, "only the borrowed definition owner was projected");
  for (let i = 0; i < 1000; i++) definitionFingerprint(first.reg, d);
  assert.deepEqual(artifactDigestStats(first), stats);
  assert.ok(replayLowering(state(build(dir, c)), cached.replay), "fresh identities replay");
  writeFileSync(join(dir, "zcl_borrow_provider.clas.abap"), c.files["zcl_borrow_provider.clas.abap"].replace("VALUE 1", "VALUE 9"));
  const changed = state(build(dir, c));
  assert.deepEqual(definitionFingerprint(changed.reg, changed.definitions.get("borrowed")).definition,
    definitionFingerprint(a.reg, d).definition);
  assert.equal(replayLowering(changed, cached.replay), false);
}));

test("cache dependency metadata and provenance are opt-in; CLI explains unavailable metadata", () => scratch((dir) => {
  const c = corpus(dir), cacheDir = join(dir, "cache");
  const off = build(dir, c, {cacheDir, provenance: false});
  assert.equal(provenanceOf(off).size, 0, "cacheDir alone installs no recorder");
  assert.equal(cacheDigestMetadata(cacheDir, "ZCL_DDIC")[0].unavailable, "provenance recording was off or entry predates digest metadata");
  const onDir = join(dir, "recorded");
  const on = build(dir, c, {cacheDir: onDir, provenance: true});
  const metadata = cacheDigestMetadata(onDir, "ZCL_DDIC");
  assert.equal(metadata.length, 1);
  for (const key of ["TABL ZORACLE_TAB", "DTEL ZORACLE_NUM", "DOMA ZORACLE_NUM"])
    assert.equal(metadata[0].dependencyDigests[key], artifactDigestsOf(on).get(key), key);
  assert.equal(metadata[0].provenanceComplete, true, "classified orchestration does not contaminate class dependencies");
  assert.deepEqual(artifactDigestsOf(on), artifactDigestsOf(off));
  const warm = build(dir, c, {cacheDir: onDir, provenance: true});
  assert.ok(warm.frontendCounts.reusedClasses.includes("ZCL_DDIC"));
  const cli = JSON.parse(execFileSync(process.execPath, ["tools/gogen/frontend-artifact-digests-cli.mjs", "--cache-dir", onDir, "--entry", "ZCL_DDIC"], {encoding: "utf8"}));
  assert.deepEqual(cli, metadata);
}));

test("cache/session compilation leaves unread owners lazy and resets memo on retained-registry compiles", () => scratch((dir) => {
  const c = corpus(dir), session = {};
  const first = build(dir, c, {session});
  const d = first.reg.getObject("CLAS", "ZCL_BORROW_PROVIDER").getDefinition();
  const before = artifactDigestStats(first)?.objects ?? 0;
  definitionFingerprint(first.reg, d);
  assert.equal(artifactDigestStats(first).objects, before + 1);
  const next = compileProgram({folders: [], registry: first.reg, objects: [], session, tolerant: true});
  assert.equal(artifactDigestStats(next).objects, 0, "new compile starts with an empty memo");
  definitionFingerprint(next.reg, d);
  assert.equal(artifactDigestStats(next).objects, 1);
  compileProgram({folders: [], registry: first.reg, objects: [], tolerant: true});
  assert.equal(artifactDigestStats(next), undefined, "uncached compilation discards the old memo");
}));

test("deferred metadata preserves the lowering snapshot when a later owner mutates shared values", () => scratch((dir) => {
  const c = corpus(dir), program = build(dir, c), cache = objectCache(program.reg, join(dir, "cache"));
  const value = {name: "ZCL_CONTROL_0001", ir: {constant: 1}}, reads = [];
  recordProvenance(() => cache.write("CLAS ZCL_CONTROL_0001", value, reads, program));
  value.ir.constant = 2; reads.push("CLAS MISSING");
  cache.finish(program);
  assert.equal(cache.read("CLAS ZCL_CONTROL_0001", value.name, program).ir.constant, 1);
}));

test("fresh processes, Node/Bun and provenance on/off have identical artifact digests", {timeout: 30_000}, () => scratch((dir) => {
  corpus(dir);
  const hosts = [process.execPath, "/home/alice/.bun/bin/bun"];
  assert.ok(existsSync(hosts[1]), "Bun stability gate requires its installed runtime");
  const captures = [];
  for (const host of hosts) for (const provenance of ["0", "1"]) for (let round = 0; round < 2; round++) {
    const args = [...(host === hosts[1] ? ["--no-install"] : []), "tools/gogen/frontend-artifact-digests-cli.mjs", dir];
    const result = JSON.parse(execFileSync(host, args, {encoding: "utf8", env: {...process.env, GOGEN_PROVENANCE: provenance}}));
    assert.deepEqual(result.stats.errors, {});
    captures.push(result.digests);
  }
  for (const capture of captures) assert.deepEqual(capture, captures[0]);
}));

test("global definition order preserves per-object digests and warm matches that order's fresh cold output", () => scratch((dir) => {
  const c = corpus(dir), order = Array.from({length: 8}, (_, i) => `zif_pass_${i}.intf.abap`);
  const cacheDir = join(dir, "cache");
  const a = compileProgram({folders: [dir], objects: c.objects, tolerant: true, cacheDir, registry: orderedRegistry([dir], order)});
  const b = compileProgram({folders: [dir], objects: c.objects, tolerant: true, registry: orderedRegistry([dir], [...order].reverse())});
  assert.deepEqual(artifactDigestsOf(a), artifactDigestsOf(b));
  const warm = compileProgram({folders: [dir], objects: c.objects, tolerant: true, cacheDir, registry: orderedRegistry([dir], [...order].reverse())});
  assert.equal(warm.frontendCounts.reused, 0, "registry inventory order remains globally guarded");
  assert.ok(compareArtifacts(artifactsOf(warm), artifactsOf(b)).equal);
}));

test("arithmetic syntax digests survive in-place rearrangement and fresh cache replay", () => scratch((dir) => {
  writeFileSync(join(dir, "zcl_arithmetic.clas.abap"), classSource("zcl_arithmetic",
    "rv = 1 + 2 * 3 - CONV i( 4 ) / 2 + ( 5 - 1 )."));
  const reg = orderedRegistry([dir], []);
  reg.findIssues();
  const before = artifactDigestsOf(reg);
  const options = {folders: [dir], objects: ["ZCL_ARITHMETIC"], tolerant: true};
  const cold = compileProgram({...options, registry: reg});
  assert.deepEqual(artifactDigestsOf(cold), before, "projection ignores arithmetic regrouping");
  const cacheDir = join(dir, "cache");
  for (let i = 0; i < 2; i++) assert.deepEqual(artifactDigestsOf(compileProgram({...options, cacheDir})), before);
}));

test("canonical dictionaries ignore insertion order; unsupported shapes refuse definition fingerprints", () => {
  assert.equal(JSON.stringify(canonical({b: 1, a: {y: 2, x: 3}})), JSON.stringify(canonical({a: {x: 3, y: 2}, b: 1})));
  assert.throws(() => canonical(new Map()), /unsupported semantic/);
  const obj = {getType: () => "TABL", getName: () => "ZBAD", getFiles: () => [], parseType: () => new Map()};
  const reg = {getObjects: () => [obj]};
  prepareArtifactDigests(reg);
  assert.equal(artifactDigestsOf(reg).get("TABL ZBAD"), null);
  assert.ok(artifactDigestStats(reg).errors["TABL ZBAD"]);
});

test("cross-object oracle: location-only mismatches, semantic fingerprint stays equal under no-version", {timeout: 40_000}, () => {
  const mutation = syntheticCorpus({classes: 4}).mutations.find((m) => m.kind === "cross-object-same-position-definition");
  for (const [fault, mismatches] of [["no-version", 0], ["no-version,fingerprint-location-only", 2]]) {
    const result = runOracle({classes: 4, scenarios: [{name: mutation.kind, steps: [mutation]}],
      env: {...process.env, GOGEN_CACHE_ORACLE_FAULT: fault}});
    assert.equal(result.mismatches, mismatches);
    if (mismatches) for (const row of result.rows) assert.ok(row.differences.artifacts.includes("borrowedDefinitionReplay"));
  }
});


test("definition fingerprints and replay refuse unsupported or missing owner digests", () => {
  class ClassDefinition {
    getName() { return "ZBAD"; }
    getFilename() { return "zbad.abap"; }
    getStart() { return {getRow: () => 1, getCol: () => 1}; }
  }
  const def = new ClassDefinition();
  const unsupported = {getType: () => "TABL", getName: () => "ZBAD",
    getFiles: () => [{getFilename: () => def.getFilename(), getRaw: () => ""}],
    parseType: () => new Map()};
  const outcomes = [];
  for (const objects of [[unsupported], []]) {
    const reg = {getObjects: () => objects};
    let error;
    try { definitionFingerprint(reg, def); } catch (caught) { error = caught; }
    outcomes.push(error instanceof TypeError && error.message === "definition has no resolved owner digest");
    const recorded = recordLowering({reg, definitions: new Map([["bad", def]])},
      (p) => p.definitions.get("bad").getName());
    assert.equal(recorded.ir, "ZBAD", "lowering still succeeds");
    outcomes.push(recorded.replay === undefined);
  }
  assert.deepEqual(outcomes, [true, true, true, true], "null and absent owners must throw and refuse persistence");
});

test("definition projection pins metadata, attributes, named types, defaults, parameters and flags", () => scratch((dir) => {
  writeFileSync(join(dir, "zcl_projection.clas.abap"), `CLASS zcl_projection DEFINITION PUBLIC.
PUBLIC SECTION. DATA value TYPE i. TYPES named TYPE i.
METHODS run IMPORTING iv TYPE i DEFAULT 1.
ENDCLASS. CLASS zcl_projection IMPLEMENTATION. METHOD run. value = iv. ENDMETHOD. ENDCLASS.`);
  const p = compileProgram({folders: [dir], objects: [], tolerant: true});
  const def = p.reg.getObject("CLAS", "ZCL_PROJECTION").getDefinition();
  const method = [...def.getMethodDefinitions().getAll()][0], params = method.getParameters();
  // Direct definition projections exclude the redundant syntax/scope ingredients.
  const project = () => prepareArtifactDigests(p.reg).definition(def);
  const probe = (name, change, restore) => {
    const before = project(); change();
    assert.notEqual(project(), before, name); restore();
  };
  const override = (name, obj, key, value) => {
    const previous = obj[key];
    probe(name, () => { obj[key] = value; }, () => { obj[key] = previous; });
  };
  const attr = def.getAttributes().getAll()[0];
  override("identifier meta", attr, "getMeta", () => ["projection-probe"]);
  override("attributes", def.getAttributes(), "getAll", () => []);
  override("named types", def.getTypeDefinitions(), "getAll", () => []);
  override("parameter defaults", params, "getParameterDefault", () => undefined);
  override("parameter identifiers", params.getAll()[0], "getMeta", () => ["parameter-probe"]);
  override("method flags", method, "isStatic", () => !method.is_static);
  const scope = p.reg.getObject("CLAS", "ZCL_PROJECTION").syntaxResult.spaghetti.getTop();
  const projected = JSON.stringify(prepareArtifactDigests(p.reg).scope(scope));
  const clearReferences = (s) => { s.getData().references = []; s.getChildren().forEach(clearReferences); };
  clearReferences(scope);
  assert.notEqual(JSON.stringify(prepareArtifactDigests(p.reg).scope(scope)), projected, "scope references");
}));
