import {gzipSync} from "node:zlib";
import {createServer} from "node:http";
import {MEDIA, sha256} from "../../tools/osd-oci.mjs";

export function registry({token = "t0k", tamper = false, gzip = false, mount = true} = {}) {
  const blobs = new Map(), manifests = new Map(), tags = new Map();
  const repositories = new Map();
  const repoBlobs = (repo) => { if (!repositories.has(repo)) repositories.set(repo, new Set()); return repositories.get(repo); };
  let mounts = 0, uploads = 0;
  const scopes = [], grants = new Map();
  const put = (bytes) => { const d = sha256(bytes); blobs.set(d, bytes); return {digest: d, size: bytes.length}; };
  let tamperBlob, tamperManifest;
  let requests = 0, tokens = 0, blobRequests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/token") {
      tokens++;
      const scope = url.searchParams.get("scope");
      scopes.push(scope);
      const issued = `${token}-${tokens}`;
      grants.set(issued, scope);
      res.writeHead(200, {"content-type": "application/json"});
      return res.end(JSON.stringify({token: issued, scope}));
    }
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
    if (!m) { res.writeHead(404); return res.end(); }
    const [, repo, type, reference] = m;
    const scope = grants.get(req.headers.authorization?.replace(/^Bearer /, ""));
    const write = !["GET", "HEAD"].includes(req.method);
    if (scope !== `repository:${repo}:pull,push` && (write || scope !== `repository:${repo}:pull`)) {
      res.writeHead(401, {"www-authenticate": `Bearer realm="http://${req.headers.host}/token",service="test",scope="repository:${repo}:${write ? "pull,push" : "pull"}"`});
      return res.end();
    }
    if (type === "blobs" && reference.startsWith("uploads/")) {
      if (req.method === "POST") {
        const digest = url.searchParams.get("mount"), from = url.searchParams.get("from");
        if (digest) mounts++;
        if (mount && digest && repoBlobs(from).has(digest)) {
          repoBlobs(repo).add(digest);
          res.writeHead(201); return res.end();
        }
        res.writeHead(202, {location: `/v2/${repo}/blobs/uploads/test?session=kept`});
        return res.end();
      }
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks), digest = url.searchParams.get("digest");
        if (sha256(bytes) !== digest || url.searchParams.get("session") !== "kept") { res.writeHead(400); return res.end(); }
        uploads++;
        blobs.set(digest, bytes); repoBlobs(repo).add(digest);
        res.writeHead(201); return res.end();
      }
    }
    if (type === "manifests" && req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), digest = sha256(bytes);
      if (reference.startsWith("sha256:") && reference !== digest) { res.writeHead(400); return res.end(); }
      manifests.set(`${repo}@${digest}`, bytes); tags.set(`${repo}:${reference}`, digest);
      res.writeHead(201, {"docker-content-digest": digest}); return res.end();
    }
    const key = type === "manifests" ? tags.get(`${repo}:${reference}`) ?? reference : reference;
    if (type === "blobs") blobRequests++;
    const body = type === "manifests" ? manifests.get(`${repo}@${key}`) : repoBlobs(repo).has(key) && blobs.get(key);
    if (!body) { res.writeHead(404); return res.end(); }
    if (req.method === "HEAD") { res.writeHead(200, {"content-length": body.length}); return res.end(); }
    if (gzip && type === "blobs") {
      const encoded = gzipSync(body);
      res.writeHead(200, {"content-encoding": "gzip", "content-length": encoded.length});
      return res.end(encoded);
    }
    res.writeHead(200, {"content-type": type === "manifests" ? MEDIA.manifest : "application/octet-stream"});
    if (type === "manifests" && key === tamperManifest) return res.end(Buffer.concat([body, Buffer.from(" ")]));
    res.end((tamper || key === tamperBlob) && type === "blobs" ? Buffer.concat([body, Buffer.from("x")]).subarray(1) : body);
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
      manifests.set(`osd/pack@${digest}`, bytes);
      for (const d of [json.config, ...json.layers]) repoBlobs("osd/pack").add(d.digest);
      tags.set("osd/pack:v1", digest);
      return digest;
    },
    get mounts() { return mounts; },
    get uploads() { return uploads; },
    get scopes() { return scopes; },
    get blobRequests() { return blobRequests; },
    get requests() { return requests; },
    get tokens() { return tokens; },
  };
}

export async function listening(r) {
  await new Promise((done) => r.server.listen(0, "127.0.0.1", done));
  return `127.0.0.1:${r.server.address().port}`;
}

