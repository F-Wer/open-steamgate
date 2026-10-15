import {relative, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
function portableSite(line) {
  return line.trim().replace(/(?:file:\/\/)?\/[^\s()]+:\d+:\d+/g, (location) => {
    const match = location.replace(/^file:\/\//, "").match(/^(.*)(:\d+:\d+)$/);
    const path = match[1], modules = path.lastIndexOf("/node_modules/");
    if (modules >= 0) return path.slice(modules + 1) + match[2];
    const local = relative(repoRoot, path);
    return (!local.startsWith("../") && !isAbsolute(local) ? local : `<external>/${path.split("/").at(-1)}`) + match[2];
  });
}
// Version-specific observation adapters for the pinned abaplint core. Unknown
// registry iteration is always visible; adding a classification needs a test.
const objectKey = (obj) => obj?.getType ? `${obj.getType()} ${obj.getName().toUpperCase()}` : undefined;
const scalar = (v) => v === undefined ? null : typeof v === "string" ? v.toUpperCase() : v;

export function installHooks(core, requireCore, r) {
  const undo = [], patched = new Map(), owners = new WeakMap();
  const regProto = core.Registry.prototype;
  const rawObjects = regProto.getObjects;
  const rawFileObject = regProto.findObjectForFile;
  const patch = (proto, name, wrap) => {
    if (!proto || !Object.hasOwn(proto, name) || patched.get(proto)?.has(name)) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof descriptor.value !== "function") return;
    if (!patched.has(proto)) patched.set(proto, new Set());
    patched.get(proto).add(name);
    Object.defineProperty(proto, name, {...descriptor, value: wrap(descriptor.value)});
    undo.push(() => Object.defineProperty(proto, name, descriptor));
  };
  const register = (reg) => {
    const objects = [...rawObjects.call(reg)];
    for (const obj of objects) owners.set(obj, reg);
    return r.inventory(reg, objects);
  };
  const coreClass = (path, name) => requireCore(`@abaplint/core/build/src/${path}`)[name];
  const contextual = (proto, name, kind) => patch(proto, name, (fn) => function(...args) {
    return r.context(kind, args.map((a) => typeof a === "string" ? a.toUpperCase() : null), () => fn.apply(this, args));
  });
  // Named queries include their actual ordered result, including absence.
  for (const method of ["getObject", "getFileByName", "findObjectForFile", "getFirstObject"]) {
    patch(regProto, method, (fn) => function(...args) {
      const state = r.state(this);
      return r.context(method, args, () => {
        r.suppressed++;
        let found;
        try { found = fn.apply(this, args); } finally { r.suppressed--; }
        r.suppressed++;
        let obj;
        try { obj = method === "getFileByName" && found ? rawFileObject.call(this, found) : found; }
        finally { r.suppressed--; }
        if (obj) { owners.set(obj, this); r.link(state, obj); }
        const result = method === "getFileByName" ? (found ? [found.getFilename()] : []) : (objectKey(obj) ? [objectKey(obj)] : []);
        r.query(state, {kind: method, args: args.map((a) => a?.getFilename ? a.getFilename() : scalar(a)), result});
        return found;
      });
    });
  }
  for (const method of ["getObjects", "getObjectsByType"]) {
    patch(regProto, method, (fn) => function(...args) {
      const reg = this, state = r.state(reg), context = r.contexts.at(-1);
      const owner = r.current(state)?.key, phase = r.current(state)?.phase ?? "registry";
      const site = String(new Error().stack ?? "").split("\n").slice(2, 5).map(portableSite);
      // Classify the direct iteration site, not an outer syntax/run context:
      // an unexpected sweep nested inside a known pass must still fail closed.
      const direct = site[0] ?? "";
      let kind;
      if (/\/registry\.js:/.test(direct)) kind = context?.kind ?? "registry-inventory";
      else if (/\/find_global_definitions\.js:/.test(direct)) kind = "global-definitions";
      else if (/\/(cross_include_macros|include_graph)\.js:/.test(direct)) kind = "include-macro-context";
      else if (/\/(_current_scope|_procedural|ddic)\.js:/.test(direct)) kind = context?.kind;
      else if (direct.includes("frontend-provenance.mjs:") && context?.kind === "function-module-index") kind = context.kind;
      const query = {kind: kind ?? "unknown-scan", scan: method,
        args: args.map(scalar), result: [], complete: false, phase};
      if (kind && context?.kind === kind) query.queryArgs = context.args.map((a) => typeof a === "string" ? a : null);
      if (!kind) query.site = site;
      const suppressed = r.suppressed > 0;
      return (function* () {
        try {
          for (const obj of fn.apply(reg, args)) {
            owners.set(obj, reg);
            r.entry(state, objectKey(obj));
            query.result.push(objectKey(obj));
            yield obj;
          }
          query.complete = true;
        } finally { if (!suppressed) r.query(state, query, owner); }
      })();
    });
  }
  for (const name of ["parse", "findIssues", "findIssuesObject"]) patch(regProto, name, (fn) => function(...args) {
    register(this);
    return r.context(`registry-${name}`, [], () => fn.apply(this, args));
  });
  for (const name of ["isDirty", "getObjectCount", "getFiles"]) contextual(regProto, name, `registry-${name}`);

  // Wrap each implementation once, including inherited methods. Reads of a
  // cached object artifact create an edge even when its body makes no lookup.
  const methods = ["parse", "parseType", "getDefinition", "getClassDefinition", "getABAPFiles", "getMainABAPFile",
    "getInclude", "getIncludeFiles", "getIncludes", "getModule", "getModules", "getSequencedFiles", "getSQLViewName", "getDefinitionName", "listBadiDefinitions"];
  for (const cls of Object.values(core.Objects)) {
    for (let proto = cls?.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const method of methods) patch(proto, method, (fn) => function(...args) {
        const reg = owners.get(this) ?? (args.find((a) => a instanceof core.Registry));
        if (!reg) return fn.apply(this, args);
        owners.set(this, reg);
        const phase = method === "parse" ? "parse" : method === "parseType" ? "ddic-type" : "artifact-read";
        const state = r.state(reg), caller = r.current(state)?.key;
        const value = r.artifact(reg, this, phase, () => fn.apply(this, args));
        if (method === "getInclude" || method === "getModule") {
          r.query(state, {kind: method === "getInclude" ? "function-group-include" : "function-module-owner",
            args: args.map(scalar), result: value ? [objectKey(this)] : []}, caller);
        }
        return value;
      });
    }
  }
  const syntax = core.SyntaxLogic.prototype;
  patch(syntax, "run", (fn) => function(...args) {
    owners.set(this.object, this.reg);
    return r.artifact(this.reg, this.object, "syntax", () => fn.apply(this, args));
  });
  const globals = coreClass("abap/5_syntax/global_definitions/find_global_definitions", "FindGlobalDefinitions").prototype;
  contextual(globals, "run", "global-definitions");
  patch(globals, "update", (fn) => function(obj, ...args) {
    return r.artifact(this.reg, obj, "global-definition", () => fn.call(this, obj, ...args));
  });

  const scope = coreClass("abap/5_syntax/_current_scope", "CurrentScope").prototype;
  // Semantic queries surround the whole resolution, preserving names even for
  // scans which return no candidates, and distinguish implicit pool prefixes.
  const semantic = (proto, method, kind, argsOf = (args) => args.map(scalar)) => patch(proto, method, (fn) => function(...args) {
    const state = r.state(this.reg);
    return r.context(kind, argsOf(args), () => {
      const value = fn.apply(this, args);
      let result = [];
      if (value instanceof Set) result = [...value].map(objectKey).filter(Boolean);
      else if (value?.object) result = [objectKey(value.object)];
      else if (value) result = [typeof value === "boolean" ? true : value.getFilename?.() ?? value.getName?.() ?? "resolved"];
      r.query(state, {kind, args: argsOf(args), result});
      return value;
    });
  });
  for (const [method, kind] of [["findFunctionModule", "function-module-owner"], ["isBadiDef", "badi-definition"],
    ["findTypePoolType", "implicit-type-pool"], ["findTypePoolConstant", "implicit-type-pool-constant"],
    ["findBehaviorDefinition", "behavior-definition"]]) semantic(scope, method, kind);
  semantic(coreClass("ddic", "DDIC").prototype, "lookupDDLS", "cds-alias");
  const procedural = coreClass("abap/5_syntax/_procedural", "Procedural").prototype;
  semantic(procedural, "findInclude", "function-group-include", (args) => [args[0]?.concatTokens() ?? null]);
  const cross = coreClass("abap/cross_include_macros", "CrossIncludeMacros").prototype;
  contextual(cross, "run", "include-macro-context");
  semantic(cross, "findMains", "include-parent", (args) => [objectKey(args[1])]);
  // The core's candidate loop has no callback. Scope the original array's
  // iterator across each yield; preserve contents, order and early return.
  patch(cross, "findCandidates", (fn) => function(...args) {
    const candidates = fn.apply(this, args), reg = this.reg;
    Object.defineProperty(candidates, Symbol.iterator, {value: function* () {
      for (let i = 0; i < this.length; i++) {
        const obj = this[i], state = r.state(reg), key = r.link(state, obj);
        r.stack.push({state, key, phase: "include-macro-context"});
        try { yield obj; } finally { r.stack.pop(); }
      }
    }});
    return candidates;
  });
  contextual(coreClass("utils/include_graph", "IncludeGraph").prototype, "build", "include-graph");
  return () => { for (const restore of undo.reverse()) restore(); };
}
