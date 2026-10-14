// tools/osd-oci.mjs against a registry in this process: the v2 subset a
// pull uses, with a Bearer challenge, so the token dance, digest checks and
// the blob cache are exercised without the network.
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect} from "chai";
import {blob, manifest, parseRef, pull, sha256, treeDigest} from "../tools/osd-oci.mjs";

import {registry, listening} from "./helpers/oci-registry.mjs";

describe("osd-oci: pulling a layer by digest", function () {
  let cache;
  beforeEach(() => { cache = mkdtempSync(join(tmpdir(), "osd-oci-")); });
  afterEach(() => rmSync(cache, {recursive: true, force: true}));

  it("hashes every file in UTF-8 byte order without normalising content", () => {
    const files = new Map([["é", Buffer.from("\ufeffx\r\n")], ["Z", Buffer.from("z")], ["a", Buffer.from("a")]]);
    const lines = ["Z", "a", "é"].map((path) => `${sha256(files.get(path)).slice(7)}  ${path}\n`).join("");
    expect(treeDigest(files)).to.equal(sha256(Buffer.from(lines)));
    expect(treeDigest(new Map([...files].reverse()))).to.equal(treeDigest(files));
    files.set("é", Buffer.from("x\n"));
    expect(treeDigest(files)).not.to.equal(sha256(Buffer.from(lines)));
  });

  it("parses references and refuses a tag unless asked to resolve it", async () => {
    const d = "sha256:" + "a".repeat(64);
    expect(parseRef(`ghcr.io/oisee/osd/pack@${d}`)).to.deep.equal({registry: "ghcr.io", repository: "oisee/osd/pack", tag: undefined, digest: d});
    expect(parseRef("localhost:5000/osd/pack:v1").tag).to.equal("v1");
    expect(() => parseRef("osd/pack@" + d)).to.throw(/expected host/);
    expect(() => parseRef("ghcr.io/osd/pack")).to.throw(/expected host/);
    const r = registry();
    const host = await listening(r);
    try {
      r.publish([Buffer.from("zip")], {name: "p"});
      let error;
      try { await manifest(`${host}/osd/pack:v1`); } catch (e) { error = e; }
      expect(error?.code).to.equal("TAG_ONLY");
      const resolved = await manifest(`${host}/osd/pack:v1`, {resolve: true});
      expect(resolved.digest).to.match(/^sha256:/);
    } finally { r.server.close(); }
  });

  it("follows the Bearer challenge, verifies every digest and reads the cache the second time", async () => {
    const r = registry();
    const host = await listening(r);
    try {
      const digest = r.publish([Buffer.from("PK zip one"), Buffer.from("PK zip two")], {name: "zlnt", kind: "pack"});
      const first = await pull(`${host}/osd/pack@${digest}`, {cacheDir: cache});
      expect(first.manifest.digest).to.equal(digest);
      expect(first.config).to.deep.equal({name: "zlnt", kind: "pack"});
      expect(first.layers.map((l) => l.bytes.toString())).to.deep.equal(["PK zip one", "PK zip two"]);
      expect(r.tokens).to.equal(1);
      const before = r.requests;
      const second = await pull(`${host}/osd/pack@${digest}`, {cacheDir: cache});
      expect(second.layers.map((l) => l.bytes.toString())).to.deep.equal(["PK zip one", "PK zip two"]);
      // only the manifest is asked for again (and its token); blobs come from the cache
      expect(r.requests - before).to.equal(3);
      // a cache file that does not hash to its name is fetched again
      const dir = join(cache, "blobs", "sha256");
      for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "corrupt");
      const third = await pull(`${host}/osd/pack@${digest}`, {cacheDir: cache});
      expect(third.layers[1].bytes.toString()).to.equal("PK zip two");
    } finally { r.server.close(); }
  });

  it("refuses a manifest or a blob that does not match its digest", async () => {
    const r = registry({tamper: true});
    const host = await listening(r);
    try {
      const digest = r.publish([Buffer.from("PK zip")], {name: "p"});
      let error;
      try { await pull(`${host}/osd/pack@${digest}`, {cacheDir: cache}); } catch (e) { error = e; }
      expect(error?.code).to.equal("DIGEST_MISMATCH");
      error = undefined;
      try { await manifest(`${host}/osd/pack@sha256:${"0".repeat(64)}`); } catch (e) { error = e; }
      expect(error?.code).to.equal("NOT_FOUND");
      error = undefined;
      try { await blob(`${host}/osd/pack@${digest}`, {digest: sha256(Buffer.from("PK zip")), size: 99}); } catch (e) { error = e; }
      expect(error?.code).to.equal("SIZE_MISMATCH");
    } finally { r.server.close(); }
  });
});
