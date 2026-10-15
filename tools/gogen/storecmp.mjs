// The Go host's DESTINATION 'STORE' against the Node host's, answer by
// answer, over the same files (go/objstore, tools/osd-store-destination.mjs).
//
//   node tools/gogen/storecmp.mjs [--root <tree>] [--tools <checkout>]
//
// --tools names the checkout whose Node store answers (default: the tree
// itself), for a tree that is only files, like testdata-store/tree.
//
// Reads are compared on the tree as it is. Writes are compared on two
// scratch copies of it (src/ copied, everything else linked), one per host,
// with the same calls in the same order; the files the writes leave behind
// are compared too. EV_MS is a stopwatch and is left out; so is the time of
// a file one of the writes touched, since the two hosts wrote it at two
// different moments.
import {execFileSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {buildFixture} from "../osgo-store-fixture.mjs";
import {compilerCases, compilerAnswers, compilerGapCases, prepareCompilerFixture} from "../osgo-store-goldens.mjs";
import {home} from "./home.mjs";
import {storeConfig} from "./store.mjs";
import {ADT_SCALARS, adtStoreSignature} from "./storecmp-signature.mjs";
// frontend.mjs first, as the compiler loads it; the table itself lives in
// the native-classes module since the frontend split
import "./frontend.mjs";
import {DESTINATION_FM} from "./frontend-classes-native.mjs";

const here = import.meta.dirname;
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(arg("--root") ?? home);
const tools = resolve(arg("--tools") ?? root);
const out = join(here, ".out", "storecmp");
mkdirSync(out, {recursive: true});

const {StoreDestination} = await import(`${tools}/tools/osd-store-destination.mjs`);
const {ObjectStore} = await import(`${tools}/tools/osd-store.mjs`);

const box = (v = "") => ({v, get() { return this.v; }, set(x) { this.v = x; }});
const table = (fields) => {
  const t = {rows: [], array() { return this.rows; }, clear() { this.rows = []; }, append(r) { this.rows.push(r); },
    getRowType() { return {clone() { const inner = Object.fromEntries(fields.map((f) => [f, box()])); return {get: () => inner}; }}; }};
  return t;
};
const rowsOf = (signature, name) => signature.tables[name.toLowerCase()].rows
  .map((row) => Object.fromEntries(Object.entries(row.get()).map(([field, value]) => [field.toUpperCase(), value.get()])));

// Compare the keys Node returns for each command, including JSON and history
// state. A reduced RFC importing signature would silently hide these fields.
async function nodeCall(destination, call) {
  const answer = await destination.execute(call);
  const scalars = Object.fromEntries(Object.entries(answer).filter(([key]) => key.startsWith("EV_")));
  return {scalars, objects: answer.ET_OBJECT, issues: answer.ET_ISSUE, types: answer.ET_TYPE, revisions: answer.ET_REVISION};
}

async function nodeAdapterCall(destination, call, fields = ADT_TABLES, scalars = ADT_SCALARS) {
  const signature = {
    exporting: Object.fromEntries(Object.entries(call).map(([key, value]) => [key.toLowerCase(), box(value)])),
    importing: Object.fromEntries(scalars.map((key) => [key.toLowerCase(), box()])),
    tables: Object.fromEntries(Object.entries(fields).map(([key, rowFields]) => [key.toLowerCase(), table(rowFields)])),
  };
  await destination.call("ZOSD_STORE", signature);
  return {
    scalars: Object.fromEntries(scalars.map((key) => [key, String(signature.importing[key.toLowerCase()].get())])),
    objects: rowsOf(signature, "ET_OBJECT"),
    revisions: rowsOf(signature, "ET_REVISION"),
    ...(fields.ET_ISSUE ? {issues:rowsOf(signature, "ET_ISSUE"), types:rowsOf(signature, "ET_TYPE")} : {}),
  };
}

function goCalls(tree, config, calls, signature = null, sidecar = null) {
  const configFile = join(out, `config-${Date.now()}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  const input = signature === null ? calls : {calls, ...signature};
  const raw = execFileSync("go", ["run", "./cmd/storecmp", "-root", tree, "-config", configFile, ...(sidecar === null ? [] : ["-compiler"])],
    {cwd: join(here, "go"), input: JSON.stringify(input), env: {...process.env, OSGO_SIDECAR:sidecar ?? "/nonexistent/osgo-sidecar"}, timeout:120000, maxBuffer: 1 << 30}).toString();
  if (signature !== null) return JSON.parse(raw).map((answer) => ({scalars: answer.Scalars, objects: answer.Objects, revisions: answer.Revisions, issues: answer.Issues, types: answer.Types}));
  return JSON.parse(raw).map((a) => ({scalars: a.Scalars, objects: a.Objects ?? [], issues: a.Issues ?? [],
    revisions: a.Revisions ?? [], types: (a.Types ?? []).map((t) => ({TYPE: t.TYPE, COUNT: t.COUNT}))}));
}

// what the two must agree on
function comparable(answer, touched = new Set()) {
  const scalars = Object.fromEntries(Object.entries(answer.scalars).filter(([k]) => k !== "EV_MS").sort(([a], [b]) => a.localeCompare(b)));
  const objects = answer.objects.map((o) => ({...o, CHANGED_AT: touched.has(o.FILE) ? "(written)" : o.CHANGED_AT}));
  const issues = answer.issues.map(i => Object.fromEntries(Object.entries({...i, LINE:Number(i.LINE), COL:Number(i.COL)}).sort(([a],[b]) => a.localeCompare(b))));
  const types = answer.types.map((t) => ({TYPE: t.TYPE, COUNT: Number(t.COUNT)}));
  return JSON.stringify({scalars, objects, issues, types, revisions: answer.revisions});
}

let bad = 0;
function compare(label, node, go, touched) {
  const n = comparable(node, touched);
  const g = comparable(go, touched);
  if (n === g) return true;
  bad += 1;
  let at = 0;
  while (at < n.length && n[at] === g[at]) at += 1;
  console.log(`FAIL ${label}\n     node: ...${n.slice(Math.max(0, at - 120), at + 200)}\n     go:   ...${g.slice(Math.max(0, at - 120), at + 200)}`);
  return false;
}

// exactly the importing parameters the ADT front declares at its
// CALL FUNCTION 'ZOSD_STORE' sites, not the wider function-module signature
const ADT_TABLES = adtStoreSignature(tools);

const goHostParams = new Map(Object.entries(DESTINATION_FM.get("STORE ZOSD_STORE")?.params ?? {}));
// batch 1 (#672) closed IV_JSON, EV_JSON, EV_STATE and EV_CHANGED: no
// scalar of the ADT front is an expected gap any more
const KNOWN_GAPS = new Map();
// and they stay closed: IV_JSON reaches no read or write call of this
// harness (only the compiler cases, which build their own signature), so a
// frontend that dropped one of them would otherwise pass unnoticed
for (const field of ["IV_JSON", "EV_JSON", "EV_STATE", "EV_CHANGED"]) {
  if (!goHostParams.has(field)) {
    bad += 1;
    console.log(`FAIL ${field}: the gogen host signature (DESTINATION_FM STORE ZOSD_STORE) no longer carries it`);
  }
}
for (const field of KNOWN_GAPS.keys()) {
  if (goHostParams.has(field)) {
    bad += 1;
    console.log(`FAIL ratchet ${field}: the gogen host signature now carries it; remove its expected gap`);
  }
}
// batch 1 (#672) maps ET_REVISION-SUBJECT_FULL (go/abap storeRevisionRow)
const ROW_GAPS = new Map();
const adapterSignature = {
  inputs: Object.fromEntries([...goHostParams].filter(([, kind]) => kind === "exporting").map(([key]) => [key, true])),
  imports: Object.fromEntries([...goHostParams].filter(([, kind]) => kind === "importing").map(([key]) => [key, true])),
  tables: Object.fromEntries(Object.keys(ADT_TABLES).map((key) => [key, true])),
  tableFields: Object.fromEntries(Object.entries(ADT_TABLES).map(([key, fields]) => [key, fields.map((f) => f.toUpperCase())])),
};
const adapterInput = (call) => Object.fromEntries(Object.entries(call)
  .filter(([key]) => adapterSignature.inputs[key] === true));

function adapterComparable(answer, touched = new Set()) {
  const stable = (row, table) => Object.fromEntries(Object.keys(row).filter((key) => !ROW_GAPS.has(`${table}-${key}`)).sort()
    .map((key) => [key, touched.has(row.FILE) && key === "CHANGED_AT" ? "(written)" : row[key]]));
  return JSON.stringify({
    scalars: Object.fromEntries(ADT_SCALARS.filter((key) => !KNOWN_GAPS.has(key)).sort()
      .map((key) => [key, answer.scalars[key] ?? ""])),
    objects: answer.objects.map((r) => stable(r, "ET_OBJECT")),
    revisions: answer.revisions.map((r) => stable(r, "ET_REVISION")),
  });
}

function expectedGaps(call, node) {
  const gaps = [];
  if (call.IV_JSON !== undefined && !goHostParams.has("IV_JSON") && KNOWN_GAPS.has("IV_JSON")) gaps.push("IV_JSON");
  if (node.scalars.EV_JSON !== "" && !goHostParams.has("EV_JSON") && KNOWN_GAPS.has("EV_JSON")) gaps.push("EV_JSON");
  if (call.IV_COMMAND?.toUpperCase() === "HISTORY") {
    if (!goHostParams.has("EV_STATE") && KNOWN_GAPS.has("EV_STATE")) gaps.push("EV_STATE");
    if (!goHostParams.has("EV_CHANGED") && KNOWN_GAPS.has("EV_CHANGED")) gaps.push("EV_CHANGED");
  }
  return gaps;
}

function compareAdapter(label, node, go, call, touched = new Set()) {
  const n = adapterComparable(node, touched);
  const g = adapterComparable(go, touched);
  if (n !== g) {
    bad += 1;
    let at = 0;
    while (at < n.length && n[at] === g[at]) at += 1;
    console.log(`FAIL adapter ${label}\n     node: ...${n.slice(Math.max(0, at - 120), at + 200)}\n     go:   ...${g.slice(Math.max(0, at - 120), at + 200)}`);
    return false;
  }
  for (const field of expectedGaps(call, node)) console.log(`KNOWN adapter gap ${label}: ${field} (${KNOWN_GAPS.get(field) ?? ROW_GAPS.get(field)})`);
  return true;
}

// ------------------------------------------------------------------ reads
const store = new ObjectStore({root});
const all = store.list();
const reads = [
  {IV_COMMAND: "SYSTEM", IV_TYPE: "IDENTITY"},
  {IV_COMMAND: "SYSTEM", IV_TYPE: "LOCK_HANDLE"},
  {IV_COMMAND: "SYSTEM", IV_TYPE: "NOPE"},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":""}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":" 2 "}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":"0x2"}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":true}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":false}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":-2}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":null}'},
  {IV_COMMAND: "SEARCH", IV_JSON: '{"seed":"Z","limit":"junk"}'},
  {IV_COMMAND: "LIST", IV_LIMIT: "100000"},
  {IV_COMMAND: "LIST"},
  {IV_COMMAND: "list", IV_FILTER: "osd", IV_LIMIT: "300"},
  {IV_COMMAND: "LIST", IV_TYPE: "CLAS", IV_FILTER: "ZCL_OSD", IV_LIMIT: "300"},
  {IV_COMMAND: "LIST", IV_TYPE: "DEVC", IV_LIMIT: "300"},
  {IV_COMMAND: "LIST", IV_FILTER: "NO_SUCH_OBJECT_ANYWHERE"},
  {IV_COMMAND: "LIST", IV_LIMIT: "-5"},
  ...[...new Set(all.map((o) => o.type))].map((type) => ({IV_COMMAND: "LIST", IV_TYPE: type, IV_LIMIT: "100000"})),
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_NO_SUCH_CLASS"},
  {IV_COMMAND: "READ", IV_TYPE: "STRU", IV_NAME: "ZOSD_OBJECT_S"},
  {IV_COMMAND: "READ", IV_TYPE: "STRU", IV_NAME: "ZOSD_TSES"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_TRAN_SESSION", IV_INCLUDE: "testclasses"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_INCLUDE: "testclasses"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_INCLUDE: "nonsense"},
  {IV_COMMAND: "BOGUS"},
  {IV_COMMAND: "CHECK", IV_TYPE: "CLAS", IV_NAME: "ZCL_NO_SUCH_CLASS"},
  // Compiler/publication calls belong to the explicit Go-only checks below.
  // HISTORY exercises the host read path and its EV_STATE/EV_CHANGED scalars.
  {IV_COMMAND: "HISTORY", IV_TYPE: "CLAS", IV_NAME: "ZCL_ST_A"},
  // the calls of testdata/zcl_gogen_t_store over testdata-store/tree
  {IV_COMMAND: "list", IV_FILTER: "st_", IV_TYPE: "clas"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "zcl_st_a"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_ST_A", IV_INCLUDE: "implementations"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_ST_A", IV_INCLUDE: "testclasses"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_ST_SKIP"},
  // every object of the tree, read whole
  ...all.map((o) => ({IV_COMMAND: "READ", IV_TYPE: o.type, IV_NAME: o.name})),
];
const nodeDest = new StoreDestination({store: () => new ObjectStore({root})});
const config = await storeConfig(root, {storeModule: `${tools}/tools/osd-store.mjs`});
const goExecuteReads = goCalls(root, config, reads);
const adapterReads = reads.map(adapterInput);
const goAdapterReads = goCalls(root, config, adapterReads, adapterSignature);
let same = 0;
let adapterSame = 0;
for (let i = 0; i < reads.length; i += 1) {
  const label = `read #${i} ${JSON.stringify(reads[i])}`;
  const nodeAnswer = await nodeCall(nodeDest, reads[i]);
  if (compare(label, nodeAnswer, goExecuteReads[i])) same += 1;
  const nodeAdapterAnswer = await nodeAdapterCall(nodeDest, reads[i]);
  if (compareAdapter(label, nodeAdapterAnswer, goAdapterReads[i], reads[i])) adapterSame += 1;

}
console.log(`execute reads: ${same} of ${reads.length} answers the same (${all.length} objects in the tree)`);
console.log(`adapter reads: ${adapterSame} of ${reads.length} answers the same`);

// A private repository gives HISTORY real rows even when the input fixture
// has no history. Long subjects distinguish the Atom title from SUBJECT(80).
const historyTree = join(out, "history");
rmSync(historyTree, {recursive: true, force: true});
mkdirSync(join(historyTree, "src"), {recursive: true});
writeFileSync(join(historyTree, "abap_transpile.json"), JSON.stringify({input_folder: ["src"]}));
const git = (...args) => execFileSync("git", args, {cwd: historyTree});
git("init", "-q");
git("config", "user.name", "Test Author");
git("config", "user.email", "test@example.invalid");
for (const subject of ["short title", "Full Atom title " + "x".repeat(100)]) {
  writeFileSync(join(historyTree, "src/zst_history.prog.abap"), `REPORT zst_history.\n* ${subject}\n`);
  git("add", ".");
  git("commit", "-q", "-m", subject);
}
const historyCalls = [{IV_COMMAND: "HISTORY", IV_TYPE: "PROG", IV_NAME: "ZST_HISTORY"}];
const historyConfig = await storeConfig(historyTree, {storeModule: `${tools}/tools/osd-store.mjs`});
const historyDest = new StoreDestination({store: () => new ObjectStore({root: historyTree})});
const nodeHistory = await nodeCall(historyDest, historyCalls[0]);
const goHistory = goCalls(historyTree, historyConfig, historyCalls)[0];
compare("history full title", nodeHistory, goHistory);
const nodeHistoryAdapter = await nodeAdapterCall(historyDest, historyCalls[0]);
const goHistoryAdapter = goCalls(historyTree, historyConfig, historyCalls.map(adapterInput), adapterSignature)[0];
compareAdapter("history full title", nodeHistoryAdapter, goHistoryAdapter, historyCalls[0]);
if (nodeHistory.revisions.length !== 2 || nodeHistory.revisions[0].SUBJECT_FULL.length <= 80) {
  bad += 1;
  console.log("FAIL history fixture: expected two revisions and an untruncated title");
}
console.log(`history: ${nodeHistory.revisions.length} revisions compared through execute and adapter`);

// ----------------------------------------------------------------- writes
// two scratch trees: src/ copied, the rest linked, so the writes land in a
// copy and the tree itself is not touched
function scratch(name) {
  const dir = join(out, name);
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true});
  for (const entry of readdirSync(root)) {
    if (entry === "src") cpSync(join(root, "src"), join(dir, "src"), {recursive: true, dereference: true});
    else symlinkSync(join(root, entry), join(dir, entry));
  }
  return dir;
}
const writes = [
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_SOURCE: "* changed\r\nCLASS x.\rENDCLASS.\n"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT"},
  {IV_COMMAND: "LIST", IV_FILTER: "ZCL_OSD_EDIT"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_INCLUDE: "testclasses", IV_SOURCE: "* tests\n"},
  {IV_COMMAND: "READ", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_INCLUDE: "testclasses"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_INCLUDE: "nonsense", IV_SOURCE: "x"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "CL_ABAP_CHAR_UTILITIES", IV_SOURCE: "x"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "ZCL_STG_SEGW_REGISTRY", IV_SOURCE: "x"},
  {IV_COMMAND: "WRITE", IV_TYPE: "XYZ", IV_NAME: "ZCL_OSD_EDIT", IV_SOURCE: "x"},
  // a new object, and a name that tries to leave its folder
  {IV_COMMAND: "WRITE", IV_TYPE: "PROG", IV_NAME: "ZOSD_STORECMP_NEW", IV_SOURCE: "REPORT zosd_storecmp_new.\n"},
  {IV_COMMAND: "LIST", IV_FILTER: "ZOSD_STORECMP"},
  {IV_COMMAND: "READ", IV_TYPE: "PROG", IV_NAME: "ZOSD_STORECMP_NEW"},
  {IV_COMMAND: "WRITE", IV_TYPE: "PROG", IV_NAME: "../../ZOSD_ESCAPE", IV_SOURCE: "REPORT x.\n"},
  {IV_COMMAND: "WRITE", IV_TYPE: "PROG", IV_NAME: "ZST_PROG", IV_SOURCE: "* changed\r\nREPORT zst_prog.\n"},
  {IV_COMMAND: "READ", IV_TYPE: "PROG", IV_NAME: "ZST_PROG"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "CL_ST_LIB", IV_SOURCE: "x"},
  {IV_COMMAND: "WRITE", IV_TYPE: "CLAS", IV_NAME: "ZCL_ST_GEN", IV_SOURCE: "x"},
  {IV_COMMAND: "WRITE", IV_TYPE: "PROG", IV_NAME: "ZST_NEW", IV_SOURCE: "REPORT zst_new."},
  {IV_COMMAND: "NOPE"},
  {IV_COMMAND: "CHECK", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT", IV_SOURCE: "CLASS x."},
  {IV_COMMAND: "ACTIVATE", IV_TYPE: "CLAS", IV_NAME: "ZCL_OSD_EDIT"},
];
const nodeTree = scratch("node");
const goTree = scratch("go");
const nodeAdapterTree = scratch("node-rfc");
const goAdapterTree = scratch("go-rfc");
const nodeWriter = new StoreDestination({store: () => new ObjectStore({root: nodeTree})});
const nodeAdapterWriter = new StoreDestination({store: () => new ObjectStore({root: nodeAdapterTree})});
const nodeWrites = [];
const nodeAdapterWrites = [];
for (const call of writes) {
  // CHECK and ACTIVATE are the compiler's on Node: not compared, only run on Go
  if (call.IV_COMMAND === "CHECK" || call.IV_COMMAND === "ACTIVATE") { nodeWrites.push(undefined); continue; }
  nodeWrites.push(await nodeCall(nodeWriter, call));
}
for (const call of writes) {
  if (call.IV_COMMAND === "CHECK" || call.IV_COMMAND === "ACTIVATE") { nodeAdapterWrites.push(undefined); continue; }
  nodeAdapterWrites.push(await nodeAdapterCall(nodeAdapterWriter, call));
}
const goWrites = goCalls(goTree, config, writes);
const goAdapterWrites = goCalls(goAdapterTree, config, writes.map(adapterInput), adapterSignature);
// the files the writes wrote, as the Node store named them
const touched = new Set(nodeWrites.filter((a, i) => a !== undefined && writes[i].IV_COMMAND === "WRITE" && a.scalars.EV_ERROR === "")
  .map((a) => a.scalars.EV_FILE));
let wsame = 0;
let adapterWsame = 0;
const comparableWrites = writes.filter((write) => write.IV_COMMAND !== "CHECK" && write.IV_COMMAND !== "ACTIVATE").length;
for (let i = 0; i < writes.length; i += 1) {
  const label = `write #${i} ${JSON.stringify(writes[i]).slice(0, 120)}`;
  if (nodeWrites[i] === undefined) {
    console.log(`go only #${i} ${writes[i].IV_COMMAND}: ${goWrites[i].scalars.EV_ERROR} | issues ${goWrites[i].issues.length}`);
    console.log(`go only adapter #${i} ${writes[i].IV_COMMAND}: ${goAdapterWrites[i].scalars.EV_ERROR}`);
    continue;
  }
  if (compare(label, nodeWrites[i], goWrites[i], touched)) wsame += 1;
  if (compareAdapter(label, nodeAdapterWrites[i], goAdapterWrites[i], writes[i], touched)) adapterWsame += 1;
}
console.log(`execute writes: ${wsame} of ${comparableWrites} answers the same`);
console.log(`adapter writes: ${adapterWsame} of ${comparableWrites} answers the same`);
// the files the writes left behind, byte for byte
for (const file of [...touched, "../ZOSD_ESCAPE", "src/osd/..#..#zosd_escape.prog.abap"]) {
  const n = existsSync(join(nodeTree, file)) ? readFileSync(join(nodeTree, file)) : undefined;
  const g = existsSync(join(goTree, file)) ? readFileSync(join(goTree, file)) : undefined;
  const ok = (n === undefined && g === undefined) || (n !== undefined && g !== undefined && Buffer.compare(n, g) === 0);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} file ${file}: ${n === undefined ? "absent" : `${n.length} bytes`} / ${g === undefined ? "absent" : `${g.length} bytes`}`);
}

// CHECK and OUTLINE compare every exporting field and table, including the
// byte-exact EV_JSON. The adapter's existing expected gaps remain ratcheted.
const compilerTree = await buildFixture();
try {
  await prepareCompilerFixture(compilerTree);
  const launcher = join(compilerTree,"osd");
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(tools,"bin/osd.mjs"))} "$@"\n`,{mode:0o700});
  const facts = await storeConfig(compilerTree,{storeModule:`${tools}/tools/osd-store.mjs`});
  const calls = compilerCases.map(([,call])=>call);
  const nodeAnswers = await compilerAnswers(compilerTree);
  const goAnswers = goCalls(compilerTree,facts,calls,null,launcher);
  for (let i=0;i<calls.length;i++) {
    const [name]=compilerCases[i];
    const answer=nodeAnswers[name];
    compare(name,{scalars:Object.fromEntries(Object.entries(answer).filter(([k])=>k.startsWith("EV_"))),objects:answer.ET_OBJECT,issues:answer.ET_ISSUE,types:answer.ET_TYPE,revisions:answer.ET_REVISION},goAnswers[i]);
  }
  // Exercise the RFC adapter with a complete caller signature. The generated
  // front's IV_JSON/EV_JSON omissions remain separately ratcheted above.
  const compilerTables = {...ADT_TABLES, ...Object.fromEntries(["ISSUE", "TYPE"].map(kind => ["ET_"+kind,
    [...readFileSync(join(tools, `src/webgui/zosd_${kind.toLowerCase()}_s.tabl.xml`), "utf8").matchAll(/<FIELDNAME>([^<]+)<\/FIELDNAME>/g)].map(m => m[1].toLowerCase())]))};
  const compilerScalars = Object.keys(nodeAnswers[compilerCases[0][0]]).filter(key => key.startsWith("EV_"));
  const compilerSignature = {inputs:Object.fromEntries(calls.flatMap(call => Object.keys(call)).map(key => [key,true])),
    imports:Object.fromEntries(compilerScalars.map(key => [key,true])),
    tables:Object.fromEntries(Object.keys(compilerTables).map(key => [key,true])),
    tableFields:Object.fromEntries(Object.entries(compilerTables).map(([key, fields]) => [key,fields.map(field => field.toUpperCase())]))};
  const goCompilerAdapter = goCalls(compilerTree,facts,calls,compilerSignature,launcher);
  for (let i=0;i<calls.length;i++) {
    const node = await nodeAdapterCall(new StoreDestination({store:new ObjectStore({root:compilerTree})}),calls[i],compilerTables,compilerScalars);
    compare(`compiler adapter ${compilerCases[i][0]}`,node,goCompilerAdapter[i]);
  }
  console.log(`compiler adapter: ${calls.length} CHECK and OUTLINE answers compared with complete RFC caller signature`);
  const gapCalls = compilerGapCases.map(([,call])=>call);
  const nodeGapAnswers = await Promise.all(gapCalls.map(call => {
    const destination = new StoreDestination({store:new ObjectStore({root:compilerTree})});
    return destination.execute(call);
  }));
  const goGapAnswers = goCalls(compilerTree,facts,gapCalls,null,launcher);
  for (let i=0;i<gapCalls.length;i++) {
    const [name] = compilerGapCases[i];
    const node = nodeGapAnswers[i], go = goGapAnswers[i];
    if (!Array.isArray(node.ET_ISSUE) || node.ET_ISSUE.length === 0 || !go.scalars.EV_ERROR.includes("UNSUPPORTED_OP: CHECK with IV_SOURCE")) {
      bad++;console.log(`FAIL compiler gap ${name}: node issues ${node.ET_ISSUE?.length ?? "none"}, go ${go.scalars.EV_ERROR || "(none)"}`);
    } else {
      console.log(`compiler gap (ratcheted): ${name}`);
    }
  }
  const absentCalls = [calls[0], ...compilerCases.filter(([name]) => name.startsWith("outline-")).map(([, call]) => call),
    {IV_COMMAND:"CHECK", IV_TYPE:"CLAS", IV_NAME:"ZMISSING"},
    {IV_COMMAND:"CHECK", IV_TYPE:"CLAS", IV_NAME:"ZCL_VALID"}];
  const standalone = goCalls(compilerTree,facts,absentCalls);
  const absent = goCalls(compilerTree,facts,absentCalls,null,"/nonexistent/osgo-sidecar");
  for (let i=0;i<absent.length;i++) {
    if (comparable(absent[i])!==comparable(standalone[i]) || !absent[i].scalars.EV_ERROR) {
      bad++;console.log(`FAIL compiler absent #${i}: ${JSON.stringify(absent[i])}`);
    }
  }
  if (!absent[0].scalars.EV_ERROR.includes("check needs the compiler") || absent[1].scalars.EV_ERROR!=="unknown store command PARSE") {bad++;console.log("FAIL original compiler refusal text");}
  console.log(`compiler: ${calls.length} CHECK and OUTLINE answers compared with real sidecar`);
  console.log("compiler absent: original CHECK and PARSE refusals");
} finally {rmSync(compilerTree,{recursive:true,force:true});}
process.exit(bad ? 1 : 0);
