// Emit hoisted VALUE expressions through each backend's normal converter.
export function localConstant(c, {fields, expr, zero, ident, struct}) {
  const ctx = {cls: {}, method: {}};
  if (c.init) return expr(c.init, ctx);
  if (!c.fieldInits) return undefined;
  const values = (fields.get(c.type.go)?.fields ?? []).map((f) =>
    `${ident(f.name)}: ${c.fieldInits[f.name] ? expr(c.fieldInits[f.name], ctx) : zero(f.type)}`);
  return struct(c.type, values.join(", "));
}
