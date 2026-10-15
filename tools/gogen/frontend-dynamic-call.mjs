// Static dispatch through a run-time class name. Parenthesized literal
// method names share the same adapter as an ordinary identifier; the class
// stays dynamic even when both names happen to be literals.
export function dynamicStaticCall(node, ctx, {Expressions, isTok, isExpr, sourceOperand, source, convert, S, Unsupported}) {
  const text = node.concatTokens();
  const kids = node.findDirectExpression(Expressions.MethodSource).getChildren();
  if (kids.length !== 3 || !isTok(kids[1], "=>")) throw new Unsupported(`CALL METHOD form: ${text}`);
  const operand = (dynamic) => {
    const inner = dynamic.getChildren().filter((c) => !isTok(c));
    if (inner.length !== 1) throw new Unsupported(`CALL METHOD form: ${text}`);
    return sourceOperand(inner[0], ctx);
  };
  const cls = convert(operand(kids[0]), S);
  let method;
  if (isExpr(kids[2], Expressions.AttributeName)) method = kids[2].concatTokens().toUpperCase();
  else if (isExpr(kids[2], Expressions.Dynamic)) {
    const value = operand(kids[2]);
    if (value.e !== "str" && value.e !== "chars") throw new Unsupported(`CALL METHOD with nonliteral dynamic method: ${text}`);
    method = value.value.trimEnd();
  } else throw new Unsupported(`CALL METHOD form: ${text}`);
  const body = node.findDirectExpression(Expressions.MethodCallBody);
  const mp = body?.findDirectExpression(Expressions.MethodParameters);
  // Only EXPORTING is passed by name. The section keywords are direct token
  // children of MethodParameters; a literal 'IMPORTING' in an argument is not.
  const sections = ["IMPORTING", "CHANGING", "RECEIVING", "EXCEPTIONS"];
  if (mp?.getChildren().some((c) => sections.some((k) => isTok(c, k)))) throw new Unsupported(`CALL METHOD by name with ${mp.concatTokens()}`);
  if (body && !mp) throw new Unsupported(`CALL METHOD form: ${text}`);
  const args = (mp?.findAllExpressions(Expressions.ParameterS) ?? []).map((p) => ({name: p.findDirectExpression(Expressions.ParameterName).concatTokens().toUpperCase(),
    value: convert(source(p.findDirectExpression(Expressions.Source), ctx), {k: "data"})}));
  ctx.program.dynStatics.add(method);
  return {s: "call_dyn_static", cls, method, args};
}
