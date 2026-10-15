import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {compileProgram} from "./frontend.mjs";
import {inlineTableLocals, cdsSqlViews} from "./frontend-analysis.mjs";
import {emitGo} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";
const require = createRequire(import.meta.url);
const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
const goRoot = new URL("./go/", import.meta.url).pathname;
function compile(body, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-tokens-"));
  try {
    writeFileSync(join(dir, "zcl_tokens.clas.abap"), `CLASS zcl_tokens DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS run RETURNING VALUE(rv) TYPE i. ENDCLASS.
CLASS zcl_tokens IMPLEMENTATION. METHOD run. ${body} ENDMETHOD. ENDCLASS.`);
    for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
    return compileProgram({folders: [dir], objects: ["ZCL_TOKENS", ...Object.keys(extra).filter(n => n.endsWith(".clas.abap")).map(n => n.split(".")[0].toUpperCase())], tolerant: true});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
function clean(p) {
  assert.deepEqual(p.broken, []);
  assert.deepEqual(p.skipped, []);
  assert.deepEqual(p.partial, []);
}
async function both(p, expected) {
  clean(p);
  const dir = mkdtempSync(join(goRoot, "cmd", "token-parsers-"));
  try {
    const js = join(dir, "generated.mjs");
    writeFileSync(js, emitJs(p, new URL("./js/abap.mjs", import.meta.url).href));
    const m = await import(pathToFileURL(js).href);
    assert.equal(m.ZCL_TOKENS.RUN({sy: {subrc: 0, tabix: 0, index: 0, dbcnt: 0}}), expected, "JS");
    writeFileSync(join(dir, "generated.go"), emitGo(p));
    writeFileSync(join(dir, "generated_test.go"), `package main\nimport ("testing"; "osg/gogen/abap")\nfunc TestTokens(t *testing.T) { if got := ZCL_TOKENS_RUN(&abap.Session{}); got != ${expected} { t.Fatalf("got %d", got) } }\n`);
    const run = spawnSync("go", ["test", `./cmd/${basename(dir)}`], {cwd: goRoot, encoding: "utf8", timeout: 120000});
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
function parsedBody(source) {
  const reg = new core.Registry();
  reg.addFile(new core.MemoryFile("ztokens.prog.abap", source));
  reg.parse();
  return reg.getFirstObject().getABAPFiles()[0].getStructure();
}

test("1 CASE literal OTHERS is a value arm", async () => {
  const p = compile("CASE 'x'. WHEN 'OTHERS'. rv = 1. ENDCASE.");
  clean(p);
  const st = p.classes[0].methods[0].body[0];
  assert.equal(st.branches.length, 1);
  assert.equal(st.else, null);
  await both(p, 0);
  await both(compile("CASE 'x'. WHEN 'OTHERS'. rv = 1. WHEN OTHERS. rv = 2. ENDCASE."), 2);
});

test("2 FIND flags cannot come from operand literals", async () => {
  const p = compile("FIND 'IGNORING CASE' IN 'ignoring case'. rv = sy-subrc.");
  clean(p);
  assert.equal(p.classes[0].methods[0].body[0].icase, false);
  await both(p, 4);
  for (const flag of ["RESPECTING", "RESULTS", "MATCH COUNT", "IN BYTE MODE", "ALL OCCURRENCES", "FIRST OCCURRENCE", "SUBMATCHES"]) {
    await both(compile(`FIND '${flag}' IN '${flag}'. rv = sy-subrc.`), 0);
  }
});

test("3 REPLACE flags cannot come from operand literals", async () => {
  const p = compile("DATA text TYPE string VALUE 'ignoring case'. REPLACE 'IGNORING CASE' IN text WITH 'x'. rv = sy-subrc.");
  clean(p);
  assert.equal(p.classes[0].methods[0].body.find(s => s.s === "replace").icase, false);
  await both(p, 4);
  for (const flag of ["RESPECTING", "RESULTS", "REPLACEMENT", "INTO", "IN BYTE MODE", "ALL OCCURRENCES", "FIRST OCCURRENCE"]) {
    await both(compile(`DATA text TYPE string VALUE '${flag}'. REPLACE '${flag}' IN text WITH 'x'. rv = sy-subrc.`), 0);
  }
});

test("4 inline SQL table discovery ignores literal text and keeps ordinary locals", async () => {
  const body = "DATA text TYPE string VALUE 'INTO TABLE @DATA(fake)'. DATA fake TYPE string. fake = 'ok'. rv = strlen( fake ).";
  assert.deepEqual([...inlineTableLocals(parsedBody(body))], []);
  await both(compile(body), 2);
  for (const into of ["INTO TABLE", "INTO CORRESPONDING FIELDS OF TABLE"]) {
    const tree = parsedBody(`SELECT * FROM ztable ${into} @DATA(real).`);
    assert.deepEqual([...inlineTableLocals(tree)], ["REAL"]);
  }
  const p = compile("SELECT id FROM zgogen_t_dbw INTO TABLE @DATA(real). rv = lines( real ).", {
    "zgogen_t_dbw.tabl.xml": readFileSync(new URL("./testdata/zgogen_t_dbw.tabl.xml", import.meta.url), "utf8"),
  });
  clean(p);
  assert.ok(p.classes[0].methods[0].body.some(s => s.s === "select_table"));
  assert.ok(emitGo(p).includes("ZCL_TOKENS_RUN"));
  assert.ok(emitJs(p).includes("ZCL_TOKENS"));
});

const cds = "@AbapCatalog.sqlViewName: 'ZGOOD'\ndefine view ZTEST as select from ztable { key id }";
test("5 CDS annotation comments cannot supply SQL view names", () => {
  assert.deepEqual(cdsSqlViews(["// @AbapCatalog.sqlViewName: 'ZBAD'\n" + cds]), {ZTEST: "ZGOOD"});
  assert.deepEqual(cdsSqlViews([cds]), {ZTEST: "ZGOOD"});
  assert.deepEqual(cdsSqlViews([cds.replace("define view", "define root view")]), {ZTEST: "ZGOOD"});
  assert.deepEqual(cdsSqlViews([cds.replace("define view", "define view entity")]), {});
  assert.deepEqual(cdsSqlViews(["/* @AbapCatalog.sqlViewName: 'ZBAD' */\n" + cds]), {ZTEST: "ZGOOD"});
  assert.deepEqual(cdsSqlViews(["define view entity ZENTITY as select from ztable { key id }"]), {});
});

test("6 READ-ONLY literal does not make a static attribute read-only", async () => {
  const owner = `CLASS zcl_owner DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-DATA txt TYPE string VALUE 'READ-ONLY'. CLASS-DATA ro TYPE string READ-ONLY.
ENDCLASS. CLASS zcl_owner IMPLEMENTATION. ENDCLASS.`;
  const p = compile("zcl_owner=>txt = 'ok'. rv = strlen( zcl_owner=>txt ).", {"zcl_owner.clas.abap": owner});
  clean(p);
  await both(p, 2);
  const refused = compile("zcl_owner=>ro = 'bad'.", {"zcl_owner.clas.abap": owner});
  assert.match(JSON.stringify([refused.partial, refused.diagnostics]), /READ.?ONLY/i);
});

test("ordinary FIND and REPLACE flags retain supported forms and refusals", async () => {
  await both(compile("FIND FIRST OCCURRENCE OF 'X' IN 'x' IGNORING CASE. rv = sy-subrc."), 0);
  await both(compile("DATA n TYPE i. FIND ALL OCCURRENCES OF 'X' IN 'xx' IGNORING CASE MATCH COUNT n. rv = n."), 2);
  await both(compile("DATA sub TYPE string. FIND REGEX '(x)' IN 'x' SUBMATCHES sub. rv = strlen( sub )."), 1);
  await both(compile("DATA x TYPE xstring VALUE '0102'. DATA p TYPE xstring VALUE '02'. DATA off TYPE i. FIND FIRST OCCURRENCE OF p IN x IN BYTE MODE MATCH OFFSET off. rv = off."), 1);
  const result = "TYPES: BEGIN OF sub, offset TYPE i, length TYPE i, END OF sub. TYPES subs TYPE STANDARD TABLE OF sub WITH DEFAULT KEY. TYPES: BEGIN OF result, line TYPE i, offset TYPE i, length TYPE i, submatches TYPE subs, END OF result. DATA res TYPE result.";
  await both(compile(`${result} FIND FIRST OCCURRENCE OF 'IGNORING CASE' IN 'ignoring case' RESULTS res. rv = sy-subrc.`), 4);
  await both(compile("DATA n TYPE i. FIND ALL OCCURRENCES OF 'IGNORING CASE' IN 'ignoring case' MATCH COUNT n. rv = n."), 0);
  for (const flag of ["IGNORING CASE", "RESPECTING CASE"]) {
    const p = compile(`${result} FIND FIRST OCCURRENCE OF 'X' IN 'x' ${flag} RESULTS res. rv = sy-subrc.`);
    await both(p, flag === "IGNORING CASE" ? 0 : 4);
  }
  for (const occurrence of ["FIRST OCCURRENCE", "ALL OCCURRENCES"]) {
    await both(compile(`DATA text TYPE string VALUE 'xx'. REPLACE ${occurrence} OF 'X' IN text WITH '' IGNORING CASE. rv = strlen( text ).`), occurrence.startsWith("ALL") ? 0 : 1);
  }
  await both(compile("DATA x TYPE xstring VALUE '0102'. DATA p TYPE xstring VALUE '03'. REPLACE SECTION OFFSET 1 LENGTH 1 OF x WITH p IN BYTE MODE. rv = xstrlen( x )."), 2);
  for (const statement of ["FIND 'x' IN 'x' RESPECTING CASE.", "REPLACE 'x' IN text WITH 'y' RESPECTING CASE.", "REPLACE 'x' IN text WITH 'y' REPLACEMENT COUNT n."]) {
    const p = compile(`DATA text TYPE string. DATA n TYPE i. ${statement}`);
    assert.equal(p.partial.length, 1, statement);
  }
});
