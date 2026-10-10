import {writeGo} from "./symbols.mjs";
// CL_HTTP_CLIENT on Node and on the Go host, byte for byte (ultra/httpc).
//
//   node tools/gogen/httpc.mjs [--node] [--keep]
//
// One local server, which records every request's bytes as they arrived and
// answers each case with bytes written here. ZCL_GOGEN_T_HTTPC
// (testdata-httpc/) is one request through open-abap-core's CL_HTTP_CLIENT
// and prints what the ABAP got back. It runs twice against that server:
//
//   Node  the class and open-abap-core through @abaplint/transpiler (the one
//         OSG_HOME has), so CL_HTTP_CLIENT's kernel lines are Node's http /
//         https modules: the oracle
//   Go    the class and the same open-abap-core through frontend.mjs and
//         emit-go.mjs, the kernel lines being go/abap/httpc.go
//
// and both what the server received and what the ABAP printed must be the
// same. --node runs the Node side alone and prints it (to read what Node
// sends), --keep leaves .out/httpc-js/ for a look.
import {execFile, execFileSync} from "node:child_process";
import {mkdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {gzipSync} from "node:zlib";
import {home} from "./home.mjs";

const here = import.meta.dirname;
const core = `${home}/.local/lars/open-abap-core/src`;

/* ------------------------------------------------------------------ cases */

const crlf = (lines, body = "") => Buffer.concat([Buffer.from(lines.map((l) => `${l}\r\n`).join("") + "\r\n", "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1")]);
const ok = (body, extra = []) => crlf(["HTTP/1.1 200 OK", ...extra, `Content-Length: ${Buffer.byteLength(body)}`], body);
const zipped = gzipSync(Buffer.from("inflated by cl_abap_gzip\n"));
const NV = (pairs) => pairs.map(([name, value]) => ({name, value}));
// each case: the ABAP's input (the URL's path is below /<case>/) and the
// answers the server gives, one per request of the case in turn
const CASES = [
  {name: "get", in: {path: "/plain"}, answers: [ok("hello", ["Content-Type: text/plain"])]},
  {name: "get-query", in: {path: "/q?service=git-upload-pack&x=a%20b"}, answers: [ok("q")]},
  {name: "post-cdata", in: {path: "/p", method: "POST", ctype: "application/x-git-upload-pack-request", body: "0032want 0123456789abcdef0123456789abcdef01234567\n00000009done\n"}, answers: [ok("PACK")]},
  {name: "post-nonlatin", in: {path: "/u", method: "POST", ctype: "text/plain; charset=utf-8", body: "aé€\u{1F600}z"}, answers: [ok("u")]},
  {name: "post-xdata", in: {path: "/x", method: "POST", xbody: "00FF10E282AC"}, answers: [ok("x")]},
  {name: "post-utf8-xdata", in: {path: "/x8", method: "POST", xbody: "E282AC41"}, answers: [ok("x8")]},
  {name: "post-empty", in: {path: "/e", method: "POST"}, answers: [ok("")]},
  {name: "put", in: {path: "/put", method: "PUT", body: "put body"}, answers: [crlf(["HTTP/1.1 204 No Content"])]},
  {name: "delete", in: {path: "/d", method: "DELETE"}, answers: [ok("gone")]},
  {name: "headers", in: {path: "/h", headers: NV([["Accept", "application/json"], ["X-Custom", "one"], ["x-custom", "two"], ["accept-encoding", "identity"], ["User-Agent", "mine/1.0"]])}, answers: [ok("h")]},
  {name: "form-get", in: {path: "/f", form: NV([["a", "1"], ["B", "x y&z"], ["c", "ä"]])}, answers: [ok("f")]},
  {name: "form-post", in: {path: "/fp", method: "POST", form: NV([["a", "1"], ["b", "2 3"]])}, answers: [ok("fp")]},
  {name: "query-post", in: {path: "/qp?k=v", method: "POST"}, answers: [ok("qp")]},
  {name: "auth", in: {path: "/a", user: "developer"}, answers: [crlf(["HTTP/1.1 401 Unauthorized", "WWW-Authenticate: Basic realm=\"x\"", "Content-Length: 0"])]},
  {name: "resp-headers", in: {path: "/rh"}, answers: [crlf(["HTTP/1.1 200 OK", "Server: one", "Server: two", "X-Multi: a", "X-Multi: b", "Set-Cookie: s=1", "Set-Cookie: t=2",
    "Cookie: c=1", "Cookie: d=2", "ETag: \"e1\"", "123: numeric", "7: seven", "Content-Type: text/html", "Content-Type: text/plain", "X-Space:   padded   ", "X-Latin: café", "Content-Length: 2"], "rh")]},
  {name: "chunked", in: {path: "/c"}, answers: [crlf(["HTTP/1.1 200 OK", "Transfer-Encoding: chunked"], "3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n")]},
  {name: "gzip", in: {path: "/z"}, answers: [crlf(["HTTP/1.1 200 OK", "Content-Encoding: gzip", `Content-Length: ${zipped.length}`], zipped)]},
  {name: "status-500", in: {path: "/500"}, answers: [crlf(["HTTP/1.1 500 Internal Server Error", "Content-Length: 4"], "boom")]},
  {name: "continue", in: {path: "/100"}, answers: [Buffer.concat([crlf(["HTTP/1.1 100 Continue"]), ok("after 100")])]},
  {name: "close-delimited", in: {path: "/cd"}, answers: [crlf(["HTTP/1.1 200 OK", "Connection: close"], "until close")], close: true},
  {name: "binary-body", in: {path: "/b"}, answers: [ok(Buffer.from([0, 1, 2, 0xfe, 0xff, 0x80]))]},
  {name: "twice", in: {path: "/t", times: 2}, answers: [ok("first", ["X-Seq: 1"]), ok("second!", ["X-Seq: 2", "X-Only-Second: y"])]},
  {name: "twice-close", in: {path: "/tc", times: 2}, answers: [crlf(["HTTP/1.1 200 OK", "Connection: close", "Content-Length: 1"], "1"), ok("2")], close: true},
  {name: "lower-method", in: {path: "/lm", method: "post", body: "b"}, answers: [ok("lm")]},
  {name: "head", in: {path: "/hd", method: "HEAD"}, answers: [crlf(["HTTP/1.1 200 OK", "Content-Length: 42"])]},
  // the server closes right after its answer, without saying so, and the
  // same client sends again at once: Node reuses the socket, whose end it has
  // not yet seen (the ABAP runs on in microtasks, the socket's 'end' is a
  // later turn of the loop), and dumps with "socket hang up"; Go sees the
  // close and opens a new connection, which is what Node does when a turn
  // of its loop has passed in between, and what a system does. A choice,
  // pinned here: the second request on a second connection
  {name: "dropped", in: {path: "/dr", times: 2}, answers: [ok("1"), ok("2")], close: true,
    diverges: {go: "create:0 send:0 receive:0 status:200/ ctype: h:content-length=1 body:31 send:0 receive:0 status:200/ ctype: h:content-length=1 body:32", conns: [1, 2]}},
  {name: "header-newline", in: {path: "/hn", headers: NV([["x-bad", "a\nb"]])}, answers: []},
  {name: "header-name", in: {path: "/hname", headers: NV([["x bad", "v"]])}, answers: []},
  {name: "method-token", in: {path: "/mt", method: "GE T"}, answers: []},
  {name: "upper-http", in: {url: "HTTP://127.0.0.1:1/x"}, answers: []},
  {name: "tls-to-plain", in: {path: "/tls", tls: true}, answers: []},
  {name: "refused", in: {url: "http://127.0.0.1:1/nothing"}, answers: []},
  {name: "bad-scheme", in: {url: "ftp://127.0.0.1/x"}, answers: []},
  // what the WHATWG parser rewrites is refused on Go, not guessed: Node
  // sends /dots/b
  {name: "dots", in: {path: "/a/../b"}, answers: [ok("d")], refused: true},
  // a blank ends the path cl_http_client's constructor finds, so the rest
  // lands in the host: an invalid URL on both
  {name: "space", in: {path: "/a b"}, answers: []},
];

/* ----------------------------------------------------------------- server */

// the bytes of each request as they arrived, per case, with the connection
// they came on (numbered per case in the order the connections were opened)
function recordingServer() {
  const log = new Map();
  const next = new Map();
  let conns = 0;
  const server = createServer((sock) => {
    const id = ++conns;
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      // a TLS handshake (tls-to-plain): an answer that is not TLS, and the end
      if (buf.length === 0 && d[0] === 0x16) { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = requestEnd(buf);
        if (end < 0) return;
        const raw = buf.subarray(0, end);
        buf = buf.subarray(end);
        const target = raw.toString("latin1").split(" ")[1] ?? "";
        const name = target.split("/")[1] ?? "";
        const c = CASES.find((x) => x.name === name);
        if (!log.has(name)) log.set(name, []);
        log.get(name).push({conn: id, raw: raw.toString("hex")});
        const i = next.get(name) ?? 0;
        next.set(name, i + 1);
        const answer = c?.answers[i] ?? crlf(["HTTP/1.1 404 Not Found", "Content-Length: 0"]);
        sock.write(answer);
        if (c?.close && i === 0) sock.end();
      }
    });
    sock.on("error", () => {});
  });
  return {server, log, reset() { log.clear(); next.clear(); }};
}

// where the first request in buf ends: its head, and a body of
// Content-Length bytes or chunks up to the last one; -1 while incomplete
function requestEnd(buf) {
  const h = buf.indexOf("\r\n\r\n");
  if (h < 0) return -1;
  const head = buf.subarray(0, h).toString("latin1").toLowerCase();
  let at = h + 4;
  const len = /\r\ncontent-length:\s*(\d+)/.exec(head);
  if (len) return buf.length >= at + Number(len[1]) ? at + Number(len[1]) : -1;
  if (/\r\ntransfer-encoding:\s*chunked/.test(head)) {
    for (;;) {
      const e = buf.indexOf("\r\n", at);
      if (e < 0) return -1;
      const n = parseInt(buf.subarray(at, e).toString("latin1"), 16);
      at = e + 2 + n + 2;
      if (buf.length < at) return -1;
      if (n === 0) return at;
    }
  }
  return at;
}

/* ------------------------------------------------------------ the inputs */

function input(c, port) {
  const i = c.in;
  return {
    url: i.url ?? `${i.tls ? "https" : "http"}://127.0.0.1:${port}/${c.name}${i.path}`,
    method: i.method ?? "", ctype: i.ctype ?? "", body: i.body ?? "", xbody: i.xbody ?? "",
    headers: i.headers ?? [], form: i.form ?? [], user: i.user ?? "", times: i.times ?? 1,
  };
}

/* -------------------------------------------------------------- Node side */

async function nodeSide() {
  // the transpiler as OSG calls it (tools/osd-transpile.mjs), over a root
  // whose src is testdata-httpc and whose one library is open-abap-core
  const out = join(here, ".out", "httpc-js");
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  symlinkSync(join(here, "testdata-httpc"), join(out, "src"));
  symlinkSync(join(home, ".local", "lars", "open-abap-core"), join(out, "core"));
  symlinkSync(join(home, "node_modules"), join(out, "node_modules"));
  const {transpile} = await import(pathToFileURL(join(home, "tools", "osd-transpile.mjs")).href);
  await transpile({root: out, config: {input_folder: ["src"], output_folder: "output", libs: [{folder: "/core", exclude_filter: ["/src/tcp/"]}],
    options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "runtimeError"}}});
  const init = await import(pathToFileURL(join(out, "output", "init.mjs")).href);
  await init.initializeABAP?.();
  const abap = globalThis.abap;
  const cls = abap.Classes["ZCL_GOGEN_T_HTTPC"];
  const table = (rows) => {
    const tab = new abap.types.Table(new abap.types.Structure({name: new abap.types.String(), value: new abap.types.String()}));
    for (const r of rows) {
      const s = new abap.types.Structure({name: new abap.types.String(), value: new abap.types.String()});
      s.get().name.set(r.name);
      s.get().value.set(r.value);
      tab.append(s);
    }
    return tab;
  };
  const str = (v) => { const s = new abap.types.String(); s.set(v); return s; };
  return async (x) => {
    const xs = new abap.types.XString();
    xs.set(x.xbody);
    const n = new abap.types.Integer();
    n.set(x.times);
    try {
      const r = await cls.call({iv_url: str(x.url), iv_method: str(x.method), iv_ctype: str(x.ctype), iv_body: str(x.body), iv_xbody: xs,
        it_headers: table(x.headers), it_form: table(x.form), iv_user: str(x.user), iv_times: n});
      return r.get();
    } catch (e) {
      // an ABAP exception nobody caught, or not one: a kernel line threw
      const name = e?.constructor?.name ?? "?";
      return /^cx_/i.test(name) ? `DUMP ${name.toUpperCase()}` : `DUMP host|${e?.message ?? e}`;
    }
  };
}

/* ---------------------------------------------------------------- Go side */

async function goSide() {
  const {compileProgram} = await import("./frontend.mjs");
  const {funcName} = await import("./emit-go.mjs");
  const program = compileProgram({folders: [join(here, "testdata-httpc"), core],
    objects: ["zcl_gogen_t_httpc", "cl_http_client", "cl_http_entity", "cl_http_utility", "cl_abap_codepage", "cl_abap_conv_out_ce", "cl_abap_conv_in_ce", "cl_abap_gzip", "cx_root", "cx_static_check", "cx_dynamic_check", "cx_no_check", "cl_message_helper"]});
  // the stubs on the path of a request; the rest of the classes compiled
  // (other methods of the utility, the gzip compressor, message texts) are
  // not called
  const onPath = program.partial.filter((x) => /^(ZCL_GOGEN_T_HTTPC|CL_HTTP_CLIENT|CL_HTTP_ENTITY|CL_ABAP_CODEPAGE|CL_ABAP_CONV_OUT_CE=>(CREATE|CONVERT)|CL_HTTP_UTILITY=>IF_HTTP_UTILITY~(ESCAPE_URL|FIELDS_TO_STRING|STRING_TO_FIELDS|UNESCAPE_URL|ENCODE_BASE64)|CL_HTTP_UTILITY=>SET_QUERY|CL_ABAP_GZIP=>DECOMPRESS_BINARY_WITH_HEADER)\b/.test(x));
  console.log(`Go: ${program.classes.length} classes, ${program.partial.length} statement stubs, ${onPath.length} on the request path${onPath.length ? `:\n  ${onPath.join("\n  ")}` : ""}`);
  const dir = join(here, "go", "cmd", "httpc");
  mkdirSync(dir, {recursive: true});
  writeGo(join(dir, "zz_generated.go"), program);
  const fn = funcName("ZCL_GOGEN_T_HTTPC", "CALL");
  writeFileSync(join(dir, "main.go"), `// generated by tools/gogen/httpc.mjs: the cases on stdin, one answer each
package main

import (
\t"encoding/hex"
\t"encoding/hex"
\t"encoding/json"
\t"fmt"
\t"os"

\t"osg/gogen/abap"
)

type nv struct{ Name, Value string }
type in struct {
\tURL, Method, Ctype, Body, Xbody string
\tHeaders, Form []nv
\tUser string
\tTimes int32
}

func rows(x []nv) []IHTTPNVP {
\tout := []IHTTPNVP{}
\tfor _, r := range x {
\t\tout = append(out, IHTTPNVP{name: r.Name, value: r.Value})
\t}
\treturn out
}

func one(x in) (out string) {
\tdefer func() {
\t\tif r := recover(); r != nil {
\t\t\t// the kind of dump, then what it said (not compared)
\t\t\tswitch e := r.(type) {
\t\t\tcase abap.ArithmeticError:
\t\t\t\tout = "DUMP " + e.Class + "|" + e.Op
\t\t\tcase abap.HostError:
\t\t\t\tout = "DUMP host|" + e.Error()
\t\t\tdefault:
\t\t\t\tif x, ok := abap.AsRaised(r); ok {
\t\t\t\t\tout = "DUMP " + x.Class
\t\t\t\t} else {
\t\t\t\t\tout = fmt.Sprintf("DUMP ?|%v", r)
\t\t\t\t}
\t\t\t}
\t\t}
\t}()
\txb, err := hex.DecodeString(x.Xbody)
\tif err != nil {
\t\tpanic(err)
\t}
\th, f := rows(x.Headers), rows(x.Form)
\treturn ${fn}(&abap.Session{}, x.URL, x.Method, x.Ctype, x.Body, string(xb), &h, &f, x.User, x.Times)
}

func main() {
\tvar cases []in
\tif err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil {
\t\tpanic(err)
\t}
\tout := []string{}
\tfor _, c := range cases {
\t\tout = append(out, one(c))
\t}
\tjson.NewEncoder(os.Stdout).Encode(out)
}
`);
  execFileSync("gofmt", ["-w", dir]);
  const bin = join(here, ".out", "httpc");
  execFileSync("go", ["build", "-o", bin, "./cmd/httpc"], {cwd: join(here, "go"), env: {...process.env, GOPROXY: "off"}});
  // not execFileSync: the recording server runs in this process's event loop
  return (inputs) => new Promise((resolve, reject) => {
    const child = execFile(bin, {maxBuffer: 1 << 26}, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
    child.stdin.end(JSON.stringify(inputs.map((x) => ({URL: x.url, Method: x.method, Ctype: x.ctype, Body: x.body, Xbody: x.xbody,
    Headers: x.headers.map((h) => ({Name: h.name, Value: h.value})), Form: x.form.map((h) => ({Name: h.name, Value: h.value})), User: x.user, Times: x.times}))));
  });
}

/* ------------------------------------------------------------------- main */

const onlyNode = process.argv.includes("--node");
const rec = recordingServer();
await new Promise((r) => rec.server.listen(0, "127.0.0.1", r));
const port = rec.server.address().port;
const inputs = CASES.map((c) => input(c, port));
// the connections of a case numbered in the order they were opened
const received = () => Object.fromEntries(CASES.map((c) => {
  const reqs = rec.log.get(c.name) ?? [];
  const ids = [...new Set(reqs.map((r) => r.conn))];
  return [c.name, reqs.map((r) => ({conn: ids.indexOf(r.conn) + 1, raw: r.raw}))];
}));
try {
  const node = await nodeSide();
  const nodeOut = [];
  for (const x of inputs) nodeOut.push(await node(x));
  const nodeGot = received();
  if (onlyNode) {
    CASES.forEach((c, i) => {
      console.log(`== ${c.name}\n   ABAP: ${nodeOut[i]}`);
      for (const r of nodeGot[c.name]) console.log(`   conn ${r.conn}: ${JSON.stringify(Buffer.from(r.raw, "hex").toString("latin1"))}`);
    });
  } else {
    rec.reset();
    const go = await goSide();
    const goOut = await go(inputs);
    const goGot = received();
    let bad = 0;
    CASES.forEach((c, i) => {
      // a refused case: Go answers NOT_COMPILED and sends nothing
      const same = c.refused ? goOut[i].startsWith("DUMP NOT_COMPILED|") : c.diverges ? goOut[i] === c.diverges.go : nodeOut[i].split("|")[0] === goOut[i].split("|")[0];
      const wire = c.refused ? goGot[c.name].length === 0
        : c.diverges ? JSON.stringify(goGot[c.name].map((r) => r.conn)) === JSON.stringify(c.diverges.conns) && goGot[c.name].every((r, k) => r.raw === nodeGot[c.name][k]?.raw)
        : JSON.stringify(nodeGot[c.name]) === JSON.stringify(goGot[c.name]);
      if (!same || !wire) bad += 1;
      console.log(`${same && wire ? "ok  " : "FAIL"} ${c.name}${c.refused ? " (refused on Go)" : c.diverges ? " (Go's choice, Node dumps)" : ""}: ${goOut[i]}`);
      if (!same) console.log(`     Node: ${nodeOut[i]}`);
      if (!wire) {
        console.log(`     Node received: ${JSON.stringify(nodeGot[c.name].map((r) => [r.conn, Buffer.from(r.raw, "hex").toString("latin1")]))}`);
        console.log(`     Go received:   ${JSON.stringify(goGot[c.name].map((r) => [r.conn, Buffer.from(r.raw, "hex").toString("latin1")]))}`);
      }
    });
    const special = CASES.filter((c) => c.refused || c.diverges).length;
    console.log(`${CASES.length - bad} of ${CASES.length} cases pass: ${CASES.length - special} the same on Node and Go, on the wire and in the ABAP, ${special} refused or Go's documented choice`);
    process.exitCode = bad ? 1 : 0;
  }
} finally {
  rec.server.close();
  if (!process.argv.includes("--keep")) rmSync(join(here, ".out", "httpc-js"), {recursive: true, force: true});
}
process.exit(process.exitCode ?? 0);
