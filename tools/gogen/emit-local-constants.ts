import type {Constant, ConstantHelpers, ConstantDeclarationHelpers, StructType} from './emit-go-types.ts';

interface FieldConstant extends Constant {
  readonly type: StructType;
  readonly fieldInits: NonNullable<Constant['fieldInits']>;
}
// The frontend only hoists field initializers for structure constants.
function hasFieldInits(c: Constant): c is FieldConstant { return !!c.fieldInits; }
interface JsDeclarations {
  readonly js: true;
  readonly literal: ConstantDeclarationHelpers['literal'];
}

// Emit hoisted VALUE expressions through each backend's normal converter.
export function localConstant(c: Constant, {fields, expr, zero, ident, struct}: ConstantHelpers): string | undefined {
  const ctx = {cls: {}, method: {}};
  if (c.init) return expr(c.init, ctx);
  if (!hasFieldInits(c)) return undefined;
  const values = (fields.get(c.type.go)?.fields ?? []).map((f): string => {
    const init = c.fieldInits[f.name];
    return `${ident(f.name)}: ${init ? expr(init, ctx) : zero(f.type)}`;
  });
  return struct(c.type, values.join(", "));
}

// Every local initializer here was proved exception-free by the frontend.
export function localConstantDeclarations(consts: ReadonlyMap<string, Constant>, helpers: ConstantDeclarationHelpers | JsDeclarations): string[] {
  return [...consts.values()].map((c): string => helpers.js ? `const ${c.go} = ${helpers.literal(c)};` : `var ${c.go} ${helpers.type(c.type)} = ${helpers.literal(c)}`);
}
