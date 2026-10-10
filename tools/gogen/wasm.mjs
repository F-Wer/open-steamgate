import {writeGo} from "./symbols.mjs";
// A scene of ZO4D in a browser three ways, measured with one instrument:
// the scene compiled by gogen to Go and built for GOOS=js GOARCH=wasm, the
// same IR emitted as JS, and the transpiler's JS. Headless Chromium through
// Playwright, one runtime at a time, each in a fresh context.
//
//   node tools/gogen/wasm.mjs [plasma glitch] [--frames 1024] [--warmup 256] [--no-browser]
//
// The page is wasm-page.mjs; the files it loads are served from .out/wasm
// by page.route on http://localhost:4719 (intercepted, nothing listens),
// with COOP/COEP, so the page is cross-origin isolated (localhost is a
// secure context) and performance.now() is coarsened to 5 µs, not 100 µs.
import {execFileSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {brotliCompressSync, constants, gzipSync} from "node:zlib";
import {compileProgram} from "./frontend.mjs";
import {emitJs} from "./emit-js.mjs";
import {home} from "./home.mjs";
import {SCENES} from "./scene-defs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const valued = new Set(["frames", "warmup"]);
const scenes = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]?.slice(2)));
if (!scenes.length) scenes.push("plasma", "glitch");
const frames = Number(flag("frames", 1024));
const warmup = Number(flag("warmup", 256));
const pack = existsSync(resolve(root, "packs/o4d/upstream")) ? resolve(root, "packs/o4d/upstream") : resolve(`${home}/packs/o4d/upstream`);
const require = createRequire(join(root, "package.json"));
const bun = [process.env.BUN, `${process.env.HOME}/.bun/bin/bun`, "bun"].find((b) => b && (b === "bun" || existsSync(b)));

const out = join(here, ".out", "wasm");
rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});
const gz = (b) => gzipSync(b, {level: 9}).length;
const br = (b) => brotliCompressSync(b, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}).length;
const sizes = [];
const size = (what, file) => {
  const b = readFileSync(file);
  sizes.push({what, raw: b.length, gzip: gz(b), brotli: br(b)});
};

const goroot = execFileSync("go", ["env", "GOROOT"]).toString().trim();
const wasmExec = [join(goroot, "lib", "wasm", "wasm_exec.js"), join(goroot, "misc", "wasm", "wasm_exec.js")].find(existsSync);
copyFileSync(wasmExec, join(out, "wasm_exec.js"));
copyFileSync(join(here, "scene-defs.mjs"), join(out, "scene-defs.mjs"));
copyFileSync(join(here, "wasm-page.mjs"), join(out, "wasm-page.mjs"));
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>gogen wasm</title><script type="module" src="wasm-page.mjs"></script>\n`);

for (const scene of scenes) {
  const sc = SCENES[scene];
  if (!sc?.goCtx) throw new Error(`no wasm entry for scene ${scene} (known: ${Object.keys(SCENES).join(", ")})`);
  const recording = `${home}/.local/o4d-a4h-${scene}.jsonl`;
  const recs = readFileSync(recording, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((f) => f.e === scene);
  writeFileSync(join(out, `${scene}-ctx.json`), JSON.stringify(recs.map((r) => ({t: r.t, gt: r.gt}))));

  /* ------------------------------------------------------------ Go -> wasm */
  const objects = ["zif_o4d_effect", sc.cls.toLowerCase()];
  const program = compileProgram({folders: [pack], objects});
  const dir = join(here, "go", "cmd", "scenewasm");
  mkdirSync(dir, {recursive: true});
  // the tag keeps the command out of a native `go build ./...`
  const go = writeGo(join(dir, "zz_generated.go"), program);
  writeFileSync(join(dir, "zz_generated.go"), `//go:build js && wasm\n\n${go}`);
  writeFileSync(join(dir, "zz_main.go"), wasmMain(sc));
  execFileSync("gofmt", ["-w", dir]);
  const env = {...process.env, GOOS: "js", GOARCH: "wasm"};
  const t1 = performance.now();
  execFileSync("go", ["build", "-trimpath", "-o", join(out, `${scene}-full.wasm`), "./cmd/scenewasm"], {cwd: join(here, "go"), env, stdio: "inherit"});
  const tBuild = performance.now() - t1;
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", join(out, `${scene}.wasm`), "./cmd/scenewasm"], {cwd: join(here, "go"), env, stdio: "inherit"});
  size(`${scene}: Go wasm`, join(out, `${scene}-full.wasm`));
  size(`${scene}: Go wasm, -ldflags="-s -w"`, join(out, `${scene}.wasm`));
  console.log(`${scene}: go build (js/wasm) ${Math.round(tBuild)} ms`);

  /* ----------------------------------------------------- the IR, as JS */
  const irDir = join(out, `${scene}-ir-src`);
  mkdirSync(irDir);
  writeFileSync(join(irDir, "scene.mjs"), emitJs(program));
  copyFileSync(join(here, "js", "abap.mjs"), join(irDir, "abap.mjs"));
  bundle(join(irDir, "scene.mjs"), join(out, `${scene}-ir.js`));
  size(`${scene}: JS from the IR (bundle)`, join(out, `${scene}-ir.js`));

  /* -------------------------------------------------- the transpiler's JS */
  const {Transpiler} = require("@abaplint/transpiler");
  const files = readdirSync(pack).filter((f) => objects.includes(f.split(".")[0])).sort()
    .map((f) => ({filename: f, contents: readFileSync(join(pack, f), "utf8")}));
  const tr = await new Transpiler({unknownTypes: "runtimeError"}).runRaw(files);
  const trDir = join(out, `${scene}-tr-src`);
  mkdirSync(trDir);
  for (const o of tr.objects) writeFileSync(join(trDir, o.filename), o.chunk.getCode());
  writeFileSync(join(trDir, "init.mjs"), tr.initializationScript);
  bundle(join(trDir, "init.mjs"), join(out, `${scene}-tr.js`));
  size(`${scene}: transpiler JS + @abaplint/runtime (bundle)`, join(out, `${scene}-tr.js`));
}
size("wasm_exec.js (Go's loader)", join(out, "wasm_exec.js"));

console.log("\nsizes (bytes; gzip -9, brotli q11; JS bundles minified whitespace+syntax, names kept)");
for (const s of sizes) console.log(`  ${s.what.padEnd(58)} ${String(s.raw).padStart(9)} ${String(s.gzip).padStart(9)} ${String(s.brotli).padStart(9)}`);

const results = [];
if (!args.includes("--no-browser")) {
  const {chromium} = require("@playwright/test");
  const browser = await chromium.launch({headless: true});
  const types = {".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm"};
  for (const scene of scenes) {
    for (const rt of ["go", "ir", "tr"]) {
      const context = await browser.newContext();
      await context.route("http://localhost:4719/**", (route) => {
        const path = new URL(route.request().url()).pathname.slice(1) || "index.html";
        const file = join(out, path);
        if (!existsSync(file)) return route.fulfill({status: 404, body: path});
        return route.fulfill({status: 200, body: readFileSync(file),
          headers: {"content-type": types[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream",
            "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp"}});
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log(`  [${rt}] ${e.message}`));
      await page.goto(`http://localhost:4719/index.html?rt=${rt}&scene=${scene}&warmup=${warmup}&frames=${frames}`);
      await page.waitForFunction(() => globalThis.__result, null, {timeout: 600000, polling: 200});
      const r = await page.evaluate(() => globalThis.__result);
      await context.close();
      if (r.error) throw new Error(`${scene}/${rt}: ${r.error}`);
      results.push(r);
      console.log(`  ${scene} ${rt} done`);
    }
  }
  const version = browser.version();
  await browser.close();
  console.log(`\nChromium ${version} headless, cross-origin isolated: ${results.every((r) => r.isolated)}; ${warmup} frames warm-up, ${frames} frames timed one by one`);
  const names = {go: "Go -> wasm", ir: "JS from the IR", tr: "transpiler JS"};
  console.log(`${"scene".padEnd(8)}${"runtime".padEnd(16)}${"median ms".padStart(10)}${"p90 ms".padStart(9)}${"fps".padStart(8)}${"startup ms".padStart(12)}${"(load".padStart(8)}${"+ 1st)".padStart(8)}  frame 0   sweep of ${"n"}`);
  for (const r of results) {
    console.log(`${r.scene.padEnd(8)}${names[r.rt].padEnd(16)}${r.medianMs.toFixed(3).padStart(10)}${r.p90Ms.toFixed(3).padStart(9)}${String(Math.round(1000 / r.medianMs)).padStart(8)}${r.startupMs.toFixed(1).padStart(12)}${r.loadMs.toFixed(1).padStart(8)}${r.firstFrameMs.toFixed(1).padStart(8)}  ${r.frame0}  ${r.sweep} (${r.n})`);
  }
  for (const scene of scenes) {
    const rs = results.filter((r) => r.scene === scene);
    const go = rs.find((r) => r.rt === "go");
    for (const r of rs) {
      const bad = r.sums.map((x, i) => (x === go.sums[i] ? -1 : i)).filter((i) => i >= 0);
      r.equalToGo = r.n - bad.length;
      console.log(`${scene} ${names[r.rt]}: ${r.equalToGo} of ${r.n} frame checksums equal to Go's${bad.length ? `, differing: ${bad.join(" ")}` : ""}`);
    }
  }
}
writeFileSync(join(out, "report.json"), JSON.stringify({sizes, results}, null, 1));

function bundle(entry, file) {
  execFileSync(bun, ["build", entry, "--target=browser", "--format=esm", "--minify-whitespace", "--minify-syntax", `--outfile=${file}`],
    {cwd: root, stdio: ["ignore", "ignore", "inherit"]});
  if (!statSync(file).size) throw new Error(`empty bundle ${file}`);
}

function wasmMain(sc) {
  return `//go:build js && wasm

// Code generated by tools/gogen/wasm.mjs. DO NOT EDIT.

package main

import (
	"encoding/binary"
	"math"
	"syscall/js"

	"osg/gogen/abap"
)

func fnv(h uint32, b []byte) uint32 {
	for _, c := range b {
		h ^= uint32(c)
		h *= 16777619
	}
	return h
}

func num(h uint32, f float64) uint32 {
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], math.Float64bits(f))
	return fnv(h, b[:])
}

func str(h uint32, s string) uint32 { return fnv(fnv(h, []byte(s)), []byte{0xff}) }

func cnt(h uint32, n int) uint32 {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], uint32(n))
	return fnv(h, b[:])
}

// checksum is wasm-page.mjs's, over the fields scenes.mjs compares with A4H
func checksum(f *ZIF_O4D_EFFECT__TY_FRAME) uint32 {
	h := uint32(2166136261)
	h = cnt(h, len(f.lines))
	for _, l := range f.lines {
		h = str(num(num(num(num(h, l.x1), l.y1), l.x2), l.y2), l.color)
	}
	h = cnt(h, len(f.rects))
	for _, r := range f.rects {
		h = str(num(num(num(num(h, r.x), r.y), r.w), r.h), r.fill)
	}
	h = cnt(h, len(f.texts))
	for _, t := range f.texts {
		h = num(str(str(num(num(h, t.x), t.y), t.text), t.color), t.size)
	}
	return h
}

func main() {
	obj := &${sc.cls}{}
	s := &abap.Session{Statics: abap.ProcessStatics}
	${sc.init ?? ""}
	var last ZIF_O4D_EFFECT__TY_FRAME
	// renderFrame(t, gt, pos16): the context fields the scene reads, all
	// from the page; the frame stays here, checksum() reduces it
	render := js.FuncOf(func(this js.Value, a []js.Value) any {
		t, gt, pos16 := a[0].Float(), a[1].Float(), a[2].Int()
		_, _, _ = t, gt, pos16
		c := ${sc.goCtx}
		last = obj.ZIF_O4D_EFFECT__RENDER_FRAME(s, &c)
		return nil
	})
	sum := js.FuncOf(func(this js.Value, a []js.Value) any { return checksum(&last) })
	js.Global().Set("goScene", js.ValueOf(map[string]any{"renderFrame": render, "checksum": sum}))
	select {}
}
`;
}
