// Focused end-to-end check for the native report host. It intentionally uses
// the local open-abap-gui/core checkouts, just like osabap.mjs itself.
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync, spawn, spawnSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builder = join(here, "osabap.mjs");
const binary = join(here, ".out", "osabap");

execFileSync(process.execPath, [builder], {stdio: "inherit"});
// the SAP GUI test is written against hello's generated types (osabap_hello)
execFileSync("go", ["test", "-tags", "nodatabase,osabap_hello", "./cmd/osabap"], {
  cwd: join(here, "go"), stdio: "inherit",
});

const run = (args, input) => spawnSync(binary, args, {encoding: "utf8", input});

test("hello symbol map distinguishes converter scaffolding from report events", () => {
  const {symbols} = JSON.parse(readFileSync(join(here, "go/cmd/osabap/symbols.json"), "utf8"));
  for (const method of ["ZIF_GG_TRANSACTION_V1__GET_TRANSACTION", "ZIF_GG_REPORT_V1__LOAD_OF_PROGRAM"]) {
    const helper = symbols[`main.(*ZCL_OSABAP_HELLO).${method}`];
    assert.ok(helper, method);
    assert.equal(helper.kind, "generated", method);
    assert.equal("file" in helper, false, method);
    assert.equal("line" in helper, false, method);
  }
  const event = symbols["main.(*ZCL_OSABAP_HELLO).ZIF_GG_REPORT_V1__START_OF_SELECTION"];
  assert.equal(event.kind, "event");
  assert.equal(event.abap, "ZHELLO (START-OF-SELECTION)");
  assert.equal(event.file, "zhello.prog.abap");
  assert.equal(event.line, 7);
});

test("positionals and repeatable select-option flags", () => {
  const result = run(["Alice", "--s-tag", "alpha", "--s-tag", "beta"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Hello Alice\nTags 2\n");
});

test("named flags and JSON ranges use the same report lifecycle", () => {
  const ranges = ["one", {low: "a", high: "z"}, {sign: "E", option: "CP", low: "tmp*"}];
  const result = run(["--name", "Bob", "--loud", "-params", JSON.stringify({S_TAG: ranges})]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Hello BOB\nTags 3\n");
});

test("no arguments presents the selection screen", () => {
  const result = run([], "Cara\nyes\nred,green\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ZHELLO . selection screen/);
  assert.match(result.stdout, /Hello CARA\nTags 2\n$/);
});

test("unknown options fail instead of becoming report input", () => {
  const result = run(["--unknown"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown report option --unknown; the report's options are --name .*--s-tag/);
  const flag = run(["-unknown"]);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /unknown flag -unknown; the host's flags are -help .*-db/);
});

// two namespaces: one dash for the host, two for the report (Alice, 2026-09-30)
test("host flags take one dash, report options two", () => {
  const help = run(["-help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /report options[\s\S]*--name[\s\S]*host flags \(one dash\):[\s\S]*-allow-read DIR/);
  const doubleHelp = run(["--help"]);
  assert.equal(doubleHelp.status, 1);
  assert.match(doubleHelp.stderr, /-help shows the usage/);
  const negative = run(["-5"]);
  assert.equal(negative.status, 1);
  assert.match(negative.stderr, /goes after its option, as in --name -5/);
  const value = run(["--name", "-5"]);
  assert.equal(value.status, 0, value.stderr);
  assert.match(value.stdout, /^Hello -5/);
  // the old double-dash spelling of a host flag, for one release, with a warning
  const old = run(["--name", "Ann", "--allow-read", tmpdir()]);
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stderr, /--allow-read is -allow-read now/);
});

test("help describes dataset grants", () => {
  const result = run(["-help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ["-allow-read", "-allow-write", "-dataset-home", "-dataset-audit"]) {
    assert.ok(result.stdout.includes(flag), flag);
  }
});

test("native frontend reads environment and copies a text file", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-frontend-"));
  try {
    const input = join(dir, "input.txt");
    const output = join(dir, "output.txt");
    writeFileSync(input, "one\ntwo\n");
    execFileSync(process.execPath, [builder, join(here, "apps", "io", "zio.prog.abap")], {stdio: "inherit"});
    const env = {...process.env, OSABAP_TEST_ENV: "works"};
    // GUI_UPLOAD / GUI_DOWNLOAD go through the DATASET sandbox: no grant, no file
    const refused = spawnSync(binary, ["--input", input, "--output", output], {encoding: "utf8", env});
    assert.notEqual(refused.status, 0, "an ungranted upload must be refused");
    const result = spawnSync(binary, ["-allow-read", dir, "-allow-write", dir, "--input", input, "--output", output], {
      encoding: "utf8", env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Copied 2 lines 8 bytes\nEnv works\n");
    assert.equal(readFileSync(output, "utf8"), "one\ntwo\n");
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("native DATASET copy obeys read, write and path grants", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-dataset-"));
  try {
    const inputDir = join(dir, "in");
    const outputDir = join(dir, "out");
    mkdirSync(inputDir);
    mkdirSync(outputDir);
    const input = join(inputDir, "source.txt");
    const output = join(outputDir, "copy.txt");
    const audit = join(outputDir, "audit.ndjson");
    const content = "one\ntwo\n";
    writeFileSync(input, content);
    execFileSync(process.execPath, [builder, join(here, "apps", "dataset", "zdataset.prog.abap")], {stdio: "inherit"});

    const allowed = run(["-allow-read", inputDir, "-allow-write", outputDir, "-dataset-audit", audit, "--input", input, "--output", output]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /Copied\s+2 lines, at byte\s+8/);
    assert.match(allowed.stdout, /Head 6F6E65\s+3/);
    assert.equal(readFileSync(output, "utf8"), content);
    assert.match(readFileSync(audit, "utf8"), /"allowed":true/);
    rmSync(output);

    const escapedAudit = join(dir, "escaped-audit.ndjson");
    const auditOutsideRoot = run(["-allow-read", inputDir, "-allow-write", outputDir,
      "-dataset-audit", escapedAudit, "--input", input, "--output", output]);
    assert.equal(auditOutsideRoot.status, 0, auditOutsideRoot.stderr);
    assert.equal(existsSync(escapedAudit), false);
    rmSync(output);

    const linkedAudit = join(outputDir, "linked-audit.ndjson");
    symlinkSync(escapedAudit, linkedAudit);
    const auditViaLink = run(["-allow-read", inputDir, "-allow-write", outputDir,
      "-dataset-audit", linkedAudit, "--input", input, "--output", output]);
    assert.equal(auditViaLink.status, 0, auditViaLink.stderr);
    assert.equal(existsSync(escapedAudit), false);
    rmSync(output);

    const joinedRoots = run(["-allow-read", `${outputDir}${delimiter}${inputDir}`, "-allow-write", outputDir,
      "--input", input, "--output", output]);
    assert.equal(joinedRoots.status, 1);
    assert.match(joinedRoots.stderr, /one directory per flag/);
    assert.equal(existsSync(output), false);

    const denied = spawnSync(binary, ["--input", input, "--output", output], {
      encoding: "utf8", env: {...process.env, OSD_DATASET_READ: inputDir, OSD_DATASET_WRITE: outputDir},
    });
    assert.equal(denied.status, 0, denied.stderr);
    assert.match(denied.stdout, /^Refused Permission denied/);
    assert.equal(existsSync(output), false);

    const wrongReadRoot = run(["-allow-read", outputDir, "-allow-write", outputDir,
      "--input", input, "--output", output]);
    assert.equal(wrongReadRoot.status, 0, wrongReadRoot.stderr);
    assert.match(wrongReadRoot.stdout, /^Refused Permission denied/);
    assert.equal(existsSync(output), false);

    const readOnly = run(["-allow-read", inputDir, "--input", input, "--output", output]);
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.match(readOnly.stdout, /Refused/);
    assert.equal(existsSync(output), false);

    const escaped = join(dir, "escape.txt");
    const escape = run(["-allow-read", inputDir, "-allow-write", outputDir, "-dataset-home", outputDir,
      "--input", input, "--output", "../escape.txt"]);
    assert.equal(escape.status, 0, escape.stderr);
    assert.match(escape.stdout, /Refused/);
    assert.equal(existsSync(escaped), false);

    const unicode = "one\nGrüße 世界\n\nlast\n";
    writeFileSync(input, unicode);
    const unicodeCopy = run(["-allow-read", inputDir, "-allow-write", outputDir,
      "--input", input, "--output", output]);
    assert.equal(unicodeCopy.status, 0, unicodeCopy.stderr);
    assert.equal(readFileSync(output, "utf8"), unicode);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// A report with a table of its own (apps/notes: ZNOTES beside the report):
// its rows live in the SQLite file -db names, created with the report's
// tables when missing; without -db it refuses and names the flag; the file
// alone holds the rows once the command ends; a file laid out by another
// build of the table is refused rather than used. The report is built from
// a copy, so the tracked table is never edited.
test("a report's own table lives in the -db file", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-db-"));
  try {
    const app = join(dir, "notes");
    cpSync(join(here, "apps", "notes"), app, {recursive: true});
    const report = join(app, "znotes.prog.abap");
    execFileSync(process.execPath, [builder, report], {stdio: "inherit"});
    const help = run(["-help"]);
    assert.match(help.stdout, /-db FILE .*ZNOTES/);

    const without = run(["--add", "hello"]);
    assert.equal(without.status, 1);
    assert.match(without.stderr, /znotes keeps its rows in tables \(ZNOTES\): run it with -db FILE/);

    const file = join(dir, "notes.db");
    const first = run(["-db", file, "--add", "hello"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "1 hello\n1 notes\n");
    // a second run of the command finds the first run's row
    const second = run(["-db", file, "--add", "second note"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, "1 hello\n2 second note\n2 notes\n");

    // the file alone is the data: no -wal left behind, and a copy of just
    // the file reads back every row
    assert.equal(existsSync(`${file}-wal`), false);
    const copy = join(dir, "copy.db");
    cpSync(file, copy);
    const fromCopy = run(["-db", copy, "--add", "third"]);
    assert.equal(fromCopy.status, 0, fromCopy.stderr);
    assert.equal(fromCopy.stdout, "1 hello\n2 second note\n3 third\n3 notes\n");

    const odd = run(["-db", join(dir, "we?ird.db"), "--add", "x"]);
    assert.equal(odd.status, 1);
    assert.match(odd.stderr, /a file name with \?, # or % is not accepted/);

    // the same table with a longer TEXT: the file was laid out by another build
    const tabl = join(app, "znotes.tabl.xml");
    writeFileSync(tabl, readFileSync(tabl, "utf8").replace("<LENG>000080</LENG>", "<LENG>000120</LENG>").replace("<INTLEN>000160</INTLEN>", "<INTLEN>000240</INTLEN>"));
    execFileSync(process.execPath, [builder, report], {stdio: "inherit"});
    const drifted = run(["-db", file, "--add", "x"]);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /seeded by another build/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("six SQL corpus forms read the notes rows through the native report", {timeout: 120000}, () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-sql-rows-"));
  try {
    const app = join(dir, "notes");
    cpSync(join(here, "apps", "notes"), app, {recursive: true});
    const db = join(dir, "notes.db");
    execFileSync(process.execPath, [builder, join(app, "znotes.prog.abap")], {stdio: "inherit"});
    for (const value of ["alpha", "beta", "alpha", "gamma", "beta", "alpha", "gamma", "beta", "alpha", "gamma", "beta", "alpha"]) {
      const added = run(["-db", db, "--add", value]);
      assert.equal(added.status, 0, added.stderr);
    }
    writeFileSync(join(app, "zcl_sql_corpus_groups.clas.abap"), `
CLASS zcl_sql_corpus_groups DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_sql_corpus_groups IMPLEMENTATION.
  METHOD run.
    DATA gv_text TYPE string.
    DATA gv_count TYPE i.
    SELECT text COUNT(*) FROM znotes INTO (gv_text, gv_count) GROUP BY text.
      rv = rv && gv_text && ':' && gv_count && ';'.
    ENDSELECT.
    rv = rv && '/' && sy-dbcnt.
  ENDMETHOD.
ENDCLASS.
`);
    const report = join(app, "zsqlrows.prog.abap");
    writeFileSync(report, `REPORT zsqlrows.
PARAMETERS p_id TYPE i.
DATA gt_notes TYPE STANDARD TABLE OF znotes WITH DEFAULT KEY.
DATA gt_sorted TYPE SORTED TABLE OF znotes WITH UNIQUE KEY id.
DATA gt_sorted_multi TYPE SORTED TABLE OF znotes WITH NON-UNIQUE KEY text.
DATA gt_hash TYPE HASHED TABLE OF znotes WITH UNIQUE KEY id.
DATA gt_sorted_text TYPE SORTED TABLE OF znotes WITH UNIQUE KEY text.
DATA gt_hash_text TYPE HASHED TABLE OF znotes WITH UNIQUE KEY text.
DATA gs_note TYPE znotes.
DATA gv_max TYPE i.
DATA gv_rc TYPE i.
DATA gv_limit TYPE i.
DATA gv_group TYPE string.
DATA gv_name TYPE string.
DATA gv_n TYPE i.
START-OF-SELECTION.
  SELECT MAX( id ) FROM znotes INTO gv_max.
  gv_rc = sy-subrc.
  WRITE: / 'MAX', gv_max, gv_rc, sy-dbcnt.
  gv_limit = 10.
  SELECT * FROM znotes INTO TABLE gt_notes UP TO gv_limit ROWS ORDER BY id DESCENDING.
  READ TABLE gt_notes INTO gs_note INDEX 1.
  WRITE: / 'TOP', lines( gt_notes ), gs_note-id.
  SELECT * FROM znotes APPENDING TABLE gt_notes WHERE id > 10.
  WRITE: / 'APPEND', lines( gt_notes ), sy-dbcnt.
  SELECT * FROM znotes INTO TABLE gt_sorted.
  READ TABLE gt_sorted INTO gs_note INDEX 1.
  WRITE: / 'SORTED', lines( gt_sorted ), gs_note-id.
  SELECT * FROM znotes INTO TABLE gt_sorted_multi.
  READ TABLE gt_sorted_multi INTO gs_note INDEX 1.
  WRITE: / 'SORTED-MULTI', lines( gt_sorted_multi ), gs_note-text.
  SELECT * FROM znotes INTO TABLE gt_hash.
  WRITE: / 'HASHED', lines( gt_hash ).
  SELECT id, text FROM znotes WHERE id >= @p_id INTO TABLE @DATA(lt_new).
  WRITE: / 'INLINE', lines( lt_new ), sy-dbcnt.
  gv_group = zcl_sql_corpus_groups=>run( ).
  WRITE: / 'GROUP', gv_group.
  CLEAR gv_group.
  SELECT text COUNT(*) FROM znotes INTO (gv_name, gv_n) GROUP BY text.
    gv_group = gv_group && gv_name && ':' && gv_n && ':' && 'p_id' && ';'.
  ENDSELECT.
  WRITE: / 'NATIVE', gv_group.
  IF p_id = 0.
    SELECT * FROM znotes INTO TABLE gt_sorted_text.
  ELSEIF p_id = 1.
    SELECT * FROM znotes APPENDING TABLE gt_sorted_text.
  ELSEIF p_id = 2.
    SELECT * FROM znotes INTO TABLE gt_hash_text.
  ELSEIF p_id = 3.
    SELECT * FROM znotes APPENDING TABLE gt_hash_text.
  ENDIF.
`);
    execFileSync(process.execPath, [builder, report], {stdio: "inherit"});
    const result = run(["-db", db, "--p-id", "10"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MAX\s+12\s+0\s+1/);
    assert.match(result.stdout, /TOP\s+10\s+12/);
    assert.match(result.stdout, /APPEND\s+12\s+2/);
    assert.match(result.stdout, /SORTED\s+12\s+1/);
    assert.match(result.stdout, /SORTED-MULTI\s+12\s+alpha/);
    assert.match(result.stdout, /HASHED\s+12/);
    assert.match(result.stdout, /INLINE\s+3\s+3/);
    assert.match(result.stdout, /GROUP\s+alpha:5;beta:4;gamma:3;\/3/);
    assert.match(result.stdout, /NATIVE\s+alpha:5:p_id;beta:4:p_id;gamma:3:p_id;/);
    const empty = run(["-db", join(dir, "empty.db"), "--p-id", "10"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /MAX\s+0\s+0\s+1/);
    for (const target of [0, 1, 2, 3]) {
      const duplicate = run(["-db", db, "--p-id", String(target)]);
      assert.equal(duplicate.status, 1, `target ${target}: ${duplicate.stderr}`);
      assert.match(duplicate.stderr, /ITAB_DUPLICATE_KEY/);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("a report without tables refuses -db", () => {
  execFileSync(process.execPath, [builder], {stdio: "inherit"});
  const result = run(["Alice", "-db", join(tmpdir(), "osabap-never.db")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /-db: ZHELLO has no tables of its own/);
});

// A report's own classes beside it, and classes from a --lib folder, are
// compiled with it (apps/greet: ZGREET calls ZCL_GREET_TEXT).
test("the classes beside a report, or in a --lib folder, are part of it", () => {
  execFileSync(process.execPath, [builder, join(here, "apps", "greet", "zgreet.prog.abap")], {stdio: "inherit"});
  const beside = run(["--name", "Ann"]);
  assert.equal(beside.status, 0, beside.stderr);
  assert.equal(beside.stdout, "Hello, Ann!\n");
  // the selection text from zgreet.prog.xml (TPOOL, ID S) labels the field
  assert.match(run(["-help"]).stdout, /--name\s+Who to greet \(P_NAME, value\)/);
  assert.match(run([], "Bo\n").stdout, /Who to greet/);

  const dir = mkdtempSync(join(tmpdir(), "osabap-lib-"));
  try {
    mkdirSync(join(dir, "report"));
    mkdirSync(join(dir, "lib"));
    cpSync(join(here, "apps", "greet", "zgreet.prog.abap"), join(dir, "report", "zgreet.prog.abap"));
    cpSync(join(here, "apps", "greet", "zcl_greet_text.clas.abap"), join(dir, "lib", "zcl_greet_text.clas.abap"));
    execFileSync(process.execPath, [builder, join(dir, "report", "zgreet.prog.abap"), "--lib", join(dir, "lib")], {stdio: "inherit"});
    const fromLib = run(["--name", "Bo"]);
    assert.equal(fromLib.status, 0, fromLib.stderr);
    assert.equal(fromLib.stdout, "Hello, Bo!\n");
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// MESSAGE TYPE 'E', 'A', 'W' or 'X' in a FORM raises ZCX_GG_CONTROL_FLOW, an
// open-abap-gui host class whose superclass CX_NO_CHECK only the host classes
// name; it ends the run with the text on stderr and exit status 1, as a
// background job with one is cancelled (apps/message)
test("an E, A, W or X message ends the run with status 1, I, S and DISPLAY LIKE 'E' do not", () => {
  execFileSync(process.execPath, [builder, join(here, "apps", "message", "zmessage.prog.abap")], {stdio: "inherit"});
  for (const [mode, text, status, stdout] of [
    ["E", "bad input", 1, "before\n"],
    ["A", "abort", 1, "before\n"],
    ["W", "warning", 1, "before\n"],
    ["X", "dump", 1, "before\n"],
    ["I", "info", 0, "before\nafter\n"],
    ["S", "status", 0, "before\nafter\n"],
    ["D", "looks bad", 0, "before\nafter\n"],
  ]) {
    const result = run(["--mode", mode]);
    assert.equal(result.status, status, `${mode}: ${result.stderr}`);
    assert.equal(result.stderr, text + "\n", mode);
    // the chained WRITE keeps the comma inside its template as one operand
    assert.equal(result.stdout, `mode ${mode}, then ` + stdout, mode);
  }
});

test("MEMORY ID checkbox is a memory id, not a checkbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-memid-"));
  try {
    writeFileSync(join(dir, "zmemid.prog.abap"), [
      "REPORT zmemid.",
      "PARAMETERS p_mem TYPE c LENGTH 10 MEMORY ID checkbox LOWER CASE.",
      "PARAMETERS p_cb AS CHECKBOX.",
      "DATA gv_n TYPE i.",
      "SELECT-OPTIONS s_m FOR gv_n MEMORY ID checkbox.",
      "START-OF-SELECTION.",
      "  WRITE: / p_mem, p_cb.",
      "  gv_n = lines( s_m ).",
      "  WRITE: / 'ranges', gv_n.",
      ""].join("\n"));
    execFileSync(process.execPath, [builder, join(dir, "zmemid.prog.abap")], {stdio: "inherit"});
    const out = run(["--mem", "hello", "--cb"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^hello\s+X\nranges\s+0\n$/);
    // a select-option with MEMORY ID checkbox stays a range: repeatable, with values
    const range = run(["--mem", "x", "--s-m", "3", "--s-m", "5"]);
    assert.equal(range.status, 0, range.stderr);
    assert.match(range.stdout, /ranges\s+2\n$/);
    const positional = run(["hi"]);
    assert.equal(positional.status, 0, positional.stderr);
    assert.match(positional.stdout, /^hi\b/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// F8 on a report (0.5 O): `osd run` builds it with osabap, keeps the command
// by the hash of what the build read, and passes the arguments through. The
// second run of the same source does not build; an edit of the report does;
// one bare `--` after the report is osd's, so -help reaches the report.
test("osd run builds a report once, keeps it and passes its arguments through", () => {
  const dir = mkdtempSync(join(tmpdir(), "osd-run-"));
  const osd = join(here, "..", "..", "bin", "osd.mjs");
  // the kept builds go to the test's own folder, not the checkout's .local
  const osdRun = (args) => spawnSync(process.execPath, [osd, "run", ...args], {encoding: "utf8", env: {...process.env, OSD_RUN_CACHE: join(dir, "cache")}});
  try {
    const app = join(dir, "notes");
    cpSync(join(here, "apps", "notes"), app, {recursive: true});
    const report = join(app, "znotes.prog.abap");
    const file = join(dir, "notes.db");
    // a folder of the user's own in the cache directory is not osd's to prune
    mkdirSync(join(dir, "cache", "mine"), {recursive: true});
    const first = osdRun([report, "-db", file, "--add", "hello"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /osd run: building znotes\.prog\.abap/);
    assert.equal(first.stdout, "1 hello\n1 notes\n");

    const second = osdRun([report, "-db", file, "--add", "again"]);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /building/);
    assert.equal(second.stdout, "1 hello\n2 again\n2 notes\n");

    const help = osdRun([report, "--", "-help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /-db FILE .*ZNOTES/);

    // a layer flag is the report's, not osd's: the report refuses it
    const layer = osdRun([report, "--layer", dir]);
    assert.notEqual(layer.status, 0);

    writeFileSync(report, readFileSync(report, "utf8") + "\n* edited\n");
    const edited = osdRun([report, "-db", file, "--add", "third"]);
    assert.equal(edited.status, 0, edited.stderr);
    assert.match(edited.stderr, /building/);

    const missing = osdRun([join(dir, "nope.prog.abap")]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no such report/);
    assert.equal(existsSync(join(dir, "cache", "mine")), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("two concurrent osd run builds share a checkout without generated-file races", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osd-run-parallel-"));
  try {
    const osd = join(here, "..", "..", "bin", "osd.mjs");
    const reports = ["first", "second"].map((name) => {
      const folder = join(dir, name);
      cpSync(join(here, "apps", "hello"), folder, {recursive: true});
      return join(folder, "zhello.prog.abap");
    });
    const runParallel = (report) => new Promise((resolveResult) => {
      const child = spawn(process.execPath, [osd, "run", report, "--name", "Alice"], {
        env: {...process.env, OSD_RUN_CACHE: join(dir, "cache")}, stdio: ["ignore", "pipe", "pipe"]});
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolveResult({status, stdout, stderr}));
    });
    const results = await Promise.all(reports.map(runParallel));
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Hello Alice/);
    }
    const cached = await runParallel(reports[0]);
    assert.equal(cached.status, 0, cached.stderr);
    assert.doesNotMatch(cached.stderr, /osd run: building/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("F4 report builds and terminal keyboard drives open, directory, save", () => {
  execFileSync(process.execPath, [builder, join(here, "apps", "pickfile", "zpickfile.prog.abap")], {stdio: "inherit"});
  execFileSync("go", ["test", "-tags", "nodatabase,osabap_pickfile", "./cmd/osabap"], {
    cwd: join(here, "go"), stdio: "inherit",
  });
  // With all values supplied, even a report containing F4 handlers stays headless.
  const result = run(["--in", "input", "--dir", "folder", "--out", "output", "--fm1", "one", "--fm2", "two"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /input\s+folder\s+output/);
});

test("ABAP compiler lowers explicit space and omitted overwrite prompt identically", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-prompt-"));
  try {
    const report = join(dir, "zprompt.prog.abap");
    writeFileSync(report, [
      "REPORT zprompt.", "PARAMETERS p_file TYPE string.",
      "AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file.",
      "  DATA lv_name TYPE string.", "  DATA lv_path TYPE string.", "  DATA lv_full TYPE string.", "  DATA lv_action TYPE i.",
      "  cl_gui_frontend_services=>file_save_dialog( CHANGING filename = lv_name path = lv_path fullpath = lv_full user_action = lv_action ).",
      "  cl_gui_frontend_services=>file_save_dialog( EXPORTING prompt_on_overwrite = space CHANGING filename = lv_name path = lv_path fullpath = lv_full user_action = lv_action ).",
      "START-OF-SELECTION.", "  WRITE p_file.", ""].join("\n"));
    execFileSync(process.execPath, [builder, report], {stdio: "inherit"});
    const generated = readFileSync(join(here, "go", "cmd", "osabap", "zz_generated.go"), "utf8");
    const calls = generated.match(/abap\.FrontendFileSaveDialog\([^\n]+/g) ?? [];
    assert.equal(calls.length, 1); // wrapper once; ABAP calls the wrapper twice
    const event = /func \(.*?AT_SELECTION_SCREEN_VALUE_REQ[\s\S]*?\n}/.exec(generated)?.[0] ?? generated;
    assert.match(event, /FILE_SAVE_DIALOG\([^\n]*""[^\n]*\)/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("headless ABAP dialog call maps ERROR_NO_GUI through EXCEPTIONS", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-headless-f4-"));
  try {
    const report = join(dir, "zheadlessf4.prog.abap");
    writeFileSync(report, ["REPORT zheadlessf4.", "DATA lv_folder TYPE string.",
      "START-OF-SELECTION.",
      "  cl_gui_frontend_services=>directory_browse( CHANGING selected_folder = lv_folder EXCEPTIONS error_no_gui = 3 OTHERS = 5 ).",
      "  WRITE: / sy-subrc.",
      "  CALL FUNCTION 'F4_FILENAME' IMPORTING file_name = lv_folder EXCEPTIONS error_no_gui = 3 OTHERS = 5.",
      "  WRITE: / sy-subrc.",
      "  CALL FUNCTION 'KD_GET_FILENAME_ON_F4' CHANGING file_name = lv_folder EXCEPTIONS error_no_gui = 3 OTHERS = 5.",
      "  WRITE: / sy-subrc.", ""].join("\n"));
    execFileSync(process.execPath, [builder, report], {stdio: "inherit"});
    const result = run(["-params", "{}"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^3\s*\n3\s*\n3\s*\n$/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("select-option LOW and HIGH F4 handlers build and run in the terminal", () => {
  execFileSync(process.execPath, [builder, join(here, "apps", "pickrange", "zpickrange.prog.abap")], {stdio: "inherit"});
  execFileSync("go", ["test", "-tags", "nodatabase,osabap_pickrange", "./cmd/osabap"], {
    cwd: join(here, "go"), stdio: "inherit",
  });
});

test("build-selected read parameters and lists grant only user paths before ABAP", () => {
  const dir = mkdtempSync(join(tmpdir(), "osabap-read-grants-"));
  try {
    const report = join(dir, "zread.prog.abap");
    writeFileSync(report, `REPORT zread.
TYPES ty_path TYPE string.
PARAMETERS p_file TYPE ty_path DEFAULT '${join(dir, "sibling.txt")}'.
PARAMETERS p_config TYPE c LENGTH 255.
PARAMETERS p_swap AS CHECKBOX.
PARAMETERS p_select AS CHECKBOX.
PARAMETERS p_rewrite AS CHECKBOX.
PARAMETERS p_upload AS CHECKBOX.
DATA upload_lines TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
PARAMETERS p_other LIKE p_file.
PARAMETERS p_deps TYPE string.
PARAMETERS p_number TYPE i.
PARAMETERS p_check AS CHECKBOX.
SELECT-OPTIONS s_paths FOR p_config.
DATA line TYPE string.
DATA reason TYPE string.
INITIALIZATION.
  p_file = '${join(dir, "init-secret.txt")}'.
  OPEN DATASET p_file FOR INPUT IN TEXT MODE ENCODING UTF-8 MESSAGE reason.
  IF sy-subrc = 0.
    WRITE: / 'initialization widened'.
    CLOSE DATASET p_file.
  ENDIF.
AT SELECTION-SCREEN.
  IF p_select = abap_true.
    p_file = p_other.
  ENDIF.
START-OF-SELECTION.
  IF p_rewrite = abap_true.
    OPEN DATASET p_deps FOR OUTPUT IN TEXT MODE ENCODING UTF-8.
    IF sy-subrc = 0.
      TRANSFER p_other TO p_deps.
      CLOSE DATASET p_deps.
    ENDIF.
  ENDIF.
  IF p_swap = abap_true.
    p_file = p_other.
  ENDIF.
  IF p_upload = abap_true.
    cl_gui_frontend_services=>gui_upload(
      EXPORTING filename = p_file filetype = 'ASC'
      CHANGING data_tab = upload_lines ).
    LOOP AT upload_lines INTO line.
      WRITE: / line.
    ENDLOOP.
    RETURN.
  ENDIF.
  OPEN DATASET p_file FOR INPUT IN TEXT MODE ENCODING UTF-8 MESSAGE reason.
  IF sy-subrc = 0.
    READ DATASET p_file INTO line.
    WRITE: / line.
    CLOSE DATASET p_file.
  ELSE.
    WRITE: / 'file refused', reason.
  ENDIF.
  OPEN DATASET p_other FOR INPUT IN TEXT MODE ENCODING UTF-8 MESSAGE reason.
  IF sy-subrc = 0.
    READ DATASET p_other INTO line.
    WRITE: / line.
    CLOSE DATASET p_other.
  ELSE.
    WRITE: / 'other refused', reason.
  ENDIF.
`);
    execFileSync(process.execPath, [builder, report, "--read-params", "p_file,p_config", "--read-lists", "p_deps"], {stdio: "inherit"});
    execFileSync("go", ["test", "-tags", "nodatabase,osabap_readgrants", "./cmd/osabap"], {
      cwd: join(here, "go"), stdio: "inherit",
    });
    const work = join(dir, "work");
    mkdirSync(work);
    const input = join(dir, "input.txt");
    const sibling = join(dir, "sibling.txt");
    const list = join(dir, "deps.txt");
    writeFileSync(input, "allowed content\n");
    writeFileSync(sibling, "sibling content\n");
    writeFileSync(join(dir, "init-secret.txt"), "initial secret\n");
    writeFileSync(list, "\ufeff# dependencies\r\n\r\nsibling.txt\r\n");
    const invoke = (args) => spawnSync(binary, args, {encoding: "utf8", cwd: work});
    const args = ["--file", "../input.txt", "--other", "../sibling.txt"];
    const allowed = invoke(args);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /^allowed content\nother refused Permission denied/);
    assert.equal(allowed.stderr, `read: ${input} (P_FILE)\n`);
    const uploaded = invoke([...args, "--upload"]);
    assert.equal(uploaded.status, 0, uploaded.stderr);
    assert.equal(uploaded.stdout, "allowed content\n");
    assert.equal(uploaded.stderr, allowed.stderr);
    const uploadSibling = invoke([...args, "--upload", "--swap"]);
    assert.notEqual(uploadSibling.status, 0);
    assert.doesNotMatch(uploadSibling.stdout, /sibling content/);
    assert.match(uploadSibling.stderr, /permission denied/i);
    const changedByReport = invoke([...args, "--swap"]);
    assert.match(changedByReport.stdout, /^file refused Permission denied[\s\S]*other refused Permission denied/);
    assert.equal(changedByReport.stderr, `read: ${input} (P_FILE)\n`);
    const defaultOnly = invoke(["--other", sibling]);
    assert.match(defaultOnly.stdout, /^file refused Permission denied/);
    assert.equal(defaultOnly.stderr, "");
    const listed = invoke([...args, "--deps", "../deps.txt"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, "allowed content\nsibling content\n");
    assert.equal(listed.stderr, `read: ${input} (P_FILE), ${list} (P_DEPS) + 1 from deps.txt\n`);
    const disabled = invoke([...args, "--deps", "../deps.txt", "-no-default-reads"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /^file refused Permission denied[\s\S]*other refused Permission denied/);
    assert.equal(disabled.stderr, "");
    const explicit = invoke([...args, "-no-default-reads", "-allow-read", dir, "-dataset-home", work]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout, "initialization widened\nallowed content\nsibling content\n");
    // Critic reproducer: adding a grant must not change the implicit home.
    const beforeGrant = invoke(["--other", "sibling.txt", "-allow-read", dir]);
    const afterGrant = invoke(["--file", "../input.txt", "--other", "sibling.txt", "-allow-read", dir]);
    assert.match(beforeGrant.stdout, /sibling content/);
    assert.match(afterGrant.stdout, /sibling content/);
    // DATASET uses the selected home, while parameter VALUES still use cwd.
    const withHome = invoke(["--file", "../input.txt", "--other", "input.txt", "-dataset-home", dir]);
    assert.match(withHome.stdout, /^file refused Permission denied[^\n]*\nallowed content\n$/);
    assert.equal(withHome.stderr, `read: ${input} (P_FILE)\n`);
    assert.doesNotMatch(allowed.stdout, /initialization widened/);
    const selected = invoke([...args, "--select"]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.stdout, /^file refused Permission denied[\s\S]*other refused Permission denied/);
    assert.equal(selected.stderr, `read: ${input} (P_FILE)\n`);
    const json = join(work, "params.json");
    writeFileSync(json, JSON.stringify({P_FILE: "../input.txt", P_OTHER: "../sibling.txt"}));
    for (const params of ["@params.json", JSON.stringify({file: "../input.txt", other: "../sibling.txt"})]) {
      const fromJSON = invoke(["-params", params]);
      assert.equal(fromJSON.status, 0, fromJSON.stderr);
      assert.equal(fromJSON.stdout, allowed.stdout);
      assert.equal(fromJSON.stderr, allowed.stderr);
    }
    // Rewriting a previously parsed list inside a separate write root never
    // recomputes grants. Its new external path remains refused this run.
    const mutable = join(work, "mutable.txt");
    writeFileSync(mutable, "../input.txt\n");
    const rewritten = invoke([...args, "--deps", "mutable.txt", "--rewrite", "-allow-write", work]);
    assert.equal(rewritten.status, 0, rewritten.stderr);
    assert.match(rewritten.stdout, /^allowed content\nother refused Permission denied/);
    assert.equal(readFileSync(mutable, "utf8"), "../sibling.txt\n");
    const help = invoke(["-help"]);
    assert.match(help.stdout, /default read parameters: P_FILE, P_CONFIG; list parameters: P_DEPS/);
    assert.match(help.stdout, /-no-default-reads/);
    const empty = invoke(["--file", "", "--other", sibling]);
    assert.equal(empty.stderr, "");
    assert.match(empty.stdout, /other refused Permission denied/);
    const unreadable = invoke([...args, "--deps", "../missing-list"]);
    assert.equal((unreadable.stderr.match(/warning:/g) ?? []).length, 1);
    assert.match(unreadable.stdout, /other refused Permission denied/);
    for (const [option, name] of [["--read-params", "P_UNKNOWN"], ["--read-lists", "P_NUMBER"], ["--read-params", "P_CHECK"], ["--read-params", "S_PATHS"], ["--read-lists", "S_PATHS"]]) {
      const bad = spawnSync(process.execPath, [builder, report, option, name], {encoding: "utf8"});
      assert.notEqual(bad.status, 0, name);
      assert.match(bad.stderr, new RegExp(`read grant: .*${name}`));
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
