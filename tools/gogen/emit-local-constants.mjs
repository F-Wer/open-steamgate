// Emit hoisted VALUE expressions through each backend's normal converter.
export function localConstant(c, {fields, expr, zero, ident, struct}) {
  const ctx = {cls: {}, method: {}};
  if (c.init) return expr(c.init, ctx);
  if (!c.fieldInits) return undefined;
  const values = (fields.get(c.type.go)?.fields ?? []).map((f) =>
    `${ident(f.name)}: ${c.fieldInits[f.name] ? expr(c.fieldInits[f.name], ctx) : zero(f.type)}`);
  return struct(c.type, values.join(", "));
}

// One guard per method. Set it last: a conversion that throws must be retried.
export function localConstantDeclarations(consts, {js, type, zero, literal}) {
  const lines = [], groups = new Map();
  for (const c of consts.values()) {
    if (!c.localConstantInit) {
      lines.push(js ? `const ${c.go} = ${literal(c)};` : `var ${c.go} ${type(c.type)} = ${literal(c)}`);
      continue;
    }
    lines.push(js ? `let ${c.go} = ${zero(c.type)};` : `var ${c.go} ${type(c.type)}`);
    const group = groups.get(c.localConstantInit) ?? [];
    group.push(c); groups.set(c.localConstantInit, group);
  }
  for (const [name, cs] of groups) {
    if (consts.has(name) || consts.has(`${name}_DONE`)) throw new Error(`local constant name collision: ${name}`);
    lines.push(js ? `let ${name}_DONE = false;` : `var ${name}_DONE bool`);
    lines.push(js ? `function ${name}() {` : `func ${name}() {`);
    lines.push(js ? `  if (${name}_DONE) return;` : `  if ${name}_DONE { return }`);
    for (const c of cs) lines.push(`  ${c.go} = ${literal(c)}${js ? ";" : ""}`);
    lines.push(`  ${name}_DONE = true${js ? ";" : ""}`, "}");
  }
  return lines;
}
