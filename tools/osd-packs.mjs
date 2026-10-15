import {userLayersOf} from "./osd-source-layers.mjs";
import {cockpitAppsOf} from "./osd-cockpit-apps.mjs";
// A pack is a directory, not a rebuild (backlog E.2).
//
// The split document's promise: content packs are directories the binary
// reads at start, so a pack is added without rebuilding anything. A pack is
// (ABAP folder, seed rows, a webapp, a manifest naming it) — the shape the
// demo already has inside this tree, made explicit and movable outside it.
//
// One directory with an osd-pack.json in it:
//
//   packs/zork/
//     osd-pack.json      {"name": "zork", "description": "…"}
//     src/               ABAP, abapGit-named, the pack's layer
//     src/ddic/          the tables its seed rows belong to (optional)
//     data/              *.tabu.json seed rows (optional)
//     webapp/            static files, served under /app/<name> (optional)
//
// A pack may fetch a folder instead of carrying it: "sources" in the
// manifest names a repository, a commit and a path, and tools/osd-fetch.mjs
// copies that into <pack>/<folder>. The pack's own src/ then layers over it
// (later wins), which is how a repository nobody here owns is run with the
// few files it needs changed, and how a public build gets the same content
// as a workstation without the content being in this repository.
//
// Found in <root>/packs/ and in every directory OSD_PACKS names (a pack
// itself, or a container of packs). The order is the manifest's `order`
// (default 100) then the name, and packs come after the tree's own input
// folders — so a pack wins a name it shares, the way any later layer does
// (tools/osd-inputs.mjs), and the build says so with both files named.
//
// Nothing here is compiled in: adding a directory and starting again is the
// whole procedure. The generation hash covers the input folders, so a new
// pack is a new generation, which is what it should be.
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import {basename, delimiter, isAbsolute, join, relative, resolve} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {parseRef} from "./osd-oci.mjs";
import {readLock} from "./osd-lock.mjs";
import {TMP_FOLDER, tmpDisabled} from "./osd-tmp.mjs";

export const MANIFEST = "osd-pack.json";
export const PACKS_DIR = "packs";

import {SOURCE, isSourceIdentity} from "./osd-source-identity.mjs";
export {SOURCE, isSourceIdentity} from "./osd-source-identity.mjs";

export function sourceOf(folder) {
  try { return JSON.parse(readFileSync(join(folder, SOURCE), "utf8")); }
  catch { return undefined; }
}

export const MARKER = ".osd-fetched.json";

export function markerOf(packDir) {
  try {
    return JSON.parse(readFileSync(join(packDir, MARKER), "utf8"));
  } catch {
    return {};
  }
}

export function sourceMatches(source, entry) {
  if (!entry || entry.path !== source.path
      || JSON.stringify(entry.exclude) !== JSON.stringify(source.exclude)) return false;
  return source.oci !== undefined
    ? entry.oci === source.oci && entry.repo === undefined && entry.ref === undefined
    : entry.oci === undefined && entry.repo === source.repo && entry.ref === source.ref;
}

const slash = (p) => p.split("\\").join("/");

/** Select one copy of each object from folders in layer order. Later folders win. */
export function winningByLayer(folders, entriesIn, keyOf) {
  const winners = new Map();
  for (const folder of folders) {
    for (const entry of entriesIn(folder)) {
      winners.set(keyOf(entry), entry);
    }
  }
  return [...winners.values()];
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** the directories to look in: <root>/packs, then what OSD_PACKS names */
export function placesOf(root, env = process.env) {
  const places = [join(root, PACKS_DIR)];
  for (const entry of (env.OSD_PACKS ?? "").split(delimiter).map((s) => s.trim()).filter((s) => s !== "")) {
    places.push(isAbsolute(entry) ? entry : join(root, entry));
  }
  return places;
}

/** one directory read as a pack, or undefined when it is not one */
export function packAt(root, dir) {
  const manifest = join(dir, MANIFEST);
  if (existsSync(manifest) === false) {
    return undefined;
  }
  let declared;
  try {
    declared = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    throw new BadPack(dir, error.message);
  }
  const name = String(declared.name ?? basename(dir)).toLowerCase();
  const inside = (value, fallback) => {
    const wanted = value ?? fallback;
    if (wanted === undefined || wanted === null || wanted === false) {
      return undefined;
    }
    const at = join(dir, wanted);
    return isDir(at) ? at : undefined;
  };
  // "abap" may name one folder or several; src/ is the abapGit default, and
  // a pack that is itself a repository folder says "." instead
  const declaredAbap = declared.abap === undefined ? undefined : [declared.abap].flat();
  const abap = (declaredAbap ?? ["src", "."]).map((f) => inside(f)).filter((f) => f !== undefined);
  // a folder the pack does not carry but fetches: a repository, a commit
  // and a path in it, copied into <pack>/<folder> by tools/osd-fetch.mjs.
  // Declared here so the pack is reproducible from its manifest alone, and
  // so a build can tell a folder nobody fetched from one that is not there
  const sources = [declared.sources ?? []].flat().filter((s) => s !== null && typeof s === "object").map((s) => {
    if (typeof s.folder !== "string" || s.folder === ""
        || (s.oci === undefined && typeof s.repo !== "string" && typeof s.lock !== "string")
        || (s.lock === undefined && s.repo === "")) {
      throw new BadPack(dir, "a source needs a folder and either a repo or a libs.lock.json library name");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.folder)) {
      throw new BadPack(dir, `source folder must be a single directory name: ${s.folder}`);
    }
    if (s.oci !== undefined) {
      if (typeof s.oci !== "string" || s.repo !== undefined || s.lock !== undefined || s.ref !== undefined) {
        throw new BadPack(dir, "an OCI source cannot also set repo, lock or ref");
      }
      try {
        const parsed = parseRef(s.oci);
        if (!parsed.digest || parsed.tag) throw new Error("pin host/repository@sha256:<64 hex>, without a tag");
      } catch (error) {
        throw new BadPack(dir, `OCI source: ${error.message}`);
      }
    }
    let repo = s.repo;
    let ref = String(s.ref ?? "main");
    if (s.lock !== undefined) {
      if (typeof s.lock !== "string" || s.repo !== undefined || s.ref !== undefined) {
        throw new BadPack(dir, "a locked source cannot also set repo or ref");
      }
      const pin = readLock(root).libraries.find((lib) => lib.folder === s.lock);
      if (pin === undefined) throw new BadPack(dir, `libs.lock.json has no library named ${s.lock}`);
      repo = `https://github.com/${pin.repo}.git`;
      ref = pin.ref;
    }
    return {
      folder: s.folder,
      dir: join(dir, s.folder),
      ...(s.oci === undefined ? {repo, ref} : {oci: s.oci}),
      path: String(s.path ?? "src").replace(/^\/+|\/+$/g, ""),
      // what not to copy, as regular expressions over the path inside the
      // repository folder: a GUI-bound program, a test class, a file loader
      exclude: [s.exclude ?? []].flat().map((e) => String(e)),
    };
  });
  return {
    root,
    sources,
    // absent folders and stale identities: an unfetched pack is a
    // different system, and it is said rather than built smaller
    missing: sources.filter((s) => !isDir(s.dir) || !sourceMatches(s, sourceOf(s.dir))),
    name,
    description: declared.description === undefined ? undefined : String(declared.description),
    dir,
    order: Number(declared.order ?? 100),
    // the package this pack's objects live in, so a tree shows a pack as a
    // package of its own rather than as "$SRC"
    package: String(declared.package ?? "$" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")),
    // one folder unless the manifest names several, in its order; "src" is
    // abapGit's default and "." is a pack that is itself a repository folder
    abap: declaredAbap === undefined ? abap.slice(0, 1) : abap,
    data: inside(declared.data, "data"),
    ddic: inside(declared.ddic, join(relative(dir, abap[0] ?? dir), "ddic")),
    webapp: inside(declared.webapp, "webapp"),
    // what the launchpad should show for this pack: a tile per entry, each
    // pointing at a URL this system serves (its own page, an app, an ICF
    // path). The launchpad asks for these at start, so a pack appears on it
    // without anybody editing webapp/flp.html.
    tiles: [declared.tiles ?? []].flat().filter((t) => t !== null && typeof t === "object").map((t, i) => {
      const type = ["static", "dynamic", "image"].includes(t.type) ? t.type : "static";
      return {
        id: String(t.id ?? `${name}-${i + 1}`),
        type,
        title: String(t.title ?? name),
        subtitle: t.subtitle === undefined ? undefined : String(t.subtitle),
        info: t.info === undefined ? undefined : String(t.info),
        icon: String(t.icon ?? "sap-icon://product"),
        url: String(t.url ?? `/app/${name}/`),
        enabled: t.enabled !== false,
        disabledReason: t.disabledReason === undefined ? undefined : String(t.disabledReason),
        requires: t.requires === undefined ? undefined : String(t.requires),
        serviceUrl: t.serviceUrl === undefined ? undefined : String(t.serviceUrl),
        serviceRefreshInterval: t.serviceRefreshInterval === undefined ? undefined : String(t.serviceRefreshInterval),
        numberUnit: t.numberUnit === undefined ? undefined : String(t.numberUnit),
        imageSource: t.imageSource === undefined ? undefined : String(t.imageSource),
      };
    }),
  };
}

/** every pack, in the order they are layered */
export function packsOf(root, env = process.env) {
  const found = new Map();
  for (const place of placesOf(root, env)) {
    if (isDir(place) === false) {
      continue;
    }
    const candidates = existsSync(join(place, MANIFEST)) ? [place] : readdirSync(place).sort().map((e) => join(place, e));
    for (const dir of candidates) {
      const pack = packAt(root, dir);
      if (pack === undefined) {
        continue;
      }
      // a pack named twice is the same pack found twice (a container listed
      // as well as its parent); the first place wins and nothing is doubled
      const previous = found.get(pack.name);
      if (previous !== undefined && resolve(previous.dir) !== resolve(pack.dir)) {
        throw new BadPack(dir, `pack name ${pack.name} is also used by ${previous.dir}`);
      }
      if (previous === undefined) found.set(pack.name, pack);
    }
  }
  // The web bundle runs transpilation and preview generation in child
  // processes; this selection must reach every consumer of pack inputs.
  const selected = env.OSD_WEB_PACKS;
  const names = selected?.split(",").map((name) => name.trim());
  const packs = selected === undefined || selected === "all"
    ? [...found.values()]
    : [...found.values()].filter((pack) => names.includes(pack.name));
  return packs.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** a pack's ABAP folder as the build and the store name it: root-relative */
export function folderOf(root, dir) {
  const rel = slash(relative(root, dir));
  return rel === "" ? "." : rel;
}

/** the layers: source, then every pack, then generated overlays.
 *
 * A pack must win over the tree's source when it deliberately replaces an
 * object, but `gen/` is not ordinary source: it contains rewritten forms of
 * source objects (notably AMDP bodies). Putting a pack after `gen/` made a
 * pack-local AMDP class hide its own runnable rewrite and handed raw
 * SQLScript to the ABAP transpiler. Insert packs immediately before `gen/`;
 * configs without a generated layer keep the original append behaviour. */
export function inputFoldersOf(root, config, env = process.env) {
  const listed = config?.input_folder === undefined ? [] : [config.input_folder].flat();
  const packs = packsOf(root, env).flatMap((p) => p.abap.map((f) => folderOf(root, f)));
  const added = packs.filter((f) => listed.includes(f) === false);
  const generated = listed.lastIndexOf("gen");
  const system = generated === -1
    ? [...listed, ...added]
    : [...listed.slice(0, generated), ...added, ...listed.slice(generated)];
  // $TMP (tools/osd-tmp.mjs) is a layer once something was created in it,
  // after the system and before the user's explicit layers.
  // OSD_TMP=off (a preview, a published build) leaves it out, listed or not.
  const tmp = !tmpDisabled(env) && existsSync(join(root, TMP_FOLDER)) && !system.includes(TMP_FOLDER) ? [TMP_FOLDER] : [];
  if (tmpDisabled(env)) {
    return [...system.filter((f) => f !== TMP_FOLDER), ...userFoldersOf(root, env).filter((f) => f !== TMP_FOLDER)];
  }
  // The user's explicit layers are last, including after generated overlays.
  // This is the same later-wins ordering as input_folder in the config.
  return [...system, ...tmp, ...userFoldersOf(root, env)];
}

export function userFoldersOf(root, env = process.env) {
  return userLayersOf(root, env).map(layer => layer.path);
}

/** the roots a pack adds to the object store, with the package each lives in */
export function packRootsOf(root, env = process.env) {
  return packsOf(root, env).flatMap((p) => p.abap.map((f) => ({
    path: folderOf(root, f), writable: true, library: false, imported: true, package: p.package, pack: p.name,
  })));
}

/** Project the build's ordered layers onto generator inputs. The transpiler
 * reads test/ for ABAP unit classes, but generators must skip its incomplete
 * fixtures (notably a CDS view without its table). Other configured folders,
 * including imports, retain their exact build precedence. */
export function generatorFoldersOf(root, env = process.env) {
  const file = join(root, "abap_transpile.json");
  const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {input_folder: ["src"]};
  return inputFoldersOf(root, config, env).filter((folder) => folder !== "test");
}

/** Content-only projection for generators that produce gen/. */
export function contentFoldersOf(root, env = process.env) {
  return generatorFoldersOf(root, env).filter((folder) => folder !== "gen");
}

/** every folder of seed rows: the tree's own, then each pack's */
export function dataDirsOf(root, env = process.env) {
  const own = join(root, "data");
  return [...(isDir(own) ? [own] : []), ...packsOf(root, env).map((p) => p.data).filter((d) => d !== undefined)];
}

/** every folder holding table definitions a seed row may need */
export function ddicDirsOf(root, env = process.env) {
  const own = ["src/ddic", "src/segw/ddic", "src/zosd_test/ddic"].map((d) => join(root, d));
  const folders = new Set([...own, ...packsOf(root, env).map((p) => p.ddic).filter((d) => d !== undefined)]);
  // Definitions can live beside a generated set or an imported layer, not
  // just in ddic/. The seed reader needs them to convert DATS and pad CHAR.
  const walk = (at) => {
    if (!isDir(at)) return;
    const entries = readdirSync(at, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.some((e) => e.name.endsWith(".tabl.xml"))) folders.add(at);
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) walk(join(at, e.name));
  };
  for (const folder of contentFoldersOf(root, env)) walk(resolve(root, folder));
  return [...folders];
}

/** every tile the packs ask the launchpad for, in pack order */
export function tilesOf(root, env = process.env) {
  return [...packsOf(root, env).flatMap((p) => p.tiles.map((t) => ({...t, pack: p.name, description: p.description}))),
    // a generated cockpit app may ask for its tile's kind, subtitle, icon and live number
    ...cockpitAppsOf(root, contentFoldersOf(root, env)).map((c) => ({id: c.app, title: c.title, pack: c.app, type: "static", icon: "sap-icon://process",
      url: `/app/${c.app}/index.html`, ...(c.tile ?? {})}))];
}

/** the static folders a pack brings, each served under /app/<name> */
export function webappsOf(root, env = process.env) {
  return [...packsOf(root, env).filter((p) => p.webapp !== undefined).map((p) => ({name: p.name, dir: p.webapp})), ...cockpitAppsOf(root, contentFoldersOf(root, env))];
}

export class BadPack extends Error {
  constructor(dir, why) {
    super(`${join(dir, MANIFEST)} is not readable as a pack: ${why}`);
    this.code = "BAD_PACK";
  }
}

function main(args) {
  const root = resolve(args[0] ?? process.cwd());
  const packs = packsOf(root);
  if (packs.length === 0) {
    console.log(`no packs: nothing in ${placesOf(root).map((p) => relative(root, p) || p).join(", ")}`);
    return 0;
  }
  for (const pack of packs) {
    const parts = [
      ...pack.abap.map((f) => `abap ${folderOf(root, f)}`),
      ...(pack.data ? [`data ${folderOf(root, pack.data)}`] : []),
      ...(pack.webapp ? [`webapp /app/${pack.name}`] : []),
    ];
    console.log(`${pack.name}  ${pack.package}  order ${pack.order}  ${parts.join(", ")}`);
    if (pack.description !== undefined) {
      console.log(`  ${pack.description}`);
    }
    for (const s of pack.sources) {
      const state = pack.missing.includes(s) ? "NOT FETCHED: node tools/osd-fetch.mjs" : "fetched";
      console.log(`  source ${s.folder} <- ${s.oci ?? `${s.repo} ${s.ref.slice(0, 12)}`} /${s.path}  (${state})`);
    }
  }
  return 0;
}

if (runsAs("osd-packs.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
