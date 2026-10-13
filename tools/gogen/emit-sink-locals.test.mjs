import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileProgram} from './frontend.mjs';
import {emitGo} from './emit-go.mjs';

test("sinking retains names bound by generated code in descendant closures", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "gogen-sink-descendant-"));
  const previous = process.env.GOGEN_SINK_LOCALS;
  try {
    writeFileSync(join(sourceDir, "zcl_sink_descendant.clas.abap"), `
CLASS zcl_sink_descendant DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_sink_descendant IMPLEMENTATION.
 METHOD run.
 DATA tab TYPE STANDARD TABLE OF i WITH DEFAULT KEY.
 DATA x TYPE i.
 DO 2 TIMES.
   CLEAR x.
   IF rv = 0.
     SORT tab.
   ENDIF.
   rv = rv + x.
 ENDDO.
 ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [sourceDir], objects: ["ZCL_SINK_DESCENDANT"]});
    process.env.GOGEN_SINK_LOCALS = '1';
    const go = emitGo(program);
    assert.match(go, /x, y :=/);
    assert.match(go, /^\tvar x int32$/m);
    assert.doesNotMatch(go, /^\t{2,}var x int32$/m);
  } finally {
    if (previous === undefined) delete process.env.GOGEN_SINK_LOCALS;
    else process.env.GOGEN_SINK_LOCALS = previous;
    rmSync(sourceDir, {recursive: true, force: true});
  }
});
