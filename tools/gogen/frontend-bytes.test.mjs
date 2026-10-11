import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";

function compile(statement, declarations = "DATA xs TYPE xstring. DATA p TYPE xstring. DATA m TYPE i. DATA ml TYPE i.") {
  const dir = mkdtempSync(join(tmpdir(), "gogen-byte-frontend-"));
  try {
    writeFileSync(join(dir, "zcl_byte_frontend.clas.abap"), `CLASS zcl_byte_frontend DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS run.
ENDCLASS.
CLASS zcl_byte_frontend IMPLEMENTATION.
METHOD run. ${declarations} ${statement} ENDMETHOD.
ENDCLASS.`);
    return compileProgram({folders: [dir], objects: ["ZCL_BYTE_FRONTEND"], tolerant: true});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test("byte FIND LENGTH is the section bound and offset/length targets are separate", () => {
  for (const section of ["OFFSET 1 LENGTH 5", "LENGTH 5", "OFFSET 1"]) {
    const p = compile(`FIND p IN SECTION ${section} OF xs IN BYTE MODE MATCH OFFSET m MATCH LENGTH ml.`);
    assert.deepEqual(p.partial, []);
    const st = p.classes[0].methods[0].body[0];
    assert.equal(st.s, "find_bytes");
    assert.equal(st.subject.name, "XS");
    assert.equal(st.off.name, "M");
    assert.equal(st.len.name, "ML");
    assert.equal(!!st.secLen, section.includes("LENGTH"));
    assert.match(emitGo(p), /abap.FindBytes/);
  }
});

test("byte REPLACE accepts either default and fixed or variable byte targets", () => {
  for (const section of ["OFFSET 1 LENGTH 2", "LENGTH 2", "OFFSET 1"]) {
    for (const type of ["xstring", "x LENGTH 4"]) {
      const p = compile(`REPLACE SECTION ${section} OF xs WITH p IN BYTE MODE.`, `DATA xs TYPE ${type}. DATA p TYPE xstring.`);
      assert.deepEqual(p.partial, []);
      assert.equal(p.classes[0].methods[0].body[0].s, "replace_bytes");
      assert.match(emitGo(p), type === "xstring" ? /xs\.Replace/ : /abap.ReplaceBytes/);
    }
  }
});

test("other byte FIND and REPLACE forms keep their refusals", () => {
  for (const statement of [
    "REPLACE FIRST OCCURRENCE OF p IN xs WITH p IN BYTE MODE.",
    "FIND REGEX p IN xs IN BYTE MODE MATCH OFFSET m.",
    "FIND ALL OCCURRENCES OF REGEX p IN xs IN BYTE MODE MATCH COUNT m.",
  ]) {
    const p = compile(statement);
    assert.equal(p.partial.length, 1);
    assert.match(p.partial[0], /(?:REPLACE|FIND) form:/);
  }

});

test("character REPLACE SECTION accepts fixed targets and either default operand", () => {
  for (const section of ["OFFSET 1 LENGTH 2", "LENGTH 2", "OFFSET 1"]) for (const type of ["string", "c LENGTH 4"]) {
    const p = compile(`REPLACE SECTION ${section} OF xs WITH p IN CHARACTER MODE.`, `DATA xs TYPE ${type}. DATA p TYPE string.`);
    assert.deepEqual(p.partial, []);
    assert.equal(p.classes[0].methods[0].body[0].s, "replace_chars");
    assert.match(emitGo(p), /hCharsection.Replace/);
  }
});

test("P2 ALL byte occurrences reuse RESULTS and accept MATCH COUNT", () => {
  for (const tail of ["MATCH COUNT m", "RESULTS res", "MATCH COUNT m RESULTS res", ""]) {
    const p = compile(`FIND ALL OCCURRENCES OF p IN xs IN BYTE MODE ${tail}.`,
      "TYPES: BEGIN OF sub, offset TYPE i, length TYPE i, END OF sub. TYPES subs TYPE STANDARD TABLE OF sub WITH DEFAULT KEY. TYPES: BEGIN OF result, line TYPE i, offset TYPE i, length TYPE i, submatches TYPE subs, END OF result. DATA xs TYPE xstring. DATA p TYPE xstring. DATA m TYPE i. DATA res TYPE STANDARD TABLE OF result WITH DEFAULT KEY.");
    assert.deepEqual(p.partial, []);
    const st = p.classes[0].methods[0].body.find((st) => st.s !== "nop");
    assert.equal(st.s, tail.includes("RESULTS") ? "find_results" : "find_bytes_all");
    assert.match(emitGo(p), /abap.FindBytesAll/);
  }
});

test("SECTION without operands is not a section in abaplint's grammar", () => {
  const reg = new core.Registry().addFile(new core.MemoryFile("zempty.prog.abap",
    "REPLACE SECTION OF xs WITH p IN BYTE MODE.\nFIND p IN SECTION OF xs IN BYTE MODE.")).parse();
  const [replace, find] = reg.getFirstObject().getABAPFiles()[0].getStatements();
  assert.equal(replace.get().constructor.name, "Unknown");
  // FIND parses SECTION as the subject variable and OF xs as an option,
  // not as a section selector. There is no bare SECTION production.
  assert.equal(find.findDirectExpressions(core.Expressions.Source)[1].concatTokens(), "SECTION");
});

test("byte bit operations calculate at maximum fixed width or dynamic XOR", () => {
  for (const op of ["BIT-XOR", "BIT-AND", "BIT-OR"]) for (const operands of ["a OP b", "b OP a"]) {
    const p = compile(`r = ${operands.replace("OP", op)}.`, "DATA a TYPE x LENGTH 3. DATA b TYPE x LENGTH 4. DATA r TYPE x LENGTH 2.");
    assert.deepEqual(p.partial, []);
    assert.deepEqual(p.classes[0].methods[0].body[0].value.x.type, {k: "x", len: 4});
    assert.match(emitGo(p), /abap.BitX/);
    assert.match(emitJs(p), /abap.BitX/);
  }
  for (const operands of ["a BIT-XOR b", "b BIT-XOR a"]) {
    const p = compile(`r = ${operands}.`, "DATA a TYPE x LENGTH 3. DATA b TYPE xstring. DATA r TYPE xstring.");
    assert.deepEqual(p.partial, []);
    assert.match(emitGo(p), /abap.BitXS/);
    assert.match(emitJs(p), /abap.BitXS/);
  }
});

test("dynamic AND/OR and non-byte bit operands retain their refusals", () => {
  for (const op of ["BIT-AND", "BIT-OR"]) {
    const p = compile(`r = a ${op} b.`, "DATA a TYPE x LENGTH 3. DATA b TYPE xstring. DATA r TYPE xstring.");
    assert.equal(p.partial.length, 1);
    assert.match(p.partial[0], /of xstrings: not measured/);
  }
  const p = compile("r = a BIT-XOR b.", "DATA a TYPE i. DATA b TYPE i. DATA r TYPE i.");
  assert.ok(p.broken.includes("zcl_byte_frontend") || p.partial.some((s) => s.includes("bit operation on other than x")));
});

// The character forms share the FindType parser with the byte forms above.
test("plain PCRE FIND and REPLACE lower in both emitters", () => {
  for (const statement of [
    "FIND FIRST OCCURRENCE OF PCRE p IN xs IGNORING CASE MATCH OFFSET m MATCH LENGTH ml.",
    "FIND ALL OCCURRENCES OF PCRE p IN xs MATCH COUNT m.",
    "REPLACE FIRST OCCURRENCE OF PCRE p IN xs WITH p.",
    "REPLACE ALL OCCURRENCES OF PCRE p IN xs WITH p IGNORING CASE.",
  ]) {
    const p = compile(statement, "DATA xs TYPE string. DATA p TYPE string. DATA m TYPE i. DATA ml TYPE i.");
    assert.deepEqual(p.partial, []);
    assert.equal(p.classes[0].methods[0].body[0].pcre, true);
    for (const emit of [emitGo, emitJs]) assert.match(emit(p), /abap.(FindStmt|FindAllCount|ReplaceStmt)\([^\n]*, true\)/);
  }
});

test("PCRE keeps REGEX's section and byte form restrictions", () => {
  for (const statement of [
    "FIND PCRE p IN SECTION OFFSET 1 OF xs MATCH OFFSET m.",
    "REPLACE FIRST OCCURRENCE OF PCRE p IN SECTION OFFSET 1 OF xs WITH p.",
    "FIND PCRE p IN xs IN BYTE MODE MATCH OFFSET m.",
    "FIND ALL OCCURRENCES OF PCRE p IN xs MATCH OFFSET m MATCH LENGTH m MATCH COUNT m.",
    "FIND FIRST OCCURRENCE OF PCRE p IN xs MATCH COUNT m.",
  ]) {
    const p = compile(statement, "DATA xs TYPE string. DATA p TYPE string. DATA m TYPE i.");
    assert.equal(p.partial.length, 1);
    assert.equal(compile(statement.replaceAll("PCRE", "REGEX"), "DATA xs TYPE string. DATA p TYPE string. DATA m TYPE i.").partial.length, 1);
  }
});

test("plain PCRE runtimes refuse exactly as RESULTS does", async () => {
  const abap = await import("./js/abap.mjs");
  for (const pattern of ["a(?=b)", "(?<=a)b", "(a)\\1", "a++", "(?>a)", "\\K", "(", "(?i)a", "(?-x:a)", "a(?-x)b"]) {
    let expected;
    try { abap.FindResults("aab", pattern, "P", false, true); } catch (e) { expected = e; }
    assert.ok(expected, pattern);
    for (const run of [
      () => abap.FindStmt("aab", pattern, true, false, 0, true),
      () => abap.FindAllCount("aab", pattern, true, false, true),
      () => abap.ReplaceStmt("aab", pattern, "x", true, true, false, 0, abap.NoLength, -1, true),
    ]) assert.throws(run, (e) => e.constructor === expected.constructor && e.message === expected.message);
  }
});


test("shared FIND and REPLACE spans count UTF-16 units", async () => {
  const a = await import("./js/abap.mjs");
  for (const pcre of [false, true]) {
    assert.deepEqual(a.FindStmt("😀a", "(a)", true, false, 1, pcre), [true, 2, 1, ["a"]]);
    assert.deepEqual(a.FindStmt("😀", "(.)", true, false, 1, pcre), [true, 0, 2, ["😀"]]);
    assert.deepEqual(a.FindResults("😀a", "(.)", pcre ? "P" : "R", false, true), [[0, 2, 0, 2], [2, 1, 2, 1]]);
    assert.deepEqual(a.ReplaceStmt("😀a", "(a)", "$1!", true, false, false, 0, a.NoLength, -1, pcre), ["😀a!", 0]);
    assert.deepEqual(a.ReplaceStmt("😀a", "(.)", "$1!", true, false, false, 2, 1, -1, pcre), ["😀a!", 0]);
    assert.deepEqual(a.ReplaceStmt("😀a", "(a)", "$1!", true, false, false, 0, a.NoLength, 3, pcre), ["😀a", 2]);
  }
});

// Unmeasured: Round 3 patterns are refused consistently rather than translated.
test("PCRE quoting and negated POSIX classes refuse in every adapter", async () => {
  const a = await import("./js/abap.mjs");
  for (const [pattern, reason] of [
    [String.raw`[\Q\E^] #]`, String.raw`unsupported quoting escape \Q`],
    [String.raw`[\Q\E] #]`, String.raw`unsupported quoting escape \Q`],
    [String.raw`\Qa b\E`, String.raw`unsupported quoting escape \Q`],
    [String.raw`\E`, String.raw`unsupported quoting escape \E`],
    ["[[:^alpha:] #]", "an unsupported POSIX class: ^alpha"],
  ]) {
    for (const run of [
      () => a.FindResults("#", pattern, "P", false, true),
      () => a.FindStmt("#", pattern, true, false, 0, true),
      () => a.FindAllCount("#", pattern, true, false, true),
      () => a.ReplaceStmt("#", pattern, "X", true, true, false, 0, a.NoLength, -1, true),
    ]) assert.throws(run, (e) => e.message === "NOT_COMPILED in FIND PCRE: " + reason);
  }
});

// Unmeasured: ABAP PCRE extended mode by documentation; measure on A4H before changing
test("PCRE extended mode preserves escaped whitespace and classes", async () => {
  const a = await import("./js/abap.mjs");
  for (const [p, s, found, len] of [
    ["a b", "ab", true, 2], [String.raw`a\ b`, "a b", true, 3], ["[ ]", " ", true, 1],
    ["a # ignored (?i)\\K\n b", "ab", true, 2], [String.raw`a\#b`, "a#b", true, 3],
    ["(?-x)a b", "a b", true, 3], ["(?-x)a b", "ab", false, 0],
    ["[^] #]", "#", false, 0], ["[^] #]", "a", true, 1], ["[] #]", "]", true, 1],
    ["[[:alpha:] #]", "#", true, 1], ["[[:alpha:] #]", " ", true, 1], ["[[:alpha:] #]", "a", true, 1],
    ["[[:space:] #]", "\t", true, 1], ["[[:ascii:] #]", "a", true, 1], ["[[:punct:] #]", "]", true, 1],
    ["[ #]", "#", true, 1], ["a\tb", "ab", true, 2], ["[(?i)]", "i", true, 1], [String.raw`\(\?i\)`, "(?i)", true, 4],
  ]) {
    assert.deepEqual(a.FindStmt(s, p, true, false, 0, true), [found, 0, len, []], p);
    assert.equal(a.FindResults(s, p, "P", false, false).length, found ? 1 : 0, p);
    assert.deepEqual(a.ReplaceStmt(s, p, "X", true, false, false, 0, a.NoLength, -1, true), [found ? "X" : s, found ? 0 : 4], p);
  }
});

test("PCRE replacements refuse directives and unknown escapes before matching", async () => {
  const a = await import("./js/abap.mjs");
  for (const replacement of ["\\U$0", "\\L$0", "\\E", "\\u$1", "\\l$1", "\\n", "\\q", "\\"]) {
    for (const text of ["ab", "miss"]) assert.throws(() => a.ReplaceStmt(text, "(ab)", replacement, true, false, false, 0, a.NoLength, -1, true), /NOT_COMPILED.*REPLACE PCRE.*unsupported replacement escape/);
  }
  for (const [replacement, want] of [["$0/$1/$9", "ab/ab/"], [String.raw`\\\$$1`, "\\$ab"], ["$&", "ab"]]) {
    assert.deepEqual(a.ReplaceStmt("ab", "(ab)", replacement, true, false, false, 0, a.NoLength, -1, true), [want, 0]);
  }
  // ${n} remains refused, as on the REGEX replacement path.
  for (const pcre of [false, true]) assert.throws(() => a.ReplaceStmt("ab", "(ab)", "${1}", true, false, false, 0, a.NoLength, -1, pcre), /NOT_COMPILED/);
});

// Unmeasured: a c(3) emoji field occupies three UTF-16 units without padding.
test("fixed-width regex replacement pads by UTF-16 units", async () => {
  const a = await import("./js/abap.mjs");
  for (const pcre of [false, true]) {
    assert.deepEqual(a.ReplaceStmt("😀a", "[ ]", "X", true, false, false, 0, a.NoLength, 3, pcre), ["😀a", 4]);
    assert.deepEqual(a.ReplaceStmt("😀", "[ ]", "X", true, false, false, 0, a.NoLength, 3, pcre), ["😀X", 0]);
  }
});
