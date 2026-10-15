// Re-evaluable query specifications for the pinned core. Unknown contracts
// refuse a v3 key. Array order and first/last winner policies are semantic.
import {createRequire} from "node:module";
import {core, inputSnapshot, objectKey, cdsInputDigest} from "./frontend-inventory.mjs";
import {currentQueryAnswer} from "./frontend-queries.mjs";
import {sourceOwnershipSafety} from "./frontend-owned.ts";
const require = createRequire(createRequire(import.meta.url).resolve("@abaplint/transpiler/package.json"));
const {CurrentScope} = require("@abaplint/core/build/src/abap/5_syntax/_current_scope");
const {DDIC} = require("@abaplint/core/build/src/ddic");
const {IncludeGraph} = require("@abaplint/core/build/src/utils/include_graph");
const {CrossIncludeMacros} = require("@abaplint/core/build/src/abap/cross_include_macros");
const methods = {"implicit-type-pool": "findTypePoolType", "implicit-type-pool-constant": "findTypePoolConstant",
  "badi-definition": "isBadiDef", "behavior-definition": "findBehaviorDefinition", "function-module-owner": "findFunctionModule"};
const simple = new Set(["getObject", "getFileByName", "findObjectForFile", "getFirstObject", "supplied", "locals", "lock", "ownershipSafety", "include-parent", "function-group-include", "cds-alias", "cds-mapping", ...Object.keys(methods)]);
const scans = new Set(["function-module-owner", "function-group-include", "cds-alias", "badi-definition", "include-macro-context"]);
export const supportedQuery = (q) => q.role === "artifact" && (q.scan ? scans : simple).has(q.kind)
  && (!q.scan || q.kind === "include-macro-context" || q.queryArgs?.length > 0);
export function querySpec(q) {
  return Object.fromEntries(["role", "artifact", "phase", "kind", "args", "queryArgs", "policy", "scan", "target"]
    .filter((k) => Object.hasOwn(q, k)).map((k) => [k, q[k]]));
}
export const queryAnswer = (q) => Object.fromEntries(["result", "providers", "parameters", "descriptor", "names", "dynamic", "complete"]
  .filter((k) => Object.hasOwn(q, k)).map((k) => [k, q[k]]));
const resultOf = (value) => value instanceof Set ? [...value].map(objectKey)
  : value?.object ? [objectKey(value.object)] : value ? [typeof value === "boolean" ? true : value.getFilename?.() ?? value.getName?.() ?? "resolved"] : [];

export function queryEvaluator(program) {
  const reg = program.reg, inventory = inputSnapshot(reg), objects = [...inventory.objects.values()].map((e) => e.obj);
  let ownership, includeGraph;
  const obj = (key) => inventory.objects.get(key)?.obj;
  const groupInclude = (q, name) => {
    // Procedural includes try their own FUGR, a PROG, then the first group.
    const owner = obj(q.artifact), include = name.replace(/^INCLUDE\s+/i, "").replace(/\s*\.$/, "");
    return (owner instanceof core.Objects.FunctionGroup ? owner.getInclude(include) : undefined)
      ?? reg.getObject("PROG", include)?.getABAPFiles()[0]
      ?? objects.filter((o) => o instanceof core.Objects.FunctionGroup).map((g) => g.getInclude(include)).find(Boolean);
  };
  return (q) => {
    if (!supportedQuery(q)) throw new Error(`unsupported query: ${q.kind}`);
    if (q.scan) {
      const candidates = q.scan === "getObjectsByType" ? objects.filter((o) => o.getType() === q.args[0]) : objects;
      const result = [];
      for (const candidate of candidates) {
        result.push(objectKey(candidate));
        const name = q.queryArgs?.[0];
        const wins = q.kind === "function-module-owner" ? candidate.getModule(name) !== undefined
          : q.kind === "function-group-include" ? candidate.getInclude(name.replace(/^INCLUDE\s+/i, "").replace(/\s*\.$/, "")) !== undefined
          : q.kind === "cds-alias" ? candidate.getSQLViewName() === name || candidate.getDefinitionName()?.toUpperCase() === name
          : q.kind === "badi-definition" ? candidate.listBadiDefinitions().some((d) => d.name.toUpperCase() === name) : false;
        // A winner returns before the generator resumes, even at the last
        // candidate. Exhaustion and an early stop are different observations.
        if (wins) return {result, complete: false};
      }
      return {result, complete: true};
    }
    if (q.kind === "cds-mapping") return {result: [], descriptor: cdsInputDigest(reg)};
    const indexed = currentQueryAnswer(program, q);
    if (indexed) return indexed;
    const [name] = q.args;
    if (q.kind === "getObject") { const found = reg.getObject(...q.args); return {result: found ? [objectKey(found)] : []}; }
    if (q.kind === "getFileByName") { const file = reg.getFileByName(name); return {result: file ? [file.getFilename()] : []}; }
    if (q.kind === "findObjectForFile") {
      // findObjectForFile uses exact filename spelling (unlike getFileByName).
      const found = objects.find((o) => o.getFiles().some((f) => f.getFilename() === name));
      return {result: found ? [objectKey(found)] : []};
    }
    if (q.kind === "getFirstObject") { const found = reg.getFirstObject(); return {result: found ? [objectKey(found)] : []}; }
    if (q.policy === "group-member") {
      const group = obj(q.target);
      if (!group) return {result: []};
      return {result: (q.kind === "function-group-include" ? group.getInclude(name) : group.getModule(name)) ? [q.target] : []};
    }
    if (q.kind === "function-module-owner" && q.policy === "gogen-last-wins") {
      let found;
      for (const group of objects.filter((o) => o instanceof core.Objects.FunctionGroup))
        if (group.getModules().some((m) => m.getName().toUpperCase() === name)) found = group;
      return {result: found ? [objectKey(found)] : []};
    }
    if (q.kind === "cds-alias") return {result: resultOf(new DDIC(reg).lookupDDLS(name))};
    if (q.kind === "function-group-include") return {result: resultOf(groupInclude(q, name))};
    if (q.kind === "include-parent") {
      includeGraph ??= new IncludeGraph(reg);
      return {result: resultOf(new CrossIncludeMacros(reg).findMains(includeGraph, obj(name)))};
    }
    if (q.kind === "ownershipSafety") {
      ownership ??= sourceOwnershipSafety(reg);
      const value = ownership.get(name);
      return {result: value ? [name] : [], providers: value ? [q.artifact] : [], names: [...value?.names ?? []], dynamic: value?.dynamic ?? false};
    }
    const scope = new CurrentScope(reg, obj(q.artifact));
    return {result: resultOf(scope[methods[q.kind]](...q.args))};
  };
}
