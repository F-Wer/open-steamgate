// Emit hoisted VALUE expressions through each backend's normal converter.
export function localConstant(c, {fields, expr, zero, ident, struct}) {
  const ctx = {cls: {}, method: {}};
  if (c.init) return expr(c.init, ctx);
  if (!c.fieldInits) return undefined;
  const values = (fields.get(c.type.go)?.fields ?? []).map((f) =>
    `${ident(f.name)}: ${c.fieldInits[f.name] ? expr(c.fieldInits[f.name], ctx) : zero(f.type)}`);
  return struct(c.type, values.join(", "));
}

// Every local initializer here was proved exception-free by the frontend.
export function localConstantDeclarations(consts, {js, type, literal}) {
  return [...consts.values()].map((c) => js ? `const ${c.go} = ${literal(c)};` : `var ${c.go} ${type(c.type)} = ${literal(c)}`);
}
