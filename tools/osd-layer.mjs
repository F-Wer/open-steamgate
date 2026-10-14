// Reproducible abapGit layers and ordered OCI systems (docs/oci-layers.md).
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {abapgitXml, zipFiles} from "./osd-abapgit-zip.mjs";
import {archiveFiles} from "./osd-source-zip.mjs";
import {MEDIA, OciError, blob, client, formatRef, manifest, parseRef, pull, push, pushBlob, pushManifest, sha256, treeDigest} from "./osd-oci.mjs";
import {toolCommand} from "./osd-host.mjs";
import {runsAs} from "./osd-main.mjs";

const LAYER = "application/vnd.osd.layer.v1";
const SYSTEM = "application/vnd.osd.system.v1";
const CONFIG = "application/vnd.osd.layer.config.v1+json";
const ZIP = "application/vnd.osd.abapgit.zip";
const NAME = "org.osd.layer.name", KIND = "org.osd.layer.kind", ORDER = "org.osd.layer.order";
const jsonBytes = (value) => Buffer.from(JSON.stringify(value));
const descriptor = (mediaType, bytes) => ({mediaType, digest: sha256(bytes), size: bytes.length});
const fail = (code, message) => { throw new OciError(code, message); };

/** Read every file, without following links or carrying fetch identity. */
function folderFiles(folder) {
  const files = [];
  const walk = (path) => {
    const full = join(folder, path), st = lstatSync(full);
    if (path.split("/").includes(".osd-source.json")) fail("RESERVED_NAME", ".osd-source.json cannot be published");
    if (st.isDirectory()) {
      for (const name of readdirSync(full).sort()) walk(path ? `${path}/${name}` : name);
    } else if (st.isFile()) files.push({path, bytes: readFileSync(full)});
    else fail("UNSAFE_ENTRY", `${path}: only regular files and directories are allowed`);
  };
  walk("");
  return files;
}

export function build(folder, {name, kind, source} = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name ?? "")) fail("BAD_NAME", "--name must be a simple filename");
  if (!["lib", "input", "pack", "customer"].includes(kind)) fail("BAD_KIND", "--kind must be lib, input, pack or customer");
  if (!lstatSync(resolve(folder)).isDirectory()) fail("UNSAFE_ENTRY", "input must be a folder");
  let files = folderFiles(resolve(folder));
  if (!files.some((f) => f.path === ".abapgit.xml")) {
    files = [{path: ".abapgit.xml", bytes: Buffer.from(abapgitXml())}, ...files.map((f) => ({...f, path: `src/${f.path}`}))];
  }
  const config = {schema: 1, name, kind, treeDigest: treeDigest(files.map(({path, bytes}) => [path, bytes]))};
  const annotations = {[NAME]: name, [KIND]: kind};
  if (source) {
    const m = /^(.+)@([^@:]+):(.+)$/.exec(source);
    if (!m) fail("BAD_SOURCE", "--source must be repo@commit:path");
    config.source = {repo: m[1], commit: m[2], path: m[3]};
    annotations["org.opencontainers.image.source"] = m[1];
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const zip = zipFiles(files), configBytes = jsonBytes(config);
  // Apply the pull reader's path, collision and size rules before publishing.
  archiveFiles(zip);
  const manifest = {schemaVersion: 2, mediaType: MEDIA.manifest, artifactType: LAYER,
    config: descriptor(CONFIG, configBytes), layers: [{...descriptor(ZIP, zip),
      annotations: {"org.opencontainers.image.title": `${name}.zip`}}], annotations};
  const manifestBytes = jsonBytes(manifest);
  return {zip, config, configBytes, manifest, manifestBytes, digest: sha256(manifestBytes), files};
}

/** Scan the exact publishable tree and metadata, before the first write. */
export function leakGate(trees, metadata) {
  const temp = mkdtempSync(join(tmpdir(), "osd-layer-scan-"));
  try {
    const paths = [];
    for (const [i, files] of trees.entries()) {
      for (const {path, bytes} of files) {
        const file = join(temp, `tree-${i}`, path);
        mkdirSync(dirname(file), {recursive: true});
        writeFileSync(file, bytes);
        paths.push(file);
      }
    }
    const metadataFile = join(temp, "metadata.json");
    writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
    // Explicit files also cover content under .git or node_modules, which
    // the scanner skips when recursively discovering a folder.
    paths.push(metadataFile);
    const [command, ...args] = toolCommand("tools/osd-leak-scan.mjs", ["--redact", "--paths", ...paths]);
    const result = spawnSync(command, args, {encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
    if (result.error || result.status !== 0) fail("LEAK", "publish refused: leak scan failed or identifier list is missing");
  } finally { rmSync(temp, {recursive: true, force: true}); }
}

function validateLayer(layer) {
  const m = layer.manifest.json, c = layer.config;
  if (m.schemaVersion !== 2 || m.mediaType !== MEDIA.manifest || m.artifactType !== LAYER || m.config?.mediaType !== CONFIG
    || m.layers?.length !== 1 || m.layers[0].mediaType !== ZIP || c?.schema !== 1
    || !["lib", "input", "pack", "customer"].includes(c.kind) || typeof c.name !== "string"
    || m.annotations?.[NAME] !== c.name || m.annotations?.[KIND] !== c.kind
    || m.layers[0].annotations?.["org.opencontainers.image.title"] !== `${c.name}.zip`) fail("BAD_LAYER", "invalid OSD layer");
  const files = [...archiveFiles(layer.layers[0].bytes)].map(([path, bytes]) => ({path, bytes}));
  if (files.some(({path}) => path.split("/").includes(".osd-source.json"))) fail("RESERVED_NAME", ".osd-source.json cannot be published");
  if (treeDigest(files.map(({path, bytes}) => [path, bytes])) !== c.treeDigest) fail("TREE_MISMATCH", "layer treeDigest does not match its ZIP");
  return files;
}

/** Sort by declared order, refusing gaps, duplicates and ambiguous ordering. */
export function systemLayers(index) {
  if (index.schemaVersion !== 2 || index.mediaType !== MEDIA.index || index.artifactType !== SYSTEM || !Array.isArray(index.manifests)) fail("BAD_SYSTEM", "expected an OSD system index");
  const layers = [...index.manifests].sort((a, b) => Number(a.annotations?.[ORDER]) - Number(b.annotations?.[ORDER]));
  layers.forEach((d, i) => {
    if (d.annotations?.[ORDER] !== String(i) || d.mediaType !== MEDIA.manifest || !d.annotations?.[NAME] || !d.annotations?.[KIND]) fail("BAD_ORDER", "system layer orders must be contiguous starting at 0");
  });
  return layers;
}

function systemAnnotations(root) {
  const out = {};
  try { out["org.osd.osg.commit"] = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim(); }
  catch { /* A source distribution can have no Git metadata. */ }
  const lock = join(root, "libs.lock.json");
  if (existsSync(lock)) {
    const {transpiler} = JSON.parse(readFileSync(lock, "utf8"));
    out["org.osd.transpiler"] = `${transpiler.repo}@${transpiler.ref}`;
  }
  return out;
}

export async function pushSystem(target, refs, options = {}) {
  if (!refs.length) fail("BAD_SYSTEM", "a system needs at least one layer");
  const dest = parseRef(target), layers = [];
  for (const ref of refs) {
    if (!parseRef(ref).digest) fail("TAG_ONLY", "system layers must be digest references");
    const layer = await pull(ref, options);
    layers.push({ref, layer, files: validateLayer(layer)});
  }
  const index = {schemaVersion: 2, mediaType: MEDIA.index, artifactType: SYSTEM,
    manifests: layers.map(({layer}, i) => ({...descriptor(MEDIA.manifest, layer.manifest.bytes),
      annotations: {[NAME]: layer.config.name, [KIND]: layer.config.kind, [ORDER]: String(i)}})),
    annotations: systemAnnotations(options.root ?? process.env.OSD_ROOT ?? process.cwd())};
  leakGate(layers.map((l) => l.files), [index, ...layers.map(({layer}) => ({manifest: layer.manifest.json, config: layer.config}))]);
  const c = client(target, {...options, push: true});
  for (const {ref, layer} of layers) {
    const src = parseRef(ref);
    if (src.registry === dest.registry && src.repository === dest.repository) continue;
    for (const d of [layer.manifest.json.config, ...layer.manifest.json.layers]) {
      const bytes = await blob(ref, d, options);
      await pushBlob(target, bytes, {...options, client: c, from: src.registry === dest.registry ? src.repository : undefined});
    }
    await pushManifest(formatRef({...dest, digest: layer.manifest.digest}), layer.manifest.bytes, options);
  }
  return pushManifest(target, jsonBytes(index), {...options, client: c});
}

export async function inspect(ref, options = {}) {
  const m = await manifest(ref, {...options, resolve: true});
  const layerSummary = async (ref, expectedSize) => {
    const layer = await pull(ref, options);
    validateLayer(layer);
    if (expectedSize !== undefined && layer.manifest.bytes.length !== expectedSize) fail("SIZE_MISMATCH", "index manifest descriptor size differs from layer manifest");
    return {digest: layer.manifest.digest, ...layer.config};
  };
  if (m.json.mediaType !== MEDIA.index) return layerSummary(formatRef({...parseRef(ref), digest: m.digest}));
  const layers = [];
  for (const d of systemLayers(m.json)) {
    const summary = await layerSummary(formatRef({...parseRef(ref), digest: d.digest}), d.size);
    if (summary.name !== d.annotations[NAME] || summary.kind !== d.annotations[KIND]) fail("BAD_LAYER", "index identity differs from layer config");
    layers.push(summary);
  }
  return {digest: m.digest, artifactType: SYSTEM, annotations: m.json.annotations, layers};
}

export async function main(args) {
  const [command, ...rest] = args;
  if (command === "inspect" && rest.length === 1) {
    console.log(JSON.stringify(await inspect(rest[0]), null, 2));
    return 0;
  }
  if (command === "system" && rest[0] === "push") {
    const digest = await pushSystem(rest[1], rest.slice(2));
    console.log(formatRef({...parseRef(rest[1]), digest}));
    return 0;
  }
  if (!["build", "push"].includes(command)) fail("USAGE", "expected build, push, system push or inspect");
  const positionals = [], options = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      if (!["name", "kind", "source", "out"].includes(key) || !rest[i + 1] || rest[i + 1].startsWith("--")) fail("USAGE", `invalid option ${rest[i]}`);
      options[key] = rest[++i];
    } else positionals.push(rest[i]);
  }
  if (positionals.length !== (command === "push" ? 2 : 1)) fail("USAGE", "expected a folder (and a destination for push)");
  if (command === "build" && !options.out) fail("USAGE", "build needs --out");
  const layer = build(positionals.at(-1), options);
  if (command === "build") {
    mkdirSync(options.out, {recursive: true});
    for (const [name, bytes] of [[`${options.name}.zip`, layer.zip], ["config.json", layer.configBytes], ["manifest.json", layer.manifestBytes]]) writeFileSync(join(options.out, name), bytes);
    console.log(`treeDigest ${layer.config.treeDigest}\nmanifest ${layer.digest}`);
  } else {
    leakGate([layer.files], {config: layer.config, manifest: layer.manifest});
    const digest = await push(positionals[0], layer);
    console.log(formatRef({...parseRef(positionals[0]), digest}));
  }
  return 0;
}

if (runsAs("osd-layer.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`osd-layer: ${error.code ?? "ERROR"}: ${error.message}`);
    process.exit(error.code === "LEAK" ? 2 : 1);
  });
}
