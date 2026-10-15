// SPDX-License-Identifier: MIT
// Compiler host boundary. Keep Node objects inside this module: abapiti maps
// these primitive contracts to an extern Go package.
import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import * as path from "node:path";

/** Read a whole file synchronously as UTF-8 (invalid bytes become U+FFFD).
 * Follows symlinks; propagates Node filesystem errors. No newline conversion.
 * JS callers may retain their old, redundant second argument "utf8". */
export function readText(file: string): string {
  return readFileSync(file, "utf8");
}

/** Synchronously create/truncate a file with UTF-8 text, following symlinks.
 * Creates no parent directories; propagates Node filesystem errors. No added
 * newline, BOM or conversion beyond Node's UTF-8 encoding. */
export function writeText(file: string, text: string): void {
  writeFileSync(file, text, "utf8");
}

/** Read immediate entry names as UTF-8 strings in Node's native directory
 * order, excluding . and ..; never sort. Propagates filesystem errors. */
export function listDir(dir: string): string[] {
  return readdirSync(dir);
}

/** Read one directory snapshot as [UTF-8 name, isDirectory] pairs in native
 * order, excluding the dot entries. Uses Dirent.isDirectory: symlinks to directories
 * remain false. Never sort; propagates readdirSync errors (including Node's
 * fallback lstat errors). No Node objects or callbacks cross the boundary. */
export function listEntries(dir: string): [string, boolean][] {
  return readdirSync(dir, {withFileTypes: true}).map((entry) => [entry.name, entry.isDirectory()]);
}

/** Lexical final component using the host platform's path.basename rules.
 * Trailing separators are ignored; empty input yields "". No filesystem access. */
export function basename(file: string): string {
  return path.basename(file);
}

/** Lexical parent using the host platform's path.dirname rules. Empty input
 * yields "."; no filesystem access, existence check or symlink resolution. */
export function dirname(file: string): string {
  return path.dirname(file);
}

/** Join and normalize string segments with the host platform's path.join
 * rules. Empty segments are ignored; no segments yields ".". No filesystem
 * access or symlink resolution; preserves Node's trailing-separator rules. */
export function join(...parts: string[]): string {
  return path.join(...parts);
}

/** Run git rev-parse HEAD synchronously in cwd, without a shell. Return its
 * UTF-8 stdout trimmed at both ends (including an empty successful result).
 * Ignore stdin/stderr; return undefined on any execution/cwd/git failure. */
export function gitHead(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  } catch { return undefined; }
}

/** Read the current process environment on each call: return the exact string
 * (including empty), or undefined if absent. No coercion or caching. */
export function env(name: string): string | undefined {
  return process.env[name];
}
