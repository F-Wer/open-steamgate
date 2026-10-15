import type {Class, Expr, Method, Type} from './ir.ts';

export interface OwnershipContext { readonly cls: Class; readonly method: Method }
// Attribute probes intentionally carry only identity, without expression type.
export interface AttributeProbe { readonly e: 'attr'; readonly name: string }
export interface Ownership {
  has(place: Expr | AttributeProbe | undefined, ctx: OwnershipContext): boolean | undefined;
  unescaped(place: Expr, ctx: OwnershipContext): boolean | undefined;
  fixed(place: Expr, ctx: OwnershipContext): number;
  width(place: Expr, ctx: OwnershipContext): number | undefined;
}
export interface PackedRenderers {
  readonly ownership: Ownership;
  expr(node: Expr, ctx: OwnershipContext): string;
  helper(name: string): string;
}
export interface OwnedRenderers extends PackedRenderers {
  place(node: Expr, ctx: OwnershipContext): string;
  rowValue(type: Type, stored: string): string;
}
