#!/usr/bin/env node
import {writeGo, reportSymbols} from "./symbols.mjs";
// Build one classic ABAP report as a small native command. The report's
// selection screen is its command-line contract; the Go host is deliberately
// separate from OSGo's HTTP/OData/database host.
import {execFileSync} from "node:child_process";
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {home} from "./home.mjs";
import {checkLibPins} from "./lib-pins.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {prepareF4} from "./osabap-f4.mjs";

const here = import.meta.dirname;
// node tools/gogen/osabap.mjs [report.prog.abap] [--lib <folder>]...
// --lib adds a folder of ABAP classes and interfaces the report may use; the
// classes, interfaces and dictionary beside the report are always part of it.
const cli = process.argv.slice(2);
const libs = [];
const positional = [];
const readOptions = {"--read-params": [], "--read-lists": []};
for (let i = 0; i < cli.length; i++) {
  const arg = cli[i];
  if (arg === "--lib" || arg in readOptions) {
    const value = cli[++i];
    if (!value || value.startsWith("-")) throw new Error(`osabap: ${arg} needs ${arg === "--lib" ? "a folder" : "parameter names"}`);
    if (arg === "--lib") libs.push(resolve(value));
    else {
      const names = value.split(",").map((name) => name.trim().toUpperCase());
      if (names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))) throw new Error(`osabap: ${arg}: invalid parameter name in ${value}`);
      readOptions[arg].push(...names);
    }
  } else if (arg.startsWith("-")) throw new Error(`osabap: unknown build option ${arg}`);
  else positional.push(arg);
}
if (positional.length > 1) throw new Error("osabap: expected one report");
const readParams = [...new Set(readOptions["--read-params"])];
const readLists = [...new Set(readOptions["--read-lists"])];
const report = resolve(positional[0] ?? join(here, "apps", "hello", "zhello.prog.abap"));
const name = basename(report).replace(/\.prog\.abap$/i, "").toUpperCase();
const className = `ZCL_OSABAP_${name.replace(/^Z/, "")}`;
const buildRoot = process.env.OSABAP_BUILD_ROOT ? resolve(process.env.OSABAP_BUILD_ROOT) : here;
if (buildRoot !== here) {
  mkdirSync(buildRoot, {recursive: true});
  cpSync(join(here, "go"), join(buildRoot, "go"), {recursive: true, filter: (path) =>
    !/(^|[/\\])(?:\.out|zz_[^/\\]*|generated)(?:[/\\]|$)/.test(path)});
}
const generated = join(buildRoot, ".out", "osabap-abap");
const dir = join(buildRoot, "go", "cmd", "osabap");
const targetGOOS = process.env.GOOS || (process.platform === "win32" ? "windows" : "");
const bin = join(buildRoot, ".out", targetGOOS === "windows" ? "osabap.exe" : "osabap");

checkLibPins(home);
rmSync(generated, {recursive: true, force: true});
mkdirSync(generated, {recursive: true});
mkdirSync(dir, {recursive: true});

const gui = libraryPath(home, "open-abap-gui");
const {convertProgram} = await import(join(gui, "converter", "src", "api.mjs"));
const {parseSource} = await import(join(gui, "converter", "src", "parser.mjs"));
const source = readFileSync(report, "utf8");
// the selection texts of the report (TPOOL, ID S) from the abapGit <report>.prog.xml
// beside it: the labels of the terminal form and of -help; the text symbols
// (ID I) go along for the block titles that name them. Only the first TPOOL
// counts: I18N_TPOOL after it holds the translations. An S entry "." takes its
// text from the dictionary, which this build has not, so the name stays, and an
// icon code in front (@DJ@) is drawn by SAP GUI, not printed
const xmlEntity = (text) => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&"})[e]);
const programXml = report.replace(/\.abap$/i, ".xml");
const textPool = {};
const tpool = existsSync(programXml) ? /<TPOOL>([\s\S]*?)<\/TPOOL>/.exec(readFileSync(programXml, "utf8"))?.[1] ?? "" : "";
for (const [, item] of tpool.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
  const field = (tag) => xmlEntity(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(item)?.[1] ?? "");
  const entry = field("ENTRY").replace(/^@[0-9A-Z]{2}(\\[^@]*)?@/, "").trim();
  if (field("KEY") === "" || entry === "") continue;
  if (field("ID") === "S" && entry !== ".") textPool[field("KEY").toUpperCase()] = entry;
  if (field("ID") === "I") textPool[`TEXT-${field("KEY").toUpperCase()}`] = entry;
}
// The converter's simple-assignment F4 shortcut replaces the event body at
// the first assignment, regardless of target. Spell every simple assignment
// as MOVE so the complete event block passes through native lowering.
const {fields: f4Fields, events: f4Events, convertedSource} = prepareF4(source, parseSource(source, basename(report)));
const converted = await convertProgram({source: convertedSource, filename: basename(report), mode: "strict", nativePassthrough: true, className, transactionCode: name, ...(Object.keys(textPool).length > 0 ? {textPool} : {})});
if (converted.supported !== true || converted.classSource === undefined) {
  throw new Error(`${report}: converter refused the report: ${JSON.stringify(converted.diagnostics)}`);
}
let classSource = converted.classSource;
if (f4Fields.length) {
  const state = converted.reportIR?.statePlan?.selectionState ?? {};
  const marker = "  METHOD zif_gg_report_v1~at_selection_screen_value_req.";
  const start = classSource.indexOf(marker);
  const end = classSource.indexOf("  ENDMETHOD.", start);
  if (start < 0 || end < 0) throw new Error(`${report}: converter omitted ON VALUE-REQUEST method`);
  for (const field of f4Fields) {
    const [base, component] = field.split("-");
    if (!state[base]?.member || Boolean(component) !== Boolean(state[base].ranges)) {
      throw new Error(`${report}: F4 target does not match a selection field: ${field}`);
    }
  }
  let method = classSource.slice(start + marker.length, end);
  let guardPosition = 0;
  for (const field of f4Events) {
    const base = field.split("-")[0];
    const guard = `IF iv_name = '${base}'.`;
    const position = method.indexOf(guard, guardPosition);
    if (position < 0) throw new Error(`${report}: converter omitted F4 guard for ${field}`);
    method = method.slice(0, position) + `IF iv_name = '${field}'.` + method.slice(position + guard.length);
    guardPosition = position + `IF iv_name = '${field}'.`.length;
  }
  // The form sends all current fields. Value-request events can read any of
  // them, including a field the user just edited before pressing F4.
  const prefix = Object.entries(state).map(([field, item]) =>
    `    IF line_exists( it_values[ name = '${field}' ] ).\n      ${item.member} = ${item.ranges ? `CORRESPONDING #( it_values[ name = '${field}' ]-ranges )` : `it_values[ name = '${field}' ]-value`}.\n    ENDIF.`).join("\n");
  const rangeInit = [...new Set(f4Fields.filter((field) => field.includes("-")).map((field) => field.split("-")[0]))]
    .map((base) => `    IF ${state[base].member} IS INITIAL.\n      APPEND VALUE #( sign = 'I' option = 'EQ' ) TO ${state[base].member}.\n    ENDIF.`).join("\n");
  const suffix = f4Fields.map((field) => {
    const [base, component] = field.split("-");
    const value = component ? `${state[base].member}[ 1 ]-${component.toLowerCase()}` : state[base].member;
    return `    IF iv_name = '${field}'.\n      rt_values = VALUE #( ( sign = zif_gg_selection_screen_types=>sign_include option = zif_gg_selection_screen_types=>option_eq low = ${value} ) ).\n    ENDIF.`;
  }).join("\n");
  classSource = classSource.slice(0, start + marker.length) + "\n" + prefix + "\n" + rangeInit + method + suffix + "\n" + classSource.slice(end);
}
writeFileSync(join(generated, `${className.toLowerCase()}.clas.abap`), classSource);
// the report's own dictionary: tables, data elements, domains and table
// types beside the report file are part of it, the way a report on a system
// brings its tables along in its package
const ddic = readdirSync(dirname(report)).filter((file) => /\.(tabl|dtel|doma|ttyp)\.xml$/i.test(file)).sort();
for (const file of ddic) copyFileSync(join(dirname(report), file), join(generated, file.toLowerCase()));
// the report's own classes and interfaces: whatever sits beside it, tests and
// all (the build skips test classes), under the name abapGit gives them
const own = readdirSync(dirname(report)).filter((file) => /\.(clas|intf)\.(abap|xml|[a-z_]+\.abap)$/i.test(file)).sort();
for (const file of own) copyFileSync(join(dirname(report), file), join(generated, file.toLowerCase()));
// compiled by name: the report's classes and interfaces, and every one in a --lib folder
const objectsIn = (folder) => readdirSync(folder).filter((f) => /\.(clas|intf)\.abap$/i.test(f)).map((f) => f.split(".")[0].toLowerCase());
const ownObjects = [...new Set([...objectsIn(dirname(report)), ...libs.flatMap(objectsIn)])].sort();
// the open-abap-core classes and interfaces the program names are pulled in
// by name, and whatever those name in turn, local classes included, until
// nothing new turns up: a static call is not followed into the core the way a
// class of the program is, and a CLI should not need a list of them
const core = join(libraryPath(home, "open-abap-core"), "src");
const coreFiles = new Map();
const walk = (folder) => {
  for (const entry of readdirSync(folder, {withFileTypes: true})) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(clas|intf)\.(abap|locals_imp\.abap|locals_def\.abap)$/i.test(entry.name)) {
      // abapGit writes /UI2/CL_JSON as #ui2#cl_json; the source names it with slashes
      const name = entry.name.split(".")[0].toLowerCase().replaceAll("#", "/");
      coreFiles.set(name, [...(coreFiles.get(name) ?? []), path]);
    }
  }
};
walk(core);
const namesIn = (text) => new Set(text.toLowerCase().match(/[a-z_/][a-z0-9_/]*/g) ?? []);
const ownSources = [source, ...[dirname(report), ...libs].flatMap((folder) => readdirSync(folder)
  .filter((f) => /\.(clas|intf)\.(abap|locals_imp\.abap|locals_def\.abap)$/i.test(f))
  .map((f) => readFileSync(join(folder, f), "utf8")))];
const hostObjects = [join(gui, "framework"), join(gui, "framework", "host")]
  .flatMap((folder) => readdirSync(folder)
    .filter((file) => /^(?:zcl_gg_host|zcx_gg_).*\.clas\.abap$/i.test(file) && !/\.testclasses\./i.test(file))
    .map((file) => file.replace(/\.clas\.abap$/i, "")));
// the host classes of open-abap-gui are compiled too, and a class needs its
// superclass: ZCX_GG_CONTROL_FLOW, which MESSAGE TYPE 'E' raises, is a
// CX_NO_CHECK, and without it every E or A message ended in NOT_COMPILED
const hostSources = [join(gui, "framework"), join(gui, "framework", "host")]
  .flatMap((folder) => readdirSync(folder)
    .filter((file) => hostObjects.includes(file.replace(/\.clas\.abap$/i, "")))
    .map((file) => readFileSync(join(folder, file), "utf8")));
if (f4Fields.some((field) => field.includes("-"))) {
  // The upstream host applies returned F4 ranges only to a whole selection
  // value. A component request must update the first range of its base field.
  const hostPath = join(gui, "framework", "host", "zcl_gg_host.clas.abap");
  const hostSource = readFileSync(hostPath, "utf8");
  const hook = "    IF line_exists( ct_values[ name = iv_name ] ) AND lt_requested_ranges IS NOT INITIAL.";
  if (!hostSource.includes(hook)) throw new Error("osabap: F4 host hook has changed");
  const componentHook = `    DATA lv_base TYPE zif_gg_selection_screen_types=>ty_name.
    DATA lv_component TYPE string.
    SPLIT iv_name AT '-' INTO lv_base lv_component.
    IF ( lv_component = 'LOW' OR lv_component = 'HIGH' )
        AND lt_requested_ranges IS NOT INITIAL.
      IF line_exists( ct_values[ name = lv_base ] ).
        IF ct_values[ name = lv_base ]-ranges IS INITIAL.
          ct_values[ name = lv_base ]-ranges = VALUE #( ( sign = 'I' option = 'EQ' ) ).
        ENDIF.
        IF lv_component = 'LOW'.
          ct_values[ name = lv_base ]-ranges[ 1 ]-low = lt_requested_ranges[ 1 ]-low.
        ELSE.
          ct_values[ name = lv_base ]-ranges[ 1 ]-high = lt_requested_ranges[ 1 ]-low.
          ct_values[ name = lv_base ]-ranges[ 1 ]-option = 'BT'.
        ENDIF.
      ENDIF.
    ELSE.`;
  const closing = "    ENDIF.\n  ENDMETHOD.";
  const methodStart = hostSource.indexOf("  METHOD run_value_request.");
  const methodEnd = hostSource.indexOf(closing, methodStart);
  if (methodEnd < 0 || hostSource.indexOf(hook, methodStart) > methodEnd) throw new Error("osabap: F4 host method has changed");
  const patched = hostSource.slice(0, methodStart) + hostSource.slice(methodStart, methodEnd).replace(hook, componentHook + "\n" + hook) +
    "    ENDIF.\n" + hostSource.slice(methodEnd);
  writeFileSync(join(generated, "zcl_gg_host.clas.abap"), patched);
}
const superclasses = (text) => [...text.matchAll(/\bINHERITING\s+FROM\s+([\w\/]+)/gi)].map((m) => m[1].toLowerCase());
const coreObjects = [];
const seen = new Set(ownObjects);
let pending = [...namesIn(ownSources.join("\n")), ...hostSources.flatMap(superclasses)];
while (pending.length > 0) {
  const next = [];
  for (const name of pending) {
    if (seen.has(name) || !coreFiles.has(name)) continue;
    seen.add(name);
    coreObjects.push(name);
    for (const path of coreFiles.get(name)) next.push(...namesIn(readFileSync(path, "utf8")));
  }
  pending = next;
}
coreObjects.sort();
for (const helper of converted.helperSources ?? []) {
  writeFileSync(join(generated, `${helper.className.toLowerCase()}.clas.abap`), helper.source);
}

const selections = (converted.reportIR?.selections ?? []).flatMap((screen) => screen.elements ?? [])
  .filter((element) => element.name);
const selectionNames = [...new Set(selections.map((element) => element.name.toUpperCase()))];
// a checkbox is PARAMETERS ... AS CHECKBOX; MEMORY ID checkbox names a
// memory id, and a select-option is never one
const isCheckbox = (element) => element.kind === "parameter" && /\bAS\s+CHECKBOX\b/i.test(element.additions ?? "");
const positionals = selections.filter((element) => element.kind === "parameter" && !isCheckbox(element))
  .map((element) => element.name.toUpperCase());
const checkboxes = selections.filter(isCheckbox)
  .map((element) => element.name.toUpperCase());
const ranges = selections.filter((element) => element.kind === "select-option")
  .map((element) => element.name.toUpperCase());

const rttiObjects = readdirSync(join(core, "rtti"))
  .filter((file) => /^cl_abap_.*\.clas\.abap$/i.test(file))
  .map((file) => file.replace(/\.clas\.abap$/i, ""));
const appRuntime = join(here, "apps", "runtime");
const program = compileProgram({
  folders: [...libs, appRuntime, join(gui, "framework"), join(gui, "src"), core, generated],
  objects: [className.toLowerCase(), ...ownObjects, ...coreObjects, ...hostObjects, ...rttiObjects, "zcl_gg_workbench_utility",
    "cl_gui_control", "cl_gui_container", "cl_gui_cfw", "cl_gui_frontend_services", "zcl_osabap_runtime"],
  skip: (path) => /\.testclasses\.abap$/i.test(path),
});
// (kept after rttiObjects: test/dsl-report.mjs evaluates the selections block alone)
for (const parameter of [...readParams, ...readLists]) {
  const element = selections.find((element) => element.name.toUpperCase() === parameter);
  if (!element) throw new Error(`osabap: read grant: unknown parameter ${parameter}`);
  if (element.kind !== "parameter" || isCheckbox(element)) throw new Error(`osabap: read grant: ${parameter} must be a character PARAMETERS field`);
}

// Validate the resolved ABAP type, including LIKE, aliases and DDIC elements;
// syntax spelling alone cannot tell whether a selection value is a path.
for (const parameter of [...readParams, ...readLists]) {
  const member = converted.reportIR?.statePlan?.selectionState?.[parameter]?.member?.toUpperCase();
  const attribute = program.classes.find((cls) => cls.name === className)?.attributes.find((attr) => attr.name === member);
  if (!["c", "string"].includes(attribute?.type?.k)) throw new Error(`osabap: read grant: ${parameter} must be a character PARAMETERS field`);
}
reportSymbols(program, converted, name, basename(report));
writeGo(join(dir, "zz_generated.go"), program);

// the report's own tables: their CREATE TABLEs, as the transpiler writes them
// for the Node host, go into the binary for -db; a report without tables is
// built without a database driver
const tables = ddic.filter((file) => /\.tabl\.xml$/i.test(file)).map((file) => file.replace(/\.tabl\.xml$/i, "").toUpperCase());
let schema = [];
if (tables.length > 0) {
  const {DatabaseSetup} = await import(join(home, "node_modules", "@abaplint", "transpiler", "build", "src", "db", "index.js"));
  const own = new Set(tables.map((t) => t.toLowerCase()));
  schema = new DatabaseSetup(program.reg).run().schemas.sqlite
    .filter((sql) => own.has(/^CREATE\s+TABLE\s+['"]?([\w/]+)/i.exec(sql)?.[1]?.toLowerCase()));
  if (schema.length !== tables.length) throw new Error(`osabap: ${tables.length} tables beside the report, ${schema.length} CREATE TABLEs`);
}
writeFileSync(join(dir, "zz_db.json"), JSON.stringify(schema));
writeFileSync(join(dir, "zz_app.go"), `package main

import (
	_ "embed"

	"osg/gogen/abap"
)

//go:embed zz_db.json
var appSchema []byte

var appTables = []string{${tables.map(JSON.stringify).join(", ")}}

const appProgram = ${JSON.stringify(name)}
var appSelectionNames = []string{${selectionNames.map(JSON.stringify).join(", ")}}
var appPositionals = []string{${positionals.map(JSON.stringify).join(", ")}}
var appCheckboxes = map[string]bool{${checkboxes.map((name) => `${JSON.stringify(name)}: true`).join(", ")}}
var appRanges = map[string]bool{${ranges.map((name) => `${JSON.stringify(name)}: true`).join(", ")}}
var appReadParams = []string{${readParams.map(JSON.stringify).join(", ")}}
var appReadLists = []string{${readLists.map(JSON.stringify).join(", ")}}
var appLabels = map[string]string{${Object.entries(textPool).filter(([key]) => selectionNames.includes(key)).map(([key, text]) => `${JSON.stringify(key)}: ${JSON.stringify(text)}`).join(", ")}}
var appF4 = map[string]bool{${f4Fields.map((name) => `${JSON.stringify(name)}: true`).join(", ")}}

func newReport(s *abap.Session) *${className} { return New_${className}(s) }
`);

execFileSync("gofmt", ["-w", dir], {stdio: "inherit"});
execFileSync("go", ["build", ...(tables.length > 0 ? [] : ["-tags", "nodatabase"]), "-trimpath", "-ldflags=-s -w", "-o", bin, "./cmd/osabap"], {
  cwd: join(buildRoot, "go"), stdio: "inherit",
});
console.log(`osabap: ${name}, ${program.classes.length} classes, ${program.partial.length} statement stubs` +
  `${tables.length ? `, tables ${tables.join(", ")} (-db)` : ""} -> ${bin}`);
