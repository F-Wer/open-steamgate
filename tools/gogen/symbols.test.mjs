import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {buildCommit, refreshSymbolBuild, reportSymbols, writeGo, writeSymbols} from "./symbols.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {home} from "./home.mjs";

const here = import.meta.dirname;
const fixture = join(here, "testdata-symbols");
const gui = libraryPath(home, "open-abap-gui");

test("converted report events keep original provenance, including implicit and empty events", async () => {
  const {convertProgram} = await import(join(gui, "converter/src/api.mjs"));
  for (const [source, events] of [
    ["REPORT zsymbols.\nWRITE / 'hello'.\n", [["START_OF_SELECTION", "START-OF-SELECTION", 2]]],
    ["REPORT zsymbols. WRITE / 'hello'.", [["START_OF_SELECTION", "START-OF-SELECTION", 1]]],
    ["REPORT zsymbols.\nDATA n TYPE i.\nn = 1.\nSTART-OF-SELECTION.\nn = 2.\n",
      [["START_OF_SELECTION", "START-OF-SELECTION", 3]]],
    ["REPORT zsymbols.\nPARAMETERS p_name TYPE string.\nINITIALIZATION.\np_name = 'hello'.\nAT SELECTION-SCREEN ON p_name.\nWRITE / p_name.\nAT SELECTION-SCREEN.\nWRITE / p_name.\nSTART-OF-SELECTION.\nWRITE / p_name.\nEND-OF-SELECTION.\n",
      [["INITIALIZATION", "INITIALIZATION", 3], ["AT_SELECTION_SCREEN_ON_FIELD", "AT SELECTION-SCREEN ON P_NAME", 5],
        ["AT_SELECTION_SCREEN", "AT SELECTION-SCREEN", 7], ["START_OF_SELECTION", "START-OF-SELECTION", 9],
        ["END_OF_SELECTION", "END-OF-SELECTION", 11]]],
    ["REPORT zsymbols.\nLOAD-OF-PROGRAM.\nSTART-OF-SELECTION.\nWRITE / 'hello'.\n",
      [["LOAD_OF_PROGRAM", "LOAD-OF-PROGRAM", 2], ["START_OF_SELECTION", "START-OF-SELECTION", 3]]],
    ["REPORT zsymbols.\nSTART-OF-SELECTION.\nWRITE / 'hello'.\nTOP-OF-PAGE.\nWRITE / 'heading'.\nAT LINE-SELECTION.\nWRITE / 'detail'.\n",
      [["START_OF_SELECTION", "START-OF-SELECTION", 2], ["TOP_OF_PAGE", "TOP-OF-PAGE", 4, "ZIF_GG_LIST_PROCESSING_V1"],
        ["AT_LINE_SELECTION", "AT LINE-SELECTION", 6, "ZIF_GG_LIST_PROCESSING_V1"]]],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "gogen-report-symbols-"));
    try {
      const converted = await convertProgram({source, filename: "zsymbols.prog.abap", mode: "strict",
        nativePassthrough: true, className: "ZCL_SYMBOL_REPORT", transactionCode: "ZSYMBOLS"});
      assert.equal(converted.supported, true);
      writeFileSync(join(dir, "zcl_symbol_report.clas.abap"), converted.classSource);
      const program = compileProgram({folders: [join(libraryPath(home, "open-abap-core"), "src"),
        join(gui, "framework"), dir], objects: ["ZCL_SYMBOL_REPORT"]});
      reportSymbols(program, converted, "ZSYMBOLS", "zsymbols.prog.abap");
      writeGo(join(dir, "zz_generated.go"), program);
      const {symbols} = JSON.parse(readFileSync(join(dir, "symbols.json"), "utf8"));
      for (const [method, label, line, intf = "ZIF_GG_REPORT_V1"] of events) {
        const go = `${intf}__${method}`;
        assert.deepEqual(symbols[`main.(*ZCL_SYMBOL_REPORT).${go}`], {
          go, abap: `ZSYMBOLS (${label})`, owner: "ZSYMBOLS", kind: "event", file: "zsymbols.prog.abap", line,
        });
      }
      const helpers = Object.values(symbols).filter((s) => s.abap.startsWith("ZCL_SYMBOL_REPORT=>"));
      assert.ok(helpers.length > 0);
      for (const helper of helpers) {
        assert.equal(helper.kind, "generated", helper.abap);
        assert.equal("file" in helper, false, helper.abap);
        assert.equal("line" in helper, false, helper.abap);
      }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test("symbol map round-trips ABAP names and real pprof frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-symbols-"));
  try {
    const source = join(dir, "source");
    cpSync(fixture, source, {recursive: true});
    const {convertProgram} = await import(join(gui, "converter/src/api.mjs"));
    const converted = await convertProgram({source: readFileSync(join(source, "zsymbols.prog.abap"), "utf8"),
      filename: "zsymbols.prog.abap", mode: "strict", nativePassthrough: true,
      className: "ZCL_SYMBOL_REPORT", transactionCode: "ZSYMBOLS"});
    assert.equal(converted.supported, true);
    writeFileSync(join(source, "zcl_symbol_report.clas.abap"), converted.classSource);
    for (const helper of converted.helperSources ?? []) writeFileSync(join(source, `${helper.className.toLowerCase()}.clas.abap`), helper.source);
    const program = compileProgram({folders: [join(libraryPath(home, "open-abap-core"), "src"),
      join(gui, "framework"), source], objects: ["/MY_NS/DEMO", "ZSYMBOLS", "ZCL_SYMBOL_REPORT", ...(converted.helperSources ?? []).map((h) => h.className)], includeTests: true});
    reportSymbols(program, converted, "ZSYMBOLS", "zsymbols.prog.abap");
    const out = join(dir, "go");
    mkdirSync(out);
    writeGo(join(out, "zz_generated.go"), program);
    const json = readFileSync(join(out, "symbols.json"), "utf8");
    const map = JSON.parse(json);
    assert.equal(map.schema, "gogen-symbols/1");
    assert.equal(map.build, buildCommit());
    assert.match(map.build, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(map.symbols), Object.keys(map.symbols).sort());
    const expected = {
      "main.N_MY_NS_DEMO_N_HELPER_RUN": ["/MY_NS/DEMO=>N_HELPER_RUN", "method", "#my_ns#demo.clas.abap", 23],
      "main.(*N_MY_NS_DEMO).ZIF_SYMBOLS__METH": ["/MY_NS/DEMO=>ZIF_SYMBOLS~METH", "method", "#my_ns#demo.clas.abap", 15],
      "main.(*N_MY_NS_DEMO).CONSTRUCTOR": ["/MY_NS/DEMO=>CONSTRUCTOR", "method", "#my_ns#demo.clas.abap", 11],
      "main.N_MY_NS_DEMO_CLASS_CONSTRUCTOR": ["/MY_NS/DEMO=>CLASS_CONSTRUCTOR", "method", "#my_ns#demo.clas.abap", 13],
      "main.(*N_MY_NS_DEMO).HANDLE": ["/MY_NS/DEMO=>HANDLE", "method", "#my_ns#demo.clas.abap", 28],
      "main.N_MY_NS_DEMO_LTCL_LOCAL_RUN": ["/MY_NS/DEMO:LTCL_LOCAL=>RUN", "local", "#my_ns#demo.clas.testclasses.abap", 6, "/MY_NS/DEMO"],
      "main.FUGR_ZSYMBOLS_Z_SYMBOLS": ["FUGR:ZSYMBOLS=>Z_SYMBOLS", "fm", "zsymbols.fugr.z_symbols.abap", 1, "ZSYMBOLS"],
      "main.(*ZCL_SYMBOL_REPORT).FORM_N_HELPER_RUN": ["ZSYMBOLS=>N_HELPER_RUN", "form", "zsymbols.prog.abap", 4, "ZSYMBOLS"],
    };
    for (const [key, [abap, kind, file, line, owner]] of Object.entries(expected)) {
      assert.deepEqual(map.symbols[key], {go: key.slice(key.lastIndexOf(".") + 1), abap,
        ...(owner ? {owner} : {}), kind, file, line}, key);
    }
    assert.deepEqual(map.symbols["main.ZCL_SYMBOL_REPORT_H1_RUN"], {go: "ZCL_SYMBOL_REPORT_H1_RUN",
      abap: "ZSYMBOLS:LCL_REPORT=>RUN", owner: "ZSYMBOLS", kind: "local", file: "zsymbols.prog.abap", line: 15});
    assert.deepEqual(map.symbols["main.(*ZCL_SYMBOL_REPORT_H1).CONSTRUCTOR"], {go: "CONSTRUCTOR",
      abap: "ZCL_SYMBOL_REPORT_H1=>CONSTRUCTOR", kind: "generated"});
    assert.equal(map.symbols["main.(*ZCL_SYMBOL_REPORT).ZIF_GG_REPORT_V1__START_OF_SELECTION"].line, 2);
    writeGo(join(out, "zz_generated.go"), program);
    assert.equal(readFileSync(join(out, "symbols.json"), "utf8"), json);
    writeSymbols(out, Object.fromEntries(Object.entries(map.symbols).reverse()), "unknown");
    assert.equal(JSON.parse(readFileSync(join(out, "symbols.json"))).build, "unknown");
    refreshSymbolBuild(out);
    assert.equal(readFileSync(join(out, "symbols.json"), "utf8"), json);

    const module = join(here, "go");
    cpSync(join(module, "go.sum"), join(out, "go.sum"));
    writeFileSync(join(out, "go.mod"), readFileSync(join(module, "go.mod"), "utf8")
      .replace("module osg/gogen", `module symbolcheck\n\nrequire osg/gogen v0.0.0\nreplace osg/gogen => ${module}`));
    writeFileSync(join(out, "main.go"), `package main
import ("os"; "runtime/pprof"; "time"; "osg/gogen/abap")
var sink int32
func main() {
 f, err := os.Create("cpu.pprof"); if err != nil { panic(err) }
 if err = pprof.StartCPUProfile(f); err != nil { panic(err) }
 s := &abap.Session{}
 o := New_N_MY_NS_DEMO(s)
 report := New_ZCL_SYMBOL_REPORT(s)
 for _, run := range []func(){
  func(){sink = N_MY_NS_DEMO_N_HELPER_RUN(s)},
  func(){sink = o.ZIF_SYMBOLS__METH(s)},
  func(){sink = N_MY_NS_DEMO_LTCL_LOCAL_RUN(s)},
  func(){FUGR_ZSYMBOLS_Z_SYMBOLS(s, &sink)},
  func(){report.FORM_N_HELPER_RUN(s, nil)},
 } { end := time.Now().Add(400*time.Millisecond); for time.Now().Before(end) { run() } }
 pprof.StopCPUProfile(); f.Close()
}
`);
    execFileSync("go", ["build", "-mod=mod", "-gcflags=all=-l", "-o", "profile", "."], {cwd: out, stdio: "inherit"});
    execFileSync(join(out, "profile"), {cwd: out, stdio: "inherit"});
    const raw = execFileSync("go", ["tool", "pprof", "-raw", "profile", "cpu.pprof"], {cwd: out, encoding: "utf8"});
    const names = [...raw.matchAll(/^\s*\d+:\s+0x[\da-f]+\s+(?:M=\d+\s+)?([^\s]+)/gm)].map((m) => m[1]);
    const routines = Object.keys(expected).filter((k) => !/CONSTRUCTOR|HANDLE/.test(k));
    for (const key of routines) assert.ok(names.some((n) => n === key || n.startsWith(key + ".func")), `${key}\n${raw}`);
    const closure = names.find((n) => n.startsWith("main.(*N_MY_NS_DEMO).ZIF_SYMBOLS__METH.func"));
    assert.ok(closure, raw);
    const parent = closure.replace(/(?:\.func\d+(?:\.\d+)*)+$/, "");
    assert.equal(map.symbols[parent].abap, "/MY_NS/DEMO=>ZIF_SYMBOLS~METH");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("layer maps use import paths and contain only emitted routines", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-symbol-layers-"));
  try {
    const program = compileProgram({folders: [join(libraryPath(home, "open-abap-core"), "src"), fixture],
      objects: ["/MY_NS/DEMO", "ZSYMBOLS"], includeTests: true});
    const classes = program.classes.filter((c) => c.name === "/MY_NS/DEMO");
    const symbols = {};
    writeGo(join(dir, "zz_generated.go"), program, "core", {classes}, true, symbols);
    assert.ok(symbols["osg/gogen/generated/core.(*N_MY_NS_DEMO).CONSTRUCTOR"]);
    assert.ok(symbols["osg/gogen/generated/core.N_MY_NS_DEMO_N_HELPER_RUN"]);
    assert.equal(Object.values(symbols).some((s) => s.kind === "fm" || s.kind === "local"), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
