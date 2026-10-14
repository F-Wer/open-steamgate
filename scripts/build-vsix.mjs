// One universal .vsix that carries the system inside it (docs/vscode-extension.md,
// "B0 spike", "What packaging still needs"). `npm run vsix` writes
// `build/vsix/open-steamgate-<version>.vsix`: a plain zip -- built with the
// system `zip` CLI, not `vsce` -- of `[Content_Types].xml`,
// `extension.vsixmanifest` (both generated from `editors/vscode/package.json`
// the way vsce does) and an `extension/` folder holding the extension itself
// plus a solid Brotli tar seed at `extension/osd/seed.tar.br`.
//
// What goes into `extension/osd/` is exactly what `node test/run.mjs` needs
// at run time, found by tracing rather than guessing. **A prebuilt
// generation IS shipped since T2 (2026-09-27, prebuildGeneration below):
// built inside the staged seed, its name is portable.** The history that
// follows is why shipping the CHECKOUT's `output/` could not work.
// **`output/` is NOT
// shipped** (fallback (b) of the vsix-prebuilt-generation task,
// 2026-09-26; see docs/vscode-extension.md, "Packaging", for the numbers
// and the portable-hash design this replaces): the first design shipped
// `output/` alone as plain files, on the theory that a first build on the
// user's machine would recompute the SAME input hash and reuse it (the
// generation cache, `build/by-input/<hash>/`). Two things ruled that out.
// `zip` without `-y` dereferences a symlink into a real directory when it
// archives one, so the cache entry and `build/live` cannot travel as
// themselves -- only `output/` tolerates arriving as a plain directory
// (`switchTo` moves a pre-existing one aside to `build/legacy-<ts>` on the
// first real build, "what every tree had before this existed"). Prebuilt
// generations are now built from the staged seed's own input closure below,
// instead of copying the development tree's output. Package identity uses
// name, version and built-file content, so linked packages and the seed's
// plain copies can describe the same code without checkout paths or Git state.
//   - `src/`, selected `packs/` (zork by default; OSD_VSIX_PACKS selects
//     more), `webapp/`, `tools/` (whole), `test/` minus `test/e2e/`,
//     `test/fixtures/`, and the two synthetic fleet reports. The directories
//     match `abap_transpile.json`'s and `abaplint.jsonc`'s exclude lists --
//     not just `run.mjs`/`start.mjs`/`setup.mjs` and
//     their JS imports (traced by grep, including one dynamic import,
//     `test/setup.mjs` -> `./seed.mjs`): `abaplint.jsonc`'s own
//     `global.files` glob makes ALL of `test/` an input to the abaplint
//     registry `tools/osd-store.mjs` builds at startup, non-JS ABAP fixtures
//     included, which a JS import graph alone can never find;
//   - `abaplint.jsonc` itself, read at startup by that same registry;
//   - `data/` (root seed rows -- `tools/osd-packs.mjs` `dataDirsOf()` reads
//     it, `test/seed.mjs` calls that);
//   - `abap_transpile.json` and, at the exact relative paths it names, the
//     library sources it reads: `.local/lars/<name>/...`, each trimmed to
//     what the library's own `files` glob names (abapGit, open-abap-gui,
//     open-abap-odata, ajson) or, for a library with no `files` filter
//     (open-abap-core, express-icf-shim, open-abap-apc), everything except
//     that library's OWN `node_modules/`, `output/` and `test/` -- its own
//     build litter, never read by our transpile;
//   - `node_modules/`, traced from `package-lock.json`'s own dependency
//     graph (lockfileVersion 3, flat `packages` map) starting at the five
//     packages the run-time path actually imports (`@abaplint/core`,
//     `@abaplint/runtime`, `@abaplint/transpiler`, `@abaplint/database-sqlite`,
//     `express`) and walking `dependencies`/`optionalDependencies` --
//     answered by npm's own resolution, not by a guess at what "the
//     transitive deps" are. `open-rfc` (live RFC) and `@duckdb/*` (not on
//     the default path, per CLAUDE.md) are left out on purpose.
//
// Left out on purpose: `.git`, `.local/worktrees`, `.local/corpus*` (SAP
// corpus -- never shipped, CLAUDE.md), every other `.local/lars/*` clone,
// `test/e2e`, `test/fixtures` used only by suites not shipped, Playwright,
// DuckDB, Postgres, docs, and every dev-only devDependency (webpack, mocha,
// chai, terser, the browserify shims -- browser-preview and node-test-only).
//
// See `docs/vscode-extension.md`, "Packaging", for the measured numbers this
// produced and the trims proposed if the total ever creeps back up.
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {createReadStream, createWriteStream} from "node:fs";
import {pipeline} from "node:stream/promises";
import {createBrotliCompress, constants as zlibConstants} from "node:zlib";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {describeVsixPreflight} from "../tools/osd-lock.mjs";
import {libraryPath, vsixPreflightMissing} from "../tools/osd-lib-path.mjs";
import {requireSupportedNode} from "../tools/osd-node-version.mjs";
import {packAt} from "../tools/osd-packs.mjs";
import {packagedVersion, writeVersionMarker} from "../tools/layer-version/index.mjs";
import {readLock} from "../tools/osd-lock.mjs";
import {writeThirdPartyNotices} from "./third-party-notices.mjs";
import {forPublishing, generationTmpProblem} from "../tools/osd-tmp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, "editors", "vscode");
const BUILD_DIR = join(ROOT, "build", "vsix");
let minimatch;
/** load what copySeedTree needs and a preflight may find missing (minimatch,
 *  for the libraries' `files` filters); stageSystemSeed calls it first */
export async function loadSeedDependencies() {
  ({minimatch} = await import("minimatch"));
}
const require = createRequire(import.meta.url);
const {writeSeedId, writeTar} = require("../editors/vscode/launcher.js");

function pinnedTranspilerRef() {
  const ref = readLock(ROOT).transpiler.ref;
  const base = join(ROOT, "node_modules", "@abaplint");
  const transpiler = realpathSync(join(base, "transpiler"));
  const runtime = realpathSync(join(base, "runtime"));
  const core = realpathSync(join(base, "core"));
  const clone = resolve(transpiler, "..", "..");
  if (transpiler !== join(clone, "packages", "transpiler") ||
      runtime !== join(clone, "packages", "runtime") ||
      core !== join(clone, "packages", "transpiler", "node_modules", "@abaplint", "core") ||
      execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {encoding: "utf8"}).trim() !== ref ||
      !readFileSync(join(transpiler, "build", "src", "index.js"), "utf8").includes("this.options?.only?.(obj) === false")) {
    throw new Error("build-vsix: transpiler and runtime must be linked to the built libs.lock.json fork; see tools/osd-ci-transpiler-build.sh");
  }
  return ref;
}

/** Only named in-tree packs can enter the seed. An empty override selects no
 * packs; an unknown name is a typo, not a silently smaller package. */
function vsixPacks(env = process.env) {
  const profile = env.OSD_VSIX_PROFILE ?? "default";
  if (!["default", "marketplace", "web-probe"].includes(profile)) throw new Error(`build-vsix: unknown OSD_VSIX_PROFILE: ${profile}`);
  const names = env.OSD_VSIX_PACKS !== undefined
    ? (env.OSD_VSIX_PACKS.trim() ? env.OSD_VSIX_PACKS.split(",").map((name) => name.trim()) : [])
    : ["zork"];
  const selected = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`build-vsix: invalid pack name in OSD_VSIX_PACKS: ${JSON.stringify(name)}`);
    }
    const pack = packAt(ROOT, join(ROOT, "packs", name));
    if (pack === undefined || pack.name !== name) {
      throw new Error(`build-vsix: unknown pack in OSD_VSIX_PACKS: ${name}`);
    }
    if (selected.some((other) => other.name === name) === false) selected.push(pack);
  }
  return selected;
}

function log(msg) {
  console.log(`build-vsix: ${msg}`);
}

/** Stamps only the package.json inside the staged extension. A package
 *  version is the tracked major.minor plus the checkout's commit count; local
 *  edits deliberately do not affect the number. The seed content ID handles
 *  freshness for dirty builds. */
export function stampStagedPackage(stagedPackagePath, root = ROOT) {
  const version = packagedVersion(root);
  const dirty = execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim().length > 0;
  const pkg = JSON.parse(readFileSync(stagedPackagePath, "utf8"));
  pkg.version = version;
  writeFileSync(stagedPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  return {pkg, dirty};
}

function dirSizeBytes(dir) {
  if (existsSync(dir) === false) return 0;
  const out = execFileSync("du", ["-sk", dir], {encoding: "utf8"});
  return parseInt(out.split(/\s+/)[0], 10) * 1024;
}

function fmtMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Copies from the real top-level source. Nested symlinks are normalized
 *  after the seed is assembled: fs.cpSync preserves them even with
 *  dereference=true, while zip follows them when making the archive. */
function copyReal(src, dest, options = {}) {
  const real = realpathSync(src);
  mkdirSync(dirname(dest), {recursive: true});
  cpSync(real, dest, {recursive: true, dereference: true, ...options});
}

/** Make the staged seed match the regular files in the archive. In
 *  particular, a locally built transpiler has nested node_modules/.bin
 *  symlinks that must be materialized before hashing or archiving. */
function materializeSeedLinks(seedRoot) {
  const visit = (dir, activeTargets = new Set()) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const entry = lstatSync(file);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(file);
        const targetIsDir = statSync(target).isDirectory();
        if (targetIsDir && activeTargets.has(target)) {
          throw new Error(`build-vsix: recursive seed symlink at ${file}`);
        }
        rmSync(file);
        cpSync(target, file, {recursive: true, dereference: true});
        if (targetIsDir) visit(file, new Set([...activeTargets, target]));
      } else if (entry.isDirectory()) {
        visit(file, activeTargets);
      }
    }
  };
  visit(seedRoot);
}

/** Copies every file of `srcDir` whose path relative to `srcDir` (leading
 *  `/`, forward slashes) matches one of `patterns` (abap_transpile.json's
 *  own glob shape) into the same relative path under `destDir`. */
function copyFiltered(srcDir, destDir, patterns) {
  const real = realpathSync(srcDir);
  // `statSync` (follows symlinks), not the dirent's own type: a lib folder
  // may hold a symlinked subtree (open-abap-apc's `src`, a sibling checkout
  // entirely outside this repo) that a dirent check alone reports as "not a
  // directory" and a plain walk then treats as a single opaque file.
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  let count = 0;
  for (const file of walk(real)) {
    const rel = `/${relative(real, file).replaceAll("\\", "/")}`;
    if (patterns.some((pat) => minimatch(rel, pat))) {
      const dest = join(destDir, relative(real, file));
      mkdirSync(dirname(dest), {recursive: true});
      cpSync(file, dest);
      count++;
    }
  }
  return count;
}

/** Everything of `srcDir` except the named top-level entries -- a library's
 *  own build litter (its `node_modules/`, `output/`, `test/`, `.git/`), not
 *  read by anything that transpiles against it as a lib. */
function copyExcludingTop(srcDir, destDir, exclude) {
  const real = realpathSync(srcDir);
  mkdirSync(destDir, {recursive: true});
  for (const entry of readdirSync(real, {withFileTypes: true})) {
    if (exclude.includes(entry.name)) continue;
    copyReal(join(real, entry.name), join(destDir, entry.name));
  }
}

// ---- node_modules: traced from package-lock.json, not guessed -----------

// js-yaml: tools/stg-compile.mjs, a generator every build runs, imports it;
// it is no direct dependency of the root package.json (it arrives with dev
// tooling), which is why a list of "what the server imports" missed it and
// the first install in a real globalStorage failed on it (2026-09-26)
//
// hdb (tools/hana-client.mjs) and @abaplint/database-pg (tools/postgres-client.mjs,
// which pulls in `pg`) are the VS Code extension's own "osd.database.system
// = hana / postgres" (docs/vscode-extension.md, "Databases"): both pure
// JavaScript, checked by hand -- `find node_modules/hdb node_modules/pg*
// -iname '*.node'` finds nothing, and hdb's only non-JS asset is
// lz4-wasm-nodejs's `.wasm` (portable, unlike a native `.node` addon).
// DuckDB (`@duckdb/node-api`) is native and stays OUT on purpose, same as
// before -- editors/vscode/launcher.js's `duckdbAvailable` answers a plain
// sentence instead of a build failure when a packaged install is asked
// for it.
const RUNTIME_ROOTS = [
  "@abaplint/core", "@abaplint/runtime", "@abaplint/transpiler", "@abaplint/database-sqlite",
  "@abaplint/database-pg", "hdb", "express", "js-yaml",
];

function runtimeModuleClosure() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const pkgs = lock.packages;
  const visited = new Set();
  const queue = [...RUNTIME_ROOTS];
  while (queue.length > 0) {
    const name = queue.shift();
    const key = `node_modules/${name}`;
    if (visited.has(key)) continue;
    const info = pkgs[key];
    if (info === undefined) {
      throw new Error(`build-vsix: ${key} is not in package-lock.json -- npm install first`);
    }
    visited.add(key);
    const deps = {...(info.dependencies ?? {}), ...(info.optionalDependencies ?? {})};
    for (const dep of Object.keys(deps)) queue.push(dep);
  }
  return [...visited].map((key) => key.slice("node_modules/".length)).sort();
}

// ---- library sources: the exact relative paths abap_transpile.json names --

/** `{name, folder, files}` for every lib entry of abap_transpile.json whose
 *  `folder` starts with `/.local/lars/` -- the only lib shape this repo
 *  actually has: a folder relative to the root, with an optional `files`
 *  glob list. */
/** Parts of a lib outside its `files` filter that a generator imports. */
const LIB_EXTRA = {"open-abap-gui": ["converter/src", "converter/package.json"]};

function libEntries() {
  const config = JSON.parse(readFileSync(join(ROOT, "abap_transpile.json"), "utf8"));
  return config.libs.map((lib) => ({
    name: basename(lib.folder),
    folder: lib.folder.replace(/^\//, ""), // "/.local/lars/x" -> ".local/lars/x"
    files: lib.files,
  }));
}

// ---- stage layout ---------------------------------------------------------

// ABAP under test/ that exists only for a suite that is not shipped: the
// two synthetic fleet reports exercise orchestration locally, and the
// in-memory ADT session double (test/adt-abap-csrf.mjs) stands in for the
// real ZIF_OSD_ADT_SESSION until it lands. None of them is a product object,
// and a double in an installed system would be one more session store.
export const TEST_ONLY_ABAP = [
  /^integration[/\\]zosd_(voyage|ready)\.prog\.(abap|xml)$/,
  /^unit[/\\]zcl_osd_adt_session_mem\.clas\.(abap|xml)$/,
  /^unit[/\\]zcl_osd_adt_(enq|store|coverage|front)_probe\.clas\.(abap|xml)$/,
  // wire replay and continuation fixtures (test/adt-abap-f2.mjs, f3)
  /^unit[/\\]zcl_osd_adt_route_f[23]\.clas\.(abap|xml|testclasses\.abap)$/,
  // the route that ends in an echo continuation (test/adt-abap-front.mjs)
  /^unit[/\\]zcl_osd_adt_route_echo\.clas\.(abap|xml)$/,
];

/** whether a path under test/ (relative to it) goes into a system seed: the
 *  VSIX's and the binary's, which both stage through copySeedTree */
export function shipsTestPath(rel) {
  const parts = String(rel).split(/[/\\]/);
  if (parts[0] === "e2e" || parts[0] === "fixtures") return false;
  return TEST_ONLY_ABAP.every((pattern) => pattern.test(rel) === false);
}

/** Drop test includes that name a class omitted by TEST_ONLY_ABAP. Match
 * whole words case-insensitively, including comments and strings: a mention
 * there conservatively drops the include too. Main class sources stay.
 * Names come from the rejected paths, never a second object-name list. */
export function excludeTestOnlyIncludes(seedRoot, excludedPaths) {
  const names = new Set(excludedPaths.flatMap((path) => {
    const match = basename(path).match(/^(.+)\.clas\./i);
    return match ? [match[1].toLowerCase()] : [];
  }));
  const visit = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.clas\.testclasses\.abap$/i.test(entry.name)) {
        const words = readFileSync(file, "utf8").toLowerCase().match(/\b[a-z_][a-z0-9_]*\b/g) ?? [];
        const references = [...new Set(words.filter((word) => names.has(word)))];
        if (references.length === 0) continue;
        rmSync(file);
        log(`drop ${relative(seedRoot, file)}: references excluded test-only class ${references.join(", ")}`);
      }
    }
  };
  visit(seedRoot);
}

// Repository inputs copied verbatim; CI imports these same lists. Packs and
// test/ are copied separately with selection/exclusion rules below.
export const SEED_DIRS = ["src", "webapp", "tools", "data"];
export const SEED_FILES = ["abap_transpile.json", "abaplint.jsonc", "libs.lock.json", "package.json"];

export function copySeedTree(seedRoot, selectedPacks) {
  mkdirSync(seedRoot, {recursive: true});

  // No output/ and no gen/ from the checkout: the checkout's generation
  // was built with every checkout pack present and can carry generated
  // ABAP/BSP files from packs excluded here. stageSystemSeed() builds the
  // seed's own generation and gen/ from the staged, selected inputs instead
  // (T2, prebuildGeneration).

  for (const dir of SEED_DIRS) {
    copyReal(join(ROOT, dir), join(seedRoot, dir));
  }
  mkdirSync(join(seedRoot, "packs"), {recursive: true});
  for (const pack of selectedPacks) {
    copyReal(pack.dir, join(seedRoot, "packs", pack.name));
  }
  for (const file of SEED_FILES) {
    cpSync(join(ROOT, file), join(seedRoot, file));
  }

  // Not just run.mjs/start.mjs/setup.mjs's own JS imports: `abaplint.jsonc`'s
  // own `global.files` glob ("/{src,...,test,...}/**/*.*") makes the WHOLE
  // `test/` folder (minus `test/e2e/` and `test/fixtures/`, its own exclude
  // list, matching abap_transpile.json's) an input to the abaplint registry
  // `tools/osd-store.mjs` builds at startup (`test/start.mjs`'s own
  // `store.registry()` call) for the ADT façade's xref/readers routes --
  // found the hard way, by running the packaged copy and reading the ENOENT
  // (a missing `abaplint.jsonc` first) and then the registry's own silent
  // narrower read (a `test/unit/*.clas.testclasses.abap` never in the tree)
  // rather than by re-deriving it from a static import graph, which a
  // non-JS file can never appear in.
  const excludedPaths = [];
  cpSync(join(ROOT, "test"), join(seedRoot, "test"), {
    recursive: true,
    filter: (src) => {
      const rel = relative(join(ROOT, "test"), src);
      if (TEST_ONLY_ABAP.some((pattern) => pattern.test(rel))) excludedPaths.push(rel);
      return shipsTestPath(rel);
    },
  });
  excludeTestOnlyIncludes(seedRoot, excludedPaths);

  for (const lib of libEntries()) {
    const srcDir = libraryPath(ROOT, lib.name);
    if (existsSync(srcDir) === false) {
      throw new Error(`build-vsix: lib ${lib.name} (${lib.folder}) is not cloned -- see .local/lars/`);
    }
    const destDir = join(seedRoot, lib.folder);
    if (lib.files !== undefined) {
      const n = copyFiltered(srcDir, destDir, lib.files);
      log(`lib ${lib.name}: ${n} files (files: filter)`);
      // a lib's `files` filter names the ABAP the transpiler reads, not the
      // JavaScript a generator imports: tools/osd-gui-convert.mjs loads
      // open-abap-gui's converter from converter/src at build time, so the
      // seed carries it too, or the first build of an install fails on it
      const extra = LIB_EXTRA[lib.name] ?? [];
      for (const rel of extra) {
        copyReal(join(srcDir, rel), join(destDir, rel));
        log(`lib ${lib.name}: + ${rel} (read by a generator)`);
      }
    } else {
      copyExcludingTop(srcDir, destDir, ["node_modules", "output", "test", ".git"]);
      log(`lib ${lib.name}: whole folder minus its own node_modules/output/test`);
    }
  }

  const modules = runtimeModuleClosure();
  for (const name of modules) {
    const source = join(ROOT, "node_modules", name);
    const dest = join(seedRoot, "node_modules", name);
    if (name === "@abaplint/transpiler" || name === "@abaplint/runtime") {
      // A linked fork package has its build-time node_modules, TypeScript
      // sources, and tests beside the compiled distribution. Runtime deps
      // are already supplied by the lockfile closure at the seed root.
      mkdirSync(dest, {recursive: true});
      for (const file of ["package.json", "LICENSE", "README.md"]) {
        if (existsSync(join(source, file))) copyReal(join(source, file), join(dest, file));
      }
      copyReal(join(source, "build"), join(dest, "build"));
    } else {
      copyReal(source, dest);
    }
  }
  for (const name of ["@abaplint/core", "@nodable/entities"]) {
    stageDependencyLicense(join(seedRoot, "node_modules", name), name);
  }
  log(`node_modules: ${modules.length} packages traced from package-lock.json`);

  // These are dependency distribution maps. The ABAP debugger's maps are
  // generated in output/ on first start, which is not part of this seed.
  const dropMaps = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) dropMaps(file);
      else if (entry.name.endsWith(".map")) rmSync(file);
    }
  };
  dropMaps(join(seedRoot, "node_modules"));

  return modules;
}

/** Apply the pack's current fetch exclusions to the staged copy. A local
 * fetched folder may predate an exclusion added to osd-pack.json; packaging
 * must not ship those old files. Call this only after materializeSeedLinks,
 * so removal cannot follow a staged symlink back into the fetched source. */
export function excludeStagedPackSources(seedRoot, selectedPacks) {
  const within = (parent, child) => {
    const path = relative(parent, child);
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const packsDir = realpathSync(join(seedRoot, "packs"));
  // Validate every target before removing anything from the staged tree.
  const plans = selectedPacks.flatMap((pack) => pack.sources.map((source) => {
    const packDir = realpathSync(join(packsDir, pack.name));
    const folder = realpathSync(join(packDir, source.folder));
    if (!within(packsDir, packDir) || !within(packDir, folder)) {
      throw new Error(`build-vsix: pack source escapes its staged pack: ${pack.name}/${source.folder}`);
    }
    return {folder, patterns: source.exclude.map((pattern) => new RegExp(pattern, "i"))};
  }));
  for (const {folder, patterns} of plans) {
      const visit = (dir, relativeDir = "") => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
          const kind = lstatSync(path);
          if (kind.isSymbolicLink()) {
            throw new Error(`build-vsix: staged source still has a symlink: ${relativePath}`);
          }
          if (patterns.some((pattern) => pattern.test(relativePath))) {
            rmSync(path, {recursive: true, force: true});
          } else if (kind.isDirectory()) {
            visit(path, relativePath);
          }
        }
      };
      visit(folder);
  }
}

/** T2 (docs/ideas.md): build the seed's own generation at packaging time, so
 *  a first start finds it and reuses it instead of transpiling cold.
 *
 *  The generation's name is portable once it is built INSIDE the staged
 *  seed: the hash reads paths relative to the tree, generator-relative
 *  filenames and package names, versions and built-file contents, which is
 *  what a materialized copy on the user's machine computes too. Measured 2026-09-27: cold first build 22.3 s; the same
 *  generation copied into a second materialized copy under another path,
 *  "reused" in 5.4 s with gen/ regenerated, 0.1 s with gen/ shipped too.
 *
 *  What ships is `build/by-input/<hash>/`, `gen/` and that generation's
 *  cross-reference rows (`build/xref/<key>.json`, tools/osd-xref-seed.mjs),
 *  as real files. The
 *  links the build makes (`build/live`, `output`, the generation's `test`)
 *  are dropped and made again by the first build; a seed that carries no
 *  symlink cannot fail to unpack where links need rights. `build/tmp/` is
 *  scratch. The build runs without OSD_PACKS. A first start always has the
 *  launcher's empty notebook-scratch pack, which names nothing since a pack
 *  that brings nothing is not an input (tools/osd-build.mjs inputsOf); a
 *  workspace pack with content is another input and builds cold, as before. */
function prebuildGeneration(seedRoot, env) {
  // a seed is published: $TMP is left out (tools/osd-tmp.mjs)
  const buildEnv = forPublishing({...env});
  delete buildEnv.OSD_PACKS;
  delete buildEnv.OSD_WARM;
  try {
    execFileSync(process.execPath, ["tools/osd-build.mjs"], {cwd: seedRoot, env: buildEnv, stdio: ["ignore", "pipe", "pipe"]});
  } catch (error) {
    // osd-build reports its failure on stdout and child diagnostics on stderr.
    throw new Error(`build-vsix: prebuilt generation failed: ${error.message}\n${error.stdout?.toString() ?? ""}\n${error.stderr?.toString() ?? ""}`, {cause: error});
  }
  const live = realpathSync(join(seedRoot, "build", "live"));
  const local = generationTmpProblem(live);
  if (local !== undefined) throw new Error(local);
  const hash = basename(live);
  // the generation's manifest records when and how long: the same tree
  // packaged twice must make the same seed ID (the materialized copy is
  // keyed by it), so both are fixed. builtAt only orders generations for
  // pruning, and the shipped one is the oldest a copy will ever hold.
  const manifestFile = join(live, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  writeFileSync(manifestFile, JSON.stringify({...manifest, builtAt: "1970-01-01T00:00:00.000Z", ms: 0}, undefined, 2) + "\n");
  // the cross-reference rows of this generation (tools/osd-xref-seed.mjs,
  // build/xref/<key>.json): a first start seeds CROSS & co. from them
  // instead of parsing the tree. Written by the seed's own module over the
  // seed's own tree, gen/ as the copy's reused build leaves it, so the key
  // is the one a materialized copy computes. rows() never throws when it
  // cannot key or write the cache, so the file is checked here: a package
  // without it would start ~5 s slower and nothing else would say so
  const xrefKey = execFileSync(process.execPath, ["--input-type=module", "-e",
    'const m = await import("./tools/osd-xref-seed.mjs"); await m.rows(process.cwd()); process.stdout.write(String(await m.cacheKey(process.cwd())));'],
  {cwd: seedRoot, env: buildEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]}).trim().split("\n").at(-1);
  const xrefFiles = existsSync(join(seedRoot, "build", "xref"))
    ? readdirSync(join(seedRoot, "build", "xref")).filter((name) => name.endsWith(".json")) : [];
  if (xrefFiles.length !== 1 || xrefFiles[0] !== `${xrefKey}.json`) {
    throw new Error(xrefKey === "undefined"
      ? "build-vsix: cacheKey() gave no key for the seed (tools/osd-xref-seed.mjs), so the cross-reference cache cannot ship"
      : `build-vsix: the cross-reference cache was not written for key ${xrefKey} (found: ${xrefFiles.join(", ") || "none"})`);
  }
  for (const name of readdirSync(join(seedRoot, "build"))) {
    if (name !== "by-input" && name !== "xref") rmSync(join(seedRoot, "build", name), {recursive: true, force: true});
  }
  for (const name of readdirSync(join(seedRoot, "build", "by-input"))) {
    if (name !== hash) rmSync(join(seedRoot, "build", "by-input", name), {recursive: true, force: true});
  }
  rmSync(join(seedRoot, "output"), {force: true});
  const dropLinks = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) rmSync(file);
      else if (entry.isDirectory()) dropLinks(file);
    }
  };
  dropLinks(join(seedRoot, "build"));
  dropLinks(join(seedRoot, "gen"));
  return hash;
}

/** Shared staging for the VSIX and the standalone binary. The binary names
 *  its generations by its own bytes (tools/osd-build.mjs generatorIdentity),
 *  so a prebuilt generation could never be reused there: `prebuild` is the
 *  VSIX's alone. */
export async function stageSystemSeed(seedRoot, env = process.env, {prebuild = false, version = packagedVersion(ROOT)} = {}) {
  requireSupportedNode(process.versions.node, "system seed: ");
  const transpilerRef = pinnedTranspilerRef();
  const preflight = describeVsixPreflight(vsixPreflightMissing(ROOT));
  if (preflight !== undefined) throw new Error(preflight);
  await loadSeedDependencies();
  const {describeUnfetched} = await import("../tools/osd-fetch.mjs");
  const selectedPacks = vsixPacks(env);
  const missing = selectedPacks.flatMap((pack) => pack.missing.map((source) => ({
    pack: pack.name, folder: source.folder, repo: source.repo, ref: source.ref, oci: source.oci,
  })));
  if (missing.length > 0) throw new Error(describeUnfetched(missing));
  rmSync(seedRoot, {recursive: true, force: true});
  const modules = copySeedTree(seedRoot, selectedPacks);
  const {seedId, generation} = finalizeSystemSeed(seedRoot, selectedPacks, {prebuild, version, transpilerRef, env});
  return {seedId, modules, selectedPacks, generation};
}

/** Finalize the actual seed tree for both packagers, after dependency preflight
 * and copying. Kept separate so marker stamping and extraction can be tested
 * without installing the pinned transpiler fork. */
export function finalizeSystemSeed(seedRoot, selectedPacks, {
  prebuild = false, version = packagedVersion(ROOT), transpilerRef, env = process.env,
} = {}) {
  writeVersionMarker(seedRoot, version);
  writeFileSync(join(seedRoot, ".osd-transpiler-ref"), `${transpilerRef}\n`);
  materializeSeedLinks(seedRoot);
  excludeStagedPackSources(seedRoot, selectedPacks);
  const generation = prebuild ? prebuildGeneration(seedRoot, env) : undefined;
  const seedId = writeSeedId(seedRoot);
  return {seedId, generation};
}

// These npm distributions omit their repository licences.
// Upstream text: https://github.com/abaplint/abaplint/blob/main/LICENSE
// Entities: https://github.com/nodable/val-parsers/blob/main/LICENSE
// Keep the grants in the seed (for notices) and in the standalone scanner.
function stageDependencyLicense(dir, name) {
  if (readdirSync(dir).some((file) => /^licen[cs]e(?:\..*)?$/i.test(file))) return;
  const fallback = {"@abaplint/core": "abaplint-core", "@nodable/entities": "nodable-entities"}[name];
  if (!fallback) throw new Error(`build-vsix: missing licence text for ${name}`);
  copyReal(join(ROOT, `scripts/licenses/${fallback}.LICENSE.txt`), join(dir, "LICENSE.txt"));
}

/** Ship the unchanged scanner independently of the compressed system seed.
 * Only Rearranger and its core dependency closure are needed, not the compiler.
 * Read from the staged seed so the core is the same copy used by the transpiler. */
export function stageKernelScanner(seedRoot, extensionDir) {
  const runtime = join(extensionDir, "kernel-runtime");
  copyReal(join(seedRoot, "tools", "osd-kernel-compat.mjs"), join(runtime, "tools", "osd-kernel-compat.mjs"));
  const transpiler = "node_modules/@abaplint/transpiler";
  for (const file of ["package.json", "LICENSE", "build/src/rearranger.js"]) {
    if (existsSync(join(seedRoot, transpiler, file))) copyReal(join(seedRoot, transpiler, file), join(runtime, transpiler, file === "LICENSE" ? "LICENSE.txt" : file));
  }
  const copied = new Set();
  const copyDependency = (name) => {
    if (copied.has(name)) return;
    copied.add(name);
    const source = join(seedRoot, "node_modules", name);
    copyReal(source, join(runtime, "node_modules", name));
    stageDependencyLicense(join(runtime, "node_modules", name), name);
    const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) copyDependency(dependency);
  };
  copyDependency("@abaplint/core");
  // Every plain VSIX entry needs an extension for OPC content typing. These
  // dependency licences were safe inside the tar; here they are .txt assets.
  const typeLicenses = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) typeLicenses(file);
      else if (entry.name === "LICENSE") {
        cpSync(file, `${file}.txt`);
        rmSync(file);
      }
    }
  };
  typeLicenses(runtime);
}

// ---- the extension itself -------------------------------------------------

function copyExtensionFiles(extensionDir, profile) {
  mkdirSync(extensionDir, {recursive: true});
  for (const entry of readdirSync(EXT_DIR, {withFileTypes: true})) {
    if (entry.name === "osd") continue; // never present here; guards a stray dev copy
    if (profile === "marketplace" && entry.name === "dist") continue; // no web bundle before S2
    copyReal(join(EXT_DIR, entry.name), join(extensionDir, entry.name));
  }
  // LICENSE.txt, as vsce names it: an OPC package gives every part a
  // content type by its extension, and the Marketplace refuses a declared
  // asset it cannot type ("declared ... but was not found in the package").
  cpSync(join(ROOT, "LICENSE"), join(extensionDir, "LICENSE.txt"));
  if (existsSync(join(EXT_DIR, "README.md"))) {
    // already copied above by the directory loop
  }
}

// ---- the two vsix manifests, generated from package.json like vsce does --

const CONTENT_TYPES = {
  json: "application/json", js: "application/javascript", mjs: "application/javascript",
  cjs: "application/javascript", md: "text/markdown", txt: "text/plain", xml: "text/xml",
  svg: "image/svg+xml", png: "image/png", vsixmanifest: "text/xml",
};

/** Every file in an OPC package needs a content type, looked up by its
 *  extension, or the Marketplace cannot see it. The list is derived from
 *  what was staged: a known type where there is one, otherwise
 *  application/octet-stream (.br, .osdnb, .seed-id and whatever a later
 *  change adds). */
export function contentTypesXml(extensions = []) {
  const all = [...new Set([...Object.keys(CONTENT_TYPES), ...extensions])].sort();
  const lines = all.map((ext) => `<Default Extension="${ext}" ContentType="${CONTENT_TYPES[ext] ?? "application/octet-stream"}"/>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${lines.join("\n")}
</Types>
`;
}

/** The extensions of every file under dir; a file without one is an error,
 *  since no Default entry can type it. */
export function stagedExtensions(dir) {
  const found = new Set();
  const walk = (at) => {
    for (const entry of readdirSync(at, {withFileTypes: true})) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0 || dot === entry.name.length - 1) {
        throw new Error(`build-vsix: ${relative(dir, path)} has no file extension, so the Marketplace cannot type it`);
      }
      found.add(entry.name.slice(dot + 1).toLowerCase());
    }
  };
  walk(dir);
  return [...found];
}

function vsixManifestXml(pkg, prerelease = false) {
  const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const publisher = pkg.publisher ?? "oisee";
  const displayName = escapeXml(pkg.displayName ?? pkg.name);
  const description = escapeXml(pkg.description ?? "");
  const vscodeEngine = escapeXml(pkg.engines?.vscode ?? "*");
  const categories = escapeXml((pkg.categories ?? []).join(","));
  const tags = escapeXml((pkg.keywords ?? []).join(","));
  const extensionKind = escapeXml((pkg.extensionKind ?? ["workspace"]).join(","));
  const source = escapeXml(typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "");
  const support = escapeXml(typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url ?? "");
  const homepage = escapeXml(pkg.homepage ?? "");
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(publisher)}" />
    <DisplayName>${displayName}</DisplayName>
    <Description xml:space="preserve">${description}</Description>
    <Tags>${tags}</Tags>
    <Categories>${categories}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${escapeXml(pkg.icon)}</Icon>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${vscodeEngine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${extensionKind}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${source}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${support}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${homepage}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${escapeXml(pkg.galleryBanner?.color ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${escapeXml(pkg.galleryBanner?.theme ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
${prerelease ? '      <Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />' : ""}
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${escapeXml(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

// ---- entry point ------------------------------------------------------------

export async function buildVsix(env = process.env, outputDir = BUILD_DIR) {
  const profile = env.OSD_VSIX_PROFILE ?? "default";
  const qualityText = env.OSD_VSIX_BROTLI_QUALITY;
  const quality = qualityText === undefined ? 5 : Number(qualityText);
  if ((qualityText !== undefined && !/^(?:[0-9]|10|11)$/.test(String(qualityText))) ||
      !Number.isInteger(quality) || quality < 0 || quality > 11) {
    throw new Error("build-vsix: OSD_VSIX_BROTLI_QUALITY must be an integer from 0 to 11");
  }
  const buildDir = resolve(outputDir);
  const stage = join(buildDir, "stage");
  rmSync(stage, {recursive: true, force: true});
  mkdirSync(stage, {recursive: true});

  const extensionDir = join(stage, "extension");
  copyExtensionFiles(extensionDir, profile);
  const {pkg, dirty} = stampStagedPackage(join(extensionDir, "package.json"));
  if (profile === "marketplace") {
    delete pkg.browser;
    writeFileSync(join(extensionDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const seedRoot = join(buildDir, "seed-stage");
  rmSync(seedRoot, {recursive: true, force: true});
  // **An unfetched pack refuses the package, not the user's first start.**
  // A selected pack whose sources were never fetched would make every
  // install's first build refuse with UNFETCHED. Other packs do not ship.
  // OSD_VSIX_PREBUILT=0 packages without a prebuilt generation (the first
  // start then transpiles cold); the tests that only look at the archive's
  // shape use it, since the build costs ~20 s per package.
  const {seedId, modules, selectedPacks, generation} = await stageSystemSeed(seedRoot, env,
    {prebuild: env.OSD_VSIX_PREBUILT !== "0", version: pkg.version});
  stageKernelScanner(seedRoot, extensionDir);
  log(generation === undefined ? "generation: none prebuilt, a first start builds cold"
    : `generation: ${generation} prebuilt, a first start reuses it`);
  const notices = writeThirdPartyNotices(seedRoot, join(extensionDir, "THIRD-PARTY-NOTICES.md"), ROOT);
  for (const issue of notices.issues) log(`LICENSE REVIEW: ${issue}`);
  log(`third-party notices: ${notices.entries.length} components, ${notices.issues.length} item(s) for review`);
  log(`packs: ${selectedPacks.map((pack) => pack.name).join(", ")}`);
  const archiveDir = join(extensionDir, "osd");
  mkdirSync(archiveDir, {recursive: true});
  const tarFile = join(buildDir, "seed.tar");
  writeTar(seedRoot, tarFile);
  const tarSize = statSync(tarFile).size;
  await pipeline(createReadStream(tarFile), createBrotliCompress({params: {
    [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: tarSize,
  }}), createWriteStream(join(archiveDir, "seed.tar.br")));
  rmSync(tarFile);
  writeFileSync(join(archiveDir, ".seed-id"), `${seedId}\n`);
  log(`seed ID: ${seedId}`);
  if (dirty) {
    log(`dirty tree: version ${pkg.version} + seed ${seedId}`);
  }

  writeFileSync(join(stage, "[Content_Types].xml"), contentTypesXml(stagedExtensions(join(stage, "extension"))));
  writeFileSync(join(stage, "extension.vsixmanifest"), vsixManifestXml(pkg, env.OSD_VSIX_PRERELEASE === "1"));

  const out = join(buildDir, `${pkg.name}-${pkg.version}.vsix`);
  rmSync(out, {force: true});
  execFileSync("zip", ["-X", "-q", "-r", out, "[Content_Types].xml", "extension.vsixmanifest", "extension"], {cwd: stage});

  const breakdown = {
    // no output/ entry: not shipped (fallback (b), see the top-of-file
    // comment) -- a first start transpiles cold instead of hitting a cache.
    "node_modules/": dirSizeBytes(join(seedRoot, "node_modules")),
    "packs/": dirSizeBytes(join(seedRoot, "packs")),
    "src/ + webapp/ + tools/ + test/ + data/": ["src", "webapp", "tools", "test", "data"]
      .reduce((sum, d) => sum + dirSizeBytes(join(seedRoot, d)), 0),
    ".local/lars/ (library sources)": dirSizeBytes(join(seedRoot, ".local")),
    "build/ + gen/ (prebuilt generation)": ["build", "gen"].reduce((sum, d) => sum + dirSizeBytes(join(seedRoot, d)), 0),
    "extension.js/lib.js/launcher.js/resources/examples": dirSizeBytes(extensionDir) - dirSizeBytes(archiveDir),
  };
  const unpackedTotal = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const vsixSize = statSync(out).size;

  log(`.vsix: ${out} (${fmtMB(vsixSize)})`);
  log(`unpacked: ${fmtMB(unpackedTotal)}`);
  for (const [label, bytes] of Object.entries(breakdown)) {
    log(`  ${label}: ${fmtMB(bytes)}`);
  }
  if (unpackedTotal > 150 * 1024 * 1024) {
    log("WARNING: unpacked size is over ~150 MB -- see docs/vscode-extension.md, Packaging, for the trims proposed.");
  }

  return {out, vsixSize, unpackedTotal, breakdown, modules, pkg, notices};
}

if (basename(process.argv[1] ?? "") === "build-vsix.mjs") {
  buildVsix().then(
    () => process.exit(0),
    (error) => {
      const message = String(error?.message ?? error).split(/\r?\n/)[0];
      console.error(message.startsWith("build-vsix:") ? message : `build-vsix: ${message}`);
      process.exit(1);
    },
  );
}
