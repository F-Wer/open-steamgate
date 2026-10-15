import {expect} from "chai";
import {execFileSync, spawn, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {load as parseYaml} from "js-yaml";
import {abapgitXml, zipFiles} from "../tools/osd-abapgit-zip.mjs";
import {build, inspect, leakGate, main, pushSystem, readLeakAllow, systemLayers} from "../tools/osd-layer.mjs";
import {manifest, pull, push, pushBlob, pushManifest, sha256, treeDigest} from "../tools/osd-oci.mjs";
import {archiveFiles} from "../tools/osd-source-zip.mjs";
import {fetchAll} from "../tools/osd-fetch.mjs";
import {registry, listening} from "./helpers/oci-registry.mjs";

const options = {name: "smoke", kind: "input"};
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
    // No chdir: the gate runs the scanner from its own scan directory, so the
    // test list below wins over a checkout's private one (and the timing
    // reporter, which maps tests to files by the cwd, keeps working).
    write(join(root, "identifiers.json"), JSON.stringify({test: ["forbidden_publish_identifier"]}));
    process.env.OSD_LEAK_IDENTIFIERS = join(root, "identifiers.json");
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(oldCwd, "test/helpers/osd-layer-host.mjs")]);
  });
  afterEach(() => {
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
    await main(["build", folder, "--name", "smoke", "--kind", "input", "--out", join(root, "out")]);
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
      await main(["push", target, folder, "--name", "smoke", "--kind", "input"]);
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

  it("regression 5: runs the workflow publish, inspect and pack fetch-back commands", async () => {
    const r = registry(), host = await listening(r);
    try {
      const workflow = parseYaml(readFileSync(join(oldCwd, ".github/workflows/oci-layers.yml"), "utf8"));
      const step = workflow.jobs.smoke.steps.find(s => s.name === "publish two layers and a system, inspect and fetch");
      // Change only the registry destination. Execute the workflow's exact
      // shell, including its generated pack manifest and final byte comparison.
      const script = step.run.replace(/^registry_repo=.*$/m, `registry_repo="${host}/workflow"`);
      expect(script).not.to.equal(step.run);
      const result = await new Promise((done, reject) => {
        const child = spawn("bash", ["-e", "-c", script], {cwd: oldCwd,
          env: {...process.env, RUN_ID: "test", TMPDIR: root}, stdio: ["ignore", "pipe", "pipe"]});
        let output = "";
        child.stdout.on("data", b => { output += b; });
        child.stderr.on("data", b => { output += b; });
        child.on("error", reject);
        child.on("close", code => done({code, output}));
      });
      expect(result.code, result.output).to.equal(0);
      expect(r.uploads).to.be.greaterThan(0);
    } finally { await new Promise(done => r.server.close(done)); }
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
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input"]), "LEAK");
      const result = spawnSync(process.execPath, [join(oldCwd, "tools/osd-layer.mjs"), "push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input"], {encoding: "utf8"});
      expect(result.status).to.equal(2);
      expect(result.stderr).to.include("LEAK");
      expect(r.requests).to.equal(0);
      rmSync(join(folder, "secret.txt"));
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input", "--source", "forbidden_publish_identifier@abc:src"]), "LEAK");
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

  it("scans original config and manifest bytes before copying foreign layers", async () => {
    const r = registry(), host = await listening(r);
    try {
      const layer = build(folder, options);
      // A duplicate JSON key disappears from the parsed config, but its bytes travel.
      layer.configBytes = Buffer.from('{"name":"forbidden_publish_identifier",' + layer.configBytes.toString().slice(1));
      Object.assign(layer.manifest.config, {digest: sha256(layer.configBytes), size: layer.configBytes.length});
      layer.manifestBytes = Buffer.from(JSON.stringify(layer.manifest));
      const digest = await push(`${host}/foreign/one:v1`, layer), uploads = r.uploads;
      await refusal(() => pushSystem(`${host}/system/all:v1`, [`${host}/foreign/one@${digest}`]), "LEAK");
      expect(r.uploads).to.equal(uploads);
      expect(r.mounts).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("fails closed without an identifier list", () => {
    delete process.env.OSD_LEAK_IDENTIFIERS;
    // In a standalone copy the scanner has neither repository nor sibling config.
    const scanner = join(root, "tools/osd-leak-scan.mjs");
    write(scanner, readFileSync(join(oldCwd, "tools/osd-leak-scan.mjs")));
    write(join(root, "tools/osd-main.mjs"), readFileSync(join(oldCwd, "tools/osd-main.mjs")));
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(oldCwd, "test/helpers/osd-layer-host.mjs"), root]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/SCAN_FAILED/);
  });

  it("uses stored entries and identical Node/Bun child-process digests", () => {
    write(join(folder, "varied.txt"), Array.from({length: 3000}, (_, i) => `line ${i % 71}: ${i * 17}\n`).join(""));
    const script = join(oldCwd, "tools/osd-layer.mjs");
    const run = (command, out) => {
      const result = spawnSync(command, [script, "build", folder, "--name", "smoke", "--kind", "input", "--out", out], {encoding: "utf8"});
      expect(result.status, result.stderr).to.equal(0);
      return [sha256(readFileSync(join(out, "smoke.zip"))), sha256(readFileSync(join(out, "manifest.json")))];
    };
    const node = run("node", join(root, "node"));
    expect(readFileSync(join(root, "node/smoke.zip")).readUInt16LE(8)).to.equal(0);
    if (spawnSync("bun", ["--version"]).error?.code === "ENOENT") {
      console.log("Bun not on PATH: skipping Node/Bun digest comparison");
      return;
    }
    expect(run("bun", join(root, "bun"))).to.deep.equal(node);
  });

  for (const foreign of ["comment", "deflate", "order", "treeDigest"]) it(`refuses foreign layer ${foreign} before destination writes`, async () => {
    const r = registry(), host = await listening(r);
    try {
      const layer = build(folder, options);
      if (foreign === "comment") {
        const zip = Buffer.from(layer.zip);
        const comment = Buffer.from("forbidden_publish_identifier");
        zip.writeUInt16LE(comment.length, zip.length - 2);
        layer.zip = Buffer.concat([zip, comment]);
      } else if (foreign === "deflate") layer.zip = zipFiles(layer.files, {method: 8});
      else if (foreign === "order") layer.zip = zipFiles([...layer.files].reverse(), {method: 0});
      else {
        layer.config.treeDigest = `sha256:${"0".repeat(64)}`;
        layer.configBytes = Buffer.from(JSON.stringify(layer.config));
        Object.assign(layer.manifest.config, {digest: sha256(layer.configBytes), size: layer.configBytes.length});
      }
      Object.assign(layer.manifest.layers[0], {digest: sha256(layer.zip), size: layer.zip.length});
      layer.manifestBytes = Buffer.from(JSON.stringify(layer.manifest));
      const digest = await push(`${host}/foreign/one:v1`, layer), uploads = r.uploads;
      await refusal(() => pushSystem(`${host}/system/all:v1`, [`${host}/foreign/one@${digest}`]), foreign === "treeDigest" ? "TREE_MISMATCH" : "NOT_CANONICAL");
      expect(r.uploads).to.equal(uploads);
      expect(r.mounts).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  for (const name of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock", ".leak-allow.json", ".git/objects/opaque"]) it(`scans content under neutral names: ${name}`, () => {
    expect(() => leakGate([[{path: name, bytes: Buffer.from("forbidden_publish_identifier")}]], {})).to.throw(/LEAK|publish refused/);
  });

  for (const name of ["trace.pcap", "dump.pcapng", "src/log.JSONL"]) it(`refuses a capture file by its archive name: ${name}`, () => {
    expect(() => leakGate([[{path: name, bytes: Buffer.from("no identifier inside")}]], {})).to.throw(/capture file/);
  });

  it("names a leaking file by its archive path, not its neutral scan name", () => {
    let error;
    try { leakGate([[{path: "safe.txt", bytes: Buffer.from("x")}, {path: "src/zcl_hit.clas.abap", bytes: Buffer.from("forbidden_publish_identifier")}]], {}); } catch (e) { error = e; }
    expect(error?.message).to.include("src/zcl_hit.clas.abap");
    expect(error?.message).not.to.match(/content\/\d{6}\.txt/);
  });

  it("lets a layer's allow entry through for that archive path and value only", () => {
    const hit = Buffer.from("forbidden_publish_identifier");
    const allow = [{file: "src/zcl_vector.clas.abap", value: "forbidden_publish_identifier", reason: "public upstream test vector"}];
    expect(() => leakGate([[{path: "src/zcl_vector.clas.abap", bytes: hit}]], {}, [], allow)).not.to.throw();
    expect(() => leakGate([[{path: "src/zcl_vector.clas.abap", bytes: hit}, {path: "src/zcl_other.clas.abap", bytes: hit}]], {}, [], allow))
      .to.throw(/zcl_other/);
    expect(() => leakGate([[{path: "src/zcl_vector.clas.abap", bytes: hit}]], {}, [], [{...allow[0], value: "something_else_entirely"}]))
      .to.throw(/publish refused/);
  });

  it("refuses an allow entry for a path the layer does not have, or for metadata", () => {
    const safe = [[{path: "src/a.clas.abap", bytes: Buffer.from("safe")}]];
    for (const file of ["src/missing.clas.abap", "OCI metadata", "paths.txt", "meta.json"]) {
      expect(() => leakGate(safe, {}, [Buffer.from("{}")], [{file, value: "x1234", reason: "r"}])).to.throw(/BAD_ALLOW|no such file/);
    }
  });

  it("never lets an archive file's exception reach the metadata documents, whatever it is called", () => {
    const hit = Buffer.from("forbidden_publish_identifier");
    for (const name of ["OCI metadata", "paths.txt", "meta.json"]) {
      const allow = [{file: name, value: "forbidden_publish_identifier", reason: "r"}];
      expect(() => leakGate([[{path: name, bytes: hit}]], {}, [], allow)).not.to.throw();
      // the same value in a raw config document (a duplicate key parsing would drop) stays refused
      expect(() => leakGate([[{path: name, bytes: Buffer.from("safe")}]], {}, [Buffer.from('{"name":"forbidden_publish_identifier","name":"smoke"}')], allow))
        .to.throw(/publish refused/);
    }
  });

  it("scopes an entry with a layer to that layer of a system", () => {
    const hit = Buffer.from("forbidden_publish_identifier");
    const trees = [[{path: "src/v.clas.abap", bytes: hit}], [{path: "src/v.clas.abap", bytes: hit}]];
    const entry = {file: "src/v.clas.abap", value: "forbidden_publish_identifier", reason: "r"};
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "one"}], ["one", "two"])).to.throw(/publish refused/);
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "one"}, {...entry, layer: "two"}], ["one", "two"])).not.to.throw();
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "three"}], ["one", "two"])).to.throw(/BAD_ALLOW|no such file/);
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "one"}], ["one", "one"])).to.throw(/more than one layer/);
    // an unscoped entry in a system is refused rather than applied to every layer
    expect(() => leakGate(trees, {}, [], [entry], ["one", "two"])).to.throw(/needs "layer"/);
    expect(() => leakGate([trees[0]], {}, [], [entry], ["one"])).not.to.throw();
  });

  it("reads an allow file only with a reason on every entry", async () => {
    const file = join(root, "allow.json");
    writeFileSync(file, JSON.stringify({allow: [{file: "src/a.clas.abap", value: "v"}]}));
    expect(() => readLeakAllow(file)).to.throw(/reason/);
    writeFileSync(file, JSON.stringify([{file: "a", value: "v", reason: "r"}]));
    expect(() => readLeakAllow(file)).to.throw(/allow/);
    writeFileSync(file, JSON.stringify({allow: [{file: "src/a.clas.abap", value: "v", reason: "upstream vector"}]}));
    expect(readLeakAllow(file)).to.have.length(1);
    writeFileSync(file, JSON.stringify({allow: [{file: "a", value: "v", reason: "r", layer: ""}]}));
    expect(() => readLeakAllow(file)).to.throw(/layer/);
    for (const bad of [{allow: [{file: "a", value: "v", reason: "r", Layer: "x"}]}, {allow: [], extra: 1}, {allow: ["x"]}, {allow: [[]]}]) {
      writeFileSync(file, JSON.stringify(bad));
      expect(() => readLeakAllow(file), JSON.stringify(bad)).to.throw(/BAD_ALLOW|unknown key|not an object/);
    }
    let refused;
    try { await main(["build", folder, "--name", "x", "--kind", "input", "--out", join(root, "o"), "--leak-allow", file]); } catch (e) { refused = e; }
    expect(refused?.message).to.match(/no leak gate/);
    writeFileSync(file, " ".repeat(1024 * 1024 + 1));
    expect(() => readLeakAllow(file)).to.throw(/1 MiB/);
    // a pipe stats as size 0; the cap is measured on what was read (a shell
    // pipe, since Node's own child stdin is a socket /dev/stdin cannot open)
    const reader = `import {readLeakAllow} from ${JSON.stringify(new URL("../tools/osd-layer.mjs", import.meta.url).href)}; try { readLeakAllow("/dev/stdin"); } catch (e) { console.log(e.message); }`;
    const piped = spawnSync("sh", ["-c", `"$0" -e 'process.stdout.write(" ".repeat(1024 * 1024 + 1))' | "$0" --input-type=module -e "$1"`, process.execPath, reader], {encoding: "utf8"});
    expect(piped.stdout).to.match(/1 MiB/);
  });

  it("refuses oversized content instead of skipping it", () => {
    expect(() => leakGate([[{path: "large.txt", bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 32)}]], {})).to.throw(/size limit/);
  });

  it("scans archive paths and reports redacted hits", () => {
    expect(() => leakGate([[{path: "forbidden_publish_identifier.txt", bytes: Buffer.from("safe")}]], {})).to.throw(/sha256:/);
  });

  it("resolves the scanner from its module when unhosted in another cwd", () => {
    delete process.env.OSD_SELF;
    expect(() => leakGate([build(folder, options).files], {})).not.to.throw();
    expect(() => leakGate([[{path: "safe", bytes: Buffer.from("forbidden_publish_identifier")}]], {})).to.throw(/sha256:/);
  });

  it("distinguishes scanner spawn failures and exit 2 from leaks", () => {
    process.env.OSD_SELF = JSON.stringify([join(root, "missing-scanner")]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/SCAN_FAILED:.*ENOENT/);
    process.env.OSD_SELF = JSON.stringify([process.execPath, "-e", "process.exit(2)"]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/SCAN_FAILED:.*2/);
  });

  for (const system of [false, true]) it(`scans ${system ? "system" : "layer"} destination references`, async () => {
    const r = registry(), host = await listening(r);
    try {
      if (system) {
        const digest = await push(`${host}/source/one:v1`, build(folder, options)), uploads = r.uploads;
        await refusal(() => pushSystem(`${host}/system/all:forbidden_publish_identifier`, [`${host}/source/one@${digest}`]), "LEAK");
        expect(r.uploads).to.equal(uploads);
        expect(r.mounts).to.equal(0);
      } else {
        await refusal(() => main(["push", `${host}/forbidden_publish_identifier/pack:v1`, folder, "--name", "smoke", "--kind", "input"]), "LEAK");
        expect(r.requests).to.equal(0);
      }
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("excludes .git directories, .git files and node_modules and logs exclusions", async () => {
    const r = registry(), host = await listening(r), logs = [], original = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      write(join(folder, ".git/config"), "forbidden_publish_identifier");
      write(join(folder, "nested/.git"), "forbidden_publish_identifier");
      write(join(folder, "node_modules/pkg/index.js"), "forbidden_publish_identifier");
      await main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input"]);
      const layer = await pull(`${host}/osd/pack@${build(folder, options).digest}`);
      expect([...archiveFiles(layer.layers[0].bytes).keys()]).to.deep.equal([".abapgit.xml", "src/zcl_smoke.clas.abap"]);
      expect(logs.join("\n")).to.include(".git").and.include("node_modules");
    } finally { console.error = original; await new Promise((done) => r.server.close(done)); }
  });

  it("preserves upload Location query bytes", async () => {
    const requests = [], bytes = Buffer.from("zip");
    await pushBlob("registry.example/osd/pack:v1", bytes, {fetch: async (url) => {
      requests.push(String(url));
      if (requests.length === 1) return new Response(null, {status: 404});
      if (requests.length === 2) return new Response(null, {status: 202, headers: {location: "/upload?token=a%20b&signature=x~y"}});
      return new Response(null, {status: 201});
    }});
    expect(requests[2]).to.equal(`https://registry.example/upload?token=a%20b&signature=x~y&digest=${encodeURIComponent(sha256(bytes))}`);
  });

  it("keeps publication credentials out of install steps", () => {
    const workflow = parseYaml(readFileSync(join(oldCwd, ".github/workflows/oci-layers.yml"), "utf8"));
    const job = workflow.jobs.smoke;
    expect(job.env).not.to.have.property("GITHUB_TOKEN");
    expect(job.env).not.to.have.property("GITHUB_ACTOR");
    expect(job.steps.find((s) => s.uses?.startsWith("actions/checkout")).with["persist-credentials"]).to.equal(false);
    const publish = job.steps.find((s) => s.name?.startsWith("publish two"));
    expect(publish.env).to.have.property("GITHUB_TOKEN");
    expect(publish.env).to.have.property("GITHUB_ACTOR");
  });

  for (const check of ["absent transpiler", "tool checkout commit", "downloads blobs only once"]) it(`handles ${check}`, async () => {
    write(join(root, "libs.lock.json"), JSON.stringify(check === "absent transpiler" ? {} : {transpiler: {repo: "example/transpiler", ref: "test"}}));
    execFileSync("git", ["init", "--quiet"], {cwd: root});
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], {cwd: root});
    const r = registry({mount: false}), host = await listening(r), reads = new Map();
    const fetchOnce = async (url, init) => {
      if ((!init?.method || init.method === "GET") && String(url).includes("/blobs/")) {
        reads.set(String(url), (reads.get(String(url)) ?? 0) + 1);
        if (check === "downloads blobs only once") expect(reads.get(String(url)), String(url)).to.equal(1);
      }
      return fetch(url, init);
    };
    try {
      const digest = await push(`${host}/source/one:v1`, build(folder, options));
      const target = `${host}/system/all:v1`;
      const index = await pushSystem(target, [`${host}/source/one@${digest}`], {root, fetch: fetchOnce});
      const result = await manifest(`${host}/system/all@${index}`);
      if (check === "absent transpiler") expect(result.json.annotations).not.to.have.property("org.osd.transpiler");
      if (check === "tool checkout commit") expect(result.json.annotations["org.osd.osg.commit"]).to.equal(execFileSync("git", ["rev-parse", "HEAD"], {cwd: oldCwd, encoding: "utf8"}).trim());
    } finally { await new Promise((done) => r.server.close(done)); }
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
