import type * as abaplint from "@abaplint/core";

type LiteralQuote = "'" | "`";
export interface LiteralValue { readonly quote: LiteralQuote; readonly value: string; readonly refusal?: never }
export interface LiteralRefusal { readonly refusal: ""; readonly quote?: never; readonly value?: never }
export interface LiteralExpressions { readonly ConcatenatedConstant: typeof abaplint.Expressions.ConcatenatedConstant }

// A text literal's kind and value: 'chars' or `string`, one literal or several
// joined by the literal operator & at compile time (`a` & `b`). The joined
// form took the whole text for one literal until 2026-10-14, so WHEN `abc` &
// `def` never matched (abapiti inbox 049). Blanks inside the joined parts are
// kept: A4H 2026-10-14, 'ab ' & 'c' is strlen 4, "ab c". A refusal is
// returned, not thrown.
const LITERAL = /'(?:[^']|'')*'|`(?:[^`]|``)*`/y;
export function textLiteral(n: abaplint.Nodes.ExpressionNode, Expressions: LiteralExpressions): LiteralValue | LiteralRefusal {
  const joined = n.findDirectExpression(Expressions.ConcatenatedConstant);
  const parts = joined ? joined.getChildren().map((c): string => c.getFirstToken().getStr()).filter((t): boolean => t !== "&") : [n.concatTokens()];
  const quote = parts[0]?.[0];
  if ((quote !== "'" && quote !== "`") || (joined && parts.some((t): boolean => t.length < 2 || t[0] !== quote || t.at(-1) !== quote))) return {refusal: ""};
  return {quote, value: parts.map((t): string => t.slice(1, -1).replaceAll(quote + quote, quote)).join("")};
}

// The same for the text of a parameter's DEFAULT: one literal or several of
// one kind joined by &, else null.
export function literalText(text: string): LiteralValue | null {
  const parts: string[] = [];
  for (let at = 0; ;) {
    LITERAL.lastIndex = at;
    const m = LITERAL.exec(text);
    if (!m || m[0][0] !== text[0]) return null;
    // The matched literal starts with the same quote as the input.
    const quote = m[0][0] as LiteralQuote;
    parts.push(m[0]);
    at = LITERAL.lastIndex;
    const rest = /^\s*&\s*/.exec(text.slice(at));
    if (!rest) return at === text.length ? {quote, value: parts.map((t): string => t.slice(1, -1).replaceAll(text[0] + text[0], text[0])).join("")} : null;
    at += rest[0].length;
  }
}
