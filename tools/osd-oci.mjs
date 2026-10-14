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
// OSD_OCI_TOKEN (GITHUB_TOKEN for ghcr.io) as basic credentials. localhost
// is spoken to over http, for tests.
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from "node:fs";
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
  if (!m || !/[.:]|^localhost$/.test(m[1]) || (!m[3] && !m[4])) throw new OciError("BAD_REF", `${ref}: expected host/repository@sha256:<64 hex> (or :tag to resolve)`);
  return {registry: m[1], repository: m[2], tag: m[3], digest: m[4]};
}

export function formatRef({registry, repository, digest}) {
  return `${registry}/${repository}@${digest}`;
}

const local = (registry) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(registry);
const base = ({registry}) => `${local(registry) ? "http" : "https"}://${registry}/v2/`;

function credentials(registry, env) {
  const user = env.OSD_OCI_USER ?? (registry === "ghcr.io" && env.GITHUB_TOKEN ? (env.GITHUB_ACTOR ?? "token") : undefined);
  const token = env.OSD_OCI_TOKEN ?? (registry === "ghcr.io" ? env.GITHUB_TOKEN : undefined);
  return user && token ? Buffer.from(`${user}:${token}`).toString("base64") : undefined;
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
  async function get(path, headers = {}) {
    const url = base(parsed) + `${parsed.repository}/${path}`;
    const send = () => fetchImpl(url, {headers: {...headers, ...(bearer ? {authorization: `Bearer ${bearer}`} : {})}, redirect: "follow"});
    let res = await send();
    if (res.status === 401 && !bearer) {
      const c = challenge(res.headers.get("www-authenticate"));
      if (!c) throw new OciError("UNAUTHORIZED", `${url}: 401 without a Bearer challenge`);
      const q = new URLSearchParams();
      if (c.service) q.set("service", c.service);
      q.set("scope", c.scope ?? `repository:${parsed.repository}:pull`);
      const basic = credentials(parsed.registry, env);
      const t = await fetchImpl(`${c.realm}?${q}`, {headers: basic ? {authorization: `Basic ${basic}`} : {}});
      if (!t.ok) throw new OciError("UNAUTHORIZED", `${c.realm}: token request answered ${t.status}`);
      const body = await t.json();
      bearer = body.token ?? body.access_token;
      if (!bearer) throw new OciError("UNAUTHORIZED", `${c.realm}: no token in the answer`);
      res = await send();
    }
    if (!res.ok) throw new OciError(res.status === 404 ? "NOT_FOUND" : "HTTP", `${url}: ${res.status}`);
    return res;
  }
  return {ref: parsed, get};
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
  const bytes = Buffer.from(await res.arrayBuffer());
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
  const file = options.cacheDir ? join(options.cacheDir, "blobs", "sha256", digest.slice(7)) : undefined;
  if (file && existsSync(file)) {
    const cached = readFileSync(file);
    if (sha256(cached) === digest) return cached;
  }
  const bytes = Buffer.from(await (await c.get(`blobs/${digest}`)).arrayBuffer());
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
  const config = m.json.config && m.json.config.size > 0 && m.json.config.mediaType !== "application/vnd.oci.empty.v1+json"
    ? JSON.parse((await blob(ref, m.json.config, {...options, client: c})).toString("utf8")) : undefined;
  const layers = [];
  for (const descriptor of m.json.layers ?? []) layers.push({descriptor, bytes: await blob(ref, descriptor, {...options, client: c})});
  return {manifest: m, config, layers};
}
