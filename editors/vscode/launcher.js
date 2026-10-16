// B0 "Pocket SAP" (docs/vscode-extension.md, "B0 spike"): the extension
// starts and stops the system itself, so a user opens a folder and clicks
// Start, with no terminal. This module is the pure half -- plain Node, no
// `vscode` import, unit-testable on its own (test/vscode-launcher.mjs) --
// the way lib.js is the pure half of the rest of the extension.
//
// What it spawns is exactly what `npm start` spawns: `tools/osd-build.mjs`
// (what `npm run transpile` runs), then `node test/run.mjs`, with
// `process.execPath` rather than a `node` on some PATH, because VS Code's
// extension host already IS a Node and does not need to find another one.
//
// Every byte this writes lives under the caller's `storageDir`, never under
// `osdHome` and never under a workspace folder: the database
// (`STG_DB_PATH`), the TLS directory (`OSD_TLS_DIR`, new below) and the
// projected workspace packs (or generated ABAP-only manifests; see
// `ensureWorkspacePacks`). Nothing here ever writes into a tracked file of
// the system it starts.
"use strict";

const {spawn} = require("node:child_process");
const {killTree} = require("./process-tree");
const {JobWorker, workerEnabled} = require("./job-worker");
const {startCredentials} = require("./abapfs-bridge.js");
const {createServer} = require("node:net");
const {EventEmitter} = require("node:events");
const {createHash, randomUUID} = require("node:crypto");
const {request} = require("node:http");
const fs = require("node:fs");
const {createBrotliDecompress} = require("node:zlib");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// Ports 3531-3539 only (the budget this spike was given); nothing here ever
// asks for a port outside it, and a caller that wants a different range
// still has to say so explicitly.
const PORT_RANGE = {from: 3531, to: 3539};

/** Turn launcher/build output, plus an error when output is empty, into the
 *  recovery actions the extension can offer. Kept pure so real log formats
 *  and no-output failures pin the mapping without needing a VS Code host. */
function classify(logText, error) {
  const text = [
    typeof logText === "string" ? logText : "",
    typeof error?.code === "string" ? error.code : "",
    typeof error?.message === "string" ? error.message : "",
  ].filter(Boolean).join("\n");
  const mismatch = text.match(/osd: (?:layer|pack) [^\r\n]+ needs osd >= \d+\.\d+\.\d+; this system is \d+\.\d+\.\d+ — update the extension \(or the binary\)/);
  if (mismatch) return {kind: "version-mismatch", message: mismatch[0], actions: ["Update"]};
  if (/\bUNFETCHED\b/.test(text)) {
    return {kind: "unfetched", message: "Some packs have not been fetched.", actions: ["Fetch packs"]};
  }
  if (/\bEADDRINUSE\b|address already in use|no free port/i.test(text)) {
    return {kind: "port-in-use", message: "The osd port is already in use.", actions: ["Pick another port"]};
  }
  return {kind: "build-failed", message: "The build failed.", actions: ["Open log", "Full rebuild"]};
}

/** OSD_WARM enables warm ABAP activation; auto follows the warm compiler's
 *  existing 4 GB minimum-memory guidance. Explicit output prevents an
 *  inherited OSD_WARM value from overriding the extension's choice. */
function warmEnvironment(mode = "auto", memoryBytes = os.totalmem()) {
  const on = shouldWarm(mode, memoryBytes);
  return {OSD_WARM: on ? "1" : "0"};
}

// ---- databases (docs/vscode-extension.md, "Databases") -------------------
//
// `test/setup.mjs` already picks a backend off `STG_DB` (file | postgres |
// hana | duckdb) -- this section is only the env this launcher hands that
// process, built the same pure way as everything else here: no `vscode`
// import, so it is unit-testable without a server or a real database.
//
// A password never lives in `config`'s caller-visible shape for long: the
// extension reads it out of `context.secrets` right before calling this and
// it travels only in the env of the one process it is for, never in argv
// (a `ps` on this host would otherwise show it) and never written to a
// tracked file or to `settings.json`.

const DATABASE_KINDS = ["sqlite", "postgres", "hana", "duckdb"];

/** A short, stable, per-`osdHome` name for the schema/database this
 *  launcher's own instance uses by default, so two workspace windows on two
 *  different checkouts never collide in one shared HANA or PostgreSQL, and
 *  a rerun of the same checkout keeps writing to the same place. Never an
 *  existing schema: it is derived, not typed in by a person, so there is
 *  nothing to accidentally point at somebody's own `OSD`. */
function defaultDedicatedName(osdHome) {
  return createHash("sha1").update(String(osdHome)).digest("hex").slice(0, 8);
}

/** The env `STG_DB` and its friends are read from (test/setup.mjs), built
 *  from one `{kind, host, port, user, database, schema, password, fresh}`
 *  config -- `kind` is one of DATABASE_KINDS, everything else optional and
 *  named the way the setting it comes from is named, not the way the env
 *  var is. Unset fields simply leave the matching env var unset, so the
 *  client's own default (tools/hana-client.mjs, tools/postgres-client.mjs)
 *  applies exactly as it would with no launcher involved at all. */
function databaseEnv(config = {}) {
  const kind = config.kind ?? "sqlite";
  if (kind === "sqlite") {
    return {STG_DB: "file"};
  }
  if (kind === "duckdb") {
    return {STG_DB: "duckdb"};
  }
  if (kind === "postgres") {
    const env = {STG_DB: "postgres"};
    if (config.host) env.PGHOST = String(config.host);
    if (config.port) env.PGPORT = String(config.port);
    if (config.user) env.PGUSER = String(config.user);
    if (config.database) env.PGDATABASE = String(config.database);
    if (config.password) env.PGPASSWORD = String(config.password);
    return env;
  }
  if (kind === "hana") {
    const env = {STG_DB: "hana"};
    if (config.host) env.HANA_HOST = String(config.host);
    if (config.port) env.HANA_PORT = String(config.port);
    if (config.user) env.HANA_USER = String(config.user);
    if (config.schema) env.HANA_SCHEMA = String(config.schema);
    if (config.password) env.HANA_PASSWORD = String(config.password);
    if (config.fresh) env.STG_DB_FRESH = "1";
    return env;
  }
  throw new Error(`unknown database kind: ${kind}`);
}

/** A short label for the status bar and the tree's own state row, e.g.
 *  "SQLite", "HANA (schema OSD_A1B2C3D4)", "PostgreSQL (osd_a1b2c3d4)" --
 *  built from `config` alone (what this launcher asked for), never from a
 *  live connection, so it is available the instant a start is requested and
 *  never carries a password. */
function describeDatabase(config = {}) {
  const kind = config.kind ?? "sqlite";
  if (kind === "sqlite") return "SQLite";
  if (kind === "duckdb") return "DuckDB";
  if (kind === "postgres") return config.database ? `PostgreSQL (${config.database})` : "PostgreSQL";
  if (kind === "hana") return config.schema ? `HANA (schema ${config.schema})` : "HANA";
  return kind;
}

/** Whether `osdHome` has the native DuckDB module a `duckdb` choice needs
 *  (`@duckdb/node-api`, CLAUDE.md "Substrate"): present in an ordinary
 *  checkout's `node_modules/`, and never shipped into a packaged `.vsix`
 *  (scripts/build-vsix.mjs, "left out on purpose" -- native, and not on the
 *  default path). Checked before a build is even attempted, so a packaged
 *  install answers with a plain sentence instead of a build failure a
 *  person has to read a stack trace to understand. */
function duckdbAvailable(osdHome) {
  return isDir(path.join(osdHome, "node_modules", "@duckdb", "node-api"));
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---- warm (T7, docs/vscode-extension.md "Warm", docs/warm-compile.md) ----
//
// `osd.warm`: "auto" (the default: on when the machine has at least
// WARM_MEMORY_FLOOR_BYTES of RAM -- the prime measured ~0.7 GB, docs/warm-
// compile.md), "on" or "off". This only decides whether the launched
// system is TOLD to try (OSD_WARM=1 in its env, below); whether it actually
// primes is the server's own business (tools/osd-store.mjs warmUp()) --
// on a pinned transpiler without abaplint/transpiler#1899/#1900/#1921 it
// stays cold and says why, and that reason is shown as-is rather than
// guessed at here.
const WARM_MEMORY_FLOOR_BYTES = 4 * 1024 * 1024 * 1024;

/** Whether a launch should set OSD_WARM=1, given `osd.warm`'s mode and the
 *  machine's total memory (os.totalmem() by default; a test hands in a
 *  number instead of measuring the real machine). Pure, so the auto rule is
 *  tested without starting anything. */
function shouldWarm(mode, totalMemBytes = os.totalmem()) {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return totalMemBytes >= WARM_MEMORY_FLOOR_BYTES;
}

// ---- ports ---------------------------------------------------------------

/** Whether a TCP port on 127.0.0.1 is free right now. Best-effort: a port
 *  free at the check can still be taken between the check and the spawn --
 *  the caller (start(), below) treats "the server never answered" as the
 *  failure that covers that race, rather than pretending this can rule it
 *  out. */
function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** The first free port in `range` (default 3531-3539), or throws when none
 *  of them is. */
async function pickPort(range = PORT_RANGE) {
  for (let port = range.from; port <= range.to; port++) {
    if (await isFree(port)) {
      return port;
    }
  }
  throw new Error(`no free port in ${range.from}-${range.to}`);
}

/** A free loopback port for a Node inspector. Unlike the listener port this
 *  has no small product budget; the operating system chooses an ephemeral
 *  port and the caller closes the probe before starting the child. */
function pickInspectorPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** `OSD_INSPECT` belongs to the launched system setting, never an inherited
 *  shell value. The runtime uses this only for its ABAP-serving child. */
function debugSystemEnv(env, enabled, port) {
  const out = {...env};
  delete out.OSD_INSPECT;
  if (enabled) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid inspector port: ${port}`);
    }
    out.OSD_INSPECT = String(port);
    out.OSD_WORKERS = "1";
  }
  return out;
}

// ---- workspace layers -----------------------------------------------------

/** Whether `dir` looks like an abapGit folder: a `.abapgit.xml` at its root,
 *  or a `*.clas.abap` / `*.prog.abap` under `src/` (the shapes the task
 *  names -- not every abapGit layout, just the two cheap-to-check signs of
 *  one). */
function looksLikeAbapGitFolder(dir) {
  if (isFile(path.join(dir, ".abapgit.xml"))) {
    return true;
  }
  const src = path.join(dir, "src");
  if (isDir(src) === false) {
    return false;
  }
  let entries;
  try {
    entries = fs.readdirSync(src);
  } catch {
    return false;
  }
  return entries.some((name) => /\.(clas|prog)\.abap$/i.test(name));
}

/** The one workspace shape where starting the extension's bundled system
 *  beside the open-steamgate checkout can hide edits to the system itself.
 *  Keep the filesystem check here separate from the pure target decision
 *  below, so that decision can be exercised with plain values in tests. */
function isOpenSteamgateCheckout(dir) {
  return isFile(path.join(dir, "abap_transpile.json")) &&
    isFile(path.join(dir, "tools", "osd-build.mjs"));
}

/** Choose the system tree Start should use. `workspaceIsOpenSteamgate` and
 *  `bundledHome` are facts supplied by the VS Code adapter; this function
 *  has no filesystem or VS Code dependency. A prompt is needed only for one
 *  open-steamgate workspace folder, no configured `osd.home`, and a bundled
 *  system that can actually be selected. `rememberedChoice` is either
 *  `"bundled"` or unset; choosing Always ask leaves it unset. */
function decideStartTarget({configuredHome, workspaceFolder, workspaceIsOpenSteamgate = false,
  bundledHome, rememberedChoice} = {}) {
  const configured = typeof configuredHome === "string" ? configuredHome.trim() : "";
  if (configured !== "") {
    const source = typeof workspaceFolder === "string" &&
      configured === workspaceFolder ? "workspace" : "configured";
    return {kind: "ready", osdHome: configured, source};
  }

  if (typeof workspaceFolder === "string" && workspaceIsOpenSteamgate && typeof bundledHome === "string") {
    if (rememberedChoice === "bundled") {
      return {kind: "ready", osdHome: bundledHome, source: "bundled"};
    }
    return {kind: "prompt", workspaceHome: workspaceFolder, bundledHome};
  }

  if (typeof bundledHome === "string") {
    return {kind: "ready", osdHome: bundledHome, source: "bundled"};
  }
  if (typeof workspaceFolder === "string") {
    return {kind: "ready", osdHome: workspaceFolder, source: "workspace"};
  }
  return {kind: "unavailable"};
}

/** `{folder, srcDir, manifest}` for every workspace pack or abapGit folder.
 *  `srcDir` is the fallback folder for a workspace without a manifest,
 *  as an input (its own `src/` when there is one, else the folder itself --
 *  a repository whose ABAP sits at its own root rather than under `src/`).
 *  Pure: `folders` is a plain array of absolute paths, no `vscode.Uri`. */
function detectWorkspaceLayers(folders) {
  const out = [];
  for (const folder of folders ?? []) {
    if (typeof folder !== "string" || isDir(folder) === false) {
      continue;
    }
    const manifest = path.join(folder, "osd-pack.json");
    if (isFile(manifest) === false && looksLikeAbapGitFolder(folder) === false) {
      continue;
    }
    const src = path.join(folder, "src");
    out.push({folder, srcDir: isDir(src) ? src : folder, manifest: isFile(manifest) ? manifest : undefined});
  }
  return out;
}

/** A short, stable, filesystem-safe name for a workspace layer's pack
 *  directory: the folder's own base name plus a hash of its full path, so
 *  two folders named `src` in different places never collide and a rerun
 *  names the same folder the same thing. */
function packNameOf(folder) {
  const base = path.basename(folder).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ws";
  const hash = createHash("sha1").update(folder).digest("hex").slice(0, 10);
  return `ws-${base}-${hash}`;
}

/** The workspace layers the system already finds as packs of its own.
 *  Start projects each workspace layer into a pack under storage; when
 *  osdHome's packs/ or the inherited OSD_PACKS (directly, or as a container,
 *  or through a symlink) already bring the same folder, a projection would
 *  bring its pack name a second time from another directory, and
 *  tools/osd-packs.mjs refuses that (BAD_PACK). Rather than repeat its rules
 *  here, ask it: `packsOf` (the home's own copy, passed in) lists what it
 *  finds, and a layer whose folder is one of those is not projected. When
 *  the question cannot be asked (an old home, a pack it refuses), nothing is
 *  covered and the build says what is wrong, as before. */
function coveredLayers(packsOf, home, env, layers) {
  const fold = (dir) => (process.platform === "win32" ? dir.toLowerCase() : dir);
  const real = (dir) => { try { return fold(fs.realpathSync(dir)); } catch { return fold(path.resolve(dir)); } };
  let found;
  try {
    found = packsOf(home, {...env, OSD_WEB_PACKS: undefined});
  } catch {
    return new Set();
  }
  const dirs = new Set(found.map((pack) => real(pack.dir)));
  return new Set(layers.filter((layer) => layer.manifest && dirs.has(real(layer.folder))));
}

function countFiles(dir, accept, seen = new Set()) {
  if (!isDir(dir)) return 0;
  const real = fs.realpathSync(dir);
  if (seen.has(real)) return 0;
  seen.add(real);
  let count = 0;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink() && isDir(file)) count += countFiles(file, accept, seen);
    else if (accept(entry.name)) count++;
  }
  return count;
}

/** Contribution counts for the Layers tree, read from the workspace itself. */
function layerContributions(layer) {
  if (!layer.manifest) return {abap: countFiles(layer.srcDir, (name) => /\.abap$/i.test(name))};
  const manifest = JSON.parse(fs.readFileSync(layer.manifest, "utf8"));
  const named = (part, fallback) => part === false ? undefined : path.join(layer.folder, part ?? fallback);
  const abapFolders = [manifest.abap ?? (isDir(path.join(layer.folder, "src")) ? "src" : ".")].flat();
  const abap = abapFolders
    .reduce((n, folder) => n + countFiles(named(folder, "src"), (name) => /\.abap$/i.test(name)), 0);
  const data = countFiles(named(manifest.data, "data"), (name) => /\.tabu\.json$/i.test(name));
  const firstAbap = abapFolders[0] ?? "src";
  const ddic = countFiles(named(manifest.ddic, path.join(firstAbap, "ddic")),
    (name) => /\.(tabl|dtel|doma|ttyp|view|shlp|enqu)\.xml$/i.test(name));
  return {abap, data, ddic, webapp: isDir(named(manifest.webapp, "webapp")) ? `/app/${String(manifest.name ?? path.basename(layer.folder)).toLowerCase()}/` : undefined,
    tiles: [manifest.tiles ?? []].flat().filter((tile) => tile && typeof tile === "object").length};
}

/** A manifest path must stay inside its workspace before we choose a link. */
function workspacePackPath(folder, entry) {
  if (typeof entry !== "string" || entry === "" || path.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
    throw new Error(`workspace pack path must be a nonempty relative path in ${folder}: ${String(entry)}`);
  }
  const parts = entry.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) {
    throw new Error(`workspace pack path must not contain '..' in ${folder}: ${entry}`);
  }
  const normalized = path.normalize(parts.join(path.sep));
  return normalized;
}

/** Projects detected workspace folders into an OSD_PACKS container. A folder
 *  with a manifest keeps it and links all declared parts; one without it gets
 *  the previous ABAP-only manifest and src link. tools/osd-packs.mjs reads
 *  either exactly like any other pack,
 *  alongside a persistent notebook scratch pack which is deliberately kept
 *  when workspace layers are refreshed.
 *
 *  Nothing is written under `osdHome` or under a workspace folder -- the
 *  container lives entirely under `storageDir` (the extension's own
 *  storage). Workspace layers are rebuilt on each call, so a closed folder
 *  does not leave a stale layer behind; the scratch pack persists.
 *
 *  Returns the container directory to set `OSD_PACKS` to. The scratch pack
 *  is present even with no workspace layers, so a notebook can write to a
 *  root the already-running ObjectStore knew about at startup. */
function ensureWorkspacePacks(storageDir, layers) {
  const packsRoot = path.join(storageDir, "packs");
  fs.mkdirSync(packsRoot, {recursive: true});
  for (const name of fs.readdirSync(packsRoot)) {
    if (name.startsWith("ws-")) {
      fs.rmSync(path.join(packsRoot, name), {recursive: true, force: true});
    }
  }
  const scratchDir = path.join(packsRoot, "notebook-scratch");
  fs.mkdirSync(path.join(scratchDir, "src"), {recursive: true});
  const scratchManifest = path.join(scratchDir, "osd-pack.json");
  fs.writeFileSync(scratchManifest, JSON.stringify({
    name: "notebook-scratch",
    order: 10000,
    description: "ABAP notebook cell source",
  }, undefined, 2));
  layers.forEach((layer, i) => {
    const name = packNameOf(layer.folder);
    const dir = path.join(packsRoot, name);
    fs.mkdirSync(dir, {recursive: true});
    if (layer.manifest) {
      const manifest = JSON.parse(fs.readFileSync(layer.manifest, "utf8"));
      // Projection changes the directory name; preserve the workspace's
      // implicit pack name for app URLs and default tiles.
      fs.writeFileSync(path.join(dir, "osd-pack.json"), JSON.stringify({name: path.basename(layer.folder), ...manifest}));
      // Preserve every path the manifest names, including custom and ordered
      // ABAP folders. A junction is required for directory links on Windows.
      const folders = [manifest.abap ?? (isDir(path.join(layer.folder, "src")) ? "src" : "."), manifest.data ?? "data",
        manifest.ddic ?? "ddic", manifest.webapp ?? "webapp",
        ...[manifest.sources ?? []].flat().filter((source) => source && typeof source === "object")
          .map((source) => source.folder)].flat();
      const normalized = folders.filter((entry) => entry !== undefined && entry !== false)
        .map((entry) => workspacePackPath(layer.folder, entry));
      if (normalized.includes(".")) {
        normalized.push(...fs.readdirSync(layer.folder).filter((entry) => entry !== "osd-pack.json"));
      }
      for (const entry of new Set(normalized)) {
        if (entry === ".") continue;
        const part = entry.split(path.sep)[0];
        const target = path.join(layer.folder, part);
        const link = path.join(dir, part);
        if (fs.existsSync(target) && !fs.existsSync(link)) {
          fs.symlinkSync(target, link, fs.statSync(target).isDirectory()
            ? (process.platform === "win32" ? "junction" : "dir") : "file");
        }
      }
    } else {
      fs.writeFileSync(path.join(dir, "osd-pack.json"), JSON.stringify({
        name, order: 900 + i, description: `workspace layer: ${layer.folder}`,
      }, undefined, 2));
      fs.symlinkSync(layer.srcDir, path.join(dir, "src"), process.platform === "win32" ? "junction" : "dir");
    }
  });
  return packsRoot;
}

// ---- the two processes `npm start` is (tools/osd-build.mjs, test/run.mjs) -

/** Runs one Node script to completion, streaming its stdout/stderr lines to
 *  `onLine` as they arrive (so a caller can show a build's own log, not just
 *  its exit code) and resolving with `{code, output}` when it exits. Used
 *  for the build step, which is a run-to-completion command, not a server. */
function runToCompletion(cwd, script, args, env, onLine, onChild) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [script, ...args], {cwd, env, detached: process.platform !== "win32"});
      onChild?.(child);
    } catch (error) {
      reject(error);
      return;
    }
    let output = "";
    const onData = (data) => {
      const text = data.toString();
      output += text;
      onLine?.(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      onChild?.(undefined);
      resolve({code, output});
    });
  });
}

/** POST {open, port}, or GET its state without a body, to /osd/inspector (test/start.mjs,
 *  tools/osd-inspector.mjs): the debugger on demand. Resolves the answer,
 *  rejects with the system's own reason. */
function inspectorOnce(port, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({hostname: "127.0.0.1", port, path: "/osd/inspector", method: payload === undefined ? "GET" : "POST", timeout: timeoutMs,
      headers: payload === undefined ? {} : {"content-type": "application/json", "content-length": Buffer.byteLength(payload)}}, (res) => {
      let text = "";
      // Once headers arrive, a truncated response can close the request
      // without a request error or an end event. Settle that path too.
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("the inspector door closed before its answer was complete")));
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let answer;
        try {
          answer = JSON.parse(text);
        } catch {
          answer = undefined;
        }
        if (res.statusCode === 200 && answer !== undefined) resolve(answer);
        else reject(new Error(answer?.error ?? `the inspector door answered ${res.statusCode}`));
      });
    });
    // A socket timeout alone can be prolonged by a trickling response.
    const timer = setTimeout(() => req.destroy(new Error(`the inspector door did not answer within ${timeoutMs} ms`)), timeoutMs);
    req.once("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`the inspector door did not answer within ${timeoutMs} ms`)));
    req.end(payload);
  });
}

/** One `GET /osd/serving` (tools/osd-serve.mjs, forwarded by test/start.mjs
 *  the way every other `/osd/*` door is), or `undefined` when nothing
 *  answers yet -- refused, reset, or the connection simply is not there.
 *  Never throws: "not up yet" is the expected answer for most of a build. */
function servingOnce(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = request({hostname: "127.0.0.1", port, path: "/osd/serving", method: "GET", timeout: timeoutMs}, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(undefined);
        }
      });
    });
    const timer = setTimeout(() => req.destroy(), timeoutMs);
    req.once("close", () => clearTimeout(timer));
    req.on("error", () => resolve(undefined));
    req.on("close", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

/** Polls `/osd/serving` until it answers `ready: true` with a generation, or
 *  the timeout passes. This is the "waits for 'serving generation'" step of
 *  the task, done by asking the server rather than by grepping its log --
 *  robust to a log line's wording changing, which the text would not be. */
async function waitForServing(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const intervalMs = options.intervalMs ?? 300;
  // a system that answers "starting" (a boot on a remote HANA takes
  // minutes) is waited for, up to the runtime's own boot limit; the timeout
  // above is then a limit on NOT answering, as tools/osd-runtime.mjs does
  const bootMs = options.bootMs ?? (Number(process.env.OSD_BOOT_TIMEOUT_MS) || 15 * 60 * 1000);
  const started = Date.now();
  let deadline = started + timeoutMs;
  let lastPhase;
  for (;;) {
    // the start race settled another way (the child exited, a stop): stop
    // polling a port that is no longer ours
    if (options.signal?.aborted) {
      throw new Error("osd readiness poll cancelled");
    }
    const serving = await servingOnce(port);
    if (serving?.ready === true && serving.generation !== undefined
      && (options.launcherPid === undefined || serving.launcherPid === options.launcherPid)
      && (options.launcherIdentity === undefined || serving.launcherIdentity === options.launcherIdentity)) {
      return serving;
    }
    if (serving?.starting === true
      && (options.launcherPid === undefined || serving.launcherPid === options.launcherPid)
      && (options.launcherIdentity === undefined || serving.launcherIdentity === options.launcherIdentity)) {
      deadline = Math.min(Math.max(deadline, Date.now() + timeoutMs), started + Math.max(bootMs, timeoutMs));
      lastPhase = serving.phase ?? lastPhase;
      options.onStarting?.(serving);
    }
    if (Date.now() >= deadline) {
      throw new Error(`osd never answered ready on :${port} within ${Date.now() - started} ms` +
        (lastPhase === undefined ? "" : ` (last step: ${lastPhase})`));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// How long a stop waits before SIGKILL. tools/osd-runtime.mjs gives each
// serving worker up to 45 s to quiesce and kills it at 55 s (a DuckDB file
// must checkpoint); a SIGKILL of test/run.mjs before that skips its reaper
// and can leave a worker holding the port and the database. So: above 55 s.
const STOP_GRACE_MS = 60000;
// what the start race answers when stop() ended the child it was waiting on
const STOPPED_WHILE_STARTING = Symbol("stopped while starting");

/** Sends `signal` to `child` and waits for it to actually exit, escalating
 *  to SIGKILL after `graceMs` -- the same shape `test/osd-child.mjs` already
 *  uses by hand for the same reason: a process that has not exited is a
 *  process that still holds the port and the database file. */
function terminate(child, {signal = "SIGTERM", graceMs = 15000} = {}) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    let timer;
    let killing = Promise.resolve();
    const finish = () => {
      if (done === false) {
        done = true;
        // a pending SIGKILL timer would keep the process alive for the
        // whole grace after the child is already gone
        clearTimeout(timer);
        killing.then(resolve, resolve);
      }
    };
    child.once("exit", finish);
    try {
      killing = killTree(child, signal);
      killing.catch(finish);
    } catch {
      finish();
      return;
    }
    timer = setTimeout(() => {
      if (done === false) {
        try {
          killing = killTree(child, "SIGKILL");
          killing.catch(finish);
        } catch {
          // already gone
        }
      }
    }, graceMs);
  });
}

// ---- materializing a bundled seed (packaging, docs/vscode-extension.md
// "Packaging"): a packaged .vsix carries a runnable system tree at
// `extension/osd/` (scripts/build-vsix.mjs). The install folder is
// read-only in spirit -- an update wipes it -- so this copies it once into
// the extension's own writable storage and everything the system writes
// (the database, gen/, a rebuilt output/) lands there, never in the
// extension folder and never in a workspace folder. ---------------------

/** Recursively copies `src` into `dest`. Files must not share inodes with
 *  the seed: Workbench saves reach ObjectStore.write(), which truncates and
 *  writes source files in place. A hard link would therefore let an edit in
 *  the writable home change the packaged seed and invalidate its ID. A
 *  symlink in the seed is kept as a symlink, not followed --
 *  `scripts/build-vsix.mjs` dereferences every symlink it packages
 *  (`copyReal`), so a real `.vsix` seed carries none today, but this keeps
 *  the tree copier general (the launcher test fixture includes one). */
function linkOrCopyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, {recursive: true});
    for (const name of fs.readdirSync(src)) {
      linkOrCopyTree(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  try {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

const SEED_ID_FILE = ".seed-id";
const MATERIALIZED_MARKER = ".osd-materialized";
const SEED_FILES_FILE = ".osd-seed-files.json";
const SERVING_LOCK_PREFIX = ".osd-serving-";
const SERVING_LOCK_PATTERN = /^\.osd-serving-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/;
const SEED_ID_PATTERN = /^[0-9a-f]{64}$/;
const HOME_NAME_PATTERN = /^osd-home-[0-9a-f]{64}$/;
const OLD_HOME_NAME_PATTERN = /^(?:osd-home-(?:[0-9a-f]{64}|previous(?:-(?:[0-9a-f]{64}|unknown)(?:-\d+)?)?)|\.osd-home-trash-[0-9a-f-]{36})$/;

/** Stable SHA-256 of a seed tree's paths and file contents. Root-level
 * launcher metadata (ID, marker, original-file list and serving locks) is
 * excluded. `modes` (relative "/"-path -> mode, unpackTar's result) stands
 * in for the file system's own permission bits: Windows reports 0o666/0o777
 * where the archive recorded 0o644/0o755, so a freshly unpacked seed would
 * never match its packaged ID there. */
function seedContentId(seedDir, modes = undefined) {
  const hash = createHash("sha256");
  const record = (kind, rel, content = Buffer.alloc(0), mode = 0) => {
    const name = Buffer.from(rel.replaceAll(path.sep, "/"), "utf8");
    const header = Buffer.alloc(13);
    header[0] = kind;
    header.writeUInt32BE(name.length, 1);
    header.writeBigUInt64BE(BigInt(content.length), 5);
    hash.update(header);
    hash.update(name);
    const modeBytes = Buffer.alloc(4);
    modeBytes.writeUInt32BE(mode & 0o7777);
    hash.update(modeBytes);
    hash.update(content);
  };
  const modeOf = (rel, stat) => modes?.get(rel.replaceAll(path.sep, "/")) ?? stat.mode;
  const visit = (dir, rel = "") => {
    const entries = fs.readdirSync(dir).sort();
    if (rel !== "") record(0x44, rel, Buffer.alloc(0), modeOf(rel, fs.lstatSync(dir)));
    for (const name of entries) {
      if (rel === "" && (name === SEED_ID_FILE || name === MATERIALIZED_MARKER ||
        name === SEED_FILES_FILE || SERVING_LOCK_PATTERN.test(name))) continue;
      const file = path.join(dir, name);
      const childRel = rel === "" ? name : path.join(rel, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        visit(file, childRel);
      } else if (stat.isSymbolicLink()) {
        record(0x4c, childRel, Buffer.from(fs.readlinkSync(file), "utf8"));
      } else if (stat.isFile()) {
        record(0x46, childRel, fs.readFileSync(file), modeOf(childRel, stat));
      } else {
        throw new Error(`Unsupported file in working copy: ${file}`);
      }
    }
  };
  visit(seedDir);
  return hash.digest("hex");
}

/** Writes the seed's content ID during packaging and returns it. */
function writeSeedId(seedDir) {
  const id = seedContentId(seedDir);
  fs.writeFileSync(path.join(seedDir, SEED_ID_FILE), `${id}\n`);
  return id;
}

/** Where a packaged seed lands under `globalStorageDir`, keyed by its
 *  content ID rather than extension version. */
function materializedHomeDir(globalStorageDir, seedId) {
  return path.join(globalStorageDir, `osd-home-${seedId}`);
}

/** Paths and bytes from the original seed, retained so a later update can
 * save only changed and added files, plus a list of deleted files. */
function seedFiles(dir) {
  const files = Object.create(null);
  function visit(folder, rel = "") {
    for (const name of fs.readdirSync(folder).sort()) {
      if (rel === "" && (name === SEED_ID_FILE || name === MATERIALIZED_MARKER ||
        name === SEED_FILES_FILE || SERVING_LOCK_PATTERN.test(name))) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const child = path.join(folder, name);
      const stat = fs.lstatSync(child);
      if (stat.isDirectory()) visit(child, childRel);
      else if (stat.isFile()) files[childRel] = `file:${createHash("sha256").update(fs.readFileSync(child)).digest("hex")}`;
      else if (stat.isSymbolicLink()) files[childRel] = `link:${fs.readlinkSync(child)}`;
      else throw new Error(`Unsupported file in working copy: ${child}`);
    }
  }
  visit(dir);
  return files;
}

function matchesHomeMetadata(home, seedId, snapshot) {
  const names = [SEED_ID_FILE, MATERIALIZED_MARKER, SEED_FILES_FILE];
  const read = (dir, name) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return undefined;
    if (!fs.lstatSync(file).isFile()) return false;
    return fs.readFileSync(file);
  };
  const expected = snapshot === undefined ? [
    `${seedId}\n`,
    `${seedId}\n`,
    JSON.stringify({seedId, files: seedFiles(home)}) + "\n",
  ] : names.map((name) => read(snapshot, name));
  return names.every((name, index) => {
    const actual = read(home, name);
    return actual !== false && expected[index] !== false &&
      (actual === undefined ? expected[index] === undefined :
        expected[index] !== undefined && actual.equals(Buffer.from(expected[index])));
  });
}

function acquireServingLock(home) {
  if (!OLD_HOME_NAME_PATTERN.test(path.basename(home)) || !isFile(path.join(home, MATERIALIZED_MARKER))) return undefined;
  const lock = path.join(home, `${SERVING_LOCK_PREFIX}${process.pid}-${randomUUID()}.lock`);
  fs.writeFileSync(lock, `${process.pid}\n0\n`, {flag: "wx"});
  return lock;
}

function setServingChildPid(lock, childPid) {
  if (lock !== undefined && Number.isSafeInteger(childPid) && childPid > 0) {
    fs.writeFileSync(lock, `${process.pid}\n${childPid}\n`);
  }
}

/** An unreadable or malformed lock is a reason to retain the copy. */
function hasLiveServingLock(home) {
  for (const name of fs.readdirSync(home)) {
    if (!SERVING_LOCK_PATTERN.test(name)) continue;
    const file = path.join(home, name);
    if (!fs.lstatSync(file).isFile()) return true;
    const pids = fs.readFileSync(file, "utf8").trim().split("\n");
    // A one-PID lock was written by older extension versions.
    if (pids.length < 1 || pids.length > 2 ||
      !pids.every((value, index) => (index === 1 && value === "0") ||
        (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))))) return true;
    for (const value of pids) {
      if (value === "0") continue;
      try {
        process.kill(Number(value), 0);
        return true;
      } catch (error) {
        if (error.code !== "ESRCH") return true;
      }
    }
  }
  return false;
}

/** Save a restorable delta when the original file list exists. Homes made
 * before this list was introduced get a complete snapshot instead. */
function saveOldHome(home, globalStorageDir, seedId) {
  const parent = path.join(globalStorageDir, "osd-saved-edits");
  fs.mkdirSync(parent, {recursive: true});
  const staging = fs.mkdtempSync(path.join(parent, ".saving-"));
  try {
    let original;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(home, SEED_FILES_FILE), "utf8"));
      if (parsed.seedId !== seedId || typeof parsed.files !== "object" || parsed.files === null ||
        Object.entries(parsed.files).some(([rel, value]) => typeof value !== "string" ||
          path.isAbsolute(rel) || rel.split("/").some((part) => !part || part === ".." || part === "."))) {
        throw new Error("invalid seed file list");
      }
      original = parsed.files;
    } catch {
      original = undefined;
    }
    if (original === undefined) {
      linkOrCopyTree(home, path.join(staging, "snapshot"));
      fs.writeFileSync(path.join(staging, "README.txt"),
        "Complete snapshot of the old working copy. To restore it, copy snapshot/ back to its original osd-home directory.\n");
    } else {
      const now = seedFiles(home);
      const deleted = Object.keys(original).filter((rel) => !Object.hasOwn(now, rel));
      const changed = Object.keys(now).filter((rel) => now[rel] !== original[rel]);
      // The delta is easy to inspect or apply to another seed. Keep the
      // complete old tree too, so restoring does not depend on finding an
      // older VSIX after an extension update.
      linkOrCopyTree(home, path.join(staging, "snapshot"));
      if (deleted.length === 0 && changed.length === 0) {
        // A changed directory tree can differ from the seed without any
        // changed file (for example an added empty directory).
        fs.writeFileSync(path.join(staging, "README.txt"),
          "Complete snapshot of the old working copy. To restore it, copy snapshot/ back to its original osd-home directory.\n");
      } else {
        for (const rel of changed) {
          const dest = path.join(staging, "files", rel);
          fs.mkdirSync(path.dirname(dest), {recursive: true});
          linkOrCopyTree(path.join(home, rel), dest);
        }
        fs.writeFileSync(path.join(staging, "deleted.json"), JSON.stringify(deleted, null, 2) + "\n");
        fs.writeFileSync(path.join(staging, "README.txt"),
          `Edits from osd-home-${seedId}. Restore the exact old copy from snapshot/. To apply just the edits to a seed, overlay files/ and remove the paths in deleted.json.\n`);
      }
    }
    const date = new Date().toISOString().slice(0, 10);
    let dest = path.join(parent, `${seedId}-${date}`);
    for (let suffix = 2; fs.existsSync(dest); suffix++) dest = path.join(parent, `${seedId}-${date}-${suffix}`);
    fs.renameSync(staging, dest);
    return dest;
  } catch (error) {
    fs.rmSync(staging, {recursive: true, force: true});
    throw error;
  }
}

/** Runs once during extension activation, before this window starts a
 * launcher. Every candidate is independently checked and failures keep it. */
function cleanupOldHomes(globalStorageDir, currentSeedId, {onSaved, onQuarantined} = {}) {
  const result = {removed: [], saved: [], kept: []};
  if (!SEED_ID_PATTERN.test(currentSeedId) || !fs.existsSync(globalStorageDir)) return result;
  for (const name of fs.readdirSync(globalStorageDir)) {
    if (!HOME_NAME_PATTERN.test(name) || name === `osd-home-${currentSeedId}`) continue;
    const home = path.join(globalStorageDir, name);
    try {
      if (!fs.lstatSync(home).isDirectory() || hasLiveServingLock(home)) continue;
      const seedId = name.slice("osd-home-".length);
      if (fs.readFileSync(path.join(home, MATERIALIZED_MARKER), "utf8") !== `${seedId}\n` ||
        fs.readFileSync(path.join(home, SEED_ID_FILE), "utf8") !== `${seedId}\n`) continue;
      const contentId = seedContentId(home);
      if (hasLiveServingLock(home)) continue;
      // Rename in the same parent before copying or removing anything. A
      // writer opening the old path now gets ENOENT; locks created just before
      // the rename follow the tree and are caught by the checks below.
      const quarantine = path.join(globalStorageDir, `.osd-home-trash-${randomUUID()}`);
      fs.renameSync(home, quarantine);
      let retained = true;
      try {
        quarantineCheck: {
          onQuarantined?.(quarantine);
          if (hasLiveServingLock(quarantine) ||
            fs.readFileSync(path.join(quarantine, MATERIALIZED_MARKER), "utf8") !== `${seedId}\n` ||
            fs.readFileSync(path.join(quarantine, SEED_ID_FILE), "utf8") !== `${seedId}\n` ||
            seedContentId(quarantine) !== contentId) {
            result.kept.push({home, error: new Error("lock or content changed during quarantine")});
            break quarantineCheck;
          }
          const saved = contentId === seedId && matchesHomeMetadata(quarantine, seedId)
            ? undefined : saveOldHome(quarantine, globalStorageDir, seedId);
          if (hasLiveServingLock(quarantine)) {
            result.kept.push({home, error: new Error("lock appeared during save")});
            break quarantineCheck;
          }
          const expected = saved === undefined ? seedId : seedContentId(path.join(saved, "snapshot"));
          if (seedContentId(quarantine) !== expected ||
            !matchesHomeMetadata(quarantine, seedId, saved === undefined ? undefined : path.join(saved, "snapshot"))) {
            result.kept.push({home, error: new Error("content changed during save")});
            break quarantineCheck;
          }
          // Activation runs before our own server starts. Rename and serving
          // locks protect path-based writers; a foreign process with an already
          // open descriptor into this unlocked quarantine can still write now.
          fs.rmSync(quarantine, {recursive: true});
          retained = false;
          result.removed.push(home);
          if (saved !== undefined) {
            result.saved.push(saved);
            onSaved?.(saved);
          }
        }
      } finally {
        if (retained) {
          if (!fs.existsSync(home)) {
            try {
              fs.renameSync(quarantine, home);
            } catch (error) {
              result.kept.push({home: quarantine, error});
            }
          } else {
            result.kept.push({home: quarantine, error: new Error("old path occupied; retained quarantined home")});
          }
        }
      }
    } catch (error) {
      result.kept.push({home, error});
    }
  }
  return result;
}

/** A best-effort indication for the explicit removal command. Generated
 *  build files also count as changes; missing metadata is reported as edited. */
function materializedHomeInfo(home) {
  try {
    if (!fs.lstatSync(home).isDirectory()) return {verifiedUnedited: false};
    const marker = path.join(home, MATERIALIZED_MARKER);
    if (!fs.lstatSync(marker).isFile()) return {verifiedUnedited: false};
    const seedId = fs.readFileSync(marker, "utf8").trim();
    if (!SEED_ID_PATTERN.test(seedId)) return {verifiedUnedited: false};
    const seedIdFile = path.join(home, SEED_ID_FILE);
    if (!fs.lstatSync(seedIdFile).isFile() || fs.readFileSync(seedIdFile, "utf8").trim() !== seedId) {
      return {seedId, verifiedUnedited: false};
    }
    const directoryId = /^osd-home-([0-9a-f]{64})$/.exec(path.basename(home))?.[1];
    if (directoryId !== undefined && directoryId !== seedId) return {seedId, verifiedUnedited: false};
    return {seedId, verifiedUnedited: seedContentId(home) === seedId};
  } catch {
    return {verifiedUnedited: false};
  }
}

/** A seed-change notice includes every stale home's size, including older
 *  copies as well as the previous one. The caller supplies measured sizes. */
function keptHomeNotice(home, oldHomes) {
  const totalBytes = oldHomes.reduce((sum, oldHome) => sum + oldHome.size, 0);
  const totalSize = totalBytes < 1024 * 1024
    ? `${Math.ceil(totalBytes / 1024)} KiB` : `${(totalBytes / 1024 / 1024).toFixed(1)} MiB`;
  return `previous working copy kept at ${home}; total size of all old working copies: ${totalSize}`;
}

function announceKeptHome(home, globalStorageDir, currentHome, options) {
  const notice = keptHomeNotice(home, listOldHomeSizes(globalStorageDir, currentHome));
  (options.onNotice ?? ((line) => console.warn(line)))(notice);
}

/** Callers supply direct children of global storage; only recognized home
 *  directories that are neither current nor served can be selected. */
function selectOldHomes(entries, currentHome, servedHome, selectedPaths) {
  const protectedPaths = new Set([currentHome, servedHome].filter(Boolean).map((home) => path.resolve(home)));
  const selected = selectedPaths === undefined ? undefined : new Set(selectedPaths.map((home) => path.resolve(home)));
  return entries.filter(({path: home, isDirectory}) => isDirectory && OLD_HOME_NAME_PATTERN.test(path.basename(home)) &&
    !protectedPaths.has(path.resolve(home)) && (selected === undefined || selected.has(path.resolve(home))));
}

function homeSize(home) {
  let bytes = 0;
  for (const entry of fs.readdirSync(home, {withFileTypes: true})) {
    const child = path.join(home, entry.name);
    if (entry.isDirectory()) bytes += homeSize(child);
    else if (entry.isFile()) bytes += fs.lstatSync(child).size;
  }
  return bytes;
}

function listOldHomeSizes(globalStorageDir, currentHome, servedHome) {
  if (!fs.existsSync(globalStorageDir)) return [];
  const entries = fs.readdirSync(globalStorageDir).map((name) => {
    const home = path.join(globalStorageDir, name);
    return {path: home, isDirectory: fs.lstatSync(home).isDirectory()};
  });
  return selectOldHomes(entries, currentHome, servedHome).map(({path: home}) => ({
    path: home,
    size: homeSize(home),
  }));
}

function listOldHomes(globalStorageDir, currentHome, servedHome) {
  return listOldHomeSizes(globalStorageDir, currentHome, servedHome).map((home) => ({
    ...home,
    edited: !materializedHomeInfo(home.path).verifiedUnedited,
  }));
}

/** Materializes a packaged seed into its own keyed directory. All other
 *  working copies stay at their original paths, including older recoveries. */
function ensureMaterializedHome(seedDir, globalStorageDir, options = {}) {
  const seedId = fs.readFileSync(path.join(seedDir, SEED_ID_FILE), "utf8").trim();
  if (!SEED_ID_PATTERN.test(seedId)) {
    throw new Error(`Invalid packaged seed ID in ${path.join(seedDir, SEED_ID_FILE)}`);
  }
  const target = materializedHomeDir(globalStorageDir, seedId);
  fs.mkdirSync(globalStorageDir, {recursive: true});
  const existing = fs.existsSync(target);
  const marker = path.join(target, MATERIALIZED_MARKER);
  if (existing && (!isFile(marker) || fs.readFileSync(marker, "utf8").trim() !== seedId)) {
    throw new Error(`Materialized home at ${target} has no matching seed marker; inspect it before retrying`);
  }
  const archive = path.join(seedDir, "seed.tar.br");
  if (!existing && fs.existsSync(archive)) {
    // Publish only a complete home. Concurrent starts extract separately;
    // the first rename wins and the other reuses its verified result.
    return (async () => {
      const pending = fs.mkdtempSync(path.join(globalStorageDir, `.osd-home-extract-${seedId}-`));
      let reused = false;
      try {
        const compressed = fs.createReadStream(archive);
        const decompressed = createBrotliDecompress();
        compressed.on("error", (error) => decompressed.destroy(error));
        const modes = await unpackTar(compressed.pipe(decompressed), pending);
        fs.writeFileSync(path.join(pending, SEED_ID_FILE), `${seedId}\n`);
        if (seedContentId(pending, modes) !== seedId) throw new Error("Packaged seed content does not match its ID");
        fs.writeFileSync(path.join(pending, MATERIALIZED_MARKER), `${seedId}\n`);
        fs.writeFileSync(path.join(pending, SEED_FILES_FILE), JSON.stringify({seedId, files: seedFiles(pending)}) + "\n");
        try {
          fs.renameSync(pending, target);
        } catch (error) {
          if (!fs.existsSync(target) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
          if (!isFile(marker) || fs.readFileSync(marker, "utf8").trim() !== seedId) {
            throw new Error(`Materialized home at ${target} has no matching seed marker; inspect it before retrying`);
          }
          reused = true;
        }
      } finally {
        fs.rmSync(pending, {recursive: true, force: true});
      }
      return finishMaterializedHome(target, globalStorageDir, reused, options);
    })();
  }
  if (!existing) {
    linkOrCopyTree(seedDir, target);
    fs.writeFileSync(marker, `${seedId}\n`);
    fs.writeFileSync(path.join(target, SEED_FILES_FILE), JSON.stringify({seedId, files: seedFiles(seedDir)}) + "\n");
  }
  return finishMaterializedHome(target, globalStorageDir, existing, options);
}

function finishMaterializedHome(target, globalStorageDir, existing, options) {
  let previous = options.previousHome;
  if (previous && (path.dirname(path.resolve(previous)) !== path.resolve(globalStorageDir) ||
      !HOME_NAME_PATTERN.test(path.basename(previous)))) previous = undefined;
  if (previous === undefined && !existing) {
    const older = fs.readdirSync(globalStorageDir).filter((name) => HOME_NAME_PATTERN.test(name) && name !== path.basename(target))
      .map((name) => path.join(globalStorageDir, name)).filter((home) => fs.lstatSync(home).isDirectory())
      .sort((a, b) => fs.statSync(b).birthtimeMs - fs.statSync(a).birthtimeMs);
    previous = older[0];
  }
  if (previous && path.resolve(previous) !== path.resolve(target) && fs.existsSync(previous)) {
    announceKeptHome(previous, globalStorageDir, target, options);
  }
  return target;
}

// ---- the launcher itself --------------------------------------------------

/** One instance of the system, started and stopped by this object rather
 *  than by a terminal. States: "stopped" -> "building" -> "starting" ->
 *  "running", and back to "stopped" on stop() or on the child's own exit
 *  (a crash is not a state this pretends is still "running"). Emits "log"
 *  (a line of the build's or the server's own output), "state" (the new
 *  state) and "exit" ({code, signal}, only when a RUNNING server went away
 *  without this launcher asking it to: stop(), rebuild() and a start that
 *  gave up are not "exit", and a child that dies while starting is
 *  start()'s rejection instead). A stop() while "starting" makes start()
 *  resolve undefined, as a stop while "building" does; the state reads
 *  "stopped" once the child is gone, which is when stop() returns. */
class Launcher extends EventEmitter {
  // why this launcher asked one of its own children to go ("stop" or
  // "abandoned"), per child and only while it was alive: a child that had
  // already died on its own is never marked, so its crash still warns
  #asked = new WeakMap();
  // the last boot step the system named, so the log says each once
  #bootPhase = undefined;
  // the readiness poll of the start in flight, so stop() can end it
  #poll = undefined;
  // the inspector open in flight (openInspector): one at a time
  #opening = undefined;

  #ask(child, reason) {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      this.#asked.set(child, reason);
    }
  }

  constructor(options = {}) {
    super();
    if (typeof options.osdHome !== "string" || options.osdHome === "") {
      throw new Error("osdHome is required");
    }
    if (typeof options.storageDir !== "string" || options.storageDir === "") {
      throw new Error("storageDir is required");
    }
    this.osdHome = options.osdHome;
    this.storageDir = options.storageDir;
    this.workspaceFolders = options.workspaceFolders ?? [];
    this.portRange = options.portRange ?? PORT_RANGE;
    this.timeoutMs = options.timeoutMs ?? 180000;
    // `osd.database.system` (docs/vscode-extension.md, "Databases"):
    // `{kind, host, port, user, database, schema, password, fresh}`, the
    // shape `databaseEnv()` above reads. Connection details and a
    // password already resolved by the caller (settings.json plus
    // `context.secrets`) -- this module stays pure and never reads either
    // itself.
    this.database = options.database ?? {kind: "sqlite"};
    this.databaseLabel = describeDatabase(this.database);
    this.jobsWorkerMode = options.jobsWorker ?? "auto";
    // "auto" | "on" | "off" (osd.warm, resolved by shouldWarm() below into
    // OSD_WARM); a test hands in "off" to keep the plain end-to-end run cold.
    this.warmMode = options.warm ?? "auto";
    this.debug = options.debug === true;
    this.state = "stopped";
    this.child = undefined;
    this.buildChild = undefined;
    this.buildCancelled = false;
    this.port = undefined;
    this.pid = undefined;
    this.generation = undefined;
    this.layers = [];
    this.lastLog = "";
    this.lastAttemptedPort = undefined;
    // when this start() began -- the status bar's "warming up..." (T7)
    // shows that while the compiler process primes; the front keeps
    // answering requests throughout (docs/warm-compile.md)
    this.startedAt = undefined;
    this.inspectPort = undefined;
    this.servingLock = undefined;
  }

  ownsServing(serving) {
    return this.state === "running" && Number.isInteger(this.pid)
      && typeof this.launcherIdentity === "string"
      && serving?.launcherPid === this.pid && serving.launcherIdentity === this.launcherIdentity;
  }

  async refreshJobsGeneration(serving) {
    if (this.state !== "running" || this.jobsStopping || serving?.ready !== true
        || serving.generation === undefined || serving.generation === this.generation) return;
    this.generation = serving.generation;
    const worker = this.jobWorker;
    if (!worker) return;
    // One refresh drains the active job. Further generations observed while
    // draining are loaded by the same replacement, rather than queued swaps.
    if (!this.jobsRefresh) {
      this.jobsRefresh = (async () => {
        await worker.stop({refresh:true});
        if (this.state === "running" && !this.jobsStopping && this.jobWorker === worker) worker.start();
      })().finally(() => { this.jobsRefresh = undefined; });
    }
    await this.jobsRefresh;
  }

  #setState(state) {
    if (state === "stopped") clearInterval(this.jobsPoll);
    if (state === "stopped" && this.servingLock !== undefined) {
      try { fs.rmSync(this.servingLock); } catch { /* A leftover lock conservatively keeps the home. */ }
      this.servingLock = undefined;
    }
    if (state === "stopped") {
      this.port = undefined;
      this.pid = undefined;
      this.generation = undefined;
      this.adtCredentials = undefined;
      this.launcherIdentity = undefined;
      if (this.env) delete this.env.OSD_LAUNCHER_IDENTITY;
      if (this.env) delete this.env.OSD_ADT_TOKEN;
    }
    this.state = state;
    this.emit("state", state);
  }

  #log(line) {
    this.lastLog = (this.lastLog + line).slice(-12000);
    this.emit("log", line);
  }

  /** Builds (tools/osd-build.mjs), spawns `node test/run.mjs`, waits for it
   *  to serve, and returns `{port, pid, generation}`. Throws, and leaves the
   *  state back at "stopped", if the build fails or the server never comes
   *  up -- there is no half-started state a caller has to notice on their
   *  own. */
  async start({force = false, forceBuild = false, port: requestedPort} = {}) {
    if (this.state !== "stopped") {
      throw new Error(`cannot start: already ${this.state}`);
    }
    await this.jobWorker?.stop();
    this.buildCancelled = false;
    this.jobsStopping = false;
    this.lastLog = "";
    fs.mkdirSync(this.storageDir, {recursive: true});
    this.startedAt = Date.now();
    this.#setState("building");
    this.layers = detectWorkspaceLayers(this.workspaceFolders);
    let covered = new Set();
    try {
      const {packsOf} = await import(pathToFileURL(path.join(this.osdHome, "tools", "osd-packs.mjs")).href);
      covered = coveredLayers(packsOf, this.osdHome, process.env, this.layers);
    } catch {
      // a home without tools/osd-packs.mjs: project every layer, as before
    }
    for (const layer of covered) {
      this.#log(`workspace layer ${layer.folder} is already a pack of this system (packs/ or OSD_PACKS): it is not projected again\n`);
    }
    const packsDir = ensureWorkspacePacks(this.storageDir, this.layers.filter((layer) => !covered.has(layer)));
    for (const layer of this.layers) {
      this.#log(`workspace layer: ${layer.folder} (${path.relative(layer.folder, layer.srcDir) === "" ? "." : "src"})\n`);
    }

    const dbDir = path.join(this.storageDir, "db");
    const tlsDir = path.join(this.storageDir, "tls");
    fs.mkdirSync(dbDir, {recursive: true});
    fs.mkdirSync(tlsDir, {recursive: true});

    if (this.database.kind === "duckdb" && duckdbAvailable(this.osdHome) === false) {
      this.#setState("stopped");
      throw new Error("DuckDB needs the native module; not in this package");
    }

    let port;
    try {
      if (requestedPort === undefined) {
        port = await pickPort(this.portRange);
      } else {
        port = Number(requestedPort);
        if (!Number.isInteger(port) || port < this.portRange.from || port > this.portRange.to) {
          throw new Error(`port must be in ${this.portRange.from}-${this.portRange.to}`);
        }
        if (await isFree(port) === false) {
          const error = new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
          error.code = "EADDRINUSE";
          throw error;
        }
      }
      this.lastAttemptedPort = port;
    } catch (error) {
      this.#setState("stopped");
      error.logText ??= this.lastLog;
      throw error;
    }
    if (this.buildCancelled) {
      this.#setState("stopped");
      return undefined;
    }
    if (!this.debug) this.inspectPort = undefined;
    if (this.debug && (this.inspectPort === undefined || await isFree(this.inspectPort) === false)) {
      this.inspectPort = await pickInspectorPort();
    }
    // open from the start only when asked at start; otherwise it is opened
    // on demand (openInspector) and a new system begins without one
    this.inspectorOpen = this.debug;
    const dbEnv = databaseEnv(this.database);
    // RuntimePool gives every serving worker the same inspector port; a
    // debugger session can follow one child only.
    const env = debugSystemEnv({
      ...process.env,
      STG_PORT: String(port),
      ...dbEnv,
      // `sqlite` and `duckdb` keep their rows under this instance's own
      // storage, exactly like before -- a persisted file, not `:memory:`,
      // so a rebuild does not start from nothing. `postgres` and `hana`
      // have no file of their own; their location is the connection.
      ...(dbEnv.STG_DB === "file" ? {STG_DB_PATH: path.join(dbDir, "osd.sqlite")} : {}),
      ...(dbEnv.STG_DB === "duckdb" ? {STG_DB_PATH: path.join(dbDir, "osd.duckdb")} : {}),
      OSD_OPERATIONS_DB: path.join(this.storageDir, "operations", "osd-operations.sqlite"),
      // No cert ever lands in `storageDir`'s TLS folder (it starts empty and
      // this launcher never runs `osd:tls`), so pointing OSD_TLS_DIR at it
      // is what makes plain HTTP the default: there is nothing to find, and
      // the extra HTTPS listener (test/start.mjs) never opens. Without this
      // an osdHome that already has a shared `.local/tls` (the worktree
      // symlinks one in, docs/CLAUDE.md's own worktree note) would open one
      // more port outside 3531-3539 on every launch.
      OSD_TLS_DIR: tlsDir,
      STG_SERVE: "child",
      ...warmEnvironment(this.warmMode),
    }, this.debug, this.inspectPort);
    env.OSD_PACKS = [process.env.OSD_PACKS, packsDir]
      .filter((value) => value !== undefined && value !== "").join(path.delimiter);
    delete env.OSD_JOB_WORKER;
    if (workerEnabled(this.jobsWorkerMode, env)) env.OSD_JOB_WORKER = "extension";
    env.OSD_BATCH_READ_TOKEN = randomUUID().replaceAll("-", "");
    delete env.OSD_ADT_TOKEN; // Never pass an inherited credential to a build.
    this.env = env;
    this.databaseLabel = describeDatabase(this.database);
    try {
      this.servingLock = acquireServingLock(this.osdHome);
    } catch (error) {
      this.#setState("stopped");
      throw error;
    }

    let build;
    try {
      build = await runToCompletion(this.osdHome, "tools/osd-build.mjs", force || forceBuild ? ["--force"] : [], env,
        (line) => this.#log(line), (child) => { this.buildChild = child; });
    } catch (error) {
      this.buildChild = undefined;
      this.#setState("stopped");
      error.logText ??= this.lastLog;
      throw error;
    }
    this.buildChild = undefined;
    if (this.buildCancelled) {
      this.#setState("stopped");
      return undefined;
    }
    if (build.code !== 0) {
      this.#setState("stopped");
      const error = new Error(`build failed (exit ${build.code}): ${build.output.slice(-2000)}`);
      error.logText = build.output;
      throw error;
    }

    this.#setState("starting");
    if (this.buildCancelled) {
      this.#setState("stopped");
      return undefined;
    }
    let child;
    try {
      // If the host dies between spawn and recording the child's PID, this
      // malformed pending value makes another window keep the home.
      if (this.servingLock !== undefined) fs.writeFileSync(this.servingLock, `${process.pid}\npending\n`);
      this.launcherIdentity = randomUUID();
      env.OSD_LAUNCHER_IDENTITY = this.launcherIdentity;
      this.adtCredentials = startCredentials(env);
      env.OSD_ADT_TOKEN = this.adtCredentials.token;
      child = spawn(process.execPath, ["test/run.mjs"], {cwd: this.osdHome, env, detached: process.platform !== "win32"});
    } catch (error) {
      this.#setState("stopped");
      error.logText ??= this.lastLog;
      throw error;
    }
    this.child = child;
    this.pid = child.pid;
    try {
      setServingChildPid(this.servingLock, child.pid);
    } catch (error) {
      await terminate(child, {graceMs: STOP_GRACE_MS});
      this.child = undefined;
      this.pid = undefined;
      this.#setState("stopped");
      throw error;
    }
    // The last few KB of what the server printed, kept only so a caller
    // who never gets a "serving" answer at all still sees WHY -- test/setup.mjs's
    // own stale-schema refusal ("Use a fresh HANA_SCHEMA, or explicitly
    // recreate it with STG_DB_FRESH=1") is a thrown Error that reaches
    // stderr and then a process exit, never a "serving" answer, so without
    // this a person waiting on HANA or PostgreSQL just saw "never answered
    // ready" after the full timeout with no reason at all.
    let recentOutput = "";
    const capture = (d) => {
      const text = d.toString();
      recentOutput = (recentOutput + text).slice(-4000);
      this.#log(text);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let resolveExitedEarly;
    const exitedEarly = new Promise((resolve) => {
      resolveExitedEarly = resolve;
    });
    child.on("exit", (code, signal) => {
      // an exit this launcher asked for (stop(), rebuild(), a start that
      // gave up) is not news; only one nobody asked for is "exit"
      const asked = this.#asked.get(child);
      // only a running system that goes away unasked is "exit": one that dies
      // while starting is start()'s own error, one popup rather than two
      const unexpected = this.state === "running" && asked === undefined;
      this.child = undefined;
      this.port = undefined;
      this.pid = undefined;
      this.generation = undefined;
      void this.jobWorker?.stop();
      this.#setState("stopped");
      if (unexpected) {
        this.emit("exit", {code, signal});
      } else if (asked !== undefined) {
        this.#log(asked === "stop" ? "\n--- osd stopped ---\n" : "\n--- osd start abandoned ---\n");
      }
      resolveExitedEarly({code, signal, asked});
    });

    let serving;
    // each start logs its own steps, the first one too
    this.#bootPhase = undefined;
    const poll = new AbortController();
    this.#poll = poll;
    try {
      serving = await Promise.race([
        waitForServing(port, {launcherPid: child.pid, launcherIdentity: this.launcherIdentity, timeoutMs: this.timeoutMs, signal: poll.signal, onStarting: (answer) => {
          // the boot's step, once each, in the system's own log
          if (answer.phase !== undefined && answer.phase !== this.#bootPhase) {
            this.#bootPhase = answer.phase;
            this.#log(`--- starting: ${answer.phase} ---\n`);
          }
        }}),
        exitedEarly.then(({code, signal, asked}) => {
          // stopped while starting: a cancel, the way a stop while building is
          if (asked === "stop") return STOPPED_WHILE_STARTING;
          const error = new Error(`osd exited before it started serving (code ${code ?? "?"}, signal ${signal ?? "?"}): ${recentOutput.trim().slice(-1000)}`);
          error.logText = recentOutput;
          throw error;
        }),
      ]);
    } catch (error) {
      poll.abort();
      if (this.#asked.get(child) === "stop") {
        // stop() came first, ended the poll and is terminating the child
        // itself: its cancel, not an error, and no second signal from here
        await exitedEarly;
        return undefined;
      }
      this.#ask(child, "abandoned");
      await terminate(child, {graceMs: STOP_GRACE_MS});
      if (this.state !== "stopped") {
        this.#setState("stopped");
      }
      error.logText ??= this.lastLog;
      throw error;
    } finally {
      poll.abort();
      if (this.#poll === poll) this.#poll = undefined;
    }
    // a stop that came while starting wins over a ready answer the child
    // gave on its way out: it is going away, it is not "running"
    if (serving === STOPPED_WHILE_STARTING || this.#asked.get(child) === "stop") {
      return undefined;
    }
    this.port = port;
    this.generation = serving.generation;
    if (workerEnabled(this.jobsWorkerMode, env)) {
      this.jobWorker = new JobWorker({cwd:this.osdHome, env,
        log: line => this.emit("jobsLog", line)});
      this.jobWorker.start();
    } else if (this.jobsWorkerMode !== "off") {
      this.emit("jobsUnavailable", {database:env.STG_DB});
    }
    this.#setState("running");
    let checking = false;
    this.jobsPoll = setInterval(async () => {
      if (checking || this.jobsStopping || this.child !== child) return;
      checking = true;
      try {
        const current = await servingOnce(port, 2000);
        if (this.child === child && this.ownsServing(current)) await this.refreshJobsGeneration(current);
      } catch (error) { this.#log(`OSD jobs: ${error.message}\n`); }
      finally { checking = false; }
    }, 250);
    this.jobsPoll.unref();
    return {port: this.port, pid: this.pid, generation: this.generation, inspectPort: this.inspectPort};
  }

  /** The debugger on demand: opens the running system's inspector on this
   *  launcher's inspector port (picked now if it has none, or if another
   *  process took it), without a restart. Resolves the port. A system
   *  started with the inspector already open answers at once. */
  // One open at a time: a breakpoint and a start's own attach, or two
  // quick clicks, would otherwise each pick a port and move the child's
  // inspector between them, leaving the debugger on the one it left.
  async openInspector() {
    this.#opening ??= this.#openInspector().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  async #openInspector() {
    if (this.state !== "running" || this.port === undefined) {
      throw new Error("osd is not running: start it first (osd: Start)");
    }
    if (this.inspectorOpen === true && this.inspectPort !== undefined) return this.inspectPort;
    if (this.inspectPort === undefined || await isFree(this.inspectPort) === false) {
      this.inspectPort = await pickInspectorPort();
    }
    const answer = await inspectorOnce(this.port, {open: true, port: this.inspectPort});
    if (answer.pending === true || answer.recovering === true) {
      const deadline = Date.now() + 15000;
      for (;;) {
        if (this.state !== "running") throw new Error("osd stopped while opening the inspector");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("the requested inspector was not ready within 15000 ms");
        const serving = await servingOnce(this.port, Math.min(2000, remaining));
        if (serving?.ready === true && this.ownsServing(serving) && Date.now() < deadline) {
          const state = await inspectorOnce(this.port, undefined, Math.max(1, deadline - Date.now()));
          if (state.open === true && state.port === this.inspectPort && state.pending !== true && state.recovering !== true) break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      }
    } else if (answer.open !== true || answer.port !== this.inspectPort) {
      throw new Error("the inspector door did not confirm the requested endpoint");
    }
    if (this.state !== "running") throw new Error("osd stopped while opening the inspector");
    this.inspectorOpen = true;
    return this.inspectPort;
  }

  /** Closes what openInspector() opened. A system started with the
   *  inspector (osd.debug, OSD_INSPECT=1) keeps it: that was asked for. */
  async closeInspector() {
    if (this.debug === true || this.inspectorOpen !== true) return false;
    this.inspectorOpen = false;
    if (this.state !== "running" || this.port === undefined) return false;
    await inspectorOnce(this.port, {open: false});
    return true;
  }

  /** Stops both processes: the child this module spawned (`node
   *  test/run.mjs`) and, through it, the grandchild it supervises
   *  (`tools/osd-serve.mjs`) and the compiler: signal the dedicated process
   *  group on POSIX, taskkill /T /F on Windows. Runtime signal handlers
   *  quiesce connections; tree termination also reaches a CPU-bound compiler
   *  whose disconnect handler cannot run yet. */
  async stop() {
    this.jobsStopping = true;
    clearInterval(this.jobsPoll);
    await this.jobsRefresh;
    await this.jobWorker?.stop();
    if (this.state === "building") {
      this.buildCancelled = true;
      await terminate(this.buildChild);
      this.buildChild = undefined;
      this.#setState("stopped");
      return;
    }
    if (this.child === undefined) {
      this.#setState("stopped");
      return;
    }
    const child = this.child;
    if (this.#asked.get(child) === "abandoned") {
      // a start that gave up is already terminating this child: the start
      // failed before the stop, so it stays failed, and it gets no second
      // signal from here -- wait for it to go
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }
      return;
    }
    this.#ask(child, "stop");
    this.#poll?.abort();
    await terminate(child, {graceMs: STOP_GRACE_MS});
    // the "exit" handler above already reset the fields and the state
  }

  async rebuild(options = {}) {
    await this.stop();
    return this.start(options);
  }

  /** Fetch every pack source declared by this osdHome. The caller decides
   *  when to restart after the fetch succeeds. */
  async fetchPacks() {
    const result = await runToCompletion(this.osdHome, "tools/osd-fetch.mjs", [], {...process.env, OSD_ROOT: this.osdHome},
      (line) => this.#log(line));
    if (result.code !== 0) {
      const error = new Error(`fetch packs failed (exit ${result.code}): ${result.output.slice(-2000)}`);
      error.logText = result.output;
      throw error;
    }
    return result;
  }
}

// Small ustar/PAX archive for the packaged seed. No shell tar or npm module is
// needed on the machine running VS Code.

const BLOCK = 512;
function octal(header, offset, length, value) {
  const digits = value.toString(8);
  if (digits.length > length - 1) throw new Error("tar field overflow");
  header.write(digits.padStart(length - 1, "0") + "\0", offset, length, "ascii");
}
function header(name, size, mode, type) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  octal(h, 100, 8, mode & 0o7777);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);
  h.fill(32, 148, 156);
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  octal(h, 148, 8, h.reduce((sum, byte) => sum + byte, 0));
  return h;
}
function paxPath(name) {
  const value = `path=${name}\n`;
  let length = Buffer.byteLength(value) + 3;
  while (true) {
    const next = Buffer.byteLength(`${length} ${value}`);
    if (next === length) return Buffer.from(`${length} ${value}`);
    length = next;
  }
}
function pad(size) { return (BLOCK - size % BLOCK) % BLOCK; }

function writeTar(root, out) {
  const fd = fs.openSync(out, "w");
  const write = (buffer) => fs.writeSync(fd, buffer);
  const writeEntry = (rel, file) => {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`unsupported seed entry: ${rel}`);
    const name = stat.isDirectory() ? `${rel}/` : rel;
    if (Buffer.byteLength(name) > 100) {
      const data = paxPath(name);
      write(header("PaxHeader", data.length, 0o644, "x"));
      write(data);
      if (pad(data.length)) write(Buffer.alloc(pad(data.length)));
    }
    write(header(Buffer.byteLength(name) <= 100 ? name : "PaxFile", stat.isFile() ? stat.size : 0,
      stat.mode, stat.isDirectory() ? "5" : "0"));
    if (stat.isFile()) {
      const input = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let count;
        while ((count = fs.readSync(input, buffer)) > 0) write(buffer.subarray(0, count));
      } finally { fs.closeSync(input); }
      if (pad(stat.size)) write(Buffer.alloc(pad(stat.size)));
    }
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) writeEntry(`${rel}/${child}`, path.join(file, child));
  };
  try {
    for (const name of fs.readdirSync(root).sort()) writeEntry(name, path.join(root, name));
    write(Buffer.alloc(2 * BLOCK));
  } finally { fs.closeSync(fd); }
}

function field(h, start, length) { return h.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, ""); }
function number(h, start, length) {
  const raw = field(h, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new Error("invalid tar number");
  return raw ? parseInt(raw, 8) : 0;
}
function safeParts(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) throw new Error(`unsafe tar path: ${name}`);
  const parts = name.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error(`unsafe tar path: ${name}`);
  return parts;
}

/** Unpacks a tar stream into `dest` and resolves to the archive's own modes
 *  (relative "/"-path -> mode), which seedContentId takes on a file system
 *  that cannot keep POSIX permission bits. */
async function unpackTar(chunks, dest) {
  let pending = Buffer.alloc(0), entry, remaining = 0, padding = 0, pax, paxData = [];
  const modes = new Map();
  const consume = (buffer) => {
    while (buffer.length) {
      if (remaining) {
        const count = Math.min(remaining, buffer.length);
        const part = buffer.subarray(0, count);
        if (entry.type === "x") paxData.push(part);
        else fs.writeSync(entry.fd, part);
        buffer = buffer.subarray(count);
        remaining -= count;
        if (!remaining) {
          if (entry.fd !== undefined) fs.closeSync(entry.fd);
          if (entry.type === "x") {
            const data = Buffer.concat(paxData).toString("utf8");
            paxData = [];
            const match = /^\d+ path=([^\n]+)\n$/.exec(data);
            if (!match) throw new Error("unsupported PAX header");
            pax = match[1];
          }
        }
        continue;
      }
      if (padding) {
        const count = Math.min(padding, buffer.length);
        buffer = buffer.subarray(count);
        padding -= count;
        continue;
      }
      if (buffer.length < BLOCK) return buffer;
      const h = buffer.subarray(0, BLOCK);
      buffer = buffer.subarray(BLOCK);
      if (h.every((byte) => byte === 0)) return Buffer.alloc(0);
      const stored = number(h, 148, 8);
      const copy = Buffer.from(h); copy.fill(32, 148, 156);
      if (stored !== copy.reduce((sum, byte) => sum + byte, 0)) throw new Error("invalid tar checksum");
      const type = field(h, 156, 1) || "0";
      const size = number(h, 124, 12);
      const mode = number(h, 100, 8);
      const name = pax ?? [field(h, 345, 155), field(h, 0, 100)].filter(Boolean).join("/");
      if (type !== "x") pax = undefined;
      entry = {type};
      if (type === "0" || type === "5") {
        const parts = safeParts(name);
        const target = path.join(dest, ...parts);
        modes.set(parts.join("/"), mode);
        if (type === "5") { fs.mkdirSync(target, {recursive: true, mode}); fs.chmodSync(target, mode); }
        else {
          fs.mkdirSync(path.dirname(target), {recursive: true});
          entry.fd = fs.openSync(target, "wx", mode);
          fs.fchmodSync(entry.fd, mode);
        }
      } else if (type !== "x") throw new Error(`unsupported tar type: ${type}`);
      remaining = size;
      padding = pad(size);
      if (!remaining && entry.fd !== undefined) fs.closeSync(entry.fd);
    }
    return Buffer.alloc(0);
  };
  try {
    for await (const chunk of chunks) {
      pending = consume(Buffer.concat([pending, chunk]));
    }
    if (remaining || padding || pending.length) throw new Error("truncated tar archive");
  } finally {
    if (entry?.fd !== undefined && remaining) fs.closeSync(entry.fd);
  }
  return modes;
}


module.exports = {
  WARM_MEMORY_FLOOR_BYTES,
  writeTar,
  unpackTar,
  shouldWarm,
  warmEnvironment,
  PORT_RANGE,
  classify,
  isFree,
  pickPort,
  pickInspectorPort,
  debugSystemEnv,
  looksLikeAbapGitFolder,
  isOpenSteamgateCheckout,
  decideStartTarget,
  detectWorkspaceLayers,
  packNameOf,
  coveredLayers,
  ensureWorkspacePacks,
  layerContributions,
  waitForServing,
  servingOnce,
  inspectorOnce,
  terminate,
  Launcher,
  linkOrCopyTree,
  SEED_ID_FILE,
  seedContentId,
  writeSeedId,
  materializedHomeDir,
  ensureMaterializedHome,
  MATERIALIZED_MARKER,
  selectOldHomes,
  listOldHomes,
  keptHomeNotice,
  cleanupOldHomes,
  hasLiveServingLock,
  setServingChildPid,
  SERVING_LOCK_PREFIX,
  SEED_FILES_FILE,
  DATABASE_KINDS,
  defaultDedicatedName,
  databaseEnv,
  describeDatabase,
  duckdbAvailable,
};
