// SPDX-License-Identifier: MIT
// Erasable contracts for emit-go.mjs. IR tags stay discriminated so the
// emitter's existing switches narrow nodes without a runtime adapter.
import type * as IR from './ir.ts';
import type {Layers as SymbolLayers} from './symbols.ts';

export type {Type, Field, Param, ResolvedKey, SqlColumn, WriteType, TemplateOptions} from './ir.ts';
export type SymbolCollector = (cls: Class, method: Method, go: string, receiver: string | null) => void;
// Reuse the IR tags while carrying the frontend's additional runtime shapes
// through nested operands, arguments, conditions and statement bodies too.
type RuntimeValue<T> = T extends IR.Expr ? Expr : T extends IR.Stmt ? Stmt
  : T extends IR.Condition ? Condition : T extends IR.Catch ? Catch
    : T extends IR.SqlPredicate ? SqlPredicate : T extends readonly (infer V)[] ? readonly RuntimeValue<V>[]
    : T extends object ? RuntimeFields<T> : T;
type RuntimeFields<T> = T extends object ? {readonly [K in keyof T]: K extends 'assign'
  ? readonly (SqlAssignment | null)[] : RuntimeValue<T[K]>} : T;
type RawCall = Extract<IR.Expr, {e: 'call'}>;
export type CallExpr = RuntimeFields<Omit<RawCall, 'owner' | 'static' | 'callee'>> & {
  readonly owner?: string | null;
  readonly static?: boolean;
  readonly callee?: string;
};
// Ownership probes also synthesize substrings without the renderer's base hint.
export interface SubstringExpr extends Omit<RuntimeFields<Extract<IR.Expr, {e: 'substr'}>>, 'base'> {
  readonly base?: IR.Type;
}
export type Expr = RuntimeFields<Exclude<IR.Expr, {e: 'call' | 'int' | 'substr'}>> | CallExpr | SubstringExpr
  | {readonly e: 'int' | 'float'; readonly value: number; readonly type?: IR.Type};
export interface LockField extends Pick<IR.TableColumn, 'name' | 'kind'> { readonly length: number }
type StatementFields<T> = T extends {s: 'call_enq'} ? Omit<T, 'fields'> & {readonly fields?: readonly LockField[]}
  : T extends {s: 'concat'} ? Omit<T, 'sep'> & {readonly sep: Expr | null}
  : T extends {s: 'select_dyn'} ? Omit<T, 'fields' | 'where'> & {readonly fields: Expr | null; readonly where: Expr | null}
  : T extends {s: 'stub' | 'kernel_loop'} ? Omit<T, 'pos'> & {readonly pos?: IR.Position}
  : T extends {s: 'call_dyn_static'} ? Omit<T, 'cls'> & {readonly cls: string | Expr}
  : T extends {s: 'loop'} ? Omit<T, 'key' | 'dynamicKeys'> & {
    readonly key?: IR.ResolvedKey | null;
    readonly dynamicKeys?: {readonly value: Expr; readonly options: readonly IR.ResolvedKey[]} | null;
  } : T extends {s: 'insert_sorted'} ? Omit<T, 'keys' | 'refInto'> & {
    readonly keys: readonly SortKey[]; readonly refInto?: Expr | null; readonly unique?: boolean;
  } : T extends {s: 'select_loop' | 'select_table' | 'select_single' | 'select_aggregate'} ? Omit<T, 'target'> & {readonly target: Expr | null}
    : T;
export type Stmt = StatementFields<RuntimeFields<IR.Stmt>> & {readonly pos?: IR.Position; readonly moveTable?: boolean};
export type Condition = RuntimeFields<Exclude<IR.Condition, {c: 'cmp'}>>
  | (RuntimeFields<Omit<Extract<IR.Condition, {c: 'cmp'}>, 'type'>> & {readonly type?: IR.Type});
export type Argument = RuntimeFields<IR.Argument>;
export type Where = RuntimeFields<IR.Where>;
export type Catch = RuntimeFields<Omit<IR.Catch, 'into' | 'intoKind' | 'intoType' | 'classes'>> & {
  readonly classes?: readonly string[]; readonly into?: string | null;
  readonly intoKind?: 'exc' | 'ref' | null; readonly intoType?: IR.Type | null;
};
export type SortKey = Omit<IR.SortKey, 'type'> & {readonly type?: IR.Type};
export type SqlAssignment = RuntimeFields<IR.SqlAssignment> & {readonly place?: Expr};
export type SqlArgument = RuntimeFields<IR.SqlArgument>;
export type SqlPredicate = Omit<IR.SqlPredicate, 'range' | 'type' | 'kind' | 'lowLen'> & {
  readonly range: Expr; readonly type: IR.WriteType; readonly kind?: string; readonly lowLen?: number;
};
export type TableType = Extract<IR.Type, {k: 'table'}>;
export type StructType = Extract<IR.Type, {k: 'struct'}>;
export type PackedType = Extract<IR.Type, {k: 'p'}>;
export type Conversion = Extract<Expr, {e: 'conv'}>;
export type Builtin = Extract<Expr, {e: 'fn'}>;
export type KeyLoop = Extract<Stmt, {s: 'loop'}> & {readonly key: IR.ResolvedKey};
export type KeyRead = Extract<Stmt, {s: 'read_seckey'}>;
export type Loop = Extract<Stmt, {s: 'loop' | 'loop_data'}>;
export type KeyValues = Extract<Stmt, {s: 'read_seckey' | 'delete_seckey'}>;

// These frontend fields are consumed by the emitter but are not yet all
// represented in ir.ts. Keep the extra shape here rather than widen IR tags.
export interface Local extends IR.Field {
  readonly static?: boolean;
  readonly statics?: string;
  readonly value?: LiteralValue;
  readonly init?: Expr;
  readonly fieldInits?: Readonly<Record<string, Expr | undefined>>;
}
export interface SupportedAttribute extends Omit<IR.Attribute, 'value'> {
  readonly value?: LiteralValue | Expr;
  readonly unsupported?: undefined;
  readonly fromIntf?: string | boolean;
  readonly intf?: string;
  readonly readOnly?: boolean;
}
export interface UnsupportedAttribute extends Omit<SupportedAttribute, 'type' | 'unsupported'> {
  readonly type?: IR.Type;
  readonly unsupported: string;
}
export type Attribute = SupportedAttribute | UnsupportedAttribute;
export interface Method extends Omit<IR.Method, 'locals' | 'body'> {
  readonly locals?: readonly Local[];
  readonly body?: readonly Stmt[];
  readonly reason?: string;
}
export interface UnsupportedMethod {
  readonly name: string;
  readonly unsupported: string;
  readonly params?: readonly IR.Param[];
  readonly returning?: IR.Field | null;
  readonly static?: boolean;
  readonly private?: boolean;
  readonly abstract?: boolean;
}
export interface Class extends Omit<IR.Class, 'attributes' | 'methods' | 'constructor' | 'stubs' | 'signatures' | 'super'> {
  readonly attributes: readonly Attribute[];
  readonly methods: readonly Method[];
  readonly constructor: Method | null;
  readonly stubs?: readonly Method[];
  readonly signatures?: ReadonlyMap<string, Method | UnsupportedMethod>;
  readonly super?: string | null;
}
export type StructDefinitions = Map<string, StructType & {readonly fields: readonly IR.Field[]}>;
export type LiteralValue = string | number | {readonly [name: string]: LiteralValue | undefined};
export interface Constant {
  readonly type: IR.Type;
  readonly value?: LiteralValue | Expr;
  readonly go?: string;
  readonly init?: Expr;
  readonly fieldInits?: Readonly<Record<string, Expr | undefined>>;
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
  readonly scope: string | undefined;
  readonly type: string;
  readonly authorities?: readonly {readonly path?: string; readonly program?: string; readonly activity?: string}[];
}
export interface FunctionModule extends Omit<IR.FunctionModule, 'sig' | 'module'> {
  readonly module: Exclude<IR.FunctionModule['module'], IR.Method> | Method;
  readonly sig: Method | UnsupportedMethod;
}
export interface Program extends Omit<IR.Program, 'functionModules' | 'classes' | 'consts' | 'tables' | 'exceptionSupers' | 'reg' | 'structs' | 'interfaceAttrs' | 'intfOwnAttrs' | 'interfaceMethods' | 'sigs'> {
  readonly classes: readonly Class[];
  readonly functionModules?: Map<string, FunctionModule>;
  readonly reg?: IR.Program['reg'];
  readonly structs: StructDefinitions;
  readonly interfaceAttrs?: ReadonlyMap<string, readonly Attribute[]>;
  readonly intfOwnAttrs?: ReadonlyMap<string, readonly Attribute[]>;
  readonly interfaceMethods?: ReadonlyMap<string, readonly Method[]>;
  readonly sigs?: ReadonlyMap<string, Method | UnsupportedMethod>;
  readonly consts?: Map<string, Constant>;
  readonly tables?: readonly DatabaseTable[];
  readonly exceptionSupers?: Readonly<Record<string, string>>;
  readonly rtti?: Rtti;
  readonly amcChannels?: readonly AmcChannel[];
}
// Legacy callers can pass a class array with no program metadata.
export type ClassList = Class[] & Partial<Program>;
export type ProgramInput = Program | ClassList;
export interface Layers extends Omit<SymbolLayers, 'classes' | 'consts' | 'structs' | 'tables'> {
  readonly classes?: readonly Class[];
  readonly consts?: Map<string, Constant>;
  readonly structs?: StructDefinitions;
  readonly tables?: readonly DatabaseTable[];
}
export interface Signature {
  readonly params: readonly {readonly type?: IR.Type}[];
  readonly returning?: {readonly type: IR.Type} | null;
}
export interface ClassName { readonly name: string }
// Interface signatures do not inspect their class argument (AMC passes {}).
export interface InterfaceClassName { readonly name?: string }

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
export type SunkLocals<Body extends readonly object[] = readonly Stmt[]> = Map<Body, readonly Local[]>;
export interface Context {
  readonly cls: Partial<Omit<Class, 'constructor'>>;
  loop?: number;
  inCtor?: boolean;
  method?: Partial<Method>;
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
export interface MethodContext extends Context { readonly cls: Class; readonly method: Method; loop: number; sinkSites: SinkSite[] }
export interface Ownership {
  readonly declarations: ReadonlySet<IR.Field>;
  unescaped(p: Expr | null | undefined, ctx: Context): boolean | undefined;
  width(p: Expr | null | undefined, ctx: Context): number | undefined;
  fixed(p: Expr | null | undefined, ctx: Context): number | false | undefined;
  has(p: Expr | null | undefined, ctx: Context): boolean | undefined;
}
export type RenderExpr = (e: Expr, ctx: Context) => string;
export type RenderType = (t: IR.Type) => string;
export type RenderName = (name: string) => string;
export type MovePair = (st: Stmt, next: Stmt | undefined, ctx: Context, previous: Stmt | undefined) => boolean;
export type AnalyzeTableMoves = (program: ProgramInput, stable: (t: TypeProbe) => boolean | undefined, goType: RenderType) => MovePair;
export type ConstructorFactories = Map<string, {readonly canOmit: boolean; readonly args: readonly Argument[]}>;
export type AnalyzeOwnership = (program: ProgramInput) => Ownership;
export type SinkLocals = (method: Method) => SunkLocals;
export type GeneratedBindings = (source: string) => Set<string> | null;
export type OmittedFactoryCall = (program: ProgramInput, cls: Class, method: Method) => Expr;
export interface ExprHelpers {
  readonly ownership: Ownership;
  readonly expr: RenderExpr;
  readonly place: RenderExpr;
  readonly helper: RenderName;
}
export interface StatementHelpers extends ExprHelpers { readonly rowValue: (table: IR.Type, item: string) => string }
export type OwnedExpression = (e: Expr, ctx: Context, helpers: ExprHelpers) => string | null;
export type OwnedStatement = (st: Stmt, ctx: Context, indent: string, helpers: StatementHelpers) => string[] | null;
export type EmitByteConcat = (st: Extract<Stmt, {s: 'concat_bytes'}>, ctx: Context, indent: string, helpers: Pick<StatementHelpers, 'expr' | 'place' | 'rowValue'>) => string[];
export type EmitByteStatement = (st: Stmt, ctx: Context, indent: string, helpers: Pick<ExprHelpers, 'expr' | 'place'>) => string[];
export type EmitBuiltinGo = (e: Builtin, args: readonly string[], names: Readonly<Record<string, string | undefined>>, imports: Set<string>) => string;
export type EmitPackedInt8 = (e: Conversion, render: (e: Expr) => string, helper: RenderName) => string | null;
export type EmitPackedComparison = (c: Condition, render: (e: Expr) => string) => string | null;
export type ExceptionClass = (cls: Partial<Class> | null | undefined, classes: ReadonlyMap<string, Class>) => boolean;
export interface RttiHelpers { readonly goType: RenderType; readonly ident: RenderName }
export type ObjectRttiGo = (program: ProgramInput, helpers: RttiHelpers) => string[];
export interface MessageHelpers extends RttiHelpers {
  readonly classes: ReadonlyMap<string, Class>;
  readonly poly: ReadonlySet<string>;
  readonly ancestorsOf: (cls: Class) => Class[];
}
export type NativeMessageText = (program: ProgramInput, helpers: MessageHelpers) => string[];
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
  readonly name?: string | Expr;
  readonly owner?: string | null;
  readonly target?: Expr | null;
  readonly table?: Expr | string | boolean;
  readonly [key: string]: unknown;
}
export type EmitGo = (program: ProgramInput, pkg?: string, layers?: Layers | null, unitBuild?: boolean, symbols?: SymbolCollector | null) => string;
