// A text literal's kind and value: 'chars' or `string`, one literal or several
// joined by the literal operator & at compile time (`a` & `b`). The joined
// form took the whole text for one literal until 2026-10-14, so WHEN `abc` &
// `def` never matched (abapiti inbox 049). A refusal is returned, not thrown.
export function textLiteral(n, Expressions) {
  const joined = n.findDirectExpression(Expressions.ConcatenatedConstant);
  const parts = joined ? joined.getChildren().map((c) => c.getFirstToken().getStr()).filter((t) => t !== "&") : [n.concatTokens()];
  const quote = parts[0]?.[0];
  if (!["'", "`"].includes(quote) || (joined && parts.some((t) => t.length < 2 || t[0] !== quote || t.at(-1) !== quote))) return {refusal: ""};
  const values = parts.map((t) => t.slice(1, -1).replaceAll(quote + quote, quote));
  // whether & keeps a text literal's trailing blanks is unmeasured; measure on A4H
  if (quote === "'" && values.slice(0, -1).some((v) => / $/.test(v))) return {refusal: ": trailing blanks before &"};
  return {quote, value: values.join("")};
}
