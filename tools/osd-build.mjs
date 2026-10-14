import {missingLibraries, describeMissingLibraries} from "./osd-build-libraries.mjs";
export {missingLibraries, describeMissingLibraries};
import {activeSystem, systemFile} from "./osd-system.mjs";
import {warnSystemToolchain} from "./osd-system-toolchain.mjs";
import {userLayersOf} from "./osd-source-layers.mjs";
// A generation: the transpiled system, built to the side, named by what
// went into it, made live by renaming a link.
//
// A build into output/ used to destroy the previous generation before
// succeeding. The serving process survived, but a restart could not.
// Build beside the live generation so a failed save leaves it usable.
//
// Here a build never touches anything that is live. It goes into a
// directory of its own under build/tmp, and only a complete one is renamed
// into build/by-input/<hash>, where <hash> is the sha256 of every input:
// the files in the input folders, the library trees, the config, and which
// transpiler did the work. The same inputs give the same name, so a rebuild
// with nothing changed costs nothing, and a transpiler upgrade is a new
// generation, as it should be. `build/live` is a symlink to the generation
// that serves, and `output/` at the root is a symlink to `build/live/output`,
// so the runtime child, which reads OSD_ROOT/output and nothing else, is
// switched by one rename and knows nothing about any of this.
//
// Content hashing takes 105 ms here, 170 ms for the largest library;
// generations are 44 MB. See docs/generations.md for the design.
import {keepCompileInputs} from "./osd-compile-snapshot.mjs";
import {keepSourceInputs, keepGeneratedSources, completeSourceSnapshot, materializeSourceSnapshot, keepCachedSources} from "./osd-source-snapshot.mjs";
import {gc} from "./osd-build-gc.mjs";
import {normalPath, stampOf, changedError} from "./osd-build-input-check.mjs";
export {normalPath};
export {gc};
import {createHash} from "node:crypto";
import {libraryPath} from "./osd-lib-path.mjs";
import {checkLayerVersions} from "./layer-version/index.mjs";
import {compareGenerations} from "./osd-generation-diff.mjs";
import {execFileSync} from "node:child_process";
import {run} from "./osd-build-command.mjs";
import {existsSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from "node:fs";
import {basename, dirname, join, relative, resolve, resolve as resolvePath, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {buildIdentity, assertToolchain, describeBuild} from "./osd-transpiler.mjs";
import {describeDuplicates, excludePatterns, layers} from "./osd-inputs.mjs";
import {transpile, selectedModules} from "./osd-transpile.mjs";
import {inputFoldersOf, packsOf, userFoldersOf, webappsOf} from "./osd-packs.mjs";
import {describeUnfetched, unfetched} from "./osd-fetch.mjs";
import {toolCommand, hosted} from "./osd-host.mjs";
import {runsAs} from "./osd-main.mjs";
import {forPublishing} from "./osd-tmp.mjs";
import {sourceBuildOverlay} from "./osd-source-build-view.mjs";

// the tools this build runs before the transpiler, in the order the old npm
// script ran them; each writes its part of gen/ and says so
export const GENERATORS = [
  ["osd-transpiler.mjs"],
  ["osd-inputs.mjs"],
  ["osd-ddic-binary.mjs"],
  ["cds2ddic.mjs"],
  ["stg-compile.mjs", "--all"],
  ["segw-registry.mjs"],
  ["segw-shlp.mjs"],
  // BSP applications: a *.wapa.xml and its pages become a registry the ABAP
  // handler reads, so a page this system serves is an object like any other
  // rather than a file behind express
  ["osd-bsp-registry.mjs"],
  // AMDP: the bodies the transpiler cannot compile become routed calls, and
  // the SQLScript is put aside for HANA (docs/amdp-in-hana.md). Before the
  // function-module registry, because the modules it writes are what that
  // registry has to see.
  ["amdp-gen.mjs"],
  // and then the CDS table functions are checked against the methods that
  // implement them: the `returns` list is the authority and a mismatch fails
  // the build, because filling columns by position quietly is worse than not
  // building at all
  ["amdp-tablefunc.mjs"],
  ["osd-fm-registry.mjs"],
  // classic reports through open-abap-gui's converter, wired as transactions
  // (docs/gui-reports.md); before the transaction registry, which is what
  // picks up the *.tran.xml this writes
  ["osd-gui-convert.mjs"],
  ["osd-tran-registry.mjs"],
];

const TOOLS = fileURLToPath(new URL(".", import.meta.url));

export function layout(root) {
  const build = join(root, "build");
  return {
    root,
    build,
    byInput: join(build, "by-input"),
    tmp: join(build, "tmp"),
    live: join(build, "live"),
    lock: join(build, ".lock"),
    output: join(root, "output"),
    config: join(root, "abap_transpile.json"),
  };
}

// the config as the transpiler reads it: its own loader, because the file
// carries comments the JSON parser refuses, and it is the transpiler's file
export function loadConfig(root) {
  // the CLI's loader does exactly this (transpiler-cli/build/config.js:
  // parse the file when there is one, defaults when there is not), and it
  // was the last thing in the build path that reached the CLI package —
  // from inside a binary through the tree's node_modules, which is where
  // the SP4 binary first fell over
  const file = layout(root).config;
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8"));
  }
  return {
    input_folder: "src",
    input_filter: [],
    output_folder: "output",
    libs: [{url: "https://github.com/open-abap/open-abap-core"}],
    write_unit_tests: true,
    write_source_map: true,
    options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
  };
}

function walk(dir, out = [], seen = new Set()) {
  let entries;
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return out;
    seen.add(real);
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || [".osd-source.json", ".osd-layer.json", ".osd-system.json"].includes(e.name)) {
      continue;
    }
    const p = join(dir, e.name);
    let directory = e.isDirectory();
    let file = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const target = statSync(p);
        directory = target.isDirectory();
        file = target.isFile();
      } catch {
        directory = false;
        file = false;
      }
    }
    if (directory) {
      walk(p, out, seen);
    } else if (file) {
      out.push(p);
    }
  }
  return out;
}

// what a generation is made of, and the hash that names it
export function inputsOf(root, config = loadConfig(root)) {
  const folders = inputFoldersOf(root, config).map((f) => join(root, f)).filter(existsSync);
  const libs = (config.libs ?? []).map((l) => l.folder).filter((f) => f !== undefined && f !== "")
    .map((f) => (activeSystem(root) || existsSync(join(root, "libs.lock.json"))) ? libraryPath(root, basename(f)) : join(root, f));
  // BSP pages are generator inputs too. In particular, Component.js lives
  // outside the ABAP input folders and the ABAP-only filter below excludes
  // JavaScript. Omitting it reused a generation whose registry named a page
  // but whose Web Repository object was not in the transpiled runtime.
  const bspFolders = [systemFile(root, "webapp"), ...webappsOf(root).map((app) => app.dir)].filter(existsSync);
  // **A pack that brings nothing is not an input.** The VS Code extension
  // always hands the build an empty notebook-scratch pack in its own storage
  // (editors/vscode/launcher.js ensureWorkspacePacks), so its manifest's path,
  // which differs per machine, named every generation -- and a generation
  // prebuilt into the .vsix could never be reused (T2). An empty pack builds
  // nothing, so it names nothing; the moment it holds an input file (the same
  // rule hashOf applies to a folder: NOT_AN_INPUT files do not count) it is
  // an input. A data, ddic or webapp folder, or a tile, keeps it one anyway.
  const packs = packsOf(root).filter((pack) => pack.data !== undefined || pack.ddic !== undefined ||
    pack.webapp !== undefined || pack.tiles.length > 0 ||
    pack.abap.some((dir) => existsSync(dir) && walk(dir).some((f) => !NOT_AN_INPUT.test(f))));
  const packFiles = packs.map((pack) => join(pack.dir, "osd-pack.json"));
  const packFolders = packs.flatMap((pack) => [pack.data, pack.ddic].filter(Boolean));
  const sourceLayers = userLayersOf(root);
  return {folders, libs, bspFolders, packFiles, packFolders, sourceLayers, config: layout(root).config};
}

// What the transpiler and the generators read, and nothing else: a mocha
// test or a note beside the ABAP is not an input, and a hash that counted
// it would spend ten seconds building the same output again after an edit
// to a .mjs. Everything in an input folder counts except these.
// Optional DSL navigation metadata is generated beside the source, carries
// volatile provenance, and is excluded by the transpiler and BSP generator.
// Creating it (for example in dsl-l2's setup) must not invalidate live code.
const TRACE_METADATA = /\.trace\.meta\.json$/i;
const NOT_AN_INPUT = /\.(mjs|cjs|js|ts|py|md|txt|log|lock|snap|trace\.meta\.json)$/i;

/**
 * The modules that decide what `gen/` will contain: the generators and
 * everything they import, transitively.
 *
 * **`gen/` used to be in the hash as a stand-in for these, and a stand-in
 * written by the build is a self-reference.** `NOT_AN_INPUT` excludes
 * `.mjs`, so a generator's own code was not an input while its output was --
 * the hash watched the representative and not the thing represented. The
 * cost was visible: two builds of a fresh tree, with no edit between them,
 * produced two different generation names, because the first wrote `gen/`
 * and the second hashed it (measured 2026-09-19, and osg-osd-i7 measured the
 * same from the other side).
 *
 * So the representative goes and the thing represented arrives. 27 of the 92
 * modules in `tools/` are in the closure, which is why it is computed rather
 * than approximated by "all of them": editing a tool that no generator
 * reaches should not rename every generation.
 */
export function generatorClosure(toolsDir = TOOLS, generators = GENERATORS) {
  const seen = new Set();
  const walk = (file) => {
    const abs = resolvePath(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) walk(join(dirname(abs), m[1]));
    for (const m of text.matchAll(/import\("(\.[^"]+)"\)/g)) walk(join(dirname(abs), m[1]));
  };
  for (const [script] of generators) walk(join(toolsDir, script));
  walk(join(toolsDir, "osd-generator-view.mjs"));
  return [...seen].sort();
}

/** the generators, in order, writing into the working `gen/` as they always do */
export function runGenerators(root, log = () => {}, overlay = undefined) {
  let output = "";
  for (const [script, ...args] of GENERATORS) {
    log(`${script} ${args.join(" ")}`.trim());
    const [cmd, ...argv] = toolCommand(join(TOOLS, script), args);
    const view = activeOverlay(overlay);
    const env = {...process.env, OSD_ROOT: root};
    delete env.OSD_ACTIVE_BUILD_OVERLAY;
    if (view) {
      env.OSD_ACTIVE_BUILD_OVERLAY = JSON.stringify({...view, exclude: [...view.exclude]});
      // Hosted executables install this view in their gen dispatch.
      if (!hosted()) argv.unshift("--import", join(TOOLS, "osd-generator-view.mjs"));
    }
    output += run(cmd, argv, root, env);
  }
  return output;
}

/**
 * What identifies the generators that will actually RUN.
 *
 * Hashing the files under `tools/` is right under node and wrong in the
 * binary, and the difference is not cosmetic: `toolCommand()` turns a
 * generator into `osd gen <name>`, so a compiled binary executes its **own
 * embedded copies** and never reads `tools/*.mjs`. Hashing the tree's files
 * there would hash code that will not run -- the representative instead of
 * the thing represented, which is the mistake this hash was just repaired
 * for (osg-osd-i7 measured it: edit a generator and node's hash moves while
 * the binary's does not, because `TOOLS` is `/$bunfs/root/` inside the
 * bundle).
 *
 * So each host names what it will run: node the contents of the closure, the
 * binary itself. **And that means the two hosts legitimately name different
 * generations**, unless the binary was compiled from the very generators the
 * tree holds. That is a true statement about the system rather than a defect
 * to paper over, and the test that asserted equality now asserts what is
 * actually required -- that the two produce the same objects.
 *
 * The binary is 85 MB and hashes in 159 ms, so the answer is kept for the
 * life of the process: a cache check must not pay it twice.
 */
let binaryIdentity;
export function generatorIdentity(root = process.cwd()) {
  // Source dispatch hashes tools; embedded dispatch (including Node bundles) hashes its entry.
  const dispatch = hosted() ? JSON.parse(process.env.OSD_SELF) : undefined;
  const embedded = typeof __OSD_TOOLCHAIN_IDENTITY__ !== "undefined";
  if (dispatch && (embedded || dispatch.length === 1)) {
    if (binaryIdentity === undefined) {
      const executable = dispatch.length === 1 ? dispatch[0] : dispatch[1];
      binaryIdentity = "binary:" + createHash("sha256").update(readFileSync(executable)).digest("hex").slice(0, 16);
    }
    return binaryIdentity;
  }
  const h = createHash("sha256");
  const closure = generatorClosure();
  h.update(`generators ${closure.length}\0`);
  for (const f of closure) {
    h.update(relative(TOOLS, f).split(sep).join("/")).update("\0").update(readFileSync(f)).update("\0");
  }
  return "tools:" + h.digest("hex").slice(0, 16);
}

/** what `gen/` holds right now, by content: 196 files, milliseconds */
export function genHash(root) {
  const dir = join(root, "gen");
  if (!existsSync(dir)) return "";
  const h = createHash("sha256");
  for (const f of walk(dir).sort()) {
    h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

// a file's content, as a digest kept for as long as its stat says it has not
// changed: the name of a generation is then a walk and a stat per input,
// which is what lets a warm build (tools/osd-warm.mjs) name the generation it
// makes in milliseconds rather than reading the whole tree again. The key
// holds ctime as well as mtime, so a write that restores an mtime is seen
const DIGESTS = new Map();
function digestOf(file) {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  let hit = DIGESTS.get(file);
  if (hit === undefined || hit.key !== key) {
    hit = {key, digest: createHash("sha256").update(readFileSync(file)).digest("hex")};
    // git's rule for a racy entry: a file written in the last two seconds
    // may be written again within the resolution of its timestamps and keep
    // its size, so its digest is not kept -- it is read again next time
    if (Date.now() - st.mtimeMs > 2000) {
      DIGESTS.set(file, hit);
    } else {
      DIGESTS.delete(file);
    }
  }
  return hit.digest;
}

// `options`, all optional, are for a warm build (tools/osd-warm.mjs):
//   digests    filled with every input and its digest, which is what the warm
//              build compares with the inputs it was primed on;
//   folders    per input folder, the (file, digest) list of an earlier walk,
//              for a folder a watcher says has not changed since -- the
//              libraries are 4400 of this tree's 5100 inputs;
//   transpiler buildIdentity(root), when the caller has it already.
// None of them changes the name: it is the same hash over the same list.
//   overlay    the inactive objects an ObjectStore keeps out of the build
//              (overlayOf below); an empty or absent one changes nothing.
export function hashOf(root, inputs = inputsOf(root), options = {}) {
  const digests = options instanceof Map ? options : options.digests;
  const overlay = options instanceof Map ? undefined : activeOverlay(options.overlay);
  // a folder walk cached for a tree without an overlay is not this list
  const folders = options instanceof Map || overlay !== undefined || options.substitute !== undefined ? undefined : options.folders;
  const kept = overlay === undefined ? () => true : (f) => !overlay.exclude.has(resolve(f));
  // a proof, not a build: these files counted with these digests (a warm
  // prime asking whether its view is the live generation with saves since
  // put back to the bytes they replaced, tools/osd-warm.mjs)
  const substitute = options instanceof Map ? undefined : options.substitute;
  const hash = createHash("sha256");
  // Optional audit of the exact framed inputs, in hashing order.
  const h = {update(value) {
    options.trace?.(value);
    hash.update(value);
    return this;
  }, digest: (...args) => hash.digest(...args)};
  h.update("transpiler\0").update(String(options.transpiler ?? buildIdentity(root))).update("\0");
  // the rule that decides a name held by two inputs is part of what the
  // output is: a generation built under another rule is another generation
  h.update("layers\0later-wins\0");
  const system = activeSystem(root);
  if (system) h.update("system\0").update(system.digest).update("\0");
  for (const layer of inputs.sourceLayers ?? []) {
    h.update("source-layer\0").update(JSON.stringify(layer)).update("\0");
  }
  h.update("config\0").update(readFileSync(inputs.config)).update("\0");
  const folder = (label, dir, list) => {
    let entries = folders?.get(dir);
    if (entries === undefined) {
      entries = list().map((f) => [f, substitute?.get(resolve(f)) ?? digestOf(f)]);
      folders?.set(dir, entries);
    }
    // an empty folder builds nothing, so its path does not name the generation
    if (entries.length === 0) return;
    h.update(`${label} ${relative(root, dir)} ${entries.length}\0`);
    for (const [f, digest] of entries) {
      digests?.set(f, digest);
      h.update(relative(root, f)).update("\0").update(digest).update("\0");
    }
  };
  for (const dir of [...inputs.folders, ...inputs.libs]) {
    // **`gen/` is an OUTPUT and is left out.** It is written by this build
    // from the folders above and the generators below, so hashing it made
    // the name a function of the tree AND of how many times the tree had
    // been built. What decides its content is hashed instead.
    if (relative(root, dir) === "gen") continue;
    folder("dir", dir, () => (existsSync(dir) ? walk(dir).filter((f) => !NOT_AN_INPUT.test(f) && kept(f)).sort() : []));
  }
  // the last active versions of the objects whose saved version is kept
  // out: a generation built from them is another generation
  if (overlay?.folder !== undefined) {
    const dir = join(root, overlay.folder);
    folder("active", dir, () => (existsSync(dir) ? walk(dir).filter((f) => !NOT_AN_INPUT.test(f) && kept(f)).sort() : []));
  }
  for (const dir of inputs.bspFolders ?? []) {
    folder("bsp", dir, () => walk(dir).filter((f) => !TRACE_METADATA.test(f)).sort());
  }
  for (const dir of inputs.packFolders ?? []) {
    folder("pack", dir, () => walk(dir).filter((f) => !TRACE_METADATA.test(f)).sort());
  }
  for (const file of inputs.packFiles ?? []) {
    h.update(`manifest ${relative(root, file)}\0`).update(digestOf(file)).update("\0");
  }
  // the generators that will actually run -- the files under node, the
  // binary itself when it is the binary, because it executes its own copies
  h.update("generators\0").update(generatorIdentity(root)).update("\0");
  return h.digest("hex").slice(0, 16);
}

// one build at a time: the generators write gen/ at the root, and two of
// them at once would race over it. A stale lock from a process that died is
// taken over, not obeyed.
export function lock(paths) {
  mkdirSync(paths.build, {recursive: true});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(paths.lock);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const pid = Number(readFileSync(paths.lock, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        const e = new Error(`a build is already running (pid ${pid})`);
        e.code = "BUSY";
        throw e;
      }
      unlinkSync(paths.lock);
    }
  }
  throw new Error("could not take the build lock");
}

// The transpiled modules reach outside output/ for one thing: the setup
// hook the config names as "../test/setup.mjs" (and whatever else a config
// may point at with "../"). Node resolves a relative import from the real
// path of the importing file, not through the symlink at the root, so from
// build/by-input/<hash>/output that path lands beside the generation, where
// nothing is. A relative symlink per such directory makes the generation
// self-contained in the way the old output/ was by accident of sitting at
// the root. Idempotent, and run on switch as well as on build, so a
// generation made before this existed gets its links the first time it
// goes live.
// the directories beside output/ that the modules of a generation name with
// "../<dir>/": the setup hook, and whatever else a module points at. `files`
// narrows the scan to some modules (a warm build's rebuilt ones)
export function rootsWanted(generation, config, files = undefined) {
  const wanted = new Set();
  const setup = config?.options?.setup?.filename;
  if (typeof setup === "string") {
    const m = /^\.\.\/([^/]+)/.exec(setup);
    if (m) {
      wanted.add(m[1]);
    }
  }
  const out = join(generation, "output");
  const names = files ?? (existsSync(out) ? readdirSync(out).filter((n) => n.endsWith(".mjs")).slice(0, 4000) : []);
  for (const f of names) {
    const text = readFileSync(join(out, f), "utf8");
    for (const m of text.matchAll(/["'`]\.\.\/([^/"'`]+)\//g)) {
      wanted.add(m[1]);
    }
  }
  return wanted;
}

// A link to a directory: a relative symlink where anyone may make one, a
// junction on Windows, where a symlink needs an administrator or Developer
// Mode and a junction needs neither. A junction's target is absolute, and
// OSD_DIR_LINK=junction takes that form anywhere, so the path Windows takes
// is tested on Linux too. `target` is relative to the link's own folder.
export function dirLinkMode(env = process.env) {
  return env.OSD_DIR_LINK ?? (process.platform === "win32" ? "junction" : "symlink");
}
export function linkDir(target, path) {
  if (dirLinkMode() === "junction") {
    symlinkSync(resolve(dirname(path), target), path, "junction");
  } else {
    symlinkSync(target, path, "dir");
  }
}
// a link replaced by another: one rename where the platform renames over an
// existing link, and where it refuses (a junction on Windows), the old link
// removed first -- a moment without it, which a reader that finds nothing
// retries
function replaceLink(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!["EPERM", "EEXIST", "EISDIR", "ENOTEMPTY", "EACCES"].includes(error?.code)) throw error;
    unlinkSync(to);
    renameSync(from, to);
  }
}

export function linkRoots(root, generation, config = loadConfig(root), log = () => {}, options = {}) {
  // `wanted`: the names, when the caller knows them already (a warm build:
  // the live generation's plus whatever the modules it rebuilt name)
  const wanted = new Set(options.wanted ?? rootsWanted(generation, config));
  for (const name of wanted) {
    // a string that merely looks like a path ("../sap/bc/…" in a literal)
    // names nothing at the root, and a link to nothing is worse than none
    if (!existsSync(join(root, name)) || !statSync(join(root, name)).isDirectory()) {
      wanted.delete(name);
      continue;
    }
    const link = join(generation, name);
    const target = relative(generation, join(root, name));
    let kind;
    try {
      kind = lstatSync(link);
    } catch {
      kind = undefined;
    }
    if (kind === undefined) {
      linkDir(target, link);
      log(`${basename(generation)}/${name} -> ${target}`);
    }
  }
  return [...wanted];
}

export function liveHash(root) {
  // a store that is not over a tree (a test's stand-in) has no generation
  if (root === undefined || root === null || root === "") {
    return undefined;
  }
  const paths = layout(root);
  try {
    // a junction reads back absolute, on Windows with a trailing separator
    return basename(readlinkSync(paths.live).replace(/[\\/]+$/, "").replace(/\\/g, "/"));
  } catch {
    return undefined;
  }
}

/** Read-only proof using the builder's own hash, including generator identity. */
export function generationStateSnapshot(root = process.cwd(), {hashTree = true} = {}) {
  const live = liveHash(root);
  return {root, live: live ?? null, ...(hashTree ? {tree: live === undefined ? null : hashOf(root)} : {})};
}

export function generations(root) {
  const paths = layout(root);
  if (!existsSync(paths.byInput)) {
    return [];
  }
  const live = liveHash(root);
  return readdirSync(paths.byInput)
    .map((hash) => {
      try {
        const manifest = JSON.parse(readFileSync(join(paths.byInput, hash, "manifest.json"), "utf8"));
        return {...manifest, hash, live: hash === live};
      } catch {
        return undefined;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.builtAt).localeCompare(String(b.builtAt)));
}

// point live at a generation, and output at live. Two renames, each atomic;
// nothing between them is a state a reader can see as "no output".
export function switchTo(root, hash, log = () => {}, options = {}) {
  const paths = layout(root);
  const target = join(paths.byInput, hash);
  if (!existsSync(join(target, "output"))) {
    const e = new Error(`generation ${hash} is not built`);
    e.code = "NOT_BUILT";
    throw e;
  }
  linkRoots(root, target, undefined, log, options);
  const tmpLink = paths.live + ".tmp";
  try {
    unlinkSync(tmpLink);
  } catch {
    // nothing to remove
  }
  linkDir(join("by-input", hash), tmpLink);
  replaceLink(tmpLink, paths.live);

  // output/ at the root: a symlink to build/live/output. A real directory
  // there is what every tree had before this existed; it is moved aside once
  // and reclaimed by gc, never deleted underneath a process that may still
  // be loading from it.
  let kind;
  try {
    kind = lstatSync(paths.output);
  } catch {
    kind = undefined;
  }
  if (kind !== undefined && !kind.isSymbolicLink()) {
    const aside = join(paths.build, `legacy-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    renameSync(paths.output, aside);
    log(`output/ was a directory: moved to ${relative(root, aside)}`);
    kind = undefined;
  }
  if (kind === undefined) {
    linkDir(join("build", "live", "output"), paths.output);
  }
  log(`live -> ${hash}`);
  return hash;
}

// the build: hash, then either the cached generation or a fresh one to the
// side, then the switch. Every failure leaves live untouched.
// what every build refuses before it takes a lock or runs a generator, and
// the layers it builds from: shared by the cold build below and the warm one
// (tools/osd-warm.mjs), so the two cannot disagree about what a tree is
export function prepare(root, log = () => {}) {
  const config = loadConfig(root);
  warnSystemToolchain(root, activeSystem(root), log);
  checkLayerVersions(root, packsOf(root), userFoldersOf(root), log);
  const missingLibs = missingLibraries(root, config);
  if (missingLibs.length > 0) {
    const e = new Error(`the build refuses: ${describeMissingLibraries(missingLibs)}`);
    e.code = "MISSING_LIBRARIES";
    e.missing = missingLibs;
    throw e;
  }
  if (existsSync(join(root, "libs.lock.json"))) {
    for (const lib of config.libs ?? []) libraryPath(root, basename(lib.folder));
  }
  // the layers, resolved before anything else (tools/osd-inputs.mjs): the
  // same file name twice inside one folder is a refusal naming both files,
  // never a guess, and it is refused before a lock is taken or a generator
  // runs; an object an earlier layer hides is said, and hidden below
  // a pack that fetches a folder and has not: a smaller system than the
  // manifest describes, refused before it is built (tools/osd-fetch.mjs)
  const missing = unfetched(root);
  if (missing.length > 0) {
    const e = new Error(`the build refuses: ${describeUnfetched(missing)}`);
    e.code = "UNFETCHED";
    e.missing = missing;
    throw e;
  }
  const stack = layers(root, config);
  if (stack.duplicates.length > 0) {
    const e = new Error(`the build refuses: ${describeDuplicates(stack.duplicates)}`);
    e.code = "DUPLICATE";
    e.duplicates = stack.duplicates;
    throw e;
  }
  for (const {object, winner, hidden} of stack.overridden) {
    log(`overridden: ${object}: ${hidden.join(", ")} hidden by ${winner}`);
  }
  return {config, stack};
}

// the config a build hands the transpiler: the same config, aimed at the
// build's own directory. The path is root-relative because the transpiler
// joins it to its working directory. The transpiler is handed the winner of
// every name only: a class in two inputs is "already defined" to it, not an
// override, so the files an earlier layer hides are kept from it here
export function ownConfig(root, config, stack, outputFolder, overlay = undefined) {
  const kept = activeOverlay(overlay);
  return {
    ...config,
    // the packs are layers of this build, so the transpiler is handed them
    // with the tree's own folders (backlog E.2); the last active versions of
    // inactive objects come last, and their saved files are excluded
    input_folder: [...inputFoldersOf(root, config), ...(kept?.folder === undefined ? [] : [kept.folder])],
    output_folder: relative(root, outputFolder),
    exclude_filter: [...(config.exclude_filter ?? []), ...excludePatterns(stack.hidden),
      ...[...(kept?.exclude ?? [])].sort().map((file) => `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)],
  };
}

// **An inactive object is not built** (vsp-i7's abapGit spike, 2026-10-02).
// The tree is the working area: a save lands in its file before anyone
// activates it, so a build of the folders alone built every saved-but-failed
// source too, and one broken object failed every later activation of
// anything until it was deleted. The store says which objects are inactive
// (ObjectStore#overlay): their files are excluded by absolute path, and the
// last active version of each, when it had one, comes from `folder` instead.
// {exclude: [absolute files], folder: root-relative folder | undefined}
const overlayFilesOf = (root, overlay) => {
  const dir = activeOverlay(overlay)?.folder === undefined ? undefined : join(root, overlay.folder);
  return dir !== undefined && existsSync(dir) ? walk(dir).map((f) => relative(root, f).split(sep).join("/")).sort() : [];
};

export function activeOverlay(overlay) {
  if (overlay === undefined || overlay === null) return undefined;
  const exclude = new Set([...(overlay.exclude ?? [])].map((f) => resolve(f)));
  if (exclude.size === 0 && overlay.folder === undefined) return undefined;
  return {exclude, folder: overlay.folder};
}

export async function build(options = {}) {
  const root = resolve(options.root ?? process.env.OSD_ROOT ?? process.cwd());
  options = {...options, overlay: await sourceBuildOverlay(root, options)};
  const log = options.log ?? (() => {});
  const paths = layout(root);
  const started = Date.now();
  const {config, stack} = prepare(root, log);
  const inputs = inputsOf(root, config);
  // what each input held when the generation was named: the bytes it is
  // built from (checked as the transpiler reads them, below), and what an
  // activation's completion compares with (ObjectStore#completeActivations)
  const loaded = selectedModules(root);
  const identity = assertToolchain(root, loaded);
  const named = new Map();
  const hash = hashOf(root, inputs, {overlay: options.overlay, digests: named, transpiler: identity});
  // one spelling of a path for every comparison: a native one from the walk,
  // a forward-slash one from the transpiler's reads on Windows
  const digests = new Map([...named].map(([file, digest]) => [normalPath(file), digest]));
  // **What the generators read is verified as well as what the transpiler
  // reads.** A CDS view or a table is no transpiler input -- a generator
  // reads it -- so a save between the hash and the generators' read, put
  // back before the completion, built a generation of other bytes under
  // this name. Every non-library input is stamped (size, times, inode) here,
  // checked against the hash's digest once stamped (closing the gap between
  // the hash's read and the stamp), and stamped again after the build: any
  // write in between, even one that restores the bytes, changes the stamp.
  const libraries = inputs.libs.map((dir) => normalPath(dir) + "/");
  const watched = [...named.keys()].filter((file) => !libraries.some((lib) => normalPath(file).startsWith(lib)));
  const stamps = new Map(watched.map((file) => [file, stampOf(file)]));
  const moved = watched.filter((file) => (existsSync(file) ? digestOf(file) : undefined) !== named.get(file));
  if (moved.length > 0) throw changedError(root, moved);
  if (options.expectedHash !== undefined && hash !== options.expectedHash) throw changedError(root, []);
  const target = join(paths.byInput, hash);
  // a generation a warm build made (tools/osd-warm.mjs) is not a cache hit
  // until a cold transpile has been compared with it: it is built again,
  // compared, and replaced if it differs
  const warmSide = `${target}.warm.json`;
  let warmUnchecked = false;
  try {
    warmUnchecked = JSON.parse(readFileSync(warmSide, "utf8")).verified !== true;
  } catch (error) {
    warmUnchecked = error.code !== "ENOENT";
  }
  if (warmUnchecked) {
    options = {...options, force: true, replace: true};
    log(`generation ${hash} was made warm and nobody has compared it yet: building it cold`);
  }

  if (options.force !== true && existsSync(join(target, "manifest.json"))) {
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    // **A cache hit must not leave `gen/` holding somebody else's edit.**
    // The generation is reused because the INPUTS match; `gen/` is an output
    // and is written by the generators, which a cache hit skips. If what is
    // on disk is not what this generation was made from, the generators run
    // again -- the transpile still does not.
    if (manifest.gen !== undefined && manifest.gen !== genHash(root)) {
      log(`generation ${hash} is already built, but gen/ has drifted from it -- regenerating`);
      const unlockAgain = lock(paths);
      try {
        runGenerators(root, log, options.overlay);
      } finally {
        unlockAgain();
      }
    } else {
      log(`generation ${hash} is already built`);
    }
    keepCachedSources(root, target, digests, options.overlay);
    if (options.switch !== false && liveHash(root) !== hash) {
      switchTo(root, hash, log);
    }
    return {ok: true, hash, cached: true, live: liveHash(root) === hash, ms: Date.now() - started, objects: manifest.objects, digests};
  }

  const unlock = lock(paths);
  const tmp = join(paths.tmp, `${hash}.${process.pid}`);
  let output = "";
  try {
    rmSync(tmp, {recursive: true, force: true});
    mkdirSync(join(tmp, "output"), {recursive: true});
    // generators: false is for a tree with nothing to generate (a test's
    // tree of a few classes); every real build runs them
    if (options.generators !== false) {
      output += runGenerators(root, log, options.overlay);
    }
    await options.onStep?.("generated");
    // **The layers are read again once gen/ is written.** gen/ is a layer, and
    // an object it holds hides the one in src/ it was generated from (the AMDP
    // bridge: gen/amdp/zcl_osd_amdp_demo over src/amdp/). Reading the layers
    // only before the generators ran gave a fresh checkout's first build no
    // such hiding -- gen/amdp did not exist yet -- so the transpiler got both
    // copies of the class, and the same inputs built different bytes on the
    // first build than on every later one (found by the warm build's premise
    // check, tools/osd-warm.mjs prime, 2026-09-26).
    const after = options.generators !== false ? layers(root, config) : stack;
    if (after.duplicates.length > 0) {
      const e = new Error(`the build refuses: ${describeDuplicates(after.duplicates)}`);
      e.code = "DUPLICATE";
      e.duplicates = after.duplicates;
      throw e;
    }
    for (const {object, winner, hidden} of after.overridden) {
      if (!stack.overridden.some((o) => o.object === object)) {
        log(`overridden: ${object}: ${hidden.join(", ")} hidden by ${winner}`);
      }
    }
    const own = ownConfig(root, config, after, join(tmp, "output"), options.overlay);
    writeFileSync(join(tmp, "abap_transpile.json"), JSON.stringify(own, null, 2));
    // the transpile itself is a library call in this process (N3,
    // tools/osd-transpile.mjs): no node_modules/.bin, no second process,
    // no parsing a count out of its output
    log("transpile");
    // **The bytes the generation is named by are the bytes it is built
    // from.** A save that lands between the hash above and the transpiler's
    // read would build other bytes under this name; it is refused instead,
    // and the next build names what is there then
    const changed = [];
    const generatedDigests = new Map();
    const made = await transpile({root, modules: loaded, config: own, log: (m) => { output += m + "\n"; },
      onInputs: (files, libs) => keepCompileInputs(root, tmp, own, files, libs, options.overlay),
      onRead: (file, bytes) => {
        if (normalPath(file).startsWith(normalPath(join(root, "gen")) + "/")) {
          generatedDigests.set(normalPath(file), createHash("sha256").update(bytes).digest("hex"));
        }
        const known = digests.get(normalPath(file));
        if (known !== undefined && createHash("sha256").update(bytes).digest("hex") !== known) throw changedError(root, [file]);
      }});
    // and nothing the generators or the transpiler read was written since
    // it was named
    assertToolchain(root, loaded);
    changed.push(...watched.filter((file) => stampOf(file) !== stamps.get(file)));
    if (changed.length > 0) throw changedError(root, changed);
    keepSourceInputs(root, tmp, digests, undefined, options.overlay);
    keepGeneratedSources(root, tmp, generatedDigests);
    materializeSourceSnapshot(root, tmp); // Include compiler-only inputs such as $TMP's tadir.json on every build.
    completeSourceSnapshot(tmp);
    const objects = made.objects;

    const manifest = {
      sourceLayers: inputs.sourceLayers ?? [],
      hash,
      builtAt: new Date().toISOString(),
      ms: Date.now() - started,
      objects,
      transpiler: describeBuild(root),
      toolchain: identity,
      inputs: {folders: inputs.folders.map((f) => relative(root, f)), libs: inputs.libs.map((f) => relative(root, f)),
        // the active copies an overlay added: a publisher reads them too (osd-tmp.mjs)
        overlay: overlayFilesOf(root, options.overlay)},
      // What `gen/` held when this generation was made. `gen/` is an OUTPUT
      // and is out of the hash (it used to be in it, which made the name
      // self-referential) -- and taking it out removed an accidental
      // protection: a cache hit skips the generators, so `gen/` on disk can
      // be left holding a previous edit's output while `src/` says
      // otherwise. Measured: edit a view, build, restore the source, build
      // again -- the second build reuses the generation and three files
      // under `gen/` still hold the edit (2026-09-19). The served system is
      // right; the working tree is not, and the next thing to read `gen/`
      // believes it.
      gen: genHash(root),
      overridden: after.overridden,
    };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    // **The generation's own copy of the config described the process that
    // made it.** `output_folder` held the build's tmp path, pid and all, so
    // two builds of one generation differed in exactly one of 2249 files --
    // and the difference was a process id. An artefact addressed by the hash
    // of its inputs must not carry the number of the process that wrote it.
    // Nothing reads this copy after the build (every reader takes the root's
    // one), so it is rewritten to describe ITSELF: the output is at `output`,
    // relative to the generation (2026-09-19, B.9).
    writeFileSync(join(tmp, "abap_transpile.json"),
      JSON.stringify({...own, output_folder: "output"}, null, 2));
    linkRoots(root, tmp, config, log);

    mkdirSync(paths.byInput, {recursive: true});
    if (existsSync(target) && options.force === true) {
      // **Build, compare, report -- never both keep the name and change the
      // bytes** (backlog B.9). A generation is addressed by the hash of its
      // inputs so that a name means one set of bytes; a forced build that
      // replaced the directory gave a consumer pinned to `<hash>` different
      // content under an unchanged name, which is the thing immutability was
      // for.
      materializeSourceSnapshot(root, target);
      const verdict = compareGenerations(target, tmp);
      if (verdict.same) {
        log(`generation ${hash} rebuilt byte for byte: ${verdict.files} files` +
          (verdict.collapsed.length > 0 ? `, after ${verdict.collapsed.join("; ")}` : ""));
        rmSync(tmp, {recursive: true, force: true});
      } else if (options.replace === true) {
        // asked for, in so many words. Two renames rather than a remove and
        // a rename, so there is no moment at which the live link points at
        // nothing.
        const changed = [...verdict.differing, ...verdict.onlyInA, ...verdict.onlyInB];
        log(`generation ${hash} REPLACED, ${changed.length} files differ: ${changed.slice(0, 5).join(", ")}`);
        const replaced = `${target}.replaced.${process.pid}`;
        renameSync(target, replaced);
        renameSync(tmp, target);
        rmSync(replaced, {recursive: true, force: true});
      } else {
        // The interesting case, and it is a FINDING rather than a nuisance:
        // the same inputs produced different output, so the transpiler or the
        // builder changed under them. Saying so is the point; overwriting
        // would hide it.
        const changed = [...verdict.differing, ...verdict.onlyInA, ...verdict.onlyInB];
        rmSync(tmp, {recursive: true, force: true});
        const error = new Error(
          `generation ${hash} is NOT reproducible: ${changed.length} of ${verdict.files} files differ ` +
          `(${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}). The same inputs gave ` +
          "different output, so the transpiler or the builder changed under them -- which is a finding, " +
          "not a nuisance. Nothing was overwritten: a name that keeps its bytes is what a generation is " +
          "for. Pass --replace to take the new bytes under the same name anyway.");
        error.notReproducible = {hash, changed, files: verdict.files};
        throw error;
      }
    } else if (existsSync(target)) {
      // a build of the same inputs finished while this one ran (a race the
      // lock did not cover); theirs is as good as ours
      rmSync(tmp, {recursive: true, force: true});
    } else {
      renameSync(tmp, target);
    }
    if (warmUnchecked) {
      // the bytes under the name are a cold build's now
      rmSync(warmSide, {force: true});
    }
    if (options.switch !== false) {
      switchTo(root, hash, log);
    }
    return {ok: true, hash, cached: false, live: liveHash(root) === hash, ms: manifest.ms, objects, output: options.verbose ? output : undefined, digests};
  } catch (error) {
    rmSync(tmp, {recursive: true, force: true});
    error.output = (error.output ?? "") || output;
    throw error;
  } finally {
    unlock();
  }
}

export async function main(args) {
  // a build for publishing leaves $TMP out (tools/osd-tmp.mjs)
  if (args.includes("--publish")) forPublishing(process.env);
  const root = process.env.OSD_ROOT ?? process.cwd();
  const say = (m) => console.log(`osd-build: ${m}`);
  const cmd = args.find((a) => !a.startsWith("--")) ?? "build";
  if (cmd === "list") {
    const all = generations(root);
    if (all.length === 0) {
      say("no generations yet");
    }
    for (const g of all) {
      say(`${g.live ? "*" : " "} ${g.hash}  ${g.builtAt}  ${g.objects} objects  ${g.ms} ms`);
    }
    return 0;
  }
  if (cmd === "switch") {
    const hash = args[args.indexOf("switch") + 1];
    switchTo(root, hash, say);
    return 0;
  }
  if (cmd === "gc") {
    const at = args.indexOf("--keep");
    const removed = gc(root, {keep: at >= 0 ? Number(args[at + 1]) : undefined});
    say(removed.length === 0 ? "nothing to remove" : `removed ${removed.join(", ")}`);
    return 0;
  }
  if (cmd === "hash") {
    say(hashOf(root));
    return 0;
  }
  try {
    const r = await build({root, force: args.includes("--force"), replace: args.includes("--replace"),
      switch: !args.includes("--no-switch"), log: say});
    say(`${r.cached ? "reused" : "built"} ${r.hash} in ${r.ms} ms, ${r.objects} objects${r.live ? ", live" : ""}`);
    return 0;
  } catch (error) {
    if (error.code === "OSD_VERSION_MISMATCH") console.error(error.message);
    else say(`${error.code ?? "FAILED"}: ${error.message}`);
    if (error.output) {
      console.error(String(error.output).slice(-3000));
    }
    say("live generation untouched");
    return 1;
  }
}

if (runsAs("osd-build.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
