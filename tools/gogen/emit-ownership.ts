import type {Class, Expr, Method, Type} from './ir.ts';

export interface OwnershipContext { readonly cls: Class; readonly method: Method }
// Attribute probes intentionally carry only identity, without expression type.
export interface AttributeProbe { readonly e: 'attr'; readonly name: string }
// A successful lookup identifies precisely the three storage forms supported
// by analyzeOwnership.has; reference fields intentionally remain excluded.
export type OwnedPlace = Extract<Expr, {e: 'var' | 'attr' | 'static'}>;
export interface Ownership {
  has(place: Expr | undefined, ctx: OwnershipContext): place is OwnedPlace;
  has(place: AttributeProbe, ctx: OwnershipContext): boolean | undefined;
  unescaped(place: Expr, ctx: OwnershipContext): boolean | undefined;
  fixed(place: Expr, ctx: OwnershipContext): number;
  width(place: Expr, ctx: OwnershipContext): number | undefined;
}
export interface PackedRenderers {
  readonly ownership: Ownership;
  expr(node: Expr, ctx: OwnershipContext): string;
  helper(name: string): string;
}
export interface OwnedExpressionRenderers extends PackedRenderers {
  place(node: Expr, ctx: OwnershipContext): string;
}
export interface ByteRenderers {
  expr(node: Expr, ctx: OwnershipContext): string;
  place(node: Expr, ctx: OwnershipContext): string;
  rowValue(type: Type, stored: string): string;
}
export interface OwnedRenderers extends OwnedExpressionRenderers, ByteRenderers {}
