// CI entry point for generated abapGit classes. The caller's directory is read only.
import {rmSync} from "node:fs";
import {join, resolve} from "node:path";
import {compiled, hosted, toolCommand} from "./osd-host.mjs";
import {runsAs} from "./osd-main.mjs";

import {unitProvenance} from "./osd-unit-provenance.mjs";

const help = `Usage: npm run osgo:unit -- <dir> [--json] [--kernel-strict] [--jobs N] [--class NAME...]
Reads the immediate directory only (no recursion). Default jobs: 4.
osd unit --go accepts the same arguments in a checkout.
The compiled binary carries neither Go nor the gogen tree; use the checkout
command with Node dependencies, synced libraries and Go 1.26 installed.
Kernel compatibility warnings preserve compiler diagnostics and exit codes; --kernel-strict reports ERROR (exit 2).
Exit codes: 0 all SUCCESS, 1 FAILURE, 2 NOT_COMPILED/ERROR, 3 no tests.`;

export {metadata, summarize} from "./osd-unit-ci.mjs";
import {stageInput, summarize, printResult, run, kernelWarnings, applyKernelWarnings} from "./osd-unit-ci.mjs";

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) { console.log(help); return 0; }
  const json = args.includes("--json");
  let staging, result, warnings = [];
  const selected = [];
  let provenance;
  try {
    const root = resolve(import.meta.dirname, "..");
    if (compiled) throw new Error("osd unit --go requires a checkout: the binary carries neither Go nor the gogen tree. Run npm run osgo:unit -- <dir>.");
    let directory, jobs = 4;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json" || arg === "--kernel-strict") continue;
      if (arg === "--jobs") {
        jobs = Number(args[++i]);
        if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256) throw new Error("--jobs must be an integer from 1 to 256");
      } else if (arg === "--class") {
        const start = selected.length;
        while (args[i + 1] && !args[i + 1].startsWith("--")) selected.push(args[++i].replaceAll("#", "/").toUpperCase());
        if (selected.length === start) throw new Error("--class needs at least one name (put <dir> first)");
      } else if (arg.startsWith("-") || directory) throw new Error(`unexpected argument: ${arg}`);
      else directory = resolve(arg);
    }
    if (!directory) throw new Error("<dir> is required; use --help for usage");
    const staged = stageInput(directory, selected, "osgo-unit");
    staging = staged.staging;
    try { warnings = kernelWarnings(staged.input ?? directory); }
    catch (error) {
      warnings = [{kind: "scanner-error", message: `Kernel compatibility scanner failed: ${String(error.message ?? error).replace(/\s+/g, " ")}`}];
    }
    const {chosen, input} = staged;
    result = staged.result;
    if (!result) {
      provenance = unitProvenance("osgo");
      const command = toolCommand(join(root, "tools", "gogen", "unit.mjs"),
        ["--input", input, "--no-extra-packs", "--jobs", String(jobs), "--out", join(staging, "out"), "--no-cache", ...chosen.flatMap((name) => ["--class", name])]);
      // Hosted dispatch uses a unique name: gogen's unit.mjs and osd-unit.mjs differ.
      if (hosted()) command[JSON.parse(process.env.OSD_SELF).length + 1] = "gogen-unit.mjs";
      const child = await run(command, root);
      if (child.stderr) process.stderr.write(child.stderr);
      if (child.signal) throw new Error(`unit runner terminated by ${child.signal}`);
      try { result = JSON.parse(child.stdout); }
      catch { throw new Error(child.stderr.trim() || `invalid unit result (exit ${child.status})`); }
      if (!Array.isArray(result.rows)) throw new Error("unit result has no rows");
      if (child.status && child.status !== 2 && !result.rows.length) throw new Error(child.stderr.trim() || `unit runner exited ${child.status} without results`);
    }
  } catch (error) {
    result = {classes: 0, compiled: 0, rows: [{source: "harness", status: "ERROR", message: error.message}], timingMs: {}};
  } finally { if (staging) rmSync(staging, {recursive: true, force: true}); }
  if (provenance) result.provenance = provenance;
  const summary = summarize(applyKernelWarnings(result, warnings, args.includes("--kernel-strict"), selected));
  printResult(summary.result, json);
  return summary.code;
}

if (runsAs("osgo-unit.mjs")) process.exitCode = await main();
