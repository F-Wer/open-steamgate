// SPDX-License-Identifier: MIT
// Pure compatibility shapes for frontend.mjs, whose body is unchanged in this
// slice. Only UTF-8 reads and name/isDirectory are consumed; no Node object
// crosses host-io, and every typed host call keeps its declared arity.
import {basename, listDir, listEntries, readText} from "./host-io.ts";
import {SOURCE} from "../osd-source-identity-name.mjs";

// The sole frontend encoding argument is "utf8"; retain that JS call shape
// here rather than sending an extra argument across the typed extern boundary.
export function readFileSync(file, _encoding) {
  return readText(file);
}

export const isSourceIdentity = (file) => basename(file) === SOURCE;
export function readdirSync(dir, options) {
  return options?.withFileTypes
    ? listEntries(dir).map(([name, directory]) => {
      /** @type {import("./host-io.ts").DirectoryEntry} */ const entry = {name, isDirectory: () => directory}; return entry; })
    : listDir(dir);
}
