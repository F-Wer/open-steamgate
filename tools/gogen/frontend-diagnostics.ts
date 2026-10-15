import type {IRegistry, Issue} from "@abaplint/core";
import type {Diagnostic} from "./ir.ts";

export interface DiagnosticsSession { issues?: readonly Issue[] | null }

// Keep parser and syntax diagnostics when tolerant compilation omits an object.
export function syntaxDiagnostics(registry: IRegistry, ours: (filename: string) => boolean, objectName: (filename: string) => string, session?: DiagnosticsSession | null): Diagnostic[] {
  return (session ? (session.issues ??= registry.findIssues()) : registry.findIssues())
    .filter((issue): boolean => ["check_syntax", "parser_error"].includes(issue.getKey()) && ours(issue.getFilename()))
    .map((issue): Diagnostic => ({object: objectName(issue.getFilename()).toUpperCase(),
      message: `${issue.getFilename()}:${issue.getStart().getRow()}: ${issue.getMessage()}`}));
}
