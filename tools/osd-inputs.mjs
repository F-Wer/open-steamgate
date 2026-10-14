import {activeSystem, layerDir} from "./osd-system.mjs";
// The layers of the system: what the transpiler is given, in what order,
// and who wins when two folders hold the same object.
//
// The order is the input_folder list plus discovered packs immediately
// before `gen/`, and the LATER folder wins, the way a layer does. That is what the
// transpiler does on its own when it is handed the same class twice
// (measured 2026-09-16 over a two-folder tree: the module written last is
// the later folder's; abaplint's registry in memory files the first as the
// main file and calls the second "already defined", so nothing about a
// duplicate is safe to leave to it), what Alice's formulation of backlog
// 1.5 says, and what the object store now does (tools/osd-store.mjs
// rootsOf reads the same list; ours-over-a-library's still holds, because a
// library is not a layer and never wins over an input). The builder hands
// the transpiler the winner only: every file of a hidden object goes into
// the build's exclude_filter (tools/osd-build.mjs), so what runs is decided
// here and not by which file the transpiler happened to write last. The
// same file name twice inside ONE folder, where no order can decide,
// refuses the build with both files named.
//
// Two more ways to edit ABAP and change nothing, both of which cost a day:
// a folder that looks like an input and is not (local/vivid-vibes beside
// local/o4d, only the latter listed: 237 files, an edit there transpiles
// nothing and reports nothing), and an object hidden by a later layer.
// Neither is an error; both are said out loud, here and in the builder's
// log.
import {readFileSync, readdirSync, statSync, existsSync} from "node:fs";
import {basename, resolve} from "node:path";
import {inputFoldersOf} from "./osd-packs.mjs";
import {runsAs} from "./osd-main.mjs";

// The tree this file lives in, resolved on FIRST USE rather than at module
// scope.
//
// `fileURLToPath` is not in the browser polyfill for `node:url` -- the
// polyfill has `Url`, `format`, `parse`, `resolve`, `resolveObject` and
// nothing else -- and this module reached the service worker's graph the day
// the editor's destination imported `objectOf` from it. A call at module
// scope is evaluated by the bundler's target whether or not anybody calls
// the function, so the preview build failed on an export that is never used
// in a browser (2026-09-19; the second time this module's arrival in that
// graph broke Pages, the first being the object store itself).
//
// Reading it lazily also states the truth: a browser has no tree, so the
// question has no answer there and is never asked.
let ROOT;
const treeRoot = () => {
  if (ROOT === undefined) {
    // decodeURIComponent, not fileURLToPath: node:url in the preview bundle
    // has no fileURLToPath, and a tree under "Application Support" arrives
    // as "%20" in a URL.
    ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
  }
  return ROOT;
};

/** the abapGit object a file belongs to: zcl_x.clas.abap and zcl_x.clas.xml are one object */
export function objectOf(filename) {
  // <name>.<type>[.<member>].<ext>; the type is the four-character abapGit kind
  if ([".osd-source.json", ".osd-layer.json", ".osd-system.json"].includes(filename)) return undefined;
  const parts = filename.split(".");
  if (parts.length < 3) {
    return undefined;
  }
  // abapGit writes the dot of ZORK-MINI.Z3 as %2e and a real per cent as
  // %25, so decoding gives the object's own name back; a name that is not
  // valid escaping is taken as it stands rather than thrown over
  let name = parts[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    // as it stands
  }
  return `${parts[1].toUpperCase()} ${name.toUpperCase()}`;
}

// every file of a folder that belongs to an object, the paths relative to
// the base and written with forward slashes, the way the transpiler globs
// them. A package file (package.devc.xml) belongs to its folder rather than
// to a name, so it is no object here and never a duplicate.
// the trace sidecar of a web page (Component.js.trace.json, manifest.json.trace.json):
// the name has three parts and reads like an object, and two generated apps in one
// input both have one (a set's run cockpit and its Set app, DSL L3 slice 6a); a page
// is no ABAP object, and neither is its sidecar
const WEB_SIDECAR = /\.(js|html?|json|properties|css)\.trace(?:\.meta)?\.json$/i;
export function filesIn(base, folder) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(resolve(base, dir)).sort()) {
      const path = `${dir}/${entry}`;
      if (statSync(resolve(base, path)).isDirectory()) {
        walk(path);
      } else if (/\.devc\.xml$/i.test(entry) === false && WEB_SIDECAR.test(entry) === false) {
        const object = objectOf(entry);
        if (object !== undefined) {
          out.push({file: path, name: entry, object});
        }
      }
    }
  };
  if (existsSync(resolve(base, folder))) {
    walk(folder);
  }
  return out;
}

// the layers as the config lists them, resolved: which folder owns each
// object, which files an earlier layer hides, and where nothing decides
export function layers(base, config = JSON.parse(readFileSync(resolve(base, "abap_transpile.json"), "utf8")), env = process.env) {
  // the config lists the tree's own folders; a pack is a directory found
  // at start and layered after them (tools/osd-packs.mjs, backlog E.2)
  const folders = inputFoldersOf(base, config.input_folder === undefined ? {input_folder: config.input_folders} : config, env);
  const byFolder = folders.map((folder) => ({folder, files: filesIn(base, folder)}));
  // the same file name twice inside one folder: no order decides, so nothing does
  const duplicates = [];
  for (const {folder, files} of byFolder) {
    const byName = new Map();
    for (const {file, name} of files) {
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
    for (const [name, paths] of byName) {
      if (paths.length > 1) {
        duplicates.push({object: objectOf(name), folder, files: paths});
      }
    }
  }
  // across folders the latest wins, and every file of the object in an
  // earlier folder is hidden, the XML and the includes with the source
  const owner = new Map();
  const all = new Map();
  for (const {folder, files} of byFolder) {
    for (const {file, object} of files) {
      owner.set(object, folder);
      all.set(object, [...(all.get(object) ?? []), {folder, file}]);
    }
  }
  const overridden = [];
  const hidden = [];
  for (const [object, files] of all) {
    const winner = owner.get(object);
    const losers = files.filter((f) => f.folder !== winner).map((f) => f.file);
    if (losers.length > 0) {
      overridden.push({object, winner, hidden: losers});
      hidden.push(...losers);
    }
  }
  // a folder beside the inputs that holds objects the inputs also hold, and
  // is not an input itself
  const shadows = [];
  const container = resolve(base, "local");
  if (existsSync(container)) {
    for (const entry of readdirSync(container).sort()) {
      const candidate = `local/${entry}`;
      if (folders.includes(candidate) || statSync(resolve(base, candidate)).isDirectory() === false) {
        continue;
      }
      const objects = new Set(filesIn(base, candidate).map((f) => f.object));
      const shared = [...objects].filter((o) => owner.has(o));
      if (objects.size > 0) {
        shadows.push({folder: candidate, total: objects.size, shared});
      }
    }
  }
  return {folders, owner, overridden, hidden, duplicates, shadows, total: owner.size};
}

// the exclude_filter lines that keep hidden files from the transpiler: one
// anchored pattern per file, matched against the path it globs
export function excludePatterns(hidden) {
  return hidden.map((file) => `(^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

// what a duplicate says when the build refuses over it
export function describeDuplicates(duplicates) {
  return duplicates.map((d) => `${d.object} is in ${d.folder} twice, and no order decides: ${d.files.join(", ")}`).join("; ");
}

export function report(configPath = undefined, options = {}) {
  const base = options.root ?? treeRoot();
  configPath = configPath ?? resolve(base, "abap_transpile.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const {folders, overridden, hidden, duplicates, shadows, total} = layers(base, config);
  return {folders, clashes: overridden, hidden, duplicates, shadows, total};
}

function main() {
  const {folders, clashes, duplicates, shadows, total} = report();
  console.log(`Inputs: ${folders.join(", ")} — ${total} objects, the later folder wins`);
  for (const {object, winner, hidden} of clashes) {
    console.log(`  overridden: ${object}: ${hidden.join(", ")} hidden by ${winner}`);
  }
  for (const duplicate of duplicates) {
    console.log(`  duplicate: ${describeDuplicates([duplicate])} — the build refuses`);
  }
  for (const {folder, total: count, shared} of shadows) {
    const also = shared.length === 0 ? "none of them in the build" : `${shared.length} of them also in the build`;
    console.log(`  not an input: ${folder} holds ${count} objects, ${also}. Edits there change nothing`);
  }
}

if (runsAs("osd-inputs.mjs")) {
  main();
}

// ---------------------------------------------------------------- libraries

/**
 * Which files each configured library contributes, by the build's own rules:
 * the folder, its `files` patterns (default `/src/**`), its
 * `exclude_filter`, and never a library's test classes.
 *
 * It lives here rather than in the transpile wrapper because **two lists
 * obliged to agree had diverged**. `tools/osd-store.mjs` carried a
 * hand-written `DEFAULT_LIBS` of three folders while `abap_transpile.json`
 * configured six, so the abaplint registry the store builds could not see
 * `open-abap-apc`, `abapgit` or `open-abap-gui`. Everything compiled and ran;
 * only the *check* was wrong, and it was wrong in the direction that costs
 * most -- it told a person their class was broken. Alice found it on the
 * deployed editor, on two classes at once: `Super class
 * "cl_apc_wsp_ext_stateful_base" not found or contains errors`, where the
 * superclass is in a library the build reads and the store did not
 * (2026-09-19).
 *
 * A lib with no folder on disk is skipped rather than cloned: the transpile
 * may clone a URL-only library, a store asked for one object may not.
 */
export function libraryFiles(root = process.cwd(), config = undefined) {
  // a tree with no config configures no libraries -- which is a tree that is
  // not this one (a fixture, a fresh folder), and asking it for libraries is
  // a question with an empty answer rather than an error
  let cfg = config;
  if (cfg === undefined) {
    const file = resolve(root, "abap_transpile.json");
    if (existsSync(file) === false) {
      return [];
    }
    cfg = JSON.parse(readFileSync(file, "utf8"));
  }
  const out = [];
  const system = activeSystem(root);
  for (const lib of cfg.libs ?? []) {
    if (lib.folder === undefined || lib.folder === "") continue;
    const layer = system?.layers.find(l => l.kind === "lib" && l.name === lib.folder.replaceAll("\\", "/").split("/").at(-1));
    if (system && !layer) throw new Error(`system does not provide library ${lib.folder}`);
    const dir = system ? layerDir(root, layer) : resolve(root, "." + lib.folder);
    if (existsSync(dir) === false) continue;
    const patterns = typeof lib.files === "string" && lib.files !== ""
      ? [lib.files]
      : Array.isArray(lib.files) ? lib.files : ["/src/**"];
    const exclude = (lib.exclude_filter ?? []).map((p) => new RegExp(p, "i"));
    const base = dir.split("/").join("/");
    const rules = patterns.map((p) => globToRegExp(base + p));
    const files = walkFiles(dir)
      .filter(f => !system || ![".osd-layer.json", ".abapgit.xml"].includes(basename(f)))
      .filter((f) => rules.some((r) => r.test(f)))
      .filter((f) => f.endsWith(".clas.testclasses.abap") === false)
      .filter((f) => exclude.length === 0 || exclude.some((r) => r.test(f)) === false);
    out.push({folder: lib.folder, dir, files});
  }
  return out;
}

/** "/src/**" and "/src/git/zcl_abapgit_git_pack.*": ** is any depth, * stays
 *  inside a segment. The same reading tools/osd-transpile.mjs does. */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules" || entry === "output") continue;
    const full = dir + "/" + entry;
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}
