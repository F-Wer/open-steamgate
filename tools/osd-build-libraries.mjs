import {existsSync, readdirSync, readFileSync} from "node:fs";
import {basename, join} from "node:path";
import {activeSystem} from "./osd-system.mjs";
import {libraryPath} from "./osd-lib-path.mjs";

/**
 * Libraries named by the transpiler config are mandatory build inputs, not
 * optional search paths. The transpiler tolerates an absent folder and then
 * builds a smaller system; that is useful for a generic CLI and fatal for an
 * addressed OSD generation. Refuse before taking the lock (and, especially,
 * before switching `live`) when a checkout/worktree has not inherited its
 * pinned library closure.
 */
export function missingLibraries(root, config = existsSync(join(root, "abap_transpile.json")) ? JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8")) : {}) {
  return (config.libs ?? [])
    .filter((lib) => typeof lib.folder === "string" && lib.folder !== "")
    .map((lib) => ({...lib, path: activeSystem(root) ? libraryPath(root, basename(lib.folder)) : process.env[`OSD_LIB_${basename(lib.folder).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || join(root, lib.folder)}))
    .filter((lib) => !existsSync(lib.path) || readdirSync(lib.path).length === 0)
    .map(({url, folder, ref}) => ({url, folder, ...(ref === undefined ? {} : {ref})}));
}

export function describeMissingLibraries(missing) {
  const names = missing
    .map((lib) => `${lib.folder}${lib.ref ? ` at ${lib.ref.slice(0, 12)}` : ""}`)
    .join(", ");
  return `configured ABAP libraries are absent or empty: ${names}. ` +
    "For a development worktree create or repair it with `npm run osd:worktree -- <name>`; " +
    "for a standalone checkout fetch the pinned libraries before building";
}

