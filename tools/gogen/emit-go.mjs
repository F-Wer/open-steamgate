import {analyzeTableMoves} from "./emit-table-move.mjs";
import {omittedFactoryCall} from "./frontend.mjs";
import {analyzeOwnership} from "./frontend-owned.mjs";
import {ownedExpression, ownedStatement, emitByteConcat} from "./emit-owned.mjs";
import {emitBuiltinGo} from "./emit-builtins.mjs";
import {I8_OPS, emitPackedInt8, emitPackedComparison} from "./emit-int8.mjs";
import {emitByteStatement} from "./emit-bytes.mjs";
// IR -> Go source, for the Go backend spike.
//
// Nothing here decides semantics: the IR already says which calculation type
// every operator runs in and where a conversion happens. This file only
// spells it. A method takes the Session first -- the roll area -- so the
// same generated code runs on any goroutine. An instance method has the
// object as its receiver; a static one is a plain function.

// An absent or OTHERS-only clause carries no named exception codes.
const exceptionCodes = (exceptions) => {
  const codes = Object.entries(exceptions?.map ?? {}).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ");
  return codes ? `map[string]int32{${codes}}` : "nil";
};

const GO_RESERVED = new Set(("break default func interface select case defer go map struct chan else goto package switch const "
  + "fallthrough if range type continue for import return var append cap clear close complex copy delete imag len make max min new "
  + "panic print println real recover bool byte error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 "
  + "uint32 uint64 uintptr true false nil iota me s math abap").split(" "));

let exportedFields = false, OWNERSHIP;
const ownedType = (v) => OWNERSHIP.declarations.has(v) ? (HELPER_IMPORTS.add("xbuf"), (v.type.k === "x" ? `[${v.type.len}]byte` : "hXbuf.Buffer")) : goType(v.type);
export const ident = (name) => {
  // INTF~ATTR, an interface's attribute in the object, keeps the ~ apart
  // from the _ of an attribute of the class's own
  const id = String(name).toLowerCase().replace(/~/g, "__").replace(/[^a-z0-9_]/g, "_");
  const safe = GO_RESERVED.has(id) || /^\d/.test(id) ? `${id}_` : id;
  // ABAP fields cross generated Go package boundaries in a layered build.
  // A leading capital exports them; the rest of the spelling stays stable.
  return exportedFields ? safe[0].toUpperCase() + safe.slice(1) : safe;
};
const selfField = (name) => `${exportedFields ? "Self" : "self"}_${typeName(name)}`;
const typeName = (s) => {
  const name = String(s).toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return name.startsWith("_") ? `N${name}` : name;
};
export const funcName = (cls, method) => `${typeName(cls)}_${typeName(method)}`;
const evType = (key) => `EV_${typeName(key)}`;
/*
 * ultra/events: CLASS_CONSTRUCTOR runs once, at the first use of the class:
 * the first NEW of it or of a subclass, or the first call of one of its
 * static methods (ABAP also counts a read of a static attribute from
 * outside; the front end compiles no such read). The superclass's runs
 * first. The flag is process-wide, as the class data is; the unit runner
 * resets both at each internal-session boundary. CL_ABAP_CHAR_
 * UTILITIES is left out: its class constructor is two kernel lines setting
 * constants the front end already knows (CHAR_UTILITIES).
 */
const ownCctor = (cls) => cls.name !== "CL_ABAP_CHAR_UTILITIES"
  && (cls.methods.some((m) => m.name === "CLASS_CONSTRUCTOR") || (cls.stubs ?? []).some((m) => m.name === "CLASS_CONSTRUCTOR"));
function chainCctor(cls) {
  for (let c = cls; c; c = c.super ? CLASSES.get(c.super) : null) if (ownCctor(c)) return true;
  return false;
}

let STABLE_ROWS = new Set();
let movePair;
const stable = (t) => t?.stable || (t?.k === "table" && STABLE_ROWS.has(t.row.go ?? `${t.row.k}:${t.row.len ?? ""}`));
export function goType(t) {
  switch (t.k) {
    case "i": return "int32";
    case "int8": return "int64";
    case "f": return "float64";
    case "string": case "c": case "x": case "xstring": return "string";
    case "table": return `[]${stable(t) ? "*" : ""}${goType(t.row)}`;
    case "struct": return t.go;
    case "ref": return t.name === "OBJECT" ? "any" : t.intf ? typeName(t.name) : POLY.has(t.name) ? `I_${typeName(t.name)}` : `*${typeName(t.name)}`;
    case "exc": return "*abap.Exception";
    case "data": case "dref": return "abap.Data";
    case "d": case "t": case "p": case "n": return "string";
    default: throw new Error(`no Go type for ${t.k}`);
  }
}
const rowValue = (table, item) => stable(table) ? `(*(${item}))` : item;
const rowAddress = (table, item) => stable(table) ? item : `&${item}`;
const rowStored = (table, value) => stable(table) ? `abap.Ptr(${value})` : value;
const rowRef = (table, tb, item) => stable(table) ? `abap.RowRef(&${tb}, ${item}, ${desc(table.row)})` : `abap.Data{P: &${item}, T: ${desc(table.row)}}`;
const boundRow = (table, tb, index) => table.row.k === "data" ? rowValue(table, `${tb}[${index}]`) : !stable(table) && table.row.k !== "struct" ? `abap.BindRow(&${tb}, int(${index}))` : rowAddress(table, `${tb}[${index}]`);

// a p field holds its decimals: initial is 0, 0.0, 0.00 ... (go/abap packed.go)
const pZero = (t) => (t.calc || !t.dec ? "0" : `0.${"0".repeat(t.dec)}`);

// an x field is always its full length: initial is that many 00 bytes.
// A structure's initial value sets every component whose initial value is
// not Go's zero value, recursively (ultra/packs fix round, critic finding 1:
// an x/d/t/n/p component, a row built from one, a CLASS-DATA and an instance
// attribute all started at "" in Go while JS and ABAP give the type's
// initial value; ZCL_GOGEN_T_XINIT pins it)
const zero = (t) => (t.k === "i" || t.k === "int8" || t.k === "f" ? "0" : t.k === "x" ? JSON.stringify("\u0000".repeat(t.len)).replaceAll("\\u0000", "\\x00")
  : t.k === "string" || t.k === "c" || t.k === "xstring" ? `""` : t.k === "struct" ? `${t.go}{${zeroFields(t).join(", ")}}` : t.k === "data" || t.k === "dref" ? "abap.Data{}"
    : t.k === "d" ? `"00000000"` : t.k === "t" ? `"000000"` : t.k === "p" ? JSON.stringify(pZero(t)) : t.k === "n" ? JSON.stringify("0".repeat(t.len)) : "nil");
/** is this zero() text Go's own zero value for the type, so a declaration may leave it out */
const isGoZero = (z) => z === "0" || z === `""` || z === "nil" || z === "abap.Data{}" || /^[A-Za-z0-9_.]+\{\}$/.test(z);
/** the components of a structure whose initial value is not Go's zero value, as `name: value` */
function zeroFields(t, skip = new Set()) {
  return (STRUCTDEFS.get(t.go)?.fields ?? []).filter((f) => !skip.has(String(f.name).toUpperCase())).map((f) => [f, zero(f.type)])
    .filter(([, z]) => !isGoZero(z)).map(([f, z]) => `${ident(f.name)}: ${z}`);
}

/*
 * ABAP tables are values: an assignment copies them, deep, with the tables
 * inside a structure (measured on A4H: lt_b = lt_a then MODIFY lt_b leaves
 * lt_a alone, and the same for a table inside a copied structure). A Go
 * slice is a reference, so every move of a table out of a place goes
 * through a generated clone. Flat values need none.
 */
const composite = (t) => t?.k === "table" || t?.k === "struct";
const byRef = (p) => p.dir === "importing" && composite(p.type) && !p.byValue;
let CLONES = new Map();
// classes some compiled class inherits from: a reference to one is the Go
// interface I_<class>, so it can hold any subclass; a leaf class stays *T
let POLY = new Set();
let CLASSES = new Map();
let EVENTS = new Map();
// descriptors of the types generic data binds to, generated at the end
let DESCS = new Map();
// elementary descriptors with a type name (ultra/json, RTTI's absolute
// names): one var each, abap.Named once at start
let NAMED = new Map();
let STRUCTDEFS = new Map();
let HELPER_IMPORTS = new Set();
// A helper package is imported under an alias ident() can never produce (a
// lower-case first letter and an inner capital), so an ABAP local or
// parameter of the same name cannot shadow it: `tstmp` in CL_ABAP_TSTMP did.
const helperAlias = (name) => `h${name[0].toUpperCase()}${name.slice(1)}`;
// a host function named pkg.Fn (frontend NATIVE / KERNEL rows): pkg other than
// abap is a helper package, imported and called through its alias
const helperFn = (fn) => {
  const m = /^([a-z][a-z0-9]*)\.(\w+)$/.exec(fn);
  if (!m || m[1] === "abap") return fn;
  HELPER_IMPORTS.add(m[1]);
  return `${helperAlias(m[1])}.${m[2]}`;
};
function needsCopy(t) {
  if (t?.k === "table") return true;
  if (t?.k === "struct") return (STRUCTDEFS.get(t.go)?.fields ?? []).some((f) => needsCopy(f.type));
  return false;
}
function cloneName(t) {
  const key = goType(t);
  if (!CLONES.has(key)) CLONES.set(key, {name: `clone_${CLONES.size}`, type: t});
  return CLONES.get(key).name;
}
const PLACES = new Set(["var", "attr", "static", "field", "fs", "row", "row_key", "refattr", "dref_field"]);
/** a value moved out of a place: a table (or a structure holding one) is copied */
/** one condition of an internal table's WHERE over the row `row`
 * (ultra/itab: a nested component and IS [NOT] INITIAL read through fx) */
function whereItem(w, row, ctx) {
  const saved = ctx.lrow;
  ctx.lrow = row;
  try {
    if (w.op === "initial" || w.op === "notinitial") {
      const c = cond({c: "initial", x: w.fx}, ctx);
      return w.op === "initial" ? c : `!(${c})`;
    }
    const lhs = w.fx ? expr(w.fx, ctx) : `${row}.${ident(w.name)}`;
    return `${lhs} ${w.op === "=" ? "==" : w.op === "<>" ? "!=" : w.op} ${expr(w.value, ctx)}`;
  } finally {
    ctx.lrow = saved;
  }
}
function copied(text, t, e) {
  return needsCopy(t) && (e === undefined || PLACES.has(e.e)) ? `${cloneName(t)}(${text})` : text;
}
const descKey = (t) => (t.k === "struct" ? `s:${t.go}` : t.k === "table" ? `t${t.sorted ? "s" : t.hashed ? "h" : ""}:${descKey(t.row)}`
  : `${t.k}:${t.len ?? ""}:${t.dec ?? ""}:${t.name ?? ""}`);
/** the descriptor of a type, for generic data: built-in for elementary types, generated for the rest */
function desc(t) {
  if ((t.qname || t.ddic) && !["struct", "table", "dref", "ref", "exc", "data"].includes(t.k)) {
    const base = desc({...t, qname: undefined, ddic: undefined});
    const key = `${base}|${t.qname ?? ""}|${t.ddic ?? ""}`;
    if (!NAMED.has(key)) NAMED.set(key, {name: `tn_${NAMED.size}`, text: `abap.Named(${base}, ${JSON.stringify(t.qname ?? "")}, ${JSON.stringify(t.ddic ?? "")})`});
    return NAMED.get(key).name;
  }
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
    case "ref": return t.name && t.name !== "OBJECT" ? `abap.Named(abap.TObj, ${JSON.stringify(t.name)}, "")` : "abap.TObj";
    case "exc": return "abap.TObj";
    case "struct": case "table": {
      // the ABAP type, not the Go one: a table of c 200 and a table of string
      // are both []string in Go but not one descriptor (ultra/events: STRING_TO_TAB
      // read the rows of a c 200 table as strings); a SORTED or HASHED table
      // has no Append
      const key = descKey(t);
      if (!DESCS.has(key)) DESCS.set(key, {name: `td_${DESCS.size}`, type: t});
      return DESCS.get(key).name;
    }
    default: throw new Error(`no descriptor for ${t.k}`);
  }
}
function descFuncs() {
  const out = [];
  const done = new Set();
  const inits = [];
  for (let again = true; again;) {
    again = false;
    for (const [key, d] of [...DESCS]) {
      if (done.has(key)) continue;
      done.add(key);
      again = true;
      const t = d.type;
      out.push(`var ${d.name} = &abap.Type{}`);
      if (t.k === "table") {
        const g = goType(t);
        inits.push(`\t*${d.name} = abap.Type{Kind: 'h', Row: ${desc(t.row)}, Lines: func(p any) int { return len(*p.(*${g})) }, At: func(p any, i int) any { return ${rowAddress(t, `(*p.(*${g}))[i]`)} }, ${t.hashed || t.sorted ? "" : `Append: func(p any) any { *p.(*${g}) = append(*p.(*${g}), ${rowStored(t, zero(t.row))}); return ${rowAddress(t, `(*p.(*${g}))[len(*p.(*${g}))-1]`)} }, `}${t.hashed ? "" : `Delete: func(p any, i int) { *p.(*${g}) = append((*p.(*${g}))[:i], (*p.(*${g}))[i+1:]...); clear((*p.(*${g}))[len(*p.(*${g})):len(*p.(*${g}))+1]) }, `}${copyZero(t)}}`);
      } else {
        const fs = STRUCTDEFS.get(t.go)?.fields ?? [];
        // a structure with a string, a table or a reference in it is deep: 'v' (A4H)
        const sname = STRUCTDEFS.get(t.go)?.qname;
        inits.push(`\t*${d.name} = abap.Type{Kind: '${deepType(t) ? "v" : "u"}', ${sname ? `Name: ${JSON.stringify(sname)}, ` : ""}Comps: []abap.Comp{${fs.map((f) => `{Name: ${JSON.stringify(String(f.name).toUpperCase())}, T: ${desc(f.type)}, Get: func(p any) any { return &p.(*${t.go}).${ident(f.name)} }}`).join(", ")}}, ${copyZero(t)}}`);
      }
    }
  }
  const named = [...NAMED.values()].map((n) => `var ${n.name} = ${n.text}`);
  if (out.length === 0) return named.length ? [...named, ""] : [];
  return [...named, ...out, "", "func init() {", ...inits, "}", ""];
}

/**
 * The table registry (frontend tableRegistry, go/abap tables.go): every
 * TABL and DDIC view with its columns, key and client flag, and the
 * descriptors of a row and of a STANDARD TABLE of rows where the row type
 * is in the subset
 */
function tableRegistry(program) {
  const tables = program.tables ?? [];
  if (tables.length === 0) return [];
  const irType = (t) => (t === null ? "nil" : `&abap.IRType{Abap: ${JSON.stringify(t.abap)}${t.len ? `, Len: ${t.len}` : ""}${t.dec ? `, Dec: ${t.dec}` : ""}}`);
  const lines = tables.map((t) => {
    const cols = t.columns.map((c) => `{Name: ${JSON.stringify(c.name)}, Kind: '${c.kind}', Len: ${c.len}, Dec: ${c.dec}, Key: ${c.key}, IR: ${irType(c.type)}}`);
    const types = t.row ? `Row: ${desc(t.row)}, Rows: ${desc({k: "table", row: t.row})}` : `Why: ${JSON.stringify(t.why)}`;
    return `\t\t&abap.Table{Name: ${JSON.stringify(t.name)}, View: ${t.view}, Client: ${t.client}, Key: []string{${t.key.map((k) => JSON.stringify(k)).join(", ")}}, Columns: []abap.Column{${cols.join(", ")}}, ${types}${t.sqlView ? `, SQLView: ${JSON.stringify(t.sqlView)}` : ""}${t.cds ? `, CDS: ${JSON.stringify(t.cds)}` : ""}${t.hidesClient ? `, HidesClient: ${JSON.stringify(t.hidesClient)}` : ""}},`;
  });
  const names = program.ddicNames ?? [];
  return ["func init() {", "	abap.RegisterTables(", ...lines, "	)",
    ...(names.length ? [`	abap.RegisterDDICNames(${names.map((n) => JSON.stringify(n)).join(", ")})`] : []), "}", ""];
}

/** a structure that holds a string, a table or a reference, at any depth */
export function deepType(t) {
  if (["string", "xstring", "table", "ref", "exc", "dref", "data"].includes(t?.k)) return true;
  if (t?.k === "struct") return (STRUCTDEFS.get(t.go)?.fields ?? []).some((f) => deepType(f.type));
  return false;
}

/** the Copy, Zero and New of a generated descriptor: a whole move, a CLEAR
 * and a CREATE DATA through generic data */
function copyZero(t) {
  const g = goType(t);
  return `Copy: func(dst, src any) { *dst.(*${g}) = ${copied(`*src.(*${g})`, t)} }, Zero: func(p any) { *p.(*${g}) = ${zero(t)} }, New: func() any { p := new(${g}); *p = ${zero(t)}; return p }`;
}

/** a structure with a d, t or n field somewhere (and nothing IsInitialData cannot read) */
function typedZeroInside(t, seen = new Set()) {
  if (seen.has(t.go)) return false;
  seen.add(t.go);
  const fs = STRUCTDEFS.get(t.go)?.fields ?? [];
  if (fs.some((f) => ["ref", "exc", "data", "dref"].includes(f.type.k))) return false;
  let found = false;
  for (const f of fs) {
    if (["d", "t", "n"].includes(f.type.k)) found = true;
    else if (f.type.k === "struct") {
      const inner = STRUCTDEFS.get(f.type.go)?.fields ?? [];
      if (inner.some((g) => ["ref", "exc", "data", "dref"].includes(g.type.k))) return false;
      if (typedZeroInside(f.type, seen)) found = true;
    }
  }
  return found;
}

function cloneFuncs() {
  const out = [];
  const done = new Set();
  for (let again = true; again;) {
    again = false;
    for (const [key, c] of [...CLONES]) {
      if (done.has(key)) continue;
      done.add(key);
      again = true;
      const t = c.type;
      if (t.k === "table") {
        const inner = stable(t) ? `for i := range v {\n\t\tr[i] = ${rowStored(t, needsCopy(t.row) ? `${cloneName(t.row)}(*v[i])` : `*v[i]`)}\n\t}` : needsCopy(t.row) ? `for i := range v {\n\t\tr[i] = ${cloneName(t.row)}(v[i])\n\t}` : "copy(r, v)";
        out.push(`func ${c.name}(v ${goType(t)}) ${goType(t)} {`, "\tif v == nil {", "\t\treturn nil", "\t}", `\tr := make(${goType(t)}, len(v))`, `\t${inner}`, "\treturn r", "}", "");
      } else {
        const fs = STRUCTDEFS.get(t.go).fields.filter((f) => needsCopy(f.type));
        out.push(`func ${c.name}(v ${goType(t)}) ${goType(t)} {`, ...fs.map((f) => `\tv.${ident(f.name)} = ${cloneName(f.type)}(v.${ident(f.name)})`), "\treturn v", "}", "");
      }
    }
  }
  return out;
}

export function emitGo(program, pkg = "main", layers = null, unitBuild = false) {
  STABLE_ROWS = new Set();
  const collectStable = (v) => {
    if (Array.isArray(v)) { for (const x of v) collectStable(x); return; }
    if (!v || typeof v !== "object") return;
    const table = v.table?.type;
    if (table?.stable && table.row.go) STABLE_ROWS.add(table.row.go);
    for (const key of ["body", "branches", "cases", "catches", "else", "then", "cleanup"]) collectStable(v[key]);
  };
  for (const cls of program.classes ?? program) for (const method of cls.methods ?? []) collectStable(method.body);
  exportedFields = Boolean(layers);
  HELPER_IMPORTS = new Set();
  OWNERSHIP = analyzeOwnership(program);
  const classes = layers?.classes ?? (Array.isArray(program) ? program : program.classes);
  const structs = layers?.structs ?? (Array.isArray(program) ? new Map() : program.structs);
  CLONES = new Map();
  DESCS = new Map();
  NAMED = new Map();
  STRUCTDEFS = Array.isArray(program) ? structs : program.structs;
  CLASSES = new Map((Array.isArray(program) ? classes : program.classes).map((c) => [c.name, c]));
  POLY = new Set([...CLASSES.values()].map((c) => c.super).filter(Boolean));
  movePair = analyzeTableMoves(program, stable, goType);
  HELPER_IMPORTS.add("hostclass");
  EVENTS = Array.isArray(program) ? new Map() : (program.events ?? new Map());
  const consts = layers?.consts ?? (Array.isArray(program) ? new Map() : program.consts);
  const out = [];
  out.push("// Code generated by tools/gogen/emit-go.mjs. DO NOT EDIT.", "", `package ${pkg}`, "", "import (",
    "\t\"math\"", "\t\"runtime/debug\"", "\t\"sort\"", "\t\"strings\"", "", "\t\"osg/gogen/abap\"", "\t\"osg/gogen/amc\"", "\u0000helper-imports", ...(layers?.imports ?? []).map((p) => `\t. ${JSON.stringify(p)}`), ")", "", "var _ = math.Sin", "var _ = debug.Stack", "var _ = sort.Ints", "var _ strings.Builder", "var _ = abap.AddI", "var _ = amc.Current", "var _ = hHostclass.ZCL_OSD_ENQ_KERNEL", "");
  if (layers?.marker) out.push(`type ${layers.marker} struct{}`, "");
  for (const marker of layers?.importMarkers ?? []) out.push(`var _ = ${marker}{}`, "");
  for (const st of structs.values()) {
    out.push(`type ${st.go} struct {`);
    for (const f of st.fields) out.push(`\t${ident(f.name)} ${goType(f.type)}`);
    out.push("}", "");
  }
  for (const c of consts.values()) out.push(`var ${c.go} ${goType(c.type)} = ${constLiteral(c)}`);
  if (consts.size > 0) out.push("");
  // interfaces used as reference types, and classes referred to but not compiled
  for (const [name, sigs] of program.interfaceMethods ?? []) {
    if (layers?.interfaces && !layers.interfaces.has(name)) continue;
    out.push(`type ${typeName(name)} interface {`);
    out.push(`\t${interfaceMarker(name)}()`);
    for (const included of componentInterfaces(program.reg, name)) out.push(`\t${interfaceMarker(included)}()`);
    for (const m of sigs) if (definable(program, m)) out.push(`\t${signature({name}, m, true)}`);
    out.push(...intfAccessors(program, name));
    out.push("}", "");
  }
  // ultra/events: the parameters of each event used, as one struct a
  // RAISE EVENT builds per handler call
  for (const ev of (layers?.events ?? EVENTS).values()) {
    out.push(`type ${evType(ev.key)} struct {`);
    for (const p of ev.params) out.push(`\t${ident(p.name)} ${goType(p.type)}`);
    out.push("}", "");
  }
  const compiled = new Set(classes.map((c) => c.name));
  for (const ref of referencedClasses({...program, classes})) if (!compiled.has(ref) && !layers?.externalClasses?.has(ref)) out.push(`type ${typeName(ref)} struct{}`, "");
  for (const cls of classes) {
    const inst = (cls.attributes ?? []).filter((a) => !a.static && !a.unsupported);
    const statics = (cls.attributes ?? []).filter((a) => a.static && !a.unsupported);
    out.push(`type ${typeName(cls.name)} struct {`);
    // the superclass's part of the object, embedded: its attributes and
    // methods are promoted, and a redefinition shadows the method
    if (cls.super) out.push(`\t${typeName(cls.super)}`);
    // the most-derived object, for the calls a method makes on me
    if (POLY.has(cls.name)) out.push(`\t${selfField(cls.name)} I_${typeName(cls.name)}`);
    // ultra/events: an object that raises instance events carries the
    // handlers registered FOR it (go/abap/events.go); once per chain, the
    // subclasses get it through the embedding
    if (cls.instanceEvents && !(cls.super && CLASSES.get(cls.super)?.instanceEvents)) out.push("\tabap.Events");
    for (const a of inst) out.push(`\t${ident(a.name)} ${ownedType(a)}`);
    // ultra/events: an object of a class without fields would be zero-sized,
    // and Go may give two of them one address: ref <> ref and the handler
    // registry need each object to be itself
    if (out.at(-1) === `type ${typeName(cls.name)} struct {`) out.push("\t_ byte");
    out.push("}", "");
    if (cls.name === "KERNEL_CX_ASSERT") out.push(`func (me *KERNEL_CX_ASSERT) AssertionMessage() string { return me.${ident("MSG")} }`, "");
    for (const intf of implementedInterfaces(program, cls)) out.push(`func (me *${typeName(cls.name)}) ${interfaceMarker(intf)}() {}`, "");
    if (POLY.has(cls.name)) out.push(...classInterface(program, cls));
    out.push(...attrAccessors(cls, inst));
    if (statics.length || chainCctor(cls)) {
      const name = typeName(cls.name);
      out.push(`type statics_${name} struct {`);
      for (const a of statics) out.push(`\t${ident(a.name)} ${ownedType(a)}`);
      if (chainCctor(cls)) out.push("\tcctor bool");
      out.push("}", `var slot_${name} = abap.RegisterStatics(func() any {`, `\treturn &statics_${name}{`);
      for (const a of statics) {
        // Owned buffers start empty; other types preserve ABAP's initial value.
        const init = OWNERSHIP.declarations.has(a) ? undefined : a.value !== undefined ? constLiteral(a) : isGoZero(zero(a.type)) ? undefined : zero(a.type);
        if (init !== undefined) out.push(`\t\t${ident(a.name)}: ${init},`);
      }
      out.push("\t}", "})", `func St_${name}(s *abap.Session) *statics_${name} {`, `\treturn s.Static(slot_${name}).(*statics_${name})`, "}", "");
    }
    if (chainCctor(cls)) {
      const sup = cls.super && CLASSES.get(cls.super) && chainCctor(CLASSES.get(cls.super)) ? `\tEnsure_${typeName(cls.super)}(s)` : null;
      out.push(`func Ensure_${typeName(cls.name)}(s *abap.Session) {`, `\tst := St_${typeName(cls.name)}(s)`, "\tif st.cctor {", "\t\treturn", "\t}",
        // Set before running for reentrant access within this session.
        "\tst.cctor = true", `\tdefer abap.CctorGuard(${JSON.stringify(cls.name)}, &st.cctor)`, ...(sup ? [sup] : []), ...(ownCctor(cls) ? [`\t${funcName(cls.name, "CLASS_CONSTRUCTOR")}(s)`] : []), "}", "");
    }
    for (const m of cls.methods) out.push(...method(cls, m), "");
    // a method that did not compile still exists, and says why when called
    for (const m of cls.stubs ?? []) {
      if (m.name === "CONSTRUCTOR" || !definable(program, m)) continue;
      out.push(`${signature(cls, m)} {`, `\tpanic(abap.NotCompiled(${JSON.stringify(`${cls.name}=>${m.name}`)}, ${JSON.stringify(m.reason)}))`, "}", "");
    }
    if (cls.constructor) out.push(...method(cls, {...cls.constructor, name: "CONSTRUCTOR", static: false}), "");
    if (cls.abstract) continue;
    // NEW: a new object, every level's attributes set, every level's self
    // pointing at it, then the nearest constructor of the chain
    const chain = [cls];
    for (let c = cls; c.super && CLASSES.has(c.super);) { c = CLASSES.get(c.super); chain.push(c); }
    const ctorAt = chain.find((c) => c.constructor || c.ctorParams);
    const cp = ctorAt ? (ctorAt.constructor?.params ?? ctorAt.ctorParams ?? []) : [];
    // Alloc_: the object without its constructor, for the host (RTTI builds
    // descriptors the way the kernel does, field by field)
    out.push(`func Alloc_${typeName(cls.name)}() *${typeName(cls.name)} {`,
      `\to := &${typeName(cls.name)}{}`,
      // an instance attribute without VALUE starts at its type's initial value (critic finding 1)
      ...chain.flatMap((c) => (c.attributes ?? []).filter((a) => !a.static && !a.unsupported && (a.value !== undefined || !isGoZero(zero(a.type))))
        .map((a) => `\to.${ident(a.name)} = ${a.value !== undefined ? constLiteral(a) : zero(a.type)}`)),
      ...chain.filter((c) => POLY.has(c.name)).map((c) => `\to.${selfField(c.name)} = o`),
      "\treturn o", "}", "");
    out.push(`func New_${typeName(cls.name)}(${["s *abap.Session", ...cp.map((p) => `${ident(p.name)} ${byRef(p) ? "*" : ""}${goType(p.type)}`)].join(", ")}) *${typeName(cls.name)} {`,
      ...(chainCctor(cls) ? [`\tEnsure_${typeName(cls.name)}(s)`] : []),
      `\to := Alloc_${typeName(cls.name)}()`,
      ...(ctorAt?.constructor ? [`\to.CONSTRUCTOR(${["s", ...cp.map((p) => ident(p.name))].join(", ")})`] : []),
      "\treturn o", "}", "");
    // CREATE OBJECT ... TYPE (name) passes no arguments
    const make = cp.length === 0 ? `return New_${typeName(cls.name)}(s)`
      : `panic(abap.NotCompiled(${JSON.stringify(`${cls.name}=>CONSTRUCTOR`)}, "CREATE OBJECT by name of a class whose constructor has parameters"))`;
    out.push(`func init() {`, `\tabap.RegisterClass(${JSON.stringify(cls.name)}, (*${typeName(cls.name)})(nil), func(s *abap.Session) any { ${make} })`, "}", "");
  }
  out.push(...exceptionSupers(program));
  out.push(...hostRaiseGlue(program, classes, layers));
  if (!layers) out.push(...dispatcher(classes));
  out.push(...staticRegistry(program, classes));
  if (classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "Native_DESCRIBE_BY_NAME"))) out.push(...nativeRtti(program));
  if (classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "Native_GET_TEXT_FOR_MESSAGE"))) out.push(...nativeMessageText(program));
  if (classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "Native_DESCRIBE_BY_DATA"))) out.push(...nativeRttiData(program));
  if (classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "Native_JSON_PARSE"))) out.push(...nativeJsonParse());
  if (classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "Native_AJSON_ENCODE"))) {
    out.push("func Native_AJSON_ENCODE(s *abap.Session, input string) string { return abap.EncodeText(\"utf8\", input) }", "");
  }
  if (classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === "Native_AJSON_DECODE"))) {
    out.push("func Native_AJSON_DECODE(s *abap.Session, input string) string { return abap.DecodeText(\"utf8\", false, input) }", "");
  }
  out.push(...nativeCodepage(classes));
  if (classes.some((c) => c.name === "CL_AMC_CHANNEL_MANAGER")) out.push(...amcGlue(program));
  out.push(...tableRegistry(layers?.tables ? {...program, tables: layers.tables} : program));
  // descriptors first: their Copy asks for clone functions
  const descs = descFuncs();
  out.push(...cloneFuncs());
  out.push(...descs);
  // a RESET line becomes a //line back to this file at the line after it
  for (let i = 0; i < out.length; i += 1) if (out[i] === RESET) out[i] = `//line zz_generated.go:${i + 2}`;
  out[out.indexOf("\u0000helper-imports")] = [...HELPER_IMPORTS].sort()
    .map((name) => `\t${helperAlias(name)} "osg/gogen/${name}"`).join("\n");
  const generated = out.join("\n") + "\n";
  // ident() is also used by the JS emitter in this process. A layered Go
  // emission must not change its spelling for the next consumer.
  exportedFields = false;
  return generated;
}

/**
 * CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE, which open-abap writes as kernel
 * code: an exception object that is no IF_T100_MESSAGE and has no text id
 * has the fallback text (A4H gives the same for such a class, 2026-09-23);
 * a T100 message or an OTR text id is not read here and dumps.
 */
function nativeMessageText(program) {
  const head = `func Native_GET_TEXT_FOR_MESSAGE(s *abap.Session, text ${goType({k: "ref", name: "IF_MESSAGE", intf: true})}) string {`;
  const root = CLASSES.get("CX_ROOT");
  // IF_T100_MESSAGE has no methods, so every Go value fits its interface:
  // the classes that implement it are told by name
  const t100 = [...CLASSES.values()].filter((c) => [c, ...ancestorsOf(c)].some((x) => (x.interfaces ?? []).includes("IF_T100_MESSAGE"))).map((c) => c.name);
  return [head, "\tif text == nil {", `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "an initial reference"))`, "\t}",
    ...(t100.length ? [`\tswitch abap.ClassOf(text) {`, `\tcase ${t100.map((x) => JSON.stringify(x)).join(", ")}:`, `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "T100 message texts are not read in the Go host"))`, "\t}"] : []),
    ...(root && POLY.has("CX_ROOT") && root.attributes.some((a) => a.name === "TEXTID" && !a.unsupported)
      ? [`\tif x, ok := any(text).(I_CX_ROOT); !ok || x.As_CX_ROOT().${ident("TEXTID")} != "" {`, `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "OTR texts are not read in the Go host"))`, "\t}"]
      : [`\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "CX_ROOT is not compiled"))`]),
    `\treturn "An exception was raised."`, "}", ""];
}

/*
 * cl_abap_conv_out_ce->convert and cl_abap_conv_in_ce->convert, kernel code
 * in open-abap: text to bytes and back in the encoding create( ) chose
 * (mv_js_encoding: utf8 or utf16le / utf-16le). The work is abap.EncodeText /
 * abap.DecodeText; N and bytes that are no valid text are refused, not guessed.
 */
function nativeCodepage(classes) {
  const out = [];
  const has = (fn) => classes.some((c) => c.methods.some((m) => m.body?.[0]?.fn === fn));
  const sup = (cls, meth, p) => classes.find((c) => c.name === cls)?.methods.find((m) => m.name === meth)?.params.some((x) => x.name === p);
  if (has("Native_CONV_OUT_CONVERT")) {
    const withSup = sup("CL_ABAP_CONV_OUT_CE", "CONVERT", "SUP_N");
    out.push(`func Native_CONV_OUT_CONVERT(s *abap.Session, me *CL_ABAP_CONV_OUT_CE, data string, n int32, buffer *string${withSup ? ", sup_n string" : ""}) {`,
      ...(withSup ? ["\tif sup_n != \"\" {", "\t\tdata = abap.SubS(data, 0, n)", "\t}"] : ["\tif n != 0 {", `\t\tpanic(abap.NotCompiled("CL_ABAP_CONV_OUT_CE=>CONVERT", "N given"))`, "\t}"]),
      `\t*buffer = abap.EncodeText(me.${ident("MV_JS_ENCODING")}, data)`, "}", "");
  }
  if (has("Native_CONV_IN_CONVERT")) {
    const withSup = sup("CL_ABAP_CONV_IN_CE", "CONVERT", "SUP_N");
    out.push(`func Native_CONV_IN_CONVERT(s *abap.Session, me *CL_ABAP_CONV_IN_CE, input string, n int32, data *string${withSup ? ", sup_n string" : ""}) {`,
      "\tif n != 0 {", `\t\tpanic(abap.NotCompiled("CL_ABAP_CONV_IN_CE=>CONVERT", "N given (open-abap ignores it)"))`, "\t}",
      `\t*data = abap.DecodeText(me.${ident("MV_JS_ENCODING")}, me.${ident("MV_IGNORE_CERR")} != "", input)`, "}", "");
  }
  return out;
}

/*
 * Class-based exceptions: a CATCH takes a runtime exception of a class it
 * covers (decided by the front end) or a raised object whose class is one
 * of the names or inherits from one (decided at run time, over the table of
 * superclasses below). INTO receives the object itself, or, for a CATCH
 * that also covers runtime exceptions, an exception value.
 */
function catchCond(c) {
  const rt = c.covers.map((x) => `xE.Class == ${JSON.stringify(x)}`);
  const own = c.own.map((x) => `abap.IsA(xRX.Class, ${JSON.stringify(x)})`);
  const parts = [];
  if (rt.length) parts.push(`(xOK && (${rt.join(" || ")}))`);
  if (own.length) parts.push(`(xROK && (${own.join(" || ")}))`);
  return parts.length ? parts.join(" || ") : "false";
}

function catchInto(c, t, ctx) {
  if (!c.into) return [];
  // a local, or an attribute of the class (a report's global data)
  const v = c.intoPlace ? place(c.intoPlace, ctx) : ident(c.into);
  if (c.intoKind === "ref") return [`${t}\t\t\t\t${v} = abap.Cast[${goType(c.intoType)}](xRX.Obj)`];
  if (!c.own.length) return [`${t}\t\t\t\t${v} = &abap.Exception{Class: xE.Class, Op: xE.Op}`];
  return [`${t}\t\t\t\tif xROK {`, `${t}\t\t\t\t\t${v} = &abap.Exception{Class: xRX.Class, Obj: xRX.Obj}`, `${t}\t\t\t\t} else {`,
    `${t}\t\t\t\t\t${v} = &abap.Exception{Class: xE.Class, Op: xE.Op}`, `${t}\t\t\t\t}`];
}

function exceptionSupers(program) {
  const m = Object.entries(program.exceptionSupers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (m.length === 0) return [];
  return ["func init() {", "\tabap.RegisterSupers(map[string]string{", ...m.map(([k, v]) => `\t\t${JSON.stringify(k)}: ${JSON.stringify(v)},`), "\t})", "}", ""];
}

/**
 * describe_by_name for the Go host: a structure of the dictionary or a class's
 * TYPES becomes a CL_ABAP_STRUCTDESCR whose components are CL_ABAP_ELEMDESCRs
 * carrying the type kind, built from the same generated classes the ABAP
 * around it uses, so get_components( ) and ?= work as written. A name the
 * registry has that is not a structure (a class, a data element) dumps; a
 * name nobody has is TYPE_NOT_FOUND, as on a system.
 */
function nativeRtti(program) {
  const sd = CLASSES.get("CL_ABAP_STRUCTDESCR");
  const ed = CLASSES.get("CL_ABAP_ELEMDESCR");
  const comp = sd?.attributes.find((a) => a.name === "MT_REFS_COMP");
  const ret = goType({k: "ref", name: "CL_ABAP_TYPEDESCR"});
  const head = `func Native_DESCRIBE_BY_NAME(s *abap.Session, p_name string) ${ret} {`;
  if (!sd || !ed || !comp || comp.unsupported || sd.abstract || ed.abstract) {
    return [head, `\tpanic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_NAME", "RTTI needs CL_ABAP_STRUCTDESCR and CL_ABAP_ELEMDESCR compiled"))`, "}", ""];
  }
  const has = (cls, a) => [cls, ...ancestorsOf(cls)].some((c) => c.attributes?.some((x) => x.name === a && !x.unsupported && !x.static));
  const set = (cls, v, a, val) => (has(cls, a) ? [`\t${v}.${ident(a)} = ${val}`] : []);
  const out = ["// the structures RTTI can describe: name -> components (name, type kind)", "var rttiStructs = map[string][][2]string{"];
  for (const [n, cs] of [...program.rtti.structs].sort()) out.push(`\t${JSON.stringify(n)}: {${cs.map((c) => `{${JSON.stringify(c.name)}, ${JSON.stringify(c.kind)}}`).join(", ")}},`);
  out.push("}", "", "var rttiKnown = map[string]bool{", ...[...program.rtti.known].sort().map((n) => `\t${JSON.stringify(n)}: true,`), "}", "");
  const row = comp.type.row.go;
  out.push(head, `\tname := strings.ToUpper(strings.TrimRight(p_name, " "))`, "\tfields, ok := rttiStructs[name]", "\tif !ok {",
    "\t\tif rttiKnown[name] {", `\t\t\tpanic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_NAME", "RTTI in the Go host describes structures only: "+name))`, "\t\t}",
    `\t\tpanic(abap.ClassicException{Name: "TYPE_NOT_FOUND", Method: "DESCRIBE_BY_NAME"})`, "\t}",
    "\td := Alloc_CL_ABAP_STRUCTDESCR()",
    ...set(sd, "d", "KIND", `"S"`), ...set(sd, "d", "TYPE_KIND", `"u"`), ...set(sd, "d", "RELATIVE_NAME", "name"),
    ...set(sd, "d", "ABSOLUTE_NAME", "`\\TYPE=` + name"), ...set(sd, "d", "DDIC", `"X"`),
    "\tfor _, f := range fields {", "\t\te := Alloc_CL_ABAP_ELEMDESCR()",
    ...set(ed, "e", "KIND", `"E"`).map((l) => `\t${l}`), ...set(ed, "e", "TYPE_KIND", "f[1]").map((l) => `\t${l}`), ...set(ed, "e", "RELATIVE_NAME", "f[0]").map((l) => `\t${l}`),
    `\t\tc := ${row}{}`, `\t\tc.${ident("name")} = f[0]`, `\t\tc.${ident("type")} = e`,
    `\t\td.${ident("mt_refs_comp")} = append(d.${ident("mt_refs_comp")}, ${rowStored(comp.type, "c")})`,
    ...(has(sd, "MT_REFS") ? [`\t\td.${ident("mt_refs")} = append(d.${ident("mt_refs")}, ${rowStored(sd.attributes.find((a) => a.name === "MT_REFS").type, "c")})`] : []), "\t}", "\treturn d", "}", "");
  return out;
}

/*
 * describe_by_data for the Go host (ultra/json; open-abap-core writes it as
 * kernel code): the descriptor of the value's type, built from the same
 * generated RTTI classes the ABAP around it uses, so ?=, get_components( )
 * and get_table_line_type( ) work as written. One descriptor per type,
 * kept for the process, as a system hands out the same object. The values
 * are A4H's (2026-09-24, ZCL_GOGEN_T_SECKEY's RTTI probe in $ZOSG_TMP_0420):
 *   kind / type_kind; length in bytes (c and n two per character, d 16,
 *   t 12, f 8, i 4, int8 8, string and xstring 8, a table 8); decimals;
 *   output_length (c, n: the length, x twice it, d 8, t 6, f 24, i 11,
 *   int8 20, p 2 * length + (decimals > 0), string 0);
 *   absolute_name \TYPE=D, T, F, I, INT8, STRING, XSTRING for the built-in
 *   types, \TYPE-POOL=ABAP\TYPE=ABAP_BOOL, \TYPE=<data element> with ddic
 *   'X', \CLASS=<class>\TYPE=<type> for a class's structure type.
 * Left out, rather than invented: the technical name A4H gives an unnamed
 * c, n, x or p (\TYPE=%_T... here counts up as open-abap's does), the
 * output length of a p that comes from the dictionary, a structure's length,
 * a table type's name and its key. A reference or an object is refused.
 */
function nativeRttiData(program) {
  const td = CLASSES.get("CL_ABAP_TYPEDESCR");
  const ed = CLASSES.get("CL_ABAP_ELEMDESCR");
  const sd = CLASSES.get("CL_ABAP_STRUCTDESCR");
  const tb = CLASSES.get("CL_ABAP_TABLEDESCR");
  const ret = goType({k: "ref", name: "CL_ABAP_TYPEDESCR"});
  const head = `func Native_DESCRIBE_BY_DATA(s *abap.Session, p_data abap.Data) ${ret} {`;
  const attr = (cls, a) => [cls, ...ancestorsOf(cls)].flatMap((c) => c.attributes ?? []).find((x) => x.name === a && !x.unsupported && !x.static);
  const need = [[ed, "OUTPUT_LENGTH"], [sd, "MT_REFS"], [sd, "MT_REFS_COMP"], [sd, "COMPONENTS"], [tb, "MO_LINE_TYPE"], [tb, "TABLE_KIND"], [tb, "HAS_UNIQUE_KEY"],
    [td, "KIND"], [td, "TYPE_KIND"], [td, "LENGTH"], [td, "DECIMALS"], [td, "ABSOLUTE_NAME"], [td, "RELATIVE_NAME"], [td, "DDIC"]];
  const missing = [td, ed, sd, tb].some((c) => !c || c.abstract) ? "the RTTI classes" : need.filter(([c, a]) => !attr(c, a)).map(([c, a]) => `${c.name}-${a}`).join(", ");
  if (missing) return [head, `\tpanic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", ${JSON.stringify(`RTTI needs ${missing} compiled`)}))`, "}", ""];
  const refRow = attr(sd, "MT_REFS").type.row.go;
  const compRow = attr(sd, "COMPONENTS").type.row.go;
  const dataRef = goType(attr(sd, "MT_REFS").type.row.k === "struct" ? STRUCTDEFS.get(refRow).fields.find((f) => f.name === "TYPE").type : null);
  const f = (a) => ident(a);
  return [
    // parity-wave1: the output lengths of the data elements the program's
    // components are typed with (frontend ddicOutputLength)
    "// the output length of each data element named by a component (its domain's, or its own)",
    `var rttiOutputLen = map[string]int32{${[...(program.ddicOutputLen ?? new Map())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ")}}`, "",
    "// the descriptors handed out, one per type (rttiOf)",
    `var rttiDescs = map[*abap.Type]${ret}{}`, "",
    "var rttiAnon int", "",
    head, "	if p_data.T == nil {", `		panic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", "a value without a type"))`, "	}", "	return rttiOf(p_data.T)", "}", "",
    `func rttiOf(t *abap.Type) ${ret} {`,
    "	if d, ok := rttiDescs[t]; ok {", "		return d", "	}",
    `	var d ${ret}`,
    "	var base *CL_ABAP_TYPEDESCR",
    `	builtin := ""`,
    "	switch t.Kind {",
    "	case 'u', 'v':",
    "		sd := Alloc_CL_ABAP_STRUCTDESCR()",
    "		d, base = sd, sd.As_CL_ABAP_TYPEDESCR()",
    `		base.${f("KIND")} = "S"`,
    "		rttiDescs[t] = d",
    "		for _, c := range t.Comps {",
    `			sd.${f("MT_REFS")} = append(sd.${f("MT_REFS")}, ${rowStored(attr(sd, "MT_REFS").type, `${refRow}{${f("NAME")}: c.Name, ${f("TYPE")}: abap.Cast[${dataRef}](rttiOf(c.T))}`)})`,
    "			ct := rttiOf(c.T).As_CL_ABAP_TYPEDESCR()",
    `			sd.${f("COMPONENTS")} = append(sd.${f("COMPONENTS")}, ${rowStored(attr(sd, "COMPONENTS").type, `${compRow}{${f("NAME")}: c.Name, ${f("TYPE_KIND")}: ct.${f("TYPE_KIND")}, ${f("LENGTH")}: ct.${f("LENGTH")}, ${f("DECIMALS")}: ct.${f("DECIMALS")}}`)})`,
    "		}",
    `		sd.${f("MT_REFS_COMP")} = append(sd.${f("MT_REFS_COMP")}[:0:0], sd.${f("MT_REFS")}...)`,
    "	case 'h':",
    "		td := Alloc_CL_ABAP_TABLEDESCR()",
    "		d, base = td, td.As_CL_ABAP_TYPEDESCR()",
    `		base.${f("KIND")}, base.${f("LENGTH")} = "T", 8`,
    "		rttiDescs[t] = d",
    `		td.${f("MO_LINE_TYPE")} = rttiOf(t.Row)`,
    `		td.${f("TABLE_KIND")} = "S"`,
    "		if t.Append == nil {",
    `			td.${f("TABLE_KIND")}, td.${f("HAS_UNIQUE_KEY")} = "H", "X"`,
    "		}",
    "	case 'r':",
    `		if t.Name != "ZCL_AJSON" { panic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", "an unmeasured object reference: "+t.Name)) }`,
    "		rd := Alloc_CL_ABAP_REFDESCR()",
    "		od := Alloc_CL_ABAP_OBJECTDESCR()",
    `		od.${f("ABSOLUTE_NAME")} = "\\\\CLASS=" + t.Name`,
    `		rd.${f("REFERENCED")} = od`,
    `		d, base = rd, rd.As_CL_ABAP_TYPEDESCR()`,
    "		rttiDescs[t] = d",
    "	case 'l':",
    `		panic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", "a data reference without a known target"))`,
    "	default:",
    "		ed := Alloc_CL_ABAP_ELEMDESCR()",
    "		d, base = ed, ed.As_CL_ABAP_TYPEDESCR()",
    `		base.${f("KIND")} = "E"`,
    "		n := t.Len",
    "		var length, out int32",
    // a dictionary type's output length is its domain's (or data element's):
    // taken from rttiOutputLen, the data elements of the registry
    // (parity-wave1, A4H ZCL_GOGEN_T_RTTIOL); one not there is refused rather
    // than taken from the length (ultra/json fix round, critic finding 6).
    // ABAP_BOOL is measured
    "		ddicOut, fromDDIC := rttiOutputLen[t.DDIC]",
    `		if t.DDIC != "" && t.DDIC != "ABAP_BOOL" && (t.Kind == 'C' || t.Kind == 'N' || t.Kind == 'P') && !fromDDIC {`,
    `			panic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", "the output length of "+t.DDIC+", a dictionary type of kind "+string(t.Kind)+", is its domain's and not carried"))`,
    "		}",
    "		switch t.Kind {",
    "		case 'C':", "			length, out = int32(2*n), int32(n)",
    "		case 'N':", "			length, out = int32(2*n), int32(n)",
    "		case 'X':", "			length, out = int32(n), int32(2*n)",
    "		case 'D':", `			length, out, builtin = 16, 8, "D"`,
    "		case 'T':", `			length, out, builtin = 12, 6, "T"`,
    "		case 'F':", `			length, out, builtin = 8, 24, "F"`,
    "		case 'I':", `			length, out, builtin = 4, 11, "I"`,
    "		case '8':", `			length, out, builtin = 8, 20, "INT8"`,
    "		case 'g':", `			length, builtin = 8, "STRING"`,
    "		case 'y':", `			length, builtin = 8, "XSTRING"`,
    "		case 'P':",
    "			length = int32(n / 100)",
    `			base.${f("DECIMALS")} = int32(n % 100)`,
    "			out = 2 * length",
    "			if n%100 > 0 {", "				out++", "			}",
    "		default:",
    `			panic(abap.NotCompiled("CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", "type kind "+string(t.Kind)))`,
    "		}",
    `		base.${f("LENGTH")} = length`,
    `		if fromDDIC && (t.Kind == 'C' || t.Kind == 'N' || t.Kind == 'P') {`,
    "			out = ddicOut",
    "		}",
    `		ed.${f("OUTPUT_LENGTH")} = out`,
    "		rttiDescs[t] = d",
    "	}",
    `	base.${f("TYPE_KIND")} = string(t.Kind)`,
    "	switch {",
    `	case t.DDIC == "ABAP_BOOL":`,
    `		base.${f("ABSOLUTE_NAME")}, base.${f("RELATIVE_NAME")} = \`\\TYPE-POOL=ABAP\\TYPE=ABAP_BOOL\`, "ABAP_BOOL"`,
    `	case t.DDIC != "" && !strings.Contains(t.DDIC, "-"):`,
    `		base.${f("ABSOLUTE_NAME")}, base.${f("RELATIVE_NAME")}, base.${f("DDIC")} = \`\\TYPE=\`+t.DDIC, t.DDIC, "X"`,
    `	case (t.Kind == 'u' || t.Kind == 'v') && strings.Contains(t.Name, "=>") && !strings.Contains(t.Name, "-"):`,
    `		cls, typ, _ := strings.Cut(t.Name, "=>")`,
    `		base.${f("ABSOLUTE_NAME")}, base.${f("RELATIVE_NAME")} = \`\\CLASS=\`+cls+\`\\TYPE=\`+typ, typ`,
    `	case builtin != "":`,
    `		base.${f("ABSOLUTE_NAME")}, base.${f("RELATIVE_NAME")} = \`\\TYPE=\`+builtin, builtin`,
    "	default:",
    "		rttiAnon++",
    `		base.${f("ABSOLUTE_NAME")} = \`\\TYPE=%_T000000000000000\` + abap.FmtI(int32(rttiAnon))`,
    "	}",
    "	return d",
    "}", "",
  ];
}

/*
 * LCL_JSON_PARSER=>PARSE of open-abap-core's CL_SXML_STRING_READER, whose
 * work is JavaScript on Node (JSON.parse and the TRAVERSE walk): the node
 * list abap.JSONNodes makes, written into the table IT_NODES points to; a
 * text that is not JSON raises CX_SXML_PARSE_ERROR (XML_OFFSET 0, see
 * go/abap/jsonparse.go) (ultra/json)
 */
function nativeJsonParse() {
  const head = "func Native_JSON_PARSE(s *abap.Session, iv_json string, it_nodes abap.Data) {";
  const cx = CLASSES.get("CX_SXML_PARSE_ERROR");
  const ctor = cx?.constructor?.params ?? cx?.ctorParams;
  const raise = cx && !cx.abstract ? `panic(abap.Raise(New_CX_SXML_PARSE_ERROR(s, 0), "CX_SXML_PARSE_ERROR"))`
    : `panic(abap.NotCompiled("LCL_JSON_PARSER=>PARSE", "CX_SXML_PARSE_ERROR is not compiled"))`;
  void ctor;
  return [head, "	nodes, ok := abap.JSONNodes(iv_json)", "	if !ok {", `		${raise}`, "	}", "	abap.FillJSONNodes(it_nodes, nodes)", "}", ""];
}

/**
 * CALL METHOD (class)=>m: every compiled class is known by name, and each
 * static method whose name some dynamic call uses gets an adapter that reads
 * its arguments out of generic data by name. A class the registry has but the
 * program did not compile dumps instead of passing for an unknown one.
 */
function staticRegistry(program, classes) {
  const wanted = program.dynStatics ?? new Set();
  if (wanted.size === 0) return [];
  const out = ["func init() {", `\tabap.KnownClasses(${goStrings(classes.map((c) => c.name))}, ${goStrings([...(program.rtti?.known ?? [])].filter((n) => !n.includes("=>")))})`];
  for (const cls of classes) {
    for (const m of [...cls.methods, ...(cls.stubs ?? [])]) {
      if (!m.static || !wanted.has(m.name) || !definable(program, m)) continue;
      const lines = [];
      const args = m.params.map((p, i) => {
        const v = `v${i}`;
        if (p.dir !== "importing") { lines.push(`\t\t${v} := new(${goType(p.type)})`); return v; }
        if (p.suppliedOf) { lines.push(`\t\t${v} := ""`, `\t\tif _, ok := a[${JSON.stringify(p.suppliedOf)}]; ok {`, `\t\t\t${v} = "X"`, `\t\t}`); return v; }
        const read = (d) => (["i", "string", "c", "d", "t"].includes(p.type.k) ? unwrapTo(p.type, d)
          : p.type.k === "data" ? d : byRef(p) ? `${d}.P.(*${goType(p.type)})` : `*${d}.P.(*${goType(p.type)})`);
        const absent = p.optional && p.default === undefined ? zero(p.type)
          : `func() ${byRef(p) ? "*" : ""}${goType(p.type)} { panic(abap.ArithmeticError{Class: "CX_SY_DYN_CALL_PARAM_MISSING", Op: ${JSON.stringify(`${cls.name}=>${m.name} ${p.name}`)}}) }()`;
        lines.push(`\t\tvar ${v} ${byRef(p) ? "*" : ""}${goType(p.type)}`, `\t\tif d, ok := a[${JSON.stringify(p.name)}]; ok {`, `\t\t\t${v} = ${read("d")}`, `\t\t} else {`,
          `\t\t\t${v} = ${byRef(p) && p.optional && p.default === undefined ? `new(${goType(p.type)})` : absent}`, `\t\t}`);
        return v;
      });
      out.push(`\tabap.RegisterStatic(${JSON.stringify(`${cls.name}=>${m.name}`)}, ${goStrings(m.params.filter((p) => p.dir === "importing").map((p) => p.name))}, func(s *abap.Session, a map[string]abap.Data) {`,
        ...lines, `\t\t${funcName(cls.name, m.name)}(${["s", ...args].join(", ")})`, "\t})");
    }
  }
  out.push("}", "");
  return out;
}

const goStrings = (xs) => `[]string{${xs.map((x) => JSON.stringify(x)).join(", ")}}`;

function ancestorsOf(cls) {
  const out = [];
  for (let c = cls; c.super && CLASSES.has(c.super);) { c = CLASSES.get(c.super); out.push(c); }
  return out;
}

/**
 * I_<class>: what a reference to a class with subclasses can call. It embeds
 * the superclass's interface, adds the class's own public and protected
 * instance methods, and As_<class>, which gives the class's part of the
 * object (its attributes) and keeps an unrelated class with the same methods
 * from fitting.
 */
function classInterface(program, cls) {
  const T = typeName(cls.name);
  const out = [`type I_${T} interface {`];
  if (cls.super && POLY.has(cls.super)) out.push(`\tI_${typeName(cls.super)}`);
  for (const intf of implementedInterfaces(program, cls)) out.push(`\t${interfaceMarker(intf)}()`);
  out.push(`\tAs_${T}() *${T}`);
  // the accessors of the interfaces the class implements, so the reference converts to them
  for (const a of (cls.attributes ?? []).filter((x) => x.fromIntf && !x.unsupported)) out.push(`\t${accessorName(a.name)}() *${goType(a.type)}`);
  for (const m of cls.signatures?.values() ?? []) {
    if (m.unsupported || m.static || m.private || m.name === "CONSTRUCTOR" || !definable(program, m)) continue;
    out.push(`\t${signature({name: cls.name}, m, true)}`);
  }
  out.push("}", "", `func (me *${T}) As_${T}() *${T} { return me }`, "");
  return out;
}

/*
 * An interface's DATA through a reference to the interface: a Go interface
 * has no fields, so it carries one accessor per attribute, a pointer to the
 * object's own field, and every class that implements the interface gives
 * it. A read is *p, a write *p = v; both reach the object.
 */
const accessorName = (attr) => `Ptr_${typeName(attr)}`;

// Exported methods have the same identity in every Go package. The Greek
// letter cannot come from an ABAP name: ident() and typeName() emit ASCII
// only, so no user method/accessor can collide with this generated marker.
const interfaceMarker = (intf) => `AbapΩImplements_${typeName(intf)}`;

function implementedInterfaces(program, cls) {
  const out = new Set();
  for (const c of [cls, ...ancestorsOf(cls)]) {
    for (const intf of c.interfaces ?? []) {
      out.add(intf);
      for (const included of componentInterfaces(program.reg, intf)) out.add(included);
    }
  }
  return out;
}

function componentInterfaces(reg, intf, seen = new Set()) {
  for (const c of reg?.getObject("INTF", intf)?.getDefinition()?.getImplementing?.() ?? []) {
    const name = String(c.name).toUpperCase();
    if (!seen.has(name)) { seen.add(name); componentInterfaces(reg, name, seen); }
  }
  return [...seen];
}

function intfAccessors(program, intf) {
  return (program.interfaceAttrs?.get(intf) ?? []).filter((a) => !a.static && !a.unsupported && definable(program, {params: [{type: a.type}]}))
    .map((a) => `\t${accessorName(a.name)}() *${goType(a.type)}`);
}

function attrAccessors(cls, inst) {
  const out = inst.filter((a) => a.fromIntf).map((a) => `func (me *${typeName(cls.name)}) ${accessorName(a.name)}() *${goType(a.type)} { return &me.${ident(a.name)} }`);
  return out.length ? [...out, ""] : [];
}

/** a signature whose every type is declared in this program */
export function definable(program, m) {
  const ok = (t) => {
    if (!t) return true;
    if (t.k === "struct") return program.structs.has(t.go);
    if (t.k === "table") return ok(t.row);
    if (t.k === "ref") return t.name === "OBJECT" || (t.intf ? program.interfaceMethods?.has(t.name) : true);
    return true;
  };
  return m.params.every((p) => ok(p.type)) && ok(m.returning?.type);
}

export function referencedClasses(program) {
  const seen = new Set();
  const visit = (t) => {
    if (!t) return;
    if (t.k === "ref" && !t.intf) seen.add(t.name);
    if (t.k === "table") visit(t.row);
  };
  for (const st of program.structs?.values() ?? []) st.fields.forEach((f) => visit(f.type));
  for (const c of program.classes ?? []) {
    (c.attributes ?? []).forEach((a) => visit(a.type));
    [...c.methods, ...(c.stubs ?? []), ...(c.constructor ? [c.constructor] : [])].forEach((m) => {
      m.params?.forEach((p) => visit(p.type)); visit(m.returning?.type); m.locals?.forEach((l) => visit(l.type));
    });
  }
  for (const sigs of program.interfaceMethods?.values() ?? []) sigs.forEach((m) => { m.params.forEach((p) => visit(p.type)); visit(m.returning?.type); });
  return seen;
}

/** the bytes of an x literal written as hex text, padded or cut to its length */
export function hexBytes(text, len) {
  const b = (String(text).match(/[0-9a-fA-F]{2}/g) ?? []).map((h) => parseInt(h, 16));
  if (len === undefined) return b;
  return b.length >= len ? b.slice(0, len) : [...b, ...new Array(len - b.length).fill(0)];
}

function constLiteral(c) {
  // a structured constant: its components, an unset one initial
  if (c.type.k === "struct") {
    const fields = STRUCTDEFS.get(c.type.go)?.fields ?? [];
    return `${c.type.go}{${fields.map((f) => `${ident(f.name)}: ${c.value[f.name] === undefined ? zero(f.type) : constLiteral({type: f.type, value: c.value[f.name]})}`).join(", ")}}`;
  }
  if (c.type.k === "i") return String(Number(c.value));
  // int8: the digits as written, a JS number would round 9223372036854775807
  if (c.type.k === "int8") return String(BigInt(String(c.value).trim()));
  if (c.type.k === "f") return String(Number(c.value));
  if (c.type.k === "n") return JSON.stringify(String(c.value));
  if (c.type.k === "string" || c.type.k === "c") return JSON.stringify(c.type.k === "c" ? c.value.replace(/ +$/, "") : c.value);
  if (c.type.k === "x" || c.type.k === "xstring") return `"${hexBytes(c.value, c.type.len).map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}"`;
  throw new Error(`constant of type ${c.type.k}`);
}

function signature(cls, m, inInterface = false) {
  const params = ["s *abap.Session", ...m.params.map((p) => `${ident(p.name)} ${p.dir === "importing" && !byRef(p) ? "" : "*"}${goType(p.type)}`)];
  const ret = m.returning ? ` (${ident(m.returning.name)} ${goType(m.returning.type)})` : "";
  if (inInterface) return `${typeName(m.name)}(${params.join(", ")})${ret}`;
  return m.static
    ? `func ${funcName(cls.name, m.name)}(${params.join(", ")})${ret}`
    : `func (me *${typeName(cls.name)}) ${typeName(m.name)}(${params.join(", ")})${ret}`;
}

/*
 * AMC's generated half (go/amc): AMCDefine gives the broker the program's
 * SAMC channels (frontend.mjs samcOf), AMCDeliver runs a receiver's RECEIVE
 * for a message in the waiting session, with the producer's client and user
 * in a ZCL_AMC_MESSAGE_CONTEXT, as tools/osd-amc.mjs drainAmcSession does.
 * The receiver is reached by its method alone, so the Go runtime needs none
 * of the generated types.
 */
function amcGlue(program) {
  const channels = (program.amcChannels ?? []).map((c) => {
    const auth = (c.authorities ?? []).map((a) => `{Path: ${JSON.stringify(a.path ?? "")}, Program: ${JSON.stringify(a.program ?? "")}, Activity: ${JSON.stringify(a.activity ?? "")}}`);
    return `\t\tamc.Channel{App: ${JSON.stringify(c.applicationId)}, Path: ${JSON.stringify(c.path)}, Type: ${JSON.stringify(c.type)}, Scope: ${JSON.stringify(c.scope ?? "")}, Auth: []amc.Authority{${auth.join(", ")}}},`;
  });
  const cases = [];
  for (const [type, intf] of [["TEXT", "IF_AMC_MESSAGE_RECEIVER_TEXT"], ["BINARY", "IF_AMC_MESSAGE_RECEIVER_BINARY"], ["PCP", "IF_AMC_MESSAGE_RECEIVER_PCP"]]) {
    // the receiver interfaces are rarely used as reference types, so their
    // RECEIVE is read off a class that implements it
    const m = program.interfaceMethods?.get(intf)?.find((x) => x.name === "RECEIVE")
      ?? [...CLASSES.values()].map((c) => c.signatures?.get(`${intf}~RECEIVE`)).find((x) => x && !x.unsupported);
    if (!m || !definable(program, m) || !CLASSES.has("ZCL_AMC_MESSAGE_CONTEXT")) continue;
    const msgType = goType(m.params.find((p) => p.name === "I_MESSAGE").type);
    cases.push(`\t\tcase ${JSON.stringify(type)}:`,
      `\t\t\tr, ok := receiver.(interface{ ${signature({}, {...m, name: `${intf}~RECEIVE`}, true)} })`,
      `\t\t\tmsg, okMsg := m.Payload.(${msgType})`,
      // a receiver or a message of another shape is a host error, never a
      // message that quietly does not arrive
      `\t\t\tif !ok || !okMsg {`,
      `\t\t\t\tpanic(abap.NotCompiled("AMC delivery", "a "+amc.TypeOf(receiver)+" cannot receive a ${type} message ("+amc.TypeOf(m.Payload)+")"))`,
      `\t\t\t}`,
      `\t\t\tr.${typeName(`${intf}~RECEIVE`)}(s, msg, New_ZCL_AMC_MESSAGE_CONTEXT(s, m.Client, m.Username))`);
  }
  return ["// AMCDefine gives the broker this program's SAMC channels (go/amc).", "func AMCDefine() {", "\tamc.Current().Define(",
    ...channels, "\t)", "}", "",
    "// AMCDeliver runs an AMC receiver in session s (go/amc).", "func AMCDeliver(s *abap.Session) amc.Deliver {",
    "\treturn func(receiver any, m amc.Message) {", "\t\tswitch m.Type {", ...cases,
    "\t\tdefault:", "\t\t\tpanic(abap.NotCompiled(\"AMC delivery\", \"no receiver for a \"+m.Type+\" message in this program\"))", "\t\t}", "\t}", "}", ""];
}

function method(cls, m) {
  const lines = [...(LINES && m.pos ? [`//line ${m.pos.file}:${m.pos.row}`] : []), `${signature(cls, m)} {`, "\t_ = s"];
  if (m.static && m.name !== "CLASS_CONSTRUCTOR" && chainCctor(cls)) lines.push(`\tEnsure_${typeName(cls.name)}(s)`);
  if (!m.static) lines.push("\t_ = me");
  if (cls.hostReplaced) lines.push(...hostMethod(cls, m));
  // a method that calls the AMC API: its class pool is who is calling while
  // it runs, for the SAMC authorities (go/amc Enter/Caller)
  if (m.amcProgram) lines.push(`\tdefer amc.Current().Enter(s, ${JSON.stringify(m.amcProgram)})()`);
  // a local whose initial value is not Go's zero value (an x of its length in
  // 00 bytes, d, t, n, p) starts at the type's initial value, as the JS
  // emitter's locals do; before (ultra/packs, ZCL_GOGEN_T_BYTECAT) an x never
  // assigned read as zero bytes long
  for (const l of m.locals) {
    const z = OWNERSHIP.declarations.has(l) && l.type.k === "x" ? `${ownedType(l)}{}` : zero(l.type);
    lines.push(isGoZero(z) ? `\tvar ${ident(l.name)} ${ownedType(l)}` : `\tvar ${ident(l.name)} ${ownedType(l)} = ${z}`, `\t_ = ${ident(l.name)}`);
  }
  // the RETURNING parameter starts at its initial value too (the JS emitter's
  // let r = zero(t)); Go's named result starts at Go's zero value
  if (m.returning && !isGoZero(zero(m.returning.type))) lines.push(`\t${ident(m.returning.name)} = ${zero(m.returning.type)}`);
  for (const f of m.fieldSymbols ?? []) lines.push(`\tvar ${ident(f.name)} ${f.type.k === "data" ? "abap.Data" : f.type.k === "struct" ? `*${goType(f.type)}` : `*abap.RowBinding[${goType(f.type)}]`}`, `\t_ = ${ident(f.name)}`);
  // A method can touch the same static repeatedly in a hot loop. Retain its
  // stable class pointer instead of repeating the slot lookup. A store never
  // replaces an initialized slot, including when another class is initialized.
  const staticStores = new Map();
  const collectStatics = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.e === "static" && !staticStores.has(node.owner)) staticStores.set(node.owner, `static_${typeName(node.owner)}`);
    for (const value of Object.values(node)) collectStatics(value);
  };
  collectStatics(m.body);
  if (staticStores.size) lines.push("\t// The store never replaces class pointers; cache them for this method call.");
  for (const [owner, store] of staticStores) lines.push(`\t${store} := St_${typeName(owner)}(s)`);
  const ctx = {cls, loop: 0, inCtor: m.name === "CONSTRUCTOR", method: m, staticStores};
  const valueOutputs = m.params.filter((p) => p.dir !== "importing" && p.byValue);
  if (valueOutputs.length) {
    ctx.valueOutputs = new Set(valueOutputs.map((p) => p.name));
    // The callee owns VALUE output parameters. Copy them to the caller only
    // after a normal return; a panic unwinds this closure without copy-back.
    for (const p of valueOutputs) lines.push(`\tvar ${ident(p.name)}_value ${goType(p.type)}`);
    lines.push("\tfunc() {");
    for (const p of valueOutputs) lines.push(`\t\tvar ${ident(p.name)} ${goType(p.type)} = ${p.dir === "changing" ? copied(`*${ident(p.name)}`, p.type) : zero(p.type)}`, `\t\t_ = ${ident(p.name)}`,
      `\t\tdefer func() { ${ident(p.name)}_value = ${ident(p.name)} }()`);
    lines.push(...stmtList(m.body, ctx, 2));
    lines.push("\t}()");
    for (const p of valueOutputs) lines.push(`\t*${ident(p.name)} = ${copied(`${ident(p.name)}_value`, p.type)}`);
  } else lines.push(...stmtList(m.body, ctx, 1));
  lines.push("\treturn", "}");
  if (LINES && m.pos) lines.push(RESET);
  return lines;
}

function hostMethod(cls, m) {
  const field = m.name === "SESSION_ID" ? "SessionID" : m.name.split("_").map((part, i) => i === 0 ? part[0] + part.slice(1).toLowerCase() : part[0] + part.slice(1).toLowerCase()).join("");
  const hook = `hHostclass.${cls.name}.${field}`;
  const ret = m.returning;
  // the IS SUPPLIED flags are the emitter's, not the hook's
  const call = `${hook}(${["s", ...m.params.filter((p) => !p.suppliedOf).map((p) => ident(p.name))].join(", ")})`;
  const lines = [`\tif ${hook} != nil {`];
  if (ret) lines.push(`\tresult, err := ${call}`);
  else lines.push(`\terr := ${call}`);
  lines.push("\t\thostRaise(s, err)");
  if (ret) {
    if (ret.type.k === "c" && (ret.type.len ?? 1) === 1) lines.push(`\t${ident(ret.name)} = map[bool]string{true: "X", false: " "}[result]`);
    else lines.push(`\t${ident(ret.name)} = result`);
  }
  lines.push("\t\treturn", "\t}");
  return lines;
}

function hostRaiseGlue(program, classes, layers) {
  if (!classes.some((cls) => cls.hostReplaced)) return [];
  const cases = [];
  for (const cls of CLASSES.values()) {
    if (layers && !(layers.visibleClasses ?? new Set(classes.map((c) => c.name))).has(cls.name)) continue;
    for (const method of cls.methods) {
      if (!(program.exceptionSupers ?? {})[cls.name] || !method.static || method.returning?.type.k !== "ref"
        || !method.params.every((p) => p.suppliedOf || p.optional || p.default !== undefined)) continue;
      cases.push([`${cls.name}=>${method.name}`, expr(omittedFactoryCall(program, cls, method), {cls})]);
    }
  }
  const lines = ["// hostRaise turns a host's factory request into an ABAP exception.",
    "func hostRaise(s *abap.Session, err error) {", "\tif err == nil { return }",
    "\tif raise, ok := err.(*hHostclass.Raise); ok {",
    `\t\tname := strings.ToUpper(raise.Class) + "=>" + strings.ToUpper(raise.Factory)`,
    "\t\tswitch name {"];
  for (const [key, call] of cases) lines.push(`\t\tcase ${JSON.stringify(key)}:`, `\t\t\tpanic(abap.Raise(${call}, strings.ToUpper(raise.Class)))`);
  lines.push("\t\t}", `\t\tpanic(abap.NotCompiled(name, "no compiled exception factory callable with omitted parameters"))`,
    "\t}", "\tpanic(err)", "}", "");
  return lines;
}

const tab = (n) => "\t".repeat(n);

/**
 * who a call on me goes to. In a class with subclasses a public or protected
 * method is virtual: through self, the most-derived object. Not in a
 * constructor, though: there ABAP calls the class's own implementation, the
 * subclass's part does not exist yet.
 */
function self(ctx, methodName) {
  if (!POLY.has(ctx.cls.name)) return "me";
  // me as a value is the whole object, in a constructor too (New_ sets self first)
  if (methodName === null) return `me.${selfField(ctx.cls.name)}`;
  if (ctx.inCtor || ctx.cls.signatures?.get(methodName)?.private) return "me";
  return `me.${selfField(ctx.cls.name)}`;
}

/**
 * RETURN (1), EXIT (2) or CONTINUE (3) where it stands: inside a TRY's
 * closure it is a code for the closure to hand out (from a CATCH, which runs
 * in the deferred function, by setting the code); EXIT and CONTINUE belong to
 * the innermost loop, so only one outside the TRY makes them leave it; EXIT
 * outside any loop leaves the method, as in ABAP
 */
function leave(ctx, code) {
  const top = ctx.tries?.at(-1);
  const escapes = top && (code === 1 || (ctx.loopLevel ?? 0) === top.level);
  if (escapes) {
    const c = code !== 1 && top.level === 0 ? 1 : code;
    top.used.add(c);
    return top.mode === "body" ? `return ${c}` : `ctl = ${c}; return`;
  }
  if (code === 1 || (ctx.loopLevel ?? 0) === 0) return "return";
  return code === 2 ? "break" : "continue";
}

/** an IMPORTING argument: a composite by reference goes as a pointer, by VALUE as a clone */
function importingArg(a, ctx) {
  if (a.byValue === undefined || !composite(a.type)) return expr(a.value, ctx);
  if (!a.byValue) return addressable(a.value) ? `&${place(a.value, ctx)}` : `abap.Ptr(${expr(a.value, ctx)})`;
  return copied(expr(a.value, ctx), a.value.type, a.value);
}

// A component of a temporary structure is readable but Go cannot take its
// address. Keep the temporary alive in a box for a by-reference argument.
function addressable(x) {
  if (!PLACES.has(x.e)) return false;
  if (x.e === "field" || x.e === "row" || x.e === "row_key") return addressable(x.base);
  return true;
}

function place(p, ctx) {
  switch (p.e) {
    case "var": return p.ref && !ctx.valueOutputs?.has(p.name) ? `(*${ident(p.name)})` : ident(p.name);
    case "attr": return `me.${ident(p.name)}`;
    case "static": {
      // The frontend resolves inherited attributes to the declaring class.
      const owner = p.owner;
      const field = `${ctx.staticStores?.get(owner) ?? `St_${typeName(owner)}(s)`}.${ident(p.name)}`;
      const decl = CLASSES.get(owner)?.attributes?.find((a) => a.name === p.name);
      const type = decl ? ownedType(decl) : goType(p.type);
      return owner !== ctx.cls.name && CLASSES.has(owner) && chainCctor(CLASSES.get(owner))
        ? `(*func() *${type} { Ensure_${typeName(owner)}(s); return &${field} }())` : field;
    }
    case "const": return p.go;
    case "sy": return p.field === "Msgno" ? `(*s.Sy.MessageNumber())` : `s.Sy.${p.field}`;
    case "field": return `${PLACES.has(p.base.e) || p.base.e === "const" ? place(p.base, ctx) : `(${expr(p.base, ctx)})`}.${ident(p.name)}`;
    case "dref_field": return `abap.DerefAs[${goType(p.struct)}](${expr(p.base, ctx)}, ${JSON.stringify(`->${p.name}`)}).${ident(p.name)}`;
    case "fs": return p.type.k === "data" ? ident(p.name) : p.type.k === "struct" ? `(*${ident(p.name)})` : `(*abap.CheckedRowPtr(${ident(p.name)}))`;
    case "refattr": if (p.base.type.intf) return `(*${expr(p.base, ctx)}.${accessorName(p.name)}())`;
      return POLY.has(p.base.type.name) && !p.base.type.intf ? `${expr(p.base, ctx)}.As_${typeName(p.base.type.name)}().${ident(p.name)}` : `${expr(p.base, ctx)}.${ident(p.name)}`;
    case "row": {
      const b = place(p.base, ctx);
      return rowValue(p.base.type, `${b}[abap.Idx(len(${b}), ${expr(p.index, ctx)})]`);
    }
    case "row_key": {
      const b = place(p.base, ctx);
      const n = ctx.loop++;
      const keys = p.keys.map((k) => (k.line ? `r${n} == ${expr(k.value, ctx)}` : `r${n}.${ident(k.name)} == ${expr(k.value, ctx)}`)).join(" && ");
      return `(${stable(p.base.type) ? "**" : "*"}abap.RowByKey(&${b}, func(r${n} ${stable(p.base.type) ? "*" : ""}${goType(p.type)}) bool { return ${keys} }))`;
    }
    default: throw new Error(`not a place: ${p.e}`);
  }
}

/*
 * v = v && x inside a loop copies all of v on every pass in Go, where V8
 * keeps a rope: a JSON frame of 800 KB built that way cost Go ten times
 * JS. When a loop only ever appends to a local string, the loop gets a
 * strings.Builder for it and writes v back once after the loop.
 */
const leftmost = (e) => { while (e?.e === "concat") e = e.l; return e; };
const isAppend = (st, name) => st?.s === "assign" && st.target.e === "var" && !st.target.ref && st.target.type.k === "string"
  && (name === undefined || st.target.name === name) && st.value.e === "concat" && leftmost(st.value).e === "var" && leftmost(st.value).name === st.target.name;

function builders(body, ctx, outside = []) {
  const names = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    if (isAppend(n)) names.add(n.target.name);
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k]);
  };
  walk(body);
  // ultra/events: a name the loop's own condition (WHILE, LOOP ... WHERE)
  // reads must stay current on every pass: no builder for it (a WHILE
  // strlen( v ) < 32 appending to v never ended, ZCL_OSD_TRAN_SESSION=>NEW_ID)
  const read = new Set();
  const seen = (n) => {
    if (Array.isArray(n)) { n.forEach(seen); return; }
    if (!n || typeof n !== "object") return;
    if (n.e === "var") read.add(n.name);
    for (const k of Object.keys(n)) if (k !== "type") seen(n[k]);
  };
  seen(outside);
  return [...names].filter((name) => !read.has(name) && !ctx.builders?.has(name) && appendsOnly(body, name));
}

function appendsOnly(body, name) {
  let appends = 0;
  let refs = 0;
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    if (n.e === "var" && n.name === name) refs += 1;
    if (isAppend(n, name)) appends += 1;
    for (const k of Object.keys(n)) if (k !== "type") walk(n[k]);
  };
  walk(body);
  return appends > 0 && refs === 2 * appends;
}

/** a loop's lines, wrapped in the builders of the strings it only appends to */
/*
 * A sorted secondary key (frontend secondaryKey, ultra/json): the rows in the
 * key's order, taken once before the first pass (abap.KeyOrder: components
 * ascending, equal keys newest first, as A4H orders them); sy-tabix is the
 * position in that order. A unique key that holds a value twice is refused.
 */
function keyCmp(key, tb) {
  const parts = key.comps.map((c) => `if c := abap.${c.num ? "CmpNum" : "CmpS"}(${tb}[a].${ident(c.name)}, ${tb}[b].${ident(c.name)}); c != 0 {\n\t\treturn c\n\t}`);
  return `func(a, b int) int {\n\t${parts.join("\n\t")}\n\treturn 0\n}`;
}

function keyLoop(st, ctx, t, d) {
  const n = ctx.loop++;
  const tb = expr(st.table, ctx);
  const i = `ord${n}[k${n}]`;
  const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, i)}` : `${place(st.into, ctx)} = ${copied(rowValue(st.table.type, `${tb}[${i}]`), st.into.type)}`;
  const skip = st.where ? `${t}\t\tif !(${st.where.map((w) => `${tb}[${i}].${ident(w.name)} ${w.op === "=" ? "==" : w.op === "<>" ? "!=" : w.op} ${expr(w.value, ctx)}`).join(" && ")}) { continue }` : null;
  return [
    `${t}{`, `${t}\tsave${n} := s.Sy.Tabix`, `${t}\ts.Sy.Subrc = 4`,
    `${t}\tord${n} := abap.KeyOrder(len(${tb}), ${keyCmp(st.key, tb).replace(/\n/g, `\n${t}\t`)}, ${st.key.unique ? JSON.stringify(st.key.name) : `""`})`,
    `${t}\tfor k${n} := range ord${n} {`,
    ...(skip ? [skip] : []),
    `${t}\t\ts.Sy.Tabix = int32(k${n} + 1)`, `${t}\t\ts.Sy.Subrc = 0`,
    `${t}\t\t${bind}`,
    ...stmtList(st.body, ctx, d + 2),
    `${t}\t}`, `${t}\ts.Sy.Tabix = save${n}`, `${t}}`,
  ];
}

/*
 * A hashed secondary key (unique): the row holding the values (abap.KeyFind,
 * a scan, not a hash: the table is a plain slice and its rows can change in
 * place). sy-tabix is 0: the ABAP documentation of READ TABLE says so for a
 * hit by a hashed key and leaves a miss undefined; not measured on A4H.
 * The temporaries are spelled kV/kI/kR, an upper case letter after the
 * first, which ident never produces, so no ABAP name can shadow them.
 */
function keyValues(st, ctx, t, n) {
  return st.values.map((v, j) => `${t}\tkV${n}_${j} := ${expr(v, ctx)}`);
}

function keyEq(key, tb, n) {
  const eq = key.comps.map((c, j) => `abap.${c.num ? "CmpNum" : "CmpS"}(${tb}[kR].${ident(c.name)}, kV${n}_${j}) == 0`);
  return `func(kR int) bool { return ${eq.join(" && ")} }`;
}

/*
 * READ TABLE ... WITH KEY k COMPONENTS over a sorted secondary key: the
 * first row of the key's order with that value (abap.KeyRead), sy-tabix its
 * position; not found, sy-tabix is where it would go and sy-subrc 4, or 8
 * past the last row, and the target is left alone (A4H 2026-09-24).
 */
function readSecKey(st, ctx, t) {
  const n = ctx.loop++;
  const tb = expr(st.table, ctx);
  const vals = st.values.map((v, j) => `${t}\tv${n}_${j} := ${expr(v, ctx)}`);
  if (st.key.hashed) {
    const at = `kI${n}`;
    const bindH = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, at)}` : st.refInto ? `${place(st.into, ctx)} = ${rowRef(st.table.type, tb, `${tb}[${at}]`)}` : st.into ? `${place(st.into, ctx)} = ${copied(rowValue(st.table.type, `${tb}[${at}]`), st.into.type)}` : null;
    return [`${t}{`, ...keyValues(st, ctx, t, n),
      `${t}\t${at} := abap.KeyFind(len(${tb}), ${keyEq(st.key, tb, n)}, ${JSON.stringify(st.key.name)})`,
      `${t}\ts.Sy.Subrc, s.Sy.Tabix = 4, 0`,
      `${t}\tif ${at} >= 0 {`, ...(bindH ? [`${t}\t\t${bindH}`] : []), `${t}\t\ts.Sy.Subrc = 0`, `${t}\t}`, `${t}}`];
  }
  const cmp = st.key.comps.map((c, j) => `if c := abap.${c.num ? "CmpNum" : "CmpS"}(${tb}[i].${ident(c.name)}, v${n}_${j}); c != 0 {\n${t}\t\treturn c\n${t}\t}`);
  const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, `i${n}`)}` : st.refInto ? `${place(st.into, ctx)} = ${rowRef(st.table.type, tb, `${tb}[i${n}]`)}` : st.into ? `${place(st.into, ctx)} = ${copied(rowValue(st.table.type, `${tb}[i${n}]`), st.into.type)}` : null;
  return [`${t}{`, ...vals,
    `${t}\ti${n}, pos${n}, sub${n} := abap.KeyRead(len(${tb}), func(i int) int {\n${t}\t${cmp.join(`\n${t}\t`)}\n${t}\treturn 0\n${t}\t}, ${st.key.unique ? JSON.stringify(st.key.name) : `""`})`,
    `${t}\tif sub${n} == 0 {`, ...(bind ? [`${t}\t\t${bind}`] : []), `${t}\t}`, `${t}\t_ = i${n}`,
    `${t}\ts.Sy.Subrc, s.Sy.Tabix = sub${n}, pos${n}`, `${t}}`];
}

function withBuilders(body, ctx, t, emitLoop, outside = []) {
  // An exception can skip the loop's write-back, and code after ENDTRY can
  // read the appended value even when the handler does not.
  const names = ctx.tryBuilderBlocked ? [] : builders(body, ctx, outside);
  ctx.builders ??= new Map();
  for (const n of names) ctx.builders.set(n, `sb_${ident(n)}_${ctx.loop++}`);
  const pre = names.flatMap((n) => {
    const b = ctx.builders.get(n);
    return [`${t}var ${b} strings.Builder`, `${t}${b}.WriteString(${ident(n)})`];
  });
  ctx.loopLevel = (ctx.loopLevel ?? 0) + 1;
  const lines = emitLoop();
  ctx.loopLevel -= 1;
  const post = names.map((n) => `${t}${ident(n)} = abap.Canon(${ctx.builders.get(n)}.String())`);
  for (const n of names) ctx.builders.delete(n);
  return [...pre, ...lines, ...post];
}

/*
 * ABAP positions: every statement carries a line directive (block form) in front
 * of it, so a panic, a stack trace, a pprof profile or delve name the ABAP
 * line, not the generated one. Code that is not ABAP gets its own lines back
 * (the RESET marker, replaced once the file is assembled).
 */
// a column as scanned, in the Go value of its kind (a RAW(n) column its n
// bytes, go/abap dbraw.go), and moved into a field of type ft: a RAW column
// into an x of another length cut or 00-padded (ultra/zvdb)
function dbColumn(c, v, ft) {
  const k = c.type.k;
  const val = k === "i" ? `abap.DBI(${v})` : k === "string" ? `abap.DBStr(${v})` : k === "xstring" ? `abap.DBXStr(${v})`
    : k === "x" ? `abap.DBX(${v}, ${c.type.len ?? 1})` : k === "p" ? dbP(v, ft) : `abap.DBChar(${v})`;
  return k === "x" && ft?.k === "x" && (ft.len ?? 1) !== (c.type.len ?? 1) ? `abap.XFit(${val}, ${ft.len ?? 1})` : val;
}

// the arguments of a statement lowered at build time: the logon client, a
// host value (a c right-trimmed, as the column binds it), a literal
function sqlArgs(args, ctx) {
  return `[]any{${args.map((a) => (a.fit !== undefined ? `abap.DBCFit(${expr(a.host, ctx)}, ${a.fit})`
    : a.xstring ? `abap.DBXString(${expr(a.host, ctx)})`
    : a.xhex !== undefined ? `abap.DBXHex(${expr(a.host, ctx)}, ${a.xhex})` : a.xexact !== undefined ? `abap.DBXSHex(${expr(a.host, ctx)}, ${a.xexact})`
    : a.host ? (a.host.type.k === "c" ? `abap.DBC(${expr(a.host, ctx)})` : expr(a.host, ctx))
    : a.mandt ? "abap.Mandt" : typeof a.value === "number" ? String(a.value) : JSON.stringify(String(a.value)))).join(", ")}}`;
}

const irTypeGo = (t) => `&abap.IRType{Abap: ${JSON.stringify(t.abap)}${t.len !== undefined ? `, Len: ${t.len}` : ""}${t.dec ? `, Dec: ${t.dec}` : ""}}`;

// the ranges of a statement: where lower() put each marker, and the rows of
// the ranges table as the Go values of their fields
function hostPreds(preds, ctx) {
  if (!preds || preds.length === 0) return "nil";
  return `[]abap.HostPred{${preds.map((p) => {
    const fields = new Map((STRUCTDEFS.get(p.range.type.row.go)?.fields ?? []).map((f) => [String(f.name).toUpperCase(), f]));
    const v = (nm) => (fields.get(nm).type.k === "i" ? `int64(r.${ident(fields.get(nm).name)})` : `r.${ident(fields.get(nm).name)}`);
    const rows = `func() []abap.RangeRow { out := []abap.RangeRow{}; for _, r := range ${expr(p.range, ctx)} { out = append(out, abap.RangeRow{Sign: r.${ident(fields.get("SIGN").name)}, Option: r.${ident(fields.get("OPTION").name)}, Low: ${v("LOW")}, High: ${v("HIGH")}}) }; return out }()`;
    return `{ID: ${JSON.stringify(p.id)}, After: ${p.after}, Column: ${JSON.stringify(p.column)}, Type: ${irTypeGo(p.type)}, Kind: ${JSON.stringify(p.kind ?? "")}, LowLen: ${p.lowLen}, Rows: ${rows}}`;
  }).join(", ")}}`;
}

const RESET = "\u0000reset-position";
// GOGEN_NOLINE=1 leaves the directives out, for debugging the emitter itself
const LINES = !process.env.GOGEN_NOLINE;

function stmtList(body, ctx, d) {
  const lines = [];
  for (let i = 0; i < body.length; i++) {
    const st = body[i], next = body[i + 1];
    if (movePair(st, next, ctx, body[i - 1])) {
      // BumpTable keys on the address of the slice HEADER, not its backing
      // array. Preserve both bumps; clearing the source cannot invalidate a.
      lines.push(...stmt({...st, moveTable: true}, ctx, d), ...stmt(next, ctx, d));
      i++;
    } else lines.push(...stmt(st, ctx, d));
  }
  return lines;
}

function stmt(st, ctx, d) {
  const loop = st.s === "loop" || st.s === "loop_data";
  if (loop) (ctx.loopStack ??= []).push(st);
  let lines;
  try { lines = stmtLines(st, ctx, d); } finally { if (loop) ctx.loopStack.pop(); }
  if (LINES && st.pos && lines.length > 0) lines[0] = lines[0].replace(/^(\t*)/, `$1/*line ${st.pos.file}:${st.pos.row}*/ `);
  return lines;
}

function stmtLines(st, ctx, d) {
  const t = tab(d);
  const owned = ownedStatement(st, ctx, t, {ownership: OWNERSHIP, expr, place, rowValue, helper: helperFn});
  if (owned) return owned;
  switch (st.s) {
    case "assign":
      if (st.target.e === "substr_target") {
        HELPER_IMPORTS.add("subwrite");
        if (st.target.base.type.k !== "x") {
          const limit = st.target.base.type.k === "c" ? st.target.base.type.len : -1;
          return [`${t}${place(st.target.base, ctx)} = hSubwrite.Char(${expr(st.target.base, ctx)}, ${st.target.off ? expr(st.target.off, ctx) : "0"}, ${st.target.len ? expr(st.target.len, ctx) : "-1"}, ${expr(st.value, ctx)}, ${limit})`];
        }

        return [`${t}${place(st.target.base, ctx)} = hSubwrite.X(${expr(st.target.base, ctx)}, ${st.target.off ? expr(st.target.off, ctx) : "0"}, ${expr(st.target.len, ctx)}, ${expr(st.value, ctx)})`];
      }
      if (ctx.builders?.has(st.target.name) && isAppend(st, st.target.name)) {
        const parts = [];
        for (let e = st.value; e.e === "concat"; e = e.l) parts.unshift(e.r);
        return parts.map((x) => `${t}${ctx.builders.get(st.target.name)}.WriteString(${expr(x, ctx)})`);
      }
      return [...(st.target.type.k === "table" ? [`${t}abap.BumpTable(&${place(st.target, ctx)})`] : []), `${t}${place(st.target, ctx)} = ${st.moveTable ? expr(st.value, ctx) : copied(expr(st.value, ctx), st.value.type, st.value)}`];
    case "clear":
      return [...(st.target.type.k === "table" ? [`${t}abap.BumpTable(&${place(st.target, ctx)})`] : []), `${t}${place(st.target, ctx)} = ${zero(st.target.type)}`];
    case "append": {
      const tb = place(st.table, ctx);
      const unique = (st.table.type.secondary ?? []).filter((k) => k.unique);
      if (unique.length) {
        // a unique secondary key (ultra/json): a row that would repeat a key
        // value is refused, not added -- A4H raises the catchable
        // CX_SY_ITAB_DUPLICATE_KEY (2026-09-24, ZCL_GOGEN_T_SECKEYDUP)
        const n = ctx.loop++;
        return [`${t}{`, `${t}	v${n} := ${copied(expr(st.value, ctx), st.value.type, st.value)}`,
          ...unique.map((k) => `${t}	abap.UniqueKeyCheck(len(${tb}), func(i int) bool { return ${k.comps.map((c) => `${tb}[i].${ident(c)} == v${n}.${ident(c)}`).join(" && ")} }, ${JSON.stringify(k.name)})`),
          `${t}	${tb} = append(${tb}, ${rowStored(st.table.type, `v${n}`)})`, `${t}}`, `${t}abap.BumpTable(&${tb})`, `${t}s.Sy.Tabix = int32(len(${tb}))`,
          // ultra/events: APPEND ... ASSIGNING <fs>
          ...(st.fs ? [`${t}${ident(st.fs)} = ${boundRow(st.table.type, tb, `len(${tb})-1`)}`] : []),
          ...(st.refInto ? [`${t}${place(st.refInto, ctx)} = ${rowRef(st.table.type, tb, `${tb}[len(${tb})-1]`)}`] : [])];
      }
      return [`${t}${tb} = append(${tb}, ${rowStored(st.table.type, copied(expr(st.value, ctx), st.value.type, st.value))})`, `${t}abap.BumpTable(&${tb})`, `${t}s.Sy.Tabix = int32(len(${tb}))`,
        // ultra/events: APPEND ... ASSIGNING <fs>
        ...(st.fs ? [`${t}${ident(st.fs)} = ${boundRow(st.table.type, tb, `len(${tb})-1`)}`] : []),
        ...(st.refInto ? [`${t}${place(st.refInto, ctx)} = ${rowRef(st.table.type, tb, `${tb}[len(${tb})-1]`)}`] : [])];
    }
    // ultra/events: CONCATENATE [LINES OF] ... INTO t [SEPARATED BY s]
    case "concat": {
      const n = ctx.loop++;
      const sep = st.sep ? expr(st.sep, ctx) : `""`;
      const joined = st.table
        ? `func() string { var b []string; for _, ConcatRowStored := range ${expr(st.table, ctx)} { ConcatRow := ${rowValue(st.table.type, "ConcatRowStored")}; b = append(b, ${expr(st.row, ctx)}) }; return strings.Join(b, ${sep}) }()`
        : `strings.Join([]string{${st.parts.map((x) => expr(x, ctx)).join(", ")}}, ${sep})`;
      const limit = st.target.type.k === "c" || st.target.type.k === "n" ? st.target.type.len : st.target.type.k === "d" ? 8 : -1;
      const value = st.target.type.k === "n" ? `abap.CToN(v${n}, ${limit})` : st.target.type.k === "d" ? `abap.S2D(v${n})` : `v${n}`;
      return [`${t}{`, `${t}	v${n}, rc${n} := abap.ConcatFit(${joined}, ${limit})`,
        `${t}	${place(st.target, ctx)} = ${value}`, `${t}	s.Sy.Subrc = rc${n}`, `${t}}`];
    }
    // ultra/events: FIND ALL OCCURRENCES ... MATCH COUNT n
    case "find_all": {
      const icase = st.icase.e === "flag" ? String(st.icase.value) : `(${expr(st.icase, ctx)} == "X")`;
      return [`${t}${place(st.count, ctx)} = abap.FindAllCount(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.regex}, ${icase})`,
        `${t}s.Sy.Subrc = 4`, `${t}if ${place(st.count, ctx)} > 0 {`, `${t}	s.Sy.Subrc = 0`, `${t}}`];
    }
    case "read_index": {
      const n = `idx${ctx.loop++}`;
      const tb = expr(st.table, ctx);
      if (st.fs) {
        return [`${t}if ${n} := ${expr(st.index, ctx)}; ${n} >= 1 && int(${n}) <= len(${tb}) {`,
          `${t}\t${ident(st.fs)} = ${boundRow(st.table.type, tb, `${n}-1`)}`, `${t}\ts.Sy.Subrc = 0`, `${t}\ts.Sy.Tabix = ${n}`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
      }
      return [
        `${t}if ${n} := ${expr(st.index, ctx)}; ${n} >= 1 && int(${n}) <= len(${tb}) {`,
        `${t}\t${place(st.into, ctx)} = ${copied(rowValue(st.table.type, `${tb}[${n}-1]`), st.into.type)}`,
        `${t}\ts.Sy.Subrc = 0`,
        `${t}\ts.Sy.Tabix = ${n}`,
        `${t}} else {`,
        `${t}\ts.Sy.Subrc = 4`,
        `${t}}`,
      ];
    }
    case "translate": {
      const p = place(st.target, ctx);
      return [`${t}${p} = abap.${st.upper ? "ToUpper" : "ToLower"}(${p})`];
    }
    case "call": {
      if (st.call.e === "nop_call") return [];
      const c = st.call;
      const run = c.receiving ? `${place(c.receiving, ctx)} = ${expr(c, ctx)}` : expr(c, ctx);
      const quit = c.owner === "CL_ABAP_UNIT_ASSERT" ? c.args.find((a) => a.name === "QUIT" && a.supplied) : null;
      const marked = quit ? `abap.WithAssertQuit(${expr(quit.value, ctx)}, func() { ${run} })` : run;
      // ultra/events: a c field passed to a generic TYPE c keeps its length
      const fits = c.args.filter((a) => a.fitc).map((a) => `${t}${place(a.place, ctx)} = abap.CFit(${place(a.place, ctx)}, ${a.fitc})`);
      if (fits.length) {
        if (!c.exceptions) return [`${t}${marked}`, ...fits];
        const m = exceptionCodes(c.exceptions);
        return [`${t}func() {`, `${t}\tdefer abap.Classic(s, ${JSON.stringify(c.callee)}, ${m}, ${c.exceptions.others})`,
          `${t}\t${marked}`, `${t}\ts.Sy.Subrc = 0`, `${t}}()`, ...fits];
      }
      if (!c.exceptions) return [`${t}${marked}`];
      const m = exceptionCodes(c.exceptions);
      return [`${t}func() {`, `${t}\tdefer abap.Classic(s, ${JSON.stringify(c.callee)}, ${m}, ${c.exceptions.others})`,
        `${t}\t${marked}`, `${t}\ts.Sy.Subrc = 0`, `${t}}()`];
    }
    // ultra/events: SET HANDLER, one registration per handler (the names
    // Ev* are mixed case, so no ABAP name, all upper or all lower, meets them)
    case "get_runtime": return [`${t}${place(st.target, ctx)} = ${helperFn("runtimeclock.Microseconds")}()`];
    case "get_timestamp": return [`${t}${place(st.target, ctx)} = abap.TimeStamp(${st.dec})`];
    // AMC on the Go host (go/amc; the bodies frontend.mjs AMC_HOST gives)
    case "amc": {
      const a = (k) => expr(st.args[k], ctx);
      const err = place(st.err, ctx);
      const at = "amc.Endpoint{Session: s, Program: amc.Current().Caller(s), Client: abap.Mandt, Username: abap.UName}";
      const refuse = (e) => [`${t}if ${e} != nil {`, `${t}\t${err} = ${e}.Error()`, ...stmt(st.raise, ctx, d + 1), `${t}}`];
      const ret = ctx.method.returning ? ident(ctx.method.returning.name) : null;
      switch (st.op) {
        case "create_producer":
          return [`${t}AMCDefine()`, `${t}if ${a("COMM")} == 1 {`, `${t}\t${err} = "Communication type 1 is not supported."`, ...stmt(st.raise, ctx, d + 1), `${t}}`,
            `${t}{`, `${t}\tr := New_${typeName(st.cls)}(s)`,
            `${t}\tamc.Current().Bind(s, r, amc.Producer{App: ${a("APP")}, Path: ${a("PATH")}, Extension: ${a("EXT")}, SuppressEcho: ${a("ECHO")} == "X"})`,
            `${t}\t${ret} = r`, `${t}}`];
        case "create_consumer":
          return [`${t}AMCDefine()`, `${t}{`, `${t}\tr := New_${typeName(st.cls)}(s)`,
            `${t}\tamc.Current().Bind(s, r, amc.Consumer{App: ${a("APP")}, Path: ${a("PATH")}, Extension: ${a("EXT")}})`,
            `${t}\t${ret} = r`, `${t}}`];
        case "session_id":
          return [`${t}${ret} = amc.Current().SessionID(s)`];
        case "send":
          return [`${t}{`, `${t}\tp, _ := amc.Current().Bound(me).(amc.Producer)`,
            `${t}\tamcErr := amc.Current().Publish(p.App, p.Path, p.Extension, ${at}, p.SuppressEcho, amc.Message{Type: ${JSON.stringify(st.type)}, Payload: ${a("MESSAGE")}})`,
            ...refuse("amcErr").map((l) => `\t${l}`), `${t}}`];
        case "start":
          return [`${t}{`, `${t}\tc, _ := amc.Current().Bound(me).(amc.Consumer)`,
            `${t}\tsub, amcErr := amc.Current().Subscribe(c.App, c.Path, c.Extension, ${at}, ${a("RECEIVER")})`,
            ...refuse("amcErr").map((l) => `\t${l}`),
            `${t}\tamc.Current().Track(me, ${a("RECEIVER")}, sub)`, `${t}}`];
        case "stop":
          return [`${t}amc.Current().Untrack(me, ${a("RECEIVER")})`];
      }
      throw new Error(`amc ${st.op}`);
    }
    case "amc_wait":
      return [`${t}s.Sy.Subrc = amc.Current().Wait(s, func() bool { return ${cond(st.cond, ctx)} }, amc.Seconds(${expr(st.seconds, ctx)}), AMCDeliver(s))`];
    // X0 (go/abap/dataset.go)
    case "dataset_open": {
      const fields = [`Mode: ${JSON.stringify(st.mode)}`, `Binary: ${st.binary}`];
      if (st.message) fields.push(`Message: abap.Ptr(${expr(st.message, ctx)})`);
      if (st.position) fields.push(`Position: abap.Ptr(${expr(st.position, ctx)})`);
      return [`${t}abap.OpenDataset(s, ${expr(st.name, ctx)}, abap.DatasetOpen{${fields.join(", ")}})`];
    }
    case "dataset_close": return [`${t}abap.CloseDataset(s, ${expr(st.name, ctx)})`];
    case "dataset_delete": return [`${t}abap.DeleteDataset(s, ${expr(st.name, ctx)})`];
    case "dataset_transfer":
      return [`${t}abap.Transfer(s, ${expr(st.src, ctx)}, ${expr(st.name, ctx)}, ${st.length ? `int(${expr(st.length, ctx)})` : "-1"}, ${st.noEndOfLine})`];
    case "dataset_read":
      return [`${t}abap.ReadDataset(s, ${expr(st.name, ctx)}, ${expr(st.target, ctx)}, ${st.max ? `int(${expr(st.max, ctx)})` : "-1"}, ${st.actual ? `abap.Ptr(${expr(st.actual, ctx)})` : "nil"})`];
    case "dataset_get_position": return [`${t}abap.GetDatasetPosition(s, ${expr(st.name, ctx)}, ${expr(st.position, ctx)})`];
    case "dataset_set_position":
      return [`${t}abap.SetDatasetPosition(s, ${expr(st.name, ctx)}, ${st.position ? expr(st.position, ctx) : "0"}, ${st.position === null})`];
    case "set_handler": {
      const lines = [`${t}func() {`];
      lines.push(`${t}\tEvFor := ${st.forObj ? `any(${expr(st.forObj, ctx)})` : "any(nil)"}`, `${t}\t_ = EvFor`);
      lines.push(`${t}\tEvOn := ${st.activation ? `abap.Activation(${expr(st.activation, ctx)})` : "true"}`);
      for (const h of st.handlers) {
        const ev = EVENTS.get(h.event);
        const filter = h.filter ? `func(o any) bool { _, ok := o.(${goType({k: "ref", name: h.filter})}); return ok }` : "nil";
        const obj = h.obj ? "any(EvH)" : h.me ? `any(${self(ctx, null)})` : "nil";
        lines.push(`${t}\t{`);
        if (h.obj) lines.push(`${t}\t\tEvH := abap.BoundHandler(${expr(h.obj, ctx)})`);
        lines.push(`${t}\t\tabap.SetHandler(s, ${JSON.stringify(h.event)}, EvFor, ${st.all}, ${ev.static}, ${obj}, ${JSON.stringify(h.key)}, ${filter}, func(s *abap.Session, EvSender any, EvArgs any) {`,
          `${t}\t\t\tEvA := EvArgs.(${evType(h.event)})`, `${t}\t\t\t_, _ = EvA, EvSender`,
          `${t}\t\t\t${expr(h.call, ctx)}`, `${t}\t\t}, EvOn)`, `${t}\t}`);
      }
      lines.push(`${t}}()`);
      return lines;
    }
    case "raise_event": {
      const ev = EVENTS.get(st.event);
      const fields = st.args.map((a) => `${ident(a.name)}: ${copied(expr(a.value, ctx), a.value.type, a.value)}`).join(", ");
      return [`${t}abap.RaiseEvent(s, ${JSON.stringify(st.event)}, ${st.sender ? `any(${expr(st.sender, ctx)})` : "nil"}, ${ev.static}, func() any { return ${evType(st.event)}{${fields}} })`];
    }
    case "raise_runtime": return [`${t}panic(abap.ArithmeticError{Class: ${JSON.stringify(st.cls)}, Op: ${JSON.stringify(st.op)}})`];
    case "call_fm": {
      // CALL FUNCTION of a module the host implements (frontend NATIVE_FM):
      // every actual as generic data, the module's classic exceptions by name
      const call = `${helperFn(st.fn)}(s, map[string]abap.Data{${st.args.map((x) => `${JSON.stringify(x.name)}: ${expr(x.value, ctx)}`).join(", ")}})`;
      if (!st.exceptions) return [`${t}func() { defer abap.MessageCallScope(s, ${JSON.stringify(st.name)}, nil, -1).Restore(s); ${call} }()`];
      const m = exceptionCodes(st.exceptions);
      return [`${t}func() {`, `${t}\tdefer abap.Classic(s, ${JSON.stringify(st.name)}, ${m}, ${st.exceptions.others})`,
        `${t}\tdefer abap.MessageCallScope(s, ${JSON.stringify(st.name)}, ${m}, ${st.exceptions.others}).Restore(s)`, `${t}\t${call}`, `${t}\ts.Sy.Subrc = 0`, `${t}}()`];
    }
    case "call_enq": {
      HELPER_IMPORTS.add("enqseam");
      const fn = st.kind === "enqueue" ? "Enqueue" : st.kind === "dequeue" ? "Dequeue" : "DequeueAll";
      const fields = (st.fields ?? []).map((field) => `{Name: ${JSON.stringify(field.name)}, Kind: '${field.kind}', Length: ${field.length}}`).join(", ");
      const table = `hEnqseam.Table{Name: ${JSON.stringify(st.table)}, Key: []hEnqseam.Field{${fields}}}`;
      const map = `hEnqseam.Args{${st.args.map((x) => `${JSON.stringify(x.name)}: abap.FmtData(${expr(x.value, ctx)})`).join(", ")}}`;
      const call = st.kind === "enqueue"
        ? `hEnqseam.${fn}(s, ${table}, ${JSON.stringify(st.object)}, ${map}, hHostclass.KERNEL_LOCK.Enqueue)`
        : st.kind === "dequeue"
          ? `hEnqseam.${fn}(s, ${table}, ${JSON.stringify(st.object)}, ${map}, hHostclass.KERNEL_LOCK.Dequeue)`
          : `hEnqseam.${fn}(s, hHostclass.KERNEL_LOCK.DequeueAll)`;
      if (!st.exceptions) return [`${t}func() { defer abap.MessageCallScope(s, ${JSON.stringify(st.name)}, nil, -1).Restore(s); ${call} }()`];
      const exceptionMap = exceptionCodes(st.exceptions);
      return [`${t}func() {`, `${t}\tdefer abap.Classic(s, ${JSON.stringify(st.name)}, ${exceptionMap}, ${st.exceptions.others})`,
        `${t}\tdefer abap.MessageCallScope(s, ${JSON.stringify(st.name)}, ${exceptionMap}, ${st.exceptions.others}).Restore(s)`, `${t}\t${call}`, `${t}}()`];
    }
    case "native": {
      const m = ctx.method;
      if (ctx.valueOutputs?.size && m.returning && !st.stmt)
        throw new Error(`${ctx.cls.name}=>${m.name}: native return cannot run inside a VALUE output closure`);
      // a host function with arguments of its own (frontend NATIVE / KERNEL):
      // "&" places are pointers it writes; a kernel line inside a body (stmt)
      // returns nothing
      if (st.args) {
        const call = `${helperFn(st.fn)}(${["s", ...st.args.map((a) => (a.ref ? `&${place(a.value, ctx)}` : expr(a.value, ctx)))].join(", ")})`;
        return [`${t}${!st.stmt && m.returning ? "return " : ""}${call}`];
      }
      return [`${t}${m.returning ? "return " : ""}${helperFn(st.fn)}(${["s", ...(st.me ? ["me"] : []), ...m.params.map((p) => ident(p.name))].join(", ")})`];
    }
    // a JavaScript for (...) { of kernel code, as a range over what the host
    // function returns; each pair is written to the binds before the body
    case "kernel_loop":
      return [`${t}for _, kv := range ${helperFn(st.fn)}(${["s", ...st.args.map((a) => (a.ref ? `&${place(a.value, ctx)}` : expr(a.value, ctx)))].join(", ")}) {`,
        ...st.binds.map((b, i) => `${t}\t${place(b, ctx)} = kv[${i}]`),
        ...stmtList(st.body, ctx, d + 1), `${t}}`];
    case "raise":
      return [`${t}panic(abap.Raise(${expr(st.value, ctx)}, ${JSON.stringify(st.cls ?? "")}))`];
    case "raise_classic":
      return [`${t}panic(abap.ClassicException{Name: ${JSON.stringify(st.name)}, Method: ${JSON.stringify(st.method)}})`];
    case "if": {
      const lines = [];
      st.branches.forEach((b, i) => {
        lines.push(`${t}${i === 0 ? "if" : "} else if"} ${cond(b.cond, ctx)} {`);
        lines.push(...stmtList(b.body, ctx, d + 1));
      });
      if (st.else !== null) {
        lines.push(`${t}} else {`);
        lines.push(...stmtList(st.else, ctx, d + 1));
      }
      lines.push(`${t}}`);
      return lines;
    }
    case "case": {
      const lines = [`${t}{`, `${t}\t${st.temp} := ${expr(st.subject, ctx)}`, `${t}\t_ = ${st.temp}`];
      if (st.branches.length === 0 && st.else !== null) {
        lines.push(...stmtList(st.else, ctx, d + 1));
      } else {
        st.branches.forEach((b, i) => {
          lines.push(`${t}\t${i === 0 ? "if" : "} else if"} ${cond(b.cond, ctx)} {`);
          lines.push(...stmtList(b.body, ctx, d + 2));
        });
        if (st.else !== null) {
          lines.push(`${t}\t} else {`);
          lines.push(...stmtList(st.else, ctx, d + 2));
        }
        if (st.branches.length > 0) lines.push(`${t}\t}`);
      }
      lines.push(`${t}}`);
      return lines;
    }
    case "do": return withBuilders(st.body, ctx, t, () => {
      // sy-index is the pass counter of the innermost DO/WHILE and comes
      // back to the enclosing loop's value after ENDDO
      const n = ctx.loop++;
      const lines = [`${t}{`, `${t}\tsave${n} := s.Sy.Index`];
      if (st.times === null) lines.push(`${t}\tfor i${n} := int32(1); ; i${n}++ {`);
      else lines.push(`${t}\tn${n} := ${expr(st.times, ctx)}`, `${t}\tfor i${n} := int32(1); i${n} <= n${n}; i${n}++ {`);
      lines.push(`${t}\t\ts.Sy.Index = i${n}`, ...stmtList(st.body, ctx, d + 2), `${t}\t}`, `${t}\ts.Sy.Index = save${n}`, `${t}}`);
      return lines;
    });
    case "while": return withBuilders(st.body, ctx, t, () => {
      const n = ctx.loop++;
      return [
        `${t}{`, `${t}\tsave${n} := s.Sy.Index`,
        `${t}\tfor i${n} := int32(1); ${cond(st.cond, ctx)}; i${n}++ {`,
        `${t}\t\ts.Sy.Index = i${n}`,
        ...stmtList(st.body, ctx, d + 2),
        `${t}\t}`, `${t}\ts.Sy.Index = save${n}`, `${t}}`,
      ];
    }, [st.cond]);
    case "loop": return withBuilders(st.body, ctx, t, () => {
      if (st.dynamicKeys) {
        const branches = [{name: "PRIMARY_KEY", key: null}, ...st.dynamicKeys.options.map((key) => ({name: key.name, key}))];
        return [`${t}switch strings.ToUpper(${expr(st.dynamicKeys.value, ctx)}) {`, ...branches.flatMap((b) => [
          `${t}case ${JSON.stringify(b.name)}:`, ...stmt({...st, dynamicKeys: null, key: b.key, token: {}}, ctx, d + 1),
        ]), `${t}default:`, `${t}\tpanic(abap.NotCompiled("LOOP USING KEY", "dynamic key is not a declared sorted key"))`, `${t}}`];
      }
      if (st.key) return keyLoop(st, ctx, t, d);
      // index-based on purpose: a row APPENDed inside the loop is visited,
      // as in ABAP; a range over the slice would not see it
      const n = ctx.loop++;
      st.token.idxVar = `i${n}`; // ultra/itab: DELETE itab of the current row
      const tb = expr(st.table, ctx);
      const start = st.from ? `int(${expr(st.from, ctx)}) - 1` : "0";
      const limit = st.to ? ` && i${n} < int(${expr(st.to, ctx)})` : "";
      const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, `i${n}`)}` : `${place(st.into, ctx)} = ${copied(rowValue(st.table.type, `${tb}[i${n}]`), st.into.type)}`;
      const skip = st.where ? `${t}\t\tif !(${st.where.map((w) => whereItem(w, `${tb}[i${n}]`, ctx)).join(" && ")}) { continue }` : null;
      return [
        `${t}{`, `${t}\tsave${n} := s.Sy.Tabix`, `${t}\ts.Sy.Subrc = 4`,
        `${t}\tfor i${n} := max(${start}, 0); i${n} < len(${tb})${limit}; i${n}++ {`,
        ...(skip ? [skip] : []),
        `${t}\t\ts.Sy.Tabix = int32(i${n} + 1)`, `${t}\t\ts.Sy.Subrc = 0`,
        `${t}\t\t${bind}`,
        ...stmtList(st.body, ctx, d + 2),
        `${t}\t}`, `${t}\ts.Sy.Tabix = save${n}`, `${t}}`,
      ];
    }, [st.where, st.from, st.to]);
    case "modify_index": {
      // sy-subrc 0 or 4; sy-tabix is left as it was (A4H 2026-09-24,
      // ZCL_GOGEN_T_MODFROM: "b:0/2" after MODIFY ... INDEX 3)
      const n = `idx${ctx.loop++}`;
      const tb = place(st.table, ctx);
      return [`${t}if ${n} := ${expr(st.index, ctx)}; ${n} >= 1 && int(${n}) <= len(${tb}) {`,
        `${t}\t${rowValue(st.table.type, `${tb}[${n}-1]`)} = ${copied(expr(st.value, ctx), st.value.type, st.value)}`, `${t}\ts.Sy.Subrc = 0`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    }
    case "split": return [`${t}${place(st.table, ctx)} = abap.Split(${expr(st.x, ctx)}, ${expr(st.sep, ctx)})`];
    case "split_into": return [`${t}{`, `${t}\tspl := abap.SplitInto(${expr(st.x, ctx)}, ${expr(st.sep, ctx)}, ${st.targets.length})`,
      `${t}\ts.Sy.Subrc = abap.SplitSubrc(spl, []int{${st.lens.join(", ")}})`,
      ...st.targets.map((x) => `${t}\t${place(x.target, ctx)} = ${expr(x.value, ctx)}`), `${t}}`];
    case "replace": {
      const p = place(st.target, ctx);
      return [`${t}${p}, s.Sy.Subrc = abap.ReplaceStmt(${p}, ${expr(st.pattern, ctx)}, ${expr(st.with, ctx)}, ${st.regex}, ${st.all}, ${st.icase}, ${st.off ? expr(st.off, ctx) : "0"}, ${st.len ? expr(st.len, ctx) : "abap.NoLength"}, ${st.cLen})`];
    }
    case "stub": return [`${t}panic(abap.NotCompiled(${JSON.stringify(st.where)}, ${JSON.stringify(st.reason)}))`];
    case "seq": return stmtList(st.body, ctx, d);
    case "try": {
      // a panic of the runtime is an ABAP exception; a CATCH takes the
      // classes the front end found it covers, anything else goes on. The
      // TRY is a closure, so RETURN, EXIT and CONTINUE inside it come out as
      // a code (1, 2, 3) and are done again after it
      const n = ctx.loop++;
      const frame = {level: ctx.loopLevel ?? 0, mode: "body", used: new Set()};
      (ctx.tries ??= []).push(frame);
      const priorTryBuilderBlocked = ctx.tryBuilderBlocked;
      ctx.tryBuilderBlocked = priorTryBuilderBlocked || st.catches.length > 0 || !!st.cleanup;
      const body = stmtList(st.body, ctx, d + 1);
      ctx.tryBuilderBlocked = priorTryBuilderBlocked;
      frame.mode = "catch";
      const cases = st.catches.map((c) => [`${t}\t\t\tcase ${catchCond(c)}:`,
        ...catchInto(c, t, ctx),
        ...stmtList(c.body, ctx, d + 4)]).flat();
      // a CLEANUP runs only when a TRY further out takes the exception (A4H:
      // the handler is looked for before unwinding; none, and the dump is at
      // the RAISE with no CLEANUP run), so each TRY with CATCHes registers
      // them in the session while its body runs
      const cleanup = st.cleanup ? [`${t}\t\t\t\tif abap.ClassBased(xR) && s.Handled(xR) {`, ...stmtList(st.cleanup, ctx, d + 5), `${t}\t\t\t\t}`] : [];
      ctx.tries.pop();
      const guard = st.catches.length ? `${t}\t\t\t\tif !abap.Catchable(xR) { return false }\n${t}\t\t\t\txE, xOK := abap.AsError(xR)\n${t}\t\t\t\txRX, xROK := abap.AsRaised(xR)\n${t}\t\t\t\t_, _, _, _ = xE, xOK, xRX, xROK\n${t}\t\t\t\treturn ${st.catches.map(catchCond).join(" || ")}` : null;
      const push = guard ? [`${t}\txH := len(s.Handlers)`, `${t}\ts.Handlers = append(s.Handlers, func(xR any) bool {`, guard, `${t}\t})`] : [];
      const pop = guard ? [`${t}\t\ts.Handlers = s.Handlers[:xH]`] : [];
      const out = [`${t}ctl${n} := func() (ctl int) {`, ...push, `${t}\tdefer func() {`, ...pop, `${t}\t\tif xR := recover(); xR != nil {`, `${t}\t\t\txE, xOK := abap.AsError(xR)`,
        `${t}\t\t\txRX, xROK := abap.AsRaised(xR)`, `${t}\t\t\t_, _, _, _ = xE, xOK, xRX, xROK`,
        `${t}\t\t\tif !abap.Catchable(xR) { abap.Repanic(xR, debug.Stack()) }`,
        `${t}\t\t\tswitch {`, ...cases, `${t}\t\t\tdefault:`, ...cleanup, `${t}\t\t\t\tabap.Repanic(xR, debug.Stack())`, `${t}\t\t\t}`, `${t}\t\t}`, `${t}\t}()`,
        ...body, `${t}\treturn 0`, `${t}}()`, `${t}_ = ctl${n}`];
      for (const code of [1, 2, 3]) if (frame.used.has(code)) out.push(`${t}if ctl${n} == ${code} {`, `${t}\t${leave(ctx, code)}`, `${t}}`);
      return out;
    }
    case "delete_adjacent": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const same = st.fields.map((f) => `p${n}.${ident(f)} == r${n}.${ident(f)}`).join(" && ");
      return [`${t}if len(${tb}) > 1 {`, `${t}\tkeep${n} := ${tb}[:1]`, `${t}\tfor _, r${n} := range ${tb}[1:] {`,
        `${t}\t\tp${n} := keep${n}[len(keep${n})-1]`, `${t}\t\tif !(${same}) { keep${n} = append(keep${n}, r${n}) }`,
        `${t}\t}`, `${t}\tif len(keep${n}) != len(${tb}) { abap.BumpTable(&${tb}) }`, `${t}\t${tb} = keep${n}`, `${t}}`];
    }
    case "sort": {
      // SORT is not stable in ABAP; stable here, so equal keys keep their order
      // (ultra/itab: a key may be the line itself; p compares as a number)
      const tb = place(st.table, ctx);
      const cmp = st.keys.map((k) => {
        const [xv, yv] = k.line ? ["x", "y"] : [`x.${ident(k.name)}`, `y.${ident(k.name)}`];
        if (k.type.k === "p") return `if c := abap.CmpP(${xv}, ${yv}); c != 0 { return c ${k.desc ? ">" : "<"} 0 }`;
        return `if ${xv} != ${yv} { return ${xv} ${k.desc ? ">" : "<"} ${yv} }`;
      });
      return [`${t}sort.SliceStable(${tb}, func(a, b int) bool { x, y := ${tb}[a], ${tb}[b]; ${cmp.join("; ")}; return false })`, `${t}abap.BumpTable(&${tb})`];
    }
    // ultra/itab: APPEND LINES OF (frontend.mjs); lrow is the source row
    case "append_lines": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const out = [`${t}{`, `${t}	src${n} := ${expr(st.src, ctx)}`, `${t}	lo${n}, hi${n} := 1, len(src${n})`];
      const bound = (v, name, set) => [`${t}	if b := int(${expr(v, ctx)}); b <= 0 {`,
        `${t}		panic(abap.ArithmeticError{Class: "TABLE_INVALID_INDEX", Op: "APPEND LINES OF ... ${name} " + abap.FmtI(int32(b))})`, `${t}	} else ${set}`];
      if (st.from) out.push(...bound(st.from, "FROM", `{
${t}		lo${n} = b
${t}	}`));
      if (st.to) out.push(...bound(st.to, "TO", `if b < hi${n} {
${t}		hi${n} = b
${t}	}`));
      const saved = ctx.lrow;
      ctx.lrow = `r${n}`;
      const v = st.value.e === "lrow" ? copied(rowValue(st.src.type, `r${n}`), st.value.type) : expr(st.value, ctx);
      ctx.lrow = saved;
      // the rows as they are: one append of the section, one growth (abapiti
      // Registry run, Z_RUNTIME_ARRA splice: per-row growth was most of it)
      if (rowStored(st.table.type, v) === `r${n}`) out.push(`${t}	if lo${n} <= hi${n} {`, `${t}		${tb} = append(${tb}, src${n}[lo${n}-1:hi${n}]...)`, `${t}	}`,
        `${t}	if lo${n} <= hi${n} { abap.BumpTable(&${tb}) }`, `${t}	s.Sy.Tabix = int32(len(${tb}))`, `${t}}`);
      else out.push(`${t}	for i${n} := lo${n}; i${n} <= hi${n}; i${n}++ {`, `${t}		r${n} := src${n}[i${n}-1]`, `${t}		${tb} = append(${tb}, ${rowStored(st.table.type, v)})`, `${t}	}`,
        `${t}	if lo${n} <= hi${n} { abap.BumpTable(&${tb}) }`, `${t}	s.Sy.Tabix = int32(len(${tb}))`, `${t}}`);
      return out;
    }
    // ultra/events: INSERT INTO TABLE of a SORTED table with a unique key
    case "insert_sorted": {
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const get = (r, k) => (k.line ? r : `${r}.${ident(k.name)}`);
      const cmp = st.keys.map((k) => `if a, b := ${get(`r${n}`, k)}, ${get(`v${n}`, k)}; a != b { if a > b { c${n} = 1 } else { c${n} = -1 }; goto done${n} }`);
      return [`${t}{`, `${t}	v${n} := ${st.value.e === "lrow" && needsCopy(st.value.type) ? `${cloneName(st.value.type)}(${rowValue(st.table.type, expr(st.value, ctx))})` : copied(st.value.e === "lrow" ? rowValue(st.table.type, expr(st.value, ctx)) : expr(st.value, ctx), st.value.type, st.value)}`, `${t}	pos${n} := len(${tb})`, `${t}	s.Sy.Subrc = 0`,
        `${t}	for i${n}, r${n} := range ${tb} {`, `${t}		c${n} := 0`, ...cmp.map((x) => `${t}		${x}`), `${t}	done${n}:`,
        ...(st.unique === false ? [] : [`${t}		if c${n} == 0 {`, `${t}			s.Sy.Subrc = 4`, `${t}			break`, `${t}		}`]),
        `${t}		if c${n} > 0 {`, `${t}			pos${n} = i${n}`, `${t}			break`, `${t}		}`, `${t}	}`,
        `${t}	if s.Sy.Subrc == 0 {`, `${t}		${tb} = append(${tb}, ${rowStored(st.table.type, `v${n}`)})`, `${t}		copy(${tb}[pos${n}+1:], ${tb}[pos${n}:])`, `${t}		${tb}[pos${n}] = ${rowStored(st.table.type, `v${n}`)}`, `${t}		abap.BumpTable(&${tb})`,
        ...(st.refInto ? [`${t}		${place(st.refInto, ctx)} = ${rowRef(st.table.type, tb, `${tb}[pos${n}]`)}`] : []), `${t}	}`, `${t}}`];
    }
    case "insert_lines_sorted": {
      const n = ctx.loop++;
      const saved = ctx.lrow;
      ctx.lrow = `line${n}`;
      const insertion = stmt({s: "insert_sorted", table: st.table, value: {e: "lrow", type: st.table.type.row}, keys: st.keys}, ctx, d + 1);
      ctx.lrow = saved;
      return [`${t}for _, line${n} := range ${expr(st.src, ctx)} {`, ...insertion, `${t}}`];
    }
    case "insert_table": {
      const tb = place(st.table, ctx);
      const v = `ins${ctx.loop++}`;
      if (!st.unique) return [`${t}${tb} = append(${tb}, ${rowStored(st.table.type, copied(expr(st.value, ctx), st.value.type, st.value))})`, `${t}abap.BumpTable(&${tb})`, `${t}s.Sy.Subrc = 0`];
      return [`${t}{`, `${t}\t${v} := ${copied(expr(st.value, ctx), st.value.type, st.value)}`, `${t}\ts.Sy.Subrc = 4`,
        ...(st.keys
          ? [`${t}\tdup${v} := false`, `${t}\tfor _, r := range ${tb} {`, `${t}\t\tif ${st.keys.map((k) => `r.${ident(k)} == ${v}.${ident(k)}`).join(" && ")} {`, `${t}\t\t\tdup${v} = true`, `${t}\t\t\tbreak`, `${t}\t\t}`, `${t}\t}`, `${t}\tif !dup${v} {`]
          : [`${t}\tif !abap.Contains(${tb}, ${v}) {`]),
        `${t}\t\t${tb} = append(${tb}, ${rowStored(st.table.type, v)})`, `${t}\t\tabap.BumpTable(&${tb})`, `${t}\t\ts.Sy.Subrc = 0`, `${t}\t}`, `${t}}`];
    }
    case "assert":
      return [`${t}if !(${cond(st.cond, ctx)}) {`, `${t}\tpanic(abap.ArithmeticError{Class: "ASSERTION_FAILED", Op: ${JSON.stringify(st.text)}})`, `${t}}`];
    case "assign_comp":
      return [`${t}if c, ok := abap.Component(${expr(st.from, ctx)}, ${expr(st.name, ctx)}); ok {`, `${t}\t${ident(st.fs.name)} = c`, `${t}\ts.Sy.Subrc = 0`,
        `${t}} else {`, ...(st.name.type.k === "i" ? [`${t}\t${ident(st.fs.name)} = abap.Data{}`] : []), `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    case "assign_deref":
      return [`${t}if r := ${expr(st.ref, ctx)}; r.P != nil {`, `${t}\t${ident(st.fs.name)} = r`, `${t}\ts.Sy.Subrc = 0`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    case "assign_deref_typed":
      return [`${t}if r := ${expr(st.ref, ctx)}; r.P != nil {`, `${t}\t${ident(st.fs.name)} = ${st.fs.type.k === "struct" ? `abap.DerefAs[${goType(st.fs.type)}](r, ${JSON.stringify(st.text)})` : `abap.DirectBinding(abap.DerefAs[${goType(st.fs.type)}](r, ${JSON.stringify(st.text)}))`}`,
        `${t}\ts.Sy.Subrc = 0`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    case "assign_data":
      return [`${t}${ident(st.fs.name)} = ${expr(st.value, ctx)}`];
    // a move into generic data writes into the slot it is bound to
    case "set_data":
      return [`${t}abap.MoveData(${expr(st.target, ctx)}, ${expr(st.value, ctx)})`];
    // ultra/events: APPEND INITIAL LINE TO <generic table> ASSIGNING <generic>
    case "append_initial_data": {
      const n = ctx.loop++;
      return [`${t}{`, `${t}\tr${n}, i${n} := abap.AppendInitialData(${expr(st.table, ctx)})`, `${t}\t${ident(st.fs)} = r${n}`, `${t}\ts.Sy.Tabix = int32(i${n})`, `${t}}`];
    }
    case "append_data":
      return [`${t}s.Sy.Tabix = int32(abap.AppendData(${expr(st.table, ctx)}, ${expr(st.value, ctx)}))`];
    // ultra/json: INSERT INTO TABLE of a generic table, CREATE DATA LIKE LINE OF one
    case "insert_data":
      return [`${t}abap.InsertData(${expr(st.table, ctx)}, ${expr(st.value, ctx)})`, `${t}s.Sy.Subrc = 0`];
    case "create_data_line":
      return [`${t}${place(st.target, ctx)} = abap.NewLine(${expr(st.table, ctx)})`];
    case "clear_data":
      return [`${t}abap.ClearData(${expr(st.target, ctx)})`];
    case "get_ref":
      return [`${t}${place(st.target, ctx)} = ${expr(st.value, ctx)}`];
    // CREATE DATA ... TYPE <static type> (ultra/sadl): a new initial value
    case "create_data":
      return [`${t}${place(st.target, ctx)} = abap.Data{P: new(${goType(st.type)}), T: ${desc(st.type)}}`];
    // CREATE DATA ... TYPE [STANDARD TABLE OF] (name): the table registry
    case "create_data_dyn":
      return [`${t}${place(st.target, ctx)} = abap.CreateDataByName(${expr(st.name, ctx)}, ${st.table})`];
    case "describe_kind":
      return [`${t}${place(st.target, ctx)} = string(${expr(st.x, ctx)}.T.Kind)`];
    case "move_corr_data":
      return [`${t}abap.MoveCorrespondingData(${expr(st.to, ctx)}, ${expr(st.from, ctx)})`];
    case "shift_places": {
      const p = place(st.target, ctx);
      const limit = st.target.type.k === "c" ? st.target.type.len : -1;
      return [`${t}${p} = abap.ShiftPlaces(${p}, ${st.left}, ${st.circular}, ${expr(st.amount, ctx)}, ${limit})`];
    }
    case "shift_right_trailing": {
      const p = place(st.target, ctx);
      const mask = st.maskLen !== undefined ? `abap.PadC(${expr(st.mask, ctx)}, ${st.maskLen})` : expr(st.mask, ctx);
      return [`${t}${p} = abap.ShiftRightTrailing(${p}, ${mask})`];
    }
    case "shift_left_leading": {
      HELPER_IMPORTS.add("shiftleft");
      const p = place(st.target, ctx);
      const mask = st.maskLen !== undefined ? `abap.PadC(${expr(st.mask, ctx)}, ${st.maskLen})` : expr(st.mask, ctx);
      return [`${t}${p} = hShiftleft.Leading(${p}, ${mask})`];
    }
    // CONCATENATE ... IN BYTE MODE into an xstring (ultra/packs): the bytes
    // joined, the operands read before the target is written
    case "shift_left_circ_bytes": {
      const p = place(st.target, ctx);
      return [`${t}if len(${p}) > 0 {`, `${t}\t${p} = ${p}[1:] + ${p}[:1]`, `${t}}`];
    }
    case "concat_bytes": return emitByteConcat(st, ctx, t, {expr, place, rowValue});
    case "condense": {
      const p = place(st.target, ctx);
      return [`${t}${p} = abap.Condense(${p}, ${st.noGaps})`];
    }
    // DELETE / READ TABLE ... INDEX on a generic table (ultra/sadl, the SADL DPC's paging)
    case "delete_index_data": {
      const n = `idx${ctx.loop++}`;
      return [`${t}if ${n} := ${expr(st.index, ctx)}; abap.DeleteIndex(${expr(st.table, ctx)}, ${n}) {`,
        ...(st.tokens ?? []).map((token) => `${t}\tif int(${n}) <= ${token.idxVar}+1 { ${token.idxVar}-- }`),
        `${t}\ts.Sy.Subrc = 0`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    }
    case "read_index_data": {
      const n = `idx${ctx.loop++}`;
      return [`${t}if ${n}, tb${n} := ${expr(st.index, ctx)}, ${expr(st.table, ctx)}; ${n} >= 1 && int(${n}) <= abap.Lines(tb${n}) {`,
        `${t}\t${ident(st.fs)} = abap.Row(tb${n}, int(${n}-1))`, `${t}\ts.Sy.Subrc = 0`, `${t}\ts.Sy.Tabix = ${n}`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    }
    case "loop_data": return withBuilders(st.body, ctx, t, () => {
      const n = ctx.loop++;
      const tb = `tab${n}`;
      st.token.idxVar = `i${n}`;
      return [`${t}{`, `${t}\t${tb} := ${expr(st.table, ctx)}`, `${t}\tsave${n} := s.Sy.Tabix`, `${t}\ts.Sy.Subrc = 4`,
        `${t}\tfor i${n} := 0; i${n} < abap.Lines(${tb}); i${n}++ {`,
        `${t}\t\ts.Sy.Tabix = int32(i${n} + 1)`, `${t}\t\ts.Sy.Subrc = 0`,
        // a typed field symbol (ultra/json): the row must be that structure
        st.fsType ? `${t}\t\t${ident(st.fs)} = abap.DerefAs[${goType(st.fsType)}](abap.Row(${tb}, i${n}), ${JSON.stringify(st.text)})` : `${t}\t\t${ident(st.fs)} = abap.Row(${tb}, i${n})`,
        ...stmtList(st.body, ctx, d + 2), `${t}\t}`, `${t}\ts.Sy.Tabix = save${n}`, `${t}}`];
    });
    case "call_dyn_static":
      return [`${t}abap.CallStatic(s, ${expr(st.cls, ctx)}, ${JSON.stringify(st.method)}, map[string]abap.Data{${st.args.map((a) => `${JSON.stringify(a.name)}: ${expr(a.value, ctx)}`).join(", ")}})`];
    case "select_table": {
      // INTO TABLE replaces the table; each row is scanned column by column
      // and moved into the target's fields (by name with CORRESPONDING)
      const n = ctx.loop++;
      const tgt = st.target === null ? null : place(st.target, ctx);
      const rowGo = goType(st.target.type.row);
      const vars = st.cols.map((c, i) => `c${i}_${n} ${c.type.k === "i" ? "abap.DBInt" : "abap.DBString"}`);
      const moves = st.assign.map((a, i) => (a === null ? null
        : `${a.line ? "r" : `r.${ident(a.field)}`} = ${dbColumn(st.cols[i], `c${i}_${n}`, a.type)}`)).filter(Boolean);
      const keyedRow = () => {
        const ty = st.target.type;
        const saved = ctx.lrow;
        ctx.lrow = "r";
        const value = {e: "lrow", type: ty.row};
        const lines = ty.sorted
          ? stmt({s: "insert_sorted", table: st.target, value,
            keys: ty.sorted.map((name) => ({name})), unique: ty.unique}, ctx, d + 1)
          : ty.hashed ? stmt({s: "insert_table", table: st.target, value,
            unique: true, keys: ty.hashed}, ctx, d + 1)
          : [`${t}\t${tgt} = append(${tgt}, ${rowStored(ty, "r")})`];
        ctx.lrow = saved;
        return [...lines, ...((ty.sorted && ty.unique) || ty.hashed
          ? [`${t}\tif s.Sy.Subrc == 4 { panic(abap.ArithmeticError{Class: "ITAB_DUPLICATE_KEY", Op: "SELECT INTO TABLE"}) }`]
          : [])];
      };
      if (st.fae) {
        // FOR ALL ENTRIES (frontend selectStatement): once per driving row,
        // a row kept only the first time its columns are seen; an empty
        // driving table runs the statement without its WHERE
        const fr = `fae${st.fae.n}`;
        return [`${t}abap.BumpTable(&${tgt}); ${tgt} = nil`, `${t}{`,
          `${t}\ttype faekey${n} struct {`, ...st.cols.map((c, i) => `${t}\t\tc${i} ${c.type.k === "i" ? "abap.DBInt" : "abap.DBString"}`), `${t}\t}`,
          `${t}\tseen${n} := map[faekey${n}]bool{}`,
          `${t}\trow${n} := func(scan func(dest ...any) error) {`,
          `${t}\t\tvar k faekey${n}`,
          `${t}\t\tabap.Must(scan(${st.cols.map((_, i) => `&k.c${i}`).join(", ")}))`,
          `${t}\t\tif seen${n}[k] {`, `${t}\t\t\treturn`, `${t}\t\t}`, `${t}\t\tseen${n}[k] = true`,
          ...st.cols.map((_, i) => `${t}\t\tc${i}_${n} := k.c${i}\n${t}\t\t_ = c${i}_${n}`),
          `${t}\t\tvar r ${rowGo}`, ...moves.map((m) => `${t}\t\t${m}`), ...keyedRow(), `${t}\t}`,
          `${t}\tif drv${n} := ${expr(st.fae.table, ctx)}; len(drv${n}) == 0 {`,
          `${t}\t\tabap.Select(s, ${JSON.stringify(st.fae.sql)}, ${sqlArgs(st.fae.args, ctx)}, ${hostPreds(st.fae.preds, ctx)}, row${n})`,
          `${t}\t} else {`,
          `${t}\t\tfor _, ${fr} := range drv${n} {`, `${t}\t\t\t_ = ${fr}`,
          `${t}\t\t\tabap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, row${n})`,
          `${t}\t\t}`, `${t}\t}`,
          `${t}\tif len(seen${n}) > 0 {`, `${t}\t\ts.Sy.Subrc, s.Sy.Dbcnt = 0, int32(len(seen${n}))`, `${t}\t} else {`, `${t}\t\ts.Sy.Subrc, s.Sy.Dbcnt = 4, 0`, `${t}\t}`,
          `${t}}`];
      }
      return [`${t}abap.BumpTable(&${tgt})`, ...(st.appending ? [] : [`${t}${tgt} = nil`]),
        `${t}if n${n} := abap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, func(scan func(dest ...any) error) {`,
        `${t}\tvar ${vars.join("\n" + t + "\tvar ")}`,
        `${t}\tabap.Must(scan(${st.cols.map((_, i) => `&c${i}_${n}`).join(", ")}))`,
        `${t}\tvar r ${rowGo}`, ...moves.map((m) => `${t}\t${m}`), ...keyedRow(),
        `${t}}); n${n} > 0 {`, `${t}\ts.Sy.Subrc, s.Sy.Dbcnt = 0, int32(n${n})`, `${t}} else {`, `${t}\ts.Sy.Subrc, s.Sy.Dbcnt = 4, 0`, `${t}}`];
    }
    case "select_aggregate": {
      const n = ctx.loop++;
      const col = st.cols[0];
      const v = `agg${n}`;
      return [`${t}{`, `${t}\tvar ${v} ${col.type.k === "i" ? "abap.DBInt" : "abap.DBString"}`,
        `${t}\tabap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, func(scan func(dest ...any) error) { abap.Must(scan(&${v})) })`,
        `${t}\t${place(st.target, ctx)} = ${dbColumn(col, v, st.assign[0].type)}`,
        `${t}\ts.Sy.Subrc, s.Sy.Dbcnt = 0, 1`, `${t}}`];
    }
    case "unassign":
      return [`${t}${ident(st.fs.name)} = ${st.fs.type.k === "data" ? "abap.Data{}" : "nil"}`];
    case "select_dyn": {
      // dynamic Open SQL (go/abap selectdyn.go): the parts given at run time
      // as strings, the target as generic data
      const strs = (v) => (v === null ? "nil" : v.e === "strlist" ? `[]string{${v.values.map((x) => JSON.stringify(x)).join(", ")}}`
        : v.type.k === "table" ? expr(v, ctx) : `[]string{${expr(v, ctx)}}`);
      return [`${t}abap.SelectDyn(s, abap.DynSelect{Table: ${expr(st.table, ctx)}, Fields: ${strs(st.fields)}, Star: ${st.fields === null}, ` +
        `Where: ${st.where === null ? `""` : expr(st.where, ctx)}, HasWhere: ${st.where !== null}, GroupBy: ${strs(st.groupBy)}, OrderBy: ${strs(st.orderBy)}, ` +
        `PrimaryKey: ${st.primaryKey}, Corresponding: ${st.corresponding}, Stmt: ${JSON.stringify(st.text)}}, ${expr(st.target, ctx)})`];
    }
    case "select_single": {
      // one row at most; only the fields the columns go to are written, and
      // nothing when there is no row
      const n = ctx.loop++;
      // INTO (a, b, ...): each column into its own place (frontend intoWorkArea)
      const tgt = st.target === null ? null : place(st.target, ctx);
      const vars = st.cols.map((c, i) => `c${i}_${n} ${c.type.k === "i" ? "abap.DBInt" : "abap.DBString"}`);
      // a character field takes the column cut to its length
      const fit = (v, ft) => (ft.k === "c" ? `abap.CFit(${v}, ${ft.len ?? 1})` : ft.k === "d" ? `abap.CFit(${v}, 8)` : ft.k === "t" ? `abap.CFit(${v}, 6)` : v);
      const moves = st.assign.map((a, i) => (a === null ? null
        : `${a.place ? place(a.place, ctx) : a.line ? tgt : `${tgt}.${ident(a.field)}`} = ${fit(dbColumn(st.cols[i], `c${i}_${n}`, a.type), a.type)}`)).filter(Boolean);
      return [`${t}if abap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, func(scan func(dest ...any) error) {`,
        `${t}\tvar ${vars.join("\n" + t + "\tvar ")}`,
        `${t}\tabap.Must(scan(${st.cols.map((_, i) => `&c${i}_${n}`).join(", ")}))`,
        ...moves.map((m) => `${t}\t${m}`),
        `${t}}) > 0 {`, `${t}\ts.Sy.Subrc, s.Sy.Dbcnt = 0, 1`, `${t}} else {`, `${t}\ts.Sy.Subrc, s.Sy.Dbcnt = 4, 0`, `${t}}`];
    }
    case "select_loop": return withBuilders(st.body, ctx, t, () => {
      // SELECT ... ENDSELECT (frontend selectLoop, A4H 2026-09-24): the rows
      // are read first, then each pass starts with sy-subrc 0 and sy-dbcnt
      // the rows so far; after the loop, EXIT included, 0 and the rows read,
      // or 4 and 0 when there was no row and the work area is untouched
      const n = ctx.loop++;
      const tgt = st.target === null ? null : place(st.target, ctx);
      const fit = (v, ft) => (ft.k === "c" ? `abap.CFit(${v}, ${ft.len ?? 1})` : ft.k === "d" ? `abap.CFit(${v}, 8)` : ft.k === "t" ? `abap.CFit(${v}, 6)` : v);
      const val = (i) => dbColumn(st.cols[i], `q${n}.c${i}`, st.assign[i]?.type ?? st.cols[i].type);
      const moves = st.assign.map((a, i) => (a === null ? null : `${a.place ? place(a.place, ctx) : a.line ? tgt : `${tgt}.${ident(a.field)}`} = ${fit(val(i), a.type)}`)).filter(Boolean);
      return [`${t}{`,
        `${t}\ttype selrow${n} struct {`, ...st.cols.map((c, i) => `${t}\t\tc${i} ${c.type.k === "i" ? "abap.DBInt" : "abap.DBString"}`), `${t}\t}`,
        `${t}\tvar rows${n} []selrow${n}`,
        `${t}\tabap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, func(scan func(dest ...any) error) {`,
        `${t}\t\tvar r selrow${n}`, `${t}\t\tabap.Must(scan(${st.cols.map((_, i) => `&r.c${i}`).join(", ")}))`, `${t}\t\trows${n} = append(rows${n}, r)`, `${t}\t})`,
        `${t}\tread${n} := int32(0)`,
        `${t}\tfor _, q${n} := range rows${n} {`,
        `${t}\t\t_ = q${n}`, `${t}\t\tread${n}++`, `${t}\t\ts.Sy.Subrc, s.Sy.Dbcnt = 0, read${n}`,
        ...moves.map((m) => `${t}\t\t${m}`),
        ...stmtList(st.body, ctx, d + 2),
        `${t}\t}`,
        `${t}\tif read${n} > 0 {`, `${t}\t\ts.Sy.Subrc, s.Sy.Dbcnt = 0, read${n}`, `${t}\t} else {`, `${t}\t\ts.Sy.Subrc, s.Sy.Dbcnt = 4, 0`, `${t}\t}`,
        `${t}}`];
    });
    case "select_count": {
      // the count into the target and into sy-dbcnt (A4H), sy-subrc 4 when 0
      const n = ctx.loop++;
      return [`${t}{`, `${t}\tvar cnt${n} abap.DBInt`,
        `${t}\tabap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, func(scan func(dest ...any) error) { abap.Must(scan(&cnt${n})) })`,
        `${t}\t${place(st.target, ctx)} = abap.DBI(cnt${n})`, `${t}\ts.Sy.Dbcnt = abap.DBI(cnt${n})`,
        `${t}\tif cnt${n}.Int64 > 0 {`, `${t}\t\ts.Sy.Subrc = 0`, `${t}\t} else {`, `${t}\t\ts.Sy.Subrc = 4`, `${t}\t}`, `${t}}`];
    }
    case "select_sum": {
      const n = ctx.loop++;
      return [`${t}{`, `${t}\tvar sum${n} abap.DBInt`,
        `${t}\tabap.Select(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)}, func(scan func(dest ...any) error) { abap.Must(scan(&sum${n})) })`,
        `${t}\t${place(st.target, ctx)} = abap.DBI(sum${n})`, `${t}\ts.Sy.Subrc = 0`, `${t}\ts.Sy.Dbcnt = 1`, `${t}}`];
    }
    case "db_write_sql":
      return [`${t}abap.ExecWrite(s, ${JSON.stringify(st.sql)}, ${sqlArgs(st.args, ctx)}, ${hostPreds(st.preds, ctx)})`];
    case "db_write": {
      // the rows as the Go values of the work area's fields, MANDT the logon
      // client; the runtime binds and renders them (go/abap/dbwrite.go)
      const n = ctx.loop++;
      const spec = `abap.WriteSpec{Table: ${JSON.stringify(st.table)}, Cols: []abap.WriteCol{${st.cols.map((c) => `{Name: ${JSON.stringify(c.name)}, Type: ${irTypeGo(c.ir)}}`).join(", ")}}, Key: ${goStrings(st.key)}}`;
      const fields = STRUCTDEFS.get((st.fromTable ? st.value.type.row : st.value.type).go)?.fields ?? [];
      const value = (c, i) => {
        if (c.client) return "abap.Mandt";
        const f = `r${n}.${ident(fields[i].name)}`;
        return c.kind === "c" ? `abap.DBC(${f})` : c.kind === "i" ? `int64(${f})` : f;
      };
      const row = `[]any{${st.cols.map(value).join(", ")}}`;
      const rows = st.fromTable
        ? `func() [][]any { rows := [][]any{}; for _, r${n} := range ${expr(st.value, ctx)} { rows = append(rows, ${row}) }; return rows }()`
        : `func() [][]any { r${n} := ${expr(st.value, ctx)}; return [][]any{${row}} }()`;
      const call = {insert: "InsertRows", update: "UpdateRows", delete: "DeleteRows", modify: "ModifyRows"}[st.op];
      return [`${t}abap.${call}(s, ${spec}, ${rows}${st.op === "insert" ? `, ${JSON.stringify(st.onDuplicate)}` : ""})`];
    }
    case "create_dyn":
      return [`${t}${place(st.target, ctx)} = abap.CreateAs[${goType(st.target.type)}](s, ${expr(st.name, ctx)})`];
    case "read_seckey": return readSecKey(st, ctx, t);
    case "read_key": {
      const tb = expr(st.table, ctx);
      const n = ctx.loop++;
      const cond = st.keys.map((k) => (k.line ? `${rowValue(st.table.type, `r${n}`)} == ${expr(k.value, ctx)}` : `r${n}.${ident(k.name)} == ${expr(k.value, ctx)}`)).join(" && ");
      if (st.into?.conv) throw new Error("READ TABLE INTO a work area of another type");
      const bind = st.fs ? `${ident(st.fs)} = ${boundRow(st.table.type, tb, `i${n}`)}` : st.refInto ? `${place(st.into, ctx)} = ${rowRef(st.table.type, tb, `${tb}[i${n}]`)}` : st.into ? `${place(st.into, ctx)} = ${copied(rowValue(st.table.type, `r${n}`), st.into.type)}` : null;
      // ultra/events (fix round): a SORTED table, see read_key in frontend.mjs
      if (st.sorted) {
        const kv = (j) => `k${n}_${j}`;
        const get = (k) => (k.line ? `r${n}` : `r${n}.${ident(k.name)}`);
        const all = st.keys.map((k, j) => `${get(k)} == ${kv(j)}`).join(" && ");
        const decl = st.keys.flatMap((k, j) => [`${t}\t${kv(j)} := ${expr(k.value, ctx)}`, `${t}\t_ = ${kv(j)}`]);
        const found = [...(bind ? [`${t}\t\t\t${bind}`] : []), `${t}\t\t\ts.Sy.Subrc = 0`, `${t}\t\t\ts.Sy.Tabix = int32(i${n} + 1)`, `${t}\t\t\thit${n} = true`, `${t}\t\t\tbreak`];
        if (st.sorted.prefix.length === 0) {
          return [`${t}{`, ...decl, `${t}\thit${n} := false`, `${t}\tfor i${n}, r${n} := range ${tb} {`, `${t}\t\tif ${all} {`, ...found, `${t}\t\t}`, `${t}\t}`,
            `${t}\tif !hit${n} {`, `${t}\t\ts.Sy.Subrc = 4`, `${t}\t\ts.Sy.Tabix = 0`, `${t}\t}`, `${t}}`];
        }
        // c: the row's key part against the key given, -1 / 0 / 1; pos: the
        // first row whose key part is not less than the key given
        const cmp = st.sorted.prefix.map((j) => `if a, b := ${get(st.keys[j])}, ${kv(j)}; a != b { if a > b { c${n} = 1 } else { c${n} = -1 }; goto cmp${n} }`);
        return [`${t}{`, ...decl, `${t}\tpos${n} := -1`, `${t}\thit${n} := false`,
          `${t}\tfor i${n}, r${n} := range ${tb} {`, `${t}\t\tc${n} := 0`, ...cmp.map((x) => `${t}\t\t${x}`), `${t}\tcmp${n}:`,
          `${t}\t\tif c${n} < 0 {`, `${t}\t\t\tcontinue`, `${t}\t\t}`,
          `${t}\t\tif pos${n} < 0 {`, `${t}\t\t\tpos${n} = i${n}`, `${t}\t\t}`,
          `${t}\t\tif c${n} > 0 {`, `${t}\t\t\tbreak`, `${t}\t\t}`,
          `${t}\t\tif ${all} {`, ...found, `${t}\t\t}`, `${t}\t}`,
          `${t}\tif !hit${n} {`,
          ...(st.sorted.extra ? [`${t}\t\t${LINES && st.pos ? `/*line ${st.pos.file}:${st.pos.row}*/ ` : ""}panic(abap.NotCompiled("READ TABLE", "a miss on a SORTED table with a key part and components outside the key: not measured"))`] : []),
          `${t}\t\ts.Sy.Subrc = 4`, `${t}\t\tif pos${n} < 0 {`, `${t}\t\t\tpos${n} = len(${tb})`, `${t}\t\t\ts.Sy.Subrc = 8`, `${t}\t\t}`, `${t}\t\ts.Sy.Tabix = int32(pos${n} + 1)`, `${t}\t}`, `${t}}`];
      }
      return [`${t}{`, `${t}\ts.Sy.Subrc = 4`, `${t}\tfor i${n}, r${n} := range ${tb} {`, `${t}\t\t_, _ = i${n}, r${n}`, `${t}\t\tif ${cond} {`,
        ...(bind ? [`${t}\t\t\t${bind}`] : []), `${t}\t\t\ts.Sy.Subrc = 0`, `${t}\t\t\ts.Sy.Tabix = ${st.hashed ? "0" : `int32(i${n} + 1)`}`,
        `${t}\t\t\tbreak`, `${t}\t\t}`, `${t}\t}`, `${t}}`];
    }
    case "replace_chars": HELPER_IMPORTS.add("charsection"); return emitByteStatement(st, ctx, t, {expr, place});
    case "find_bytes":
    case "replace_bytes":
    case "find_bytes_all": return emitByteStatement(st, ctx, t, {expr, place});
    case "find": {
      // IN TABLE and IN SECTION (ultra/sadl): see abap.FindTable / abap.FindSection
      const call = st.table ? `fok, fline, foff, flen, fsub := abap.FindTable(${expr(st.table, ctx)}, ${expr(st.pattern, ctx)}, ${st.regex}, ${st.icase}, ${st.subs.length})`
        : "secOff" in st ? `fok, foff, flen, fsub := abap.FindSection(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.icase}, ${st.secOff ? expr(st.secOff, ctx) : "0"}, ${st.secLen ? expr(st.secLen, ctx) : "-1"}, ${st.subs.length})`
          : `fok, foff, flen, fsub := abap.FindStmt(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.regex}, ${st.icase}, ${st.subs.length})`;
      const lines = [`${t}{`, `${t}\t${call}`,
        `${t}\t_, _, _ = foff, flen, fsub`, ...(st.table ? [`${t}\t_ = fline`] : []), `${t}\tif fok {`, `${t}\t\ts.Sy.Subrc = 0`];
      if (st.line) lines.push(`${t}\t\t${place(st.line, ctx)} = fline`);
      if (st.off) lines.push(`${t}\t\t${place(st.off, ctx)} = foff`);
      if (st.len) lines.push(`${t}\t\t${place(st.len, ctx)} = flen`);
      for (const x of st.subs) lines.push(`${t}\t\t${place(x.target, ctx)} = ${expr(x.value, ctx)}`);
      lines.push(`${t}\t} else {`, `${t}\t\ts.Sy.Subrc = 4`, `${t}\t}`, `${t}}`);
      return lines;
    }
    // FIND ... RESULTS (parity-wave2): abap.FindResults gives each match as
    // offset, length and a pair per group, in characters; the rows are
    // built here in the target's own types. A FIRST that misses leaves the
    // structure alone, an ALL that misses clears the table (A4H)
    case "find_results": {
      const n = ctx.loop++;
      const f = st.f;
      const rowGo = goType(st.row);
      const subGo = goType(st.sub);
      const fill = (r) => [`${t}\t\t${r}.${ident(f.LINE)} = 0`, `${t}\t\t${r}.${ident(f.OFFSET)} = fm${n}[0]`, `${t}\t\t${r}.${ident(f.LENGTH)} = fm${n}[1]`,
        `${t}\t\t${r}.${ident(f.SUBMATCHES)} = nil`,
        `${t}\t\tfor g := 2; g+1 < len(fm${n}); g += 2 {`,
        `${t}\t\t\t${r}.${ident(f.SUBMATCHES)} = append(${r}.${ident(f.SUBMATCHES)}, ${subGo}{${ident(f.SOFFSET)}: fm${n}[g], ${ident(f.SLENGTH)}: fm${n}[g+1]})`,
        `${t}\t\t}`];
      const tgt = place(st.target, ctx);
      const call = st.bytes ? `abap.FindBytesAll(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)})` : `abap.FindResults(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)}, ${st.mode ? `'${st.mode}'` : "0"}, ${st.icase}, ${st.all})`;
      if (st.table) {
        return [`${t}{`, `${t}\tfms${n} := ${call}`, `${t}\t${tgt} = nil`, ...(st.count ? [`${t}\t${place(st.count, ctx)} = int32(len(fms${n}))`] : []), `${t}\ts.Sy.Subrc = 4`, `${t}\tfor _, fm${n} := range fms${n} {`,
          `${t}\t\ts.Sy.Subrc = 0`, `${t}\t\tvar fr${n} ${rowGo}`, ...fill(`fr${n}`), `${t}\t\t${tgt} = append(${tgt}, fr${n})`, `${t}\t}`, `${t}}`];
      }
      return [`${t}{`, `${t}\tfms${n} := ${call}`, `${t}\ts.Sy.Subrc = 4`, `${t}\tif len(fms${n}) > 0 {`, `${t}\t\ts.Sy.Subrc = 0`,
        `${t}\t\tfm${n} := fms${n}[0]`, `${t}\t\tfr${n} := &${tgt}`, ...fill(`fr${n}`), `${t}\t}`, `${t}}`];
    }
    case "delete_where": {
      // sy-subrc 0 when a row went, 4 when none did
      const tb = place(st.table, ctx);
      const n = ctx.loop++;
      const keep = st.where.map((w) => whereItem(w, `r${n}`, ctx)).join(" && ");
      return [`${t}{`, `${t}\tkept${n} := ${tb}[:0]`, `${t}\tfor _, r${n} := range ${tb} {`, `${t}\t\tif !(${keep}) {`,
        `${t}\t\t\tkept${n} = append(kept${n}, r${n})`, `${t}\t\t}`, `${t}\t}`,
        `${t}\ts.Sy.Subrc = 4`, `${t}\tif len(kept${n}) < len(${tb}) {`, `${t}\t\ts.Sy.Subrc = 0`, `${t}\t\tclear(${tb}[len(kept${n}):])`, `${t}\t\tabap.BumpTable(&${tb})`, `${t}\t}`, `${t}\t${tb} = kept${n}`, `${t}}`];
    }
    case "delete_key": {
      const n = ctx.loop++;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}\tkey${n} := ${expr(st.value, ctx)}`, `${t}\ts.Sy.Subrc = 4`,
        `${t}\tfor i${n}, r${n} := range ${tb} {`, `${t}\t\tif r${n}.${ident(st.key)} == key${n} {`,
        `${t}\t\t\t${tb} = append(${tb}[:i${n}], ${tb}[i${n}+1:]...)`, `${t}\t\t\tclear(${tb}[len(${tb}):len(${tb})+1])`, `${t}\t\t\tabap.BumpTable(&${tb})`,
        `${t}\t\t\ts.Sy.Subrc = 0`, `${t}\t\t\tbreak`, `${t}\t\t}`, `${t}\t}`, `${t}}`];
    }
    // DELETE TABLE ... WITH TABLE KEY k COMPONENTS: the row a unique key
    // (sorted or hashed) holds the values in; sy-tabix is left alone
    case "delete_seckey": {
      const n = ctx.loop++;
      const tb = place(st.table, ctx);
      const at = `kI${n}`;
      return [`${t}{`, ...keyValues(st, ctx, t, n), `${t}\t${at} := abap.KeyFind(len(${tb}), ${keyEq(st.key, tb, n)}, ${JSON.stringify(st.key.name)})`, `${t}\ts.Sy.Subrc = 4`,
        `${t}\tif ${at} >= 0 {`, `${t}\t\t${tb} = append(${tb}[:${at}], ${tb}[${at}+1:]...)`, `${t}\t\tclear(${tb}[len(${tb}):len(${tb})+1])`, `${t}\t\tabap.BumpTable(&${tb})`,
        `${t}\t\ts.Sy.Subrc = 0`, `${t}\t}`, `${t}}`];
    }
    case "delete_from": {
      const n = ctx.loop++;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}\twa${n} := ${expr(st.value, ctx)}`, `${t}\ts.Sy.Subrc = 4`,
        `${t}\tfor i${n}, r${n} := range ${tb} {`, `${t}\t\tif ${st.keys.map((k) => `r${n}.${ident(k)} == wa${n}.${ident(k)}`).join(" && ")} {`,
        `${t}\t\t\t${tb} = append(${tb}[:i${n}], ${tb}[i${n}+1:]...)`, `${t}\t\t\tclear(${tb}[len(${tb}):len(${tb})+1])`, `${t}\t\t\tabap.BumpTable(&${tb})`,
        `${t}\t\t\ts.Sy.Subrc = 0`, `${t}\t\t\tbreak`, `${t}\t\t}`, `${t}\t}`, `${t}}`];
    }
    // ultra/itab: DELETE itab inside LOOP AT itab: the current row goes and
    // the loop index steps back, so the next pass reads the row after it
    case "delete_current": {
      const tb = place(st.table, ctx);
      const i = st.token.idxVar;
      return [`${t}${tb} = append(${tb}[:${i}], ${tb}[${i}+1:]...)`, `${t}clear(${tb}[len(${tb}):len(${tb})+1])`, `${t}abap.BumpTable(&${tb})`, `${t}${i}--`, `${t}s.Sy.Subrc = 0`];
    }
    case "delete_index": {
      const n = `idx${ctx.loop++}`;
      const tb = place(st.table, ctx);
      return [`${t}if ${n} := ${expr(st.index, ctx)}; ${n} >= 1 && int(${n}) <= len(${tb}) {`,
        `${t}\t${tb} = append(${tb}[:${n}-1], ${tb}[${n}:]...)`, `${t}\tclear(${tb}[len(${tb}):len(${tb})+1])`, `${t}\tabap.BumpTable(&${tb})`,
        ...(st.tokens ?? []).map((token) => `${t}\tif int(${n}) <= ${token.idxVar}+1 { ${token.idxVar}-- }`),
        `${t}\ts.Sy.Subrc = 0`, `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    }
    case "delete_range": {
      const n = ctx.loop++;
      const tb = place(st.table, ctx);
      return [`${t}{`, `${t}\tfrom${n} := ${expr(st.from, ctx)}`, `${t}\tto${n} := ${st.to ? expr(st.to, ctx) : `int32(len(${tb}))`}`,
        `${t}\tif from${n} < 1 || to${n} < 1 { panic(abap.NotCompiled("DELETE range", "index below 1 was not measured")) }`,
        `${t}\tif to${n} > int32(len(${tb})) { to${n} = int32(len(${tb})) }`,
        `${t}\ts.Sy.Subrc = 4`, `${t}\tif from${n} <= to${n} {`,
        `${t}\t\t${tb} = append(${tb}[:from${n}-1], ${tb}[to${n}:]...)`, `${t}\t\tclear(${tb}[len(${tb}):len(${tb})+int(to${n}-from${n}+1)])`, `${t}\t\tabap.BumpTable(&${tb})`, `${t}\t\ts.Sy.Subrc = 0`, `${t}\t}`, `${t}}`];
    }
    case "insert_index": {
      const n = `idx${ctx.loop++}`;
      const tb = place(st.table, ctx);
      return [`${t}if ${n} := ${expr(st.index, ctx)}; ${n} >= 1 && int(${n}) <= len(${tb})+1 {`,
        `${t}\t${tb} = abap.InsertAt(${tb}, ${n}, ${rowStored(st.table.type, copied(expr(st.value, ctx), st.value.type, st.value))})`, `${t}\tabap.BumpTable(&${tb})`, `${t}\ts.Sy.Subrc = 0`, `${t}\ts.Sy.Tabix = ${n}`,
        `${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`];
    }
    case "nop": return [];
    case "note_update_task": return [`${t}s.UpdateTask = true`];
    case "commit_work": return [`${t}abap.GeneratedCommitWork(s)`];
    case "rollback_work": return [`${t}abap.GeneratedRollbackWork(s)`];
    case "exit": return [`${t}${leave(ctx, 2)}`];
    case "continue": return [`${t}${leave(ctx, 3)}`];
    // CHECK continues the innermost loop, or leaves the processing block
    // when it stands outside one.
    case "check": return [`${t}if !(${cond(st.cond, ctx)}) { ${leave(ctx, 3)} }`];
    // a RETURN inside a loop that appends through builders writes the
    // strings back first (parity-wave1: ZCL_STG_JSON=>READ_STRING appended a
    // 750 KB value a character at a time and returned from inside the loop,
    // which kept it off the builder and made the append quadratic)
    case "return": return [...[...(ctx.builders ?? new Map())].map(([n, sb]) => `${t}${ident(n)} = abap.Canon(${sb}.String())`), `${t}${leave(ctx, 1)}`];
    default: throw new Error(`no Go for statement ${st.s}`);
  }
}

// a DEC column read into a p field, rounded to the field's decimals
const dbP = (v, ft) => `abap.DBP(${v}, ${ft.len ?? 8}, ${ft.dec ?? 0})`;

const I_OPS = {"+": "abap.AddI", "-": "abap.SubI", "*": "abap.MulI", "/": "abap.DivI", DIV: "abap.DivIntI", MOD: "abap.ModI"};
const P_OPS = {"+": "abap.AddP", "-": "abap.SubP", "*": "abap.MulP", "/": "abap.DivP", DIV: "abap.DivIntP", MOD: "abap.ModP"};
const F_OPS = {"/": "abap.DivF", DIV: "abap.DivIntF", MOD: "abap.ModF"};
const FN_F = {SIN: "abap.Sin", COS: "abap.Cos", TAN: "math.Tan", SQRT: "abap.SqrtF", EXP: "math.Exp", LOG: "abap.LogF", LOG10: "math.Log10"};

function expr(e, ctx) {
  const owned = ownedExpression(e, ctx, {ownership: OWNERSHIP, expr, place, helper: helperFn});
  if (owned !== null) return owned;
  switch (e.e) {
    case "static": return place(e, ctx);
    case "var": case "attr": case "field": case "fs": case "row": case "row_key": case "refattr": case "dref_field": return place(e, ctx);
    case "zero": return zero(e.type) === "nil" ? `(${goType(e.type)})(nil)` : zero(e.type);
    case "case_fn": return `abap.${e.upper ? "ToUpper" : "ToLower"}(${expr(e.x, ctx)})`;
    case "table_lit": return `${goType(e.type)}{${e.rows.map((r) => rowStored(e.type, copied(expr(r, ctx), r.type, r))).join(", ")}}`;
    case "bool": return `func() string { if ${cond(e.cond, ctx)} { return "X" }; return ${JSON.stringify(e.blank)} }()`;
    case "cond": {
      const parts = e.branches.map((b) => `if ${cond(b.cond, ctx)} { return ${expr(b.value, ctx)} }`);
      return `func() ${goType(e.type)} { ${parts.join("; ")}; return ${e.else ? expr(e.else, ctx) : zero(e.type)} }()`;
    }
    case "const": return e.go;
    case "temp": return e.name;
    case "padc": return `abap.PadC(${expr(e.x, ctx)}, ${e.n})`;
    case "flag": return String(e.value);
    case "str_fn": return `abap.${e.fn}(${e.args.map((a) => expr(a, ctx)).join(", ")})`;
    case "sy": return place(e, ctx);
    case "sy_mandt": return "abap.Mandt";
    case "sy_host": return `abap.${e.name}`;
    case "int": return `int32(${e.value})`;
    case "float": return Number.isInteger(e.value) ? `float64(${e.value})` : String(e.value);
    case "chars": case "str": return JSON.stringify(e.value);
    case "template": {
      const parts = e.parts.map((p) => (p.text !== undefined ? JSON.stringify(p.text) : templatePart(p.value, ctx, p.opts ?? {})));
      return parts.length === 0 ? `""` : parts.reduce((a, b) => `abap.Concat(${a}, ${b})`);
    }
    case "concat": return `abap.Concat(${e.l.e === "conv" && ["i2s", "i82s"].includes(e.l.kind) ? `strings.TrimRight(${expr(e.l, ctx)}, " ")` : expr(e.l, ctx)}, ${e.r.e === "conv" && ["i2s", "i82s"].includes(e.r.kind) ? `strings.TrimRight(${expr(e.r, ctx)}, " ")` : expr(e.r, ctx)})`;
    // CORRESPONDING type( itab ): a new table, one mapped row per source row
    case "table_map": {
      const n = ctx.loop++;
      return `func() ${goType(e.type)} { out := ${goType(e.type)}{}; for _, MapRow${n} := range ${expr(e.from, ctx)} { ${place(e.row, ctx)} = ${rowValue(e.from.type, `MapRow${n}`)}; out = append(out, ${rowStored(e.type, expr(e.value, ctx))}) }; return out }()`;
    }
    case "struct": {
      // VALUE #( ... ): a component it does not name is initial (critic finding 1)
      const rest = zeroFields(e.type, new Set(e.fields.map((f) => String(f.name).toUpperCase())));
      return `${e.type.go}{${[...e.fields.map((f) => `${ident(f.name)}: ${copied(expr(f.value, ctx), f.value.type, f.value)}`), ...rest].join(", ")}}`;
    }
    case "neg": return e.type.k === "int8" ? `abap.SubI8(0, ${expr(e.x, ctx)})` : e.type.k === "i" ? `abap.NegI(${expr(e.x, ctx)})` : e.type.k === "p" ? `abap.NegP(${expr(e.x, ctx)})` : `(-${expr(e.x, ctx)})`;
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
    case "date_add": HELPER_IMPORTS.add("datearith"); return `hDatearith.Add(${expr(e.date, ctx)}, ${e.subtract ? "-" : ""}${expr(e.days, ctx)})`;
    case "sorted_move": {
      const names = e.keys.map((k) => ident(k));
      const less = names.map((k) => `if x.${k} != y.${k} { return x.${k} < y.${k} }`).join("; ");
      const same = names.map((k) => `v[i-1].${k} == v[i].${k}`).join(" && ");
      return `func() ${goType(e.type)} { v := ${cloneName(e.type)}(${expr(e.x, ctx)}); sort.SliceStable(v, func(a,b int) bool { x,y := v[a],v[b]; ${less}; return false }); ${e.unique ? `for i:=1; i<len(v); i++ { if ${same} { panic(abap.NotCompiled("SORTED table move", "a duplicate primary key")) } };` : ""} return v }()`;
    }
    case "fn": return fn(e, ctx);
    case "lines": return `int32(len(${expr(e.table, ctx)}))`;
    case "strlen": return `abap.Strlen(${expr(e.x, ctx)})`;
    case "uccp": return `abap.Uccp(${expr(e.x, ctx)})`;
    case "exc_text": return `${expr(e.x, ctx)}.TextOf(s)`;
    case "exc_class": return `("\\\\CLASS=" + ${expr(e.x, ctx)}.Class)`;
    case "random": return `abap.RandomInt(${expr(e.min, ctx)}, ${expr(e.max, ctx)})`;
    case "find": return `abap.Find(${expr(e.val, ctx)}, ${expr(e.sub, ctx)}, ${e.off ? expr(e.off, ctx) : "0"})`;
    case "find_occ": HELPER_IMPORTS.add("charsearch"); return `hCharsearch.FindOcc(${expr(e.val, ctx)}, ${expr(e.sub, ctx)}, ${expr(e.occ, ctx)})`;
    case "reverse": HELPER_IMPORTS.add("charsearch"); return `hCharsearch.Reverse(${expr(e.x, ctx)})`;
    case "xstrlen": return `int32(len(${expr(e.x, ctx)}))`;
    case "uccpi": return `abap.Uccpi(${expr(e.x, ctx)})`;
    case "substr": {
      const off = e.off ? expr(e.off, ctx) : "0";
      const len = e.len ? expr(e.len, ctx) : "-1";
      if (e.base.k === "x" || e.base.k === "xstring") return `abap.SubX(${expr(e.x, ctx)}, ${off}, ${len})`;
      if (e.base.k === "c") return `abap.SubC(${expr(e.x, ctx)}, ${e.base.len}, ${off}, ${len})`;
      return `abap.SubS(${expr(e.x, ctx)}, ${off}, ${len})`;
    }
    case "new": return `New_${typeName(e.cls)}(${["s", ...e.args.map((a) => importingArg(a, ctx))].join(", ")})`;
    case "call": {
      const args = ["s", ...e.args.map((a) => (a.dir === "importing" ? importingArg(a, ctx)
        : a.wrap ? `&${expr(a.wrap, ctx)}` : a.place === null ? `new(${goType(a.type)})` : `&${place(a.place, ctx)}`))];
      let call;
      if (e.receiver) call = `${expr(e.receiver, ctx)}.${typeName(e.method)}(${args.join(", ")})`;
      else if (e.owner) call = `${funcName(e.owner, e.method)}(${args.join(", ")})`;
      else if (e.static) call = `${funcName(ctx.cls.name, e.method)}(${args.join(", ")})`;
      else if (e.sup) call = `me.${typeName(e.sup)}.${typeName(e.method)}(${args.join(", ")})`;
      else call = `${self(ctx, e.method)}.${typeName(e.method)}(${args.join(", ")})`;
      const exceptionMap = exceptionCodes(e.exceptions);
      const result = e.type.k === "void" ? "" : goType(e.type);
      return `func() ${result} { defer abap.MessageCallScope(s, ${JSON.stringify(e.callee)}, ${exceptionMap}, ${e.exceptions?.others ?? -1}).Restore(s); ${result ? "return " : ""}${call} }()`;
    }
    case "nop_call": return "";
    case "xbytes": return constLiteral({type: e.type, value: e.value});
    case "type_length": return `abap.DescrLength(${expr(e.x, ctx)})`;
    case "type_kind": return `string(${expr(e.x, ctx)}.T.Kind)`;
    // ultra/events: inside a handler's registration (set_handler)
    case "ev_arg": return `EvA.${ident(e.name)}`;
    case "ev_sender": return `abap.SenderAs[${goType(e.type)}](EvSender)`;
    case "ev_handler": return "EvH";
    case "me": return self(ctx, null);
    case "upcast": {
      // a nil pointer put into an interface is not a nil interface: an unbound
      // reference must stay initial when it is widened
      const x = expr(e.x, ctx);
      const fromPtr = e.x.type.k === "ref" && !e.x.type.intf && !POLY.has(e.x.type.name);
      const toIface = e.type.intf || POLY.has(e.type.name);
      return fromPtr && toIface && e.x.e !== "me" && e.x.e !== "new" ? `abap.Up[${goType(e.type)}](${x})` : x;
    }
    case "cast": return `abap.Cast[${goType(e.type)}](${expr(e.x, ctx)})`;
    // a typed slot seen as generic data: its address and its descriptor
    case "lrow": return ctx.lrow;
    // ultra/itab: generic arithmetic (frontend.mjs genericArith)
    case "unwrap_calc": {
      const d = expr(e.x, ctx);
      return e.type.k === "i" ? `abap.DataI(${d})` : e.type.k === "int8" ? `abap.DataI8(${d})` : e.type.k === "f" ? `abap.DataF(${d})` : `abap.DataP(${d})`;
    }
    case "gen_arith": {
      const sel = `abap.CalcKind(${JSON.stringify(e.statics)}, ${e.charTarget}, ${e.target ? expr(e.target, ctx) : "abap.Data{}"}${e.leaves.map((l) => `, ${expr(l, ctx)}`).join("")})`;
      const arms = Object.entries(e.branches).map(([code, b]) => (b.reason !== undefined
        ? `case '${code}': panic(abap.NotCompiled("arithmetic", ${JSON.stringify(b.reason)}))`
        : `case '${code}': return ${expr(b, ctx)}`));
      return `func() ${goType(e.type)} { switch ${sel} { ${arms.join("; ")} }; panic(abap.NotCompiled("arithmetic", ${JSON.stringify(`calculation type of ${e.text} with these operands: not measured`)})) }()`;
    }
    case "wrap": return `abap.Data{P: ${addressable(e.x) ? `&${place(e.x, ctx)}` : `abap.Ptr(${expr(e.x, ctx)})`}, T: ${desc(e.x.type)}}`;
    case "unwrap": return unwrapTo(e.type, expr(e.x, ctx));
    case "unwrap_chars": return `abap.DataChars(${expr(e.x, ctx)})`;
    case "fae_row": return `fae${e.n}`;
    case "lines_data": return `int32(abap.Lines(${expr(e.x, ctx)}))`;
    default: throw new Error(`no Go for expression ${e.e}`);
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
    case "int8": return `abap.FmtI8(${x})`;
    case "f": return `abap.FmtF(${x})`;
    case "p": return `abap.FmtP(${x}, ${opts.pdec ?? v.type.dec ?? 0})`;
    case "string": case "c": case "d": case "t": case "n": return x;
    case "x": case "xstring": return `abap.XToHex(${x})`;
    case "data": return `abap.FmtData(${x})`;
    default: throw new Error(`template part ${v.type.k}`);
  }
}

function conv(e, ctx) {
  const fast = emitPackedInt8(e, (n) => expr(n, ctx), helperFn);
  if (fast !== null) return fast;
  const x = expr(e.x, ctx);
  const from = e.from.k;
  const to = e.to.k;
  switch (e.kind) {
    case "char_to_struct": {
      let off = 0;
      const total = e.fields.reduce((n, f) => n + f.len, 0);
      const fields = e.fields.map((f) => { const value = `${ident(f.name)}: abap.SubC(v, ${total}, ${off}, ${f.len})`; off += f.len; return value; });
      return `func(v string) ${goType(e.to)} { return ${goType(e.to)}{${fields.join(", ")}} }(${x})`;
    }
    case "struct_layout":
      return `func(v ${goType(e.from)}) ${goType(e.to)} { return ${goType(e.to)}{${e.pairs.map(([t, f]) => `${ident(t)}: v.${ident(f)}`).join(", ")}} }(${x})`;
    case "flat_struct_string":
      return `func(v ${goType(e.from)}) string { return strings.TrimRight(abap.Canon(${e.fields.map((f) => `abap.CFit(v.${ident(f.name)}, ${f.len})`).join(" + ")}), " ") }(${x})`;
    case "num":
      if (from === "i" && to === "f") return `float64(${x})`;
      if (from === "f" && to === "i") return `abap.F2I(${x})`;
      if (from === "i" && to === "int8") return `int64(${x})`;
      if (from === "int8" && to === "i") return `abap.I8ToI(${x})`;
      if (from === "int8" && to === "f") return `float64(${x})`;
      if (from === "f" && to === "int8") return `abap.F2I8(${x})`;
      break;
    case "c2s": return x;
    case "table_rows": return `func() ${goType(e.to)} { var out ${goType(e.to)}; for _, ConvRow := range ${x} { out = append(out, ${rowStored(e.to, expr(e.row, ctx))}) }; return out }()`;
    case "s2c": return `abap.CFit(${x}, ${e.to.len})`;
    case "s2d": return `abap.S2D(${x})`;
    case "s2t": return `abap.S2T(${x})`;
    case "i2s": return `abap.IToString(${x})`;
    case "i82s": HELPER_IMPORTS.add("intpower"); return `hIntpower.I8ToString(${x})`;
    case "f2s": HELPER_IMPORTS.add("intpower"); return `hIntpower.FToString(${x})`;
    case "i2n": return `abap.IToN(${x}, ${e.to.len})`;
    case "s2n": return `abap.CToN(${x}, ${e.to.len})`;
    case "x2s": return e.to.k === "c" ? `abap.CFit(abap.XToHex(${x}), ${e.to.len})` : `abap.XToHex(${x})`;
    case "i2x": case "i82x": return `${helperFn(e.to.k === "xstring" ? "intbytes.ToString" : "intbytes.ToX")}(int64(${x}), ${from === "i" ? 4 : 8}${e.to.k === "x" ? `, ${e.to.len}` : ""})`;
    // packed numbers, go/abap packed.go
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
    case "x2i": case "x2i8": return `${to === "i" ? "int32" : "int64"}(${helperFn("intbytes.FromX")}(${x}, ${to === "i" ? 4 : 8}))`;
    case "xs2x": return `abap.XFit(${x}, ${e.to.len})`;
    case "c2x": return e.to.k === "x" ? `abap.XFit(abap.CToX(${x}), ${e.to.len})` : `abap.CToX(${x})`;
    case "t2i": return `abap.TToI(${x})`;
    case "d2i": return `abap.DToI(${x})`;
    case "c2n":
      if (to === "f") return `abap.ParseF(${x})`;
      if (to === "i") return `abap.ParseI(${x})`;
      if (to === "int8") return `abap.ParseI8(${x})`;
      break;
    default: break;
  }
  throw new Error(`no Go for conversion ${e.kind} ${from}->${to}`);
}

function fn(e, ctx) {
  return emitBuiltinGo(e, e.args.map((a) => expr(a, ctx)), FN_F, HELPER_IMPORTS);
}

// an initial reference: the frontend decided it from the static type
// (frontend.mjs upcastable)
const initialReferenceInstanceOf = (predicate) => (predicate.initial ? "true" : "false");

function cond(c, ctx) {
  const fast = emitPackedComparison(c, (n) => expr(n, ctx));
  if (fast !== null) return fast;
  switch (c.c) {
    case "num_data_cmp": return `abap.CmpData(${expr(c.l, ctx)}, ${expr(c.r, ctx)}) ${c.op === "=" ? "==" : c.op === "<>" ? "!=" : c.op} 0`;
    case "in_range": {
      const n = ctx.loop++;
      // field names through ident(): capitalised only in a layered build
      return `func() bool { rows${n} := ${expr(c.range, ctx)}; hasI${n}, hit${n} := false, false; for _, r${n} := range rows${n} { match${n} := false; switch r${n}.${ident("OPTION")} { case "EQ": match${n} = ${expr(c.value, ctx)} == r${n}.${ident("LOW")}; case "BT": match${n} = ${expr(c.value, ctx)} >= r${n}.${ident("LOW")} && ${expr(c.value, ctx)} <= r${n}.${ident("HIGH")}; default: panic(abap.NotCompiled("IN range", "selection option other than EQ or BT")) }; if r${n}.${ident("SIGN")} == "I" { hasI${n} = true; if match${n} { hit${n} = true } } else if r${n}.${ident("SIGN")} == "E" { if match${n} { return false } } else { panic(abap.NotCompiled("IN range", "selection sign other than I or E")) } }; return !hasI${n} || hit${n} }()`;
    }
    case "co": return `abap.CO(${expr(c.l, ctx)}, ${expr(c.r, ctx)})`;
    case "cs": HELPER_IMPORTS.add("charsearch"); return `hCharsearch.WithPos(s, ${expr(c.l, ctx)}, ${expr(c.r, ctx)}, ${!!c.csubject})`;
    case "cp": return `abap.CP(${expr(c.l, ctx)}, ${expr(c.r, ctx)}, ${!!c.cpat}, ${!!c.csubject})`;
    case "ca": return `abap.CA(${expr(c.l, ctx)}, ${expr(c.r, ctx)})`;
    case "cmp":
      // a generic operand (frontend compareValues, unwrap_chars): the pair
      // decides the comparison type, so both go to abap.CmpData as data
      if (c.l.e === "unwrap_chars" || c.r.e === "unwrap_chars") {
        const side = (x) => (x.e === "unwrap_chars" ? expr(x.x, ctx) : `abap.StrData(${expr(x, ctx)})`);
        if (c.op === "=" || c.op === "<>") return `${c.op === "=" ? "" : "!"}abap.DataEq(${side(c.l)}, ${side(c.r)})`;
        return `abap.CmpData(${side(c.l)}, ${side(c.r)}) ${c.op} 0`;
      }
      if (c.type?.k === "p") return `abap.CmpP(${expr(c.l, ctx)}, ${expr(c.r, ctx)}) ${c.op === "=" ? "==" : c.op === "<>" ? "!=" : c.op} 0`;
      return `${expr(c.l, ctx)} ${c.op === "=" ? "==" : c.op === "<>" ? "!=" : c.op} ${expr(c.r, ctx)}`;
    // abap.RefEq: two initial references of different static types are equal (ultra/json fix round)
    case "refeq": return `(${c.op === "=" ? "" : "!"}abap.RefEq(${expr(c.l, ctx)}, ${expr(c.r, ctx)}))`;
    // in parentheses: a composite literal right before the { of an if does not parse
    case "initial":
      if (c.x.type.k === "data") return `abap.IsInitialData(${expr(c.x, ctx)})`;
      if (c.x.type.k === "dref") return `(${expr(c.x, ctx)}.P == nil)`;
      // a table is initial when it has no rows, whether its slice is nil or
      // an empty one (ultra/events: a converted table, make(T, 0))
      if (c.x.type.k === "table") return `(len(${expr(c.x, ctx)}) == 0)`;
      // a d, t or n field of a structure starts as "" (Go's zero), a
      // variable as its typed zero: both are initial
      if (["d", "t", "n"].includes(c.x.type.k)) return `abap.InitialCh(${expr(c.x, ctx)}, ${zero(c.x.type)})`;
      // a structure holding such a field: component by component
      if (c.x.type.k === "struct" && typedZeroInside(c.x.type)) return `abap.IsInitialOf(${expr(c.x, ctx)}, ${desc(c.x.type)})`;
      return `(${expr(c.x, ctx)} == ${zero(c.x.type)})`;
    // IS INSTANCE OF uses the same fit as ?= / CAST, but reports false
    // instead of raising CX_SY_MOVE_CAST_ERROR.
    case "instance_of": {
      const value = expr(c.x, ctx);
      const target = goType(c.type);
      const initial = initialReferenceInstanceOf(c);
      if (c.type.name === "OBJECT" && c.type.intf) return `func() bool { value := ${value}; if value == nil { return ${initial} }; return true }()`;
      return `func() bool { value := ${value}; if value == nil { return ${initial} }; _, ok := any(value).(${target}); return ok }()`;
    }
    // ultra/events: line_exists( ) (frontend lineExists)
    case "line_exists": {
      const n = ctx.loop++;
      const keys = c.keys.map((k) => (k.line ? `r${n} == ${expr(k.value, ctx)}` : `r${n}.${ident(k.name)} == ${expr(k.value, ctx)}`)).join(" && ");
      return `func() bool { for _, r${n} := range ${expr(c.table, ctx)} { if ${keys} { return true } }; return false }()`;
    }
    case "assigned": return c.fs.type.k === "data" ? `(${ident(c.fs.name)}.P != nil)` : `(${ident(c.fs.name)} != nil)`;
    case "data_bound": return `abap.DataBound(${expr(c.x, ctx)})`;
    case "and": return `(${cond(c.l, ctx)} && ${cond(c.r, ctx)})`;
    case "true": return "true";
    // two tables, = or <>: the row counts, then each row at its index
    case "tableeq":
      return `(${c.op === "=" ? "" : "!"}func() bool { l, r := ${expr(c.l, ctx)}, ${expr(c.r, ctx)}; if len(l) != len(r) { return false }; for i := range l { ${place(c.a, ctx)}, ${place(c.b, ctx)} = l[i], r[i]; if !(${cond(c.rowEq, ctx)}) { return false } }; return true }())`;
    case "or": return `(${cond(c.l, ctx)} || ${cond(c.r, ctx)})`;
    case "not": return `!(${cond(c.x, ctx)})`;
    default: throw new Error(`no Go for condition ${c.c}`);
  }
}

/** Call(name, session, args) for the numeric harness: numbers in, a number out */
function dispatcher(classes) {
  const lines = ["// Call runs one static method by name with numeric arguments, for the harness.",
    "func Call(name string, s *abap.Session, args []float64) float64 {", "\tswitch name {"];
  for (const cls of classes) {
    for (const m of cls.methods) {
      if (!m.static || m.returning === null || !["i", "f"].includes(m.returning.type.k)) continue;
      if (m.params.some((p) => p.dir !== "importing" || !["i", "f"].includes(p.type.k))) continue;
      const args = m.params.map((p, i) => (p.type.k === "i" ? `int32(args[${i}])` : `args[${i}]`));
      lines.push(`\tcase "${cls.name}=>${m.name}":`, `\t\treturn float64(${funcName(cls.name, m.name)}(${["s", ...args].join(", ")}))`);
    }
  }
  lines.push("\t}", "\tpanic(\"unknown method \" + name)", "}");
  return lines;
}
