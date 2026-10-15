// SPDX-License-Identifier: MIT
// Erasable contracts for session reuse and observational provenance. Opaque
// values below are identity/fingerprint payloads, never interpreted as IR here.
import type * as Core from '@abaplint/core';
import type {Class, Method, UnsupportedMethod} from './emit-go-types.ts';
import type {FunctionModule as IRFunctionModule} from './ir.ts';

// The core's general overload erases the object kind; these two literal
// lookups are the selection path used by the provenance module.
export interface Registry extends Core.IRegistry {
  getObject(type: 'CLAS', name: string): Core.Objects.Class | undefined;
  getObject(type: 'FUGR', name: string): Core.Objects.FunctionGroup | undefined;
  getObject(type: string | undefined, name: string | undefined): Core.IObject | undefined;
}
export type SourceFile = Core.IFile;
export type ArtifactIdentity = unknown[];
export type RegistryObjects = (this: Registry) => Iterable<ArtifactObject>;
// The frontend's enqueue seam retains DDIC lock field descriptors.
export interface LockField {readonly name: string; readonly kind: string; readonly length?: number}
type CacheValue<T> = T extends {s: 'call_enq'} ? Omit<T, 'fields'> & {readonly fields?: readonly LockField[]}
  : T extends readonly (infer V)[] ? readonly CacheValue<V>[]
    : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<K, CacheValue<V>>
      : T extends object ? {[K in keyof T]: CacheValue<T[K]>} : T;
export type ClassIR = CacheValue<Class>;
export type Signature = Method | UnsupportedMethod;
export type Signatures = Map<string, Signature>;
export type SignatureChanges = [string, Signature][];
export interface ProgramSnapshot extends Map<string, unknown> {
  get(key: 'sigs'): Signatures;
  get(key: string): unknown;
}
export interface ArtifactObject {
  getType(): string;
  getName(): string;
  getFiles(): readonly SourceFile[];
  isDirty?(): boolean;
  syntaxResult?: unknown;
  parsedType?: unknown;
  def?: unknown;
  definition?: unknown;
}
// Local class adapters retain the owning core object beside their own getters.
export interface ClassObject {
  getName(): string;
  getMainABAPFile(): Core.ABAPFile | undefined;
  obj?: ArtifactObject;
}
export type ArtifactInput = ArtifactObject | {obj: ArtifactObject};
export interface RegistryContext {reg: Registry}
export interface LoweringContext extends RegistryContext {program: SessionProgram}
export type ClassLowering = (ctx: LoweringContext, obj: ClassObject) => ClassIR;
export interface FunctionModule extends Omit<IRFunctionModule, 'sig'> {sig: Signature}
export interface SessionProgram {
  // Snapshot/unchanged compare every enumerable field, including future ones.
  [key: string]: unknown;
  reg: Registry;
  sigs: Signatures;
  supplied: Map<string, Set<string>>;
  skipped: string[];
  partial: string[];
  currentClass?: string;
  currentOwner?: string;
  currentTypes?: Set<string>;
  functionModules: Map<string, FunctionModule>;
  frontendCounts: {lowered: number; reused: number; loweredClasses: string[]; reusedClasses: string[]};
}
// A replay is an ordered transcript of heterogeneous program observations and
// effects. Payloads remain opaque until frontend-replay validates/applies them.
export type ReplayOperation =
  | {kind: 'measure'; key: string; method: string; value: number}
  | {kind: 'read'; key: string; method?: string; args: unknown[]; value: string | undefined}
  | {kind: 'assign'; key: string; value: unknown}
  | {kind: 'effect'; key: string; method: string; args: unknown[]};
export interface Replay {ops: ReplayOperation[]; written: Set<string>}
export interface RecordedLowering {ir: ClassIR; replay?: Replay}
export interface SessionEntry {
  file: Core.ABAPFile;
  structure: ReturnType<Core.ABAPFile['getStructure']>;
  ir: ClassIR;
  supplied: string;
  current: Pick<SessionProgram, 'currentClass' | 'currentOwner' | 'currentTypes'>;
  sigs?: SignatureChanges;
  skipped?: string[];
  partial?: string[];
  replay?: Replay;
  provenance?: StoredProvenance;
}
export interface CacheSession {
  // Preparation clears all own fields, including disk-cache extensions.
  [key: string]: unknown;
  registry: Registry;
  config: ReturnType<Registry['getConfig']> | undefined;
  files: SourceFile[];
  classes: Map<string, SessionEntry>;
}
export type SessionInput = Partial<CacheSession> | null | undefined;
export interface CompileOptions {
  [key: string]: unknown;
  provenance?: boolean;
  cacheDir?: string;
  registry?: Registry;
  session?: Partial<CacheSession> | null;
}
export type Role = 'artifact' | 'scheduling' | 'final-output';
// Hooks normalize strings and undefined, retaining other scalar answers.
export type QueryScalar = string | number | boolean | null | undefined;
export interface QueryBase {
  args: QueryScalar[];
  result: QueryScalar[];
  role?: Role;
  phase?: string;
  artifact?: string;
  providers?: string[];
  scan?: string;
  complete?: boolean;
  policy?: string;
  target?: string;
  queryArgs?: QueryScalar[];
  site?: string[];
}
// Named semantic answers carry different payloads; keep their discriminants
// through Recorder.query, stored rows and semanticQuery's partial details.
export interface LockDescriptor {
  name: string;
  table: string;
  key: string[];
  fields: LockField[];
}
export interface RttiComponent {name: string; kind: string}
export type ObservationKind =
  | 'getObject' | 'getFileByName' | 'findObjectForFile' | 'getFirstObject'
  | 'unknown-scan' | 'function-module-owner' | 'function-group-include'
  | 'function-module-index' | 'badi-definition' | 'implicit-type-pool'
  | 'implicit-type-pool-constant' | 'behavior-definition' | 'cds-alias'
  | 'include-parent' | 'include-macro-context' | 'global-definitions'
  | 'registry-inventory' | 'registry-parse' | 'registry-findIssues'
  | 'registry-findIssuesObject' | 'registry-isDirty' | 'registry-getFiles'
  | 'registry-getObjectCount' | 'registry-setConfig' | 'include-graph'
  | 'supplied-index' | 'locals' | 'local-dispatch' | 'selected-groups'
  | 'selected-classes' | 'ownership-dispatch' | 'table-inventory'
  | 'lock-inventory' | 'rtti-inventory' | 'rtti' | 'exception-supers'
  | 'tables' | 'locks';
export type Query = QueryBase & (
  | {kind: ObservationKind}
  | {kind: 'supplied'; parameters: string[]}
  | {kind: 'lock'; descriptor: LockDescriptor | 'MISSING'}
  | {kind: 'ownershipSafety'; names: string[]; dynamic: boolean}
  | {kind: 'rtti-owner'; known: string[]; structs: [string, RttiComponent[]][]}
);
export type QueryRow = Query & {role: Role; phase: string; artifact: string};
export interface QueryEntry {queries: Map<string, QueryRow>; edges: Set<string>}
// Leaves contain true; intermediate nodes are Maps indexed by scalar tuples.
export interface QueryTrie extends Map<QueryScalar, QueryTrie | true> {}
export interface RegistryState {
  reg: Registry;
  config: ReturnType<Registry['getConfig']> | undefined;
  entries: Map<string, QueryEntry>;
  lowerings: Map<string, QueryEntry>;
  scheduling: QueryEntry;
  finalOutput: QueryEntry;
  global: QueryEntry;
  files: Map<string, [string, string][]>;
  artifacts: Map<ArtifactObject, ArtifactIdentity>;
  exposed?: boolean;
  auditBuilt?: boolean;
}
export interface ArtifactFrame {
  state: RegistryState;
  key: string | undefined;
  phase: string;
  obj?: ArtifactObject;
  lowering?: boolean;
  named?: QueryTrie;
}
export interface QueryContext {kind: string; args: unknown[]}
export interface InputSource {file: SourceFile; name: string; raw: string; rawHash: string; artifactHash: string}
export interface InputSnapshot {
  objects: Map<string, {obj: ArtifactObject; dependency: boolean; sources: InputSource[]}>;
  fileOwners: Map<string, string>;
  files: SourceFile[];
  config: string;
  configObject?: ReturnType<Registry['getConfig']>;
  signature: string;
}
export interface ResultState {states: Set<RegistryState>; exposed: boolean}
export interface StoredProvenance {rows: QueryRow[]; edges: string[]}
export interface Manifest {hits: QueryRow[]; misses: QueryRow[]; scans: QueryRow[]; unknownScans: QueryRow[]}
export type ProvenanceInput = Registry | {reg?: Registry; registry?: Registry};
export interface ProvenanceGraph {
  artifacts: Map<string, QueryEntry>;
  lowerings: Map<string, QueryEntry>;
  global: QueryEntry;
}
// Selection needs only these public core members; tests also pass this seam.
export interface SelectionCore {
  VirtualPosition: typeof Core.VirtualPosition;
  MacroContent: typeof Core.MacroContent;
  Objects: {FunctionGroup: typeof Core.Objects.FunctionGroup};
  Visibility: {Public: Core.Visibility};
  Statements: {CallFunction: typeof Core.Statements.CallFunction};
  Expressions: {FunctionName: typeof Core.Expressions.FunctionName};
  Tokens: {StringToken: typeof Core.Tokens.StringToken; Identifier: typeof Core.Tokens.Identifier};
}
