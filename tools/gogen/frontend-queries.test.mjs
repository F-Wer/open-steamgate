import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runInThisContext} from "node:vm";
import {test} from "node:test";
import assert from "node:assert/strict";
import {core} from "./frontend-inventory.mjs";
import {compileProgram, lockObjectRegistry} from "./frontend.mjs";
import {provenanceOf, compilationProvenanceOf, recordProvenance, withArtifact, auditedBookkeeping} from "./frontend-provenance.mjs";
import {syntheticCorpus, classSource} from "./cache-oracle-corpus.mjs";
import {artifactDigestsOf} from "./frontend-artifact-digests.mjs";
const xml = (s) => `<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>${s}</asx:values></asx:abap></abapGit>`;
function registry(files) {
  const cfg = core.Config.getDefault().get();
  cfg.syntax = {...cfg.syntax, version: "v758", errorNamespace: "."};
  cfg.rules = {check_syntax: true, parser_error: true};
  const reg = new core.Registry(new core.Config(JSON.stringify(cfg)));
  for (const [name, raw] of Object.entries(files)) reg.addFile(new core.MemoryFile(name, raw));
  return reg;
}
const rows = (p, key) => { const m = provenanceOf(p).get(key); return [...m.hits, ...m.misses, ...m.scans, ...m.unknownScans]; };
const build = (files, objects, extra = {}) => recordProvenance(() => compileProgram({registry: registry(files), folders: [], objects, tolerant: true, ...extra}));

test("supplied queries include empty answers, selected overrides and expanded macros", () => {
  const files = {
    "zbase.clas.abap": "CLASS zbase DEFINITION PUBLIC. PUBLIC SECTION. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDCLASS. CLASS zbase IMPLEMENTATION. METHOD work. r = iv. ENDMETHOD. ENDCLASS.",
    "zchild.clas.abap": "CLASS zchild DEFINITION PUBLIC INHERITING FROM zbase. PUBLIC SECTION. METHODS work REDEFINITION. ENDCLASS. CLASS zchild IMPLEMENTATION. METHOD work. asks. ENDMETHOD. ENDCLASS.",
    "zchild.clas.macros.abap": "DEFINE asks. IF iv IS SUPPLIED. r = iv. ENDIF. END-OF-DEFINITION.",
    "zreader.clas.abap": classSource("zreader", "DATA obj TYPE REF TO zbase. CREATE OBJECT obj TYPE zchild. rv = obj->work( )."),
  };
  const p = build(files, ["ZBASE", "ZCHILD", "ZREADER"]);
  assert.equal(p.diagnostics.length, 0, JSON.stringify(p.diagnostics));
  const q = rows(p, "CLAS ZREADER").find((q) => q.kind === "supplied" && q.args.join() === "ZBASE,WORK");
  assert.deepEqual(q.parameters, ["IV"]);
  assert.ok(q.providers.includes("CLAS ZCHILD"));
  files["zchild.clas.macros.abap"] = "DEFINE asks. r = iv. END-OF-DEFINITION.";
  const empty = build(files, ["ZBASE", "ZCHILD", "ZREADER"]);
  const miss = provenanceOf(empty).get("CLAS ZREADER").misses.find((q) => q.kind === "supplied" && q.args.join() === "ZBASE,WORK");
  assert.deepEqual(miss.parameters, []); assert.ok(miss.providers.includes("CLAS ZCHILD"));
  assert.equal(p.supplied.get("ZBASE=>WORK").has("IV"), true);
  assert.equal(empty.supplied.has("ZBASE=>WORK"), false);
  const unselected = build(files, ["ZBASE", "ZREADER"]);
  assert.ok(!rows(unselected, "CLAS ZREADER").some((q) => q.kind === "supplied" && q.providers.includes("CLAS ZCHILD")));
});

test("supplied interface implementations attribute the declaring interface", () => {
  const p = build({
    "zif_supply.intf.abap": "INTERFACE zif_supply PUBLIC. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDINTERFACE.",
    "zimpl.clas.abap": "CLASS zimpl DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_supply. ENDCLASS. CLASS zimpl IMPLEMENTATION. METHOD zif_supply~work. IF iv IS SUPPLIED. r = iv. ENDIF. ENDMETHOD. ENDCLASS.",
  }, ["ZIMPL"]);
  const q = rows(p, "CLAS ZIMPL").find((q) => q.kind === "supplied" && q.args.join() === "ZIF_SUPPLY,WORK");
  assert.deepEqual(q.parameters, ["IV"]); assert.deepEqual(q.providers, ["CLAS ZIMPL"]);
});

test("local queries are owner-scoped, ordered, and include the test selection", () => {
  const files = {"zlocal.clas.abap": classSource("zlocal"),
    "zlocal.clas.testclasses.abap": "CLASS ltcl_test DEFINITION FOR TESTING. PRIVATE SECTION. METHODS test FOR TESTING. ENDCLASS. CLASS ltcl_test IMPLEMENTATION. METHOD test. ENDMETHOD. ENDCLASS."};
  const yes = build(files, ["ZLOCAL"], {includeTests: true});
  const query = rows(yes, "CLAS ZLOCAL").find((q) => q.kind === "locals");
  assert.deepEqual(query.args, ["ZLOCAL", true]);
  assert.ok(query.result.some((n) => n.includes("LTCL_TEST"))); assert.deepEqual(query.providers, ["CLAS ZLOCAL"]);
  const no = build({"zlocal.clas.abap": files["zlocal.clas.abap"]}, ["ZLOCAL"], {includeTests: true});
  assert.deepEqual(rows(no, "CLAS ZLOCAL").find((q) => q.kind === "locals").result, []);
  assert.ok(compilationProvenanceOf(yes).scheduling.some((q) => q.kind === "local-dispatch"));
});

test("selection inventories are scheduling; named FM ownership retains last-wins order", () => {
  const c = syntheticCorpus({classes: 4});
  const groupXml = c.files["zoracle_group.fugr.xml"];
  const functionRaw = c.files["zoracle_group.fugr.zoracle_function.abap"];
  c.files["zsecond.fugr.xml"] = groupXml.replaceAll("ZORACLE_GROUP", "ZSECOND");
  c.files["zsecond.fugr.zoracle_function.abap"] = functionRaw;
  const p = build(c.files, ["ZCL_FUNCTION", "ZCL_CONTROL_0001"]);
  const ownership = rows(p, "CLAS ZCL_FUNCTION").find((q) => q.kind === "function-module-owner" && q.args[0] === "ZORACLE_FUNCTION" && q.phase === "selection");
  assert.deepEqual(ownership.result, ["FUGR ZSECOND"]);
  assert.equal(ownership.policy, "gogen-last-wins");
  const scheduling = compilationProvenanceOf(p).scheduling;
  for (const kind of ["selected-groups", "selected-classes", "global-definitions"]) assert.ok(scheduling.some((q) => q.kind === kind), kind);
  assert.ok(!rows(p, "CLAS ZCL_CONTROL_0001").some((q) => ["selected-groups", "selected-classes", "function-module-index"].includes(q.kind)));
  delete c.files["zsecond.fugr.xml"]; delete c.files["zsecond.fugr.zoracle_function.abap"];
  const earlier = build(c.files, ["ZCL_FUNCTION"]);
  assert.ok(rows(earlier, "CLAS ZCL_FUNCTION").some((q) => q.kind === "function-module-owner" && q.phase === "selection" && q.result.includes("FUGR ZORACLE_GROUP")));
});

test("locks have named misses and ENQU to TABL to DDIC edges; final inventories stay separate", () => {
  const c = syntheticCorpus({classes: 4});
  c.files["ezlock.enqu.xml"] = xml("<DD25V><VIEWNAME>EZLOCK</VIEWNAME><ROOTTAB>ZORACLE_TAB</ROOTTAB></DD25V>");
  c.files["zlocker.clas.abap"] = classSource("zlocker", "CALL FUNCTION 'ENQUEUE_EZLOCK'. rv = 1.");
  const p = build(c.files, ["ZLOCKER", "ZCL_CONTROL_0001"]);
  const q = rows(p, "CLAS ZLOCKER").find((q) => q.kind === "lock" && q.args[0] === "EZLOCK");
  assert.deepEqual(q.result, ["ENQU EZLOCK"]);
  assert.ok(q.descriptor.fields.length > 0);
  for (const key of ["TABL ZORACLE_TAB", "DTEL ZORACLE_NUM", "DOMA ZORACLE_NUM"]) assert.ok(rows(p, "CLAS ZLOCKER").some((q) => q.result.includes(key)), key);
  assert.ok(!rows(p, "CLAS ZCL_CONTROL_0001").some((q) => q.kind === "lock"));
  assert.ok(compilationProvenanceOf(p).finalOutput.some((q) => q.kind === "lock-inventory"));
  delete c.files["ezlock.enqu.xml"];
  const absent = build(c.files, ["ZLOCKER"]);
  const miss = provenanceOf(absent).get("CLAS ZLOCKER").misses.find((q) => q.kind === "lock" && q.args[0] === "EZLOCK");
  assert.equal(miss.descriptor, "MISSING");
  c.files["ezlock.enqu.xml"] = xml("<DD25V><ROOTTAB>ZABSENT_TABLE</ROOTTAB></DD25V>");
  const unreadable = build(c.files, ["ZLOCKER"]);
  assert.ok(rows(unreadable, "CLAS ZLOCKER").some((q) => q.kind === "getObject" && q.args.join() === "TABL,ZABSENT_TABLE" && q.result.length === 0));
});

test("RTTI preserves explicit superclass names and rebuilds them independently of compiled classes", () => {
  const files = {
    "zparent.clas.abap": classSource("zparent", "rv = 1."),
    "zchild.clas.abap": classSource("zchild", "rv = 2.").replace("DEFINITION PUBLIC", "DEFINITION PUBLIC INHERITING FROM zparent"),
  };
  const first = build(files, ["ZPARENT"]);
  assert.equal(first.rtti.classSupers.get("ZCHILD"), "ZPARENT");
  assert.equal(first.rtti.classSupers.get("ZPARENT"), null);
  assert.ok(!first.rtti.classSupers.has("OBJECT"));
  files["zchild.clas.abap"] = files["zchild.clas.abap"].replace(" INHERITING FROM zparent", "");
  assert.equal(build(files, ["ZPARENT"]).rtti.classSupers.get("ZCHILD"), null);
});

test("RTTI and table projections are final-output and rebuild when inventories change", () => {
  const c = syntheticCorpus({classes: 4});
  const first = build(c.files, ["ZCL_CONTROL_0001"]);
  const manifests = rows(first, "CLAS ZCL_CONTROL_0001");
  assert.ok(!manifests.some((q) => ["rtti-inventory", "table-inventory"].includes(q.kind)));
  for (const kind of ["rtti-inventory", "table-inventory"]) assert.ok(compilationProvenanceOf(first).finalOutput.some((q) => q.kind === kind));
  const projection = compilationProvenanceOf(first).finalOutput.find((q) => q.kind === "rtti-owner" && q.args[0] === "ZORACLE_TAB");
  assert.ok(projection.structs.length > 0);
  const empty = build(c.files, []);
  for (const kind of ["selected-groups", "selected-classes"]) assert.deepEqual(compilationProvenanceOf(empty).scheduling.find((q) => q.kind === kind).result, []);
  const before = first.tables.find((t) => t.name === "ZORACLE_TAB");
  delete c.files["zoracle_tab.tabl.xml"];
  const second = build(c.files, ["ZCL_CONTROL_0001"]);
  assert.ok(before); assert.ok(!second.tables.some((t) => t.name === "ZORACLE_TAB"));
  assert.ok(first.rtti.known.has("ZORACLE_TAB")); assert.ok(!second.rtti.known.has("ZORACLE_TAB"));
});

test("ownershipSafety observes expanded statements, including edits introduced by a macro", () => {
  const files = {"zowned.clas.abap": classSource("zowned", "escape. rv = 1."), "zowned.clas.macros.abap": "DEFINE escape. CLEAR rv. END-OF-DEFINITION."};
  const first = build(files, ["ZOWNED"]);
  assert.equal(first.ownershipSafety.get("ZOWNED").dynamic, false);
  files["zowned.clas.macros.abap"] = "DEFINE escape. FIELD-SYMBOLS <fs> TYPE any. ASSIGN ('RV') TO <fs>. END-OF-DEFINITION.";
  const second = build(files, ["ZOWNED"]);
  assert.equal(second.ownershipSafety.get("ZOWNED").dynamic, true);
  const q = rows(second, "CLAS ZOWNED").find((q) => q.kind === "ownershipSafety");
  assert.equal(q.dynamic, true); assert.deepEqual(q.providers, ["CLAS ZOWNED"]);
});

test("bookkeeping exemption is purpose-scoped; a later unknown loop still fails closed", () => {
  const reg = registry({"z.clas.abap": classSource("z")});
  recordProvenance(() => {
    reg.parse();
    // AUDITED test inventory: exercise only this explicit exclusion boundary.
    auditedBookkeeping("test-input-inventory", () => [...reg.getObjects()]);
    assert.equal(provenanceOf(reg).get("CLAS Z").unknownScans.length, 0);
    [...reg.getObjects()];
  });
  assert.equal(provenanceOf(reg).get("CLAS Z").unknownScans.length, 1);
});

test("provider artifact provenance never inherits another entry's lowering transcript", () => {
  const reg = registry({"za.clas.abap": classSource("za"), "zb.clas.abap": classSource("zb")});
  recordProvenance(() => {
    reg.parse(); const a = reg.getObject("CLAS", "ZA"), b = reg.getObject("CLAS", "ZB");
    withArtifact({reg}, a, () => reg.getObject("DOMA", "ZLOWERING_ONLY"));
    withArtifact({reg}, b, () => a.getDefinition());
  });
  assert.ok(rows(reg, "CLAS ZA").some((q) => q.args.includes("ZLOWERING_ONLY")));
  assert.ok(!rows(reg, "CLAS ZB").some((q) => q.args.includes("ZLOWERING_ONLY")));
});

function typeFiles(type = "i") {
  return {"zif_provider.intf.abap": `INTERFACE zif_provider PUBLIC. TYPES value TYPE ${type}. ENDINTERFACE.`,
    "zif_consumer.intf.abap": "INTERFACE zif_consumer PUBLIC. TYPES value TYPE zif_provider=>value. ENDINTERFACE.",
    "zreader.clas.abap": classSource("zreader", "DATA value TYPE zif_consumer=>value. rv = value.")};
}
const resolvedType = (p) => p.reg.getObject("INTF", "ZIF_CONSUMER").getDefinition().getTypeDefinitions().getByName("value").getType().constructor.name;
for (const disk of [false, true]) test(`retained provider i to int8 rebuilds the consumer and clears analyses (session=${disk})`, () => {
  const reg = registry(typeFiles()), session = disk ? {} : undefined;
  const options = {registry: reg, session, folders: [], objects: ["ZREADER"], tolerant: true, provenance: true};
  const first = compileProgram(options);
  assert.equal(resolvedType(first), "IntegerType");
  const unchanged = compileProgram(options);
  assert.equal(unchanged.reg, first.reg);
  if (session) { assert.ok(unchanged.frontendCounts.reused > 0); session.sentinel = true; }
  reg.updateFile(new core.MemoryFile("zif_provider.intf.abap", typeFiles("int8")["zif_provider.intf.abap"]));
  reg.parse(); // Even a caller's reparse must not certify stale consumer syntax.
  const changed = compileProgram(options);
  assert.notEqual(changed.reg, reg);
  assert.equal(resolvedType(changed), "Integer8Type");
  if (session) assert.equal(session.sentinel, undefined);
  assert.equal(compileProgram(options).reg, changed.reg, "unchanged subsequent closure reuses fresh registry");
  assert.equal(provenanceOf(changed).get("INTF ZIF_CONSUMER").unknownScans.length, 0);
});

test("fresh rebuilds preserve dependency roles, effective config, ordered files and inventory edits", () => {
  const reg = registry(typeFiles());
  reg.addDependency(new core.MemoryFile("zdep.intf.abap", "INTERFACE zdep PUBLIC. ENDINTERFACE."));
  const args = {registry: reg, folders: [], objects: [], provenance: true};
  compileProgram(args);
  reg.addFile(new core.MemoryFile("zextra.prog.abap", "REPORT zextra."));
  let p = compileProgram(args);
  assert.equal(p.reg.isDependency(p.reg.getObject("INTF", "ZDEP")), true);
  assert.deepEqual(p.reg.getConfig().get(), reg.getConfig().get());
  assert.deepEqual([...p.reg.getObjects()].map((o) => o.getName()), [...reg.getObjects()].map((o) => o.getName()));
  reg.removeFile(reg.getFileByName("zextra.prog.abap"));
  p = compileProgram(args); assert.equal(p.reg.getObject("PROG", "ZEXTRA"), undefined);
  const old = p.reg;
  const config = reg.getConfig().get(); config.syntax.version = "v750";
  reg.setConfig(new core.Config(JSON.stringify(config)));
  p = compileProgram(args); assert.notEqual(p.reg, old); assert.equal(p.reg.getConfig().get().syntax.version, "v750");
});

test("within-owner file-order edits invalidate retained registries", () => {
  const c = syntheticCorpus({classes: 4}), reg = registry(c.files);
  const args = {registry: reg, folders: [], objects: ["ZCL_ORDER_MACRO"], tolerant: true};
  const first = compileProgram(args);
  const owner = reg.getObject("CLAS", "ZCL_ORDER_MACRO");
  const before = artifactDigestsOf(first).get("CLAS ZCL_ORDER_MACRO");
  owner.getFiles().reverse();
  const changed = compileProgram(args);
  assert.notEqual(changed.reg, first.reg);
  assert.deepEqual(changed.reg.getObject("CLAS", "ZCL_ORDER_MACRO").getFiles().map((f) => f.getFilename()), owner.getFiles().map((f) => f.getFilename()));
  assert.notEqual(artifactDigestsOf(changed).get("CLAS ZCL_ORDER_MACRO"), before);
});


test("supplied query recording survives replay proxies and warm disk inheritance", () => {
  const dir = mkdtempSync(join(tmpdir(), "query-supplied-disk-"));
  try {
    const files = {
      "zcallee.clas.abap": "CLASS zcallee DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS read IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDCLASS. CLASS zcallee IMPLEMENTATION. METHOD read. IF iv IS SUPPLIED. r = iv. ENDIF. ENDMETHOD. ENDCLASS.",
      "zreader.clas.abap": classSource("zreader", "rv = zcallee=>read( )."),
      "zreader2.clas.abap": classSource("zreader2", "rv = zcallee=>read( )."),
    };
    const options = {cacheDir: dir};
    const cold = build(files, ["ZCALLEE", "ZREADER", "ZREADER2"], options);
    const warm = build(files, ["ZCALLEE", "ZREADER", "ZREADER2"], options);
    assert.ok(warm.frontendCounts.reusedClasses.includes("ZREADER"));
    for (const p of [cold, warm]) for (const owner of ["CLAS ZREADER", "CLAS ZREADER2"]) {
      const query = rows(p, owner).find((q) => q.kind === "supplied" && q.phase === "lowering" && q.args.join() === "ZCALLEE,READ");
      assert.deepEqual(query.parameters, ["IV"]);
      assert.deepEqual(query.providers, ["CLAS ZCALLEE"]);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("an unaudited iteration in a core-named file remains an unknown scan", () => {
  const reg = registry({"zunknown.clas.abap": classSource("zunknown")});
  recordProvenance(() => {
    reg.parse();
    const loop = runInThisContext("(reg) => [...reg.getObjects()]", {filename: "/tmp/adapter-negative/registry.js"});
    loop(reg);
  });
  assert.ok(provenanceOf(reg).get("CLAS ZUNKNOWN").unknownScans.some((q) => q.site?.[0].includes("registry.js")));
});


test("rebuilding a retained folder registry preserves its CDS final metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "query-registry-cds-"));
  try {
    writeFileSync(join(dir, "zreader.clas.abap"), classSource("zreader"));
    writeFileSync(join(dir, "zcds.ddls.asddls"), "@AbapCatalog.sqlViewName: 'ZSQLVIEW'\ndefine view ZCDS as select from s { key f }");
    const first = compileProgram({folders: [dir], objects: ["ZREADER"]});
    assert.deepEqual(first.cdsViews, {ZCDS: "ZSQLVIEW"});
    first.reg.updateFile(new core.MemoryFile("zreader.clas.abap", classSource("zreader", "rv = 9.")));
    const edited = compileProgram({registry: first.reg, folders: [dir], objects: ["ZREADER"]});
    assert.notEqual(first.reg, edited.reg);
    assert.deepEqual(edited.cdsViews, first.cdsViews);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test("retained closure rounds replace entry traces while preserving provider artifacts", () => {
  const reg = registry({"za.clas.abap": classSource("za"), "zb.clas.abap": classSource("zb")});
  const first = compileProgram({registry: reg, folders: [], objects: ["ZA"], provenance: true});
  assert.ok(rows(first, "CLAS ZA").some((q) => q.phase === "lowering"));
  recordProvenance(() => withArtifact({reg}, reg.getObject("CLAS", "ZA"), () => reg.getObject("DOMA", "ZPROVIDER_BUILD"), "global-definition"));
  const second = compileProgram({registry: reg, folders: [], objects: ["ZB"], provenance: true});
  assert.ok(!rows(second, "CLAS ZA").some((q) => q.phase === "lowering"));
  assert.ok(rows(second, "CLAS ZA").some((q) => q.phase === "global-definition" && q.args.includes("ZPROVIDER_BUILD")));
  assert.deepEqual(compilationProvenanceOf(second).scheduling.find((q) => q.kind === "selected-classes").result, ["CLAS ZB"]);
});


test("memory replay inherits the entry's lowering queries after clearing previous traces", () => {
  const c = syntheticCorpus({classes: 4}), reg = registry(c.files), session = {};
  const options = {registry: reg, session, folders: [], objects: ["ZCL_DDIC"], tolerant: true, provenance: true};
  compileProgram(options);
  const warm = compileProgram(options);
  assert.ok(warm.frontendCounts.reusedClasses.includes("ZCL_DDIC"));
  assert.ok(rows(warm, "CLAS ZCL_DDIC").some((q) => q.kind === "getObject" && q.phase === "lowering" && q.result.includes("TABL ZORACLE_TAB")));
});


test("unobserved prebuilt procedural registries are rebuilt after an INCLUDE edit", () => {
  const code = `import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    const core = createRequire(require.resolve('@abaplint/transpiler/package.json'))('@abaplint/core');
    const config = core.Config.getDefault().get(); config.rules = {check_syntax:true, parser_error:true};
    const reg = new core.Registry(new core.Config(JSON.stringify(config)));
    const xml = '<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><PROGDIR><SUBC>I</SUBC></PROGDIR></asx:values></asx:abap></abapGit>';
    for (const [name, raw] of Object.entries({
      'zmain.prog.abap': 'REPORT zmain. INCLUDE zprovider. INCLUDE zconsumer.',
      'zprovider.prog.abap': "DEFINE sibling. WRITE 'old'. END-OF-DEFINITION.",
      'zprovider.prog.xml': xml, 'zconsumer.prog.xml': xml, 'zconsumer.prog.abap': 'sibling.',
    })) reg.addFile(new core.MemoryFile(name, raw));
    reg.parse();
    reg.updateFile(new core.MemoryFile('zprovider.prog.abap', "DEFINE sibling. WRITE 'new'. END-OF-DEFINITION."));
    const {compileProgram} = await import('./tools/gogen/frontend.mjs');
    const p = compileProgram({registry:reg,folders:[],objects:[],tolerant:true});
    if (p.reg === reg) throw new Error('unobserved prebuilt registry was retained');
    if (p.reg.getObject('PROG','ZCONSUMER') === reg.getObject('PROG','ZCONSUMER')) throw new Error('consumer artifact was retained');
    if (!p.reg.getObject('PROG','ZPROVIDER').getMainABAPFile().getRaw().includes("'new'")) throw new Error('provider source was lost');`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {stdio: "pipe"});
});


test("first observed reparse cannot certify artifacts built before the frontend import", () => {
  const code = `import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    const core = createRequire(require.resolve('@abaplint/transpiler/package.json'))('@abaplint/core');
    const config = core.Config.getDefault().get();
    config.syntax = {...config.syntax, version:'v758', errorNamespace:'.'};
    config.rules = {check_syntax:true, parser_error:true};
    const files = {
      'zif_provider.intf.abap': 'INTERFACE zif_provider PUBLIC. TYPES value TYPE i. ENDINTERFACE.',
      'zif_consumer.intf.abap': 'INTERFACE zif_consumer PUBLIC. TYPES value TYPE zif_provider=>value. ENDINTERFACE.',
      'zreader.clas.abap': 'CLASS zreader DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS run RETURNING VALUE(rv) TYPE zif_consumer=>value. ENDCLASS. CLASS zreader IMPLEMENTATION. METHOD run. rv = 7. ENDMETHOD. ENDCLASS.',
    };
    const registry = () => {
      const reg = new core.Registry(new core.Config(JSON.stringify(config)));
      for (const [name, raw] of Object.entries(files)) reg.addFile(new core.MemoryFile(name, raw));
      return reg;
    };
    const reg = registry();
    reg.parse();
    assert.equal(reg.findIssues().length, 0);
    const {compileProgram} = await import('./tools/gogen/frontend.mjs');
    files['zif_provider.intf.abap'] = files['zif_provider.intf.abap'].replace('TYPE i.', 'TYPE int8.');
    reg.updateFile(new core.MemoryFile('zif_provider.intf.abap', files['zif_provider.intf.abap']));
    reg.parse();
    const options = {folders:[], objects:['ZREADER'], tolerant:true};
    const p = compileProgram({...options, registry:reg});
    const cold = compileProgram({...options, registry:registry()});
    const run = p => p.classes.find(c => c.name === 'ZREADER').methods.find(m => m.name === 'RUN');
    assert.equal(run(cold).returning.type.k, 'int8');
    assert.deepEqual(run(p), run(cold));
    assert.notEqual(p.reg, reg);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {stdio: "pipe"});
});
