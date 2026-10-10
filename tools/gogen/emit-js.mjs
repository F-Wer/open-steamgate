import {ipow, boolx} from "./ipow-js.mjs";
import {emitBuiltinJs} from "./emit-builtins.mjs";
// IR -> JavaScript, from the same IR as emit-go.mjs.
//
// The point is a measurement: how much of the Go backend's speed is the
// language, and how much is the value model the IR allows -- plain numbers
// instead of boxed ABAP values, synchronous calls instead of an await on
// every one, no type test on every operator. This emitter keeps the model
// and changes only the language.
//
// Values: i and f are numbers, c / x / string are strings, a structure is an
// object, a table an array; a structure or table moved out of a place is
// copied (abap.copy), which is ABAP's value semantics. An EXPORTING
// parameter is a box {v}.
import {emitSectionStatement} from "./emit-js-section.mjs";
import {ident as goIdent, funcName, referencedClasses, hexBytes, definable} from "./emit-go.mjs";

const JS_RESERVED = new Set(("await catch class const debugger delete do enum export extends finally function in instanceof let "
  + "super this throw try typeof void while with yield arguments eval implements private protected public static").split(" "));
const ident = (name) => {
  const id = goIdent(name);
  return JS_RESERVED.has(id) ? `${id}_` : id;
};

const typeName = (s) => {
  const name = String(s).toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return name.startsWith("_") ? `N${name}` : name;
};

/** a constant's or an attribute's VALUE as a JS literal */
function literal(c) {
  // a structured constant: frozen, so a write through an alias fails loudly
  if (c.type.k === "struct") {
    const fields = STRUCTS.get(c.type.go)?.fields ?? [];
    return `Object.freeze({${fields.map((f) => `${ident(f.name)}: ${c.value[f.name] === undefined ? zero(f.type) : literal({type: f.type, value: c.value[f.name]})}`).join(", ")}})`;
  }
  if (c.type.k === "i" || c.type.k === "f") return String(Number(c.value));
  if (c.type.k === "int8") return `${BigInt(c.value)}n`;
  if (c.type.k === "x" || c.type.k === "xstring") return JSON.stringify(String.fromCharCode(...hexBytes(c.value, c.type.len)));
  return JSON.stringify(c.type.k === "c" ? c.value.replace(/ +$/, "") : c.value);
}

function zero(t) {
  switch (t.k) {
    case "i": case "f": return "0";
    case "int8": return "0n";
    case "string": case "c": case "xstring": return `""`;
    case "x": return JSON.stringify("\u0000".repeat(t.len));
    case "table": return "[]";
    case "struct": return `new_${t.go}()`;
    case "ref": case "exc": case "data": case "dref": return "null";
    case "d": return `"00000000"`;
    case "p": return JSON.stringify(t.calc || !t.dec ? "0" : `0.${"0".repeat(t.dec)}`);
    case "t": return `"000000"`;
    case "n": return JSON.stringify("0".repeat(t.len));
    default: throw new Error(`no zero for ${t.k}`);
  }
}
const composite = (t) => t.k === "struct" || t.k === "table";
const isPlace = (e) => ["var", "attr", "static", "field", "fs", "row", "refattr"].includes(e.e);

let STRUCTS = new Map();

/*
 * Generic data (TYPE any, ANY TABLE, REF TO data), the design of go/abap
 * data.go: a generic value is a binding {get, set, t} to the slot it stands
 * for, never a copy, and t is a descriptor. Elementary descriptors are in the
 * runtime; one per structure and table type is generated here (DESCS) and
 * written at the end of the module.
 */
let DESCS = new Map();
const typeKey = (t) => (t.k === "struct" ? `s:${t.go}` : t.k === "table" ? `t${t.sorted ? "s" : t.hashed ? "h" : ""}:${typeKey(t.row)}` : `${t.k}:${t.len ?? ""}:${t.dec ?? ""}:${t.name ?? ""}`);
function desc(t) {
  switch (t.k) {
    case "i": return "abap.TI";
    case "int8": return "abap.TInt8";
    case "f": return "abap.TF";
    case "string": return "abap.TString";
    case "xstring": return "abap.TXString";
    case "c": return `abap.TC(${t.len ?? 0})`;
    case "x": return `abap.TX(${t.len ?? 0})`;
    case "d": return "abap.TD";
    case "p": return `abap.TP(${t.len ?? 8}, ${t.dec ?? 0})`;
    case "t": return "abap.TT";
    case "n": return `abap.TN(${t.len})`;
    case "dref": return "abap.TRef";
    case "ref": case "exc": return "abap.TObj";
    case "struct": case "table": {
      const key = typeKey(t);
      if (!DESCS.has(key)) DESCS.set(key, {name: `td_${DESCS.size}`, type: t});
      return DESCS.get(key).name;
    }
    default: throw new Error(`no descriptor for ${t.k}`);
  }
}
/** a structure that holds a string, a table or a reference, at any depth: type kind v (A4H) */
function deep(t) {
  if (["string", "xstring", "table", "ref", "exc", "dref", "data"].includes(t?.k)) return true;
  if (t?.k === "struct") return (STRUCTS.get(t.go)?.fields ?? []).some((f) => deep(f.type));
  return false;
}
function descDecls() {
  const decl = [];
  const fill = [];
  const done = new Set();
  for (let again = true; again;) {
    again = false;
    for (const [key, d] of [...DESCS]) {
      if (done.has(key)) continue;
      done.add(key);
      again = true;
      const t = d.type;
      if (t.k === "table") {
        // a SORTED or HASHED table takes no generic APPEND (ultra/events, as go/abap AppendData)
        decl.push(`const ${d.name} = {kind: "h", row: null, ${t.hashed ? "hashed: true, " : ""}zero: () => []${t.sorted || t.hashed ? ", noAppend: true" : ""}};`);
        fill.push(`${d.name}.row = ${desc(t.row)};`);
      } else {
        const fs = STRUCTS.get(t.go)?.fields ?? [];
        decl.push(`const ${d.name} = {kind: "${deep(t) ? "v" : "u"}", comps: [], zero: () => new_${t.go}()};`);
        fill.push(`${d.name}.comps = [${fs.map((f) => `{name: ${JSON.stringify(String(f.name).toUpperCase())}, key: ${JSON.stringify(ident(f.name))}, t: ${desc(f.type)}}`).join(", ")}];`);
      }
    }
  }
  return decl.length ? ["// descriptors of the types generic data binds to", ...decl, ...fill, ""] : [];
}

/**
 * a typed place seen as generic data: a binding that reaches the slot the
 * way Go's &place does. What Go fixes when it takes the address is fixed
 * here once too (the row of a table, the object of a reference, a typed
 * field symbol); a variable, an attribute or a field is reached through its
 * name on every access, so a structure moved into the variable later is the
 * one written.
 */
function bind(p, ctx) {
  const caps = [];
  const cap = (code) => { const n = `$c${caps.length}`; caps.push(`const ${n} = ${code};`); return n; };
  const path = (q) => {
    switch (q.e) {
      case "var": case "attr": case "static": case "const": return place(q, ctx);
      case "field": return `${path(q.base)}.${ident(q.name)}`;
      case "fs": return cap(ident(q.name));
      case "refattr": return `${cap(expr(q.base, ctx))}.${ident(q.name)}`;
      case "row": {
        const b = cap(path(q.base));
        return `${b}[${cap(`abap.Idx(${b}.length, ${expr(q.index, ctx)})`)}]`;
      }
      default: throw new Error(`not a place: ${q.e}`);
    }
  };
  const at = path(p);
  // a typed field symbol as a whole is a value held, not a slot: a structure
  // or table in it is written in place (abap.MoveData / ClearData do so
  // anyway); an elementary one has no slot the JS side could write to
  const whole = p.e === "fs";
  const set = !whole ? `($v) => { ${at} = $v; }`
    : composite(p.type) ? `($v) => { abap.Overwrite(${desc(p.type)}, ${at}, $v); }`
      : `() => { throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`a write through generic data bound to the typed field symbol ${p.name} of an elementary type: the JS backend holds its value, not its slot`)}); }`;
  const b = `{get: () => ${at}, set: ${set}, t: ${desc(p.type)}}`;
  return caps.length ? `(() => { ${caps.join(" ")} return ${b}; })()` : b;
}

export function emitJs(program, runtimeUrl = "./abap.mjs") {
  STRUCTS = program.structs;
  DESCS = new Map();
  const out = [ipow.toString(), boolx.toString()];
  out.push("// Code generated by tools/gogen/emit-js.mjs. DO NOT EDIT.", `import * as abap from ${JSON.stringify(runtimeUrl)};`, "");
  if (program.classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "hashchar.Calculate"))) out.push('import {createHash} from "crypto-browserify";', 'import {Buffer} from "buffer";', "");
  for (const st of program.structs.values()) {
    out.push(`export function new_${st.go}() {`, `  return {${st.fields.map((f) => `${ident(f.name)}: ${zero(f.type)}`).join(", ")}};`, "}");
  }
  out.push("");
  for (const c of program.consts.values()) out.push(`const ${c.go} = ${literal(c)};`);
  out.push("");
  const compiledNames = new Set(program.classes.map((c) => c.name));
  for (const name of referencedClasses(program)) if (!compiledNames.has(name)) out.push(`export class ${typeName(name)} {}`);
  // a superclass is declared before its subclasses
  const byName = new Map(program.classes.map((c) => [c.name, c]));
  BYNAME = byName;
  const ordered = [];
  const placed = new Set();
  const put = (c) => { if (placed.has(c.name)) return; placed.add(c.name); if (c.super && byName.has(c.super)) put(byName.get(c.super)); ordered.push(c); };
  program.classes.forEach(put);
  // what a class is, for casts and CREATE OBJECT by name: itself, its
  // superclasses and every interface along the chain
  const isOf = (c) => {
    const names = [];
    for (let x = c; x; x = x.super ? byName.get(x.super) : null) names.push(x.name, ...(x.interfaces ?? []));
    return names;
  };
  for (const cls of ordered) {
    const inst = (cls.attributes ?? []).filter((a) => !a.static && !a.unsupported);
    out.push(`export class ${typeName(cls.name)}${cls.super ? ` extends ${typeName(cls.super)}` : ""} {`, "  constructor() {");
    if (cls.super) out.push("    super();");
    for (const a of inst) out.push(`    this.${ident(a.name)} = ${a.value === undefined ? zero(a.type) : literal(a)};`);
    out.push("  }");
    for (const a of (cls.attributes ?? []).filter((x) => x.static && !x.unsupported)) {
      out.push(`  static ${ident(a.name)} = ${a.value === undefined ? zero(a.type) : literal(a)};`);
    }
    // the nearest constructor of the chain runs; the object inherits it
    const chain = [cls];
    for (let c = cls; c.super && byName.has(c.super);) { c = byName.get(c.super); chain.push(c); }
    const ctorAt = chain.find((c) => c.constructor || c.ctorParams);
    const cp = ctorAt ? (ctorAt.constructor?.params ?? ctorAt.ctorParams ?? []) : [];
    out.push(`  static $is = new Set(${JSON.stringify(isOf(cls))});`);
    // ultra/events: CLASS_CONSTRUCTOR at the first use, as emit-go (chainCctor)
    if (chainCctor(cls)) {
      out.push(`  static $ensure(s) {`, `    if (Object.prototype.hasOwnProperty.call(${typeName(cls.name)}, "$cc")) return;`, `    ${typeName(cls.name)}.$cc = true;`);
      // ultra/events (fix round): an exception out of it is a runtime error
      // and the next use runs it again (abap.CctorGuard in emit-go)
      out.push("    try {");
      if (cls.super && byName.get(cls.super) && chainCctor(byName.get(cls.super))) out.push(`      ${typeName(cls.super)}.$ensure(s);`);
      if (ownCctor(cls)) out.push(`      ${typeName(cls.name)}.CLASS_CONSTRUCTOR(s);`);
      out.push(`    } catch (e) { delete ${typeName(cls.name)}.$cc; throw abap.cctorDump(${JSON.stringify(cls.name)}, e); }`);
      out.push("  }");
    }
    out.push(`  static $abap = ${JSON.stringify(cls.name)};`);
    out.push(`  static $new(${["s", ...cp.map((p) => ident(p.name))].join(", ")}) {`, ...(chainCctor(cls) ? [`    ${typeName(cls.name)}.$ensure(s);`] : []), `    const o = new ${typeName(cls.name)}();`,
      ...(ctorAt?.constructor ? [`    o.CONSTRUCTOR(${["s", ...cp.map((p) => ident(p.name))].join(", ")});`] : []), "    return o;", "  }");
    const all = [...cls.methods, ...(cls.constructor ? [{...cls.constructor, name: "CONSTRUCTOR", static: false}] : [])];
    for (const m of all) out.push(...method(cls, m));
    for (const m of cls.stubs ?? []) {
      if (m.name === "CONSTRUCTOR") continue;
      out.push(`  ${m.static ? "static " : ""}${typeName(m.name)}() { throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${cls.name}=>${m.name}: ${m.reason}`)}); }`);
    }
    out.push("}", "");
    if (cls.abstract) continue;
    // CREATE OBJECT ... TYPE (name) passes no arguments
    const make = cp.length === 0 ? `(s) => ${typeName(cls.name)}.$new(s)`
      : `() => { throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${cls.name}=>CONSTRUCTOR: CREATE OBJECT by name of a class whose constructor has parameters`)}); }`;
    out.push(`abap.registerClass(${JSON.stringify(cls.name)}, ${JSON.stringify(isOf(cls))}, ${make});`, "");
  }
  const supers = Object.entries(program.exceptionSupers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (supers.length) out.push(`abap.registerSupers(${JSON.stringify(Object.fromEntries(supers))});`, "");
  out.push(...staticRegistry(program));
  out.push(...descDecls());
  return out.join("\n") + "\n";
}

/**
 * CALL METHOD (class)=>m, as emit-go's staticRegistry: every compiled class is
 * known by name, and each static method a dynamic call names gets an adapter
 * that reads its arguments out of generic data by name.
 */
function staticRegistry(program) {
  const wanted = program.dynStatics ?? new Set();
  if (wanted.size === 0) return [];
  const out = [`abap.knownClasses(${JSON.stringify(program.classes.map((c) => c.name))}, ${JSON.stringify([...(program.rtti?.known ?? [])].filter((n) => !n.includes("=>")))});`];
  for (const cls of program.classes) {
    for (const m of [...cls.methods, ...(cls.stubs ?? [])]) {
      if (!m.static || !wanted.has(m.name) || !m.params || !definable(program, m)) continue;
      const lines = [];
      const args = m.params.map((p, i) => {
        const v = `v${i}`;
        if (p.dir !== "importing") { lines.push(`  const ${v} = {v: ${zero(p.type)}};`); return v; }
        if (p.suppliedOf) { lines.push(`  const ${v} = ${JSON.stringify(p.suppliedOf)} in a ? "X" : "";`); return v; }
        const d = `a[${JSON.stringify(p.name)}]`;
        const read = ["i", "string", "c", "d", "t"].includes(p.type.k) ? unwrapTo(p.type, d)
          : p.type.k === "data" ? d : composite(p.type) && p.byValue ? `abap.copy(${d}.get())` : `${d}.get()`;
        const absent = p.optional && p.default === undefined ? zero(p.type)
          : `abap.paramMissing(${JSON.stringify(`${cls.name}=>${m.name} ${p.name}`)})`;
        lines.push(`  const ${v} = ${JSON.stringify(p.name)} in a ? ${read} : ${absent};`);
        return v;
      });
      out.push(`abap.registerStatic(${JSON.stringify(`${cls.name}=>${m.name}`)}, ${JSON.stringify(m.params.filter((p) => p.dir === "importing").map((p) => p.name))}, (s, a) => {`,
        ...lines, `  ${typeName(cls.name)}.${typeName(m.name)}(${["s", ...args].join(", ")});`, "});");
    }
  }
  out.push("");
  return out;
}

/* class-based exceptions: see catchCond in emit-go.mjs */
function catchCondJs(c) {
  const parts = [];
  if (c.covers.length) parts.push(`(xE instanceof abap.AbapError && ${JSON.stringify(c.covers)}.includes(xE.cls))`);
  if (c.own.length) parts.push(`(xE instanceof abap.Raised && (${c.own.map((x) => `abap.isA(xE.cls, ${JSON.stringify(x)})`).join(" || ")}))`);
  return parts.length ? `(abap.catchable(xE) && (${parts.join(" || ")}))` : "false";
}

function catchIntoJs(c, t, ctx) {
  if (!c.into) return "";
  // a ref INTO takes the object; an exception value is the error itself; the
  // target is a local, or an attribute of the class (a report's global data)
  return `${t}    ${c.intoPlace ? place(c.intoPlace, ctx) : ident(c.into)} = ${c.intoKind === "ref" ? "xE.obj" : "xE"};\n`;
}

// ultra/events: see chainCctor in emit-go.mjs
const ownCctor = (cls) => cls.name !== "CL_ABAP_CHAR_UTILITIES"
  && (cls.methods.some((m) => m.name === "CLASS_CONSTRUCTOR") || (cls.stubs ?? []).some((m) => m.name === "CLASS_CONSTRUCTOR"));
let BYNAME = new Map();
function chainCctor(cls) {
  for (let c = cls; c; c = c.super ? BYNAME.get(c.super) : null) if (ownCctor(c)) return true;
  return false;
}

function method(cls, m) {
  const params = ["s", ...m.params.map((p) => ident(p.name))];
  const head = `  ${m.static ? "static " : ""}${typeName(m.name)}(${params.join(", ")}) {`;
  const lines = [head];
  if (m.static && m.name !== "CLASS_CONSTRUCTOR" && chainCctor(cls)) lines.push(`    ${typeName(cls.name)}.$ensure(s);`);
  if (!m.static) lines.push("    const me = this;");
  const ret = m.returning ? ident(m.returning.name) : null;
  if (m.returning) lines.push(`    let ${ret} = ${zero(m.returning.type)};`);
  for (const l of m.locals) lines.push(`    let ${ident(l.name)} = ${zero(l.type)};`);
  for (const f of m.fieldSymbols ?? []) lines.push(`    let ${ident(f.name)} = null;`);
  const ctx = {cls, method: m, loop: 0, ret, inCtor: m.name === "CONSTRUCTOR"};
  // ultra/events: a field symbol of anything but a structure row or generic
  // data would need a box for the place it points at; refused here honestly
  const odd = (m.fieldSymbols ?? []).find((f) => f.type.k !== "struct" && f.type.k !== "data" && !["i", "int8", "string", "c", "n", "p", "d", "t", "x", "xstring", "f"].includes(f.type.k));
  if (odd) lines.push(`    throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${cls.name}=>${m.name}: field symbol ${odd.name} of a ${odd.type.k}: the JS emitter holds only rows of structures`)});`);
  else lines.push(...m.body.flatMap((st) => stmt(st, ctx, 2)));
  if (ret) lines.push(`    return ${ret};`);
  lines.push("  }");
  return lines;
}

const tab = (n) => "  ".repeat(n);

function place(p, ctx) {
  switch (p.e) {
    case "var": return p.box ? `${ident(p.name)}.v` : ident(p.name);
    case "attr": return `me.${ident(p.name)}`;
    case "sy": return `s.sy.${p.field.toLowerCase()}`;
    case "const": return p.go;
    case "static": {
      const [cls, attr] = p.go.split("__");
      return `${p.owner ? `(${cls}.$ensure?.(s), ${cls})` : cls}.${ident(attr)}`;
    }
    case "field": return `${["var", "attr", "static", "field", "fs", "row", "refattr", "const"].includes(p.base.e) ? place(p.base, ctx) : `(${expr(p.base, ctx)})`}.${ident(p.name)}`;
    case "dref_field": return `${expr(p.base, ctx)}.get().${ident(p.name)}`;
    case "fs": return p.type.k === "struct" || p.type.k === "data" ? ident(p.name) : `${ident(p.name)}.get()`;
    case "refattr": return `${expr(p.base, ctx)}.${ident(p.name)}`;
    case "row": {
      const b = place(p.base, ctx);
      return `${b}[abap.Idx(${b}.length, ${expr(p.index, ctx)})]`;
    }
    default: throw new Error(`not a place: ${p.e}`);
  }
}

/** a value moved somewhere: a structure or table read out of a place is copied */
/** one condition of an internal table's WHERE, as emit-go whereItem */
function whereItem(w, row, ctx) {
  const saved = ctx.lrow;
  ctx.lrow = row;
  try {
    if (w.op === "initial" || w.op === "notinitial") {
      const c = cond({c: "initial", x: w.fx}, ctx);
      return w.op === "initial" ? c : `!(${c})`;
    }
    const lhs = w.fx ? expr(w.fx, ctx) : `${row}.${ident(w.name)}`;
    return `${lhs} ${w.op === "=" ? "===" : w.op === "<>" ? "!==" : w.op} ${expr(w.value, ctx)}`;
  } finally {
    ctx.lrow = saved;
  }
}
const moved = (e, ctx) => (composite(e.type) && isPlace(e) ? `abap.copy(${expr(e, ctx)})` : expr(e, ctx));
const boundRow = (table, tb, index) => ["data", "struct"].includes(table.row.k) ? `${tb}[${index}]` : `abap.bindRow(() => ${tb}, ${index})`;
const rowRef = (table, tb, index) => table.row.k === "struct" ? `abap.cell(${tb}[${index}], ${desc(table.row)}, ${tb})` : `abap.rowCell(() => ${tb}, ${index}, ${desc(table.row)})`;

/* sorted secondary keys (frontend secondaryKey, ultra/json): as emit-go keyLoop / readSecKey */
function keyCmpJs(key, x, y) {
  return key.comps.map((c) => `abap.cmpKey(${x}.${ident(c.name)}, ${y}.${ident(c.name)})`).join(" || ") + " || 0";
}

function keyLoop(st, ctx, t, d) {
  const n = ctx.loop++;
  const tb = expr(st.table, ctx);
  const r = `${tb}[ord${n}[k${n}]]`;
  const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, `ord${n}[k${n}]`)}` : `${place(st.into, ctx)} = ${composite(st.into.type) ? `abap.copy(${r})` : r}`;
  return [
    `${t}{`, `${t}  const save${n} = s.sy.tabix;`, `${t}  s.sy.subrc = 4;`,
    `${t}  const ord${n} = abap.keyOrder(${tb}, (a, b) => ${keyCmpJs(st.key, "a", "b")}, ${st.key.unique ? JSON.stringify(st.key.name) : `""`});`,
    `${t}  for (let k${n} = 0; k${n} < ord${n}.length; k${n}++) {`,
    ...(st.where ? [`${t}    if (!(${st.where.map((w) => `${r}.${ident(w.name)} ${w.op === "=" ? "===" : w.op === "<>" ? "!==" : w.op} ${expr(w.value, ctx)}`).join(" && ")})) continue;`] : []),
    `${t}    s.sy.tabix = k${n} + 1; s.sy.subrc = 0;`, `${t}    ${bind};`,
    ...st.body.flatMap((x) => stmt(x, ctx, d + 2)),
    `${t}  }`, `${t}  s.sy.tabix = save${n};`, `${t}}`,
  ];
}

// a hashed secondary key, as emit-go keyEq (temporaries kV/kI/kR: no ABAP
// name is spelled with an upper case letter after the first)
function keyEq(key, n) {
  return `(kR) => ${key.comps.map((c, j) => `abap.cmpKey(kR.${ident(c.name)}, kV${n}[${j}]) === 0`).join(" && ")}`;
}

function readSecKey(st, ctx, t) {
  const n = ctx.loop++;
  const tb = expr(st.table, ctx);
  const vals = `[${st.values.map((v) => expr(v, ctx)).join(", ")}]`;
  if (st.key.hashed) {
    const at = `kI${n}`;
    const bindH = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, at)};` : st.refInto ? `${place(st.into, ctx)} = ${rowRef(st.table.type, tb, at)};` : st.into ? `${place(st.into, ctx)} = ${composite(st.into.type) ? `abap.copy(${tb}[${at}])` : `${tb}[${at}]`};` : "";
    return [`${t}{`, `${t}  const kV${n} = ${vals};`,
      `${t}  const ${at} = abap.keyFind(${tb}, ${keyEq(st.key, n)}, ${JSON.stringify(st.key.name)});`,
      `${t}  s.sy.subrc = 4; s.sy.tabix = 0;`, `${t}  if (${at} >= 0) { ${bindH} s.sy.subrc = 0; }`, `${t}}`];
  }
  const cmp = st.key.comps.map((c, j) => `abap.cmpKey(r.${ident(c.name)}, v${n}[${j}])`).join(" || ") + " || 0";
  const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, `i${n}`)};` : st.refInto ? `${place(st.into, ctx)} = ${rowRef(st.table.type, tb, `i${n}`)};` : st.into ? `${place(st.into, ctx)} = ${composite(st.into.type) ? `abap.copy(${tb}[i${n}])` : `${tb}[i${n}]`};` : "";
  return [`${t}{`, `${t}  const v${n} = ${vals};`,
    `${t}  const [i${n}, pos${n}, sub${n}] = abap.keyRead(${tb}, (r) => ${cmp}, ${st.key.unique ? JSON.stringify(st.key.name) : `""`});`,
    `${t}  if (sub${n} === 0) { ${bind} }`, `${t}  s.sy.subrc = sub${n}; s.sy.tabix = pos${n};`, `${t}}`];
}

function stmt(st, ctx, d) {
  const t = tab(d);
  switch (st.s) {
    case "assign":
      if (st.target.e === "fs" && st.target.type.k !== "struct" && st.target.type.k !== "data")
        return [`${t}${ident(st.target.name)}.set(${moved(st.value, ctx)});`];
      if (st.target.e === "substr_target") {
        const base = place(st.target.base, ctx);
        const off = st.target.off ? expr(st.target.off, ctx) : "0";
        const len = expr(st.target.len, ctx);
        return [`${t}${base} = ((b, o, n, v) => { abap.SubX(b, o, n); return b.slice(0, o) + abap.XFit(v, n) + b.slice(o + n); })(${base}, ${off}, ${len}, ${moved(st.value, ctx)});`];
      }
      // a field symbol is the row itself: assigning to it writes into the row
      if (st.target.e === "fs") return [`${t}Object.assign(${ident(st.target.name)}, ${moved(st.value, ctx)});`];
      return [...(st.target.type.k === "table" ? [`${t}abap.bumpTable(${place(st.target, ctx)});`] : []), `${t}${place(st.target, ctx)} = ${moved(st.value, ctx)};`];
    case "clear":
      // a field symbol is the row itself: clearing it clears the row
      if (st.target.e === "fs" && st.target.type.k === "struct") return [`${t}Object.assign(${ident(st.target.name)}, ${zero(st.target.type)});`];
      if (st.target.e === "fs" && st.target.type.k === "table") return [`${t}abap.bumpTable(${ident(st.target.name)});`, `${t}${ident(st.target.name)}.length = 0;`];
      return [...(st.target.type.k === "table" ? [`${t}abap.bumpTable(${place(st.target, ctx)});`] : []), `${t}${place(st.target, ctx)} = ${zero(st.target.type)};`];
    case "append": {
      const tb = place(st.table, ctx);
      const unique = (st.table.type.secondary ?? []).filter((k) => k.unique);
      if (unique.length) {
        // a unique secondary key (ultra/json): as emit-go, a repeated value is refused
        const n = ctx.loop++;
        return [`${t}{`, `${t}  const v${n} = ${moved(st.value, ctx)};`,
          ...unique.map((k) => `${t}  abap.uniqueKeyCheck(${tb}, (r) => ${k.comps.map((c) => `r.${ident(c)} === v${n}.${ident(c)}`).join(" && ")}, ${JSON.stringify(k.name)});`),
          `${t}  ${tb}.push(v${n});`, `${t}}`, `${t}abap.bumpTable(${tb});`, `${t}s.sy.tabix = ${tb}.length;`, ...(st.fs ? [`${t}${ident(st.fs)} = ${boundRow(st.table.type, tb, `${tb}.length - 1`)};`] : []),
          ...(st.refInto ? [`${t}${place(st.refInto, ctx)} = ${rowRef(st.table.type, tb, `${tb}.length - 1`)};`] : [])];
      }
      // ultra/events: APPEND ... ASSIGNING <fs> (a row of a structure only: see method)
      return [`${t}${tb}.push(${moved(st.value, ctx)});`, `${t}abap.bumpTable(${tb});`, `${t}s.sy.tabix = ${tb}.length;`, ...(st.fs ? [`${t}${ident(st.fs)} = ${boundRow(st.table.type, tb, `${tb}.length - 1`)};`] : []),
        ...(st.refInto ? [`${t}${place(st.refInto, ctx)} = ${rowRef(st.table.type, tb, `${tb}.length - 1`)};`] : [])];
    }
    case "concat": {
      const sep = st.sep ? expr(st.sep, ctx) : `""`;
      const joined = st.table ? `${expr(st.table, ctx)}.map((ConcatRow) => ${expr(st.row, ctx)}).join(${sep})` : `[${st.parts.map((x) => expr(x, ctx)).join(", ")}].join(${sep})`;
      const limit = st.target.type.k === "c" || st.target.type.k === "n" ? st.target.type.len : st.target.type.k === "d" ? 8 : -1;
      const value = st.target.type.k === "n" ? `abap.CToN(v, ${limit})` : st.target.type.k === "d" ? "abap.S2D(v)" : "v";
      return [`${t}{ const [v, rc] = abap.ConcatFit(${joined}, ${limit}); ${place(st.target, ctx)} = ${value}; s.sy.subrc = rc; }`];
    }
    case "replace_bytes": case "replace_chars": return emitSectionStatement(st, ctx, t, {expr, place});
    case "find_bytes":
      return [`${t}{ const fb = abap.FindBytes(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.secOff ? expr(st.secOff, ctx) : "0"}); if (fb >= 0) { ${st.off ? `${place(st.off, ctx)} = fb; ` : ""}s.sy.subrc = 0; } else { s.sy.subrc = 4; } }`];
    case "find_all": {
      const icase = st.icase.e === "flag" ? String(st.icase.value) : `(${expr(st.icase, ctx)} === "X")`;
      return [`${t}${place(st.count, ctx)} = abap.FindAllCount(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.regex}, ${icase}); s.sy.subrc = ${place(st.count, ctx)} > 0 ? 0 : 4;`];
    }
    case "read_index": {
      const n = `idx${ctx.loop++}`;
      const tb = expr(st.table, ctx);
      if (st.fs) {
        return [`${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)};`,
          `${t}  if (${n} >= 1 && ${n} <= ${tb}.length) { ${ident(st.fs)} = ${boundRow(st.table.type, tb, `${n} - 1`)}; s.sy.subrc = 0; } else { s.sy.subrc = 4; }`, `${t}}`];
      }
      const row = composite(st.into.type) ? `abap.copy(${tb}[${n} - 1])` : `${tb}[${n} - 1]`;
      return [
        `${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)};`,
        `${t}  if (${n} >= 1 && ${n} <= ${tb}.length) { ${place(st.into, ctx)} = ${row}; s.sy.subrc = 0; s.sy.tabix = ${n}; }`,
        `${t}  else { s.sy.subrc = 4; }`, `${t}}`,
      ];
    }
    case "translate": {
      const p = place(st.target, ctx);
      return [`${t}${p} = abap.${st.upper ? "ToUpper" : "ToLower"}(${p});`];
    }
    case "call": {
      if (st.call.e === "nop_call") return [];
      const c = st.call;
      const plain = c.receiving ? [`${t}${place(c.receiving, ctx)} = ${expr(c, ctx)};`] : callStmt(c, ctx, t);
      // ultra/events: a c field passed to a generic TYPE c keeps its length (emit-go)
      const fits = c.args.filter((a) => a.fitc).map((a) => `${t}${place(a.place, ctx)} = abap.CFit(${place(a.place, ctx)}, ${a.fitc});`);
      if (!c.exceptions) return [...plain, ...fits];
      return [`${t}try {`, ...plain.map((l) => `  ${l}`), `${t}  s.sy.subrc = 0;`,
        `${t}} catch (e) { abap.classic(s, e, ${JSON.stringify(c.callee)}, ${JSON.stringify(c.exceptions.map)}, ${c.exceptions.others}); }`, ...fits];
    }
    case "move_corr_data":
      return [`${t}abap.MoveCorrespondingData(${expr(st.to, ctx)}, ${expr(st.from, ctx)});`];
    case "shift_right_trailing": {
      const p = place(st.target, ctx);
      const mask = st.maskLen !== undefined ? `abap.PadC(${expr(st.mask, ctx)}, ${st.maskLen})` : expr(st.mask, ctx);
      return [`${t}${p} = abap.ShiftRightTrailing(${p}, ${mask});`];
    }
    case "shift_left_leading": {
      const p = place(st.target, ctx);
      const mask = st.maskLen !== undefined ? `abap.PadC(${expr(st.mask, ctx)}, ${st.maskLen})` : expr(st.mask, ctx);
      return [`${t}${p} = abap.ShiftLeftLeading(${p}, ${mask});`];
    }
    // CONCATENATE ... IN BYTE MODE (ultra/packs; see emit-go.mjs)
    case "shift_left_circ_bytes": {
      const p = place(st.target, ctx);
      return [`${t}${p} = ${p}.slice(1) + ${p}.slice(0, 1);`];
    }
    case "concat_bytes":
      if (st.table) return [`${t}${place(st.target, ctx)} = ${expr(st.table, ctx)}.map((ConcatRow) => ${expr(st.row, ctx)}).join("");`, `${t}s.sy.subrc = 0;`];
      if (st.fixed !== undefined) return [`${t}{ const j = ${st.parts.map((x) => expr(x, ctx)).join(" + ")}; ${place(st.target, ctx)} = abap.XFit(j, ${st.fixed}); s.sy.subrc = j.length > ${st.fixed} ? 4 : 0; }`];
      return [`${t}${place(st.target, ctx)} = ${st.parts.map((x) => expr(x, ctx)).join(" + ")};`, `${t}s.sy.subrc = 0;`];
    case "condense": {
      const p = place(st.target, ctx);
      return [`${t}${p} = abap.Condense(${p}, ${st.noGaps});`];
    }
    case "assign_comp":
      return [`${t}{`, `${t}  const c = abap.Component(${expr(st.from, ctx)}, ${expr(st.name, ctx)});`,
        `${t}  if (c !== null) { ${ident(st.fs.name)} = c; s.sy.subrc = 0; } else { ${st.name.type.k === "i" ? `${ident(st.fs.name)} = null; ` : ""}s.sy.subrc = 4; }`, `${t}}`];
    case "assign_deref":
      return [`${t}{`, `${t}  const r = ${expr(st.ref, ctx)};`, `${t}  if (r !== null) { ${ident(st.fs.name)} = r; s.sy.subrc = 0; } else { s.sy.subrc = 4; }`, `${t}}`];
    case "assign_deref_typed":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${st.text}: a typed field symbol over a data reference is Go-only`)});`];
    case "assign_data":
      return [`${t}${ident(st.fs.name)} = ${expr(st.value, ctx)};`];
    case "unassign":
      return [`${t}${ident(st.fs.name)} = null;`];
    // a move into generic data writes into the slot it is bound to
    // ultra/events: APPEND INITIAL LINE TO <generic table> ASSIGNING <generic> (emit-go)
    case "append_initial_data":
      return [`${t}{ const [r, i] = abap.AppendInitialData(${expr(st.table, ctx)}); ${ident(st.fs)} = r; s.sy.tabix = i; }`];
    case "append_data":
      return [`${t}s.sy.tabix = abap.AppendData(${expr(st.table, ctx)}, ${expr(st.value, ctx)});`];
    // ultra/json: as emit-go (js/abap.mjs InsertData, NewLine)
    case "insert_data":
      return [`${t}abap.InsertData(${expr(st.table, ctx)}, ${expr(st.value, ctx)}); s.sy.subrc = 0;`];
    case "create_data_line":
      return [`${t}${place(st.target, ctx)} = abap.NewLine(${expr(st.table, ctx)});`];
    case "set_data":
      return [`${t}abap.MoveData(${expr(st.target, ctx)}, ${expr(st.value, ctx)});`];
    case "clear_data":
      return [`${t}abap.ClearData(${expr(st.target, ctx)});`];
    case "get_ref":
      return [`${t}${place(st.target, ctx)} = ${expr(st.value, ctx)};`];
    // CREATE DATA ... TYPE <static type> (ultra/sadl): a new initial value
    case "create_data":
      return [`${t}${place(st.target, ctx)} = abap.cell(${zero(st.type)}, ${desc(st.type)});`];
    // the table registry is the Go host's (go/abap tables.go)
    case "create_data_dyn":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", "CREATE DATA TYPE (name): the JS backend has no table registry (the Go host has)");`];
    case "describe_kind":
      return [`${t}${place(st.target, ctx)} = ${expr(st.x, ctx)}.t.kind;`];
    // DELETE / READ TABLE ... INDEX on a generic table (ultra/sadl, the SADL DPC's paging)
    case "delete_index_data": {
      const n = `idx${ctx.loop++}`;
      return [`${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)};`, `${t}  if (abap.DeleteIndex(${expr(st.table, ctx)}, ${n})) {`,
        ...(st.tokens ?? []).map((token) => `${t}    if (${n} <= ${token.idxVar}+1) ${token.idxVar}--;`),
        `${t}    s.sy.subrc = 0;`, `${t}  } else { s.sy.subrc = 4; }`, `${t}}`];
    }
    case "read_index_data": {
      const n = `idx${ctx.loop++}`;
      return [`${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)}, tb${n} = ${expr(st.table, ctx)};`,
        `${t}  if (${n} >= 1 && ${n} <= abap.Lines(tb${n})) { ${ident(st.fs)} = abap.Row(tb${n}, ${n} - 1); s.sy.subrc = 0; s.sy.tabix = ${n}; } else { s.sy.subrc = 4; }`, `${t}}`];
    }
    case "loop_data": {
      if (st.fsType) return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${st.text}: a typed field symbol over generic rows is Go-only`)});`];
      const n = ctx.loop++;
      st.token.idxVar = `i${n}`;
      return [`${t}{`, `${t}  const tab${n} = ${expr(st.table, ctx)};`, `${t}  const save${n} = s.sy.tabix;`, `${t}  s.sy.subrc = 4;`,
        `${t}  for (let i${n} = 0; i${n} < abap.Lines(tab${n}); i${n}++) {`,
        `${t}    s.sy.tabix = i${n} + 1; s.sy.subrc = 0;`, `${t}    ${ident(st.fs)} = abap.Row(tab${n}, i${n});`,
        ...st.body.flatMap((x) => stmt(x, ctx, d + 2)), `${t}  }`, `${t}  s.sy.tabix = save${n};`, `${t}}`];
    }
    case "call_dyn_static":
      return [`${t}abap.CallStatic(s, ${expr(st.cls, ctx)}, ${JSON.stringify(st.method)}, {${st.args.map((a) => `${JSON.stringify(a.name)}: ${expr(a.value, ctx)}`).join(", ")}});`];
    // the JS side has no database: a SELECT is refused, not guessed
    case "select_dyn":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`dynamic SELECT: the JS backend has no database (the Go host has SQLite)`)});`];
    case "select_aggregate":
    case "select_table":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`SELECT ... FROM ${st.table}: the JS backend has no database (the Go host has SQLite)`)});`];
    case "select_single":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`SELECT SINGLE ... FROM ${st.table}: the JS backend has no database (the Go host has SQLite)`)});`];
    case "select_loop":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`SELECT ... FROM ${st.table} ... ENDSELECT: the JS backend has no database (the Go host has SQLite)`)});`];
    case "kernel_loop":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${st.fn}: a host function of the Go runtime`)});`];
    case "select_count":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`SELECT COUNT(*) FROM ${st.table}: the JS backend has no database (the Go host has SQLite)`)});`];
    case "select_sum":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`SELECT SUM(...) FROM ${st.table}: the JS backend has no database (the Go host has SQLite)`)});`];
    case "dataset_open": case "dataset_close": case "dataset_delete": case "dataset_transfer":
    case "dataset_read": case "dataset_get_position": case "dataset_set_position":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", "DATASET: the JS backend has no file system (the Go host has the sandbox of go/abap/dataset.go)");`];
    case "db_write_sql": case "db_write":
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${st.verb ?? st.op.toUpperCase()} ${st.table}: the JS backend has no database (the Go host has SQLite)`)});`];
    case "native":
      if (st.fn === "hashchar.Calculate") {
        const args = st.args.map((a) => expr(a.value, ctx));
        return [`${t}{ const hx = createHash(${args[0]}.toLowerCase()).update(${args[1]}).digest("hex").toUpperCase();`,
          `${t}  ${place(st.args[2].value, ctx)} = hx; ${place(st.args[3].value, ctx)} = hx;`,
          `${t}  ${place(st.args[4].value, ctx)} = Buffer.from(hx, "hex").toString("base64"); }`];
      }
      // see nativeMessageText in emit-go.mjs
      if (st.fn === "Native_GET_TEXT_FOR_MESSAGE") {
        // the names as the Go side derives them, so a renamed parameter or
        // attribute fails here as it fails there
        const x = ident(ctx.method.params[0].name);
        return [`${t}if (${x} === null || ${x}.constructor.$is.has("IF_T100_MESSAGE") || !${x}.constructor.$is.has("CX_ROOT") || ${x}.${ident("TEXTID")} !== "") throw new abap.AbapError("NOT_COMPILED", "CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE: T100 and OTR texts are not read here");`,
          `${t}return "An exception was raised.";`];
      }
      return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${st.fn}: a host function of the Go runtime`)});`];
    case "raise_classic":
      return [`${t}throw new abap.ClassicException(${JSON.stringify(st.name)}, ${JSON.stringify(st.method)});`];
    case "if": {
      const lines = [];
      st.branches.forEach((b, i) => {
        lines.push(`${t}${i === 0 ? "if" : "} else if"} (${cond(b.cond, ctx)}) {`);
        lines.push(...b.body.flatMap((x) => stmt(x, ctx, d + 1)));
      });
      if (st.else !== null) lines.push(`${t}} else {`, ...st.else.flatMap((x) => stmt(x, ctx, d + 1)));
      lines.push(`${t}}`);
      return lines;
    }
    case "case": {
      const lines = [`${t}{`, `${t}  const ${st.temp} = ${expr(st.subject, ctx)};`];
      st.branches.forEach((b, i) => {
        lines.push(`${t}  ${i === 0 ? "if" : "} else if"} (${cond(b.cond, ctx)}) {`);
        lines.push(...b.body.flatMap((x) => stmt(x, ctx, d + 2)));
      });
      if (st.else !== null) {
        lines.push(st.branches.length ? `${t}  } else {` : `${t}  {`);
        lines.push(...st.else.flatMap((x) => stmt(x, ctx, d + 2)));
      }
      if (st.branches.length || st.else !== null) lines.push(`${t}  }`);
      lines.push(`${t}}`);
      return lines;
    }
    case "do": {
      const n = ctx.loop++;
      const lines = [`${t}{`, `${t}  const save${n} = s.sy.index;`];
      if (st.times === null) lines.push(`${t}  for (let i${n} = 1; ; i${n}++) {`);
      else lines.push(`${t}  const n${n} = ${expr(st.times, ctx)};`, `${t}  for (let i${n} = 1; i${n} <= n${n}; i${n}++) {`);
      lines.push(`${t}    s.sy.index = i${n};`, ...st.body.flatMap((x) => stmt(x, ctx, d + 2)), `${t}  }`, `${t}  s.sy.index = save${n};`, `${t}}`);
      return lines;
    }
    case "while": {
      const n = ctx.loop++;
      return [
        `${t}{`, `${t}  const save${n} = s.sy.index;`,
        `${t}  for (let i${n} = 1; ${cond(st.cond, ctx)}; i${n}++) {`, `${t}    s.sy.index = i${n};`,
        ...st.body.flatMap((x) => stmt(x, ctx, d + 2)),
        `${t}  }`, `${t}  s.sy.index = save${n};`, `${t}}`,
      ];
    }
    case "loop": {
      if (st.dynamicKeys) {
        const branches = [{name: "PRIMARY_KEY", key: null}, ...st.dynamicKeys.options.map((key) => ({name: key.name, key}))];
        return [`${t}switch (${expr(st.dynamicKeys.value, ctx)}.toUpperCase()) {`, ...branches.flatMap((b) => [
          `${t}case ${JSON.stringify(b.name)}: {`, ...stmt({...st, dynamicKeys: null, key: b.key, token: {}}, ctx, d + 1), `${t}  break; }`,
        ]), `${t}default: throw new abap.AbapError("NOT_COMPILED", "LOOP USING KEY: dynamic key is not a declared sorted key");`, `${t}}`];
      }
      if (st.key) return keyLoop(st, ctx, t, d);
      const n = ctx.loop++;
      st.token.idxVar = `i${n}`; // ultra/itab: DELETE itab of the current row
      const tb = expr(st.table, ctx);
      const start = st.from ? `Math.max(${expr(st.from, ctx)} - 1, 0)` : "0";
      const limit = st.to ? ` && i${n} < ${expr(st.to, ctx)}` : "";
      const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, `i${n}`)}`
        : `${place(st.into, ctx)} = ${composite(st.into.type) ? `abap.copy(${tb}[i${n}])` : `${tb}[i${n}]`}`;
      return [
        `${t}{`, `${t}  const save${n} = s.sy.tabix;`, `${t}  s.sy.subrc = 4;`,
        `${t}  for (let i${n} = ${start}; i${n} < ${tb}.length${limit}; i${n}++) {`,
        ...(st.where ? [`${t}    if (!(${st.where.map((w) => whereItem(w, `${tb}[i${n}]`, ctx)).join(" && ")})) continue;`] : []),
        `${t}    s.sy.tabix = i${n} + 1; s.sy.subrc = 0;`, `${t}    ${bind};`,
        ...st.body.flatMap((x) => stmt(x, ctx, d + 2)),
        `${t}  }`, `${t}  s.sy.tabix = save${n};`, `${t}}`,
      ];
    }
    case "nop": return [];
    // an update-task module's LUW mark: without a database no COMMIT
    // here can read it, so it emits nothing
    case "note_update_task": return [];
    // the JS runtime has no database (select_table is not emitted either),
    // so there is no LUW to end: refused, not a no-op
    case "commit_work": case "rollback_work":
      return [`${t}abap.notCompiled("COMMIT / ROLLBACK WORK: the JS emitter has no database");`];
    case "modify_index": {
      const n = `idx${ctx.loop++}`;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)};`,
        `${t}  if (${n} >= 1 && ${n} <= ${tb}.length) { ${tb}[${n} - 1] = ${moved(st.value, ctx)}; s.sy.subrc = 0; } else { s.sy.subrc = 4; }`, `${t}}`];
    }
    case "split": return [`${t}${place(st.table, ctx)} = abap.Split(${expr(st.x, ctx)}, ${expr(st.sep, ctx)});`];
    case "split_into": return [`${t}{`, `${t}  const spl = abap.SplitInto(${expr(st.x, ctx)}, ${expr(st.sep, ctx)}, ${st.targets.length});`,
      `${t}  s.sy.subrc = abap.SplitSubrc(spl, [${st.lens.join(", ")}]);`,
      ...st.targets.map((x) => `${t}  ${place(x.target, ctx)} = ${expr(x.value, ctx)};`), `${t}}`];
    case "replace": {
      const p = place(st.target, ctx);
      return [`${t}{ const r = abap.ReplaceStmt(${p}, ${expr(st.pattern, ctx)}, ${expr(st.with, ctx)}, ${st.regex}, ${st.all}, ${st.icase}, ${st.off ? expr(st.off, ctx) : "0"}, ${st.len ? expr(st.len, ctx) : "abap.NoLength"}, ${st.cLen}); ${p} = r[0]; s.sy.subrc = r[1]; }`];
    }
    // CALL FUNCTION of a host module: the JS emitter has no host for them
    case "raise_runtime": return [`${t}throw new abap.AbapError(${JSON.stringify(st.cls)}, ${JSON.stringify(st.op)});`];
    case "call_fm": return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`CALL FUNCTION '${st.name}': the JS emitter has no host function modules`)});`];
    case "stub": return [`${t}throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`${st.where}: ${st.reason}`)});`];
    // ultra/events: SET HANDLER and RAISE EVENT, as emit-go (js/abap.mjs
    // setHandler / raiseEvent follow go/abap/events.go)
    case "get_timestamp": return [`${t}${place(st.target, ctx)} = abap.TimeStamp(${st.dec});`];
    case "set_handler": {
      const lines = [`${t}{`, `${t}  const EvFor = ${st.forObj ? expr(st.forObj, ctx) : "null"};`,
        `${t}  const EvOn = ${st.activation ? `abap.activation(${expr(st.activation, ctx)})` : "true"};`];
      for (const h of st.handlers) {
        const filter = h.filter ? `(o) => !!o?.constructor?.$is?.has(${JSON.stringify(h.filter)})` : "null";
        const obj = h.obj ? "EvH" : h.me ? "me" : "null";
        lines.push(`${t}  {`);
        if (h.obj) lines.push(`${t}    const EvH = abap.boundHandler(${expr(h.obj, ctx)});`);
        lines.push(`${t}    abap.setHandler(s, ${JSON.stringify(h.event)}, EvFor, ${st.all}, ${st.static}, ${obj}, ${JSON.stringify(h.key)}, ${filter}, (s, EvSender, EvA) => { ${expr(h.call, ctx)}; }, EvOn);`, `${t}  }`);
      }
      lines.push(`${t}}`);
      return lines;
    }
    case "raise_event": {
      const fields = st.args.map((a) => `${ident(a.name)}: ${moved(a.value, ctx)}`).join(", ");
      return [`${t}abap.raiseEvent(s, ${JSON.stringify(st.event)}, ${st.sender ? expr(st.sender, ctx) : "null"}, ${st.static}, () => ({${fields}}));`];
    }
    case "seq": return st.body.flatMap((x) => stmt(x, ctx, d));
    case "try": {
      const arms = st.catches.map((c, i) => `${i ? " else " : ""}if (${catchCondJs(c)}) {\n${catchIntoJs(c, t, ctx)}${c.body.flatMap((x) => stmt(x, ctx, d + 2)).join("\n")}\n${t}  }`);
      // a CLEANUP runs only when a TRY further out takes the exception: see
      // emit-go; the CATCHes of this TRY are registered while its body runs
      const cleanup = st.cleanup ? `if (abap.classBased(xE) && abap.handled(s, xE)) {\n${st.cleanup.flatMap((x) => stmt(x, ctx, d + 2)).join("\n")}\n${t}  } ` : "";
      const n = ctx.loop++;
      const guard = st.catches.length ? `(xE) => ${st.catches.map((c) => `(${catchCondJs(c)})`).join(" || ")}` : null;
      const body = st.body.flatMap((x) => stmt(x, ctx, d + 1));
      const tail = [`${t}} catch (xE) {`, ...(guard ? [`${t}  abap.popHandler(s, xH${n});`] : []),
        `${t}  ${arms.join("")}${arms.length ? " else " : ""}{ ${cleanup}throw xE; }`];
      if (!guard) return [`${t}try {`, ...body, ...tail, `${t}}`];
      return [`${t}{`, `${t}const xH${n} = abap.pushHandler(s, ${guard});`, `${t}try {`, ...body, ...tail, `${t}} finally {`, `${t}  abap.popHandler(s, xH${n});`, `${t}}`, `${t}}`];
    }
    case "raise": return [`${t}throw abap.raise(${expr(st.value, ctx)}, ${JSON.stringify(st.cls ?? "")});`];
    case "delete_adjacent": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const same = st.fields.map((f) => `rows${n}[i-1].${ident(f)} === rows${n}[i].${ident(f)}`).join(" && ");
      return [`${t}{ const rows${n} = ${tb}; const kept${n} = rows${n}.filter((_, i) => i === 0 || !(${same})); if (kept${n}.length !== rows${n}.length) { abap.bumpTable(rows${n}); ${tb} = kept${n}; } }`];
    }
    case "sort": {
      // Array.prototype.sort is stable; a key may be the line itself, p
      // compares as a number (ultra/itab)
      const tb = place(st.table, ctx);
      const cmp = st.keys.map((k) => {
        const [xv, yv] = k.line ? ["x", "y"] : [`x.${ident(k.name)}`, `y.${ident(k.name)}`];
        if (k.type.k === "p") return `{ const c = abap.CmpP(${xv}, ${yv}); if (c !== 0) return c * ${k.desc ? -1 : 1}; }`;
        return `if (${xv} !== ${yv}) return (${xv} < ${yv} ? -1 : 1) * ${k.desc ? -1 : 1};`;
      });
      return [`${t}${tb}.sort((x, y) => { ${cmp.join(" ")} return 0; });`, `${t}abap.bumpTable(${tb});`];
    }
    // ultra/itab: APPEND LINES OF, as emit-go
    case "append_lines": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const out = [`${t}{`, `${t}  const src${n} = ${expr(st.src, ctx)};`, `${t}  let lo${n} = 1, hi${n} = src${n}.length;`];
      const bound = (v, name, set) => [`${t}  { const b = ${expr(v, ctx)}; if (b <= 0) throw new abap.AbapError("TABLE_INVALID_INDEX", "APPEND LINES OF ... ${name} " + b); ${set} }`];
      if (st.from) out.push(...bound(st.from, "FROM", `lo${n} = b;`));
      if (st.to) out.push(...bound(st.to, "TO", `if (b < hi${n}) hi${n} = b;`));
      const saved = ctx.lrow;
      ctx.lrow = `r${n}`;
      const v = st.value.e === "lrow" ? (composite(st.value.type) ? `abap.copy(r${n})` : `r${n}`) : expr(st.value, ctx);
      ctx.lrow = saved;
      out.push(`${t}  for (let i${n} = lo${n}; i${n} <= hi${n}; i${n}++) { const r${n} = src${n}[i${n} - 1]; ${tb}.push(${v}); }`,
        `${t}  if (lo${n} <= hi${n}) abap.bumpTable(${tb});`, `${t}  s.sy.tabix = ${tb}.length;`, `${t}}`);
      return out;
    }
    // ultra/events: INSERT INTO TABLE of a SORTED table with a unique key (emit-go)
    case "insert_sorted": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const get = (r, k) => (k.line ? r : `${r}.${ident(k.name)}`);
      const cmp = st.keys.map((k) => `if (${get(`r${n}`, k)} !== ${get(`v${n}`, k)}) return ${get(`r${n}`, k)} > ${get(`v${n}`, k)} ? 1 : -1;`).join(" ");
      return [`${t}{`, `${t}  const v${n} = ${st.value.e === "lrow" && composite(st.value.type) ? `abap.copy(${expr(st.value, ctx)})` : moved(st.value, ctx)};`, `${t}  const cmp${n} = (r${n}) => { ${cmp} return 0; };`,
        `${t}  let pos${n} = ${tb}.length; s.sy.subrc = 0;`,
        `${t}  for (let i = 0; i < ${tb}.length; i++) { const c = cmp${n}(${tb}[i]); if (c === 0) { s.sy.subrc = 4; break; } if (c > 0) { pos${n} = i; break; } }`,
        `${t}  if (s.sy.subrc === 0) { ${tb}.splice(pos${n}, 0, v${n}); abap.bumpTable(${tb});${st.refInto ? ` ${place(st.refInto, ctx)} = ${rowRef(st.table.type, tb, `pos${n}`)};` : ""} }`, `${t}}`];
    }
    case "insert_lines_sorted": {
      const n = ctx.loop++;
      const saved = ctx.lrow;
      ctx.lrow = `line${n}`;
      const insertion = stmt({s: "insert_sorted", table: st.table, value: {e: "lrow", type: st.table.type.row}, keys: st.keys}, ctx, d + 1);
      ctx.lrow = saved;
      return [`${t}for (const line${n} of ${expr(st.src, ctx)}) {`, ...insertion, `${t}}`];
    }
    case "insert_table": {
      const tb = place(st.table, ctx);
      const v = `ins${ctx.loop++}`;
      if (!st.unique) return [`${t}${tb}.push(${moved(st.value, ctx)}); abap.bumpTable(${tb}); s.sy.subrc = 0;`];
      return [`${t}{`, `${t}  const ${v} = ${moved(st.value, ctx)};`,
        `${t}  if (${st.keys ? `${tb}.some((r) => ${st.keys.map((k) => `r.${ident(k)} === ${v}.${ident(k)}`).join(" && ")})` : `${tb}.includes(${v})`}) { s.sy.subrc = 4; } else { ${tb}.push(${v}); abap.bumpTable(${tb}); s.sy.subrc = 0; }`, `${t}}`];
    }
    case "assert":
      return [`${t}if (!(${cond(st.cond, ctx)})) throw new abap.AbapError("ASSERTION_FAILED", ${JSON.stringify(st.text)});`];
    case "create_dyn":
      return [`${t}${place(st.target, ctx)} = abap.createAs(s, ${expr(st.name, ctx)}, ${JSON.stringify(st.target.type.name)});`];
    case "read_seckey": return readSecKey(st, ctx, t);
    case "read_key": {
      const tb = expr(st.table, ctx);
      const n = ctx.loop++;
      const cond = st.keys.map((k) => (k.line ? `r${n} === ${expr(k.value, ctx)}` : `r${n}.${ident(k.name)} === ${expr(k.value, ctx)}`)).join(" && ");
      const bind = st.fs ? `${ident(st.fs)} = r${n};` : st.refInto ? `${place(st.into, ctx)} = ${rowRef(st.table.type, tb, `i${n}`)};` : st.into ? `${place(st.into, ctx)} = ${composite(st.into.type) ? `abap.copy(r${n})` : `r${n}`};` : "";
      // ultra/events (fix round): a SORTED table, as emit-go
      if (st.sorted) {
        const kv = (j) => `k${n}_${j}`;
        const get = (k) => (k.line ? `r${n}` : `r${n}.${ident(k.name)}`);
        const all = st.keys.map((k, j) => `${get(k)} === ${kv(j)}`).join(" && ");
        const decl = st.keys.map((k, j) => `${t}  const ${kv(j)} = ${expr(k.value, ctx)};`);
        const found = `{ ${bind} s.sy.subrc = 0; s.sy.tabix = i${n} + 1; hit${n} = true; break; }`;
        if (st.sorted.prefix.length === 0) {
          return [`${t}{`, ...decl, `${t}  let hit${n} = false;`, `${t}  for (let i${n} = 0; i${n} < ${tb}.length; i${n}++) {`, `${t}    const r${n} = ${tb}[i${n}];`,
            `${t}    if (${all}) ${found}`, `${t}  }`, `${t}  if (!hit${n}) { s.sy.subrc = 4; s.sy.tabix = 0; }`, `${t}}`];
        }
        const cmp = st.sorted.prefix.map((j) => `if (${get(st.keys[j])} !== ${kv(j)}) return ${get(st.keys[j])} > ${kv(j)} ? 1 : -1;`).join(" ");
        return [`${t}{`, ...decl, `${t}  const cmp${n} = (r${n}) => { ${cmp} return 0; };`, `${t}  let pos${n} = -1, hit${n} = false;`,
          `${t}  for (let i${n} = 0; i${n} < ${tb}.length; i${n}++) {`, `${t}    const r${n} = ${tb}[i${n}];`, `${t}    const c${n} = cmp${n}(r${n});`,
          `${t}    if (c${n} < 0) continue;`, `${t}    if (pos${n} < 0) pos${n} = i${n};`, `${t}    if (c${n} > 0) break;`, `${t}    if (${all}) ${found}`, `${t}  }`,
          `${t}  if (!hit${n}) {`,
          ...(st.sorted.extra ? [`${t}    throw new abap.AbapError("NOT_COMPILED", "READ TABLE: a miss on a SORTED table with a key part and components outside the key: not measured");`] : []),
          `${t}    s.sy.subrc = 4;`, `${t}    if (pos${n} < 0) { pos${n} = ${tb}.length; s.sy.subrc = 8; }`, `${t}    s.sy.tabix = pos${n} + 1;`, `${t}  }`, `${t}}`];
      }
      return [`${t}{`, `${t}  s.sy.subrc = 4;`, `${t}  for (let i${n} = 0; i${n} < ${tb}.length; i${n}++) {`, `${t}    const r${n} = ${tb}[i${n}];`,
        `${t}    if (${cond}) { ${bind} s.sy.subrc = 0; s.sy.tabix = ${st.hashed ? "0" : `i${n} + 1`}; break; }`, `${t}  }`, `${t}}`];
    }
    case "find": {
      // IN TABLE and IN SECTION (ultra/sadl): see abap.FindTable / abap.FindSection
      const call = st.table ? `const [fok, fline, foff, flen, fsub] = abap.FindTable(${expr(st.table, ctx)}, ${expr(st.pattern, ctx)}, ${st.regex}, ${st.icase}, ${st.subs.length});`
        : "secOff" in st ? `const [fok, foff, flen, fsub] = abap.FindSection(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.icase}, ${st.secOff ? expr(st.secOff, ctx) : "0"}, ${st.secLen ? expr(st.secLen, ctx) : "-1"}, ${st.subs.length});`
          : `const [fok, foff, flen, fsub] = abap.FindStmt(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.regex}, ${st.icase}, ${st.subs.length});`;
      const lines = [`${t}{`, `${t}  ${call}`,
        `${t}  if (fok) {`, `${t}    s.sy.subrc = 0;`];
      if (st.line) lines.push(`${t}    ${place(st.line, ctx)} = fline;`);
      if (st.off) lines.push(`${t}    ${place(st.off, ctx)} = foff;`);
      if (st.len) lines.push(`${t}    ${place(st.len, ctx)} = flen;`);
      for (const x of st.subs) lines.push(`${t}    ${place(x.target, ctx)} = ${expr(x.value, ctx)};`);
      lines.push(`${t}  } else { s.sy.subrc = 4; }`, `${t}}`);
      return lines;
    }
    // FIND ... RESULTS (parity-wave2): as emit-go
    case "find_results": {
      const n = ctx.loop++;
      const f = st.f;
      const tgt = place(st.target, ctx);
      const fill = (r) => `${r}.${ident(f.LINE)} = 0; ${r}.${ident(f.OFFSET)} = fm${n}[0]; ${r}.${ident(f.LENGTH)} = fm${n}[1]; ${r}.${ident(f.SUBMATCHES)} = [];`
        + ` for (let g = 2; g + 1 < fm${n}.length; g += 2) { const sr = ${zero(st.sub)}; sr.${ident(f.SOFFSET)} = fm${n}[g]; sr.${ident(f.SLENGTH)} = fm${n}[g + 1]; ${r}.${ident(f.SUBMATCHES)}.push(sr); }`;
      const call = `abap.FindResults(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${JSON.stringify(st.mode)}, ${st.icase}, ${st.all})`;
      if (st.table) {
        return [`${t}{ const fms${n} = ${call}; ${tgt} = []; s.sy.subrc = fms${n}.length > 0 ? 0 : 4;`,
          `${t}  for (const fm${n} of fms${n}) { const fr${n} = ${zero(st.row)}; ${fill(`fr${n}`)} ${tgt}.push(fr${n}); } }`];
      }
      return [`${t}{ const fms${n} = ${call}; s.sy.subrc = fms${n}.length > 0 ? 0 : 4;`,
        `${t}  if (fms${n}.length > 0) { const fm${n} = fms${n}[0]; const fr${n} = ${tgt}; ${fill(`fr${n}`)} } }`];
    }
    case "delete_where": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const keep = st.where.map((w) => whereItem(w, `r${n}`, ctx)).join(" && ");
      return [`${t}{`, `${t}  const kept${n} = ${tb}.filter((r${n}) => !(${keep}));`,
        `${t}  s.sy.subrc = kept${n}.length < ${tb}.length ? 0 : 4;`, `${t}  if (s.sy.subrc === 0) { abap.bumpTable(${tb}); ${tb} = kept${n}; }`, `${t}}`];
    }
    case "delete_key": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      return [`${t}{`, `${t}  const key${n} = ${expr(st.value, ctx)};`, `${t}  s.sy.subrc = 4;`,
        `${t}  const i${n} = ${tb}.findIndex((r${n}) => r${n}.${ident(st.key)} === key${n});`,
        `${t}  if (i${n} >= 0) { ${tb}.splice(i${n}, 1); abap.bumpTable(${tb}); s.sy.subrc = 0; }`, `${t}}`];
    }
    case "delete_seckey": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      return [`${t}{`, `${t}  const kV${n} = [${st.values.map((v) => expr(v, ctx)).join(", ")}];`, `${t}  s.sy.subrc = 4;`,
        `${t}  const kI${n} = abap.keyFind(${tb}, ${keyEq(st.key, n)}, ${JSON.stringify(st.key.name)});`,
        `${t}  if (kI${n} >= 0) { ${tb}.splice(kI${n}, 1); abap.bumpTable(${tb}); s.sy.subrc = 0; }`, `${t}}`];
    }
    case "delete_from": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      return [`${t}{`, `${t}  const wa${n} = ${expr(st.value, ctx)};`, `${t}  s.sy.subrc = 4;`,
        `${t}  const i${n} = ${tb}.findIndex((r${n}) => ${st.keys.map((k) => `r${n}.${ident(k)} === wa${n}.${ident(k)}`).join(" && ")});`,
        `${t}  if (i${n} >= 0) { ${tb}.splice(i${n}, 1); abap.bumpTable(${tb}); s.sy.subrc = 0; }`, `${t}}`];
    }
    // ultra/itab: DELETE itab inside LOOP AT itab, as emit-go
    case "delete_current": {
      const tb = place(st.table, ctx);
      const i = st.token.idxVar;
      return [`${t}${tb}.splice(${i}, 1); abap.bumpTable(${tb}); ${i}--; s.sy.subrc = 0;`];
    }
    case "delete_index": {
      const n = `idx${ctx.loop++}`;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)};`,
        `${t}  if (${n} >= 1 && ${n} <= ${tb}.length) { ${tb}.splice(${n} - 1, 1); abap.bumpTable(${tb});`,
        ...(st.tokens ?? []).map((token) => `${t}    if (${n} <= ${token.idxVar}+1) ${token.idxVar}--;`),
        `${t}    s.sy.subrc = 0; } else { s.sy.subrc = 4; }`, `${t}}`];
    }
    case "delete_range": {
      const n = ctx.loop++;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}  const from${n} = ${expr(st.from, ctx)};`, `${t}  const to${n} = ${st.to ? expr(st.to, ctx) : `${tb}.length`};`,
        `${t}  if (from${n} < 1 || to${n} < 1) throw new abap.AbapError("NOT_COMPILED", "DELETE range index below 1 was not measured");`,
        `${t}  const end${n} = Math.min(to${n}, ${tb}.length);`,
        `${t}  s.sy.subrc = 4;`, `${t}  if (from${n} <= end${n}) { ${tb}.splice(from${n} - 1, end${n} - from${n} + 1); abap.bumpTable(${tb}); s.sy.subrc = 0; }`, `${t}}`];
    }
    case "insert_index": {
      const n = `idx${ctx.loop++}`;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}  const ${n} = ${expr(st.index, ctx)};`,
        `${t}  if (${n} >= 1 && ${n} <= ${tb}.length + 1) { ${tb}.splice(${n} - 1, 0, ${moved(st.value, ctx)}); abap.bumpTable(${tb}); s.sy.subrc = 0; s.sy.tabix = ${n}; }`,
        `${t}  else { s.sy.subrc = 4; }`, `${t}}`];
    }
    case "exit": return [`${t}break;`];
    case "continue": return [`${t}continue;`];
    case "return": return [ctx.ret ? `${t}return ${ctx.ret};` : `${t}return;`];
    default: throw new Error(`no JS for statement ${st.s}`);
  }
}

/** an IMPORTING VALUE( ) table or structure is the callee's own copy */
function importingArg(a, ctx) {
  return a.byValue && (a.type?.k === "table" || a.type?.k === "struct") ? moved(a.value, ctx) : expr(a.value, ctx);
}

/** a call statement: EXPORTING parameters go through boxes and come back after the call */
function callStmt(e, ctx, t) {
  const boxes = [];
  const args = e.args.map((a, i) => {
    if (a.dir === "importing") return importingArg(a, ctx);
    const b = `box${ctx.loop++}_${i}`;
    boxes.push({b, a});
    return a.byValue ? `${b}_value` : b;
  });
  const lines = [`${t}{`];
  for (const {b, a} of boxes) lines.push(`${t}  const ${b} = {v: ${a.dir === "exporting" && a.byValue ? zero(a.type) : a.wrap ? expr(a.wrap, ctx) : a.place ? place(a.place, ctx) : zero(a.type)}};`);
  for (const {b, a} of boxes) if (a.byValue) lines.push(`${t}  const ${b}_value = {v: ${composite(a.type) ? `abap.copy(${b}.v)` : `${b}.v`}};`);
  // Reference parameters retain writes when the callee raises; VALUE
  // parameters are copied out only after its normal return.
  lines.push(`${t}  try {`, `${t}    ${callee(e, ctx)}(${["s", ...args].join(", ")});`, `${t}  } finally {`);
  for (const {b, a} of boxes) if (a.place && !a.byValue) lines.push(`${t}    ${place(a.place, ctx)} = ${b}.v;`);
  lines.push(`${t}  }`);
  for (const {b, a} of boxes) if (a.byValue) lines.push(`${t}  ${b}.v = ${b}_value.v;`);
  for (const {b, a} of boxes) if (a.place && a.byValue) lines.push(`${t}  ${place(a.place, ctx)} = ${b}.v;`);
  lines.push(`${t}}`);
  return lines;
}

const callee = (e, ctx) => {
  if (e.receiver) return `${expr(e.receiver, ctx)}.${typeName(e.method)}`;
  if (e.owner) return `${typeName(e.owner)}.${typeName(e.method)}`;
  if (e.static) return `${typeName(ctx.cls.name)}.${typeName(e.method)}`;
  // SUPER->m( ): the superclass's implementation
  if (e.sup) return `super.${typeName(e.method)}`;
  // in a constructor ABAP calls the class's own implementation, not a
  // subclass's redefinition: the subclass's part does not exist yet
  if (ctx.inCtor && !ctx.cls.signatures?.get(e.method)?.private) return `${typeName(ctx.cls.name)}.prototype.${typeName(e.method)}.bind(me)`;
  return `me.${typeName(e.method)}`;
};

const I_OPS = {"+": "abap.AddI", "-": "abap.SubI", "*": "abap.MulI", "/": "abap.DivI", DIV: "abap.DivIntI", MOD: "abap.ModI"};
const P_OPS = {"+": "abap.AddP", "-": "abap.SubP", "*": "abap.MulP", "/": "abap.DivP", DIV: "abap.DivIntP", MOD: "abap.ModP"};
const I8_OPS = {"+": "abap.AddI8", "-": "abap.SubI8", "*": "abap.MulI8", "/": "abap.DivI8", DIV: "abap.DivIntI8", MOD: "abap.ModI8"};
const F_OPS = {"/": "abap.DivF", DIV: "abap.DivIntF", MOD: "abap.ModF"};
const FN = {SIN: "Math.sin", COS: "Math.cos", TAN: "Math.tan", SQRT: "abap.SqrtF", EXP: "Math.exp", LOG: "abap.LogF", LOG10: "Math.log10"};

function expr(e, ctx) {
  switch (e.e) {
    case "static": return place(e, ctx);
    case "var": case "attr": case "field": case "fs": case "row": case "refattr": case "dref_field": return place(e, ctx);
    case "zero": return zero(e.type);
    case "case_fn": return `abap.${e.upper ? "ToUpper" : "ToLower"}(${expr(e.x, ctx)})`;
    case "table_lit": return `[${e.rows.map((r) => moved(r, ctx)).join(", ")}]`;
    case "bool": return `(${cond(e.cond, ctx)} ? "X" : ${JSON.stringify(e.blank)})`;
    case "cond": {
      let out = e.else ? expr(e.else, ctx) : zero(e.type);
      for (const b of [...e.branches].reverse()) out = `(${cond(b.cond, ctx)} ? ${expr(b.value, ctx)} : ${out})`;
      return out;
    }
    case "const": return e.go;
    case "temp": return e.name;
    case "padc": return `abap.PadC(${expr(e.x, ctx)}, ${e.n})`;
    case "flag": return String(e.value);
    case "str_fn": return `abap.${e.fn}(${e.args.map((a) => expr(a, ctx)).join(", ")})`;
    case "sy": return /^Msg/.test(e.field) ? `(s.sy.${e.field.toLowerCase()} ?? ${JSON.stringify(e.field === "Msgno" ? "000" : "")})` : `s.sy.${e.field.toLowerCase()}`;
    case "sy_mandt": return "abap.Mandt";
    case "sy_host": return `abap.${e.name}`;
    case "int": return String(e.value);
    case "float": return String(e.value);
    case "chars": case "str": return JSON.stringify(e.value);
    case "template": {
      const parts = e.parts.map((p) => (p.text !== undefined ? JSON.stringify(p.text) : templatePart(p.value, ctx, p.opts ?? {})));
      return parts.length === 0 ? `""` : `(${parts.join(" + ")})`;
    }
    case "concat": return `(${e.l.e === "conv" && ["i2s", "i82s"].includes(e.l.kind) ? `${expr(e.l, ctx)}.replace(/ +$/, "")` : expr(e.l, ctx)} + ${e.r.e === "conv" && ["i2s", "i82s"].includes(e.r.kind) ? `${expr(e.r, ctx)}.replace(/ +$/, "")` : expr(e.r, ctx)})`;
    // CORRESPONDING type( itab ): a new table, one mapped row per source row
    case "table_map":
      return `(() => { const out = []; for (const row of ${expr(e.from, ctx)}) { ${place(e.row, ctx)} = row; out.push(${expr(e.value, ctx)}); } return out; })()`;
    case "struct": {
      // every field, in the declared order: one object shape per structure
      const given = new Map(e.fields.map((f) => [f.name, f.value]));
      const fields = STRUCTS.get(e.type.go).fields;
      return `{${fields.map((f) => `${ident(f.name)}: ${given.has(f.name) ? moved(given.get(f.name), ctx) : zero(f.type)}`).join(", ")}}`;
    }
    case "neg": return e.type.k === "i" ? `abap.NegI(${expr(e.x, ctx)})` : e.type.k === "int8" ? `abap.NegI8(${expr(e.x, ctx)})` : e.type.k === "p" ? `abap.NegP(${expr(e.x, ctx)})` : `(-${expr(e.x, ctx)})`;
    case "bin":
      if (e.type.k === "x") return `abap.BitX(${JSON.stringify(e.op)}, ${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      if (e.type.k === "xstring") return `abap.BitXS(${JSON.stringify(e.op)}, ${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      if (e.type.k === "i") return `${I_OPS[e.op]}(${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      if (e.type.k === "p") return `${P_OPS[e.op]}(${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      if (e.type.k === "int8") return `${I8_OPS[e.op]}(${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      if (F_OPS[e.op] !== undefined) return `${F_OPS[e.op]}(${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      if (e.op === "**") return `abap.PowF(${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
      return `(${expr(e.l, ctx)} ${e.op} ${expr(e.r, ctx)})`;
    case "conv": return conv(e, ctx);
    case "date_add": return `abap.DateAdd(${expr(e.date, ctx)}, ${e.subtract ? "-" : ""}${expr(e.days, ctx)})`;
    case "sorted_move": {
      const names = e.keys.map((k) => ident(k));
      const cmp = names.map((k) => `if (x.${k} !== y.${k}) return x.${k} < y.${k} ? -1 : 1;`).join(" ");
      const same = names.map((k) => `v[i-1].${k} === v[i].${k}`).join(" && ");
      return `(() => { const v = abap.copy(${expr(e.x, ctx)}).sort((x,y) => { ${cmp} return 0; }); ${e.unique ? `for (let i=1; i<v.length; i++) if (${same}) throw new abap.AbapError("NOT_COMPILED", "SORTED table move: a duplicate primary key");` : ""} return v; })()`;
    }
    case "fn": return fn(e, ctx);
    case "lines": return `${expr(e.table, ctx)}.length`;
    case "strlen": return `abap.Strlen(${expr(e.x, ctx)})`;
    case "uccp": return `abap.Uccp(${expr(e.x, ctx)})`;
    case "exc_text": return `abap.excText(s, ${expr(e.x, ctx)})`;
    case "exc_class": return `("\\\\CLASS=" + ${expr(e.x, ctx)}.cls)`;
    case "random": return `abap.RandomInt(${expr(e.min, ctx)}, ${expr(e.max, ctx)})`;
    case "find": return `abap.Find(${expr(e.val, ctx)}, ${expr(e.sub, ctx)}, ${e.off ? expr(e.off, ctx) : "0"})`;
    case "find_occ": return `abap.FindOcc(${expr(e.val, ctx)}, ${expr(e.sub, ctx)}, ${expr(e.occ, ctx)})`;
    case "reverse": return `abap.Reverse(${expr(e.x, ctx)})`;
    case "xstrlen": return `${expr(e.x, ctx)}.length`;
    case "uccpi": return `abap.Uccpi(${expr(e.x, ctx)})`;
    case "substr": {
      const off = e.off ? expr(e.off, ctx) : "0";
      const len = e.len ? expr(e.len, ctx) : "-1";
      if (e.base.k === "x" || e.base.k === "xstring") return `abap.SubX(${expr(e.x, ctx)}, ${off}, ${len})`;
      if (e.base.k === "c") return `abap.SubC(${expr(e.x, ctx)}, ${e.base.len}, ${off}, ${len})`;
      return `abap.SubS(${expr(e.x, ctx)}, ${off}, ${len})`;
    }
    case "new": return `${typeName(e.cls)}.$new(${["s", ...e.args.map((a) => importingArg(a, ctx))].join(", ")})`;
    case "call": {
      if (e.args.some((a) => a.dir !== "importing" && (a.place || a.wrap))) {
        // EXPORTING / CHANGING of a functional call: boxes, written back
        // after the call, inside an arrow so the call stays an expression
        const pre = [];
        const post = [];
        const args = e.args.map((a, i) => {
          if (a.dir === "importing") return importingArg(a, ctx);
          if (a.wrap) return `{v: ${expr(a.wrap, ctx)}}`;
          if (!a.place) return `{v: ${zero(a.type)}}`;
          const b = `box${ctx.loop++}_${i}`;
          pre.push(`const ${b} = {v: ${place(a.place, ctx)}};`);
          post.push(`${place(a.place, ctx)} = ${b}.v;`);
          return b;
        });
        return `(() => { ${pre.join(" ")} const r = ${callee(e, ctx)}(${["s", ...args].join(", ")}); ${post.join(" ")} return r; })()`;
      }
      const args = e.args.map((a) => (a.dir === "importing" ? importingArg(a, ctx) : `{v: ${zero(a.type)}}`));
      return `${callee(e, ctx)}(${["s", ...args].join(", ")})`;
    }
    case "me": return "me";
    case "xbytes": return literal({type: e.type, value: e.value});
    case "type_length": return `abap.DescrLength(${expr(e.x, ctx)})`;
    case "type_kind": return `${expr(e.x, ctx)}.t.kind`;
    // ultra/events: inside a handler's registration (set_handler)
    case "ev_arg": return `EvA.${ident(e.name)}`;
    case "ev_sender": return "EvSender";
    case "ev_handler": return "EvH";
    case "upcast": return expr(e.x, ctx);
    case "cast": return `abap.cast(${expr(e.x, ctx)}, ${JSON.stringify(e.type.name)})`;
    // a typed slot seen as generic data: a binding to it; a value that is no
    // place gets a slot of its own
    case "lrow": return ctx.lrow;
    // ultra/itab: generic arithmetic, as emit-go
    case "unwrap_calc": {
      const d = expr(e.x, ctx);
      return e.type.k === "i" ? `abap.DataI(${d})` : e.type.k === "int8" ? `abap.DataI8(${d})` : e.type.k === "f" ? `abap.DataF(${d})` : `abap.DataP(${d})`;
    }
    case "gen_arith": {
      const sel = `abap.CalcKind(${JSON.stringify(e.statics)}, ${e.charTarget}, ${e.target ? expr(e.target, ctx) : "null"}, [${e.leaves.map((l) => expr(l, ctx)).join(", ")}])`;
      const arms = Object.entries(e.branches).map(([code, b]) => (b.reason !== undefined
        ? `case ${JSON.stringify(code)}: throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`arithmetic: ${b.reason}`)});`
        : `case ${JSON.stringify(code)}: return ${expr(b, ctx)};`));
      return `(() => { switch (${sel}) { ${arms.join(" ")} } throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(`arithmetic: calculation type of ${e.text} with these operands: not measured`)}); })()`;
    }
    case "wrap": return isPlace(e.x) ? bind(e.x, ctx) : `abap.cell(${expr(e.x, ctx)}, ${desc(e.x.type)})`;
    case "unwrap": return unwrapTo(e.type, expr(e.x, ctx));
    case "unwrap_chars": return `abap.DataChars(${expr(e.x, ctx)})`;
    case "lines_data": return `abap.Lines(${expr(e.x, ctx)})`;
    default: throw new Error(`no JS for expression ${e.e}`);
  }
}

/** a generic value read into a typed one: an i, or a string fitted to a c's length */
function unwrapTo(t, d) {
  if (t.k === "i") return `abap.DataI(${d})`;
  if (t.k === "c") return `abap.CFit(abap.DataString(${d}), ${t.len})`;
  if (t.k === "p") return `abap.PFit(abap.DataP(${d}), ${t.len}, ${t.dec ?? 0}, false)`;
  return `abap.DataString(${d})`;
}

function templatePart(v, ctx, opts) {
  let out = templateValue(v, ctx, opts);
  if (opts.width !== undefined) out = `abap.Pad(${out}, ${opts.width}, ${JSON.stringify(opts.align ?? "LEFT")}, ${JSON.stringify(opts.pad ?? " ")})`;
  return out;
}

function templateValue(v, ctx, opts) {
  const x = expr(v, ctx);
  if (opts.decimals !== undefined) return v.type.k === "p" ? `abap.FmtPDec(${x}, ${opts.decimals})` : `abap.FmtFDec(${x}, ${opts.decimals})`;
  switch (v.type.k) {
    case "i": return `abap.FmtI(${x})`;
    case "int8": return `String(${x})`;
    case "f": return `abap.FmtF(${x})`;
    case "p": return `abap.FmtP(${x}, ${opts.pdec ?? v.type.dec ?? 0})`;
    case "string": case "c": case "d": case "t": case "n": return x;
    case "x": case "xstring": return `abap.XToHex(${x})`;
    case "data": return `abap.FmtData(${x})`;
    default: throw new Error(`template part ${v.type.k}`);
  }
}

function conv(e, ctx) {
  const x = expr(e.x, ctx);
  const from = e.from.k;
  const to = e.to.k;
  switch (e.kind) {
    case "char_to_struct": {
      let off = 0;
      const total = e.fields.reduce((n, f) => n + f.len, 0);
      const fields = e.fields.map((f) => { const value = `${ident(f.name)}: abap.SubC(v, ${total}, ${off}, ${f.len})`; off += f.len; return value; });
      return `((v) => ({${fields.join(", ")}}))(${x})`;
    }
    case "struct_layout":
      return `((v) => ({${e.pairs.map(([t, f]) => `${ident(t)}: v.${ident(f)}`).join(", ")}}))(${x})`;
    case "flat_struct_string":
      return `((v) => (${e.fields.map((f) => `abap.CFit(v.${ident(f.name)}, ${f.len})`).join(" + ")}).replace(/ +$/, ""))(${x})`;
    case "num":
      if (from === "i" && to === "f") return x;
      if (from === "f" && to === "i") return `abap.F2I(${x})`;
      // int8 is a BigInt (ultra/itab)
      if (from === "i" && to === "int8") return `BigInt(${x})`;
      if (from === "int8" && to === "i") return `abap.I8ToI(${x})`;
      if (from === "int8" && to === "f") return `Number(${x})`;
      if (from === "f" && to === "int8") return `abap.F2I8(${x})`;
      break;
    case "c2s": return x;
    case "table_rows": return `${x}.map((ConvRow) => ${expr(e.row, ctx)})`;
    case "s2c": return `abap.CFit(${x}, ${e.to.len})`;
    case "s2d": return `abap.S2D(${x})`;
    case "s2t": return `abap.S2T(${x})`;
    case "x2s": return e.to.k === "c" ? `abap.CFit(abap.XToHex(${x}), ${e.to.len})` : `abap.XToHex(${x})`;
    case "i2x": case "i82x": return `abap.IToX(${x}, ${e.to.k === "x" ? e.to.len : "undefined"}, ${from === "i" ? 4 : 8})`;
    // packed numbers, js/abap.mjs (= go/abap packed.go)
    case "i2pc": return `abap.IToP(${x})`;
    case "c2pc": return `abap.CToP(${x})`;
    case "i2p": return `abap.PFit(abap.IToP(${x}), ${e.to.len}, ${e.to.dec ?? 0}, false)`;
    case "p2p": return `abap.PFit(${x}, ${e.to.len}, ${e.to.dec ?? 0}, ${!!e.arith})`;
    case "f2p": return `abap.PFit(abap.FToP(${x}), ${e.to.len}, ${e.to.dec ?? 0}, false)`;
    case "c2p": return `abap.PFit(abap.CToP(${x}), ${e.to.len}, ${e.to.dec ?? 0}, false)`;
    case "p2i": return `abap.PToI(${x}, ${!!e.arith})`;
    case "p2i8": return `abap.PToI8(${x}, ${!!e.arith})`;
    case "p2f": return `abap.PToF(${x})`;
    case "p2s": return `abap.PToString(${x}, ${e.from.dec ?? 0})`;
    case "p2c": return `abap.PToC(${x}, ${e.from.dec ?? 0}, ${e.to.len})`;
    case "p2n": return `abap.PToN(${x}, ${e.to.len})`;
    case "x2i": case "x2i8": return `abap.${to === "i" ? "XToI" : "XToI8"}(${x})`;
    case "i2s": return `abap.IToString(${x})`;
    case "i82s": return `((v) => v < 0n ? String(-v) + "-" : String(v) + " ")(${x})`;
    case "f2s": return `(${x}).toExponential(16).replace(/e([+-])(\\d)$/, "E$10$2").replace("e", "E")`;
    case "i2n": return `abap.IToN(${x}, ${e.to.len})`;
    case "s2n": return `abap.CToN(${x}, ${e.to.len})`;
    case "xs2x": return `abap.XFit(${x}, ${e.to.len})`;
    case "c2x": return e.to.k === "x" ? `abap.XFit(abap.CToX(${x}), ${e.to.len})` : `abap.CToX(${x})`;
    case "d2i": return `abap.DToI(${x})`;
    case "t2i": return `abap.TToI(${x})`;
    case "c2n":
      if (to === "f") return `abap.ParseF(${x})`;
      if (to === "i") return `abap.ParseI(${x})`;
      if (to === "int8") return `abap.ParseI8(${x})`;
      break;
    default: break;
  }
  throw new Error(`no JS for conversion ${e.kind} ${from}->${to}`);
}

function fn(e, ctx) {
  return emitBuiltinJs(e, e.args.map((a) => expr(a, ctx)), FN);
}

function cond(c, ctx) {
  switch (c.c) {
    case "num_data_cmp": return `abap.CmpNumericData(${expr(c.l, ctx)}, ${expr(c.r, ctx)}) ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} 0`;
    case "in_range": {
      const n = ctx.loop++;
      return `(() => { const rows${n} = ${expr(c.range, ctx)}; let hasI${n} = false, hit${n} = false; for (const r${n} of rows${n}) { let match${n}; if (r${n}.Option === "EQ") match${n} = ${expr(c.value, ctx)} === r${n}.Low; else if (r${n}.Option === "BT") match${n} = ${expr(c.value, ctx)} >= r${n}.Low && ${expr(c.value, ctx)} <= r${n}.High; else throw new abap.AbapError("NOT_COMPILED", "IN range: selection option other than EQ or BT"); if (r${n}.Sign === "I") { hasI${n} = true; if (match${n}) hit${n} = true; } else if (r${n}.Sign === "E") { if (match${n}) return false; } else throw new abap.AbapError("NOT_COMPILED", "IN range: selection sign other than I or E"); } return !hasI${n} || hit${n}; })()`;
    }
    case "co": return `abap.CO(${expr(c.l, ctx)}, ${expr(c.r, ctx)})`;
    case "cs": return `abap.CSWithPos(s, ${expr(c.l, ctx)}, ${expr(c.r, ctx)}, ${!!c.csubject})`;
    case "cp": return `abap.CP(${expr(c.l, ctx)}, ${expr(c.r, ctx)}, ${!!c.cpat}, ${!!c.csubject})`;
    case "ca": return `abap.CA(${expr(c.l, ctx)}, ${expr(c.r, ctx)})`;
    case "cmp":
      if (c.type?.k === "p") return `abap.CmpP(${expr(c.l, ctx)}, ${expr(c.r, ctx)}) ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} 0`;
      return `${expr(c.l, ctx)} ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} ${expr(c.r, ctx)}`;
    // ultra/events: line_exists( ) (frontend lineExists)
    case "line_exists": {
      const n = ctx.loop++;
      const keys = c.keys.map((k) => (k.line ? `r${n} === ${expr(k.value, ctx)}` : `r${n}.${ident(k.name)} === ${expr(k.value, ctx)}`)).join(" && ");
      return `${expr(c.table, ctx)}.some((r${n}) => ${keys})`;
    }
    // two object references (ultra/json refeq; ultra/events: undefined and
    // null are both the initial reference)
    case "refeq": return `(${c.op === "=" ? "" : "!"}abap.RefEq(${expr(c.l, ctx)}, ${expr(c.r, ctx)}))`;
    case "data_bound": return `abap.DataBound(${expr(c.x, ctx)})`;
    case "initial":
      if (c.x.type.k === "data") return `abap.IsInitialData(${expr(c.x, ctx)})`;
      if (c.x.type.k === "dref") return `(${expr(c.x, ctx)} === null)`;
      // "" or the typed zero for d, t and n; a structure or table compared component by component
      if (["d", "t", "n"].includes(c.x.type.k)) return `abap.InitialCh(${expr(c.x, ctx)}, ${zero(c.x.type)})`;
      if (c.x.type.k === "struct" || c.x.type.k === "table") return `abap.IsInitialDeep(${expr(c.x, ctx)}, ${zero(c.x.type)})`;
      return `${expr(c.x, ctx)} === ${zero(c.x.type)}`;
    case "assigned": return `${ident(c.fs.name)} !== null`;
    case "and": return `(${cond(c.l, ctx)} && ${cond(c.r, ctx)})`;
    case "true": return "true";
    // two tables, = or <>: the row counts, then each row at its index
    case "tableeq":
      return `(${c.op === "=" ? "" : "!"}(() => { const l = ${expr(c.l, ctx)}, r = ${expr(c.r, ctx)}; if (l.length !== r.length) return false; for (let i = 0; i < l.length; i++) { ${place(c.a, ctx)} = l[i]; ${place(c.b, ctx)} = r[i]; if (!(${cond(c.rowEq, ctx)})) return false; } return true; })())`;
    case "or": return `(${cond(c.l, ctx)} || ${cond(c.r, ctx)})`;
    case "not": return `!(${cond(c.x, ctx)})`;
    default: throw new Error(`no JS for condition ${c.c}`);
  }
}
void funcName;
