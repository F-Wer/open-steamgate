// Read installed source facts like lib.js reads pack manifests. The extension
// also works with older homes and never imports the checkout's tools modules.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function systemSourceMappings(root) {
  if (root === undefined) return undefined;
  const base = path.join(root, ".local/system");
  const identity = path.join(base, ".osd-system.json");
  if (!fs.existsSync(identity)) return undefined;
  const {layers} = JSON.parse(fs.readFileSync(identity, "utf8"));
  return [...layers].reverse().map(layer => {
    const source = path.join(base, layer.path);
    if (layer.kind === "pack") return {logical: path.join(root, "packs", layer.name), source};
    if (layer.kind === "lib") return {logical: path.join(root, ".local/lars", layer.name), source};
    const xml = path.join(source, ".abapgit.xml");
    const text = fs.existsSync(xml) ? fs.readFileSync(xml, "utf8") : "";
    const starting = /<STARTING_FOLDER>([^<]*)<\/STARTING_FOLDER>/i.exec(text)?.[1] ?? "/src/";
    const folder = starting.replace(/^\/+|\/+$/g, "");
    if (folder.includes("\\") || folder.split("/").includes("..") || /^[A-Za-z]:/.test(folder))
      throw new Error("unsafe installed starting folder");
    return {logical: path.join(root, layer.name), source: path.join(source, folder)};
  });
}

function installedSource(root, file, mappings) {
  if (mappings === undefined) return file;
  for (const {logical, source} of mappings) {
    const relative = path.relative(logical, file);
    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
      return path.join(source, relative);
  }
  // Generated sources and already installed paths keep their physical names.
  for (const dir of [path.join(root, "gen"), path.join(root, ".local/system")]) {
    const relative = path.relative(dir, file);
    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return file;
  }
  return undefined;
}

module.exports = {systemSourceMappings, installedSource};
