// Real Go builds; run under flock /tmp/osd-heavy.lock with the gogen checks.
import assert from "node:assert/strict";
import childProcess, {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {metadata, summarize, main} from "../tools/osgo-unit.mjs";
import {unitInputs} from "../tools/gogen/unit-inputs.mjs";
import {syncBuiltinESMExports} from "node:module";
import {EventEmitter} from "node:events";
import {compileProgram} from "../tools/gogen/frontend.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = (dir, name = "zcl_osgo_ci", body = "cl_abap_unit_assert=>assert_equals( act = 1 exp = 1 ).") => {
  writeFileSync(join(dir, `${name}.clas.abap`), `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS.\nCLASS ${name} IMPLEMENTATION. ENDCLASS.\n`);
  writeFileSync(join(dir, `${name}.clas.testclasses.abap`), `CLASS ltcl_test DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.\n PRIVATE SECTION. METHODS check FOR TESTING. ENDCLASS.\nCLASS ltcl_test IMPLEMENTATION. METHOD check. ${body} ENDMETHOD. ENDCLASS.\n`);
};
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]));
const invoke = (dir, args = [], script = "tools/osgo-unit.mjs", options = {}) => {
  const run = spawnSync(process.execPath, [join(root, script), ...(script.startsWith("bin/") ? ["unit", "--go"] : []), dir, ...args],
    {cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 5e6, ...options});
  assert.equal(run.error, undefined, run.stderr);
  return run;
};

describe("osgo unit CI entry point", function () {
  this.timeout(240000);
  let temp, input, config;
  beforeEach(() => {
    mkdirSync(join(root, ".local"), {recursive: true});
    temp = mkdtempSync(join(root, ".local", "osgo-ci-test-"));
    input = join(temp, "input"); mkdirSync(input);
    config = readFileSync(join(root, "abap_transpile.json"), "utf8");
  });
  afterEach(() => {
    assert.equal(readFileSync(join(root, "abap_transpile.json"), "utf8"), config);
    assert.equal(readdirSync(join(root, ".local")).some((name) => name.startsWith("osgo-unit-")), false, "staging cleaned");
    rmSync(temp, {recursive: true, force: true});
  });
  it("round 2 item 1: the conformance osgo child keeps the original ten folders and no user packs", async () => {
    fixture(input);
    const home = join(temp, "home"), config = {input_folder: ["src", "test", "gen"]};
    for (const folder of ["src", "test", "gen", ...["open-abap-core/src", "express-icf-shim/src", "open-abap-apc/src",
      "open-abap-gui/src", "open-abap-odata/src", "ajson/src/core"].map(f => ".local/lars/" + f), "packs/demo/src"])
      mkdirSync(join(home, folder), {recursive: true});
    writeFileSync(join(home, "packs/demo/osd-pack.json"), JSON.stringify({name: "demo"}));
    const originalSpawn = childProcess.spawn, originalLog = console.log;
    let folders, original;
    childProcess.spawn = (command, args) => {
      const staged = args[args.indexOf("--input") + 1];
      folders = unitInputs({home, config, extraInputs: [staged],
        extraPacks: !args.includes("--no-extra-packs"), env: {OSD_PACKS: input}}).folders;
      original = unitInputs({home, config, extraInputs: [staged], env: {OSD_PACKS: "", OSD_WEB_PACKS: ""}});
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({classes: 1, compiled: 1,
          rows: [{class: "ZCL_OSGO_CI", testclass: "LTCL_TEST", method: "CHECK", status: "SUCCESS"}]}));
        child.emit("close", 0);
      });
      return child;
    };
    syncBuiltinESMExports(); console.log = () => {};
    try {
      assert.equal(await main([input, "--json"]), 0);
      // origin/main conformance passed empty pack env: src, test, gen, staged input + six existing lib folders.
      assert.deepEqual(folders, original.folders);
      assert.equal(folders.length, 10);
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); console.log = originalLog; }
  });

  it("passes without XML, emits totals, and leaves the caller's folder unchanged", () => {
    fixture(input);
    const before = snapshot(input);
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.totals, {success: 1, failure: 0, not_compiled: 0, error: 0, tests: 1});
    assert.equal(result.classes, 1); assert.equal(result.compiled, 1);
    assert.equal(result.rows[0].status, "SUCCESS");
    assert.deepEqual(snapshot(input), before);
    assert.equal(existsSync(resolve(result.buildDir)), false, "generated Go tree cleaned");
  });
  it("runs character-set positions, fixed-width blanks and short circuits on both emitters", () => {
    const name = "zcl_gogen_t_setpos";
    for (const suffix of ["clas.abap", "clas.testclasses.abap"]) {
      const file = `${name}.${suffix}`;
      writeFileSync(join(input, file), readFileSync(join(root, "tools/gogen/testdata", file)));
    }
    const expected = ["POSITIONS", "TRAILING_BLANKS", "SHORT_CIRCUIT"];
    const go = invoke(input, ["--json"]);
    assert.equal(go.status, 0, go.stdout + go.stderr);
    const goRows = JSON.parse(go.stdout).rows;
    // IR-JS uses emit-js, not the separate abaplint/transpiler JS host.
    const out = join(temp, "irjs");
    const js = spawnSync(process.execPath, ["tools/gogen/unit-js.mjs", "--fixture", input, "--out", out],
      {cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 5e6});
    assert.equal(js.error, undefined, js.stderr);
    assert.equal(js.status, 0, js.stdout + js.stderr);
    const jsRows = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
    for (const rows of [goRows, jsRows]) {
      assert.deepEqual(rows.map((row) => row.method).sort(), [...expected].sort());
      assert.deepEqual(rows.map((row) => row.status), expected.map(() => "SUCCESS"));
    }
  });
  for (const jobs of [1, 2]) it(`attributes fatal recursion to its own class with jobs=${jobs}`, () => {
    const fixtureDir = join(root, "tools/gogen/testdata-unit-crash");
    const before = snapshot(fixtureDir);
    const run = invoke(fixtureDir, ["--json", "--jobs", String(jobs)], "tools/osgo-unit.mjs",
      {env: {...process.env, GOGEN_UNIT_MAX_STACK: "65536"}});
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.totals, {success: 3, failure: 0, not_compiled: 0, error: 1, tests: 4});
    assert.deepEqual(result.rows.map((row) => row.status), ["SUCCESS", "ERROR", "SUCCESS", "SUCCESS"]);
    assert.match(result.rows[1].message, /^runner died: runtime: goroutine stack exceeds 65536-byte limit/);
    assert.deepEqual(snapshot(fixtureDir), before);
  });
  it("returns 1 and a human method line on a failing assertion", () => {
    fixture(input, "zcl_osgo_ci", "cl_abap_unit_assert=>assert_equals( act = 1 exp = 2 ).");
    const run = invoke(input);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /ZCL_OSGO_CI\/LTCL_TEST\/CHECK: FAILURE/);
    assert.match(run.stdout, /Tests: 1, SUCCESS: 0, FAILURE: 1, NOT_COMPILED: 0, ERROR: 0/);
  });
  it("returns 2 for a construct gogen refuses", () => {
    fixture(input, "zcl_osgo_ci", "CALL TRANSACTION 'DUMMY'.");
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.totals.not_compiled, 1);
    assert.equal(result.totals.tests, 1);
  });
  it("returns 3 on empty or nonrecursive input", () => {
    mkdirSync(join(input, "nested")); fixture(join(input, "nested"));
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 3, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).totals, {success: 0, failure: 0, not_compiled: 0, error: 0, tests: 0});
  });
  it("returns 3 when an owner has a test include but no test methods", () => {
    fixture(input);
    writeFileSync(join(input, "zcl_osgo_ci.clas.testclasses.abap"), "");
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 3, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).totals.tests, 0);
  });
  it("preserves existing XML bytes and uses its metadata", () => {
    fixture(input);
    const xml = metadata("ZCL_OSGO_CI").replace("<DESCRIPT>ZCL_OSGO_CI</DESCRIPT>", "<DESCRIPT>Caller metadata</DESCRIPT>");
    writeFileSync(join(input, "zcl_osgo_ci.clas.xml"), xml);
    const before = snapshot(input);
    const run = invoke(input, ["--json", "--jobs", "1"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(snapshot(input), before);
    const program = compileProgram({folders: [input], objects: ["ZCL_OSGO_CI"]});
    assert.equal(program.reg.getObject("CLAS", "ZCL_OSGO_CI").getDescription(), "Caller metadata");
  });
  it("filters multiple names through the checkout's osd host", () => {
    fixture(input, "zcl_osgo_one"); fixture(input, "zcl_osgo_two");
    fixture(input, "zcl_osgo_fail", "cl_abap_unit_assert=>fail( ).");
    const run = invoke(input, ["--json", "--jobs", "2", "--class", "ZCL_OSGO_ONE", "ZCL_OSGO_TWO"], "bin/osd.mjs");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.totals.success, 2); assert.equal(result.totals.tests, 2); assert.equal(result.classes, 2);
  });
  it("adds --input after checkout layers and hides the complete earlier object", () => {
    const base = join(temp, "base"), overlay = join(temp, "overlay"); mkdirSync(base); mkdirSync(overlay);
    fixture(base); fixture(overlay);
    writeFileSync(join(base, "zcl_osgo_ci.clas.xml"), metadata("ZCL_OSGO_CI"));
    writeFileSync(join(base, "zcl_osgo_ci.clas.locals_def.abap"), "earlier include");
    const {skip, sources, folders, overrides} = unitInputs({home: temp, config: {input_folder: ["base"]}, extraInputs: [overlay]});
    assert.equal(folders.at(-1), overlay);
    assert.deepEqual(overrides, [{object: "CLAS ZCL_OSGO_CI", input: overlay, hidden: base}]);
    for (const file of readdirSync(base)) assert.equal(skip(join(base, file)), true);
    assert.deepEqual(sources, [join(overlay, "zcl_osgo_ci.clas.testclasses.abap")]);
    // Exercise the actual option by replacing a checkout owner and its test include.
    fixture(overlay, "zcl_osd_statics_test");
    const run = spawnSync(process.execPath, ["tools/gogen/unit.mjs", "--fixture", "test/fixtures/unit-statics", "--input", overlay,
      "--class", "ZCL_OSD_STATICS_TEST", "--jobs", "1", "--no-cache", "--out", join(temp, "out")],
    {cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 5e6});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).rows.map((row) => row.status), ["SUCCESS"]);
    assert.match(run.stderr, /Override CLAS ZCL_OSD_STATICS_TEST:/);
    assert.deepEqual(JSON.parse(run.stdout).overrides, [{object: "CLAS ZCL_OSD_STATICS_TEST", input: overlay,
      hidden: "test/fixtures/unit-statics"}]);
  });
  it("reports a checkout collision on stderr and in JSON", () => {
    fixture(input, "zcl_osd_adt_handler");
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stderr, /Override CLAS ZCL_OSD_ADT_HANDLER:/);
    const overrides = JSON.parse(run.stdout).overrides.filter((o) => o.object === "CLAS ZCL_OSD_ADT_HANDLER");
    assert.equal(overrides.length, 1);
    assert.ok(overrides[0].input.endsWith("/input"));
    assert.ok(overrides[0].hidden.startsWith(root + "/"));
  });
  it("carries abaplint syntax errors with the source file and line", () => {
    fixture(input, "zcl_osgo_ci", "DATA x TYPE i. x = .");
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.rows[0].status, "NOT_COMPILED");
    assert.match(result.rows[0].message, /zcl_osgo_ci\.clas\.testclasses\.abap:3:.*(parse|syntax|statement)/i);
  });
  for (const [length, comment, file] of [[256, false, "clas.abap"], [300, false, "clas.testclasses.abap"], [300, true, "clas.locals_imp.abap"]]) {
    it(`rejects a ${length}-character ${comment ? "comment" : "code"} line in ${file} before building`, () => {
      fixture(input);
      const name = `zcl_osgo_ci.${file}`;
      const line = comment ? "*" + "x".repeat(length - 1) : "WRITE '" + "x".repeat(length - 9) + "'.";
      assert.equal(line.length, length);
      writeFileSync(join(input, name), line + "\n");
      // No Go toolchain is reachable: validation must still yield the precise error.
      const run = invoke(input, ["--json"], "tools/osgo-unit.mjs", {env: {...process.env, PATH: ""}});
      assert.equal(run.status, 2, run.stdout + run.stderr);
      const result = JSON.parse(run.stdout);
      assert.deepEqual(result.rows, [{status: "ERROR", message: `${name}:1: line exceeds 255 characters (the kernel refuses it)`}]);
      assert.equal(result.compiled, 0);
      assert.equal(result.totals.error, 1);
      assert.equal(result.buildDir, undefined);
    });
  }
  it("accepts exactly 255 characters and CRLF lines", () => {
    fixture(input);
    const name = "zcl_osgo_ci.clas.testclasses.abap";
    writeFileSync(join(input, name), "*" + "x".repeat(254) + "\r\n" + readFileSync(join(input, name), "utf8"));
    const run = invoke(input, ["--json"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).totals.success, 1);
  });
  it("runs from another directory without leaving .local there", () => {
    fixture(input);
    const run = invoke(input, ["--json"], "tools/osgo-unit.mjs", {cwd: temp});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).totals.success, 1);
    assert.equal(existsSync(join(temp, ".local")), false);
  });
  it("rewrites only the hosted dispatch argument when the host prefix contains gen", () => {
    fixture(input);
    const env = {...process.env, OSD_SELF: JSON.stringify([process.execPath, "--title", "gen", join(root, "bin/osd.mjs")])};
    const run = invoke(input, ["--json"], "tools/osgo-unit.mjs", {env});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).totals.success, 1);
  });
  it("classifies infrastructure, skipped methods, and mixed outcomes conservatively", () => {
    for (const row of [{source: "harness", status: "FAILED", message: "runner: crashed", method: "CHECK"}, {source: "harness", status: "FAILED", message: "runner died: crashed", method: "CHECK"}, {status: "SKIPPED", method: "CHECK"}]) {
      const result = summarize({rows: [row]}); assert.equal(result.code, 2); assert.equal(result.result.totals.error, 1);
    }
    assert.equal(summarize({rows: [{status: "FAILED", method: "ONE"}, {status: "NOT_COMPILED", method: "TWO"}]}).code, 2);
  });
  it("returns parseable ERROR JSON on invalid arguments", () => {
    for (const args of [["--jobs", "0"], ["--class", "MISSING"], ["--unknown"]]) {
      const run = invoke(input, ["--json", ...args]); assert.equal(run.status, 2);
      assert.equal(JSON.parse(run.stdout).totals.error, 1);
    }
  });
});
