// tools/osd-oci.mjs against a registry in this process: the v2 subset a
// pull uses, with a Bearer challenge, so the token dance, digest checks and
// the blob cache are exercised without the network.
import {createServer} from "node:http";
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect} from "chai";
import {MEDIA, blob, manifest, parseRef, pull, sha256} from "../tools/osd-oci.mjs";

function registry({token = "t0k", tamper = false} = {}) {
  const blobs = new Map(), manifests = new Map(), tags = new Map();
  const put = (bytes) => { const d = sha256(bytes); blobs.set(d, bytes); return {digest: d, size: bytes.length}; };
  let requests = 0, tokens = 0;
  const server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/token") {
      tokens++;
      res.writeHead(200, {"content-type": "application/json"});
      return res.end(JSON.stringify({token, scope: url.searchParams.get("scope")}));
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, {"www-authenticate": `Bearer realm="http://${req.headers.host}/token",service="test",scope="repository:osd/pack:pull"`});
      return res.end();
    }
    const m = /^\/v2\/osd\/pack\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
    const key = m && (m[1] === "manifests" && tags.has(m[2]) ? tags.get(m[2]) : m[2]);
    const body = m && (m[1] === "manifests" ? manifests.get(key) : blobs.get(key));
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {"content-type": m[1] === "manifests" ? MEDIA.manifest : "application/octet-stream"});
    res.end(tamper && m[1] === "blobs" ? Buffer.concat([body, Buffer.from("x")]).subarray(1) : body);
  });
  return {
    server, put,
    publish(layers, config) {
      const cfg = put(Buffer.from(JSON.stringify(config)));
      const json = {schemaVersion: 2, mediaType: MEDIA.manifest, artifactType: "application/vnd.osd.layer.v1",
        config: {mediaType: "application/vnd.osd.layer.config.v1+json", ...cfg},
        layers: layers.map((bytes) => ({mediaType: "application/vnd.osd.abapgit.zip", ...put(bytes)}))};
      const bytes = Buffer.from(JSON.stringify(json));
      const digest = sha256(bytes);
      manifests.set(digest, bytes);
      tags.set("v1", digest);
      return digest;
    },
    get requests() { return requests; },
    get tokens() { return tokens; },
  };
}

async function listening(r) {
  await new Promise((done) => r.server.listen(0, "127.0.0.1", done));
  return `127.0.0.1:${r.server.address().port}`;
}

describe("osd-oci: pulling a layer by digest", function () {
  let cache;
  beforeEach(() => { cache = mkdtempSync(join(tmpdir(), "osd-oci-")); });
  afterEach(() => rmSync(cache, {recursive: true, force: true}));

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
