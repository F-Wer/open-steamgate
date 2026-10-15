import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {elementaryFieldsWithoutRollname, assertTableFieldsTyped, TRANSPARENT} from "./frontend-ddic.mjs";

const require = createRequire(import.meta.url);
const abaplint = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
const table = (fields, tabclass = "TRANSP") => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>
<DD02V><TABNAME>ZPROBE</TABNAME><TABCLASS>${tabclass}</TABCLASS></DD02V>
<DD03P_TABLE>${fields.map((f) => `<DD03P>${f}</DD03P>`).join("")}</DD03P_TABLE>
</asx:values></asx:abap></abapGit>`;
const registry = (fields, tabclass) => {
  const reg = new abaplint.Registry();
  reg.addFile(new abaplint.MemoryFile("zprobe.tabl.xml", table(fields, tabclass)));
  return reg.parse();
};

test("fields typed by a data element, a built-in or a structure pass", () => {
  const reg = registry([
    "<FIELDNAME>A</FIELDNAME><COMPTYPE>E</COMPTYPE><ROLLNAME>ZTEXT</ROLLNAME><DATATYPE>CHAR</DATATYPE>",
    "<FIELDNAME>B</FIELDNAME><COMPTYPE>E</COMPTYPE><ROLLNAME><![CDATA[ZTEXT]]></ROLLNAME><DATATYPE>CHAR</DATATYPE>",
    "<FIELDNAME>C</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>2</LENG>",
    "<FIELDNAME>D</FIELDNAME><COMPTYPE>S</COMPTYPE><ROLLNAME>ZSTRUC</ROLLNAME>",
    "<FIELDNAME>E</FIELDNAME><COMPTYPE>E</COMPTYPE><ROLLNAME>ZTEXT</ROLLNAME>",
  ]);
  assert.deepEqual(elementaryFieldsWithoutRollname(reg), []);
  assertTableFieldsTyped(reg);
});

test("only transparent tables are checked, as DatabaseSetup builds only those", () => {
  assert.equal(TRANSPARENT, abaplint.Objects.TableCategory.Transparent);
  for (const tabclass of ["INTTAB", "APPEND"])
    assert.deepEqual(elementaryFieldsWithoutRollname(registry(["<FIELDNAME>A</FIELDNAME><COMPTYPE>E</COMPTYPE><DATATYPE>CHAR</DATATYPE><LENG>2</LENG>"], tabclass)), []);
});

test("COMPTYPE E with a DATATYPE and no ROLLNAME is named, whatever the empty form", () => {
  const reg = registry([
    "<FIELDNAME>MANDT</FIELDNAME><COMPTYPE>E</COMPTYPE><DATATYPE>CLNT</DATATYPE>",
    "<FIELDNAME>X</FIELDNAME><COMPTYPE>E</COMPTYPE><ROLLNAME/><DATATYPE>CHAR</DATATYPE>",
    "<FIELDNAME>Y</FIELDNAME><COMPTYPE> E </COMPTYPE><ROLLNAME><![CDATA[ ]]></ROLLNAME><!-- c --><DATATYPE>INT4</DATATYPE>",
    "<FIELDNAME>Z</FIELDNAME><COMPTYPE>E</COMPTYPE><LENG>2</LENG>",
  ]);
  assert.deepEqual(elementaryFieldsWithoutRollname(reg),
    ["ZPROBE-MANDT (DATATYPE CLNT)", "ZPROBE-X (DATATYPE CHAR)", "ZPROBE-Y (DATATYPE INT4)", "ZPROBE-Z (DATATYPE none)"]);
  assert.throws(() => assertTableFieldsTyped(reg), /no ROLLNAME: ZPROBE-MANDT \(DATATYPE CLNT\), ZPROBE-X/);
});
