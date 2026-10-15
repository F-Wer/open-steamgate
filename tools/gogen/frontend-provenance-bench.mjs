import {artifactDigestStats, artifactDigestsOf} from "./frontend-artifact-digests.mjs";
// Fresh-process no-cache/cold/warm timings, cache size and output byte parity.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync, writeFileSync, readdirSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";
import {syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {artifactsOf, orderedRegistry} from "./cache-oracle-capture.mjs";
import {compileProgram} from "./frontend.mjs";
import {provenanceOf, recordProvenance} from "./frontend-provenance.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {home} from "./home.mjs";

function child({folders, objects, recording, mode = "none", cacheDir}) {
  const start = performance.now();
  const compile = () => {
    const reg = orderedRegistry(folders, [], {parse: false});
    reg.parse();
    return compileProgram({registry: reg, folders, objects, tolerant: true,
      cacheDir: mode === "none" ? undefined : cacheDir, provenance: recording, includeTests: new Set(["ZCL_CONTROL_0000"])});
  };
  const program = recording ? recordProvenance(compile) : compile();
  const frontendMs = performance.now() - start;
  const {artifacts, classArtifacts} = artifactsOf(program);
  const digest = createHash("sha256").update(JSON.stringify({artifacts, classArtifacts})).digest("hex");
  const manifests = provenanceOf(program), unknown = new Map();
  let queryRows = 0;
  for (const [owner, m] of manifests) {
    queryRows += m.hits.length + m.misses.length + m.scans.length + m.unknownScans.length;
    for (const q of m.unknownScans) {
      const site = q.site?.[0] ?? q.args.join(" ");
      if (!unknown.has(site)) unknown.set(site, {site, queries: new Set(), owners: 0});
      const entry = unknown.get(site); entry.queries.add(JSON.stringify(q)); entry.owners++;
    }
  }
  const resolvedArtifacts = artifactDigestStats(program) ?? {objects: 0, nodes: 0, milliseconds: 0, errors: {}};
  const inspected = [...artifactDigestsOf(program)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return {recording, mode, frontendMs, resolvedArtifacts, inspectedArtifacts: artifactDigestStats(program),
    resolvedDigest: createHash("sha256").update(JSON.stringify(inspected)).digest("hex"), cacheBytes: mode === "none" ? 0 : treeBytes(cacheDir), reused: program.frontendCounts.reused, digest, objects: [...program.reg.getObjects()].length,
    lowered: program.frontendCounts.lowered, diagnostics: program.diagnostics.length,
    manifestObjects: manifests.size, queryRows,
    unknownScans: [...unknown.values()].map(({site, queries, owners}) => ({site, uniqueQueries: queries.size, manifestOccurrences: owners}))};
}

function treeBytes(dir) {
  return readdirSync(dir, {withFileTypes: true}).reduce((sum, e) => sum +
    (e.isDirectory() ? treeBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
}
function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") { console.log(JSON.stringify(child(JSON.parse(args[1])))); return; }
  const real = args.includes("--real"), roundIndex = args.indexOf("--rounds");
  const rounds = roundIndex < 0 ? 3 : Number(args[roundIndex + 1]);
  const reportIndex = args.indexOf("--report"), report = reportIndex < 0 ? undefined : resolve(args[reportIndex + 1]);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be >= 1");
  const scratch = mkdtempSync(join(tmpdir(), "gogen-provenance-bench-"));
  try {
    const folders = [], objects = [];
    if (real) {
      for (const name of ["open-abap-core", "ajson"]) {
        const folder = join(libraryPath(home, name), "src"); folders.push(folder);
        const walk = (dir) => {
          for (const e of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.isDirectory()) walk(join(dir, e.name));
            else if (/\.clas\.abap$/i.test(e.name)) objects.push(e.name.split(".")[0].replaceAll("#", "/").toUpperCase());
          }
        };
        walk(folder);
      }
    } else {
      const c = syntheticCorpus({classes: 300, seed: 719}); folders.push(scratch); objects.push(...c.objects);
      for (const [name, raw] of Object.entries(c.files)) writeFileSync(join(scratch, name), raw);
    }
    const runs = [], cacheDir = join(scratch, "cache");
    const run = (options) => JSON.parse(execFileSync(process.execPath,
      [fileURLToPath(import.meta.url), "--child", JSON.stringify(options)],
      {encoding: "utf8", maxBuffer: 16 * 1024 * 1024}));
    for (let round = 0; round < rounds; round++) for (const recording of round % 2 ? [true, false] : [false, true]) {
      for (const mode of ["none", "cold", "warm"]) {
        if (mode !== "warm") rmSync(cacheDir, {recursive: true, force: true});
        // Warm follows a fresh-process cold prime for this round/recording mode.
        const result = run({folders, objects, recording, mode, cacheDir});
        runs.push(result);
        if (new Set(runs.map((r) => r.resolvedDigest)).size !== 1) throw new Error("resolved artifact digest mismatch");
        if (result.inspectedArtifacts.objects !== result.objects || Object.keys(result.inspectedArtifacts.errors).length)
          throw new Error("incomplete resolved digest inspection");
        if (mode === "none" && result.resolvedArtifacts.objects !== 0) throw new Error("uncached compile performed digest work");
        if (new Set(runs.map((r) => r.digest)).size !== 1) throw new Error("recording/cache mode byte mismatch");
      }
    }
    const med = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const scenarios = ["none", "cold", "warm"].map((mode) => {
      const subset = (on) => runs.filter((r) => r.mode === mode && r.recording === on);
      const offMs = med(subset(false).map((r) => r.frontendMs)), onMs = med(subset(true).map((r) => r.frontendMs));
      return {mode, offMs, onMs, offDigestMs: med(subset(false).map((r) => r.resolvedArtifacts.milliseconds)),
        onDigestMs: med(subset(true).map((r) => r.resolvedArtifacts.milliseconds)), overheadPercent: (onMs / offMs - 1) * 100,
        offBytes: med(subset(false).map((r) => r.cacheBytes)), onBytes: med(subset(true).map((r) => r.cacheBytes))};
    });
    const result = {corpus: real ? "open-abap-core + ajson" : "oracle 300 controls + feature fixtures", rounds,
      scenarios, byteIdentical: true, runs};
    if (report) writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}
try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
