// Open SQL value and type lowering.
import * as RIR from "../sqlscript-ir.mjs";
import {Unsupported, Expressions, charlike, isExpr, isTok, upper} from "./frontend-base.mjs";
import {convert, fieldChain, isVariableName, source, sourceOperand} from "./frontend.mjs";
import {fieldOf} from "./frontend-types-signatures.mjs";

/** the IR type of a column in a predicate or a projection */
// a DEC column: its digits (2n-1 for p LENGTH n) and decimals, as the IR
// counts them (ANORMALIES NOTE packed-length-is-bytes)
// a RAW(n) column is T.bytes(n), a RAWSTRING T.bytes() (ultra/zvdb)
const sqlIrType = (t) => (t.k === "i" ? RIR.T.int : t.k === "int8" ? RIR.T.int8 : t.k === "string" ? RIR.T.str : t.k === "d" ? RIR.T.date
  : t.k === "p" ? RIR.T.dec(2 * (t.len ?? 8) - 1, t.dec ?? 0) : t.k === "x" ? RIR.T.bytes(t.len ?? 1) : t.k === "xstring" ? RIR.T.bytes()
    : RIR.T.char(t.len ?? 1));
/** the IR type a written value binds as (tools/ir-writes.mjs bindValue): a
 * d, t or n is its characters, as the column stores them */
function writeIrType(t, where) {
  if (t.k === "i") return RIR.T.int;
  if (t.k === "int8") return RIR.T.int8;
  if (t.k === "string") return RIR.T.str;
  if (t.k === "c" || t.k === "n") return RIR.T.char(t.len ?? 1);
  if (t.k === "d") return RIR.T.char(8);
  if (t.k === "t") return RIR.T.char(6);
  // a RAW(n) column (ultra/zvdb, A4H ZCL_GOGEN_T_RAWRD / _RAWSEL): its n
  // bytes, an x or xstring cut or padded with 00, bound by the Go runtime as
  // the column holds them (go/abap dbraw.go DBXHex, bindValue).
  // tools/ir-writes.mjs has no byte type in bindValue / initialValue yet, so
  // the build-time check of a write stands a STRING in for it (irCheck). A
  // RAWSTRING column is not written yet: not measured
  if (t.k === "x") return RIR.T.bytes(t.len ?? 1);
  if (t.k === "xstring") return RIR.T.bytes();
  // a DEC column: its digits and decimals, as sqlIrType counts them; bound
  // as the decimal text of the work area's p (tools/ir-writes.mjs
  // packedText, taken from main, where the P initial value was added;
  // go/abap/dbwrite.go bindValue). ultra/demodata: ZOSD_TAXIFACT's FARE
  if (t.k === "p") return RIR.T.dec(2 * (t.len ?? 8) - 1, t.dec ?? 0);
  throw new Unsupported(`${where}: a column of kind ${t.k} is not written yet`);
}
/** the type a write is checked with at build time: ir-writes.mjs binds no
 * bytes yet (bindValue, initialValue), and the shape it renders does not
 * depend on the type, so a STRING stands in for a RAW column there. What
 * runs is the Go runtime's bindValue with the real type (dbwrite.go) */
const irCheck = (t) => (t.abap === "X" || t.abap === "XSTRING" ? RIR.T.str : t);
const lowName = (n) => n.toLowerCase();
const mandtPred = () => RIR.bin("=", RIR.col("mandt", RIR.T.char(3)), RIR.param("SY-MANDT", RIR.T.char(3)), RIR.T.bool);
const andIr = (a, b) => (a === null ? b : b === null ? a : RIR.bin("AND", a, b, RIR.T.bool));

/** a host value of Open SQL: [@]name[-comp...], the parser leaving a
 * component after @ as siblings (Dash, SQLFieldName) */
function sqlHost(src, trailing, ctx, text) {
  // FOR ALL ENTRIES IN itab: itab-comp is the component of the driving row
  // the statement is run for (selectStatement, parity-wave1)
  if (ctx.fae) {
    const whole = [src, ...trailing].map((x) => x.concatTokens()).join("").replace(/^@/, "");
    const m = /^([\w\/]+)-([\w\/]+)$/.exec(whole);
    if (m && upper(m[1]) === ctx.fae.name) {
      if (upper(m[2]) === "TABLE_LINE") throw new Unsupported(`FOR ALL ENTRIES: ${whole}: an elementary driving table is not in the subset`);
      const f = fieldOf(ctx, ctx.fae.row, m[2], text);
      return {e: "field", base: {e: "fae_row", n: ctx.fae.n, type: ctx.fae.row}, name: f.name, type: f.type};
    }
  }
  const sk = [...src.getChildren().filter((c) => !isTok(c, "@")), ...trailing];
  const simple = sk[0];
  if (isExpr(simple, Expressions.Source)) {
    if (sk.length !== 1) throw new Unsupported(`SQL value: ${text}`);
    return source(simple, ctx);
  }
  if (!isExpr(simple, Expressions.SimpleSource3) || simple.getChildren().length !== 1) throw new Unsupported(`SQL value: ${text}`);
  // sy-mandt (sy-subrc, ...) without @ in an old-style condition: the parser
  // leaves the component as a sibling of `sy` (ultra/zvdb: DELETE FROM
  // zvdb_100_vec WHERE mandt = sy-mandt ...); read as the same field of sy
  if (sk.length === 3 && upper(simple.concatTokens()) === "SY" && !isVariableName("SY", ctx) && isTok(sk[1], "-") && isExpr(sk[2], Expressions.SQLFieldName)) {
    const syText = `SY-${upper(sk[2].concatTokens())}`;
    let v;
    try { v = fieldChain({getChildren: () => [], concatTokens: () => syText}, ctx); } catch { v = undefined; }
    if (v === undefined || v.e === undefined) throw new Unsupported(`SQL value: ${text}`);
    return v;
  }
  let v = sourceOperand(simple.getFirstChild(), ctx);
  for (let i = 1; i < sk.length; i += 2) {
    if (!isTok(sk[i], "-") || !isExpr(sk[i + 1], Expressions.SQLFieldName)) throw new Unsupported(`SQL value: ${text}`);
    const f = fieldOf(ctx, v.type, sk[i + 1].concatTokens(), text);
    v = {e: "field", base: v, name: f.name, type: f.type};
  }
  return v;
}

/** a value compared with or written into a column: a literal of the
 * column's own kind is an IR literal, anything else a host value converted
 * to the column's type and bound at run time */
function sqlValue(v, ct, ir, acc, set = false) {
  if (ct.k === "x") return rawValue(v, ct, ir, acc, set);
  if (ct.k === "xstring" && set) {
    if (v.type.k !== "xstring" && v.type.k !== "x") throw new Unsupported(`UPDATE of an xstring column from a ${v.type.k}`);
    acc.hosts.push({xstring: true, v});
    return RIR.param(`@@host:${acc.hosts.length - 1}@@`, ir);
  }
  if (v.e === "chars" && ct.k === "c" && v.value.length <= (ct.len ?? 1)) return RIR.lit(v.value, ir);
  if (v.e === "int" && ct.k === "i") return RIR.lit(v.value, ir);
  // a character value that may not fit the column: convert( ) would cut it,
  // and a cut value can compare equal to (or be written as) a different
  // key. A4H raises CX_SY_OPEN_SQL_DATA_ERROR for a range LOW longer than
  // the column; a plain comparison and a SET are not measured, so a value
  // that does not fit is refused when it arrives (abap.DBCFit) and one that
  // fits is bound right-trimmed as before.
  if (ct.k === "c" && (v.type.k === "string" || (v.type.k === "c" && (v.type.len ?? 1) > (ct.len ?? 1)))) {
    if (v.e === "chars" || v.e === "str") throw new Unsupported(`a literal longer than the ${ct.len ?? 1} characters of its column`);
    acc.hosts.push({fit: ct.len ?? 1, v});
    return RIR.param(`@@host:${acc.hosts.length - 1}@@`, ir);
  }
  const x = convert(v, ct);
  acc.hosts.push(x);
  return RIR.param(`@@host:${acc.hosts.length - 1}@@`, ir);
}

/**
 * A value against a RAW(n) column (ultra/zvdb, A4H 2026-09-24,
 * ZCL_GOGEN_T_RAWRD / _RAWSEL / _RAWSTR / _RAWDYN; go/abap dbraw.go). In a
 * WHERE: an x of the same length compares as its bytes (another length does
 * not activate), an xstring must hold exactly n bytes at run time
 * (CX_SY_OPEN_SQL_DATA_ERROR), a literal is exactly 2n upper-case hex
 * digits. In a SET: an x or xstring of any length cut or padded with 00, a
 * character value by the move rule (CToX). Bound as the column holds it,
 * upper-case hex of 2n digits.
 */
function rawValue(v, ct, ir, acc, set) {
  const n = ct.len ?? 1;
  const where = set ? "SET" : "WHERE";
  if (v.e === "chars" || v.e === "str") {
    if (v.e === "chars" && new RegExp(`^[0-9A-F]{${2 * n}}$`).test(v.value)) return RIR.lit(v.value, ir);
    throw new Unsupported(`${where}: the literal '${v.value}' against a RAW(${n}) column is not ${2 * n} upper-case hex digits (not measured statically; CX_SY_OPEN_SQL_DATA_ERROR in a dynamic WHERE)`);
  }
  if (v.type.k === "x" && (set || (v.type.len ?? 1) === n)) { acc.hosts.push({xhex: n, v}); return RIR.param(`@@host:${acc.hosts.length - 1}@@`, ir); }
  if (v.type.k === "x") throw new Unsupported(`WHERE: an x of ${v.type.len ?? 1} bytes against a RAW(${n}) column (a syntax error on A4H: not compatible)`);
  if (v.type.k === "xstring") { acc.hosts.push(set ? {xhex: n, v} : {xexact: n, v}); return RIR.param(`@@host:${acc.hosts.length - 1}@@`, ir); }
  if (set && charlike(v.type)) { acc.hosts.push({xhex: n, v: convert(v, ct)}); return RIR.param(`@@host:${acc.hosts.length - 1}@@`, ir); }
  throw new Unsupported(`${where}: a ${v.type.k} against a RAW(${n}) column is not measured`);
}

const SQL_OPS = {"=": "=", EQ: "=", "<>": "<>", NE: "<>", "<": "<", LT: "<", ">": ">", GT: ">", "<=": "<=", LE: "<=", ">=": ">=", GE: ">="};

export {sqlIrType, writeIrType, irCheck, lowName, mandtPred, andIr, sqlHost, sqlValue, SQL_OPS};
