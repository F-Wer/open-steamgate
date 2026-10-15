// One installed index supplies the complete source closure. No Git or network here.
import {existsSync, readFileSync} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import {repositoryConfig, sourceFolder} from "./osd-abapgit-config.mjs";

export const SYSTEM_ID = ".osd-system.json";
export const LAYER_ID = ".osd-layer.json";
export const systemPath = (kind, name) => `${kind === "lib" ? "libs" : kind === "pack" ? "packs" : "inputs"}/${name}`;
const digest = /^sha256:[0-9a-f]{64}$/;
const name = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const fail = (message) => { const e = new Error(`system mode: ${message}`); e.code = "BAD_SYSTEM"; throw e; };

export function activeSystem(root, env = process.env) {
  const file = join(root, ".local/system", SYSTEM_ID);
  if (!existsSync(file)) return undefined;
  const system = JSON.parse(readFileSync(file, "utf8"));
  if (!digest.test(system.digest) || !Array.isArray(system.layers)) fail("invalid installed identity");
  const paths = new Set();
  system.layers.forEach((layer, order) => {
    if (layer.order !== order || typeof layer.name !== "string" || !name.test(layer.name) || !["lib", "input", "pack", "customer"].includes(layer.kind)
      || !digest.test(layer.digest) || !digest.test(layer.treeDigest) || layer.path !== systemPath(layer.kind, layer.name)
      || paths.has(layer.path)) fail("invalid installed layer identity/order");
    paths.add(layer.path);
    const identity = join(root, ".local/system", layer.path, LAYER_ID);
    if (!existsSync(identity) || JSON.stringify(JSON.parse(readFileSync(identity, "utf8"))) !== JSON.stringify(layer)) fail(`layer identity differs: ${layer.name}`);
  });
  for (const key of Object.keys(env)) {
    if (["OSD_PACKS", "OSD_WEB_PACKS", "OSD_LAYERS"].includes(key) || key.startsWith("OSD_LIB_")) {
      if (env[key] !== undefined) fail(`${key} is refused; the system digest supplies all layers`);
    }
  }
  if (existsSync(join(root, "local/tmp"))) fail("$TMP layer (local/tmp) is refused; the system digest supplies all layers");
  return system;
}

export const layerDir = (root, layer) => join(root, ".local/system", layer.path);
export const layerSource = (root, layer) => sourceFolder(layerDir(root, layer), repositoryConfig(layerDir(root, layer)));

// Logical paths preserve source-map paths and existing config selection rules.
export function logicalSystemPath(root, file, system = activeSystem(root) ?? null) {
  if (!system) return file;
  for (const layer of system.layers) {
    const dir = layerDir(root, layer);
    const rel = relative(dir, file).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../")) continue;
    if (layer.kind === "lib") return join(root, ".local/lars", layer.name, rel);
    if (layer.kind === "pack") return join(root, "packs", layer.name, rel);
    const src = relative(layerSource(root, layer), file).replaceAll("\\", "/");
    if (src !== ".." && !src.startsWith("../")) return join(root, layer.name, src);
    // The src repository layer can also carry its seed data and static pages.
    if (layer.kind === "input" && layer.name === "src") return join(root, rel);
  }
  return file;
}

export function systemFile(root, logical, env = process.env) {
  const system = activeSystem(root, env);
  if (!system) return resolve(root, logical);
  const actual = resolve(root, logical);
  if (isAbsolute(logical) || logical.startsWith(".local/system/") || logical.startsWith("gen/")) {
    const inside = dir => { const rel = relative(dir, actual); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
    if (system.layers.some(layer => inside(layerDir(root, layer))) || inside(join(root, "gen"))) return actual;
    fail(`content path is outside the installed system: ${logical}`);
  }
  if (logical.split("/").includes("..") || logical.includes("\\")) fail(`unsafe content path: ${logical}`);
  for (const layer of [...system.layers].reverse()) {
    const prefix = layer.kind === "pack" ? `packs/${layer.name}/`
      : layer.kind === "lib" ? `.local/lars/${layer.name}/` : undefined;
    if (prefix && logical.startsWith(prefix)) return join(layerDir(root, layer), logical.slice(prefix.length));
  }
  for (const layer of [...system.layers].reverse()) {
    if (!["input", "customer"].includes(layer.kind)) continue;
    const prefix = `${layer.name}/`;
    const file = logical.startsWith(prefix) ? join(layerSource(root, layer), logical.slice(prefix.length))
      : layer.kind === "input" && layer.name === "src" ? join(layerDir(root, layer), logical) : undefined;
    if (file && existsSync(file)) return file;
  }
  return join(root, ".local/system/.absent", logical);
}


// Pass the build's resolved system (null for a checkout), never probe per file.
export function matchesSourcePath(root, file, patterns, system = null) {
  const logical = logicalSystemPath(root, file, system);
  return patterns.some(rule => rule.test(logical));
}

/** Resolve a source-map's logical checkout path beside its generated module. */
export function sourceMapFile(generated, source) {
  const logical = resolve(dirname(generated), source);
  for (let root = dirname(generated); ; root = dirname(root)) {
    if (existsSync(join(root, ".local/system", SYSTEM_ID))) {
      const path = relative(root, logical);
      // A frame can name output/ through its symlink while the map is relative
      // to the real generation. An unavailable source must not break a dump.
      if (path === ".." || path.startsWith("../") || isAbsolute(path)) return undefined;
      return systemFile(root, path);
    }
    if (dirname(root) === root) return logical;
  }
}

/** The root launchpad belongs to the src input repository. */
export const rootWebappOf = (root, env = process.env) => systemFile(root, "webapp", env);
