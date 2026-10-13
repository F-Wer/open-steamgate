import {runtimeRootFixture} from "./helpers/runtime-root.mjs";
import {expect} from "chai";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {basename, dirname, join, matchesGlob, relative, resolve} from "node:path";
import {pathToFileURL, fileURLToPath} from "node:url";
import {ObjectStore} from "../tools/osd-store.mjs";
import {UnitRun} from "../tools/osd-unit.mjs";
import {hashOf} from "../tools/osd-build.mjs";
import {modulesOf, transpile} from "../tools/osd-transpile.mjs";
import {createRequire} from "node:module";

const runtimeFixture = runtimeRootFixture();
const {pickInspectorPort, packNameOf} = createRequire(import.meta.url)("../editors/vscode/launcher.js");
const {Launcher} = createRequire(import.meta.url)("../editors/vscode/launcher.js");
const {debuggerConfiguration, runningAbapSources, breakpointWarning, Osd} = createRequire(import.meta.url)("../editors/vscode/lib.js");
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(text) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of text) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) throw new Error(`invalid source-map VLQ character: ${char}`);
    value |= (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    values.push((value & 1) === 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

function generatedPosition(mappings, sourceIndex, sourceLine, sourceColumn) {
  let previousSource = 0;
  let previousLine = 0;
  let previousColumn = 0;
  for (const [lineIndex, line] of mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const segment of line.split(",")) {
      if (segment === "") continue;
      const [generatedDelta, sourceDelta, lineDelta, columnDelta] = decodeVlq(segment);
      generatedColumn += generatedDelta;
      if (sourceDelta === undefined) continue;
      previousSource += sourceDelta;
      previousLine += lineDelta;
      previousColumn += columnDelta;
      if (previousSource === sourceIndex && previousLine === sourceLine - 1 && previousColumn >= sourceColumn) {
        return {line: lineIndex + 1, column: generatedColumn};
      }
    }
  }
  return undefined;
}

class InspectorClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.method === message.method && waiter.predicate(message.params));
      if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0].resolve(message.params);
      else this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
    this.socket.send(JSON.stringify({id, method, params}));
    return result;
  }

  waitFor(method, predicate = () => true, timeoutMs = 15000) {
    const index = this.events.findIndex((event) => event.method === method && predicate(event.params));
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0].params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== finish);
        reject(new Error(`timed out waiting for inspector event ${method}`));
      }, timeoutMs);
      const finish = (params) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.waiters.push({method, predicate, resolve: finish});
    });
  }
}

async function inspectorTarget(port) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const [target] = await response.json();
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch {
      // The detached child has not opened its inspector yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`unit child inspector did not open on port ${port}`);
}

function breakpointFor(sourcePath, sourceLine, sourceColumn) {
  const output = join(runtimeFixture.root, "output");
  for (const name of readdirSync(output).filter((entry) => entry.endsWith(".mjs.map"))) {
    const mapFile = realpathSync(join(output, name));
    const data = JSON.parse(readFileSync(mapFile, "utf8"));
    const source = data.sources.find((entry) => {
      const absolute = resolve(dirname(mapFile), entry);
      return absolute === sourcePath || (sourcePath.endsWith("/src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap") &&
        entry.replaceAll("\\", "/").endsWith("/src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap"));
    });
    if (source === undefined) continue;
    const position = generatedPosition(data.mappings, data.sources.indexOf(source), sourceLine, sourceColumn);
    if (position === undefined) continue;
    const moduleFile = mapFile.slice(0, -4);
    return {url: pathToFileURL(realpathSync(moduleFile)).href, lineNumber: position.line - 1,
      columnNumber: position.column, source, position};
  }
  throw new Error(`no source-map position for ${sourcePath}:${sourceLine}`);
}

describe("VS Code debugger transport: detached ABAP Unit child", function () {
  this.timeout(180000);

  it("keeps projected DPC maps portable and resolves them through attach overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-dpc-map-"));
    try {
      const home = join(dir, "home");
      const storage = join(dir, "storage");
      const workspace = join(dir, "workspace");
      const workspaceSource = join(workspace, "src");
      const packSource = join(storage, "packs", packNameOf(workspace), "src");
      const generation = join(home, "build", "by-input", "abc123", "output");
      const otherWorkspace = join(dir, "other-workspace", "src");
      mkdirSync(workspaceSource, {recursive: true});
      mkdirSync(otherWorkspace, {recursive: true});
      mkdirSync(dirname(packSource), {recursive: true});
      symlinkSync(workspaceSource, packSource, "dir");
      writeFileSync(join(dirname(packSource), "osd-pack.json"), JSON.stringify({name: "projected", abap: "src"}));
      const source = join(workspaceSource, "zcl_ship_dpc_ext.clas.abap");
      const abap = `CLASS zcl_ship_dpc_ext DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS shipset_get_entityset.
ENDCLASS.
CLASS zcl_ship_dpc_ext IMPLEMENTATION.
  METHOD shipset_get_entityset.
    DATA lv_count TYPE i.
    lv_count = 1.
  ENDMETHOD.
ENDCLASS.`;
      writeFileSync(source, abap);
      writeFileSync(join(otherWorkspace, "zcl_ship_dpc_ext.clas.abap"), abap);
      const config = {input_folder: relative(home, packSource),
        output_folder: relative(home, generation), input_filter: [".*\\.abap$"], exclude_filter: [],
        libs: [], options: {}, write_source_map: true, write_unit_tests: false};
      await transpile({root: home, config, modules: modulesOf(runtimeFixture.root)});
      const map = JSON.parse(readFileSync(join(generation, "zcl_ship_dpc_ext.clas.mjs.map"), "utf8"));
      const mapped = map.sources.find((entry) => entry.endsWith("zcl_ship_dpc_ext.clas.abap"));
      expect(mapped).to.equal(`${relative(generation, packSource).replaceAll("\\", "/")}/zcl_ship_dpc_ext.clas.abap`);
      expect(JSON.stringify(map)).not.to.include(workspace);
      expect(JSON.stringify(map)).not.to.include(storage);
      symlinkSync(generation, join(home, "output"), "dir");
      const attach = debuggerConfiguration(9341, {root: home, storageDir: storage,
        layers: [{folder: workspace, srcDir: workspaceSource}]});
      expect(attach.outFiles).to.deep.equal([`${generation}/**/*.mjs`]);
      expect(attach.resolveSourceMapLocations).to.deep.equal(
        [...new Set([`${join(home, "build")}/**`, `${realpathSync(join(home, "build"))}/**`]), "!**/node_modules/**"]);
      expect(attach.pauseForSourceMap).to.equal(true);
      expect(attach.sourceMapPathOverrides[`${dirname(mapped)}/*`]).to.equal(`${workspaceSource}/*`);
      expect(attach.sourceMapPathOverrides[`file://${packSource}/*`]).to.equal(`${workspaceSource}/*`);
      const running = runningAbapSources(home, {storageDir: storage,
        layers: [{folder: workspace, srcDir: workspaceSource}]});
      expect(breakpointWarning(source, running), "the compiled DPC file is the editor's breakpoint source")
        .to.equal(undefined);
      // The same bytes under a retargeted projection may reuse the same
      // generation: its map names the stable projection, while the attach
      // config points to the workspace now open in the editor.
      const previousPacks = process.env.OSD_PACKS;
      process.env.OSD_PACKS = join(storage, "packs");
      let before;
      let after;
      try {
        before = hashOf(runtimeFixture.root);
        rmSync(packSource);
        symlinkSync(otherWorkspace, packSource, "dir");
        after = hashOf(runtimeFixture.root);
      } finally {
        if (previousPacks === undefined) delete process.env.OSD_PACKS;
        else process.env.OSD_PACKS = previousPacks;
      }
      expect(after).to.equal(before);
      await transpile({root: home, config, modules: modulesOf(runtimeFixture.root)});
      const retargeted = JSON.parse(readFileSync(join(generation, "zcl_ship_dpc_ext.clas.mjs.map"), "utf8"));
      expect(retargeted).to.deep.equal(map);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("renders ABAP values through the launch generators in a paused inspector session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-abap-values-"));
    let child;
    let exited;
    let client;
    try {
      const runner = join(dir, "values.cjs");
      const runtime = createRequire(import.meta.url).resolve("@abaplint/runtime");
      writeFileSync(runner, `const {ABAP} = require(${JSON.stringify(runtime)});
const t = new ABAP().types;
const structure = new t.Structure({name: new t.Character(20).set('ABC'), amount: new t.Packed({length: 8, decimals: 2}).set('12.50')});
const table = new t.Table(structure);
table.append(structure);
const reference = new t.DataReference(structure).assign(structure);
const casting = new t.FieldSymbol(new t.Hex({length: 8}));
casting.assign(new t.Float().set(1.5));
casting.setCasting();
const scalars = [new t.String().set('ABC  '), new t.Integer().set(-42), new t.Integer8().set('9223372036854775807'), new t.Float().set(1.5), new t.Date().set('20261003'), new t.Time().set('123456'), new t.XString().set('ABCDEF'), new t.Hex({length: 4}).set('ABCD'), new t.Packed({length: 16, decimals: 2}).set('12345678901234567890.12')];
class AbapClass {
  static INTERNAL_TYPE = 'CLAS';
  static INTERNAL_NAME = 'ZCL_DEBUG_PROBE';
}
const object = new AbapClass();
const wrappedObject = new t.ABAPObject();
wrappedObject.set(object);
const sorted = new t.Table(new t.Integer(), {primaryKey: {type: 'SORTED'}});
const hashed = new t.HashedTable(new t.Integer());
const symbol = new t.FieldSymbol(new t.Integer());
symbol.assign(new t.Integer().set(7));
const extraCases = [object, wrappedObject, new t.ABAPObject(), sorted, hashed, symbol,
  new t.FieldSymbol(new t.Integer()), new t.DataReference(new t.Integer()),
  new t.Character(20).set(" A'B\\r\\n\\t"), new t.Packed({length: 8, decimals: 2}).set('-0.05'),
  new t.Packed({length: 8, decimals: 2}), new t.Hex({length: 4}).set('abcdef'),
  new t.String().set('x'.repeat(257)), new t.Hex({length: 130}).set('ab'.repeat(130))];
debugger;
`);
      const port = await pickInspectorPort();
      const config = debuggerConfiguration(port, {root: runtimeFixture.root});
      child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${port}`, runner], {cwd: dir, stdio: "ignore"});
      exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      const target = await inspectorTarget(port);
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, {once: true});
        socket.addEventListener("error", reject, {once: true});
      });
      client = new InspectorClient(socket);
      await client.send("Debugger.enable");
      await client.send("Runtime.runIfWaitingForDebugger");
      await client.waitFor("Debugger.paused");
      await client.send("Debugger.resume");
      const paused = await client.waitFor("Debugger.paused");
      const evaluate = async (expression) => {
        const answer = await client.send("Debugger.evaluateOnCallFrame", {callFrameId: paused.callFrames[0].callFrameId, expression});
        expect(answer.exceptionDetails, JSON.stringify(answer.exceptionDetails)).to.equal(undefined);
        return answer.result.objectId;
      };
      const render = async (objectId) => {
        const answer = await client.send("Runtime.callFunctionOn", {objectId,
          functionDeclaration: config.customDescriptionGenerator, arguments: [{value: "default JS"}],
          returnByValue: true, throwOnSideEffect: true});
        expect(answer.exceptionDetails, JSON.stringify(answer.exceptionDetails)).to.equal(undefined);
        return answer.result.value;
      };
      const children = async (objectId) => {
        const answer = await client.send("Runtime.callFunctionOn", {objectId,
          functionDeclaration: config.customPropertiesGenerator, throwOnSideEffect: true});
        expect(answer.exceptionDetails, JSON.stringify(answer.exceptionDetails)).to.equal(undefined);
        const bagId = answer.result.objectId;
        // js-debug requests own data properties and inherited accessors separately.
        const result = await client.send("Runtime.getProperties", {objectId: bagId, ownProperties: true});
        const accessors = await client.send("Runtime.getProperties", {objectId: bagId, ownProperties: false, accessorPropertiesOnly: true});
        for (const response of [result, accessors]) {
          expect(response.exceptionDetails).to.equal(undefined);
          const names = [...response.result, ...(response.internalProperties ?? [])].map((property) => property.name);
          expect(names).not.to.include("[[Prototype]]");
          expect(names).not.to.include("__proto__");
        }
        return result.result.filter((property) => property.enumerable);
      };
      const structureId = await evaluate("structure");
      expect(await render(structureId)).to.equal("{…} (structure)");
      const fields = await children(structureId);
      expect(fields.map((field) => field.name)).to.deep.equal(["name", "amount"]);
      expect(await render(fields[0].value.objectId)).to.equal("'ABC' (c20)");
      expect(await render(fields[1].value.objectId)).to.equal("12.50 (p8,2)");
      const expectedScalars = ["'ABC  ' (string)", "-42 (i)", "9223372036854775807 (int8)",
        "1.5000000000000000E+00 (f)", "2026-10-03 (d)", "12:34:56 (t)", "ABCDEF (xstring)",
        "ABCD0000 (x4)", "12345678901234567890.12 (p16,2)"];
      for (const [index, expected] of expectedScalars.entries()) {
        expect(await render(await evaluate(`scalars[${index}]`))).to.equal(expected);
      }
      const expectedExtras = ["ZCL_DEBUG_PROBE (object)", "ZCL_DEBUG_PROBE (object)", "initial (object)",
        "[0 rows] (sorted table)", "[rows not enumerated] (hashed table)", "-> 7 (i)",
        "-> unassigned (field symbol)", "-> initial (data reference)", "' A''B\\r\\n\\t' (c20)",
        "-0.05 (p8,2)", "0.00 (p8,2)", "ABCDEF00 (x4)", "'" + "x".repeat(256) + "…' (string)",
        "AB".repeat(128) + "… (x130)"];
      for (const [index, expected] of expectedExtras.entries()) {
        const id = await evaluate(`extraCases[${index}]`);
        expect(await render(id), `extra description ${index}`).to.equal(expected);
        await children(id);
      }
      const castingId = await evaluate("casting");
      expect(await render(castingId)).to.equal("-> 000000000000F83F (x8)");
      const castChildren = await children(castingId);
      expect(await render(castChildren[0].value.objectId)).to.equal("000000000000F83F (x8)");
      const tableId = await evaluate("table");
      expect(await render(tableId)).to.equal("[1 rows] (standard table)");
      expect((await children(tableId)).map((row) => row.name)).to.deep.equal(["1"]);
      const referenceId = await evaluate("reference");
      expect(await render(referenceId)).to.equal("-> {…} (structure)");
      expect((await children(referenceId)).map((field) => field.name)).to.deep.equal(["->"]);
      await client.send("Debugger.resume");
      socket.close();
      client = undefined;
      expect(await exited).to.equal(0);
    } finally {
      if (child?.exitCode === null) child.kill("SIGTERM");
      client?.socket.close();
      await exited?.catch(() => {});
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("binds a workspace ABAP Unit breakpoint at a multiline call's executable start", async () => {
    const source = `CLASS ltcl_probe DEFINITION FINAL FOR TESTING.
  PRIVATE SECTION.
    METHODS helper IMPORTING iv_text TYPE string.
    METHODS counts FOR TESTING.
ENDCLASS.
CLASS ltcl_probe IMPLEMENTATION.
  METHOD helper.
  ENDMETHOD.
  METHOD counts.
    me->helper(
      iv_text = 'hello'
    ).
  ENDMETHOD.
ENDCLASS.`;
    const dir = mkdtempSync(join(tmpdir(), "osd-statement-map-"));
    let client;
    let child;
    let exited;
    try {
      const home = join(dir, "home");
      const storage = join(dir, "instance");
      const workspace = join(dir, "workspace");
      const workspaceSource = join(workspace, "src");
      const packSource = join(storage, "packs", packNameOf(workspace), "src");
      mkdirSync(workspaceSource, {recursive: true});
      mkdirSync(dirname(packSource), {recursive: true});
      symlinkSync(workspaceSource, packSource, "dir");
      writeFileSync(join(workspace, "osd-pack.json"), JSON.stringify({name: "probe", abap: "src"}));
      writeFileSync(join(workspaceSource, "zcl_probe.clas.abap"),
        "CLASS zcl_probe DEFINITION PUBLIC FINAL CREATE PUBLIC. PUBLIC SECTION. ENDCLASS. " +
        "CLASS zcl_probe IMPLEMENTATION. ENDCLASS.");
      const testFile = join(workspaceSource, "zcl_probe.clas.testclasses.abap");
      writeFileSync(testFile, source);
      const config = {input_folder: relative(home, packSource), output_folder: "build/by-input/generation/output",
        input_filter: [".*\\.abap$"], exclude_filter: [], libs: [], options: {},
        write_source_map: true, write_unit_tests: false};
      await transpile({root: home, config, modules: modulesOf(runtimeFixture.root)});
      const module = join(home, config.output_folder, "zcl_probe.clas.testclasses.mjs");
      const map = JSON.parse(readFileSync(module + ".map", "utf8"));
      expect(realpathSync(resolve(dirname(module), map.sources[0]))).to.equal(testFile);
      const position = generatedPosition(map.mappings, 0, 10, 4);
      expect(position, "ABAP call line has a source-map position").to.not.equal(undefined);
      const generated = readFileSync(module, "utf8").split("\n")[position.line - 1];
      expect(generated.slice(position.column)).to.match(/^await this\.me\.get\(\)\.#helper\(/);
      const port = await pickInspectorPort();
      const attach = debuggerConfiguration(port, {target: "unit", root: home, storageDir: storage,
        layers: [{folder: workspace, srcDir: workspaceSource, manifest: join(workspace, "osd-pack.json")}]});
      expect(attach.sourceMapPathOverrides[`${dirname(map.sources[0])}/*`]).to.equal(`${workspaceSource}/*`);
      expect(attach.outFiles).to.deep.equal([`${home}/build/live/output/**/*.mjs`]);

      const runner = join(dir, "runner.mjs");
      const runtime = createRequire(import.meta.url).resolve("@abaplint/runtime");
      writeFileSync(runner, `import runtime from ${JSON.stringify(pathToFileURL(runtime).href)};\n` +
        `globalThis.abap = new runtime.ABAP();\n` +
        `await import(${JSON.stringify(pathToFileURL(module).href)});\n` +
        `await new abap.Classes['CLAS-ZCL_PROBE-LTCL_PROBE']().FRIENDS_ACCESS_INSTANCE.counts();\n`);
      child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${port}`, "--enable-source-maps", runner],
        {cwd: dir, stdio: "ignore"});
      exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
      const target = await inspectorTarget(port);
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, {once: true});
        socket.addEventListener("error", reject, {once: true});
      });
      client = new InspectorClient(socket);
      await client.send("Debugger.enable");
      const breakpoint = await client.send("Debugger.setBreakpointByUrl", {
        url: pathToFileURL(module).href, lineNumber: position.line - 1, columnNumber: position.column,
      });
      await client.send("Runtime.runIfWaitingForDebugger");
      await client.waitFor("Debugger.paused"); // entry in runner.mjs
      await client.send("Debugger.resume");
      const hit = await client.waitFor("Debugger.paused");
      expect(hit.hitBreakpoints).to.include(breakpoint.breakpointId);
      expect(hit.callFrames[0].location.lineNumber).to.equal(position.line - 1);
      await client.send("Debugger.resume");
      client.socket.close();
      client = undefined;
      expect(await exited).to.equal(0);
    } finally {
      if (child?.exitCode === null) child.kill("SIGTERM");
      client?.socket.close();
      await exited?.catch(() => {});
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("attaches over CDP and stops on an ABAP line in a test method", async () => {
    const sourcePath = join(runtimeFixture.root, "src/webgui/zcl_osd_abap_tokens.clas.testclasses.abap");
    const sourceLines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    const sourceLine = sourceLines.findIndex((line) => line.includes("lt_token = zcl_osd_abap_tokens=>scan")) + 1;
    expect(sourceLine).to.be.greaterThan(0);
    const breakpoint = breakpointFor(sourcePath, sourceLine, sourceLines[sourceLine - 1].search(/\S/));
    const inspectPort = await pickInspectorPort();
    const runner = new UnitRun(new ObjectStore({root: runtimeFixture.root}));
    const resultPromise = runner.runDetached("CLAS", "ZCL_OSD_ABAP_TOKENS", {
      testClass: "LTCL_SCAN",
      method: "KEYWORDS_AND_NAMES",
      inspectPort,
      waitForDebugger: true,
    });
    let client;
    let released = false;
    try {
      const target = await inspectorTarget(inspectPort);
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, {once: true});
        socket.addEventListener("error", reject, {once: true});
      });
      client = new InspectorClient(socket);
      await client.send("Debugger.enable");
      const set = await client.send("Debugger.setBreakpointByUrl", {
        url: breakpoint.url,
        lineNumber: breakpoint.lineNumber,
        columnNumber: breakpoint.columnNumber,
      });
      expect(set.breakpointId).to.be.a("string");
      await client.send("Runtime.runIfWaitingForDebugger");
      released = true;
      const entry = await client.waitFor("Debugger.paused");
      expect(entry.reason).to.equal("Break on start");
      await client.send("Debugger.resume");
      // Resuming entry loads the full system under the inspector before the
      // method runs. Its module/seed work can exceed the small-fixture wait.
      const paused = await client.waitFor("Debugger.paused", () => true, 30000);
      expect(paused.hitBreakpoints).to.include(set.breakpointId);
      expect(paused.callFrames[0].location.lineNumber).to.equal(breakpoint.lineNumber);
      const script = client.events.find((event) => event.method === "Debugger.scriptParsed"
        && event.params.scriptId === paused.callFrames[0].location.scriptId);
      expect(script?.params.url).to.equal(breakpoint.url);
      await client.send("Debugger.resume");
      client.socket.close();
      client = undefined;
      const result = await resultPromise;
      expect(result.ok).to.equal(true);
      expect(result.counts).to.include({passed: 1, failed: 0});
    } finally {
      if (client !== undefined) {
        if (!released) await client.send("Runtime.runIfWaitingForDebugger").catch(() => {});
        await client.send("Debugger.resume").catch(() => {});
        client.socket.close();
      }
      await resultPromise.catch(() => {});
    }
  });

  it("terminates a child paused at startup when the debug request is aborted", async () => {
    const inspectPort = await pickInspectorPort();
    const cancellation = new AbortController();
    const runner = new UnitRun(new ObjectStore({root: runtimeFixture.root}));
    const resultPromise = runner.runDetached("CLAS", "ZCL_OSD_ABAP_TOKENS", {
      testClass: "LTCL_SCAN", method: "KEYWORDS_AND_NAMES", inspectPort,
      waitForDebugger: true, signal: cancellation.signal,
    });
    try {
      await inspectorTarget(inspectPort);
      cancellation.abort();
      try {
        await resultPromise;
        throw new Error("expected cancelled run");
      } catch (error) {
        expect(error.message).to.equal("ABAP Unit run cancelled");
      }
      let closed = false;
      try {
        await fetch(`http://127.0.0.1:${inspectPort}/json/list`);
      } catch {
        closed = true;
      }
      expect(closed, "the paused inspector closed").to.equal(true);
    } finally {
      cancellation.abort();
      await resultPromise.catch(() => {});
    }
  });
});

// js-debug reads a script's source map only when the map's own location
// matches resolveSourceMapLocations (positive globs, `!` excludes, dot files
// included). The same rule, so a test can ask it without js-debug.
function sourceMapAllowed(config, mapFile) {
  const file = mapFile.replaceAll("\\", "/");
  const patterns = config.resolveSourceMapLocations;
  return patterns.some((p) => !p.startsWith("!") && matchesGlob(file, p)) &&
    !patterns.some((p) => p.startsWith("!") && matchesGlob(file, p.slice(1)));
}

describe("VS Code debugger configuration: which generations' maps js-debug may read", function () {
  it("predicts the live generation but resolves maps of every generation and of a warm swap", () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-debug-generations-"));
    try {
      const home = join(dir, "home");
      const booted = join(home, "build", "by-input", "booted", "output");
      const live = join(home, "build", "by-input", "live", "output");
      const hot = join(home, "build", "hot", "live");
      for (const folder of [booted, live, hot]) mkdirSync(folder, {recursive: true});
      symlinkSync(join(home, "build", "by-input", "live"), join(home, "build", "live"), "dir");
      symlinkSync(join("build", "live", "output"), join(home, "output"), "dir");
      const config = debuggerConfiguration(9229, {root: home});
      const real = (file) => join(realpathSync(dirname(file)), basename(file));
      expect(config.outFiles).to.deep.equal([`${realpathSync(live).replaceAll("\\", "/")}/**/*.mjs`]);
      // The serving process booted from another generation than the one that
      // is live now (a build ahead of the recycle, or a warm swap that only
      // replaced the changed modules): its maps must still be read.
      expect(sourceMapAllowed(config, real(join(booted, "zcl_osd_fleet_report.clas.mjs.map")))).to.equal(true);
      expect(sourceMapAllowed(config, real(join(live, "zcl_zosd_fleet_dpc_ext.clas.mjs.map")))).to.equal(true);
      expect(sourceMapAllowed(config, real(join(hot, "zcl_zosd_fleet_dpc_ext.clas.mjs.map")))).to.equal(true);
      expect(sourceMapAllowed(config, join(home, "node_modules", "@abaplint", "runtime", "build", "x.js.map"))).to.equal(false);
      // inside the allowed build/ tree, so only the node_modules exclusion can refuse it
      expect(sourceMapAllowed(config, join(realpathSync(live), "node_modules", "x", "y.js.map"))).to.equal(false);
      // Without a root the profile stays portable and still covers the build.
      expect(debuggerConfiguration(9229).resolveSourceMapLocations)
        .to.deep.equal(["${workspaceFolder}/build/**", "!**/node_modules/**"]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("resolves maps from a generation store that build/ only links to", () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-debug-store-link-"));
    try {
      const home = join(dir, "home");
      const store = join(dir, "shared", "by-input");
      const hot = join(dir, "shared", "hot");
      mkdirSync(join(store, "booted", "output"), {recursive: true});
      mkdirSync(hot, {recursive: true});
      mkdirSync(join(home, "build", "other", "output"), {recursive: true});
      symlinkSync(store, join(home, "build", "by-input"), "dir");
      symlinkSync(hot, join(home, "build", "hot"), "dir");
      symlinkSync(join(home, "build", "other"), join(home, "build", "live"), "dir");
      const config = debuggerConfiguration(9229, {root: home});
      expect(sourceMapAllowed(config, join(realpathSync(store), "booted", "output", "x.clas.mjs.map"))).to.equal(true);
      expect(sourceMapAllowed(config, join(realpathSync(store), "booted", "output", "node_modules", "x.js.map"))).to.equal(false);
      expect(sourceMapAllowed(config, join(realpathSync(store), "..", "elsewhere", "x.clas.mjs.map"))).to.equal(false);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("resolves maps through a build folder that is itself a link", () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-debug-build-link-"));
    try {
      const home = join(dir, "home");
      const store = join(dir, "store");
      mkdirSync(join(store, "by-input", "a", "output"), {recursive: true});
      mkdirSync(home);
      symlinkSync(store, join(home, "build"), "dir");
      symlinkSync(join(store, "by-input", "a"), join(store, "live"), "dir");
      const config = debuggerConfiguration(9229, {root: home});
      expect(sourceMapAllowed(config, join(realpathSync(store), "by-input", "a", "output", "x.clas.mjs.map"))).to.equal(true);
      expect(sourceMapAllowed(config, join(home, "build", "by-input", "a", "output", "x.clas.mjs.map"))).to.equal(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe("VS Code debugger transport: a generation goes live ahead of the serving process", function () {
  this.timeout(240000);

  // osg-demo on 0.5.1467: "Run as ABAP Application with debugger" and
  // "Attach debugger and call" showed a bound breakpoint and never stopped.
  // The serving process ran modules from the generation it booted from while
  // build/live already named another, and the attach configuration allowed
  // source maps from the live generation only. Read the real script URLs off
  // the running process's inspector and check them against the configuration
  // the extension builds at that moment.
  // The system serves from its private source root; nothing here moves its
  // build/live. The "other generation goes live" is staged in a temp home
  // whose build/ reuses the private root's generation store read-only (a link
  // to build/by-input) and whose own build/live names a different, empty
  // generation, so the configuration is built exactly as for a home where
  // live has moved on while the serving process kept the one it booted.
  it("keeps the classrun class and the DPC the process loaded inside resolveSourceMapLocations", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "osd-debug-ahead-"));
    const dir = mkdtempSync(join(tmpdir(), "osd-debug-ahead-home-"));
    const launcher = new Launcher({osdHome: runtimeFixture.root, storageDir, workspaceFolders: [], warm: "off"});
    let client;
    try {
      const {port} = await launcher.start();
      const rootLive = readlinkSync(join(runtimeFixture.root, "build", "live"));
      const osdClient = new Osd(`http://127.0.0.1:${port}`);
      // The class run and the OData call load both modules before any debugger.
      expect((await osdClient.classrun("ZCL_OSD_CLASSRUN_DEMO")).text).to.be.a("string");
      expect((await fetch(`http://127.0.0.1:${port}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$format=json`)).status).to.equal(200);
      const inspectPort = await launcher.openInspector();
      const target = await inspectorTarget(inspectPort);
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, {once: true});
        socket.addEventListener("error", reject, {once: true});
      });
      client = new InspectorClient(socket);
      await client.send("Debugger.enable");
      const loaded = (name) => client.events.find((event) => event.method === "Debugger.scriptParsed" &&
        event.params.url.endsWith(`/${name}.clas.mjs`))?.params;
      const scripts = ["zcl_osd_classrun_demo", "zcl_zstg_demo_dpc_ext"].map(loaded);
      expect(scripts.every(Boolean), "both modules are loaded in the serving process").to.equal(true);
      // a home where another generation is live, over the same store
      const home = join(dir, "home");
      const other = join(home, "build", "other", "output");
      mkdirSync(other, {recursive: true});
      symlinkSync(join(runtimeFixture.root, "build", "by-input"), join(home, "build", "by-input"), "dir");
      symlinkSync(dirname(other), join(home, "build", "live"), "dir");
      const config = debuggerConfiguration(inspectPort, {root: home, storageDir, layers: launcher.layers});
      expect(config.outFiles[0]).to.equal(`${realpathSync(other)}/**/*.mjs`);
      for (const script of scripts) {
        const moduleFile = fileURLToPath(script.url);
        expect(moduleFile.startsWith(realpathSync(join(runtimeFixture.root, "build", "by-input")))).to.equal(true);
        const mapFile = script.sourceMapURL.startsWith("file:")
          ? fileURLToPath(script.sourceMapURL) : resolve(dirname(moduleFile), script.sourceMapURL);
        expect(sourceMapAllowed(config, mapFile), `${mapFile} against ${config.resolveSourceMapLocations}`).to.equal(true);
      }
      expect(readlinkSync(join(runtimeFixture.root, "build", "live")), "the source root's live link is untouched").to.equal(rootLive);
    } finally {
      client?.socket.close();
      await launcher.stop();
      rmSync(dir, {recursive: true, force: true});
      rmSync(storageDir, {recursive: true, force: true});
    }
  });
});

describe("VS Code debugger transport: serving DPC after earlier activity", function () {
  this.timeout(180000);

  it("pauses on a DPC line after a plain call, a detached session, and Stop/Start", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "osd-dpc-debug-"));
    const launcher = new Launcher({osdHome: runtimeFixture.root, storageDir, workspaceFolders: [], warm: "off"});
    const sourcePath = join(runtimeFixture.root, "src/demo/zcl_zstg_demo_dpc_ext.clas.abap");
    const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    const sourceLine = lines.findIndex((line) => line.includes("lt_status = ranges_for(")) + 1;
    expect(sourceLine).to.be.greaterThan(0);
    let client;
    try {
      for (let run = 0; run < 2; run++) {
        const {port} = await launcher.start();
        const breakpoint = breakpointFor(sourcePath, sourceLine, lines[sourceLine - 1].search(/\S/));
        const url = `http://127.0.0.1:${port}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$format=json`;
        // This request loads and executes the DPC before any debugger exists.
        expect((await fetch(url)).status).to.equal(200);
        const inspectPort = await launcher.openInspector();
        for (let session = 0; session < 2; session++) {
          const target = await inspectorTarget(inspectPort);
          const socket = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, {once: true});
            socket.addEventListener("error", reject, {once: true});
          });
          client = new InspectorClient(socket);
          await client.send("Debugger.enable");
          const scripts = client.events.filter((event) => event.method === "Debugger.scriptParsed" &&
            event.params.url.includes("zcl_zstg_demo_dpc_ext"));
          expect(scripts.map((event) => event.params.url), `expected ${breakpoint.url}`).to.include(breakpoint.url);
          const set = await client.send("Debugger.setBreakpointByUrl", {
            url: breakpoint.url, lineNumber: breakpoint.lineNumber, columnNumber: breakpoint.columnNumber,
          });
          if (set.locations.length === 0) {
            await client.waitFor("Debugger.breakpointResolved", (event) => event.breakpointId === set.breakpointId);
          }
          const response = fetch(url);
          const paused = await client.waitFor("Debugger.paused");
          expect(paused.hitBreakpoints).to.include(set.breakpointId);
          await client.send("Debugger.resume");
          expect((await response).status).to.equal(200);
          client.socket.close();
          client = undefined;
        }
        await launcher.stop();
      }
    } finally {
      client?.socket.close();
      await launcher.stop();
      rmSync(storageDir, {recursive: true, force: true});
    }
  });
});

describe("VS Code controller: Attach and call across a generation switch", function () {
  // osg-demo under Xvfb (0.5.1467): nobody answers a notification, and the
  // breakpoint's URI is the workspace copy while the command may name the
  // same source through another path. Neither may stop the call.
  function loadEntitySetCommands(api) {
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const extensionPath = require.resolve("../editors/vscode/extension.js");
    delete require.cache[extensionPath];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "vscode") return api;
      return originalLoad.call(this, request, parent, isMain);
    };
    try { return require(extensionPath).registerEntitySetCommands; }
    finally { Module._load = originalLoad; }
  }

  function entitySetApi(breakpoints, warnings, commands) {
    class SourceBreakpoint {
      constructor(file, enabled = true) { this.enabled = enabled; this.location = {uri: {scheme: "file", fsPath: file}}; }
    }
    return {
      SourceBreakpoint,
      TreeItem: class {},
      EventEmitter: class { event = () => ({dispose() {}}); fire() {} },
      debug: {breakpoints: breakpoints.map(([file, enabled]) => new SourceBreakpoint(file, enabled))},
      ViewColumn: {Beside: 2},
      commands: {registerCommand(name, handler) { commands.set(name, handler); return {dispose() {}}; }},
      workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback})},
      // an unattended UI: a notification is shown and never answered
      window: {showWarningMessage: (message, ...choices) => { warnings.push({message, choices}); return new Promise(() => {}); },
        createWebviewPanel: () => ({webview: {html: ""}})},
    };
  }

  async function withFetch(requests, body) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requests.push(url);
      return {status: 200, text: async () => JSON.stringify({d: {results: []}})};
    };
    try { return await body(); } finally { globalThis.fetch = originalFetch; }
  }

  it("calls without stopping, and says so, when no enabled DPC breakpoint matches: no prompt to answer", async () => {
    const commands = new Map();
    const warnings = [];
    const requests = [];
    const notes = [];
    const api = entitySetApi([["/w/zcl_demo_dpc_ext.clas.abap", false]], warnings, commands);
    const registerEntitySetCommands = loadEntitySetCommands(api);
    const calls = [];
    const controller = {attachSystemDebugger: async () => { calls.push("attach"); return true; },
      waitForDebuggerReady: async () => { calls.push("ready"); return true; }, debugNote: (line) => notes.push(line)};
    await withFetch(requests, async () => {
      registerEntitySetCommands({subscriptions: []}, {appendLine() {}}, undefined, controller);
      const command = commands.get("osd.callEntitySetWithDebugger");
      const args = {service: "ZDEMO_SRV", set: "TravelSet", kind: "get_entityset", file: "/w/zcl_demo_dpc_ext.clas.abap"};
      const done = command(args);
      const outcome = await Promise.race([done.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 500))]);
      expect(outcome, "the command must not wait for an answer nobody gives").to.equal("done");
    });
    expect(warnings).to.have.length(1);
    expect(warnings[0].message).to.include("no enabled breakpoint");
    expect(warnings[0].choices).to.deep.equal([]);
    expect(notes.some((line) => line.includes("no enabled breakpoint matches"))).to.equal(true);
    expect(calls).to.deep.equal(["attach", "ready"]);
    expect(requests).to.have.length(1);
  });

  it("matches a DPC breakpoint set through a link or in the running copy, never in a shadowed copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-bp-identity-"));
    try {
      const real = join(dir, "osg-demo", "src");
      mkdirSync(real, {recursive: true});
      writeFileSync(join(real, "zcl_zosd_fleet_dpc_ext.clas.abap"), "");
      symlinkSync(join(dir, "osg-demo"), join(dir, "linked"), "dir");
      const viaLink = join(dir, "linked", "src", "zcl_zosd_fleet_dpc_ext.clas.abap");
      // the copy the running generation was compiled from, as the command's
      // file may name the store's path or another layer's
      const runningCopy = join(dir, "packs", "ws-osg-demo", "src", "zcl_zosd_fleet_dpc_ext.clas.abap");
      // a shadowed copy: same object, never compiled (packs/, .worktrees, .local/lars, output/)
      const shadowed = join(dir, ".local", "lars", "src", "zcl_zosd_fleet_dpc_ext.clas.abap");
      const running = {files: new Map([[runningCopy, runningCopy]])};
      for (const [breakpointFile, counts] of [[viaLink, true], [runningCopy, true], [shadowed, false]]) {
        const commands = new Map();
        const warnings = [];
        const requests = [];
        const api = entitySetApi([[breakpointFile, true]], warnings, commands);
        const registerEntitySetCommands = loadEntitySetCommands(api);
        const waited = [];
        const controller = {attachSystemDebugger: async () => true, runningSources: () => running,
          waitForDebuggerReady: async (file) => { waited.push(file); return true; }, debugNote() {}};
        await withFetch(requests, async () => {
          registerEntitySetCommands({subscriptions: []}, {appendLine() {}}, undefined, controller);
          await commands.get("osd.callEntitySetWithDebugger")({service: "ZOSD_FLEET_SRV", set: "ShipSet",
            kind: "get_entityset", file: join(real, "zcl_zosd_fleet_dpc_ext.clas.abap")});
        });
        expect(warnings.length, `${breakpointFile} ${counts ? "is" : "is not"} the source that runs`).to.equal(counts ? 0 : 1);
        expect(waited).to.deep.equal([join(real, "zcl_zosd_fleet_dpc_ext.clas.abap")]);
        expect(requests).to.have.length(1);
      }
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("is ready once js-debug's child session verifies the breakpoint, which its attach session never does", async () => {
    // Measured with the js-debug DAP server: the attach session named
    // "OSD: ABAP (<port>)" answers every setBreakpoints unverified and sends
    // no breakpoint event; only the child it starts ("Remote Process [0]")
    // binds and stops. 0.5.1467 asked the named session only, waited 15 s,
    // and then dropped the call.
    const dir = mkdtempSync(join(tmpdir(), "osd-bp-family-"));
    try {
      const real = join(dir, "osg-demo", "src");
      mkdirSync(real, {recursive: true});
      const file = join(real, "zcl_osd_fleet_report.clas.abap");
      writeFileSync(file, "");
      symlinkSync(join(dir, "osg-demo"), join(dir, "linked"), "dir");
      class SourceBreakpoint {
        constructor(at) { this.enabled = true; this.location = {uri: {scheme: "file", fsPath: at}}; }
      }
      const starts = [];
      const lines = [];
      const api = {
        SourceBreakpoint,
        EventEmitter: class { event = () => ({dispose() {}}); fire() {} },
        TreeItem: class {},
        ViewColumn: {Beside: 2},
        commands: {registerCommand() { return {dispose() {}}; }},
        workspace: {onDidChangeWorkspaceFolders: () => ({dispose() {}}), getConfiguration: () => ({get: (_key, fallback) => fallback})},
        window: {setStatusBarMessage: () => ({dispose() {}}), createWebviewPanel: () => ({webview: {html: ""}})},
        debug: {
          // the breakpoint was set on the file opened through the link
          breakpoints: [new SourceBreakpoint(join(dir, "linked", "src", "zcl_osd_fleet_report.clas.abap"))],
          onDidStartDebugSession(fn) { starts.push(fn); return {dispose() {}}; },
          onDidTerminateDebugSession() { return {dispose() {}}; },
        },
      };
      const require = createRequire(import.meta.url);
      const Module = require("node:module");
      const extensionPath = require.resolve("../editors/vscode/extension.js");
      delete require.cache[extensionPath];
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === "vscode") return api;
        return originalLoad.call(this, request, parent, isMain);
      };
      let SystemController, classrunObject;
      try { ({SystemController, classrunObject} = require(extensionPath)); }
      finally { Module._load = originalLoad; }
      const controller = new SystemController({subscriptions: []}, {appendLine: (line) => lines.push(line)});
      controller.launcher = {state: "running", inspectPort: 9402, osdHome: dir};
      const parent = {id: "attach", name: "OSD: ABAP (9402)",
        getDebugProtocolBreakpoint: async () => ({verified: false, message: "breakpoint.provisionalBreakpoint"})};
      const child = {id: "target", name: "Remote Process [0]", parentSession: parent,
        getDebugProtocolBreakpoint: async () => ({verified: true})};
      starts.forEach((fn) => fn(parent));
      starts.forEach((fn) => fn(child));
      expect(await controller.waitForDebuggerReady(file, 1000)).to.equal(true);
      expect(lines.some((line) => line.includes("matches") && line.includes("(realpath)"))).to.equal(true);
      expect(lines.some((line) => line.includes("ready after") && line.includes("Remote Process [0]"))).to.equal(true);
      const runSteps = [];
      await classrunObject("ZCL_OSD_FLEET_REPORT", {show() {}, appendLine() {}}, false, file, {
        attach: async () => { runSteps.push("attach"); return true; },
        controller: {waitForDebuggerReady: async target => {
          expect(target).to.equal(file);
          runSteps.push("verified");
          return controller.waitForDebuggerReady(target, 1000);
        }},
        client: () => ({classrun: async () => { runSteps.push("run"); return {text: "ok", ms: 1}; }}),
      });
      expect(runSteps, "F9 with an existing breakpoint attaches before sending").to.deep.equal(["attach", "verified", "run"]);
      // and a wait that gives up says why
      child.getDebugProtocolBreakpoint = async () => ({verified: false});
      expect(await controller.waitForDebuggerReady(file, 120)).to.equal(false);
      expect(lines.at(-1)).to.match(/gave up waiting after 120 ms: sessions .*verified: false/);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("waits for the replacement session's verified DPC breakpoint despite late old termination", async () => {
    const home = mkdtempSync(join(tmpdir(), "osd-attach-generation-"));
    const first = join(home, "build", "by-input", "first", "output");
    const second = join(home, "build", "by-input", "second", "output");
    mkdirSync(first, {recursive: true});
    mkdirSync(second, {recursive: true});
    symlinkSync(first, join(home, "output"), "dir");
    const listeners = {start: [], end: []};
    const events = [];
    const commands = new Map();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      events.push(`request ${url}`);
      return {status: 200, text: async () => JSON.stringify({d: {results: []}})};
    };
    const file = join(home, "src", "zcl_demo_dpc_ext.clas.abap");
    class SourceBreakpoint {
      constructor() { this.enabled = true; this.location = {uri: {scheme: "file", fsPath: file}}; }
    }
    const api = {
      SourceBreakpoint,
      EventEmitter: class { event = () => ({dispose() {}}); fire() {} },
      TreeItem: class {},
      ViewColumn: {Beside: 2},
      commands: {registerCommand(name, handler) { commands.set(name, handler); return {dispose() {}}; }},
      workspace: {onDidChangeWorkspaceFolders: () => ({dispose() {}}),
        getConfiguration: () => ({get: (_key, fallback) => fallback})},
      window: {setStatusBarMessage: () => ({dispose() {}}),
        showErrorMessage: (message) => { throw new Error(message); },
        createWebviewPanel: () => ({webview: {html: ""}})},
      debug: {
        breakpoints: [new SourceBreakpoint()],
        onDidStartDebugSession(fn) { listeners.start.push(fn); return {dispose() {}}; },
        onDidTerminateDebugSession(fn) { listeners.end.push(fn); return {dispose() {}}; },
        async stopDebugging(session) {
          events.push(`stop ${session.id}`);
          // VS Code may deliver termination after the new session starts.
        },
        async startDebugging(_folder, config) {
          events.push(`start ${config.outFiles[0]}`);
          return true;
        },
      },
    };
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const extensionPath = require.resolve("../editors/vscode/extension.js");
    delete require.cache[extensionPath];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "vscode") return api;
      return originalLoad.call(this, request, parent, isMain);
    };
    let SystemController;
    let registerEntitySetCommands;
    try { ({SystemController, registerEntitySetCommands} = require(extensionPath)); }
    finally { Module._load = originalLoad; }
    try {
      const output = [];
      const controller = new SystemController({subscriptions: []}, {appendLine: (line) => output.push(line)});
      controller.launcher = {state: "running", inspectPort: 9401, inspectorOpen: true, debug: false,
        osdHome: home, storageDir: home, layers: []};
      controller.debuggerState = {systemPort: 9401};
      controller.debuggerOutputPattern = `${first}/**/*.mjs`;
      registerEntitySetCommands({subscriptions: []}, {appendLine: (line) => output.push(line)}, undefined, controller);
      const old = {id: "old", name: "OSD: ABAP (9401)",
        getDebugProtocolBreakpoint: async () => ({verified: true})};
      listeners.start.forEach((fn) => fn(old));
      rmSync(join(home, "output"));
      symlinkSync(second, join(home, "output"), "dir");
      const command = commands.get("osd.callEntitySetWithDebugger");
      expect(command).to.be.a("function");
      let finished = false;
      const calling = command({service: "ZDEMO_SRV", set: "TravelSet", kind: "get_entityset", file})
        .then(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).to.deep.equal([`stop old`, `start ${second}/**/*.mjs`]);
      // The old DAP marker was verified, but the serving generation changed.
      expect(finished).to.equal(false);
      const replacement = {id: "new", name: old.name,
        getDebugProtocolBreakpoint: async () => ({verified: false})};
      listeners.start.forEach((fn) => fn(replacement));
      listeners.end.forEach((fn) => fn(old));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events.some((event) => event.startsWith("request ")), "unverified replacement must not receive the call").to.equal(false);
      replacement.getDebugProtocolBreakpoint = async () => ({verified: true});
      await calling;
      expect(events.at(-1)).to.equal("request http://localhost:3030/sap/opu/odata/sap/ZDEMO_SRV/TravelSet?$top=20&$format=json");
      expect(finished).to.equal(true);
      expect(controller.activeSystemSessionId).to.equal("new");
      expect(controller.debuggerState.systemPort).to.equal(9401);
      expect(output.filter((line) => /gave up|failed|could not|without/.test(line))).to.deep.equal([]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(home, {recursive: true, force: true});
    }
  });
});
