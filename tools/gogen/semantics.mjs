// ABAP semantics pinned against A4H: each class in testdata/ has a static
// RUN returning a string, and EXPECT below is what A4H returned for the same
// code (ABAP Unit probe, 2026-09-23), except entries marked unmeasured.
// Both emitters must give it.
//
//   node tools/gogen/semantics.mjs
import {execFileSync} from "node:child_process";
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {compileProgram} from "./frontend.mjs";
import {emitGo, funcName} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";
import {home} from "./home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXPECT = {
  // Unmeasured: documented TABLES aliasing, positional components, nested rows,
  // and DELETE INDEX at / before / after the loop cursor (or a missing index).
  ZCL_GOGEN_T_GENLOOP: "std:0/before/1/written/nested sorted:0/before/1/written/nested hashed:0/before/1/written/nested sorted-delete:abc/0 fm1:abc/0 any1:abc/0 typed1:abc/0 fm2:abc/1 any2:abc/1 typed2:abc/1 fm3:abc/3 any3:abc/3 typed3:abc/3 fm4:ac/1 any4:ac/1 typed4:ac/1 fm5:abc/0 any5:abc/0 typed5:abc/0",
  // unmeasured; ABAP documentation: generic binary rows, writable components, and failed assignment.
  ZCL_GOGEN_T_BINARY: "x:0102A0B0 miss:4/free miss:4/free/CCDD/CCDD s:1122 second:0/Q miss:4/free/CCDD/Q any:CCDDCCDD miss:4/free miss:4/free omitted:[]",
  // Unmeasured regression: nested classic mappings; OTHERS cannot take a class exception.
  ZCL_GOGEN_T_CLASSICNEST: "0/3/7/9/class",
  // Unmeasured regression: recursive MESSAGE masking and nested classic mappings.
  ZCL_GOGEN_T_CALLSCOPE: {Go: "continue/outer/7/ZZ/S/007/nested/9/continue/outer3/0//5/11/continue/outer3/0/continue/",
    JS: "ERROR NOT_COMPILED in abap.MessageRaise: a host function of the Go runtime"},
  // Unmeasured: ABAP value semantics
  ZCL_GOGEN_T_MOVCLR: "clear:3,0 append:1,9 delete:2,2 free:4,2,8 deep:6,10 component:14,16 object:18,19 loop:11,2,13",
  // Unmeasured: ABAP value semantics; a forwarded row reference must not alias the copy.
  ZCL_GOGEN_T_MOVFWD: "1",
  // TASK5: initial NUMC(3) and character message fields.
  ZCL_GOGEN_T_MSGINITIAL: "000//////",
  // TASK5 supplied CS oracle; other operators follow SAP character comparison rules.
  ZCL_GOGEN_T_INITIALCS: "ok",
  // TASK4 supplied oracles; fixed blanks and re-raise are documented regressions.
  ZCL_GOGEN_T_ADT4: "83700/20733/20733/[    83700 ]/1/2/X",
  // Unmeasured: private static buffer snapshots across an in-place store.
  ZCL_GOGEN_T_STATICOWNED: "0102030401ABCD0401ABCD04ABCD",
  ZCL_GOGEN_T_STATICWRITE: "1/00ABCD00/4/00EE/aXYd!/0000EE00/7/19/0/9000000000/2/7",
  ZCL_GOGEN_T_STATICREC: "2001",
  // Supplied byte oracles plus documentation, unmeasured extensions (fixture NOTES.md).
  ZCL_GOGEN_T_INT8X: "0000000000000000FFFFFFFFFFFFFFFE/-2/0708/65535/-9223372036854775808/8000000000000000/0/00000000FFFFFFFE/-2/FFFFFFFE/documented",
  // Documentation-backed int8 limits, also checked against math/big in Go.
  ZCL_GOGEN_T_INT8ARITH: "-4/1/-4/4/1/4/-3/1/-4/div-overflow/round-overflow/0/1/0/1/1/9223372036854775807/0/0/9223372036854775807/-1/-2/9223372036854775806/-1/1/0/-1/1/-1/add-overflow/sub-overflow/mul-overflow/9223372036854775807/-1/4294967289/-30064771072/4294967289/0/packed-div-overflow/neg-overflow/-9223372036854775808/7/0/0/0/zero-div/zero-mod/zero-round",
  // Unmeasured regression: character bases, int8 concat and shared i formatting.
  ZCL_GOGEN_T_IPOWTEXT: "a42/42a/a42a/a5-/c:10/n:10/5-/2147483648-",
  // Unmeasured: documented integer power and packed assignment rounding.
  ZCL_GOGEN_T_IPOW: "1073741824/overflow/4611686018427387904/3.38/bytes:2/negative:-1/1/0.50/5.0000000000000000E-01/minimum:2147483648-/wide:4611686018427387904/zero-overflow/wide-overflow",
  // ABAPiti oracle 009, A4H 2026-10-02: fixed-x fitting and sy-subrc.
  ZCL_GOGEN_T_REPL009: "[12FF rc=2][AB00 rc=0][11A1A2A3 rc=2][11AB4400 rc=0][12FFFF rc=0][12AB rc=0][1234 rc=2][A1A2 rc=2]",
  // Unmeasured: fixed-x byte fitting and signed integer moves.
  ZCL_GOGEN_T_SINGLEBYTES: "255/-2147483648/254/255/FE7FFF80",
  // A raised exception retains reference writes and attributes, but discards
  // VALUE output and RETURNING copy-back (the same fixture runs in both hosts).
  // Unmeasured (SAP docs): classic exceptions retain by-reference TABLES writes.
  ZCL_GOGEN_T_EXCPARAMS: "ref/out/before/before/before/nxxx/nxxx/uyy/4/9/10/keep/1",
  // Unmeasured (SAP docs): optional defaults and exception class matching.
  ZCL_GOGEN_T_DEFAULTS: "7/11/13/17",
  ZCL_GOGEN_T_XCASE: "pad/prefix/length",
  ZCL_GOGEN_T_UNCATCH: {Go: "ERROR NOT_COMPILED in find( ): OCC = 0 was not measured at zcl_gogen_t_uncatch.clas.abap:8", JS: "ERROR NOT_COMPILED in find( ) OCC = 0 was not measured"},
  ZCL_GOGEN_T_ROWREF: "append:9",
  ZCL_GOGEN_T_ELEMREF: "append:9 read:8",
  ZCL_GOGEN_T_ELEMREFSTALE: {Go: "ERROR GETWA_NOT_ASSIGNED in reference to a deleted table row at zcl_gogen_t_elemrefstale.clas.abap:19", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_ROWDEL: {Go: "ERROR GETWA_NOT_ASSIGNED in reference to a deleted table row at zcl_gogen_t_rowdel.clas.abap:20", JS: "ERROR GETWA_NOT_ASSIGNED in reference to a deleted table row"},
  // AJSON's local serializer, dynamic sorted key, row references and UTF-8
  // SHA-256 (Node's open-abap-core/AJSON result for this fixture).
  ZCL_GOGEN_T_AJSON: {Go: '{"a":"x","b":[7]}|44FFF909E380AA93C5444E84BC9F1D4C5FF61F2A4A18592CBE02DBF44D8B5423',
    JS: "ERROR NOT_COMPILED in Native_DESCRIBE_BY_DATA: a host function of the Go runtime"},
  ZCL_GOGEN_T_WLIN: "0/2/0/1/0/0/4/0",
  ZCL_GOGEN_T_XATTR: "X",
  // GENERATE SUBROUTINE POOL, refused without an exception (not an A4H
  // value: there GENERATE works; a pool with an error is sy-subrc 4).
  // sy-subrc 8 ("other generation error" in SAP's documentation), NAME
  // initial, MESSAGE the fixed text, LINE 0, WORD initial, MESSAGE-ID and
  // OFFSET untouched. This compares gogen's two emitters (Go and JS), not
  // the abaplint transpiler; its branch generate-subroutine-pool-refusal
  // gives the same fields, by its own tests
  ZCL_GOGEN_T_GENPOOL: "8::GENERATE SUBROUTINE POOL is not supported:0::ID:5",
  ZCL_GOGEN_T_SUBX: "X",
  ZCL_GOGEN_T_DELRANGE: "0/3/4 0/2 4/2",
  ZCL_GOGEN_T_FMDEFAULT: "7/9",
  ZCL_GOGEN_T_RF_SORT_OK: "mv:ab vl:cd rk:dc empty:0 back:2",
  ZCL_GOGEN_T_SORTREF: "m:9 a:2",
  ZCL_GOGEN_T_COPYROWS: "1/2",
  ZCL_GOGEN_T_COPYROUTES: "111119",
  ZCL_GOGEN_T_COPYBASE: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_COPYBASE=>RUN (zcl_gogen_t_copybase.clas.abap:18): VALUE for a table with BASE src at zcl_gogen_t_copybase.clas.abap:18", JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_COPYBASE=>RUN (zcl_gogen_t_copybase.clas.abap:18): VALUE for a table with BASE src"},
  ZCL_GOGEN_T_COPYINSERT: "1",
  ZCL_GOGEN_T_COPYDATA: "1",
  ZCL_GOGEN_T_COPYHASH: "1",
  // abapiti 017: string -> int8; the first three A4H-measured (2026-10-03),
  // the bounds unmeasured
  ZCL_GOGEN_T_C2I8: "42/8000000000/-17/9223372036854775807/-9223372036854775808/ovf",
  // Unmeasured (ABAP keyword documentation: DELETE TABLE itab FROM wa matches
  // the primary table key only): hashed one-field key, hashed two-field key,
  // sorted unique key; the ADT front needs the hashed form (adt-i5, 10-08).
  ZCL_GOGEN_T_DELFROM: "0/1/4/1/b/0/21a2a/0/ac",
  ZCL_GOGEN_T_COPYDREF: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_COPYDREF=>RUN (zcl_gogen_t_copydref.clas.abap:19): target lr->* at zcl_gogen_t_copydref.clas.abap:19", JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_COPYDREF=>RUN (zcl_gogen_t_copydref.clas.abap:19): target lr->*"},
  ZCL_GOGEN_T_SCALARBIND: {Go: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation at zcl_gogen_t_scalarbind.clas.abap:18", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_REBIND: {Go: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation at zcl_gogen_t_rebind.clas.abap:18", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_INITBIND: {Go: "ERROR GETWA_NOT_ASSIGNED in reference to a deleted table row at zcl_gogen_t_initbind.clas.abap:14", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_BINDMUT: "2/1/0/0/0",
  ZCL_GOGEN_T_DELNOOPBIND: "7",
  ZCL_GOGEN_T_GENERICBIND: {Go: "ERROR GETWA_NOT_ASSIGNED in reference to a deleted table row at zcl_gogen_t_genericbind.clas.abap:15", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_SCALARREAD: {Go: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation at zcl_gogen_t_scalarread.clas.abap:17", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_SCALARLOOP: {Go: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation at zcl_gogen_t_scalarloop.clas.abap:19", JS: "ERROR GETWA_NOT_ASSIGNED in table row binding after structural mutation"},
  ZCL_GOGEN_T_SECREF: "0/7",
  ZCL_GOGEN_T_BOUND: "X",
  // Arithmetic statements share the assignment calculation type: i division
  // rounds 21 / 2 to 11, while packed decimal retains its two places.
  ZCL_GOGEN_T_ARSTMT: "i:11 p:11.25",
  ZCL_GOGEN_T_IDEF: "base/child",
  // parity-wave1, A4H 2026-09-24 ($ZOSG_TMP_0050, ABAP Unit probes of the
  // same classes). escape( format = e_json_string ): \\ and " escaped,
  // \b \t \n \f \r, the other control characters \u00XX in upper case,
  // U+007F, / ' and non-ASCII as they are; a c without its trailing blanks
  ZCL_GOGEN_T_JSESC: "p:[a\\\\b\\\"c/d'e f ] cc:\\u0000,\\u0001,\\u0002,\\u0003,\\u0004,\\u0005,\\u0006,\\u0007,\\b,\\t,\\n,\\u000B,\\f,\\r,\\u000E,\\u000F,\\u0010,\\u0011,\\u0012,\\u0013,\\u0014,\\u0015,\\u0016,\\u0017,\\u0018,\\u0019,\\u001A,\\u001B,\\u001C,\\u001D,\\u001E,\\u001F, del:11 u:31 c:[a\\\"b]4 g:[x\\\"y ][a\\\"b]",
  // a generic operand against c / string holding a c or a string: the typed
  // rule (both strings, a c without trailing blanks)
  ZCL_GOGEN_T_GENCMP: "ty:10101 c:1011101111 s:001011 c1:01110,10010",
  // a string into a d / t, generic and typed alike: the first 8 / 6
  // characters, an empty string initial, a short t filled with zeros
  ZCL_GOGEN_T_GENMOVD: "d:[20250107]0120258,[2025010]0120257,[00000000]1100008,[abc]01abc3,[20250107]0120258,[2025-01-]0120258,[ 2025010]01 2028,c[19991231] t:[202501]01,[202501]01,[000000]11,[abc000]01,[202501]01,[2025-0]01,[ 20250]01,",
  // SELECT ... FOR ALL ENTRIES: the rows unique over the columns selected
  // (sy-dbcnt counts them after), an empty driving table ignores the whole
  // WHERE, INTO TABLE replaces the target, no row is 4/0 and an empty table
  ZCL_GOGEN_T_FAE: {Go: "dup:0/2/2,A1,C2 col:0/2/2,1,2 two:0/2,B2,D3 empty:0/4/4 cor:0/2,2[],3[] none:4/0/0",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // describe_by_data's OUTPUT_LENGTH of a dictionary type: the domain's
  // OUTPUTLEN, or the data element's without a domain (A4H ran it with SAP's
  // data elements of the same shape, see the class)
  // CALL FUNCTION of a module compiled with the program: by-value EXPORTING
  // starts initial in the module; after RAISE the caller's EXPORTING and
  // CHANGING fields keep their values and the TABLES rows appended stay;
  // an optional importing left out is initial, OTHERS takes an exception
  // not named
  ZCL_GOGEN_T_FM: "ok:0/6/11/2/in:3/0/10/1 boom:4/5/10/3/keep opt:0/11/4 oth:7/11/5,X0,F3,F4,F0,F0 omitted:in:0/0/11/0 omitted:in:0/0/12/0",
  ZCL_GOGEN_T_RTTIOL: {Go: "C/80/0/10 C/2/0/80 C/10/0/5 P/8/0/19 N/4/0/1 ",
    JS: "ERROR NOT_COMPILED in Native_DESCRIBE_BY_DATA: a host function of the Go runtime"},
  // ultra/itab, A4H 2026-09-24 ($ZOSG_TMP_0400, ABAP Unit probes of the same
  // classes). APPEND LINES OF [FROM] [TO]: sy-subrc untouched, sy-tabix
  // lines(target) afterwards, c rows into a string table converted, itab
  // TO itab doubles it (FROM 0 and TO 0 dump TABLE_INVALID_INDEX there)
  ZCL_GOGEN_T_APPL: "all:4/6[0;1;2;3;4;5;] ft:4/3[2;3;4;] f:[4;5;] t:[1;2;] rev:0/0[] past:[] clamp:[3;4;5;] empty:4/3[3;4;5;] call:6[3;4;5;7;8;9;]<q ><ab><xyz> self:[1;2;3;4;5;1;2;3;4;5;]",
  // SORT: without BY by the default key (the line; for a structure its c
  // and string components, not the i), DESCENDING, STABLE BY, mixed
  // directions; a string "a" sorts before "a "
  // SELECT ... COUNT( * ) / MAX / MIN / SUM ... GROUP BY into a table, by
  // position (aggregate first in the field list too) and CORRESPONDING
  ZCL_GOGEN_T_GRPBY: {Go: "g:0/3,1=1,2=3,3=1 g0:4/0/0 cor:2,3=1,2=3 agg:3,1:A/A/1,2:C/AB/6,3:D/D/3 two:3,AB2=1,B2=1,C2=1",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // arithmetic with a generic operand or target: the calculation type of
  // the run-time types (/ 2 * 2 tells i from p: 7 / 2 * 2 is 8 in i, 7 in p;
  // a c, string or n operand makes it p, an f f, a p target p)
  ZCL_GOGEN_T_GENAR: "i:8,70,7.00 i8:8 p:8,1.88 c:7 s:7 n:7 f:8 ti:8,-3 tp:7.00,1.75",
  // cl_abap_conv_in_ce=>uccp( 'hhhh' ) of a literal (zcl_stg_segw_gen's BOM)
  ZCL_GOGEN_T_UCCP: "A/1/65279",
  // LOOP / DELETE itab WHERE a-b = v and c IS [NOT] INITIAL (a structure
  // component too)
  ZCL_GOGEN_T_LOOPW: "a:11;33; b:1;4; c:3; d:4; e:1;3; del:0/3/4/3",
  // template WIDTH / ALIGN / PAD, PAD = '=' among them (the option parser
  // cut a quoted '=' in two)
  ZCL_GOGEN_T_TPLPAD: "zcl_x=====CP/zcl_x/ab.../000zcl_x/zcl_x==",
  // NS / CN (negated CS / CO); DELETE itab inside LOOP AT itab deletes the
  // current row and the loop goes on with the next (two in a row here)
  ZCL_GOGEN_T_NSCN: "01011-3-3 3:T1Berlin;T2Aarhus;T5Bergen;",
  // ultra/itab critic fixes: honest refusals of what A4H was not asked
  ZCL_GOGEN_T_DELFS: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_DELFS=>STALE (zcl_gogen_t_delfs.clas.abap:42): <L> used after DELETE of its row inside the LOOP: not measured at zcl_gogen_t_delfs.clas.abap:42", JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_DELFS=>STALE (zcl_gogen_t_delfs.clas.abap:42): <L> used after DELETE of its row inside the LOOP: not measured"},
  ZCL_GOGEN_T_DELTO: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_DELTO=>RUN (zcl_gogen_t_delto.clas.abap:15): DELETE itab inside LOOP ... TO: not measured: DELETE lt. at zcl_gogen_t_delto.clas.abap:15", JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_DELTO=>RUN (zcl_gogen_t_delto.clas.abap:15): DELETE itab inside LOOP ... TO: not measured: DELETE lt."},
  ZCL_GOGEN_T_GRPCOR: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_GRPCOR=>RUN (zcl_gogen_t_grpcor.clas.abap:13): SELECT aggregate without AS INTO CORRESPONDING FIELDS: not measured: SELECT val MAX( id ) FROM zgogen_t_dbw INTO CORRESPONDING FIELDS OF TABLE lt GROUP BY val. at zcl_gogen_t_grpcor.clas.abap:13", JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_GRPCOR=>RUN (zcl_gogen_t_grpcor.clas.abap:13): SELECT aggregate without AS INTO CORRESPONDING FIELDS: not measured: SELECT val MAX( id ) FROM zgogen_t_dbw INTO CORRESPONDING FIELDS OF TABLE lt GROUP BY val."},
  ZCL_GOGEN_T_SORTK: "s:<><B><C><a><a ><b> sd:<b><a ><a><C><B><> c:<><C><a><ab><b> i:-1;2;3; st:A2z;a5y;a4y;a3y;a9a;b1x; mix:b1x;a3y;a4y;a5y;a9a;A2z; key:A2z;a9a;a3y;a4y;a5y;b1x;",
  // an IMPORTING by reference sees what CHANGING did to the same table,
  // APPEND included: it:3,99 on A4H
  ZCL_GOGEN_T_COPY: "copy a:2,1 b:3,50 struct a:1 b:60 alias it:3,99 after:3,99",
  // a division by zero raises; the harness reports it with the ABAP line
  // the stack names (the line directives of emit-go)
  // not an A4H value: what each emitter must report. Go names the ABAP
  // line through its line directives; the JS emitter has no source map yet
  // CREATE OBJECT TYPE (name): the name as written, so lower case is an
  // unknown class, as is a class that does not exist
  // DELETE <name> FROM n on an internal table named like a TABL is the
  // internal table's statement: A4H answered "lines:1  subrc:0" (over an
  // itab named T000). DELETE itab FROM idx is not in the subset yet, so both
  // emitters refuse it as an internal DELETE form; what this pins is that it
  // is not sent to the database (before the fix: "the relational IR has no
  // delete node")
  ZCL_GOGEN_T_DELNAME: "lines:1  subrc:0",
  ZCL_GOGEN_T_DYN: "upper:7 lower:err unknown:err",
  // CONCATENATE ... IN BYTE MODE into an xstring (A4H 2026-09-24, $ZOSG_TMP_0460;
  // ultra/packs, the SMW0 loaders of Zork and ZO4D): an x keeps its trailing
  // 00 bytes, an x never assigned is its length in 00, sy-subrc 0
  // byte-like comparisons (ultra/bytecmp, A4H 2026-09-24, $ZOSG_TMP_0480,
  // probes ZCL_GOGEN_T_XCMP, _XCMP2, _XCMP3 with these bodies): x against x
  // padded with 00; xstring (and x against xstring) bytes in order, a prefix
  // smaller; against c/string the upper-case hex digits compared as
  // characters; against i/n the last four bytes as a signed int32. The
  // transpiler differs in g (x against x of another length) and in all of
  // XCMPN (ANORMALIES byte-like-comparisons)
  ZCL_GOGEN_T_XCMP: "a:10010010 b:101011 c:1011010 d:0100111 e:100001101111010 f:010010010111 g:10010101101 h:101111111/1; a:01100011001 b:0110 c:00000011; s:000000000000011110; m:AB00/2 z:10000",
  ZCL_GOGEN_T_XCMPN: "xi:1111110 xn:1 xsi:111 l:1111 l2:11",
  // x / xstring moved into an i (A4H 2026-09-24, $ZOSG_TMP_0481; the move of
  // ZCL_ABAPGIT_CONVERT=>XSTRING_TO_INT): the last four bytes, signed. The
  // transpiler gives e:NaN x5:4294967298 xs5:4294967298
  // (ANORMALIES byte-to-i-move)
  ZCL_GOGEN_T_XMOVI: "a:11 b:-1 c:255 d:258 e:0 f:-2147483648 g:-2 h:255 x5:2 xs5:2",
  ZCL_GOGEN_T_BYTECAT: "cat:FFAB00CD00/5/0 zeros:0000AB00CD00/6 empty:0/0",
  // FIND ... IN [SECTION [OFFSET o] [LENGTH l] OF] xs IN BYTE MODE
  // [MATCH OFFSET m] [MATCH LENGTH ml]; bounded byte spans and REPLACE SECTION
  // and ALL OCCURRENCES MATCH COUNT / RESULTS are covered by the original
  // ABAPiti fixtures, the 23 P1/P2 A4H oracle tests and frontend-bytes.test.mjs.
  // See testdata/byte-section-notes.md for JS differences and provenance.
  // (A4H 2026-10-01, execute_abap): byte offsets, a miss leaves m alone with
  // sy-subrc 4, a section offset at the end is a miss and not an error, an
  // empty pattern is found where the search starts, an offset past the end
  // is CX_SY_RANGE_OUT_OF_BOUNDS
  // CATCH ... INTO an attribute (a report's global): a runtime exception read
  // in another method, a raised object with its attribute, a static attribute,
  // a CATCH of both kinds INTO one attribute, a local and a parameter of the
  // attribute's name. Derived, not measured on A4H: what a local gives
  // (\\CLASS= of the caught class, as ZCL_GOGEN_T_RAWRD measured for a local;
  // a raised object's text as ZCL_GOGEN_T_RAISE)
  ZCL_GOGEN_T_CATCHATTR: "rt:\\CLASS=CX_SY_ZERODIVIDE obj:X/3 static:\\CLASS=CX_SY_ARITHMETIC_OVERFLOW mixed:\\CLASS=CX_SY_ZERODIVIDE,\\CLASS=ZCX_GOGEN_T_RSUB shadow:5 param:[An exception was raised.]",
  ZCL_GOGEN_T_FINDBYTE: "a:0/1 b:0/4 c:0/2 d:4/7 e:4/7 f:4 g:0/0 h:0/3 i:range",
  // CONCATENATE LINES OF ... IN BYTE MODE and x = x + y grown in place
  // (abap.AppendBytes; the zip reader's read_all and the inflater).
  // Derived, not measured on A4H: the rows joined; an empty table gives an
  // empty xstring and sy-subrc 0; a view taken at 5000 bytes keeps them while
  // the history grows to 6000, and its own append ends in EE
  ZCL_GOGEN_T_BYTELINES: "empty:0/0 lines:ABCDEF/0 hist:6000/8889/70 old:5001/88EE fork:same",
  // cl_http_utility=>encode_x_base64: RFC 4648, padded (A4H 2026-09-24,
  // $ZOSG_TMP_0460; the LSD channel). A host function of the Go runtime: the
  // JS emitter refuses
  // the initial value of an x/d/t/n/p that nobody assigned, wherever it
  // lives: a structure component (nested too), a row APPENDed after CLEAR, a
  // CLASS-DATA, an instance attribute, a local, a RETURNING never set, a
  // component VALUE #( ) does not name (A4H 2026-09-24, $ZOSG_TMP_0461; the
  // transpiler 2.13.89 agrees). Before the ultra/packs fix round Go gave
  // s:0 row:0 static:0 inst:0 and "" for the d/t/n/p components
  ZCL_GOGEN_T_XINIT: "s:2 row:2 static:2 inst:2 00000000 nested:2 00000000 000000 000 0.00 comp:00000000 000000 000 0.00 loc:00000000 000000 000 0.00 ret:1 00 value:7 2 00000000 000",
  // parity-wave2, A4H 2026-09-24 ($ZOSG_TMP_0083, ABAP Unit probes of these
  // classes; CL_ABAP_ZIP's CRC-32 needs both). An x or xstring operand of
  // arithmetic is its move into an i (the last four bytes, signed) and
  // counts as an i for the calculation type; CONCATENATE IN BYTE MODE into
  // an x pads with 00 (sy-subrc 0) or cuts (sy-subrc 4)
  // parity-wave2, A4H 2026-09-25 ($ZOSG_TMP_0084, ABAP Unit probes of these
  // classes). FIND ... RESULTS into match_result / match_result_tab: POSIX
  // leftmost-longest (a|ab takes ab), a group that did not take part is
  // (-1,0), a FIRST that misses leaves the structure alone and an ALL that
  // misses clears the table, empty matches listed (x* in abc four times;
  // after bb of abbc the empty one at its end too). PCRE is leftmost-first
  // with lazy quantifiers. JS's RegExp is leftmost-first for REGEX as well:
  // a|ab gives 1,1 3,1 there (as FindStmt; the Go runtime is the exact one)
  ZCL_GOGEN_T_FINDRES: {Go: "alt:0/2[0:1,2;0:3,2;] grp:0/0:1,1(-1,0)(1,1) nest:2[0:0,2(0,2)(0,1)(1,1);0:2,2(2,2)(2,1)(3,1);] wb:2[0:0,2;0:7,2;] sub:2[0:0,2;0:2,2;] ic:2[0:1,2;0:3,2;] uni:1[0:2,1;] opt:0/0:1,1(-1,0) opt2:2[0:0,1(-1,0);0:1,2(2,1);] miss1:4/0:7,1(-1,0) missall:4/0[] empty:0/4[0:0,0;0:1,0;0:2,0;0:3,0;] empty2:0/4[0:0,0;0:1,2;0:3,0;0:4,0;] w:2[0:0,3(0,3);0:4,3(4,3);] posix:1[0:0,4(0,1)(1,3);]",
    JS: "alt:0/2[0:1,1;0:3,1;] grp:0/0:1,1(-1,0)(1,1) nest:2[0:0,2(0,2)(0,1)(1,1);0:2,2(2,2)(2,1)(3,1);] wb:2[0:0,2;0:7,2;] sub:2[0:0,2;0:2,2;] ic:2[0:1,2;0:3,2;] uni:1[0:2,1;] opt:0/0:1,1(-1,0) opt2:2[0:0,1(-1,0);0:1,2(2,1);] miss1:4/0:7,1(-1,0) missall:4/0[] empty:0/4[0:0,0;0:1,0;0:2,0;0:3,0;] empty2:0/4[0:0,0;0:1,2;0:3,0;0:4,0;] w:2[0:0,3(0,3);0:4,3(4,3);] posix:1[0:0,4(0,1)(1,3);]"},
  ZCL_GOGEN_T_FINDPCRE: "alt:2[1,1;3,1;] grp:1[0,4(0,1)(1,3);] empty:4[0,0;1,2;3,0;4,0;] wb:2[0,2;7,2;] opt:1[1,1(-1,0);] lazy:3[0,1;1,1;2,1;] ic:2[1,2;3,2;]",
  ZCL_GOGEN_T_XARITH: "div:F6DC4190/-153337456 mod:00000002 mul:000003FC ff:FFFFFFFF/0 x1:256 x2:65536 x8:255 xs:256 p:11.50 f:10.25 div2:4",
  // CL_ABAP_ZIP=>SAVE of two files, run against SAP's own CL_ABAP_ZIP on
  // A4H ($ZOSG_TMP_0083) and open-abap-core's here: the same frame, entry
  // count, first name and CRC-32 (zlib's too); SHIFT LEFT CIRCULAR IN BYTE
  // MODE rotates one byte. JS has no codepage host function
  ZCL_GOGEN_T_ZIP: {Go: "shift:BBAA/02030401 head:504B0304 eocd:504B0506 entries:0200 name:612E747874 crc:-1167589325",
    JS: "ERROR NOT_COMPILED in Native_CONV_OUT_CONVERT: a host function of the Go runtime"},
  ZCL_GOGEN_T_BYTECATX: "exact:000000AB/0 short:ABCDEF00/0 long:CDEF1234/4 rev:04030201/0 sub:000000B2/0",
  // parity-wave2, A4H 2026-09-24 ($ZOSG_TMP_0082, ABAP Unit probe of this
  // class, in two runs whose outputs are joined here): a text into an i is
  // blanks, one sign (leading + -, or trailing -, a blank after or before
  // it allowed), digits with at most one point, rounded half away from
  // zero, NN for anything else (an exponent, nan, 1_0, 0x10) and OV past
  // the range. Into an f the first word counts and the rest is ignored
  // ('12 abc' is 12, '- 12' NN), an exponent is allowed, 1E400 and the
  // words nan inf Infinity are OV, 1E-400 is 0. Go and JS both took
  // strconv.ParseFloat / Number( ) before (the $batch of mocha.mjs dumps
  // on Seats = "abc" by design: NN either way)
  ZCL_GOGEN_T_C2NUM: "[12]12/12.000 [ 12 ]12/12.000 [-12]-12/-12.000 [12-]-12/-12.000 [+12]12/12.000 [2.5]3/2.500 [-2.5]-3/-2.500 [.5]1/0.500 [5.]5/5.000 [1E3]NN/1000.000 [1e3]NN/1000.000 [1.5E+2]NN/150.000 [nan]NN/OV [inf]NN/OV [Infinity]NN/OV [0x10]NN/NN [1_0]NN/NN [1,5]NN/NN [12 3]NN/12.000 [abc]NN/NN []0/0.000 [   ]0/0.000 [-]NN/NN [3000000000]OV/3000000000.000 [12 abc]NN/12.000 [1 2 3]NN/1.000 [- 12]-12/NN [12 -]-12/12.000 [ -12 ]-12/-12.000 [1E 3]NN/NN [E3]NN/NN [1E]NN/NN [1e+]NN/NN [1.5.2]NN/NN [+-1]NN/NN [--1]NN/NN [-1-]NN/NN [0012]12/12.000 [.]NN/NN [+]NN/NN [2147483647.4]2147483647/2147483647.400 [2147483647.5]OV/2147483647.500 [-2147483648.5]OV/-2147483648.500 [-2147483648.4]-2147483648/-2147483648.400 [1.49999]1/1.500 [12 3 ]NN/12.000 [1E400]NN/OV [1E-400]NN/0.000 [1.5E3-]NN/-1500.000 [1.5D3]NN/NN [12a]NN/NN [1.e2]NN/100.000 [.5e1]NN/5.000 [1E+03]NN/1000.000 ",
  // parity-wave2, A4H 2026-09-24 ($ZOSG_TMP_0081, ABAP Unit probe of this
  // class): CREATE DATA LIKE LINE OF a generic table of elementary rows is
  // a new initial value of the row type (d 00000000, n zeros, i 0), which
  // is written and inserted (/UI2/CL_JSON into a table of strings, ZOSD_NOTE)
  ZCL_GOGEN_T_CRELEM: "s:g[][ab]1 s2:g[][cd]2 i:I[0 ][42 ]1 c:C[][abc]1 d:D[00000000][20250107]1 t:T[000000][123456]1 n:N[0000][0012]1",
  // parity-wave2, A4H 2026-09-24 ($ZOSG_TMP_0080, ABAP Unit probe of this
  // class): cl_abap_gzip=>compress_binary then decompress_binary gives the
  // input back, GZIP_OUT_LEN is xstrlen( gzip_out ), an empty input too,
  // 1000 repetitive bytes compress below 100; zlib's raw stream of 11223344
  // and one with a sync marker before an empty final block (Go's) both
  // inflate. The compressed bytes are not pinned: A4H writes zlib's
  // (130A312A63646160F8FF1F00 for 1254327601040000FFFF), Go its own
  ZCL_GOGEN_T_GZIP: {Go: "rt:11/8 e:11/0 big:11/1000 small:1 z:11223344/4 s:11223344/4",
    JS: "ERROR NOT_COMPILED in abap.DeflateRaw: a host function of the Go runtime"},
  // X0: measured on A4H (docs/dataset.md); the JS backend has no file system
  ZCL_GOGEN_T_DATASET: {Go: "t:61620A6364200A r:0/a/1 r:0/b/1 r:4//0 p:3 x:0/00FF0D/3 x:4/0A4100/2 x:4/000000/0 c:6100620020002000 m:8/No such file or directory e:open_mode d:0",
    JS: "ERROR NOT_COMPILED in DATASET: the JS backend has no file system (the Go host has the sandbox of go/abap/dataset.go)"},
  // table CORRESPONDING and table = / <> (A4H 2026-09-30): c into string
  // loses its blanks, i into n4 is zero-padded, a column the source lacks
  // stays initial; tables compare row by row in order, c without blanks
  ZCL_GOGEN_T_CORR: "[ab/0007/][abcdef/1234/] empty:0 copy:eq changed:ne shorter:ne reversed:ne blanks:eq wide:ne",
  ZCL_GOGEN_T_B64: {Go: "b1:/w== b2://4= b3:+/+/ b0:[]", JS: "ERROR NOT_COMPILED in abap.EncodeXBase64: a host function of the Go runtime"},
  // SHIFT s RIGHT DELETING TRAILING mask on a string: the length stays, the
  // masked tail goes and blanks come in on the left; a blank stops it
  // (A4H 2026-09-23, $batch parts end their body this way)
  // a generic EXPORTING (TYPE any) is the caller's variable, by reference:
  // not cleared on entry, written in place; MOVE-CORRESPONDING into it
  // converts component by component; CLEAR clears the caller's structure
  // (A4H 2026-09-23; the entry provider's read_entry_data does all three)
  ZCL_GOGEN_T_GENEXP: "set:5/x/keep corr:42/hel/keep clear:42/hel/[]",
  // not A4H values: standard ABAP the Travels path needed (review of
  // ultra/travels). Two flat structures of one technical type move by
  // position, names aside; DEFAULT names a constant of the class, bare or
  // as cls=>c. The conversions are open-abap's kernel code as Go host
  // functions: UTF-8 and 4103 (UTF-16LE) there and back, N cuts the text
  // before it is encoded; the JS emitter has no host function for them and
  // refuses
  ZCL_GOGEN_T_TRAVMISC: "move:pq/42/rst back:pq/5/rst dflt:dx/7 v/7 dx/1",
  ZCL_GOGEN_T_TRAVCONV: {Go: "u8:61C3A4E282AC>same u16:6100E400AC20>same cut8:6162 cut16:610062006300",
    JS: "ERROR NOT_COMPILED in Native_CONV_OUT_CONVERT: a host function of the Go runtime"},
  ZCL_GOGEN_T_SHIFT: "1:4[__ab] 2:4[_ab_] 3:2[ab] 4:0[] 5:4[_aNb] 6:1[_] 7:4[abN_] 8:5[___ab]",
  // inheritance: a base method's call on me reaches the redefinition, SUPER->
  // the superclass's; a protected attribute is one field across levels; in
  // the superclass's constructor me->name( ) is the superclass's own
  // (ctor:base); ?= down, an initial reference widened stays initial, and an
  // initial reference casts without CX_SY_MOVE_CAST_ERROR
  ZCL_GOGEN_T_INH: "sub<base>/k/t1+ ctor:base down:k initial dyn:sub<base> nullcast:ok",
  // RETURN out of a TRY body and out of a CATCH, CONTINUE and EXIT of a DO
  // from inside two nested TRYs (Go runs a TRY as a closure and hands these
  // out as codes)
  ZCL_GOGEN_T_TRYFLOW: "b cd caught a1 13!",
  // A write in a TRY loop is visible after an exception leaves the loop,
  // even when neither CATCH nor CLEANUP reads the string.
  ZCL_GOGEN_T_TRYAPPEND: "axx",
  ZCL_GOGEN_T_TRYAPPEND_CLEANUP: "axx",
  // CP / NP / CA / NA; A4H gave "... ca:X1---X", the 1 being sy-fdpos,
  // which the local copy does not read
  ZCL_GOGEN_T_CP: "cp:XX-X--XX-XX-XX-XX ca:X---X",
  // not an A4H value: the language rule WHEN a OR b OR c, which the front
  // end read as WHEN a alone until 2026-09-23 (the alternatives after the
  // first sit in Or nodes), and which a wrong OData type came out of
  ZCL_GOGEN_T_WHEN: "abc abc abc d -",
  // call chains whose head is a call on me: m( )->n( ), me->m( )->n( ),
  // zif_x~m( )->n( ), cl_x=>m( )->n( ), as statements and as operands; the
  // head runs before the argument of the tail (log ...mfnxtx...), A4H
  ZCL_GOGEN_T_CHAINS: "a0 b+0 c0 d2 d2 <d2> <d2> f.x g+0 if log:mambmb+mcmdmemfnxtxmgmg+ng+0mh",
  // strings, measured on A4H 2026-09-23 (probe classes of the same code in
  // $ZOSG_TMP_0130). SPLIT INTO fields: the last takes the rest, missing
  // pieces clear, a c field cut is sy-subrc 4, an empty string clears all
  ZCL_GOGEN_T_STRSPLIT: "more:a/b,c,d/0 fewer:a///0 trail:a/b//0 empty:a//b none://0 lead:/a resttrail:a/b,c, trunc:ab/d/4 trunc2:ab/cd/4 space:a//b str:[a]/[b]/[] self:p/q two:a/b",
  // REPLACE: POSIX leftmost-longest, empty regex matches replaced, SECTION,
  // $0 literal without REGEX, c pattern and WITH lose trailing blanks, a c
  // target cut is sy-subrc 2. The pair: a JS RegExp is leftmost-first, so
  // a|aX in aXbX takes a where A4H and Go take aX (longest:-bX); the JS
  // backend refuses nothing here and is wrong there, as FindStmt already is
  ZCL_GOGEN_T_STRREPL: {
    Go: "first:aXYcabc/0 miss:aXYcabc/4 rxall:a--a--/0 rxempty:-a-b-c-/0 rxstar:-a--c- groups:baabbaab longest:-bX rxmiss:4 sect:abca-c/0 sectoff:abca-ca-c sectlen:a-cabc dollar:a$0c cwith:ab ctrail:[a X] cten:a -/0 ctrunc:aXYZ/2 icase:---",
    JS: "first:aXYcabc/0 miss:aXYcabc/4 rxall:a--a--/0 rxempty:-a-b-c-/0 rxstar:-a--c- groups:baabbaab longest:-XbX rxmiss:4 sect:abca-c/0 sectoff:abca-ca-c sectlen:a-cabc dollar:a$0c cwith:ab ctrail:[a X] cten:a -/0 ctrunc:aXYZ/2 icase:---",
  },
  // repeat( ) replace( ): A4H's run, except its last line had sub = ' ',
  // which is empty there and raised CX_SY_STRG_PAR_VAL (see STREDGE); the
  // copy asks sub = 'b' with = '_ ' (A4H: a c WITH loses its blank too)
  ZCL_GOGEN_T_STRFN: "rep:ababab/[]/[  ]/[] r1:a-cabc r0:a-ca-c r2:abca-cabc rm1:abcabca-c r5:abcabc rq:a''b'' rx:a--a-- rxe:-a-b-c- rxg:baba rc:[a _]",
  // condense( ) shift_left( ) shift_right( ): del strips first, then runs of
  // from become the first character of to
  ZCL_GOGEN_T_STRCOND: "c:[a b] cd:[a-b-] cdel:[ a b ] cfrom:[a  b] cto:[ab] cc:[a b] cto2:[axb] cdel2:[x] sl:cde/[ab ]/x/bca sr:abc/[ ab]/x/cab slc:[ab]/[ab]//abc",
  // MOVE-CORRESPONDING: by name, converted, the rest and sy-subrc untouched.
  // A4H set sy-subrc = 7 before it and answered .../7; the subset refuses an
  // assignment to sy-subrc, so the copy sets 4 with a FIND that fails
  ZCL_GOGEN_T_STRMOVE: "[lon]/[42 ]/[AB]/keep/12/4",
  // to_mixed( ), c targets of REPLACE (searched with their blanks), regex
  // replacement text, ^ and $ per line, empty matches, SPLIT with c
  // separators (their blanks count), and what raises. A4H caught cx_root
  // and printed the class; the copy catches that class by name
  ZCL_GOGEN_T_STREDGE: "n1 m:HelloWorld/_a_b_/AbCd/abCd/ab_cdEf/a12bC lc:helloWorld cblank:[xxb]/0 cfull:[xxxb]/0 crx:[a-]/0 cdel:[a]/0 crx2:[-]/0 cfield:[ab--------]/0"
    + " n2 esc:$1[a]b amp:a..b find:0 repl:-a#-b dollar:a-#b- bb:- empty:[-]/0 firstempty:-abc/0 rxicase:a-a"
    + " n4 csep:[]/[b] c2sep:[a]/[b]/[] csrc:[a]/[b]/[] ctab:2 etab:1 stab:2 cvar:[ab x cd]/[] splitempty:abc//0"
    + " replfirstempty:-abc/0 repneg:CX_SY_STRG_PAR_VAL replfnempty:CX_SY_STRG_PAR_VAL"
    + " shiftneg:CX_SY_RANGE_OUT_OF_BOUNDS shiftbig:CX_SY_RANGE_OUT_OF_BOUNDS r:CX_SY_RANGE_OUT_OF_BOUNDS src5:CX_SY_RANGE_OUT_OF_BOUNDS slc3:abc"
    + " slc4:CX_SY_RANGE_OUT_OF_BOUNDS sectbig:CX_SY_RANGE_OUT_OF_BOUNDS sectok:a-c/0 sectlong:CX_SY_RANGE_OUT_OF_BOUNDS",
  // REPLACE ALL OCCURRENCES OF an empty pattern (' ', a c blank, is empty)
  // raises CX_SY_REPLACE_INFINITE_LOOP, which CATCH cx_dynamic_check and
  // CATCH cx_root take on A4H (probe ZCL_GOGEN_T_STRCR in $ZOSG_TMP_0131);
  // open-abap-core has no such class, so the front end holds its superclass
  // (RUNTIME_CX_SUPER). A4H ran this copy with a third TRY that caught
  // cx_sy_replace_infinite_loop by name (x3:loop); abaplint refuses a CATCH
  // naming a class it does not know, so that TRY is not in the copy
  ZCL_GOGEN_T_STRLOOP: "x1:dyn x2:root a b",
  // lines and dot, and condense( ) with c arguments, A4H 2026-09-23 (probe
  // ZCL_GOGEN_T_STRCR, $ZOSG_TMP_0131): ^ after \n, $ before \n and at the
  // end, . matches \r and \n, \f and \v end no line; a c del / from / to
  // loses its trailing blanks (space, ' ', a c(1) field of a blank are empty)
  ZCL_GOGEN_T_STRLINES: "n1:-a|-|-b n2:a-|b- n3:a-|-|b- dot:---- ff:4/0 vt:4 c1:[ xa bx ] c2:[ab] c3:[a  b] c4:[ a b ] c5:[a b] c7:[ a b ]",
  // not an A4H value: A4H answers f1:0 here ($ matches before the \r of a
  // CRLF, and not between \r and \n; a\n\rb has ^ after its \r, a\rb does
  // not). Neither Go's (?m) nor JS's m says that, so an anchored pattern on
  // a text with \r, U+2028 or U+2029 is NOT_COMPILED in both backends
  ZCL_GOGEN_T_STRCRLF: {Go: "ERROR NOT_COMPILED in FIND REGEX: ^ or $ in a text with a line end other than \\n is not measured: a$ at zcl_gogen_t_strcrlf.clas.abap:11",
    JS: "ERROR NOT_COMPILED in FIND REGEX: ^ or $ in a text with a line end other than \\n is not measured: a$"},
  // DATA of an interface is one field of the object: written through an
  // interface reference and read through the class reference and back,
  // through a reference to an included interface (zif_ia2, measured with
  // local interfaces in a test include), in the class as zif~attr and
  // me->zif~attr, in a subclass too; READ-ONLY written inside the class
  // through me and through a reference of the class's type, and in the
  // subclass. The A4H probe also showed what does not activate, which the
  // front end refuses rather than compiles: VALUE on an interface DATA (so
  // init:0), a write to READ-ONLY through an interface reference (inside
  // the class too) or from outside the class, and lo_i->zif_ia~attr on a
  // reference to zif_ia itself
  ZCL_GOGEN_T_IA: "init:0 o:7 i:8 bump:9,90,90,9 pair:3p inner:in,in,two alias:shared other:0, first:9,shared sub:42,1049,43,7 ro:2",
  // a subclass implementing an interface (zif_iadb) that includes one its
  // superclass already implements (zif_iadc, through zif_iada): A4H
  // activates it and keeps one field, which set( ) of the superclass writes
  // and every reference reads ($ZOSG_TMP_0121, 2026-09-23). Go gave the
  // subclass a second field until then: get:0 ... get:7
  ZCL_GOGEN_T_IADUP: "get:5 a:6 c:6 s:6 b:7 get:5",
  // not an A4H value but a compile fixture: the row of a RANGE OF in an
  // interface method's signature, built by a caller and taken by another
  // class that implements it (Go named the row after each, and the class no
  // longer implemented the interface; osg-research's DSL L3 ports, #401)
  ZCL_GOGEN_T_RNG: "all:3 b:1",
  // class-based exceptions (A4H, the exception classes local to the probe,
  // the same code otherwise): a CATCH by hierarchy with the attributes read
  // INTO, the first CATCH that fits, CLEANUP inner then outer then the
  // handler, no CLEANUP for one raised inside a CATCH of the same TRY,
  // get_text( ) of a class without a text, RAISE EXCEPTION obj hands over
  // the object itself (a handler's change stays in it), previous, cx_no_check
  // through a method without RAISING, an INTO not taken stays initial,
  // cx_root taking a raised object and a runtime one, a runtime exception
  // passing a CLEANUP. Not in the local copy: RAISE EXCEPTION of an initial
  // reference, which aborts on A4H ("Access using a 'ZERO' object reference
  // is not possible", CATCH cx_root does not take it), and a CATCH after one
  // of its superclass, which does not activate
  ZCL_GOGEN_T_RAISE: "h:7 first:sub clean:i1-ci-co-h3 incatch:ch text:[An exception was raised.] same:18 prev:18 nocheck again:19 untaken:initial root:[An exception was raised.] root:zerodivide rt:ch",
  // an exception that no TRY takes: the kernel looks for a handler before it
  // unwinds, finds none and dumps at the RAISE (UNCAUGHT_EXCEPTION, line 16),
  // and no CLEANUP on the way runs; the CLEANUP of the first part does run,
  // a handler being there. A4H 2026-09-23, $ZOSG_TMP_0118: the same code in
  // an RFC module (no handler above it) with each CLEANUP writing a committed
  // row; the rows of the handled part came, none of the other, the dump named
  // the RAISE. What the Go harness names is the stack of the first panic
  ZCL_GOGEN_T_UNCAUGHT: {Go: "ERROR UNCAUGHT_EXCEPTION ZCX_GOGEN_T_RNOCHK at zcl_gogen_t_uncaught.clas.abap:16", JS: "ERROR UNCAUGHT_EXCEPTION ZCX_GOGEN_T_RNOCHK"},
  // runs after it in the same process and reads the static its CLEANUPs
  // would have written to
  ZCL_GOGEN_T_UNCAUGHT_READ: "log:s-c-h",
  // generic data: ASSIGN COMPONENT read and written back (a lower-case name
  // is found, an unknown one is sy-subrc 4 and leaves the field symbol as it
  // was), LOOP over ANY TABLE writing through the field symbol, DESCRIBE
  // FIELD kinds (a structure with a string in it is v, a flat one u), GET
  // REFERENCE + ->* written, ASSIGN of an initial reference sy-subrc 4 with
  // the field symbol kept, IS SUPPLIED, CALL METHOD (class)=>m, a binding
  // that outlives a move into its structure, c fitting, i into a string,
  // CLEAR through generic data, a typed field symbol seen as generic data
  // (CLEAR and a whole move write the row, and the typed field symbol sees
  // it), a generic value read into a shorter c cut, CLEAR of a typed field
  // symbol clearing its row. The A4H class had the same source.
  ZCL_GOGEN_T_JSGENERIC: "comp:0/1/5/0/low/4/low lines:2 p11 q22 kinds:IFgCXDTvhl ref:0/3/42/4/asg/ini/set notini/ini sup:a-b-A+b-a-B+A+B+ dyn:<d1><7><noclass> flat:u moved:m9 m9 q22 fit:xy/5-/cleared:0 row:0 row:s3/0/s3 c2:xy clr:2/0/0",
  // COMMIT WORK / ROLLBACK WORK set sy-subrc 0 (A4H: from 7, with rows
  // written in between, sy-dbcnt left as it was). The JS emitter has no
  // database and refuses both rather than make them no-ops
  ZCL_GOGEN_T_LUW: {Go: "miss:4 rb:0 cw:0 cww:0", JS: "ERROR NOT_COMPILED in COMMIT / ROLLBACK WORK: the JS emitter has no database"},
  // database writes through the write nodes of the relational IR
  // (tools/ir-writes.mjs, go/abap/dbwrite.go). A4H answered, as
  // "sy-subrc/sy-dbcnt" after each statement (i -> string, hence the blank
  // after each number):
  //   ins:0 /1  dup:4 /0  tabcx:0 /0  rows3  acc:4 /2  rows5  updmiss:4 /0
  //   upd:0 /1  set2:0 /2  set0:4 /0  updtab:4 /1  modins:0 /1  modupd:0 /1
  //   modtab:0 /2  delmiss:4 /0  del:0 /1  delw0:4 /0  delw2:0 /2
  //   deltab:4 /1  insm:0 /1  mandt001 insempty:0 /0  rows4  rb:0 /4  after0
  // A second run with sy-subrc = sy-dbcnt = 7 before INSERT FROM TABLE of
  // A(dup) B C A(dup) D gave "tabcx:7 /7": CX_SY_OPEN_SQL_DB, sy untouched,
  // B, C and D written all the same. Go answers every statement the same;
  // the string differs in two places, neither a database rule:
  //   - mandt123: the logon client, which is 001 on A4H and 123 here (the
  //     transpiler runtime's constant, abap.Mandt); the work area said 999;
  //   - tabcx:4: the INSERT leaves sy as it was (the rule above), and what
  //     it was differs: on A4H the call note( ) before it set sy-subrc to 0
  //     (ZCL_GOGEN_T_CNT, $ZOSG_TMP_0220, 2026-09-23: "call:0" after a READ
  //     that missed), and a method call in the subset leaves sy-subrc alone
  //     (ZCL_GOGEN_T_CALLSUBRC below pins that gap on its own).
  // The JS backend has no database and refuses (ANORMALIES dbwrite-* are
  // the transpiler runtime's answers, not these)
  ZCL_GOGEN_T_DBW: {
    Go: "ins:0 /1  dup:4 /0  tabcx:4 /0  rows3  acc:4 /2  rows5  updmiss:4 /0  upd:0 /1  set2:0 /2  set0:4 /0  updtab:4 /1  modins:0 /1  modupd:0 /1  modtab:0 /2  delmiss:4 /0  del:0 /1  delw0:4 /0  delw2:0 /2  deltab:4 /1  insm:0 /1  mandt123 insempty:0 /0  rows4  rb:0 /4  after0 ",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // sy after SELECT (A4H, ZCL_GOGEN_T_CNT, the same statements over a
  // system table of two rows: "app:4 ... cnt0:4/0/0 cnt:0/2/2 tab:0/2/2
  // tab0:4/0/0 single:0/1 single0:4/0"); here three rows, and two ranges:
  // I CP 'A*' without E EQ 'AB', and a LOW longer than the column, which is
  // CX_SY_OPEN_SQL_DATA_ERROR under CX_SY_OPEN_SQL_ERROR
  ZCL_GOGEN_T_SELCNT: {Go: "app:4 cnt0:4/0/0 cnt:0/3/3 tab:0/3/3 tab0:4/0/0 single:0/1 single0:4/0 rng:1,A long:caught",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // a string or a c longer than the column, compared in WHERE and written
  // by SET: when it fits after its trailing blanks it is the c value (not
  // an A4H value, the Go port's rule); when it does not, NOT_COMPILED at
  // the statement rather than a value cut to the column, which would have
  // deleted the row 'ABCDEFGHIJ' here (review of ultra/dbport)
  ZCL_GOGEN_T_HOSTFIT: {Go: "str:1 c20:1 set:0/1 ten:1 del:0/1",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  ZCL_GOGEN_T_HOSTLONG: {Go: "ERROR NOT_COMPILED in Open SQL host value: \"ABCDEFGHIJK\" is longer than the column's 10 characters (CX_SY_OPEN_SQL_DATA_ERROR for a range on A4H; a plain comparison or SET is not measured) at zcl_gogen_t_hostlong.clas.abap:19",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // sy-subrc after a method call without EXCEPTIONS: A4H "call:0"
  // (ZCL_GOGEN_T_CNT, $ZOSG_TMP_0220), the subset leaves it as the READ
  // before set it, in both emitters. Pinned to the wrong value on purpose,
  // a known gap of call emission (README, "What this does not show"); it
  // is also why ZCL_GOGEN_T_DBW answers tabcx:4 where A4H answered tabcx:0
  ZCL_GOGEN_T_CALLSUBRC: {Go: "read:4 call:4", JS: "read:4 call:4"},
  // an OPTION in lower case: a dump CATCH cx_root does not take (A4H,
  // a4h-ranges.json), never "no restriction"
  ZCL_GOGEN_T_SELDUMP: {Go: "ERROR SAPSQL_IN_ITAB_ILLEGAL_OPTION in range OPTION \"cp\": SAPSQL_IN_ITAB_ILLEGAL_OPTION, an uncatchable dump on A4H at zcl_gogen_t_seldump.clas.abap:24",
    JS: "ERROR NOT_COMPILED in SELECT ... FROM ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // d and t (A4H 2026-09-23, two probes joined into one class): c -> d keeps
  // 'ABC'; d - d counts days in calculation type i (( d / 7 ) * 7 rounds in
  // between); an i template expression overflows at 20713 * 86400 * 1000,
  // which OSG's ZCL_STG_JSON=>EPOCH_MS computes (ANORMALIES); a t read by
  // offset; d -> i is days since 00010101, Julian before 15821015, 0 for a
  // date that is not one
  ZCL_GOGEN_T_RQDATE: "a[ABC];b20713,-719164;c739879;dOVF;k12,34;00000000=0;00010101=0;00010102=1;15821004=577736;15821015=577737;19700101=719164;20000229=730180;20260917=739877;99991231=3652060;20260230=0;ABC=0;1900022=0;",
  // SPLIT ... INTO fields (A4H 2026-09-23): the last field takes the rest,
  // a field without a piece is cleared, a piece cut to fit a c sets sy-subrc 4
  ZCL_GOGEN_T_RQSPLIT: "e[Seats][desc]0;f[a][ b]0;g[a][]0;h[a][b c]0;i[abc][gh]4;j[x][yyy]4",
  // not an A4H value (the probe could not be created on A4H in this
  // session): the language rule that a d, t or n field is initial at its
  // typed zero, and a structure when every component is. Go gave
  // a---X- c---X dX- e-- before (a structure field starts as ""), JS
  // aXXX-X cXXX- dX- e-- (a structure compared with a fresh one by ===)
  ZCL_GOGEN_T_RQINIT: "aXXXXX b-- cXXXX dXX eX- fX",
  // x / xstring into a string or a c, and i into x(1), A4H 2026-09-23
  // ($ZOSG_TMP_0022; the copy leaves out the probe's TRY around hex1( -1 ),
  // which raised nothing there, and sets x'0A0B' as 2571 and x'DEADBEEF' as a
  // constant: c -> x is not in the subset): the demo's outro stopped on INT_TO_HEX
  // FIND IN SECTION [OFFSET] [LENGTH] OF a string and FIND [REGEX] IN TABLE
  // of strings (A4H 2026-09-24, $ZOSG_TMP_0041, the same code with CATCH
  // cx_root printing the class): MATCH OFFSET counts from the start of the
  // string; an offset at the end is an empty section; offset < 0, offset past
  // the end, a section past the end and LENGTH < -1 raise; LENGTH -1 is the
  // rest; an empty substring is found at the start (x1, x2: plain FIND too);
  // IN TABLE goes row by row, first row with a match, MATCH LINE from 1
  ZCL_GOGEN_T_FINDSEC: "a:0/5/1 b:0/2/1 c:4/99/98 d:4/99/98 e:\\CLASS=CX_SY_RANGE_OUT_OF_BOUNDS f:\\CLASS=CX_SY_RANGE_OUT_OF_BOUNDS g:4/99/98 h:0/5/1 i:4/99/98 j:0/2/1 k:\\CLASS=CX_SY_RANGE_OUT_OF_BOUNDS l:0/2/1 m:4/99/98 n:4/99/98 p:0/1/0 p2:4/99/98 p3:0/6/1 q:0/SUM/2/2 r:0/max/3/1 s:4/keep/99 s2:0/a/ u:4/keep/99 v:4/99 w:0/2/1 w2:0/2/1"
    + " x1:0/0/0 x2:0/0/0 l3:\\CLASS=CX_SY_RANGE_OUT_OF_BOUNDS l4:0/5/1 l5:0/7/0 l6:0/7/0",
  // a c literal of digits into p DECIMALS 0 (CONSTANTS ... TYPE timestamp
  // VALUE '...', leading zeros dropped) and p compared with p and with i
  // (A4H 2026-09-24, $ZOSG_TMP_0041, the same code): the SADL MPCs' dates
  ZCL_GOGEN_T_PCMP: "c:20260912010000 z:12 v:20260912010001 gt lt eq ne zi ilt neg init",
  // CREATE DATA ... TYPE <static type> / TYPE STANDARD TABLE OF <ddic
  // table>: a new initial value each time, a reference kept apart from the
  // next CREATE (A4H 2026-09-24, $ZOSG_TMP_0041, the same code)
  ZCL_GOGEN_T_CRDATA: "t000:0 tt:1 fresh:0 kept:1 n0:0 n1:42 n2:0",
  // DELETE / READ TABLE ... INDEX on a generic STANDARD TABLE (A4H
  // 2026-09-24, $ZOSG_TMP_0041, the same code): as for a typed table, and a
  // move into the generic table copies (orig keeps its four rows)
  ZCL_GOGEN_T_GENIDX: "d1:0/3 d9:4/3 r2:0/2/3 r7:4 kept:30 2 30 orig:4",
  // SELECT from a DDIC view with MANDT: read as a client-dependent table (not
  // an A4H value: the Open SQL rule, pinned so the view path stays compiled);
  // a view over a client-dependent table without MANDT is refused
  ZCL_GOGEN_T_SELVIEW: {Go: "0/1 B:2", JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // dynamic Open SQL (go/abap selectdyn.go): a static table and one named
  // at run time, a CDS name through its SQL view, GROUP BY with SUM, an
  // empty condition, no row. The rows are ordinary Open SQL, not measured;
  // '1 = 1' raising CX_SY_DYNAMIC_OSQL_SEMANTICS and an operator without
  // blanks CX_SY_DYNAMIC_OSQL_SYNTAX are A4H's (docs/osql-where.md, #47)
  // Node accepts the literal-left tautology used by search help; A4H raises
  // CX_SY_DYNAMIC_OSQL_SEMANTICS for it (recorded in the ABAP corpus).
  ZCL_GOGEN_T_DSEL: {Go: "static:0/2/CB byname:0/2/AC cds:0/2,B2,C3 empty:0/3 none:4/0/0 sum:0/2,C3,A1 one:semantics syntax:caught",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // a view hiding the client, read by name: refused at run time as the
  // static read is refused at build time
  ZCL_GOGEN_T_DSELX: {
    Go: "ERROR NOT_COMPILED in SELECT ... FROM (ZGOGEN_T_DBWN): ZGOGEN_T_DBWN is a view over the client-dependent ZGOGEN_T_DBW without MANDT: a system reads the logon client's rows, this one would read every client's at zcl_gogen_t_dselx.clas.abap:18",
    JS: "ERROR NOT_COMPILED in CREATE DATA TYPE (name): the JS backend has no table registry (the Go host has)"},
  // UNASSIGN of a generic and a typed field symbol (the language rule, not
  // measured): not assigned after, the variable and the row untouched; SE16's
  // ROWS_OF needs it
  ZCL_GOGEN_T_UNASSIGN: "XX/  /7/1",
  // a string into an n through generic data: digits that fit, zero-padded
  // (the NUMC rule A4H showed for a WHERE literal, docs/osql-where.md); a
  // letter is not measured and refused. The SADL DPC's synthetic keys do the
  // first (the aggregated flight cube's FACTID)
  ZCL_GOGEN_T_MOVEN: "004711/012345",
  ZCL_GOGEN_T_MOVENX: {Go: "ERROR NOT_COMPILED in move: a value of type kind g into generic data of type kind N at zcl_gogen_t_movenx.clas.abap:22",
    JS: "ERROR NOT_COMPILED in move: a value of type kind g into generic data of type kind N"},
  ZCL_GOGEN_T_SELVIEWN: {
    Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_SELVIEWN=>RUN (zcl_gogen_t_selviewn.clas.abap:11): SELECT FROM ZGOGEN_T_DBWN: a view over the client-dependent ZGOGEN_T_DBW without MANDT at zcl_gogen_t_selviewn.clas.abap:11",
    JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_SELVIEWN=>RUN (zcl_gogen_t_selviewn.clas.abap:11): SELECT FROM ZGOGEN_T_DBWN: a view over the client-dependent ZGOGEN_T_DBW without MANDT"},
  ZCL_GOGEN_T_X2S: "a:AB b:00 c:2C d:FF e:[0A0B] f:[DEADBEEF] g:[] h:[0A0] i:FF",
  // SMW0 through the host: WWWDATA_IMPORT and SCMS_BINARY_TO_XSTRING, A4H
  // 2026-09-23 ($ZOSG_TMP_0230) answered this string over an object of its
  // own; the copy reads testdata/media (the Go host's media directory). The
  // JS emitter has no host function modules and refuses the call
  ZCL_GOGEN_T_W3MI: {Go: "miss:2/1 rel:1/0 hit:0 rowsdiff:0 pad:00/255 exact:0/X five:5/X zero:0 over:0/0 neg:0/0 empty:0/0",
    JS: "ERROR NOT_COMPILED in CALL FUNCTION 'WWWDATA_IMPORT': the JS emitter has no host function modules"},
  // p DECIMALS 0: calculation type p (OSG's EPOCH_MS, A4H 2026-09-23 in
  // ANORMALIES epoch-ms-overflow: the i operands do not overflow when the
  // target is p); a move that does not fit is a conversion overflow (ABAP
  // documentation)
  ZCL_GOGEN_T_PACKED: "ms:1728003600000 neg:-16400 small:conv max:999 lit:20260912000000",
  // SELECT ... ENDSELECT (A4H 2026-09-24, this class over ZGOGEN_T_DBW in
  // $ZOSG_TMP_0195): sy-dbcnt counts the passes, sy-subrc 0 at each pass and
  // after the loop (EXIT too) when a row was read, 4/0 and the work area
  // kept when none was. The transpiler reads the rows and loops without
  // touching sy (ANORMALIES select-loop-sy)
  // sorted secondary keys (ultra/json, /UI2/CL_JSON's parser): A4H
  // 2026-09-24, ZCL_GOGEN_T_SECKEY in $ZOSG_TMP_0420. Equal keys come
  // newest first, a key changed through a field symbol keeps the row's
  // place, sy-tabix is the key's position; a READ that misses leaves the
  // target alone, sy-tabix where the value would go, sy-subrc 4 inside and
  // 8 past the end (ANORMALIES secondary-key-duplicates: the transpiler
  // runtime answers otherwise)
  ZCL_GOGEN_T_SECKEY: "w:5/3,3/4,1/5, after:2 app:0/3,5/4,3/5,1/6, mod:4/1,3/2,2/3, all:0/1,5/2,4/3,3/4,2/5,1/6, ru:0/3/4 rp:0/0/4 rmiss:8/0/7 rlow:4/0/1 rfs:0/4/3",
  // WHERE over int8 (abapiti inbox 043): the comparison is in int8 when
  // either side is i or int8 and one is int8, also for values past the
  // range of i. Unmeasured: ABAP documentation of comparison types
  ZCL_GOGEN_T_WHEREI8: "d:0/2 l:7 n:7 g:0/1",
  // a unique hashed secondary key (abapiti inbox 042, its maps): READ ...
  // WITH KEY k COMPONENTS finds by value, a miss is sy-subrc 4 with the
  // target left alone; DELETE TABLE ... WITH TABLE KEY k COMPONENTS removes
  // the row, 4 when there is none. Unmeasured past abapiti's own A4H run of
  // the first READ and DELETE (a10): ABAP documentation
  ZCL_GOGEN_T_SECKEYH: "r:0 i:0/3 miss:4/99 t:0 d:0 i:1/0 d2:4 a10c3",
  // the generic statements of /UI2/CL_JSON's deserializer (ultra/json), A4H
  // 2026-09-24 (the same code in ZCL_GOGEN_T_SECKEY's probe include): INSERT
  // INTO TABLE of a generic standard table appends and leaves sy-tabix alone,
  // CREATE DATA LIKE LINE OF <any table> is a new initial row, CREATE DATA
  // of a typed reference a new empty table; a variable may be called value;
  // two references are equal when they point at one object
  ZCL_GOGEN_T_JSONGEN: "ins:0/1/2 new:0 value:3 lt:2 row2:7/x cd:0 ins:0/2/1 new:0 after:1 eq ne",
  // = and <> between object references of different static types
  // (ultra/json fix round): two initial references are equal whatever their
  // static types. A4H 2026-09-24 ($ZOSG_TMP_0422, the same statements over
  // CL_ABAP_STRUCTDESCR/CL_ABAP_TYPEDESCR and CX_SY_ZERODIVIDE/IF_MESSAGE)
  // answered this line exactly; the transpiler too
  ZCL_GOGEN_T_REFEQ: "sb:eq bs:eq ci:eq ic:eq b1:ne b2:ne same:eq isame:eq icl:ne clr:eq",
  // APPEND repeating a unique secondary key: A4H raises the catchable
  // CX_SY_ITAB_DUPLICATE_KEY ("caught"), the transpiler appends; both
  // backends refuse (ultra/json fix round)
  ZCL_GOGEN_T_SECKEYDUP: {Go: "ERROR NOT_COMPILED in APPEND: a row repeating the value of the unique secondary key K_U: A4H raises the catchable CX_SY_ITAB_DUPLICATE_KEY (2026-09-24), which this runtime does not at zcl_gogen_t_seckeydup.clas.abap:27",
    JS: "ERROR NOT_COMPILED in APPEND: a row repeating the value of the unique secondary key K_U: A4H raises the catchable CX_SY_ITAB_DUPLICATE_KEY (2026-09-24), which this runtime does not"},
  // LOOP ... USING KEY over zcl_x=>gt with APPEND ... TO gt in the body
  // (ultra/json fix round): A4H visits the appended row (app:1/1,3/2,2/3,
  // lines:3, see the class); the key order taken once would not, so both
  // backends refuse the loop
  ZCL_GOGEN_T_SECKEYQ: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_SECKEYQ=>RUN (zcl_gogen_t_seckeyq.clas.abap:29): LOOP ... USING KEY whose body changes the table: APPEND ls2 TO gt. at zcl_gogen_t_seckeyq.clas.abap:29",
    JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_SECKEYQ=>RUN (zcl_gogen_t_seckeyq.clas.abap:29): LOOP ... USING KEY whose body changes the table: APPEND ls2 TO gt."},
  // LOOP AT ref->* ASSIGNING <typed>: A4H the same day; the JS emitter binds
  // no typed field symbol over generic rows (as ASSIGN ref->* TO <typed>)
  ZCL_GOGEN_T_DREFLOOP: {Go: "1:1/a,2:2/b,10,20,",
    JS: "ERROR NOT_COMPILED in LOOP AT lr->* ASSIGNING <ls>.: a typed field symbol over generic rows is Go-only"},
  // cl_abap_typedescr=>describe_by_data (ultra/json, a host function in Go,
  // emit-go nativeRttiData): A4H 2026-09-24 ran this class under the name
  // ZCL_GOGEN_T_SECKEY (the name in the absolute names replaced). What the
  // Go host leaves out is not printed: the technical names of unnamed c, n,
  // x, p (\TYPE=%_T...), a structure's length. The JS emitter has no RTTI
  ZCL_GOGEN_T_RTTI: {Go: "c3:E/C/0/6/3 n4:E/N/0/8/4 x2:E/X/0/2/4 d:E/D/0/16/\\TYPE=D/D//8 t:E/T/0/12/\\TYPE=T/T//6 f:E/F/0/8/\\TYPE=F/F//24 i:E/I/0/4/\\TYPE=I/I//11 i8:E/8/0/8/\\TYPE=INT8/INT8//20 p:E/P/2/8/17 b:E/C/0/2/\\TYPE-POOL=ABAP\\TYPE=ABAP_BOOL/ABAP_BOOL//1 s:E/g/0/8/\\TYPE=STRING/STRING//0 xs:E/y/0/8/\\TYPE=XSTRING/XSTRING//0 flat:S/u/0/\\CLASS=ZCL_GOGEN_T_RTTI\\TYPE=TY_FLAT/TY_FLAT/ deep:S/v/0/\\CLASS=ZCL_GOGEN_T_RTTI\\TYPE=TY_DEEP/TY_DEEP/ comps:S=E,XS=E,FL=S,TB=T, line:\\CLASS=ZCL_GOGEN_T_RTTI\\TYPE=TY_FLAT tk:S uk: same",
    JS: "ERROR NOT_COMPILED in Native_DESCRIBE_BY_DATA: a host function of the Go runtime"},
  // a dictionary-typed c: its output length is its domain's (ultra/json
  // refused it; parity-wave1 carries it, the rule of ZCL_GOGEN_T_RTTIOL;
  // A4H's DD04L has SDOK_CLASS CHAR 10 with output length 10, as
  // open-abap-core's sdok_class.doma.xml)
  ZCL_GOGEN_T_RTTIDDIC: {Go: "C/20/10", JS: "ERROR NOT_COMPILED in Native_DESCRIBE_BY_DATA: a host function of the Go runtime"},
  // open-abap-core's /UI2/CL_JSON=>DESERIALIZE end to end (ultra/json): not
  // an A4H value, a system has its own /UI2/CL_JSON. What the pieces give
  // that were measured there (the parser's members through a non-unique
  // sorted key come newest first, so an array fills its table in reverse;
  // ZCL_GOGEN_T_SECKEY), where the Node host answers
  // "osg/42/X//3:1X,2,3, bad:caught" (ANORMALIES secondary-key-duplicates).
  // A missing member is cleared, an unknown one ignored. The JS emitter
  // has neither JSON.parse nor RTTI as host functions
  ZCL_GOGEN_T_JSONDES: {Go: "osg/42/X//3:3,2,1X, bad:caught",
    JS: "ERROR NOT_COMPILED in Native_CONV_OUT_CONVERT: a host function of the Go runtime"},
  ZCL_GOGEN_T_SELLOOP: {Go: "n:2 in:1/0,2/0, after:0/2 exit:0/1/A exitmiss:0/1 none:4/0/QQQ cont:0/2/2 corr:5/A elem:A/2 exit2:0/2",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_DBW: the JS backend has no database (the Go host has SQLite)"},
  // not an A4H value (A4H has no destination AMDP and says HDB / 758): parity
  // with OSG on Node without HANA, CX_SY_DYN_CALL_ILLEGAL_FUNC raised before
  // any parameter is passed; sy-dbsys the database client's name, sy-saprl
  // the transpiler runtime's constant (ultra/gaps, the AMDP sandbox page)
  ZCL_GOGEN_T_AMDPDEST: "illegal_func out:[] db:[sqlite] rel:[OPEN]",
  // CALL FUNCTION 'ZOSD_STORE' DESTINATION 'STORE' over a copy of
  // testdata-store/tree (go/objstore). Not an A4H value: the Node
  // host's destination answers LIST, READ and WRITE the same over the same
  // fixture (tools/gogen/storecmp.mjs --root, every call of this class
  // among its calls); CHECK, ACTIVATE and TOKENS are the Go host's own
  // honest refusal, an error and an issue that stands
  ZCL_GOGEN_T_STORE: {Go: "LIST n6 a CLAS:CL_ST_LIB:$LIB:lib/src/cl_st_lib.clas.abap::inactive CLAS:ZCL_ST_A:$STG:src/zcl_st_a.clas.abap:X:inactive CLAS:ZCL_ST_GEN:$STG_GEN:gen/zcl_st_gen.clas.abap::inactive DEVC:$TMP:$TMP:local/tmp/package.devc.xml:X:active INTF:ZIF_ST_B:$STG_SUB:src/sub/zif_st_b.intf.abap:X:inactive PROG:ZST_PROG:$STG:src/zst_prog.prog.abap:X:inactive #CLAS=3 #DEVC=1 #INTF=1 #PROG=1 t0;list n3 a CLAS:CL_ST_LIB:$LIB:lib/src/cl_st_lib.clas.abap::inactive CLAS:ZCL_ST_A:$STG:src/zcl_st_a.clas.abap:X:inactive CLAS:ZCL_ST_GEN:$STG_GEN:gen/zcl_st_gen.clas.abap::inactive #CLAS=3 #INTF=1 #PROG=1 t0;READ src[118] src/zcl_st_a.clas.abap $STG inactive wX n0 a CLAS:ZCL_ST_A:$STG:src/zcl_st_a.clas.abap:X:inactive t0;READ src[28] src/zcl_st_a.clas.locals_imp.abap $STG inactive wX n0 a CLAS:ZCL_ST_A:$STG:src/zcl_st_a.clas.locals_imp.abap:X:inactive t0;READ src/zcl_st_a.clas.testclasses.abap $STG inactive wX n0 a CLAS:ZCL_ST_A:$STG:src/zcl_st_a.clas.testclasses.abap:X:inactive t0;READ err[CLAS ZCL_ST_SKIP does not exist] n0 a t0;WRITE src/zst_prog.prog.abap $STG inactive wX n0 a t0;READ src[27] src/zst_prog.prog.abap $STG inactive wX n0 a PROG:ZST_PROG:$STG:src/zst_prog.prog.abap:X:inactive t0;WRITE err[CLAS CL_ST_LIB comes from a library and cannot be changed here] n0 a t0;WRITE err[CLAS ZCL_ST_GEN comes from a library and cannot be changed here] n0 a t0;WRITE src/osd/zst_new.prog.abap $STG_OSD inactive wX n0 a t0;CHECK err[check needs the compiler (abaplint over the whole system), and this binary carries none: nothing was checked. Check on the Node host, or build the binary again from this tree] n1 a !PROG:ZST_PROG:0:no_compiler t0;ACTIVATE err[activation needs a new generation (rebuild): this binary is a built generation and carries no abaplint and no transpiler, so PROG ZST_PROG stays as it is in src/zst_prog.prog.abap and is active once the binary is built again from this tree] n1 a !PROG:ZST_PROG:0:rebuild t0;TOKENS err[tokens need the parser (abaplint), and this binary carries none] n0 a t0;NOPE err[unknown store command NOPE] n0 a t0;",
    JS: "ERROR NOT_COMPILED in CALL FUNCTION 'ZOSD_STORE': the JS emitter has no host function modules"},
  // MODIFY itab FROM wa INDEX n = MODIFY itab INDEX n FROM wa (A4H
  // 2026-09-24, $ZOSG_TMP_0195): sy-subrc 0 / 4, sy-tabix untouched (both
  // emitters set it to n before)
  ZCL_GOGEN_T_MODFROM: "a:0/2 b:0/2 c:4 A1 B20 X30",
  // packed numbers with decimals (A4H 2026-09-24, $ZOSG_TMP_0270, each
  // class the same source; go/abap packed.go has the rules). Conversions:
  // c/string -> p (a sign behind or in front, '- 1', '.5', blanks only 0;
  // exponent, comma, inner blank NN; commercial rounding; a move that does
  // not fit CO), f -> p through its seventeen significant digits (2.345 ->
  // 2.35 but 2.675 -> 2.67), i/int8 -> p, p -> p rounded, p -> i/int8
  // rounded, p -> f, p -> c right aligned with a sign place and '*' when
  // short, p -> string with a sign place, p -> n rounded and unsigned
  ZCL_GOGEN_T_PDCONV: "c:1.24,-1.24,1.23,12.50,-12.50,3.00,0.00,0.50,5.00,0.00,NN,NN,NN,999.99,CO,CO,NN,-1.00,0.00,-0.01 s:1.24,-7.50,0.00,NN,2.50,NN f:2.35,2.36,-2.35,0.13,-0.13,1.00,CO,CO,0.00,0.00,CO,2.67 i:7.00,-7.00,CO,5000000000.00 pp:1.26,-1.26,1.25,3,-3,2,CO,999.99 pi:3,-3,2,CO,-3 pf:0.10000000000000001,-2.6749999999999998 pc:[   1.50][   1.50-][   0.00][*67] ps:[1.50 ][1.50-][42 ][42-] pn:0013",
  // calculation type p: the target counts (7 / 2 into p is 4, -7 / 2 is
  // -4), a c or string operand makes it p ('7' / 2 * 2 into i is 7), p
  // ahead of int8; / keeps 31 significant digits, + - * are exact; DIV/MOD
  // as for i; an arithmetic result that does not fit is AO, 63 integer
  // digits in between are allowed; a string compared with an i is an i
  // ('-0.4' < 0 is false)
  ZCL_GOGEN_T_PDCALC: "mul:1.56,1.82,-1.95 div:0.33,0.67,-0.67,4,-4,3,2,1.00,3.50 prec:0.33333333333333,0.66666666666667,1.00000000000000,33333333333333333333333333333,66666666666666666666666666667,142857142857142857143,23333333333333333333333333 dm:3.00,1.50,-3.00,1.50,-4.00,0.50,4.00,0.50,0.30,-3,1,648398213,999999901 z:ZD,0.00,ZD,ZD ov:AO,9999999999999999999999999999999,AO,AO,AO,AO ch:7,20000,0,-2,3.75,4,8,ge,eq f:0.30,2.67 i8:15000000000,1666666666.67 neg:-1.25 sum:1.00",
  // templates (the field's decimals, DECIMALS = rounds, NUMBER = RAW is
  // plain), comparisons of p with p, i, c, string and f, abs( ) frac( )
  // keep the type, ceil( ) floor( ) trunc( ) have no decimals, p through
  // generic data (DESCRIBE FIELD P, move into a string, template, IS
  // INITIAL, a c and a p written through a field symbol)
  ZCL_GOGEN_T_PDFMT: "t:0.00,0,0.00000000000000,1.50,-1.50,0.005,-0.05,-42,0.33333333333333 d:1.3,1.250,1,-1.3,3,42.00 n:1.50,[    1.50],-1.50 c:abcdefghij fn:1.50,-1,-2,-1,-0.50,-1,1.5,-0.5 g:P/-1.50/[1.50-],P/0.00/[0.00 ]/ini,P/42/[42 ],3.14,3.140",
  // p -> c too short, and the precision of intermediate results: 31
  // significant digits after a division (0.667 at 28 integer digits), exact
  // products (1e-14 cubed), 63 integer digits and not 64. A4H ran this
  // class with a last line of p arithmetic in a template, now
  // ZCL_GOGEN_T_PDTPL / _PDTPLM
  ZCL_GOGEN_T_PDPREC: "c:[1.50][1.50][1.50-][*50-][*0-][12345.67][12345.67][*7-][*345.67-] d:0.66700000000000,0.66700000000000,0.66666666666667,0.66666666666667,0.00000000000001,0.00000000000001,1234567890.12345678901000,0.33333333333333 g:9999999999999999999999999999999,9999999999999999999999999999999,AO",
  // a comparison with arithmetic takes the calculation type of both sides
  // (a string inside arithmetic: p, so i * 86400 * 1000 does not
  // overflow); a string alone against an i is an i; p -> n; ceil( ) and
  // floor( ) into p(8,1). A4H refuses `arithmetic > string` itself ("An
  // arithmetic expression cannot be compared with the non-numeric
  // operand"), and so does the front end
  ZCL_GOGEN_T_PDCMP: "a:gt b:ne c:eq d:gt e:eq n:0013,2346 f:-1.0,-2.0",
  // p arithmetic in a template: + - print the most decimals of their
  // operands. A4H answered "t:2.25,0.75,-1.25,2.500" for both classes in
  // one: 1.25 * 2 prints 2.500 and 1.25 * 1.25 printed 1.56250, a rule
  // not pinned down by two points, so * and / in a template are refused
  ZCL_GOGEN_T_PDTPL: "t:2.25,0.75,-1.25",
  ZCL_GOGEN_T_PDTPLM: {Go: "ERROR NOT_COMPILED in ZCL_GOGEN_T_PDTPLM=>RUN (zcl_gogen_t_pdtplm.clas.abap:10): an arithmetic expression of type p with * or / in a string template: its decimals are not measured at zcl_gogen_t_pdtplm.clas.abap:10",
    JS: "ERROR NOT_COMPILED in ZCL_GOGEN_T_PDTPLM=>RUN (zcl_gogen_t_pdtplm.clas.abap:10): an arithmetic expression of type p with * or / in a string template: its decimals are not measured"},
  // CREATE DATA ... TYPE [STANDARD TABLE OF] (name) through the table
  // registry (A4H 2026-09-24, $ZOSG_TMP_0270, the same code): a new initial
  // table / row, APPEND of a generic row to it, the name in any case, an
  // unknown name CX_SY_CREATE_DATA_ERROR with the reference kept. The JS
  // emitter has no registry and refuses
  ZCL_GOGEN_T_CRDYN: {Go: "a:0/h b:u/0[] c:2 lower:ok unknown:err kept:0",
    JS: "ERROR NOT_COMPILED in CREATE DATA TYPE (name): the JS backend has no table registry (the Go host has)"},
  // class events (A4H 2026-09-24, $ZOSG_TMP_0440, ultra/events; the rules
  // in go/abap/events.go): handlers in registration order, per sender a
  // table with holes (a new one takes the lowest free place), a duplicate
  // is one, FOR the sender before FOR ALL INSTANCES, a dispatch calls what
  // was active at its start and still is, the actual read anew per handler
  // (val), an exception out of a handler ends the dispatch, static events
  // and handlers, an interface's event through an interface reference
  ZCL_GOGEN_T_EVENTS: "none:[] order:a.p(2,s)b.q(2)c.p(2,s) other:[] twice:a.p(4,s) off:b.p(5,s) again:a.p(6,s)b.p(6,s) var:a.p(7,s) kill:a.kill kill2:a.kill add:a.add add2:a.addc.p(11,s) boom:a.boom.caught val:a.m(5,105)b.m(105,205) all:a.q(13)c.p(13,x)b.p(14,y)a.q(14)c.p(14,y) both:b.p(15,y)c.p(15,y)a.q(15)c.p(15,y) offone:b.p(16,y)a.q(16)c.p(16,y) offall:b.p(18,y) stat:static(19,s) sev:a.s(20)b.s(20) sev2:b.s(21) intf:a.i(hi,s)",
  ZCL_GOGEN_T_EVENTS2: "revive:a.revive allfirst:b.p(2,s)c.p(2,s) nest:a.n1(a.n2()b.p(2,s))b.p(1,s) self:a.self3b.p(3,s)b.p(4,s) rev:c.p(5,s)a.p(5,s)b.q(5)b.p(5,s) back:a.p(6,s)b.p(6,s)c.p(6,s) holes:b.q(7)b.p(7,s)a.q(7) holes2:b.q(8)b.p(8,s)a.q(8)",
  // the WEBGUI's sapevent path (A4H 2026-09-24, $ZOSG_TMP_0440, ultra/events):
  // line_exists( ), NS / CN, reference comparison (two objects of a class
  // without fields are two), a SORTED unique table (INSERT INTO TABLE leaves
  // sy-tabix alone, rows in binary key order, a duplicate is sy-subrc 4),
  // CONCATENATE (c operands lose trailing blanks, the
  // separator keeps them, a c target is cut with sy-subrc 4, LINES OF an
  // empty table clears), FIND ALL ... MATCH COUNT (0 and sy-subrc 4 when
  // none; a CL_ABAP_REGEX object), escape( ) e_html_attr. APPEND ...
  // ASSIGNING with a field symbol of a string is in WGUI3 (fix round,
  // re-measured on A4H 2026-09-24, $ZOSG_TMP_0441), so the JS emitter
  // compiles WGUI1 and must give the same string
  ZCL_GOGEN_T_WGUI1: "le:XXXX ns:XX ref:XXXX so:0/2,0/2,0/2,4/2,0/2 B5 c2 m1 x3 rd:0/4 cc:[abcd e][ab cd][ab- cd][ab cd][abc]4[ab]0[ab cdx] cl:[p!/r!][ab][a  b  ][a b][]0 fa:3/0,1/0,0/4,2,2,2 esc:a&lt;b&gt;&quot;c&#39;&amp;d e",
  ZCL_GOGEN_T_WGUI3: "ap:2 fs:[p!/r!]",
  // READ TABLE WITH [TABLE] KEY on a SORTED table (A4H 2026-09-24,
  // $ZOSG_TMP_0441, fix round): a search by the key's leading components,
  // a miss is 4 and the row the key would go before, or 8 and lines + 1;
  // without the first key component linear, a miss 4/0; the work area is
  // left alone on a miss
  ZCL_GOGEN_T_SORTRD: "hit:0/3/3 mid:4/3/c first:4/1 past:8/5 tk:4/3,8/5 fs:4/4 nf:8/5 nonkey:0/4,4/0 kv:0/3 lead:0/1/1,0/3/3,4/2,8/5,4/1 second:0/3,4/0 tk2:4/4 line:4/2/f,0/2/q,8/3",
  // a miss with a key part and a component outside the key: A4H gave 4/3,
  // 8/5 and 4/-1 (k = m v = 9, k = x v = 9, a = 2 v = 9), no rule; refused
  // at the miss, the hit before it still answers
  ZCL_GOGEN_T_SORTRD2: {Go: "ERROR NOT_COMPILED in READ TABLE: a miss on a SORTED table with a key part and components outside the key: not measured at zcl_gogen_t_sortrd2.clas.abap:28",
    JS: "ERROR NOT_COMPILED in READ TABLE: a miss on a SORTED table with a key part and components outside the key: not measured"},
  // a handler FOR EVENT e OF a subclass, FOR ALL INSTANCES: senders of the
  // subclass only, whatever the static type of the reference raising it
  // (A4H 2026-09-24, $ZOSG_TMP_0441, fix round)
  ZCL_GOGEN_T_EVENTS3: "all:b(base)s(sub)b(sub)s(sub2)b(sub2) one:s(sub2)",
  // a class constructor runs at the first use of its class: a static method
  // call, a CREATE OBJECT of it or of a subclass (the superclass's first),
  // once (A4H 2026-09-24, $ZOSG_TMP_0440; the transpiler runs them all when
  // the program loads, ANOMALY-2026-09-14-class-constructor-eager)
  ZCL_GOGEN_T_CCTOR: "a cc3 t3 t3 b cc1 cc2 t1 c ",
  // an exception out of a class constructor: a runtime abortion on A4H
  // (2026-09-24, $ZOSG_TMP_0441, fix round: "Division by 0", none of the
  // CATCHes, CX_SY_ZERODIVIDE, CX_SY_NO_HANDLER, CX_ROOT, took it)
  ZCL_GOGEN_T_CCBOOM2: {Go: "ERROR RUNTIME_ERROR in ZCL_GOGEN_T_CCBOOM=>CLASS_CONSTRUCTOR: CX_SY_ZERODIVIDE in / at zcl_gogen_t_ccboom.clas.abap:15",
    JS: "ERROR RUNTIME_ERROR in ZCL_GOGEN_T_CCBOOM=>CLASS_CONSTRUCTOR: CX_SY_ZERODIVIDE in /"},
  // substring_before / _after: the first occurrence, empty when none (A4H
  // 2026-09-24, $ZOSG_TMP_0440, ultra/events)
  ZCL_GOGEN_T_WGUI2: "b:[a][][][k] a:[b=c][][x][][c]",
  // not an A4H value: the language rule that a WHILE condition and a LOOP
  // ... WHERE read the variable as the body left it (the Go emitter's string
  // builders kept an appended string out of both until the loop ended)
  ZCL_GOGEN_T_WHILEAPP: "ababab xxx",
  // not an A4H value: a generic table's rows keep their type (the Go
  // emitter gave a c 3 table the descriptor of a string table: "g g")
  ZCL_GOGEN_T_DESCKEY: "g C",
  // not an A4H value: sy-subrc written and read back, concat_lines_of( )
  // over a table of strings with sep '&', none and ', ' (ultra/httpc; the
  // transpiler on Node answers the same)
  ZCL_GOGEN_T_SUBRCW: "subrc:7,0 empty:[] cat:[a&&b c][ab c][a, , b c]",
  // RAW(n) columns (ultra/zvdb, A4H 2026-09-24, $ZOSG_TMP_0300, the same
  // code but for the CATCH, see each class): read into xstring the n bytes
  // (trailing 00 and an initial value too), into x cut or 00-padded; WHERE
  // with an x of the same length or an xstring of exactly n bytes (else
  // CX_SY_OPEN_SQL_DATA_ERROR), < and ORDER BY in byte order; SET with any
  // x / xstring cut or padded, a string by the move rule; INTO (a, b) by
  // position, a miss keeps the targets, @DATA( ) typed as the column; a
  // literal is exactly 2n upper-case hex digits (dynamic WHERE: else
  // CX_SY_OPEN_SQL_DATA_ERROR)
  ZCL_GOGEN_T_RAWRD: {Go: "xs:A4=12000000;B4=12340000;C4=00000000;D4=FFFFFFFF;E4=00000012; x2:A=1200;120000000000;B=1234;123400000000;C=0000;000000000000;D=FFFF;FFFFFFFF0000;E=0000;000000120000; eqs5:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR  eq4:A eqs1:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR eqs4:A eq0:C eqe:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR lt4:CE gts1:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR nes1:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR ord:CEABD set1:1/4=12000000 sets1:4=12000000 set5:4=12000000",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_RAW: the JS backend has no database (the Go host has SQLite)"},
  ZCL_GOGEN_T_RAWSEL: {Go: "old:0/BB/12340000 miss:4/BB/12340000 new:0/[A]/12000000 inl:0/12000000/[A]/12345678/[ABCD] nmiss:4/keep/12000000 imiss:4/00000000/[] us1:0/1=56000000 us5:0/1=56000000",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_RAW: the JS backend has no database (the Go host has SQLite)"},
  ZCL_GOGEN_T_RAWSTR: {Go: "[12AB]0/1=12AB0000 [12ab]0/1=12000000 [1234567890AB]0/1=12345678 [XYZ]0/1=00000000 []0/1=00000000 [ABC]0/1=ABC00000 [12345678]0/1=12345678 ",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_RAW: the JS backend has no database (the Go host has SQLite)"},
  ZCL_GOGEN_T_RAWDYN: {Go: "st4:A stlt:ABC [r = '12000000']:A [r = '12']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r = '1200000000']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r < '12340000']:AC [r = 'abcdef01']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r = 'ABCDEF01']:E [r = 'XYZ']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r = '']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r = '00000000']:C [r = 12]:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r = ' 12000000']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR [r = '1200000 ']:\\CLASS=CX_SY_OPEN_SQL_DATA_ERROR",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_RAW: the JS backend has no database (the Go host has SQLite)"},
  // a RAW(4) and a DEC(9,2) column in one row, written by INSERT, MODIFY
  // FROM TABLE and read back (merge of ultra/zvdb and ultra/demodata; not an
  // A4H value, each column's rule is pinned above on its own)
  ZCL_GOGEN_T_RAWDEC: {Go: "ins:0=12AB0000/111.12 mod:0/2 A=00000001/9999999.99 B=FFFFFFFF/-0.05",
    JS: "ERROR NOT_COMPILED in DELETE ZGOGEN_T_RAWDEC: the JS backend has no database (the Go host has SQLite)"},
  // string / c -> x and xstring: the longest prefix of upper-case hex digits,
  // odd padded with 0; CORRESPONDING #( ) from initial by name; BIT-XOR of
  // xstrings, the shorter padded with 00 (ultra/zvdb, A4H, same code)
  ZCL_GOGEN_T_XCONV: "x4:AB000000;00000000;A0000000;AB000000;AB000000;12345678;00000000;00000000;ABC00000;00000000; xs:1=AB;0=;1=A0;1=AB;1=AB;5=1234567890;0=;0=;2=ABC0;1=00; c:AB000000/1=AB cor:[xy]2/[AB]/7/[];[xy]/[AB]/7/[];[xy]/[AB]/7/[] xor:2=F00F/2=F00F/2=F00F conv:ABCDEF/CD/205/2",
  // a superclass's constant named through the subclass (ultra/zvdb, A4H
  // 2026-09-24, $ZOSG_TMP_0300, the same code)
  ZCL_GOGEN_T_INHCONST: "SUP/ZMSG/042/SUP",
  // ultra/demodata, A4H 2026-09-24 ($ZOSG_TMP_0462, ZCL_GOGEN_T_NUMC):
  // NUMC moves -- i -> n drops the sign and keeps the last digits, c -> n
  // keeps the digits only, n -> string keeps the zeros, n -> c 8 is its
  // first eight, n by offset, in CONCATENATE, a template and a constant
  ZCL_GOGEN_T_NUMC: "i:0000000042,005,456,00 c:9000000001,0000000012,123,765,000 ni:42  ns:[0000000042] nc:[00000000] off:123 ,000000123 cat:20250107,9000000017 tpl:000000017 const:9000000000 gt",
  // ZCL_OSD_DEMO_RANDOM / ZCL_OSD_DEMO_TAXI (copies of src/demo_data, checked
  // below): A4H answered exactly this for the same class (2026-09-24,
  // $ZOSG_TMP_0462; the checksum re-pinned after #65's review, which folds
  // the client, zone and payment in: 163171580, pinned_checksum green on
  // A4H in $ZOSG_TMP_0463), and so does Node's transpiler: the 10000th step of the
  // minimal standard, the first five rows and the checksum of 20000
  ZCL_GOGEN_T_DEMODATA: "pm:1043618065  9000000001 20250101 0 Manhattan/Penn Station/Madison Sq West/Cash 2 28.24 0.00 4.48; 9000000002 20250101 0 Manhattan/TriBeCa/Civic Center/Card 2 28.90 4.33 4.56; 9000000003 20250101 0 Manhattan/Upper West Side South/Card 8 83.76 14.23 12.24; 9000000004 20250101 0 Manhattan/Chinatown/Card 1 12.12 2.90 1.76; 9000000005 20250101 0 Manhattan/Central Park/Card 2 16.02 2.88 2.38; rows 20000 trips 78715 fare 1264137.29 tip 178368.34 distance 215645.95 checksum 163171580",
  // not an A4H value (ZOSD_TAXIFACT does not activate there: ZONE is a
  // reserved word): what Node's transpiler answers for the same calls.
  // Written, unchanged, read back (p columns round-trip), replaced, removed
  ZCL_GOGEN_T_DEMODB: {Go: "taxi: 300 synthetic rows of seed 9 written (checksum 669166395), 0 replaced | taxi: 300 synthetic rows of seed 9 present (checksum 669166395); unchanged | 9000000001 20250101 3 Queens/LaGuardia Airport/Other 1 56.11 0.00 11.44; 9000000002 20250101 8 Manhattan/Lincoln Square West/Disputed 1 13.31 0.00 2.05; rows 300 trips 1365 fare 20086.65 tip 3245.89 distance 3279.43 checksum 669166395 | taxi: 100 synthetic rows of seed 9 written (checksum 1304488219), 300 replaced | taxi: 0 synthetic rows of seed 20250101 written (checksum 1), 100 replaced",
    JS: "ERROR NOT_COMPILED in SELECT COUNT(*) FROM ZOSD_TAXIFACT: the JS backend has no database (the Go host has SQLite)"},
  ZCL_GOGEN_T_BOOM: {Go: "ERROR CX_SY_ZERODIVIDE in / at zcl_gogen_t_boom.clas.abap:9", JS: "ERROR CX_SY_ZERODIVIDE in /"},
};
const {libraryPath} = await import("../osd-lib-path.mjs");
const core = `${libraryPath(home, "open-abap-core")}/src`;
const ajson = `${libraryPath(home, "ajson")}/src/core`;
// the demo-data classes in testdata/ are copies of src/demo_data: when the
// checkout has them (OSG_HOME), a copy that drifted is a failure
const demoCopies = readdirSync(join(here, "testdata")).filter((f) => /^zcl_osd_demo_\w+\.clas\.abap$/.test(f)).sort();
const demoDrift = [];
for (const f of demoCopies) {
  const theirs = join(home, "src", "demo_data", f);
  if (!existsSync(theirs)) { console.log(`skip copy check ${f}: not in ${home}/src/demo_data`); continue; }
  if (readFileSync(theirs, "utf8") !== readFileSync(join(here, "testdata", f), "utf8")) demoDrift.push(f);
}
// sorted: zcl_gogen_t_uncaught_read reads what zcl_gogen_t_uncaught left
const objects = readdirSync(join(here, "testdata")).filter((f) => f.endsWith(".clas.abap")).map((f) => f.split(".")[0]).sort();
// the function groups (parity-wave1: ZGOGEN_T_FG, called by ZCL_GOGEN_T_FM)
// A focused invocation still checks the shared Go/JS oracle rows.
const selected = process.argv.slice(2).flatMap((arg, i, args) => arg === "--class" ? [args[i + 1]?.toLowerCase()] : []);
if (selected.length) {
  for (const name of selected) if (!objects.includes(name)) throw new Error(`unknown semantics class: ${name}`);
  objects.splice(0, objects.length, ...objects.filter((name) => selected.includes(name)));
}
const groups = readdirSync(join(here, "testdata")).filter((f) => f.endsWith(".fugr.xml")).map((f) => f.split(".")[0]).sort();
// the roots of the exception classes, and get_text( )'s helper, compiled
// out of open-abap-core as the gateway compiles them
// and RTTI (ultra/json: describe_by_data, ZCL_GOGEN_T_RTTI)
const CORE = ["CX_ROOT", "CX_STATIC_CHECK", "CX_DYNAMIC_CHECK", "CX_NO_CHECK", "CL_MESSAGE_HELPER", "CL_ABAP_CONV_OUT_CE", "CL_ABAP_CONV_IN_CE", "CL_ABAP_REGEX", "CL_HTTP_UTILITY",
  "ZCL_AJSON", "ZIF_AJSON", "ZIF_AJSON_TYPES", "ZCX_AJSON_ERROR", "CL_ABAP_MESSAGE_DIGEST", "CX_ABAP_MESSAGE_DIGEST",
  "CL_ABAP_TYPEDESCR", "CL_ABAP_DATADESCR", "CL_ABAP_ELEMDESCR", "CL_ABAP_COMPLEXDESCR", "CL_ABAP_STRUCTDESCR", "CL_ABAP_TABLEDESCR", "CL_ABAP_REFDESCR", "CL_ABAP_OBJECTDESCR", "CL_ABAP_CLASSDESCR", "CL_ABAP_INTFDESCR",
  // and open-abap-core's JSON reader (ZCL_GOGEN_T_JSONDES)
  "/UI2/CL_JSON", "CL_SXML_STRING_READER", "CX_SXML_PARSE_ERROR", "CX_SXML_ERROR", "CL_ABAP_CODEPAGE",
  // raw DEFLATE and zip (parity-wave2, ZCL_GOGEN_T_GZIP, ZCL_GOGEN_T_ZIP)
  "CL_ABAP_GZIP", "CL_ABAP_ZIP"];
const program = compileProgram({folders: [join(here, "testdata"), core, ajson], objects: [...objects, ...groups, ...CORE]});
// the classes that carry a test: a static RUN of their own (the others are
// the classes those tests use)
objects.splice(0, objects.length, ...objects.filter((o) => program.classes.find((c) => c.name === o.toUpperCase())?.methods.some((m) => m.name === "RUN" && m.static)));
if (program.skipped.length) console.log(`not compiled: ${program.skipped.join("; ")}`);
const out = join(here, ".out", "semantics");
mkdirSync(out, {recursive: true});
const dir = join(here, "go", "cmd", "semantics");
mkdirSync(dir, {recursive: true});
writeFileSync(join(dir, "zz_generated.go"), emitGo(program));
// the database of the Go harness: the transpiler's CREATE TABLEs for this
// registry (zgogen_t_dbw among them), no rows; each RUN is one dialog step
// the same entry gateway.mjs builds its database script from: a module the
// transpiler does not export, path read off @abaplint/transpiler 2.13.89;
// a layout change there breaks both, loudly (the import fails)
const {DatabaseSetup} = await import(`${home}/node_modules/@abaplint/transpiler/build/src/db/index.js`);
writeFileSync(join(dir, "zz_db.json"), JSON.stringify(new DatabaseSetup(program.reg).run().schemas.sqlite));
// DESTINATION 'STORE' (ZCL_GOGEN_T_STORE): the object store over a copy of
// testdata-store/tree, fresh each run, since a WRITE lands in it; the
// build's facts about it come from the Node store, as osgo.mjs takes them
const storeTree = join(out, "store-tree");
rmSync(storeTree, {recursive: true, force: true});
cpSync(join(here, "testdata-store", "tree"), storeTree, {recursive: true});
const {storeConfig} = await import("./store.mjs");
const storeFacts = JSON.stringify(await storeConfig(storeTree, {storeModule: `${home}/tools/osd-store.mjs`}));
writeFileSync(join(dir, "main.go"), `package main\n\nimport (\n\t_ "embed"\n\t"fmt"\n\t"runtime/debug"\n\t"strings"\n\n\t"osg/gogen/abap"\n)\n\n//go:embed zz_db.json\nvar dbScript []byte\n\n// abapLine is the first frame of the stack that is ABAP source: the stack\n// of the first panic when a TRY passed it on\nfunc abapLine(r any) string {\n\tst := string(debug.Stack())\n\tif w, ok := r.(*abap.Rethrown); ok {\n\t\tst = w.Stack\n\t}\n\tfor _, l := range strings.Split(st, "\\n") {\n\t\tl = strings.TrimSpace(l)\n\t\tif i := strings.Index(l, ".abap:"); i > 0 {\n\t\t\tif j := strings.IndexAny(l[i:], " +"); j > 0 {\n\t\t\t\tl = l[:i+j]\n\t\t\t}\n\t\t\treturn l[strings.LastIndex(l, "/")+1:]\n\t\t}\n\t}\n\treturn "?"\n}\n\nfunc main() {\n\tif err := abap.OpenDB(dbScript); err != nil {\n\t\tpanic(err)\n\t}\n\tif err := abap.SetMediaDir(${JSON.stringify(join(here, "testdata", "media"))}); err != nil {\n\t\tpanic(err)\n\t}\n\tif err := abap.SetStore(${JSON.stringify(storeTree)}, []byte(${JSON.stringify(storeFacts)}), ""); err != nil {\n\t\tpanic(err)\n\t}\n\t// Fixtures share one internal session, including the post-dump log reader.\n\ts := &abap.Session{}\n${objects.map((o) => `\tfunc() {\n\t\tdefer func() {\n\t\t\tif r := recover(); r != nil {\n\t\t\t\tfmt.Printf("${o.toUpperCase()}\\tERROR %v at %s\\n", r, abapLine(r))\n\t\t\t}\n\t\t}()\n\t\tvar out string\n\t\ts.Sy = abap.Sy{}\n\t\tabap.DialogStep(func() { out = ${funcName(o.toUpperCase(), "RUN")}(s) })\n\t\tfmt.Printf("${o.toUpperCase()}\\t%s\\n", out)\n\t}()`).join("\n")}\n}\n`);
execFileSync("gofmt", ["-w", dir]);
// a write root of its own for the DATASET cases, relative names land in it
const datasetRoot = join(here, ".out", "dataset-root");
rmSync(datasetRoot, {recursive: true, force: true});
mkdirSync(datasetRoot, {recursive: true});
const goOut = execFileSync("go", ["run", "./cmd/semantics"], {cwd: join(here, "go"),
  env: {...process.env, OSD_DATASET_READ: "", OSD_DATASET_WRITE: datasetRoot, OSD_DATASET_HOME: ""}}).toString();
writeFileSync(join(out, "t.mjs"), emitJs(program));
copyFileSync(join(here, "js", "abap.mjs"), join(out, "abap.mjs"));
const m = await import(pathToFileURL(join(out, "t.mjs")).href);
let bad = 0;
for (const line of goOut.trim().split("\n")) {
  const [cls, go] = line.split("\t");
  let js;
  try { js = m[cls].RUN({sy: {index: 0, tabix: 0, subrc: 0, dbcnt: 0}}); } catch (e) { js = `ERROR ${e.message}`; }
  for (const [who, got] of [["Go", go], ["JS", js]]) {
    if (EXPECT[cls] === undefined) { console.log(`new  ${who} ${cls}: ${got}`); continue; }
    const want = typeof EXPECT[cls] === "string" ? EXPECT[cls] : EXPECT[cls][who];
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${who} ${cls}: ${got}${ok ? "" : `\n     want: ${want}`}`);
  }
}

// What A4H does not activate and abaplint does not report, so the front end
// refuses it (a statement stub): testdata-refused/ holds one statement per
// refusal, each answered by its message at its line, and the neighbours that
// must still compile (an attribute named VALUE, a read of a READ-ONLY
// attribute); MV_X is READ-ONLY and shares its name with a component of a
// structure declared before it, which is not an attribute and must not hide
// the READ-ONLY. lo_i->zif~attr on a reference to zif itself is a
// syntax error abaplint does report, so that object is left out whole.
const REFUSED = {
  12: "ZIF_GOGEN_T_RF~MV_V: VALUE on an interface DATA does not activate on A4H",
  13: "ZIF_GOGEN_T_RF->MV_RO: a write to a READ-ONLY attribute through an interface reference (a syntax error on A4H)",
  14: "ZCL_GOGEN_T_RF_OBJ->ZIF_GOGEN_T_RF~MV_RO: a write to a READ-ONLY attribute outside ZCL_GOGEN_T_RF_OBJ (a syntax error on A4H)",
  15: "ZIF_GOGEN_T_RF->CO_K: a constant through an interface reference is not in the subset",
  17: "ZIF_GOGEN_T_RF->MV_X: a write to a READ-ONLY attribute through an interface reference (a syntax error on A4H)",
  // REGEX in byte mode is a syntax error on A4H that abaplint lets through;
  // refused rather than searched for as bytes
  22: "FIND form: FIND REGEX lv_p IN lv_xs IN BYTE MODE MATCH OFFSET lv_o.",
};
const refused = compileProgram({folders: [join(here, "testdata-refused"), core], objects: ["zcl_gogen_t_rf", "zcl_gogen_t_rf_obj", "zcl_gogen_t_rf_own"], tolerant: true});
const got = new Map(refused.partial.map((x) => [Number(/zcl_gogen_t_rf\.clas\.abap:(\d+)\)/.exec(x)?.[1]), x.slice(x.indexOf("): ") + 3)]));
for (const [line, want] of Object.entries(REFUSED)) {
  const ok = got.get(Number(line)) === want;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} refused :${line}: ${got.get(Number(line)) ?? "(compiled)"}${ok ? "" : `\n     want: ${want}`}`);
}
for (const [line, msg] of got) {
  if (REFUSED[line] === undefined) { bad += 1; console.log(`FAIL refused :${line}: must compile, got ${msg}`); }
}
// Sorted-table moves, VALUE rows, and a standard-table actual now compile.
// Keep the old refusal corpus as a compile check so these forms stay covered.
const REFUSED_SORT = {54: "SHOW: a STANDARD table is not type-compatible with SORTED parameter IT (A4H refusal)"};
const rsort = compileProgram({folders: [join(here, "testdata-refused"), core], objects: ["zcl_gogen_t_rf_sort"], tolerant: true});
const rgot = new Map(rsort.partial.map((x) => [Number(/zcl_gogen_t_rf_sort\.clas\.abap:(\d+)\)/.exec(x)?.[1]), x.slice(x.indexOf("): ") + 3)]));
for (const line of new Set([...Object.keys(REFUSED_SORT).map(Number), ...rgot.keys()])) {
  const ok = rgot.get(line) === REFUSED_SORT[line];
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} refused sort :${line}: ${rgot.get(line) ?? "(compiled)"}${ok ? "" : `\n     want: ${REFUSED_SORT[line] ?? "(compiled)"}`}`);
}
for (const f of demoDrift) { bad += 1; console.log(`FAIL testdata/${f} differs from ${home}/src/demo_data/${f}: copy it again`); }
const own = refused.broken.includes("zcl_gogen_t_rf_own");
if (!own) bad += 1;
console.log(`${own ? "ok  " : "FAIL"} refused ZCL_GOGEN_T_RF_OWN left out by abaplint's syntax check`);
// DELETE TABLE itab FROM wa inside a LOOP over the same table (#688 critic)
const DEL_REFUSED = {23: "DELETE TABLE lt FROM wa inside a LOOP over the same table: the loop index and its field symbol were not adjusted", 26: "DELETE TABLE lt FROM <row> inside a LOOP over the same table: the loop index and its field symbol were not adjusted", 30: "DELETE TABLE lt FROM wa inside a LOOP over the same table: the loop index and its field symbol were not adjusted"};
const rdel = compileProgram({folders: [join(here, "testdata-refused"), core], objects: ["zcl_gogen_t_rf_delfrom"], tolerant: true});
const dgot = new Map(rdel.partial.map((x) => [Number(/zcl_gogen_t_rf_delfrom\.clas\.abap:(\d+)\)/.exec(x)?.[1]), x.slice(x.indexOf("): ") + 3)]));
for (const line of new Set([...Object.keys(DEL_REFUSED).map(Number), ...dgot.keys()])) {
  const ok = dgot.get(line) === DEL_REFUSED[line];
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} refused delfrom :${line}: ${dgot.get(line) ?? "(compiled)"}${ok ? "" : `\n     want: ${DEL_REFUSED[line] ?? "(compiled)"}`}`);
}
// a hashed secondary key (abapiti 042): what stays refused
const HKEY_REFUSED = {21: "READ TABLE WITH KEY BY_K INTO a work area of another type (READ TABLE shorts WITH KEY by_k COMPONENTS k = 'a' INTO wa.)", 23: "DELETE TABLE entries WITH TABLE KEY by_k COMPONENTS k = row-k inside a LOOP over the same table: the loop index and its field symbol were not adjusted", 25: "key BY_K: a hashed secondary key (LOOP AT entries INTO row USING KEY by_k.)"};
const rhkey = compileProgram({folders: [join(here, "testdata-refused"), core], objects: ["zcl_gogen_t_rf_seckeyh"], tolerant: true});
const hgot = new Map(rhkey.partial.map((x) => [Number(/zcl_gogen_t_rf_seckeyh\.clas\.abap:(\d+)\)/.exec(x)?.[1]), x.slice(x.indexOf("): ") + 3)]));
for (const line of new Set([...Object.keys(HKEY_REFUSED).map(Number), ...hgot.keys()])) {
  const ok = hgot.get(line) === HKEY_REFUSED[line];
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} refused seckeyh :${line}: ${hgot.get(line) ?? "(compiled)"}${ok ? "" : `\n     want: ${HKEY_REFUSED[line] ?? "(compiled)"}`}`);
}
// LOOP ... USING KEY with a WHERE in int8 over an i component (abapiti 043)
const ri8 = compileProgram({folders: [join(here, "testdata-refused"), core], objects: ["zcl_gogen_t_rf_wherei8"], tolerant: true});
const ri8ok = ri8.partial.some((x) => x.includes("zcl_gogen_t_rf_wherei8.clas.abap:16): LOOP ... USING KEY with a WHERE on a component of another type"));
if (!ri8ok) bad += 1;
console.log(`${ri8ok ? "ok  " : "FAIL"} refused wherei8 :16: ${ri8.partial.join(" | ") || "(compiled)"}`);
const resumable = compileProgram({folders: [join(here, "testdata-refused"), core], objects: ["zcl_gogen_t_rf_resume", "CX_SY_ZERODIVIDE"], tolerant: true});
const resumeRefused = resumable.partial.some((x) => x.includes("RAISE RESUMABLE:"));
if (!resumeRefused) bad += 1;
console.log(`${resumeRefused ? "ok  " : "FAIL"} refused RESUMABLE until continuation support is implemented`);
process.exit(bad ? 1 : 0);
