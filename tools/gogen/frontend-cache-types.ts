// Erasable contracts for discovery indexes, hierarchy memos and input caches.
import type {MethodSignature, FrontendParam} from './frontend-types.ts';
import type {Registry, InputSnapshot, LockDescriptor} from './frontend-session-types.ts';

export interface ChainEntry {reg: Registry; chain: string[]; done: boolean}
export interface CaughtEntry {size: number; own: string[]}
export interface SuppliedIndex {
  reg: Registry;
  providers: Map<string, Set<string>>;
  declarations: Map<string, string>;
}
export interface QueryProgram {
  reg: Registry;
  supplied: Map<string, Set<string>>;
  lockObjects?: Map<string, LockDescriptor>;
}
export interface QueryContext {reg: Registry; program: QueryProgram}
export interface CurrentQueryAnswer {
  result: (string | number | boolean | null | undefined)[];
  providers: string[];
  parameters?: string[];
  descriptor?: LockDescriptor | 'MISSING';
}
export interface Replacement {
  reg: Registry;
  signature: string;
  configObject?: InputSnapshot['configObject'];
}
export type CdsSource = string | {filename: string; source: string};
export interface CdsInputs {ordered: [string, string][]; digest?: string}
// Refused signatures carry no parameter list; successful signatures retain it.
export type SuppliedSignature = MethodSignature & {readonly params?: readonly FrontendParam[]};
