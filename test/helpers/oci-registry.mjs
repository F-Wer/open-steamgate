import {gzipSync} from "node:zlib";
import {createServer} from "node:http";
import {MEDIA, sha256} from "../../tools/osd-oci.mjs";

export function registry({token = "t0k", tamper = false, gzip = false} = {}) {
  const blobs = new Map(), manifests = new Map(), tags = new Map();
  const put = (bytes) => { const d = sha256(bytes); blobs.set(d, bytes); return {digest: d, size: bytes.length}; };
  let tamperBlob, tamperManifest;
  let requests = 0, tokens = 0, blobRequests = 0;
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
    if (m?.[1] === "blobs") blobRequests++;
    const body = m && (m[1] === "manifests" ? manifests.get(key) : blobs.get(key));
    if (!body) { res.writeHead(404); return res.end(); }
    if (gzip && m[1] === "blobs") {
      const encoded = gzipSync(body);
      res.writeHead(200, {"content-encoding": "gzip", "content-length": encoded.length});
      return res.end(encoded);
    }
    res.writeHead(200, {"content-type": m[1] === "manifests" ? MEDIA.manifest : "application/octet-stream"});
    if (m[1] === "manifests" && key === tamperManifest) return res.end(Buffer.concat([body, Buffer.from(" ")]));
    res.end((tamper || key === tamperBlob) && m[1] === "blobs" ? Buffer.concat([body, Buffer.from("x")]).subarray(1) : body);
  });
  return {
    server, put,
    set tamperManifest(digest) { tamperManifest = digest; },
    set tamperBlob(digest) { tamperBlob = digest; },
    publish(layers, config, {mediaType = "application/vnd.osd.abapgit.zip", title, empty = false} = {}) {
      const cfg = put(Buffer.from(JSON.stringify(config)));
      const json = {schemaVersion: 2, mediaType: MEDIA.manifest, artifactType: "application/vnd.osd.layer.v1",
        config: {mediaType: empty ? "application/vnd.oci.empty.v1+json" : "application/vnd.osd.layer.config.v1+json", ...cfg},
        layers: layers.map((bytes) => ({mediaType, ...(title ? {annotations: {"org.opencontainers.image.title": title}} : {}), ...put(bytes)}))};
      const bytes = Buffer.from(JSON.stringify(json));
      const digest = sha256(bytes);
      manifests.set(digest, bytes);
      tags.set("v1", digest);
      return digest;
    },
    get blobRequests() { return blobRequests; },
    get requests() { return requests; },
    get tokens() { return tokens; },
  };
}

export async function listening(r) {
  await new Promise((done) => r.server.listen(0, "127.0.0.1", done));
  return `127.0.0.1:${r.server.address().port}`;
}

