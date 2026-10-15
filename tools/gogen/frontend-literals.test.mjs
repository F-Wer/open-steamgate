import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";

const compile = (body) => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-literal-"));
  try {
    writeFileSync(join(dir, "zcl_lit.clas.abap"), `CLASS zcl_lit DEFINITION PUBLIC.
PUBLIC SECTION. CLASS-METHODS pick IMPORTING p TYPE string RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_lit IMPLEMENTATION.
METHOD pick. ${body} ENDMETHOD.
ENDCLASS.`);
    return compileProgram({folders: [dir], objects: ["ZCL_LIT"], tolerant: true});
  } finally { rmSync(dir, {recursive: true, force: true}); }
};
const literals = (p) => JSON.stringify(p.classes).match(/"e":"(?:str|chars)","value":"[^"]*"/g) ?? [];

test("the literal operator joins literals of one kind (inbox 049)", () => {
  const p = compile("CASE p. WHEN `abc` &\n `de``f`. r = 1. WHEN 'x' & 'y' & 'z'. r = 3. WHEN OTHERS. r = 2. ENDCASE.");
  assert.deepEqual(p.skipped, []);
  assert.deepEqual(literals(p), ['"e":"str","value":"abcde`f"', '"e":"chars","value":"xyz"']);
});

test("blanks inside joined text literals are kept (A4H: 'ab ' & 'c' is 'ab c')", () => {
  const p = compile("CASE p. WHEN 'ab ' & 'c'. r = 1. ENDCASE.");
  assert.deepEqual(p.partial, []);
  assert.match(JSON.stringify(p.classes), /"e":"chars","value":"ab c","type":\{"k":"c","len":4\}/);
});

test("DATA(x) = 'ab' & 'cd' takes the joined length, not the first literal's", () => {
  const p = compile("DATA(s) = 'ab' & 'cd'. r = strlen( s ).");
  assert.deepEqual(p.partial, []);
  assert.match(JSON.stringify(p.classes), /"s":"assign","target":\{[^}]*"name":"S"[^}]*"type":\{"k":"c","len":4\}/);
});

test("a DEFAULT joined by & is one literal", async () => {
  const {literalText} = await import("./frontend-literals.ts");
  assert.deepEqual(literalText("`ab` & `c``d`"), {quote: "`", value: "abc`d"});
  assert.deepEqual(literalText("'it''s' &\n 'x'"), {quote: "'", value: "it'sx"});
  assert.equal(literalText("`ab` & 'cd'"), null);
  assert.equal(literalText("`ab` & c_x"), null);
  assert.deepEqual(literalText("`a`"), {quote: "`", value: "a"});
});

test("single literals keep their values", () => {
  assert.deepEqual(literals(compile("CASE p. WHEN `a``b`. r = 1. WHEN 'it''s  '. r = 2. ENDCASE.")),
    ['"e":"str","value":"a`b"', '"e":"chars","value":"it\'s"']);
});
