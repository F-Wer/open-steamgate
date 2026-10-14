import {expect} from "chai";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {registry, listening} from "./helpers/oci-registry.mjs";
import {build as layerBuild, pushSystem, validateLayer} from "../tools/osd-layer.mjs";
import {push, pushManifest, manifest, pull, sha256} from "../tools/osd-oci.mjs";
import {fetchSystem, main as fetchMain} from "../tools/osd-fetch.mjs";
import {activeSystem, LAYER_ID} from "../tools/osd-system.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";
import {inputFoldersOf, packsOf, dataDirsOf, ddicDirsOf, webappsOf, tilesOf, contentFoldersOf} from "../tools/osd-packs.mjs";
import {layers, libraryFiles, excludePatterns} from "../tools/osd-inputs.mjs";
import {hashOf, inputsOf} from "../tools/osd-build.mjs";
import {loadLibs, loadFiles} from "../tools/osd-transpile.mjs";
import {seedStatements} from "./seed.mjs";
import {abapgitXml, zipFiles} from "../tools/osd-abapgit-zip.mjs";
const write = (file, bytes) => { mkdirSync(join(file, ".."), {recursive: true}); writeFileSync(file, bytes); };
const json = (file, value) => write(file, JSON.stringify(value));
const rejects = async (fn, code) => { let e; try { await fn(); } catch (error) { e = error; } expect(e?.code, e?.message).to.equal(code); };

describe("osd-system: one digest supplies the system", function () {
  this.timeout(60000);
  let root, source, r, host, ref, env, cwd;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-system-"));
    source = join(root, "fixtures");
    cwd = process.cwd(); env = {...process.env};
    process.chdir(root);
    process.env.OSD_LEAK_IDENTIFIERS = join(root, "identifiers.json");
    json(process.env.OSD_LEAK_IDENTIFIERS, {test: ["forbidden_publish_identifier"]});
    delete process.env.OSD_SELF;
    r = registry(); host = await listening(r);
    write(join(source, "lib/.abapgit.xml"), abapgitXml());
    write(join(source, "lib/src/cl_lib.clas.abap"), "* library");
    write(join(source, "lib/src/skip/cl_skip.clas.abap"), "* excluded");
    write(join(source, "input/zcl_same.clas.abap"), "* original");
    write(join(source, "customer/zcl_same.clas.abap"), "* customer");
    for (const name of ["first", "last"]) {
      json(join(source, name, "osd-pack.json"), {name, order: name === "first" ? 999 : 0, tiles: [{title: name}]});
      write(join(source, name, "src/ddic/zrows.tabl.xml"), '<DD03P><FIELDNAME>text</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>8</LENG></DD03P>');
      json(join(source, name, "data/zrows.tabu.json"), [{text: name}]);
      write(join(source, name, "webapp/index.html"), name);
    }
    const refs = [];
    for (const [folder, name, kind] of [["lib", "lib", "lib"], ["input", "src", "input"], ["first", "first", "pack"], ["last", "last", "pack"], ["customer", "customer", "customer"]]) {
      const built = layerBuild(join(source, folder), {name, kind});
      const d = await push(`${host}/system/all:${name}`, built);
      refs.push(`${host}/system/all@${d}`);
    }
    const d = await pushSystem(`${host}/system/all:v1`, refs);
    ref = `${host}/system/all@${d}`;
    json(join(root, "abap_transpile.json"), {input_folder: ["src", "test", "gen"], output_folder: "output", libs: [{folder: "/.local/lars/lib", files: ["/src/**"], exclude_filter: ["/src/skip/"]}]});
  });
  afterEach(async () => {
    await new Promise(done => r.server.close(done));
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, {recursive: true, force: true});
  });

  it("fetches via CLI and resolves libraries as dependencies, inputs, packs, seed precedence and pages", async () => {
    process.env.OSD_ROOT = root;
    expect(await fetchMain(["--system", ref])).to.equal(0);
    const sys = activeSystem(root);
    expect(sys.digest).to.equal(ref.split("@")[1]);
    expect(sys.layers.map(l => l.kind)).to.deep.equal(["lib", "input", "pack", "pack", "customer"]);
    expect(libraryPath(root, "lib")).to.equal(join(root, ".local/system/libs/lib"));
    const config = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
    const folders = inputFoldersOf(root, config);
    expect(folders).to.deep.equal([".local/system/inputs/src/src", ".local/system/packs/first/src", ".local/system/packs/last/src", ".local/system/inputs/customer/src", "gen"]);
    expect(contentFoldersOf(root)).to.deep.equal(folders.slice(0, -1));
    const stack = layers(root, config);
    expect(stack.owner.get("CLAS ZCL_SAME")).to.equal(folders[3]);
    expect(stack.overridden.find(o => o.object === "CLAS ZCL_SAME").hidden).to.deep.equal([`${folders[0]}/zcl_same.clas.abap`]);
    expect(packsOf(root).map(p => p.name)).to.deep.equal(["first", "last"]);
    expect(dataDirsOf(root)).to.deep.equal(["first", "last"].map(n => join(root, ".local/system/packs", n, "data")));
    expect(ddicDirsOf(root)).to.include(join(root, ".local/system/packs/last/src/ddic"));
    expect(webappsOf(root).map(p => p.dir)).to.deep.equal(["first", "last"].map(n => join(root, ".local/system/packs", n, "webapp")));
    expect(tilesOf(root).map(t => t.title)).to.deep.equal(["first", "last"]);
    expect(seedStatements().join("\n")).to.include("'last    '").and.not.include("first");
    expect(libraryFiles(root, config)[0].files.map(f => f.split("/").at(-1))).to.deep.equal(["cl_lib.clas.abap"]);
    expect((await loadLibs(root, config)).map(f => f.filename)).to.deep.equal(["cl_lib.clas.abap"]);
    // The tree's own inputs and packs are ignored even when present.
    write(join(root, "src/zcl_wrong.clas.abap"), "* ignored");
    json(join(root, "packs/extra/osd-pack.json"), {name: "extra"});
    expect(layers(root, config).owner.has("CLAS ZCL_WRONG")).to.equal(false);
    expect(packsOf(root).length).to.equal(2);
    const compiled = await loadFiles(root, {...config, exclude_filter: excludePatterns(stack.hidden)}, {});
    expect(compiled.files.find(f => f.filename === "zcl_same.clas.abap").contents).to.equal("* customer");
    expect(compiled.files.some(f => f.filename === "zcl_wrong.clas.abap")).to.equal(false);
    expect(() => libraryPath(root, "absent")).to.throw(/does not provide library absent/);
  });

  it("refuses overrides and TMP, and checks installed layer identities", async () => {
    await fetchSystem(root, ref);
    for (const key of ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_LAYERS", "OSD_LIB_LIB"]) {
      expect(() => activeSystem(root, {[key]: ""})).to.throw(key);
      expect(() => inputFoldersOf(root, {}, {[key]: "value"})).to.throw(key);
    }
    mkdirSync(join(root, "local/tmp"), {recursive: true});
    expect(() => activeSystem(root, {OSD_TMP: "off"})).to.throw(/\$TMP/);
    rmSync(join(root, "local"), {recursive: true});
    json(join(root, ".local/system/libs/lib", LAYER_ID), {});
    expect(() => libraryPath(root, "lib")).to.throw(/identity differs/);
  });

  it("adds the index digest to content hashing", async () => {
    await fetchSystem(root, ref);
    const inputs = inputsOf(root), a = hashOf(root, inputs, {transpiler: "fixture"});
    expect(inputs.libs).to.deep.equal([join(root, ".local/system/libs/lib")]);
    const file = join(root, ".local/system/.osd-system.json"), system = activeSystem(root);
    system.digest = `sha256:${"a".repeat(64)}`; json(file, system);
    expect(hashOf(root, inputs, {transpiler: "fixture"})).not.to.equal(a);
  });

  for (const fault of ["gap", "tree", "canonical", "identity", "digest", "duplicate"]) it(`refuses ${fault} tampering without replacing the previous system`, async () => {
    await fetchSystem(root, ref);
    const previous = readFileSync(join(root, ".local/system/.osd-system.json"));
    const index = (await manifest(ref)).json;
    let code;
    if (fault === "gap") { index.manifests[1].annotations["org.osd.layer.order"] = "9"; code = "BAD_ORDER"; }
    else if (fault === "duplicate") { index.manifests[1] = {...index.manifests[0], annotations: {...index.manifests[0].annotations, "org.osd.layer.order": "1"}}; code = "BAD_SYSTEM"; }
    else if (fault === "digest") { r.tamperManifest = index.manifests[0].digest; code = "DIGEST_MISMATCH"; }
    else {
      const l = layerBuild(join(source, "lib"), {name: "lib", kind: "lib"});
      if (fault === "tree") { l.config.treeDigest = `sha256:${"0".repeat(64)}`; l.configBytes = Buffer.from(JSON.stringify(l.config)); l.manifest.config = {...l.manifest.config, digest: sha256(l.configBytes), size: l.configBytes.length}; code = "TREE_MISMATCH"; }
      if (fault === "canonical") { l.zip = zipFiles(l.files, {method: 8}); l.manifest.layers[0] = {...l.manifest.layers[0], digest: sha256(l.zip), size: l.zip.length}; code = "NOT_CANONICAL"; }
      l.manifestBytes = Buffer.from(JSON.stringify(l.manifest));
      const d = await push(`${host}/system/all:bad`, l);
      index.manifests[0] = {...index.manifests[0], digest: d, size: l.manifestBytes.length};
      if (fault === "identity") { index.manifests[0].annotations["org.osd.layer.name"] = "other"; code = "BAD_LAYER"; }
    }
    const d = await pushManifest(`${host}/system/all:bad-index`, Buffer.from(JSON.stringify(index)));
    await rejects(() => fetchSystem(root, `${host}/system/all@${d}`), code);
    expect(readFileSync(join(root, ".local/system/.osd-system.json"))).to.deep.equal(previous);
    expect(activeSystem(root).digest).to.equal(ref.split("@")[1]);
  });

  it("installs a local OCI layout by verified descriptors and refuses mutable tags", async () => {
    const index = await manifest(ref), base = join(root, "layout");
    write(join(base, "index.json"), index.bytes);
    for (const d of index.json.manifests) {
      const l = await pull(`${host}/system/all@${d.digest}`);
      for (const bytes of [l.manifest.bytes, l.configBytes, ...l.layers.map(l => l.bytes)]) write(join(base, "blobs/sha256", sha256(bytes).slice(7)), bytes);
    }
    expect((await fetchSystem(root, join(base, "index.json"))).digest).to.equal(index.digest);
    await rejects(() => fetchSystem(root, `${host}/system/all:v1`), "TAG_ONLY");
  });

  it("warns when the recorded OSG commit differs, while installing successfully", async () => {
    const index = (await manifest(ref)).json;
    index.annotations["org.osd.osg.commit"] = "0".repeat(40);
    const d = await pushManifest(`${host}/system/all:other-toolchain`, Buffer.from(JSON.stringify(index)));
    const logs = [];
    await fetchSystem(root, `${host}/system/all@${d}`, {log: line => logs.push(line)});
    expect(logs.some(line => /warning:.*records OSG.*running OSG/.test(line))).to.equal(true);
    expect(activeSystem(root).digest).to.equal(d);
  });

  it("preserves a library root even without abapGit metadata", () => {
    const l = layerBuild(join(source, "input"), {name: "lib", kind: "lib"});
    expect(l.files.map(f => f.path)).to.include("zcl_same.clas.abap").and.not.include("src/zcl_same.clas.abap");
  });

  it("keeps pack paths at the ZIP root and refuses unresolved sources and fetched identities", () => {
    const l = layerBuild(join(source, "first"), {name: "first", kind: "pack"});
    const files = validateLayer({manifest: {json: l.manifest}, config: l.config, layers: [{bytes: l.zip}]});
    expect(files.map(f => f.path)).to.include("osd-pack.json").and.include("data/zrows.tabu.json").and.include("webapp/index.html");
    json(join(source, "first/osd-pack.json"), {name: "first", abap: ["../../outside"]});
    expect(() => layerBuild(join(source, "first"), {name: "first", kind: "pack"})).to.throw(/escapes its layer/);
    json(join(source, "first/osd-pack.json"), {name: "first", sources: [{folder: "upstream"}]});
    expect(() => layerBuild(join(source, "first"), {name: "first", kind: "pack"})).to.throw(/resolved and stripped/);
    json(join(source, "first/upstream/.osd-source.json"), {});
    expect(() => layerBuild(join(source, "first"), {name: "first", kind: "pack"})).to.throw(/cannot be published/);
  });
});
