// Hook sensitivity: one mutation at a time in a disposable compiler checkout.
import {cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
const root = resolve(import.meta.dirname, "../..");
const facade = "tools/gogen/frontend-provenance.mjs", recorder = "tools/gogen/frontend-provenance-recorder.mjs", hooks = "tools/gogen/frontend-provenance-hooks.mjs";
const mutants = [];
const add = (name, file, from, to, equivalent) => mutants.push({name, file, from, to, equivalent});
add("rec-query-edge", recorder, 'if (role === "artifact" && owner && !row.scan)', 'if (false)');
add("rec-link-edge", recorder, 'if (from && from !== key)', 'if (false)');
add("query-and-link-edges", recorder, 'if (role === "artifact" && owner && !row.scan)', 'if (false)');
add("sel-artifact", recorder, 'return active && obj ? active.artifact', 'return false ? active.artifact');
add("methods-all-artifact-read", hooks, 'for (const method of methods)', 'for (const method of [])');
add("owner-from-owners-map", hooks, 'owners.get(this) ??', 'undefined ??');
add("fg-include-query", hooks, 'if (method === "getInclude" || method === "getModule")', 'if (false)');
add("cross.findCandidates", hooks, 'patch(cross, "findCandidates",', 'patch(cross, "absentFindCandidates",');
for (const method of ["getObject", "getFileByName", "findObjectForFile", "getFirstObject"]) {
  add(`named-${method}`, hooks, `NAMED:${method}`, '', undefined);
}
for (const method of ["parse", "parseType", "getDefinition", "getClassDefinition", "getABAPFiles", "getMainABAPFile", "getInclude", "getIncludeFiles", "getIncludes", "getModule", "getModules", "getSequencedFiles", "getSQLViewName", "getDefinitionName", "listBadiDefinitions"]) {
  // Restrict edits to the artifact-method list, not the registry adapters.
  add(`artifact-${method}`, hooks, `ARTIFACT:${method}`, '', {
    getClassDefinition: "getMainABAPFile/getABAPFiles still link the same class owner",
    getMainABAPFile: "getABAPFiles still links the same cached ABAP owner",
    getIncludeFiles: "getIncludes/getABAPFiles still link the same group owner",
    getIncludes: "getInclude/getIncludeFiles still link the same group owner",
    getModules: "getModule and explicit group contexts still link the same owner",
    getSequencedFiles: "getMainABAPFile/getABAPFiles still link the same owner",
    getSQLViewName: "getSQLViewName calls the wrapped DDLS parse(), even when its parsed data is cached",
    getDefinitionName: "getDefinitionName calls the wrapped DDLS parse(), even when its parsed data is cached",
    listBadiDefinitions: "named badi-definition scan records the visited ENHS owner; current fixture does not cache BAdI metadata"
  }[method]);
}
for (const method of ["findFunctionModule", "isBadiDef", "findTypePoolType", "findTypePoolConstant", "findBehaviorDefinition"]) {
  add(`semantic-${method}`, hooks, `["${method}",`, '["absentMethod",');
}
add("semantic-lookupDDLS", hooks, '"lookupDDLS", "cds-alias"', '"absentMethod", "cds-alias"');
add("semantic-findInclude", hooks, '"findInclude", "function-group-include"', '"absentMethod", "function-group-include"');
add("semantic-findMains", hooks, '"findMains", "include-parent"', '"absentMethod", "include-parent"');
add("syntax-artifact", hooks, 'patch(syntax, "run",', 'patch(syntax, "absentRun",');
add("globals-update-artifact", hooks, 'patch(globals, "update",', 'patch(globals, "absentUpdate",');
for (const name of ["retained-registry-edit", "retained-registry-config-edit", "artifact-built-before-recording", "untraced-artifact", "lowering-built-before-recording"]) {
  add(`marker-${name}`, recorder, `"${name}"`, '"disabled-marker"',
    name.startsWith("retained-registry-") ? "Fresh-registry rebuilding replaces edited artifacts before recorder inventory; the retained-edit marker is a defensive fallback" : undefined);
}
add("stack-fallback", hooks, 'const direct = site[0] ?? "";', 'const direct = site[0];');
add("portable-sites", hooks, '.map(portableSite)', '.map((s) => s.trim())');
add("unknown-scan", hooks, 'kind: kind ?? "unknown-scan"', 'kind: kind ?? "classified"');
add("default-opt-in", facade, '(process.env.GOGEN_PROVENANCE === "1")', '!!options.cacheDir');
add("fm-lowering-query", recorder, 'if (active) {\n    const state = active.state(ctx.reg);', 'if (false) {\n    const state = active.state(ctx.reg);');
add("own-row-storage", recorder, 'rows: entries.flatMap((e) => [...e.queries.values()])', 'rows: []');
const scratch = mkdtempSync(join(tmpdir(), "provenance-mutations-"));
try {
  cpSync(join(root, "tools"), join(scratch, "tools"), {recursive: true});
  for (const file of ["package.json", "package-lock.json", "libs.lock.json"]) cpSync(join(root, file), join(scratch, file));
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const originals = new Map([facade, recorder, hooks].map((file) => [file, readFileSync(join(scratch, file), "utf8")]));
  const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=1",
    "tools/gogen/frontend-provenance.test.mjs", "tools/gogen/frontend-provenance-regression.test.mjs", "tools/gogen/frontend-queries.test.mjs"],
  {cwd: scratch, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024});
  const baseline = run();
  if (baseline.status !== 0) throw new Error(`scratch baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
  const results = [];
  for (const mutant of mutants) {
    for (const [file, source] of originals) writeFileSync(join(scratch, file), source);
    let source = originals.get(mutant.file);
    if (mutant.from.startsWith("ARTIFACT:") || mutant.from.startsWith("NAMED:")) {
      const artifact = mutant.from.startsWith("ARTIFACT:");
      const method = mutant.from.split(":")[1], begin = source.indexOf(artifact ? 'const methods = [' : 'for (const method of ["getObject"'), end = source.indexOf(artifact ? '];' : '])', begin);
      const list = source.slice(begin, end).replace(`"${method}"`, '"absentMethod"');
      source = source.slice(0, begin) + list + source.slice(end);
    } else {
      if (!source.includes(mutant.from)) throw new Error(`no mutation match: ${mutant.name}`);
      source = source.replaceAll(mutant.from, mutant.to);
    }
    if (mutant.name === "query-and-link-edges") source = source.replace('if (from && from !== key)', 'if (false)');
    writeFileSync(join(scratch, mutant.file), source);
    const result = run();
    if (result.signal || result.error) throw new Error(`mutation infrastructure: ${mutant.name}: ${result.error ?? result.signal}`);
    const failedTests = result.stdout.split("\n").filter((line) => /^✖|^not ok/.test(line));
    // Syntax/import errors are invalid mutants, not evidence of sensitivity.
    if (result.status !== 0 && !failedTests.length) throw new Error(`invalid mutant ${mutant.name}: ${result.stdout}\n${result.stderr}`);
    const killed = result.status !== 0;
    results.push({name: mutant.name, killed, failedTests, ...(!killed ? {reason: mutant.equivalent ?? "UNDOCUMENTED"} : {})});
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${mutant.name}${!killed ? `: ${mutant.equivalent ?? "UNDOCUMENTED"}` : ""}`);
  }
  const report = {baseline: "pass", killed: results.filter((r) => r.killed).length,
    survived: results.filter((r) => !r.killed).length, results};
  const arg = process.argv.indexOf("--report");
  if (arg >= 0) writeFileSync(resolve(process.argv[arg + 1]), JSON.stringify(report, null, 2) + "\n");
  if (results.some((r) => !r.killed && r.reason === "UNDOCUMENTED")) process.exitCode = 1;
} finally { rmSync(scratch, {recursive: true, force: true}); }
