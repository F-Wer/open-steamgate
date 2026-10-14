import {expect} from "chai";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {execFileSync, spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {build, hashOf, liveHash, missingLibraries} from "../tools/osd-build.mjs";
import {transpile} from "../tools/osd-transpile.mjs";

// The builder over a tree of its own. What is cheap to check here is what
// it refuses before it does anything: a full generation takes the real
// transpiler and lives in test/osd-child.mjs and the workbench.
describe("tools/osd-build: the layers, refused before a lock is taken", function () {
  this.timeout(30000);
  let root;
  const write = (file, text = "") => {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-build-"));
    // the config loader is the transpiler's own, resolved from the tree
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "local/used"], output_folder: "output"}));
  });

  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it("compiles source without entering transient Git metadata", async () => {
    write("src/zmetadata.prog.abap", "REPORT zmetadata. WRITE 'ok'.\n");
    mkdirSync(join(root, "src/.git"));
    // A vanished metadata target must not abort discovery of real ABAP.
    symlinkSync(join(root, "removed-index-lock"), join(root, "src/.git/index.lock"));
    const config = {input_folder: ["src"], output_folder: "output", options: {unknownTypes: "compileError"}};
    const made = await transpile({root, config});
    expect(made.objects).to.equal(1);
    expect(readFileSync(join(root, "output/zmetadata.prog.mjs"), "utf8")).to.include("abap.statements.write");
  });

  it("CI restore verification accepts matching inputs and refuses a stale generation", async () => {
    write("src/zcl_archive.clas.abap", "CLASS zcl_archive DEFINITION PUBLIC. ENDCLASS. CLASS zcl_archive IMPLEMENTATION. ENDCLASS.\n");
    const built = await build({root, generators: false});
    const verify = () => spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "verify"], {cwd: root, encoding: "utf8"});
    const fresh = verify();
    expect(fresh.status, fresh.stdout + fresh.stderr).to.equal(0);
    expect(JSON.parse(fresh.stdout.split("generation: ")[1])).to.include({live: built.hash, tree: built.hash});
    write("src/zcl_archive.clas.abap", "* changed source\n");
    const stale = verify();
    expect(stale.status, stale.stdout + stale.stderr).to.equal(1);
    expect(liveHash(root)).to.equal(built.hash);
  });

  it("freezes identical compiler metadata across build locations and processes", async () => {
    write("src/zcl_frozen.clas.abap", "CLASS zcl_frozen DEFINITION PUBLIC. ENDCLASS. CLASS zcl_frozen IMPLEMENTATION. ENDCLASS.\n");
    const first = await build({root, generators: false});
    const frozen = readFileSync(join(root, "build", "by-input", first.hash, "compile-inputs.json"), "utf8");
    rmSync(join(root, "build"), {recursive: true, force: true});
    renameSync(root, `${root}-elsewhere`);
    root = `${root}-elsewhere`;
    const script = `import {build} from ${JSON.stringify(new URL("../tools/osd-build.mjs", import.meta.url).href)}; await build({root: process.cwd(), generators: false});`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {cwd: root});
    expect(readFileSync(join(root, "build", "by-input", first.hash, "compile-inputs.json"), "utf8")).to.equal(frozen);
    expect(JSON.parse(frozen).config.output_folder).to.equal("output");
  });

  // The builder starts a generator through tools/osd-host.mjs, which inside a
  // compiled binary becomes "osd gen <name>" and is answered from a map in
  // bin/osd.mjs. A generator the build runs and the map does not know exits
  // 2 there and nowhere else, so the two lists are compared rather than
  // remembered: osd-fm-registry.mjs had been missing from the map since it
  // was added, and no test would have said so.
  it("hands the binary every generator the build runs", () => {
    const named = (file, re) => [...readFileSync(file, "utf8").matchAll(re)].map((m) => m[1]);
    const runs = named("tools/osd-build.mjs", /^\s*\["([a-z0-9-]+\.mjs)"/gm);
    const known = named("bin/osd.mjs", /"([a-z0-9-]+\.mjs)": \(\) => import/g);
    expect(runs.length, "the build runs generators").to.be.greaterThan(5);
    expect(runs.filter((one) => known.includes(one) === false)).to.deep.equal([]);
  });

  it("renames a generation when a BSP page changes, including JavaScript", () => {
    write("src/bsp/apps.json", JSON.stringify({ZOSD_TAXI_ANAL: {folder: "webapp/taxi"}}));
    write("webapp/taxi/Component.js", "first");
    const first = hashOf(root);
    write("webapp/taxi/Component.js", "second");
    expect(hashOf(root)).not.to.equal(first);
  });

  it("hashes library content reached through a symlinked directory", () => {
    write("src/zcl_one.clas.abap", "");
    write("library-source/src/if_library.intf.abap", "INTERFACE if_library. ENDINTERFACE.\n");
    mkdirSync(join(root, ".local/lars/library"), {recursive: true});
    symlinkSync(join(root, "library-source", "src"), join(root, ".local/lars/library/src"), "dir");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: ["src"],
      output_folder: "output",
      libs: [{folder: "/.local/lars/library"}],
    }));
    const first = hashOf(root);
    write("library-source/src/if_library.intf.abap", "INTERFACE if_library. CONSTANTS changed TYPE abap_bool VALUE abap_true. ENDINTERFACE.\n");
    expect(hashOf(root)).not.to.equal(first);
  });

  it("refuses a name twice inside one input, naming both files, and builds nothing", async () => {
    write("src/a/zcl_two.clas.abap", "");
    write("src/b/zcl_two.clas.abap", "");
    let refused;
    try {
      await build({root});
    } catch (error) {
      refused = error;
    }
    expect(refused?.code).to.equal("DUPLICATE");
    expect(refused.message).to.contain("src/a/zcl_two.clas.abap, src/b/zcl_two.clas.abap");
    expect(refused.duplicates).to.deep.equal([{object: "CLAS ZCL_TWO", folder: "src", files: ["src/a/zcl_two.clas.abap", "src/b/zcl_two.clas.abap"]}]);
    // nothing was started: no lock, no tmp, no generation
    expect(existsSync(join(root, "build"))).to.equal(false);
  });

  it("refuses a pack whose declared source is not fetched, and builds nothing", async () => {
    write("src/zcl_one.clas.abap", "");
    write("packs/theirs/osd-pack.json", JSON.stringify({sources: [{folder: "upstream", repo: "https://example.invalid/theirs", ref: "abcdef0123456789", path: "src"}]}));
    let refused;
    try {
      await build({root});
    } catch (error) {
      refused = error;
    }
    expect(refused?.code).to.equal("UNFETCHED");
    expect(refused.message).to.contain("pack theirs fetches upstream from https://example.invalid/theirs at abcdef012345");
    expect(refused.message).to.contain("node tools/osd-fetch.mjs");
    expect(existsSync(join(root, "build"))).to.equal(false);
  });

  it("refuses an incomplete library closure and leaves the live generation untouched", async () => {
    write("src/zcl_one.clas.abap", "");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: ["src"],
      output_folder: "output",
      libs: [{
        url: "https://github.com/open-abap/open-abap-core",
        folder: "/.local/lars/open-abap-core",
      }],
    }));
    write("build/by-input/known-good/output/init.mjs", "export const good = true;\n");
    symlinkSync(join("by-input", "known-good"), join(root, "build", "live"));

    expect(missingLibraries(root)).to.deep.equal([{
      url: "https://github.com/open-abap/open-abap-core",
      folder: "/.local/lars/open-abap-core",
    }]);
    let refused;
    try {
      await build({root});
    } catch (error) {
      refused = error;
    }
    expect(refused?.code).to.equal("MISSING_LIBRARIES");
    expect(refused.message).to.contain("npm run osd:worktree");
    expect(readlinkSync(join(root, "build", "live"))).to.equal(join("by-input", "known-good"));
    expect(existsSync(join(root, "build", ".lock"))).to.equal(false);
    expect(existsSync(join(root, "build", "tmp"))).to.equal(false);
  });

  // N3: the transpile is a library call. The CLI is the oracle, run over the
  // same tree into a folder of its own, and the two outputs are compared
  // file by file. The CLI now groups project objects in project/, whereas
  // OSG keeps its flat module layout. Resolve map sources and normalize only
  // those module paths and the transpiler temporary counter before comparing.
  it("matches CLI code and source mappings across output layouts", async function () {
    this.timeout(120000);
    const CLASS = (name, method) => `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS ${method}.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\n  METHOD ${method}.\n  ENDMETHOD.\nENDCLASS.\n`;
    write("src/zcl_one.clas.abap", CLASS("zcl_one", "first"));
    write("src/zcl_one.clas.xml", "");
    write("src/zosd_report.prog.abap", "REPORT zosd_report.\nWRITE 'hi'.\n");
    write("local/used/zcl_two.clas.abap", CLASS("zcl_two", "second"));
    const config = {input_folder: ["src", "local/used"], output_folder: "output-cli", write_unit_tests: true, write_source_map: true,
                    options: {addFilenames: true, addCommonJS: true, unknownTypes: "compileError"}};
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify(config));
    const cli = process.env.OSD_TEST_TRANSPILE_CLI ? resolve(process.env.OSD_TEST_TRANSPILE_CLI) : join(root, "node_modules", ".bin", "abap_transpile");
    execFileSync(process.execPath, [cli], {cwd: root, stdio: "pipe"});
    const made = await transpile({root, config: {...config, output_folder: "output-lib"}});
    expect(made.objects).to.equal(3);
    const list = (dir) => readdirSync(join(root, dir), {recursive: true, withFileTypes: true})
      .filter(entry => entry.isFile())
      .map(entry => relative(join(root, dir), join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort();
    const flat = name => name.replace(/^project\//, "");
    expect(list("output-lib")).to.deep.equal(list("output-cli").map(flat).sort());
    const norm = (dir, name) => {
      const file = join(root, dir, name);
      const text = readFileSync(file, "utf8");
      if (name.endsWith(".map")) {
        const map = JSON.parse(text);
        map.sources = map.sources.map(source => resolve(dirname(file), decodeURIComponent(source)));
        const sourceText = map.sources.map(source => readFileSync(source, "utf8"));
        // CLI embeds source text; OSG maps point at the checkout's files.
        if (dir === "output-cli") expect(map.sourcesContent).to.be.an("array");
        if (dir === "output-cli" || map.sourcesContent) expect(map.sourcesContent).to.deep.equal(sourceText);
        delete map.sourcesContent;
        return map;
      }
      return text.replace(/unique\d+/g, "uniqueN")
        .replace(/"\.\/project\//g, '"./').replace(/"\.\.\/_init\.mjs"/g, '"./_init.mjs"');
    };
    for (const name of list("output-cli")) {
      expect(norm("output-lib", flat(name)), name).to.deep.equal(norm("output-cli", name));
    }
    // and the map names its source the way the CLI names it, relative to the output
    expect(readFileSync(join(root, "output-lib", "zcl_one.clas.mjs.map"), "utf8")).to.contain("../src/zcl_one.clas.abap");
  });
});

// Windows: a symlink to a directory needs an administrator or Developer Mode
// there, a junction needs neither, so build/live, output/ and a generation's
// roots are junctions on Windows (tools/osd-build.mjs linkDir). A junction's
// target is absolute; OSD_DIR_LINK=junction takes that form here too, so the
// path Windows takes is the path this test takes.
describe("tools/osd-build: the links a generation is reached through, as junctions", function () {
  this.timeout(120000);
  let root;
  let previous;
  const clas = (n) => `CLASS zcl_junction DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    CLASS-METHODS n RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_junction IMPLEMENTATION.\n  METHOD n.\n    rv = ${n}.\n  ENDMETHOD.\nENDCLASS.\n`;

  before(() => {
    previous = process.env.OSD_DIR_LINK;
    process.env.OSD_DIR_LINK = "junction";
    root = realpathSync(mkdtempSync(join(tmpdir(), "osd-junction-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "zcl_junction.clas.abap"), clas(1));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: "src", input_filter: [], output_folder: "output", libs: [], write_unit_tests: true,
      options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
    }));
    writeFileSync(join(root, "package.json"), "{}");
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  });
  after(() => {
    if (previous === undefined) delete process.env.OSD_DIR_LINK;
    else process.env.OSD_DIR_LINK = previous;
    rmSync(root, {recursive: true, force: true});
  });

  it("builds, switches and resolves through absolute links", async () => {
    const first = await build({root, generators: false});
    const live = readlinkSync(join(root, "build", "live"));
    expect(live.startsWith("/"), live).to.equal(true);
    expect(live.endsWith(join("by-input", first.hash))).to.equal(true);
    expect(liveHash(root)).to.equal(first.hash);
    expect(readlinkSync(join(root, "output")).startsWith("/")).to.equal(true);
    expect(readFileSync(join(root, "output", "zcl_junction.clas.mjs"), "utf8")).to.include("IntegerFactory.get(1)");

    writeFileSync(join(root, "src", "zcl_junction.clas.abap"), clas(2));
    const second = await build({root, generators: false});
    expect(second.hash).to.not.equal(first.hash);
    expect(liveHash(root)).to.equal(second.hash);
    expect(readFileSync(join(root, "output", "zcl_junction.clas.mjs"), "utf8")).to.include("IntegerFactory.get(2)");
  });

  it("reads the live generation off a link with a trailing separator, as a junction reads back", () => {
    const at = join(root, "build", "live");
    rmSync(at);
    symlinkSync(join(root, "build", "by-input", "abc123") + "/", at);
    expect(liveHash(root)).to.equal("abc123");
  });
});
