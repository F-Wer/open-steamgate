// SPDX-License-Identifier: MIT
// Pure compatibility shapes for frontend.mjs, whose body is unchanged in this
// slice. Only name/isDirectory are consumed; no Node object crosses host-io.
import {basename, listDir, listEntries} from "./host-io.ts";
import {SOURCE} from "../osd-source-identity-name.mjs";

export const isSourceIdentity = (file) => basename(file) === SOURCE;
export function readdirSync(dir, options) {
  return options?.withFileTypes
    ? listEntries(dir).map(([name, directory]) => ({name, isDirectory: () => directory}))
    : listDir(dir);
}
