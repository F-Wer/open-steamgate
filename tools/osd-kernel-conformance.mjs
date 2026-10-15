import {spawnSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {generate, render} from "./osg-support.mjs";
import {compareFailures, compareDrift, identityDigest} from "./osd-kernel-check.mjs";
import {root, readJSON, pin, prepare, verifyCorpus, goEnv} from "./osd-kernel-corpus.mjs";
import {runsAs} from "./osd-main.mjs";
import {toolCommand} from "./osd-host.mjs";

export const publicFolders = ["TestOSD_EmitUnitClasses", "int8"];
export const unmeasuredInputs = ["mono", "QuickJS"].map((name) =>
  `${name}: not measured in CI: no public pinned source (local copies only; see docs/ci-tests.md)`);

export function regenerateEvidence(corpus, runs, out, ref) {
  writeFileSync(join(out, "runs.json"), JSON.stringify(runs, null, 2) + "\n");
  const dirs = [...new Set(runs.map((r) => r.folder))].map((folder) => join(corpus, folder));
  const {report} = generate(dirs, {osgjs: [], osgo: [], runs: [join(out, "runs.json")]});
  report.abapiti = ref;
  writeFileSync(join(out, "support.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(out, "support.md"), render(report));
  return report;
}

export const conformanceEnv = work => ({...goEnv(work), OSD_PACKS: undefined,
  OSD_WEB_PACKS: undefined, OSD_LAYERS: undefined, NODE_OPTIONS: "--max-old-space-size=12288"});

export function main(args = process.argv.slice(2)) {
  const start = performance.now(), errors = [], summary = ["# Kernel conformance", ""], runs = [];
  let work = join(root, ".local/kernelci"), profile = "required", source;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error(`${args[i]} needs a value`);
    if (args[i] === "--work") work = resolve(value);
    else if (args[i] === "--profile") profile = value;
    else if (args[i] === "--source") source = value;
    else throw new Error(`unexpected argument: ${args[i]}`);
  }
  if (!["required", "heavy"].includes(profile)) throw new Error("profile must be required or heavy");
  const out = join(work, "report"); mkdirSync(out, {recursive: true});
  const results = {osgjs: {rows: [], totals: {}}, osgo: {rows: [], totals: {}}};
  try {
    summary.push(...unmeasuredInputs.map((line) => `- ${line}`), "");
    const corpus = prepare({work, source});
    const manifest = readJSON(join(root, ".github/ci/kernel-corpus.json"));
    const known = readJSON(join(root, ".github/ci/kernel-known-failures.json"));
    if (known.abapiti !== pin()) throw new Error("known failures pin differs");
    const env = conformanceEnv(work);
    for (const runtime of profile === "heavy" ? ["osgjs", "osgo"] : ["osgjs"]) for (const folder of publicFolders) {
      // Public required inputs remain strict; unavailable optional inputs are report lines above.
      try { verifyCorpus(corpus, manifest, [folder]); }
      catch (error) { errors.push(error.message); continue; }
      const t = performance.now(), file = `${folder}-${runtime}.json`;
      console.log(`kernel conformance: ${folder}/${runtime}`);
      const [command, ...argv] = toolCommand(join(root, `tools/${runtime === "osgo" ? "osgo" : "osgjs"}-unit.mjs`), [join(corpus, folder), "--json", ...(runtime === "osgjs" ? ["--db", "file"] : [])]);
      const child = spawnSync(command, argv, {
        cwd: root, env, encoding: "utf8", timeout: 1200000, maxBuffer: 32e6,
      });
      writeFileSync(join(out, file), child.stdout ?? "");
      writeFileSync(join(out, `${folder}-${runtime}.err`), child.stderr ?? "");
      const seconds = Number(((performance.now() - t) / 1000).toFixed(2));
      try {
        if (child.error || child.signal) throw new Error(child.error?.message ?? `runner signal ${child.signal}`);
        const result = JSON.parse(child.stdout);
        const expected = known.entries.filter((e) => e.runtime === runtime && e.folder === folder);
        errors.push(...compareFailures(result, expected, {tests: manifest.folders[folder].tests, exitCode: child.status}).map((e) => `${folder}/${runtime}: ${e}`));
        // Protect against a missing/renamed passing test even when totals stay constant.
        if (identityDigest(result.rows) !== manifest.folders[folder].identitiesSha256) errors.push(`${folder}/${runtime}: test identities differ from pinned corpus`);
        results[runtime].rows.push(...result.rows);
        runs.push({folder, runtime, file, wallSeconds: seconds});
        summary.push(`- ${folder}/${runtime}: ${result.totals.success}/${result.totals.tests} SUCCESS, ${result.totals.failure} FAILURE; ${seconds} s`);
      } catch (error) { errors.push(`${folder}/${runtime}: ${error.message}`); }
    }
    if (runs.length) {
      // Same evidence generator as osg:support. Omitted runtimes/folders carry no credit.
      const report = regenerateEvidence(corpus, runs, out, pin());
      errors.push(...compareDrift(report, readFileSync(join(root, "docs/osg-support.md"), "utf8"), readJSON(join(root, ".github/ci/kernel-inventory.json"))));
    }
  } catch (error) { errors.push(error.message); }
  finally {
    for (const [runtime, result] of Object.entries(results)) {
      for (const [key, status] of Object.entries({success: "SUCCESS", failure: "FAILURE", error: "ERROR", not_compiled: "NOT_COMPILED"})) result.totals[key] = result.rows.filter((r) => r.status === status).length;
      result.totals.tests = result.rows.filter((r) => r.method).length;
      result.abapiti = pin(); result.profile = profile;
      writeFileSync(join(out, `${runtime}.json`), JSON.stringify(result, null, 2) + "\n");
    }
    const seconds = Number(((performance.now() - start) / 1000).toFixed(2));
    summary.push("", `Profile: ${profile}; ABAPiti: ${pin()}; wall time: ${seconds} s.`, "", errors.length ? "FAIL" : "PASS", ...errors.map((e) => `- ${e}`), "");
    writeFileSync(join(out, "summary.md"), summary.join("\n"));
    console.log(summary.join("\n"));
  }
  return errors.length ? 1 : 0;
}
if (runsAs("osd-kernel-conformance.mjs")) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
