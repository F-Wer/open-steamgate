import {Nodes, Expressions, upper, isExpr, charlike, Unsupported, I, S, XS} from "./frontend-base.mjs";
/** @param {import("@abaplint/core").Nodes.StatementNode} node @param {import("./frontend.mjs").ByteStatementHelpers} h */ export function replaceStatement(node, ctx, text, h) {
  const {source, lvalue, convert} = h;
  const kids = node.getChildren();
  const words = kids.map((k) => (k instanceof Nodes.TokenNode ? upper(k.concatTokens()) : ""));
  const tw = words.filter((w) => w !== "" && w !== ".").join(" ");
  const matches = (...parts) => keywordForm(tw, ...parts);
  const section = matches("REPLACE SECTION", ["", "OFFSET"], ["", "LENGTH"], "OF WITH", ["", "IN BYTE MODE", "IN CHARACTER MODE"]);
  const bytes = matches("REPLACE SECTION", ["", "OFFSET"], ["", "LENGTH"], "OF WITH IN BYTE MODE");
  const hasKeywords = (...seq) => words.some((_, i) => seq.every((w, j) => words[i + j] === w));
  if (!bytes && (words.some((w) => ["RESPECTING", "REPLACEMENT", "RESULTS", "INTO"].includes(w)) || hasKeywords("IN", "BYTE", "MODE"))) throw new Unsupported(`REPLACE form: ${text}`);
  if (!section && words.includes("SECTION") && !words.includes("OCCURRENCE") && !words.includes("OCCURRENCES")) throw new Unsupported(`REPLACE SECTION form: ${text}`);
  const ft = node.findDirectExpression(Expressions.FindType);
  const kind = ft ? upper(ft.concatTokens()) : "";
  if (kind && kind !== "REGEX" && kind !== "PCRE" && kind !== "SUBSTRING") throw new Unsupported(`REPLACE ${kind}`);
  const regex = kind === "REGEX" || kind === "PCRE";
  let pat = null, off = null, len = null, wth = null, mode = "pat";
  for (let i = 0; i < kids.length; i += 1) {
    const w = words[i];
    if (w === "OFFSET") { mode = "off"; continue; }
    if (w === "LENGTH") { mode = "len"; continue; }
    if (w === "WITH") { mode = "with"; continue; }
    if (!isExpr(kids[i], Expressions.Source)) continue;
    if (mode === "pat" && pat === null) pat = kids[i];
    else if (mode === "off") off = kids[i];
    else if (mode === "len") len = kids[i];
    else if (mode === "with") wth = kids[i];
  }
  // ABAPiti r1-r6: SECTION replaces the span with all replacement bytes.
  if (bytes) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const w = wth ? source(wth, ctx) : null;
    if (!["x", "xstring"].includes(target.type.k) || !w || !["x", "xstring"].includes(w.type.k)) throw new Unsupported(`REPLACE byte SECTION operands: ${text}`);
    return {s: "replace_bytes", target, with: convert(w, XS), off: off ? convert(source(off, ctx, I), I) : null, len: len ? convert(source(len, ctx, I), I) : null};
  }
  if (section) {
    const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
    const w = wth ? source(wth, ctx) : null;
    if (!["string", "c"].includes(target.type.k) || !w || !charlike(w.type)) throw new Unsupported(`REPLACE character SECTION operands: ${text}`);
    return {s: "replace_chars", target, with: convert(w, S), off: off ? convert(source(off, ctx, I), I) : null, len: len ? convert(source(len, ctx, I), I) : null};
  }
  if (pat === null || wth === null) throw new Unsupported(`REPLACE operands: ${text}`);
  if (regex && (off || len)) throw new Unsupported(`REPLACE REGEX IN SECTION: what an anchor sees there is not measured: ${text}`);
  const target = lvalue(node.findDirectExpression(Expressions.Target), ctx);
  if (target.type.k !== "string" && target.type.k !== "c") throw new Unsupported(`REPLACE in a ${target.type.k}`);
  const p = source(pat, ctx);
  const w = source(wth, ctx);
  if (!charlike(p.type) || !charlike(w.type)) throw new Unsupported(`REPLACE operands of ${p.type.k} / ${w.type.k}`);
  return {s: "replace", target, pattern: convert(p, S), with: convert(w, S), regex, pcre: kind === "PCRE", all: words.includes("ALL"),
    icase: hasKeywords("IGNORING", "CASE"), off: off ? convert(source(off, ctx, I), I) : null, len: len ? convert(source(len, ctx, I), I) : null,
    cLen: target.type.k === "c" ? target.type.len : -1};
}

// ABAPiti f1-f5: LENGTH bounds the section; MATCH OFFSET counts from xs.
/** @param {import("./frontend.mjs").ByteStatementHelpers} h */
export function lowerByteFind(node, ctx, text, kids, words, tw, h) {
  const {source, lvalue, convert} = h;
  // A4H oracle P2 ALL C3: non-overlapping byte results, with optional count.
  if (keywordForm(tw, "FIND ALL OCCURRENCES OF IN IN BYTE MODE", ["", "MATCH COUNT"], ["", "RESULTS"])
    && !node.findDirectExpression(Expressions.FindType)) {
    let count = null, resultNode = null;
    for (let i = 0; i < kids.length; i++) {
      if (words[i] === "COUNT") count = lvalue(kids[i + 1], ctx);
      if (words[i] === "RESULTS") resultNode = kids[i + 1];
    }
    if (count && count.type.k !== "i") throw new Unsupported(`MATCH COUNT into a ${count.type.k}`);
    if (resultNode) return {...h.findResults(node, ctx, text, tw, true, resultNode), count};
    const [p, s] = node.findDirectExpressions(Expressions.Source).map((n) => source(n, ctx));
    if (![p, s].every((x) => ["x", "xstring"].includes(x.type.k))) throw new Unsupported(`FIND IN BYTE MODE operands: ${text}`);
    return {s: "find_bytes_all", pattern: convert(p, XS), subject: convert(s, XS), count};
  }
  if (!keywordForm(tw, "FIND", ["", "FIRST OCCURRENCE OF"], "IN", ["", "SECTION OF", "SECTION OFFSET OF", "SECTION LENGTH OF", "SECTION OFFSET LENGTH OF"], "IN BYTE MODE", ["", "MATCH OFFSET"], ["", "MATCH LENGTH"])
    || ["REGEX", "PCRE"].includes(upper(node.findDirectExpression(Expressions.FindType)?.concatTokens() ?? ""))) return null;
  const srcs = node.findDirectExpressions(Expressions.Source);
  const pat = source(srcs[0], ctx), subject = source(srcs.at(-1), ctx);
  for (const x of [pat, subject]) if (x.type.k !== "x" && x.type.k !== "xstring") throw new Unsupported(`FIND IN BYTE MODE of a ${x.type.k}`);
  const out = {s: "find_bytes", pattern: convert(pat, XS), subject: convert(subject, XS), secOff: null, secLen: null, off: null, len: null};
  for (let i = 0; i < kids.length; i++) {
    const w = words[i];
    if (w !== "OFFSET" && w !== "LENGTH") continue;
    if (isExpr(kids[i + 1], Expressions.Source)) out[w === "OFFSET" ? "secOff" : "secLen"] = convert(source(kids[i + 1], ctx, I), I);
    else if (isExpr(kids[i + 1], Expressions.Target)) {
      const target = lvalue(kids[i + 1], ctx);
      if (target.type.k !== "i") throw new Unsupported(`MATCH ${w} into a ${target.type.k}`);
      out[w === "OFFSET" ? "off" : "len"] = target;
    }
  }
  return out;
}

// Match alternatives of direct keyword tokens; operands never enter these forms.
function keywordForm(text, ...parts) {
  return parts.reduce(/** @param {string[]} forms */ (forms, part) => forms.flatMap((form) =>
    (Array.isArray(part) ? part : [part]).map((p) => [form, p].filter(Boolean).join(" "))), [""]).includes(text);
}
