export const staticSlot = (owner, name, type, goName) => ({e: "static", owner, name, type, go: goName(`${owner}=>${name}`)});

// Static attributes share storage in their declaring class, including inherited names.
export function resolveStatic(owner, attr, ctx, deps, write = false) {
  const {CHAR_UTILITIES, C, upper, clasDef, registerConst, localInterfaceConstant, Unsupported, ancestors, goName, typeOf, abaplint, notInProgram} = deps;
  if (!write && owner === "CL_ABAP_CHAR_UTILITIES" && CHAR_UTILITIES[attr] !== undefined) return {e: "chars", value: CHAR_UTILITIES[attr], type: C(1)};
  const intf = ctx.reg.getObject("INTF", owner)?.getDefinition();
  const clas = clasDef(ctx.reg, owner);
  const local = ctx.program.localInterfaces.get(`${ctx.program.currentOwner}|${owner}`);
  const def = intf ?? clas ?? local?.def;
  if (def === undefined) throw new Unsupported(`${owner}=>${attr}: ${owner} is not in the program`);
  const c = def.getAttributes().getConstants().find((x) => upper(x.getName()) === attr);
  if (c !== undefined) {
    if (write) throw new Unsupported(`${owner}=>${attr}: a write to a constant`);
    const go = registerConst(ctx.program, `${ctx.program.currentOwner ?? owner}:${owner}~${attr}`,
      local ? localInterfaceConstant(c, attr, local, ctx.reg) : c, owner);
    if (go === undefined) throw new Unsupported(`constant ${owner}=>${attr} is outside the subset`);
    return {e: "const", go, type: ctx.program.consts.get(go).type};
  }
  // a constant a superclass declares, named through the subclass
  // (/IWBEP/CX_MGW_NOT_IMPL_EXC=>METHOD_NOT_IMPLEMENTED, declared by
  // /IWBEP/CX_MGW_TECH_EXCEPTION): the same constant; a constant is fixed
  // at compile time, so no class constructor runs for it (ultra/zvdb)
  if (clas !== undefined && intf === undefined) {
    for (const anc of ancestors(ctx.reg, owner)) {
      const ac = clasDef(ctx.reg, anc)?.getAttributes().getConstants().find((x) => upper(x.getName()) === attr);
      if (ac === undefined) continue;
      if (write) throw new Unsupported(`${owner}=>${attr}: a write to a constant`);
      const go = registerConst(ctx.program, `${anc}~${attr}`, ac, anc);
      if (go === undefined) throw new Unsupported(`constant ${anc}=>${attr} is outside the subset`);
      return {e: "const", go, type: ctx.program.consts.get(go).type};
    }
  }
  // an alias of an interface for a constant of an interface it includes
  // (IF_APC_WSP_EXTENSION=>CO_CONNECT_MODE_REJECT for
  // IF_APC_WSP_EXTENSION_COMMON~CO_CONNECT_MODE_REJECT)
  const alias = (def.getAliases?.() ?? []).find((x) => upper(x.getName()) === attr);
  const comp = alias === undefined ? [] : upper(alias.getComponent()).split("~");
  if (comp.length === 2 && comp[0] !== owner) return resolveStatic(comp[0], comp[1], ctx, deps, write);
  for (const at of [owner, ...(clas ? ancestors(ctx.reg, owner) : [])]) {
    const a = clasDef(ctx.reg, at)?.getAttributes().getStatic().find((x) => upper(x.getName()) === attr);
    if (!a) continue;
    const pool = ctx.reg.getObject("CLAS", at.split(":")[0]);
    const friendName = ctx.className.split(":").at(-1);
    const globalFriend = (clasDef(ctx.reg, at)?.getFriends?.() ?? []).some((f) => upper(typeof f === "string" ? f : f.getName()) === ctx.className);
    const localFriend = ctx.className.startsWith(`${at.split(":")[0]}:`) && (pool?.getABAPFiles() ?? []).some((f) => f.getStatements().some((st) => {
      const text = st.concatTokens().toUpperCase();
      return text.startsWith(`CLASS ${at.split(":").at(-1)} DEFINITION LOCAL FRIENDS `) && text.split(/\bLOCAL FRIENDS\b/)[1].match(/[A-Z_][A-Z0-9_]*/g)?.includes(friendName);
    }));
    const friend = globalFriend || localFriend;
    const inside = friend || ctx.className === at || ancestors(ctx.reg, ctx.className).includes(at);
    if (a.getVisibility() !== abaplint.Visibility.Public && !(inside && (friend || ctx.className === at || a.getVisibility() === abaplint.Visibility.Protected))) {
      throw new Unsupported(`${owner}=>${attr} is ${a.getVisibility() === abaplint.Visibility.Private ? "private" : "protected"} to ${at}`);
    }
    const file = pool?.getABAPFiles().find((f) => f.getFilename() === a.getFilename());
    // ClassDataBegin is absent from core's info attributes, and its readOnly
    // flag also matches VALUE literals. Locate the declaration by its name token.
    const {Statements, Expressions, Nodes} = abaplint;
    const declaration = file?.getStatements().find((st) =>
      [Statements.ClassData, Statements.ClassDataBegin, Statements.Data, Statements.DataBegin].some((kind) => st.get() instanceof kind)
      && st.getTokens().some((token) => token.getStart().equals(a.getToken().getStart())));
    const hasReadOnly = (node, trailing = false) => {
      const children = node?.getChildren() ?? [];
      return children.some((c, i) => (!trailing || i === children.length - 3)
        && c instanceof Nodes.TokenNode && upper(c.getFirstToken().getStr()) === "READ"
        && children[i + 1] instanceof Nodes.TokenNode && children[i + 1].getFirstToken().getStr() === "-"
        && children[i + 2] instanceof Nodes.TokenNode && upper(children[i + 2].getFirstToken().getStr()) === "ONLY");
    };
    const data = declaration?.findDirectExpression(Expressions.DataDefinition);
    // A keyed table consumes READ-ONLY in TypeTableKey. Do not search through
    // arbitrary descendants: VALUE/Constant/Source may contain the same text.
    const keyedReadOnly = data?.findDirectExpression(Expressions.TypeTable)
      ?.findDirectExpressions(Expressions.TypeTableKey).some((key) => hasReadOnly(key, true));
    const readOnly = hasReadOnly(declaration) || hasReadOnly(data) || keyedReadOnly;
    if (write && !inside && readOnly) {
      throw new Unsupported(`${owner}=>${attr}: a write to a READ-ONLY attribute outside ${at}`);
    }
    if (!ctx.program.wanted.has(at)) throw notInProgram(ctx, at, `${owner}=>${attr}: ${at} is not compiled in this program`);
    return staticSlot(at, attr, typeOf(a.getType(), `${at}=>${attr}`, ctx.program), goName);
  }
  throw new Unsupported(`${owner}=>${attr}`);
}
