// Where in the ABAP did this happen.
//
// A stack from transpiled code names .mjs files and generated line numbers,
// which is the wrong screen for everyone who wrote the ABAP. The transpiler
// can say where each generated line came from — `write_source_map` in
// abap_transpile.json, off by default — and with that on, a position resolves
// to the statement rather than to the object:
//
//   zcl_o4d_sales_dance.clas.mjs:1346   abap.statements.append({source: lv_val, ...})
//   zcl_o4d_sales_dance.clas.abap:119   APPEND lv_val TO rt_values.
//
// This is the only copy of that. osd-unit.mjs used to carry its own, and two
// copies of a thing whose job is to be accurate is how they stop agreeing.
//
// It is deliberately not in the runtime: `node:module` does not exist in a
// browser, and an exception that costs a source-map lookup every time it is
// raised is a worse trade than a log line that asks for one when it needs it.
import {sourceMapFile} from "./osd-system.mjs";
import {SourceMap} from "node:module";
import {existsSync, readFileSync} from "node:fs";
import {basename} from "node:path";

const maps = new Map();
const sources = new Map();

/** Every frame of a stack that resolves to ABAP, nearest first. A frame with
 * no map is kept as itself rather than dropped: a gap in the middle of a
 * stack is information, and a silently shortened stack is not. */
export function abapFrames(from, options = {}) {
  const stack = typeof from === "string" ? from : String(from?.stack ?? "");
  const out = [];
  for (const line of stack.split("\n")) {
    const m = /\(?((?:file:\/\/)?\/\S+?\.mjs):(\d+):(\d+)\)?$/.exec(line.trim());
    if (m === null) {
      continue;
    }
    const file = m[1].replace(/^file:\/\//, "");
    const found = resolveFrame(file, Number(m[2]), Number(m[3]));
    // the same statement twice, once from where it raised and once from the
    // frame that raised it, reads as noise
    if (found !== undefined && out.at(-1)?.text !== found.text) {
      out.push(found);
    } else if (found === undefined && options.keepUnmapped !== false) {
      out.push({file: basename(file), line: Number(m[2]), text: undefined, mapped: false});
    }
    if (out.length >= (options.limit ?? 12)) {
      break;
    }
  }
  return out;
}

/** A short dump: what was raised, where in ABAP, and the ABAP frames under
 * it — the object a runtime keeps and a client reads, the way ST22 keeps
 * one. `where` is describe()'s line; `frames` are abapFrames()' entries. */
export function dumpOf(error, options = {}) {
  const frames = abapFrames(error, {...options, keepUnmapped: options.keepUnmapped ?? false});
  const name = error?.constructor?.name?.toUpperCase?.() || "error";
  return {
    at: new Date().toISOString(),
    name,
    message: String(error?.message?.get?.() ?? error?.message ?? error ?? ""),
    where: describe(error, options),
    frames,
    request: options.request,
    // no ABAP frame at all: the JavaScript stack is still a place, and under
    // a runtime that keeps no async frames (JavaScriptCore) it is the only one
    ...(frames.length === 0 ? {stack: String(error?.stack ?? "").split("\n").slice(0, 10)} : {}),
  };
}

/** One line for a log: what was raised and where, in ABAP. */
export function describe(error, options = {}) {
  // `??` does not fire on "", and an ABAP exception can reach JavaScript with
  // an empty name the same way it reaches it with an empty message. Falsy,
  // not nullish — open-steamgate paid an afternoon for that distinction.
  const name = error?.constructor?.name?.toUpperCase?.() || "error";
  const frame = abapFrames(error, {...options, keepUnmapped: false})[0];
  if (frame === undefined) {
    return `${name} (no ABAP position; is write_source_map on?)`;
  }
  return `${name} at ${frame.file}:${frame.line}${frame.text === undefined ? "" : "  " + frame.text}`;
}

/** One generated position as an ABAP one, or undefined when there is no map
 * for it. Exported so osd-unit can keep its own frame shape without keeping
 * its own copy of the mapping. */
export function resolveFrame(file, row, column) {
  if (maps.has(file) === false) {
    const map = `${file}.map`;
    maps.set(file, existsSync(map) ? new SourceMap(JSON.parse(readFileSync(map, "utf8"))) : undefined);
  }
  const entry = maps.get(file)?.findEntry(row - 1, column - 1);
  if (entry?.originalSource === undefined) {
    return undefined;
  }
  const path = sourceMapFile(file, entry.originalSource);
  const text = read(path);
  const at = statementAfter(text, entry.originalLine + 1, entry.originalColumn + 1);
  return {
    file: basename(entry.originalSource),
    line: at.line,
    column: at.column,
    text: text?.split("\n")[at.line - 1]?.trim(),
    mapped: true,
  };
}

function read(path) {
  if (sources.has(path) === false) {
    sources.set(path, existsSync(path) ? readFileSync(path, "utf8") : undefined);
  }
  return sources.get(path);
}

// points at the line above the one that raised: right screen, wrong line,
// and a client that jumps there lands on the end of the call before the
// assert. When the mapped position is the end of its line, the statement
// that produced the code is the next line carrying any, and that is the
// line to name. A position inside a line is left alone, because then the
// map is pointing at a statement rather than past one.
export function statementAfter(text, line, column) {
  if (typeof text !== "string") {
    return {line, column};
  }
  const lines = text.split("\n");
  const at = lines[line - 1];
  if (at === undefined || column < at.replace(/\s+$/, "").length) {
    return {line, column};
  }
  for (let next = line; next < lines.length; next += 1) {
    const content = lines[next].trim();
    if (content === "" || content.startsWith("*") || content.startsWith("\"")) {
      continue;
    }
    return {line: next + 1, column: lines[next].length - lines[next].trimStart().length + 1};
  }
  return {line, column};
}
