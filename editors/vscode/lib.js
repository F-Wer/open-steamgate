// The part of the extension that does not need VS Code: which ABAP object a
// file is, where an include of it lives, how to talk to a running osd, and
// what a unit run's answer means per method. Kept apart so a plain mocha
// test can hold it to the server's real shapes (test/vscode-extension.mjs).
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const {pathToFileURL, fileURLToPath} = require("node:url");
const {systemSourceMappings, installedSource} = require("./system-sources.js");
const {packNameOf} = require("./launcher.js");
const {customDescriptionGenerator, customPropertiesGenerator} = require("./abap-debug-view.js");

// Quick start's choices live here rather than in the command handler so a
// future preset can add a row without duplicating its settings in UI code.
const PRESETS = Object.freeze({
  defaults: Object.freeze({home: "auto", database: "sqlite", warm: "auto", keymap: "abap"}),
});

function presetSettings(name) {
  const preset = PRESETS[name];
  if (preset === undefined) throw new Error(`unknown osd preset: ${name}`);
  return {home: preset.home, database: preset.database, warm: preset.warm, keymap: preset.keymap};
}

/** The packaged extension normally runs its bundled copy. When the open-
 *  steamgate checkout itself is one of the open folders, DX2's rule is to
 *  make that checkout osd.home instead, so the extension edits the system
 *  the user is looking at. */
function isOpenSteamgateCheckout(manifest, markers = {}) {
  return manifest?.name === "open-steamgate" && markers.buildScript === true && markers.vscodeExtension === true;
}

function osdHomeChoice({configuredHome = "", workspaces = [], bundledHome, bundledAvailable = false, homeMode = "auto"} = {}) {
  if (String(configuredHome).trim() !== "") return {path: String(configuredHome).trim(), kind: "osd.home"};
  const checkout = workspaces.find((folder) => folder.isOpenSteamgate === true);
  if (homeMode === "open-steamgate") return checkout === undefined ? undefined : {path: checkout.path, kind: "osd.home"};
  if (homeMode === "bundled") return bundledAvailable === true && bundledHome ? {path: bundledHome, kind: "bundled copy"} : undefined;
  if (homeMode === "auto" && checkout !== undefined) return {path: checkout.path, kind: "osd.home"};
  if (bundledAvailable === true && bundledHome) return {path: bundledHome, kind: "bundled copy"};
  return workspaces.length === 1 ? {path: workspaces[0].path, kind: "osd.home"} : undefined;
}

/** Tree context values are also the menu selectors in package.json. */
function osdStateContext(state) {
  if (state === "stopped") return "osd-state-stopped";
  if (state === "running") return "osd-state-running";
  return "osd-state-building";
}

const SYSTEM_STATUS_SETS = Object.freeze({
  system: "SystemSet",
  processes: "ProcessSet",
  ports: "PortSet",
  services: "ServiceSet",
  packs: "PackSet",
  database: "DatabaseSet",
});

function odataV2Results(body) {
  return body?.d?.results ?? (body?.d === undefined ? [] : [body.d]);
}

function firstStatusValue(rows, name) {
  const row = (rows ?? []).find((one) => String(one.name ?? one.Name ?? "").toLowerCase() === name.toLowerCase());
  return row?.value ?? row?.Value;
}

/** One pure page model for the tree's status row and the overview webview.
 *  Values retain their source routes so the view explains what is measured
 *  and can be reused by service details without reaching into VS Code. */
function systemOverviewModel(input = {}) {
  const launcher = input.launcher ?? {};
  const serving = input.serving?.ready === true ? input.serving : undefined;
  const status = input.status ?? {};
  const databaseRows = status.database ?? [];
  const engine = serving?.databaseIdentity?.engine ?? firstStatusValue(databaseRows, "Engine") ?? "unknown";
  const storage = serving?.databaseIdentity?.storage ?? firstStatusValue(databaseRows, "Storage") ?? "unknown";
  const databasePath = storage === "file" && serving?.database && serving.database !== ":memory:"
    ? serving.database : undefined;
  const port = input.state === "running" ? launcher.port : undefined;
  const baseUrl = input.state === "running"
    ? input.baseUrl ?? (port === undefined ? undefined : `http://localhost:${port}`) : undefined;
  return {
    state: input.state ?? "stopped",
    running: input.state === "running",
    extensionVersion: input.extensionVersion,
    home: {kind: input.homeKind ?? "osd.home", path: input.homePath ?? launcher.osdHome},
    layers: (input.layers ?? launcher.layers ?? []).map((layer) => typeof layer === "string" ? layer : layer.folder),
    listener: {port, url: baseUrl, source: "launcher"},
    launchpadUrl: baseUrl === undefined ? undefined : `${baseUrl}/app/flp.html`,
    database: {engine, storage, path: databasePath, source: "/osd/serving"},
    warm: serving?.warm ?? {state: "unavailable"},
    keymap: input.keymap ?? "abap",
    status: {
      system: status.system ?? [],
      processes: status.processes ?? [],
      ports: status.ports ?? [],
      services: status.services ?? [],
      packs: status.packs ?? [],
      database: databaseRows,
    },
    sources: {
      serving: "/osd/serving",
      status: Object.fromEntries(Object.entries(SYSTEM_STATUS_SETS).map(([key, set]) =>
        [key, `/sap/opu/odata/sap/ZOSD_STATUS_SRV/${set}?$format=json`])),
      sysinfo: "/sap/bc/osd/sysinfo/",
      launcher: "VS Code extension launcher state",
    },
  };
}

// abapGit file names: `zcl_x.clas.abap`, `zcl_x.clas.testclasses.abap`,
// `zprog.prog.abap`; a namespace is `#ns#zcl_x`
const FILE = /^(.+?)\.(clas|prog)(?:\.(locals_def|locals_imp|macros|testclasses))?\.abap$/i;
const INCLUDE = {locals_def: "definitions", locals_imp: "implementations", macros: "macros", testclasses: "testclasses"};

/** Each workspace pack's compiled source folder in the extension's storage
 *  (`packSource`, what a source map names) and the folder it really is
 *  (`source`, what the editor has open). The transpiler names each source
 *  relative to build/by-input/<generation>/output (`relativeSource`). */
function packSourceMappings({root, storageDir, layers = []} = {}) {
  if (storageDir === undefined || root === undefined) return [];
  const mappings = [];
  for (const layer of layers) {
    const manifest = layer.manifest ? JSON.parse(fs.readFileSync(layer.manifest, "utf8")) : undefined;
    const folders = manifest ? [manifest.abap ?? (layer.srcDir === layer.folder ? "." : "src")].flat() : ["src"];
    for (const folder of folders) {
      const packSource = path.join(storageDir, "packs", packNameOf(layer.folder), folder);
      const source = manifest ? path.join(layer.folder, folder) : layer.srcDir;
      const generated = path.join(root, "build", "by-input", "generation", "output");
      mappings.push({packSource, source, relativeSource: path.relative(generated, packSource).replaceAll("\\", "/")});
    }
  }
  return mappings;
}

/** The Node attach configuration used by the extension and by
 *  docs/debugging-abap.md. `restart` lets vscode-js-debug reconnect when
 *  the supervised ABAP process recycles on the same inspector port. */
function debuggerConfiguration(port, {target = "system", restart = true, root, storageDir, layers = [], skipFiles = []} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid inspector port: ${port}`);
  }
  const normalizedRoot = typeof root === "string" && root !== "" ? root.replaceAll("\\", "/").replace(/\/+$/, "") : undefined;
  const buildRoot = normalizedRoot === undefined ? "${workspaceFolder}/build" : `${normalizedRoot}/build`;
  // Node loads modules through output/, but resolves that link to the immutable
  // by-input generation. outFiles predicts only the generation that is live
  // now, never the cached ones. Source maps, though, are allowed from the
  // whole build tree: the serving process can run code from a generation
  // other than the live one -- a build that went live before the recycle, a
  // warm swap (changed modules under build/hot/, the rest still in the
  // generation the process booted from) -- and js-debug never reads the map
  // of a script outside resolveSourceMapLocations, so a breakpoint there
  // looks bound and never stops (0.5.1467, osg-demo).
  let outputRoot = `${buildRoot}/live/output`;
  // Node reports scripts by real path. build/ itself may be a link, and so
  // may the generation store inside it (by-input/, hot/, shared with
  // another checkout): each is admitted by where it really is.
  let realBuildRoot = buildRoot;
  const realStores = [];
  if (root !== undefined) {
    try {
      realBuildRoot = fs.realpathSync(path.join(root, "build")).replaceAll("\\", "/");
    } catch {
      // No build yet: the literal path is the only one there is.
    }
    for (const store of ["by-input", "hot"]) {
      try {
        const real = fs.realpathSync(path.join(root, "build", store)).replaceAll("\\", "/");
        if (!real.startsWith(`${realBuildRoot}/`)) realStores.push(real);
      } catch {
        // not there yet
      }
    }
    try {
      outputRoot = fs.realpathSync(path.join(root, "build", "live", "output")).replaceAll("\\", "/");
    } catch {
      // Detached unit children can have output/ without a serving generation.
      try {
        outputRoot = fs.realpathSync(path.join(root, "output")).replaceAll("\\", "/");
      } catch {
        // An attach requested during a build still has one live alias.
      }
    }
  }
  const modulesRoot = normalizedRoot === undefined ? "${workspaceFolder}/node_modules" : `${normalizedRoot}/node_modules`;
  const sourceMapPathOverrides = {};
  for (const {packSource, source, relativeSource} of packSourceMappings({root: normalizedRoot === undefined ? undefined : root, storageDir, layers})) {
    // js-debug applies overrides to the map's own entry before resolving it to a file URL.
    const target = `${source.replaceAll("\\", "/").replace(/\/+$/, "")}/*`;
    sourceMapPathOverrides[`${relativeSource}/*`] = target;
    sourceMapPathOverrides[`${pathToFileURL(packSource).href}/*`] = target;
  }
  for (const {logical, source} of systemSourceMappings(root) ?? []) {
    const target = `${source.replaceAll("\\", "/")}/*`;
    for (const output of [path.join(root, "output"), path.join(root, "build/by-input/generation/output"), outputRoot]) {
      const relative = path.relative(output, logical).replaceAll("\\", "/");
      sourceMapPathOverrides[`${relative}/*`] = target;
    }
    sourceMapPathOverrides[`${pathToFileURL(logical).href}/*`] = target;
    sourceMapPathOverrides[`${logical.replaceAll("\\", "/")}/*`] = target;
  }
  return {
    name: `OSD: ${target === "unit" ? "ABAP Unit" : "ABAP"} (${port})`,
    type: "node",
    request: "attach",
    address: "127.0.0.1",
    port,
    restart,
    ...(target === "unit" ? {continueOnAttach: true} : {}),
    timeout: 30000,
    resolveSourceMapLocations: [...new Set([`${buildRoot}/**`, `${realBuildRoot}/**`, ...realStores.map((store) => `${store}/**`)])]
      .concat("!**/node_modules/**"),
    skipFiles: [...new Set([...skipFiles, "<node_internals>/**", `${modulesRoot}/@abaplint/runtime/**`])],
    outFiles: [`${outputRoot}/**/*.mjs`],
    pauseForSourceMap: true,
    ...(Object.keys(sourceMapPathOverrides).length ? {sourceMapPathOverrides} : {}),
    customDescriptionGenerator,
    customPropertiesGenerator,
  };
}

/** The `.abap` files the running generation was compiled from, read off its
 *  own source maps (`<root>/output/*.mjs.map`), with a workspace pack's
 *  storage copy mapped back to the folder the editor has open. This is the
 *  set a breakpoint can bind in: js-debug binds a breakpoint by the path a
 *  loaded source map names, so a breakpoint in any other copy of the same
 *  file stays unbound (docs/debugging-abap.md, "Which copy"). Returns
 *  undefined when there is no generation to read. */
function runningAbapSources(root, {storageDir, layers = []} = {}) {
  let output;
  try {
    output = fs.realpathSync(path.join(root, "output"));
  } catch {
    return undefined;
  }
  const mappings = packSourceMappings({root, storageDir, layers});
  const systemMappings = systemSourceMappings(root);
  const files = new Map();
  for (const name of fs.readdirSync(output).sort()) {
    if (!name.endsWith(".mjs.map")) continue;
    let map;
    try {
      map = JSON.parse(fs.readFileSync(path.join(output, name), "utf8"));
    } catch {
      continue;
    }
    for (const entry of map.sources ?? []) {
      if (typeof entry !== "string" || !/\.abap$/i.test(entry)) continue;
      let file = entry.startsWith("file:") ? fileURLToPath(entry) : path.resolve(output, map.sourceRoot ?? "", entry);
      const pack = mappings.find((m) => isInside(file, m.packSource) || isInside(file, realOrSelf(m.packSource)));
      if (pack !== undefined) {
        const base = isInside(file, pack.packSource) ? pack.packSource : realOrSelf(pack.packSource);
        file = path.join(pack.source, path.relative(base, file));
      }
      file = installedSource(root, file, systemMappings);
      if (file === undefined) continue;
      // a library's map names a bare file name, which resolves inside
      // output/ to nothing; a stale gen/ entry names a file since removed.
      // Neither is a copy a breakpoint could be moved to.
      if (!fs.existsSync(file)) continue;
      files.set(sourceKey(realOrSelf(file)), file);
    }
  }
  return {generation: output, files};
}

function realOrSelf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sourceKey(file, platform = process.platform) {
  return platform === "win32" || platform === "darwin" ? file.toLowerCase() : file;
}

/** Why a breakpoint in `file` will not be hit by the running system, or
 *  undefined when it can be. `running` is runningAbapSources()'s result.
 *  `counterpart` is the running system's copy of the same file name, when
 *  there is exactly one. */
function breakpointWarning(file, running, {home} = {}) {
  if (running === undefined || !/\.abap$/i.test(file)) return undefined;
  if (running.files.has(sourceKey(realOrSelf(file)))) return undefined;
  const base = path.basename(file).toLowerCase();
  const same = [...running.files.values()].filter((candidate) => path.basename(candidate).toLowerCase() === base);
  const where = home === undefined ? "the running system" : `the running system (${home})`;
  if (same.length === 1) {
    return {file, counterpart: same[0],
      message: `This breakpoint will not be hit: ${where} runs ${same[0]}, not this copy of ${path.basename(file)}.`};
  }
  return {file, counterpart: undefined,
    message: `This breakpoint will not be hit: no code of ${where} maps back to ${path.basename(file)}.`};
}

/** Pure attach lifecycle policy. A supervised runtime restart keeps the
 *  same inspector port, so the existing restart-enabled debug session owns
 *  reconnection; stopping the extension-launched system ends that session.
 *  Detached unit children get their own one-shot attach session. */
function debugAttachPlan(state = {}, event = {}) {
  const current = state.systemPort;
  if (event.type === "system-attached" && Number.isInteger(event.port)) {
    return {state: {systemPort: event.port}, actions: []};
  }
  if (event.type === "system-session-ended") {
    return {state: current === event.port ? {systemPort: undefined} : state, actions: []};
  }
  if (event.type === "system-started") {
    if (event.enabled !== true || !Number.isInteger(event.port) || event.port < 1 || event.port > 65535) {
      return {state: {systemPort: undefined}, actions: current === undefined ? [] : [{type: "stop", target: "system", port: current}]};
    }
    if (current === event.port) return {state, actions: []};
    return {
      state,
      actions: [
        ...(current === undefined ? [] : [{type: "stop", target: "system", port: current}]),
        {type: "attach", target: "system", port: event.port, restart: true},
      ],
    };
  }
  // stopped, or detached on purpose (the debugger on demand, released once
  // no .abap breakpoint wants it): the session goes either way
  if (event.type === "system-stopped" || event.type === "system-detach") {
    return {state: {systemPort: undefined}, actions: current === undefined ? [] : [{type: "stop", target: "system", port: current}]};
  }
  if (event.type === "unit-started" && Number.isInteger(event.port) && event.port >= 1 && event.port <= 65535) {
    return {state, actions: [{type: "attach", target: "unit", port: event.port, restart: false}]};
  }
  return {state, actions: []};
}

// ---- the Test Explorer's queue by RISK LEVEL (docs/vscode-extension.md,
// "Running tests") --------------------------------------------------------
//
// An ABAP Unit class declares `RISK LEVEL HARMLESS | DANGEROUS | CRITICAL`
// and `DURATION SHORT | MEDIUM | LONG`. The façade checks the declaration
// (tools/osd-unit-risk.mjs) and says what each class is scheduled as; a
// unit here is one object's selections, run in the order they were asked,
// and its risk is the riskiest class it runs. HARMLESS units run
// `poolSize` at a time, longest first; every other unit runs after them,
// one at a time, also longest first.

const DURATION_RANK = {long: 3, medium: 2, short: 1};

/** The risk of one object's run: HARMLESS only when every class it runs is
 *  scheduled HARMLESS; a class nobody could tell us about is DANGEROUS. */
function unitRiskOf(schedules) {
  if (schedules.length === 0 || schedules.some((s) => s?.schedule !== "harmless")) return "dangerous";
  return "harmless";
}

/** The longest DURATION among a unit's classes, `short` when none say. */
function unitDurationOf(schedules) {
  return schedules.map((s) => s?.duration).filter((d) => DURATION_RANK[d] !== undefined)
    .sort((a, b) => DURATION_RANK[b] - DURATION_RANK[a])[0] ?? "short";
}

/** The two queues: HARMLESS (parallel) and the rest (serial), each longest
 *  first and otherwise in the order asked. */
function unitSchedule(units) {
  const byDuration = (a, b) => (DURATION_RANK[b.duration] ?? 1) - (DURATION_RANK[a.duration] ?? 1);
  return {
    parallel: units.filter((u) => u.risk === "harmless").sort(byDuration),
    serial: units.filter((u) => u.risk !== "harmless").sort(byDuration),
  };
}

/** Runs the units: the HARMLESS queue `poolSize` at a time, then the rest
 *  one at a time. `unit.run()` reports its own results and does not throw;
 *  `cancelled()` is asked before each unit starts. */
async function runUnitQueue(units, {poolSize = 1, cancelled = () => false} = {}) {
  const {parallel, serial} = unitSchedule(units);
  let next = 0;
  const worker = async () => {
    while (next < parallel.length && !cancelled()) {
      const unit = parallel[next++];
      await unit.run();
    }
  };
  await Promise.all(Array.from({length: Math.max(1, Math.min(poolSize, parallel.length))}, worker));
  for (const unit of serial) {
    if (cancelled()) break;
    await unit.run();
  }
}

/** The warning on a class that declares RISK LEVEL HARMLESS and whose
 *  object's tests reach a write (the façade's `writes`), or undefined. */
function riskWarning(testClass, found = {}) {
  if (testClass?.riskLevelDeclared !== true || testClass.riskLevel !== "harmless" || testClass.schedule === "harmless") return undefined;
  const first = found.writes?.[0];
  if (first === undefined) {
    if (found.riskError !== undefined)
      return `RISK LEVEL HARMLESS, but the tests may reach a database write: call analysis could not complete (${found.riskError}). It runs one at a time while the target is unknown.`;
    const dynamic = found.dynamicCalls?.[0];
    if (dynamic === undefined) return undefined;
    const reason = dynamic.kind?.startsWith("an unknown ") || /^a dynamic ASSIGN\b/.test(dynamic.kind ?? "") ? dynamic.kind
      : dynamic.kind?.includes("dynamic") ? "a dynamic call" : "an unresolved call";
    return `RISK LEVEL HARMLESS, but the tests may reach a database write through ${reason} in ${dynamic.method ?? dynamic.object} (${dynamic.file}:${dynamic.line}). It runs one at a time while the target is unknown.`;
  }
  const more = (found.writesTotal ?? found.writes.length) - 1;
  const path = first.path?.slice(0, -1) ?? [];
  // At most five call hops; an ellipsis explicitly marks omitted middle edges.
  const shown = path.length > 6 ? [...path.slice(0, 2), null, ...path.slice(-2)] : path;
  const route = shown.map((hop) => hop === null ? "…" : `${hop.target ?? hop.method ?? hop.object} (${hop.file}:${hop.line})`).join(" → ");
  return `RISK LEVEL HARMLESS, but the tests of ${found.object?.name ?? "this object"} reach a database write: `
    + `${route ? `${route} → ` : ""}${first.kind} in ${first.object} (${first.file}:${first.line})${more > 0 ? ` and ${more} more` : ""}. `
    + "It runs one at a time, as DANGEROUS; declare RISK LEVEL DANGEROUS to say so.";
}

/** How many HARMLESS runs at once: one child process each, which boots its
 *  own runtime and database. Measured on this tree (docs/vscode-extension.md,
 *  "Running tests"); bounded by the machine. */
function unitPoolSize(cpus = require("node:os").cpus().length) {
  return Math.max(1, Math.min(4, cpus - 1));
}

/** Start the paused child request while VS Code attaches. A rejected attach
 * or a cancelled Test Explorer run aborts the HTTP request, which tells the
 * façade to kill that child. */
async function runWithDebuggerAttach(attach, execute, token) {
  const cancellation = new AbortController();
  const subscription = token?.onCancellationRequested(() => cancellation.abort());
  if (token?.isCancellationRequested) cancellation.abort();
  const attached = Promise.resolve().then(attach).then((started) => {
    if (started !== true) throw new Error("VS Code could not attach to the ABAP Unit child");
  }).catch((error) => {
    cancellation.abort();
    throw error;
  });
  const response = Promise.resolve().then(() => execute(cancellation.signal));
  try {
    const [, result] = await Promise.all([attached, response]);
    return result;
  } finally {
    subscription?.dispose();
  }
}

/** VS Code does not expose its global activation bit to extensions. A label
 *  without a local shadow bit stays true when the built-in command is used. */
function breakpointToggleText() {
  return "$(debug) Toggle ABAP breakpoints";
}
const SUFFIX = Object.fromEntries(Object.entries(INCLUDE).map(([suffix, include]) => [include, suffix]));

// Same shape as FILE, plus interfaces: an interface has no ABAP Unit to run,
// so objectOf (above) deliberately does not know it, but Check and Activate
// (ADT's Ctrl+F2 / Ctrl+F3) apply to it too.
const ADT_FILE = /^(.+?)\.(clas|prog|intf)(?:\.(locals_def|locals_imp|macros|testclasses))?\.abap$/i;

// The ADT collection a type is served under (tools/osd-store.mjs TYPES,
// the `adt` column); only the three source types Ctrl+F2/Ctrl+F3 reach.
const ADT_COLLECTION = {CLAS: "oo/classes", INTF: "oo/interfaces", PROG: "programs/programs"};

/** `{type, name, base, include}` for a file that can carry ABAP Unit, else undefined. */
function objectOf(file) {
  const m = FILE.exec(path.basename(file));
  if (m === null) return undefined;
  return {
    type: m[2].toUpperCase(),
    name: m[1].replaceAll("#", "/").toUpperCase(),
    base: m[1].toLowerCase(),
    include: m[3] === undefined ? "main" : INCLUDE[m[3].toLowerCase()],
  };
}

/** Whether a breakpoint's file and the file a command acts on are the same
 *  ABAP source, and why: the same path, the same file through a link (a
 *  workspace opened through a symlink, a pack projection), or the same object
 *  and include in another folder (the breakpoint's URI and the editor's or
 *  the store's path need not be spelled alike). Returns the reason, or
 *  undefined when they differ. */
function sameAbapSource(a, b, realpath = fs.realpathSync) {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return undefined;
  if (path.resolve(a) === path.resolve(b)) return "path";
  const real = (file) => { try { return realpath(file); } catch { return undefined; } };
  const ra = real(a);
  if (ra !== undefined && ra === real(b)) return "realpath";
  const oa = adtObjectOf(a);
  const ob = adtObjectOf(b);
  if (oa && ob && oa.type === ob.type && oa.name === ob.name && oa.include === ob.include) return "object";
  return undefined;
}

/** Which of the breakpoint `files` are in the source a command acts on
 *  (`target`), each with `{file, why, counts}`. A match by path or real path
 *  counts. A match by object alone counts only when the breakpoint's file is
 *  the copy the running generation was compiled from (`running`, from
 *  runningAbapSources()). A shadowed copy of the same object, such as a
 *  packs/ copy, a worktree, .local/lars or output/, never binds, so it must
 *  neither make a call look covered nor hold a wait for 15 s. Files that do
 *  not match at all are left out. */
function breakpointMatches(files, target, running) {
  const matches = [];
  for (const file of files) {
    const why = sameAbapSource(file, target);
    if (why === undefined) continue;
    if (why !== "object") {
      matches.push({file, why, counts: true});
      continue;
    }
    const isRunning = running?.files?.has(sourceKey(realOrSelf(file))) === true;
    matches.push({file, why: isRunning ? "object, the running copy" : "object, not the running copy",
      counts: isRunning});
  }
  return matches;
}

/** `{type, name, base, include}` for a file Check or Activate can reach
 *  (a class, its includes, an interface, a program), else undefined. */
function adtObjectOf(file) {
  const m = ADT_FILE.exec(path.basename(file));
  if (m === null) return undefined;
  return {
    type: m[2].toUpperCase(),
    name: m[1].replaceAll("#", "/").toUpperCase(),
    base: m[1].toLowerCase(),
    include: m[3] === undefined ? "main" : INCLUDE[m[3].toLowerCase()],
  };
}

/** The object's own ADT URI (`/sap/bc/adt/...`), the one a checkObject or an
 *  objectReference names -- never an include's own path, which the façade's
 *  object lookup (adt-documents.mjs objectFromUri) does not parse. */
function uriOf(object) {
  const collection = ADT_COLLECTION[object.type];
  if (collection === undefined) throw new Error(`no ADT collection known for ${object.type}`);
  return `/sap/bc/adt/${collection}/${object.base}`;
}

/** The file of one include of an object, next to a file of the same object. */
function fileOf(dir, object, include) {
  const type = object.type.toLowerCase();
  const suffix = include === undefined || include === "main" ? "" : `.${SUFFIX[include] ?? include}`;
  return path.join(dir, `${object.base}.${type}${suffix}.abap`);
}

/** A client of one osd listener. The ADT façade wants a CSRF token and the
 *  session cookie it came with for anything that is not a read. */
class Osd {
  constructor(url, fetchImpl = globalThis.fetch) {
    this.url = String(url).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.token = undefined;
    this.cookie = undefined;
  }

  async #csrf(signal) {
    const res = await this.fetch(`${this.url}/sap/bc/adt/core/discovery`, {method: "HEAD", headers: {"x-csrf-token": "fetch"}, signal});
    if (res.status !== 200) throw new Error(`osd at ${this.url}: CSRF fetch answered ${res.status}`);
    this.token = res.headers.get("x-csrf-token") ?? undefined;
    const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    this.cookie = cookies.map((c) => c.split(";")[0]).join("; ") || undefined;
  }

  async request(route, options = {}) {
    const write = options.method !== undefined && options.method !== "GET" && options.method !== "HEAD";
    for (let attempt = 0; ; attempt++) {
      if (write && this.token === undefined) await this.#csrf(options.signal);
      const headers = {...(options.headers ?? {})};
      if (write) {
        headers["x-csrf-token"] = this.token;
        if (this.cookie) headers.cookie = this.cookie;
      }
      const res = await this.fetch(this.url + route, {...options, headers});
      // a restarted listener forgets the token: fetch a new one once
      if (write && res.status === 403 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        let detail;
        try {
          detail = JSON.parse(text)?.error?.message;
        } catch {
          // Most ADT refusals are XML; keep their own words below.
        }
        detail = String(detail ?? text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        throw new Error(`${options.method ?? "GET"} ${route}: HTTP ${res.status}${detail ? ` -- ${detail.slice(0, 300)}` : ""}`);
      }
      return res;
    }
  }

  async json(route, options) {
    return (await this.request(route, options)).json();
  }

  serving() {
    return this.json("/osd/serving");
  }

  /** The status app's existing read-only OData sets, used by the shared
   *  System overview page. The sysinfo app has no JSON representation, so
   *  the page embeds `/sap/bc/osd/sysinfo/` separately. */
  async systemStatus() {
    const entries = await Promise.all(Object.entries(SYSTEM_STATUS_SETS).map(async ([key, set]) => {
      const body = await this.json(`/sap/opu/odata/sap/ZOSD_STATUS_SRV/${set}?$format=json`);
      return [key, odataV2Results(body)];
    }));
    return Object.fromEntries(entries);
  }

  dumps() {
    return this.json("/osd/dumps");
  }

  /** Cheap read of the activated include, bounded so F9 stays responsive. */
  async activeSource(object, include = object.include ?? "main") {
    const suffix = include === "main" ? "/source/main" : `/includes/${encodeURIComponent(include)}/source/main`;
    return (await this.request(`${uriOf(object)}${suffix}?version=active`,
      {headers: {accept: "text/plain"}, signal: AbortSignal.timeout(750)})).text();
  }

  /** Test classes and methods of an object, without running anything. */
  discover(object) {
    return this.json(`/sap/bc/adt/core/http/unit/object?type=${encodeURIComponent(object.type)}&name=${encodeURIComponent(object.name)}`);
  }

  /** Which service and entity sets a SEGW _DPC_EXT class's own
   *  `<set>_get_entityset` / `<set>_get_entity` methods answer for
   *  (tools/adt-facade.mjs `core/http/segw/entitysets`). `undefined` on a
   *  404 (the class is not a registered service's DPC), an error on
   *  anything else -- the same distinction `run()`/`discover()` leave to
   *  their caller, made here because a CodeLensProvider asks this for
   *  every `.abap` file VS Code opens and "not a DPC_EXT" is not a fault. */
  async entitySets(className) {
    try {
      return await this.json(`/sap/bc/adt/core/http/segw/entitysets?class=${encodeURIComponent(className)}`);
    } catch (e) {
      if (/HTTP 404/.test(String(e.message ?? e))) return undefined;
      throw e;
    }
  }

  /** Q3 "Readers" (docs/vscode-extension.md): who references a CLAS or INTF
   *  (tools/adt-facade.mjs `core/http/xref/readers`): `{name, readers:
   *  [{type, name, include, isTest, services}], counts: {readers, tests,
   *  services}}`. `undefined` on a 404 (not a CLAS/INTF this store knows),
   *  an error on anything else -- the same shape `entitySets` above answers,
   *  for the same reason: a CodeLensProvider asks this for every
   *  class/interface file VS Code opens. */
  async readers(type, name) {
    try {
      return await this.json(`/sap/bc/adt/core/http/xref/readers?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
    } catch (e) {
      if (/HTTP 404/.test(String(e.message ?? e))) return undefined;
      throw e;
    }
  }

  /** The full transitive xref closure used by a service's details and its
   *  "Test" action. Returns undefined when this class is not in the store. */
  async closure(type, name) {
    try {
      return await this.json(`/sap/bc/adt/core/http/xref/closure?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
    } catch (e) {
      if (/HTTP 404/.test(String(e.message ?? e))) return undefined;
      throw e;
    }
  }

  /** Q2b "Runner": GET an OData v2 resource of a service this osd serves --
   *  `service` and `resource` joined as `/sap/opu/odata/sap/<service>/
   *  <resource>` -- timed and never throwing on a non-2xx answer, so a
   *  webview can show the status and the body's own error message instead
   *  of an exception: `{status, ms, url, body}`, `body` parsed from JSON
   *  when the answer is JSON, else `undefined` (the raw text stays in
   *  `text`). */
  async odata(service, resource) {
    const url = `/sap/opu/odata/sap/${service}/${resource}`;
    const startedAt = Date.now();
    const res = await this.fetch(this.url + url, {headers: {accept: "application/json"}});
    const ms = Date.now() - startedAt;
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return {status: res.status, ms, url, text, body};
  }

  /** A POST function import of an OData service, with the CSRF token that
   *  service hands out (the gateway's, not the ADT facade's). Answers the
   *  function's value, the one field under "d"; an OData error is thrown
   *  with its own message. */
  async odataAction(service, name, parameters = {}) {
    const root = `${this.url}/sap/opu/odata/sap/${service}/`;
    const head = await this.fetch(root, {headers: {"x-csrf-token": "fetch"}});
    if (!head.ok) throw new Error(`GET ${service}/: HTTP ${head.status} -- no CSRF token`);
    const cookies = typeof head.headers.getSetCookie === "function" ? head.headers.getSetCookie() : [];
    const query = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)])).toString();
    const res = await this.fetch(`${root}${name}${query ? `?${query}` : ""}`, {method: "POST", headers: {
      accept: "application/json",
      "x-csrf-token": head.headers.get("x-csrf-token") ?? "",
      ...(cookies.length > 0 ? {cookie: cookies.map((c) => c.split(";")[0]).join("; ")} : {}),
    }});
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const said = body?.error?.message?.value ?? text.replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(`POST ${service}/${name}: HTTP ${res.status}${said ? ` -- ${said}` : ""}`);
    }
    return body?.d?.[name];
  }

  /** Q6a "Notebook SQL" (docs/vscode-extension.md): run one SQL statement
   *  through the ADT façade's data preview (tools/adt-facade.mjs
   *  `datapreview/freestyle`, ~2358-2392): POST the statement as the
   *  body, `rowNumber` the row limit. The answer is XML, column-oriented
   *  (`tableDataDocument`, ~257-303) -- `freestyleRows` below turns it into
   *  `{columns, rows}`. Timed like `odata()` above; the generation the
   *  answer carries (`X-OSD-Generation`, set on every façade answer, see
   *  `router.use` near the top of `adtRouter`) rides along for the cell's
   *  own status line. Goes through `request()`, so a refused statement (not
   *  a SELECT, or a database never built) throws with the server's own
   *  `exceptionDocument` message, the same as `check()` / `activate()`
   *  above -- a notebook cell's error output is that message, unwrapped. */
  async freestyle(statement, rowLimit) {
    const startedAt = Date.now();
    const res = await this.request(`/sap/bc/adt/datapreview/freestyle?rowNumber=${encodeURIComponent(rowLimit)}`, {
      method: "POST",
      headers: {"content-type": "text/plain; charset=utf-8"},
      body: statement,
    });
    const ms = Date.now() - startedAt;
    const xml = await res.text();
    const generation = res.headers.get("x-osd-generation") ?? undefined;
    return {...freestyleRows(xml), ms, generation};
  }

  /** Q7 "F8 on a table or a CDS view" (docs/vscode-extension.md): the
   *  façade's own datapreview/ddic (kind "TABL") or datapreview/cds (kind
   *  "DDLS") route -- the same door ADT's own Data Preview uses, and the
   *  one that already carries a DDIC field's label (tableDataDocument's
   *  own dataPreview:description) and resolves a DDLS's own name the way
   *  tools/adt-cds.mjs cdsEntityOf does, so this client hands it the CDS
   *  entity's own name and never has to know its @AbapCatalog.sqlViewName.
   *  `statement` is the SQL to run (lib.js dataPreviewQuery below); the
   *  façade runs it as written, the same as freestyle() above. Timed and
   *  carries the generation the same way; goes through request(), so a
   *  name the store does not have throws with the façade's own message (a
   *  404 naming the object, not swallowed into a client-side guess) and a
   *  name it has but the database does not (an unsupported CDS join,
   *  tools/cds2ddic.mjs's own skip) throws with the SQL engine's own
   *  refusal -- neither reads as silently empty rows. */
  async dataPreview(kind, name, statement, rowLimit) {
    const route = kind === "DDLS" ? "cds" : "ddic";
    const param = kind === "DDLS" ? "ddlSourceName" : "ddicEntityName";
    const startedAt = Date.now();
    const res = await this.request(
      `/sap/bc/adt/datapreview/${route}?${param}=${encodeURIComponent(name)}&rowNumber=${encodeURIComponent(rowLimit)}`,
      {method: "POST", headers: {"content-type": "text/plain; charset=utf-8"}, body: statement},
    );
    const ms = Date.now() - startedAt;
    const xml = await res.text();
    const generation = res.headers.get("x-osd-generation") ?? undefined;
    return {...dataPreviewRows(xml), ms, generation};
  }

  /** Q6b "Classrun" (docs/vscode-extension.md): F9, "Run as ABAP Application
   *  (Console)" -- POST tools/adt-facade.mjs `oo/classrun/<name>` with no
   *  body, text/plain back: everything the class wrote through
   *  `out->write( )`, or a trace after it if it dumped (still a 200, the
   *  way ADT's own console shows a partial run). `request()` still throws
   *  on an actual HTTP error -- not found, or a class that does not
   *  implement IF_OO_ADT_CLASSRUN -- which is the caller's to catch, the
   *  same distinction `entitySets()` / `readers()` above draw. Timed and
   *  carries the generation like `freestyle()` above. */
  async classrun(className) {
    const startedAt = Date.now();
    const res = await this.request(`/sap/bc/adt/oo/classrun/${encodeURIComponent(className)}`, {
      method: "POST",
      headers: {accept: "text/plain"},
    });
    const ms = Date.now() - startedAt;
    const text = await res.text();
    const generation = res.headers.get("x-osd-generation") ?? undefined;
    return {text, ms, generation};
  }

  /** ABAP notebook cells are one generated classrun class in the persistent
   *  scratch pack. The façade writes it to that layer, activates it, and
   *  returns this run's console text, all in one serialized request. */
  async notebookAbap(source) {
    const res = await this.request("/sap/bc/adt/notebook/abap", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({source}),
    });
    return res.json();
  }

  /** SQLScript notebook cells use the existing AMDP sandbox's JSON cell
   *  path. This door is ICF, not ADT, and its own database guard answers a
   *  structured error when the system is not on HANA. */
  async amdpCell(source) {
    const res = await this.fetch(`${this.url}/sap/bc/osd/amdp/cell`, {
      method: "POST",
      headers: {"content-type": "text/plain; charset=utf-8", accept: "application/json"},
      body: source,
    });
    const text = await res.text();
    let answer;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = undefined;
    }
    if (res.ok === false) {
      throw new Error(answer?.error ?? `AMDP sandbox: HTTP ${res.status}`);
    }
    return amdpCellResult(answer);
  }

  /** Q4 "Hotspots" (docs/vscode-extension.md): counts per (object, line)
   *  and per object off ZOSD_DUMP -- the table tools/osd-dumps.mjs writes
   *  after a request's own rollback (tools/osd-serve.mjs `dump()`). No new
   *  route: this is `freestyle()` above with HOTSPOTS_SQL, the same door
   *  Q6a's notebook runs a cell through. `hotspotsFromRows` (below) does the
   *  rows-to-maps half, so a test can hold it to a canned answer without a
   *  server. A table the SQL door refuses (not built yet) reads as no
   *  hotspots rather than an error a status-bar timer would have to filter. */
  async hotspots(rowLimit = 1000) {
    try {
      const result = await this.freestyle(HOTSPOTS_SQL, rowLimit);
      return hotspotsFromRows(result.rows);
    } catch (e) {
      if (/no such table/i.test(String(e.message ?? e))) return {byLine: [], byFile: {}};
      throw e;
    }
  }

  /** Services tree (docs/vscode-extension.md, "Services tree"): every row
   *  this osd serves, normalized (lib.js `normalizeServiceRow` /
   *  `normalizeServiceSetRow` above) whichever of the two sources
   *  answered. Tries the composing route first (docs/ideas.md T8, `GET
   *  core/http/services`) and falls back to ZOSD_STATUS_SRV's own
   *  ServiceSet on a 404 for older systems. Any other error (osd down, a
   *  malformed answer) is the caller's to catch, the same as every other
   *  method here. */
  async services() {
    try {
      const body = await this.json("/sap/bc/adt/core/http/services");
      return uniqueServices((body?.services ?? []).map(normalizeServiceRow));
    } catch (e) {
      if (!/HTTP 404/.test(String(e.message ?? e))) throw e;
    }
    const res = await this.fetch(`${this.url}/sap/opu/odata/sap/ZOSD_STATUS_SRV/ServiceSet?$format=json`);
    if (!res.ok) throw new Error(`GET ZOSD_STATUS_SRV/ServiceSet: HTTP ${res.status}`);
    const body = await res.json();
    return uniqueServices((body?.d?.results ?? []).map(normalizeServiceSetRow));
  }

  /** Every transaction declaration, including reports and dynpros the
   *  runtime cannot enter, from the same registry the WebGUI renders. */
  async transactions() {
    const body = await this.json("/sap/bc/adt/core/http/transactions");
    return (body?.transactions ?? []).map(normalizeTransactionRow);
  }

  /** Run an object's tests, or one class, or one method of it.
   *
   *  `dbEnv` (docs/vscode-extension.md, "Databases"; the shape
   *  editors/vscode/launcher.js's `databaseEnv` builds) runs THIS request's
   *  tests on a different database than the server's own -- `undefined`
   *  (the default) sends no body at all, and the façade route runs the
   *  test in its usual throwaway SQLite file, unchanged. Sent in the body,
   *  never the query string: it may carry a password, and a query string
   *  ends up in server logs where a body does not. */
  run(object, testClass, method, dbEnv, inspectPort, waitForDebugger = false, signal) {
    let route = `/sap/bc/adt/core/http/unit/object/run?type=${encodeURIComponent(object.type)}&name=${encodeURIComponent(object.name)}`;
    if (testClass) route += `&testClass=${encodeURIComponent(testClass)}`;
    if (method) route += `&method=${encodeURIComponent(method)}`;
    const options = {method: "POST", signal};
    if (dbEnv !== undefined || inspectPort !== undefined) {
      options.headers = {"content-type": "application/json"};
      options.body = JSON.stringify({...(dbEnv === undefined ? {} : {dbEnv}),
        ...(inspectPort === undefined ? {} : {inspectPort, waitForDebugger})});
    }
    return this.json(route, options);
  }

  /** Ctrl+F2: check `source` (an editor's own buffer, not necessarily saved)
   *  as the given include of `object`, against the checkruns route
   *  (tools/adt-facade.mjs, `router.post(BASE/checkruns, ...)`). Sends the
   *  content inline, the way ADT checks what a person has typed rather than
   *  what is on disk. */
  async check(object, include, source) {
    const objectUri = uriOf(object);
    const artifactUri = include === undefined || include === "main"
      ? `${objectUri}/source/main`
      : `${objectUri}/includes/${include}/source/main`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="${xmlEscape(objectUri)}" chkrun:version="active">
    <chkrun:artifacts>
      <chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${xmlEscape(artifactUri)}">
        <chkrun:content>${xmlEscape(source)}</chkrun:content>
      </chkrun:artifact>
    </chkrun:artifacts>
  </chkrun:checkObject>
</chkrun:checkObjectList>`;
    const res = await this.request("/sap/bc/adt/checkruns", {method: "POST", headers: {"content-type": "application/vnd.sap.adt.checkobjects+xml"}, body});
    return parseCheckReport(await res.text());
  }

  /** Ctrl+F3: activate `object` (tools/adt-facade.mjs, `router.post(BASE/activation,
   *  ...)`). Awaits the object's own build, so the generation on the answer
   *  is the one that already serves it -- `X-OSD-Generation` on every osd
   *  answer (docs/generations.md). One name, through activateMany() below. */
  activate(object) {
    return this.activateMany([object]);
  }

  /** T7 "Rebuild (warm)" (docs/vscode-extension.md "Warm"): activate several
   *  objects in one call, the way a person activating a whole change in ADT
   *  would -- one build (and, warm, one swap) covers every object named,
   *  rather than one swap per object. Same route and same document shape as
   *  activate() above (which is just this with one name), and the same
   *  build-headers on the answer: `build` ("warm" or "cold" -- "cold;
   *  <reason>" folded into the reason -- tools/adt-facade.mjs warmHeaders()),
   *  `swapMs` (present only for a warm build that actually swapped; absent
   *  for a warm build the process recycled instead, a HOST_HELD module,
   *  docs/warm-compile.md "What the process holds itself"), `closure` (how
   *  many objects the change reached) and `closureTests` (the ones among
   *  them that carry ABAP Unit, comma-list on the wire, an array here). */
  async activateMany(objects) {
    const refs = objects.map((o) =>
      `<adtcore:objectReference adtcore:uri="${xmlEscape(uriOf(o))}" adtcore:name="${xmlEscape(o.name)}"/>`).join("");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs}</adtcore:objectReferences>`;
    const res = await this.request("/sap/bc/adt/activation?method=activate", {method: "POST", headers: {"content-type": "application/xml"}, body});
    const generation = res.headers.get("x-osd-generation") ?? undefined;
    const build = res.headers.get("x-osd-build") ?? undefined;
    const swapMs = res.headers.get("x-osd-swap-ms");
    const closure = res.headers.get("x-osd-closure");
    const closureTests = res.headers.get("x-osd-closure-tests");
    return {
      ...parseActivationResult(await res.text()),
      generation,
      build,
      swapMs: swapMs === null || swapMs === undefined || swapMs === "" ? undefined : Number(swapMs),
      closure: closure === null || closure === undefined || closure === "" ? undefined : Number(closure),
      closureTests: closureTests ? closureTests.split(",").filter(Boolean) : [],
    };
  }

  /** T7 "Rebuild (warm)": every CLAS/INTF this osd's warm registry says no
   *  longer hashes to what it was primed or last built from
   *  (tools/adt-facade.mjs `core/http/changed`, ObjectStore#changedObjects).
   *  `objects: undefined` (not an empty array) when the registry is not
   *  primed -- the caller's cue to fall back to a cold rebuild -- with
   *  `reason` carrying why, verbatim from the server. */
  changed() {
    return this.json("/sap/bc/adt/core/http/changed");
  }
}

// ---- the two documents above are XML, without a parser this project does
// not otherwise need; escape/unescape the five entities checkReportDocument
// and activationFailureDocument use (tools/adt-documents.mjs) and read the
// two shapes back with the same kind of pattern that wrote them.

function xmlEscape(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function xmlUnescape(text) {
  return String(text ?? "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

/** A checkRunReports document (tools/adt-documents.mjs checkReportDocument)
 *  into `[{uri, status, statusText, issues: [{line, column, severity, message}]}]`.
 *  A4H puts the position only in the message's own `chkrun:uri` fragment
 *  (`#start=line,column`), and this façade follows that shape. */
function parseCheckReport(xml) {
  const reports = [];
  const reportRe = /<chkrun:checkReport\b([^>]*?)(?:\/>|>([\s\S]*?)<\/chkrun:checkReport>)/g;
  for (const r of String(xml ?? "").matchAll(reportRe)) {
    const attrs = r[1];
    const uri = attrs.match(/chkrun:triggeringUri="([^"]*)"/)?.[1] ?? "";
    const status = attrs.match(/chkrun:status="([^"]*)"/)?.[1] ?? "processed";
    const statusText = xmlUnescape(attrs.match(/chkrun:statusText="([^"]*)"/)?.[1] ?? "");
    const issues = [];
    for (const m of String(r[2] ?? "").matchAll(/<chkrun:checkMessage\b([^>]*)\/>/g)) {
      const a = m[1];
      const messageUri = a.match(/chkrun:uri="([^"]*)"/)?.[1] ?? "";
      const [, line, column] = messageUri.match(/#start=(\d+),(\d+)/) ?? [, "1", "1"];
      issues.push({
        line: Number(line),
        column: Number(column),
        severity: a.match(/chkrun:type="([^"]*)"/)?.[1] ?? "E",
        message: xmlUnescape(a.match(/chkrun:shortText="([^"]*)"/)?.[1] ?? ""),
      });
    }
    reports.push({uri, status, statusText, issues});
  }
  return reports;
}

/** The activation route's answer (tools/adt-documents.mjs, activationSuccessDocument
 *  / activationFailureDocument) into `{ok, issues}` with source hrefs and severity.
 *  Both shapes carry properties; activationExecuted determines success. */
function parseActivationResult(xml) {
  const text = String(xml ?? "").trim();
  if (text === "" || /<chkl:properties\b[^>]*activationExecuted="true"/.test(text)) {
    return {ok: true, issues: []};
  }
  const issues = [];
  // `msg` as a system writes it; `msg:msg` as an older OSD did
  for (const m of text.matchAll(/<(msg(?::msg)?)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = m[2];
    const href = xmlUnescape(attrs.match(/href="([^"]*)"/)?.[1] ?? "");
    issues.push({
      href,
      severity: attrs.match(/type="([^"]*)"/)?.[1] ?? "E",
      line: Number(href.match(/#start=(\d+),/)?.[1] ?? attrs.match(/line="([^"]*)"/)?.[1] ?? "1"),
      column: Number(href.match(/,(\d+)$/)?.[1] ?? "1"),
      objDescr: xmlUnescape(attrs.match(/objDescr="([^"]*)"/)?.[1] ?? ""),
      message: xmlUnescape(m[3].match(/<txt>([\s\S]*?)<\/txt>/)?.[1] ?? ""),
    });
  }
  return {ok: false, issues};
}

// ---- T7 "Rebuild (warm)" (docs/vscode-extension.md "Warm"): turning
// /osd/serving's `warm` field and an activation's own build headers into the
// three or four words a status bar, a tree row or a message has room for.
// Pure, so the shapes (docs/warm-compile.md's own vocabulary: off / priming
// / primed / cold-with-a-reason, warm-but-recycled) are tested without a
// server (test/vscode-extension.mjs).

/** /osd/serving's `warm` field (tools/osd-store.mjs warmStatus()) into the
 *  line the status bar and the tree's state row show: "warming up..." while
 *  the prime is still running, "warm" once it is, "cold: <reason>"
 *  otherwise -- the reason exactly as the server gave it (which transpiler
 *  PR is missing, docs/warm-compile.md, or "OSD_WARM is not 1"). `undefined`
 *  (no line at all) for `warm.state === "off"` or no `warm` field at all --
 *  most machines never turn this on, and a status bar that says "off" on
 *  every tick would be noise rather than news. */
function warmStatusText(warm) {
  if (warm === undefined || warm.state === "off") return undefined;
  if (warm.state === "priming") return "warming up…";
  if (warm.state === "primed") return "warm";
  return `cold: ${warm.reason ?? "not primed"}`;
}

/** An activation's (or activateMany's) own build, off the headers
 *  activate()/activateMany() already read into the result (`build`,
 *  `swapMs`): "hot-swapped in <ms> ms (warm)", "warm, already live" for a
 *  warm build with no swap header (the generation was already the one
 *  serving, nothing to load), or "cold build" / "cold build: <reason>"
 *  (tools/adt-facade.mjs warmHeaders() folds `cold; <reason>` into one
 *  header value -- a warm build the runtime was recycled for, a refused
 *  swap or a HOST_HELD module, is `cold; recycled after a warm build:
 *  <why>`, never "warm"). `undefined` when the
 *  answer carried no `X-OSD-Build` at all (an activation that never
 *  reached publish(), such as a checked-only edit). */
function activationBuildText(result) {
  const build = result?.build;
  if (build === undefined) return undefined;
  if (build === "warm") {
    return result.swapMs === undefined ? "warm, already live" : `hot-swapped in ${result.swapMs} ms (warm)`;
  }
  // `failed; <why>`: nothing was loaded (a runtime still changing hands, a
  // recycle that failed); the answer is a failure document, so the caller
  // normally shows its issue and not this
  const failed = /^failed;\s*(.*)$/.exec(build)?.[1];
  if (failed !== undefined) return `nothing loaded: ${failed}`;
  const reason = /^cold;\s*(.*)$/.exec(build)?.[1];
  return reason ? `cold build: ${reason}` : "cold build";
}

/** "3 tests in the closure" (or nothing for none, or an empty string with no
 *  closure at all) -- activateMany()'s own `closureTests`, kept on the
 *  result for a later use (B1) and shown here as the one line the task
 *  asks for. */
function closureTestsText(result) {
  const n = result?.closureTests?.length ?? 0;
  return n === 0 ? undefined : `${n} test${n === 1 ? "" : "s"} in the closure`;
}

// ---- Q2b "Runner" (docs/vscode-extension.md, "Next"): call the entity set
// of a SEGW _DPC_EXT class's own `<set>_get_entityset` / `<set>_get_entity`
// method, from a CodeLens above it or from F8 inside it. The server names
// the class's service and its sets (tools/adt-facade.mjs `core/http/segw/
// entitysets`, tools/segw-entityset-map.mjs); everything here is the pure
// half -- where a lens goes over a source string, and which method (if any)
// a cursor line sits inside -- so a test holds it without VS Code or a
// server.

const ENTITYSET_METHOD_LINE = /^[ \t]*METHOD\s+(\w+)_get_entityset\s*\.[ \t]*$/i;
const ENTITY_METHOD_LINE = /^[ \t]*METHOD\s+(\w+)_get_entity\s*\.[ \t]*$/i;
const METHOD_LINE = /^[ \t]*METHOD\s+(\S+?)\s*\.[ \t]*$/i;
const ENDMETHOD_LINE = /^[ \t]*ENDMETHOD\s*\.[ \t]*$/i;

/** `[{line, method, kind}]`, one per `METHOD <set>_get_entityset.` /
 *  `METHOD <set>_get_entity.` line of `source` (1-based line numbers, the
 *  shape a `vscode.CodeLens`'s `Range` wants minus one) -- a plain text
 *  scan of the editor's own buffer, so a lens follows an unsaved edit the
 *  way the server's answer (by method name) cannot. */
function entitySetMethodLines(source) {
  const out = [];
  const lines = String(source ?? "").split(/\r\n|\r|\n/);
  lines.forEach((text, i) => {
    const entityset = ENTITYSET_METHOD_LINE.exec(text);
    if (entityset !== null) {
      out.push({line: i + 1, method: `${entityset[1]}_get_entityset`.toUpperCase(), kind: "get_entityset"});
      return;
    }
    const entity = ENTITY_METHOD_LINE.exec(text);
    if (entity !== null) {
      out.push({line: i + 1, method: `${entity[1]}_get_entity`.toUpperCase(), kind: "get_entity"});
    }
  });
  return out;
}

/** `entitySetMethodLines(source)` joined with the server's own map for the
 *  class (`{service, sets: [{method, kind, set}]}`, `core/http/segw/
 *  entitysets`) into what a CodeLens shows: `{line, kind, set, service,
 *  title}`. A method the server's map does not carry -- an override the
 *  MPC's own constants do not name -- gets no lens rather than a guessed
 *  one; `map` itself missing (the class is not a registered service's DPC)
 *  answers no lenses at all. */
function entitySetLenses(source, map) {
  if (map === undefined || !Array.isArray(map.sets)) return [];
  const bySets = new Map(map.sets.map((s) => [`${s.kind} ${s.method}`, s]));
  const out = [];
  for (const found of entitySetMethodLines(source)) {
    const known = bySets.get(`${found.kind} ${found.method}`);
    if (known === undefined) continue;
    out.push({line: found.line, kind: found.kind, set: known.set, service: map.service, title: `▶ Call ${known.set}`});
  }
  return out;
}

/** The method active at 0-based `line` of `source`: the name of the last
 *  `METHOD x.` seen up to and including that line, cleared by the
 *  `ENDMETHOD.` that closes it -- so F8 pressed on the `METHOD` line itself
 *  or anywhere in its body dispatches the same as a lens above it, and F8
 *  pressed between methods (or on a declaration, not an implementation)
 *  finds none. `undefined` outside any method. */
function methodAtLine(source, line) {
  const lines = String(source ?? "").split(/\r\n|\r|\n/);
  let current;
  for (let i = 0; i <= line && i < lines.length; i++) {
    const m = METHOD_LINE.exec(lines[i]);
    if (m !== null) {
      current = m[1].toUpperCase();
      continue;
    }
    if (ENDMETHOD_LINE.test(lines[i])) {
      current = undefined;
    }
  }
  return current;
}

/** OData v2 JSON's own rows: an entity set's `d.results`, a single entity's
 *  `d` itself, or `[]` when the body wears neither shape -- each row as the
 *  server sent it, `__metadata` and all (`stripMetadata` below strips it
 *  for display; `keyOf` below reads the key predicate out of it first). */
function resultRows(body) {
  const d = body?.d;
  if (Array.isArray(d?.results)) return d.results;
  if (d !== undefined) return [d];
  return [];
}

/** A row without `__metadata`: the columns a table shows. */
function stripMetadata(row) {
  const {__metadata, ...rest} = row ?? {};
  return rest;
}

/** The key predicate out of a row's own `__metadata.uri`
 *  (`.../TravelSet('T0001')` -> `'T0001'`, a composite key's
 *  `(TravelID='T0001',BookingID='0001')` unchanged) -- what the `_get_entity`
 *  lens's key prompt defaults to, read off the server's own answer rather
 *  than reconstructed from the entity type's key properties, which this
 *  client does not otherwise know. `undefined` when the row carries no
 *  `__metadata` (a service not built with `set_is_media` or a plain object). */
function keyOf(row) {
  const uri = row?.__metadata?.uri;
  if (typeof uri !== "string") return undefined;
  const m = /\(([^)]*)\)\s*$/.exec(uri);
  return m === null ? undefined : m[1];
}

/** Q6b "Classrun": does this class's own source declare `INTERFACES
 *  if_oo_adt_classrun`? The same test tools/osd-classrun.mjs runs against
 *  the tracked file server-side; here it decides F8's dispatch (RUN_TABLE.CLAS)
 *  off the buffer VS Code already has open, not necessarily saved -- the
 *  same "the editor's own text, not the file" Ctrl+F2's check() already
 *  works this way. */
function implementsClassrun(source) {
  return /^\s*INTERFACES\s+if_oo_adt_classrun\b/im.test(String(source ?? ""));
}

/** the transaction code tools/osd-gui-convert.mjs wires a converted report
 *  under: `ZGUI_<base>`, base being the program name with a leading Z
 *  stripped -- namesOf() there, kept in step by test/vscode-extension.mjs
 *  rather than by a shared module (see the RUN_TABLE.PROG comment below). */
function progTcodeOf(programName) {
  const base = String(programName ?? "").replace(/^Z/i, "").toUpperCase();
  return base === "" ? undefined : `ZGUI_${base}`;
}

/** The Easy Access entry URL for a transaction. Build the path and its
 *  `okcode` after VS Code has resolved the base for the local UI: the remote
 *  port-forwarding URI is a transport address, while these are the webgui
 *  resource and command that must reach it. */
function webguiTransactionUrl(base, tcode) {
  const url = new URL(String(base));
  const root = url.pathname.replace(/\/+$/, "");
  url.pathname = `${root}/sap/bc/gui/sap/its/webgui/`;
  url.hash = "";
  url.searchParams.set("okcode", String(tcode ?? ""));
  return url.toString();
}

/** Keep the iframe URL intact, but change the document on every run. VS Code
 *  ignores assignments of identical webview HTML, so a run number makes F8
 *  reload the transaction even when the target URL has not changed. */
function webguiPanelHtml(url, tcode, run) {
  const origin = new URL(url).origin;
  const attr = (value) => htmlEscape(value).replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${attr(origin)}; style-src 'unsafe-inline';">
<style>html,body{margin:0;height:100%;background:#1f4e79}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body><iframe src="${attr(url)}" title="${attr(tcode)}" data-run="${run}"></iframe></body>
</html>`;
}

/** Reserve a report's panel before the async URI lookup. Only the latest F8
 *  may fill it: an earlier lookup can otherwise finish after a later run. */
async function runWebguiPanel(tcode, baseUri, panels, {createPanel, resolveBase, panelHtml, onResolveError}) {
  let entry = panels.get(tcode);
  if (entry === undefined) {
    const panel = createPanel(tcode);
    entry = {panel, run: 0};
    panels.set(tcode, entry);
    panel.onDidDispose(() => {
      if (panels.get(tcode) === entry) panels.delete(tcode);
    });
  } else {
    entry.panel.reveal();
  }
  const run = ++entry.run;
  let externalBase = baseUri;
  try {
    externalBase = await resolveBase(baseUri);
  } catch (e) {
    onResolveError?.(e);
  }
  if (panels.get(tcode) !== entry || entry.run !== run) return;
  const target = webguiTransactionUrl(externalBase.toString(), tcode);
  entry.panel.webview.html = panelHtml(target, tcode, run);
}

/** `{line, tcode, title}` for the CodeLens above a *.prog.abap's own
 *  `REPORT` statement (1-based line, VS Code's own convention for a
 *  Range), or `undefined` for a program with no `REPORT` line at all (an
 *  include) -- the "Open in VS Code" symmetric to F8 (RUN_TABLE.PROG),
 *  placed once at parse time rather than asked for on every keypress. */
function progRunLens(source, programName) {
  const tcode = progTcodeOf(programName);
  if (tcode === undefined) return undefined;
  const lines = String(source ?? "").split(/\r\n|\r|\n/);
  const at = lines.findIndex((line) => /^\s*REPORT\b/i.test(line));
  if (at < 0) return undefined;
  return {line: at + 1, tcode, title: `▶ Run in Easy Access (${tcode})`};
}

// ---- F8, "Run", by object type (SE80's own dispatch). What this build
// already reaches stays concrete; every other type answers a `text`
// describing the server work its turn would add, so the table gets one
// entry filled in at a time rather than the same guess made twice. Kept as
// data (not a switch inside extension.js) so a test can hold every row to
// its planned action without VS Code.
const RUN_TABLE = {
  // a service's _DPC_EXT / _MPC_EXT: SE80's F8 there opens a client of the
  // service, not a debugger. Q2b (docs/vscode-extension.md) narrowed the
  // gap: the cursor inside a `<set>_get_entityset` / `<set>_get_entity`
  // method now does the same as that method's CodeLens -- extension.js
  // finds the method the cursor sits in (lib.js methodAtLine) and looks it
  // up in the server's own map (Osd#entitySets) before calling here, and
  // hands the answer in `ctx.entitySet`; everything else on such a class
  // still has no Gateway client to open.
  CLAS: (ctx) => {
    if (ctx.hasClassrun) return {kind: "classrun"};
    if (/_DPC_EXT$|_MPC_EXT$/i.test(ctx.name ?? "")) {
      if (ctx.entitySet !== undefined) {
        return {kind: "call-entityset", ...ctx.entitySet};
      }
      return {kind: "not-yet", text: "not yet: put the cursor inside a <set>_get_entityset or <set>_get_entity method (or click its CodeLens) -- the rest of a service's DPC_EXT / MPC_EXT still has no Gateway client"};
    }
    return {kind: "nothing-to-run", text: `Nothing to run for ${ctx.name}. Tests: Ctrl+Shift+F10.`};
  },
  INTF: () => ({kind: "not-yet", text: "not yet: an interface has nothing of its own to run"}),
  // gui-reports spike (docs/gui-reports.md): a report converted by
  // tools/osd-gui-convert.mjs is wired as a transaction named ZGUI_<base>,
  // the same naming the generator uses (namesOf there, progTcodeOf here --
  // duplicated on purpose rather than shared, since one is a build tool and
  // the other ships inside the extension; test/vscode-extension.mjs holds
  // them to the same answer for the three examples). F8 does not ask the
  // server whether that transaction exists: it opens webgui at the code
  // either way, and an unconverted report gets the same "Transaction ...
  // does not exist" the real Easy Access screen would show, in the webview
  // rather than in a dialog -- one fact, wherever it is read.
  // 0.5 O: F8 builds the report with osabap into a native command and runs
  // it in a terminal (`osd run`, tools/osd-run.mjs), its selection screen
  // as the command line; Run with debugger keeps the Easy Access panel the
  // CodeLens above REPORT also opens
  PROG: (ctx) => {
    if (!ctx.forceDebugger && ctx.file) {
      return {kind: "cli", file: ctx.file};
    }
    const tcode = progTcodeOf(ctx.name);
    if (tcode === undefined) {
      return {kind: "not-yet", text: "not yet: run a report -- no server route to run one headlessly yet"};
    }
    return {kind: "webgui", tcode};
  },
  FUGR: () => ({kind: "not-yet", text: "not yet: a test form from GET /sap/bc/osd/rfc/functions/<NAME>, then POST /call"}),
  // Q7 (docs/vscode-extension.md): F8's data preview -- the façade's own
  // datapreview/ddic (TABL) or datapreview/cds (DDLS) route, the same one
  // ADT's own Data Preview uses. It resolves the name, and for a DDLS the
  // twin view a CDS entity's own name reaches (tools/adt-cds.mjs
  // cdsEntityOf) -- nothing here guesses a @AbapCatalog.sqlViewName.
  // extension.js's openDataPreview does the rest; `ctx.name` is the file's
  // own name (dataPreviewObjectOf below), not read off adtObjectOf, which
  // knows neither type.
  TABL: (ctx) => ({kind: "data-preview", objectType: "TABL", name: ctx.name}),
  DDLS: (ctx) => ({kind: "data-preview", objectType: "DDLS", name: ctx.name}),
  IWSV: () => ({kind: "not-yet", text: "not yet: the Gateway client on the service document"}),
  SICF: () => ({kind: "not-yet", text: "not yet: open the node's URL"}),
};

/** The terminal command line F8 on a report runs: node on the checkout's
 *  bin/osd.mjs, `run`, the report's file. Quoted for the shell the terminal
 *  starts (POSIX single quotes; PowerShell on Windows takes the same). */
function osdRunCommandLine({home, file, node = "node"}) {
  const q = (x) => `'${String(x).replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const osd = path.join(String(home), "bin", "osd.mjs");
  const call = process.platform === "win32" ? "& " : "";
  return `${call}${q(node)} ${q(osd)} run ${q(file)}`;
}

/** F8 dispatches runnable objects only; ABAP Unit has its own commands. */
function runActionFor(object, ctx = {}) {
  const entry = RUN_TABLE[object?.type];
  if (entry === undefined) {
    return {kind: "not-yet", text: `not yet: ${object?.type ?? "this object"} has no F8 action`};
  }
  return entry({name: object?.name, ...ctx});
}

// ---- Q7 "F8 on a table or a CDS view" (docs/vscode-extension.md): the
// rows the façade's own datapreview/ddic (a TABL) or datapreview/cds (a
// DDLS) route answers, filtered to the runtime's own client the way a
// real system's SADL would for a CDS view and Open SQL would not for a
// plain SELECT (CLAUDE.md "Known traps": no implicit MANDT). Every
// function here is pure -- extension.js's openDataPreview is the thin
// wrapping, the same split Q2b/Q3/Q6a already use.

const DATAPREVIEW_TABL_FILE = /^(.+?)\.tabl\.xml$/i;
const DATAPREVIEW_DDLS_FILE = /^(.+?)\.ddls\.(?:asddls|xml)$/i;

/** `{type, name}` for a file F8's data preview reaches: a TABL's own
 *  `<table>.tabl.xml`, or a DDLS's `<view>.ddls.asddls` / its `.ddls.xml`
 *  twin -- else undefined. adtObjectOf (above) does not know either type
 *  (Check/Activate do not reach them), so `run()` asks this instead. The
 *  name is the file's own base, upper-cased and namespace-mapped the same
 *  way objectOf's is: for a TABL, the table the database has; for a DDLS,
 *  the CDS entity's own name -- what tools/adt-cds.mjs cdsEntityOf and the
 *  façade's datapreview/cds route resolve by, not the view's own
 *  @AbapCatalog.sqlViewName, which this file never has to know. */
function dataPreviewObjectOf(file) {
  const base = path.basename(String(file ?? ""));
  const tabl = DATAPREVIEW_TABL_FILE.exec(base);
  if (tabl !== null) return {type: "TABL", name: tabl[1].replaceAll("#", "/").toUpperCase()};
  const ddls = DATAPREVIEW_DDLS_FILE.exec(base);
  if (ddls !== null) return {type: "DDLS", name: ddls[1].replaceAll("#", "/").toUpperCase()};
  return undefined;
}

/** Whether a TABL's own abapGit XML (the file F8's data preview reads,
 *  not necessarily saved -- the same "the buffer, not the file" rule
 *  Ctrl+F2's check and Q6b's implementsClassrun already follow) carries a
 *  MANDT field: a plain scan of its DD03P rows. A DDLS never reaches
 *  this -- the CDS-name view tools/cds2ddic.mjs writes for one has no
 *  MANDT column at all ("the CDS entity itself has no client... as on a
 *  system", that file's own viewFieldsOf), so there is no column there to
 *  filter by or to show. */
function tablHasMandt(xmlSource) {
  return /<FIELDNAME>MANDT<\/FIELDNAME>/i.test(String(xmlSource ?? ""));
}

// The runtime's own sy-mandt is fixed at 123 (tools/osd-identity.mjs
// DEFAULT_CLIENT) -- and deliberately not the client the ADT façade itself
// presents (identity().adt.client, "001", backlog G.1b: the façade's own
// pretend system is allowed to differ from the data's own). Reading the
// façade's client here would filter for the wrong one, so this is the
// fixed constant CLAUDE.md's "Known traps" already names, with the reason
// it is not read off the server instead.
const MANDT_CLIENT = "123";

/** The SQL a data-preview cell runs for `name` (dataPreviewObjectOf's own
 *  shape): the whole object, filtered to MANDT_CLIENT when `hasMandt` and
 *  not `allClients`. A DDLS caller always passes `hasMandt: false`
 *  (tablHasMandt above never applies to one), so this never files a WHERE
 *  MANDT a CDS-name view has no column to satisfy. */
function dataPreviewQuery(name, {hasMandt = false, allClients = false} = {}) {
  return hasMandt && !allClients ? `SELECT * FROM ${name} WHERE MANDT = '${MANDT_CLIENT}'` : `SELECT * FROM ${name}`;
}

/** The same query, as a row count -- run separately and only when the main
 *  fetch came back exactly at the row cap (dataPreviewStatusText below),
 *  because a COUNT(*) is the one query this feature asks the door for
 *  twice rather than once. */
function dataPreviewCountQuery(name, options) {
  return dataPreviewQuery(name, options).replace(/^SELECT \*/, "SELECT COUNT(*) AS N");
}

/** "N rows" when the cap was not reached; "first N of M" once it was and a
 *  cheap COUNT (dataPreviewCountQuery above) answered `total`; "first N
 *  rows" when it was reached and no count was asked for (or it failed) --
 *  a guessed total is worse than none. */
function dataPreviewStatusText(shown, rowLimit, total) {
  if (shown < rowLimit) return `${shown} row${shown === 1 ? "" : "s"}`;
  if (total === undefined) return `first ${shown} rows`;
  return `first ${shown} of ${total}`;
}

/** An unavailable managed listener should not be contacted. An external
 * osd.url remains usable at every state of this window's launcher. */
function dataPreviewAvailability(state, managedUrl, currentUrl) {
  if (managedUrl !== currentUrl || state === "running") return undefined;
  if (state === "stopped" || state === undefined) return {message: "The osd system is stopped. Start it to preview data.", start: true};
  return {message: `The osd system is ${state}. Refresh when it is running.`, start: false};
}

function dataPreviewError(error, url) {
  const message = String(error?.message ?? error);
  if (error instanceof TypeError && /fetch failed|failed to fetch/i.test(message)) {
    return `Cannot reach osd at ${url}. Check that the system is running, or start it with osd: Start.`;
  }
  return message;
}

/** F8's data preview XML (tools/adt-facade.mjs tableDataDocument -- the
 *  same document shape freestyleRows above reads) into `{columns: [{name,
 *  label, key}], rows}`, `rows` shaped like freestyleRows' own. Unlike
 *  plain freestyle, datapreview/ddic and datapreview/cds carry each
 *  column's own DDIC label in dataPreview:description and whether it is a
 *  key in dataPreview:keyAttribute -- read here rather than duplicating
 *  freestyleRows' own row extraction. A column the façade did not
 *  recognise (its own fallback metadata, name.toUpperCase() again) keeps
 *  its bare name as the label rather than showing blank. */
function dataPreviewRows(xml) {
  const {columns: names, rows} = freestyleRows(xml);
  const meta = new Map();
  const metaRe = /<dataPreview:metadata\s+dataPreview:name="([^"]*)"([^>]*)\/>/g;
  for (const m of String(xml ?? "").matchAll(metaRe)) {
    const name = xmlUnescape(m[1]);
    const label = xmlUnescape(m[2].match(/dataPreview:description="([^"]*)"/)?.[1] ?? "");
    const key = m[2].match(/dataPreview:keyAttribute="([^"]*)"/)?.[1] === "true";
    meta.set(name, {label: label || name, key});
  }
  const columns = names.map((name) => ({name, label: meta.get(name)?.label ?? name, key: meta.get(name)?.key === true}));
  return {columns, rows};
}

/** The first frame of an alert that points into an ABAP file: `{file, line, column}`. */
function abapFrame(alert) {
  for (const frame of alert.stack ?? []) {
    const file = String(frame.uri ?? frame.file ?? "");
    if (/\.abap$/i.test(file) && Number(frame.line) > 0) {
      return {file: path.basename(file), line: Number(frame.line), column: Number(frame.column ?? 1)};
    }
  }
  return undefined;
}

/** One entry per method a run answered for: `{testClass, method, passed, ms,
 *  alerts: [{title, details, frame}]}`. An alert on the class with no methods
 *  (a failing class_setup) marks every method it was asked to run. */
function outcomes(run, asked = []) {
  const out = [];
  const shape = (alert) => ({title: alert.title ?? alert.kind ?? "failed", details: alert.details ?? [], frame: abapFrame(alert)});
  for (const testClass of run.testClasses ?? []) {
    const classAlerts = (testClass.alerts ?? []).map(shape);
    const methods = testClass.testMethods ?? [];
    if (methods.length === 0 && classAlerts.length > 0) {
      for (const a of asked.filter((x) => x.testClass === testClass.name)) {
        out.push({testClass: testClass.name, method: a.method, passed: false, ms: 0, alerts: classAlerts});
      }
    }
    for (const m of methods) {
      const alerts = [...classAlerts, ...(m.alerts ?? []).map(shape)];
      out.push({testClass: testClass.name, method: m.name, passed: alerts.length === 0, ms: Number(m.ms ?? 0), alerts});
    }
  }
  return out;
}

// ---- Q3 "Readers" (docs/vscode-extension.md, "Next"): a CodeLens "read by N
// · tests M · services K" over a class's own `CLASS <name> DEFINITION` line
// or an interface's own `INTERFACE <name>` line, off the server's own
// where-used answer (tools/adt-facade.mjs `core/http/xref/readers`). As with
// Q2b, the placement is a plain text scan of the editor's own buffer (so an
// unsaved rename of the class does not still show the old line) and the
// server is asked by the object's name, not guessed from the file.

/** The 1-based line of `object`'s own `CLASS <name> DEFINITION` /
 *  `INTERFACE <name>` statement in `source`, or undefined when `object` is
 *  not a CLAS/INTF or that line is not in `source` (an include other than
 *  the main one, or a name the file does not actually declare). */
function readersLensLine(source, object) {
  if (object === undefined || (object.type !== "CLAS" && object.type !== "INTF")) return undefined;
  const escaped = String(object.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = object.type === "CLAS"
    ? new RegExp(`^[ \\t]*CLASS\\s+${escaped}\\s+DEFINITION\\b`, "i")
    : new RegExp(`^[ \\t]*INTERFACE\\s+${escaped}\\b`, "i");
  const lines = String(source ?? "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

/** "read by N · tests M · services K" -- the lens title, off the server's
 *  own `counts` (`core/http/xref/readers`'s `counts.readers/tests/services`). */
function readersLensTitle(counts) {
  return `read by ${counts?.readers ?? 0} · tests ${counts?.tests ?? 0} · services ${counts?.services ?? 0}`;
}

/** The quick pick a click on the lens shows: one item per reader
 *  (`core/http/xref/readers`'s own `readers`), sorted the way the server
 *  already sorted them, Test / Service named in the description so a person
 *  can tell the two counts in the lens apart from the list rather than only
 *  from the number. Each item carries its own `reader` back, for opening. */
function readersQuickPickItems(readers) {
  return (readers ?? []).map((reader) => {
    const tags = [];
    if (reader.isTest) tags.push("Test");
    if ((reader.services ?? []).length > 0) tags.push(`Service (${reader.services.join(", ")})`);
    return {
      label: reader.name,
      description: [reader.type, ...tags].join(" · "),
      reader,
    };
  });
}

// ---- Q6a notebooks (docs/vscode-extension.md): the pure half of SQL result
// parsing, table rendering, ABAP source wrapping, AMDP result parsing, and
// notebook JSON serialization. None of this touches `vscode`, so a plain
// mocha test covers it without a notebook editor open. extension.js owns the
// NotebookSerializer and NotebookController.

/** Escape for HTML text content (not an attribute): the notebook output's
 *  own `<td>`/`<th>` cells go through this, the same three entities
 *  `entitySetHtml`'s `xmlEscapeHtml` (extension.js, Q2b) escapes -- kept
 *  here rather than there because a mocha test needs it without `vscode`. */
function htmlEscape(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** freestyle SQL's own answer (tools/adt-facade.mjs `tableDataDocument`,
 *  ~257-303: one `<dataPreview:columns>` per selected column, each with its
 *  own `dataPreview:metadata dataPreview:name="..."` and a `dataPreview:
 *  dataSet` of one `<dataPreview:data>` per row, in row order) into
 *  `{columns, rows}` -- `columns` the names in the server's own order,
 *  `rows` one plain object per row keyed by column name, so a JSON output
 *  and an HTML table can both be built off the same shape `resultRows` /
 *  `stripMetadata` above give the OData side. A column with fewer
 *  `<dataPreview:data>` than the widest one (should not happen -- every
 *  column carries exactly one value per row) pads the short rows with "".*/
function freestyleRows(xml) {
  const columns = [];
  const values = [];
  const colRe = /<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g;
  for (const m of String(xml ?? "").matchAll(colRe)) {
    const block = m[1];
    columns.push(xmlUnescape(block.match(/dataPreview:name="([^"]*)"/)?.[1] ?? ""));
    const cells = [];
    for (const d of block.matchAll(/<dataPreview:data>([\s\S]*?)<\/dataPreview:data>/g)) {
      cells.push(xmlUnescape(d[1]));
    }
    values.push(cells);
  }
  const rowCount = values.reduce((max, v) => Math.max(max, v.length), 0);
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {};
    columns.forEach((name, ci) => { row[name] = values[ci][i] ?? ""; });
    rows.push(row);
  }
  return {columns, rows};
}

/** The HTML a run cell's output shows: `columns`/`rows` (`freestyleRows`
 *  above) as a table, and the status line Q6a asks for -- "N rows · M ms ·
 *  <generation>", the generation truncated the same way the status bar and
 *  Ctrl+F3 truncate it (`serving.generation.slice(0, 8)` / `result.
 *  generation.slice(0, 8)`, extension.js). `meta.generation` missing (an
 *  answer with no `X-OSD-Generation`, which should not happen against a
 *  real façade but is not this function's business to assume) leaves that
 *  segment off rather than showing "undefined". */
function freestyleTableHtml(columns, rows, meta = {}) {
  const thead = columns.map((c) => `<th>${htmlEscape(c)}</th>`).join("");
  const tbody = rows.map((row) => `<tr>${columns.map((c) => `<td>${htmlEscape(row[c])}</td>`).join("")}</tr>`).join("");
  const generation = meta.generation === undefined ? undefined : String(meta.generation).slice(0, 8);
  const status = `${rows.length} row${rows.length === 1 ? "" : "s"} · ${meta.ms ?? 0} ms${generation === undefined ? "" : ` · ${generation}`}`;
  return `<div class="osd-sql-result">
<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
<details><summary>raw JSON</summary><pre>${htmlEscape(JSON.stringify(rows, null, 2))}</pre></details>
<div class="osd-sql-status">${htmlEscape(status)}</div>
</div>`;
}

/** VS Code prefers its JSON renderer even when HTML comes first. A single
 *  HTML item makes the table the default; raw JSON is inside its disclosure. */
function freestyleOutputItems(html) {
  return [{mime: "text/html", value: html}];
}

/** Turn an ABAP statement cell into the main source of the one class the
 *  notebook scratch pack owns. Keeping the wrapper pure makes the exact
 *  source checked by the extension testable without a VS Code host. */
function notebookAbapSource(source) {
  return `CLASS zcl_osd_notebook_cell DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_osd_notebook_cell IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
${String(source ?? "").split(/\r\n|\r|\n/).map((line) => `    ${line}`).join("\n")}
  ENDMETHOD.
ENDCLASS.
`;
}

/** The AMDP cell route wraps the sandbox's result JSON in an ordinary JSON
 *  response so a notebook can render rows without scraping its HTML page. */
function amdpCellResult(answer) {
  if (answer === null || typeof answer !== "object") {
    return {error: "AMDP sandbox did not return a JSON answer"};
  }
  if (answer.status !== "ok") {
    return {error: String(answer.error ?? "AMDP sandbox could not run this cell"), raw: answer.raw};
  }
  let rows;
  try {
    rows = JSON.parse(answer.result ?? "[]");
  } catch {
    return {error: "AMDP sandbox returned rows that were not valid JSON"};
  }
  if (Array.isArray(rows) === false) {
    return {error: "AMDP sandbox returned a result that was not a row array"};
  }
  const columns = rows.length > 0 && rows[0] !== null && typeof rows[0] === "object"
    ? Object.keys(rows[0]) : [];
  const engine = answer.engine ?? (answer.system_db === "HDB" ? "HANA (eAMDP)" : undefined);
  return {columns, rows, ms: Number(answer.ms) || 0, raw: answer.raw,
    ...(engine === undefined ? {} : {engine})};
}

// ---- Q4 "Hotspots": ZOSD_DUMP as line and file heat (docs/vscode-extension.md).
// The SQL is the whole server side of this -- no new route, the freestyle
// door above runs it -- so it lives here where a test can hold it and the
// rows-to-maps reduction to the server's real column names.

/** One dump count per (object, line), the last time and message with it
 *  (a correlated subquery rather than a second round trip): the line's own
 *  hover text is built off the same row the count came from. GROUP BY
 *  "include" too -- a class carries more than one file (main, locals,
 *  testclasses), and two of them can share a line number.
 *
 *  The subquery's own `LIMIT 1` makes `Data#query` (tools/osd-data.mjs)
 *  see this statement as already carrying a LIMIT and leave the outer one
 *  off -- so `hotspots()`'s own `rowLimit` does not bound this query. Left
 *  as is: the result is one row per distinct (object, include, line), which
 *  ZOSD_DUMP's own cap (tools/osd-dumps.mjs, 1000 rows) already bounds. */
const HOTSPOTS_SQL = `SELECT objname, "include", line, COUNT(*) AS n, MAX(created_at) AS last_at,
  (SELECT message FROM zosd_dump z2 WHERE z2.objname = z.objname AND z2."include" = z."include"
    AND z2.line = z.line ORDER BY z2.dump_id DESC LIMIT 1) AS last_message
FROM zosd_dump z
WHERE objname <> ''
GROUP BY objname, "include", line
ORDER BY n DESC`;

/** HOTSPOTS_SQL's own rows (freestyleRows' shape: every value a string,
 *  every key upper-case -- `tableDataDocument`, tools/adt-facade.mjs,
 *  writes `dataPreview:name` as `name.toUpperCase()` regardless of how the
 *  SQL cased it, so a lower-case column read here would silently see
 *  `undefined` against the real door and only against it, never against a
 *  hand-built fixture that happened to keep the SQL's own case) into
 *  `{byLine: [{objname, include, line, count, lastAt, lastMessage}],
 *  byFile: {OBJNAME: count}}`. A row with no object name or no usable line
 *  number is dropped rather than guessed at -- ZOSD_DUMP.LINE is INT4, so
 *  that only happens against a table this SQL was not written for. */
function hotspotsFromRows(rows) {
  const byLine = [];
  const byFile = {};
  for (const raw of rows ?? []) {
    const row = Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const objname = String(row.objname ?? "").trim();
    const line = Number(row.line);
    const count = Number(row.n ?? 0);
    if (objname === "" || !Number.isFinite(line) || line <= 0 || count <= 0) continue;
    byLine.push({
      objname, include: String(row.include ?? "main").trim() || "main", line, count,
      lastAt: Number(row.last_at ?? 0), lastMessage: String(row.last_message ?? ""),
    });
    byFile[objname] = (byFile[objname] ?? 0) + count;
  }
  return {byLine, byFile};
}

/** count -> intensity bucket, 1 (one dump) to 4 (heaviest): a fixed few
 *  steps rather than a scale fitted to whatever counts happen to be open,
 *  so a file with one hotspot and a file with a thousand read the same way
 *  from one editor to the next. */
function hotspotBucket(count) {
  if (count >= 10) return 4;
  if (count >= 5) return 3;
  if (count >= 2) return 2;
  return 1;
}

// translucent red over whatever the editor's own background is, rather
// than a fixed hex: a colour the theme already chose stays the theme's, in
// light mode and in dark, and the tint is what carries the heat
const HOTSPOT_ALPHA = {1: 0.12, 2: 0.22, 3: 0.35, 4: 0.5};

/** The decoration background for a bucket (1-4, hotspotBucket's own range):
 *  an rgba string, translucent over either theme rather than a colour of
 *  its own. */
function hotspotColor(bucket) {
  return `rgba(255, 0, 0, ${HOTSPOT_ALPHA[bucket] ?? HOTSPOT_ALPHA[1]})`;
}

/** A FileDecoration badge for `count`: VS Code keeps at most two characters
 *  of it, so ten or more reads as "9+" rather than being cut to "1" of "10". */
function hotspotBadge(count) {
  return count > 9 ? "9+" : String(count);
}

/** The hover text for one line's entry (a `byLine` row, above): "N dumps,
 *  last <ISO time>: <message>". `lastAt` of 0 (should not happen once a
 *  dump has been written; a defensive read of a row this function did not
 *  itself produce) reads as "an unknown time" rather than the 1970 epoch. */
function hotspotHoverText(entry) {
  const when = entry.lastAt > 0 ? new Date(entry.lastAt).toISOString() : "an unknown time";
  return `${entry.count} dump${entry.count === 1 ? "" : "s"}, last ${when}: ${entry.lastMessage || "(no message)"}`;
}

/** A *.osdnb file's own JSON (`{cells: [{kind: "code"|"markdown", value,
 *  language?}]}`) into `[{kind, language, value}]` -- close to `vscode.
 *  NotebookData`'s own cells but without the `vscode` module, so
 *  `NotebookSerializer#deserializeNotebook` and a mocha test both go
 *  through this. A `kind: "code"` cell with no `language` defaults to
 *  "sql" (the only kernel this extension registers); a bad or missing
 *  `cells` array reads as no cells rather than throwing, the way an empty
 *  notebook opens instead of refusing to. */
function notebookFromJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  const cells = Array.isArray(doc?.cells) ? doc.cells : [];
  return cells.map((c) => (c?.kind === "markdown"
    ? {kind: "markdown", language: "markdown", value: String(c.value ?? "")}
    : {kind: "code", language: String(c?.language ?? "sql"), value: String(c?.value ?? "")}));
}

/** The reverse of `notebookFromJson`: `[{kind, language, value}]` (what
 *  `NotebookSerializer#serializeNotebook` reads off `vscode.NotebookData`'s
 *  own cells) into the file's own JSON text, newline-terminated so a saved
 *  `*.osdnb` diffs cleanly. A markdown cell carries no `language` back out
 *  (its kind already says what it is); a code cell's language is written
 *  even when it is "sql", so a notebook this wrote round-trips byte for
 *  byte through `notebookFromJson`. */
function notebookToJson(cells) {
  const doc = {
    cells: (cells ?? []).map((c) => (c.kind === "markdown"
      ? {kind: "markdown", value: c.value}
      : {kind: "code", language: c.language ?? "sql", value: c.value})),
  };
  return `${JSON.stringify(doc, undefined, 2)}\n`;
}

/** Initial cells for the SQL door. ZOSD_SYS is part of the base status
 *  schema, so the example also works without any optional pack. */
function sqlNotebookStarter(statement) {
  return [
    {kind: "markdown", language: "markdown", value: "# Open SQL\nQuery the running osd system. Select the SQL cell and run it with the cell's Run button or Shift+Enter."},
    {kind: "code", language: "sql", value: statement ?? "SELECT * FROM zosd_sys UP TO 10 ROWS"},
    {kind: "markdown", language: "markdown", value: "## More about SQL cells\nUse read-only Open SQL `SELECT` statements, including `WHERE`, `ORDER BY`, and `UP TO n ROWS`. The notebook limits returned rows with `osd.notebook.rowLimit`. Results come from the running system's database through the ADT freestyle preview route. Output shows a table with a **raw JSON** disclosure of the same rows. For executable ABAP and SQLScript cells, see DX7 and `docs/notebook-cells.md`. SQLScript notebook cells currently accept relational SELECT bodies, including table variables. They run as HANA (eAMDP) on HANA or Portable AMDP (limited) on SQLite, DuckDB and PostgreSQL; unsupported constructs return a reason."},
  ];
}

// abapGit's own extension per object type, so a reader's file can be found
// without guessing at what generated it; a type this extension has no file
// shape for (FUGR, TABL, DDLS, ...) opens nothing rather than a wrong guess
const READER_EXTENSION = {CLAS: "clas", INTF: "intf", PROG: "prog"};

/** The glob `vscode.workspace.findFiles` matches for `reader`'s own file
 *  (`**\/<base>.<ext>.abap`, the namespace-to-`#` mapping `objectOf` above
 *  reads back), or undefined for a type with no such file. */
function readerFilePattern(reader) {
  const ext = READER_EXTENSION[reader?.type];
  if (ext === undefined) return undefined;
  const base = String(reader.name).replaceAll("/", "#").toLowerCase();
  return `**/${base}.${ext}.abap`;
}

// ---- Test Explorer grouping (docs/vscode-extension.md, "Test Explorer
// groups"): today every `*.clas.testclasses.abap` this extension finds
// becomes one flat sibling, project classes next to CL_ABAP_* and
// /UI2/CL_JSON from open-abap-core under .local/lars/. This section is the
// pure half of splitting that into Project / Packs / Workspace layers /
// System: which of the four a file's own path falls under, and -- once a
// group holds more than a handful of classes -- which package inside it.
// extension.js's testExplorer() is the thin wrapping: it walks
// abap_transpile.json into transpileLayers() once, calls classifyTestPath()
// per file findFiles() turns up, and builds the group/subgroup TestItems
// around the object items this file already knew how to build (unchanged,
// same ids, so a run's history still matches them).

/** `abap_transpile.json`'s own `input_folder` and `libs` turned into what
 *  classifyTestPath() below reads: the folders that are the Project (every
 *  `input_folder` entry that is not also a lib's own folder -- none are,
 *  today, but a future lib pointed at `src` should still not double as
 *  Project) and, per lib, its `name` (the folder's own last path segment --
 *  "open-abap-core", not the folder or the `url`) and its `folder`
 *  (leading/trailing slashes trimmed, so it compares one way against a
 *  relative path built by relOf() below). `config` is the parsed JSON
 *  itself, not a path -- a test holds this to the real file's own content,
 *  and extension.js reads it off disk.
 *
 *  `excludeFilter` (top-level) and each lib's own `excludeFilter` are the
 *  build's own `exclude_filter` lists (tools/osd-inputs.mjs / osd-build.mjs,
 *  tools/osd-transpile.mjs `regexps()`), read the same way -- case-
 *  insensitively, unanchored -- so a file the build itself would never read
 *  or serve (`test/fixtures/`, a lib's own `/src/tcp/`) is not listed in the
 *  Test Explorer either (classifyTestPath() below applies them). A pack has
 *  no `exclude_filter` of its own: it is layered into `input_folder` at
 *  build time and the top-level list already covers it. */
function transpileLayers(config) {
  const libs = (config?.libs ?? []).map((lib) => {
    const folder = String(lib.folder ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
    const name = folder.split("/").filter(Boolean).pop() ?? folder;
    const excludeFilter = (lib.exclude_filter ?? []).map((p) => new RegExp(p, "i"));
    return {name, folder, excludeFilter};
  });
  const libFolders = new Set(libs.map((l) => l.folder));
  const inputFolders = (config?.input_folder ?? [])
    .map((f) => String(f).replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter((f) => !libFolders.has(f));
  const excludeFilter = (config?.exclude_filter ?? []).map((p) => new RegExp(p, "i"));
  return {inputFolders, libs, excludeFilter};
}

/** Whether `absPath`, already routed to `classification` by
 *  classifyTestPath() below, is hidden by the build's own exclude filters:
 *  the top-level list for a Project or a Packs file (both are plain
 *  `input_folder` entries by the time the transpiler sees them), the
 *  matching lib's own list for a System file. A Workspace-layer file is
 *  never excluded here -- another layer's own config is not this tree's to
 *  read, and `classifyTestPath` never reads it for one either. */
function isExcludedByConfig(absPath, classification, layers) {
  const patterns = classification.group === "system"
    ? (layers?.libs ?? []).find((l) => l.name === classification.subgroup)?.excludeFilter ?? []
    : classification.group === "project" || classification.group === "packs"
      ? layers?.excludeFilter ?? []
      : [];
  return patterns.some((re) => re.test(absPath));
}

/** `absPath` relative to `root`, forward slashes always -- what every
 *  comparison in classifyTestPath() below is done against, on Windows too. */
function relOf(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}

function startsWithSegment(rel, prefix) {
  if (prefix === "") return false;
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

const PACKS_FOLDER = "packs";

/** A short, stable label for a workspace layer (launcher.js's own `{folder,
 *  srcDir}`): the folder's own last path segment, the way the System group
 *  below names a lib by its folder's, so "workspace layer" and "library"
 *  read the same way once either has more than one. */
function workspaceLayerName(layer) {
  return path.basename(String(layer?.folder ?? "")) || "layer";
}

/** Which Test Explorer group (and, inside it, which sub-node) a
 *  `*.clas.testclasses.abap` (or, since PROG keeps its own local test
 *  classes inline, a `*.prog.abap`) file at `absPath` belongs under, given
 *  `layers` (transpileLayers()'s own answer, read off `root`'s own
 *  `abap_transpile.json` -- the file's own workspace folder, never a
 *  different tree's) and `workspaceLayers` (the running launcher's own
 *  `layers`, `[]` when none is running or known -- extension.js reads
 *  `activeController?.launcher?.layers`). Checked in this order because a
 *  workspace layer can sit anywhere on disk, even somewhere that would
 *  otherwise read as a lib's own folder or as `packs/`:
 *
 *  1. `workspace` -- under a running B0 workspace layer's own folder.
 *  2. `system` -- under one of abap_transpile.json's `libs` (`.local/lars/*`
 *     today, but read off the config rather than hardcoded).
 *  3. `packs` -- under `packs/<name>/`.
 *  4. `project` -- under `src/`, `test/`, `gen/`, or whatever else
 *     `input_folder` lists that is not a lib's own folder.
 *
 *  `undefined` both for a path outside every one of the four (a staging
 *  folder such as `deploy/`, never a layer of the build) and for a path a
 *  matching root's own `exclude_filter` hides from the build itself
 *  (`test/fixtures/`, a lib's own excluded corner -- isExcludedByConfig()
 *  above): a file that is not an object of this system is not listed,
 *  rather than dropped into Project as though it were one. `root` and
 *  `absPath` sharing no common tree (the packaged extension's osdHome, a
 *  materialized copy in globalStorage, handed the workspace folder's own
 *  file) reads the same way, for the same reason: `rel` starts with `..`
 *  all the way up, matches none of the four, and is correctly refused --
 *  the fix for that case is the caller passing the file's OWN workspace
 *  folder as `root`, never falling back to it here.
 *
 *  `relInGroup` is the path below whatever root matched, for packageOf()
 *  below to sub-group further; `subgroup` is `undefined` for `project`,
 *  which has no sub-node of its own (Project lists straight from
 *  packageOf(), when it needs to at all). */
function classifyTestPath(root, absPath, layers, workspaceLayers = []) {
  const rel = relOf(root, absPath);
  let result;
  for (const wl of workspaceLayers ?? []) {
    const wlRel = relOf(root, wl.folder ?? wl.srcDir);
    // The opened folder can itself be the workspace layer. Its relative
    // prefix is empty, which startsWithSegment deliberately rejects for
    // ordinary configured roots; here every file below that folder belongs.
    const inLayer = wlRel === ""
      ? rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel) && !path.win32.isAbsolute(rel)
      : startsWithSegment(rel, wlRel);
    if (inLayer) {
      result = {group: "workspace", subgroup: workspaceLayerName(wl), relInGroup: rel.slice(wlRel.length).replace(/^\//, "")};
      break;
    }
  }
  if (result === undefined) {
    for (const lib of layers?.libs ?? []) {
      if (startsWithSegment(rel, lib.folder)) {
        result = {group: "system", subgroup: lib.name, relInGroup: rel.slice(lib.folder.length).replace(/^\//, "")};
        break;
      }
    }
  }
  if (result === undefined && startsWithSegment(rel, PACKS_FOLDER)) {
    const rest = rel.slice(PACKS_FOLDER.length + 1);
    const slash = rest.indexOf("/");
    result = {
      group: "packs",
      subgroup: slash === -1 ? rest : rest.slice(0, slash),
      relInGroup: slash === -1 ? "" : rest.slice(slash + 1),
    };
  }
  if (result === undefined) {
    for (const folder of layers?.inputFolders ?? []) {
      if (startsWithSegment(rel, folder)) {
        result = {group: "project", subgroup: undefined, relInGroup: rel};
        break;
      }
    }
  }
  if (result === undefined) return undefined;
  if (isExcludedByConfig(absPath, result, layers)) return undefined;
  return result;
}

/** How many test-carrying classes a group (or a group's own sub-node -- one
 *  pack, one lib, one workspace layer) may hold before it is worth
 *  splitting further by package rather than listed flat -- the "~15" the
 *  task named, kept in one place so extension.js and a test read the same
 *  number. */
const PACKAGE_SPLIT_THRESHOLD = 15;

function needsPackageSplit(count) {
  return count > PACKAGE_SPLIT_THRESHOLD;
}

/** `package.xml` files' own paths (each relative to the same root
 *  `classifyTestPath()` above measured `relInGroup` against) turned into
 *  the directories that carry one -- what packageOf() below prefers over
 *  guessing from `src/`. */
function packageDirsFrom(packageXmlPaths) {
  return (packageXmlPaths ?? []).map((p) => {
    const parts = String(p).replace(/\\/g, "/").split("/");
    parts.pop();
    return parts.join("/");
  });
}

/** The sub-group `relInGroup` (classifyTestPath()'s own field) falls into
 *  once its group is too big to list flat: the nearest ancestor directory
 *  in `packageDirs` (abapGit's own `package.xml`, ~one per ABAP package)
 *  when any is known, else the first real directory once any leading
 *  `src`/`test`/`gen` content root is stripped -- so
 *  "src/rtti/cl_abap_typedescr...abap" reads as "rtti" and
 *  "test/adbc/zcl_adbc_test...abap" as "adbc", the subject rather than
 *  which content root happened to carry it. `undefined` for a file with no
 *  directory of its own once that stripping is done (kept in the group's
 *  own flat overflow rather than given a made-up name). */
function packageOf(relInGroup, packageDirs = []) {
  const parts = String(relInGroup).replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  if (packageDirs.length > 0) {
    let dir = "";
    let best = packageDirs.includes("") ? "" : undefined;
    for (const part of parts) {
      dir = dir === "" ? part : `${dir}/${part}`;
      if (packageDirs.includes(dir)) best = dir;
    }
    if (best !== undefined) return best === "" ? undefined : best;
  }
  let i = 0;
  while (i < parts.length && (parts[i] === "src" || parts[i] === "test" || parts[i] === "gen")) i++;
  return parts[i];
}

/** Whether `source` (a `*.clas.testclasses.abap` include's own text) is
 *  worth turning into a Test Explorer item at all: does it mark at least
 *  one method `FOR TESTING` anywhere? Run up front, against the file
 *  system, before any object item is created -- the cheap half of the
 *  filter `discover()`'s own server round trip already does per test class
 *  and method (extension.js, `(c.methods ?? []).length > 0`), so a
 *  testclasses include with no test method at all (a global class's own
 *  empty include, or one that declares a test class with none) never
 *  becomes an item only to be found empty once expanded. */
function hasTestMethods(source) {
  return /\bFOR\s+TESTING\b/i.test(String(source ?? ""));
}

/** The object names `abap_transpile.json`'s own `options.skip` already
 *  marks as deliberately failing (`{object, class, method}`, read by
 *  tools/osd-transpile.mjs into the transpiler's own `settings.skip` --
 *  what keeps `npm test`'s build-time ABAP Unit run green over a method
 *  that fails on purpose, ZOSD_TEST's `deliberate_failure`
 *  (`docs/vscode-extension.md`, "Test Explorer groups"): the demo's own
 *  point is that the failure DOES reach a live client, so "Run" on Project
 *  in the Test Explorer must still run it and still see it fail; only the
 *  build-time run, which cannot tell "meant to fail" from "broken", skips
 *  it. Reused here rather than a new marker (a source comment, a second
 *  config list) because it is already the single, explicit, machine-read
 *  statement of exactly this fact, per object -- adding a second one risks
 *  the two drifting the way `exclude_filter`/`not_in_system` do not, only
 *  because a test holds those two together and nothing would hold these. */
function demoFailureObjects(config) {
  return new Set((config?.options?.skip ?? []).map((s) => String(s.object ?? "").toUpperCase()).filter((s) => s !== ""));
}

// ---- Services tree (docs/vscode-extension.md, "Services tree"): pure row
// normalisation, grouping, target flags, manifest resolution, and details
// rendering. extension.js supplies the VS Code tree and panel.
//
// Two sources answer the same rows, normalized to one shape here so the
// rest of the provider reads either without knowing which one answered:
// ZOSD_STATUS_SRV's own ServiceSet (today, PascalCase OData columns,
// osd-status.mjs's own servicesOf/appsOf) and the composing route
// docs/ideas.md T8 named (`GET core/http/services`, lowercase, already
// kind-typed: `handler` is a class name for every kind but APP, whose own
// class-shaped field is `app` -- an app has a manifest id, not an ADT
// class). `Osd#services()` below tries the route first and falls back to
// ServiceSet on a 404, so this client works whether or not that route
// exists on the server it happens to be talking to (docs/vscode-extension.md,
// "forward-compatible expansion").

const SERVICE_GROUP_LABEL = {ODATA: "OData", APP: "Apps", ICF: "ICF", APC: "APC"};
const SERVICE_GROUP_ORDER = ["ODATA", "APP", "ICF", "APC"];

/** The group label for a service kind: the four named ones read as this
 *  tree's own words for them; any other kind the server starts returning
 *  (DAEMON, JOB, TRAN, ... -- docs/osd-status.mjs `servicesOf`'s own
 *  comment names them as coming) still gets a readable label instead of
 *  needing a code change first -- title case of the raw kind, the only
 *  guess this client can make about a word it has never seen. */
function serviceGroupLabel(kind) {
  if (SERVICE_GROUP_LABEL[kind] !== undefined) return SERVICE_GROUP_LABEL[kind];
  const word = String(kind ?? "");
  return word.length === 0 ? "Other" : word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** ZOSD_STATUS_SRV's own ServiceSet row (PascalCase, one of `d.results`)
 *  into the one shape every row below reads: `{kind, name, path, text,
 *  pack, handler, handlerUri, app, mpc, mpcUri, source}`. `HandlerName` is
 *  the manifest app id for an APP row (osd-status.mjs `appsOf`) and a
 *  class name for every other kind -- the same split the composing route
 *  makes explicit with its own `app` field, so an APP row here answers
 *  `app` and every other kind answers `handler`, never both. ServiceSet
 *  carries no ADT uri, no MPC and no source file, so those three stay
 *  undefined -- serviceClassNodes() below still finds a handler to show
 *  for every kind but APP, just with nowhere to click through to its
 *  source (extension.js falls back to a workspace glob by name). */
function normalizeServiceSetRow(row) {
  const kind = String(row?.Kind ?? "");
  const handlerName = row?.HandlerName === undefined || row.HandlerName === "" ? undefined : String(row.HandlerName);
  const pack = row?.Pack === undefined || row.Pack === "" ? undefined : String(row.Pack);
  return {
    kind, name: undefined, path: String(row?.Path ?? ""), text: String(row?.Text ?? ""), pack,
    handler: kind === "APP" ? undefined : handlerName,
    handlerUri: undefined,
    handlerSource: undefined,
    app: kind === "APP" ? handlerName : undefined,
    mpc: undefined, mpcUri: undefined, mpcSource: undefined, helpers: [], source: undefined,
  };
}

/** The composing route's own row (docs/ideas.md T8, `GET core/http/
 *  services`: `{kind, name, path, text, pack, handler, handlerUri, app,
 *  mpc, mpcUri, source}`) into the same shape -- already this shape, field
 *  for field, so this is only the defensive normalisation of an absent
 *  optional key into `undefined` rather than `null` or a missing property,
 *  the one thing a fixture and the real route are not promised to agree on
 *  byte for byte. */
function normalizeServiceRow(row) {
  const str = (v) => (v === undefined || v === null || v === "" ? undefined : String(v));
  return {
    kind: String(row?.kind ?? ""), name: str(row?.name),
    path: String(row?.path ?? ""), text: String(row?.text ?? ""), pack: str(row?.pack),
    handler: str(row?.handler), handlerUri: str(row?.handlerUri), handlerSource: str(row?.handlerSource),
    app: str(row?.app), mpc: str(row?.mpc), mpcUri: str(row?.mpcUri), mpcSource: str(row?.mpcSource),
    helpers: (row?.helpers ?? []).map((helper) => ({
      name: String(helper?.name ?? ""), role: String(helper?.role ?? "helper"),
      uri: str(helper?.uri), source: str(helper?.source),
    })).filter((helper) => helper.name !== ""),
    source: str(row?.source),
  };
}

/** Every normalized row grouped by kind: `SERVICE_GROUP_ORDER` first (so
 *  "OData (n)", "Apps (n)", "ICF (n)", "APC (n)" read in that order, the
 *  task's own words), then any kind the server returns that this client
 *  has never named, alphabetically -- "a generic group, so new kinds
 *  appear without code changes". Each group's own rows sorted by path,
 *  the way the flat list this replaces already read top to bottom. */
function uniqueServices(rows) {
  const byEndpoint = new Map();
  for (const row of rows ?? []) byEndpoint.set(`${row.kind}\n${String(row.path ?? "").replace(/\/+$/, "").toLowerCase()}`, row);
  return [...byEndpoint.values()];
}

function serviceTechnicalName(row) {
  if (row.kind === "ODATA") return row.name || String(row.path ?? "").replace(/\/+$/, "").split("/").pop() || row.handler || row.path;
  if (row.kind === "ICF" || row.kind === "APC") return row.handler || row.name || row.path;
  return row.name || row.app || row.handler || row.path;
}

function serviceLayer(row) {
  return row.layer || row.pack || "base";
}

function groupServices(rows, groupBy = "kind", sortBy = "name", hideBase = false) {
  const visible = uniqueServices(rows).filter((row) => !hideBase || serviceLayer(row) !== "base");
  const compare = (a, b) => {
    const value = (row) => sortBy === "path" ? row.path : sortBy === "description" ? row.text || serviceTechnicalName(row) : serviceTechnicalName(row);
    return String(value(a) ?? "").localeCompare(String(value(b) ?? "")) || String(a.path ?? "").localeCompare(String(b.path ?? ""));
  };
  if (groupBy === "layer") {
    const layers = new Map();
    for (const row of visible) {
      const layer = serviceLayer(row);
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(row);
    }
    const keys = [...layers.keys()].sort((a, b) => a === "base" ? -1 : b === "base" ? 1 : a.startsWith("workspace ") ? -1 : b.startsWith("workspace ") ? 1 : a.localeCompare(b));
    return keys.map((layer) => ({key: layer, label: layer, groupBy: "layer", groups: groupServices(layers.get(layer), "kind", sortBy)}));
  }
  const byKind = new Map();
  for (const row of visible) {
    const key = groupBy === "pack" ? (row.pack ?? "") : row.kind;
    const list = byKind.get(key) ?? [];
    list.push(row);
    byKind.set(key, list);
  }
  if (groupBy === "pack") {
    return [...byKind.keys()].sort((a, b) => (a || "Unpacked").localeCompare(b || "Unpacked")).map((pack) => ({
      key: pack, pack: pack || undefined, groupBy, label: pack || "Unpacked",
      rows: [...byKind.get(pack)].sort(compare),
    }));
  }
  const known = SERVICE_GROUP_ORDER.filter((k) => byKind.has(k));
  const rest = [...byKind.keys()].filter((k) => !SERVICE_GROUP_ORDER.includes(k)).sort();
  return [...known, ...rest].map((kind) => ({
    key: kind, kind, groupBy: "kind", label: serviceGroupLabel(kind),
    rows: [...byKind.get(kind)].sort(compare),
  }));
}

/** The label and the (dimmed, `TreeItem.description`) text a service row's
 *  own tree item shows: the server's own text first, falling back to the
 *  row's name or its path when a row carries no text at all -- the path
 *  always goes in `description`, never folded into the label itself. */
function serviceLabel(row, labelBy = "name") {
  const name = serviceTechnicalName(row);
  const description = row.text || name;
  return labelBy === "description"
    ? {label: description, description: name === description ? "" : name}
    : {label: name, description: description === name ? "" : description};
}

/** `osd-service-<kind>`, lower-cased -- one contextValue per kind so
 *  package.json's `view/item/context` menus can offer exactly the actions
 *  that kind supports (Copy URL everywhere, "Open $metadata" for OData
 *  only, "Copy ws:// URL" for APC only) without an enum this file and
 *  package.json would otherwise have to keep in lockstep by hand: a kind
 *  neither knows about gets a contextValue and simply matches no menu
 *  entry, rather than the provider needing to special-case it. */
function serviceContextValue(kind) {
  return `osd-service-${String(kind ?? "").toLowerCase()}`;
}

/** The context value also names only the actions whose targets exist for
 *  this row. VS Code's menu predicates match the semicolon-delimited flags. */
function serviceActionContext(row, capabilities = {}) {
  const flags = [];
  if (row?.path) flags.push("url");
  if (row?.kind === "ODATA" && row.path) flags.push("metadata");
  if (row?.kind === "APC" && row.path) flags.push("ws");
  if ((capabilities.testClasses ?? []).length > 0) flags.push("test");
  for (const role of ["dpc", "mpc", "handler", "app", "service"]) {
    if (capabilities.sources?.[role]?.path) flags.push(`source-${role}`);
  }
  // the taxi demo's sample data: generate a year, reset (osd.generateTaxiData)
  if (row?.name === "ZOSD_TAXI_SRV") flags.push("taxi-data");
  return [serviceContextValue(row?.kind), ...flags].join(";");
}

// ---- the taxi demo's sample data (ZOSD_TAXI_SRV): the two palette commands
// and the tree action ask what these say, so the words are the app's
// (webapp/taxi/i18n/i18n.properties)

/** the most recent year without rows, this year first */
function taxiDefaultYear(years = [], now = new Date()) {
  const loaded = new Set(years.map((y) => Number(y.Year)));
  let year = now.getFullYear();
  while (loaded.has(year) && year > 1900) year -= 1;
  return year;
}

/** what a reset would remove, as the question to ask; undefined when only
 *  rows that are not synthetic are loaded and there is nothing to remove */
function taxiResetPrompt(years = []) {
  if (years.length === 0) return undefined;
  const group = (n) => Number(n).toLocaleString("en-US").replace(/,/g, " ");
  const trips = years.reduce((n, y) => n + Number(y.Trips), 0);
  const rows = years.reduce((n, y) => n + Number(y.Rows), 0);
  return `Remove ${years.map((y) => y.Year).join(", ")} (${group(trips)} trips in ${group(rows)} rows)? Rows that are not synthetic stay.`;
}

function normalizeTransactionRow(row) {
  return {
    tcode: String(row?.tcode ?? ""), text: String(row?.text ?? ""),
    program: String(row?.program ?? ""), dynpro: String(row?.dynpro ?? ""),
    className: String(row?.className ?? ""), method: String(row?.method ?? ""),
    parameter: String(row?.parameter ?? ""),
    kind: String(row?.kind ?? ""), runnable: row?.runnable === true,
    reason: String(row?.reason ?? ""), source: String(row?.source ?? ""),
    package: String(row?.package ?? ""), layer: String(row?.layer ?? ""),
    programSource: String(row?.programSource ?? ""),
  };
}

/** The TRAN details content. `programSource` is supplied only after the
 *  extension has verified that the class or program file exists. */
function transactionDetailsModel(row, programSource) {
  const source = String(row?.source ?? "").replaceAll("\\", "/");
  const parts = source.split("/");
  const isPack = parts[0] === "packs" && parts.length > 2;
  const layer = isPack ? `Pack ${parts[1]}` : parts[0] === "gen" ? "Generated" : parts[0] === "src" ? "Project" : "Unknown";
  const packagePath = isPack ? parts.slice(2).join("/") : source;
  const parameterTarget = /^\/\*([^\s]+)/.exec(row?.parameter ?? "")?.[1];
  const target = row?.className || parameterTarget || row?.program || row?.parameter || "";
  const targetType = row?.className ? "Class" : parameterTarget || (!row?.program && row?.parameter) ? "Transaction" : "Program";
  const kind = row?.className ? "OO transaction" : row?.parameter ? "Parameter transaction"
    : row?.kind === "DYNPRO" || (row?.dynpro && row.dynpro !== "1000") ? "Dialog transaction" : "Report transaction";
  return {
    tcode: String(row?.tcode ?? ""), text: String(row?.text ?? ""), kind,
    target, targetType,
    package: row?.package || packageOf(packagePath) || "Unknown", layer: row?.layer || layer,
    programSource: programSource || undefined,
    runnable: row?.runnable === true, reason: String(row?.reason ?? ""),
  };
}

/** A second click on the same node within 400 ms runs it. Expired clicks
 *  are discarded, so the state stays small even as the tree changes. */
function classifyTransactionClick(previousByNode, node, at, threshold = 400) {
  const clicks = new Map([...previousByNode].filter(([, time]) => at >= time && at - time <= threshold));
  if (clicks.has(node)) {
    clicks.delete(node);
    return {action: "double", clicks};
  }
  clicks.set(node, at);
  return {action: "single", clicks};
}

function transactionDetailsHtml(details, nonce = "") {
  const esc = htmlEscape;
  const attr = htmlAttrEscape;
  const link = details.programSource
    ? `<button type="button" data-source="program">Go to program</button> <code>${esc(details.programSource)}</code>` : "";
  const script = `<script nonce="${attr(nonce)}">const vscode=acquireVsCodeApi();document.addEventListener("click",e=>{if(e.target.closest("[data-source=program]"))vscode.postMessage({command:"openSource",role:"program"});});</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${attr(nonce)}';"><style>
    body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:0 20px;max-width:1000px}h1{font-size:20px}section{border-top:1px solid var(--vscode-panel-border);padding:8px 0}button{color:var(--vscode-textLink-foreground);background:transparent;border:0;padding:0;text-decoration:underline;cursor:pointer}code{font-family:var(--vscode-editor-font-family)}.muted{color:var(--vscode-descriptionForeground)}
    </style></head><body><h1>${esc(details.tcode)}</h1><p>${esc(details.text)}</p>
    <section><p>Kind: ${esc(details.kind)}</p><p>${esc(details.targetType)}: <code>${esc(details.target || "n/a")}</code></p>
    <p>Package: ${esc(details.package)} · Layer: ${esc(details.layer)}</p><p>${link}</p>
    ${details.reason ? `<p class="muted">${esc(details.reason)}</p>` : ""}</section>${script}</body></html>`;
}

/** Read a UI5 manifest's identity and resolve each sap.app.dataSources URI
 *  to the OData inventory row with the same service path. */
function appManifestDetails(manifest, appRow, serviceRows = []) {
  const app = manifest?.["sap.app"] ?? {};
  const inbounds = app.crossNavigation?.inbounds ?? {};
  const intent = Object.keys(inbounds)[0];
  const dataSources = Object.entries(app.dataSources ?? {}).map(([key, value]) => {
    const uri = String(value?.uri ?? "");
    const match = /\/sap\/opu\/odata\/sap\/([^/?#]+)\/?/i.exec(uri);
    const serviceName = match?.[1]?.toUpperCase();
    const service = serviceRows.find((row) => {
      if (row.kind !== "ODATA") return false;
      const rowName = /\/sap\/opu\/odata\/sap\/([^/]+)/i.exec(row.path)?.[1]?.toUpperCase();
      return row.name?.toUpperCase() === serviceName || rowName === serviceName;
    });
    return {key, uri, service: service?.name};
  });
  return {
    id: String(app.id ?? appRow?.app ?? ""),
    title: String(app.title ?? appRow?.text ?? ""),
    intent,
    folder: String(appRow?.source ?? ""),
    dataSources,
  };
}

/** Tests from test/ and test/e2e whose source names a service URL. The
 *  extension supplies only those files, so this stays pure and fast to test. */
function httpTestFiles(files, servicePath, serviceName) {
  const pathNeedle = String(servicePath ?? "");
  const nameNeedle = String(serviceName ?? "");
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "(?=$|[/?#'\"`\\s])";
  const direct = pathNeedle ? new RegExp(`${escapeRegex(pathNeedle)}${boundary}`, "i") : undefined;
  const prefix = nameNeedle && pathNeedle.toUpperCase().endsWith(nameNeedle.toUpperCase())
    ? pathNeedle.slice(0, -nameNeedle.length) : undefined;
  const assembled = prefix
    ? new RegExp(`${escapeRegex(prefix)}[\"'\x60]\\s*\\+\\s*[\"'\x60]${escapeRegex(nameNeedle)}${boundary}`, "i") : undefined;
  return (files ?? []).filter((file) => {
    const content = String(file?.source ?? file?.content ?? "");
    return direct?.test(content) || assembled?.test(content);
  }).map((file) => String(file.path ?? "")).filter(Boolean).sort();
}

/** Unique ABAP Unit objects across DPC/MPC closures, in stable order. */
function closureTestNames(...closures) {
  return [...new Set(closures.flatMap((closure) => closure?.tests ?? []))].sort();
}

/** Only dumps whose mapped ABAP frames name this service's DPC or MPC. */
function dumpsForService(dumps, row) {
  const names = [row?.handler, row?.mpc].filter(Boolean).map((name) => name.toLowerCase());
  if (names.length === 0) return [];
  return (dumps ?? []).filter((dump) => (dump.frames ?? []).some((frame) => {
    const file = String(frame.file ?? "").toLowerCase();
    return names.some((name) => file.includes(name));
  }));
}

/** `baseUrl` (osd().url, no trailing slash) plus the row's own path --
 *  what an APP, an ICF node or an OData service document opens, in a
 *  browser or in the "open inside VS Code" webview alike. */
function serviceHttpUrl(row, baseUrl) {
  return `${baseUrl}${row.path}`;
}

/** The OData `$metadata` document beside the service document above --
 *  its own context-menu action rather than the click, because the service
 *  document is the more useful default and a person who wants the EDMX
 *  asks for it by name. */
function serviceMetadataUrl(row, baseUrl) {
  return `${serviceHttpUrl(row, baseUrl)}/$metadata`;
}

/** VS Code forwards localhost for Remote SSH, WSL and web workspaces. */
async function serviceMetadataExternalUrl(row, baseUrl, externalize) {
  const raw = serviceMetadataUrl(row, baseUrl);
  try {
    return String(await externalize(raw));
  } catch {
    return raw;
  }
}

/** The push channel's own `ws://` (or `wss://` over `https://`) URL --
 *  never opened by a click, since a WebSocket URL does nothing in a
 *  browser tab or a webview iframe (docs/vscode-extension.md, "Services
 *  tree"): only ever copied to the clipboard. */
function serviceWsUrl(row, baseUrl) {
  return serviceHttpUrl(row, baseUrl).replace(/^http/i, "ws");
}

/** The class nodes a service row expands to (docs/vscode-extension.md,
 *  "forward-compatible expansion"): the DPC then the MPC for an OData
 *  service (in that order, the way SEGW itself always names the pair),
 *  the one handler class for everything else that carries one (ICF, APC,
 *  and any future kind this client has never seen), and none for APP --
 *  an app has no ADT class of its own, only a manifest, which is why the
 *  normalisers above route its id to `row.app` rather than `row.handler`.
 *  `{role, name, uri}`: `uri` is the ADT class uri when the composing
 *  route answered one, `undefined` over ServiceSet (extension.js opens by
 *  a workspace glob on the name instead, the same way Q3's readers does). */
function serviceClassNodes(row) {
  const helpers = (row.helpers ?? []).map((helper) => ({role: helper.role, name: helper.name, uri: helper.uri, source: helper.source}));
  if (row.kind === "APP") return helpers;
  if (row.kind === "ODATA") {
    const out = [];
    if (row.handler) out.push({role: "dpc", name: row.handler, uri: row.handlerUri, source: row.handlerSource});
    if (row.mpc) out.push({role: "mpc", name: row.mpc, uri: row.mpcUri, source: row.mpcSource});
    return [...out, ...helpers];
  }
  return [...(row.handler ? [{role: "handler", name: row.handler, uri: row.handlerUri, source: row.handlerSource}] : []), ...helpers];
}

const htmlAttrEscape = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** One-based implementation line, excluding declarations and ABAP comments. */
function implementationMethodLine(source, name) {
  const wanted = String(name).toUpperCase();
  const lines = String(source ?? "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\*/.test(line)) continue;
    const match = /^\s*METHOD\s+(\S+)\s*\./i.exec(line);
    if (match && match[1].toUpperCase() === wanted) return i + 1;
  }
  return undefined;
}

function implementationMethodIndex(source) {
  const lines = new Map();
  String(source ?? "").split(/\r\n|\r|\n/).forEach((line, index) => {
    if (/^\s*\*/.test(line)) return;
    const match = /^\s*METHOD\s+(\S+)\s*\./i.exec(line);
    if (match && !lines.has(match[1].toUpperCase())) lines.set(match[1].toUpperCase(), index + 1);
  });
  return lines;
}

function methodLine(file, name) {
  return file?.methodLines
    ? file.methodLines.get(String(name).toUpperCase())
    : implementationMethodLine(file?.source, name);
}

/** The implementation selected by an EXT class, then its generated base. */
function resolveImplementationMethod(className, methodName, sources) {
  const ext = String(className ?? "").toUpperCase();
  const base = ext.replace(/_EXT$/, "");
  for (const owner of [...new Set([ext, base])]) {
    const file = sources?.[owner];
    const line = file && methodLine(file, methodName);
    if (line && file.path) return {owner, path: file.path, line};
  }
  return undefined;
}

function implementationMethodBody(source, name) {
  const lines = String(source ?? "").split(/\r\n|\r|\n/);
  const start = implementationMethodLine(source, name);
  if (!start) return "";
  const end = lines.findIndex((line, index) => index >= start && /^\s*ENDMETHOD\s*\./i.test(line));
  return lines.slice(start, end < 0 ? undefined : end).filter((line) => !/^\s*\*/.test(line)).join("\n");
}

const SET_OPERATIONS = ["GET_ENTITYSET", "GET_ENTITY", "CREATE_ENTITY", "UPDATE_ENTITY", "DELETE_ENTITY",
  "GET_EXPANDED_ENTITY", "GET_EXPANDED_ENTITYSET", "CREATE_DEEP_ENTITY", "GET_STREAM", "UPDATE_STREAM"];
const INTERFACE_OPERATIONS = new Set(SET_OPERATIONS.slice(5));

/** Pure service-card links from source files already found in the checkout. */
function serviceCardModel(row, sets = [], files = []) {
  const serviceName = row.name || /^\/sap\/opu\/odata\/sap\/([^/?#]+)/i.exec(String(row.path ?? ""))?.[1];
  const mpcName = row.mpc || String(row.handler ?? "").replace(/_DPC_EXT$/i, "_MPC_EXT");
  const layerRank = (file) => file.path.startsWith("src/") ? 0 : file.path.startsWith("gen/") ? 1 : 2;
  const ordered = [...files].sort((a, b) => layerRank(a) - layerRank(b) || a.path.localeCompare(b.path));
  const sameLayer = (file, anchor) => anchor && file.path.slice(0, file.path.lastIndexOf("/")) === anchor.slice(0, anchor.lastIndexOf("/"));
  const findFile = (name, anchor) => {
    if (!name) return undefined;
    const matches = ordered.filter((file) => path.basename(file.path).toLowerCase() === name.toLowerCase());
    return matches.find((file) => file.path === anchor) ?? matches.find((file) => sameLayer(file, anchor)) ??
      matches.find((file) => row.pack && (file.pack === row.pack || file.path.startsWith(`packs/${row.pack}/src/`))) ?? matches[0];
  };
  const cls = (name, anchor) => name && findFile(`${name.toLowerCase()}.clas.abap`, anchor);
  const link = (file, label, line) => file && ({label, path: file.path, line: line ?? 1});
  const method = (file, name, label = name) => {
    const line = file && methodLine(file, name);
    return line && link(file, label, line);
  };
  const indexed = (file) => file && {...file, methodLines: implementationMethodIndex(file.source)};
  const dpc = indexed(cls(row.handler, row.handlerSource));
  const dpcBase = indexed(cls(String(row.handler ?? "").replace(/_EXT$/i, ""), dpc?.path));
  const dpcSources = {[String(row.handler ?? "").toUpperCase()]: dpc};
  if (dpcBase && /_EXT$/i.test(row.handler ?? "")) {
    dpcSources[String(row.handler).replace(/_EXT$/i, "").toUpperCase()] = dpcBase;
  }
  const mpc = cls(mpcName, row.mpcSource ?? dpc?.path);
  const mpcBase = cls(String(mpcName ?? "").replace(/_EXT$/i, ""), mpc?.path ?? dpc?.path);
  const model = [method(mpcBase, "DEFINE", "MPC DEFINE"),
    /_EXT$/i.test(mpcName ?? "") && method(mpc, "DEFINE", "MPC_EXT DEFINE")].filter(Boolean);
  const ann = cls(String(mpcName ?? "").replace(/_MPC_EXT$/i, "_MPC_ANN"), mpc?.path);
  if (ann) model.push(method(ann, "DEFINE", "MPC_ANN DEFINE") ?? link(ann, "MPC_ANN"));
  const yaml = serviceName && ordered.find((f) => f.path.endsWith(".stg.yaml") && new RegExp(`^service:\\s*${String(serviceName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(f.source));
  if (yaml) model.push(link(yaml, ".stg.yaml", String(yaml.source).split(/\r\n|\r|\n/).findIndex((line) => /^service:\s*/i.test(line)) + 1));
  const iwpr = serviceName && ordered.find((f) => f.path.endsWith(".iwpr.xml") && f.source.toUpperCase().includes(String(serviceName).toUpperCase()));
  if (iwpr) model.push(link(iwpr, "IWPR"));
  const sadl = `${mpcBase?.source ?? ""}\n${dpc?.source ?? ""}`;
  const structures = new Map();
  for (const match of sadl.matchAll(/<sadl:structure\s+name="([^"]+)"\s+dataSource="([^"]+)"/gi)) {
    structures.set(`${match[1].toLowerCase()}set`, {set: `${match[1]}Set`, cds: match[2].toLowerCase()});
  }
  const knownSets = new Map(sets.map((set) => [String(set.set).toLowerCase(), set.set]));
  const setConstants = new Map();
  for (const match of String(mpcBase?.source ?? "").matchAll(/CONSTANTS\s+(\S+_set)\s+TYPE\s+\S*ty_e_med_entity_name\S*\s+VALUE\s+'([^']+)'/gi)) {
    setConstants.set(match[1].toLowerCase(), match[2].toLowerCase());
    if (!knownSets.has(match[2].toLowerCase())) knownSets.set(match[2].toLowerCase(), match[2]);
  }
  for (const [name, structure] of structures) if (!knownSets.has(name)) knownSets.set(name, structure.set);
  const mediaSets = new Set();
  for (const block of String(mpcBase?.source ?? "").matchAll(/^\s*METHOD\s+\S+\s*\.([\s\S]*?)^\s*ENDMETHOD\s*\./gim)) {
    if (!/->set_is_media\s*\(/i.test(block[1])) continue;
    const constant = /->create_entity_set\(\s*(\w+_set)\s*\)/i.exec(block[1])?.[1];
    const set = constant && setConstants.get(constant.toLowerCase());
    if (set) mediaSets.add(set);
  }
  const generic = [];
  const mappedOperations = new Map(sets.map((set) => [`${String(set.set).toLowerCase()}:${String(set.kind).toUpperCase()}`, set.method]));
  const interfaceTargets = new Map();
  for (const operation of INTERFACE_OPERATIONS) {
    const candidate = `/iwbep/if_mgw_appl_srv_runtime~${operation.toLowerCase()}`;
    const resolved = resolveImplementationMethod(row.handler, candidate, dpcSources);
    if (!resolved || resolved.owner !== String(row.handler).toUpperCase()) continue;
    const target = {label: `${operation} interface operation redefined (${resolved.path}:${resolved.line})`, path: resolved.path, line: resolved.line};
    const body = implementationMethodBody(dpc.source, candidate);
    const named = /\biv_entity_(?:set_)?name\b/i.test(body) ? [...knownSets.values()].filter((name) =>
      new RegExp(`'${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`, "i").test(body)) : [];
    if (named.length) interfaceTargets.set(operation, {target, named: new Set(named.map((name) => name.toLowerCase()))});
    else generic.push({...target, label: `${operation} interface operation generic (all sets) (${resolved.path}:${resolved.line})`});
  }
  const yamlEntity = (name) => {
    if (!yaml) return "";
    const blocks = yaml.source.split(/(?=^  [A-Za-z_][\w]*:\s*$)/m);
    return blocks.find((block) => new RegExp(`^    set:\\s*${name}\\s*$`, "im").test(block)) ?? "";
  };
  const entitySets = [...knownSets.values()].map((name) => {
    const prefix = String(name).toLowerCase();
    const entityYaml = yamlEntity(name);
    const operations = SET_OPERATIONS.map((operation) => {
      const candidate = INTERFACE_OPERATIONS.has(operation)
        ? `/iwbep/if_mgw_appl_srv_runtime~${operation.toLowerCase()}` : `${prefix}_${operation.toLowerCase()}`;
      const resolved = resolveImplementationMethod(row.handler,
        mappedOperations.get(`${prefix}:${operation}`) ?? candidate, dpcSources);
      const found = INTERFACE_OPERATIONS.has(operation) ?
        (interfaceTargets.get(operation)?.named.has(prefix) ? interfaceTargets.get(operation).target : undefined) :
        resolved?.owner === String(row.handler).toUpperCase()
          ? {label: `${operation} redefined (${resolved.path}:${resolved.line})`, path: resolved.path, line: resolved.line}
          : undefined;
      return {name: operation, link: found, inherited: !found};
    }).filter((operation) => !generic.some((target) => target.label.startsWith(`${operation.name} interface operation `)) &&
      (!["GET_STREAM", "UPDATE_STREAM"].includes(operation.name) ||
      /media:\s*true/i.test(entityYaml) || mediaSets.has(prefix)));
    const cds = structures.get(prefix)?.cds;
    const cdsFile = cds && findFile(`${cds}.ddls.asddls`, mpcBase?.path);
    let generated;
    if (cdsFile) {
      const sqlView = /@AbapCatalog\.sqlViewName\s*:\s*['"]([^'"]+)['"]/i.exec(cdsFile.source)?.[1];
      generated = sqlView && cls(`zcl_stg_cds_${sqlView}`);
    }
    const helps = files.filter((file) => file.path.endsWith(".shlp.xml") &&
      new RegExp(`searchhelp:\\s*${path.basename(file.path, ".shlp.xml")}\\b`, "i").test(entityYaml));
    const cdsLine = cdsFile && String(cdsFile.source).split(/\r\n|\r|\n/).findIndex((line) => /^\s*define\s+(?:view|entity)\s+/i.test(line)) + 1;
    return {set: name, operations, sources: [link(cdsFile, "CDS source", cdsLine || 1),
      generated && (method(generated, "zif_stg_cds_source~read", "Generated source class READ") ?? link(generated, "Generated source class")),
      ...helps.map((file) => link(file, "Search help"))].filter(Boolean)};
  });
  const actions = [...(yaml?.source.matchAll(/^  ([\w]+):\s*\n\s+method:\s*(?:GET|POST)/gm) ?? [])].map((m) => m[1]);
  if (!actions.length) for (const m of String(mpcBase?.source ?? "").matchAll(/create_action\(\s*'([^']+)'\s*\)/gi)) actions.push(m[1]);
  const actionMethod = "/iwbep/if_mgw_appl_srv_runtime~execute_action";
  const actionResolved = resolveImplementationMethod(row.handler, actionMethod, dpcSources);
  const actionLink = actionResolved?.owner === String(row.handler).toUpperCase()
    ? {label: `EXECUTE_ACTION function import redefined (${actionResolved.path}:${actionResolved.line})`, path: actionResolved.path, line: actionResolved.line} : undefined;
  const actionBody = implementationMethodBody(dpc?.source, actionMethod);
  const namedActions = actions.filter((name) => /\biv_action_name\b/i.test(actionBody) &&
    new RegExp(`'${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`, "i").test(actionBody));
  if (actionLink && !namedActions.length) generic.push({...actionLink,
    label: `EXECUTE_ACTION function import generic (all sets) (${actionLink.path}:${actionLink.line})`});
  const functionImports = [...new Set(actions)].map((name) => ({name,
    link: namedActions.includes(name) ? actionLink : undefined,
  }));
  return {model, entitySets, functionImports, generic};
}

function serviceDetailsHtml(details, nonce = "") {
  const row = details?.row ?? {};
  const esc = htmlEscape;
  const attr = htmlAttrEscape;
  const heading = serviceLabel(row, "description").label;
  const sourceButton = (role, label, source) => source?.path
    ? `<button type="button" data-source="${attr(role)}">${esc(label)}</button> <code>${esc(source.path)}</code>`
    : `<span class="muted">${esc(label)} source unavailable</span>`;
  const cardLink = (target) => target?.path
    ? `<button type="button" data-path="${attr(target.path)}" data-line="${attr(target.line ?? 1)}">${esc(target.label)}</button>`
    : "";
  const list = (items, render) => (items?.length ? `<ul>${items.map(render).join("")}</ul>` : `<p class="muted">None found</p>`);
  let body = `<h1>${esc(heading)}</h1><p class="muted">${esc(row.kind ?? "")} · ${esc(row.path ?? "")}${row.pack ? ` · ${esc(row.pack)}` : ""}</p>`;

  if (row.kind === "ODATA") {
    const metadataUrl = details.metadataUrl;
    const section = (role, title, name, source, readers, closure) => {
      if (!name) return "";
      const tests = closure?.tests ?? [];
      return `<section><h2>${esc(title)} ${esc(name)}</h2>${sourceButton(role, "Open source", source)}
        <p>Readers: ${readers?.counts?.readers ?? "n/a"} (${readers?.counts?.tests ?? 0} with tests, ${readers?.counts?.services ?? 0} services) ·
          Closure: ${closure?.counts?.objects ?? "n/a"} objects · ${closure?.counts?.tests ?? tests.length} tests</p>
        <p class="muted">ABAP Unit by reference</p>${list(tests, (test) => `<li><code>${esc(test)}</code></li>`)}</section>`;
    };
    body += `<section><h2>OData</h2><p>DPC: ${esc(row.handler ?? "n/a")}</p><p>MPC: ${esc(row.mpc ?? "n/a")}</p>
      <p><a href="#" data-metadata="default" title="${attr(metadataUrl ?? "")}">$metadata</a> · <a href="#" data-metadata="browser">in browser</a></p>
      ${details.entitySetsError ? `<p class="error">Entity sets: ${esc(details.entitySetsError)}</p>` : ""}
      <h3>Model sources</h3>${list(details.card?.model, (target) => `<li>${cardLink(target)}</li>`)}
      <h3>Entity sets</h3>${list(details.card?.entitySets ?? details.entitySets ?? [], (set) => `<li><code>${esc(set.set)}</code>
        ${set.sources?.length ? `<div>${set.sources.map(cardLink).join(" · ")}</div>` : ""}
        ${set.operations ? `<ul>${set.operations.map((op) => `<li>${op.link ? cardLink(op.link) : `${esc(op.name)}${INTERFACE_OPERATIONS.has(op.name) ? " interface operation" : ""} <span class="muted">inherited (generic)</span>`}</li>`).join("")}</ul>` : `<span class="muted">${esc(set.kind)}</span>`}</li>`)}
      <h3>Generic service methods</h3>${list(details.card?.generic, (target) => `<li>${cardLink(target)}</li>`)}
      <h3>Function imports</h3>${list(details.card?.functionImports, (action) => `<li>${esc(action.name)}: ${action.link ? cardLink(action.link) : `<span class="muted">EXECUTE_ACTION function import inherited (generic)</span>`}</li>`)}</section>`;
    body += section("dpc", "DPC", row.handler, details.sources?.dpc, details.readers?.dpc, details.closures?.dpc);
    body += section("mpc", "MPC", row.mpc, details.sources?.mpc, details.readers?.mpc, details.closures?.mpc);
    const warm = details.serving?.warm;
    body += `<section><h2>Runtime</h2><p>Generation: <code>${esc(details.serving?.generation ?? "unavailable")}</code> ·
      Warm: ${esc(warm?.state ?? "unavailable")}${warm?.reason ? ` (${esc(warm.reason)})` : ""}</p></section>`;
    body += `<section><h2>Short dumps naming this service</h2>${list(details.dumps ?? [], (dump) =>
      `<li>${esc(dump.at ?? "")} · ${esc(dump.name ?? "error")} · ${esc(dump.message ?? "")}</li>`)}</section>`;
    body += `<section><h2>HTTP tests by URL</h2>${list(details.httpTests ?? [], (file) => `<li><code>${esc(file)}</code></li>`)}</section>`;
  } else if (row.kind === "APP") {
    const app = details.app ?? {};
    body += `<section><h2>App</h2><p>Id: <code>${esc(app.id ?? "")}</code></p><p>Title: ${esc(app.title ?? "")}</p>
      <p>Intent: <code>${esc(app.intent ?? "n/a")}</code></p><p>Folder: ${sourceButton("app", "Open app folder", details.sources?.app)}</p>
      <h3>OData data sources</h3>${list(app.dataSources ?? [], (source) =>
        `<li><code>${esc(source.key)}</code>: ${source.service ? `uses <code>${esc(source.service)}</code>` : esc(source.uri)}</li>`)}</section>`;
  } else {
    const role = row.kind === "ICF" || row.kind === "APC" ? "handler" : undefined;
    const protocol = row.kind === "APC" ? "WebSocket (ws)" : "HTTP";
    body += `<section><h2>${esc(row.kind ?? "Service")}</h2><p>Protocol: ${esc(protocol)}</p><p>Path: <code>${esc(row.path ?? "")}</code></p>
      <p>Handler: <code>${esc(row.handler ?? "n/a")}</code></p>
      ${role ? sourceButton("handler", "Open handler source", details.sources?.handler) : ""}
      <p>Service declaration: ${sourceButton("service", row.kind === "APC" ? "Open SAPC source" : "Open SICF source", details.sources?.service)}</p></section>`;
  }

  const script = `<script nonce="${attr(nonce)}">const vscode=acquireVsCodeApi();document.addEventListener("click",e=>{const m=e.target.closest("[data-metadata]");if(m){e.preventDefault();vscode.postMessage({command:"openMetadata",where:m.dataset.metadata});return;}const b=e.target.closest("[data-path], [data-source]");if(!b)return;if(b.dataset.path)vscode.postMessage({command:"openCardPath",path:b.dataset.path,line:Number(b.dataset.line)});else vscode.postMessage({command:"openSource",role:b.dataset.source});});</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${attr(nonce)}';"><style>
    body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:0 20px;max-width:1000px}h1{font-size:20px}h2{font-size:16px;margin-bottom:8px}section{border-top:1px solid var(--vscode-panel-border);padding:8px 0}button{color:var(--vscode-textLink-foreground);background:transparent;border:0;padding:0;text-decoration:underline;cursor:pointer}a{color:var(--vscode-textLink-foreground)}code{font-family:var(--vscode-editor-font-family)}ul{margin-top:6px}.muted{color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}
    </style></head><body>${body}${script}</body></html>`;
}

module.exports = {osdRunCommandLine, unitRiskOf, unitDurationOf, unitSchedule, runUnitQueue, unitPoolSize, riskWarning, objectOf, adtObjectOf, uriOf, fileOf, Osd, abapFrame, outcomes, parseCheckReport, parseActivationResult, runActionFor, sameAbapSource, breakpointMatches,
  debuggerConfiguration, debugAttachPlan, runWithDebuggerAttach, breakpointToggleText,
  packSourceMappings, runningAbapSources, breakpointWarning, sourceKey,
  warmStatusText, activationBuildText, closureTestsText,
  entitySetMethodLines, entitySetLenses, methodAtLine, resultRows, stripMetadata, keyOf,
  readersLensLine, readersLensTitle, readersQuickPickItems, readerFilePattern,
  htmlEscape, freestyleRows, freestyleTableHtml, freestyleOutputItems, notebookAbapSource, amdpCellResult,
  notebookFromJson, notebookToJson, sqlNotebookStarter,
  HOTSPOTS_SQL, hotspotsFromRows, hotspotBucket, hotspotColor, hotspotBadge, hotspotHoverText,
  implementsClassrun,
  dataPreviewObjectOf, tablHasMandt, MANDT_CLIENT, dataPreviewQuery, dataPreviewCountQuery, dataPreviewStatusText, dataPreviewRows,
  dataPreviewAvailability, dataPreviewError,
  transpileLayers, classifyTestPath, PACKAGE_SPLIT_THRESHOLD, needsPackageSplit, packageDirsFrom, packageOf, hasTestMethods,
  demoFailureObjects,
  progTcodeOf, webguiTransactionUrl, webguiPanelHtml, runWebguiPanel, progRunLens,
  SERVICE_GROUP_ORDER, serviceGroupLabel, normalizeServiceSetRow, normalizeServiceRow, groupServices, serviceLabel, uniqueServices,
  serviceContextValue, serviceActionContext, normalizeTransactionRow, transactionDetailsModel, classifyTransactionClick,
  transactionDetailsHtml, appManifestDetails, httpTestFiles, closureTestNames, dumpsForService,
  implementationMethodLine, resolveImplementationMethod, serviceCardModel, serviceDetailsHtml, serviceHttpUrl, serviceMetadataUrl, serviceMetadataExternalUrl, serviceWsUrl, serviceClassNodes,
  PRESETS, presetSettings, isOpenSteamgateCheckout, osdHomeChoice, osdStateContext,
  SYSTEM_STATUS_SETS, odataV2Results, systemOverviewModel, taxiDefaultYear, taxiResetPrompt};
