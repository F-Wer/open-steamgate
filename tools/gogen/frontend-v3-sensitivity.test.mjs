// Deliberately narrow cache seams remove redundant guards, so each fault must
// actually predict stale reuse and the independent cold validation must kill it.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {core, inputSnapshot} from "./frontend-inventory.mjs";
import {classSource, syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {recordProvenance, semanticQuery, auditedBookkeeping} from "./frontend-provenance.mjs";
import {prepareArtifactDigests} from "./frontend-artifact-digests.mjs";
import {objectCache, compileDiskClass} from "./frontend-object-cache.mjs";

function seam(cacheDir, files, lower) {
  return recordProvenance(() => {
    const cfg = core.Config.getDefault().get();
    cfg.syntax = {...cfg.syntax, version: "v758", errorNamespace: "."};
    cfg.rules = {check_syntax: true, parser_error: true};
    const reg = new core.Registry(new core.Config(JSON.stringify(cfg)));
    for (const [name, raw] of Object.entries(files)) reg.addFile(new core.MemoryFile(name, raw));
    reg.parse(); reg.findIssues(); prepareArtifactDigests(reg);
    const p = {reg, frontendCounts: {reused: 0, lowered: 0, reusedClasses: [], loweredClasses: []},
      supplied: new Map(), wanted: new Set(["ZREADER"]), effects: new Map()};
    const disk = auditedBookkeeping("test-cache-inventory", () => objectCache(reg, cacheDir));
    const session = {disk, classes: new Map()}; disk.begin();
    const reader = reg.getObject("CLAS", "ZREADER");
    const ir = compileDiskClass({reg, program: p}, reader, (ctx) => {
      const value = lower(ctx);
      ctx.program.effects.set("result", value);
      return {name: "ZREADER", value};
    }, session);
    disk.finish(p);
    return {ir, report: p.frontendCounts.shadowV3};
  });
}
function scratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-v3-sensitivity-"));
  const previous = {validate: process.env.GOGEN_CACHE_SHADOW_VALIDATE, fault: process.env.GOGEN_CACHE_SHADOW_FAULT};
  process.env.GOGEN_CACHE_SHADOW_VALIDATE = "1"; delete process.env.GOGEN_CACHE_SHADOW_FAULT;
  try { run(dir); }
  finally {
    for (const [key, value] of [["GOGEN_CACHE_SHADOW_VALIDATE", previous.validate], ["GOGEN_CACHE_SHADOW_FAULT", previous.fault]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, {recursive: true, force: true});
  }
}
const readerFiles = {"zreader.clas.abap": classSource("ZREADER")};
const provider = (n) => classSource("ZPROVIDER", "rv = value.", "i", `CONSTANTS value TYPE i VALUE ${n}.`);
const readConstant = ({reg}) => reg.getObject("CLAS", "ZPROVIDER")?.getDefinition().getAttributes().getConstants()[0].getValue() ?? "MISSING";

test("dropping a dependency digest produces a shadow disagreement", () => scratch((dir) => {
  const files = {...readerFiles, "zprovider.clas.abap": provider(1)};
  const prime = seam(join(dir, "good"), files, readConstant);
  assert.equal(prime.report.entries[0].currentComplete, true);
  files["zprovider.clas.abap"] = provider(9);
  assert.equal(seam(join(dir, "good"), files, readConstant).report.entries[0].wouldReuseV3, false);
  process.env.GOGEN_CACHE_SHADOW_FAULT = "drop-dependency:^CLAS ZPROVIDER$";
  files["zprovider.clas.abap"] = provider(1); seam(join(dir, "fault"), files, readConstant);
  files["zprovider.clas.abap"] = provider(9);
  assert.throws(() => seam(join(dir, "fault"), files, readConstant), /SHADOW V3 DISAGREEMENT/);
}));

test("ignoring a named miss produces a shadow disagreement when the provider is added", () => scratch((dir) => {
  const files = {...readerFiles};
  seam(join(dir, "good"), files, readConstant);
  files["zprovider.clas.abap"] = provider(9);
  assert.equal(seam(join(dir, "good"), files, readConstant).report.entries[0].wouldReuseV3, false);
  process.env.GOGEN_CACHE_SHADOW_FAULT = "ignore-miss";
  delete files["zprovider.clas.abap"]; seam(join(dir, "fault"), files, readConstant);
  files["zprovider.clas.abap"] = provider(9);
  assert.throws(() => seam(join(dir, "fault"), files, readConstant), /SHADOW V3 DISAGREEMENT/);
}));

test("falsely completing an unknown observation produces a shadow disagreement", () => scratch((dir) => {
  const files = {...readerFiles, "zprovider.clas.abap": provider(1)};
  const hidden = (ctx) => {
    semanticQuery(ctx.reg, "unknown-scan", ["test-hidden-provider"], []);
    return auditedBookkeeping("test-deliberately-hidden-read", () => readConstant(ctx));
  };
  assert.equal(seam(join(dir, "good"), files, hidden).report.entries[0].currentComplete, false);
  process.env.GOGEN_CACHE_SHADOW_FAULT = "unknown-complete";
  assert.equal(seam(join(dir, "fault"), files, hidden).report.entries[0].currentComplete, true);
  files["zprovider.clas.abap"] = provider(9);
  assert.throws(() => seam(join(dir, "fault"), files, hidden), /SHADOW V3 DISAGREEMENT/);
}));

test("second FUGR with the same FM changes last-wins ownership; ignoring its answer is killed", () => scratch((dir) => {
  const c = syntheticCorpus({classes: 4});
  const firstGroup = Object.fromEntries(Object.entries(c.files).filter(([n]) => n.startsWith("zoracle_group.fugr.")));
  const secondGroup = Object.fromEntries(Object.entries(firstGroup).map(([n, raw]) => [n.replaceAll("zoracle_group", "zzother_group"), raw.replaceAll("ZORACLE_GROUP", "ZZOTHER_GROUP").replaceAll("zoracle_group", "zzother_group")]));
  const files = {...readerFiles, ...firstGroup};
  const owner = ({reg}) => {
    const groups = auditedBookkeeping("test-current-fm-index", () => [...inputSnapshot(reg).objects.values()]
      .map((e) => e.obj).filter((o) => o instanceof core.Objects.FunctionGroup && o.getModule("ZORACLE_FUNCTION")));
    const answer = groups.length ? [`FUGR ${groups.at(-1).getName().toUpperCase()}`] : [];
    semanticQuery(reg, "function-module-owner", ["ZORACLE_FUNCTION"], answer, {policy: "gogen-last-wins"});
    return answer.join();
  };
  seam(join(dir, "good"), files, owner);
  assert.equal(seam(join(dir, "good"), files, owner).report.entries[0].wouldReuseV3, true);
  const changed = seam(join(dir, "good"), {...files, ...secondGroup}, owner);
  assert.equal(changed.report.entries[0].wouldReuseV3, false);
  assert.match(changed.report.entries[0].reason, /query:function-module-owner/);
  process.env.GOGEN_CACHE_SHADOW_FAULT = "ignore-query:function-module-owner";
  seam(join(dir, "fault"), files, owner);
  assert.throws(() => seam(join(dir, "fault"), {...files, ...secondGroup}, owner), /SHADOW V3 DISAGREEMENT/);
}));
