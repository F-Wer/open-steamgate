import {writeGo} from "./symbols.mjs";
// OSGo: build the Go host of open-steamgate (go/cmd/osgo) out of OSG's own
// ABAP, compiled as gateway.mjs compiles it (osg-build.mjs), with the ICF
// shim in front: a browser can use it.
//
//   node tools/gogen/osgo.mjs            -> .out/osgo  (all of OSG; heavy, run it under the shared lock;
//                                           refused when gen/ is not the tree's generation, --stale-gen overrides)
//   node tools/gogen/osgo.mjs --echo     -> .out/osgo-echo  (the shim, open-abap-core and a test handler at /echo)
//   .out/osgo [-port 3095] [-db file.sqlite] [-root <checkout>]
//
// The generated half of the program is written beside go/cmd/osgo/main.go:
// zz_generated.go (the classes), zz_db.json (tables and seed rows) and
// zz_boot.go (what boots, which SICF nodes are mounted, the launchpad tiles
// and the pack folders, as read from the checkout now).
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {columnRegistry, compileProgram} from "./frontend.mjs";
import {home} from "./home.mjs";
import {adtSourceHash} from "../osd-adt-gogen-gate.mjs";

const here = import.meta.dirname;
const echo = process.argv.includes("--echo");
const dir = join(here, "go", "cmd", "osgo");
const out = join(here, ".out", echo ? "osgo-echo" : "osgo");
const reportPath = `${out}-compile-report.json`;
// A failed build must not leave a previous successful report for the gate.
rmSync(reportPath, {force: true});
const sourceHash = adtSourceHash();
const sourceEpoch = process.env.SOURCE_DATE_EPOCH ?? execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {cwd: home, encoding: "utf8"}).trim();
if (!/^\d+$/.test(sourceEpoch)) throw new Error(`invalid SOURCE_DATE_EPOCH: ${sourceEpoch}`);
const builtAt = new Date(Number(sourceEpoch) * 1000).toISOString().slice(0, 16).replace("T", " ");

let program;
let statements = [];
let services = [];
const notServed = [];
let tiles = {tiles: []};
// the object store's facts (tools/gogen/store.mjs): none for --echo
let store = "";
let webapps = [];
// the push channels (*.sapc.xml) whose handler class this program has, and
// the ones left out; served by go/apc around the compiled ZCL_APC_HOST
// (ultra/packs, 2026-09-24)
const channels = [];
const channelsLeftOut = [];
if (echo) {
  program = compileProgram({folders: [`${home}/.local/lars/open-abap-core/src`, `${home}/.local/lars/express-icf-shim/src`, join(dir, "testdata")],
    objects: ["cl_express_icf_shim", "cl_http_entity", "cl_http_utility", "zcl_osgo_echo"]});
  console.log(`front end: ${program.classes.length} classes, ${program.partial.length} statement stubs`);
  services = [{path: "/echo", handler: "ZCL_OSGO_ECHO", active: true}];
} else {
  const {compileOsg, osgDatabase, staleGen} = await import("./osg-build.mjs");
  // a stale gen/ is refused (--stale-gen builds it anyway, with the warning)
  const stale = await staleGen();
  if (stale && !process.argv.includes("--stale-gen")) {
    console.error(`osgo: refused: ${stale} (or pass --stale-gen)`);
    process.exit(2);
  }
  if (stale) console.warn(`osgo: WARNING ${stale}`);
  const built = compileOsg();
  program = built.program;
  console.log(built.summary);
  const db = await osgDatabase(program);
  statements = db.statements;
  console.log(db.summary);
  // SMW0: the W3MI objects of the layers (the BSP apps' pages among them)
  // beside the binary in media/, their WWWPARAMS rows with the real sizes
  const {layers} = await import("./osg-build.mjs");
  const {collectMedia, writeMedia, replaceWwwparams} = await import("./media.mjs");
  const media = collectMedia(layers.filter(existsSync));
  statements = replaceWwwparams(statements, media);
  writeMedia(media, join(here, ".out", "media"));
  // the ICF registry as the Node hosts apply it at start (test/start.mjs
  // applyAtStartup): the same decision over the same *.sicf.xml, recorded
  // against an empty registry at build time and written as seed rows, so the
  // ICF services app and the status tables do not start empty
  const {applyAtStartup} = await import(`${home}/tools/osd-icf-apply.mjs`);
  const icfSql = [];
  const recorder = {select: async () => ({rows: []}), execute: async (sql) => { icfSql.push(sql); }};
  const icfActions = await applyAtStartup(recorder, {root: home, say: () => {}, now: new Date(Number(sourceEpoch) * 1000).toISOString()});
  if (icfActions === undefined) throw new Error("ICF registry could not be applied at build time");
  statements = [...statements, ...icfSql];
  console.log(`ICF registry: ${icfActions.length} nodes, ${icfSql.length} statements into the seed`);
  console.log(`media: ${media.length} W3MI objects, ${Math.round(media.reduce((n, o) => n + o.size, 0) / 1024)} KB -> .out/media`);
  // the SICF nodes of the tree, as the Node hosts mount them, minus the
  // paths src/icf/nodes.json gives to another front, minus a handler class
  // this program does not have (it would answer CX_SY_CREATE_OBJECT_ERROR)
  const {services: sicf} = await import(`${home}/tools/osd-icf.mjs`);
  const {nodes} = await import(`${home}/tools/osd-nodes.mjs`);
  const claimed = nodes(home, {proxies: false}).filter((n) => n.source.endsWith("nodes.json")).map((n) => n.path);
  const compiled = new Set(program.classes.map((c) => c.name));
  for (const s of sicf(home)) {
    if (s.handler === undefined && s.active !== false) continue;
    if (claimed.some((p) => s.path === p || s.path.startsWith(`${p}/`))) continue;
    // mounted as a refusal (main.go), so a request below it is not taken by
    // a parent node whose class is compiled, or by the 404 of no node
    if (s.type !== "ABAP") notServed.push({path: s.path, handler: String(s.handler ?? ""), why: `handler type ${s.icftyp} is not served by OSGo`});
    else if (!compiled.has(String(s.handler).toUpperCase())) notServed.push({path: s.path, handler: String(s.handler).toUpperCase(), why: `${String(s.handler).toUpperCase()} is not in this program`});
    else services.push({path: s.path, handler: String(s.handler).toUpperCase(), active: s.active !== false});
  }
  const {channels: sapc} = await import(`${home}/tools/osd-icf.mjs`);
  for (const c of sapc(home)) {
    if (!compiled.has("ZCL_APC_HOST")) channelsLeftOut.push({path: c.path, handler: c.handler, why: "ZCL_APC_HOST is not in this program"});
    else if (!compiled.has(String(c.handler).toUpperCase())) channelsLeftOut.push({path: c.path, handler: String(c.handler).toUpperCase(), why: `${String(c.handler).toUpperCase()} is not in this program`});
    else channels.push({path: c.path, name: c.name, handler: String(c.handler).toUpperCase()});
  }
  // DESTINATION 'STORE' over the files of the tree (go/objstore)
  const {storeConfig} = await import("./store.mjs");
  const cfg = await storeConfig(home);
  store = JSON.stringify(cfg);
  console.log(`store: ${cfg.roots.length} roots, ${cfg.libs.length} libraries (${cfg.libs.reduce((n, l) => n + l.files.length, 0)} files), ${Object.keys(cfg.built).length} files of this generation`);
  const {tilesOf, webappsOf} = await import(`${home}/tools/osd-packs.mjs`);
  tiles = {tiles: tilesOf(home)};
  webapps = webappsOf(home).map((p) => ({path: `/app/${p.name}`, dir: p.dir}));
}

const go = writeGo(join(dir, "zz_generated.go"), program);
writeFileSync(join(dir, "zz_db.json"), JSON.stringify(statements));
writeFileSync(join(dir, "zz_store.json"), store);
// the table registry as JSON, the column registry a dynamic WHERE parser reads
writeFileSync(join(dir, "zz_tables.json"), JSON.stringify(columnRegistry(program), null, 1));
const has = (fn) => go.includes(`\nfunc ${fn}(`);
// the system status of the binary (ultra/json, status.mjs / go/cmd/osgo/status.go):
// what it serves, and the generation it is
{
  const {statusFacts, statusGo} = await import("./status.mjs");
  const generated = go + JSON.stringify(statements);
  const facts = echo ? {services: [], packs: [], generation: `go:${(await import("node:crypto")).createHash("sha256").update(generated).digest("hex").slice(0, 16)}`}
    : await statusFacts({program, services: services.filter((x) => x.active), webapps, generated});
  writeFileSync(join(dir, "zz_status.go"), statusGo(facts, has("ZCL_OSD_STATUS_REFRESH")));
  console.log(`status: ${facts.services.length} services and ${facts.packs.length} packs of this binary, generation ${facts.generation}`);
}
// Keep generated ADT references out of handwritten cmd/osgo and echo tests.
const adtSessionAdapter = has("New_ZCL_OSD_ADT_SESSION") && has("ZCL_OSD_ADT_HANDLER_USE_SESSION") ? `
type adtSystemSession struct {
 *ZCL_OSD_ADT_SESSION
 step *abap.Session
 resolved ZIF_OSD_ADT_SESSION__TY_SESSION
}
func (a *adtSystemSession) ZIF_OSD_ADT_SESSION__RESOLVE(s *abap.Session, cookies, headers *[]*IHTTPNVP) ZIF_OSD_ADT_SESSION__TY_SESSION {
 a.resolved = a.ZCL_OSD_ADT_SESSION.ZIF_OSD_ADT_SESSION__RESOLVE(s, cookies, headers)
 return a.resolved
}
func (a *adtSystemSession) View() (string, bool) { return a.resolved.id, a.resolved.stateful == "X" }
func (a *adtSystemSession) Alive(id string) bool { return a.ZIF_OSD_ADT_SESSION__ALIVE(a.step, id) == "X" }
func (a *adtSystemSession) Adopt(id, typ, name string) string { return a.ZIF_OSD_ADT_SESSION__ADOPT_HANDLE(a.step, id, typ, name) }
func (a *adtSystemSession) Forget(id, handle string) (typ, name string) { a.ZIF_OSD_ADT_SESSION__RELEASE_HANDLE(a.step, id, handle, &typ, &name); return }
func init() {
 hasADTSession = true
 bindADTSession = func(s *abap.Session) func() {
  session := &adtSystemSession{ZCL_OSD_ADT_SESSION: New_ZCL_OSD_ADT_SESSION(s, 1800, "0"), step: s}
  clear := adtSystems.Bind(s, adtsystem.Provider{Sessions: session, Holders: adtsystem.ENQHolders{Server: adtLocks, Kernel: adtKernel, Client: abap.Mandt}, Identity: adtIdentity(abap.SysID, os.LookupEnv)})
  ZCL_OSD_ADT_HANDLER_USE_SESSION(s, session)
  return func() { clear(); ZCL_OSD_ADT_HANDLER_USE_SESSION(s, nil) }
 }
}
` : "// ADT session classes are absent; use the handwritten no-op binding.\n";
writeFileSync(join(dir, "zz_adt_session.go"), `package main
import ("osg/gogen/abap"; "osg/gogen/adtsystem"; "os")
var _ *abap.Session
var _ adtsystem.Provider
var _ = os.LookupEnv
${adtSessionAdapter}`);
const boots = ["ZCL_STG_SEGW_REGISTRY_REGISTER", "ZCL_STG_SHLP_REGISTRY_REGISTER"].filter(has);
// the synthetic demo rows: ZCL_OSD_DEMO_DATA=>BOOT with the knob the Node
// hosts pass (tools/osd-demo-data.mjs, OSD_DEMO_ROWS); main.go runs it in a
// dialog step of its own, after boot, and starts without them if it dumps
const demoData = has("ZCL_OSD_DEMO_DATA_BOOT")
  ? "const hasDemoData = true\n\nfunc demoData(s *abap.Session, config string) string { return ZCL_OSD_DEMO_DATA_BOOT(s, config) }"
  : "// ZCL_OSD_DEMO_DATA is not in this program\nconst hasDemoData = false\n\nfunc demoData(s *abap.Session, config string) string { return \"\" }";
// ZCL_APC_HOST as go/apc's Host, when this program compiled it (cmd/o4dserve's
// adapter): the query of the upgrade request as the handler's form fields
const apcAdapter = has("New_ZCL_APC_HOST") ? `
type apcHost struct{ h *ZCL_APC_HOST }

func (a apcHost) Open(s *abap.Session) bool         { return a.h.OPEN(s) == "X" }
func (a apcHost) Message(s *abap.Session, t string) { a.h.MESSAGE(s, t) }
func (a apcHost) Close(s *abap.Session, reason string, code int32) { a.h.CLOSE(s, reason, code) }
func (a apcHost) Drain(s *abap.Session) []string { return a.h.DRAIN(s) }

func newAPCHost(s *abap.Session, handler string, r *http.Request) apc.Host {
\t// in the order the URL has them, decoded as URLSearchParams decodes them
\t// for the Node host (apc.FormFields; url.ParseQuery would drop a pair with
\t// a bad escape or a ';')
\tfields := []*IHTTPNVP{}
\tfor _, f := range apc.FormFields(r.URL.RawQuery) {
\t\tfields = append(fields, &IHTTPNVP{name: f[0], value: f[1]})
\t}
\treturn apcHost{New_ZCL_APC_HOST(s, handler, &fields)}
}
` : `
// ZCL_APC_HOST is not in this program: no channel is served
func newAPCHost(s *abap.Session, handler string, r *http.Request) apc.Host { return nil }
`;
writeFileSync(join(dir, "zz_boot.go"), `package main

import (
\t"net/http"
\t"net/url"
\t"strings"

\t"osg/gogen/abap"
\t"osg/gogen/apc"
)

var _, _ = url.ParseQuery, strings.Split
${apcAdapter}
// the push channels (*.sapc.xml) whose handler this program has
var apcChannels = []apcChannel{
${channels.map((c) => `\t{Path: ${JSON.stringify(c.path)}, Name: ${JSON.stringify(c.name)}, Handler: ${JSON.stringify(c.handler)}},`).join("\n")}
}

// the push channels left out, and why
var apcLeftOut = []icfRefused{
${channelsLeftOut.map((s) => `\t{Path: ${JSON.stringify(s.path)}, Handler: ${JSON.stringify(s.handler)}, Why: ${JSON.stringify(s.why)}},`).join("\n")}
}

// generated by tools/gogen/osgo.mjs${echo ? " --echo" : ""}

// the checkout whose webapp/ is served unless -root says another
const osgRoot = "."

// what the Node hosts do at start: the SEGW registry and the search helps as providers
func boot(s *abap.Session) {
${boots.map((b) => `\t${b}(s)`).join("\n")}
}

${demoData}

// the shim's REQ and RES are the exchange (go/abap/icf.go)
func runShim(s *abap.Session, x *abap.ICFExchange, base string) {
\tCL_EXPRESS_ICF_SHIM_RUN(s, abap.Data{P: x}, abap.Data{P: x}, base)
}

var icfServices = []icfService{
${services.map((s) => `\t{Path: ${JSON.stringify(s.path)}, Handler: ${JSON.stringify(s.handler)}, Active: ${s.active}},`).join("\n")}
}

// the SICF nodes left out, each answered with a refusal at its own path
var notServed = []icfRefused{
${notServed.map((s) => `\t{Path: ${JSON.stringify(s.path)}, Handler: ${JSON.stringify(s.handler)}, Why: ${JSON.stringify(s.why)}},`).join("\n")}
}

const packTiles = ${JSON.stringify(JSON.stringify(tiles))}

// what the build was, for ZCL_OSD_SYSINFO's environment tab
const buildFacts = ${JSON.stringify(`build\t${program.classes.length} classes compiled, ${program.partial.length} statement stubs, ${program.skipped.length} methods not compiled; built ${builtAt} UTC`)}

var packWebapps = map[string]string{
${webapps.map((w) => `\t${JSON.stringify(w.path)}: ${JSON.stringify(relative(home, w.dir))},`).join("\n")}
}
`);
mkdirSync(join(here, ".out"), {recursive: true});
try { execFileSync("gofmt", ["-w", dir], {stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { console.log(`gofmt: ${String(e.stderr).split("\n").slice(0, 10).join("\n")}`); process.exit(1); }
const t1 = performance.now();
try {
  execFileSync("go", ["build", "-o", out, "./cmd/osgo"], {cwd: join(here, "go"), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, GOPROXY: "off"}});
} catch (e) {
  const lines = String(e.stderr).split("\n").filter((l) => /\.(go|abap):\d/.test(l) || /^#/.test(l));
  console.log(`go build failed; first:\n${lines.slice(0, 25).join("\n")}`);
  process.exit(1);
}
console.log(`go build ${Math.round(performance.now() - t1)} ms -> ${out}${existsSync(out) ? "" : " (missing!)"}`);
if (!existsSync(out)) throw new Error("osgo build produced no binary");
if (sourceHash !== adtSourceHash()) throw new Error("ADT sources changed during osgo build; rebuild before gating");
writeFileSync(reportPath, JSON.stringify({classes: program.classes.map(c => c.name), adtSourceHash: sourceHash,
  statementStubs: program.partial, methodsNotCompiled: program.skipped}, null, 2) + "\n");
console.log(`${services.length} SICF nodes mounted, ${notServed.length} not served, ${webapps.length} pack folders, ${tiles.tiles.length} tiles, ${channels.length} push channels${channelsLeftOut.length ? ` (left out: ${channelsLeftOut.map((c) => `${c.path} ${c.why}`).join("; ")})` : ""}`);
