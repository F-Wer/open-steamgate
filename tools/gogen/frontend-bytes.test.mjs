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
