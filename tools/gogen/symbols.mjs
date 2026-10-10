// Names and provenance are recorded at the emitter's routine signatures.
import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {emitGo} from "./emit-go.mjs";

export const typeName = (s) => {
  const name = String(s).toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return name.startsWith("_") ? `N${name}` : name;
};
export const funcName = (cls, method) => `${typeName(cls)}${cls.includes(":") ? "__OSD_METHOD__" : "_"}${typeName(method)}`;

export function buildCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  } catch { return "unknown"; }
}

export function symbolCollector(program, pkg = "main", symbols = {}) {
  return (cls, m, go, receiver) => {
    const source = program.routineSymbols?.get(`${cls.name}=>${m.name}`);
    const fm = cls.name.startsWith("FUGR:");
    const local = !fm && cls.name.includes(":");
    const pos = source?.pos ?? m.pos;
    if (!pos) return; // Synthetic helpers have no ABAP routine statement.
    const entry = {go, abap: source?.abap ?? `${cls.name}=>${m.name}`,
      ...(source?.owner ? {owner: source.owner} : fm ? {owner: cls.name.slice(5)} : local ? {owner: cls.name.split(":")[0]} : {}),
      kind: source?.kind ?? (fm ? "fm" : local ? "local" : "method"), file: pos.file, line: pos.row};
    symbols[`${pkg}.${receiver ? `(*${receiver}).` : ""}${go}`] = entry;
  };
}

export function writeSymbols(dir, symbols, build = buildCommit()) {
  writeFileSync(join(dir, "symbols.json"), JSON.stringify({schema: "gogen-symbols/1", build,
    symbols: Object.fromEntries(Object.keys(symbols).sort().map((key) => [key, symbols[key]]))}, null, 2) + "\n");
}

// Non-main pprof names use the import path, not the package declaration.
export function writeGo(file, program, pkg = "main", layers = null, unitBuild = false, symbols = {}, importPath = pkg === "main" ? "main" : `osg/gogen/generated/${pkg}`) {
  const source = emitGo(program, pkg, layers, unitBuild, symbolCollector(program, importPath, symbols));
  writeFileSync(file, source);
  writeSymbols(dirname(file), symbols);
  return source;
}

// The report converter supplies the exact method names, including truncated
// FORM names. Use its parsed statements for original source positions.
export function reportSymbols(program, converted, owner, file) {
  const ir = converted.reportIR;
  program.routineSymbols ??= new Map();
  const record = (cls, method, abap, kind, statement) => {
    if (statement) program.routineSymbols.set(`${cls.toUpperCase()}=>${method.toUpperCase()}`, {
      abap, owner, kind, pos: {file, row: statement.span.start.line},
    });
  };
  for (const local of ir.localClasses ?? []) {
    for (const method of local.methods ?? []) {
      record(local.generatedName, method.name, `${owner}:${local.name}=>${method.name}`, "local", method.statement);
    }
  }
  for (const [event, headers] of Object.entries(ir.eventHeaders ?? {})) {
    record(ir.targetClassName, `ZIF_GG_REPORT_V1~${event}`, `${owner}=>${event.toUpperCase()}`, "method", headers[0]);
  }
  for (const routine of ir.routines ?? []) {
    program.routineSymbols.set(`${ir.targetClassName.toUpperCase()}=>${routine.methodName.toUpperCase()}`, {
      abap: `${owner}=>${routine.name.toUpperCase()}`, owner, kind: "form",
      pos: {file, row: routine.statement.span.start.line},
    });
  }
}

// Cached Go is still part of this build; refresh provenance after restoring it.
export function refreshSymbolBuild(dir, build = buildCommit()) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) refreshSymbolBuild(path, build);
    else if (entry.name === "symbols.json") writeSymbols(dir, JSON.parse(readFileSync(path, "utf8")).symbols, build);
  }
}
