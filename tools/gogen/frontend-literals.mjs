// A text literal's kind and value: 'chars' or `string`, one literal or several
// joined by the literal operator & at compile time (`a` & `b`). The joined
// form took the whole text for one literal until 2026-10-14, so WHEN `abc` &
// `def` never matched (abapiti inbox 049). Blanks inside the joined parts are
// kept: A4H 2026-10-14, 'ab ' & 'c' is strlen 4, "ab c". A refusal is
// returned, not thrown.
const LITERAL = /'(?:[^']|'')*'|`(?:[^`]|``)*`/y;
export function textLiteral(n, Expressions) {
  const joined = n.findDirectExpression(Expressions.ConcatenatedConstant);
  const parts = joined ? joined.getChildren().map((c) => c.getFirstToken().getStr()).filter((t) => t !== "&") : [n.concatTokens()];
  const quote = parts[0]?.[0];
  if (!["'", "`"].includes(quote) || (joined && parts.some((t) => t.length < 2 || t[0] !== quote || t.at(-1) !== quote))) return {refusal: ""};
  return {quote, value: parts.map((t) => t.slice(1, -1).replaceAll(quote + quote, quote)).join("")};
}

// The same for the text of a parameter's DEFAULT: one literal or several of
// one kind joined by &, else null.
export function literalText(text) {
  const parts = [];
  for (let at = 0; ;) {
    LITERAL.lastIndex = at;
    const m = LITERAL.exec(text);
    if (!m || m[0][0] !== text[0]) return null;
    parts.push(m[0]);
    at = LITERAL.lastIndex;
    const rest = /^\s*&\s*/.exec(text.slice(at));
    if (!rest) return at === text.length ? {quote: text[0], value: parts.map((t) => t.slice(1, -1).replaceAll(text[0] + text[0], text[0])).join("")} : null;
    at += rest[0].length;
  }
}
