import {writeGo} from "./symbols.mjs";
// A scene of the ZO4D demo, compiled to Go and checked against a recording
// taken on A4H (docs/frame-comparison.md): the recording is the oracle.
//
//   node tools/gogen/scenes.mjs glitch [--recording .local/o4d-a4h-glitch.jsonl] [--repeat 20]
//
// The scene's render_frame gets the context the recording carries (t, and
// the beat position where a scene reads it), the frame comes back as JSON in
// the recording's own compact shape, and the two are compared number by
// number within a relative 1e-9 -- the same tolerance o4d-record uses,
// because the two sides print floats with 17 and 15 digits.
import {execFileSync} from "node:child_process";
import {mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {compileProgram} from "./frontend.mjs";
import {funcName} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";
import {home} from "./home.mjs";
import {SCENES} from "./scene-defs.mjs";
import {copyFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const scene = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "glitch";
const upstream = flag("upstream", resolve(root, "..", "..", "..", "packs", "o4d", "upstream"));
const pack = existsSync(upstream) ? upstream : resolve(`${home}/packs/o4d/upstream`);
const recording = flag("recording", `${home}/.local/o4d-a4h-${scene}.jsonl`);
const repeat = Number(flag("repeat", 20));

const sc = SCENES[scene];
if (!sc) throw new Error(`no scene ${scene} (known: ${Object.keys(SCENES).join(", ")})`);

const out = join(here, ".out", "scene");
rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});

/* ------------------------------------------------------------------ compile */
const t0 = performance.now();
const program = compileProgram({folders: [pack], objects: ["zif_o4d_effect", sc.cls.toLowerCase()]});
const cls = program.classes.find((c) => c.name === sc.cls);
const render = cls.methods.find((m) => m.name === "ZIF_O4D_EFFECT~RENDER_FRAME");
if (program.skipped.length) console.log(`skipped:\n  ${program.skipped.join("\n  ")}`);
if (!render) throw new Error("render_frame did not compile");
const dir = join(here, "go", "cmd", "scene");
mkdirSync(dir, {recursive: true});
writeGo(join(dir, "zz_generated.go"), program);
// a recording runs on past the end of its scene into the next one; only the
// frames the scene itself drew are its oracle
const frames = readFileSync(recording, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((f) => f.e === scene);
writeFileSync(join(dir, "zz_main.go"), sceneMain(sc, frames));
execFileSync("gofmt", ["-w", dir]);
const tFront = performance.now() - t0;
const bin = join(out, scene);
const t1 = performance.now();
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", bin, "./cmd/scene"], {cwd: join(here, "go"), stdio: "inherit"});
const tBuild = performance.now() - t1;

/* ---------------------------------------------------------------------- run */
const result = JSON.parse(execFileSync(bin, [String(repeat)], {maxBuffer: 1 << 30}).toString());

/* ------------------------------------------------------------------ compare */
const close = (a, b) => (typeof a === "number" && typeof b === "number"
  ? a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b))
  : a === b);
const KEYS = {l: ["x1", "y1", "x2", "y2", "c"], r: ["x", "y", "w", "h", "f"], tx: ["x", "y", "t", "c", "s"]};
let differing = 0;
const byPath = new Map();
let first = null;
result.frames.forEach((got, i) => {
  const want = frames[i];
  let bad = false;
  for (const [list, keys] of Object.entries(KEYS)) {
    const a = got[list] ?? [];
    const b = want[list] ?? [];
    if (a.length !== b.length) { bad = true; byPath.set(`${list}.length`, (byPath.get(`${list}.length`) ?? 0) + 1); continue; }
    a.forEach((row, j) => {
      for (const k of keys) {
        if (!close(row[k], b[j][k])) {
          bad = true;
          byPath.set(`${list}.*.${k}`, (byPath.get(`${list}.*.${k}`) ?? 0) + 1);
          first = first ?? {frame: i, t: want.t, path: `${list}.${j}.${k}`, go: row[k], a4h: b[j][k]};
        }
      }
    });
  }
  if (bad) differing += 1;
});

console.log(`\n${scene}: ${cls.name}, ${result.frames.length} frames against ${recording.split("/").pop()}`);
console.log(`front end + emit ${Math.round(tFront)} ms · go build ${Math.round(tBuild)} ms · binary ${(statSync(bin).size / 1e6).toFixed(2)} MB`);
console.log(`frames equal to A4H: ${result.frames.length - differing} of ${result.frames.length}`);
if (differing) {
  console.log(`differing paths: ${[...byPath].map(([p, n]) => `${p} x${n}`).join(", ")}`);
  console.log(`first difference: ${JSON.stringify(first)}`);
}
console.log(`Go: ${(result.nsPerFrame / 1e3).toFixed(1)} µs a frame (render_frame only, median of ${repeat} sweeps)`);

/* ------------------------------------------------- the same IR, emitted as JS */
writeFileSync(join(out, "scene.mjs"), emitJs(program));
copyFileSync(join(here, "js", "abap.mjs"), join(out, "abap.mjs"));
const m = await import(pathToFileURL(join(out, "scene.mjs")).href);
const jsObj = new m[sc.cls]();
const jsS = {sy: {index: 0, tabix: 0, subrc: 0}};
sc.jsInit?.(jsObj, jsS);
const ctxs = frames.map((r) => sc.jsCtx(m, r));
let jsDiff = 0;
ctxs.forEach((c, i) => {
  const f = jsObj.ZIF_O4D_EFFECT__RENDER_FRAME(jsS, c);
  const got = {l: f.lines.map((l) => ({x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, c: l.color})),
    r: f.rects.map((r) => ({x: r.x, y: r.y, w: r.w, h: r.h, f: r.fill})),
    tx: f.texts.map((t) => ({x: t.x, y: t.y, t: t.text, c: t.color, s: t.size}))};
  const want = frames[i];
  const same = Object.entries(KEYS).every(([list, keys]) => (got[list].length === (want[list] ?? []).length)
    && got[list].every((row, j) => keys.every((k) => close(row[k], want[list][j][k]))));
  if (!same) jsDiff += 1;
});
const jsSweeps = [];
for (let k = 0; k < repeat; k++) {
  const t = process.hrtime.bigint();
  for (const c of ctxs) jsObj.ZIF_O4D_EFFECT__RENDER_FRAME(jsS, c);
  jsSweeps.push(Number(process.hrtime.bigint() - t) / ctxs.length);
}
jsSweeps.sort((a, b) => a - b);
console.log(`JS from the IR: ${frames.length - jsDiff} of ${frames.length} frames equal to A4H, ${(jsSweeps[jsSweeps.length >> 1] / 1e3).toFixed(1)} µs a frame`);

function sceneMain(sc, recs) {
  const ctxs = recs.map((r) => `\t\t${sc.ctx(r)},`).join("\n");
  return `// Code generated by tools/gogen/scenes.mjs. DO NOT EDIT.

package main

import (
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"time"

	"osg/gogen/abap"
)

func main() {
	ctxs := []ZIF_O4D_EFFECT__TY_RENDER_CTX{
${ctxs}
	}
	obj := &${sc.cls}{}
	s := &abap.Session{Statics: abap.ProcessStatics}
	${sc.init ?? ""}
	frames := make([]map[string]any, 0, len(ctxs))
	for _, c := range ctxs {
		f := obj.ZIF_O4D_EFFECT__RENDER_FRAME(s, &c)
		lines := []map[string]any{}
		for _, l := range f.lines {
			lines = append(lines, map[string]any{"x1": l.x1, "y1": l.y1, "x2": l.x2, "y2": l.y2, "c": l.color})
		}
		rects := []map[string]any{}
		for _, r := range f.rects {
			rects = append(rects, map[string]any{"x": r.x, "y": r.y, "w": r.w, "h": r.h, "f": r.fill})
		}
		texts := []map[string]any{}
		for _, t := range f.texts {
			texts = append(texts, map[string]any{"x": t.x, "y": t.y, "t": t.text, "c": t.color, "s": t.size})
		}
		frames = append(frames, map[string]any{"l": lines, "r": rects, "tx": texts})
	}
	repeat, _ := strconv.Atoi(os.Args[1])
	sweeps := []int64{}
	for i := 0; i < repeat; i++ {
		t := time.Now()
		for _, c := range ctxs {
			obj.ZIF_O4D_EFFECT__RENDER_FRAME(s, &c)
		}
		sweeps = append(sweeps, time.Since(t).Nanoseconds()/int64(len(ctxs)))
	}
	sort.Slice(sweeps, func(a, b int) bool { return sweeps[a] < sweeps[b] })
	ns := int64(0)
	if len(sweeps) > 0 {
		ns = sweeps[len(sweeps)/2]
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"frames": frames, "nsPerFrame": ns})
}
`;
}
void funcName;
