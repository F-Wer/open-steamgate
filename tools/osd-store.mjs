import {activeSystem} from "./osd-system.mjs";
import {repositoryConfig} from "./osd-abapgit-config.mjs";
import {userLayersOf, declaredPackage, rootPackage} from "./osd-source-layers.mjs";
import {packageChildName} from "./osd-object-name.mjs";
import {transpileStore} from "./osd-store-build.mjs";
import {deferSourceMutation} from "./osd-store-source-lock.mjs";
import {verifyNext} from "./osd-store-verify.mjs";
import {warmUp} from "./osd-store-warm.mjs";
import {activationJournal, recordBaselineGeneration, recordStoreGeneration} from "./osd-activation-journal.mjs";
// The object store of OSD, the off-stack doppelgänger: what sits behind
// the ADT façade. A client asks for an object by type and name; this finds
// the file, reads it, writes it, checks it and activates it. The façade
// above never touches the file system, this never parses HTTP.
//
// What an object is here: a file, the way abapGit names it, in this
// repository (src/, gen/) or in a library beside it (.local/lars/*, the
// open-abap clones), which is how OSD has a system's worth of content
// without anyone typing it. A library object is read-only, ours is not.
//
// What activation is: abaplint's syntax and semantic check over the whole
// registry, because a class that compiles alone can still break the system
// it is part of. The check returns the same shape for a write and for an
// activation, since the façade reports both the same way.
import {chmodSync, copyFileSync, readdirSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, watch, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {CREATABLE} from "./osd-store-create.mjs";
import {StoreVersions} from "./osd-store-versions.mjs";
import {buildRegistry, forgetRegistry, registryDependents, registryIssues, updateRegistryFiles, walkStoreFiles, withSource} from "./osd-store-registry.mjs";
import {warmCheck} from "./adt-warm-check.mjs";
import {entityOf} from "./ddls-entity.mjs";
import {inputFoldersOf, packRootsOf} from "./osd-packs.mjs";
import {libraryFiles} from "./osd-inputs.mjs";
import {hashOf, inputsOf, loadConfig, normalPath, liveHash} from "./osd-build.mjs";
import {TMP_FOLDER, TMP_TEXT, isTmpPackage, tmpAuthors, tmpRoot} from "./osd-tmp.mjs";
import {authorNow, checkName, indexTmp, noteAuthor, tmpChild, tmpDelete, tmpPackageFile, withTmp, writeCheck, writeChecked} from "./osd-store-tmp.mjs";
export {InvalidName} from "./osd-store-tmp.mjs";

import {basename, dirname, join, relative, resolve} from "node:path";
import {Data} from "./osd-data.mjs";
import {ServingRuntime} from "./osd-runtime.mjs";
import {RuntimePool} from "./osd-pool.mjs";
import {runsAs} from "./osd-main.mjs";

// a process that has taken this many warm swaps, or has been quiet this long
// after one, is replaced by one started on the live generation: every swap
// leaves its old module instances in the module map, and the start-up's own
// work (the init script's rows) is only done by a start
const WARM_SWAPS = Number(process.env.OSD_WARM_SWAPS ?? 25);
const WARM_QUIET_MS = Number(process.env.OSD_WARM_QUIET_MS ?? 60000);
// ... or whose heap has grown this much since its first swap
const WARM_HEAP_MB = Number(process.env.OSD_WARM_HEAP_MB ?? 512);
// how long a publish waits for a runtime changing hands (a recycle, a
// start) before it answers that it is still changing rather than hang
const TRANSITION_MS = Number(process.env.OSD_TRANSITION_MS ?? 60000);

import {fileOf, nameOf, TYPES, STRUCTURE_TABCLASS, INCLUDES} from "./osd-store-types.mjs";
export {fileOf, nameOf, TYPES, STRUCTURE_TABCLASS, INCLUDES} from "./osd-store-types.mjs";

// A package is a folder. abapGit's PREFIX logic names the folders of a
// repository after the package they hold, so a tree that came from a system
// carries the names, and a tree that did not, like ours, gets them from the
// layout: the root's own name, then one segment per folder below it. When
// real content arrives with its package.devc.xml files, the names and the
// texts come from those and nothing above this changes.
const ROOT_PACKAGES = {
  src: "$STG",
  local: "$OSD",
  test: "$STG_TEST",
  gen: "$STG_GEN",
};

// A folder that is a package of its own rather than a child of the root
// above it. The demo package lives inside src but is not part of $STG.
const FOLDER_PACKAGES = {
  "src/zosd_test": "$ZOSD_TEST",
};

// A package above all of ours, if one is wanted. It was tried as $Z and
// taken out again the same day: one more level to click through, in the
// system library and in the favourites alike, bought nothing a person
// wanted. null means the roots are the roots.
const SUPER_PACKAGE = null;

// the open-abap clones beside us: a system's worth of standard objects,
// read-only, and the reason a package tree looks inhabited
// The libraries, as the BUILD reads them -- folder, `files` patterns and
// `exclude_filter` of each entry in abap_transpile.json, resolved by the one
// body in tools/osd-inputs.mjs.
//
// It used to be a hand-written list of three folders while the config
// configured six, and everything compiled and ran: only the **check** was
// wrong, because the registry it builds could not see `open-abap-apc`,
// `abapgit` or `open-abap-gui`. A class extending one of their classes was
// reported broken -- `Super class "cl_apc_wsp_ext_stateful_base" not found or
// contains errors` -- by an editor that had just been handed to somebody to
// use (2026-09-19, Alice, on two classes at once). A pair obliged to agree,
// maintained in two places, is a defect deferred to its first divergence.
//
// The path of a root is kept as `<folder>/src` where the file lives under it,
// because a library object's package is derived from its path and moving the
// root up a level would rename every one of them.
function libraryRoots(root) {
  const byPath = new Map();
  for (const {folder, files} of libraryFiles(root)) {
    const base = folder.replace(/^\//, "");
    for (const full of files) {
      const file = relative(root, full);
      const src = base + "/src";
      const path = file.startsWith(src + "/") ? src : base;
      if (byPath.has(path) === false) {
        byPath.set(path, {path, writable: false, library: true, files: []});
      }
      byPath.get(path).files.push(file);
    }
  }
  return [...byPath.values()];
}

const packageWord = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

// The roots as the transpiler lists them: the input_folder of
// abap_transpile.json, in its order, so that the index and the build resolve
// a name to the same file (tools/osd-inputs.mjs: the later root wins in
// both, the way a layer does; a library never wins over a root). A tree
// without the config uses the build's fallback. gen/ is never written by hand,
// and what sits under local/ was imported, not written here.
/** The exclusions that mean "this is not an object of this system".
 *
 *  The gap this closed: `gen/segw-editor/` (the SEGW editor's "Save to gen/"
 *  button wrote it, until that was removed on 2026-09-25) was left out of
 *  the build on purpose, and the store indexed it anyway -- so the ADT façade and the cross reference described
 *  objects the system does not contain. Measured on this tree, which had
 *  been used: four such classes (fable-osd found the symptom in
 *  `test/osd-xref.mjs`, which named one of them).
 *
 *  **It is a named list rather than a rule read off `exclude_filter`, and
 *  that is the finding.** Three attempts at inferring which entries meant
 *  "not ours" were wrong in three different directions: all of them removed
 *  13 CDS views, because `\.ddls\.` is there to stop the transpiler reading
 *  a file it cannot compile; folder-shaped ones removed the program in
 *  `test/fixtures/` that the ADT tests read. The build's question is "can
 *  the transpiler read this file", the store's is "is this an object of the
 *  system", and no amount of looking at the pattern turns one into the
 *  other. It is intent, so it is stated.
 *
 *  `test/store-exclusions.mjs` checks that every entry is also in
 *  `exclude_filter`, so the two cannot drift into disagreeing. */
export function exclusionsOf(root) {
  try {
    const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
    return (config.not_in_system ?? []).map((pattern) => new RegExp(pattern));
  } catch {
    return [];
  }
}

export function rootsOf(root, env = process.env) {
  const config = loadConfig(root), system = activeSystem(root, env);
  const packs = new Map([...packRootsOf(root, env), ...userLayersOf(root, env)].map((pack) => [pack.path, pack]));
  return inputFoldersOf(root, config, env).map((path) => packs.get(path) ?? (path === TMP_FOLDER ? tmpRoot() : {
    path, writable: path !== "gen", library: false,
    ...(path === "local" || path.startsWith("local/") ? {imported: true} : {}),
    ...(existsSync(join(root, path, ".abapgit.xml")) ? {
      abapgit: repositoryConfig(join(root, path)),
      package: rootPackage(join(root, path), "$OSD_" + packageWord(basename(path))),
    } : {}),
  })).map(r => system ? {...r, writable: false} : r);
}

export class ObjectStore {
  constructor(options = {}) {
    this.root = options.root ?? process.cwd();
    this.registryIssueOptions = options.registryIssueOptions;
    this.registryInputs = options.registryInputs === true;
    // test seams: beforeWrite(file) runs between a create's check and its write
    this.hooks = options.hooks ?? {};
    this.explicitRoots = options.roots !== undefined;
    this.roots = withTmp(options.roots ?? rootsOf(this.root), this.root);
    // the build's exclusions are the store's too, from the same file
    this.excluded = options.excluded ?? exclusionsOf(this.root);
    this.superPackage = options.superPackage === undefined ? SUPER_PACKAGE : options.superPackage;
    this.libs = options.libs === undefined
      ? libraryRoots(this.root)
      : options.libs.map((p) => ({path: p, writable: false, library: true}));
    this.index = undefined;
    this.parsed = undefined;
    // What has been written and not activated since. A system keeps an
    // inactive version of such an object and says so in its documents; a
    // client that saved and then read the object back unchanged took its
    // own copy for the newer one and showed an empty editor over a save
    // that had succeeded. Written marks it, a clean activation clears it.
    this.inactive = new Set();
    // **And an inactive object is not built.** The saved version is the
    // file, because the tree is the working area every other editor shares;
    // the version that was active before the first save after an activation
    // is kept beside the build (`build/inactive/active/<file>`), and the
    // build takes that one, or leaves the object out when it never had one
    // (#overlay). The set and the copies survive a restart in
    // `build/inactive/`, which is gitignored with the rest of build/.
    this.inactiveDir = join("build", "inactive");
    // what every cold build of this store is also given (a test's tree of a
    // few objects has nothing to generate: {generators: false})
    this.buildOptions = options.build ?? {};
    // a test's crash: the named step throws, leaving the disk as a process
    // killed there would (#crash)
    this.crashAt = options.crashAt;
    this.#versions = new StoreVersions(this, () => this.#entries());
    if (process.env.OSD_GENERATOR_ACTIVE_VIEW !== "1") this.#versions.loadInactive();
  }

  #versions;

  inactiveSources(activating = new Set()) {
    return this.#versions.inactiveSources(activating);
  }

  objectKeyOf(file) {
    return this.#versions.objectKeyOf(file);
  }

  savedInactive(file) {
    return this.#versions.savedInactive(file);
  }

  overlay(activating = new Set()) {
    return this.#versions.overlay(activating);
  }

  activeSourceFile(file, entry) { return this.#versions.activeSourceFile(file, entry); }
  withActiveSources(entry, fn) {
    return this.#versions.withActiveSources(entry, fn);
  }

  withOverlay(activating, fn) {
    return this.#versions.withOverlay(activating, fn);
  }

  inactiveObjects() {
    return this.#versions.inactiveObjects();
  }

  // the config changed under us (an import listed its folder as an input):
  // the roots are read again, unless a caller chose them
  reroot() {
    if (this.explicitRoots === false) {
      this.roots = withTmp(rootsOf(this.root), this.root);
    }
    this.index = undefined;
    this.#forget();
    return this.roots;
  }

  stateOf(entry) {
    return this.#versions.stateOf(entry);
  }

  // ---------------------------------------------------------------- index

  // the chain of packages a file sits in: the root's package, then one per
  // folder below it. The chain is the hierarchy; the name is only its last
  // link joined up, so a name that happens to hold an underscore does not
  // invent a parent that is not there.
  #packagesOf(file, root) {
    if (root.abapgit) {
      const folders = relative(root.path, dirname(file)).split(/[\\/]/).filter(p => p && p !== ".");
      const chain = [root.package];
      let at = root.path;
      for (const folder of folders) {
        at = join(at, folder);
        chain.push(declaredPackage(join(this.root, at)) ?? (root.abapgit.folderLogic === "FULL"
          ? folder.toUpperCase() : `${chain[chain.length - 1]}_${folder.toUpperCase()}`));
      }
      return chain;
    }
    const own = Object.keys(FOLDER_PACKAGES).find((folder) => file.startsWith(folder + "/"));
    const bases = own !== undefined ? [FOLDER_PACKAGES[own]]
      // a pack says which package it is (tools/osd-packs.mjs)
      : root.package !== undefined ? [root.package]
      : ROOT_PACKAGES[root.path] !== undefined ? [ROOT_PACKAGES[root.path]]
      // an imported repository is a package of its own under the one that
      // holds every import: local/o4d is $OSD_O4D under $OSD, as it was
      // when local/ was one root rather than one root per repository
      : root.path.startsWith("local/") ? [ROOT_PACKAGES.local, `${ROOT_PACKAGES.local}_${packageWord(root.path.slice("local/".length))}`]
      : ["$" + packageWord(root.path.split("/").filter((p) => p !== "src" && p !== "." && p !== ".local" && p !== "lars").pop() ?? root.path)];
    const inside = file.slice((own ?? root.path).length).split("/").filter((p) => p !== "");
    inside.pop();
    const chain = [...bases];
    for (const folder of inside) {
      chain.push(tmpChild(root, chain, folder) ?? `${chain[chain.length - 1]}_${folder.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`);
    }
    return chain;
  }

  // every object of every root, by type and name
  build(invalidate = true) {
    const index = new Map();
    for (const root of [...this.roots, ...this.libs]) {
      // a library brings the file list the BUILD reads; a root is walked
      for (const file of root.files ?? walkStoreFiles(this, root.path, [])) {
        const name = basename(file);
        for (const [type, meta] of Object.entries(TYPES)) {
          if (!name.endsWith(meta.ext) || meta.sameFileAs !== undefined) {
            continue;
          }
          const chain = this.#packagesOf(file, root);
          // abapGit calls every package file package.devc.xml and lets the
          // folder say which package it is, so the object is named after the
          // folder rather than after the file
          const objectName = type === "DEVC" && name === "package.devc.xml"
            ? chain[chain.length - 1]
            : nameOf(name.slice(0, -meta.ext.length));
          const key = `${type} ${objectName}`;
          // a later root wins over an earlier one, the way the build resolves
          // the same list (tools/osd-inputs.mjs); a library is not a layer,
          // so it fills only what no root has
          if (root.library !== true || !index.has(key)) {
            // a package is an object of the package above it, the way a
            // system holds it, so its own folder is not also its home
            const own = type === "DEVC" && objectName === chain[chain.length - 1];
            const home = own && chain.length > 1 ? chain.slice(0, -1)
              // a root package's own object goes to the package above every
              // root, when there is one; a root holds no object of itself
              : own && this.superPackage ? [this.superPackage]
              : chain;
            index.set(key, {type, name: objectName, file, root: root.path, writable: root.writable, library: root.library,
                            imported: root.imported === true, overlay: root.overlay, package: home[home.length - 1], packages: home});
          }
          break;
        }
      }
    }
    indexTmp(index, this.root); // $TMP, and who made what in it
    this.index = index;
    if (invalidate) this.#forget();
    this.incrementalIndex = false;

    return index;
  }

  #ddlsEntities() {
    const entries = this.#entries();
    if (this.ddlsEntityIndex === undefined || this.ddlsEntityIndexOf !== entries) {
      // as the folder dictionary does: two sources defining one entity are
      // not valid on a system, so neither is taken
      const byEntity = new Map();
      const twice = new Set();
      for (const entry of entries.values()) {
        if (entry.type !== "DDLS") continue;
        let entity;
        try { entity = entityOf(readFileSync(join(this.root, entry.file), "utf8")); } catch { entity = undefined; }
        if (entity === undefined || entity === String(entry.name).toUpperCase()) continue;
        if (byEntity.has(entity)) twice.add(entity);
        byEntity.set(entity, entry);
      }
      for (const entity of twice) byEntity.delete(entity);
      this.ddlsEntityIndex = byEntity;
      this.ddlsEntityIndexOf = entries;
    }
    return this.ddlsEntityIndex;
  }

  #entries() {
    if (this.index === undefined) {
      this.build(!this.incrementalIndex);
    }
    return this.index;
  }

  // ----------------------------------------------------------- the seam

  // every object, or every object of a type
  list(type) {
    const out = [];
    for (const entry of this.#entries().values()) {
      if (type === undefined || entry.type === type) {
        out.push({type: entry.type, name: entry.name, library: entry.library, writable: entry.writable});
      }
    }
    return out.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
  }

  /** Package and source layer for a declaration path that is not itself an
   *  indexed ADT object (such as a *.tran.xml). */
  locationOf(file) {
    const relativeFile = String(file).replaceAll("\\", "/");
    const root = this.roots.filter((candidate) => relativeFile.startsWith(`${candidate.path}/`))
      .sort((a, b) => a.path.length - b.path.length).at(-1);
    if (!root) return undefined;
    return {package: this.#packagesOf(relativeFile, root).at(-1), layer: root.path};
  }

  find(type, name) {
    const key = String(name).toUpperCase();
    const direct = this.#entries().get(`${type} ${key}`);
    if (direct !== undefined) {
      return direct;
    }
    // an include is a program on disk, a structure is a table
    if (type === "INCL") {
      const program = this.#entries().get(`PROG ${key}`);
      return program === undefined ? undefined : {...program, type: "INCL"};
    }
    if (type === "STRU") {
      const table = this.#entries().get(`TABL ${key}`);
      if (table === undefined) {
        return undefined;
      }
      return readFileSync(join(this.root, table.file), "utf8").includes(`<TABCLASS>${STRUCTURE_TABCLASS}</TABCLASS>`)
        ? {...table, type: "STRU"}
        : undefined;
    }
    return undefined;
  }

  exists(type, name) {
    return this.find(type, name) !== undefined;
  }

  // the source of an object, or of one of a class's includes
  // Which includes a class actually has on disk.
  //
  // A client builds the class's file list from this: against a real system a
  // class appears as a folder holding .clas.abap beside .clas.locals_def.abap
  // and its siblings, and a class document that lists only main gets a single
  // flat file. Reporting an include that is not there would be worse — a file
  // in the tree that opens empty.
  classIncludes(name) {
    const entry = this.find("CLAS", name);
    if (entry === undefined) {
      return [];
    }
    const present = [];
    for (const [include, suffix] of Object.entries(INCLUDES)) {
      if (include === "main") {
        continue;
      }
      if (existsSync(join(this.root, entry.file.replace(/\.clas\.abap$/, suffix)))) {
        present.push(include);
      }
    }
    return present;
  }

  read(type, name, include = "main", version = "inactive") {
    // a DDLS may be read by the entity it defines, when that is not its
    // object name (FOR TABLE FUNCTION names the entity). Only a read: a
    // write or a delete resolves its target by object name, never by entity,
    // or it would land in another object's file (foreman-dell, 2026-09-23)
    const entry = this.find(type, name)
      ?? (String(type).toUpperCase() === "DDLS" ? this.#ddlsEntities().get(String(name).toUpperCase()) : undefined);
    if (entry === undefined) {
      throw new NotFound(type, name);
    }
    if (type === "CLAS" && include !== "main") {
      // own keys only: "constructor" or "toString" is no include
      const suffix = Object.hasOwn(INCLUDES, include) ? INCLUDES[include] : undefined;
      if (suffix === undefined) {
        throw new NotFound(type, `${name} include ${include}`);
      }
      const file = entry.file.replace(/\.clas\.abap$/, suffix);
      if (!existsSync(join(this.root, file))) {
        return this.#versions.sourceVersion({...entry, include, file, source: "", empty: true}, version);
      }
      return this.#versions.sourceVersion({...entry, include, file, source: readFileSync(join(this.root, file), "utf8")}, version);
    }
    return this.#versions.sourceVersion({...entry, include, source: readFileSync(join(this.root, entry.file), "utf8")}, version);
  }

  // Copy the complete winning object, including XML and all class includes,
  // before the active-source machinery takes its snapshot of the overlay.
  #copyToOverlay(entry) {
    const root = this.roots.find(r => r.path === entry.overlay && r.writable);
    if (!root) throw new ReadOnly(entry.type, entry.name);
    const sourceDir = dirname(entry.file);
    const targetDir = join(root.path, relative(entry.root, sourceDir));
    const safe = writeCheck(this.root, {...root, tmp: true}, `${entry.type} ${entry.name}`);
    for (const name of readdirSync(join(this.root, sourceDir))) {
      if (name.startsWith(basename(entry.file).slice(0, -TYPES[entry.type].ext.length) + "." + entry.type.toLowerCase() + ".")) safe(join(targetDir, name));
    }
    mkdirSync(join(this.root, targetDir), {recursive: true});
    const stem = basename(entry.file).slice(0, -TYPES[entry.type].ext.length);
    for (const name of readdirSync(join(this.root, sourceDir))) {
      if (name.startsWith(stem + "." + entry.type.toLowerCase() + ".")) {
        copyFileSync(join(this.root, sourceDir, name), join(this.root, targetDir, name));
        chmodSync(join(this.root, targetDir, name), 0o644);
      }
    }
    // Preserve package descriptions/identity at every level above the copy.
    let from = sourceDir;
    for (;;) {
      const header = join(this.root, from, "package.devc.xml");
      const to = join(this.root, root.path, relative(entry.root, from), "package.devc.xml");
      if (existsSync(header) && !existsSync(to)) {
        mkdirSync(dirname(to), {recursive: true});
        safe(relative(this.root, to));
        copyFileSync(header, to);
        chmodSync(to, 0o644);
      }
      if (from === entry.root) break;
      from = dirname(from);
    }
    const copied = {...entry, file: join(targetDir, basename(entry.file)), root: root.path,
      writable: true, overlay: undefined};
    this.#versions.relocateActive(entry, copied);
    this.#entries().set(`${entry.type} ${entry.name}`, copied);
    this.#forget();
    return copied;
  }

  // a write lands a file; a new object goes to the first writable root unless
  // a caller with a specific layer (the notebook scratch pack) names one
  write(type, name, source, include = "main", options = {}) {
    this.#stillActive();
    const queued = deferSourceMutation(this, "write", [...arguments]);
    if (queued) return queued;
    const meta = TYPES[type];
    if (meta === undefined) {
      throw new NotSupported(`object type ${type}`);
    }
    const requestedRoot = options.root === undefined ? undefined : this.roots.find((candidate) =>
      resolve(this.root, candidate.path) === resolve(this.root, String(options.root)));
    if (options.root !== undefined && (requestedRoot === undefined || requestedRoot.writable !== true)) {
      throw new Error(`write target root ${options.root} is not a writable object-store root`);
    }
    let entry = this.find(type, name);
    if (entry !== undefined && entry.writable === false) {
      if (entry.overlay) entry = this.#copyToOverlay(entry);
      else throw new ReadOnly(type, name);
    }
    if (entry !== undefined && requestedRoot !== undefined &&
        resolve(this.root, entry.root) !== resolve(this.root, requestedRoot.path)) {
      throw new Error(`${type} ${name} already belongs to ${entry.root}, not ${requestedRoot.path}`);
    }
    if (entry === undefined) {
      checkName(type, name, CREATABLE[type] !== undefined); // a W3MI id, an IWSV keep their own
      const root = requestedRoot ?? [...this.roots].reverse().find(r => r.overlayOf && r.writable)
        ?? this.roots.find((r) => r.writable);
      if (!root) throw new ReadOnly(type, name);
      const file = join(root.path, ...(root.overlayOf ? [] : ["osd"]), fileOf(name) + meta.ext);
      const packages = this.#packagesOf(file, root);
      entry = {type, name: String(name).toUpperCase(), file, root: root.path, writable: true, library: false,
               imported: root.imported === true, package: packages[packages.length - 1], packages};
      this.#entries().set(`${entry.type} ${entry.name}`, entry);
    }
    let file = entry.file;
    if (type === "CLAS" && include !== "main") {
      const suffix = Object.hasOwn(INCLUDES, include) ? INCLUDES[include] : undefined;
      if (suffix === undefined) {
        throw new NotSupported(`class include ${include}`);
      }
      file = entry.file.replace(/\.clas\.abap$/, suffix);
    }
    const writeRoot = this.roots.find(r => r.path === entry.root);
    const safe = writeCheck(this.root, {...writeRoot, tmp: writeRoot?.overlayOf ? true : writeRoot?.tmp}, `${type} ${entry.name}`);
    safe(file);
    mkdirSync(join(this.root, dirname(file)), {recursive: true});
    // One line ending, the repository's. An editor on Windows sends CRLF,
    // and a save that wrote it as it came turned a one-line comment into a
    // sixty-three-line diff with no comment in it. A system stores source
    // by line, not by terminator, and so does this tree.
    const text = String(source).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    // the active copy, then the intent, then the bytes (#loadInactive)
    this.#versions.keepActive(entry);
    this.#versions.crash("write:before-intent");
    this.#versions.markInactive(entry, new Map([[file, Buffer.from(text, "utf8")]]));
    this.#versions.crash("write:before-source");
    writeChecked(this.root, file, text, safe, this.hooks);
    this.#forget([file]);
    return {...entry, ...this.stateOf(entry), include, file, bytes: Buffer.byteLength(source, "utf8"),
      revision: this.#versions.sourceRevision(type, entry.name)};
  }

  // A new object, in the folder of the package it is asked for. The two
  // files are the ones abapGit would write: the source and the header
  // beside it, so a repository made here is one abapGit can pull, and an
  // object made by abapGit is one this finds. The source is a skeleton the
  // client overwrites on its first save, which is what every ADT client
  // does after a create; a caller that has the source hands it in.
  //
  // The folder comes from the package and not the other way round: a
  // package here IS a folder (#packagesOf), so an object of $ZOSD_TEST_SRC
  // lands in src/zosd_test/src/, and a new package is a new folder under
  // its parent's, named after the last link of its name. A package whose
  // name does not continue its parent's cannot be a folder, and is refused
  // rather than misfiled.
  create(type, name, options = {}) {
    const queued = deferSourceMutation(this, "create", [...arguments]);
    if (queued) return queued;
    const meta = TYPES[type];
    if (meta === undefined || CREATABLE[type] === undefined) {
      throw new NotSupported(`creating an object of type ${type}`);
    }
    const upper = String(name).toUpperCase();
    checkName(type, upper);
    if (this.find(type, upper) !== undefined) {
      throw new Conflict(type, upper);
    }
    const parent = String(options.package ?? "").toUpperCase();
    let home = this.find("DEVC", parent);
    if (parent === "" || home === undefined) {
      throw new NotFound("DEVC", parent === "" ? "(no package named)" : parent);
    }
    if (home.writable === false) {
      if (home.overlay) home = this.#copyToOverlay(home);
      else throw new ReadOnly("DEVC", parent);
    }
    const folder = dirname(home.file);
    const root = this.roots.find((r) => folder === r.path || folder.startsWith(r.path + "/"));
    const description = String(options.description ?? "");
    let file = tmpPackageFile(this.root, parent, upper, folder, type); // $TMP: tools/osd-store-tmp.mjs
    if (file === undefined && type === "DEVC") {
      if (!packageChildName(parent, upper)) {
        throw new NotSupported(`a package under ${parent} is named ${parent}_<FOLDER>; ${upper}`);
      }
      file = join(folder, upper.slice(parent.length + 1).toLowerCase(), "package.devc.xml");
    } else if (file === undefined) {
      file = join(folder, fileOf(upper) + meta.ext);
    }
    const safe = writeCheck(this.root, root?.overlayOf ? {...root, tmp: true} : root, `${type} ${upper}`); // inside its root, no link
    safe(file);
    if (existsSync(join(this.root, file))) {
      throw new Conflict(type, upper);
    }
    mkdirSync(join(this.root, dirname(file)), {recursive: true});
    safe(file);
    const made = CREATABLE[type](upper, description, options.source);
    const writes = Object.entries(made).map(([suffix, content]) =>
      [type === "DEVC" ? file : file.slice(0, -meta.ext.length) + suffix, content]);
    // filed the way build() files it, so the entry a create makes is the
    // entry the next rebuild makes: a package sits in the package above it,
    // and its own chain stops there
    const chain = this.#packagesOf(file, root);
    const packages = type === "DEVC" ? chain.slice(0, -1) : chain;
    const entry = {type, name: upper, file, root: root.path, writable: true, library: false,
                   imported: root.imported === true, description,
                   package: packages[packages.length - 1], packages};
    const author = noteAuthor(this.root, root.path, type, upper, options.author);
    if (author !== undefined) entry.changedBy = author;
    // the intent first: a crash before the files leaves a set naming files
    // that are all absent, which the next start drops (#loadInactive)
    if (type !== "DEVC") {
      this.#versions.markInactive(entry, new Map(writes.map(([target, content]) => [target, Buffer.from(String(content), "utf8")])), options.activeSkeleton === true);
    }
    for (const [target, content] of writes) writeChecked(this.root, target, content, safe, this.hooks);
    this.#entries().set(`${type} ${upper}`, entry);
    this.#forget(writes.map(([file]) => file));
    return {...entry, ...this.stateOf(entry), created: true};
  }

  // The disk is the other editor. A file that appears, changes or goes
  // under a writable root (a git checkout, an abapGit pull, an editor that
  // is not ADT) is noticed here. The next request rebuilds the object index
  // and updates the changed source files in the kept registry. Reparse also
  // invalidates cached readers; configuration/root changes stay cold.
  // persistent:false so a store in a test does not keep the process alive.
  watch() {
    if (this.watchers !== undefined) {
      return this;
    }
    this.watchers = [];
    for (const root of this.roots.filter((r) => r.writable)) {
      try {
        const watcher = watch(join(this.root, root.path), {recursive: true, persistent: false}, (event, file) => {
          if (file === undefined || /\.(abap|xml|asddls|json)$/.test(file) === false) {
            return;
          }
          this.index = undefined;
          this.incrementalIndex = true;
          this.#forget([join(root.path, String(file))]);
          for (const listener of this.listeners ?? []) {
            listener({event, file: join(root.path, String(file)), root: root.path});
          }
        });
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // a file system without recursive watching answers as before: from
        // the index built at start
      }
    }
    return this;
  }

  // who wants to know when the disk changed: the dev loop, which turns a
  // save in any editor into a check, a build and a recycle. The watcher
  // itself only invalidates; what to do about a change is the caller's.
  onChange(listener) {
    this.listeners = [...(this.listeners ?? []), listener];
    return () => {
      this.listeners = (this.listeners ?? []).filter((l) => l !== listener);
    };
  }

  unwatch() {
    for (const w of this.watchers ?? []) {
      w.close();
    }
    this.watchers = undefined;
  }

  delete(type, name) {
    const queued = deferSourceMutation(this, "delete", [...arguments]);
    if (queued) return queued;
    const entry = this.find(type, name);
    if (entry === undefined) {
      throw new NotFound(type, name);
    }
    if (entry.writable === false) {
      throw new ReadOnly(type, name);
    }
    tmpDelete(this.root, entry, true);
    const meta = TYPES[type];
    const files = [entry.file];
    if (type === "CLAS") {
      files.push(...Object.values(INCLUDES).map((suffix) => entry.file.replace(/\.clas\.abap$/, suffix)));
    }
    if (type === "DEVC") {
      // a package goes only once it is empty: its objects are not deleted
      // by implication, the way a real system refuses to delete a package
      // that still has content
      const inside = [...this.#entries().values()].filter((e) => e.type !== "DEVC" ? e.package === entry.name : e.package === entry.name && e.name !== entry.name);
      if (inside.length > 0) {
        throw new NotSupported(`deleting ${entry.name} while it still holds ${inside.length} object(s)`);
      }
    } else if (meta.ext.endsWith(".abap") || meta.ext.endsWith(".asddls")) {
      // the abapGit header beside the source
      files.push(entry.file.slice(0, -meta.ext.length) + meta.ext.replace(/\.(abap|asddls)$/, ".xml"));
    }
    for (const file of files) {
      if (existsSync(join(this.root, file))) {
        unlinkSync(join(this.root, file));
      }
    }
    // the files, then the set, then the copies (#loadInactive)
    this.#entries().delete(`${entry.type} ${entry.name}`);
    if (this.inactive.delete(`${entry.type} ${entry.name}`)) this.#versions.saveInactive();
    this.#versions.dropActiveCopy(entry);
    tmpDelete(this.root, entry, false);
    activationJournal(this).forgetObject(entry.type, entry.name);
    this.#forget(files);
    return {type: entry.type, name: entry.name, deleted: true};
  }

  // name or source matches, the way ADT's search and a grep over the tree do
  search(query, options = {}) {
    const needle = String(query).toUpperCase();
    const out = [];
    for (const entry of this.#entries().values()) {
      if (options.type !== undefined && entry.type !== options.type) {
        continue;
      }
      let hit = entry.name.includes(needle);
      if (hit === false && options.source === true && TYPES[entry.type].source === true) {
        hit = readFileSync(join(this.root, entry.file), "utf8").toUpperCase().includes(needle);
      }
      if (hit === true) {
        out.push({type: entry.type, name: entry.name, library: entry.library});
        if (out.length >= (options.max ?? 100)) {
          break;
        }
      }
    }
    return out;
  }

  // --------------------------------------------------- check and activate

  // ------------------------------------------------------------ packages

  // every package of the system, parent first, with what is in it
  packages() {
    const packages = new Map();
    const ensure = (name, parent) => {
      if (packages.has(name) === false) {
        packages.set(name, {name, parent, description: this.#packageText(name), objects: 0, subpackages: [], library: true});
      }
      return packages.get(name);
    };
    for (const entry of this.#entries().values()) {
      // every link of the chain exists, even a folder that holds only folders
      entry.packages.forEach((name, at) => {
        const node = ensure(name, at === 0 ? undefined : entry.packages[at - 1]);
        if (entry.library === false) {
          node.library = false;
        }
        if (at > 0) {
          const parent = packages.get(entry.packages[at - 1]);
          if (parent.subpackages.includes(name) === false) {
            parent.subpackages.push(name);
          }
        }
      });
      // A package object is the package, even when nothing sits in it yet.
      // Its own chain stops at its parent (build() files a package under
      // the package above it), so a package folder that holds only its
      // package.devc.xml -- what a create makes -- was named by no chain at
      // all and vanished from the tree, the search and nodestructure on the
      // first rebuild after the create, while find() still knew it.
      if (entry.type === "DEVC" && entry.name !== entry.package) {
        const node = ensure(entry.name, entry.package);
        if (entry.library === false) {
          node.library = false;
        }
        const parent = packages.get(entry.package);
        if (parent !== undefined && parent.subpackages.includes(entry.name) === false) {
          parent.subpackages.push(entry.name);
        }
      }
      // a root package's own object is the package, not something in it
      if (entry.type === "DEVC" && entry.name === entry.package) {
        continue;
      }
      const own = packages.get(entry.package);
      own.objects = own.objects + 1;
    }
    // everything that had no package above it now has the super-package
    const tops = [...packages.values()]
      .filter((node) => node.parent === undefined && node.name !== this.superPackage).map((node) => node.name);
    // and not on an empty system: a super-package over nothing is a package
    // that holds nothing, which is not what "no packages" means
    if (this.superPackage !== null && this.superPackage !== undefined && tops.length > 0) {
      const top = ensure(this.superPackage, undefined);
      top.library = false;
      top.description = "Packages served by this system";
      for (const name of tops) {
        packages.get(name).parent = this.superPackage;
        top.subpackages.push(name);
      }
    }
    for (const node of packages.values()) {
      node.subpackages.sort();
    }
    return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // the top of the tree: what a client sees when it has not named a package
  // yet. A system answers this for the node its clients call the system
  // library, and without it a tree has no root to open, which is what
  // "Unable to resolve nonexistent file" means on the other end.
  //
  // Not called roots(): this.roots is the folders the store reads from, and
  // a method of that name is silently shadowed by the field, which is how
  // the registry cache broke once already.
  rootPackages() {
    return this.packages().filter((node) => node.parent === undefined);
  }

  // one package: what is under it and what is in it. An empty name is the
  // root, because that is what a client asks for first.
  package(name) {
    const wanted = String(name ?? "").toUpperCase();
    if (wanted === "") {
      return {
        name: "",
        parent: undefined,
        description: "the packages of this system",
        library: false,
        subpackages: this.rootPackages().map((node) => node.name),
        objects: [],
      };
    }
    const all = this.packages();
    const node = all.find((p) => p.name === wanted);
    if (node === undefined) {
      throw new NotFound("DEVC", wanted);
    }
    const objects = [];
    const authors = [...this.#entries().values()].some((e) => e.package === wanted && e.root === TMP_FOLDER)
      ? (tmpAuthors(this.root) ?? {}) : {};
    for (const entry of this.#entries().values()) {
      if (entry.package === wanted && !(entry.type === "DEVC" && entry.name === wanted)) {
        const author = authorNow(this.root, entry, authors);
        objects.push({type: entry.type, name: entry.name, library: entry.library, writable: entry.writable,
          version: this.stateOf(entry).version, ...(author === undefined ? {} : {author})});
      }
    }
    return {
      ...node,
      objects: objects.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name)),
    };
  }

  authorOf(type, name) {
    const entry = this.find(type, name);
    return entry?.root === TMP_FOLDER ? authorNow(this.root, entry) : undefined;
  }

  // the text of a package: a real one carries it in package.devc.xml, and
  // until content arrives the folder speaks for itself
  #packageText(name) {
    const file = this.#devcOf(name);
    if (file !== undefined && existsSync(join(this.root, file))) {
      const text = /<CTEXT>([^<]*)<\/CTEXT>/.exec(readFileSync(join(this.root, file), "utf8"));
      if (text !== null) {
        return text[1];
      }
    }
    return isTmpPackage(name) ? TMP_TEXT : undefined;
  }

  // a package object is named after the package it describes
  #devcOf(name) {
    const entry = this.#entries().get(`DEVC ${name}`);
    return entry === undefined ? undefined : entry.file;
  }

  // the rows of the system, for a client that asks for table contents: one
  // place knows about the schema, the seed and the dialect (tools/osd-data.mjs)
  data() {
    if (this.rows === undefined) {
      this.rows = new Data({root: this.root});
    }
    return this.rows;
  }

  // the serving runtime, the process that answers OData (tools/osd-runtime.mjs
  // and tools/osd-serve.mjs). This only hands the supervisor over; whoever
  // owns the listener decides when to start it, because starting a process
  // is not something a store should do behind a caller's back.
  serving(options = {}) {
    if (this.served === undefined) {
      // more than one work process when asked for one (OSD_WORKERS,
      // tools/osd-pool.mjs): the pool behaves as a runtime for everything
      // that used one, and offers next() to whoever pins a session
      const size = Math.max(1, Number(options.workers ?? process.env.OSD_WORKERS ?? 1));
      this.served = size > 1
        ? new RuntimePool({root: this.root, size, ...options})
        : new ServingRuntime({root: this.root, ...options});
    }
    return this.served;
  }

  // activation, finished rather than promised: the modules are written and
  // then the process that serves them is replaced, because Node pins a
  // module graph and the old process would go on answering with the old
  // code. A caller that awaits this can tell a client the truth, which is
  // what a real system's activation does.
  //
  // Recycling is skipped when nothing is serving, so a command line or a
  // test suite pays only for the transpile.
  //
  // One activation at a time per store. A save has two activators -- the
  // dev loop (tools/osd-dev.mjs) and the ADT façade's own activation
  // (tools/adt-facade.mjs) -- and side by side they shared one build and
  // both swapped from its base, or the second swapped from a base the
  // first had already replaced: refused, and the process recycled
  // (vsp-i7, 2026-10-02). In line, the second builds on what the first
  // made live: the same source is a no-op on that generation, a later edit
  // a build and a swap of its own. Every caller needs this, so it is here.
  //
  // In line is not in turn, though: a caller whose tree is the one already
  // queued or in flight takes THAT publish's answer, its load included,
  // instead of building the same thing again behind it. A queued publish has
  // not read the tree yet, so it reads this caller's too; one in flight is
  // joined when its build named the generation by the same hash the tree
  // has now (sourceKey()). Two activators of one save are then one build and
  // one swap, and both answers wait for the swap and carry its ms.
  //
  // Each publication carries its own activation (`activate`, the objects it
  // builds with their saved version), and is joined only by a caller with
  // the same set over the same tree: two activations of different objects
  // are two builds, so one's broken save never enters the other's.
  async publish(options = {}) {
    this.#stillActive();
    const activating = new Set([...(options.activate ?? [])].map((o) => `${o.type} ${String(o.name).toUpperCase()}`));
    const set = [...activating].sort().join("\n");
    const forced = options.force === true || options.replace === true;
    if (!forced) {
      if (this.#queued !== undefined && this.#queued.set === set) return this.#queued.promise;
      const running = this.#running;
      if (running !== undefined && running.forced !== true && running.set === set) {
        // the name first: what the tree is now, before waiting on anything
        const key = await this.sourceKey(activating);
        const built = await running.built.catch(() => undefined);
        if (key !== undefined && built?.ok !== false && built?.hash === key) return running.promise;
        if (this.#queued !== undefined && this.#queued.set === set) return this.#queued.promise;
      }
    }
    const entry = {forced, set};
    entry.built = new Promise((resolve, reject) => {
      entry.resolveBuilt = resolve;
      entry.rejectBuilt = reject;
    });
    entry.built.catch(() => undefined);
    entry.promise = this.#publishing.then(() => {
      if (this.#queued === entry) this.#queued = undefined;
      this.#running = entry;
      return this.#publish({...options, activating}, entry);
    }).then(result => {
      if (result?.ok === true && result.generation) {
        if (result.transpile?.built && typeof result.transpile.built === "object") {
          this.#publishedBuilds.set(result.transpile.built, result.generation);
        }
        // Builds with no activating source already contain only active input.
        if (activating.size === 0) recordStoreGeneration(this, () => result.generation);
      }
      return result;
    }).finally(() => {
      if (this.#running === entry) this.#running = undefined;
      entry.rejectBuilt(new Error("the publish ended before its build"));
    });
    if (!forced) this.#queued = entry;
    this.#publishing = entry.promise.catch(() => undefined);
    return entry.promise;
  }

  #publishing = Promise.resolve();
  #publishedBuilds = new WeakMap();
  // the publish waiting for its turn (not forced), and the one in its turn
  #queued = undefined;
  #running = undefined;

  // the name a build of the tree as it is now would give its generation:
  // the hash of the inputs (tools/osd-build.mjs hashOf), the same one a warm
  // build names its generation by. undefined when the tree cannot be named,
  // and then nothing is joined.
  async sourceKey(activating = new Set()) {
    try {
      return hashOf(this.root, inputsOf(this.root), {overlay: this.overlay(activating)});
    } catch {
      return undefined;
    }
  }

  async #publish(options, entry = {}) {
    recordBaselineGeneration(this, () => this.served?.generation ?? liveHash(this.root));
    let transpile;
    try {
      transpile = await this.transpile(options);
    } finally {
      entry.resolveBuilt?.(transpile);
    }
    if (transpile?.ok === false) {
      return {ok: false, transpile};
    }
    let runtime = this.served;
    // a runtime changing hands (a catch-up recycle, a start; for a pool, any
    // of its work processes) is waited for before its generation is read or
    // loaded into: answering now would say "active" while no process serves
    // the code, and the one coming up may have read the live generation
    // before this build switched it
    // -- but not for ever: a recycle that never settles is answered as one
    const deadline = Date.now() + this.transitionMs;
    for (let changing = runtime?.recycling ?? runtime?.starting; changing !== undefined;
      changing = runtime?.recycling ?? runtime?.starting) {
      const waited = await this.#bounded(changing.catch(() => undefined), "a runtime changing hands", deadline);
      if (waited.late) return {ok: false, transpile, recycled: false, error: waited.error};
      runtime = this.served;
    }
    if (runtime === undefined || runtime.running !== true) {
      // The complete generation is available to a fresh detached context,
      // even when this source host has no serving process to recycle.
      return {ok: true, transpile, recycled: false, generation: transpile.hash};
    }
    // nothing to load: the process already serves the generation this build
    // named (a no-op warm build, a cached cold one), so no swap and no
    // recycle -- a recycle of unchanged code ends every session for nothing.
    // Said how THIS process got it: by a swap (its ms), or by a load at its
    // start, which must not read as a swap (a recycle after a refused swap,
    // a catch-up recycle, a process that came up on the live generation
    // after this build switched it). A load is the process's only while its
    // epoch is the one serving. A forced build replaces the generation's
    // files under the same name, and is always loaded.
    // For a pool, every work process: one a partial recycle left on the old
    // generation is loaded (swapped or recycled), not reported as served.
    const members = Array.isArray(runtime.runtimes) ? runtime.runtimes : [runtime];
    if (options.force !== true && options.replace !== true && (transpile.warm === true || transpile.cached === true) &&
        members.every((m) => m.running === true && m.generation === transpile.hash)) {
      const last = this.lastLoad?.generation === transpile.hash && this.lastLoad.epoch === runtime.epoch
        ? this.lastLoad : undefined;
      const how = last?.why !== undefined ? {why: `the runtime was recycled onto it: ${last.why}`}
        : last?.hot === true ? {swapMs: last.ms}
          : {why: "the serving process was started on it"};
      return {ok: true, transpile, recycled: false, hot: false, generation: transpile.hash, ...how};
    }
    // a warm build is loaded into the process that serves, not a new one
    // (tools/osd-hot.mjs); when that cannot be done, the recycle below does
    let why;
    if (transpile.warm === true && (transpile.hostHeld ?? []).length === 0) {
      try {
        const swap = await runtime.hot({generation: transpile.hash, from: transpile.from,
          modules: transpile.modules, only: transpile.closure, xrefRows: transpile.xrefRows, verified: transpile.unverified !== true});
        this.lastLoad = {generation: transpile.hash, epoch: runtime.epoch, hot: true, ms: swap.ms};
        // the swap limit or the heap: the catch-up recycle is part of this
        // activation, and its answer is the load that recycle made
        const after = this.#afterSwap(transpile.hash, swap);
        const waited = after === undefined ? undefined : await this.#bounded(after, "the catch-up recycle");
        const caught = waited === undefined ? undefined : waited.late ? {ok: false, error: waited.error} : waited.value;
        if (caught !== undefined) {
          if (caught.ok !== true) return {ok: false, transpile, recycled: false, error: caught.error};
          return {ok: true, transpile, recycled: true, generation: caught.generation, ms: caught.ms,
            why: `the swap (${swap.ms} ms) was followed by a catch-up recycle after ${caught.why}`};
        }
        return {ok: true, transpile, recycled: false, hot: true, generation: transpile.hash, ms: swap.ms, swaps: swap.swaps};
      } catch (error) {
        console.log(`warm: the swap was refused, recycling instead: ${error.message}`);
        why = `the swap was refused: ${error.message}`;
      }
    }
    if (transpile.warm === true && (transpile.hostHeld ?? []).length > 0) {
      why = `${transpile.hostHeld.join(", ")} requires a fresh runtime`;
      console.log(`warm: ${why}, recycling instead of swapping`);
    }
    try {
      const bounded = await this.#bounded(runtime.recycle(), "the recycle");
      if (bounded.late) return {ok: false, transpile, recycled: false, error: bounded.error};
      const recycle = bounded.value;
      this.#cleanHot();
      if (this.warmState !== undefined) this.warmState.heapBase = undefined;
      // a warm build loaded by a recycle says why, so no answer reports it as a swap
      this.lastLoad = {generation: recycle.generation, epoch: runtime.epoch, why};
      return {ok: true, transpile, recycled: true, generation: recycle.generation, ms: recycle.ms, ...(why === undefined ? {} : {why})};
    } catch (error) {
      // the modules are good and the process that should carry them is not:
      // that is a failure of the activation, not a detail to log quietly
      return {ok: false, transpile, recycled: false, error: error.message};
    }
  }

  // A runtime changing hands -- a recycle already underway, the one this
  // publish asks for, the catch-up a swap brings -- is waited for for as
  // long as it is starting and says so, and is late once it has said
  // nothing for transitionMs (OSD_TRANSITION_MS): silence, not slowness,
  // the rule the runtime's own boot already keeps (tools/osd-runtime.mjs,
  // `timeout` of silence, `bootTimeout` in all, after which it gives the
  // boot up itself and the recycle rejects). A fixed limit turned a boot
  // that was slow and correct into a failed activation: vsp-i7 on 0.6.1511
  // measured a boot of more than 60 s under load (the generation 6.6 s, the
  // cross-reference 21.6 s, the registrations after them) and every 60-s
  // wait for it answered "still changing hands". A transition with no boot
  // to hear from (a stop, a supervisor that never settles) is late after
  // transitionMs as before, so the chain still moves on. {late: false,
  // value} or {late: true, error}; a rejection is the caller's.
  async #bounded(promise, what, deadline = Date.now() + this.transitionMs) {
    const late = Symbol("late");
    const started = Date.now();
    for (;;) {
      let timer;
      const value = await Promise.race([
        promise,
        new Promise((done) => {
          timer = setTimeout(() => done(late), Math.max(0, deadline - Date.now()));
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (value !== late) return {late: false, value};
      // what the boot said while this process was busy itself (a prime
      // holds it for seconds) is still queued: let it land before reading
      await new Promise((r) => setImmediate(r));
      const heard = this.#heard();
      if (heard !== undefined && heard + this.transitionMs > Date.now()) {
        deadline = heard + this.transitionMs;
        continue;
      }
      break;
    }
    // whatever it settles to later is nobody's answer, and not unhandled
    Promise.resolve(promise).catch(() => undefined);
    return {late: true, error: `the runtime is still changing hands after ${Date.now() - started} ms, ` +
      `${this.transitionMs} ms of it without a word (${what}); nothing was loaded`};
  }

  // when a runtime (or any work process of a pool) that is booting last said
  // anything; undefined when none is booting
  #heard() {
    const runtime = this.served;
    const members = Array.isArray(runtime?.runtimes) ? runtime.runtimes : runtime === undefined ? [] : [runtime];
    let at;
    for (const m of members) {
      const h = m?.booting?.heard;
      if (typeof h === "number" && (at === undefined || h > at)) at = h;
    }
    return at;
  }

  // ---- the warm compile (tools/osd-warm.mjs, docs/warm-compile.md) --------
  //
  // On with OSD_WARM=1. The registry is primed in the background after a
  // cold build, and a save it may build (a content edit of a class or an
  // interface) becomes a build of the objects it reaches and a swap in the
  // serving process. Anything else is the cold build, and after it the
  // registry advances incrementally when its delta permits, otherwise primes again.

  warm() {
    if (this.warmState === undefined) {
      const on = (process.env.OSD_WARM ?? "") === "1";
      this.warmState = {on, compiler: undefined, priming: undefined, reason: on ? "not primed yet" : "OSD_WARM is not 1",
        verifying: undefined, next: undefined, last: undefined, timer: undefined};
    }
    return this.warmState;
  }

  // What a client shows about the warm build (the VS Code extension's
  // "warming up"): off, priming, primed, or cold with the reason it is
  // cold, and what the process serving has taken.
  warmStatus() {
    const w = this.warm();
    const c = w.compiler;
    const state = w.on !== true ? "off" : w.priming !== undefined ? "priming" : c?.primed === true ? "primed" : "cold";
    return {
      state,
      reason: state === "primed" || state === "priming" ? undefined : w.reason,
      generation: c?.primed === true ? c.hash : undefined,
      unverified: c === undefined ? [] : [...c.unverified],
      swaps: this.served?.swaps ?? 0,
      copies: c?.copies ?? 0,
      lastVerify: w.last,
      compilerMemory: c?.memory,
    };
  }

  // Every CLAS/INTF whose file on disk no longer hashes to what the warm
  // registry was primed or last built from -- what "Rebuild (warm)"
  // (editors/vscode) activates in one call, so a person never has to name
  // the object themselves. Reuses the warm compiler's own digests
  // (tools/osd-warm.mjs WarmCompiler#prime / #build), which are exactly the
  // per-file hashes the live generation was built from: no second bookkeeping.
  // undefined when the registry is not primed, which is the caller's cue to
  // fall back to a cold rebuild rather than guess at a list this has no way
  // to check.
  changedObjects() {
    const w = this.warm();
    const c = w.compiler;
    if (c?.primed !== true) return undefined;
    const out = [];
    for (const entry of this.#entries().values()) {
      if (entry.type !== "CLAS" && entry.type !== "INTF") continue;
      const file = resolve(this.root, entry.file);
      let hash;
      try {
        hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      } catch {
        continue;
      }
      if (c.digests.get(file) !== hash) {
        // `base`: the lowercase file stem uriOf() (editors/vscode/lib.js)
        // needs to build the object's own ADT uri -- the same shape
        // adtObjectOf() derives from a file name, namespace `#ns#` form
        // included, so activateMany() can be handed this list as is.
        const base = basename(entry.file).replace(/\.(clas|intf)\.abap$/i, "");
        out.push({type: entry.type, name: entry.name, base});
      }
    }
    return out;
  }

  // prime in the background; a failure leaves every build cold and says why
  warmUp() {
    return warmUp(this);
  }

  // after a swap: compare the generation with a cold transpile of the same
  // inputs, and once the process has been swapped into for long enough,
  // replace it with one started on the live generation
  #afterSwap(hash, swap = {}) {
    const w = this.warm();
    // one heap per work process (a pool reports each, tools/osd-pool.mjs),
    // each measured against its own at the first swap
    const heaps = swap.heaps ?? [swap.heap];
    w.heapBase ??= heaps;
    const grown = Math.max(0, ...heaps.map((heap, i) =>
      typeof heap === "number" && typeof w.heapBase[i] === "number" ? heap - w.heapBase[i] : 0));
    if (w.compiler?.unverified.has(hash)) {
      (w.next ??= new Set()).add(hash);
      this.#verifyNext();
    }
    const runtime = this.served;
    clearTimeout(w.timer);
    w.quietArmed = false;
    // the limits are reached by a swap, so the recycle is the swap's
    // publish's to await (undefined when nothing is recycled). The heap is
    // the safety limit and always recycles; the swap count and a quiet
    // minute are housekeeping and wait while a client holds an APC socket,
    // which a recycle would cut (PIA, 2026-10-06: its terminal dropped
    // while a turn waited on its model).
    if (grown > WARM_HEAP_MB * 1024 * 1024) {
      return this.#catchUp(`a heap ${Math.round(grown / 1048576)} MB larger than at the first swap`);
    } else if ((runtime?.swaps ?? 0) >= this.warmSwapLimit && !this.#channelsOpen(`${runtime.swaps} swaps`)) {
      return this.#catchUp(`${runtime.swaps} swaps`);
    } else {
      this.#armQuiet();
    }
    return undefined;
  }

  // a quiet minute after the last swap brings the catch-up recycle, unless
  // an APC socket is open: then it is asked again a quiet period later
  #armQuiet() {
    const w = this.warm();
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      // Retry genuinely missing frozen inputs after a quiet interval.
      const live = this.served?.generation;
      if (live !== undefined && w.compiler?.unverified.has(live)) {
        (w.next ??= new Set()).add(live);
        this.#verifyNext();
      }
      if (this.#channelsOpen("quiet") || this.#running !== undefined || this.#queued !== undefined) this.#armQuiet();
      else { w.quietArmed = false; this.#catchUp("quiet"); }
    }, this.warmQuietMs);
    w.timer.unref?.();
    w.quietArmed = true;
  }

  // a save or an activation is not quiet: a pending quiet recycle starts its
  // period again, so it never lands on the activation it would have to wait
  // for and turn that warm swap into a cold load (adt-lifecycle, 2026-10-07)
  #stillActive() {
    if (this.warmState?.quietArmed === true && this.warmState.closed !== true) this.#armQuiet();
  }

  // the APC sockets the serving process holds (counted by upgradeProxy,
  // tools/osd-proxy.mjs); says once per deferral why nothing is recycled
  #channelsOpen(why) {
    const open = this.served?.openChannels ?? 0;
    if (open > 0) console.log(`warm: recycle after ${why} deferred: ${open} APC connection(s) open`);
    return open > 0;
  }

  // the swap count that brings a catch-up recycle (OSD_WARM_SWAPS); a test lowers it
  warmSwapLimit = WARM_SWAPS;
  // the quiet period after a swap that brings one (OSD_WARM_QUIET_MS); likewise
  warmQuietMs = WARM_QUIET_MS;
  warmVerifyWaitMs = Number(process.env.OSD_WARM_VERIFY_WAIT_MS ?? 30000);
  warmVerifyLifetimeMs = Number(process.env.OSD_WARM_VERIFY_LIFETIME_MS ?? 180000);
  // how long a publish waits for a runtime changing hands (OSD_TRANSITION_MS)
  transitionMs = TRANSITION_MS;

  #verifyNext() { verifyNext(this); }

  async #catchUp(why) {
    const runtime = this.served;
    if (runtime === undefined || runtime.running !== true || (runtime.swaps ?? 0) === 0) return undefined;
    try {
      const r = await runtime.recycle();
      this.#cleanHot();
      this.warm().heapBase = undefined;
      // the process now serving loaded its generation at its start
      this.lastLoad = {generation: r.generation, epoch: runtime.epoch, why: `a catch-up recycle after ${why}`};
      console.log(`warm: recycled after ${why} (${r.ms} ms)`);
      return {ok: true, generation: r.generation, ms: r.ms, why};
    } catch (error) {
      console.log(`warm: the catch-up recycle failed: ${error.message}`);
      return {ok: false, error: `the catch-up recycle after ${why} failed: ${error.message}`};
    }
  }

  // the swapped copies, once no process carries them
  #cleanHot() {
    rmSync(join(this.root, "build", "hot"), {recursive: true, force: true});
  }

  // the test run of an object (tools/osd-unit.mjs). It needs the parse and
  // the runtime, both of which live here, so the façade asks the store for
  // it rather than assembling one. Imported when first asked for, because
  // the runner imports the store back.
  async unit() {
    if (this.tests === undefined) {
      const {UnitRun} = await import("./osd-unit.mjs");
      this.tests = new UnitRun(this);
    }
    return this.tests;
  }

  // ADT's F9, "Run as ABAP Application (Console)" (tools/osd-classrun.mjs):
  // a class implementing IF_OO_ADT_CLASSRUN, run against the runtime this
  // store already has -- no detached child, because a classrun IS a run of
  // the application and shares the connection every other request does.
  async classrun() {
    if (this.classruns === undefined) {
      const {ClassRun} = await import("./osd-classrun.mjs");
      this.classruns = new ClassRun(this);
    }
    return this.classruns;
  }

  // a write means the parse is stale, here and for anyone sharing this tree
  #forget(files) {
    this.ddlsEntityIndex = undefined;
    forgetRegistry(this, files);
  }

  // StoreVersions borrows the registry update from here so that it can be
  // imported without the compiler (the Docker core image has none).
  updateRegistryFiles(registry, replacements) {
    return updateRegistryFiles(registry, replacements);
  }

  registry(configPath = "abaplint.jsonc") {
    this.#entries();
    return buildRegistry(this, configPath);
  }

  // the syntax check a write runs; issues of this object only.
  //
  // With {source} the given text stands in for the file for this one check
  // and nothing on disk changes: what an editor asks before it saves, and
  // what a client asks about an object it has not created yet. The answer
  // has the same shape either way, because the caller is the same code.
  check(type, name, options = {}) {
    const entry = this.find(type, name);
    if (entry === undefined && options.source === undefined) {
      throw new NotFound(type, name);
    }
    if (options.source === undefined) {
      return registryIssues(this.registry(), type, entry.name, this.registryIssueOptions);
    }
    const target = this.#fileFor(type, name, entry, options.include ?? "main");
    return withSource(this, target.file, options.source, (registry) => registryIssues(registry, type, target.name, this.registryIssueOptions));
  }

  // The Node store owns compiler IPC; browser check runners remain portable.
  checkWarm(object) { return warmCheck(this, object); }

  // which file a source belongs in: the object's own, the class include the
  // caller named, or the one a write would create for an object that is not
  // there yet
  #fileFor(type, name, entry, include) {
    const meta = TYPES[type];
    if (meta === undefined) {
      throw new NotSupported(`object type ${type}`);
    }
    let file = entry?.file;
    if (file === undefined) {
      const root = this.roots.find((r) => r.writable);
      file = join(root.path, "osd", fileOf(name) + meta.ext);
    }
    if (type === "CLAS" && include !== "main") {
      const suffix = Object.hasOwn(INCLUDES, include) ? INCLUDES[include] : undefined;
      if (suffix === undefined) {
        throw new NotSupported(`class include ${include}`);
      }
      file = file.replace(/\.clas\.abap$/, suffix);
    }
    return {name: entry?.name ?? String(name).toUpperCase(), file};
  }

  // the objects whose source names this one, which is who an activation can
  // break. An over-approximation on purpose: a mention in a comment or a
  // string counts, so the list is longer than the truth and never shorter,
  // and a healthy object costs one check to clear. The cheap direction to be
  // wrong in — the expensive one is telling a client a rename was fine.
  dependents(type, name) {
    return registryDependents(this.registry(), type, name);
  }

  // activation is that check over the object AND everything that uses it: a
  // local system has no queue, so it either holds or it does not. Checking
  // the object alone is the false green this whole thing exists to catch —
  // rename a method its callers use and the object is still self-consistent,
  // while the system it lives in no longer compiles. A real system refuses
  // that activation, so this one does too, and it says which caller broke.
  //
  // This is only the check verdict. The inactive mark is cleared separately,
  // after publication succeeds; a failed build is not an activation.
  //
  // The check sees the system the build will make (#withOverlay): the
  // objects activated together (`options.activating`, "TYPE NAME"s; this one
  // when none are named) as saved, every other inactive object as its active
  // copy or absent. A saved, unactivated, broken dependent no longer holds
  // back an edit its active version accepts.
  activate(type, name, options = {}) {
    const self = `${type} ${String(name).toUpperCase()}`;
    const activating = new Set([self, ...[...(options.activating ?? [])].map((o) =>
      typeof o === "string" ? o : `${o.type} ${String(o.name).toUpperCase()}`)]);
    return this.#versions.withOverlay(activating, (registry, paths) => {
      options.beforeCheck?.(registry, paths);
      return this.#activateChecked(type, name);
    });
  }

  #activateChecked(type, name) {
    const result = this.check(type, name);
    if (result.issues.length > 0) {
      return {...result, active: false, dependents: []};
    }
    // the order matters: a candidate is only a dependent if its own check
    // fails. That is what makes the over-approximation above safe — a name
    // mentioned in a comment produces a candidate, the candidate checks
    // clean, and nothing is refused over it. A wasted check, not a wrong
    // verdict.
    const broken = [];
    for (const dependent of this.dependents(type, name)) {
      // straight off the registry, not through find(): a dependent may be of
      // a type the store does not index (an IWPR naming the class it maps),
      // and it is in the registry by construction, so it is checked there
      const checked = registryIssues(this.registry(), dependent.type, dependent.name, this.registryIssueOptions);
      if (checked.issues.length > 0) {
        broken.push(checked);
      }
    }
    return {...result, active: broken.length === 0, dependents: broken,
      revision: broken.length === 0 ? this.#versions.sourceRevision(type, name) : undefined};
  }

  // what a warm build's check stands for (tools/osd-warm.mjs): the
  // transpiler checks the objects a change reaches while it builds them, and
  // refuses to build when one is broken, so the activation is the revision
  // taken before that build -- completed only if it is still the one on disk
  warmActivation(type, name) {
    return {type, name, active: true, issues: [], dependents: [], warm: true, revision: this.#versions.sourceRevision(type, name)};
  }

  // Complete only the exact revision that passed the check. An editor may
  // save again while publish() awaits its build or runtime recycle.
  completeActivation(result, built = undefined) {
    return this.completeActivations([result], built);
  }

  // `built` is what the build read of each object ("TYPE NAME" -> revision,
  // the publication's transpile.built): an object is promoted only when the
  // checked revision is the one that was built AND the one on disk now. A
  // save between the check and the build's read, restored before the
  // completion, otherwise promoted the checked bytes over a live build of
  // others and dropped the active copy. Without `built` (no build ran: a
  // façade whose activation does not transpile) the disk is compared alone.
  completeActivations(results, built = undefined) {
    const queued = deferSourceMutation(this, "completeActivations", [...arguments]);
    if (queued) return queued;
    // An ADT request may activate several objects. Do not mark the first
    // active if a later one was saved again during the same build.
    const key = (result) => `${result.type} ${String(result.name).toUpperCase()}`;
    if (results.some((result) => result.active !== true || result.revision === undefined ||
        (built !== undefined && built[key(result)] !== result.revision) ||
        result.revision !== this.#versions.sourceRevision(result.type, result.name))) return false;
    for (const result of results) {
      this.#versions.markActive(result.type, result.name);
    }
    // ADT and STORE share promotion. Update the same publication checkpoint
    // only for the exact successful build whose source revisions were promoted.
    const generation = built && this.#publishedBuilds.get(built);
    if (generation && liveHash(this.root) === generation) {
      recordStoreGeneration(this, () => generation);
    }
    return true;
  }

  // the transpile behind an activation: the modules the runtime loads.
  // Built to the side and made live by a rename (tools/osd-build.mjs), so a
  // build that fails leaves the live generation exactly as it was — which
  // is the whole reason publish() can promise the truth. The promise is
  // shared: a second caller while one is running gets the same one, and
  // {force: true} rebuilds even when the inputs have not changed.
  transpile(options = {}) {
    // the objects this build activates: its own, never another caller's
    const activating = options.activating instanceof Set ? options.activating : new Set();
    const set = [...activating].sort().join("\n");
    if (this.building !== undefined && options.force !== true && this.buildingSet === set) {
      return this.building;
    }
    // a forced build, or one of another activation, waits for the one in
    // flight rather than running beside it
    const before = this.building;
    this.buildingSet = set;
    this.building = (async () => {
      await before?.catch(() => undefined);
      // what this build read of the objects it activates: the revision a
      // completion must match, not the bytes on disk when it completes
      const built = (read) => {
        if (read === undefined) return undefined;
        const digests = new Map([...read].map(([file, digest]) => [normalPath(file), digest]));
        return Object.fromEntries([...activating].map((key) => [key, this.#versions.builtRevision(key, digests)]));
      };
      return transpileStore(this, options, activating, built);
    })();
    const building = this.building;
    building.then(() => {
      if (this.building === building) this.building = undefined;
    }, () => { if (this.building === building) this.building = undefined; });
    return building;
  }
}

export class Conflict extends Error {
  constructor(type, name) {
    super(`${type} ${name} already exists`);
    this.code = "CONFLICT";
    this.objectType = type;
    this.objectName = name;
  }
}

export class NotFound extends Error {
  constructor(type, name) {
    super(`${type} ${name} does not exist`);
    this.code = "NOT_FOUND";
    this.objectType = type;
    this.objectName = name;
  }
}

export class ReadOnly extends Error {
  constructor(type, name) {
    super(`${type} ${name} comes from a library and cannot be changed here`);
    this.code = "READ_ONLY";
    this.objectType = type;
    this.objectName = name;
  }
}

export class NotSupported extends Error {
  constructor(what) {
    super(`${what} is not supported`);
    this.code = "NOT_SUPPORTED";
  }
}

// the command line, so the store can be looked at without a façade
function main(args) {
  const store = new ObjectStore();
  const [command, type, name] = args;
  switch (command) {
    case "list": {
      const objects = store.list(type);
      const counts = new Map();
      for (const o of objects) {
        counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
      }
      console.log(`${objects.length} objects: ${[...counts].sort().map(([t, n]) => `${t} ${n}`).join(", ")}`);
      return 0;
    }
    case "read":
      process.stdout.write(store.read(type, name).source);
      return 0;
    case "check":
    case "activate": {
      // check TYPE NAME --source file.abap answers for a file that is not
      // the object's own, the way an editor asks before it saves
      const at = args.indexOf("--source");
      const source = at < 0 ? undefined : readFileSync(args[at + 1], "utf8");
      const result = command === "check" ? store.check(type, name, {source}) : store.activate(type, name);
      console.log(JSON.stringify(result, undefined, 1));
      return result.issues.length === 0 ? 0 : 1;
    }
    case "search": {
      for (const hit of store.search(type, {source: name === "--source"})) {
        console.log(`${hit.type} ${hit.name}${hit.library ? " (library)" : ""}`);
      }
      return 0;
    }
    default:
      console.log("usage: osd-store.mjs list [TYPE] | read TYPE NAME | check TYPE NAME [--source FILE] | activate TYPE NAME | search TEXT [--source]");
      return 2;
  }
}

if (runsAs("osd-store.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
