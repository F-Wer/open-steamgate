import {writeGo} from "./symbols.mjs";
// Build the two stands for the ZO4D player, one per runtime, from the same
// IR as tools/gogen/demo.mjs:
//
//   node tools/gogen/o4dserve.mjs            -> .out/o4dserve/o4dserve (Go) and .out/o4dserve/demo.mjs (JS)
//   .out/o4dserve/o4dserve -listen :3092 -upstream http://127.0.0.1:3091
//   node tools/gogen/o4dserve-js.mjs --listen 3093 --upstream http://127.0.0.1:3091
//
// Both answer the demo channel with the compiled ABAP and pass every other
// request to an OSG server, so the page and its media are that server's.
import {execFileSync} from "node:child_process";
import {copyFileSync, mkdirSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileProgram} from "./frontend.mjs";
import {emitJs} from "./emit-js.mjs";
import {home} from "./home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pack = `${home}/packs/o4d/upstream`;
const objects = ["zif_o4d_effect", ...new Set(readdirSync(pack).filter((f) => /^zcl_o4d_.*\.clas\.abap$/.test(f)).map((f) => f.split(".")[0])),
  // the APC framework of open-abap-apc, which the host library
  // (go/apc/apc.go) drives through ZCL_APC_HOST, as the Node hosts do
  "zcl_apc_host", "zcl_apc_message_manager", "zcl_apc_message", "zcl_apc_context", "zcl_apc_initial_request", "zcl_apc_binding_manager", "cx_apc_error",
  // its exception and the roots it inherits from, as semantics.mjs compiles them
  "cx_root", "cx_static_check", "cx_dynamic_check", "cx_no_check", "cl_message_helper"];
const program = compileProgram({folders: [pack, `${home}/.local/lars/open-abap-core/src`, `${home}/.local/lars/open-abap-apc/src`], objects});
const out = join(here, ".out", "o4dserve");
mkdirSync(out, {recursive: true});
writeGo(join(here, "go", "cmd", "o4dserve", "zz_generated.go"), program);
execFileSync("gofmt", ["-w", join(here, "go", "cmd", "o4dserve")]);
const tags = process.argv.includes("--libm") ? "libm" : "";
execFileSync("go", ["build", "-trimpath", `-tags=${tags}`, "-ldflags=-s -w", "-o", join(out, "o4dserve"), "./cmd/o4dserve"],
  {cwd: join(here, "go"), stdio: "inherit", env: {...process.env, CGO_ENABLED: tags ? "1" : "0"}});
writeFileSync(join(out, "demo.mjs"), emitJs(program));
copyFileSync(join(here, "js", "abap.mjs"), join(out, "abap.mjs"));
console.log(`built ${join(out, "o4dserve")} and ${join(out, "demo.mjs")} (${program.classes.length} classes, sin/cos ${tags ? "glibc" : "fdlibm"})`);
