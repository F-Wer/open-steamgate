import {Expressions, Unsupported, upper, I, F, P31, S, XS, numeric} from "./frontend-base.mjs";
// Overloaded numeric built-ins, with explicit result types for both emitters.
export function builtin(name, direct, named, ctx, api, calc) {
  const {FUNCTIONS, source, convert} = api;
  const kind = FUNCTIONS[name];
  if (name === "BOOLX") {
    const params = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    const get = (key) => params.find((p) => upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()) === key)?.findDirectExpression(Expressions.Source);
    if (!get("BOOL")) throw new Unsupported("BOOLX( ) requires BOOL");
    return {e: "fn", name, args: [convert(source(get("BOOL"), ctx), S), get("BIT") ? convert(source(get("BIT"), ctx), I) : {e: "int", value: 0, type: I}], type: XS};
  }
  if (name === "IPOW") {
    const params = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    const get = (key) => params.find((p) => upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()) === key)?.findDirectExpression(Expressions.Source);
    if (!get("BASE") || !get("EXP")) throw new Unsupported("IPOW( ) requires BASE and EXP");
    const base = source(get("BASE"), ctx);
    const rank = {i: 0, int8: 1, p: 2, f: 3};
    // Leaf-type discovery has no enclosing hint yet. Character bases start
    // as i (the built-in signature); the later calculation can widen it.
    calc ??= ["c", "n"].includes(base.type.k) ? I : undefined;
    const chosen = calc && (rank[calc.k] ?? -1) > (rank[base.type.k] ?? -1) ? calc : base.type;
    const type = chosen.k === "p" ? P31 : {...chosen};
    delete type.calculation;
    if (!["i", "int8", "p", "f"].includes(type.k)) throw new Unsupported(`IPOW( ) of a ${type.k}: awaiting A4H oracle`);
    return {e: "fn", name, args: [convert(base, type), convert(source(get("EXP"), ctx), I)], type};
  }
  if (kind === "max") {
    if (named === undefined) throw new Unsupported(`${name}( ) without val1 / val2`);
    const vals = named.findDirectExpressions(Expressions.ParameterS).map((p) => source(p.findDirectExpression(Expressions.Source), ctx));
    const t = vals.some((v) => v.type.k === "f") ? F : vals.every((v) => v.type.k === "i") ? I : null;
    if (t === null) throw new Unsupported(`${name}( ) over ${vals.map((v) => v.type.k).join(",")}`);
    return {e: "fn", name, args: vals.map((v) => convert(v, t)), type: t};
  }
  const argNode = direct ?? named?.findDirectExpressions(Expressions.ParameterS).find((p) => upper(p.findDirectExpression(Expressions.ParameterName).concatTokens()) === "VAL")?.findDirectExpression(Expressions.Source);
  if (argNode === undefined) throw new Unsupported(`${name}( ) arguments`);
  if (kind === "f") return {e: "fn", name, args: [convert(source(argNode, ctx, F), F)], type: F};
  const arg = source(argNode, ctx);
  // of a p (A4H PDFMT fn:, PDCMP f:): abs( ) and frac( ) keep its type,
  // sign( ) is an i, ceil( ) floor( ) trunc( ) have no decimals (-1.5 gives
  // -1, -2, -1 in a template, -1.0 and -2.0 in a p(8,1))
  if (arg.type.k === "p") {
    if (name === "SIGN") return {e: "fn", name, args: [arg], type: I};
    if (["CEIL", "FLOOR", "TRUNC"].includes(name)) return {e: "fn", name, args: [arg], type: arg.type.calc ? P31 : {k: "p", len: arg.type.len, dec: 0}};
    return {e: "fn", name, args: [arg], type: arg.type};
  }
  if (!numeric(arg.type)) throw new Unsupported(`${name}( ) of a ${arg.type.k}`);
  return {e: "fn", name, args: [arg], type: arg.type};
}
