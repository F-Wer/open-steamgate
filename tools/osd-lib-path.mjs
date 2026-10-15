import {activeSystem, layerDir} from "./osd-system.mjs";
// Where a locked library is read from, and the pin gate in front of it.
//
// Kept apart from tools/osd-lock.mjs on purpose: osd-lock is imported by
// code that the preview bundles with webpack (tools/osd-packs.mjs ->
// readLock), where there is no `child_process`, and this module needs git.
//
// The gate runs only in a git checkout of this repository. A shipped tree --
// the VSIX seed, the bun binary's install, the Docker image -- has no `.git`
// at its root and carries the libraries as plain copies made from the
// verified pins at packaging time (scripts/build-vsix.mjs copySeedTree,
// docker/image/assemble.mjs), so there is nothing to `git rev-parse` there
// and the copy is the pinned content. The licence approval of a pinned ref
// is repo tooling too (docker/image/license-assumptions.mjs,
// checkLockLicences), never imported from here.
import {execFileSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync, realpathSync, statSync} from "node:fs";
import {join} from "node:path";
import {librariesFromLock, readLock} from "./osd-lock.mjs";

const envKey = (folder) => `OSD_LIB_${folder.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** A tree that is a git checkout of its own (a `.git` directory, or the
 *  `.git` file of a worktree) is a development tree and gets the gate. */
export function isCheckout(root) {
  return existsSync(join(root, ".git"));
}

/** Resolve a library at its established path, checking the checkout itself. */
export function libraryPath(root, folder, env = process.env) {
  const system = activeSystem(root, env);
  if (system) {
    const layer = system.layers.find(l => l.kind === "lib" && l.name === folder);
    if (!layer) throw new Error(`system ${system.digest} does not provide library ${folder}`);
    return layerDir(root, layer);
  }
  const pin = readLock(root).libraries.find((lib) => lib.folder === folder);
  if (!pin) throw new Error(`libs.lock.json has no pin for ${folder}`);
  const key = envKey(folder);
  if (env[key]) {
    console.error(`*** OSD LIBRARY OVERRIDE: ${folder} <- ${env[key]} (pin bypassed) ***`);
    return env[key];
  }
  const path = join(root, ".local", "lars", folder);
  // shipped: the copy was made from the pin when the artefact was built
  if (!isCheckout(root)) return path;
  let actual = "missing";
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd: path, encoding: "utf8", stdio: "pipe"}).trim();
    if (realpathSync(top) === realpathSync(path)) {
      actual = execFileSync("git", ["rev-parse", "HEAD"], {cwd: path, encoding: "utf8", stdio: "pipe"}).trim();
    }
  } catch { /* absent or not a standalone checkout */ }
  if (actual === "missing") {
    // a worktree whose clone has moved: its `.git` file names a gitdir that is gone
    try {
      const link = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(path, ".git"), "utf8"));
      if (link && !existsSync(link[1])) actual = `missing (a worktree of a moved clone: ${link[1]} is gone)`;
    } catch { /* no .git file */ }
  }
  if (actual !== pin.ref) throw new Error(`${folder} is at ${actual}, libs.lock.json says ${pin.ref}; run node tools/osd-libs.mjs --sync`);
  let dirty;
  try { dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {cwd: path, encoding: "utf8", stdio: "pipe"}).length > 0; }
  catch (error) { throw new Error(`${folder} at ${path}: cannot check working tree (${error.message})`); }
  if (dirty) throw new Error(`${folder} at ${path} has modified or untracked files; use ${key} for development`);
  return path;
}

function isUsableDirectory(path) {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export function vsixPreflightMissing(root = ".") {
  const missing = [];
  if (!isUsableDirectory(join(root, "node_modules"))) missing.push("node_modules/");
  const {libraries} = librariesFromLock(root);
  for (const lib of libraries) {
    if (!isUsableDirectory(process.env[envKey(lib.name)] || lib.path)) missing.push(`${lib.folder}/`);
    else libraryPath(root, lib.name);
  }
  return missing;
}
