import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileProgram} from "./frontend.mjs";
import {classSource, syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {compareArtifacts, artifactsOf} from "./cache-oracle-capture.mjs";
import {provenanceOf, recordProvenance} from "./frontend-provenance.mjs";
import {core} from "./frontend-inventory.mjs";
import {keyComputer} from "./frontend-v3-key.mjs";

function scratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-v3-"));
  const previous = process.env.GOGEN_CACHE_SHADOW_VALIDATE;
  process.env.GOGEN_CACHE_SHADOW_VALIDATE = "1";
  try { return run(dir); }
  finally {
    if (previous === undefined) delete process.env.GOGEN_CACHE_SHADOW_VALIDATE;
    else process.env.GOGEN_CACHE_SHADOW_VALIDATE = previous;
    rmSync(dir, {recursive: true, force: true});
  }
}
const put = (dir, files) => { for (const [name, raw] of Object.entries(files)) writeFileSync(join(dir, name), raw); };
const build = (dir, objects, extra = {}) => compileProgram({folders: [dir], objects, cacheDir: join(dir, "cache"), tolerant: true, ...extra});
const report = (p) => p.frontendCounts.shadowV3;
const row = (p, name) => report(p).entries.find((e) => e.name === name);
const reuse = (p) => report(p).entries.filter((e) => e.wouldReuseV3).length;

test("300-class shadow predictions: ten-class closure, isolated edit, unrelated addition; production stays global", () => scratch((dir) => {
  const names = Array.from({length: 300}, (_, i) => `ZC${String(i).padStart(4, "0")}`);
  const files = Object.fromEntries(names.map((n, i) => [`${n.toLowerCase()}.clas.abap`, classSource(n,
    i > 0 && i < 10 ? `rv = ${names[i - 1]}=>run( ).` : "rv = 1.")]));
  put(dir, files);
  const cold = build(dir, names);
  assert.equal(report(cold).entries.filter((e) => e.currentComplete).length, 300);
  assert.equal(provenanceOf(cold).size, 0, "internal recording does not expose expanded manifests");
  const warm = build(dir, names);
  assert.equal(reuse(warm), 300); assert.equal(report(warm).validated, 300);
  assert.equal(warm.frontendCounts.lowered, 0);
  writeFileSync(join(dir, "zc0000.clas.abap"), classSource(names[0], "rv = 9."));
  const chain = build(dir, names);
  assert.equal(reuse(chain), 290);
  assert.deepEqual(report(chain).entries.filter((e) => !e.wouldReuseV3).map((e) => e.name), names.slice(0, 10));
  assert.equal(chain.frontendCounts.lowered, 300, "production lookup still uses the global version");
  assert.equal(report(chain).entries.filter((e) => e.actuallyLowered).length, 300);
  assert.equal(compareArtifacts(artifactsOf(chain), artifactsOf(build(dir, names, {cacheDir: undefined}))).equal, true);
  writeFileSync(join(dir, "zc0250.clas.abap"), classSource(names[250], "rv = 7."));
  const isolated = build(dir, names);
  assert.equal(reuse(isolated), 299, JSON.stringify(report(isolated).entries.filter((e) => !e.wouldReuseV3))); assert.equal(row(isolated, names[250]).wouldReuseV3, false);
  put(dir, {"zunrelated.clas.abap": classSource("ZUNRELATED")});
  const added = build(dir, [...names, "ZUNRELATED"]);
  assert.equal(reuse(added), 300); assert.equal(row(added, "ZUNRELATED").wouldReuseV3, false);
}));

test("new selected IS SUPPLIED redefinition changes the saved query answer", () => scratch((dir) => {
  put(dir, {
    "zbase.clas.abap": "CLASS zbase DEFINITION PUBLIC. PUBLIC SECTION. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDCLASS. CLASS zbase IMPLEMENTATION. METHOD work. r = iv. ENDMETHOD. ENDCLASS.",
    "zreader.clas.abap": classSource("ZREADER", "DATA obj TYPE REF TO zbase. CREATE OBJECT obj. rv = obj->work( )."),
  });
  build(dir, ["ZBASE", "ZREADER"]);
  assert.equal(row(build(dir, ["ZBASE", "ZREADER"]), "ZREADER").wouldReuseV3, true);
  put(dir, {"zchild.clas.abap": "CLASS zchild DEFINITION PUBLIC INHERITING FROM zbase. PUBLIC SECTION. METHODS work REDEFINITION. ENDCLASS. CLASS zchild IMPLEMENTATION. METHOD work. IF iv IS SUPPLIED. r = iv. ENDIF. ENDMETHOD. ENDCLASS."});
  const changed = build(dir, ["ZBASE", "ZCHILD", "ZREADER"]);
  assert.equal(row(changed, "ZREADER").wouldReuseV3, false);
  assert.match(row(changed, "ZREADER").reason, /query:supplied/);
}));

test("new interface implementor changes the saved contribution query", () => scratch((dir) => {
  const intf = "INTERFACE zif_supply PUBLIC. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDINTERFACE.";
  const impl = (name, body) => `CLASS ${name} DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_supply. ENDCLASS. CLASS ${name} IMPLEMENTATION. METHOD zif_supply~work. ${body} ENDMETHOD. ENDCLASS.`;
  put(dir, {"zif_supply.intf.abap": intf, "zimpl.clas.abap": impl("zimpl", "r = iv."),
    "zreader.clas.abap": classSource("ZREADER", "DATA obj TYPE REF TO zif_supply. CREATE OBJECT obj TYPE zimpl. rv = obj->work( ).")});
  const names = ["ZIMPL", "ZREADER"];
  build(dir, names); assert.equal(row(build(dir, names), "ZREADER").wouldReuseV3, true);
  put(dir, {"zimpl2.clas.abap": impl("zimpl2", "IF iv IS SUPPLIED. r = iv. ENDIF.")});
  const changed = build(dir, [...names, "ZIMPL2"]);
  assert.equal(row(changed, "ZREADER").wouldReuseV3, false);
  assert.match(row(changed, "ZREADER").reason, /query:supplied/);
}));

test("new ENQU changes a saved named lock miss", () => scratch((dir) => {
  const c = syntheticCorpus({classes: 4});
  put(dir, Object.fromEntries(Object.entries(c.files).filter(([n]) => /\.(tabl|dtel|doma)\.xml$/.test(n))));
  put(dir, {"zlocker.clas.abap": classSource("ZLOCKER", "CALL FUNCTION 'ENQUEUE_EZLOCK'. rv = 1.")});
  build(dir, ["ZLOCKER"]);
  assert.equal(row(build(dir, ["ZLOCKER"]), "ZLOCKER").wouldReuseV3, true);
  put(dir, {"ezlock.enqu.xml": '<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DD25V><VIEWNAME>EZLOCK</VIEWNAME><ROOTTAB>ZORACLE_TAB</ROOTTAB></DD25V></asx:values></asx:abap></abapGit>'});
  const changed = build(dir, ["ZLOCKER"]);
  assert.equal(row(changed, "ZLOCKER").wouldReuseV3, false);
  assert.match(row(changed, "ZLOCKER").reason, /query:lock/);
}));

test("candidate index is bounded and corrupt payloads fail closed", () => scratch((dir) => {
  for (let i = 0; i < 7; i++) {
    put(dir, {"z.clas.abap": classSource("Z", `rv = ${i}.`)}); build(dir, ["Z"]);
  }
  const indexes = readdirSync(join(dir, "cache/v3"), {recursive: true}).filter((f) => f.endsWith("index.json"));
  assert.equal(indexes.length, 1);
  const indexPath = join(dir, "cache/v3", indexes[0]), keys = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(keys.length, 4);
  for (const key of keys) writeFileSync(join(indexPath, "..", `${key}.bin`), "corrupt");
  const p = build(dir, ["Z"]);
  assert.equal(row(p, "Z").wouldReuseV3, false); assert.equal(row(p, "Z").reason, "corrupt-candidate");
}));

test("explicit recording opt-out stays global only", () => scratch((dir) => {
  put(dir, {"z.clas.abap": classSource("Z")});
  const p = build(dir, ["Z"], {provenance: false});
  assert.equal(report(p), undefined);
  assert.ok(!readdirSync(join(dir, "cache")).includes("v3"));
}));

test("a stored complete candidate refuses a current unknown observation", () => scratch((dir) => {
  put(dir, {"z.clas.abap": classSource("Z")});
  build(dir, ["Z"]); assert.equal(reuse(build(dir, ["Z"])), 1);
  const p = recordProvenance(() => {
    // Match the folder compiler's config exactly, so this tests completeness
    // rather than a config/namespace miss.
    const config = core.Config.getDefault().get();
    config.syntax = {...config.syntax, version: "v758", errorNamespace: "."};
    config.rules = {check_syntax: true, parser_error: true};
    const reg = new core.Registry(new core.Config(JSON.stringify(config)));
    reg.addFile(new core.MemoryFile("z.clas.abap", classSource("Z"))); reg.parse();
    [...reg.getObjects()]; // Deliberately unaudited caller observation.
    return build(dir, ["Z"], {registry: reg});
  });
  assert.equal(row(p, "Z").wouldReuseV3, false);
  assert.match(row(p, "Z").reason, /current-unknown-scan/);
}));

test("completeness is recomputed: every dependency/raw hash and unknown marker matters; non-artifact roles do not", () => {
  const reg = new core.Registry(); reg.addFile(new core.MemoryFile("z.clas.abap", classSource("Z"))); reg.parse();
  const program = {reg, supplied: new Map(), lockObjects: new Map()}, value = {name: "Z", replay: {ops: []}};
  const node = {owner: "CLAS Z", digest: "owner-digest", dependencies: [], rows: []};
  const graph = {nodes: {"CLAS Z": node}};
  const compute = keyComputer(reg, "namespace", program), baseline = compute(graph, "CLAS Z", value);
  assert.equal(baseline.complete, true);
  for (const role of ["scheduling", "final-output"]) {
    node.rows.push({role, kind: "test-inventory", args: [], result: ["UNRELATED"]});
    assert.equal(compute(graph, "CLAS Z", value).key, baseline.key); node.rows.pop();
  }
  graph.nodes["INTF ZDEP"] = {owner: "INTF ZDEP", digest: null, dependencies: [], rows: []};
  node.dependencies.push("INTF ZDEP");
  assert.match(compute(graph, "CLAS Z", value).reason, /missing-digest:INTF ZDEP/); node.dependencies.pop();
  for (const marker of ["unknown", "untraced-artifact", "artifact-built-before-recording", "lowering-built-before-recording", "retained-registry-edit", "retained-registry-config-edit"]) {
    node.rows.push({role: "artifact", kind: "unknown-scan", args: [marker], result: []});
    assert.equal(compute(graph, "CLAS Z", value).complete, false, marker); node.rows.pop();
  }
  node.rows.push({role: "artifact", kind: "getFileByName", args: ["z.clas.abap"], result: ["z.clas.abap"]});
  assert.match(compute(graph, "CLAS Z", value).reason, /missing-raw-hash/);
});
