import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, symlinkSync, mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
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

test("round 2 READ-ONLY structured declarations and literal values", async (t) => {
  const owner = (decl) => `CLASS zcl_owner DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. ${decl} ENDCLASS. CLASS zcl_owner IMPLEMENTATION. ENDCLASS.`;
  for (const value of ["READ-ONLY", " READ-ONLY", "text READ-ONLY"]) {
    await t.test(`literal ${JSON.stringify(value)}`, async () => both(compile("zcl_owner=>txt = 'ok'. rv = strlen( zcl_owner=>txt ).", {
      "zcl_owner.clas.abap": owner(`CLASS-DATA txt TYPE string VALUE '${value}'.`),
    }), 2));
  }
  for (const [decl, body] of [
    ["CLASS-DATA ro TYPE i READ-ONLY.", "zcl_owner=>ro = 7."],
    ["CLASS-DATA: BEGIN OF ro READ-ONLY, f TYPE i, END OF ro.", "zcl_owner=>ro-f = 7."],
    ["CLASS-DATA: BEGIN OF ro READ-ONLY, f TYPE i, END OF ro.", "DATA s LIKE zcl_owner=>ro. zcl_owner=>ro = s."],
  ]) {
    await t.test(body, () => {
      const p = compile(body, {"zcl_owner.clas.abap": owner(decl)});
      assert.equal(p.partial.length, 1, body);
      assert.match(JSON.stringify(p.partial), /READ-ONLY/, body);
    });
  }
});

test("round 2 WITH discovers inline table; FINAL and NEW DATA stay discovered", () => {
  for (const sql of [
    "WITH +c AS ( SELECT id FROM zgogen_t_dbw ) SELECT id FROM +c INTO TABLE @DATA(real).",
    "SELECT id FROM zgogen_t_dbw INTO TABLE @FINAL(real).",
    "SELECT id FROM zgogen_t_dbw INTO TABLE NEW @DATA(real).",
  ]) assert.deepEqual([...inlineTableLocals(parsedBody(sql))], ["REAL"], sql);
  const p = compile("WITH +c AS ( SELECT id FROM zgogen_t_dbw ) SELECT id FROM +c INTO TABLE @DATA(real). rv = lines( real ).", {
    "zgogen_t_dbw.tabl.xml": readFileSync(new URL("./testdata/zgogen_t_dbw.tabl.xml", import.meta.url), "utf8"),
  });
  assert.deepEqual(p.skipped, []);
  assert.ok(p.partial.some(message => message.includes("WITH"))); // WITH remains outside the lowering subset.
  assert.ok(p.classes[0].methods.some(method => method.name === "RUN"));
});

test("round 2 FIND count and offset inline targets keep integer types", async (t) => {
  const result = "TYPES: BEGIN OF sub, offset TYPE i, length TYPE i, END OF sub. TYPES subs TYPE STANDARD TABLE OF sub WITH DEFAULT KEY. TYPES: BEGIN OF result, line TYPE i, offset TYPE i, length TYPE i, submatches TYPE subs, END OF result. DATA t TYPE STANDARD TABLE OF result WITH DEFAULT KEY.";
  for (const clause of ["MATCH COUNT DATA(n)", "MATCH OFFSET DATA(o)"]) {
    const name = clause.includes("COUNT") ? "n" : "o";
    await t.test(clause, () => {
      const p = compile(`${result} FIND ALL OCCURRENCES OF 'x' IN 'axx' ${clause} RESULTS t. rv = ${name}.`);
      // Combined FIND options are currently refused, but their locals must be typed correctly.
      assert.deepEqual(p.skipped, []);
      const method = p.classes[0].methods[0];
      assert.equal(method.locals.find(x => x.name === name.toUpperCase()).type.k, "i");
    });
  }
});

test("round 2 analysis loads the transpiler core instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-core-instance-"));
  try {
    // A distinct root core must never be loaded, even without npm overrides.
    const top = join(dir, "node_modules/@abaplint/core");
    const nested = join(dir, "node_modules/@abaplint/transpiler/node_modules/@abaplint");
    mkdirSync(top, {recursive: true});
    mkdirSync(nested, {recursive: true});
    writeFileSync(join(top, "package.json"), JSON.stringify({main: "index.js"}));
    writeFileSync(join(top, "index.js"), 'throw new Error("loaded root core instead of transpiler core");');
    writeFileSync(join(nested, "../../package.json"), '{}');
    symlinkSync(dirname(createRequire(require.resolve("@abaplint/transpiler/package.json")).resolve("@abaplint/core/package.json")), join(nested, "core"), "dir");
    let source = readFileSync(new URL("./frontend-analysis.mjs", import.meta.url), "utf8");
    // Relocate only this module; keep its unrelated local dependencies in place.
    source = source.replace('"./host-io.ts"', JSON.stringify(new URL("./host-io.ts", import.meta.url).href))
      .replace('"../osd-samc.ts"', JSON.stringify(new URL("../osd-samc.ts", import.meta.url).href));
    const file = join(dir, "analysis.mjs");
    writeFileSync(file, source);
    const analysis = await import(pathToFileURL(file).href);
    assert.deepEqual([...analysis.inlineTableLocals(parsedBody("SELECT id FROM ztab INTO TABLE @DATA(real)."))], ["REAL"]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("round 2 CDS BOM mapping", () => {
  assert.deepEqual(cdsSqlViews(["\uFEFF" + cds]), {ZTEST: "ZGOOD"});
});

test("round 3 keyed table READ-ONLY refuses assignment and CLEAR", async (t) => {
  for (const type of ["STANDARD TABLE OF i WITH DEFAULT KEY", "SORTED TABLE OF i WITH UNIQUE KEY table_line"]) {
    for (const body of [`DATA l TYPE ${type}. zcl_owner=>t = l.`, "CLEAR zcl_owner=>t."]) {
      await t.test(`${type}: ${body}`, () => {
        const owner = `CLASS zcl_owner DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-DATA t TYPE ${type} READ-ONLY.
ENDCLASS. CLASS zcl_owner IMPLEMENTATION. ENDCLASS.`;
        const p = compile(body, {"zcl_owner.clas.abap": owner});
        assert.deepEqual(p.skipped, []);
        assert.equal(p.partial.length, 1);
        assert.match(p.partial[0], /write to a READ-ONLY attribute/);
        clean(compile(body, {"zcl_owner.clas.abap": owner.replace(" READ-ONLY", "")}));
      });
    }
  }
});

test("round 3 LOB handle READ-ONLY is direct in DataDefinition", () => {
  const tree = parsedBody("CLASS zcl_owner DEFINITION. PUBLIC SECTION. CLASS-DATA t TYPE string READ-ONLY LOB HANDLE FOR ALL COLUMNS. ENDCLASS.");
  const def = tree.findFirstExpression(core.Expressions.DataDefinition);
  const tokens = def.getChildren().filter(c => c instanceof core.Nodes.TokenNode).map(c => c.getFirstToken().getStr());
  assert.deepEqual(tokens.slice(1, 4), ["READ", "-", "ONLY"]);
  const p = compile("CLEAR zcl_owner=>t.", {"zcl_owner.clas.abap": `CLASS zcl_owner DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-DATA t TYPE string READ-ONLY LOB HANDLE FOR ALL COLUMNS.
ENDCLASS. CLASS zcl_owner IMPLEMENTATION. ENDCLASS.`});
  assert.deepEqual(p.skipped, []);
  assert.match(JSON.stringify(p.partial), /write to a READ-ONLY attribute/);
});

const viewFixture = () => Object.fromEntries(["zgogen_t_dbw.tabl.xml", "zgogen_t_dbwc.view.xml", "zgogen_t_dbwv.view.xml"]
  .map(name => [name, readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8")]));
const viewCds = "@AbapCatalog.sqlViewName: 'ZGOGEN_T_DBWV'\ndefine view ZGOGEN_T_DBWC as select from zgogen_t_dbw { key id, val as amount }";
test("round 3 uppercase DDLS filename compiles and maps", () => {
  const p = compile("SELECT id FROM zgogen_t_dbwv INTO TABLE @DATA(rows). rv = lines( rows ).", {
    ...viewFixture(), "ZV.DDLS.ASDDLS": viewCds,
  });
  clean(p);
  assert.deepEqual(p.cdsViews, {ZGOGEN_T_DBWC: "ZGOGEN_T_DBWV"});
  assert.equal(p.tables.find(t => t.name === "ZGOGEN_T_DBWC").sqlView, "ZGOGEN_T_DBWV");
});

test("round 3 unreadable unused DDLS does not abort compileProgram", () => {
  const p = compile("rv = 1.", {...viewFixture(), "zbroken.ddls.asddls": viewCds + " invalid syntax!!"});
  clean(p);
  assert.deepEqual(p.cdsViews, {});
  const reused = compileProgram({registry: p.reg, folders: [], objects: ["ZCL_TOKENS"], tolerant: true});
  clean(reused);
});

test("round 3 unreadable used DDLS reports its original filename", async (t) => {
  for (const name of ["zgogen_t_dbwc", "zgogen_t_dbwv"]) await t.test(name, () => {
    const p = compile(`SELECT id FROM ${name} INTO TABLE @DATA(rows).`, {
      ...viewFixture(), "ZBROKEN.DDLS.ASDDLS": "// define view ZFAKE\n@View: 'VIEW'\n" + viewCds + " invalid syntax!!",
    });
    assert.deepEqual(p.skipped, []);
    assert.match(JSON.stringify(p.partial), /ZBROKEN\.DDLS\.ASDDLS.*view mapping could not be read/);
    const reused = compileProgram({registry: p.reg, folders: [], objects: ["ZCL_TOKENS"], tolerant: true});
    assert.match(JSON.stringify(reused.partial), /ZBROKEN\.DDLS\.ASDDLS.*view mapping could not be read/);
    const strict = compileProgram({registry: p.reg, folders: [], objects: ["ZCL_TOKENS"]});
    assert.match(JSON.stringify(strict.partial), /ZBROKEN\.DDLS\.ASDDLS.*view mapping could not be read/);
  });
});
