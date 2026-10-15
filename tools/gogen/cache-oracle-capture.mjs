import {recordProvenance} from "./frontend-provenance.mjs";
import {createRequire} from "node:module";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";
import {lowerBoolx} from "./frontend-boolx.ts";
import {lowerNarrowSubmit} from "../osd-narrow-submit.mjs";

const require = createRequire(import.meta.url);
const abaplint = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
export const jsonArtifact = (value) => JSON.stringify(value, (_, v) =>
  v instanceof Map ? {map: [...v]} : v instanceof Set ? {set: [...v]} : v);

export function orderedRegistry(folders, order = [], {parse = true} = {}) {
  const config = abaplint.Config.getDefault().get();
  // Model a missing external provider: abaplint leaves its type unresolved,
  // so gogen can record the failed lookup instead of skipping a syntax-broken
  // consumer before the cache is reached. Every other name is checked.
  config.syntax = {...config.syntax, version: "v758", errorNamespace: "^(?!ZCL_ADDED$)."};
  config.rules = {check_syntax: true, parser_error: true};
  const registry = new abaplint.Registry(new abaplint.Config(JSON.stringify(config))), files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.clas\.testclasses\.abap$/i.test(entry.name) && entry.name !== "zcl_control_0000.clas.testclasses.abap") continue;
      else if (/\.(abap|xml)$/i.test(entry.name)) files.push({name: entry.name, path});
    }
  };
  folders.forEach(walk);
  // Replace just the listed slots; preserve object inventory and every other
  // object's order. This exercises the supplied-registry API, since the folder
  // loader deliberately sorts directory entries.
  const slots = files.map((f, i) => order.includes(f.name) ? i : -1).filter((i) => i >= 0);
  if (slots.length !== order.length) throw new Error("order must name existing, unique files");
  const selected = order.map((name) => files.find((f) => f.name === name));
  slots.forEach((slot, i) => { files[slot] = selected[i]; });
  for (const {name, path} of files) registry.addFile(new abaplint.MemoryFile(name,
    lowerNarrowSubmit(lowerBoolx(readFileSync(path, "utf8"), name, abaplint), name, abaplint)));
  if (parse) registry.parse();
  return registry;
}

// Always called in a fresh child by the oracle. Cache-disabled compilation
// uses the ordinary frontend, including its different PERSIST_LOWERING path.
export function captureArtifacts(options) {
  return options.provenance ?? (process.env.GOGEN_PROVENANCE === "1")
    ? recordProvenance(() => capture(options)) : capture(options);
}
function capture({folders, objects, cacheDir, order, provenance}) {
  const program = compileProgram({folders, objects, cacheDir, provenance, tolerant: true,
    includeTests: new Set(["ZCL_CONTROL_0000"]),
    registry: orderedRegistry(folders, order)});
  return artifactsOf(program);
}

export function artifactsOf(program) {
  const artifacts = {emitGo: emitGo(program)};
  try { artifacts.emitJs = emitJs(program); }
  catch (error) { artifacts.jsRefusal = `${error.name}: ${error.message}`; }
  for (const key of ["broken", "skipped", "partial", "diagnostics", "missing"])
    artifacts[key] = jsonArtifact(program[key]);
  // Final passes live outside class replay; compare their results as well.
  for (const key of ["rtti", "tables", "lockObjects", "exceptionSupers", "cdsViews", "amcChannels", "interfaceMethods"])
    artifacts[key] = jsonArtifact(program[key]);
  return {artifacts, counts: program.frontendCounts,
    classArtifacts: Object.fromEntries(program.classes.map((cls) => [cls.name, jsonArtifact(cls)]))};
}

export function compareArtifacts(warm, cold) {
  for (const artifact of new Set([...Object.keys(warm.artifacts), ...Object.keys(cold.artifacts)])) {
    const a = warm.artifacts[artifact], b = cold.artifacts[artifact];
    if (a === b) continue;
    const left = Buffer.from(a ?? ""), right = Buffer.from(b ?? "");
    let offset = 0;
    while (offset < Math.min(left.length, right.length) && left[offset] === right[offset]) offset++;
    return {equal: false, artifact, offset, warmBytes: left.length, coldBytes: right.length};
  }
  return {equal: true};
}

// Record all differences, including consumer IR, rather than attributing a
// sensitivity row to whichever aggregate artifact happens to differ first.
export function artifactDifferences(left, right) {
  const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => a[key] !== b[key]);
  return {artifacts: changed(left.artifacts, right.artifacts),
    classes: changed(left.classArtifacts, right.classArtifacts)};
}

export function assertDdicRun(capture) {
  const cls = JSON.parse(capture.classArtifacts.ZCL_DDIC ?? "null");
  if (!cls?.methods.some((method) => method.name === "RUN" && !method.dropped) ||
      ["broken", "skipped", "partial"].some((key) => capture.artifacts[key].includes("ZCL_DDIC")))
    throw new Error("valid DDIC edit must still lower ZCL_DDIC.RUN");
}
