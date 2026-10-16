// The relational half of a SQLScript body, as data.
//
// This is the IR the splitter lowers (docs/sqlscript-splitter.md). It is
// deliberately written and tested BEFORE any parser exists: twenty fixtures
// built by hand answer "can this model express the semantics" for the cost
// of an afternoon, where finding the same answer after a front end exists
// costs a front end. If the model cannot carry it, nothing downstream can.
//
// Two rules the shape follows, both of them measured rather than preferred:
//
//   1. **An assignment to a table variable is not a barrier.** Measured on
//      HANA Express: a projection that would fail does not fail when a later
//      filter removes the offending row, and the same body does fail under
//      NO_INLINE (docs/sqlscript-hana-observed.md). So a chain of assignments
//      is ONE plan here, not three, and `lower()` must produce one statement.
//
//   2. **Every expression carries the type HANA would give it.** Not for
//      documentation: the lowering cannot choose a form without it. `1/2` is
//      0.5 in DuckDB and 0 in SQLite, so a division node that does not know
//      it is integer division has no correct rendering in either.
//
// Nothing here talks to a database. Lowering is in sqlscript-lower.mjs.

/** ABAP-ish type letters, because that is what the caller and the seam speak */
export const T = {
  int: {abap: "I"},
  // INT2: an INTEGER in every expression (HANA promotes SMALLINT arithmetic,
  // measured on A4H), whose range is checked where ABAP meets it -- the input
  // bind and the output boundary (docs/sqlscript-hana-observed.md)
  int2: {abap: "I", bits: 16},
  int8: {abap: "INT8"},
  /** @param {number} len @param {number} dec @returns {{abap: "P", len: number, dec: number}} */ dec: (len, dec) => ({abap: "P", len, dec}),
  /** @param {number} len @returns {{abap: "C", len: number}} */ char: (len) => ({abap: "C", len}),
  /** @param {number} [len] @returns {{abap: "XSTRING"} | {abap: "X", len: number}} */ bytes: (len) => len === undefined ? ({abap: "XSTRING"}) : ({abap: "X", len}),
  str: {abap: "STRING"},
  date: {abap: "D"},
  bool: {abap: "BOOL"},
};

// ---------------------------------------------------------------- expressions

/** @param {string} [source] */
export const col = (name, type, source) => source === undefined
  ? ({node: "col", name, type}) : ({node: "col", name, type, source});
export const lit = (value, type) => ({node: "lit", value, type});
/** a host value: bound by the driver, never rendered into the text */
export const param = (name, type, isNull = false) => ({node: "param", name, type, isNull});
/** A value owned by the AMDP execution context rather than by the database
 *  connection chosen to execute a relational plan. It must be captured into
 *  a bound parameter before lowering; no backend is allowed to substitute
 *  its own user, schema, or session setting. */
export const sessionValue = (kind, name, type = T.str) => ({node: "session", kind, name, type});

/**
 * An arithmetic or comparison node. `type` is the type HANA gives the RESULT,
 * and it is required: integer division and decimal division are different
 * operations that look identical in the source.
 */
export const bin = (op, left, right, type) => ({node: "bin", op, left, right, type});
export const call = (fn, args, type) => ({node: "call", fn, args, type});
export const cast = (expr, type) => ({node: "cast", expr, type});
export const isNull = (expr) => ({node: "isnull", expr, type: T.bool});
/** NOT, as its own node rather than a `bin` with one side missing */
export const not = (expr) => ({node: "not", expr, type: T.bool});
/** `x [NOT] LIKE p [ESCAPE e]` -- three operands, so it is not a `bin` */
export const like = (expr, pattern, escape, negated = false) =>
  ({node: "like", expr, pattern, escape, negated, type: T.bool});
/** `x [NOT] IN (a, b, c)` -- the list form only; a subquery is a relation and
 *  belongs in the relational half, which this IR keeps separate on purpose */
export const inList = (expr, values, negated = false) =>
  ({node: "in", expr, values, negated, type: T.bool});
/** A relation used where an expression is expected: `x IN (SELECT ...)`,
 *  `EXISTS (SELECT ...)`, `x = (SELECT ...)`.
 *
 *  This IR keeps relations and expressions apart on purpose, and this node is
 *  the one seam between them rather than a hole in the wall: it carries a
 *  whole relation, so everything that walks relations -- `effects`, the
 *  barrier decision, the row chooser -- reaches inside it by walking `rel`,
 *  and nothing has to learn a second shape. `kind` says which of the three
 *  it is, because the three render differently and only one of them is
 *  allowed to answer more than one row. */
export const subquery = (kind, rel, expr, negated = false) =>
  ({node: "sub", kind, rel, expr, negated, type: kind === "scalar" ? undefined : T.bool});

/** `CASE WHEN p THEN a ... ELSE b END`, the searched form; the simple form
 *  `CASE x WHEN v THEN ...` is rewritten into it by the binder, because one
 *  shape downstream is one shape to lower and one shape to type */
export const caseWhen = (whens, otherwise, type) =>
  ({node: "case", whens, otherwise, type});

// ------------------------------------------------------------------ relations

export const scan = (table) => ({rel: "scan", table});
/** A source alias is semantic: qualified columns and correlated subqueries
 * must keep the author's scope name until SQL rendering. */
export const alias = (input, name) => ({rel: "alias", input, name});
/**
 * `FROM :lt` - a reference to a table variable, as the PARSER sees it.
 *
 * This is the one node the lowering never accepts. A table variable is not a
 * barrier (measured on HANA), so `lt2 = SELECT ... FROM :lt1` is not a
 * sequence of two statements: it is one plan in which lt1's plan sits where
 * the FROM is. Performing that substitution is the binder's job, and it has
 * two possible outcomes - inline the referenced plan (the usual case, and
 * what makes a chain one statement), or, if a barrier materialised the
 * variable, replace it with `ref(handle)`.
 *
 * Keeping it a distinct node rather than letting the parser emit `scan("lt")`
 * matters for a reason the lexer already had to solve one level down: `FROM
 * :lt` and `FROM lt` are different objects - the second is a database table,
 * and shadowing a real table name is ordinary. Losing the colon here would
 * read one and mean the other.
 */
export const varRef = (name, schema) => schema === undefined ? ({rel: "var", name}) : ({rel: "var", name, schema});
/** a relation the seam already knows by name (a barrier materialised it) */
export const ref = (handle) => ({rel: "ref", handle});

/**
 * The same, with the schema of the plan that was materialised.
 *
 * Use this one in the binder. A `ref` is the only node whose columns cannot
 * be derived from anything below it - there is nothing below it - so the
 * schema has to be carried, and the moment it is known is the moment the
 * barrier is created. `schemaOf` refuses a bare `ref` rather than guessing,
 * which is correct and also easy to hit; this exists so it is easier to do
 * the right thing than the wrong one.
 */
export const refTo = (handle, schema) => ({rel: "ref", handle, schema});
/** a table function called in FROM: the callee as the source spells it, its
 *  arguments (scalar expressions or relations), and the schema its
 *  declaration promises -- carried, like a ref's, because nothing below it
 *  can derive it */
export const tableFunctionCall = (name, args, schema) => ({rel: "tfcall", name, args, schema});
export const filter = (input, pred) => ({rel: "filter", input, pred});
export const project = (input, items) => ({rel: "project", input, items});
export const join = (left, right, on, kind = "inner") => ({rel: "join", left, right, on, kind});
export const union = (inputs, all = true) => ({rel: "union", inputs, all});
export const except = (left, right) => ({rel: "except", inputs: [left, right]});
export const aggregate = (input, groupBy, aggs) => ({rel: "aggregate", input, groupBy, aggs});
export const order = (input, keys) => ({rel: "order", input, keys});
export const limit = (input, n) => ({rel: "limit", input,
  n: typeof n === "number" ? lit(n, T.int) : n});

/**
 * The effects of a relational subtree, which is what decides whether a chain
 * may stay one plan. `mayThrow` is the interesting one: fusing a chain whose
 * projection can raise moves the error - measured, both on HANA and on our
 * own engines - so a caller that cares must materialise deliberately and say
 * why (the seam's `materialise` reason).
 */
/** @typedef {{mayThrow: boolean, nonDeterministic: boolean, reads: string[], writes: string[]}} RelationEffects */
export function effects(rel) {
  /** @type {RelationEffects} */ const out = {mayThrow: false, nonDeterministic: false, reads: [], writes: []};
  const walkExpr = (e) => {
    if (e === undefined || e === null) return;
    if (e.node === "cast") out.mayThrow = true;
    if (e.node === "bin" && e.op === "/") out.mayThrow = true;
    if (e.node === "call" && ["TO_INTEGER", "TO_DECIMAL", "TO_TIMESTAMP", "TO_DATE"].includes(e.fn)) out.mayThrow = true;
    if (e.node === "call" && ["RAND", "CURRENT_TIMESTAMP", "CURRENT_DATE"].includes(e.fn)) out.nonDeterministic = true;
    // A concatenating aggregate with no ordering has an **unspecified**
    // result on all three engines, so two of them agreeing says nothing --
    // it is the shape that agrees on three rows and parts on three hundred
    if (e.node === "call" && ["STRING_AGG", "GROUP_CONCAT"].includes(e.fn) && (e.orderBy ?? []).length === 0) {
      out.nonDeterministic = true;
    }
    // ROW_NUMBER over an unordered window numbers the rows in whatever order
    // the engine produced them, which is not an order anybody promised
    if (e.node === "call" && ["ROW_NUMBER", "RANK", "DENSE_RANK"].includes(e.fn)
        && (e.window?.orderBy ?? []).length === 0) {
      out.nonDeterministic = true;
    }
    for (const key of ["left", "right", "expr", "pattern", "escape", "otherwise"]) walkExpr(e[key]);
    for (const one of e.args ?? []) walkExpr(one);
    for (const one of e.values ?? []) walkExpr(one);
    for (const one of e.whens ?? []) { walkExpr(one.when); walkExpr(one.then); }
    if (e.node === "sub") walk(e.rel);
  };
  const walk = (r) => {
    if (r === undefined) return;
    if (r.rel === "scan") out.reads.push(r.table);
    // A body that writes is coming (INSERT INTO ... SELECT, MERGE INTO), and
    // when it arrives the difference between reading a plan twice and
    // running it twice stops being academic. Recorded here so that the
    // instruments can refuse before the first such body exists, rather than
    // discovering the rule by writing twice into somebody's table.
    if (["insert", "update", "delete", "merge"].includes(r.rel)) out.writes.push(r.into ?? r.table ?? r.rel);
    walkExpr(r.pred);
    for (const item of r.items ?? []) walkExpr(item.expr);
    for (const agg of r.aggs ?? []) walkExpr(agg.expr);
    walkExpr(r.on);
    walkExpr(r.n);
    for (const key of ["input", "left", "right"]) walk(r[key]);
    for (const one of r.inputs ?? []) walk(one);
  };
  walk(rel);
  return out;
}

/**
 * The seam speaks a different type language, and this is the translation.
 *
 * Inside the IR a type is an object, because the lowering has to ask it
 * questions - is this division integer, how wide is this character field.
 * The native channel's contract (docs/db-seam-native.md) says `type` is "an
 * ABAP type letter with length and decimals", which is a string. Both halves
 * were written against the same document and still disagreed here, and
 * nothing said so until a plan was actually executed: the text-level tests
 * were green throughout. That is the argument for running the fixtures and
 * not only spelling them.
 */
export function seamType(type) {
  if (type === undefined || type === null) return "STRING";
  if (typeof type === "string") return type;
  const {abap, len, dec} = type;
  if (abap === "UNRESOLVED") throw new Error(`a column with no resolved type reached the seam (${type.reason})`);
  if (abap === "P" && len !== undefined) return `P(${len},${dec ?? 0})`;
  if (len !== undefined) return `${abap}(${len})`;
  return abap;
}

/**
 * The output schema of a plan: {COLUMN: type}.
 *
 * The typer needs the type of a COLUMN, not only of a literal, and a column's
 * type has two different sources depending on what it hangs off:
 *
 *   - a `scan` reads it from the **catalogue**, which is passed in rather
 *     than imported. A pure function with a catalogue argument can be tested
 *     with four lines of fixture; one that reaches into the runtime registry
 *     drags the whole system into every test of the type rules.
 *   - a **table variable has no catalogue entry at all**. Its columns are
 *     whatever the plan that defined it produces, so the schema is computed
 *     bottom-up through the tree - which is also why `var` must be resolved
 *     before this is asked: an unresolved variable has no schema anywhere.
 *
 * The catalogue is the smallest thing that answers the question:
 *
 *   {"SRC": {"K": {abap: "C", len: 3}, "N": {abap: "I"}}}
 *
 * so the runtime's own registry is adapted into it by a caller, outside this
 * file, and nothing here knows that a registry exists.
 */
export function schemaOf(rel, catalogue = {}) {
  if (rel === undefined || rel === null || rel.rel === undefined) {
    throw new Error(`schemaOf: a relation arrived without a rel kind: ${JSON.stringify(rel)?.slice(0, 60)}`);
  }
  const need = (r) => schemaOf(r, catalogue);
  switch (rel.rel) {
    case "scan": {
      // DUMMY is the engine's one-row, zero-domain source. Its projection
      // defines every output column, so no dictionary entry is required.
      if (String(rel.table).toUpperCase() === "DUMMY") return {};
      const table = catalogue[rel.table] ?? catalogue[rel.table?.toUpperCase?.()];
      if (table === undefined) throw new Error(`schemaOf: the catalogue does not describe ${rel.table}`);
      return {...table};
    }
    case "alias":
      return need(rel.input);
    case "var":
      if (rel.schema !== undefined) return {...rel.schema};
      throw new Error(`schemaOf: :${rel.name} has no schema until the binder resolves it`);
    case "ref":
      // a materialised relation: its schema is the plan's that made it, and
      // the binder knows which that was - it must carry it on the node
      if (rel.schema === undefined) throw new Error("schemaOf: a ref must carry the schema of the relation it points at");
      return {...rel.schema};
    case "tfcall":
      if (rel.schema === undefined) throw new Error(`schemaOf: the call of ${rel.name} must carry the schema its declaration promises`);
      return {...rel.schema};
    case "filter":
    case "order":
    case "limit":
      return need(rel.input);
    case "project":
      if (rel.items === undefined) throw new Error("schemaOf: a project arrived without its items");
      return Object.fromEntries(rel.items.map((item) => [item.as, typeOfExpr(item.expr, need(rel.input))]));
    case "join": {
      const left = need(rel.left);
      const right = need(rel.right);
      return {...left, ...right};
    }
    case "union": {
      if (rel.inputs.some((one) => one?.rel === "except" || (one?.rel === "union" && one.all !== rel.all))) {
        throw new Error("schemaOf: nested set operations are outside the measured subset");
      }
      const all = rel.inputs.map(need);
      const first = Object.keys(all[0]);
      const merged = {...all[0]};
      for (const one of all.slice(1)) {
        // SQLScript lets a UNION of mismatched shapes through only by
        // position; refusing here is cheaper than a wrong column later
        if (JSON.stringify(Object.keys(one)) !== JSON.stringify(first)) {
          throw new Error("schemaOf: the branches of a UNION do not have the same columns");
        }
        for (const name of first) {
          const left = merged[name], right = one[name];
          if (JSON.stringify(left) === JSON.stringify(right)) continue;
          const text = (type) => type?.abap === "C" || type?.abap === "STRING";
          if (text(left) && text(right)) {
            merged[name] = left.abap === "STRING" || right.abap === "STRING"
              ? T.str : T.char(Math.max(Number(left.len ?? 0), Number(right.len ?? 0)));
            continue;
          }
          throw new Error(`schemaOf: UNION column ${name} differs in type`);
        }
      }
      return merged;
    }
    case "except": {
      if (rel.inputs?.length !== 2) throw new Error("schemaOf: EXCEPT requires exactly two branches");
      if (rel.inputs.some((one) => one?.rel === "union" || one?.rel === "except")) {
        throw new Error("schemaOf: nested set operations are outside the measured subset");
      }
      const left = need(rel.inputs[0]), right = need(rel.inputs[1]);
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        throw new Error("schemaOf: EXCEPT branches must have identical columns and measured types");
      }
      return left;
    }
    case "aggregate": {
      const input = need(rel.input);
      const out = {};
      for (const key of rel.groupBy) out[key] = input[key];
      for (const agg of rel.aggs) out[agg.as] = typeOfExpr(agg.expr, input);
      return out;
    }
    default:
      throw new Error(`schemaOf: no schema rule for ${rel.rel}`);
  }
}

/** the type an expression produces, given the schema it reads from */
export function typeOfExpr(expr, schema = {}) {
  if (expr === undefined || expr === null || expr.node === undefined) {
    throw new Error(`typeOfExpr: an expression arrived without a node kind: ${JSON.stringify(expr)?.slice(0, 60)}`);
  }
  switch (expr.node) {
    case "col": {
      // Once the binder has resolved a qualified (or otherwise ambiguous)
      // column it carries the authoritative type on the expression. Looking
      // it up again in a flattened JOIN schema can select the other side's
      // same-named column because object keys cannot represent both.
      if (expr.type !== undefined) return expr.type;
      const type = schema[expr.name] ?? schema[expr.name?.toUpperCase?.()];
      if (type === undefined) throw new Error(`typeOfExpr: ${expr.name} is not in the input schema`);
      return type;
    }
    case "lit":
    case "param":
    case "session":
      return expr.type;
    case "isnull":
    case "not":
    case "like":
    case "in":
      return T.bool;
    case "sub":
      if (expr.kind !== "scalar") return T.bool;
      if (expr.type !== undefined) return expr.type;
      throw new Error("typeOfExpr: a scalar subquery carries no type and none has been measured for it");
    case "case":
      if (expr.type !== undefined) return expr.type;
      // every branch has to agree, and saying so is cheaper than guessing
      return typeOfExpr(expr.whens[0].then, schema);
    case "cast":
      return expr.type;
    case "bin":
    case "call":
      // Only the nodes the LOWERING renders differently actually need a
      // computed type - division and casts - so a typer that knows those two
      // and copies the rest through unblocks the first bodies long before
      // full inference exists. Where the type is already on the node, it wins:
      // the parser may know better than a rule we have not measured.
      if (expr.type !== undefined) return expr.type;
      throw new Error(`typeOfExpr: ${expr.node} ${expr.op ?? expr.fn} carries no type and no rule has been measured for it`);
    default:
      throw new Error(`typeOfExpr: no type rule for ${expr.node}`);
  }
}

/**
 * Rows chosen to make a plan misbehave, derived from the plan itself.
 *
 * The fused-against-forced comparison only says something when the data can
 * reach the expression that behaves differently. Representative data almost
 * never does: a cast diverges on the one row that is not a number, a division
 * on the one row that is zero, arithmetic on the one row that is NULL, and a
 * fixture invented to look plausible contains none of them. So the rows are
 * derived from the expressions in the plan rather than from imagination -
 * which is also the only way to do it automatically for a corpus nobody has
 * read.
 *
 * Returns {column: value} suggestions, one per hazard found, plus the reason,
 * so a caller can build its fixture and a reader can see why each row is
 * there. It does not invent a schema: a column it cannot see in `schema` is
 * reported and left to the caller.
 */
export function adversarialRows(rel, schema = {}) {
  const out = [];
  const note = (column, value, why) => {
    if (column === undefined) return;
    out.push({column, value, why, known: Object.prototype.hasOwnProperty.call(schema, column)});
  };
  const colOf = (e) => (e?.node === "col" ? e.name : undefined);

  const walkExpr = (e) => {
    if (e === undefined || e === null) return;
    if (e.node === "cast" || (e.node === "call" && /^TO_(INTEGER|DECIMAL|DATE|TIMESTAMP)$/.test(e.fn ?? ""))) {
      note(colOf(e.expr ?? e.args?.[0]), "not-a-number", "a cast raises on a value that will not convert, and only on that row");
    }
    if (e.node === "bin" && e.op === "/") {
      note(colOf(e.right), 0, "division by zero raises on HANA, is Infinity in DuckDB and NULL in sql.js");
    }
    if (e.node === "bin" && ["+", "-", "*"].includes(e.op)) {
      note(colOf(e.right) ?? colOf(e.left), null, "NULL in arithmetic propagates, and a filter may remove the row before or after");
    }
    for (const key of ["left", "right", "expr", "pattern", "escape", "otherwise"]) walkExpr(e[key]);
    for (const one of e.args ?? []) walkExpr(one);
    for (const one of e.values ?? []) walkExpr(one);
    for (const one of e.whens ?? []) { walkExpr(one.when); walkExpr(one.then); }
    if (e.node === "sub") walk(e.rel);
  };
  const walk = (r) => {
    if (r === undefined) return;
    walkExpr(r.pred);
    for (const item of r.items ?? []) walkExpr(item.expr);
    for (const agg of r.aggs ?? []) walkExpr(agg.expr);
    walkExpr(r.on);
    for (const key of ["input", "left", "right"]) walk(r[key]);
    for (const one of r.inputs ?? []) walk(one);
  };
  walk(rel);
  return out;
}

/**
 * The tables a plan needs, invented from the plan.
 *
 * Seven of the corpus bodies could be compared, and none of them could
 * diverge - all projections. The reason is not that hazardous bodies fail to
 * lower: it is that a body doing arithmetic almost always READS A TABLE, and
 * the only bodies runnable here were the self-contained ones that read
 * nothing but their parameters. The filter that made them runnable is the
 * same filter that removed everything interesting.
 *
 * So the tables are derived instead of found. A plan says which tables it
 * scans, which columns it touches, and - from what is done to each column -
 * enough about its type to build something the body will run against:
 *
 *   compared with a character literal, or cast to a number  -> character
 *   used in arithmetic, or compared with a number           -> integer
 *   only ever selected                                      -> character
 *
 * The last line is a guess and is marked as one. Everything here is a
 * scaffold for running a body against invented data, never a claim about
 * what the table really is: a column whose use says nothing gets `guessed:
 * true`, and a caller that cares can refuse it.
 */
export function tableShapesFor(rel) {
  const tables = new Map();
  const seen = new Map();
  const note = (name, type, why, guessed = false, hint = undefined) => {
    if (name === undefined) return;
    const already = seen.get(name);
    // a use that determines the type beats one that guesses at it
    if (already !== undefined && already.guessed === false) return;
    // `hint` says what a PLAUSIBLE value looks like, which is not the same
    // question as the type. A column cast to a number is held as text and
    // must be filled with text that CONVERTS, or every body that casts it
    // raises on both sides of a comparison and the measurement is about the
    // fixture. The plan knows this; it was simply not being carried.
    seen.set(name, hint === undefined ? {type, why, guessed} : {type, why, guessed, hint});
  };
  const colOf = (e) => (e?.node === "col" ? e.name : undefined);

  const walkExpr = (e) => {
    if (e === undefined || e === null) return;
    if (e.node === "col") note(e.name, T.char(20), "only ever read, so nothing says what it is", true);
    if (e.node === "cast" || (e.node === "call" && /^TO_(INTEGER|DECIMAL)$/.test(e.fn ?? ""))) {
      note(colOf(e.expr ?? e.args?.[0]), T.str, "cast to a number, so it is written as text", false, "digits");
    }
    // A function that only takes numbers says as much about its argument as
    // arithmetic does. Without this, `ABS(a)` left the column GUESSED as
    // CHAR(20), the invented table held text, and both halves of the
    // HANA-against-HANA comparison raised -- which the verdict then read as
    // AGREEMENT. Three constructs measured nothing that way and said they
    // agreed (2026-09-19). Only functions whose argument cannot be anything
    // else are listed: `MIN`, `MAX` and `COALESCE` take either kind and
    // would be a guess dressed as evidence.
    if (e.node === "call" && ["ABS", "ROUND", "SUM", "AVG", "CEIL", "FLOOR", "TRUNC", "SIGN"].includes(e.fn ?? "")) {
      note(colOf(e.args?.[0]), T.int, `argument of ${e.fn}, which takes a number`);
    }
    if (e.node === "bin" && ["+", "-", "*", "/"].includes(e.op)) {
      note(colOf(e.left), T.int, "arithmetic");
      note(colOf(e.right), T.int, "arithmetic");
    }
    if (e.node === "bin" && ["=", "<>", "<", ">", "<=", ">="].includes(e.op)) {
      const other = e.right?.node === "lit" ? e.right : e.left?.node === "lit" ? e.left : undefined;
      const column = colOf(e.left) ?? colOf(e.right);
      if (other !== undefined) {
        note(column, typeof other.value === "number" ? T.int : T.char(20),
          `compared with a ${typeof other.value === "number" ? "number" : "character"} literal`);
      }
    }
    for (const key of ["left", "right", "expr"]) walkExpr(e[key]);
    for (const one of e.args ?? []) walkExpr(one);
    if (e.rel !== undefined) walk(e);
  };

  const walk = (r) => {
    if (r === undefined) return;
    if (r.rel === "scan") tables.set(r.table, (tables.get(r.table) ?? 0) + 1);
    walkExpr(r.pred);
    for (const item of r.items ?? []) walkExpr(item.expr);
    for (const agg of r.aggs ?? []) walkExpr(agg.expr);
    walkExpr(r.on);
    for (const key of ["input", "left", "right"]) walk(r[key]);
    for (const one of r.inputs ?? []) walk(one);
  };
  walk(rel);

  // A bare column name is unattributable whenever the plan holds **more than
  // one scan** - not more than one table. Counting distinct names missed the
  // case that matters: the same table scanned twice is a self-join, the
  // engine says `Ambiguous reference to table`, and the plan looked
  // single-table right up until it ran. Found in the corpus, by the engine,
  // which is the wrong place to find it.
  const names = [...tables.keys()];
  const scans = [...tables.values()].reduce((a, b) => a + b, 0);
  const columns = Object.fromEntries([...seen].map(([name, one]) => [name, one]));
  return {
    tables: names,
    scans,
    columns,
    ambiguous: scans > 1,
    guessed: Object.entries(columns).filter(([, one]) => one.guessed).map(([name]) => name),
  };
}

/**
 * Which table each column came from, where the plan says so.
 *
 * A column reference in this IR is a bare name, so with two tables in a plan
 * a name cannot be attributed - and giving every table every column does not
 * help, because then the name exists twice and the engine says the same
 * thing back: ambiguous. Pointing both scans at ONE table does not help
 * either; it turns the join into a self-join and the name exists twice
 * again. The ambiguity moves, it does not go.
 *
 * But a join predicate usually says it outright. `ON a = b` compares one
 * side with the other, so `a` belongs under the left subtree and `b` under
 * the right. That is derivable rather than invented, and where it is not
 * derivable - a self-join on the same column name, a predicate that is not a
 * simple comparison of two columns - nothing is claimed.
 */
export function attributeColumns(rel) {
  const owner = new Map();
  const tablesUnder = (r, out = []) => {
    if (r === undefined) return out;
    if (r.rel === "scan") out.push(r.table);
    for (const key of ["input", "left", "right"]) tablesUnder(r[key], out);
    for (const one of r.inputs ?? []) tablesUnder(one, out);
    return out;
  };
  const walk = (r) => {
    if (r === undefined) return;
    if (r.rel === "join" && r.on?.node === "bin" && r.on.op === "=" &&
        r.on.left?.node === "col" && r.on.right?.node === "col" &&
        r.on.left.name !== r.on.right.name) {
      const left = tablesUnder(r.left);
      const right = tablesUnder(r.right);
      // **Exactly one table on each side, or nothing is claimed.**
      //
      // If the left subtree is itself a join of two tables, then "this
      // column is somewhere under the left" narrows the candidates from
      // three to two - which is not attribution, and placing the column in
      // both recreates the ambiguity this exists to remove. So the outer
      // predicate says nothing here and the column stays unattributed.
      //
      // In practice that costs less than it sounds: a nested join has its
      // own predicate, and this walk visits every join, so the inner one
      // usually attributes the inner columns. What is left over is a column
      // mentioned only by an outer predicate whose side holds more than one
      // table - and for that, nobody knows.
      // and the two sides must be DIFFERENT tables. The same table on both
      // sides is a self-join: naming it for both columns looks like
      // attribution and attributes nothing, because both scans are that
      // table and a bare name still matches twice.
      if (left.length === 1 && right.length === 1 && left[0] !== right[0]) {
        owner.set(r.on.left.name, left[0]);
        owner.set(r.on.right.name, right[0]);
      }
    }
    for (const key of ["input", "left", "right"]) walk(r[key]);
    for (const one of r.inputs ?? []) walk(one);
  };
  walk(rel);
  return owner;
}

/**
 * The shapes, split per table when the plan allows it.
 *
 * Columns the join predicate attributes go to their own table; everything
 * else goes to the first table, and the fact is reported rather than hidden.
 * A caller that refuses to run on a guess can look at `unattributed`.
 */
export function tableShapesPerTable(rel) {
  const flat = tableShapesFor(rel);
  const owner = attributeColumns(rel);
  const perTable = Object.fromEntries(flat.tables.map((name) => [name, {}]));
  const unattributed = [];
  for (const [column, one] of Object.entries(flat.columns)) {
    const table = owner.get(column);
    if (table !== undefined && perTable[table] !== undefined) {
      perTable[table][column] = one;
    } else {
      unattributed.push(column);
      perTable[flat.tables[0]][column] = one;
    }
  }
  return {...flat, perTable, unattributed, attributed: [...owner.keys()]};
}
