import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {compileProgram} from "./frontend.mjs";
import {objectCache} from "./frontend-object-cache.mjs";
import {core} from "./frontend-inventory.mjs";
import {emitGo} from "./emit-go.mjs";
import {classSource, syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {home} from "./home.mjs";

function scratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-global-first-"));
  const previous = process.env.GOGEN_CACHE_SHADOW_VALIDATE;
  const exhaustive = process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE;
  delete process.env.GOGEN_CACHE_SHADOW_VALIDATE;
  delete process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE;
  try { run(dir); } finally {
    if (previous === undefined) delete process.env.GOGEN_CACHE_SHADOW_VALIDATE;
    else process.env.GOGEN_CACHE_SHADOW_VALIDATE = previous;
    if (exhaustive === undefined) delete process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE;
    else process.env.GOGEN_CACHE_SHADOW_EXHAUSTIVE = exhaustive;
    rmSync(dir, {recursive: true, force: true});
  }
}
const build = (dir, extra = {}) => compileProgram({folders: [dir], objects: ["Z"], cacheDir: join(dir, "cache"), ...extra});
const coldEqual = (p, dir, extra = {}) => assert.equal(emitGo(p), emitGo(build(dir, {...extra, cacheDir: undefined})));

test("global replay precedes v3 setup; exhaustive mode still validates real predictions", () => scratch((dir) => {
  writeFileSync(join(dir, "z.clas.abap"), classSource("Z"));
  build(dir);
  const warm = build(dir);
  assert.deepEqual(warm.frontendCounts.reusedClasses, ["Z"]);
  assert.equal(warm.frontendCounts.shadowV3, undefined, "no probe or key computer on a global replay hit");
  coldEqual(warm, dir);
  process.env.GOGEN_CACHE_SHADOW_VALIDATE = "1";
  const exhaustive = build(dir);
  assert.equal(exhaustive.frontendCounts.shadowV3.validated, 1);
  assert.equal(exhaustive.frontendCounts.shadowV3.disagreements, 0);
  assert.equal(emitGo(exhaustive), emitGo(warm));
}));

test("same-size same-mtime content edit misses, then the edited generation warms globally", () => scratch((dir) => {
  const file = join(dir, "z.clas.abap");
  writeFileSync(file, classSource("Z", "rv = 1."));
  // Use exactly representable timestamps, so a fractional-ms rounding change
  // cannot accidentally make a stat-based guard pass this test.
  utimesSync(file, new Date("2020-01-02T03:04:05Z"), new Date("2020-01-02T03:04:05Z"));
  const before = build(dir), stat = statSync(file);
  assert.equal(build(dir).frontendCounts.reused, 1);
  writeFileSync(file, readFileSync(file, "utf8").replace("rv = 1.", "rv = 9."));
  utimesSync(file, stat.atime, stat.mtime);
  assert.equal(statSync(file).size, stat.size);
  assert.equal(statSync(file).mtimeMs, stat.mtimeMs);
  const edited = build(dir);
  assert.equal(edited.frontendCounts.reused, 0);
  assert.notEqual(emitGo(edited), emitGo(before));
  coldEqual(edited, dir);
  const warm = build(dir);
  assert.equal(warm.frontendCounts.reused, 1);
  assert.equal(warm.frontendCounts.shadowV3, undefined);
  coldEqual(warm, dir);
}));

test("effective layer order changes the global content certificate", () => scratch((dir) => {
  const a = join(dir, "a"), b = join(dir, "b"); mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, "a.clas.abap"), classSource("A"));
  writeFileSync(join(b, "b.clas.abap"), classSource("B"));
  const options = {folders: [a, b], objects: ["A", "B"]};
  build(dir, options);
  assert.equal(build(dir, options).frontendCounts.reused, 2);
  const reversed = {...options, folders: [b, a]}, changed = build(dir, reversed);
  assert.equal(changed.frontendCounts.reused, 0);
  coldEqual(changed, dir, reversed);
}));

// The guard itself must cover role changes and named additions, even when no
// source-word edge points at the new provider. Existing semantic sensitivity
// tests separately prove changed supplied/FM answers and cold disagreement.
const registry = (files, dependency = false) => {
  const reg = new core.Registry();
  for (const [name, raw] of Object.entries(files)) {
    const file = new core.MemoryFile(name, raw);
    if (dependency) reg.addDependency(file); else reg.addFile(file);
  }
  return reg;
};
const program = () => ({wanted: new Set(["Z"])});
const seed = (reg, root) => objectCache(reg, root).write("CLAS Z", {name: "Z", ir: {}}, [], program());
const hit = (reg, root) => objectCache(reg, root).read("CLAS Z", "Z", program());
test("dependency role and new named implementor/FM owner invalidate the global guard", () => scratch((dir) => {
  const intf = "INTERFACE zif_provider PUBLIC. METHODS work. ENDINTERFACE.";
  const files = {"z.clas.abap": classSource("Z"), "zif_provider.intf.abap": intf}, root = join(dir, "cache");
  seed(registry(files), root); assert.ok(hit(registry(files), root));
  assert.equal(hit(registry(files, true), root), undefined);
  assert.equal(hit(registry({...files,
    "zimpl.clas.abap": "CLASS zimpl DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_provider. ENDCLASS. CLASS zimpl IMPLEMENTATION. METHOD zif_provider~work. ENDMETHOD. ENDCLASS."}), root), undefined);
  const c = syntheticCorpus({classes: 4});
  const group = Object.fromEntries(Object.entries(c.files).filter(([n]) => n.startsWith("zoracle_group.fugr.")));
  seed(registry({...files, ...group}), root);
  assert.ok(hit(registry({...files, ...group}), root));
  const second = Object.fromEntries(Object.entries(group).map(([n, raw]) => [n.replaceAll("zoracle_group", "zzother_group"), raw.replaceAll("ZORACLE_GROUP", "ZZOTHER_GROUP").replaceAll("zoracle_group", "zzother_group")]));
  assert.equal(hit(registry({...files, ...group, ...second}), root), undefined);
}));

test("corrupt content certificate and missing payload refuse reuse without crashing", () => scratch((dir) => {
  writeFileSync(join(dir, "z.clas.abap"), classSource("Z"));
  build(dir); assert.equal(build(dir).frontendCounts.reused, 1);
  const root = join(dir, "cache"), version = readdirSync(root).find((n) => /^[a-f0-9]{64}$/.test(n));
  const file = join(root, version, readdirSync(join(root, version)).find((n) => n.endsWith(".bin")));
  const bytes = readFileSync(file), entry = deserialize(inflateRawSync(bytes.subarray(65)));
  // A valid envelope checksum cannot turn a damaged certificate into a hit.
  entry.key = "corrupt-content-certificate";
  const payload = deflateRawSync(serialize(entry));
  writeFileSync(file, Buffer.concat([Buffer.from(createHash("sha256").update(payload).digest("hex") + "\n"), payload]));
  const corrupt = build(dir);
  assert.equal(corrupt.frontendCounts.reused, 0); coldEqual(corrupt, dir);
  rmSync(file);
  const missing = build(dir);
  assert.equal(missing.frontendCounts.reused, 0); coldEqual(missing, dir);
}));

test("same-version tool content edit misses the real global guard in fresh processes", () => scratch((dir) => {
  cpSync(join(home, "tools"), join(dir, "tools"), {recursive: true});
  for (const name of ["package-lock.json", "libs.lock.json"]) cpSync(join(home, name), join(dir, name));
  symlinkSync(join(home, "node_modules"), join(dir, "node_modules"));
  const run = (write) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {objectCache} from ${JSON.stringify(pathToFileURL(join(dir, "tools/gogen/frontend-object-cache.mjs")).href)};
      const reg = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
      const cache = objectCache(reg, ${JSON.stringify(join(dir, "cache"))});
      const p = {wanted: new Set(['Z'])};
      if (${write}) cache.write('CLAS Z', {name: 'Z', ir: {}}, [], p);
      console.log(!!cache.read('CLAS Z', 'Z', p));
    `], {encoding: "utf8"});
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  assert.equal(run(true), "true"); assert.equal(run(false), "true");
  const file = join(dir, "tools/gogen/frontend-source-key.mjs"), before = statSync(file);
  writeFileSync(file, readFileSync(file, "utf8") + "\n// changed tool, same package version\n");
  utimesSync(file, before.atime, before.mtime);
  assert.equal(run(false), "false");
}));
