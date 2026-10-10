// Literal local CONSTANTS use exactly the ordinary VALUE conversion, but the
// resulting expression belongs to the program, not a method activation.
export function hoistLocalConstants(body, ctx, h) {
  const {Nodes, Structures, Statements, Expressions, isTok, isExpr, isStruct, isStmt, upper, goName, initialValue, Unsupported} = h;
  ctx.localConstants = new Map();
  const literalValue = (node) => {
    const val = node.findFirstExpression(Expressions.Value);
    const src = val?.getChildren().find((c) => !isTok(c));
    return src && isExpr(src, Expressions.Constant);
  };
  const add = (name, type, init) => {
    // Keep the class prefix: layered builds and frontend caches use it.
    const go = goName(`${ctx.className}=>LOCAL_CONSTANT=>${ctx.method}=>${name}`);
    ctx.program.consts.set(go, {go, type, ...init});
    ctx.localConstants.set(name, {e: "const", go, type});
    ctx.locals.delete(name);
  };
  const walk = (node) => {
    if (!node) return;
    if (isStruct(node, Structures.Constants)) {
      const name = upper(node.findFirstExpression(Expressions.DefinitionName).concatTokens());
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
      add(name, type, {fieldInits: inits});
      return;
    }
    if (isStmt(node, Statements.Constant) && literalValue(node)) {
      const name = upper(node.findFirstExpression(Expressions.DefinitionName).concatTokens());
      const init = initialValue(node, ctx);
      add(name, init.target.type, {init: init.value});
      return;
    }
    if (node instanceof Nodes.StructureNode) for (const child of node.getChildren()) walk(child);
  };
  walk(body);
}
