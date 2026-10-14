import {expect} from "chai";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {abapgitXml} from "../tools/osd-abapgit-zip.mjs";
import {build, inspect, leakGate, main, pushSystem, systemLayers} from "../tools/osd-layer.mjs";
import {manifest, pull, push, pushBlob, pushManifest, sha256, treeDigest} from "../tools/osd-oci.mjs";
import {archiveFiles} from "../tools/osd-source-zip.mjs";
import {fetchAll} from "../tools/osd-fetch.mjs";
import {registry, listening} from "./helpers/oci-registry.mjs";

const options = {name: "smoke", kind: "pack"};
const refusal = async (run, code) => {
  let error;
  try { await run(); } catch (e) { error = e; }
  expect(error?.code).to.equal(code);
};

describe("osd-layer: reproducible publishing", function () {
  this.timeout(30000);
  let root, folder, oldList, oldCwd, oldSelf;
  const write = (path, text) => { mkdirSync(join(path, ".."), {recursive: true}); writeFileSync(path, text); };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-layer-"));
    folder = join(root, "input");
    write(join(folder, "zcl_smoke.clas.abap"), "CLASS zcl_smoke DEFINITION PUBLIC. ENDCLASS.\nCLASS zcl_smoke IMPLEMENTATION. ENDCLASS.\n");
    oldList = process.env.OSD_LEAK_IDENTIFIERS;
    oldSelf = process.env.OSD_SELF;
    oldCwd = process.cwd();
    // The scanner prefers a checkout-local list. Run from an isolated root
    // so these tests always exercise this test list, never private config.
    process.chdir(root);
    write(join(root, "identifiers.json"), JSON.stringify({test: ["forbidden_publish_identifier"]}));
    process.env.OSD_LEAK_IDENTIFIERS = join(root, "identifiers.json");
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(oldCwd, "test/helpers/osd-layer-host.mjs")]);
  });
  afterEach(() => {
    process.chdir(oldCwd);
    if (oldSelf === undefined) delete process.env.OSD_SELF;
    else process.env.OSD_SELF = oldSelf;
    if (oldList === undefined) delete process.env.OSD_LEAK_IDENTIFIERS;
    else process.env.OSD_LEAK_IDENTIFIERS = oldList;
    rmSync(root, {recursive: true, force: true});
  });

  it("builds identical bytes and import-shaped trees with generated and existing abapGit metadata", async () => {
    const a = build(folder, options), b = build(folder, options);
    expect(a.zip).to.deep.equal(b.zip);
    expect(a.digest).to.equal(b.digest);
    expect(a.config.treeDigest).to.equal(b.config.treeDigest);
    expect(a.config.treeDigest).to.equal(treeDigest(archiveFiles(a.zip)));
    expect([...archiveFiles(a.zip).keys()]).to.deep.equal([".abapgit.xml", "src/zcl_smoke.clas.abap"]);
    const existing = join(root, "existing");
    for (const [path, bytes] of archiveFiles(a.zip)) write(join(existing, path), bytes);
    const c = build(existing, options);
    expect(c.zip).to.deep.equal(a.zip);
    expect(archiveFiles(c.zip).get(".abapgit.xml").toString()).to.equal(abapgitXml());
    await main(["build", folder, "--name", "smoke", "--kind", "pack", "--out", join(root, "out")]);
    expect(readFileSync(join(root, "out/smoke.zip"))).to.deep.equal(a.zip);
    expect(sha256(readFileSync(join(root, "out/manifest.json")))).to.equal(a.digest);
  });

  it("keeps every existing repository file and its custom starting folder", () => {
    const repo = join(root, "repo");
    const xml = abapgitXml().replace("/src/", "/objects/");
    write(join(repo, ".abapgit.xml"), xml);
    write(join(repo, "objects/deep/zcl_smoke.clas.abap"), "* source\r\n");
    write(join(repo, "README.md"), "repository readme");
    const built = build(repo, {...options, source: "https://github.com/example/repo@abc:objects"});
    expect([...archiveFiles(built.zip).keys()]).to.deep.equal([".abapgit.xml", "README.md", "objects/deep/zcl_smoke.clas.abap"]);
    expect(archiveFiles(built.zip).get(".abapgit.xml").toString()).to.equal(xml);
    expect(built.config.source).to.deep.equal({repo: "https://github.com/example/repo", commit: "abc", path: "objects"});
    expect(built.manifest.annotations["org.opencontainers.image.source"]).to.equal("https://github.com/example/repo");
    expect(built.zip.readUInt16LE(4)).to.equal(20);
    expect(built.zip.readUInt16LE(6)).to.equal(0x800);
    expect(built.zip.readUInt16LE(10)).to.equal(0);
    expect(built.zip.readUInt16LE(12)).to.equal(33);
    expect(built.zip.readUInt16LE(28)).to.equal(0);
  });

  it("refuses symlinks, nonregular entries and reserved fetch metadata", () => {
    symlinkSync(join(folder, "zcl_smoke.clas.abap"), join(folder, "link"));
    expect(() => build(folder, options)).to.throw(/only regular/);
    rmSync(join(folder, "link"));
    write(join(folder, "nested/.osd-source.json"), "{}");
    expect(() => build(folder, options)).to.throw(/cannot be published/);
  });

  it("pushes through the CLI, pulls exact bytes and fetches a real OSD pack with verified treeDigest", async () => {
    const r = registry(), host = await listening(r), target = `${host}/osd/pack:v2`;
    try {
      await main(["push", target, folder, "--name", "smoke", "--kind", "pack"]);
      const a = build(folder, options), ref = `${host}/osd/pack@${a.digest}`;
      const result = await pull(ref);
      expect(result.layers[0].bytes).to.deep.equal(a.zip);
      expect(result.config).to.deep.equal(a.config);
      expect(r.scopes).to.include("repository:osd/pack:pull,push");
      const before = r.uploads;
      await push(target, a);
      expect(r.uploads).to.equal(before);
      write(join(root, "packs/smoke/osd-pack.json"), JSON.stringify({name: "smoke", abap: ["upstream"], sources: [{folder: "upstream", oci: ref}]}));
      const [fetched] = await fetchAll(root, {env: {}});
      expect(fetched.treeDigest).to.equal(a.config.treeDigest);
      expect(readFileSync(join(root, "packs/smoke/upstream/zcl_smoke.clas.abap"))).to.deep.equal(readFileSync(join(folder, "zcl_smoke.clas.abap")));
      expect((await inspect(ref)).treeDigest).to.equal(a.config.treeDigest);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  for (const mount of [true, false]) it(`copies two repositories into a system with ${mount ? "mounts" : "upload fallback"}`, async () => {
    const r = registry({mount}), host = await listening(r);
    try {
      const a = build(folder, options), b = build(folder, {...options, name: "upper", kind: "input"});
      const d1 = await push(`${host}/source/one:v1`, a), d2 = await push(`${host}/source/two:v1`, b);
      const uploads = r.uploads;
      const target = `${host}/system/all:v1`;
      const digest = await pushSystem(target, [`${host}/source/one@${d1}`, `${host}/source/two@${d2}`], {root: oldCwd});
      const ref = `${host}/system/all@${digest}`, m = await manifest(ref);
      expect(m.json.manifests.map((d) => d.annotations["org.osd.layer.order"])).to.deep.equal(["0", "1"]);
      expect(m.json.annotations["org.osd.transpiler"]).to.match(/@/);
      expect(r.mounts).to.equal(3); // shared ZIP is mounted only once
      expect(r.uploads - uploads).to.equal(mount ? 0 : 3);
      for (const d of m.json.manifests) expect((await pull(`${host}/system/all@${d.digest}`)).layers[0].bytes).to.deep.equal(a.zip);
      expect((await inspect(ref)).layers.map((l) => l.name)).to.deep.equal(["smoke", "upper"]);
      const reversed = {...m.json, manifests: [...m.json.manifests].reverse()};
      expect(systemLayers(reversed).map((d) => d.annotations["org.osd.layer.order"])).to.deep.equal(["0", "1"]);
      for (const order of ["0", "2", "01", undefined]) {
        const invalid = structuredClone(m.json);
        invalid.manifests[1].annotations["org.osd.layer.order"] = order;
        expect(() => systemLayers(invalid)).to.throw(/contiguous/);
      }
      const same = await pushSystem(`${host}/system/all:v2`, m.json.manifests.map((d) => `${host}/system/all@${d.digest}`), {root: oldCwd});
      expect(same).to.equal(digest);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("refuses folder or metadata identifiers before anything reaches the registry, with CLI exit 2", async () => {
    const r = registry(), host = await listening(r);
    try {
      write(join(folder, "secret.txt"), "forbidden_publish_identifier");
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "pack"]), "LEAK");
      const result = spawnSync(process.execPath, [join(oldCwd, "tools/osd-layer.mjs"), "push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "pack"], {encoding: "utf8"});
      expect(result.status).to.equal(2);
      expect(result.stderr).to.include("LEAK");
      expect(r.requests).to.equal(0);
      rmSync(join(folder, "secret.txt"));
      write(join(folder, ".git/private.txt"), "forbidden_publish_identifier");
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "pack"]), "LEAK");
      expect(r.requests).to.equal(0);
      rmSync(join(folder, ".git"), {recursive: true});
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "pack", "--source", "forbidden_publish_identifier@abc:src"]), "LEAK");
      expect(r.requests).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("refuses a system containing a leaking layer before destination uploads", async () => {
    const r = registry(), host = await listening(r);
    try {
      const layer = build(folder, {...options, source: "forbidden_publish_identifier@abc:src"});
      const digest = await push(`${host}/source/one:v1`, layer);
      const uploads = r.uploads;
      await refusal(() => pushSystem(`${host}/system/all:v1`, [`${host}/source/one@${digest}`]), "LEAK");
      expect(r.uploads).to.equal(uploads);
      expect(r.mounts).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("fails closed without an identifier list", () => {
    delete process.env.OSD_LEAK_IDENTIFIERS;
    // In a standalone copy the scanner has neither repository nor sibling config.
    const scanner = join(root, "tools/osd-leak-scan.mjs");
    write(scanner, readFileSync(join(oldCwd, "tools/osd-leak-scan.mjs")));
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(oldCwd, "test/helpers/osd-layer-host.mjs"), root]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/identifier list is missing/);
  });

  it("refuses upload redirects to another origin before forwarding a token", async () => {
    const ref = "registry.example/osd/pack:v1", requests = [];
    await refusal(() => pushBlob(ref, Buffer.from("zip"), {fetch: async (url) => {
      requests.push(url);
      return requests.length === 1 ? new Response(null, {status: 404}) : new Response(null, {status: 202, headers: {location: "https://other.example/upload"}});
    }}), "UNSAFE_LOCATION");
    expect(requests).to.have.length(2);
    await refusal(() => pushManifest(`registry.example/osd/pack@sha256:${"a".repeat(64)}`, Buffer.from("{}")), "DIGEST_MISMATCH");
  });
});
