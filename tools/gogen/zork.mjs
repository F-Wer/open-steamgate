import {writeGo} from "./symbols.mjs";
// Zork, the whole interpreter, compiled from packs/zork through the IR to Go
// and to JS, and played by its own speedrun: the story file and the script
// of the pack, the same commands on both, the logs compared line by line.
//
//   node tools/gogen/zork.mjs [speedrun|test]
//
// The script loader of the pack reads SMW0; the harness does its few lines
// (drop CR, split lines, tab to blank, CONDENSE, skip empty and # lines).
import {execFileSync} from "node:child_process";
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {compileProgram} from "./frontend.mjs";
import {emitJs} from "./emit-js.mjs";
import {home} from "./home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const which = process.argv.slice(2).find((a) => /^[a-z]+$/.test(a)) ?? "speedrun";
const story = `${home}/packs/zork/games/zork-mini-z3.w3mi.data.z3`;
const script = readFileSync(`${home}/packs/zork/games/zork-mini-${which}-txt.w3mi.data.txt`, "utf8");
const commands = script.replace(/\r/g, "").split("\n").map((l) => l.replace(/\t/g, " ").trim().replace(/ +/g, " "))
  .filter((l) => l !== "" && !l.startsWith("#"));

const objects = ["zif_ork_00_game_loader", "zif_ork_00_script_loader", "zcl_ork_00_memory", "zcl_ork_00_stack", "zcl_ork_00_text",
  "zcl_ork_00_dict", "zcl_ork_00_objects", "zcl_ork_00_zmachine", "zcl_ork_00_speedrun"];
const program = compileProgram({folders: [`${home}/packs/zork/upstream`, `${home}/.local/lars/open-abap-core/src`], objects});
if (program.skipped.length) console.log(`not compiled: ${program.skipped.join("; ")}`);
const out = join(here, ".out", "zork");
mkdirSync(out, {recursive: true});
writeFileSync(join(out, "commands.json"), JSON.stringify(commands));
writeGo(join(here, "go", "cmd", "zork", "zz_generated.go"), program);
execFileSync("gofmt", ["-w", join(here, "go", "cmd", "zork")]);
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", join(out, "zork"), "./cmd/zork"], {cwd: join(here, "go"), stdio: "inherit"});
// --seed n: both runtimes draw the same random sequence, so the whole
// transcript can be compared; without it the fights differ run to run
const seedArg = process.argv.indexOf("--seed");
const seed = seedArg < 0 ? null : Number(process.argv[seedArg + 1]);
const go = JSON.parse(execFileSync("prlimit", ["--as=4000000000", join(out, "zork"), story, join(out, "commands.json")],
  {maxBuffer: 1 << 28, timeout: 120000, env: {...process.env, ...(seed === null ? {} : {ZORK_SEED: String(seed)})}}).toString());

writeFileSync(join(out, "zork.mjs"), emitJs(program));
copyFileSync(join(here, "js", "abap.mjs"), join(out, "abap.mjs"));
const m = await import(pathToFileURL(join(out, "zork.mjs")).href);
const js = {};
try {
  const s = {sy: {index: 0, tabix: 0, subrc: 0}};
  const rt = await import(pathToFileURL(join(out, "abap.mjs")).href);
  if (seed !== null) rt.SeedRandom(seed);
  const bytes = readFileSync(story);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  const t = performance.now();
  const sr = m.ZCL_ORK_00_SPEEDRUN.$new(s, text, commands);
  js.result = sr.RUN(s);
  js.ms = performance.now() - t;
  js.log = sr.GET_LOG_AS_TEXT(s);
} catch (e) { js.error = String(e.message ?? e); }

const show = (r) => r.error ? `ERROR ${r.error}` : `${r.result.commands_run}/${r.result.commands_total} commands, assertions ${r.result.assertions_pass}/${r.result.assertions_total} pass, ${r.result.assertions_fail} fail, success=${r.result.success}, ${r.ms.toFixed(1)} ms`;
console.log(`zork ${which}: ${commands.length} commands`);
console.log(`  Go: ${show(go)}`);
console.log(`  JS: ${show(js)}`);
writeFileSync(join(out, `log-go-${which}.txt`), go.log ?? "");
writeFileSync(join(out, `log-js-${which}.txt`), js.log ?? "");
const a = (go.log ?? "").split("\n"); const b = (js.log ?? "").split("\n");
const first = a.findIndex((l, i) => l !== b[i]);
console.log(first < 0 && a.length === b.length ? `  logs equal, ${a.length} lines` : `  logs differ at line ${first + 1}: go ${JSON.stringify(a[first])} js ${JSON.stringify(b[first])}`);
