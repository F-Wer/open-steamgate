import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";

test("only ASCII character literals fold, including structure fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "constant-unicode-"));
  try {
    const fields = ["c LENGTH 2", "c LENGTH 3", "n LENGTH 3", "d", "t", "string"];
    writeFileSync(join(dir, "zcl_constant_unicode.clas.abap"), `
CLASS zcl_constant_unicode DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS run. ENDCLASS.
CLASS zcl_constant_unicode IMPLEMENTATION. METHOD run.
${fields.map((type, i) => `CONSTANTS u${i} TYPE ${type} VALUE '😀z'.
CONSTANTS a${i} TYPE ${type} VALUE '12'.
CONSTANTS: BEGIN OF r${i}, ascii${i} TYPE c VALUE 'a', unicode${i} TYPE ${type} VALUE '😀z', END OF r${i}.`).join("\n")}
ENDMETHOD. ENDCLASS.`);
    const p = compileProgram({folders: [dir], objects: ["ZCL_CONSTANT_UNICODE"]});
    assert.deepEqual(p.partial, []);
    const constants = [...p.consts.values()];
    assert.equal(constants.length, fields.length);
    assert.ok(constants.every((c) => c.init && !String(c.init.value).includes("😀")));
    for (const emitted of [emitGo(p), emitJs(p)]) {
      assert.match(emitted, /CFit\("😀z", 2\)/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
