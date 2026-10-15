import type {Expr, Conversion, Condition, RenderName} from './emit-go-types.ts';

type RenderOperand = (e: Expr) => string;

// An integral packed expression can use int64 without changing its IR type.
// Fractional intermediates, wide values and side effects retain the p path.
export const I8_OPS: ReadonlyMap<string, string> = new Map([
  ['+', 'abap.AddI8'], ['-', 'abap.SubI8'], ['*', 'abap.MulI8'],
  ['/', 'abap.DivI8'], ['DIV', 'abap.DivIntI8'], ['MOD', 'abap.ModI8'],
]);
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
const literal = (e: Expr): bigint | null => {
  if (e.e === "neg") { const v = literal(e.x); return v === null ? null : -v; }
  return e.e === "str" && e.type?.k === "p" && e.type.calc && /^-?\d+$/.test(e.value) ? BigInt(e.value) : null;
};
const pure = (e: Expr | null | undefined): boolean => {
  if (!e || ("ref" in e && e.ref) || ("fromP" in e && e.fromP)) return false;
  switch (e.e) {
    case "var": case "attr": case "int": return true;
    case "field": return pure(e.base);
    case "conv": return !e.fields && !e.pairs && pure(e.x) && (!e.row || pure(e.row));
    default: return false;
  }
};
export function integerPackedOperand(e: Expr, render: RenderOperand): string | null {
  const value = literal(e);
  if (value !== null) return value >= MIN && value <= MAX ? `int64(${value})` : null;
  if (e.e === "conv" && e.kind === "i2pc" && ["i", "int8"].includes(e.from.k) && pure(e.x)) return `int64(${render(e.x)})`;
  return null;
}
export function emitPackedInt8(e: Conversion, render: RenderOperand, helper: RenderName): string | null {
  if (e.kind !== "p2i8") return null;
  const leaf = integerPackedOperand(e.x, render);
  if (leaf !== null) return leaf;
  if (!e.arith) return null;
  let operations = 0;
  const walk = (n: Expr, root = false): string | null => {
    const operand = integerPackedOperand(n, render);
    if (operand !== null) return operand;
    if (n.e === "neg") { const x = walk(n.x); operations++; return x === null ? null : `abap.SubI8(0, ${x})`; }
    if (n.e !== "bin" || !I8_OPS.has(n.op) || (n.op === "/" && !root)) return null;
    const l = walk(n.l), r = walk(n.r);
    operations++;
    return l === null || r === null ? null : `${I8_OPS.get(n.op)}(${l}, ${r})`;
  };
  const fast = walk(e.x, true);
  if (fast === null) return null;
  // A single operator has no wider intermediate to preserve. For compound
  // trees, retry the original expression if any integral intermediate spills.
  if (operations === 1) return fast;
  // A root / over a compound tree may round twice in the packed calculation.
  if (e.x.e === "bin" && e.x.op === "/") return null;
  return `${helper("intarith.Packed")}(func() int64 { return ${fast} }, func() int64 { return abap.PToI8(${render(e.x)}, true) })`;
}
export function emitPackedComparison(c: Condition, render: RenderOperand): string | null {
  if (c.c !== "cmp" || c.type?.k !== "p") return null;
  const l = integerPackedOperand(c.l, render), r = integerPackedOperand(c.r, render);
  return l === null || r === null ? null : `${l} ${c.op === "=" ? "==" : c.op === "<>" ? "!=" : c.op} ${r}`;
}
