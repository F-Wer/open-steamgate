#!/usr/bin/env node
// Fresh-process warm==cold oracle. Only the cache implementation reads the
// test-only fault variable; this harness merely passes the environment on.
import {spawnSync} from "node:child_process";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {libraryPath} from "../osd-lib-path.mjs";
import {home} from "./home.mjs";
import {syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {captureArtifacts, compareArtifacts} from "./cache-oracle-capture.mjs";
export {syntheticCorpus, captureArtifacts, compareArtifacts};

export function captureInChild(args, scratch, {noline = false, env = process.env} = {}) {
  const input = join(scratch, "capture-input.json"), output = join(scratch, "capture-output.json");
  writeFileSync(input, JSON.stringify(args));
  rmSync(output, {force: true});
  const childEnv = {...env};
  delete childEnv.GOGEN_NOLINE;
  if (noline) childEnv.GOGEN_NOLINE = "1";
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--capture", input, output],
    {env: childEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 4e6});
  if (child.error || child.status !== 0) throw new Error(`oracle capture failed (${child.status}): ${child.error?.message ?? ""}\n${child.stderr}`);
  return JSON.parse(readFileSync(output, "utf8"));
}

export function applyMutation(dir, mutation, objects) {
  for (const edit of mutation.edits ?? []) {
    const file = join(dir, edit.file);
    if (edit.remove) rmSync(file);
    else if (edit.contents !== undefined) writeFileSync(file, edit.contents);
    else {
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(edit.from)) throw new Error(`mutation ${mutation.kind}: ${edit.from} absent in ${edit.file}`);
      writeFileSync(file, raw.replace(edit.from, edit.to));
    }
  }
  return [...objects, ...(mutation.addObjects ?? [])];
}

export function mutationScenarios(mutations) {
  return [
    ...mutations.map((m) => ({name: m.kind, steps: [m]})),
    {name: "multi-edit-and-revert", steps: [
      mutations.find((m) => m.kind === "method-body"),
      mutations.find((m) => m.kind === "pool-type"),
      mutations.find((m) => m.kind === "include-macro"),
      {kind: "revert-to-original", revert: true},
    ].filter(Boolean)},
  ];
}

export function runOracle({classes = 300, seed = 719, real = false, scenarios,
  lineModes = [false, true], report, env = process.env, onResult = () => {}} = {}) {
  const started = performance.now(), corpus = syntheticCorpus({classes, seed});
  const plan = scenarios ?? mutationScenarios(corpus.mutations);
  const scratch = mkdtempSync(join(tmpdir(), "gogen-cache-oracle-"));
  const rows = [], primes = [], summaries = [];
  const manifest = {schema: 1, seed, classes, real, lineModes, scenarios: plan};
  try {
    // Save the complete descriptors before starting, including on a child crash.
    // Keep report failures inside cleanup as well (e.g. a missing parent folder).
    if (report) writeFileSync(resolve(report), JSON.stringify({manifest}, null, 2) + "\n");
    const baseline = join(scratch, "baseline");
    mkdirSync(baseline);
    for (const [file, raw] of Object.entries(corpus.files)) writeFileSync(join(baseline, file), raw);
    const realObjects = [];
    if (real) {
      // libraryPath checks pins and cleanliness before any copy. All edits stay
      // in scratch; the shared public library paths are never modified.
      for (const library of ["open-abap-core", "ajson"]) {
        const source = join(libraryPath(home, library), "src"), target = join(baseline, library);
        cpSync(source, target, {recursive: true});
        const collect = (dir) => {
          for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory()) collect(join(dir, entry.name));
            else if (/\.clas\.abap$/i.test(entry.name)) realObjects.push(entry.name.split(".")[0].replaceAll("#", "/").toUpperCase());
          }
        };
        collect(target);
      }
      // Use the pinned exception root rather than shadowing it with the small
      // synthetic stand-in. All real classes are selected, with tolerant
      // refusals retained in the comparison.
      rmSync(join(baseline, "cx_root.clas.abap"));
      manifest.realObjects = realObjects;
      manifest.libraryPins = JSON.parse(readFileSync(join(home, "libs.lock.json"), "utf8")).libraries
        .filter((lib) => ["open-abap-core", "ajson"].includes(lib.folder));
      if (!scenarios) plan.push(
        {name: "real-comment", steps: [{kind: "real-comment", edits: [{file: "ajson/core/zcl_ajson.clas.abap", from: "  public section.", to: '  public section.\n" seeded oracle comment'}]}]},
        {name: "real-constant", steps: [{kind: "real-constant", edits: [{file: "open-abap-core/abap/cl_abap_char_utilities.clas.abap", from: "VALUE 2.", to: "VALUE 4."}]}]},
      );
    }
    const save = () => {
      const result = {manifest, rows, primes, summaries, mutationsRun: rows.length,
        mismatches: rows.filter((r) => !r.equal).length, runtimeMs: Math.round(performance.now() - started)};
      if (report) writeFileSync(resolve(report), JSON.stringify(result, null, 2) + "\n");
      return result;
    };
    for (const noline of lineModes) for (const scenario of plan) {
      const caseDir = join(scratch, "case"), input = join(caseDir, "input"), cacheDir = join(caseDir, "cache");
      mkdirSync(caseDir);
      try {
        cpSync(baseline, input, {recursive: true});
        const folders = [input], originalObjects = [...new Set([...corpus.objects, ...realObjects])];
        // Copies of libraries are nested under input and loaded by its walk.
        let objects = originalObjects, order;
        const opts = {noline, env};
        const prime = captureInChild({folders, objects, cacheDir}, caseDir, opts);
        primes.push({scenario: scenario.name, noline, ...prime.counts});
        // A no-edit control proves that this is a functioning disk cache. It
        // also records deliberately nonportable/uncacheable class lowerings.
        if (scenario === plan[0]) {
          const unchanged = captureInChild({folders, objects, cacheDir}, caseDir, opts);
          const noEdit = {...compareArtifacts(unchanged, prime), scenario: scenario.name, kind: "unchanged", noline, ...unchanged.counts};
          summaries.push(noEdit);
          if (!noEdit.equal) throw new Error(`unchanged warm differs: ${JSON.stringify(noEdit)}`);
        }
        for (const mutation of scenario.steps) {
          if (mutation.revert) {
            rmSync(input, {recursive: true}); cpSync(baseline, input, {recursive: true});
            objects = originalObjects; order = undefined;
          } else { objects = applyMutation(input, mutation, objects); order = mutation.order ?? order; }
          const args = {folders, objects, order};
          const warm = captureInChild({...args, cacheDir}, caseDir, opts);
          const cold = captureInChild(args, caseDir, opts);
          const row = {...compareArtifacts(warm, cold), scenario: scenario.name, kind: mutation.kind, noline,
            loweredClasses: warm.counts.loweredClasses, reusedClasses: warm.counts.reusedClasses,
            lowered: warm.counts.lowered, reused: warm.counts.reused, coldCounts: cold.counts};
          rows.push(row); onResult(row); save();
        }
      } finally { rmSync(caseDir, {recursive: true, force: true}); }
    }
    return save();
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--capture") writeFileSync(argv[2], JSON.stringify(captureArtifacts(JSON.parse(readFileSync(argv[1], "utf8")))));
  else {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--real") options.real = true;
      else if (["--classes", "--seed"].includes(argv[i])) options[argv[i].slice(2)] = Number(argv[++i]);
      else if (argv[i] === "--report") options.report = argv[++i];
      else if (argv[i] === "--reproduce") {
        const {manifest} = JSON.parse(readFileSync(argv[++i], "utf8")); Object.assign(options, manifest);
      } else throw new Error(`unknown option: ${argv[i]}`);
    }
    options.report ??= "cache-oracle-report.json";
    const result = runOracle({...options, onResult: (r) => console.log(
      `${r.noline ? "noline" : "lines"} ${r.scenario}/${r.kind}: equal=${r.equal ? "yes" : "no"} lowered=${r.lowered} reused=${r.reused}${r.equal ? "" : ` first=${r.artifact}@${r.offset}`}`)});
    console.log(JSON.stringify({mutationsRun: result.mutationsRun, mismatches: result.mismatches,
      lowered: result.rows.reduce((n, r) => n + r.lowered, 0), reused: result.rows.reduce((n, r) => n + r.reused, 0), runtimeMs: result.runtimeMs, report: options.report}));
    if (result.mismatches) process.exitCode = 1;
  }
}
