// Public, generated fixtures only. Mutation descriptors are JSON so a failed
// run can be reproduced without relying on the PRNG's implementation later.
export const classSource = (name, body = "rv = 7.", type = "i", declaration = "") => `CLASS ${name} DEFINITION PUBLIC.
PUBLIC SECTION.
${declaration}
CLASS-METHODS run RETURNING VALUE(rv) TYPE ${type}.
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
METHOD run. ${body} ENDMETHOD.
ENDCLASS.
`;
const xml = (body) => `<?xml version="1.0"?><abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>${body}</asx:values></asx:abap></abapGit>`;
const cx = (name, sup) => `CLASS ${name} DEFINITION PUBLIC INHERITING FROM ${sup} CREATE PUBLIC.
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
ENDCLASS.
`;

export function syntheticCorpus({classes = 300, seed = 719} = {}) {
  if (!Number.isInteger(classes) || classes < 4) throw new Error("classes must be an integer >= 4");
  if (!Number.isInteger(seed)) throw new Error("seed must be an integer");
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const files = {}, objects = [];
  const addClass = (name, raw) => { files[`${name}.clas.abap`] = raw; objects.push(name.toUpperCase()); };
  // The first half is disconnected; the second is a seeded DAG with edges
  // pointing backwards. Keep at least four stable controls for edit scenarios.
  const name = (i) => `zcl_control_${String(i).padStart(4, "0")}`;
  for (let i = 0; i < classes; i++) addClass(name(i), classSource(name(i),
    i >= classes / 2 ? `rv = ${name(random() % i)}=>run( ) + ${random() % 10}.` : `rv = ${random() % 100}.`));
  // A stable reverse dependent exists even at the minimum corpus size.
  addClass("zcl_control_reader", classSource("zcl_control_reader", "rv = zcl_control_0001=>run( )."));
  addClass("zcl_pool_implicit", classSource("zcl_pool_implicit", "rv = 7.", "zorc_value"));
  addClass("zcl_pool_explicit", classSource("zcl_pool_explicit", "rv = 7.", "zorc_value", "TYPE-POOLS zorc."));
  addClass("zcl_pool_constant_explicit", classSource("zcl_pool_constant_explicit", "rv = zorc_default.", "i", "TYPE-POOLS zorc."));
  addClass("zcl_pool_constant_implicit", classSource("zcl_pool_constant_implicit", "rv = zorc_default."));
  files["zorc.type.abap"] = "TYPE-POOL zorc.\nTYPES zorc_value TYPE i.\nCONSTANTS zorc_default TYPE i VALUE 7.\n";
  addClass("zcl_local_macro", classSource("zcl_local_macro", "oracle_local."));
  files["zcl_local_macro.clas.macros.abap"] = "DEFINE oracle_local. rv = 7. END-OF-DEFINITION.\n";
  addClass("zcl_include_macro", classSource("zcl_include_macro", "oracle_include."));
  files["zcl_include_macro.clas.macros.abap"] = "INCLUDE zoracle_macros.\n";
  files["zoracle_macros.prog.abap"] = "DEFINE oracle_include. rv = 7. END-OF-DEFINITION.\n";
  addClass("zcl_order_macro", classSource("zcl_order_macro", "oracle_order."));
  files["zcl_order_macro.clas.locals_def.abap"] = "DEFINE oracle_order. rv = 1. END-OF-DEFINITION.\n";
  files["zcl_order_macro.clas.macros.abap"] = "DEFINE oracle_order. rv = 2. END-OF-DEFINITION.\n";
  addClass("zcl_defaults", classSource("zcl_defaults", "rv = value.", "i", "CONSTANTS value TYPE i VALUE 7.")
    .replace("run RETURNING", "run IMPORTING iv TYPE i DEFAULT 7 RETURNING"));
  addClass("zcl_default_reader", classSource("zcl_default_reader", "rv = zcl_defaults=>run( )."));
  addClass("zcl_constant_reader", classSource("zcl_constant_reader", "rv = zcl_defaults=>value."));
  for (const [n, sup] of [["zcl_parent", null], ["zcl_parent_other", null], ["zcl_child", "zcl_parent"], ["zcl_grandchild", "zcl_child"]]) {
    addClass(n, sup ? `CLASS ${n} DEFINITION PUBLIC INHERITING FROM ${sup}.\n${n === "zcl_grandchild" ? "PUBLIC SECTION. CLASS-METHODS read RETURNING VALUE(rv) TYPE i." : ""}\nENDCLASS.\nCLASS ${n} IMPLEMENTATION.\n${n === "zcl_grandchild" ? "METHOD read. rv = shared. ENDMETHOD." : ""}\nENDCLASS.\n` : classSource(n, "rv = 7.", "i", `CLASS-DATA shared TYPE ${n === "zcl_parent" ? "i" : "int8"}.`));
  }
  files["zif_oracle.intf.abap"] = "INTERFACE zif_oracle PUBLIC. METHODS value RETURNING VALUE(rv) TYPE i. ENDINTERFACE.\n";
  addClass("zcl_interface", `CLASS zcl_interface DEFINITION PUBLIC.
PUBLIC SECTION. INTERFACES zif_oracle. ALIASES answer FOR zif_oracle~value.
CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_interface IMPLEMENTATION.
METHOD zif_oracle~value. rv = 7. ENDMETHOD.
METHOD run. DATA obj TYPE REF TO zcl_interface. CREATE OBJECT obj. rv = obj->answer( ). ENDMETHOD.
ENDCLASS.
`);
  addClass("cx_root", "CLASS cx_root DEFINITION PUBLIC CREATE PUBLIC. ENDCLASS.\nCLASS cx_root IMPLEMENTATION. ENDCLASS.\n");
  addClass("zcx_oracle", cx("zcx_oracle", "cx_root"));
  addClass("zcx_other", cx("zcx_other", "cx_root"));
  addClass("zcx_leaf", cx("zcx_leaf", "zcx_oracle"));
  addClass("zcl_catch", classSource("zcl_catch", "TRY. RAISE EXCEPTION TYPE zcx_leaf. CATCH zcx_oracle. rv = 1. CATCH zcx_other. rv = 2. ENDTRY."));
  addClass("zcl_events", `CLASS zcl_events DEFINITION PUBLIC.
PUBLIC SECTION.
EVENTS changed EXPORTING VALUE(value) TYPE i.
METHODS handle FOR EVENT changed OF zcl_events IMPORTING value.
METHODS fire.
CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_events IMPLEMENTATION.
METHOD handle. DATA n TYPE i. n = value. ENDMETHOD.
METHOD fire. RAISE EVENT changed EXPORTING value = 7. ENDMETHOD.
METHOD run. DATA obj TYPE REF TO zcl_events. CREATE OBJECT obj. SET HANDLER obj->handle FOR obj. obj->fire( ). rv = 7. ENDMETHOD.
ENDCLASS.
`);
  files["zoracle_num.doma.xml"] = xml("<DD01V><DOMNAME>ZORACLE_NUM</DOMNAME><DATATYPE>INT4</DATATYPE><LENG>000010</LENG><OUTPUTLEN>000011</OUTPUTLEN></DD01V>");
  files["zoracle_num.dtel.xml"] = xml("<DD04V><ROLLNAME>ZORACLE_NUM</ROLLNAME><DOMNAME>ZORACLE_NUM</DOMNAME><REFKIND>D</REFKIND></DD04V>");
  files["zoracle_tab.tabl.xml"] = xml(`<DD02V><TABNAME>ZORACLE_TAB</TABNAME><TABCLASS>TRANSP</TABCLASS></DD02V><DD03P_TABLE>
<DD03P><FIELDNAME>ID</FIELDNAME><KEYFLAG>X</KEYFLAG><DATATYPE>CHAR</DATATYPE><LENG>000004</LENG></DD03P>
<DD03P><FIELDNAME>VALUE</FIELDNAME><ROLLNAME>ZORACLE_NUM</ROLLNAME><COMPTYPE>E</COMPTYPE></DD03P></DD03P_TABLE>`);
  addClass("zcl_ddic", classSource("zcl_ddic", "DATA row TYPE zoracle_tab. DATA val TYPE zoracle_num. SELECT SINGLE * FROM zoracle_tab INTO row. val = row-value. rv = val."));
  files["zoracle_group.fugr.xml"] = xml(`<INCLUDES><SOBJ_NAME>LZORACLE_GROUPTOP</SOBJ_NAME><SOBJ_NAME>SAPLZORACLE_GROUP</SOBJ_NAME></INCLUDES>
<FUNCTIONS><item><FUNCNAME>ZORACLE_FUNCTION</FUNCNAME><IMPORT><RSIMP><PARAMETER>IV_VALUE</PARAMETER><TYP>I</TYP><OPTIONAL>X</OPTIONAL></RSIMP></IMPORT><EXPORT><RSEXP><PARAMETER>EV_VALUE</PARAMETER><TYP>I</TYP></RSEXP></EXPORT></item></FUNCTIONS>`);
  files["zoracle_group.fugr.saplzoracle_group.abap"] = "INCLUDE lzoracle_grouptop.\n";
  files["zoracle_group.fugr.lzoracle_grouptop.abap"] = "FUNCTION-POOL zoracle_group.\n";
  files["zoracle_group.fugr.zoracle_function.abap"] = "FUNCTION zoracle_function. ev_value = iv_value. ENDFUNCTION.\n";
  objects.push("ZORACLE_GROUP");
  addClass("zcl_function", classSource("zcl_function", "CALL FUNCTION 'ZORACLE_FUNCTION' EXPORTING iv_value = 7 IMPORTING ev_value = rv."));
  addClass("zcl_absent_reader", classSource("zcl_absent_reader", "rv = zcl_added=>run( )."));
  // This is a same-object source-hash regression, not evidence that a
  // cross-object location-only definition fingerprint is guarded.
  files["zcl_control_0000.clas.testclasses.abap"] = `CLASS lcl_same DEFINITION. PUBLIC SECTION. CONSTANTS value TYPE i VALUE 1.
CLASS-METHODS run RETURNING VALUE(rv) TYPE i. ENDCLASS.
CLASS lcl_same IMPLEMENTATION. METHOD run. rv = value. ENDMETHOD. ENDCLASS.
`;
  const mutations = [], edit = (kind, file, from, to) => mutations.push({kind, edits: [{file, from, to}]});
  const control = "zcl_control_0001.clas.abap", original = files[control];
  edit("comment-only", control, "PUBLIC SECTION.", 'PUBLIC SECTION.\n" seeded oracle comment');
  edit("whitespace", control, "METHOD run.", "METHOD   run.\n");
  edit("method-body", control, original.match(/rv = \d+/)[0], "rv = 901");
  edit("signature", control, "TYPE i", "TYPE int8");
  edit("class-constant", "zcl_defaults.clas.abap", "VALUE 7", "VALUE 9");
  edit("parameter-default", "zcl_defaults.clas.abap", "DEFAULT 7", "DEFAULT 9");
  edit("superclass", "zcl_child.clas.abap", "FROM zcl_parent.", "FROM zcl_parent_other.");
  edit("exception-superclass", "zcx_leaf.clas.abap", "FROM zcx_oracle", "FROM zcx_other");
  edit("interface", "zif_oracle.intf.abap", "TYPE i", "TYPE int8");
  edit("alias", "zcl_interface.clas.abap", "ALIASES answer", "ALIASES renamed");
  edit("event", "zcl_events.clas.abap", "VALUE(value) TYPE i", "VALUE(value) TYPE int8");
  mutations.push({kind: "add-object", edits: [{file: "zcl_added.clas.abap", contents: classSource("zcl_added")}], addObjects: ["ZCL_ADDED"]});
  mutations.push({kind: "remove-object", edits: [{file: control, remove: true}]});
  mutations.push({kind: "rename", edits: [{file: control, remove: true}, {file: "zcl_renamed.clas.abap", contents: original.replaceAll("zcl_control_0001", "zcl_renamed")}], addObjects: ["ZCL_RENAMED"]});
  edit("ddic-field", "zoracle_tab.tabl.xml", "<FIELDNAME>ID</FIELDNAME>", "<FIELDNAME>IDENT</FIELDNAME>");
  edit("ddic-type", "zoracle_num.doma.xml", "INT4", "INT8");
  edit("ddic-key", "zoracle_tab.tabl.xml", "<KEYFLAG>X</KEYFLAG>", "<KEYFLAG></KEYFLAG>");
  edit("ddic-data-element", "zoracle_num.dtel.xml", "<DOMNAME>ZORACLE_NUM</DOMNAME>", "<DATATYPE>INT8</DATATYPE><LENG>000019</LENG>");
  edit("class-macro", "zcl_local_macro.clas.macros.abap", "rv = 7", "rv = 9");
  edit("include-macro", "zoracle_macros.prog.abap", "rv = 7", "rv = 9");
  edit("pool-type", "zorc.type.abap", "TYPES zorc_value TYPE i", "TYPES zorc_value TYPE int8");
  edit("pool-constant", "zorc.type.abap", "VALUE 7", "VALUE 9");
  edit("fugr-signature", "zoracle_group.fugr.xml", "<TYP>I</TYP>", "<TYP>INT8</TYP>");
  edit("same-object-local-definition", "zcl_control_0000.clas.testclasses.abap", "VALUE 1", "VALUE 9");
  mutations.push({kind: "file-order", order: ["zcl_order_macro.clas.macros.abap", "zcl_order_macro.clas.locals_def.abap"]});
  return {files, objects, mutations, seed, classes,
    featureClasses: [...objects.filter((o) => !o.startsWith("ZCL_CONTROL_") || o === "ZCL_CONTROL_READER"), "ZCL_CONTROL_0000:LCL_SAME"]};
}
