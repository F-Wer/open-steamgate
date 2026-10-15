import {append} from "./append.ts";
// Parity: OSG's own HTTP-level suites, run against OSG on Node and against
// OSGo, the same test files, each suite file on a fresh server of each kind.
//
//   node tools/gogen/parity.mjs [--root <checkout>] [--osgo <binary>] [--media <dir>]
//        [--port 4720] [--jobs N] [--out <dir>] [--node-ref <file>]
//        [--suites a,b] [--changed] [--only node|osgo]
//        [--reuse-node | --fresh-node] [--timeout 30000] [--no-count]
//        [--e2e] [--fast] [--report-only] [--stale-gen]
//
// --report-only reads the last run's results (<out>/node-reference.json and
// <out>/osgo-results.json) and only classifies and writes the summary again.
//
// Fast mode (the loop inside a wave; the full run with --e2e stays for the
// end of one):
//   --fast        mocha suites only (no Playwright), the Node reference reused,
//                 suites in parallel. A few minutes.
//   --jobs N      suites run N at a time (default: cores / 2), each on a port
//                 of its own (--port + 1 + slot) with a server of its own and
//                 so a database of its own (osgo and Node are both in memory).
//                 A suite's Node and OSGo runs never overlap: one suite is one
//                 job, and a suite that writes into the checkout (the editor's
//                 "Save to gen/") does so from one server at a time. The probe
//                 stays per test: each mocha is a process of its own and
//                 notes only the requests to its own STG_PORT.
//   --suites a,b  only these suite files (test/ and .mjs may be left out).
//   --changed     only the suites that OSGo did not pass in full last time
//                 (<out>/osgo-results.json); the others keep that result.
//                 Cheap and blind: a rebuild can break a suite that passed.
//
// The Node reference (--node-ref, default <out>/node-reference.json) is
// reused by default when its sidecar <ref>.meta.json names the same checkout
// commit (and the same diff of tracked files) and it holds every suite asked
// for; a reference of the same commit that lacks some suites gets just those
// run and added. Anything else is stale and is run again, and the harness
// says which and why. --reuse-node takes it whatever it says (a warning),
// --fresh-node never takes it.
//
// How a suite reaches its server: 16 files of test/suites.d/*.json call
// startServer() from test/start.mjs, which builds an express host in the
// suite's own process, and then fetch http://localhost:STG_PORT. The harness
// runs mocha with a module hook (parity/hooks.mjs) that turns test/start.mjs
// into a stub, so those fetches go to a server started here instead: the
// Node reference (parity/node-server.mjs, the same inline host in a process
// of its own) or the osgo binary. A probe (parity/register.mjs) notes every
// request a test sends to that port, with the status and, for an error, the
// body; a test that sent none is in-process and not comparable.
//
// Score = tests passing on OSGo / tests passing on Node, over the tests that
// passed on Node and sent at least one request there. Every other suite of
// test/suites.d/*.json is in-process (it imports output/ or a tool directly) and
// is counted, not run (mocha --dry-run), as "not applicable"; the count is
// kept in the reference's meta and reused with it.
//
// --e2e adds the Playwright specs of test/e2e (the browser against the
// server, SAPUI5 from SAP's CDN): one server per backend for the whole run,
// as playwright.config.mjs has it, and the specs' results joined the same
// way. Every spec is HTTP-level by construction. It runs beside the mocha
// suites, in one job slot of its own.
//
// Writes <out>/parity.json and <out>/parity.md (default .local/parity/).
import {spawn, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, createWriteStream} from "node:fs";
import {availableParallelism} from "node:os";
import {dirname, join, resolve} from "node:path";
import {home} from "./home.mjs";
import {loadSuites} from "../osd-suites.mjs";

const here = import.meta.dirname;
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const T0 = Date.now();
const phases = [];
let phaseStart = Date.now();
const phase = (name) => {
  const now = Date.now();
  phases.push({name, ms: now - phaseStart});
  console.log(`[phase] ${name}: ${((now - phaseStart) / 1000).toFixed(1)} s`);
  phaseStart = now;
};

const fast = flag("fast");
const root = resolve(arg("root", home));
const osgoBin = resolve(arg("osgo", join(here, ".out", "osgo")));
const media = arg("media", join(dirname(osgoBin), "media"));
const basePort = Number(arg("port", 4720));
const jobs = Math.max(1, Number(arg("jobs", Math.max(1, Math.floor(availableParallelism() / 2)))));
const out = resolve(arg("out", join(home, ".local", "parity")));
const nodeRefPath = resolve(arg("node-ref", join(out, "node-reference.json")));
const nodeMetaPath = nodeRefPath.replace(/\.json$/, "") + ".meta.json";
const only = arg("only");
const testTimeout = Number(arg("timeout", 30000));
const e2e = flag("e2e") && !fast;
const mocha = join(root, "node_modules", "mocha", "bin", "mocha.js");
mkdirSync(join(out, "runs"), {recursive: true});

const listed = loadSuites(root).files;
// an HTTP suite: it starts the gateway through test/start.mjs, statically
const isHttp = (f) => {
  const text = readFileSync(join(root, f), "utf8");
  return /^import \{startServer\} from "\.\/start\.mjs";/m.test(text) && /startServer\(/.test(text);
};
const allHttp = listed.filter(isHttp);
const norm = (s) => (s.startsWith("test/") ? s : `test/${s}`).replace(/(\.mjs)?$/, ".mjs");
let httpSuites = arg("suites") ? arg("suites").split(",").filter(Boolean).map(norm) : [...allHttp];
const naSuites = listed.filter((f) => !allHttp.includes(f));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };

async function waitUp(port, child, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    try {
      await fetch(`http://127.0.0.1:${port}/`, {redirect: "manual", signal: AbortSignal.timeout(2000)});
      return true;
    } catch { await sleep(100); }
  }
  return false;
}

// servers are stopped by their own pid, never by port or by name
function stop(child) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const t = setTimeout(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} }, 5000);
    child.once("exit", () => { clearTimeout(t); done(); });
    try { process.kill(child.pid, "SIGTERM"); } catch { done(); }
  });
}
const live = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const c of live) { try { process.kill(c.pid, "SIGKILL"); } catch {} } process.exit(130); });

function startBackend(kind, port, log) {
  const stream = createWriteStream(log);
  const env = {...process.env, STG_PORT: String(port), STG_TLS: "0"};
  delete env.STG_SERVE;
  delete env.STG_DB;
  delete env.STG_DB_PATH;
  const child = kind === "node"
    ? spawn(process.execPath, ["--max-old-space-size=4000", join(here, "parity", "node-server.mjs")], {cwd: root, env, stdio: ["ignore", "pipe", "pipe"]})
    : spawn(osgoBin, ["-port", String(port), "-addr", "127.0.0.1", "-root", root, ...(existsSync(media) ? ["-media", media] : [])], {cwd: dirname(osgoBin), env, stdio: ["ignore", "pipe", "pipe"]});
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  live.add(child);
  child.once("exit", () => live.delete(child));
  return child;
}

// a child process, awaited without blocking the other jobs
function run(cmd, args, opts, ms) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {...opts, stdio: ["ignore", "pipe", "pipe"]});
    live.add(child);
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-6000); });
    const t = setTimeout(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} }, ms);
    child.once("exit", (status, signal) => { clearTimeout(t); live.delete(child); done({status, signal, stderr}); });
  });
}

async function runMocha(files, port, recordFile, reportFile, extra = []) {
  const env = {...process.env, STG_PORT: String(port), PARITY_OUT: recordFile, STG_TLS: "0"};
  delete env.STG_SERVE;
  const r = await run(process.execPath, [
    "--import", join(here, "parity", "register.mjs"), mocha,
    "--require", join(here, "parity", "root-hooks.mjs"),
    "--timeout", String(testTimeout), "--reporter", "json", "--reporter-option", `output=${reportFile}`,
    ...extra, ...files,
  ], {cwd: root, env}, 20 * 60_000);
  return {status: r.status, signal: r.signal, stderr: String(r.stderr ?? "").slice(-3000), records: readJson(recordFile) ?? [], report: readJson(reportFile)};
}

const slug = (f) => f.replace(/^test\//, "").replace(/\.mjs$/, "");

async function runSuite(kind, file, port) {
  const base = join(out, "runs", `${kind}-${slug(file)}`);
  const child = startBackend(kind, port, `${base}.server.log`);
  const t0 = Date.now();
  const up = await waitUp(port, child, kind === "node" ? 240_000 : 120_000);
  const boot = Date.now() - t0;
  if (!up) {
    await stop(child);
    return {file, kind, up: false, boot, records: [], hookFailures: [], serverDied: true, log: tail(`${base}.server.log`)};
  }
  const t1 = Date.now();
  const m = await runMocha([file], port, `${base}.records.json`, `${base}.mocha.json`);
  const wall = Date.now() - t1;
  const died = child.exitCode !== null || child.signalCode !== null;
  await stop(child);
  // failures that are not a test: a hook ("before all" ...), which leaves the tests under it unrun
  const hookFailures = (m.report?.failures ?? []).filter((f) => /"(before|after) (all|each)" hook/.test(f.title))
    .map((f) => ({title: f.fullTitle, message: String(f.err?.message ?? "").slice(0, 600)}));
  const ran = (m.report?.tests ?? []).length;
  console.log(`  ${kind.padEnd(4)} ${file.padEnd(28)} :${port} boot ${String(boot).padStart(6)} ms  run ${(wall / 1000).toFixed(1).padStart(6)} s  ${m.records.filter((r) => r.state === "passed").length}/${m.records.length} passed${hookFailures.length ? `, ${hookFailures.length} hook failure(s)` : ""}${died ? ", SERVER DIED" : ""}${m.report ? "" : ` (no report: exit ${m.status} ${m.signal ?? ""})`}`);
  return {file, kind, up: true, boot, wall, ran, records: m.records, hookFailures, serverDied: died, mochaExit: m.status, mochaStderr: m.report ? undefined : m.stderr, log: died ? tail(`${base}.server.log`) : undefined};
}

function tail(f) {
  try { return readFileSync(f, "utf8").split("\n").slice(-15).join("\n"); } catch { return ""; }
}

// N at a time, each job holding one port slot for its whole length
async function pool(items, n, work) {
  const free = Array.from({length: n}, (_, i) => i);
  const waiting = [];
  const take = () => free.length ? Promise.resolve(free.shift()) : new Promise((r) => waiting.push(r));
  const give = (s) => { const w = waiting.shift(); if (w) w(s); else free.push(s); };
  await Promise.all(items.map(async (item) => {
    const slot = await take();
    try { await work(item, basePort + 1 + slot); } finally { give(slot); }
  }));
}

// ---- the checkout's gen/ is guarded ----------------------------------------
// A suite may write into the checkout it runs in, and one does at load time:
// test/shadowed-objects.mjs calls compileAll("src", "gen/stg") in its
// describe body, so even `mocha --dry-run` runs it, and its sweep ("what this
// run did not write, it removes") deletes the gen/stg folders of every model
// it was not given -- the CDS-published services and the packs' (measured
// 2026-09-24: the count of the previous full run left parity-home without
// ZC_STG_TRAVEL_CDS & co., and the next osgo built from it could not create
// their classes). So gen/ is copied aside at the start, compared after each
// phase, and put back, with what changed named.
const genDir = join(root, "gen");
const genSnap = join(out, "runs", "gen.snapshot");
const genList = (dir) => {
  const acc = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (rel === "" && e.name === "segw-editor") continue; // the editor's "Save to gen/" writes here on purpose
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else { const st = statSync(p); acc.push(`${rel}${e.name}\t${st.size}\t${st.mtimeMs}`); }
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return acc;
};
let genBefore;
// a checkout whose gen/ is not the generation of its inputs is refused
// (osg-build.mjs staleGen): Node runs such a gen/ and hides what an osgo
// built from it lacks, which is how two holes reached the browser build
if (!flag("report-only") && !flag("stale-gen")) {
  const {staleGen} = await import("./osg-build.mjs");
  const stale = await staleGen(root);
  if (stale) {
    console.error(`parity: refused: ${stale} (or pass --stale-gen)`);
    process.exit(2);
  }
}
if (!flag("report-only") && existsSync(genDir)) {
  rmSync(genSnap, {recursive: true, force: true});
  cpSync(genDir, genSnap, {recursive: true, preserveTimestamps: true});
  genBefore = genList(genDir);
}
function guardGen(when) {
  if (!genBefore) return;
  const now = genList(genDir);
  if (now.join("\n") === genBefore.join("\n")) return;
  const a = new Set(genBefore.map((l) => l.split("\t")[0]));
  const b = new Set(now.map((l) => l.split("\t")[0]));
  const gone = [...a].filter((f) => !b.has(f));
  const added = [...b].filter((f) => !a.has(f));
  const changed = now.filter((l) => a.has(l.split("\t")[0]) && !genBefore.includes(l)).map((l) => l.split("\t")[0]);
  const dirs = (fs) => [...new Set(fs.map((f) => f.split("/").slice(0, 2).join("/")))].slice(0, 12).join(", ");
  console.log(`WARNING gen/ of the checkout changed during ${when}: ${gone.length} removed (${dirs(gone)}), ${added.length} added (${dirs(added)}), ${changed.length} rewritten (${dirs(changed)}); put back`);
  for (const e of readdirSync(genDir)) if (e !== "segw-editor") rmSync(join(genDir, e), {recursive: true, force: true});
  for (const e of readdirSync(genSnap)) if (e !== "segw-editor") cpSync(join(genSnap, e), join(genDir, e), {recursive: true, preserveTimestamps: true});
  genWarnings.push({when, removed: gone.length, added: added.length, rewritten: changed.length, removedDirs: dirs(gone)});
}
const genWarnings = [];

// ---- the Node reference: reused or stale ---------------------------------
function checkoutId() {
  const git = (...a) => spawnSync("git", ["-C", root, ...a], {encoding: "utf8"}).stdout?.trim() ?? "";
  const diff = git("diff", "HEAD");
  return {commit: git("rev-parse", "HEAD"), diff: diff ? createHash("sha1").update(diff).digest("hex").slice(0, 12) : ""};
}
const checkout = checkoutId();
const results = {node: {}, osgo: {}};
const osgoPath = join(out, "osgo-results.json");
const reportOnly = flag("report-only");
let nodeMeta;
let nodeRan = false;
if (reportOnly) {
  results.node = JSON.parse(readFileSync(nodeRefPath, "utf8"));
  results.osgo = JSON.parse(readFileSync(osgoPath, "utf8"));
  httpSuites = Object.keys(results.osgo);
  nodeMeta = readJson(nodeMetaPath);
} else if (only !== "osgo") {
  const ref = readJson(nodeRefPath);
  const meta = readJson(nodeMetaPath);
  const wanted = [...httpSuites, ...(e2e ? ["test/e2e"] : [])];
  let why;
  if (flag("fresh-node")) why = "--fresh-node";
  else if (!ref) why = `none at ${nodeRefPath}`;
  else if (!meta) why = `no ${nodeMetaPath}: which checkout it was measured on is unknown`;
  else if (meta.commit !== checkout.commit) why = `measured on ${meta.commit.slice(0, 7)}, the checkout is ${checkout.commit.slice(0, 7)}`;
  else if (meta.diff !== checkout.diff) why = `measured on ${meta.commit.slice(0, 7)} with tracked changes ${meta.diff || "none"}, now ${checkout.diff || "none"}`;
  if (why && flag("reuse-node") && ref) {
    console.log(`node reference: STALE (${why}), reused anyway (--reuse-node): ${nodeRefPath}`);
    why = undefined;
  }
  if (why) {
    console.log(`node reference: STALE (${why}); all ${wanted.length} suites run on Node again`);
    nodeMeta = {commit: checkout.commit, diff: checkout.diff};
  } else {
    results.node = ref;
    nodeMeta = meta ?? {commit: checkout.commit, diff: checkout.diff};
    const missing = wanted.filter((f) => ref[f] === undefined);
    console.log(`node reference: reused ${nodeRefPath} (${meta?.commit?.slice(0, 7) ?? "?"}, ${Object.keys(ref).length} suites, measured ${meta?.when ?? "?"})` +
      (missing.length ? `; not in it, run now: ${missing.join(", ")}` : ""));
  }
}
if (!reportOnly && !existsSync(osgoBin) && only !== "node") {
  console.error(`no osgo binary at ${osgoBin} (node tools/gogen/osgo.mjs builds it)`);
  process.exit(2);
}

// --changed: the suites OSGo did not pass in full last time, the rest kept
let keptSuites;
if (flag("changed") && !reportOnly) {
  const prev = readJson(osgoPath) ?? {};
  const whole = (f) => {
    const g = prev[f];
    const n = results.node[f];
    if (!g || !g.up || g.serverDied || g.hookFailures?.length) return false;
    const ok = new Set(g.records.filter((r) => r.state === "passed").map((r) => r.title));
    return (n?.records ?? []).filter((r) => r.state === "passed").every((r) => ok.has(r.title));
  };
  const kept = httpSuites.filter(whole);
  for (const f of kept) results.osgo[f] = prev[f];
  httpSuites = httpSuites.filter((f) => !kept.includes(f));
  console.log(`--changed: ${httpSuites.length} suite(s) to run, ${kept.length} kept from ${osgoPath} (passed in full last time): ${kept.map(slug).join(", ") || "none"}`);
  append(httpSuites, kept);
  keptSuites = new Set(kept);
}
phase("setup");

console.log(`parity: ${httpSuites.length} HTTP suites${e2e ? " + e2e" : ""}, ${jobs} job(s) on ports ${basePort + 1}..${basePort + jobs}, checkout ${root} (${checkout.commit.slice(0, 7)}${checkout.diff ? ` +${checkout.diff}` : ""}), osgo ${osgoBin}`);
if (!reportOnly) {
  const todo = httpSuites.filter((f) => !keptSuites?.has(f));
  const work = [...todo.map((file) => ({file})), ...(e2e ? [{e2e: true}] : [])];
  // e2e first: it is the longest job, it should not start last
  work.sort((a, b) => (b.e2e ? 1 : 0) - (a.e2e ? 1 : 0));
  await pool(work, jobs, async (w, port) => {
    const file = w.e2e ? "test/e2e" : w.file;
    const runOne = w.e2e ? (kind) => runE2e(kind, port) : (kind) => runSuite(kind, file, port);
    if (only !== "osgo" && results.node[file] === undefined) { results.node[file] = await runOne("node"); nodeRan = true; }
    if (only !== "node") results.osgo[file] = await runOne("osgo");
  });
  if (e2e) httpSuites.push("test/e2e");
  guardGen("the suites");
  phase(`suites (${work.length} job(s), ${jobs} at a time${nodeRan ? ", Node included" : only === "osgo" ? ", Node not run" : ", Node reused"})`);
}

// the Playwright specs, one server per backend for the whole run
async function runE2e(kind, port) {
  const base = join(out, "runs", `${kind}-e2e`);
  const config = `${base}.playwright.config.mjs`;
  writeFileSync(config, `export default ${JSON.stringify({
    testDir: join(root, "test", "e2e"), testIgnore: "**/*preview*.spec.mjs", workers: 1, timeout: 90_000, expect: {timeout: 30_000}, retries: 0,
    outputDir: `${base}.artifacts`, reporter: [["json", {outputFile: `${base}.playwright.json`}]],
    use: {baseURL: `http://localhost:${port}`, headless: true},
  })};\n`);
  const child = startBackend(kind, port, `${base}.server.log`);
  const up = await waitUp(port, child, kind === "node" ? 240_000 : 120_000);
  const records = [];
  const t1 = Date.now();
  if (up) {
    const env = {...process.env, STG_PORT: String(port)};
    await run(process.execPath, [join(root, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", config], {cwd: root, env}, 40 * 60_000);
    const report = readJson(`${base}.playwright.json`);
    const walk = (suite, path) => {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const r = t.results?.[t.results.length - 1];
          const status = r?.status ?? "skipped";
          const msg = String(r?.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "");
          records.push({title: `e2e ${[...path, spec.title].join(" ")}`, state: status === "passed" ? "passed" : status === "skipped" ? "pending" : "failed",
            duration: r?.duration, err: status === "passed" ? undefined : {message: msg.slice(0, 800), timeout: /Timeout \d+ms exceeded|timed out/i.test(msg),
              // the lines around the failing assertion, as Playwright prints them: the
              // browser's requests are not probed, so this is how a spec names its path
              snippet: String(r?.error?.snippet ?? "").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 800)},
            // a spec drives the browser at the server, so every one is HTTP-level; its requests are not probed
            requests: [{method: "BROWSER", path: spec.file ?? suite.file ?? "", status: status === "passed" ? 200 : 0}]});
        }
      }
      for (const sub of suite.suites ?? []) walk(sub, [...path, sub.title]);
    };
    for (const s of report?.suites ?? []) walk(s, []);
  }
  const wall = Date.now() - t1;
  const died = child.exitCode !== null || child.signalCode !== null;
  await stop(child);
  console.log(`  ${kind.padEnd(4)} test/e2e (playwright)         :${port} run ${(wall / 1000).toFixed(1).padStart(6)} s  ${records.filter((r) => r.state === "passed").length}/${records.length} passed${died ? ", SERVER DIED" : ""}`);
  return {file: "test/e2e", kind, up, boot: 0, wall, records, hookFailures: [], serverDied: died, log: died ? tail(`${base}.server.log`) : undefined};
}

// the in-process suites, counted (kept with the Node reference: they depend on the checkout only)
let naCount;
if (reportOnly && existsSync(join(out, "runs", "na.mocha.json"))) {
  const r = JSON.parse(readFileSync(join(out, "runs", "na.mocha.json"), "utf8"));
  naCount = {suites: naSuites.length, tests: r.stats?.tests, counted: true};
} else if (nodeMeta?.naCount && nodeMeta.commit === checkout.commit && nodeMeta.naCount.suites === naSuites.length) {
  naCount = nodeMeta.naCount;
} else if (!flag("no-count")) {
  const m = await runMocha(naSuites, basePort, join(out, "runs", "na.records.json"), join(out, "runs", "na.mocha.json"), ["--dry-run"]);
  naCount = {suites: naSuites.length, tests: m.report?.stats?.tests ?? (m.report?.tests ?? []).length, counted: m.report !== undefined};
  if (nodeMeta && naCount.counted) { nodeMeta.naCount = naCount; nodeRan = true; }
  guardGen("the in-process count (mocha --dry-run)");
  phase("in-process suites counted (--dry-run)");
}

if (!reportOnly && only !== "osgo" && nodeRan) {
  writeFileSync(nodeRefPath, JSON.stringify(results.node));
  writeFileSync(nodeMetaPath, JSON.stringify({...nodeMeta, commit: checkout.commit, diff: checkout.diff, root, when: new Date().toISOString(), suites: Object.keys(results.node)}, null, 1));
  console.log(`node reference: written ${nodeRefPath} (${Object.keys(results.node).length} suites)`);
}
if (!reportOnly && only !== "node") writeFileSync(osgoPath, JSON.stringify(Object.fromEntries(httpSuites.filter((f) => results.osgo[f]).map((f) => [f, results.osgo[f]]))));

// ---- compare ---------------------------------------------------------------
const tests = [];
for (const file of httpSuites) {
  const n = results.node[file];
  const g = results.osgo[file];
  if (!n || !g) continue;
  const byTitle = new Map(g.records.map((r) => [r.title, r]));
  for (const r of n.records) {
    const o = byTitle.get(r.title);
    tests.push({file, title: r.title, node: r, osgo: o, osgoRun: g});
  }
}
const http = tests.filter((t) => t.node.requests.length > 0);
const inProcess = tests.filter((t) => t.node.requests.length === 0);
const denom = http.filter((t) => t.node.state === "passed");
const passed = denom.filter((t) => t.osgo?.state === "passed");
const failing = denom.filter((t) => t.osgo?.state !== "passed");
const osgoOnly = http.filter((t) => t.node.state !== "passed" && t.osgo?.state === "passed");
// the ADT facade (tools/adt-facade.mjs, a JS module of the Node host) is
// postponed (Alice, 2026-09-24): its tests are "adt-deferred", out of the
// headline's numerator and denominator alike and listed on their own line
const ADT_PATH = /^\/sap\/bc\/adt(\/|$|\?)|^\/osd\/not-served(\/|$|\?)/;
// A Playwright spec's requests are not probed: an e2e test is adt-deferred when
// the assertion OSGo failed on is next to a request to the facade, as in
// launchpad-navigation's "the Workbench tile is live where ADT answers"
// (HEAD /sap/bc/adt/core/discovery, a 404 on OSGo, which greys the tile)
const ADT_IN_SNIPPET = /["'`]\/sap\/bc\/adt(\/|["'`?])|["'`]\/osd\/not-served(\/|["'`?])/;
const isAdt = (t) => t.file === "test/adt-facade.mjs" || [...(t.node?.requests ?? []), ...(t.osgo?.requests ?? [])].some((q) => ADT_PATH.test(q.path ?? "")) ||
  (t.file === "test/e2e" && ADT_IN_SNIPPET.test(t.osgo?.err?.snippet ?? ""));
// "compiler-deferred" (Alice, 2026-09-25): the editor's CHECK, which on
// Node is abaplint over the whole system behind DESTINATION 'STORE'. OSGo is
// a built generation and answers CHECK with an explicit refusal naming the
// missing compiler (go/objstore storeNoCompiler); it is deferred until
// the incremental rebuild exists. Out of the headline's numerator and
// denominator, as adt-deferred is, and listed on its own line. That test
// only: the parser colouring (TOKENS) is not deferred, it moves to ABAP
// (ZCL_OSD_ABAP_TOKENS) and counts as a failure until then.
const COMPILER_DEFERRED = [
  {file: "test/editor.mjs", title: /checks the source it was POSTED/, tool: "abaplint's check over the whole system (STORE CHECK), until the incremental rebuild"},
];
const compilerDeferredOf = (t) => COMPILER_DEFERRED.find((h) => h.file === t.file && h.title.test(t.title));

function dumpKey(body) {
  let text = body;
  try { const j = JSON.parse(body); text = j?.error?.message?.value ?? body; } catch {}
  return String(text).replace(/\s+/g, " ").trim();
}
// where a missing route belongs: the ICF service (/sap/bc/<x>), the OData service, else the first two segments
const routeOf = (p) => {
  const path = p.split("?")[0];
  const odata = path.match(/^\/sap\/opu\/odata\/sap\/[^/]+/);
  if (odata) return odata[0];
  const seg = path.split("/").filter(Boolean);
  if (seg[0] === "sap" && seg[1] === "bc") return "/" + seg.slice(0, 3).join("/");
  return "/" + seg.slice(0, 2).join("/");
};
const shape = (p) => p.split("?")[0].replace(/\('[^']*'\)|\([^)]*=[^)]*\)|\(\d+\)/g, "(…)");

// Differences where OSGo answers what a system answers and Node does not
// ("go-matches-system": Go = system, Node = anomaly, each backed by an
// ANORMALIES entry). Such a test is no work for OSGo: the headline score
// leaves it out of the denominator, and the report lists it apart as
// closer to the reference, with the anomaly it rests on.
//
// Implicit MANDT: the seed row T0009 ("Other client, must not leak") is client
// 001. The transpiler has no implicit client, so OSG on Node serves it and the
// suites expect it (docs/shift-right-and-quick-wins.md B.6 keeps it visible on
// purpose); OSGo adds the logon client to the WHERE as a system does and
// filters it, so every count over ZSTG_DEMO is one lower. OSGo is the one
// that behaves like SAP here.
const KNOWN = [
  {name: "Go = system, Node = anomaly: implicit MANDT (ANORMALIES ANOMALY-2026-09-11-no-implicit-mandt): T0009 (client 001) filtered by OSGo, served by Node",
    test: (t, text) => /T0009/.test(text) ||
      (/Travel|list report/i.test(`${t.title} ${t.osgo?.requests?.map((q) => q.path).join(" ") ?? ""}`) &&
        /2 != 3|length 3, not 4|does not contain 4|expected 2 to equal 3|length of 4 but got 3|expected '3' to equal '4'|Expected: 4\s+Received: 3|Expected: 3\s+Received: 2/.test(text))},
];

function classify(t) {
  if (isAdt(t)) return {cat: "adt-deferred", key: "the ADT facade (/sap/bc/adt, /osd/not-served): a JS module of the Node host, postponed", detail: String(t.osgo?.err?.message ?? "").split("\n")[0].slice(0, 200)};
  const cd = compilerDeferredOf(t);
  if (cd) return {cat: "compiler-deferred", key: `the compiler, not in a built generation: ${cd.tool}`, detail: String(t.osgo?.err?.message ?? "").split("\n")[0].slice(0, 200)};
  const o = t.osgo;
  if (o !== undefined && o.state !== "passed") {
    const text = `${o.err?.message ?? ""} ${o.err?.expected ?? ""} ${o.err?.actual ?? ""}`;
    const nc = o.requests.some((q) => q.status >= 500);
    const known = nc ? undefined : KNOWN.find((k) => k.test(t, text));
    if (known) return {cat: "go-matches-system", key: known.name, detail: text.replace(/\s+/g, " ").slice(0, 200)};
  }
  if (o === undefined) {
    const hook = t.osgoRun.hookFailures[0];
    if (t.osgoRun.serverDied || !t.osgoRun.up) return {cat: "crash", key: "server did not start or died", detail: t.osgoRun.log};
    return {cat: "hook", key: `hook: ${(hook?.message ?? "not run").split("\n")[0].slice(0, 120)}`, detail: hook?.title};
  }
  const reqs = o.requests;
  const err = o.err ?? {};
  if (t.file === "test/e2e") {
    // the browser's requests are not probed: the spec file is the key, the first line of the error the detail
    const spec = reqs[0]?.path?.split("/").pop() ?? "?";
    return {cat: err.timeout ? "timeout" : "different answer", key: `e2e ${spec}`, detail: String(err.message ?? o.state).split("\n").filter(Boolean).slice(0, 2).join(" / ").slice(0, 300)};
  }
  if (reqs.some((q) => /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|fetch failed|socket hang up/.test(q.error ?? ""))) {
    return {cat: "crash", key: "connection refused or reset", detail: reqs.find((q) => q.error)?.error};
  }
  const nc = reqs.find((q) => q.status >= 500 && /NOT_COMPILED/.test(q.body ?? ""));
  if (nc) {
    const text = dumpKey(nc.body);
    // "NOT_COMPILED in <method>: <reason>" -- the method and the reason both, the reason names what is missing
    const key = text.slice(text.indexOf("NOT_COMPILED") + "NOT_COMPILED".length).replace(/^[:\s]+/, "").replace(/^in /, "");
    return {cat: "NOT_COMPILED", key: key.slice(0, 160), detail: `${nc.method} ${nc.path}: ${text.slice(0, 300)}`};
  }
  // the first request whose status differs from Node's for the same request
  const nreqs = t.node.requests;
  let diff;
  for (let i = 0; i < reqs.length; i++) {
    const q = reqs[i];
    const nq = nreqs.find((x, j) => j >= i && x.method === q.method && x.path === q.path) ?? nreqs[i];
    if (nq && nq.status !== q.status) { diff = {q, nq}; break; }
  }
  if (err.timeout) return {cat: "timeout", key: diff ? `${diff.q.method} ${shape(diff.q.path)}` : `timeout in ${t.file}`, detail: err.message};
  if (diff && diff.q.status >= 500) {
    return {cat: "dump", key: dumpKey(diff.q.body ?? "").slice(0, 140) || `${diff.q.status} ${shape(diff.q.path)}`, detail: `${diff.q.method} ${diff.q.path} -> ${diff.q.status} (Node ${diff.nq.status}): ${dumpKey(diff.q.body ?? "").slice(0, 300)}`};
  }
  // express's "Cannot GET /x" is no route at all, whatever Node answered there (a 400 or a 403 of a route it has)
  const noRoute = diff && diff.q.status === 404 && /<pre>Cannot /.test(diff.q.body ?? "") && diff.nq.status !== 404;
  if (diff && (noRoute || ((diff.q.status === 404 || diff.q.status === 501 || diff.q.status === 503) && diff.nq.status < 400))) {
    const refused = /not served by OSGo|is not in this program|not compiled/i.test(diff.q.body ?? "");
    return {cat: refused ? "missing service" : "missing route", key: `${routeOf(diff.q.path)}`, detail: `${diff.q.method} ${diff.q.path.slice(0, 120)} -> ${diff.q.status} (Node ${diff.nq.status}): ${(diff.q.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`};
  }
  if (diff) {
    return {cat: "different answer", key: `${diff.q.method} ${shape(diff.q.path)}: ${diff.nq.status} -> ${diff.q.status}`, detail: `${(diff.q.body ?? "").replace(/\s+/g, " ").slice(0, 200)} | ${String(err.message ?? "").split("\n")[0].slice(0, 200)}`};
  }
  const msg = String(err.message ?? o.state).split("\n")[0].slice(0, 160);
  const last = reqs[reqs.length - 1];
  return {cat: "different answer", key: `${t.file}: ${last ? `${last.method} ${shape(last.path)}` : "no request"}`,
    detail: `${msg}${err.expected !== undefined ? ` | expected ${err.expected.slice(0, 120)} | actual ${String(err.actual).slice(0, 120)}` : ""}`};
}

const groups = new Map();
for (const t of failing) {
  const c = classify(t);
  t.cat = c;
  const k = `${c.cat}\u0000${c.key}`;
  if (!groups.has(k)) groups.set(k, {category: c.cat, key: c.key, tests: []});
  groups.get(k).tests.push({file: t.file, title: t.title, detail: c.detail});
}
const ranked = [...groups.values()].sort((a, b) => b.tests.length - a.tests.length || a.key.localeCompare(b.key));
const byCat = {};
for (const g of ranked) byCat[g.category] = (byCat[g.category] ?? 0) + g.tests.length;

const perSuite = httpSuites.map((file) => {
  const all = tests.filter((t) => t.file === file);
  const h = all.filter((t) => t.node.requests.length > 0);
  const d = h.filter((t) => t.node.state === "passed");
  return {file, tests: all.length, http: h.length, nodePassed: d.length,
    osgoPassed: d.filter((t) => t.osgo?.state === "passed").length,
    nodeBootMs: results.node[file]?.boot, osgoBootMs: results.osgo[file]?.boot,
    osgoHookFailures: results.osgo[file]?.hookFailures?.length ?? 0, osgoServerDied: results.osgo[file]?.serverDied ?? false};
});

const summary = {
  when: new Date().toISOString(), root, osgo: osgoBin,
  score: denom.length ? passed.length / denom.length : null,
  totals: {suitesHttp: httpSuites.length, testsInHttpSuites: tests.length, httpTests: http.length, inProcessTestsInHttpSuites: inProcess.length,
    nodePassed: denom.length, nodeFailed: http.length - denom.length, osgoPassed: passed.length, osgoFailed: failing.length, osgoOnlyPassed: osgoOnly.length,
    notApplicableSuites: naCount?.suites ?? naSuites.length, notApplicableTests: naCount?.tests},
  byCategory: byCat, perSuite,
  groups: ranked,
  osgoOnly: osgoOnly.map((t) => ({file: t.file, title: t.title})),
  nodeFailures: http.filter((t) => t.node.state !== "passed").map((t) => ({file: t.file, title: t.title, message: String(t.node.err?.message ?? "").split("\n")[0].slice(0, 200)})),
  inProcess: inProcess.map((t) => ({file: t.file, title: t.title})),
};
writeFileSync(join(out, "parity.json"), JSON.stringify(summary, null, 1));

// the headline leaves the go-matches-system tests out of the denominator:
// OSGo answers them as a system does (scoreRaw keeps them in)
const known = failing.filter((t) => t.cat.cat === "go-matches-system").length;
const adtAll = denom.filter(isAdt).length;
const cdAll = denom.filter((t) => !isAdt(t) && compilerDeferredOf(t)).length;
const cdPassed = passed.filter((t) => !isAdt(t) && compilerDeferredOf(t)).length;
const passedH = passed.filter((t) => !isAdt(t) && !compilerDeferredOf(t)).length;
const denomH = denom.length - known - adtAll - cdAll;
summary.scoreRaw = summary.score;
summary.score = denomH ? passedH / denomH : null;
summary.totals.compilerDeferred = cdAll;
summary.totals.goMatchesSystem = known;
summary.totals.adtDeferred = adtAll;
summary.totals.headlinePassed = passedH;
summary.totals.headlineDenominator = denomH;
summary.closerToReference = failing.filter((t) => t.cat.cat === "go-matches-system").map((t) => ({file: t.file, title: t.title, why: t.cat.key}));
writeFileSync(join(out, "parity.json"), JSON.stringify(summary, null, 1));
const pct = (x) => x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
const md = [];
md.push(`# OSG parity: Node vs OSGo`, "", `${summary.when}, checkout \`${root}\`.`, "");
md.push(`**Score: ${pct(summary.score)}** -- ${passedH} of ${denomH} HTTP-level tests that pass on Node also pass on OSGo (${denom.length} pass on Node, less ${known} go-matches-system and ${adtAll} adt-deferred${cdAll ? `, ${cdAll} compiler-deferred` : ""}).`, "");
md.push(`**adt-deferred** -- ${adtAll} test(s) of the ADT facade (/sap/bc/adt, /osd/not-served), postponed; ${passed.length - passedH} of them pass on OSGo.`, "");
md.push(`Counting those as failures: ${pct(summary.scoreRaw)} (${passed.length} of ${denom.length}).`, "");
if (cdAll) md.push(`**compiler-deferred** -- ${cdAll} test(s) whose Node answer is abaplint's whole-system check (the editor's CHECK), deferred until the incremental rebuild; ${cdPassed} of them pass on OSGo.`, "");
if (known) {
  md.push(`**Closer to the reference** (go-matches-system: OSGo answers as a system does, Node's answer is an ANORMALIES entry) -- ${known} test(s):`, "");
  const why = new Map();
  for (const t of summary.closerToReference) why.set(t.why, (why.get(t.why) ?? 0) + 1);
  for (const [w, n] of why) md.push(`- ${n}: ${w}`);
  md.push("");
}
md.push(`| | count |`, `|---|---:|`);
for (const [k, v] of Object.entries(summary.totals)) md.push(`| ${k} | ${v ?? "?"} |`);
md.push("", "## Failures by category", "", "| category | tests |", "|---|---:|");
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
md.push("", "## Per suite", "", "| suite | tests | http | Node pass | OSGo pass | OSGo boot ms | notes |", "|---|---:|---:|---:|---:|---:|---|");
for (const s of perSuite) md.push(`| ${s.file} | ${s.tests} | ${s.http} | ${s.nodePassed} | ${s.osgoPassed} | ${s.osgoBootMs ?? ""} | ${[s.osgoHookFailures ? `${s.osgoHookFailures} hook failure(s)` : "", s.osgoServerDied ? "server died" : ""].filter(Boolean).join(", ")} |`);
md.push("", "## Failure groups, ranked by tests unblocked", "");
ranked.forEach((g, i) => {
  md.push(`### ${i + 1}. [${g.category}] ${g.key.replace(/\|/g, "\\|")} -- ${g.tests.length} test(s)`, "");
  for (const t of g.tests.slice(0, 8)) md.push(`- ${t.file}: ${t.title}${t.detail ? `  \n  \`${String(t.detail).split("\n")[0].replace(/`/g, "'").slice(0, 260)}\`` : ""}`);
  if (g.tests.length > 8) md.push(`- ... and ${g.tests.length - 8} more`);
  md.push("");
});
// what OSGo itself logged as a dump, over every run: the e2e specs' only view of the server side
{
  const dumps = new Map();
  for (const file of httpSuites) {
    let text = "";
    try { text = readFileSync(join(out, "runs", `osgo-${file === "test/e2e" ? "e2e" : slug(file)}.server.log`), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = line.match(/runtime error: \S+ (\S+): (.*?)  at /);
      if (!m) continue;
      const k = m[2].slice(0, 160);
      const e = dumps.get(k) ?? {n: 0, suites: new Set(), example: m[1]};
      e.n++; e.suites.add(file); dumps.set(k, e);
    }
  }
  summary.serverDumps = [...dumps].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => ({dump: k, count: e.n, suites: [...e.suites], example: e.example}));
  writeFileSync(join(out, "parity.json"), JSON.stringify(summary, null, 1));
  if (dumps.size) {
    md.push("## Dumps OSGo logged (all runs, e2e included)", "", "| count | dump | suites | e.g. |", "|---:|---|---|---|");
    for (const d of summary.serverDumps.slice(0, 40)) md.push(`| ${d.count} | ${d.dump.replace(/\|/g, "\\|")} | ${d.suites.join(", ")} | \`${d.example.slice(0, 80)}\` |`);
    md.push("");
  }
}
if (osgoOnly.length) {
  md.push("## Pass on OSGo, fail on Node", "");
  append(md, osgoOnly.map((t) => `- ${t.file}: ${t.title}`));
  md.push("");
}
phase("compare and report");
summary.phases = phases;
summary.genWarnings = genWarnings;
summary.wallMs = Date.now() - T0;
writeFileSync(join(out, "parity.json"), JSON.stringify(summary, null, 1));
md.push("## Wall time", "", "| phase | s |", "|---|---:|");
append(md, phases.map((p) => `| ${p.name} | ${(p.ms / 1000).toFixed(1)} |`));
md.push(`| total | ${(summary.wallMs / 1000).toFixed(1)} |`, "");
writeFileSync(join(out, "parity.md"), md.join("\n"));
console.log(`\nscore ${pct(summary.score)} (${passedH}/${denomH}: ${denom.length} Node-passed - ${known} go-matches-system - ${adtAll} adt-deferred - ${cdAll} compiler-deferred); raw ${pct(summary.scoreRaw)} (${passed.length}/${denom.length})`);
console.log(`${failing.length} failing in ${ranked.length} groups; not applicable: ${summary.totals.notApplicableSuites} suites, ${summary.totals.notApplicableTests ?? "?"} tests`);
console.log(`wall ${(summary.wallMs / 1000).toFixed(1)} s: ${phases.map((p) => `${p.name} ${(p.ms / 1000).toFixed(1)} s`).join("; ")}`);
console.log(`-> ${join(out, "parity.md")}`);
