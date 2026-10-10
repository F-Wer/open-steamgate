import * as abap from "./js/abap.mjs";

// Refuse unknown conversions; only literal, exception-free values leave entry.
function fold(e) {
  // Character converters are only proven backend-equivalent for ASCII.
  // Keep Unicode literals (including structure fields) at their entry site.
  if (["chars", "str"].includes(e.e) && /[^\x00-\x7f]/.test(e.value)) return undefined;
  if (["int", "float", "chars", "str", "xbytes"].includes(e.e)) return e;
  const x = e.x && fold(e.x);
  if (!x) return undefined;
  let value;
  try {
    if (e.e === "neg" && e.type.k === "i") value = abap.NegI(x.value);
    else if (e.e === "neg" && e.type.k === "f") value = -x.value;
    else if (e.e === "conv") {
      const v = x.value;
      switch (e.kind) {
        case "c2n":
          if (e.to.k === "f") value = abap.ParseF(v);
          else if (e.to.k === "i") value = abap.ParseI(v);
          break;
        case "num": if (e.from.k === "i" && e.to.k === "f") value = v; break;
        case "c2s": value = v; break;
        case "s2c": value = abap.CFit(v, e.to.len); break;
        case "s2d": value = abap.S2D(v); break;
        case "s2t": value = abap.S2T(v); break;
        case "s2n": value = abap.CToN(v, e.to.len); break;
        case "i2n": value = abap.IToN(v, e.to.len); break;
      }
    }
  } catch { return undefined; }
  // Negative zero needs backend-specific spelling: keep its entry conversion.
  if (value === undefined || Object.is(value, -0)) return undefined;
  return {e: e.type.k === "i" ? "int" : e.type.k === "f" ? "float" : "str", value, type: e.type};
}
const segment = (s) => `${s.length}_${Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
export function hoistLocalConstants(body, ctx, h) {
  const {Nodes, Structures, Statements, Expressions, isTok, isExpr, isStruct, isStmt, upper, goName, initialValue, Unsupported} = h;
  ctx.localConstants = new Map();
  ctx.localConstantNames = new Set();
  const owner = `${goName(ctx.className)}__LOCAL_CONSTANT__${segment(ctx.className)}_${segment(ctx.method)}`;
  ctx.localConstantFields = new Map();
  const literalValue = (node) => {
    const val = node.findFirstExpression(Expressions.Value);
    const src = val?.getChildren().find((c) => !isTok(c));
    return src && isExpr(src, Expressions.Constant);
  };
  const add = (name, type, init) => {
    // Keep the class prefix: layered builds and frontend caches use it.
    const go = `${owner}_${segment(name)}`;
    if (ctx.program.consts.has(go)) throw new Error(`local constant name collision: ${ctx.className}=>${ctx.method}=>${name} (${go})`);
    ctx.program.consts.set(go, {go, type, ...init});
    ctx.localConstants.set(name, {e: "const", go, type});
    ctx.locals.delete(name);
  };
  const walk = (node) => {
    if (!node) return;
    if (isStruct(node, Structures.Constants)) {
      const name = upper(node.findFirstExpression(Expressions.DefinitionName).concatTokens());
      ctx.localConstantNames.add(name);
      const type = ctx.locals.get(name);
      if (type?.k !== "struct") throw new Unsupported(`CONSTANTS BEGIN OF ${name}: not a local structure`);
      const fields = ctx.program.structs.get(type.go)?.fields ?? [];
      const inits = {};
      for (const st of node.findAllStatements(Statements.Constant)) {
        const field = upper(st.findFirstExpression(Expressions.DefinitionName).concatTokens());
        const ft = fields.find((f) => f.name === field)?.type;
        if (!ft || !literalValue(st)) throw new Unsupported(`CONSTANTS ${name}-${field}: nonliteral VALUE`);
        inits[field] = initialValue(st, {...ctx, locals: new Map([[field, ft]])}).value;
      }
      const folded = Object.fromEntries(Object.entries(inits).map(([f, v]) => [f, fold(v)]));
      if (Object.values(folded).every(Boolean)) add(name, type, {fieldInits: folded});
      else ctx.localConstantFields.set(node, Object.entries(inits).map(([field, value]) => ({
        s: "assign", target: {e: "field", base: {e: "var", name, type}, name: field, type: fields.find((f) => f.name === field).type}, value,
      })));
      return;
    }
    if (isStmt(node, Statements.Constant) && literalValue(node)) {
      const name = upper(node.findFirstExpression(Expressions.DefinitionName).concatTokens());
      ctx.localConstantNames.add(name);
      const init = initialValue(node, ctx);
      const value = fold(init.value);
      if (value) add(name, init.target.type, {init: value});
      return;
    }
    if (node instanceof Nodes.StructureNode) for (const child of node.getChildren()) walk(child);
  };
  walk(body);
}
