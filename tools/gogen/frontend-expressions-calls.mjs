import {Nodes, Expressions, Unsupported, I, F, INT8, P31, S, C, X, XS, EXC,
  isExpr, upper, numeric, charlike} from "./frontend-base.mjs";
import {BIT_OPS, call, cond, constructor, convert, defaultValue, descrAttr, fieldChain,
  findAttribute, genericArith, hasArith, hasBitOp, hasPow, items, leafTypes, template} from "./frontend.mjs";
import {fieldOf} from "./frontend-types-signatures.mjs";
import {textLiteral} from "./frontend-literals.ts";

/**
 * One Source as IR. When it is arithmetic, every operator runs in the
 * calculation type of all its leaves plus `outer` (the target, or the other
 * side of a comparison), as ABAP computes it.
 */
/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {import("./ir.ts").Type} [outer] @param {import("./ir.ts").Type} [hint] @returns {import("./frontend-types.ts").ValueExpr} */ function source(node, ctx, outer, hint = outer) {
  const sk = node?.getChildren?.() ?? [];
  if (sk.length === 3 && isExpr(sk[0], Expressions.MethodCallChain) && isExpr(sk[1], Expressions.Arrow) && isExpr(sk[2], Expressions.AttributeChain)) return descrAttr(sk[0], sk[2], ctx);
  if (!hasArith(node)) return arith(node, ctx, undefined, hint);
  if (outer?.k === "d") {
    const parts = items(node);
    if (parts.length === 3 && ["+", "-"].includes(parts[1].op) && parts[0].node && parts[2].node) {
      const date = sourceOperand(parts[0].node, ctx);
      const days = sourceOperand(parts[2].node, ctx);
      if (date.type.k === "d" && days.type.k === "i") return {e: "date_add", date, days, subtract: parts[1].op === "-", type: outer};
    }
  }
  const bits = hasBitOp(node);
  if (bits) {
    // Bit expressions calculate to the longest operand, padding on the right.
    const leaves = leafTypes(node, ctx);
    if (!leaves.every((t) => t.k === "x" || t.k === "xstring")) {
      throw new Unsupported(`bit operation on other than x fields of one length: ${node.concatTokens()}`);
    }
    if (leaves.every((t) => t.k === "x")) {
      return arith(node, ctx, X(leaves.reduce((max, t) => Math.max(max, t.len), -Infinity)));
    }
    // Retain the existing dynamic AND/OR refusal; CRC needs only XOR.
    const ops = node.getChildren().filter((c) => isExpr(c, Expressions.ArithOperator)).map((c) => upper(c.concatTokens()));
    if (ops.every((o) => o === "BIT-XOR")) return arith(node, ctx, XS);
    throw new Unsupported(`${ops.find((o) => o !== "BIT-XOR")} of xstrings: not measured: ${node.concatTokens()}`);
  }

  // ultra/itab: a generic operand or a generic target decides the
  // calculation type at run time (genericArith)
  const genericLeaves = leafTypes(node, ctx).some((t) => t.k === "data");
  if (outer?.k === "data" && !genericLeaves && !ctx.genTarget) return convert(source(node, ctx), outer);
  if (outer?.k === "data" || genericLeaves) return genericArith(node, ctx, outer);
  // an x target computes as i and the i result is converted into it
  // (measured on A4H 2026-09-23 for i MOD 256 into x LENGTH 1: 255 and -1
  // both give FF, 300 gives 2C)
  const target = outer?.k === "x" ? I : outer;
  // an x or xstring operand is its move into an i (the last four bytes,
  // ZCL_GOGEN_T_XMOVI) and counts as an i for the calculation type (A4H
  // 2026-09-24, ZCL_GOGEN_T_XARITH: 'EDB88320' DIV 2 is -153337456, x1 FF
  // + 1 is 256, x8 ...000000FF is 255, x1 0A + p 1.5 is 11.50 in p, 07 / 2
  // into i is 4); arith converts such a leaf to i first
  const leaves = leafTypes(node, ctx).map((t) => (["x", "xstring", "d", "t"].includes(t.k) ? I : t));
  // A character or numeric-text target does not take part: compute from the
  // operands, then MOVE the result (JS oracle: adt-cases calculation probe).
  const charTarget = target !== undefined && (charlike(target) || target.k === "n");
  const types = [...leaves, ...(target === undefined || charTarget ? [] : [target])];
  // ** computes in f when the operands are integers (measured on A4H:
  // 2 ** 31 into i overflows "converting from '2.14748e+09'")
  if (types.some((t) => t.k === "f") || hasPow(node)) return arith(node, ctx, F);
  if (types.some((t) => t.k === "x")) throw new Unsupported(`calculation type of an x operand: ${node.concatTokens()}`);
  // calculation type p (A4H 2026-09-24, ZCL_GOGEN_T_PDCALC): a p operand or
  // a p target, and a c or string operand too (`lv_s / 2 * 2` into i is 7
  // for lv_s = '7', not 8), ahead of int8 (int8 / 3 into p is
  // 1666666666.67). + - * are exact, / keeps 31 significant digits
  if (types.some((t) => t.k === "p" || charlike(t))) {
    const odd = types.find((t) => !["p", "i", "int8", "c", "string"].includes(t.k));
    if (odd) throw new Unsupported(`calculation type p with a ${odd.k} operand: ${node.concatTokens()}`);
    return arith(node, ctx, P31);
  }
  if (types.some((t) => t.k === "int8")) return arith(node, ctx, INT8);
  // a d operand counts its days as an i (measured on A4H: ( d / 7 ) * 7
  // into i rounds in between, so the calculation type is i, not p); a d
  // target (days back into a date) is not measured
  if (types.some((t) => t.k === "d") && outer?.k !== "d" && types.every((t) => t.k === "i" || t.k === "d")) return arith(node, ctx, I);
  if (types.every((t) => t.k === "i")) return arith(node, ctx, I);
  throw new Unsupported(`calculation type of ${node.concatTokens()}`);
}

/** a ComponentChain (a-b-c) read off a structured value */
/** @param {import("./frontend-types.ts").ValueExpr} v @param {import("./frontend-types.ts").SyntaxNode} chain @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr} */ function componentsOf(v, chain, ctx) {
  for (const c of chain.getChildren()) {
    if (c.concatTokens() === "-") continue;
    if (isExpr(c, Expressions.ComponentChain) || isExpr(c, Expressions.ComponentChainSimple)) {
      v = componentsOf(v, c, ctx);
      continue;
    }
    if (!isExpr(c, Expressions.ComponentName)) throw new Unsupported(`component chain ${chain.concatTokens()}`);
    const f = fieldOf(ctx, v.type, c.concatTokens(), chain.concatTokens());
    v = {e: "field", base: v, name: f.name, type: f.type};
  }
  return v;
}

/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @param {import("./ir.ts").Type} [calc] @param {import("./ir.ts").Type} [hint] @returns {import("./frontend-types.ts").ValueExpr} */ function arith(node, ctx, calc, hint) {
  const its = items(node);
  let negate = false;
  while (its.length > 0 && its[0].sign !== undefined) {
    if (its.shift().sign === "-") negate = !negate;
  }
  /** @param {import("./frontend-types.ts").ExpressionItem} item @param {import("./ir.ts").Type} [t] @returns {import("./frontend-types.ts").ValueExpr} */ const value = (item, t) => {
    if (item.ctor) { const v = constructor(item.ctor, ctx, item.hint); return t === undefined ? v : convert(v, t); }
    if (item.bool) {
      // xsdbool: a c(1) 'X' or blank; boolc: a string 'X' or ' '
      const v = {e: "bool", cond: cond(item.cond, ctx), blank: item.bool === "BOOLC" ? " " : "", type: item.bool === "BOOLC" ? S : C(1)};
      return t === undefined ? v : convert(v, t);
    }
    if (item.descr) { const v = descrAttr(item.descr.call, item.descr.attr, ctx); return t === undefined ? v : convert(v, t); }
    if (item.group !== undefined) return arith(item.group, ctx, t);
    if (isExpr(item.node, Expressions.Source)) return arith(item.node, ctx, t);
    let v = sourceOperand(item.node, ctx, t === undefined ? item.hint : t);
    if (item.comps) v = componentsOf(v, item.comps, ctx);
    // Byte, date and time operands enter arithmetic through their integer
    // value (dates in days, times in seconds), before the calculation type.
    if (t !== undefined && ["x", "xstring", "d", "t"].includes(v.type.k) && !["x", "xstring", "i"].includes(t.k)) v = convert(v, I);
    return t === undefined ? v : convert(v, t);
  };
  /** @type {import("./frontend-types.ts").ValueExpr} */ let expr;
  if (its.length === 3 && its[1].concat) {
    expr = {e: "concat", l: convert(value(its[0]), S), r: convert(value(its[2]), S), type: S};
  } else if (its.length === 3 && its[1].op !== undefined) {
    const op = its[1].op;
    if (calc === undefined) throw new Unsupported(`arithmetic without a calculation type: ${node.concatTokens()}`);
    if (op === "**" && calc.k !== "f") throw new Unsupported(`** with calculation type ${calc.k}`);
    if (BIT_OPS.has(op) !== (calc.k === "x" || calc.k === "xstring")) throw new Unsupported(`${op} with calculation type ${calc.k}`);
    expr = {e: "bin", op, l: value(its[0], calc), r: value(its[2], calc), type: calc};
  } else if (its.length === 1) {
    // a lone constructor takes its # from where the value goes
    expr = value({...its[0], hint}, calc);
  } else {
    throw new Unsupported(`expression shape: ${node.concatTokens()}`);
  }
  if (!negate) return expr;
  if (!numeric(expr.type) && expr.type.k !== "p") throw new Unsupported("unary minus on a non-number");
  return {e: "neg", x: expr, type: expr.type};
}

/** one operand: a field chain, a literal, a call, a template, a constructor */
/** @param {import("./frontend-types.ts").SyntaxNode} n @param {import("./frontend-types.ts").MethodContext} ctx @param {import("./ir.ts").Type} [hint] @returns {import("./frontend-types.ts").ValueExpr} */ function sourceOperand(n, ctx, hint) {
  if (isExpr(n, Expressions.Source)) return source(n, ctx);
  if (isExpr(n, Expressions.FieldChain) || isExpr(n, Expressions.SourceField)) return fieldChain(n, ctx);
  if (isExpr(n, Expressions.Constant)) {
    const int = n.findDirectExpression(Expressions.Integer);
    if (int !== undefined) {
      const value = Number(int.concatTokens());
      // a number literal past the range of i is a p literal in ABAP (31
      // digits at most), held as its digits like every p value
      if (Math.abs(value) > 2147483647) {
        const digits = int.concatTokens().replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1");
        if (!/^-?\d{1,31}$/.test(digits)) throw new Unsupported(`integer literal ${int.concatTokens()}`);
        return {e: "str", value: digits, type: P31};
      }
      if (!Number.isSafeInteger(value)) throw new Unsupported(`integer literal ${value}`);
      return {e: "int", value, type: I};
    }
    const lit = textLiteral(n, Expressions);
    if (lit.refusal !== undefined) throw new Unsupported(`literal ${n.concatTokens()}${lit.refusal}`);
    return lit.quote === "`" ? {e: "str", value: lit.value, type: S} : {e: "chars", value: lit.value.replace(/ +$/, ""), type: C(Math.max(1, lit.value.length))};
  }
  if (isExpr(n, Expressions.MethodCallChain)) return call(n, ctx, false, hint);
  if (isExpr(n, Expressions.StringTemplate)) return template(n, ctx);
  throw new Unsupported(`operand ${n.get().constructor.name}: ${n.concatTokens()}`);
}

/*
 * ultra/events: the old CALL METHOD m / obj->m / cls=>m [EXPORTING ...]
 * [IMPORTING ...] [CHANGING ...] [RECEIVING ...] [EXCEPTIONS ...] (ZCL_OSD_NOTE
 * calls the HTML viewer so) as the method call chain the functional form
 * parses into, so call() reads it the same way; undefined for any other shape
 */
/** @param {import("@abaplint/core").Nodes.StatementNode} node @returns {import("@abaplint/core").Nodes.ExpressionNode | undefined} */ function callMethodChain(node) {
  const ms = node.findDirectExpression(Expressions.MethodSource);
  const body = node.findDirectExpression(Expressions.MethodCallBody);
  if (!ms || ms.findDirectExpression(Expressions.Dynamic)) return undefined;
  const mk = ms.getChildren();
  const nameFrom = mk.length === 1 ? mk[0] : mk.length === 3 && isExpr(mk[2], Expressions.AttributeName) ? mk[2] : null;
  if (!nameFrom || (mk.length === 1 && !isExpr(mk[0], Expressions.SourceField))) return undefined;
  /** @param {import("./frontend-types.ts").SyntaxNode} n @returns {import("@abaplint/core").Nodes.TokenNode[]} */ const tokens = (n) => (n instanceof Nodes.TokenNode ? [n] : n.getChildren().flatMap(tokens));
  const name = new Nodes.ExpressionNode(new Expressions.MethodName());
  name.setChildren(tokens(nameFrom));
  const kids = [name];
  if (body) {
    const mp = body.findDirectExpression(Expressions.MethodParameters);
    if (!mp || body.getChildren().length !== 1) return undefined;
    const param = new Nodes.ExpressionNode(new Expressions.MethodCallParam());
    param.setChildren([mp]);
    kids.push(param);
  }
  const mc = new Nodes.ExpressionNode(new Expressions.MethodCall());
  mc.setChildren(kids);
  const chain = new Nodes.ExpressionNode(new Expressions.MethodCallChain());
  chain.setChildren(mk.length === 1 ? [mc] : [mk[0], mk[1], mc]);
  return chain;
}

/** x when it holds an exception value: a local caught INTO, or an attribute
 * (a report's global) a CATCH of runtime exceptions takes INTO */
/** @param {string} v @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").ValueExpr | undefined} */ function excHolder(v, ctx) {
  const n = upper(v);
  if (ctx.locals?.get(n)?.k === "exc") return {e: "var", name: n, type: EXC};
  if (ctx.locals?.has(n) || ctx.sig?.params.some((x) => x.name === n) || ctx.sig?.returning?.name === n) return undefined;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(n) || !ctx.program.excAttrs?.has(`${ctx.className}|${n}`)) return undefined;
  return findAttribute(ctx, n);
}

// Shared with an ordinary method call whose importing argument is omitted.
/** @param {import("./frontend-types.ts").FrontendParam} p @param {import("./frontend-types.ts").NamedContext} ctx @returns {import("./ir.ts").Argument} */ function omittedArgument(p, ctx) {
  return {dir: "importing", byValue: p.byValue, type: p.type,
    value: p.default !== undefined ? defaultValue(p, ctx) : {e: "zero", type: p.type}};
}

// Host exceptions use the ordinary call IR, including defaults, references,
// output temporaries and IS SUPPLIED flags. No constructor shortcut is used.
/** @param {import("./ir.ts").Program | import("./frontend-types.ts").FrontendProgram} program @param {{name: string}} cls @param {import("./frontend-types.ts").FactoryMethod} method @returns {Extract<import("./frontend-types.ts").ValueExpr, {e: "call"}>} */ function omittedFactoryCall(program, cls, method) {
  const ctx = {program, reg: program.reg, className: cls.name};
  const args = method.params.map((p) => p.suppliedOf
    ? {dir: "importing", byValue: true, type: p.type, value: {e: "chars", value: "", type: p.type}}
    : p.dir === "importing" ? omittedArgument(p, ctx) : {dir: p.dir, place: null, type: p.type});
  return {e: "call", owner: cls.name, method: method.name, static: true, args,
    type: method.returning.type, callee: method.name};
}

export {source, componentsOf, arith, sourceOperand, callMethodChain, excHolder,
  omittedArgument, omittedFactoryCall};
