// Lowering the relational IR into one engine's dialect.
//
// The whole point of the splitter is that this is the ONLY place a dialect
// is known (docs/sqlscript-splitter.md). The host half - control flow,
// scalars, loops - is JavaScript and never comes here; what arrives is a
// relational subtree, and what leaves is one statement plus its bound
// values, ready for the seam's `native()` (docs/db-seam-native.md).
//
// Values are bound, identifiers are generated: a param becomes a placeholder
// and travels in `params`, and a relation already known to the seam becomes
// whatever `relationRef()` gave us. Nothing is interpolated.
//
// The divergences below are measured, not assumed:
//
//   1 / 2         HANA 0.500000, DuckDB 0.5, sql.js 0
//   -7 / 2        HANA -3.500000, DuckDB -3.5, sql.js -3
//   CAST('x' AS INTEGER)  HANA raises, DuckDB raises, sql.js returns 0
//
// Three more, measured 2026-09-19 against HANA Express when CAST and LIKE
// were added, and every one of them a silent wrong answer rather than an
// error:
//
//   'ABC' LIKE 'abc'          HANA no, DuckDB no, sql.js MATCH
//   CAST('abcdef' AS NVARCHAR(3))   HANA 'abc', DuckDB 'abcdef', sql.js 'abcdef'
//   CAST(1.7 AS INTEGER)      HANA 1, DuckDB 2, sql.js 1
//
// The last one is the uncomfortable one: DuckDB was the engine this file
// trusted to pass casts through, and it ROUNDS where HANA truncates. It had
// been passing casts through since the day the dialect was written. The
// renderings below were then measured back against HANA before being
// written, not reasoned about -- `SUBSTR(CAST(x AS VARCHAR), 1, n)` and
// `CAST(TRUNC(CAST(x AS DOUBLE)) AS INTEGER)` agree with HANA on all six
// probes, including raising on a value that will not convert.
//
// The first line was written the other way round here until the oracle
// answered: this file assumed HANA truncated integer division, and it does
// not - `/` over two INTEGERs yields a decimal. So DuckDB was the engine
// that already matched and the browser engine is the outlier, which is the
// opposite of what the code did. Fixed below, and left on the record,
// because the assumption was plausible, uncontested and wrong.
//
// So division and casts have a per-dialect rendering rather than a
// pass-through, and a dialect that cannot express one refuses instead of
// approximating. Refusing is a feature: an engine that quietly returns a
// different number is the failure this project has already paid for twice.

export const DIALECTS = {
  hana: {
    quote: (id) => `"${id.replace(/"/g, '""')}"`,
    // HANA infers a bare `?` from its immediate context. In `? || ?` that
    // makes an INTEGER host value a string parameter, while the same value
    // in `? * ?` is numeric; node-hdb then rejects the number before HANA can
    // apply SQLScript's implicit conversion. Carry the IR type into numeric
    // placeholders so one captured scalar keeps one meaning in every use.
    placeholder: (_n, type) => {
      const code = String(type ?? "").toUpperCase();
      if (/^[IBS](?:\(|$)/.test(code)) return "CAST(? AS INTEGER)";
      if (/^F(?:\(|$)/.test(code)) return "CAST(? AS DOUBLE)";
      if (/^P\(\d+,\d+\)$/.test(code)) return `CAST(? AS DECIMAL${code.slice(1)})`;
      return "?";
    },
    // `/` yields a decimal even over two INTEGERs - measured, not assumed
    divide: (a, b) => `(${a} / ${b})`,
    // and when the source asked for integer division, it says so
    intDiv: (a, b) => `DIV(${a}, ${b})`,
    /** @param {readonly string[]} args */ concat: (args) => args.join(" || "),
    ifnull: (a, b) => `IFNULL(${a}, ${b})`,
    substr: (s, from, len) => `SUBSTRING(${s}, ${from}${len === undefined ? "" : `, ${len}`})`,
    castInt: (e) => `CAST(${e} AS INTEGER)`,
    castChar: (e, n) => `CAST(${e} AS NVARCHAR(${n}))`,
    castDec: (e, n, s) => `CAST(${e} AS DECIMAL(${n}, ${s}))`,
    // HANA's own, so they pass through -- they are the reference the two
    // renderings below were measured against
    substrBefore: /** @param {() => string} s @param {() => string} x */ (s, x) => `SUBSTR_BEFORE(${s()}, ${x()})`,
    substrAfter: /** @param {() => string} s @param {() => string} x */ (s, x) => `SUBSTR_AFTER(${s()}, ${x()})`,
    toChar: /** @param {() => string} x */ (x) => `TO_NVARCHAR(${x()})`,
    locate: /** @param {() => string} s @param {() => string} x */ (s, x) => `LOCATE(${s()}, ${x()})`,
    // case-sensitive, which is the reference the other two are measured against
    like: (e, p, esc, neg) => `(${e}${neg ? " NOT" : ""} LIKE ${p}${esc === undefined ? "" : ` ESCAPE ${esc}`})`,
    aggName: () => "STRING_AGG",
    dummy: "DUMMY",
  },
  // PostgreSQL is deliberately a separate dialect rather than an alias for
  // DuckDB. The two happen to share a lot of spelling, but not their value
  // rules: INTEGER / INTEGER truncates here and is decimal in HANA, while
  // placeholders are numbered. Only the operations below are claimed; a
  // HANA-specific function still reaches the common refusal below.
  postgres: {
    // Adding a dialect must not silently widen the three-engine PORTABLE
    // allowlist. Functions enter this set only after PostgreSQL has a
    // value-level conformance row. The first AMDP slice needs operators, not
    // built-ins, so an empty set is the honest initial capability.
    functions: new Set(),
    quote: (id) => `"${id.replace(/"/g, '""')}"`,
    placeholder: (n, type) => {
      const code = String(type ?? "").toUpperCase();
      let pg;
      if (/^[IBS](?:\(|$)/.test(code)) pg = "integer";
      else if (/^F(?:\(|$)/.test(code)) pg = "double precision";
      else if (/^P\(\d+,\d+\)$/.test(code)) pg = `numeric${code.slice(1)}`;
      else if (/^C\(\d+\)$/.test(code)) pg = `varchar${code.slice(1)}`;
      else if (code === "STRING") pg = "text";
      // a RAW(n) is its 2n upper-case hex digits, as the transpiler's schema
      // stores it (NCHAR(2n)), bound as that text
      else if (/^X\(\d+\)$/.test(code)) pg = `varchar(${2 * Number(code.slice(2, -1))})`;
      else throw new Refused(`the ABAP type ${code || "(missing)"} has no PostgreSQL parameter type`);
      return `$${n}::${pg}`;
    },
    divide: (a, b) => `(CAST(${a} AS NUMERIC) / CAST(${b} AS NUMERIC))`,
    intDiv: (a, b) => `CAST(TRUNC(CAST(${a} AS NUMERIC) / CAST(${b} AS NUMERIC)) AS INTEGER)`,
    /** @param {readonly string[]} args */ concat: (args) => args.join(" || "),
    ifnull: (a, b) => `COALESCE(${a}, ${b})`,
    substr: (s, from, len) => `SUBSTRING(${s} FROM ${from}${len === undefined ? "" : ` FOR ${len}`})`,
    // PostgreSQL rounds some numeric-to-integer casts. SQLScript truncates
    // toward zero, so make that step explicit as for DuckDB.
    castInt: (e) => `CAST(TRUNC(CAST(${e} AS NUMERIC)) AS INTEGER)`,
    castChar: (e, n) => `SUBSTRING(CAST(${e} AS VARCHAR) FROM 1 FOR ${n})`,
    castDec: (e, n, s) => `CAST(${e} AS NUMERIC(${n}, ${s}))`,
    substrBefore: /** @param {() => string} s @param {() => string} x */ (s, x) =>
      `CASE WHEN strpos(${s()}, ${x()}) > 0 THEN substr(${s()}, 1, strpos(${s()}, ${x()}) - 1) ELSE '' END`,
    substrAfter: /** @param {() => string} s @param {() => string} x */ (s, x) =>
      `CASE WHEN strpos(${s()}, ${x()}) > 0 THEN substr(${s()}, strpos(${s()}, ${x()}) + length(${x()})) ELSE '' END`,
    toChar: /** @param {() => string} x */ (x) => `CAST(${x()} AS VARCHAR)`,
    locate: /** @param {() => string} s @param {() => string} x */ (s, x) => `strpos(${s()}, ${x()})`,
    // PostgreSQL escapes with a backslash by default, which neither ABAP nor
    // the other engines do: 'a\\%' would mean a literal % there only. ESCAPE ''
    // switches it off, so a pattern means the same on every engine
    like: (e, p, esc, neg) => `(${e}${neg ? " NOT" : ""} LIKE ${p} ESCAPE ${esc === undefined ? "''" : esc})`,
    aggName: () => "string_agg",
    dummy: "(SELECT 1) AS dummy",
  },
  duckdb: {
    quote: (id) => `"${id.replace(/"/g, '""')}"`,
    // A packed value is bound as its decimal string (abap-types bindValue),
    // and a bare `?` bound to a string is VARCHAR here: `A * ?` is a Binder
    // Error, and `? * 2` casts '12.50' to INTEGER and answers 26 (measured
    // by the #55 critic, 2026-09-24). The placeholder says its type, as the
    // HANA and PostgreSQL ones do.
    placeholder: (_n, type) => {
      const code = String(type ?? "").toUpperCase();
      return /^P\(\d+,\d+\)$/.test(code) ? `CAST(? AS DECIMAL${code.slice(1)})` : "?";
    },
    // `/` is floating point here, which is what HANA does too
    divide: (a, b) => `(${a} / ${b})`,
    // HANA raises on division by zero; this engine answers Infinity or NULL
    // depending on the types, which is a different program. It can be made
    // to raise - measured - so it is.
    guardZero: (divided, divisor) => `CASE WHEN (${divisor}) = 0 THEN error('division by zero') ELSE ${divided} END`,
    // `//` is the integer one, for when the source asked for it
    intDiv: (a, b) => `(${a} // ${b})`,
    /** @param {readonly string[]} args */ concat: (args) => args.join(" || "),
    ifnull: (a, b) => `COALESCE(${a}, ${b})`,
    substr: (s, from, len) => `SUBSTRING(${s}, ${from}${len === undefined ? "" : `, ${len}`})`,
    // It raises like HANA on a value that will not convert -- and ROUNDS
    // where HANA truncates, which is the divergence this dialect shipped
    // with. TRUNC through DOUBLE truncates toward zero and still raises.
    castInt: (e) => `CAST(TRUNC(CAST(${e} AS DOUBLE)) AS INTEGER)`,
    // CAST to a character type does not truncate here and does on HANA
    castChar: (e, n) => `SUBSTR(CAST(${e} AS VARCHAR), 1, ${n})`,
    castDec: (e, n, s) => `CAST(${e} AS DECIMAL(${n}, ${s}))`,
    // `SUBSTR_BEFORE` / `SUBSTR_AFTER` are HANA's and exist nowhere else, so
    // they are built out of `instr` and `substr`, which both engines have.
    // The edges were measured rather than assumed: on HANA a miss answers
    // the **empty string** and not NULL, and so does a separator at the very
    // start or the very end. All six probes agree.
    //
    // Note the thunks. Each argument appears three or four times in the text
    // and a rendered argument may be a `?`, so re-using one rendered string
    // would put N placeholders in the statement against one bound value --
    // a statement whose values are out of step with its `?`s, which no
    // engine catches. Calling the thunk once per occurrence pushes one value
    // per placeholder, in the order the text has them.
    substrBefore: /** @param {() => string} s @param {() => string} x */ (s, x) =>
      `CASE WHEN instr(${s()}, ${x()}) > 0 THEN substr(${s()}, 1, instr(${s()}, ${x()}) - 1) ELSE '' END`,
    substrAfter: /** @param {() => string} s @param {() => string} x */ (s, x) =>
      `CASE WHEN instr(${s()}, ${x()}) > 0 THEN substr(${s()}, instr(${s()}, ${x()}) + length(${x()})) ELSE '' END`,
    toChar: /** @param {() => string} x */ (x) => `CAST(${x()} AS VARCHAR)`,
    locate: /** @param {() => string} s @param {() => string} x */ (s, x) => `instr(${s()}, ${x()})`,
    like: (e, p, esc, neg) => `(${e}${neg ? " NOT" : ""} LIKE ${p}${esc === undefined ? "" : ` ESCAPE ${esc}`})`,
    aggName: () => "string_agg",
    dummy: "(SELECT 1) AS dummy",
  },
  sqlite: {
    quote: (id) => `"${id.replace(/"/g, '""')}"`,
    // SQLite types a parameter by the value bound: node:sqlite binds every
    // JavaScript number as REAL, sql.js any number past int32 as REAL, and an
    // INTEGER read back as text was then '1.0' where HANA gives '1'
    // (measured 2026-09-24). An integer parameter says what it is, as the
    // HANA dialect's already does
    // A packed one is bound as its decimal string, and a text parameter has
    // no affinity outside a bare-column comparison: `"A" + 0 = ?` compared
    // a number with text and matched nothing (the #55 critic). NUMERIC is
    // the nearest this engine has to a decimal.
    placeholder: (_n, type) => {
      const code = String(type ?? "").toUpperCase();
      if (/^(?:[IBS](?:\(|$)|INT8$)/.test(code)) return "CAST(? AS INTEGER)";
      if (/^P(?:\(|$)/.test(code)) return "CAST(? AS NUMERIC)";
      return "?";
    },
    // `/` over two integers truncates here and does NOT on HANA, so a
    // decimal division has to be forced. This is the typed rewrite the
    // conformance table found, and it exists only for this engine.
    divide: (a, b) => `((${a}) * 1.0 / (${b}))`,
    // **No guardZero here, and it is a decision rather than an omission.**
    // This engine cannot raise at all, so faithfulness to HANA on division
    // by zero would mean refusing division outright - and division is in
    // ordinary bodies everywhere, while a zero divisor is rare. Refusing a
    // common operator to be exact about a rare case would cost far more
    // coverage than it buys fidelity. So: division by zero answers NULL
    // here where HANA raises, it is written down, and the conformance table
    // keeps measuring it.
    intDiv: (a, b) => `(${a} / ${b})`,
    /** @param {readonly string[]} args */ concat: (args) => args.join(" || "),
    ifnull: (a, b) => `IFNULL(${a}, ${b})`,
    substr: (s, from, len) => `SUBSTR(${s}, ${from}${len === undefined ? "" : `, ${len}`})`,
    // SQLite's CAST never raises: 'x' becomes 0, which is a DIFFERENT
    // program. There is no expression that makes it raise, so this dialect
    // declines the node rather than returning a wrong number quietly.
    castInt: () => {
      throw new Refused("CAST to INTEGER cannot raise in SQLite: it returns 0 where HANA and DuckDB raise");
    },
    // no truncation here either, and SQLite has no TRUNC to borrow
    castChar: (e, n) => `SUBSTR(CAST(${e} AS VARCHAR), 1, ${n})`,
    // **SQLite has no decimal type at all.** A DECIMAL(15,2) column is
    // NUMERIC, which is binary floating point, so 0.10 + 0.20 answers
    // 0.30000000000000004 where HANA and DuckDB answer 0.30. It is the one
    // row of the conformance table that nothing addressed, and the most
    // dangerous of them: it does not raise, it does not return a different
    // kind of thing, it returns a number that is nearly right, and a body
    // that compares it or sums it over a thousand rows is wrong quietly.
    //
    // The result type says what the scale is -- the same premise the
    // division above rests on -- so the arithmetic is rounded back to it.
    // Only `+` has an oracle row behind it (`dec_arith`). `-` shares its
    // scale rule and rides on the same measurement; `*` does NOT and is
    // deliberately left alone -- see the call site.
    decArith: (e, scale) => `ROUND(${e}, ${scale})`,
    // SQLite's LIKE is case-INSENSITIVE for ASCII unless the connection says
    // otherwise, and HANA's is not. The shared connection setup registers
    // case-sensitive LIKE, which survives transactions (measured), so the
    // two SQLite native channels set it when they open rather than every
    // statement carrying a workaround. A dialect cannot check a pragma from
    // here, which is why this reads as a pass-through and the guarantee lives
    // at the connection: tools/sqljs-native.mjs and tools/sqlite-file-client.mjs.
    // `SUBSTR_BEFORE` / `SUBSTR_AFTER` are HANA's and exist nowhere else, so
    // they are built out of `instr` and `substr`, which both engines have.
    // The edges were measured rather than assumed: on HANA a miss answers
    // the **empty string** and not NULL, and so does a separator at the very
    // start or the very end. All six probes agree.
    //
    // Note the thunks. Each argument appears three or four times in the text
    // and a rendered argument may be a `?`, so re-using one rendered string
    // would put N placeholders in the statement against one bound value --
    // a statement whose values are out of step with its `?`s, which no
    // engine catches. Calling the thunk once per occurrence pushes one value
    // per placeholder, in the order the text has them.
    substrBefore: /** @param {() => string} s @param {() => string} x */ (s, x) =>
      `CASE WHEN instr(${s()}, ${x()}) > 0 THEN substr(${s()}, 1, instr(${s()}, ${x()}) - 1) ELSE '' END`,
    substrAfter: /** @param {() => string} s @param {() => string} x */ (s, x) =>
      `CASE WHEN instr(${s()}, ${x()}) > 0 THEN substr(${s()}, instr(${s()}, ${x()}) + length(${x()})) ELSE '' END`,
    toChar: /** @param {() => string} x */ (x) => `CAST(${x()} AS VARCHAR)`,
    locate: /** @param {() => string} s @param {() => string} x */ (s, x) => `instr(${s()}, ${x()})`,
    like: (e, p, esc, neg) => `(${e}${neg ? " NOT" : ""} LIKE ${p}${esc === undefined ? "" : ` ESCAPE ${esc}`})`,
    // SQLite calls it group_concat, and takes the ORDER BY inside it
    aggName: () => "group_concat",
    dummy: "(SELECT 1) AS dummy",
  },
};

import {seamType} from "./sqlscript-ir.mjs";

/** Functions that mean the same thing on HANA, DuckDB and SQLite.
 *
 *  Short on purpose. Membership is a claim, and the claim is "the same
 *  arguments give the same answer on all three" -- not "all three have a
 *  function with this name", which is how a portability hole gets written by
 *  somebody being helpful. `ROUND` and `LOCATE` are deliberately absent:
 *  they exist everywhere and their tie rule and argument order have not been
 *  measured here. */
/** Aggregates that concatenate, which each engine spells differently and all
 *  three order identically once told to (measured 2026-09-19: `a,b,c` and
 *  `c,b,a` on HANA, DuckDB and sql.js alike).
 *
 *  **Without an ORDER BY the result is unspecified on every one of them**, so
 *  two runs agreeing proves nothing about the third. `effects()` marks an
 *  unordered one non-deterministic for exactly that reason. */
const AGGREGATES = new Set(["STRING_AGG", "GROUP_CONCAT"]);

/** Ranking functions, which exist only with an `OVER` clause and whose tie
 *  behaviour was measured rather than recalled: RANK leaves a gap after a
 *  tie and DENSE_RANK does not, identically on all three. */
const WINDOW = new Set(["ROW_NUMBER", "RANK", "DENSE_RANK"]);

export const PORTABLE = new Set([
  "LOWER", "UPPER", "LENGTH", "ABS", "COALESCE", "TRIM", "LTRIM", "RTRIM",
  "SUM", "MIN", "MAX", "COUNT", "AVG",
  // measured 2026-09-19: ROUND(2.5) is 3 and ROUND(-2.5) is -3 on all three,
  // and the two-argument form agrees too. It was kept out of this list until
  // it had been asked, which is the rule the list exists for.
  "ROUND",
]);

export class Refused extends Error {}

// HANA sorts NULL as the smallest value: first ascending, last descending
// (measured on HXE 2.00.088, 2026-09-24: ORDER BY v gives N,1,2 and ORDER BY
// v DESC gives 2,1,N). PostgreSQL and DuckDB put NULL last ascending by
// default, so the placement is written out on every engine rather than
// left to each one's default
/** @param {(typeof DIALECTS)[keyof typeof DIALECTS]} d @param {import("./sqlscript-types.ts").SqlOrder} k */ const orderKey = (d, k) => `${d.quote(k.col)} ${k.desc ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`;

export function lower(rel, dialectName, options = {}) {
  const d = DIALECTS[dialectName];
  if (d === undefined) throw new Refused(`no dialect ${dialectName}`);
  const params = [];
  const hostPreds = [];
  const refOf = options.relationRef ?? ((handle) => handle);

  const expr = (e) => {
    // A missing or shapeless node is refused by name, not dereferenced. A
    // TypeError here says "Cannot read properties of undefined (reading
    // 'node')", which names the line that fell over rather than the thing
    // that was wrong, and a histogram of such messages is a histogram of
    // where walkers stand - measured across both halves of this project on
    // 2026-09-19 and fixed in both.
    if (e === undefined || e === null || e.node === undefined) {
      throw new Refused(`an expression arrived without a node kind: ${JSON.stringify(e)?.slice(0, 60)}`);
    }
    switch (e.node) {
      case "col": return e.source === undefined
        ? d.quote(e.name) : `${d.quote(e.source)}.${d.quote(e.name)}`;
      case "lit":
        if (typeof e.value === "number") return String(e.value);
        // a string literal still goes through a parameter: a literal in the
        // text is the class of defect this contract exists to remove
        params.push({name: `p${params.length}`, value: e.value, type: seamType(e.type), isNull: e.value == null});
        return d.placeholder(params.length, seamType(e.type));
      case "param":
        params.push({name: e.name, value: e.value, type: seamType(e.type), isNull: e.isNull});
        return d.placeholder(params.length, seamType(e.type));
      case "hostPred": {
        // a predicate the host supplies at run time (tools/ir-ranges.mjs):
        // a marker, not a parameter, so the build-time text keeps its own
        // placeholders in order and the host splices its own in
        if (!/^[A-Za-z0-9_]+$/.test(String(e.id))) throw new Refused(`host predicate id ${JSON.stringify(e.id)} is not a plain name`);
        hostPreds.push({id: e.id, column: e.column, columnType: e.columnType, ...(e.kind === undefined ? {} : {kind: e.kind}), after: params.length});
        return `/*@range:${e.id}*/`;
      }
      case "session":
        throw new Refused(`session value ${e.kind} ${e.name} was not captured by the procedure runtime`);
      case "bin": {
        const left = expr(e.left);
        const right = expr(e.right);
        if (e.op === "/") {
          // The result type decides which of the two divisions this is, and
          // it is the reason every node carries one: plain `/` in SQLScript
          // yields a decimal, and only an explicitly integer result means
          // the truncating operator.
          //
          // `guardZero` renders the divisor a SECOND time, deliberately:
          // rendering an operand is what PUSHES its bound values, so an
          // expression that mentions it twice has to render it twice or it
          // will carry two placeholders for one value. Reusing the string
          // would look tidier and be wrong, and neither the engine nor a
          // check on the text would say so.
          const divided = e.type?.abap === "I" ? d.intDiv(left, right) : d.divide(left, right);
          return d.guardZero === undefined ? divided : d.guardZero(divided, expr(e.right));
        }
        const rendered = `(${left} ${e.op} ${right})`;
        // a decimal result on an engine that has no decimals
        // **`+` and `-` only, and the exclusion of `*` is the interesting
        // half.** For addition HANA's result scale is the operands' own, so
        // rounding back to the declared scale restores exactly what it would
        // have answered. For multiplication the result scale is s1 + s2:
        // 0.15 * 0.15 is 0.0225 on HANA, and rounding that to the declared 2
        // would answer 0.02. The IR now types a product s1 + s2 as HANA does
        // (docs/sqlscript-hana-observed.md, "Decimal arithmetic"; dec_mult in
        // the conformance table), so the rounding is exact for it too, and it
        // is needed: SQLite's product of two REALs is 2.4180249999999997 for
        // 1.555 * 1.555, where HANA answers 2.418025.
        if (d.decArith !== undefined && e.type?.abap === "P" && e.type.dec !== undefined
            && (e.op === "+" || e.op === "-" || e.op === "*")) {
          return d.decArith(rendered, Number(e.type.dec));
        }
        return rendered;
      }
      case "cast":
        if (e.type?.abap === "I") return d.castInt(expr(e.expr));
        if (e.type?.abap === "C" && e.type.len !== undefined) return d.castChar(expr(e.expr), Number(e.type.len));
        if (e.type?.abap === "P" && e.type.len !== undefined && e.type.dec !== undefined && d.castDec !== undefined) {
          const exactInteger = e.expr?.type?.abap === "I" && ["hana", "duckdb"].includes(dialectName);
          const unchangedPacked = e.expr?.type?.abap === "P" && e.expr.type.dec === e.type.dec;
          if (!exactInteger && !unchangedPacked) {
            throw new Refused("decimal cast requires INTEGER or a packed-decimal source with unchanged scale");
          }
          return d.castDec(expr(e.expr), Number(e.type.len), Number(e.type.dec));
        }
        throw new Refused(`cast to ${JSON.stringify(e.type)} not lowered yet`);
      case "isnull": return `(${expr(e.expr)} IS NULL)`;
      case "not": return `(NOT ${expr(e.expr)})`;
      case "like":
        return d.like(expr(e.expr), expr(e.pattern), e.escape === undefined ? undefined : expr(e.escape), e.negated);
      case "in":
        return `(${expr(e.expr)}${e.negated ? " NOT" : ""} IN (${e.values.map(expr).join(", ")}))`;
      case "sub": {
        // The subquery is rendered **where it appears**, so its own bound
        // values land in `params` in the order the text has them. Building it
        // anywhere else would be the one way to get a statement whose
        // placeholders and values are out of step, which no engine catches
        // and no test that checks the text would either.
        const inner = select(e.rel);
        if (e.kind === "exists") return `(${e.negated ? "NOT " : ""}EXISTS (${inner}))`;
        if (e.kind === "in") return `(${expr(e.expr)}${e.negated ? " NOT" : ""} IN (${inner}))`;
        return `(${inner})`;
      }
      case "case": {
        const whens = e.whens.map((w) => `WHEN ${expr(w.when)} THEN ${expr(w.then)}`).join(" ");
        const other = e.otherwise === undefined ? "" : ` ELSE ${expr(e.otherwise)}`;
        return `(CASE ${whens}${other} END)`;
      }
      case "call": {
        if (e.fn === "BITXOR") {
          if (e.args.length !== 2) throw new Refused("BITXOR requires two arguments");
          if (dialectName === "hana") return `BITXOR(${expr(e.args[0])}, ${expr(e.args[1])})`;
          if (dialectName === "duckdb") {
            // The ABAP database seam stores fixed RAW as its canonical hex
            // text (the same representation Open SQL reads and writes), not
            // as a driver-specific Buffer. Decode that physical form before
            // using DuckDB's exact BIT xor. A nested BITXOR is already BIT.
            const bit = (arg) => arg.node === "call" && arg.fn === "BITXOR"
              ? `CAST(${expr(arg)} AS BIT)` : `CAST(from_hex(${expr(arg)}) AS BIT)`;
            return `xor(${bit(e.args[0])}, ${bit(e.args[1])})`;
          }
          throw new Refused(`BITXOR has no measured rendering on ${dialectName}`);
        }
        if (e.fn === "BITCOUNT") {
          if (e.args.length !== 1) throw new Refused("BITCOUNT requires one argument");
          if (dialectName === "hana") return `BITCOUNT(${expr(e.args[0])})`;
          if (dialectName === "duckdb") {
            const arg = e.args[0];
            const value = arg.node === "call" && arg.fn === "BITXOR"
              ? expr(arg) : `from_hex(${expr(arg)})`;
            return `bit_count(CAST(${value} AS BIT))`;
          }
          throw new Refused(`BITCOUNT has no measured rendering on ${dialectName}`);
        }
        if (e.fn === "REGEXP_REPLACE_ALL") {
          if (e.args.length !== 3) throw new Refused("REGEXP_REPLACE_ALL requires subject, pattern and replacement");
          if (e.args[0]?.node !== "col" || e.args[1]?.node !== "lit" || e.args[1].value !== "x"
              || e.args[2]?.node !== "lit" || e.args[2].value !== "") {
            throw new Refused("REGEXP_REPLACE_ALL is measured only for a column subject, literal 'x', and empty replacement");
          }
          if (dialectName === "hana") {
            // HANA's textual order is pattern, subject, replacement, so
            // render in exactly that order: rendering pushes bound values.
            return `REPLACE_REGEXPR(${expr(e.args[1])} IN ${expr(e.args[0])} WITH ${expr(e.args[2])} OCCURRENCE ALL)`;
          }
          if (dialectName === "duckdb") {
            return `REGEXP_REPLACE(${expr(e.args[0])}, ${expr(e.args[1])}, ${expr(e.args[2])}, 'g')`;
          }
          throw new Refused(`REGEXP_REPLACE_ALL has no measured rendering on ${dialectName}`);
        }
        if (d.functions instanceof Set && !d.functions.has(e.fn)) {
          throw new Refused(`the function ${e.fn} has not been measured on ${dialectName}`);
        }
        // **Rendering an argument is not free: it pushes that argument's
        // bound values.** So the arguments are rendered exactly as many
        // times as they appear in the text, and never before it is known how
        // many that will be. Mapping them up front (which is what this did)
        // put two values behind one `?` the moment a rendering used an
        // argument twice -- a statement whose values are out of step with
        // its placeholders, which no engine catches and no assertion about
        // the text would either.
        const arg = (i) => () => expr(e.args[i]);
        // the ones whose rendering repeats an argument take thunks
        if (e.fn === "SUBSTR_BEFORE") return d.substrBefore(arg(0), arg(1));
        if (e.fn === "SUBSTR_AFTER") return d.substrAfter(arg(0), arg(1));
        if (e.fn === "TO_NVARCHAR" || e.fn === "TO_VARCHAR") return d.toChar(arg(0));
        if (e.fn === "LOCATE") return d.locate(arg(0), arg(1));
        // and the rest use each argument once, so one rendering is right.
        // `COUNT(*)` carries no argument expression at all: the star is the
        // argument. Returning early for it was the first attempt and it
        // dropped the OVER clause, because everything after this line is
        // what renders a window.
        const args = e.star === true && e.args.length === 0 ? ["*"] : e.args.map(expr);
        if (e.fn === "CONCAT") return `(${d.concat(args)})`;
        if (e.fn === "IFNULL") return d.ifnull(args[0], args[1]);
        if (e.fn === "SUBSTR" || e.fn === "SUBSTRING") return d.substr(args[0], args[1], args[2]);
        if (e.fn === "TO_INTEGER" || e.fn === "TO_INT") return d.castInt(args[0]);
        // **The window, rendered after the call and identically on all
        // three.** Measured 2026-09-19: ROW_NUMBER, RANK, DENSE_RANK and an
        // aggregate over a partition answer the same on HANA, DuckDB and
        // sql.js, ties included. A frame clause is not rendered because
        // nobody has measured one -- the name of a construct being familiar
        // is not the same as its behaviour being known.
        const over = (w) => {
          if (w === undefined) return "";
          const parts = [];
          if (w.partitionBy.length > 0) parts.push(`PARTITION BY ${w.partitionBy.map(expr).join(", ")}`);
          if (w.orderBy.length > 0) {
            parts.push(`ORDER BY ${w.orderBy.map((k) => orderKey(d, k)).join(", ")}`);
          }
          return ` OVER (${parts.join(" ")})`;
        };
        if (WINDOW.has(e.fn)) {
          if (e.window === undefined) throw new Refused(`${e.fn} is a window function and this call has no OVER clause`);
          return `${e.fn}(${args.join(", ")})${over(e.window)}`;
        }
        if (PORTABLE.has(e.fn) || AGGREGATES.has(e.fn)) {
          const name = AGGREGATES.has(e.fn) ? d.aggName(e.fn) : e.fn;
          const ordering = (e.orderBy ?? []).length === 0 ? ""
            : ` ORDER BY ${e.orderBy.map((k) => orderKey(d, k)).join(", ")}`;
          return `${name}(${args.join(", ")}${ordering})${over(e.window)}`;
        }
        // **An unknown function is refused, not rendered.**
        //
        // This used to pass any name straight through, which is the same
        // mistake as passing a cast through to DuckDB and for once the
        // corpus made it visible: `SUBSTR_BEFORE`, `SUBSTR_AFTER`, `MAP`,
        // `TO_NVARCHAR`, `SESSION_CONTEXT` are HANA's, and on DuckDB they
        // raise "Scalar Function ... does not exist". Raising is the LUCKY
        // half. The other half is a name that exists on both engines and
        // means something slightly different -- `LOCATE`'s argument order,
        // `ROUND`'s tie rule, `TO_DATE`'s format string -- and that one
        // answers a number instead of an error.
        //
        // `PORTABLE` is therefore a list of functions whose meaning is the
        // same on all three, not a list of functions that exist. A name is
        // added to it by measuring, the way division and casts were.
        throw new Refused(`the function ${e.fn} has no measured rendering on ${dialectName}: ` +
          "it is either HANA's own, or it exists on both engines and may not mean the same thing");
      }
      default: throw new Refused(`expression ${e.node} not lowered`);
    }
  };

  // A relation becomes a SELECT; an input that is itself a relation becomes a
  // subquery. That is how a chain of assignments ends up as ONE statement:
  // the chain is nesting, not sequence, because HANA says an assignment is
  // not a barrier.
  let alias = 0;
  const from = (r) => {
    if (r.rel === "var") return select(r); // refuses, with the right message
    if (r.rel === "alias") return `(${select(r.input)}) AS ${d.quote(r.name)}`;
    if (r.rel === "scan") return String(r.table).toUpperCase() === "DUMMY" ? d.dummy : d.quote(r.table);
    if (r.rel === "ref") return refOf(r.handle);
    if (r.rel === "tfcall") return tableFunctionFrom(r);
    return `(${select(r)}) AS ${d.quote(`t${alias++}`)}`;
  };

  /** A table function called in FROM. Only HANA has the callee as an object
   *  of that name; every other dialect refuses until the callee is compiled
   *  for it (the DuckDB table-macro route is being measured, 2026-09-23). A
   *  table-valued argument is refused everywhere: on HANA it has to be a
   *  table variable, which this SQL does not have. */
  const tableFunctionFrom = (r) => {
    if (dialectName !== "hana") {
      throw new Refused(`the table function ${r.name} is not compiled for ${dialectName}: only HANA has it as an object of that name`);
    }
    const args = r.args.map((arg) => {
      if (arg.kind === "relation") {
        throw new Refused(`a table-valued argument to ${r.name} is not lowered yet: on HANA it must be a table variable, which one statement does not have`);
      }
      return expr(arg.expr);
    });
    return `${d.quote(r.name)}(${args.join(", ")})`;
  };

  const joinFrom = (r) => {
    const kind = r.kind.toUpperCase();
    if (kind === "CROSS" && r.on !== undefined) throw new Refused("a CROSS JOIN carries no ON condition");
    if (kind !== "CROSS" && r.on === undefined) {
      throw new Refused(`a ${kind} JOIN without an ON condition is a cross join written by accident, not a join`);
    }
    const left = r.left?.rel === "join" ? joinFrom(r.left) : from(r.left);
    const right = r.right?.rel === "join" ? `(${joinFrom(r.right)})` : from(r.right);
    // Render in textual order. Expressions append their bound values while
    // rendering, so doing ON before the two sources would put its values at
    // the front of the parameter array although its placeholders occur last.
    const on = r.on === undefined ? "" : ` ON ${expr(r.on)}`;
    return `${left} ${kind} JOIN ${right}${on}`;
  };

  const projectionItems = (r) => r.items.map((i) => `${expr(i.expr)} AS ${d.quote(i.as)}`).join(", ");
  const limitCount = (value) => {
    if (dialectName === "hana" && value?.node === "param") {
      // HANA accepts a bound scalar in LIMIT but rejects CAST(? AS INTEGER)
      // in this grammar slot. The driver still receives the IR's INTEGER
      // type; only the SQL spelling is context-specific.
      params.push({name: value.name, value: value.value, type: seamType(value.type), isNull: value.isNull});
      return "?";
    }
    return typeof value === "number" ? String(value) : expr(value);
  };

  const select = (r) => {
    if (r === undefined || r === null || r.rel === undefined) {
      throw new Refused(`a relation arrived without a rel kind: ${JSON.stringify(r)?.slice(0, 60)}`);
    }
    // the parts each kind cannot do without, checked before they are read
    // A CROSS JOIN has no predicate by definition, so demanding `on` of
    // every join refused the very idiom the corpus uses most (60 bodies) -
    // caught by its own test, which is what that test is for.
    const needs = {filter: ["pred"], project: ["items"],
                   join: r.kind === "cross" ? ["left", "right"] : ["left", "right", "on"],
                   union: ["inputs"], aggregate: ["groupBy", "aggs"], order: ["keys"], limit: ["n"]};
    for (const key of needs[r.rel] ?? []) {
      if (r[key] === undefined) throw new Refused(`a ${r.rel} arrived without its ${key}`);
    }
    switch (r.rel) {
      case "var":
        // deliberately not lowered: see varRef() in sqlscript-ir.mjs. Getting
        // here means the binder did not run, and quietly treating the name as
        // a table would read a database table with the same name - which is
        // an ordinary thing to exist.
        throw new Refused(`the table variable :${r.name} reached the lowering unresolved - the binder must inline it or point it at a materialised relation`);
      case "scan":
      case "ref":
      case "alias":
      case "tfcall":
        return `SELECT * FROM ${from(r)}`;
      case "filter":
        // **A filter over an aggregate is a HAVING, and has to be rendered
        // as one.** Wrapped, it came out as `SELECT * FROM (… GROUP BY k)
        // WHERE SUM(n) > 1` -- and `SUM(n)` is not a column of that
        // subquery, it is aliased in it, so the statement is invalid. The
        // same shape as the ORDER BY defect two commits ago: a clause of the
        // select rendered as a wrapper around it.
        if (r.input?.rel === "aggregate") {
          return `${select(r.input)} HAVING ${expr(r.pred)}`;
        }
        if (r.input?.rel === "join") {
          return `SELECT * FROM ${joinFrom(r.input)} WHERE ${expr(r.pred)}`;
        }
        return `SELECT * FROM ${from(r.input)} WHERE ${expr(r.pred)}`;
      case "project":
        if (r.input?.rel === "filter") {
          const items = projectionItems(r);
          const source = r.input.input?.rel === "join" ? joinFrom(r.input.input) : from(r.input.input);
          return `SELECT ${r.distinct === true ? "DISTINCT " : ""}${items} ` +
            `FROM ${source} WHERE ${expr(r.input.pred)}`;
        }
        // A qualified projection belongs to the same query block as its
        // JOIN. Wrapping the JOIN first would hide its source aliases and
        // turn an ordinary `SELECT L.K FROM A L JOIN B R ...` into an outer
        // query that still refers to L although L is no longer in scope.
        if (r.input?.rel === "join") {
          const items = projectionItems(r);
          return `SELECT ${r.distinct === true ? "DISTINCT " : ""}${items} FROM ${joinFrom(r.input)}`;
        }
        return `SELECT ${r.distinct === true ? "DISTINCT " : ""}` +
          `${projectionItems(r)} FROM ${from(r.input)}`;
      case "join": {
        return `SELECT * FROM ${joinFrom(r)}`;
      }
      case "union":
        if (r.inputs.some((one) => one?.rel === "except" || (one?.rel === "union" && one.all !== r.all))) {
          throw new Refused("nested set operations require measured parenthesized lowering");
        }
        return r.inputs.map(select).join(r.all ? " UNION ALL " : " UNION ");
      case "except":
        if (!["hana", "duckdb"].includes(dialectName)) {
          throw new Refused(`EXCEPT has no measured rendering on ${dialectName}`);
        }
        if (r.inputs?.length !== 2) throw new Refused("EXCEPT requires exactly two branches");
        if (r.inputs.some((one) => one?.rel === "union" || one?.rel === "except")) {
          throw new Refused("nested set operations require measured parenthesized lowering");
        }
        return `${select(r.inputs[0])} EXCEPT ${select(r.inputs[1])}`;
      case "aggregate": {
        const keys = r.groupBy.map((c) => d.quote(c));
        const aggs = r.aggs.map((a) => `${expr(a.expr)} AS ${d.quote(a.as)}`);
        const group = keys.length === 0 ? "" : ` GROUP BY ${keys.join(", ")}`;
        return `SELECT ${[...keys, ...aggs].join(", ")} FROM ${from(r.input)}${group}`;
      }
      case "order": {
        // **ORDER BY is a clause of the SELECT, not a wrapper around it.**
        //
        // Wrapping produced `SELECT * FROM (SELECT f(k) AS v FROM t) ORDER BY
        // k` -- and `k` is not a column of that subquery, so the engine
        // refuses it. In SQL the ordering is evaluated over the **input** of
        // the select, which is why `SELECT f(k) AS v FROM t ORDER BY k` is
        // ordinary and legal. So a projection underneath is folded in rather
        // than nested, which is what the source said in the first place.
        //
        // The alternative -- ordering first and projecting after -- would
        // rest on row order surviving a projection, which no standard
        // promises and which is exactly the kind of assumption this file
        // exists to avoid.
        const keys = r.keys.map((k) => orderKey(d, k)).join(", ");
        const inner = r.input;
        if (inner?.rel === "project") {
          // Reuse the projection's whole query block. Reconstructing its
          // FROM here used to wrap a JOIN and hide L/R while the SELECT list
          // still named L.K; LIMIT above this ORDER inherited the same bad
          // SQL. ORDER BY can be appended directly to the SELECT it orders.
          return `${select(inner)} ORDER BY ${keys}`;
        }
        return `SELECT * FROM ${from(inner)} ORDER BY ${keys}`;
      }
      case "limit":
        // the same reason: LIMIT belongs to the select it limits, and
        // wrapping an ordered select in an unordered one is a second defect
        // of the same family waiting to be found
        {
          if (r.input?.rel === "order" || r.input?.rel === "project") {
            const input = select(r.input);
            const count = limitCount(r.n);
            return `${input} LIMIT ${count}`;
          }
          const input = from(r.input);
          const count = limitCount(r.n);
          return `SELECT * FROM ${input} LIMIT ${count}`;
        }
      default: throw new Refused(`relation ${r.rel} not lowered`);
    }
  };

  // writes (tools/ir-writes.mjs): the same expr() renders their values and
  // conditions, so their placeholders and params come in text order
  const writeStatement = (w) => {
    const table = d.quote(w.table);
    // the target's alias, which a correlated subquery in the condition names
    const target = w.alias === undefined ? table : `${table} AS ${d.quote(w.alias)}`;
    const cols = (list) => `(${list.map((c) => d.quote(c)).join(", ")})`;
    const values = (rows) => rows.map((row) => `(${row.map(expr).join(", ")})`).join(", ");
    // HANA takes one VALUES row; several go as a SELECT ... FROM DUMMY union
    const hanaRows = (rows) => rows.map((row) => `SELECT ${row.map(expr).join(", ")} FROM DUMMY`).join(" UNION ALL ");
    // a function, called where the WHERE stands in the text: rendering it
    // earlier would push its params before the SET's (a bug caught by
    // printing params next to the text, 2026-09-23)
    const where = () => (w.pred === undefined ? "" : ` WHERE ${expr(w.pred)}`);
    if (w.write === "insert") {
      // "raise" writes what it can and the host raises after (A4H's INSERT
      // FROM TABLE), so it renders as the skipping INSERT
      const skip = w.onDuplicate === "ignore" || w.onDuplicate === "raise";
      if (skip && dialectName === "hana") {
        throw new Refused("INSERT that skips duplicate keys is not rendered for hana yet");
      }
      const ignore = skip ? " ON CONFLICT DO NOTHING" : "";
      if (w.from !== undefined) {
        // SQLite reads `... FROM t ON CONFLICT` as a join constraint: the
        // select goes into a derived table with a WHERE of its own first
        const from = skip && dialectName === "sqlite" ? `SELECT * FROM (${select(w.from)}) WHERE true` : select(w.from);
        return `INSERT INTO ${table} ${cols(w.columns)} ${from}${ignore}`;
      }
      if (dialectName === "hana" && w.rows.length > 1) return `INSERT INTO ${table} ${cols(w.columns)} ${hanaRows(w.rows)}`;
      return `INSERT INTO ${table} ${cols(w.columns)} VALUES ${values(w.rows)}${ignore}`;
    }
    if (w.write === "update") {
      const set = w.set.map((one) => `${d.quote(one.col)} = ${expr(one.expr)}`).join(", ");
      return `UPDATE ${target} SET ${set}${where()}`;
    }
    if (w.write === "delete") return `DELETE FROM ${target}${where()}`;
    if (w.write === "upsert" && w.from !== undefined) {
      if (dialectName === "hana") return `UPSERT ${table} ${cols(w.columns)} ${select(w.from)}`;
      const fill = w.fill ?? [];
      // the named columns only: one left out keeps its value on an update
      const rest = w.columns.filter((c) => !w.key.includes(c));
      const action = rest.length === 0 ? "DO NOTHING"
        : `DO UPDATE SET ${rest.map((c) => `${d.quote(c)} = excluded.${d.quote(c)}`).join(", ")}`;
      // the fill values are rendered before the query they follow in the
      // text's order; SQLite reads `... FROM t ON CONFLICT` as a join
      // constraint, so the source is a derived table with a WHERE of its own
      const fillValues = fill.map((one) => expr(one.expr));
      const source = fill.length === 0
        ? (dialectName === "sqlite" ? `SELECT * FROM (${select(w.from)}) WHERE true` : select(w.from))
        : `SELECT "q".*${fillValues.map((v) => `, ${v}`).join("")} FROM (${select(w.from)}) AS "q"${dialectName === "sqlite" ? " WHERE true" : ""}`;
      return `INSERT INTO ${table} ${cols([...w.columns, ...fill.map((one) => one.col)])} ${source} ON CONFLICT ${cols(w.key)} ${action}`;
    }
    if (w.write === "upsert") {
      if (dialectName === "hana") {
        return w.rows.length === 1
          ? `UPSERT ${table} ${cols(w.columns)} VALUES ${values(w.rows)} WITH PRIMARY KEY`
          : `UPSERT ${table} ${cols(w.columns)} ${hanaRows(w.rows)}`;
      }
      const fill = w.fill ?? [];
      const rest = w.columns.filter((c) => !w.key.includes(c));
      const action = rest.length === 0 ? "DO NOTHING"
        : `DO UPDATE SET ${rest.map((c) => `${d.quote(c)} = excluded.${d.quote(c)}`).join(", ")}`;
      const rows = w.rows.map((row) => [...row, ...fill.map((one) => one.expr)]);
      return `INSERT INTO ${table} ${cols([...w.columns, ...fill.map((one) => one.col)])} VALUES ${values(rows)} ON CONFLICT ${cols(w.key)} ${action}`;
    }
    throw new Refused(`no write ${JSON.stringify(w.write)}`);
  };
  const sql = rel.write !== undefined ? writeStatement(rel) : select(rel);
  return hostPreds.length === 0 ? {sql, params} : {sql, params, hostPreds};
}

/** how many statements this plan will cost - one, unless a barrier says otherwise */
export function statementCount(rel) {
  let n = 1;
  const walk = (r) => {
    if (r === undefined) return;
    if (r.rel === "ref") n += 0; // already materialised, costs nothing here
    for (const key of ["input", "left", "right"]) walk(r[key]);
    for (const one of r.inputs ?? []) walk(one);
  };
  walk(rel);
  return n;
}
