import {activeSystem} from "./osd-system.mjs";
import {writable} from "./osd-source-write-check.mjs";
// The object store's side of $TMP (tools/osd-tmp.mjs): its root, the
// package entry every system has, who made what, and the checked write a
// create goes through. Apart from tools/osd-store.mjs, which may not grow
// (tools/osd-size-budget.json).
import {closeSync, constants as fsConstants, existsSync, openSync, renameSync, rmSync, writeSync} from "node:fs";
import {dirname, join} from "node:path";
import {TMP_FOLDER, TMP_PACKAGE, ensureTmp, forgetAuthor, isTmpPackage, nameProblem, recordAuthor, tmpAuthors, tmpDisabled, tmpRoot} from "./osd-tmp.mjs";
// the store's own refusal, imported lazily-safe: osd-store re-exports it
import {NotSupported} from "./osd-store.mjs";

export class InvalidName extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_NAME";
  }
}

// $TMP is a root whether or not anything was created in it yet: the build
// reads its folder once it exists (inputFoldersOf), the store needs it
// before, so that the first create has somewhere to go. Last, so that a
// write that names no root never lands in it. OSD_TMP=off (a preview, any
// published build) leaves it out altogether.
export function withTmp(roots, base) {
  if (activeSystem(base)) return roots.filter(r => r.path !== TMP_FOLDER)
    .map(({overlay, overlayOf, ...root}) => ({...root, writable: false}));
  if (tmpDisabled()) return roots.filter((r) => r.path !== TMP_FOLDER);
  return roots.some((r) => r.path === TMP_FOLDER) ? roots : [...roots, tmpRoot()];
}

// $TMP exists on every system, before anything was put in it; and what is
// in it says who made it. An unreadable record (null) makes nobody the
// author of anything, so nobody is shown anything.
export function indexTmp(index, root) {
  if (!index.has(`DEVC ${TMP_PACKAGE}`)) {
    index.set(`DEVC ${TMP_PACKAGE}`, {type: "DEVC", name: TMP_PACKAGE, file: join(TMP_FOLDER, "package.devc.xml"),
      root: TMP_FOLDER, writable: !activeSystem(root), library: false, imported: false, package: TMP_PACKAGE, packages: [TMP_PACKAGE],
      synthetic: true});
  }
  const authors = tmpAuthors(root) ?? {};
  for (const entry of index.values()) {
    const author = entry.root === TMP_FOLDER ? authors[`${entry.type} ${entry.name}`]?.author : undefined;
    if (author !== undefined) entry.changedBy = author;
  }
}

/** who made an indexed entry of $TMP, from the record as it is now (a stale
 *  copy would keep showing what an unreadable record must hide) */
export function authorNow(root, entry, authors = tmpAuthors(root) ?? {}) {
  if (entry === undefined) return undefined;
  return entry.root === TMP_FOLDER ? authors[`${entry.type} ${entry.name}`]?.author : entry.changedBy;
}

// Whether `target` (relative to `base`) may be written as a file of the
// root `inside`. One way only: the target is inside the root, by path and by
// the real path of whatever of it exists. And no symlink on the way: below
// the root for every root, and from the top of the tree for a strict one
// ($TMP), where a link anywhere -- local/, local/tmp/, a package folder -- is
// how a write would be steered somewhere else. (A root itself may be a link,
// a pack mounted from elsewhere, unless strict.)
export {writable} from "./osd-source-write-check.mjs";

/** One file of a create: checked, written to a temp file opened only if new
 *  and without following a link, checked again, renamed into place. A
 *  folder swapped for a link after the first look is caught by the second.
 *  `check(target)` throws; `hooks.beforeWrite` is the test seam between. */
export function writeChecked(base, target, content, check, hooks = {}) {
  hooks.beforeWrite?.(target);
  check(target);
  const temp = join(base, `${target}.${process.pid}.${Date.now()}.new`);
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    check(target);
  } catch (e) {
    rmSync(temp, {force: true});
    throw e;
  }
  renameSync(temp, join(base, target));
}

/** a name becomes a path: one outside SAP's character set is refused
 *  (tools/osd-tmp.mjs nameProblem); `when` false skips the check */
export function checkName(type, name, when = true) {
  const problem = when ? nameProblem(type, String(name).toUpperCase()) : undefined;
  if (problem !== undefined) throw new InvalidName(problem);
}

/** the check a create's every file goes through: inside its root, no link */
export function writeCheck(base, root, what) {
  return (target) => {
    if (root === undefined || !writable(base, root.path, target, root.tmp === true)) {
      throw new InvalidName(`${what} would be written outside ${root?.path ?? "every root"}, or through a link`);
    }
  };
}

/** under $TMP a folder that starts with $ is a package of that name: A4H
 *  takes any local package as a child of $TMP, not only $TMP_<X> */
export const tmpChild = (root, chain, folder) =>
  root.tmp === true && chain.length === 1 && /^\$[a-z0-9_]+$/i.test(folder) ? folder.toUpperCase() : undefined;

/** an object of $TMP carries its author, the way TADIR does on a system */
export function noteAuthor(base, rootPath, type, name, author) {
  if (rootPath !== TMP_FOLDER || author === undefined || author === "") return undefined;
  recordAuthor(base, type, name, author);
  return String(author).toUpperCase();
}

/** a create into $TMP: its folder exists first, and a local package of any
 *  name (not only $TMP_<X>) is a child of it, its folder its name (A4H) */
export function tmpPackageFile(base, parent, name, folder, type) {
  if (!isTmpPackage(parent)) return undefined;
  ensureTmp(base);
  return type === "DEVC" && name.startsWith("$") && !name.startsWith(parent + "_")
    ? join(folder, name.toLowerCase(), "package.devc.xml") : undefined;
}

/** a delete in $TMP: $TMP itself is delivered with every system (refused,
 *  `before`), and an object that goes takes its author record with it */
export function tmpDelete(base, entry, before) {
  if (before && entry.type === "DEVC" && isTmpPackage(entry.name)) {
    throw new NotSupported(`deleting ${TMP_PACKAGE}, the local package every system has`);
  }
  if (!before && entry.root === TMP_FOLDER) forgetAuthor(base, entry.type, entry.name);
}
