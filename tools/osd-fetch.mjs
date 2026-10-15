// A pack's sources: the folders it fetches rather than carries.
//
// A pack manifest may say
//
//   "sources": [{"folder": "upstream", "repo": "https://github.com/x/y",
//                "ref": "<commit>", "path": "src", "exclude": ["\\.prog\\."]}]
//
// and this copies /src of that repository at that commit into
// <pack>/upstream, minus what exclude names. The pack's own folders layer
// over it (tools/osd-inputs.mjs: later wins), so the files a repository
// needs changed to run here are the pack's overlay and nothing else, and
// the diff against upstream is the overlay's file list.
//
// Pinned to a commit rather than a branch on purpose: a generation is the
// hash of its inputs, and an input that moves under a branch name is a
// generation that changes without anybody changing anything. A branch name
// is accepted for a pack somebody is actively working on; the marker file
// records the commit it resolved to, so what was built is still known.
//
// The fetch is git's, by commit: init, fetch --depth 1 <ref>, checkout.
// GitHub answers a fetch of any reachable commit; a server that does not
// gets a full clone and a checkout instead, which is slower and the same.
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, existsSync, mkdirSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {MARKER, SOURCE, markerOf, sourceOf, sourceMatches, packsOf} from "./osd-packs.mjs";
import {runsAs} from "./osd-main.mjs";
import {pull, treeDigest} from "./osd-oci.mjs";
import {archiveFiles} from "./osd-source-zip.mjs";
export {MARKER, markerOf};
// loaded on demand: a system install pulls in the layer zip encoder, which
// costs ~0.3 s to import, and every build imports this module for unfetched()
// (the warm compiler worker's startup deadline is 500 ms in its tests)
export async function fetchSystem(...args) {
  return (await import("./osd-system-fetch.mjs")).fetchSystem(...args);
}


function git(args, cwd) {
  return execFileSync("git", args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
}

/** the repository at the ref, in a temporary directory: [dir, commit] */
function checkout(repo, ref) {
  const tmp = mkdtempSync(join(tmpdir(), "osd-fetch-"));
  try {
    git(["init", "-q"], tmp);
    git(["remote", "add", "origin", repo], tmp);
    try {
      git(["fetch", "-q", "--depth", "1", "origin", ref], tmp);
    } catch (shallow) {
      // a server that will not hand out a commit by name: take the history
      // and find it there
      git(["fetch", "-q", "origin"], tmp);
      try {
        git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], tmp);
      } catch {
        try {
          git(["rev-parse", "--verify", "-q", `origin/${ref}^{commit}`], tmp);
        } catch {
          throw new FetchFailed(repo, ref, shallow.stderr?.toString() ?? shallow.message);
        }
      }
    }
    let commit;
    try {
      commit = git(["rev-parse", "FETCH_HEAD"], tmp);
    } catch {
      commit = git(["rev-parse", `origin/${ref}`], tmp);
    }
    git(["checkout", "-q", commit], tmp);
    return {dir: tmp, commit};
  } catch (error) {
    rmSync(tmp, {recursive: true, force: true});
    throw error;
  }
}

/** copy `from` into `to`, minus the excluded paths; returns the files copied */
function copyTree(from, to, source) {
  const fail = (path, code) => { throw new FetchFailed(source.repo, source.ref, path, code); };
  if (!lstatSync(from).isDirectory()) fail(source.path, "UNSAFE_ENTRY");
  const patterns = source.exclude.map((e) => new RegExp(e, "i"));
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(from, dir)).sort()) {
      if (entry === ".git") {
        continue;
      }
      const rel = dir === "" ? entry : `${dir}/${entry}`;
      if (patterns.some((p) => p.test(rel))) {
        continue;
      }
      const file = join(from, rel);
      if (rel === SOURCE) fail(rel, "RESERVED_NAME");
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        walk(rel);
      } else {
        if (!stat.isFile()) fail(rel, "UNSAFE_ENTRY");
        mkdirSync(join(to, dir), {recursive: true});
        cpSync(file, join(to, rel));
        files.push(rel);
      }
    }
  };
  walk("");
  return files;
}

/** The staged folder carries its identity; its rename commits the install. */
async function publish(pack, source, stage, entry, log) {
  writeFileSync(join(stage, SOURCE), JSON.stringify(entry, null, 2) + "\n", {flag: "wx"});
  const old = stage.replace(".osd-fetch-stage-", ".osd-fetch-old-");
  let movedOld = false;
  if (existsSync(source.dir)) {
    renameSync(source.dir, old);
    movedOld = true;
  }
  try {
    renameSync(stage, source.dir);
  } catch (error) {
    if (movedOld && !existsSync(source.dir)) {
      try { renameSync(old, source.dir); }
      catch (restoreError) { error.cause = restoreError; }
    }
    throw error;
  }
  if (process.env.OSD_FETCH_TEST_PAUSE === "after-swap") {
    log("OSD_FETCH_TEST_PAUSE=after-swap");
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  if (movedOld) {
    try { rmSync(old, {recursive: true, force: true}); }
    catch (error) { log(`warning: installed ${pack.name}/${source.folder}; cleanup left ${old}: ${error.message}`); }
  }
  const markerTemp = `${stage}.json`;
  try {
    const marker = markerOf(pack.dir);
    marker[source.folder] = entry;
    writeFileSync(markerTemp, JSON.stringify(marker, null, 2) + "\n");
    renameSync(markerTemp, join(pack.dir, MARKER));
  } catch (error) {
    log(`warning: installed ${pack.name}/${source.folder}; summary failed: ${error.message}`);
  } finally {
    try { rmSync(markerTemp, {force: true}); }
    catch (error) { log(`warning: cleanup left ${markerTemp}: ${error.message}`); }
  }
}

// A recent leftover may belong to a concurrent fetch. Cleanup is optional.
function cleanupLeftovers(dir) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\.osd-fetch-(old|stage)-/.test(name)) continue;
      const path = join(dir, name);
      try {
        if (lstatSync(path).mtimeMs < cutoff) rmSync(path, {recursive: true, force: true});
      } catch { /* another fetch or a read-only pack can prevent cleanup */ }
    }
  } catch { /* fetching and read-only no-ops do not require cleanup */ }
}

/** Fetch one source; matching folder identity needs no write access. */
export async function fetchSource(pack, source, options = {}) {
  const log = options.log ?? (() => {});
  cleanupLeftovers(pack.dir);
  const before = sourceOf(source.dir);
  if (options.force !== true && existsSync(source.dir) && statSync(source.dir).isDirectory() && sourceMatches(source, before)) {
    log(`${pack.name}/${source.folder}: already at ${before.digest ? before.digest.slice(0, 19) : before.commit.slice(0, 12)}`);
    return {pack: pack.name, folder: source.folder, commit: before.commit, digest: before.digest, treeDigest: before.treeDigest, files: before.files, fetched: false};
  }
  if (source.oci !== undefined) return fetchOci(pack, source, log);
  log(`${pack.name}/${source.folder}: fetching ${source.repo} at ${source.ref}`);
  const {dir, commit} = checkout(source.repo, source.ref);
  let stage;
  try {
    const from = join(dir, source.path);
    if (existsSync(from) === false) {
      throw new FetchFailed(source.repo, source.ref, `no /${source.path} in it`);
    }
    stage = mkdtempSync(join(pack.dir, ".osd-fetch-stage-"));
    // mkdtemp makes it 0700; the published folder keeps the mode a plain mkdir gave it
    chmodSync(stage, 0o777 & ~process.umask());
    const files = copyTree(from, stage, source);
    await publish(pack, source, stage, {
      repo: source.repo, ref: source.ref, commit, path: source.path, exclude: source.exclude,
      files: files.length, at: new Date().toISOString(),
    }, log);
    log(`${pack.name}/${source.folder}: ${files.length} files from ${commit.slice(0, 12)}`);
    return {pack: pack.name, folder: source.folder, commit, files: files.length, fetched: true};
  } finally {
    for (const path of [stage, dir].filter(Boolean)) {
      try { rmSync(path, {recursive: true, force: true}); }
      catch (error) { log(`warning: cleanup left ${path}: ${error.message}`); }
    }
  }
}

async function fetchOci(pack, source, log) {
  let stage;
  try {
    const layer = await pull(source.oci, {cacheDir: join(pack.root, ".local", "oci")});
    const typed = layer.layers.filter((l) => l.descriptor.mediaType === "application/vnd.osd.abapgit.zip");
    const payload = typed.length === 1 ? typed[0] : typed.length === 0 && layer.layers.length === 1
      && layer.layers[0].descriptor.annotations?.["org.opencontainers.image.title"]?.endsWith(".zip") ? layer.layers[0] : undefined;
    if (!payload) throw new Error(`no unambiguous ABAP zip layer; media types: ${layer.layers.map((l) => l.descriptor.mediaType).join(", ")}`);
    const archive = archiveFiles(payload.bytes);
    const digest = treeDigest(archive);
    if (layer.config?.treeDigest !== undefined && layer.config.treeDigest !== digest) {
      throw new Error(`TREE_MISMATCH: expected ${layer.config.treeDigest}, got ${digest}`);
    }
    const prefix = source.path ? `${source.path}/` : "";
    const patterns = source.exclude.map((e) => new RegExp(e, "i"));
    const selected = [...archive].filter(([path]) => path.startsWith(prefix)).map(([path, bytes]) => [path.slice(prefix.length), bytes]);
    if (!selected.length) throw new Error(`no /${source.path} in it`);
    stage = mkdtempSync(join(pack.dir, ".osd-fetch-stage-"));
    // mkdtemp makes it 0700; the published folder keeps the mode a plain mkdir gave it
    chmodSync(stage, 0o777 & ~process.umask());
    let files = 0;
    for (const [path, bytes] of selected) {
      // copyTree skips excluded directories as well as individual files.
      const parts = path.split("/");
      if (parts.includes(".git") || parts.some((_, i) => patterns.some((p) => p.test(parts.slice(0, i + 1).join("/"))))) continue;
      if (path === SOURCE) throw new FetchFailed(source.oci, undefined, path, "RESERVED_NAME");
      mkdirSync(dirname(join(stage, path)), {recursive: true});
      writeFileSync(join(stage, path), bytes);
      files++;
    }
    await publish(pack, source, stage, {oci: source.oci, digest: layer.manifest.digest, treeDigest: digest,
      path: source.path, exclude: source.exclude, files, at: new Date().toISOString()}, log);
    log(`${pack.name}/${source.folder}: ${files} files from ${source.oci.split("@")[1].slice(0, 19)} tree ${digest.slice(0, 19)}`);
    return {pack: pack.name, folder: source.folder, digest: layer.manifest.digest, treeDigest: digest, files, fetched: true};
  } catch (error) {
    if (error instanceof FetchFailed) throw error;
    const failure = new FetchFailed(source.oci, undefined, error.message, error.code);
    if (error.cause) failure.cause = error.cause;
    throw failure;
  } finally {
    if (stage) {
      try { rmSync(stage, {recursive: true, force: true}); }
      catch (error) { log(`warning: cleanup left ${stage}: ${error.message}`); }
    }
  }
}

/** every source of every pack the root sees */
export async function fetchAll(root, options = {}) {
  const out = [];
  for (const pack of packsOf(root, options.env ?? process.env)) {
    for (const source of pack.sources) {
      out.push(await fetchSource(pack, source, options));
    }
  }
  return out;
}

/** what is declared and not there, without touching the network */
export function unfetched(root, env = process.env) {
  return packsOf(root, env).flatMap((pack) => pack.missing.map((s) => ({pack: pack.name, folder: s.folder, repo: s.repo, ref: s.ref, oci: s.oci})));
}

/** one line per missing source, for a build that refuses */
export function describeUnfetched(list) {
  return list.map((m) => `pack ${m.pack} fetches ${m.folder} from ${m.oci ?? `${m.repo} at ${(m.ref ?? "unknown ref").slice(0, 12)}`} and it is not there`).join("; ")
    + " — run: node tools/osd-fetch.mjs";
}

export class FetchFailed extends Error {
  constructor(repo, ref, why, code = "FETCH_FAILED") {
    super(`${repo}${ref ? ` at ${ref}` : ""}: ${code === "FETCH_FAILED" ? "" : `${code}: `}${why}`);
    this.code = code;
  }
}

export async function main(args) {
  const root = resolve(process.env.OSD_ROOT ?? process.cwd());
  if (args[0] === "--system") {
    if (args.length !== 2) throw new Error("usage: osd-fetch --system <ref@digest | index.json>");
    await fetchSystem(root, args[1], {log: console.log});
    return 0;
  }
  if (args.includes("--check")) {
    const missing = unfetched(root);
    for (const m of missing) {
      console.log(`${m.pack}/${m.folder}: not fetched (${m.oci ?? `${m.repo} at ${(m.ref ?? "unknown ref").slice(0, 12)}`})`);
    }
    console.log(missing.length === 0 ? "every declared source is there" : `${missing.length} to fetch`);
    return missing.length === 0 ? 0 : 1;
  }
  const only = args.filter((a) => a.startsWith("--") === false);
  let n = 0;
  for (const pack of packsOf(root)) {
    if (only.length > 0 && only.includes(pack.name) === false) {
      continue;
    }
    for (const source of pack.sources) {
      await fetchSource(pack, source, {force: args.includes("--force"), log: (line) => console.log(`osd-fetch: ${line}`)});
      n += 1;
    }
  }
  if (n === 0) {
    console.log(`osd-fetch: no pack declares a source${only.length > 0 ? ` (asked for ${only.join(", ")})` : ""}`);
  }
  return 0;
}

if (runsAs("osd-fetch.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`osd-fetch: ${error.code ?? "ERROR"}: ${error.message}`);
    process.exit(1);
  });
}
