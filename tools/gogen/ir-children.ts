import type {Expr as RuntimeExpr, Stmt, Condition as RuntimeCondition, Type as RuntimeType} from './emit-go-types.ts';
import type {Expr, Condition, Argument, Type, Field, SecondaryKey, TableKey,
  TemplatePart, TemplateOptions, ArithmeticBranches, Exceptions} from './ir.ts';

// Visit every own enumerable property in its original insertion order. Keep
// wrapper records and arrays: ownership analysis depends on that traversal.
// The two emitter predicates historically exclude only type; ownership also
// excludes pos. Do not replace this with a reordered list of expression edges.
type PropertyValue<T> = T extends object ? T[keyof T] : never;
export function children<T extends object>(node: T, excluded: readonly string[] = ['type', 'pos']): readonly PropertyValue<T>[] {
  const keys = Object.keys(node) as (keyof T & string)[];
  return keys.filter((key) => !excluded.includes(key)).map((key) => node[key] as PropertyValue<T>);
}

interface ConversionField { readonly name: string; readonly len: number }
interface ConditionalBranch { readonly cond: Condition; readonly value: Expr }
interface RefusedBranch { readonly reason: string }
// This is the complete expression property graph, including non-expression
// records. The recursive call below checks its closure against every IR union
// member, so new child shapes cannot silently disappear from the traversal.
type ExpressionNode = Expr | Condition | Argument | Type | Field | SecondaryKey | TableKey |
  TemplatePart | TemplateOptions | ArithmeticBranches | Exceptions | Exceptions['map'] |
  ConversionField | ConditionalBranch | RefusedBranch;
type ExpressionValue = ExpressionNode | readonly ExpressionValue[] | string | number | boolean | null | undefined;
function isArray(value: ExpressionValue): value is readonly ExpressionValue[] { return Array.isArray(value); }
function isExpression(node: ExpressionNode): node is Expr { return 'e' in node && typeof node.e === 'string'; }

export function someExpression(value: ExpressionValue, predicate: (node: Expr) => boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  if (isArray(value)) return value.some((child) => someExpression(child, predicate));
  if (isExpression(value) && predicate(value)) return true;
  return children(value, ['type']).some((child) => someExpression(child, predicate));
}

// Full runtime property graph for the storage analyses. Derive wrapper records
// (branches, arguments, SQL assignments, etc.) from the shared contracts rather
// than copying their shapes. Three levels reach all non-recursive wrappers;
// children(node) below checks that the graph stays closed as the IR evolves.
type ObjectValues<T> = T extends readonly (infer V)[] ? ObjectValues<V> : T extends object ? T : never;
type ChildObjects<T> = ObjectValues<PropertyValue<T>>;
type Roots = RuntimeExpr | Stmt | RuntimeCondition | RuntimeType;
type Wrappers = ChildObjects<Roots>;
type NestedWrappers = ChildObjects<Wrappers>;
export type IRNode = Roots | Wrappers | NestedWrappers | ChildObjects<NestedWrappers>;
export type IRValue = IRNode | readonly IRValue[] | string | number | boolean | null | undefined;
export function isIRArray(value: IRValue): value is readonly IRValue[] { return Array.isArray(value); }
export function isExpr(value: IRNode): value is RuntimeExpr { return 'e' in value && typeof value.e === 'string'; }
export function isStmt(value: IRNode): value is Stmt { return 's' in value && typeof value.s === 'string'; }
export function isCondition(value: IRNode): value is RuntimeCondition { return 'c' in value && typeof value.c === 'string'; }
export function irChildren(node: IRNode, excluded: readonly string[] = ['type', 'pos']): readonly IRValue[] {
  return children(node, excluded);
}
export function entries<T extends object>(node: T): readonly (readonly [string, PropertyValue<T>])[] {
  const keys = Object.keys(node) as (keyof T & string)[];
  return keys.map((key) => [key, node[key] as PropertyValue<T>] as const);
}
export function irEntries(node: IRNode): readonly (readonly [string, IRValue])[] {
  return entries(node);
}
