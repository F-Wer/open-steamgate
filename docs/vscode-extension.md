# A thin VS Code extension over a running osd (Q2)

Release packaging and tag instructions: [VS Code prerelease by tag](release.md).
Source-layer discovery, write behavior and the proposed ZIP layer are mapped
in [Source layers](source-layers.md).

*2026-09-25.* `editors/vscode/` is a VS Code extension that holds no ABAP
and runs nothing itself. It is a client of one listener (`npm start`,
`build/osd up`), set by the setting `osd.url` (default
`http://localhost:3030`). abaplint stays the language server; the debugger
is Q1 (`docs/debugging-abap.md`). What this adds is what needs a running
system:

| In VS Code | Asks the server | Where it is answered |
| --- | --- | --- |
| Test Explorer, "ABAP Unit (osd)": one item per `*.clas.testclasses.abap`, its test classes and methods resolved when expanded | `GET /sap/bc/adt/core/http/unit/object?type=CLAS&name=<X>` | `tools/adt-facade.mjs`, `UnitRun.classes()` |
| Run an object, a test class or one method; a failure carries Expected/Actual (the diff view) and the first ABAP frame of its stack as the place | `POST …/unit/object/run?type=&name=&testClass=&method=` (CSRF token and session cookie fetched with `HEAD /sap/bc/adt/core/discovery`, refetched once on a 403) | `UnitRun.runDetached()`, a child with its own database |
| Status bar: the generation served, hot swaps, the number of short dumps (red when it grows); "osd down" when nothing answers | `GET /osd/serving`, `GET /osd/dumps` every 5 s | `tools/osd-serve.mjs` |
| `osd: Show short dumps` (also a click on the status bar) | `GET /osd/dumps` | `tools/osd-serve.mjs` |

The two `/osd/*` doors are implemented by the child that runs the ABAP, and
under `npm start` the parent used to forward only `/sap/bc/*` and
`/sap/opu/odata/sap/*`, so they answered 404 on the port a client knows.
`test/start.mjs` now forwards every HOST node `src/icf/nodes.json` declares
for `tools/osd-serve.mjs` (#95).

`osd: Prepare abapGit zip…` (Command Palette and OSD view overflow) picks a deploy unit from the checkout’s `deploy/manifest.json`, preferring the active file’s source unit, and saves its offline zip under `build/deploy/` by default. It runs the checkout’s zip tool with the extension host’s own Node (`process.execPath`, as Start does), logs to **osd**, preserves object-naming refusals, and offers Reveal in Explorer or Copy path on success. A checkout is required; units without sources must be prepared separately. Import the zip with abapGit; delivery to a system is not part of this command.

## Layer version requirements

A pack or workspace layer can require a minimum system version with
`"osd": ">=0.6.1650"` in `osd-pack.json`. Only `>=x.y.z` is supported;
omitting `osd` means no requirement. Versions compare numerically, and an
invalid requirement refuses the build. The check runs before generation or
transpilation, including cached and warm builds.

Packaged systems carry `osd-version.json`, stamped with the extension version;
seeded binaries use the same version rule. A source checkout without that
marker, including a checkout-mode binary, skips the comparison and logs a
debug line. A mismatch leaves the live generation untouched and tells you to
update the extension or binary. In desktop VS Code, the error notification
shows the diagnostic verbatim; **Update** opens the installed extension's
entry in the Extensions view.

## Key bindings

*2026-09-25.* `osd.keymap` (default `"abap"`) puts an ABAP developer's
fingers where SAP GUI / ADT (Eclipse) put them, over an `.abap` editor; set
it to `"vscode"` to get VS Code's own bindings back everywhere -- every row
below carries `when: config.osd.keymap == abap`, so the setting is the only
place this is decided. Scoped by `resourceExtname == .abap` rather than a
language id: abaplint is an extension this repo does not install or
control, so which language id it registers (if any) is not something a
`when` clause here can depend on. F8 alone widens that to a `resourceFilename
=~ /regex/` match (`resourceExtname` is only ever the last extension, and a
TABL's own file is `<table>.tabl.xml`, a DDLS's `<view>.ddls.asddls` or
`.ddls.xml`) -- Ctrl+F2/Ctrl+F3/F9 stay `.abap`-only, since Check/Activate/
Classrun do not reach either type (Q7, below).

| Key | SAP GUI / ADT | Here | Gap |
| --- | --- | --- | --- |
| Ctrl+F2 | Check | `osd.check` -- the current buffer (not necessarily saved) against `checkruns` (`tools/adt-facade.mjs` ~1683-1727), diagnostics on the lines | -- |
| Ctrl+F3 | Activate | `osd.activate` -- saves the file, then `activation` (~1835-1924); a failure's issues go to Problems, a pass shows the generation that now serves it (`X-OSD-Generation`) | -- |
| Ctrl+Shift+F3 | Activate all inactive | -- | **left out**: `GET .../activation/inactiveobjects` always answers an empty list by design (`tools/adt-facade.mjs`, "nothing here is ever inactive: an object is what the file says") -- there is no inactive set on the server for this to activate |
| F8 | Run | `osd.run` -- dispatched by object type (`lib.js` `RUN_TABLE` / `runActionFor`, SE80's own dispatch, table below); runs objects independently of ABAP Unit | see the table below |
| F9 | Run as ABAP Application (Console) | `osd.classrun` -- the current class against `oo/classrun` (Q6b, below), output in its own Output channel "OSD: Console" | -- |
| Ctrl+Shift+F10 | Run ABAP Unit | the built-in `testing.runCurrentFile`, also used by the beaker title button | -- |
| F5 / F6 / F7 / F8, while execution is paused | Step Into / Step Over / Return / Continue | the built-in `workbench.action.debug.step{Into,Over,Out}` / `.continue`, remapped only `when debugState == 'stopped' && resourceExtname == .abap`, so an attached but running session leaves F8 and F9 available to run ABAP objects | -- |
| Ctrl+Shift+B | Toggle breakpoint | the built-in `editor.debug.action.toggleBreakpoint` | -- |
| F1 on a keyword | ABAP keyword documentation | -- | **left out**: ADT resolves a keyword to its help.sap.com page through its own shipped keyword-to-file index; a guessed URL (`abap` + the word + `.htm`) is wrong for enough keywords that a dead link is worse than no binding |

F8's dispatch by object type (`lib.js` `runActionFor`, held to this table by
`test/vscode-extension.mjs` without a server):

| Type | F8 here |
| --- | --- |
| CLAS, declares `IF_OO_ADT_CLASSRUN` | classrun (Q6b, below), regardless of tests or class name |
| CLAS, without classrun, name ends `_DPC_EXT`, cursor inside a `<set>_get_entityset` / `<set>_get_entity` method | calls the set, the same as that method's CodeLens (Q2b, below) |
| CLAS, without classrun, name ends `_DPC_EXT` / `_MPC_EXT`, otherwise | not yet: the rest of a Gateway client |
| CLAS, otherwise (with or without tests) | information message: “Nothing to run for <OBJ>. Tests: Ctrl+Shift+F10.” |
| INTF | nothing of its own to run |
| PROG | F8: asks for the report's arguments, then builds it with osabap and runs it in a terminal of its own (`osd run`, `docs/osabap-native.md`; needs a checkout and Go); empty arguments open its selection screen in the terminal. Run with debugger: opens its converted report's WebGUI transaction in a reusable VS Code panel (see `docs/gui-reports.md`), as the CodeLens above REPORT does |
| FUGR | not yet: a test form from `GET /sap/bc/osd/rfc/functions/<NAME>`, then `POST /call` |
| TABL, DDLS | data preview (Q7, below) |
| IWSV | not yet: the Gateway client on the service document |
| SICF | not yet: open the node's URL |

F8 / ▷ / F9 never run ABAP Unit. Run tests with Ctrl+Shift+F10, the
beaker button, or Test Explorer.

## Test Explorer groups

Open regression: [an `osg-demo` folder used as the workspace-layer root
shows 0/0 tests](open-issues/osg-demo-test-explorer.md). The two known test
classes contain `FOR TESTING`, but `classifyTestPath` rejects the empty
layer-relative prefix. This is an extension issue, not a demo pull issue.

*2026-09-26.* Before this, "ABAP Unit (osd)" was one flat list: every
`*.clas.testclasses.abap` `findFiles()` turned up became a sibling, so a
project class sat next to `CL_ABAP_*` and `/UI2/CL_JSON` from
`open-abap-core` under `.local/lars/` -- and any workspace that opened a lib
clone as its own root, or a lib file the exclude glob missed, mixed the two
sets with nothing to tell them apart. Now the tree has four top-level
groups, decided per file by `lib.js`'s `classifyTestPath()`, the pure half
(`test/vscode-extension.mjs` holds it to real paths of this tree):

| Group | What is in it | Sub-node |
| --- | --- | --- |
| **Project** | `src/`, `test/`, `gen/` -- `abap_transpile.json`'s own `input_folder`, minus any that is also a lib's own folder | none of its own (Project lists straight, or by package once it clears the threshold below) |
| **Packs** | `packs/<name>/**` | one per pack, always |
| **Workspace layers** | a running B0 launcher's own `layers` (`launcher.js` `detectWorkspaceLayers`) -- shown only while one is known | one per layer |
| **System** | `abap_transpile.json`'s own `libs` (`.local/lars/open-abap-core`, `abapgit`, `express-icf-shim`, `open-abap-apc`, `open-abap-gui`, `open-abap-odata`, `ajson`) | one per lib, always; collapsed by default the way any Test Explorer node with unexpanded children already is |

`classifyTestPath()` is checked in that order for a reason: a workspace
layer can sit anywhere on disk, even inside what would otherwise read as a
lib's own folder, so it wins first. `osd.tests.showSystem` (default `true`)
turns System off (and skips scanning those folders at all) for a session
that only wants its own tests.

Once a group's own bucket (Project as a whole; one pack; one lib; one
workspace layer) clears `PACKAGE_SPLIT_THRESHOLD` (15) classes, `lib.js`'s
`packageOf()` sub-groups it further by the directory under `src/`/`test/`/
`gen/` that carries the file (an abapGit `package.xml`, when
`packageDirsFrom()` is handed any, wins over that guess -- none of this
repo's own corpus has one today, so the fallback is what runs in practice:
`open-abap-core`'s 62 test classes split into `rtti`, `http`, `json`,
`oauth2`, ... rather than 62 flat siblings under System).

`objectOf`/`fileOf`/`discover()`/`run()` below the object level are
unchanged, and so are an object's, a class's and a method's own ids -- only
where in the tree an object sits moved, so a run's history still matches it
by id. The cheap filter that was always implicit (a class without test
methods has nothing to run, `discover()`'s own
`(c.methods ?? []).length > 0`) now also runs before an item is even built:
`hasTestMethods()` skips a `*.clas.testclasses.abap` with no `FOR TESTING`
anywhere in it, rather than adding an item only to find it empty once
expanded. Running a group, a pack, a lib or a workspace layer runs every
object under it, the way the Testing API does by default for any parent
handed to a run profile -- there is no special "run this group" code beyond
expanding it to the objects it holds.

## Running tests: by RISK LEVEL

*2026-09-28.* A run used to go one object at a time, and Cancel did not
reach the object in flight: an ordinary run passed no abort signal, so the
child it had started ran to its end. Now the signal goes with every request
(the façade kills the child when the request aborts), and the objects run
by what their test classes declare:

- **HARMLESS** objects run in parallel, `min(4, cpus - 1)` at a time
  (`lib.js` `unitPoolSize`), longest `DURATION` first. Each is its own child
  process with its own throwaway database, so they cannot see each other's
  rows.
- **DANGEROUS** and **CRITICAL** objects run after them, one at a time,
  also longest first. So does an object with a class that declares no
  `RISK LEVEL` at all: ADT reports that as harmless, and a scheduler that
  believed it would run unknown tests side by side.
- An object's own selections keep the order they were asked in, and an
  object's risk is its riskiest class that runs.
- With a shared database for tests (`osd.database.tests` = HANA or
  PostgreSQL), every object runs one at a time. Every child uses the one
  schema there, and even a HARMLESS one writes while it boots: the
  cross-reference and the pack rows are reseeded. So two at once would
  delete each other's rows. The spec allowed HARMLESS in parallel there
  ("reads only"); the boot is why it does not. This is the extension's
  rule: the façade still accepts runs at once from other clients.
- A debug run stays one at a time: one debugger, one child.

**The declaration is checked, not trusted** (`tools/osd-unit-risk.mjs`).
The method call graph starts at the object's test and lifecycle methods.
Only reachable method bodies contribute database writes; type declarations
and unused methods do not. Interface and virtual calls use implementations
instantiated by reachable code, including reachable factories. The warning
shows a concrete source path and the count of reachable write statements.
Dynamic or unresolved receivers produce a separate "may reach a database
write" warning instead of a confirmed write. Both confirmed writes and
uncertainty schedule HARMLESS objects serially. See [unit-risk.md](unit-risk.md)
for the fallback policy, limitations and the fleet fixture's red proof.

**And guarded at runtime** (`tools/osd-unit.mjs`, the first consumer of the
database hooks in `tools/osd-dialog-step.mjs`, docs/ideas.md B17). A class
scheduled as HARMLESS runs with its writes failing, from `class_setup` to
`class_teardown`: `RISK LEVEL HARMLESS but wrote to <table>`, an alert of
kind `riskLevel`. The failure is a JavaScript error, not an ABAP exception,
so a `CATCH` in the test does not swallow it. A class the static check
already flagged is not guarded: it runs alone, and failing it for a write
the warning already names would fail it twice.

What the guard sees: Open SQL's insert, update and delete, and a data
statement (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT`, `REPLACE`,
`TRUNCATE`) sent through the client's `execute`, `native`, `write` or
`modifying`, which is how SQLScript and AMDP bodies write. It counts only a
table the DDIC knows, and never DDL, so a client's own scratch relations
(DuckDB's views for an AMDP read) are not a test's write. What it does not
see: a secondary `CONNECTION`, which is not hooked. The static check does
not read AMDP bodies either, so a HARMLESS test calling a writing AMDP is
caught only by the guard.

Where it applies: the Test Explorer's run route
(`core/http/unit/object/run`). The Eclipse `testruns` route runs one object
at a time and is not guarded. The schedules and warnings are what
discovery said when an object was last expanded or run, or since the tree
was rebuilt. An edit to production code a test reaches does not refresh
them until then; the runtime guard always runs on the current code.

What a system does, and what this adds: a system's client setting
(`SAUNIT_CLIENT_SETUP`) says which risk levels may run in that client and
refuses the rest; it does not look at what a test does. Mirrored here:
the levels, the durations, and running a class by its level. Added: the
static check, the runtime guard, and "undeclared is DANGEROUS" for the
scheduling (ADT still reports it as harmless).

Measured on this tree (4 CPUs, 23 objects, a real server, 2026-09-28),
two runs:
- first run: one at a time 76.7 s, a pool of 2 60.6 s, a pool of 4 54.2 s;
- second run, after the fixes: one at a time 70.6 s, a pool of 3 (the
  default on 4 CPUs) 57.4 s.

The outcomes of every object were identical in all of them. The gain is
bounded by the DANGEROUS half, which runs alone: 14 objects, about 50 s of
the first serial run's 77. The 9 HARMLESS objects took 27 s one at a time
and 8.6 s in a pool of 4 on their own.

`test/osd-child.mjs` runs a mixed set end to end: two HARMLESS objects at
once (counted as requests in flight from the client), the one that writes
alone after them, and the results of a serial run.
`test/vscode-extension.mjs` drives the Run profile over a mixed tree, and
`test/unit-risk.mjs` holds the static check and the guard.

*2026-09-26, same day, as seen with the packaged extension.* Six bugs, all
fixed together:

1/2/6. **Classify a file against its own workspace folder, never osdHome.**
   The packaged install runs the system from a materialized copy of the
   bundled seed under `context.globalStorageUri` (`resolveStartTarget()`), while
   the window's own workspace folder is the checkout a person actually
   opened and edits -- two different trees. `classifyTestPath(root, ...)`
   was always called with `root = activeController?.launcher?.osdHome ??
   osdHomeOf()`, so a project or a packs file `findFiles()` turned up (which
   walks the open workspace, never osdHome) was classified relative to the
   *wrong* tree: `path.relative` climbed out of osdHome and back down into
   the workspace folder, landing on `classifyTestPath`'s own fallback branch
   with a `relInGroup` starting `../../...`. `packageOf()` then read that
   leading `..` as the sub-node's own name -- one node called ".." holding
   every Project class -- and Packs, whose own prefix check can never match
   a path that starts `..`, held nothing at all. The fix reads each found
   file's own root with `vscode.workspace.getWorkspaceFolder(uri)` and reads
   *that* folder's own `abap_transpile.json` (cached per root for the
   build), rather than osdHome's; a lib's own folder and a running
   workspace layer's own folder are already found by an explicit
   `RelativePattern` rooted correctly, so they needed no change. Readers
   (Q3), F8's dispatch (`RUN_TABLE`) and Data Preview (Q7) map a file to an
   object by its own filename alone (`objectOf`/`adtObjectOf`/
   `dataPreviewObjectOf`) and never call `path.relative` against osdHome at
   all, so this bug never reached them -- checked, not assumed.
2. **Packs empty** was the same bug (1), over a `packs/` file.
3. **Only a file the build itself would read is listed.** A path outside
   every one of `classifyTestPath`'s four roots (`deploy/`, a staging folder
   for a system, never one of `input_folder`/`libs`/`packs`) now answers
   `undefined` instead of falling into Project; a path *inside* a root but
   hidden by that root's own `exclude_filter` (the top-level list for a
   Project or a Packs file, the same list `tools/osd-transpile.mjs
   listFiles()` applies to `input_folder`, packs included, once they are
   layered in; the matching lib's own list for a System file, the same list
   `loadLibs()` applies) is excluded the same way -- `test/fixtures/`
   (`test/fixtures/adt-editor/zcl_editor.*`) and a lib's own excluded corner
   (open-abap-core's `/src/tcp/`) both go through this, not the root check.
   `transpileLayers()` now also carries `excludeFilter` (top-level) and each
   lib's own, as `RegExp`s built the same case-insensitive, unanchored way
   the build reads them.
4. **A demo that fails on purpose no longer reddens "Run" on Project.**
   ZOSD_TEST's `deliberate_failure` exists to prove a failure reaches a live
   client, so it must still run and still fail when asked for -- only
   `npm test`'s own build-time run needs to skip it, which
   `abap_transpile.json`'s `options.skip` (`{object, class, method}`) already
   does. `lib.js`'s `demoFailureObjects(config)` reads that same list (no
   second marker to keep in step with it) and, for a Project-group class
   whose name is in it, the Test Explorer puts it under its own
   **Demos (fail on purpose)** sub-node instead of listing it flat.
5. **A PROG's own local test class is found the same way a class's is.**
   abapGit keeps a program's `FOR TESTING` classes inline in its
   `*.prog.abap` (no `.testclasses.abap` split the way a class has), so the
   scan glob widened from `**/*.clas.testclasses.abap` to
   `**/{*.clas.testclasses.abap,*.prog.abap}` (`TEST_FILE_GLOB`, also the
   file watcher's own pattern now); `objectOf`/`hasTestMethods`/
   `classifyTestPath` already worked by suffix and needed no change, and
   neither did `discover()`/`run()`, which already pass the object's own
   `type` (`CLAS` or `PROG`) through to
   `GET/POST .../unit/object[/run]?type=...` -- that route already accepts
   both. `src/zosd_test/src/zosd_test_demo_prog.prog.abap` carries a small
   passing local test class (`ltcl_zosd_test_demo_prog`, over the program's
   own `lcl_counter`) as the worked example. **A function group's `FOR
   TESTING` is a gap, not silently listed**: the same route refuses
   `type=FUGR` with 400 ("cannot carry ABAP Unit tests here",
   `tools/adt-facade.mjs`), so the Test Explorer does not scan for one.

## Q2b: calling an entity set

*2026-09-25.* A CodeLens "▶ Call \<Set\>" over every `METHOD
<set>_get_entityset.` / `METHOD <set>_get_entity.` line of a SEGW `_DPC_EXT`
class's source. The class → service → set mapping is a server route rather
than a build artefact (the smaller of the two ways the class carried this
work): `GET /sap/bc/adt/core/http/segw/entitysets?class=<NAME>`
(`tools/adt-facade.mjs`) answers `{class, service, mpc, sets: [{method,
kind, set}]}` for a class the registry knows as a service's DPC, 404
otherwise -- read fresh off the tree on every call, never guessed from a
file name: the service comes from `segwRegistrations()`
(`tools/segw-registry.mjs`, the project's own IWSV/IWMO), the set's real
name and case from the MPC's own entity-name constants
(`tools/segw-entityset-map.mjs`, the type SEGW gives every one of them,
`ty_e_med_entity_name`, not the constant's own name). A `_DPC_EXT` and its
model's `_MPC_EXT` are read together with their base classes (SEGW puts the
constants and the generated method bodies there, the hand-written overrides
in `_EXT`), the way inheritance actually resolves them.

Clicking a lens does `GET <osd.url>/sap/opu/odata/sap/<service>/<set>?$top=
20&$format=json` for `_get_entityset`, or prompts for a key (defaulted from
the first row's own `__metadata.uri`, `keyOf` in `lib.js`) and does
`<set>(<key>)?$format=json` for `_get_entity`, and shows the answer in a
webview: the URL, the HTTP status, the time and the row count above a table
(the columns are the properties, `__metadata` left out), a "raw JSON"
toggle beside it. F8 does the same when the cursor sits inside one of these
two kinds of method (`lib.js` `methodAtLine` finds which, `RUN_TABLE`'s
`CLAS` entry answers `{kind: "call-entityset", ...}` when it does); every
other `_DPC_EXT` / `_MPC_EXT` case is still the "not yet" of the F8 table
above.

`editors/vscode/lib.js` carries the pure half (`entitySetMethodLines`,
`entitySetLenses`, `methodAtLine`, `resultRows`, `stripMetadata`, `keyOf`,
`Osd#entitySets`, `Osd#odata`); `tools/segw-entityset-map.mjs` carries the
server's own mapping (`entityNameConstantsOf`, `entitySetMethodsOf`,
`entitySetsOf`, `entitySetMapFor`), both tested without VS Code or a server
in `test/vscode-extension.mjs`; the route itself in
`test/adt-devloop.mjs`, beside the other `core/http/*` routes.

## Q3: readers of a class or interface

*2026-09-25.* A CodeLens "read by N · tests M · services K" over a class's
own `CLASS <name> DEFINITION` line or an interface's own `INTERFACE <name>`
line. It is the reverse of Q2b's own class-to-service map: not what a
`_DPC_EXT` calls, but who calls *this* class or interface, off the
cross-reference tables every host already seeds at start
(`tools/osd-xref-seed.mjs`, from the parse) -- the same direction
`tools/osd-xref.mjs --who-calls` reads for a terminal. A
`WBCROSSGT`/`WBCROSSGTX` row is `{OTYPE: 'TY', NAME: the referenced object,
INCLUDE: the referencer}`, and `INCLUDE` already carries the referencing
object's own name, never a per-include suffix (`tools/osd-xref.mjs`
`CrossReference#build`, the `WBCROSSGT` branch), so no include-to-object
mapping is needed to read it back. `GET
/sap/bc/adt/core/http/xref/readers?type=CLAS|INTF&name=<NAME>`
(`tools/adt-facade.mjs`) answers `{name, readers: [{type, name, include,
isTest, services}], counts: {readers, tests, services}}` for a CLAS or INTF
this store knows, 404 otherwise; the class or interface itself and any
self-reference are left out. The rows are read the same way the client's own
data preview reads any table (`data.query`, `tools/osd-data.mjs`) -- this is
a where-used view over the same seeded tables, not a second index. A reader
is marked a test when it carries its own ABAP Unit tests
(`tools/osd-unit-run.mjs` `testClassesIn`) and a service when it is
registered as a service's own `_DPC_EXT` (`tools/segw-registry.mjs`
`segwRegistrations`, read fresh off the tree the way the entitysets route
does); a reader can be neither, either, or both. The `services` count also
includes services registered directly to the class being viewed as DPC, MPC,
or handler. The class itself remains absent from the where-used reader list.

Clicking the lens shows a quick pick of the readers (Test / Service tagged in
the description) and opens the file of the one chosen, by the glob its own
type and name give (`readerFilePattern` in `lib.js`: `**/<base>.<ext>.abap`,
the same namespace-to-`#` mapping `objectOf` reads back) -- a type this
extension has no file shape for (FUGR, TABL, DDLS, ...) opens nothing rather
than guessing. A save anywhere refreshes the lens, since a reference to the
class open in the editor can be added or removed in any other file.

`editors/vscode/lib.js` carries the pure half (`readersLensLine`,
`readersLensTitle`, `readersQuickPickItems`, `readerFilePattern`, `Osd#readers`),
tested without VS Code or a server in `test/vscode-extension.mjs`; the route
itself in `test/adt-devloop.mjs`, beside the other `core/http/*` routes.

## Q4: hotspots

*2026-09-25.* Short dumps are kept in a table the way a system keeps them
for ST22: `ZOSD_DUMP` (`src/dumps/zosd_dump.tabl.xml`, client-dependent,
key `MANDT` + `DUMP_ID`), one row per dump -- the runtime error, the
message, the ABAP position (object type, object name, include, line), the
request (method, path truncated to 120), the generation, and the frames as
a JSON string. Capped at the last `OSD_DUMP_CAP` rows (default 1000, an
env var read once) so a long-lived process does not grow it without bound.

**Writing is a kernel job, not the application's** -- the same rule as the
end of a dialog step (`tools/osd-dialog-step.mjs`, "a rule for what every
host must do lives in a module they all import"): an AS ABAP writes a dump
*after* the LUW has been rolled back, in its own statement and its own
commit, never inside the failed one. `tools/osd-dumps.mjs` (`persistDump`)
is that module; `tools/osd-serve.mjs`'s `dump()` calls it, not awaited, only
after the request's own `dialogStep()` has already rolled back (its catch
runs on a rejected `await`, by which point `exclusive()`'s `finally` has
released the work process) -- `persistDump` commits through a fresh
`dialogStep()` of its own. `test/start.mjs`'s inline front (`MODE ===
"inline"`, `runtime === undefined`) has **no dump hook at all**: its catch
logs to the console and answers 500, with no ring and no `/osd/dumps` --
that door is declared only for `tools/osd-serve.mjs`
(`src/icf/nodes.json`), so there was nothing to wire this into, and it is
left that way on purpose rather than given a second, parallel writer.

`/osd/dumps` keeps its current shape (the in-memory ring of the last 100,
tested by `test/osd-child.mjs` and depended on by the status bar below) --
smaller than teaching it to read the table, and the two are two views of
the same events rather than two sources of truth.

**Reading is the freestyle SQL door Q6a's notebook already uses** -- no new
route. `editors/vscode/lib.js` `HOTSPOTS_SQL` groups `ZOSD_DUMP` by
`(objname, include, line)`, with a correlated subquery for each line's own
last message; `Osd#hotspots()` runs it through `Osd#freestyle()` and
`hotspotsFromRows` turns the answer into `{byLine: [{objname, include,
line, count, lastAt, lastMessage}], byFile: {OBJNAME: count}}` --
normalising every column to lower case first, because `tableDataDocument`
(`tools/adt-facade.mjs`) always writes `dataPreview:name` upper-case
regardless of how the SQL cased it, and a reducer that trusted the SQL's
own case would only fail against the real door, never against a fixture
that happened to agree with it.

In the editor: a `vscode.TextEditorDecorationType` per intensity bucket
(`hotspotBucket`, 1 dump to 4 = ten or more), a translucent red
(`rgba(255, 0, 0, alpha)`, heavier per bucket) laid over whatever the
theme's own background is rather than a colour of its own, so it reads in
both; hovering a coloured line shows `hotspotHoverText` ("N dumps, last
\<ISO time\>: \<message\>"). A `FileDecorationProvider` puts a badge
(`hotspotBadge`, "1".."9", else "9+" -- VS Code keeps at most two
characters of it) on an `.abap` file in the explorer, summed over every
include of the object. Command "osd: Refresh hotspots"
(`osd.refreshHotspots`) re-reads the table and redecorates; so does a timer
(`osd.hotspots.refreshSeconds`, default 30, 0 = off, re-read on a settings
change) and the end of `osd.run` / `osd.activate` (fire-and-forget, so
neither waits on it). The status bar's dump count (Q2, `$(bug) N`) is left
reading `/osd/dumps` as before -- the ring and the table are fed by the
same `dump()`, so the two numbers are already the same kind of count, just
with different caps (100 vs. `OSD_DUMP_CAP`).

`editors/vscode/lib.js` carries the pure half (`HOTSPOTS_SQL`,
`hotspotsFromRows`, `hotspotBucket`, `hotspotColor`, `hotspotBadge`,
`hotspotHoverText`, `Osd#hotspots`), tested without VS Code in
`test/vscode-extension.mjs`, including one round trip through
`tableDataDocument` so the upper-casing above is caught by a fixture built
the way the server actually answers, not typed by hand to agree with the
code under test. The write, the rollback and the read together, against a
real `tools/osd-serve.mjs` (`ServingRuntime`, in-memory database) rather
than a synthetic dump: `test/osd-dumps.mjs`.

**ANORMALIES-worth noting here rather than there** (a one-liner, since the
difference is deliberate and small): unlike SAP's `SNAP`, `ZOSD_DUMP` is
one flat table with no TemSe cluster and no per-user/task columns -- a
short dump here is what `tools/osd-where.mjs` can already say (the ABAP
position and the frames), and this table is exactly that, kept.

Not done: `test/start.mjs`'s inline front writes nothing (see above); OSGo
(the Go runtime) does not write the table at all -- named as a follow-up,
not attempted here.

## Q6a: SQL, ABAP, and SQLScript notebook cells

*2026-09-26.* `*.osdnb` is a small JSON file of SQL, ABAP, SQLScript or
markdown cells
(`editors/vscode/examples/demo.osdnb`): a VS Code
[NotebookSerializer](https://code.visualstudio.com/api/extension-guides/notebook)
for the type `osd-sql-notebook` (`package.json` `contributes.notebooks`,
selector `*.osdnb`), and a `NotebookController` named "osd notebook" that runs a
cell the way ADT's own SQL Pane does: `POST
/sap/bc/adt/datapreview/freestyle?rowNumber=<osd.notebook.rowLimit>` with
the cell's own text as the body (`tools/adt-facade.mjs`, ~2358; `data.query`
underneath is SELECT-only and applies the row limit itself). The answer is
XML, column-oriented (one
`<dataPreview:columns>` per selected column, its own metadata and a
`<dataPreview:data>` per row -- `tableDataDocument`, ~257); a cell's output
is that answer turned into an HTML table (`text/html`, escaped so a value
carrying `<` or `&` renders as text) with a status line "N rows · M ms ·
\<generation\>" (the generation off `X-OSD-Generation`, set on every façade
answer). The HTML table is the only output item because VS Code chooses its
JSON renderer ahead of HTML even when JSON comes second. A `raw JSON`
disclosure in the HTML shows the same rows on demand. A refused statement
(not a SELECT, or a database never built) becomes the cell's error output,
the server's own message unwrapped. Command
"osd: New SQL notebook" and the System → SQL row open a notebook with a
short Markdown introduction, a ready `SELECT * FROM zosd_sys UP TO 10 ROWS`
cell, and a longer Markdown guide below it. `ZOSD_SYS` is part of the base
status schema (`src/status/zosd_sys.tabl.xml`); no optional pack is needed.
The guide explains the read-only Open SQL subset, row limit, table and raw
JSON output, the running system as the data source, and the ABAP and SQLScript
cell types (DX7, `docs/notebook-cells.md`). Opening from a data preview keeps
its requested SQL statement in the middle cell.

The same controller accepts `abap` and `sqlscript` code cells. An ABAP cell's
statements are wrapped as the main method of `ZCL_OSD_NOTEBOOK_CELL`, written
to the persistent `notebook-scratch` pack, activated through
`ObjectStore#publish()` and `completeActivation()`, and run through the
existing classrun path. Its
console text appears under that cell. The façade serializes these runs because
each uses the same class and activation replaces the serving process's loaded
module graph. A failed activation restores the prior scratch source and its
active or inactive ADT state, or removes the first failed cell before the next
launch. The launcher creates the scratch
pack under its ignored extension storage and keeps it in `OSD_PACKS` even when
no workspace layers are configured. `ObjectStore#write(..., "main", {root})` places the new
object in that already-known writable layer; ordinary writes still use the
first writable root.

A `sqlscript` cell posts its body to `/sap/bc/osd/amdp/cell`, the structured
cell interface of the existing `/sap/bc/osd/amdp/` sandbox. The sandbox's
existing `AMDP` destination runs the throwaway SQLScript procedure and returns
rows or the engine's message as JSON. When the system database is HANA, it
uses the configured `HANA_*` connection even if a separate `HXE_*` sandbox
connection is also configured. On SQLite, PostgreSQL, or DuckDB the route
answers with a clear requirement for a HANA system database before attempting
the destination call, even if an unrelated HANA connection is configured.
Plain `sql` cells continue to use the system database through freestyle.
`pAMDP` remains parked.

`editors/vscode/examples/abap-amdp.osdnb` shows both new cell types: an ABAP
`SELECT ... INTO TABLE` and `LOOP` that writes with `out->write`, plus a
SQLScript query.

`editors/vscode/lib.js` carries the pure half (`freestyleRows`,
`freestyleTableHtml`, `freestyleOutputItems`, `htmlEscape`,
`notebookAbapSource`, `amdpCellResult`, `notebookFromJson`, `notebookToJson`,
`Osd#freestyle`), tested without VS Code in `test/vscode-extension.mjs`.
The SQL and ABAP routes use the façade. The freestyle route is also tested
through a CSRF session in `test/adt-devloop.mjs`, and the ICF-owned AMDP
route is tested through the sandbox suite.

## Q6b: classrun

*2026-09-26.* ADT's own F9, "Run as ABAP Application (Console)":
`POST /sap/bc/adt/oo/classrun/<name>` (`tools/adt-facade.mjs`), advertised
in discovery the way the real system does it -- a plain collection, no
`app:accept`, no compatibility-graph node
(`.local/adt-corpus/latest/bodies/00009-response.xml` /
`00008-response.xml`, the discovery and compatibility captures) --
instantiates a class that declares `INTERFACES if_oo_adt_classrun` and
calls its `MAIN` with a console object of this repo's own,
`ZCL_OSD_CLASSRUN_OUT` (`src/classrun/`), implementing
`IF_OO_ADT_CLASSRUN_OUT` the interface `main` takes. Both interfaces are
open-abap-core's own (`src/classrun/if_oo_adt_classrun*.intf.abap`), an MIT
library `abap_transpile.json` already pulls in whole -- they were not
missing, so nothing here is a clean-room addition of the interfaces
themselves, only of the OUT implementation and the route.

`WRITE` is kept modest: a simple value becomes one line (`name = value`
when a name is given), a structure becomes one `field: value, field: value`
line, and an internal table becomes a header line of column names followed
by one tab-separated line per row (its own line per row for an
elementary-typed table); anything RTTI resolves to neither elem, struct nor
table becomes a line saying WRITE does not format it, rather than dumping.
The answer is always `text/plain`; a dump is still a 200, the way ADT's own
console shows a partial run -- whatever the class had already written, then
`Runtime error: <message> at <ABAP position>`.

Unlike an ABAP Unit run (`tools/osd-unit.mjs`), which spawns a detached
child with its own throwaway database because a test's writes must never
land in the rows the application serves, a classrun **is** a run of the
application: it shares the one live connection every other request runs
against, wrapped the same way -- a dialog step
(`tools/osd-dialog-step.mjs`), commit when the work is done, roll back when
it dumps, the work-process lock in between. A dump is recorded exactly like
a runtime dump (`tools/osd-dumps.mjs` `ZOSD_DUMP`), not swallowed; the
console text already written survives the rollback because it lives in the
OUT object's own memory, not in a row. `tools/osd-classrun.mjs`'s
`ClassRun#run` (asked for through `store.classrun()`, the same lazy pattern
as `store.unit()`) does the work when the façade holds the connection
itself (inline mode, and every test here); when a served (child) runtime
holds it instead (`STG_SERVE=child`, `npm start`'s and `test/run.mjs`'s own
default), the façade forwards through a door of the same shape as the
existing SQL one -- `POST /osd/classrun` on `tools/osd-serve.mjs`
(`src/icf/nodes.json`, `Data#classrun` in `tools/osd-data.mjs`) -- because
that is the process actually holding the connection there. Verified live on
both: inline through the mocha suites below, served (child) mode by hand on
a throwaway port (5, in the PR).

**F9** (`osd.classrun`, its own Output channel "OSD: Console") runs the
current class standalone, and **F8** dispatches to it
(`RUN_TABLE.CLAS`, `ctx.hasClassrun`) for a class that declares the
interface, even when it has ABAP Unit tests. `ctx.hasClassrun` is
`implementsClassrun`
(`editors/vscode/lib.js`), the same regex `tools/osd-classrun.mjs` runs
server-side, over the editor's own buffer (not necessarily saved), the same
way Ctrl+F2's check already reads the unsaved buffer.

ABAP and SQLScript cells are implemented as described above. The scratch
root is a normal pack, discovered at startup like other packs, and notebook
ABAP requests reuse the existing activation and classrun lifecycle.

## Q7: F8 on a table or a CDS view

*2026-09-26.* F8 on a `*.tabl.xml` (a TABL) or a `*.ddls.asddls` / `*.ddls.xml`
(a DDLS) opens a "Data Preview \<NAME\>" webview: rows (capped by
`osd.dataPreview.rowLimit`, default 100, "N rows" or "first N of M" once a
cheap `COUNT(*)` was worth asking for), column headers with the DDIC field's
own label when the façade offers one, a Refresh button and an "Open in SQL
notebook" button that seeds a fresh `*.osdnb` cell (Q6a) with the exact
statement the panel is showing.

Neither type reaches `adtObjectOf` (Check/Activate/Classrun do not apply to
either), so `run()` falls back to `lib.js` `dataPreviewObjectOf` -- a plain
regex over the file's own name, `run()`'s editor buffer and all, the same
"read what is open, not what adtObjectOf knows" split Q6b's classrun already
uses. The name it reads off a DDLS file is the CDS entity's own name (say
`ZC_STG_FLIGHTCUBE`), never its `@AbapCatalog.sqlViewName` (`ZVSTGFLIGHTCUBE`)
-- this client does not need to know that annotation exists. **No new server
route**: F8's rows and labels come from the façade's own `datapreview/ddic`
(a TABL) and `datapreview/cds` (a DDLS) -- the same door ADT's own Data
Preview uses (`tools/adt-facade.mjs`, `lib.js` `Osd#dataPreview`), which
already resolves a DDLS by its CDS name (`tools/adt-cds.mjs` `cdsEntityOf`,
against the twin view `tools/cds2ddic.mjs` writes under that name -- "the CDS
entity itself has no client... as on a system") and already carries each
column's own DDIC label (`tableDataDocument`'s `dataPreview:description`).
The row count, asked for only once the main fetch came back at the cap, goes
through the plain `datapreview/freestyle` door instead (`Osd#freestyle`) --
the one door this feature is told to prefer, and the one already built for
"run this SQL, hand back a number". A DDLS with no database object behind it
(an unsupported join, `tools/cds2ddic.mjs`'s own skip, or a name that does
not exist at all) answers the façade's own message ("DDLS X does not exist",
or the SQL engine's refusal), not a bare 404.

**Client**: `ZSTG_FLIGHTFACT` (and every TABL with a MANDT field, read off
its own DD03P rows in the buffer, `lib.js` `tablHasMandt`) is filtered to the
runtime's own client by default -- `WHERE MANDT = '123'`, `MANDT_CLIENT` in
`lib.js`, the constant CLAUDE.md's "Known traps" already names, not read off
the ADT façade's own identity: that one deliberately answers a different,
made-up client (`tools/osd-identity.mjs`, `identity().adt.client`, `"001"`,
backlog G.1b) so the façade's pretend system is never confused with the data
underneath it, and reading it here would filter for the wrong one. An "all
clients" toggle drops the filter and shows the MANDT column (hidden while
filtered -- every row would carry the same value). A DDLS never gets the
toggle: the CDS-name view has no MANDT column at all
(`tools/cds2ddic.mjs` `viewFieldsOf`), so there is nothing to filter or to
show.

Pure logic (`dataPreviewObjectOf`, `tablHasMandt`, `dataPreviewQuery`,
`dataPreviewCountQuery`, `dataPreviewStatusText`, `dataPreviewRows`), held to
`tableDataDocument`'s real shape the way Q6a's `freestyleRows` already is,
in `test/vscode-extension.mjs`.

## Trying it

No build step and no dependencies: plain CommonJS, VS Code's own Node.

```sh
npm start                                   # in one terminal
code --extensionDevelopmentPath="$PWD/editors/vscode" "$PWD"
```

or, to keep it installed, *Developer: Install Extension from Location…* on
`editors/vscode`. Never `npm install` in that folder: it has nothing to
install.

## Tests

- `test/vscode-extension.mjs`: `editors/vscode/lib.js` without VS Code --
  file name to object and include, include to file, a run's answer per
  method, the frame a failure points at, a check run's diagnostics and an
  activation's result read off the real documents (`tools/adt-documents.mjs`
  `checkReportDocument` / `activationSuccessDocument` /
  `activationFailureDocument`, imported directly rather than re-typed), F8's
  dispatch table, and Q2b's lens placement / cursor-to-method / OData row
  shapes, including one test run against the demo's own DPC_EXT and MPC
  sources through `tools/segw-entityset-map.mjs` end to end; Q6a's
  `freestyleRows` / `freestyleTableHtml` / `htmlEscape` /
  `notebookFromJson` / `notebookToJson`, including a cell value carrying
  `<` and `&`; Q6b's `implementsClassrun` against the tracked demo fixture
  and against a comment merely naming the interface, and `RUN_TABLE.CLAS`'s
  classrun branch (including classes with tests and DPC_EXT classes).
  The Services tree cases cover kind/pack grouping, valid context actions,
  app manifest data-source resolution, HTTP tests by URL, closure test union,
  service dump filtering, safe details HTML, and the services/transaction
  routes against an in-memory `ObjectStore`.
- `test/adt-devloop.mjs`: `core/http/segw/entitysets` against the real demo
  service, beside the other `core/http/*` routes; Q6a's `datapreview/
  freestyle` round trip (a SELECT over the demo data, through the same CSRF
  session the rest of that suite uses); Q6b's `oo/classrun` against the
  tracked demo class (a scalar and a table, formatted), a class that does
  not implement the interface (400), an unknown class (404), discovery, and
  the tracked dumper fixture's rollback-and-record path read back through
  `ZOSD_DUMP` -- all against fixtures already transpiled before this
  suite's `before()` boots, on purpose (see Q6b above).
- `test/osd-child.mjs`: the extension's own client (`Osd`) against a real
  `npm start`, through the parent -- the doors, discovery, one method run
  with the CSRF round trip.
- `test/osd-dumps.mjs`: Q4 -- `objectOf`/`rowOf` (`tools/osd-dumps.mjs`)
  against abapGit file names and `dumpOf()`'s own shape; a real request that
  dumps, against a real `tools/osd-serve.mjs` (`ServingRuntime`), writes one
  `ZOSD_DUMP` row with the right object and line while the rest of its
  changeset is still rolled back, readable through `/osd/sql` and through
  the same `GROUP BY` a hotspot query runs; the cap.

`extension.js` itself (the Testing API wiring) is checked by hand in VS Code
only; there is no `@vscode/test-electron` here, on purpose, since it would
download a VS Code per run.

## B0 spike

*2026-09-26.* Everything above is a client of a system started by hand. B0
(ADR 0003 point 5, `docs/ideas.md`'s B0 row) is the other half: the
extension builds and runs the system itself, so opening a folder and
clicking Start needs no terminal. `editors/vscode/launcher.js` is the
proof, plain Node with no `vscode` import (unit-testable on its own,
`test/vscode-launcher.mjs`), and `extension.js` is the thin VS Code glue
over it (`SystemController`, `OsdTreeProvider`, the ▶/■ status bar item).

**What it spawns is exactly `npm start`'s own two steps**, with
`process.execPath` rather than a `node` on some PATH (VS Code's extension
host already is one): `node tools/osd-build.mjs` (what `npm run transpile`
runs) to completion, then `node test/run.mjs`, waited on by polling `GET
/osd/serving` until it answers `ready: true` with a generation — robust to
the log's own wording, which grepping stdout for "serving generation"
would not be, though the same text is there too (`tools/osd-runtime.mjs`
forwards the child's lines to the parent's stdout, prefixed `[runtime]`,
which is what streams into the extension's Output channel).

**All mutable state lives in the extension's own storage**
(`context.globalStorageUri`, one subdirectory per `osdHome` keyed by a hash
of its path), never in `osdHome`'s tracked files and never in a workspace
folder:
- the database: `STG_DB=file`, `STG_DB_PATH=<storage>/db/osd.sqlite`;
- the TLS directory: a new override, `OSD_TLS_DIR` (`tools/osd-tls.mjs`
  `paths()`), pointed at `<storage>/tls`. It starts empty and the launcher
  never runs `osd:tls`, so there is no certificate to find — which is what
  makes plain HTTP the default. Without this a worktree that shares a
  `.local/tls` with its origin (`tools/osd-worktree.mjs`'s own symlink)
  would have opened one more HTTPS listener outside the 3531-3539 budget
  on every launch (measured: `44300 + port % 100` lands at 44331 for
  3531). `test/start.mjs`'s log line that used to read `TLS_DIR` directly
  now reads `dirOf()` so it still names the right directory when
  `OSD_TLS_DIR` is set.
- the projected packs that add workspace content as a layer
  (below).

**The layer mechanism is the existing one, unchanged: `OSD_PACKS` naming a
container directory of packs** (`tools/osd-packs.mjs`, "a pack is a
directory"). Nothing new was built for this — a pack is found either at
`<root>/packs` or at whatever `OSD_PACKS` names, "a pack itself, or a
container of packs", and the container form is exactly what a launcher that
does not know in advance how many workspace folders there will be needs.
An open workspace folder with `osd-pack.json` is a full pack. The launcher
copies its manifest into `<storage>/packs/<name>/`, filling an omitted `name`
with the workspace folder's name, and projects its
declared paths through directory symlinks (junctions on Windows). Manifest
`name`, `order`, `abap`, `data`, `ddic`, `webapp`, and `tiles` keep their usual
pack meanings. A folder without a manifest still layers ABAP alone when it
has `.abapgit.xml` or a class/program under `src/`; its generated manifest
has order 900+. No workspace source is copied or changed. Layers shows the
ABAP object count, seed table count, DDIC count, page URL, and tile count.

The later layer that names a table in a TABU capture owns all of its rows.
Fresh databases insert only that layer's capture; on an existing database,
startup replaces that table's rows with the same capture, including when it
is empty. Other business tables retain their rows. The generation hash
includes the manifest, seed data, DDIC, ABAP, and webapp bytes, so an edit
to a page or row produces a new generation.
Closing the workspace folder and restarting removes its projected pack, tile,
and page. The persistent database may still contain old rows until its schema
is reset; they are no longer seeded by that pack.
Two distinct packs cannot share a pack name, and webapps whose derived BSP
names collide at the 15-character limit fail the build with both owners named.
Each pack BSP app rebases every OData data source whose URI names a service (`.../opu/odata/sap/<SRV>`) to `../../../../opu/odata/sap/<SRV>/`, relative to the BSP page. Annotation sources and URIs without a service name are carried unchanged.

Shadowing is already said out loud by the build itself
(`osd-build: overridden: CLAS X: <hidden files> hidden by <winner>`,
`tools/osd-build.mjs`), and since the launcher streams the build's stdout
verbatim into the "OSD: System log" Output channel, that line is already
visible there with no extra plumbing. A missing reference (the user's code
calling something the system lacks) is not yet surfaced as an editor
diagnostic in this spike — abaplint's own errors reach the build log the
same way overrides do, but nothing here turns them into
`vscode.Diagnostic`s the way Ctrl+F2's `check` command already does for a
single object; `npm run probe` / `tools/osd-inputs.mjs` exist for a closure
audit by hand and were not wired into the tree view.

**The UI**: an Activity Bar container "OSD" (`views` id `osdTree`) with a
tree of state and launchpad items, **System**, **TRAN**, **Layers**, and
**Services** ("Services tree", below). **System** contains the serving,
dumps, and SQL doors. **TRAN** comes from the transaction registry.
"osd: Open launchpad" opens `http://localhost:<port>/app/flp.html` where
`osd.openIn` says: a tab inside VS Code by default (Q7, 2026-09-27: an
iframe of the running system's own page, one tab per URL, a second click
reveals it), the system browser when the setting is `browser`; the
Launchpad node's inline link-external action and its "Open in External
Browser" context item always use the browser, and "osd: Open launchpad
inside VS Code" (the palette) always a tab. The System overview's
"Open launchpad" / "Open in browser" buttons and the service details'
`$metadata` / "in browser" links take the same two routes. Page tabs close
on Stop and when the system exits unasked (the page is gone); a rebuild,
which is stop-then-start, keeps them and reloads each once the system
serves again, on the new port if it moved; a second, new status bar item
(▶ / ■, left of the existing generation display, which assumes something
is already serving) starts or stops the one `Launcher` this window
drives. The editor-title run button uses `osd.classrun` (F9) for classrun
classes and `osd.runTitle` (F8 dispatch) otherwise; the independent beaker
uses `testing.runCurrentFile` (Ctrl+Shift+F10). These actions are contributed
via `contributes.menus["editor/title"]`. Once started, `osd.url` is written
to the launched address
(Workspace target when the window has a folder, Global otherwise) —
every existing feature reads that setting fresh on every call (`osd()` in
`extension.js`), so nothing else had to change for the rest of the
extension to follow a self-started instance automatically.

When the window has exactly one folder and it is an open-steamgate checkout
(`abap_transpile.json` and `tools/osd-build.mjs` both exist), a packaged
extension with `osd.home` unset asks before the first start: **"Run the system
from this folder? (edits go to your files and git)"**. **Yes** writes that
folder to the workspace's `osd.home` setting and starts it as the system.
**No, use the bundled copy** starts the materialized bundled system and
remembers that choice as the workspace setting `osd.startSource: "bundled"`
(visible in Settings; an answer an older build kept in workspace storage is
moved there on the next Start). **Always ask** uses the bundled copy for this
start and sets `osd.startSource` back to `"ask"`, so the next Start asks
again. **osd: Choose which system Start runs** (the tree's `...` menu and the
state row's context menu) switches at any time: the bundled copy, this
workspace folder, another checkout picked in a folder dialog (it sets
`osd.home`), or "Ask each time"; it offers to restart the system. Dismissing the prompt leaves the system stopped. The pure
decision is `decideStartTarget()` in `editors/vscode/launcher.js`; its tests
cover the checkout, configured-home, remembered-bundle and ordinary-workspace
cases in `test/vscode-launcher.mjs`. The tree's state row and the ▶ / ■ status
bar item show **from workspace** or **bundled copy** after a source is chosen.
Other workspace folders use the packaged bundle as the base. A folder with
`osd-pack.json` layers its full pack; a folder without one can still layer
ABAP source alone. A development
install without a packaged bundle already uses its single workspace folder as
the system and does not offer an unavailable bundle choice.

Launcher failures are classified from the build or server log, with the
error code and message used when no log is available. An
`UNFETCHED` build refusal offers **Fetch packs**, which runs
`node tools/osd-fetch.mjs` in `osdHome` and starts the system again after a
successful fetch. Other build failures offer **Open log** and **Full
rebuild**; the latter runs `tools/osd-build.mjs --force` before starting.
An `EADDRINUSE` failure offers **Pick another port** from the currently
available ports in 3531–3539. The serving status tooltip includes
`/osd/serving`'s `warm.reason` verbatim when `warm.state` is `cold`.

Q6a's scratch pack is created on every launcher start and retained between
starts, even without workspace layers. The launched process receives it in
`OSD_PACKS` alongside any packs inherited from the environment. The façade's
store discovers it before the system starts, so an already-running notebook
can select that writable root without changing `OSD_PACKS` or reconstructing
the store.

## Getting started and System overview

*2026-09-26.* `osd: Getting started` opens the contributed walkthrough in
`editors/vscode/walkthrough/`. Its first step is the one-button quick path;
the remaining Markdown steps cover start/stop, the three places, key
bindings, the Test Explorer and editor tools, and reinstalling a VSIX.
`test/vscode-extension.mjs` checks every walkthrough Markdown reference
against the files in the extension package.

`osd.quickStart` applies the `defaults` entry in `editors/vscode/lib.js`'s
`PRESETS` table, starts the system, then opens **System overview**. If this
window already has a running system, quick start stops it and starts it again
with the preset's database and warm settings. The overview reads the serving
and status routes from the controller's launcher port, independent of a later
change to `osd.url`. The
preset selects SQLite, `osd.keymap = abap`, and `osd.warm = auto`. Auto
sets `OSD_WARM=1` on a host with at least 4 GB of memory, following the
warm compiler's existing memory guidance; otherwise the setting is off.
`/osd/serving` supplies the page's actual database identity, file path,
and warm state. The home resolver uses an explicit `osd.home` first, the
open-steamgate checkout as `osd.home` when that checkout is open (the DX2
rule, implemented locally on this branch), then the packaged bundled copy,
then one workspace folder in a development install.

The top OSD tree row is the overview entry: a click opens the page, while
its stopped/running/building context menus expose the actions for that
state. Stop during a build terminates the launcher's own build child. A
warm rebuild restarts with the ordinary cached build and warm activation
enabled; later supported class/interface activations can swap into the
serving process. Full rebuild passes `--force` to `tools/osd-build.mjs`.
Both actions can also be reached from the OSD view title bar. **Open log**
shows Output → `OSD: System log`.

The page model is pure (`systemOverviewModel` in `lib.js`) and keeps the
route for each set. The extension reads the existing `SystemSet`,
`ProcessSet`, `PortSet`, `ServiceSet`, `PackSet`, and `DatabaseSet` OData
JSON from `ZOSD_STATUS_SRV`, plus `/osd/serving` and launcher state. The
System information app has no JSON route, so the overview iframes its
existing `/sap/bc/osd/sysinfo/` page. `system-overview.js` owns the reusable
HTML components for this overview and a future Services details view; no
server route was needed. The stopped state still renders its selected base,
layers, settings link, and a large Start action without making a server
request.

## Databases

*2026-09-26.* B0 hard-coded `STG_DB=file`. The system already runs on
PostgreSQL, HANA and DuckDB (`test/setup.mjs`, `docs/db-backends.md`) --
this lets the extension pick which one, for the running system and,
separately, for a Test Explorer run.

**Two settings, not one.** `osd.database.system` (`sqlite` | `postgres` |
`hana` | `duckdb`, default `sqlite`) is what `osd.start` runs on.
`osd.database.tests` (`same` | `sqlite` | `postgres` | `hana` | `duckdb`,
default `same`) is what a *test run* uses, when it should be a different
one -- `system=sqlite`, `tests=hana` runs a live Fiori session on SQLite
while the Test Explorer proves the same `_DPC_EXT` against a real HANA, in
one window, with no second window and no second `osd.start`. Connection
settings are plain, non-secret `settings.json`, per kind:
`osd.database.postgres.{host,port,user,database}`,
`osd.database.hana.{host,port,user,schema}`, and
`osd.database.hana.fresh` (`STG_DB_FRESH`, below). Left empty, `host`/
`port`/`user` fall through to the client's own default (`tools/hana-client.mjs`,
`tools/postgres-client.mjs`) exactly as if the launcher were not involved
at all; `database`/`schema` default to a name derived from `osd.home`
(`OSD_<hash>` / `osd_<hash>`, `defaultDedicatedName` in `launcher.js`), so
two windows on two different checkouts never collide in one shared HANA or
PostgreSQL by writing into the same schema by accident.

**A password is never a setting.** "osd: Set database password (HANA)" and
"osd: Set database password (PostgreSQL)" (`vscode.window.showInputBox`
with `password: true`) store it in `context.secrets` -- VS Code's own
SecretStorage, not `settings.json`, not this repository. It is read back
once, right before a launch or a test run, and travels only in that one
process's environment (`HANA_PASSWORD` / `PGPASSWORD`), never in argv --
`ps` on this host never shows it -- and, for a test run, in the JSON body
of the façade request that starts it, never in the query string a server
might log. Clearing the input box (an empty string) deletes the stored
password rather than storing an empty one.

**The env, one function, two callers.** `databaseEnv(config)`
(`editors/vscode/launcher.js`) turns `{kind, host, port, user, database,
schema, password, fresh}` into the `STG_DB`/`HANA_*`/`PG*` env
`test/setup.mjs` reads, and only that -- unset fields leave the matching
var unset. `osd.start` passes its result straight into the spawned
`node test/run.mjs`'s environment, next to `STG_PORT` and the rest
(unchanged for `sqlite`, which still gets `STG_DB_PATH` under this
instance's own storage so a rebuild does not start from nothing; `duckdb`
now gets the same treatment, `<storage>/db/osd.duckdb`). A Test Explorer
run passes the same shape as `dbEnv` in `Osd#run`'s request body
(`editors/vscode/lib.js`), read by `core/http/unit/object/run`
(`unitRunDbEnv` in `tools/adt-facade.mjs`, an explicit allowlist of the env
keys a body may set -- this is the one route in the façade that takes a
body most callers never send, and it must not become a way to set an
arbitrary env var in a spawned child) and handed to
`tools/osd-unit.mjs`'s `runDetached` as `options.dbEnv`.

**The detached run itself needed one change to take a different
database.** `runDetached` always gave its child a throwaway SQLite file of
its own -- the whole point of running detached is that a test's writes
never land in the rows the live system answers from -- and did so
unconditionally, even when the live system itself was already on HANA or
PostgreSQL. `unitChildEnv` (`tools/osd-unit.mjs`) keeps that default
exactly when no `dbEnv` is given, and only when `dbEnv.STG_DB` names
`hana` or `postgres` skips the throwaway file: those two carry their own
isolation (a dedicated schema or database the caller already chose), so
nothing here should be layering a second, pointless one on top. `file` and
`duckdb`, explicit or defaulted, still get the file. Tests:
`test/osd-unit.mjs` (`unitChildEnv`, pure), `test/adt-facade.mjs`
(`unitRunDbEnv`'s allowlist), `test/vscode-extension.mjs` (`Osd#run`'s
body/headers), `test/vscode-launcher.mjs` (`databaseEnv`,
`describeDatabase`, `defaultDedicatedName`, `duckdbAvailable`).

**The stale-schema refusal surfaces, with its own fix.**
`test/setup.mjs`'s HANA and DuckDB (persistent) branches refuse a schema
this build did not stamp rather than silently reusing or dropping it, and
name the fix in the thrown message: "Use a fresh HANA_SCHEMA, or explicitly
recreate it with STG_DB_FRESH=1". That Error reaches the child's stderr
and then a process exit -- never a "serving" answer -- so before this a
person waiting on `osd.start` just saw "osd never answered ready" after
the *full* build timeout, with the actual reason sitting unread in the
Output channel. `Launcher.start()` now races `waitForServing` against the
child's own exit and rejects immediately with the child's stderr tail when
it exits first (`test/vscode-launcher.mjs`, "Launcher surfaces a child
that exits before serving", a fake `test/run.mjs` standing in for the real
one so the test needs no HANA). `SystemController.start()` recognizes
`STG_DB_FRESH` in that message and offers "Set osd.database.hana.fresh and
retry" on the error notification itself, rather than a person having to
know the setting's name.

**Found live, fixed on the way: a kept HANA schema died on its own check.**
Verifying this against a real HANA (HANA Express, reached over the LAN --
the reachability this task's own budget rules meant asking for it at all)
surfaced a bug in code this task did not otherwise touch: `test/setup.mjs`'s
HANA branch called `refuseUnmigratedHana(db, db.schema)` -- `db` itself,
not `{query: (sql) => db.query(sql)}` like the DuckDB branch two lines
above it does it. `refuseUnmigratedHana` destructures `query` off its first
argument and calls it unbound, and `HanaDatabaseClient#query`'s very first
line reads `this.trace`, so **every** connection to an already-built HANA
schema (the ordinary case: a second run, or a second connection within one
run, against a schema `STG_DB_FRESH` did not just drop) died with "Cannot
read properties of undefined (reading 'trace')" before running a single
test. Fixed by matching the DuckDB branch's own pattern; a regression test
(`test/db-migrate.mjs`, "a query method that reads `this`") reproduces the
trap with a plain object shaped the same way as `HanaDatabaseClient`, no
`hdb` or real HANA needed to catch it again.

**Packaging.** `hdb` (HANA) and `@abaplint/database-pg` (which pulls in
`pg`, PostgreSQL) ship in the `.vsix` -- both pure JavaScript, confirmed by
hand (`find node_modules/hdb node_modules/pg* -iname '*.node'` finds
nothing; `hdb`'s only non-JS asset is `lz4-wasm-nodejs`'s `.wasm`, portable
across platforms unlike a native `.node` addon). DuckDB's own native
module (`@duckdb/node-api`) does **not** ship, unchanged from before this
task (it was never on `RUNTIME_ROOTS`) -- `duckdbAvailable(osdHome)`
checks for it before a build is even attempted, so `osd.database.system =
duckdb` (or `tests = duckdb`) in a packaged install answers "DuckDB needs
the native module; not in this package" instead of a build failure nobody
asked for (`test/vscode-vsix.mjs`).

**Status.** The tree's state row and the ▶/■ status bar's tooltip read
`Launcher#databaseLabel` (`describeDatabase`, built from the config alone,
so it never carries a password and is available before any connection is
made) -- "Running on :3611 · SQLite", "· HANA (schema OSD_A1B2C3D4)". The
generation status bar item (the one that answers even for an `osd.url` this
window did not itself start) reads the SERVER's own
`databaseIdentity.engine` off `/osd/serving` instead
(`tools/osd-database-identity.mjs`, pre-existing, a bounded public
vocabulary that never serializes the connection).

## Services tree

The tree root has serving status, the launchpad, **Layers**, a **System**
group for `/osd/serving`, `/osd/dumps`, and `/osd/sql`, a **TRAN** group, and
the service inventory. TRAN rows come from the same transaction registry the
WebGUI uses; report transactions converted into registry entries appear here
alongside hand-declared transactions. Entries the registry marks non-runnable
stay visible with their reason. A single click on a runnable TRAN leaf runs it
in Easy Access. A non-runnable TRAN leaf shows its code,
text, kind (report, dialog, OO, or parameter transaction), starting program,
class, or referenced transaction code, and package/layer in the reused details
panel. **Go to program** opens
the ABAP source only when that file exists. If a TRAN has children, its first
click shows details and a second click within 400 ms runs it. The inline
**Run** button and context-menu **Run** remain direct actions. Non-runnable
rows offer no Run action.

Leaf rows act on one click: source leaves open files, URL leaves open pages,
and the SQL door opens its notebook. Expandable rows show details on one
click and use the 400 ms second-click classifier for navigation. Inline
buttons and context-menu commands act immediately. A page-opening leaf's
tooltip says where a click goes (it follows `osd.openIn`). "Reveal the same
tab" below is the default; with `osd.openIn: browser` a second click opens
the browser again. Easy Access transactions (Run) keep their own
`osdWebgui` tabs and are not part of this rule.

| Node kind | Single click | Second click within 400 ms |
| --- | --- | --- |
| Stopped/running/building state | System overview | System overview |
| Launchpad leaf | Open Launchpad using `osd.openIn` (a VS Code tab by default) | Reveal the same tab |
| System group | Group explanation | No additional action |
| Serving `/osd/serving` leaf | Open endpoint using `osd.openIn` (a VS Code tab by default) | Reveal the same tab |
| Short dumps `/osd/dumps` leaf | List dumps in Output | List again |
| SQL `/osd/sql` | Open the SQL notebook and its guide | Another notebook if clicked again |
| TRAN group | Group explanation | No additional action |
| Runnable TRAN leaf | Run in Easy Access | Run again |
| Expandable runnable TRAN | Transaction details | Run in Easy Access |
| Non-runnable TRAN leaf | Transaction details and reason | No run |
| Layers group, base layer, workspace layer | Layer explanation | No additional action |
| Services root, kind group, layer group | Group explanation | No additional action |
| Expandable APP, OData, ICF service row | Service details | Open service or app using `osd.openIn` |
| APP, OData or ICF leaf with a URL (no children) | Open app or service using `osd.openIn` (a VS Code tab by default) | Reveal the same tab |
| APC service row | Service details | No page to open |
| Service class (DPC, MPC, handler, generated helper) leaf | Open source file | Open again |
| OData entity set leaf | Open DPC method | Open again |
| Empty/start-system placeholder | Why this group is empty | No additional action |

Service rows show their technical name first, with the description in grey and
the path in the tooltip. Four view title buttons toggle name/description
labels, cycle sorting by name/path/description, toggle grouping by kind/layer,
and show or hide base services. They persist separately in the workspace's
`workspaceState`. Defaults are name labels, name sorting, kind grouping, and
base visible. Layer grouping shows **base**, each **workspace <folder>**, and
each named pack; each layer then contains OData, Apps, ICF, and APC groups.
The status inventory's Pack column identifies a service's layer; a workspace
pack is shown by its source folder name. Two registrations of the same OData
endpoint resolve to one row, with the later registration winning.
A single click on an expandable APP, OData, ICF, or APC
row updates one reused **Service details** webview. A service leaf with a URL
opens that URL directly. The panel is disposed when closed and
does not retain its hidden context. Its sections are specific to each row:

- **OData:** DPC and MPC source links, lazily loaded entity sets, `$metadata`,
  and a source card. The model section opens `DEFINE` in the MPC and MPC_EXT,
  the MPC annotation class when generated, the `.stg.yaml` and IWPR when
  present. Each entity set lists DPC_EXT operation implementations and opens
  the exact `METHOD` line. Shared interface methods appear under a set only
  when their body names that set; methods naming no set appear once as
  **generic (all sets)**. Operations without an override read **inherited
  (generic)** and have no source link. Media sets include stream operations;
  function imports have their own group with `EXECUTE_ACTION`. SADL sets link
  to the CDS definition and generated source class when present; value-help
  sets link to their search-help XML. The card also opens `$metadata`.
  Source links appear when their files exist in `src/`, `gen/`, or `packs/`.
  reader and xref closure counts for each class, closure test classes labelled
  **ABAP Unit by reference**, matching files under `test/` and `test/e2e`
  labelled **HTTP tests by URL**, generation and `/osd/serving` warm state,
  and `/osd/dumps` entries whose frames name the DPC or MPC.
  VS Code forwards the `$metadata` link through `asExternalUri` for remote
  workspaces.
- **App:** manifest id, title, first inbound intent, folder, and each
  `sap.app.dataSources` URI resolved to a service row (for example, “uses
  ZSTG_DEMO_SRV”).
- **ICF/APC:** path, handler and handler source, the SICF/SAPC declaration
  source, and HTTP or WebSocket protocol.

The inline **▶ Open** action follows `osd.openIn` (`vscode`, the default, or
`browser`); the inline link-external action beside it always opens the
system browser. The context menu has **Open in External Browser**, **Open
$metadata** (following `osd.openIn`), **Open $metadata in External
Browser**, **Test** (runs the
ABAP Unit classes found in the handler/DPC/MPC xref closures), **Source**
(only source files or folders that exist), and **Copy** (only available URL,
WebSocket URL, and `$metadata` URL targets). A row's context value is updated
when its group is expanded, before the row is first shown, using existing
source paths and closure tests. Selecting it refreshes those targets with the
rest of its details. Missing source or test targets produce no menu action.
APC rows have no page-open action.

The service inventory comes from `GET /sap/bc/adt/core/http/services`, with
the status service's `ServiceSet` as a fallback for older systems; class
source paths and generated service helpers are returned with the rows. An
OData row expands to its DPC, MPC, MPC annotation, and available SEGW, search
help, and function module registry helpers; an app may expand to its BSP
registry helper. Generated helpers are children of their service. Its entity
sets are requested lazily from
`GET /sap/bc/adt/core/http/segw/entitysets?class=<DPC>`.
ICF and APC rows expand to their handler. `GET
/sap/bc/adt/core/http/transactions` reads all declared and generated
`*.tran.xml` entries, including report wrappers, with relative declaration
paths and the TSTCP parameter field used to identify parameter transactions.

Pure view logic lives in `editors/vscode/lib.js` and is held without VS Code
or a live server by `test/vscode-extension.mjs`: service normalization,
kind/layer grouping, sorting, deduplication, TRAN click classification and details, target-specific context actions, manifest data-source
resolution, HTTP test matching, closure test union, dump filtering, method-line
resolution, service-card links, and the details HTML renderer. It also checks the services and transaction routes
against a real in-memory `ObjectStore`. `extension.js` owns the webview and
tree commands.

**Tests**: `test/vscode-launcher.mjs` (registered in `test/suites.d/*.json`) —
pure: `pickPort`/`isFree` over the 3531-3539 range and its exhaustion,
`classify(logText)` against the builder's `UNFETCHED` refusal, a transpile
failure, and Node's `EADDRINUSE` line,
`detectWorkspaceLayers`/`looksLikeAbapGitFolder` (`.abapgit.xml`, `src/
*.clas.abap`, `src/*.prog.abap`, a `src/` with only XML is not a layer, a
folder that does not exist is skipped), `packNameOf`'s stability,
`ensureWorkspacePacks` read back through `tools/osd-packs.mjs`'s own
`packAt`/`packsOf` (a real symlink, nothing written into the workspace
folder, a stale layer removed on the next call), `waitForServing`/
`servingOnce` against a fake HTTP server (resolves once ready, times out
when nothing ever answers), `terminate()` against a real spawned child.
Then two real, unmocked runs of `Launcher` against this checkout on a free
port in 3531-3539 with a temp storage directory: a full start (build,
serve, one OData read of `ZSTG_DEMO_SRV/TravelSet`, `/osd/serving`, then
`stop()` and a check that the spawned pid is actually gone) and a build
that is made to fail (`osdHome` pointed at an empty temp directory), which
must leave the state back at `"stopped"` rather than half-started. An earlier
recorded run beside its neighbours
(`STG_PORT=3538 npx mocha test/vscode-extension.mjs test/adt-devloop.mjs
test/osd-dumps.mjs test/vscode-launcher.mjs`) produced 130 passing before
the Services tree additions; the launcher's own range (3531-3539) and its
neighbours' dynamically-assigned ports do not overlap.

**Live smoke** (`.local/b0-demo-ws/`, gitignored, one abapGit-shaped class,
`ZCL_B0_HELLO IMPLEMENTS IF_OO_ADT_CLASSRUN`): the launcher, given that
folder as a workspace folder, built 1728 objects where the tree alone
builds 1727 — the one extra being the workspace layer's own class — and
`POST /sap/bc/adt/oo/classrun/ZCL_B0_HELLO` (after the same CSRF round
trip every other write in this extension already does) answered `hello
from the B0 workspace layer`. Cold start to `ready: true` measured at
~19.2 s on this machine (build ~12-13 s of it); a build the generation
cache already has (unchanged code, `test/vscode-launcher.mjs`'s own second
run of the same tree) came back at ~4.3 s. Stopping left neither the
spawned `node test/run.mjs` nor its `tools/osd-serve.mjs` grandchild
running, and opened no port outside 3531-3539 (confirmed with `ss -ltnp`
before and after) — `tools/osd-runtime.mjs`'s own SIGTERM/SIGINT/SIGHUP
handler reaps the grandchild before the parent exits, so the launcher only
ever signals the one pid it spawned.

## Packaging

**T2 prebuilt generation (2026-09-27).** `npm run vsix` now runs the seed's
own `tools/osd-build.mjs` inside the staged seed and ships
`build/by-input/<hash>/` and `gen/` as real files (no `build/live`, no
`output`, no generation `test` link: the first build makes those). The
portable-hash obstacle described below does not arise there: inside the
staged seed the transpiler is a plain copy in the seed's `node_modules`,
so `describeBuild()` says "published" with no path or git state, and the
hash reads paths relative to the tree.

One engine change was needed for a real first start to hit it. The
launcher always sets `OSD_PACKS` to its own storage, holding an empty
`notebook-scratch` pack, and that pack's manifest path, different on every
machine, named the generation: a copy materialized from the prebuilt seed
and started the launcher's way built cold (`built 11cf1308…`, measured).
Now a pack that brings nothing (no input file in its ABAP folders, no
data, ddic or webapp folder, no tiles) is not an input, and an input
folder that contributes no file to the hash does not name the generation
(`tools/osd-build.mjs` `inputsOf`, `hashOf`): an ABAP folder with no file
`NOT_AN_INPUT` leaves, or any other input folder with no file at all. A
pack that holds anything still is an input, so a workspace pack builds
cold as before. A tree with such a folder, or with a pack that brings
nothing, names its generation differently once; any other tree keeps its
names.

The generation's `manifest.json` in the seed has `builtAt` and `ms` fixed,
so the same tree packaged twice makes the same seed ID (the materialized
copy is keyed by it).

Measured on a cloud container (Node 22.22) with a throwaway script that
does what the launcher does (materialize, `OSD_PACKS` from
`ensureWorkspacePacks(storage, [])`, `tools/osd-build.mjs`, then
`test/run.mjs` until `ZSTG_DEMO_SRV/TravelSet` answers), default Zork
package:

| | materialize | build | serve | first start |
| --- | ---: | ---: | ---: | ---: |
| `OSD_VSIX_PREBUILT=0` | 1.9 s | 21.7 s (built) | 11.4 s | 35.0 s |
| prebuilt (default) | 1.5 s | 0.35 s (reused) | 12.0 s | 13.8 s |

`.vsix` 9.4 MB -> 11.9 MB at the default Brotli quality; unpacked, the
prebuilt `build/` and `gen/` add 52 MB to each materialized copy (and to
each saved snapshot of an old one). The ~4 s target was the build step
alone; what remains of a first start is the first boot filling the
database (demo data, the taxi facts), which a second start of the same copy
does not pay.

The generation's cross-reference rows ship with it too
(`build/xref/<key>.json`, `tools/osd-xref-seed.mjs`), written in the seed
after its build, so the first start seeds CROSS, WBCROSSGT, WBCROSSGTX and
D010INC from the file instead of parsing the tree. The key is portable for
the same reason the generation's name is (tree-relative paths and contents);
the vsix test checks a copy materialized elsewhere computes it. Measured on
one package, the launcher's way, with and without the file in the copy:
the cross-reference step 5069 ms -> 110 ms, and the serving child's start
to the first `TravelSet` answer (the "serve" column above, in a separate
run) 10.0 s -> 5.0 s (measured 2026-09-27). The file is ~0.3 MB
unpacked, inside the 52 MB above.

`OSD_VSIX_PREBUILT=0` packages without it; the vsix tests
that only look at the archive's shape set it. The binary does not
prebuild: it names generations by its own bytes (`generatorIdentity`), so
a shipped generation could never be reused there.

**T3 solid seed (2026-09-27).** The package now contains one
`extension/osd/seed.tar.br` and `extension/osd/.seed-id` instead of separate
seed files in the VSIX ZIP. The tar code in `launcher.js` writes regular files and directories
with PAX paths for long names and their Unix modes. On first start the
launcher streams Brotli decompression and tar extraction into the keyed
`osd-home-<seedId>` directory, checks the unpacked tree's content ID, then
writes its marker. An incomplete or mismatched extraction is removed. Existing
homes are reused and older edited homes are kept as before. The ID covers
paths, file bytes, and mode bits after seed symlinks have been materialized.

Brotli is used for every package. The extension declares VS Code `^1.101.0`;
[VS Code 1.101 release notes](https://code.visualstudio.com/updates/v1_101)
say that release ships Electron 35 with Node 22.15.1. [Node's zlib
documentation](https://nodejs.org/download/release/v22.15.0/docs/api/zlib.html)
shows that `zstdDecompress` was added in 22.15.0, so the minimum VS Code
runtime does have it, though it is experimental. T3 uses Brotli as the
preferred stable format. The seed includes no `output/`.
Its 23 preexisting `.map` files were all under `node_modules/` and are omitted
now. Q1/DX5 ABAP debugger maps are made with the first transpile under
`output/` and remain available in the materialized home.

On this machine, the default Zork package measured 17.7 MiB before T3 and
8.0 MiB after T3 (a 9.7 MiB reduction). The unpacked seed is 65.4 MiB.
The first-start unpack time and end-to-end packaging test results are recorded
in `REPORT.md` for this change.

*2026-09-26.* One universal `.vsix` that carries the system inside it:
`npm run vsix` (`scripts/build-vsix.mjs`) writes
`build/vsix/open-steamgate-<version>.vsix`, built with the system `zip` CLI --
not `vsce` -- as a plain zip of `[Content_Types].xml`, `extension.vsixmanifest`
(both generated from `editors/vscode/package.json` the way `vsce` does,
`Identity`/`DisplayName`/`Engine`/`ExtensionKind` read straight off it) and
an `extension/` folder holding the extension's own files plus the compressed
system seed at `extension/osd/seed.tar.br`.

Build it from a fresh checkout with Node 22.18+ or Node 24 (the repository's
`.nvmrc` selects 24):

```sh
npm install
node tools/osd-libs.mjs
node tools/osd-fetch.mjs zork
npm run vsix
```

`npm run bootstrap` remains the full checkout setup: it fetches every pack and
generates `gen/`. `npm run test:bootstrap-scratch` exercises that full path in
a temporary clone outside the checkout and removes the clone afterward.

Bootstrap reads `libs.lock.json` for the pinned library repositories and
commits, fetches the packs named by their manifests, then runs the transpile to
create `gen/`. On a workstation, `node tools/osd-libs.mjs --sync` materialises
each commit at `.local/pins/<folder>@<sha>` and points `.local/lars/<folder>`
there. An existing real clone moves to `.local/dev/<folder>`; if that destination
already exists, sync refuses and leaves both directories alone. A folder there
that is not a clone of its own (`git rev-parse --show-toplevel` is not the
folder) is moved as is, with a log line, and its dirty check is skipped, since
git would otherwise answer for the enclosing repository. Pins are standalone
checkouts; a pin made earlier as a `git worktree` of a clone is re-attached
(`git worktree repair`) when sync moves that clone, and on a re-run if an
earlier sync stopped in between. Pins are read-only by convention, not by
file mode: sync gives every pin directory owner write access again, because a
555 directory copied with `fs.cpSync` (a local `build-vsix`) stays 555 and the
copy fails with EACCES. The gate (clean checkout at the locked commit) is what
keeps a pin unchanged. Edit the development clone and use
`OSD_LIB_<FOLDER>=<path>` to select it explicitly. The override is printed
when used. On Windows, sync creates junctions; if the OS refuses a link,
enable Developer Mode or run an elevated terminal.

A `.local/lars` that worktrees share (a symlink to another checkout's) is
migrated once per machine with `node tools/osd-libs.mjs --sync --shared`:
plain `--sync` refuses it, and `--shared` also refuses a clone with
uncommitted changes, so commit held changes to a branch inside the clone
first (it moves to `.local/dev` with that branch). Run it from any
up-to-date checkout whose `.local/lars` resolves to the shared folder: the
lock comes from that checkout, while the clones, `.local/pins` and
`.local/dev` all sit next to the folder its `.local/lars` resolves to. So a
main checkout parked on an old branch without `libs.lock.json` is migrated
from a fresh `origin/main` worktree with `.local/lars` linked to it. A
folder there that is not a git clone is moved to `.local/dev` by the run
itself, with a log line. Afterwards
`node tools/osd-libs.mjs --status` lists every library as ready.

CI keeps real clones under
`.local/lars` so its build artefact and restore paths stay the same. A pin moves
only in a pin PR that also carries its licence approval; `node tools/osd-libs.mjs`
and `test/bootstrap.mjs` check that approval against
`docker/image/license-assumptions.mjs`, which nothing on the runtime path imports.

The pin gate (`tools/osd-lib-path.mjs`: each library a clean checkout at its
locked commit) applies only to a tree with its own `.git`. The VSIX seed, the
binary's install and the Docker image have none: their libraries are plain
copies made from the verified pins at packaging time, and are read as they are.

`npm run vsix` checks for
installed dependencies and every library before packaging; `gen/` is generated
on first start from the selected packs. Missing dependencies or libraries are
reported with the setup commands. The preview and test workflows use the same
lock for the patched libraries and
transpiler. The Docker image build also reads the lock; `docker/image/sources.json`
keeps its source inventory and licensing notes without a second copy of those
commits.

`npm run vsix:install` runs that same build and then installs the resulting
file with `code --install-extension <vsix> --force`. The build refuses to
package while a selected pack is unfetched, so a successful install command
has a complete bundled seed.

The tracked `editors/vscode/package.json` keeps the release baseline (`0.7.0`, the 0.7 line since 2026-10-04; the last 0.6 release was `vscode-stable-v0.6.1666`)
and supplies the major and minor for packaged builds. At packaging time, the
build changes only the staged copy's patch to `git rev-list --count HEAD`;
the tracked patch remains intact. Bump the major or minor by hand for a new
release line. The stamped version appears in the VSIX manifest and
`open-steamgate-<version>.vsix` filename, and `vsix:install` installs that exact
file. Local edits do not change the commit count, so a dirty build keeps the
same extension version; it logs that version with the content seed ID, which
keys the materialized install to the actual packaged files.

**What the archive unpacks into `osd-home-<seedId>/`**, found by tracing rather than guessing:
**not `output/`** -- see "two false starts, and a third" below for why a
first design shipped it and a second one dropped it again; `src/`,
`packs/zork/` by default (set `OSD_VSIX_PACKS=zork,o4d` to include more),
`webapp/`, `tools/` (whole); `test/` minus `test/e2e/`
and `test/fixtures/` (`abap_transpile.json`'s and `abaplint.jsonc`'s own
exclude lists) -- not just `run.mjs`/`start.mjs`/`setup.mjs` and their own
JS imports (grepped, including one dynamic import, `test/setup.mjs` ->
`./seed.mjs`): `abaplint.jsonc`'s own `global.files` glob makes ALL of
`test/` an input to the abaplint registry `tools/osd-store.mjs` builds at
startup (`test/start.mjs`'s own `store.registry()` call, on the critical
path to serving anything), non-JS ABAP fixtures under `test/unit/`
included -- a fact a JS import graph can never surface, and the first of
two things a dry read would have missed (below); `data/` (root seed rows,
`tools/osd-packs.mjs`'s `dataDirsOf()`); `abap_transpile.json` and
`abaplint.jsonc` themselves; the library sources they both name, at the
exact relative paths (`.local/lars/<name>/...`), each trimmed to the
lib's own `files` glob (abapGit, open-abap-gui, open-abap-odata, ajson,
open-abap-apc) or, for a library with no `files` filter in either config
(open-abap-core, express-icf-shim), everything except that library's own
`node_modules/`, `output/` and `test/` -- its own build litter, never read
by our transpile; `node_modules/`, traced from `package-lock.json`'s own
dependency graph (lockfileVersion 3, flat `packages` map) starting at the
five packages the run-time path actually imports (`@abaplint/core`,
`@abaplint/runtime`, `@abaplint/transpiler`, `@abaplint/database-sqlite`,
`express`) and walking `dependencies`/`optionalDependencies` -- 86 packages,
46.1 MB, answered by npm's own resolution rather than a guess at "the
transitive deps". `open-rfc` (live RFC) and `@duckdb/*` (not on the default
path per this file) are left out on purpose, along with `.git`,
`.local/worktrees`, `.local/corpus*`, every other `.local/lars/*` clone,
Playwright, DuckDB, Postgres, docs, and every dev-only devDependency
(webpack, mocha, chai, terser, the browserify shims). The staged seed also
omits `gen/`: the checkout's copy was generated with all packs present and
contains code from excluded packs. The first build regenerates it from the
pack selection in the installed seed.

**Two false starts, and a third that settled it, kept here because the fix
each time is the design.** The first version shipped `build/by-input/<hash>/`
(the cache entry `output/` lives in) plus the `build/live` and root `output`
symlinks, on the theory that a first build on the user's machine would
recompute the SAME input hash and reuse it -- the ~19 s / ~4 s difference
this spike measured. Trying it found two independent reasons this cannot
work. `zip` without `-y` dereferences a symlink into a real directory when
it archives one (confirmed by `unzip -l`: `build/live` came back as a
directory, not a link), and `tools/osd-build.mjs`'s own live-switch has no
fallback for that shape at `build/live` (unlike `output/`, which explicitly
does) -- `renameSync` throws `EISDIR` and the build fails outright.
Separately, and enough on its own even with `-y`: the input hash is
computed over each lib folder's WHOLE tree, not the `files` glob a lib
entry restricts reading to (`tools/osd-build.mjs`'s `hashOf()`), so a lib
trimmed to that glob (needed to keep the size down at all) never reproduces
the hash of the untrimmed clone the shipped generation was built from --
the cache would miss on the first build regardless of the symlink problem.
The fix tried second was `copyOutput()`: ship `output/` alone, as plain
files, nothing else under `build/`. `switchTo()` already tolerates exactly
that shape on the first real build ("a real directory there is what every
tree had before this existed", moved aside to `build/legacy-<ts>`), so this
is not a special case taught to the build -- it is the case already there.

That crashed on a separate bug, fixed in the same commit (#106): the
packaged copy ran `tools/osd-build.mjs` to completion (1709 of the tree's
1727 objects -- the trimmed libs cost a few unused files, nothing the build
needs) and then `test/run.mjs` came up as far as "Listening on
.../sap/opu/odata/sap/" before an uncaught `ENOENT` on `abaplint.jsonc` at
the seed root -- read by `tools/osd-store.mjs`'s registry, never named in
the task's own file list because it is not a JS import of anything.
Copying it (and the whole `test/` tree it requires) fixed it; a bare "trace
the imports" pass would have missed both, which is why they are written
down rather than folded quietly into the file list.

With the crash fixed, `output/` still never reproduced a cache hit, for a
third reason found only by tracing what a real first build actually
compares (2026-09-26, `vsix-prebuilt-generation` task). `hashOf()` folds
`describeBuild(root)` (`tools/osd-transpiler.mjs`) into the generation
name. For the ordinary case -- the transpiler installed from npm, not
linked -- `describeBuild` already prints a portable string with no
absolute path: `transpiler: @abaplint/transpiler 2.13.89, published`.
Measured directly (`node -e ...describeBuild(process.cwd())`): true on
this tree today. The non-portable case is the one CLAUDE.md's "Known
traps" and "Working in the tree" call out as routine here -- a LOCAL
transpiler build linked from `.local/lars/` while a fix is not released
yet. There, `packageInUse()` reports `{kind: "linked", where: <absolute
path>, branch, commit, dirty}` and `describeOne()` prints all of it,
including the path, into the hashed string. `scripts/build-vsix.mjs`'s own
`copyReal()` **dereferences** that symlink when it packages `node_modules/`
(needed regardless, since a `.vsix` cannot carry a symlink pointing outside
itself), so the shipped `node_modules/@abaplint/transpiler` arrives as a
plain directory with no git metadata in it at all. A user's machine
materializing that copy calls `packageInUse()` on it and gets back
`{kind: "published", version: <whatever the built dist's package.json
says>}` -- a different shape, computed from different facts, than the one
the packaging machine had. No rewrite of the STRING closes that gap on its
own: making `describeOne`'s "linked" case portable (drop `where`, keep
`branch`/`commit`/`dirty` so a dirty local build still changes the hash on
the machine that built it -- genuinely a small change) does not make the
shipped tree capable of reporting the SAME branch/commit/dirty, because
that information no longer exists on disk after `copyReal` -- it lived in
`.git`, which a lib's own trim already excludes as build litter. Closing it
for real needs a metadata file written at packaging time (the packaging
machine's true `describeBuild()`) and read back by `packageInUse()` in
preference to what the tree looks like -- a second code path in a function
whose whole point today is "trust what's on disk", not the small, clean
change the hour this task set aside was for. So, per Alice's call
(2026-09-26): **fallback (b)**. `output/` is not shipped at all. A first
start is an ordinary full, cold build (measured below); a second start of
the SAME materialized copy is fast because by then it has grown its own
matching cache, the same way any other checkout's second build does --
unaffected by any of this, since by then `describeBuild(materializedRoot)`
is being compared against itself, not against a different machine's build.

**Next step, not done here**: make `describeOne()`'s "linked" case
portable in the sense above (branch/commit/dirty, no absolute path) --
worth doing on its own for CI log readability regardless of packaging --
and, separately, decide whether per-library generation reuse (shipping a
metadata file that lets a materialized copy claim the packaging machine's
`describeBuild()` when the packaged transpiler was a local build) is worth
the second code path it needs. Backlogged rather than attempted under this
task's one-hour budget for it.

**Materializing on first start** (`osd.home` unset, the packaged path):
packaging writes the SHA-256 content ID of the staged seed tree
into `extension/osd/.seed-id`. The ID covers relative paths and file contents
and mode bits, and excludes `.seed-id` itself. `ensureMaterializedHome()`
(`editors/vscode/launcher.js`) uses that ID as the key for
`<globalStorageUri>/osd-home-<seedId>/`; its `.osd-materialized` marker stores
the same ID. A matching ID reuses the existing copy, including any edits made
since it was materialized. A changed seed, even under the same extension
version, gets a new copy in its own seed-keyed directory. At extension
activation, before this window starts a system, old seed-keyed homes are
checked. Cleanup first renames each eligible old home to a unique quarantine
name in the same storage directory, then checks its lock and contents again.
If either changed, it restores the old path (or retains the quarantine path
if the old path has been occupied). An old home whose contents still match
its own seed ID is removed.
For an edited home, the extension first saves changed and added files under
`<globalStorageUri>/osd-saved-edits/<old-seed-id>-<yyyy-mm-dd>/files/`, with
deleted file paths in `deleted.json`, then removes the old home. The saved
folder also contains a complete `snapshot/`, so restoring the exact old copy
does not require finding an older VSIX: copy `snapshot/` back to its original
`osd-home-*` path. To apply just the edits to a seed, overlay `files/` and
remove the paths in `deleted.json`. A home created before
`.osd-seed-files.json` recorded the original file list gets only the complete
snapshot. A notice for each saved copy has an
**Open saved edits** button. Repeated saves on the same day get a numeric
suffix, so an earlier save is never overwritten.

A launcher writes a `.osd-serving-<pid>-<uuid>.lock` with its extension host
PID while building, then records the server child PID as soon as it starts,
and removes its lock on stop or server exit. Cleanup treats a lock as stale
only when both PIDs are dead, and keeps a home with a live,
unreadable, or malformed lock. The current seed's home is always kept.
Only exact lock filenames are excluded from content checks; similarly named
files such as `.osd-serving-notes` count as user edits.
Cleanup also verifies the excluded seed metadata before removing an unedited
home; changed metadata is saved with the home or causes it to be kept. This
activation-only cleanup runs before this window starts its system. Quarantine
blocks new opens through the old path, and per-home server locks protect known
serving processes. A foreign process that already holds an open file descriptor
into an unlocked old home can still write during deletion; that residual risk
is accepted for this local development tool.
Unreadable homes, failed hashes, and failed saves are kept. The manual
`osd: Remove old working copies` command still lists old homes with sizes
and whether their content differs from the seed ID. Generated build files
also count as differences; unreadable or unverifiable homes are labeled
edited. The user selects homes and confirms deletion in a modal dialog.
The command checks the current seed's home and serving locks again before
deleting selected paths.

`linkOrCopyTree()` copies regular files and keeps symlinks as symlinks. Files
must have separate inodes because the Workbench's ADT save path writes them
in place through `ObjectStore.write()`; a hard link would also change the
packaged seed. `osd.home`, when set, still wins -- the dev path, unchanged,
and the only path a checkout with no bundled `extension/osd/` (the symlinked
dev install) ever takes. `build/` and `gen/` are then written inside that
storage copy by the ordinary build, never inside `extension/osd/` itself.
`test/vscode-launcher.mjs` checks activation cleanup, edit saving, serving
locks, the command's pure selection logic, and a late `ObjectStore.write()`
through an older path before cleanup. `test/vscode-vsix.mjs` checks seed IDs
in real `.vsix` packages and preservation of an edited home until activation
cleanup runs.

**Measured before** (2026-09-26, `output/` shipped, the state #105/#106
left this in, version 0.1.1): `.vsix` 53.5 MB, unpacked 148.7 MB
(`output/` 59.6 MB of it, plain files minus `*.mjs.map`); first start
22.9 s (materialize 0.45 s, build+serve 22.4 s -- the "cache miss" the
paragraph above traces to `describeBuild()`, plus a spurious "moved to
build/legacy-&lt;ts&gt;" since a real directory was already sitting at
`output/`); second start of the same materialized copy 4.2 s.

**Measured after** (same machine, same method, `npm run vsix` then a
direct run of `editors/vscode/launcher.js` against the unzipped `.vsix`,
`osd.home` unset, version 0.1.2, fallback (b) -- `output/` dropped
entirely):

| | |
| --- | --- |
| `.vsix` | 34.7 MB (was 53.5 MB, -18.8 MB) |
| unpacked (`extension/osd/` + the extension's own files) | 90.8 MB (was 148.7 MB, -57.9 MB) |
| -- `node_modules/` (88 packages, traced from package-lock.json) | 47.3 MB |
| -- `packs/` (o4d, zork, zvdb, lsd -- whole, media included) | 22.1 MB |
| -- `src/` + `gen/` + `webapp/` + `tools/` + `test/` + `data/` | 13.7 MB |
| -- `.local/lars/` (7 libraries, `files`-glob-trimmed where named) | 7.5 MB |
| -- the extension's own files (`extension.js`, `lib.js`, `launcher.js`, `resources/`, `examples/`) | 0.1 MB |
| first start (materialize + full cold build + serve), same storageDir both times | 23.6 s (`osd-build: transpile` runs, no `moved to build/legacy`) |
| second start, same materialized copy AND same storageDir (cache hit) | 4.3 s (`osd-build: transpile` does not run) |

First start is, within measurement noise, the same ~19-23 s this spike
measured throughout (it was always a cold build in practice, the cache
never having actually hit); the difference this change makes is -57.9 MB
unpacked / -18.8 MB of `.vsix`, one fewer spurious log line, and an honest
design: nothing here claims a cache hit it cannot deliver. Second start
is unchanged, because it was never the problem -- a materialized copy
growing its own matching cache on its own first build is the ordinary
`build/by-input/<hash>/` mechanism, working exactly as it does in any
checkout. (The two runs above share one `storageDir`, matching
`storageDirFor()` in `editors/vscode/extension.js`, which is deterministic
in `osdHome` -- a real VS Code restart reuses it. An earlier measurement
pass using a fresh `storageDir` per run showed both starts cold, because
the workspace-layer pack path `ensureWorkspacePacks()` writes under
`storageDir` is itself a generation input; that is a measurement artefact
of this spike, not a bug -- a real restart's `storageDir` does not move.)

90.8 MB was under the ~150 MB threshold; `build-vsix.mjs` still warns past
that line. The later pack selection below removes the o4d media from the
default package while leaving it available through `OSD_VSIX_PACKS`.

**Pack selection, measured 2026-09-27** on the same checkout before and
after the allowlist change, with all six local packs fetched. The figures
are MiB (`build-vsix.mjs` prints them as MB):

| | All six packs and `gen/` (before) | Zork only (default) |
| --- | ---: | ---: |
| `.vsix` | 34.6 | 17.7 |
| unpacked | 93.8 | 67.3 |
| `packs/` in the seed | 22.1 | 0.3 |
| `gen/` in the seed | 4.7 | 0 |

The default archive contains only `extension/osd/packs/zork/`; the 16.9 MiB
archive reduction comes from leaving out `gui-examples`, `lsd`, `o4d`,
`travels-a4h`, `zvdb`, and generated files made from them. `OSD_VSIX_PACKS`
is a comma-separated list of in-tree pack names; the builder rejects unknown
names and checks fetched sources only for the selected packs. `src/webgui/`
remains part of `src/`.
`test/vscode-vsix.mjs` checks both archive selections and starts the default
archive after materializing it outside the checkout; the launchpad and
`ZSTG_DEMO_SRV/TravelSet` answer, and the first build generates no zvdb
service.

**Proving it runs outside this checkout**: `test/vscode-vsix.mjs`
(registered in `test/suites.d/*.json`, skipped via `this.skip()` when
`build/vsix` was never built, the same shape `test/osd-binary.mjs` already
uses for the compiled binary) unzips the `.vsix` into
`OSD_VSIX_SCRATCH` (or `~/.cache/osd-vsix-test` by default), runs
`ensureMaterializedHome()` against a scratch `globalStorageDir` with
`osd.home` unset, and points `Launcher` at a workspace folder
in its scratch directory. The fixture has a manifest, classrun class, DDIC
table, TABU row, webapp page, and launchpad tile. The test checks classrun
and the seeded row, the page and tile, Layers contribution counts, a new
generation and row after edits, and disappearance of the class, tile, and
page after closing the folder and restarting. It stops its spawned process
and removes the scratch directory.

**Installed for real**: `code --install-extension build/vsix/osd-vscode-0.1.0.vsix`
under this machine's Remote-WSL VS Code Server (the `code` on `PATH` here
resolves to the Windows-side binary, which talks to the same server over
the remote bridge) replaced the existing DEV install --
`~/.vscode-server/extensions/open-steamgate.osd-vscode-0.1.0` had been a
symlink to `editors/vscode/` (the usual dev-install shape this same file
names above, since `--extensionDevelopmentPath` is not supported over a
remote connection) -- with a real, extracted 149 MB copy carrying
`extension/osd/`, `engines.vscode` and `extensionKind` read back correctly
off its `package.json`. The dev symlink was restored afterward (`rm` the
extracted copy, `ln -s .../editors/vscode` back in its place) so the usual
edit-and-reload dev loop keeps working; anyone who wants the REAL install
kept instead runs the `--install-extension` command above again and skips
the `ln -s`.

**`engines.vscode`**: `^1.101.0`. `tools/sqlite-file-client.mjs` (the
`STG_DB=file` backend the launcher always selects) imports Node's own
`node:sqlite`, which needs Node 22.5 or newer. Evidence:
[ewanharris/vscode-versions](https://github.com/ewanharris/vscode-versions)
(a maintained table of VS Code's own bundled Electron/Node/Chromium per
release) shows 1.100.0 still on Node 20.19.0 and 1.101.0 (released
2025-06-11) on Node 22.15.1 -- the first VS Code release with Node 22 at
all, and already past 22.5. `extensionKind: ["workspace"]` is set too:
the system has to run where the folder is, never only in a local UI host.

**Left as gaps, not attempted here**: an actual marketplace `publisher`
account and a `CHANGELOG.md` (explicitly out of scope per the task); an
icon distinct from the activity-bar glyph; a non-WSL remote/SSH install
proof (only Remote-WSL was exercised, on this machine); shrinking
`packs/*/upstream`, the one remaining size trim named above; and, per the
"third false start" above, making `describeBuild()`'s "linked" case
portable (branch/commit/dirty, no absolute path) and, separately, a
metadata file at packaging time that would let per-library generation
reuse actually hit, so a materialized first start could be the 4-5 s cache
hit rather than the ~20-23 s cold build it is today (2026-09-26,
`vsix-prebuilt-generation` task; fallback (b) taken on Alice's call within
the hour the task set aside for the portable-hash design).

## Warm

*2026-09-26 (T7).* B0 launches the whole system by itself; this makes the
save-to-serving loop of a system it launched itself under `docs/warm-
compile.md`'s ~0.5 s instead of the cold build's several seconds, and says
so rather than leaving a person to guess whether Ctrl+F3 actually reached
the running process.

**`osd.warm`: `"auto"` (default), `"on"` or `"off"`.** The launcher
(`editors/vscode/launcher.js`) sets `OSD_WARM=1` in the launched system's
own env when the setting resolves to on -- `"auto"` is on at or above
`WARM_MEMORY_FLOOR_BYTES` (4 GB; the prime measured about 0.7 GB,
`docs/warm-compile.md`), off below it (`shouldWarm(mode, totalMemBytes =
os.totalmem())`, pure and unit-tested at both sides of the floor,
`test/vscode-launcher.mjs`). This only asks the launched system to *try*:
whether it actually primes is `tools/osd-store.mjs` `warmUp()`'s own
business. Release VSIX builds use the locked fork with upstream `only` and
registry reuse and one shared `@abaplint/core`; they can prime. A
checkout using the published npm transpiler stays cold and says why. That
reason is shown as the server gave it, not reworded.

**Where it shows.** `/osd/serving`'s own `warm` field (`{state: off |
priming | primed | cold, reason, generation, unverified, swaps, copies,
lastVerify}`, `tools/osd-store.mjs` `warmStatus()`, #108) drives:
- the status bar, alongside the existing generation and dump count --
  `$(server) osd <gen> · warm +<swaps>` or `· cold: <reason>`, and, for the
  first ~20 s after *this window's own* launch, `$(sync~spin) osd warming
  up…` in place of "osd down" while the prime is still synchronous and the
  façade answers nothing at all (`docs/warm-compile.md`'s own note on
  that);
- the tree's state row (`OsdTreeProvider`), the same text appended to
  "Running on :port, generation …", polled every 5 s while running (the
  prime finishing, or a swap happening, is not a controller state change,
  so nothing else would tell the row it had gone stale);
- both tooltips carry the rest: warm generation, `unverified` (a warm
  build a cold comparison has not passed yet, `X-OSD-Generation:
  <hash> warm-unverified`), `swaps`, `copies` (a warm build that had to
  copy rather than hard-link, `#108`) and `lastVerify`.

`editors/vscode/lib.js` `warmStatusText(warm)` is the pure text (`undefined`
for `"off"` or no field at all -- most machines never turn this on, and a
status bar that says so on every tick would be noise), tested against the
real vocabulary in `test/vscode-extension.mjs`.

**Ctrl+F3 says what it built.** `Osd#activate()`/`#activateMany()` read
`X-OSD-Build`, `X-OSD-Swap-Ms`, `X-OSD-Closure` and `X-OSD-Closure-Tests`
off the activation answer (`tools/adt-facade.mjs` `warmHeaders()`) into
`{build, swapMs, closure, closureTests}`; `activationBuildText(result)`
turns that into "hot-swapped in `<ms>` ms (warm)", "warm, already live"
(a warm build with no swap header: the generation was already serving)
or "cold build" / "cold build: `<reason>`". `warm` means the build **and**
the load: a warm build the runtime was recycled for -- a refused swap, or a
`HOST_HELD` module (`docs/warm-compile.md` "What the process holds
itself") -- answers `cold; recycled after a warm build: <why>`. It used to
answer `warm` while osd.log said the swap was refused (vsp-i7,
2026-10-02; `test/warm.mjs`).
`closureTestsText(result)` is "`<n>` test(s) in the closure", kept on the
result for a later use (B1) and shown in the status-bar message
alongside the build text.

**"Rebuild" (the `$(tools)` icon) is the warm path; "Full rebuild" (the
view's own "…" menu) is the old `osd.rebuild`** (stop, build, start --
unchanged, just moved and renamed so the icon slot is the fast path by
default). `SystemController#rebuildWarm()`:
1. not running -> falls back to `rebuild()`;
2. `/osd/serving`'s `warm.state !== "primed"` -> falls back, and says the
   reason;
3. otherwise asks `GET /sap/bc/adt/core/http/changed` -- every CLAS/INTF
   whose file no longer hashes to what the warm registry was primed or
   last built from (`ObjectStore#changedObjects()`, reusing the warm
   compiler's own per-file digests, `tools/osd-warm.mjs` `WarmCompiler`
   -- no second bookkeeping). `objects: undefined` (not empty) means the
   route itself could not tell, which falls back the same way; an empty
   list means nothing to do;
4. activates every changed object in **one** call
   (`Osd#activateMany`) -- one build, and, warm, one swap, covers the
   whole closure rather than one swap per object, the way a person
   activating a whole change in ADT would.

Every branch above either falls back to a full rebuild or returns having
reported something; nothing here can dump or hang on a system that never
primed -- the fallback runs the same `rebuild()` a plain "not running"
does.

**Tests**: pure logic in `test/vscode-extension.mjs` ("T7 warm status and
build text") and `test/vscode-launcher.mjs` ("shouldWarm"); the live half
in `test/vscode-warm.mjs`, against a real `node test/run.mjs` with
`OSD_WARM=1`, an on-disk comment edit and `Osd#activate()` -- asserts a
warm swap when the registry primed, and that the cold reason is surfaced
verbatim when it did not.

## Debugging ABAP

Debugging switches itself on; `osd.debug` is gone from the settings. A
fresh profile recognizes `.abap` as ABAP and accepts VS Code breakpoints
without changing user settings. The extension uses VS Code's built-in Node
debugger for its attach sessions. A breakpoint set in an `.abap` file while
the system runs, **osd: Run with
debugger**, or the debugger variants of the entity-set CodeLens and of
classrun open the running serving child's inspector on a free
127.0.0.1 port (`/osd/inspector`, `tools/osd-inspector.mjs`) and start a
Node attach session with the same source-map settings as
[`docs/debugging-abap.md`](debugging-abap.md), with no restart. The
session reconnects when that child recycles; a full rebuild ends it, and
the new system is attached again when `.abap` breakpoints are waiting. Once no `.abap` breakpoint is left and the session has ended, the
inspector is closed. `OSD_INSPECT=1` in VS Code's
environment (or, for one release, an existing `"osd.debug": true`) opens
it at start instead, and then it stays open. A debugger needs one work
process (`OSD_WORKERS=1`).
For packaged installs, the attach profile maps source paths in generated
workspace-layer packs back to the folder open in the editor.

The Test Explorer has **Run** and **Debug** profiles. Debug starts the
detached ABAP Unit child with its own free `--inspect-brk` port and
`--enable-source-maps`; js-debug resumes it after attaching and installing
breakpoints. With the inspector asked for at start, ordinary Test Explorer
runs, including Ctrl+Shift+F10 and the beaker, use the same attach path
automatically.

The status bar's **Toggle ABAP breakpoints** item calls VS Code's global
breakpoint activation command. It stops or resumes reactions to breakpoints
without removing their markers. Its label does not claim the global state,
which VS Code's extension API does not expose. The attach policy and configuration are pure
functions in `editors/vscode/lib.js`; the live CDP test
`test/vscode-debug.mjs` pauses on a mapped line in an ABAP Unit test method.
The pure attach transitions are unit-tested in `test/vscode-extension.mjs`,
and port/environment selection in `test/vscode-launcher.mjs`.

## Next

- Smart F8 / Runner, the rest of it: create/update/delete entity, a function
  import, `$expand` on the lens's own request. Today's lens and F8 only
  read (Q2b, above).
