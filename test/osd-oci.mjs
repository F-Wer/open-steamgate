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

// Tiny streaming responses expose cancellation and requests without a network.
describe("OCI hardening regressions", () => {
  const ref = `registry.example/osd/pack@sha256:${"a".repeat(64)}`;
  const fails = async (run, code) => {
    let error;
    try { await run(); } catch (e) { error = e; }
    expect(error?.code).to.equal(code);
  };
  const json = (value) => Buffer.from(JSON.stringify(value));
  const responseClient = (bytes, headers = {}) => ({ref: parseRef(ref), get: async () => new Response(bytes, {headers})});

  it("hardening 11: rejects dot repository segments", () => {
    for (const path of ["osd/../pack", "osd/./pack", "../pack", "./pack"])
      expect(() => parseRef(ref.replace("osd/pack", path))).to.throw(/expected host/);
    expect(parseRef(ref.replace("osd/pack", "osd/pack.name")).repository).to.equal("osd/pack.name");
  });

  it("hardening 2: refuses insecure nonlocal realms before requesting them", async () => {
    for (const realm of ["http://auth.example/token", "file:///token", "/token"]) {
      const seen = [];
      await fails(() => manifest(ref, {fetch: async (url) => {
        seen.push(url);
        return new Response(null, {status: 401, headers: {"www-authenticate": `Bearer realm="${realm}"`}});
      }}), "INSECURE_REALM");
      expect(seen).to.have.length(1);
    }
  });

  it("hardening 2: scopes credentials to a registry and preserves realm query parameters", async () => {
    const {client} = await import("../tools/osd-oci.mjs");
    const env = {OSD_OCI_USER: "user", OSD_OCI_TOKEN: "secret", GITHUB_TOKEN: "github", GITHUB_ACTOR: "actor"};
    for (const [host, scope, expected] of [
      ["registry.example", undefined, undefined],
      ["registry.example", "other.example", undefined],
      ["registry.example", "registry.example", "user:secret"],
      ["ghcr.io", undefined, "actor:github"],
      ["127.0.0.1:5000", undefined, undefined],
    ]) {
      let calls = 0, auth, tokenUrl;
      const realm = `${host.startsWith("127") ? "http" : "https"}://auth.example/token?existing=yes`;
      const c = client(ref.replace("registry.example", host), {env: {...env, OSD_OCI_REGISTRY: scope}, fetch: async (url, options) => {
        calls++;
        if (calls === 1) return new Response(null, {status: 401, headers: {"www-authenticate": `Bearer realm="${realm}",service="test"`}});
        if (calls === 2) { auth = options.headers.authorization; tokenUrl = new URL(url); return new Response('{"token":"ok"}'); }
        return new Response("ok");
      }});
      await c.get("manifests/x");
      expect(auth).to.equal(expected ? `Basic ${Buffer.from(expected).toString("base64")}` : undefined);
      expect(tokenUrl.searchParams.get("existing")).to.equal("yes");
      expect(tokenUrl.searchParams.get("service")).to.equal("test");
      expect(tokenUrl.searchParams.get("scope")).to.equal("repository:osd/pack:pull");
    }
  });

  it("hardening 3: rejects oversized headers before reading and cancels overflowing streams", async () => {
    const bytes = Buffer.from("abc"), descriptor = {digest: sha256(bytes), size: 3};
    for (const header of [true, false]) {
      let reads = 0, cancelled = false;
      const body = new ReadableStream({pull(c) { if (++reads === 1) c.enqueue(Buffer.from("abcd")); else c.close(); }, cancel() { cancelled = true; }}, {highWaterMark: 0});
      const c = {ref: parseRef(ref), get: async () => new Response(body, {headers: header ? {"content-length": "4"} : {}})};
      await fails(() => blob(ref, descriptor, {client: c}), "SIZE_MISMATCH");
      expect(cancelled).to.equal(true);
      expect(reads).to.equal(header ? 0 : 1);
    }
    await fails(() => manifest(ref, {client: responseClient(Buffer.alloc(4 * 1024 * 1024 + 1))}), "SIZE_MISMATCH");
    const cfg = Buffer.alloc(4 * 1024 * 1024 + 1, " ");
    const m = json({config: {mediaType: "config", digest: sha256(cfg), size: cfg.length}, layers: []});
    await fails(() => pull(`registry.example/osd/pack@${sha256(m)}`, {fetch: async (url) => new Response(url.includes("manifests/") ? m : cfg)}), "SIZE_MISMATCH");
  });

  it("hardening 4: verifies configs, including size zero and impostor empty descriptors", async () => {
    const bytes = json({treeDigest: "untrusted"});
    for (const [descriptor, served, code] of [
      [{mediaType: "config", digest: sha256(bytes), size: 0}, bytes, "BAD_DESCRIPTOR"],
      [{mediaType: "config", digest: sha256(bytes), size: bytes.length}, Buffer.alloc(bytes.length, "x"), "DIGEST_MISMATCH"],
      [{mediaType: "config", digest: sha256(bytes), size: bytes.length - 1}, bytes, "SIZE_MISMATCH"],
      [{mediaType: "application/vnd.oci.empty.v1+json", digest: sha256(bytes), size: bytes.length}, bytes, "BAD_DESCRIPTOR"],
      [{mediaType: "application/vnd.oci.empty.v1+json", digest: sha256(Buffer.from("{}")), size: 3}, bytes, "BAD_DESCRIPTOR"],
    ]) {
      const m = json({config: descriptor, layers: []});
      await fails(() => pull(`registry.example/osd/pack@${sha256(m)}`, {fetch: async (url) => new Response(url.includes("manifests/") ? m : served)}), code);
    }
    const m = json({config: {mediaType: "application/vnd.oci.empty.v1+json", digest: sha256(Buffer.from("{}")), size: 2}, layers: []});
    let calls = 0;
    expect((await pull(`registry.example/osd/pack@${sha256(m)}`, {fetch: async () => { calls++; return new Response(m); }})).config).to.equal(undefined);
    expect(calls).to.equal(1);
  });

  it("hardening 5: rejects a digest-valid cached blob of the wrong descriptor length", async () => {
    const cache = mkdtempSync(join(tmpdir(), "oci-size-"));
    const bytes = Buffer.from("abc"), digest = sha256(bytes);
    try {
      await blob(ref, {digest, size: 3}, {cacheDir: cache, client: responseClient(bytes)});
      await fails(() => blob(ref, {digest, size: 2}, {cacheDir: cache, client: responseClient(bytes)}), "SIZE_MISMATCH");
    } finally { rmSync(cache, {recursive: true, force: true}); }
  });

  it("hardening 10: refuses bytes served at a different manifest digest (HTTP 200)", async () => {
    const r = registry();
    const host = await listening(r);
    try {
      const digest = r.publish([Buffer.from("zip")], {});
      r.tamperManifest = digest;
      await fails(() => manifest(`${host}/osd/pack@${digest}`), "DIGEST_MISMATCH");
    } finally { await new Promise((done) => r.server.close(done)); }
  });
});
