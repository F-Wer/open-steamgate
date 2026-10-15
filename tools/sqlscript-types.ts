// Construction shapes of the relational IR in sqlscript-ir.mjs.
import type {WriteType} from "./gogen/ir.ts";
export type SqlType = WriteType | {readonly abap: "UNRESOLVED"; readonly reason: string} | {readonly abap: "BOOL"} | {readonly abap: "I"; readonly bits: 16};
export type SqlValue = string | number | bigint | boolean | null;
export type SqlExpr =
  | {node: "star"}
  | {node: "col"; name: string; type?: SqlType; source?: string}
  | {node: "lit"; value: SqlValue; type?: SqlType}
  | {node: "param"; name: string; type: SqlType; isNull: boolean}
  | {node: "session"; kind: string; name: string; type: SqlType}
  | {node: "bin"; op: string; left: SqlExpr; right: SqlExpr; type: SqlType}
  | {node: "call"; fn: string; args: readonly SqlExpr[]; type?: SqlType}
  | {node: "cast"; expr: SqlExpr; type: SqlType}
  | {node: "isnull" | "not"; expr: SqlExpr; type: SqlType}
  | {node: "like"; expr: SqlExpr; pattern: SqlExpr; escape?: SqlExpr; negated: boolean; type: SqlType}
  | {node: "in"; expr: SqlExpr; values: readonly SqlExpr[]; negated: boolean; type: SqlType}
  | {node: "sub"; kind: string; rel: SqlRelation; expr?: SqlExpr; negated: boolean; type?: SqlType}
  | {node: "case"; whens: readonly {when: SqlExpr; then: SqlExpr}[]; otherwise?: SqlExpr; type?: SqlType}
  | {node: "hostPred"; id: string; column: string; columnType: SqlType; kind?: string; type: SqlType};
export interface SqlItem {as: string; expr: SqlExpr}
export interface SqlSet {col: string; expr: SqlExpr}
export interface SqlOrder {col: string; desc?: boolean}
export type SqlSchema = Readonly<Record<string, SqlType>>;
// A seam may name a relation directly or return a handle from defineRelation.
export type SqlHandle = string | {readonly ref: string; readonly ident?: string; readonly kind?: "definition" | "materialised"; readonly reason?: string; readonly viaWrite?: boolean};
export type SqlFunctionArgument =
  | {kind: "scalar"; name: string; expr: SqlExpr}
  | {kind: "relation"; name: string; param: string; rel: SqlRelation};
export type SqlRelation =
  | {rel: "scan"; table: string}
  | {rel: "alias"; input: SqlRelation; name: string}
  | {rel: "var"; name: string; schema?: SqlSchema}
  | {rel: "ref"; handle: SqlHandle; schema?: SqlSchema}
  | {rel: "tfcall"; name: string; args: readonly SqlFunctionArgument[]; schema: SqlSchema}
  | {rel: "filter"; input: SqlRelation; pred: SqlExpr}
  | {rel: "project"; input: SqlRelation; items: readonly SqlItem[]}
  | {rel: "join"; left: SqlRelation; right: SqlRelation; on: SqlExpr; kind: string}
  | {rel: "union"; inputs: readonly SqlRelation[]; all: boolean}
  | {rel: "except"; inputs: readonly SqlRelation[]}
  | {rel: "aggregate"; input: SqlRelation; groupBy: readonly string[]; aggs: readonly SqlItem[]}
  | {rel: "order"; input: SqlRelation; keys: readonly SqlOrder[]}
  | {rel: "limit"; input: SqlRelation; n: SqlExpr};

// Named construction records for writes; optional fields are omitted by callers.
export interface SqlInsert {
  write: "insert"; table: string; columns: readonly string[];
  rows: readonly (readonly SqlExpr[])[]; onDuplicate: string; expected?: number;
}
export interface SqlUpdate {
  write: "update"; table: string; alias?: string;
  set: readonly SqlSet[]; pred?: SqlExpr;
}
export interface SqlUpsert {
  write: "upsert"; table: string; columns: readonly string[];
  rows: readonly (readonly SqlExpr[])[]; key: readonly string[]; fill?: readonly SqlSet[];
}
