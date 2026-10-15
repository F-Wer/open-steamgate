// Validate every byte before publishing one complete system directory.
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {manifest, parseRef, formatRef, pull, sha256, OciError} from "./osd-oci.mjs";
import {systemLayers, validateLayer} from "./osd-layer.mjs";
import {SYSTEM_ID, LAYER_ID, systemPath} from "./osd-system.mjs";
import {repositoryConfig, sourceFolder} from "./osd-abapgit-config.mjs";
import {warnSystemToolchain} from "./osd-system-toolchain.mjs";
const fail = (code, message) => { throw new OciError(code, message); };

function localBlob(base, d) {
  if (!/^sha256:[0-9a-f]{64}$/.test(d.digest)) fail("BAD_DIGEST", "invalid local descriptor digest");
  const bytes = readFileSync(join(base, "blobs/sha256", d.digest.slice(7)));
  if (bytes.length !== d.size || sha256(bytes) !== d.digest) fail("DIGEST_MISMATCH", "local blob differs from descriptor");
  return bytes;
}

export async function fetchSystem(root, ref, options = {}) {
  const log = options.log ?? (() => {});
  let index, load;
  if (existsSync(ref)) {
    const bytes = readFileSync(ref), base = dirname(resolve(ref));
    index = {json: JSON.parse(bytes), digest: sha256(bytes)};
    // OCI layout indexes can wrap one system index descriptor. Verify that
    // descriptor before following it; the installed identity is the system.
    if (!index.json.artifactType && index.json.manifests?.length === 1) {
      const d = index.json.manifests[0];
      if (d.mediaType === index.json.mediaType) {
        const bytes = localBlob(base, d);
        index = {json: JSON.parse(bytes), digest: d.digest};
      }
    }
    load = async d => {
      const bytes = localBlob(base, d), json = JSON.parse(bytes);
      const configBytes = localBlob(base, json.config);
      return {manifest: {json, bytes, digest: d.digest}, configBytes, config: JSON.parse(configBytes),
        layers: json.layers.map(descriptor => ({descriptor, bytes: localBlob(base, descriptor)}))};
    };
  } else {
    const parsed = parseRef(ref);
    if (!parsed.digest || parsed.tag) fail("TAG_ONLY", "a system needs a digest reference");
    index = await manifest(ref, options);
    load = d => pull(formatRef({...parsed, digest: d.digest}), options);
  }
  const descriptors = systemLayers(index.json);
  if (!descriptors.length) fail("BAD_SYSTEM", "a system needs at least one layer");
  const parent = join(root, ".local");
  mkdirSync(parent, {recursive: true});
  const stage = mkdtempSync(join(parent, ".osd-system-stage-"));
  const target = join(parent, "system"), old = stage.replace("-stage-", "-old-");
  try {
    const layers = [], paths = new Set();
    for (const d of descriptors) {
      const layer = await load(d), files = validateLayer(layer), c = layer.config;
      if (layer.manifest.bytes.length !== d.size) fail("SIZE_MISMATCH", "index layer size differs");
      if (c.name !== d.annotations["org.osd.layer.name"] || c.kind !== d.annotations["org.osd.layer.kind"]) fail("BAD_LAYER", "index identity differs from layer config");
      const path = systemPath(c.kind, c.name);
      if (paths.has(path)) fail("BAD_SYSTEM", `duplicate layer destination ${path}`);
      paths.add(path);
      const dir = join(stage, path);
      mkdirSync(dir, {recursive: true});
      for (const f of files) {
        mkdirSync(dirname(join(dir, f.path)), {recursive: true});
        writeFileSync(join(dir, f.path), f.bytes);
      }
      if (!existsSync(sourceFolder(dir, repositoryConfig(dir))) && ["input", "customer"].includes(c.kind)) fail("BAD_LAYER", `${c.name}: starting folder is absent`);
      const entry = {order: layers.length, name: c.name, kind: c.kind, digest: layer.manifest.digest, treeDigest: c.treeDigest, path};
      writeFileSync(join(dir, LAYER_ID), JSON.stringify(entry));
      layers.push(entry);
    }
    const identity = {digest: index.digest, annotations: index.json.annotations ?? {}, layers};
    writeFileSync(join(stage, SYSTEM_ID), JSON.stringify(identity, null, 2) + "\n");
    let moved = false;
    if (existsSync(target)) { renameSync(target, old); moved = true; }
    try { renameSync(stage, target); }
    catch (error) { if (moved) renameSync(old, target); throw error; }
    if (moved) {
      try { rmSync(old, {recursive: true, force: true}); }
      catch (error) { log(`warning: installed system; cleanup left ${old}: ${error.message}`); }
    }
    warnSystemToolchain(root, identity, log);
    log(`system ${identity.digest}: ${layers.length} layers`);
    return identity;
  } finally { rmSync(stage, {recursive: true, force: true}); }
}
