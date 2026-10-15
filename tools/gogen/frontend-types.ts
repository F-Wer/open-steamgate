// Mutable construction state for frontend.mjs; the public IR stays in ir.ts.
import type * as abaplint from "@abaplint/core";
import type {Attribute, Class, DatabaseTable, Diagnostic, Event, Expr, Method, Param, Program, SqlPredicate, Stmt, Type, TypedExpr, WriteType} from "./ir.ts";

export type Mutable<T> = {-readonly [K in keyof T]: T[K]};
export type StructType = Mutable<Extract<Type, {k: "struct"}>>;
export type TableType = Extract<Type, {k: "table"}>;
export type RefType = Extract<Type, {k: "ref"}>;
export type PackedType = Extract<Type, {k: "p"}>;
export type ValueExpr = (TypedExpr | {readonly e: "nop_call"; readonly type: Extract<Type, {k: "void"}>}) & {readonly arith?: boolean; readonly fromP?: PackedType};
// Shapes still emitted by the JavaScript frontend, including explicit absence values.
export interface FrontendSqlPredicate extends Omit<SqlPredicate, "type" | "kind"> { readonly type: WriteType; readonly kind?: string }
type StatementShape<T> = T extends {readonly s: "concat"} ? Omit<T, "sep"> & {readonly sep: Expr | null}
  : T extends {readonly s: "select_dyn"} ? Omit<T, "fields" | "where"> & {readonly fields: Expr | null; readonly where: Expr | null}
  : T extends {readonly s: "select_single" | "select_loop" | "select_aggregate"} ? Omit<T, "target"> & {readonly target: Expr | null}
  : T extends {readonly s: "call_dyn_static"} ? Omit<T, "cls"> & {readonly cls: Expr | string} : T;
type FrontendIR<T> = T extends SqlPredicate ? FrontendSqlPredicate
  : T extends readonly (infer Item)[] ? readonly FrontendIR<Item>[]
  : T extends object ? {readonly [K in keyof StatementShape<T>]: FrontendIR<StatementShape<T>[K]>} : T;
export type FrontendStmt = FrontendIR<Stmt>;
export interface FrontendMethod extends Omit<Method, "body"> { readonly body?: readonly FrontendStmt[] }
export interface FrontendConstant { go: string; type: Type; value?: string | Record<string, string | undefined>; init?: ConstantInitializer; fieldInits?: Record<string, ConstantInitializer | undefined> }
export type FrontendAttribute = (Omit<Attribute, "value"> & {readonly value?: string; readonly unsupported?: undefined})
  | {readonly name: string; readonly unsupported: string; readonly type?: undefined; readonly value?: undefined; readonly static?: boolean; readonly private?: boolean};
export type SyntaxNode = abaplint.Nodes.ExpressionNode | abaplint.Nodes.StatementNode | abaplint.Nodes.StructureNode | abaplint.Nodes.TokenNode;
export type NodeClass = new () => object;
export type Scope = abaplint.ISpaghettiScopeNode;
export type ScopeKind = `${ReturnType<Scope["getIdentifier"]>["stype"]}`;
export type MethodDefinition = abaplint.IMethodDefinition;
export type MethodParameters = ReturnType<MethodDefinition["getParameters"]>;
export interface FrontendParam extends Param { readonly defaultOwner?: string; readonly defOwner?: string }
export type Signature = Omit<FrontendMethod, "params" | "unsupported"> & {readonly params: readonly FrontendParam[]; readonly unsupported?: undefined; readonly none?: boolean};
export type RefusedSignature = {readonly name: string; readonly unsupported: string};
export type MethodSignature = Signature | RefusedSignature;
export interface SuppliedMethod { name: string; found: string[] }
export interface RttiTable { structs: Map<string, {name: string; kind: string}[]>; known: Set<string> }
export interface LockObject { name: string; table: string; key: string[]; fields: {name: string; kind: string; length: number}[] }
export interface FrontendTable extends DatabaseTable { row?: Type; hidesClient?: string; why?: string }
export interface LocalClass {
  name: string; owner: string; local: string; obj: abaplint.Objects.Class;
  def: abaplint.IClassDefinition; file: abaplint.ABAPFile;
  getName(): string;
  getMainABAPFile(): abaplint.ABAPFile;
  getDefinition(): abaplint.IClassDefinition;
}
export interface ClassSource {
  owner?: string; local?: string; obj?: abaplint.Objects.Class;
  getName(): string; getDefinition(): abaplint.IClassDefinition | undefined;
  getMainABAPFile(): abaplint.ABAPFile | undefined; getABAPFiles?(): readonly abaplint.ABAPFile[];
}
export interface FrontendClass extends Omit<Mutable<Class>, "methods" | "attributes" | "signatures" | "stubs" | "constructor" | "abstracts"> {
  methods: FrontendMethod[]; constructor: FrontendMethod | null; abstracts?: readonly FrontendMethod[]; attributes: FrontendAttribute[]; signatures?: Map<string, MethodSignature>;
  stubs?: (MethodSignature & {reason: string; pos?: {file: string; row: number}})[];
  ctorBroken?: string;
}
export interface FrontendProgram extends Omit<Mutable<Program>, "classes" | "structs" | "sigs" | "skipped" | "partial" | "frontendCounts" | "tables" | "consts" | "intfOwnAttrs" | "interfaceAttrs" | "exceptionSupers"> {
  classes: FrontendClass[]; structs: Map<string, StructType>; sigs: Map<string, MethodSignature>;
  anonStructs: Map<abaplint.AbstractType, string>; badStructs: Map<string, string>; ddicOutputLen: Map<string, number>;
  excAttrs: Set<string>; dynStatics: Set<string>; intfOwnAttrs: Map<string, readonly InterfaceAttribute[]>; interfaceAttrs: Map<string, readonly InterfaceAttribute[]>;
  consts: Map<string, FrontendConstant>; skipped: string[]; partial: string[];
  missing: Set<string>; wanted: Set<string>; interfaces: Set<string>; events: Map<string, Event>;
  diagnostics: readonly Diagnostic[]; broken: string[];
  frontendCounts: {lowered: number; reused: number; loweredClasses: string[]; reusedClasses: string[]};
  localDefs?: Map<string, abaplint.IClassDefinition>; faeN?: number;
  tables?: FrontendTable[]; rtti?: RttiTable; cdsViews?: Record<string, string>;
  lockObjects?: Map<string, LockObject>; exceptionSupers?: Record<string, string>;
}
export interface CompilationContext { reg: abaplint.IRegistry; program: FrontendProgram }
export interface NativeMe { fn: string; params: [string, "importing" | "exporting", "string" | "xstring" | "i", boolean?][] }
export interface NativeArgument { ref: boolean; value: ValueExpr }
export interface KernelSpec { fn?: string; args?: string[]; loop?: string; binds?: string[]; end?: boolean; bound?: string; nop?: boolean }
export type LoopState = (Omit<Mutable<Extract<FrontendStmt, {s: "loop"}>>, "body"> | Omit<Mutable<Extract<FrontendStmt, {s: "loop_data"}>>, "body">) & {body?: FrontendStmt[]};
export interface MethodContext extends CompilationContext {
  className: string; scopeName?: string; owner?: string; method: string; sig: Signature;
  signatures: Map<string, MethodSignature>; scope?: Scope; file: abaplint.ABAPFile; spaghetti: abaplint.ISpaghettiScope;
  locals: Map<string, Type>; fieldSymbols: Map<string, Type>; temps: number; sinkUnsafe?: boolean;
  inits: FrontendStmt[]; calls?: string[]; genTarget?: Expr; kernelLoop?: KernelSpec;
  localConstants?: Map<string, ValueExpr>; localConstantNames?: Set<string>; localConstantFields?: Map<SyntaxNode, FrontendStmt[]>;
  loopStack?: LoopState[];
  fsGone?: Set<string>; fsFresh?: {name: string; stale: boolean}[];
  fae?: {name: string; row: Type; n: number};
}

export type VariableContext = Pick<MethodContext, "reg" | "program" | "className" | "scopeName" | "method" | "sig" | "spaghetti" | "locals" | "fieldSymbols" | "localConstants" | "fsGone" | "fsFresh">;
export interface NamedContext extends CompilationContext { className: string }
export interface InterfaceAttribute { name: string; intf: string; readOnly?: boolean; static?: boolean; type?: Type; unsupported?: string }
export type FieldChain = Pick<abaplint.Nodes.ExpressionNode, "getChildren" | "concatTokens">;
export type CallChain = Pick<abaplint.Nodes.ExpressionNode, "getChildren" | "concatTokens" | "findFirstExpression">;
export type TokenText = Pick<abaplint.Nodes.ExpressionNode, "concatTokens">;
export interface ConstructorItem { kw: string; typeNode: SyntaxNode; body: SyntaxNode | null | undefined; text: string }
export interface ExpressionItem {
  ctor?: ConstructorItem; bool?: string; cond?: SyntaxNode; group?: SyntaxNode;
  descr?: {call: abaplint.Nodes.ExpressionNode; attr: SyntaxNode};
  node?: SyntaxNode; comps?: SyntaxNode; op?: string; concat?: boolean; sign?: string; hint?: Type;
}

export interface FactoryMethod { name: string; params: readonly FrontendParam[]; returning: {type: Type} }

export type ConstantIdentifier = Pick<abaplint.TypedIdentifier, "getType" | "getValue">;

export type ConstantInitializer = ValueExpr | {readonly e: "float"; readonly value: number; readonly type: Type};

// Shared source-analysis contracts; parser implementations stay in abaplint.
export interface OwnershipSource extends abaplint.IObject, Partial<Pick<abaplint.ABAPObject, 'getABAPFiles'>> {}
export interface OwnershipSafety { readonly names: ReadonlySet<string>; readonly dynamic: boolean }
export type OwnershipSafetyMap = ReadonlyMap<string, OwnershipSafety>;
