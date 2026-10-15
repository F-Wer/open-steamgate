import {abaplint, BasicTypes, Unsupported, I, F, INT8, S, C, X, XS, upper, goName} from "./frontend-base.mjs";
import {ddicOutputLength, REG, clasDef} from "./frontend.mjs";
import {P_GENERIC} from "./frontend-classes-native.mjs";
import {copyType} from "./tagged-copies.ts";
/** the RTTI type kind (cl_abap_typedescr=>typekind_*) of an abaplint type */
/** @param {import("@abaplint/core").AbstractType | undefined} t @returns {string} */ function typeKindOf(t) {
  if (t instanceof BasicTypes.CharacterType) return "C";
  if (t instanceof BasicTypes.NumericType) return "N";
  if (t instanceof BasicTypes.DateType) return "D";
  if (t instanceof BasicTypes.TimeType) return "T";
  if (t instanceof BasicTypes.IntegerType) return "I";
  if (t instanceof BasicTypes.Integer8Type) return "8";
  if (t instanceof BasicTypes.PackedType) return "P";
  if (t instanceof BasicTypes.FloatType) return "F";
  if (t instanceof BasicTypes.HexType) return "X";
  if (t instanceof BasicTypes.StringType) return "g";
  if (t instanceof BasicTypes.XStringType) return "y";
  if (t instanceof BasicTypes.DecFloat16Type) return "a";
  if (t instanceof BasicTypes.DecFloat34Type) return "e";
  if (t instanceof BasicTypes.StructureType) return "u";
  if (t instanceof BasicTypes.TableType) return "h";
  if (t instanceof BasicTypes.DataReference) return "l";
  if (t instanceof BasicTypes.ObjectReferenceType) return "r";
  return "?";
}

/* --------------------------------------------------------------------- types */

/** @param {import("@abaplint/core").AbstractType} t @param {string} where @param {import("./frontend-types.ts").FrontendProgram} program @returns {import("./ir.ts").Type} */ function typeOf(t, where, program) {
  // generic data: TYPE any / data / ANY TABLE, and data references. A
  // generic value is a binding to a typed slot (abap.Data in Go)
  if (t instanceof BasicTypes.AnyType || t instanceof BasicTypes.DataType || t instanceof BasicTypes.SimpleType) return {k: "data"};
  if (t instanceof BasicTypes.TableType && (t.getRowType() instanceof BasicTypes.AnyType || t.getRowType() instanceof BasicTypes.DataType)) return {k: "data", table: true};
  if (t instanceof BasicTypes.DataReference) {
    const inner = t.getType();
    if (inner && !(inner instanceof BasicTypes.AnyType) && !(inner instanceof BasicTypes.DataType)) {
      try { return {k: "dref", to: typeOf(inner, where, program)}; } catch (e) { if (!(e instanceof Unsupported)) throw e; }
    }
    return {k: "dref"};
  }
  // REF TO object: the root of every class, any object fits
  if (t instanceof BasicTypes.GenericObjectReferenceType) return {k: "ref", name: "OBJECT", intf: true};
  // d and t: their characters, initial all zeros
  if (t instanceof BasicTypes.DateType) return {k: "d", len: 8};
  // ultra/events: a generic TYPE p takes the caller's decimals, which a typed
  // signature cannot say; only the host functions listed in P_GENERIC take
  // one, as p(16,7), which holds a TIMESTAMP and a TIMESTAMPL exactly
  if (t instanceof BasicTypes.PGenericType && P_GENERIC.has(String(where).split(" ")[0])) return {k: "p", len: 16, dec: 7};
  // ASSERT_NUMBER_BETWEEN takes TYPE numeric. Bind the caller's actual type:
  // converting a packed or float boundary to i rounds before the comparison.
  if (t instanceof BasicTypes.NumericGenericType && String(where).split(" ")[0] === "CL_ABAP_UNIT_ASSERT=>ASSERT_NUMBER_BETWEEN") return {k: "data", numeric: true};
  if (t instanceof BasicTypes.NumericGenericType && P_GENERIC.has(String(where).split(" ")[0])) return {k: "i"};
  // p: declared, initial, copied and compared with initial only, as its
  // decimal text; any arithmetic or conversion is refused until packed
  // numbers are measured on A4H
  if (t instanceof BasicTypes.PackedType) return {k: "p", len: t.getLength(), dec: t.getDecimals()};
  if (t instanceof BasicTypes.TimeType) return {k: "t", len: 6};
  // n: its digits, initial all zeros; declared, copied and compared with
  // initial only until its conversions are measured
  if (t instanceof BasicTypes.NumericType) return {k: "n", len: t.getLength()};
  if (t instanceof BasicTypes.IntegerType) return I;
  if (t instanceof BasicTypes.FloatType) return F;
  if (t instanceof BasicTypes.Integer8Type) return INT8;
  if (t instanceof BasicTypes.StringType) return S;
  if (t instanceof BasicTypes.CharacterType) return C(t.getLength());
  if (t instanceof BasicTypes.HexType) return X(t.getLength());
  if (t instanceof BasicTypes.XStringType) return XS;
  // a parameter TYPE c takes the length of what is passed: stored without
  // trailing blanks like any c, so a length no value reaches
  if (t instanceof BasicTypes.CGenericType) return C(262143);
  // csequence and clike take a c or a string: carried as a string, so a c
  // passed in arrives without its trailing blanks, which every character
  // operation of a c ignores anyway (a structure passed as clike is refused
  // at the call, where the conversion to string fails)
  if (t instanceof BasicTypes.CSequenceType || t instanceof BasicTypes.CLikeType) return S;
  // ultra/events: xsequence takes an x or an xstring: carried as an xstring,
  // as csequence is carried as a string (ZCL_ABAPGIT_CONVERT=>XSTRING_TO_STRING_UTF8)
  if (t instanceof BasicTypes.XSequenceType) return XS;
  if (t instanceof BasicTypes.TableType) {
    const access = t.getAccessType();
    const row = typeOf(t.getRowType(), where, program);
    // secondary keys (ultra/json): carried with the type, used by LOOP ...
    // USING KEY and READ ... WITH KEY k COMPONENTS (secondaryKey below);
    // a hashed one is refused where it is used
    const secondary = (t.getOptions().secondary ?? []).map((k) => ({name: upper(k.name), sorted: String(k.type).toUpperCase() === "SORTED",
      hashed: String(k.type).toUpperCase() === "HASHED", unique: k.isUnique === true, comps: k.keyFields.map(upper)}));
    if (secondary.length && access === "HASHED") throw new Unsupported(`${where}: secondary keys on a ${access} table`);
    // ultra/itab: the primary key, for SORT without BY: "default", the
    // component names of a user key, or [] for an empty one
    if (access === "STANDARD") {
      const o = t.getOptions();
      const skey = o.keyType === "DEFAULT" ? "default" : o.keyType === "EMPTY" ? [] : (o.primaryKey?.keyFields ?? []).map(upper);
      return secondary.length ? {k: "table", row, skey, secondary} : {k: "table", row, skey};
    }
    // a HASHED table loops in insertion order, so it is a slice whose
    // INSERT keeps the key unique; SORTED is not here yet
    if (access === "HASHED") {
      const key = (t.getOptions().primaryKey?.keyFields ?? []).map(upper);
      if (key.length === 0) throw new Unsupported(`${where}: HASHED table without a key`);
      return {k: "table", row, hashed: key};
    }
    // ultra/events: SORTED ... WITH UNIQUE / NON-UNIQUE KEY (ZCL_ABAPGIT_STRING_MAP):
    // a slice in key order, see refuseSorted and insert_table
    if (access === "SORTED") {
      const o = t.getOptions();
      const key = (o.primaryKey?.keyFields ?? []).map(upper);
      if (key.length === 0) throw new Unsupported(`${where}: SORTED table without a key`);
      return secondary.length ? {k: "table", row, sorted: key, unique: !!o.primaryKey?.isUnique, secondary}
        : {k: "table", row, sorted: key, unique: !!o.primaryKey?.isUnique};
    }
    throw new Unsupported(`${where}: ${access} tables`);
  }
  if (t instanceof BasicTypes.StructureType) {
    const comps = t.getComponents();
    const q = t.getQualifiedName();
    // a type declared in a class or a method has no owner in its name: two
    // classes may both have a ty_face, with other fields, so the class names it
    // a DDIC structure (a TABL of the dictionary, e.g. IHTTPNVP) is global:
    // one Go type for every class that uses it, or two classes cannot pass it
    // a structure is the class's own only when the class declares a type of
    // that name; a DDIC table or a type-pool type is global, one Go type
    // for every class that uses it, or two classes cannot pass it
    const local = !q || (!q.includes("=>") && (program.currentTypes?.has(upper(q)) ?? true));
    let go = q ? goName(q) : `S_${comps.map((c) => c.name).join("_").slice(0, 40).toUpperCase()}`;
    if (local && program.currentClass) go = `${program.currentClass}__${go}`;
    // an anonymous structure (the row of a RANGE OF, of a TYPE TABLE OF an
    // inline BEGIN OF) is one abaplint type wherever it is reached -- an
    // interface's signature, the caller, the implementing class, LIKE LINE
    // OF a parameter: it keeps the name it was first given, or the places
    // that share it name two Go types
    if (!q) {
      const seen = program.anonStructs.get(t);
      if (seen !== undefined) go = seen;
      else program.anonStructs.set(t, go);
    }
    const shape = comps.map((c) => upper(c.name)).join(",");
    for (let n = 2; program.structs.has(go) && program.structs.get(go).shape !== undefined && program.structs.get(go).shape !== shape; n += 1) {
      go = `${go.replace(/_V\d+$/, "")}_V${n}`;
    }
    if (program.badStructs?.has(go)) throw new Unsupported(program.badStructs.get(go));
    if (!program.structs.has(go)) {
      /** @type {import("./frontend-types.ts").StructType} */ const st = {k: "struct", go, fields: [], shape, ...(q ? {qname: upper(q)} : {})};
      program.structs.set(go, st); // before the fields: a struct may nest itself through a table
      try {
        st.fields = comps.map((c) => ({name: upper(c.name), type: rttiNamed(typeOf(c.type, `${where}-${c.name}`, program), c.type)}));
      } catch (e) {
        // a field outside the subset: the structure is not in the program,
        // and every later use of it is refused with the same reason
        program.structs.delete(go);
        program.badStructs.set(go, e.message);
        throw e;
      }
    }
    return {k: "struct", go};
  }
  if (t instanceof BasicTypes.ObjectReferenceType) {
    const name = upper(t.getIdentifierName());
    // a local class of the class being compiled, by its compiled name (ultra/json)
    const local = program.locals?.get(`${program.currentOwner}|${name}`);
    if (local !== undefined) return {k: "ref", name: local, intf: false};
    const intf = program.reg?.getObject("INTF", name) !== undefined;
    if (!intf && program.reg?.getObject("CLAS", name) === undefined) throw new Unsupported(`${where}: REF TO ${name}, which is not in the program`);
    if (intf) program.interfaces.add(name);
    return {k: "ref", name, intf};
  }
  throw new Unsupported(`${where}: type ${t.constructor.name} is outside the subset`);
}

/*
 * An elementary component's type with the names RTTI reads (ultra/json):
 * abaplint's qualified name, upper case, as the transpiler hands it to its
 * runtime, and the dictionary type it comes from. Only components carry
 * them: a component is what describe_by_data sees through ASSIGN
 * COMPONENT, and naming every local would give every generic binding a
 * descriptor of its own.
 */
/** @param {import("./ir.ts").Type} ir @param {import("@abaplint/core").AbstractType} t @returns {import("./ir.ts").Type} */ function rttiNamed(ir, t) {
  if (["struct", "table", "dref", "ref", "exc", "data"].includes(ir.k)) return ir;
  const q = t.getQualifiedName?.();
  // abaplint gives a NUMC data element its name as the qualified name only
  // (no DDIC name): read it as the dictionary type it is (parity-wave1)
  const d = t.getDDICName?.() ?? (ir.k === "n" && q && !/[=>-]/.test(q) && REG?.getObject("DTEL", upper(q)) ? q : undefined);
  if (!q && !d) return ir;
  if (d) ddicOutputLength(upper(d));
  return copyType(ir, {...(q ? {qname: upper(q)} : {}), ...(d ? {ddic: upper(d)} : {})});
}

/** @param {import("./frontend-types.ts").CompilationContext} ctx @param {Extract<import("./ir.ts").Type, {k: "struct"}>} t @returns {import("./frontend-types.ts").StructType | undefined} */ const structOf = (ctx, t) => ctx.program.structs.get(t.go);
/** @param {import("./frontend-types.ts").CompilationContext} ctx @param {import("./ir.ts").Type} t @param {string} name @param {string} where @returns {import("./ir.ts").Field} */ const fieldOf = (ctx, t, name, where) => {
  if (t.k !== "struct") throw new Unsupported(`${where}: component ${name} of a non-structure`);
  const f = structOf(ctx, t).fields.find((x) => x.name === upper(name));
  if (f === undefined) throw new Unsupported(`${where}: no component ${name}`);
  return f;
};

/** @param {import("./frontend-types.ts").SyntaxNode | undefined} typeNode @param {import("./frontend-types.ts").MethodContext} ctx @param {import("./ir.ts").Type} [inferred] @returns {import("./ir.ts").Type} */ function namedType(typeNode, ctx, inferred) {
  if (typeNode === undefined) throw new Unsupported("a constructor without a type");
  const text = typeNode.concatTokens();
  if (text === "#") {
    if (inferred === undefined) throw new Unsupported("# without a type to infer from here");
    return inferred;
  }
  const t = upper(text);
  const builtin = {
    I, F, STRING: S, XSTRING: XS, INT8, D: {k: "d", len: 8}, T: {k: "t", len: 6},
    OBJECT: {k: "ref", name: "OBJECT", intf: true},
    P: {k: "p", len: 8, dec: 0}, C: C(1), N: {k: "n", len: 1}, X: X(1), ABAP_BOOL: C(1),
  }[t];
  if (builtin) return builtin;
  const pool = t.includes("_") ? ctx.reg.getObject("TYPE", t.split("_")[0]) : undefined;
  const poolType = pool ? new abaplint.SyntaxLogic(ctx.reg, pool).run().spaghetti.getFirstChild()?.getFirstChild()?.findType(t) : undefined;
  const local = ctx.scope.findType?.(t) ?? ctx.scope.findTypePoolType?.(t) ?? poolType
    ?? clasDef(ctx.reg, ctx.className)?.getTypeDefinitions().getByName(t);
  if (local !== undefined) return typeOf(local.getType(), text, ctx.program);
  if (ctx.reg.getObject("CLAS", t) || ctx.reg.getObject("INTF", t)) return {k: "ref", name: t, intf: ctx.reg.getObject("INTF", t) !== undefined};
  const m = /^(\w+)=>(\w+)$/.exec(t);
  if (m) {
    const owner = ctx.reg.getObject("INTF", m[1])?.getDefinition() ?? clasDef(ctx.reg, m[1]);
    const td = owner?.getTypeDefinitions().getByName(m[2]);
    if (td === undefined) throw new Unsupported(`type ${text}`);
    return typeOf(td.getType(), text, ctx.program);
  }
  throw new Unsupported(`type ${text}`);
}

export {typeKindOf, typeOf, rttiNamed, structOf, fieldOf, namedType};
