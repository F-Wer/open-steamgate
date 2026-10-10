import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {CmpNumericData, Component, DataString, MoveData, cell, TP, TI, TF, TX} from "./js/abap.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("nested string builder loops do not retain deferred buffers", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-builder-loop-"));
  try {
    writeFileSync(join(sourceDir, "zcl_gogen_builder_loop.clas.abap"), `
CLASS zcl_gogen_builder_loop DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_builder_loop IMPLEMENTATION.
  METHOD run.
    DATA lv TYPE string.
    DO 60000 TIMES.
      DO 1 TIMES.
        lv = lv && 'x'.
      ENDDO.
      rv = strlen( lv ).
    ENDDO.
  ENDMETHOD.
ENDCLASS.
`);
    const go = emitGo(compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_BUILDER_LOOP"]}));
    assert.match(go, /strings\.Builder/);
    assert.doesNotMatch(go, /defer func\(\) \{ if active_sb_/);
    assert.doesNotMatch(go, /active_sb_/);
  } finally { rmSync(sourceDir, {recursive: true, force: true}); }
});

test("TRY handlers block builders for every loop in the TRY body", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-builder-try-"));
  try {
    writeFileSync(join(sourceDir, "zcl_gogen_builder_try.clas.abap"), `
CLASS zcl_gogen_builder_try DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_builder_try IMPLEMENTATION.
  METHOD run.
    DATA seen TYPE string.
    DATA free TYPE string.
    DO 3 TIMES.
      seen = seen && 'a'.
      free = free && 'b'.
    ENDDO.
    rv = free.
  ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_BUILDER_TRY"]});
    const method = program.classes[0].methods.find((m) => m.name === "RUN");
    const loop = method.body.find((st) => st.s === "do");
    const readSeen = {s: "assign", target: {e: "var", name: "rv", type: {k: "string"}}, value: {e: "var", name: "seen", type: {k: "string"}}};
    method.body = [{s: "try", body: [loop], catches: [{covers: ["CX_ROOT"], own: [], body: [readSeen]}], cleanup: [readSeen]}, ...method.body.filter((st) => st !== loop)];
    const go = emitGo(program);
    assert.doesNotMatch(go, /sb_free_/);
    assert.doesNotMatch(go, /sb_seen_/);
  } finally { rmSync(sourceDir, {recursive: true, force: true}); }
});

test("numeric generic SUBTRACTSECS reaches its Go native", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-tstmp-native-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-tstmp-test-"));
  try {
    writeFileSync(join(sourceDir, "cl_abap_tstmp.clas.abap"), `
CLASS cl_abap_tstmp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS subtractsecs IMPORTING tstmp TYPE p secs TYPE numeric RETURNING VALUE(r) TYPE p.
ENDCLASS.
CLASS cl_abap_tstmp IMPLEMENTATION.
  METHOD subtractsecs.
  ENDMETHOD.
ENDCLASS.
`);
    writeFileSync(join(sourceDir, "zcl_gogen_tstmp_native.clas.abap"), `
CLASS zcl_gogen_tstmp_native DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE p.
ENDCLASS.
CLASS zcl_gogen_tstmp_native IMPLEMENTATION.
  METHOD run.
    rv = cl_abap_tstmp=>subtractsecs( tstmp = rv secs = 60 ).
  ENDMETHOD.
ENDCLASS.
`);
    const go = emitGo(compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_TSTMP_NATIVE", "CL_ABAP_TSTMP"]}));
    assert.match(go, /hTstmpsecs\.SubtractSecs/);
    writeFileSync(join(goDir, "zz_generated.go"), go);
    const build = spawnSync("go", ["test", "-vet=off", `./cmd/${basename(goDir)}`], {cwd: join(here, "go"), encoding: "utf8", timeout: 120000});
    assert.equal(build.status, 0, build.stderr || build.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("generic numeric comparison keeps packed decimal boundaries in JS", () => {
  assert.equal(CmpNumericData(cell("1.5", TP(4, 1)), cell("1.4", TP(4, 1))), 1);
  assert.equal(CmpNumericData(cell(1, TI), cell("1.4", TP(4, 1))), -1);
  assert.equal(CmpNumericData(cell(1.5, TF), cell("1.5", TP(4, 1))), 0);
});

test("SELECT clauses come from syntax nodes, not WHERE string literals", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-select-literals-"));
  try {
    const table = readFileSync(join(here, "testdata", "zgogen_t_dbw.tabl.xml"), "utf8")
      .replace("<INTLEN>000020</INTLEN>", "<INTLEN>000160</INTLEN>")
      .replace("<LENG>000010</LENG>", "<LENG>000080</LENG>");
    writeFileSync(join(sourceDir, "zgogen_t_dbw.tabl.xml"), table);
    writeFileSync(join(sourceDir, "zcl_gogen_select_literals.clas.abap"), `
CLASS zcl_gogen_select_literals DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_select_literals IMPLEMENTATION.
  METHOD run.
    DATA lt TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    SELECT id FROM zgogen_t_dbw INTO TABLE lt WHERE id = 'UP TO 1 ROWS APPENDING TABLE'.
    SELECT id FROM zgogen_t_dbw APPENDING TABLE lt WHERE id = 'UP TO 1 ROWS'.
    SELECT id FROM zgogen_t_dbw INTO TABLE lt UP TO 2 ROWS WHERE id = 'APPENDING TABLE'.
    rv = lines( lt ).
  ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_SELECT_LITERALS"]});
    const method = program.classes.find((c) => c.name === "ZCL_GOGEN_SELECT_LITERALS").methods.find((m) => m.name === "RUN");
    assert.ok(method, JSON.stringify({methods: program.classes[0].methods, skipped: program.skipped, partial: program.partial}));
    const selects = method.body.filter((s) => s.s === "select_table");
    assert.equal(selects.length, 3, JSON.stringify(method.body));
    assert.deepEqual(selects.map((s) => s.appending), [false, true, false]);
    assert.doesNotMatch(selects[0].sql, /LIMIT/i);
    assert.doesNotMatch(selects[1].sql, /LIMIT/i);
    assert.match(selects[2].sql, /LIMIT 2/i);
    assert.doesNotMatch(emitGo(program), /NOT_COMPILED in ZCL_GOGEN_SELECT_LITERALS/);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
  }
});

test("FOR ALL ENTRIES with APPENDING, UP TO or ORDER BY is refused, not run without the clause", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-select-fae-"));
  try {
    copyFileSync(join(here, "testdata", "zgogen_t_dbw.tabl.xml"), join(sourceDir, "zgogen_t_dbw.tabl.xml"));
    const method = (name, statement) => `  METHOD ${name}.
    TYPES: BEGIN OF ty_key, id TYPE c LENGTH 10, END OF ty_key.
    DATA lt TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lt_keys TYPE STANDARD TABLE OF ty_key WITH DEFAULT KEY.
    ${statement}
    rv = lines( lt ).
  ENDMETHOD.`;
    const fae = "FOR ALL ENTRIES IN lt_keys WHERE id = lt_keys-id";
    writeFileSync(join(sourceDir, "zcl_gogen_select_fae.clas.abap"), `
CLASS zcl_gogen_select_fae DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS plain RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS appending RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS upto RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS ordered RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_select_fae IMPLEMENTATION.
${method("plain", `SELECT id FROM zgogen_t_dbw INTO TABLE lt ${fae}.`)}
${method("appending", `SELECT id FROM zgogen_t_dbw APPENDING TABLE lt ${fae}.`)}
${method("upto", `SELECT id FROM zgogen_t_dbw INTO TABLE lt UP TO 3 ROWS ${fae}.`)}
${method("ordered", `SELECT id FROM zgogen_t_dbw INTO TABLE lt ${fae} ORDER BY id.`)}
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_SELECT_FAE"]});
    const generated = emitGo(program);
    const cls = program.classes.find((c) => c.name === "ZCL_GOGEN_SELECT_FAE");
    const compiled = (name) => cls.methods.some((m) => m.name === name && m.body.some((st) => st.s === "select_table" && st.fae));
    assert.ok(compiled("PLAIN"), "a plain FOR ALL ENTRIES still compiles");
    for (const [name, clause] of [["APPENDING", "APPENDING"], ["UPTO", "UP TO"], ["ORDERED", "ORDER BY"]]) {
      assert.ok(!compiled(name), `${name} must not compile`);
      assert.match(generated, new RegExp(`ZCL_GOGEN_SELECT_FAE=>${name}[^\n]*(FOR ALL ENTRIES with ${clause}|${clause})`), `${name} is refused, and the reason names ${clause}`);
    }
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
  }
});

test("a source literal naming datearith does not add an unused Go import", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-import-source-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-import-test-"));
  try {
    writeFileSync(join(sourceDir, "zcl_gogen_import_test.clas.abap"), `
CLASS zcl_gogen_import_test DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_import_test IMPLEMENTATION.
  METHOD run.
    rv = 'datearith.'.
  ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_IMPORT_TEST"]});
    const generated = emitGo(program);
    assert.match(generated, /"datearith\."/);
    assert.doesNotMatch(generated, /"osg\/gogen\/datearith"/);
    writeFileSync(join(goDir, "zz_generated.go"), generated);
    const build = spawnSync("go", ["test", `./cmd/${basename(goDir)}`], {
      cwd: join(here, "go"), encoding: "utf8", timeout: 120000,
    });
    assert.equal(build.error, undefined, build.stderr);
    assert.equal(build.status, 0, build.stderr || build.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("an ABAP parameter named like a helper package does not shadow it", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-shadow-source-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-shadow-test-"));
  try {
    // `charsearch` is both the parameter and the package CS compiles to;
    // without an alias the parameter hides the package (stoker's tstmp case)
    writeFileSync(join(sourceDir, "zcl_gogen_shadow_test.clas.abap"), `
CLASS zcl_gogen_shadow_test DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING charsearch TYPE string RETURNING VALUE(rv) TYPE abap_bool.
ENDCLASS.
CLASS zcl_gogen_shadow_test IMPLEMENTATION.
  METHOD run.
    IF charsearch CS 'b'.
      rv = abap_true.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_SHADOW_TEST"]});
    const generated = emitGo(program);
    assert.match(generated, /hCharsearch "osg\/gogen\/charsearch"/);
    writeFileSync(join(goDir, "zz_generated.go"), generated);
    const build = spawnSync("go", ["vet", `./cmd/${basename(goDir)}`], {
      cwd: join(here, "go"), encoding: "utf8", timeout: 120000,
    });
    assert.equal(build.error, undefined, build.stderr);
    assert.equal(build.status, 0, build.stderr || build.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("another class's public static attribute is read in expressions after its constructor", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-static-source-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-static-test-"));
  try {
    writeFileSync(join(sourceDir, "zcl_gogen_static_owner.clas.abap"), `
CLASS zcl_gogen_static_owner DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-DATA gv_y TYPE i.
    CLASS-METHODS class_constructor.
ENDCLASS.
CLASS zcl_gogen_static_owner IMPLEMENTATION.
  METHOD class_constructor.
    gv_y = 7.
  ENDMETHOD.
ENDCLASS.
`);
    writeFileSync(join(sourceDir, "zcl_gogen_static_reader.clas.abap"), `
CLASS zcl_gogen_static_reader DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_static_reader IMPLEMENTATION.
  METHOD run.
    rv = zcl_gogen_static_owner=>gv_y + 1.
    IF zcl_gogen_static_owner=>gv_y = 7.
      rv = rv + 1.
    ENDIF.
    DO 2 TIMES.
      IF zcl_gogen_static_owner=>gv_y <> 7.
        rv = 0.
      ENDIF.
    ENDDO.
  ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_STATIC_READER"]});
    const generated = emitGo(program);
    // osgo.mjs and osabap.mjs both use the default emitter mode.
    assert.doesNotMatch(generated, /session\.Register\(/);
    assert.doesNotMatch(generated, /"osg\/gogen\/session"/);
    assert.doesNotMatch(emitGo(program, "main", null, true), /session\.Register\(/);
    assert.doesNotMatch(generated, /NOT_COMPILED in ZCL_GOGEN_STATIC_READER=>RUN/);
    const reader = generated.slice(generated.indexOf("func ZCL_GOGEN_STATIC_READER_RUN("));
    const body = reader.slice(0, reader.indexOf("\n}\n"));
    assert.equal((body.match(/:= St_ZCL_GOGEN_STATIC_OWNER\(s\)/g) ?? []).length, 1);
    assert.doesNotMatch(body, /St_ZCL_GOGEN_STATIC_OWNER\(s\)\./);
    // Foreign constructors stay at the access site, preserving conditional use.
    assert.match(body, /Ensure_ZCL_GOGEN_STATIC_OWNER\(s\)/);
    writeFileSync(join(goDir, "zz_generated.go"), generated);
    writeFileSync(join(goDir, "zz_generated_test.go"), `package main\nimport ("testing"; "osg/gogen/abap")\nfunc TestRead(t *testing.T) { if got := ZCL_GOGEN_STATIC_READER_RUN(&abap.Session{}); got != 9 { t.Fatalf("got %d", got) } }\n`);
    const run = spawnSync("go", ["test", `./cmd/${basename(goDir)}`], {cwd: join(here, "go"), encoding: "utf8", timeout: 120000});
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("an inline SELECT table name in one method does not hide a local of another method", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-inline-source-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-inline-test-"));
  try {
    copyFileSync(join(here, "apps", "notes", "znotes.tabl.xml"), join(sourceDir, "znotes.tabl.xml"));
    writeFileSync(join(sourceDir, "zcl_gogen_inline_scope.clas.abap"), `
CLASS zcl_gogen_inline_scope DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS rows RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS number RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_inline_scope IMPLEMENTATION.
  METHOD rows.
    SELECT id FROM znotes INTO TABLE @DATA(lt).
    rv = lines( lt ).
  ENDMETHOD.
  METHOD number.
    DATA(lt) = 3.
    rv = lt.
  ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_INLINE_SCOPE"]});
    const generated = emitGo(program);
    assert.doesNotMatch(generated, /NOT_COMPILED in ZCL_GOGEN_INLINE_SCOPE/);
    writeFileSync(join(goDir, "zz_generated.go"), generated);
    const build = spawnSync("go", ["test", `./cmd/${basename(goDir)}`], {
      cwd: join(here, "go"), encoding: "utf8", timeout: 120000,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("GET RUN TIME FIELD lowers an i target to monotonic microseconds", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-runtime-"));
  try {
    const file = join(sourceDir, "zcl_runtime.clas.abap");
    const source = (type) => `CLASS zcl_runtime DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS run.
ENDCLASS.
CLASS zcl_runtime IMPLEMENTATION.
METHOD run. DATA elapsed TYPE ${type}. GET RUN TIME FIELD elapsed. ENDMETHOD.
ENDCLASS.`;
    writeFileSync(file, source("i"));
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_RUNTIME"]});
    assert.equal(program.classes[0].methods[0].body[0].s, "get_runtime");
    const go = emitGo(program);
    assert.match(go, /hRuntimeclock \"osg\/gogen\/runtimeclock\"/);
    assert.match(go, /elapsed = hRuntimeclock\.Microseconds\(\)/);
    writeFileSync(file, source("string"));
    const refused = compileProgram({folders: [sourceDir], objects: ["ZCL_RUNTIME"], tolerant: true});
    assert.match(refused.partial.join("\n"), /GET RUN TIME FIELD into a string/);
  } finally { rmSync(sourceDir, {recursive: true, force: true}); }
});


test("declared interface membership works across core and app layers", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-interface-source-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-interface-layers-"));
  try {
    writeFileSync(join(sourceDir, "zif_layer.intf.abap"), `
INTERFACE zif_layer PUBLIC.
ENDINTERFACE.
`);
    writeFileSync(join(sourceDir, "zcl_layer_core.clas.abap"), `
CLASS zcl_layer_core DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
CLASS-METHODS accepts IMPORTING value TYPE REF TO zif_layer RETURNING VALUE(rv) TYPE abap_bool.
ENDCLASS.
CLASS zcl_layer_core IMPLEMENTATION.
METHOD accepts.
rv = xsdbool( value IS INSTANCE OF zif_layer ).
ENDMETHOD.
ENDCLASS.
`);
    writeFileSync(join(sourceDir, "zcl_layer_app.clas.abap"), `
CLASS zcl_layer_app DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
INTERFACES zif_layer.
CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_layer_app IMPLEMENTATION.
METHOD run.
DATA concrete TYPE REF TO zcl_layer_app.
DATA generic TYPE REF TO object.
DATA assigned TYPE REF TO zif_layer.
DATA narrowed TYPE REF TO zif_layer.
concrete = NEW zcl_layer_app( ).
generic = concrete.
assigned = concrete.
IF assigned IS BOUND. rv = rv + 1. ENDIF.
narrowed ?= generic.
IF narrowed = assigned. rv = rv + 1. ENDIF.
DATA(casted) = CAST zif_layer( generic ).
IF casted = assigned. rv = rv + 1. ENDIF.
IF zcl_layer_core=>accepts( concrete ) = abap_true. rv = rv + 1. ENDIF.
IF generic IS INSTANCE OF zif_layer. rv = rv + 1. ENDIF.
ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_LAYER_CORE", "ZCL_LAYER_APP"]});
    const core = join(goDir, "core"), app = join(goDir, "app");
    mkdirSync(core); mkdirSync(app);
    const layer = (name) => ({classes: program.classes.filter((c) => c.name === name),
      externalClasses: new Set(program.classes.filter((c) => c.name !== name).map((c) => c.name))});
    writeFileSync(join(core, "zz_generated.go"), emitGo(program, "core", {
      ...layer("ZCL_LAYER_CORE"), interfaces: new Set(["ZIF_LAYER"]), marker: "GogenCoreLayer",
    }));
    writeFileSync(join(app, "zz_generated.go"), emitGo(program, "app", {
      ...layer("ZCL_LAYER_APP"), interfaces: new Set(),
      imports: [`osg/gogen/cmd/${basename(goDir)}/core`], importMarkers: ["GogenCoreLayer"],
    }));
    writeFileSync(join(app, "layer_test.go"), `package app
import ("testing"; "osg/gogen/abap")
func TestMembership(t *testing.T) {
  if got := ZCL_LAYER_APP_RUN(&abap.Session{}); got != 5 { t.Fatalf("membership checks: got %v, want 5", got) }
}
`);
    const run = spawnSync("go", ["test", `./cmd/${basename(goDir)}/...`], {
      cwd: join(here, "go"), encoding: "utf8", timeout: 120000,
    });
    assert.equal(run.error, undefined, run.stderr);
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("MOVE of flat character components rejoins surrogate halves", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-flat-string-"));
  const goDir = mkdtempSync(join(here, "go", "cmd", "gogen-flat-string-"));
  try {
    writeFileSync(join(sourceDir, "zcl_gogen_flat_string.clas.abap"), `
CLASS zcl_gogen_flat_string DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
CLASS-METHODS run IMPORTING hi TYPE string lo TYPE string RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_flat_string IMPLEMENTATION.
METHOD run.
TYPES: BEGIN OF ty_pair, hi TYPE c LENGTH 1, lo TYPE c LENGTH 1, END OF ty_pair.
DATA pair TYPE ty_pair.
pair-hi = hi.
pair-lo = lo.
rv = pair.
ENDMETHOD.
ENDCLASS.
`);
    const generated = emitGo(compileProgram({folders: [sourceDir], objects: ["ZCL_GOGEN_FLAT_STRING"]}));
    writeFileSync(join(goDir, "zz_generated.go"), generated);
    writeFileSync(join(goDir, "zz_generated_test.go"), `package main
import ("testing"; "osg/gogen/abap")
func TestFlatString(t *testing.T) {
 hi,lo:=abap.SubS("😀",0,1),abap.SubS("😀",1,1)
 got:=ZCL_GOGEN_FLAT_STRING_RUN(&abap.Session{},hi,lo)
 if got!="😀" {t.Fatalf("MOVE bytes=%x, want F09F9880",got)}
}
`);
    const run = spawnSync("go", ["test", `./cmd/${basename(goDir)}`], {cwd: join(here, "go"), encoding: "utf8", timeout: 120000});
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(sourceDir, {recursive: true, force: true});
    rmSync(goDir, {recursive: true, force: true});
  }
});

test("ADT JS host refusals and initial message fields are explicit", async () => {
  const {emitJs} = await import("./emit-js.mjs");
  const {pathToFileURL} = await import("node:url");
  mkdirSync(join(here, ".out"), {recursive: true});
  const dir = mkdtempSync(join(here, ".out", "adt-js-"));
  try {
    writeFileSync(join(dir, "zcl_adt_jscheck.clas.abap"), `
CLASS zcl_adt_jscheck DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS stamp.
 CLASS-METHODS reverse.
 CLASS-METHODS msg EXCEPTIONS failed.
 CLASS-METHODS fields RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_adt_jscheck IMPLEMENTATION.
 METHOD stamp.
 DATA ts TYPE p LENGTH 8 DECIMALS 0 VALUE '20261007231500'.
 DATA d TYPE d.
 CONVERT TIME STAMP ts TIME ZONE 'UTC' INTO DATE d.
 ENDMETHOD.
 METHOD reverse.
 DATA ts TYPE p LENGTH 8 DECIMALS 0.
 DATA d TYPE d VALUE '20261007'.
 DATA t TYPE t.
 CONVERT DATE d TIME t INTO TIME STAMP ts TIME ZONE 'UTC'.
 ENDMETHOD.
 METHOD msg.
 MESSAGE s001(00) RAISING failed.
 ENDMETHOD.
 METHOD fields.
 rv = |{ sy-msgid }/{ sy-msgno }/{ sy-msgty }/{ sy-msgv1 }/{ sy-msgv2 }/{ sy-msgv3 }/{ sy-msgv4 }|.
 ENDMETHOD.
ENDCLASS.`);
    const program = compileProgram({folders: [dir], objects: ["ZCL_ADT_JSCHECK"]});
    assert.deepEqual(program.skipped, []);
    writeFileSync(join(dir, "out.mjs"), emitJs(program, pathToFileURL(join(here, "js", "abap.mjs")).href));
    const {ZCL_ADT_JSCHECK: cls} = await import(pathToFileURL(join(dir, "out.mjs")).href);
    const s = {sy: {}};
    for (const [method, helper] of [["STAMP", "ConvertTimestampInto"], ["REVERSE", "ConvertDateTimeInto"], ["MSG", "MessageRaise"]]) {
      assert.throws(() => cls[method](s), (e) => e.cls === "NOT_COMPILED" && e.message.includes(helper));
    }
    assert.equal(cls.FIELDS(s), "/000/////");
    Object.assign(s.sy, {msgid: "00", msgno: "001", msgty: "E", msgv1: "one", msgv2: "two", msgv3: "three", msgv4: "four"});
    assert.equal(cls.FIELDS(s), "00/001/E/one/two/three/four");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test("move then CLEAR/FREE avoids clones but an enclosing LOOP keeps its copy", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const go = emitGo(program);
  assert.doesNotMatch(go, /NOT_COMPILED in ZCL_GOGEN_T_MOVCLR/);
  assert.match(go, /a = b\b/);
  assert.match(go, /freed = free_src\b/);
  assert.match(go, /deep_a = deep_b\b/);
  assert.match(go, /component_dst.items = component_src.items\b/);
  assert.match(go, /result.items = me.items\b/);
  assert.match(go, /loop_copy = clone_\d+\(loop_src\)/);
  assert.doesNotMatch(go, /(?:a|freed|deep_a) = clone_\d+\((?:b|free_src|deep_b)\)/);
});


test("table moves refuse bindings, aliases, conversions and keyed types", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const method = program.classes[0].methods.find((m) => m.name === "RUN");
  const pair = method.body.find((st) => st.s === "assign" && st.target.name === "A");
  const original = structuredClone(pair);
  const check = (change, extra = []) => {
    const st = structuredClone(original);
    change(st);
    method.body = [st, {s: "clear", target: st.value}, ...extra];
    return emitGo(program);
  };
  assert.match(check(() => {}, [{s: "get_ref", target: {e: "var", name: "r", type: {k: "dref"}}, value: {e: "wrap", x: original.value, type: {k: "data"}}}]), /a = clone_\d+\(b\)/);
  assert.match(check(() => {}, [{s: "read_index", table: original.value, index: {e: "int", value: 1, type: {k: "i"}}, fs: "fs"}]), /a = clone_\d+\(b\)/);
  assert.match(check((st) => { st.target = st.value; }), /b = clone_\d+\(b\)/);
  assert.match(check((st) => { st.value.ref = true; }), /a = clone_\d+\(\(\*b\)\)/);
  for (const key of ["sorted", "hashed", "secondary"]) {
    assert.match(check((st) => { st.target.type[key] = st.value.type[key] = key === "secondary" ? [{name: "SK", comps: [], unique: false}] : []; }), /a = clone_\d+\(b\)/);
  }
  assert.match(check((st) => { st.target.type.row = {k: "int8"}; }), /a = clone_\d+\(b\)/);
  assert.match(check((st) => { st.target = {...st.target, e: "attr"}; st.value = {...st.value, e: "attr"}; }), /me.a = clone_\d+\(me.b\)/);
});

test("a binding through a CHANGING parameter alias keeps the clone", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const method = program.classes[0].methods.find((m) => m.name === "RUN");
  const pair = method.body.find((st) => st.s === "assign" && st.target.name === "A");
  method.params.push({name: "ALIAS", type: pair.value.type, dir: "changing"});
  method.fieldSymbols.push({name: "<R>", type: pair.value.type.row});
  // The caller may pass B as ALIAS. Its binding path is unknown even though
  // the assignment's source is ordinary, non-reference local storage.
  method.body = [{s: "read_index", table: {e: "var", name: "ALIAS", ref: true, type: pair.value.type},
    index: {e: "int", value: 1, type: {k: "i"}}, fs: "<R>"}, pair, {s: "clear", target: pair.value}];
  assert.match(emitGo(program), /a = clone_\d+\(b\)/);
});

test("a caller binding an attribute keeps the moving method's clone", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const cls = program.classes[0], caller = cls.methods.find((m) => m.name === "RUN");
  const take = cls.methods.find((m) => m.name === "TAKE"), pair = take.body[1];
  assert.match(emitGo(program), /result.items = me.items\b/);
  const call = caller.body.findIndex((st) => st.s === "assign" && st.target.name === "RESULT");
  caller.fieldSymbols.push({name: "<R>", type: pair.value.type.row});
  // A separate type object mirrors frontend typeOf's per-access types.
  caller.body.splice(call, 0, {s: "read_index", table: {e: "refattr",
    base: {e: "var", name: "OBJ", type: take.returning.type}, name: "ITEMS", type: structuredClone(pair.value.type)},
    index: {e: "int", value: 1, type: {k: "i"}}, fs: "<R>"});
  assert.equal(pair.value.type.stable, undefined);
  assert.match(emitGo(program), /result.items = clone_\d+\(me.items\)/);
  caller.body.splice(call, 1);
  for (const expr of [pair.target, pair.value]) expr.type.stable = true;
  assert.match(emitGo(program), /result.items = clone_\d+\(me.items\)/);
});

test("a callee binding into a local table passed by reference keeps the caller's clone", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const cls = program.classes[0], method = cls.methods.find((m) => m.name === "RUN");
  const pair = method.body.find((st) => st.s === "assign" && st.target.name === "A");
  assert.match(emitGo(program), /a = b\b/);
  // A helper given B by reference can hand its row binding back.
  const helper = cls.methods.find((m) => m !== method);
  helper.fieldSymbols.push({name: "<ROW>", type: pair.value.type.row});
  method.body.unshift({s: "call", call: {e: "call", owner: cls.name, method: helper.name, static: true,
    args: [{dir: "importing", byValue: false, value: pair.value}], type: {k: "void"}}});
  helper.body.unshift({s: "read_index", table: {e: "var", name: "TAB", type: structuredClone(pair.value.type)},
    index: {e: "int", value: 1, type: {k: "i"}}, fs: "<ROW>"});
  assert.match(emitGo(program), /a = clone_\d+\(b\)/);
});

test("a binding into a table nested in a moved table's row keeps the clone", () => {
  const program = compileProgram({folders: [join(here, "testdata-move")], objects: ["ZCL_GOGEN_T_MOVNEST"]});
  const go = emitGo(program);
  assert.doesNotMatch(go, /NOT_COMPILED in ZCL_GOGEN_T_MOVNEST/);
  assert.match(go, /result.items = clone_\d+\(me.items\)/);
});


function compileMoveReach({direction = "IMPORTING", actual = "other", dynamic = false, byValue = false} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-move-reach-"));
  try {
    writeFileSync(join(dir, "zcl_move_reach.clas.abap"), `
CLASS zcl_move_reach DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF row, n TYPE i, END OF row.
    TYPES rows TYPE STANDARD TABLE OF row WITH EMPTY KEY.
    DATA items TYPE rows.
    METHODS take RETURNING VALUE(result) TYPE REF TO zcl_move_reach.
    CLASS-METHODS bind ${direction} ${byValue ? "VALUE(tab)" : "tab"} TYPE ANY TABLE.
    CLASS-METHODS run.
    CLASS-METHODS dynamic.
ENDCLASS.
CLASS zcl_move_reach IMPLEMENTATION.
  METHOD take.
    CREATE OBJECT result.
    result->items = items.
    CLEAR items.
  ENDMETHOD.
  METHOD bind.
    FIELD-SYMBOLS <fs> TYPE any.
    LOOP AT tab ASSIGNING <fs>.
    ENDLOOP.
  ENDMETHOD.
  METHOD run.
    DATA a TYPE rows.
    DATA b TYPE rows.
    DATA other TYPE STANDARD TABLE OF string WITH EMPTY KEY.
    ${direction === "CHANGING" ? `bind( CHANGING tab = ${actual} ).` : `bind( ${actual} ).`}
    a = b.
    FREE b.
  ENDMETHOD.
  METHOD dynamic.
    ${dynamic ? `DATA name TYPE string.
    FIELD-SYMBOLS <fs> TYPE any.
    name = 'ITEMS'.
    ${typeof dynamic === "string" ? dynamic : "ASSIGN (name) TO <fs>."}` : ""}
  ENDMETHOD.
ENDCLASS.
`);
    return compileProgram({folders: [dir], objects: ["ZCL_MOVE_REACH"]});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test("an unrelated generic table binding permits the move", () => {
  const go = emitGo(compileMoveReach());
  assert.doesNotMatch(go, /NOT_COMPILED/);
  assert.match(go, /a = b\b/);
  assert.match(go, /result.items = me.items\b/);
});

test("generic by-reference IMPORTING and CHANGING escape the source storage", () => {
  for (const direction of ["IMPORTING", "CHANGING"]) {
    const program = compileMoveReach({direction, actual: "b"});
    const lines = [], oldError = console.error, oldTrace = process.env.GOGEN_MOVE_TRACE;
    let go;
    try {
      process.env.GOGEN_MOVE_TRACE = "1";
      console.error = (line) => lines.push(line);
      go = emitGo(program);
    } finally {
      console.error = oldError;
      if (oldTrace === undefined) delete process.env.GOGEN_MOVE_TRACE;
      else process.env.GOGEN_MOVE_TRACE = oldTrace;
    }
    assert.doesNotMatch(go, /NOT_COMPILED/);
    assert.match(go, /a = clone_\d+\(b\)/);
    assert.ok(lines.some((line) => /ZCL_MOVE_REACH=>RUN.*escapedStorage local:ZCL_MOVE_REACH=>RUN:B by ZCL_MOVE_REACH=>RUN call/.test(line)), lines.join("\n"));
  }
  assert.match(emitGo(compileMoveReach({actual: "b", byValue: true})), /a = b\b/);
});

test("dynamic ASSIGN by name escapes attributes but not unrelated locals", () => {
  const go = emitGo(compileMoveReach({dynamic: true}));
  // This ASSIGN form is a runtime stub today; its conservative escape must
  // still protect attributes when another method performs the move.
  assert.match(go, /ASSIGN form/);
  assert.match(go, /result.items = clone_\d+\(me.items\)/);
  assert.match(go, /a = b\b/);
});


test("inline FIELD-SYMBOL parentheses do not imply dynamic name access", () => {
  const program = compileMoveReach();
  program.classes[0].methods.find((m) => m.name === "DYNAMIC").body = [
    {s: "stub", where: "probe", reason: "ASSIGN form: ASSIGN COMPONENT 'VALUE' OF STRUCTURE <row> TO FIELD-SYMBOL(<value>)."},
  ];
  const go = emitGo(program);
  assert.match(go, /a = b\b/);
  assert.match(go, /result.items = me.items\b/);
});

test("binding a whole typed structure protects its contained table rows", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const cls = program.classes[0], method = cls.methods.find((m) => m.name === "RUN");
  const source = method.locals.find((l) => l.name === "COMPONENT_SRC");
  method.body.unshift({s: "get_ref", target: {e: "var", name: "r", type: {k: "dref"}},
    value: {e: "var", name: source.name, type: source.type}});
  assert.match(emitGo(program), /component_dst.items = clone_\d+\(component_src.items\)/);
});


test("binding a structure scalar field does not bind independent table rows of that type", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const helper = program.classes[0].methods.find((m) => m.name === "TAKE");
  const row = {k: "struct", go: "SCALAR_MAPPING"}, table = {k: "table", row};
  program.structs.set(row.go, {...row, fields: [{name: "VALUE", type: {k: "i"}}]});
  helper.locals.push({name: "MAPPING", type: table});
  helper.fieldSymbols.push({name: "<MAP>", type: row});
  helper.body.unshift({s: "read_index", table: {e: "var", name: "MAPPING", type: table},
    index: {e: "int", value: 1, type: {k: "i"}}, fs: "<MAP>"});
  assert.match(emitGo(program), /a = b\b/);
});


test("a typed helper binding a nested-table actual protects the containing rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-move-nested-actual-"));
  try {
    writeFileSync(join(dir, "zcl_move_nested_actual.clas.abap"), `
CLASS zcl_move_nested_actual DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES ints TYPE STANDARD TABLE OF i WITH EMPTY KEY.
    TYPES: BEGIN OF row, items TYPE ints, END OF row.
    TYPES rows TYPE STANDARD TABLE OF row WITH EMPTY KEY.
    CLASS-METHODS bind IMPORTING tab TYPE ints.
    CLASS-METHODS run.
ENDCLASS.
CLASS zcl_move_nested_actual IMPLEMENTATION.
  METHOD bind.
    FIELD-SYMBOLS <n> TYPE i.
    LOOP AT tab ASSIGNING <n>.
    ENDLOOP.
  ENDMETHOD.
  METHOD run.
    DATA a TYPE rows.
    DATA b TYPE rows.
    bind( b[ 1 ]-items ).
    a = b.
    CLEAR b.
  ENDMETHOD.
ENDCLASS.
`);
    const go = emitGo(compileProgram({folders: [dir], objects: ["ZCL_MOVE_NESTED_ACTUAL"]}));
    assert.doesNotMatch(go, /NOT_COMPILED/);
    assert.match(go, /a = clone_\d+\(b\)/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test("typed-to-generic forwarding with an exported row reference keeps the clone", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVFWD"]});
  const go = emitGo(program);
  assert.doesNotMatch(go, /NOT_COMPILED/);
  assert.match(go, /a = clone_\d+\(b\)/);
  assert.match(go, /ZCL_GOGEN_T_MOVFWD_BIND\(s, abap.Data/);
  assert.match(go, /ZCL_GOGEN_T_MOVFWD_WRITE\(s, r\)/);
});

test("a by-reference scalar actual outside table storage does not escape table rows", () => {
  const program = compileMoveReach();
  const run = program.classes[0].methods.find((m) => m.name === "RUN");
  const pair = run.body.find((st) => st.s === "assign" && st.target.name === "A");
  pair.target.type.row = pair.value.type.row = {k: "i"};
  const scalar = {e: "var", name: "N", type: {k: "i"}};
  run.locals.push({name: "N", type: scalar.type});
  run.body.unshift({s: "call", call: {e: "call", owner: "ZCL_MOVE_REACH", method: "SCALAR", static: true,
    args: [{dir: "importing", byValue: false, type: scalar.type, value: scalar}], type: {k: "void"}}});
  const go = emitGo(program);
  assert.match(go, /a = b\b/);
  assert.match(go, /result.items = me.items\b/);
});


test("an unrelated generic loop_data binding does not taint string attributes", () => {
  const program = compileMoveReach();
  const cls = program.classes[0], take = cls.methods.find((m) => m.name === "TAKE");
  for (const expr of [take.body[1].target, take.body[1].value]) expr.type.row = {k: "string"};
  cls.attributes.find((a) => a.name === "ITEMS").type.row = {k: "string"};
  assert.match(emitGo(program), /result.items = me.items\b/);
});

test("dynamic object attribute names escape all attributes; literals escape only that name", () => {
  for (const [operand, refused] of [["name", true], ["'ITEMS'", true], ["'OTHER'", false]]) {
    const program = compileMoveReach({dynamic:
      `DATA obj TYPE REF TO zcl_move_reach. ASSIGN obj->(${operand}) TO <fs>.`});
    const body = program.classes[0].methods.find((m) => m.name === "DYNAMIC").body;
    assert.ok(body.some((st) => st.s === "stub" && st.reason.includes(`obj->(${operand})`)), JSON.stringify(body));
    const go = emitGo(program);
    if (refused) assert.match(go, /result.items = clone_\d+\(me.items\)/);
    else assert.match(go, /result.items = me.items\b/);
    assert.match(go, /a = b\b/);
  }
});

test("a binding made in the constructor keeps the clone (044 critic round 5)", () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZCL_GOGEN_T_MOVCLR"]});
  const cls = program.classes[0];
  assert.match(emitGo(program), /result.items = me.items\b/);
  const take = cls.methods.find((m) => m.name === "TAKE"), pair = take.body.find((st) => st.s === "assign" && st.target.e === "refattr");
  cls.constructor ??= {name: "CONSTRUCTOR", params: [], body: [], fieldSymbols: [], locals: []};
  cls.constructor.fieldSymbols = [...(cls.constructor.fieldSymbols ?? []), {name: "<ROW>", type: pair.value.type.row}];
  cls.constructor.body = [{s: "read_index", table: pair.value, index: {e: "int", value: 1, type: {k: "i"}}, fs: "<ROW>"}, ...(cls.constructor.body ?? [])];
  assert.match(emitGo(program), /result.items = clone_\d+\(me.items\)/);
});


test("generic TABLES retain the caller descriptor in both emitters", async () => {
  const program = compileProgram({folders: [join(here, "testdata")], objects: ["ZGOGEN_T_FG", "ZCL_GOGEN_T_BINARY"]});
  const go = emitGo(program);
  assert.match(go, /ZGOGEN_T_BINARY\(s \*abap.Session, ev_text \*string, binary_tab \*abap.Data\)/);
  assert.match(go, /_ls_row_ = abap.Row\(tab\d+, i\d+\)/);
  assert.doesNotMatch(go, /BindRow\(&\(\*binary_tab\)/);
  assert.doesNotMatch(go, /ASSIGN COMPONENT by a i/);
  const {emitJs} = await import("./emit-js.mjs");
  const js = emitJs(program);
  assert.match(js, /_ls_row_ = abap.Row\(tab\d+, i\d+\)/);
});

test("JS positional components retain writable storage and reject invalid positions", () => {
  const row = {first: "\x01\x02", second: "Q"};
  const t = {kind: "u", comps: [{name: "FIRST", key: "first", t: TX(2)}, {name: "SECOND", key: "second", t: {kind: "C", len: 1}}]};
  const d = cell(row, t);
  const c = Component(d, 1);
  assert.equal(DataString(c), "0102");
  MoveData(c, cell("\xCC\xDD", TX(2)));
  assert.equal(row.first, "\xCC\xDD");
  assert.equal(DataString(Component(d, 2)), "Q");
  for (const i of [-1, 0, 3]) assert.equal(Component(d, i), null);
  assert.equal(Component(cell("x", {kind: "C", len: 1}), 1), null);
  assert.equal(Component(null, 1), null);
});
