import {writeGo} from "./symbols.mjs";
// The whole ZO4D demo, compiled to Go and to JS from one IR, against the A4H
// recordings: the handler, the demo director and every effect class of the
// pack, nothing rewritten.
//
//   node tools/gogen/demo.mjs [scene ...]
//
// What runs is ABAP: ZCL_O4D_APC_HANDLER=>INIT_ALL_DEMOS and LOAD_DEMO set
// the demo up, BUILD_RENDER_CTX makes the context of a tick (beat info,
// scene switching, transitions), ZCL_O4D_DEMO=>GET_EFFECT_AT_BAR picks the
// effect, the effect renders, FRAME_TO_JSON writes the frame. The harness
// only does what the handler's 'frame' command does before those calls
// (three lines, the time of a tick and mv_frame_num) -- that command parses
// its JSON with FIND and offsets, which this compiler does not have yet --
// and it starts a fresh handler per recording, as o4d-record opens a fresh
// socket per scene. The frames the ABAP writes are compared with the
// recording number by number.
import {execFileSync} from "node:child_process";
import {copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileProgram} from "./frontend.mjs";
import {emitJs} from "./emit-js.mjs";
import {home} from "./home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pack = `${home}/packs/o4d/upstream`;
const libs = [`${home}/.local/lars/open-abap-core/src`, `${home}/.local/lars/open-abap-apc/src`];
const wantedScenes = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const recordings = readdirSync(`${home}/.local`).filter((f) => /^o4d-a4h-[a-z0-9_]+\.jsonl$/.test(f) && f !== "o4d-a4h.jsonl")
  .map((f) => ({scene: f.replace(/^o4d-a4h-|\.jsonl$/g, ""), file: `${home}/.local/${f}`}))
  .filter((r) => wantedScenes.length === 0 || wantedScenes.includes(r.scene)).sort((a, b) => a.scene.localeCompare(b.scene));

/* ------------------------------------------------------------------ compile */
const t0 = performance.now();
const objects = ["zif_o4d_effect", ...new Set(readdirSync(pack).filter((f) => /^zcl_o4d_.*\.clas\.abap$/.test(f)).map((f) => f.split(".")[0]))];
const program = compileProgram({folders: [pack, ...libs], objects});
const tFront = performance.now() - t0;
const out = join(here, ".out", "demo");
rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});
const dir = join(here, "go", "cmd", "demo");
mkdirSync(dir, {recursive: true});
writeGo(join(dir, "zz_generated.go"), program);

// the ticks of each recording: frames are consecutive ticks from the first
const runs = recordings.map((r) => ({scene: r.scene, frames: readFileSync(r.file, "utf8").trim().split("\n").map((l) => JSON.parse(l))}));
writeFileSync(join(dir, "zz_main.go"), goMain());
execFileSync("gofmt", ["-w", dir]);
const bin = join(out, "demo");
const t1 = performance.now();
// sin and cos: pure Go (a port of fdlibm, as V8 has it) unless --libm asks
// for the C library's through cgo. A4H computes them with glibc (measured
// 2026-09-23 on the seed chains of constellation and ignition); the pure
// build is the same on every platform and is a known difference
// (ANORMALIES sin-cos-libm), the glibc build is opt-in, for the oracle.
const tags = process.argv.includes("--libm") ? "libm" : "";
execFileSync("go", ["build", "-trimpath", `-tags=${tags}`, "-ldflags=-s -w", "-o", bin, "./cmd/demo"], {cwd: join(here, "go"), stdio: "inherit", env: {...process.env, CGO_ENABLED: tags.includes("libm") ? "1" : "0"}});
const tBuild = performance.now() - t1;
// one process per recording, with a hard ceiling: a loop the compiler got
// wrong grows a table without end, and on 2026-09-23 one such run took the
// whole WSL machine down (OOM at 14.7 GB). Now it fails its own scene only.
const LIMIT_BYTES = 4e9;
const goOut = {runs: runs.map((r, i) => {
  const file = join(out, `run-${i}.json`);
  writeFileSync(file, JSON.stringify([{scene: r.scene, gt: r.frames.map((f) => f.gt)}]));
  try {
    const res = execFileSync("prlimit", [`--as=${LIMIT_BYTES}`, bin, file],
      {maxBuffer: 1 << 30, timeout: 120000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"]});
    return JSON.parse(res.toString()).runs[0];
  } catch (e) {
    const why = e.signal ? `killed (${e.signal}, 120 s or ${LIMIT_BYTES / 1e9} GB)` : String(e.stderr).split("\n").find((l) => l.trim()) ?? String(e.message);
    return {scene: r.scene, error: why.slice(0, 160)};
  }
})};

/* --------------------------------------------------------------------- JS */
writeFileSync(join(out, "demo.mjs"), emitJs(program));
copyFileSync(join(here, "js", "abap.mjs"), join(out, "abap.mjs"));
const jsOut = runs.map((r, i) => {
  try {
    const res = execFileSync("node", ["--max-old-space-size=2000", join(here, "demo-js.mjs"), out, join(out, `run-${i}.json`)],
      {maxBuffer: 1 << 30, timeout: 120000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"]});
    return JSON.parse(res.toString());
  } catch (e) {
    const why = e.signal ? `killed (${e.signal}, 120 s)` : (String(e.stderr).match(/FATAL ERROR[^\n]*/) ?? [String(e.stderr).split("\n").find((l) => l.trim()) ?? String(e.message)])[0];
    return {scene: r.scene, error: why.slice(0, 160)};
  }
});

/* ------------------------------------------------------------------ compare */
const close = (a, b) => (typeof a === "number" && typeof b === "number"
  ? a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) : a === b);
function diff(a, b, path = "") {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], `${path}.*`); if (d) return d; }
    return null;
  }
  if (a && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) { const d = diff(a[k], b?.[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return close(a, b) ? null : path;
}
console.log(`\ndemo: sin/cos from ${tags.includes("libm") ? "glibc (cgo)" : "fdlibm (pure Go)"}, ${program.classes.length} classes compiled, front end ${Math.round(tFront)} ms, go build ${Math.round(tBuild)} ms, binary ${(statSync(bin).size / 1e6).toFixed(1)} MB`);
console.log(`${"scene".padEnd(18)}${"frames".padStart(7)}${"Go = A4H".padStart(10)}${"JS = A4H".padStart(10)}${"Go µs".padStart(9)}${"JS µs".padStart(9)}  first difference`);
let totals = {n: 0, go: 0, js: 0};
for (const [i, r] of runs.entries()) {
  const g = goOut.runs[i];
  const j = jsOut[i];
  let gok = 0; let jok = 0; let first = g.error ? `go: ${g.error.slice(0, 110)}` : "";
  r.frames.forEach((want, k) => {
    const dg = g.error ? "error" : diff(JSON.parse(g.frames[k]), want);
    const dj = j.error ? "error" : diff(JSON.parse(j.frames[k]), want);
    if (!dg) gok++; else first = first || `go f${k} ${dg}`;
    if (!dj) jok++; else first = first || `js f${k} ${dj}`;
  });
  totals.n += r.frames.length; totals.go += gok; totals.js += jok;
  const own = (each) => { const v = (each ?? []).filter((_, k) => r.frames[k]?.e === r.scene); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  (globalThis.ownTimes ??= []).push({scene: r.scene, frames: r.frames.filter((f) => f.e === r.scene).length, go: own(g.each), js: own(j.each)});
  console.log(`${r.scene.padEnd(18)}${String(r.frames.length).padStart(7)}${String(gok).padStart(10)}${String(jok).padStart(10)}${((g.ns ?? 0) / 1e3).toFixed(0).padStart(9)}${((j.ns ?? 0) / 1e3).toFixed(0).padStart(9)}  ${first}`);
}
if (process.argv.includes("--own")) {
  console.log("\nper frame, the scene's own frames only (e === scene), microseconds");
  for (const o of globalThis.ownTimes) console.log(`${o.scene.padEnd(18)}${String(o.frames).padStart(5)}${(o.go / 1e3).toFixed(0).padStart(9)}${(o.js / 1e3).toFixed(0).padStart(9)}`);
}
console.log(`${"all".padEnd(18)}${String(totals.n).padStart(7)}${String(totals.go).padStart(10)}${String(totals.js).padStart(10)}`);

function goMain() {
  return `// Code generated by tools/gogen/demo.mjs. DO NOT EDIT.

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"time"

	"osg/gogen/abap"
)

type run struct {
	Scene string    \`json:"scene"\`
	Gt    []float64 \`json:"gt"\`
}

type result struct {
	Scene  string   \`json:"scene"\`
	Frames []string \`json:"frames"\`
	Ns     float64  \`json:"ns"\`
	Each   []float64 \`json:"each"\`
	Error  string   \`json:"error,omitempty"\`
}

func main() {
	raw, _ := os.ReadFile(os.Args[1])
	var runs []run
	json.Unmarshal(raw, &runs)
	out := []result{}
	for _, r := range runs {
		out = append(out, one(r))
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"runs": out})
}

// one recording on a fresh handler; a method that did not compile raises,
// and the scene is reported with the reason instead of stopping the rest
func one(r run) (res result) {
	res.Scene = r.Scene
	defer func() {
		if e := recover(); e != nil {
			res.Error = fmt.Sprint(e)
		}
	}()
	{
		s := &abap.Session{Statics: abap.ProcessStatics}
		h := New_ZCL_O4D_APC_HANDLER(s)
		h.INIT_ALL_DEMOS(s)
		h.LOAD_DEMO(s, "main")
		spt := h.mo_demo.GET_SEC_PER_TICK(s)
		first := int32(math.Round(r.Gt[0] / spt))
		frames := []string{}
		t := time.Now()
		for k := range r.Gt {
			t0 := time.Now()
			frames = append(frames, frame(h, s, first+int32(k)))
			res.Each = append(res.Each, float64(time.Since(t0).Nanoseconds()))
		}
		res.Frames = frames
		res.Ns = float64(time.Since(t).Nanoseconds()) / float64(len(r.Gt))
	}
	return res
}

// the handler's 'frame' command, sub = 0, after it parsed the tick
func frame(h *ZCL_O4D_APC_HANDLER, s *abap.Session, tick int32) string {
	fpt := h.mo_demo.GET_FPT(s)
	gt := float64(tick) * h.mo_demo.GET_SEC_PER_TICK(s)
	h.mv_frame_num = tick * fpt
	ctx := h.BUILD_RENDER_CTX(s, gt)
	eff := h.mo_demo.GET_EFFECT_AT_BAR(s, ctx.gbi.bar)
	var f ZIF_O4D_EFFECT__TY_FRAME
	if eff != nil {
		f = eff.ZIF_O4D_EFFECT__RENDER_FRAME(s, &ctx)
	}
	return h.FRAME_TO_JSON(s, &f, &ctx, "")
}
`;
}
