// The VS Code extension's logic that needs no VS Code (editors/vscode/lib.js):
// which object a file is, where its includes live, and what a unit run's
// answer means per method. The live half, against a real server, is in
// test/osd-child.mjs.
import {expect} from "chai";
import {EventEmitter as NodeEventEmitter} from "node:events";
import express from "express";
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {checkReportDocument, activationSuccessDocument, activationFailureDocument, uriOf as facadeUriOf} from "../tools/adt-documents.mjs";
import {entitySetMapFor} from "../tools/segw-entityset-map.mjs";
import {adtRouter, tableDataDocument, countServiceRegistrations} from "../tools/adt-facade.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";

const {objectOf, adtObjectOf, uriOf, fileOf, Osd, outcomes, abapFrame, parseCheckReport, parseActivationResult, runActionFor, osdRunCommandLine,
  entitySetMethodLines, entitySetLenses, methodAtLine, resultRows, stripMetadata, keyOf,
  readersLensLine, readersLensTitle, readersQuickPickItems, readerFilePattern,
  htmlEscape, freestyleRows, freestyleTableHtml, freestyleOutputItems, notebookAbapSource, amdpCellResult,
  notebookFromJson, notebookToJson, sqlNotebookStarter,
  HOTSPOTS_SQL, hotspotsFromRows, hotspotBucket, hotspotColor, hotspotBadge, hotspotHoverText,
  implementsClassrun,
  dataPreviewObjectOf, tablHasMandt, MANDT_CLIENT, dataPreviewQuery, dataPreviewCountQuery, dataPreviewStatusText, dataPreviewRows,
  dataPreviewAvailability, dataPreviewError,
  transpileLayers, classifyTestPath, PACKAGE_SPLIT_THRESHOLD, needsPackageSplit, packageDirsFrom, packageOf, hasTestMethods,
  demoFailureObjects, progTcodeOf, webguiTransactionUrl, webguiPanelHtml, runWebguiPanel, progRunLens,
  SERVICE_GROUP_ORDER, serviceGroupLabel, normalizeServiceSetRow, normalizeServiceRow, groupServices, serviceLabel, uniqueServices,
  serviceContextValue, serviceActionContext, normalizeTransactionRow, appManifestDetails, httpTestFiles, closureTestNames,
  transactionDetailsModel, classifyTransactionClick, transactionDetailsHtml,
  dumpsForService, implementationMethodLine, serviceCardModel, serviceDetailsHtml, serviceHttpUrl, serviceMetadataUrl, serviceMetadataExternalUrl, serviceWsUrl, serviceClassNodes,
  warmStatusText, activationBuildText, closureTestsText,
  PRESETS, presetSettings, isOpenSteamgateCheckout, osdHomeChoice, osdStateContext, SYSTEM_STATUS_SETS,
  odataV2Results, systemOverviewModel, runningAbapSources, breakpointWarning, taxiDefaultYear, taxiResetPrompt,
  debuggerConfiguration, debugAttachPlan, runWithDebuggerAttach, breakpointToggleText} =
  createRequire(import.meta.url)("../editors/vscode/lib.js");
const {overviewStatusSection, systemOverviewHtml} = createRequire(import.meta.url)("../editors/vscode/system-overview.js");
import {implementsClassrun as facadeImplementsClassrun} from "../tools/osd-classrun.mjs";
import {namesOf as guiConvertNamesOf} from "../tools/osd-gui-convert.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Module = require("node:module");
const {Launcher} = require("../editors/vscode/launcher.js");
const ownedLauncher = {pid: 12345, launcherIdentity: "test-owned", ownsServing: Launcher.prototype.ownsServing};

function loadExtension(vscodeApi) {
  const extensionPath = require.resolve("../editors/vscode/extension.js");
  delete require.cache[extensionPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscodeApi;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(extensionPath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadSystemController(vscodeApi) {
  return loadExtension(vscodeApi).SystemController;
}

function loadTreeItems(vscodeApi) {
  const {OsdTreeProvider, TransactionItem} = loadExtension(vscodeApi);
  return {OsdTreeProvider, TransactionItem};
}

function vscodeStub(settings = {}) {
  class EventEmitter {
    listeners = new Set();
    event = (listener) => {
      this.listeners.add(listener);
      return {dispose: () => this.listeners.delete(listener)};
    };
    fire(value) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  }
  const panels = [];
  const externalUris = [];
  const externalOpens = [];
  const executedCommands = [];
  const sourceOpens = [];
  const sourceEditors = [];
  const workspaceFolderEvents = new EventEmitter();
  return {
    panels,
    externalUris,
    externalOpens,
    executedCommands,
    sourceOpens,
    sourceEditors,
    fireWorkspaceFoldersChanged: () => workspaceFolderEvents.fire(),
    EventEmitter,
    TreeItem,
    ThemeIcon,
    TreeItemCollapsibleState: {None: 0, Collapsed: 1, Expanded: 2},
    ViewColumn: {Beside: 2},
    ConfigurationTarget: {Workspace: 1, Global: 2},
    Uri: {parse: (value) => ({toString: () => value}), file: (fsPath) => ({fsPath})},
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Selection: class { constructor(start, end) { this.start = start; this.end = end; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    env: {asExternalUri: async (uri) => {
      externalUris.push(uri.toString());
      return uri;
    }, openExternal: async (uri) => { externalOpens.push(uri); }},
    commands: {executeCommand: async (...args) => { executedCommands.push(args); }},
    debug: {
      // no `sessions`: the stable VS Code API has none (it crashed on a Mac)
      onDidStartDebugSession: () => ({dispose() {}}),
      onDidTerminateDebugSession: () => ({dispose() {}}),
    },
    workspace: {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: workspaceFolderEvents.event,
      findFiles: async () => [{fsPath: "stub.clas.abap"}],
      openTextDocument: async (uri) => uri,
      getConfiguration: () => ({get: (name, fallback) => settings[name] ?? fallback, update: async () => {}}),
    },
    window: {
      createWebviewPanel: (...args) => {
        const disposeListeners = [];
        const panel = {
          args,
          webview: {html: "", onDidReceiveMessage: () => ({dispose() {}})},
          onDidDispose: (listener) => { disposeListeners.push(listener); return {dispose() {}}; },
          disposed: false,
          dispose() { this.disposed = true; for (const listener of disposeListeners) listener(); },
          reveal() {},
        };
        panels.push(panel);
        return panel;
      },
      showInformationMessage() {},
      showErrorMessage() {},
      showTextDocument: async (uri) => {
        sourceOpens.push(uri);
        const editor = {revealRange() {}};
        sourceEditors.push(editor);
        return editor;
      },
    },
  };
}

function controllerContext() {
  const saved = new Map();
  return {
    subscriptions: [],
    globalStorageUri: {fsPath: path.join(tmpdir(), "osd-controller-test")},
    extensionUri: {fsPath: path.join(tmpdir(), "osd-controller-test-no-bundle")},
    extension: {packageJSON: {version: "test"}},
    workspaceState: {get: (key) => saved.get(key), update: async (key, value) => { saved.set(key, value); }},
  };
}

describe("editors/vscode: the extension's logic", function () {
  it("registers .abap as a breakpoint-capable language in a fresh profile", () => {
    const {contributes} = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    expect(contributes.languages).to.deep.include({id: "abap", aliases: ["ABAP"], extensions: [".abap"]});
    expect(contributes.breakpoints).to.deep.include({language: "abap"});
    expect(contributes.debuggers ?? [], "Node attach uses VS Code's built-in debugger").to.deep.equal([]);
  });

  it("shows Check and Activate before Run and Debug for supported source objects", () => {
    const {contributes} = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    const menu = contributes.menus["editor/title"];
    expect(menu.map(({command}) => command)).to.deep.equal(["osd.check", "osd.activate", "osd.classrun", "osd.runTitle", "osd.runUnit", "osd.runWithDebugger"]);
    for (const [command, name] of [["osd.check", "check"], ["osd.activate", "activate"],
      ["osd.classrun", "run-console"], ["osd.runTitle", "run-console"],
      ["osd.run", "run-console"], ["osd.runUnit", "beaker"]]) {
      const {icon} = contributes.commands.find(row => row.command === command);
      expect(icon).to.deep.equal({light: `resources/icons/${name}-light.svg`, dark: `resources/icons/${name}-dark.svg`});
      for (const [theme, color] of [["light", "#424242"], ["dark", "#C5C5C5"]]) {
        const svg = readFileSync(path.join(ROOT, "editors/vscode", icon[theme]), "utf8");
        expect(svg).to.include('viewBox="0 0 16 16"').and.include('stroke-width="1"').and.include(`stroke="${color}"`);
        expect(svg).not.to.include("currentColor");
      }
    }
    for (const [command, title] of [["osd.check", "osd: Check (Ctrl+F2)"],
      ["osd.activate", "osd: Activate (Ctrl+F3)"]]) {
      expect(contributes.commands.find((row) => row.command === command)).to.include({title});
      const entry = menu.find((row) => row.command === command);
      expect(entry.when).to.include("!isWeb && !osd.web && resourceFilename =~ ");
      expect(entry.group).to.match(/^navigation@/);
      expect(Number(entry.group.split("@")[1])).to.be.lessThan(Number(menu[2].group.split("@")[1]));
      const literal = entry.when.slice(entry.when.indexOf("/"));
      const pattern = new RegExp(literal.slice(1, literal.lastIndexOf("/")), literal.slice(literal.lastIndexOf("/") + 1));
      for (const file of ["zcl_a.clas.abap", "zcl_a.clas.locals_def.abap", "zcl_a.clas.locals_imp.abap",
        "zcl_a.clas.macros.abap", "zcl_a.clas.testclasses.abap", "zif_a.intf.abap", "zprog.prog.abap", "ZCL_A.CLAS.ABAP"]) {
        expect(pattern.test(file), file).to.equal(adtObjectOf(file) !== undefined);
      }
      for (const file of ["readme.md", "plain.abap", "ztab.tabl.xml", "zview.ddls.asddls", "zview.ddls.xml", "zfg.fugr.abap"]) {
        expect(pattern.test(file), file).to.equal(false);
      }
    }
  });

  it("offers classrun and ABAP Unit independently on a class with tests", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "osd-title-"));
    try {
      const api = vscodeStub();
      const file = path.join(dir, "zcl_demo.clas.abap");
      writeFileSync(path.join(dir, "zcl_demo.clas.testclasses.abap"), "CLASS ltcl DEFINITION FOR TESTING. METHODS known_line FOR TESTING. ENDCLASS.");
      api.window.activeTextEditor = {document: {fileName: file, getText: () => "INTERFACES if_oo_adt_classrun."}};
      loadExtension(api).editorRunContext({subscriptions: []});
      expect(api.executedCommands).to.deep.include(["setContext", "osd.editorClassrun", true]);
      expect(api.executedCommands).to.deep.include(["setContext", "osd.editorTests", true]);
      const {contributes} = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
      expect(contributes.commands.find(c => c.command === "osd.classrun").title).to.equal("osd: Run classrun (F9)");
      expect(contributes.commands.find(c => c.command === "osd.runUnit")).to.include({title: "osd: Run ABAP Unit (Ctrl+Shift+F10)"});
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("names desktop output channels consistently and explains their contents first", () => {
    const api = vscodeStub(), channels = [];
    api.window.createOutputChannel = name => {
      const channel = {name, lines: [], appendLine(line) { this.lines.push(line); }, dispose() {}};
      channels.push(channel);
      return channel;
    };
    const context = {subscriptions: []};
    loadExtension(api).desktopOutputs(context);
    expect(channels.map(c => c.name)).to.deep.equal(["OSD", "OSD: Console", "OSD: System log"]);
    expect(channels.map(c => c.lines[0])).to.deep.equal([
      "OSD: extension diagnostics and command/debugger activity.",
      "OSD: Console: classrun (F9/▷) output and Check/Activate results.",
      "OSD: System log: server builds, runtime and debugger attachment diagnostics.",
    ]);
    expect(context.subscriptions).to.deep.equal(channels);
  });

  it("writes check and activation results to OSD: Console and keeps status feedback", async () => {
    let issues = [];
    const app = express();
    app.head("/sap/bc/adt/core/discovery", (_req, res) => res.set("x-csrf-token", "test-token").end());
    app.post("/sap/bc/adt/checkruns", (_req, res) => res.type("application/xml").send(
      checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_a", issues}])));
    app.post("/sap/bc/adt/activation", (_req, res) => res.set({"x-osd-generation": "123456789abcdef", "x-osd-build": "warm", "x-osd-swap-ms": "12"})
      .type("application/xml").send(activationSuccessDocument()));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const api = vscodeStub({url: `http://127.0.0.1:${server.address().port}`});
      const handlers = new Map(), lines = [], statuses = [], errors = [], general = [], shows = [];
      api.commands.registerCommand = (name, handler) => { handlers.set(name, handler); return {dispose() {}}; };
      api.languages = {createDiagnosticCollection: () => ({set() {}, dispose() {}})};
      api.DiagnosticSeverity = {Error: 0, Warning: 1, Information: 2};
      api.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, {range, message, severity}); } };
      api.Position = class {
        constructor(line, character) { Object.assign(this, {line, character}); }
        translate(line, character) { return new api.Position(this.line + line, this.character + character); }
      };
      const file = "/project/zcl_a.clas.abap";
      api.window.activeTextEditor = {document: {fileName: file, uri: api.Uri.file(file), isDirty: false, getText: () => ""}};
      api.window.setStatusBarMessage = (...args) => statuses.push(args);
      api.window.showErrorMessage = (message) => errors.push(message);
      loadExtension(api).registerCheckActivateCommands({subscriptions: []}, {appendLine: (line) => general.push(line)},
        {appendLine: (line) => lines.push(line), show: (preserveFocus) => shows.push(preserveFocus)});
      await handlers.get("osd.check")();
      issues = [{severity: "W", message: "unused variable", line: 1, column: 1}];
      await handlers.get("osd.check")();
      issues = [];
      await handlers.get("osd.activate")();
      expect(lines).to.deep.equal(["osd check ZCL_A: no findings", "osd check ZCL_A: 1 findings",
        "osd activate ZCL_A: activated, generation 12345678 (hot-swapped in 12 ms (warm))"]);
      expect(statuses).to.have.lengthOf(3);
      expect(statuses.every(([, duration]) => duration === 5000)).to.equal(true);
      expect(shows).to.deep.equal([true, true, true]);
      expect(errors).to.deep.equal([]);
      expect(general).to.deep.equal([]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it("warns before classrun sends a dirty editor's run, and stays quiet for clean or unrelated editors", async () => {
    const api = vscodeStub();
    const file = "/project/zcl_a.clas.abap";
    const document = {fileName: file, isDirty: true};
    api.window.activeTextEditor = {document};
    const {classrunObject} = loadExtension(api);
    const lines = [];
    const output = {show() {}, appendLine: (line) => lines.push(line)};
    const warning = "osd: running the active version; your editor changes are not activated yet (Ctrl+F3)";
    const options = {client: () => ({classrun: async () => {
      expect(lines[0]).to.equal(document.isDirty && document.fileName === file ? warning : "--- classrun ZCL_A ---");
      return {text: "hello", ms: 1};
    }})};
    await classrunObject("ZCL_A", output, false, file, options);
    expect(lines.filter((line) => line === warning)).to.have.lengthOf(1);
    document.isDirty = false;
    lines.length = 0;
    await classrunObject("ZCL_A", output, false, file, options);
    expect(lines).not.to.include(warning);
    document.isDirty = true;
    document.fileName = "/project/zcl_b.clas.abap";
    lines.length = 0;
    await classrunObject("ZCL_A", output, false, file, options);
    expect(lines).not.to.include(warning);
  });

  it("compares saved source with the active ADT include before F9, falling back when unavailable", async () => {
    const api = vscodeStub();
    const file = "/project/zcl_a.clas.abap", lines = [], requests = [];
    let active = "old", unavailable = false, status = 200;
    api.window.activeTextEditor = {document: {fileName: file, isDirty: false, getText: () => "new\r\n"}};
    const client = new Osd("http://local", async (url, options) => {
      requests.push([url, options]);
      if (unavailable) throw Error("timeout");
      return {ok: status === 200, status, statusText: "Not Found", text: async () => active};
    });
    client.classrun = async () => ({text: "ok", ms: 1});
    const run = () => loadExtension(api).classrunObject("ZCL_A", {show() {}, appendLine: line => lines.push(line)},
      false, file, {client: () => client, controller: {launcher: {state: "running"}}});
    await run();
    expect(lines[0]).to.include("editor changes are not activated");
    expect(requests[0][0]).to.equal("http://local/sap/bc/adt/oo/classes/zcl_a/source/main?version=active");
    expect(requests[0][1].signal).to.be.instanceOf(AbortSignal);
    active = "new\n"; lines.length = 0;
    await run();
    expect(lines[0]).to.equal("--- classrun ZCL_A ---");
    unavailable = true; lines.length = 0;
    await run();
    expect(lines[0]).to.equal("--- classrun ZCL_A ---");
    // A successful empty read is proven active source and must be compared.
    unavailable = false; active = ""; lines.length = 0;
    await run();
    expect(lines[0]).to.include("editor changes are not activated");
    status = 404; lines.length = 0;
    await run();
    expect(lines[0]).to.equal("--- classrun ZCL_A ---");
  });

  it("normalizes active-source CRLF and terminal newlines for main source and includes", async () => {
    const api = vscodeStub();
    const {classrunObject} = loadExtension(api);
    for (const [suffix, include] of [["abap", "main"], ["locals_imp.abap", "implementations"]]) {
      const file = `/project/zcl_a.clas.${suffix}`;
      for (const [active, saved] of [["same", "same\r\n"], ["same\r\n\r\n", "same"],
        ["one\r\ntwo\r\n", "one\ntwo\n\n"], ["same", "changed\n"], ["", "changed\n"], ["", ""], [" \n", "changed\n"]]) {
        const lines = [], requests = [];
        api.window.activeTextEditor = {document: {fileName: file, isDirty: false, getText: () => saved}};
        const client = new Osd("http://local", async url => {
          requests.push(url);
          return {ok: true, text: async () => active};
        });
        client.classrun = async () => ({text: "ok", ms: 1});
        await classrunObject("ZCL_A", {show() {}, appendLine: line => lines.push(line)}, false, file,
          {client: () => client, controller: {launcher: {state: "running"}}});
        expect(requests).to.deep.equal([`http://local/sap/bc/adt/oo/classes/zcl_a/${include === "main" ? "source/main" : "includes/implementations/source/main"}?version=active`]);
        expect(lines.some(line => line.includes("not activated")), `${suffix}: ${JSON.stringify([active, saved])}`)
          .to.equal(saved.startsWith("changed"));
      }
    }
  });

  it("skips the active-source comparison when serving availability is unknown or stopped", async () => {
    const api = vscodeStub(), file = "/project/zcl_a.clas.abap";
    api.window.activeTextEditor = {document: {fileName: file, isDirty: false, getText: () => "same"}};
    const {classrunObject} = loadExtension(api);
    for (const state of [undefined, "stopped", "starting", "failed", "running"]) {
      let comparisons = 0, runs = 0;
      const client = {activeSource: async () => { comparisons++; return "same"; },
        classrun: async () => { runs++; return {text: "ok", ms: 1}; }};
      await classrunObject("ZCL_A", {show() {}, appendLine() {}}, false, file,
        {client: () => client, controller: state === undefined ? undefined : {launcher: {state}}});
      expect(comparisons, String(state)).to.equal(state === "running" ? 1 : 0);
      expect(runs).to.equal(1);
    }
  });

  it("compares active source for an independently running system after a successful serving poll", async () => {
    const api = vscodeStub(), file = "/project/zcl_a.clas.abap";
    api.window.activeTextEditor = {document: {fileName: file, isDirty: false, getText: () => "same"}};
    api.StatusBarAlignment = {Left: 1};
    api.window.createStatusBarItem = () => ({show() {}, hide() {}, dispose() {}});
    const {statusBar, classrunObject} = loadExtension(api);
    const context = {subscriptions: []};
    const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval;
    let tick, comparisons = 0;
    try {
      globalThis.fetch = async url => ({ok: true, json: async () =>
        String(url).endsWith("/osd/serving") ? {generation: "external", ready: true} : []});
      globalThis.setInterval = fn => { tick = fn; return undefined; };
      statusBar(context, () => 0);
      await tick();
      await classrunObject("ZCL_A", {show() {}, appendLine() {}}, false, file, {client: () => ({
        activeSource: async () => { comparisons++; return "same"; },
        classrun: async () => ({text: "ok", ms: 1}),
      })});
      expect(comparisons).to.equal(1);
    } finally {
      context.subscriptions.forEach(subscription => subscription.dispose());
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalInterval;
    }
  });

  it("uses paused debug state for ABAP run and stepping keys", () => {
    const bindings = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8")).contributes.keybindings;
    for (const [key, command] of [["f8", "osd.run"], ["f9", "osd.classrun"]]) {
      const binding = bindings.find((row) => row.key === key && row.command === command);
      expect(binding?.when).to.include("debugState != 'stopped'");
      expect(binding.when).not.to.include("inDebugMode");
    }
    for (const [key, command] of [["f5", "workbench.action.debug.stepInto"],
      ["f6", "workbench.action.debug.stepOver"], ["f7", "workbench.action.debug.stepOut"],
      ["f8", "workbench.action.debug.continue"]]) {
      const binding = bindings.find((row) => row.key === key && row.command === command);
      expect(binding?.when).to.include("debugState == 'stopped'");
      expect(binding.when).not.to.include("inDebugMode");
    }
  });

  it("builds the attach profile and keeps a supervised restart on one debugger session", () => {
    const config = debuggerConfiguration(9341);
    expect(config).to.include({name: "OSD: ABAP (9341)", type: "node", request: "attach", address: "127.0.0.1", port: 9341, restart: true, timeout: 30000});
    // Maps are read from the whole build: the serving process can run a
    // generation other than the live one (docs/debugging-abap.md).
    expect(config.resolveSourceMapLocations).to.deep.equal(["${workspaceFolder}/build/**", "!**/node_modules/**"]);
    expect(config.outFiles).to.deep.equal(["${workspaceFolder}/build/live/output/**/*.mjs"]);
    expect(config.pauseForSourceMap).to.equal(true);
    expect(config.skipFiles).to.include("<node_internals>/**");
    const userSkips = ["**/custom/**", "<node_internals>/**"];
    for (const target of ["system", "unit"]) {
      const merged = debuggerConfiguration(9342, {target, skipFiles: userSkips});
      expect(merged.skipFiles).to.deep.equal(["**/custom/**", "<node_internals>/**", "${workspaceFolder}/node_modules/@abaplint/runtime/**"]);
    }
    expect(userSkips).to.deep.equal(["**/custom/**", "<node_internals>/**"]);
    expect(debuggerConfiguration(9342, {target: "unit", restart: false}))
      .to.include({name: "OSD: ABAP Unit (9342)", restart: false, continueOnAttach: true});
    const externalRoot = debuggerConfiguration(9343, {root: "C:\\workspace\\osd"});
    expect(externalRoot.outFiles).to.deep.equal(["C:/workspace/osd/build/live/output/**/*.mjs"]);
    expect(externalRoot.skipFiles).to.include("C:/workspace/osd/node_modules/@abaplint/runtime/**");
    expect(() => debuggerConfiguration(0)).to.throw(/invalid inspector port/);

    const home = mkdtempSync(path.join(tmpdir(), "osd-debug-generation-"));
    try {
      const build = path.join(home, "build");
      const first = path.join(build, "by-input", "first", "output");
      const second = path.join(build, "by-input", "second", "output");
      mkdirSync(first, {recursive: true});
      mkdirSync(second, {recursive: true});
      symlinkSync(path.dirname(first), path.join(build, "live"), "dir");
      symlinkSync(first, path.join(home, "output"), "dir");
      expect(debuggerConfiguration(9341, {root: home}).outFiles).to.deep.equal([`${first}/**/*.mjs`]);
      rmSync(path.join(build, "live"));
      symlinkSync(path.dirname(second), path.join(build, "live"), "dir");
      rmSync(path.join(home, "output"));
      symlinkSync(second, path.join(home, "output"), "dir");
      const swapped = debuggerConfiguration(9341, {root: home});
      expect(swapped.outFiles).to.deep.equal([`${second}/**/*.mjs`]);
      expect(swapped.resolveSourceMapLocations).to.deep.equal(
        [...new Set([`${build}/**`, `${realpathSync(build)}/**`]), "!**/node_modules/**"]);
    } finally {
      rmSync(home, {recursive: true, force: true});
    }

    const first = debugAttachPlan({}, {type: "system-started", enabled: true, port: 9341});
    expect(first.actions).to.deep.equal([{type: "attach", target: "system", port: 9341, restart: true}]);
    const attached = debugAttachPlan(first.state, {type: "system-attached", port: 9341});
    const recycled = debugAttachPlan(attached.state, {type: "system-started", enabled: true, port: 9341});
    expect(recycled.actions).to.deep.equal([]);
    expect(recycled.state).to.equal(attached.state);
    const stopped = debugAttachPlan(recycled.state, {type: "system-stopped"});
    expect(stopped.actions).to.deep.equal([{type: "stop", target: "system", port: 9341}]);
    const restarted = debugAttachPlan(stopped.state, {type: "system-started", enabled: true, port: 9341});
    expect(restarted.actions).to.deep.equal([{type: "attach", target: "system", port: 9341, restart: true}]);
    expect(debugAttachPlan(restarted.state, {type: "unit-started", port: 9342}).actions)
      .to.deep.equal([{type: "attach", target: "unit", port: 9342, restart: false}]);
    expect(breakpointToggleText()).to.equal("$(debug) Toggle ABAP breakpoints");
  });

  it("retries a failed attach and a manually closed system session", () => {
    const pending = debugAttachPlan({}, {type: "system-started", enabled: true, port: 9341});
    expect(pending.state.systemPort).to.equal(undefined);
    expect(debugAttachPlan(pending.state, {type: "system-started", enabled: true, port: 9341}).actions)
      .to.deep.equal(pending.actions);
    const attached = debugAttachPlan(pending.state, {type: "system-attached", port: 9341});
    expect(attached.state.systemPort).to.equal(9341);
    const closed = debugAttachPlan(attached.state, {type: "system-session-ended", port: 9341});
    expect(closed.state.systemPort).to.equal(undefined);
    expect(debugAttachPlan(attached.state, {type: "system-session-ended", port: 9342}).state)
      .to.equal(attached.state);
    expect(debugAttachPlan(closed.state, {type: "system-started", enabled: true, port: 9341}).actions)
      .to.deep.equal(pending.actions);
  });

  it("propagates attach failure to the debug run and aborts its paused child request", async () => {
    for (const failure of [false, new Error("attach rejected")]) {
      let requestSignal;
      const execute = (signal) => new Promise((resolve, reject) => {
        requestSignal = signal;
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {once: true});
      });
      const attach = () => failure === false ? false : Promise.reject(failure);
      try {
        await runWithDebuggerAttach(attach, execute);
        throw new Error("expected attach failure");
      } catch (error) {
        expect(error.message).to.equal(failure === false
          ? "VS Code could not attach to the ABAP Unit child" : "attach rejected");
      }
      expect(requestSignal.aborted).to.equal(true);
    }
  });

  it("aborts an active debug request when Test Explorer cancels the run", async () => {
    let cancel;
    let disposed = false;
    let requestSignal;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener) {
        cancel = () => {
          this.isCancellationRequested = true;
          listener();
        };
        return {dispose: () => { disposed = true; }};
      },
    };
    const execute = (signal) => new Promise((resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("request aborted")), {once: true});
    });
    const run = runWithDebuggerAttach(() => true, execute, token);
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestSignal.aborted).to.equal(false);
    cancel();
    try {
      await run;
      throw new Error("expected cancelled request");
    } catch (error) {
      expect(error.message).to.equal("request aborted");
    }
    expect(requestSignal.aborted).to.equal(true);
    expect(disposed).to.equal(true);
  });

  it("stops a multi-method debug run before attaching the next selection after cancellation", async () => {
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const source = path.join(ROOT, "src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap");
    api.Uri.file = (fsPath) => ({fsPath});
    api.Range = class {
      constructor() {}
    };
    api.TestMessage = class {
      constructor(message) { this.message = message; }
    };
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    api.workspace.findFiles = async () => [api.Uri.file(source)];
    api.workspace.getWorkspaceFolder = () => ({uri: api.Uri.file(ROOT)});
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange() {}, dispose() {}});
    api.commands = {registerCommand: () => ({dispose() {}})};
    const collection = (parent) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        get: (id) => items.get(id),
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator](),
      };
    };
    const profiles = new Map();
    const events = [];
    const controller = {
      items: collection(undefined),
      createTestItem(id, label, uri) {
        const item = {id, label, uri};
        item.children = collection(item);
        return item;
      },
      createRunProfile(name, kind, handler) { profiles.set(name, handler); },
      createTestRun() {
        return Object.fromEntries(["started", "passed", "failed", "skipped", "errored", "appendOutput", "end"]
          .map((name) => [name, (item) => events.push([name, item?.id])]));
      },
      dispose() {},
    };
    api.tests = {createTestController: () => controller};
    const {testExplorer} = loadExtension(api);
    const originalDiscover = Osd.prototype.discover;
    const originalRun = Osd.prototype.run;
    const runs = [];
    const attaches = [];
    const cancellationToken = () => {
      const listeners = new Set();
      return {
        isCancellationRequested: false,
        get listenerCount() { return listeners.size; },
        onCancellationRequested(listener) {
          listeners.add(listener);
          return {dispose: () => listeners.delete(listener)};
        },
        cancel() {
          this.isCancellationRequested = true;
          for (const listener of listeners) listener();
        },
      };
    };
    let token = cancellationToken();
    let pickPort = async () => 9341;
    Osd.prototype.discover = async () => ({classes: [{name: "LTCL_SCAN", include: "testclasses", line: 1,
      methods: [{name: "FIRST", line: 2}, {name: "SECOND", line: 3}]}]});
    Osd.prototype.run = (object, testClass, method, dbEnv, inspectPort, waitForDebugger, signal) => {
      runs.push({method, inspectPort, waitForDebugger});
      if (signal.aborted) return Promise.reject(new Error("request aborted"));
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {once: true});
        setImmediate(() => token.cancel());
      });
    };
    let explorer;
    try {
      explorer = testExplorer(controllerContext(), {appendLine() {}}, {
        attachUnitDebugger: (event) => {
          attaches.push(event);
          return true;
        },
        pickUnitInspectorPort: () => pickPort(),
      });
      await controller.resolveHandler();
      const object = controller.items.get("group:project").children.get("CLAS:ZCL_OSD_ABAP_TOKENS");
      expect(object).not.to.equal(undefined);
      await controller.resolveHandler(object);
      const methods = [...object.children.get("CLAS:ZCL_OSD_ABAP_TOKENS/LTCL_SCAN").children].map(([, item]) => item);
      await profiles.get("Debug")({include: methods}, token);
      expect(runs).to.have.lengthOf(1);
      expect(runs[0]).to.include({method: "FIRST", inspectPort: 9341, waitForDebugger: true});
      expect(attaches).to.have.lengthOf(1);
      expect(attaches[0]).to.include({type: "unit-started", port: runs[0].inspectPort});
      expect(events.filter(([name]) => name === "started").map(([, id]) => id)).to.deep.equal([methods[0].id]);
      expect(events.filter(([name]) => name === "errored").map(([, id]) => id)).to.deep.equal([methods[0].id]);
      expect(events.at(-1)[0]).to.equal("end");
      expect(token.listenerCount).to.equal(0);

      token = cancellationToken();
      pickPort = async () => {
        token.cancel();
        return 9342;
      };
      runs.length = 0;
      attaches.length = 0;
      events.length = 0;
      await profiles.get("Debug")({include: methods}, token);
      expect(runs).to.have.lengthOf(0);
      expect(attaches).to.have.lengthOf(0);
      expect(events.filter(([name]) => name === "started").map(([, id]) => id)).to.deep.equal([methods[0].id]);
      expect(events.filter(([name]) => name === "skipped").map(([, id]) => id)).to.deep.equal([methods[0].id]);
      expect(events.at(-1)[0]).to.equal("end");
    } finally {
      explorer?.dispose();
      Osd.prototype.discover = originalDiscover;
      Osd.prototype.run = originalRun;
    }
  });

  it("Cancel reaches an ordinary (non-debug) run: the request gets a signal and it is aborted", async () => {
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const source = path.join(ROOT, "src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap");
    api.Uri.file = (fsPath) => ({fsPath});
    api.Range = class { constructor() {} };
    api.TestMessage = class { constructor(message) { this.message = message; } };
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    api.workspace.findFiles = async () => [api.Uri.file(source)];
    api.workspace.getWorkspaceFolder = () => ({uri: api.Uri.file(ROOT)});
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange() {}, dispose() {}});
    api.commands = {registerCommand: () => ({dispose() {}})};
    const collection = (parent) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        get: (id) => items.get(id),
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator](),
      };
    };
    const profiles = new Map();
    const events = [];
    const controller = {
      items: collection(undefined),
      createTestItem(id, label, uri) {
        const item = {id, label, uri};
        item.children = collection(item);
        return item;
      },
      createRunProfile(name, kind, handler) { profiles.set(name, handler); },
      createTestRun() {
        return Object.fromEntries(["started", "passed", "failed", "skipped", "errored", "appendOutput", "end"]
          .map((name) => [name, (item) => events.push([name, item?.id])]));
      },
      dispose() {},
    };
    api.tests = {createTestController: () => controller};
    const {testExplorer} = loadExtension(api);
    const originalDiscover = Osd.prototype.discover;
    const originalRun = Osd.prototype.run;
    const listeners = new Set();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener) { listeners.add(listener); return {dispose: () => listeners.delete(listener)}; },
      cancel() { this.isCancellationRequested = true; for (const listener of listeners) listener(); },
    };
    const signals = [];
    Osd.prototype.discover = async () => ({classes: [{name: "LTCL_SCAN", include: "testclasses", line: 1, schedule: "harmless",
      methods: [{name: "FIRST", line: 2}]}]});
    Osd.prototype.run = (object, testClass, method, dbEnv, inspectPort, waitForDebugger, signal) => {
      signals.push(signal);
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("request aborted")), {once: true});
        setImmediate(() => token.cancel());
      });
    };
    let explorer;
    try {
      explorer = testExplorer(controllerContext(), {appendLine() {}}, {});
      await controller.resolveHandler();
      const object = controller.items.get("group:project").children.get("CLAS:ZCL_OSD_ABAP_TOKENS");
      await controller.resolveHandler(object);
      const methods = [...object.children.get("CLAS:ZCL_OSD_ABAP_TOKENS/LTCL_SCAN").children].map(([, item]) => item);
      await Promise.race([profiles.get("Run")({include: methods}, token),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error("the run waited for the request it cancelled")), 3000))]);
      expect(signals).to.have.length(1);
      expect(signals[0], "an ordinary run passes a signal").to.be.instanceOf(AbortSignal);
      expect(signals[0].aborted, "and Cancel aborts it").to.equal(true);
      expect(events.filter(([name]) => name === "errored").map(([, id]) => id)).to.deep.equal([methods[0].id]);
      expect(listeners.size, "the cancellation listener is removed").to.equal(0);
    } finally {
      explorer?.dispose();
      Osd.prototype.discover = originalDiscover;
      Osd.prototype.run = originalRun;
    }
  });

  it("keeps running TestItems stable when an activation save triggers rediscovery", async () => {
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const source = path.join(ROOT, "src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap");
    api.Uri.file = (fsPath) => ({fsPath});
    api.Range = class { constructor() {} };
    api.TestMessage = class { constructor(message) { this.message = message; } };
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    api.workspace.findFiles = async () => [api.Uri.file(source)];
    api.workspace.getWorkspaceFolder = () => ({uri: api.Uri.file(ROOT)});
    let changed;
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange(fn) { changed = fn; }, dispose() {}});
    api.commands = {registerCommand: () => ({dispose() {}})};
    const collection = (parent) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        get: (id) => items.get(id),
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator](),
      };
    };
    const profiles = new Map();
    const events = [];
    const controller = {
      items: collection(undefined),
      createTestItem(id, label, uri) {
        const item = {id, label, uri};
        item.children = collection(item);
        return item;
      },
      createRunProfile(name, kind, handler) { profiles.set(name, handler); },
      createTestRun() {
        return Object.fromEntries(["started", "passed", "failed", "skipped", "errored", "appendOutput", "end"]
          .map((name) => [name, (item) => events.push([name, item?.id])]));
      },
      dispose() {},
    };
    api.tests = {createTestController: () => controller};
    const {testExplorer} = loadExtension(api);
    const originalDiscover = Osd.prototype.discover;
    const originalRun = Osd.prototype.run;
    const listeners = new Set();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener) { listeners.add(listener); return {dispose: () => listeners.delete(listener)}; },
      cancel() { this.isCancellationRequested = true; for (const listener of listeners) listener(); },
    };
    const signals = [];
    Osd.prototype.discover = async () => ({classes: [{name: "LTCL_SCAN", include: "testclasses", line: 1, schedule: "harmless",
      methods: [{name: "FIRST", line: 2}]}]});
    let finish;
    Osd.prototype.run = () => new Promise(resolve => { finish = resolve; });
    let explorer;
    try {
      explorer = testExplorer(controllerContext(), {appendLine() {}}, {});
      await controller.resolveHandler();
      const object = controller.items.get("group:project").children.get("CLAS:ZCL_OSD_ABAP_TOKENS");
      await controller.resolveHandler(object);
      const methods = [...object.children.get("CLAS:ZCL_OSD_ABAP_TOKENS/LTCL_SCAN").children].map(([, item]) => item);
      const running = profiles.get("Run")({include: methods}, token);
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      changed(api.Uri.file(source));
      await new Promise(resolve => setImmediate(resolve));
      expect(object.children.get("CLAS:ZCL_OSD_ABAP_TOKENS/LTCL_SCAN").children.get(methods[0].id),
        "a watcher must not replace a spinning item").to.equal(methods[0]);
      finish({classes: [{name: "LTCL_SCAN", methods: [{name: "FIRST", status: "passed"}]}]});
      await running;
      expect(events.filter(([name]) => name === "started")).to.have.length(1);
      expect(events.filter(([name]) => ["passed", "failed", "skipped", "errored"].includes(name))).to.have.length(1);
      expect(events.at(-1)[0]).to.equal("end");
      expect(listeners.size).to.equal(0);
    } finally {
      explorer?.dispose();
      Osd.prototype.discover = originalDiscover;
      Osd.prototype.run = originalRun;
    }
  });

  for (const scenario of ["removed", "replaced", "rejected"]) it(`deferred rediscovery handles an object ${scenario} during a run`, async () => {
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const source = path.join(ROOT, "src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap");
    api.Uri.file = (fsPath) => ({fsPath});
    api.Range = class { constructor() {} };
    api.TestMessage = class { constructor(message) { this.message = message; } };
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    let files = [api.Uri.file(source)];
    api.workspace.findFiles = async () => files;
    api.workspace.getWorkspaceFolder = () => ({uri: api.Uri.file(ROOT)});
    let changed;
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange(fn) { changed = fn; }, dispose() {}});
    api.commands = {registerCommand: () => ({dispose() {}})};
    const collection = (parent) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        get: (id) => items.get(id),
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator](),
      };
    };
    const profiles = new Map();
    const events = [];
    const controller = {
      items: collection(undefined),
      createTestItem(id, label, uri) {
        const item = {id, label, uri};
        item.children = collection(item);
        return item;
      },
      createRunProfile(name, kind, handler) { profiles.set(name, handler); },
      createTestRun() {
        return Object.fromEntries(["started", "passed", "failed", "skipped", "errored", "appendOutput", "end"]
          .map((name) => [name, (item) => events.push([name, item?.id])]));
      },
      dispose() {},
    };
    api.tests = {createTestController: () => controller};
    const {testExplorer} = loadExtension(api);
    const originalDiscover = Osd.prototype.discover;
    const originalRun = Osd.prototype.run;
    const listeners = new Set();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested(listener) { listeners.add(listener); return {dispose: () => listeners.delete(listener)}; },
      cancel() { this.isCancellationRequested = true; for (const listener of listeners) listener(); },
    };
    const signals = [];
    Osd.prototype.discover = async () => ({classes: [{name: "LTCL_SCAN", include: "testclasses", line: 1, schedule: "harmless",
      methods: [{name: "FIRST", line: 2}]}]});
    let finish;
    Osd.prototype.run = () => new Promise(resolve => { finish = resolve; });
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let explorer;
    try {
      const outputLines = [];
      explorer = testExplorer(controllerContext(), {appendLine: line => outputLines.push(line)}, {});
      await controller.resolveHandler();
      const object = controller.items.get("group:project").children.get("CLAS:ZCL_OSD_ABAP_TOKENS");
      await controller.resolveHandler(object);
      const methods = [...object.children.get("CLAS:ZCL_OSD_ABAP_TOKENS/LTCL_SCAN").children].map(([, item]) => item);
      const running = profiles.get("Run")({include: methods}, token);
      while (!finish) await new Promise(resolve => setImmediate(resolve));
      changed(api.Uri.file(source));
      await new Promise(resolve => setImmediate(resolve));
      expect(object.children.get("CLAS:ZCL_OSD_ABAP_TOKENS/LTCL_SCAN").children.get(methods[0].id),
        "a watcher must not replace a spinning item").to.equal(methods[0]);
      files = scenario === "removed" ? [] : files;
      await controller.refreshHandler();
      const current = controller.items.get("group:project").children.get(object.id);
      let discoveries = 0;
      Osd.prototype.discover = async () => { discoveries++; return {classes: []}; };
      if (scenario === "rejected") Object.defineProperty(current, "busy", {set() { throw Error("deferred failure"); }});
      finish({classes: [{name: "LTCL_SCAN", methods: [{name: "FIRST", status: "passed"}]}]});
      await running;
      expect(events.filter(([name]) => name === "started")).to.have.length(1);
      expect(events.filter(([name]) => ["passed", "failed", "skipped", "errored"].includes(name))).to.have.length(1);
      expect(events.at(-1)[0]).to.equal("end");
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled.map(String)).to.deep.equal([]);
      if (scenario === "replaced") expect(current.busy).to.equal(false);
      expect(discoveries).to.equal(scenario === "replaced" ? 1 : 0);
      if (scenario !== "removed") {
        expect(current).not.to.equal(object);
        expect(current.children.size).to.equal(0);
      }
      if (scenario === "rejected") expect(outputLines).to.include("deferred failure");
      expect(listeners.size).to.equal(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      explorer?.dispose();
      Osd.prototype.discover = originalDiscover;
      Osd.prototype.run = originalRun;
    }
  });

  it("a Run over a mixed tree runs the HARMLESS objects at once and the DANGEROUS one alone, after them", async () => {
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const files = ["src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap", "src/demo_data/zcl_osd_demo_random.clas.testclasses.abap",
      "src/webgui/zcl_osd_webgui.clas.testclasses.abap"].map((f) => path.join(ROOT, f));
    api.Uri.file = (fsPath) => ({fsPath});
    api.Range = class { constructor() {} };
    api.TestMessage = class { constructor(message) { this.message = message; } };
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    api.workspace.findFiles = async () => files.map((f) => api.Uri.file(f));
    api.workspace.getWorkspaceFolder = () => ({uri: api.Uri.file(ROOT)});
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange() {}, dispose() {}});
    api.commands = {registerCommand: () => ({dispose() {}})};
    const collection = (parent) => {
      const items = new Map();
      return {
        get size() { return items.size; },
        get: (id) => items.get(id),
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator](),
      };
    };
    const profiles = new Map();
    const controller = {
      items: collection(undefined),
      createTestItem(id, label, uri) {
        const item = {id, label, uri};
        item.children = collection(item);
        return item;
      },
      createRunProfile(name, kind, handler) { profiles.set(name, handler); },
      createTestRun() {
        return Object.fromEntries(["started", "passed", "failed", "skipped", "errored", "appendOutput", "end"].map((name) => [name, () => {}]));
      },
      dispose() {},
    };
    api.tests = {createTestController: () => controller};
    const {testExplorer} = loadExtension(api);
    // four CPUs, whatever the machine: a pool of one would pass this test
    // with every object scheduled DANGEROUS
    const os = require("node:os");
    const originalCpus = os.cpus;
    os.cpus = () => [{}, {}, {}, {}];
    const originalDiscover = Osd.prototype.discover;
    const originalRun = Osd.prototype.run;
    // ZCL_OSD_WEBGUI is the one that writes
    const schedule = {ZCL_OSD_ABAP_TOKENS: "harmless", ZCL_OSD_DEMO_RANDOM: "harmless", ZCL_OSD_WEBGUI: "dangerous"};
    Osd.prototype.discover = async (object) => ({classes: [{name: "LTCL_T", include: "testclasses", line: 1,
      schedule: schedule[object.name], durationCategory: "short", methods: [{name: "M", line: 2}]}]});
    let running = 0;
    const seen = [];
    Osd.prototype.run = async (object) => {
      running += 1;
      seen.push([object.name, running]);
      await new Promise((r) => setTimeout(r, 60));
      running -= 1;
      return {testClasses: [], counts: {passed: 0, failed: 0}};
    };
    const token = {isCancellationRequested: false, onCancellationRequested: () => ({dispose() {}})};
    let explorer;
    try {
      explorer = testExplorer(controllerContext(), {appendLine() {}}, {});
      await controller.resolveHandler();
      const objects = [...controller.items.get("group:project").children].map(([, item]) => item);
      expect(objects.map((o) => o.id).sort()).to.deep.equal(["CLAS:ZCL_OSD_ABAP_TOKENS", "CLAS:ZCL_OSD_DEMO_RANDOM", "CLAS:ZCL_OSD_WEBGUI"]);
      await profiles.get("Run")({include: objects}, token);
      const harmless = seen.filter(([name]) => name !== "ZCL_OSD_WEBGUI");
      expect(Math.max(...harmless.map(([, n]) => n)), "the HARMLESS objects at once").to.equal(2);
      expect(seen.at(-1), "the DANGEROUS one last, alone").to.deep.equal(["ZCL_OSD_WEBGUI", 1]);
    } finally {
      os.cpus = originalCpus;
      explorer?.dispose();
      Osd.prototype.discover = originalDiscover;
      Osd.prototype.run = originalRun;
    }
  });

  it("schedules by RISK LEVEL: HARMLESS units in a pool, longest first, the rest one at a time after", async () => {
    const {unitRiskOf, unitDurationOf, unitSchedule, runUnitQueue, unitPoolSize, riskWarning} = require("../editors/vscode/lib.js");
    expect(unitRiskOf([{schedule: "harmless"}, {schedule: "harmless"}])).to.equal("harmless");
    expect(unitRiskOf([{schedule: "harmless"}, {schedule: "dangerous"}])).to.equal("dangerous");
    expect(unitRiskOf([{schedule: "harmless"}, undefined]), "a class nobody described").to.equal("dangerous");
    expect(unitRiskOf([])).to.equal("dangerous");
    expect(unitDurationOf([{duration: "short"}, {duration: "long"}, {duration: "medium"}])).to.equal("long");
    expect(unitDurationOf([undefined])).to.equal("short");
    expect(unitPoolSize(1)).to.equal(1);
    expect(unitPoolSize(3)).to.equal(2);
    expect(unitPoolSize(32)).to.equal(4);
    const plan = unitSchedule([
      {key: "a", risk: "harmless", duration: "short"}, {key: "b", risk: "dangerous", duration: "short"},
      {key: "c", risk: "harmless", duration: "long"}, {key: "d", risk: "critical", duration: "medium"},
    ]);
    expect(plan.parallel.map((u) => u.key)).to.deep.equal(["c", "a"]);
    expect(plan.serial.map((u) => u.key)).to.deep.equal(["d", "b"]);

    // run for real, with timers: at most `poolSize` HARMLESS at once, no
    // other unit while any runs, and the rest strictly one after another
    let running = 0;
    let most = 0;
    const log = [];
    const unit = (key, risk, ms) => ({key, risk, duration: "short", run: async () => {
      running += 1;
      most = Math.max(most, running);
      log.push(["start", key, risk, running]);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      log.push(["end", key]);
    }});
    const started = Date.now();
    await runUnitQueue([unit("h1", "harmless", 120), unit("d1", "dangerous", 30), unit("h2", "harmless", 120),
      unit("h3", "harmless", 120), unit("d2", "critical", 30)], {poolSize: 3});
    const elapsed = Date.now() - started;
    expect(most, "three HARMLESS at once").to.equal(3);
    for (const [event, key, risk, concurrent] of log.filter(([e]) => e === "start")) {
      if (risk !== "harmless") expect(concurrent, `${key} ran alone`).to.equal(1);
    }
    const firstDangerous = log.findIndex(([e, , risk]) => e === "start" && risk !== "harmless");
    expect(log.slice(firstDangerous).some(([e, , risk]) => e === "start" && risk === "harmless"), "no HARMLESS after the serial queue began").to.equal(false);
    expect(elapsed, "the pool overlapped the HARMLESS runs").to.be.below(120 * 3 + 60);
    // cancelled: nothing new starts
    const ran = [];
    let stop = false;
    await runUnitQueue([{risk: "harmless", run: async () => { ran.push(1); stop = true; }}, {risk: "harmless", run: async () => ran.push(2)},
      {risk: "dangerous", run: async () => ran.push(3)}], {poolSize: 1, cancelled: () => stop});
    expect(ran).to.deep.equal([1]);

    const found = {object: {name: "ZCL_X_TEST"}, writes: [{object: "ZCL_X_TEST", kind: "INSERT", file: "zcl_x_test.clas.testclasses.abap", line: 12}], writesTotal: 3};
    expect(riskWarning({riskLevel: "harmless", riskLevelDeclared: true, schedule: "dangerous"}, found))
      .to.equal("RISK LEVEL HARMLESS, but the tests of ZCL_X_TEST reach a database write: INSERT in ZCL_X_TEST (zcl_x_test.clas.testclasses.abap:12) and 2 more. It runs one at a time, as DANGEROUS; declare RISK LEVEL DANGEROUS to say so.");
    expect(riskWarning({riskLevel: "harmless", riskLevelDeclared: false, schedule: "dangerous"}, found), "undeclared says nothing").to.equal(undefined);
    expect(riskWarning({riskLevel: "dangerous", riskLevelDeclared: true, schedule: "dangerous"}, found)).to.equal(undefined);
    expect(riskWarning({riskLevel: "harmless", riskLevelDeclared: true, schedule: "harmless"}, found)).to.equal(undefined);
  });

  it("maps packaged workspace-layer source-map entries to the open folder", () => {
    const layer = {folder: "/work/project", srcDir: "/work/project/src"};
    const config = debuggerConfiguration(9341, {root: "/installed/osd", storageDir: "/storage/osd", layers: [layer]});
    const {packNameOf} = createRequire(import.meta.url)("../editors/vscode/launcher.js");
    const packSource = `/storage/osd/packs/${packNameOf(layer.folder)}/src`;
    const relativeSource = path.relative("/installed/osd/build/by-input/generation/output", packSource).replaceAll("\\", "/");
    expect(config.sourceMapPathOverrides[`${relativeSource}/*`])
      .to.equal("/work/project/src/*");
    expect(config.sourceMapPathOverrides[`file://${packSource}/*`])
      .to.equal("/work/project/src/*");
  });

  it("maps a manifest's custom ABAP folder through the projected pack", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "osd-debug-pack-"));
    try {
      const manifest = path.join(dir, "osd-pack.json");
      writeFileSync(manifest, JSON.stringify({name: "custom", abap: ["code"]}));
      const layer = {folder: dir, srcDir: dir, manifest};
      const config = debuggerConfiguration(9341, {root: "/installed/osd", storageDir: "/storage/osd", layers: [layer]});
      const {packNameOf} = createRequire(import.meta.url)("../editors/vscode/launcher.js");
      const packSource = `/storage/osd/packs/${packNameOf(dir)}/code`;
      expect(config.sourceMapPathOverrides[`file://${packSource}/*`]).to.equal(`${dir}/code/*`);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("names the copy a breakpoint binds in: the one the running generation's source maps name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "osd-breakpoint-"));
    try {
      // a running home (the bundled copy's shape), a checkout of the same
      // tree beside it, and one workspace pack compiled through storage
      const home = path.join(dir, "home");
      const checkout = path.join(dir, "checkout");
      const storage = path.join(dir, "storage");
      const workspace = path.join(dir, "work");
      const layer = {folder: workspace, srcDir: path.join(workspace, "src")};
      const {packNameOf} = createRequire(import.meta.url)("../editors/vscode/launcher.js");
      const packSource = path.join(storage, "packs", packNameOf(workspace), "src");
      const output = path.join(home, "build", "by-input", "g1", "output");
      for (const folder of [output, path.join(home, "src"), path.join(checkout, "src"), layer.srcDir, packSource]) {
        mkdirSync(folder, {recursive: true});
      }
      for (const file of [path.join(home, "src", "zcl_a.clas.abap"), path.join(checkout, "src", "zcl_a.clas.abap"),
        path.join(checkout, "src", "zcl_b.clas.abap"), path.join(layer.srcDir, "zcl_p.clas.abap")]) {
        writeFileSync(file, "CLASS x DEFINITION.\n");
      }
      writeFileSync(path.join(output, "zcl_a.clas.mjs.map"), JSON.stringify({version: 3,
        sources: [path.relative(output, path.join(home, "src", "zcl_a.clas.abap")).replaceAll("\\", "/")], mappings: ""}));
      writeFileSync(path.join(output, "zcl_p.clas.mjs.map"), JSON.stringify({version: 3,
        sources: [path.relative(output, path.join(packSource, "zcl_p.clas.abap")).replaceAll("\\", "/")], mappings: ""}));
      // a library's map names a bare file name, resolving inside output/ to nothing
      writeFileSync(path.join(output, "zcl_lib.clas.mjs.map"), JSON.stringify({version: 3, sources: ["zcl_lib.clas.abap"], mappings: ""}));
      mkdirSync(path.join(dir, "lib", "src"), {recursive: true});
      writeFileSync(path.join(dir, "lib", "src", "zcl_lib.clas.abap"), "CLASS x DEFINITION.\n");
      symlinkSync(output, path.join(home, "output"), "dir");

      const running = runningAbapSources(home, {storageDir: storage, layers: [layer]});
      expect(running.generation).to.equal(realpathSync(output));
      expect(breakpointWarning(path.join(home, "src", "zcl_a.clas.abap"), running)).to.equal(undefined);
      expect(breakpointWarning(path.join(layer.srcDir, "zcl_p.clas.abap"), running)).to.equal(undefined);
      expect(breakpointWarning(path.join(dir, "notes.txt"), running)).to.equal(undefined);

      const other = breakpointWarning(path.join(checkout, "src", "zcl_a.clas.abap"), running, {home});
      expect(other.counterpart).to.equal(path.join(home, "src", "zcl_a.clas.abap"));
      expect(other.message).to.contain("will not be hit").and.contain(`runs ${path.join(home, "src", "zcl_a.clas.abap")}`);

      const absent = breakpointWarning(path.join(checkout, "src", "zcl_b.clas.abap"), running);
      expect(absent.counterpart).to.equal(undefined);
      expect(absent.message).to.contain("no code of the running system maps back to zcl_b.clas.abap");

      expect(running.files.size).to.equal(2);
      const library = breakpointWarning(path.join(dir, "lib", "src", "zcl_lib.clas.abap"), running);
      expect(library.counterpart).to.equal(undefined);
      expect(library.message).to.contain("no code of the running system maps back to zcl_lib.clas.abap");

      expect(runningAbapSources(path.join(dir, "nothing-built"))).to.equal(undefined);
      expect(breakpointWarning(path.join(checkout, "src", "zcl_a.clas.abap"), undefined)).to.equal(undefined);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("round 2 item 3: discovers installed sources and binds debugger maps to those same files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "osd-system-debug-"));
    try {
      const layers = [{name: "src", kind: "input", path: "inputs/src"},
        {name: "custom", kind: "customer", path: "inputs/custom"},
        {name: "demo", kind: "pack", path: "packs/demo"}, {name: "lib", kind: "lib", path: "libs/lib"}];
      const system = path.join(dir, ".local/system"), output = path.join(dir, "build/by-input/g1/output");
      mkdirSync(output, {recursive: true}); mkdirSync(system, {recursive: true});
      writeFileSync(path.join(system, ".osd-system.json"), JSON.stringify({layers}));
      const cases = [["src/zfoo.prog.abap", "inputs/src/code/zfoo.prog.abap"],
        ["custom/zbar.prog.abap", "inputs/custom/src/zbar.prog.abap"],
        ["packs/demo/src/zpack.prog.abap", "packs/demo/src/zpack.prog.abap"],
        [".local/lars/lib/src/cl_lib.clas.abap", "libs/lib/src/cl_lib.clas.abap"]];
      for (const layer of layers) {
        const base = path.join(system, layer.path); mkdirSync(base, {recursive: true});
        writeFileSync(path.join(base, ".abapgit.xml"), `<STARTING_FOLDER>/${layer.name === "src" ? "code" : "src"}/</STARTING_FOLDER>`);
      }
      for (const [logical, installed] of cases) {
        const actual = path.join(system, installed), checkout = path.join(dir, logical);
        mkdirSync(path.dirname(actual), {recursive: true}); writeFileSync(actual, "* installed");
        mkdirSync(path.dirname(checkout), {recursive: true}); writeFileSync(checkout, "* unrelated");
        writeFileSync(path.join(output, path.basename(logical) + ".mjs.map"), JSON.stringify({version: 3,
          sources: [path.relative(output, checkout).replaceAll("\\", "/")], mappings: ""}));
      }
      symlinkSync(output, path.join(dir, "output"), "dir");
      const running = runningAbapSources(dir), attach = debuggerConfiguration(9341, {root: dir});
      expect(running.files.size).to.equal(cases.length);
      for (const [logical, installed] of cases) {
        const actual = path.join(system, installed), checkout = path.join(dir, logical);
        expect(breakpointWarning(actual, running)).to.equal(undefined);
        expect(breakpointWarning(checkout, running).counterpart).to.equal(actual);
        const override = entry => {
          for (const [pattern, target] of Object.entries(attach.sourceMapPathOverrides)) {
            const prefix = pattern.slice(0, -1);
            if (entry.startsWith(prefix)) return target.replace("*", entry.slice(prefix.length));
          }
        };
        expect(override(path.relative(output, checkout).replaceAll("\\", "/"))).to.equal(actual);
        expect(override(pathToFileURL(checkout).href)).to.equal(actual);
      }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("the taxi sample data: the next year to make, what a reset removes, and the tree's action", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    expect(taxiDefaultYear([], now)).to.equal(2026);
    expect(taxiDefaultYear([{Year: 2026}, {Year: 2025}, {Year: 2023}], now), "the most recent year without rows").to.equal(2024);
    expect(taxiResetPrompt([])).to.equal(undefined);
    expect(taxiResetPrompt([{Year: 2023, Trips: 87192, Rows: 20000}, {Year: 2024, Trips: 122665, Rows: 20000}]))
      .to.equal("Remove 2023, 2024 (209 857 trips in 40 000 rows)? Rows that are not synthetic stay.");
    expect(serviceActionContext({kind: "ODATA", name: "ZOSD_TAXI_SRV", path: "/sap/opu/odata/sap/ZOSD_TAXI_SRV"}))
      .to.match(/(^|;)taxi-data(;|$)/);
    expect(serviceActionContext({kind: "ODATA", name: "ZSTG_DEMO_SRV", path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV"}))
      .to.not.match(/taxi-data/);
  });

  it("calls a POST function import with the service's own CSRF token, and says an OData error in its words", async () => {
    const seen = [];
    const fake = async (url, options = {}) => {
      seen.push({url, method: options.method ?? "GET", headers: options.headers ?? {}});
      if ((options.headers ?? {})["x-csrf-token"] === "fetch") {
        return new Response("", {status: 200, headers: {"x-csrf-token": "tok-1", "set-cookie": "sap-XSRF_OSD=abc; path=/"}});
      }
      if (url.includes("GenerateYear")) {
        return new Response(JSON.stringify({d: {GenerateYear: "taxi: 2025 generated"}}), {status: 200});
      }
      return new Response(JSON.stringify({error: {message: {lang: "en", value: "Year \"abc\" is not a year"}}}), {status: 400});
    };
    const client = new Osd("http://localhost:3999/", fake);
    expect(await client.odataAction("ZOSD_TAXI_SRV", "GenerateYear", {Year: 2025})).to.equal("taxi: 2025 generated");
    expect(seen[0]).to.include({url: "http://localhost:3999/sap/opu/odata/sap/ZOSD_TAXI_SRV/", method: "GET"});
    expect(seen[1]).to.include({url: "http://localhost:3999/sap/opu/odata/sap/ZOSD_TAXI_SRV/GenerateYear?Year=2025", method: "POST"});
    expect(seen[1].headers).to.include({"x-csrf-token": "tok-1", cookie: "sap-XSRF_OSD=abc"});
    let error;
    try {
      await client.odataAction("ZOSD_TAXI_SRV", "ResetData");
    } catch (e) {
      error = e;
    }
    expect(error?.message).to.equal('POST ZOSD_TAXI_SRV/ResetData: HTTP 400 -- Year "abc" is not a year');
    // a token fetch that fails is said as that, not as the POST's 403
    const refused = new Osd("http://localhost:3999/", async () => new Response("", {status: 403}));
    error = undefined;
    try {
      await refused.odataAction("ZOSD_TAXI_SRV", "ResetData");
    } catch (e) {
      error = e;
    }
    expect(error?.message).to.equal("GET ZOSD_TAXI_SRV/: HTTP 403 -- no CSRF token");
  });

  // the debugger on demand (docs/debugging-abap.md): no osd.debug before
  // Start; "Run with debugger" or a breakpoint opens the inspector in the
  // running system, and the last breakpoint gone closes it again
  const debugApi = () => {
    const api = vscodeStub();
    class SourceBreakpoint {
      constructor(file, enabled = true) {
        this.enabled = enabled;
        this.location = {uri: {scheme: "file", fsPath: file}};
      }
    }
    api.SourceBreakpoint = SourceBreakpoint;
    api.debug.breakpoints = [];
    api.debug.started = [];
    api.debug.startDebugging = async (folder, config) => {
      api.debug.started.push(config);
      return true;
    };
    api.debug.stopDebugging = async () => {};
    return api;
  };
  const fakeLauncher = (fields = {}) => {
    const calls = [];
    return {
      calls, state: "running", port: 3100, debug: false, inspectPort: undefined, inspectorOpen: false, osdHome: ROOT,
      async openInspector() {
        calls.push("open");
        this.inspectPort = 9401;
        this.inspectorOpen = true;
        return 9401;
      },
      async closeInspector() {
        calls.push("close");
        this.inspectorOpen = false;
        return true;
      },
      ...fields,
    };
  };

  it("Run with debugger opens the inspector of a system started without one, and attaches", async () => {
    const api = debugApi();
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    controller.launcher = fakeLauncher();
    expect(await controller.attachSystemDebugger(), "without on-demand, nothing is opened").to.equal(false);
    expect(controller.launcher.calls).to.deep.equal([]);
    expect(await controller.attachSystemDebugger({onDemand: true})).to.equal(true);
    expect(controller.launcher.calls).to.deep.equal(["open"]);
    expect(api.debug.started.map((c) => [c.name, c.address, c.port, c.restart]))
      .to.deep.equal([["OSD: ABAP (9401)", "127.0.0.1", 9401, true]]);
    // asked again: already open, already attached
    expect(await controller.attachSystemDebugger({onDemand: true})).to.equal(true);
    expect(controller.launcher.calls).to.deep.equal(["open"]);
  });

  it("waits for the current system session and a verified DPC breakpoint after prior activity and restart", async () => {
    const api = debugApi();
    const statuses = [];
    api.window.setStatusBarMessage = (message) => {
      statuses.push(message);
      return {dispose: () => statuses.push("disposed")};
    };
    const listeners = {start: [], end: []};
    api.debug.onDidStartDebugSession = (fn) => { listeners.start.push(fn); return {dispose() {}}; };
    api.debug.onDidTerminateDebugSession = (fn) => { listeners.end.push(fn); return {dispose() {}}; };
    const file = "/w/src/zcl_demo_dpc_ext.clas.abap";
    const bp = new api.SourceBreakpoint(file);
    api.debug.breakpoints = [bp];
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {appendLine() {}});
    controller.launcher = fakeLauncher();
    // A plain request loads the DPC before the debugger starts.
    const calls = ["plain request"];
    await controller.attachSystemDebugger({onDemand: true});
    let ready = false;
    const first = controller.waitForDebuggerReady(file, 300).then(() => { ready = true; calls.push("debug request"); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ready).to.equal(false);
    let verified = false;
    const session = {name: "OSD: ABAP (9401)", id: "first",
      getDebugProtocolBreakpoint: async () => verified ? {verified: true} : {verified: false}};
    listeners.start.forEach((fn) => fn(session));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ready).to.equal(false);
    verified = true;
    await first;
    expect(calls).to.deep.equal(["plain request", "debug request"]);
    // Shift+F5 ends that session. The next call must wait for a new one.
    listeners.end.forEach((fn) => fn(session));
    const second = controller.attachSystemDebugger({onDemand: true});
    await second;
    let secondReady = false;
    const next = controller.waitForDebuggerReady(file, 300).then(() => { secondReady = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondReady).to.equal(false);
    const replacement = {...session, id: "second", getDebugProtocolBreakpoint: async () => ({verified: true})};
    listeners.start.forEach((fn) => fn(replacement));
    await next;
    // A Stop/Start on the same port must not reuse the old session.
    controller.launcher.state = "stopped";
    await controller.applyDebuggerEvent({type: "system-stopped"});
    controller.launcher.state = "running";
    await controller.attachSystemDebugger({onDemand: true});
    let restartedReady = false;
    const restarted = controller.waitForDebuggerReady(file, 300).then(() => { restartedReady = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(restartedReady).to.equal(false);
    listeners.start.forEach((fn) => fn({...session, id: "third"}));
    // VS Code reports the old session's termination after the new one starts.
    listeners.end.forEach((fn) => fn(replacement));
    expect(controller.debuggerState.systemPort).to.equal(9401);
    expect(controller.activeSystemSessionId).to.equal("third");
    await restarted;
    expect(statuses).to.include("osd: waiting for the debugger…");
    expect(statuses.filter((s) => s === "disposed")).to.have.length(3);
    verified = false;
    expect(await controller.waitForDebuggerReady(file, 80), "unverified breakpoints time out").to.equal(false);
    expect(statuses.at(-1)).to.equal("disposed");
  });

  it("bounds a pending DAP breakpoint request and cancels its progress wait", async () => {
    const api = debugApi();
    const file = "/w/src/zcl_wait.clas.abap";
    api.debug.breakpoints = [new api.SourceBreakpoint(file)];
    const listeners = [];
    api.debug.onDidStartDebugSession = (fn) => { listeners.push(fn); return {dispose() {}}; };
    let cancel;
    api.ProgressLocation = {Notification: 15};
    api.window.withProgress = (options, task) => {
      expect(options).to.include({location: 15, cancellable: true});
      return task({}, {onCancellationRequested(fn) { cancel = fn; return {dispose() {}}; }});
    };
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {appendLine() {}});
    controller.launcher = fakeLauncher({inspectPort: 9401});
    listeners.forEach((fn) => fn({id: "pending", name: "OSD: ABAP (9401)",
      getDebugProtocolBreakpoint: () => new Promise(() => {})}));
    const started = Date.now();
    expect(await controller.waitForDebuggerReady(file, 80)).to.equal(false);
    expect(Date.now() - started).to.be.lessThan(500);
    const waiting = controller.waitForDebuggerReady(file, 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancel();
    // a cancel is not a give-up: the caller sends nothing
    expect(await waiting).to.equal("cancelled");
  });

  it("reports an absent enabled DPC breakpoint, but verifies one when present", async () => {
    const api = debugApi();
    const file = "/w/src/zcl_demo_dpc_ext.clas.abap";
    const output = [];
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {appendLine: (line) => output.push(line)});
    controller.launcher = fakeLauncher({inspectPort: 9401});
    let verified = false;
    controller.debugSessions.add({id: "dpc", name: "OSD: ABAP (9401)",
      getDebugProtocolBreakpoint: async () => ({verified})});
    api.debug.breakpoints = [new api.SourceBreakpoint(file, false)];
    expect(await controller.waitForDebuggerReady(file, 100, {reportMissingBreakpoint: true})).to.equal(true);
    const said = () => output.filter((line) => line.includes("calling without a verified breakpoint"));
    expect(said()).to.deep.equal([`osd debugger: no enabled breakpoint in ${file}; calling without a verified breakpoint`]);
    api.debug.breakpoints = [new api.SourceBreakpoint(file)];
    expect(await controller.waitForDebuggerReady(file, 80, {reportMissingBreakpoint: true})).to.equal(false);
    verified = true;
    expect(await controller.waitForDebuggerReady(file, 100, {reportMissingBreakpoint: true})).to.equal(true);
    expect(said()).to.have.length(1);
  });

  it("serializes a generation refresh with a following attach and ignores the old termination", async () => {
    const api = debugApi();
    const listeners = {start: [], end: []};
    api.debug.onDidStartDebugSession = (fn) => { listeners.start.push(fn); return {dispose() {}}; };
    api.debug.onDidTerminateDebugSession = (fn) => { listeners.end.push(fn); return {dispose() {}}; };
    const home = mkdtempSync(path.join(tmpdir(), "osd-debug-refresh-"));
    try {
      const first = path.join(home, "build", "by-input", "first", "output");
      const second = path.join(home, "build", "by-input", "second", "output");
      mkdirSync(first, {recursive: true});
      mkdirSync(second, {recursive: true});
      symlinkSync(first, path.join(home, "output"), "dir");
      const SystemController = loadSystemController(api);
      const controller = new SystemController(controllerContext(), {appendLine() {}});
      controller.launcher = fakeLauncher({osdHome: home, inspectPort: 9401, inspectorOpen: true});
      controller.debuggerState = {systemPort: 9401};
      controller.debuggerOutputPattern = `${first}/**/*.mjs`;
      const old = {id: "old", name: "OSD: ABAP (9401)"};
      listeners.start.forEach((fn) => fn(old));
      rmSync(path.join(home, "output"));
      symlinkSync(second, path.join(home, "output"), "dir");
      let finishStop;
      api.debug.stopDebugging = async () => new Promise((resolve) => { finishStop = resolve; });
      api.debug.startDebugging = async (_folder, config) => {
        api.debug.started.push(config);
        listeners.start.forEach((fn) => fn({id: "new", name: config.name}));
        return true;
      };
      const refresh = controller.refreshDebuggerGeneration();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const attach = controller.attachSystemDebugger({onDemand: true});
      expect(api.debug.started).to.have.length(0);
      finishStop();
      await Promise.all([refresh, attach]);
      listeners.end.forEach((fn) => fn({...old}));
      expect(api.debug.started).to.have.length(1);
      expect(controller.activeSystemSessionId).to.equal("new");
      expect(controller.debuggerState.systemPort).to.equal(9401);
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  });

  it("classrun with debugger waits for its class breakpoint, then sends the run even when the wait gives up", async () => {
    const api = debugApi();
    // an unattended run: nobody ever answers a notification
    api.window.showWarningMessage = () => new Promise(() => {});
    const {classrunObject} = loadExtension(api);
    const lines = [];
    const notes = [];
    const output = {show() {}, appendLine(line) { lines.push(line); }};
    const calls = [];
    const options = {attach: async () => true,
      controller: {waitForDebuggerReady: async (file) => { calls.push(file); return false; },
        debugNote: (line) => notes.push(line)},
      client: () => ({classrun: async () => { calls.push("run"); return {text: "ok", ms: 1}; }})};
    await classrunObject("ZCL_X", output, true, "/w/src/zcl_x.clas.abap", options);
    // 0.5.1467 returned here: nothing sent, nothing in any output channel
    expect(calls).to.deep.equal(["/w/src/zcl_x.clas.abap", "run"]);
    expect(notes).to.include("classrun ZCL_X: running without a verified breakpoint");
    options.controller.waitForDebuggerReady = async (file) => { calls.push(file); return true; };
    await classrunObject("ZCL_X", output, true, "/w/src/zcl_x.clas.abap", options);
    expect(calls).to.deep.equal(["/w/src/zcl_x.clas.abap", "run", "/w/src/zcl_x.clas.abap", "run"]);
    expect(lines.filter((line) => line === "ok")).to.have.length(2);
  });

  it("waits for one verified breakpoint per object, and never for a shadowed copy of it", async () => {
    const api = debugApi();
    const file = "/w/src/zcl_demo_dpc_ext.clas.abap";
    const shadow = "/w/.local/lars/src/zcl_demo_dpc_ext.clas.abap";
    const lines = [];
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {appendLine: (line) => lines.push(line)});
    controller.launcher = fakeLauncher({inspectPort: 9401, osdHome: undefined});
    // two breakpoints in the file (one on a line that never binds), and one
    // in a never-compiled copy of the same class
    const bound = new api.SourceBreakpoint(file);
    const neverBinds = new api.SourceBreakpoint(file);
    const inShadow = new api.SourceBreakpoint(shadow);
    api.debug.breakpoints = [bound, neverBinds, inShadow];
    controller.debugSessions.add({id: "dpc", name: "OSD: ABAP (9401)",
      getDebugProtocolBreakpoint: async (bp) => ({verified: bp === bound})});
    const started = Date.now();
    expect(await controller.waitForDebuggerReady(file, 1500)).to.equal(true);
    expect(Date.now() - started, "no wait for the unbound line or the shadow").to.be.lessThan(1000);
    expect(lines.some((line) => line.includes(`${shadow}:0 is ignored for ${file} (object, not the running copy)`))).to.equal(true);
  });

  it("a cancelled breakpoint wait sends nothing; a wait that gave up still sends", async () => {
    const api = debugApi();
    api.window.showWarningMessage = () => new Promise(() => {});
    const {classrunObject, WAIT_CANCELLED} = loadExtension(api);
    expect(WAIT_CANCELLED).to.equal("cancelled");
    const calls = [];
    const notes = [];
    const options = {attach: async () => true,
      controller: {waitForDebuggerReady: async () => "cancelled", debugNote: (line) => notes.push(line)},
      client: () => ({classrun: async () => { calls.push("run"); return {text: "ok", ms: 1}; }})};
    const output = {show() {}, appendLine() {}};
    await classrunObject("ZCL_X", output, true, "/w/src/zcl_x.clas.abap", options);
    expect(calls, "cancel must cancel").to.deep.equal([]);
    expect(notes).to.include("classrun ZCL_X: the wait was cancelled; nothing sent");
    options.controller.waitForDebuggerReady = async () => false;
    await classrunObject("ZCL_X", output, true, "/w/src/zcl_x.clas.abap", options);
    expect(calls).to.deep.equal(["run"]);
  });

  it("lets a queued debugger step run longer than every bound of an attach added up", () => {
    const {INSPECTOR_STEP_ESCAPE_MS} = loadExtension(debugApi());
    // inspector 15 + previous stop 15 + refresh stop 10 + second bound 10 +
    // refresh start 35 + plain start 35 = 120 s
    expect(INSPECTOR_STEP_ESCAPE_MS).to.be.greaterThan(120000);
  });

  it("keeps a start that outlived its bound in flight, so a second attach does not start beside it", async () => {
    const api = debugApi();
    let starts = 0;
    let finish;
    api.debug.startDebugging = () => { starts++; return new Promise((resolve) => { finish = resolve; }); };
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {appendLine() {}});
    controller.launcher = fakeLauncher({inspectPort: 9401, inspectorOpen: true});
    controller.debuggerBounds = {start: 50, stop: 50};
    expect(await controller.applyDebuggerEvent({type: "system-started", enabled: true, port: 9401})).to.equal(false);
    controller.debuggerState = {};
    expect(await controller.applyDebuggerEvent({type: "system-started", enabled: true, port: 9401})).to.equal(false);
    expect(starts, "one start in flight, not two").to.equal(1);
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.debuggerStarts.size, "forgotten once it settles").to.equal(0);
  });

  it("does not start the new generation's session beside an old one that would not stop", async () => {
    const api = debugApi();
    const listeners = {start: [], end: []};
    api.debug.onDidStartDebugSession = (fn) => { listeners.start.push(fn); return {dispose() {}}; };
    api.debug.onDidTerminateDebugSession = (fn) => { listeners.end.push(fn); return {dispose() {}}; };
    const home = mkdtempSync(path.join(tmpdir(), "osd-debug-stuck-stop-"));
    try {
      const first = path.join(home, "build", "by-input", "first", "output");
      const second = path.join(home, "build", "by-input", "second", "output");
      mkdirSync(first, {recursive: true});
      mkdirSync(second, {recursive: true});
      symlinkSync(second, path.join(home, "output"), "dir");
      const lines = [];
      const SystemController = loadSystemController(api);
      const controller = new SystemController(controllerContext(), {appendLine: (line) => lines.push(line)});
      controller.launcher = fakeLauncher({osdHome: home, inspectPort: 9401, inspectorOpen: true});
      controller.debuggerBounds = {start: 1000, stop: 80};
      controller.debuggerState = {systemPort: 9401};
      controller.debuggerOutputPattern = `${first}/**/*.mjs`;
      const old = {id: "old", name: "OSD: ABAP (9401)"};
      listeners.start.forEach((fn) => fn(old));
      api.debug.stopDebugging = () => new Promise(() => {});
      const refresh = controller.refreshDebuggerGeneration();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(api.debug.started, "not while the old session is still there").to.have.length(0);
      listeners.end.forEach((fn) => fn(old));
      await refresh;
      expect(api.debug.started).to.have.length(1);
      expect(lines.some((line) => line.includes("did not stop within 80 ms"))).to.equal(true);
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  });

  it("the debugger on demand says why it cannot attach: not running, or the door refused", async () => {
    const api = debugApi();
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    expect(await controller.attachSystemDebugger({onDemand: true})).to.equal(false);
    expect(controller.debuggerError).to.match(/not running; start it with osd: Start/);
    controller.launcher = fakeLauncher({async openInspector() {
      throw new Error("a debugger needs one work process, and this system runs 2 (OSD_WORKERS=1)");
    }});
    expect(await controller.attachSystemDebugger({onDemand: true})).to.equal(false);
    expect(controller.debuggerError).to.equal("could not open the inspector: a debugger needs one work process, and this system runs 2 (OSD_WORKERS=1)");
    expect(api.debug.started).to.deep.equal([]);
  });

  it("releases an inspector it opened once no .abap breakpoint is left, and keeps one opened at start", async () => {
    const api = debugApi();
    let terminated;
    api.debug.onDidTerminateDebugSession = (listener) => {
      terminated = listener;
      return {dispose() {}};
    };
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    controller.launcher = fakeLauncher();
    await controller.attachSystemDebugger({onDemand: true});
    api.debug.breakpoints = [new api.SourceBreakpoint("/w/src/zcl_osd_fleet_report.clas.abap")];
    expect(await controller.releaseDebugger(), "a breakpoint still wants it").to.equal(false);
    api.debug.breakpoints = [new api.SourceBreakpoint("/w/src/zcl_osd_fleet_report.clas.abap", false),
      new api.SourceBreakpoint("/w/tools/x.mjs")];
    // the last one gone while the session is attached (a paused request, a
    // Run with debugger): it stays until the session ends
    const session = {id: "release-test", name: "OSD: ABAP (9401)"};
    controller.debugSessions.add(session);
    controller.activeSystemSessionId = session.id;
    expect(await controller.releaseDebugger(), "the session is still in use").to.equal(false);
    expect(controller.launcher.calls).to.deep.equal(["open"]);
    // the session's own end is what releases it (the terminate handler)
    terminated(session);
    await controller.inspectorSteps;
    await controller.inspectorSteps;
    expect(controller.launcher.calls).to.deep.equal(["open", "close"]);
    expect(controller.debuggerState.systemPort, "detached").to.equal(undefined);
    // a system started with its inspector (osd.debug, OSD_INSPECT=1) keeps it
    controller.launcher = fakeLauncher({debug: true, inspectPort: 9402, inspectorOpen: true});
    expect(await controller.releaseDebugger()).to.equal(false);
    expect(controller.launcher.calls).to.deep.equal([]);
  });

  it("a breakpoint set in an .abap file opens the debugger, the last one removed releases it", async () => {
    const api = debugApi();
    let handler;
    api.debug.onDidChangeBreakpoints = (listener) => {
      handler = listener;
      return {dispose() {}};
    };
    const {debugOnDemand} = loadExtension(api);
    const calls = [];
    const controller = {
      launcher: {state: "running"},
      output: {appendLine() {}},
      attachSystemDebugger: async (options) => { calls.push(["attach", options]); return true; },
      releaseDebugger: async () => { calls.push(["release"]); return true; },
    };
    debugOnDemand({subscriptions: []}, () => controller);
    const document = {uri: {fsPath: "/w/src/zcl_osd_fleet_report.clas.abap"}, languageId: "abap"};
    expect(document.languageId).to.equal(JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"))
      .contributes.breakpoints[0].language);
    const abap = new api.SourceBreakpoint(document.uri.fsPath);
    handler({added: [new api.SourceBreakpoint("/w/tools/x.mjs")], removed: [], changed: []});
    expect(calls, "not an .abap file").to.deep.equal([]);
    handler({added: [abap], removed: [], changed: []});
    handler({added: [], removed: [abap], changed: []});
    handler({added: [], removed: [], changed: [new api.SourceBreakpoint("/w/src/zcl_osd_fleet_report.clas.abap", false)]});
    expect(calls).to.deep.equal([["attach", {onDemand: true}], ["release"], ["release"]]);
    controller.launcher.state = "stopped";
    handler({added: [abap], removed: [], changed: []});
    expect(calls, "nothing to attach to while stopped").to.have.length(3);
  });

  it("explains debugging on the first workspace ABAP breakpoint and remembers dismissal", () => {
    const api = debugApi(), saved = new Map(), messages = [];
    let changed;
    api.workspace.workspaceFolders = [{uri: {toString: () => "file:///workspace"}}];
    api.workspace.getWorkspaceFolder = uri => uri.fsPath.startsWith("/w/") ? {} : undefined;
    api.debug.onDidChangeBreakpoints = fn => { changed = fn; return {dispose() {}}; };
    api.window.showInformationMessage = (...args) => messages.push(args);
    const context = {subscriptions: [], globalState: {get: key => saved.get(key), update: async (key, value) => saved.set(key, value)}};
    const {debugOnboarding} = loadExtension(api);
    debugOnboarding(context);
    changed({added: [new api.SourceBreakpoint("/outside/z.clas.abap")]});
    changed({added: [new api.SourceBreakpoint("/w/x.mjs")]});
    expect(messages).to.have.length(0);
    changed({added: [new api.SourceBreakpoint("/w/z.clas.abap")]});
    changed({added: [new api.SourceBreakpoint("/w/z2.clas.abap")]});
    expect(messages).to.deep.equal([["osd debugs without a launch configuration: set a breakpoint and press F9 or ▷. 'Attach to server' / 'ABAP on server' belong to the ABAP-FS extension and SAP systems.", "Got it"]]);
    debugOnboarding(context);
    changed({added: [new api.SourceBreakpoint("/w/z.clas.abap")]});
    expect(messages).to.have.length(1);
    expect(api.debug.started).to.have.length(0);
  });

  it("never attaches on system Start, even with saved ABAP breakpoints and legacy debug enabled", async () => {
    const api = debugApi();
    api.debug.breakpoints = [new api.SourceBreakpoint("/w/z.clas.abap")];
    api.window.setStatusBarMessage = () => {};
    const controller = new (loadSystemController(api))(controllerContext(), {show() {}, appendLine() {}});
    const launcher = fakeLauncher({state: "stopped", debug: true, databaseLabel: "SQLite", async start() { this.state = "running"; return {port: 3100}; }});
    controller.ensureLauncher = async () => launcher;
    let attaches = 0;
    controller.attachSystemDebugger = async () => { attaches++; return true; };
    expect(await controller.start()).to.equal(true);
    expect(attaches).to.equal(0);
    expect(api.debug.started).to.have.length(0);
  });

  it("osd.debug is gone from the settings UI, and read silently for one release", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    expect(manifest.contributes.configuration.properties).to.not.have.property("osd.debug");
    expect(readFileSync(path.join(ROOT, "editors/vscode/extension.js"), "utf8")).to.contain('get("debug", false) === true');
  });

  it("quick start applies its preset and restarts a running controller before opening the overview", async () => {
    const api = vscodeStub();
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    controller.launcher = {state: "running"};
    const calls = [];
    controller.applyPreset = async (name) => calls.push(["preset", name]);
    controller.stop = async () => {
      calls.push(["stop"]);
      controller.launcher.state = "stopped";
    };
    controller.start = async () => {
      calls.push(["start"]);
      controller.launcher.state = "running";
      return true;
    };
    controller.openSystemOverview = async () => calls.push(["overview"]);

    await controller.quickStart("defaults");

    expect(calls).to.deep.equal([["preset", "defaults"], ["stop"], ["start"], ["overview"]]);
  });

  it("refreshes the launcher's workspace folders when VS Code changes them", () => {
    const api = vscodeStub({home: ROOT});
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    const folder = path.join(tmpdir(), "osd-workspace-folder-event");
    controller.launcher = {osdHome: ROOT, workspaceFolders: [folder], state: "running"};
    let changes = 0;
    controller.onDidChange(() => changes++);
    api.workspace.workspaceFolders = [{uri: {fsPath: ROOT}}];
    api.fireWorkspaceFoldersChanged();
    expect(controller.launcher.workspaceFolders).to.deep.equal([]);
    expect(changes).to.equal(1);
  });

  it("loads a running controller overview from its launcher port after osd.url changes", async () => {
    const api = vscodeStub({url: "http://localhost:5999", home: "", keymap: "abap"});
    const SystemController = loadSystemController(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    controller.launcher = {
      ...ownedLauncher, state: "running", port: 3542, osdHome: "/work/osd", homeKind: "osd.home", layers: [],
      databaseLabel: "SQLite", generation: "abc123",
    };
    const oldFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      const body = String(url).endsWith("/osd/serving")
        ? {ready: true, launcherPid: 12345, launcherIdentity: "test-owned", database: "/work/db/osd.sqlite", databaseIdentity: {engine: "sqlite", storage: "file"}, warm: {state: "primed"}}
        : {d: {results: []}};
      return {ok: true, status: 200, json: async () => body};
    };
    try {
      await controller.openSystemOverview();
    } finally {
      globalThis.fetch = oldFetch;
    }

    expect(requested).to.have.lengthOf(7);
    expect(requested.every((url) => url.startsWith("http://localhost:3542/"))).to.equal(true);
    expect(requested.some((url) => url.startsWith("http://localhost:5999/"))).to.equal(false);
    expect(api.externalUris).to.deep.equal([
      "http://localhost:3542/sap/bc/osd/sysinfo/",
      "http://localhost:3542/app/flp.html",
    ]);
    expect(api.panels[0].webview.html).to.contain("http://localhost:3542/app/flp.html");
    expect(api.panels.find((panel) => panel.args[0] === "osdSystemOverview").args[3].enableCommandUris)
      .to.include.members(["osd.openLaunchpad", "osd.openLaunchpadExternal"]);
  });

  it("renders stopped when a foreign server answers on the cached overview port", async () => {
    const foreign = express();
    foreign.get("/osd/serving", (_req, res) => res.json({
      ready: true, launcherPid: 54321, generation: "foreign-system",
      databaseIdentity: {engine: "foreign-database"},
    }));
    foreign.use((_req, res) => res.json({d: {results: [{Name: "foreign-system"}]}}));
    const server = await new Promise(resolve => {
      const listening = foreign.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const api = vscodeStub();
    const Controller = loadSystemController(api);
    const controller = new Controller(controllerContext(), {append() {}, appendLine() {}, show() {}});
    controller.launcher = {...ownedLauncher, state: "running", port: server.address().port, layers: []};
    try {
      await controller.openSystemOverview();
      const html = api.panels[0].webview.html;
      expect(html).to.include("Stopped").and.not.include("Running on port")
        .and.not.include("foreign-system").and.not.include("foreign-database");
      expect(api.externalUris).to.deep.equal([]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it("keeps the quick-start preset, DX2 home rule, and state menus in pure logic", () => {
    expect(Object.keys(PRESETS)).to.deep.equal(["defaults"]);
    expect(presetSettings("defaults")).to.deep.equal({home: "auto", database: "sqlite", warm: "auto", keymap: "abap"});
    expect(isOpenSteamgateCheckout({name: "open-steamgate"}, {buildScript: true, vscodeExtension: true})).to.equal(true);
    expect(isOpenSteamgateCheckout({name: "another-project"}, {buildScript: true, vscodeExtension: true})).to.equal(false);
    expect(osdHomeChoice({bundledHome: "/storage/osd", bundledAvailable: true,
      workspaces: [{path: "/work/osd", isOpenSteamgate: true}]})).to.deep.equal({path: "/work/osd", kind: "osd.home"});
    expect(osdHomeChoice({homeMode: "open-steamgate", bundledHome: "/storage/osd", bundledAvailable: true,
      workspaces: [{path: "/work/osd", isOpenSteamgate: true}]})).to.deep.equal({path: "/work/osd", kind: "osd.home"});
    expect(osdHomeChoice({bundledHome: "/storage/osd", bundledAvailable: true,
      workspaces: [{path: "/work/app"}]})).to.deep.equal({path: "/storage/osd", kind: "bundled copy"});
    expect(osdHomeChoice({configuredHome: "/configured/osd", bundledHome: "/storage/osd", bundledAvailable: true,
      workspaces: [{path: "/work/osd", isOpenSteamgate: true}]})).to.deep.equal({path: "/configured/osd", kind: "osd.home"});
    expect(["stopped", "running", "building", "starting"].map(osdStateContext)).to.deep.equal([
      "osd-state-stopped", "osd-state-running", "osd-state-building", "osd-state-building",
    ]);
  });

  it("builds an overview from the live serving and OData status values", () => {
    const model = systemOverviewModel({
      state: "running",
      launcher: {port: 3542, osdHome: "/storage/osd", layers: [{folder: "/workspace/layer"}]},
      homeKind: "bundled copy",
      serving: {ready: true, database: "/storage/db/osd.sqlite", databaseIdentity: {engine: "sqlite", storage: "file"}, warm: {state: "primed", swaps: 2}},
      status: {system: [{Sid: "OSD", GenServing: "abc123"}], processes: [{Pid: "42"}], ports: [{Port: "3542"}],
        services: [{Path: "/app/flp.html"}], packs: [{Name: "demo"}], database: [{name: "Engine", value: "sqlite"}]},
      baseUrl: "http://localhost:3542",
      keymap: "abap",
      extensionVersion: "0.2.0-test",
    });
    expect(model).to.include({state: "running", running: true, keymap: "abap"});
    expect(model.extensionVersion).to.equal("0.2.0-test");
    expect(model.listener).to.include({port: 3542, url: "http://localhost:3542"});
    expect(model.launchpadUrl).to.equal("http://localhost:3542/app/flp.html");
    expect(model.home).to.deep.equal({kind: "bundled copy", path: "/storage/osd"});
    expect(model.layers).to.deep.equal(["/workspace/layer"]);
    expect(model.database).to.deep.equal({engine: "sqlite", storage: "file", path: "/storage/db/osd.sqlite", source: "/osd/serving"});
    expect(model.warm).to.deep.equal({state: "primed", swaps: 2});
    expect(model.status.services[0].Path).to.equal("/app/flp.html");
    expect(model.sources.status).to.deep.equal({
      system: "/sap/opu/odata/sap/ZOSD_STATUS_SRV/SystemSet?$format=json",
      processes: "/sap/opu/odata/sap/ZOSD_STATUS_SRV/ProcessSet?$format=json",
      ports: "/sap/opu/odata/sap/ZOSD_STATUS_SRV/PortSet?$format=json",
      services: "/sap/opu/odata/sap/ZOSD_STATUS_SRV/ServiceSet?$format=json",
      packs: "/sap/opu/odata/sap/ZOSD_STATUS_SRV/PackSet?$format=json",
      database: "/sap/opu/odata/sap/ZOSD_STATUS_SRV/DatabaseSet?$format=json",
    });
    expect(model.sources.sysinfo).to.equal("/sap/bc/osd/sysinfo/");
    const html = systemOverviewHtml(model, {sysinfoUrl: "http://localhost:3542/sap/bc/osd/sysinfo/"});
    expect(html).to.contain("/storage/db/osd.sqlite");
    expect(html).to.contain("<strong>Extension version</strong><span>0.2.0-test</span>");
    expect(html).to.contain("primed");
    expect(html).to.contain("System information app");
    expect(html).to.contain("portable (limited) on sqlite");
    expect(html).to.contain("<iframe");
    // Q7: its launchpad buttons are the extension's own commands, not a browser link
    expect(html).to.contain('href="command:osd.openLaunchpad"').and.to.contain('href="command:osd.openLaunchpadExternal"');
    expect(html).to.not.contain('target="_blank"');
    expect(overviewStatusSection("Services", model.status.services)).to.contain("/app/flp.html");
    // OData plumbing is not shown: __metadata and all-deferred navigation columns
    const plumbed = [
      {__metadata: {uri: "x"}, Name: "a", Pack: {__deferred: {uri: "y"}}},
      {__metadata: {uri: "z"}, Name: "b", Pack: {__deferred: {uri: "w"}}},
    ];
    const table = overviewStatusSection("Services", plumbed);
    expect(table).to.contain("<th>Name</th>");
    expect(table).not.to.contain("__metadata");
    expect(table).not.to.contain("__deferred");
    // one row reads down as field / value
    const single = overviewStatusSection("System", [{Sid: "OSD", Port: 3531}]);
    expect(single).to.contain('class="record"');
    expect(single).to.contain("<tr><th>Sid</th><td>OSD</td></tr>");
    // sections are stacked, not two to a row

    const stopped = systemOverviewModel({state: "stopped", launcher: {port: 3532}, baseUrl: "http://localhost:3532", homeKind: "osd.home", homePath: "/work/osd", layers: ["/work/app"]});
    expect(stopped.running).to.equal(false);
    expect(stopped.listener).to.include({port: undefined, url: undefined});
    expect(stopped.launchpadUrl).to.equal(undefined);
    expect(stopped.home.path).to.equal("/work/osd");
    expect(systemOverviewHtml(stopped)).to.contain("Start system");
    const statusFallback = systemOverviewModel({state: "running", launcher: {port: 3542}, status: {
      database: [{Name: "Engine", Value: "sqlite"}, {Name: "Storage", Value: "file"}],
    }});
    expect(statusFallback.database).to.include({engine: "sqlite", storage: "file"});
  });

  it("validates every walkthrough markdown entry in package.json", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    const walkthroughs = manifest.contributes.walkthroughs;
    expect(walkthroughs).to.have.lengthOf(1);
    expect(manifest.contributes.commands.some((command) => command.command === "osd.gettingStarted" && command.title === "osd: Getting started")).to.equal(true);
    expect(manifest.contributes.commands.some((command) => command.command === "osd.quickStart")).to.equal(true);
    expect(manifest.contributes.commands.some((command) => command.command === "osd.openSystemOverview")).to.equal(true);
    const itemMenu = manifest.contributes.menus["view/item/context"];
    for (const state of ["stopped", "running", "building"]) {
      expect(itemMenu.some((item) => item.when.includes(`viewItem == osd-state-${state}`)), state).to.equal(true);
    }
    const stateItems = itemMenu.filter((item) => item.when.includes("viewItem == osd-state-"));
    expect(stateItems.length).to.be.greaterThan(0);
    expect(stateItems.every((item) => item.group !== "inline" && !item.group?.startsWith("inline@"))).to.equal(true);
    const actionsFor = (state) => stateItems.filter((item) => item.when.includes(`viewItem == osd-state-${state}`)).map((item) => item.command);
    expect(actionsFor("stopped")).to.include.members(["osd.start", "osd.fullRebuild"]);
    expect(actionsFor("running")).to.include.members(["osd.stop", "osd.rebuildWarm", "osd.fullRebuild", "osd.openLaunchpad", "osd.openSystemLog"]);
    expect(actionsFor("building")).to.include.members(["osd.openSystemLog", "osd.stop"]);
    for (const walkthrough of walkthroughs) {
      expect(walkthrough.steps[0].id).to.equal("quickStart");
      for (const step of walkthrough.steps) {
        const media = readFileSync(path.join(ROOT, "editors/vscode", step.media.markdown), "utf8");
        expect(media).not.to.equal("");
        // Media can disappear with both sidebars open. Every action offered
        // there must also be reachable in the always-visible step description.
        for (const link of media.matchAll(/\[[^\]]+\]\((command:osd\.[^)]+)\)/g)) {
          expect(step.description, `${step.id}: ${link[1]}`).to.contain(`](${link[1]})`);
        }
        if (step.id === "quickStart") {
          expect(step.description).to.contain("[Start with the defaults](command:osd.quickStart)");
          expect(media).to.contain("[Start with the defaults](command:osd.quickStart)");
        }
        if (step.id === "startSystem") expect(step.description).to.contain("](command:osd.start)");
      }
    }
  });

  it("contributes each configuration key and command only once", () => {
    const source = readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8");
    const manifest = JSON.parse(source);
    // JSON.parse keeps the last value of a duplicate key, so inspect the
    // declarations in the source before that information is lost.
    const properties = source.slice(source.indexOf('"properties": {'), source.indexOf('"notebooks": ['));
    const keys = [...properties.matchAll(/^\s*"((?:osd|osg)\.[^"]+)":\s*\{/gm)].map((match) => match[1]);
    expect(keys).to.have.lengthOf(Object.keys(manifest.contributes.configuration.properties).length);
    expect(new Set(keys).size).to.equal(keys.length);
    const commands = manifest.contributes.commands.map(({command}) => command);
    expect(new Set(commands).size).to.equal(commands.length);
  });

  it("reads all six existing status OData sets for the overview", async () => {
    const routes = [];
    const client = new Osd("http://localhost:3531", async (url) => {
      routes.push(new URL(url).pathname + new URL(url).search);
      const set = new URL(url).pathname.split("/").at(-1).replace("Set", "").toLowerCase();
      return {ok: true, json: async () => ({d: {results: [{set}]}})};
    });
    const status = await client.systemStatus();
    expect(Object.keys(status)).to.deep.equal(Object.keys(SYSTEM_STATUS_SETS));
    expect(status.system).to.deep.equal([{set: "system"}]);
    expect(routes).to.have.lengthOf(6);
    expect(routes).to.include("/sap/opu/odata/sap/ZOSD_STATUS_SRV/SystemSet?$format=json");
    expect(odataV2Results({d: {Sid: "OSD"}})).to.deep.equal([{Sid: "OSD"}]);
  });

  it("names the object and include of an abapGit file", () => {
    expect(objectOf("/x/zcl_a.clas.testclasses.abap")).to.deep.equal({type: "CLAS", name: "ZCL_A", base: "zcl_a", include: "testclasses"});
    expect(objectOf("zcl_a.clas.abap").include).to.equal("main");
    expect(objectOf("#ns#zcl_a.clas.locals_imp.abap")).to.include({name: "/NS/ZCL_A", include: "implementations"});
    expect(objectOf("zprog.prog.abap")).to.include({type: "PROG", name: "ZPROG"});
    expect(objectOf("zif_a.intf.abap")).to.equal(undefined);
  });

  it("finds an include's file beside another file of the object", () => {
    const object = objectOf("zcl_a.clas.abap");
    expect(fileOf("/d", object, "testclasses")).to.equal("/d/zcl_a.clas.testclasses.abap");
    expect(fileOf("/d", object, "main")).to.equal("/d/zcl_a.clas.abap");
    expect(fileOf("/d", object, "implementations")).to.equal("/d/zcl_a.clas.locals_imp.abap");
  });

  it("reads a run per method, the first ABAP frame as the place", () => {
    const run = {testClasses: [
      {name: "LTCL_A", alerts: [], testMethods: [
        {name: "OK", ms: 3, alerts: []},
        {name: "BAD", ms: 4, alerts: [{kind: "failedAssertion", title: "differ", details: ["Expected [1]", "Actual [2]"],
          stack: [{uri: "cl_abap_unit_assert.clas.abap", line: 0}, {uri: "zcl_a.clas.testclasses.abap", line: 12, column: 5}]}]},
      ]},
      {name: "LTCL_SETUP", alerts: [{kind: "exception", title: "class_setup", details: [], stack: []}], testMethods: []},
    ]};
    const got = outcomes(run, [{testClass: "LTCL_SETUP", method: "M1"}]);
    expect(got.map((r) => [r.testClass, r.method, r.passed])).to.deep.equal([
      ["LTCL_A", "OK", true], ["LTCL_A", "BAD", false], ["LTCL_SETUP", "M1", false]]);
    expect(got[1].alerts[0].frame).to.deep.equal({file: "zcl_a.clas.testclasses.abap", line: 12, column: 5});
    expect(abapFrame({stack: []})).to.equal(undefined);
  });

  it("names the object of a file Check/Activate can reach, interfaces included", () => {
    expect(adtObjectOf("/x/zcl_a.clas.testclasses.abap")).to.deep.equal({type: "CLAS", name: "ZCL_A", base: "zcl_a", include: "testclasses"});
    expect(adtObjectOf("zif_a.intf.abap")).to.deep.equal({type: "INTF", name: "ZIF_A", base: "zif_a", include: "main"});
    expect(adtObjectOf("zprog.prog.abap")).to.include({type: "PROG", name: "ZPROG"});
    expect(adtObjectOf("readme.md")).to.equal(undefined);
  });

  it("builds an object's own ADT URI the way tools/adt-documents.mjs does, and refuses a type it does not know", () => {
    expect(uriOf({type: "CLAS", base: "zcl_a"})).to.equal(facadeUriOf("CLAS", "zcl_a"));
    expect(uriOf({type: "INTF", base: "zif_a"})).to.equal(facadeUriOf("INTF", "zif_a"));
    expect(uriOf({type: "PROG", base: "zprog"})).to.equal(facadeUriOf("PROG", "zprog"));
    expect(() => uriOf({type: "FUGR", base: "zfg"})).to.throw(/FUGR/);
  });

  it("Ctrl+F2: reads a check run's diagnostics off checkReportDocument's real shape", () => {
    const clean = parseCheckReport(checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_a", issues: []}]));
    expect(clean).to.deep.equal([{uri: "/sap/bc/adt/oo/classes/zcl_a", status: "processed", statusText: "no errors", issues: []}]);

    const broken = parseCheckReport(checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_a", issues: [
      {severity: "E", message: "\"X\" is not defined", line: 12, column: 5},
      {severity: "W", message: "unused variable", line: 3, column: 1},
    ]}]));
    expect(broken).to.have.lengthOf(1);
    expect(broken[0].statusText).to.equal("2 error(s)");
    expect(broken[0].issues).to.deep.equal([
      {line: 12, column: 5, severity: "E", message: '"X" is not defined'},
      {line: 3, column: 1, severity: "W", message: "unused variable"},
    ]);

    // a check that could not run: no issues, but not a clean pass either
    const notProcessed = parseCheckReport(checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_x", issues: [], status: "notProcessed", statusText: "ZCL_X does not exist"}]));
    expect(notProcessed[0]).to.include({status: "notProcessed", statusText: "ZCL_X does not exist"});
  });

  it("Ctrl+F3: tells a clean activation from a failed one, off the real activation documents", () => {
    expect(parseActivationResult(activationSuccessDocument())).to.deep.equal({ok: true, issues: []});

    const failed = parseActivationResult(activationFailureDocument([
      {type: "CLAS", name: "ZCL_A", issues: [{severity: "E", message: "Syntax error", line: 7, column: 3}]},
    ]));
    expect(failed.ok).to.equal(false);
    expect(failed.issues).to.deep.equal([
      {href: "", severity: "W", line: 0, column: 1, objDescr: "", message: "Activation was cancelled."},
      {href: "/sap/bc/adt/oo/classes/zcl_a/source/main#start=7,3", severity: "E", line: 7, column: 3, objDescr: "Class ZCL_A", message: "Syntax error"},
    ]);
  });

  for (const nextResult of ["success", "failure B only"]) {
    it(`Ctrl+F3 command: href diagnostics on each document; ${nextResult} clears stale files`, async () => {
      let xml = activationFailureDocument([
        {type: "CLAS", name: "ZCL_A", issues: [
          {severity: "E", message: "Main syntax error", line: 7, column: 3},
          {severity: "E", message: "Test syntax error", file: "zcl_a.clas.testclasses.abap", line: 11, column: 5},
          {severity: "W", message: "Local warning", file: "zcl_a.clas.locals_imp.abap", line: 4, column: 2},
        ]},
        {type: "PROG", name: "X", issues: [{severity: "E", message: "Program syntax error", line: 8, column: 6}]},
      ]);
      const app = express();
      app.head("/sap/bc/adt/core/discovery", (_req, res) => res.set("x-csrf-token", "test-token").end());
      app.post("/sap/bc/adt/activation", (_req, res) => res.type("application/xml").send(xml));
      app.post("/sap/bc/adt/checkruns", (_req, res) => res.type("application/xml").send(
        checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_a", issues: []}])));
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      try {
        const api = vscodeStub({url: `http://127.0.0.1:${server.address().port}`});
        const handlers = new Map(), collections = new Map(), output = [];
        api.commands.registerCommand = (name, handler) => { handlers.set(name, handler); return {dispose() {}}; };
        api.languages = {createDiagnosticCollection: (name) => {
          const problems = new Map();
          collections.set(name, problems);
          return {set: (uri, issues) => problems.set(uri.fsPath, issues), dispose() {}};
        }};
        api.DiagnosticSeverity = {Error: 0, Warning: 1, Information: 2};
        api.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, {range, message, severity}); } };
        api.Position = class {
          constructor(line, character) { Object.assign(this, {line, character}); }
          translate(line, character) { return new api.Position(this.line + line, this.character + character); }
        };
        const activeFile = "/project/zcl_a.clas.testclasses.abap";
        api.window.activeTextEditor = {document: {fileName: activeFile, uri: api.Uri.file(activeFile), isDirty: false, getText: () => ""}};
        api.workspace.findFiles = async (pattern) => pattern === "**/x.prog.abap" ? [api.Uri.file("/other/x.prog.abap")] : [];
        loadExtension(api).registerCheckActivateCommands({subscriptions: []}, {appendLine: (line) => output.push(line)});
        const problems = collections.get("osd-activation");
        await handlers.get("osd.activate")();
        const actual = [...problems].filter(([, issues]) => issues.length).map(([file, issues]) => [file,
          issues.map((issue) => [issue.message, issue.range.start.line, issue.range.start.character, issue.severity])]);
        expect(actual).to.have.deep.members([
          ["/project/zcl_a.clas.abap", [["Main syntax error", 6, 2, 0]]],
          [activeFile, [["Test syntax error", 10, 4, 0]]],
          ["/project/zcl_a.clas.locals_imp.abap", [["Local warning", 3, 1, 1]]],
          ["/other/x.prog.abap", [["Program syntax error", 7, 5, 0]]],
        ]);
        expect(output.join("\n")).to.contain("Activation was cancelled.");
        expect(output.join("\n")).not.to.contain("also broke");

        // Activation belongs to the object, even if another include is now open.
        const mainFile = "/project/zcl_a.clas.abap";
        api.window.activeTextEditor = {document: {fileName: mainFile, uri: api.Uri.file(mainFile), isDirty: false, getText: () => ""}};
        xml = nextResult === "success" ? activationSuccessDocument() : activationFailureDocument([
          {type: "PROG", name: "X", issues: [{severity: "E", message: "Remaining program error", line: 9, column: 2}]},
        ]);
        await handlers.get("osd.activate")();
        const remaining = [...problems].filter(([, issues]) => issues.length).map(([file, issues]) =>
          [file, issues.map((issue) => issue.message)]);
        expect(remaining).to.deep.equal(nextResult === "success" ? [] : [
          ["/other/x.prog.abap", ["Remaining program error"]],
        ]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }

  it("Ctrl+F3 command: retrying one scope preserves newer diagnostics owned by another", async () => {
    let xml = activationFailureDocument([
      {type: "CLAS", name: "ZCL_Y", issues: [{severity: "E", message: "Error from X", line: 7, column: 3}]},
    ]);
    const app = express();
    app.head("/sap/bc/adt/core/discovery", (_req, res) => res.set("x-csrf-token", "test-token").end());
    app.post("/sap/bc/adt/activation", (_req, res) => res.type("application/xml").send(xml));
    app.post("/sap/bc/adt/checkruns", (_req, res) => res.type("application/xml").send(
      checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_x", issues: []}])));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const api = vscodeStub({url: `http://127.0.0.1:${server.address().port}`});
      const handlers = new Map(), collections = new Map();
      api.commands.registerCommand = (name, handler) => { handlers.set(name, handler); return {dispose() {}}; };
      api.languages = {createDiagnosticCollection: (name) => {
        const problems = new Map();
        collections.set(name, problems);
        return {set: (uri, issues) => problems.set(uri.fsPath, issues), dispose() {}};
      }};
      api.DiagnosticSeverity = {Error: 0, Warning: 1, Information: 2};
      api.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, {range, message, severity}); } };
      api.Position = class {
        constructor(line, character) { Object.assign(this, {line, character}); }
        translate(line, character) { return new api.Position(this.line + line, this.character + character); }
      };
      const select = (fileName) => {
        api.window.activeTextEditor = {document: {fileName, uri: api.Uri.file(fileName), isDirty: false, getText: () => ""}};
      };
      const x = "/project/zcl_x.clas.abap", y = "/project/zcl_y.clas.abap";
      api.workspace.findFiles = async (pattern) => pattern === "**/zcl_y.clas.abap" ? [api.Uri.file(y)] : [];
      loadExtension(api).registerCheckActivateCommands({subscriptions: []}, {appendLine() {}});
      const problems = collections.get("osd-activation");
      select(x);
      await handlers.get("osd.activate")();
      expect(problems.get(y).map((issue) => issue.message)).to.deep.equal(["Error from X"]);

      select(y);
      xml = activationFailureDocument([
        {type: "CLAS", name: "ZCL_Y", issues: [{severity: "E", message: "Newer error from Y", line: 9, column: 2}]},
      ]);
      await handlers.get("osd.activate")();
      expect(problems.get(y).map((issue) => issue.message)).to.deep.equal(["Newer error from Y"]);

      select(x);
      xml = activationSuccessDocument();
      await handlers.get("osd.activate")();
      expect(problems.get(x)).to.deep.equal([]);
      expect(problems.get(y).map((issue) => issue.message)).to.deep.equal(["Newer error from Y"]);

      select(y);
      await handlers.get("osd.activate")();
      expect(problems.get(y)).to.deep.equal([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  for (const first of ["check", "activation"]) {
    it(`check/activation diagnostic isolation: ${first} findings survive the other command succeeding`, async () => {
      let checkIssues = first === "check" ? [{severity: "E", message: "Check error", line: 5, column: 2}] : [];
      const activationXml = first === "activation" ? activationFailureDocument([
        {type: "CLAS", name: "ZCL_A", issues: [{severity: "E", message: "Activation error", line: 7, column: 3}]},
      ]) : activationSuccessDocument();
      const app = express();
      app.head("/sap/bc/adt/core/discovery", (_req, res) => res.set("x-csrf-token", "test-token").end());
      app.post("/sap/bc/adt/activation", (_req, res) => res.type("application/xml").send(activationXml));
      app.post("/sap/bc/adt/checkruns", (_req, res) => res.type("application/xml").send(
        checkReportDocument([{uri: "/sap/bc/adt/oo/classes/zcl_a", issues: checkIssues}])));
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      try {
        const api = vscodeStub({url: `http://127.0.0.1:${server.address().port}`});
        const handlers = new Map(), collections = new Map(), output = [];
        api.commands.registerCommand = (name, handler) => { handlers.set(name, handler); return {dispose() {}}; };
        api.languages = {createDiagnosticCollection: (name) => {
          const problems = new Map();
          collections.set(name, problems);
          return {set: (uri, issues) => problems.set(uri.fsPath, issues), dispose() {}};
        }};
        api.DiagnosticSeverity = {Error: 0, Warning: 1, Information: 2};
        api.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, {range, message, severity}); } };
        api.Position = class {
          constructor(line, character) { Object.assign(this, {line, character}); }
          translate(line, character) { return new api.Position(this.line + line, this.character + character); }
        };
        api.window.setStatusBarMessage = () => {};
        const file = "/project/zcl_a.clas.abap";
        api.window.activeTextEditor = {document: {fileName: file, uri: api.Uri.file(file), isDirty: false, getText: () => ""}};
        loadExtension(api).registerCheckActivateCommands({subscriptions: []}, {appendLine: (line) => output.push(line)});
        const checks = collections.get("osd-abap"), activations = collections.get("osd-activation");
        expect(checks).not.to.equal(activations);
        // A failed activation is expected to show an error to the user.
        api.window.showErrorMessage = () => {};
        const owner = first === "check" ? checks : activations;
        const message = first === "check" ? "Check error" : "Activation error";
        await handlers.get(first === "check" ? "osd.check" : "osd.activate")();
        const original = owner.get(file);
        expect(original.map((issue) => issue.message)).to.deep.equal([message]);

        // Successful activation also runs a clean post-activation check.
        checkIssues = [];
        await handlers.get(first === "check" ? "osd.activate" : "osd.check")();
        expect(owner.get(file), "the other command preserves the original diagnostics").to.equal(original);
        const other = first === "check" ? activations : checks;
        expect(other.get(file)).to.deep.equal([]);
        expect([...other.values()].flat()).to.deep.equal([]);
        expect(output.join("\n")).not.to.contain("post-activation check:");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }

  it("SE80's F8, one entry per object type: what this build does, or the route its turn would use", () => {
    expect(runActionFor({type: "CLAS", name: "ZCL_DEMO"}, {hasUnitTests: true})).to.deep.equal({kind: "nothing-to-run", text: "Nothing to run for ZCL_DEMO. Tests: Ctrl+Shift+F10."});
    expect(runActionFor({type: "CLAS", name: "ZCL_DEMO"}, {hasUnitTests: false}).kind).to.equal("nothing-to-run");
    // a service's own class, cursor outside any entity-set method: F8 there
    // means a Gateway client -- still not yet
    const dpc = runActionFor({type: "CLAS", name: "ZCL_ZSTG_DEMO_DPC_EXT"}, {hasUnitTests: true});
    expect(dpc.kind).to.equal("not-yet");
    expect(dpc.text).to.contain("get_entityset");
    const mpc = runActionFor({type: "CLAS", name: "ZCL_ZSTG_DEMO_MPC_EXT"}, {hasUnitTests: true});
    expect(mpc.kind).to.equal("not-yet");
    // Q2b: cursor inside a known entity-set method does what its lens does
    const inside = runActionFor({type: "CLAS", name: "ZCL_ZSTG_DEMO_DPC_EXT"},
      {hasUnitTests: true, entitySet: {service: "ZSTG_DEMO_SRV", set: "TravelSet", entityKind: "get_entityset"}});
    expect(inside).to.deep.equal({kind: "call-entityset", service: "ZSTG_DEMO_SRV", set: "TravelSet", entityKind: "get_entityset"});
    expect(runActionFor({type: "INTF", name: "ZIF_A"})).to.deep.equal({kind: "not-yet", text: "not yet: an interface has nothing of its own to run"});
    expect(runActionFor({type: "FUGR", name: "ZFG"}).text).to.contain("/sap/bc/osd/rfc/functions/<NAME>");
    expect(runActionFor({type: "TABL", name: "ZSTG_DEMO"})).to.deep.equal({kind: "data-preview", objectType: "TABL", name: "ZSTG_DEMO"});
    expect(runActionFor({type: "DDLS", name: "ZC_STG_DEMO"})).to.deep.equal({kind: "data-preview", objectType: "DDLS", name: "ZC_STG_DEMO"});
    expect(runActionFor({type: "IWSV", name: "ZSTG_DEMO_SRV"}).text).to.equal("not yet: the Gateway client on the service document");
    expect(runActionFor({type: "SICF", name: "ZOSD_APP"}).kind).to.equal("not-yet");
    expect(runActionFor({type: "BOGUS", name: "X"}).text).to.contain("BOGUS");
  });

  it("0.5 O: F8 on a report runs it as a command; Run with debugger keeps Easy Access", () => {
    expect(runActionFor({type: "PROG", name: "ZNOTES"}, {file: "/w/znotes.prog.abap"})).to.deep.equal({kind: "cli", file: "/w/znotes.prog.abap"});
    expect(runActionFor({type: "PROG", name: "ZNOTES"}, {file: "/w/znotes.prog.abap", forceDebugger: true})).to.deep.equal({kind: "webgui", tcode: "ZGUI_NOTES"});
    // no file known (a caller that does not say): the Easy Access answer as before
    expect(runActionFor({type: "PROG", name: "ZNOTES"}).kind).to.equal("webgui");
  });

  it("0.5 O: the terminal line is node on the checkout's bin/osd.mjs, quoted", () => {
    if (process.platform === "win32") return;
    expect(osdRunCommandLine({home: "/h/my osd", file: "/w/it's.prog.abap"}))
      .to.equal("'node' '/h/my osd/bin/osd.mjs' run '/w/it'\\''s.prog.abap'");
  });

  it("0.5 O: F8 on a report asks for arguments, saves the buffer and runs osd run in a terminal of its own", async () => {
    const api = vscodeStub({home: ROOT});
    const terminals = [];
    let asked = "--add hello -db notes.db";
    api.window.showInputBox = async (options) => { api.lastInput = options; return asked; };
    api.window.createTerminal = (options) => {
      const terminal = {options, lines: [], shown: false, sendText(line) { this.lines.push(line); }, show() { this.shown = true; }};
      terminals.push(terminal);
      return terminal;
    };
    const {runReportInTerminal} = loadExtension(api);
    let saved = 0;
    const editor = {document: {fileName: "/w/znotes.prog.abap", isDirty: true, save: async () => { saved++; }}};
    const output = {appendLine() {}};
    await runReportInTerminal("ZNOTES", editor, output);
    expect(saved).to.equal(1);
    expect(terminals).to.have.length(1);
    expect(terminals[0].options).to.deep.equal({name: "osd run ZNOTES", cwd: ROOT});
    expect(terminals[0].shown).to.equal(true);
    expect(terminals[0].lines[0]).to.contain(`${path.join(ROOT, "bin", "osd.mjs")}' run '/w/znotes.prog.abap' -- --add hello -db notes.db`);
    // the last arguments are offered again; empty runs the selection screen
    asked = "";
    await runReportInTerminal("ZNOTES", editor, output);
    expect(api.lastInput.value).to.equal("--add hello -db notes.db");
    expect(terminals[1].lines[0]).to.match(/run '\/w\/znotes\.prog\.abap'$/);
    // Escape cancels: no terminal
    asked = undefined;
    await runReportInTerminal("ZNOTES", editor, output);
    expect(terminals).to.have.length(2);
  });

  it("0.5 O: without a checkout to build in, F8 on a report falls back to Easy Access instead of a terminal", async () => {
    const api = vscodeStub({home: tmpdir()});
    const lines = [];
    api.window.createTerminal = () => { throw new Error("must not open a terminal"); };
    api.window.showInputBox = async () => { throw new Error("must not ask"); };
    const {runReportInTerminal} = loadExtension(api);
    const ran = await runReportInTerminal("ZNOTES", {document: {fileName: "/w/znotes.prog.abap"}}, {appendLine: (line) => lines.push(line)});
    expect(ran).to.equal(false);
    expect(lines[0]).to.contain("opening it in Easy Access");
  });

  // ---- Q6b "Classrun": F9, ADT's "Run as ABAP Application (Console)" --
  // implementsClassrun (the buffer scan F8's dispatch and osd-classrun.mjs's
  // server-side check both run) and the dispatch itself, held to the same
  // shape lib.js's own RUN_TABLE test above holds every other kind to.
  it("Q6b: a class buffer declaring IF_OO_ADT_CLASSRUN, off the source text alone", () => {
    const demo = readFileSync(new URL("../src/classrun/zcl_osd_classrun_demo.clas.abap", import.meta.url), "utf8");
    expect(implementsClassrun(demo)).to.equal(true);
    expect(implementsClassrun("CLASS zcl_x DEFINITION.\nENDCLASS.")).to.equal(false);
    // case- and whitespace-insensitive, the way an ABAP statement is
    expect(implementsClassrun("  interfaces   if_oo_adt_classrun .")).to.equal(true);
    // a class that merely names the interface in a comment does not count
    expect(implementsClassrun("* interfaces if_oo_adt_classrun would go here")).to.equal(false);
    // the two implementations (the editor's buffer scan and the façade's
    // own file scan, tools/osd-classrun.mjs) agree on the same fixture
    expect(facadeImplementsClassrun(demo)).to.equal(implementsClassrun(demo));
  });

  it("Q6b: F8 runs classrun regardless of tests and never dispatches to ABAP Unit", () => {
    expect(runActionFor({type: "CLAS", name: "ZCL_OSD_CLASSRUN_DEMO"}, {hasUnitTests: false, hasClassrun: true}))
      .to.deep.equal({kind: "classrun"});
    // Classrun runs even when the class carries tests
    expect(runActionFor({type: "CLAS", name: "ZCL_OSD_CLASSRUN_DEMO"}, {hasUnitTests: true, hasClassrun: true}))
      .to.deep.equal({kind: "classrun"});
    // Neither: explain how to run tests independently
    expect(runActionFor({type: "CLAS", name: "ZCL_DEMO"}, {hasUnitTests: false, hasClassrun: false}))
      .to.deep.equal({kind: "nothing-to-run", text: "Nothing to run for ZCL_DEMO. Tests: Ctrl+Shift+F10."});
    // An explicit classrun interface also runs on a DPC_EXT
    const dpc = runActionFor({type: "CLAS", name: "ZCL_ZSTG_DEMO_DPC_EXT"}, {hasUnitTests: false, hasClassrun: true});
    expect(dpc).to.deep.equal({kind: "classrun"});
  });

  // ---- Q2b "Runner": the CodeLens over a SEGW _DPC_EXT class's own
  // `<set>_get_entityset` / `<set>_get_entity` methods, and F8 doing what
  // the lens above the cursor's own method does.

  it("Q2b: a lens line over each METHOD <set>_get_entityset. / <set>_get_entity. line, none elsewhere", () => {
    const source = [
      "CLASS zcl_x IMPLEMENTATION.",
      "  METHOD travelset_get_entityset.",
      "    \" body",
      "  ENDMETHOD.",
      "  METHOD travelset_get_entity.",
      "  ENDMETHOD.",
      "  METHODS travelset_get_entityset REDEFINITION.", // a declaration, not the body: no line for this
      "  METHOD other_method.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    expect(entitySetMethodLines(source)).to.deep.equal([
      {line: 2, method: "TRAVELSET_GET_ENTITYSET", kind: "get_entityset"},
      {line: 5, method: "TRAVELSET_GET_ENTITY", kind: "get_entity"},
    ]);
  });

  it("Q2b: a lens only for a method the server's map names, titled with the set's real name", () => {
    const source = [
      "  METHOD travelset_get_entityset.",
      "  ENDMETHOD.",
      "  METHOD bookingset_get_entityset.", // the server does not know this one
      "  ENDMETHOD.",
    ].join("\n");
    const map = {service: "ZSTG_DEMO_SRV", sets: [{method: "TRAVELSET_GET_ENTITYSET", kind: "get_entityset", set: "TravelSet"}]};
    expect(entitySetLenses(source, map)).to.deep.equal([
      {line: 1, kind: "get_entityset", set: "TravelSet", service: "ZSTG_DEMO_SRV", title: "▶ Call TravelSet"},
    ]);
    expect(entitySetLenses(source, undefined)).to.deep.equal([]);
  });

  it("Q2b: the method a cursor's (0-based) line sits inside, cleared by the ENDMETHOD that closes it", () => {
    const source = [
      "  METHOD travelset_get_entityset.", // 0
      "    DATA lv TYPE i.",               // 1
      "  ENDMETHOD.",                      // 2
      "  METHOD travelset_get_entity.",    // 3
      "  ENDMETHOD.",                      // 4
      "  DATA gv TYPE i.",                 // 5, between methods
    ].join("\n");
    expect(methodAtLine(source, 0)).to.equal("TRAVELSET_GET_ENTITYSET");
    expect(methodAtLine(source, 1)).to.equal("TRAVELSET_GET_ENTITYSET");
    expect(methodAtLine(source, 2)).to.equal(undefined);
    expect(methodAtLine(source, 3)).to.equal("TRAVELSET_GET_ENTITY");
    expect(methodAtLine(source, 5)).to.equal(undefined);
  });

  it("Q2b: an OData v2 answer's rows, the key predicate off __metadata, columns without it", () => {
    const setBody = {d: {results: [
      {__metadata: {uri: "http://x/TravelSet('T0001')"}, TravelId: "T0001", Description: "A"},
      {__metadata: {uri: "http://x/TravelSet('T0002')"}, TravelId: "T0002", Description: "B"},
    ]}};
    const rows = resultRows(setBody);
    expect(rows).to.have.lengthOf(2);
    expect(keyOf(rows[0])).to.equal("'T0001'");
    expect(stripMetadata(rows[0])).to.deep.equal({TravelId: "T0001", Description: "A"});

    const entityBody = {d: {__metadata: {uri: "http://x/BookingSet(TravelID='T0001',BookingID='0001')"}, TravelID: "T0001", BookingID: "0001"}};
    const one = resultRows(entityBody);
    expect(one).to.have.lengthOf(1);
    expect(keyOf(one[0])).to.equal("TravelID='T0001',BookingID='0001'");

    expect(resultRows({})).to.deep.equal([]);
    expect(keyOf({})).to.equal(undefined);
  });

  it("Q2b: end to end against the demo's own sources -- what a CodeLens gets is what tools/adt-facade.mjs answers", () => {
    const readSource = (name) => readFileSync(`src/demo/${name.toLowerCase()}.clas.abap`, "utf8");
    const registrations = [{dpc: "ZCL_ZSTG_DEMO_DPC_EXT", mpc: "ZCL_ZSTG_DEMO_MPC_EXT", external: "ZSTG_DEMO_SRV", service: "ZSTG_DEMO_SRV"}];
    const map = entitySetMapFor("ZCL_ZSTG_DEMO_DPC_EXT", registrations, readSource);
    expect(map.service).to.equal("ZSTG_DEMO_SRV");
    const dpcSource = readSource("ZCL_ZSTG_DEMO_DPC_EXT");
    const lenses = entitySetLenses(dpcSource, map);
    expect(lenses.map((l) => l.title)).to.include("▶ Call TravelSet");
    const travel = lenses.find((l) => l.kind === "get_entityset" && l.set === "TravelSet");
    expect(dpcSource.split(/\r\n|\r|\n/)[travel.line - 1]).to.match(/METHOD travelset_get_entityset\.\s*$/i);
    // and F8 with the cursor on that same line does the same as the lens
    const entitySet = {service: map.service, set: travel.set, entityKind: travel.kind};
    expect(runActionFor({type: "CLAS", name: "ZCL_ZSTG_DEMO_DPC_EXT"}, {hasUnitTests: false, entitySet}))
      .to.deep.equal({kind: "call-entityset", service: "ZSTG_DEMO_SRV", set: "TravelSet", entityKind: "get_entityset"});
  });

  it("Q2b: STG-generated MPC set creation maps a workspace DPC method to F8 and CodeLens", () => {
    const dpcSource = [
      "CLASS zcl_zosd_fleet_dpc_ext IMPLEMENTATION.",
      "  METHOD voyageset_get_entityset.",
      "    DATA lv_ship_id TYPE string.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const sources = new Map([
      ["ZCL_ZOSD_FLEET_DPC_EXT", dpcSource],
      ["ZCL_ZOSD_FLEET_MPC_EXT", "CLASS zcl_zosd_fleet_mpc_ext IMPLEMENTATION. ENDCLASS."],
      ["ZCL_ZOSD_FLEET_MPC", "lo_entity_set = lo_entity_type->create_entity_set( 'VoyageSet' )."],
    ]);
    const registrations = [{dpc: "ZCL_ZOSD_FLEET_DPC_EXT", mpc: "ZCL_ZOSD_FLEET_MPC_EXT", external: "ZOSD_FLEET_SRV"}];
    const map = entitySetMapFor("ZCL_ZOSD_FLEET_DPC_EXT", registrations, (name) => sources.get(name));
    expect(map.sets).to.deep.equal([{method: "VOYAGESET_GET_ENTITYSET", kind: "get_entityset", set: "VoyageSet"}]);
    const lenses = entitySetLenses(dpcSource, map);
    expect(lenses.map((lens) => lens.title)).to.deep.equal(["▶ Call VoyageSet"]);
    const method = methodAtLine(dpcSource, 2);
    const set = map.sets.find((entry) => entry.method === method);
    expect(runActionFor({type: "CLAS", name: "ZCL_ZOSD_FLEET_DPC_EXT"}, {
      entitySet: {service: map.service, set: set.set, entityKind: set.kind},
    })).to.deep.equal({kind: "call-entityset", service: "ZOSD_FLEET_SRV", set: "VoyageSet", entityKind: "get_entityset"});
  });

  // ---- Q3 "Readers": the lens over a class's or interface's own definition
  // line, its title, the quick pick a click shows, and the file glob a
  // chosen reader opens.

  it("Q3: the lens line is the object's own CLASS ... DEFINITION / INTERFACE line, none for another object's", () => {
    const clas = [
      "CLASS zcl_other DEFINITION PUBLIC.",      // 1, not this object
      "ENDCLASS.",                               // 2
      "CLASS zcl_x DEFINITION PUBLIC FINAL.",    // 3
      "  PUBLIC SECTION.",                       // 4
      "ENDCLASS.",                               // 5
      "CLASS zcl_x IMPLEMENTATION.",             // 6, not a DEFINITION line
      "ENDCLASS.",                               // 7
    ].join("\n");
    expect(readersLensLine(clas, {type: "CLAS", name: "ZCL_X"})).to.equal(3);
    expect(readersLensLine(clas, {type: "CLAS", name: "ZCL_NOT_THERE"})).to.equal(undefined);

    const intf = ["\" a comment", "INTERFACE zif_x PUBLIC."].join("\n");
    expect(readersLensLine(intf, {type: "INTF", name: "ZIF_X"})).to.equal(2);

    // an INTERFACES statement (implementing one, inside a class) is not an
    // INTERFACE statement (declaring one)
    expect(readersLensLine("  INTERFACES zif_x.", {type: "INTF", name: "ZIF_X"})).to.equal(undefined);
    expect(readersLensLine(clas, {type: "PROG", name: "ZCL_X"})).to.equal(undefined);
    expect(readersLensLine(clas, undefined)).to.equal(undefined);
  });

  it("Q3: the lens title, off the server's own counts", () => {
    expect(readersLensTitle({readers: 3, tests: 1, services: 2})).to.equal("read by 3 · tests 1 · services 2");
    expect(readersLensTitle(undefined)).to.equal("read by 0 · tests 0 · services 0");
  });

  it("Q3: the quick pick tags a reader that is a test, a service, both, or neither", () => {
    const readers = [
      {type: "CLAS", name: "ZCL_A", include: "ZCL_A", isTest: false, services: []},
      {type: "CLAS", name: "ZCL_B", include: "ZCL_B", isTest: true, services: []},
      {type: "CLAS", name: "ZCL_C", include: "ZCL_C", isTest: false, services: ["ZSTG_DEMO_SRV"]},
      {type: "CLAS", name: "ZCL_D", include: "ZCL_D", isTest: true, services: ["ZSTG_DEMO_SRV", "ZOSD_TEST_SRV"]},
    ];
    const items = readersQuickPickItems(readers);
    expect(items.map((i) => i.label)).to.deep.equal(["ZCL_A", "ZCL_B", "ZCL_C", "ZCL_D"]);
    expect(items[0].description).to.equal("CLAS");
    expect(items[1].description).to.equal("CLAS · Test");
    expect(items[2].description).to.equal("CLAS · Service (ZSTG_DEMO_SRV)");
    expect(items[3].description).to.equal("CLAS · Test · Service (ZSTG_DEMO_SRV, ZOSD_TEST_SRV)");
    expect(items.map((i) => i.reader)).to.deep.equal(readers);
    expect(readersQuickPickItems(undefined)).to.deep.equal([]);
  });

  it("Q3: a reader's file glob, namespace-to-# and all, undefined for a type with no known file shape", () => {
    expect(readerFilePattern({type: "CLAS", name: "ZCL_ZSTG_DEMO_MPC_EXT"})).to.equal("**/zcl_zstg_demo_mpc_ext.clas.abap");
    expect(readerFilePattern({type: "INTF", name: "ZIF_STG_CDS_SOURCE"})).to.equal("**/zif_stg_cds_source.intf.abap");
    expect(readerFilePattern({type: "PROG", name: "ZREPORT"})).to.equal("**/zreport.prog.abap");
    expect(readerFilePattern({type: "CLAS", name: "/NS/ZCL_X"})).to.equal("**/#ns#zcl_x.clas.abap");
    expect(readerFilePattern({type: "FUGR", name: "ZFG"})).to.equal(undefined);
    expect(readerFilePattern(undefined)).to.equal(undefined);
  });

  it("Q3: end to end against the demo's own sources -- what the lens shows is what tools/adt-facade.mjs's readers route answers", () => {
    const mpcSource = readFileSync("src/demo/zcl_zstg_demo_mpc_ext.clas.abap", "utf8");
    const object = adtObjectOf("zcl_zstg_demo_mpc_ext.clas.abap");
    const line = readersLensLine(mpcSource, object);
    expect(line).to.be.a("number");
    expect(mpcSource.split(/\r\n|\r|\n/)[line - 1]).to.match(/^CLASS\s+zcl_zstg_demo_mpc_ext\s+DEFINITION\b/i);
  });

  // ---- Q6a "Notebook SQL": the pure half of a *.osdnb notebook -- the
  // freestyle route's own column-oriented XML into rows, the rows into an
  // escaped HTML table, and a notebook file's JSON into cells and back.

  it("Q6a: the freestyle route's own XML shape (tools/adt-facade.mjs tableDataDocument) becomes columns and rows", () => {
    const xml = tableDataDocument({
      rows: [{TRAVEL_ID: "T0001", DESCRIPTION: "Berlin"}, {TRAVEL_ID: "T0002", DESCRIPTION: "Paris"}],
      columns: ["TRAVEL_ID", "DESCRIPTION"],
    });
    const {columns, rows} = freestyleRows(xml);
    expect(columns).to.deep.equal(["TRAVEL_ID", "DESCRIPTION"]);
    expect(rows).to.deep.equal([
      {TRAVEL_ID: "T0001", DESCRIPTION: "Berlin"},
      {TRAVEL_ID: "T0002", DESCRIPTION: "Paris"},
    ]);
  });

  it("Q6a: an empty result set is zero rows, not one row of nothing", () => {
    const xml = tableDataDocument({rows: [], columns: ["A", "B"]});
    expect(freestyleRows(xml)).to.deep.equal({columns: ["A", "B"], rows: []});
  });

  it("Q6a: a value the XML had to escape (& and <) round-trips through freestyleRows unescaped", () => {
    const xml = tableDataDocument({rows: [{NOTE: "Tom & Jerry <3"}], columns: ["NOTE"]});
    expect(freestyleRows(xml).rows).to.deep.equal([{NOTE: "Tom & Jerry <3"}]);
  });

  it("Q6a: htmlEscape stops a cell value with < or & from becoming markup", () => {
    expect(htmlEscape("<script>alert(1)</script>")).to.equal("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(htmlEscape("Fish & Chips")).to.equal("Fish &amp; Chips");
    expect(htmlEscape(undefined)).to.equal("");
  });

  it("Q6a: the cell output table escapes every cell, and the status line carries rows, ms and generation", () => {
    const html = freestyleTableHtml(["NAME"], [{NAME: "<b>&</b>"}], {ms: 12, generation: "abcdef1234567890"});
    expect(html).to.contain("<th>NAME</th>");
    expect(html).to.contain("<td>&lt;b&gt;&amp;&lt;/b&gt;</td>");
    expect(html).to.not.contain("<b>&</b>");
    expect(html).to.contain("1 row · 12 ms · abcdef12");
  });

  it("Q6a: the status line leaves the generation off when the answer did not carry one", () => {
    const html = freestyleTableHtml([], [], {ms: 3});
    expect(html).to.contain("0 rows · 3 ms</div>");
  });

  it("Q6a: HTML is the only renderer, with an escaped raw JSON disclosure inside it", () => {
    const rows = [{NAME: "<script>alert(1)</script>"}];
    const items = freestyleOutputItems(freestyleTableHtml(["NAME"], rows));
    expect(items.map((item) => item.mime)).to.deep.equal(["text/html"]);
    expect(items[0].value).to.contain("<details><summary>raw JSON</summary><pre>");
    expect(items[0].value).to.contain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(items[0].value).to.not.contain("<script>");
  });

  it("Q6a: an ABAP cell becomes the main method of the notebook classrun class", () => {
    const source = notebookAbapSource("out->write( 'hello' ).\nLOOP AT lt_demo INTO ls_demo.\nENDLOOP.");
    expect(source).to.contain("CLASS zcl_osd_notebook_cell DEFINITION");
    expect(source).to.contain("METHOD if_oo_adt_classrun~main.");
    expect(source).to.contain("    out->write( 'hello' ).\n    LOOP AT lt_demo INTO ls_demo.\n    ENDLOOP.");
    expect(source).to.contain("ENDCLASS.");
  });

  it("Q6a: AMDP sandbox JSON keeps the engine label and a portable refusal", () => {
    expect(amdpCellResult({status: "ok", result: '[{"ANSWER":42}]', ms: "8",
      engine: "Portable AMDP (limited) on sqlite"})).to.deep.equal({
      columns: ["ANSWER"], rows: [{ANSWER: 42}], ms: 8, raw: undefined,
      engine: "Portable AMDP (limited) on sqlite",
    });
    const sqlite = amdpCellResult({
      status: "error", system_db: "sqlite",
      error: "UNSUPPORTED_SQLSCRIPT: CAST to INTEGER cannot raise in SQLite",
    });
    expect(sqlite.error).to.contain("UNSUPPORTED_SQLSCRIPT");
    expect(sqlite.error).to.contain("CAST to INTEGER");
    expect(amdpCellResult({status: "ok", result: "[]", system_db: "HDB"}).engine)
      .to.equal("HANA (eAMDP)");
  });

  it("Q6a: a notebook's own JSON becomes cells, code defaulting to sql, markdown its own kind", () => {
    const cells = notebookFromJson(JSON.stringify({cells: [
      {kind: "markdown", value: "# Demo"},
      {kind: "code", value: "SELECT 1"},
      {kind: "code", language: "sql", value: "SELECT 2"},
      {kind: "code", language: "abap", value: "out->write( 'hello' )."},
      {kind: "code", language: "sqlscript", value: "SELECT 1 FROM dummy;"},
    ]}));
    expect(cells).to.deep.equal([
      {kind: "markdown", language: "markdown", value: "# Demo"},
      {kind: "code", language: "sql", value: "SELECT 1"},
      {kind: "code", language: "sql", value: "SELECT 2"},
      {kind: "code", language: "abap", value: "out->write( 'hello' )."},
      {kind: "code", language: "sqlscript", value: "SELECT 1 FROM dummy;"},
    ]);
  });

  it("Q6a: a bad or missing notebook JSON reads as no cells rather than throwing", () => {
    expect(notebookFromJson("not json")).to.deep.equal([]);
    expect(notebookFromJson(JSON.stringify({}))).to.deep.equal([]);
  });

  it("Q6a: notebookToJson and notebookFromJson round-trip a notebook", () => {
    const cells = [
      {kind: "code", language: "sql", value: "SELECT * FROM zstg_demo"},
      {kind: "markdown", language: "markdown", value: "a query"},
    ];
    const text = notebookToJson(cells);
    expect(text.endsWith("\n")).to.equal(true);
    expect(notebookFromJson(text)).to.deep.equal(cells);
  });

  it("opens the SQL door with explanatory markdown around a runnable base-table query", () => {
    const cells = sqlNotebookStarter();
    expect(cells.map((cell) => [cell.kind, cell.language])).to.deep.equal([
      ["markdown", "markdown"], ["code", "sql"], ["markdown", "markdown"],
    ]);
    expect(cells[0].value).to.contain("Shift+Enter");
    expect(cells[1].value).to.equal("SELECT * FROM zosd_sys UP TO 10 ROWS");
    expect(cells[2].value).to.contain("raw JSON").and.to.contain("DX7")
      .and.to.contain("docs/notebook-cells.md").and.to.contain("SQLScript");
    expect(cells[2].value).to.contain("SELECT bodies").and.to.contain("SQLite, DuckDB and PostgreSQL");
    expect(sqlNotebookStarter("SELECT * FROM zstg_demo")[1].value).to.equal("SELECT * FROM zstg_demo");
  });

  it("describes the current SQLScript cell scope in the example notebook", () => {
    const example = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/examples/abap-amdp.osdnb"), "utf8"));
    const intro = example.cells[0].value;
    expect(intro).to.contain("SELECT bodies").and.to.contain("SQLite, DuckDB and PostgreSQL");
  });

  // ---- Q7 "F8 on a table or a CDS view": name resolution off the file
  // alone (dataPreviewObjectOf), the MANDT filter SQL (dataPreviewQuery /
  // dataPreviewCountQuery), the row cap wording (dataPreviewStatusText)
  // and the façade's own datapreview XML (dataPreviewRows), held to
  // tableDataDocument's real shape the same way Q6a's freestyleRows tests
  // are above.

  it("Q7: dataPreviewObjectOf names a TABL and a DDLS off the file alone, and knows neither for anything else", () => {
    expect(dataPreviewObjectOf("/x/src/ddic/zstg_flightfact.tabl.xml")).to.deep.equal({type: "TABL", name: "ZSTG_FLIGHTFACT"});
    expect(dataPreviewObjectOf("zc_stg_flightcube.ddls.asddls")).to.deep.equal({type: "DDLS", name: "ZC_STG_FLIGHTCUBE"});
    expect(dataPreviewObjectOf("zc_stg_flightcube.ddls.xml")).to.deep.equal({type: "DDLS", name: "ZC_STG_FLIGHTCUBE"});
    expect(dataPreviewObjectOf("#ns#ztab.tabl.xml")).to.deep.equal({type: "TABL", name: "/NS/ZTAB"});
    expect(dataPreviewObjectOf("zcl_a.clas.abap")).to.equal(undefined);
    expect(dataPreviewObjectOf("zstg_flightfact.tabl.abap")).to.equal(undefined);
  });

  it("Q7: tablHasMandt reads a TABL's own DD03P rows, off the buffer -- ZSTG_FLIGHTFACT has the field, ZOSD_PACK does not", () => {
    const withMandt = readFileSync(new URL("../src/ddic/zstg_flightfact.tabl.xml", import.meta.url), "utf8");
    const withoutMandt = readFileSync(new URL("../src/status/zosd_pack.tabl.xml", import.meta.url), "utf8");
    expect(tablHasMandt(withMandt)).to.equal(true);
    expect(tablHasMandt(withoutMandt)).to.equal(false);
    expect(tablHasMandt(undefined)).to.equal(false);
  });

  it("Q7: dataPreviewQuery filters to the logon client only for a TABL that has MANDT and is not showing all clients", () => {
    expect(dataPreviewQuery("ZSTG_FLIGHTFACT", {hasMandt: true})).to.equal(`SELECT * FROM ZSTG_FLIGHTFACT WHERE MANDT = '${MANDT_CLIENT}'`);
    expect(MANDT_CLIENT).to.equal("123"); // CLAUDE.md "Known traps": the runtime's own sy-mandt
    expect(dataPreviewQuery("ZSTG_FLIGHTFACT", {hasMandt: true, allClients: true})).to.equal("SELECT * FROM ZSTG_FLIGHTFACT");
    expect(dataPreviewQuery("ZOSD_PACK", {hasMandt: false})).to.equal("SELECT * FROM ZOSD_PACK");
    // a DDLS is never filtered: the CDS-name view has no MANDT column at all
    expect(dataPreviewQuery("ZC_STG_FLIGHTCUBE", {hasMandt: false})).to.equal("SELECT * FROM ZC_STG_FLIGHTCUBE");
    expect(dataPreviewQuery("ZSTG_FLIGHTFACT")).to.equal("SELECT * FROM ZSTG_FLIGHTFACT");
  });

  it("Q7: dataPreviewCountQuery is the same statement, as a count", () => {
    expect(dataPreviewCountQuery("ZSTG_FLIGHTFACT", {hasMandt: true})).to.equal(`SELECT COUNT(*) AS N FROM ZSTG_FLIGHTFACT WHERE MANDT = '${MANDT_CLIENT}'`);
    expect(dataPreviewCountQuery("ZOSD_PACK", {hasMandt: false})).to.equal("SELECT COUNT(*) AS N FROM ZOSD_PACK");
  });

  it("Q7: dataPreviewStatusText says the row cap only once there is something to say about it", () => {
    expect(dataPreviewStatusText(0, 100)).to.equal("0 rows");
    expect(dataPreviewStatusText(24, 100)).to.equal("24 rows");
    expect(dataPreviewStatusText(1, 100)).to.equal("1 row");
    expect(dataPreviewStatusText(100, 100, 137)).to.equal("first 100 of 137");
    expect(dataPreviewStatusText(100, 100, undefined)).to.equal("first 100 rows");
  });

  it("Q7: a stopped or starting managed listener is actionable without a fetch", async () => {
    for (const state of ["stopped", "starting"]) {
      const api = vscodeStub({url: "http://localhost:3531"});
      const {openDataPreview} = loadExtension(api);
      let calls = 0;
      await openDataPreview("TABL", "ZOSD_FLEET_VOY", true, {appendLine() {}}, {
        launcher: {state}, managedUrl: "http://localhost:3531",
        client: () => { calls++; throw new Error("must not fetch"); },
      });
      expect(calls).to.equal(0);
      expect(api.panels[0].webview.html).to.contain(state === "stopped" ? "Start system" : "Refresh when it is running");
    }
  });

  it("Q7: the managed URL survives a controller reload and gates its stopped listener", async () => {
    const saved = new Map();
    const context = controllerContext();
    context.workspaceState = {get: (key) => saved.get(key), update: async (key, value) => { saved.set(key, value); }};
    const api = vscodeStub({url: "http://localhost:3531"});
    api.window.setStatusBarMessage = () => {};
    const {SystemController, openDataPreview} = loadExtension(api);
    const output = {append() {}, appendLine() {}, show() {}};
    const first = new SystemController(context, output);
    first.launcher = {state: "stopped", osdHome: ROOT, databaseLabel: "SQLite", debug: false,
      async start() { this.state = "running"; return {port: 3531, generation: "abc123"}; }};
    first.ensureLauncher = async () => first.launcher;
    expect(await first.start()).to.equal(true);
    expect(saved.get("osd.managedUrl")).to.equal("http://localhost:3531");

    const reloaded = new SystemController(context, output);
    expect(reloaded.managedUrl).to.equal("http://localhost:3531");
    let calls = 0;
    await openDataPreview("TABL", "ZOSD_FLEET_VOY", false, output, {
      controller: reloaded, client: () => { calls++; throw new Error("must not fetch"); },
    });
    expect(calls).to.equal(0);
    expect(api.panels[0].webview.html).to.contain("Start system");
  });

  it("Q7: an external URL remains usable, and a successful empty table is not an error", async () => {
    for (const state of ["stopped", "starting", "stopping"]) {
      const api = vscodeStub({url: "http://localhost:4545"});
      const {openDataPreview} = loadExtension(api);
      let calls = 0;
      await openDataPreview("TABL", "ZOSD_FLEET_VOY", true, {appendLine() {}}, {
        launcher: {state}, managedUrl: "http://localhost:3531",
        client: () => ({dataPreview: async () => { calls++; return {columns: [{name: "VOYAGE_ID", label: "Voyage", key: true}], rows: [], ms: 1}; }}),
      });
      expect(calls, state).to.equal(1);
      expect(api.panels[0].webview.html).to.contain("0 rows").and.to.contain("Voyage");
      expect(api.panels[0].webview.html).to.not.contain('class="osd-error"');
    }
  });

  it("Q7: a connection refusal names the endpoint, while HTTP and SQL errors keep their details", async () => {
    const api = vscodeStub({url: "http://localhost:3531"});
    const {openDataPreview} = loadExtension(api);
    await openDataPreview("TABL", "ZOSD_FLEET_VOY", false, {appendLine() {}}, {
      launcher: undefined,
      client: () => ({dataPreview: async () => { throw new TypeError("fetch failed"); }}),
    });
    expect(api.panels[0].webview.html).to.contain("Cannot reach osd at http://localhost:3531");
    expect(dataPreviewError(new Error("POST /sap/bc/adt/datapreview/ddic: HTTP 404 -- missing table"), "http://localhost:3531"))
      .to.contain("HTTP 404 -- missing table");
    expect(dataPreviewError(new Error("SQL table missing"), "http://localhost:3531")).to.equal("SQL table missing");
    expect(dataPreviewAvailability("stopped", "http://localhost:3531", "http://localhost:4545")).to.equal(undefined);
    expect(dataPreviewAvailability("starting", "http://localhost:3531", "http://localhost:4545")).to.equal(undefined);
    expect(dataPreviewAvailability("stopping", "http://localhost:3531", "http://localhost:4545")).to.equal(undefined);
  });

  it("Q7: dataPreviewRows reads tableDataDocument's own labels and keys, off the real façade shape (datapreview/ddic and /cds)", () => {
    const xml = tableDataDocument({
      rows: [{FACT_ID: "0000000001", AIRLINE: "LH"}, {FACT_ID: "0000000002", AIRLINE: "BA"}],
      columns: ["FACT_ID", "AIRLINE"],
    }, {fields: [
      {name: "FACT_ID", description: "Fact", key: true, letter: "N", dataType: "NUMC", length: 10},
      {name: "AIRLINE", description: "Airline", key: false, letter: "C", dataType: "CHAR", length: 3},
    ]});
    const {columns, rows} = dataPreviewRows(xml);
    expect(columns).to.deep.equal([
      {name: "FACT_ID", label: "Fact", key: true},
      {name: "AIRLINE", label: "Airline", key: false},
    ]);
    expect(rows).to.deep.equal([{FACT_ID: "0000000001", AIRLINE: "LH"}, {FACT_ID: "0000000002", AIRLINE: "BA"}]);
  });

  it("Q7: dataPreviewRows falls back to the column's own name when the façade did not know it (freestyle's own fallback metadata)", () => {
    const xml = tableDataDocument({rows: [{X: "1"}], columns: ["X"]}); // no fields option: the unknown-column branch
    expect(dataPreviewRows(xml).columns).to.deep.equal([{name: "X", label: "X", key: false}]);
  });

  // ---- Q4 "Hotspots": ZOSD_DUMP as heat, off the same freestyle SQL door
  // Q6a's notebook uses (HOTSPOTS_SQL, hotspotsFromRows); tableDataDocument
  // builds the real XML shape a server answers with, the same way Q6a's own
  // tests hold freestyleRows to the real document rather than a hand-typed one.

  it("Q4: HOTSPOTS_SQL is a SELECT, over zosd_dump, grouped by object/include/line", () => {
    expect(HOTSPOTS_SQL).to.match(/^SELECT\b/i);
    expect(HOTSPOTS_SQL).to.contain("FROM zosd_dump");
    expect(HOTSPOTS_SQL).to.contain("GROUP BY objname");
  });

  it("Q4: a server's own freestyle rows (real XML shape) become byLine and byFile counts", () => {
    const rows = [
      {objname: "ZCL_STG_DISPATCHER", include: "main", line: "119", n: "3", last_at: "1700000000000", last_message: "Division by zero"},
      {objname: "ZCL_STG_DISPATCHER", include: "main", line: "44", n: "1", last_at: "1700000001000", last_message: "no such field"},
      {objname: "ZCL_STG_ENTRY_PROVIDER", include: "testclasses", line: "7", n: "12", last_at: "1700000002000", last_message: "conversion"},
    ];
    const xml = tableDataDocument({columns: ["objname", "include", "line", "n", "last_at", "last_message"], rows});
    const {byLine, byFile} = hotspotsFromRows(freestyleRows(xml).rows);
    expect(byLine).to.have.length(3);
    const dispatcher119 = byLine.find((e) => e.objname === "ZCL_STG_DISPATCHER" && e.line === 119);
    expect(dispatcher119).to.deep.equal({objname: "ZCL_STG_DISPATCHER", include: "main", line: 119, count: 3, lastAt: 1700000000000, lastMessage: "Division by zero"});
    expect(byFile).to.deep.equal({ZCL_STG_DISPATCHER: 4, ZCL_STG_ENTRY_PROVIDER: 12});
  });

  it("Q4: a row with no object name or no usable line is dropped, not guessed at", () => {
    const {byLine, byFile} = hotspotsFromRows([
      {objname: "", include: "main", line: "5", n: "2"},
      {objname: "ZCL_A", include: "main", line: "", n: "1"},
      {objname: "ZCL_A", include: "main", line: "0", n: "1"},
    ]);
    expect(byLine).to.deep.equal([]);
    expect(byFile).to.deep.equal({});
    expect(hotspotsFromRows(undefined)).to.deep.equal({byLine: [], byFile: {}});
  });

  it("Q4: intensity buckets a fixed few steps rather than a scale fitted to the data", () => {
    expect([0, 1, 2, 4, 5, 9, 10, 999].map(hotspotBucket)).to.deep.equal([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("Q4: bucket colours are translucent and get heavier with the bucket", () => {
    const colors = [1, 2, 3, 4].map(hotspotColor);
    for (const c of colors) expect(c).to.match(/^rgba\(255, 0, 0, 0(\.\d+)?\)$/);
    const alpha = (c) => Number(/rgba\(255, 0, 0, (0(?:\.\d+)?)\)/.exec(c)[1]);
    expect(alpha(colors[0])).to.be.lessThan(alpha(colors[1]));
    expect(alpha(colors[1])).to.be.lessThan(alpha(colors[2]));
    expect(alpha(colors[2])).to.be.lessThan(alpha(colors[3]));
  });

  it("Q4: a badge is at most two characters (VS Code's own limit)", () => {
    expect(hotspotBadge(1)).to.equal("1");
    expect(hotspotBadge(9)).to.equal("9");
    expect(hotspotBadge(10)).to.equal("9+");
    expect(hotspotBadge(250)).to.equal("9+");
    for (const n of [1, 9, 10, 250]) expect(hotspotBadge(n)).to.have.length.at.most(2);
  });

  it("Q4: a line's hover names the count, the last time and the message", () => {
    const text = hotspotHoverText({count: 3, lastAt: Date.parse("2026-09-25T12:00:00Z"), lastMessage: "Division by zero"});
    expect(text).to.equal("3 dumps, last 2026-09-25T12:00:00.000Z: Division by zero");
    expect(hotspotHoverText({count: 1, lastAt: 0, lastMessage: ""})).to.equal("1 dump, last an unknown time: (no message)");
  });

  // gui-reports spike (docs/gui-reports.md): F8/"Open in VS Code" on a
  // converted report names the same transaction code
  // tools/osd-gui-convert.mjs wires it under. Held to that tool's own
  // namesOf() rather than to a literal, so the two cannot drift silently.
  it("names a report's webgui transaction the way osd-gui-convert.mjs wires it", () => {
    for (const program of ["ZGG_EX_001", "ZGG_EX_012", "ZGG_EX_043"]) {
      expect(progTcodeOf(program)).to.equal(guiConvertNamesOf(program).tcode);
    }
    expect(progTcodeOf(undefined)).to.equal(undefined);
    expect(progTcodeOf("")).to.equal(undefined);
  });

  it("builds the transaction URL after the externally reachable base, retaining its route prefix", () => {
    const url = new URL(webguiTransactionUrl("https://forwarded.example/proxy/?ticket=forwarded", "ZGUI_GG_EX_012"));
    expect(url.pathname).to.equal("/proxy/sap/bc/gui/sap/its/webgui/");
    expect(url.searchParams.get("okcode")).to.equal("ZGUI_GG_EX_012");
    expect(url.searchParams.get("ticket")).to.equal("forwarded");
  });

  it("reloads a report with distinct HTML on each F8 while keeping its transaction URL", () => {
    const url = webguiTransactionUrl("https://forwarded.example/proxy/", "ZGUI_GG_EX_012");
    const first = webguiPanelHtml(url, "ZGUI_GG_EX_012", 1);
    const second = webguiPanelHtml(url, "ZGUI_GG_EX_012", 2);
    expect(second).to.not.equal(first);
    expect(first).to.contain(`src="${url}"`);
    expect(second).to.contain(`src="${url}"`);
  });

  it("reserves one panel before concurrent external URI resolution and drops a stale result", async () => {
    const panels = new Map();
    const resolvers = [];
    const created = [];
    const createPanel = () => {
      const panel = {webview: {html: ""}, reveals: 0, reveal() { this.reveals++; }, onDidDispose(fn) { this.dispose = fn; }};
      created.push(panel);
      return panel;
    };
    const deps = {createPanel, resolveBase: () => new Promise((resolve) => resolvers.push(resolve)), panelHtml: webguiPanelHtml};
    const first = runWebguiPanel("ZGUI_GG_EX_012", "https://forwarded.example/", panels, deps);
    const second = runWebguiPanel("ZGUI_GG_EX_012", "https://forwarded.example/", panels, deps);
    expect(created).to.have.length(1);
    expect(created[0].reveals).to.equal(1);
    resolvers[1]("https://forwarded.example/");
    await second;
    const current = created[0].webview.html;
    resolvers[0]("https://forwarded.example/");
    await first;
    expect(created[0].webview.html).to.equal(current);
    expect(current).to.contain("ZGUI_GG_EX_012");
    const third = runWebguiPanel("ZGUI_GG_EX_012", "https://forwarded.example/", panels, deps);
    resolvers[2]("https://forwarded.example/");
    await third;
    expect(created).to.have.length(1);
    expect(created[0].webview.html).to.not.equal(current);
    created[0].dispose();
    expect(panels.size).to.equal(0);
  });

  it("places the run lens on a report's own REPORT line", () => {
    const source = "REPORT zgg_ex_001.\n\nSTART-OF-SELECTION.\n  WRITE 'hello world'.\n";
    const lens = progRunLens(source, "ZGG_EX_001");
    expect(lens).to.deep.equal({line: 1, tcode: "ZGUI_GG_EX_001", title: "▶ Run in Easy Access (ZGUI_GG_EX_001)"});
    // an include has no REPORT statement of its own: no lens rather than a
    // wrong line
    expect(progRunLens("* nothing but comments\n", "ZGG_EX_001_INC")).to.equal(undefined);
  });
});

describe("editors/vscode: Test Explorer grouping (Project / Packs / Workspace layers / System)", function () {
  it("rebuilds the workspace test tree and refreshes its count lens when Start reaches serving", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "osd-serving-layer-"));
    const source = path.join(folder, "src/zcl_layer_test.clas.testclasses.abap");
    mkdirSync(path.dirname(source), {recursive: true});
    writeFileSync(source, "CLASS ltcl_test DEFINITION FOR TESTING.\n  PRIVATE SECTION.\n    METHODS check_it FOR TESTING.\nENDCLASS.\n");
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const state = new api.EventEmitter();
    const systemController = {launcher: {osdHome: ROOT, state: "stopped", layers: []}, onDidChange: state.event};
    const collection = (parent) => {
      const items = new Map();
      return {get: (id) => items.get(id), get size() { return items.size; },
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator]()};
    };
    const tree = {items: collection(undefined),
      createTestItem(id, label, uri) { const item = {id, label, uri}; item.children = collection(item); return item; },
      createRunProfile() {}, dispose() {}};
    api.tests = {createTestController: () => tree};
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    let scans = 0;
    let activeScans = 0;
    let maxActiveScans = 0;
    let releaseScan;
    let holdScan = false;
    api.workspace.findFiles = async (pattern) => {
      if (!(pattern instanceof api.RelativePattern)) {
        scans++;
        activeScans++;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
        if (holdScan) await new Promise((resolve) => { releaseScan = resolve; });
        activeScans--;
        return [];
      }
      return [api.Uri.file(source)];
    };
    api.workspace.getWorkspaceFolder = () => undefined;
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange() {}, dispose() {}});
    api.workspace.onDidSaveTextDocument = () => ({dispose() {}});
    api.commands.registerCommand = () => ({dispose() {}});
    api.RelativePattern = class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } };
    api.CodeLens = class { constructor(range, command) { this.range = range; this.command = command; } };
    let lensProvider;
    api.languages = {registerCodeLensProvider: (_selector, provider) => { lensProvider = provider; return {dispose() {}}; }};
    const {testExplorer, readersLensProvider} = loadExtension(api);
    const oldReaders = Osd.prototype.readers;
    Osd.prototype.readers = async () => ({counts: {readers: 0, tests: systemController.launcher.state === "running" ? 1 : 0,
      services: 0}, readers: []});
    const document = {fileName: path.join(folder, "src/zcl_layer_test.clas.abap"), getText: () => "CLASS zcl_layer_test DEFINITION PUBLIC.\nENDCLASS."};
    let explorer;
    let lens;
    try {
      explorer = testExplorer(controllerContext(), {appendLine() {}}, {systemController});
      lens = readersLensProvider({appendLine() {}}, systemController);
      const titles = async () => (await lensProvider.provideCodeLenses(document)).map((item) => item.command.title);
      let lensRefreshes = 0;
      const subscription = lensProvider.onDidChangeCodeLenses(() => lensRefreshes++);
      await tree.resolveHandler();
      expect(scans).to.equal(1);
      expect(tree.items.get("group:workspace")).to.equal(undefined);
      expect(await titles()).to.deep.equal(["read by 0 · tests 0 · services 0"]);

      systemController.launcher.state = "building";
      state.fire();
      systemController.launcher.layers = [{folder, srcDir: path.join(folder, "src")}];
      systemController.launcher.state = "starting";
      state.fire();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(scans, "building and starting do not scan").to.equal(1);
      systemController.launcher.state = "running";
      state.fire();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(scans, "Start scans once after running").to.equal(2);
      expect(tree.items.get("group:workspace").children.get(`group:workspace:${path.basename(folder)}`)
        .children.get("CLAS:ZCL_LAYER_TEST")).to.not.equal(undefined);
      expect(await titles()).to.deep.equal(["read by 0 · tests 1 · services 0"]);
      expect(lensRefreshes).to.be.greaterThan(0);
      state.fire();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(scans, "unchanged running state does not scan").to.equal(2);

      systemController.launcher.layers = [];
      state.fire();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(scans, "a layer change scans once").to.equal(3);
      expect(tree.items.get("group:workspace")).to.equal(undefined);

      holdScan = true;
      const first = tree.resolveHandler();
      expect(scans).to.equal(4);
      const second = tree.resolveHandler();
      const third = tree.resolveHandler();
      expect(scans, "overlapping requests wait for the first scan").to.equal(4);
      holdScan = false;
      releaseScan();
      await Promise.all([first, second, third]);
      expect(scans, "overlapping requests coalesce into one follow-up scan").to.equal(5);
      expect(maxActiveScans).to.equal(1);
      subscription.dispose();
    } finally {
      lens?.dispose();
      explorer?.dispose();
      expect(state.listeners.size, "disposing removes state listeners").to.equal(0);
      Osd.prototype.readers = oldReaders;
      rmSync(folder, {recursive: true, force: true});
    }
  });

  it("indexes a class's tests by its main file while keeping child locations in testclasses", async () => {
    const api = vscodeStub({home: ROOT, "tests.showSystem": false});
    const include = path.join(ROOT, "src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap");
    const main = path.join(ROOT, "src/webgui/zcl_osd_abap_tokens.clas.abap");
    api.workspace.findFiles = async () => [api.Uri.file(include)];
    api.workspace.getWorkspaceFolder = () => ({uri: api.Uri.file(ROOT)});
    api.workspace.createFileSystemWatcher = () => ({onDidCreate() {}, onDidDelete() {}, onDidChange() {}, dispose() {}});
    api.commands.registerCommand = () => ({dispose() {}});
    api.TestRunProfileKind = {Run: 1, Debug: 2};
    const collection = (parent) => {
      const items = new Map();
      return {get: (id) => items.get(id), get size() { return items.size; },
        add(item) { item.parent = parent; items.set(item.id, item); },
        replace(next) { items.clear(); next.forEach((item) => this.add(item)); },
        [Symbol.iterator]: () => items[Symbol.iterator]()};
    };
    const controller = {items: collection(undefined),
      createTestItem(id, label, uri) { const item = {id, label, uri}; item.children = collection(item); return item; },
      createRunProfile() {}, dispose() {}};
    api.tests = {createTestController: () => controller};
    const {testExplorer} = loadExtension(api);
    const originalDiscover = Osd.prototype.discover;
    Osd.prototype.discover = async () => ({classes: [{name: "LTCL_SCAN", include: "testclasses", line: 1,
      methods: [{name: "CHECK", line: 2}]}]});
    let explorer;
    try {
      explorer = testExplorer(controllerContext(), {appendLine() {}});
      await controller.resolveHandler();
      const object = controller.items.get("group:project").children.get("CLAS:ZCL_OSD_ABAP_TOKENS");
      expect(object.uri.fsPath).to.equal(main);
      await controller.resolveHandler(object);
      const testClass = object.children.get(`${object.id}/LTCL_SCAN`);
      expect(testClass.uri.fsPath).to.equal(include);
      expect(testClass.children.get(`${testClass.id}/CHECK`).uri.fsPath).to.equal(include);
    } finally {
      explorer?.dispose();
      Osd.prototype.discover = originalDiscover;
    }
  });

  const transpileConfig = JSON.parse(readFileSync(path.join(ROOT, "abap_transpile.json"), "utf8"));
  const layers = transpileLayers(transpileConfig);

  it("reads abap_transpile.json's own libs and input folders, not a hardcoded list", () => {
    expect(layers.inputFolders).to.deep.equal(["src", "test", "gen"]);
    const names = layers.libs.map((l) => l.name).sort();
    expect(names).to.deep.equal(
      ["abapgit", "ajson", "express-icf-shim", "open-abap-apc", "open-abap-core", "open-abap-gui", "open-abap-odata"].sort());
    expect(layers.libs.find((l) => l.name === "open-abap-core")).to.include(
      {name: "open-abap-core", folder: ".local/lars/open-abap-core"});
    // the build's own top-level exclude_filter (bug 3, docs/vscode-extension.md)
    expect(layers.excludeFilter.some((re) => re.test("/x/test/fixtures/y.clas.abap"))).to.equal(true);
    // and each lib's own, read the same way
    const core = layers.libs.find((l) => l.name === "open-abap-core");
    expect(core.excludeFilter.some((re) => re.test("/x/.local/lars/open-abap-core/src/tcp/y.clas.abap"))).to.equal(true);
  });

  it("classifies a project file under src/ as Project, with no sub-node of its own", () => {
    const abs = path.join(ROOT, "src/webgui/zcl_osd_webgui.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, abs, layers)).to.deep.equal(
      {group: "project", subgroup: undefined, relInGroup: "src/webgui/zcl_osd_webgui.clas.testclasses.abap"});
  });

  it("classifies a project file under test/ the same way, gen/ included by the same rule though empty today", () => {
    const abs = path.join(ROOT, "test/unit/zcl_stg_gateway_test.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, abs, layers).group).to.equal("project");
    expect(classifyTestPath(ROOT, abs, layers).relInGroup).to.equal("test/unit/zcl_stg_gateway_test.clas.testclasses.abap");
  });

  it("classifies a packs/* file under Packs, one sub-node per pack", () => {
    const zvdb = path.join(ROOT, "packs/zvdb/src/zcl_vdb_100_anydb.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, zvdb, layers)).to.deep.equal(
      {group: "packs", subgroup: "zvdb", relInGroup: "src/zcl_vdb_100_anydb.clas.testclasses.abap"});
    const lsd = path.join(ROOT, "packs/lsd/src/zcl_lsd_media.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, lsd, layers).subgroup).to.equal("lsd");
  });

  it("classifies a .local/lars/<lib> file under System, named by the lib's own folder", () => {
    const core = path.join(ROOT, ".local/lars/open-abap-core/src/rtti/cl_abap_typedescr.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, core, layers)).to.deep.equal(
      {group: "system", subgroup: "open-abap-core", relInGroup: "src/rtti/cl_abap_typedescr.clas.testclasses.abap"});
    const json = path.join(ROOT, ".local/lars/open-abap-core/src/json/#ui2#cl_json.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, json, layers).group).to.equal("system");
    expect(classifyTestPath(ROOT, json, layers).subgroup).to.equal("open-abap-core");
  });

  it("classifies under a running B0 workspace layer before System or Packs, even if it sits under .local", () => {
    const layerFolder = path.join(ROOT, ".local/lars/open-abap-core");
    const abs = path.join(layerFolder, "src/http/cl_http_server.clas.testclasses.abap");
    const workspaceLayers = [{folder: layerFolder}];
    expect(classifyTestPath(ROOT, abs, layers, workspaceLayers)).to.deep.equal(
      {group: "workspace", subgroup: "open-abap-core", relInGroup: "src/http/cl_http_server.clas.testclasses.abap"});
  });

  it("shows both osg-demo tests in Workspace layers when the opened folder is the layer root", () => {
    const demoRoot = path.join(ROOT, "osg-demo");
    const workspaceLayers = [{folder: demoRoot, srcDir: path.join(demoRoot, "src")}];
    const demoLayers = {inputFolders: [], libs: [], excludeFilter: []};
    for (const name of ["zosd_demo_hello", "zcl_osd_fleet_report"]) {
      const relInGroup = `src/${name}.clas.testclasses.abap`;
      expect(classifyTestPath(demoRoot, path.join(demoRoot, relInGroup), demoLayers, workspaceLayers)).to.deep.equal(
        {group: "workspace", subgroup: "osg-demo", relInGroup});
    }
    // An empty layer-relative prefix must not admit a file beside the layer.
    expect(classifyTestPath(demoRoot, path.join(ROOT, "other-demo/src/outsider.clas.testclasses.abap"), demoLayers,
      workspaceLayers)).to.equal(undefined);
  });

  it("is undefined for a path outside every known root, rather than falling into Project (deploy/ is a staging folder, not a layer)", () => {
    const docs = path.join(ROOT, "docs/vscode-extension.md");
    expect(classifyTestPath(ROOT, docs, layers)).to.equal(undefined);
    // bug 3: exactly this shape (a real capture staged for a system's deploy,
    // never one of abap_transpile.json's input_folder/libs/packs)
    const deploy = path.join(ROOT, "deploy/lsd-a4h-011/src/zcl_zosd_011_lsd_media.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, deploy, layers)).to.equal(undefined);
  });

  it("is undefined for a project file the build's own exclude_filter hides (bug 3: test/fixtures/)", () => {
    const abs = path.join(ROOT, "test/fixtures/adt-editor/zcl_editor.clas.testclasses.abap");
    // it IS under test/, an input_folder -- exclude_filter is what removes
    // it, not the root check: a layers with no excludeFilter at all still
    // classifies it as project, proving the root check alone would pass it
    expect(classifyTestPath(ROOT, abs, {...layers, excludeFilter: []}).group).to.equal("project");
    expect(classifyTestPath(ROOT, abs, layers)).to.equal(undefined);
  });

  it("is undefined for a lib file the LIB's own exclude_filter hides (open-abap-core's /src/tcp/)", () => {
    const abs = path.join(ROOT, ".local/lars/open-abap-core/src/tcp/zcl_x.clas.testclasses.abap");
    expect(classifyTestPath(ROOT, abs, layers)).to.equal(undefined);
  });

  it("bugs 1/2/6: is undefined when root and absPath share no common tree -- the packaged install's own osdHome (a materialized copy) versus the workspace folder a person actually opened", () => {
    // the bug: root is a different tree entirely (a materialized copy in
    // globalStorage, say), while absPath is the real, open workspace
    // folder's own file -- path.relative climbs out of one tree and back
    // down the other, landing on the fallback branch (now undefined) rather
    // than matching any of the four; before the fix that fallback answered
    // {group: "project", subgroup: undefined, relInGroup: "../../.../src/..."},
    // which is where the Project group's stray ".." sub-node came from
    const unrelatedRoot = path.join(ROOT, ".local", "not-a-real-osdhome");
    const abs = path.join(ROOT, "src/webgui/zcl_osd_webgui.clas.testclasses.abap");
    expect(classifyTestPath(unrelatedRoot, abs, layers)).to.equal(undefined);
    // the fix: classify against the file's OWN root instead, and it is fine again
    expect(classifyTestPath(ROOT, abs, layers)).to.deep.equal(
      {group: "project", subgroup: undefined, relInGroup: "src/webgui/zcl_osd_webgui.clas.testclasses.abap"});
    // bug 2 (Packs empty) is the same cause, over a packs/ file
    const zvdb = path.join(ROOT, "packs/zvdb/src/zcl_vdb_100_anydb.clas.testclasses.abap");
    expect(classifyTestPath(unrelatedRoot, zvdb, layers)).to.equal(undefined);
    expect(classifyTestPath(ROOT, zvdb, layers).group).to.equal("packs");
  });

  // ---- Item 4: a class abap_transpile.json's own `options.skip` already
  // marks as deliberately failing (ZOSD_TEST's own demo, so "Run" on
  // Project stays green) gets its own sub-node -- derived from that list
  // rather than a new marker, since it is already the single, explicit,
  // per-object statement of exactly this fact.

  it("reads the demo-failure objects off abap_transpile.json's own options.skip, not a new marker", () => {
    const demoObjects = demoFailureObjects(transpileConfig);
    expect(demoObjects.has("ZCL_ZOSD_TEST_DEMO")).to.equal(true);
    expect(demoObjects.has("ZCL_STG_GATEWAY_TEST")).to.equal(false);
    expect(demoFailureObjects(undefined)).to.deep.equal(new Set());
    expect(demoFailureObjects({options: {}})).to.deep.equal(new Set());
  });

  // ---- Item 5: abapGit keeps a program's local test classes inline, in
  // its own `*.prog.abap` (or an include it reaches) rather than split into
  // a `.testclasses.abap` the way a class's are -- hasTestMethods()/
  // objectOf() are already generic by suffix, so finding one is the same
  // scan with a wider glob (extension.js TEST_FILE_GLOB), not new lib.js
  // logic.

  it("finds FOR TESTING in a PROG's own main file the same way, and classifies it under Project", () => {
    const prog = readFileSync(path.join(ROOT, "src/zosd_test/src/zosd_test_demo_prog.prog.abap"), "utf8");
    expect(hasTestMethods(prog)).to.equal(true);
    expect(objectOf("zosd_test_demo_prog.prog.abap")).to.deep.equal(
      {type: "PROG", name: "ZOSD_TEST_DEMO_PROG", base: "zosd_test_demo_prog", include: "main"});
    const abs = path.join(ROOT, "src/zosd_test/src/zosd_test_demo_prog.prog.abap");
    expect(classifyTestPath(ROOT, abs, layers)).to.deep.equal(
      {group: "project", subgroup: undefined, relInGroup: "src/zosd_test/src/zosd_test_demo_prog.prog.abap"});
  });

  it("a PROG with no FOR TESTING at all is skipped by the same cheap filter as a class", () => {
    const plain = readFileSync(path.join(ROOT, "src/zosd_test/src/zosd_test_demo_plain.prog.abap"), "utf8");
    expect(hasTestMethods(plain)).to.equal(false);
  });

  it("sub-groups by the directory under src/ or test/ once package.xml is not there to ask", () => {
    expect(packageOf("src/rtti/cl_abap_typedescr.clas.testclasses.abap")).to.equal("rtti");
    expect(packageOf("test/adbc/zcl_adbc_test.clas.testclasses.abap")).to.equal("adbc");
    expect(packageOf("src/json/#ui2#cl_json.clas.testclasses.abap")).to.equal("json");
    // a file sitting directly in a content root, no directory of its own
    expect(packageOf("test/cl_http_client.clas.testclasses.abap")).to.equal(undefined);
  });

  it("prefers the nearest package.xml directory over the src/ guess when one is known", () => {
    const dirs = packageDirsFrom(["package.xml", "a/package.xml", "a/b/package.xml"]);
    expect(dirs).to.deep.equal(["", "a", "a/b"]);
    expect(packageOf("a/b/c/zcl_x.clas.testclasses.abap", dirs)).to.equal("a/b");
    expect(packageOf("a/zcl_y.clas.testclasses.abap", dirs)).to.equal("a");
    // a root package.xml alone: everything below it is the root package, i.e. no sub-node
    expect(packageOf("zcl_z.clas.testclasses.abap", packageDirsFrom(["package.xml"]))).to.equal(undefined);
  });

  it("only splits a group into packages once it is bigger than the ~15 the task named", () => {
    expect(PACKAGE_SPLIT_THRESHOLD).to.equal(15);
    expect(needsPackageSplit(15)).to.equal(false);
    expect(needsPackageSplit(16)).to.equal(true);
    // measured in this tree: open-abap-core's own test classes clear it, a single pack does not
    const coreCount = 62;
    const packCount = 1;
    expect(needsPackageSplit(coreCount)).to.equal(true);
    expect(needsPackageSplit(packCount)).to.equal(false);
  });

  it("finds FOR TESTING in a real testclasses include, case-insensitively", () => {
    const real = readFileSync(path.join(ROOT, "test/unit/zcl_stg_gateway_test.clas.testclasses.abap"), "utf8");
    expect(hasTestMethods(real)).to.equal(true);
    expect(hasTestMethods("class ltcl_x definition for testing.\nendclass.")).to.equal(true);
  });

  it("skips a testclasses include with no FOR TESTING at all, the cheap filter done before any server round trip", () => {
    expect(hasTestMethods("CLASS ltcl_empty DEFINITION.\nENDCLASS.\n")).to.equal(false);
    expect(hasTestMethods("")).to.equal(false);
    expect(hasTestMethods(undefined)).to.equal(false);
  });
});

// The "OSD: System" panel's Services tree (docs/vscode-extension.md,
// "Services tree"): grouping by kind, sorting inside a group, and the two
// normalisers that turn either source's own row shape (ZOSD_STATUS_SRV's
// ServiceSet or the composing route's own `GET core/http/services`) into
// the one shape groupServices/serviceLabel/serviceClassNodes read. Most
// logic is pure; route coverage below uses an in-memory ObjectStore, while
// the live round trip against a running osd is test/osd-child.mjs.
describe("editors/vscode: Services tree (grouping, sorting, URLs, normalization)", function () {
  it("persists each tree toggle in workspace state and restores it in a new provider", async () => {
    const api = vscodeStub({home: ROOT});
    const {OsdTreeProvider} = loadExtension(api);
    const context = controllerContext();
    const controller = {context, launcher: {state: "running", layers: []}, onDidChange: () => {}};
    const first = new OsdTreeProvider(controller);
    try {
      expect([first.labelBy, first.sortBy, first.groupBy, first.hideBase]).to.deep.equal(["name", "name", "kind", false]);
      await first.setServiceOption("labelBy", "description");
      await first.setServiceOption("sortBy", "path");
      await first.setServiceOption("groupBy", "layer");
      await first.setServiceOption("hideBase", true);
      const restored = new OsdTreeProvider(controller);
      try {
        expect([restored.labelBy, restored.sortBy, restored.groupBy, restored.hideBase])
          .to.deep.equal(["description", "path", "layer", true]);
      } finally { restored.dispose(); }
    } finally { first.dispose(); }
  });

  it("exposes all four tree toggles as icon commands in the view title", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    for (const id of ["osd.toggleServiceLabel", "osd.cycleServiceSort", "osd.toggleServiceGrouping", "osd.toggleServiceBase"]) {
      expect(manifest.contributes.commands.find((command) => command.command === id)?.icon).to.match(/^\$\(.+\)$/);
      expect(manifest.contributes.menus["view/title"].some((entry) => entry.command === id && entry.when.includes("view == osdTree"))).to.equal(true);
    }
  });

  it("renders layer groups with kind children and hides only base rows", async () => {
    const api = vscodeStub({home: ROOT});
    const {OsdTreeProvider} = loadExtension(api);
    const controller = {context: controllerContext(), launcher: {state: "running", layers: []}, onDidChange: () => {}};
    const provider = new OsdTreeProvider(controller, async () => ({sources: {}, testClasses: []}));
    try {
      provider.rows = [
        {kind: "ODATA", name: "BASE", path: "/base"},
        {kind: "ODATA", name: "PACK", path: "/pack", pack: "fleet"},
      ];
      await provider.setServiceOption("groupBy", "layer");
      expect(provider.serviceGroupItems().map((item) => item.label)).to.deep.equal(["base (1)", "fleet (1)"]);
      const nested = provider.getChildren(provider.serviceGroupItems()[1]);
      expect(nested.map((item) => item.label)).to.deep.equal(["OData (1)"]);
      await provider.setServiceOption("hideBase", true);
      expect(provider.serviceGroupItems().map((item) => item.label)).to.deep.equal(["fleet (1)"]);
    } finally { provider.dispose(); }
  });

  it("labels a manifest-named workspace pack with its workspace folder", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "osd-workspace-pack-"));
    const manifest = path.join(folder, "osd-pack.json");
    writeFileSync(manifest, JSON.stringify({name: "declared-pack"}));
    const original = Osd.prototype.services;
    Osd.prototype.services = async () => [{kind: "ODATA", name: "ZWORK_SRV", path: "/sap/opu/odata/sap/ZWORK_SRV", pack: "declared-pack"}];
    const api = vscodeStub({home: ROOT});
    const {OsdTreeProvider} = loadExtension(api);
    const controller = {context: controllerContext(), launcher: {state: "running", layers: [{folder, manifest}]}, onDidChange: () => {}};
    const provider = new OsdTreeProvider(controller);
    try {
      await provider.refreshServices();
      expect(provider.rows[0].layer).to.equal(`workspace ${path.basename(folder)}`);
      await provider.setServiceOption("groupBy", "layer");
      expect(provider.serviceGroupItems()[0].label).to.equal(`workspace ${path.basename(folder)} (1)`);
    } finally {
      provider.dispose();
      Osd.prototype.services = original;
      rmSync(folder, {recursive: true, force: true});
    }
  });

  it("removes duplicate registrations of one OData endpoint while keeping the winning row", () => {
    const path = "/sap/opu/odata/sap/ZOSD_TEST_SRV";
    expect(uniqueServices([
      {kind: "ODATA", path, source: "src/old.iwsv.xml"},
      {kind: "ODATA", path: `${path}/`, source: "packs/new.iwsv.xml"},
      {kind: "ICF", path, source: "src/icf.xml"},
    ])).to.deep.equal([
      {kind: "ODATA", path: `${path}/`, source: "packs/new.iwsv.xml"},
      {kind: "ICF", path, source: "src/icf.xml"},
    ]);
  });

  it("shows technical names with descriptions secondary and supports description labels", () => {
    const row = {kind: "ODATA", name: "ZOSD_TEST_SRV", text: "Demo items", path: "/sap/opu/odata/sap/ZOSD_TEST_SRV"};
    expect(serviceLabel(row, "name")).to.deep.equal({label: "ZOSD_TEST_SRV", description: "Demo items"});
    expect(serviceLabel(row, "description")).to.deep.equal({label: "Demo items", description: "ZOSD_TEST_SRV"});
    expect(serviceLabel({kind: "ICF", handler: "ZCL_HANDLER", text: "Endpoint", path: "/sap/bc/example"}, "name").label).to.equal("ZCL_HANDLER");
  });

  it("sorts each kind by name, path, or description", () => {
    const rows = [
      {kind: "ODATA", name: "ZA", path: "/b", text: "Alpha"},
      {kind: "ODATA", name: "ZB", path: "/a", text: "Beta"},
    ];
    expect(groupServices(rows, "kind", "name")[0].rows.map((r) => r.name)).to.deep.equal(["ZA", "ZB"]);
    expect(groupServices(rows, "kind", "path")[0].rows.map((r) => r.name)).to.deep.equal(["ZB", "ZA"]);
    expect(groupServices(rows, "kind", "description")[0].rows.map((r) => r.name)).to.deep.equal(["ZA", "ZB"]);
  });

  it("groups by layer, then kind, and hides base services when requested", () => {
    const rows = [
      {kind: "ODATA", name: "BASE", path: "/base"},
      {kind: "APP", name: "WORK", path: "/work", layer: "workspace my-folder"},
      {kind: "ODATA", name: "PACK", path: "/pack", pack: "fleet"},
    ];
    const groups = groupServices(rows, "layer", "name");
    expect(groups.map((g) => g.label)).to.deep.equal(["base", "workspace my-folder", "fleet"]);
    expect(groups[0].groups.map((g) => g.label)).to.deep.equal(["OData"]);
    expect(groupServices(rows, "layer", "name", true).map((g) => g.label)).to.deep.equal(["workspace my-folder", "fleet"]);
    expect(groupServices(rows, "kind", "name", true).flatMap((g) => g.rows).map((r) => r.name)).to.deep.equal(["PACK", "WORK"]);
  });
  it("renders a full workspace pack in the Layers tree", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "osd-tree-layer-"));
    const api = vscodeStub({home: ROOT});
    const {OsdTreeProvider} = loadExtension(api);
    const controller = {context: controllerContext(), launcher: {state: "running", osdHome: ROOT,
      layers: [{folder, manifest: path.join(folder, "osd-pack.json")}]}, onDidChange: () => {}};
    const provider = new OsdTreeProvider(controller, async () => ({sources: {}, testClasses: []}));
    try {
      for (const dir of ["src/ddic", "data", "webapp"]) mkdirSync(path.join(folder, dir), {recursive: true});
      writeFileSync(path.join(folder, "osd-pack.json"), JSON.stringify({tiles: [{title: "Demo"}]}));
      writeFileSync(path.join(folder, "src", "zcl_demo.clas.abap"), "CLASS zcl_demo DEFINITION. ENDCLASS.");
      writeFileSync(path.join(folder, "src", "ddic", "zdemo.tabl.xml"), "<abapGit/>");
      writeFileSync(path.join(folder, "data", "zdemo.tabu.json"), "[]");
      writeFileSync(path.join(folder, "webapp", "index.html"), "demo");
      const row = provider.layerItems().find((item) => item.contextValue === "osd-layer-workspace");
      expect(row.label).to.equal(`workspace: ${folder}`);
      expect(row.description).to.equal(`ABAP 1 objects · data 1 tables · ddic 1 · webapp /app/${path.basename(folder).toLowerCase()}/ · tiles 1`);
      expect(row.tooltip).to.contain(row.description);
    } finally {
      provider.dispose();
      rmSync(folder, {recursive: true, force: true});
    }
  });
  it("single-clicking every produced leaf acts immediately while expandable nodes show details", async () => {
    const api = vscodeStub({home: ROOT});
    const {OsdTreeProvider, EntitySetItem, clickTreeNode, clickTransaction} = loadExtension(api);
    let launchpadOpens = 0;
    let overviewOpens = 0;
    const controller = {context: controllerContext(), launcher: {state: "running", port: 3591, databaseLabel: "SQLite",
      generation: "abcdef12", osdHome: ROOT, layers: [{folder: "extra-layer"}]}, onDidChange: () => {},
    openLaunchpad: () => { launchpadOpens++; }, openSystemOverview: () => { overviewOpens++; }};
    const provider = new OsdTreeProvider(controller, async () => ({sources: {}, testClasses: []}));
    const output = {shown: 0, appendLine() {}, clear() {}, show() { this.shown++; }};
    provider.rows = [
      {kind: "APP", path: "/app/flp.html", name: "App"},
      {kind: "ODATA", path: "/sap/opu/odata/sap/ZTEST", name: "OData", handler: "ZCL_TEST_DPC", mpc: "ZCL_TEST_MPC"},
      {kind: "ODATA", path: "/sap/opu/odata/sap/ZLEAF", name: "OData leaf"},
      {kind: "ICF", path: "/sap/bc/test", name: "ICF", handler: "ZCL_TEST_ICF"},
      {kind: "APC", path: "/sap/bc/apc/test", name: "APC", handler: "ZCL_TEST_APC"},
    ];
    provider.transactions = [normalizeTransactionRow({tcode: "ZCLICK_SINGLE", runnable: true}),
      normalizeTransactionRow({tcode: "ZCLICK_DISABLED", runnable: false, reason: "no target"})];
    const seen = new Set();
    const expandableKinds = new Set();
    const leafKinds = new Set();
    try {
      const visit = async (item) => {
        const kind = item.contextValue?.split(";")[0] ?? "unknown";
        seen.add(kind);
        const expandable = item.collapsibleState > api.TreeItemCollapsibleState.None;
        (expandable ? expandableKinds : leafKinds).add(kind);
        const externalBefore = api.externalOpens.length;
        const sourcesBefore = api.sourceOpens.length;
        const webguiBefore = api.panels.filter((panel) => panel.args[0] === "osdWebgui").length;
        const panelsBefore = api.panels.length;
        const launchpadBefore = launchpadOpens;
        const dumpsBefore = output.shown;
        if (item.command?.command === "osd.clickTreeNode") {
          await clickTreeNode(item, provider, output);
        }
        else if (item.command?.command === "osd.clickTransaction") await clickTransaction(item, output);
        else if (item.command?.command === "osd.newSqlNotebook") {
          expect(item.route).to.equal("/osd/sql");
          await api.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
        }
        else throw new Error(`Unclassified tree command: ${item.label}`);
        if (expandable) expect(api.externalOpens.length, `${kind} opened a browser`).to.equal(externalBefore);
        if (kind === "osd-launchpad") {
          expect(launchpadOpens).to.equal(launchpadBefore + 1);
          expect(item.tooltip).to.match(/VS Code tab/);
          expect(item.command.title).to.equal("Open Fiori Launchpad");
        }
        if (kind === "osd-host-open") {
          // Q7: a VS Code tab by default, not the system browser
          expect(api.externalOpens.length).to.equal(externalBefore);
          expect(api.panels.slice(panelsBefore).map((panel) => panel.args[0])).to.deep.equal(["osdEndpoint"]);
          expect(item.tooltip).to.match(/VS Code tab/);
          expect(item.command.title).to.equal("Open endpoint");
        }
        if (kind === "osd-host-dumps") {
          expect(output.shown).to.equal(dumpsBefore + 1);
          expect(item.command.title).to.equal("Show short dumps");
        }
        if (kind === "osd-transaction-runnable") {
          expect(api.panels.filter((panel) => panel.args[0] === "osdWebgui").length).to.equal(webguiBefore + 1);
          expect(item.command.title).to.equal("Run transaction");
        }
        if (kind === "osd-service-app") {
          expect(api.externalOpens.length).to.equal(externalBefore);
          expect(api.panels.slice(panelsBefore).map((panel) => panel.args[0])).to.deep.equal(["osdService"]);
          expect(item.tooltip).to.match(/VS Code tab/);
          expect(item.command.title).to.equal("Open app");
        }
        if (kind === "osd-service-odata" && !expandable) {
          expect(api.externalOpens.length).to.equal(externalBefore);
          expect(api.panels.slice(panelsBefore).map((panel) => panel.args[0])).to.deep.equal(["osdService"]);
          expect(item.tooltip).to.match(/VS Code tab/);
          expect(item.command.title).to.equal("Open service");
          expect(await provider.getChildren(item)).to.deep.equal([]);
        }
        if (kind === "osd-service-class" || kind === "osd-service-entityset")
          expect(api.sourceOpens.length).to.equal(sourcesBefore + 1);
        if (kind === "osd-service-class" || kind === "osd-service-entityset")
          expect(item.command.title).to.equal("Open source");
        for (const child of await provider.getChildren(item)) await visit(child);
      };
      for (const item of provider.getChildren()) await visit(item);
      // EntitySetItem is produced when the live entity-set map answers.
      await visit(new EntitySetItem("ZCL_TEST_DPC", {set: "TravelSet", kind: "GET_ENTITYSET"}, 12));
      await provider.setServiceOption("groupBy", "layer");
      for (const item of provider.serviceGroupItems()) {
        seen.add("osd-service-pack-group");
        await clickTreeNode(item, provider, output);
      }
      controller.launcher.state = "stopped";
      const stoppedRoots = provider.getChildren();
      expect(stoppedRoots[0].label).to.match(/^Stopped \(click here!\)/);
      await visit(stoppedRoots[0]);
      for (const item of [stoppedRoots[3], stoppedRoots[5]]) {
        for (const child of await provider.getChildren(item)) await visit(child);
      }
      controller.launcher.state = "building";
      await visit(provider.getChildren()[0]);
      expect([...seen]).to.include.members(["osd-state-running", "osd-launchpad", "osd-system-group", "osd-host-open",
        "osd-host-dumps", "osd-host-sql", "osd-transactions", "osd-transaction-runnable", "osd-transaction",
        "osd-layers", "osd-layer-base", "osd-layer-workspace", "osd-services", "osd-service-group", "osd-service-pack-group",
        "osd-service-class", "osd-service-entityset", "osd-placeholder", "osd-state-stopped", "osd-state-building",
        "osd-service-app", "osd-service-odata", "osd-service-icf", "osd-service-apc"]);
      expect([...expandableKinds]).to.include.members(["osd-system-group", "osd-transactions", "osd-layers", "osd-services", "osd-service-group", "osd-service-odata"]);
      expect([...leafKinds]).to.include.members(["osd-launchpad", "osd-host-open", "osd-host-dumps", "osd-host-sql", "osd-transaction-runnable", "osd-service-app", "osd-service-class", "osd-service-entityset"]);
      expect(api.executedCommands).to.deep.equal([["osd.newSqlNotebook"]]);
      expect(launchpadOpens).to.equal(1);
      expect(overviewOpens).to.equal(3);
      expect(api.panels.filter((panel) => panel.args[0] === "osdWebgui")).to.have.lengthOf(1);

      const serving = new api.TreeItem("Other endpoint");
      serving.contextValue = "osd-host-open";
      serving.route = "/osd/other";
      const externalBefore = api.externalOpens.length;
      const endpointTabs = () => api.panels.filter((panel) => panel.args[0] === "osdEndpoint" && panel.webview.html.includes("/osd/other"));
      let reveals = 0;
      await clickTreeNode(serving, provider, output);
      expect(endpointTabs()).to.have.lengthOf(1);
      endpointTabs()[0].reveal = () => { reveals++; };
      // a second click reveals the tab it already has
      await clickTreeNode(serving, provider, output);
      expect(endpointTabs()).to.have.lengthOf(1);
      expect(reveals).to.equal(1);
      expect(api.externalOpens).to.have.lengthOf(externalBefore);

      const launchpad = new api.TreeItem("Another launchpad");
      launchpad.contextValue = "osd-launchpad";
      await clickTreeNode(launchpad, provider, output);
      expect(launchpadOpens).to.equal(2);
      await clickTreeNode(launchpad, provider, output);
      expect(launchpadOpens).to.equal(3);
    } finally {
      provider.dispose();
    }
  });
  // Q7: a page opens in a VS Code tab by default, in the browser when
  // osd.openIn says so, and always in the browser through the explicit
  // external action; every tree node that opens a URL has that action inline
  // and in its context menu.
  it("routes page opens: a tab by default, the browser by setting or by the external action", async () => {
    const url = "http://localhost:3591/app/flp.html";
    const byDefault = vscodeStub({home: ROOT});
    await loadExtension(byDefault).openPage(url, {title: "Fiori Launchpad"});
    expect(byDefault.panels.map((panel) => panel.args[0])).to.deep.equal(["osdPage"]);
    expect(byDefault.externalOpens).to.have.lengthOf(0);
    const external = vscodeStub({home: ROOT});
    await loadExtension(external).openPage(url, {where: "browser"});
    expect(external.panels).to.have.lengthOf(0);
    expect(external.externalOpens.map(String)).to.deep.equal([url]);
    const bySetting = vscodeStub({home: ROOT, openIn: "browser"});
    const {openPage} = loadExtension(bySetting);
    await openPage(url);
    expect(bySetting.externalOpens).to.have.lengthOf(1);
    // an explicit "vscode" (osd.openLaunchpadInVsCode) wins over the setting
    await openPage(url, {where: "vscode"});
    expect(bySetting.panels).to.have.lengthOf(1);

    const manifest = JSON.parse(readFileSync(new URL("../editors/vscode/package.json", import.meta.url), "utf8"));
    expect(manifest.contributes.configuration.find?.((c) => c.properties?.["osd.openIn"])?.properties["osd.openIn"].default
      ?? manifest.contributes.configuration.properties["osd.openIn"].default).to.equal("vscode");
    const items = manifest.contributes.menus["view/item/context"];
    const commands = new Map(manifest.contributes.commands.map((c) => [c.command, c]));
    for (const [external, node] of [["osd.openLaunchpadExternal", "osd-launchpad"], ["osd.openHostDoorExternal", "osd-host-open"],
      ["osd.openServiceRowExternal", "osd-service-app"]]) {
      const entries = items.filter((m) => m.command === external && m.when.includes(node));
      expect(entries.map((m) => m.group.split("@")[0]).sort(), external).to.deep.equal(["1_open", "inline"]);
      expect(commands.get(external).icon).to.equal("$(link-external)");
      expect(commands.get(external).title).to.match(/in External Browser$/);
    }
    const palette = manifest.contributes.menus.commandPalette;
    for (const command of ["osd.newSqlNotebook", "osd.openSample", "osd.showRawJobLog"]) {
      expect(palette.find((m) => m.command === command)?.when, command).to.equal("!isWeb && !osd.web");
    }
    for (const command of ["osd.openHostDoorExternal", "osd.openServiceRowExternal", "osd.openServiceMetadataExternal"]) {
      expect(palette.find((m) => m.command === command)?.when, command).to.equal("false");
    }
    expect(items.some((m) => m.command === "osd.openServiceMetadataExternal")).to.equal(true);
  });

  it("the registered open commands: the external ones use the browser with a tree item, the others osd.openIn", async () => {
    const api = vscodeStub({home: ROOT});
    const handlers = new Map();
    api.commands.registerCommand = (command, handler) => { handlers.set(command, handler); return {dispose() {}}; };
    const {registerOpenCommands} = loadExtension(api);
    const launchpad = [];
    const controller = {openLaunchpad: (where) => launchpad.push(where ?? "default"), openLaunchpadInVsCode: () => launchpad.push("vscode")};
    registerOpenCommands({subscriptions: []}, controller);
    const external = [["osd.openHostDoorExternal", {route: "/osd/serving"}],
      ["osd.openServiceRowExternal", {row: {kind: "ICF", path: "/sap/bc/leaf", name: "Leaf"}}],
      ["osd.openServiceMetadataExternal", {row: {kind: "ODATA", path: "/sap/opu/odata/sap/ZLEAF", name: "Leaf"}}]];
    for (const [command, item] of external) {
      const before = api.externalOpens.length;
      await handlers.get(command)(item);
      expect(api.externalOpens.length, command).to.equal(before + 1);
    }
    expect(api.panels, "an external action opens no tab").to.have.lengthOf(0);
    await handlers.get("osd.openHostDoor")({route: "/osd/serving"});
    await handlers.get("osd.openServiceMetadata")({row: {kind: "ODATA", path: "/sap/opu/odata/sap/ZLEAF", name: "Leaf"}});
    expect(api.panels.map((panel) => panel.args[0])).to.deep.equal(["osdEndpoint", "osdServiceMetadata"]);
    await handlers.get("osd.openLaunchpadExternal")();
    await handlers.get("osd.openLaunchpad")();
    await handlers.get("osd.openLaunchpadInVsCode")();
    expect(launchpad).to.deep.equal(["browser", "default", "vscode"]);
  });

  it("a closed page tab is forgotten, and a stopped system closes its tabs", async () => {
    const api = vscodeStub({home: ROOT});
    const {openPage, closePageTabs} = loadExtension(api);
    const first = await openPage("http://localhost:3591/osd/serving");
    first.dispose();
    const second = await openPage("http://localhost:3591/osd/serving");
    expect(second, "a new tab after the old one was closed").to.not.equal(first);
    const other = await openPage("http://localhost:3591/app/flp.html");
    closePageTabs();
    expect([second.disposed, other.disposed]).to.deep.equal([true, true]);
    const third = await openPage("http://localhost:3591/osd/serving");
    expect(api.panels).to.have.lengthOf(4);
    expect(third.disposed).to.equal(false);
  });

  it("Stop awaits recovery cleanup and distinguishes reload shutdown", async () => {
    const api = vscodeStub({home: ROOT});
    const {SystemController} = loadExtension(api);
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    const order = [];
    const off = controller.onWillStop(event => {
      order.push(event.shutdown ? "shutdown" : "explicit");
      event.waitUntil(new Promise(resolve => setImmediate(() => { order.push("cleared"); resolve(); })));
    });
    controller.launcher = {stop: async () => order.push("launcher stopped")};
    await controller.stop();
    await controller.stop({shutdown: true});
    expect(order).to.deep.equal(["explicit", "cleared", "launcher stopped", "shutdown", "cleared", "launcher stopped"]);
    off.dispose();
  });

  it("page tabs: a rebuild reloads them (on a new port too), Stop and an unasked exit close them", async () => {
    const api = vscodeStub({home: ROOT});
    const {openPage, wirePageTabs, SystemController} = loadExtension(api);
    const launcher = new NodeEventEmitter();
    launcher.port = 3591;
    wirePageTabs(launcher);
    const tab = await openPage("http://localhost:3591/app/flp.html", {title: "Fiori Launchpad"});
    tab.title = "Fiori Launchpad";
    const before = tab.webview.html;
    // rebuild: stop, then start on another port -- the tab stays and follows
    launcher.emit("state", "stopped");
    launcher.port = 3592;
    launcher.emit("state", "running");
    await new Promise((r) => setTimeout(r, 10));
    expect(tab.disposed).to.equal(false);
    expect(tab.webview.html).to.not.equal(before);
    expect(tab.webview.html).to.contain("http://localhost:3592/app/flp.html");
    // the moved tab is found under its new URL
    expect(await openPage("http://localhost:3592/app/flp.html")).to.equal(tab);
    // an exit nobody asked for closes it
    launcher.emit("exit", {code: 1});
    expect(tab.disposed).to.equal(true);
    // and Stop closes whatever is open
    const again = await openPage("http://localhost:3592/osd/serving");
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    controller.launcher = {stop: async () => {}};
    await controller.stop();
    expect(again.disposed).to.equal(true);
  });

  it("page tabs: a moved tab is forgotten when closed; a Stop racing a reload or a collision leaves no orphan", async () => {
    const api = vscodeStub({home: ROOT});
    const {openPage, reloadPageTabs, closePageTabs} = loadExtension(api);
    const moved = await openPage("http://localhost:3591/app/flp.html");
    await reloadPageTabs(3592);
    moved.dispose();
    const fresh = await openPage("http://localhost:3592/app/flp.html");
    expect(fresh, "a closed tab is not revealed again").to.not.equal(moved);
    // a Stop while the reload awaits asExternalUri, with a second tab still to come
    const second = await openPage("http://localhost:3592/osd/serving");
    const reloading = reloadPageTabs(3593);
    closePageTabs();
    await reloading;
    expect([fresh.disposed, second.disposed]).to.deep.equal([true, true]);
    for (const page of ["app/flp.html", "osd/serving"]) {
      const after = await openPage(`http://localhost:3593/${page}`);
      expect(after.disposed, `${page}: not a tab the Stop closed`).to.equal(false);
    }
    // two tabs that would land on one URL: one is kept, the other closed, none untracked
    closePageTabs();
    const a = await openPage("http://localhost:3594/osd/serving");
    const b = await openPage("http://localhost:3595/osd/serving");
    await reloadPageTabs(3595);
    expect([a.disposed, b.disposed]).to.deep.equal([true, false]);
    closePageTabs();
    expect(b.disposed, "Stop reaches every tab still open").to.equal(true);
  });

  it("page tabs through the real Launcher: a rebuild keeps and reloads them, Stop closes them", async function () {
    this.timeout(20000);
    const api = vscodeStub({home: ROOT});
    const {openPage, SystemController} = loadExtension(api);
    const {Launcher} = require("../editors/vscode/launcher.js");
    const osdHome = mkdtempSync(path.join(tmpdir(), "osd-q7-home-"));
    const storageDir = mkdtempSync(path.join(tmpdir(), "osd-q7-storage-"));
    mkdirSync(path.join(osdHome, "tools"), {recursive: true});
    mkdirSync(path.join(osdHome, "test"), {recursive: true});
    writeFileSync(path.join(osdHome, "tools", "osd-build.mjs"), "process.exit(0);\n");
    writeFileSync(path.join(osdHome, "test", "run.mjs"),
      "import {createServer} from 'node:http';\n" +
      "createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ready: true, generation: 'fake', launcherPid: process.pid, launcherIdentity: process.env.OSD_LAUNCHER_IDENTITY})); })" +
      ".listen(Number(process.env.STG_PORT), '127.0.0.1');\n");
    const controller = new SystemController(controllerContext(), {append() {}, appendLine() {}, show() {}});
    const launcher = new Launcher({osdHome, storageDir, workspaceFolders: [], timeoutMs: 15000});
    controller.attachLauncher(launcher);
    try {
      await launcher.start();
      const tab = await openPage(`http://localhost:${launcher.port}/app/flp.html`, {title: "Fiori Launchpad"});
      tab.title = "Fiori Launchpad";
      tab.webview.html = "stale";
      await launcher.rebuild();
      await new Promise((r) => setTimeout(r, 20));
      expect(tab.disposed, "a rebuild keeps the tab").to.equal(false);
      expect(tab.webview.html, "and reloads it").to.contain(`http://localhost:${launcher.port}/app/flp.html`);
      await controller.stop();
      expect(tab.disposed, "Stop closes it").to.equal(true);
    } finally {
      await launcher.stop();
      rmSync(osdHome, {recursive: true, force: true});
      rmSync(storageDir, {recursive: true, force: true});
    }
  });

  it("the details panel's $metadata links: a tab by default, the browser for 'in browser'", async () => {
    const api = vscodeStub({home: ROOT});
    const {openDetailsMetadata} = loadExtension(api);
    const item = {row: {kind: "ODATA", path: "/sap/opu/odata/sap/ZLEAF", name: "Leaf"}};
    await openDetailsMetadata(item, {command: "openMetadata", where: "default"});
    expect(api.panels.map((panel) => panel.args[0])).to.deep.equal(["osdServiceMetadata"]);
    await openDetailsMetadata(item, {command: "openMetadata", where: "browser"});
    expect(api.externalOpens).to.have.lengthOf(1);
    // a transaction's details carry no service: nothing opens
    await openDetailsMetadata(undefined, {command: "openMetadata"});
    expect(api.panels).to.have.lengthOf(1);
  });

  it("keeps entity-set and entity clicks separate for the same DPC and set", async () => {
    const api = vscodeStub({home: ROOT});
    const {EntitySetItem, clickTreeNode} = loadExtension(api);
    const provider = {controller: {openSystemOverview() {}}};
    let sourceLookups = 0;
    api.workspace.findFiles = async () => { sourceLookups++; return [{fsPath: "stub.clas.abap"}]; };
    const entitySet = new EntitySetItem("ZCL_CLICK_PAIR_DPC", {set: "TravelSet", kind: "get_entityset"}, 12);
    const entity = new EntitySetItem("ZCL_CLICK_PAIR_DPC", {set: "TravelSet", kind: "get_entity"}, 20);
    await clickTreeNode(entitySet, provider);
    await clickTreeNode(entity, provider);
    expect(sourceLookups).to.equal(2);
    expect(api.sourceOpens).to.have.lengthOf(2);
    expect(api.sourceOpens[1].fsPath).to.equal("stub.clas.abap");
    expect(api.sourceEditors.map((editor) => editor.selection.start.line)).to.deep.equal([11, 19]);
  });
  it("opens an entity set in the running base system when only a pack is the VS Code workspace", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "osd-entityset-home-"));
    const relative = "src/demo/zcl_zstg_demo_dpc_ext.clas.abap";
    const target = path.join(home, relative);
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, "CLASS zcl_zstg_demo_dpc_ext IMPLEMENTATION.\n  METHOD travelset_get_entityset.\n  ENDMETHOD.\nENDCLASS.\n");
    const api = vscodeStub({home, url: "http://localhost:5999"});
    api.workspace.workspaceFolders = [{uri: {fsPath: "/workspace/osg-demo"}}];
    api.workspace.findFiles = async () => [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ok: true, status: 200, json: async () => ({sets: [
      {set: "TravelSet", kind: "get_entityset", method: "TRAVELSET_GET_ENTITYSET"},
    ]})});
    const {OsdTreeProvider, clickTreeNode} = loadExtension(api);
    const provider = new OsdTreeProvider({context: controllerContext(), launcher: {state: "running", osdHome: home}, onDidChange() {}},
      async () => ({sources: {}, testClasses: []}));
    try {
      const row = {kind: "ODATA", handler: "ZCL_ZSTG_DEMO_DPC_EXT", handlerSource: relative};
      const items = await provider.serviceClassItems(row);
      const travel = items.find((item) => item.contextValue === "osd-service-entityset");
      expect(travel.line).to.equal(2);
      await clickTreeNode(travel, provider);
      expect(api.sourceOpens.at(-1).fsPath).to.equal(target);
      expect(api.sourceEditors.at(-1).selection.start.line).to.equal(1);
    } finally {
      provider.dispose();
      globalThis.fetch = oldFetch;
      rmSync(home, {recursive: true, force: true});
    }
  });
  it("opens an inherited entity set method in its generated DPC base", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "osd-entityset-base-"));
    const extPath = "src/demo/zcl_sample_dpc_ext.clas.abap";
    const basePath = "src/demo/zcl_sample_dpc.clas.abap";
    mkdirSync(path.join(home, "src/demo"), {recursive: true});
    writeFileSync(path.join(home, extPath), "CLASS zcl_sample_dpc_ext IMPLEMENTATION.\nENDCLASS.\n");
    writeFileSync(path.join(home, basePath), "CLASS zcl_sample_dpc IMPLEMENTATION.\n  METHOD travelset_get_entityset.\n  ENDMETHOD.\nENDCLASS.\n");
    const api = vscodeStub({home, url: "http://localhost:5999"});
    api.workspace.findFiles = async () => [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ok: true, status: 200, json: async () => ({sets: [
      {set: "TravelSet", kind: "get_entityset", method: "TRAVELSET_GET_ENTITYSET"},
    ]})});
    const {OsdTreeProvider, clickTreeNode} = loadExtension(api);
    const provider = new OsdTreeProvider({context: controllerContext(), launcher: {state: "running", osdHome: home}, onDidChange() {}},
      async () => ({sources: {}, testClasses: []}));
    try {
      const items = await provider.serviceClassItems({kind: "ODATA", handler: "ZCL_SAMPLE_DPC_EXT", handlerSource: extPath});
      const travel = items.find((item) => item.contextValue === "osd-service-entityset");
      expect(travel.dpcName).to.equal("ZCL_SAMPLE_DPC");
      expect(travel.sourceFile).to.equal(path.join(home, basePath));
      expect(travel.line).to.equal(2);
      await clickTreeNode(travel, provider);
      expect(api.sourceOpens.at(-1).fsPath).to.equal(path.join(home, basePath));
      expect(api.sourceEditors.at(-1).selection.start.line).to.equal(1);
    } finally {
      provider.dispose();
      globalThis.fetch = oldFetch;
      rmSync(home, {recursive: true, force: true});
    }
  });
  it("opens a service leaf on one click and keeps expandable service navigation on double click", async () => {
    const api = vscodeStub({home: ROOT});
    const {OsdTreeProvider, clickTreeNode} = loadExtension(api);
    const controller = {context: controllerContext(), launcher: {state: "running", osdHome: ROOT}, onDidChange() {}};
    const provider = new OsdTreeProvider(controller, async () => ({sources: {}, testClasses: []}));
    try {
      const [leaf] = await provider.serviceRowItems({rows: [{kind: "ICF", path: "/sap/bc/leaf", name: "Leaf"}]});
      expect(leaf.collapsibleState).to.equal(api.TreeItemCollapsibleState.None);
      expect(leaf.tooltip).to.match(/VS Code tab/);
      const serviceTabs = () => api.panels.filter((panel) => panel.args[0] === "osdService");
      await clickTreeNode(leaf, provider);
      expect(serviceTabs()).to.have.lengthOf(1);
      const [expandable] = await provider.serviceRowItems({rows: [{kind: "ICF", path: "/sap/bc/parent", handler: "ZCL_PARENT"}]});
      expect(expandable.collapsibleState).to.equal(api.TreeItemCollapsibleState.Collapsed);
      await clickTreeNode(expandable, provider);
      expect(serviceTabs()).to.have.lengthOf(1);
      await clickTreeNode(expandable, provider);
      expect(serviceTabs()).to.have.lengthOf(2);
      expect(api.externalOpens).to.have.lengthOf(0);
    } finally {
      provider.dispose();
    }
  });
  it("labels the four named kinds SEGW's own words, and title-cases a kind it has never seen", () => {
    expect(serviceGroupLabel("ODATA")).to.equal("OData");
    expect(serviceGroupLabel("APP")).to.equal("Apps");
    expect(serviceGroupLabel("ICF")).to.equal("ICF");
    expect(serviceGroupLabel("APC")).to.equal("APC");
    expect(serviceGroupLabel("DAEMON")).to.equal("Daemon");
    expect(serviceGroupLabel("")).to.equal("Other");
    expect(serviceGroupLabel(undefined)).to.equal("Other");
  });

  it("normalizes a ZOSD_STATUS_SRV ServiceSet row: HandlerName is a class for every kind but APP", () => {
    const icf = normalizeServiceSetRow({Path: "/sap/bc/osd/rfc/", Kind: "ICF", HandlerName: "ZCL_OSD_RFC", Text: "RFC channel", Pack: ""});
    expect(icf).to.deep.equal({
      kind: "ICF", name: undefined, path: "/sap/bc/osd/rfc/", text: "RFC channel", pack: undefined,
      handler: "ZCL_OSD_RFC", handlerUri: undefined, handlerSource: undefined, app: undefined,
      mpc: undefined, mpcUri: undefined, mpcSource: undefined, helpers: [], source: undefined,
    });
    const app = normalizeServiceSetRow({Path: "/app/flp.html#Travel-manage", Kind: "APP", HandlerName: "travels", Text: "Travels", Pack: "o4d"});
    expect(app.handler).to.equal(undefined);
    expect(app.app).to.equal("travels");
    expect(app.pack).to.equal("o4d");
  });

  it("normalizes the composing route's own row, already the target shape, missing keys as undefined", () => {
    const odata = normalizeServiceRow({
      kind: "ODATA", name: "ZSTG_DEMO_SRV", path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV", text: "Demo",
      handler: "ZCL_ZSTG_DEMO_DPC_EXT", handlerUri: "/sap/bc/adt/oo/classes/zcl_zstg_demo_dpc_ext",
      mpc: "ZCL_ZSTG_DEMO_MPC_EXT", mpcUri: "/sap/bc/adt/oo/classes/zcl_zstg_demo_mpc_ext",
      source: "src/demo/zstg_demo.iwsv.xml",
    });
    expect(odata).to.deep.equal({
      kind: "ODATA", name: "ZSTG_DEMO_SRV", path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV", text: "Demo", pack: undefined,
      handler: "ZCL_ZSTG_DEMO_DPC_EXT", handlerUri: "/sap/bc/adt/oo/classes/zcl_zstg_demo_dpc_ext",
      handlerSource: undefined, app: undefined, mpc: "ZCL_ZSTG_DEMO_MPC_EXT", mpcUri: "/sap/bc/adt/oo/classes/zcl_zstg_demo_mpc_ext",
      mpcSource: undefined, helpers: [],
      source: "src/demo/zstg_demo.iwsv.xml",
    });
    const app = normalizeServiceRow({kind: "APP", path: "/app/index.html", text: "", handler: undefined, app: "travels"});
    expect(app.text).to.equal("");
    expect(app.app).to.equal("travels");
    expect(app.handler).to.equal(undefined);
  });

  it("groups by kind in OData/Apps/ICF/APC order, a new kind after them alphabetically, rows sorted by path", () => {
    expect(SERVICE_GROUP_ORDER).to.deep.equal(["ODATA", "APP", "ICF", "APC"]);
    const rows = [
      {kind: "ICF", path: "/sap/bc/osd/rfc/", text: "RFC"},
      {kind: "APP", path: "/app/flp.html#B", text: "B"},
      {kind: "JOB", path: "/job/z", text: "Z job"},
      {kind: "ODATA", path: "/sap/opu/odata/sap/ZB_SRV", text: "B service"},
      {kind: "ODATA", path: "/sap/opu/odata/sap/ZA_SRV", text: "A service"},
      {kind: "APP", path: "/app/flp.html#A", text: "A"},
      {kind: "APC", path: "/sap/bc/apc/z", text: "push"},
      {kind: "DAEMON", path: "/daemon/a", text: "A daemon"},
    ];
    const groups = groupServices(rows);
    expect(groups.map((g) => g.kind)).to.deep.equal(["ODATA", "APP", "ICF", "APC", "DAEMON", "JOB"]);
    expect(groups.map((g) => g.label)).to.deep.equal(["OData", "Apps", "ICF", "APC", "Daemon", "Job"]);
    const odataGroup = groups.find((g) => g.kind === "ODATA");
    expect(odataGroup.rows.map((r) => r.path)).to.deep.equal(["/sap/opu/odata/sap/ZA_SRV", "/sap/opu/odata/sap/ZB_SRV"]);
    const appGroup = groups.find((g) => g.kind === "APP");
    expect(appGroup.rows.map((r) => r.path)).to.deep.equal(["/app/flp.html#A", "/app/flp.html#B"]);
  });

  it("groups an empty list into no groups at all", () => {
    expect(groupServices([])).to.deep.equal([]);
    expect(groupServices(undefined)).to.deep.equal([]);
  });

  it("can regroup those same service rows by pack, keeping unpacked rows visible", () => {
    const groups = groupServices([
      {kind: "ODATA", pack: "o4d", path: "/z", text: "Z service"},
      {kind: "APP", pack: "o4d", path: "/a", text: "A app"},
      {kind: "ICF", pack: "zork", path: "/b", text: "B node"},
      {kind: "APC", pack: undefined, path: "/c", text: "C channel"},
    ], "pack");
    expect(groups.map((g) => g.label)).to.deep.equal(["o4d", "Unpacked", "zork"]);
    expect(groups[0].rows.map((r) => r.text)).to.deep.equal(["A app", "Z service"]);
    expect(groups[1].rows.map((r) => r.kind)).to.deep.equal(["APC"]);
    expect(groups.every((g) => g.groupBy === "pack")).to.equal(true);
  });

  it("defaults to technical names and keeps descriptive text secondary", () => {
    expect(serviceLabel({text: "Travels", name: "ZSTG_DEMO_SRV", path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV"}))
      .to.deep.equal({label: "ZSTG_DEMO_SRV", description: "Travels"});
    expect(serviceLabel({text: "", name: "ZSTG_DEMO_SRV", path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV"}))
      .to.deep.equal({label: "ZSTG_DEMO_SRV", description: ""});
    expect(serviceLabel({text: "", name: undefined, path: "/app/index.html"}))
      .to.deep.equal({label: "/app/index.html", description: ""});
  });

  it("gives each kind its own lower-cased contextValue, for view/item/context in package.json to match", () => {
    expect(serviceContextValue("ODATA")).to.equal("osd-service-odata");
    expect(serviceContextValue("APP")).to.equal("osd-service-app");
    expect(serviceContextValue("ICF")).to.equal("osd-service-icf");
    expect(serviceContextValue("APC")).to.equal("osd-service-apc");
    expect(serviceContextValue("DAEMON")).to.equal("osd-service-daemon");
  });

  it("advertises only URL, metadata, WebSocket, test, and source actions with real targets", () => {
    expect(serviceActionContext({kind: "ODATA", path: "/odata"}, {sources: {dpc: {path: "dpc.abap"}}, testClasses: ["ZCL_TEST"]}))
      .to.equal("osd-service-odata;url;metadata;test;source-dpc");
    expect(serviceActionContext({kind: "APC", path: "/ws"}, {sources: {}, testClasses: []}))
      .to.equal("osd-service-apc;url;ws");
    expect(serviceActionContext({kind: "APP", path: ""}, {sources: {}, testClasses: []}))
      .to.equal("osd-service-app");
    expect(serviceActionContext({kind: "ODATA", path: "/odata"}, {sources: {dpc: {path: undefined}}, testClasses: []}))
      .to.equal("osd-service-odata;url;metadata");
  });

  it("resolves Test and Source before a service row is first shown in the tree", async () => {
    const api = vscodeStub();
    const {OsdTreeProvider} = loadTreeItems(api);
    const controller = {launcher: {state: "running"}, onDidChange: () => {}};
    const row = {kind: "ODATA", path: "/sap/opu/odata/sap/ZDEMO", handler: "ZCL_DEMO_DPC_EXT"};
    const provider = new OsdTreeProvider(controller, async () => ({sources: {dpc: {path: "src/demo.clas.abap"}}, testClasses: ["ZCL_TEST"]}));
    try {
      const [item] = await provider.serviceRowItems({rows: [row]});
      expect(item.contextValue).to.equal("osd-service-odata;url;metadata;test;source-dpc");
    } finally {
      provider.dispose();
    }
  });

  it("builds the URL a click or a context action opens: the plain path for APP/ICF/ODATA, $metadata beside it, ws:// for APC", () => {
    const base = "http://localhost:3591";
    const odata = {path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV"};
    expect(serviceHttpUrl(odata, base)).to.equal("http://localhost:3591/sap/opu/odata/sap/ZSTG_DEMO_SRV");
    expect(serviceMetadataUrl(odata, base)).to.equal("http://localhost:3591/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata");
    const apc = {path: "/sap/bc/apc/zosd/push"};
    expect(serviceWsUrl(apc, base)).to.equal("ws://localhost:3591/sap/bc/apc/zosd/push");
    expect(serviceWsUrl(apc, "https://localhost:44300")).to.equal("wss://localhost:44300/sap/bc/apc/zosd/push");
    const app = {path: "/app/flp.html#Travel-manage"};
    expect(serviceHttpUrl(app, base)).to.equal("http://localhost:3591/app/flp.html#Travel-manage");
  });

  it("uses VS Code's external URI for a metadata link in a remote workspace", async () => {
    const row = {path: "/sap/opu/odata/sap/ZDEMO"};
    const externalized = [];
    const url = await serviceMetadataExternalUrl(row, "http://localhost:3030", async (raw) => {
      externalized.push(raw);
      return "https://forwarded.example/sap/opu/odata/sap/ZDEMO/$metadata";
    });
    expect(externalized).to.deep.equal(["http://localhost:3030/sap/opu/odata/sap/ZDEMO/$metadata"]);
    expect(url).to.equal("https://forwarded.example/sap/opu/odata/sap/ZDEMO/$metadata");
  });

  it("expands an OData row to its DPC then its MPC, an ICF/APC row to its one handler, an APP row to nothing", () => {
    const odata = {kind: "ODATA", handler: "ZCL_X_DPC_EXT", handlerUri: "/sap/bc/adt/oo/classes/zcl_x_dpc_ext",
      mpc: "ZCL_X_MPC_EXT", mpcUri: "/sap/bc/adt/oo/classes/zcl_x_mpc_ext"};
    expect(serviceClassNodes(odata)).to.deep.equal([
      {role: "dpc", name: "ZCL_X_DPC_EXT", uri: "/sap/bc/adt/oo/classes/zcl_x_dpc_ext", source: undefined},
      {role: "mpc", name: "ZCL_X_MPC_EXT", uri: "/sap/bc/adt/oo/classes/zcl_x_mpc_ext", source: undefined},
    ]);
    // ServiceSet carries no uri at all -- still a node, just nothing to open by uri
    const icf = {kind: "ICF", handler: "ZCL_OSD_RFC", handlerUri: undefined};
    expect(serviceClassNodes(icf)).to.deep.equal([{role: "handler", name: "ZCL_OSD_RFC", uri: undefined, source: undefined}]);
    const apc = {kind: "APC", handler: "ZCL_OSD_APC_HANDLER", handlerUri: "/sap/bc/adt/oo/classes/zcl_osd_apc_handler"};
    expect(serviceClassNodes(apc)).to.deep.equal([{role: "handler", name: "ZCL_OSD_APC_HANDLER", uri: "/sap/bc/adt/oo/classes/zcl_osd_apc_handler", source: undefined}]);
    const app = {kind: "APP", app: "travels"};
    expect(serviceClassNodes(app)).to.deep.equal([]);
    // a kind this client has never seen, but that still carries a handler
    const daemon = {kind: "DAEMON", handler: "ZCL_OSD_DAEMON"};
    expect(serviceClassNodes(daemon)).to.deep.equal([{role: "handler", name: "ZCL_OSD_DAEMON", uri: undefined, source: undefined}]);
  });

  it("keeps generated MPC helpers under their service row", () => {
    const odata = {kind: "ODATA", handler: "ZCL_X_DPC_EXT", mpc: "ZCL_X_MPC_EXT", helpers: [
      {role: "annotations", name: "ZCL_X_MPC_ANN", source: "gen/stg/x/zcl_x_mpc_ann.clas.abap"},
      {role: "registry", name: "ZCL_STG_SEGW_REGISTRY", source: "gen/segw/zcl_stg_segw_registry.clas.abap"},
    ]};
    expect(serviceClassNodes(odata).map((node) => node.name)).to.deep.equal([
      "ZCL_X_DPC_EXT", "ZCL_X_MPC_EXT", "ZCL_X_MPC_ANN", "ZCL_STG_SEGW_REGISTRY",
    ]);
    expect(serviceClassNodes({kind: "APP", app: "travel", helpers: [
      {role: "registry", name: "ZCL_STG_BSP_REGISTRY", source: "gen/bsp/zcl_stg_bsp_registry.clas.abap"},
    ]})).to.deep.equal([{role: "registry", name: "ZCL_STG_BSP_REGISTRY", uri: undefined,
      source: "gen/bsp/zcl_stg_bsp_registry.clas.abap"}]);
  });

  it("resolves manifest identity, inbound intent, and dataSources to the OData service rows", () => {
    const app = appManifestDetails({"sap.app": {
      id: "stg.travel", title: "Travels", dataSources: {mainService: {uri: "../sap/opu/odata/sap/ZSTG_DEMO_SRV/"}},
      crossNavigation: {inbounds: {"Travel-manage": {}, "Travel-display": {}}},
    }}, {app: "stg.travel", source: "webapp"}, [
      {kind: "ODATA", name: "ZSTG_DEMO_SRV", path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV"},
    ]);
    expect(app).to.deep.equal({id: "stg.travel", title: "Travels", intent: "Travel-manage", folder: "webapp",
      dataSources: [{key: "mainService", uri: "../sap/opu/odata/sap/ZSTG_DEMO_SRV/", service: "ZSTG_DEMO_SRV"}]});
  });

  it("collects HTTP test files by full service URL or a service URL assembled in source", () => {
    expect(httpTestFiles([
      {path: "test/e2e/travel.spec.mjs", source: `fetch(base + "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet")`},
      {path: "test/other.mjs", source: "ZSTG_DEMO_SRV but no OData request"},
      {path: "test/http.mjs", source: "const url = '/sap/opu/odata/sap/ZOTHER_SRV'"},
      {path: "test/other-service.mjs", source: "// ZSTG_DEMO_SRV is unrelated here\nfetch('/sap/opu/odata/sap/ZOTHER_SRV/Set')"},
      {path: "test/assembled.mjs", source: "fetch('/sap/opu/odata/sap/' + 'ZSTG_DEMO_SRV' + '/Set')"},
    ], "/sap/opu/odata/sap/ZSTG_DEMO_SRV", "ZSTG_DEMO_SRV")).to.deep.equal(["test/assembled.mjs", "test/e2e/travel.spec.mjs"]);
  });

  it("keeps every transaction selectable and exposes Run only for runnable rows", () => {
    const {TransactionItem} = loadTreeItems(vscodeStub());
    const report = new TransactionItem(normalizeTransactionRow({tcode: "ZREP", kind: "REPORT", runnable: false, reason: "unbound"}));
    const dynpro = new TransactionItem(normalizeTransactionRow({tcode: "ZSCREEN", kind: "DYNPRO", runnable: false, reason: "missing screen"}));
    const runnable = new TransactionItem(normalizeTransactionRow({tcode: "ZRUN", kind: "CLASS", runnable: true}));
    expect(report.label).to.equal("ZREP");
    expect(report.command?.command).to.equal("osd.clickTransaction");
    expect(dynpro.command?.command).to.equal("osd.clickTransaction");
    expect(runnable.command?.command).to.equal("osd.clickTransaction");
    expect(report.contextValue).to.equal("osd-transaction");
    expect(runnable.contextValue).to.equal("osd-transaction-runnable");
  });

  it("classifies a second TRAN click per node within 400 ms and resets after a run", () => {
    let clicks = new Map();
    const click = (node, at) => {
      const result = classifyTransactionClick(clicks, node, at);
      clicks = result.clicks;
      return result.action;
    };
    expect(click("ZA", 1000)).to.equal("single");
    expect(click("ZB", 1100)).to.equal("single");
    expect(click("ZA", 1400)).to.equal("double");
    expect(click("ZA", 1450)).to.equal("single");
    expect(click("ZB", 1501)).to.equal("single");
    expect(click("ZB", 1902)).to.equal("single");
    expect(click("ZB", 1903)).to.equal("double");
    expect(click("ZA", 2000)).to.equal("single");
    expect(click("ZA", 1900)).to.equal("single"); // clock moved backwards
  });

  it("models report, dialog, OO and parameter TRAN details with a link only for a found program", () => {
    const common = {tcode: "ZREP", text: "Report <demo>", source: "src/webgui/zrep.tran.xml", program: "ZREP_MAIN"};
    const report = transactionDetailsModel({...common, kind: "REPORT"}, "src/webgui/zrep_main.prog.abap");
    expect(report).to.include({kind: "Report transaction", target: "ZREP_MAIN", targetType: "Program",
      package: "webgui", layer: "Project", programSource: "src/webgui/zrep_main.prog.abap"});
    expect(transactionDetailsModel({...common, kind: "DYNPRO", dynpro: "100"}).kind).to.equal("Dialog transaction");
    expect(transactionDetailsModel({...common, kind: "CLASS", className: "ZCL_REP", parameter: "\\CLASS=ZCL_REP"}))
      .to.include({kind: "OO transaction", target: "ZCL_REP", targetType: "Class"});
    expect(transactionDetailsModel({...common, parameter: "/*START"}).kind).to.equal("Parameter transaction");
    const parameter = transactionDetailsModel({...common, program: "", parameter: "/*START WITH_ARGS"});
    expect(parameter).to.include({kind: "Parameter transaction", target: "START", targetType: "Transaction", programSource: undefined});
    expect(transactionDetailsHtml(parameter, "nonce")).to.contain("Transaction: <code>START</code>");
    const missing = transactionDetailsModel({...common, source: "packs/demo/src/zrep.tran.xml"});
    expect(missing).to.include({layer: "Pack demo", programSource: undefined});
    expect(transactionDetailsHtml(report, "nonce")).to.contain("Go to program").and.to.contain("&lt;demo&gt;");
    expect(transactionDetailsHtml(missing, "nonce")).not.to.contain("Go to program");
  });

  it("runs a TRAN leaf on one click and shows details for an expandable TRAN", async () => {
    const api = vscodeStub();
    const {TransactionItem, clickTransaction} = loadExtension(api);
    const item = new TransactionItem(normalizeTransactionRow({tcode: "ZDETAILS_FOCUS", text: "Focus test", runnable: true}));
    expect(item.command.command).to.equal("osd.clickTransaction");
    await clickTransaction(...item.command.arguments);
    expect(api.panels).to.have.lengthOf(1);
    expect(api.panels[0].args[0]).to.equal("osdWebgui");
    expect(api.panels[0].webview.html).to.contain("ZDETAILS_FOCUS");
    const expandable = new TransactionItem(normalizeTransactionRow({tcode: "ZDETAILS_PROGRAM", runnable: true}));
    expandable.collapsibleState = api.TreeItemCollapsibleState.Collapsed;
    clickTransaction(expandable);
    expect(api.panels.at(-1).args[2]).to.include({viewColumn: api.ViewColumn.Beside, preserveFocus: true});
    expect(api.panels.at(-1).webview.html).to.contain("ZDETAILS_PROGRAM");
    await clickTransaction(expandable);
    expect(api.panels.at(-1).args[0]).to.equal("osdWebgui");
  });

  it("resolves registered TRAN source files and omits a link when the registered file is gone", () => {
    const {transactionProgramPath} = loadExtension(vscodeStub({home: ROOT}));
    expect(transactionProgramPath({className: "ZCL_OSD_NOTE", programSource: "src/webgui/zcl_osd_note.clas.abap"}))
      .to.equal(path.join(ROOT, "src/webgui/zcl_osd_note.clas.abap"));
    expect(transactionProgramPath({program: "ZOSD_TEST_DEMO_PROG", programSource: "src/zosd_test/src/zosd_test_demo_prog.prog.abap"}))
      .to.equal(path.join(ROOT, "src/zosd_test/src/zosd_test_demo_prog.prog.abap"));
    expect(transactionProgramPath({className: "ZCL_OSD_NOTE", programSource: "src/webgui/deleted.clas.abap"}))
      .to.equal(undefined);
  });

  it("contributes direct inline and context Run actions for runnable TRAN rows", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    const actions = manifest.contributes.menus["view/item/context"].filter((entry) => entry.command === "osd.runTransaction");
    expect(actions.map((entry) => entry.group)).to.deep.equal(["inline", "1_run@1"]);
    expect(actions.every((entry) => entry.when.includes("osd-transaction-runnable"))).to.equal(true);
  });

  it("unions closure tests and filters dumps whose mapped frames name the DPC or MPC", () => {
    expect(closureTestNames({tests: ["ZCL_B", "ZCL_A"]}, {tests: ["ZCL_A", "ZCL_C"]})).to.deep.equal(["ZCL_A", "ZCL_B", "ZCL_C"]);
    const row = {handler: "ZCL_X_DPC_EXT", mpc: "ZCL_X_MPC_EXT"};
    expect(dumpsForService([
      {frames: [{file: "src/demo/zcl_x_mpc_ext.clas.abap"}]},
      {frames: [{file: "src/demo/zcl_other.clas.abap"}]},
      {frames: []},
    ], row)).to.have.lengthOf(1);
  });

  it("normalizes transaction registry reports and renders escaped service details with source links", () => {
    expect(normalizeTransactionRow({tcode: "ZREP", text: "A report", kind: "REPORT", runnable: true, source: "gen/gui/zrep.tran.xml"}))
      .to.include({tcode: "ZREP", kind: "REPORT", runnable: true, source: "gen/gui/zrep.tran.xml"});
    const html = serviceDetailsHtml({row: {kind: "ODATA", text: "<Demo>", path: "/sap/opu/odata/sap/ZDEMO", handler: "ZCL_DEMO_DPC_EXT", mpc: "ZCL_DEMO_MPC_EXT"},
      metadataUrl: "http://localhost/sap/opu/odata/sap/ZDEMO/$metadata",
      sources: {dpc: {path: "src/zcl_demo_dpc_ext.clas.abap"}, mpc: {path: "src/zcl_demo_mpc_ext.clas.abap"}},
      entitySets: [{set: "TravelSet", kind: "get_entityset"}],
      closures: {dpc: {counts: {objects: 5, tests: 1}, tests: ["ZCL_TEST"]}, mpc: {counts: {objects: 4, tests: 0}, tests: []}},
      readers: {dpc: {counts: {readers: 3, tests: 1}}, mpc: {counts: {readers: 1, tests: 0}}},
      serving: {generation: "abc123", warm: {state: "primed"}}, dumps: [], httpTests: ["test/e2e/service.spec.mjs"]}, "testnonce");
    expect(html).to.contain("&lt;Demo&gt;").and.to.contain("ABAP Unit by reference").and.to.contain("HTTP tests by URL");
    expect(html).to.contain("TravelSet").and.to.contain("abc123").and.to.contain("data-source=\"dpc\"");
    expect(html).to.contain("test/e2e/service.spec.mjs");
    // Q7: the $metadata link asks the extension (a VS Code tab by osd.openIn), with a browser twin
    expect(html).to.contain('data-metadata="default"').and.to.contain('data-metadata="browser"');
    expect(html).to.not.contain('target="_blank"');
    expect(html).to.contain('closest("[data-metadata]")').and.to.contain('command:"openMetadata"');
  });
});

describe("editors/vscode/lib.js: service details data routes", () => {
  it("reads xref closures and the transaction registry through their server routes", async () => {
    const calls = [];
    const client = new Osd("http://localhost:3620", async (url) => {
      calls.push(url);
      return {
        ok: true, status: 200,
        json: async () => url.includes("/transactions")
          ? {transactions: [{tcode: "ZREP", text: "Converted report", kind: "CLASS", runnable: true, source: "gen/gui/zrep.tran.xml"}]}
          : {type: "CLAS", name: "ZCL_DEMO_DPC_EXT", tests: ["ZCL_DEMO_TEST"], counts: {objects: 8, tests: 1}},
      };
    });
    const closure = await client.closure("CLAS", "ZCL_DEMO_DPC_EXT");
    const transactions = await client.transactions();
    expect(closure.counts).to.deep.equal({objects: 8, tests: 1});
    expect(transactions[0]).to.include({tcode: "ZREP", kind: "CLASS", source: "gen/gui/zrep.tran.xml"});
    expect(calls[0]).to.equal("http://localhost:3620/sap/bc/adt/core/http/xref/closure?type=CLAS&name=ZCL_DEMO_DPC_EXT");
    expect(calls[1]).to.equal("http://localhost:3620/sap/bc/adt/core/http/transactions");
  });
});

describe("editors/vscode: service card source navigation", () => {
  const source = (name) => ({path: name, source: readFileSync(path.join(ROOT, name), "utf8")});

  it("resolves implementation lines case insensitively, including interface methods, skipping comments and declarations", () => {
    const fixture = ["* METHOD x.", "  METHODS x REDEFINITION.", "  \" METHOD x.",
      "  METHOD /iwbep/if_mgw_appl_srv_runtime~get_stream.", "  ENDMETHOD.", "  method X.", "  ENDMETHOD."].join("\n");
    expect(implementationMethodLine(fixture, "X")).to.equal(6);
    expect(implementationMethodLine(fixture, "/IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_STREAM")).to.equal(4);
    expect(implementationMethodLine(fixture, "missing")).to.equal(undefined);
  });

  it("links SEGW operations and function imports to their exact demo DPC lines, and leaves inherited operations unlinked", () => {
    const files = [source("src/demo/zcl_zstg_demo_dpc_ext.clas.abap"), source("src/demo/zcl_zstg_demo_mpc.clas.abap"),
      source("src/demo/zcl_zstg_demo_mpc_ext.clas.abap"), source("src/demo/zstg_demo.stg.yaml"),
      source("src/ddic/zstg_status_sh.shlp.xml"),
      {path: "gen/stg/zstg_demo/zstg_demo.iwpr.xml", source: "<project>ZSTG_DEMO_SRV</project>"},
      {path: "gen/stg/zstg_demo/zcl_zstg_demo_mpc_ann.clas.abap", source: "CLASS zcl_zstg_demo_mpc_ann IMPLEMENTATION.\n METHOD define.\n ENDMETHOD.\nENDCLASS."}];
    const card = serviceCardModel({name: "ZSTG_DEMO_SRV", handler: "ZCL_ZSTG_DEMO_DPC_EXT", mpc: "ZCL_ZSTG_DEMO_MPC_EXT"},
      [{set: "TravelSet"}, {set: "PhotoSet"}, {set: "StatusVHSet"}], files);
    const op = (set, name) => card.entitySets.find((s) => s.set === set).operations.find((one) => one.name === name);
    for (const [set, name, line] of [["TravelSet", "GET_ENTITYSET", 138], ["TravelSet", "CREATE_DEEP_ENTITY", 392],
      ["PhotoSet", "GET_STREAM", 679]]) {
      expect(op(set, name).link).to.include({path: "src/demo/zcl_zstg_demo_dpc_ext.clas.abap", line});
    }
    expect(op("TravelSet", "GET_EXPANDED_ENTITY")).to.include({inherited: true, link: undefined});
    expect(op("BookingSet", "CREATE_DEEP_ENTITY")).to.include({inherited: true, link: undefined});
    expect(card.functionImports.find((one) => one.name === "CancelTravel").link).to.include({line: 525});
    expect(card.entitySets.find((s) => s.set === "StatusVHSet").sources[0].path).to.equal("src/ddic/zstg_status_sh.shlp.xml");
    expect(card.model.map((one) => one.label)).to.include.members(["MPC DEFINE", "MPC_EXT DEFINE", "MPC_ANN DEFINE", ".stg.yaml", "IWPR"]);
    const html = serviceDetailsHtml({row: {kind: "ODATA", name: "ZSTG_DEMO_SRV"}, card}, "nonce");
    expect(html).to.contain('data-line="392"').and.to.contain("inherited (generic)").and.to.contain("Function imports");
    expect(html).to.contain("GET_STREAM interface operation redefined (src/demo/zcl_zstg_demo_dpc_ext.clas.abap:679)");
    expect(html).to.contain("EXECUTE_ACTION function import redefined (src/demo/zcl_zstg_demo_dpc_ext.clas.abap:525)");
    expect(html).to.contain("GET_EXPANDED_ENTITY interface operation <span class=\"muted\">inherited (generic)</span>");
  });

  it("shows DPC_EXT redefinitions at their source lines and keeps other set operations inherited", () => {
    const files = [
      {path: "src/fleet/zcl_fleet_dpc_ext.clas.abap", source: [
        "CLASS zcl_fleet_dpc_ext IMPLEMENTATION.",
        "  METHOD shipset_get_entityset.", "  ENDMETHOD.",
        "  METHOD shipset_get_entity.", "  ENDMETHOD.",
        "  METHOD voyageset_get_entityset.", "  ENDMETHOD.", "ENDCLASS.",
      ].join("\n")},
      {path: "src/fleet/zcl_fleet_dpc.clas.abap", source: [
        "CLASS zcl_fleet_dpc IMPLEMENTATION.",
        "  METHOD shipset_create_entity.", "  ENDMETHOD.", "ENDCLASS.",
      ].join("\n")},
    ];
    const sets = [
      {set: "ShipSet", kind: "get_entityset", method: "SHIPSET_GET_ENTITYSET"},
      {set: "ShipSet", kind: "get_entity", method: "SHIPSET_GET_ENTITY"},
      {set: "VoyageSet", kind: "get_entityset", method: "VOYAGESET_GET_ENTITYSET"},
    ];
    const row = {kind: "ODATA", name: "FLEET_SRV", handler: "ZCL_FLEET_DPC_EXT"};
    const card = serviceCardModel(row, sets, files);
    const operation = (set, name) => card.entitySets.find((item) => item.set === set).operations.find((item) => item.name === name);
    expect(operation("ShipSet", "GET_ENTITYSET").link).to.include({path: files[0].path, line: 2});
    expect(operation("ShipSet", "GET_ENTITY").link).to.include({path: files[0].path, line: 4});
    expect(operation("VoyageSet", "GET_ENTITYSET").link).to.include({path: files[0].path, line: 6});
    expect(operation("ShipSet", "CREATE_ENTITY")).to.include({inherited: true, link: undefined});
    expect(operation("ShipSet", "UPDATE_ENTITY")).to.include({inherited: true, link: undefined});
    const html = serviceDetailsHtml({row, card});
    expect(html).to.contain("GET_ENTITYSET redefined (src/fleet/zcl_fleet_dpc_ext.clas.abap:2)");
    expect(html).to.contain('data-line="2"');
    expect(html).to.contain("CREATE_ENTITY <span class=\"muted\">inherited (generic)</span>");
  });

  it("maps a SADL set to its CDS definition and generated source class", () => {
    const files = [source("src/demo_sadl/zcl_zstg_sadl_mpc.clas.abap"), source("src/demo_sadl/zcl_zstg_sadl_mpc_ext.clas.abap"),
      source("src/demo_sadl/zcl_zstg_sadl_dpc_ext.clas.abap"), source("src/cds/zc_stg_travel.ddls.asddls"),
      {path: "gen/cds/zcl_stg_cds_zvstgtravel.clas.abap", source: "CLASS zcl_stg_cds_zvstgtravel IMPLEMENTATION.\n METHOD zif_stg_cds_source~read.\n ENDMETHOD.\nENDCLASS."}];
    const card = serviceCardModel({name: "ZSTG_SADL_SRV", handler: "ZCL_ZSTG_SADL_DPC_EXT", mpc: "ZCL_ZSTG_SADL_MPC_EXT"}, [], files);
    const travel = card.entitySets.find((set) => set.set === "Zc_Stg_TravelSet");
    expect(travel.sources.map((one) => one.path)).to.deep.equal([
      "src/cds/zc_stg_travel.ddls.asddls", "gen/cds/zcl_stg_cds_zvstgtravel.clas.abap"]);
    expect(travel.sources[1]).to.include({line: 2});
  });

  it("resolves a ServiceSet row from its URL without matching unrelated IWPR files", () => {
    const row = normalizeServiceSetRow({Kind: "ODATA", Path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV/", HandlerName: "ZCL_ZSTG_DEMO_DPC_EXT"});
    const files = [source("src/demo/zcl_zstg_demo_mpc.clas.abap"), source("src/demo/zcl_zstg_demo_mpc_ext.clas.abap"),
      source("src/demo/zcl_zstg_demo_dpc_ext.clas.abap"),
      {path: "gen/other/unrelated.iwpr.xml", source: "<project>UNRELATED_SRV</project>"}];
    const card = serviceCardModel(row, [{set: "TravelSet"}], files);
    expect(card.model.map((one) => one.label)).to.include("MPC DEFINE");
    expect(card.model.map((one) => one.label)).not.to.include("IWPR");
    expect(card.entitySets.find((one) => one.set === "TravelSet").operations.find((one) => one.name === "GET_ENTITYSET").link).to.include({line: 138});
  });

  it("uses known source paths and stable layer precedence for duplicate class names", () => {
    const files = [
      {path: "src/demo/zcl_sample_dpc_ext.clas.abap", source: "METHOD travelset_get_entityset.\nENDMETHOD."},
      {path: "packs/other/src/zcl_sample_dpc_ext.clas.abap", source: "METHOD travelset_get_entityset.\nENDMETHOD."},
      {path: "src/demo/zcl_sample_mpc.clas.abap", source: "METHOD define.\nENDMETHOD."},
      {path: "packs/other/src/zcl_sample_mpc.clas.abap", source: "METHOD define.\nENDMETHOD."},
    ];
    const row = {handler: "ZCL_SAMPLE_DPC_EXT", handlerSource: "src/demo/zcl_sample_dpc_ext.clas.abap", mpc: "ZCL_SAMPLE_MPC_EXT", mpcSource: "src/demo/zcl_sample_mpc_ext.clas.abap"};
    const card = serviceCardModel(row, [{set: "TravelSet"}], files);
    expect(card.entitySets[0].operations[0].link.path).to.equal("src/demo/zcl_sample_dpc_ext.clas.abap");
    expect(card.model[0].path).to.equal("src/demo/zcl_sample_mpc.clas.abap");
    expect(serviceCardModel({handler: "ZCL_SAMPLE_DPC_EXT"}, [{set: "TravelSet"}], files).entitySets[0].operations[0].link.path)
      .to.equal("src/demo/zcl_sample_dpc_ext.clas.abap");
    const packed = normalizeServiceSetRow({Kind: "ODATA", Pack: "other", HandlerName: "ZCL_SAMPLE_DPC_EXT"});
    const packedCard = serviceCardModel(packed, [{set: "TravelSet"}], files);
    expect(packedCard.entitySets[0].operations[0].link.path).to.equal("packs/other/src/zcl_sample_dpc_ext.clas.abap");
    expect(packedCard.model[0].path).to.equal("packs/other/src/zcl_sample_mpc.clas.abap");
  });

  it("shows an interface method without a named set once at service level", () => {
    const files = [{path: "src/zcl_sample_dpc_ext.clas.abap", source: "METHOD /iwbep/if_mgw_appl_srv_runtime~get_expanded_entity.\n  RETURN.\nENDMETHOD."}];
    const card = serviceCardModel({handler: "ZCL_SAMPLE_DPC_EXT"}, [{set: "TravelSet"}, {set: "BookingSet"}], files);
    expect(card.generic.map((one) => one.label)).to.deep.equal([
      "GET_EXPANDED_ENTITY interface operation generic (all sets) (src/zcl_sample_dpc_ext.clas.abap:1)"]);
    expect(card.entitySets.every((set) => !set.operations.some((op) => op.name === "GET_EXPANDED_ENTITY"))).to.equal(true);
    const html = serviceDetailsHtml({row: {kind: "ODATA"}, card});
    expect(html).to.contain("GET_EXPANDED_ENTITY interface operation generic (all sets) (src/zcl_sample_dpc_ext.clas.abap:1)");
  });

  it("classifies an inherited function import in rendered Details", () => {
    const files = [{path: "src/sample.stg.yaml", source: "service: SAMPLE_SRV\n  Cancel:\n    method: POST\n"}];
    const row = {kind: "ODATA", name: "SAMPLE_SRV", handler: "ZCL_SAMPLE_DPC_EXT"};
    const card = serviceCardModel(row, [], files);
    expect(serviceDetailsHtml({row, card})).to.contain("EXECUTE_ACTION function import inherited (generic)");
  });

  it("resolves every operation kind and a function import through the shared EXT/base resolver", () => {
    const operations = ["GET_ENTITYSET", "GET_ENTITY", "CREATE_ENTITY", "UPDATE_ENTITY", "DELETE_ENTITY",
      "GET_EXPANDED_ENTITY", "GET_EXPANDED_ENTITYSET", "CREATE_DEEP_ENTITY", "GET_STREAM", "UPDATE_STREAM"];
    const interfaceOperations = new Set(operations.slice(5));
    const methods = operations.map((operation) => interfaceOperations.has(operation)
      ? `/iwbep/if_mgw_appl_srv_runtime~${operation.toLowerCase()}` : `travelset_${operation.toLowerCase()}`);
    const ext = methods.flatMap((name) => [`METHOD ${name}.`, " IF iv_entity_set_name = 'TravelSet'. ENDIF.", "ENDMETHOD."]);
    ext.push("METHOD /iwbep/if_mgw_appl_srv_runtime~execute_action.", " IF iv_action_name = 'CancelTravel'. ENDIF.", "ENDMETHOD.");
    const files = [
      {path: "src/zcl_all_dpc_ext.clas.abap", source: ext.join("\n")},
      {path: "src/zcl_all_mpc.clas.abap", source: "METHOD define.\nENDMETHOD."},
      {path: "src/all.stg.yaml", source: "service: ALL_SRV\n  Travel:\n    set: TravelSet\n    media: true\n  CancelTravel:\n    method: POST\n"},
    ];
    const card = serviceCardModel({name: "ALL_SRV", handler: "ZCL_ALL_DPC_EXT"}, [{set: "TravelSet"}], files);
    const set = card.entitySets.find((one) => one.set === "TravelSet");
    expect(set.operations.map((one) => one.name)).to.deep.equal(operations);
    for (const [index, operation] of operations.entries()) {
      expect(set.operations[index].link, operation).to.include({path: files[0].path, line: index * 3 + 1});
    }
    expect(card.functionImports.find((one) => one.name === "CancelTravel").link).to.include({path: files[0].path, line: 31});
    const html = serviceDetailsHtml({row: {kind: "ODATA"}, card});
    expect(html).to.contain("GET_EXPANDED_ENTITY interface operation redefined (src/zcl_all_dpc_ext.clas.abap:16)");
    expect(html).to.contain("GET_STREAM interface operation redefined (src/zcl_all_dpc_ext.clas.abap:25)");
    expect(html).to.contain("EXECUTE_ACTION function import redefined (src/zcl_all_dpc_ext.clas.abap:31)");
  });

  it("builds a 1,000-set card within the source-index budget", () => {
    const sets = Array.from({length: 1000}, (_, i) => ({set: `Set${i}`, kind: "GET_ENTITYSET", method: `SET${i}_GET_ENTITYSET`}));
    const source = sets.map((set) => `METHOD ${set.method}.\nENDMETHOD.`).join("\n");
    const files = [{path: "src/zcl_large_dpc_ext.clas.abap", source}];
    const started = performance.now();
    const card = serviceCardModel({handler: "ZCL_LARGE_DPC_EXT"}, sets, files);
    expect(card.entitySets).to.have.lengthOf(1000);
    expect(card.entitySets[999].operations[0].link).to.include({line: 1999});
    expect(performance.now() - started).to.be.lessThan(200);
  });

  it("reads the launcher's workspace layers, including custom projected pack sources", () => {
    const {serviceCardFiles} = loadExtension(vscodeStub({home: ROOT}));
    const folder = mkdtempSync(path.join(tmpdir(), "osd-card-layer-"));
    try {
      const custom = path.join(folder, "abap");
      mkdirSync(custom);
      writeFileSync(path.join(folder, "osd-pack.json"), JSON.stringify({name: "fleet", abap: "abap"}));
      writeFileSync(path.join(custom, "zcl_layer_dpc_ext.clas.abap"), "METHOD travelset_get_entityset.\nENDMETHOD.");
      const files = serviceCardFiles(ROOT, [{folder, srcDir: custom, manifest: path.join(folder, "osd-pack.json")}]);
      const row = {handler: "ZCL_LAYER_DPC_EXT", pack: "fleet"};
      const card = serviceCardModel(row, [{set: "TravelSet"}], files);
      expect(card.entitySets[0].operations[0].link).to.include({path: path.join(custom, "zcl_layer_dpc_ext.clas.abap"), line: 1});
    } finally {
      rmSync(folder, {recursive: true, force: true});
    }
  });
});

describe("tools/adt-facade: service detail inventories", function () {
  let server;
  let base;

  before(async function () {
    const app = express();
    const store = new ObjectStore({root: ROOT, libs: []});
    app.use(adtRouter({store, data: {query: async () => ({rows: []})}, watch: false}).router);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}/sap/bc/adt/core/http`;
  });

  after(async function () {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });

  it("returns exact service class source paths and keeps generated helpers under OData/App rows", async () => {
    const response = await fetch(`${base}/services`);
    expect(response.status).to.equal(200);
    const {services} = await response.json();
    const demo = services.find((row) => row.kind === "ODATA" && row.name === "ZSTG_DEMO_SRV");
    expect(demo.handlerSource).to.match(/\.clas\.abap$/);
    expect(demo.mpcSource).to.match(/\.clas\.abap$/);
    expect(demo.helpers).to.be.an("array");
    expect(services.find((row) => row.kind === "APP").handlerSource).to.equal(undefined);
  });

  it("counts a service registered directly to its DPC_EXT in the readers lens", async () => {
    const response = await fetch(`${base}/xref/readers?type=CLAS&name=ZCL_ZSTG_DEMO_DPC_EXT`);
    expect(response.status).to.equal(200);
    const answer = await response.json();
    expect(answer.counts.services).to.equal(1);
    expect(readersLensTitle(answer.counts)).to.contain("services 1");
    expect(answer.readers.some((reader) => reader.name === "ZCL_ZSTG_DEMO_DPC_EXT")).to.equal(false);
  });

  it("counts each endpoint once for DPC, MPC, handler, and where-used readers", () => {
    const rows = [
      {kind: "ODATA", path: "/sap/opu/odata/sap/DEMO", handler: "ZCL_DPC", mpc: "ZCL_MPC"},
      {kind: "ODATA", path: "/sap/opu/odata/sap/DEMO", handler: "ZCL_DPC", mpc: "ZCL_MPC"},
      {kind: "ICF", path: "/sap/bc/demo", handler: "ZCL_HANDLER"},
      {kind: "ICF", path: "/sap/bc/demo", handler: "ZCL_HANDLER"},
    ];
    const readers = [{services: ["DEMO", "DEMO"]}, {services: ["DEMO"]}];
    expect(countServiceRegistrations(readers, rows, "ZCL_DPC")).to.equal(1);
    expect(countServiceRegistrations([], rows, "ZCL_MPC")).to.equal(1);
    expect(countServiceRegistrations([], rows, "ZCL_HANDLER")).to.equal(1);
    expect(countServiceRegistrations(readers, rows, "ZCL_OTHER")).to.equal(1);
  });

  it("returns source-relative transaction registry rows including hand-declared transactions", async () => {
    const response = await fetch(`${base}/transactions`);
    expect(response.status).to.equal(200);
    const {transactions} = await response.json();
    expect(transactions.find((row) => row.tcode === "ZOSD_NOTE").source).to.equal("src/webgui/zosd_note.tran.xml");
    expect(transactions.find((row) => row.tcode === "ZOSD_NOTE").parameter).to.contain("\\CLASS=ZCL_OSD_NOTE");
    expect(transactions.find((row) => row.tcode === "ZOSD_NOTE")).to.include({
      package: "$STG_WEBGUI", layer: "src", programSource: "src/webgui/zcl_osd_note.clas.abap",
    });
    expect(transactions.every((row) => row.source.endsWith(".tran.xml"))).to.equal(true);
  });
});

// "run tests on a different database" (docs/vscode-extension.md,
// "Databases"): Osd#run's own half of the wiring -- a fake fetch, no
// server, so this proves the body/headers/query-string split without a
// running osd. The other half (which env a caller builds, and what the
// façade route does with it) is tools/adt-facade.mjs `unitRunDbEnv`
// (test/adt-facade.mjs) and tools/osd-unit.mjs `unitChildEnv`
// (test/osd-unit.mjs).
describe("editors/vscode/lib.js: Osd#run's dbEnv (run tests on a different database)", () => {
  function fakeOsd() {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({url, options});
      if (options.method === "HEAD") {
        return {status: 200, headers: {get: (name) => (name === "x-csrf-token" ? "TOK" : undefined), getSetCookie: () => []}};
      }
      return {ok: true, status: 200, headers: {get: () => undefined}, json: async () => ({ok: true}), text: async () => ""};
    };
    return {client: new Osd("http://localhost:3611", fetchImpl), calls};
  }

  it("with no dbEnv sends no body at all -- the façade route's own default, unchanged", async () => {
    const {client, calls} = fakeOsd();
    await client.run({type: "CLAS", name: "ZCL_X"}, "LTCL_A", "M1");
    const post = calls.find((c) => c.options.method === "POST");
    expect(post.options.body).to.equal(undefined);
    expect(post.options.headers?.["content-type"]).to.equal(undefined);
    expect(post.url).to.contain("testClass=LTCL_A").and.to.contain("method=M1");
  });

  it("with a dbEnv sends it as a JSON body, never in the query string a server logs", async () => {
    const {client, calls} = fakeOsd();
    await client.run({type: "CLAS", name: "ZCL_X"}, undefined, undefined, {STG_DB: "hana", HANA_PASSWORD: "s3cret", HANA_SCHEMA: "OSD_TEST"});
    const post = calls.find((c) => c.options.method === "POST");
    expect(post.url).to.not.contain("s3cret");
    expect(post.url).to.not.contain("HANA_PASSWORD");
    expect(post.options.headers["content-type"]).to.equal("application/json");
    expect(JSON.parse(post.options.body)).to.deep.equal({dbEnv: {STG_DB: "hana", HANA_PASSWORD: "s3cret", HANA_SCHEMA: "OSD_TEST"}});
  });

  it("requests a paused child for a debugger run", async () => {
    const {client, calls} = fakeOsd();
    await client.run({type: "CLAS", name: "ZCL_X"}, "LTCL_A", "M1", undefined, 9444, true);
    const post = calls.find((c) => c.options.method === "POST");
    expect(JSON.parse(post.options.body)).to.deep.equal({inspectPort: 9444, waitForDebugger: true});
  });
});

// ---- T7 "Rebuild (warm)" (docs/vscode-extension.md "Warm"): the pure
// half of the status bar's, the tree's and Ctrl+F3's own text, off
// /osd/serving's `warm` field (tools/osd-store.mjs warmStatus()) and an
// activation's own build headers (activate()/activateMany(), tools/adt-
// facade.mjs warmHeaders()) -- both real server shapes, held here rather
// than re-derived from a running one.

describe("editors/vscode: T7 warm status and build text", function () {
  it("warmStatusText: nothing for off or no warm field at all", () => {
    expect(warmStatusText(undefined)).to.equal(undefined);
    expect(warmStatusText({state: "off"})).to.equal(undefined);
  });

  it("warmStatusText: warming up while priming, warm once primed", () => {
    expect(warmStatusText({state: "priming"})).to.equal("warming up…");
    expect(warmStatusText({state: "primed"})).to.equal("warm");
  });

  it("warmStatusText: cold with the reason exactly as the server gave it", () => {
    expect(warmStatusText({state: "cold", reason: "the transpiler has no `only` option (abaplint/transpiler#1900)"}))
      .to.equal("cold: the transpiler has no `only` option (abaplint/transpiler#1900)");
    expect(warmStatusText({state: "cold"})).to.equal("cold: not primed");
  });

  it("activationBuildText: a warm build that swapped, one already live, one recycled, and a cold one", () => {
    expect(activationBuildText({build: "warm", swapMs: 12})).to.equal("hot-swapped in 12 ms (warm)");
    expect(activationBuildText({build: "warm", swapMs: undefined})).to.equal("warm, already live");
    expect(activationBuildText({build: "cold; recycled after a warm build: the swap was refused: x"}))
      .to.equal("cold build: recycled after a warm build: the swap was refused: x");
    expect(activationBuildText({build: "cold"})).to.equal("cold build");
    expect(activationBuildText({build: "cold; the transpiler has no `only` option (abaplint/transpiler#1900)"}))
      .to.equal("cold build: the transpiler has no `only` option (abaplint/transpiler#1900)");
  });

  it("activationBuildText: a load that failed says nothing was loaded, never warm or cold", () => {
    expect(activationBuildText({build: "failed; the runtime is still changing hands after 60000 ms (the recycle); nothing was loaded"}))
      .to.equal("nothing loaded: the runtime is still changing hands after 60000 ms (the recycle); nothing was loaded");
  });

  it("activationBuildText: undefined when the answer carried no X-OSD-Build at all", () => {
    expect(activationBuildText({})).to.equal(undefined);
    expect(activationBuildText(undefined)).to.equal(undefined);
  });

  it("closureTestsText: the count, or nothing for none or no closure at all", () => {
    expect(closureTestsText({closureTests: ["ZCL_X_TESTCLASSES"]})).to.equal("1 test in the closure");
    expect(closureTestsText({closureTests: ["ZCL_X", "ZCL_Y", "ZCL_Z"]})).to.equal("3 tests in the closure");
    expect(closureTestsText({closureTests: []})).to.equal(undefined);
    expect(closureTestsText({})).to.equal(undefined);
    expect(closureTestsText(undefined)).to.equal(undefined);
  });
});

// Exercise the real status item and command callbacks with a small VS Code API.
function runningStatusApi() {
  const commands = new Map(), items = [], executed = [];
  let pick;
  const api = {
    StatusBarAlignment: {Left: 1},
    TreeItem: class {},
    commands: {
      registerCommand(id, fn) { commands.set(id, fn); return {dispose() {}}; },
      async executeCommand(id) { executed.push(id); return commands.get(id)?.(); },
    },
    window: {
      createStatusBarItem() {
        const item = {show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {}};
        items.push(item); return item;
      },
      createOutputChannel() { return {show() {}, appendLine() {}, dispose() {}}; },
      async showQuickPick(entries) { api.entries = entries; return pick?.(entries); },
    },
  };
  return {api, items, commands, executed, choose(fn) { pick = fn; }};
}

describe("editors/vscode: running parts status and actions", () => {
  it("shows each system state without a click and keeps one action menu", () => {
    const h = runningStatusApi();
    const {startStopStatusBar} = loadExtension(h.api);
    let refresh;
    const controller = {onDidChange(fn) { refresh = fn; return {dispose() {}}; }};
    const context = {subscriptions: []};
    const item = startStopStatusBar(context, controller);
    expect(item.text).to.equal("$(play) OSD stopped");
    expect(item.command).to.equal("osd.showRunning");
    for (const state of ["running", "building", "starting", "stopping", "stopped"]) {
      controller.launcher = {state, port: 8060, databaseLabel: "SQLite"};
      refresh();
      expect(item.text).to.include(`OSD ${state}`);
      expect(item.tooltip).to.include(`OSD system: ${state}`);
      expect(item.command).to.equal("osd.showRunning");
    }
    context.subscriptions.forEach(s => s.dispose());
  });

  it("maps system/worker state combinations to the right click actions", async () => {
    const h = runningStatusApi();
    const {startStopStatusBar, runningParts} = loadExtension(h.api);
    const controller = {onDidChange() { return {dispose() {}}; }};
    const context = {subscriptions: []};
    startStopStatusBar(context, controller);
    let starts = 0;
    for (const state of ["stopped", "starting", "running", "stopping"]) {
      for (const running of [false, true]) {
        controller.launcher = {state, jobsWorkerMode: "auto", env: {STG_DB: "file", STG_DB_PATH: "jobs.sqlite"},
          jobWorker: {running, start() { starts++; }}};
        const parts = runningParts(controller);
        expect(parts[0].command).to.equal(state === "stopped" ? "osd.start" : "osd.openSystemOverview");
        expect(parts[1].description).to.equal(running ? "running" : "stopped");
        expect(parts[1].command).to.equal(running ? "osd.showJobs" : state === "running" ? "osd.startJobWorker" : state === "stopped" ? "osd.start" : "osd.openSystemOverview");
        for (const label of ["OSD system", "Job worker", "System overview"]) {
          h.choose(entries => entries.find(e => e.label === label));
          await h.commands.get("osd.showRunning")();
          expect(h.executed.at(-1)).to.equal(parts.find(e => e.label === label).command);
        }
      }
    }
    expect(starts).to.equal(1);
    expect(runningParts(controller).find(i => i.label === "Show raw job log")?.command).to.equal("osd.showRawJobLog");
    expect(JSON.parse(readFileSync(new URL("../editors/vscode/package.json", import.meta.url), "utf8")).contributes.commands
      .find(i => i.command === "osd.showRawJobLog")?.title).to.equal("OSD: Show raw job log");
    controller.launcher.jobWorker.otherWindow = true;
    expect(runningParts(controller)[1]).to.include({description: "running in another window", command: "osd.showJobs"});
    controller.launcher.jobsWorkerMode = "off";
    expect(runningParts(controller).map(e => e.label)).not.to.include("Job worker");
    controller.launcher.jobsWorkerMode = "auto";
    controller.launcher.env.STG_DB = "duckdb";
    expect(runningParts(controller).map(e => e.label)).not.to.include("Job worker");
    const before = h.executed.length;
    h.choose(() => undefined);
    await h.commands.get("osd.showRunning")();
    expect(h.executed).to.have.length(before);
    context.subscriptions.forEach(s => s.dispose());
  });

  it("hides unused jobs and keeps idle, stopped, active and other-window states visible", async () => {
    const h = runningStatusApi();
    const {jobsStatusBar} = require("../editors/vscode/job-worker.js");
    const controller = {onDidChange() { return {dispose() {}}; }};
    const context = {subscriptions: []};
    const tick = jobsStatusBar(h.api, context, controller);
    const item = h.items[0];
    const originalFetch = globalThis.fetch;
    try {
      expect(item.visible).to.equal(false);
      controller.launcher = {port: 8060, jobsWorkerMode: "auto", env: {STG_DB: "file", STG_DB_PATH: "jobs.sqlite"}, jobWorker: {running: false}};
      await tick();
      expect(item.visible).to.equal(true);
      expect(item.text).to.equal("OSD jobs: worker stopped");
      expect(item.command).to.equal("osd.openJobsPanel");
      controller.launcher.jobWorker.running = true;
      for (const counts of [{running: 0, queued: 0}, {running: 2, queued: 1}]) {
        globalThis.fetch = async () => ({ok: true, json: async () => ({counts})});
        await tick();
        expect(item.text).to.equal(counts.running ? "OSD jobs: running 2, queued 1" : "OSD jobs: idle");
      }
      globalThis.fetch = async () => { throw Error("offline"); };
      await tick();
      expect(item.text).to.equal("OSD jobs: running 2, queued 1");
      expect(item.backgroundColor).to.equal(undefined);
      controller.launcher.jobWorker.otherWindow = true;
      controller.launcher.jobWorker.running = false;
      let queried = false;
      globalThis.fetch = async url => { queried = url.endsWith("/osd/job-counts"); return {ok: true, json: async () => ({counts: {running: 2, queued: 1}})}; };
      await tick();
      expect(queried).to.equal(true);
      expect(item.text).to.equal("OSD jobs: other window · 2 running, 1 queued");
      for (const [mode, db] of [["off", "file"], ["auto", "sqlite"], ["auto", "duckdb"]]) {
        controller.launcher.jobsWorkerMode = mode;
        controller.launcher.env.STG_DB = db;
        await tick();
        expect(item.visible).to.equal(false);
      }
    } finally {
      globalThis.fetch = originalFetch;
      context.subscriptions.forEach(s => s.dispose());
    }
  });
});

describe("editors/vscode: serving generation status", () => {
  // Critic round 2: drive the exported status function with a deterministic
  // clock and deferred responses, restoring globals even on assertion failure.
  const nativeFetch = globalThis.fetch;
  async function handoffProbe(run, {realController = false, findingCount = () => 2} = {}) {
    const h = runningStatusApi();
    const base = vscodeStub();
    Object.assign(h.api, {EventEmitter: base.EventEmitter, debug: base.debug,
      ConfigurationTarget: base.ConfigurationTarget});
    let url = "http://external:3030", now = 0, tick, refresh;
    let respond = async () => { throw Error("unreachable"); };
    const errors = [];
    h.api.workspace = {...base.workspace, getConfiguration: () => ({
      get: (key, fallback) => key === "url" ? url : fallback,
      update: async () => { throw Error("settings are read-only"); },
    })};
    h.api.window.showErrorMessage = message => errors.push(message);
    h.api.window.setStatusBarMessage = () => {};
    const {statusBar, SystemController} = loadExtension(h.api);
    const context = controllerContext();
    const saved = {fetch: globalThis.fetch, interval: globalThis.setInterval,
      clear: globalThis.clearInterval, now: Date.now};
    const controller = realController
      ? new SystemController(context, {append() {}, appendLine() {}, show() {}})
      : {launcher: {...ownedLauncher, state: "stopped"}, onDidChange(fn) { refresh = fn; return {dispose() {}}; }};
    if (realController) {
      const launcher = new NodeEventEmitter();
      Object.assign(launcher, {...ownedLauncher, state: "stopped", port: 8060, async start() {
        for (const state of ["starting", "running"]) { this.state = state; this.emit("state", state); }
        return {port: this.port, generation: "local123"};
      }});
      controller.attachLauncher(launcher);
      controller.ensureLauncher = async () => launcher;
    }
    try {
      globalThis.fetch = (...args) => respond(...args);
      globalThis.setInterval = fn => { tick = fn; return 1; };
      globalThis.clearInterval = () => {};
      Date.now = () => now;
      const item = statusBar(context, findingCount, controller);
      await new Promise(resolve => setImmediate(resolve));
      await run({item, controller, errors, tick: () => tick(),
        time: value => { now = value; }, url: value => { url = value; },
        respond: fn => { respond = fn; },
        state: value => { controller.launcher.state = value; refresh(); },
        refresh: () => refresh(),
        start: () => { controller.launcher.state = "starting"; refresh(); controller.launcher.state = "running"; refresh(); }});
    } finally {
      context.subscriptions.forEach(s => s.dispose());
      globalThis.fetch = saved.fetch; globalThis.setInterval = saved.interval;
      globalThis.clearInterval = saved.clear; Date.now = saved.now;
    }
  }

  for (const times of [[0, 5000, 14999, 15000], [0, 60000, 60001]]) {
    it(`bounds a never-serving handoff with both three misses and fifteen seconds (${times.join(",")})`, async () => {
      await handoffProbe(async p => {
        p.start();
        for (const time of times.slice(0, -1)) {
          p.time(time); await p.tick();
          expect(p.item.text).to.include("awaiting serving");
        }
        p.time(times.at(-1)); await p.tick();
        expect(p.item.text).to.include("osd down");
        expect(p.item.tooltip).to.include("OSD kernel: 2 finding(s)");
        p.start(); await p.tick();
        expect(p.item.text, "restart resets the grace").to.include("awaiting serving");
      });
    });
  }

  it("keeps two kernel findings in immediate and polled awaiting tooltips", async () => {
    await handoffProbe(async p => {
      p.start();
      expect(p.item.tooltip).to.include("OSD kernel: 2 finding(s)");
      await p.tick();
      expect(p.item.tooltip).to.include("OSD kernel: 2 finding(s)");
      p.state("stopped"); p.start();
      expect(p.item.tooltip).to.include("OSD kernel: 2 finding(s)");
    });
  });

  it("treats a throwing findings provider as unknown through state notifications and polls", async () => {
    await handoffProbe(async p => {
      expect(() => p.start()).not.to.throw();
      expect(p.item.text).to.include("awaiting serving");
      expect(p.item.tooltip).to.include("OSD kernel: unknown finding(s)");
      await p.tick();
      expect(p.item.text).to.include("awaiting serving");
      expect(p.item.tooltip).to.include("OSD kernel: unknown finding(s)");
      p.respond(async url => ({ok: true, json: async () => url.endsWith("/osd/dumps")
        ? [] : {launcherPid: 12345, launcherIdentity: "test-owned", generation: "fresh123"}}));
      await p.tick();
      expect(p.item.text).to.include("fresh123");
      expect(p.item.tooltip).to.include("OSD kernel: unknown finding(s)");
      for (const state of ["stopped", "failed"]) {
        p.start();
        expect(() => p.state(state)).not.to.throw();
        expect(p.item.text).to.include("osd down");
        expect(p.item.tooltip).to.include("OSD kernel: unknown finding(s)");
      }
    }, {findingCount: () => { throw Error("count failed"); }});
  });

  it("shows down for a foreign launch identity with a copied PID and never polls after Stop", async () => {
    await handoffProbe(async p => {
      p.start();
      let requests = 0;
      const foreign = express();
      foreign.get("/osd/serving", (_req, res) => { requests++; res.json({
        launcherPid: 12345, launcherIdentity: "foreign", ready: true, generation: "foreign-system",
      }); });
      const server = await new Promise(resolve => {
        const listening = foreign.listen(0, "127.0.0.1", () => resolve(listening));
      });
      p.respond(() => nativeFetch(`http://127.0.0.1:${server.address().port}/osd/serving`));
      try {
        await p.tick();
        expect(p.item.text).to.include("osd down").and.not.include("foreign-system");
        expect(requests).to.equal(1); // No dump read from the foreign system.
        p.state("stopped");
        await p.tick();
        expect(requests).to.equal(1);
        expect(p.item.text).to.include("osd down");
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
  });

  it("leaves awaiting immediately when the launcher stops or fails", async () => {
    await handoffProbe(async p => {
      for (const state of ["stopped", "failed"]) {
        p.start(); p.state(state);
        expect(p.item.text, state).to.include("osd down");
        expect(p.item.tooltip).to.include("OSD kernel: 2 finding(s)");
      }
    });
  });

  for (const notify of [true, false]) {
    it(`ignores an old URL serving response after a URL switch (state notification: ${notify})`, async () => {
      await handoffProbe(async p => {
        p.start();
        let resolveOld;
        const requests = [];
        p.respond(url => {
          requests.push(url);
          return url.endsWith("/osd/serving")
            ? new Promise(resolve => { resolveOld = resolve; })
            : Promise.resolve({ok: true, json: async () => []});
        });
        const pending = p.tick();
        p.url("http://localhost:8060");
        if (notify) p.refresh();
        resolveOld({ok: true, json: async () => ({generation: "old-system"})});
        await pending;
        expect(p.item.text).to.include("awaiting serving");
        expect(requests).to.deep.equal(["http://external:3030/osd/serving"]);
        p.respond(async url => {
          requests.push(url);
          return {ok: true, json: async () => url.endsWith("/osd/dumps") ? [] : {launcherPid: 12345, launcherIdentity: "test-owned", generation: "fresh123"}};
        });
        await p.tick();
        expect(p.item.text).to.include("fresh123");
        expect(p.item.tooltip).to.include("http://localhost:8060");
        expect(requests.slice(1)).to.deep.equal(["http://localhost:8060/osd/serving", "http://localhost:8060/osd/dumps"]);
      });
    });
  }

  it("bounds awaiting when a successful launch cannot update osd.url", async () => {
    await handoffProbe(async p => {
      expect(await p.controller.start()).to.equal(true);
      expect(p.errors.some(message => message.includes("could not update osd.url"))).to.equal(true);
      expect(p.item.text).to.include("awaiting serving");
      for (const time of [0, 5000, 15000]) { p.time(time); await p.tick(); }
      expect(p.item.text).to.include("osd down");
      expect(p.item.tooltip).to.include("http://external:3030");
    }, {realController: true});
  });

  it("hides immediately throughout long startup, guards a late poll, and restores stopped/crashed status", async () => {
    const h = runningStatusApi();
    h.api.workspace = {getConfiguration() { return {get: (_, fallback) => fallback}; }};
    const {statusBar} = loadExtension(h.api);
    let refresh, rejectPoll;
    const controller = {launcher: {...ownedLauncher, state: "running", startedAt: Date.now() - 60000},
      onDidChange(fn) { refresh = fn; return {dispose() { refresh = undefined; }}; }};
    const originalFetch = globalThis.fetch;
    const context = {subscriptions: []};
    try {
      globalThis.fetch = () => new Promise((_, reject) => { rejectPoll = reject; });
      const item = statusBar(context, () => 0, controller);
      for (const state of ["building", "starting"]) {
        controller.launcher.state = state;
        refresh();
        expect(item.visible, state).to.equal(false);
      }
      rejectPoll(new Error("not serving yet"));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(item.visible, "late failed poll during startup").to.equal(false);
      controller.launcher.state = "running";
      refresh();
      expect(item.visible).to.equal(true);
      expect(item.text).to.include("awaiting serving");
      expect(item.backgroundColor).to.equal(undefined);
      for (const state of ["stopped"]) {
        controller.launcher.state = state;
        refresh();
        expect(item.visible, state).to.equal(true);
        expect(item.text).to.include("osd down");
      }
      controller.launcher.state = "stopping";
      refresh();
      expect(item.visible).to.equal(false);
    } finally {
      context.subscriptions.forEach(s => s.dispose());
      globalThis.fetch = originalFetch;
    }
    expect(refresh).to.equal(undefined);
  });

  it("stays neutral through failed handoff polls, accepts the first fresh serving poll, and shows a later crash", async () => {
    const h = runningStatusApi();
    h.api.workspace = {getConfiguration() { return {get: (_, fallback) => fallback}; }};
    const {statusBar} = loadExtension(h.api);
    const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const context = {subscriptions: []};
    let tick, refresh, resolveOld, respond;
    const controller = {launcher: {...ownedLauncher, state: "stopped"},
      onDidChange(fn) { refresh = fn; return {dispose() {}}; }};
    try {
      globalThis.setInterval = fn => { tick = fn; return 1; };
      globalThis.clearInterval = () => {};
      controller.launcher.state = "running";
      respond = () => new Promise(resolve => { resolveOld = resolve; });
      globalThis.fetch = (...args) => respond(...args);
      const item = statusBar(context, () => 0, controller);
      controller.launcher.state = "starting"; refresh();
      controller.launcher.state = "running"; refresh();
      expect(item.text).to.include("awaiting serving");
      resolveOld({ok: true, json: async () => ({generation: "stale"})});
      await new Promise(resolve => setImmediate(resolve));
      expect(item.text).to.include("awaiting serving");
      respond = async () => { throw Error("not ready"); };
      await tick(); await tick();
      expect(item.visible).to.equal(true);
      expect(item.text).to.include("awaiting serving");
      expect(item.backgroundColor).to.equal(undefined);
      respond = async url => ({ok: true, json: async () => url.endsWith("/osd/dumps") ? [] : {launcherPid: 12345, launcherIdentity: "test-owned", generation: "fresh123"}});
      await tick();
      expect(item.text).to.include("OSD generation fresh123");
      respond = async () => { throw Error("crashed"); };
      await tick();
      expect(item.text).to.include("osd down");
      controller.launcher.state = "starting"; refresh();
      controller.launcher.state = "running"; refresh();
      expect(item.text).to.include("awaiting serving");
      controller.launcher.state = "stopped"; refresh();
      expect(item.text).to.include("osd down");
    } finally {
      context.subscriptions.forEach(s => s.dispose());
      globalThis.fetch = originalFetch;
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("preserves generation, database, dump action and kernel findings tooltip", async () => {
    const h = runningStatusApi();
    h.api.workspace = {getConfiguration() { return {get: (_, fallback) => fallback}; }};
    const {statusBar} = loadExtension(h.api);
    const originalFetch = globalThis.fetch;
    const context = {subscriptions: []};
    try {
      globalThis.fetch = async url => ({ok: true, json: async () => url.endsWith("/osd/dumps") ? [{id: 1}]
        : {generation: "abcdefgh123", databaseIdentity: {engine: "sqlite"}, pid: 123}});
      const item = statusBar(context, () => 2);
      // statusBar starts its first asynchronous poll immediately.
      for (let i = 0; i < 20 && !item.tooltip?.includes("OSD kernel:"); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(item.text).to.include("OSD generation abcdefgh · SQLite");
      expect(item.text).to.include("$(bug) 1");
      expect(item.tooltip).to.include("OSD kernel: 2 finding(s)");
      expect(item.command).to.equal("osd.showDumps");
      item.dispose();
    } finally {
      context.subscriptions.forEach(s => s.dispose());
      globalThis.fetch = originalFetch;
    }
  });
});

describe("editors/vscode: Open sample", () => {
  const context = {extensionUri: {fsPath: path.join(ROOT, "editors/vscode")}};
  function sampleApi(classes = []) {
    const h = runningStatusApi();
    h.api.Uri = {file: fsPath => ({fsPath})};
    h.api.workspace = {
      getConfiguration() { return {get: (_, fallback) => fallback}; },
      async findFiles(pattern, exclude) {
        expect(pattern).to.equal("**/zosd_demo_hello.clas.abap");
        expect(exclude).to.include("node_modules");
        return classes.map(c => c.uri);
      },
      async openTextDocument(uri) { return {getText: () => classes.find(c => c.uri === uri).source}; },
      async openNotebookDocument(uri) { h.openedNotebook = uri; return {uri}; },
    };
    h.api.window.showNotebookDocument = async doc => { h.shownNotebook = doc.uri; };
    h.api.window.showTextDocument = async uri => { h.shownClass = uri; };
    h.api.window.showInformationMessage = async (_, action) => { h.offer = action; return h.startChoice; };
    h.api.window.showErrorMessage = message => { h.error = message; };
    return h;
  }
  it("lists every bundled notebook and only a present classrun hello sample", async () => {
    const h = sampleApi();
    const {sampleItems, runningParts} = loadExtension(h.api);
    const notebooks = await sampleItems(context);
    expect(notebooks.map(e => e.label)).to.deep.equal(["abap-amdp.osdnb", "demo.osdnb"]);
    for (const item of notebooks) {
      expect(item.notebook).to.equal(true);
      expect(item.uri.fsPath).to.equal(path.join(context.extensionUri.fsPath, "examples", item.label));
      expect(JSON.parse(readFileSync(item.uri.fsPath, "utf8")).cells.length).to.be.greaterThan(0);
    }
    expect(runningParts({}).find(e => e.label === "Open sample").command).to.equal("osd.openSample");
    const uri = {fsPath: "/workspace/src/zosd_demo_hello.clas.abap"};
    const classes = [{uri, source: "CLASS zosd_demo_hello DEFINITION.\n  PUBLIC SECTION.\n    INTERFACES if_oo_adt_classrun.\nENDCLASS."}];
    const demo = sampleApi(classes);
    const items = await loadExtension(demo.api).sampleItems(context);
    expect(items).to.have.length(3);
    expect(items[2]).to.include({label: "ZOSD_DEMO_HELLO", uri, detail: "Open and press F9 to run"});
    classes[0].source = "CLASS zosd_demo_hello DEFINITION. ENDCLASS.";
    expect(await loadExtension(demo.api).sampleItems(context)).to.have.length(2);
    const manifest = JSON.parse(readFileSync(path.join(context.extensionUri.fsPath, "package.json"), "utf8"));
    expect(manifest.contributes.commands.find(c => c.command === "osd.openSample").title).to.equal("OSD: Open sample");
    expect(readFileSync(path.join(context.extensionUri.fsPath, "walkthrough/try-it.md"), "utf8")).to.include("command:osd.openSample");
  });

  it("opens the chosen notebook or class without running it", async () => {
    const uri = {fsPath: "/workspace/src/zosd_demo_hello.clas.abap"};
    const h = sampleApi([{uri, source: "INTERFACES if_oo_adt_classrun."}]);
    const {openSample} = loadExtension(h.api);
    h.choose(entries => entries.find(e => e.label === "demo.osdnb"));
    await openSample(context, {launcher: {state: "running"}});
    expect(h.openedNotebook).to.equal(h.shownNotebook);
    expect(h.shownNotebook.fsPath).to.match(/examples\/demo.osdnb$/);
    h.choose(entries => entries.find(e => e.label === "ZOSD_DEMO_HELLO"));
    await openSample(context, {launcher: {state: "running"}});
    expect(h.shownClass).to.equal(uri);
    expect(h.executed).to.deep.equal([]);
    expect(h.offer).to.equal(undefined);
    expect(h.error).to.equal(undefined);
  });

  it("offers Start only for an unavailable system, allows dismissal and cancellation", async () => {
    const h = sampleApi();
    const {openSample} = loadExtension(h.api);
    const originalFetch = globalThis.fetch;
    try {
      h.choose(entries => entries[0]);
      let available = false;
      globalThis.fetch = async (url, options) => {
        expect(url).to.match(/\/osd\/serving$/);
        expect(options.signal).to.be.instanceOf(AbortSignal);
        if (!available) throw Error("offline");
        return {ok: true, json: async () => ({generation: "external"})};
      };
      await openSample(context, {});
      expect(h.offer).to.equal("Start system");
      expect(h.executed).to.deep.equal([]);
      h.startChoice = "Start system";
      await openSample(context, {});
      expect(h.executed).to.deep.equal(["osd.start"]);
      h.offer = undefined;
      available = true;
      await openSample(context, {});
      expect(h.offer).to.equal(undefined);
      available = false;
      await openSample(context, {launcher: {state: "starting"}});
      expect(h.offer).to.equal(undefined);
      h.choose(() => undefined);
      h.openedNotebook = undefined;
      await openSample(context, {});
      expect(h.openedNotebook).to.equal(undefined);
      expect(h.executed).to.deep.equal(["osd.start"]);
      expect(h.error).to.equal(undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
});
