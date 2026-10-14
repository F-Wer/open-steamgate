// SPDX-License-Identifier: MIT
// Raw parent/candidate proof. From the repository root, with pinned libraries:
//   OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh node tools/gogen/typing-proof.mjs --record .local/typing-parent
//   OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh node tools/gogen/typing-proof.mjs --compare .local/typing-parent
// Record BEFORE implementation edits; use the same checkout, relative fixtures,
// Node version, options and environment for compare. No gofmt or normalization:
// emitGo/emitJs strings, stable-build symbols JSON, refusal arrays and copied
// JS/Go runtime files are byte contracts. Cache blobs and HEAD provenance aren't.
// Each sink-locals mode (0/1) runs in three fresh child processes: no cache,
// cold with an empty cacheDir, then warm with that SAME cacheDir. All artifacts
// are compared across cache modes as well as against the recorded parent.
// Warm is deliberately a fresh process, with no registry/session held in memory.
// Scratch stays outside tools/: the cache hashes every .mjs/.ts below gogen,
// including generated files. Do not run other output-writing gogen tests beside
// a proof; their generated modules would invalidate its cold/warm tool identity.
// Fixed checkout-relative input paths preserve source positions without rewriting
// output. An exclusive scratch directory prevents concurrent fixture mutation.
// This driver does not capture ctx.program or a raw frontend program in helper
// closures: PROGRAM is a write proxy used by hierarchy memoization (#733).
// Node 22.14-22.17 needs NODE_OPTIONS=--experimental-strip-types (inherited by
// children); this driver also forwards explicit Node execution flags.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join, relative, resolve} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";
import {symbolCollector, writeSymbols} from "./symbols.ts";
import {copyJsRuntime} from "./copy-js-runtime.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {unitInputs} from "./unit-inputs.mjs";

const here = relative(process.cwd(), import.meta.dirname);
const scratch = join(".local", "gogen-typing-proof");
const inputs = join(scratch, "inputs");
const corpus = join(here, "testdata");
const classNames = (dir) => readdirSync(dir).filter((f) => f.endsWith(".clas.abap") || f.endsWith(".fugr.xml"))
  .map((f) => f.split(".")[0]).sort();
const files = (dir) => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => e.isDirectory() ? files(join(dir, e.name)).map((f) => join(e.name, f)) : [e.name]);

// Same runtime/core closure as semantics.mjs (including AJSON and RTTI).
const coreObjects = ["CX_SY_ZERODIVIDE", "CX_SY_ARITHMETIC_ERROR", "CX_SY_CONVERSION_NO_NUMBER", "CX_SY_CONVERSION_ERROR", "KERNEL_INTERNAL_NAME", "CX_ROOT", "CX_STATIC_CHECK", "CX_DYNAMIC_CHECK", "CX_NO_CHECK", "CL_MESSAGE_HELPER", "CL_ABAP_CONV_OUT_CE", "CL_ABAP_CONV_IN_CE", "CL_ABAP_REGEX", "CL_HTTP_UTILITY", "ZCL_AJSON", "ZIF_AJSON", "ZIF_AJSON_TYPES", "ZCX_AJSON_ERROR", "CL_ABAP_MESSAGE_DIGEST", "CX_ABAP_MESSAGE_DIGEST", "CL_ABAP_TYPEDESCR", "CL_ABAP_DATADESCR", "CL_ABAP_ELEMDESCR", "CL_ABAP_COMPLEXDESCR", "CL_ABAP_STRUCTDESCR", "CL_ABAP_TABLEDESCR", "CL_ABAP_REFDESCR", "CL_ABAP_OBJECTDESCR", "CL_ABAP_CLASSDESCR", "CL_ABAP_INTFDESCR", "/UI2/CL_JSON", "CL_SXML_STRING_READER", "CX_SXML_PARSE_ERROR", "CX_SXML_ERROR", "CL_ABAP_CODEPAGE", "CL_ABAP_GZIP", "CL_ABAP_ZIP"];

function source(name, definition, body) {
  return `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC. PUBLIC SECTION. ${definition} ENDCLASS.
CLASS ${name} IMPLEMENTATION. ${body} ENDCLASS.`;
}

function prepareInputs() {
  mkdirSync(inputs);
  writeFileSync(join(inputs, "zcl_ctor_default.clas.abap"), source("zcl_ctor_default",
    "METHODS constructor IMPORTING iv TYPE i DEFAULT 5.", "METHOD constructor. ENDMETHOD."));
  const types = ["c LENGTH 2", "c LENGTH 3", "n LENGTH 3", "d", "t", "string"];
  writeFileSync(join(inputs, "zcl_constant_unicode.clas.abap"), source("zcl_constant_unicode", "CLASS-METHODS run.",
    `METHOD run. ${types.map((type, i) => `CONSTANTS u${i} TYPE ${type} VALUE '😀z'.
CONSTANTS a${i} TYPE ${type} VALUE '12'.
CONSTANTS: BEGIN OF r${i}, ascii${i} TYPE c VALUE 'a', unicode${i} TYPE ${type} VALUE '😀z', END OF r${i}.`).join("\n")} ENDMETHOD.`));
  // Positive and escape/evaluation-order cases from frontend-owned.test.mjs.
  // Separate classes keep ownership identities and static/instance storage apart.
  const cases = [
    ["mem = '12345678'. b = mem. b = mem+1(2). mv_mem = mem. REPLACE SECTION OFFSET 1 LENGTH 2 OF mv_mem WITH b IN BYTE MODE. CONCATENATE mv_mem b b INTO mv_mem IN BYTE MODE. CLEAR mem."],
    ...["FIELD-SYMBOLS <x> TYPE xstring. ASSIGN mem TO <x>.",
      "DATA r TYPE REF TO xstring. GET REFERENCE OF mem INTO r.", "DATA r TYPE REF TO xstring. r = REF #( mem ).",
      "FIELD-SYMBOLS <x> TYPE any. DATA name TYPE string VALUE 'MEM'. ASSIGN (name) TO <x>.",
      "FIELD-SYMBOLS <x> TYPE any. ASSIGN ('MEM') TO <x>.", "FIELD-SYMBOLS <x> TYPE any. ASSIGN COMPONENT 1 OF STRUCTURE mem TO <x>."].map((body) => [body]),
    ...[["CHANGING p TYPE xstring", "CHANGING p = mem"], ["EXPORTING p TYPE xstring", "IMPORTING p = mem"],
      ["IMPORTING p TYPE xstring", "EXPORTING p = mem"], ["IMPORTING VALUE(p) TYPE xstring", "mem"],
      ["RETURNING VALUE(p) TYPE xstring", "RECEIVING p = mem"]]
      .map(([signature, actual]) => [`other( ${actual} ).`, `METHODS other ${signature}.`, "METHOD other. ENDMETHOD."]),
    ["TYPES: BEGIN OF row, bytes TYPE xstring, END OF row. DATA r TYPE row. DATA rows TYPE STANDARD TABLE OF xstring WITH DEFAULT KEY. r-bytes = mem. APPEND mem TO rows."],
    ["mv_mem = '1234'.", "METHODS other.", "METHOD other. FIELD-SYMBOLS <x> TYPE xstring. ASSIGN mv_mem TO <x>. REPLACE FIRST OCCURRENCE OF mv_mem IN mv_mem WITH mv_mem IN BYTE MODE. ENDMETHOD."],
    ["mem = '1234'.", "METHODS other. METHODS helper CHANGING p TYPE xstring.", "METHOD other. DATA mem TYPE xstring. helper( CHANGING p = mem ). ENDMETHOD. METHOD helper. ENDMETHOD."],
    ["", "METHODS constructor.", "METHOD constructor. DATA memory TYPE xstring. memory = '1234'. CLEAR memory. ENDMETHOD."],
    ["mv_mem = '01'. CONCATENATE mv_mem mv_mem INTO mv_mem IN BYTE MODE."],
    ...["b = comb( iv_a = mv_mem iv_b = grow( ) ).", "DATA n TYPE i. n = xstrlen( mv_mem ) + xstrlen( grow( ) ).", "IF mv_mem = grow( ). CLEAR b. ENDIF.", "mem = '01'. REPLACE SECTION OFFSET 0 LENGTH 1 OF mem WITH grow( ) IN BYTE MODE."]
      .map((body) => [`mv_mem = '01'. ${body}`, "METHODS grow RETURNING VALUE(r) TYPE xstring. METHODS comb IMPORTING VALUE(iv_a) TYPE xstring VALUE(iv_b) TYPE xstring RETURNING VALUE(r) TYPE xstring.", "METHOD grow. DATA ff TYPE x LENGTH 1 VALUE 'FF'. CONCATENATE mv_mem ff INTO mv_mem IN BYTE MODE. r = 'EE'. ENDMETHOD. METHOD comb. CONCATENATE iv_a iv_b INTO r IN BYTE MODE. ENDMETHOD."]),
    ["DATA replacement TYPE x LENGTH 1 VALUE 'FF'. mv_mem = '01'. DO 2 TIMES. REPLACE SECTION OFFSET 0 LENGTH 1 OF mv_mem WITH replacement IN BYTE MODE. grow( ). ENDDO.", "METHODS grow RETURNING VALUE(r) TYPE xstring.", "METHOD grow. r = 'EE'. ENDMETHOD."],
    ...[false, true].map((staticMemory) => ["DATA replacement TYPE x LENGTH 4 VALUE '01020304'. REPLACE SECTION OFFSET 1024 LENGTH 4 OF mv_mem WITH replacement IN BYTE MODE.", "METHODS init IMPORTING VALUE(memory) TYPE xstring.", "METHOD init. mv_mem = memory. ENDMETHOD.", staticMemory]),
    ...["FIELD-SYMBOLS <x> TYPE any. ASSIGN mv_mem TO <x>.", "DATA r TYPE REF TO xstring. GET REFERENCE OF mv_mem INTO r.", "other( CHANGING p = mv_mem ).", "DATA n TYPE i. n = xstrlen( mv_mem ) + xstrlen( grow( ) ).", "DATA rows TYPE STANDARD TABLE OF xstring WITH DEFAULT KEY. APPEND mv_mem TO rows."]
      .map((body) => [body, "METHODS other CHANGING p TYPE xstring. METHODS grow RETURNING VALUE(r) TYPE xstring.", "METHOD other. ENDMETHOD. METHOD grow. r = 'FF'. ENDMETHOD.", true]),
    ["DATA b1 TYPE x LENGTH 1 VALUE 'FF'. b = mv_mem+0(1). REPLACE SECTION OFFSET 0 LENGTH 1 OF mv_mem WITH b1 IN BYTE MODE. CONCATENATE mv_mem mv_mem INTO mv_mem IN BYTE MODE.", "CLASS-METHODS class_constructor. CLASS-METHODS store.", "METHOD class_constructor. mv_mem = '0102'. ENDMETHOD. METHOD store. CLEAR mv_mem. ENDMETHOD.", true],
    ["mv_mem = '00'.", "TYPES packed TYPE p LENGTH 16 DECIMALS 0. METHODS checksum IMPORTING VALUE(seed) TYPE packed VALUE(n) TYPE i RETURNING VALUE(r) TYPE packed.", "METHOD checksum. r = seed. r = r + n. ENDMETHOD."],
    ["mv_mem = '00'.", "TYPES packed TYPE p LENGTH 16 DECIMALS 0. METHODS checksum IMPORTING VALUE(n) TYPE i RETURNING VALUE(r) TYPE packed.", "METHOD checksum. DATA ptr TYPE REF TO packed. GET REFERENCE OF r INTO ptr. r = r + n. ENDMETHOD."],
    ...["", "DATA r TYPE REF TO x. GET REFERENCE OF byte INTO r.", "FIELD-SYMBOLS <b> TYPE x. ASSIGN byte TO <b>."]
      .map((escape) => [`DATA byte TYPE x LENGTH 1. DATA n TYPE i. mem = 'FF'. byte = mem+0(1). n = byte. byte = n. REPLACE SECTION OFFSET 0 LENGTH 1 OF mem WITH byte IN BYTE MODE. ${escape}`]),
  ];
  for (const [i, [body, definition = "", methods = "", staticMemory = false]] of cases.entries()) {
    const name = `zcl_proof_owned_${String(i).padStart(2, "0")}`;
    writeFileSync(join(inputs, `${name}.clas.abap`), source(name,
      `METHODS run. ${definition} PRIVATE SECTION. ${staticMemory ? "CLASS-DATA" : "DATA"} mv_mem TYPE xstring.`,
      `METHOD run. DATA mem TYPE xstring. DATA b TYPE xstring. ${body} ENDMETHOD. ${methods}`));
  }
  // Keep added captures separate: the original parent artifacts stay comparable.
  for (const [name, body, definition, methods] of [
    ["boxed", "mem = '1234'.", "", ""],
    ["substring-call", "b = comb( iv_a = mv_mem iv_b = grow( ) ).",
      "METHODS grow RETURNING VALUE(r) TYPE xstring. METHODS comb IMPORTING VALUE(iv_a) TYPE xstring VALUE(iv_b) TYPE xstring RETURNING VALUE(r) TYPE xstring.",
      "METHOD grow. DATA ff TYPE x LENGTH 1 VALUE 'FF'. CONCATENATE mv_mem ff INTO mv_mem IN BYTE MODE. r = 'EE'. ENDMETHOD. METHOD comb. CONCATENATE iv_a iv_b INTO r IN BYTE MODE. ENDMETHOD."],
  ]) {
    const dir = join(scratch, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "zcl_owned.clas.abap"), source("zcl_owned",
      `METHODS run. ${definition} PRIVATE SECTION. DATA mv_mem TYPE xstring.`,
      `METHOD run. DATA mem TYPE xstring. DATA b TYPE xstring. ${body} ENDMETHOD. ${methods}`));
  }
}

function capture(out, cache) {
  const core = join(libraryPath(process.cwd(), "open-abap-core"), "src");
  const ajson = join(libraryPath(process.cwd(), "ajson"), "src/core");
  // Checkout-relative paths keep source positions byte-stable across worktrees.
  const config = JSON.parse(readFileSync("abap_transpile.json", "utf8"));
  const {folders: adtFolders} = unitInputs({home: ".", config});
  const fixtures = [
    {name: "semantics", folders: [corpus, core, ajson], objects: [...classNames(corpus), ...coreObjects]},
    {name: "constructors-constants-owned", folders: [inputs], objects: classNames(inputs)},
    {name: "constructor-refused", folders: [inputs], objects: ["ZCL_CTOR_DEFAULT"]},
    {name: "layers", folders: [join(here, "fixtures/session-statics")], objects: ["ZCL_RACE_INIT", "ZCL_RACE_COUNTER", "ZCL_RACE_READER", "ZCL_RACE_CHILD", "ZCL_RACE_BASE"]},
    // The owned test exercises Go; JS currently refuses the session's enqueue.
    {name: "owned-adt-session", folders: adtFolders, objects: ["ZCL_OSD_ADT_SESSION", "CL_ABAP_TSTMP"], tolerant: true,
      jsRefusal: "no JS for statement call_enq"},
    ...[true, false].map((length) => ({
      name: length ? "owned-boxed-length" : "owned-boxed-value", folders: [join(scratch, "boxed")], objects: ["ZCL_OWNED"],
      mutate(program) {
        const mem = {e: "var", name: "MEM", type: {k: "xstring"}};
        const boxed = {e: "wrap", x: length ? {e: "xstrlen", x: mem, type: {k: "i"}} : mem, type: {k: "data"}};
        program.classes[0].methods[0].body.push({s: "call", call: {e: "call", method: "OTHER", static: true,
          args: [{dir: "importing", byValue: false, type: {k: "data"}, value: boxed}], type: {k: "void"}}});
      },
    })),
    {name: "owned-substring-call", folders: [join(scratch, "substring-call")], objects: ["ZCL_OWNED"],
      mutate(program) {
        const call = program.classes[0].methods.find((m) => m.name === "RUN").body.at(-1).value;
        const arg = call.args[0];
        arg.value = {e: "substr", x: arg.value, base: arg.value.type, off: {e: "int", value: 0}, len: {e: "int", value: 1}, type: {k: "xstring"}};
      },
    },
    // Preserve the separate selection/diagnostic ordering used by semantics.
    ...[["zcl_gogen_t_rf", "zcl_gogen_t_rf_obj", "zcl_gogen_t_rf_own"], ["zcl_gogen_t_rf_sort"], ["zcl_gogen_t_rf_delfrom"], ["zcl_gogen_t_rf_seckeyh"], ["zcl_gogen_t_rf_wherei8"], ["zcl_gogen_t_rf_resume", "CX_SY_ZERODIVIDE"]]
      .map((objects, i) => ({name: `refused-${i}`, folders: [join(here, "testdata-refused"), core], objects, tolerant: true})),
  ];
  let reused = 0, lowered = 0;
  for (const fixture of fixtures) {
    const {name, mutate, jsRefusal, ...options} = fixture;
    const program = compileProgram({...options, ...(cache ? {cacheDir: join(cache, name)} : {})});
    mutate?.(program);
    reused += program.frontendCounts.reusedClasses.length;
    lowered += program.frontendCounts.loweredClasses.length;
    if (name === "constructor-refused") program.classes[0].constructor.params[0].default = "ZCL_CTOR_DEFAULT=>NO_SUCH";
    const dir = join(out, name);
    mkdirSync(dir, {recursive: true});
    const symbols = new Map();
    writeFileSync(join(dir, "raw.go"), emitGo(program, "main", null, false, symbolCollector(program, "main", symbols)));
    if (jsRefusal) {
      let message;
      try { emitJs(program); } catch (error) { message = error.message; }
      assert.equal(message, jsRefusal, `${name}: expected JS refusal`);
      writeFileSync(join(dir, "js-refusal.txt"), message);
    } else writeFileSync(join(dir, "raw.mjs"), emitJs(program));
    writeFileSync(join(dir, "refusals.json"), JSON.stringify({broken: program.broken, skipped: program.skipped, partial: program.partial, diagnostics: program.diagnostics}, null, 2) + "\n");
    if (name === "layers") {
      const base = program.classes.filter((c) => c.name === "ZCL_RACE_BASE");
      const rest = program.classes.filter((c) => c.name !== "ZCL_RACE_BASE");
      writeFileSync(join(dir, "core.go"), emitGo(program, "core", {classes: base, structs: new Map(), consts: new Map(), externalClasses: new Set(rest.map((c) => c.name)), marker: "StaticsCoreLayer"}, false, symbolCollector(program, "typing-proof/core", symbols)));
      writeFileSync(join(dir, "app.go"), emitGo(program, "app", {classes: rest, structs: new Map(), consts: new Map(), externalClasses: new Set(base.map((c) => c.name)), imports: ["typing-proof/core"], importMarkers: ["StaticsCoreLayer"]}, false, symbolCollector(program, "typing-proof/app", symbols)));
    }
    writeSymbols(dir, symbols, "typing-proof");
  }
  if (cache) {
    assert.ok(lowered > 0, "cache path compiled no classes");
    if (process.env.GOGEN_TYPING_CACHE_MODE === "warm") assert.ok(reused > 0, "warm cache reused no classes");
    else assert.equal(reused, 0, "cold cache was not empty");
    console.log(`typing-proof cache: ${lowered} lowered, ${reused} reused`);
  }
  const runtime = join(out, "runtime");
  mkdirSync(join(runtime, "js"), {recursive: true});
  copyJsRuntime(join(runtime, "js"));
  // Same Go tree copy as unit.mjs, excluding generated commands and tests.
  cpSync(join(here, "go"), join(runtime, "go"), {recursive: true,
    filter: (file) => !relative(join(here, "go"), file).split(/[\\/]/).includes("cmd") && !file.endsWith("_test.go")});
}

export function compareBytes(expected, actual) {
  const names = files(expected);
  assert.deepEqual(files(actual), names, `artifact list differs: ${actual}`);
  for (const name of names) {
    const before = readFileSync(join(expected, name)), after = readFileSync(join(actual, name));
    if (!before.equals(after)) {
      let offset = 0;
      while (offset < Math.min(before.length, after.length) && before[offset] === after[offset]) offset++;
      throw new Error(`${name}: bytes differ at ${offset} (${before.length} vs ${after.length} bytes)`);
    }
  }
  return names.length;
}

function main() {
  const [action, target, ...extra] = process.argv.slice(2);
  if (action === "--capture" && extra.length === 1) return capture(target, extra[0] === "none" ? null : extra[0]);
  if (!["--record", "--compare"].includes(action) || !target || extra.length) throw new Error("usage: typing-proof.mjs --record <dir> | --compare <dir>");
  if (action === "--record" && existsSync(target)) throw new Error(`record directory already exists: ${target}`);
  if (action === "--compare" && !existsSync(target)) throw new Error(`record directory missing: ${target}`);
  mkdirSync(".local", {recursive: true});
  mkdirSync(scratch); // exclusive: never remove somebody else's active proof
  try {
    prepareInputs();
    const output = join(scratch, "output");
    for (const sink of ["0", "1"]) {
      const cache = join(scratch, `cache-${sink}`);
      for (const mode of ["none", "cold", "warm"]) {
        const dir = join(output, `sink-${sink}`, mode);
        const child = spawnSync(process.execPath, [...process.execArgv, join(here, "typing-proof.mjs"), "--capture", dir, mode === "none" ? "none" : cache],
          {stdio: "inherit", env: {...process.env, GOGEN_SINK_LOCALS: sink, GOGEN_TYPING_CACHE_MODE: mode}});
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, `capture sink=${sink} cache=${mode}`);
        const count = mode === "none" ? files(dir).length : compareBytes(join(output, `sink-${sink}`, "none"), dir);
        if (action === "--compare") compareBytes(join(target, `sink-${sink}`, mode), dir);
        console.log(`typing-proof ${action.slice(2)} sink=${sink} cache=${mode}: ${count} byte-identical artifacts`);
      }
    }
    if (action === "--record") cpSync(output, target, {recursive: true});
    else compareBytes(target, output); // also reject added/removed top-level artifacts
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) main();
