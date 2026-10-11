// Inline RESULTS uses the same registry DDIC types as explicit declarations.
// abaplint's inferred result has an untyped SUBMATCHES table.
export function inlineFindResultTypes(body, ctx, h) {
  const {Statements, Expressions, typeOf, Unsupported} = h;
  const types = new Map();
  for (const st of body?.findAllStatementNodes() ?? []) {
    if (!(st.get() instanceof Statements.Find)) continue;
    const target = st.findDirectExpression(Expressions.Target);
    const inline = target?.findFirstExpression(Expressions.InlineData);
    if (!inline || !/\bRESULTS\s+DATA\s*\(/i.test(st.concatTokens())) continue;
    const name = inline.findFirstExpression(Expressions.TargetField).concatTokens().toUpperCase();
    const ddicName = /^FIND ALL\b/i.test(st.concatTokens()) ? "MATCH_RESULT_TAB" : "MATCH_RESULT";
    const obj = ctx.reg.getObject(ddicName.endsWith("_TAB") ? "TTYP" : "TABL", ddicName);
    if (!obj) throw new Unsupported(`FIND inline RESULTS: missing DDIC type ${ddicName}`);
    types.set(name, typeOf(obj.parseType(ctx.reg), name, ctx.program));
  }
  return types;
}

/**
 * FIND ... RESULTS (parity-wave2). The target is a structure with LINE,
 * OFFSET, LENGTH (i) and SUBMATCHES, a standard table of a structure with
 * OFFSET and LENGTH (i) and nothing else -- match_result -- for FIRST, or a
 * standard table of such rows -- match_result_tab -- for FIRST or ALL.
 * The subject is a string or a c (not a table, not a section); the pattern a string or a
 * c, not a CL_ABAP_REGEX object. Byte ALL shares the result shape (P2 oracle).
 */
export function lowerFindResults(node, ctx, text, tw, bytes, resultNode, h) {
  const {Expressions, upper, source, charlike, Unsupported, lvalue, fieldOf, convert, XS, S} = h;
  const all = tw.startsWith("FIND ALL");
  const ft = node.findDirectExpression(Expressions.FindType);
  const kind = ft ? upper(ft.concatTokens()) : "";
  if (kind && kind !== "REGEX" && kind !== "PCRE") throw new Unsupported(`FIND ${kind} ... RESULTS`);
  const [pat, subj] = node.findDirectExpressions(Expressions.Source);
  const patX = source(pat, ctx);
  if (!(bytes ? ["x", "xstring"].includes(patX.type.k) : charlike(patX.type))) throw new Unsupported(`FIND ... RESULTS with a ${patX.type.k} pattern`);
  const subjX = source(subj, ctx);
  if (!(bytes ? ["x", "xstring"].includes(subjX.type.k) : charlike(subjX.type))) throw new Unsupported(`FIND ... RESULTS in a ${subjX.type.k}`);
  const target = lvalue(resultNode ?? node.findDirectExpression(Expressions.Target), ctx);
  const where = `FIND ... RESULTS ${target.type.k}`;
  let row = target.type;
  const table = target.type.k === "table";
  if (all || table) {
    if (!table || target.type.sorted || target.type.hashed) throw new Unsupported(`FIND ... RESULTS into other than a standard table`);
    row = target.type.row;
  } else if (target.type.k !== "struct") throw new Unsupported(`FIND FIRST OCCURRENCE ... RESULTS into a ${target.type.k}`);
  if (row.k !== "struct") throw new Unsupported(`${where}: rows that are not structures`);
  const f = {};
  for (const n of ["LINE", "OFFSET", "LENGTH"]) {
    const x = fieldOf(ctx, row, n, where);
    if (x.type.k !== "i") throw new Unsupported(`${where}: ${n} is a ${x.type.k}`);
    f[n] = x.name;
  }
  const sm = fieldOf(ctx, row, "SUBMATCHES", where);
  if (sm.type.k !== "table" || sm.type.sorted || sm.type.hashed || sm.type.row.k !== "struct") throw new Unsupported(`${where}: SUBMATCHES is not a standard table of structures`);
  f.SUBMATCHES = sm.name;
  const sub = sm.type.row;
  for (const n of ["OFFSET", "LENGTH"]) {
    const x = fieldOf(ctx, sub, n, where);
    if (x.type.k !== "i") throw new Unsupported(`${where}: SUBMATCHES-${n} is a ${x.type.k}`);
    f[`S${n}`] = x.name;
  }
  const nFields = (t) => ctx.program.structs.get(t.go)?.fields?.length ?? 0;
  if (nFields(row) !== 4 || nFields(sub) !== 2) throw new Unsupported(`${where}: a result structure with more components than match_result`);
  return {s: "find_results", all, bytes, mode: kind === "PCRE" ? "P" : kind === "REGEX" ? "R" : "", pattern: convert(patX, bytes ? XS : S), subject: convert(subjX, bytes ? XS : S),
    icase: /\bIGNORING\s+CASE\b/i.test(text), target, table, row, sub, f};
}
