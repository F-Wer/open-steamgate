import {normalizeSource} from "./frontend-source.mjs";
import {dynamicStaticCall} from "./frontend-dynamic-call.mjs";
import {require, abaplint, Rearranger, Nodes, Statements, Structures, Expressions, BasicTypes,
  Unsupported, notInProgram, I, F, INT8, P31, S, C, X, XS, EXC, isExpr, isStmt, isStruct, isTok,
  tokenStr, upper, goName, refuseSorted, sameSort, sameType, composite, byRef, numeric, charlike} from "./frontend-base.mjs";
export {Unsupported, I, F, INT8, S, sameType, composite, byRef} from "./frontend-base.mjs";
import {inputOrigin} from "./frontend-inventory.mjs";
import {suppliedIndex, suppliedAnswer, suppliedSignature, localDiscovery, lockAnswer, finalOutput, rttiProjection} from "./frontend-queries.mjs";
import {enumerateObjects, auditedBookkeeping, withRole, beginProvenanceCompile} from "./frontend-provenance.mjs";
import {prepareArtifactDigests} from "./frontend-artifact-digests.mjs";
import {withProvenance, expandProgramSelection, withArtifact, resolvedFunctionModule} from "./frontend-provenance.mjs";
import {isSourceIdentity, readdirSync, readFileSync} from "./host-io-compat.mjs";
import {append} from "./append.ts";
import {lowerFindResults, inlineFindResultTypes} from "./frontend-find-results.ts";
import {hoistLocalConstants} from "./frontend-local-constants.mjs";
// ABAP -> IR, for the Go backend spike (tools/gogen/README.md).
//
// The front half is not ours: @abaplint/core parses, type-checks and builds
// the scopes; the transpiler's Rearranger turns a flat Source into a binary
// tree with ABAP's operator precedence. What this file adds is the IR. Every
// expression carries its type, every arithmetic expression carries the ABAP
// calculation type (the target included, measured on A4H: ANORMALIES), and
// every conversion is an explicit node. A backend has no semantics left to
// decide.
//
// Everything outside the subset is a named refusal (Unsupported), never a
// guess. A method whose body or signature is outside it is skipped and says
// why; a method that calls a skipped one is refused in turn.
import {resolveStatic as lowerStatic, staticSlot} from "./frontend-static.mjs";
import {prepareSession, finishSession, compileClass} from "./frontend-session.mjs";
import {syntaxDiagnostics} from "./frontend-diagnostics.ts";
import {sourceOwnershipSafety} from "./frontend-owned.mjs";
import {builtin} from "./frontend-builtins.mjs";
import {literalText, textLiteral} from "./frontend-literals.ts";
import {replaceStatement, lowerByteFind} from "./frontend-bytes.mjs";
import * as RIR from "../sqlscript-ir.mjs";
import {lower as lowerRelation} from "../sqlscript-lower.mjs";
import {hostPred as rangeHostPred} from "../ir-ranges.mjs";
import * as WIR from "../ir-writes.mjs";
import {samcOf, cdsSqlViews, cdsMappingError, rearrangedClass, inlineTableLocals} from "./frontend-analysis.mjs";
import {join} from "./host-io.ts";
import {caughtOnce, chainHas} from "./frontend-hierarchy.mjs";
import {typeKindOf, typeOf, rttiNamed, structOf, fieldOf, namedType} from "./frontend-types-signatures.mjs";

import {TRANSPILER_MEANING, P_GENERIC, NATIVE, kernelOf, nativeArgs, AMC_HOST, AMC_CALLER, amcProgramOf, amcMethod, NATIVE_FM, DESTINATION_FM, NATIVE_ME, nativeMeSig, RUNTIME_CX, RUNTIME_CX_SUPER} from "./frontend-classes-native.mjs";
import {sqlIrType, writeIrType, irCheck, lowName, mandtPred, andIr, sqlHost, sqlValue, SQL_OPS} from "./frontend-sql.mjs";

import {source, componentsOf, arith, sourceOperand, callMethodChain, excHolder,
  omittedArgument, omittedFactoryCall} from "./frontend-expressions-calls.mjs";

const byteStatementHelpers = {Nodes, Expressions, upper, isExpr, source, lvalue, convert, charlike, Unsupported, I, S, XS, findResults};
/** @type {WeakMap<import("@abaplint/core").IRegistry, Record<string, string>>} */ const cdsViewsByRegistry = new WeakMap();
const HOST_REPLACED = new Set(["ZCL_OSD_ENQ_KERNEL"]);

/* ------------------------------------------------------------------- program */

/**
 * Compile the named classes (and whatever interfaces they implement) out of
 * one or more folders of abapGit files. `files` narrows each folder to the
 * objects wanted, so a big pack can be read without parsing all of it.
 */
// skip(path): a file not to load, for a layered build where a later folder
// hides an object an earlier one holds (osg-build.mjs; ultra/packs)
export const compileProgram = withProvenance(function compileProgram({folders, objects, tolerant = false, skip = () => false, includeTests = false, registry, session, cacheDir}) {
  const config = abaplint.Config.getDefault().get();
  config.syntax = {...config.syntax, version: "v758", errorNamespace: "."};
  // only the syntax check and parser errors are read below (parser_error is a
  // rule too: without it a statement that does not parse is dropped silently);
  // the default config runs every lint rule, which was 45 % of a build
  config.rules = {check_syntax: true, parser_error: true};
  // Reset the ordinary module counter on each compile, as on main.
  FAE_N = 0;
  PERSIST_LOWERING = !!cacheDir;
  /** @type {import("@abaplint/core").IRegistry} */ const reg = registry ?? new abaplint.Registry(new abaplint.Config(JSON.stringify(config)));
  beginProvenanceCompile(reg);
  // Load every file for resolution; lower and report diagnostics for selected objects.
  /** @param {string} fn @returns {string} */ const objName = (fn) => fn.split("/").pop().split(".")[0].toLowerCase().replace(/#/g, "/");
  /** @type {string[]} */ let wanted = objects.map((o) => o.toLowerCase().replace(/#/g, "/"));
  /** @type {string[]} */ const ddls = [];
  /** @param {string} dir @returns {void} */ const walk = (dir) => {
    for (const e of readdirSync(dir, {withFileTypes: true}).sort((x, y) => x.name.localeCompare(y.name))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (isSourceIdentity(e.name) || skip(path)) continue;
      else if (e.name.toLowerCase().endsWith(".clas.testclasses.abap") && includeTests !== true
          && !includeTests?.has?.(objName(e.name).toUpperCase())) continue;
      else if (/\.(abap|xml)$/i.test(e.name)) {
        const source = readFileSync(path, "utf8");
        // Later rounds can select any loaded object. Normalize once before
        // parsing so newly selected app classes match a fresh final registry.
        reg.addFile(new abaplint.MemoryFile(e.name,
          normalizeSource(source, e.name, abaplint)));
      }
      // a CDS view's source: its SQL view name, for the table registry
      else if (/\.ddls\.asddls$/i.test(e.name)) ddls.push({filename: path, source: readFileSync(path, "utf8")});
    }
  };
  if (!registry) {
    for (const folder of folders) walk(folder);
    reg.parse();
    cdsViewsByRegistry.set(reg, cdsSqlViews(ddls));
  }
  REG = reg;
  // Load cache code and its module state only for an explicit opt-in.
  const diskFrontend = cacheDir ? require("./frontend-object-cache.mjs") : undefined;
  if (diskFrontend) {
    session = diskFrontend.cacheSession(session, reg, cacheDir);
    auditedBookkeeping("session-prepare", () => diskFrontend.prepareDiskSession(session, reg)); // Input guards only.
  } else {
    if (session?.disk) {
      session.classes.clear();
      delete session.disk;
      delete session.diskRoot;
      delete session.cacheDir;
    }
    auditedBookkeeping("session-prepare", () => prepareSession(session, reg)); // Input guards only.
  }
  const compile = diskFrontend ? diskFrontend.compileDiskClass : compileClass;
  // abaplint's RAISE syntax checker only accepts ObjectReferenceType, not
  // its generic REF TO object sibling. The dynamic raise path below checks
  // the actual registered object; retain every other syntax diagnostic.
  const diagnostics = syntaxDiagnostics(reg, (fn) => wanted.includes(objName(fn)), objName, session)
    .filter((d) => !d.message.endsWith("RAISE EXCEPTION, must be object reference, got GenericObjectReferenceType"));
  prepareArtifactDigests(reg, !!session);
  if (diagnostics.length && !tolerant) throw new Error(diagnostics.map((d) => d.message).join("\n"));
  const broken = new Set(diagnostics.map((d) => d.object.toLowerCase()));
  if (broken.size > 0) wanted = wanted.filter((w) => !broken.has(w));

  // A literal CALL FUNCTION is a dependency on its function group. The
  // registry already knows each module's group; include it before signatures
  // are built, including calls made by a module in another group.
  withRole("scheduling", () => expandProgramSelection(reg, wanted, abaplint));

  // Eager collections keep first writes inside the replay proxies. Anonymous
  // type identities use a Map so their ordered effects can be replayed too;
  // these keys already belong to the registry retained for this compilation.
  /** @type {import("./frontend-types.ts").FrontendProgram} */ const program = {anonStructs: new Map(), badStructs: new Map(), ddicOutputLen: new Map(),
    excAttrs: new Set(), dynStatics: new Set(), intfOwnAttrs: new Map(), interfaceAttrs: new Map(), structs: new Map(), consts: new Map(), classes: [], skipped: [], missing: new Set(), wanted: new Set(wanted.map(upper)),
    diagnostics, frontendCounts: {lowered: 0, reused: 0, loweredClasses: [], reusedClasses: []}, interfaces: new Set(), reg, sigs: new Map(), broken: [...broken], partial: [], events: new Map()};
  if (PERSIST_LOWERING) Object.assign(program, {faeN: 0, localDefs: new Map()});
  if (PERSIST_LOWERING) PROGRAM = program;
  program.supplied = suppliedIndex(reg, program.wanted, abaplint, suppliedMethods, declaringClass);
  PROGRAM = program;
  /** @type {import("./frontend-types.ts").CompilationContext} */ const ctx0 = {reg, program};
  // the local classes of the owners that have them compiled (LOCAL_CLASSES),
  // named OWNER:LOCAL: wanted before any class compiles, so the owner's
  // CREATE OBJECT ... TYPE lcl_x finds its class
  program.locals = new Map();
  program.localInterfaces = new Map();
  LOCAL_DEFS.clear();
  /** @type {import("./frontend-types.ts").LocalClass[]} */ const localDefs = [];
  for (const obj of enumerateObjects(reg, "local-dispatch", [], "scheduling", (o) => o instanceof abaplint.Objects.Class && wanted.includes(o.getName().toLowerCase()) && (includeTests || LOCAL_CLASSES.has(upper(o.getName()))))) {
    localDiscovery(reg, obj, includeTests === true || includeTests?.has?.(upper(obj.getName())), () => {
    if (LOCAL_CLASSES.has(upper(obj.getName()))) {
      const top = new abaplint.SyntaxLogic(reg, obj).run().spaghetti.getTop();
      for (const file of obj.getABAPFiles()) {
        for (const match of file.getRaw().matchAll(/\bINTERFACE\s+(LIF_[A-Z0-9_]+)\s*\./gi)) {
          const name = upper(match[1]);
          const def = top.getChildren().find((s) => s.findInterfaceDefinition(name))?.findInterfaceDefinition(name);
          if (def) program.localInterfaces.set(`${upper(obj.getName())}|${name}`, {def, source: file.getRaw()});
        }
      }
    }
    for (const l of localClasses(reg, obj, includeTests === true || includeTests?.has?.(upper(obj.getName())))) {
      program.locals.set(`${upper(obj.getName())}|${l.local}`, l.name);
      program.wanted.add(l.name);
      (PERSIST_LOWERING ? program.localDefs : LOCAL_DEFS).set(l.name, l.def);
      localDefs.push(l);
    }
    return {names: [...program.localInterfaces.keys(), ...program.locals.values()].filter((k) => k.startsWith(`${upper(obj.getName())}|`) || k.startsWith(`${upper(obj.getName())}:`)), value: undefined}; });
  }
  // parity-wave1: the function groups named are compiled too, one pseudo
  // class FUGR:<group> per group with a static method per module; their
  // signatures are known before any class compiles, so a CALL FUNCTION of
  // one of their modules is a call (functionGroupSignatures, callFunction)
  program.functionModules = new Map();
  const groups = enumerateObjects(reg, "selected-groups", wanted, "scheduling", (o) => o instanceof abaplint.Objects.FunctionGroup && wanted.includes(o.getName().toLowerCase()));
  // a group the front end cannot even read (an error that is not a refusal)
  // is left out whole, named in skipped, and its modules stay refused
  const readable = groups.filter((g) => {
    try { withArtifact(ctx0, g, () => functionGroupSignatures(ctx0, g), "function-signature"); return true; } catch (e) {
      program.skipped.push(`${fugrOwner(g)}: ${e.message}`);
      for (const [k, v] of program.functionModules) if (v.owner === fugrOwner(g)) program.functionModules.delete(k);
      return false;
    }
  });
  // lock objects must be known before methods compile: their key order is
  // part of every generated ENQUEUE / DEQUEUE argument
  program.lockObjects = lockObjectRegistry(reg, program);
  const lowerClass = (ctx, obj) => {
    const saved = PROGRAM;
    PROGRAM = ctx.program; // Global type helpers must use the tracked program too.
    try { return classIr(ctx, obj); } finally { PROGRAM = saved; }
  };
  for (const obj of enumerateObjects(reg, "selected-classes", wanted, "scheduling", (o) => o instanceof abaplint.Objects.Class && wanted.includes(o.getName().toLowerCase()))) program.classes.push(compile(ctx0, obj, lowerClass, session));
  for (const l of localDefs) program.classes.push(compile(ctx0, l, lowerClass, session));
  for (const g of readable) program.classes.push(withArtifact(ctx0, g, () => functionGroupIr(ctx0, g)));
  // every interface used as a reference type: its methods whose signature
  // types, which is what a class must provide to satisfy it
  program.interfaceMethods = new Map();
  withRole("final-output", () => { /** @type {import("./frontend-types.ts").CompilationContext} */ const ictx = {reg, program};
  let pending = [...program.interfaces];
  while (pending.length > 0) {
    for (const name of pending) {
      // its own methods and those of the interfaces it includes (INTERFACES
      // inside an interface), which are called as COMP~M through it
      /** @type {import("./frontend-types.ts").MethodSignature[]} */ const sigs = [];
      for (const i of [name, ...componentInterfaces(reg, name)]) {
        const all = reg.getObject("INTF", i)?.getDefinition()?.getMethodDefinitions();
        if (!all) continue;
        append(sigs, Array.from(Array.isArray(all) ? all : all.getAll()).map((m) => methodSignature(ictx, i, `${i}~${upper(m.getName())}`)));
      }
      // a CLASS-METHODS of an interface is the class's function, not a method of the reference
      program.interfaceMethods.set(name, sigs.filter((x) => !x.unsupported && !x.static));
      interfaceAttributes(program, name);
    }
    pending = [...program.interfaces].filter((n) => !program.interfaceMethods.has(n));
  }
  });
  program.rtti = finalOutput(reg, "rtti", () => rttiTable(reg, program));
  program.exceptionSupers = finalOutput(reg, "exception-supers", () => exceptionSupers(reg, program));
  program.cdsViews = cdsViewsByRegistry.get(reg) ?? cdsViewsByRegistry.get(inputOrigin(reg)) ?? {};
  program.tables = finalOutput(reg, "tables", () => tableRegistry(reg, program));
  program.lockObjects = finalOutput(reg, "locks", () => lockObjectRegistry(reg, program, "final-output"));
  auditedBookkeeping("session-finalize", () => finishSession(session, reg)); // File guards, no resolution.
  Object.assign(program, {amcChannels: samcOf(folders), ownershipSafety: session ? (session.ownershipSafety ??= sourceOwnershipSafety(reg)) : sourceOwnershipSafety(reg)});
  session?.disk?.finish(program); return program;
});

/**
 * The table registry (go/abap tables.go, README "The table registry"): every
 * TABL and DDIC view the registry has, in name order, as
 *   {name, view, client, key: [..], columns: [{name, kind, len, dec, key, type}],
 *    row: <the Go struct type, when every column is in the subset> | why}
 * where kind is the type kind letter (C N D T I 8 F P g y X), len the
 * characters of C N X and the bytes of P, and type the column's type in the
 * relational IR (sqlscript-ir.mjs T: C/len for C and N, I, INT8, P/digits/
 * dec, STRING, D, X/len, XSTRING; null where the IR has none). Built from
 * the same DDIC facts the SELECT path reads (dbTable), after the classes, so
 * that the row types it adds change nothing they compiled.
 */
/** the table registry as the column registry of the dynamic Open SQL
 * condition parser: {NAME: {view, client, key, columns: [{name, kind, len,
 * dec, key, type}]}}, JSON as it stands (README "The table registry") */
export function columnRegistry(program) {
  return {
    tables: Object.fromEntries((program.tables ?? []).map((t) => [t.name, {view: t.view, client: t.client, key: t.key,
      ...(t.sqlView ? {sqlView: t.sqlView} : {}), ...(t.cds ? {cds: t.cds} : {}),
      // tools/ir-osql-where.mjs osqlWherePredicate(text, columns) as it is
      columns: whereColumns(t),
      fields: t.columns.map((c) => ({name: c.name, kind: c.kind, len: c.len, dec: c.dec, key: c.key}))}])),
    cdsViews: program.cdsViews ?? {},
  };
}

/** {COL: {type, kind?}}: the columns argument of osqlWherePredicate
 * (tools/ir-osql-where.mjs), NUMC marked; a column with no IR type is left
 * out, as the parser could not compare it anyway */
export function whereColumns(t) {
  return Object.fromEntries(t.columns.filter((c) => c.type !== null).map((c) => [c.name, c.kind === "N" ? {type: c.type, kind: "NUMC"} : {type: c.type}]));
}

/** @param {import("@abaplint/core").IRegistry} reg @param {import("./frontend-types.ts").FrontendProgram} program @returns {import("./frontend-types.ts").FrontendTable[]} */ export function tableRegistry(reg, program) {
  /** @type {import("./frontend-types.ts").FrontendTable[]} */ const out = [];
  const saved = [program.currentClass, program.currentTypes];
  program.currentClass = undefined;
  program.currentTypes = undefined;
  try {
    for (const obj of enumerateObjects(reg, "table-inventory", [], "final-output", (o) => o instanceof abaplint.Objects.Table || o instanceof abaplint.Objects.View)) {
      const view = obj instanceof abaplint.Objects.View;
      if (!(obj instanceof abaplint.Objects.Table) && !view) continue;
      withArtifact({reg}, obj, () => { const name = upper(obj.getName());
      let st;
      try { st = obj.parseType(reg); } catch { return; }
      if (!(st instanceof BasicTypes.StructureType)) return;
      let key = [];
      try { key = view ? [] : (obj.listKeys?.(reg) ?? []).map(upper); } catch { key = []; }
      const columns = st.getComponents().map((c) => {
        const kind = typeKindOf(c.type);
        const len = ["C", "N", "X"].includes(kind) ? c.type.getLength() : kind === "P" ? c.type.getLength() : 0;
        const dec = kind === "P" ? c.type.getDecimals() : 0;
        const ir = {C: {abap: "C", len}, N: {abap: "C", len}, I: {abap: "I"}, 8: {abap: "INT8"}, P: {abap: "P", len: 2 * len - 1, dec},
          g: {abap: "STRING"}, D: {abap: "D"}, X: {abap: "X", len}, y: {abap: "XSTRING"}}[kind] ?? null;
        return {name: upper(c.name), kind, len, dec, key: key.includes(upper(c.name)), type: ir};
      });
      const entry = {name, view, client: columns.some((c) => c.name === "MANDT"), key, columns};
      // a view over a client-dependent table without MANDT hides the client
      // (dbTable refuses it at build time; a read by name at run time does
      // the same, go/abap selectdyn.go)
      if (view && !entry.client) {
        const hidden = [...new Set((obj.getFields() ?? []).map((f) => upper(f.TABNAME)))].find((b) => {
          try {
            const bt = reg.getObject("TABL", b)?.parseType(reg);
            return bt instanceof BasicTypes.StructureType && bt.getComponents().some((c) => upper(c.name) === "MANDT");
          } catch { return false; }
        });
        if (hidden) entry.hidesClient = hidden;
      }
      // a CDS name and its SQL view (both are views here, gen/cds writes the
      // DDIC view under each name); the client is the SQL view's, which is
      // where MANDT is (open-steamgate #45)
      const sqlView = view ? program.cdsViews?.[name] : undefined;
      if (sqlView && sqlView !== name) entry.sqlView = sqlView;
      const cds = Object.entries(program.cdsViews ?? {}).find(([, v]) => v === name)?.[0];
      if (cds && cds !== name) entry.cds = cds;
      try {
        entry.row = typeOf(st, name, program);
        if (entry.row.k !== "struct") throw new Unsupported(`${name}: not a flat structure`);
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        delete entry.row;
        entry.why = e.message;
      }
      out.push(entry); }, "table-output");
    }
  } finally {
    [program.currentClass, program.currentTypes] = saved;
  }
  // the other names of the dictionary: CREATE DATA ... TYPE (name) of one
  // of them is refused by name, an unknown name is CX_SY_CREATE_DATA_ERROR
  program.ddicNames = [...program.rtti.known].filter((n) => !/=>/.test(n) && !out.some((t) => t.name === n)).sort();
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** each ENQU object's primary table, keyed by the object name */
/** @param {import("@abaplint/core").IRegistry} reg @param {import("./frontend-types.ts").FrontendProgram} program @param {string} [role] @returns {Map<string, import("./frontend-types.ts").LockObject>} */ export function lockObjectRegistry(reg, program, role = "scheduling") {
  /** @type {Map<string, import("./frontend-types.ts").LockObject>} */ const out = new Map();
  for (const obj of enumerateObjects(reg, "lock-inventory", [], role, (o) => o instanceof abaplint.Objects.LockObject)) {
    withArtifact({reg}, obj, () => {
    const name = upper(obj.getName());
    const table = upper(obj.getPrimaryTable() ?? "");
    const tableObject = reg.getObject("TABL", table);
    if (tableObject === undefined) return;
    try {
      const key = (tableObject.listKeys?.(reg) ?? []).map(upper);
      const structure = tableObject.parseType(reg);
      const columns = new Map(structure.getComponents().map((c) => [upper(c.name), c.type]));
      const fields = key.map((field) => {
        const type = columns.get(field), kind = typeKindOf(type);
        // Node request(): getLength() when supplied, otherwise the length
        // of the component's initial value (integer zero is "0").
        const length = ["C", "N", "X", "P"].includes(kind) ? type.getLength()
          : ({D: 8, T: 6, I: 1, "8": 1})[kind];
        if (!Number.isInteger(length) || length <= 0) throw new Unsupported(`lock table ${table} field ${field}: cannot size key kind ${kind}`);
        return {name: field, kind, length};
      });
      out.set(name, {name, table, key, fields});
    } catch (e) {
      if (e instanceof Unsupported) throw e;
      // an unreadable table is named by the call's normal dictionary refusal
    }
    }, "lock-descriptor");
  }
  return out;
}

/**
 * What RTTI (cl_abap_typedescr=>describe_by_name) can describe, for the Go
 * host, which has no transpiler kernel: the structures of the dictionary and
 * the structured TYPES of the compiled classes (CLASS=>TYPE), each as its
 * components and their type kinds. `known` is every name the registry has,
 * so a name that exists but is not a structure dumps instead of reading as
 * TYPE_NOT_FOUND.
 */
/** @param {import("@abaplint/core").IRegistry} reg @param {import("./frontend-types.ts").FrontendProgram} program @returns {import("./frontend-types.ts").RttiTable} */ function rttiTable(reg, program) {
  /** @type {Map<string, {name: string; kind: string}[]>} */ const structs = new Map();
  /** @param {string} name @param {import("@abaplint/core").AbstractType} t @returns {void} */ const add = (name, t) => {
    if (!(t instanceof BasicTypes.StructureType)) return;
    structs.set(name, t.getComponents().map((c) => ({name: upper(c.name), kind: typeKindOf(c.type)})));
  };
  /** @type {Set<string>} */ const known = new Set();
  for (const obj of enumerateObjects(reg, "rtti-inventory", [], "final-output")) {
    const n = upper(obj.getName());
    if (["TABL", "DTEL", "TTYP", "DOMA", "CLAS", "INTF", "VIEW", "DDLS"].includes(obj.getType())) known.add(n);
    try {
      if (obj instanceof abaplint.Objects.Table) add(n, obj.parseType(reg));
      // a DDIC view (the SQL views of OSG's CDS entities, gen/cds/*.view.xml)
      // is a structure of its fields too (ultra/sadl: the SADL MPC's entity types)
      if (obj instanceof abaplint.Objects.View) add(n, obj.parseType(reg));
      if (obj instanceof abaplint.Objects.Class && program.wanted.has(n)) {
        for (const td of obj.getDefinition()?.getTypeDefinitions().getAll() ?? []) {
          known.add(`${n}=>${upper(td.type.getName())}`);
          add(`${n}=>${upper(td.type.getName())}`, td.type.getType());
        }
      }
    } catch { /* a type abaplint cannot resolve is simply not described */ }
    rttiProjection(reg, obj, () => [[...known].filter((k) => k === n || k.startsWith(`${n}=>`)), [...structs].filter(([k]) => k === n || k.startsWith(`${n}=>`))]);
  }
  return {structs, known};
}


/** ALIASES a FOR i~m of a class or interface (or a superclass): i~m */
/** @param {import("@abaplint/core").IRegistry} reg @param {string} owner @param {string} name @returns {string | undefined} */ function aliasTarget(reg, owner, name) {
  for (const o of [owner, ...ancestors(reg, owner)]) {
    const def = reg.getObject("INTF", o)?.getDefinition() ?? clasDef(reg, o);
    const all = def?.getAliases?.();
    /** @type {ReturnType<import("@abaplint/core").IInterfaceDefinition["getAliases"]>} */ const list = Array.isArray(all) ? all : all?.getAll?.() ?? [];
    const hit = list.find((x) => upper(x.getName()) === name);
    if (hit) return upper(hit.getComponent());
  }
  return undefined;
}

/**
 * p IS SUPPLIED: the callee must know whether its caller passed p, so every
 * parameter some implementation asks about gets a hidden SUP_<p> ('X' or ''),
 * filled in at each call. Keyed by the class that declares the method, so a
 * redefinition and the class interface keep one signature.
 */
// per parsed file, the methods that ask IS SUPPLIED: a closure build calls
// suppliedParams once a round over the same registry (abapiti's Registry
// set, 2110 classes: 10 s of a 104 s build before this)
/** @type {WeakMap<import("@abaplint/core").ABAPFile, import("./frontend-types.ts").SuppliedMethod[]>} */ const suppliedOfFile = new WeakMap();
/** @param {import("@abaplint/core").ABAPFile} file @returns {import("./frontend-types.ts").SuppliedMethod[]} */ function suppliedMethods(file) {
  let methods = suppliedOfFile.get(file);
  if (methods) return methods;
  methods = [];
  // the parsed structure, not the raw text: a macro of another include can
  // bring the IS SUPPLIED in (#694 critic)
  for (const m of file.getStructure()?.findAllStructures(Structures.Method) ?? []) {
    const found = [...m.concatTokens().matchAll(/(\w+)\s+IS\s+(?:NOT\s+)?SUPPLIED/gi)].map((x) => upper(x[1]));
    methods.push({name: upper(m.findFirstExpression(Expressions.MethodName).concatTokens()), found});
  }
  suppliedOfFile.set(file, methods);
  return methods;
}

/** the hidden SUP_<p> parameters of a method, after its own */
/** @param {import("./frontend-types.ts").FrontendProgram} program @param {string} key @param {readonly import("./frontend-types.ts").FrontendParam[]} params @returns {readonly import("./frontend-types.ts").FrontendParam[]} */ function withSupplied(program, key, params) {
  const set = suppliedAnswer(program, key);
  if (!set) return params;
  /** @type {import("./ir.ts").Param[]} */ const hidden = params.filter((p) => set.has(p.name)).map((p) => ({name: `SUP_${p.name}`, dir: "importing", byValue: true, type: C(1), optional: true, suppliedOf: p.name}));
  return [...params, ...hidden];
}

/** the interfaces an interface includes, transitively */
/** @param {import("@abaplint/core").IRegistry} reg @param {string} intf @param {Set<string>} [seen] @returns {string[]} */ function componentInterfaces(reg, intf, seen = new Set()) {
  for (const c of reg.getObject("INTF", intf)?.getDefinition()?.getImplementing?.() ?? []) {
    const n = upper(c.name);
    if (!seen.has(n)) { seen.add(n); componentInterfaces(reg, n, seen); }
  }
  return [...seen];
}

/*
 * Local classes (a class's locals_imp), compiled only for the owners named
 * here: the ICF shim creates its server object as a local class. Each is
 * compiled as a class named OWNER:LOCAL (no ABAP name can hold the colon, so
 * CREATE OBJECT ... TYPE (name) never reaches one), out of an object that
 * answers what classIr asks of a global class. A local class with a
 * superclass or a constructor of its own is refused: neither is looked up
 * outside the registry yet.
 */
// ultra/json: /UI2/CL_JSON (LCL_PARSER, LCL_STACK) and CL_SXML_STRING_READER
// (LCL_READER and its node classes; LCL_JSON_PARSER's PARSE is kernel code,
// NATIVE below) carry the deserialize path ZCL_OSD_STATUS=>REFRESH takes
// parity-wave2: CL_ABAP_ZIP (LCL_STREAM: the zip's bytes and its CRC-32),
// the SEGW RepoSet zip
const LOCAL_CLASSES = new Set(["CL_EXPRESS_ICF_SHIM", "/UI2/CL_JSON", "CL_SXML_STRING_READER", "CL_ABAP_ZIP", "CL_ABAP_UNIT_ASSERT", "ZCL_AJSON"]);
// a class's definition: a global class of the registry, or a local class of
// LOCAL_CLASSES by its compiled name (OWNER:LOCAL)
// Track local definitions only for persisted lowerings. Ordinary sessions
// retain main's module-local map, without adding reads to their transcripts.
/** @type {Map<string, import("@abaplint/core").IClassDefinition>} */ const LOCAL_DEFS = new Map();
let PERSIST_LOWERING = false;
/** @param {import("@abaplint/core").IRegistry} reg @param {string} name @returns {import("@abaplint/core").IClassDefinition | undefined} */ const clasDef = (reg, name) => (PERSIST_LOWERING ? PROGRAM.localDefs : LOCAL_DEFS).get(name) ?? reg.getObject("CLAS", name)?.getDefinition();

/** @param {import("@abaplint/core").IRegistry} reg @param {import("@abaplint/core").Objects.Class} obj @param {boolean} [includeTests] @returns {import("./frontend-types.ts").LocalClass[]} */ function localClasses(reg, obj, includeTests = false) {
  const owner = upper(obj.getName());
  const top = new abaplint.SyntaxLogic(reg, obj).run().spaghetti.getTop();
  /** @type {import("./frontend-types.ts").LocalClass[]} */ const out = [];
  for (const file of obj.getABAPFiles()) {
    if (file === obj.getMainABAPFile()) continue;
    const testInclude = /\.testclasses\.abap$/i.test(file.getFilename());
    if (testInclude && !includeTests) continue;
    if (!testInclude && !LOCAL_CLASSES.has(owner)) continue;
    for (const info of file.getInfo().listClassDefinitions()) {
      const local = upper(info.name);
      // AJSON's parser is the only local path needed by PARSE. Its mutator
      // locals implement local interfaces that the compiler cannot model.
      if (owner === "ZCL_AJSON" && !["LCL_JSON_PARSER", "LCL_UTILS", "LCL_JSON_SERIALIZER", "LCL_ABAP_TO_JSON"].includes(local)) continue;
      const def = findScope(top, "class_definition", local)?.findClassDefinition(local);
      if (def === undefined) continue;
      out.push({
        name: `${owner}:${local}`, owner, local, obj, def, file,
        getName: () => `${owner}:${local}`,
        getMainABAPFile: () => file,
        getDefinition: () => def,
      });
    }
  }
  return out;
}

/*
 * Function modules (parity-wave1, A4H ZCL_GOGEN_T_FM): a function group is
 * compiled as a pseudo class FUGR:<group> whose static methods are its
 * modules. A module's parameters are typed from its function scope (the
 * signature in the group's XML, as abaplint reads it): IMPORTING, EXPORTING
 * and CHANGING as a method's, TABLES as a CHANGING table by reference. The
 * caller does the VALUE( ) part (callFunction): an EXPORTING or CHANGING
 * passed by value goes through a copy that is written back only when the
 * module ends normally, which is what A4H showed for a RAISE. A group with
 * global data (DATA in its TOP include) or a module with a global
 * interface is not compiled: its modules are stubs that dump.
 */
function fugrOwner(g) { return `FUGR:${upper(g.getName())}`; }

function functionGroupSignatures(ctx0, g) {
  const {reg, program} = ctx0;
  const owner = fugrOwner(g);
  program.wanted.add(owner);
  program.currentClass = goName(owner);
  program.currentOwner = owner;
  program.currentTypes = new Set();
  let spaghetti;
  try { spaghetti = new abaplint.SyntaxLogic(reg, g).run().spaghetti; } catch { spaghetti = undefined; }
  const top = spaghetti?.getTop();
  const globalData = g.getABAPFiles().some((f) => /top\.abap$/i.test(f.getFilename()) && f.getStatements().some((st) => st.get() instanceof Statements.Data || st.get() instanceof Statements.DataBegin || st.get() instanceof Statements.Tables));
  const updateModules = new Set([...(g.getXMLFile()?.getRaw() ?? "").matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .filter((m) => /<UPDATE_TASK>/.test(m[1])).map((m) => upper(/<FUNCNAME>([^<]*)<\/FUNCNAME>/.exec(m[1])?.[1] ?? "")));
  for (const m of g.getModules()) {
    const name = upper(m.getName());
    const where = `${owner}=>${name}`;
    let sig;
    try {
      if (globalData) throw new Unsupported(`function group ${upper(g.getName())} has global data (DATA in its TOP include), not in the subset`);
      if (m.isGlobalParameters()) throw new Unsupported(`${name}: a module with a global interface`);
      const scope = top && findScopeNamed(top, "function", name);
      if (!scope) throw new Unsupported(`${name}: no function scope`);
      const vars = scope.getData().vars;
      const params = m.getParameters().map((p) => {
        const pn = upper(p.name);
        const id = vars[pn] ?? vars[pn.toLowerCase()];
        if (!id) throw new Unsupported(`${name}: parameter ${pn} has no type in the function scope`);
        // a TABLES parameter is a standard table with a default key (abaplint
        // types it as a table with a header line and no access kind); the
        // header line itself is not in the subset, a use of it is refused
        const it = id.getType();
        let type = p.direction === "tables" && it instanceof BasicTypes.TableType
          ? {k: "table", row: typeOf(it.getRowType(), `${where} ${pn}`, program), skey: "default"} : typeOf(it, `${where} ${pn}`, program);
        if (p.direction === "tables" && type.k !== "table") throw new Unsupported(`${name}: TABLES ${pn} is a ${type.k}`);
        // Untyped TABLES must retain the caller's row descriptor and storage.
        if (p.direction === "tables" && type.row.k === "data") type = {k: "data", table: true};
        const dir = p.direction === "tables" ? "changing" : p.direction;
        return {name: pn, dir, byValue: p.direction === "tables" ? false : p.passByValue, type,
          default: p.defaultValue, optional: p.optional || p.defaultValue !== undefined || p.direction === "exporting" || p.direction === "tables",
          tables: p.direction === "tables"};
      });
      sig = {name, static: true, private: false, abstract: false, params, returning: null, fm: true};
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      sig = {name, unsupported: e.message};
    }
    program.functionModules.set(name, {owner, group: g, module: m, sig, top, spaghetti, updateTask: updateModules.has(name)});
  }
}

function functionGroupIr(ctx0, g) {
  const {reg, program} = ctx0;
  const owner = fugrOwner(g);
  program.currentClass = goName(owner);
  program.currentOwner = owner;
  program.currentTypes = new Set();
  const signatures = new Map();
  const cls = {name: owner, attributes: [], methods: [], constructor: null, stubs: [], interfaces: [], super: null, abstract: false, abstracts: [], signatures, instanceEvents: false};
  const fms = [...program.functionModules.values()].filter((x) => x.owner === owner);
  for (const x of fms) signatures.set(x.sig.name ?? upper(x.module.getName()), x.sig);
  for (const x of fms) {
    const name = upper(x.module.getName());
    const sig = x.sig;
    const file = g.getABAPFiles().find((f) => f.getStructure()?.findAllStructures(Structures.FunctionModule)
      .some((fm) => upper(fm.findFirstExpression(Expressions.Field)?.concatTokens() ?? "") === name));
    const node = file?.getStructure()?.findAllStructures(Structures.FunctionModule)
      .find((fm) => upper(fm.findFirstExpression(Expressions.Field)?.concatTokens() ?? "") === name);
    const skip = (why) => {
      program.skipped.push(`${owner}=>${name}: ${why}`);
      if (!sig.unsupported) cls.stubs.push({...sig, reason: why, ...(node ? {pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}} : {})});
    };
    if (sig.unsupported) { skip(sig.unsupported); continue; }
    if (!file || !node) { skip("no source"); continue; }
    try {
      const scope = findScopeNamed(x.top, "function", name);
      const ctx = {program, reg, className: owner, scopeName: owner, owner, method: name, sig, signatures, scope, file, spaghetti: x.spaghetti, locals: new Map(), temps: 0};
      const known = new Set(sig.params.map((p) => p.name));
      ctx.fieldSymbols = new Map();
      for (const [vname, id] of Object.entries(scope.getData().vars)) {
        if (known.has(vname)) continue;
        const t = typeOf(id.getType(), `${owner}=>${name} ${vname}`, program);
        if (vname.startsWith("<")) {
          if (!["struct", "data", "table", "string", "c", "i", "int8", "n", "d", "t", "x", "xstring", "p", "f"].includes(t.k)) throw new Unsupported(`field symbol ${vname} of a ${t.k}`);
          ctx.fieldSymbols.set(vname, t);
        } else {
          ctx.locals.set(vname, t);
        }
      }
      const body = node.findDirectStructure(Structures.Body);
      ctx.sinkUnsafe = !!body?.findAllExpressionsRecursive(Expressions.Dynamic).length;
      ctx.inits = [];
      hoistLocalConstants(body, ctx, {Nodes, Structures, Statements, Expressions, isTok, isExpr, isStruct, isStmt, upper, goName, initialValue, Unsupported});
      const bodyStatements = body === undefined ? [] : block(body, ctx);
      const compiled = [];
      append(compiled, ctx.inits, bodyStatements);
      // an update-task module marks the LUW on entry, after its caller's
      // arguments are evaluated, like Node's wrapper (osd-enq-host.mjs)
      if (x.updateTask) compiled.unshift({s: "note_update_task"});
      cls.methods.push({...sig, fieldSymbols: [...ctx.fieldSymbols].map(([n, t]) => ({name: n, type: t})), locals: [...ctx.locals].map(([n, t]) => ({name: n, type: t})).sort((a, b) => a.name.localeCompare(b.name)),
        body: compiled, sinkUnsafe: !!ctx.sinkUnsafe, calls: ctx.calls ?? [], pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}});
    } catch (e) {
      // a module is not a class: a path of the front end written for classes
      // may fail outside a refusal; such a module becomes a dumping stub
      if (e.message.startsWith("local constant name collision:")) throw e;
      skip(e instanceof Unsupported ? e.message : `the front end failed on a function module: ${e.message}`);
    }
  }
  return cls;
}


/** kept for the numeric bench sample: one folder, every class in it */
export function readClass(folder) {
  const objects = [...new Set(readdirSync(folder).map((f) => f.split(".")[0]))];
  return compileProgram({folders: [folder], objects}).classes;
}



/** CALL FUNCTION of a module the host implements (NATIVE_FM) */
function callFunction(node, ctx, text) {
  const nameNode = node.findDirectExpression(Expressions.FunctionName);
  const lit = /^'([^']+)'$/.exec(nameNode?.concatTokens() ?? "");
  if (lit === null) throw new Unsupported(`CALL FUNCTION by a name that is not a literal: ${text}`);
  const name = upper(lit[1]);
  const lockCall = lockFunctionCall(node, ctx, text, name);
  if (lockCall !== undefined) return lockCall;
  // DESTINATION 'AMDP' (tools/amdp-destination.mjs on Node): SQLScript runs
  // in a HANA, which the Go host has none of. Node without one raises
  // CX_SY_DYN_CALL_ILLEGAL_FUNC from the destination before any parameter
  // is passed, and the ABAP around such a call catches cx_root to say so
  // (ZCL_OSD_AMDP_SBX=>ENGINE answers "none"); the Go host raises the same
  // class at the call. 'STORE' is answered below (DESTINATION_FM); any
  // other destination stays refused.
  const dest = /\bDESTINATION\s+'([^']*)'/i.exec(text)?.[1];
  if (dest !== undefined && upper(dest) === "AMDP" && !/\b(IN\s+UPDATE\s+TASK|STARTING\s+NEW\s+TASK|IN\s+BACKGROUND)\b/i.test(text)) {
    return {s: "raise_runtime", cls: "CX_SY_DYN_CALL_ILLEGAL_FUNC",
      op: `CALL FUNCTION '${name}' DESTINATION 'AMDP': this host has no database that speaks SQLScript (OSGo runs on SQLite; an AMDP method needs a HANA)`};
  }
  // DESTINATION 'STORE' and the module it answers (DESTINATION_FM): a
  // host function like NATIVE_FM, reached only through its destination
  const viaDest = dest === undefined ? undefined : DESTINATION_FM.get(`${upper(dest)} ${name}`);
  const fm = viaDest ?? (dest === undefined ? NATIVE_FM.get(name) : undefined);
  if (fm === undefined && dest === undefined && resolvedFunctionModule(ctx, name)) return compiledFunctionCall(node, ctx, text, name);
  if (fm === undefined && dest !== undefined) throw new Unsupported(`CALL FUNCTION '${name}' DESTINATION '${dest}': no host implementation of this destination`);
  if (fm === undefined) throw new Unsupported(`CALL FUNCTION '${name}': no host implementation of this function module`);
  if (/\b(IN\s+UPDATE\s+TASK|STARTING\s+NEW\s+TASK|IN\s+BACKGROUND)\b/i.test(text) || (viaDest === undefined && /\bDESTINATION\b/i.test(text))) throw new Unsupported(`CALL FUNCTION '${name}' form: ${text}`);
  const fp = node.findDirectExpression(Expressions.FunctionParameters);
  const args = [];
  let exceptions = null;
  const side = (pname, want) => {
    const got = fm.params[pname];
    if (got === undefined) throw new Unsupported(`CALL FUNCTION '${name}': parameter ${pname} is not in the host's signature`);
    if (got !== want) throw new Unsupported(`CALL FUNCTION '${name}': ${pname} passed as ${want}, it is ${got}`);
  };
  if (fp !== undefined) {
    const kids = fp.getChildren();
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (isExpr(k, Expressions.FunctionExporting)) {
        for (const p of k.findDirectExpressions(Expressions.FunctionExportingParameter)) {
          const pname = upper(p.findDirectExpression(Expressions.ParameterName).concatTokens());
          side(pname, "exporting");
          args.push({name: pname, value: convert(source(p.findDirectExpression(Expressions.Source), ctx), {k: "data"})});
        }
      } else if (isExpr(k, Expressions.ParameterListT)) {
        const kw = upper(kids[i - 1]?.concatTokens() ?? "");
        const dir = kw === "IMPORTING" ? "importing" : kw === "TABLES" ? "tables" : kw === "CHANGING" ? "changing" : null;
        if (dir === null) throw new Unsupported(`CALL FUNCTION '${name}': ${kw} parameters`);
        for (const p of k.findDirectExpressions(Expressions.ParameterT)) {
          const pname = upper(p.findDirectExpression(Expressions.ParameterName).concatTokens());
          side(pname, dir);
          const target = lvalue(p.findDirectExpression(Expressions.Target), ctx);
          if (dir === "tables" && target.type.k !== "table") throw new Unsupported(`CALL FUNCTION '${name}': TABLES ${pname} is a ${target.type.k}`);
          if (target.type.hashed) throw new Unsupported(`CALL FUNCTION '${name}': TABLES ${pname} is a hashed table`);
          args.push({name: pname, value: convert(target, {k: "data"})});
        }
      } else if (isExpr(k, Expressions.ParameterListExceptions)) {
        exceptions = {map: {}, others: -1};
        for (const x of k.findDirectExpressions(Expressions.ParameterException)) {
          const v = x.findDirectExpression(Expressions.Integer);
          if (!v) throw new Unsupported(`EXCEPTIONS with a value that is not a number: ${x.concatTokens()}`);
          const nm = x.findDirectExpression(Expressions.ParameterName);
          if (nm) exceptions.map[upper(nm.concatTokens())] = Number(v.concatTokens());
          else exceptions.others = Number(v.concatTokens());
        }
      } else if (!(k instanceof Nodes.TokenNode)) {
        throw new Unsupported(`CALL FUNCTION '${name}' form: ${k.concatTokens()}`);
      }
    }
  }
  return {s: "call_fm", name, fn: fm.fn, args, exceptions};
}

/** KERNEL_LOCK calls: the host seam behind ENQUEUE_ / DEQUEUE_ / DEQUEUE_ALL */
function lockFunctionCall(node, ctx, text, name) {
  if (name !== "DEQUEUE_ALL" && !/^(?:ENQUEUE|DEQUEUE)_/.test(name)) return undefined;
  if (/\b(DESTINATION|IN\s+UPDATE\s+TASK|STARTING\s+NEW\s+TASK|IN\s+BACKGROUND|PARAMETER-TABLE|EXCEPTION-TABLE)\b/i.test(text)) {
    throw new Unsupported(`CALL FUNCTION '${name}' form: ${text}`);
  }
  if (name === "DEQUEUE_ALL") {
    rejectParameters(node, name, new Set());
    return {s: "call_enq", kind: "all", name, args: []};
  }
  const object = name.replace(/^(?:ENQUEUE|DEQUEUE)_/, "");
  const lock = lockAnswer(ctx, object);
  if (lock === undefined) return undefined;
  const params = new Set(["MANDT", "CLIENT", "_SCOPE", "_WAIT", "_COLLECT", `MODE_${lock.table}`]);
  for (const key of lock.key) {
    if (key !== "MANDT" && key !== "CLIENT") params.add(key);
    params.add(`X_${key}`);
  }
  const {args, exceptions} = lockArguments(node, ctx, name, params);
  return {s: "call_enq", kind: name.startsWith("ENQUEUE_") ? "enqueue" : "dequeue", name, table: lock.table, fields: lock.fields, object, args, exceptions};
}

function rejectParameters(node, name, params) {
  const fp = node.findDirectExpression(Expressions.FunctionParameters);
  if (fp === undefined) return;
  for (const k of fp.getChildren()) {
    if (isExpr(k, Expressions.FunctionExporting)) {
      for (const p of k.findDirectExpressions(Expressions.FunctionExportingParameter)) {
        const pname = upper(p.findDirectExpression(Expressions.ParameterName).concatTokens());
        if (!params.has(pname)) throw new Unsupported(`CALL FUNCTION '${name}': parameter ${pname} is not in the lock module's signature`);
      }
    } else if (!(k instanceof Nodes.TokenNode) && !isExpr(k, Expressions.ParameterListExceptions)) {
      throw new Unsupported(`CALL FUNCTION '${name}' form: ${k.concatTokens()}`);
    }
  }
}

function lockArguments(node, ctx, name, params) {
  const fp = node.findDirectExpression(Expressions.FunctionParameters);
  const args = [];
  let exceptions = null;
  if (fp === undefined) return {args, exceptions};
  for (const k of fp.getChildren()) {
    if (isExpr(k, Expressions.FunctionExporting)) {
      for (const p of k.findDirectExpressions(Expressions.FunctionExportingParameter)) {
        const pname = upper(p.findDirectExpression(Expressions.ParameterName).concatTokens());
        if (!params.has(pname)) throw new Unsupported(`CALL FUNCTION '${name}': parameter ${pname} is not in the lock module's signature`);
        args.push({name: pname, value: convert(source(p.findDirectExpression(Expressions.Source), ctx), {k: "data"})});
      }
    } else if (isExpr(k, Expressions.ParameterListExceptions)) {
      exceptions = {map: {}, others: -1};
      for (const x of k.findDirectExpressions(Expressions.ParameterException)) {
        const value = x.findDirectExpression(Expressions.Integer);
        if (!value) throw new Unsupported(`EXCEPTIONS with a value that is not a number: ${x.concatTokens()}`);
        const exceptionName = x.findDirectExpression(Expressions.ParameterName);
        if (exceptionName) exceptions.map[upper(exceptionName.concatTokens())] = Number(value.concatTokens());
        else exceptions.others = Number(value.concatTokens());
      }
    } else if (!(k instanceof Nodes.TokenNode)) {
      throw new Unsupported(`CALL FUNCTION '${name}' form: ${k.concatTokens()}`);
    }
  }
  return {args, exceptions};
}

/** CALL FUNCTION of a module compiled with the program (functionGroupIr):
 * a static call of FUGR:<group>=><module>, EXPORTING to its importing
 * parameters, IMPORTING from its exporting ones, TABLES and CHANGING to
 * its changing ones. An EXPORTING or CHANGING parameter passed by value
 * goes through a temporary written back only when the module returns
 * normally (A4H ZCL_GOGEN_T_FM: after RAISE the caller's fields keep their
 * values, a TABLES table keeps what the module appended). Without
 * EXCEPTIONS sy-subrc is 0 afterwards and a RAISE dumps. */
function compiledFunctionCall(node, ctx, text, name) {
  const {owner, sig} = resolvedFunctionModule(ctx, name);
  if (/\b(IN\s+UPDATE\s+TASK|STARTING\s+NEW\s+TASK|IN\s+BACKGROUND|DESTINATION|PARAMETER-TABLE|EXCEPTION-TABLE)\b/i.test(text)) throw new Unsupported(`CALL FUNCTION '${name}' form: ${text}`);
  if (sig.unsupported) throw new Unsupported(`CALL FUNCTION '${name}': ${sig.unsupported}`);
  const fp = node.findDirectExpression(Expressions.FunctionParameters);
  const given = new Map();
  const targets = new Map();
  let exceptions = null;
  if (fp !== undefined) {
    const kids = fp.getChildren();
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (isExpr(k, Expressions.FunctionExporting)) {
        for (const p of k.findDirectExpressions(Expressions.FunctionExportingParameter)) {
          given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
        }
      } else if (isExpr(k, Expressions.ParameterListT)) {
        const kw = upper(kids[i - 1]?.concatTokens() ?? "");
        if (!["IMPORTING", "TABLES", "CHANGING"].includes(kw)) throw new Unsupported(`CALL FUNCTION '${name}': ${kw} parameters`);
        for (const p of k.findDirectExpressions(Expressions.ParameterT)) {
          targets.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), {kw, target: lvalue(p.findDirectExpression(Expressions.Target), ctx)});
        }
      } else if (isExpr(k, Expressions.ParameterListExceptions)) {
        exceptions = {map: {}, others: -1};
        for (const x of k.findDirectExpressions(Expressions.ParameterException)) {
          const v = x.findDirectExpression(Expressions.Integer);
          if (!v) throw new Unsupported(`EXCEPTIONS with a value that is not a number: ${x.concatTokens()}`);
          const nm = x.findDirectExpression(Expressions.ParameterName);
          if (nm) exceptions.map[upper(nm.concatTokens())] = Number(v.concatTokens());
          else exceptions.others = Number(v.concatTokens());
        }
      } else if (!(k instanceof Nodes.TokenNode)) {
        throw new Unsupported(`CALL FUNCTION '${name}' form: ${k.concatTokens()}`);
      }
    }
  }
  const known = new Set(sig.params.map((p) => p.name));
  for (const pn of [...given.keys(), ...targets.keys()]) if (!known.has(pn)) throw new Unsupported(`CALL FUNCTION '${name}': ${pn} is not a parameter of the module`);
  const before = [], after = [];
  const args = sig.params.map((p) => {
    if (p.dir === "importing") {
      if (targets.has(p.name)) throw new Unsupported(`CALL FUNCTION '${name}': importing ${p.name} passed as ${targets.get(p.name).kw}`);
      const s = given.get(p.name);
      if (s === undefined) {
        if (p.default !== undefined) return {dir: "importing", byValue: p.byValue, type: p.type, value: defaultValue(p, ctx)};
        if (p.optional) return {dir: "importing", byValue: p.byValue, type: p.type, value: {e: "zero", type: p.type}};
        throw new Unsupported(`CALL FUNCTION '${name}': parameter ${p.name} not supplied`);
      }
      return {dir: "importing", byValue: p.byValue, type: p.type, value: convert(source(s, ctx, p.type), p.type)};
    }
    if (given.has(p.name)) throw new Unsupported(`CALL FUNCTION '${name}': ${p.dir} ${p.name} passed as EXPORTING`);
    const want = p.dir === "exporting" ? "IMPORTING" : p.tables ? "TABLES" : "CHANGING";
    const got = targets.get(p.name);
    if (got !== undefined && got.kw !== want) throw new Unsupported(`CALL FUNCTION '${name}': ${p.name} passed as ${got.kw}, it is ${want}`);
    if (got === undefined) {
      if (!p.optional) throw new Unsupported(`CALL FUNCTION '${name}': parameter ${p.name} not supplied`);
      return {dir: p.dir, byValue: p.byValue, place: null, type: p.type,
        wrap: p.tables && p.type.k === "data" ? {e: "wrap", x: {e: "zero", type: {k: "table", row: S, skey: "default"}}, type: p.type} : undefined};
    }
    const t = got.target;
    if (p.tables && p.type.k === "data" && t.type.k === "table") {
      return {dir: p.dir, byValue: false, place: null, wrap: {e: "wrap", x: t, type: p.type}, type: p.type};
    }
    const direct = sameType(t.type, p.type);
    if (!direct && !(charlike(t.type) && charlike(p.type))) {
      throw new Unsupported(`CALL FUNCTION '${name}': ${want} ${p.name} into a ${t.type.k}, the parameter is ${p.type.k}`);
    }
    if (!p.byValue && direct) return {dir: p.dir, byValue: false, place: t, type: p.type};
    const tmp = {e: "var", name: `FMV_${ctx.temps++}`, type: p.type};
    ctx.locals.set(tmp.name, p.type);
    if (p.dir === "changing") before.push({s: "assign", target: tmp, value: convert(t, p.type)});
    else before.push({s: "clear", target: tmp});
    after.push({s: "assign", target: t, value: convert(tmp, t.type)});
    return {dir: p.dir, byValue: p.byValue, place: tmp, type: p.type};
  });
  const call = {s: "call", call: {e: "call", method: name, static: true, owner, receiver: null, sup: null, args, type: {k: "void"}, exceptions, receiving: null, callee: name}};
  const subrc = {e: "sy", field: "Subrc", type: I};
  const tail = exceptions
    ? (after.length ? [{s: "if", branches: [{cond: {c: "cmp", op: "=", l: subrc, r: {e: "int", value: 0, type: I}, type: I}, body: after}], else: null}] : [])
    : [...after, {s: "assign", target: subrc, value: {e: "int", value: 0, type: I}}];
  return {s: "seq", body: [...before, call, ...tail]};
}



/*
 * The output length of a data element (parity-wave1, A4H ZCL_GOGEN_T_RTTIOL:
 * cl_abap_elemdescr's OUTPUT_LENGTH is the domain's OUTPUTLEN when the data
 * element has one, else the data element's own), read off the abapGit XML
 * of the registry into PROGRAM.ddicOutputLen for emit-go's RTTI. A name that
 * is not a data element of the registry, or whose XML has no OUTPUTLEN, is
 * left out, and RTTI keeps refusing it.
 */
/** @param {string} name @returns {void} */ function ddicOutputLength(name) {
  const map = PROGRAM.ddicOutputLen;
  if (map.has(name) || name.includes("-") || !REG) return;
  const xmlOf = (type, n) => REG.getObject(type, n)?.getXMLFile?.()?.getRaw?.() ?? "";
  const tag = (xml, t) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1];
  const dtel = xmlOf("DTEL", name);
  if (!dtel) return;
  const dom = tag(dtel, "DOMNAME");
  const src = dom && tag(dtel, "REFKIND") === "D" ? xmlOf("DOMA", upper(dom)) : dtel;
  const out = tag(src, "OUTPUTLEN");
  if (out !== undefined && /^\d+$/.test(out)) map.set(name, Number(out));
}


/* --------------------------------------------------------------------- class */

/** @param {import("./frontend-types.ts").CompilationContext} ctx0 @param {import("./frontend-types.ts").ClassSource} obj @returns {import("./frontend-types.ts").FrontendClass} */ function classIr(ctx0, obj) {
  const {reg, program} = ctx0;
  program.currentClass = goName(obj.getName());
  // the class whose local classes a REF TO / CREATE OBJECT names (ultra/json)
  program.currentOwner = upper(obj.owner ?? obj.getName());
  const file = obj.getMainABAPFile();
  // the type names this class declares itself (class and method TYPES)
  program.currentTypes = new Set([...file.getRaw().matchAll(/\bTYPES\s*:?\s*(?:BEGIN\s+OF\s+)?([\w\/]+)/gi)].map((m) => upper(m[1])));
  for (const m of file.getRaw().matchAll(/,\s*(?:BEGIN\s+OF\s+)?([\w\/]+)\s+TYPE\b/gi)) program.currentTypes.add(upper(m[1]));
  const def = obj.getDefinition();
  // a local class (localClasses) is read in the scopes of its owner
  const spaghetti = new abaplint.SyntaxLogic(reg, obj.obj ?? obj).run().spaghetti;
  const tree = rearrangedClass(file.getStructure(), Rearranger);
  const className = upper(obj.getName());
  const scopeName = obj.local ?? className;
  if (obj.local !== undefined && def.getSuperClass()) throw new Error(`${className}: a local class with a superclass is not compiled (LOCAL_CLASSES)`);

  // attributes and constants live in the class implementation scope
  const implScope = findScope(spaghetti.getTop(), "class_implementation", scopeName);
  const defScope = findScope(spaghetti.getTop(), "class_definition", scopeName);
  /** @type {import("./frontend-types.ts").FrontendAttribute[]} */ const attributes = [];
  const ownAttrs = new Set(def.getAttributes().getAll().map((a) => upper(a.getName())));
  const classVars = {...(defScope?.getData().vars ?? {}), ...(implScope?.getData().vars ?? {})};
  // a private attribute a CATCH of runtime exceptions in this class takes INTO
  // holds an exception value, not an object (see tryStatement). Private: a
  // subclass sees the attribute as the REF it is declared. A CATCH in a local
  // or test class, and one INTO a local or parameter of the same name, do not
  // count
  const privateAttrs = new Set(def.getAttributes().getAll()
    .filter((a) => a.getVisibility?.() === abaplint.Visibility.Private).map((a) => upper(a.getName())));
  /** @param {import("./frontend-types.ts").Scope | undefined} scope @returns {boolean} */ const inThisClass = (scope) => {
    for (let x = scope; x; x = x.getParent()) {
      const id = x.getIdentifier();
      if (id.stype === "class_implementation") return upper(id.sname) === upper(scopeName);
    }
    return false;
  };
  const excInto = new Set();
  for (const file of obj.getABAPFiles?.() ?? []) {
    for (const st of file.getStatements()) {
      if (!(st.get() instanceof Statements.Catch) || !/\bINTO\b/i.test(st.concatTokens())) continue;
      const target = st.findDirectExpression(Expressions.Target);
      const nm = upper((target?.findFirstExpression(Expressions.TargetField) ?? target)?.concatTokens() ?? "");
      const names = st.findDirectExpressions(Expressions.ClassName).map((x) => upper(x.concatTokens()));
      if (!privateAttrs.has(nm) || !RUNTIME_CX.some((cx) => names.some((x) => isSubclass(reg, cx, x)))) continue;
      const scope = spaghetti.lookupPosition(st.getFirstToken().getStart(), file.getFilename());
      if (inThisClass(scope) && scope.getData().vars[nm] === undefined) excInto.add(nm);
    }
  }
  for (const [name, id] of Object.entries(classVars)) {
    if (name === "ME" || name === "SUPER") continue;
    const meta = id.getMeta();
    if (id instanceof abaplint.Types.ClassConstant || (meta.includes("read_only") && meta.includes("static") && name.includes("~"))) {
      registerConst(program, name, id, className);
      continue;
    }
    // an inherited attribute lives in the superclass's part of the object
    if (!ownAttrs.has(name)) continue;
    if (excInto.has(name)) {
      program.excAttrs.add(`${className}|${name}`);
      attributes.push({name, type: EXC, static: meta.includes("static")});
      continue;
    }
    try {
      const type = typeOf(id.getType(), `${className} ${name}`, program);
      attributes.push({name, type, private: privateAttrs.has(name), static: meta.includes("static"), value: attributeValue(id, type, `${className} ${name}`)});
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      attributes.push({name, unsupported: e.message});
    }
  }

  // signatures: the class's own methods plus the interfaces' it implements
  /** @type {Map<string, import("./frontend-types.ts").MethodSignature>} */ const signatures = new Map();
  /** @param {import("./frontend-types.ts").MethodDefinition} m @param {string} prefix @param {boolean} isStatic @returns {void} */ const addSig = (m, prefix, isStatic) => {
    const name = prefix + upper(m.getName());
    const where = `${className}=>${name}`;
    if (NATIVE_ME.has(where)) { signatures.set(name, nativeMeSig(program, where, name)); return; }
    try {
      const p = m.getParameters();
      const optional = new Set((p.getOptional?.() ?? []).map(upper));
      /** @param {import("@abaplint/core").TypedIdentifier} x @param {NonNullable<import("./ir.ts").Param["dir"]>} dir @returns {import("./frontend-types.ts").FrontendParam} */ const param = (x, dir) => ({name: upper(x.getName()), dir, byValue: x.getMeta().includes("pass_by_value"), type: typeOf(x.getType(), where, program),
        default: defaultOf(p, x), defaultOwner: prefix ? prefix.slice(0, -1) : className, defOwner: prefix ? prefix.slice(0, -1) : className, optional: optional.has(upper(x.getName()))});
      const ret = p.getReturning();
      const own = [...p.getImporting().map((x) => param(x, "importing")), ...p.getExporting().map((x) => param(x, "exporting")),
        ...p.getChanging().map((x) => param(x, "changing"))];
      signatures.set(name, {
        name, static: isStatic, private: m.getVisibility?.() === 1, abstract: m.isAbstract?.() ?? false,
        params: withSupplied(program, prefix ? `${prefix.slice(0, -1)}=>${upper(m.getName())}`
          : `${declaringClass(reg, className, name, "method") ?? className}=>${name}`, own),
        returning: ret === undefined ? null : {name: upper(ret.getName()), type: typeOf(ret.getType(), where, program)},
      });
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      signatures.set(name, {name, unsupported: e.message});
    }
  };
  // a REDEFINITION declares no parameters of its own: they are the ones of
  // the interface or superclass the method comes from (without this an
  // inherited IF_APC_WSP_EXTENSION~ON_START read its I_MESSAGE_MANAGER as
  // an empty local)
  /** @param {{getName(): string}} m @returns {import("./frontend-types.ts").MethodDefinition} */ const origin = (m) => {
    const nm = upper(m.getName());
    if (nm.includes("~")) {
      const [intf, meth] = nm.split("~");
      const idef = reg.getObject("INTF", intf)?.getDefinition();
      const all = idef?.getMethodDefinitions();
      const found = all && Array.from(Array.isArray(all) ? all : all.getAll()).find((x) => upper(x.getName()) === meth);
      if (!found) throw new Unsupported(`${className}: the interface method of REDEFINITION ${nm} is not in the program`);
      return found;
    }
    for (let sup = def.getSuperClass(), guard = 0; sup && guard < 20; guard += 1) {
      const sdef = clasDef(reg, sup);
      if (!sdef) break;
      const found = sdef.getMethodDefinitions().getAll().find((x) => upper(x.getName()) === nm);
      if (found && !found.isRedefinition()) return found;
      sup = sdef.getSuperClass();
    }
    throw new Unsupported(`${className}: where REDEFINITION ${nm} comes from is not in the program`);
  };
  // METHODS get_text REDEFINITION where get_text is a superclass's ALIASES
  // for if_message~get_text: the method redefined is the interface method,
  // and its implementation (METHOD get_text) is compiled under that name
  const redefinedAlias = new Map();
  for (const m of def.getMethodDefinitions().getAll()) {
    if (!m.isRedefinition()) { addSig(m, "", m.isStatic()); continue; }
    const nm = upper(m.getName());
    const target = nm.includes("~") ? undefined : aliasTarget(reg, className, nm);
    if (target?.includes("~")) redefinedAlias.set(nm, target);
    let o;
    const as = target?.includes("~") ? {getName: () => target} : m;
    try { o = origin(as); } catch (e) { if (!(e instanceof Unsupported)) throw e; signatures.set(upper(as.getName()), {name: upper(as.getName()), unsupported: e.message}); continue; }
    addSig(Object.assign(Object.create(Object.getPrototypeOf(o)), o, {getName: () => as.getName()}), "", m.isStatic());
  }
  const implemented = [...new Set(def.getImplementing().flatMap((i) => [upper(i.name), ...componentInterfaces(reg, upper(i.name))]))];
  // an interface a superclass already implements (itself or through an
  // included one) is a field of the superclass's part of the object: a
  // second copy here would be a second field in Go, shadowing the embedded
  // one, and the value would split in two
  const inherited = new Set(ancestors(reg, className).flatMap((c) => (clasDef(reg, c)?.getImplementing() ?? [])
    .flatMap((i) => [upper(i.name), ...componentInterfaces(reg, upper(i.name))])));
  append(attributes, implementedAttributes(program, implemented.filter((i) => !inherited.has(i))));
  for (const intf of implemented.map((name) => ({name}))) {
    const idef = reg.getObject("INTF", intf.name)?.getDefinition();
    if (idef === undefined) throw new Unsupported(`${className}: interface ${intf.name} not in the program`);
    const all = idef.getMethodDefinitions();
    // typed as the interface's, as methodSignature types them for a caller
    const owner = program.currentClass;
    program.currentClass = goName(intf.name);
    try {
      for (const m of Array.from(Array.isArray(all) ? all : all.getAll())) addSig(m, `${upper(intf.name)}~`, m.isStatic?.() ?? false);
    } finally {
      program.currentClass = owner;
    }
  }

  // single inheritance: the superclass when it is compiled too (else the
  // class stands alone, as it did before inheritance was compiled)
  const sup = def.getSuperClass() ? upper(def.getSuperClass()) : null;
  const typed = new Map([...signatures].filter(([, v]) => !v.unsupported));
  if (HOST_REPLACED.has(className)) {
    // a method the frontend cannot type would be dropped, and its hook with it
    for (const sig of signatures.values()) if (sig.unsupported) throw new Unsupported(`${className}=>${sig.name}: a host-replaced method must compile (${sig.unsupported})`);
    for (const sig of typed.values()) {
      for (const p of [...sig.params, ...(sig.returning ? [sig.returning] : [])].filter((p) => !p.suppliedOf)) {
        const basic = p.type.k === "string" || p.type.k === "i" || p.type.k === "int8"
          || (p.type.k === "c" && (p.type.len ?? 1) === 1);
        if (!basic) throw new Unsupported(`${className}=>${sig.name} ${p.name}: a host-replaced method may use only string, c LENGTH 1, i, or int8`);
      }
    }
  }
  /** @type {import("./frontend-types.ts").FrontendClass} */ const cls = {name: className, hostReplaced: HOST_REPLACED.has(className), attributes, methods: [], constructor: null, stubs: [],
    interfaces: def.getImplementing().map((i) => upper(i.name)), super: sup && program.wanted.has(sup) ? sup : null, abstract: def.isAbstract()};
  cls.abstracts = [...signatures.values()].filter((x) => x.abstract && !x.unsupported && !x.name.includes("~"));
  cls.signatures = signatures;
  // an object of this class can raise instance events (its own, a
  // superclass's, an interface's): the backends give it its registrations
  // (ultra/events, go/abap/events.go)
  cls.instanceEvents = [className, ...ancestors(reg, className)].some((c) => {
    const d = reg.getObject("CLAS", c)?.getDefinition();
    if (!d) return false;
    if (d.getEvents().some((e) => !e.isStatic())) return true;
    return d.getImplementing().some((i) => [upper(i.name), ...componentInterfaces(reg, upper(i.name))]
      .some((n) => reg.getObject("INTF", n)?.getDefinition()?.getEvents?.().some((e) => !e.isStatic())));
  });
  // a local class's methods are the ones of its own CLASS ... IMPLEMENTATION
  const methodNodes = obj.local === undefined ? tree.findAllStructures(Structures.Method)
    : tree.findAllStructures(Structures.ClassImplementation).filter((ci) => upper(ci.findFirstExpression(Expressions.ClassName).concatTokens()) === obj.local)
      .flatMap((ci) => ci.findAllStructures(Structures.Method));
  for (const node of methodNodes) {
    const written = upper(node.findFirstExpression(Expressions.MethodName).concatTokens());
    const name = redefinedAlias.get(written) ?? written;
    const sig = signatures.get(name);
    const skip = (why) => {
      program.skipped.push(`${className}=>${name}: ${why}`);
      // a method with a typed signature still exists as a stub that raises
      // when called, so its callers compile; only an untyped signature
      // cannot be called at all
      if (typed.has(name)) cls.stubs.push({...typed.get(name), reason: why, pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}});
      else signatures.set(name, {name, unsupported: why});
    };
    if (sig === undefined) { skip("no signature"); continue; }
    if (sig.unsupported) { skip(sig.unsupported); continue; }
    if (className === "CL_MESSAGE_HELPER" && ["GET_TEXT_PARAMS", "REPLACE_TEXT_PARAMS", "GET_OTR_TEXT_RAW"].includes(name)) {
      skip("message metadata lookup is not implemented"); continue;
    }
    // a kernel service the host implements: the ABAP body (the transpiler's
    // @KERNEL code) is replaced by a call into the host
    if (NATIVE_ME.has(`${className}=>${name}`)) {
      cls.methods.push({...sig, locals: [], fieldSymbols: [], calls: [], body: [{s: "native", fn: NATIVE_ME.get(`${className}=>${name}`).fn, me: true}],
        pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}});
      continue;
    }
    if (AMC_HOST.has(`${className}=>${name}`)) {
      const actx = {program, reg, className, scopeName, method: name, sig, signatures, spaghetti, locals: new Map([["LV_AMC_ERROR", S]]), fieldSymbols: new Map()};
      // the host classes the body makes are references, so a closure grown
      // from references (unit.mjs, referencedClasses) compiles them
      const hostRefs = {create_producer: "ZCL_AMC_PRODUCER", create_consumer: "ZCL_AMC_CONSUMER", start: "ZCL_AMC_MESSAGE_CONTEXT"};
      const spec = AMC_HOST.get(`${className}=>${name}`);
      const locals = [{name: "LV_AMC_ERROR", type: S}, ...(hostRefs[spec.op] ? [{name: "LO_AMC_HOST", type: {k: "ref", name: hostRefs[spec.op], intf: false}}] : [])];
      cls.methods.push({...sig, locals, fieldSymbols: [], calls: [], body: [amcMethod(spec, actx)],
        pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}});
      continue;
    }
    if (NATIVE.has(`${className}=>${name}`)) {
      const native = NATIVE.get(`${className}=>${name}`);
      if (native === "Native_DESCRIBE_BY_OBJECT_REF") program.missing.add("CL_ABAP_CLASSDESCR");
      // {fn, args}: the host function takes the places and values named
      // (attributes and parameters, "&" for a place it writes) instead of
      // the parameters in their order
      /** @type {import("./frontend-types.ts").FrontendStmt} */ const st = typeof native === "string" ? {s: "native", fn: native}
        : {s: "native", fn: native.fn, args: nativeArgs(native.args, {program, reg, className, scopeName, method: name, sig, signatures, spaghetti, locals: new Map(), fieldSymbols: new Map()})};
      cls.methods.push({...sig, locals: [], fieldSymbols: [], calls: [], body: [st],
        pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}});
      continue;
    }
    try {
      const scope = spaghetti.lookupPosition(node.getFirstToken().getStart(), file.getFilename());
      const ctx = {program, reg, className, scopeName, owner: obj.owner ?? className, method: name, sig, signatures, scope, file, spaghetti, locals: new Map(), temps: 0};
      const body = node.findDirectStructure(Structures.Body);
      ctx.sinkUnsafe = !!body?.findAllExpressionsRecursive(Expressions.Dynamic).length;
      const known = new Set([...sig.params.map((p) => p.name), sig.returning?.name].filter(Boolean));
      ctx.fieldSymbols = new Map();
      const inlineTables = inlineTableLocals(body);
      const inlineResults = inlineFindResultTypes(body, ctx, {Statements, Expressions, typeOf, Unsupported});
      for (const [vname, id] of Object.entries(scope.getData().vars)) {
        if (known.has(vname) || vname === "ME" || vname === "SUPER") continue;
        // abaplint leaves SELECT ... INTO TABLE @DATA(x) without a row type.
        // The SELECT field list supplies it when the statement is lowered.
        if (inlineTables.has(vname)) continue;
        const t = inlineResults.get(vname) ?? typeOf(id.getType(), `${className}=>${name} ${vname}`, program);
        // a field symbol points into a row: only rows of structures, whose
        // reference both backends can hold (a pointer, an object)
        if (vname.startsWith("<")) {
          // ultra/events: in Go a typed field symbol of any kind is a pointer to
          // the row or field (a string table's line, a whole table); the JS
          // emitter holds only rows of structures and refuses the method
          if (!["struct", "data", "table", "string", "c", "i", "int8", "n", "d", "t", "x", "xstring", "p", "f"].includes(t.k)) throw new Unsupported(`field symbol ${vname} of a ${t.k}`);
          ctx.fieldSymbols.set(vname, t);
        } else {
          ctx.locals.set(vname, t);
        }
      }
      ctx.inits = [];
      hoistLocalConstants(body, ctx, {Nodes, Structures, Statements, Expressions, isTok, isExpr, isStruct, isStmt, upper, goName, initialValue, Unsupported});
      const bodyStatements = body === undefined ? [] : block(body, ctx);
      const compiled = [];
      append(compiled, ctx.inits, bodyStatements);
      const ir = {...sig, fieldSymbols: [...ctx.fieldSymbols].map(([n, t]) => ({name: n, type: t})), locals: [...ctx.locals].map(([n, t]) => ({name: n, type: t})).sort((a, b) => a.name.localeCompare(b.name)),
        body: compiled, sinkUnsafe: !!ctx.sinkUnsafe, calls: ctx.calls ?? [], pos: {file: file.getFilename().split("/").pop(), row: node.getFirstToken().getStart().getRow()}};
      // by the class, not the method: a producer kept in an attribute and
      // sent from a method that never names the type is this class's call
      // too (the critic on #263). The AMC classes are not callers, as Node's
      // callerProgram skips them
      if (AMC_CALLER.test(file.getRaw()) && !/^(CL_AMC_|ZCL_AMC_)/.test(upper(ctx.owner))) ir.amcProgram = amcProgramOf(ctx.owner);
      if (name === "CONSTRUCTOR") cls.constructor = ir; else cls.methods.push(ir);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      skip(e.message);
    }
  }
  // a compiled method that calls one that did not compile cannot run
  let changed = true;
  while (changed) {
    changed = false;
    if (cls.constructor && !cls.constructor.dropped) {
      const bad = cls.constructor.calls?.find((c) => signatures.get(c)?.unsupported);
      if (bad) {
        cls.constructor.dropped = true; changed = true;
        program.skipped.push(`${className}=>CONSTRUCTOR: calls ${bad}, which was skipped`);
      }
    }
    for (const m of cls.methods) {
      const bad = m.calls?.find((c) => signatures.get(c)?.unsupported);
      if (bad && !m.dropped) {
        m.dropped = true; changed = true;
        program.skipped.push(`${className}=>${m.name}: calls ${bad}, which was skipped`);
        if (typed.has(m.name)) cls.stubs.push({...typed.get(m.name), reason: `calls ${bad}`});
        signatures.set(m.name, {name: m.name, unsupported: `calls ${bad}`});
      }
    }
  }
  cls.methods = cls.methods.filter((m) => !m.dropped);
  if (cls.constructor?.dropped) cls.constructor = null;
  // a constructor that did not compile: the object can still be created, so
  // the classes that create it compile, but none of its methods runs on a
  // state the constructor never set -- they all raise, with the reason
  const hasCtor = methodNodes.some((n) => upper(n.findFirstExpression(Expressions.MethodName).concatTokens()) === "CONSTRUCTOR");
  if (hasCtor && cls.constructor === null) {
    const why = program.skipped.find((x) => x.startsWith(`${className}=>CONSTRUCTOR:`))?.replace(/^[^:]+: /, "") ?? "?";
    cls.ctorBroken = why;
    cls.ctorParams = typed.get("CONSTRUCTOR")?.params ?? [];
    for (const m of cls.methods) cls.stubs.push({...m, reason: `the constructor did not compile: ${why}`});
    cls.methods = [];
  }
  return cls;
}

// the scope of that kind, the one of the class named when a name is given
// (a class with local classes has one class_implementation per class, and
// the locals come first); without a match by name, the first of the kind
/** @param {import("./frontend-types.ts").Scope} node @param {import("./frontend-types.ts").ScopeKind} stype @param {string} [name] @returns {import("./frontend-types.ts").Scope | undefined} */ function findScope(node, stype, name) {
  if (name !== undefined) {
    const named = findScopeNamed(node, stype, upper(name));
    if (named) return named;
  }
  if (node.getIdentifier().stype === stype) return node;
  for (const c of node.getChildren()) {
    const f = findScope(c, stype);
    if (f) return f;
  }
  return undefined;
}

/** @param {import("./frontend-types.ts").Scope} node @param {import("./frontend-types.ts").ScopeKind} stype @param {string} name @returns {import("./frontend-types.ts").Scope | undefined} */ function findScopeNamed(node, stype, name) {
  if (node.getIdentifier().stype === stype && upper(node.getIdentifier().sname) === name) return node;
  for (const c of node.getChildren()) {
    const f = findScopeNamed(c, stype, name);
    if (f) return f;
  }
  return undefined;
}

/** @param {import("./frontend-types.ts").MethodParameters} params @param {import("@abaplint/core").TypedIdentifier} x @returns {string | undefined} */ function defaultOf(params, x) {
  const d = params.getParameterDefault?.(x.getName());
  return d === undefined ? undefined : d.concatTokens();
}

/** an interface or class constant, by its ABAP name (ZIF_X~C_Y) */
/**
 * The VALUE of an attribute, set when the object is made (static: when the
 * class is loaded) and not left at the type's initial value: a rotozoom
 * with `mv_scale TYPE i VALUE 8` left at 0 stepped its WHILE by 0 and
 * appended rows until the machine ran out of memory (2026-09-23).
 * Literals only; anything else is refused, not guessed.
 */
/** @param {import("@abaplint/core").TypedIdentifier} id @param {import("./ir.ts").Type} type @param {string} where @returns {string | undefined} */ function attributeValue(id, type, where) {
  const raw = id.getValue?.();
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") throw new Unsupported(`${where}: structured VALUE`);
  const text = String(raw);
  const quoted = /^'.*'$/s.test(text) || /^`.*`$/s.test(text);
  if (!quoted && !/^-?\d+(\.\d+)?$/.test(text)) throw new Unsupported(`${where}: VALUE ${text}`);
  let value = quoted ? text.slice(1, -1).replaceAll(text[0] === "'" ? "''" : "``", text[0]) : text;
  if (type.k === "c") value = value.slice(0, type.len).replace(/ +$/, "");
  else if (type.k === "x" || type.k === "xstring") {
    if (!quoted || !/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Unsupported(`${where}: VALUE ${text} for type ${type.k}`);
  } else if (!["i", "int8", "f", "string"].includes(type.k)) throw new Unsupported(`${where}: VALUE for type ${type.k}`);
  if (!["c", "string", "x", "xstring"].includes(type.k) && !Number.isFinite(Number(value))) throw new Unsupported(`${where}: VALUE ${text}`);
  return value;
}

/** @param {import("./frontend-types.ts").FrontendProgram} program @param {string} name @param {import("./frontend-types.ts").ConstantIdentifier} id @param {string} className @returns {string | undefined} */ function registerConst(program, name, id, className) {
  const go = goName(name.includes("~") ? name : `${className}=>${name}`);
  if (program.consts.has(go)) return go;
  /** @type {import("./ir.ts").Type} */ let type;
  try { type = typeOf(id.getType(), name, program); } catch (e) { if (e instanceof Unsupported) return undefined; throw e; }
  let value = id.getValue?.();
  const SCALAR = ["i", "int8", "f", "c", "string", "x", "xstring"];
  // a quote inside a literal is written twice: '#''"' is #'" (the Zork
  // alphabet shifted by one character after it until this was read right)
  /** @param {string | number | undefined} v @returns {string} */ const unquote = (v) => {
    v = String(v);
    if (/^'.*'$/s.test(v)) return v.slice(1, -1).replaceAll("''", "'");
    if (/^`.*`$/s.test(v)) return v.slice(1, -1).replaceAll("``", "`");
    return v;
  };
  // CONSTANTS: BEGIN OF ... END OF: one value per component, all scalar
  if (value !== null && typeof value === "object" && type.k === "struct") {
    const fields = program.structs.get(type.go)?.fields ?? [];
    const byName = new Map(Object.entries(value).map(([k, v]) => [upper(k), v]));
    // an n component (MSGNO of a T100 key) whose VALUE is exactly its digits:
    // the characters are the value; any other n VALUE is not measured
    /** @param {import("./ir.ts").Field} f @returns {boolean} */ const nDigits = (f) => f.type.k === "n" && byName.has(f.name) && new RegExp(`^[0-9]{${f.type.len}}$`).test(unquote(byName.get(f.name)));
    if (fields.length === 0 || fields.some((f) => (!SCALAR.includes(f.type.k) && !nDigits(f)) || typeof byName.get(f.name) === "object")) return undefined;
    program.consts.set(go, {go, type, value: Object.fromEntries(fields.map((f) => [f.name, byName.has(f.name) ? unquote(byName.get(f.name)) : undefined]))});
    return go;
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  // an n constant whose VALUE is exactly its digits (ultra/demodata: A4H
  // prints C_MIN of n 10 VALUE '9000000000' as 9000000000); any other n
  // VALUE is not measured
  if (type.k === "n" && new RegExp(`^[0-9]{${type.len}}$`).test(unquote(value))) {
    program.consts.set(go, {go, type, value: unquote(value)});
    return go;
  }
  if (!SCALAR.includes(type.k)) return undefined;
  program.consts.set(go, {go, type, value: unquote(value)});
  return go;
}

/* ---------------------------------------------------------------- statements */

// the statements and control structures of a body, Normal and Body unwrapped
/** @param {import("@abaplint/core").Nodes.StructureNode} node @returns {(import("@abaplint/core").Nodes.StatementNode | import("@abaplint/core").Nodes.StructureNode)[]} */ const flatChildren = (node) => node.getChildren().flatMap((c) => (c instanceof Nodes.StructureNode && (isStruct(c, Structures.Normal) || isStruct(c, Structures.Body)) ? flatChildren(c) : [c]));

/** @param {import("@abaplint/core").Nodes.StructureNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt[]} */ function block(node, ctx) {
  return blockList(flatChildren(node), ctx);
}

/** @param {readonly (import("@abaplint/core").Nodes.StatementNode | import("@abaplint/core").Nodes.StructureNode)[]} children @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt[]} */ function blockList(children, ctx) {
  /** @type {import("./frontend-types.ts").FrontendStmt[]} */ const out = [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    // a host loop (KERNEL): the statements up to its closing line are its body
    const k = kernelOf(child, ctx);
    if (k?.loop !== undefined) {
      const pos = {file: ctx.file.getFilename().split("/").pop(), row: child.getFirstToken().getStart().getRow()};
      const j = children.findIndex((c, x) => x > i && kernelOf(c, ctx)?.end === true);
      const inner = children.slice(i + 1, j);
      const where = `${ctx.className}=>${ctx.method} (${pos.file}:${pos.row})`;
      if (j < 0 || ctx.kernelLoop !== undefined || inner.some((c) => !(c instanceof Nodes.StatementNode) || /^(EXIT|CONTINUE|RETURN|CHECK)\b/i.test(c.concatTokens()))) {
        ctx.program.partial.push(`${where}: a kernel loop without its end, nested, or with control flow`);
        out.push({s: "stub", where, reason: "a kernel loop without its end, nested, or with control flow", pos});
        if (j < 0) break;
        i = j;
        continue;
      }
      try {
        const binds = k.binds.map((b) => variable(b, ctx));
        if (binds.some((b) => b.type.k !== "string")) throw new Unsupported(`kernel loop binds ${k.binds.join(", ")}: not strings`);
        ctx.kernelLoop = k;
        out.push({s: "kernel_loop", fn: k.loop, args: nativeArgs(k.args, ctx), binds, body: blockList(inner, ctx), pos});
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        ctx.program.partial.push(`${where}: ${e.message}`);
        out.push({s: "stub", where, reason: e.message.slice(0, 200), pos});
      } finally {
        ctx.kernelLoop = undefined;
      }
      i = j;
      continue;
    }
    // one statement (or one IF, LOOP, TRY ...) the subset does not cover
    // becomes a stub that raises NOT_COMPILED when it runs, as a system
    // dumps; the rest of the method compiles, and nothing is skipped
    // silently: execution never passes the stub
    const pos = {file: ctx.file.getFilename().split("/").pop(), row: child.getFirstToken().getStart().getRow()};
    try {
      if (child instanceof Nodes.StructureNode) out.push({...structure(child, ctx), pos});
      else if (child instanceof Nodes.StatementNode) {
        const s = statement(child, ctx);
        if (s !== undefined) out.push({...s, pos});
      }
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      const where = `${ctx.className}=>${ctx.method} (${pos.file}:${pos.row})`;
      ctx.program.partial.push(`${where}: ${e.message}`);
      out.push({s: "stub", where, reason: e.message.slice(0, 200), pos});
    }
  }
  return out;
}


// IS INSTANCE OF on an initial reference answers by its static type: true
// when an up cast from it to the target is legal (A4H 7.58, 2026-10-08:
// REF TO zcl_a -> zcl_a true, -> a subclass false; REF TO object -> zcl_a
// false; REF TO zif_x -> zif_x true)
/** @param {import("@abaplint/core").IRegistry} reg @param {import("./frontend-types.ts").RefType} from @param {import("./frontend-types.ts").RefType} to @returns {boolean} */ function upcastable(reg, from, to) {
  if (to.name === "OBJECT" || from.name === to.name) return true;
  if (from.name === "OBJECT") return false;
  if (!to.intf) return !from.intf && isSubclass(reg, from.name, to.name);
  if (from.intf) return componentInterfaces(reg, from.name).includes(to.name);
  return [from.name, ...ancestors(reg, from.name)].some((c) => (clasDef(reg, c)?.getImplementing() ?? [])
    .some((i) => upper(i.name) === to.name || componentInterfaces(reg, upper(i.name)).includes(to.name)));
}

/** @param {import("@abaplint/core").IRegistry} reg @param {string} cls @param {string} ancestor @returns {boolean} */ function isSubclass(reg, cls, ancestor) {
  return chainHas(PROGRAM ?? reg, reg, cls, ancestor, (c) => clasDef(reg, c)?.getSuperClass()?.toUpperCase() ?? RUNTIME_CX_SUPER[c]);
}

/** @param {readonly import("./frontend-types.ts").FrontendStmt[] | null | undefined} stmts @param {boolean} [inLoop] @returns {boolean} */ function leaves(stmts, inLoop = false) {
  for (const st of stmts ?? []) {
    if (st.s === "return") return true;
    if ((st.s === "exit" || st.s === "continue") && !inLoop) return true;
    const loop = st.s === "loop" || st.s === "do" || st.s === "while" || st.s === "select_loop";
    for (const k of ["body", "then", "else"]) if (Array.isArray(st[k]) && leaves(st[k], inLoop || loop)) return true;
    for (const b of st.branches ?? st.cases ?? st.elseifs ?? []) if (leaves(b.body, inLoop || loop)) return true;
    for (const c of st.catches ?? []) if (leaves(c.body, inLoop)) return true;
  }
  return false;
}

/** @param {import("@abaplint/core").Nodes.StructureNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt} */ function tryBlock(node, ctx) {
  const body = bodyOf(node, ctx);
  const seen = [];
  const catches = node.findDirectStructures(Structures.Catch).map((c) => {
    const st = c.findDirectStatement(Statements.Catch);
    const names = st.findDirectExpressions(Expressions.ClassName).map((n) => upper(n.concatTokens()));
    // a class after a CATCH of its superclass does not activate on a system
    // (A4H 2026-09-23: "a CATCH clause already exists ... uses the superclass")
    const shadow = names.find((n) => seen.some((e) => isSubclass(ctx.reg, n, e)));
    if (shadow) throw new Unsupported(`CATCH ${shadow} after a CATCH of its superclass`);
    append(seen, names);
    const covers = RUNTIME_CX.filter((cx) => names.some((n) => isSubclass(ctx.reg, cx, n)));
    // exception objects (RAISE EXCEPTION): taken when the raised class is one
    // of the names or inherits from one, decided at run time
    const own = caughtClasses(ctx, names).length > 0 ? names : [];
    // CATCH ... INTO x: when the CATCH covers exceptions the runtime raises,
    // x is an exception value whose one method here is get_text( ) (a raised
    // object's own get_text, else the class and the operation, not A4H's
    // text); when it covers only raised objects, x keeps its declared
    // reference type and receives the object itself
    let into = null;
    let intoKind = null;
    if (/\bINTO\b/i.test(st.concatTokens())) {
      const target = st.findDirectExpression(Expressions.Target);
      const nm = upper((target.findFirstExpression(Expressions.TargetField) ?? target).concatTokens());
      if (ctx.sig.params.some((x) => x.name === nm) || ctx.sig.returning?.name === nm) throw new Unsupported(`CATCH ... INTO ${nm}: a parameter`);
      if (!ctx.locals.has(nm)) {
        // an attribute of the class: a report's global data, which the
        // converter makes attributes of the report class. One that takes
        // runtime exceptions is an exception value in the whole class
        // (classIr marks it), as a local is in its method
        const attr = /^[A-Z_][A-Z0-9_]*$/.test(nm) ? findAttribute(ctx, nm) : undefined;
        if (attr?.e !== "attr" && attr?.e !== "static") throw new Unsupported(`CATCH ... INTO ${nm}: not a local or an attribute`);
        // only a private attribute of this class is made an exception value (classIr)
        if (covers.length > 0 && attr.type.k !== "exc") throw new Unsupported(`CATCH ... INTO ${nm}: runtime exceptions INTO an attribute that is not private to ${ctx.className}`);
        if (covers.length === 0 && attr.type.k !== "ref") throw new Unsupported(`CATCH ... INTO ${nm}: an attribute of type ${attr.type.k}`);
        if (attr.type.k === "ref" && !attr.type.intf && attr.type.name !== "OBJECT" && !ctx.program.wanted.has(attr.type.name)) throw new Unsupported(`CATCH ... INTO ${nm}: REF TO ${attr.type.name}, which is not compiled`);
        return {classes: names, into: nm, intoPlace: attr, intoKind: covers.length > 0 ? "exc" : "ref", intoType: attr.type, covers, own, body: bodyOf(c, ctx)};
      }
      const declared = ctx.locals.get(nm);
      if (covers.length > 0) {
        ctx.locals.set(nm, EXC);
        intoKind = "exc";
      } else {
        if (declared.k !== "ref") throw new Unsupported(`CATCH ... INTO ${nm}: a ${declared.k} (also the INTO of a CATCH of runtime exceptions)`);
        if (!declared.intf && declared.name !== "OBJECT" && !ctx.program.wanted.has(declared.name)) throw new Unsupported(`CATCH ... INTO ${nm}: REF TO ${declared.name}, which is not compiled`);
        intoKind = "ref";
      }
      into = nm;
    }
    return {classes: names, into, intoKind, intoType: into ? ctx.locals.get(into) : null, covers, own, body: bodyOf(c, ctx)};
  });
  // CLEANUP: runs when a class-based exception leaves the TRY body for a
  // handler further out, inner CLEANUPs first, then the handler (A4H
  // 2026-09-23); not for one raised inside a CATCH of the same TRY. For an
  // exception nobody catches no CLEANUP runs: the kernel looks for a handler
  // before it unwinds and dumps at the RAISE when there is none (A4H
  // 2026-09-23, ZCL_GOGEN_T_UNCAUGHT); the emitters ask the session's
  // active CATCHes (abap.Session.Handled)
  const cl = node.findDirectStructure(Structures.Cleanup);
  let cleanup = null;
  if (cl) {
    if (/\bINTO\b/i.test(cl.findDirectStatement(Statements.Cleanup)?.concatTokens() ?? "")) throw new Unsupported("CLEANUP INTO");
    cleanup = bodyOf(cl, ctx);
    if (leaves(cleanup, false)) throw new Unsupported("RETURN, EXIT or CONTINUE out of a CLEANUP");
  }
  return {s: "try", body, catches, cleanup};
}

/** @param {import("@abaplint/core").Nodes.StructureNode} n @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt[]} */ const bodyOf = (n, ctx) => {
  const b = n.findDirectStructure(Structures.Body);
  return b === undefined ? [] : block(b, ctx);
};

/** @param {import("@abaplint/core").Nodes.StructureNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt} */ function structure(node, ctx) {
  if (isStruct(node, Structures.Types)) return {s: "nop"};
  if (isStruct(node, Structures.Data)) {
    if (/\bVALUE\b/i.test(node.concatTokens())) throw new Unsupported(`DATA BEGIN OF with VALUE: ${node.concatTokens().slice(0, 60)}`);
    return {s: "nop"};
  }
  if (isStruct(node, Structures.Constants)) { append(ctx.inits, ctx.localConstantFields?.get(node) ?? []); return {s: "nop"}; }
  if (isStruct(node, Structures.Try)) return tryBlock(node, ctx);
  if (isStruct(node, Structures.If)) {
    const branches = [{cond: cond(node.findDirectStatement(Statements.If).findDirectExpression(Expressions.Cond), ctx), body: bodyOf(node, ctx)}];
    for (const e of node.findDirectStructures(Structures.ElseIf)) {
      branches.push({cond: cond(e.findDirectStatement(Statements.ElseIf).findDirectExpression(Expressions.Cond), ctx), body: bodyOf(e, ctx)});
    }
    const els = node.findDirectStructure(Structures.Else);
    return {s: "if", branches, else: els === undefined ? null : bodyOf(els, ctx)};
  }
  if (isStruct(node, Structures.Case)) {
    const subjectNode = node.findDirectStatement(Statements.Case).findDirectExpression(Expressions.Source);
    const subject = source(subjectNode, ctx);
    const tmp = `case${ctx.temps++}`;
    const branches = [];
    let others = null;
    for (const w of node.findDirectStructures(Structures.When)) {
      const st = w.findDirectStatement(Statements.When) ?? w.findDirectStatement(Statements.WhenOthers);
      if (st.get() instanceof Statements.WhenOthers) { others = bodyOf(w, ctx); continue; }
      // WHEN a OR b OR c: the alternatives after the first sit in Or nodes
      // (only the first was read until 2026-09-23, silently)
      const alts = [...st.findDirectExpressions(Expressions.Source), ...st.findDirectExpressions(Expressions.Or).map((o) => o.findDirectExpression(Expressions.Source))];
      const expected = 1 + st.findDirectExpressions(Expressions.Or).length;
      if (alts.length !== expected || alts.some((x) => !x) || st.getChildren().filter((c) => !isTok(c)).length !== expected) throw new Unsupported(`WHEN form: ${st.concatTokens()}`);
      const values = alts.map((s) => source(s, ctx));
      const conds = values.map((v) => compareValues("=", {e: "temp", name: tmp, type: subject.type}, v, ctx));
      branches.push({cond: conds.reduce((l, r) => ({c: "or", l, r})), body: bodyOf(w, ctx)});
    }
    return {s: "case", temp: tmp, subject, branches, else: others};
  }
  if (isStruct(node, Structures.Do)) {
    const st = node.findDirectStatement(Statements.Do);
    if (/\bVARYING\b/i.test(st.concatTokens())) throw new Unsupported("DO ... VARYING");
    const times = st.findDirectExpression(Expressions.Source);
    return {s: "do", times: times === undefined ? null : convert(source(times, ctx, I), I), body: bodyOf(node, ctx)};
  }
  if (isStruct(node, Structures.While)) {
    return {s: "while", cond: cond(node.findDirectStatement(Statements.While).findDirectExpression(Expressions.Cond), ctx), body: bodyOf(node, ctx)};
  }
  if (isStruct(node, Structures.Select)) return selectLoop(node, ctx);
  if (isStruct(node, Structures.Loop)) {
    const st = node.findDirectStatement(Statements.Loop);
    const text = st.concatTokens();
    // USING KEY <sorted secondary key> (ultra/json): the key's order, see secondaryKey
    const using = /\bUSING\s+KEY\s+([\w~]+)/i.exec(text);
    const dynamicUsing = /\bUSING\s+KEY\s+\(\s*([\w]+)\s*\)/i.exec(text);
    if (/\b(REFERENCE\s+INTO|GROUP\s+BY|AT\s+GROUP|CASTING)\b/i.test(text) || (/\bUSING\b/i.test(text) && using === null && dynamicUsing === null)) throw new Unsupported(`LOOP form: ${text}`);
    // LOOP AT ref->* (ultra/json, CL_SXML_STRING_READER's reader): what a data
    // reference points to, generic data in Go and JS alike
    const derefLoop = /^([\w\/~]+)->\*$/.exec(st.findFirstExpression(Expressions.LoopSource).concatTokens());
    /** @type {import("./frontend-types.ts").ValueExpr} */ let table;
    if (derefLoop) {
      const ref = variable(derefLoop[1], ctx);
      if (ref.type.k !== "dref") throw new Unsupported(`LOOP AT ->* of a ${ref.type.k}`);
      table = {...ref, type: {k: "data", table: true}};
    } else table = sourceOperand(st.findFirstExpression(Expressions.LoopSource).getFirstChild().getFirstChild(), ctx);
    if (using !== null || dynamicUsing !== null) {
      if (table.type.k !== "table") throw new Unsupported(`LOOP ... USING KEY over a ${table.type.k}`);
      if (/\b(FROM|TO)\b/i.test(text)) throw new Unsupported(`LOOP ... USING KEY with FROM / TO: ${text}`);
      // the order is taken once, before the first pass: a body that could
      // change the table (a call, or a statement naming it) is refused.
      // Names are compared without their qualifier (ultra/json fix round,
      // critic finding 1): LOOP AT zcl_x=>gt with APPEND ... TO gt in the
      // body, or me->mt against mt, is the same table. A4H 2026-09-24
      // ($ZOSG_TMP_0421) visits a row appended during the loop, where the
      // key order taken once would not: refused, not silently wrong.
      // Over-refusal (lo->mt of another instance) is accepted.
      /** @param {string} t @returns {string} */ const bare = (t) => upper(t).replace(/\s+/g, "").replace(/\[.*$/, "").replace(/^.*(=>|->)/, "");
      const name = bare(st.findFirstExpression(Expressions.LoopSource).concatTokens());
      const esc = name.replace(/[^\w]/g, "\\$&");
      /** @param {string} t @returns {boolean} */ const hit = (t) => { const b = bare(t); return b === name || name.startsWith(`${b}-`) || b.startsWith(`${name}-`); };
      for (const s of node.findAllStatementNodes()) {
        if (s === st) continue;
        const stext = upper(s.concatTokens());
        if ((s.findFirstExpression(Expressions.MethodCallChain) || s.findFirstExpression(Expressions.MethodCall) || isStmt(s, Statements.Call))
            && !(ctx.className === "ZCL_AJSON:LCL_JSON_SERIALIZER" && ctx.method === "STRINGIFY_SET")) {
          throw new Unsupported(`LOOP ... USING KEY whose body calls a method: ${s.concatTokens()}`);
        }
        const modifies = /^(APPEND|INSERT|DELETE|MODIFY|SORT|CLEAR|REFRESH|FREE)\b/.test(stext);
        if ((modifies && new RegExp(`(^|[^\\w-]|->|=>)${esc}([^\\w-]|$)`).test(stext))
            || s.findAllExpressions(Expressions.Target).some((t) => hit(t.concatTokens()))) {
          throw new Unsupported(`LOOP ... USING KEY whose body changes the table: ${s.concatTokens()}`);
        }
      }
    }
    if (table.type.k === "data") {
      // LOOP AT <generic table> ASSIGNING <generic>: row by row, bound
      // (an inline FIELD-SYMBOL( ) too: CL_GUI_HTML_VIEWER=>LOAD_DATA, ultra/events)
      const nm = /ASSIGNING\s+(?:FIELD-SYMBOL\(\s*)?(<[\w]+>)/i.exec(text)?.[1];
      const fsType = nm ? ctx.fieldSymbols.get(upper(nm)) : undefined;
      if (!nm || !["data", "struct"].includes(fsType?.k) || /\b(WHERE|FROM|TO|INTO|USING)\b/i.test(text.replace(/ASSIGNING.*/i, ""))) throw new Unsupported(`LOOP form over a generic table: ${text}`);
      // a typed field symbol (ultra/json): each row must be a value of that
      // structure, checked at run time as ASSIGN ref->* TO <typed> is
      /** @type {import("./frontend-types.ts").LoopState} */ const loop = {s: "loop_data", table, fs: upper(nm), ...(fsType.k === "struct" ? {fsType, text} : {}), token: {}};
      (ctx.loopStack ??= []).push(loop);
      try { loop.body = bodyOf(node, ctx); } finally { ctx.loopStack.pop(); }
      return loop;
    }
    if (table.type.k !== "table") throw new Unsupported("LOOP over a non-table");
    const lt = st.findFirstExpression(Expressions.LoopTarget);
    if (!lt) throw new Unsupported(`LOOP form: ${text}`);
    const fsNode = lt.findFirstExpression(Expressions.FSTarget) ?? lt.findFirstExpression(Expressions.TargetFieldSymbol);
    /** @type {import("./frontend-types.ts").ValueExpr | null} */ let into = null;
    /** @type {string | null} */ let fs = null;
    if (/\bASSIGNING\b/i.test(lt.concatTokens())) {
      const nm = /<[\w]+>/.exec(lt.concatTokens())?.[0];
      if (nm === undefined || !ctx.fieldSymbols.has(upper(nm))) throw new Unsupported(`LOOP ASSIGNING ${lt.concatTokens()}`);
      fs = upper(nm);
      if (table.type.row.k === "struct") table.type.stable = true;
    } else {
      // (ultra/events) LOOP ... TRANSPORTING NO FIELDS and the like have no target
      if (!lt?.findFirstExpression(Expressions.Target)) throw new Unsupported(`LOOP form: ${text}`);
      into = lvalue(lt.findFirstExpression(Expressions.Target), ctx);
      // Moving a fixed character row into a string is lossless; both are
      // represented as strings here, and ABAP trims the fixed row at its
      // declared edge rather than requiring identical static types.
      if (!sameType(into.type, table.type.row)
          && !(into.type.k === "string" && charlike(table.type.row))) {
        throw new Unsupported(`LOOP ... INTO a ${into.type.k} over rows of ${table.type.row.k}`);
      }
    }
    void fsNode;
    /** @param {string} kw @returns {import("./frontend-types.ts").ValueExpr | null} */ const bound = (kw) => {
      const e = st.getChildren();
      const at = e.findIndex((c) => isTok(c, kw));
      return at < 0 ? null : convert(source(e[at + 1], ctx, I), I);
    };
    // WHERE comp op value [AND ...]: a row that fails it is not a pass
    const cc = st.findDirectExpression(Expressions.ComponentCond);
    const where = cc ? whereOf(cc, table.type.row, ctx, text) : null;
    const key = using === null ? null : secondaryKey(table.type, using[1], ctx, text);
    // keyLoop compares w.name with w.value directly: a converted or nested component is not there
    if ((using !== null || dynamicUsing !== null) && where?.some((w) => w.fx)) throw new Unsupported(`LOOP ... USING KEY with a WHERE on a component of another type or a nested one: ${text}`);
    const dynamicKeys = dynamicUsing === null ? null : {
      value: convert(variable(dynamicUsing[1], ctx), S),
      options: (table.type.secondary ?? []).filter((x) => x.sorted).map((x) => secondaryKey(table.type, x.name, ctx, text)),
    };
    // ultra/itab: the loop is known to its body, for DELETE itab (the
    // current row) inside it
    // (a shared token object, not the loop itself, so the IR stays a tree)
    /** @type {import("./frontend-types.ts").LoopState} */ const loop = {s: "loop", table, into, fs, where, from: bound("FROM"), to: bound("TO"), rowType: table.type.row, ...(key ? {key} : {}), ...(dynamicKeys ? {dynamicKeys} : {}), token: {}};
    (ctx.loopStack ??= []).push(loop);
    // critic fix: inside the body the loop's field symbol is freshly
    // assigned on every pass until a DELETE of the current row makes it
    // stale (fsCheck below)
    const fresh = fs ? {name: fs, stale: false} : null;
    if (fresh) (ctx.fsFresh ??= []).push(fresh);
    try { loop.body = bodyOf(node, ctx); } finally { ctx.loopStack.pop(); if (fresh) ctx.fsFresh.pop(); }
    return loop;
  }
  throw new Unsupported(`structure ${node.get().constructor.name}`);
}

/*
 * A sorted secondary key of a standard table (ultra/json, /UI2/CL_JSON's
 * LCL_PARSER). Measured on A4H 2026-09-24 (ZCL_GOGEN_T_SECKEY): the key's
 * order is its components ascending, and rows with the same key value come
 * newest first -- in the order they were created, last one first, a key
 * changed through a field symbol keeping the row's place; sy-tabix in a LOOP
 * USING KEY and after a READ ... WITH KEY k COMPONENTS is the position in
 * that order; a READ that finds nothing leaves the target alone and sets
 * sy-tabix to where the value would go, with sy-subrc 4 when that is before
 * a row and 8 when it is past the last one.
 *
 * "Created" is the primary index as long as rows are only added at the end,
 * so the statements that would put a row elsewhere or free a slot (INSERT
 * ... INDEX, SORT, DELETE) are refused on a table with a non-unique sorted
 * key (keyGuard). A hashed secondary key (always unique) is read and
 * deleted by its value only (hashedOk: READ ... WITH KEY k COMPONENTS,
 * DELETE TABLE ... WITH TABLE KEY k COMPONENTS); a LOOP USING it is not in
 * the subset, since its order is not measured. The order is
 * computed where it is used (abap.KeyOrder), never cached, so a key changed
 * in place is always seen.
 *
 * Node's runtime sorts a copy stably, so its duplicates come oldest first:
 * ANORMALIES secondary-key-duplicates. The Go and JS emitters follow A4H.
 */
/** @param {import("./frontend-types.ts").TableType} tableType @param {string} keyName @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @param {boolean} [hashedOk] @returns {import("./ir.ts").ResolvedKey | null} */ function secondaryKey(tableType, keyName, ctx, text, hashedOk = false) {
  const name = upper(keyName);
  if (name === "PRIMARY_KEY") return null;
  const k = (tableType.secondary ?? []).find((x) => x.name === name);
  if (k === undefined) throw new Unsupported(`key ${name}: not a secondary key of the table (${text})`);
  if (!k.sorted && !hashedOk) throw new Unsupported(`key ${name}: a hashed secondary key (${text})`);
  if (tableType.row.k !== "struct") throw new Unsupported(`key ${name} over rows that are not structures`);
  const comps = k.comps.map((c) => {
    const f = fieldOf(ctx, tableType.row, c, text);
    if (!["string", "c", "n", "d", "t", "i", "int8", "f"].includes(f.type.k)) throw new Unsupported(`key ${name}: component ${c} of type ${f.type.k}`);
    return {name: f.name, type: f.type, num: numeric(f.type)};
  });
  return {name, unique: k.unique, comps, ...(k.sorted ? {} : {hashed: true})};
}

/** statements that add a row anywhere but the end, or remove one, on a table with a non-unique sorted secondary key */
/** @param {import("./frontend-types.ts").TableType} tableType @param {string} what @param {import("./frontend-types.ts").MethodContext | null} [ctx] @returns {void} */ function keyGuard(tableType, what, ctx = null) {
  // AJSON's tree has one node per (path,name). The non-unique secondary
  // declarations order only array children (path,index) or ordered object
  // children (path,order); those are unique within their respective sets.
  // Removing a node therefore cannot reorder equal keys seen by stringify.
  if (what === "DELETE" && ctx?.className === "ZCL_AJSON" && tableType.row?.go === "ZIF_AJSON_TYPES__TY_NODE") return;
  const nonUnique = (tableType?.secondary ?? []).filter((k) => !k.unique);
  if (nonUnique.length) throw new Unsupported(`${what} on a table with the non-unique secondary key ${nonUnique[0].name}: the order of its duplicates is measured for rows added at the end only`);
}

/** statements that add rows other than APPEND, on a table with a unique secondary key */
/** @param {import("./frontend-types.ts").TableType} tableType @param {string} what @returns {void} */ function uniqueGuard(tableType, what) {
  const unique = (tableType?.secondary ?? []).filter((k) => k.unique);
  if (unique.length) throw new Unsupported(`${what} on a table with the unique secondary key ${unique[0].name}`);
}

/** String operators share exactly the logical-expression semantics. */
/** @param {string} op @param {import("./frontend-types.ts").ValueExpr} l @param {import("./frontend-types.ts").ValueExpr} r @returns {import("./ir.ts").Condition | null} */ function stringComparison(op, l, r) {
  /** @type {Readonly<Record<string, "cp" | "ca" | "cs" | "co">>} */ const kinds = {CP: "cp", NP: "cp", CA: "ca", NA: "ca", CS: "cs", NS: "cs", CO: "co", CN: "co"};
  if (!kinds[op]) return null;
  const kind = kinds[op];
  // CS keeps the subject's blanks; CA/CO keep both. CP keeps escaped
  // pattern blanks and distinguishes fixed subjects from strings.
  /** @type {import("./ir.ts").Condition} */ const c = {c: kind, l: padded(l), r: kind === "cs" ? convert(r, S) : padded(r),
    cpat: r.type.k === "c", csubject: l.type.k === "c"};
  return ["NP", "NA", "NS", "CN"].includes(op) ? {c: "not", x: c} : c;
}

/** the type two numbers of a WHERE compare in: f, else int8 when both are i/int8 and either is int8 (abapiti 043), else i as before (a packed side keeps its old lowering) */
/** @param {import("./ir.ts").Type} a @param {import("./ir.ts").Type} b @returns {import("./ir.ts").Type} */ const whereCalc = (a, b) => (a.k === "f" || b.k === "f" ? F : numeric(a) && numeric(b) && (a.k === "int8" || b.k === "int8") ? {k: "int8"} : I);

/** WHERE comp op value [AND ...] over the rows of a table of structures */
/** @param {import("@abaplint/core").Nodes.ExpressionNode} cc @param {import("./ir.ts").Type} rowType @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./ir.ts").Where[]} */ function whereOf(cc, rowType, ctx, text) {
  /** @type {import("./ir.ts").Where[]} */ const where = [];
  for (const k of cc.getChildren()) {
    if (isTok(k, "AND")) continue;
    // ultra/itab: a component of a component (param-shape) is read through
    // the row (fx, over the row placeholder lrow); c IS [NOT] INITIAL
    const kids = isExpr(k, Expressions.ComponentCompare) ? k.getChildren() : [];
    const words = kids.slice(1).map((x) => (x instanceof Nodes.TokenNode ? upper(x.concatTokens()) : null));
    const initial = kids.length >= 3 && words[0] === "IS" && words[words.length - 1] === "INITIAL" && (kids.length === 3 || (kids.length === 4 && words[1] === "NOT"));
    if (!initial && (!isExpr(k, Expressions.ComponentCompare) || kids.length !== 3)) throw new Unsupported(`WHERE form: ${cc.concatTokens()}`);
    const path = kids[0].concatTokens().split("-");
    if (rowType.k !== "struct") {
      if (path.length !== 1 || upper(path[0]) !== "TABLE_LINE") throw new Unsupported("WHERE over a table not of structures");
      const fx = {e: "lrow", type: rowType};
      if (initial) {
        where.push({fx, op: kids.length === 4 ? "notinitial" : "initial"});
        continue;
      }
      const opT = upper(kids[1].concatTokens());
      const op = OPS[opT] ?? opT;
      const sc = ["CP", "NP", "CA", "NA", "CS", "NS", "CO", "CN"].includes(op) ? stringComparison(op, fx, source(kids[2], ctx, rowType)) : null;
      if (sc) { where.push({fx: {e: "bool", cond: sc, blank: "", type: C(1)}, op: "=", value: {e: "chars", value: "X", type: C(1)}, calc: S}); continue; }
      if (!["=", "<>", "<", "<=", ">", ">="].includes(op)) throw new Unsupported(`WHERE table_line operator ${op}`);
      const v = source(kids[2], ctx, rowType);
      const calc = numeric(rowType) || numeric(v.type) ? whereCalc(rowType, v.type) : S;
      if (calc !== S && (charlike(rowType) || charlike(v.type))) throw new Unsupported("WHERE comparing characters with a number");
      where.push({fx: calc !== S && numeric(rowType) && calc.k !== rowType.k ? convert(fx, calc) : fx, op, value: convert(v, calc), calc});
      continue;
    }
    let fx = null;
    if (path.length > 1 || initial) {
      fx = {e: "lrow", type: rowType};
      for (const part of path) {
        if (fx.type.k !== "struct") throw new Unsupported(`WHERE component ${kids[0].concatTokens()}`);
        const pf = fieldOf(ctx, fx.type, part, text);
        fx = {e: "field", base: fx, name: pf.name, type: pf.type};
      }
    }
    if (initial) {
      where.push({fx, op: kids.length === 4 ? "notinitial" : "initial"});
      continue;
    }
    const [comp, opN, src] = kids;
    const f = fx !== null ? {name: fx.name, type: fx.type} : fieldOf(ctx, rowType, comp.concatTokens(), text);
    const opT = upper(opN.concatTokens());
    const op = OPS[opT] ?? opT;
    const sc = ["CP", "NP", "CA", "NA", "CS", "NS", "CO", "CN"].includes(op) ? stringComparison(op, fx ?? {e: "field", base: {e: "lrow", type: rowType}, name: f.name, type: f.type}, source(src, ctx, f.type)) : null;
    if (sc) { where.push({fx: {e: "bool", cond: sc, blank: "", type: C(1)}, op: "=", value: {e: "chars", value: "X", type: C(1)}, calc: S}); continue; }
    if (!["=", "<>", "<", "<=", ">", ">="].includes(op)) throw new Unsupported(`WHERE operator ${op}`);
    const v = source(src, ctx, f.type);
    const calc = numeric(f.type) || numeric(v.type) ? whereCalc(f.type, v.type) : S;
    if (calc !== S && (charlike(f.type) || charlike(v.type))) throw new Unsupported("WHERE comparing characters with a number");
    // a component of another numeric type is compared in the calculation type
    const fxc = calc !== S && numeric(f.type) && calc.k !== f.type.k ? convert(fx ?? {e: "field", base: {e: "lrow", type: rowType}, name: f.name, type: f.type}, calc) : fx;
    where.push({name: f.name, ftype: f.type, op, value: convert(v, calc), calc, ...(fxc !== null ? {fx: fxc} : {})});
  }
  return where;
}

/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt | undefined} */ function statement(node, ctx) {
  const text = node.concatTokens();
  // Dynamic access can name any method local, even a literal name omitted
  // from the lowered IR. STATICS and opaque kernel code also retain lifetime.
  if (/^STATICS\b|\bKERNEL\b/i.test(text) || node.findAllExpressions(Expressions.Dynamic).length) ctx.sinkUnsafe = true;
  if (isStmt(node, Statements.Constant) && ctx.localConstants?.has(upper(node.findFirstExpression(Expressions.DefinitionName)?.concatTokens() ?? ""))) return undefined;
  if (isStmt(node, Statements.Data) || isStmt(node, Statements.Constant)) {
    // DATA VALUE is initialized at method entry, including inside loops.
    if (node.findFirstExpression(Expressions.Value)) ctx.inits.push(initialValue(node, ctx));
    return undefined;
  }
  if (isStmt(node, Statements.Type) || isStmt(node, Statements.TypeBegin) || isStmt(node, Statements.TypeEnd)) return undefined;
  if (isStmt(node, Statements.CreateObject)) return createObject(node, ctx);
  if (isStmt(node, Statements.CreateData)) return createDataStatic(node, ctx, text);
  if (isStmt(node, Statements.Assign)) return assignStatement(node, ctx, text);
  // UNASSIGN <fs>: the field symbol is not assigned any more (a later
  // IS ASSIGNED is false, a read of it GETWA_NOT_ASSIGNED)
  if (isStmt(node, Statements.Unassign)) {
    const m = /^UNASSIGN\s+(<[\w\/]+>)\s*\.?$/i.exec(text);
    const name = m ? upper(m[1]) : undefined;
    if (!name || !ctx.fieldSymbols?.has(name)) throw new Unsupported(`statement Unassign: ${text}`);
    return {s: "unassign", fs: {e: "fs", name, type: ctx.fieldSymbols.get(name)}};
  }
  if (isStmt(node, Statements.Select)) return selectStatement(node, ctx, text);
  if (isStmt(node, Statements.Commit) || isStmt(node, Statements.Rollback)) return luwStatement(node, text);
  if (isStmt(node, Statements.InsertDatabase)) return dbWriteStatement("insert", node, ctx, text);
  if (isStmt(node, Statements.UpdateDatabase)) return dbWriteStatement("update", node, ctx, text);
  if (isStmt(node, Statements.ModifyDatabase)) return dbWriteStatement("merge", node, ctx, text);
  if (isStmt(node, Statements.DeleteDatabase)) return dbWriteStatement("delete", node, ctx, text);
  // DELETE dbtab FROM wa parses as DeleteInternal (abaplint cannot tell it
  // from DELETE itab FROM idx without the dictionary); a name that resolves
  // as a variable is the internal table, as ABAP resolves it, even when a
  // TABL of the same name exists
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+\S+\s+FROM\s+/i.test(text)
    && !isVariableName(text.split(/\s+/)[1], ctx)
    && ctx.reg.getObject("TABL", upper(text.split(/\s+/)[1]))) return dbWriteStatement("delete", node, ctx, text);
  // GET REFERENCE OF x INTO r: r is bound to x itself
  if (isStmt(node, Statements.GetReference)) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "dref") throw new Unsupported(`GET REFERENCE INTO a ${target.type.k}`);
    return {s: "get_ref", target, value: convert(source(node.findDirectExpression(Expressions.Source), ctx), {k: "data"})};
  }
  // DESCRIBE FIELD x TYPE k: the type kind (cl_abap_typedescr=>typekind_*)
  if (isStmt(node, Statements.Describe)) {
    if (!/^DESCRIBE\s+FIELD\s+\S+\s+TYPE\s+\S+\s*\.?$/i.test(text)) throw new Unsupported(`DESCRIBE form: ${text}`);
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "c" && target.type.k !== "string") throw new Unsupported(`DESCRIBE ... TYPE into a ${target.type.k}`);
    return {s: "describe_kind", x: convert(source(node.findDirectExpression(Expressions.Source), ctx), {k: "data"}), target};
  }
  // CONDENSE x [NO-GAPS]
  // SHIFT s RIGHT DELETING TRAILING mask on a string, measured on A4H
  // (ZCL_GOGEN_T_SHIFT, 2026-09-23): the trailing characters that are in the
  // mask go and as many blanks come in on the left, so the length stays; a
  // blank not in the mask stops it. Every other SHIFT form is refused.
  if (isStmt(node, Statements.Shift)) {
    if (/^SHIFT\s+\S+(?:\s+BY\s+\S+(?:\s+PLACES)?)?(?:\s+(?:LEFT|RIGHT))?(?:\s+CIRCULAR)?\s*\.?$/i.test(text)) {
      const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
      if (!["string", "c"].includes(target.type.k)) throw new Unsupported(`character SHIFT of a ${target.type.k}`);
      const amount = node.findDirectExpression(Expressions.Source);
      return {s: "shift_places", target, amount: amount ? convert(source(amount, ctx), I) : {e: "int", value: 1, type: I}, left: !/\sRIGHT\b/i.test(text), circular: /\sCIRCULAR\b/i.test(text)};
    }

    // parity-wave2: SHIFT x LEFT CIRCULAR IN BYTE MODE, one byte (CL_ABAP_ZIP's
    // little-endian int2; A4H 2026-09-24, ZCL_GOGEN_T_ZIP: AABB is BBAA,
    // 01020304 is 02030401)
    if (/^SHIFT\s+\S+\s+LEFT\s+CIRCULAR\s+IN\s+BYTE\s+MODE\s*\.?$/i.test(text)) {
      const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
      if (target.type.k !== "x") throw new Unsupported(`SHIFT LEFT CIRCULAR IN BYTE MODE of a ${target.type.k}`);
      return {s: "shift_left_circ_bytes", target};
    }
    // SHIFT s LEFT DELETING LEADING mask on a string or a c: the leading
    // characters that are in the mask go (the runtime's shift.js); a c mask
    // keeps its trailing blanks, so `space` deletes blanks. A c target is
    // stored without trailing blanks, so nothing is padded here.
    if (/^SHIFT\s+\S+\s+LEFT\s+DELETING\s+LEADING\s/i.test(text)) {
      const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
      if (target.type.k !== "string" && target.type.k !== "c") throw new Unsupported(`SHIFT LEFT DELETING LEADING of a ${target.type.k}`);
      const mask = source(node.findDirectExpression(Expressions.Source), ctx);
      if (mask.type.k !== "c" && mask.type.k !== "string") throw new Unsupported(`SHIFT ... DELETING LEADING a ${mask.type.k}`);
      return {s: "shift_left_leading", target, mask: convert(mask, S), maskLen: mask.type.k === "c" ? mask.type.len ?? 1 : undefined};
    }
    if (!/^SHIFT\s+\S+\s+RIGHT\s+DELETING\s+TRAILING\s/i.test(text)) throw new Unsupported(`statement Shift: ${text}`);
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "string") throw new Unsupported(`SHIFT RIGHT DELETING TRAILING of a ${target.type.k}`);
    const mask = source(node.findDirectExpression(Expressions.Source), ctx);
    if (mask.type.k !== "c" && mask.type.k !== "string") throw new Unsupported(`SHIFT ... DELETING TRAILING a ${mask.type.k}`);
    return {s: "shift_right_trailing", target, mask: convert(mask, S), maskLen: mask.type.k === "c" ? mask.type.len ?? 1 : undefined};
  }
  // CONCATENATE a b ... INTO t IN BYTE MODE, t an xstring and every operand
  // an x or an xstring (ultra/packs: the SMW0 loaders of Zork and ZO4D glue
  // WWWDATA_IMPORT's rows together this way). Measured on A4H 2026-09-24
  // (ZCL_GOGEN_T_BYTECAT): an x keeps its trailing x'00', sy-subrc is 0.
  // SEPARATED BY, RESPECTING BLANKS, LINES OF and a target of fixed length
  // stay refused in byte mode; character mode is ultra/events' CONCATENATE
  // further down.
  if (isStmt(node, Statements.Concatenate)) {
    const keywords = node.getChildren().filter((k) => k instanceof Nodes.TokenNode).map((k) => upper(tokenStr(k)));
    const hasKeywords = (...words) => keywords.some((_, i) => words.every((word, j) => keywords[i + j] === word));
    const endsWithKeywords = (...words) => {
      const end = keywords.at(-1) === "." ? keywords.length - 1 : keywords.length;
      const start = end - words.length;
      return start >= 0 && words.every((word, i) => keywords[start + i] === word);
    };
    if (hasKeywords("IN", "BYTE", "MODE")) {
      if (!endsWithKeywords("IN", "BYTE", "MODE") || hasKeywords("SEPARATED") || hasKeywords("RESPECTING")) throw new Unsupported(`CONCATENATE form: ${text}`);
      const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
      // CONCATENATE LINES OF itab INTO xstr IN BYTE MODE: the rows joined once,
      // the way a reader gathers its pieces without copying the whole each time
      if (hasKeywords("LINES", "OF") && keywords[1] === "LINES" && keywords[2] === "OF") {
        const table = source(node.findDirectExpressions(Expressions.SimpleSource3)[0] ?? node.findDirectExpression(Expressions.Source), ctx);
        if (target.type.k !== "xstring" || table?.type.k !== "table" || table.type.row.k !== "xstring") throw new Unsupported(`CONCATENATE form: ${text}`);
        return {s: "concat_bytes", target, table, row: {e: "temp", name: "ConcatRow", type: table.type.row}};
      }
      // parity-wave2: into an x of fixed length (A4H 2026-09-24,
      // ZCL_GOGEN_T_BYTECATX): padded with 00 on the right and sy-subrc 0,
      // cut to the length and sy-subrc 4 when longer; the operands, the target
      // among them, are read first
      if (target.type.k !== "xstring" && target.type.k !== "x") throw new Unsupported(`CONCATENATE IN BYTE MODE into a ${target.type.k}`);
      const parts = node.findDirectExpressions(Expressions.SimpleSource3).map((n) => source(n, ctx));
      if (parts.length < 2) throw new Unsupported(`CONCATENATE form: ${text}`);
      for (const p of parts) if (p.type.k !== "x" && p.type.k !== "xstring") throw new Unsupported(`CONCATENATE IN BYTE MODE of a ${p.type.k}`);
      return {s: "concat_bytes", target, parts: parts.map((p) => convert(p, XS)), fixed: target.type.k === "x" ? target.type.len : undefined};
    }
  }
  if (isStmt(node, Statements.Condense)) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "c" && target.type.k !== "string") throw new Unsupported(`CONDENSE of a ${target.type.k}`);
    return {s: "condense", target, noGaps: /\bNO\s*-\s*GAPS\b/i.test(text)};
  }
  // ASSERT: a false condition ends the program (ASSERTION_FAILED, a runtime
  // error no CATCH reaches); no checkpoint group, so always active
  if (isStmt(node, Statements.Assert)) {
    if (/\bID\b/i.test(node.concatTokens())) throw new Unsupported(`ASSERT with a checkpoint group: ${node.concatTokens()}`);
    return {s: "assert", cond: cond(node.findDirectExpression(Expressions.Cond), ctx), text: node.concatTokens()};
  }
  if ([Statements.Add, Statements.Subtract, Statements.Multiply, Statements.Divide].some((kind) => isStmt(node, kind))) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const operand = source(node.findDirectExpression(Expressions.Source), ctx);
    const kinds = [target.type.k, operand.type.k];
    if (!kinds.every((k) => ["i", "int8", "p", "f", "c", "string", "n", "x"].includes(k))) {
      throw new Unsupported(`arithmetic statement types ${kinds.join(" and ")}: ${text}`);
    }
    // As in an assignment expression, the target takes part in choosing the
    // calculation type. Character operands and packed targets calculate in
    // packed decimal; an x field enters as an integer.
    const calc = kinds.includes("f") ? F
      : kinds.some((k) => ["p", "c", "string", "n"].includes(k)) ? P31
        : kinds.includes("int8") ? INT8 : I;
    const op = isStmt(node, Statements.Add) ? "+" : isStmt(node, Statements.Subtract) ? "-"
      : isStmt(node, Statements.Multiply) ? "*" : "/";
    const left = convert(target, calc);
    const right = convert(operand, calc);
    return {s: "assign", target, value: convert({e: "bin", op, l: left, r: right, type: calc}, target.type)};
  }
  if (isStmt(node, Statements.Move)) {
    const targets = node.findDirectExpressions(Expressions.Target);
    if (targets.length !== 1) throw new Unsupported("chained assignment");
    const src = node.findDirectExpression(Expressions.Source);
    const inline = targets[0].getChildren()[0];
    if (isExpr(inline, Expressions.InlineData)) {
      // DATA(x) = ... takes the type of what is assigned. abaplint types some
      // built-ins by a fixed return (frac( ) as i, _builtin.js), where ABAP
      // gives the argument's type: frac( f ) is an f (A4H: pulse 0.25, not 0)
      const name = upper(inline.findFirstExpression(Expressions.TargetField).concatTokens());
      const declared = ctx.locals.get(name);
      // abaplint types DATA(x) = 'ab' & 'cd' as the first literal, c LENGTH 2
      const joined = declared?.k === "c" && src.findFirstExpression(Expressions.ConcatenatedConstant);
      if (declared && (numeric(declared) || joined)) {
        let t;
        try { t = source(src, ctx).type; } catch (e) { if (!(e instanceof Unsupported)) throw e; }
        if (t && ((numeric(t) && declared.k !== t.k) || (joined && t.k === "c" && t.len !== declared.len))) ctx.locals.set(name, t);
      }
    }
    const target = lvalue(targets[0], ctx);
    // a ?= b: a down-cast, checked at run time
    if (node.getChildren().some((c) => isTok(c, "?="))) return {s: "assign", target, value: downCast(source(src, ctx), target.type, node.concatTokens())};
    // a generic target is a binding: the value is written into its slot
    // (ultra/itab: genericArith reads the target's kind through ctx.genTarget)
    if (target.type.k === "data") {
      ctx.genTarget = target;
      try { return {s: "set_data", target, value: convert(source(src, ctx, target.type), target.type)}; } finally { ctx.genTarget = undefined; }
    }
    // the calculation type of an assignment includes the TARGET
    return {s: "assign", target, value: convert(source(src, ctx, target.type), target.type)};
  }
  // ultra/itab: APPEND LINES OF src [FROM i] [TO j] TO itab (A4H 2026-09-24,
  // ZCL_GOGEN_T_APPL): the rows i..j of src in order, j clamped to lines(src),
  // nothing when i > j or i past the end; FROM or TO below 1 is the
  // uncatchable TABLE_INVALID_INDEX; sy-subrc untouched, sy-tabix
  // lines(itab) afterwards, whatever was appended; each row converted as a
  // move (c into string); src evaluated once, so itab TO itab doubles it
  if (isStmt(node, Statements.Append) && /^APPEND\s+LINES\s+OF\b/i.test(text)) {
    if (/\b(ASSIGNING|REFERENCE|SORTED BY)\b/i.test(text)) throw new Unsupported(`APPEND form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table" || table.type.hashed) throw new Unsupported(`APPEND LINES OF into a ${table.type.hashed ? "hashed table" : table.type.k}`);
    const kids = node.getChildren();
    const srcNode = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
    const src = source(srcNode, ctx);
    if (src.type.k !== "table") throw new Unsupported(`APPEND LINES OF a ${src.type.k}`);
    let from = null;
    let to = null;
    for (let i = 0; i + 1 < kids.length; i += 1) {
      const next = kids[i + 1];
      if (!isExpr(next, Expressions.Source) || next === srcNode) continue;
      if (isTok(kids[i], "FROM")) from = convert(source(next, ctx, I), I);
      else if (isTok(kids[i], "TO")) to = convert(source(next, ctx, I), I);
    }
    const value = convert({e: "lrow", type: src.type.row}, table.type.row);
    refuseSorted(table, "APPEND LINES OF into");
    return {s: "append_lines", table, src, from, to, value};
  }
  // APPEND REFERENCE INTO binds the new row, including after later appends.
  if (isStmt(node, Statements.Append) && /\bREFERENCE\s+INTO\b/i.test(text)) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const name = /\bREFERENCE\s+INTO\s+([\w-]+)/i.exec(text)?.[1];
    if (table.type.k !== "table" || !name) throw new Unsupported(`APPEND REFERENCE INTO form: ${text}`);
    refuseSorted(table, "APPEND to");
    const refInto = variable(name, ctx);
    if (refInto.type.k !== "dref") throw new Unsupported(`APPEND REFERENCE INTO a ${refInto.type.k}`);
    const initial = /\bINITIAL\s+LINE\b/i.test(text);
    const valueNode = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
    if (!initial && !valueNode) throw new Unsupported(`APPEND REFERENCE INTO form: ${text}`);
    table.type.stable = true;
    return {s: "append", table, value: initial ? {e: "zero", type: table.type.row} : convert(source(valueNode, ctx, table.type.row), table.type.row), refInto};
  }
  // APPEND ASSIGNING gives the field symbol the new row's address.
  if (isStmt(node, Statements.Append) && /\bASSIGNING\b/i.test(text) && !/\b(LINES OF|INITIAL LINE|REFERENCE|SORTED BY)\b/i.test(text)) {
    const fsName = upper(node.findDirectExpression(Expressions.FSTarget)?.concatTokens() ?? "");
    const fsType = ctx.fieldSymbols.get(fsName);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table") throw new Unsupported(`APPEND ... ASSIGNING to a ${table.type.k}`);
    refuseSorted(table, "APPEND to");
    if (!fsType || fsType.k === "data" || !sameType(fsType, table.type.row) || (fsType.k === "struct" && fsType.go !== table.type.row.go)) throw new Unsupported(`APPEND ... ASSIGNING ${fsName}: ${text}`);
    if (table.type.row.k === "struct") table.type.stable = true;
    const value = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
    return {s: "append", table, value: convert(source(value, ctx, table.type.row), table.type.row), fs: fsName};
  }
  // ultra/events: CONCATENATE (A4H ZCL_GOGEN_T_WGUI1): a c operand without
  // its trailing blanks unless RESPECTING BLANKS, a string as it is, the
  // separator with its blanks; into a c the result is cut (sy-subrc 4),
  // else sy-subrc 0; LINES OF an empty table clears the target
  if (isStmt(node, Statements.Concatenate)) {
    const kids = node.getChildren();
    const keywords = node.getChildren().filter((k) => k instanceof Nodes.TokenNode).map((k) => upper(tokenStr(k)));
    const hasKeywords = (...words) => keywords.some((_, i) => words.every((word, j) => keywords[i + j] === word));
    const respecting = hasKeywords("RESPECTING", "BLANKS");
    const lines = keywords[1] === "LINES" && keywords[2] === "OF";
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (!["string", "c", "n", "d"].includes(target.type.k)) throw new Unsupported(`CONCATENATE into a ${target.type.k}`);
    const piece = (x) => {
      if (x.type.k === "c") return respecting ? {e: "padc", x, n: x.type.len, type: S} : convert(x, S);
      if (["string", "n", "d", "t"].includes(x.type.k)) return convert(x, S);
      throw new Unsupported(`CONCATENATE of a ${x.type.k}`);
    };
    let sep = null;
    const parts = [];
    let table = null;
    for (let i = 0; i < kids.length; i += 1) {
      if (isTok(kids[i], "BY") && isTok(kids[i - 1], "SEPARATED")) {
        const x = source(kids[i + 1], ctx);
        sep = x.type.k === "c" ? {e: "padc", x, n: x.type.len, type: S} : piece(x);
        i += 1;
        continue;
      }
      if (isTok(kids[i], "INTO")) { i += 1; continue; }
      if (isExpr(kids[i], Expressions.SimpleSource3) || isExpr(kids[i], Expressions.Source)) {
        if (lines) table = source(kids[i], ctx);
        else parts.push(piece(source(kids[i], ctx)));
      }
    }
    if (lines) {
      if (table?.type.k !== "table") throw new Unsupported(`CONCATENATE LINES OF a ${table?.type.k}`);
      return {s: "concat", target, sep, table, row: piece({e: "temp", name: "ConcatRow", type: table.type.row})};
    }
    return {s: "concat", target, sep, parts};
  }
  // ultra/events: APPEND INITIAL LINE TO itab ASSIGNING <fs> (ZCL_ABAPGIT_CONVERT=>
  // STRING_TO_TAB, over a generic STANDARD TABLE): a new initial row, <fs>
  // on it, sy-tabix its index
  if (isStmt(node, Statements.Append) && /^APPEND\s+INITIAL\s+LINE\s+TO\s+\S+\s+ASSIGNING\s+<[\w]+>\s*\.?$/i.test(text)) {
    const fsName = upper(node.findDirectExpression(Expressions.FSTarget)?.concatTokens() ?? "");
    const fsType = ctx.fieldSymbols.get(fsName);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k === "data" && table.type.table && fsType?.k === "data") return {s: "append_initial_data", table, fs: fsName};
    if (table.type.k !== "table" || !fsType || fsType.k === "data" || !sameType(fsType, table.type.row)) throw new Unsupported(`APPEND form: ${text}`);
    refuseSorted(table, "APPEND to");
    table.type.stable = true;
    return {s: "append", table, value: {e: "zero", type: table.type.row}, fs: fsName};
  }
  if (isStmt(node, Statements.Append)) {
    if (/\b(LINES OF|INITIAL LINE|ASSIGNING|REFERENCE|SORTED BY)\b/i.test(text)) throw new Unsupported(`APPEND form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    // APPEND wa TO <generic table> (a field symbol TYPE STANDARD TABLE, the
    // rows of CREATE DATA ... TYPE STANDARD TABLE OF (name)): a new row, the
    // value moved into it as a move into generic data converts it
    if (table.type.k === "data") {
      const value = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
      return {s: "append_data", table, value: convert(source(value, ctx), {k: "data"})};
    }
    if (table.type.k !== "table") throw new Unsupported("APPEND to a non-table");
    const value = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
    refuseSorted(table, "APPEND to");
    return {s: "append", table, value: convert(source(value, ctx, table.type.row), table.type.row)};
  }
  if (isStmt(node, Statements.ReadTable) && /\bWITH\s+(TABLE\s+)?KEY\b/i.test(text)) {
    // READ TABLE t [INTO wa | ASSIGNING <fs> | TRANSPORTING NO FIELDS] WITH [TABLE] KEY c = v ...:
    // the first row whose components equal the values (each converted to the
    // component's type); sy-subrc 0 / 4, sy-tabix the row (0 for a HASHED
    // table), the target left alone when nothing is found
    if (/\b(BINARY|CASTING|COMPARING)\b/i.test(text) || (/\bTRANSPORTING\b/i.test(text) && !/\bTRANSPORTING\s+NO\s+FIELDS\b/i.test(text))) {
      throw new Unsupported(`READ TABLE form: ${text}`);
    }
    const ss2 = node.findDirectExpression(Expressions.SimpleSource2);
    if (!ss2) throw new Unsupported(`READ TABLE table form: ${text}`);
    const table = sourceOperand(ss2.getFirstChild(), ctx);
    if (table.type.k !== "table") throw new Unsupported("READ TABLE of a non-table");
    const cc = node.findDirectExpression(Expressions.ComponentCompareSimple);
    if (!cc) throw new Unsupported(`READ TABLE key form: ${text}`);
    const kids = cc.getChildren();
    const keys = [];
    for (let i = 0; i + 2 < kids.length + 1; i += 3) {
      const comp = kids[i];
      if (!comp || !isTok(kids[i + 1], "=")) throw new Unsupported(`READ TABLE key form: ${cc.concatTokens()}`);
      const cname = upper(comp.concatTokens());
      if (cname === "TABLE_LINE") {
        keys.push({line: true, value: convert(source(kids[i + 2], ctx, table.type.row), table.type.row)});
      } else {
        const f = fieldOf(ctx, table.type.row, cname, text);
        keys.push({name: f.name, value: convert(source(kids[i + 2], ctx, f.type), f.type)});
      }
    }
    const rt = node.findFirstExpression(Expressions.ReadTableTarget);
    let into = null;
    let fs = null;
    let refInto = false;
    if (rt && /\bASSIGNING\b/i.test(rt.concatTokens())) {
      fs = upper(/<[\w]+>/.exec(rt.concatTokens())?.[0] ?? "");
      if (!ctx.fieldSymbols.has(fs)) throw new Unsupported(`READ TABLE ASSIGNING ${fs}`);
      if (table.type.row.k === "struct") table.type.stable = true;
    } else if (rt && /^TRANSPORTING\s+NO\s+FIELDS$/i.test(rt.concatTokens().trim())) {
      // only sy-subrc and sy-tabix
    } else if (rt) {
      const tgt = rt.findFirstExpression(Expressions.Target);
      if (!tgt) throw new Unsupported(`READ TABLE target form: ${rt.concatTokens()}`);
      into = lvalue(tgt, ctx);
      refInto = /\bREFERENCE\s+INTO\b/i.test(rt.concatTokens());
      if (refInto) {
        if (into.type.k !== "dref") throw new Unsupported(`READ TABLE REFERENCE INTO a ${into.type.k}`);
        table.type.stable = true;
      } else if (!sameType(into.type, table.type.row)) into = {...into, conv: true};
    }
    // WITH [TABLE] KEY k COMPONENTS c = v ...: a secondary key's order (secondaryKey)
    // with every component of the key given, each once; it was read as a
    // primary-order search until ultra/json, silently
    const named = /\bWITH\s+(?:TABLE\s+)?KEY\s+([\w~]+)\s+COMPONENTS\b/i.exec(text);
    if (named !== null) {
      const key = secondaryKey(table.type, named[1], ctx, text, true);
      if (key === null) throw new Unsupported(`READ TABLE WITH KEY primary_key COMPONENTS: ${text}`);
      // read_key refuses the same in emit-go; the hashed path does not convert the row
      if (key.hashed && into?.conv) throw new Unsupported(`READ TABLE WITH KEY ${key.name} INTO a work area of another type (${text})`);
      const given = keys.map((x) => x.name);
      if (keys.some((x) => x.line) || given.length !== key.comps.length || new Set(given).size !== given.length || !key.comps.every((c) => given.includes(c.name))) {
        throw new Unsupported(`READ TABLE WITH KEY ${key.name}: not every component of the key once (${text})`);
      }
      // the values in the key's own order
      const values = key.comps.map((c) => keys.find((x) => x.name === c.name).value);
      return {s: "read_seckey", table, key, values, into, fs, refInto};
    }
    // ultra/events (fix round): a SORTED table is searched by its key (A4H
    // 2026-09-24, ZCL_GOGEN_T_SORTRD). The key components given from the
    // left of the table key (the whole key or a leading part of it) find the
    // first row whose key part is not less: a hit is the first row of that
    // range matching every component; a miss is sy-subrc 4 and sy-tabix that
    // row, or 8 and lines + 1 past the end. Without the first key
    // component the search is linear and a miss is 4 / 0. A leading part
    // with components outside the key besides gave misses no rule covers
    // (4/3, 8/5 and 4/-1 on A4H), so such a miss is NOT_COMPILED at run time.
    let sorted = null;
    if (table.type.sorted) {
      const line = table.type.sorted.length === 1 && table.type.sorted[0] === "TABLE_LINE";
      const prefix = [];
      for (const k of table.type.sorted) {
        const hit = line ? keys.find((x) => x.line) : keys.find((x) => !x.line && x.name === fieldOf(ctx, table.type.row, k, text).name);
        if (!hit) break;
        const kt = line ? table.type.row : fieldOf(ctx, table.type.row, k, text).type;
        if (!["c", "string", "n", "d", "t", "i", "int8"].includes(kt.k)) throw new Unsupported(`READ TABLE of a SORTED table keyed on a ${kt.k}`);
        prefix.push(keys.indexOf(hit));
      }
      sorted = {prefix, extra: keys.length > prefix.length};
    }
    return {s: "read_key", table, keys, into, fs, refInto, hashed: !!table.type.hashed, sorted};
  }
  if (isStmt(node, Statements.ReadTable)) {
    if (!/\bINDEX\b/i.test(text) || /\b(WITH KEY|REFERENCE|TRANSPORTING|BINARY|CASTING)\b/i.test(text)) {
      throw new Unsupported(`READ TABLE form: ${text}`);
    }
    const table = sourceOperand(node.findDirectExpression(Expressions.SimpleSource2).getFirstChild(), ctx);
    // a generic table (ultra/sadl): READ TABLE <t> INDEX n ASSIGNING <generic> only
    if (table.type.k === "data" && table.type.table) {
      const fsName = upper(/ASSIGNING\s+(<[\w]+>)/i.exec(text)?.[1] ?? "");
      if (!fsName || ctx.fieldSymbols.get(fsName)?.k !== "data") throw new Unsupported(`READ TABLE form over a generic table: ${text}`);
      return {s: "read_index_data", table, index: convert(source(node.findDirectExpression(Expressions.Source), ctx, I), I), fs: fsName};
    }
    if (table.type.k !== "table") throw new Unsupported(`READ TABLE ... INDEX of a ${table.type.k}`);
    const index = convert(source(node.findDirectExpression(Expressions.Source), ctx, I), I);
    if (/\bASSIGNING\b/i.test(text)) {
      // the field symbol after ASSIGNING, not the first one in the text: READ
      // TABLE <a>-t ASSIGNING <b> bound <a> (ultra/events, ZCL_GG_HTTP_HANDLER)
      const fsName = upper(/ASSIGNING\s+(?:FIELD-SYMBOL\(\s*)?(<[\w]+>)/i.exec(text)?.[1] ?? "");
      if (!ctx.fieldSymbols.has(fsName)) throw new Unsupported(`READ TABLE ASSIGNING ${fsName}`);
      if (ctx.fieldSymbols.get(fsName).k !== "data" && !sameType(ctx.fieldSymbols.get(fsName), table.type.row)) throw new Unsupported(`READ TABLE ASSIGNING ${fsName}: typed unlike the rows`);
      if (table.type.row.k === "struct") table.type.stable = true;
      return {s: "read_index", table, index, fs: fsName};
    }
    const into = lvalue(node.findFirstExpression(Expressions.ReadTableTarget).findFirstExpression(Expressions.Target), ctx);
    return {s: "read_index", table, index, into};
  }
  // ultra/itab: SORT itab [ASCENDING|DESCENDING] [STABLE] [BY c [ASC|DESC] ...]
  // (A4H 2026-09-24, ZCL_GOGEN_T_SORTK). The emitters sort stably, which is
  // what STABLE asks and what A4H showed for equal keys without it. Without
  // BY: the primary key, for a table WITH DEFAULT KEY the line itself when it
  // is elementary, else its c and string components (the ones measured; i is
  // left out); the direction after SORT itab is that of every component that
  // names none. AS TEXT (locale collation) is not measured: refused.
  if (isStmt(node, Statements.Sort)) {
    const m = /^SORT\s+(\S+)((?:\s+(?:ASCENDING|DESCENDING|STABLE))*)(?:\s+BY\s+(.*?))?\s*\.?$/i.exec(text);
    if (m === null || /\bAS\s+TEXT\b/i.test(text)) throw new Unsupported(`SORT form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target) ?? node.findFirstExpression(Expressions.Target), ctx);
    if (table.type.k !== "table" || table.type.hashed) throw new Unsupported(`SORT of a ${table.type.hashed ? "hashed table" : table.type.k}`);
    const allDesc = /\bDESCENDING\b/i.test(m[2]);
    const row = table.type.row;
    const sortable = (t) => ["i", "int8", "f", "p", "c", "string", "n", "d", "t", "x", "xstring"].includes(t.k);
    const keys = [];
    if (m[3] === undefined) {
      if (row.k !== "struct") {
        if (table.type.skey !== "default" && !(Array.isArray(table.type.skey) && table.type.skey.length === 1 && table.type.skey[0] === "TABLE_LINE")) throw new Unsupported(`SORT without BY of a table whose key is not known here: ${text}`);
        if (!sortable(row)) throw new Unsupported(`SORT of a table of ${row.k}`);
        keys.push({line: true, type: row, desc: allDesc});
      } else if (table.type.skey === "default") {
        for (const f of PROGRAM.structs.get(row.go).fields) {
          if (f.type.k === "c" || f.type.k === "string") keys.push({name: f.name, type: f.type, desc: allDesc});
          else if (!["i", "int8", "f", "p"].includes(f.type.k)) throw new Unsupported(`SORT by the default key of a structure with a ${f.type.k} component: not measured`);
        }
      } else if (Array.isArray(table.type.skey) && table.type.skey.length > 0) {
        for (const k of table.type.skey) {
          const f = fieldOf(ctx, row, k, text);
          if (!sortable(f.type)) throw new Unsupported(`SORT by a ${f.type.k} component`);
          keys.push({name: f.name, type: f.type, desc: allDesc});
        }
      } else {
        throw new Unsupported(`SORT without BY of a table whose key is not known here: ${text}`);
      }
    } else {
      if (/[()]/.test(m[3])) throw new Unsupported(`SORT form: ${text}`);
      const words = m[3].trim().split(/\s+/);
      for (let i = 0; i < words.length; i += 1) {
        let key;
        if (upper(words[i]) === "TABLE_LINE") {
          if (row.k === "struct" || !sortable(row)) throw new Unsupported(`SORT BY table_line of a table of ${row.k}`);
          key = {line: true, type: row};
        } else {
          if (row.k !== "struct") throw new Unsupported("SORT BY a component of a table that is not of structures");
          if (words[i].includes("-")) throw new Unsupported(`SORT BY a nested component: ${text}`);
          const f = fieldOf(ctx, row, words[i], text);
          if (!sortable(f.type)) throw new Unsupported(`SORT by a ${f.type.k} component`);
          key = {name: f.name, type: f.type};
        }
        let desc = allDesc;
        if (/^(ASCENDING|DESCENDING)$/i.test(words[i + 1] ?? "")) { desc = /^DESCENDING$/i.test(words[i + 1]); i += 1; }
        keys.push({...key, desc});
      }
    }
    keyGuard(table.type, "SORT");
    refuseSorted(table, "SORT of");
    return {s: "sort", table, keys};
  }
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+ADJACENT\s+DUPLICATES\s+FROM\s+\S+\s+COMPARING\s+ALL\s+FIELDS\s*\.?$/i.test(text)) {
    const name = /^DELETE\s+ADJACENT\s+DUPLICATES\s+FROM\s+(\S+)/i.exec(text)[1];
    const table = variable(name, ctx);
    if (table.type.k !== "table" || table.type.hashed || table.type.row.k !== "struct") throw new Unsupported(`DELETE ADJACENT DUPLICATES from a ${table.type.k}`);
    keyGuard(table.type, "DELETE ADJACENT DUPLICATES");
    const fields = ctx.program.structs.get(table.type.row.go)?.fields ?? [];
    if (!fields.length || fields.some((f) => !["string", "c", "n", "d", "t", "i", "int8", "f"].includes(f.type.k))) throw new Unsupported(`DELETE ADJACENT DUPLICATES of a row with deep or unsupported fields`);
    return {s: "delete_adjacent", table, fields: fields.map((f) => f.name)};
  }
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+\S+\s+WHERE\s+/i.test(text)) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table") throw new Unsupported("DELETE from a non-table");
    const cc = node.findDirectExpression(Expressions.ComponentCond);
    if (!cc) throw new Unsupported(`DELETE form: ${text}`);
    keyGuard(table.type, "DELETE", ctx);
    return {s: "delete_where", table, where: whereOf(cc, table.type.row, ctx, text)};
  }
  // DELETE TABLE itab WITH TABLE KEY k COMPONENTS c = v ...: the row a unique
  // secondary key holds the values in, every component of the key given once
  // (abapiti's maps, a hashed key; secondaryKey)
  const namedDelete = /^DELETE\s+TABLE\s+\S+\s+WITH\s+TABLE\s+KEY\s+([\w~]+)\s+COMPONENTS\b/i.exec(text);
  if (isStmt(node, Statements.DeleteInternal) && namedDelete) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table") throw new Unsupported("DELETE from a non-table");
    const key = secondaryKey(table.type, namedDelete[1], ctx, text, true);
    if (key === null || !key.unique) throw new Unsupported(`DELETE TABLE WITH TABLE KEY ${upper(namedDelete[1])}: not a unique secondary key (${text})`);
    const given = node.findDirectExpressions(Expressions.ComponentCompare).map((cc) => {
      const kids = cc.getChildren();
      if (kids.length !== 3 || kids[1].concatTokens() !== "=") throw new Unsupported(`DELETE TABLE key form: ${cc.concatTokens()}`);
      const f = fieldOf(ctx, table.type.row, kids[0].concatTokens(), text);
      return {name: f.name, value: convert(source(kids[2], ctx, f.type), f.type)};
    });
    const names = given.map((x) => x.name);
    if (names.length !== key.comps.length || new Set(names).size !== names.length || !key.comps.every((c) => names.includes(c.name))) {
      throw new Unsupported(`DELETE TABLE WITH TABLE KEY ${key.name}: not every component of the key once (${text})`);
    }
    keyGuard(table.type, "DELETE TABLE");
    const bare = (x) => JSON.stringify(x, (k, v) => (k === "type" ? undefined : v));
    if (ctx.loopStack?.some((l) => bare(l.table) === bare(table))) throw new Unsupported(`${text.replace(/\s*\.$/, "")} inside a LOOP over the same table: the loop index and its field symbol were not adjusted`);
    return {s: "delete_seckey", table, key, values: key.comps.map((c) => given.find((x) => x.name === c.name).value)};
  }
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+TABLE\s+\S+\s+WITH\s+TABLE\s+KEY\s+/i.test(text)) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const key = /^DELETE\s+TABLE\s+\S+\s+WITH\s+TABLE\s+KEY\s+(\w+)\s*=\s*([\w-]+)\s*\.?$/i.exec(text);
    const keyExpr = node.getChildren().find((x) => x.concatTokens().trim() === `${key?.[1]} = ${key?.[2]}`);
    const value = keyExpr?.getChildren()[2];
    if (!key || !value || table.type.k !== "table" || table.type.row.k !== "struct") throw new Unsupported(`DELETE form: ${text}`);
    const field = fieldOf(ctx, table.type.row, key[1], text);
    keyGuard(table.type, "DELETE TABLE");
    return {s: "delete_key", table, key: field.name, value: convert(source(value, ctx, field.type), field.type)};
  }
  // DELETE TABLE itab FROM wa: the first row whose primary key equals wa's
  // goes (the ADT front's namespace bindings, a HASHED table); a key that
  // is a standard table's default key or the whole line is not here
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+TABLE\s+[^\s.]+\s+FROM\s+[^\s.]+\s*\.?$/i.test(text)) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const keys = table.type.k === "table" ? table.type.hashed ?? table.type.sorted : null;
    if (!keys || table.type.row.k !== "struct" || keys.includes("TABLE_LINE")) throw new Unsupported(`DELETE form: ${text}`);
    const fields = keys.map((k) => fieldOf(ctx, table.type.row, k, text));
    for (const f of fields) if (!["c", "string", "n", "d", "t", "i", "int8"].includes(f.type.k)) throw new Unsupported(`DELETE TABLE FROM keyed on a ${f.type.k}`);
    keyGuard(table.type, "DELETE TABLE");
    // critic of #688: inside a LOOP over the same table a system steps the
    // loop back and unassigns its field symbol; neither emitter does
    const bare = (x) => JSON.stringify(x, (k, v) => (k === "type" ? undefined : v));
    if (ctx.loopStack?.some((l) => bare(l.table) === bare(table))) throw new Unsupported(`${text.replace(/\s*\.$/, "")} inside a LOOP over the same table: the loop index and its field symbol were not adjusted`);
    const vNode = node.findDirectExpression(Expressions.Source) ?? node.findDirectExpression(Expressions.SimpleSource2);
    if (!vNode) throw new Unsupported(`DELETE form: ${text}`);
    return {s: "delete_from", table, value: convert(source(vNode, ctx, table.type.row), table.type.row), keys: fields.map((f) => f.name)};
  }
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+\S+\s+FROM\s+/i.test(text)) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table" || table.type.hashed || table.type.sorted) throw new Unsupported(`DELETE range of a ${table.type.k}`);
    const indices = node.findDirectExpressions(Expressions.Source);
    if (indices.length < 1 || indices.length > 2) throw new Unsupported(`DELETE range form: ${text}`);
    keyGuard(table.type, "DELETE range");
    return {s: "delete_range", table, from: convert(source(indices[0], ctx, I), I),
      to: indices[1] ? convert(source(indices[1], ctx, I), I) : null};
  }
  // ultra/itab: DELETE itab, the short form inside LOOP AT itab: the
  // current row goes and the loop goes on with the row after it (A4H
  // ZCL_GOGEN_T_NSCN); only in the innermost loop, over that same table
  if (isStmt(node, Statements.DeleteInternal) && /^DELETE\s+[^\s.]+\s*\.?$/i.test(text)) {
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const loop = ctx.loopStack?.[ctx.loopStack.length - 1];
    const same = (a, b) => JSON.stringify(a, (k, v) => (k === "type" ? undefined : v)) === JSON.stringify(b, (k, v) => (k === "type" ? undefined : v));
    if (!loop || table.type.k !== "table" || !same(loop.table, table)) throw new Unsupported(`DELETE itab outside a LOOP over it: ${text}`);
    // critic fix: LOOP ... TO n with a deletion was not measured (the TO
    // bound would stay absolute while the index steps back)
    if (loop.to !== null) throw new Unsupported(`DELETE itab inside LOOP ... TO: not measured: ${text}`);
    // critic fix: what <fs> of LOOP ... ASSIGNING <fs> is after its row went
    // was not measured (Go would see the next row, JS the deleted one), so
    // any later use of it in the method is refused (fsCheck)
    if (loop.fs) {
      const fresh = ctx.fsFresh?.findLast((f) => f.name === loop.fs);
      if (fresh) fresh.stale = true;
      (ctx.fsGone ??= new Set()).add(loop.fs);
    }
    return {s: "delete_current", table, token: loop.token};
  }
  if (isStmt(node, Statements.DeleteInternal)) {
    if (!/^DELETE\s+\S+\s+INDEX\s+/i.test(text)) throw new Unsupported(`DELETE form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    // Like DELETE current, INDEX at or before the cursor steps it back.
    const same = (a, b) => JSON.stringify(a, (k, v) => k === "type" ? undefined : v) === JSON.stringify(b, (k, v) => k === "type" ? undefined : v);
    const loops = (ctx.loopStack ?? []).filter((loop) => same(loop.table, table));
    if (loops.some((loop) => loop.to || loop.key || loop.dynamicKeys)) throw new Unsupported(`DELETE INDEX inside LOOP with TO / USING KEY: not measured: ${text}`);
    const tokens = loops.map((loop) => loop.token);
    // a generic table (ultra/sadl): the same rule through its descriptor
    if (table.type.k === "data" && table.type.table) return {s: "delete_index_data", table, tokens, index: convert(source(node.findDirectExpressions(Expressions.Source).slice(-1)[0], ctx, I), I)};
    if (table.type.k !== "table") throw new Unsupported("DELETE from a non-table");
    const idx = node.findDirectExpressions(Expressions.Source).slice(-1)[0];
    keyGuard(table.type, "DELETE", ctx);
    return {s: "delete_index", table, tokens, index: convert(source(idx, ctx, I), I)};
  }
  if (isStmt(node, Statements.InsertInternal) && /\bINTO\s+TABLE\b/i.test(text)) {
    if (/^INSERT\s+LINES\s+OF\b/i.test(text)) {
      const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
      const srcNode = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
      const src = source(srcNode, ctx);
      if (table.type.k !== "table" || src.type.k !== "table" || !table.type.sorted || !table.type.unique || !sameType(src.type.row, table.type.row)) throw new Unsupported(`INSERT LINES OF form: ${text}`);
      const keys = table.type.sorted.map((k) => ({name: fieldOf(ctx, table.type.row, k, text).name, type: fieldOf(ctx, table.type.row, k, text).type}));
      return {s: "insert_lines_sorted", table, src, keys};
    }
    if (/\b(LINES OF|INITIAL LINE|ASSIGNING)\b/i.test(text)) throw new Unsupported(`INSERT form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const vNode = node.findDirectExpression(Expressions.SimpleSource4) ?? node.findDirectExpression(Expressions.Source);
    // INSERT v INTO TABLE <generic table> (ultra/json, /UI2/CL_JSON): a
    // standard table appends, as INSERT INTO TABLE does to one; any other
    // kind is refused at run time (abap.InsertData)
    if (table.type.k === "data" && table.type.table) return {s: "insert_data", table, value: convert(source(vNode, ctx), {k: "data"})};
    if (table.type.k !== "table") throw new Unsupported("INSERT into a non-table");
    const refMatch = /\bREFERENCE\s+INTO\s+([\w-]+)/i.exec(text);
    const refInto = refMatch ? variable(refMatch[1], ctx) : null;
    if (refMatch && refInto.type.k !== "dref") throw new Unsupported(`INSERT REFERENCE INTO a ${refInto.type.k}`);
    // a unique key: a row with the same key is not inserted (sy-subrc 4)
    const keys = table.type.hashed && !(table.type.hashed.length === 1 && table.type.hashed[0] === "TABLE_LINE") ? table.type.hashed : null;
    if (keys && table.type.row.k !== "struct") throw new Unsupported(`INSERT INTO TABLE with key ${keys.join(",")} on a table not of structures`);
    for (const k of keys ?? []) fieldOf(ctx, table.type.row, k, text);
    uniqueGuard(table.type, "INSERT INTO TABLE");
    // ultra/events: a SORTED table (UNIQUE key only; where a duplicate of a
    // NON-UNIQUE key goes is not measured): the row goes before the first
    // row with a greater key, not at all when one has the same key
    if (table.type.sorted) {
      if (refInto) table.type.stable = true;
      if (!table.type.unique) throw new Unsupported(`INSERT INTO TABLE of a SORTED table with a NON-UNIQUE key`);
      const line = table.type.sorted.length === 1 && table.type.sorted[0] === "TABLE_LINE";
      const sortKeys = line ? [{line: true, type: table.type.row}] : table.type.sorted.map((k) => ({name: fieldOf(ctx, table.type.row, k, text).name, type: fieldOf(ctx, table.type.row, k, text).type}));
      for (const k of sortKeys) if (!["c", "string", "n", "d", "t", "i", "int8"].includes(k.type.k)) throw new Unsupported(`SORTED table keyed on a ${k.type.k}`);
      return {s: "insert_sorted", table, value: convert(source(vNode, ctx, table.type.row), table.type.row), keys: sortKeys, refInto};
    }
    if (refInto) throw new Unsupported(`INSERT REFERENCE INTO a non-sorted table: ${text}`);
    return {s: "insert_table", table, value: convert(source(vNode, ctx, table.type.row), table.type.row), unique: !!table.type.hashed, keys};
  }
  if (isStmt(node, Statements.InsertInternal)) {
    const m = /\bINDEX\b/i.test(text);
    if (!m || /\b(LINES OF|INITIAL LINE|ASSIGNING|REFERENCE)\b/i.test(text)) throw new Unsupported(`INSERT form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table") throw new Unsupported("INSERT into a non-table");
    const srcs = node.findDirectExpressions(Expressions.Source).concat(node.findDirectExpressions(Expressions.SimpleSource4));
    const vNode = node.findDirectExpression(Expressions.SimpleSource4) ?? srcs[0];
    const idxNode = node.findDirectExpressions(Expressions.Source).slice(-1)[0];
    keyGuard(table.type, "INSERT ... INDEX");
    uniqueGuard(table.type, "INSERT ... INDEX");
    refuseSorted(table, "INSERT ... INDEX into");
    return {s: "insert_index", table, value: convert(source(vNode, ctx, table.type.row), table.type.row), index: convert(source(idxNode, ctx, I), I)};
  }
  if (isStmt(node, Statements.Replace)) return replaceStatement(node, ctx, text, byteStatementHelpers);
  if (isStmt(node, Statements.Translate)) {
    const m = /\bTO\s+(UPPER|LOWER)\s+CASE\b/i.exec(text);
    if (m === null) throw new Unsupported(`TRANSLATE form: ${text}`);
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (!charlike(target.type)) throw new Unsupported("TRANSLATE of a non-character field");
    return {s: "translate", target, upper: upper(m[1]) === "UPPER"};
  }
  // WAIT FOR MESSAGING CHANNELS UNTIL c UP TO n SECONDS: deliver AMC
  // messages to this session until c holds (0) or the time is up (8)
  if (isStmt(node, Statements.Wait) && /^WAIT\s+FOR\s+MESSAGING\s+CHANNELS\s+UNTIL\b/i.test(text)) {
    if (/\bPUSH\s+CHANNELS\b|\bASYNCHRONOUS\s+TASKS\b/i.test(text)) throw new Unsupported(`WAIT FOR more than MESSAGING CHANNELS: ${text}`);
    const up = node.findDirectExpression(Expressions.Source);
    if (!up) throw new Unsupported(`WAIT FOR MESSAGING CHANNELS without UP TO: ${text}`);
    return {s: "amc_wait", cond: cond(node.findDirectExpression(Expressions.Cond), ctx), seconds: convert(sourceOperand(up, ctx), {k: "f"})};
  }
  // X0: the DATASET statements, as the transpiler's runtime does them
  // (go/abap/dataset.go, docs/dataset.md): the file system behind the
  // sandbox of OSD_DATASET_READ / OSD_DATASET_WRITE
  if ([Statements.OpenDataset, Statements.CloseDataset, Statements.DeleteDataset, Statements.Transfer,
    Statements.ReadDataset, Statements.GetDataset, Statements.SetDataset].some((k) => isStmt(node, k))) {
    return datasetStatement(node, ctx, text);
  }
  // GET RUN TIME FIELD: monotonic microseconds since the first call (FIX.md).
  if (isStmt(node, Statements.GetRunTime)) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "i") throw new Unsupported(`GET RUN TIME FIELD into a ${target.type.k}`);
    return {s: "get_runtime", target};
  }
  if (isStmt(node, Statements.Convert)) {
    const kids = node.getChildren();
    const inputs = new Map(), outputs = new Map();
    for (let i = 0; i < kids.length; i++) {
      if (!isExpr(kids[i], Expressions.Source) && !isExpr(kids[i], Expressions.Target)) continue;
      const key = upper(kids[i - 1].concatTokens());
      (isExpr(kids[i], Expressions.Source) ? inputs : outputs).set(key, kids[i]);
    }
    if (!inputs.has("ZONE") || /DAYLIGHT|UTCLONG|INVERTED/i.test(text)) throw new Unsupported(`CONVERT form: ${text}`);
    const zone = convert(source(inputs.get("ZONE"), ctx), S);
    if (inputs.has("STAMP")) {
      const stamp = source(inputs.get("STAMP"), ctx);
      if (stamp.type.k !== "p") throw new Unsupported(`CONVERT TIME STAMP of a ${stamp.type.k}`);
      const date = outputs.has("DATE") ? lvalue(outputs.get("DATE"), ctx) : null;
      const time = outputs.has("TIME") ? lvalue(outputs.get("TIME"), ctx) : null;
      if ((!date && !time) || (date && date.type.k !== "d") || (time && time.type.k !== "t")) throw new Unsupported(`CONVERT targets: ${text}`);
      return {s: "native", fn: "abap.ConvertTimestampInto", stmt: true, args: [stamp, zone,
        date ? convert(date, {k: "data"}) : {e: "zero", type: {k: "data"}},
        time ? convert(time, {k: "data"}) : {e: "zero", type: {k: "data"}}].map((value) => ({value}))};
    }
    if (!inputs.has("DATE") || !inputs.has("TIME") || !outputs.has("STAMP")) throw new Unsupported(`CONVERT form: ${text}`);
    const stamp = lvalue(outputs.get("STAMP"), ctx);
    if (stamp.type.k !== "p") throw new Unsupported(`CONVERT INTO TIME STAMP of a ${stamp.type.k}`);
    return {s: "native", fn: "abap.ConvertDateTimeInto", stmt: true, args: [
      convert(source(inputs.get("DATE"), ctx), S), convert(source(inputs.get("TIME"), ctx), S), zone,
      convert(stamp, {k: "data"})].map((value) => ({value}))};
  }
  // ultra/events: GET TIME STAMP FIELD ts into a TIMESTAMP p(8,0) or a
  // TIMESTAMPL p(11,7): UTC, as sy-datum and sy-uzeit are here
  if (isStmt(node, Statements.GetTime)) {
    if (!/^GET\s+TIME\s+STAMP\s+FIELD\s+\S+\s*\.?$/i.test(text)) throw new Unsupported(`GET TIME form: ${text}`);
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "p" || !((target.type.len === 8 && (target.type.dec ?? 0) === 0) || (target.type.len === 11 && target.type.dec === 7))) throw new Unsupported(`GET TIME STAMP into a ${target.type.k}(${target.type.len},${target.type.dec ?? 0})`);
    return {s: "get_timestamp", target, dec: target.type.dec ?? 0};
  }
  // class events (ultra/events): SET HANDLER and RAISE EVENT, see setHandler
  if (isStmt(node, Statements.SetHandler)) return setHandler(node, ctx, text);
  if (isStmt(node, Statements.RaiseEvent)) return raiseEvent(node, ctx, text);
  // RAISE EXCEPTION TYPE cls [EXPORTING ...] / RAISE EXCEPTION obj
  if (isStmt(node, Statements.Raise) && /^RAISE\s+(EXCEPTION|RESUMABLE|SHORTDUMP)\b/i.test(text)) return raiseException(node, ctx, text);
  if (isStmt(node, Statements.Message)) {
    const raising = node.findDirectExpression(Expressions.ExceptionName);
    const msg = node.findDirectExpression(Expressions.MessageSource);
    if (!raising || !msg || /DISPLAY LIKE|INTO/i.test(text)) throw new Unsupported(`MESSAGE form: ${text}`);
    let id, ty, no;
    const short = msg.findDirectExpression(Expressions.MessageTypeAndNumber);
    if (short) {
      const m = /^([a-z])(\d{3})$/i.exec(short.concatTokens());
      const cls = msg.findDirectExpression(Expressions.MessageClass);
      if (!m || !cls) throw new Unsupported(`MESSAGE without explicit class: ${text}`);
      id = {e: "str", value: upper(cls.concatTokens()), type: S};
      ty = {e: "str", value: upper(m[1]), type: S};
      no = {e: "str", value: m[2], type: S};
    } else {
      const kids = msg.getChildren();
      const read = (key) => {
        const i = kids.findIndex((k) => isTok(k, key));
        if (i < 0) throw new Unsupported(`MESSAGE missing ${key}`);
        return source(kids[i + 1], ctx);
      };
      id = convert(read("ID"), S);
      ty = convert(read("TYPE"), S);
      no = convert(read("NUMBER"), {k: "n", len: 3});
    }
    const values = node.findDirectExpressions(Expressions.MessageSourceSource).map((x) => convert(source(x, ctx), C(50)));
    if (values.length > 4) throw new Unsupported(`MESSAGE WITH more than four values: ${text}`);
    const name = {e: "str", value: upper(raising.concatTokens()), type: S};
    const method = {e: "str", value: ctx.method, type: S};
    return {s: "native", fn: "abap.MessageRaise", stmt: true, args: [id, ty, no, name, method, ...values].map((value) => ({value}))};
  }
  // RAISE name: a classic exception, for the caller's EXCEPTIONS list
  if (isStmt(node, Statements.Raise) && !/^RAISE\s+(EXCEPTION|RESUMABLE)\b/i.test(text)) {
    const n = node.findDirectExpression(Expressions.ExceptionName);
    if (!n) throw new Unsupported(`RAISE form: ${text}`);
    return {s: "raise_classic", name: upper(n.concatTokens()), method: ctx.method};
  }
  // CALL METHOD (class)=>m EXPORTING ...: a static method by class name,
  // through the program's registry of static methods
  if (isStmt(node, Statements.Call) && node.findDirectExpression(Expressions.MethodSource)?.findDirectExpression(Expressions.Dynamic)) {
    return dynamicStaticCall(node, ctx, {Expressions, isTok, isExpr, sourceOperand, source, convert, S, Unsupported});
  }
  if (isStmt(node, Statements.CallFunction)) return callFunction(node, ctx, text);
  if (isStmt(node, Statements.Call)) {
    const chain = node.findDirectExpression(Expressions.MethodCallChain) ?? callMethodChain(node);
    if (chain === undefined) throw new Unsupported(`CALL form: ${text}`);
    return {s: "call", call: call(chain, ctx, true)};
  }
  if (isStmt(node, Statements.Exit)) return {s: "exit"};
  if (isStmt(node, Statements.Continue)) return {s: "continue"};
  if (isStmt(node, Statements.Return)) return {s: "return"};
  if (isStmt(node, Statements.Check)) {
    const condition = node.findDirectExpression(Expressions.Cond);
    if (!condition) throw new Unsupported(`CHECK form: ${text}`);
    return {s: "check", cond: cond(condition, ctx)};
  }
  // FIELD-SYMBOLS: declared from the scope like DATA
  if (isStmt(node, Statements.FieldSymbol)) return undefined;
  if (isStmt(node, Statements.ModifyInternal)) {
    // MODIFY itab INDEX n FROM wa, and the same written MODIFY itab FROM wa
    // INDEX n (the order of the two additions is free; open-abap-gui's
    // CL_GUI_CONTROL writes the second): each Source is the one after its word
    const indexFirst = /^MODIFY\s+\S+\s+INDEX\s+.+\s+FROM\s+/i.test(text);
    if (!(indexFirst || /^MODIFY\s+\S+\s+FROM\s+.+\s+INDEX\s+/i.test(text)) || /\b(TRANSPORTING|USING\s+KEY|ASSIGNING|REFERENCE\s+INTO)\b/i.test(text)) throw new Unsupported(`MODIFY form: ${text}`);
    const table = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (table.type.k !== "table") throw new Unsupported("MODIFY of a non-table");
    const kids = node.getChildren();
    const after = (kw) => { const at = kids.findIndex((c) => isTok(c, kw)); return at < 0 || !isExpr(kids[at + 1], Expressions.Source) ? undefined : kids[at + 1]; };
    const idx = after("INDEX");
    const val = after("FROM");
    if (!idx || !val || node.findDirectExpressions(Expressions.Source).length !== 2) throw new Unsupported(`MODIFY form: ${text}`);
    refuseSorted(table, "MODIFY ... INDEX of");
    return {s: "modify_index", table, index: convert(source(idx, ctx, I), I), value: convert(source(val, ctx, table.type.row), table.type.row)};
  }
  if (isStmt(node, Statements.Split)) return splitStatement(node, ctx, text);
  if (isStmt(node, Statements.MoveCorresponding)) return moveCorresponding(node, ctx, text);
  if (isStmt(node, Statements.Find)) {
    // FIND [FIRST OCCURRENCE OF] [REGEX] p IN s [IGNORING CASE] [SUBMATCHES a b ...]
    // [MATCH OFFSET o] [MATCH LENGTH l]; measured on A4H: POSIX leftmost-
    // longest, offsets in characters, a failed FIND leaves every target alone,
    // a submatch target without a group (or of a group that did not take
    // part) becomes initial.
    // ultra/sadl (A4H 2026-09-24, ZCL_GOGEN_T_FINDSEC): IN SECTION [OFFSET o]
    // [LENGTH l] OF s for a substring in a string (MATCH OFFSET counts from
    // the start of s, not of the section), and IN TABLE itab of strings
    // [MATCH LINE n] (row by row, the first row with a match). REGEX IN
    // SECTION stays refused: what ^ and $ see there is not measured.
    const kids = node.getChildren();
    const words = kids.map((k) => (k instanceof Nodes.TokenNode ? upper(k.concatTokens()) : ""));
    // ultra/events: FIND ALL OCCURRENCES OF [REGEX] p IN s [IGNORING CASE]
    // MATCH COUNT n and nothing else (A4H ZCL_GOGEN_T_WGUI1): matches do not
    // overlap, n is 0 and sy-subrc 4 when there is none; REGEX may be a
    // CL_ABAP_REGEX object (open-abap-core's: its PATTERN and MV_IGNORE_CASE)
    const tw = words.filter((w) => w !== "" && w !== ".").join(" ");
    const matches = (...parts) => parts.reduce((forms, part) => forms.flatMap((form) =>
      (Array.isArray(part) ? part : [part]).map((p) => [form, p].filter(Boolean).join(" "))), [""]).includes(tw);
    const hasKeywords = (...seq) => words.some((_, i) => seq.every((w, j) => words[i + j] === w));
    if (matches("FIND ALL OCCURRENCES OF IN", ["", "IGNORING CASE"], "MATCH COUNT") && node.findDirectExpressions(Expressions.Source).length === 2) {
      const [pat, subj] = node.findDirectExpressions(Expressions.Source);
      const kind = upper(node.findDirectExpression(Expressions.FindType)?.concatTokens() ?? "");
      if (kind && kind !== "REGEX" && kind !== "PCRE") throw new Unsupported(`FIND ${kind}`);
      const regex = kind !== "";
      const pcre = kind === "PCRE";
      let pattern = source(pat, ctx);
      let icase = {e: "flag", value: hasKeywords("IGNORING", "CASE"), type: {k: "bool"}};
      if (!pcre && regex && pattern.type.k === "ref" && pattern.type.name === "CL_ABAP_REGEX" && ctx.program.wanted.has("CL_ABAP_REGEX") && !icase.value) {
        const base = pattern;
        pattern = {e: "refattr", base, name: "PATTERN", type: S};
        icase = {e: "refattr", base, name: "MV_IGNORE_CASE", type: C(1)};
      } else if (!charlike(pattern.type)) throw new Unsupported(`FIND ALL OCCURRENCES OF a ${pattern.type.k}`);
      else pattern = convert(pattern, S);
      const count = lvalue(node.findDirectExpression(Expressions.Target), ctx);
      if (count.type.k !== "i") throw new Unsupported(`MATCH COUNT into a ${count.type.k}`);
      return {s: "find_all", regex, pcre, pattern, icase, subject: convert(source(subj, ctx), S), count};
    }
    // parity-wave2: FIND [FIRST OCCURRENCE OF | ALL OCCURRENCES OF]
    // [REGEX | PCRE] p IN s [IGNORING CASE] RESULTS r, r a match_result or a
    // match_result_tab (open-abap-core's CL_ABAP_MATCHER, CL_IXML). A4H
    // 2026-09-25 (ZCL_GOGEN_T_FINDRES, _FINDPCRE): see abap.FindResults
    if (matches("FIND", ["", "FIRST OCCURRENCE OF", "ALL OCCURRENCES OF"], "IN", ["", "IGNORING CASE", "RESPECTING CASE"], "RESULTS")
      && node.findDirectExpressions(Expressions.Source).length === 2) return findResults(node, ctx, text, tw);
    const byteFind = lowerByteFind(node, ctx, text, kids, words, tw, byteStatementHelpers);
    if (byteFind) return byteFind;
    if (words.includes("ALL") || words.includes("RESULTS") || words.includes("RESPECTING") || hasKeywords("MATCH", "COUNT") || hasKeywords("IN", "BYTE", "MODE")) throw new Unsupported(`FIND form: ${text}`);
    const ft = node.findDirectExpression(Expressions.FindType);
    const kind = ft ? upper(ft.concatTokens()) : "";
    if (kind && kind !== "REGEX" && kind !== "PCRE") throw new Unsupported(`FIND ${kind}`);
    const inTable = words.some((w, i) => w === "IN" && words[i + 1] === "TABLE");
    const section = words.includes("SECTION");
    if (section && (kind !== "" || inTable)) throw new Unsupported(`FIND form: ${text}`);
    // the Sources in order: pattern, [section offset], [section length], subject
    const srcs = [];
    let smode = "pat";
    for (let i = 0; i < kids.length; i += 1) {
      const w = words[i];
      if (w === "SECTION") { smode = "sec"; continue; }
      if (smode === "sec" && w === "OFFSET") { smode = "secoff"; continue; }
      if (smode !== "pat" && smode !== "subj" && w === "LENGTH") { smode = "seclen"; continue; }
      if (smode !== "pat" && w === "OF") { smode = "subj"; continue; }
      if (isExpr(kids[i], Expressions.Source)) srcs.push({mode: smode === "pat" && srcs.length > 0 ? "subj" : smode, node: kids[i]});
    }
    const pat = srcs.find((x) => x.mode === "pat")?.node;
    const subj = srcs.find((x) => x.mode === "subj")?.node;
    if (!pat || !subj) throw new Unsupported(`FIND operands: ${text}`);
    const patX = source(pat, ctx);
    if (!charlike(patX.type)) throw new Unsupported(`FIND of a ${patX.type.k}`);
    const out = {s: "find", regex: kind !== "", pcre: kind === "PCRE", pattern: convert(patX, S),
      icase: hasKeywords("IGNORING", "CASE"), subs: [], off: null, len: null};
    if (inTable) {
      const tb = source(subj, ctx);
      if (tb.type.k !== "table" || tb.type.row.k !== "string") throw new Unsupported(`FIND IN TABLE of a ${tb.type.k === "table" ? `table of ${tb.type.row.k}` : tb.type.k}`);
      out.table = tb;
    } else if (section) {
      const sx = source(subj, ctx);
      if (sx.type.k !== "string") throw new Unsupported(`FIND IN SECTION of a ${sx.type.k}`);
      out.subject = sx;
      const so = srcs.find((x) => x.mode === "secoff")?.node;
      const sl = srcs.find((x) => x.mode === "seclen")?.node;
      out.secOff = so ? convert(source(so, ctx, I), I) : null;
      out.secLen = sl ? convert(source(sl, ctx, I), I) : null;
    } else out.subject = convert(source(subj, ctx), S);
    let mode = null;
    for (let i = 0; i < kids.length; i += 1) {
      const w = words[i];
      if (w === "SUBMATCHES") { mode = "sub"; continue; }
      if (w === "MATCH" && words[i + 1] === "OFFSET") { mode = "off"; i += 1; continue; }
      if (w === "MATCH" && words[i + 1] === "LENGTH") { mode = "len"; i += 1; continue; }
      if (w === "MATCH" && words[i + 1] === "LINE") { mode = "line"; i += 1; continue; }
      if (w) { mode = null; continue; }
      if (!isExpr(kids[i], Expressions.Target) || mode === null) continue;
      const t = lvalue(kids[i], ctx);
      if (mode === "sub") {
        if (!charlike(t.type)) throw new Unsupported(`SUBMATCHES into a ${t.type.k}`);
        out.subs.push({target: t, value: convert({e: "temp", name: `fsub[${out.subs.length}]`, type: S}, t.type)});
      } else {
        if (t.type.k !== "i") throw new Unsupported(`MATCH ${mode.toUpperCase()} into a ${t.type.k}`);
        if (mode === "line" && !inTable) throw new Unsupported(`MATCH LINE without IN TABLE: ${text}`);
        out[mode] = t;
      }
    }
    return out;
  }
  if (isStmt(node, Statements.Clear)) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    // CLEAR of generic data clears the slot it is bound to
    if (target.type.k === "data") {
      if (/\bWITH\b/i.test(text)) throw new Unsupported(`CLEAR form: ${text}`);
      return {s: "clear_data", target};
    }
    return {s: "clear", target};
  }
  // FREE is CLEAR that also gives the memory back, which a GC does anyway
  if (isStmt(node, Statements.Refresh)) return {s: "seq", body: node.findDirectExpressions(Expressions.Target).map((t) => lvalue(t, ctx)).map((target) => ({s: target.type.k === "data" ? "clear_data" : "clear", target}))};
  if (isStmt(node, Statements.Free)) return {s: "seq", body: node.findDirectExpressions(Expressions.Target).map((t) => lvalue(t, ctx)).map((target) => ({s: target.type.k === "data" ? "clear_data" : "clear", target}))};
  // WRITE goes to a list; in an APC or HTTP handler nobody ever displays it
  // WRITE is a no-op here, except the transpiler runtime's host code: open-abap-core
  // writes its kernel parts in JS as WRITE '@KERNEL ...', and skipping one would
  // run the ABAP around it on values nobody set
  if (isStmt(node, Statements.Write)) {
    // a kernel line the host implements (KERNEL)
    const k = kernelOf(node, ctx);
    if (k?.fn !== undefined) return {s: "native", fn: k.fn, args: nativeArgs(k.args, ctx), stmt: true};
    if (k?.bound !== undefined && ctx.kernelLoop?.binds.includes(k.bound)) return {s: "nop"};
    // a line whose work the host does elsewhere (a JavaScript declaration the
    // host function of a later line does not need)
    if (k?.nop === true) return {s: "nop"};
    if (/'@KERNEL/i.test(node.concatTokens())) throw new Unsupported(`@KERNEL: host code of the transpiler runtime`);
    return {s: "nop"};
  }
  if (isStmt(node, Statements.GenerateSubroutine)) return generateSubroutine(node, ctx);
  throw new Unsupported(`statement ${node.get().constructor.name}: ${text}`);
}

/* GENERATE SUBROUTINE POOL: there is no compiler at run time, so the
 * statement is refused the way a system reports a pool it could not
 * generate, without an exception: sy-subrc 8 (documented as "other
 * generation error"; 4 is a syntax error in the pool, measured on A4H),
 * NAME initial, MESSAGE set to a fixed text, LINE 0, WORD initial. The
 * other additions (MESSAGE-ID, INCLUDE, OFFSET, SHORTDUMP-ID) are left
 * alone. The same refusal as the transpiler's JS runtime. */
const GENERATE_REFUSED = "GENERATE SUBROUTINE POOL is not supported";
// what the emitters spell as a place (emit-go.mjs place()), constants and sy excluded
const PLACES = new Set(["var", "attr", "static", "field", "dref_field", "fs", "refattr", "row", "row_key"]);
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt} */ function generateSubroutine(node, ctx) {
  const kids = node.getChildren();
  /** @param {string} kw @returns {import("./frontend-types.ts").SyntaxNode | undefined} */ const after = (kw) => {
    const i = kids.findIndex((k, j) => isTok(k, kw) && kids[j + 1] instanceof Nodes.ExpressionNode);
    return i < 0 ? undefined : kids[i + 1];
  };
  /** @type {import("./frontend-types.ts").FrontendStmt[]} */ const body = [];
  const name = after("NAME");
  if (name !== undefined) {
    // NAME is a Source in abaplint's grammar and a field the kernel writes:
    // read through the ordinary operand machinery, kept only when it is a place
    const target = source(name, ctx);
    if (!PLACES.has(target.e)) throw new Unsupported(`GENERATE SUBROUTINE POOL NAME ${name.concatTokens()}: not a writable field`);
    body.push({s: target.type.k === "data" ? "clear_data" : "clear", target});
  }
  const message = after("MESSAGE");
  if (message !== undefined) {
    const target = lvalue(message, ctx);
    body.push({s: "assign", target, value: convert({e: "str", value: GENERATE_REFUSED, type: S}, target.type)});
  }
  const line = after("LINE");
  if (line !== undefined) {
    const target = lvalue(line, ctx);
    body.push({s: "assign", target, value: convert({e: "int", value: 0, type: I}, target.type)});
  }
  const word = after("WORD");
  if (word !== undefined) {
    const target = lvalue(word, ctx);
    body.push({s: target.type.k === "data" ? "clear_data" : "clear", target});
  }
  body.push({s: "assign", target: {e: "sy", field: "Subrc", type: I}, value: {e: "int", value: 8, type: I}});
  return {s: "seq", body};
}

/* ------------------------------------------------------------ strings (A4H) */

// A c operand keeps its trailing blanks where ABAP keeps them: the
// separator of SPLIT (measured, 'a ' splits `a b` into '' and 'b'). A c
// value is stored without them, so its declared length pads it back.
/** @param {import("./frontend-types.ts").ValueExpr} x @returns {import("./frontend-types.ts").ValueExpr} */ function padded(x) {
  const v = convert(x, S);
  return x.type.k === "c" ? {e: "padc", x: v, n: x.type.len, type: S} : v;
}

/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function splitStatement(node, ctx, text) {
  // measured on A4H: an empty string gives no rows, and one empty last
  // piece after a trailing separator is dropped (a| -> [a], a|| -> [a,'']);
  // an empty separator does not split; a c separator keeps its blanks
  if (/\bIN\s+BYTE\s+MODE\b/i.test(text)) throw new Unsupported(`SPLIT form: ${text}`);
  const [strNode, sepNode] = node.findDirectExpressions(Expressions.Source);
  const str = source(strNode, ctx);
  if (!charlike(str.type)) throw new Unsupported(`SPLIT of a ${str.type.k}`);
  const sepX = source(sepNode, ctx);
  if (!charlike(sepX.type)) throw new Unsupported(`SPLIT AT a ${sepX.type.k}`);
  const x = convert(str, S);
  const sep = padded(sepX);
  const targets = node.findDirectExpressions(Expressions.Target);
  if (/\bINTO\s+TABLE\b/i.test(text)) {
    const table = lvalue(targets[0], ctx);
    if (table.type.k !== "table" || table.type.row.k !== "string") throw new Unsupported("SPLIT into a table not of strings");
    refuseSorted(table, "SPLIT INTO TABLE");
    return {s: "split", table, x, sep};
  }
  // INTO t1 t2 ...: measured, the last target takes the rest (a,b,c,d into
  // two is a / b,c,d), missing pieces clear their targets, a piece longer
  // than its c field is cut and sy-subrc is 4
  const places = targets.map((t) => lvalue(t, ctx));
  for (const t of places) if (t.type.k !== "string" && t.type.k !== "c") throw new Unsupported(`SPLIT INTO a ${t.type.k}`);
  return {s: "split_into", x, sep, lens: places.map((t) => (t.type.k === "c" ? t.type.len : -1)),
    targets: places.map((t, i) => ({target: t, value: convert({e: "temp", name: `spl[${i}]`, type: S}, t.type)}))};
}

// MOVE-CORRESPONDING a TO b between structures: every component of b whose
// name a has too gets a's value by the conversion rules, the others are
// left alone, sy-subrc too (measured on A4H). A component that is itself a
// structure or a table on either side is not flat and is refused.
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function moveCorresponding(node, ctx, text) {
  if (/\b(EXPANDING|KEEPING)\b/i.test(text)) throw new Unsupported(`MOVE-CORRESPONDING form: ${text}`);
  const from = source(node.findDirectExpression(Expressions.Source), ctx);
  const tNode = node.findDirectExpression(Expressions.SimpleTarget) ?? node.findDirectExpression(Expressions.Target);
  const to = lvalue(tNode, ctx);
  if ((from.type.k === "data" || to.type.k === "data") && ["data", "struct"].includes(from.type.k) && ["data", "struct"].includes(to.type.k)) {
    // generic on one side or both: component by component at run time,
    // through bindings to the two structures
    return {s: "move_corr_data", from: convert(from, {k: "data"}), to: convert(to, {k: "data"})};
  }
  if (from.type.k !== "struct" || to.type.k !== "struct") throw new Unsupported(`MOVE-CORRESPONDING from a ${from.type.k} to a ${to.type.k}`);
  // each component names source and target again, so both must be places
  // that cost nothing and do nothing when named twice: a variable, an
  // attribute, a field symbol or a component of one (a table expression, a
  // dereference or a call would run once per component where ABAP runs it once)
  const plain = (x) => ["var", "attr", "static", "fs"].includes(x.e) || (x.e === "field" && plain(x.base));
  if (!plain(from) || !plain(to)) throw new Unsupported(`MOVE-CORRESPONDING of something other than a variable or its component: ${text}`);
  const src = structOf(ctx, from.type);
  const dst = structOf(ctx, to.type);
  if (!src || !dst) throw new Unsupported(`MOVE-CORRESPONDING: a structure not in the program`);
  const body = [];
  for (const f of dst.fields) {
    const g = src.fields.find((x) => x.name === f.name);
    if (!g) continue;
    if (["struct", "table"].includes(f.type.k) || ["struct", "table"].includes(g.type.k)) throw new Unsupported(`MOVE-CORRESPONDING with a deep component ${f.name}`);
    body.push({s: "assign", target: {e: "field", base: to, name: f.name, type: f.type}, value: convert({e: "field", base: from, name: g.name, type: g.type}, f.type)});
  }
  return {s: "seq", body};
}

// the built-in string functions: repeat( ) replace( ) condense( )
// shift_left( ) shift_right( ) to_mixed( ), measured on A4H 2026-09-23. A c
// argument loses its trailing blanks (replace( ) with sub = ' ' raises for
// an empty sub), which is how a c value is stored here already.
const STRING_FNS = {
  REPEAT: ["VAL", "OCC"], REPLACE: ["VAL", "SUB", "REGEX", "WITH", "OCC"], CONDENSE: ["VAL", "DEL", "FROM", "TO"],
  SHIFT_LEFT: ["VAL", "PLACES", "CIRCULAR", "SUB"], SHIFT_RIGHT: ["VAL", "PLACES", "CIRCULAR", "SUB"], TO_MIXED: ["VAL", "SEP", "CASE", "MIN"],
  // ultra/events: substring_before / _after( val sub ), abapGit's parse_fields
  SUBSTRING_BEFORE: ["VAL", "SUB"], SUBSTRING_AFTER: ["VAL", "SUB"],
};
/** @param {string} name @param {import("@abaplint/core").Nodes.ExpressionNode | undefined} direct @param {import("@abaplint/core").Nodes.ExpressionNode | undefined} named @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").ValueExpr} */ function stringFn(name, direct, named, ctx, text) {
  const ps = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
  const given = new Map(ps.map((p) => [upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source)]));
  if (direct) given.set("VAL", direct);
  for (const k of given.keys()) if (!STRING_FNS[name].includes(k)) throw new Unsupported(`${name.toLowerCase()}( ) with ${k.toLowerCase()}: ${text}`);
  if (!given.has("VAL")) throw new Unsupported(`${name.toLowerCase()}( ) without val: ${text}`);
  const chars = (k) => {
    const x = source(given.get(k), ctx);
    if (!charlike(x.type)) throw new Unsupported(`${name.toLowerCase()}( ) ${k.toLowerCase()} of a ${x.type.k}`);
    return convert(x, S);
  };
  const int = (k) => convert(source(given.get(k), ctx, I), I);
  const val = chars("VAL");
  // the text before / after the first occurrence of sub, empty when there is
  // none (A4H ZCL_GOGEN_T_WGUI2)
  if (name === "SUBSTRING_BEFORE" || name === "SUBSTRING_AFTER") {
    if (!given.has("SUB")) throw new Unsupported(`${name.toLowerCase()}( ) without sub: ${text}`);
    return {e: "str_fn", fn: name === "SUBSTRING_BEFORE" ? "SubstringBefore" : "SubstringAfter", args: [val, chars("SUB")], type: S};
  }
  if (name === "REPEAT") {
    if (!given.has("OCC")) throw new Unsupported(`repeat( ) without occ: ${text}`);
    return {e: "str_fn", fn: "Repeat", args: [val, int("OCC")], type: S};
  }
  if (name === "REPLACE") {
    if (given.has("SUB") === given.has("REGEX") || !given.has("WITH")) throw new Unsupported(`replace( ) form: ${text}`);
    const regex = given.has("REGEX");
    return {e: "str_fn", fn: "ReplaceFn", args: [val, chars(regex ? "REGEX" : "SUB"), chars("WITH"), {e: "flag", value: regex},
      given.has("OCC") ? int("OCC") : {e: "int", value: 1, type: I}], type: S};
  }
  if (name === "CONDENSE") {
    // a c del / from / to loses its trailing blanks (A4H 2026-09-23, probe
    // ZCL_GOGEN_T_STRCR: del = space, del = ' ', del = a c(1) field holding
    // a blank and from = space all strip or match nothing; to = space
    // replaces a run with nothing), which is how a c value is stored here
    const set = (k) => (given.has(k) ? chars(k) : {e: "str", value: " ", type: S});
    return {e: "str_fn", fn: "CondenseFn", args: [val, set("DEL"), set("FROM"), set("TO")], type: S};
  }
  if (name === "SHIFT_LEFT" || name === "SHIFT_RIGHT") {
    const kinds = ["PLACES", "CIRCULAR", "SUB"].filter((k) => given.has(k));
    if (kinds.length > 1) throw new Unsupported(`${name.toLowerCase()}( ) form: ${text}`);
    const kind = kinds[0] ?? "";
    return {e: "str_fn", fn: "ShiftFn", args: [val, {e: "flag", value: name === "SHIFT_LEFT"}, {e: "str", value: kind.toLowerCase(), type: S},
      kind === "PLACES" || kind === "CIRCULAR" ? int(kind) : {e: "int", value: 0, type: I}, kind === "SUB" ? chars("SUB") : {e: "str", value: "", type: S}], type: S};
  }
  // TO_MIXED
  return {e: "str_fn", fn: "ToMixed", args: [val, given.has("SEP") ? chars("SEP") : {e: "str", value: "_", type: S}, {e: "flag", value: given.has("CASE")},
    given.has("CASE") ? chars("CASE") : {e: "str", value: "", type: S}, given.has("MIN") ? int("MIN") : {e: "int", value: 1, type: I}], type: S};
}

/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @param {string} tw @param {boolean} [bytes] @param {import("@abaplint/core").Nodes.ExpressionNode | null} [resultNode] @returns {Extract<import("./frontend-types.ts").FrontendStmt, {s: "find_results"}>} */ function findResults(node, ctx, text, tw, bytes = false, resultNode = null) {
  return lowerFindResults(node, ctx, text, tw, bytes, resultNode, {Expressions, upper, source, charlike, Unsupported, lvalue, fieldOf, convert, XS, S});
}

/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt} */ function initialValue(node, ctx) {
  const name = upper(node.findFirstExpression(Expressions.DefinitionName).concatTokens());
  const type = ctx.locals.get(name);
  if (type === undefined) throw new Unsupported(`${name}: a VALUE for something that is not a local`);
  const val = node.findFirstExpression(Expressions.Value);
  const src = val?.getChildren().find((c) => !isTok(c));
  if (src === undefined) throw new Unsupported(`VALUE of ${name}`);
  /** @type {import("./frontend-types.ts").ValueExpr} */ let v;
  if (isExpr(src, Expressions.Constant)) v = sourceOperand(src, ctx);
  else if (upper(src.concatTokens()) === "ABAP_TRUE") v = {e: "chars", value: "X", type: C(1)};
  else if (upper(src.concatTokens()) === "ABAP_FALSE") v = {e: "chars", value: "", type: C(1)};
  else if (isExpr(src, Expressions.SimpleFieldChain) && src.getChildren().length === 1) v = variable(upper(src.concatTokens()), ctx);
  else if (isExpr(src, Expressions.SimpleFieldChain) || isExpr(src, Expressions.FieldChain)) v = fieldChain(src, ctx);
  else throw new Unsupported(`VALUE ${src.concatTokens()} of ${name}`);
  if (type.k === "struct" || type.k === "table") throw new Unsupported(`VALUE for a ${type.k}`);
  // ultra/events: VALUE 'C2A0' of an x or xstring is its bytes, as a class
  // constant's is (ZCL_ABAPGIT_GUI_EVENT's class constructor); only hex digits
  if ((type.k === "xstring" || type.k === "x") && v.e === "chars" && /^([0-9A-F]{2})*$/i.test(v.value)) {
    return {s: "assign", target: {e: "var", name, type}, value: {e: "xbytes", value: v.value, type}};
  }
  return {s: "assign", target: {e: "var", name, type}, value: convert(v, type)};
}

/* ------------------------------------------------------------ names, lvalues */

/**
 * Where an ABAP name lives: a local, a parameter (EXPORTING and CHANGING are
 * pointers in Go), an attribute of the instance, a static attribute or a
 * constant. The IR says which; the backend spells it.
 */
/**
 * ultra/itab (critic fix): a field symbol whose row a DELETE itab (the
 * current row) removed is not used again, since what it then points to was
 * not measured. Textual order over-approximates control flow on purpose:
 * inside a later LOOP ... ASSIGNING of the same name it is fresh again, and
 * everywhere else after the DELETE (the rest of that body, after the loop)
 * it is refused.
 */
/** @param {string} n @param {import("./frontend-types.ts").VariableContext} ctx @returns {void} */ function fsCheck(n, ctx) {
  if (!ctx.fsGone?.has(n)) return;
  const fresh = ctx.fsFresh?.findLast((f) => f.name === n);
  if (!fresh || fresh.stale) throw new Unsupported(`${n} used after DELETE of its row inside the LOOP: not measured`);
}

/** @param {string} name @param {import("./frontend-types.ts").VariableContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function variable(name, ctx) {
  const n = upper(name);
  // me as a value: the object itself (in Go its most-derived self)
  if (n === "ME") return {e: "me", type: {k: "ref", name: ctx.className}};
  if (ctx.fieldSymbols?.has(n)) { fsCheck(n, ctx); return {e: "fs", name: n, type: ctx.fieldSymbols.get(n)}; }
  const p = ctx.sig.params.find((x) => x.name === n);
  // ref: a pointer in Go; box: an EXPORTING / CHANGING box in JS (an
  // IMPORTING table or structure is a pointer in Go and the object itself in JS)
  if (p) return {e: "var", name: n, type: p.type, ref: p.dir !== "importing" || byRef(p), box: p.dir !== "importing"};
  if (ctx.sig.returning?.name === n) return {e: "var", name: n, type: ctx.sig.returning.type};
  if (ctx.localConstants?.has(n)) return ctx.localConstants.get(n);
  if (ctx.locals.has(n)) return {e: "var", name: n, type: ctx.locals.get(n)};
  const attr = findAttribute(ctx, n);
  if (attr) return attr;
  throw new Unsupported(`${ctx.method}: ${name} is not a local, parameter or attribute of the subset`);
}

/** whether a name resolves as a variable the way variable() resolves it
 * (field symbol, parameter, returning, local, attribute), without its side
 * effects */
/** @param {string} name @param {import("./frontend-types.ts").MethodContext} ctx @returns {boolean} */ function isVariableName(name, ctx) {
  const n = upper(name);
  if (n === "ME" || ctx.fieldSymbols?.has(n)) return true;
  if (ctx.sig.params.some((x) => x.name === n) || ctx.sig.returning?.name === n || ctx.locals.has(n) || ctx.localConstants?.has(n)) return true;
  const impl = findScope(ctx.spaghetti.getTop(), "class_implementation", ctx.scopeName ?? ctx.className);
  const defs = findScope(ctx.spaghetti.getTop(), "class_definition", ctx.scopeName ?? ctx.className);
  return (impl?.getData().vars[n] ?? defs?.getData().vars[n]) !== undefined;
}

/** @param {import("./frontend-types.ts").VariableContext} ctx @param {string} n @returns {import("./frontend-types.ts").ValueExpr | undefined} */ function findAttribute(ctx, n) {
  if (n === "ME" || n === "SUPER") return undefined;
  const alias = aliasTarget(ctx.reg, ctx.className, n);
  if (alias?.includes("~") && ownInterfaceAttributes(ctx.program, alias.split("~")[0]).some((a) => a.name === alias)) {
    return ownIntfAttribute(ctx, alias);
  }
  // instance and static attributes are declared in the class definition's
  // scope, constants and interface constants show in the implementation's
  const impl = findScope(ctx.spaghetti.getTop(), "class_implementation", ctx.scopeName ?? ctx.className);
  const defs = findScope(ctx.spaghetti.getTop(), "class_definition", ctx.scopeName ?? ctx.className);
  const id = impl?.getData().vars[n] ?? defs?.getData().vars[n];
  if (id === undefined) return undefined;
  if (n.includes("~") && !(id instanceof abaplint.Types.ClassConstant) && !id.getMeta().includes("static")) return ownIntfAttribute(ctx, n);
  if (id instanceof abaplint.Types.ClassConstant || n.includes("~")) {
    const go = registerConst(ctx.program, n, id, ctx.className);
    if (go === undefined) throw new Unsupported(`constant ${n} is outside the subset`);
    return {e: "const", go, type: ctx.program.consts.get(go).type};
  }
  const type = ctx.program.excAttrs?.has(`${ctx.className}|${n}`) ? EXC : typeOf(id.getType(), `${ctx.className} ${n}`, ctx.program);
  if (id.getMeta().includes("static")) return staticSlot(declaringClass(ctx.reg, ctx.className, n, "attr") ?? ctx.className, n, type, goName);
  return {e: "attr", name: n, type};
}

/** a Target (or InlineData) as an assignable place */
/** @param {import("./frontend-types.ts").SyntaxNode} target @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function lvalue(target, ctx) {
  const kids = target.getChildren();
  let place;
  let i = 0;
  const first = kids[0];
  if (isExpr(first, Expressions.ClassName) && isTok(kids[1], "=>")) {
    place = resolveStatic(upper(first.concatTokens()), upper(kids[2].concatTokens()), ctx, true);
    i = 3;
  } else if (isExpr(first, Expressions.InlineData)) {
    place = variable(first.findFirstExpression(Expressions.TargetField).concatTokens(), ctx);
    i = 1;
  } else if (upper(first.concatTokens()) === "ME" && isTok(kids[1], "->")) {
    const a = findAttribute(ctx, upper(kids[2].concatTokens()));
    if (a === undefined) throw new Unsupported(`me->${kids[2].concatTokens()}: not an attribute`);
    place = a;
    i = 3;
  } else if (upper(first.concatTokens()) === "SY" && isExpr(first, Expressions.TargetField) && kids.length === 3 && isTok(kids[1], "-") && !isVariableName("SY", ctx)) {
    const key = `SY-${upper(kids[2].concatTokens())}`;
    if (SY_MESSAGES[key]) return {e: "sy", ...SY_MESSAGES[key]};
    if (SY[key]) return {e: "sy", field: SY[key], type: I};
    throw new Unsupported(`write to ${key}: system field outside the subset`);
  } else if (isExpr(first, Expressions.TargetField) || isExpr(first, Expressions.TargetFieldSymbol)) {
    place = variable(first.concatTokens(), ctx);
    if (place.e === "const" || ctx.localConstantNames?.has(upper(first.concatTokens()))) throw new Unsupported(`a write to constant ${first.concatTokens()}`);
    i = 1;
  } else if (isTok(first, "ME")) {
    if (!isTok(kids[1], "->")) throw new Unsupported(`target ${target.concatTokens()}`);
    place = {e: "attr", name: upper(kids[2].concatTokens()), type: findAttribute(ctx, upper(kids[2].concatTokens())).type};
    i = 3;
  } else {
    throw new Unsupported(`target ${target.concatTokens()}`);
  }
  for (; i < kids.length; i += 1) {
    if (isExpr(kids[i], Expressions.TableExpression)) {
      place = rowOf(place, kids[i], ctx);
    } else if (isTok(kids[i], "->") && isExpr(kids[i + 1], Expressions.AttributeName)) {
      place = place.type.k === "dref" ? dataRefField(place, kids[i + 1], ctx) : refAttribute(place, kids[i + 1], ctx, true);
      i += 1;
    } else if (isTok(kids[i], "-") && isExpr(kids[i + 1], Expressions.ComponentName)) {
      const f = fieldOf(ctx, place.type, kids[i + 1].concatTokens(), target.concatTokens());
      place = {e: "field", base: place, name: f.name, type: f.type};
      i += 1;
    } else if (isExpr(kids[i], Expressions.FieldOffset) || isExpr(kids[i], Expressions.FieldLength)) {
      const off = isExpr(kids[i], Expressions.FieldOffset) ? offsetValue(kids[i], ctx) : null;
      if (off !== null) i += 1;
      const len = isExpr(kids[i], Expressions.FieldLength) ? offsetValue(kids[i], ctx) : null;
      if (i < kids.length - 1 || !["x", "c"].includes(place.type.k) || (place.type.k === "x" && !len)) throw new Unsupported(`write target ${target.concatTokens()}`);
      return {e: "substr_target", base: place, off, len, type: place.type.k === "x" ? X(len.e === "int" ? len.value : place.type.len) : S};
    } else {
      throw new Unsupported(`target ${target.concatTokens()}`);
    }
  }
  return place;
}

/** ref->attr: an instance attribute of the class a reference points to */
/** @param {import("./frontend-types.ts").ValueExpr} base @param {import("./frontend-types.ts").TokenText} attrNode @param {import("./frontend-types.ts").NamedContext} ctx @param {boolean} [write] @returns {import("./frontend-types.ts").ValueExpr} */ function refAttribute(base, attrNode, ctx, write = false) {
  if (base.type.k === "exc") {
    const name = upper(attrNode.concatTokens());
    if (write || name !== "PREVIOUS") throw new Unsupported(`exception attribute ${name}${write ? " write" : ""}`);
    ctx.program.missing.add("CX_ROOT");
    return {e: "exc_previous", x: base, type: EXC};
  }
  if (base.type.k === "ref" && base.type.intf && base.type.name !== "OBJECT") return intfRefAttribute(base, upper(attrNode.concatTokens()), ctx, write);
  if (base.type.k === "ref" && !base.type.intf && attrNode.concatTokens().includes("~")) return classRefIntfAttribute(base, upper(attrNode.concatTokens()), ctx, write);
  if (base.type.k !== "ref" || base.type.intf) throw new Unsupported(`-> on a ${base.type.k === "ref" ? "interface reference" : base.type.k}`);
  const name = upper(attrNode.concatTokens());
  const kernelRtti = ["ATTRIBUTES", "METHODS", "INTERFACES", "TYPES", "EVENTS"].includes(name) && isSubclass(ctx.reg, base.type.name, "CL_ABAP_OBJECTDESCR");
  // a class the program does not compile is an empty struct in Go: its
  // attribute is refused here, in this method, not left to fail the build
  if (!ctx.program.wanted.has(base.type.name)) throw notInProgram(ctx, base.type.name, `${base.type.name}->${name}: the class is not compiled in this program`);
  const a = [base.type.name, ...ancestors(ctx.reg, base.type.name)].map((c) => clasDef(ctx.reg, c)?.getAttributes().getInstance()
    .find((x) => upper(x.getName()) === name)).find(Boolean);
  if (a === undefined) {
    const alias = aliasTarget(ctx.reg, base.type.name, name);
    if (alias?.includes("~") && ownInterfaceAttributes(ctx.program, alias.split("~")[0]).some((x) => x.name === alias)) {
      return classRefIntfAttribute(base, alias, ctx, write);
    }
    throw new Unsupported(`${base.type.name}->${name}: not an instance attribute`);
  }
  return {e: "refattr", base, name, ...(kernelRtti ? {kernelRtti: true} : {}), type: typeOf(a.getType(), `${base.type.name}->${name}`, ctx.program)};
}

/** @param {import("./frontend-types.ts").ValueExpr & {type: Extract<import("./ir.ts").Type, {k: "dref"}>}} base @param {import("./frontend-types.ts").TokenText} attrNode @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function dataRefField(base, attrNode, ctx) {
  const name = upper(attrNode.concatTokens());
  if (base.type.to?.k !== "struct") throw new Unsupported(`-> on a dref without a structured target`);
  const f = fieldOf(ctx, base.type.to, name, `${name} of data reference`);
  return {e: "dref_field", base, name: f.name, type: f.type, struct: base.type.to};
}

/** tab[ n ] or tab[ component = value ... ]: the addressed row; a missing
 * row raises CX_SY_ITAB_LINE_NOT_FOUND. Keyed expressions use the same
 * component/value subset as line_exists and READ TABLE WITH KEY. */
/** @param {import("./frontend-types.ts").ValueExpr} place @param {import("@abaplint/core").Nodes.ExpressionNode} te @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function rowOf(place, te, ctx) {
  if (place.type.k !== "table") throw new Unsupported(`a table expression on a ${place.type.k}`);
  const inner = te.getChildren().filter((c) => !isTok(c, "[") && !isTok(c, "]"));
  if (inner.length === 1 && isExpr(inner[0], Expressions.Source)) {
    return {e: "row", base: place, index: convert(source(inner[0], ctx, I), I), type: place.type.row};
  }
  /** @type {import("./ir.ts").TableKey[]} */ const keys = [];
  for (let i = 0; i < inner.length; i += 3) {
    const comp = inner[i];
    if (!isExpr(comp, Expressions.ComponentChainSimple) || !isTok(inner[i + 1], "=") || !isExpr(inner[i + 2], Expressions.Source)) {
      throw new Unsupported(`table expression with a key: ${te.concatTokens()}`);
    }
    const cname = upper(comp.concatTokens());
    if (cname === "TABLE_LINE") keys.push({line: true, value: convert(source(inner[i + 2], ctx, place.type.row), place.type.row)});
    else {
      const f = fieldOf(ctx, place.type.row, cname, te.concatTokens());
      keys.push({name: f.name, value: convert(source(inner[i + 2], ctx, f.type), f.type)});
    }
  }
  if (keys.length === 0) throw new Unsupported(`table expression with a key: ${te.concatTokens()}`);
  return {e: "row_key", base: place, keys, type: place.type.row};
}

/* ------------------------------------------------------ interface attributes */

/*
 * DATA of an interface is a field of every object whose class implements
 * the interface: INTF~ATTR in the class, ref->attr through a reference to
 * the interface, ref->intf~attr through a class reference or through a
 * reference to an interface that includes INTF. Measured on A4H
 * (ZCL_GOGEN_T_IA, 2026-09-23): one field, written through either reference
 * and read through the other; READ-ONLY is writable in the implementing
 * class and its subclasses (through me and through a reference of the
 * class's type), never through an interface reference, and not at all
 * outside; VALUE on an interface DATA does not activate; lo_i->intf~attr
 * naming the reference's own interface does not either. VALUE and the
 * READ-ONLY writes are syntax errors abaplint does not report, so the front
 * end refuses them; the last one abaplint does report, and the refusal here
 * only matters to a tolerant survey. A subclass that implements an interface
 * its superclass already implements (through an included one) shares the
 * superclass's field (A4H, ZCL_GOGEN_T_IADUP). The refusals are checked by
 * semantics.mjs against testdata-refused/.
 */

/** the DATA and CLASS-DATA of one interface (not of those it includes), cached */
/** @param {import("./frontend-types.ts").FrontendProgram} program @param {string} intf @returns {readonly import("./frontend-types.ts").InterfaceAttribute[]} */ function ownInterfaceAttributes(program, intf) {
  if (program.intfOwnAttrs.has(intf)) return program.intfOwnAttrs.get(intf);
  const obj = program.reg.getObject("INTF", intf);
  const def = obj?.getDefinition();
  /** @type {import("./frontend-types.ts").InterfaceAttribute[]} */ const out = [];
  program.intfOwnAttrs.set(intf, out);
  if (!def) return out;
  // READ-ONLY and VALUE are read off the statement: abaplint's attribute of
  // an interface carries neither (its meta is empty). Only the statements
  // that declare an attribute count: a DATA BEGIN OF block is its DataBegin,
  // and the components inside it are not attributes
  /** @type {Map<string, import("@abaplint/core").Nodes.StatementNode>} */ const stmts = new Map();
  /** @param {import("@abaplint/core").Nodes.StructureNode} node @returns {void} */ const walk = (node) => {
    for (const c of node.getChildren()) {
      if (isStmt(c, Statements.Data) || isStmt(c, Statements.DataBegin)) {
        const n = c.findDirectExpression(Expressions.DefinitionName) ?? c.findFirstExpression(Expressions.DefinitionName);
        if (n && !stmts.has(upper(n.concatTokens()))) stmts.set(upper(n.concatTokens()), c);
      } else if (isStruct(c, Structures.Data)) {
        const begin = c.findDirectStatement(Statements.DataBegin);
        const n = begin?.findDirectExpression(Expressions.DefinitionName);
        if (n && !stmts.has(upper(n.concatTokens()))) stmts.set(upper(n.concatTokens()), begin);
      } else if (c instanceof Nodes.StructureNode) walk(c);
    }
  };
  const top = obj.getMainABAPFile()?.getStructure();
  if (top) walk(top);
  /** @param {import("@abaplint/core").Nodes.StatementNode | undefined} st @returns {boolean} */ const readOnly = (st) => {
    const t = st?.getTokens().map((x) => upper(x.getStr())) ?? [];
    return t.some((x, i) => x === "READ" && t[i + 1] === "-" && t[i + 2] === "ONLY");
  };
  for (const a of def.getAttributes().getInstance()) {
    const name = `${intf}~${upper(a.getName())}`;
    const st = stmts.get(upper(a.getName()));
    /** @type {import("./frontend-types.ts").InterfaceAttribute} */ const entry = {name, intf, readOnly: readOnly(st)};
    if (st?.findFirstExpression(Expressions.Value)) entry.unsupported = `${name}: VALUE on an interface DATA does not activate on A4H`;
    else {
      // an anonymous structure (DATA BEGIN OF qname ...) is the interface's
      // type, named after the interface: typed while a class that implements
      // it is compiled, it was named after that class, and the interface's
      // accessor in another package then named a type it cannot see
      const owner = program.currentClass;
      program.currentClass = goName(intf);
      try { entry.type = typeOf(a.getType(), name, program); } catch (e) { if (!(e instanceof Unsupported)) throw e; entry.unsupported = e.message; } finally { program.currentClass = owner; }
    }
    out.push(entry);
  }
  for (const a of def.getAttributes().getStatic()) {
    const name = `${intf}~${upper(a.getName())}`;
    out.push({name, intf, static: true, unsupported: `${name}: CLASS-DATA of an interface is not in the subset`});
  }
  return out;
}

/** the attributes of an interface and of every interface it includes */
/** @param {import("./frontend-types.ts").FrontendProgram} program @param {string} intf @returns {readonly import("./frontend-types.ts").InterfaceAttribute[]} */ function interfaceAttributes(program, intf) {
  if (!program.interfaceAttrs.has(intf)) {
    program.interfaceAttrs.set(intf, [intf, ...componentInterfaces(program.reg, intf)].flatMap((i) => ownInterfaceAttributes(program, i)));
  }
  return program.interfaceAttrs.get(intf);
}

/** the fields a class gets for the interfaces it implements itself (a subclass inherits them) */
/** @param {import("./frontend-types.ts").FrontendProgram} program @param {readonly string[]} implemented @returns {import("./frontend-types.ts").FrontendAttribute[]} */ function implementedAttributes(program, implemented) {
  return implemented.flatMap((i) => ownInterfaceAttributes(program, i)).filter((a) => !a.static)
    .map((a) => (a.unsupported ? {name: a.name, unsupported: a.unsupported} : {name: a.name, type: a.type, static: false, fromIntf: a.intf, readOnly: a.readOnly}));
}

/** INTF~ATTR inside a class that implements INTF (or inherits it) */
/** @param {import("./frontend-types.ts").NamedContext} ctx @param {string} n @returns {import("./frontend-types.ts").ValueExpr} */ function ownIntfAttribute(ctx, n) {
  const intf = n.slice(0, n.lastIndexOf("~"));
  const a = ownInterfaceAttributes(ctx.program, intf).find((x) => x.name === n);
  if (a === undefined) throw new Unsupported(`${n}: not an attribute of ${intf} (an alias?)`);
  if (a.unsupported) throw new Unsupported(a.unsupported);
  return {e: "attr", name: n, type: a.type};
}

/** ref->attr and ref->comp~attr through a reference to an interface */
/** @param {import("./frontend-types.ts").ValueExpr} base @param {string} name @param {import("./frontend-types.ts").NamedContext} ctx @param {boolean} write @returns {import("./frontend-types.ts").ValueExpr} */ function intfRefAttribute(base, name, ctx, write) {
  const intf = base.type.name;
  if (name.includes("~")) {
    const pre = name.slice(0, name.lastIndexOf("~"));
    // measured on A4H: lo_i->zif_i~a on a reference to zif_i is a syntax error
    if (!componentInterfaces(ctx.reg, intf).includes(pre)) throw new Unsupported(`${intf}->${name}: ${pre} is not an interface ${intf} includes`);
  }
  const full = name.includes("~") ? name : `${intf}~${name}`;
  const a = interfaceAttributes(ctx.program, intf).find((x) => x.name === full);
  if (a === undefined) {
    // a constant or a CLASS-DATA read through the reference is ABAP too, but
    // not in the subset; say so rather than suspect an alias
    const [pre, comp] = full.split("~");
    const idef = ctx.reg.getObject("INTF", pre)?.getDefinition();
    if (idef?.getAttributes().getConstants().some((x) => upper(x.getName()) === comp)) {
      throw new Unsupported(`${intf}->${name}: a constant through an interface reference is not in the subset`);
    }
    if (idef?.getAttributes().getStatic().some((x) => upper(x.getName()) === comp)) {
      throw new Unsupported(`${intf}->${name}: a static attribute through an interface reference is not in the subset`);
    }
    throw new Unsupported(`${intf}->${name}: not an attribute of the interface (an alias?)`);
  }
  if (a.unsupported) throw new Unsupported(a.unsupported);
  if (write && a.readOnly) throw new Unsupported(`${intf}->${name}: a write to a READ-ONLY attribute through an interface reference (a syntax error on A4H)`);
  return {e: "refattr", base, name: full, type: a.type};
}

/** ref->intf~attr through a reference to a class that implements intf */
/** @param {import("./frontend-types.ts").ValueExpr} base @param {string} name @param {import("./frontend-types.ts").NamedContext} ctx @param {boolean} write @returns {import("./frontend-types.ts").ValueExpr} */ function classRefIntfAttribute(base, name, ctx, write) {
  const pre = name.slice(0, name.lastIndexOf("~"));
  // the topmost class that implements it: the field is its, and a subclass
  // implementing the same interface again shares it
  const owner = [base.type.name, ...ancestors(ctx.reg, base.type.name)].findLast((c) => (clasDef(ctx.reg, c)?.getImplementing() ?? [])
    .some((i) => upper(i.name) === pre || componentInterfaces(ctx.reg, upper(i.name)).includes(pre)));
  if (owner === undefined) throw new Unsupported(`${base.type.name}->${name}: the class does not implement ${pre}`);
  if (!ctx.program.wanted.has(owner)) throw new Unsupported(`${base.type.name}->${name}: ${owner}, which implements ${pre}, is not compiled`);
  const a = ownInterfaceAttributes(ctx.program, pre).find((x) => x.name === name);
  if (a === undefined) throw new Unsupported(`${base.type.name}->${name}: not an attribute of ${pre} (an alias?)`);
  if (a.unsupported) throw new Unsupported(a.unsupported);
  const inside = ctx.className === owner || ancestors(ctx.reg, ctx.className).includes(owner);
  if (write && a.readOnly && !inside) throw new Unsupported(`${base.type.name}->${name}: a write to a READ-ONLY attribute outside ${owner} (a syntax error on A4H)`);
  return {e: "refattr", base, name, type: a.type};
}

/* --------------------------------------------------------------- expressions */

const SY = {"SY-INDEX": "Index", "SY-TABIX": "Tabix", "SY-SUBRC": "Subrc", "SY-DBCNT": "Dbcnt", "SY-FDPOS": "Fdpos"};
const SY_MESSAGES = {
  "SY-MSGID": {field: "Msgid", type: C(20)}, "SY-MSGNO": {field: "Msgno", type: {k: "n", len: 3}},
  "SY-MSGTY": {field: "Msgty", type: C(1)},
  ...Object.fromEntries([1, 2, 3, 4].map((i) => [`SY-MSGV${i}`, {field: `Msgv${i}`, type: C(50)}])),
};
const CONSTRUCTORS = new Set(["VALUE", "CONV", "NEW", "REF", "COND", "SWITCH", "EXACT", "CORRESPONDING", "REDUCE", "FILTER", "CAST", "BOOLC", "XSDBOOL"]);

/**
 * The children of one Source, split into operands and operators. An operand
 * is one node, a parenthesised group `( Source )`, or a constructor
 * expression `CONV t( ... )` / `VALUE t( ... )`, which the parser leaves
 * inline in the same Source as the operator after it: `CONV f( w ) / 2` is
 * one Source of seven children.
 */
/** @param {import("./frontend-types.ts").SyntaxNode} node @returns {import("./frontend-types.ts").ExpressionItem[]} */ function items(node) {
  const kids = node.getChildren();
  /** @type {import("./frontend-types.ts").ExpressionItem[]} */ const out = [];
  for (let i = 0; i < kids.length; i += 1) {
    const k = kids[i];
    if (isTok(k) && ["XSDBOOL", "BOOLC"].includes(upper(tokenStr(k))) && isTok(kids[i + 1], "(") && isExpr(kids[i + 2], Expressions.Cond)) {
      out.push({bool: upper(tokenStr(k)), cond: kids[i + 2]});
      i += 3;
    } else if (isTok(k) && CONSTRUCTORS.has(upper(tokenStr(k))) && isExpr(kids[i + 1], Expressions.TypeNameOrInfer)) {
      // KW type ( body ) -- the body may be absent: VALUE #( )
      let j = i + 2;
      if (!isTok(kids[j]) || tokenStr(kids[j]) !== "(") throw new Unsupported(`constructor shape: ${node.concatTokens()}`);
      let body = null;
      if (!(isTok(kids[j + 1]) && tokenStr(kids[j + 1]) === ")")) { body = kids[j + 1]; j += 1; }
      if (!isTok(kids[j + 1]) || tokenStr(kids[j + 1]) !== ")") throw new Unsupported(`constructor shape: ${node.concatTokens()}`);
      out.push({ctor: {kw: upper(tokenStr(k)), typeNode: kids[i + 1], body, text: node.concatTokens()}});
      i = j + 1;
    } else if (isTok(k) && tokenStr(k) === "(") {
      const close = kids[i + 2];
      if (!isExpr(kids[i + 1], Expressions.Source) || !isTok(close) || tokenStr(close) !== ")") throw new Unsupported(`parenthesis: ${node.concatTokens()}`);
      out.push({group: kids[i + 1]});
      i += 2;
    } else if (isExpr(k, Expressions.MethodCallChain) && isExpr(kids[i + 1], Expressions.Arrow) && isExpr(kids[i + 2], Expressions.AttributeChain)) {
      // ultra/events: m( )->attr, an attribute of what the call returns (only
      // describe_by_data( )->type_kind / ->length are compiled: descrAttr)
      out.push({descr: {call: k, attr: kids[i + 2]}});
      i += 2;
    } else if (isExpr(k, Expressions.MethodCallChain) && isTok(kids[i + 1], "-") && isExpr(kids[i + 2], Expressions.ComponentChain)) {
      // m( )-comp: a component of what the call returns
      out.push({node: k, comps: kids[i + 2]});
      i += 2;
    } else if (isExpr(k, Expressions.ArithOperator)) {
      out.push({op: upper(k.concatTokens())});
    } else if (isTok(k) && ["&&", "&"].includes(tokenStr(k))) {
      out.push({concat: true});
    } else if (isTok(k) && ["-", "+"].includes(tokenStr(k)) && out.length === 0) {
      out.push({sign: tokenStr(k)});
    } else {
      out.push({node: k});
    }
  }
  return out;
}

/** the leaves of one arithmetic expression: calls count as leaves, their arguments do not */
/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./ir.ts").Type[]} */ function leafTypes(node, ctx) {
  /** @type {import("./ir.ts").Type[]} */ const out = [];
  /** @param {import("./frontend-types.ts").SyntaxNode} n @returns {void} */ const walk = (n) => {
    for (const it of items(n)) {
      if (it.ctor) out.push(constructor(it.ctor, ctx).type);
      else if (it.bool) out.push(it.bool === "BOOLC" ? S : C(1));
      else if (it.descr) out.push(descrAttr(it.descr.call, it.descr.attr, ctx).type);
      else if (it.group) walk(it.group);
      else if (it.node && isExpr(it.node, Expressions.Source)) walk(it.node);
      else if (it.node && it.comps) out.push(componentsOf(sourceOperand(it.node, ctx), it.comps, ctx).type);
      else if (it.node) out.push(sourceOperand(it.node, ctx).type);
    }
  };
  walk(node);
  return out;
}

const BIT_OPS = new Set(["BIT-AND", "BIT-OR", "BIT-XOR"]);
/** @param {import("./frontend-types.ts").SyntaxNode} node @returns {boolean} */ const hasBitOp = (node) => node.getChildren().some((c) => (isExpr(c, Expressions.ArithOperator) && BIT_OPS.has(upper(c.concatTokens())))
  || (isExpr(c, Expressions.Source) && hasBitOp(c)));
/** @param {import("./frontend-types.ts").SyntaxNode} node @returns {boolean} */ const hasPow = (node) => node.getChildren().some((c) => (isExpr(c, Expressions.ArithOperator) && c.concatTokens() === "**")
  || (isExpr(c, Expressions.Source) && hasPow(c)));
/** @param {import("./frontend-types.ts").SyntaxNode} node @returns {boolean} */ const hasArith = (node) => node.getChildren().some((c) => isExpr(c, Expressions.ArithOperator)
  || (isExpr(c, Expressions.Source) && hasArith(c)));

/*
 * cl_abap_typedescr=>describe_by_data( x )->type_kind / ->length (ultra/events:
 * ZCL_ABAPGIT_HTML~ADD, ZCL_ABAPGIT_CONVERT=>STRING_TO_TAB): the type kind
 * DESCRIBE FIELD x TYPE gives, the length in bytes (two per character of a
 * c); no descriptor object is made. Any other attribute of a call's result
 * is refused.
 */
/** @param {import("@abaplint/core").Nodes.ExpressionNode} methodCall @param {import("./frontend-types.ts").TokenText} attr @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function descrAttr(methodCall, attr, ctx) {
  const a = upper(attr.concatTokens());
  if (!/^cl_abap_typedescr=>describe_by_data\($/i.test(methodCall.concatTokens().replace(/\(.*$/s, "(")) || !["TYPE_KIND", "LENGTH"].includes(a)) {
    const base = call(methodCall, ctx, false);
    if (base.type.k !== "ref") throw new Unsupported(`an attribute of a call's non-reference result: ${methodCall.concatTokens()}->${attr.concatTokens()}`);
    return refAttribute(base, attr, ctx);
  }
  const arg = methodCall.findFirstExpression(Expressions.MethodCallParam)?.findDirectExpression(Expressions.Source);
  if (!arg) throw new Unsupported(`describe_by_data form: ${methodCall.concatTokens()}`);
  const x = convert(source(arg, ctx), {k: "data"});
  return a === "LENGTH" ? {e: "type_length", x, type: I} : {e: "type_kind", x, type: C(1)};
}

/*
 * ultra/itab: arithmetic with a generic operand (TYPE any) or into a generic
 * target. A4H 2026-09-24 (ZCL_GOGEN_T_GENAR, $ZOSG_TMP_0400): the
 * calculation type is the one the static rule above gives for the types the
 * field symbols have at run time, as if they had been declared with them
 * ("<a> / 2 * 2" into i is 8 for an i, 7 for a c, a string, an n and a p
 * 7.50, 8 for an f; a p target makes it p). So every calculation type that
 * can come out is compiled here as ordinary typed arithmetic, a generic
 * operand read into that type (unwrap_calc), and abap.CalcKind picks the
 * branch at run time from the static kinds, the operands' descriptors and
 * the target's. A branch that does not compile, and a combination the static
 * rule refuses (a character target of an i result, a d or x operand), is
 * NOT_COMPILED when it is reached, not before. A generic operand is read
 * twice (kind, then value), so only a place is taken.
 */
let GEN_CALC = false;
const CALC_CODE = {i: "I", int8: "8", f: "F", p: "P", c: "C", string: "g", n: "N", d: "D", t: "T", x: "X", xstring: "y"};
/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {import("./ir.ts").Type} [outer] @returns {import("./frontend-types.ts").ValueExpr} */ function genericArith(node, ctx, outer) {
  const text = node.concatTokens();
  if (outer === undefined) throw new Unsupported(`arithmetic with a generic operand outside an assignment: ${text}`);
  if (hasBitOp(node)) throw new Unsupported(`bit operation with a generic operand: ${text}`);
  const statics = [];
  for (const t of leafTypes(node, ctx)) {
    if (t.k === "data") continue;
    if (CALC_CODE[t.k] === undefined) throw new Unsupported(`calculation type with a ${t.k} operand: ${text}`);
    statics.push(CALC_CODE[t.k]);
  }
  // ** computes in f (the static rule)
  if (hasPow(node)) statics.push("F");
  let charTarget = false;
  if (outer.k !== "data") {
    if (charlike(outer)) charTarget = true;
    else if (outer.k === "x") statics.push("I");
    else if (["i", "int8", "f", "p"].includes(outer.k)) statics.push(CALC_CODE[outer.k]);
    else throw new Unsupported(`calculation type of ${text} into a ${outer.k}`);
  }
  const target = outer.k === "data" ? ctx.genTarget : null;
  if (outer.k === "data" && !target) throw new Unsupported(`generic arithmetic into a generic value that is not a target: ${text}`);
  const branches = {};
  let leaves = null;
  for (const [code, calc] of [["I", I], ["8", INT8], ["P", P31], ["F", F]]) {
    GEN_CALC = true;
    try {
      const v = arith(node, ctx, calc);
      if (leaves === null) {
        leaves = [];
        const walk = (n) => {
          if (Array.isArray(n)) { n.forEach(walk); return; }
          if (!n || typeof n !== "object") return;
          if (n.e === "unwrap_calc") { leaves.push(n.x); return; }
          for (const [k, x] of Object.entries(n)) if (k !== "type") walk(x);
        };
        walk(v);
      }
      branches[code] = outer.k === "data" ? {e: "wrap", x: v, type: {k: "data"}} : convert(v, outer);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      branches[code] = {reason: `calculation type ${calc.k} of ${text}: ${e.message}`};
    } finally {
      GEN_CALC = false;
    }
  }
  if (leaves === null) throw new Unsupported(`calculation type of ${text}: ${branches.I.reason}`);
  const PLACE = new Set(["var", "attr", "static", "field", "fs", "row", "refattr"]);
  for (const l of leaves) if (!PLACE.has(l.e)) throw new Unsupported(`a generic operand that is not a field in ${text}`);
  return {e: "gen_arith", statics: statics.join(""), charTarget, target, leaves, branches, text, type: outer.k === "data" ? {k: "data"} : outer};
}

/** @param {import("./frontend-types.ts").FieldChain} n @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function fieldChain(n, ctx) {
  const kids = isExpr(n, Expressions.SourceField) ? [n] : n.getChildren();
  const text = upper(n.concatTokens());
  if (SY_MESSAGES[text]) return {e: "sy", ...SY_MESSAGES[text]};
  if (SY[text] !== undefined) return {e: "sy", field: SY[text], type: I};
  // the logon client: the transpiler runtime's constant (abap.Mandt)
  if (text === "SY-MANDT") return {e: "sy_mandt", type: C(3)};
  if (text === "SY-BATCH") return {e: "chars", value: "", type: C(1)};
  // who the system is and its clock, as the host says (abap.SysID / UName,
  // the identity tools/osd-identity.mjs gives the Node boot: OSD, DEVELOPER;
  // date and time in UTC, as the transpiler runtime has them)
  if (text === "SY-SYSID") return {e: "sy_host", name: "SysID", type: C(8)};
  if (text === "SY-UNAME") return {e: "sy_host", name: "UName", type: C(12)};
  if (text === "SY-DATUM") return {e: "sy_host", name: "Datum()", type: {k: "d"}};
  if (text === "SY-UZEIT") return {e: "sy_host", name: "Uzeit()", type: {k: "t"}};
  // the database and the release, as the transpiler runtime has them on Node:
  // sy-dbsys the database client's name (c10, 'sqlite' for OSG's SQLite,
  // test/setup.mjs), sy-saprl its constant 'OPEN' (c4, @abaplint/runtime
  // builtin/sy.js); a system says 'HDB' and '758' (ultra/gaps)
  if (text === "SY-DBSYS") return {e: "sy_host", name: "DBSys", type: C(10)};
  if (text === "SY-SAPRL") return {e: "sy_host", name: "SapRl", type: C(4)};
  if (text === "ABAP_TRUE") return {e: "chars", value: "X", type: C(1)};
  if (text === "ABAP_FALSE") return {e: "chars", value: "", type: C(1)};
  // space: the c(1) blank, stored without its blank like every c value
  if (text === "SPACE") return {e: "chars", value: "", type: C(1)};
  if (text === "SY-ABCDE") return {e: "chars", value: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", type: C(26)};
  let place;
  let i = 0;
  if (isExpr(kids[0], Expressions.ClassName) && isTok(kids[1], "=>")) {
    const owner = upper(kids[0].concatTokens());
    const attr = upper(kids[2].concatTokens());
    place = resolveStatic(owner, attr, ctx);
    i = 3;
  } else if ((isTok(kids[0], "ME") || upper(kids[0].concatTokens()) === "ME") && isTok(kids[1], "->")) {
    place = {e: "attr", name: upper(kids[2].concatTokens()), type: findAttribute(ctx, upper(kids[2].concatTokens()))?.type};
    if (place.type === undefined) throw new Unsupported(`me->${kids[2].concatTokens()}: not an attribute`);
    i = 3;
  } else if (isExpr(kids[0], Expressions.SourceField) || isExpr(kids[0], Expressions.SourceFieldSymbol)) {
    place = variable(kids[0].concatTokens(), ctx);
    i = 1;
  } else if (isTok(kids[0], "ME") || (isExpr(kids[0], Expressions.SourceField) && upper(kids[0].concatTokens()) === "ME")) {
    place = {e: "attr", name: upper(kids[2].concatTokens()), type: findAttribute(ctx, upper(kids[2].concatTokens())).type};
    i = 3;
  } else {
    throw new Unsupported(`field chain ${n.concatTokens()}`);
  }
  for (; i < kids.length; i += 1) {
    if (isExpr(kids[i], Expressions.TableExpression)) {
      place = rowOf(place, kids[i], ctx);
    } else if (isTok(kids[i], "-") && isExpr(kids[i + 1], Expressions.ComponentName)) {
      const f = fieldOf(ctx, place.type, kids[i + 1].concatTokens(), n.concatTokens());
      place = {e: "field", base: place, name: f.name, type: f.type};
      i += 1;
    } else if (isTok(kids[i], "->") && isExpr(kids[i + 1], Expressions.AttributeName) && ["ref", "exc"].includes(place.type.k)) {
      place = refAttribute(place, kids[i + 1], ctx);
      i += 1;
    } else if (isTok(kids[i], "->") && isExpr(kids[i + 1], Expressions.AttributeName) && place.type.k === "dref") {
      place = dataRefField(place, kids[i + 1], ctx);
      i += 1;
    } else if (isTok(kids[i], "->") && upper(kids[i - 1].concatTokens()) === "ME") {
      place = {e: "attr", name: upper(kids[i + 1].concatTokens()), type: findAttribute(ctx, upper(kids[i + 1].concatTokens())).type};
      i += 1;
    } else if (isExpr(kids[i], Expressions.FieldOffset) || isExpr(kids[i], Expressions.FieldLength)) {
      const off = isExpr(kids[i], Expressions.FieldOffset) ? offsetValue(kids[i], ctx) : null;
      if (off !== null) i += 1;
      const len = isExpr(kids[i], Expressions.FieldLength) ? offsetValue(kids[i], ctx) : null;
      if (i < kids.length - 1) throw new Unsupported(`field chain ${n.concatTokens()}`);
      return substring(place, off, len, n);
    } else {
      throw new Unsupported(`field chain ${n.concatTokens()}`);
    }
  }
  return place;
}

/** the number after + or inside ( ) of v+off(len); null for (*) */
/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr | null} */ function offsetValue(node, ctx) {
  const v = node.getChildren()[1];
  if (isTok(v, "*")) return null;
  if (v instanceof Nodes.TokenNode) {
    if (!/^\d+$/.test(tokenStr(v))) throw new Unsupported(`offset ${node.concatTokens()}`);
    return {e: "int", value: Number(tokenStr(v)), type: I};
  }
  return convert(fieldChain(v, ctx), I);
}

/**
 * v+off(len): characters of a string or c, bytes of an xstring or x. Out of
 * range raises CX_SY_RANGE_OUT_OF_BOUNDS. A c field is read as its full
 * length (trailing blanks included) and the part is stored trimmed again.
 */
/** @param {import("./frontend-types.ts").ValueExpr} base @param {import("./frontend-types.ts").ValueExpr | null} off @param {import("./frontend-types.ts").ValueExpr | null} len @param {import("./frontend-types.ts").SyntaxNode} node @returns {import("./frontend-types.ts").ValueExpr} */ function substring(base, off, len, node) {
  // a d or t is read as the c of its length (measured on A4H: t '123456'
  // gives 12 and 34 for (2) and +2(2) into i)
  if (base.type.k === "d" || base.type.k === "t") base = {...base, type: C(base.type.len)};
  // an n the same way: its digits (A4H: n 10 '9000000123'+1(9) is 123 into
  // an i and 000000123 into an n 9; ultra/demodata)
  if (base.type.k === "n") base = {...base, type: C(base.type.len)};
  const k = base.type.k;
  if (!["string", "c", "xstring", "x"].includes(k)) throw new Unsupported(`offset on a ${k}: ${node.concatTokens()}`);
  const litLen = len?.e === "int" ? len.value : undefined;
  const type = k === "string" ? S : k === "xstring" ? XS : k === "c" ? C(litLen ?? base.type.len) : X(litLen ?? base.type.len);
  return {e: "substr", x: base, off, len, base: base.type, type};
}

const CHAR_UTILITIES = {NEWLINE: "\n", CR_LF: "\r\n", HORIZONTAL_TAB: "\t", FORM_FEED: "\f", VERTICAL_TAB: "\v"};

// abaplint resolves a local interface's constant types but leaves VALUEs
// that refer to a class constant undefined. Recover only declared VALUEs;
// an unresolved expression remains a refusal in registerConst.
function localInterfaceConstant(id, attr, local, reg) {
  const resolve = (name, source) => {
    const m = new RegExp(`\\b${name}\\s+TYPE\\s+[^\\n,.]+?\\s+VALUE\\s+([^,\\n.]+)`, "i").exec(source);
    if (!m) return undefined;
    const value = m[1].split('"')[0].trim();
    const ref = /^([\w/]+)=>([\w]+)$/i.exec(value);
    if (!ref) return value;
    return reg.getObject("CLAS", upper(ref[1]))?.getDefinition()?.getAttributes().getConstants()
      .find((c) => upper(c.getName()) === upper(ref[2]))?.getValue();
  };
  let value = id.getValue?.();
  if (value && typeof value === "object") {
    const begin = new RegExp(`\\bBEGIN\\s+OF\\s+${attr}\\s*,([\\s\\S]*?)\\bEND\\s+OF\\s+${attr}\\s*[,.]`, "i").exec(local.source)?.[1];
    if (begin) value = Object.fromEntries(Object.keys(value).map((k) => [k, resolve(k, begin)]));
  } else if (value === undefined) value = resolve(attr, local.source);
  return {...id, getType: () => id.getType(), getValue: () => value};
}

/** zif_x=>c_y or zcl_x=>attr */
/** @param {string} owner @param {string} attr @param {import("./frontend-types.ts").NamedContext} ctx @param {boolean} [write] @returns {import("./frontend-types.ts").ValueExpr} */ function resolveStatic(owner, attr, ctx, write = false) {
  return lowerStatic(owner, attr, ctx, {CHAR_UTILITIES, C, upper, clasDef, registerConst, localInterfaceConstant, Unsupported, ancestors, goName, typeOf, abaplint, notInProgram}, write);
}

/* ------------------------------------------------------------- constructors */


/** @param {import("./frontend-types.ts").ConstructorItem} c @param {import("./frontend-types.ts").MethodContext} ctx @param {import("./ir.ts").Type} [inferred] @returns {import("./frontend-types.ts").ValueExpr} */ function constructor(c, ctx, inferred) {
  if (c.kw === "CONV") {
    const to = namedType(c.typeNode, ctx, inferred);
    if (c.body === null || c.body.getChildren().length !== 1) throw new Unsupported(`CONV with LET or empty: ${c.text}`);
    // the type of CONV takes part in the calculation type of its argument
    return convert(source(c.body.findDirectExpression(Expressions.Source), ctx, to), to);
  }
  if (c.kw === "VALUE") {
    const to = namedType(c.typeNode, ctx, inferred);
    return valueBody(c.body, to, ctx, c.text);
  }
  // CORRESPONDING type( struct ) without BASE / MAPPING / EXCEPT (ultra/zvdb,
  // A4H 2026-09-24, ZCL_GOGEN_T_XCONV): a new structure, initial but for the
  // components the source has by name, each moved by the conversion rules
  // (c 6 into string loses its trailing blanks, c 4 into c 2 is cut). The
  // source is named once per component, so it must be a place that costs
  // nothing to name (as MOVE-CORRESPONDING)
  if (c.kw === "CORRESPONDING") {
    const to = namedType(c.typeNode, ctx, inferred);
    const kids = c.body?.getChildren() ?? [];
    if (kids.length !== 1 || !isExpr(kids[0], Expressions.Source)) throw new Unsupported(`CORRESPONDING form: ${c.text}`);
    const from = source(kids[0], ctx);
    // CORRESPONDING type( itab ) without BASE / MAPPING / EXCEPT: a new table,
    // one row per source row, each row as the structure case below builds it
    // (the report converter of open-abap-gui writes it for a select-option's
    // ranges). The source is read once; a sorted or hashed target would need
    // its key kept and is refused
    if (from.type.k === "table" && to.k === "table") {
      if (to.sorted || to.hashed) throw new Unsupported(`CORRESPONDING into a ${to.sorted ? "sorted" : "hashed"} table`);
      if (from.type.row?.k !== "struct" || to.row?.k !== "struct") throw new Unsupported(`CORRESPONDING between tables of ${from.type.row?.k} and ${to.row?.k} rows`);
      const src = structOf(ctx, from.type.row);
      const dst = structOf(ctx, to.row);
      if (!src || !dst) throw new Unsupported(`CORRESPONDING: a structure not in the program`);
      const row = {e: "var", name: `CORR_${ctx.temps++}`, type: from.type.row};
      ctx.locals.set(row.name, from.type.row);
      const fields = [];
      for (const f of dst.fields) {
        const g = src.fields.find((x) => x.name === f.name);
        if (!g) continue;
        if (["struct", "table"].includes(f.type.k) || ["struct", "table"].includes(g.type.k)) throw new Unsupported(`CORRESPONDING with a deep component ${f.name}`);
        fields.push({name: f.name, value: convert({e: "field", base: row, name: g.name, type: g.type}, f.type)});
      }
      return {e: "table_map", from, row, value: {e: "struct", fields, type: to.row}, type: to};
    }
    if (from.type.k !== "struct" || to.k !== "struct") throw new Unsupported(`CORRESPONDING from a ${from.type.k} to a ${to.k}`);
    const plain = (x) => ["var", "attr", "static", "fs"].includes(x.e) || (x.e === "field" && plain(x.base));
    if (!plain(from)) throw new Unsupported(`CORRESPONDING of something other than a variable or its component: ${c.text}`);
    const src = structOf(ctx, from.type);
    const dst = structOf(ctx, to);
    if (!src || !dst) throw new Unsupported(`CORRESPONDING: a structure not in the program`);
    const fields = [];
    for (const f of dst.fields) {
      const g = src.fields.find((x) => x.name === f.name);
      if (!g) continue;
      if (["struct", "table"].includes(f.type.k) || ["struct", "table"].includes(g.type.k)) throw new Unsupported(`CORRESPONDING with a deep component ${f.name}`);
      fields.push({name: f.name, value: convert({e: "field", base: from, name: g.name, type: g.type}, f.type)});
    }
    return {e: "struct", fields, type: to};
  }
  if (c.kw === "COND") {
    const to = namedType(c.typeNode, ctx, inferred);
    const kids = c.body?.getChildren() ?? [];
    const branches = [];
    let otherwise = null;
    for (let i = 0; i < kids.length; i += 1) {
      if (isTok(kids[i], "WHEN")) {
        const cnd = cond(kids[i + 1], ctx);
        if (!isTok(kids[i + 2], "THEN")) throw new Unsupported(`COND shape: ${c.text}`);
        branches.push({cond: cnd, value: convert(source(kids[i + 3], ctx, to), to)});
        i += 3;
      } else if (isTok(kids[i], "ELSE")) {
        otherwise = convert(source(kids[i + 1], ctx, to), to);
        i += 1;
      } else {
        throw new Unsupported(`COND part ${kids[i].concatTokens()}: ${c.text}`);
      }
    }
    return {e: "cond", branches, else: otherwise, type: to};
  }
  if (c.kw === "CAST") {
    const to = namedType(c.typeNode, ctx, inferred);
    if (!c.body || !isExpr(c.body, Expressions.Source)) throw new Unsupported(`CAST form: ${c.text}`);
    return downCast(source(c.body, ctx), to, c.text);
  }
  if (c.kw === "NEW") {
    const to = namedType(c.typeNode, ctx, inferred);
    if (to.k !== "ref") throw new Unsupported(`NEW of a ${to.k}: ${c.text}`);
    if (!ctx.program.wanted.has(to.name)) throw notInProgram(ctx, to.name, `NEW ${to.name}: the class is not compiled in this program`);
    const sig = constructorSignature(ctx, to.name);
    const given = new Map();
    const body = c.body;
    if (body !== null) {
      if (isExpr(body, Expressions.Source)) {
        const imp = sig.filter((p) => p.dir === "importing");
        given.set(imp.find((p) => p.default === undefined)?.name ?? imp[0]?.name, body);
      } else {
        for (const p of body.findAllExpressions(Expressions.ParameterS)) {
          given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
        }
      }
    }
    const args = sig.map((p) => {
      if (p.suppliedOf) return {dir: "importing", byValue: true, type: p.type, value: {e: "chars", value: given.has(p.suppliedOf) ? "X" : "", type: p.type}};
      const src = given.get(p.name);
      if (src === undefined) {
        if (p.default !== undefined) return {name: p.name, supplied: false, dir: "importing", byValue: p.byValue, type: p.type, value: defaultValue(p, ctx)};
        if (p.optional) return {name: p.name, supplied: false, dir: "importing", byValue: p.byValue, type: p.type, value: {e: "zero", type: p.type}};
        throw new Unsupported(`NEW ${to.name}: ${p.name} not supplied`);
      }
      return {dir: "importing", byValue: p.byValue, type: p.type, value: convert(source(src, ctx, p.type), p.type)};
    });
    return {e: "new", cls: to.name, args, type: to};
  }
  throw new Unsupported(`${c.kw} constructor expression`);
}

/**
 * The signature of a method of any class or interface of the registry, by
 * owner and name ("M", or "I~M" for an interface method). Cached; an
 * untypeable signature is a named refusal at the call.
 */
/** @param {import("./frontend-types.ts").CompilationContext} ctx @param {string} owner @param {string} name @returns {import("./frontend-types.ts").MethodSignature} */ function methodSignature(ctx, owner, name) {
  const key = `${owner}=>${name}`;
  if (ctx.program.sigs.has(key)) return suppliedSignature(ctx, owner, name, ctx.program.sigs.get(key));
  if (NATIVE_ME.has(key)) { ctx.program.sigs.set(key, nativeMeSig(ctx.program, key, name)); return ctx.program.sigs.get(key); }
  /** @type {import("./frontend-types.ts").MethodSignature} */ let sig;
  try {
    const [intf, meth] = name.includes("~") ? name.split("~") : [null, name];
    const defOwner = intf ?? owner;
    const def = ctx.reg.getObject("INTF", defOwner)?.getDefinition() ?? clasDef(ctx.reg, defOwner);
    if (def === undefined) throw new Unsupported(`${defOwner} is not in the program`);
    /** @type {import("./frontend-types.ts").MethodDefinition | undefined} */ const m = intf ? Array.from((() => { const all = def.getMethodDefinitions(); return Array.isArray(all) ? all : all.getAll(); })()).find((x) => upper(x.getName()) === meth)
      : declaredMethod(ctx.reg, defOwner, meth);
    if (m === undefined) throw new Unsupported(`${defOwner} has no method ${meth}`);
    const p = m.getParameters();
    const optional = new Set((p.getOptional?.() ?? []).map(upper));
    // an anonymous structure of an interface method's signature (the row of
    // a RANGE OF) is the interface's, named after it: typed while a caller
    // or an implementing class was compiled, each named it after itself and
    // the class no longer implemented the interface in Go
    /** @param {import("@abaplint/core").AbstractType} t @returns {import("./ir.ts").Type} */ const typeIn = (t) => {
      if (!intf) return typeOf(t, key, ctx.program);
      const saved = ctx.program.currentClass;
      ctx.program.currentClass = goName(intf);
      try { return typeOf(t, key, ctx.program); } finally { ctx.program.currentClass = saved; }
    };
    /** @param {import("@abaplint/core").TypedIdentifier} x @param {NonNullable<import("./ir.ts").Param["dir"]>} dir @returns {import("./frontend-types.ts").FrontendParam} */ const param = (x, dir) => ({name: upper(x.getName()), dir, byValue: x.getMeta().includes("pass_by_value"), type: typeIn(x.getType()), default: defaultOf(p, x),
      optional: optional.has(upper(x.getName())), defaultOwner: intf ?? declaringClass(ctx.reg, defOwner, meth, "method") ?? defOwner, defOwner: intf ?? declaringClass(ctx.reg, defOwner, meth, "method") ?? defOwner});
    const ret = p.getReturning();
    const own = [...p.getImporting().map((x) => param(x, "importing")), ...p.getExporting().map((x) => param(x, "exporting")),
      ...p.getChanging().map((x) => param(x, "changing"))];
    sig = {name, static: m.isStatic?.() ?? false,
      params: withSupplied(ctx.program, intf ? `${intf}=>${meth}`
        : `${declaringClass(ctx.reg, defOwner, meth, "method") ?? defOwner}=>${meth}`, own),
      returning: ret === undefined ? null : {name: upper(ret.getName()), type: typeIn(ret.getType())}};
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    sig = {name, unsupported: e.message};
  }
  ctx.program.sigs.set(key, sig);
  return sig;
}

/** the superclasses of a class, nearest first, as far as the registry has them */
/** @param {import("@abaplint/core").IRegistry} reg @param {string} cls @returns {string[]} */ export function ancestors(reg, cls) {
  const out = [];
  for (let c = clasDef(reg, cls)?.getSuperClass(), g = 0; c && g < 30; g += 1) {
    out.push(upper(c));
    c = clasDef(reg, c)?.getSuperClass();
  }
  return out;
}

/** the definition of a method as a class has it: its own, else the nearest
 * superclass's; a REDEFINITION declares no parameters, so its origin's */
/** @param {import("@abaplint/core").IRegistry} reg @param {string} cls @param {string} meth @returns {import("./frontend-types.ts").MethodDefinition | undefined} */ function declaredMethod(reg, cls, meth) {
  for (const c of [cls, ...ancestors(reg, cls)]) {
    const m = clasDef(reg, c)?.getMethodDefinitions().getAll().find((x) => upper(x.getName()) === meth);
    if (m && !m.isRedefinition()) return m;
  }
  return undefined;
}

/** the class in cls's chain, itself first, that declares a method or attribute */
/** the class of cls and its ancestors that lists intf in its INTERFACES */
/** @param {import("@abaplint/core").IRegistry} reg @param {string} cls @param {string} intf @returns {string | undefined} */ function implementingClass(reg, cls, intf) {
  for (const c of [cls, ...ancestors(reg, cls)]) {
    const def = clasDef(reg, c);
    if (!def) return undefined;
    if (def.getImplementing().some((x) => upper(x.name) === intf)) return c;
  }
  return undefined;
}

/** @param {import("@abaplint/core").IRegistry} reg @param {string} cls @param {string} name @param {"method" | "attr"} kind @returns {string | undefined} */ function declaringClass(reg, cls, name, kind) {
  for (const c of [cls, ...ancestors(reg, cls)]) {
    const def = clasDef(reg, c);
    if (!def) return undefined;
    const has = kind === "method" ? def.getMethodDefinitions().getAll().some((x) => upper(x.getName()) === name && !x.isRedefinition())
      : def.getAttributes().getAll().some((x) => upper(x.getName()) === name);
    if (has) return c;
  }
  return undefined;
}


/*
 * Open SQL through the shared relational IR (osg-i7's, tools/sqlscript-ir.mjs
 * lowered by tools/sqlscript-lower.mjs; ranges tools/ir-ranges.mjs, writes
 * tools/ir-writes.mjs). What is known at build time is lowered here, once:
 * a SELECT, an UPDATE ... SET ... WHERE, a DELETE FROM ... WHERE, with a
 * host value as a parameter and a range as a hostPred marker that the Go
 * runtime fills (go/abap/ranges.go, a port checked byte for byte against
 * the pairs). A write whose rows are a work area or an internal table is
 * built here with ir-writes' constructors and lowered once to refuse what
 * the IR refuses; its rows arrive at run time and the Go runtime renders
 * them with its port of the same lowering (go/abap/irsql.go, checked
 * against writes.json). MANDT is the logon client in every predicate and in
 * every row written, as a system does implicitly.
 */

/** a table of the dictionary: its columns (typed on demand), its key, whether it has a client */
function dbTable(ctx, tableName, verb) {
  const mappings = cdsViewsByRegistry.get(ctx.reg) ?? cdsViewsByRegistry.get(inputOrigin(ctx.reg));
  const mappingError = cdsMappingError(mappings, tableName);
  if (mappingError) throw new Unsupported(mappingError);
  // a DDIC view (the SQL views of OSG's CDS entities, created as SQLite views
  // by the transpiler's DatabaseSetup) is read like a table: its fields are
  // its columns, MANDT among them when it has one (ultra/sadl). It is never
  // written: a write to a view is refused
  const view = verb === "SELECT FROM" ? ctx.reg.getObject("VIEW", tableName) : undefined;
  const tabl = ctx.reg.getObject("TABL", tableName) ?? view;
  if (!tabl) throw new Unsupported(`${verb} ${tableName}: not a table of the dictionary in this program`);
  let tType;
  try { tType = tabl.parseType(ctx.reg); } catch { throw new Unsupported(`${verb} ${tableName}: its type does not resolve`); }
  if (!(tType instanceof BasicTypes.StructureType)) throw new Unsupported(`${verb} ${tableName}: its type does not resolve`);
  const columns = new Map(tType.getComponents().map((c) => [upper(c.name), c]));
  // a view over a client-dependent table that does not carry MANDT hides
  // the client: a system reads the logon client's rows (a CDS view's SQL view
  // has MANDT), this one would read every client's. Refused, not served
  // unfiltered (OSG's tools/cds2ddic.mjs leaves MANDT out of such views)
  if (tabl === view && !columns.has("MANDT")) {
    const hidden = [...new Set((view.getFields() ?? []).map((f) => upper(f.TABNAME)))].find((t) => {
      try {
        const bt = ctx.reg.getObject("TABL", t)?.parseType(ctx.reg);
        return bt instanceof BasicTypes.StructureType && bt.getComponents().some((c) => upper(c.name) === "MANDT");
      } catch { return false; }
    });
    if (hidden) throw new Unsupported(`${verb} ${tableName}: a view over the client-dependent ${hidden} without MANDT`);
  }
  const colType = (n) => {
    const c = columns.get(n);
    if (!c) throw new Unsupported(`${verb}: ${tableName} has no column ${n}`);
    return typeOf(c.type, `${tableName}-${n}`, ctx.program);
  };
  let key = [];
  try { key = tabl.listKeys?.(ctx.reg)?.map(upper) ?? []; } catch { key = []; }
  return {name: tableName, columns, colType, key, client: columns.has("MANDT")};
}


/** one comparison of a WHERE: col op value, or col IN range (a hostPred) */
function sqlCompare(p, ctx, tb, acc) {
  const kids = p.getChildren();
  const text = p.concatTokens();
  if (!isExpr(kids[0], Expressions.SQLFieldName) || kids[0].concatTokens().includes("~")) throw new Unsupported(`WHERE compare: ${text}`);
  const col = upper(kids[0].concatTokens());
  const ct = tb.colType(col);
  // The parser leaves LIKE as tokens rather than SQLCompareOperator. The
  // SEGW cleanup tests use a quoted pattern; keep other forms refused.
  const like = /^[\w/]+\s+(NOT\s+)?LIKE\s+'((?:''|[^'])*)'$/i.exec(text);
  if (like) {
    if (ct.k !== "c" && ct.k !== "string") throw new Unsupported(`WHERE LIKE on a ${ct.k} column: ${text}`);
    return RIR.like(RIR.col(lowName(col), sqlIrType(ct)),
      RIR.lit(like[2].replaceAll("''", "'"), RIR.T.str), undefined, !!like[1]);
  }
  const inn = p.findDirectExpression(Expressions.SQLIn);
  if (inn) {
    if (kids.length !== 2 || kids[1] !== inn) throw new Unsupported(`WHERE IN form: ${text}`);
    const srcs = inn.findDirectExpressions(Expressions.SQLSource);
    if (srcs.length !== 1 || inn.getChildren().length !== 2) throw new Unsupported(`WHERE IN form: ${text}`);
    const range = sqlHost(srcs[0], [], ctx, text);
    if (range.type.k !== "table" || range.type.row.k !== "struct") throw new Unsupported(`IN of a ${range.type.k}`);
    const fields = new Map((ctx.program.structs.get(range.type.row.go)?.fields ?? []).map((x) => [String(x.name).toUpperCase(), x]));
    if (!["SIGN", "OPTION", "LOW", "HIGH"].every((x) => fields.has(x))) throw new Unsupported(`IN of a table that is not a ranges table`);
    for (const f of ["LOW", "HIGH"]) {
      if (!["c", "string", "i", "n", "d", "t"].includes(fields.get(f).type.k)) throw new Unsupported(`IN: a range whose ${f} is a ${fields.get(f).type.k}`);
    }
    if (!["c", "string", "i", "n", "t"].includes(ct.k)) throw new Unsupported(`IN on a ${ct.k} column: ${text}`);
    // a d column: tools/ir-ranges.mjs refuses dates, so every range with a
    // row would be NOT_COMPILED at run time; refused here until it does
    const id = String(acc.ranges.length);
    const low = fields.get("LOW").type;
    const kind = ct.k === "n" ? "NUMC" : undefined;
    const irT = sqlIrType(ct);
    acc.ranges.push({id, column: lowName(col), type: irT, kind, lowLen: low.k === "c" || low.k === "n" ? low.len ?? 0 : 0, range});
    return rangeHostPred(id, lowName(col), irT, kind === undefined ? {} : {kind});
  }
  // col [NOT] BETWEEN a AND b: both bounds included, as on a system; the
  // same >= / <= pair the single comparisons below produce, so Go and JS
  // lower it alike
  const between = isTok(kids[1], "BETWEEN") ? 1 : isTok(kids[1], "NOT") && isTok(kids[2], "BETWEEN") ? 2 : 0;
  if (between > 0) {
    const [lowSrc, andTok, highSrc] = kids.slice(between + 1);
    if (!isExpr(lowSrc, Expressions.SQLSource) || !isTok(andTok, "AND") || !isExpr(highSrc, Expressions.SQLSource)
        || kids.length !== between + 4) throw new Unsupported(`WHERE BETWEEN form: ${text}`);
    if (!["c", "string", "i", "n", "d", "t", "int8", "p"].includes(ct.k)) throw new Unsupported(`WHERE BETWEEN on a ${ct.k} column: ${text}`);
    const colIr = RIR.col(lowName(col), sqlIrType(ct));
    const bound = (node) => sqlValue(sqlHost(node, [], ctx, text), ct, sqlIrType(ct), acc);
    const both = RIR.bin("AND", RIR.bin(">=", colIr, bound(lowSrc), RIR.T.bool),
      RIR.bin("<=", colIr, bound(highSrc), RIR.T.bool), RIR.T.bool);
    return between === 2 ? RIR.not(both) : both;
  }
  const op = p.findDirectExpression(Expressions.SQLCompareOperator);
  const src = p.findDirectExpression(Expressions.SQLSource);
  if (!op || !src || kids[1] !== op || kids[2] !== src) throw new Unsupported(`WHERE compare: ${text}`);
  const sqlOp = SQL_OPS[upper(op.concatTokens())];
  if (sqlOp === undefined) throw new Unsupported(`WHERE operator ${op.concatTokens()}`);
  if (!["c", "string", "i", "n", "d", "t", "int8", "x", "p"].includes(ct.k)) throw new Unsupported(`WHERE on a ${ct.k} column: ${text}`);
  const v = sqlHost(src, kids.slice(3), ctx, text);
  return RIR.bin(sqlOp, RIR.col(lowName(col), sqlIrType(ct)), sqlValue(v, ct, sqlIrType(ct), acc), RIR.T.bool);
}

/** a WHERE (SQLCond) as an IR predicate: comparisons, IN range, AND, OR,
 * NOT and parentheses, with ABAP's precedence (NOT, AND, OR) */
function sqlCond(node, ctx, tb, acc) {
  const items = node.getChildren();
  let i = 0;
  const text = node.concatTokens();
  const primary = () => {
    const n = items[i++];
    if (isTok(n, "(")) {
      const inner = items[i++];
      if (!isExpr(inner, Expressions.SQLCond) || !isTok(items[i], ")")) throw new Unsupported(`WHERE form: ${text}`);
      i += 1;
      return sqlCond(inner, ctx, tb, acc);
    }
    if (isExpr(n, Expressions.SQLCompare)) return sqlCompare(n, ctx, tb, acc);
    throw new Unsupported(`WHERE form: ${text}`);
  };
  const notExpr = () => {
    if (isTok(items[i], "NOT")) { i += 1; return RIR.not(notExpr()); }
    return primary();
  };
  const andExpr = () => {
    let l = notExpr();
    while (isTok(items[i], "AND")) { i += 1; l = RIR.bin("AND", l, notExpr(), RIR.T.bool); }
    return l;
  };
  let l = andExpr();
  while (isTok(items[i], "OR")) { i += 1; l = RIR.bin("OR", l, andExpr(), RIR.T.bool); }
  if (i !== items.length) throw new Unsupported(`WHERE form: ${text}`);
  return l;
}

/** the client and the WHERE of a statement, AND'ed */
function wherePred(node, ctx, tb, acc) {
  const cond = node.findDirectExpression(Expressions.SQLCond);
  let pred = tb.client ? mandtPred() : null;
  if (cond) pred = andIr(pred, sqlCond(cond, ctx, tb, acc));
  return pred;
}

/** a lowered statement's parameters as the emitter binds them, and its ranges */
function loweredArgs(lowered, acc) {
  const args = lowered.params.map((p) => {
    const m = /^@@host:(\d+)@@$/.exec(String(p.name ?? ""));
    if (m) {
      const h = acc.hosts[Number(m[1])];
      return h.fit !== undefined ? {host: h.v, fit: h.fit} : h.xstring ? {host: h.v, xstring: true} : h.xhex !== undefined ? {host: h.v, xhex: h.xhex}
        : h.xexact !== undefined ? {host: h.v, xexact: h.xexact} : {host: h};
    }
    if (p.name === "SY-MANDT") return {mandt: true};
    return {value: p.value};
  });
  const preds = (lowered.hostPreds ?? []).map((h) => ({...acc.ranges[Number(h.id)], after: h.after}));
  return {args, preds};
}

function lowerOrRefuse(verb, rel) {
  try { return lowerRelation(rel, "sqlite"); } catch (e) { throw new Unsupported(`${verb}: the relational IR refused it: ${e.message}`); }
}

/** the field list of a SELECT: * or plain columns */
function selectColumns(sel, tb, text) {
  const fl = sel.findDirectExpression(Expressions.SQLFieldList);
  const names = /^\s*\*\s*$/.test(fl?.concatTokens() ?? "") ? [...tb.columns.keys()]
    : (fl?.findAllExpressions(Expressions.SQLField) ?? []).map((f) => {
      const n = f.findDirectExpression(Expressions.SQLFieldName);
      if (!n || f.getChildren().length !== 1) throw new Unsupported(`SELECT field ${f.concatTokens()}`);
      return upper(n.concatTokens());
    });
  if (names.length === 0) throw new Unsupported(`SELECT field list: ${text}`);
  return names.map((n) => ({name: n, type: tb.colType(n)}));
}

/*
 * ultra/itab: SELECT c ... COUNT( * ) [AS a] MAX( c ) AS a ... GROUP BY c ...
 * (A4H 2026-09-24, ZCL_GOGEN_T_GRPBY): plain columns, each one of the GROUP
 * BY list, and COUNT( * ), MAX / MIN of a column (its own type) and SUM of
 * an i column; the result named by AS (the CORRESPONDING name). An
 * aggregate without GROUP BY reads NULL over no rows, which a scan into a
 * field does not take: refused, as are AVG, COUNT( col ), DISTINCT inside
 * and SUM of other types (not measured).
 */
function groupedColumns(sel, tb, text) {
  const gb = sel.findDirectExpression(Expressions.SQLGroupBy);
  if (!gb && !/^SELECT\s+(?:MAX|MIN|SUM|COUNT)\s*\(/i.test(text)) throw new Unsupported(`SELECT with an aggregate and no GROUP BY: ${text}`);
  // the first column is an SQLField, the ones after it bare SQLFieldNames
  const gcols = gb?.getChildren().filter((c) => !isTok(c, "GROUP") && !isTok(c, "BY") && !isTok(c, ",")) ?? [];
  const groupBy = gcols.map((f) => {
    const n = isExpr(f, Expressions.SQLFieldName) ? f : f.findDirectExpression(Expressions.SQLFieldName);
    if (!n || (!isExpr(f, Expressions.SQLFieldName) && f.getChildren().length !== 1)) throw new Unsupported(`GROUP BY ${f.concatTokens()}`);
    const name = upper(n.concatTokens());
    tb.colType(name);
    return name;
  });
  if (gb && groupBy.length === 0) throw new Unsupported(`GROUP BY form: ${text}`);
  const fl = sel.findDirectExpression(Expressions.SQLFieldList);
  const cols = [];
  for (const f of fl?.findDirectExpressions(Expressions.SQLField) ?? []) {
    const agg = f.findDirectExpression(Expressions.SQLAggregation);
    const as = f.findDirectExpression(Expressions.SQLAsName);
    if (!agg) {
      const n = f.findDirectExpression(Expressions.SQLFieldName);
      if (!n || f.getChildren().length !== 1) throw new Unsupported(`SELECT field ${f.concatTokens()}`);
      const name = upper(n.concatTokens());
      if (!groupBy.includes(name)) throw new Unsupported(`SELECT field ${name} is not in GROUP BY: ${text}`);
      cols.push({name, type: tb.colType(name)});
      continue;
    }
    const fn = upper(agg.getFirstToken().getStr());
    const name = as ? upper(as.concatTokens()) : null;
    if (/\bDISTINCT\b/i.test(agg.concatTokens())) throw new Unsupported(`aggregate ${agg.concatTokens()}`);
    if (fn === "COUNT" && /^COUNT\s*\(\s*\*\s*\)$/i.test(agg.concatTokens())) {
      cols.push({name: name ?? "COUNT_STAR", type: I, agg: {star: true}, named: !!name});
      continue;
    }
    const n = agg.findFirstExpression(Expressions.SQLFieldName);
    if (!n || !["MAX", "MIN", "SUM"].includes(fn)) throw new Unsupported(`aggregate ${agg.concatTokens()}`);
    const col = upper(n.concatTokens());
    const ct = tb.colType(col);
    if (fn === "SUM" && ct.k !== "i") throw new Unsupported(`SUM of a ${ct.k} column: not measured`);
    if (fn !== "SUM" && !["c", "i", "n", "d", "t", "string"].includes(ct.k)) throw new Unsupported(`${fn} of a ${ct.k} column`);
    cols.push({name: name ?? `${fn}_${col}`, type: ct, agg: {fn, col}, named: !!name});
  }
  if (cols.length === 0) throw new Unsupported(`SELECT field list: ${text}`);
  if (new Set(cols.map((c) => c.name)).size !== cols.length) throw new Unsupported(`SELECT: two results of one name: ${text}`);
  cols.grouped = true;
  cols.groupBy = groupBy;
  return cols;
}

function selectTable(sel, ctx, text) {
  const from = sel.findDirectExpression(Expressions.SQLFrom)?.findAllExpressions(Expressions.DatabaseTable) ?? [];
  if (from.length !== 1) throw new Unsupported(`SELECT FROM form: ${text}`);
  return dbTable(ctx, upper(from[0].concatTokens()), "SELECT FROM");
}

/** ORDER BY f [ASCENDING|DESCENDING] ..., by columns of the table */
function orderByOf(sel, tb) {
  const order = [];
  const ob = sel.findDirectExpression(Expressions.SQLOrderBy);
  if (ob) {
    if (/PRIMARY\s+KEY/i.test(ob.concatTokens())) throw new Unsupported("ORDER BY PRIMARY KEY");
    const kids = ob.getChildren().filter((c) => !isTok(c, "ORDER") && !isTok(c, "BY") && !isTok(c, ","));
    for (let i = 0; i < kids.length; i += 1) {
      if (!isExpr(kids[i], Expressions.SQLField)) throw new Unsupported(`ORDER BY form: ${ob.concatTokens()}`);
      // the column before its direction (read after the step, it was the
      // DESCENDING token itself: "no column DESCENDING")
      const col = upper(kids[i].concatTokens());
      const desc = isTok(kids[i + 1], "DESCENDING");
      if (isTok(kids[i + 1], "DESCENDING") || isTok(kids[i + 1], "ASCENDING")) i += 1;
      tb.colType(col);
      order.push({col, desc});
    }
  }
  return order;
}

/*
 * SELECT ... INTO wa ... ENDSELECT, a loop over the rows. Measured on A4H
 * 2026-09-24 (ZCL_GOGEN_T_SELLOOP in $ZOSG_TMP_0195, over T000 of two rows:
 * "n:2 in:1/0,2/0, after:0/2 exit:0/1/000 exitmiss:0/1 none:4/0/QQQ
 * cont:0/2/2 corr:5/000 elem:000/2 exit2:0/2"): each pass starts with
 * sy-subrc 0 and sy-dbcnt the rows read so far, whatever the body did on
 * the pass before; after ENDSELECT, or after an EXIT out of the loop,
 * sy-subrc is 0 and sy-dbcnt the rows read when there was a row (a sy-subrc
 * the body left is overwritten), 4 and 0 when there was none, and the work
 * area keeps what it had. The rows are read before the first pass (the
 * transpiler does the same); what a system's cursor shows of a write to the
 * same table inside the loop is not measured, so such a body is refused.
 */
function selectLoop(node, ctx) {
  const st = node.findDirectStatement(Statements.SelectLoop);
  const text = st?.concatTokens() ?? "";
  const sel = st?.findDirectExpression(Expressions.Select);
  if (!sel || /\b(SINGLE|UP\s+TO|DISTINCT|HAVING|JOIN|FOR\s+ALL|APPENDING|PACKAGE|BYPASSING|CLIENT|UNION|FOR\s+UPDATE)\b/i.test(selectShape(sel))) throw new Unsupported(`SELECT loop form: ${text}`);
  if (sel.findDirectExpression(Expressions.SQLIntoTable)) throw new Unsupported(`SELECT loop INTO TABLE: ${text}`);
  const tb = selectTable(sel, ctx, text);
  const grouped = !!sel.findDirectExpression(Expressions.SQLGroupBy);
  const cols = grouped ? groupedColumns(sel, tb, text) : selectColumns(sel, tb, text);
  const {assign, target} = intoWorkArea(sel, ctx, text, cols, "SELECT loop");
  const acc = {hosts: [], ranges: []};
  const pred = wherePred(sel, ctx, tb, acc);
  const order = orderByOf(sel, tb);
  let rel = RIR.scan(lowName(tb.name));
  if (pred !== null) rel = RIR.filter(rel, pred);
  if (grouped) {
    rel = RIR.aggregate(rel, cols.groupBy.map(lowName), cols.filter((c) => c.agg).map((c) => ({as: lowName(c.name), expr: c.agg.star
      ? {...RIR.call("COUNT", [], RIR.T.int), star: true} : RIR.call(c.agg.fn, [RIR.col(lowName(c.agg.col), sqlIrType(c.type))], sqlIrType(c.type))})));
  }
  rel = RIR.project(rel, cols.map((c) => ({as: lowName(c.name), expr: RIR.col(lowName(c.name), sqlIrType(c.type))})));
  if (order.length > 0) rel = RIR.order(rel, order.map((o) => ({col: lowName(o.col), desc: o.desc})));
  const lowered = lowerOrRefuse("SELECT", rel);
  const body = bodyOf(node, ctx);
  // a write to the table being read, inside the loop: refused (see above)
  const writes = [];
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    if ((n.s === "db_write" || n.s === "db_write_sql") && n.table === tb.name) writes.push(n);
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k]);
  };
  walk(body);
  if (writes.length > 0) throw new Unsupported(`SELECT loop over ${tb.name} that writes ${tb.name}: what the cursor sees of it is not measured`);
  return {s: "select_loop", table: tb.name, cols, assign, target, sql: lowered.sql, ...loweredArgs(lowered, acc), body};
}

// Clause checks must inspect the parsed SELECT, not its source text: a WHERE
// string can contain any of these keywords without adding a SQL clause.
function selectShape(sel) {
  return sel.getChildren().map((child) => {
    if (isTok(child)) return tokenStr(child);
    if (isExpr(child, Expressions.SQLIntoTable)) return isTok(child.getFirstChild(), "APPENDING") ? "APPENDING TABLE" : "INTO TABLE";
    if (isExpr(child, Expressions.SQLFrom)) return /\bJOIN\b/i.test(child.concatTokens()) ? "JOIN" : "FROM";
    if (isExpr(child, Expressions.SQLSetOp)) return "UNION";
    if (isExpr(child, Expressions.SQLOptions)) return child.concatTokens();
    const clauses = [
      [Expressions.SQLUpTo, "UP TO"], [Expressions.SQLGroupBy, "GROUP BY"],
      [Expressions.SQLOrderBy, "ORDER BY"], [Expressions.SQLForAllEntries, "FOR ALL"],
      [Expressions.SQLHaving, "HAVING"], [Expressions.SQLPackageSize, "PACKAGE"],
      [Expressions.SQLBypassingBuffer, "BYPASSING"], [Expressions.SQLClient, "CLIENT"],
      [Expressions.DatabaseConnection, "CONNECTION"], [Expressions.SQLOffset, "OFFSET"],
    ];
    return clauses.find(([kind]) => isExpr(child, kind))?.[1] ?? "";
  }).join(" ");
}

/**
 * SELECT fields FROM table INTO [CORRESPONDING FIELDS OF] TABLE itab
 * [WHERE ...] [ORDER BY f ...]: the form the gateway's DPCs use. sy-subrc 0
 * with rows, 4 without; sy-dbcnt the rows.
 */
function selectStatement(node, ctx, text) {
  const sel = node.findDirectExpression(Expressions.Select);
  if (sel && isDynamicSelect(sel)) return dynamicSelect(sel, ctx, text);
  if (sel && /^SELECT\s+SINGLE\b/i.test(text)) return selectSingle(sel, ctx, text);
  if (sel && /^SELECT\s+COUNT\s*\(\s*\*\s*\)\s+FROM\b/i.test(text)) return selectCount(sel, ctx, text);
  if (sel && /^SELECT\s+SUM\s*\(/i.test(text) && !sel.findDirectExpression(Expressions.SQLGroupBy)) return selectSum(sel, ctx, text);
  if (!sel || /\b(SINGLE|DISTINCT|HAVING|JOIN|PACKAGE|BYPASSING|CLIENT|UNION)\b/i.test(selectShape(sel))) throw new Unsupported(`SELECT form: ${text}`);
  // parity-wave1: SELECT ... FOR ALL ENTRIES IN itab WHERE ... itab-comp ...
  // (A4H ZCL_GOGEN_T_FAE): the statement once per driving row, the rows
  // made unique over the columns selected (sy-dbcnt counts them), and an
  // empty driving table ignores the whole WHERE, the client aside. With
  // GROUP BY, aggregates or ORDER BY it is refused (not measured)
  const faeNode = sel.findFirstExpression(Expressions.SQLForAllEntries);
  let fae = null;
  if (faeNode) {
    const drvSrc = faeNode.findDirectExpression(Expressions.SQLSource);
    const drv = drvSrc ? sqlHost(drvSrc, [], ctx, text) : null;
    if (!drv || drv.type.k !== "table" || drv.type.row.k !== "struct") throw new Unsupported(`FOR ALL ENTRIES IN a ${drv?.type.k === "table" ? `table of ${drv.type.row.k}` : drv?.type.k ?? "?"}: ${text}`);
    if (sel.findDirectExpression(Expressions.SQLGroupBy) || sel.findFirstExpression(Expressions.SQLAggregation) || sel.findDirectExpression(Expressions.SQLOrderBy)) {
      throw new Unsupported(`FOR ALL ENTRIES with GROUP BY, an aggregate or ORDER BY: not measured: ${text}`);
    }
    const n = PERSIST_LOWERING ? ++ctx.program.faeN : ++FAE_N;
    fae = {name: upper(drvSrc.concatTokens().replace(/^@/, "")), row: drv.type.row, n, table: drv};
  }
  const tb = selectTable(sel, ctx, text);
  const scalarAggregate = /^SELECT\s+(MAX|MIN|SUM)\s*\(\s*(\w+)\s*\)/i.exec(text);
  if (scalarAggregate && !sel.findDirectExpression(Expressions.SQLGroupBy)) {
    const fn = upper(scalarAggregate[1]);
    const field = upper(scalarAggregate[2]);
    const col = {name: `${fn}_${field}`, type: tb.colType(field), agg: {fn, col: field}};
    return selectAggregateScalar(sel, ctx, text, tb, col);
  }
  // ultra/itab: aggregates and GROUP BY (groupedColumns below)
  const grouped = sel.findDirectExpression(Expressions.SQLGroupBy) !== undefined && sel.findDirectExpression(Expressions.SQLGroupBy) !== null;
  const cols = grouped || sel.findFirstExpression(Expressions.SQLAggregation) ? groupedColumns(sel, tb, text) : selectColumns(sel, tb, text);
  const into = sel.findDirectExpression(Expressions.SQLIntoTable);
  if (!into && cols.length === 1 && cols[0].agg && !grouped) return selectAggregateScalar(sel, ctx, text, tb, cols[0]);
  if (!into) throw new Unsupported(`SELECT INTO form (only INTO [CORRESPONDING FIELDS OF] TABLE): ${text}`);
  const inline = /@DATA\s*\(\s*(\w+)\s*\)/i.exec(into.concatTokens());
  if (inline) {
    const name = upper(inline[1]);
    const go = goName(`${ctx.className}=>${ctx.method}~${name}`);
    const row = {k: "struct", go};
    ctx.program.structs.set(go, {...row, fields: cols.map((c) => ({name: c.name, type: c.type}))});
    ctx.locals.set(name, {k: "table", row});
  }
  const corresponding = /\bCORRESPONDING\s+FIELDS\b/i.test(into.concatTokens());
  // ultra/itab (critic fix): an aggregate without AS has no name of its
  // own (COUNT_STAR / MAX_ID are ours), so INTO CORRESPONDING FIELDS would
  // drop it silently; what ABAP does there is not measured. By position it
  // was measured (ZCL_GOGEN_T_GRPBY) and stays.
  if (corresponding && cols.some((c) => c.agg && !c.named)) throw new Unsupported(`SELECT aggregate without AS INTO CORRESPONDING FIELDS: not measured: ${text}`);
  const target = lvalue(into.findFirstExpression(Expressions.Target), ctx);
  if (target.type.k !== "table") throw new Unsupported(`SELECT INTO TABLE of a ${target.type.k}`);
  const elementary = target.type.row.k !== "struct";
  if (elementary && (corresponding || cols.length !== 1 || !["c", "string", "i"].includes(target.type.row.k))) throw new Unsupported(`SELECT INTO TABLE of ${target.type.row.k} rows: ${text}`);
  const rowFields = new Map((ctx.program.structs.get(target.type.row.go)?.fields ?? []).map((f) => [String(f.name).toUpperCase(), f]));
  const rowOrder = ctx.program.structs.get(target.type.row.go)?.fields ?? [];
  // where each column goes: by name for CORRESPONDING, else by position
  const assign = elementary ? [{line: true, type: target.type.row}] : cols.map((c, i) => {
    const f = corresponding ? rowFields.get(c.name) : rowOrder[i];
    if (!f) return null;
    // a DEC column into a p field, rounded to the field (abap.DBP)
    if ((c.type.k === "p") !== (f.type.k === "p")) throw new Unsupported(`SELECT: column ${c.name} (${c.type.k}) into ${f.name} (${f.type.k})`);
    if (c.type.k === "p") return {field: f.name, type: f.type};
    // a RAW(n) column into an x (cut or 00-padded) or an xstring (n bytes),
    // a RAWSTRING into an xstring (ultra/zvdb, A4H ZCL_GOGEN_T_RAWRD)
    if (c.type.k === "x" || c.type.k === "xstring" || f.type.k === "x" || f.type.k === "xstring") {
      if (f.type.k === "xstring" || (c.type.k === "x" && f.type.k === "x")) return {field: f.name, type: f.type};
      throw new Unsupported(`SELECT: column ${c.name} (${c.type.k}) into ${f.name} (${f.type.k})`);
    }
    // a NUMC column into an n field of its length: its digits (ultra/demodata)
    if (c.type.k === "n" && f.type.k === "n" && c.type.len === f.type.len) return {field: f.name, type: f.type};
    if (!["c", "string", "i", "d", "t", "n"].includes(c.type.k) || !["c", "string", "i", "d", "t"].includes(f.type.k)) throw new Unsupported(`SELECT: column ${c.name} (${c.type.k}) into ${f.name} (${f.type.k})`);
    if ((c.type.k === "i") !== (f.type.k === "i")) throw new Unsupported(`SELECT: column ${c.name} (${c.type.k}) into ${f.name} (${f.type.k})`);
    return {field: f.name, type: f.type};
  });
  const acc = {hosts: [], ranges: []};
  const pred = (() => {
    const saved = ctx.fae;
    ctx.fae = fae ?? undefined;
    try { return wherePred(sel, ctx, tb, acc); } finally { ctx.fae = saved; }
  })();
  const order = orderByOf(sel, tb);
  let rel = RIR.scan(lowName(tb.name));
  if (pred !== null) rel = RIR.filter(rel, pred);
  if (cols.grouped) {
    // GROUP BY keys and aggregates, then a projection back into the order of
    // the field list: the rows are scanned by position
    const aggs = cols.filter((c) => c.agg).map((c) => ({as: lowName(c.name), expr: c.agg.star
      ? {...RIR.call("COUNT", [], RIR.T.int), star: true} : RIR.call(c.agg.fn, [RIR.col(lowName(c.agg.col), sqlIrType(c.type))], sqlIrType(c.type))}));
    rel = RIR.aggregate(rel, cols.groupBy.map(lowName), aggs);
    rel = RIR.project(rel, cols.map((c) => ({as: lowName(c.name), expr: RIR.col(lowName(c.name), sqlIrType(c.type))})));
  } else {
    rel = RIR.project(rel, cols.map((c) => ({as: lowName(c.name), expr: RIR.col(lowName(c.name), sqlIrType(c.type))})));
  }
  if (order.length > 0) rel = RIR.order(rel, order.map((o) => ({col: lowName(o.col), desc: o.desc})));
  const up = sel.findDirectExpression(Expressions.SQLUpTo);
  if (up) {
    const src = up.findDirectExpression(Expressions.SQLSource);
    if (!src) throw new Unsupported(`UP TO form: ${text}`);
    const count = sqlHost(src, [], ctx, text);
    if (count.type.k !== "i") throw new Unsupported(`UP TO a ${count.type.k} value: ${text}`);
    if (count.e === "int") rel = RIR.limit(rel, count.value);
    else {
      acc.hosts.push(count);
      rel = RIR.limit(rel, RIR.param(`@@host:${acc.hosts.length - 1}@@`, RIR.T.int));
    }
  }
  const lowered = lowerOrRefuse("SELECT", rel);
  const appending = isTok(into.getFirstChild(), "APPENDING");
  if (fae) {
    // The empty-driver query below is the bare column list, and the driver
    // path replaces the target: a FOR ALL ENTRIES that also appends, limits
    // or orders would lose rows or return too many, so it is refused.
    if (appending || up || order.length > 0) {
      throw new Unsupported(`FOR ALL ENTRIES with ${appending ? "APPENDING" : up ? "UP TO" : "ORDER BY"}: ${text}`);
    }
    // the same columns without the WHERE, for an empty driving table
    const accAll = {hosts: [], ranges: []};
    let relAll = RIR.scan(lowName(tb.name));
    if (tb.client) relAll = RIR.filter(relAll, mandtPred());
    relAll = RIR.project(relAll, cols.map((c) => ({as: lowName(c.name), expr: RIR.col(lowName(c.name), sqlIrType(c.type))})));
    const all = lowerOrRefuse("SELECT", relAll);
    return {s: "select_table", table: tb.name, cols, assign, target, sql: lowered.sql, ...loweredArgs(lowered, acc),
      fae: {n: fae.n, table: fae.table, sql: all.sql, ...loweredArgs(all, accAll)}};
  }
  return {s: "select_table", table: tb.name, cols, assign, target, appending, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}
function selectAggregateScalar(sel, ctx, text, tb, col) {
  const {assign, target} = intoWorkArea(sel, ctx, text, [col], "SELECT aggregate");
  const acc = {hosts: [], ranges: []};
  let rel = RIR.scan(lowName(tb.name));
  const pred = wherePred(sel, ctx, tb, acc);
  if (pred !== null) rel = RIR.filter(rel, pred);
  const agg = col.agg.star ? {...RIR.call("COUNT", [], RIR.T.int), star: true}
    : RIR.call(col.agg.fn, [RIR.col(lowName(col.agg.col), sqlIrType(col.type))], sqlIrType(col.type));
  rel = RIR.aggregate(rel, [], [{as: lowName(col.name), expr: agg}]);
  const lowered = lowerOrRefuse("SELECT", rel);
  return {s: "select_aggregate", table: tb.name, cols: [col], assign, target, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}
let FAE_N = 0;

/** a SELECT with a part given at run time: FROM (name), a field list,
 * WHERE, GROUP BY or ORDER BY in parentheses */
function isDynamicSelect(sel) {
  const dyn = (n) => n?.findDirectExpression(Expressions.Dynamic) !== undefined && n?.findDirectExpression(Expressions.Dynamic) !== null;
  const tables = sel.findDirectExpression(Expressions.SQLFrom)?.findAllExpressions(Expressions.DatabaseTable) ?? [];
  const cond = sel.findDirectExpression(Expressions.SQLCond);
  return tables.some(dyn) || dyn(sel.findDirectExpression(Expressions.SQLFieldList))
    || (cond !== undefined && cond !== null && cond.findFirstExpression(Expressions.Dynamic) !== undefined && cond.findFirstExpression(Expressions.Dynamic) !== null)
    || dyn(sel.findDirectExpression(Expressions.SQLGroupBy)) || dyn(sel.findDirectExpression(Expressions.SQLOrderBy));
}

/** the operand of a dynamic token, (x): a string or c (one line of tokens)
 * or a table of them (the lines, one after the other) */
function dynamicTokens(dyn, ctx, what, text) {
  const fc = dyn.findFirstExpression(Expressions.FieldChain);
  if (!fc || dyn.getChildren().length !== 3) throw new Unsupported(`dynamic ${what}: ${text}`);
  const v = fieldChain(fc, ctx);
  if (["string", "c"].includes(v.type.k)) return v;
  if (v.type.k === "table" && ["string", "c"].includes(v.type.row.k)) return v;
  throw new Unsupported(`dynamic ${what} of a ${v.type.k === "table" ? `table of ${v.type.row.k}` : v.type.k}: ${text}`);
}

/**
 * Dynamic Open SQL: SELECT [*|(fields)|f ...] FROM <table>|(name) INTO
 * [CORRESPONDING FIELDS OF] TABLE <itab> [WHERE (cond)] [GROUP BY (g)]
 * [ORDER BY (o) | PRIMARY KEY | f ...], the form OSG's generated readers
 * (gen/cds zcl_stg_tab_* / zcl_stg_cds_*) and open-abap-odata's search-help
 * reader use. Nothing of it is known here but the shape: the runtime
 * (go/abap selectdyn.go) resolves the table in the registry, parses the
 * condition with the port of tools/ir-osql-where.mjs, adds the client and
 * fills the table through its descriptor.
 */
function dynamicSelect(sel, ctx, text) {
  if (/^SELECT\s+SINGLE\b/i.test(text)) throw new Unsupported(`dynamic SELECT SINGLE: ${text}`);
  if (/\b(UP\s+TO|DISTINCT|HAVING|JOIN|FOR\s+ALL|APPENDING|PACKAGE|BYPASSING|CLIENT|UNION|CONNECTION|OFFSET)\b/i.test(selectShape(sel))) throw new Unsupported(`dynamic SELECT form: ${text}`);
  const from = sel.findDirectExpression(Expressions.SQLFrom)?.findAllExpressions(Expressions.DatabaseTable) ?? [];
  if (from.length !== 1) throw new Unsupported(`dynamic SELECT FROM form: ${text}`);
  let table;
  const tdyn = from[0].findDirectExpression(Expressions.Dynamic);
  if (tdyn) {
    const v = dynamicTokens(tdyn, ctx, "FROM", text);
    if (v.type.k === "table") throw new Unsupported(`FROM of a table of names: ${text}`);
    table = convert(v, S);
  } else {
    const name = upper(from[0].concatTokens());
    // a table or view of the dictionary, and not a view that hides the
    // client (refused here as a static read is; by name it is refused when
    // it arrives)
    dbTable(ctx, name, "SELECT FROM");
    table = {e: "str", value: name, type: S};
  }
  // the field list: * (null), (x), or plain column names
  const fl = sel.findDirectExpression(Expressions.SQLFieldList);
  let fields = null;
  const fdyn = fl?.findDirectExpression(Expressions.Dynamic);
  if (fdyn) fields = dynamicTokens(fdyn, ctx, "field list", text);
  else if (!/^\s*\*\s*$/.test(fl?.concatTokens() ?? "")) {
    const names = (fl?.findAllExpressions(Expressions.SQLField) ?? []).map((f) => {
      const n = f.findDirectExpression(Expressions.SQLFieldName);
      if (!n || f.getChildren().length !== 1) throw new Unsupported(`SELECT field ${f.concatTokens()}`);
      return upper(n.concatTokens());
    });
    if (names.length === 0) throw new Unsupported(`SELECT field list: ${text}`);
    fields = {e: "strlist", values: names};
  }
  // WHERE (x) alone: a static condition over a table named at run time has
  // no columns to be typed against here
  const cond = sel.findDirectExpression(Expressions.SQLCond);
  let where = null;
  if (cond) {
    const kids = cond.getChildren();
    const cmp = kids.length === 1 && isExpr(kids[0], Expressions.SQLCompare) ? kids[0] : undefined;
    const wdyn = cmp && cmp.getChildren().length === 1 && isExpr(cmp.getFirstChild(), Expressions.Dynamic) ? cmp.getFirstChild() : undefined;
    if (!wdyn) throw new Unsupported(`a WHERE that is not one (condition) in a dynamic SELECT: ${text}`);
    where = dynamicTokens(wdyn, ctx, "WHERE", text);
    if (where.type.k === "table") throw new Unsupported(`WHERE of a table of lines (how the lines join is not measured): ${text}`);
    where = convert(where, S);
  }
  const listOf = (node, what) => {
    if (!node) return null;
    const d = node.findDirectExpression(Expressions.Dynamic);
    if (d) return dynamicTokens(d, ctx, what, text);
    const kids = node.getChildren().filter((c) => !isTok(c, "ORDER") && !isTok(c, "GROUP") && !isTok(c, "BY") && !isTok(c, ","));
    const out = [];
    for (const k of kids) {
      if (isTok(k, "ASCENDING") || isTok(k, "DESCENDING")) { out.push(upper(k.concatTokens())); continue; }
      if (!isExpr(k, Expressions.SQLField) && !isExpr(k, Expressions.SQLFieldName)) throw new Unsupported(`${what} form: ${node.concatTokens()}`);
      out.push(upper(k.concatTokens()));
    }
    return {e: "strlist", values: out};
  };
  const groupBy = listOf(sel.findDirectExpression(Expressions.SQLGroupBy), "GROUP BY");
  const ob = sel.findDirectExpression(Expressions.SQLOrderBy);
  const primaryKey = ob !== undefined && ob !== null && /^ORDER\s+BY\s+PRIMARY\s+KEY$/i.test(ob.concatTokens());
  const orderBy = primaryKey ? null : listOf(ob, "ORDER BY");
  const into = sel.findDirectExpression(Expressions.SQLIntoTable);
  if (!into) throw new Unsupported(`dynamic SELECT INTO form (only INTO [CORRESPONDING FIELDS OF] TABLE): ${text}`);
  const corresponding = /\bCORRESPONDING\s+FIELDS\b/i.test(into.concatTokens());
  let target = lvalue(into.findFirstExpression(Expressions.Target), ctx);
  if (target.type.k === "table") target = convert(target, {k: "data", table: true});
  else if (target.type.k !== "data") throw new Unsupported(`dynamic SELECT INTO TABLE of a ${target.type.k}`);
  refuseSorted(target, "SELECT INTO TABLE");
  return {s: "select_dyn", table, fields, where, groupBy, orderBy, primaryKey, corresponding, target, text: text.replace(/\s+/g, " ")};
}

/**
 * SELECT COUNT(*) FROM table INTO n [WHERE ...]: the count into n, sy-dbcnt
 * the count (A4H, ANORMALIES select-count-dbcnt), sy-subrc 4 when it is 0.
 */
function selectCount(sel, ctx, text) {
  if (/\b(SINGLE|UP\s+TO|DISTINCT|GROUP|HAVING|JOIN|FOR\s+ALL|APPENDING|PACKAGE|BYPASSING|CLIENT|UNION|ORDER\s+BY|TABLE)\b/i.test(selectShape(sel))) throw new Unsupported(`SELECT COUNT form: ${text}`);
  const fl = sel.findDirectExpression(Expressions.SQLFieldList);
  if (!/^COUNT\s*\(\s*\*\s*\)$/i.test(fl?.concatTokens() ?? "")) throw new Unsupported(`SELECT COUNT form: ${text}`);
  const tb = selectTable(sel, ctx, text);
  const into = sel.findDirectExpression(Expressions.SQLIntoStructure);
  const tnode = into?.findDirectExpression(Expressions.SQLTarget)?.findDirectExpression(Expressions.Target);
  if (!into || !tnode || into.findDirectExpressions(Expressions.SQLTarget).length !== 1) throw new Unsupported(`SELECT COUNT INTO form: ${text}`);
  const target = lvalue(tnode, ctx);
  if (target.type.k !== "i") throw new Unsupported(`SELECT COUNT INTO a ${target.type.k}: ${text}`);
  const acc = {hosts: [], ranges: []};
  const pred = wherePred(sel, ctx, tb, acc);
  let rel = RIR.scan(lowName(tb.name));
  if (pred !== null) rel = RIR.filter(rel, pred);
  rel = RIR.aggregate(rel, [], [{as: "n", expr: {...RIR.call("COUNT", [], RIR.T.int), star: true}}]);
  const lowered = lowerOrRefuse("SELECT COUNT", rel);
  return {s: "select_count", table: tb.name, target, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}

/** Narrow scalar SUM of an i column, into an i field. */
function selectSum(sel, ctx, text) {
  if (/\b(SINGLE|UP\s+TO|DISTINCT|GROUP|HAVING|JOIN|FOR\s+ALL|APPENDING|PACKAGE|BYPASSING|CLIENT|UNION|ORDER\s+BY|TABLE)\b/i.test(selectShape(sel))) throw new Unsupported(`SELECT SUM form: ${text}`);
  const fl = sel.findDirectExpression(Expressions.SQLFieldList);
  const field = /^SUM\s*\(\s*([\w]+)\s*\)$/i.exec(fl?.concatTokens() ?? "")?.[1];
  if (!field) throw new Unsupported(`SELECT SUM form: ${text}`);
  const tb = selectTable(sel, ctx, text);
  if (tb.colType(upper(field)).k !== "i") throw new Unsupported(`SELECT SUM of a non-i column: ${text}`);
  const into = sel.findDirectExpression(Expressions.SQLIntoStructure);
  const tnode = into?.findDirectExpression(Expressions.SQLTarget)?.findDirectExpression(Expressions.Target);
  if (!tnode || into.findDirectExpressions(Expressions.SQLTarget).length !== 1) throw new Unsupported(`SELECT SUM INTO form: ${text}`);
  const target = lvalue(tnode, ctx);
  if (target.type.k !== "i") throw new Unsupported(`SELECT SUM INTO a ${target.type.k}: ${text}`);
  const acc = {hosts: [], ranges: []};
  const pred = wherePred(sel, ctx, tb, acc);
  let rel = RIR.scan(lowName(tb.name));
  if (pred !== null) rel = RIR.filter(rel, pred);
  rel = RIR.aggregate(rel, [], [{as: "n", expr: RIR.call("SUM", [RIR.col(lowName(field), RIR.T.int)], RIR.T.int)}]);
  const lowered = lowerOrRefuse("SELECT SUM", rel);
  return {s: "select_sum", table: tb.name, target, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}

/**
 * COMMIT WORK [AND WAIT] / ROLLBACK WORK: the database LUW of the host
 * (go/abap/luw.go). sy-subrc 0, sy-dbcnt untouched (A4H). Nothing else is
 * registered for a COMMIT to run: PERFORM ON COMMIT and CALL FUNCTION IN
 * UPDATE TASK do not compile. COMMIT/ROLLBACK CONNECTION is another
 * database connection, which the host does not have.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function luwStatement(node, text) {
  if (!/^(COMMIT\s+WORK(\s+AND\s+WAIT)?|ROLLBACK\s+WORK)\s*\.?$/i.test(text)) throw new Unsupported(`LUW form: ${text}`);
  return {s: isStmt(node, Statements.Commit) ? "commit_work" : "rollback_work"};
}

/**
 * INSERT / UPDATE / MODIFY / DELETE on a database table, through the write
 * nodes of the relational IR (tools/ir-writes.mjs). What each does was
 * measured on A4H (testdata/zcl_gogen_t_dbw, ANORMALIES dbwrite-*):
 *   INSERT FROM wa         sy-subrc 4 and nothing written for a duplicate key
 *   INSERT FROM TABLE      every row without a duplicate written, then
 *                          CX_SY_OPEN_SQL_DB with sy untouched ("raise")
 *   ... ACCEPTING DUPLICATE KEYS  sy-subrc 4, sy-dbcnt the rows written
 *   UPDATE / DELETE FROM wa / TABLE   by the primary key, one row at a time,
 *                          the counts summed, sy-subrc 4 when a row is missing
 *   UPDATE SET / DELETE WHERE   sy-subrc 4 when no row, sy-dbcnt the rows
 *   MODIFY                 insert or update, sy-subrc 0
 * MANDT is the logon client whatever the work area holds.
 */
function dbWriteStatement(kind, node, ctx, text) {
  const verb = text.split(/\s+/)[0].toUpperCase();
  const name = upper((node.findFirstExpression(Expressions.DatabaseTable) ?? node.findFirstExpression(Expressions.Target))?.concatTokens() ?? "");
  if (/\b(CLIENT|CONNECTION|USING)\b/i.test(text)) throw new Unsupported(`${verb} form: ${text}`);
  // a name that is a variable is the internal table's, as ABAP resolves it
  if (isVariableName(name, ctx)) throw new Unsupported(`${verb} ${name}: an internal table named like a table of the dictionary`);
  const tb = dbTable(ctx, name, verb);
  if (kind === "update" && isStmt(node, Statements.UpdateDatabase) && /^UPDATE\s+\S+\s+SET\b/i.test(text)) return updateSet(node, ctx, tb, text);
  if (kind === "delete" && /^DELETE\s+FROM\b/i.test(text)) return deleteWhere(node, ctx, tb, text);
  return writeRows(kind, node, ctx, tb, text, verb);
}

/** UPDATE dbtab SET col = value ... [WHERE ...], lowered here */
function updateSet(node, ctx, tb, text) {
  const acc = {hosts: [], ranges: []};
  const set = [];
  const kids = node.getChildren();
  const at = kids.findIndex((k) => isTok(k, "SET"));
  for (let i = at + 1; i < kids.length && !isTok(kids[i], "WHERE") && !isTok(kids[i], "."); i += 1) {
    const k = kids[i];
    if (isTok(k, ",")) continue;
    if (!isExpr(k, Expressions.SQLFieldAndValue)) throw new Unsupported(`UPDATE SET form: ${text}`);
    const fk = k.getChildren();
    const src = k.findDirectExpression(Expressions.SQLSource);
    if (!isExpr(fk[0], Expressions.SQLFieldName) || !isTok(fk[1], "=") || fk[2] !== src) throw new Unsupported(`UPDATE SET form: ${k.concatTokens()}`);
    const col = upper(fk[0].concatTokens());
    if (tb.client && col === "MANDT") throw new Unsupported(`UPDATE SET of the client column: ${text}`);
    const ct = tb.colType(col);
    const ir = writeIrType(ct, `UPDATE ${tb.name}-${col}`);
    set.push({col, expr: sqlValue(sqlHost(src, fk.slice(3), ctx, k.concatTokens()), ct, ir, acc, true)});
  }
  if (set.length === 0) throw new Unsupported(`UPDATE SET form: ${text}`);
  const pred = wherePred(node, ctx, tb, acc);
  let stmt;
  try { stmt = WIR.update(tb.name, set, pred ?? undefined); } catch (e) { throw new Unsupported(`UPDATE ${tb.name}: ${e.message}`); }
  const lowered = lowerOrRefuse(`UPDATE ${tb.name}`, stmt);
  return {s: "db_write_sql", verb: "UPDATE", table: tb.name, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}

/** DELETE FROM dbtab [WHERE ...], lowered here */
function deleteWhere(node, ctx, tb, text) {
  if (!isStmt(node, Statements.DeleteDatabase)) throw new Unsupported(`DELETE form: ${text}`);
  const acc = {hosts: [], ranges: []};
  const pred = wherePred(node, ctx, tb, acc);
  const lowered = lowerOrRefuse(`DELETE ${tb.name}`, WIR.remove(tb.name, pred ?? undefined));
  return {s: "db_write_sql", verb: "DELETE", table: tb.name, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}

/** INSERT / UPDATE / MODIFY / DELETE dbtab FROM wa | FROM TABLE itab, INSERT INTO dbtab VALUES wa */
function writeRows(kind, node, ctx, tb, text, verb) {
  const fromTable = /\bFROM\s+TABLE\b/i.test(text);
  const accepting = /\bACCEPTING\s+DUPLICATE\s+KEYS\b/i.test(text);
  if (accepting && (kind !== "insert" || !fromTable)) throw new Unsupported(`${verb} form: ${text}`);
  let value;
  if (isStmt(node, Statements.DeleteInternal)) {
    const src = node.findDirectExpression(Expressions.Source);
    if (!src || !/^DELETE\s+\S+\s+FROM\s+[^\s.]+\s*\.?$/i.test(text)) throw new Unsupported(`DELETE form: ${text}`);
    value = source(src, ctx);
  } else {
    const src = node.findDirectExpression(Expressions.SQLSource) ?? node.findDirectExpression(Expressions.SQLSourceSimple);
    const ok = kind === "insert" ? /^INSERT\s+(INTO\s+\S+\s+VALUES|\S+\s+FROM(\s+TABLE)?)\s+\S+(\s+ACCEPTING\s+DUPLICATE\s+KEYS)?\s*\.?$/i
      : new RegExp(`^${verb}\\s+\\S+\\s+FROM(\\s+TABLE)?\\s+\\S+\\s*\\.?$`, "i");
    if (!src || !ok.test(text)) throw new Unsupported(`${verb} form: ${text}`);
    value = sqlHost(src, [], ctx, text);
  }
  const row = fromTable ? (value.type.k === "table" ? value.type.row : null) : value.type;
  if (row === null) throw new Unsupported(`${verb} ... FROM TABLE of a ${value.type.k}`);
  if (row.k !== "struct") throw new Unsupported(`${verb} ${tb.name} FROM a ${row.k}: a work area of the table's line type is needed`);
  // the work area has the table's columns, in order, of the same kind and
  // length: a move by name and by layout are then the same
  const fields = ctx.program.structs.get(row.go)?.fields ?? [];
  const names = [...tb.columns.keys()];
  if (fields.length !== names.length || names.some((n, i) => {
    const ct = tb.colType(n);
    const f = fields[i];
    return f.name !== n || f.type.k !== ct.k || (f.type.len ?? null) !== (ct.len ?? null);
  })) throw new Unsupported(`${verb} ${tb.name}: a work area not of the table's line type (${row.go})`);
  const cols = names.map((n) => {
    const ct = tb.colType(n);
    return {name: n, kind: ct.k, ir: writeIrType(ct, `${verb} ${tb.name}-${n}`), client: tb.client && n === "MANDT"};
  });
  if (tb.key.length === 0 || tb.key.some((k) => !tb.columns.has(k))) throw new Unsupported(`${verb} ${tb.name}: its primary key does not resolve`);
  const schema = Object.fromEntries(cols.map((c) => [c.name, irCheck(c.ir)]));
  const rows = WIR.bindRows(names, schema, [{}]);
  const keyPred = cols.filter((c) => tb.key.includes(c.name)).map((c) => RIR.bin("=", RIR.col(c.name, irCheck(c.ir)), WIR.initialValue(irCheck(c.ir)), RIR.T.bool))
    .reduce((a, b) => RIR.bin("AND", a, b, RIR.T.bool));
  const rest = cols.filter((c) => !tb.key.includes(c.name));
  const op = kind === "merge" ? "modify" : kind;
  if (op === "modify" && rest.length === 0) throw new Unsupported(`MODIFY ${tb.name}: every column is a key column, and what sy-dbcnt says for an existing row is not measured`);
  // the statement as the IR has it, lowered once here so that what the IR
  // refuses is refused at build time; the Go runtime renders the same
  // shape with the rows it is given (go/abap/irsql.go, writes.json)
  const onDuplicate = op !== "insert" ? undefined : accepting ? "ignore" : fromTable ? "raise" : "error";
  try {
    const stmt = op === "insert" ? WIR.insertRows(tb.name, names, rows, {onDuplicate})
      : op === "update" ? WIR.update(tb.name, rest.map((c) => ({col: c.name, expr: WIR.initialValue(irCheck(c.ir))})), keyPred)
        : op === "delete" ? WIR.remove(tb.name, keyPred)
          : WIR.upsert(tb.name, names, rows, tb.key);
    lowerRelation(stmt, "sqlite");
  } catch (e) {
    throw new Unsupported(`${verb} ${tb.name}: the relational IR refused it: ${e.message}`);
  }
  return {s: "db_write", op, table: tb.name, value, fromTable, onDuplicate, cols, key: tb.key};
}

/**
 * The INTO of SELECT SINGLE and of a SELECT loop: one work area, or one
 * elementary field for one column. Only the fields the columns go to are
 * written (by name with CORRESPONDING, else by position).
 */
function intoWorkArea(sel, ctx, text, cols, verb) {
  const into = sel.findDirectExpression(Expressions.SQLIntoStructure) ?? sel.findDirectExpression(Expressions.SQLIntoList);
  const targets = into?.findDirectExpressions(Expressions.SQLTarget) ?? [];
  const tnode = targets[0]?.findDirectExpression(Expressions.Target);
  // a raw column (RAWSTRING) holds its bytes as hex text, the transpiler's
  // storage: it goes into an xstring field only; a RAW(n) column into an x
  // (cut or 00-padded) or an xstring (its n bytes) (ultra/zvdb, A4H
  // ZCL_GOGEN_T_RAWRD)
  const okCol = (c, f) => (c.type.k === "xstring" && f.type.k === "xstring") || (c.type.k === "p" && f.type.k === "p")
    || (c.type.k === "x" && (f.type.k === "x" || f.type.k === "xstring"))
    || (["c", "string", "i", "d", "t", "n"].includes(c.type.k) && ["c", "string", "i", "d", "t"].includes(f.type.k) && (c.type.k === "i") === (f.type.k === "i"))
    // a NUMC column into an n field of its length (ultra/demodata)
    || (c.type.k === "n" && f.type.k === "n" && c.type.len === f.type.len);
  // INTO (a, b, ...) / INTO (@a, @DATA(b), ...): one target per column, by
  // position (ultra/zvdb, A4H ZCL_GOGEN_T_RAWSEL: a row missing leaves the
  // targets as they were, sy-subrc 4; @DATA( ) is typed as its column)
  if (into && targets.length > 1) {
    if (/\bCORRESPONDING\b/i.test(into.concatTokens()) || targets.length !== cols.length) throw new Unsupported(`${verb} INTO list form: ${text}`);
    const places = targets.map((t) => {
      const tn = t.findDirectExpression(Expressions.Target);
      if (!tn) throw new Unsupported(`${verb} INTO list form: ${text}`);
      return lvalue(tn, ctx);
    });
    places.forEach((p, i) => {
      if (!okCol(cols[i], p) || ["struct", "table"].includes(p.type.k)) throw new Unsupported(`SELECT: column ${cols[i].name} (${cols[i].type.k}) into a ${p.type.k}`);
    });
    return {assign: places.map((p) => ({place: p, type: p.type})), target: null};
  }
  if (!into || !tnode || targets.length !== 1) throw new Unsupported(`${verb} INTO form: ${text}`);
  const corresponding = /\bCORRESPONDING\s+FIELDS\b/i.test(into.concatTokens());
  const target = lvalue(tnode, ctx);
  let assign;
  if (target.type.k === "struct") {
    const fields = ctx.program.structs.get(target.type.go)?.fields ?? [];
    const byName = new Map(fields.map((f) => [String(f.name).toUpperCase(), f]));
    assign = cols.map((c, i) => {
      const f = corresponding ? byName.get(c.name) : fields[i];
      if (!f && !corresponding) throw new Unsupported(`SELECT without CORRESPONDING: more columns than ${target.type.go} has fields`);
      if (!f) return null;
      if (!okCol(c, f)) throw new Unsupported(`SELECT: column ${c.name} (${c.type.k}) into ${f.name} (${f.type.k})`);
      // by position the move is by flat layout on a system: equal only while
      // each column has its field's type and length
      if (!corresponding && (c.type.k !== f.type.k || (c.type.len ?? null) !== (f.type.len ?? null) || (c.type.dec ?? null) !== (f.type.dec ?? null))) {
        throw new Unsupported(`SELECT without CORRESPONDING: column ${c.name} (${c.type.k}${c.type.len ?? ""}) into ${f.name} (${f.type.k}${f.type.len ?? ""}) is a layout move`);
      }
      return {field: f.name, type: f.type};
    });
  } else {
    if (corresponding || cols.length !== 1 || !okCol(cols[0], target)) throw new Unsupported(`${verb} INTO a ${target.type.k}: ${text}`);
    assign = [{line: true, type: target.type}];
  }
  return {assign, target};
}

/**
 * SELECT SINGLE fields FROM table INTO [CORRESPONDING FIELDS OF] wa
 * [WHERE ...]. Measured on A4H (2026-09-23): without a row, sy-subrc is 4
 * and the target keeps what it had; with one, only the fields the columns
 * go to are written (by name with CORRESPONDING, else by position), the
 * others keep theirs. A host value is converted to the column's type and
 * bound; MANDT is the logon client, as for a table.
 */
function selectSingle(sel, ctx, text) {
  if (/\b(UP\s+TO|DISTINCT|GROUP|HAVING|JOIN|FOR\s+ALL|APPENDING|PACKAGE|BYPASSING|CLIENT|UNION|ORDER\s+BY|FOR\s+UPDATE)\b/i.test(selectShape(sel))) throw new Unsupported(`SELECT form: ${text}`);
  const tb = selectTable(sel, ctx, text);
  const cols = selectColumns(sel, tb, text);
  const {assign, target} = intoWorkArea(sel, ctx, text, cols, "SELECT SINGLE");
  const acc = {hosts: [], ranges: []};
  const pred = wherePred(sel, ctx, tb, acc);
  let rel = RIR.scan(lowName(tb.name));
  if (pred !== null) rel = RIR.filter(rel, pred);
  rel = RIR.project(rel, cols.map((c) => ({as: lowName(c.name), expr: RIR.col(lowName(c.name), sqlIrType(c.type))})));
  rel = RIR.limit(rel, 1);
  const lowered = lowerOrRefuse("SELECT", rel);
  return {s: "select_single", table: tb.name, cols, assign, target, sql: lowered.sql, ...loweredArgs(lowered, acc)};
}

/**
 * ASSIGN into a generic field symbol: a component of a structure by name
 * (sy-subrc 4 when there is none), what a data reference points to
 * (sy-subrc 4 when it is initial; not measured), or a value, bound.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function assignStatement(node, ctx, text) {
  const fsName = upper(node.findDirectExpression(Expressions.FSTarget)?.concatTokens() ?? "");
  const fsType = ctx.fieldSymbols?.get(fsName);
  if (!fsType) throw new Unsupported(`ASSIGN to ${fsName || "?"}`);
  if (["struct", "table", "string", "c", "i", "n", "d", "t", "x", "xstring"].includes(fsType.k)
      && !/\b(CASTING|INCREMENT|RANGE|COMPONENT)\b/i.test(text)) {
    // ASSIGN ref->* TO <typed>: the reference must point at a value of that
    // structure; one of another Go type (an ABAP-compatible structure of
    // another name included) is refused at run time, not moved by layout
    const inner = node.findDirectExpression(Expressions.AssignSource)?.getChildren().filter((c) => !isTok(c));
    const kids = inner?.length === 1 && isExpr(inner[0], Expressions.Source) && inner[0].findDirectExpression(Expressions.Dereference) ? inner[0].getChildren() : null;
    if (kids?.length === 2) {
      const ref = sourceOperand(kids[0], ctx);
      if (ref.type.k !== "dref") throw new Unsupported(`->* of a ${ref.type.k}`);
      return {s: "assign_deref_typed", fs: {e: "fs", name: fsName, type: fsType}, ref, text};
    }
  }
  if (fsType.k !== "data") throw new Unsupported(`ASSIGN to a typed field symbol: ${text}`);
  if (/\b(CASTING|INCREMENT|RANGE)\b/i.test(text)) throw new Unsupported(`ASSIGN form: ${text}`);
  const fs = {e: "fs", name: fsName, type: fsType};
  const src = node.findDirectExpression(Expressions.AssignSource);
  const parts = src.getChildren().filter((c) => !isTok(c));
  if (/^ASSIGN\s+COMPONENT\b/i.test(text)) {
    if (parts.length !== 2) throw new Unsupported(`ASSIGN COMPONENT form: ${text}`);
    const name = sourceOperand(parts[0].getFirstChild(), ctx);
    if (!["string", "c", "i"].includes(name.type.k)) throw new Unsupported(`ASSIGN COMPONENT by a ${name.type.k}`);
    return {s: "assign_comp", fs, name: convert(name, name.type.k === "i" ? I : S), from: convert(source(parts[1], ctx), {k: "data"})};
  }
  if (parts.length !== 1 || !isExpr(parts[0], Expressions.Source)) throw new Unsupported(`ASSIGN form: ${text}`);
  const inner = parts[0];
  if (inner.findDirectExpression(Expressions.Dereference)) {
    const kids = inner.getChildren();
    if (kids.length !== 2) throw new Unsupported(`ASSIGN form: ${text}`);
    const ref = sourceOperand(kids[0], ctx);
    if (ref.type.k !== "dref") throw new Unsupported(`->* of a ${ref.type.k}`);
    return {s: "assign_deref", fs, ref};
  }
  return {s: "assign_data", fs, value: convert(source(inner, ctx), fsType)};
}

/**
 * CREATE DATA dref TYPE t | TYPE STANDARD TABLE OF t [WITH DEFAULT KEY], with
 * t a type known at build time (ultra/sadl: the generated CDS and table
 * sources of OSG's SADL runtime). The reference points at a new initial
 * value of that type. A type given by name at run time ((name)), LIKE, REF
 * TO, LENGTH / DECIMALS and HANDLE are other forms, not taken here.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function createDataStatic(node, ctx, text) {
  // CREATE DATA ref LIKE LINE OF itab (ultra/json, /UI2/CL_JSON): a new
  // initial row of the table's line type, a generic table's at run time
  const likeLine = /^CREATE\s+DATA\s+\S+\s+LIKE\s+LINE\s+OF\s+([\w\/~<>-]+)\s*\.?$/i.exec(text);
  if (likeLine) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "dref") throw new Unsupported(`CREATE DATA into a ${target.type.k}`);
    const tb = variable(likeLine[1], ctx);
    if (tb.type.k === "data" && tb.type.table) return {s: "create_data_line", target, table: tb};
    // LIKE LINE OF a TYPE data / any parameter does not activate on A4H
    // ("DATA is not an internal table", 2026-09-24) and abaplint takes it:
    // refused, but for the one method listed in TRANSPILER_MEANING
    if (tb.type.k === "data") {
      const allowed = TRANSPILER_MEANING.get(`${ctx.className}=>${ctx.method}`);
      if (allowed !== "CREATE DATA LIKE LINE OF generic data") throw new Unsupported(`CREATE DATA ... LIKE LINE OF ${likeLine[1]}: a generic operand that is not a table does not activate on A4H`);
      return {s: "create_data_line", target, table: tb};
    }
    if (tb.type.k === "table" && !["ref", "exc", "data", "dref"].includes(tb.type.row.k)) return {s: "create_data", target, type: tb.type.row};
    throw new Unsupported(`CREATE DATA LIKE LINE OF a ${tb.type.k}`);
  }
  // CREATE DATA ref. (ultra/json, CL_SXML_STRING_READER): a new value of the
  // type the reference is declared with (REF TO t)
  const bare = /^CREATE\s+DATA\s+([\w\/~]+)\s*\.?$/i.exec(text);
  if (bare) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "dref") throw new Unsupported(`CREATE DATA into a ${target.type.k}`);
    const declared = ctx.scope.findVariable?.(bare[1])?.getType();
    const inner = declared instanceof BasicTypes.DataReference ? declared.getType() : undefined;
    if (inner === undefined || inner instanceof BasicTypes.AnyType || inner instanceof BasicTypes.DataType) throw new Unsupported(`CREATE DATA ${bare[1]}: a reference without a complete type`);
    const t = typeOf(inner, `CREATE DATA ${bare[1]}`, ctx.program);
    if (["ref", "exc", "data", "dref"].includes(t.k)) throw new Unsupported(`CREATE DATA ${bare[1]}: a ${t.k}`);
    return {s: "create_data", target, type: t};
  }
  // CREATE DATA r TYPE (name) / TYPE STANDARD TABLE OF (name): a table or
  // view of the dictionary, looked up at run time in the table registry
  // (A4H ZCL_GOGEN_T_CRDYN: the name in any case, an unknown one
  // CX_SY_CREATE_DATA_ERROR with the reference untouched)
  const dyn = /^CREATE\s+DATA\s+\S+\s+TYPE\s+(STANDARD\s+TABLE\s+OF\s+)?\(\s*([^()\s]+)\s*\)(\s+WITH\s+(NON-UNIQUE\s+)?DEFAULT\s+KEY)?\s*\.?$/i.exec(text);
  if (dyn) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    if (target.type.k !== "dref") throw new Unsupported(`CREATE DATA into a ${target.type.k}`);
    const src = node.findDirectExpression(Expressions.Dynamic)?.findFirstExpression(Expressions.FieldChain)
      ?? node.findFirstExpression(Expressions.Dynamic)?.findFirstExpression(Expressions.FieldChain);
    let name;
    if (src) name = convert(fieldChain(src, ctx), S);
    else if (/^'.*'$/.test(dyn[2])) name = {e: "str", value: dyn[2].slice(1, -1), type: S};
    else throw new Unsupported(`CREATE DATA TYPE (${dyn[2]}): the name`);
    return {s: "create_data_dyn", target, name, table: !!dyn[1]};
  }
  const m = /^CREATE\s+DATA\s+\S+\s+TYPE\s+(STANDARD\s+TABLE\s+OF\s+)?([\w\/=>~-]+)(\s+WITH\s+(NON-UNIQUE\s+)?DEFAULT\s+KEY)?\s*\.?$/i.exec(text);
  if (!m || /^(REF|LINE|RANGE|SORTED|HASHED|TABLE)$/i.test(m[2])) throw new Unsupported(`statement CreateData: ${text}`);
  const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
  if (target.type.k !== "dref") throw new Unsupported(`CREATE DATA into a ${target.type.k}`);
  const name = upper(m[2]);
  let t;
  const ddic = ctx.reg.getObject("TABL", name) ?? ctx.reg.getObject("VIEW", name) ?? ctx.reg.getObject("TTYP", name) ?? ctx.reg.getObject("DTEL", name);
  if (!/=>/.test(name) && !(ctx.scope.findType?.(name)) && ddic) {
    let at;
    try { at = ddic.parseType(ctx.reg); } catch { throw new Unsupported(`CREATE DATA TYPE ${name}: its type does not resolve`); }
    t = typeOf(at, name, ctx.program);
  } else t = namedType(node.findDirectExpression(Expressions.TypeName) ?? {concatTokens: () => m[2]}, ctx);
  if (["ref", "exc", "data", "dref"].includes(t.k)) throw new Unsupported(`CREATE DATA TYPE ${name}: a ${t.k}`);
  return {s: "create_data", target, type: m[1] ? {k: "table", row: t} : t};
}

/**
 * CREATE OBJECT o [TYPE cls | TYPE (name)] [EXPORTING ...]. A static class
 * is NEW. A class given by name goes through the program's class registry and
 * takes no arguments. The runtime checks that the result fits o, as the kernel
 * does: CX_SY_CREATE_OBJECT_ERROR for an unknown class, CX_SY_MOVE_CAST_ERROR
 * for one that does not fit.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").FrontendStmt} */ function createObject(node, ctx) {
  const text = node.concatTokens();
  const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
  if (target.type.k !== "ref") throw new Unsupported(`CREATE OBJECT into a ${target.type.k}`);
  const params = node.findDirectExpression(Expressions.ParameterListS);
  if (node.findDirectExpression(Expressions.ParameterListExceptions)) throw new Unsupported(`CREATE OBJECT with EXCEPTIONS: ${text}`);
  const dyn = node.findDirectExpression(Expressions.Dynamic);
  if (dyn) {
    if (params) throw new Unsupported(`CREATE OBJECT by name with EXPORTING: ${text}`);
    const inner = dyn.getChildren().filter((c) => !isTok(c));
    if (inner.length !== 1) throw new Unsupported(`CREATE OBJECT TYPE ${dyn.concatTokens()}`);
    return {s: "create_dyn", target, name: convert(sourceOperand(inner[0], ctx), {k: "string"})};
  }
  const clsNode = node.findDirectExpression(Expressions.ClassName);
  if (!clsNode && target.type.intf) throw new Unsupported(`CREATE OBJECT of an interface reference without TYPE: ${text}`);
  const written = clsNode ? upper(clsNode.concatTokens()) : target.type.name;
  // a local class of this class's owner (LOCAL_CLASSES), by its compiled name
  const cls = ctx.program.locals?.get(`${ctx.owner ?? ctx.className}|${written}`) ?? written;
  if (!ctx.program.wanted.has(cls)) throw notInProgram(ctx, cls, `CREATE OBJECT ${cls}: the class is not compiled in this program`);
  const sig = constructorSignature(ctx, cls);
  const given = new Map();
  for (const p of params?.findAllExpressions(Expressions.ParameterS) ?? []) {
    given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
  }
  const args = sig.map((p) => {
    if (p.suppliedOf) return {dir: "importing", byValue: true, type: p.type, value: {e: "chars", value: given.has(p.suppliedOf) ? "X" : "", type: p.type}};
    const src = given.get(p.name);
    if (src === undefined) {
      if (p.default !== undefined) return {dir: "importing", byValue: p.byValue, type: p.type, value: defaultValue(p, ctx)};
      if (p.optional) return {dir: "importing", byValue: p.byValue, type: p.type, value: {e: "zero", type: p.type}};
      throw new Unsupported(`CREATE OBJECT ${cls}: ${p.name} not supplied`);
    }
    return {dir: "importing", byValue: p.byValue, type: p.type, value: convert(source(src, ctx, p.type), p.type)};
  });
  const made = {e: "new", cls, args, type: {k: "ref", name: cls}};
  return {s: "assign", target, value: !target.type.intf && target.type.name === cls ? made : convert(made, target.type)};
}

/*
 * RAISE EXCEPTION of a class-based exception: the object is made as CREATE
 * OBJECT makes it (TYPE cls EXPORTING ...) or is one that exists (RAISE
 * EXCEPTION obj, the same object arrives in the CATCH: A4H 2026-09-23).
 * The class must be compiled in the program; RESUMABLE, SHORTDUMP and the
 * MESSAGE forms are refused.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function raiseException(node, ctx, text) {
  if (/^RAISE\s+(RESUMABLE|SHORTDUMP)\b/i.test(text)) throw new Unsupported(`RAISE ${text.split(/\s+/)[1].toUpperCase()}: ${text.slice(0, 80)}`);
  if (/^RAISE\s+EXCEPTION\s+TYPE\s+\S+\s+(MESSAGE|USING\s+MESSAGE)\b/i.test(text)) throw new Unsupported(`RAISE EXCEPTION with MESSAGE: ${text.slice(0, 80)}`);
  const clsNode = node.findDirectExpression(Expressions.ClassName);
  if (clsNode) {
    const cls = upper(clsNode.concatTokens());
    if (!ctx.program.wanted.has(cls)) throw notInProgram(ctx, cls, `RAISE EXCEPTION TYPE ${cls}: the class is not compiled in this program`);
    const params = node.findDirectExpression(Expressions.ParameterListS);
    const given = new Map();
    for (const p of params?.findAllExpressions(Expressions.ParameterS) ?? []) {
      given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
    }
    const sig = constructorSignature(ctx, cls);
    for (const n of given.keys()) if (!sig.some((p) => p.name === n)) throw new Unsupported(`RAISE EXCEPTION TYPE ${cls}: no constructor parameter ${n}`);
    const args = sig.map((p) => {
      if (p.suppliedOf) return {dir: "importing", byValue: true, type: p.type, value: {e: "chars", value: given.has(p.suppliedOf) ? "X" : "", type: p.type}};
      const src = given.get(p.name);
      if (src === undefined) {
        if (p.default !== undefined) return {name: p.name, supplied: false, dir: "importing", byValue: p.byValue, type: p.type, value: defaultValue(p, ctx)};
        if (p.optional) return {name: p.name, supplied: false, dir: "importing", byValue: p.byValue, type: p.type, value: {e: "zero", type: p.type}};
        throw new Unsupported(`RAISE EXCEPTION TYPE ${cls}: ${p.name} not supplied`);
      }
      return {dir: "importing", byValue: p.byValue, type: p.type, value: convert(source(src, ctx, p.type), p.type)};
    });
    return {s: "raise", value: {e: "new", cls, args, type: {k: "ref", name: cls}}, cls};
  }
  const src = node.findDirectExpression(Expressions.Source) ?? node.findDirectExpression(Expressions.SimpleSource2);
  if (!src) throw new Unsupported(`RAISE EXCEPTION form: ${text.slice(0, 80)}`);
  const value = source(src, ctx);
  if (!["ref", "exc"].includes(value.type.k)) throw new Unsupported(`RAISE EXCEPTION of a ${value.type.k}`);
  return {s: "raise", value, cls: null};
}

/*
 * Class events (ultra/events). EVENTS / CLASS-EVENTS of a class or an
 * interface, SET HANDLER and RAISE EVENT, measured on A4H
 * (ZCL_GOGEN_T_EVENTS / _EVENTS2, $ZOSG_TMP_0440; go/abap/events.go has the
 * rules). An event is known by where it is declared, "DECL~EVENT", so a
 * handler FOR EVENT e OF a subclass and a RAISE EVENT in a subclass meet
 * the declaring class's event. program.events collects the events used,
 * for the backends' parameter types.
 */
function eventInfo(ctx, owner, evName) {
  let decl = null;
  let def = null;
  let name = upper(evName);
  if (name.includes("~")) {
    const [intf, ev] = name.split("~");
    const idef = ctx.reg.getObject("INTF", intf)?.getDefinition();
    const found = idef?.getEvents?.().find((e) => upper(e.getName()) === ev);
    if (found) { decl = intf; def = found; name = ev; }
  } else if (ctx.reg.getObject("INTF", owner)) {
    const found = ctx.reg.getObject("INTF", owner).getDefinition()?.getEvents?.().find((e) => upper(e.getName()) === name);
    if (found) { decl = owner; def = found; }
  } else {
    for (const c of [owner, ...ancestors(ctx.reg, owner)]) {
      const found = ctx.reg.getObject("CLAS", c)?.getDefinition()?.getEvents?.().find((e) => upper(e.getName()) === name);
      if (found) { decl = c; def = found; break; }
    }
  }
  if (!def) throw new Unsupported(`event ${evName} of ${owner} is not in the program`);
  const key = `${decl}~${name}`;
  if (ctx.program.events.has(key)) return ctx.program.events.get(key);
  // DEFAULT of an event parameter is not read off the definition (abaplint
  // keeps no default for it): an event that has one is refused
  const obj = ctx.reg.getObject("INTF", decl) ?? ctx.reg.getObject("CLAS", decl);
  for (const f of obj.getABAPFiles()) {
    for (const st of f.getStatements()) {
      if (!(st.get() instanceof Statements.Events)) continue;
      if (upper(st.findDirectExpression(Expressions.EventName)?.concatTokens() ?? "") !== name) continue;
      if (/\bDEFAULT\b/i.test(st.concatTokens())) throw new Unsupported(`event ${key}: a parameter with DEFAULT`);
    }
  }
  const params = def.getParameters().map((p) => ({name: upper(p.getName()), type: typeOf(p.getType(), `event ${key}`, ctx.program)}));
  const info = {key, decl, name, static: def.isStatic(), params};
  ctx.program.events.set(key, info);
  return info;
}

/*
 * SET HANDLER h1 h2 ... [FOR obj | FOR ALL INSTANCES] [ACTIVATION act].
 * Each handler becomes the call the dispatch makes: its receiver the
 * handler object as it was when SET HANDLER ran (ev_handler), its IMPORTING
 * parameters the event's (ev_arg) and SENDER (ev_sender). A handler on me
 * (bare name or me->m) is called as a call on me.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function setHandler(node, ctx, text) {
  const forAll = /\bFOR\s+ALL\s+INSTANCES\b/i.test(text);
  const kids = node.getChildren();
  const forAt = kids.findIndex((k) => isTok(k, "FOR"));
  const actAt = kids.findIndex((k) => isTok(k, "ACTIVATION"));
  const forObj = forAt >= 0 && !forAll ? source(kids[forAt + 1], ctx) : null;
  if (forObj && forObj.type.k !== "ref") throw new Unsupported(`SET HANDLER ... FOR a ${forObj.type.k}`);
  const activation = actAt >= 0 ? convert(source(kids[actAt + 1], ctx), C(1)) : null;
  const handlers = [];
  for (const ms of node.findDirectExpressions(Expressions.MethodSource)) {
    const mk = ms.getChildren();
    if (ms.findDirectExpression(Expressions.Dynamic)) throw new Unsupported(`SET HANDLER with a dynamic method: ${text}`);
    let obj = null;
    let owner;
    let mname;
    let staticRef = false;
    if (mk.length === 1) {
      owner = ctx.className;
      mname = upper(mk[0].concatTokens());
    } else if (mk.length === 3 && isTok(mk[1], "=>")) {
      owner = upper(mk[0].concatTokens());
      mname = upper(mk[2].concatTokens());
      staticRef = true;
    } else if (mk.length === 3 && isTok(mk[1], "->") && upper(mk[0].concatTokens()) === "ME") {
      owner = ctx.className;
      mname = upper(mk[2].concatTokens());
    } else if (mk.length === 3 && isTok(mk[1], "->")) {
      obj = fieldChain(mk[0], ctx);
      if (obj.type.k !== "ref" || obj.type.intf) throw new Unsupported(`SET HANDLER through ${mk[0].concatTokens()}: not a class reference`);
      owner = obj.type.name;
      mname = upper(mk[2].concatTokens());
    } else {
      throw new Unsupported(`SET HANDLER handler ${ms.concatTokens()}`);
    }
    if (mname.includes("~")) throw new Unsupported(`SET HANDLER of an interface method: ${ms.concatTokens()}`);
    const at = declaringClass(ctx.reg, owner, mname, "method");
    if (!at) throw new Unsupported(`SET HANDLER: ${owner} has no method ${mname}`);
    if (!ctx.program.wanted.has(at)) throw notInProgram(ctx, at, `SET HANDLER: ${at} is not compiled in this program`);
    const mdef = declaredMethod(ctx.reg, at, mname);
    if (!mdef?.isEventHandler?.()) throw new Unsupported(`SET HANDLER: ${at}=>${mname} is not an event handler`);
    const ev = eventInfo(ctx, upper(mdef.getEventClass()), mdef.getEventName());
    const sig = methodSignature(ctx, at, mname);
    if (sig.unsupported) throw new Unsupported(`SET HANDLER: ${at}=>${mname} was skipped: ${sig.unsupported}`);
    if (sig.static && obj) throw new Unsupported(`SET HANDLER of a static method through a reference: ${ms.concatTokens()}`);
    if (!sig.static && (staticRef || ctx.sig.static) && !obj) throw new Unsupported(`SET HANDLER of an instance method without an object: ${ms.concatTokens()}`);
    if (ev.static && (forObj || forAll)) throw new Unsupported(`SET HANDLER ... FOR of a static event: ${text}`);
    if (!ev.static && !forObj && !forAll) throw new Unsupported(`SET HANDLER of an instance event without FOR: ${text}`);
    const byName = new Map(ev.params.map((p) => [p.name, p]));
    const args = sig.params.map((p) => {
      if (p.dir !== "importing") throw new Unsupported(`handler ${at}=>${mname}: ${p.dir} parameter ${p.name}`);
      if (p.name === "SENDER") {
        if (ev.static) throw new Unsupported(`handler ${at}=>${mname}: SENDER of a static event`);
        return {dir: "importing", byValue: p.byValue, type: p.type, value: {e: "ev_sender", type: p.type}};
      }
      const ep = byName.get(p.name);
      if (!ep) throw new Unsupported(`handler ${at}=>${mname}: ${p.name} is no parameter of ${ev.key}`);
      if (!sameType(ep.type, p.type)) throw new Unsupported(`handler ${at}=>${mname}: ${p.name} typed unlike the event`);
      return {dir: "importing", byValue: p.byValue, type: p.type, value: {e: "ev_arg", name: p.name, type: p.type}};
    });
    const call = {e: "call", method: mname, static: sig.static, owner: sig.static ? at : null,
      receiver: obj ? {e: "ev_handler", type: obj.type} : null, sup: null, args, type: {k: "void"}, exceptions: null, receiving: null, callee: mname};
    // FOR EVENT e OF a subclass of the declaring class: FOR ALL INSTANCES
    // only takes senders of that class
    const of = upper(mdef.getEventClass());
    let filter = null;
    if (forAll && of !== ev.decl && !ctx.reg.getObject("INTF", of)) {
      if (!ctx.program.wanted.has(of)) throw notInProgram(ctx, of, `SET HANDLER ... FOR ALL INSTANCES: ${of} is not compiled in this program`);
      filter = of;
    }
    handlers.push({call, obj, me: !obj && !sig.static, key: sig.static ? `${at}=>${mname}` : mname, event: ev.key, filter});
  }
  return {s: "set_handler", handlers, forObj, all: forAll, static: handlers.length > 0 && ctx.program.events.get(handlers[0].event).static, activation};
}

/*
 * RAISE EVENT e [EXPORTING p = v ...]: the sender is me (none for a static
 * event); every parameter's actual is evaluated anew for each handler, as
 * A4H does (val: in ZCL_GOGEN_T_EVENTS).
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function raiseEvent(node, ctx, text) {
  const ev = eventInfo(ctx, ctx.className, node.findDirectExpression(Expressions.EventName).concatTokens());
  if (!ev.static && ctx.sig.static) throw new Unsupported(`RAISE EVENT of an instance event in a static method: ${text}`);
  const given = new Map();
  for (const p of node.findDirectExpression(Expressions.ParameterListS)?.findDirectExpressions(Expressions.ParameterS) ?? []) {
    given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
  }
  for (const n of given.keys()) if (!ev.params.some((p) => p.name === n)) throw new Unsupported(`RAISE EVENT ${ev.key}: no parameter ${n}`);
  const args = ev.params.map((p) => ({name: p.name, type: p.type,
    value: given.has(p.name) ? convert(source(given.get(p.name), ctx, p.type), p.type) : {e: "zero", type: p.type}}));
  return {s: "raise_event", event: ev.key, static: ev.static, sender: ev.static ? null : {e: "me", type: {k: "ref", name: ctx.className}}, args};
}

/**
 * The superclass of every compiled exception class (and of its ancestors,
 * compiled or not), for a CATCH to walk at run time: the object raised is
 * told by its class, which a RAISE EXCEPTION obj only knows then.
 */
/** @param {import("@abaplint/core").IRegistry} reg @param {import("./frontend-types.ts").FrontendProgram} program @returns {Record<string, string>} */ function exceptionSupers(reg, program) {
  const out = {};
  for (const c of program.classes) {
    const chain = [c.name, ...ancestors(reg, c.name)];
    if (!chain.includes("CX_ROOT")) continue;
    for (let i = 0; i + 1 < chain.length; i += 1) out[chain[i]] = chain[i + 1];
  }
  return out;
}

/**
 * The classes a CATCH takes that are raised as objects: every compiled class
 * that is one of the named classes or inherits from one (by the hierarchy
 * abaplint knows, so an ancestor outside the program still counts).
 */
/** @param {import("./frontend-types.ts").CompilationContext} ctx @param {readonly string[]} names @returns {string[]} */ function caughtClasses(ctx, names) {
  return caughtOnce(ctx.program, names, () => [...ctx.program.wanted].filter((w) => names.some((n) => isSubclass(ctx.reg, w, n))).sort());
}

/** the importing parameters of a class's constructor, read off its definition */
/** @param {import("./frontend-types.ts").NamedContext} ctx @param {string} clsName @returns {readonly import("./frontend-types.ts").FrontendParam[]} */ function constructorSignature(ctx, clsName) {
  // a class without a constructor of its own is created through the
  // nearest superclass's
  // a local class (LOCAL_CLASSES) has its definition by its compiled name
  const def = (PERSIST_LOWERING ? ctx.program.localDefs : LOCAL_DEFS).get(clsName) ?? ctx.reg.getObject("CLAS", declaringClass(ctx.reg, clsName, "CONSTRUCTOR", "method") ?? clsName)?.getDefinition();
  const m = def?.getMethodDefinitions().getByName("CONSTRUCTOR");
  if (m === undefined) return [];
  const p = m.getParameters();
  if (p.getExporting().length + p.getChanging().length > 0) throw new Unsupported(`${clsName} constructor with EXPORTING/CHANGING`);
  const optional = new Set((p.getOptional?.() ?? []).map(upper));
  const defOwner = declaringClass(ctx.reg, clsName, "CONSTRUCTOR", "method") ?? clsName;
  /** @type {import("./frontend-types.ts").FrontendParam[]} */ const own = p.getImporting().map((x) => ({name: upper(x.getName()), dir: "importing", byValue: x.getMeta().includes("pass_by_value"),
    type: typeOf(x.getType(), `${clsName}=>CONSTRUCTOR`, ctx.program), default: defaultOf(p, x), defaultOwner: defOwner, defOwner,
    optional: optional.has(upper(x.getName()))}));
  return withSupplied(ctx.program, `${declaringClass(ctx.reg, clsName, "CONSTRUCTOR", "method") ?? clsName}=>CONSTRUCTOR`, own);
}

/** @param {import("@abaplint/core").Nodes.ExpressionNode | null} body @param {import("./ir.ts").Type} to @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").ValueExpr} */ function valueBody(body, to, ctx, text) {
  if (to.k === "table") {
    // VALUE #( ( ... ) ( ... ) ): one row per line, a structure or one value
    /** @type {import("./frontend-types.ts").ValueExpr[]} */ const rows = [];
    for (const line of body?.getChildren() ?? []) {
      if (!isExpr(line, Expressions.ValueBodyLine)) throw new Unsupported(`VALUE for a table with ${line.concatTokens().slice(0, 30)}`);
      const inner = line.getChildren().filter((c) => !isTok(c));
      if (to.row.k === "struct") rows.push(valueBody(line, to.row, ctx, text));
      else if (inner.length === 1 && isExpr(inner[0], Expressions.Source)) rows.push(convert(source(inner[0], ctx, to.row), to.row));
      else throw new Unsupported(`VALUE table line ${line.concatTokens().slice(0, 30)}`);
    }
    // ultra/events (fix round): VALUE for a SORTED table places the rows in
    // key order and raises on a duplicate; the literal keeps source order
    /** @type {Extract<import("./frontend-types.ts").ValueExpr, {e: "table_lit"}>} */ const literal = {e: "table_lit", rows, type: to};
    if (to.sorted && rows.length > 0) {
      const fields = ctx.program.structs.get(to.row.go)?.fields ?? [];
      if (to.row.k !== "struct" || to.sorted.some((name) => !fields.some((f) => f.name === name && ["string", "c", "n", "d", "t", "i", "int8"].includes(f.type.k)))) throw new Unsupported(`VALUE with rows for a SORTED table with an unsupported key`);
      return {e: "sorted_move", x: literal, keys: to.sorted, unique: to.unique, type: to};
    }
    return literal;
  }
  if (body === null && to.k !== "struct") return {e: "zero", type: to};
  if (to.k !== "struct") throw new Unsupported(`VALUE for a ${to.k}: ${text}`);
  /** @type {{name: string; value: import("./frontend-types.ts").ValueExpr}[]} */ const fields = [];
  for (const c of body?.getChildren() ?? []) {
    if (isTok(c)) continue;
    if (!isExpr(c, Expressions.FieldAssignment)) throw new Unsupported(`VALUE body: ${text}`);
    const name = upper(c.findDirectExpression(Expressions.FieldSub).concatTokens());
    if (name.includes("-")) throw new Unsupported(`VALUE with a nested component path: ${name}`);
    const f = fieldOf(ctx, to, name, text);
    const src = c.findDirectExpression(Expressions.Source);
    const its = items(src);
    /** @type {import("./frontend-types.ts").ValueExpr} */ let v;
    if (its.length === 1 && its[0].ctor && its[0].ctor.typeNode.concatTokens() === "#") {
      v = constructor(its[0].ctor, ctx, f.type);
    } else {
      v = convert(source(src, ctx, f.type), f.type);
    }
    fields.push({name, value: v});
  }
  return {e: "struct", type: to, fields};
}

/* ------------------------------------------------------------------- templates */

/** @param {string} raw @returns {string} */ function templateText(raw) {
  const t = raw.replace(/^[|}]/, "").replace(/[{|]$/, "");
  return t.replace(/\\([{}|\\nrt])/g, (m, c) => ({n: "\n", r: "\r", t: "\t"})[c] ?? c);
}

/** the decimals a system prints for a p expression in a template, or null */
/** @param {import("./frontend-types.ts").ValueExpr} v @returns {number | null} */ function templateDecimals(v) {
  if (v.type.k === "p" && !v.type.calc) return v.type.dec ?? 0;
  if (v.fromP) return v.fromP.dec ?? 0;
  if (v.type.k === "i" || v.type.k === "int8") return 0;
  if (v.e === "conv" && ["i2pc"].includes(v.kind)) return 0;
  if (v.e === "neg") return templateDecimals(v.x);
  if (v.e === "bin" && (v.op === "+" || v.op === "-")) {
    const l = templateDecimals(v.l);
    const r = templateDecimals(v.r);
    return l === null || r === null ? null : Math.max(l, r);
  }
  if (v.e === "str" && /^-?\d+$/.test(v.value)) return 0;
  return null;
}

/** @param {import("@abaplint/core").Nodes.ExpressionNode} n @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function template(n, ctx) {
  /** @type {import("./ir.ts").TemplatePart[]} */ const parts = [];
  for (const c of n.getChildren()) {
    if (c instanceof Nodes.TokenNode) {
      const txt = templateText(tokenStr(c));
      if (txt !== "") parts.push({text: txt});
    } else if (isExpr(c, Expressions.StringTemplateSource)) {
      const v = source(c.findDirectExpression(Expressions.Source), ctx);
      const fmt = c.findDirectExpression(Expressions.StringTemplateFormatting);
      /** @type {import("./frontend-types.ts").Mutable<import("./ir.ts").TemplateOptions>} */ const opts = {};
      if (fmt) {
        // KEY = value pairs; a quoted value may itself be '=' (PAD = '=',
        // ultra/itab: zcl_stg_segw_gen's include name), which a split on
        // "=" cut in two
        const src = fmt.concatTokens();
        const pairs = [...src.matchAll(/(\w+)\s*=\s*('(?:[^']|'')*'|[^\s']+)/g)];
        if (pairs.map((m) => m[0]).join(" ").replace(/\s+/g, "") !== src.replace(/\s+/g, "")) throw new Unsupported(`template formatting ${src}`);
        const words = pairs.flatMap((m) => [m[1], m[2]]);
        for (let i = 0; i < words.length; i += 2) {
          const k = upper(words[i]);
          const val = words[i + 1];
          if (k === "DECIMALS" && /^\d+$/.test(val) && (v.type.k === "f" || v.type.k === "p")) opts.decimals = Number(val);
          // NUMBER = RAW of a p is its plain form (A4H PDFMT n:)
          else if (k === "NUMBER" && upper(val) === "RAW" && v.type.k === "p") opts.raw = true;
          else if (k === "WIDTH" && /^\d+$/.test(val)) opts.width = Number(val);
          else if (k === "ALIGN" && /^(LEFT|RIGHT|CENTER)$/i.test(val)) opts.align = upper(val);
          else if (k === "PAD" && /^'.'$/.test(val)) opts.pad = val.slice(1, 2);
          else throw new Unsupported(`template formatting ${k} = ${val} for a ${v.type.k}`);
        }
      }
      // f: seventeen significant digits, positional, measured on A4H (abap.FmtF)
      // n: its digits as they are (A4H PDCONV pn:0013)
      if (!["i", "int8", "f", "string", "c", "x", "xstring", "data", "d", "t", "p", "n"].includes(v.type.k)) throw new Unsupported(`${v.type.k} in a string template`);
      // a p field prints its own decimals; an arithmetic expression of
      // calculation type p prints decimals a system decides by rules not
      // fully measured (A4H: 1.25 + 1 is 2.25, but 1.25 * 2 is 2.500 and
      // 1.25 * 1.25 is 1.56250), so only + and - are taken, with the most
      // decimals of their operands
      if (v.type.k === "p") {
        opts.pdec = v.type.calc ? templateDecimals(v) : v.type.dec;
        if (opts.pdec === null && opts.decimals === undefined) throw new Unsupported(`an arithmetic expression of type p with * or / in a string template: its decimals are not measured`);
      }
      parts.push({value: v, opts});
    } else {
      throw new Unsupported(`template part ${c.get().constructor.name}`);
    }
  }
  return {e: "template", parts, type: S};
}

/* ------------------------------------------------------------------------ calls */

const FUNCTIONS = {
  SIN: "f", COS: "f", TAN: "f", SQRT: "f", EXP: "f", LOG: "f", LOG10: "f",
  ABS: "same", SIGN: "same", FLOOR: "same", CEIL: "same", TRUNC: "same", FRAC: "same",
  NMAX: "max", NMIN: "max", IPOW: "power", BOOLX: "boolx",
};

/** @param {import("./frontend-types.ts").CallChain} chain @param {import("./frontend-types.ts").MethodContext} ctx @param {boolean} statement @param {import("./ir.ts").Type} [hint] @returns {import("./frontend-types.ts").ValueExpr} */ function call(chain, ctx, statement, hint) {
  const kids = chain.getChildren();
  // x->get_text( ) of an exception caught INTO x
  if (kids.length === 3 && isTok(kids[1], "->") && isExpr(kids[2], Expressions.MethodCall)) {
    const x = excHolder(kids[0].concatTokens(), ctx);
    if (x) {
      if (upper(kids[2].findDirectExpression(Expressions.MethodName).concatTokens()) !== "GET_TEXT") throw new Unsupported(`exception method ${kids[2].concatTokens()}`);
      return {e: "exc_text", x, type: S};
    }
  }
  // cl_abap_classdescr=>get_class_name( x ) of an exception caught INTO x
  // together with runtime exceptions: \CLASS=<its class>, what A4H answers
  // for the runtime's own (ZCL_GOGEN_T_RAWRD: \CLASS=CX_SY_OPEN_SQL_DATA_ERROR)
  // and for a raised object alike
  if (/^cl_abap_(class|type)descr=>get_class_name\(\s*\w+\s*\)$/i.test(chain.concatTokens())) {
    const v = /\(\s*(\w+)\s*\)$/.exec(chain.concatTokens())[1];
    const x = excHolder(v, ctx);
    if (x) return {e: "exc_class", x, type: S};
  }
  // cl_abap_random_int=>create( [seed] min max )->get_next( ): a system seeds
  // an unseeded generator at random, so a number, not a sequence, is the
  // contract; a SEED makes the sequence the contract and is refused
  if (/^cl_abap_random_int=>create\(.*\)->get_next\(\s*\)$/i.test(chain.concatTokens())) {
    const create = chain.findFirstExpression(Expressions.MethodCall);
    const ps = create.findFirstExpression(Expressions.ParameterListS)?.findDirectExpressions(Expressions.ParameterS) ?? [];
    const arg = (p) => ps.find((x) => upper(x.findDirectExpression(Expressions.ParameterName).concatTokens()) === p)?.findDirectExpression(Expressions.Source);
    if (arg("SEED") || !arg("MIN") || !arg("MAX") || ps.length !== 2) throw new Unsupported(`cl_abap_random_int form: ${chain.concatTokens()}`);
    return {e: "random", min: convert(source(arg("MIN"), ctx, I), I), max: convert(source(arg("MAX"), ctx, I), I), type: I};
  }
  if (isExpr(kids[0], Expressions.NewObject)) {
    if (kids.length !== 1) throw new Unsupported(`a call on a new object: ${chain.concatTokens()}`);
    const nk = kids[0].getChildren();
    const body = nk.slice(3, -1).find((c) => !isTok(c)) ?? null;
    return constructor({kw: "NEW", typeNode: nk[1], body, text: chain.concatTokens()}, ctx, hint);
  }
  if (isExpr(kids[0], Expressions.Cast)) {
    if (kids.length !== 1) throw new Unsupported(`a call on a CAST result: ${chain.concatTokens()}`);
    const ck = kids[0].getChildren();
    const body = ck.slice(3, -1).find((c) => isExpr(c, Expressions.Source));
    return constructor({kw: "CAST", typeNode: ck[1], body, text: chain.concatTokens()}, ctx, hint);
  }
  /** @type {import("./frontend-types.ts").ValueExpr | null} */ let receiver = null;
  /** @type {string | null} */ let owner = null;
  /** @type {string | null} */ let sup = null;
  /** @type {import("./frontend-types.ts").ValueExpr | null} */ let receiving = null;
  /** @type {{map: Record<string, number>; others: number} | null} */ let exceptions = null;
  /** @type {import("@abaplint/core").Nodes.ExpressionNode} */ let mc;
  if (kids.length === 3 && upper(kids[0].concatTokens()) === "SUPER" && isTok(kids[1], "->") && isExpr(kids[2], Expressions.MethodCall)) {
    // SUPER->m( ): the superclass's implementation, not a virtual call
    sup = ancestors(ctx.reg, ctx.className)[0];
    if (!sup || !ctx.program.wanted.has(sup)) throw notInProgram(ctx, sup, `SUPER-> in ${ctx.className}: the superclass is not compiled in this program`);
    mc = kids[2];
  } else if (kids.length === 1 && isExpr(kids[0], Expressions.MethodCall)) {
    mc = kids[0];
  } else if (kids.length === 3 && isExpr(kids[0], Expressions.ClassName) && isTok(kids[1], "=>") && isExpr(kids[2], Expressions.MethodCall)) {
    // a local class of the owner being compiled, by its compiled name
    // (parity-wave2: CL_ABAP_ZIP's lcl_stream=>read_int2( ))
    const cn = upper(kids[0].concatTokens());
    const local = ctx.program.locals?.get(`${ctx.program.currentOwner}|${cn}`);
    if ((local ?? cn) !== ctx.className) owner = local ?? cn;
    mc = kids[2];
  } else if (kids.length === 3 && upper(kids[0].concatTokens()) === "ME" && isTok(kids[1], "->")) {
    mc = kids[2];
  } else if (kids.length === 3 && isTok(kids[1], "->") && isExpr(kids[2], Expressions.MethodCall) && !isExpr(kids[0], Expressions.MethodCall)) {
    receiver = isExpr(kids[0], Expressions.FieldChain) || isExpr(kids[0], Expressions.SourceField) ? fieldChain(kids[0], ctx) : null;
    if (receiver === null || receiver.type.k !== "ref") throw new Unsupported(`call through ${kids[0].concatTokens()}`);
    if (!receiver.type.intf && !ctx.program.wanted.has(receiver.type.name)) throw notInProgram(ctx, receiver.type.name, `call on a ${receiver.type.name}, which is not compiled in this program`);
    owner = receiver.type.name;
    mc = kids[2];
  } else if ((kids.length > 3 || isExpr(kids[0], Expressions.MethodCall)) && isTok(kids[kids.length - 2], "->") && isExpr(kids[kids.length - 1], Expressions.MethodCall)) {
    // a->b( )->c( ): the receiver is what the chain before the last -> returns;
    // so is m( )->n( ) and zif_x~m( )->n( ), whose head is a call on me
    const head = kids.slice(0, -2);
    const prefix = {getChildren: () => head, concatTokens: () => head.map((k) => k.concatTokens()).join(""),
      findFirstExpression: (t) => head.map((k) => (isTok(k) ? undefined : isExpr(k, t) ? k : k.findFirstExpression(t))).find(Boolean)};
    receiver = call(prefix, ctx, false);
    if (receiver.type.k !== "ref") throw new Unsupported(`call through a ${receiver.type.k}: ${chain.concatTokens()}`);
    if (!receiver.type.intf && !ctx.program.wanted.has(receiver.type.name)) throw notInProgram(ctx, receiver.type.name, `call on a ${receiver.type.name}, which is not compiled in this program`);
    owner = receiver.type.name;
    mc = kids[kids.length - 1];
  } else {
    throw new Unsupported(`call chain ${chain.concatTokens()}`);
  }
  const name = upper(mc.findDirectExpression(Expressions.MethodName).concatTokens());
  if (receiver && isSubclass(ctx.reg, receiver.type.name, "CL_ABAP_OBJECTDESCR") && ["GET_ATTRIBUTE_TYPE", "GET_METHOD_PARAMETER_TYPE", "GET_INTERFACE_TYPE", "GET_SUPER_CLASS_TYPE"].includes(name)) throw new Unsupported(`object RTTI method ${name}: member descriptions are not implemented`);
  const param = mc.findDirectExpression(Expressions.MethodCallParam);
  const direct = param?.findDirectExpression(Expressions.Source);
  const named = param?.findDirectExpression(Expressions.ParameterListS);
  const full = param?.findDirectExpression(Expressions.MethodParameters);
  // ultra/events (fix round): CL_ABAP_RANDOM->INT is a host function that
  // ignores a seed (as open-abap-core's @KERNEL line does), so a seeded
  // generator, whose sequence would be the contract, is refused
  if (owner === "CL_ABAP_RANDOM" && name === "CREATE" && (direct || named || full)) throw new Unsupported(`CL_ABAP_RANDOM=>CREATE with a SEED: the host generator ignores it`);

  if (receiver === null && owner === null && FUNCTIONS[name] !== undefined && !ctx.signatures.has(name)) return builtin(name, direct, named, ctx, {FUNCTIONS, Expressions, source, convert, Unsupported, upper, I, F, P31, S, XS, numeric}, name === "IPOW" && ["i", "int8", "p", "f"].includes(hint?.k) ? hint : undefined);
  if (receiver === null && name === "LINES" && !ctx.signatures.has(name)) {
    const t = source(direct, ctx);
    if (t.type.k === "data") return {e: "lines_data", x: t, type: I};
    if (t.type.k !== "table") throw new Unsupported("lines( ) of a non-table");
    return {e: "lines", table: t, type: I};
  }
  // ultra/events: escape( val = v format = cl_abap_format=>e_html_attr ) (A4H
  // ZCL_GOGEN_T_WGUI1: & < > " ' become entities, nothing else changes)
  if (receiver === null && owner === null && name === "ESCAPE" && !ctx.signatures.has(name)) {
    const ps = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    const arg = (p) => ps.find((x) => upper(x.findDirectExpression(Expressions.ParameterName).concatTokens()) === p)?.findDirectExpression(Expressions.Source);
    // parity-wave1: e_json_string (A4H ZCL_GOGEN_T_JSESC: \\ and " escaped,
    // \b \t \n \f \r, every other control character \u00XX, the rest as
    // it is; a c loses its trailing blanks, a generic operand is read as a
    // string, which /UI2/CL_JSON=>SERIALIZE_INT passes)
    const fmt = /^cl_abap_format=>(e_html_attr|e_json_string)$/i.exec(arg("FORMAT")?.concatTokens() ?? "")?.[1]?.toLowerCase();
    if (ps.length !== 2 || !arg("VAL") || !fmt) throw new Unsupported(`escape( ) form: ${chain.concatTokens()}`);
    const v = source(arg("VAL"), ctx);
    if (!charlike(v.type) && !(fmt === "e_json_string" && v.type.k === "data" && !v.type.table)) throw new Unsupported(`escape( ) of a ${v.type.k}`);
    return {e: "str_fn", fn: fmt === "e_html_attr" ? "EscapeHTMLAttr" : "EscapeJSONString", args: [convert(v, S)], type: S};
  }
  if (receiver === null && owner === null && STRING_FNS[name] && !ctx.signatures.has(name)) return stringFn(name, direct, named, ctx, chain.concatTokens());
  // ultra/httpc: concat_lines_of( table = t sep = s ) over a table of
  // strings (cl_http_utility=>fields_to_string): the rows joined by sep. A
  // row type other than string is refused (what a c row keeps of its
  // trailing blanks is not measured), and so is a table without sep only
  // when sep is not a character operand
  if (receiver === null && owner === null && name === "CONCAT_LINES_OF" && !ctx.signatures.has(name)) {
    const ps = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    const arg = (p) => ps.find((x) => upper(x.findDirectExpression(Expressions.ParameterName).concatTokens()) === p)?.findDirectExpression(Expressions.Source);
    const tabNode = direct ?? arg("TABLE");
    if (tabNode === undefined || ps.some((x) => !["TABLE", "SEP"].includes(upper(x.findDirectExpression(Expressions.ParameterName).concatTokens())))) throw new Unsupported(`concat_lines_of( ) form: ${chain.concatTokens()}`);
    const tab = source(tabNode, ctx);
    if (tab.type.k !== "table" || tab.type.row.k !== "string") throw new Unsupported(`concat_lines_of( ) of a ${tab.type.k === "table" ? `table of ${tab.type.row.k}` : tab.type.k}: only a table of strings is in the subset`);
    let sep = {e: "str", value: "", type: S};
    if (arg("SEP") !== undefined) {
      const x = source(arg("SEP"), ctx);
      if (!charlike(x.type)) throw new Unsupported(`concat_lines_of( ) sep of a ${x.type.k}`);
      sep = convert(x, S);
    }
    return {e: "str_fn", fn: "ConcatLinesOf", args: [tab, sep], type: S};
  }
  if (receiver === null && owner === null && ["TO_LOWER", "TO_UPPER"].includes(name) && !ctx.signatures.has(name)) {
    const argNode = direct ?? named?.findDirectExpressions(Expressions.ParameterS).find((p) => upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()) === "VAL")?.findDirectExpression(Expressions.Source);
    return {e: "case_fn", upper: name === "TO_UPPER", x: convert(source(argNode, ctx), S), type: S};
  }
  if (receiver === null && ["STRLEN", "NUMOFCHAR"].includes(name) && !ctx.signatures.has(name)) {
    // parity-wave1: of a value the backends hold as text only (a generic
    // operand reached it through a function module's untyped parameter and
    // the Go build failed on it)
    const x = source(direct, ctx);
    if (["data", "i", "int8", "f", "struct", "table", "ref", "dref", "exc"].includes(x.type.k)) throw new Unsupported(`strlen( ) of a ${x.type.k}`);
    return name === "NUMOFCHAR" ? {e: "str_fn", fn: "Numofchar", args: [convert(x, S)], type: I} : {e: "strlen", x, type: I};
  }
  if (receiver === null && owner === null && name === "REVERSE" && !ctx.signatures.has(name)) {
    const x = source(direct, ctx);
    if (!charlike(x.type)) throw new Unsupported(`reverse( ) of a ${x.type.k}`);
    return {e: "reverse", x: convert(x, S), type: S};
  }
  if (receiver === null && owner === null && name === "FIND" && !ctx.signatures.has(name)) {
    // find( val = s sub = x [off = n] ): measured on A4H, see abap.Find
    const arg = (p) => named?.findDirectExpressions(Expressions.ParameterS).find((x) => upper(x.findDirectExpression(Expressions.ParameterName).concatTokens()) === p)?.findDirectExpression(Expressions.Source);
    const given = (named?.findDirectExpressions(Expressions.ParameterS) ?? []).map((x) => upper(x.findDirectExpression(Expressions.ParameterName).concatTokens()));
    if (!named || given.some((p) => !["VAL", "SUB", "OFF", "OCC"].includes(p)) || !arg("VAL") || !arg("SUB") || (arg("OCC") && arg("OFF"))) throw new Unsupported(`find( ) form: ${chain.concatTokens()}`);
    const val = convert(source(arg("VAL"), ctx), S);
    const sub = convert(source(arg("SUB"), ctx), S);
    if (arg("OCC")) return {e: "find_occ", val, sub, occ: convert(source(arg("OCC"), ctx, I), I), type: I};
    return {e: "find", val, sub, off: arg("OFF") ? convert(source(arg("OFF"), ctx, I), I) : null, type: I};
  }
  if (receiver === null && name === "XSTRLEN" && !ctx.signatures.has(name)) {
    const x = source(direct, ctx);
    if (x.type.k !== "xstring" && x.type.k !== "x") throw new Unsupported(`xstrlen( ) of a ${x.type.k}`);
    return {e: "xstrlen", x, type: I};
  }
  // the character of a code point (a blank is the empty c, as stored)
  // the code point of a character; a blank c is stored empty and is 32
  if (owner === "CL_ABAP_CONV_OUT_CE" && name === "UCCPI") return {e: "uccp", x: convert(source(direct, ctx), S), type: I};
  if (receiver === null && owner === null && name === "SUBSTRING" && !ctx.signatures.has(name)) {
    const ps = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    const arg = (p) => ps.find((x) => upper(x.findDirectExpression(Expressions.ParameterName).concatTokens()) === p)?.findDirectExpression(Expressions.Source);
    if (!arg("VAL") || ps.some((x) => !["VAL", "OFF", "LEN"].includes(upper(x.findDirectExpression(Expressions.ParameterName).concatTokens())))) {
      throw new Unsupported(`substring( ) form: ${chain.concatTokens()}`);
    }
    const val = convert(source(arg("VAL"), ctx), S);
    return {e: "substr", x: val, base: S, off: arg("OFF") ? convert(source(arg("OFF"), ctx, I), I) : null,
      len: arg("LEN") ? convert(source(arg("LEN"), ctx, I), I) : null, type: S};
  }
  if (owner === "CL_ABAP_CONV_IN_CE" && name === "UCCPI") return {e: "uccpi", x: convert(source(direct, ctx), I), type: C(1)};
  // open-abap-core UCCP moves SIMPLE into x(2), then i, retaining a UTF-16 unit.
  if (owner === "CL_ABAP_CONV_IN_CE" && name === "UCCP") {
    const x = convert(convert(source(direct, ctx), X(2)), I);
    return {e: "utf16unit", x, type: C(2)};
  }
  // an ALIASES name is the component it stands for; through an interface
  // reference, a method is otherwise the interface's own: I~M
  const alias = owner !== null && !name.includes("~") ? aliasTarget(ctx.reg, owner, name)
    : owner === null && !name.includes("~") && !ctx.signatures.has(name) ? aliasTarget(ctx.reg, ctx.className, name) : undefined;
  const qualified = alias ?? (owner !== null && receiver?.type.intf && !name.includes("~") ? `${owner}~${name}` : name);
  /** @type {import("./frontend-types.ts").MethodSignature | undefined} */ let sig;
  if (sup !== null && name === "CONSTRUCTOR") {
    const at = declaringClass(ctx.reg, sup, "CONSTRUCTOR", "method");
    sig = {name, static: false, params: at ? constructorSignature(ctx, at) : [], returning: null, none: !at};
  } else if (sup !== null) {
    sig = methodSignature(ctx, sup, name);
  } else if (owner === null && !ctx.signatures.has(name) && !alias) {
    // a method the class inherits: resolved where it is declared
    // me->intf~m( ) of an interface a superclass implements: that class's
    const at = name.includes("~") ? implementingClass(ctx.reg, ctx.className, name.split("~")[0]) : declaringClass(ctx.reg, ctx.className, name, "method");
    if (at === undefined || at === ctx.className) throw new Unsupported(`unknown method ${name}`);
    if (declaredMethod(ctx.reg, at, name)?.getVisibility?.() === 1) throw new Unsupported(`${name} is private in ${at}`);
    sig = methodSignature(ctx, at, name);
    if (sig.static) owner = at;
  } else {
    // an alias the class inherits names an interface method its superclass
    // implements: the signature is the interface's
    sig = owner === null ? (ctx.signatures.get(qualified) ?? (alias ? methodSignature(ctx, ctx.className, qualified) : undefined))
      : methodSignature(ctx, owner, qualified);
  }
  // a static method named through a subclass is the declaring class's function
  if (owner !== null && receiver === null && sig?.static && !qualified.includes("~")) owner = declaringClass(ctx.reg, owner, name, "method") ?? owner;
  if (sig === undefined) throw new Unsupported(`unknown method ${name}`);
  if (sig.unsupported) throw new Unsupported(`${owner ? owner + "=>" : ""}${name} was skipped: ${sig.unsupported}`);
  if (!statement && sig.returning === null) throw new Unsupported(`${name} has no RETURNING, cannot be an operand`);
  if (owner !== null && receiver === null && !sig.static) throw new Unsupported(`${owner}=>${name}: an instance method called statically`);
  if (owner !== null && receiver === null && !ctx.program.wanted.has(owner)) throw notInProgram(ctx, owner, `${owner}=>${name}: ${owner} is not compiled in this program`);
  const importing = sig.params.filter((p) => p.dir === "importing");
  /** @type {Map<string, import("@abaplint/core").Nodes.ExpressionNode | undefined>} */ const given = new Map();
  /** @type {Map<string, import("./frontend-types.ts").ValueExpr>} */ const targets = new Map();
  if (direct !== undefined) {
    if (importing.length < 1) throw new Unsupported(`${name}: an argument for no parameter`);
    given.set(importing.filter((p) => p.default === undefined)[0]?.name ?? importing[0].name, direct);
  } else if (named !== undefined) {
    for (const p of named.findDirectExpressions(Expressions.ParameterS)) {
      given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
    }
  } else if (full !== undefined) {
    const kidsP = full.getChildren();
    // RECEIVING r = x: the RETURNING value into x
    const ri = kidsP.findIndex((k) => isTok(k, "RECEIVING"));
    if (ri >= 0) receiving = lvalue(kidsP[ri + 1].findDirectExpression(Expressions.Target), ctx);
    // EXCEPTIONS name = n ... OTHERS = n: a classic exception of the method
    // called ends it, and sy-subrc says which
    const exl = full.findDirectExpression(Expressions.ParameterListExceptions);
    if (exl) {
      exceptions = {map: {}, others: -1};
      for (const x of exl.findDirectExpressions(Expressions.ParameterException)) {
        const v = x.findDirectExpression(Expressions.Integer);
        if (!v) throw new Unsupported(`EXCEPTIONS with a value that is not a number: ${x.concatTokens()}`);
        const nm = x.findDirectExpression(Expressions.ParameterName);
        if (nm) exceptions.map[upper(nm.concatTokens())] = Number(v.concatTokens());
        else exceptions.others = Number(v.concatTokens());
      }
    }
    const exp = full.findDirectExpression(Expressions.MethodParameters) ?? full;
    for (const list of full.findAllExpressions(Expressions.ParameterListS)) {
      for (const p of list.findDirectExpressions(Expressions.ParameterS)) {
        given.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), p.findDirectExpression(Expressions.Source));
      }
    }
    for (const list of full.findAllExpressions(Expressions.ParameterListT)) {
      for (const p of list.findDirectExpressions(Expressions.ParameterT)) {
        targets.set(upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()), lvalue(p.findDirectExpression(Expressions.Target), ctx));
      }
    }
    void exp;
  }
  /** @type {import("./ir.ts").Argument[]} */ const args = sig.params.map((p) => {
    if (p.suppliedOf) {
      const yes = given.has(p.suppliedOf) || targets.has(p.suppliedOf);
      return {dir: "importing", byValue: true, type: p.type, value: {e: "chars", value: yes ? "X" : "", type: p.type}};
    }
    if (p.dir === "importing") {
      const s = given.get(p.name);
      if (s === undefined) {
        if (p.default !== undefined || p.optional) return omittedArgument(p, ctx);
        throw new Unsupported(`${name}: parameter ${p.name} not supplied`);
      }
      const actual = source(s, ctx, p.type);
      if (p.type.k === "table" && p.type.sorted && !actual.type.sorted) {
        throw new Unsupported(`${name}: a STANDARD table is not type-compatible with SORTED parameter ${p.name} (A4H refusal)`);
      }
      return {name: p.name, supplied: true, dir: "importing", byValue: p.byValue, type: p.type, value: convert(actual, p.type)};
    }
    const t = targets.get(p.name);
    if (t === undefined) return {dir: p.dir, place: null, type: p.type};
    // a generic EXPORTING / CHANGING (TYPE any, data): the callee writes
    // through a binding to the caller's typed variable, as ABAP passes it by
    // reference; an ANY TABLE takes only a table
    if (p.type.k === "data" && !p.byValue && t.type.k !== "data" && t.type.k !== "dref" && (!p.type.table || t.type.k === "table")) {
      return {dir: p.dir, byValue: false, place: null, wrap: {e: "wrap", x: t, type: p.type}, type: p.type};
    }
    // ultra/events: a generic TYPE c parameter (C(262143) here) takes the
    // caller's c of any length: the callee writes the caller's field, which
    // keeps its own length (the value is fitted to it after the call)
    if (statement && p.type.k === "c" && p.type.len === 262143 && t.type.k === "c" && p.dir !== "importing") return {dir: p.dir, byValue: p.byValue, place: t, type: p.type, fitc: t.type.len};
    if (!sameType(t.type, p.type)) throw new Unsupported(`${name}: IMPORTING ${p.name} into a ${t.type.k}, the parameter is ${p.type.k}`);
    return {dir: p.dir, byValue: p.byValue, place: t, type: p.type};
  });
  if (owner === null && !sig.static && ctx.sig.static) throw new Unsupported(`${name}: an instance method called from a static one`);
  if (owner === null && sup === null) (ctx.calls = ctx.calls ?? []).push(name);
  if ((exceptions || receiving) && !statement) throw new Unsupported(`RECEIVING / EXCEPTIONS in an expression: ${chain.concatTokens()}`);
  if (receiving && (sig.returning === null || !sameType(receiving.type, sig.returning.type))) throw new Unsupported(`RECEIVING into a ${receiving.type.k}: ${chain.concatTokens()}`);
  // SUPER->constructor( ) of a chain where no superclass has a constructor does nothing
  if (sig.none) return {e: "nop_call", type: {k: "void"}};
  return {e: "call", method: qualified, static: sig.static, owner, receiver, sup, args, type: sig.returning?.type ?? {k: "void"},
    exceptions, receiving, callee: qualified};
}

/** @param {import("./frontend-types.ts").FrontendParam & {default: string}} p @param {import("./frontend-types.ts").NamedContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function defaultValue(p, ctx) {
  let t = p.default;
  // A system field in a signature default is read when the call is made.
  // ASSERT_SUBRC's ACT defaults to sy-subrc.
  if (SY_MESSAGES[upper(t)]) return convert({e: "sy", ...SY_MESSAGES[upper(t)]}, p.type);
  if (SY[upper(t)] !== undefined) return convert({e: "sy", field: SY[upper(t)], type: I}, p.type);
  // SPACE is a built-in value, not an attribute of the class which declares
  // the method. GUI_UPLOAD's optional CODEPAGE uses exactly this default.
  if (/^space$/i.test(t)) return convert({e: "chars", value: "", type: C(1)}, p.type);
  // a constant of the class or interface that declares the method, by its
  // plain name: its VALUE, a literal
  if (/^[a-z_][\w]*$/i.test(t) && !/^abap_(true|false)$/i.test(t) && p.defaultOwner !== undefined) {
    const def = ctx.reg.getObject("INTF", p.defaultOwner)?.getDefinition() ?? clasDef(ctx.reg, p.defaultOwner);
    const c = def?.getAttributes().getConstants().find((x) => upper(x.getName()) === upper(t));
    if (c !== undefined && typeof c.getValue() === "string") t = c.getValue();
    else {
      const aliased = aliasTarget(ctx.reg, p.defaultOwner, upper(t));
      const match = /^([\w\/]+)~(\w+)$/.exec(aliased ?? "");
      if (match) return convert(resolveStatic(upper(match[1]), upper(match[2]), ctx), p.type);
    }
  }
  if (/^-?\d+$/.test(t)) return convert({e: "int", value: Number(t), type: I}, p.type);
  const lit = literalText(t); // 'a', `b`, or `a` & `b`
  if (lit) return convert(lit.quote === "`" ? {e: "str", value: lit.value, type: S} : {e: "chars", value: lit.value, type: C(Math.max(1, lit.value.length))}, p.type);
  if (/^abap_true$/i.test(t)) return convert({e: "chars", value: "X", type: C(1)}, p.type);
  if (/^abap_false$/i.test(t)) return convert({e: "chars", value: "", type: C(1)}, p.type);
  // a constant: CLS=>C, or C of the class or interface the method is declared in
  const named = /^([\w\/]+)=>(\w+)$/.exec(t) ?? (/^\w+$/.test(t) && p.defOwner ? [t, p.defOwner, t] : null);
  if (named) return convert(resolveStatic(upper(named[1]), upper(named[2]), ctx), p.type);
  // a component of a structured constant: CLS=>C-COMP or C-COMP (ultra/events:
  // zif_abapgit_html=>c_action_type-sapevent, the DEFAULT of ZIF_ABAPGIT_HTML~A)
  const comp = /^([\w\/]+)=>(\w+)-(\w+)$/.exec(t) ?? (/^\w+-\w+$/.test(t) && p.defOwner ? [t, p.defOwner, ...t.split("-")] : null);
  if (comp) {
    const base = resolveStatic(upper(comp[1]), upper(comp[2]), ctx);
    const f = fieldOf(ctx, base.type, comp[3], `DEFAULT ${t}`);
    return convert({e: "field", base, name: f.name, type: f.type}, p.type);
  }
  throw new Unsupported(`DEFAULT ${t}`);
}


/* ------------------------------------------------------------------- conversion */

/**
 * An explicit conversion node where the types differ, nothing where they
 * agree. The kinds are the ones ABAP's conversion rules separate; a pair
 * that is not listed is refused, not approximated.
 */
/** CToP and PFit of go/abap packed.go at build time, for a literal: the
 * value as the field holds it, or null for no number or an overflow */
/** @param {string | number} text @param {import("./frontend-types.ts").PackedType} to @returns {string | null} */ export function packedLiteral(text, to) {
  let t = String(text).replace(/^ +| +$/g, "");
  let neg = false;
  if (t.endsWith("-")) { neg = true; t = t.slice(0, -1).replace(/ +$/, ""); } else if (t.startsWith("-")) { neg = true; t = t.slice(1).replace(/^ +/, ""); } else if (t.startsWith("+")) t = t.slice(1).replace(/^ +/, "");
  if (t === "") t = "0";
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] + (m[2] ?? "")) === "") return null;
  const frac = m[2] ?? "";
  let v = BigInt((m[1] || "0") + frac);
  const dec = to.dec ?? 0;
  if (frac.length > dec) {
    const div = 10n ** BigInt(frac.length - dec);
    const q = v / div;
    v = (v % div) * 2n >= div ? q + 1n : q;
  } else {
    v *= 10n ** BigInt(dec - frac.length);
  }
  const digits = v.toString();
  if (v !== 0n && digits.length > 2 * to.len - 1) return null;
  const padded = digits.padStart(dec + 1, "0");
  const out = dec > 0 ? `${padded.slice(0, -dec)}.${padded.slice(-dec)}` : padded;
  return neg && v !== 0n ? `-${out}` : out;
}

/**
 * OPEN / CLOSE / DELETE / READ / GET / SET DATASET and TRANSFER (X0). Each
 * operand is found by the keywords right in front of it -- the statement's
 * own tokens, never the text of an operand, which is the lesson of the
 * transpiler's version (a variable lv_type is no TYPE addition) -- and an
 * addition the runtime does not do is refused by name.
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {string} text @returns {import("./frontend-types.ts").FrontendStmt} */ function datasetStatement(node, ctx, text) {
  const operands = [];
  const words = [];
  let keywords = [];
  for (const c of node.getChildren()) {
    if (c instanceof Nodes.TokenNode) {
      const w = upper(c.getFirstToken().getStr());
      keywords.push(w);
      words.push(w);
    } else {
      operands.push({keywords, node: c});
      keywords = [];
    }
  }
  // abaplint splits UTF-8, NON-UNICODE and BYTE-ORDER into three tokens
  const joined = ` ${words.join(" ").replace(/ - /g, "-")} `;
  const has = (w) => joined.includes(` ${w} `);
  const after = (w, notAfter = []) => {
    const want = w.split(" ");
    return operands.slice(1).find((o) => o.keywords.slice(-want.length).join(" ") === w
      && !notAfter.includes(o.keywords[o.keywords.length - want.length - 1]))?.node;
  };
  // GET DATASET's name is a Target in the grammar, read here like a source
  const source = (n, to) => convert(isExpr(n, Expressions.Target) ? lvalue(n, ctx) : sourceOperand(n, ctx), to);
  const target = (n) => convert(lvalue(n, ctx), {k: "data"});
  // a position or length from a number; a character operand would need a
  // conversion the Go emitter has no rule for (c/n/string -> int8), and an
  // Error there fails the whole program, so it is refused here, in one method
  const number = (n, to, what) => {
    const v = isExpr(n, Expressions.Target) ? lvalue(n, ctx) : sourceOperand(n, ctx);
    if (!["i", "int8", "p", "f"].includes(v.type.k)) throw new Unsupported(`${what} of type ${v.type.k}`);
    return convert(v, to);
  };
  if (isStmt(node, Statements.OpenDataset)) {
    for (const w of ["CODE PAGE", "TYPE", "FILTER", "REPLACEMENT CHARACTER", "WITH BYTE-ORDER MARK", "SKIPPING BYTE-ORDER MARK",
      "WITH SMART LINEFEED", "WITH NATIVE LINEFEED", "WITH UNIX LINEFEED", "WITH WINDOWS LINEFEED", "IGNORING CONVERSION ERRORS",
      "IN LEGACY", "NON-UNICODE"]) {
      if (has(w) || after(w) !== undefined) throw new Unsupported(`OPEN DATASET ... ${w}`);
    }
    const mode = ["INPUT", "OUTPUT", "APPENDING", "UPDATE"].find((m) => has(`FOR ${m}`)) ?? "INPUT";
    const message = after("MESSAGE");
    const position = after("AT POSITION");
    return {s: "dataset_open", name: source(operands[0].node, S), mode, binary: has("BINARY MODE"),
      message: message ? target(message) : null, position: position ? number(position, INT8, "OPEN DATASET ... AT POSITION") : null};
  }
  if (isStmt(node, Statements.CloseDataset)) return {s: "dataset_close", name: source(operands[0].node, S)};
  if (isStmt(node, Statements.DeleteDataset)) return {s: "dataset_delete", name: source(operands[0].node, S)};
  if (isStmt(node, Statements.Transfer)) {
    const length = after("LENGTH");
    return {s: "dataset_transfer", src: source(operands[0].node, {k: "data"}), name: source(after("TO"), S),
      length: length ? number(length, I, "TRANSFER ... LENGTH") : null, noEndOfLine: has("NO END OF LINE")};
  }
  if (isStmt(node, Statements.ReadDataset)) {
    const max = after("MAXIMUM LENGTH");
    const actual = after("ACTUAL LENGTH") ?? after("LENGTH", ["MAXIMUM", "ACTUAL"]);
    return {s: "dataset_read", name: source(operands[0].node, S), target: target(after("INTO")),
      max: max ? number(max, I, "READ DATASET ... MAXIMUM LENGTH") : null, actual: actual ? target(actual) : null};
  }
  if (isStmt(node, Statements.GetDataset)) {
    if (after("ATTRIBUTES") !== undefined) throw new Unsupported("GET DATASET ... ATTRIBUTES");
    const position = after("POSITION");
    if (position === undefined) throw new Unsupported(`GET DATASET form: ${text}`);
    return {s: "dataset_get_position", name: source(operands[0].node, S), position: target(position)};
  }
  const position = after("POSITION");
  return {s: "dataset_set_position", name: source(operands[0].node, S), position: position ? number(position, INT8, "SET DATASET ... POSITION") : null};
}

/** @param {import("./frontend-types.ts").ValueExpr} expr @param {import("./ir.ts").Type} to @returns {import("./frontend-types.ts").ValueExpr} */ function convert(expr, to) {
  // a typed value where a generic one is expected is bound, not copied; a
  // generic one where a type is expected is read through its descriptor
  if (to.k === "data" && expr.type.k === "data") return expr;
  if (to.k === "dref" && expr.type.k === "dref") return expr;
  if (to.k === "data") {
    if (to.table && expr.type.k !== "table") throw new Unsupported(`a ${expr.type.k} where ANY TABLE is expected`);
    return {e: "wrap", x: expr, type: to};
  }
  if (expr.type.k === "data") {
    // ultra/itab: an operand of generic arithmetic, read into one calculation type
    if (GEN_CALC && (["i", "int8", "f"].includes(to.k) || (to.k === "p" && to.calc))) return {e: "unwrap_calc", x: expr, type: to};
    if (!["string", "c", "i", "d", "t", "p"].includes(to.k) || to.calc) throw new Unsupported(`a generic value moved into a ${to.k}`);
    return {e: "unwrap", x: expr, type: to};
  }
  const from = expr.type;
  if (from.k === "exc" && to.k === "ref") {
    if (!["CX_ROOT", "OBJECT"].includes(to.name)) throw new Unsupported(`exception widening to REF TO ${to.name}`);
    // The closure compiles the kernel classes; no surrogate object loses its type.
    for (const name of ["CX_ROOT", ...RUNTIME_CX]) if (REG?.getObject("CLAS", name)) PROGRAM?.missing.add(name);
    return {e: "exc_ref", x: expr, type: to};
  }
  if (sameType(from, to)) return expr;
  /** @param {string} kind @returns {Extract<import("./frontend-types.ts").ValueExpr, {e: "conv"}>} */ const ok = (kind) => ({e: "conv", kind, from, to, x: expr, type: to});
  if (numeric(from) && numeric(to)) return ok("num");
  if (to.k === "string" && from.k === "c") return ok("c2s");
  if (to.k === "c" && charlike(from)) return ok("s2c");
  // string -> d / t (parity-wave1, A4H ZCL_GOGEN_T_GENMOVD): the first eight
  // (six) characters as for a c, but an empty string is the initial value,
  // and a t shorter than six is filled with zeros ('abc' is abc000)
  if (to.k === "d" && from.k === "string") return ok("s2d");
  if (to.k === "t" && from.k === "string") return ok("s2t");
  // c -> d, measured on A4H: the first eight characters, no check ('ABC' is
  // kept, reads back as ABC and counts as 0 days); '' is not initial
  if (to.k === "d" && charlike(from)) return ok("s2c");
  // c -> t: the first six characters, the same rule (measured on A4H for
  // '123456' only, which then reads back 12 and 34 by offset)
  if (to.k === "t" && charlike(from)) return ok("s2c");
  // d -> i, measured on A4H: days since 00010101 (which is 0), Julian
  // before 15821015 (15821004 is 577736, 15821015 is 577737), an invalid
  // date is 0 (abap.DToI)
  if (to.k === "i" && from.k === "d") return ok("d2i");
  if (to.k === "i" && from.k === "t") return ok("t2i");
  // Reuse the existing signed, right-aligned packed MOVE formatting.
  if (to.k === "c" && from.k === "i") return convert(convert(expr, {k: "p", len: 8, dec: 0}), to);
  // d / t into characters: the eight / six digits as they are (both are
  // held as their digits already); into a c they are cut or padded as any
  // characters are
  if (to.k === "string" && (from.k === "d" || from.k === "t")) return {...expr, type: to};
  if (to.k === "c" && (from.k === "d" || from.k === "t")) return ok("s2c");
  // c -> n for a literal of exactly the field's digits only: the characters
  // are the value (anything else, blanks, signs, other lengths, is a
  // conversion rule not measured here)
  if (to.k === "n" && expr.e === "chars" && to.len && new RegExp(`^[0-9]{${to.len}}$`).test(expr.value)) return {...expr, type: to};
  // ultra/demodata, NUMC moves measured on A4H 2026-09-24 (ZCL_GOGEN_T_NUMC,
  // $ZOSG_TMP_0462). An n holds its digits, zeros included:
  // n -> string keeps them (0000000042), n -> c is a c move of them (into a
  // c 8: 00000000), n -> i and f read them as a number
  if (from.k === "n" && to.k === "string") return {...expr, type: to};
  if (from.k === "n" && to.k === "c") return ok("s2c");
  if (from.k === "n" && numeric(to)) return ok("c2n");
  // i -> n: the sign dropped, the last digits kept, zeros in front (42 into
  // n 10 is 0000000042, -5 into n 3 is 005, 123456 into n 3 is 456)
  if (from.k === "i" && to.k === "n") return ok("i2n");
  // c / string -> n: the digits only, right-aligned, the last ones kept
  // (' 12' is 0000000012, 'a1b2 3' into n 3 is 123, '98765' into n 3 is
  // 765, a blank c is 000)
  if (charlike(from) && to.k === "n") return ok("s2n");
  // i -> string, measured on A4H: the digits and then a place for the sign,
  // 42 is "42 ", -5 is "5-" (a template writes -5; a move does not)
  if (to.k === "string" && from.k === "i") return ok("i2s");
  if (to.k === "string" && from.k === "int8") return ok("i82s");
  if (to.k === "string" && from.k === "f") return ok("f2s");
  // Four/eight big-endian bytes, zero-padded or truncated on the left.
  if (["x", "xstring"].includes(to.k) && ["i", "int8"].includes(from.k)) return ok(from.k === "i" ? "i2x" : "i82x");
  // An exact upper-case hex literal supplies the bytes directly.
  if ((to.k === "xstring" || (to.k === "x" && expr.value?.length === 2 * to.len)) && expr.e === "chars" && /^([0-9A-F]{2})*$/.test(expr.value)) {
    return {e: "xbytes", value: expr.value, type: to};
  }
  // packed numbers (go/abap packed.go, A4H 2026-09-24, ZCL_GOGEN_T_PD*).
  // Into calculation type p: exact, nothing rounded yet
  if (to.k === "p" && to.calc) {
    if (from.k === "p") return {...expr, type: to, fromP: from.calc ? expr.fromP : from};
    if (from.k === "i" || from.k === "int8") return ok("i2pc");
    if (charlike(from)) return ok("c2pc");
    throw new Unsupported(`conversion ${from.k} -> calculation type p`);
  }
  // into a p field: rounded half away from zero to its decimals; a value
  // that does not fit raises CX_SY_ARITHMETIC_OVERFLOW after arithmetic and
  // CX_SY_CONVERSION_OVERFLOW after a move
  if (to.k === "p") {
    const arith = expr.e === "bin" || expr.e === "neg" || (expr.e === "fn" && expr.name === "IPOW");
    if (from.k === "p") return {...ok("p2p"), arith};
    if (from.k === "i" || from.k === "int8") return ok("i2p");
    if (from.k === "f") return ok("f2p");
    // a character literal is converted at build time (CONSTANTS ... TYPE
    // timestamp VALUE '20260912010000'); one that is no number or does not
    // fit is refused here rather than raised at run time
    if ((expr.e === "chars" || expr.e === "str") && charlike(from)) {
      const v = packedLiteral(expr.value, to);
      if (v === null) throw new Unsupported(`the literal '${expr.value}' is no number or does not fit p LENGTH ${to.len} DECIMALS ${to.dec}`);
      return {e: "str", value: v, type: to};
    }
    if (charlike(from)) return ok("c2p");
    if (from.k === "n") return ok("c2p");
    throw new Unsupported(`conversion ${from.k} -> p`);
  }
  if (from.k === "p") {
    const arith = expr.e === "bin" || expr.e === "neg" || (expr.e === "fn" && expr.name === "IPOW");
    if (to.k === "i" || to.k === "int8") return {...ok(to.k === "i" ? "p2i" : "p2i8"), arith};
    if (to.k === "f") return ok("p2f");
    // into characters and n: the field's own decimals (a calculation type
    // p value has none fixed, and what a system prints for it is not
    // measured beyond + and -)
    if (from.calc && ["string", "c", "n"].includes(to.k)) throw new Unsupported(`an arithmetic expression of type p moved into a ${to.k}: not measured`);
    if (to.k === "string") return ok("p2s");
    if (to.k === "c") return ok("p2c");
    if (to.k === "n") return ok("p2n");
    throw new Unsupported(`conversion p -> ${to.k}`);
  }
  // x / xstring into characters: the hex digits, upper case, zeros kept; a c
  // target cuts them to its length (A4H 2026-09-23: x'0A0B' into c(3) is 0A0)
  if ((to.k === "string" || to.k === "c") && (from.k === "x" || from.k === "xstring")) return ok("x2s");
  if (to.k === "struct" && charlike(from) && PROGRAM) {
    const fields = PROGRAM.structs.get(to.go)?.fields;
    if (fields?.length && fields.every((f) => f.type.k === "c" && Number.isInteger(f.type.len))) {
      return {e: "conv", kind: "char_to_struct", from, to, x: expr, type: to,
        fields: fields.map((f) => ({name: f.name, len: f.type.len}))};
    }
  }
  if (from.k === "struct" && to.k === "string" && PROGRAM) {
    const fields = PROGRAM.structs.get(from.go)?.fields;
    if (fields?.length && fields.every((f) => f.type.k === "c" && Number.isInteger(f.type.len))) {
      return {e: "conv", kind: "flat_struct_string", from, to, x: expr, type: to,
        fields: fields.map((f) => ({name: f.name, len: f.type.len}))};
    }
  }
  // characters into x / xstring (A4H 2026-09-24, ZCL_GOGEN_T_XCONV, and the
  // same rule for UPDATE SET raw = string, ZCL_GOGEN_T_RAWSTR): the longest
  // prefix of upper-case hex digits (a lower-case letter, a blank or a G ends
  // it), an odd count padded with 0; into x LENGTH n then cut or 00-padded
  if ((to.k === "x" || to.k === "xstring") && charlike(from)) return ok("c2x");
  // x <-> xstring: the bytes; into x LENGTH n cut or padded right with 00
  if (to.k === "x" && (from.k === "xstring" || from.k === "x")) return ok("xs2x");
  if (to.k === "xstring" && from.k === "x") return {...expr, type: to};
  // x / xstring -> i/int8: last four/eight bytes, zero-extended, then signed.
  // (A4H: FF gives 255; ultra/bytecmp 2026-09-24, ZCL_GOGEN_T_XMOVI:
  // FFFFFFFF -1, 80000000 -2147483648, 0100000002 2 for an x and an
  // xstring, an empty xstring 0; ZCL_ABAPGIT_CONVERT=>XSTRING_TO_INT)
  if (["i", "int8"].includes(to.k) && ["x", "xstring"].includes(from.k)) return ok(to.k === "i" ? "x2i" : "x2i8");
  if (numeric(to) && charlike(from)) return ok("c2n");
  // ultra/events (fix round): a move INTO a SORTED table sorts the rows (and
  // raises on a duplicate of a unique key), which no emitter does, so a
  // table of another kind or key refuses here; out of a SORTED table into a
  // STANDARD one the rows keep their order, which is what a slice does
  if (to.k === "table" && from.k === "table" && to.sorted && !sameSort(from, to)) {
    if (!sameType(from.row, to.row) || to.row.k !== "struct") throw new Unsupported(`a move into a SORTED table from a table of another kind or key`);
    const fields = PROGRAM?.structs.get(to.row.go)?.fields ?? [];
    const keys = to.sorted.map((name) => fields.find((f) => f.name === name));
    if (keys.some((k) => !k || !["string", "c", "n", "d", "t", "i", "int8"].includes(k.type.k))) throw new Unsupported(`a move into a SORTED table with a key outside the subset`);
    return {e: "sorted_move", x: expr, keys: to.sorted, unique: to.unique, type: to};
  }
  if (to.k === "table" && from.k === "table" && sameType(from.row, to.row)) return expr;
  // two structures of one technical type (the same components in the same
  // order, each of the same type and length; names may differ): a move is
  // component by component in order, as ABAP moves compatible structures.
  // Anything else between structures (a layout move of another shape) is
  // refused. A T100 key constant into TEXTID is the case that needs it.
  if (from.k === "struct" && to.k === "struct" && PROGRAM) {
    const ff = PROGRAM.structs.get(from.go)?.fields;
    const tf = PROGRAM.structs.get(to.go)?.fields;
    /** @param {import("./ir.ts").Type} t @returns {boolean} */ const flat = (t) => !["struct", "table", "ref", "data", "dref", "exc"].includes(t.k);
    if (ff && tf && ff.length === tf.length && ff.every((f, i) => flat(f.type) && sameType(f.type, tf[i].type) && (f.type.len ?? null) === (tf[i].type.len ?? null))) {
      return {e: "conv", kind: "struct_layout", from, to, x: expr, type: to, pairs: tf.map((f, i) => [f.name, ff[i].name])};
    }
  }
  if (from.k === "ref" && to.k === "ref") {
    // up-cast: a class into an interface it implements, or any reference into
    // the same interface; a down-cast needs CAST and is refused
    if (to.intf && (to.name === "OBJECT" || implementsIntf(expr, from.name, to.name))) return {e: "upcast", x: expr, type: to};
    if (!to.intf && !from.intf && REG && ancestors(REG, from.name).includes(to.name)) return {e: "upcast", x: expr, type: to};
    throw new Unsupported(`reference ${from.name} -> ${to.name}`);
  }
  // ultra/events: a standard table into a standard table of another row
  // type, row by row as a move converts the row (RAISE EVENT of abapGit's
  // viewer: POSTDATA of c 1024 lines into c 256 lines, QUERY_TABLE of one
  // flat structure into another)
  if (from.k === "table" && to.k === "table" && !from.sorted && !to.sorted && !from.hashed && !to.hashed) {
    const row = convert({e: "temp", name: "ConvRow", type: from.row}, to.row);
    return {e: "conv", kind: "table_rows", from, to, x: expr, row, type: to};
  }
  throw new Unsupported(`conversion ${from.k} -> ${to.k}`);
}

/** a ?= b and CAST: to a class or interface reference, checked at run time
 * (CX_SY_MOVE_CAST_ERROR); an up-cast needs no check */
/** @param {import("./frontend-types.ts").ValueExpr} x @param {import("./ir.ts").Type} to @param {string} text @returns {import("./frontend-types.ts").ValueExpr} */ function downCast(x, to, text) {
  if (x.type.k !== "ref" || to.k !== "ref") throw new Unsupported(`cast of a ${x.type.k} to a ${to.k}: ${text}`);
  try { return convert(x, to); } catch (e) { if (!(e instanceof Unsupported)) throw e; }
  return {e: "cast", x, type: to};
}

/** @type {import("@abaplint/core").IRegistry | null} */ let REG = null;
/** @type {import("./frontend-types.ts").FrontendProgram | null} */ let PROGRAM = null;
/** @param {import("./ir.ts").Expr} expr @param {string} cls @param {string} intf @returns {boolean} */ function implementsIntf(expr, cls, intf) {
  if (cls === intf) return true;
  for (const c of [cls, ...(REG ? ancestors(REG, cls) : [])]) {
    const def = REG?.getObject("CLAS", c)?.getDefinition() ?? REG?.getObject("INTF", c)?.getDefinition() ?? (PERSIST_LOWERING ? PROGRAM.localDefs : LOCAL_DEFS).get(c);
    if ((def?.getImplementing?.() ?? []).some((i) => upper(i.name) === intf || (REG && componentInterfaces(REG, upper(i.name)).includes(intf)))) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- conditions */

/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./ir.ts").Condition} */ function cond(node, ctx) {
  /** @type {import("./frontend-types.ts").SyntaxNode[]} */ const parts = [];
  /** @type {string[]} */ const ops = [];
  for (const k of node.getChildren()) {
    if (k instanceof Nodes.TokenNode) ops.push(upper(tokenStr(k)));
    else parts.push(k);
  }
  /** @param {import("./frontend-types.ts").SyntaxNode} n @returns {import("./ir.ts").Condition} */ const one = (n) => {
    if (isExpr(n, Expressions.Compare)) return compare(n, ctx);
    if (isExpr(n, Expressions.CondSub)) {
      const not = n.getChildren().some((c) => isTok(c, "NOT"));
      const inner = cond(n.findDirectExpression(Expressions.Cond), ctx);
      return not ? {c: "not", x: inner} : inner;
    }
    throw new Unsupported(`condition part ${n.get().constructor.name}`);
  };
  /** @type {import("./ir.ts").Condition[]} */ const orList = [];
  /** @type {import("./ir.ts").Condition} */ let current = one(parts[0]);
  for (let i = 0; i < ops.length; i += 1) {
    const next = one(parts[i + 1]);
    if (ops[i] === "AND") current = {c: "and", l: current, r: next};
    else if (ops[i] === "OR") { orList.push(current); current = next; }
    else throw new Unsupported(`condition operator ${ops[i]}`);
  }
  orList.push(current);
  return orList.reduce((l, r) => ({c: "or", l, r}));
}

/** @type {Readonly<Record<string, string>>} */ const OPS = {EQ: "=", NE: "<>", LT: "<", LE: "<=", GT: ">", GE: ">="};

/** @param {import("@abaplint/core").Nodes.ExpressionNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./ir.ts").Condition} */ function compare(node, ctx) {
  const kids = node.getChildren();
  // only a leading NOT negates the whole comparison; the NOT of IS NOT
  // INITIAL / IS NOT BOUND is read from the text below (counting both made
  // `x IS NOT INITIAL` true for an empty x)
  const not = kids.length > 0 && isTok(kids[0], "NOT");
  const sources = node.findDirectExpressions(Expressions.Source);
  const text = upper(node.concatTokens());
  const instanceClass = node.findDirectExpression(Expressions.ClassName);
  if (/\bIS\s+(NOT\s+)?INSTANCE\s+OF\b/.test(text) && sources.length === 1 && instanceClass !== undefined) {
    const value = source(sources[0], ctx);
    if (value.type.k !== "ref") throw new Unsupported(`IS INSTANCE OF a ${value.type.k}`);
    const target = namedType(instanceClass, ctx);
    if (target.intf) ctx.program.interfaces.add(target.name);
    /** @type {import("./ir.ts").Condition} */ const result = {c: "instance_of", x: value, type: target, initial: upcastable(ctx.reg, value.type, target)};
    return /\bIS\s+NOT\s+INSTANCE\s+OF\b/.test(text) !== not ? {c: "not", x: result} : result;
  }
  if (/\bIS\s+(NOT\s+)?SUPPLIED\b/.test(text)) {
    const nm = upper(/^(?:NOT\s+)?(\S+)\s+IS\b/.exec(text)?.[1] ?? "");
    if (!ctx.sig.params.some((p) => p.suppliedOf === nm)) throw new Unsupported(`${nm} IS SUPPLIED: not a parameter this method's declaration tracks`);
    /** @type {import("./ir.ts").Condition} */ const r = {c: "not", x: {c: "initial", x: {e: "var", name: `SUP_${nm}`, type: C(1)}}};
    return /\bIS\s+NOT\s+SUPPLIED\b/.test(text) !== not ? {c: "not", x: r} : r;
  }
  if (/\bIS\s+(NOT\s+)?ASSIGNED\b/.test(text)) {
    const nm = /<[\w]+>/.exec(text)?.[0];
    if (!nm || !ctx.fieldSymbols.has(nm)) throw new Unsupported(`IS ASSIGNED: ${text}`);
    fsCheck(nm, ctx);
    /** @type {import("./ir.ts").Condition} */ const r = {c: "assigned", fs: {e: "fs", name: nm, type: ctx.fieldSymbols.get(nm)}};
    return /\bIS\s+NOT\s+ASSIGNED\b/.test(text) !== not ? {c: "not", x: r} : r;
  }
  if (/\bIS\s+(NOT\s+)?BOUND\b/.test(text) && sources.length === 1) {
    const v = source(sources[0], ctx);
    if (v.type.k === "dref") {
      /** @type {import("./ir.ts").Condition} */ const r = {c: "initial", x: v};
      return /\bIS\s+NOT\s+BOUND\b/.test(text) !== not ? r : {c: "not", x: r};
    }
    if (v.type.k === "data") {
      /** @type {import("./ir.ts").Condition} */ const r = {c: "data_bound", x: v};
      return /\bIS\s+NOT\s+BOUND\b/.test(text) !== not ? {c: "not", x: r} : r;
    }
    if (!["ref", "exc"].includes(v.type.k)) throw new Unsupported(`IS BOUND of a ${v.type.k}`);
    /** @type {import("./ir.ts").Condition} */ const r = {c: "initial", x: v};
    return /\bIS\s+NOT\s+BOUND\b/.test(text) !== not ? r : {c: "not", x: r};
  }
  if (/\bIS\s+(NOT\s+)?INITIAL\b/.test(text) && sources.length === 1) {
    const v = source(sources[0], ctx);
    /** @type {import("./ir.ts").Condition} */ const r = {c: "initial", x: v};
    return /\bIS\s+NOT\s+INITIAL\b/.test(text) !== not ? {c: "not", x: r} : r;
  }
  // line_exists( itab[ c = v ... ] ) (ultra/events, CL_GUI_CONTAINER=>ADD_CHILD
  // and CL_GUI_HTML_VIEWER=>DISPATCH_SAPEVENT): whether READ TABLE ... WITH
  // KEY with the same components would find a row, without sy-subrc
  const pf = node.findDirectExpression(Expressions.MethodCallChain);
  if (pf && sources.length === 0 && /^LINE_EXISTS$/i.test(pf.findDirectExpression(Expressions.MethodCall)?.findDirectExpression(Expressions.MethodName)?.concatTokens() ?? "")) {
    /** @type {import("./ir.ts").Condition} */ const r = lineExists(pf, ctx);
    return not ? {c: "not", x: r} : r;
  }
  const opNode = node.findDirectExpression(Expressions.CompareOperator);
  const opText = upper(opNode?.concatTokens() ?? (upper(kids[1]?.concatTokens()) === "IN" ? "IN" : ""));
  if (sources.length !== 2 || !opText) throw new Unsupported(`comparison ${node.concatTokens()}`);
  const op = OPS[opText] ?? opText;
  if (op === "IN") {
    const value = source(sources[0], ctx);
    const range = source(sources[1], ctx);
    const fields = range.type.k === "table" && range.type.row.k === "struct"
      ? ctx.program.structs.get(range.type.row.go)?.fields ?? [] : [];
    const byName = new Map(fields.map((f) => [f.name, f]));
    if (value.type.k !== "i" || !["SIGN", "OPTION", "LOW", "HIGH"].every((n) => byName.has(n))
        || byName.get("LOW").type.k !== "i" || byName.get("HIGH").type.k !== "i") throw new Unsupported(`IN range outside the integer selection subset: ${node.concatTokens()}`);
    /** @type {import("./ir.ts").Condition} */ const result = {c: "in_range", value, range};
    return not ? {c: "not", x: result} : result;
  }
  const stringCond = ["CP", "NP", "CA", "NA", "CS", "NS", "CO", "CN"].includes(op) ? stringComparison(op, source(sources[0], ctx), source(sources[1], ctx)) : null;
  if (stringCond) return not ? {c: "not", x: stringCond} : stringCond;
  if (!["=", "<>", "<", "<=", ">", ">="].includes(op)) throw new Unsupported(`comparison operator ${op}`);
  const types = [...leafTypes(sources[0], ctx), ...leafTypes(sources[1], ctx)];
  /** @type {import("./ir.ts").Condition} */ let r;
  const arithL = hasArith(sources[0]);
  const arithR = hasArith(sources[1]);
  // an arithmetic expression compared with a character operand does not
  // activate on A4H ("An arithmetic expression cannot be compared with the
  // non-numeric operand"; `lv_s + 0` can be)
  for (const [a, other] of [[arithL, sources[1]], [arithR, sources[0]]]) {
    if (a && !hasArith(other) && leafTypes(other, ctx).some(charlike)) {
      throw new Unsupported(`an arithmetic expression compared with the character operand ${other.concatTokens()} (does not activate on A4H)`);
    }
  }
  // byte-like operands (ultra/bytecmp, A4H 2026-09-24, $ZOSG_TMP_0480,
  // testdata ZCL_GOGEN_T_XCMP / _XCMPN)
  if (!arithL && !arithR && types.some((t) => t.k === "x" || t.k === "xstring")) {
    const bl = source(sources[0], ctx);
    const br = source(sources[1], ctx);
    const r2 = compareBytes(op, bl, br, node);
    if (r2) return not ? {c: "not", x: r2} : r2;
  }
  // calculation type p for the comparison (A4H 2026-09-24, PDFMT c: and
  // PDCMP): a p on either side, or a character operand inside arithmetic
  // (`lv_i * 86400 * 1000 > lv_s + 0` does not overflow i); a p against a
  // character operand compares numbers ('1.50' = 1.5)
  if (!types.some((t) => t.k === "f") && (types.some((t) => t.k === "p") || ((arithL || arithR) && types.some(charlike)))) {
    const odd = types.find((t) => !["p", "i", "int8", "c", "string"].includes(t.k));
    if (odd) throw new Unsupported(`comparison of p with a ${odd.k}: ${node.concatTokens()}`);
    r = {c: "cmp", op, l: convert(arith(sources[0], ctx, arithL ? P31 : undefined), P31), r: convert(arith(sources[1], ctx, arithR ? P31 : undefined), P31), type: P31};
    return not ? {c: "not", x: r} : r;
  }
  if (types.some(numeric) || (types.some((t) => t.k === "p") && types.some((t) => t.k === "f"))) {
    // numbers compare numerically; a character operand is converted to the
    // numeric type (f when any operand is f). Against i it is converted to
    // i, rounded (A4H PDCALC: '-0.4' < 0 is false, '1.4' = 1 is true)
    const calc = types.some((t) => t.k === "f") ? F : types.some((t) => t.k === "int8") ? INT8 : I;
    if (types.some(charlike) && calc.k === "int8") throw new Unsupported(`comparison of int8 with characters: ${node.concatTokens()}`);
    r = {c: "cmp", op, l: convert(arith(sources[0], ctx, arithL ? calc : undefined), calc), r: convert(arith(sources[1], ctx, arithR ? calc : undefined), calc), type: calc};
  } else {
    r = compareValues(op, source(sources[0], ctx), source(sources[1], ctx), ctx);
  }
  return not ? {c: "not", x: r} : r;
}

/** line_exists( itab[ c1 = v1 c2 = v2 ... ] ) and itab[ table_line = v ]: the
 * keys as READ TABLE ... WITH KEY builds them (each value converted to the
 * component's type) */
/** @param {import("@abaplint/core").Nodes.ExpressionNode} chain @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./ir.ts").Condition} */ function lineExists(chain, ctx) {
  const src = chain.findFirstExpression(Expressions.MethodCallParam)?.findDirectExpression(Expressions.Source);
  const fc = src?.findDirectExpression(Expressions.FieldChain);
  const fk = fc?.getChildren() ?? [];
  const te = fk.at(-1);
  if (!fc || !isExpr(te, Expressions.TableExpression)) throw new Unsupported(`line_exists form: ${chain.concatTokens()}`);
  const head = {getChildren: () => fk.slice(0, -1), concatTokens: () => fk.slice(0, -1).map((k) => k.concatTokens()).join(""),
    findFirstExpression: (t) => fk.slice(0, -1).map((k) => (isExpr(k, t) ? k : k.findFirstExpression?.(t))).find(Boolean), get: () => fc.get()};
  const table = fk.length === 2 ? sourceOperand(fk[0], ctx) : fieldChain(head, ctx);
  if (table.type.k !== "table") throw new Unsupported("line_exists of a non-table");
  const inner = te.getChildren().filter((c) => !isTok(c, "[") && !isTok(c, "]"));
  /** @type {import("./ir.ts").TableKey[]} */ const keys = [];
  for (let i = 0; i < inner.length; i += 3) {
    const comp = inner[i];
    if (!isExpr(comp, Expressions.ComponentChainSimple) || !isTok(inner[i + 1], "=") || !isExpr(inner[i + 2], Expressions.Source)) {
      throw new Unsupported(`line_exists key form: ${te.concatTokens()}`);
    }
    const cname = upper(comp.concatTokens());
    if (cname === "TABLE_LINE") keys.push({line: true, value: convert(source(inner[i + 2], ctx, table.type.row), table.type.row)});
    else {
      const f = fieldOf(ctx, table.type.row, cname, te.concatTokens());
      keys.push({name: f.name, value: convert(source(inner[i + 2], ctx, f.type), f.type)});
    }
  }
  if (keys.length === 0) throw new Unsupported(`line_exists key form: ${te.concatTokens()}`);
  return {c: "line_exists", table, keys};
}

/** A comparison with an x or an xstring on either side, as A4H answers it
 * (ultra/bytecmp, 2026-09-24, $ZOSG_TMP_0480; the transpiler differs in
 * the x-x and numeric rules, ANORMALIES byte-like-comparisons):
 * - x against x: the shorter is padded with 00 on the right (x'AB' = x'AB00');
 * - xstring against xstring or an x: the bytes in order, a prefix is the
 *   smaller (x'AB' < xstring AB00), an x keeps its trailing 00 bytes;
 *   v+off(len) of an xstring is an xstring;
 * - against c or string (literal or not): the byte operand becomes its hex
 *   digits in upper case, then it is a character comparison (x'FF' <> 'ff',
 *   x'FF' < 'ff', x'00' <> '0', an empty xstring = ' ');
 * - against i/int8: convert bytes to that integer. ABAPiti 007 measured
 *   x4 FFFFFFFF = i -1 / int8 4294967295, x4 00000005 = i 5 (NE 6),
 *   x4 80000000 = INT_MIN, x8 FFFFFFFFFFFFFFFF = int8 -1, and
 *   xstring FFFFFFFF = i -1. Xstring vs int8, x1 vs int8, x9 and other
 *   extensions remain documentation, unmeasured. Short inputs zero-extend;
 *   n retains the measured i rule.
 * Anything else with a byte operand (p, f, d, t, ...) is refused.
 * null when neither side is byte-like. */
/** @param {string} op @param {import("./frontend-types.ts").ValueExpr} l @param {import("./frontend-types.ts").ValueExpr} r @param {import("./frontend-types.ts").TokenText} node @returns {import("./ir.ts").Condition | null} */ function compareBytes(op, l, r, node) {
  /** @param {import("./ir.ts").Type} t @returns {t is Extract<import("./ir.ts").Type, {k: "x" | "xstring"}>} */ const isB = (t) => t.k === "x" || t.k === "xstring";
  if (!isB(l.type) && !isB(r.type)) return null;
  /** @param {import("./frontend-types.ts").ValueExpr} x @param {string} kind @param {import("./ir.ts").Type} to @returns {Extract<import("./frontend-types.ts").ValueExpr, {e: "conv"}>} */ const conv = (x, kind, to) => ({e: "conv", kind, from: x.type, to, x, type: to});
  if (isB(l.type) && isB(r.type)) {
    if (l.type.k === "x" && r.type.k === "x") {
      const len = Math.max(l.type.len, r.type.len);
      /** @param {import("./frontend-types.ts").ValueExpr} x @returns {import("./frontend-types.ts").ValueExpr} */ const pad = (x) => (x.type.len === len ? x : conv(x, "xs2x", X(len)));
      return {c: "cmp", op, l: pad(l), r: pad(r), type: X(len)};
    }
    /** @param {import("./frontend-types.ts").ValueExpr} x @returns {import("./frontend-types.ts").ValueExpr} */ const xs = (x) => (x.type.k === "xstring" ? x : {...x, type: XS});
    return {c: "cmp", op, l: xs(l), r: xs(r), type: XS};
  }
  const [b, o] = isB(l.type) ? [l, r] : [r, l];
  /** @param {import("./frontend-types.ts").ValueExpr} x @returns {import("./frontend-types.ts").ValueExpr | null} */ const side = (x) => (x === b ? null : x);
  if (charlike(o.type)) {
    const hex = conv(b, "x2s", S);
    const ch = convert(o, S);
    return {c: "cmp", op, l: side(l) ? ch : hex, r: side(r) ? ch : hex, type: S};
  }
  if (["i", "int8", "n"].includes(o.type.k)) {
    const n = convert(b, o.type.k === "int8" ? INT8 : I);
    // n: its digits as a number, as the c2n of a comparison with i reads them
    const other = o.type.k === "n" ? conv(o, "c2n", I) : o;
    return {c: "cmp", op, l: side(l) ? other : n, r: side(r) ? other : n, type: n.type};
  }
  throw new Unsupported(`comparison of ${l.type.k} with ${r.type.k}: not measured: ${node.concatTokens()}`);
}

/** character comparisons: c ignores trailing blanks, which the stored form already has */
/** @param {string} op @param {import("./frontend-types.ts").ValueExpr} l @param {import("./frontend-types.ts").ValueExpr} r @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./ir.ts").Condition} */ function compareValues(op, l, r, ctx) {
  // CASE and table-row comparisons arrive here without the syntax-node path
  // in compare(), but use the same byte rules as IF comparisons.
  if ([l.type, r.type].some((t) => t.k === "x" || t.k === "xstring")) {
    const bytes = compareBytes(op, l, r, {concatTokens: () => `${l.type.k} ${op} ${r.type.k}`});
    if (bytes) return bytes;
  }
  // two tables of one row type, = or <>: the same number of rows and each
  // row equal to the one at its index, a row of a structure component by
  // component by the rules below (the report converter of open-abap-gui
  // compares a select-option's ranges this way). Other operators order
  // tables by rules not measured here; deep rows are refused
  if (l.type.k === "table" && r.type.k === "table") {
    if (op !== "=" && op !== "<>") throw new Unsupported(`comparison of tables with ${op}`);
    if (!sameType(l.type.row, r.type.row)) throw new Unsupported("comparison of tables of different row types");
    // a hashed table's order after DELETE and INSERT is not measured
    if (l.type.hashed || r.type.hashed) throw new Unsupported("comparison of hashed tables");
    const rowType = l.type.row;
    /** @type {import("./frontend-types.ts").ValueExpr} */ const a = {e: "var", name: `TEQ_${ctx.temps++}`, type: rowType};
    /** @type {import("./frontend-types.ts").ValueExpr} */ const b = {e: "var", name: `TEQ_${ctx.temps++}`, type: rowType};
    ctx.locals.set(a.name, rowType);
    ctx.locals.set(b.name, rowType);
    /** @type {import("./ir.ts").Condition | undefined} */ let rowEq;
    if (rowType.k === "struct") {
      const st = structOf(ctx, rowType);
      if (!st) throw new Unsupported("comparison of tables: a row structure not in the program");
      for (const f of st.fields) {
        if (["struct", "table", "ref", "data", "dref"].includes(f.type.k)) throw new Unsupported(`comparison of tables with a deep component ${f.name}`);
        const one = compareValues("=", {e: "field", base: a, name: f.name, type: f.type}, {e: "field", base: b, name: f.name, type: f.type}, ctx);
        rowEq = rowEq ? {c: "and", l: rowEq, r: one} : one;
      }
    } else if (!["struct", "table", "ref", "data", "dref"].includes(rowType.k)) {
      rowEq = compareValues("=", a, b, ctx);
    } else {
      throw new Unsupported(`comparison of tables of ${rowType.k} rows`);
    }
    return {c: "tableeq", op, l, r, a, b, rowEq: rowEq ?? {c: "true"}};
  }
  if (numeric(l.type) || numeric(r.type)) {
    const calc = l.type.k === "f" || r.type.k === "f" ? F : l.type.k === "int8" || r.type.k === "int8" ? INT8 : I;
    return {c: "cmp", op, l: convert(l, calc), r: convert(r, calc), type: calc};
  }
  if ((l.type.k === "d" && charlike(r.type)) || (r.type.k === "d" && charlike(l.type))) {
    return {c: "cmp", op, l: convert(l, S), r: convert(r, S), type: S};
  }
  if (charlike(l.type) && charlike(r.type)) return {c: "cmp", op, l: convert(l, S), r: convert(r, S), type: S};
  // NUMC against character text compares its stored digits as text. The
  // selection-screen renderer joins a screen number (n4) with an optional
  // tab screen held as string; neither side is arithmetic here.
  if ([l.type, r.type].every((t) => charlike(t) || t.k === "n")) {
    return {c: "cmp", op, l: convert(l, S), r: convert(r, S), type: S};
  }
  // n with n of one length: their digits in order, which is their numeric
  // order (A4H: 9000000017 > 9000000000, ZCL_GOGEN_T_NUMC); other lengths
  // are not measured
  if (l.type.k === "n" && r.type.k === "n" && l.type.len === r.type.len) return {c: "cmp", op, l: convert(l, S), r: convert(r, S), type: S};
  // two object references, = and <>: the same object or not (ultra/json)
  if (["ref", "exc"].includes(l.type.k) && ["ref", "exc"].includes(r.type.k) && (op === "=" || op === "<>")) return {c: "refeq", op, l, r};
  // parity-wave1: a generic operand against a c, a string or another
  // generic operand (A4H ZCL_GOGEN_T_GENCMP): holding a c or a string at
  // run time, the typed rule above, both read as strings and a c without
  // its trailing blanks (`AB ` <> 'AB', 'AB' = `AB`, '' = ``, ' ' <> ` `).
  // Holding anything else it dumps NOT_COMPILED (abap.DataChars): those
  // comparisons are numeric or by other rules, not measured here
  /** @param {import("./frontend-types.ts").ValueExpr} x @returns {boolean} */ const gen = (x) => x.type.k === "data" && !x.type.table;
  if (gen(l) && gen(r) && l.type.numeric && r.type.numeric) {
    return {c: "num_data_cmp", op, l, r};
  }
  if ((gen(l) || gen(r)) && [l, r].every((x) => gen(x) || charlike(x.type))) {
    /** @param {import("./frontend-types.ts").ValueExpr} x @returns {import("./frontend-types.ts").ValueExpr} */ const side = (x) => (gen(x) ? {e: "unwrap_chars", x, type: S} : convert(x, S));
    return {c: "cmp", op, l: side(l), r: side(r), type: S};
  }
  throw new Unsupported(`comparison of ${l.type.k} with ${r.type.k}`);
}

export {variable, refAttribute, constructorSignature, convert, defaultValue, withSupplied, ddicOutputLength, REG, clasDef, fieldChain, isVariableName, BIT_OPS, call, cond, constructor, descrAttr, findAttribute, genericArith, hasArith, hasBitOp, hasPow, items, leafTypes, omittedFactoryCall, template};
