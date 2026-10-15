// Fresh-process shadow predictions and directly timed key recomputation. All
// mutations are to scratch copies of the pinned public libraries.
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {compileProgram} from "./frontend.mjs";
import {artifactsOf} from "./cache-oracle-capture.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {home} from "./home.mjs";
function child({folder, objects, cacheDir, globalOnly}) {
  const start = performance.now();
  const p = compileProgram({folders: [folder], objects, cacheDir, tolerant: true,
    ...(globalOnly ? {provenance: false} : {})});
  const frontendMs = performance.now() - start;
  const {artifacts, classArtifacts} = artifactsOf(p);
  return {frontendMs, counts: p.frontendCounts,
    output: createHash("sha256").update(JSON.stringify({artifacts, classArtifacts})).digest("hex")};
}
function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--child") { console.log(JSON.stringify(child(JSON.parse(args[1])))); return; }
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const rounds = Number(option("--rounds") ?? 3), reportPath = option("--report");
  // Default remains exhaustive and nonvacuous. Timing runs explicitly opt out
  // of cold shadow lowerings; their independent fresh cold output gate stays.
  const globalOnly = args.includes("--global-only"), production = args.includes("--production") || globalOnly;
  const compareGlobal = args.includes("--compare-global");
  if (compareGlobal && (!production || globalOnly)) throw new Error("--compare-global requires --production");
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be positive");
  const scratch = mkdtempSync(join(tmpdir(), "gogen-v3-real-"));
  const run = (options) => {
    const result = spawnSync(process.execPath, [import.meta.filename, "--child", JSON.stringify(options)],
      {encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: {...process.env,
        GOGEN_CACHE_SHADOW_EXHAUSTIVE: "0", GOGEN_CACHE_SHADOW_VALIDATE: production ? "0" : "1"}});
    if (result.status !== 0) throw new Error(result.stderr || result.error || `child exited ${result.status}`);
    return JSON.parse(result.stdout);
  };
  const walk = (dir) => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  try {
    const folder = join(scratch, "input"), cacheDir = join(scratch, "cache"), referenceCache = join(scratch, "reference"), objects = [];
    for (const name of ["open-abap-core", "ajson"]) cpSync(join(libraryPath(home, name), "src"), join(folder, name), {recursive: true});
    for (const file of walk(folder)) if (/\.clas\.abap$/i.test(file)) objects.push(file.split("/").at(-1).split(".")[0].replaceAll("#", "/").toUpperCase());
    const leafName = "CL_ABAP_HMAC", leaf = join(folder, "open-abap-core/abap/hash/cl_abap_hmac.clas.abap");
    // No incoming source references in compiled code (its own Unit tests are
    // excluded). Conservative recorded semantic closures can still include it.
    const incomingSourceReferences = walk(folder).filter((file) => file !== leaf && /\.abap$/i.test(file)
      && !/\.testclasses\.abap$/i.test(file) && /\bCL_ABAP_HMAC\b/i.test(readFileSync(file, "utf8")
        .split("\n").filter((line) => !/^\s*["*]/.test(line)).join("\n")));
    if (incomingSourceReferences.length) throw new Error("leaf fixture acquired an incoming source reference");
    const intf = join(folder, "open-abap-core/ixml/if_ixml_node.intf.abap");
    const originalLeaf = readFileSync(leaf, "utf8"), originalInterface = readFileSync(intf, "utf8");
    const editedInterface = originalInterface.replace("co_node_text          TYPE i VALUE 16", "co_node_text          TYPE i VALUE 17");
    if (editedInterface === originalInterface) throw new Error("interface mutation did not apply");
    const runs = [];
    for (let round = 0; round < rounds; round++) {
      for (const scenario of ["unchanged", "leaf-class", "widely-used-interface"]) {
        rmSync(cacheDir, {recursive: true, force: true});
        if (compareGlobal) rmSync(referenceCache, {recursive: true, force: true});
        writeFileSync(leaf, originalLeaf); writeFileSync(intf, originalInterface);
        run({folder, objects, cacheDir, globalOnly});
        if (compareGlobal) run({folder, objects, cacheDir: referenceCache, globalOnly: true});
        writeFileSync(leaf, scenario === "leaf-class" ? originalLeaf.replace(/(METHOD\s+\w+\.)/i, '$1\n" shadow leaf edit') : originalLeaf);
        writeFileSync(intf, scenario === "widely-used-interface" ? editedInterface : originalInterface);
        // Adjacent fresh processes, alternating order, reduce shared-host drift
        // between a production sample and its global-only reference.
        const reference = () => run({folder, objects, cacheDir: referenceCache, globalOnly: true});
        let globalWarm = compareGlobal && round % 2 === 0 ? reference() : undefined;
        const warm = run({folder, objects, cacheDir, globalOnly});
        if (compareGlobal && !globalWarm) globalWarm = reference();
        const cold = run({folder, objects});
        if (warm.output !== cold.output) throw new Error(`warm/cold output disagreement: ${scenario}`);
        if (globalWarm && globalWarm.output !== cold.output) throw new Error(`global/cold output disagreement: ${scenario}`);
        const shadow = warm.counts.shadowV3;
        if ((!production && !shadow?.validated) || shadow?.disagreements) throw new Error("vacuous or disagreeing shadow run");
        runs.push({round, scenario, frontendMs: warm.frontendMs, recomputeMs: shadow?.recomputeMs ?? 0,
          wouldReuse: shadow?.entries.filter((e) => e.wouldReuseV3).length ?? 0,
          wouldLower: shadow?.entries.filter((e) => !e.wouldReuseV3).length ?? 0,
          validated: shadow?.validated ?? 0, actuallyLowered: warm.counts.lowered,
          ...(globalWarm ? {globalFrontendMs: globalWarm.frontendMs} : {}),
          actuallyReused: warm.counts.reused, entries: shadow?.entries, outputEqual: true});
      }
    }
    const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const scenarios = ["unchanged", "leaf-class", "widely-used-interface"].map((scenario) => {
      const rows = runs.filter((r) => r.scenario === scenario);
      return {scenario, wouldReuse: rows[0].wouldReuse, wouldLower: rows[0].wouldLower,
        ...(compareGlobal ? {globalFrontendMs: median(rows.map((r) => r.globalFrontendMs))} : {}),
        recomputeMs: median(rows.map((r) => r.recomputeMs)), frontendMs: median(rows.map((r) => r.frontendMs))};
    });
    const report = {corpus: "pinned open-abap-core + ajson", rounds, mode: globalOnly ? "global-only" : production ? "production" : "exhaustive", leaf: `${leafName} method comment (zero incoming source references)`,
      interface: "IF_IXML_NODE CO_NODE_TEXT 16 -> 17", scenarios, runs};
    if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({...report, runs: undefined}));
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}
try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
