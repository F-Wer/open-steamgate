import type {Expr, Type} from './ir.ts';
import type {OwnershipContext, PackedRenderers} from './emit-ownership.ts';
import {someExpression} from './ir-children.ts';

interface PackedConversion extends Extract<Expr, {e: 'conv'}> {
  readonly kind: 'p2p';
  readonly to: Extract<Type, {k: 'p'}>;
}
// The lowering tag establishes the packed destination; no extra runtime test.
function isPackedConversion(node: Expr): node is PackedConversion {
  return node.e === 'conv' && node.kind === 'p2p';
}

// Keep the measured checksum optimization in classes with owned memory.
// Packed fields and method signatures retain their ordinary string ABI.
export function packedChecksum(e: Expr, ctx: OwnershipContext, {ownership, expr, helper}: PackedRenderers): string | null {
  if (!ctx.cls.attributes?.some((a) => a.type.k === "xstring" && ownership.has({e: "attr", name: a.name}, ctx))) return null;
  if (!isPackedConversion(e) || !e.arith || e.to.dec || e.x?.e !== "bin" || e.x.op !== "+") return null;
  const {l, r} = e.x;
  if (l.e !== "var" || l.ref || l.type.k !== "p" || l.type.dec || r.e !== "conv" || r.kind !== "i2pc") return null;
  // A call may inspect escaped locals. Only an unescaped local/RETURNING sum
  // qualifies; parameters and reference actuals keep the original path.
  const mentions = (n: Expr): boolean => someExpression(n, (child) => child.e === "var" && child.name === l.name);
  if (!ownership.unescaped(l, ctx) || mentions(r.x)) return null;
  const a = expr(l, ctx), b = expr(r.x, ctx);
  return `func(a string, b int64) string { if v, ok := ${helper("packedint.Add")}(a, b, ${2 * e.to.len - 1}); ok { return v }; return abap.PFit(abap.AddP(a, abap.IToP(b)), ${e.to.len}, 0, true) }(${a}, int64(${b}))`;
}
