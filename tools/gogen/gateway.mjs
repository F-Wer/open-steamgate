import {writeGo} from "./symbols.mjs";
// OSG's own gateway through the Go backend: every ABAP object of src/, gen/
// and the libraries of abap_transpile.json compiled (a statement outside the
// subset raises NOT_COMPILED at its ABAP line when it runs), then the start
// of OSG (the SEGW registry) and one request through ZCL_STG_DISPATCHER.
//
//   node tools/gogen/gateway.mjs [path ...]  default: the demo service document
//
// Several paths share one compile and one go build (a minute each); the
// binary then runs once per path, each run from the seeded database, and
// each answer is printed after a "== <path>" line when there is more than one.
//
// A request as the ICF sees it (--icf, implied by --method, --header and
// --body): the Go host does what cl_express_icf_shim=>run does -- a
// CL_HTTP_SERVER with two CL_HTTP_ENTITYs, the headers, ~path, the query as
// form fields -- and calls ZCL_STG_HTTP_HANDLER, so the CSRF token, the
// dialog step's COMMIT/ROLLBACK brackets and the response headers are the
// handler's own. The answer is printed with the status, every header the
// ABAP set, and the body (text, or its length and sha256 when it is bytes).
//
//   --method M          the method of every path (a path "M /x" names its own)
//   --header 'k: v'     a request header (repeatable)
//   --body @file|text   the request body
//   --steps             every request in ONE process, in order, each its own
//                       dialog step on one database: a write and the read
//                       that sees it (without it each request starts seeded)
//   --compare <origin>  each answer next to what a running OSG answers for the
//                       same request (status, the ABAP's headers, the body)
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, statSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {compileOsg, osgDatabase} from "./osg-build.mjs";

const argv = process.argv.slice(2);
// --compare <origin>: each answer's body next to what a running OSG answers
// for the same path (one table line per path at the end)
const take = (flag, many = false) => {
  const out = [];
  for (let i = argv.indexOf(flag); i >= 0; i = argv.indexOf(flag)) out.push(argv.splice(i, 2)[1]);
  return many ? out : out.at(-1);
};
const flag = (name) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const compareWith = take("--compare");
const method = take("--method");
const headerArgs = take("--header", true);
const bodyArg = take("--body");
const steps = flag("--steps");
// --requests <file.json>: [{method, path, headers: {k: v}, body | bodyFile}]
// in place of paths, each with its own method, headers and body
const requestsFile = take("--requests");
// --other-client Prop=V1,V2: rows of another client (MANDT not the logon
// client) that OSG's reads return and a system's (and the Go host's) do not;
// dropped from OSG's JSON before the byte comparison, and said so
const otherClient = take("--other-client", true).map((x) => { const [k, v] = x.split("="); return [k, new Set(v.split(","))]; });
const icf = flag("--icf") || method !== undefined || headerArgs.length > 0 || bodyArg !== undefined || steps || requestsFile !== undefined;
const paths = argv.length > 0 ? argv : ["/sap/opu/odata/sap/ZSTG_DEMO_SRV/"];
const body = bodyArg === undefined ? "" : bodyArg.startsWith("@") ? readFileSync(bodyArg.slice(1)) : Buffer.from(bodyArg, "utf8");
const hostHeader = () => ["host", new URL(compareWith ?? process.env.GW_HOST ?? "http://localhost:3091").host];
const requests = requestsFile !== undefined ? JSON.parse(readFileSync(requestsFile, "utf8")).map((r) => ({
  method: r.method ?? "GET", path: r.path,
  headers: [hostHeader(), ...Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])],
  body: r.bodyFile !== undefined ? readFileSync(join(dirname(requestsFile), r.bodyFile)).toString("base64") : Buffer.from(r.body ?? "", "utf8").toString("base64"),
})) : paths.map((p) => {
  const m = /^([A-Z]+) (\/.*)$/.exec(p);
  const rq = {method: m ? m[1] : (method ?? "GET"), path: m ? m[2] : p, headers: []};
  // the host header a client sends; the answers' absolute URLs are built from it
  rq.headers.push(hostHeader());
  for (const h of headerArgs) {
    const i = h.indexOf(":");
    rq.headers.push([h.slice(0, i).trim().toLowerCase(), h.slice(i + 1).trim()]);
  }
  rq.body = rq.method === "GET" || rq.method === "HEAD" ? "" : body.toString("base64");
  return rq;
});
const here = import.meta.dirname;
// GW_REUSE=1: the Go of the last compile and its database again, only the
// host (main.go) rewritten -- for work on the host, not on the compiler
const reuse = ["1", "2"].includes(process.env.GW_REUSE) && existsSync(join(here, "go", "cmd", "gateway", "zz_generated.go"));
if (reuse) {
  const f = process.env.GW_REUSE === "2" ? join(here, ".out", "gateway") : join(here, "go", "cmd", "gateway", "zz_generated.go");
  console.log(`GW_REUSE=${process.env.GW_REUSE}: reusing ${f} from ${existsSync(f) ? statSync(f).mtime.toISOString() : "(missing)"}`);
}
const {program, summary} = reuse ? {program: null, summary: ""} : compileOsg();
const dir = join(here, "go", "cmd", "gateway");
mkdirSync(dir, {recursive: true});
if (!reuse) {
console.log(summary);
writeGo(join(dir, "zz_generated.go"), program);
const db = await osgDatabase(program);
writeFileSync(join(dir, "zz_db.json"), JSON.stringify(db.statements));
console.log(db.summary);
}
// GW_REUSE=2: the binary of the last build as it is (a comparison rerun)
if (process.env.GW_REUSE !== "2") {
writeFileSync(join(dir, "main.go"), `package main

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"runtime/debug"
	"net/url"
	"strings"

	"osg/gogen/abap"
)

// one request as the ICF hands it over, and what the handler answered
type icfRequest struct {
	Method  string      \`json:"method"\`
	Path    string      \`json:"path"\`
	Headers [][2]string \`json:"headers"\`
	Body    string      \`json:"body"\` // base64
}
type icfResponse struct {
	Status  int32       \`json:"status"\`
	Reason  string      \`json:"reason"\`
	Headers [][2]string \`json:"headers"\`
	Body    string      \`json:"body"\` // base64
	Dump    string      \`json:"dump,omitempty"\`
	At      string      \`json:"at,omitempty"\`
}

// what cl_express_icf_shim=>run does with an express request, line for line:
// the request entity (body, method, headers, ~request_uri, ~query_string, the
// query as form fields, ~path, ~path_info below the base), the handler, and
// the response entity read back (status 200 and text/html when unset)
func icf(s *abap.Session, rq icfRequest, base string) icfResponse {
	server := New_CL_HTTP_SERVER(s)
	req := New_CL_HTTP_ENTITY(s)
	server.if_http_server__request = req
	body, err := base64.StdEncoding.DecodeString(rq.Body)
	if err != nil {
		panic(err)
	}
	req.IF_HTTP_ENTITY__SET_DATA(s, string(body))
	req.IF_HTTP_REQUEST__SET_METHOD(s, rq.Method)
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~request_method", rq.Method)
	for _, h := range rq.Headers {
		req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, h[0], h[1])
	}
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~request_uri", rq.Path)
	path, query, _ := strings.Cut(rq.Path, "?")
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~query_string", query)
	fields := CL_HTTP_UTILITY_IF_HTTP_UTILITY__STRING_TO_FIELDS(s, query, 0)
	req.IF_HTTP_ENTITY__SET_FORM_FIELDS(s, &fields, 0)
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~path", path)
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~path_translated_expanded", path)
	info := strings.Replace(path, base, "", 1)
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~path_info", info)
	req.IF_HTTP_ENTITY__SET_HEADER_FIELD(s, "~path_info_expanded", info)
	res := New_CL_HTTP_ENTITY(s)
	server.if_http_server__response = res
	New_ZCL_STG_HTTP_HANDLER(s).IF_HTTP_EXTENSION__HANDLE_REQUEST(s, server)
	var out icfResponse
	res.IF_HTTP_RESPONSE__GET_STATUS(s, &out.Status, &out.Reason)
	if out.Status == 0 {
		out.Status = 200
	}
	if res.IF_HTTP_ENTITY__GET_CONTENT_TYPE(s) == "" {
		res.IF_HTTP_ENTITY__SET_CONTENT_TYPE(s, "text/html")
	}
	var hs []*IHTTPNVP
	res.IF_HTTP_ENTITY__GET_HEADER_FIELDS(s, &hs)
	for _, h := range hs {
		out.Headers = append(out.Headers, [2]string{h.name, h.value})
	}
	out.Body = base64.StdEncoding.EncodeToString([]byte(res.IF_HTTP_ENTITY__GET_DATA(s, "")))
	return out
}

// every request of the file in order, each one dialog step; a dump ends its
// step (rolled back) and is reported, and the next request still runs
func icfMain(s *abap.Session, file string) {
	raw, err := os.ReadFile(file)
	if err != nil {
		panic(err)
	}
	var rqs []icfRequest
	if err := json.Unmarshal(raw, &rqs); err != nil {
		panic(err)
	}
	for _, rq := range rqs {
		var out icfResponse
		func() {
			defer func() {
				if r := recover(); r != nil {
					out = icfResponse{Dump: fmt.Sprint(r), At: abapStack(r)}
				}
			}()
			abap.DialogStep(func() {
				out = icf(s, rq, "/sap/opu/odata/sap")
			})
		}()
		line, _ := json.Marshal(out)
		fmt.Printf("RESPONSE %s\\n", line)
	}
}

// the ABAP frames of the stack, innermost first
func abapStack(r any) string {
	stack := string(debug.Stack())
	if w, ok := r.(*abap.Rethrown); ok {
		stack = w.Stack
	}
	// the frames above the (last) panic are the handlers; the origin is below it
	if i := strings.LastIndex(stack, "panic("); i > 0 {
		stack = stack[i:]
	}
	var out []string
	for _, l := range strings.Split(stack, "\\n") {
		l = strings.TrimSpace(l)
		if i := strings.Index(l, ".abap:"); i > 0 {
			if j := strings.IndexAny(l[i:], " +"); j > 0 {
				l = l[:i+j]
			}
			out = append(out, l[strings.LastIndex(l, "/")+1:])
		}
	}
	if len(out) > 8 {
		out = out[:8]
	}
	return strings.Join(out, " <- ")
}

//go:embed zz_db.json
var dbScript []byte

func main() {
	s := &abap.Session{Statics: abap.ProcessStatics}
	defer func() {
		if r := recover(); r != nil {
			fmt.Println("DUMP", r)
			fmt.Println("  at", abapStack(r))
			os.Exit(1)
		}
	}()
	if err := abap.OpenDB(dbScript); err != nil {
		fmt.Println("DATABASE", err)
		os.Exit(1)
	}
	ZCL_STG_SEGW_REGISTRY_REGISTER(s)
	// the search helps of src/ as providers, as test/start.mjs does
	ZCL_STG_SHLP_REGISTRY_REGISTER(s)
	if os.Args[1] == "--requests" {
		icfMain(s, os.Args[2])
		return
	}
	// what the ICF handler does before dispatch: ~path without the query,
	// the query as form fields, decoded; the host as the outside sees it
	path, query, _ := strings.Cut(os.Args[1], "?")
	opts := []*IHTTPNVP{}
	for _, kv := range strings.Split(query, "&") {
		if kv == "" {
			continue
		}
		k, v, _ := strings.Cut(kv, "=")
		k, _ = url.QueryUnescape(k)
		v, _ = url.QueryUnescape(v)
		opts = append(opts, &IHTTPNVP{name: k, value: v})
	}
	// one dialog step: its database LUW is committed when it ends and rolled
	// back when it dumps (abap.DialogStep, the kernel's rule)
	var res ZCL_STG_DISPATCHER__TY_RESPONSE
	abap.DialogStep(func() {
		res = ZCL_STG_DISPATCHER_DISPATCH(s, "GET", path, &opts, ${JSON.stringify(process.env.GW_HOST ?? "http://localhost:3091")}, "", "", "")
	})
	fmt.Printf("%d %s\\n%s\\n%s\\n", res.status, res.reason, res.content_type, res.body)
}
`);
try { execFileSync("gofmt", ["-w", dir], {stdio: ["ignore", "pipe", "pipe"]}); } catch (e) { console.log(`gofmt: ${String(e.stderr).split("\n").slice(0, 10).join("\n")}`); process.exit(1); }
const t1 = performance.now();
try {
  execFileSync("go", ["build", "-o", join(here, ".out", "gateway"), "./cmd/gateway"], {cwd: join(here, "go"), stdio: ["ignore", "pipe", "pipe"]});
} catch (e) {
  const lines = String(e.stderr).split("\n").filter((l) => /\.(go|abap):\d/.test(l));
  console.log(`go build failed, ${lines.length} errors; first:\n${lines.slice(0, 25).join("\n")}`);
  process.exit(1);
}
console.log(`go build ${Math.round(performance.now() - t1)} ms`);
}
const table = [];
if (icf) {
  await runIcf();
  process.exit(0);
}
for (const path of paths) {
  if (paths.length > 1) console.log(`== ${path}`);
  let out;
  try {
    out = execFileSync("prlimit", ["--as=4000000000", join(here, ".out", "gateway"), path], {timeout: 60000}).toString();
  } catch (e) { out = String(e.stdout) + String(e.stderr).slice(0, 800); }
  console.log(out);
  if (compareWith === undefined) continue;
  const res = await fetch(compareWith + path);
  const osg = await res.text();
  const m = /^(\d{3}) [^\n]*\n[^\n]*\n([\s\S]*)\n$/.exec(out);
  let verdict;
  if (m === null) verdict = out.split("\n")[0].slice(0, 160);
  else if (Number(m[1]) !== res.status) verdict = `status ${m[1]}, OSG ${res.status}`;
  else if (m[2] === osg) verdict = `equal (${osg.length} bytes)`;
  else {
    let i = 0;
    while (i < osg.length && m[2][i] === osg[i]) i += 1;
    verdict = `differs at byte ${i}: Go ${JSON.stringify(m[2].slice(i, i + 40))} OSG ${JSON.stringify(osg.slice(i, i + 40))}`;
  }
  table.push(`${path}\t${verdict}`);
}
if (table.length) console.log(`compared with ${compareWith}:\n${table.join("\n")}`);

/* ------------------------------------------------------------ the ICF mode */

function isText(ct) { return /^(application\/(json|xml|atom\+xml|atomsvc\+xml)|text\/|multipart\/|application\/http)/i.test(ct); }
function show(r) {
  if (r.dump) return `DUMP ${r.dump}\n  at ${r.at}`;
  const bytes = Buffer.from(r.body, "base64");
  const ct = r.headers.find(([k]) => k === "content-type")?.[1] ?? "";
  const text = isText(ct) ? bytes.toString("utf8") : `<${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}>`;
  return [`${r.status} ${r.reason}`, ...r.headers.map(([k, v]) => `${k}: ${v}`), "", text].join("\n");
}

async function osgAnswer(rq) {
  const headers = Object.fromEntries(rq.headers.filter(([k]) => k !== "host"));
  const res = await fetch(compareWith + rq.path, {method: rq.method, headers, body: rq.body === "" ? undefined : Buffer.from(rq.body, "base64")});
  return {status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer())};
}

// status, every header the ABAP set (OSG's HTTP layers add more: date, etag,
// content-length, x-powered-by), and the body byte for byte
function verdict(r, o, method) {
  // the headers OSG's HTTP layers add, not the ABAP
  const hostLayer = new Set(["date", "content-length", "connection", "keep-alive", "etag", "x-powered-by", "x-osd-generation"]);
  if (r.dump) return `Go dumped: ${r.dump.slice(0, 200)}`;
  const diffs = [];
  const notes = [];
  if (r.status !== o.status) diffs.push(`status ${r.status}, OSG ${o.status}`);
  for (const [k, v] of r.headers) {
    const ov = o.headers.get(k);
    // express's res.set adds the charset the mime table has for a type: the
    // host's HTTP layer, not the ABAP's answer
    if (k === "content-type" && ov === `${v}; charset=utf-8`) notes.push("express adds '; charset=utf-8' to content-type");
    else if (ov !== v && counters(ov ?? "") === counters(v)) notes.push(`header ${k} equal apart from the $batch counter`);
    else if (ov !== v) diffs.push(`header ${k}: Go ${JSON.stringify(v)} OSG ${JSON.stringify(ov)}`);
  }
  // and the other way: a header OSG's ABAP set that the Go host left out;
  // the ones OSG's HTTP layers add are skipped by name
  const goNames = new Set(r.headers.map(([k]) => k));
  for (const [k, ov] of o.headers) {
    if (hostLayer.has(k) || goNames.has(k)) continue;
    diffs.push(`header ${k}: Go (none) OSG ${JSON.stringify(ov)}`);
  }
  let g = Buffer.from(r.body, "base64");
  // HTTP sends no body for HEAD; what the ABAP wrote is not compared
  if (method === "HEAD") { notes.push(`HEAD: the ABAP's ${g.length}-byte body is not sent`); g = o.body; }
  // the response boundaries of $batch carry a counter of the process
  // (zcl_stg_batch=>gv_counter): OSG's has served other batches before; and
  // OSG's reads return rows of another client (--other-client)
  if (!g.equals(o.body) && method !== "HEAD") {
    let osg = o.body.toString("utf8");
    const go = g.toString("utf8");
    const before = [];
    if (otherClient.length) {
      const x = dropOtherClient(osg);
      if (x.dropped > 0) { osg = x.text; before.push(`${x.dropped} row(s) of another client in OSG's answer`); }
    }
    if (counters(osg) !== osg || counters(go) !== go) {
      if (counters(osg) === counters(go) && osg !== go) before.push("the $batch boundary counter");
      osg = counters(osg);
      if (counters(go) === osg) osg = go;
    }
    if (osg === go && before.length) { notes.push(`equal apart from ${before.join(" and ")}`); g = o.body; }
  }
  if (!g.equals(o.body)) {
    let i = 0;
    while (i < g.length && i < o.body.length && g[i] === o.body[i]) i += 1;
    diffs.push(`body differs at byte ${i} (Go ${g.length}, OSG ${o.body.length} bytes): Go ${JSON.stringify(g.subarray(i, i + 60).toString("latin1"))} OSG ${JSON.stringify(o.body.subarray(i, i + 60).toString("latin1"))}`);
  }
  return diffs.length ? diffs.join("; ") : `equal (status ${r.status}, ${r.headers.length} headers, ${g.length} bytes)${notes.length ? `; ${notes.join("; ")}` : ""}`;
}

async function runIcf() {
  const groups = steps ? [requests] : requests.map((r) => [r]);
  let n = 0;
  for (const group of groups) {
    const file = join(here, ".out", `requests-${n}.json`);
    writeFileSync(file, JSON.stringify(group));
    n += 1;
    let out;
    try {
      out = execFileSync("prlimit", ["--as=4000000000", join(here, ".out", "gateway"), "--requests", file], {timeout: 120000, maxBuffer: 1 << 28}).toString();
    } catch (e) { out = String(e.stdout) + String(e.stderr).slice(0, 2000); }
    const answers = out.split("\n").filter((l) => l.startsWith("RESPONSE ")).map((l) => JSON.parse(l.slice(9)));
    if (answers.length !== group.length) console.log(out.slice(0, 4000));
    for (let i = 0; i < answers.length; i += 1) {
      const rq = group[i];
      console.log(`== ${rq.method} ${rq.path}\n${show(answers[i])}\n`);
      if (compareWith !== undefined) table.push(`${rq.method} ${rq.path}\t${verdict(answers[i], await osgAnswer(rq), rq.method)}`);
    }
  }
  if (table.length) console.log(`compared with ${compareWith}:\n${table.join("\n")}`);
}

function counters(text) { return text.replace(/(batchresponse|changesetresponse)_stg_\d+/g, "$1_stg_N"); }

// OSG's JSON without the rows of another client: each {"d":...} document (the
// whole body, or a line of a $batch part) re-serialized with those results
// left out, __count lowered, and the part's Content-Length fixed
function dropOtherClient(text) {
  let dropped = 0;
  const doc = (json) => {
    let d;
    try { d = JSON.parse(json); } catch { return json; }
    if (JSON.stringify(d) !== json || !Array.isArray(d?.d?.results)) return json;
    const keep = d.d.results.filter((r) => !otherClient.some(([k, vs]) => vs.has(String(r[k]))));
    const n = d.d.results.length - keep.length;
    if (n === 0) return json;
    dropped += n;
    d.d.results = keep;
    if (d.d.__count !== undefined) d.d.__count = String(Number(d.d.__count) - n);
    return JSON.stringify(d);
  };
  if (text.startsWith('{"d":')) return {text: doc(text), dropped};
  const lines = text.split("\r\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('{"d":')) continue;
    const before = lines[i];
    lines[i] = doc(before);
    if (lines[i] === before) continue;
    for (let j = i - 1; j >= 0 && !lines[j].startsWith("--"); j -= 1) {
      if (/^Content-Length: \d+$/i.test(lines[j])) lines[j] = lines[j].replace(/\d+$/, String(Buffer.byteLength(lines[i], "utf8")));
    }
  }
  return {text: lines.join("\r\n"), dropped};
}
