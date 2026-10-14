import {expect} from "chai";
import {execFileSync} from "node:child_process";
import fs, {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MARKER, FetchFailed, describeUnfetched, fetchAll, fetchSource, unfetched} from "../tools/osd-fetch.mjs";
import {BadPack, packsOf} from "../tools/osd-packs.mjs";

import {registry, listening} from "./helpers/oci-registry.mjs";
import {treeDigest} from "../tools/osd-oci.mjs";
import {archiveFiles} from "../tools/osd-source-zip.mjs";
import {zipInProcess} from "../tools/osd-abapgit-zip.mjs";
import {prepare} from "../tools/osd-build.mjs";

// Patch the real filesystem binding so failures exercise the old code too.
async function withFsFaults(patches, run) {
  const originals = Object.fromEntries(Object.keys(patches).map((name) => [name, fs[name]]));
  for (const [name, patch] of Object.entries(patches)) fs[name] = (...args) => patch(originals[name], ...args);
  syncBuiltinESMExports();
  try { return await run(); }
  finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

// A pack may fetch a folder instead of carrying it: a repository, a commit
// and a path in it, declared in the manifest, copied by tools/osd-fetch.mjs.
// The repository here is a real one on disk, so the fetch is git's and not
// a stand-in for it; a file URL is what GitHub would be.
describe("tools/osd-fetch: a pack fetches a folder it does not carry", function () {
  this.timeout(30000);
  let root;
  let repo;
  let commit;
  const git = (args, cwd = repo) => execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
  const write = (base, file, text = "") => {
    mkdirSync(join(base, file, ".."), {recursive: true});
    writeFileSync(join(base, file), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-fetch-root-"));
    repo = mkdtempSync(join(tmpdir(), "osd-fetch-repo-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "test"]);
    write(repo, "src/zcl_theirs.clas.abap", "CLASS zcl_theirs DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_theirs IMPLEMENTATION.\nENDCLASS.\n");
    write(repo, "src/zcl_theirs.clas.xml", "<abapGit/>");
    write(repo, "src/zcl_theirs.clas.testclasses.abap", "* tests");
    write(repo, "src/zgui.prog.abap", "REPORT zgui.");
    write(repo, "src/sub/zcl_deep.clas.abap", "CLASS zcl_deep DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_deep IMPLEMENTATION.\nENDCLASS.\n");
    write(repo, "README.md", "not part of src");
    git(["add", "."]);
    git(["commit", "-q", "-m", "first"]);
    commit = git(["rev-parse", "HEAD"]);
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src"]}));
    write(root, "packs/theirs/osd-pack.json", JSON.stringify({
      abap: ["upstream", "src"],
      sources: [{folder: "upstream", repo: repo, ref: commit, path: "src", exclude: ["\\.testclasses\\.abap$", "^zgui\\."]}],
    }));
    write(root, "packs/theirs/src/zcl_mine.clas.abap", "CLASS zcl_mine DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_mine IMPLEMENTATION.\nENDCLASS.\n");
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
    rmSync(repo, {recursive: true, force: true});
  });

  it("reads the declaration and says the folder is not there yet", async () => {
    const [pack] = packsOf(root, {});
    expect(pack.sources.map((s) => [s.folder, s.ref, s.path, s.exclude])).to.deep.equal([["upstream", commit, "src", ["\\.testclasses\\.abap$", "^zgui\\."]]]);
    expect(pack.missing.map((s) => s.folder)).to.deep.equal(["upstream"]);
    // an unfetched folder is not a layer: the pack is smaller than declared, and says so
    expect(pack.abap.map((f) => f.split("/").pop())).to.deep.equal(["src"]);
    expect(unfetched(root, {}).map((m) => `${m.pack}/${m.folder}`)).to.deep.equal(["theirs/upstream"]);
    expect(describeUnfetched(unfetched(root, {}))).to.contain("pack theirs fetches upstream from").and.to.contain("node tools/osd-fetch.mjs");
  });

  it("fetches the path at the commit, minus what is excluded, and the pack is whole", async () => {
    const [pack] = packsOf(root, {});
    const answer = await fetchSource(pack, pack.sources[0]);
    expect(answer.fetched).to.equal(true);
    expect(answer.commit).to.equal(commit);
    expect(answer.files).to.equal(3);
    const up = join(root, "packs/theirs/upstream");
    expect(existsSync(join(up, "zcl_theirs.clas.abap"))).to.equal(true);
    expect(existsSync(join(up, "sub/zcl_deep.clas.abap"))).to.equal(true);
    expect(existsSync(join(up, "zcl_theirs.clas.testclasses.abap"))).to.equal(false);
    expect(existsSync(join(up, "zgui.prog.abap"))).to.equal(false);
    expect(existsSync(join(up, "README.md"))).to.equal(false);
    expect(existsSync(join(up, ".git"))).to.equal(false);
    // now it is a layer, below the pack's own folder
    const [again] = packsOf(root, {});
    expect(again.missing).to.deep.equal([]);
    expect(again.abap.map((f) => f.split("/").pop())).to.deep.equal(["upstream", "src"]);
    // and the marker says what was fetched
    const marker = JSON.parse(readFileSync(join(root, "packs/theirs", MARKER), "utf8"));
    expect(marker.upstream.commit).to.equal(commit);
    expect(marker.upstream.files).to.equal(3);
  });

  it("does nothing the second time at the same commit, and fetches again when the declaration moves", async () => {
    await fetchAll(root, {env: {}});
    const [pack] = packsOf(root, {});
    expect((await fetchSource(pack, pack.sources[0])).fetched).to.equal(false);
    expect((await fetchSource(pack, pack.sources[0], {force: true})).fetched).to.equal(true);
    // the repository moves on, and the manifest is re-pinned to a branch
    write(repo, "src/zcl_new.clas.abap", "CLASS zcl_new DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_new IMPLEMENTATION.\nENDCLASS.\n");
    rmSync(join(repo, "src/sub"), {recursive: true});
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "second"]);
    const second = git(["rev-parse", "HEAD"]);
    write(root, "packs/theirs/osd-pack.json", JSON.stringify({
      abap: ["upstream", "src"],
      sources: [{folder: "upstream", repo: repo, ref: "main", path: "src"}],
    }));
    const [moved] = packsOf(root, {});
    const answer = await fetchSource(moved, moved.sources[0]);
    expect(answer.fetched).to.equal(true);
    expect(answer.commit).to.equal(second);
    // replaced whole: what the repository dropped is gone, what it added is there
    expect(existsSync(join(root, "packs/theirs/upstream/sub"))).to.equal(false);
    expect(existsSync(join(root, "packs/theirs/upstream/zcl_new.clas.abap"))).to.equal(true);
    expect(existsSync(join(root, "packs/theirs/upstream/zgui.prog.abap"))).to.equal(true);
  });

  it("requires a marker and refetches when only the git repo changes", async () => {
    const up = join(root, "packs/theirs/upstream");
    mkdirSync(up);
    expect(unfetched(root, {})).to.have.length(1);
    await fetchAll(root, {env: {}});
    const file = join(root, "packs/theirs/osd-pack.json");
    const declared = JSON.parse(readFileSync(file));
    // The same commit from another URL is a different declared source.
    declared.sources[0].repo = `file://${repo}`;
    writeFileSync(file, JSON.stringify(declared));
    expect(unfetched(root, {})).to.have.length(1);
    const [pack] = packsOf(root, {});
    expect((await fetchSource(pack, pack.sources[0])).fetched).to.equal(true);
    expect(unfetched(root, {})).to.deep.equal([]);
  });

  it("hardening 8: a failed force copy preserves the git folder and its marker", async () => {
    const [pack] = packsOf(root, {}), source = pack.sources[0];
    await fetchSource(pack, source);
    const marker = readFileSync(join(pack.dir, MARKER));
    write(source.dir, "sentinel", "previous folder");
    let copies = 0, error;
    try {
      await withFsFaults({cpSync(copy, from, to) {
        if (++copies === 2) throw new Error("copy failed");
        copy(from, to);
      }}, () => fetchSource(pack, source, {force: true}));
    } catch (e) { error = e; }
    expect(error?.message).to.equal("copy failed");
    expect(readFileSync(join(source.dir, "sentinel"), "utf8")).to.equal("previous folder");
    expect(readFileSync(join(pack.dir, MARKER))).to.deep.equal(marker);
    expect(readdirSync(pack.dir).filter((p) => p.startsWith(".osd-fetch-"))).to.deep.equal([]);
  });

  it("refuses a path the repository does not have, and leaves nothing behind", async () => {
    write(root, "packs/theirs/osd-pack.json", JSON.stringify({
      sources: [{folder: "upstream", repo: repo, ref: commit, path: "nowhere"}],
    }));
    const [pack] = packsOf(root, {});
    let error;
    try { await fetchSource(pack, pack.sources[0]); } catch (e) { error = e; }
    expect(error).to.be.instanceOf(FetchFailed);
    expect(error.message).to.contain("no /nowhere in it");
    expect(existsSync(join(root, "packs/theirs", MARKER))).to.equal(false);
  });
});

describe("tools/osd-fetch: an OCI pack source", function () {
  this.timeout(30000);
  let root, r, host, dir, bytes;
  const write = (file, content) => {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), content);
  };
  const declare = (digest, extra = {}) => {
    write("packs/theirs/osd-pack.json", JSON.stringify({abap: ["upstream"], sources: [
      {folder: "upstream", oci: `${host}/osd/pack@${digest}`, ...extra},
    ]}));
    return packsOf(root, {})[0];
  };
  const fetchPack = (pack, options) => fetchSource(pack, pack.sources[0], options);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-fetch-oci-"));
    r = registry();
    host = await listening(r);
    dir = join(root, "packs/theirs");
    write("abap_transpile.json", JSON.stringify({input_folder: ["src"], libs: []}));
    write("payload/src/zcl_one.clas.abap", "CLASS zcl_one DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_one IMPLEMENTATION.\nENDCLASS.\n");
    write("payload/src/sub/zcl_two.clas.abap", "* nested\r\n");
    write("payload/src/skip/zcl_skip.clas.abap", "* excluded");
    write("payload/.abapgit.xml", "<abapGit/>");
    bytes = zipInProcess(join(root, "payload"));
  });
  afterEach(async () => {
    await new Promise((done) => r.server.close(done));
    rmSync(root, {recursive: true, force: true});
  });

  it("selects path and exclusions, records identity, caches blobs and passes build readiness", async () => {
    const digest = r.publish([bytes], {treeDigest: treeDigest(archiveFiles(bytes))});
    const pack = declare(digest, {exclude: ["^SKIP$"]});
    const logs = [];
    const answer = await fetchPack(pack, {log: (line) => logs.push(line)});
    expect(answer.files).to.equal(2);
    expect(readFileSync(join(dir, "upstream/sub/zcl_two.clas.abap"), "utf8")).to.equal("* nested\r\n");
    expect(existsSync(join(dir, "upstream/skip"))).to.equal(false);
    expect(existsSync(join(dir, "upstream/.abapgit.xml"))).to.equal(false);
    const marker = JSON.parse(readFileSync(join(dir, MARKER))).upstream;
    expect(marker).to.include({oci: pack.sources[0].oci, digest, treeDigest: answer.treeDigest, path: "src", files: 2});
    expect(marker.exclude).to.deep.equal(["^SKIP$"]);
    expect(marker.at).to.be.a("string");
    expect(logs[0]).to.contain("theirs/upstream: 2 files from sha256:").and.to.contain(" tree sha256:");
    const before = r.blobRequests;
    expect((await fetchPack(pack)).fetched).to.equal(false);
    expect(r.blobRequests).to.equal(before);
    expect((await fetchPack(pack, {force: true})).fetched).to.equal(true);
    expect(r.blobRequests).to.equal(before);
    expect(unfetched(root, {})).to.deep.equal([]);
    expect(() => prepare(root)).not.to.throw();
    declare(r.publish([bytes], {changed: true}));
    expect(unfetched(root, {})).to.have.length(1);
    expect(describeUnfetched(unfetched(root, {}))).to.contain(host);
    let error;
    try { prepare(root); } catch (e) { error = e; }
    expect(error?.code).to.equal("UNFETCHED");
  });

  it("selects a nested path and requires every declared identity field to match", async () => {
    const digest = r.publish([bytes], {});
    const pack = declare(digest, {path: "src/sub"});
    expect(pack.sources[0].exclude).to.deep.equal([]);
    expect((await fetchPack(pack)).files).to.equal(1);
    expect(existsSync(join(dir, "upstream/zcl_two.clas.abap"))).to.equal(true);
    for (const change of [{path: "src"}, {path: "src/sub", exclude: ["two"]}]) {
      declare(digest, change);
      expect(unfetched(root, {})).to.have.length(1);
    }
    declare(digest, {path: "src/sub"});
    expect(unfetched(root, {})).to.deep.equal([]);
  });

  it("accepts a single oras zip layer with an empty config", async () => {
    const digest = r.publish([bytes], {}, {mediaType: "application/zip", title: "pack.zip", empty: true});
    expect((await fetchPack(declare(digest))).files).to.equal(3);
  });

  for (const failure of ["TREE_MISMATCH", "DIGEST_MISMATCH", "unsafe ZIP", "media types"]) {
    it(`preserves the previous folder and marker on ${failure}`, async () => {
      const good = declare(r.publish([bytes], {}));
      await fetchPack(good);
      const marker = readFileSync(join(dir, MARKER));
      const old = readFileSync(join(dir, "upstream/zcl_one.clas.abap"));
      let config = {}, options = {}, payload = bytes;
      if (failure === "TREE_MISMATCH") config = {treeDigest: "sha256:" + "0".repeat(64)};
      if (failure === "DIGEST_MISMATCH") {
        // Tamper only the layer, keeping its descriptor and size unchanged.
        const blobDigest = r.put(bytes).digest;
        r.tamperBlob = blobDigest;
        // Drop the cached layer so this forced fetch checks registry bytes.
        rmSync(join(root, ".local/oci/blobs/sha256", blobDigest.slice(7)));
      }
      if (failure === "unsafe ZIP") {
        payload = Buffer.from(bytes);
        const name = Buffer.from("src/zcl_one.clas.abap");
        const bad = Buffer.from("../x".padEnd(name.length, "x"));
        for (let at = payload.indexOf(name); at >= 0; at = payload.indexOf(name, at + name.length)) bad.copy(payload, at);
      }
      if (failure === "media types") options = {mediaType: "application/octet-stream"};
      const pack = declare(r.publish([failure === "DIGEST_MISMATCH" ? bytes : payload], config, options));
      let error;
      try { await fetchPack(pack, {force: true}); } catch (e) { error = e; }
      expect(error).to.be.instanceOf(FetchFailed);
      const message = failure === "unsafe ZIP" ? "unsafe or unsupported source ZIP" : failure;
      expect(error.message).to.contain(message);
      if (failure === "media types") expect(error.message).to.contain("application/octet-stream");
      expect(readFileSync(join(dir, MARKER))).to.deep.equal(marker);
      expect(readFileSync(join(dir, "upstream/zcl_one.clas.abap"))).to.deep.equal(old);
    });
  }

  it("hardening 6: concurrent sources retain both installed identities in the marker", async () => {
    const digest = r.publish([bytes], {});
    const pack = declare(digest);
    const one = pack.sources[0];
    const two = {...one, folder: "games", dir: join(dir, "games"), path: "src/sub"};
    const answers = await Promise.all([fetchSource(pack, one), fetchSource(pack, two)]);
    const marker = JSON.parse(readFileSync(join(dir, MARKER)));
    for (const [source, answer] of [[one, answers[0]], [two, answers[1]]]) {
      expect(marker[source.folder]).to.include({oci: source.oci, digest, files: answer.files, path: source.path});
      expect(readFileSync(join(source.dir, source === one ? "sub/zcl_two.clas.abap" : "zcl_two.clas.abap"), "utf8")).to.equal("* nested\r\n");
    }
    expect(readdirSync(dir).filter((p) => p.startsWith(".osd-fetch-"))).to.deep.equal([]);
  });

  it("hardening 7: cleanup after marker commit warns and leaves an ignored old folder", async () => {
    const pack = declare(r.publish([bytes], {}));
    await fetchPack(pack);
    const logs = [];
    const answer = await withFsFaults({rmSync(remove, path, options) {
      if (path.endsWith(".old")) throw new Error("cleanup failed");
      remove(path, options);
    }}, () => fetchPack(pack, {force: true, log: (line) => logs.push(line)}));
    expect(answer.fetched).to.equal(true);
    expect(unfetched(root, {})).to.deep.equal([]);
    const leftovers = readdirSync(dir).filter((p) => p.endsWith(".old"));
    expect(leftovers).to.have.length(1);
    expect(leftovers[0]).to.match(/^\.osd-fetch-/);
    expect(readFileSync(".gitignore", "utf8").split("\n")).to.include("packs/*/.osd-fetch-*");
    expect(logs.join("\n")).to.contain("warning:").and.to.contain("cleanup failed");
  });

  it("hardening 7: a failed stage rename never deletes a destination it did not install", async () => {
    const pack = declare(r.publish([bytes], {}));
    let error;
    try {
      await withFsFaults({renameSync(rename, from, to) {
        if (to === pack.sources[0].dir) {
          mkdirSync(to);
          writeFileSync(join(to, "other-process"), "keep");
          throw new Error("rename failed");
        }
        rename(from, to);
      }}, () => fetchPack(pack));
    } catch (e) { error = e; }
    expect(error?.message).to.contain("rename failed");
    expect(readFileSync(join(pack.sources[0].dir, "other-process"), "utf8")).to.equal("keep");
    expect(existsSync(join(dir, MARKER))).to.equal(false);
  });

  it("hardening 7: marker rename failure rolls back only this process's install", async () => {
    const pack = declare(r.publish([bytes], {}));
    await fetchPack(pack);
    write("packs/theirs/upstream/sentinel", "old bytes");
    const marker = readFileSync(join(dir, MARKER));
    let error;
    try {
      await withFsFaults({renameSync(rename, from, to) {
        if (to === join(dir, MARKER)) throw new Error("marker rename failed");
        rename(from, to);
      }}, () => fetchPack(pack, {force: true}));
    } catch (e) { error = e; }
    expect(error?.message).to.contain("marker rename failed");
    expect(readFileSync(join(dir, "upstream/sentinel"), "utf8")).to.equal("old bytes");
    expect(readFileSync(join(dir, MARKER))).to.deep.equal(marker);
  });

  it("hardening 9: diagnostics preserve OCI error codes and name the reference once", async () => {
    const digest = r.publish([bytes], {});
    r.tamperBlob = r.put(bytes).digest;
    const pack = declare(digest);
    let error;
    try { await fetchPack(pack); } catch (e) { error = e; }
    expect(error?.code).to.equal("DIGEST_MISMATCH");
    expect(error.message.split(digest)).to.have.length(2);
    expect(describeUnfetched([{pack: "test", folder: "upstream"}])).to.contain("unknown ref");
    const check = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import {main} from ${JSON.stringify(new URL("../tools/osd-fetch.mjs", import.meta.url).href)}; await main(["--check"]);`],
      {env: {...process.env, OSD_ROOT: root, OSD_PACKS: "theirs"}, encoding: "utf8"});
    expect(check).to.contain(pack.sources[0].oci);
  });

  it("hardening 9: both builders and CLI diagnostics describe missing OCI and git identities", () => {
    const digest = "sha256:" + "a".repeat(64);
    const oci = `ghcr.io/example/pack@${digest}`;
    const pack = {name: "test", missing: [{folder: "upstream", oci}, {folder: "git", repo: "git.example", ref: "abcdef0123456789"}]};
    for (const script of ["scripts/build-vscode-web.mjs", "scripts/build-vsix.mjs"]) {
      // Execute the builders' actual projection without running a packaging build.
      const projection = readFileSync(script, "utf8").match(/const missing = (?:selected|selectedPacks)\.flatMap[\s\S]*?;\n/)[0];
      const list = new Function("selected", "selectedPacks", `${projection} return missing;`)([pack], [pack]);
      expect(describeUnfetched(list)).to.contain(oci).and.to.contain("git.example at abcdef012345");
    }
  });

  it("refuses tags and mixed OCI/git declarations", () => {
    const digest = "sha256:" + "a".repeat(64);
    for (const extra of [{oci: `${host}/osd/pack:v1`}, {repo: "x"}, {ref: "main"}, {lock: "core"}]) {
      expect(() => declare(digest, extra)).to.throw(BadPack);
    }
  });
});
