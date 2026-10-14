import type {Program, Class, Method} from './ir.ts';
// Names and provenance are recorded at the emitter's routine signatures.
import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {emitGo} from "./emit-go.mjs";

// Compatibility exports for callers that also collect symbol provenance.
export {typeName, funcName} from "./go-symbols.ts";

export function buildCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  } catch { return "unknown"; }
}

export function symbolCollector(program: Program, pkg: string = "main", symbols: Map<string, SymbolEntry> = new Map()): SymbolCollector {
  return (cls, m, go, receiver) => {
    const source = program.routineSymbols?.get(`${cls.name}=>${m.name}`);
    const fm = cls.name.startsWith("FUGR:");
    const local = !fm && cls.name.includes(":");
    const generated = !source && program.convertedClasses?.has(cls.name);
    const pos = source?.pos ?? m.pos;
    if (!pos && !generated) return; // Runtime helpers have no ABAP routine statement.
    const entry: SymbolEntry = {go, abap: source?.abap ?? `${cls.name}=>${m.name}`,
      ...(source?.owner ? {owner: source.owner} : fm ? {owner: cls.name.slice(5)} : local ? {owner: cls.name.split(":")[0]} : {}),
      kind: source?.kind ?? (generated ? "generated" : fm ? "fm" : local ? "local" : "method"),
      ...(!generated ? {file: pos!.file, line: pos!.row} : {})};
    symbols.set(`${pkg}.${receiver ? `(*${receiver}).` : ""}${go}`, entry);
  };
}

export function writeSymbols(dir: string, symbols: ReadonlyMap<string, SymbolEntry>, build: string = buildCommit()): void {
  writeFileSync(join(dir, "symbols.json"), JSON.stringify({schema: "gogen-symbols/1", build,
    symbols: Object.fromEntries([...symbols.keys()].sort().map((key) => [key, symbols.get(key)]))}, null, 2) + "\n");
}

// Non-main pprof names use the import path, not the package declaration.
export function writeGo(file: string, program: Program, pkg: string = "main", layers: Layers | null = null, unitBuild: boolean = false, symbols: Map<string, SymbolEntry> = new Map(), importPath: string = pkg === "main" ? "main" : `osg/gogen/generated/${pkg}`): string {
  // The untyped emitter infers null-only defaults; this boundary states its actual contract.
  const emit = emitGo as unknown as (program: Program, pkg: string, layers: Layers | null, unitBuild: boolean, symbols: SymbolCollector) => string;
  const source = emit(program, pkg, layers, unitBuild, symbolCollector(program, importPath, symbols));
  writeFileSync(file, source);
  writeSymbols(dirname(file), symbols);
  return source;
}

// The report converter supplies the exact method names, including truncated
// FORM names. Use its parsed statements for original source positions.
export function reportSymbols(program: Program, converted: ConvertedReport, owner: string, file: string): void {
  const ir = {...converted.reportIR, events: new Map(Object.entries(converted.reportIR.events ?? {})),
    eventHeaders: new Map(Object.entries(converted.reportIR.eventHeaders ?? {}))};
  const routineSymbols = program.routineSymbols ??= new Map();
  // Every unmatched method in these classes is converter scaffolding, even
  // when the frontend has a position in the generated .clas.abap file.
  program.convertedClasses ??= new Set();
  for (const cls of [ir.targetClassName, ...(converted.helperSources ?? []).map((h) => h.className)]) {
    program.convertedClasses.add(cls.toUpperCase());
  }
  const record = (cls: string, method: string, abap: string, kind: string, statement: ReportStatement | undefined): void => {
    if (statement) routineSymbols.set(`${cls.toUpperCase()}=>${method.toUpperCase()}`, {
      abap, owner, kind, pos: {file: statement.filename ?? file, row: statement.span.start.line},
    });
  };
  for (const local of ir.localClasses ?? []) {
    for (const method of local.methods ?? []) {
      record(local.generatedName, method.name, `${owner}:${local.name}=>${method.name}`, "local", method.statement);
    }
  }
  const listEvents = new Set(["top_of_page", "end_of_page", "top_of_page_during_line_sel", "at_line_selection", "at_user_command", "at_pf"]);
  for (const event of new Set([...[...(ir.events?.keys() ?? [])], ...[...(ir.eventHeaders?.keys() ?? [])]])) {
    const header = ir.eventHeaders?.get(event)?.[0];
    const body = ir.events?.get(event)?.[0];
    // Blocks are in execution order; offsets may belong to different INCLUDE files.
    const firstBlock = ir.eventBlocks?.find((block) => block.event === event);
    const statement = firstBlock && !firstBlock.qualifier ? firstBlock.statements[0] ?? body : header ?? body;
    const label = header?.text.replace(/\.\s*$/, "").trim().toUpperCase() ?? event.toUpperCase().replaceAll("_", "-");
    const intf = listEvents.has(event) ? "ZIF_GG_LIST_PROCESSING_V1" : "ZIF_GG_REPORT_V1";
    record(ir.targetClassName, `${intf}~${event}`, `${owner} (${label})`, "event", statement);
  }
  for (const routine of ir.routines ?? []) {
    program.routineSymbols.set(`${ir.targetClassName.toUpperCase()}=>${routine.methodName.toUpperCase()}`, {
      abap: `${owner}=>${routine.name.toUpperCase()}`, owner, kind: "form",
      pos: {file: routine.statement.filename ?? file, row: routine.statement.span.start.line},
    });
  }
}

// Cached Go is still part of this build; refresh provenance after restoring it.
export function refreshSymbolBuild(dir: string, build: string = buildCommit()): void {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) refreshSymbolBuild(path, build);
    else if (entry.name === "symbols.json") writeSymbols(dir, new Map(Object.entries((JSON.parse(readFileSync(path, "utf8")) as SymbolFile).symbols)), build);
  }
}

export interface SymbolEntry { readonly go: string; readonly abap: string; readonly owner?: string; readonly kind: string; readonly file?: string; readonly line?: number }
interface SymbolFile { readonly symbols: Record<string, SymbolEntry> }
export type SymbolCollector = (cls: Class, method: Method, go: string, receiver: string | null) => void;
export interface Layers { readonly classes?: readonly Class[]; readonly visibleClasses?: ReadonlySet<string>; readonly interfaces?: ReadonlySet<string>; readonly marker?: string; readonly tables?: Program['tables']; readonly structs?: Program['structs']; readonly consts?: Program['consts']; readonly events?: Program['events']; readonly externalClasses?: ReadonlySet<string>; readonly imports?: readonly string[]; readonly importMarkers?: readonly string[] }
interface ReportStatement { readonly filename?: string; readonly text: string; readonly span: { readonly start: { readonly line: number } } }
interface ConvertedReport { readonly helperSources?: readonly { readonly className: string }[]; readonly reportIR: {
  readonly targetClassName: string;
  readonly localClasses?: readonly { readonly generatedName: string; readonly name: string; readonly methods?: readonly { readonly name: string; readonly statement?: ReportStatement }[] }[];
  readonly events?: Record<string, readonly ReportStatement[]>;
  readonly eventHeaders?: Record<string, readonly ReportStatement[]>;
  readonly eventBlocks?: readonly { readonly event: string; readonly qualifier?: string; readonly statements: readonly ReportStatement[] }[];
  readonly routines?: readonly { readonly methodName: string; readonly name: string; readonly statement: ReportStatement }[];
} }
