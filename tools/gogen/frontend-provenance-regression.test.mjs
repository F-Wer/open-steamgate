import {deserialize} from "node:v8";
import {inflateRawSync} from "node:zlib";
import {runInThisContext} from "node:vm";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {recordProvenance, provenanceOf, artifactLowering, withArtifact, storedProvenance, inheritStoredProvenance, expandProgramSelection} from "./frontend-provenance.mjs";
import {classSource, syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {emitGo} from "./emit-go.mjs";
const require = createRequire(import.meta.url), cr = createRequire(require.resolve("@abaplint/transpiler/package.json"));
const core = cr("@abaplint/core");
const xml = (body) => `<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>${body}</asx:values></asx:abap></abapGit>`;
function registry(files) {
  const config = core.Config.getDefault().get();
  config.syntax = {...config.syntax, version: "v758", errorNamespace: "."};
  config.rules = {check_syntax: true, parser_error: true};
  const reg = new core.Registry(new core.Config(JSON.stringify(config)));
  for (const [name, raw] of Object.entries(files)) reg.addFile(new core.MemoryFile(name, raw));
  return reg;
}
const allRows = (m) => [...m.hits, ...m.misses, ...m.scans, ...m.unknownScans];
const marker = (reg, owner, name) => provenanceOf(reg).get(owner).unknownScans.some((q) => q.args[0] === name);
const scope = (reg, obj, run) => withArtifact({reg}, obj, run, "test-artifact-build");
const aFiles = () => ({"zcl_a.clas.abap": classSource("zcl_a", "DATA x TYPE zmiss. rv = 7.")});

function diskFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((e) => e.isDirectory() ? diskFiles(join(dir, e.name)) : [join(dir, e.name)]);
}

test("public reporting is opt-in with cacheDir, and explicit false overrides the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "prov-optin-")), previous = process.env.GOGEN_PROVENANCE;
  try {
    writeFileSync(join(dir, "zcl_a.clas.abap"), classSource("zcl_a"));
    const options = {folders: [dir], objects: ["ZCL_A"], cacheDir: join(dir, "cache")};
    delete process.env.GOGEN_PROVENANCE;
    assert.equal(provenanceOf(compileProgram(options)).size, 0);
    process.env.GOGEN_PROVENANCE = "1";
    assert.ok(provenanceOf(compileProgram(options)).size > 0);
    assert.equal(provenanceOf(compileProgram({...options, provenance: false})).size, 0);
  } finally {
    if (previous === undefined) delete process.env.GOGEN_PROVENANCE; else process.env.GOGEN_PROVENANCE = previous;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("disk entries reference the shared graph, which stores own rows and artifact edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "prov-own-"));
  try {
    const c = syntheticCorpus({classes: 4});
    for (const [name, raw] of Object.entries(c.files)) writeFileSync(join(dir, name), raw);
    const options = {folders: [dir], objects: ["ZCL_DDIC"], cacheDir: join(dir, "cache"), provenance: true};
    compileProgram(options);
    const files = diskFiles(options.cacheDir);
    const entries = files.filter((f) => f.endsWith(".bin")).map((f) => deserialize(inflateRawSync(readFileSync(f).subarray(65))));
    const entry = entries.find((e) => e.value?.name === "ZCL_DDIC");
    assert.ok(entry.valueBytes, "frozen lowering bytes");
    assert.equal(entry.value.provenance, undefined, "no duplicate per-entry transcript");
    const graph = deserialize(inflateRawSync(readFileSync(files.find((f) => f.endsWith(`${entry.metadata.graph}.provenance`)))));
    const stored = graph.nodes[entry.metadata.root];
    assert.ok(stored.rows.every((q) => q.artifact === "CLAS ZCL_DDIC"));
    assert.ok(stored.dependencies.includes("TABL ZORACLE_TAB"));
    const warm = compileProgram(options), m = provenanceOf(warm).get("CLAS ZCL_DDIC");
    assert.ok(m.hits.some((q) => q.artifact === "DTEL ZORACLE_NUM" && q.result.includes("DOMA ZORACLE_NUM")));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("cached syntax built between recording sessions marks its owner untraced-artifact", () => {
  const reg = registry(aFiles()), session = {};
  recordProvenance(() => reg.parse());
  const options = {registry: reg, folders: [], objects: ["ZCL_A"], session, tolerant: true};
  compileProgram({...options, provenance: false});
  const p = compileProgram({...options, provenance: true});
  assert.ok(p.frontendCounts.reusedClasses.includes("ZCL_A"));
  assert.ok(marker(reg, "CLAS ZCL_A", "untraced-artifact"));
});

test("parsed DDIC built between recording sessions marks its owner untraced-artifact", () => {
  const c = syntheticCorpus({classes: 4}), reg = registry(c.files);
  recordProvenance(() => reg.parse());
  // Clear then build a cached type while hooks are absent, with no source edit.
  const table = reg.getObject("TABL", "ZORACLE_TAB");
  table.parsedType = undefined; table.parseType(reg);
  compileProgram({registry: reg, folders: [], objects: [], provenance: true});
  assert.ok(marker(reg, "TABL ZORACLE_TAB", "untraced-artifact"));
});

for (const edit of ["replace", "add", "remove"]) test(`retained registry ${edit} uses immutable file snapshots and prunes stale queries`, () => {
  const reg = registry({...aFiles(), "zcl_a.clas.locals_def.abap": "", "zcl_old.clas.abap": classSource("zcl_old")});
  recordProvenance(() => {
    reg.parse();
    scope(reg, reg.getObject("CLAS", "ZCL_A"), () => reg.getObject("CLAS", "ZSTALE"));
  });
  if (edit === "replace") reg.updateFile(new core.MemoryFile("zcl_a.clas.abap", classSource("zcl_a", "rv = 8.")));
  if (edit === "add") reg.addFile(new core.MemoryFile("zcl_a.clas.locals_imp.abap", ""));
  if (edit === "remove") reg.removeFile(reg.getFileByName("zcl_a.clas.locals_def.abap"));
  reg.removeFile(reg.getFileByName("zcl_old.clas.abap"));
  const p = compileProgram({registry: reg, folders: [], objects: [], provenance: true});
  assert.notEqual(p.reg, reg, "edited registries are rebuilt");
  assert.ok(!allRows(provenanceOf(p).get("CLAS ZCL_A")).some((q) => q.args.includes("ZSTALE")));
  assert.ok(!provenanceOf(p).has("CLAS ZCL_OLD"));
});

test("retained config edits prune old rows and fail closed", () => {
  const reg = registry(aFiles());
  recordProvenance(() => { reg.parse(); scope(reg, reg.getObject("CLAS", "ZCL_A"), () => reg.getObject("CLAS", "ZSTALE")); });
  reg.setConfig(new core.Config(JSON.stringify(reg.getConfig().get())));
  const p = compileProgram({registry: reg, folders: [], objects: [], provenance: true});
  assert.notEqual(p.reg, reg);
  assert.ok(!allRows(provenanceOf(p).get("CLAS ZCL_A")).some((q) => q.args.includes("ZSTALE")));
});

test("no stack frames is an unknown scan, including without artifact context", () => {
  const code = `import {recordProvenance,provenanceOf} from './tools/gogen/frontend-provenance.mjs';
    import {createRequire} from 'node:module';const r=createRequire(import.meta.url), c=createRequire(r.resolve('@abaplint/transpiler/package.json'))('@abaplint/core');
    const reg=new c.Registry();reg.addFile(new c.MemoryFile('z.prog.abap','REPORT z.'));
    recordProvenance(()=>{reg.parse();[...reg.getObjects()];});
    if(!provenanceOf(reg).get('PROG Z').unknownScans.some(q=>q.scan==='getObjects'&&q.artifact==='<registry>'))throw Error('missing unknown scan');`;
  execFileSync(process.execPath, ["--stack-trace-limit=0", "--input-type=module", "-e", code], {stdio: "pipe"});
});

test("unknown sites are module-relative and carry no absolute cwd or node_modules root", () => {
  const reg = registry(aFiles());
  recordProvenance(() => { reg.parse(); runInThisContext("(reg) => [...reg.getObjects()]", {filename: "/tmp/private-checkout/scan.mjs"})(reg); });
  const sites = provenanceOf(reg).get("CLAS ZCL_A").unknownScans.flatMap((q) => q.site ?? []);
  assert.ok(sites.length);
  for (const site of sites) assert.ok(!site.includes(process.cwd()) && !/(?:file:\/\/)?\/(?:home|mnt|tmp)\//.test(site), site);
});

test("macro-expanded CALL FUNCTION records lowering ownership and signature DDIC edges", () => {
  const c = syntheticCorpus({classes: 4});
  c.files["zoracle_group.fugr.xml"] = c.files["zoracle_group.fugr.xml"].replaceAll("<TYP>I</TYP>", "<TYP>ZORACLE_NUM</TYP>");
  c.files["zcl_function.clas.abap"] = classSource("zcl_function", "invoke.");
  c.files["zcl_function.clas.macros.abap"] = "DEFINE invoke. CALL FUNCTION 'ZORACLE_FUNCTION' EXPORTING iv_value = 7 IMPORTING ev_value = rv. END-OF-DEFINITION.";
  const build = () => recordProvenance(() => {
    const reg = registry(c.files); reg.parse();
    return compileProgram({registry: reg, folders: [], objects: ["ZCL_FUNCTION", "ZORACLE_GROUP"], tolerant: true});
  });
  const p = build(), m = provenanceOf(p).get("CLAS ZCL_FUNCTION");
  assert.ok(m.hits.some((q) => q.artifact === "CLAS ZCL_FUNCTION" && q.phase === "lowering" && q.kind === "function-module-owner" && q.result.includes("FUGR ZORACLE_GROUP")));
  for (const name of ["DTEL ZORACLE_NUM", "DOMA ZORACLE_NUM"]) assert.ok(m.hits.some((q) => q.result.includes(name)), name);
  c.files["zoracle_num.doma.xml"] = c.files["zoracle_num.doma.xml"].replace("INT4", "INT8");
  assert.notEqual(emitGo(p), emitGo(build()), "signature edit changes cold output");
});

test("macro-expanded missing CALL FUNCTION records a consumer miss before the module is added", () => {
  const c = syntheticCorpus({classes: 4});
  c.files["zcl_a.clas.abap"] = classSource("zcl_a", "invoke 'ZORACLE_FUNCTION'.");
  c.files["zcl_a.clas.macros.abap"] = "DEFINE invoke. CALL FUNCTION &1 EXPORTING iv_value = 7 IMPORTING ev_value = rv. END-OF-DEFINITION.";
  const moduleFile = "zoracle_group.fugr.zoracle_function.abap";
  const originalXml = c.files["zoracle_group.fugr.xml"], originalModule = c.files[moduleFile];
  c.files["zoracle_group.fugr.xml"] = originalXml.replaceAll("ZORACLE_FUNCTION", "ZOTHER");
  delete c.files[moduleFile];
  c.files["zoracle_group.fugr.zother.abap"] = originalModule.replaceAll("zoracle_function", "zother");
  const build = () => recordProvenance(() => {
    const reg = registry(c.files); reg.parse();
    return compileProgram({registry: reg, folders: [], objects: ["ZCL_A", "ZORACLE_GROUP"], tolerant: true});
  });
  const query = (q) => q.artifact === "CLAS ZCL_A" && q.phase === "lowering"
    && q.kind === "function-module-owner" && q.args[0] === "ZORACLE_FUNCTION";
  const before = build();
  assert.ok(JSON.stringify([before.skipped, before.partial]).includes("no host implementation"), JSON.stringify([before.skipped, before.partial]));
  assert.ok(provenanceOf(before).get("CLAS ZCL_A").misses.some(query), "consumer ownership MISS");
  c.files["zoracle_group.fugr.xml"] = originalXml;
  delete c.files["zoracle_group.fugr.zother.abap"];
  c.files[moduleFile] = originalModule;
  const after = build(), manifest = provenanceOf(after).get("CLAS ZCL_A");
  assert.ok(!JSON.stringify([after.skipped, after.partial]).includes("no host implementation"));
  assert.ok(JSON.stringify(after.classes.find((cls) => cls.name === "ZCL_A")).includes('"s":"call"'));
  assert.ok(manifest.hits.some((q) => query(q) && q.result.includes("FUGR ZORACLE_GROUP")), "consumer ownership HIT");
  assert.ok(!manifest.misses.some(query));
});

test("selection queries add edges and belong to their consumer", () => {
  const c = syntheticCorpus({classes: 4}), reg = registry(c.files);
  recordProvenance(() => {
    reg.parse();
    const group = reg.getObject("FUGR", "ZORACLE_GROUP");
    scope(reg, group, () => reg.getObject("DOMA", "ZSIGNATURE_MISS"));
    expandProgramSelection(reg, ["zcl_function"], core);
    const own = storedProvenance(reg, reg.getObject("CLAS", "ZCL_FUNCTION"));
    assert.ok(own.rows.some((q) => q.kind === "function-module-owner" && q.artifact === "CLAS ZCL_FUNCTION"));
  });
  const m = provenanceOf(reg).get("CLAS ZCL_FUNCTION");
  assert.ok(m.misses.some((q) => q.artifact === "FUGR ZORACLE_GROUP" && q.args.includes("ZSIGNATURE_MISS")));
  assert.ok(!provenanceOf(reg).get("CLAS ZCL_CONTROL_0000").misses.some((q) => q.args.includes("ZSIGNATURE_MISS")));
});

test("cached artifact reads link providers through the owners map without lookup arguments", () => {
  const reg = registry({"zcl_a.clas.abap": classSource("zcl_a"), "zprovider.prog.abap": "REPORT zprovider."});
  recordProvenance(() => {
    reg.parse();
    const a = reg.getObject("CLAS", "ZCL_A"), provider = reg.getObject("PROG", "ZPROVIDER");
    scope(reg, provider, () => reg.getObject("DOMA", "ZARTIFACT_MISS"));
    scope(reg, a, () => provider.getABAPFiles()); // no Registry argument, cached files
  });
  assert.ok(provenanceOf(reg).get("CLAS ZCL_A").misses.some((q) => q.artifact === "PROG ZPROVIDER" && q.args.includes("ZARTIFACT_MISS")));
});

for (const method of ["getModule", "getInclude"]) test(`${method} artifact hook names the function group query`, () => {
  const reg = registry(syntheticCorpus({classes: 4}).files);
  recordProvenance(() => {
    reg.parse();
    const a = reg.getObject("CLAS", "ZCL_FUNCTION"), group = reg.getObject("FUGR", "ZORACLE_GROUP");
    scope(reg, a, () => group[method](method === "getModule" ? "ZORACLE_FUNCTION" : "LZORACLE_GROUPTOP"));
    const own = storedProvenance(reg, a);
    assert.ok(own.rows.some((q) => q.kind === (method === "getModule" ? "function-module-owner" : "function-group-include") && q.result.includes("FUGR ZORACLE_GROUP")));
  });
});

test("implicit pool constant and procedural include queries retain semantic names", () => {
  const c = syntheticCorpus({classes: 4});
  c.files["zmain.prog.abap"] = "REPORT zmain. INCLUDE zinc.";
  c.files["zinc.prog.abap"] = "FORM work. ENDFORM.";
  c.files["zinc.prog.xml"] = xml("<PROGDIR><SUBC>I</SUBC></PROGDIR>");
  const reg = registry(c.files);
  recordProvenance(() => {
    reg.parse(); reg.findIssues();
    const a = reg.getObject("CLAS", "ZCL_CONTROL_0000");
    const {CurrentScope} = cr("@abaplint/core/build/src/abap/5_syntax/_current_scope");
    scope(reg, a, () => CurrentScope.buildDefault(reg, a).findTypePoolConstant("ZORC_LIMIT"));
  });
  assert.ok(allRows(provenanceOf(reg).get("CLAS ZCL_CONTROL_0000")).some((q) => q.kind === "implicit-type-pool-constant" && q.args[0] === "ZORC_LIMIT" && q.artifact === "CLAS ZCL_CONTROL_0000"));
  assert.ok(allRows(provenanceOf(reg).get("PROG ZMAIN")).some((q) => q.kind === "function-group-include" && q.args[0]?.toUpperCase().startsWith("INCLUDE ZINC")));
});

test("cross include candidate context belongs only to the consumer", () => {
  const reg = registry({
    "zmain.prog.abap": "REPORT zmain. INCLUDE zprovider. INCLUDE zconsumer.",
    "zprovider.prog.abap": "DEFINE sibling. WRITE 'ok'. END-OF-DEFINITION.",
    "zconsumer.prog.abap": "sibling.",
    "zprovider.prog.xml": xml("<PROGDIR><SUBC>I</SUBC></PROGDIR>"),
    "zconsumer.prog.xml": xml("<PROGDIR><SUBC>I</SUBC></PROGDIR>"),
    "zcl_unrelated.clas.abap": classSource("zcl_unrelated"),
  });
  recordProvenance(() => reg.parse());
  const consumer = provenanceOf(reg).get("PROG ZCONSUMER"), unrelated = provenanceOf(reg).get("CLAS ZCL_UNRELATED");
  assert.ok(consumer.hits.some((q) => q.kind === "include-parent" && q.artifact === "PROG ZCONSUMER" && q.result.includes("PROG ZMAIN")));
  for (const m of [consumer, unrelated]) assert.ok(!m.hits.some((q) => q.artifact === "<registry>" && q.kind === "include-parent"));
  assert.ok(!unrelated.hits.some((q) => q.kind === "include-parent" || q.kind === "getObject" && q.result.includes("PROG ZPROVIDER")));
});

test("subclass DDIC and interface implicit pool dependencies inherit provider artifacts", () => {
  const c = syntheticCorpus({classes: 4});
  c.files["zcl_parent.clas.abap"] = "CLASS zcl_parent DEFINITION PUBLIC. PUBLIC SECTION. DATA value TYPE zoracle_num. ENDCLASS. CLASS zcl_parent IMPLEMENTATION. ENDCLASS.";
  c.files["zcl_child.clas.abap"] = "CLASS zcl_child DEFINITION PUBLIC INHERITING FROM zcl_parent. PUBLIC SECTION. METHODS run RETURNING VALUE(rv) TYPE i. ENDCLASS. CLASS zcl_child IMPLEMENTATION. METHOD run. rv = value. ENDMETHOD. ENDCLASS.";
  c.files["zif_typed.intf.abap"] = "INTERFACE zif_typed PUBLIC. METHODS run RETURNING VALUE(rv) TYPE zorc_value. ENDINTERFACE.";
  c.files["zcl_typed.clas.abap"] = "CLASS zcl_typed DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_typed. ENDCLASS. CLASS zcl_typed IMPLEMENTATION. METHOD zif_typed~run. rv = 1. ENDMETHOD. ENDCLASS.";
  const reg = registry(c.files);
  recordProvenance(() => { reg.parse(); compileProgram({registry: reg, folders: [], objects: ["ZCL_CHILD", "ZCL_TYPED"], tolerant: true}); });
  assert.ok(provenanceOf(reg).get("CLAS ZCL_CHILD").hits.some((q) => q.result.includes("DOMA ZORACLE_NUM") && q.artifact !== "CLAS ZCL_CHILD"));
  assert.ok(provenanceOf(reg).get("CLAS ZCL_TYPED").hits.some((q) => q.kind === "implicit-type-pool" && q.artifact === "INTF ZIF_TYPED"));
});

test("session lowering built while recording was off has an explicit marker", () => {
  const reg = registry({"zcl_a.clas.abap": classSource("zcl_a")}), session = {};
  recordProvenance(() => { reg.parse(); reg.findIssues(); });
  const options = {registry: reg, folders: [], objects: ["ZCL_A"], session};
  compileProgram({...options, provenance: false});
  const p = compileProgram({...options, provenance: true});
  assert.ok(p.frontendCounts.reusedClasses.includes("ZCL_A"));
  assert.ok(marker(reg, "CLAS ZCL_A", "lowering-built-before-recording"));
});

test("disk entries built without recording omit metadata and mark subsequent recorded replay incomplete", () => {
  const dir = mkdtempSync(join(tmpdir(), "prov-lowering-"));
  try {
    writeFileSync(join(dir, "zcl_a.clas.abap"), classSource("zcl_a"));
    const options = {folders: [dir], objects: ["ZCL_A"], cacheDir: join(dir, "cache")};
    const off = compileProgram({...options, provenance: false});
    assert.equal(provenanceOf(off, {internal: true}).size, 0, "no internal recorder either");
    const entries = diskFiles(options.cacheDir).filter((f) => f.endsWith(".bin"))
      .map((f) => deserialize(inflateRawSync(readFileSync(f).subarray(65))));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].metadata, undefined, "no dependency digest metadata");
    assert.equal(entries[0].value.provenance, undefined, "no own-row transcript");
    const p = compileProgram({...options, provenance: true});
    assert.ok(p.frontendCounts.reusedClasses.includes("ZCL_A"));
    assert.ok(marker(p.reg, "CLAS ZCL_A", "lowering-built-before-recording"));
    assert.equal(emitGo(p), emitGo(compileProgram({...options, cacheDir: undefined, provenance: true})));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

for (const [type, name, method] of [["CLAS", "ZCL_CONTROL_0001", "getDefinition"],
  ["FUGR", "ZORACLE_GROUP", "getIncludes"], ["FUGR", "ZORACLE_GROUP", "getModules"],
  ["ENHS", "ZSPOT", "listBadiDefinitions"]]) test(`isolated cached ${method} inherits its provider queries`, () => {
  const c = syntheticCorpus({classes: 4});
  c.files["zspot.enhs.xml"] = xml("<BADI_DATA><ENH_BADI_DATA><BADI_NAME>ZBADI</BADI_NAME><INTERFACE_NAME>ZIF_BADI</INTERFACE_NAME></ENH_BADI_DATA></BADI_DATA>");
  const reg = registry(c.files);
  recordProvenance(() => {
    reg.parse(); reg.findIssues();
    const a = reg.getObject("CLAS", "ZCL_CONTROL_0000"), provider = reg.getObject(type, name);
    provider[method](); // warm the getter before reading it under the consumer
    scope(reg, provider, () => reg.getObject("DOMA", "ZLEAF_MISS"));
    scope(reg, a, () => provider[method]());
  });
  assert.ok(provenanceOf(reg).get("CLAS ZCL_CONTROL_0000").misses.some((q) => q.artifact === `${type} ${name}` && q.args.includes("ZLEAF_MISS")));
});

test("plain class compilation and inactive hooks never load the recorder", () => {
  const code = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {compileProgram} from './tools/gogen/frontend.mjs';
    import {classSource} from './tools/gogen/cache-oracle-corpus.mjs';
    import * as facade from './tools/gogen/frontend-provenance.mjs';
    const require = createRequire(import.meta.url);
    const recorder = require.resolve('./tools/gogen/frontend-provenance-recorder.mjs');
    const core = createRequire(require.resolve('@abaplint/transpiler/package.json'))('@abaplint/core');
    const reg = new core.Registry();
    reg.addFile(new core.MemoryFile('zcl_a.clas.abap', classSource('zcl_a')));
    assert.equal(require.cache[recorder], undefined);
    const p = compileProgram({registry: reg, folders: [], objects: ['ZCL_A']});
    assert.equal(p.classes[0].name, 'ZCL_A');
    const inaccessible = new Proxy({}, {get() { throw new Error('unexpected argument read'); }});
    const value = {};
    assert.equal(facade.withArtifact(inaccessible, inaccessible, () => value), value);
    assert.equal(facade.artifactLowering((ctx, obj, arg) => arg)(inaccessible, inaccessible, value), value);
    for (const run of [f => facade.withRole('scheduling', f),
      f => facade.auditedBookkeeping('test', f), f => facade.recordedArtifactBuild(f)]) {
      assert.equal(run(() => value), value);
      assert.throws(() => run(() => { throw value; }), e => e === value);
    }
    assert.equal(facade.semanticQuery(inaccessible, 'unknown-scan', [], [], inaccessible), undefined);
    assert.equal(facade.beginProvenanceCompile(inaccessible), undefined);
    assert.equal(facade.recordingProvenance(), false);
    assert.equal(facade.provenanceAuditActive(), false);
    assert.equal(facade.auditBuiltArtifacts(inaccessible), false);
    const objects = [...reg.getObjects()];
    assert.deepEqual(facade.enumerateObjects(reg, 'test', [], 'scheduling', (_, i) => i === 0), objects.slice(0, 1));
    assert.equal(facade.resolvedFunctionModule({program: {functionModules: new Map([['A', value]])}}, 'A'), value);
    assert.equal(require.cache[recorder], undefined);
    facade.recordProvenance(() => assert.equal(facade.recordingProvenance(), true));
    assert.ok(require.cache[recorder]);
    assert.equal(facade.recordingProvenance(), false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(), env: {...process.env, GOGEN_PROVENANCE: "0"}, encoding: "utf8",
  });
});

test("selection uses parsed calls and static identifiers, preserving per-file query order", () => {
  const c = syntheticCorpus({classes: 4});
  c.files["zcl_select.clas.abap"] = classSource("zcl_select", `
    rv = zcl_static=>value.
    CALL FUNCTION 'zoracle_function'.
    CALL FUNCTION 'ZNO_SUCH_FUNCTION'.
    CALL FUNCTION dynamic_name.
    rv = zcl_static => value.
    " CALL FUNCTION 'ZCOMMENT'. zcl_comment=>value
* CALL FUNCTION 'ZFULL_COMMENT'. zcl_comment=>value
    DATA text TYPE string.
    text = 'CALL FUNCTION ''ZLITERAL''. zcl_literal=>value'.
    text = \`CALL FUNCTION 'ZBACKTICK'. zcl_literal=>value\`.
    text = |CALL FUNCTION 'ZTEMPLATE'. zcl_literal=>value|.
    text = |{ zcl_static=>value }|.
  `);
  for (const name of ["zcl_static", "zcl_comment", "zcl_literal"])
    c.files[`${name}.clas.abap`] = classSource(name, "rv = 7.", "i", "CLASS-DATA value TYPE i.");
  const reg = registry(c.files);
  recordProvenance(() => {
    reg.parse();
    const wanted = ["zcl_select"];
    expandProgramSelection(reg, wanted, core);
    assert.deepEqual(wanted, ["zcl_select", "zoracle_group", "zcl_static"]);
    const own = storedProvenance(reg, reg.getObject("CLAS", "ZCL_SELECT"));
    const relevant = own.rows.filter(q => q.kind === "function-module-owner"
      || q.kind === "getObject" && ["ZCL_STATIC", "ZCL_COMMENT", "ZCL_LITERAL"].includes(q.args[1]));
    assert.deepEqual(relevant.map(q => [q.kind, q.args]), [
      ["function-module-owner", ["ZORACLE_FUNCTION"]],
      ["function-module-owner", ["ZNO_SUCH_FUNCTION"]],
      ["getObject", ["CLAS", "ZCL_STATIC"]],
    ]);
    assert.ok(relevant.every(q => q.phase === "selection"));
  });
});
