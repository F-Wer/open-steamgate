// Lazy type pools exercise the real cache seam without eager findIssues().
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {core, freshRegistry} from "./frontend-inventory.mjs";
import {classSource} from "./cache-oracle-corpus.mjs";
import {recordProvenance, auditedBookkeeping, provenanceOf, semanticQuery, beginProvenanceCompile} from "./frontend-provenance.mjs";
import {prepareArtifactDigests, artifactDigestOf, artifactDigestStats} from "./frontend-artifact-digests.mjs";
import {dependencyGraph} from "./frontend-provenance-metadata.mjs";
import {objectCache, compileDiskClass} from "./frontend-object-cache.mjs";
const intf = (n) => `INTERFACE zif_types PUBLIC. TYPES ty_x TYPE c LENGTH ${n}. ENDINTERFACE.`;
const corpus = () => ({"zreader.clas.abap": classSource("ZREADER"),
  "zz.type.abap": "TYPE-POOL zz.\nTYPES zz_t TYPE zif_types=>ty_x.\n", "zif_types.intf.abap": intf(5)});
const registry = (files) => {
  const cfg = core.Config.getDefault().get();
  cfg.syntax = {...cfg.syntax, version: "v758", errorNamespace: "."};
  cfg.rules = {check_syntax: true, parser_error: true};
  const reg = new core.Registry(new core.Config(JSON.stringify(cfg)));
  for (const [name, raw] of Object.entries(files)) reg.addFile(new core.MemoryFile(name, raw));
  reg.parse(); prepareArtifactDigests(reg);
  return reg;
};
const lower = ({reg}) => {
  const pool = reg.getObject("TYPE", "ZZ");
  return new core.SyntaxLogic(reg, pool).run().spaghetti.getFirstChild()?.getFirstChild()?.findType("ZZ_T").getType().getLength();
};
function seam(cacheDir, files, lowering = lower, retained) {
  return recordProvenance(() => {
    const reg = retained ? freshRegistry(retained) : registry(files);
    beginProvenanceCompile(reg); prepareArtifactDigests(reg);
    const p = {reg, supplied: new Map(), wanted: new Set(["ZREADER"]), effects: new Map(),
      frontendCounts: {reused: 0, lowered: 0, reusedClasses: [], loweredClasses: []}};
    const disk = auditedBookkeeping("test-cache-inventory", () => objectCache(reg, cacheDir));
    const session = {disk, classes: new Map()}; disk.begin();
    const ir = compileDiskClass({reg, program: p}, reg.getObject("CLAS", "ZREADER"), (ctx) => {
      const value = lowering(ctx); ctx.program.effects.set("result", value); return {name: "ZREADER", value};
    }, session);
    disk.finish(p);
    return {reg, ir, row: p.frontendCounts.shadowV3.entries[0], report: p.frontendCounts.shadowV3, manifest: provenanceOf(p)};
  });
}
function scratch(validate, run) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-v3-audit-")), previous = process.env.GOGEN_CACHE_SHADOW_VALIDATE;
  const exhaustive = process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE;
  process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE = "1";
  if (validate) process.env.GOGEN_CACHE_SHADOW_VALIDATE = "1"; else delete process.env.GOGEN_CACHE_SHADOW_VALIDATE;
  try { run(dir); } finally {
    if (exhaustive === undefined) delete process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE; else process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE = exhaustive;
    if (previous === undefined) delete process.env.GOGEN_CACHE_SHADOW_VALIDATE; else process.env.GOGEN_CACHE_SHADOW_VALIDATE = previous;
    rmSync(dir, {recursive: true, force: true});
  }
}
for (const validate of [false, true]) test(`lazy type-pool C1–C4 refuses interface edit (validation ${validate})`, () => scratch(validate, (dir) => {
  const files = corpus();
  const c1 = seam(dir, files);
  assert.equal(c1.ir.value, 5); assert.equal(c1.row.currentComplete, true);
  const c2 = seam(dir, {...files, "zun1.clas.abap": classSource("ZUN1")});
  assert.equal(c2.row.wouldReuseV3, true, JSON.stringify(c2.row));
  const unrelated = {"zun2.clas.abap": classSource("ZUN2")};
  const c3 = seam(dir, {...files, ...unrelated});
  assert.equal(c3.row.wouldReuseV3, true); assert.equal(c3.ir.value, 5);
  const c4 = seam(dir, {...files, ...unrelated, "zif_types.intf.abap": intf(7)});
  assert.equal(c4.row.wouldReuseV3, false);
  assert.equal(c4.row.reason, "dependency:INTF ZIF_TYPES");
  assert.equal(c4.ir.value, 7); assert.equal(c4.report.disagreements, 0);
}));

test("same corpus saves identical graph after different digest probe orders", () => {
  const graph = (order) => recordProvenance(() => {
    const reg = registry(corpus());
    artifactDigestOf(reg, order[0]);
    lower({reg});
    artifactDigestOf(reg, order[1]);
    return dependencyGraph(reg, [], ["TYPE ZZ", "INTF ZIF_TYPES"]);
  });
  assert.deepEqual(graph(["TYPE ZZ", "INTF ZIF_TYPES"]), graph(["INTF ZIF_TYPES", "TYPE ZZ"]));
});

test("audit build after parse produces untraced-artifact and writes no v3 candidate", () => scratch(true, (dir) => {
  const result = seam(dir, corpus(), (ctx) => {
    auditedBookkeeping("test-audit-lazy-build", () => lower(ctx));
    return lower(ctx); // Cached syntax must not be mistaken for a traced build.
  });
  const unknown = result.manifest.get("CLAS ZREADER").unknownScans;
  assert.ok(unknown.some((q) => q.args.includes("untraced-artifact")), JSON.stringify(unknown));
  assert.equal(result.row.currentComplete, false);
  const files = readdirSync(dir, {recursive: true});
  assert.ok(!files.some((f) => f.startsWith("v3/") && f.endsWith("index.json")));
}));

const v3Files = (dir) => readdirSync(join(dir, "v3"), {recursive: true}).filter((f) => /\.(json|bin|provenance)$/.test(f))
  .sort().map((f) => [f, readFileSync(join(dir, "v3", f)).toString("hex")]);

test("retained unchanged registry resets compile refusal but retains poisoned provider gaps", () => scratch(false, (dir) => {
  const firstDir = join(dir, "first");
  const first = seam(firstDir, corpus(), (ctx) => {
    auditedBookkeeping("test-audit-lazy-build", () => lower(ctx));
    return 5; // This lowering does not consume the poisoned provider.
  });
  assert.equal(first.report.persistenceRefused, "audit-built-artifact");
  assert.ok(!readdirSync(firstDir, {recursive: true}).some((f) => f.startsWith("v3/") && f.endsWith("index.json")));
  // Separate disk roots force normal lowering rather than production replay.
  const secondDir = join(dir, "second");
  const second = seam(secondDir, corpus(), () => 5, first.reg);
  assert.equal(second.reg, first.reg);
  assert.equal(second.report.persistenceRefused, undefined);
  assert.equal(second.row.currentComplete, true, JSON.stringify(second.row));
  assert.ok(v3Files(secondDir).some(([f]) => f.endsWith("index.json")));
  assert.ok(second.manifest.get("TYPE ZZ").unknownScans.some((q) => q.args.includes("untraced-artifact")));
  const probe = seam(secondDir, corpus(), () => 5, second.reg);
  assert.equal(probe.reg, first.reg);
  assert.equal(probe.row.wouldReuseV3, true);
  const third = seam(join(dir, "third"), corpus(), lower, second.reg);
  assert.equal(third.reg, first.reg);
  assert.equal(third.row.currentComplete, false, "reading the old poisoned identity still fails closed");
  assert.ok(third.manifest.get("TYPE ZZ").unknownScans.some((q) => q.args.includes("untraced-artifact")));
}));

test("digest miss under audit is recomputed outside audit in the same compile", () => scratch(true, (dir) => {
  const result = seam(dir, corpus(), (ctx) => {
    assert.equal(auditedBookkeeping("test-audit-digest-miss", () => artifactDigestOf(ctx.reg, "TYPE ZZ")), null);
    assert.deepEqual(artifactDigestStats(ctx.reg).errors, {});
    assert.match(artifactDigestOf(ctx.reg, "TYPE ZZ"), /^[a-f0-9]{64}$/);
    return lower(ctx);
  });
  assert.equal(result.ir.value, 5);
  assert.equal(result.row.currentComplete, true);
  assert.equal(result.report.persistenceRefused, undefined);
  assert.equal(result.report.disagreements, 0);
  assert.ok(v3Files(dir).some(([f]) => f.endsWith("index.json")));
}));

test("a cold validator build poisons the compile and leaves existing v3 files untouched", () => scratch(true, (dir) => {
  const files = corpus();
  seam(dir, files, () => 5);
  const before = v3Files(dir);
  const result = seam(dir, {...files, "zunrelated.clas.abap": classSource("ZUNRELATED")});
  assert.equal(result.report.validated, 1); assert.equal(result.report.disagreements, 0);
  assert.equal(result.report.persistenceRefused, "audit-built-artifact");
  assert.equal(result.row.currentComplete, false);
  assert.ok(result.manifest.get("TYPE ZZ").unknownScans.some((q) => q.args.includes("untraced-artifact")));
  assert.deepEqual(v3Files(dir), before);
}));

test("query re-evaluation that builds a lazy pool refuses reuse and all v3 writes", () => scratch(false, (dir) => {
  // A narrow semantic-query seam deliberately omits the direct provider read,
  // so only the audit-build guard can detect this re-evaluator's lazy build.
  const queryOnly = ({reg}) => { semanticQuery(reg, "implicit-type-pool", ["ZZZ_T"], ["ZZZ_T"]); return 5; };
  const files = corpus();
  files["zzz.type.abap"] = files["zz.type.abap"].replaceAll("zz", "zzz"); delete files["zz.type.abap"];
  seam(dir, files, queryOnly);
  const before = v3Files(dir);
  const result = seam(dir, {...files, "zunrelated.clas.abap": classSource("ZUNRELATED")}, queryOnly);
  assert.equal(result.row.wouldReuseV3, false); assert.equal(result.row.reason, "audit-built-artifact");
  assert.equal(result.report.persistenceRefused, "audit-built-artifact");
  assert.deepEqual(v3Files(dir), before);
}));
