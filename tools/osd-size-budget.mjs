// The size budget: monoliths may shrink, never grow (tools/osd-size-budget.json).
//
//   node tools/osd-size-budget.mjs              check; exit 1 on a breach
//   node tools/osd-size-budget.mjs --update     lower every budget to what is
//                                               there now, record new packages,
//                                               drop exemptions no longer needed
//   node tools/osd-size-budget.mjs --base <ref> also: a budget raised against
//                                               the one at <ref> needs a reason
//   node tools/osd-size-budget.mjs --changed <ref>
//                                               judge only what this branch
//                                               changed since its merge base
//                                               with <ref> (the pre-push hook);
//                                               a breach on what it did not
//                                               touch is printed and passes
//
// What it checks, each a ratchet that only loosens through an edit of the
// budget file a reviewer sees:
//   - every budgeted file and Go package is within its budget (physical lines;
//     a Go package without its tests and generated zz_ files);
//   - a .go file in go/abap without a budget has budget 0: new capabilities go
//     in a package of their own (tools/gogen/go/<name>), go/abap keeps binding;
//   - a Go file over fileLimits.go lines, or a tools/**/*.{mjs,ts} over
//     fileLimits.mjs, needs a budget of its own;
//   - every package under tools/gogen/go has a budget (--update records a new
//     one), a README.md of at least three lines, and does not depend on
//     osg/gogen/abap -- unless it is on the exemption lists, which only shrink.
// It runs at pre-push (.githooks/pre-push) and in CI (size-budget.yml).
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {dirname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET = join(ROOT, "tools", "osd-size-budget.json");
const GO = join(ROOT, "tools", "gogen", "go");
const UPDATE_REASON = "recorded by --update";
const HINT = "carve it into a package of its own (docs/backlog/gogen-osgo.md, \"modules\"), or raise the budget in tools/osd-size-budget.json with a reason";

const lines = (file) => {
  const text = readFileSync(file, "utf8");
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};
const rel = (p) => relative(ROOT, p).split("\\").join("/");

/** the Go packages: directories under tools/gogen/go with .go files, but
 * not generated/ or testdata/ */
/** the files git tracks under tools/, or undefined outside a checkout: what
 * is measured is what a commit carries, so a local run and CI measure the
 * same tree (generated files a build leaves on disk do not count) */
let trackedFiles;
function tracked() {
  if (trackedFiles !== undefined) return trackedFiles ?? undefined;
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--", "tools"], {cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1e8});
    trackedFiles = new Set(out.split("\0").filter(Boolean));
  } catch {
    trackedFiles = null;
  }
  return trackedFiles ?? undefined;
}
const isTracked = (file) => tracked()?.has(rel(file)) ?? true;

function goPackages() {
  const out = [];
  const walk = (dir) => {
    const names = readdirSync(dir).sort();
    if (names.some((n) => n.endsWith(".go") && isTracked(join(dir, n)))) out.push(dir);
    for (const n of names) {
      const p = join(dir, n);
      if (n === "testdata" || n === "generated" || n.startsWith(".") || !statSync(p).isDirectory()) continue;
      walk(p);
    }
  };
  walk(GO);
  return out;
}

/** a package's own code: no tests, and no zz_ files where they are
 * generated (cmd/*, which the gogen tools write and git ignores); a zz_ file
 * anywhere else is written by hand and counts */
const ownGoFiles = (dir) => readdirSync(dir).sort()
  .filter((n) => n.endsWith(".go") && !n.endsWith("_test.go") && !(n.startsWith("zz_") && rel(dir).startsWith("tools/gogen/go/cmd/")))
  .map((n) => join(dir, n))
  .filter(isTracked);

const pkgName = (dir) => rel(dir).replace(/^tools\/gogen\/go\//, "");

function scriptFiles(dir = join(ROOT, "tools"), out = []) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".out" || n.startsWith(".")) continue;
    if (statSync(p).isDirectory()) scriptFiles(p, out);
    else if (/\.(mjs|ts)$/.test(n) && isTracked(p)) out.push(p);
  }
  return out;
}

/** package -> does it depend on osg/gogen/abap; undefined without a Go
 * toolchain, and an Error when there is one and the listing failed (a check
 * that did not run must not read as one that passed). -e lists a package
 * whose files are incomplete -- cmd/osgo embeds a generated, ignored file */
export function abapDependents() {
  try {
    execFileSync("go", ["version"], {cwd: GO, stdio: "ignore"});
  } catch {
    return undefined;
  }
  try {
    const listing = execFileSync("go", ["list", "-e", "-f", "{{.ImportPath}} {{join .Deps \" \"}}", "./..."], {cwd: GO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
    const out = new Map();
    for (const line of listing.trim().split("\n")) {
      const [path, ...deps] = line.split(" ");
      out.set(path.replace(/^osg\/gogen\//, ""), deps.includes("osg/gogen/abap"));
    }
    return out;
  } catch (e) {
    return new Error(`go list failed: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`);
  }
}

/** what is there now: {key: lines} for files and packages */
export function measure(budget) {
  const sizes = {};
  for (const dir of goPackages()) {
    const files = ownGoFiles(dir);
    sizes[`go:${pkgName(dir)}`] = files.reduce((n, f) => n + lines(f), 0);
    for (const f of files) sizes[rel(f)] = lines(f);
  }
  for (const f of scriptFiles()) sizes[rel(f)] = lines(f);
  for (const f of budget.watched ?? []) if (existsSync(join(ROOT, f))) sizes[f] = lines(join(ROOT, f));
  return sizes;
}

/** the rules, each breach with the key it is about: a file path, a package
 * ("go:<name>"), or null for an edit of the budget file itself (judged
 * against the base, so always the branch's own) */
export function checkKeyed(budget, sizes, {deps, base} = {}) {
  const errors = [];
  errors.add = (key, message) => errors.push({key, message});
  const b = budget.budgets;
  const limitGo = budget.fileLimits?.go ?? 800;
  const limitMjs = budget.fileLimits?.mjs ?? 1000;
  for (const [key, entry] of Object.entries(b)) {
    if (sizes[key] === undefined) continue;
    if (sizes[key] > entry.lines) errors.add(key, `${key}: ${sizes[key]} lines, budget ${entry.lines} -- ${HINT}`);
  }
  for (const [key, n] of Object.entries(sizes)) {
    if (b[key]) continue;
    if (key.startsWith("tools/gogen/go/abap/") && key.endsWith(".go")) {
      errors.add(key, `${key}: a new file in go/abap (budget 0) -- a new capability goes in tools/gogen/go/<name> with a README; go/abap keeps binding glue`);
    } else if (key.endsWith(".go") && n > limitGo) {
      errors.add(key, `${key}: ${n} lines, over ${limitGo} without a budget -- ${HINT}`);
    } else if (/\.(mjs|ts)$/.test(key) && n > limitMjs) {
      errors.add(key, `${key}: ${n} lines, over ${limitMjs} without a budget -- ${HINT}`);
    } else if ((budget.watched ?? []).includes(key)) {
      errors.add(key, `${key}: watched, without a budget -- run --update`);
    } else if (key.startsWith("go:")) {
      errors.add(key, `${key}: a package without a budget -- run node tools/osd-size-budget.mjs --update to record it`);
    }
  }
  for (const key of Object.keys(sizes).filter((k) => k.startsWith("go:"))) {
    const name = key.slice(3);
    if (name === "abap" || name.startsWith("cmd/")) continue;
    const readme = join(GO, name, "README.md");
    const short = !existsSync(readme) || lines(readme) < 3;
    if (short && !(budget.readmeMissing ?? []).includes(name)) {
      errors.add(key, `tools/gogen/go/${name}: no README.md of at least three lines (what it is, its API, its invariants)`);
    }
    if (deps instanceof Map && deps.get(name) && !(name in (budget.importsAbap ?? {}))) {
      errors.add(`deps:${name}`, `tools/gogen/go/${name}: depends on osg/gogen/abap -- a package takes a narrow interface; only go/abap imports packages`);
    }
  }
  if (base) {
    for (const [key, entry] of Object.entries(b)) {
      const was = base.budgets?.[key];
      if (was && entry.lines > was.lines && (!entry.reason || entry.reason === was.reason)) {
        errors.add(null, `${key}: budget raised ${was.lines} -> ${entry.lines} without a new reason`);
      }
      // a budget the base did not have: a renamed package that grew, or a big
      // new one, needs a reason a reviewer reads, not the one --update writes
      if (!was && entry.lines > limitGo && (!entry.reason || entry.reason === UPDATE_REASON)) {
        errors.add(null, `${key}: a new budget of ${entry.lines} lines without a reason`);
      }
    }
    for (const name of budget.readmeMissing ?? []) {
      if (!(base.readmeMissing ?? []).includes(name)) errors.add(null, `readmeMissing: ${name} added -- the exemption list only shrinks; write the README`);
    }
    for (const name of Object.keys(budget.importsAbap ?? {})) {
      if (!(name in (base.importsAbap ?? {}))) errors.add(null, `importsAbap: ${name} added -- the exemption list only shrinks; take a narrow interface`);
    }
    for (const kind of ["go", "mjs"]) {
      if ((budget.fileLimits?.[kind] ?? 0) > (base.fileLimits?.[kind] ?? Infinity)) errors.add(null, `fileLimits.${kind} raised -- the limits only go down`);
    }
    for (const f of base.watched ?? []) {
      if (!(budget.watched ?? []).includes(f) && existsSync(join(ROOT, f))) errors.add(null, `watched: ${f} removed while it exists`);
    }
  }
  return errors;
}

export const check = (budget, sizes, options) => checkKeyed(budget, sizes, options).map((e) => e.message);

/** splits keyed breaches into the branch's own and those it only inherits:
 * a file is the branch's when it touched the file, a package when it touched
 * a file directly in the package's directory (its README included); either
 * is also the branch's when it changed that key's budget entry (lowered or
 * deleted it). A dependency on go/abap is transitive, so it is the branch's
 * when the branch touched any Go file or go.mod at all. */
export function attribute(errors, touched, {budget, base} = {}) {
  const dirs = new Set([...touched].map((p) => p.slice(0, p.lastIndexOf("/"))));
  const anyGo = [...touched].some((p) => p.startsWith("tools/gogen/go/") && (p.endsWith(".go") || p.endsWith("/go.mod")));
  const entryChanged = (key) => budget !== undefined
    && JSON.stringify(budget.budgets?.[key]) !== JSON.stringify(base?.budgets?.[key]);
  const mine = ({key}) => {
    if (key === null) return true;
    if (key.startsWith("deps:")) return anyGo;
    if (entryChanged(key)) return true;
    return key.startsWith("go:") ? dirs.has(`tools/gogen/go/${key.slice(3)}`) : touched.has(key);
  };
  return {
    own: errors.filter(mine).map((e) => e.message),
    inherited: errors.filter((e) => !mine(e)).map((e) => e.message),
  };
}

export function update(budget, sizes, {deps} = {}) {
  const b = budget.budgets;
  for (const [key, entry] of Object.entries(b)) {
    if (sizes[key] === undefined) delete b[key];
    else if (sizes[key] < entry.lines) entry.lines = sizes[key];
  }
  // a new package is recorded; a new go/abap file or an oversize file is not
  // (those need a budget written by hand, with a reason)
  for (const [key, n] of Object.entries(sizes)) {
    if (key.startsWith("go:") && !b[key]) b[key] = {lines: n, reason: UPDATE_REASON};
    if ((budget.watched ?? []).includes(key) && !b[key]) b[key] = {lines: n, reason: UPDATE_REASON};
  }
  budget.readmeMissing = (budget.readmeMissing ?? []).filter((name) => {
    const readme = join(GO, name, "README.md");
    return sizes[`go:${name}`] !== undefined && (!existsSync(readme) || lines(readme) < 3);
  });
  if (deps instanceof Map) {
    budget.importsAbap = Object.fromEntries(Object.entries(budget.importsAbap ?? {}).filter(([name]) => deps.get(name)));
  }
  budget.budgets = Object.fromEntries(Object.entries(b).sort(([a], [c]) => a.localeCompare(c)));
  return budget;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const budget = JSON.parse(readFileSync(BUDGET, "utf8"));
  const sizes = measure(budget);
  const deps = abapDependents();
  if (args.includes("--update")) {
    writeFileSync(BUDGET, JSON.stringify(update(budget, sizes, {deps}), null, 2) + "\n");
    console.log("osd-size-budget: budgets lowered to what is there, new packages recorded");
  } else {
    const git = (...a) => execFileSync("git", a, {cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1e8});
    const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
    // --changed <ref>: the branch is judged against where it left <ref>, so
    // what <ref> gained since (a breach that landed while CI was advisory, a
    // budget raised there) is not the branch's to fix
    let baseRef = option("--base");
    let touched;
    const changed = option("--changed");
    if (changed) {
      let mergeBase;
      try {
        mergeBase = git("merge-base", "HEAD", changed).trim();
      } catch {
        mergeBase = undefined;
      }
      if (mergeBase) {
        baseRef ??= mergeBase;
        // the working tree against the merge base: what a push of this
        // branch carries, plus what is not committed yet
        touched = new Set(git("diff", "--name-only", "-z", mergeBase).split("\0").filter(Boolean));
      } else {
        console.error(`osd-size-budget: no merge base with ${changed} -- judging the whole tree against it`);
        baseRef ??= changed;
      }
    }
    let base;
    if (baseRef) {
      try {
        base = JSON.parse(git("show", `${baseRef}:tools/osd-size-budget.json`));
      } catch {
        base = undefined; // the base has no budget file yet
      }
    }
    const keyed = checkKeyed(budget, sizes, {deps, base});
    const {own: errors, inherited} = touched ? attribute(keyed, touched, {budget, base}) : {own: keyed.map((e) => e.message), inherited: []};
    if (deps instanceof Error) errors.push(`the dependency direction could not be checked: ${deps.message}`);
    if (deps === undefined) {
      if (process.env.CI) errors.push("no Go toolchain in CI -- the dependency direction was not checked");
      else console.error("osd-size-budget: no Go toolchain -- the dependency direction was not checked");
    }
    if (inherited.length > 0) {
      const tty = process.stderr.isTTY ? ["\x1b[33m", "\x1b[0m"] : ["", ""];
      console.error(`${tty[0]}osd-size-budget: ${inherited.length} breach(es) in what this branch does not touch (on ${changed} already, not this branch's to fix):${tty[1]}`);
      for (const e of inherited) console.error(`${tty[0]}  ${e}${tty[1]}`);
    }
    if (errors.length > 0) {
      // --warn reports and passes: CI is advisory (Alice, 2026-10-02); the
      // pre-push hook is where a breach stops you
      const warn = args.includes("--warn");
      console.error(`osd-size-budget: ${errors.length} breach(es)${warn ? " (advisory)" : ""}:`);
      for (const e of errors) console.error(warn && process.env.GITHUB_ACTIONS ? `::warning title=size budget::${e}` : `  ${e}`);
      if (!warn) process.exit(1);
      process.exit(0);
    }
    if (inherited.length > 0) {
      console.log("osd-size-budget: nothing this branch touched is over its budget");
      process.exit(0);
    }
    console.log(`osd-size-budget: ${Object.keys(budget.budgets).length} budgets, all within`);
  }
}
