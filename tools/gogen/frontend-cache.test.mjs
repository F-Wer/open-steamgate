import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {frontendInputs, readFrontendCache, writeFrontendCache} from "./frontend-cache.mjs";

test("every input category changes the frontend key", () => {
  const home = mkdtempSync(join(tmpdir(), "gogen-cache-key-"));
  const fixture = join(home, "src");
  const files = ["src/example.clas.abap", "src/example.clas.testclasses.abap", "src/example.tabl.xml",
    "tools/gogen/frontend.mjs", "tools/gogen/frontend-local-constants.mjs", "tools/gogen/emit-local-constants.mjs", "tools/gogen/emit-go.mjs", "tools/gogen/go/abap/abap.go",
    "tools/osd-amc.mjs", "test/seed.mjs", "data/rows.tabu.json", "packs/example/data/rows.tabu.json",
    "abap_transpile.json", "package-lock.json", "libs.lock.json"];
  // Pack discovery reads this configuration as JSON before hashing it.
  const content = (file, value) => file === "abap_transpile.json"
    ? JSON.stringify({input_folder: ["src"], value}) : value;
  try {
    for (const file of files) {
      mkdirSync(join(home, file, ".."), {recursive: true});
      writeFileSync(join(home, file), content(file, "first"));
    }
    const options = {home, folders: [fixture], owners: ["EXAMPLE"], fixture: true, unlayered: false};
    const key = () => frontendInputs(options).key;
    const baseline = key();
    for (const file of files) {
      writeFileSync(join(home, file), content(file, "changed"));
      assert.notEqual(key(), baseline, file);
      writeFileSync(join(home, file), content(file, "first"));
    }
    writeFileSync(join(fixture, "new.clas.abap"), "new");
    assert.notEqual(key(), baseline, "new registry object");
    assert.notEqual(frontendInputs({...options, owners: ["OTHER"]}).key, key(), "selection");
    assert.notEqual(frontendInputs({...options, folders: [fixture, join(home, "other")]}).key, key(), "layer order");
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test("external pack seed and DDIC edits invalidate the frontend snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "gogen-cache-pack-"));
  const external = mkdtempSync(join(tmpdir(), "gogen-external-pack-"));
  try {
    const data = join(external, "data", "rows.tabu.json");
    const ddic = join(external, "src", "ddic", "zrows.tabl.xml");
    mkdirSync(join(external, "data"));
    mkdirSync(join(external, "src", "ddic"), {recursive: true});
    writeFileSync(join(external, "osd-pack.json"), JSON.stringify({name: "external"}));
    writeFileSync(data, "first row");
    writeFileSync(ddic, "first definition");
    const options = {home, folders: [], owners: [], fixture: false, unlayered: false,
      env: {OSD_PACKS: external}};
    const initial = frontendInputs(options);
    assert.ok(initial.files.includes(data));
    assert.ok(initial.files.includes(ddic));
    const cacheRoot = join(home, "cache");
    const go = join(home, "go");
    mkdirSync(join(go, "cmd", "unit"), {recursive: true});
    writeFileSync(join(go, "cmd", "unit", "zz_generated.go"), "package main\n");
    writeFrontendCache(cacheRoot, initial.key, go, {rows: [], layers: {}});
    writeFileSync(data, "changed row");
    const changedSeedKey = frontendInputs(options).key;
    assert.notEqual(changedSeedKey, initial.key, "seed row");
    assert.equal(readFrontendCache(cacheRoot, changedSeedKey, join(home, "copy")), null, "changed row misses snapshot");
    writeFileSync(data, "first row");
    writeFileSync(ddic, "changed definition");
    assert.notEqual(frontendInputs(options).key, initial.key, "DDIC definition");
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(external, {recursive: true, force: true});
  }
});

test("effective emission flag changes the frontend key", () => {
  const home = mkdtempSync(join(tmpdir(), "gogen-cache-env-"));
  try {
    const options = {home, folders: [], owners: [], fixture: false, unlayered: false};
    const key = (GOGEN_NOLINE) => frontendInputs({...options, env: {GOGEN_NOLINE}}).key;
    assert.equal(key(undefined), key(""), "both enable line emission");
    assert.notEqual(key(undefined), key("1"), "suppressed line emission");
    assert.equal(key("1"), key("yes"), "both suppress line emission");
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test("resolved abaplint package overrides change the frontend key", () => {
  const home = mkdtempSync(join(tmpdir(), "gogen-cache-toolchain-"));
  try {
    const options = {home, folders: [], owners: [], fixture: false, unlayered: false, env: {}};
    const fakeRequire = (variant) => {
      const project = join(home, variant);
      const transpiler = join(project, "node_modules", "@abaplint", "transpiler");
      const core = join(transpiler, "node_modules", "@abaplint", "core");
      mkdirSync(core, {recursive: true});
      writeFileSync(join(transpiler, "package.json"), JSON.stringify({version: "1.0.0"}));
      writeFileSync(join(core, "package.json"), JSON.stringify({version: "1.0.0"}));
      return createRequire(join(project, "frontend.mjs"));
    };
    const firstRequire = fakeRequire("first");
    const first = frontendInputs({...options, toolchainRequire: firstRequire}).key;
    const override = frontendInputs({...options, toolchainRequire: fakeRequire("override")}).key;
    assert.notEqual(override, first, "same versions from different resolved directories");
    const transpiler = join(home, "first", "node_modules", "@abaplint", "transpiler");
    writeFileSync(join(transpiler, "package.json"), JSON.stringify({version: "2.0.0"}));
    assert.notEqual(frontendInputs({...options, toolchainRequire: firstRequire}).key, first, "transpiler version");
    writeFileSync(join(transpiler, "package.json"), JSON.stringify({version: "1.0.0"}));
    writeFileSync(join(transpiler, "node_modules", "@abaplint", "core", "package.json"), JSON.stringify({version: "2.0.0"}));
    assert.notEqual(frontendInputs({...options, toolchainRequire: firstRequire}).key, first, "core version");
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test("touching build code in a local abaplint override misses the snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "gogen-cache-build-"));
  try {
    const transpiler = join(home, "node_modules", "@abaplint", "transpiler");
    const core = join(transpiler, "node_modules", "@abaplint", "core");
    for (const dir of [transpiler, core]) {
      mkdirSync(join(dir, "build"), {recursive: true});
      writeFileSync(join(dir, "package.json"), JSON.stringify({version: "1.0.0"}));
      writeFileSync(join(dir, "build", "index.js"), "module.exports = 1;");
    }
    // Each build runs in a fresh process, as unit.mjs does. The fingerprint
    // is memoized only while that process's loaded toolchain is in use.
    const script = `import {createRequire} from "node:module";
      import {join} from "node:path";
      import {frontendInputs} from ${JSON.stringify(new URL("./frontend-cache.mjs", import.meta.url).href)};
      const home = process.argv[1];
      process.stdout.write(frontendInputs({home, folders: [], owners: [], fixture: false,
        unlayered: false, env: {}, toolchainRequire: createRequire(join(home, "frontend.mjs"))}).key);`;
    const key = () => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, home], {encoding: "utf8"});
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    let current = key();
    const cacheRoot = join(home, "cache");
    const go = join(home, "go");
    mkdirSync(join(go, "cmd", "unit"), {recursive: true});
    writeFileSync(join(go, "cmd", "unit", "zz_generated.go"), "package main\n");
    for (const dir of [transpiler, core]) {
      writeFrontendCache(cacheRoot, current, go, {});
      const file = join(dir, "build", "index.js");
      utimesSync(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
      const changed = key();
      assert.notEqual(changed, current, `${dir} build edit`);
      assert.equal(readFrontendCache(cacheRoot, changed, join(home, "copy")), null);
      current = changed;
    }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test("a snapshot is complete before it can be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-cache-atomic-"));
  try {
    const go = join(dir, "go");
    mkdirSync(join(go, "cmd", "unit"), {recursive: true});
    writeFileSync(join(go, "cmd", "unit", "zz_generated.go"), "package main\n");
    const root = join(dir, "cache");
    assert.equal(readFrontendCache(root, "key", join(dir, "copy")), null);
    writeFrontendCache(root, "key", go, {rows: [{status: "READY"}], layers: {}});
    writeFrontendCache(root, "key", go, {rows: [], layers: {}});
    assert.deepEqual(readFrontendCache(root, "key", join(dir, "copy")).rows, [{status: "READY"}]);
    assert.equal(readFileSync(join(dir, "copy", "cmd", "unit", "zz_generated.go"), "utf8"), "package main\n");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
