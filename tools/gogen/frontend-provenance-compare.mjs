// Compare observational manifests across compiler checkouts. Query dictionaries
// are unordered; candidate/result arrays, stopping policy and phases are not.
import {createHash} from "node:crypto";
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
import {canonical} from "./frontend-artifact-digests.mjs";
import {syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {home} from "./home.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const canonicalQueries = (queries) => queries.map((q) => JSON.stringify(canonical(q))).sort(ordered);
export function canonicalManifests(manifests, compilation) {
  return {artifacts: [...manifests].map(([key, m]) => [key,
    Object.fromEntries(Object.entries(m).map(([kind, rows]) => [kind, canonicalQueries(rows)]))])
    .sort(([a], [b]) => ordered(a, b)), scheduling: canonicalQueries(compilation.scheduling),
  finalOutput: canonicalQueries(compilation.finalOutput)};
}

async function capture({compiler, folders, objects, mode, cacheDir}) {
  const load = (file) => import(pathToFileURL(join(compiler, "tools/gogen", file)).href);
  const [{compileProgram}, {recordProvenance, provenanceOf, compilationProvenanceOf},
    {orderedRegistry, artifactsOf}, {artifactDigestsOf}] = await Promise.all([
    load("frontend.mjs"), load("frontend-provenance.mjs"), load("cache-oracle-capture.mjs"), load("frontend-artifact-digests.mjs")]);
  const p = recordProvenance(() => compileProgram({registry: orderedRegistry(folders), folders, objects,
    tolerant: true, provenance: true, cacheDir: mode === "none" ? undefined : cacheDir,
    includeTests: new Set(["ZCL_CONTROL_0000"])}));
  const {artifacts, classArtifacts} = artifactsOf(p);
  const manifests = canonicalManifests(provenanceOf(p), compilationProvenanceOf(p));
  return {mode, output: hash({artifacts, classArtifacts}),
    digests: hash([...artifactDigestsOf(p)].sort(([a], [b]) => ordered(a, b))),
    manifests: {artifacts: manifests.artifacts.map(([key, m]) => [key, hash(m)]),
      scheduling: hash(manifests.scheduling), finalOutput: hash(manifests.finalOutput)}};
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") { console.log(JSON.stringify(await capture(JSON.parse(args[1])))); return; }
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const compiler = resolve(option("--compiler") ?? home), report = option("--report");
  const scratch = mkdtempSync(join(tmpdir(), "gogen-manifest-compare-"));
  try {
    const folders = [], objects = [];
    if (args.includes("--real")) for (const name of ["open-abap-core", "ajson"]) {
      const folder = join(libraryPath(home, name), "src"); folders.push(folder);
      const walk = (dir) => {
        for (const e of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.isDirectory()) walk(join(dir, e.name));
          else if (/\.clas\.abap$/i.test(e.name)) objects.push(e.name.split(".")[0].replaceAll("#", "/").toUpperCase());
        }
      };
      walk(folder);
    } else {
      const corpus = syntheticCorpus({classes: 300, seed: 719}); folders.push(scratch); objects.push(...corpus.objects);
      for (const [name, raw] of Object.entries(corpus.files)) writeFileSync(join(scratch, name), raw);
    }
    const runs = [];
    for (const mode of ["none", "cold", "warm"]) {
      const child = spawnSync(process.execPath, [import.meta.filename, "--child",
        JSON.stringify({compiler, folders, objects, mode, cacheDir: join(scratch, "cache")})],
      {cwd: compiler, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
      if (child.status !== 0) throw new Error(child.stderr || child.error || `child exited ${child.status}`);
      runs.push(JSON.parse(child.stdout));
    }
    if (report) writeFileSync(report, JSON.stringify(runs, null, 2) + "\n");
    const comparison = option("--compare");
    if (comparison) {
      const before = JSON.parse(readFileSync(comparison, "utf8"));
      if (JSON.stringify(before) !== JSON.stringify(runs)) throw new Error(`manifest/output/digest mismatch against ${comparison}`);
    }
    console.log(JSON.stringify({corpus: args.includes("--real") ? "open-abap-core + ajson" : "oracle 300 controls",
      objects: runs[0].manifests.artifacts.length, modes: runs.map((r) => r.mode), equal: comparison ? true : undefined}));
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
