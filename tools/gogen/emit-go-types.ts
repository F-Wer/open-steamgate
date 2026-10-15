// SPDX-License-Identifier: MIT
// Erasable contracts for emit-go.mjs. IR tags stay discriminated so the
// emitter's existing switches narrow nodes without a runtime adapter.
import type * as IR from './ir.ts';
import type {Layers as SymbolLayers, SymbolCollector} from './symbols.ts';

export type {Type, Expr, Stmt, Condition, Field, Param, Argument, Where, Catch,
  ResolvedKey, SqlColumn, SqlArgument, SqlPredicate, WriteType, TemplateOptions} from './ir.ts';
export type {SymbolCollector} from './symbols.ts';
export type TableType = Extract<IR.Type, {k: 'table'}>;
export type StructType = Extract<IR.Type, {k: 'struct'}>;
export type PackedType = Extract<IR.Type, {k: 'p'}>;
export type Conversion = Extract<IR.Expr, {e: 'conv'}>;
export type CallExpr = Extract<IR.Expr, {e: 'call'}>;
export type Builtin = Extract<IR.Expr, {e: 'fn'}>;
export type KeyLoop = Extract<IR.Stmt, {s: 'loop'}> & {readonly key: IR.ResolvedKey};
export type KeyRead = Extract<IR.Stmt, {s: 'read_seckey'}>;
export type Loop = Extract<IR.Stmt, {s: 'loop' | 'loop_data'}>;
export type KeyValues = Extract<IR.Stmt, {s: 'read_seckey' | 'delete_seckey'}>;

// These frontend fields are consumed by the emitter but are not yet all
// represented in ir.ts. Keep the extra shape here rather than widen IR tags.
export interface Local extends IR.Field {
  readonly static?: boolean;
  readonly statics?: string;
  readonly value?: LiteralValue;
  readonly init?: IR.Expr;
  readonly fieldInits?: Readonly<Record<string, IR.Expr>>;
}
export interface Attribute extends IR.Attribute {
  readonly unsupported?: string;
  readonly fromIntf?: boolean;
}
export interface Method extends Omit<IR.Method, 'locals'> {
  readonly locals?: readonly Local[];
  readonly reason?: string;
}
export interface Class extends Omit<IR.Class, 'attributes' | 'methods' | 'constructor' | 'stubs' | 'signatures'> {
  readonly attributes: readonly Attribute[];
  readonly methods: readonly Method[];
  readonly constructor: Method | null;
  readonly stubs?: readonly Method[];
  readonly signatures?: ReadonlyMap<string, Method>;
}
export type StructDefinitions = Map<string, StructType & {readonly fields: readonly IR.Field[]}>;
export type LiteralValue = string | number | {readonly [name: string]: LiteralValue};
export interface Constant {
  readonly type: IR.Type;
  readonly value?: LiteralValue;
  readonly go?: string;
  readonly init?: IR.Expr;
  readonly fieldInits?: Readonly<Record<string, IR.Expr>>;
}
export interface DatabaseTable extends IR.DatabaseTable {
  readonly row?: IR.Type;
  readonly why?: string;
  readonly hidesClient?: string;
}
export interface Rtti {
  readonly structs: ReadonlyMap<string, readonly {readonly name: string; readonly kind: string}[]>;
  readonly known: ReadonlySet<string>;
}
export interface AmcChannel {
  readonly applicationId: string;
  readonly path: string;
  readonly scope: string;
  readonly type: string;
  readonly authorities?: readonly {readonly path?: string; readonly program?: string; readonly activity?: string}[];
}
export interface Program extends Omit<IR.Program, 'classes' | 'consts' | 'tables' | 'exceptionSupers'> {
  readonly classes: readonly Class[];
  readonly consts?: Map<string, Constant>;
  readonly tables?: readonly DatabaseTable[];
  readonly exceptionSupers?: Readonly<Record<string, string>>;
  readonly rtti?: Rtti;
  readonly amcChannels?: readonly AmcChannel[];
}
// Legacy callers can pass a class array with no program metadata.
export type ClassList = Class[] & Partial<Program>;
export type ProgramInput = Program | ClassList;
export interface Layers extends Omit<SymbolLayers, 'classes' | 'consts' | 'structs'> {
  readonly classes?: readonly Class[];
  readonly consts?: Map<string, Constant>;
  readonly structs?: StructDefinitions;
}
export interface Signature {
  readonly params: readonly {readonly type?: IR.Type}[];
  readonly returning?: {readonly type: IR.Type} | null;
}
export interface ClassName { readonly name: string }

// Optional metadata probes intentionally read absent properties as undefined.
// Actual type switches use IR.Type, not this inspection view.
export type TypeProbe = IR.Type & {
  readonly len?: number;
  readonly dec?: number;
  readonly name?: string;
  readonly go?: string;
  readonly stable?: boolean;
  readonly row?: TypeProbe;
};
export interface Descriptor { readonly name: string; readonly type: TableType | StructType }
export interface NamedDescriptor { readonly name: string; readonly text: string }
export interface TryFrame { level: number; mode: 'body' | 'catch'; used: Set<number> }
export interface SinkSite { locals: readonly Local[]; depth: number }
export type SunkLocals = Map<readonly IR.Stmt[], readonly Local[]>;
export interface Context {
  readonly cls: Class;
  loop: number;
  inCtor?: boolean;
  method?: Method;
  staticStores?: Map<string, string>;
  sunkLocals?: SunkLocals;
  sinkSites?: SinkSite[];
  valueOutputs?: Set<string>;
  lrow?: string;
  builders?: Map<string, string>;
  loopLevel?: number;
  loopStack?: Loop[];
  tries?: TryFrame[];
  tryBuilderBlocked?: boolean;
}
export interface MethodContext extends Context { readonly method: Method; sinkSites: SinkSite[] }
export interface Ownership {
  readonly declarations: ReadonlySet<IR.Field>;
  unescaped(p: IR.Expr, ctx: Context): boolean | undefined;
  width(p: IR.Expr, ctx: Context): number | undefined;
  fixed(p: IR.Expr, ctx: Context): number | false | undefined;
  has(p: IR.Expr, ctx: Context): boolean | undefined;
}
export type RenderExpr = (e: IR.Expr, ctx: Context) => string;
export type RenderType = (t: IR.Type) => string;
export type RenderName = (name: string) => string;
export type MovePair = (st: IR.Stmt, next: IR.Stmt | undefined, ctx: Context, previous: IR.Stmt | undefined) => boolean;
export type AnalyzeTableMoves = (program: ProgramInput, stable: (t: TypeProbe) => boolean | undefined, goType: RenderType) => MovePair;
export type ConstructorFactories = ReturnType<typeof import("./emit-constructors.ts").constructorFactories>;
export type AnalyzeOwnership = (program: ProgramInput) => Ownership;
export type SinkLocals = (method: Method) => SunkLocals;
export type GeneratedBindings = (source: string) => Set<string> | null;
export type OmittedFactoryCall = (program: Program, cls: Class, method: Method) => IR.Expr;
export interface ExprHelpers {
  readonly ownership: Ownership;
  readonly expr: RenderExpr;
  readonly place: RenderExpr;
  readonly helper: RenderName;
}
export interface StatementHelpers extends ExprHelpers { readonly rowValue: (table: IR.Type, item: string) => string }
export type OwnedExpression = (e: IR.Expr, ctx: Context, helpers: ExprHelpers) => string | null;
export type OwnedStatement = (st: IR.Stmt, ctx: Context, indent: string, helpers: StatementHelpers) => string[] | null;
export type EmitByteConcat = (st: Extract<IR.Stmt, {s: 'concat_bytes'}>, ctx: Context, indent: string, helpers: Pick<StatementHelpers, 'expr' | 'place' | 'rowValue'>) => string[];
export type EmitByteStatement = (st: IR.Stmt, ctx: Context, indent: string, helpers: Pick<ExprHelpers, 'expr' | 'place'>) => string[];
export type EmitBuiltinGo = (e: Builtin, args: readonly string[], names: Readonly<Record<string, string>>, imports: Set<string>) => string;
export type EmitPackedInt8 = (e: Conversion, render: (e: IR.Expr) => string, helper: RenderName) => string | null;
export type EmitPackedComparison = (c: IR.Condition, render: (e: IR.Expr) => string) => string | null;
export type ExceptionClass = (cls: Class | undefined, classes: ReadonlyMap<string, Class>) => boolean;
export interface RttiHelpers { readonly goType: RenderType; readonly ident: RenderName }
export type ObjectRttiGo = (program: Program, helpers: RttiHelpers) => string[];
export interface MessageHelpers extends RttiHelpers {
  readonly classes: ReadonlyMap<string, Class>;
  readonly poly: ReadonlySet<string>;
  readonly ancestorsOf: (cls: Class) => Class[];
}
export type NativeMessageText = (program: Program, helpers: MessageHelpers) => string[];
export interface ConstantHelpers {
  readonly fields: StructDefinitions;
  readonly expr: RenderExpr;
  readonly zero: RenderType;
  readonly ident: RenderName;
  readonly struct: (type: StructType, value: string) => string;
}
export type LocalConstant = (constant: Constant, helpers: ConstantHelpers) => string | undefined;
export interface ConstantDeclarationHelpers { readonly type: RenderType; readonly literal: (constant: Constant) => string }
export type LocalConstantDeclarations = (constants: ReadonlyMap<string, Constant>, helpers: ConstantDeclarationHelpers) => string[];

// Object walkers inspect a few fields and recurse over all remaining values.
// They do not turn a generic walk into an expression/statement emitter.
export interface WalkNode {
  readonly e?: string;
  readonly s?: string;
  readonly name?: string;
  readonly owner?: string;
  readonly target?: IR.Expr;
  readonly table?: IR.Expr;
  readonly [key: string]: unknown;
}
export type EmitGo = (program: ProgramInput, pkg?: string, layers?: Layers | null, unitBuild?: boolean, symbols?: SymbolCollector | null) => string;
