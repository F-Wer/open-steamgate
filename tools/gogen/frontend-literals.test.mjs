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

test("a text literal with trailing blanks before & is refused, not guessed", () => {
  const p = compile("CASE p. WHEN 'ab ' & 'c'. r = 1. ENDCASE.");
  assert.match(p.partial.join("\n"), /ZCL_LIT=>PICK .*trailing blanks before &/);
});

test("single literals keep their values", () => {
  assert.deepEqual(literals(compile("CASE p. WHEN `a``b`. r = 1. WHEN 'it''s  '. r = 2. ENDCASE.")),
    ['"e":"str","value":"a`b"', '"e":"chars","value":"it\'s"']);
});
