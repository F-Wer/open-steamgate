import {test} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {artifactLowering, compilationProvenanceOf, provenanceOf, recordProvenance} from "./frontend-provenance.mjs";
import {syntheticCorpus, classSource} from "./cache-oracle-corpus.mjs";
import {captureArtifacts, compareArtifacts} from "./cache-oracle-capture.mjs";
const require = createRequire(import.meta.url);
const cr = createRequire(require.resolve("@abaplint/transpiler/package.json"));
const core = cr("@abaplint/core");
const {CurrentScope} = cr("@abaplint/core/build/src/abap/5_syntax/_current_scope");
const {DDIC} = cr("@abaplint/core/build/src/ddic");
const xml = (body) => `<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>${body}</asx:values></asx:abap></abapGit>`;
function registry(files) {
  const config = core.Config.getDefault().get();
  config.syntax = {...config.syntax, version: "v758", errorNamespace: "^(?!ZCL_ADDED$)."};
  config.rules = {check_syntax: true, parser_error: true};
  const reg = new core.Registry(new core.Config(JSON.stringify(config)));
  for (const [name, raw] of Object.entries(files)) reg.addFile(new core.MemoryFile(name, raw));
  return reg;
}
const rows = (m) => [...m.hits, ...m.misses, ...m.scans, ...m.unknownScans];
const has = (m, kind, result) => m.hits.some((q) => q.kind === kind && q.result.includes(result));
const corpus = () => syntheticCorpus({classes: 4});
function compile(files, objects) {
  return recordProvenance(() => {
    const reg = registry(files); reg.parse();
    return compileProgram({registry: reg, folders: [], objects, tolerant: true});
  });
}

test("pre-parse manifests cover implicit pools, include macros, FM ownership and DDIC chains", () => {
  const c = corpus(), p = compile(c.files, c.objects), manifests = provenanceOf(p);
  const implicit = manifests.get("CLAS ZCL_POOL_IMPLICIT");
  assert.ok(has(implicit, "getObject", "TYPE ZORC"));
  assert.ok(implicit.hits.some((q) => q.kind === "implicit-type-pool" && q.args[0] === "ZORC_VALUE"));
  assert.ok(implicit.hits.some((q) => q.result.includes("TYPE ZORC") && q.phase === "global-definition"));
  const macro = manifests.get("CLAS ZCL_INCLUDE_MACRO");
  assert.ok(macro.hits.some((q) => q.kind === "getObject" && q.result.includes("PROG ZORACLE_MACROS") && q.phase === "parse"));
  const fm = manifests.get("CLAS ZCL_FUNCTION");
  assert.ok(compilationProvenanceOf(p).scheduling.some((q) => q.kind === "function-module-index" && q.result.includes("FUGR ZORACLE_GROUP")));
  assert.ok(!fm.scans.some((q) => q.kind === "function-module-index"));
  assert.ok(fm.hits.some((q) => q.kind === "function-module-owner" && q.args[0] === "ZORACLE_FUNCTION" && q.result.includes("FUGR ZORACLE_GROUP")));
  assert.ok(rows(manifests.get("FUGR ZORACLE_GROUP")).some((q) => q.kind === "function-group-include"));
  const ddic = manifests.get("CLAS ZCL_DDIC");
  for (const key of ["TABL ZORACLE_TAB", "DTEL ZORACLE_NUM", "DOMA ZORACLE_NUM"]) assert.ok(has(ddic, "getObject", key), key);
  // Every registry object, including non-selected/non-ABAP providers, is exposed.
  assert.equal(manifests.size, [...p.reg.getObjects()].length);
});

test("a failed named query survives, and a fresh registry records the newly added hit", () => {
  const c = corpus();
  const absent = provenanceOf(compile(c.files, c.objects)).get("CLAS ZCL_ABSENT_READER");
  assert.ok(absent.misses.some((q) => q.kind === "getObject" && q.args.join(" ") === "CLAS ZCL_ADDED" && q.result.length === 0));
  c.files["zcl_added.clas.abap"] = classSource("zcl_added");
  const added = provenanceOf(compile(c.files, c.objects)).get("CLAS ZCL_ABSENT_READER");
  assert.ok(has(added, "getObject", "CLAS ZCL_ADDED"));
});

test("sibling include macro resolution keeps its parent, filename queries and provider", () => {
  const files = {
    "zmain.prog.abap": "REPORT zmain. INCLUDE zprovider. INCLUDE zconsumer.",
    "zprovider.prog.abap": "DEFINE sibling. WRITE 'ok'. END-OF-DEFINITION.",
    "zconsumer.prog.abap": "sibling.",
    "zprovider.prog.xml": xml("<PROGDIR><SUBC>I</SUBC></PROGDIR>"),
    "zconsumer.prog.xml": xml("<PROGDIR><SUBC>I</SUBC></PROGDIR>"),
  };
  const p = compile(files, []), m = provenanceOf(p).get("PROG ZCONSUMER");
  assert.ok(has(m, "include-parent", "PROG ZMAIN"));
  assert.ok(has(m, "getFileByName", "zmain.prog.abap"));
  assert.ok(has(m, "findObjectForFile", "PROG ZMAIN"));
  assert.ok(has(m, "getObject", "PROG ZPROVIDER"));
  assert.ok(p.reg.getObject("PROG", "ZCONSUMER").getMainABAPFile().getStatements()
    .every((s) => s.get().constructor.name !== "Unknown"), "macro really resolves");
});

test("CDS SQL-view alias scans preserve candidate order, hits and misses", () => {
  const files = {
    "zbase.tabl.xml": xml("<DD02V><TABNAME>ZBASE</TABNAME><TABCLASS>TRANSP</TABCLASS></DD02V><DD03P_TABLE><DD03P><FIELDNAME>ID</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>000004</LENG></DD03P></DD03P_TABLE>"),
    "zother.ddls.asddls": "@AbapCatalog.sqlViewName: 'ZOTHER'\ndefine view ZOther as select from zbase as b { key b.id }",
    "zview.ddls.asddls": "@AbapCatalog.sqlViewName: 'ZSQLALIAS'\ndefine view ZDefinition as select from zbase as b { key b.id }",
    "zcl_alias.clas.abap": classSource("zcl_alias", "rv-id = 'test'.", "zsqlalias"),
  };
  const p = compile(files, ["ZCL_ALIAS"]), m = provenanceOf(p).get("CLAS ZCL_ALIAS");
  assert.ok(m.hits.some((q) => q.kind === "cds-alias" && q.args[0] === "ZSQLALIAS" && q.result.includes("DDLS ZVIEW")));
  assert.ok(m.scans.some((q) => q.kind === "cds-alias" && q.result.join() === "DDLS ZOTHER,DDLS ZVIEW" && !q.complete));
  assert.ok(has(m, "getObject", "TABL ZBASE"));
  recordProvenance(() => artifactLowering((ctx) => new DDIC(ctx.reg).lookupDDLS("ZABSENT_ALIAS"))({reg: p.reg}, p.reg.getObject("CLAS", "ZCL_ALIAS")));
  const after = provenanceOf(p).get("CLAS ZCL_ALIAS");
  assert.ok(after.misses.some((q) => q.kind === "cds-alias" && q.args[0] === "ZABSENT_ALIAS"));
  assert.ok(after.scans.some((q) => q.kind === "cds-alias" && q.complete && q.result.join() === "DDLS ZOTHER,DDLS ZVIEW"));
  assert.equal(p.diagnostics.length, 0, JSON.stringify(p.diagnostics));
});

test("TTYP, VIEW, structure INCLUDE and APPEND typing keep their complete DDIC chain", () => {
  const c = corpus();
  for (const [name, marker] of [["zinclude", ".INCLUDE"], ["zappend", ".INCLU--AP"]])
    c.files[`${name}.tabl.xml`] = xml(`<DD02V><TABNAME>${name.toUpperCase()}</TABNAME><TABCLASS>INTTAB</TABCLASS></DD02V><DD03P_TABLE><DD03P><FIELDNAME>${marker}</FIELDNAME><PRECFIELD>ZORACLE_TAB</PRECFIELD></DD03P></DD03P_TABLE>`);
  c.files["zrows.ttyp.xml"] = xml("<DD40V><TYPENAME>ZROWS</TYPENAME><ROWTYPE>ZINCLUDE</ROWTYPE><ROWKIND>S</ROWKIND><ACCESSMODE>T</ACCESSMODE><KEYDEF>D</KEYDEF><KEYKIND>N</KEYKIND></DD40V>");
  c.files["zview.view.xml"] = xml("<DD25V><VIEWNAME>ZVIEW</VIEWNAME><VIEWCLASS>D</VIEWCLASS></DD25V><DD27P_TABLE><DD27P><VIEWFIELD>VALUE</VIEWFIELD><TABNAME>ZAPPEND</TABNAME><FIELDNAME>VALUE</FIELDNAME></DD27P></DD27P_TABLE>");
  c.files["zcl_chain.clas.abap"] = classSource("zcl_chain", "DATA t TYPE zrows. DATA v TYPE zview. rv = v-value.");
  const p = compile(c.files, ["ZCL_CHAIN"]), m = provenanceOf(p).get("CLAS ZCL_CHAIN");
  for (const key of ["TTYP ZROWS", "VIEW ZVIEW", "TABL ZINCLUDE", "TABL ZAPPEND", "TABL ZORACLE_TAB", "DTEL ZORACLE_NUM", "DOMA ZORACLE_NUM"])
    assert.ok(has(m, "getObject", key), key);
  assert.equal(p.diagnostics.length, 0, JSON.stringify(p.diagnostics));
});

test("a second cached DDIC consumer inherits the original DOMA query without retyping it", () => {
  const c = corpus(), reg = registry(c.files);
  let domainCalls = 0;
  const domain = reg.getObject("DOMA", "ZORACLE_NUM"), parse = domain.parseType;
  domain.parseType = function(...args) { domainCalls++; return parse.apply(this, args); };
  let callsAfterFirst;
  recordProvenance(() => {
    reg.parse(); // eagerly caches TABL -> DTEL -> DOMA before either consumer
    const first = reg.getObject("CLAS", "ZCL_DDIC");
    new core.SyntaxLogic(reg, first).run();
    callsAfterFirst = domainCalls;
    const second = reg.getObject("CLAS", "ZCL_CONTROL_READER");
    artifactLowering((ctx) => new DDIC(ctx.reg).lookup("ZORACLE_TAB"))({reg}, second);
    assert.equal(domainCalls, callsAfterFirst, "second consumer uses cached table type");
  });
  assert.ok(callsAfterFirst > 0);
  const m = provenanceOf(reg).get("CLAS ZCL_CONTROL_READER");
  assert.ok(m.hits.some((q) => q.kind === "getObject" && q.result.includes("DOMA ZORACLE_NUM") && q.artifact === "DTEL ZORACLE_NUM"));
  assert.ok(!m.hits.some((q) => q.result.includes("DOMA ZORACLE_NUM") && q.artifact === "CLAS ZCL_CONTROL_READER"));
});

test("FUGR/ENHS scans, BDEF and all registry lookup methods record unresolved queries", () => {
  const c = corpus();
  c.files["zspot.enhs.xml"] = xml("<BADI_DATA><ENH_BADI_DATA><BADI_NAME>ZPRESENT_BADI</BADI_NAME><INTERFACE_NAME>ZIF_BADI</INTERFACE_NAME></ENH_BADI_DATA></BADI_DATA>");
  const reg = registry(c.files);
  recordProvenance(() => {
    reg.parse();
    const obj = reg.getObject("CLAS", "ZCL_FUNCTION");
    artifactLowering(() => {
      const scope = CurrentScope.buildDefault(reg, obj);
      assert.ok(scope.findFunctionModule("ZORACLE_FUNCTION"));
      assert.equal(scope.findFunctionModule("ZABSENT_FUNCTION"), undefined);
      assert.equal(scope.isBadiDef("ZABSENT_BADI"), false);
      assert.equal(scope.isBadiDef("ZPRESENT_BADI"), true);
      // Drive the real behavior-name resolution without requiring supported RAP lowering.
      const definition = obj.getClassDefinition;
      obj.getClassDefinition = () => ({behaviorDefinitionName: "ZABSENT_BEHAVIOR"});
      try { assert.equal(scope.findBehaviorDefinition(), undefined); } finally { obj.getClassDefinition = definition; }
      assert.equal(reg.getFileByName("absent.prog.abap"), undefined);
      assert.equal(reg.findObjectForFile(new core.MemoryFile("absent.prog.abap", "")), undefined);
      assert.ok(reg.getFirstObject());
    })({reg}, obj);
  });
  const m = provenanceOf(reg).get("CLAS ZCL_FUNCTION");
  assert.ok(m.scans.some((q) => q.kind === "function-module-owner" && q.args[0] === "FUGR" && q.result.includes("FUGR ZORACLE_GROUP")));
  assert.ok(m.scans.some((q) => q.kind === "badi-definition" && q.result.includes("ENHS ZSPOT")));
  for (const kind of ["function-module-owner", "badi-definition", "behavior-definition", "getFileByName", "findObjectForFile"])
    assert.ok(m.misses.some((q) => q.kind === kind), kind);
  assert.ok(m.misses.some((q) => q.kind === "getObject" && q.args.join(" ") === "BDEF ZABSENT_BEHAVIOR"));
  assert.ok(has(m, "getFirstObject", "CLAS ZCL_CONTROL_0000"));
});

test("unclassified scans fail closed, including partial iteration and an empty type inventory", () => {
  const reg = registry(corpus().files);
  const before = core.Registry.prototype.getObjects;
  recordProvenance(() => {
    reg.parse();
    const obj = reg.getObject("CLAS", "ZCL_DDIC");
    artifactLowering(() => {
      for (const ignored of reg.getObjects()) { void ignored; break; }
      assert.deepEqual([...reg.getObjectsByType("ENHS")], []);
    })({reg}, obj);
  });
  assert.equal(core.Registry.prototype.getObjects, before, "hook restored");
  const m = provenanceOf(reg).get("CLAS ZCL_DDIC");
  assert.ok(m.unknownScans.some((q) => q.scan === "getObjects" && !q.complete && q.result.length === 1));
  assert.ok(m.unknownScans.some((q) => q.scan === "getObjectsByType" && q.complete && q.args[0] === "ENHS" && !q.result.length));
  assert.throws(() => recordProvenance(() => { throw new Error("refusal"); }), /refusal/);
  assert.equal(core.Registry.prototype.getObjects, before, "hook restored after refusal");
});

test("untraced cached artifacts are explicitly incomplete; default-off does not produce manifests", () => {
  const reg = registry(corpus().files); reg.parse();
  const p = compileProgram({registry: reg, folders: [], objects: ["ZCL_DDIC"]});
  assert.equal(provenanceOf(p).size, 0);
  const traced = compileProgram({registry: reg, folders: [], objects: ["ZCL_DDIC"], provenance: true});
  assert.ok(provenanceOf(traced).get("TABL ZORACLE_TAB").unknownScans.some((q) => q.args[0] === "artifact-built-before-recording"));
});

test("temporary preprocessing registries cannot overwrite the program object's manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-provenance-normalize-"));
  try {
    writeFileSync(join(dir, "zcl_bool.clas.abap"), classSource("zcl_bool", "rv = boolx( bool = 1 = 1 bit = 1 ).", "xstring"));
    const p = compileProgram({folders: [dir], objects: ["ZCL_BOOL"], provenance: true});
    const m = provenanceOf(p).get("CLAS ZCL_BOOL");
    assert.ok(m.hits.some((q) => q.phase === "lowering" && q.artifact === "CLAS ZCL_BOOL"));
    assert.equal(m.unknownScans.length, 0);
    assert.deepEqual(provenanceOf(p), provenanceOf(p.reg));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a preexisting syntax session is marked incomplete even when it bypasses findIssues", () => {
  const reg = registry(corpus().files), session = {};
  reg.parse();
  compileProgram({registry: reg, folders: [], objects: ["ZCL_DDIC"], session});
  assert.ok(session.issues);
  const p = compileProgram({registry: reg, folders: [], objects: ["ZCL_DDIC"], session, provenance: true});
  const m = provenanceOf(p).get("TABL ZORACLE_TAB");
  assert.ok(m.unknownScans.some((q) => q.args[0] === "artifact-built-before-recording"));
  assert.deepEqual(provenanceOf(session), provenanceOf(p));
});

test("disk replay retains lowering provenance and does not leave registry hooks installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-provenance-replay-"));
  try {
    const c = corpus(); for (const [name, raw] of Object.entries(c.files)) writeFileSync(join(dir, name), raw);
    const args = {folders: [dir], objects: ["ZCL_POOL_IMPLICIT", "ZCL_DDIC"], cacheDir: join(dir, "cache"), provenance: true};
    const first = compileProgram(args), warm = compileProgram(args);
    assert.deepEqual(warm.frontendCounts.reusedClasses, ["ZCL_DDIC", "ZCL_POOL_IMPLICIT"]);
    const m = provenanceOf(warm).get("CLAS ZCL_DDIC");
    assert.ok(m.hits.some((q) => q.kind === "getObject" && q.phase === "lowering" && q.result.includes("TABL ZORACLE_TAB")));
    for (const p of [first, warm]) assert.equal(Object.hasOwn(p.reg, "getObject"), false);
    const before = JSON.stringify([...provenanceOf(first)]);
    compileProgram({...args, registry: first.reg, provenance: false});
    assert.equal(JSON.stringify([...provenanceOf(first)]), before, "a disabled retained-registry compile does not record");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("CI oracle corpus artifacts are byte-identical with recording explicitly on/off", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-provenance-output-"));
  try {
    const c = corpus(); for (const [name, raw] of Object.entries(c.files)) writeFileSync(join(dir, name), raw);
    const args = {folders: [dir], objects: c.objects};
    const off = captureArtifacts({...args, provenance: false}), on = captureArtifacts({...args, provenance: true});
    assert.deepEqual(compareArtifacts(off, on), {equal: true});
    assert.deepEqual(off.classArtifacts, on.classArtifacts);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
