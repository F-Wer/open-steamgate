// ABAP ranges (`col IN rt_range`, a SELECT-OPTIONS table of SIGN / OPTION /
// LOW / HIGH) as an IR condition: the one place their meaning is written.
//
// The ranges' rows are values known only at run time, like a scalar input.
// Two uses, one semantics:
//   - a JS host expands them into IR with rangesPredicate() and lowers the
//     whole statement;
//   - a host that runs no JS at request time (the Go runtime) lowers the
//     static statement at build time with a hostPred() where the ranges go,
//     and fills that placeholder with its port of rangesPredicate(), checked
//     byte for byte against the pairs this module writes
//     (tools/ir-ranges-pairs.mjs, test/fixtures/ir-pairs/).
//
// The rules, as ABAP Open SQL has them:
//   - no rows: no restriction (true);
//   - otherwise (any I row matches, true when there is none) AND NOT (any E
//     row matches);
//   - EQ NE GT GE LT LE compare; BT is LOW <= x <= HIGH; NB is its negation;
//   - CP / NP follow what the kernel sends (A4H's plan cache, 2026-09-23,
//     docs/sqlscript-hana-observed.md): the pattern is LOW at its declared
//     width with HIGH after it, trailing blanks dropped; `*` any string, `+`
//     one character, `#` makes the next character literal (a trailing `#`
//     escapes a padding blank). A pattern with no wildcard left is an
//     equality (`col = ?`), a pattern of `*` alone is true (`1 = 1`), any
//     other is `col LIKE ?`, with `ESCAPE ?` only when a literal `%` or `_`
//     needs it. A pattern whose blanks meet the padding (a leading blank, or
//     blanks just before a wildcard) gets a special form on A4H that is not
//     reconstructed here: refused by name;
//   - SIGN and OPTION as ABAP has them, upper case; anything else (lower
//     case, an initial row) is a dump on A4H, SAPSQL_IN_ITAB_ILLEGAL_SIGN or
//     _OPTION, and is RangesDump here -- never "no restriction";
//   - a value longer than the column is CX_SY_OPEN_SQL_DATA_ERROR (measured),
//     and a CP pattern longer than twice the column is
//     CX_SY_DYNAMIC_OSQL_SEMANTICS -- measured at one width only (CHAR10: 20
//     and 12 pass, 46 raises), so "twice" is an extrapolation from CHAR10 --
//     RangesDataError here;
//   - LOW / HIGH are bound as the column binds (measured on A4H,
//     docs/sqlscript-hana-observed.md): a CHAR value right-trimmed, a NUMC
//     one zero-padded to its length, an INTEGER as a number.
import {T, lit, bin, not, like, col, filter, scan} from "./sqlscript-ir.mjs";
import {lower} from "./sqlscript-lower.mjs";

/** a range this module does not carry, refused by name; `reason` is a short stable code */
export class RangesError extends Error {
  constructor(message, reason = "refused") { super(message); this.reason = reason; }
}
/** what A4H answers with an uncatchable dump (an invalid SIGN / OPTION, an initial row); `abap` names it */
export class RangesDump extends RangesError {
  constructor(message, abap) { super(message, "dump"); this.abap = abap; }
}
/** what A4H raises as a catchable exception (a value too long for the column); `abap` names the class */
export class RangesDataError extends RangesError {
  constructor(message, abap) { super(message, "data error"); this.abap = abap; }
}

/** the outcome of a refused range as the pairs file carries it, for a port to check */
export function errorCode(error) {
  if (error instanceof RangesDump) return {error: "RangesDump", abap: error.abap};
  if (error instanceof RangesDataError) return {error: "RangesDataError", abap: error.abap};
  if (error instanceof RangesError) return {error: "Refused", reason: error.reason};
  throw error;
}

const upper = (v) => String(v ?? "").toUpperCase();
const TRUE = () => bin("=", lit(1, T.int), lit(1, T.int), T.bool);
const FALSE = () => bin("=", lit(1, T.int), lit(0, T.int), T.bool);
/** @param {readonly import("./sqlscript-types.ts").SqlExpr[]} parts */ const or = (parts) => parts.reduce((a, b) => bin("OR", a, b, T.bool));
const and = (a, b) => bin("AND", a, b, T.bool);

/** a LOW / HIGH value as the column's type binds it */
function bound(value, type, kind) {
  if (type?.abap === "I") {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new RangesError(`range value ${JSON.stringify(value)} is not an INTEGER`);
    return lit(n, T.int);
  }
  if (type?.abap === "C") {
    let text = String(value ?? "").replace(/ +$/, "");
    if (kind === "NUMC") {
      if (!/^\d*$/.test(text)) throw new RangesError(`range value ${JSON.stringify(value)} is not NUMC digits`);
      text = text.padStart(type.len, "0");
    }
    if (Number.isInteger(type.len) && text.length > type.len) {
      throw new RangesDataError(`range value ${JSON.stringify(value)} is longer than the column's ${type.len} characters: CX_SY_OPEN_SQL_DATA_ERROR on A4H`, "CX_SY_OPEN_SQL_DATA_ERROR");
    }
    return lit(text, type);
  }
  if (type?.abap === "STRING") return lit(String(value ?? ""), type);
  throw new RangesError(`ranges over a column of type ${type?.abap ?? "unknown"} are not carried yet`);
}

/**
 * An ABAP CP pattern as the kernel reads it: a list of items, {lit: ch},
 * {any} for `*`, {one} for `+`; `#` makes the next character literal, and a
 * `#` with nothing after it escapes a padding blank. Trailing literal blanks
 * are dropped, as the column holds its values right-trimmed.
 */
export function cpItems(pattern) {
  const items = [];
  const text = String(pattern ?? "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "#") { items.push({lit: text[i + 1] ?? " "}); i += 1; }
    else if (ch === "*") items.push({any: true});
    else if (ch === "+") items.push({one: true});
    else items.push({lit: ch});
  }
  while (items.length > 0 && items.at(-1).lit === " ") items.pop();
  return items;
}

/** the items as a LIKE pattern, and whether it needs `ESCAPE '#'` */
export function likePattern(pattern) {
  const items = Array.isArray(pattern) ? pattern : cpItems(pattern);
  const escape = items.some((one) => one.lit === "%" || one.lit === "_");
  const text = items.map((one) => one.any ? "%" : one.one ? "_"
    : escape && ["%", "_", "#"].includes(one.lit) ? `#${one.lit}` : one.lit).join("");
  return {text, escape};
}

/** one row of the ranges, as a condition that is true when it matches */
function rowCondition(expr, type, kind, row, lowLen) {
  const option = String(row.OPTION ?? "");
  if (!["EQ", "NE", "GT", "GE", "LT", "LE", "BT", "NB", "CP", "NP"].includes(option)) {
    throw new RangesDump(`range OPTION ${JSON.stringify(row.OPTION ?? "")}: SAPSQL_IN_ITAB_ILLEGAL_OPTION, an uncatchable dump on A4H`, "SAPSQL_IN_ITAB_ILLEGAL_OPTION");
  }
  const low = () => bound(row.LOW, type, kind);
  const high = () => bound(row.HIGH, type, kind);
  const compare = {EQ: "=", NE: "<>", GT: ">", GE: ">=", LT: "<", LE: "<="}[option];
  if (compare !== undefined) return bin(compare, expr, low(), T.bool);
  if (option === "BT" || option === "NB") {
    const between = and(bin(">=", expr, low(), T.bool), bin("<=", expr, high(), T.bool));
    return option === "BT" ? between : not(between);
  }
  if (option === "CP" || option === "NP") {
    if (type?.abap !== "C" && type?.abap !== "STRING") throw new RangesError(`${option} over a column of type ${type?.abap} is not carried`);
    const lowText = String(row.LOW ?? "");
    const highText = String(row.HIGH ?? "").replace(/ +$/, "");
    if (type.abap === "STRING" && highText !== "") throw new RangesError(`${option} with a HIGH over a STRING column is not measured`, "high over string");
    // LOW at the declared width of the RANGE's LOW (not the column's), then
    // HIGH (measured on A4H: 'X' + 44 blanks + '*' for a char45 range on a
    // CHAR10 column). Without that width a HIGH has no single reading
    if (highText !== "" && !Number.isInteger(lowLen)) {
      throw new RangesError(`${option} with a HIGH needs the declared width of the range's LOW (option lowLen)`, "high without lowLen");
    }
    const source = type.abap === "C" && highText !== "" ? lowText.padEnd(lowLen, " ") + highText : lowText;
    if (type.abap === "C" && source.replace(/ +$/, "").length > 2 * type.len) {
      throw new RangesDataError(`CP pattern ${JSON.stringify(source.replace(/ +$/, ""))} is longer than twice the column's ${type.len} (the limit measured at CHAR10, extrapolated): CX_SY_DYNAMIC_OSQL_SEMANTICS on A4H`, "CX_SY_DYNAMIC_OSQL_SEMANTICS");
    }
    const items = cpItems(source);
    const wild = (one) => one.any === true || one.one === true;
    // blanks that meet the padding: A4H renders a special OR form for these
    // (`col LIKE ? OR col LIKE ? AND (N'_' <> ? OR col <> N'')`)
    const leadingBlank = items[0]?.lit === " ";
    const blankBeforeWild = items.some((one, i) => one.lit === " " && wild(items[i + 1] ?? {}));
    if (leadingBlank || blankBeforeWild) {
      throw new RangesError(`${option} pattern ${JSON.stringify(source)} has blanks that meet the padding; A4H renders a special form for it that is not carried`, "special padding form");
    }
    // `+` alone matched the initial CHAR on A4H while `++` did not, through
    // the same `col LIKE ?`: the difference is in the bound value, which the
    // plan cache does not keep. Refused rather than guessed
    if (items.length === 1 && items[0].one === true) {
      throw new RangesError(`${option} pattern "+" matches the initial value on A4H in a way not reconstructed here`, "plus alone");
    }
    const negated = option === "NP";
    if (items.length > 0 && items.every((one) => one.any === true)) return negated ? FALSE() : TRUE();
    if (!items.some(wild)) {
      // no wildcard left: an equality, as the kernel sends it
      const text = items.map((one) => one.lit).join("");
      return bin(negated ? "<>" : "=", expr, type.abap === "C" ? lit(text, type) : lit(text, type), T.bool);
    }
    const {text, escape} = likePattern(items);
    return like(expr, lit(text, T.str), escape ? lit("#", T.str) : undefined, negated);
  }
  throw new RangesDump(`range OPTION ${JSON.stringify(row.OPTION)} is not one ABAP knows`, "SAPSQL_IN_ITAB_ILLEGAL_OPTION");
}

/**
 * `column IN ranges` as an IR condition.
 * @param column  an IR expression (usually col(name, type)) or a column name
 * @param type    the column's IR type ({abap: "C", len} / {abap: "I"} / STRING)
 * @param rows    [{SIGN, OPTION, LOW, HIGH}] -- keys in any case
 * @param options {kind: "NUMC"} when a C column is NUMC; {lowLen} the declared
 *                width of the range's LOW, needed for a CP / NP with a HIGH
 */
export function rangesPredicate(column, type, rows, options = {}) {
  const expr = typeof column === "string" ? col(upper(column), type) : column;
  const normal = (rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [upper(k), v])));
  if (normal.length === 0) return TRUE();
  const sign = (s) => normal.filter((row) => row.SIGN === s);
  // exactly I or E: lower case or an initial row is a dump on A4H, not a no-op
  const unknown = normal.find((row) => !["I", "E"].includes(row.SIGN));
  if (unknown !== undefined) throw new RangesDump(`range SIGN ${JSON.stringify(unknown.SIGN ?? "")}: SAPSQL_IN_ITAB_ILLEGAL_SIGN, an uncatchable dump on A4H`, "SAPSQL_IN_ITAB_ILLEGAL_SIGN");
  const include = sign("I").map((row) => rowCondition(expr, type, options.kind, row, options.lowLen));
  const exclude = sign("E").map((row) => rowCondition(expr, type, options.kind, row, options.lowLen));
  const included = include.length === 0 ? undefined : or(include);
  const excluded = exclude.length === 0 ? undefined : not(or(exclude));
  if (included !== undefined && excluded !== undefined) return and(included, excluded);
  return included ?? excluded;
}

// Where a range predicate arrives at run time, for a host that lowers the
// statement at build time: lower() renders it as a marker that is not a
// parameter -- an SQL comment `@range:<id>` -- and lists it in the result's
// `hostPreds` (with `after`, the number of parameters before it), and the
// host puts its rangesPredicate() rendering in the marker's place.
export const hostPred = (id, column, columnType, options = {}) =>
  ({node: "hostPred", id: String(id), column: upper(column), columnType,
    ...(options.kind === undefined ? {} : {kind: options.kind}), type: T.bool});

/**
 * A condition alone, rendered by the same lower() a whole statement uses:
 * the SQL a host splices into a hostPred marker, with its own parameters in
 * order. Rendered as the WHERE of a one-table select and cut out, so there
 * is no second renderer to drift from the first.
 */
export function lowerPredicate(pred, dialect) {
  const {sql, params} = lower(filter(scan("__RANGES__"), pred), dialect);
  const prefixes = [`SELECT * FROM "__RANGES__" WHERE `];
  const prefix = prefixes.find((one) => sql.startsWith(one));
  if (prefix === undefined) throw new RangesError(`lowerPredicate: ${dialect} rendered an unexpected shape: ${sql.slice(0, 60)}`);
  return {sql: sql.slice(prefix.length), params};
}
