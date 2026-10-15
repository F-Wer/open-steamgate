// Unit discovery and one-run input overlays. Hide earlier objects before abaplint.
import {existsSync, readdirSync, statSync} from "node:fs";
import {join, basename} from "node:path";
import {inputFoldersOf} from "../osd-packs.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {activeSystem, matchesSourcePath} from "../osd-system.mjs";
import {objectOf} from "../osd-inputs.mjs";

const walk = (dir) => !existsSync(dir) ? [] : readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

export function unitInputs({home, config, fixture, extraInputs = [], env = process.env, extraPacks = true}) {
  for (const folder of extraInputs) if (!statSync(folder).isDirectory()) throw new Error(`--input is not a directory: ${folder}`);
  const sourceFolders = [...(fixture ? [fixture] : inputFoldersOf(home, config, env, {extraPacks}).map((f) => join(home, f))), ...extraInputs];
  const libDirs = ["open-abap-core/src", "express-icf-shim/src", "open-abap-apc/src", "open-abap-gui/src", "open-abap-gui/framework", "open-abap-odata/src", "ajson/src/core"]
    .map((x) => join(existsSync(join(home, "libs.lock.json")) ? libraryPath(home, x.split("/")[0]) : join(home, ".local/lars", x.split("/")[0]), x.slice(x.indexOf("/") + 1))).filter(existsSync);
  const folders = (extraInputs.length ? [...libDirs, ...sourceFolders] : [...sourceFolders, ...libDirs]).filter(existsSync);
  const hidden = new Set();
  const overrides = [];
  if (extraInputs.length) {
    const winner = new Map();
    const layers = folders.map((folder) => ({folder, files: walk(folder)}));
    for (const {folder, files} of layers) for (const file of files) {
      const object = objectOf(basename(file));
      if (object) winner.set(object, folder);
    }
    for (const {folder, files} of layers) for (const file of files) {
      const object = objectOf(basename(file));
      if (object && winner.get(object) !== folder) {
        hidden.add(file);
        const input = winner.get(object);
        if (extraInputs.includes(input) && !overrides.some((o) => o.object === object && o.hidden === folder))
          overrides.push({object, input, hidden: folder});
      }
    }
  }
  const system = activeSystem(home, env) ?? null;
  const excluded = (config.exclude_filter ?? []).map((p) => new RegExp(p));
  const skip = (file) => hidden.has(file) || matchesSourcePath(home, system ? file : "/" + file.slice(home.length + 1), excluded, system);
  // Last include wins, and an owner replaced without a test include loses its tests.
  const sources = [...new Map(sourceFolders.flatMap(walk).filter((file) => !skip(file)).map((file) => [basename(file), file])).values()]
    .filter((file) => file.endsWith(".clas.testclasses.abap") && !matchesSourcePath(home, file, [/\/test\/fixtures\//], system));
  return {sources, folders, libDirs, skip, overrides};
}
