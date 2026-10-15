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

function compile(statement, declarations = "DATA xs TYPE xstring. DATA p TYPE xstring. DATA m TYPE i. DATA ml TYPE i.", folders = []) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-byte-frontend-"));
  try {
    writeFileSync(join(dir, "zcl_byte_frontend.clas.abap"), `CLASS zcl_byte_frontend DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS run.
ENDCLASS.
CLASS zcl_byte_frontend IMPLEMENTATION.
METHOD run. ${declarations} ${statement} ENDMETHOD.
ENDCLASS.`);
    return compileProgram({folders: [dir, ...folders], objects: ["ZCL_BYTE_FRONTEND"], tolerant: true});
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
    ...[0, 1].map(off => `FIND PCRE ` + "`(?<![\\s\\S])ab`" + ` IN SECTION OFFSET ${off} OF xs MATCH OFFSET m.`),
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

// Unmeasured: Round 4 absolute PCRE anchors; A4H not run.
test("PCRE absolute anchors preserve subject boundaries and escaped literals", async () => {
  const a = await import("./js/abap.mjs");
  for (const [s, p, want] of [
    ["abab", "\\Aab", [[0, 2]]], ["abab", "ab\\z", [[2, 2]]],
    ["ab\n", "ab\\z", []], ["ab\r\n", "ab\\z", []], ["\nab", "\\Aab", []],
    ["x\\A", "\\\\A", [[1, 2]]], ["x\\z", "\\\\z", [[1, 2]]], ["abab", "\\Aab\\z", []],
  ]) assert.deepEqual(a.FindResults(s, p, "P", false, true), want, p);
  for (const [p, reason] of [
    ["[\\A]", "unsupported anchor escape in character class \\A"],
    ["[\\z]", "unsupported anchor escape in character class \\z"],
    ["\\Z", "\\Z is not in Go's RE2: \\Z"], ["\\G", "\\G is not in Go's RE2: \\G"],
    ["(?m)\\Aab", "an unsupported inline flag group: (?m)\\Aab"],
  ]) assert.throws(() => a.FindResults("ab", p, "P", false, true), (e) => e.message === "NOT_COMPILED in FIND PCRE: " + reason);
});

// The dictionary files also used by explicitly typed RESULTS targets.
const regexDdic = new URL("../../.local/lars/open-abap-core/src/abap/regex", import.meta.url).pathname;

test("inline RESULTS shares DDIC types with explicit results and copied submatch rows", () => {
  for (const occurrence of ["ALL OCCURRENCES", "FIRST OCCURRENCE"]) {
    const all = occurrence.startsWith("ALL");
    const p = compile(`FIND ${occurrence} OF REGEX '(a)(b)?' IN 'xab a' RESULTS DATA(matches).
      explicit = matches.
      ${all ? "LOOP AT matches INTO hit." : "hit = matches."}
      groups = hit-submatches.
      LOOP AT groups INTO group. hit-offset = group-offset. ENDLOOP.
      ${all ? "ENDLOOP." : ""}`,
      `DATA explicit TYPE ${all ? "match_result_tab" : "match_result"}.
       DATA hit TYPE match_result. DATA groups TYPE submatch_result_tab. DATA group TYPE submatch_result.`, [regexDdic]);
    assert.deepEqual(p.partial, []);
    const method = p.classes[0].methods[0];
    const locals = new Map(method.locals.map((l) => [l.name, l.type]));
    assert.deepEqual(locals.get("MATCHES"), locals.get("EXPLICIT"));
    const st = method.body.find((st) => st.s === "find_results");
    assert.equal(st.all, all);
    assert.equal(st.table, all);
    assert.equal(st.sub.go, locals.get("GROUP").go);
    assert.match(emitGo(p), /abap.FindResults/);
    assert.match(emitJs(p), /abap.FindResults/);
  }
});

test("FIRST RESULTS table uses first-match iteration and still refuses sorted targets", () => {
  const p = compile("FIND FIRST OCCURRENCE OF REGEX '(a)' IN 'aa' RESULTS matches.",
    "DATA matches TYPE match_result_tab.", [regexDdic]);
  assert.deepEqual(p.partial, []);
  const st = p.classes[0].methods[0].body.find((st) => st.s === "find_results");
  assert.equal(st.all, false);
  assert.equal(st.table, true);
  for (const access of ["SORTED", "HASHED"]) {
    const bad = compile("FIND FIRST OCCURRENCE OF REGEX '(a)' IN 'aa' RESULTS matches.",
      `DATA matches TYPE ${access} TABLE OF match_result WITH UNIQUE KEY offset.`, [regexDdic]);
    assert.equal(bad.partial.length, 1);
    assert.match(bad.partial[0], /RESULTS into other than a standard table/);
  }
});

// Unmeasured; measure on A4H. Same hex cases and UTF-16 spans as pcre_hex_test.go.
test("PCRE hex escapes agree across FIND, RESULTS, COUNT and REPLACE", async () => {
  const a = await import("./js/abap.mjs");
  for (const [p, text, off, n] of [
    [String.raw`\xA0`, "😀\u00a0", 2, 1],
    [String.raw`[\x00-\x1F\xA0]`, "😀\u00a0", 2, 1],
    [String.raw`[\x00-\x1F\xA0]`, "a\x1f", 1, 1],
    [String.raw`[\x4]`, "a\x04", 1, 1],
    [String.raw`[\x{263A}]`, "a☺", 1, 1],
    [String.raw`\x41`, "😀A", 2, 1], [String.raw`\x4`, "a\x04", 1, 1],
    [String.raw`\x414`, "aA4", 1, 2],
    [String.raw`\x{263A}`, "a☺", 1, 1], [String.raw`\x{1F600}`, "a😀", 1, 2],
    [String.raw`[\x{1F600}-\x{1F601}]`, "a😁", 1, 2],
    [String.raw`\x{000000000000001F600}+`, "a😀😀", 1, 4],
    [String.raw`\x{10FFFF}`, "a\u{10ffff}", 1, 2],
    [String.raw`\\x41`, String.raw`a\x41`, 1, 4], [String.raw`[\\x41]+`, String.raw`a\x41`, 1, 4],
    [String.raw`\x4 1`, "a\x041", 1, 2],
    [String.raw`\x23\x20\x5B\x5C`, "a# [\\", 1, 4],
    [String.raw`\A\x41\z`, "A", 0, 1], [String.raw`\x41 # \x{D800}`, "A", 0, 1],
  ]) {
    assert.deepEqual(a.FindResults(text, p, "P", false, true), [[off, n]], p);
    assert.deepEqual(a.FindStmt(text, p, true, false, 0, true), [true, off, n, []], p);
    assert.equal(a.FindAllCount(text, p, true, false, true), 1, p);
    for (const all of [false, true]) assert.deepEqual(a.ReplaceStmt(text, p, "X", true, all, false, 0, a.NoLength, -1, true),
      [text.slice(0, off) + "X" + text.slice(off + n), 0], p);
  }
  assert.deepEqual(a.FindResults("😀A😀", String.raw`(\x{1F600})`, "P", false, true), [[0, 2, 0, 2], [3, 2, 3, 2]]);
});

test("PCRE hex escapes refuse invalid scalars and retain other escape refusals", async () => {
  const a = await import("./js/abap.mjs");
  for (const [p, reason] of [
    [String.raw`\x{D800}`, "a surrogate hex escape"], [String.raw`[\x{DFFF}]`, "a surrogate hex escape"],
    [String.raw`\x{110000}`, "a hex escape above U+10FFFF"],
    [String.raw`\x{FFFFFFFFFFFFFFFFFFFFFFFF}`, "a hex escape above U+10FFFF"],
    [String.raw`\x{}`, "a malformed braced hex escape"], [String.raw`\x{41`, "a malformed braced hex escape"],
    [String.raw`\x{4G}`, "a malformed braced hex escape"],
    [String.raw`\x41++`, "a possessive quantifier"],
    [String.raw`\u{41}+`, String.raw`a possessive quantifier is not in Go's RE2: \u{41}+`],
    [String.raw`\u0041`, "RE2 does not read this pattern (error parsing regexp: invalid escape sequence: `\\u`); whether PCRE does is not measured"],
    [String.raw`\x`, String.raw`\x without hex digits`],
    [String.raw`[\x]`, String.raw`\x without hex digits`],
    [String.raw`\xg`, String.raw`\x without hex digits`],
    [String.raw`\x 41`, String.raw`\x without hex digits`],
    [String.raw`\x\x11`, String.raw`\x without hex digits`],
  ]) {
    for (const run of [
      () => a.FindResults("A", p, "P", false, true),
      () => a.FindStmt("A", p, true, false, 0, true),
      () => a.FindAllCount("A", p, true, false, true),
      () => a.ReplaceStmt("A", p, "X", true, true, false, 0, a.NoLength, -1, true),
    ]) assert.throws(run, e => e.message.includes("NOT_COMPILED in FIND PCRE: " + reason), p);
  }
  for (const escape of "ceoNXRhHvV") assert.throws(() => a.FindResults("a", "\\" + escape, "P", false, true), /NOT_COMPILED/);
});

test("PCRE on line-ended text admits newline-independent syntax", async () => {
  const a = await import("./js/abap.mjs");
  const cds = "\ndefine root view entity zi_lockentity as select from zfoo {\n  key field1\n}";
  for (const [s, p, replacement, want, spans, rc] of [
    ["WHEN &1.\n", "&1", "'a'", "WHEN 'a'.\n", [[5, 2]], 0],
    [cds, "\u00a0", " ", cds, [], 4],
    ["a\n\ra", String.raw`[^a]+`, "X", "aXa", [[1, 2]], 0],
    ["a \n\r\tb", String.raw`\s+`, "X", "aXb", [[1, 4]], 0],
    ["a.b\n", String.raw`\.`, "X", "aXb\n", [[1, 1]], 0],
    ["^$\n", String.raw`\^\$`, "X", "X\n", [[0, 2]], 0],
    ["x\r\n12", String.raw`\b\d+\b`, "X", "x\r\nX", [[3, 2]], 0],
    ["\nx", String.raw`\w+`, "X", "\nX", [[1, 1]], 0],
    ["\n.^$", "[.^$]+", "X", "\nX", [[1, 3]], 0],
  ]) {
    assert.deepEqual(a.FindResults(s, p, "P", false, true), spans, p);
    assert.deepEqual(a.ReplaceStmt(s, p, replacement, true, true, false, 0, a.NoLength, -1, true), [want, rc], p);
  }
  for (const p of ["^x", "x$", "a.b", String.raw`\\.`, String.raw`\A^x`, String.raw`x$\z`]) {
    for (const run of [() => a.FindResults("x\na.b", p, "P", false, true),
      () => a.ReplaceStmt("x\na.b", p, "X", true, true, false, 0, a.NoLength, -1, true)]) {
      assert.throws(run, e => e.message === "NOT_COMPILED in FIND PCRE: a text with line ends: PCRE's ^ $ and . around them are not measured", p);
    }
  }
});

 test("PCRE non-UCP generic sets and ASCII boundaries under iu", async () => {
 const a = await import("./js/abap.mjs");
 for (const [p,s,icase,want] of [
    ["\\s+", "\n ", false, "X "],
    ["\\s+", "\n\u000b", false, "X"],
    ["\\S+", "\n ", false, "\nX"],
    ["[^\\s]+", "\n ", false, "\nX"],
    ["[\\s\\d]+", "\n\u000b12 ", false, "X "],
    ["[\\S\\d]+", "\n 12", false, "\nX"],
    ["[^\\S\\d]+", "\n 12", false, "X 12"],
    ["\\w+", "ſKK", true, "ſKX"],
    ["[\\w]+", "ſKK", true, "ſKX"],
    ["[^\\w]+", "ſKK", true, "XK"],
    ["[\\wſ]+", "ſKK", true, "XKX"],
    ["\\W+", "ſKK", true, "XK"],
    ["\\d+", "١1", true, "١X"],
    ["\\D+", "١1", true, "X1"],
    ["\\bK\\b", " K ", true, " X "],
    ["\\b", "ſKK", true, "ſXKXK"],
    ["\\B", "ſKK", true, "XſKKX"],
    ["\\\\s", "\\s", false, "X"],
    ["[\\\\s]+", "\\s", false, "X"],
    ["\\s # \\w\n +", "\n\u000b", false, "X"],
  ]) {
 assert.deepEqual(a.ReplaceStmt(s,p,"X",true,true,icase,0,a.NoLength,-1,true),[want,0],p);
 }
 for (const p of [String.raw`[a-\s]`,String.raw`[\w-z]`]) assert.throws(()=>a.FindResults("a",p,"P",false,true), /generic type as a character range endpoint/);
 });

test("PCRE space types exclude Unicode whitespace in both cases", async () => {
  const a = await import("./js/abap.mjs");
  assert.deepEqual(a.FindResults("ſKa", String.raw`\p{L}`, "P", true, true), [[0, 1], [1, 1], [2, 1]]);
  const extra = "\u00a0\ufeff\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
  for (const icase of [false, true]) {
    for (const p of [String.raw`\s+`, String.raw`[\s]+`, String.raw`[^\S]+`])
      assert.deepEqual(a.ReplaceStmt("\t\n\v\f\r " + extra, p, "X", true, true, icase, 0, a.NoLength, -1, true), ["X" + extra, 0]);
    for (const p of [String.raw`\S+`, String.raw`[^\s]+`, String.raw`[\S]+`])
      assert.deepEqual(a.ReplaceStmt("\t\n\v\f\r " + extra, p, "X", true, true, icase, 0, a.NoLength, -1, true), ["\t\n\v\f\r X", 0]);
  }
  assert.deepEqual(a.FindResults("\b\b", String.raw`[\b]+`, "P", true, true), [[0, 2]]);
  assert.deepEqual(a.FindResults(String.raw`\Q`, String.raw`\\Q`, "P", false, true), [[0, 2]]);
});

test("PCRE class tokenizer matches the shared real PCRE2 oracle", async () => {
  const a = await import("./js/abap.mjs");
  const {readFile} = await import("node:fs/promises");
  const oracle = JSON.parse(await readFile(new URL("./pcre-class-oracle.json", import.meta.url), "utf8"));
  for (const {pattern, icase, matches, spans, supported} of oracle.rows) {
    if (supported === false) {
      assert.throws(() => a.FindResults("aa", pattern, "P", icase, true), /NOT_COMPILED/, pattern);
      continue;
    }
    if (matches === null) {
      assert.throws(() => a.FindResults("-", pattern, "P", icase, true), /generic type as a character range endpoint/, pattern);
      continue;
    }
    for (const [i, s] of oracle.inputs.entries()) {
      assert.deepEqual(a.FindResults(s, pattern, "P", icase, true), spans[i], `${pattern} ${JSON.stringify(s)} icase=${icase}`);
      assert.deepEqual(a.ReplaceStmt(s, pattern, "X", true, true, icase, 0, a.NoLength, -1, true), matches[i] ? [spans[i].reduceRight((text,r) => text.slice(0,r[0])+"X"+text.slice(r[0]+r[1]),s),0] : [s,4], pattern);
    }
  }
  assert.deepEqual(a.FindResults("ab", String.raw`[\s^a]`, "P", false, true), [[0,1]]);
  assert.deepEqual(a.FindResults("a", String.raw`[\s^]`, "P", false, true), []);
});

test("PCRE class tokenizer refuses unmodeled items by name", async () => {
  const a = await import("./js/abap.mjs");
  for (const [p, reason] of [
    [String.raw`[\B]`, /unsupported character class escape \\B/],
    [String.raw`[\p{L}\s]`, /unsupported character class escape \\p/],
    [String.raw`[[.a.]\s]`, /collating or equivalence item/],
    [String.raw`[[:space:]-a]`, /POSIX class as a character range endpoint/],
  ]) assert.throws(() => a.FindResults("a", p, "P", false, true), reason, p);
});

// Node's native assertions are an independent oracle for subject boundaries.
test("PCRE lookaround absolute anchors agree with native u/s assertions", async () => {
  const a = await import("./js/abap.mjs");
  const {extendedPCRE} = await import("./js/pcre.mjs");
  for (const pair of ["sS", "Ss", "dD", "Dd", "wW", "Ww"]) {
    const start = `(?<![\\${pair[0]}\\${pair[1]}])`, end = `(?![\\${pair[0]}\\${pair[1]}])`;
    for (const s of ["", "ab", "abab", "ab\nab", "ab\n", "\nab", "Ab"]) {
      for (const p of [start, end, start + end, start + "ab", "ab" + end, start + "ab" + end, "(?:" + start + "ab)"]) {
        for (const icase of [false, true]) for (const all of [false, true]) {
          const re = new RegExp(p, "gdsu" + (icase ? "i" : ""));
          const matches = [...s.matchAll(re)];
          const selected = all ? matches : matches.slice(0, 1);
          assert.deepEqual(a.FindResults(s, p, "P", icase, all), selected.map(m => [m.index, m[0].length]), `${s} ${p}`);
          const expected = s.replace(new RegExp(p, "dsu" + (all ? "g" : "") + (icase ? "i" : "")), "X");
          assert.deepEqual(a.ReplaceStmt(s, p, "X", true, all, icase, 0, a.NoLength, -1, true), [expected, matches.length ? 0 : 4]);
        }
      }
    }
  }
  // V8's native lookbehind oracle reports a spurious empty match inside a
  // surrogate pair for start+end; pin scalar boundary semantics independently.
  assert.deepEqual(a.FindResults("😀ab", String.raw`(?<![\s\S])(?![\s\S])`, "P", false, true), []);
  assert.deepEqual(a.FindResults("😀ab", String.raw`ab(?![\s\S])`, "P", false, true), [[2, 2]]);
  for (const p of [String.raw`\(?<![\s\S])`, String.raw`[(?<![\s\S])]`, String.raw`\(?![\s\S])`, String.raw`[(?![\s\S])]`]) {
    const anchors = [];
    assert.doesNotMatch(extendedPCRE(p, anchors), /\\[Az]/);
    assert.deepEqual(anchors, []);
  }
  assert.equal(extendedPCRE("ab # (?<![\\s\\S]) (?![\\s\\S])\n", []), "ab");
  for (const [p, reason] of [[String.raw`(?!\*)`, "a negative lookahead (?!...)"], ["(?<=a)", "a lookbehind (?<=...)"], ["(?<!.)", "a negative lookbehind (?<!...)"], ["(?!.)", "a negative lookahead (?!...)"]]) {
    assert.throws(() => a.FindResults("a", p, "P", false, true), e => e.message === `NOT_COMPILED in FIND PCRE: ${reason} is not in Go's RE2: ${p}`);
  }
});


test("matches with PCRE remains outside the frontend subset", () => {
  const p = compile("IF matches( val = xs pcre = `(?<![\\s\\S])ab(?![\\s\\S])` ). ENDIF.", "DATA xs TYPE string.");
  assert.equal(p.partial.length, 1);
  assert.match(p.partial[0], /comparison matches/);
});
