import {expect} from "chai";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SOURCE, isSourceIdentity, BadPack, contentFoldersOf, dataDirsOf, ddicDirsOf, generatorFoldersOf, inputFoldersOf, packAt, packRootsOf, packsOf, webappsOf} from "../tools/osd-packs.mjs";
import {ObjectStore, rootsOf} from "../tools/osd-store.mjs";
import {loadConfig} from "../tools/osd-build.mjs";
import {generate as generateBsp, packApplications, packApps} from "../tools/osd-bsp-registry.mjs";
import {packNodes} from "../tools/osd-nodes.mjs";
import {SOURCE as leafSource, isSourceIdentity as leafIdentity} from "../tools/osd-source-identity.mjs";

// A pack is a directory, not a rebuild (backlog E.2): ABAP, seed rows, a
// page and a manifest naming it, found at start and layered after the tree's
// own folders. Nothing here is compiled in, so these tests build packs on
// disk and ask what OSD makes of them.
describe("tools/osd-packs: a pack is a directory", () => {
  it("shares the pure source identity predicate with the frontend", () => {
    expect(SOURCE).to.equal(leafSource).and.to.equal(".osd-source.json");
    expect(isSourceIdentity).to.equal(leafIdentity);
    for (const [file, expected] of [[SOURCE, true], [join("folder", SOURCE), true],
      [".OSD-SOURCE.JSON", false], ["object.clas.xml", false], [SOURCE + ".bak", false]]) {
      expect(leafIdentity(file), file).to.equal(expected);
    }
  });

  let root;
  let outside;
  const write = (file, text = "") => {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), text);
  };
  const CLASS = (name) => `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS.\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-packs-"));
    outside = mkdtempSync(join(tmpdir(), "osd-elsewhere-"));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "gen"]}));
    write("src/zcl_ours.clas.abap", CLASS("zcl_ours"));
    write("packs/vibes/osd-pack.json", JSON.stringify({description: "the worked example"}));
    write("packs/vibes/src/zcl_theirs.clas.abap", CLASS("zcl_theirs"));
    write("packs/vibes/src/ddic/ztheirs.tabl.xml", "<abapGit/>");
    write("packs/vibes/data/ztheirs.tabu.json", "[]");
    write("packs/vibes/webapp/index.html", "<h1>hello</h1>");
    write("packs/notapack/src/zcl_ignored.clas.abap", CLASS("zcl_ignored"));
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
    rmSync(outside, {recursive: true, force: true});
  });

  it("refuses a source without a folder or a repository, naming the manifest", () => {
    write("packs/half/osd-pack.json", JSON.stringify({sources: [{repo: "https://example.invalid/x"}]}));
    expect(() => packsOf(root, {})).to.throw(BadPack, "a source needs a folder and either a repo or a libs.lock.json library name");
  });

  it("refuses source folders that can escape the pack", () => {
    for (const folder of ["../outside", "..\\outside", "..", "/outside"]) {
      write("packs/half/osd-pack.json", JSON.stringify({sources: [{folder, repo: "https://example.invalid/x"}]}));
      expect(() => packsOf(root, {}), folder).to.throw(BadPack, /source folder must be a single directory name/);
    }
  });

  it("reads a directory with a manifest, and takes its name and its folders from what is there", () => {
    const packs = packsOf(root, {});
    expect(packs.map((p) => p.name)).to.deep.equal(["vibes"]);
    const [pack] = packs;
    expect(pack.description).to.equal("the worked example");
    expect(pack.package, "a pack is a package of its own").to.equal("$VIBES");
    expect(pack.order).to.equal(100);
    expect(pack.abap.map((f) => f.endsWith(join("packs", "vibes", "src")))).to.deep.equal([true]);
    expect(pack.data.endsWith(join("packs", "vibes", "data"))).to.equal(true);
    expect(pack.webapp.endsWith(join("packs", "vibes", "webapp"))).to.equal(true);
    expect(pack.ddic.endsWith(join("src", "ddic"))).to.equal(true);
  });

  it("a directory with no manifest is not a pack, however much it looks like one", () => {
    expect(packAt(root, join(root, "packs", "notapack"))).to.equal(undefined);
    expect(packsOf(root, {}).map((p) => p.name)).to.not.include("notapack");
  });

  it("a manifest that will not parse says which file and why", () => {
    writeFileSync(join(root, "packs", "vibes", "osd-pack.json"), "{not json");
    expect(() => packsOf(root, {})).to.throw(BadPack).with.property("code", "BAD_PACK");
  });

  it("layers packs after source but before generated rewrites", () => {
    const config = {input_folder: ["src", "gen"]};
    const folders = inputFoldersOf(root, config, {});
    expect(folders).to.have.length(3);
    expect(folders[0]).to.equal("src");
    expect(folders[1].split("/").slice(-3).join("/")).to.equal("packs/vibes/src");
    expect(folders[2]).to.equal("gen");
  });

  it("gives the store the build's exact root order, including user layers", () => {
    write("user/zcl_ours.clas.abap", CLASS("zcl_ours"));
    const env = {OSD_LAYERS: "user"};
    const config = {input_folder: ["src", "gen"]};
    expect(rootsOf(root, env).map((entry) => entry.path)).to.deep.equal(inputFoldersOf(root, config, env));
    expect(rootsOf(root, env).at(-1)).to.include({path: "user", writable: true, library: false});
  });

  it("gives the store shared roots for scalar and empty input_folder values", () => {
    for (const input_folder of ["src", []]) {
      const config = {input_folder};
      writeFileSync(join(root, "abap_transpile.json"), JSON.stringify(config));
      const env = {OSD_LAYERS: "user"};
      expect(rootsOf(root, env).map((entry) => entry.path)).to.deep.equal(inputFoldersOf(root, config, env));
    }
  });

  it("uses the build fallback and shared pack and user order with no config file", () => {
    rmSync(join(root, "abap_transpile.json"));
    const env = {OSD_LAYERS: "user"};
    const fallback = loadConfig(root);
    expect(fallback.input_folder).to.equal("src");
    expect(rootsOf(root, env).map((entry) => entry.path)).to.deep.equal(inputFoldersOf(root, fallback, env));
    expect(rootsOf(root, env).map((entry) => entry.path)).to.deep.equal(["src", "packs/vibes/src", "user"]);
  });

  it("derives BSP apps and host nodes from packsOf, including a direct pack path", () => {
    const direct = join(outside, "direct");
    mkdirSync(join(direct, "webapp"), {recursive: true});
    writeFileSync(join(direct, "osd-pack.json"), JSON.stringify({name: "direct", order: 1}));
    writeFileSync(join(direct, "webapp", "index.html"), "direct page");
    const env = {OSD_PACKS: direct};
    expect(packApps(root, env).map((app) => app.app)).to.deep.equal(["ZDIRECT", "ZVIBES"]);
    expect(packApps(root, env)[0].pages[0].content.toString()).to.equal("direct page");
    expect(packNodes(root, env).map((node) => node.path)).to.deep.equal(["/app/direct", "/app/vibes"]);
  });

  it("rebases each pack OData source in the generated BSP manifest page", () => {
    write("packs/vibes/webapp/manifest.json", JSON.stringify({"sap.app": {dataSources: {
      first: {type: "OData", uri: "../../sap/opu/odata/sap/FIRST_SRV/"},
      second: {type: "OData", uri: "/sap/opu/odata/sap/SECOND_SRV/"},
      annotation: {type: "ODataAnnotation", uri: "/sap/opu/odata/sap/ANNO_SRV/"},
      unnamed: {type: "OData", uri: "../../sap/opu/odata/sap/"},
    }}}));
    const page = packApps(root, {}).find((app) => app.app === "ZVIBES").pages.find((item) => item.page === "manifest.json");
    const sources = JSON.parse(page.content.toString("utf8"))["sap.app"].dataSources;
    expect(sources.first.uri).to.equal("../../../../opu/odata/sap/FIRST_SRV/");
    expect(sources.second.uri).to.equal("../../../../opu/odata/sap/SECOND_SRV/");
    expect(sources.annotation.uri).to.equal("/sap/opu/odata/sap/ANNO_SRV/");
    expect(sources.unnamed.uri).to.equal("../../sap/opu/odata/sap/");
  });

  it("hands the launchpad each intent a pack app declares, pointed at its BSP application", () => {
    write("packs/vibes/webapp/manifest.json", JSON.stringify({"sap.app": {
      id: "osd.vibes", title: "Vibes",
      crossNavigation: {inbounds: {
        show: {semanticObject: "Vibe", action: "display"},
        edit: {semanticObject: "Vibe", action: "manage", title: "Edit vibes"},
        localized: {semanticObject: "Vibe", action: "translate", title: "{{appTitle}}"},
        broken: {semanticObject: "Vibe"},
        dashed: {semanticObject: "Vibe-Pack", action: "display"},
        wildcard: {semanticObject: "*", action: "display"},
      }},
    }}));
    expect(packApps(root, {}).map((app) => app.app), "the url names the BSP application packApps serves").to.include("ZVIBES");
    write("packs/garbled/osd-pack.json", JSON.stringify({}));
    write("packs/garbled/webapp/manifest.json", "{ not json");
    write("packs/noid/osd-pack.json", JSON.stringify({}));
    write("packs/noid/webapp/manifest.json", JSON.stringify({"sap.app": {crossNavigation: {inbounds: {x: {semanticObject: "No", action: "id"}}}}}));
    write("packs/plain/osd-pack.json", JSON.stringify({}));
    write("packs/plain/webapp/index.html", "no manifest");

    const apps = packApplications(root, {});
    expect(Object.keys(apps).sort(), "no action, a dash, a wildcard, no app id, no manifest, bad JSON: nothing").to.deep.equal(["Vibe-display", "Vibe-manage", "Vibe-translate"]);
    expect(apps["Vibe-display"]).to.deep.equal({
      title: "Vibes",
      description: "pack vibes",
      additionalInformation: "SAPUI5.Component=osd.vibes",
      applicationType: "URL",
      url: "../sap/bc/ui5_ui5/sap/zvibes/",
      navigationMode: "embedded",
    });
    expect(apps["Vibe-manage"].title).to.equal("Edit vibes");
    expect(apps["Vibe-translate"].title, "an i18n placeholder is not a title").to.equal("Vibes");
  });

  it("refuses two webapp packs whose names collide at the BSP 15 character limit", () => {
    write("packs/first/osd-pack.json", JSON.stringify({name: "long-workspace-one"}));
    write("packs/first/webapp/index.html", "first");
    write("packs/second/osd-pack.json", JSON.stringify({name: "long-workspace-two"}));
    write("packs/second/webapp/index.html", "second");
    expect(() => packApps(root, {})).to.throw(/packs long-workspace-one and long-workspace-two both derive the BSP application name ZLONG_WORKSPACE/);
  });

  it("lets a declared app in a later layer override a derived pack app", () => {
    write("src/bsp/apps.json", JSON.stringify({ZVIBES: {folder: join(root, "webapp")}}));
    write("webapp/index.html", "base");
    const apps = generateBsp([join(root, "src")], join(root, "gen", "bsp"), root);
    expect(apps.find((app) => app.app === "ZVIBES").pages[0].content.toString()).to.equal("base");
  });

  it("orders by the manifest, then by name", () => {
    write("packs/early/osd-pack.json", JSON.stringify({order: 10}));
    write("packs/early/src/zcl_early.clas.abap", CLASS("zcl_early"));
    write("packs/also/osd-pack.json", JSON.stringify({}));
    write("packs/also/src/zcl_also.clas.abap", CLASS("zcl_also"));
    expect(packsOf(root, {}).map((p) => p.name)).to.deep.equal(["early", "also", "vibes"]);
  });

  it("selects only requested web packs across the build inputs", () => {
    write("packs/early/osd-pack.json", JSON.stringify({order: 10}));
    write("packs/early/src/zcl_early.clas.abap", CLASS("zcl_early"));
    expect(packsOf(root, {OSD_WEB_PACKS: ""})).to.deep.equal([]);
    expect(packsOf(root, {OSD_WEB_PACKS: "vibes"}).map((pack) => pack.name)).to.deep.equal(["vibes"]);
    expect(inputFoldersOf(root, {input_folder: ["src", "gen"]}, {OSD_WEB_PACKS: "vibes"}))
      .to.deep.equal(["src", "packs/vibes/src", "gen"]);
    expect(dataDirsOf(root, {OSD_WEB_PACKS: ""})).to.deep.equal([]);
    expect(packsOf(root, {OSD_WEB_PACKS: "all"}).map((pack) => pack.name)).to.deep.equal(["early", "vibes"]);
  });

  it("finds a pack outside the tree, named on its own or by the directory that holds it", () => {
    mkdirSync(join(outside, "away", "src"), {recursive: true});
    writeFileSync(join(outside, "away", "osd-pack.json"), JSON.stringify({name: "away"}));
    writeFileSync(join(outside, "away", "src", "zcl_away.clas.abap"), CLASS("zcl_away"));
    expect(packsOf(root, {OSD_PACKS: join(outside, "away")}).map((p) => p.name)).to.deep.equal(["away", "vibes"]);
    expect(packsOf(root, {OSD_PACKS: outside}).map((p) => p.name)).to.deep.equal(["away", "vibes"]);
    // the same pack reached two ways is one pack
    expect(packsOf(root, {OSD_PACKS: `${outside}:${join(outside, "away")}`}).map((p) => p.name)).to.deep.equal(["away", "vibes"]);
  });

  it("refuses two different directories with the same pack name", () => {
    write("packs/other/osd-pack.json", JSON.stringify({name: "vibes"}));
    expect(() => packsOf(root, {})).to.throw(BadPack, /pack name vibes is also used by/);
  });

  it("brings its seed rows, its table definitions and its page", () => {
    expect(dataDirsOf(root, {}).map((d) => d.split("/").slice(-2).join("/"))).to.deep.equal(["vibes/data"]);
    expect(ddicDirsOf(root, {}).some((d) => d.includes(join("packs", "vibes")))).to.equal(true);
    expect(webappsOf(root, {})).to.have.length(1);
    expect(webappsOf(root, {})[0].name).to.equal("vibes");
  });

  it("carries FLP tile types, live-number settings and availability without interpreting them", () => {
    write("packs/vibes/osd-pack.json", JSON.stringify({tiles: [
      {id: "live", type: "dynamic", title: "Live rows", serviceUrl: "/tile/count", serviceRefreshInterval: 30, numberUnit: "rows"},
      {id: "picture", type: "image", imageSource: "/tile/image.png"},
      {id: "hana", requires: "HDB", enabled: false, disabledReason: "needs HANA"}
    ]}));
    const tiles = packsOf(root, {})[0].tiles;
    expect(tiles[0]).to.include({type: "dynamic", serviceUrl: "/tile/count", serviceRefreshInterval: "30", numberUnit: "rows"});
    expect(tiles[1]).to.include({type: "image", imageSource: "/tile/image.png"});
    expect(tiles[2]).to.include({type: "static", requires: "HDB", enabled: false, disabledReason: "needs HANA"});
  });

  it("a generator reads content, not every layer: the tree's src and each pack", () => {
    const folders = contentFoldersOf(root, {});
    expect(folders[0]).to.equal("src");
    expect(folders).to.have.length(2);
    expect(folders[1].endsWith("packs/vibes/src")).to.equal(true);
  });

  it("projects configured inputs, imports, packs, gen, then user layers", () => {
    write("imported/zcl_imported.clas.abap", CLASS("zcl_imported"));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "imported", "test", "gen"]}));
    mkdirSync(join(root, "user"));
    expect(generatorFoldersOf(root, {OSD_LAYERS: "user"})).to.deep.equal([
      "src", "imported", "packs/vibes/src", "gen", "user",
    ]);
  });

  it("the object store shows a pack's objects, in the pack's own package", () => {
    const store = new ObjectStore({root, libs: []});
    const entry = store.find("CLAS", "ZCL_THEIRS");
    expect(entry, "the pack's class is an object of the system").to.not.equal(undefined);
    expect(entry.package).to.equal("$VIBES");
    expect(entry.writable).to.equal(true);
    expect(store.rootPackages().map((p) => p.name)).to.include("$VIBES");
    expect(store.find("CLAS", "ZCL_IGNORED"), "a folder without a manifest is in nobody's tree").to.equal(undefined);
  });

  it("the roots a pack adds carry the package, so nothing guesses it from the folder name", () => {
    const roots = packRootsOf(root, {});
    expect(roots).to.have.length(1);
    expect(roots[0]).to.include({package: "$VIBES", pack: "vibes", writable: true});
    expect(roots[0].path.endsWith("packs/vibes/src")).to.equal(true);
  });
});
