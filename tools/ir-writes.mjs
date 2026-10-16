// Writes as IR: INSERT, UPDATE, DELETE and MODIFY (an upsert by key), for a
// host that turns ABAP Open SQL into this IR and lowers it -- the Go runtime
// at build time, a JS host at run time. The statement is rendered by the
// same lower() a SELECT is (tools/sqlscript-lower.mjs), so its values and
// conditions are the same placeholders and the same dialect texts; the pairs
// a port is checked against are tools/ir-writes-pairs.mjs's.
//
// What the node carries is what the SQL needs; what ABAP makes of the answer
// is the host's (sy-dbcnt the rows affected, sy-subrc 4 when none). The
// duplicate-key rules, measured on A4H by the dbwrite agent (branch
// ultra/dbwrite, ANORMALIES dbwrite-*):
//   - INSERT dbtab FROM wa, a duplicate: sy-subrc 4, nothing written --
//     onDuplicate "error": one plain INSERT, the engine raises, the host
//     answers 4;
//   - INSERT dbtab FROM TABLE itab, a duplicate: CX_SY_OPEN_SQL_DB, and every
//     non-duplicate row IS written (a duplicate inside the itab too: the
//     first written, then the raise) -- onDuplicate "raise": rendered as the
//     skipping INSERT, and the host raises when fewer rows were written than
//     given (`rows.length` is on the node);
//   - ACCEPTING DUPLICATE KEYS: sy-subrc 4, the rest written -- "ignore".
// UPDATE dbtab FROM TABLE is one UPDATE per row by key with the counts summed
// (a missing row: sy-subrc 4); DELETE dbtab FROM wa / FROM TABLE match on the
// primary key only: the front end builds those predicates from the key.
// MODIFY writes the whole work area, row by row, the last row of a key wins.
//
// The front end puts MANDT into the rows and the conditions (the logon
// client) and binds CHAR right-trimmed, as the column holds it on HANA. A
// remove() or update() without a predicate touches every row of every
// client: lower() adds no MANDT, by contract.
import {T, lit} from "./sqlscript-ir.mjs";

export class WriteError extends Error {}

const upper = (v) => String(v ?? "").toUpperCase();
/** @param {readonly string[]} columns @returns {string[]} */ const names = (columns) => columns.map(upper);

/** ABAP's initial value of a column type: what a work-area field holds untouched */
export function initialValue(type) {
  if (type?.abap === "I" || type?.abap === "INT8") return lit(0, type);
  if (type?.abap === "C" || type?.abap === "STRING") return lit("", type);
  if (type?.abap === "D") return lit("00000000", type);
  // a RAW(n) is n zero bytes, never empty (measured: a cleared field reads
  // back 00000000); a RAWSTRING is empty
  if (type?.abap === "X") return lit(Number.isInteger(type.len) ? "00".repeat(type.len) : "", type);
  if (type?.abap === "XSTRING") return lit("", type);
  if (type?.abap === "P") return lit(packedText("0", type, "the initial value"), type);
  throw new WriteError(`a column of type ${type?.abap ?? "unknown"} has no initial value here yet`);
}

/**
 * A packed value as the decimal string of its type: exactly `dec` digits
 * after the point, no exponent, no -0. It is what an ABAP work area's P field
 * holds, so a value it could not hold is refused rather than rounded: more
 * decimals than the type has (unless the extra ones are zeros), or more
 * digits than its length -- rounding on the way in is ABAP's assignment, not
 * the write's, and was not measured here.
 *
 * The text grammar is abapNumber's (tools/ir-osql-where.mjs): blanks around
 * it are skipped (spaces only -- a tab is not a blank), a sign may lead or
 * trail ('5-' is -5, as ABAP writes it), digits on both sides of a point.
 * Two differences, both on purpose. abapNumber converts a WHERE literal and
 * rounds half away from zero, as A4H does; a work area already holds its
 * value, so here extra decimals are refused, never rounded. And abapNumber
 * reads an empty or blank literal as 0; here it is refused -- a field left
 * out is the initial value (undefined), but '' given for a number is a
 * caller's mistake, not a value a P field holds.
 *
 * A JavaScript number is read by its shortest text and is refused past
 * 2^53, where that text is no longer the number the caller meant: a caller
 * with more digits passes a string. The type is checked as DDIC has it:
 * `len` 1..31 digits (31 when absent), `dec` 0..14 and not above `len`.
 */
export function packedText(value, type, what = "value") {
  const len = type?.len === undefined ? 31 : type.len;
  const dec = type?.dec === undefined ? 0 : type.dec;
  if (!Number.isInteger(len) || len < 1 || len > 31) throw new WriteError(`a packed type of length ${JSON.stringify(type?.len)}: DDIC allows 1 to 31 digits`);
  if (!Number.isInteger(dec) || dec < 0 || dec > 14 || dec > len) throw new WriteError(`a packed type with ${JSON.stringify(type?.dec)} decimals: DDIC allows 0 to 14, and not more than its ${len} digits`);
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WriteError(`${what} ${JSON.stringify(value)} is not a decimal number`);
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new WriteError(`${what} ${value} is past 2^53 as a JavaScript number: pass it as a decimal string`);
    text = String(value);
    // the shortest text of a small number is exponent form: 1e-7 is what
    // the ABAP runtime's P(15,7) answers for 0.0000001. Written out to the
    // type's decimals, it must read back as the same number, or it had more
    // decimals than the type
    if (/e/i.test(text)) {
      const fixed = value.toFixed(dec);
      if (Number(fixed) !== value) throw new WriteError(`${what} ${text} has more than the column's ${dec} decimals`);
      text = fixed;
    }
  } else if (typeof value === "string" || typeof value === "bigint") {
    text = String(value).replace(/^ +| +$/g, "");
  } else {
    throw new WriteError(`${what} ${JSON.stringify(value)} is not a decimal number`);
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?([+-]?)$/.exec(text);
  if (m === null || (m[1] !== "" && m[4] !== "")) throw new WriteError(`${what} ${JSON.stringify(value)} is not a decimal number`);
  const fraction = m[3] ?? "";
  if (fraction.length > dec && /[1-9]/.test(fraction.slice(dec))) {
    throw new WriteError(`${what} ${JSON.stringify(value)} has more than the column's ${dec} decimals`);
  }
  const whole = m[2].replace(/^0+(?=\d)/, "");
  const digits = fraction.padEnd(dec, "0").slice(0, dec);
  if ((whole === "0" ? 0 : whole.length) + dec > len) {
    throw new WriteError(`${what} ${JSON.stringify(value)} does not fit the column's ${len} digits`);
  }
  const zero = /^0*$/.test(whole + digits);
  return `${(m[1] || m[4]) === "-" && !zero ? "-" : ""}${whole}${dec > 0 ? `.${digits}` : ""}`;
}

/**
 * A value bound as the column's type binds it: CHAR right-trimmed, INTEGER a
 * number, STRING unchanged, a packed number as its decimal string. A field the row does not name is ABAP's initial
 * value (a work area has no NULL); an explicit null is refused.
 */
export function bindValue(value, type) {
  if (value === undefined) return initialValue(type);
  if (value === null) throw new WriteError("a NULL value: an ABAP work area has none");
  if (type?.abap === "INT8") {
    // an INT8 past 2^53 stays a BigInt, which every client binds exactly;
    // a JavaScript number past it is already not the caller's value
    if (typeof value === "bigint") return lit(Number.isSafeInteger(Number(value)) ? Number(value) : value, type);
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new WriteError(`value ${value} is not an INT8 a JavaScript number can carry: pass a BigInt or a string`);
    if (typeof value === "string" && /^ *[+-]?\d+ *$/.test(value)) {
      const b = BigInt(value.trim());
      if (b < -(2n ** 63n) || b >= 2n ** 63n) throw new WriteError(`value ${JSON.stringify(value)} is past INT8`);
      return lit(Number.isSafeInteger(Number(b)) ? Number(b) : b, type);
    }
    if (!Number.isInteger(value)) throw new WriteError(`value ${JSON.stringify(value)} is not an INT8`);
    return lit(value, type);
  }
  if (type?.abap === "I") {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new WriteError(`value ${JSON.stringify(value)} is not an INTEGER`);
    return lit(n, type);
  }
  if (type?.abap === "D") {
    // a date is CHAR 8 of digits, as DATS is on the database; '00000000' is
    // its initial value, and a blank field is the same
    const text = String(value).replace(/ +$/, "");
    if (text === "") return lit("00000000", type);
    if (!/^\d{8}$/.test(text)) throw new WriteError(`value ${JSON.stringify(value)} is not a date of eight digits`);
    return lit(text, type);
  }
  if (type?.abap === "C") {
    const text = String(value).replace(/ +$/, "");
    if (Number.isInteger(type.len) && text.length > type.len) throw new WriteError(`value ${JSON.stringify(value)} is longer than the column's ${type.len}`);
    return lit(text, type);
  }
  if (type?.abap === "STRING") return lit(String(value), type);
  if (type?.abap === "X" || type?.abap === "XSTRING") {
    // measured on A4H (the zvdb agent): what a SET writes to a RAW(n) is cut
    // or padded with 00 to n bytes, never raising; a text goes by ABAP's
    // c -> x rule, the longest prefix of [0-9A-F], an odd count padded with
    // a 0. Upper-case hex is the value at the IR's boundary
    // (ANOMALY-2026-09-24-raw-columns, -c-to-x). Only a text is measured: a
    // number goes to an x by the i -> x rule (12 is 0000000C), not by this
    // one, so it is refused. For an XSTRING only the move was measured, not
    // a write into a RAWSTRING column
    if (typeof value !== "string") throw new WriteError(`value ${JSON.stringify(typeof value === "bigint" ? String(value) : value)} is not a hex text: only a text is moved into a RAW here`);
    const text = value;
    let hex = /^[0-9A-F]*/.exec(text)[0];
    if (hex.length % 2 === 1) hex += "0";
    if (type.abap === "X" && Number.isInteger(type.len)) hex = hex.slice(0, 2 * type.len).padEnd(2 * type.len, "0");
    return lit(hex, type);
  }
  if (type?.abap === "P") return lit(packedText(value, type, "value"), type);
  throw new WriteError(`a column of type ${type?.abap ?? "unknown"} is not written yet`);
}

/** rows of plain values into rows of IR values, by the table's column types */
export function bindRows(columns, schema, rows) {
  return rows.map((row) => columns.map((column) => {
    const key = Object.keys(row).find((k) => upper(k) === upper(column));
    const type = schema[upper(column)];
    if (type === undefined) throw new WriteError(`column ${upper(column)} is not in the table's schema`);
    return bindValue(key === undefined ? undefined : row[key], type);
  }));
}

/**
 * A packed literal a statement writes must be the decimal string of its
 * type, whoever built it: a lit(0.1 + 0.2, P) made by hand, not through
 * bindValue, would be inlined into the text as 0.30000000000000004 (lower
 * renders a number literal as String(n)), and 1e21 as '1e+21'. Checked where
 * values are written (rows, SET, the columns an INSERT FROM selects), not in
 * conditions.
 */
function checkWritten(node) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(checkWritten); return; }
  if (node.node === "lit" && node.type?.abap === "P") {
    if (typeof node.value !== "string" || packedText(node.value, node.type) !== node.value) {
      throw new WriteError(`a packed literal ${JSON.stringify(node.value)} is not the decimal string of P(${node.type.len ?? 31},${node.type.dec ?? 0}): bind it with bindValue`);
    }
    return;
  }
  for (const value of Object.values(node)) checkWritten(value);
}

const DUPLICATES = ["error", "raise", "ignore"];
const checkDuplicates = (onDuplicate) => {
  if (!DUPLICATES.includes(onDuplicate)) throw new WriteError(`onDuplicate ${JSON.stringify(onDuplicate)} is error, raise or ignore`);
};

/** INSERT dbtab FROM wa ("error") / FROM TABLE itab ("raise") / ACCEPTING DUPLICATE KEYS ("ignore") */
/** @param {readonly string[]} columns @param {readonly (readonly import("./sqlscript-types.ts").SqlExpr[])[]} rows */ export const insertRows = (table, columns, rows, {onDuplicate = "error"} = {}) => {
  checkDuplicates(onDuplicate);
  if (rows.length === 0) throw new WriteError("an INSERT with no rows");
  if (rows.some((row) => row.length !== columns.length)) throw new WriteError("a row does not have one value per column");
  checkWritten(rows);
  /** @type {import("./sqlscript-types.ts").SqlInsert} */ const write = {write: "insert", table: upper(table), columns: names(columns), rows, onDuplicate,
    ...(onDuplicate === "raise" ? {expected: rows.length} : {})}; return write;
};
/** INSERT dbtab FROM ( SELECT ... ): a relation whose columns are the table's, in order */
/** @param {readonly string[]} columns @param {import("./sqlscript-types.ts").SqlRelation} rel */ export const insertFrom = (table, columns, rel, {onDuplicate = "error"} = {}) => {
  checkDuplicates(onDuplicate);
  if (rel?.rel === "project") checkWritten((rel.items ?? []).map((item) => item.expr));
  return {write: "insert", table: upper(table), columns: names(columns), from: rel, onDuplicate};
};
/** UPDATE dbtab [AS alias] SET ... WHERE ...; `pred` undefined updates every
 *  row. The alias is the name a correlated subquery in the condition uses. */
/** @param {readonly import("./sqlscript-types.ts").SqlSet[]} set */ export const update = (table, set, pred, alias) => {
  if (set.length === 0) throw new WriteError("an UPDATE that sets nothing");
  checkWritten(set.map((one) => one.expr));
  /** @type {import("./sqlscript-types.ts").SqlUpdate} */ const write = {write: "update", table: upper(table), ...(alias === undefined ? {} : {alias: upper(alias)}),
    set: set.map((one) => {
      /** @type {import("./sqlscript-types.ts").SqlSet} */ const assignment = {col: upper(one.col), expr: one.expr}; return assignment; }), ...(pred === undefined ? {} : {pred})}; return write;
};
/** DELETE FROM dbtab [AS alias] WHERE ...; `pred` undefined deletes every row */
export const remove = (table, pred, alias) => ({write: "delete", table: upper(table),
  ...(alias === undefined ? {} : {alias: upper(alias)}), ...(pred === undefined ? {} : {pred})});
/** UPSERT dbtab [(cols)] SELECT ...: by the primary key, the keys the query
 *  brings updated and the others inserted (measured on HXE) */
/** @param {readonly string[]} columns @param {readonly string[]} key */ export const upsertFrom = (table, columns, rel, key, fill = []) => {
  const cols = names(columns);
  const keys = names(key);
  if (keys.length === 0) throw new WriteError("an UPSERT ... SELECT needs the table's key columns");
  if (keys.some((k) => !cols.includes(k))) throw new WriteError("an UPSERT's key columns must be among its columns");
  checkWritten(fill.map((one) => one.expr));
  return {write: "upsert", table: upper(table), columns: cols, from: rel, key: keys,
    ...(fill.length === 0 ? {} : {fill: fill.map((one) => ({col: upper(one.col), expr: one.expr}))})};
};
/** MODIFY dbtab FROM wa / FROM TABLE itab: insert, or update the row of the same key */
/** `fill`: the columns the statement does not name, with the value an insert
 *  gives them -- measured on HXE: a column left out of an UPSERT keeps its
 *  value when the row is updated and takes its default when it is inserted
 *  (a DDIC table's default is the initial value, which the transpiler's
 *  tables do not declare, so it is written; HANA's own UPSERT needs none) */
/** @param {readonly string[]} columns @param {readonly string[]} key @param {readonly (readonly import("./sqlscript-types.ts").SqlExpr[])[]} rows */ export const upsert = (table, columns, rows, key, fill = []) => {
  const cols = names(columns);
  const keys = names(key);
  if (keys.length === 0) throw new WriteError("a MODIFY needs the table's key columns");
  if (keys.some((k) => !cols.includes(k))) throw new WriteError("a MODIFY's key columns must be among its columns");
  if (rows.length === 0) throw new WriteError("a MODIFY with no rows");
  if (rows.some((row) => row.length !== cols.length)) throw new WriteError("a row does not have one value per column");
  checkWritten(rows);
  // ABAP writes row by row and the last row of a key wins; one statement
  // would differ per engine (SQLite keeps the last, DuckDB the first,
  // PostgreSQL refuses), so the earlier rows of a key are dropped here
  const at = keys.map((k) => cols.indexOf(k));
  const keyOf = (row) => {
    const parts = at.map((i) => row[i]);
    if (parts.some((e) => e?.node !== "lit")) throw new WriteError("a MODIFY row whose key is not a bound value cannot be ordered by key");
    return JSON.stringify(parts.map((e) => e.value));
  };
  // one row needs no ordering by key, and its key may be any expression
  // (`UPSERT t VALUES (:iv, ...) WITH PRIMARY KEY`, the #64 critic)
  const last = rows.length === 1 ? undefined : new Map(rows.map((row, i) => [keyOf(row), i]));
  const kept = rows.length === 1 ? rows : rows.filter((row, i) => last.get(keyOf(row)) === i);
  checkWritten(fill.map((one) => one.expr));
  /** @type {import("./sqlscript-types.ts").SqlUpsert} */ const write = {write: "upsert", table: upper(table), columns: cols, rows: kept, key: keys,
    ...(fill.length === 0 ? {} : {fill: fill.map((one) => ({col: upper(one.col), expr: one.expr}))})}; return write;
};
