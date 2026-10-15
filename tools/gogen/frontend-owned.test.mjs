import {copyJsRuntime} from "./copy-js-runtime.mjs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {compileProgram} from "./frontend.mjs";
import {analyzeOwnership} from "./frontend-owned.ts";
import {emitJs} from "./emit-js.mjs";
import {emitGo} from "./emit-go.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {unitInputs} from "./unit-inputs.mjs";
import {home} from "./home.mjs";

mkdirSync(join(import.meta.dirname, ".out"), {recursive: true});

function compile(body, extra = "", definition = "", staticMemory = false) {
  const dir = mkdtempSync(join(import.meta.dirname, ".out", "gogen-owned-"));
  try {
    writeFileSync(join(dir, "zcl_owned.clas.abap"), `CLASS zcl_owned DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. METHODS run. ${definition}
PRIVATE SECTION. ${staticMemory ? "CLASS-DATA" : "DATA"} mv_mem TYPE xstring.
ENDCLASS.
CLASS zcl_owned IMPLEMENTATION.
METHOD run. DATA mem TYPE xstring. DATA b TYPE xstring. ${body} ENDMETHOD.
${extra}
ENDCLASS.`);
    return compileProgram({folders: [dir], objects: ["ZCL_OWNED"], tolerant: true});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
function owns(p, name = "MEM") {
  const cls = p.classes[0], method = cls.methods.find((m) => m.name === "RUN");
  assert.ok(method, JSON.stringify(p.partial));
  const local = method.locals.find((v) => v.name === name);
  return analyzeOwnership(p).declarations.has(local);
}

test("ABAPiti private memory and a local qualify; slices and whole reads are snapshots", () => {
  const p = compile(`mem = '12345678'. b = mem. b = mem+1(2).
    mv_mem = mem. REPLACE SECTION OFFSET 1 LENGTH 2 OF mv_mem WITH b IN BYTE MODE.
    CONCATENATE mv_mem b b INTO mv_mem IN BYTE MODE. CLEAR mem.`);
  assert.deepEqual(p.partial, []);
  assert.equal(owns(p), true);
  assert.ok(analyzeOwnership(p).declarations.has(p.classes[0].attributes.find((a) => a.name === "MV_MEM")));
  const go = emitGo(p);
  assert.match(go, /mv_mem hXbuf.Buffer/);
  assert.match(go, /mem\.Sub\(int32\(1\), int32\(2\)\)/);
  assert.match(go, /mv_mem\.Replace/);
  assert.match(go, /mv_mem\.Append/);
  assert.match(go, /mem\.Clear/);
});

test("the ADT session sweep compiles", () => {
  const config = JSON.parse(readFileSync(join(home, "abap_transpile.json"), "utf8"));
  const {folders} = unitInputs({home, config});
  const program = compileProgram({folders, objects: ["ZCL_OSD_ADT_SESSION", "CL_ABAP_TSTMP"], tolerant: true});
  const generated = emitGo(program);
  assert.doesNotMatch(generated, /NotCompiled\([^\n]*ZCL_OSD_ADT_SESSION=>SWEEP/);
});

test("ASSIGN, GET REFERENCE, REF #, and dynamic names disqualify", () => {
  for (const statement of [
    "FIELD-SYMBOLS <x> TYPE xstring. ASSIGN mem TO <x>.",
    "DATA r TYPE REF TO xstring. GET REFERENCE OF mem INTO r.",
    "DATA r TYPE REF TO xstring. r = REF #( mem ).",
    "FIELD-SYMBOLS <x> TYPE any. DATA name TYPE string VALUE 'MEM'. ASSIGN (name) TO <x>.",
    "FIELD-SYMBOLS <x> TYPE any. ASSIGN ('MEM') TO <x>.",
    "FIELD-SYMBOLS <x> TYPE any. ASSIGN COMPONENT 1 OF STRUCTURE mem TO <x>.",
  ]) assert.equal(owns(compile(statement)), false, statement);
});

test("calls retain normal representation even for explicit VALUE inputs", () => {
  for (const [signature, actual] of [
    ["CHANGING p TYPE xstring", "CHANGING p = mem"],
    ["EXPORTING p TYPE xstring", "IMPORTING p = mem"],
    ["IMPORTING p TYPE xstring", "EXPORTING p = mem"],
  ]) {
    const p = compile(`other( ${actual} ).`, "METHOD other. ENDMETHOD.", `METHODS other ${signature}.`);
    assert.deepEqual(p.partial, []);
    assert.equal(owns(p), false, signature);
  }
  const p = compile("other( mem ).", "METHOD other. ENDMETHOD.", "METHODS other IMPORTING VALUE(p) TYPE xstring.");
  assert.deepEqual(p.partial, []);
  assert.equal(owns(p), false);
  assert.match(emitGo(p), /OTHER\(s, mem\)/);
});

test("components, rows, generic boxing and RETURNING targets retain their ABI", () => {
  const p = compile(`TYPES: BEGIN OF row, bytes TYPE xstring, END OF row.
    DATA r TYPE row. DATA rows TYPE STANDARD TABLE OF xstring WITH DEFAULT KEY.
    r-bytes = mem. APPEND mem TO rows.`);
  assert.deepEqual(p.partial, []);
  const go = emitGo(p);
  assert.match(go, /bytes string/);
  assert.match(go, /rows \[\]string/);
  // Unknown table write contexts conservatively retain the source too.
  assert.equal(owns(p), false);
  const ret = compile("other( RECEIVING p = mem ).", "METHOD other. ENDMETHOD.", "METHODS other RETURNING VALUE(p) TYPE xstring.");
  assert.equal(owns(ret), false);
});

test("an uncompiled method cannot hide an attribute escape", () => {
  const p = compile("mv_mem = '1234'.", "METHOD other. FIELD-SYMBOLS <x> TYPE xstring. ASSIGN mv_mem TO <x>. REPLACE FIRST OCCURRENCE OF mv_mem IN mv_mem WITH mv_mem IN BYTE MODE. ENDMETHOD.", "METHODS other.");
  assert.equal(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]), false);
  assert.doesNotMatch(emitGo(p), /mv_mem hXbuf.Buffer/);
});

test("local names in separate methods have separate ownership decisions", () => {
  const p = compile("mem = '1234'.", "METHOD other. DATA mem TYPE xstring. helper( CHANGING p = mem ). ENDMETHOD. METHOD helper. ENDMETHOD.", "METHODS other. METHODS helper CHANGING p TYPE xstring.");
  assert.deepEqual(p.partial, []);
  assert.equal(owns(p), true);
  const other = p.classes[0].methods.find((m) => m.name === "OTHER");
  assert.equal(analyzeOwnership(p).declarations.has(other.locals.find((v) => v.name === "MEM")), false);
});

test("a call consuming a boxed length conservatively retains string storage", () => {
  const p = compile("mem = '1234'.");
  const method = p.classes[0].methods[0];
  const mem = {e: "var", name: "MEM", type: {k: "xstring"}};
  const boxed = {e: "wrap", x: {e: "xstrlen", x: mem, type: {k: "i"}}, type: {k: "data"}};
  method.body.push({s: "call", call: {e: "call", method: "OTHER", static: true,
    args: [{dir: "importing", byValue: false, type: {k: "data"}, value: boxed}], type: {k: "void"}}});
  assert.equal(owns(p), false);
  assert.doesNotMatch(emitGo(p), /mem\.Len\(\)/);
  boxed.x = mem;
  assert.equal(owns(p), false);
});

test("constructor local ownership survives the emitter's constructor wrapper", () => {
  const p = compile("", "METHOD constructor. DATA memory TYPE xstring. memory = '1234'. CLEAR memory. ENDMETHOD.", "METHODS constructor.");
  assert.deepEqual(p.partial, []);
  const go = emitGo(p);
  assert.match(go, /memory hXbuf.Buffer/);
  assert.match(go, /memory\.Set\(/);
  assert.match(go, /memory\.Clear\(/);
});

const growDefinition = "METHODS grow RETURNING VALUE(r) TYPE xstring. METHODS comb IMPORTING VALUE(iv_a) TYPE xstring VALUE(iv_b) TYPE xstring RETURNING VALUE(r) TYPE xstring.";
const growMethods = "METHOD grow. DATA ff TYPE x LENGTH 1 VALUE 'FF'. CONCATENATE mv_mem ff INTO mv_mem IN BYTE MODE. r = 'EE'. ENDMETHOD. METHOD comb. CONCATENATE iv_a iv_b INTO r IN BYTE MODE. ENDMETHOD.";
test("whole and length reads beside calls retain string evaluation order", () => {
  for (const statement of [
    "b = comb( iv_a = mv_mem iv_b = grow( ) ).",
    "DATA n TYPE i. n = xstrlen( mv_mem ) + xstrlen( grow( ) ).",
  ]) {
    const p = compile("mv_mem = '01'. " + statement, growMethods, growDefinition);
    assert.deepEqual(p.partial, []);
    assert.deepEqual(p.broken, [], p.reg.findIssues().map(x => x.getMessage()).join("; "));
    assert.equal(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]), false, statement);
    assert.doesNotMatch(emitGo(p), /mv_mem hXbuf.Buffer/);
  }
});
test("self-append without calls remains owned", () => {
  const p = compile("mv_mem = '01'. CONCATENATE mv_mem mv_mem INTO mv_mem IN BYTE MODE.");
  assert.deepEqual(p.partial, []);
  assert.ok(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]));
  assert.match(emitGo(p), /mv_mem\.Append\(me\.mv_mem\.Snapshot\(\)\)/);
});

test("a substring read beside a call disqualifies its source", () => {
  const p = compile("b = comb( iv_a = mv_mem iv_b = grow( ) ).", growMethods, growDefinition);
  const call = p.classes[0].methods.find(m => m.name === "RUN").body.at(-1).value;
  const arg = call.args[0];
  arg.value = {e: "substr", x: arg.value, off: {e: "int", value: 0}, len: {e: "int", value: 1}, type: {k: "xstring"}};
  assert.equal(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]), false);
});

test("unrelated calls in a loop body do not disqualify call-free stores", () => {
  const p = compile("DATA replacement TYPE x LENGTH 1 VALUE 'FF'. mv_mem = '01'. DO 2 TIMES. REPLACE SECTION OFFSET 0 LENGTH 1 OF mv_mem WITH replacement IN BYTE MODE. grow( ). ENDDO.",
    "METHOD grow. r = 'EE'. ENDMETHOD.", "METHODS grow RETURNING VALUE(r) TYPE xstring.");
  assert.deepEqual(p.partial, []);
  assert.ok(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]));
});

test("condition reads beside calls retain strings", () => {
  const p = compile("mv_mem = '01'. IF mv_mem = grow( ). CLEAR b. ENDIF.", growMethods, growDefinition);
  assert.deepEqual(p.partial, []);
  assert.equal(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]), false);
});

test("replacement targets retain strings when a byte operand calls a method", () => {
  const p = compile("mem = '01'. REPLACE SECTION OFFSET 0 LENGTH 1 OF mem WITH grow( ) IN BYTE MODE.",
    "METHOD grow. r = 'FF'. ENDMETHOD.", "METHODS grow RETURNING VALUE(r) TYPE xstring.");
  assert.deepEqual(p.partial, []);
  assert.equal(owns(p), false);
});

for (const staticMemory of [false, true]) test(`generated owned ${staticMemory ? "static" : "instance"} equal-length REPLACE allocates nothing on 16 pages`, () => {
  // Compile a fixed byte operand through the same frontend as ABAP stores.
  const stores = compile("DATA replacement TYPE x LENGTH 4 VALUE '01020304'. REPLACE SECTION OFFSET 1024 LENGTH 4 OF mv_mem WITH replacement IN BYTE MODE.",
    "METHOD init. mv_mem = memory. ENDMETHOD.", "METHODS init IMPORTING VALUE(memory) TYPE xstring.", staticMemory);
  assert.deepEqual(stores.partial, []);
  assert.deepEqual(stores.broken, []);
  assert.ok(analyzeOwnership(stores).declarations.has(stores.classes[0].attributes[0]));
  const dir = mkdtempSync(join(import.meta.dirname, ".out", "owned-allocation-"));
  try {
    cpSync(join(import.meta.dirname, "go"), dir, {recursive: true});
    mkdirSync(join(dir, "ownedcheck"));
    writeFileSync(join(dir, "ownedcheck", "generated.go"), emitGo(stores).replace("package main", "package ownedcheck"));
    writeFileSync(join(dir, "ownedcheck", "generated_test.go"), `package ownedcheck
import ("testing"; "strings"; "osg/gogen/abap")
func TestGeneratedStore(t *testing.T) {
  s := &abap.Session{}
  me := &ZCL_OWNED{}
  me.INIT(s, strings.Repeat("\\x00", 16*65536))
  if ${staticMemory ? "St_ZCL_OWNED(s).mv_mem" : "me.mv_mem"}.Len() != 16*65536 { t.Fatal("buffer is not 16 pages") }
  if allocations := testing.AllocsPerRun(1000, func() { me.RUN(s) }); allocations != 0 {
    t.Fatalf("generated store allocations: %g", allocations)
  }
}
`);
    execFileSync("go", ["test", "./ownedcheck"], {cwd: dir, env: process.env});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("private statics qualify in static/instance methods and the class constructor", () => {
  const p = compile("DATA b1 TYPE x LENGTH 1 VALUE 'FF'. b = zcl_owned=>mv_mem+0(1). REPLACE SECTION OFFSET 0 LENGTH 1 OF zcl_owned=>mv_mem WITH b1 IN BYTE MODE. CONCATENATE zcl_owned=>mv_mem zcl_owned=>mv_mem INTO zcl_owned=>mv_mem IN BYTE MODE.",
    "METHOD class_constructor. zcl_owned=>mv_mem = '0102'. ENDMETHOD. METHOD store. CLEAR mv_mem. ENDMETHOD.",
    "CLASS-METHODS class_constructor. CLASS-METHODS store.", true);
  assert.deepEqual(p.partial, []);
  assert.ok(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]));
  const go = emitGo(p);
  assert.match(go, /mv_mem hXbuf.Buffer/);
  assert.match(go, /static_ZCL_OWNED\.mv_mem\.Sub/);
  assert.match(go, /static_ZCL_OWNED\.mv_mem\.StoreByte/);
  assert.match(go, /static_ZCL_OWNED\.mv_mem\.Append/);
  assert.doesNotMatch(go, /func\(\) \*string \{ Ensure_ZCL_OWNED/);
});

test("static escapes and evaluation order preserve the string ABI", () => {
  for (const body of [
    "FIELD-SYMBOLS <x> TYPE any. ASSIGN zcl_owned=>mv_mem TO <x>.",
    "DATA r TYPE REF TO xstring. GET REFERENCE OF zcl_owned=>mv_mem INTO r.",
    "other( CHANGING p = zcl_owned=>mv_mem ).",
    "DATA n TYPE i. n = xstrlen( zcl_owned=>mv_mem ) + xstrlen( grow( ) ).",
    "DATA rows TYPE STANDARD TABLE OF xstring WITH DEFAULT KEY. APPEND zcl_owned=>mv_mem TO rows.",
  ]) {
    const p = compile(body, "METHOD other. ENDMETHOD. METHOD grow. r = 'FF'. ENDMETHOD.", "METHODS other CHANGING p TYPE xstring. METHODS grow RETURNING VALUE(r) TYPE xstring.", true);
    assert.deepEqual(p.partial, []);
    assert.equal(analyzeOwnership(p).declarations.has(p.classes[0].attributes[0]), false, body);
  }
});

test("fixed locals loading owned memory use inline bytes; references keep strings", () => {
  const body = "DATA byte TYPE x LENGTH 1. DATA n TYPE i. mem = 'FF'. byte = mem+0(1). n = byte. byte = n. REPLACE SECTION OFFSET 0 LENGTH 1 OF mem WITH byte IN BYTE MODE.";
  const p = compile(body);
  assert.deepEqual(p.partial, []);
  const go = emitGo(p);
  assert.match(go, /var byte_ \[1\]byte/);
  assert.match(go, /byte_\[0\] = mem\.Byte\(/);
  assert.match(go, /int32\(byte_\[0\]\)/);
  assert.match(go, /byte_\[0\] = hXsmall.Byte\(n\)/);
  assert.match(go, /mem\.StoreByte/);
  for (const escape of ["DATA r TYPE REF TO x. GET REFERENCE OF byte INTO r.", "FIELD-SYMBOLS <b> TYPE x. ASSIGN byte TO <b>."]) {
    const escaped = emitGo(compile(body + escape));
    assert.match(escaped, /var byte_ string/);
    assert.match(escaped, /StoreByte\(hXsmall.First\(byte_\)/);
  }
});

test("generated single-byte reads, integer moves, padding and snapshots agree with JS", async () => {
  const program = compileProgram({folders: [join(import.meta.dirname, "testdata")], objects: ["ZCL_GOGEN_T_SINGLEBYTES"]});
  assert.deepEqual(program.partial, []);
  assert.deepEqual(program.broken, []);
  const dir = mkdtempSync(join(import.meta.dirname, ".out", "owned-parity-"));
  const want = "255/-2147483648/254/255/FE7FFF80";
  try {
    cpSync(join(import.meta.dirname, "go"), dir, {recursive: true});
    mkdirSync(join(dir, "ownedcheck"));
    writeFileSync(join(dir, "ownedcheck/generated.go"), emitGo(program).replace("package main", "package ownedcheck"));
    writeFileSync(join(dir, "ownedcheck/generated_test.go"), `package ownedcheck
import ("testing"; "osg/gogen/abap")
func TestBytes(t *testing.T) { if got:=ZCL_GOGEN_T_SINGLEBYTES_RUN(&abap.Session{}); got != ${JSON.stringify(want)} {t.Fatal(got)}; if got:=ZCL_GOGEN_T_SINGLEBYTES_EMPTY_SOURCE(&abap.Session{}); got!="00/0" {t.Fatal(got)}; if got:=ZCL_GOGEN_T_SINGLEBYTES_FROM_BYTE(&abap.Session{}, ""); got!="00/0" {t.Fatal(got)}; if got:=ZCL_GOGEN_T_SINGLEBYTES_REPLACE_FIT(&abap.Session{}); got!="12FF/2/12FFFF/0" {t.Fatal(got)} }
`);
    execFileSync("go", ["test", "./ownedcheck"], {cwd: dir, env: process.env});
    writeFileSync(join(dir, "generated.mjs"), emitJs(program));
    copyJsRuntime(dir);
    const js = await import(join(dir, "generated.mjs"));
    assert.equal(js.ZCL_GOGEN_T_SINGLEBYTES.RUN({sy: {index:0, subrc:0}}), want);
    assert.equal(js.ZCL_GOGEN_T_SINGLEBYTES.EMPTY_SOURCE({sy: {subrc:0}}), "00/0");
    assert.equal(js.ZCL_GOGEN_T_SINGLEBYTES.REPLACE_FIT({sy: {subrc:0}}), "12FF/2/12FFFF/0");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("owned-memory checksum addition keeps exact packed fallbacks and JS parity", async () => {
  const p = compile("mv_mem = '00'.", `METHOD checksum. r = seed. r = r + n. ENDMETHOD.`,
    "TYPES packed TYPE p LENGTH 16 DECIMALS 0. METHODS checksum IMPORTING VALUE(seed) TYPE packed VALUE(n) TYPE i RETURNING VALUE(r) TYPE packed.");
  assert.deepEqual(p.partial, []);
  assert.deepEqual(p.broken, [], p.reg.findIssues().map((i) => i.getMessage()).join("; "));
  assert.match(emitGo(p), /hPackedint.Add/);
  const dir = mkdtempSync(join(import.meta.dirname, ".out", "packed-checksum-"));
  const cases = [["0", 255, "255"], ["12", -20, "-8"], ["9223372036854775807", 1, "9223372036854775808"],
    ["-9223372036854775808", -1, "-9223372036854775809"], ["9999999999999999999999999999999", -1, "9999999999999999999999999999998"]];
  try {
    cpSync(join(import.meta.dirname, "go"), dir, {recursive: true});
    mkdirSync(join(dir, "check"));
    writeFileSync(join(dir, "check/generated.go"), emitGo(p).replace("package main", "package check"));
    writeFileSync(join(dir, "check/generated_test.go"), `package check
import("testing"; "osg/gogen/abap")
func TestChecksum(t *testing.T) {
 me:=&ZCL_OWNED{}; s:=&abap.Session{}
 ${cases.map(([seed, n, want]) => `if got:=me.CHECKSUM(s, ${JSON.stringify(seed)}, ${n}); got!=${JSON.stringify(want)} {t.Fatal(got)}`).join("\n")}
 defer func(){r:=recover(); e,ok:=r.(abap.ArithmeticError); if !ok || e.Class!="CX_SY_ARITHMETIC_OVERFLOW" {t.Fatalf("overflow: %v",r)}}()
 me.CHECKSUM(s,"9999999999999999999999999999999",1)
}
`);
    execFileSync("go", ["test", "./check"], {cwd: dir, env: process.env});
    writeFileSync(join(dir, "generated.mjs"), emitJs(p));
    copyJsRuntime(dir);
    const js = await import(join(dir, "generated.mjs"));
    const me = new js.ZCL_OWNED();
    for (const [seed, n, want] of cases) assert.equal(me.CHECKSUM({sy: {}}, seed, n), want);
    assert.throws(() => me.CHECKSUM({sy: {}}, "9999999999999999999999999999999", 1), /CX_SY_ARITHMETIC_OVERFLOW/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
  // Any parameter, reference, or generic consumer retains ordinary arithmetic.
  const escaped = compile("mv_mem = '00'.", "METHOD checksum. DATA ptr TYPE REF TO packed. GET REFERENCE OF r INTO ptr. r = r + n. ENDMETHOD.",
    "TYPES packed TYPE p LENGTH 16 DECIMALS 0. METHODS checksum IMPORTING VALUE(n) TYPE i RETURNING VALUE(r) TYPE packed.");
  assert.doesNotMatch(emitGo(escaped), /hPackedint.Add/);
});

// A4H 2026-10-02, ABAPiti oracle 009: keep each measured case visible.
test("oracle 009 byte replacement expectations on IR-as-JS", async (t) => {
  const root = join(import.meta.dirname, "../..");
  const program = compileProgram({folders: [join(import.meta.dirname, "testdata"),
    join(libraryPath(root, "open-abap-core"), "src")], objects: ["ZCL_GOGEN_T_REPL009"]});
  assert.deepEqual(program.partial, []);
  assert.deepEqual(program.broken, []);
  const js = emitJs(program, new URL("./js/abap.mjs", import.meta.url).href);
  const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const expected = ["[12FF rc=2]", "[AB00 rc=0]", "[11A1A2A3 rc=2]", "[11AB4400 rc=0]",
    "[12FFFF rc=0]", "[12AB rc=0]", "[1234 rc=2]", "[A1A2 rc=2]"];
  for (const [index, want] of expected.entries()) await t.test(`case ${index + 1}`, () => {
    assert.equal(m.ZCL_GOGEN_T_REPL009.PROBE({sy: {index: 0, subrc: 0}}, index + 1), want);
  });
});


test("unsupported attributes do not qualify for packed checksum emission", () => {
  for (const supported of [false, true]) {
    const program = compile("", "METHOD checksum. r = r + n. ENDMETHOD.",
      "TYPES packed TYPE p LENGTH 16 DECIMALS 0. METHODS checksum IMPORTING VALUE(n) TYPE i RETURNING VALUE(r) TYPE packed.");
    if (!supported) program.classes[0].attributes = [];
    // classIr preserves the name/reason when it cannot lower an attribute.
    program.classes[0].attributes.unshift({name: "UNSUPPORTED", unsupported: "unsupported attribute type"});
    const go = emitGo(program);
    assert.equal(go.includes("hPackedint.Add"), supported);
  }
});
