#!/usr/bin/env node
// osd run [--lib <folder>]... <report.prog.abap> [--] [arguments...]
//
// F8 on a report: build it with osabap (tools/gogen/osabap.mjs) into a
// native command and run that command with the arguments as given. The
// report's selection screen is its command line: host flags take one dash
// (-db FILE, -allow-read DIR, -help), report options two (--name or
// --p-name), and with no arguments a terminal presents the selection screen.
//
// Every argument after the report goes to the command untouched; one bare
// `--` right after the report is osd's and is dropped, so that `osd run x
// -- -help` reaches the report rather than osd. A build is kept under
// .local/osd-run/<hash> (or $OSD_RUN_CACHE), the 16 last used kept, the hash
// taken over what the build reads: the report and the objects beside it,
// every --lib folder, and the compiler itself (tools/gogen with its runtime
// ABAP, the tools/*.mjs its front end imports, open-abap-core and
// open-abap-gui by size and time, the abaplint versions, the Go toolchain).
// The same source runs the kept command without a build.
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {compiled, toolCommand} from "./osd-host.mjs";

const root = resolve(import.meta.dirname, "..");

export function parseRunArgs(args) {
  const libs = [];
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--lib") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error("osd run: --lib needs a folder");
      libs.push(resolve(args[++i]));
      continue;
    }
    break;
  }
  const report = args[i];
  if (report === undefined || !/\.prog\.abap$/i.test(report)) {
    throw new Error("osd run: name a report, <name>.prog.abap");
  }
  let rest = args.slice(i + 1);
  if (rest[0] === "--") rest = rest.slice(1);
  return {libs, report: resolve(report), args: rest};
}

// the files a build reads, sorted, with what makes each one different
function* walk(dir, filter) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".out" || entry.name === "node_modules" || entry.name === ".git") continue;
      yield* walk(full, filter);
    } else if (filter(entry.name)) {
      yield full;
    }
  }
}

// The compiler's own files: tools/gogen (its runtime ABAP under apps/runtime
// included) and the tools/*.mjs its front end imports, as git knows them,
// tracked only, so what a build or another tool writes
// there (zz_*, go/generated, the gateway's main.go) is not an input
function compilerFiles() {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--", "tools/gogen", ":(glob)tools/*.mjs"],
    {cwd: root, encoding: "utf8"});
  if (listed.status === 0) return listed.stdout.split("\0").filter((file) => file && !/(^|\/)(?:\.out|zz_[^/]*)(\/|$)/.test(file)).sort().map((file) => join(root, file));
  return [...walk(join(root, "tools", "gogen"), (name) => /\.(mjs|ts|go|mod|sum|abap|xml)$/.test(name) && !name.startsWith("zz_"))];
}

const goEnv = () => {
  const version = spawnSync("go", ["env", "GOVERSION"], {cwd: join(root, "tools", "gogen", "go"), encoding: "utf8"});
  return `${version.stdout?.trim() ?? ""}/${process.env.GOTOOLCHAIN ?? ""}/${process.env.GOFLAGS ?? ""}/${process.env.CGO_ENABLED ?? ""}`;
};

export function buildHash({report, libs}) {
  const hash = createHash("sha256");
  const content = (file) => hash.update(`${file}\0`).update(readFileSync(file)).update("\0");
  const stamp = (file) => {
    const s = statSync(file, {throwIfNoEntry: false});
    hash.update(`${file}\0${s?.size}\0${s?.mtimeMs}\0`);
  };
  const abap = (name) => /\.(abap|xml)$/i.test(name);
  // the report's own folder holds its classes and dictionary (osabap.mjs)
  for (const file of walk(dirname(report), (name) => abap(name) && !name.includes(".testclasses."))) {
    if (dirname(file) === dirname(report)) content(file);
  }
  for (const lib of libs) for (const file of walk(lib, abap)) content(file);
  for (const file of compilerFiles()) stamp(file);
  for (const file of walk(join(root, ".local", "lars", "open-abap-core", "src"), abap)) stamp(file);
  for (const file of walk(join(root, ".local", "lars", "open-abap-gui"), (name) => /\.(abap|mjs)$/i.test(name))) stamp(file);
  for (const pkg of ["@abaplint/core", "@abaplint/transpiler"]) stamp(join(root, "node_modules", pkg, "package.json"));
  hash.update(`go:${goEnv()}`);
  return hash.digest("hex").slice(0, 32);
}

// Coordinate cache publication and pruning across processes. The lock holds
// the builder's pid, so a build that died leaves a lock the next run can take.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const lockPid = (file) => Number(readFileSync(file, {encoding: "utf8", flag: "r"}).trim()) || 0;

function withLock(file, fn, log) {
  mkdirSync(dirname(file), {recursive: true});
  const deadline = Date.now() + 15 * 60 * 1000;
  let said = false;
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let pid = 0;
    try {
      pid = lockPid(file);
    } catch {
      continue;
    }
    if (pid !== 0 && !alive(pid)) {
      // moved aside before it is looked at again, so two runs that both saw
      // it dead cannot remove the lock the faster one has just taken
      const aside = `${file}.${process.pid}`;
      try {
        renameSync(file, aside);
        if (lockPid(aside) === pid) rmSync(aside, {force: true});
        else renameSync(aside, file);
      } catch {
        // someone else moved it first
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`osd run: another build (pid ${pid}) holds ${file}`);
    if (!said) {
      log(`osd run: waiting for another build (pid ${pid})`);
      said = true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  // Ctrl+C reaches the whole terminal group: the build dies, spawnSync
  // returns, and this process removes its lock rather than dying with it
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", ignore);
  try {
    return fn();
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", ignore);
    rmSync(file, {force: true});
  }
}

const cacheDir = () => process.env.OSD_RUN_CACHE ? resolve(process.env.OSD_RUN_CACHE) : join(root, ".local", "osd-run");
const KEEP = 16;

// The kept builds beyond the KEEP last used go: only folders named like a
// hash, whatever else $OSD_RUN_CACHE holds stays, and a build another
// terminal is running (Windows will not remove it) is left for next time
function prune(dir) {
  const entries = readdirSync(dir, {withFileTypes: true}).filter((e) => e.isDirectory() && /^[0-9a-f]{32}$/.test(e.name))
    .map((e) => ({path: join(dir, e.name), at: statSync(join(dir, e.name)).mtimeMs}))
    .sort((a, b) => b.at - a.at);
  for (const old of entries.slice(KEEP)) {
    try {
      rmSync(old.path, {recursive: true, force: true});
    } catch {
      // in use
    }
  }
}

export function binaryFor({report, libs}, {log = (line) => console.error(line)} = {}) {
  // the command runs here, so it is built for here whatever GOOS says
  const exe = process.platform === "win32" ? "osabap.exe" : "osabap";
  const dir = cacheDir();
  const hashed = join(dir, buildHash({report, libs}));
  const kept = join(hashed, basename(report).replace(/\.prog\.abap$/i, ""), exe);
  if (existsSync(kept)) {
    // used now: pruning keeps the builds last used, not the last built
    const now = new Date();
    utimesSync(hashed, now, now);
    return kept;
  }
  return withLock(join(dir, ".lock"), () => {
    if (existsSync(kept)) return kept;
    log(`osd run: building ${basename(report)}`);
    const [command, ...args] = toolCommand(join(root, "tools", "gogen", "osabap.mjs"), [report, ...libs.flatMap((lib) => ["--lib", lib])]);
    const buildRoot = join(hashed, `.build-${process.pid}`);
    const env = {...process.env, OSABAP_BUILD_ROOT: buildRoot};
    delete env.GOOS;
    delete env.GOARCH;
    try {
      // the build talks on stderr: stdout is the report's own output
      const built = spawnSync(command, args, {cwd: root, env, stdio: ["ignore", 2, 2]});
      if (built.error) throw new Error(`osd run: the build of ${basename(report)} did not start: ${built.error.message}`);
      if (built.signal) throw new Error(`osd run: the build of ${basename(report)} was stopped (${built.signal})`);
      if (built.status !== 0) throw new Error(`osd run: the build of ${basename(report)} failed`);
      mkdirSync(dirname(kept), {recursive: true});
      const temp = `${kept}.${process.pid}`;
      copyFileSync(join(buildRoot, ".out", exe), temp);
      renameSync(temp, kept);
    } finally {
      rmSync(buildRoot, {recursive: true, force: true});
    }
    prune(dir);
    return kept;
  }, log);
}

export function main(args) {
  let bin;
  let run;
  try {
    // osabap is a checkout's tool (Go, the gogen sources, open-abap-core),
    // not part of the bundle
    if (compiled) throw new Error("osd run: build reports from a checkout: node bin/osd.mjs run <report.prog.abap>");
    run = parseRunArgs(args);
    if (!existsSync(run.report)) throw new Error(`osd run: no such report ${run.report}`);
    bin = binaryFor(run);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const result = spawnSync(bin, run.args, {stdio: "inherit"});
  if (result.error) {
    console.error(`osd run: ${result.error.message}`);
    return 2;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
