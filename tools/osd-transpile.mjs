// The transpile as a library call: what abap_transpile does, done in this
// process (backlog N3).
//
// The CLI is a thin wrapper around @abaplint/transpiler — it globs the input
// folders, reads the libraries, fills a registry, runs the transpiler and
// writes the chunks — and it ends in process.exit(), which is why the
// builder used to spawn it. Spawning costs a process and a parse of the
// output for the object count, needs node_modules/.bin on the path, and is
// impossible from a compiled binary, where process.execPath is the binary
// itself. So the wrapper is here, line for line where it matters: the same
// file names, the same relative paths in the source maps, the same
// bootstrap line on a program, the same five scripts beside the objects.
// The proof is a byte comparison of a generation built both ways.
//
// One thing the CLI gets for free that this must do on purpose: the
// transpiler and the registry it is handed must come from ONE copy of
// @abaplint/core, because the transpiler checks its input with instanceof.
// So core is resolved from where the transpiler package is, not from here.
import {createHash} from "node:crypto";
import {buildIdentity, assertToolchain} from "./osd-transpiler.mjs";
import {phase} from "./osgjs-trace.mjs";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import {hostModules} from "./osd-host.mjs";
import {mapStatementStarts} from "./osd-source-map-starts.mjs";
import {lowerNarrowSubmit} from "./osd-narrow-submit.mjs";
import {installRfcMessage} from "./osd-rfc-message.mjs";
import {libraryPath} from "./osd-lib-path.mjs";
import {orderRegistry} from "./osd-warm-order.mjs";

// the transpiler package in use by this tree, and the core it was built
// against. A tree with the library installed resolves it directly; a tree
// with only the CLI (a linked local build of the monorepo, as here) reaches
// the library the way the CLI itself does, through the CLI's own location.
export function transpilerLocation(root) {
  const fromRoot = createRequire(join(root, "package.json"));
  let main;
  try {
    main = fromRoot.resolve("@abaplint/transpiler");
  } catch {
    const cli = fromRoot.resolve("@abaplint/transpiler-cli/package.json");
    main = createRequire(cli).resolve("@abaplint/transpiler");
  }
  return packageRootOf(main);
}

const LOADED_IDENTITIES = new WeakMap();
export function modulesOf(root) {
  const fromRoot = createRequire(join(root, "package.json"));
  const where = transpilerLocation(root);
  // Capture before require executes the package, once per loaded class.
  const identity = buildIdentity(root);
  const fromTranspiler = createRequire(join(where, "package.json"));
  const {Transpiler, Chunk} = fromTranspiler(where);
  const validationFile = join(where, "build/src/validation.js");
  const validationConfig = existsSync(validationFile) ? fromTranspiler(validationFile).config : undefined;
  if (!LOADED_IDENTITIES.has(Transpiler)) LOADED_IDENTITIES.set(Transpiler, identity);
  const core = fromTranspiler("@abaplint/core");
  const {CallFunctionTranspiler} = fromTranspiler(join(where, 'build/src/statements/call_function.js'));
  let plugin;
  try {
    // the CLI's optional plugin, resolved from the project as it does it
    plugin = fromRoot("@abaplint/transpiler-extras").plugin;
  } catch {
    plugin = undefined;
  }
  return prepareModules({Transpiler, Chunk, core, CallFunctionTranspiler, validationConfig, plugin, where, identityRoot: root, identity: LOADED_IDENTITIES.get(Transpiler), version: JSON.parse(readFileSync(join(where, "package.json"), "utf8")).version});
}

// Install on the selected copy, including bundled hosts and explicit modules.
const VALIDATION_NORMALIZED = new WeakSet();
function prepareModules(modules) {
  if (modules.validationConfig && !VALIDATION_NORMALIZED.has(modules.Transpiler)) {
    const validate = modules.Transpiler.prototype.validate;
    modules.Transpiler.prototype.validate = function (reg) {
      // The pinned validator sets this for runtimeError but never resets it.
      // Every registry must use this instance's policy, not the previous one's.
      modules.validationConfig.syntax.errorNamespace = this.options?.unknownTypes === "runtimeError" ? "VOID_EVERYTHING" : ".";
      return validate.call(this, reg);
    };
    VALIDATION_NORMALIZED.add(modules.Transpiler);
  }
  installRfcMessage(modules.CallFunctionTranspiler, modules.Chunk, modules.core);
  return modules;
}
export function selectedModules(root, explicit) {
  const modules = explicit ?? hostModules() ?? modulesOf(root);
  // Callers supplying already loaded code must supply its load-time identity,
  // or use a class captured by modulesOf. Never infer it from disk now.
  if (modules.identity === undefined) {
    const identity = LOADED_IDENTITIES.get(modules.Transpiler);
    if (identity === undefined) throw new Error("transpiler modules need an identity captured when they were loaded");
    return prepareModules({...modules, identity});
  }
  return prepareModules(modules);
}

function packageRootOf(file) {
  let dir = dirname(file);
  while (existsSync(join(dir, "package.json")) === false) {
    const up = dirname(dir);
    if (up === dir) {
      throw new Error(`no package.json above ${file}`);
    }
    dir = up;
  }
  return dir;
}

// the CLI's binary rule: read and written as latin1, so the bytes survive
export function isBinaryFilename(filename) {
  return /\.(w3mi|smim)\.data\./i.test(filename);
}

// every file under a folder, absolute, forward slashes, sorted: the order
// the registry sees is then a property of the tree and not of the disk
export function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === ".git") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else {
      out.push(p.split(sep).join("/"));
    }
  }
  return out;
}

// the glob the config speaks, "/src/**", "/src/git/zcl_abapgit_git_pack.*",
// "/deps/progname.dtel.xml": ** is any depth, * stays inside a segment
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matching(dir, patterns) {
  const base = dir.split(sep).join("/");
  const rules = patterns.map((p) => globToRegExp(base + p));
  return walk(dir).filter((f) => rules.some((r) => r.test(f)));
}

const regexps = (list) => (list ?? []).map((p) => new RegExp(p, "i"));

export async function readAll(files, relativeTo, transform = (source) => source, onRead = undefined, retainBytes = false) {
  return files.map((filename) => {
    // read as bytes once: what a caller is told was read is what was used
    const bytes = readFileSync(filename);
    onRead?.(filename, bytes);
    return {
      filename: basename(filename),
      path: filename,
      sourceDigest: createHash("sha256").update(bytes).digest("hex"),
      ...(retainBytes ? {sourceBytes: bytes} : {}),
      relative: relative(relativeTo, dirname(filename)),
      contents: transform(bytes.toString(isBinaryFilename(filename) ? "latin1" : "utf8"), basename(filename)),
    };
  });
}

// the input folders, filtered the way the CLI filters them: the regular
// expressions of input_filter and exclude_filter over the absolute path
export async function loadFiles(root, config, core, onRead = undefined) {
  const {wanted, skipped} = listFiles(root, config);
  return {files: await readAll(wanted, resolve(root, config.output_folder),
    (source, filename) => lowerNarrowSubmit(source, filename, core), onRead), skipped};
}

// the same list, unread: a caller that keeps the files it read (a warm
// compile, tools/osd-warm.mjs) reads only the ones whose stat changed
export function listFiles(root, config) {
  const include = regexps(config.input_filter);
  const exclude = regexps(config.exclude_filter);
  const folders = Array.isArray(config.input_folder) ? config.input_folder : [config.input_folder];
  const wanted = [];
  let skipped = 0;
  for (const folder of folders) {
    for (const filename of walk(resolve(root, folder))) {
      if (include.length > 0 && include.some((r) => r.test(filename)) === false) {
        skipped++;
      } else if (exclude.length > 0 && exclude.some((r) => r.test(filename))) {
        skipped++;
      } else {
        wanted.push(filename);
      }
    }
  }
  return {wanted, skipped};
}

// the libraries: a folder beside the tree when there is one, a shallow
// clone into a temporary folder when there is only a URL, gone after
export async function loadLibs(root, config, log = () => {}, onRead = undefined) {
  const files = [];
  for (const lib of config.libs ?? []) {
    let dir;
    let cleanup = false;
    if (existsSync(join(root, "libs.lock.json"))) {
      dir = libraryPath(root, basename(lib.folder));
      log(`lib from locked folder: ${lib.folder}`);
    } else
    if (lib.folder !== undefined && lib.folder !== "" && existsSync(root + lib.folder)) {
      dir = root + lib.folder;
      log(`lib from folder: ${lib.folder}`);
    } else if (lib.url !== undefined && lib.url !== "") {
      dir = mkdtempSync(join(tmpdir(), "osd-lib-"));
      log(`lib clone: ${lib.url}`);
      execFileSync("git", ["clone", "--quiet", "--depth", "1", "--", lib.url, "."], {cwd: dir, stdio: "pipe"});
      cleanup = true;
    } else {
      throw new Error(`a lib needs a folder or a url: ${JSON.stringify(lib)}`);
    }
    const patterns = typeof lib.files === "string" && lib.files !== "" ? [lib.files]
      : Array.isArray(lib.files) ? lib.files : ["/src/**"];
    const exclude = regexps(lib.exclude_filter);
    // the CLI's one rule of its own: a library's test classes are not read
    // at all, so a dependency is never tested and never gets a test module
    const found = matching(dir, patterns)
      .filter((f) => f.endsWith(".clas.testclasses.abap") === false)
      .filter((f) => exclude.length === 0 || exclude.some((r) => r.test(f)) === false);
    files.push(...await readAll(found, root, undefined, onRead, cleanup));
    log(`\t${found.length} files added from lib`);
    if (cleanup) {
      rmSync(dir, {recursive: true, force: true});
    }
  }
  return files;
}

// what the CLI writes beside the objects, byte for byte
export function outputFiles(output, config, outputFolder, files) {
  const writeSourceMaps = config.write_source_map || false;
  const out = [];
  for (const o of output.objects) {
    const type = o.object.type.toUpperCase();
    let contents = o.chunk.getCode();
    // PROG output gets a runtime bootstrap line prepended, which shifts every
    // generated line down by one; the source map accounts for the offset
    let generatedLineOffset = 0;
    if (type === "PROG") {
      contents = `if (!globalThis.abap) await import("./_init.mjs");\n` + contents;
      generatedLineOffset = 1;
    }
    if (writeSourceMaps === true && (type === "PROG" || type === "FUGR" || type === "CLAS")) {
      const name = o.filename + ".map";
      contents = contents + `\n//# sourceMappingURL=` + name.replace(/%/g, "%25").replace(/#/g, "%23");
      const sourcePaths = {};
      for (const f of files) {
        if (f.relative === undefined) {
          continue;
        }
        const rel = f.relative.split(sep).join("/");
        sourcePaths[f.filename] = rel === "" ? f.filename : `${rel}/${f.filename}`;
      }
      out.push({path: join(outputFolder, name), contents: o.chunk.getMap(o.filename, {generatedLineOffset, sourcePaths})});
    }
    out.push({path: join(outputFolder, o.filename), contents});
  }
  if (config.write_unit_tests === true) {
    out.push({path: join(outputFolder, "index.mjs"), contents: output.unitTestScript});
    out.push({path: join(outputFolder, "_unit_open.mjs"), contents: output.unitTestScriptOpen});
  }
  out.push({path: join(outputFolder, "init.mjs"), contents: output.initializationScript});
  out.push({path: join(outputFolder, "_init.mjs"), contents: output.initializationScript2});
  out.push({path: join(outputFolder, "_top.mjs"), contents: `import runtime from "@abaplint/runtime";\nglobalThis.abap = new runtime.ABAP();`});
  return out;
}

const QUIET = {set() {}, async tick() {}};

// the whole of it: files in, objects on disk, a count back
export async function transpile(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const config = options.config;
  const log = options.log ?? (() => {});
  const started = Date.now();
  // a binary registered its bundled transpiler and core; a checkout resolves them
  const loaded = selectedModules(root, options.modules);
  assertToolchain(loaded.identityRoot ?? root, loaded);
  const {Transpiler, Chunk, core, plugin, version} = loaded;
  if (config.write_source_map === true) mapStatementStarts(Chunk);
  const {files, skipped} = await loadFiles(root, config, core, options.onRead);
  log(`${files.length} files added from source, ${skipped} skipped`);
  const libs = await loadLibs(root, config, log, options.onRead);
  options.onInputs?.(files, libs);
  const settings = {...config.options};
  if (config.write_source_map !== true) {
    settings.ignoreSourceMap = true;
  }
  const t = new Transpiler(settings, plugin);
  const reg = new core.Registry();
  for (const f of files) {
    reg.addFile(new core.MemoryFile(f.filename, f.contents));
  }
  for (const l of libs) {
    reg.addDependency(new core.MemoryFile(l.filename, l.contents));
  }
  orderRegistry(reg, core, files, libs);
  const output = await phase("transpile", () => t.run(reg, options.progress ?? QUIET));
  const outputFolder = resolve(root, config.output_folder);
  mkdirSync(outputFolder, {recursive: true});
  let written;
  await phase("write-modules", async () => {
    written = outputFiles(output, config, outputFolder, files);
    for (const file of written) {
      writeFileSync(file.path, file.contents, isBinaryFilename(file.path) ? {encoding: "latin1"} : undefined);
    }
    log(`${output.objects.length} objects written to disk`);
  });
  return {objects: output.objects.length, files: files.length, libs: libs.length, written: written.length, version, ms: Date.now() - started};
}
