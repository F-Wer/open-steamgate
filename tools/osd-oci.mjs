// An OCI registry, read by digest (backlog E.10): the registry v2 API, the
// part a pull needs, over fetch. No oras binary, because the Bun binary and
// the Pages workflow pull too.
//
// A reference is host/repository@sha256:<hex>. A tag names something that
// can move under it, and a generation is the hash of its inputs, so a tag
// is refused unless the caller asks to resolve it (resolve: true), which is
// how a digest is found to pin. Everything read is checked against its
// digest before it is used: the manifest's bytes, and each blob's bytes and
// size. Blobs are kept by digest under the cache directory, so a second
// pull of the same layer touches no network and a cache file that does not
// hash to its name is fetched again.
//
// Authentication is the registry's own: a request answered 401 with
// WWW-Authenticate: Bearer realm=...,service=...,scope=... gets a token
// from the realm, anonymously for a public package, or with OSD_OCI_USER /
// OSD_OCI_TOKEN only for OSD_OCI_REGISTRY (GITHUB_TOKEN only for ghcr.io).
// Token realms must use HTTPS except when the registry is local. localhost
// is spoken to over http, for tests.
import {createHash} from "node:crypto";
import {closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";

export const MEDIA = {
  manifest: "application/vnd.oci.image.manifest.v1+json",
  index: "application/vnd.oci.image.index.v1+json",
  dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
  dockerList: "application/vnd.docker.distribution.manifest.list.v2+json",
};
const ACCEPT = [MEDIA.manifest, MEDIA.index, MEDIA.dockerManifest, MEDIA.dockerList].join(", ");

export class OciError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Every archive file, sorted by UTF-8 bytes; content is hashed as raw bytes. */
export function treeDigest(files) {
  const lines = [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, bytes]) => `${sha256(bytes).slice(7)}  ${path}\n`).join("");
  return sha256(Buffer.from(lines));
}

/** host/repository[:tag][@sha256:hex] as its parts; the host is required */
export function parseRef(ref) {
  const m = /^([a-z0-9.-]+(?::\d+)?)\/([a-z0-9._\/-]+?)(?::([\w][\w.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(ref);
  // a host is told from a path by a dot, a port or the name localhost, as docker does
  if (!m || !/[.:]|^localhost$/.test(m[1]) || (!m[3] && !m[4]) || m[2].split("/").some((p) => p === "." || p === "..")) throw new OciError("BAD_REF", `${ref}: expected host/repository@sha256:<64 hex> (or :tag to resolve)`);
  return {registry: m[1], repository: m[2], tag: m[3], digest: m[4]};
}

export function formatRef({registry, repository, digest}) {
  return `${registry}/${repository}@${digest}`;
}

const local = (registry) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(registry);
const base = ({registry}) => `${local(registry) ? "http" : "https"}://${registry}/v2/`;

function credentials(registry, env) {
  if (registry === env.OSD_OCI_REGISTRY && env.OSD_OCI_USER && env.OSD_OCI_TOKEN) {
    return Buffer.from(`${env.OSD_OCI_USER}:${env.OSD_OCI_TOKEN}`).toString("base64");
  }
  if (registry === "ghcr.io" && env.GITHUB_TOKEN) {
    return Buffer.from(`${env.GITHUB_ACTOR ?? "token"}:${env.GITHUB_TOKEN}`).toString("base64");
  }
  return undefined;
}

function challenge(header) {
  const m = /^Bearer\s+(.*)$/i.exec(header ?? "");
  if (!m) return undefined;
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)="([^"]*)"/g)) out[k] = v;
  return out.realm ? out : undefined;
}

/** a client for one repository: GET with the registry's token dance */
export function client(ref, options = {}) {
  const parsed = typeof ref === "string" ? parseRef(ref) : ref;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  let bearer;
  async function request(path, {method = "GET", headers = {}, body, allow = []} = {}) {
    const url = new URL(path, base(parsed) + `${parsed.repository}/`).href;
    if (new URL(url).origin !== new URL(base(parsed)).origin) throw new OciError("UNSAFE_LOCATION", "registry upload location must have the same origin");
    const send = () => fetchImpl(url, {method, body, headers: {...headers, ...(bearer ? {authorization: `Bearer ${bearer}`} : {})}, redirect: method === "GET" ? "follow" : "error"});
    let res = await send();
    if (res.status === 401 && !bearer) {
      const c = challenge(res.headers.get("www-authenticate"));
      if (!c) throw new OciError("UNAUTHORIZED", `${url}: 401 without a Bearer challenge`);
      let realm;
      try { realm = new URL(c.realm); }
      catch { throw new OciError("INSECURE_REALM", `${c.realm}: invalid token realm URL`); }
      if (realm.protocol !== "https:" && !(local(parsed.registry) && realm.protocol === "http:")) {
        throw new OciError("INSECURE_REALM", `${c.realm}: token realm must use HTTPS`);
      }
      const q = realm.searchParams;
      if (c.service) q.set("service", c.service);
      q.set("scope", options.push ? `repository:${parsed.repository}:pull,push` : c.scope ?? `repository:${parsed.repository}:pull`);
      const basic = credentials(parsed.registry, env);
      const t = await fetchImpl(realm.href, {headers: basic ? {authorization: `Basic ${basic}`} : {}, redirect: "error"});
      if (!t.ok) throw new OciError("UNAUTHORIZED", `${c.realm}: token request answered ${t.status}`);
      const body = JSON.parse((await boundedBody(t, JSON_LIMIT)).toString("utf8"));
      bearer = body.token ?? body.access_token;
      if (!bearer) throw new OciError("UNAUTHORIZED", `${c.realm}: no token in the answer`);
      res = await send();
    }
    if (!res.ok && !allow.includes(res.status)) throw new OciError(res.status === 404 ? "NOT_FOUND" : "HTTP", `${url}: ${res.status}`);
    return res;
  }
  return {ref: parsed, request, get: (path, headers) => request(path, {headers})};
}

const JSON_LIMIT = 4 * 1024 * 1024;

/** Check headers before reading, and cancel before retaining an oversized chunk. */
async function boundedBody(res, cap) {
  const length = res.headers.get("content-length");
  const encoding = res.headers.get("content-encoding");
  if ((!encoding || encoding.toLowerCase() === "identity") && length !== null && Number(length) > cap) {
    await res.body?.cancel();
    throw new OciError("SIZE_MISMATCH", `body exceeds ${cap} bytes`);
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel();
        throw new OciError("SIZE_MISMATCH", `body exceeds ${cap} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

/**
 * The manifest (or index) a reference names, verified: {digest, mediaType,
 * json, bytes}. A tag is resolved only with resolve: true.
 */
export async function manifest(ref, options = {}) {
  const c = options.client ?? client(ref, options);
  const {tag, digest} = c.ref;
  if (!digest && options.resolve !== true) throw new OciError("TAG_ONLY", `${formatRef({...c.ref, digest: `:${tag}`})}: a tag can move; pin a digest (resolve it with --resolve)`);
  const res = await c.get(`manifests/${digest ?? tag}`, {accept: ACCEPT});
  const bytes = await boundedBody(res, JSON_LIMIT);
  const actual = sha256(bytes);
  if (digest && actual !== digest) throw new OciError("DIGEST_MISMATCH", `manifest of ${c.ref.repository}: expected ${digest}, got ${actual}`);
  const json = JSON.parse(bytes.toString("utf8"));
  return {digest: actual, mediaType: json.mediaType ?? res.headers.get("content-type"), json, bytes};
}

/** one blob by its descriptor, verified and kept by digest under cacheDir */
export async function blob(ref, descriptor, options = {}) {
  const c = options.client ?? client(ref, options);
  const {digest, size} = descriptor;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new OciError("BAD_DESCRIPTOR", `blob digest ${digest}`);
  if (!Number.isSafeInteger(size) || size < 0) throw new OciError("BAD_DESCRIPTOR", `blob size ${size}`);
  const cap = Math.min(size, options.maxSize ?? size);
  if (size > cap) throw new OciError("SIZE_MISMATCH", `blob ${digest}: exceeds ${cap} bytes`);
  const file = options.cacheDir ? join(options.cacheDir, "blobs", "sha256", digest.slice(7)) : undefined;
  if (file && existsSync(file) && statSync(file).size === size) {
    // Read at most size even if another process replaces/grows the cache file.
    const fd = openSync(file, "r");
    try {
      if (fstatSync(fd).size === size) {
        const cached = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const count = readSync(fd, cached, offset, size - offset, offset);
          if (!count) break;
          offset += count;
        }
        if (offset === size && fstatSync(fd).size === size && sha256(cached) === digest) return cached;
      }
    } finally { closeSync(fd); }
  }
  const bytes = await boundedBody(await c.get(`blobs/${digest}`), cap);
  if (typeof size === "number" && bytes.length !== size) throw new OciError("SIZE_MISMATCH", `blob ${digest}: expected ${size} bytes, got ${bytes.length}`);
  if (sha256(bytes) !== digest) throw new OciError("DIGEST_MISMATCH", `blob ${digest}: content hashes to ${sha256(bytes)}`);
  if (file) {
    mkdirSync(join(file, ".."), {recursive: true});
    const temp = `${file}.${process.pid}.pending`;
    writeFileSync(temp, bytes);
    renameSync(temp, file);
  }
  return bytes;
}

/** a manifest and every layer blob in it: {manifest, layers: [{descriptor, bytes}]} */
export async function pull(ref, options = {}) {
  const c = client(ref, options);
  const m = await manifest(ref, {...options, client: c});
  if (m.json.manifests) throw new OciError("IS_INDEX", `${formatRef({...c.ref, digest: m.digest})} is an index; pull its manifests one by one`);
  const descriptor = m.json.config;
  if (!descriptor || descriptor.size <= 0) throw new OciError("BAD_DESCRIPTOR", "config must have a positive size");
  const empty = descriptor.mediaType === "application/vnd.oci.empty.v1+json";
  if (empty && (descriptor.digest !== "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" || descriptor.size !== 2)) {
    throw new OciError("BAD_DESCRIPTOR", "invalid OCI empty config descriptor");
  }
  const config = empty ? undefined : JSON.parse((await blob(ref, descriptor,
    {...options, client: c, maxSize: JSON_LIMIT})).toString("utf8"));
  const layers = [];
  for (const descriptor of m.json.layers ?? []) layers.push({descriptor, bytes: await blob(ref, descriptor, {...options, client: c})});
  return {manifest: m, config, layers};
}

/** Upload verified bytes, mounting from another repository when possible. */
export async function pushBlob(ref, bytes, options = {}) {
  const c = options.client ?? client(ref, {...options, push: true});
  const digest = sha256(bytes);
  const head = await c.request(`blobs/${digest}`, {method: "HEAD", allow: [404]});
  if (head.ok) return digest;
  const mount = options.from ? `?mount=${digest}&from=${encodeURIComponent(options.from)}` : "";
  const start = await c.request(`blobs/uploads/${mount}`, {method: "POST"});
  if (start.status === 201) return digest;
  const location = start.headers.get("location");
  if (!location) throw new OciError("BAD_UPLOAD", "registry omitted upload Location");
  const url = new URL(location, base(c.ref) + `${c.ref.repository}/blobs/uploads/`);
  url.searchParams.set("digest", digest);
  await c.request(url.href, {method: "PUT", body: bytes, headers: {"content-type": "application/octet-stream"}});
  return digest;
}

/** PUT by tag or digest; the result is always the digest of the exact bytes. */
export async function pushManifest(ref, bytes, options = {}) {
  if (bytes.length > JSON_LIMIT) throw new OciError("SIZE_MISMATCH", "manifest exceeds 4 MiB");
  const c = options.client ?? client(ref, {...options, push: true});
  const digest = sha256(bytes);
  if (c.ref.digest && c.ref.digest !== digest) throw new OciError("DIGEST_MISMATCH", "manifest does not match destination digest");
  await c.request(`manifests/${c.ref.digest ?? c.ref.tag}`, {method: "PUT", body: bytes,
    headers: {"content-type": JSON.parse(bytes).mediaType}});
  return digest;
}

/** Push a built layer's blobs followed by its manifest. */
export async function push(ref, layer, options = {}) {
  const c = client(ref, {...options, push: true});
  for (const bytes of [layer.configBytes, layer.zip]) await pushBlob(ref, bytes, {...options, client: c});
  return pushManifest(ref, layer.manifestBytes, {...options, client: c});
}
