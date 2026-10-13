# open-abap and transpiler anomaly log

Behaviour that differs between a real SAP system and open-abap / the abaplint
transpiler / its database adapter. Add an entry as soon as the discrepancy is
isolated and before hiding it behind a workaround. Ordinary open-steamgate
defects that reproduce identically on both runtimes do not belong here.

Resolved entries stay as compatibility history. Review all open entries before
upgrading `@abaplint/*` and before every release.

Format adapted from `larshp/hithub` (MIT).

## Entry template

### ANOMALY-YYYY-MM-DD-short-name — Short title

- Status: `open` | `workaround` | `reported` | `fixed` | `not-an-anomaly`
- Discovery date: `YYYY-MM-DD`
- Affected versions: `@abaplint/transpiler-cli x.y.z`, `@abaplint/runtime x.y.z`, `@abaplint/database-sqlite x.y.z`
- Affected ABAP statement, runtime API or adapter: `...`
- Minimal ABAP reproducer: `path/to/reproducer`
- Exact command used to run it: `...`
- Expected SAP behaviour: `...`
- Actual open-abap behaviour: `...`
- Impact on open-steamgate: `...`
- Smallest safe workaround: `...` or `none`
- Upstream issue: `link` or why it has not been reported
- Regression-test location: `path/to/test`
- Upstream version containing a fix: `...` or `unknown`

## Open anomalies

### ANOMALY-2026-10-10-get-run-time-wrap -- GET RUN TIME does not wrap at 2^31

- Status: `open` (fix committed locally in the transpiler branch).
- Discovery date: `2026-10-10`.
- Affected versions: `@abaplint/runtime 2.14.2` on transpiler `origin/main`; the unwrapped implementation also affected the observed 55-minute run.
- Affected ABAP statement, runtime API or adapter: `GET RUN TIME FIELD`; `packages/runtime/src/statements/get_run_time.ts` in `abaplint/transpiler`.
- Minimal ABAP reproducer: `DATA elapsed TYPE i. GET RUN TIME FIELD elapsed.`; repeat in the same internal session more than `2147483648` microseconds after the first call. A controllable-clock reproducer is `packages/runtime/test/statements/get_run_time.ts` in the transpiler clone.
- Exact command used to run it: `cd packages/runtime && npm test -- --grep 'Statement GET RUN TIME'` in the transpiler clone. Kernel measurement: background job calling the statement into `TYPE i` every 60 seconds for 41 minutes.
- Expected SAP behaviour: measured on an ABAP 7.5x system on `2026-10-10`, the first call returns 0 and elapsed microseconds wrap modulo `2^31`, staying non-negative without an exception. Minute 35: `2100029253`; minute 36: `12546088` (a drop of about `2^31`, then growing again); subsequent minutes: `72546692`, `132547544`.
- Actual open-abap behaviour: assigns `floor((now - start) * 1000)` without wrapping. `Integer.set` does not range-check (its check is commented out), so after about 35.8 minutes a `TYPE i` target silently holds a value above `2147483647`. OSG's pinned runtime carries abaplint/transpiler#1955 (the `i` range check), so there the assignment itself raises `CX_SY_ARITHMETIC_OVERFLOW`; that is how a 55-minute run ended.
- Impact on open-steamgate: long-running sessions and background jobs that read the runtime counter get out-of-range `TYPE i` values; arithmetic on them can overflow.
- Smallest safe workaround: carried in the pin: `libs.lock.json` transpiler oisee/transpiler `local/osd-build-2026-10-10` ee5c2cd1 = the previous pin 753230cb plus the fix.
- Upstream issue: abaplint/transpiler#1990 (branch `get-run-time-wrap`).
- Regression-test location: transpiler `packages/runtime/test/statements/get_run_time.ts`; fake `performance.now` and fallback `Date.now`, first call, boundary, wrap, unwrapped monotonic clamp, continued progress, second wrap.
- Target type: the measurement and the fix cover `TYPE i`, the type SAP documents for the field ([ABAP 7.50 documentation](https://help.sap.com/doc/abapdocu_750_index_htm/7.50/en-US/abapget_run_time.htm)).
- Upstream version containing a fix: `unknown`.

### ANOMALY-2026-10-08-dec-sqlite-real -- DEC precision collapses in SQLite

- Status: `open`
- Discovery date: `2026-10-08`
- Affected versions: `@abaplint/transpiler 2.13.93`, `@abaplint/runtime 2.13.93`, `@abaplint/database-sqlite 2.13.83`; OSGo SQLite host.
- Affected adapter: DEC columns in the SQLite Open SQL seam.
- Minimal ABAP reproducer: `tools/gogen/testdata/adt-cases/zcl_adt_pwhere.clas.abap`, method `precision_parity`, table `zadt_pwhere` (DEC 21,7).
- Exact command: `GOFLAGS=-buildvcs=false OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh node tools/gogen/unit.mjs --fixture tools/gogen/testdata --class ZCL_ADT_PWHERE --jobs 4`.
- Expected SAP behaviour: exact decimal comparison of rows `20261008100000.1234567` and `20261008100000.1234568` against the first value gives counts `1, 0, 2, 1` for `=`, `<`, `>=`, and point `BETWEEN`.
- Actual open-abap behaviour: DEC beyond 15 significant digits is stored as REAL by the SQLite seam; equality and ranges at the 16th digit collapse. The transpiled JS class through `@abaplint/database-sqlite` stores both rows as REAL `20261008100000.125` and returns `2, 0, 2, 2`; the same ABAP/table fixture on Go returns identical counts. Local measurement: `.local/hostcls/dec-measure.txt`, scripts `measure-dec.mjs` and `measure-dec-go.mjs` beside it.
- Impact: DEC 15 timestamps remain exact; full DEC 21,7 timestamp precision is unavailable in SQLite comparisons on both hosts.
- Smallest safe workaround: compare values within 15 significant digits when exactness is required; storage is unchanged.
- Upstream issue: not reported; this round is local only.
- Regression: the fixture asserts DEC 15 exactly, adjacent DEC 21,7 values `20261008.1234567` / `20261008.1234568` exactly, and measured high-precision host parity.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-08-lone-surrogate-egress -- Unmeasured text output of lone UTF-16 halves

- Status: `open`
- Affected runtime: OSGo's text DATASET, `CL_GUI_FRONTEND_SERVICES=>GUI_DOWNLOAD`
  in ASC mode, and APC text messages.
- Actual OSGo behaviour: a lone surrogate produced by a character section is
  stored as WTF-8 and its bytes are written unchanged to UTF-8 text output
  (for example, a high D83D unit is `ED A0 BD`). File output also writes its
  configured newline; APC submits the same bytes as a text frame, which a
  receiver requiring valid UTF-8 may reject. Adjacent high/low halves are
  joined at string construction and leave as the normal supplementary character.
- `substring_before/after` with a half inside a supplementary character return empty in OSGo; the kernel splits on UTF-16 units; A4H was not measured.
- `SPLIT AT` a half leaves the supplementary character unsplit in OSGo; the kernel splits on UTF-16 units; A4H was not measured.
- `shift_left/right( sub = half )` leaves the supplementary character unchanged in OSGo; the kernel splits on UTF-16 units; A4H was not measured.
- Expected SAP behaviour: unknown; A4H was not measured. No substitution,
  rejection or encoding rule is inferred from the behaviour of this host.
- Smallest safe workaround: avoid sending lone halves to text output.
- Regression: `tools/gogen/go/abap/text_egress_test.go`,
  `tools/gogen/go/apc/surrogate_test.go`, and the UTF-16 ABAP Unit fixture.
- Upstream: not reported; kernel behaviour needs measurement first.

### ANOMALY-2026-10-07-aunit-comparison-sign -- E.2 type-blind comparison formatting

- Status: `fixed locally`
- Affected versions: locked transpiler/runtime `f3611417` (2.13.93), open-abap-core `8b397be`.
- API: `cl_abap_unit_assert=>assert_equals`, projected by ADT XML and STORE `RUN_TESTS`.
- Reproducer: `test/fixtures/aunit-x2/` and `test/fixtures/aunit-types/`
  (synthetic sources; X2 XML is synthetic too).
- Expected SAP behaviour: subtraction of 3 from 2 reports actual text `1-` and
  testclasses stack line 7; addition reports one pass with no alerts.
- Actual open-abap behaviour: its assertion dump erases operand types into strings.
  E.2 (#628) inferred numeric types from those strings in ADT XML, so a character
  or string `'-1'` incorrectly became `"1-"`. X2 initially reused that formatter
  in STORE: the adapters agreed on this common error. Packed padding, float
  detail splitting, and underscore title casing also differed from SAP.
- Resolution: `tools/osd-unit-assert.mjs` wraps the existing assertion during Unit
  runs, retaining RTTI kind/decimals and scalar values on the original exception.
  `alertOf` carries that provenance through detached result JSON.
  `tools/osd-unit-value.mjs` formats each known type for both adapters; unknown
  types retain runtime text. XML splits float details and cases method titles
  at underscores, and sorts uppercase names by byte order. Comparisons and raw
  exception messages are unchanged; X2 still reports integer actual `"1-"`.
- Limits: packed thousands separators/other magnitudes are unmeasured; decimal
  float precision remains limited by the runtime scalar representation.
- Upstream issue: none; this is the host's protocol projection.
- Regression: `OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 tools/osd-heavy.sh npx mocha test/adt-aunit-types.mjs test/adt-aunit-conformance-x2.mjs test/adt-unit-result.mjs`.

### ANOMALY-2026-10-06-transpiler-validation-state -- runtimeError leaks into later compileError runs

- Status: `workaround`
- Affected version: locked transpiler `f3611417`, version 2.13.93.
- Reproducer: run a registry with `unknownTypes: runtimeError`, then a new registry with `unknownTypes: compileError` in the same process. `build/src/validation.js` leaves its exported `config.syntax.errorNamespace` at `VOID_EVERYTHING` instead of restoring `.`.
- Expected: each build uses its requested unknown-type policy, independent of previous builds.
- Actual: earlier DSL suites change later cold output for IF_ALV_MESSAGE and both SALV exception classes; a fresh warm compiler refuses the byte comparison.
- Workaround: when the selected transpiler exposes `build/src/validation.js`, normalize its validation namespace before every validation, including directly constructed instances and bundled hosts. Linked fixture transpilers without that module skip the normalization; errors loading an existing validator still propagate.
- Regression: `test/warm.mjs`, runtimeError followed by compileError rejects an unresolved type.
- Upstream: not filed; this task authorizes local CI repair only. No SAP calls were needed for this compiler-state defect.

### ANOMALY-2026-10-06-adt-unit-result-uris - ABAP Unit results name invalid class source suffixes

- Status: `fixed locally`
- Discovery: user-supplied SAP protocol measurement, 2026-10-06; no SAP calls made for this fix.
- Affected path: `tools/adt-documents.mjs` result and frame URI rendering (now extracted into `tools/adt-unit-result.mjs`), and both facade result callers.
- Expected: class results use semantic class/method selectors, include navigation selectors, and include stack URIs with `#start=line,0`. Class include URIs have no `/source/main` suffix. Disabling navigation removes class/method types as well as navigation attributes. Assertion comparisons are nested under `Different values`.
- Actual: class/method identities and stack frames used `/includes/testclasses/source/main#start=...`; Eclipse rejected the suffix after running the tests. Navigation options were ignored and comparison details were flat.
- Resolution: render the measured CLAS shapes, preserve available failure text, and read the navigation option on run and evaluation. Program result shapes stay as before except for the navigation switch. Activation and check diagnostics retain their existing source suffix explicitly when calling the shared frame helper.
- Regression: `test/adt-unit-result.mjs`, plus the existing development-loop and reference-package run assertions. The new contract suite fails against the old renderer. Include navigation GETs read a synthetic source file; no captures or measured object names are stored.
- Execution seam: Node stack paths resolve the output generation symlink. The runner now compares frames with that resolved output directory so the test include reaches the renderer; previously only the assertion library's explicit frame survived. `test/osd-unit.mjs` checks the real failure line.
- Upstream: none; the renderer is an open-steamgate implementation.

### ANOMALY-2026-10-04-sqlite-like-case -- sql.js Open SQL LIKE ignores ASCII case

- Status: `workaround`
- Discovery date: `2026-10-04`
- Affected versions: `@abaplint/database-sqlite 2.13.83`, `sql.js 1.14.2`.
- Affected adapter: SQLite connection setup, SELECT and cursors with LIKE.
- Minimal ABAP reproducer: transpiled SELECT in `test/sqlite-like.mjs`.
- Exact command: `OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh npx mocha test/sqlite-like.mjs`.
- Expected SAP behaviour: case-sensitive LIKE; lowercase pattern selects 0 and uppercase pattern 32 in the A4H measurement (`docs/osql-where.md`).
- Actual open-abap behaviour: `'A' LIKE 'a'` returns 1 through the default sql.js adapter; the file adapter previously returned 0 through a connection pragma.
- Impact: browser preview and default Node connection selected different rows from file SQLite.
- Smallest safe workaround: shared `tools/sqlite-connection.mjs` enables SQLite case-sensitive LIKE per connection with `PRAGMA case_sensitive_like = ON`, verifies its effect (fail if omitted), and reinstalls it after sql.js export reopens the connection. Native LIKE preserves value conversion and indexed prefix searches.
- Upstream issue: not reported; local work only authorized.
- Regression-test location: `test/sqlite-like.mjs` (SQL, cursors, escaping, export/reconnect and transpiled ABAP; DuckDB and optionally PostgreSQL).
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-03-none-dump-luw -- Local NONE leaves receiver partial writes pending

- Status: `open`
- Discovery date: `2026-10-03`
- Affected versions: `@abaplint/runtime 2.13.93`, local `tools/rfc-replay.mjs`.
- Affected runtime API: `localClient`, synchronous `CALL FUNCTION ... DESTINATION 'NONE'`.
- Minimal ABAP reproducer: copied receiver in `test/dsl-l3-remote.mjs`, "NONE dump isolation anomaly" (INSERT then ASSERT).
- Exact command used to run it: `OSD_HEAVY_RANGE=40-49 tools/osd-heavy.sh npx mocha test/dsl-l3-remote.mjs --grep 'NONE dump isolation anomaly'`.
- Expected SAP behaviour: a separate RFC session rolls back a dumping module's uncommitted writes; the caller's pending writes survive.
- Actual open-abap behaviour: the module shares the caller's connection; caught SYSTEM_FAILURE leaves its partial writes pending, and the caller's next commit persists them.
- Impact on open-steamgate: NONE is an emulation without session isolation, including on failure. It cannot prove receiver dump atomicity.
- Smallest safe workaround: none across the supported DatabaseClient adapters. Whole-connection rollback also erases caller writes (the copied rollback mutant demonstrates this); portable nested transactions/savepoints across module COMMIT are unavailable. Use independent RFC sessions for isolation; SL.0 remains planned.
- Upstream issue: not reported; local work only authorized.
- Regression-test location: `test/dsl-l3-remote.mjs`, "NONE dump isolation anomaly".
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-03-rfc-message -- Transpiler drops RFC exception MESSAGE targets

- Status: `workaround`
- Discovery date: `2026-10-03`
- Affected versions: `@abaplint/transpiler 2.13.93`, `@abaplint/runtime 2.13.93`.
- Affected ABAP statement: `CALL FUNCTION ... DESTINATION ... EXCEPTIONS system_failure = 1 MESSAGE lv_msg communication_failure = 2 MESSAGE lv_msg`.
- Minimal ABAP reproducer: `recipes/l3-remote/client.tpl`, exercised by `test/dsl-l3-remote.mjs`.
- Exact command used to run it: `OSD_HEAVY_RANGE=40-49 tools/osd-heavy.sh npx mocha test/dsl-l3-remote.mjs --grep 'far-side text'`.
- Expected SAP behaviour: MESSAGE receives the remote failure text.
- Actual open-abap behaviour: exception lowering sets only sy-subrc, silently ignoring MESSAGE; local dump conversion also discards the original text.
- Impact on open-steamgate: the doctor sees a failure code without the far-side explanation.
- Smallest safe workaround: local CallFunction transpiler adapter assigns the caught error's message to the parsed MESSAGE target for the two RFC failures; localClient preserves dump text on the classic error. The selected modules receive the idempotent adapter for checkout, bundled-host, warm and generated-copy transpiles.
- Upstream issue: needs an issue in `abaplint/transpiler`; no upstream filing authorized. Present on local current main `71a75787c0013104758e89d79b2830e76bebbb36` (checked 2026-10-03): `call_function.ts` delegates to `CallTranspiler.buildExceptions` in `call.ts`, which emits only sy-subrc assignments and ignores MESSAGE targets.
- Regression-test location: `test/dsl-l3-remote.mjs`, "far-side text", including MESSAGE-removal copies; `test/rfc-message-host.mjs` covers cold and warm host modules plus missing-install copies.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-02-repl009-subrc-text -- Oracle return-code text carries an extra sign blank

- Status: `workaround`
- Discovery date: `2026-10-02`
- Affected versions: gogen Go and IR-as-JS on origin/main `45d8f8af`.
- Affected ABAP statement: `lv_rc = sy-subrc` into a string, followed by `CONCATENATE ... RESPECTING BLANKS`.
- Minimal ABAP reproducer: ABAPiti oracle 009; tracked byte-contract adaptation in `tools/gogen/testdata/zcl_gogen_t_repl009.clas.abap`.
- Exact command used to run it: `node tools/gogen/unit.mjs --fixture tools/gogen/testdata --class ZCL_GOGEN_T_REPL009 --jobs 2 --no-cache` (before the formatting adaptation).
- Expected SAP behaviour: the supplied A4H expectations (ABAPiti, 2026-10-02) contain `[12FF rc=2]`, with no blank before `]`, and likewise for all eight cases.
- Actual gogen behaviour: Go returns `[12FF rc=2 ]`; the shared Go and JS `IToString` helpers append a sign blank to a nonnegative integer. All expected byte values and numeric return codes match. This conflicts with the oracle's presentation, not its byte-section rules; standalone positive integer assignment needs re-measurement before changing the shared conversion.
- Impact on open-steamgate: copying oracle 009 verbatim makes all eight byte-contract assertions fail on formatting.
- Smallest safe workaround: render `sy-subrc` with a string template in the tracked fixture; retain all eight expected strings and every byte operation. Leave shared integer assignment unchanged.
- Upstream issue: none; local validation only, no issue or PR actions authorized.
- Regression-test location: the fixture's eight ABAP Unit methods and its Go/JS row in `tools/gogen/semantics.mjs`.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-02-boolx-logical-argument -- BOOLX's logical argument does not parse as a method parameter

- Status: `workaround`
- Discovery date: `2026-10-02`
- Affected versions: `@abaplint/core 2.120.59`, as resolved by the installed transpiler
- Affected ABAP: `boolx( bool = 1 = 1 bit = 9 )`
- Minimal reproducer: `tools/gogen/testdata/zcl_gogen_t_ipow.clas.testclasses.abap`, method LOGICAL
- Expected SAP behaviour: BOOL takes a logical expression and returns an xstring with the selected bit set when true. This is the [documented contract (SAP keyword documentation, mirrored)](https://eduardocopat.github.io/abap-docs/7.40/abenboole_functions/), not a new A4H measurement.
- Actual abaplint behaviour: the built-in table declares BOOL as CLIKE, and the ordinary method-parameter grammar accepts Source rather than Cond. The comparison inside BOOL is rejected by the parser.
- Impact: otherwise supported logical conditions prevent the owning class from compiling in gogen.
- Smallest safe workaround: gogen wraps BOOL's token-delimited logical expression in BOOLC before parsing and lowers the resulting BOOLX call to a byte-string helper. Comments, literals, nested calls and source line counts are preserved; qualified methods are left alone.
- Upstream issue: no report filed
- Regression tests: `node --test tools/gogen/builtins.test.mjs`; `node tools/gogen/unit.mjs --fixture tools/gogen/testdata --class ZCL_GOGEN_T_IPOW`
- Upstream version containing a fix: unknown

### ANOMALY-2026-10-01-rule-reserved-word -- a table field named RULE builds and runs here and does not activate on a system

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected versions: every version; abaplint and the transpiler check no field name against a system's reserved words
- Affected ABAP statement, runtime API or adapter: a transparent table (`*.tabl.xml`) with a field `RULE`; the same family as `zone-reserved-word`
- Minimal ABAP reproducer: `src/dsl/zosd_l3_alert.tabl.xml` before this date (field `RULE`, key `MANDT, SET_NAME, RULE, MODEL_HASH, CHECK_DATE, ALERT_SEQ`)
- Exact command used to run it: the lead's `node tools/osd-prove-on-system.mjs ... --unit l3demo` on A4H, 2026-10-01
- Expected SAP behaviour: activation refused, "RULE is a reserved word (choose another field name)"; and a warning "Table ZOSD_L3_ALERT: Key length > 120 (restricted functions)"
- Actual open-abap behaviour: the table is created and the L3 runner and its tests pass
- Impact on open-steamgate: L3 could not reach a system
- Smallest safe workaround: the column is `RULE_NAME` and not part of the key (the model hash names the rule); `SET_NAME` is CHAR 16; the key is 102. `tools/osd-ddic-reserved.mjs` (CI: leak-scan.yml) refuses a field named by a public reserved-word list, so the next one is found here
- Upstream issue: none; a system's dictionary rule, not a transpiler defect
- Regression-test location: `test/ddic-reserved.mjs`; `test/dsl-l3.mjs`
- Upstream version containing a fix: not applicable

### ANOMALY-2026-10-01-assert-equals-table-length-msg -- assert_equals on two tables of different length reports its own text, not MSG

- Status: `open`
- Discovery date: `2026-10-01`
- Affected versions: `oisee/open-abap-core 909179a` (`src/unit/cl_abap_unit_assert.clas.abap`, the table branch of `assert_equals`)
- Affected ABAP statement, runtime API or adapter: `cl_abap_unit_assert=>assert_equals( act = lt_a exp = lt_b msg = '...' )` with `lines( lt_a ) <> lines( lt_b )`
- Minimal ABAP reproducer: the L3 proof's `rerun` method (`src/l3proof/zcl_l3_fleet_proof.clas.testclasses.abap`) against a runner that drops a rule
- Exact command used to run it: `npx mocha test/dsl-l3.mjs`, "a runner that drops a rule"
- Expected SAP behaviour: the failure carries the caller's MSG (ABAP Unit shows it as the alert's description), with the difference as detail; not measured on A4H
- Actual open-abap behaviour: the alert text is `Expected table to contain <n> rows, got <m>` and MSG is dropped; equal-length tables that differ do carry MSG
- Impact on open-steamgate: a failing table comparison says how it differs but not which check failed; the test still fails
- Smallest safe workaround: none needed; `test/dsl-l3.mjs` accepts either text for that mutant
- Upstream issue: none yet (open-abap-core; for the lead)
- Regression-test location: `test/dsl-l3.mjs`, "a runner that drops a rule"
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-01-assert-differs-never-fails -- open-abap-core's cl_abap_unit_assert=>assert_differs passes on equal values

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected versions: `oisee/open-abap-core 909179a`; at `8b397be` (#372, open-abap-core#1279) the invalid-UTF-8, byte-offset and lower-case-encoding fixtures pass, and the marks in `cases.json` say which still miss. Still open at `8b397be`: a declaration with one byte cut out of it (`xml_decl_lowercase_utf8` under the drop-a-boundary-byte mutant) ends the run with `CONVT_NO_NUMBER` instead of a parse error, so that mutant leaves the fixture out and upstream `open-abap/open-abap-core` main at `9959c70`
- Affected ABAP statement, runtime API or adapter: `cl_abap_unit_assert=>assert_differs( act = x exp = x )`
- Minimal ABAP reproducer: `cl_abap_unit_assert=>assert_differs( act = 1 exp = 1 ).` in any test method: the method passes
- Exact command used to run it: found by the sXML contract's mutant test (`test/unit/zcl_osd_sxml_contract_test`, `mutant_decode_per_chunk`): a loop of `assert_differs( act = split exp = whole )` passed over two rows whose split was `whole`
- Expected SAP behaviour: the assertion fails when ACT equals EXP
- Actual open-abap behaviour: the method calls `assert_equals`, raises `kernel_cx_assert` when it did not fail, and its own `CATCH kernel_cx_assert. RETURN.` catches that raise as well, so it never fails
- Impact on open-steamgate: every `assert_differs` in the tree is a check that cannot fail here (eight files used it on 2026-10-01); a green run says nothing about them
- Smallest safe workaround: `IF act = exp. cl_abap_unit_assert=>fail( ... ). ENDIF.`, as the sXML contract test does
- Upstream issue: none yet, needs an issue (open-abap-core; for the lead)
- Regression-test location: none in this tree yet; the sXML contract test avoids the method
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-01-sxml-reader-vs-a4h -- CL_SXML_STRING_READER of the pinned fork against A4H

- Status: `open`
- Discovery date: `2026-10-01`
- Affected versions: `oisee/open-abap-core 909179a` (pinned in `libs.lock.json`)
- Affected ABAP statement, runtime API or adapter: `cl_sxml_string_reader=>create( )`, `if_sxml_reader->next_node( )` / `next_attribute( )`, `cx_sxml_parse_error-xml_offset`
- Minimal ABAP reproducer: the fixtures with `fork: MISS` or `DUMPS` in `test/fixtures/sxml-contract/cases.json`, run by `test/unit/zcl_osd_sxml_contract_test` (`reference_concat`); on A4H by `test/fixtures/sxml-contract/recorder.abap`
- Exact command used to run it: `npm run unit` (the reference test asserts the fork misses exactly the fixtures marked MISS); `node tools/osd-sxml-contract.mjs provisional` re-derives the marks
- Expected SAP behaviour (measured on A4H 2026-10-01 by the lead and stoker, except where marked as derived from XML 1.0 / JSON-XML): `xml_offset` is a byte offset (`<a>`+e acute+euro+`</b>`: 8, the start of the wrong close tag; `<a x="`+two e acute+`<"/>`: 6, the start of the value); text and CDATA next to each other are ONE value; invalid UTF-8 in text is replaced, not raised (80: one FFFD; C0 AF: one FFFD; E2 82 before a letter: two FFFD; E2 82 or F0 9F 98 directly before `<`: a parse error at the `<`; ED A0 80: a lone D800 passed through); a byte FF inside a comment is ignored; `encoding="utf-8"` in lower case is accepted; derived: `&#128512;` is the pair D83D DE00; a JSON document read with `next_node` ends in `co_nt_final` and a member's key is its attribute `name`
- Actual open-abap behaviour: offsets count characters and point after the close tag (9 and 8 for the two cases); text and CDATA are two values; any invalid UTF-8 anywhere raises `CX_SY_CONVERSION_CODEPAGE` in `create( )`; lower-case `utf-8` ends the run with the runtime error CONVT_NO_NUMBER in `cl_abap_conv_in_ce=>create`, which no CATCH sees; `&#128512;` becomes F600 (`uccpi` keeps 16 bits); JSON through `next_node` never reports `co_nt_final` (the last close element repeats) and `next_attribute` gives no `name` attribute
- Impact on open-steamgate: an sXML consumer here sees other values, offsets and errors than on a system; the streaming readers (stoker) are written against the A4H behaviour, so the fork's reader is not their oracle
- Smallest safe workaround: none; the contract records the A4H behaviour and marks the fork's misses
- Upstream issue: none yet, needs an issue or a fork fix (open-abap-core; for the lead, after the A4H recording confirms the derived parts)
- Regression-test location: `test/unit/zcl_osd_sxml_contract_test.clas.testclasses.abap` (`reference_concat`)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-01-sxml-stream-transcoded-offsets -- the streaming sXML parser counted a UTF-16 input's error offsets in its UTF-8 stream, not in the input's own bytes

- Status: `fixed`
- Discovery date: `2026-10-01`
- Affected versions: `ZCL_OSD_SXML_PULL` as first written
- Affected ABAP statement, runtime API or adapter: `cx_sxml_parse_error-xml_offset` of `ZCL_OSD_SXML_PULL` / `ZCL_OSD_SXML_STREAM_READER` for input with a UTF-16 BOM or a declared ISO-8859-1 / US-ASCII
- Minimal ABAP reproducer: `FFFE` then `<a></b>` in UTF-16LE through `ZCL_OSD_SXML_STREAM_READER=>CREATE( )`: the error offset was 3 before the fix (the start of `</b>` in the UTF-8 the input was transcoded to) and is 6 now, as on the system
- Exact command used to run it: `npm run unit`, `test/unit/zcl_osd_sxml_stream_test` (`ltcl_pull->utf16_offset`)
- Expected SAP behaviour: measured on A4H (2026-10-01, `CL_SXML_STRING_READER`): UTF-16 is counted in the input's own bytes, the BOM not counted -- `FFFE` or `FEFF` then `<a></b>` is 6, `<a>` `E9E9` `</b>` is 10 (UTF-8 would be 3 and 7); any other code page is counted in the UTF-8 the system converts it to -- a declared ISO-8859-1 `<a>` `E9` `</b>` after a 43-byte declaration is 48, with `E9E9` 50 (input bytes would be 47 and 48)
- Actual open-abap behaviour: was: every transcoded input counted in its UTF-8, wrong for UTF-16 only. Now: `ZCL_OSD_SXML_PULL` maps a UTF-16 input's offset back to its bytes (2 per character, a surrogate pair 4); ISO-8859-1 / US-ASCII keep the UTF-8 count, as the system does. A US-ASCII byte above 7F is read as U+FFFD, not refused
- Impact on open-steamgate: an error position in a non-UTF-8 document points at the wrong byte; values and events are unaffected
- Smallest safe workaround: none needed for UTF-8 input; for the others, measure the system's offsets with a contract fixture before relying on them
- Upstream issue: none; the parser is this repository's
- Regression-test location: the A4H-recorded transcoded fixtures of the sXML contract (UTF-16LE/BE mismatched close at 6, declared ISO-8859-1 at 48), run against the streaming reader in `ltcl_readers->streaming`; `ltcl_pull->utf16_offset` in `test/unit/zcl_osd_sxml_stream_test.clas.testclasses.abap`
- Upstream version containing a fix: not applicable

### ANOMALY-2026-10-01-find-byte-mode -- FIND ... IN BYTE MODE searches the hex text, and SECTION ... LENGTH loses its target

- Status: `open`
- Discovery date: `2026-10-01`
- Affected versions: the pinned transpiler and runtime (`libs.lock.json`, `oisee/transpiler e34d6a1`)
- Affected ABAP statement, runtime API or adapter: `FIND x IN [SECTION OFFSET o [LENGTH l] OF] xstr IN BYTE MODE MATCH OFFSET m`
- Minimal ABAP reproducer: `FIND iv_byte IN SECTION OFFSET lv_rel LENGTH lv_len OF mv_buf IN BYTE MODE MATCH OFFSET lv_found.` transpiles to `abap.statements.find(lv_len, {..., length: lv_len})`: the LENGTH operand becomes the searched object and the MATCH LENGTH target, and the call fails with `blah.substr is not a function`. Without LENGTH: the runtime runs a regular expression over the hex text of the xstring, so needle `3C` matches the bytes `C3 A3 C3` at a half-byte offset and MATCH OFFSET is that offset / 2, rounded; it also collects every match even though FIND asks for the first.
- Exact command used to run it: found by the streaming sXML parser (now `ZCL_OSD_SXML_PULL`) under `test/unit/zcl_osd_sxml_contract_test` (`ltcl_readers->streaming`); the half-byte match is read off `@abaplint/runtime` `statements/find.js`
- Expected SAP behaviour: LENGTH bounds the section; byte mode matches whole bytes only; the first match ends the search
- Actual open-abap behaviour: as above
- Impact on open-steamgate: a byte-mode FIND can report a needle that is not there, and every FIND costs the whole rest of the section
- Smallest safe workaround: `ZCL_OSD_SXML_PULL` never uses LENGTH, searches small slices that double, and checks every reported match against the bytes before trusting it (`find_slice`)
- Upstream issue: none yet, needs an issue (abaplint/transpiler)
- Regression-test location: `test/unit/zcl_osd_sxml_contract_test.clas.testclasses.abap` (`ltcl_readers->streaming`, through the reader's checked search)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-01-submit-via-job-char-operands -- SUBMIT VIA JOB refused a job name and count in SAP's own CHAR types

- Status: `fixed` (in this repository's lowering; no upstream involved)
- Discovery date: `2026-10-01`
- Affected versions: `tools/osd-narrow-submit.mjs` before this date
- Affected ABAP statement, runtime API or adapter: `SUBMIT <prog> ... VIA JOB lv_jobname NUMBER lv_jobcount AND RETURN` with `lv_jobname TYPE tbtcjob-jobname` (CHAR 32) and `lv_jobcount TYPE tbtcjob-jobcount` (CHAR 8), the types `JOB_OPEN` hands back
- Minimal ABAP reproducer: `test/narrow-submit.mjs`, "takes a job name and count in SAP's own CHAR types"; found by the DSL L3 runner (`src/l2demo/zcl_l3_fleet.clas.abap`, method `submit`)
- Exact command used to run it: `npm run transpile` with the runner in the tree: `osd-build: FAILED: check_syntax, Method parameter type not compatible, IV_JOBNAME`
- Expected SAP behaviour: SUBMIT VIA JOB takes the name and count as character-like data objects; the job FMs' own types are the documented choice
- Actual open-abap behaviour: the lowering passed the operands as they were to `ZCL_OSD_BATCH_REPORT=>SUBMIT_VIA_JOB`, whose parameters are STRING, so a CHAR operand was a type error at the syntax check; only STRING variables (as in `test/integration/zcl_osd_job_e2e_driver`) went through
- Impact on open-steamgate: a program written for a system, with SAP's types, did not build here
- Smallest safe workaround: none needed; the lowering now wraps both operands in `CONV string( )`, as it already did for selection values
- Upstream issue: none; the lowering is this repository's
- Regression-test location: `test/narrow-submit.mjs` (fails without the conversion: `Method parameter type not compatible, IV_JOBNAME`); `test/dsl-l3.mjs` mode P
- Upstream version containing a fix: not applicable

### ANOMALY-2026-10-01-int8-string-sign -- INT8 to STRING puts a negative sign first here, not last as SAP does

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/runtime 2.13.93` (the version pinned here)
- Affected ABAP statement, runtime API or adapter: assigning an `INT8` value to a `STRING`; runtime API equivalent `String.set(Integer8(-3n))`
- Minimal ABAP reproducer: `DATA lv_value TYPE int8 VALUE -3. DATA lv_text TYPE string. lv_text = lv_value.`
- Exact command used to run it: `node --input-type=module -e 'import * as abap from "@abaplint/runtime"; console.log(new abap.types.String().set(new abap.types.Integer8().set(-3n)).get())'`
- Expected SAP behaviour: `lv_text` is `3-`, with the negative sign last. Measured on A4H on 2026-10-01 by another session (execute_abap): INT8 -3 and I -3 to STRING both give `3-`; to C(10) both give `        3-`; in a string template `{ }` both give `-3`
- Actual open-abap behaviour: the INT8 runtime object converts to `-3`, with a leading sign and no trailing blank; the `Integer` runtime object instead converts to `3-`
- Impact on open-steamgate: an integer aggregate alert formatted by a direct INT8-to-STRING assignment agrees with the interpreter only because of this runtime difference and would print incorrectly on a system
- Smallest safe workaround: take the absolute value into INT8, convert that magnitude to STRING and CONDENSE it, then prefix `-` when the aggregate is negative; special-case INT8 minimum because its magnitude is not representable as INT8
- Upstream issue: [abaplint/transpiler#1939](https://github.com/abaplint/transpiler/issues/1939)
- Regression-test location: `test/dsl-l2.mjs`, generated-code shape assertion for both the check and reference test templates (runtime sign placement is not a valid oracle)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-30-numc-short-literal-not-padded -- a short NUMC literal in a WHERE is compared unpadded

- Status: `open`
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/transpiler` and `@abaplint/database-sqlite` as pinned here
- Affected ABAP statement, runtime API or adapter: `SELECT ... WHERE numc_field = '12'` on a column of type NUMC 4 (and the same literal in other comparisons against a NUMC column)
- Minimal ABAP reproducer: found by the DSL L2 agreement test (`test/dsl-l2.mjs`, "field-to-field types and NUMC"): a rule compares a NUMC 4 field with the literal `'12'`; the generated `check` and `check_reference` both returned no rows while the row holds `0012`
- Exact command used to run it: `npx mocha test/dsl-l2.mjs` with the NUMC literal padding in `tools/dsl-l2.mjs` removed
- Expected SAP behaviour: the literal is converted to the column type before the comparison, so `'12'` becomes `'0012'` and the row matches (ABAP conversion rules for NUMC; **not measured on A4H** in this session)
- Actual open-abap behaviour: the SQL compares the text `12` with `0012` and nothing matches
- Impact on open-steamgate: hand-written SELECTs with short NUMC literals find nothing here; the L2 compiler pads NUMC literals to their DDIC length in the model, so generated code is not affected
- Smallest safe workaround: write NUMC literals at their full length
- Upstream issue: not filed
- Regression-test location: `test/dsl-l2.mjs`, "field-to-field types and NUMC" (the ABAP agreement case)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-30-concat-packed-drops-decimals -- `&&` with a packed operand prints 10.5 where a system prints 10.50

- Status: `open`
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/runtime` as pinned here: `packages/runtime/src/operators/concat.ts` (the operand's `get()` is a JavaScript number, so the decimals are gone before the text is made)
- Affected ABAP statement, runtime API or adapter: `lv_text = a && b.` (and string templates' `&&` chains) with an operand of type `p` with decimals
- Minimal ABAP reproducer: found by the DSL L2 agreement test (`test/dsl-l2.mjs`, the synthetic rule over INT and DEC fields, first written with `{m.amt}` in the alert): a field of a table, `DEC 5,2`, holding `10.50`, read by `SELECT` into a structure component of the same type, then `lv_alert = ... && ls-amt.`
- Exact command used to run it: `npx mocha test/dsl-l2.mjs`; by hand, `abap.operators.concat(new abap.types.Packed({length: 3, decimals: 2}).set("10.5"), new abap.types.String().set("x"))` answers `10.5x`, while `string.set(packed)` answers `10.50 `
- Expected SAP behaviour: converting `p` to a string keeps the declared decimals, so the text is `10.50` (ABAP keyword documentation, conversion of `p`; **not measured on A4H** in this session)
- Actual open-abap behaviour: `10.5`. The slice-6 ABAP probe measured direct
  packed-to-STRING assignment as `10.50` for positive `10.50` and
  `10.50-` for negative `-10.50` after `CONDENSE ... NO-GAPS`. Assigning
  through fixed CHAR first gives `10.5` / `-10.5`. The direct runtime API
  `String.set(Packed("10.50"))` likewise gives `10.50 `.
- Impact on open-steamgate: a direct DEC/CURR/QUAN field alert hole still exposes this runtime difference. Slice 6 aggregate holes use a formatter that avoids both conversion paths and are checked against the interpreter by the SUM/MIN/MAX tests.
- Smallest safe workaround: aggregate alerts convert the absolute packed
  accumulator directly to STRING, condense it, then prefix `-` for a negative
  value. This keeps DEC decimals and a leading sign without concatenating a
  packed operand or converting through fixed CHAR. Integer aggregates use the
  magnitude-to-STRING formatter in ANOMALY-2026-10-01-int8-string-sign; direct
  INT8-to-STRING sign placement is a runtime divergence, not a feature.
- Upstream issue: not filed
- Regression-test location: `docs/probes/dsl-l2/zcl_l2_aggregate_probe.clas.testclasses.abap` distinguishes ABAP assignment from the direct API; `test/dsl-l2.mjs` covers aggregate alert text, including a negative DEC minimum
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-07-osgo-session-statics -- Go class state shared between internal sessions

- Status: fixed locally in the Go emitter; Node daemon state remains the separate entry below
- Discovery date: `2026-10-07`
- Affected statement: `CLASS-DATA` and `CLASS_CONSTRUCTOR` in generated Go
- Reproducer: `tools/gogen/fixtures/session-statics/`, eight goroutines with separate zero Sessions
- Exact command: `node --test tools/gogen/session-statics.test.mjs` (Go driver runs with `-race`)
- Expected behaviour: each session reads 42 after initialization and finishes its own 10,000 increments
- Actual behaviour before the fix: package globals shared values and constructor flags; the race detector reports concurrent access in `Ensure_ZCL_RACE_INIT`
- Fix: stable class storage and constructor flags in lazy `abap.Statics` slots selected by `Session.Statics`, inherited attributes in the declaring class's slot. Nil selects private state; serialized HTTP/APC hosts select `ProcessStatics` to retain caches across requests. The host regression test observes counter values 1 then 2 on separate connections.
- Regression location: `tools/gogen/session-statics.test.mjs` and its generated-code Go driver; wired into `gogen.yml`
- Upstream issue: none; this is our Go emitter

### ANOMALY-2026-09-24-daemon-statics -- a daemon's class data is its own session's on a system, and the process's here

- Status: `open` (by design; decision D4 in `docs/abap-daemons.md`)
- Discovery date: `2026-09-24`
- Affected versions: none yet; the daemon host is not built (`docs/abap-daemons.md`, step 5)
- Affected ABAP statement, runtime API or adapter: static attributes read or written from a daemon callback (`CL_ABAP_DAEMON_EXT_BASE` subclasses)
- Minimal ABAP reproducer: `docs/probes/abap-daemons/zcl_osd_t_ddrv.batch_a.testclasses.abap`, method `p01_serial` (the P9 part); the daemon sets `gv_static` in `ON_START`, the driver reads and sets its own copy, the daemon logs its value
- Exact command used to run it: the ABAP Unit driver `ZCL_OSD_T_DDRV` (sources in `docs/probes/abap-daemons/`), run on A4H 2026-09-24 in `$ZOSG_TMP_0060`, all objects deleted afterwards
- Expected SAP behaviour: the starting session reads the static the daemon set as initial, and the daemon keeps its own value after the starting session changed the static (probe P9). A daemon runs in an ABAP session of its own.
- Actual open-abap behaviour: (planned) the daemon runs in the host process and on its thread (model (b) of D4), where class data is shared with every request of the process; a daemon step that reads or writes class data outside the runtime's own classes is a recorded runtime error instead
- Impact on open-steamgate: a daemon that keeps state in class data works on a system and dumps here; that is the intended rule against state that outlives a call
- Smallest safe workaround: keep daemon state in instance attributes or in a table
- Upstream issue: none; this is our design, not a transpiler defect
- Regression-test location: none yet (step 5 of `docs/abap-daemons.md`)
- Upstream version containing a fix: `not applicable`

### ANOMALY-2026-09-24-daemon-creator-program -- a system restricts GET_DAEMON_INFO and ATTACH to the program that called START; the local runtime will not check it at first

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: none yet; the client manager is not built (`docs/abap-daemons.md`, step 5)
- Affected ABAP statement, runtime API or adapter: `CL_ABAP_DAEMON_CLIENT_MANAGER=>GET_DAEMON_INFO`, `=>ATTACH` (and probably `=>STOP`, unmeasured)
- Minimal ABAP reproducer: `docs/probes/abap-daemons/zcl_osd_t_other.clas.abap` called from `zcl_osd_t_ddrv.batch_d1.testclasses.abap`
- Exact command used to run it: the ABAP Unit driver `ZCL_OSD_T_DDRV` (sources in `docs/probes/abap-daemons/`), run on A4H 2026-09-24 in `$ZOSG_TMP_0060`, all objects deleted afterwards
- Expected SAP behaviour: from a program other than the one that called `START` (for a class, its class pool, not the class name), `GET_DAEMON_INFO` returns 0 rows and `ATTACH` + `SEND` raises `CX_ABAP_DAEMON_ERROR` "No access right for program <program>." (probe P6). Inside the daemon itself `GET_DAEMON_INFO` also returns 0 rows. `STOP` from another program was not measured.
- Actual open-abap behaviour: (planned) the transpiled runtime has no way to ask for the calling program, so the local client manager allows every caller until step 5 builds one
- Impact on open-steamgate: code that works here may be refused on a system, notably a generic stop button in the status list
- Smallest safe workaround: call `START`, `ATTACH` and `STOP` of a daemon from one class
- Upstream issue: none yet; a caller-program query belongs to the runtime and would be proposed with the daemon host
- Regression-test location: none yet
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-24-daemon-lazy-restart -- after a re-activation a system restarts a daemon at its next event; we restart it at the generation swap

- Status: `open` (by design; option A of D2 in `docs/abap-daemons.md`)
- Discovery date: `2026-09-24`
- Affected versions: none yet; the swap phase is not built (`docs/abap-daemons.md`, step 6)
- Affected ABAP statement, runtime API or adapter: `ON_BEFORE_RESTART_BY_SYSTEM` / `ON_RESTART` after a changed daemon class is activated
- Minimal ABAP reproducer: `docs/probes/abap-daemons/zcl_osd_t_ddrv.batch_d1.testclasses.abap`, then the daemon class activated with `co_version = 'V2'`, then `batch_d2`
- Exact command used to run it: the ABAP Unit driver `ZCL_OSD_T_DDRV` (sources in `docs/probes/abap-daemons/`), run on A4H 2026-09-24 in `$ZOSG_TMP_0060`, all objects deleted afterwards
- Expected SAP behaviour: nothing happens while the daemon is idle; at its next event (a timer, a message, a stop) `ON_BEFORE_RESTART_BY_SYSTEM( i_code = 202 )` runs in the old load and `ON_RESTART` in the new one, same instance ID (probe P10). A daemon that never gets another event keeps the old load.
- Actual open-abap behaviour: (planned) the old generation's daemons are restarted when the generation is swapped, with the same two callbacks in the same order
- Impact on open-steamgate: the callbacks a daemon sees are the same; only their moment differs, and an idle daemon restarts here and not on a system
- Smallest safe workaround: none needed
- Upstream issue: none; this is our design
- Regression-test location: none yet (`test/daemon.mjs`, demo test 4, planned)
- Upstream version containing a fix: `not applicable`

### ANOMALY-2026-09-24-wait-for-channels-subrc -- WAIT FOR MESSAGING CHANNELS that reaches its time limit sets sy-subrc 8 on a system and 4 here, and a non-positive UP TO asserts here

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/transpiler 2.13.89`, `@abaplint/runtime 2.13.89`, open-abap-core `src/kernel/kernel_push_channels.clas.abap` (current `main`)
- Affected ABAP statement, runtime API or adapter: `WAIT FOR MESSAGING CHANNELS UNTIL <cond> UP TO <n> SECONDS` (every `WAIT FOR ...` transpiles to `KERNEL_PUSH_CHANNELS=>wait`)
- Minimal ABAP reproducer: `docs/probes/abap-daemons/zcl_osd_t_ddrv.batch_p8b.testclasses.abap`, method `p08b_luw`, the `ECHO_ON` step: a session subscribed to a channel sends with `i_suppress_echo = abap_true`, so the condition never becomes true, and waits `UP TO 2 SECONDS`
- Exact command used to run it: the ABAP Unit driver `ZCL_OSD_T_DDRV` (sources in `docs/probes/abap-daemons/`), run on A4H 2026-09-24 in `$ZOSG_TMP_0061`, all objects deleted afterwards
- Expected SAP behaviour: after the time limit `sy-subrc = 8` (probe P8, logged as `ECHO_ON subrc=8`); when the condition is met `sy-subrc = 0` (`ECHO_OFF subrc=0`). A non-positive `UP TO` was not measured.
- Actual open-abap behaviour: `KERNEL_PUSH_CHANNELS=>wait` returns `sy-subrc = 4` at the time limit, and `ASSERT lv_seconds > 0` dumps for an `UP TO` of zero or less (read from the source, not run)
- Impact on open-steamgate: code that branches on `sy-subrc = 8` after a timed-out wait takes the wrong branch locally; nothing here depends on it yet (AMC is step 4 of `docs/abap-daemons.md`)
- Smallest safe workaround: test `sy-subrc <> 0` rather than a specific value
- Upstream issue: none yet; to be proposed to open-abap-core together with the AMC work, after the value for `UP TO 0` is measured
- Regression-test location: none yet (step 4 of `docs/abap-daemons.md`)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-24-zone-reserved-word -- A table field named ZONE (or HANDLER, SECTION, PARAMETER) activates here and not on a system

- Status: `workaround` (ZONE: the table field is renamed in #67, the CDS element in #69, and ZC_OSD_TAXICUBE activates on A4H; HANDLER, SECTION, PARAMETER: the fields and the elements are renamed in #73, and every table and view they were in activates on A4H)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/cli` 2.120.50 (the `npm run lint` pass, `open-abap` syntax version, reports nothing), `@abaplint/core` 2.120.55, `@abaplint/transpiler` 2.13.89 (creates the column)
- Affected ABAP statement, runtime API or adapter: a TABL field, or a CDS element, named like a word the dictionary reserves; here `ZOSD_TAXIFACT-ZONE` (`src/ddic/zosd_taxifact.tabl.xml`) and the element `Zone` of `ZC_OSD_TAXICUBE`; `HANDLER` in `ZOSD_ICF_APC`, `ZOSD_ICF_ASIDE` and `ZOSD_SVC`, `SECTION` in `ZOSD_DB`, `PARAMETER` in `ZSTG_FM_PARAM`; the elements `Handler` of `ZC_OSD_ICF_APC`, `ZC_OSD_ICF_HANDLER` and `ZC_OSD_SERVICE` and `Section` of `ZC_OSD_DATABASE`
- Minimal ABAP reproducer: a transparent table with a field `ZONE` of any type; a CDS view with an element `... as Zone`
- Exact command used to run it: **measured on A4H 2026-09-24** twice. `$ZOSG_TMP_0462` (ultra/demodata): ZOSD_TAXIFACT created over ADT with its eleven fields; activation cancelled with "ZONE is a reserved word (choose another field name)" and "TABL ZOSD_TAXIFACT was not activated" (D0 408). `$ZOSG_TMP_0025` (#67), saving the DDL source over ADT: a table with `zone : abap.char(80)` is not saved, "ZONE is a reserved word (choose another field name)"; the same eleven fields with `pickup_zone` save and activate. A DDIC-based CDS view (`@AbapCatalog.sqlViewName`) over that table with `pickup_zone as Zone` is not saved, "ZONE is a reserved word; choose another word"; a view entity with the same element, "ZONE is a reserved word (choose another field name)"; `pickup_zone as PickupZone` activates. All probes were deleted. `$ZOSG_TMP_0025` also found HANDLER, SECTION and PARAMETER refused in a table (TEXT and LENGTH, also in `TRESE`, accepted) and `Handler` / `Section` refused as view-entity elements. `$ZOSG_TMP_0040` (#73): `ZOSD_SVC` with `handler` is not saved, "HANDLER is a reserved word (choose another field name)"; `ZC_OSD_ICF_HANDLER` with `icfhandler as Handler` is not saved, "HANDLER is a reserved word; choose another word", and `ZC_OSD_DATABASE` with `category as Section`, "SECTION is a reserved word; choose another word" (both DDIC-based views).
- Expected SAP behaviour: neither the table nor the view activates. The list is the dictionary table `TRESE` (453 names on A4H; `ZONE` carries the source hint `DB6, MSS`)
- Actual open-abap behaviour: abaplint reports nothing, the transpiler creates `"zone"`, and the table, the CDS cube `ZC_OSD_TAXICUBE` over it and the Analytical List Page work
- Impact on open-steamgate: ZOSD_TAXIFACT, and with it the taxi cube and page, could not be deployed to a system. The table field is now `PICKUP_ZONE` (#67) and the cube's element `PickupZone` (`pickup_zone as PickupZone`), so the OData property is `PICKUPZONE`; the page's annotations, its e2e test and the taxi bench follow it. The demo's OData has no outside consumers, so a system that activates the cube was put before the old property name (decided 2026-09-24). Measured on A4H after the rename (`$ZOSG_TMP_0026`): ZOSD_TAXIFACT with `PICKUP_ZONE` and ZC_OSD_TAXICUBE / ZVOSDTAXICUBE with this tree's source (without `@OData.publish`, which would register a service) activate, and a Data Preview `SELECT PickupZone, SUM( Trips ) ... GROUP BY PickupZone` answers; both were deleted. The same for the other three words (#73): the table fields are `ZOSD_ICF_APC-CLASS_NAME` (SAPC's own name for it), `ZOSD_ICF_ASIDE-ICF_HANDLER`, `ZOSD_SVC-HANDLER_NAME` (a DPC, a handler class, an APC class or an app id), `ZOSD_DB-CATEGORY` and `ZSTG_FM_PARAM-PARAM_NAME`; the elements are `ClassName`, `IcfHandler` (`ZC_OSD_ICF_HANDLER`, like its `IcfName`/`IcfOrder`/`IcfTyp`), `HandlerName` and `Category`, and the OData properties of ZOSD_ICF_SRV and ZOSD_STATUS_SRV follow them (the Fiori pages are annotation-driven from the YAML; the zvdb pack page and the preview e2e read `Category`). `ModuleParameterSet` keeps its property `Parameter`: it is table-mapped, not a CDS element, and only its `sap:label` changes. The JSON the hosts post to `/sap/bc/osd/status/` keeps its keys `handler` and `section`. Measured on A4H (`$ZOSG_TMP_0040`): the five tables and the four DDIC-based views with this tree's sources activate (the views only warn "DDIC-based CDS views are obsolete", `ZC_OSD_ICF_HANDLER` also that ICFTYP is not in its key) and a Data Preview of each view answers with the new column; all deleted. The structures with COUNT, FILE, PACKAGE, ROWCOUNT and RULE (`ZOSD_TYPE_S`, `ZOSD_OBJECT_S`, `ZOSD_SQLTRACE_S`, `ZOSD_ISSUE_S`) are left as they are: a structure has no database table, and among the dictionary objects A4H activated since 2024-01-01 (DD03L joined to DD02L, active version) these names occur in structures only, never in a transparent table: COUNT in 23 structures, FILE 1, PACKAGE 9, ROWCOUNT 2, RULE 2, and PARAMETER 39, HANDLER 1, SECTION 1; a structure of ours could not be activated directly, because vsp creates only transparent tables
- Smallest safe workaround: the renames above. DuckDB files made before it are migrated at boot and by the import (`tools/osd-db-migrate.mjs`, one transaction), **one way**: a build from before the rename cannot read a migrated file (its first `SELECT zone` fails). Views the running build does not have are logged and left, and one of them that names `zone` breaks. A kept HANA schema is not migrated and is refused at boot with the way out (`STG_DB_FRESH=1`); the stamped backends rebuild or set the file aside by their own drift policy. **The migration covers DuckDB only.** A SQLite file (`STG_DB=file`, `STG_DB_PATH` with SQLite) that sees this DDIC drift is moved aside to `*.drift` and the system starts empty: the module signatures imported into `ZSTG_FM_PARAM` and the records in `ZOSD_ICF_ASIDE` are not carried over. The way back is `POST FunctionGroupSet` with the same `*.fugr.xml` again; the aside records are kept in the `*.drift` file only and are not restored by anything (they are written again only when an object next replaces an edited ICF row)
- Upstream issue: [abaplint/abaplint#4331](https://github.com/abaplint/abaplint/issues/4331), filed 2026-09-24: abaplint's `cds_check_syntax` already refuses BEGIN, NUMBER and POSITION; the issue asks for ZONE, HANDLER and SECTION there and a TABL field counterpart
- Regression-test location: `test/db-migrate.mjs` (the migration, including a renamed key column), `test/taxi-import.mjs` (an import into an old-shaped file), `test/reserved-words.mjs` (no field of an own transparent table and no CDS element is one of the names A4H was seen refusing: ZONE, HANDLER, SECTION, PARAMETER; checked failing on the tree before the renames)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-24-delete-adjacent-default-key -- DELETE ADJACENT DUPLICATES without COMPARING compares whole rows, where a system compares the primary key

- Status: `fixed upstream: abaplint/transpiler#1892, merged 2026-09-24, not yet in a release`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 as this tree pins it, and every release up to the one that ships #1892 (`packages/runtime/src/statements/delete_internal.ts`: without `COMPARING`, the whole row was compared)
- Affected ABAP statement, runtime API or adapter: `DELETE ADJACENT DUPLICATES FROM itab` without `COMPARING`, on any table whose primary key is not the whole row: a structure `WITH DEFAULT KEY` (or `TYPE TABLE OF` with no key clause), a user key, a sorted key, an empty key
- Minimal ABAP reproducer:

```abap
TYPES: BEGIN OF ty_row,
         c TYPE c LENGTH 2,
         i TYPE i,
       END OF ty_row.
DATA tab TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
DATA row TYPE ty_row.
APPEND row TO tab.
row-i = 7.
APPEND row TO tab.
DELETE ADJACENT DUPLICATES FROM tab.
WRITE / lines( tab ).   " system: 1 -- runtime before #1892: 2
```

- Exact command used to run it: first seen with `ZCL_OSD_DEMO_TAXI`'s grain test (`$ZOSG_TMP_0462`, ultra/demodata): rows (a,2) (a,1) (b,1) of `c(1), i`, `SORT` then `DELETE ADJACENT DUPLICATES`, 2 lines on an ABAP 7.5x system and 3 here. The rule was then measured with ABAP Unit probes on the same ABAP 7.5x system in `$ZOSG_TMP_0030` and `$ZOSG_TMP_0031` (deleted after): two rows that differ in one component only, then `DELETE ADJACENT DUPLICATES FROM tab`; two lines left means the component is in the key.

| Component type | Lines left | In the default key |
| --- | ---: | --- |
| `c`, `n`, `d`, `t` | 2 | yes |
| `string` | 2 | yes |
| `x`, `xstring` | 2 | yes |
| `i`, `int1`, `int2`, `int8` | 1 | no |
| `p`, `f`, `decfloat16`, `decfloat34` | 1 | no |
| `utclong` | 1 | no |
| `c` inside a substructure | 2 | yes, substructures are expanded |
| `i` inside a substructure | 1 | no |
| table component | 1 | no |
| `REF TO data`, `REF TO object` | 1 | no |
| `c` from `INCLUDE TYPE` | 2 | yes |

| Case | System | Runtime before #1892 |
| --- | --- | --- |
| `TYPE TABLE OF ty_row` (no key clause), rows differ in `i` only | 1 line | 2 |
| Only numeric components, `WITH DEFAULT KEY`, two identical rows | 2 lines, nothing deleted | 1 |
| `WITH EMPTY KEY`, two identical rows | 2 lines, nothing deleted | 1 |
| `WITH NON-UNIQUE KEY i`, rows (0,''), (0,'AB'), (5,'AB') | 2 | 3 |
| `SORTED ... WITH NON-UNIQUE KEY c`, rows differ in `n`, then in `c` | 2 | 3 |
| `WITH NON-UNIQUE KEY table_line` | whole row compared | same |
| elementary `STANDARD TABLE OF i`, 1 1 2 1 | 3 | same |

- Expected SAP behaviour: without `COMPARING` only the primary key is compared. The standard key of a structured row is its character-like and byte-like components (`c`, `n`, `d`, `t`, `string`, `x`, `xstring`), with substructures and includes expanded; `i`/`int1`/`int2`/`int8`, `p`, `f`, `decfloat16`/`decfloat34`, `utclong`, table and reference components are not in it. An empty key (a row of numeric components only, or `WITH EMPTY KEY`) deletes nothing, not even identical rows; the syntax check warns "table with an empty primary key"
- Actual open-abap behaviour: before #1892 the runtime compared whole rows, whatever the key, so rows differing only outside the key stayed and an empty key deleted identical rows
- Impact on open-steamgate: found by `ZCL_OSD_DEMO_TAXI`'s grain test, which passed here and failed on the system; the test now sorts and compares by every component explicitly, which both answer alike. Any ABAP relying on the default key to drop rows that differ in an amount or a count keeps them here
- Smallest safe workaround: name the key: `SORT ... BY` and `COMPARING <components>` (or `COMPARING ALL FIELDS` where the whole row is meant)
- Upstream issue: fixed by [abaplint/transpiler#1892](https://github.com/abaplint/transpiler/pull/1892), merged 2026-09-24 (branch `delete-adjacent-default-key`): without `COMPARING`, rows are reduced to their primary key (the given `keyFields`, else the standard key above; `keyType` EMPTY or a standard key with no components deletes nothing). Two callers relied on the old whole-row compare and keep it through an explicit `allFields: true`: `COMPARING ALL FIELDS`, which was transpiled like the plain form, and the duplicate removal after `FOR ALL ENTRIES` (`statements/select.ts`), which passed a `by` the runtime ignored. Not covered: `USING KEY` on the statement is still ignored, and a row type that is itself a table type (empty standard key) is still compared as a whole row
- Relation to ANOMALY-2026-09-24-sort-default-key (ultra/parity-wave1, not on main yet): both measurements agree that a system uses the standard key for `SORT` and `DELETE ADJACENT DUPLICATES` alike. That entry measures the runtime's `SORT` without `BY` on a table of structures as leaving the order unchanged (whole rows compared with `lt`), which contradicts this entry's first version, where the taxi rows came out of `SORT` in the same order on both sides; that agreement was the rows' order, not the runtime sorting by the default key. The key rule measured here (character-like and byte-like components) is wider than what sort-default-key measured (`c` and `string`); the rule of that entry is left to it
- Regression-test location: upstream, `test/statements/delete_internal.ts` (six cases from the tables above), `test/database.ts` ("FOR ALL ENTRIES, duplicates removed comparing all fields, not the key"), `packages/transpiler/test/single_statements.ts` (`COMPARING ALL FIELDS` emits `allFields: true`); here `src/demo_data/zcl_osd_demo_taxi.clas.testclasses.abap` (`grain_and_marks`) uses the portable form, and no test pins the anomaly
- Upstream version containing a fix: `unknown` (merged, not yet released)

### ANOMALY-2026-09-24-httpc-body-latin1 -- open-abap-core's `CL_HTTP_CLIENT` sends the request body one byte per UTF-16 code unit; a system sends UTF-8, whatever charset the request names

- Status: `fixed upstream: open-abap/open-abap-core#1268, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: open, **measured on an ABAP 7.5x system 2026-09-24** (the Go host of tools/gogen does what Node does, on purpose: Node is its oracle)
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core 4eec777 (still in 3f22182) (`src/http/cl_http_client.clas.abap`, `IF_HTTP_CLIENT~SEND`: `req.write(requestBody, "binary")` of `get_cdata( )`, `content-length` from `lv_body.get().length`)
- Affected ABAP statement, runtime API or adapter: `IF_HTTP_CLIENT~SEND` with a body set by `request->set_cdata( )`; `request->get_cdata( )` after `request->set_data( )`
- Minimal ABAP reproducer: `docs/probes/httpc/zcl_osd_t_httpc_body.testclasses.abap`, `zcl_osd_t_httpc_body2.testclasses.abap`, `zcl_osd_t_httpc_cs.testclasses.abap` (over `zcl_osd_t_httpc.clas.abap` and `z_osd_t_httpc_sleep.func.abap`); on Node, case `post-nonlatin` of `tools/gogen/httpc.mjs` (spike/go-backend)
- Exact command used to run it: the probe classes as ABAP Unit on an ABAP 7.5x system; every request went to the system's own ICM on localhost, logged on with an assertion ticket. The text is `a`, e-acute, euro sign, `z`. Two receivers: `/sap/bc/abap/demo_post?input=X` (SAP's demo handler, answers the body's `&`-parts, but its `unescape_url` turns every non-ASCII character into `#`, so it only counts characters) and `/sap/bc/soap/rfc` calling a probe RFC module that answers the text the SOAP runtime decoded, as UTF-8 (`EV_HEX`). The SOAP receiver decodes UTF-8 whatever the header's charset says (calibrated by posting known UTF-8 bytes with `set_data` under `charset=iso-8859-1`: it answered the text unchanged)
- Expected SAP behaviour, as measured: `set_cdata` puts UTF-8 into the entity and that is what goes out. `request->get_data( )` is `61C3A9E282AC7A` right after `set_cdata` and again after `SEND`, under `text/plain; charset=utf-8`, `text/plain`, no content type at all, `text/plain; charset=iso-8859-1` set before `set_cdata` and set after it, `text/plain;charset=ISO-8859-1`, `charset=windows-1252`, `charset=utf-16`, and the header set through `set_header_field( 'content-type' )` or `( 'Content-Type' )`. Through SOAP the four cases posted that way (charset utf-8, iso-8859-1 set before and after `set_cdata`, none) each arrived as the same four characters (`EV_HEX` = base64 `YcOp4oKseg==` = `61C3A9E282AC7A`) and the envelope parsed whole; windows-1252, utf-16 and the `set_header_field` spellings were seen as `get_data` bytes only. An emoji is `F09F9880` (`61F09F98807A`) and reaches demo_post as two characters, one surrogate pair. So the charset parameter of the request does **not** change the bytes on this system; the entry's first version ("in the entity's code page, UTF-8 by default") was half right. `set_data( '61E97A' )` (not UTF-8): `get_data` keeps the three bytes, nothing raises, and the receiver decoding UTF-8 got an empty body (the bytes on the wire were not captured). `request->get_cdata( )` after `set_data` decodes UTF-8 (`41C3A9` gives `Aé`) and gives an **empty string** for bytes that are not UTF-8 (`61E97A`, under no charset, utf-8 and iso-8859-1 alike), not an exception. `Content-Length` of the wire was not seen directly (no raw echo was available); the SOAP envelope arriving whole is consistent with a byte count
- Actual open-abap behaviour: the euro sign goes out as the single byte `AC` (each UTF-16 code unit written as its low byte), `content-length` counts UTF-16 code units, so a non-Latin-1 body is both corrupted and cut short; a body `set_data` filled with bytes that are not UTF-8 raises `CX_SY_CONVERSION_CODEPAGE` in `get_cdata` before anything is sent
- Impact on open-steamgate: any request body outside Latin-1 is corrupted on the wire; ZCL_OSD_GIT's upload-pack request is ASCII and is not affected
- Smallest safe workaround: none in OSG (a caller can `set_data( cl_abap_codepage=>convert_to( text ) )` itself, which is what a system does anyway)
- Upstream: [open-abap/open-abap-core#1268](https://github.com/open-abap/open-abap-core/pull/1268) (branch `httpc-body-utf8`), opened 2026-09-25, not merged at the time: send the bytes of `request->get_data( )`, which are UTF-8 for a `set_cdata` body, with `content-length` from their length; `get_cdata` of bytes that are not UTF-8 answers empty. Fixed upstream by [open-abap/open-abap-core#1268](https://github.com/open-abap/open-abap-core/pull/1268), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Regression-test location: `tools/gogen/httpc.mjs` on spike/go-backend (Node and Go compared, not against a system); the system side is the probe sources above
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-httpc-failure-dumps -- a failed `CL_HTTP_CLIENT` request is an uncatchable error on Node; a system returns from SEND and fails RECEIVE with a classic exception

- Status: `fixed upstream: open-abap/open-abap-core#1271, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: open, **measured on an ABAP 7.5x system 2026-09-24** (the Go host dumps where Node does)
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core 4eec777 (still in 3f22182) (`IF_HTTP_CLIENT~SEND`: the promise rejects out of a `WRITE '@KERNEL'` line; `SEND` and `RECEIVE` end in `sy-subrc = 0. " workaround for classic exceptions`; `GET_LAST_ERROR` answers the status code and `'todo_open_abap'`)
- Affected ABAP statement, runtime API or adapter: `client->send( EXCEPTIONS http_communication_failure = 1 http_invalid_state = 2 http_processing_failed = 3 ... )`, `client->receive( EXCEPTIONS ... )`, `client->get_last_error( )`
- Minimal ABAP reproducer: `docs/probes/httpc/zcl_osd_t_httpc_misc.testclasses.abap`, methods `f1`-`f7`; on Node, cases `refused`, `tls-to-plain`, `bad-scheme`, `header-newline` of `tools/gogen/httpc.mjs` (spike/go-backend)
- Exact command used to run it: the probe class as ABAP Unit on an ABAP 7.5x system, each call inside `TRY ... CATCH cx_root` as well as with `EXCEPTIONS`
- Expected SAP behaviour, as measured: no class-based exception in any case (the `CATCH cx_root` never fired) and no dump. A connection failure is **not** reported by `SEND`, which returns sy-subrc 0; it is `RECEIVE` that ends with `http_communication_failure` (sy-subrc 1, message 00 001 carrying the text), and the response then holds a status and an HTML error page that the ICM made up as the client:

| Case | SEND | RECEIVE | `get_last_error` code / message | `get_status` |
| --- | ---: | ---: | --- | --- |
| connection refused (`http://localhost:1/x`) | 0 | 1 | 411 / `Direct connect to localhost:1 failed: NIECONN_REFUSED(-10)` | 404 `Connection Refused` |
| `https://` to a plain HTTP port | 0 | 1 | 407 / `SSL handshake with localhost:<port> failed: SSSLRC_NO_SSL_RESPONSE (-75)` + the SSL library's explanation | 500 `Native SSL Error` |
| method `GE T` | 0 | 1 | 405 / `Error in HTTP Request: Invalid request line (9); request line: GE T /sap/bc/abap/demo_post HTTP/1.0` | 400 `Bad Request` |
| header value with a newline | 1 (message SHTTP 864) | 2 (SHTTP 862) | after SEND 46 / `46 -Fehlercode beim Senden der Daten.` (the kernel's text, German on that system); after RECEIVE 1001 / `Invalid http state.` | 46, then 1001, empty reason |
| `RECEIVE` without `SEND` | -- | 2 (SHTTP 862) | 1001 / `Invalid http state.` | -- |
| `ftp://` URL | `create_by_url` sy-subrc 1 (`argument_not_found`), no client | | | |
| header name with a space | 0 | 0 | sent as is, the server answered 200 | 200 |

- Actual open-abap behaviour: a JavaScript error no `CATCH` takes (a dump) for the refused, TLS, scheme and header-newline cases; the classic exceptions are never raised and sy-subrc is 0 whenever the call returns; `get_last_error` has no message
- Impact on open-steamgate: ZCL_OSD_GIT (and any client) cannot report an unreachable remote; the dialog step dumps; our own calls had no `EXCEPTIONS` either, so ZCL_OSD_GIT dumped on a system too and needed `EXCEPTIONS http_communication_failure = 1 ...` on its SEND/RECEIVE whatever upstream does. It has them now (`ZCL_OSD_GIT=>EXCHANGE`, PR #84): on a system an unreachable remote is a `zcx_abapgit_exception` with `get_last_error`'s text; here it still dumps until the upstream fix
- Smallest safe workaround: `EXCEPTIONS` on every SEND and RECEIVE of our own ABAP (ZCL_OSD_GIT has them); it is right on a system and changes nothing here until the upstream fix
- Upstream: [open-abap/open-abap-core#1271](https://github.com/open-abap/open-abap-core/pull/1271) (branch `httpc-communication-failure`), opened 2026-09-25, not merged at the time: catch the request's error in `SEND`, keep it, and let `RECEIVE` set sy-subrc 1 with the message in `get_last_error`; the response status the ICM invents (404/500/400) is secondary. Classic exceptions from a method in the transpiler are the underlying gap the source comment names. Fixed upstream by [open-abap/open-abap-core#1271](https://github.com/open-abap/open-abap-core/pull/1271), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Regression-test location: `tools/gogen/httpc.mjs` on spike/go-backend; the system side is the probe source above
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-httpc-timeout-ignored -- `SEND`'s `TIMEOUT` is ignored by open-abap-core's `CL_HTTP_CLIENT`; a system ends RECEIVE after that many seconds

- Status: `open`, **measured on an ABAP 7.5x system 2026-09-24** (the Go host ignores it as well)
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core 4eec777 (still in 3f22182) (`IF_HTTP_CLIENT~SEND` never reads `timeout`; no timeout is set on the Node request or its agent)
- Affected ABAP statement, runtime API or adapter: `client->send( timeout = n )`
- Minimal ABAP reproducer: `docs/probes/httpc/zcl_osd_t_httpc_time.testclasses.abap`, methods `t0`-`t5`
- Exact command used to run it: the probe class as ABAP Unit on an ABAP 7.5x system against the system's own `/sap/bc/soap/rfc` calling a probe RFC module that waits a given number of seconds (at most 10); elapsed time from `GET TIME STAMP` around `SEND` + `RECEIVE`
- Expected SAP behaviour, as measured: `if_http_client=>co_timeout_default` is 0 and `co_timeout_infinite` is -1. `send( timeout = 2 )` against a 6-second answer: `SEND` sy-subrc 0, `RECEIVE` sy-subrc 1 (`http_communication_failure`, message 00 001) after 2054 ms, `get_last_error` 402 / `Connection to partner timed out after 2s.`, `get_status` 500 `Internal Server Error` with an ICM error page. `timeout = 10` against 3 s: answered in 3014 ms; `timeout = 0` (default) against 3 s: 3013 ms; `timeout = -1` against 2 s: 2014 ms. `timeout = -5`: `SEND` sy-subrc 4 (`http_invalid_timeout`, message SHTTP 865), nothing sent; the following `RECEIVE` sy-subrc 1 (SHTTP 864), `get_last_error` 17 / `Internal error. Handle for this http session was not found or is NULL.` The default timeout's own length (a profile value) was not measured
- Actual open-abap behaviour: the request waits as long as the socket stays open, whatever `timeout` says; an invalid value is not refused
- Impact on open-steamgate: a remote that hangs hangs the dialog step
- Smallest safe workaround: none in OSG
- Upstream: [open-abap/open-abap-core#1272](https://github.com/open-abap/open-abap-core/issues/1272), filed 2026-09-25 (the fix follows #1271): a positive `timeout` as a socket timeout on the request, surfacing at `RECEIVE` as `http_communication_failure` (together with the failure entry above); a value below -1 is `http_invalid_timeout` from `SEND`
- Regression-test location: none here (no timing test); the system side is the probe source above
- Upstream version containing a fix: none yet


### ANOMALY-2026-09-24-httpc-status-code-field -- the response of open-abap-core's `CL_HTTP_CLIENT` has no `~status_code` header field; a system's has it and five more pseudo fields

- Status: `fixed upstream: open-abap/open-abap-core#1269, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: open, **measured on an ABAP 7.5x system 2026-09-24** (the Go host does the same)
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core 4eec777 (still in 3f22182) (`IF_HTTP_CLIENT~SEND` sets `mv_status` and the header fields Node returns; no pseudo field)
- Affected ABAP statement, runtime API or adapter: `client->response->get_header_field( '~status_code' )`, `~status_reason`, `~server_protocol`, `get_header_fields( )`; `get_status( )` itself answers on both
- Minimal ABAP reproducer: `docs/probes/httpc/zcl_osd_t_httpc_misc.testclasses.abap`, methods `s1`-`s4` (every probe call prints `get_status( )`, the three fields and the names of all `~` fields); on Node, case `status-500` of `tools/gogen/httpc.mjs` (spike/go-backend)
- Exact command used to run it: the probe classes as ABAP Unit on an ABAP 7.5x system
- Expected SAP behaviour, as measured: after a `RECEIVE` that got an answer, `get_header_fields( )` lists `~response_line`, `~server_protocol`, `~status_code`, `~status_reason`, `~remote_addr`, `~uri_scheme_expanded` (after the timeout only the first four), and `~status_code` / `~status_reason` agree with `get_status( )` in every case seen: 200 `OK`, 401 `Unauthorized`, 403 `Forbidden`, 404 `Not found`, 500 `Soap document processing failed`, and the ICM's own 404 `Connection Refused`, 500 `Native SSL Error`, 400 `Bad Request`, 500 `Internal Server Error` of the failure entries. `~server_protocol` was `HTTP/1.0` against this system's own ICM. When `SEND` itself failed (a header with a newline), the three fields are empty and `get_status( )` answers the last error code (46, then 1001) with an empty reason
- Actual open-abap behaviour: `~status_code`, `~status_reason` and `~server_protocol` are empty and `get_header_fields( )` has no `~` field; `get_status( )` gives the code and an empty reason
- Impact on open-steamgate: ZCL_OSD_GIT's 4xx/5xx check read `~status_code` and never fired, on Node or on OSGo, so an error answer was parsed as refs
- Smallest safe workaround: read `get_status( )` instead, in the ABAP that is ours: ZCL_OSD_GIT does since PR #84 and refuses anything but a 2xx (a 3xx with its `Location`), and an advertisement that is not `application/x-git-upload-pack-advertisement` (`test/osd-git.mjs`: a 404, a 301 and an HTML page, each red before)
- Upstream: [open-abap/open-abap-core#1269](https://github.com/open-abap/open-abap-core/pull/1269) (branch `httpc-status-fields`), opened 2026-09-25, not merged at the time: set `~status_code`, `~status_reason` (Node's `statusMessage`) and `~server_protocol` on the response, and `get_status`'s reason. Fixed upstream by [open-abap/open-abap-core#1269](https://github.com/open-abap/open-abap-core/pull/1269), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Regression-test location: `tools/gogen/httpc.mjs` on spike/go-backend; the system side is the probe source above
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-httpc-post-url-query -- open-abap-core moves the query of a POST's URL into the body even when the program set a body; a system does that only for a POST without one

- Status: `fixed upstream: open-abap/open-abap-core#1270, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: open, **measured on an ABAP 7.5x system 2026-09-24**; narrowed: the case tools/gogen/httpc.mjs records (query-post, a POST with no body) does on a system what it does here, except the content type (the Go host does the same as Node)
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core 4eec777 (still in 3f22182) (`CREATE_BY_URL` splits the query off into form fields with `cl_http_utility=>set_query`; `SEND` writes the form fields of a POST into the body with `set_cdata`, whether or not a body was set, and sets no content type for them)
- Affected ABAP statement, runtime API or adapter: `cl_http_client=>create_by_url( 'http://h/p?a=1' )` followed by `request->set_method( 'POST' )`, a body or none, and `send( )`
- Minimal ABAP reproducer: `docs/probes/httpc/zcl_osd_t_httpc_misc.testclasses.abap`, methods `q1`-`q4`, and `zcl_osd_t_httpc_time.testclasses.abap`, method `q5`; on Node, case `query-post` of `tools/gogen/httpc.mjs` (spike/go-backend)
- Exact command used to run it: the probe classes as ABAP Unit on an ABAP 7.5x system against SAP's demo handler `/sap/bc/abap/demo_post`, which answers the request's `~QUERY_STRING` (without `input=X`) or the `&`-parts of its body (with `input=X`)
- Expected SAP behaviour, as measured: `create_by_url` keeps only the path in `~request_uri` and leaves `~query_string` empty, as open-abap-core does; the query waits as form fields. At `SEND`:
  - GET: the fields go onto the request line (`~QUERY_STRING` at the server `k=v&z=1`, order kept)
  - POST with a body set by `set_cdata` (`BODY`, `b=1`): the fields go onto the request line (`k=v&z=1`) and the body is sent unchanged
  - POST with no body: the fields become the body (`input=X&k=v` at the server), the request line has no query (`~QUERY_STRING` empty), and the request's `content-type` field reads `application/x-www-form-urlencoded` after `SEND` (while `request->get_data( )` stays empty)
- Actual open-abap behaviour: a POST always gets the fields as its body, replacing a body set before (`set_cdata`), with no query on the request line and no `content-type`
- Impact on open-steamgate: none found (git's smart HTTP puts `?service=` on GETs only)
- Smallest safe workaround: none in OSG
- Upstream: [open-abap/open-abap-core#1270](https://github.com/open-abap/open-abap-core/pull/1270) (branch `httpc-post-query`), opened 2026-09-25, not merged at the time, narrow: when a POST has a body, put the fields on the URL as for GET; when it has none, keep writing them into the body and add `content-type: application/x-www-form-urlencoded` unless one is set. PUT and other methods were not measured. Fixed upstream by [open-abap/open-abap-core#1270](https://github.com/open-abap/open-abap-core/pull/1270), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Regression-test location: `tools/gogen/httpc.mjs` on spike/go-backend; the system side is the probe sources above
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-23-div-mod-negative-divisor — DIV and MOD can be wrong when the divisor is negative

- Status: `reported`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89 on npm, the pinned `oisee/transpiler` 0263e42, and `abaplint/transpiler` main at 6014241 (2026-09-22): `packages/runtime/src/operators/div.ts` and `mod.ts`
- Affected ABAP statement, runtime API or adapter: `DIV` and `MOD` with a negative right operand, for `i`, `int8` and `f`
- Minimal ABAP reproducer:

```abap
DATA d TYPE i.
DATA m TYPE i.
d = 7 DIV -2.    " SAP: -3 -- open-abap: -4
d = -7 DIV -2.   " SAP: 4  -- open-abap: 3
m = 7 MOD -3.    " SAP: 1  -- open-abap: 2
m = -7 MOD -3.   " SAP: 2  -- open-abap: 1
m = 11 MOD -4.   " SAP: 3  -- open-abap: 1
```

- Exact command used to run it: found by the Go backend spike (`tools/gogen/run.mjs` on branch `spike/go-backend`), which compares the transpiled JS against ABAP's documented rules. **Measured on A4H, 2026-09-23**, ABAP Unit probes in throwaway `$` packages. For `i`, `int8` and `f`: `7 DIV -2 = -3`, `-7 DIV -2 = 4`, `6 DIV -2 = -3`, `7 MOD -3 = 1`, `-7 MOD -3 = 2`, `11 MOD -4 = 3`, `-11 MOD -4 = 1`, and `6 MOD -2 = 0` for `i`. For `f` and `p` with fractional operands of both signs (20 pairs): `7.5 MOD -2 = 1.5`, `-7 DIV -2.5 = 3`, `-7.5 DIV 2.5 = -3` with MOD 0, and more. For `f` near the limits of double precision: `0.5 DIV/MOD 0.1 = 5 / 0`, `0.5 DIV/MOD -0.1 = -5 / 0`, `-0.5 DIV/MOD 0.1 = -5 / 0`, `0.3 DIV/MOD 0.1 = 2 / 0.09999999999999998`, `-0.25 DIV/MOD -2^54 = 1 / 2^54`. The measured `f` cases match `MOD = a - b * ( a DIV b )` computed in double precision.
- Expected SAP behaviour: for `i` and `int8`, `a MOD b` lies in `[0, |b|)` for any signs, and `a DIV b` is the quotient that goes with it. For `f`, MOD is `a - b * ( a DIV b )` computed in double precision.
- Actual open-abap behaviour: `div` floors, which is right only for a positive divisor; the `int8` branch applies the same floor (abaplint/transpiler#1411). `mod` computes `((l % r) + r) % r` and takes the absolute value, which gives `|b| - r` for a negative divisor. The only negative divisor in upstream's tests is -2, where `r = |b| - r = 1`. The `f` remainder by `%` also differs from a system for a positive divisor: `0.5 MOD 0.1` is 0.09999999999999998 here and 0 there.
- Impact on open-steamgate: none seen in the served tree yet. Some `DIV` and `MOD` expressions with a negative divisor answer differently (`6 DIV -2` and `6 MOD -2` happen to agree). The ZO4D scenes only use positive divisors, which is why the frame oracle never saw it.
- Smallest safe workaround: none in ABAP; the code is right as written
- Upstream issue: branch `fix/div-mod-negative-divisor` in `abaplint/transpiler` (worktree `.local/lars/transpiler-div`, one commit on origin/main 6014241). `div` rounds up for a negative divisor; for number operands `mod` computes `a - b * ( a DIV b )` with the same quotient rule, and the `int8` branch normalises the bigint remainder. The critic gate and codex (gpt-6-sol) agreed with changes, which are applied. On the i7, `TZ=UTC npm test` with Postgres 16 in Docker: base 2419 passing / 0 failing, patched 2422 / 0 (the three new tests). Filed 2026-09-23: issue [abaplint/transpiler#1884](https://github.com/abaplint/transpiler/issues/1884), PR [#1885](https://github.com/abaplint/transpiler/pull/1885) from the branch inside the repository, and Regression runs on it.
- Regression-test location: upstream `test/operators/arithmetics.ts` ("DIV and MOD, negative divisor", "…, float") and `test/types/integer8.ts`; locally the Go spike's semantic table in `tools/gogen/run.mjs`
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-23-mod-packed-drops-fraction — MOD with packed operands returns an integer

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89, `abaplint/transpiler` main at 6014241: `packages/runtime/src/operators/mod.ts`, which answers a `Float` only when an operand is `Float` and an `Integer` otherwise
- Affected ABAP statement, runtime API or adapter: `MOD` where an operand is `p` with decimals
- Minimal ABAP reproducer:

```abap
DATA a TYPE p LENGTH 8 DECIMALS 2.
DATA m TYPE p LENGTH 8 DECIMALS 2.
a = '7.5'.
m = a MOD 2.     " SAP: 1.50 -- open-abap: 2.00
```

- Exact command used to run it: **measured on A4H 2026-09-23** in the same fractional probe as the entry above: all ten `p` pairs agree with `f` on the system (`7.5 MOD 2 = 1.5`, `-7.5 MOD -2 = 0.5`, `7 MOD -2.5 = 2`, …). The runtime rounds the remainder into an `Integer`: `7.5 MOD 2` gives 2, `-7 MOD 2.5` gives 1. The checked positive-divisor `DIV` cases with `p` agree; with a negative divisor `DIV` has the defect of the entry above.
- Expected SAP behaviour: with calculation type `p`, the remainder keeps its decimals
- Actual open-abap behaviour: the remainder is stored in an `Integer` and rounded
- Impact on open-steamgate: none seen yet; `MOD` on packed fields with a fractional remainder and no `f` operand
- Smallest safe workaround: none in ABAP
- Upstream issue: not filed. It is a separate defect from the sign rule above, so it gets its own branch and PR after that one: `mod` should answer a `Packed` when an operand is packed, the way the other operators do
- Regression-test location: none yet
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-23-f-to-i-no-overflow — An f too large for i is stored instead of raising

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89 and `abaplint/transpiler` main at 6014241: `packages/runtime/src/types/integer.ts`, whose range check at the end of `set()` is commented out
- Affected ABAP statement, runtime API or adapter: assignment of an out-of-range `f` to an `i`
- Minimal ABAP reproducer:

```abap
DATA f TYPE f VALUE '3000000000'.
DATA i TYPE i.
i = f.           " SAP: CX_SY_CONVERSION_OVERFLOW -- open-abap: 3000000000
```

- Exact command used to run it: found by the Go backend spike's semantic table. **Measured on A4H 2026-09-23**, ABAP Unit: inline, and through a method that declares `RAISING cx_sy_conversion_overflow`, both `3e9` and `-3e9` raise `CX_SY_CONVERSION_OVERFLOW`. Through a method that does not declare it, the caller sees `CX_SY_NO_HANDLER`.
- Expected SAP behaviour: `CX_SY_CONVERSION_OVERFLOW`, catchable
- Actual open-abap behaviour: the `Integer` holds 3000000000, a value no `i` can hold, and nothing is raised
- Impact on open-steamgate: none seen yet; wrong silently instead of loudly
- Smallest safe workaround: none
- Upstream issue: not filed, and no PR, on purpose. The range check in `Integer.set` was commented out upstream, and the same `set()` receives the results of integer arithmetic, where a system raises `CX_SY_ARITHMETIC_OVERFLOW` and not the conversion error. Arithmetic overflow into `i` needs its own measured test before choosing where to enforce the range, so this goes to Lars as a question with the measurement, after the DIV/MOD PR.
- Regression-test location: `tools/gogen/run.mjs` (the Go runtime raises it; the JS column shows the anomaly)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-18-icf-shim-form-fields-from-body — A POSTed form field is not there, and reads as an empty one

The same defect as ANOMALY-2026-09-19-posted-form-has-no-fields, found a day
earlier building the AMDP sandbox (backlog G.8); the entries are merged there
(2026-09-24), with this one's workaround and its `+`-to-space trap.

### ANOMALY-2026-09-18-call-function-parameter-case — A destination call is made in lower case and the declaration is upper, so it answers into nothing

**A destination call runs and answers into nothing.** The transpiler writes the
parameter names of a `CALL FUNCTION` in the case they were typed in the ABAP
source, which for ordinary ABAP is **lower**:

```js
abap.statements.callFunction({name: 'ZOSD_AMDP_SANDBOX', destination: 'AMDP',
  exporting: {iv_body: lv_body}, importing: {ev_result: lv_result, ...}});
```

The function group declares the same parameters **upper** case (`IV_BODY`,
`EV_RESULT`), which is how a `*.fugr.xml` names them and how a real system
holds them. A destination implementation that looks its parameters up by the
declared name therefore finds nothing: the call is made, the work is done, and
the answer is written into a bag nobody reads.

**Why it is worth an entry.** On a system this cannot happen -- the kernel
resolves the parameter interface, and case is not a property the caller
carries. Here the two spellings meet, and the failure leaves **no trace at
all**: no exception, no error, no empty result to be suspicious of. The page
that prompted it showed neither a result nor an error, which is the least
informative outcome a program can produce.

Found building the AMDP sandbox (backlog G.8). **Workaround** in
`tools/amdp-destination.mjs`: look parameters up case-insensitively. Every
destination implementation needs the same, so it belongs in the contract rather
than in each one -- see `docs/rfc-destinations.example.json` and the note in
`tools/rfc-replay.mjs`.

**Upstream:** abaplint/transpiler, if the intent is that a destination sees the
declared names. Not yet drafted -- the question to ask first is which spelling
is meant to be authoritative.


### ANOMALY-2026-09-18-system-uuid-window — cl_system_uuid asks a service worker for `window`, and drops the ABAP wrapper when it does

- Status: `workaround`
- Discovery date: `2026-09-18`
- Affected versions: `open-abap-core` at `.local/lars/open-abap-core` (`src/uuid/cl_system_uuid.clas.abap`), any host that is not Node
- Affected ABAP statement, runtime API or adapter: `cl_system_uuid=>if_system_uuid_static~create_uuid_c32` / `_c22` / `_c36` / `_x16`, all four through the private `RANDOM`
- Minimal ABAP reproducer: `DATA(lv) = cl_system_uuid=>if_system_uuid_static~create_uuid_c32( ).` anywhere that runs in the browser deployment
- Exact command used to run it: `npm run web:preview` then `grep -o ".\{40\}window\.crypto.\{0,40\}" build/preview/sw.js`
- Expected SAP behaviour: a 32-character uuid, on every host
- Actual open-abap behaviour: `RANDOM` does `await import("crypto")` and, when that module has no `randomUUID`, falls back to `rv_str = window.crypto.randomUUID();`. Two things are wrong with that line in this tree, and the second one only shows on a host where the first does not bite:
  - webpack polyfills `crypto` with `crypto-browserify`, which has **no** `randomUUID` (`prng, pseudoRandomBytes, rng, randomBytes, Hash, …`), so the fallback is the branch that runs; and the browser deployment is a **service worker**, where there is no `window` at all. `ReferenceError`.
  - the fallback assigns the JavaScript variable rather than calling `set( )` on it — `rv_str = …` where every other line of the method is `rv_str.set(…)` — so a plain page, where `window` does exist, gets a raw JavaScript string back where the caller's ABAP type is a `String`.
- Impact on open-steamgate: the dialog-session id of a transaction (backlog G.3) is the first thing in this tree that wanted a uuid, and the browser preview is one of the three deployments it has to work in
- Smallest safe workaround: `zcl_osd_tran_session=>new_id( )` — `GET TIME STAMP` plus `cl_abap_random`, which is `Math.random( )` on every host and needs no import. Local, and one line from becoming the upstream call again
- Upstream issue: not filed yet. It belongs in `open-abap/open-abap-core` and is two lines: `globalThis.crypto` rather than `window.crypto`, and `rv_str.set(…)` rather than `rv_str = …`. See `docs/upstream.md`
- Regression-test location: `src/webgui/zcl_osd_tran_session.clas.testclasses.abap` (`ltcl_session`, which would fail on any host where the id could not be made) and `test/transaction.mjs`
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-17-integer-division-not-rounded — In integer arithmetic, a division keeps its fraction until the end of the expression

- Status: `open, issue filed`
- Discovery date: `2026-09-17`
- Affected versions: `@abaplint/transpiler` 2.13.87 and `@abaplint/runtime` 2.13.87 together: the transpiler emits `abap.operators.divide( )` for every `/`, and the runtime's `divide` answers a `Float` for two integers; nothing rounds until the target is assigned
- Affected ABAP statement, runtime API or adapter: any arithmetic expression whose calculation type is `i` (every operand and the target are integers) with a `/` in it that is not the last operation — `( a / 3 + b ) MOD 256`, `7 / 2 + 7 / 2`, `( 7 / 2 ) * 2`
- Minimal ABAP reproducer:

```abap
DATA i TYPE i.
i = 7 / 2 + 7 / 2.              " SAP: 8 — open-abap: 7
i = ( 7 / 2 ) * 2.              " SAP: 8 — open-abap: 7
i = ( -40 / 3 + 13 ) MOD 256.   " SAP: 0 — open-abap: 256
DATA f TYPE f.
f = 7 / 2 + 7 / 2.              " SAP: 7 — open-abap: 7 (the target makes the calculation type f)
```

- Exact command used to run it: `tools/o4d-record.mjs --scene plasma --ticks 256` against A4H after `ANOMALY-2026-09-17-append-number-rounded` was fixed: 7 frames of 256 still differed (10, 41, 161, 177, 192, 208, 223), each in exactly one row of 32 rectangles. The row's sine index is `( lv_y / 3 + CONV i( lv_t1 * 35 ) ) MOD 256`, and for those rows the sum before `MOD` is −0.333 or 255.667: a system rounds `lv_y / 3` to an integer first and gets 0, here the fraction survives, `MOD` gives 255.667, the integer target rounds it to 256, and `READ TABLE mt_sin INDEX 257` fails, leaving the previous pixel's value in `lv_v2`. **Measured on A4H, 2026-09-17**, ABAP Unit on a probe class: `( -40 / 3 + 13 ) MOD 256` = 0, `( 140 / 3 + 209 ) MOD 256` = 0, `7 / 2 + 7 / 2` = 8, `( 7 / 2 ) * 2` = 8, `10 / 4 + 10 / 4` = 6, and into an `f` target `7 / 2 + 7 / 2` = 7. The runtime asked directly gives 256, 256, 7, 7, 5 and 7. The probe class was deleted afterwards.
- Expected SAP behaviour: with calculation type `i`, every intermediate result of `/` is rounded to an integer (ABAP keyword documentation, "Calculation Type"; the rounding is commercial, half away from zero)
- Actual open-abap behaviour: the intermediate is a float, rounded once at the assignment
- Impact on open-steamgate: 7 of 256 plasma frames, one wrong row each; and the whole tesseract scene (127 of 128 frames): `CONV i( lv_bright / 255 * 60 + 20 )` with `lv_bright TYPE i` is 20 or 80 on a system (`200 / 255` rounds to 1, measured `l=80` on A4H 2026-09-17) and 39 to 70 here, so the depth shading of every line differs. Any ABAP that does integer arithmetic with a division inside a longer expression — index computations, bucketing, `MOD` after a division — silently differs
- Smallest safe workaround: none in ABAP that a system would want; the code is right as written
- Upstream issue: [abaplint/transpiler#1866](https://github.com/abaplint/transpiler/issues/1866), filed 2026-09-17 as a question with the six measured lines, after a critic pass. The fix is not in the runtime alone: whether `7 / 2` is 4 or 3.5 depends on the calculation type of the whole statement, which the target decides too, so the transpiler has to emit a rounding division (a `divide` with an integer flag, or `abap.operators.div_i`) when the expression's calculation type is `i`, and core knows that type. A design question for Lars; the reproducer is the four lines above as a transpiler test.
- Regression-test location: none yet; `packages/transpiler/test` over the reproducer
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-17-append-number-rounded — `APPEND sin( x ) TO` a float table rounds the value to an integer

- Status: `fixed upstream: abaplint/transpiler#1867, released in 2.13.88`
- Discovery date: `2026-09-17`
- Affected versions: `@abaplint/runtime 2.13.87` (`types/table.ts`, `cloneRow`, twice)
- Affected ABAP statement, runtime API or adapter: `APPEND <numeric function>( … ) TO itab` where the row type is `f` (or `p`, or anything with a fraction) — `sin`, `cos`, `sqrt`, `abs`, `floor`, `ceil`, `trunc`, `sign`, `log`, `exp` return a raw JavaScript number from the runtime
- Minimal ABAP reproducer:

```abap
DATA sines TYPE STANDARD TABLE OF f WITH EMPTY KEY.
DO 256 TIMES.
  APPEND sin( ( sy-index - 1 ) * '6.283185' / 256 ) TO sines.
ENDDO.
READ TABLE sines INDEX 2 INTO DATA(second).   " SAP: 0.024541227323353419 — open-abap: 0
READ TABLE sines INDEX 7 INTO DATA(seventh).  " SAP: 0.14673046733376413 — open-abap: 0 (index 65, sin of a quarter turn, is 1 on both, which is why the first draft of the issue reproduced nothing)
```

- Exact command used to run it: `tools/o4d-record.mjs --scene plasma --ticks 256` on the lab and on A4H, then `--compare`: 256 of 256 frames differ, every rectangle's `f` (its colour) — 7 distinct colours here across 641 rectangles and 169 there, frame 0 all `rgb(20,201,201)` here (hue 180: the row's four sines are 0 after rounding). Then the runtime asked directly: `append({source: abap.builtin.sin({val: Float 0.5}), target: <float table>})` leaves a row of `0`; `append({source: Float 0.479})` keeps it. The values of indexes 2, 7 and 65 were measured on A4H with an ABAP Unit probe (0.0245…, 0.1467…, 0.99999…97); the old wrapping makes them 0, 0, 1. The critic pass before the issue caught the first draft claiming "all zeros": the table holds −1, 0 and 1.
- Expected SAP behaviour: the sine value in the row
- Actual open-abap behaviour: `cloneRow` wraps a raw number as `new Integer().set(item)` before setting the row, so the value is rounded to the nearest integer before the float row sees it
- Impact on open-steamgate: the plasma scene of the demo has 7 colours across a frame instead of 169; any ABAP that tabulates a numeric function
- Smallest safe workaround: assign to an `f` variable first and append that
- Upstream issue: [abaplint/transpiler#1865](https://github.com/abaplint/transpiler/issues/1865), filed 2026-09-17 after a critic pass; PR [#1867](https://github.com/abaplint/transpiler/pull/1867) the same day. Branch `fix/append-number-float` (worktree `.local/pr-append-number` of the transpiler clone, based on `origin/main`, 283a48d8): a whole number stays an `Integer`, anything else goes through a `Float`; cherry-picked onto `local/osd-build`. Runtime tests and lint green.
- Regression-test location: `packages/runtime/test/statements/append_number.ts`, upstream since #1867
- **Verified, 2026-09-17.** With the fix on `local/osd-build` and the runtime rebuilt, the plasma scene against A4H goes from 256 differing frames of 256 to 18: 12 of them the pulse `p` (`ANOMALY-2026-09-16-numeric-builtins-typed-integer`), 7 one row each (`ANOMALY-2026-09-17-integer-division-not-rounded`).
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-17-character-literal-calc-type — An inline declaration from `lc_h * ( '0.4' + … )` is a character

- Status: `fixed upstream, pin behind`
- Discovery date: `2026-09-17`
- Affected versions: `@abaplint/core` up to 2.120.51; fixed in 2.120.52 by [abaplint/abaplint#4293](https://github.com/abaplint/abaplint/pull/4293) (merged 2026-09-14). The transpiler build this tree and the preview were pinned to (`local/osd-build`) still resolved 2.120.50.
- Affected ABAP statement, runtime API or adapter: `DATA(x) = <arithmetic expression with a character literal>` — the inline variable took the literal's type, `Character(4)` for `'0.12'`
- Minimal ABAP reproducer:

```abap
CONSTANTS lc_h TYPE f VALUE 400.
DATA(lv_base_y) = lc_h * ( '0.4' + 1 * '0.12' ).   " SAP: f, 208 — open-abap: c(4) '2,08', then 2 in arithmetic
```

- Exact command used to run it: `tools/o4d-record.mjs --scene mountains_oops --ticks 512` on the lab and on A4H: 511 of 512 frames differ, every mountain rectangle's `y` and `h` by exactly 159. The generated module declares `lv_base_y = new abap.types.Character(4, {})`; the runtime asked directly: `Character(4).set(400 * ('0.4' + 0 * '0.12'))` is `"1,60"`, and `"1,60" - lv_h` reads it as 1. 160 − 1 = 159.
- Expected SAP behaviour: the calculation type of the expression, `f`; 160
- Actual open-abap behaviour: a four-character field, and a float printed with the user's decimal comma into it, read back as its integer part
- Impact on open-steamgate: the mountains scene sits 159 pixels too high; more generally any inline declaration from an expression with a character literal in it
- Smallest safe workaround: none needed once core is at 2.120.52
- Upstream issue: fixed by #4293. The action here is the pin: `local/osd-build` takes `@abaplint/core ^2.120.54` (c148d363), and the preview workflow's `OSD_TRANSPILER_REF` moves with it.
- Regression-test location: upstream, with #4293; here the frame comparison of the mountains scene
- **Verified, 2026-09-17.** With core 2.120.54 in the pinned build, the mountains scene against A4H goes from 511 differing frames of 512 to 268, and the constant 159 is gone. What remains is in bars 28 to 31 only, the sharp mountains: `DATA(lv_tri1) = abs( ( lv_nx MOD 2 ) - 1 ) * 2 - 1` is declared an integer because `abs` is (`ANOMALY-2026-09-16-numeric-builtins-typed-integer`, core), and the `MOD` fix alone changes nothing there; plus the pulse `p` and the beat `flash` it triggers, the same core anomaly.
- Upstream version containing a fix: `@abaplint/core 2.120.52`

### ANOMALY-2026-09-16-numeric-builtins-typed-integer — `frac`, `abs`, `floor`, `ceil`, `trunc`, `sign` of a float are typed as integers

- Status: `open, issue filed`
- Discovery date: `2026-09-16`
- Affected versions: `@abaplint/core 2.120.50` and 2.120.54 (`build/src/abap/5_syntax/_builtin.js`, entries `FRAC`, `FLOOR`, `CEIL`, `TRUNC`, `ABS`, `SIGN`: `return: IntegerType.get()`), and so every transpile
- Affected ABAP statement, runtime API or adapter: an inline declaration from one of the six numeric functions — `DATA(lv_phase) = frac( lv_time / lv_step )`, `DATA(lv_d) = abs( lv_x - lv_y )` — and anything else that takes the function's type from the syntax analysis rather than from the value
- Minimal ABAP reproducer:

```abap
DATA time TYPE f VALUE '8.25'.
DATA(phase) = frac( time ).     " SAP: f, 0.25 — open-abap: i, 0
DATA(dist)  = abs( CONV f( '-2.5' ) ).  " SAP: f, 2.5 — open-abap: i, 3
```

- Exact command used to run it: the ZO4D demo compared frame by frame with A4H after `ANOMALY-2026-09-16-float-vs-character-compare` was fixed: 3 frames of 60 still differed, all in the beat pulse `1 / ( 1 + lv_phase16 * 12 )`; on A4H `lv_phase16` runs 0, 0.25, 0.5, 0.75 and here 0, 0, 1, 1. The generated module declares it `new abap.types.Integer({qualifiedName: "I"})` and `abap.builtin.frac` returns a `Float` of 0.25 into it. Then the core table, read directly. **Measured on A4H, 2026-09-17**, with an ABAP Unit class asking `cl_abap_typedescr=>describe_by_data( )->type_kind` of the inline variable: `frac( f )` and `abs( f )` are `typekind_float`, `frac( 7 )` is `typekind_int`; the probe class was deleted afterwards.
- Expected SAP behaviour: the numeric functions `abs`, `ceil`, `floor`, `frac`, `sign` and `trunc` return a value **of the type of their argument** (ABAP keyword documentation, "Numeric Functions"); `frac( f )` is `f`.
- Actual open-abap behaviour: the six are declared with a fixed integer return type in core's built-in table, whatever the argument. The runtime's `frac` returns a float and the variable it lands in rounds it, so the value is right for a moment and wrong at rest.
- Impact on open-steamgate: the last three of sixty differing frames of the demo's first scene, and, measured 2026-09-17 with every other anomaly fixed, everything that still differs from A4H in three more: the pulse `p` in 12 of 256 plasma frames and 24 of 512 mountains frames, the beat `flash` it triggers (10 mountains frames), the brightness of 13 voxel-landscape frames on the beat, and the sharp mountains of bars 28 to 31 (`DATA(lv_tri1) = abs( … )` declared an integer). More generally any 7.40-style ABAP that declares inline from these functions over a float gets an integer without a word from the compiler. Business code, which mostly applies them to `i` and `p`, is not hit — for `i` the rule and the table agree.
- Smallest safe workaround: declare the variable — `DATA lv_phase16 TYPE f.` before the assignment — which is what the demo's author would not write on a system.
- Upstream issue: [abaplint/abaplint#4302](https://github.com/abaplint/abaplint/issues/4302), filed 2026-09-17 with the measurement and the three tests. Branch `fix/numeric-builtins-argument-type` in the fork worktree (`~/dev/abaplint/.local/pr-numeric-builtins`, based on `origin/main`) carries the tests only, no fix yet. The fix is not a table edit: `IBuiltinMethod.return` is one static `AbstractType`, so the six need their return type taken from the argument where the call is typed: `expressions/method_call_chain.ts` sets `context` to the declared return (line 101 of 2.120.52) *before* `MethodCallParam.runSyntax` analyses the argument; for these six, `context` should be the argument's type once that has run. A fork PR, since `oisee` has no write access there (`DEBT-2026-09-14-no-push-to-abaplint`).
- Regression-test location: `packages/core/test/abap/syntax/basic_variables.ts` on the branch — "inline DATA from frac( f ) is a float", "… abs( f ) …" (both failing on 2.120.54: `expected IntegerType to be an instance of FloatType`) and "frac( i ) stays an integer" (passing)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-17-release-bundle-slower-than-source — The release bundle runs ABAP arithmetic three and a half times slower than the same build on plain Node

- Status: `measured, not diagnosed`
- Discovery date: `2026-09-17`
- Affected versions: this tree's own `scripts/build-sea.mjs` bundle (`osd.mjs`) and, by extension, the Bun binary and every release deployed from them
- Affected ABAP statement, runtime API or adapter: none in particular — arithmetic-heavy ABAP, measured on the demo
- Minimal reproducer: serve one generation two ways and profile the same scene.

```
node tools/o4d-profile.mjs http://127.0.0.1:<port> --scene quat_julia --ticks 60
# the ordinary source host (test/run.mjs -> tools/osd-serve.mjs):   100.4 ms a frame
# the release bundle (.local/release-*/osd.mjs serve):              363.3 ms a frame
```

- Exact command used to run it: found while re-measuring the code-generation
  feature with five interleaved rounds a side, 2026-09-17. The same cached
  generation, the same machine, the same scene. Node was ruled out as the
  cause: the source host under the release tree's own private Node 26.9 gives
  98.6-101.5 ms, indistinguishable from system Node 26.3 at 100.4.
- Expected behaviour: a bundle of the same code runs at roughly the speed of
  the code.
- Actual behaviour: **3.5x slower**, and not uniformly. The penalty falls on
  the `@abaplint/runtime` operator protocol specifically: with the transpiler's
  typed-arithmetic flag **off** the bundle costs 3.6x (100 -> 363 ms), with it
  **on** only 2.0x (59 -> 119 ms). Whatever the bundling does, it does it to
  the operators.
- Impact on open-steamgate: **this is what the i7 and every release run.**
  The demo on a deployed release is several times slower than the same code
  served from a checkout, and the work-process pool (B.12) was measured on the
  source host. It also silently inflates any performance comparison taken
  through a release: a change that removes protocol work looks better than it
  is, which is how a -41 % improvement read as -63 % before this was found.
- Smallest safe workaround: measure on the source host. For deployment there
  is none yet, because the cause is unknown.
- Suspects, none confirmed: Terser's mangling of the runtime's hot classes
  (`keep_classnames`/`keep_fnames` are set for a correctness reason, so the
  shape V8 sees may still differ), the bundle's single-chunk module wrapper
  defeating inlining, or the generated code reaching the runtime through the
  plugin's `build.module` copy rather than a normal import (CLAUDE.md, the
  binary's four facts).
- Upstream issue: none; this is ours.
- Regression-test location: none yet
- Upstream version containing a fix: n/a

### ANOMALY-2026-09-17-character-operand-calculation-type — A character literal in arithmetic gives a different type on each side, and neither is the kernel's

- Status: `measured, not fixed`
- Discovery date: `2026-09-17`
- Affected versions: `@abaplint/runtime 2.13.87` (`operators/multiply.ts`, `minus.ts`, `add.ts`, `divide.ts`) and the transpiler's inferred type for an inline declaration
- Affected ABAP statement, runtime API or adapter: any arithmetic with a character literal operand, which is how ABAP spells a non-integer constant
- Minimal ABAP reproducer:

```abap
DATA lv_i TYPE i VALUE 3.
DATA(lv_a) = lv_i * '2'.      " SAP: P(8,0) 6    open-abap: Float 6
DATA(lv_b) = '2' * lv_i.      " SAP: P(8,0) 6    open-abap: Integer 6
DATA(lv_c) = lv_i * '2.5'.    " SAP: P(8,0) 8    open-abap: Float 7.5
```

- Exact command used to run it: **measured on A4H, 2026-09-17**, a throwaway class with an ABAP Unit test that fails on purpose so the assertion message carries `cl_abap_typedescr=>describe_by_data( )->type_kind` and the value of each expression; created, read and deleted. The runtime side was read from the operators directly.
- Expected SAP behaviour: a character-like operand makes the calculation type packed, **symmetrically** — the side the literal is on does not matter. The system answers `P(8,0)` for `*`, `-`, `+` and `/` alike, and the compiler warns nine times that `P(8,0)` is used implicitly because the length and the decimals cannot be derived.
- Actual open-abap behaviour: the operators test a character operand only on one side, and differently per operator. `multiply` and `minus` check `Number.isInteger(Number(left.get()))` for the left operand only; the right-hand test reads the object rather than its value, so it can never fire; `divide` has no character branch at all. The result is `Integer` with the literal on the left and `Float` with it on the right, and neither is packed.
- **The second half of the measurement, and the more useful half**: the rounding is not in the computation, it is in the target. On A4H `lv_f = lv_i * '2.5'` is 7.5 and `lv_p` with four decimals is 7.5000, while the inline `DATA(x)` is 8, because the inferred type is `P(8,0)`. And with no character literal at all, `lv_f = lv_i / 2` is 1.5 while `DATA(x) = lv_i / 2` is `I` and 2. **So the kernel chooses the calculation type from the target of the assignment as well as from the operands**, which is exactly the question [abaplint/transpiler#1866](https://github.com/abaplint/transpiler/issues/1866) asks and has no answer to yet. This is the measurement that issue was missing.
- Impact on open-steamgate: this is the family behind the inline-declaration differences the frame comparison found (`docs/frame-comparison.md`, the mountains and tesseract rows). A scene that writes `DATA(lv_x) = lc_h * ( '0.4' + … )` is packed with no decimals on a system and a float here.
- Smallest safe workaround: declare the variable rather than inferring it, and give it the type the computation needs.
- Upstream issue: none of its own yet. It belongs with #1866 as the measurement that answers it, and the asymmetry is a candidate in the draft of the character-literal issue (`docs/upstream.md`, the performance track).
- Regression-test location: none yet
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-16-mod-result-integer — `MOD` with a float operand answers an integer

- Status: `fixed upstream: abaplint/transpiler#1863, merged 2026-09-18, released in @abaplint/runtime 2.13.88; this tree already has it`
- Discovery date: `2026-09-16`
- Affected versions: `@abaplint/runtime 2.13.86` and 2.13.87 (`operators/mod.ts`)
- Affected ABAP statement, runtime API or adapter: `a MOD b` where either operand is a float (or a packed number with decimals)
- Minimal ABAP reproducer:

```abap
DATA r TYPE f.
r = CONV f( '2.75' ) MOD 1.   " SAP: 0.75 — open-abap: 1
```

- Exact command used to run it: the runtime asked directly, `abap.operators.mod(Float 2.75, Integer 1)` — the value is computed as 0.75 and returned in an `Integer`, which rounds it to 1. Found while probing the arithmetic around `ANOMALY-2026-09-16-numeric-builtins-typed-integer`. **Measured on A4H, 2026-09-17** (ABAP Unit, `lv_f = '2.75'. rv_r = lv_f MOD 1.` into an `f`): 0.75.
- Expected SAP behaviour: the calculation type of the operands decides — with a float operand the result is a float, 0.75.
- Actual open-abap behaviour: `mod()` returns `new Integer().set(val)` for anything that is not `Integer8`, and the integer rounds the remainder.
- Impact on open-steamgate: none seen in the demo; every effect that keeps a phase with `MOD` on floats would be quantised the way the pulse was.
- Smallest safe workaround: `frac( a / b ) * b` in ABAP, which stays float
- Upstream issue: [abaplint/transpiler#1860](https://github.com/abaplint/transpiler/issues/1860), filed 2026-09-17; PR [#1863](https://github.com/abaplint/transpiler/pull/1863), 2026-09-17. Branch `fix/mod-float-result` (worktree `.local/pr-mod-float-result` of the transpiler clone, based on `origin/main`), one commit with the fix and the test (2026-09-17, after Alice asked why the tests went without fixes): a `Float` result when either operand is one or the remainder is not whole, beside the `Integer8` case that already exists; the runtime's tests and lint green.
- Regression-test location: `packages/runtime/test/arithmetics.ts` on the branch, "MOD with a float operand answers a float" (failed on 2.13.87 with `expected Integer{ value: 1 } to be an instance of Float`, passes with the fix)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-16-integer-rounds-negative-half-to-zero — A float of −0.5 assigned to an integer becomes 0

- Status: `fixed upstream: abaplint/transpiler#1864, released in 2.13.88`
- Discovery date: `2026-09-16`
- Affected versions: `@abaplint/runtime 2.13.86` and 2.13.87 (`types/integer.ts`, `set()` with `Math.round`)
- Affected ABAP statement, runtime API or adapter: any move of a negative float exactly on a half to an integer — `lv_i = lv_f` with `lv_f = -0.5`, `-1.5`, …
- Minimal ABAP reproducer:

```abap
DATA i TYPE i.
i = CONV f( '-0.5' ).   " SAP: -1 — open-abap: 0
```

- Exact command used to run it: the runtime asked directly, `Integer.set(Float -0.5)` gives 0; +0.5, 1.5, 2.5 are right. `Math.round(-0.5)` is `-0` in JavaScript, which rounds a half towards positive infinity, and ABAP rounds a half away from zero. **Measured on A4H, 2026-09-17** (ABAP Unit, `lv_f = '-0.5'. rv_i = lv_f.`): −1.
- Expected SAP behaviour: −1
- Actual open-abap behaviour: 0
- Impact on open-steamgate: none seen; it is a half of a unit, exactly, on the negative side, which is rare and silent
- Smallest safe workaround: none needed
- Upstream issue: [abaplint/transpiler#1861](https://github.com/abaplint/transpiler/issues/1861), filed 2026-09-17; PR [#1864](https://github.com/abaplint/transpiler/pull/1864), 2026-09-17. Branch `fix/integer-round-half-away` (worktree `.local/pr-integer-round-half-away`, based on `origin/main`), one commit with the fix and the test (2026-09-17): `roundHalfAwayFromZero` on `Integer` (`-Math.round(-v)` for a negative, `-0` made `0`), used by `Integer.set` for numbers and floats, by `toInteger` for strings and by `Integer8.set` for floats; `Float.getRaw` already rounded this way. The runtime's tests and lint green.
- Regression-test location: `packages/runtime/test/arithmetics.ts`, "a negative half moved to an integer rounds away from zero" (failed on 2.13.87 with `expected -0 to equal -1`, passes with the fix), upstream since #1864
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-16-float-vs-character-compare — A float compared with a character literal is compared with an integer

- Status: `fixed upstream: abaplint/transpiler#1862, released in 2.13.88`
- Discovery date: `2026-09-16`
- Affected versions: `@abaplint/runtime 2.13.86` and 2.13.87 (`compare/gt.ts`)
- Affected ABAP statement, runtime API or adapter: every comparison of a numeric operand with a character or string one — `IF f > '0.5'`, `f < '0.3'` — through `compare.gt` and, written in terms of it, `lt`, `ge`, `le`. `eq` is not affected: it already reads a point.
- Minimal ABAP reproducer:

```abap
DATA prog TYPE f.
prog = '0.06'.
IF prog > '0.5'.
  WRITE 'label'.   " open-abap writes it; SAP does not
ENDIF.
```

- Exact command used to run it: `tools/o4d-record.mjs --compare` of the ZO4D demo recorded on A4H and here — 59 frames of 60 differ, every one by a quarter label the demo draws here from the second frame on and a system never does. Then the runtime asked directly: `abap.compare.gt(Float 0.06, Character '0.5')` is `true`, `lt` is `false`, `gt(Float 0.06, Float 0.5)` is `false`.
- Expected SAP behaviour: the character operand is converted to the type of the numeric operand it is compared with — `f` here, so `'0.5'` is 0.5 and the label waits until the bar is half grown.
- Actual open-abap behaviour: in the generic tail of `compare/gt.ts` a numeric left against a string right (and the mirror) ended in `parseInt(…, 10)`, so `'0.5'` was 0 and every fraction compared as its integer part. The runtime's own `operators/_parse.ts` has the right rule (`parseFloat` when the string holds a point) and was not called.
- Impact on open-steamgate: the demo's `Sales Dance` scene labels its bars on the second frame instead of halfway through the intro, and the frame stream is not the system's from frame 1 (`ANOMALY-2026-09-16-*` is the first anomaly found by the frame comparison rather than by a crash). Any ABAP that compares a float with a literal carrying a fraction is affected; business code, which compares with integer literals, happens not to be.
- Smallest safe workaround: write the literal as a float, `CONV f( '0.5' )`, which compares float with float. Not applied to the demo: the ABAP is right as written.
- Upstream issue: [abaplint/transpiler#1859](https://github.com/abaplint/transpiler/issues/1859), filed 2026-09-17 with the frame count before and after; PR [#1862](https://github.com/abaplint/transpiler/pull/1862) from the branch inside the repository, 2026-09-17. Branch `fix/compare-character-literal` in `abaplint/transpiler` (worktree `.local/pr-compare-char`, based on `origin/main` 7daf28f2): `parse()` in place of `parseInt` in both branches of `gt`'s tail, one commit, the runtime's tests and lint green.
- Regression-test location: `packages/runtime/test/compare.ts`, "float against a character literal with a fraction", upstream since #1862
- **Verified, 2026-09-16.** With the fix cherry-picked onto `local/osd-build` and the runtime rebuilt, the same sixty frames against A4H differ in 3 instead of 59, and none of them by a label; what remains is the field `p` on frames 33 to 35, which is a different question and is being looked at.
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-15-srvd-not-allowed — The transpiler refuses SRVD objects

- Status: `open`
- Discovery date: `2026-09-15`
- Affected versions: `@abaplint/transpiler-cli` as pinned in package.json (see `npm ls @abaplint/transpiler-cli`)
- Affected ABAP statement, runtime API or adapter: object type `SRVD` (service definition) in the transpile input
- Minimal ABAP reproducer: any `<name>.srvd.srvdsrv` + `<name>.srvd.xml` under `src/`
- Exact command used to run it: `npm run transpile`
- Expected SAP behaviour: a service definition is an ordinary repository object; abaplint knows the type
- Actual open-abap behaviour: `Error: allowed_object_types, Object type SRVD not allowed` — `SRVD` is absent from the transpiler's `defaultAllowedObjectTypes`
- Impact on open-steamgate: the `$ZTEST` demo package cannot hold a service definition; the ADT façade lists the type (`osd-store.mjs` TYPES) but no object can exist behind it
- Smallest safe workaround: `none` — the object files were removed from `src/ztest/`
- Upstream issue: needs an issue in `abaplint/transpiler` (not yet filed)
- Regression-test location: none yet
- Upstream version containing a fix: `unknown`


### ANOMALY-2026-09-11-no-implicit-mandt — Client-dependent tables are read across all clients

- Status: `open`
- Discovery date: `2026-09-11`
- Affected versions: `@abaplint/transpiler-cli 2.13.85`, `@abaplint/runtime 2.13.85`, `@abaplint/database-sqlite 2.13.83`
- Affected ABAP statement, runtime API or adapter: `SELECT` on a table with `CLIDEP = X`; `sy-mandt` is the constant `123` (`runtime/src/builtin/sy.ts`)
- Minimal ABAP reproducer: `src/demo/zcl_zstg_demo_dpc_ext.clas.abap` `travelset_get_entityset` against `data/zstg_demo.tabu.json` (3 rows in client 123, 1 in client 001)
- Exact command used to run it: `npm run unit`
- Expected SAP behaviour: 3 rows; the database interface adds `MANDT = sy-mandt` to every Open SQL statement on a client-dependent table unless `CLIENT SPECIFIED`
- Actual open-abap behaviour: 4 rows; no client predicate is generated, `INSERT`/`UPDATE`/`DELETE` likewise touch every client
- Impact on open-steamgate: every real business table is client-dependent; a seeded multi-client capture leaks rows across clients, and any DPC that branches on `sy-mandt` sees `123`
- Smallest safe workaround: seed captures with a single client and set every row's `mandt` to `123`; do not rely on client isolation in tests
- Upstream issue: **[abaplint/transpiler#606](https://github.com/abaplint/transpiler/issues/606)**, open since 2022 and phrased as a question. larshp's own answer on it is "or ignore it? as the client feature is not needed in the transpiler/runtime, just spin up multiple" — which is what our workaround already does, so this is a settled design decision rather than a missing fix. Measured and added to the issue on 2026-09-14: a `CLNT`-keyed table with rows under 123, 456 and 789 returns 3 rows here and 1 on a system. Documented rather than implemented, in [abaplint/transpiler#1850](https://github.com/abaplint/transpiler/pull/1850), because the README's `SY-MANDT = 123` line reads as though the client is handled and merely constant
- Regression-test location: `test/unit/zcl_stg_phase0_test.clas.testclasses.abap` `entityset_reads_sqlite` pins the current 4-row result and will fail when the runtime starts filtering
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-11-oao-handler-hardcodes-test-dpc — open-abap-odata cannot be consumed as a library

- Status: `fixed upstream, workaround removed`
- Discovery date: `2026-09-11`
- Affected versions: `open-abap/open-abap-odata` main at `7b20ba2` (2026-08-27)
- Affected ABAP statement, runtime API or adapter: `zcl_oao_http_handler=>data` declares `lo_dpc TYPE REF TO zcl_zsegw_dpc_ext`, a class that only exists in that repo's `test/` folder
- Minimal ABAP reproducer: add the repo as a lib in `abap_transpile.json` without `exclude_filter`
- Exact command used to run it: `npm run transpile`
- Expected SAP behaviour: n/a (library packaging)
- Actual open-abap behaviour: `Error: CreateObjectTranspiler, target variable "lo_dpc" not a object reference`
- Impact on open-steamgate: blocks using the interface transcription as a lib
- Smallest safe workaround: `"exclude_filter": ["zcl_oao_http_handler"]` on the lib entry. **Removed 2026-09-14**: the filter is no longer in `abap_transpile.json` and the build is green without it, so the record saying "(applied)" had outlived the thing it described
- Upstream issue: https://github.com/open-abap/open-abap-odata/issues/33 (open, same crash); QW1 in `AGENDA.md` is the fix, sent upstream as https://github.com/open-abap/open-abap-odata/pull/40 (merged 2026-09-12)
- Regression-test location: `npm run transpile` itself
- Upstream version containing a fix: open-abap-odata main from 5467424 (2026-09-12); open-steamgate consumes upstream directly since #48

### ANOMALY-2026-09-11-doubled-quote-literal — A literal holding two quotes is transpiled as one character

- Status: `fixed` in `@abaplint/transpiler` 2.13.86 (2026-09-12); workaround removed the same day
- Discovery date: `2026-09-11`
- Affected versions: `@abaplint/transpiler-cli 2.13.85`
- Affected ABAP statement, runtime API or adapter: any character literal whose content is escaped quotes, e.g. `''''''` (two quotes) used in `REPLACE ALL OCCURRENCES OF '''''' IN lv WITH ''''`
- Minimal ABAP reproducer (inline):

  ```abap
  rv_result = `x''y`.
  REPLACE ALL OCCURRENCES OF '''''' IN rv_result WITH ''''.
  " SAP: x'y   open-abap: x''y
  ```

- Exact command used to run it: `abap_transpile` + `node output/index.mjs` on a class with the two lines above in a FOR TESTING method
- Expected SAP behaviour: `''''''` is a `c LENGTH 2` literal containing `''`; the replace yields `x'y`
- Actual open-abap behaviour: the literal is emitted as `abap.CharacterFactory.get(1, '\'\'')`, a `c LENGTH 1`, so the pattern degenerates to a single quote and the statement is a no-op. Length is computed before the escape sequence is folded.
- Impact on open-steamgate: OData key predicates and `$filter` literals escape quotes by doubling; un-doubling silently failed
- Smallest safe workaround: build the two-quote string at runtime, `lv_two = |''|`, and use the variable in `REPLACE` (was applied in `zcl_stg_url`, `zcl_stg_json`, `zcl_stg_request_context`, `zcl_stg_sadl_dpc`; the literal is back since 2.13.86)
- Upstream issue: https://github.com/abaplint/transpiler/pull/1829 (fix + test, open 2026-09-12)
- Regression-test location: `test/unit/zcl_stg_gateway_test.clas.testclasses.abap` `ltcl_url->keys_named`
- Upstream version containing a fix: 2.13.86

### ANOMALY-2026-09-12-fae-dedupe-by-db-key — FOR ALL ENTRIES de-duplicates by the DB key on the target table

- Status: `fixed` in `@abaplint/transpiler` 2.13.86 (2026-09-12); workaround removed the same day
- Discovery date: `2026-09-12`
- Affected versions: `@abaplint/transpiler-cli 2.13.85`, `@abaplint/runtime 2.13.85`
- Affected ABAP statement, runtime API or adapter: `SELECT <fields> FROM tab INTO CORRESPONDING FIELDS OF TABLE lt FOR ALL ENTRIES IN ...` where the target line type lacks a key field of `tab` (typically MANDT)
- Minimal ABAP reproducer: `src/demo/zcl_zstg_demo_dpc_ext.clas.abap` `get_expanded_entityset` before this entry's workaround
- Exact command used to run it: `npm run unit`
- Expected SAP behaviour: the union of the per-entry selects with duplicates removed, target fields filled by name
- Actual open-abap behaviour: the generated code runs `SORT lt BY mandt travel_id booking_id` + `DELETE ADJACENT DUPLICATES` with the DB key's component names on the *target* table: `Error: sort compare, wrong component name, mandt`
- Impact on open-steamgate: any DPC that FAE-selects into a projection structure crashes the request; very common in hand-written DPCs
- Smallest safe workaround: select into a table typed like the DB table (`TYPE STANDARD TABLE OF tab`) and MOVE-CORRESPONDING afterwards (was applied in the demo; `INTO CORRESPONDING FIELDS` is back since 2.13.86)
- Upstream issue: https://github.com/abaplint/transpiler/pull/1830 (fix + test, open 2026-09-12)
- Regression-test location: `test/unit/zcl_stg_gateway_test.clas.testclasses.abap` `ltcl_navigation->expand_by_the_dpc`
- Upstream version containing a fix: 2.13.86

### ANOMALY-2026-09-12-fae-empty-driver — FOR ALL ENTRIES with an empty driving table throws

- Status: `fixed` in `@abaplint/transpiler` 2.13.86 (2026-09-12); workaround removed the same day
- Discovery date: `2026-09-12`
- Affected versions: `@abaplint/transpiler-cli 2.13.85`
- Affected ABAP statement, runtime API or adapter: `SELECT ... FOR ALL ENTRIES IN lt` with `lt` empty
- Minimal ABAP reproducer: the same SELECT as above with an empty `lt_travel` (guarded by `IF lt_travel IS NOT INITIAL` in the demo)
- Exact command used to run it: `npm run unit` without the guard
- Expected SAP behaviour: the WHERE condition with the FAE table is dropped, all rows are selected (the classic FAE trap)
- Actual open-abap behaviour: `throw new Error("FAE, todo, empty table")` in the generated code
- Impact on open-steamgate: a DPC that relies on the SAP behaviour (or forgets the guard) crashes instead of over-selecting
- Smallest safe workaround: guard every FAE with `IF lt IS NOT INITIAL`, as good ABAP does anyway (kept: since 2.13.86 an unguarded empty driver selects everything, like on SAP)
- Upstream issue: https://github.com/abaplint/transpiler/pull/1832 (SAP semantics: empty driver ignores the WHERE; Lars may prefer an option, offered in the PR)
- Regression-test location: none
- Upstream version containing a fix: 2.13.86

### ANOMALY-2026-09-12-create-data-ddic-view — CREATE DATA with a DDIC view type is unknown at runtime

- Status: `fixed` in `@abaplint/transpiler` 2.13.86 (2026-09-12); workaround removed the same day
- Discovery date: `2026-09-12`
- Affected versions: `@abaplint/transpiler-cli 2.13.85`, `@abaplint/runtime 2.13.85`
- Affected ABAP statement, runtime API or adapter: `CREATE DATA rr TYPE STANDARD TABLE OF <ddic view>` (VIEW object)
- Minimal ABAP reproducer: `tools/cds2ddic.mjs` generated source classes before this entry's workaround
- Exact command used to run it: `npm run unit`
- Expected SAP behaviour: a table of the view's line type
- Actual open-abap behaviour: `Error: CREATE DATA, unknown type ZVSTGTRAVEL` (the transpiler resolves the view statically for SELECT, but the runtime DDIC lookup has no entry for views)
- Impact on open-steamgate: generic code that creates data by a view name fails
- Smallest safe workaround: declare `TYPES ty_line TYPE <view>` in the class and `CREATE DATA ... TYPE ty_line` / a local table type (was applied in the generator; `CREATE DATA ... TYPE STANDARD TABLE OF <view>` is back since 2.13.86)
- Upstream issue: https://github.com/abaplint/transpiler/pull/1831 (two fixes: views were never imported by the init script, and the runtime ignored the TABLE flag for static DDIC names, so plain `CREATE DATA ... TYPE STANDARD TABLE OF t100` was broken too)
- Regression-test location: `test/unit/zcl_stg_gateway_test.clas.testclasses.abap` `ltcl_sadl->entity_set_with_filter`
- Upstream version containing a fix: 2.13.86

### ANOMALY-2026-09-13-conv-second-in-expression — The second constructor expression in one expression has no type

- Status: `fixed upstream: abaplint/transpiler#1842`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler 2.13.86`, `@abaplint/core 2.120.5`
- Affected ABAP statement, runtime API or adapter: `CONV` (and any constructor expression resolved through an inferred type) when more than one appears in one expression
- Minimal ABAP reproducer: `foo = CONV f( 1 ) + CONV f( 2 ).`
- Exact command used to run it: `npx abap_transpile` over oisee/vivid-vibes; isolated with the transpiler's own `runSingle`
- Expected SAP behaviour: both are floats; ABAP has no opinion about how many of them fit in a statement
- Actual open-abap behaviour: the transpile ends with `TypeNameOrInfer, type not found: f`. The syntax check records an InferredType reference for the first name and none for the rest, and the transpiler had nothing else to fall back on
- Impact on open-steamgate: none of ours; 786 uses of `CONV f(` across 69 files of vivid-vibes, 136 of them with two in one expression, so the demo payload did not transpile at all
- Smallest safe workaround: split the expression into two statements
- Upstream issue: **PR [abaplint/transpiler#1842](https://github.com/abaplint/transpiler/pull/1842)**, opened 2026-09-14 from branch `fix/conv-builtin-type-name` inside the repo, so Regression runs. A built-in type name that names exactly one type (`i`, `f`, `string`, `xstring`, `d`, `t`, `int8`, `utclong`, `decfloat16/34`) is enough on its own when no reference was recorded
- Regression-test location: the transpiler's `test/single_statements.ts`, upstream since #1842 (`foo = CONV f( 1 ) + CONV f( 2 ).`, not skipped)
- Upstream version containing a fix: `2.13.88`
- **What actually landed, checked 2026-09-18.** #1842 was merged as three lines of test and no fix: the defect was closed by `@abaplint/core` recording an inferred type for every constructor expression rather than the first (abaplint#4290). So the `BUILT_IN` table this side carried in `expressions/type_name_or_infer.ts` is *not* upstream, and on 2.13.88 it is not needed either — the reproducer transpiles without it. The table was dropped with the link

### ANOMALY-2026-09-13-paren-before-conv — A parenthesised group before `* CONV ... /` generates unbalanced JavaScript

- Status: `fixed upstream: abaplint/transpiler#1843`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler 2.13.86`
- Affected ABAP statement, runtime API or adapter: arithmetic where a constructor expression sits between two operators
- Minimal ABAP reproducer: `foo = ( 1 - 2 ) * CONV f( 3 ) / 256.`
- Exact command used to run it: `npx abap_transpile`; the generated module then fails to parse with `Private field '#x' must be declared in an enclosing class`, which is V8 recovering from unbalanced parentheses somewhere above
- Expected SAP behaviour: `(( 1 - 2 ) * conv) / 256`, left to right
- Actual open-abap behaviour: the emitted JavaScript drops `( 1 - 2 ) *` and closes one bracket too many. The rearranger flattens a nested arithmetic Source into its parent so precedence can be decided across the whole chain, and a constructor expression is five children rather than one, so its type name and body landed beside the operators and were read as operands
- Impact on open-steamgate: none of ours; 15 of 85 effect classes in vivid-vibes emitted modules that could not be imported, and one broken module breaks the whole runtime because `init.mjs` imports every class
- Smallest safe workaround: assign the constructor expression to a variable first
- Upstream issue: none yet, branch `fix/rearranger-constructor-operand`, next in the queue. The head of the flattened chain is wrapped back into one Source before it is hoisted
- Regression-test location: the transpiler's `test/single_statements.ts`, local branch
- Upstream version containing a fix: `2.13.87`

### ANOMALY-2026-09-13-builtin-as-method — A built-in function in such an expression is emitted as a method of the class

- Status: `gone upstream on 2.13.88, not by our fix`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler 2.13.86`
- Affected ABAP statement, runtime API or adapter: any built-in function call (`cos`, `sin`, `nmax`, `lines`, `frac`) inside an expression carrying more than one constructor expression
- Minimal ABAP reproducer: in a class, `lv = CONV f( 1 ) + CONV f( 2 ) * nmax( val1 = 0 val2 = lv_ax * cos( lv_ax ) ).`
- Exact command used to run it: `npx abap_transpile`, then calling the method: `TypeError: this.cos is not a function`
- Expected SAP behaviour: `cos` is a built-in unless the class defines a method of that name, in which case the method wins
- Actual open-abap behaviour: emitted as `await this.cos( )`. The decision rests on a BuiltinMethodReference the syntax check records, and in this shape it records none, so the call fell through to the `this.` case. Same root as the two above: one reference per expression
- Impact on open-steamgate: none of ours; it is why several vivid-vibes effects failed at runtime rather than at build time, which is the worse of the two
- Smallest safe workaround: split the expression
- Upstream issue: none yet, PR deferred. Fixed in the same local branch: an unrecorded name is taken as a built-in only when it is the first call in its chain, `abaplint.BuiltIn.searchBuiltin` knows it, and the enclosing class has no method of that name. The chain condition matters, `mi_merge->get_result( )-stage->count( )` is a method called COUNT
- Regression-test location: the transpiler's `test/files.ts` on `fix/builtin-not-a-method`, both directions, still local
- Upstream version containing a fix: `2.13.88`, indirectly
- **Checked 2026-09-18, on published 2.13.88 with the link dropped.** The defect does not reproduce any more, and the reason is the same one as for `ANOMALY-2026-09-13-conv-second-in-expression`: the syntax check now records a reference for every call in the expression, so nothing falls through to the `this.` case. Measured over the whole build, 1499 objects: no `await this.(cos|sin|nmax|sqrt|frac|abs|lines)(` anywhere in `output/`. The branch `fix/builtin-not-a-method` is kept, because it also guards the case where a class *does* define a method of a built-in's name, which has no upstream test

### ANOMALY-2026-09-14-class-constructor-eager — A class constructor runs before the program, not at first use

- Status: `reported: abaplint/transpiler#1849`
- Discovery date: `2026-09-14`
- Affected versions: `@abaplint/transpiler 2.13.86`
- Affected ABAP statement, runtime API or adapter: `CLASS-METHODS class_constructor`
- Minimal ABAP reproducer:

```abap
CLASS lcl DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS class_constructor.
    CLASS-METHODS touch.
ENDCLASS.
CLASS lcl IMPLEMENTATION.
  METHOD class_constructor.
    WRITE / 'ctor'.
  ENDMETHOD.
  METHOD touch.
    WRITE / 'touch'.
  ENDMETHOD.
ENDCLASS.

START-OF-SELECTION.
WRITE / 'before'.
lcl=>touch( ).
WRITE / 'after'.
```

- Exact command used to run it: transpile and run; measured 2026-09-14
- Expected SAP behaviour: `before / ctor / touch / after`. The class constructor runs once, at the first access to the class, which here is inside the program's executable part. **Verified on A4H 2026-09-24** (ultra/events, `$ZOSG_TMP_0440`): `tools/gogen/testdata/zcl_gogen_t_cctor.clas.abap` with `_CC1`, `_CC2` (a subclass), `_CC3` and `_CCLOG` answered `a cc3 t3 t3 b cc1 cc2 t1 c ` — at the first static call, at the first CREATE OBJECT of a subclass (the superclass's first), once; the transpiler 2.13.89 answers `cc3 cc1 cc2 a t3 t3 b t1 c `. An exception out of a class constructor (`zcl_gogen_t_ccboom2.clas.abap`, `$ZOSG_TMP_0441`) is a runtime abortion on A4H that no CATCH takes, `CX_SY_ZERODIVIDE`, `CX_SY_NO_HANDLER` or `CX_ROOT`; the transpiler raises it while the modules load, before any statement of the program, so nothing can catch it either, but the program never starts
- Actual open-abap behaviour: `ctor / before / touch / after`. The constructor runs eagerly, before the program's own statements, which is what an ES module initialising at import time does
- Impact on open-steamgate: subtle and real, because a class constructor can touch `sy-tabix`. A registry filled with `APPEND` in a class constructor leaves `sy-tabix` at the last appended index; run lazily inside a loop body that reads `sy-tabix` afterwards, the first iteration sees that index rather than its own row number. Measured: `12` here where a system would give `32` for the same program. Found by larshp reviewing `abaplint/transpiler#1848`, who asked whether a test should expect `,a,b,c` — it depends entirely on this
- Smallest safe workaround: do not read `sy-tabix` after a call that may be a class's first access; or touch the class once before the loop, which is what that test now does
- Upstream issue: **[abaplint/transpiler#1849](https://github.com/abaplint/transpiler/issues/1849)**. Confirmed as a bug by larshp on #1848 the same day — "yea, its a bug, dont use class constructors" — so the expected column above is no longer only our reading. Filed as an issue rather than a pull request because deferring initialisation to first access changes how the transpiler emits and imports modules, which is his design call. His advice, avoid class constructors, is a good workaround and not one a repository being transpiled knows to have followed
- Regression-test location: none; the pull request that found it now avoids the dependency rather than pinning it
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-14-builtin-positional-argument — An unrecorded built-in is called positionally

- Status: `gone upstream on 2.13.88, not by our fix`
- Discovery date: `2026-09-14`
- Affected versions: `@abaplint/transpiler 2.13.86`, including the local build that already carried the earlier half of this fix
- Affected ABAP statement, runtime API or adapter: any built-in function taking a single argument — `sin`, `cos`, `sqrt`, `exp` — called from inside an expression that carries more than one constructor expression
- Minimal ABAP reproducer:

```abap
DATA lv_t TYPE f.
DATA lv_speed TYPE f.
DATA(a) = CONV f( '0.5' ) + sin( lv_t * lv_speed ) * CONV f( '0.3' ).
"        -> abap.builtin.sin(abap.operators.multiply(...))   wrong
DATA(b) = sin( lv_t * 3 + lv_t * 4 ) * 10.
"        -> abap.builtin.sin({val: abap.operators.add(...)}) right
```

- Exact command used to run it: `npx mocha build/test/builtin/cos.js`; found by open-steamgate driving her preload sequence, which died at frame 1281 in `zcl_o4d_twistzoomer`
- Expected SAP behaviour: n/a, this is an emitter defect rather than a semantic one. The runtime signature is `sin(input: {val})`
- Actual open-abap behaviour: the argument is emitted positionally, so `input.val` is undefined and the first line that touches it throws `Cannot read properties of undefined (reading 'get')`. Nineteen calls across eight of her classes, with correct calls in the same files three lines away
- Impact on open-steamgate: the whole timeline. Twistzoomer was simply the first of the eight her sequence reached; the other seven were queued behind it. Deterministic, not a race — they chased concurrency first and it was a blind alley
- Smallest safe workaround: `sin( val = x )` written out, or lift the argument into its own variable first
- Upstream issue: none yet, branch `fix/builtin-not-a-method`, which carries both halves — the name and the argument shape — since they are the same defect one layer apart. It sits on `fix/conv-builtin-type-name` (PR #1842) because a built-in only goes unrecorded in an expression that also loses a constructor expression's type, so the test cannot be written without it; four other shapes were tried. **This is the tail of a defect this session fixed earlier and did not fix far enough.** `isBuiltinMethod` was taught to recognise built-ins the syntax check had not recorded, so the *name* came out right; `findMethodReference` still returns nothing for them, and the parameter transpiler falls back to a positional argument when it has no definition. Right function, wrong shape. A built-in now brings its own definition via `BuiltIn.searchBuiltin`
- Regression-test location: `test/builtin/cos.ts` on the branch — runs the expression, and separately asserts that no `builtin.sin(` or `builtin.cos(` is followed by anything but a brace, so a regression fails on the shape rather than on a value that happens to be zero
- **Checked 2026-09-18, on published 2.13.88.** `zcl_o4d_twistzoomer` line 59, the class this was found in, is the reproducer verbatim (`CONV f( '0.5' ) + sin( lv_t * mv_zoom_speed ) * CONV f( '0.3' )`) and now emits `abap.builtin.sin({val: …})`. Over the whole build there is no `abap.builtin.<fn>(` followed by anything but `{`
- Upstream version containing a fix: `2.13.88`, indirectly

### DEBT-2026-09-14-no-push-to-abaplint — We can push a branch to the transpiler and not to abaplint

- Status: `open`
- Discovery date: `2026-09-14`
- Affected versions: n/a, a process fact
- Affected ABAP statement, runtime API or adapter: none
- Minimal ABAP reproducer: none
- Exact command used to run it: `gh api repos/abaplint/abaplint --jq .permissions` against `gh api repos/abaplint/transpiler --jq .permissions`
- Expected SAP behaviour: n/a
- Actual behaviour: `abaplint/transpiler` gives us `push: true`, `abaplint/abaplint` gives `push: false`. So Lars's advice — make the PR from a branch inside the repo, or the regression and performance workflows never run — **can be followed for the transpiler and cannot be followed for abaplint**. Their `regression.yml` skips forks by an explicit condition, `github.repository == 'abaplint/abaplint'`, with a comment in the file saying as much, and `coverage.yml` is push-only too. A fork PR there runs `main.yml` and `playground.yml` and nothing else
- Impact on open-steamgate: our first core fix, `fix/arithmetic-calculation-type`, cannot arrive with the evidence a transpiler PR arrives with. The mitigation is to run `.github/regression/run.js` locally, which is what the workflow does — build the CLI before and after and compare across real repositories — and put the result in the PR body. Roughly a thirty-minute job and it needs the network
- Smallest safe workaround: the fork `oisee/abaplint` exists as of 2026-09-14 and #4291 came from it. Asking Lars for push access would be better, since it is the only way the regression evidence can arrive with the pull request rather than pasted into it
- Upstream issue: none; nothing to file, this is about our access
- Regression-test location: `npm run parked` prints the constraint against each repository, so nobody has to remember which of the two rules applies
- Upstream version containing a fix: `n/a`

### ANOMALY-2026-09-14-arithmetic-typed-as-character — Arithmetic with a character literal is typed by the literal

- Status: `fixed upstream: abaplint/abaplint#4293, merged 2026-09-14, first released in @abaplint/core 2.120.53; this tree already has it`
- Discovery date: `2026-09-14`
- Affected versions: `@abaplint/core 2.120.50`
- Affected ABAP statement, runtime API or adapter: the inferred type of `DATA(x) = <arithmetic expression>`
- Minimal ABAP reproducer:

```abap
DATA lv_f TYPE f.
DATA(a) = lv_f * '0.25'.   " typed Character(4), should be f
DATA(b) = lv_f + '0.25'.   " typed Character(4), should be f
DATA(c) = lv_f * 2.        " typed f, correct
```

- Exact command used to run it: transpile and read the `let` line in the output; found by open-steamgate driving vivid-vibes, stack `Float.set` ← `Table.cloneRow` ← `APPEND` ← `zcl_o4d_sales_dance=>get_dancing_values`
- Expected SAP behaviour: the result of an arithmetic expression is never character-like. With an operand of type `f` the calculation type is `f`; a character operand is converted into it, it does not become the result type
- Actual open-abap behaviour: the inline declaration takes the character literal's type **and its length**, so `sin( x ) * '0.25'` yields `c(4)` and `lv_pulse * '0.3'` yields `c(3)`. An integer literal does not do this
- Impact on open-steamgate: two ways, and the quiet one is worse. Loud: appending such a variable to a table of `f` raised `CX_SY_CONVERSION_NO_NUMBER` and killed her channel at bar 6. Quiet: the value is truncated to the literal's length, so her dance bars were computed from `9,4` instead of `9.4983552631578956` — right shape, two significant digits, no complaint from anything
- Smallest safe workaround: `CONV f( '0.25' )` in the expression, or declare the variable rather than inferring it
- Upstream issue: **PR [abaplint/abaplint#4293](https://github.com/abaplint/abaplint/pull/4293)**, opened 2026-09-14 from the fork `oisee/abaplint`, rebased on #4290. This is `@abaplint/core`, not the transpiler: the transpiler asks the scope for the variable's type and faithfully emits the answer it gets. Reproduced independently by open-steamgate on 2026-09-14 with a fourth line that narrows it: `DATA(d) = lv_f * CONV f( '0.25' ).` gives `f`, so it is the bare character literal, not the mixed arithmetic. Two cases wider than the report, both found while fixing: `lv_f * lv_c` with a character **variable** gave `Character(10)`, and `lv_p * '0.25'` gave a character field rather than packed
- What the fix does: `Source.runSyntax` walked the operands and let each one replace the running context, so the last operand won. It now records that an `ArithOperator` has been seen and from that point combines rather than replaces, using ABAP's calculation type — decfloat34, decfloat16, f, p, int8, i — with character-like operands transparent. Outside arithmetic nothing changes, and the concatenation path still returns `StringType`. Conservative in two places: when neither operand is numeric the previous behaviour stands, and a void or unknown operand wins, because not knowing an operand means not knowing the result
- Verification: abaplint core's own suite, 10977 passing and none failing before, 10984 and none failing after, lint clean. Seven new tests in `basic_variables`, five of which fail without the change; the other two are the cases that were already right and could plausibly have broken
- Regression-test location: none here; belongs upstream
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-14-float-separator-not-inverse — A float could not read back what it had just written

- Status: `fixed upstream: abaplint/transpiler#1847`
- Discovery date: `2026-09-14`
- Affected versions: `@abaplint/runtime 2.13.86`
- Affected ABAP statement, runtime API or adapter: `Float.get`/`Float.set`, `DecFloat34.get`/`DecFloat34.set`, so any move of a float through a character field
- Minimal ABAP reproducer:

```abap
DATA float TYPE f.
DATA ch TYPE c LENGTH 30.
DATA back TYPE f.
float = '9.79440789'.
ch = float.      " 9,7944078900000004E+00
back = ch.       " CX_SY_CONVERSION_NO_NUMBER
```

- Exact command used to run it: `npx mocha build/test/types/float.js`; found by open-steamgate from a trace line that showed the comma one field before the exception
- Expected SAP behaviour: the pair round-trips. SAP localises the decimal separator on the way out and accepts it on the way back
- Actual open-abap behaviour: `get()` wrote a comma and `set()` accepted only a point. `DecFloat34` was worse and silent: `parseFloat` stops at the comma, so reading back `9,79440789` gave `9` with no error
- Impact on open-steamgate: this is what turned the type defect above into a dead channel rather than a wrong number. Her page reported it as "Disconnected", because a client cannot tell a handler that raised from a network that dropped
- Smallest safe workaround: none needed now
- Upstream issue: none yet, branch `fix/float-separator` in `abaplint/transpiler`. `set()` accepts both separators — the comma because that is what `get()` writes, the point because ABAP source literals carry one and `CONV f( '0.25' )` is everywhere. `get()` is unchanged: `test/statements/write.ts:209` asserts the comma at ABAP level, so the output side was verified against a system
- Regression-test location: `test/types/float.ts` (round trip, point still a point, `'1,2,3'` still raises) and `test/types/decfloat34.ts`
- Upstream version containing a fix: `2.13.87`

### ANOMALY-2026-09-14-source-position-without-raise — `get_source_position( )` crashes on an exception the runtime raised

- Status: `fixed upstream: open-abap/open-abap-core#1219`
- Discovery date: `2026-09-14`
- Affected versions: `open-abap-core` before #1219
- Affected ABAP statement, runtime API or adapter: `cx_root~get_source_position`, so every exception the runtime raises itself — `CX_SY_CONVERSION_NO_NUMBER`, `CX_SY_ZERODIVIDE` and the rest
- Minimal ABAP reproducer:

```abap
TRY.
    DATA(lv_f) = CONV f( 'not a number' ).
  CATCH cx_root INTO DATA(lx).
    lx->get_source_position( IMPORTING source_line = DATA(lv_line) ).
ENDTRY.
```

- Exact command used to run it: `npm run unit` in open-abap-core with that test class
- Expected SAP behaviour: a position, or at worst the fallback the method already writes
- Actual open-abap behaviour: `Cannot read properties of undefined (reading 'INTERNAL_LINE')`. `EXTRA_CX` is attached by the transpiled `RAISE` statement (`raise.ts:104`); an exception the runtime raises never goes through `RAISE`, so it has none, and `this.EXTRA_CX.INTERNAL_LINE || 1` throws on the property access before the fallback can be reached
- Impact on open-steamgate: this is the one that actually cost the three blind runs, not the missing text. Their channel logged an empty reason, and the natural next step — asking the exception where it came from — would have replaced a silent failure with a louder unrelated one
- **Correction, 2026-09-14.** This entry previously said the exception had *no text*, and that `throwError` not calling `constructor_` was why. Both were wrong, and measured to be wrong the next morning: `get_text( )` returns "Conversion no number" on a runtime-raised exception, constructed or not, because `cx_root~constructor` only sets `previous` and `textid` and `get_text` goes through `cl_message_helper`, which needs neither. The real empty-reason bug was open-steamgate's `String(error?.message ?? error)`, where `??` does not fire on `""` — see [[ANOMALY-2026-09-14-exception-with-no-message]] in their half. Two wrong causes for one symptom, and the entry named neither
- Smallest safe workaround: none needed now
- Upstream issue: **[open-abap/open-abap-core#1219](https://github.com/open-abap/open-abap-core/pull/1219)**, merged and approved 2026-09-14. Two question marks; the fallbacks were already written and unreachable
- Regression-test location: `src/exceptions/cx_root.clas.testclasses.abap`, raising through `CONV` rather than `RAISE` so it goes down the path that had no cover
- Upstream version containing a fix: the commit after #1219
- Related: the position it returns is still the fallback, because nothing attaches a real one. `tools/osd-where.mjs` answers the actual question from the source maps instead

### ANOMALY-2026-09-14-sy-tabix-hashed — `sy-tabix` is a row number in a loop over a hashed table

- Status: `fixed upstream: abaplint/transpiler#1848`
- Discovery date: `2026-09-14`
- Affected versions: `@abaplint/runtime 2.13.86`
- Affected ABAP statement, runtime API or adapter: `LOOP AT` over a hashed table, and `LOOP AT ... USING KEY` with a hash secondary key
- Minimal ABAP reproducer:

```abap
DATA lt TYPE HASHED TABLE OF ty WITH UNIQUE KEY id.
LOOP AT lt INTO DATA(ls).
  lv_out = lv_out && |{ sy-tabix }|.   " 123, a system writes 000
ENDLOOP.
```

- Exact command used to run it: `npx mocha build/test/statements/loop.js`
- Expected SAP behaviour: `000`. A hashed table has no row order, so ABAP reports no position rather than inventing one
- Actual open-abap behaviour: `123`. A position that looks usable and is not
- Impact on open-steamgate: compounded with [[ANOMALY-2026-09-13-sy-tabix-not-restored]] in her `send_megademo`. Her `gt_registry` is `HASHED TABLE OF REF TO zcl_o4d_demo`, so an inner loop over it both invented an index and kept it. Restoring already made her caller correct; this makes the value itself correct for anyone who reads it
- Smallest safe workaround: do not read `sy-tabix` in a loop over a hashed table, which is also the rule on a system
- Upstream issue: none yet, branch `fix/sy-tabix-restore` in `abaplint/transpiler`, alongside the restore fix, since the two are siblings and one test file covers both
- Regression-test location: `test/statements/loop.ts`, two cases: hashed gives `000`, sorted still gives `12`
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-13-sy-tabix-not-restored — An inner loop keeps the outer loop's `sy-tabix`

- Status: `fixed upstream: abaplint/transpiler#1848`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/runtime 2.13.86`
- Affected ABAP statement, runtime API or adapter: `LOOP AT` and `sy-tabix`
- Minimal ABAP reproducer:

```abap
LOOP AT lt_outer INTO DATA(lv_o).
  LOOP AT lt_inner INTO DATA(lv_i).
  ENDLOOP.
  lv_out = lv_out && |{ sy-tabix }|.
ENDLOOP.
```

- Exact command used to run it: `npx mocha build/test/statements/loop.js` in the transpiler checkout; found by open-steamgate driving vivid-vibes' `send_megademo`
- Expected SAP behaviour: `123`. A loop owns `sy-tabix` only while it runs; leaving it, by `ENDLOOP` or `EXIT` or `RETURN` or an exception, restores what the enclosing loop had
- Actual open-abap behaviour: `333`. The inner loop leaves its own last index behind, so the outer body reads the inner loop's row number as its own
- Impact on open-steamgate: her `send_megademo` calls `zcl_o4d_demo=>get( )` in the loop body, which walks its own table, and then writes a separator when `sy-tabix > 1`. The separators land wrong, and the frame is a JSON array that is well formed everywhere except one character. Nothing on our side reports anything; the browser says `Expected ',' or ']' after array element in JSON at position 236`. Same family as the day's other findings: output that is valid-looking, plausible, the right size, and wrong
- Smallest safe workaround: read `sy-tabix` into a variable as the first statement of the loop body, before anything that might loop
- Upstream issue: none yet, branch `fix/sy-tabix-restore` in `abaplint/transpiler`, commit `be5d4db9`. Save on entry, restore in the `finally` that already runs, so every exit path is covered by construction. Full suite 2224/133 before, 2227/130 after, and the three that moved are the new tests
- Regression-test location: `test/statements/loop.ts`, three cases: nested, inner loop left with `EXIT`, and a method that loops called from a loop
- Upstream version containing a fix: `2.13.88`

### DEBT-2026-09-13-runtime-not-linked — The transpiler is linked from our clone, the runtime is not

- Status: `not live, 2026-09-18` — both are published 2.13.89 and neither is a symlink, so the two cannot disagree today. The entry stays because the shape comes back with the next carried fix, and `transpiler:which` is the thing that would catch it
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler-cli` linked, `@abaplint/runtime 2.13.86` published
- Affected ABAP statement, runtime API or adapter: none; a build-topology note
- Minimal ABAP reproducer: none
- Exact command used to run it: `ls -la node_modules/@abaplint/`
- Expected SAP behaviour: n/a
- Actual open-abap behaviour: only `transpiler-cli` is a symlink into `~/dev/transpiler`; `@abaplint/runtime` in each consuming tree is the published copy. So a fix in `packages/transpiler` or `packages/cli` reaches a rebuild immediately and a fix in `packages/runtime` does not, and the two feel identical from the outside. The `sy-tabix` fix above is a runtime fix and is therefore *not* in any running demo
- Impact on open-steamgate: a fix can be reported as done and still be absent from the process that needed it. Whoever wants a runtime fix locally has to link `@abaplint/runtime` too, deliberately, and say so here
- Smallest safe workaround: `npm run runtime:local`, which symlinks the path directly. **Not `npm link`**: that resolves through the global npm directory, a third place with its own idea of which checkout is current. open-steamgate linked the runtime that way on 2026-09-13 and got commit `1889911` beside a CLI at `058df744` — two checkouts in one tree, both `package.json` files saying `2.13.86`, nothing on the surface able to tell them apart. `transpiler:which` printed the two commits side by side and that is how it was found
- Third thing, and the one with no tool behind it: a checkout can also be pointed at an **unreleased abaplint**, which `transpiler:which` does not report because it only looks at the transpiler and the runtime. Done once on 2026-09-14 to check whether `abaplint/abaplint#4290` made the test in `abaplint/transpiler#1842` pass before its release — it did, and it also showed the test would still have been red for an unrelated reason, which is why it was worth doing. The recipe, and the trap in it: replace the worktree's `node_modules` symlink with a real directory symlinking every package except `@abaplint/core`, point that at the abaplint clone, **and do the same for `packages/extras`**, which has a second copy of core; then check all four resolution points agree before believing anything. Reverted immediately afterwards
- Second thing a linked tree does that a clean clone does not: **it changes under you**. The transpiler checkout is shared, and on 2026-09-13 open-steamgate measured all four CLI/runtime combinations while this session had HEAD briefly on a branch off `main` for an unrelated PR. Three of the four rows were real; the fourth said the two fixes could not coexist, and was reading a moved HEAD. Whoever moves that HEAD says so first
- **Seen again, 2026-10-02.** CI links the fork's runtime and the lockfile still held npm 2.13.89, whose `expand_in.js` lacks `BT`: a piled L3 rule (`IN <range>` with `I BT`) was green in CI and raised `IN, I BT not supported` on the plain `npm ci` route. Fixed by pinning `@abaplint/runtime` at `^2.13.96` (2.13.93 is the lowest published release with BT; 2.13.90 to 2.13.92 lack it), see `docs/dsl-l3.md`, "Piles and set parameters". Reproduced on a clean clone: `ZCL_L3_FLEET_PROOF`/`MODE_S` fails on 2.13.89 and passes on 2.13.93
- **Seen a third time, 2026-10-02, caused by the fix above.** #455 moved the runtime to 2.13.96 and left `@abaplint/transpiler` at 2.13.89, so the npm route ran a 2.13.89 transpiler against a 2.13.96 runtime. Runtime 2.13.93 changed `DELETE ADJACENT DUPLICATES` without `COMPARING` to compare the primary key (for a `WITH DEFAULT KEY` table the non-numeric components only, as on a system) and added an `allFields` option; transpiler 2.13.93 started emitting `allFields: true` for `COMPARING ALL FIELDS`. A 2.13.89 transpiler emits nothing for it, so on the new runtime `COMPARING ALL FIELDS` silently became "compare the default key". `ZCL_OSD_DEMO_TAXI`/`GRAIN_AND_MARKS` found it: its group table leaves the `i` hour out of the default key, two facts of 20250106 (FACT_ID 9000000489 hour 3 and 9000000491 hour 5, both Manhattan / Lenox Hill East / Card, no row at hour 4) became adjacent equals and 3000 groups counted 2999. Measured on a clean clone, taxi class only: transpiler 2.13.89 + runtime 2.13.89 pass, 2.13.89 + 2.13.96 fail, 2.13.96 + 2.13.96 pass. CI stayed green because it links the fork's transpiler, which already emits `allFields`. Fixed by moving `@abaplint/transpiler` and `@abaplint/transpiler-cli` to `^2.13.96` with the runtime; the generator was right. The same generated statement also appears in four more modules (`ZCL_OSG_JSON_MATCHER`, `ZCL_ZSTG_DEMO_DPC_EXT`, two lift demos), but there it gives the same result: their rows are character-like only, so the default key covers every field, or the deduplicated table is hashed. Taxi is the one demonstrated wrong result. The bump is a whole compiler upgrade (56 upstream commits from 2.13.89 to 2.13.96: FOR ALL ENTRIES batching, numeric DO conversion, LOOP fixes, DATASET), so on the npm route generated code changes beyond this statement; CI links the fork and does not exercise that route. Rule this adds: the transpiler and the runtime move together on the npm route, one version each
- **Where it surfaces next** (dell, review of #455): in `.github/workflows/gogen.yml` the `gogen` and `unit-inventory` jobs run on the npm runtime after `npm ci` and link no fork; only `osgo-parity` links it. The first thing that exists only in the fork and is needed there fails in those two jobs first.
- Upstream issue: none; this is ours. Related: `DEBT-2026-09-13-linked-transpiler`
- Regression-test location: `tools/osd-transpiler.mjs` now prints both, and `npm run transpiler:which` says in two lines which transpiler wrote the code and which runtime will execute it. That is the check; it does not make the two match, it makes the mismatch visible. `npm run runtime:local` links the runtime deliberately, the same way `transpiler:local` does
- Upstream version containing a fix: `n/a`

### ANOMALY-2026-09-13-xstring-as-hex — An xstring costs two characters per byte, twice over

- Status: `open`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/runtime 2.13.86`
- Affected ABAP statement, runtime API or adapter: `xstring` itself, and anything that moves a large one: `WWWDATA_IMPORT`, `SCMS_BINARY_TO_XSTRING`, a media response
- Minimal ABAP reproducer: read a four megabyte W3MI object and send it as a response
- Exact command used to run it: open-steamgate serving her 4 MB MP3 through the SMW0 chain, measured over twenty-four requests
- Expected SAP behaviour: an xstring is bytes and costs bytes
- Actual open-abap behaviour: the runtime carries an xstring as a hex string, two characters to the byte, and the SMW0 path holds it twice at once, once sliced into a table and once joined back. Serving 4 MB costs about 24 MB of transient strings per request; the heap goes 744 MB to 901 MB over twenty-four requests and then flattens, so it is a plateau rather than a leak
- Impact on open-steamgate: nothing breaks. It is the reason a media-heavy page is expensive rather than cheap, and it will be the reason the browser bundle is heavy when the media go into it
- Smallest safe workaround: none worth having. Reading the file from disk instead was considered and rejected, because `WWWDATA_IMPORT` has to return a table the caller loops over and her CCP class does exactly that
- Upstream issue: none. The real fix is an xstring carried as a byte buffer rather than a hex string, which is the open-abap runtime's shape rather than something a caller can route around, and it is a large change. Recorded because the number is worth having before someone diagnoses it as a leak
- Regression-test location: none
- Upstream version containing a fix: `unknown`

### DEBT-2026-09-13-linked-transpiler — This tree may be built by a transpiler that is not published

- Status: `paid, 2026-09-18` — the tree builds with published `@abaplint/transpiler` / `@abaplint/runtime` 2.13.89 and nothing is linked. The banner and the two switches stay, because the next unreleased fix will want them
- Discovery date: `2026-09-13`
- What it is: four transpiler defects found on oisee/vivid-vibes are fixed in a local branch of `abaplint/transpiler` (`fix/conv-builtin-type`) and not released. `npm link @abaplint/transpiler-cli` puts that build in a tree, which is what makes SMW0 content, the vivid-vibes effects and anything else those four fixes touch work at all
- The cost, said plainly: a linked tree differs from a clean clone, so `npm test` can be green here and red in CI, and nothing about the repository says why. That is the same failure the W3MIMETABTYPE hunt cost a morning on, and it is worth having a rule about rather than a memory
- What keeps it honest: every transpile prints which transpiler produced it, published or local, and a local one prints the path, the branch and the commit (`tools/osd-transpiler.mjs`, first line of `npm run transpile`). `npm run transpiler:which` answers on demand. So a green run here and a red one in CI are one line apart from being explained rather than a mystery
- How to switch: `npm run transpiler:local` links the local build, `npm run transpiler:published` puts the released one back. `npm ci` and `npm install` silently drop the link, which the banner then says
- Who is on it: the transpiler session's tree is linked; open-steamgate's is its own choice
- How it ends: four pull requests upstream, one per fix, at which point the link comes out and this entry moves to the resolved section. The four are recorded above with their reproducers
- **How it actually ended, 2026-09-18.** Three of the four (`#1843` the rearranger, `#1844` the percent, `#1846` the W3MI name) went upstream and are released. The fourth, `fix/builtin-not-a-method`, was never sent and does not need to be: `@abaplint/core` closed the underlying defect from the other end, and the reproducer has stopped reproducing (see the two entries above). `node tools/osd-transpiler.mjs` now prints `published` on both lines
- Upstream issue: none yet, deferred by Alice 2026-09-13

### DEBT-2026-09-14-ci-pinned-transpiler — The public deployment is built by an unmerged branch

- Status: `half paid, 2026-09-18` — `OSD_TRANSPILER_REF` is empty and the build step is gone; `OSD_CORE_REF` and `OSD_GUI_REF` remain, and so does this entry until open-abap-core has `SCMS_BINARY_TO_XSTRING` and the `WWWDATA_IMPORT` walk, and open-abap-gui the inbound `sapevent`
- Discovery date: `2026-09-14`
- What it is: the preview deployment builds a transpiler from a pinned commit of `oisee/transpiler` (`osd-build`, `c5a2290f`) and links it, instead of taking what npm resolves. Decided by Alice: "можно сделать один раз (или добавить режим для этого) — и записать в техдолг"
- Why it had to happen: on a published transpiler a runner writes **no** `*.w3mi.data.*` files at all, so the bundle CI builds is not the bundle this repository tests. #1845 (a binary file survives the copy to output) and #1846 (a W3MI object keyed on its name, not its file name) are both still open. Measured on the runner: `ENOENT: output/zo4d_05_copper%2epng.w3mi.data.png`. Before this, the public site had been serving a build from before the media, the Zork channel and the two new tiles — 17.7 MB of `sw.js` against the 22.8 MB built here — and nobody had noticed, because a failed deployment leaves the previous one standing
- The cost, said plainly: the public site now depends on a branch nobody has reviewed. A commit rather than a branch name is pinned on purpose, so the site cannot change because somebody pushed to `osd-build` this morning; the price of that is that moving the pin is a commit here
- What keeps it honest: `OSD_TRANSPILER_REF` is a plain environment variable at the top of the workflow. Empty means "take what npm gives" and the whole step is skipped, so the day the fixes are released the debt is paid by deleting one line. `tools/osd-transpiler.mjs` runs at the end of the step and prints which transpiler produced the build, into the run log
- Related: `DEBT-2026-09-13-linked-transpiler`, which is the same divergence on a developer's machine. This one is that divergence made public
- How it ends: #1845 and #1846 merged and released, then `OSD_TRANSPILER_REF: ""` and the step goes
- **Half of it ended 2026-09-18**: 2.13.88 carries #1844, #1845, #1846, #1863 and #1869, and 2.13.87 carried #1843 and #1847, so the transpiler pin and the whole clone-and-compile step came out. What is left pinned is the two ABAP libraries, which are a different debt wearing this one's name: `OSD_CORE_REF` (open-abap-core, `SCMS_BINARY_TO_XSTRING` and the `WWWDATA_IMPORT` remainder) and `OSD_GUI_REF` (open-abap-gui, the `sapevent` branch). Neither has been offered upstream yet
- Upstream issue: the two pull requests above, both merged and released

### ANOMALY-2026-09-13-binary-file-to-output — A binary file is corrupted on the way to output

- Status: `fixed upstream: abaplint/transpiler#1845, released in 2.13.88`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler-cli 2.13.86`
- Affected ABAP statement, runtime API or adapter: the CLI's copy of non-ABAP files, `FileOperations.readAllFiles` and `writeFiles`
- Minimal ABAP reproducer: none; put a PNG in a W3MI object and transpile
- Exact command used to run it: `abap_transpile` on a tree with `*.w3mi.data.png`
- Expected SAP behaviour: n/a, a tooling defect. The bytes that went in should come out
- Actual open-abap behaviour: the file was read and written as UTF-8, so every byte above 0x7F became the replacement character: an 11770-byte PNG arrived as 20175 bytes and no image. Nothing reported an error, because a corrupted PNG is a perfectly valid file
- Impact on open-steamgate: every image and every sound in her demo. It is the reason the media chain could not be tested end to end until it was fixed
- Smallest safe workaround: none; exclude the binary objects from the transpile and copy them by hand
- Upstream issue: PR [abaplint/transpiler#1845](https://github.com/abaplint/transpiler/pull/1845), merged 2026-09-18 as `39af3f1c`, unchanged from the branch (`packages/cli/src/file_operations.ts` is byte-identical to `fix/binary-file-copy`). Files matching `\.(w3mi|smim)\.data\.` are read and written as `latin1`. `binary` was measured against `latin1` on Node and Bun and is the same alias, so the plainer name is used
- Regression-test location: `packages/cli` — the fix is in `file_operations.ts`; the end-to-end proof is open-steamgate serving the 11770-byte PNG byte-identical through the whole ABAP chain
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-13-percent-in-filename — A percent in a file name is not escaped in the import specifier

- Status: `fixed upstream: abaplint/transpiler#1844, released in 2.13.88`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler 2.13.86`
- Affected ABAP statement, runtime API or adapter: not ABAP — any object whose abapGit file name carries a percent, which is every W3MI (Web Repository) object, because abapGit encodes the dot of `ZO4D_06_PLASMA.PNG` as `zo4d_06_plasma%2epng`
- Minimal ABAP reproducer: none needed; a file named `a%2eb.mjs`, imported as `./a%2eb.mjs`, is `ERR_MODULE_NOT_FOUND`, and as `./a%252eb.mjs` it is found
- Exact command used to run it: `npx abap_transpile` over a repository with any SMW0 image, then `node output/init.mjs`
- Expected SAP behaviour: n/a — a runtime resolution rule, not a SAP one. A module specifier is a URL and is percent-decoded before it resolves, so a percent in a name has to be escaped as `%25`
- Actual open-abap behaviour: `init.mjs` throws `ERR_MODULE_NOT_FOUND` at boot with the module sitting beside it, so adding an image to a build takes the whole runtime down: the ADT façade and the OData front never start, not only the images
- Impact on open-steamgate: found by open-steamgate on oisee/vivid-vibes, whose media are W3MI objects. Nothing of ours carries a percent today
- Smallest safe workaround: exclude `\.w3mi\.` from the transpile, which is what the vivid-vibes staging did until this was fixed
- Upstream issue: PR [abaplint/transpiler#1844](https://github.com/abaplint/transpiler/pull/1844), merged 2026-09-18 as `f6689840`. The percent is escaped before the slash in `escapeNamespaceFilename`, and the order matters because escaping it afterwards would corrupt the `%23` the same function writes for a namespace. Both specifier writers and the CLI's `sourceMappingURL` use it
- Regression-test location: the transpiler's `test/files.ts`, upstream since #1844
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-13-w3mi-objid-encoded — The W3MI registry is keyed on the encoded file name, not the object name

- Status: `fixed upstream: abaplint/transpiler#1846, released in 2.13.88`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/transpiler 2.13.86`
- Affected ABAP statement, runtime API or adapter: `SELECT ... FROM wwwparams WHERE objid = ...` and the W3MI registry the transpiler generates
- Minimal ABAP reproducer: a W3MI object whose name carries a dot; read it back with the name that is in `<NAME>` in its own XML
- Exact command used to run it: reading an image through a handler that follows SAP's own API shape
- Expected SAP behaviour: **the plain name**, the one in `<NAME>`. Answered on 2026-09-13 by open-steamgate from the artefact rather than from a system: her page asks for `?audio=ZOISEE-EAR-02.MP3`, her handler passes that straight to `objid`, and that code runs on a real system. Evidence of that grade rather than a read of `wwwparams` on A4H, which is still worth one line the next time someone is on a system with Alice's say-so
- Actual open-abap behaviour: the registry and the `wwwparams` rows are keyed on the encoded name, `ZOISEE-EAR-02%2EMP3`, while the object's own XML carries `ZOISEE-EAR-02.MP3`, so a handler that asks the way SAP's API is asked finds nothing and returns empty rather than failing. The percent-escape is an abapGit filename spelling that should never have become a key
- Impact on open-steamgate: this is what stops the audio in the running demo. The images work only because they were asked for by the encoded name while testing, which is the failure mode in miniature: the wrong key looks like a working one until someone uses the right one
- Smallest safe workaround: ask with the encoded name
- **Addendum, 2026-09-16.** Seen again, from the other side: `npm i --no-save postject` (for a Node single-executable experiment) rewrote `node_modules` and replaced the link to the local build with the published `@abaplint/transpiler` 2.13.87, which does not carry this fix. The next build named the object `ZO4D_00_SALES%2EPNG` and `init.mjs` imported `./zo4d_00_sales%2epng.w3mi.mjs`, which Node decodes to a dot and cannot find while Bun resolves literally and can — so the compiled binary served the generation and every Node host failed at boot. `npm run transpiler:local` puts the link back; `node tools/osd-transpiler.mjs` says which build is in use. Both halves of the W3MI naming, this entry and `ANOMALY-2026-09-13-percent-in-filename`, were still local only, and this is the cost of that. Both are released in 2.13.88 (2026-09-18), so the link is gone and `npm install` can no longer undo them.
- Upstream issue: PR [abaplint/transpiler#1846](https://github.com/abaplint/transpiler/pull/1846), merged 2026-09-18 as `8a0df788`. The registry, `wwwparams` and `tadir` are all keyed on `<NAME>` now. **That merge commit also carried a change to `operators/mod.ts` that nobody on this side wrote — see `ANOMALY-2026-09-16-mod-result-integer`.** Corrected 2026-09-14: this was the transpiler's code all along, not open-steamgate's, and saying otherwise nearly left it unowned
- Regression-test location: `packages/transpiler/test/files.ts` upstream, four cases (the registry, `wwwparams`/`tadir`, a `<NAME>` inside the parameters, and the fall back to the file name)
- Upstream version containing a fix: `2.13.88`

### ANOMALY-2026-09-13-default-ignore — `DEFAULT IGNORE` is parsed and not honoured, and the project cannot switch the rule off

- Status: `fixed upstream: abaplint/abaplint#4291, merged 2026-09-14, first released in @abaplint/core 2.120.53; this tree already has it`
- Discovery date: `2026-09-13`
- Affected versions: `@abaplint/core 2.120.5`, `@abaplint/transpiler-cli 2.13.86`
- Affected ABAP statement, runtime API or adapter: `METHODS m DEFAULT IGNORE` / `DEFAULT FAIL` in an interface
- Minimal ABAP reproducer: an interface with one `DEFAULT IGNORE` method and a class that implements the interface and not that method
- Exact command used to run it: `npx abaplint`, then `npx abap_transpile`
- Expected SAP behaviour: a class need not implement an optional interface method; calling it does nothing (`IGNORE`) or raises (`FAIL`)
- Actual open-abap behaviour: `implement_methods` demands it anyway, and turning the rule off in `abaplint.jsonc` changes nothing for the transpile, which runs its own mandatory rule set rather than the project's
- Impact on open-steamgate: none of ours; found by open-steamgate on vivid-vibes, where an interface grew two methods and fifty implementors were never updated. It is the reason the repository needs 154 written-out implementations rather than two words in the interface
- Smallest safe workaround: implement the method with an empty body, which is what the patch for that repository does
- Upstream issue: **PR [abaplint/abaplint#4291](https://github.com/abaplint/abaplint/pull/4291)**, opened 2026-09-14 from the fork `oisee/abaplint`, since we cannot push a branch there. The cause was a layer below the rule: `InfoMethodDefinition` did not carry the modifier at all, so `implement_methods` had nothing to read. Two fields beside `isForTesting` and `isFinal`, and the rule skips a method that has either; `DEFAULT FAIL` is included because it is equally optional to implement. Reproduced independently by open-steamgate on 2026-09-14 with a control: removing `DEFAULT IGNORE` gives the identical message, so `implement_methods` does not read the modifier at all, although the parser understands it (`method_def.js`, 7.40 SP08)
- Regression-test location: none
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-18-html-viewer-show-url — `cl_gui_html_viewer=>show_url` of an assigned url shows the url's text, not the document

- Status: `fixed upstream` — open-abap-gui `d7dca1f` (#166, in `main` since `8a5f474`) rewrote `load_data` / `show_url` so that `show_url` of the url last loaded shows that document (`mv_external_url`); our fork commit for it was dropped when the branch was rebased onto `8a5f474`, and the build pins the rebased fork commit `31cc8b3` (branch `html-viewer-sapevent-r1`, the `sapevent` raise alone). Upstream keeps one document rather than a cache per url, which covers abapGit's order (assets first, the page last)
- Discovery date: `2026-09-18`
- Affected versions: `open-abap-gui` at `ed96e89` (upstream `main`)
- Affected ABAP statement, runtime API or adapter: `cl_gui_html_viewer->load_data( )` followed by `show_url( assigned_url )`, which is how abapGit shows every page (`zcl_abapgit_gui=>cache_asset` then `render`)
- Minimal ABAP reproducer: `load_data( IMPORTING assigned_url = lv_url CHANGING data_table = lt_html )` then `show_url( lv_url )`, then `cl_gui_control=>render_html( )`
- Exact command used to run it: `STG_PORT=3080 npx mocha test/sapevent.mjs` before the fork fix: the frame's `srcdoc` read `abapgit.html`
- Expected SAP behaviour: `load_data` puts the document into the control's data cache under the url it assigns (or the one given), and `show_url` of that url shows the document; any other url is a link the control navigates to
- Actual open-abap behaviour: the substitute set the payload to the url's text at `show_url`, so the document loaded a line earlier was replaced by its own name. `load_data` without a url also assigned nothing, so abapGit's `show_url( '' )` had nothing to name
- Impact on open-steamgate: abapGit's own page flow drew an empty frame with a file name in it; the sapevent round trip (backlog G.2) could not be run against real markup until this was fixed
- Smallest safe workaround: none here; the build takes the library from `.local/lars/open-abap-gui` and the workflows pin it by commit (`OSD_GUI_REF`)
- Upstream issue: none needed for this half; the remaining fork commit, the raise of `sapevent`, goes to open-abap/open-abap-gui as a PR after a critic pass (`docs/upstream.md`, "Beside the transpiler")
- Regression-test location: `test/sapevent.mjs` here (green at `31cc8b3`); the fork's `show_url_shows_what_was_loaded` went with the dropped commit
- Upstream version containing a fix: open-abap-gui `d7dca1f` (#166)

### ANOMALY-2026-09-19-interface-call-without-interfaces — a call through an interface the class does not implement is accepted here and refused on a system

- Discovery date: `2026-09-19`
- What happened: `zcl_zstg_demo_dpc_ext` has, and has had since the search
  help was added, `me->/iwbep/if_sb_gendpc_shlp_data~get_search_help_values(
  ... )`, while no class in its hierarchy declares
  `INTERFACES /IWBEP/IF_SB_GENDPC_SHLP_DATA`. `npm test` is green, abaplint
  says nothing, and the request is served here. A4H refuses to activate it:
  *"The class ZCL_ZOSD_005_DEMO_DPC_EXT does not contain an interface
  /IWBEP/IF_SB_GENDPC_SHLP_DATA. However, there is a similarly named
  interface /IWBEP/IF_SB_GEN_DPC_INJECTION."*
- What is right: A4H. `me->intf~meth` requires the class to implement the
  interface; the interface existing is not enough. The interface does exist
  on A4H, in `/IWBEP/SB_GENDPC_SHLP`, and open-abap-odata has it too — so
  both sides resolve the **name**, and only one checks the **binding**
- Why it stayed invisible: the call is legal-looking and the type
  (`=>tt_result_list`) resolves either way, so nothing on this side has a
  reason to ask. It took a real system to ask
- What was done about it: not a workaround. The model was missing the data
  source the code already used — `StatusVH` now maps its query operation to
  `ZSTG_STATUS_SH` in `src/demo/zstg_demo.stg.yaml`, so segw-gen writes the
  `INTERFACES` line into the generated `_DPC`, which is where SEGW puts it.
  Measured before deciding where: the DPC of [GWSAMPLE_BASIC](https://help.sap.com/docs/ABAP_PLATFORM_NEW/68bf513362174d54b58cddec28794093/59283fc4528f486b83b1a58a4f1063c0.html)
  declares three interfaces (`IF_SB_DPC_COMM_SERVICES`,
  `IF_SB_GENDPC_SHLP_DATA`, `IF_SB_GEN_DPC_INJECTION`); eight corpus DPCs
  declare the first and third and **none** declares the second, and none of
  the eight maps a search help. So the third is conditional on the mapping,
  which is exactly what our generator already did with `hasShlp` — the
  generator was right and the tree was wrong
- Upstream: **needs an issue** in abaplint. A syntax rule for "call through
  an interface the class does not implement" would have caught this here,
  and would catch it for everyone generating ABAP for a real system. No fix
  proposed; the reproducer is four lines

### NOTE-2026-09-19-date-facets — one facet differs, and it took three readings to say which

Written down mostly as a record of getting the same small question wrong
twice out loud before reading the code that answers it.

- Discovery date: `2026-09-19`
- The tree, after `type: Date`, carries `Edm.DateTime`, `TYPE_NAME SYDATE`,
  `TYPE_KIND D`, `LENGTH 8` and **no** `PROP_PRECISION` — SAP's own sample
  projects' shape for a date
- A4H answers `<Property Name="FlightDate" Type="Edm.DateTime"
  Precision="0" sap:unicode="false" sap:label="Flight date"/>` — a
  precision nothing in the tree asked for, and no `sap:display-format`
- **`Precision` is not a divergence.** Said twice that it was, in opposite
  directions, both times from a reading rather than the code.
  `zcl_oao_http_handler` emits `Precision="{ mv_precision }"`
  *unconditionally* for `Edm.DateTime`, and `mv_precision` is an `i`, so a
  property whose MPC never calls `set_precison` gets `Precision="0"` here
  too. Same answer, different route
- **`sap:display-format` is the one that differs.** We derive it in
  `zcl_oao_entity_typ=>bind_structure` for a DATS-bound field; 38
  `Edm.DateTime` properties across 17 real `$metadata` documents in the
  corpus (measured by fable-osd) and one live A4H service carry it **zero**
  times. 39 observations, no occurrences, several vendors
- **And it is still not enough to act on.** All 39 could share a binding
  style; the case that would settle it is a SAP-delivered service with a
  DDIC-bound date. Tried on A4H: a Gateway demo service answers 403 and
  a test application service 500 for this user, and the EPM-RFC-SAMPLE
  service and GWSAMPLE_BASIC are not activated. So
  the measurement is blocked on an authorisation, not on an argument, and
  nothing changes until it is not
- What fable-osd's numbers do settle: `Precision` on `Edm.DateTime` is
  derived from the ABAP type, `0` for DATS (26 properties) and `7` for
  TIMESTAMP (9). The three with no `Precision` at all are Northwind in a
  `localService` copy, not a Gateway's answer

### ANOMALY-2026-09-12-transpiler-concat-chain — An `&`/`&&` chain nests one concat( ) call per operand

- Status: `fixed upstream, workaround removed`
- Discovery date: `2026-09-12`
- Affected versions: `@abaplint/transpiler-cli 2.13.85`
- Affected ABAP statement, runtime API or adapter: `a & b & c ...` (also `&&`), `abap.operators.concat`
- Minimal ABAP reproducer: the `IF_SADL_GW_DPC_UTIL~GET_DPC` segw-gen writes for a project with many entity sets (`gen/stg/zstg_segw/zcl_zstg_segw_dpc.clas.abap`, 55 sets, ~830 operands)
- Exact command used to run it: `npm run e2e:preview` (the service worker refuses the bundle: "ServiceWorker script evaluation failed", CDP says "Maximum call stack size exceeded"; Node and a dedicated worker parse the same file)
- Expected SAP behaviour: a chain of any length is one string expression
- Actual open-abap behaviour: `concat(a, concat(b, concat(c, ...)))`, one nesting level per operand; the runtime already accepts `concat([a, b, c])` (used for constant chains) but the Source transpiler does not emit it
- Impact on open-steamgate: the browser preview (GitHub Pages) fails to install its worker once any transpiled class carries a chain of ~800 operands
- Smallest safe workaround: `tools/segw-gen.mjs` builds a SADL definition longer than `SADL_CHUNK` (200) lines in pieces (`lv_sadl_xml = lv_sadl_xml & ...`); every SAP project we have is shorter (85 max), so their generated classes are unchanged
- Upstream issue: **[abaplint/transpiler#1836](https://github.com/abaplint/transpiler/pull/1836)**, merged and released in `@abaplint/transpiler 2.13.87` on 2026-09-14. The workaround is gone from both generators — `tools/segw-gen.mjs` and `src/segw/zcl_stg_segw_gen_dpc.clas.abap` — which had to move together, because a test compares them byte for byte. Measured before removing rather than after: 1200 operands now emit one `concat( )` call, where the nesting used to be one per operand. ZSTG_SEGW's definition is back to a single 836-line chain, past the 800 the service worker's stack used to give out at, and the whole Playwright suite is green
- Regression-test location: `test/e2e/preview.spec.mjs` (the preview installs), `test/stg-compile.mjs`
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-13-bun-percent-encoded-specifier — Bun does not decode `%23` in an ESM specifier

- Status: `workaround`
- Discovery date: `2026-09-13`
- Affected versions: `bun 1.4.2`, `@abaplint/transpiler-cli 2.13.86`
- Affected ABAP statement, runtime API or adapter: not ABAP — the transpiled output of any `/NAMESPACE/`-prefixed object, whose file name carries `#` and whose importers write it percent-encoded (`await import("./%23iwbep%23cl_mgw_data_util.clas.mjs")`)
- Minimal ABAP reproducer: none needed; two files, `mod.mjs` renamed to `#h#mod.mjs`, imported once as `"./%23h%23mod.mjs"` and once as `"./#h#mod.mjs"`
- Exact command used to run it: `node enc.mjs` / `bun enc.mjs` (percent-encoded) and `node lit.mjs` / `bun lit.mjs` (literal)
- Expected SAP behaviour: n/a — this is a runtime divergence, not a SAP one. Node resolves the percent-encoded form and refuses the literal; Bun does the exact opposite, so no single specifier satisfies both
- Actual open-abap behaviour: under Bun the run dies at the first such import with `Cannot find module "./%23iwbep%23cl_mgw_data_util.clas.mjs"`. 99 files in `output/` carry a `#` today
- Impact on open-steamgate: nothing today (we run Node), and **narrower than first written**. Measured 2026-09-14: it blocks the interpreted path (`bun entry.mjs`) and `bun build --compile` from the command line, which takes no plugin. It does **not** block packaging. `Bun.build({compile, plugins})` with a five-line `onResolve` that decodes `%23` produces a binary that runs and prints the value from the namespaced module. So single-binary packaging needs the plugin, not the upstream fix, and #1841 stops being a gate for it
- Smallest safe workaround: rename `#` out of the file names in a copy of `output/` and apply the same substitution inside relative `./*.mjs` specifiers (`.local/dehash.mjs`, ~20 lines, 99 renames and 22 rewrites). With it Bun runs the same 107 ABAP Unit tests as Node and serves the gateway over HTTP; see `docs/bun-spike.md`. For a bundled or compiled build the workaround is smaller and needs no copy of `output/`: a `Bun.build` plugin whose `onResolve` filter is `/%23/` rewrites the specifier at resolve time (`.local/bun-build.mjs`). The same plugin closes `ANOMALY-2026-09-13-percent-in-filename` with a second `/%25/` filter, which is why the 172 files carrying a percent are a bundler footnote rather than the blocker they were called
- Upstream issue: https://github.com/abaplint/transpiler/issues/1841 (open 2026-09-13, filed by the transpiler session, this spike cited as the evidence). Traced to `escapeNamespaceFilename` in `packages/transpiler/src/initialization.ts` and the source-map line in `packages/cli/src/index.ts`, both of which write `/` as `%23`. Filed as an issue rather than a patch because changing the character changes every mapping from a file back to an object name, so the choice is Lars's; `$`, `-` and `_` are the candidates that need no encoding anywhere. A Bun issue for the specifier decoding is the other half and is not filed
- Regression-test location: none
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-14-bun-bundler-module-output — Bun's bundler emits module-only syntax a classic worker cannot evaluate

- Status: `open`
- Discovery date: `2026-09-14`
- Affected versions: `bun 1.4.2`, `webpack 5.110.3` (the comparison)
- Affected ABAP statement, runtime API or adapter: not ABAP — the transpiled runtime as a whole. `output/` carries `import.meta` and 8893 top-level `await`s, both of which are legal only in an ES module
- Minimal ABAP reproducer: none needed; `bun build web/preview-worker.mjs --target=browser` against any entry point whose graph contains a top-level `await` or `import.meta`
- Exact command used to run it: `bun .local/bun-build.mjs`, then `navigator.serviceWorker.register("./sw.js")` in Chromium
- Expected SAP behaviour: n/a — a bundler divergence. webpack lowers both for a non-module target: `experiments.topLevelAwait` turns a top-level await into a promise chain, and `import.meta` is rewritten
- Actual open-abap behaviour: Bun bundles the same graph successfully and 166 times faster (337 ms against webpack's 56 s, 33.3 MB unminified against 22.8 MB minified) but emits the two module-only constructs verbatim. A service worker registered without `{type: "module"}` is a classic script, so evaluation dies with `Cannot use 'import.meta' outside a module` and registration fails as `ServiceWorker script evaluation failed`. All four preview e2e tests go red; the error surfaces only when the file is loaded as a classic `<script>`, because the registration failure itself says nothing
- Impact on open-steamgate: Bun cannot replace webpack for the browser preview today. It does not touch the binary path, where the target is a module and both constructs are legal (see the entry above). It also decides the single-file HTML question: `file://` refuses `<script type="module">`, so that build needs the same lowering and therefore webpack
- Smallest safe workaround: keep webpack for `web:preview`. The alternative, registering the worker with `{type: "module"}`, is not taken: module service workers are not supported across the browsers this preview is opened in
- Upstream issue: none filed. Two halves, as with the specifier defect: Bun could lower for non-module targets, and we could stop generating top-level awaits. Neither is ours to decide alone
- Regression-test location: `test/e2e/preview.spec.mjs` (four tests, which is what caught it)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-14-general-get-random-int — `GENERAL_GET_RANDOM_INT` is not implemented

- Status: `fixed upstream elsewhere: open-abap-core#1221 was closed, and the module landed in open-abap/open-abap-deprecated#2 (merged 2026-09-18)`
- Discovery date: `2026-09-14`
- Affected versions: `open-abap-core` as cloned 2026-09-14
- Affected ABAP statement, runtime API or adapter: `CALL FUNCTION 'GENERAL_GET_RANDOM_INT'`
- Minimal ABAP reproducer: `CALL FUNCTION 'GENERAL_GET_RANDOM_INT' EXPORTING range = 10 IMPORTING random = lv_n.`
- Exact command used to run it: `npx playwright test --config playwright.preview.config.mjs -g walkthrough` — the MiniZork walkthrough replayed through the APC channel of the browser bundle
- Expected SAP behaviour: **measured on an AS ABAP 1909 sandbox rather than inferred, and the inference was wrong.** The parameter text says only "The random int will be <= range". It is uniform over `[0, range]` — `range + 1` values, not `range`: 300 calls each gave zero in 163 (range 1), 105 (range 2), 53 (range 6) and 3 (range 100), which is `1/(range+1)` at every point. `range = 0` answers `0`; `range = -5` answered `-2`, so a negative range is not an error and the span runs towards `range`. No exceptions are raised. Observed by calling it from a throwaway report and test class in `$TMP`, never by reading its implementation — an observation can be contributed upstream, an adaptation cannot
- Actual open-abap behaviour: the module does not exist, so the dynamic call raises `CX_SY_DYN_CALL_ILLEGAL_FUNC`
- Impact on open-steamgate: it is the Z-machine's `random` opcode (`local/zork/zcl_ork_00_zmachine.clas.abap:557`), so MiniZork plays perfectly until the first dice roll and then the channel dies. The first dice roll in the walkthrough is the troll fight, twenty-five commands in. Anything transpiled that needs randomness hits the same wall
- Smallest safe workaround: `src/fugr/openabap.fugr.general_get_random_int.abap` plus the FUNCNAME block in `openabap.fugr.xml`, three `@KERNEL` lines over `Math.random`. **Not** `cl_abap_random_int`, which was the first attempt and cannot express this: `cl_abap_random=>intinrange` opens with `ASSERT high > low` and `ASSERT low >= 0`, so a range of zero dumps and every negative range dumps. Reaching the contract through `abs( )` and a negation works and reads as cleverness hiding intent; it is the same `Math.random` either way, and `generate_sec_random` in that group is the precedent for the plain form. With it the whole MiniZork walkthrough plays in the browser bundle, every assertion, start to finish, three runs on the strict form of the test. The test still tolerates the old death, because a fresh clone of core does not have this file
- Upstream issue: https://github.com/open-abap/open-abap-core/pull/1221 (fork branch `general-get-random-int`; no write access on that repository, as with #1218). Agreed with the transpiler session before opening, per Alice, so the same fix is not offered twice
- Regression-test location: `test/e2e/preview.spec.mjs`, "the MiniZork walkthrough plays the same in the bundle"
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-14-exception-with-no-message — An ABAP exception reaches JavaScript with an empty `message`

- Status: `workaround`
- Discovery date: `2026-09-14`
- Affected versions: `@abaplint/runtime 2.13.86`
- Affected ABAP statement, runtime API or adapter: any `RAISE EXCEPTION` or runtime-raised `CX_*` crossing into host JavaScript
- Minimal ABAP reproducer: none needed; catch anything thrown out of transpiled code and read `error.message`
- Exact command used to run it: the APC channel of the browser bundle closing on a handler failure
- Expected SAP behaviour: n/a — a host-boundary question, not a SAP one
- Actual open-abap behaviour: the thrown value is an exception class instance, not an `Error`. It has no `message`, or one that is an ABAP string object. So the obvious host line, `String(error?.message ?? error)`, yields the empty string — the nullish coalescing does not fire on `""`
- Impact on open-steamgate: a channel closed with code 1011 and a blank reason, and a real crash in the transpiled Z-machine looked like an unexplained disconnect for an afternoon. The same shape would hide any handler failure in the bundle
- Smallest safe workaround: `tools/osd-describe.mjs`, now used by both the APC front and the service worker: it reads `constructor.INTERNAL_NAME` for the class, unwraps an ABAP string `message` through `.get()`, and appends the frames that point into `output/`. `CX_SY_DYN_CALL_ILLEGAL_FUNC (no text)` beats an empty string
- Upstream issue: none. Arguably the runtime could give exception instances a `message`; T is separately fixing `get_source_position( )`, which throws on anything the runtime raised itself
- Regression-test location: `test/osd-apc.mjs`
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-19-posted-form-has-no-fields — a form posted to a screen arrives with no form fields

- Status: `open`
- Discovery date: `2026-09-19`
- Affected versions: `express-icf-shim` as cloned 2026-09-19 (`cl_express_icf_shim`)
- Affected ABAP statement, runtime API or adapter: the request assembly of `cl_express_icf_shim~run`, seen through `if_http_entity~get_form_field` / `~get_form_fields_cs`
- Minimal ABAP reproducer: any handler that reads `get_form_field( 'name' )` behind a `<form method="post">`. The shim sets the form fields from the query string alone — `lt_fields = cl_http_utility=>string_to_fields( lv_value )` where `lv_value` is what followed the `?` — and the body, which it has already read into the request as data, is never looked at
- Exact command used to run it: `STG_PORT=3131 node test/run.mjs`, then a POST of `type=CLAS&name=ZCL_OSD_ST05&do=check` to `/sap/bc/osd/edit/`. The editor answered its **object list**: every field was empty, so the screen behaved exactly as though the person had typed nothing and pressed nothing
- Expected SAP behaviour: **documented, not measured.** No system was asked (the sandbox is only used when Alice asks), so this claims nothing about a particular release. It does not have to: the interface open-abap ships says it itself — `get_form_fields_cs` takes `search_option TYPE i DEFAULT co_body_before_query_string`. A default named "body before query string" is only meaningful if the body is a source of form fields, and here it never is
- Actual open-abap behaviour: the body survives intact as the request's data (`get_cdata` returns it), so nothing is lost — it is simply not parsed into fields. The failure is therefore **silent and total** for a posting screen: no error, no empty-ness anywhere a caller can see, just every field reading as if nobody filled it in
- Impact on open-steamgate: the editor screen (G.8) is the first page here that posts a form at all. The screens written before it did not meet this — SE16 navigates by GET, and the webgui posts through `sapevent`, which carries its payload in the URL. So the gap is one this tree could only find the day it wrote a text area
- Smallest safe workaround: `src/webgui/zcl_osd_form.clas.abap` — the query-string fields as the shim gives them, plus the body parsed when the method is POST or PUT and the content type is `application/x-www-form-urlencoded`. (Found first on 2026-09-18 in the AMDP sandbox, whose `zcl_osd_amdp_sbx=>posted_body` parses the pairs by hand; a form sends a space as `+`, and `REPLACE ... WITH ' '` replaces it with nothing, since a text literal loses its trailing blanks -- it has to be written `` WITH ` ` ``.) It is **not** `cl_http_utility=>string_to_fields`, and the two differences are required by the encoding rather than chosen: `+` is a space (that method decodes with `decodeURIComponent`, which leaves `+` alone, so a source posted through a text area would come back with its indentation turned into plus signs), and the **name** is unescaped too
- Upstream issue: none yet; the repository is open-abap/express-icf-shim. The fix belongs in the shim, where the request is assembled, and it is small — parse the body into fields when the content type says it is a form. `docs/upstream.md` carries it; it goes out under the critic gate like the rest
- Regression-test location: `test/unit/zcl_osd_form_test` — the decoding rules, and separately `the_gap_this_exists_for`, which asserts that `get_form_field` over a posted body answers **nothing**. That is the expiry: when the shim learns to parse a body, that test fails and says to delete the workaround rather than to adjust an expectation
- Upstream version containing a fix: `unknown`


### ANOMALY-2026-09-19-form-field-name-case — `get_form_field` lower-cases the question and not the answer

- Status: `fixed upstream: open-abap/open-abap-core#1253, merged 2026-09-19`
- Discovery date: `2026-09-19`
- Affected versions: `open-abap-core` as cloned 2026-09-19
- Affected ABAP statement, runtime API or adapter: `if_http_entity~get_form_field` / `~set_form_fields`
- Minimal ABAP reproducer: set a form field named `f_STATUS`, then ask for it by that exact name — nothing comes back. It is reachable by no spelling at all: `get_form_field` lower-cases what it is asked for, so the only name it can ever match is one already lower case
- Exact command used to run it: `STG_PORT=3131 npx mocha test/se16.mjs`, the data browser's per-field selection (`?t=ZC_STG_TRAVEL&f_STATUS=B*`), which silently filtered nothing
- Expected SAP behaviour: **not measured, and deliberately not claimed.** No system was asked, so this entry does not assert what SAP does. It does not need to: the inconsistency is *inside* open-abap-core and visible without any oracle — `cl_http_entity=>get_form_field` reads `READ TABLE mt_form_fields WITH KEY name = to_lower( name )`, while `set_form_fields` stores `mt_form_fields = fields` unchanged. One side normalises and the other does not, so a name that can be **set** can never be **got**. Whichever behaviour SAP has, it is not this one, because this one is not a behaviour — it is two halves disagreeing
- Actual open-abap behaviour: as above. `get_form_fields` (plural) lower-cases on the way out, which is a third spelling of the same decision and the reason the single getter's asymmetry is easy to miss
- Impact on open-steamgate: any page whose form field names are not already lower case reads them as empty. Found in the data browser (G.9 wave 2), where the field names come from DDIC and DDIC names are upper case. The failure is silent: the filter simply selected everything, which looks like a working screen with no filter typed
- Smallest safe workaround: name the form fields in lower case and ask for them that way — `f_{ to_lower( ls_field-name ) }` in `src/webgui/zcl_osd_se16.clas.abap`, both where the input is rendered and where it is read. One line each, no dependency on which half upstream fixes
- Upstream issue: https://github.com/open-abap/open-abap-core/issues/1252, opened 2026-09-19; **PR https://github.com/open-abap/open-abap-core/pull/1253** opened the same day when the maintainer asked for one. The fix compares the name case insensitively on both sides, with three tests, the first of which was checked failing on `main` by reverting the method rather than by reasoning about it. The issue names the side that looks right and says why — the header path normalises on both sides, and the interface ships `_cs` variants, which only makes sense if the plain getter is the case-insensitive one — and offers a PR with a test
- Regression-test location: `test/se16.mjs`, "filters through the same clause builder an OData $filter goes through"
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-19-bang-value — abaplint does not parse a method declared `!VALUE(x)`, and the method is lost

- Status: `fixed in this tree with @abaplint/core 2.120.59`
- Discovery date: `2026-09-19`
- Affected versions: `@abaplint/core` 2.120.55
- Affected ABAP statement, runtime API or adapter: `METHODS` / `CLASS-METHODS` with a parameter written `!VALUE(name)`
- Minimal ABAP reproducer:
  ```abap
  CLASS c DEFINITION PUBLIC.
    PUBLIC SECTION.
      CLASS-METHODS m1 IMPORTING !VALUE(iv_x) TYPE i.
  ENDCLASS.
  ```
- Exact command used to run it: parse it with `new Registry().addFile(...).parse()` and read `getFirstObject().getABAPFiles()[0].getStatements()`
- Expected SAP behaviour: **not claimed, and not needed.** The `!` is the **identifier escape** — it stops the name being read as a keyword — and it carries no meaning for the interface. (It is not `PREFERRED PARAMETER`, which is a separate `METHODS` addition; abaplint's own rule for the escape is `no_exclamation_escape`. The first version of this entry got that name wrong, and a critic caught it before it went to the people who wrote that rule.) What makes this an anomaly does not need a system: abaplint parses `!iv_x` and parses `VALUE(iv_x)`, and does not parse the two **together**. `!REFERENCE(x)` fails the same way
- Actual open-abap behaviour: the `METHODS` / `CLASS-METHODS` statement comes back as `Unknown`, so **that method** is missing from `getClassDefinition().methods`. Other methods of the class are unaffected — the first version of this entry said "the whole class", which is an artefact of a reproducer with one method in it. Nor is it silent: `findIssues()` reports a `parser_error`, but it points at the `CLASS` token rather than at the parameter, and a caller using `getClassDefinition()` sees only a missing method
- Impact on open-steamgate: rare by file count and total where it occurs — 6 of 3052 classes read off a system contain the form at all, and in those it is generated for every parameter of every method, so abaplint parses 2 of 15 methods in one class and 1 of 9 in another. (Who generates it is **not** measured: the first version of this entry said SE24, which nobody asked. abaplint#2529 floats the same guess and it is still a guess.) A body then looks as though it read an **undeclared table variable** — the refusal names `:it_ddls`, declared three lines above it in the ABAP. Measured: 171 of 364 corpus bodies had a signature carrying parameters; with the workaround, **188**
- Resolution: root `@abaplint/core` and the bundled `@abaplint/cli` are pinned to 2.120.59, matching the fork transpiler. `withoutBangValue()` and its canary were removed; the parameter test remains.
- Upstream issue: https://github.com/abaplint/abaplint/issues/4308, opened 2026-09-19; **PR https://github.com/abaplint/abaplint/pull/4311** the same day, after Lars answered "PRs welcome". Three expressions matched the keyword as a literal and all three are fixed: `MethodParam`, `MethodDefReturning` and `PassByValue`. The second was found by a test — `RETURNING !VALUE(rv_x)` still failed after the first was fixed — which is why the test cases were written before the second site was looked for. That repository takes no branch from us and its regression workflow skips forks, so an issue is the whole of what we can offer there, and the issue offers a PR if the maintainer names the shape he wants. Related upstream: abaplint#2529, the same escape in front of a builtin function, open since 2022
- Regression-test location: `test/amdp.mjs`, "a parameter written `!VALUE(x)` is still a parameter"
- Upstream version containing a fix: `@abaplint/core 2.120.57` (this tree uses 2.120.59)


### ANOMALY-2026-09-19-native-sql-colon — abaplint dropped colons inside NativeSQL (#4307)

- Status: `fixed in this tree with @abaplint/core 2.120.59`
- Affected versions: `@abaplint/core 2.120.55`
- Reproducer: `SELECT :a AS x, :b AS y FROM dummy;` inside an AMDP method was split into two NativeSQL statements and their tokens lost the colons.
- Resolution: abaplint #4307 is fixed in 2.120.59, and its canary was removed. NativeSQL token-span extraction nevertheless lost body tails and first tokens on the measured A4H corpus (teaching parsed 77→64, working parsed 223→182, package exports 894→858). `tools/amdp-extract.mjs` keeps the earlier source-position extraction, which also handles the separate #4329 parser defect.
- Regression-test location: `test/amdp.mjs`, AMDP body extraction and colon assertions.
- Upstream version containing a fix: `@abaplint/core 2.120.59` (verified by the former canary).


### NOTE-2026-09-19-shared-library-clone — a library clone shared by symlink has no private checkout

Not an anomaly in anybody's software; a property of how this tree is
arranged, written down because it produced a real disagreement about a
measurement and cost two sessions half an hour.

- Discovery date: `2026-09-19`
- What happened: two sessions counted the objects the store indexes and got
  **1134** and **1140** within a minute of each other. The repository content
  was identical — grouped by origin, the two agreed on **420** own objects
  and differed only in the libraries, 714 against 720
- Why: `.local/lars/*` are single working directories, and every worktree
  `osd-branch` makes points at them by symlink
  (`.local/worktrees/*/.local/lars -> <main>/.local/lars`). **There is no
  private checkout to differ**; there is one checkout that either session can
  move. This one was moved: a branch was created in
  `.local/lars/open-abap-core` to send open-abap-core#1253, which carried the
  clone from `4eec777` to `origin/main`, and the twenty commits in between
  added exactly six objects — `char5`, `char64`, `char100`, `char200`,
  `cx_osql_failure`, `if_ixml_text`
- What follows for `osd-branch`: a worktree is isolated **by repository and
  by `$HOME`, and not by libraries.** That is a real limit on what "a clean
  tree" means, and it is worth stating in the same breath as the Playwright
  browsers: a shared clone is shared files **and a shared checkout**, and a
  symlink makes the second look like the first
- What follows for measuring: a count of objects is only comparable when the
  library checkouts are named alongside it. The two readings were both
  correct and were about different systems
- The cheap check, which settled it in one step: print the count, the types,
  **and `git -C .local/lars/open-abap-core rev-parse HEAD` together**, so
  that a number can never travel without the state it was taken in


### NOTE-2026-09-20-generation-hash-moved — a test writes into `src/`, and the first cause I named was wrong

Not an anomaly in anybody's software yet, because it has not been isolated.
Written down because a **wrong explanation was published in a commit
message** (`735feed`) and a wrong explanation is worse than an open question:
the next person stops looking.

- What was observed: the i7's `/sap/bc/adt/core/http/build` reported
  `synchronized: false` three times, and `hashOf(root)` returned
  `0c3527a9` -> `3aa2efb4` -> `b0de031f` within a few minutes **with no
  build between them**. The last equals `liveHash`, and once the tree was
  quiet `source == live` without anything being rebuilt.
- What was in flight each time: a full `tools/osd-suites.mjs` run.
- **What I blamed, and it is not true:**
  `src/zosd_test/src/zosd_test_demo_inc.prog.abap` has been showing `M` all
  session, so I said the suites write it. They do not: its diff is
  `"comments added directly on FS` and `"+2`, a person's editor test, made
  before this session started and deliberately left alone. The file being
  dirty and the hash moving are two facts that happened to sit next to each
  other, and I joined them because one explained the other.
- What has since been ruled out, by measuring rather than reasoning: no file
  under any input folder or library folder was written in the last 90
  minutes (`find … -newermt`); `describeBuild()` is stable across repeated
  calls; and a suite that starts and recycles servers
  (`test/osd-runtime.mjs`) held the hash steady for 30 seconds of polling.
- **Isolated, 2026-09-20, in five seconds of the measurement described
  below.** `test/adt-devloop.mjs` writes `src/osd/zcl_osd_scratch.clas.abap`
  -- the state-changing half of the ADT façade is tested by locking, writing
  and activating a real class, and the façade's store writes an object where
  objects live. Its `after()` removes the file again ("the scratch object is
  a file like any other, so it is removed like one"), which is why
  `find … -newermt` afterwards shows nothing and why the hash returns to its
  old value on its own.
- **And it is not the only one.** Caught mid-run while writing this up:
  `test/cds-check.mjs` rewrites `src/cds/zc_osd_pack.ddls.asddls` to check
  that a changed annotation is noticed, and restores it -- it even carries
  an assertion of its own, "and the file is restored, or this suite breaks
  the tree it measures". Two suites, both deliberate, both tidy, and
  together they mean an input folder is in motion for part of every run.
- **So `hashOf` is right and the reader was wrong.** While that file exists
  it IS part of the tree, and a build would produce a different generation.
  Nothing to fix in the hash, nothing to fix in the test: what was missing
  is the precondition, now written down -- **`synchronized` is only readable
  when the tree is quiet.** A deploy is verified after the suites, not
  beside them.
- How it was found, kept because the shape generalises: snapshot the file
  list and sizes of `inputsOf(root)`, poll `hashOf` once a second, and on
  the first change diff the snapshot -- added, gone, resized. Thirty lines.
  It prints the file, or it prints "nothing changed under the inputs", which
  would have meant the defect was in `hashOf` itself. Either answer is one
  run away, which is the argument for writing it instead of reasoning.
- Why it matters beyond tidiness: `synchronized` is how this session decides
  whether the i7 is serving its own source, and it is read after every
  deploy. A field that is unreadable while a suite runs is a field whose
  false readings get explained away -- which is exactly what happened three
  times tonight, twice by blaming the deployment and once by blaming a test.

### NOTE-2026-09-20-i18n-not-intercepted — the preview's service worker does not see an app's i18n request

Found while giving the new ICF registry application an end-to-end check,
and **it is not that application's**: the same request fails the same way
for `zosd_status_app`, which has been deployed for a day.

- What is measured, in a persistent-context Chromium against a local
  preview build, watching every response under `/sap/bc/ui5_ui5/`:
  ```
  200 sw=true   /sap/bc/ui5_ui5/sap/zosd_status_app/Component.js
  200 sw=true   /sap/bc/ui5_ui5/sap/zosd_status_app/manifest.json
  404 sw=false  /sap/bc/ui5_ui5/sap/zosd_status_app/i18n/i18n.properties
  ```
  `fromServiceWorker` is **false** for the one that fails. The worker is in
  control (the two above it prove that), the path matches
  `SERVICE_PREFIXES` (`/sap/bc/ui5_ui5/sap` is in the generated list), and
  the page is served correctly when the same URL is fetched by hand from a
  page the worker controls -- 200, with the right content.
- So the request is **not reaching the worker at all**, rather than the
  worker answering 404. Why UI5's resource-bundle load is not intercepted
  while its module loads are is the open question. A synchronous XHR from
  `sap.ui.model.resource.ResourceModel` is the first thing to look at.
- Consequence, and it is small: the bundle falls back and the application
  renders with its default texts. Both applications list their rows. It is
  a red line in a network tab and a missing translation, not a broken app.
- Why it is written down rather than fixed now: the fix is in UI5's loading
  or in the worker's scope handling, neither of which is guessed at
  cheaply, and the application it was found on is new -- attaching an old
  defect to a new test would make the new test carry it forever.
- Where the check is: `test/e2e/preview.spec.mjs` excludes `/i18n/` from
  the 404 assertion and names this entry. When this is fixed, delete the
  exclusion; if the exclusion outlives the defect, the assertion has
  stopped testing what it says.

### NOTE-2026-09-22-packed-length-is-bytes — `P LENGTH n` is n bytes, and the portable IR reads it as n digits

- `tools/sqlscript-to-procedure-ir.mjs` (`irTypeFromAbap`) maps
  `P LENGTH n DECIMALS m` to `T.dec(n, m)`, and bare `P` to `dec(16, 2)`.
  In ABAP the length of a packed number is in **bytes**: `n` bytes hold
  `2n - 1` digits, and the default is 8 bytes = 15 digits. So a parameter
  `TYPE p LENGTH 8 DECIMALS 2` -- 15 digits -- becomes a `DECIMAL(8,2)` on
  the way to the database, which holds 8 digits: an amount above 999999.99
  overflows or is refused by the engine, depending on the dialect.
- Found by foreman-dell reading `c12329b..ddde7d7`, not by a test: no
  conformance case sends a packed parameter of more than six digits.
- Not changed in that branch, because it is the runtime's type boundary and
  a change there needs its conformance case (a `P LENGTH 8 DECIMALS 2`
  input of 15 digits through the destination, on HXE and DuckDB) before it
  is trusted. Until then, the mapping is wrong in a known direction --
  **narrower** than the ABAP type -- which fails loudly rather than
  silently for a value that does not fit.
- Where the fix goes: `irTypeFromAbap`, `scalarTypeOf` (the same literal
  form) and the DDIC catalogue's `DEC` mapping (`LENG` of a DEC field in DD03P is already digits, not bytes, so
  only the literal `P LENGTH n` form is affected).

### ANOMALY-2026-09-23-amdp-method-options — abaplint drops the whole class definition when an AMDP method uses an OPTIONS clause other than READ-ONLY

- Status: `fixed upstream: gone in @abaplint/core 2.120.62; verified 2026-09-30 by running the reproducer`; before: open
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` 2.120.55 (as installed; `npm ls @abaplint/core`)
- Affected ABAP statement, runtime API or adapter: `METHOD … BY DATABASE PROCEDURE|FUNCTION FOR HDB LANGUAGE SQLSCRIPT OPTIONS …` — the statement accepts `OPTIONS READ-ONLY` and nothing else; `OPTIONS SUPPRESS SYNTAX ERRORS`, `OPTIONS READ-ONLY SUPPRESS SYNTAX ERRORS`, `OPTIONS DETERMINISTIC` and `OPTIONS CDS SESSION CLIENT p_clnt` are all reported as "Statement does not exist in the configured ABAP version (or a parser error)". `LANGUAGE LLANG` and `BY DATABASE GRAPH WORKSPACE` are refused the same way.
- Minimal ABAP reproducer:
  ```abap
  CLASS cl_x DEFINITION PUBLIC.
    PUBLIC SECTION.
      INTERFACES if_amdp_marker_hdb.
      CLASS-METHODS m IMPORTING VALUE(iv) TYPE i EXPORTING VALUE(ev) TYPE i.
  ENDCLASS.
  CLASS cl_x IMPLEMENTATION.
    METHOD m BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT
    OPTIONS SUPPRESS SYNTAX ERRORS
    USING ztab.
      ev = 1;
    ENDMETHOD.
  ENDCLASS.
  ```
  With `OPTIONS READ-ONLY` in place of `OPTIONS SUPPRESS SYNTAX ERRORS` the same file parses and `getClassDefinition()` lists one method.
- Exact command used to run it: `new abaplint.Registry().addFile(new MemoryFile("cl_x.clas.abap", src)).parse()`, then `getFirstObject().getClassDefinition()` is `undefined` and `findIssues()` carries a `parser_error` on the METHOD line.
- Not a configuration matter: the same file fails identically under `syntax.version` `v702`, `v750`, `v755`, `v757`, `v758`, `open-abap` and `Cloud` (the extractor uses the default, `Newest`), so no version setting in `abaplint.json` parses the clause — the grammar lacks it (checked 2026-09-23 at foreman-dell's request).
- Expected SAP behaviour: all four OPTIONS forms are documented AMDP syntax (`SUPPRESS SYNTAX ERRORS`, `DETERMINISTIC` for functions, `CDS SESSION CLIENT` for CDS table functions); the class activates.
- Actual open-abap behaviour: the METHOD statement fails to parse, the method body is read as ABAP statements (more parser errors on `declare`, on a column name), and **`getClassDefinition()` answers `undefined` for the whole class**, so every method of it has no parameters.
- Impact on open-steamgate: measured on the A4H AMDP export, 17 of 181 AMDP classes lose their definition, 12 of them on exactly this clause (`SUPPRESS SYNTAX ERRORS` ×11, `DETERMINISTIC` ×1; the other 5 are GRAPH WORKSPACE and LLANG). Among them the classes of one package whose functions 15 corpus bodies call. The extractor (`tools/amdp-extract.mjs`) then had no signature for any of their methods, and a body's own `:it_configuration` was refused as an unknown table variable.
- Smallest safe workaround: `tools/amdp-extract.mjs` reads the method definitions as text (`definitionsByText`) when abaplint hands back no class definition, and for a single method abaplint dropped from a definition it did read; a section the reader cannot read whole yields no parameters for that method; the coverage instrument cross-checks that reader against abaplint on every class abaplint does read and prints the count of disagreements, so the fallback is measured where it is not the only source. It is gated, not preferred: abaplint resolves what the text reader cannot (types from includes, aliases, inheritance), and a runtime refusal on disagreement would make abaplint's right answer depend on the weaker parser (foreman-dell).
- The same clause in the **definition** has the same effect on that one method: `METHODS m AMDP OPTIONS READ-ONLY IMPORTING VALUE(iv) TYPE i EXPORTING VALUE(ev) TYPE i.` is a parser error, the class definition survives without `m`, and `m` has no parameters (two documentation demo classes and a family of compiler fixtures: 10 methods on the export, found by the cross-check below). `METHODS: a …, b ….` chains are fine.
- Upstream issue: was marked needs-issue in `abaplint/abaplint` (the statement grammars `MethodImplementation` / `BY DATABASE` and `MethodDef` / `AMDP OPTIONS`); not yet filed — goes out through the critic gate. `oisee` has no push rights there, so it is a fork PR or an issue. Fixed upstream in @abaplint/core 2.120.62; verified 2026-09-30 by running the reproducer. The reproducer parses in @abaplint/core 2.120.62 and still fails in 2.120.55; no issue was filed.
- Regression-test location: `test/sqlscript-table-function.mjs` ("method definitions read as text …" and "is what extract() falls back to …" — the second one carries the reproducer's shape and must start passing through abaplint, with the fallback no longer firing, once the grammar knows the clause)
- Upstream version containing a fix: `@abaplint/core 2.120.62` (was: unknown)

### ANOMALY-2026-09-23-amdp-scalar-optional — our compiler and abaplint accept OPTIONAL on an AMDP scalar input, which the kernel refuses

- Status: `workaround`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` 2.120.55; `tools/sqlscript-to-procedure-ir.mjs` before this entry
- Affected ABAP statement, runtime API or adapter: `CLASS-METHODS m IMPORTING VALUE(iv) TYPE <scalar> OPTIONAL …` on an AMDP method (`BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT`)
- Minimal ABAP reproducer:
  ```abap
  CLASS zcl_opt DEFINITION PUBLIC FINAL CREATE PUBLIC.
    PUBLIC SECTION.
      INTERFACES if_amdp_marker_hdb.
      TYPES: BEGIN OF ty_seen, n TYPE i, END OF ty_seen,
             tt_seen TYPE STANDARD TABLE OF ty_seen WITH EMPTY KEY.
      CLASS-METHODS m IMPORTING VALUE(iv) TYPE i OPTIONAL EXPORTING VALUE(et) TYPE tt_seen.
  ENDCLASS.
  CLASS zcl_opt IMPLEMENTATION.
    METHOD m BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
      et = SELECT :iv AS n FROM dummy;
    ENDMETHOD.
  ENDCLASS.
  ```
- Exact command used to run it: on A4H, saving the class through ADT; in abaplint, `new Registry(Config.getDefault(v757|v758|Cloud))`, `addFile`, `parse()`, `findIssues()`.
- Expected SAP behaviour (measured on A4H, throwaway class, deleted): the class does not compile -- `Use DEFAULT instead of OPTIONAL for the optional parameter "IV" of the AMDP method "M".` -- for `i` and `string` alike. On a **table** input `OPTIONAL` compiles, and an omitted table arrives in the body as an empty table (`COUNT(*)` = 0; a passed two-row table counts 2). Every OPTIONAL in the A4H AMDP export is on a table input.
- Actual open-abap behaviour: abaplint reports no issue under `v757`, `v758` or `Cloud`. Our compiler accepted the scalar OPTIONAL and bound an omitted input as ABAP's initial value -- a case the kernel never lets happen -- and a clean-room fixture of ours was written that way.
- Impact on open-steamgate: none on the measured corpus (no scalar OPTIONAL there); a hand-written AMDP class would have run here and failed to activate on a system.
- Smallest safe workaround: the compiler refuses a scalar OPTIONAL in the kernel's words and a table OPTIONAL by name ("omitted it is an empty table (measured on A4H); not carried yet"); the fixture and the tests that leaned on the omission use `DEFAULT` or pass the initial value.
- Upstream issue: **needs an issue** in `abaplint/abaplint` (a syntax check for OPTIONAL on an AMDP method's scalar parameter); not yet filed -- goes out through the critic gate.
- Upstream version containing a fix: none yet (the workaround lives in our compiler; abaplint has no check to fix)
- Regression-test location: `test/sqlscript-procedure-scope.mjs` ("OPTIONAL on a scalar is refused in the kernel's words …"), `test/sqlscript-procedure-source.mjs`, `test/amdp-cleanroom-corpus.mjs`

### ANOMALY-2026-09-23-epoch-ms-overflow — `ZCL_STG_JSON=>EPOCH_MS` overflows `i` on a system, and the transpiler runtime lets it through

- Status: `fixed in OSG` (EPOCH_MS computes in p); the transpiler runtime's missing range check is still open The transpiler runtime's `i` range check: abaplint/transpiler#1955 (open), pinned 2026-10-08 as `libs.lock.json` transpiler oisee/transpiler `local/osd-build-2026-10-08b` 753230cb = the previous pin e2a459b1 plus its four commits.
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/transpiler` 2.13.89 (npm) runtime; OSG's own `src/gateway/zcl_stg_json.clas.abap`
- Affected ABAP statement, runtime API or adapter: an arithmetic expression of `i` operands embedded in a string template, `rv_ms = |{ ( lv_days * 86400 + lv_seconds ) * 1000 }|` in `EPOCH_MS`, which every `Edm.DateTime` of a JSON answer goes through
- Minimal ABAP reproducer: `DATA li TYPE i VALUE 20713. DATA lv TYPE string. lv = |{ ( li * 86400 + 0 ) * 1000 }|.`
- Exact command used to run it: A4H, a throwaway ABAP Unit probe in `$ZOSG_TMP_0160` (deleted after); here, `node tools/gogen/semantics.mjs` (ZCL_GOGEN_T_RQDATE, part `d`) and `node tools/gogen/gateway.mjs '/sap/opu/odata/sap/ZSTG_DEMO_SRV/BookingSet?$format=json'`
- Expected SAP behaviour: measured on A4H: `CX_SY_ARITHMETIC_OVERFLOW`. The calculation type of the embedded expression is `i` (its operands' type; a template gives it no wider target), and 20713 * 86400 * 1000 is outside `i` for any date after 1970-01-25. The same probe measured that a `d` operand counts as `i` too: `( d / 7 ) * 7` into `i` rounds in between
- Actual open-abap behaviour: OSG answers `BookingSet` with `"FlightDate":"\/Date(1789430400000)\/"`; the JS runtime computes the product without the `i` range check
- Impact on open-steamgate: every entity with a date (`BookingSet`, `TravelSet('T0001')/to_Bookings`) answers here and would dump on a system; the Go backend of `tools/gogen` computes in `i` as A4H does and stops with the same exception
- Smallest safe workaround: not a workaround but the fix: `EPOCH_MS` computes the milliseconds in `p LENGTH 16`. Measured on A4H with the fixed method ($ZOSG_TMP_0021, deleted): 2026-09-15 is 1789430400000 (the value OSG answered before, so no answer changes), 1969-12-31 23:59:59 is -1000, 9999-12-31 23:59:59 is 253402300799000
- Upstream: the range check is the transpiler runtime's (**needs an issue** once reduced to the runtime alone); the `EPOCH_MS` fix is ours
- Regression-test location: `tools/gogen/semantics.mjs` on branch spike/go-backend, ZCL_GOGEN_T_RQDATE (`dOVF`); the Go backend computes `i` as A4H does and stopped at this method
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-amdp-execution-failed-class — a data error in a portable AMDP run reaches ABAP as `CX_SY_DYN_CALL_ILLEGAL_FUNC`, where a system raises `CX_AMDP_EXECUTION_FAILED`

- Status: `open`
- Discovery date: `2026-09-24` (foreman-dell's critic on #44)
- Affected versions: `tools/amdp-destination.mjs` since the portable route; open-abap-core has no `CX_AMDP_EXECUTION_FAILED`
- Affected ABAP statement, runtime API or adapter: a call of an AMDP method that the portable runtime answers, inside `TRY. ... CATCH cx_amdp_execution_failed. ... ENDTRY.`
- Minimal ABAP reproducer: an AMDP procedure with `DECLARE a NVARCHAR(3) = 'abcdef';` (or an INT2 out of range, or `SELECT ... INTO` of two rows), called inside `CATCH cx_amdp_execution_failed`.
- Expected SAP behaviour (measured on A4H for the three cases, 2026-09-23): the call raises `CX_AMDP_EXECUTION_FAILED`, which the CATCH takes.
- Actual open-abap behaviour: the runtime raises `ScalarTooLong` / `Int2OutOfRange` / `SelectIntoRows`, and the destination hands every failure to ABAP as `CX_SY_DYN_CALL_ILLEGAL_FUNC`, so that CATCH does not take it and the program dumps where it would have recovered.
- Impact on open-steamgate: none on the measured corpus yet (no body catches it in a path we run); a program that recovers from a data error behaves differently here.
- Smallest safe workaround: none yet. The fix is to raise `CX_AMDP_EXECUTION_FAILED` for a data error the kernel raises, and to keep `CX_SY_DYN_CALL_ILLEGAL_FUNC` for "cannot be run here" (no engine, no procedure, a refusal).
- Upstream issue: the class is missing from open-abap-core -- **needs an issue** there (or a PR from the fork, per the branch-not-fork exception); not yet filed, goes out through the critic gate.
- Upstream version containing a fix: none yet
- Regression-test location: none yet

### NOTE-2026-09-24-view-client-node-vs-go — a CDS SQL view carries MANDT, and only the Go backend filters by it

- Status: `known`
- Discovery date: `2026-09-24` (critic on #45)
- Affected versions: `tools/cds2ddic.mjs` since #45
- Affected ABAP statement, runtime API or adapter: `SELECT ... FROM <cds sql view>` in the generated `zcl_stg_cds_*` sources, and every OData read over them
- Expected SAP behaviour: a CDS SQL view over a client-dependent table has the client as its first key field, and Open SQL reads only the logon client's rows through it (implicit client handling); the CDS entity itself exposes no client.
- Actual open-abap behaviour: the generated SQL view now carries MANDT (the CDS twin does not), but the transpiled Open SQL adds no client condition (no implicit MANDT, the known anomaly), so the Node runtime reads every client's rows through the view, while the Go backend filters by the column. The same request can answer different rows on the two when the data holds more than one client.
- Impact on open-steamgate: none on the seed data, which holds one client; a capture seeded with a second client's rows would show them on Node.
- Smallest safe workaround: seed one client per database; the fix is implicit client handling in the transpiled Open SQL.
- Upstream issue: part of the implicit-MANDT anomaly; no separate issue.
- Upstream version containing a fix: none yet
- Regression-test location: `test/cds-client.mjs` (the column itself)

### NOTE-2026-09-24-order-beyond-bmp — the sort order of text outside the Basic Multilingual Plane is not measured

- Status: `known`
- Discovery date: `2026-09-24` (critic on #53)
- Affected versions: every ORDER BY the portable lowering writes over text
- Affected ABAP statement, runtime API or adapter: an AMDP body sorting NVARCHAR values that hold characters outside the BMP (emoji and the like)
- Expected SAP behaviour: not measured. HANA stores Unicode as CESU-8 / UTF-16, where a character outside the BMP is a surrogate pair and may sort before U+E000..U+FFFF.
- Actual open-abap behaviour: SQLite and DuckDB compare UTF-8 bytes, which puts U+FF21 before U+1F600; HANA may put them the other way round.
- Impact on open-steamgate: a FOR loop over such a cursor would visit rows in a different order; the scalar runtime already refuses a non-BMP character in a text variable, so the case reaches only an ORDER BY over table data.
- Smallest safe workaround: none needed on the corpus; measure before relying on it.
- Upstream issue: none (ours)
- Upstream version containing a fix: none yet
- Regression-test location: none yet

### ANOMALY-2026-09-24-amdp-body-brace — one `}` or `|` in an AMDP body hides its ENDMETHOD from abaplint, and the next method is lost

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/core` 2.120.55 (as installed) and 2.120.59 (the latest on npm, checked the same day)
- Affected ABAP statement, runtime API or adapter: the body of `METHOD … BY DATABASE PROCEDURE|FUNCTION …` (and `EXEC SQL … ENDEXEC`), lexed by abaplint as ABAP. A `}` or a `|` outside an ABAP string -- in a SQLScript `--` or `/* */` comment too -- starts a string template in the lexer's normal mode, and a newline does not end it: each following line is one token until the next `|` or `{`, so `ENDMETHOD.` is not a statement and the next `METHOD … BY DATABASE …` is not one either. `)`, `]`, a lone `{` and `'}'` in a string do not do it (foreman-dell's critic read the lexer and measured the variants).
- Minimal reproducer (clean-room):
  ```abap
  CLASS zcl_r DEFINITION PUBLIC.
    PUBLIC SECTION.
      INTERFACES if_amdp_marker_hdb.
      CLASS-METHODS a.
      CLASS-METHODS b.
  ENDCLASS.
  CLASS zcl_r IMPLEMENTATION.
    METHOD a BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.
      declare x integer;
      x = 1; -- closing }
    ENDMETHOD.
    METHOD b BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.
      declare y integer;
    ENDMETHOD.
  ENDCLASS.
  ```
- Exact command used to run it: `new abaplint.Registry().addFile(new MemoryFile("zcl_r.clas.abap", src)).parse()`, then the statement kinds of the file: `ClassDefinition Public InterfaceDef MethodDef MethodDef EndClass ClassImplementation MethodImplementation NativeSQL` -- no `EndMethod`, no second `MethodImplementation`. With `-- closing )` in place of `-- closing }`: `… MethodImplementation NativeSQL EndMethod MethodImplementation NativeSQL EndMethod EndClass`.
- Expected SAP behaviour: the body is SQLScript and the kernel ends it at `ENDMETHOD.`; both methods exist.
- Actual open-abap behaviour: abaplint reports one method whose body runs to the end of the next one.
- Impact on open-steamgate: `tools/amdp-extract.mjs` cut bodies between abaplint's `MethodImplementation` and `EndMethod`, so on the A4H export **64 database methods were lost** (452 found, 516 there; 56 of them SQLScript), and 5 bodies came out merged with the method after them -- which the corpus oracle then counted as HXE refusing them ("incorrect syntax near <the next method's name>").
- Smallest safe workaround: the extractor now finds the database methods in the text -- from `METHOD m BY DATABASE …` to the last `ENDMETHOD` (pragmas allowed) before the next `METHOD` or `ENDCLASS` -- in copies with the ABAP comment lines blanked offset for offset (and `"` comments where the header is looked for; a `*` line inside a USING list is not a table, a header in a comment is none), and cuts the body from the source itself. Checked once, by hand, on this machine against the export under `.local` (not tracked, so not reproducible from the repository) and on every class of this tree: of the 452 methods the old cut found, all but the 5 merged ones came out with the same name, kind, USING list and body hash; foreman-dell's critic repeated the comparison on the tree's own AMDP classes (19 of 19 the same).
- Upstream issue: [abaplint/abaplint#4329](https://github.com/abaplint/abaplint/issues/4329) (filed 2026-09-24 after foreman-dell's critic pass), related #3486 and #4307
- Regression-test location: `test/amdp.mjs` ("the database methods are cut out of the text, not out of abaplint's statements")
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-24-raw-columns — a RAW(n) column holds what was written, of any length, in the transpiler runtime; a system holds n bytes and checks the length of a compared value

- Status: `workaround`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/transpiler` 2.13.89 (`DatabaseSetup`: RAW(n) is `NCHAR(2n)` hex text, RAWSTRING `TEXT`) and `@abaplint/runtime` 2.13.89; OSG's `test/seed.mjs` wrote abapGit's hex as it stood until 2026-09-24 and now pads a RAW to its 2n upper-case digits
- Affected ABAP statement, runtime API or adapter: `SELECT` / `UPDATE ... SET` / `INSERT` on a RAW column, a RAW column in `WHERE` (static and dynamic); in OSG `packs/zvdb` (`ZVDB_100_VEC-QBITS RAW(192)`, seeded with 96 bytes for the 768-bit vectors)
- Minimal ABAP reproducer: [zcl_gogen_t_rawrd](https://github.com/oisee/open-steamgate/blob/spike/go-backend/tools/gogen/testdata/zcl_gogen_t_rawrd.clas.abap), `_rawsel`, `_rawstr`, `_rawdyn` over `zgogen_t_raw.tabl.xml` (on the branch `spike/go-backend`) (MANDT, ID CHAR4, R RAW4)
- Exact command used to run it: A4H ABAP Unit probes of the same classes (`$ZOSG_TMP_0300`, deleted); Node: the classes transpiled with open-abap-core and run over `@abaplint/database-sqlite` (`.local/ultra-wip/zvdb-tp`); Go: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour (A4H): a RAW(4) written as x'12000000' reads back into an xstring as four bytes, an initial one as four 00 bytes; `SET r = x'12'` gives 12000000 and `SET r = x'1200000000'` 12000000 (00-padded, cut), a string is moved by the c -> x rule (`12ab` gives 12000000); `WHERE r = @xs` with an xstring of another length than 4 (empty too) raises CX_SY_OPEN_SQL_DATA_ERROR, an x of another length does not activate; a literal against R, static or in `WHERE (cond)`, must be exactly 8 upper-case hex digits, anything else CX_SY_OPEN_SQL_DATA_ERROR; `<` and `ORDER BY` are byte order
- Actual open-abap behaviour: `set1:1/1=12` (one byte stored), `set5:5=1200000000` (five bytes in a RAW(4)), `[12ab]=12`, `[1234567890AB]=1234567890AB`; `eqs1:` / `gts1:A B D` / `[r = '12']:` answer rows or none where a system raises; a seeded 96-byte value of a RAW(192) reads back as 96 bytes into an xstring. (The same runs also show CHAR read into a string keeping its trailing blanks, `new:0/[A   ]`, where A4H gives `[A]`.)
- Impact on open-steamgate: the zvdb pack reads and writes QBITS only through `x LENGTH 192` fields and validates the hex first, so its answers are the same on both hosts (checked request by request); a program that reads a RAW column into an xstring, compares one with an xstring or writes a shorter value sees other bytes than on a system
- Smallest safe workaround: the portable IR binds and compares a RAW as HANA does (`tools/ir-osql-where.mjs`, `tools/ir-writes.mjs`, the RAW pairs in `test/fixtures/ir-pairs/`), and `test/seed.mjs` pads seeded RAW values; the Go backend keeps the store as HANA does (`go/abap/dbraw.go`, `dbstore.go` pads seeded RAW values to 2n upper-case digits at open), binds every value at n bytes and raises where A4H raises
- Upstream: [abaplint/transpiler#1896](https://github.com/abaplint/transpiler/issues/1896), filed 2026-09-24; no fix offered
- Regression-test location: `test/ir-osql-where.mjs`, `test/ir-writes.mjs` (the RAW cases); on `spike/go-backend` `tools/gogen/semantics.mjs` ZCL_GOGEN_T_RAWRD, _RAWSEL, _RAWSTR, _RAWDYN
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-c-to-x — a character value moved into an x keeps the characters after a non-hex one in the transpiler runtime

- Status: `fixed upstream: abaplint/transpiler#1895, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: reported (transpiler#1857, fix offered in PR #1895)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`Hex.set` of a character value takes it as it stands and pads with 0)
- Affected ABAP statement, runtime API or adapter: `x = string`, `x = c` (and `UPDATE ... SET raw = string`, ANOMALY-2026-09-24-raw-columns)
- Minimal ABAP reproducer: [zcl_gogen_t_xconv](https://github.com/oisee/open-steamgate/blob/spike/go-backend/tools/gogen/testdata/zcl_gogen_t_xconv.clas.abap) (on the branch `spike/go-backend`)
- Exact command used to run it: A4H ABAP Unit probe of the same class (`$ZOSG_TMP_0300`, deleted); Node as in the entry above
- Expected SAP behaviour (A4H): the longest prefix of upper-case hex digits, an odd count padded with 0, then cut or 00-padded: `ABG1` gives AB000000, `AB CD` AB000000, `0a1B` 00000000, a c(6) `AB` AB000000; into an xstring the same prefix (`ABG1` is one byte AB)
- Actual open-abap behaviour: into x LENGTH 4, `ABG10000`, `AB CD000`, `0a1B0000` and `AB    00` (the blanks of the c kept), none of them hex; into an xstring the same as A4H
- Impact on open-steamgate: none seen; the zvdb DPC upper-cases and validates VectorHex before the move
- Smallest safe workaround: the IR writes a RAW by the A4H rule (`tools/ir-writes.mjs` bindValue); the Go backend has it too (`go/abap/conv.go` CToX)
- Upstream: [abaplint/transpiler#1857](https://github.com/abaplint/transpiler/issues/1857) (a related, older issue about conversion type c; the measured table is in a comment of 2026-09-24), fix offered as [PR #1895](https://github.com/abaplint/transpiler/pull/1895). Fixed upstream by [abaplint/transpiler#1895](https://github.com/abaplint/transpiler/pull/1895), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `test/ir-writes.mjs` ("binds a RAW as its upper-case hex"); on `spike/go-backend` `tools/gogen/semantics.mjs` ZCL_GOGEN_T_XCONV
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### NOTE-2026-09-25-warm-swap-class-constructor — a warm swap runs a class constructor when the class is loaded, a system runs it at the first access

- Status: `known` (a deliberate choice, `docs/warm-compile.md`)
- Discovery date: `2026-09-25`
- Affected versions: `tools/osd-hot.mjs`, the in-process swap of a warm build (`OSD_WARM=1`)
- Affected ABAP statement, runtime API or adapter: `CLASS-METHODS class_constructor` of a class a warm build rebuilt
- Expected SAP behaviour: after an activation, the new load's class constructor runs at the first access to the class in a session; a session that already used the class keeps the old load and its static attributes.
- Actual open-abap behaviour: a transpiled module runs its class constructor when it is evaluated, which a swap does at once for every rebuilt class; objects created before the swap keep the code they were created with, as on a system, and static attributes start again, as with a new load.
- Impact on open-steamgate: a class constructor with side effects (a row written, a message said) runs at the save rather than at the next call; none of the tree's class constructors does more than set static attributes.
- Smallest safe workaround: none needed; the catch-up recycle after a swap starts a process that runs every class constructor at its start, as before.
- Upstream issue: none (ours)
- Upstream version containing a fix: none
- Regression-test location: `test/warm.mjs` ("binds a swapped module to the instances already loaded": the module is evaluated again on a swap)

### ANOMALY-2026-09-25-in-process-numbering — a second transpile in one process numbers the temporary names on from the first, so a dev-loop build is not reproducible

- Status: `fixed upstream: abaplint/transpiler#1899, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: reported (fix offered as abaplint/transpiler#1899)
- Discovery date: `2026-09-25` (foreman-dell, measuring the dev loop on main 03f0fa0)
- Affected versions: `@abaplint/transpiler` at the pinned 0263e428 and on npm
- Affected ABAP statement, runtime API or adapter: `Transpiler.run` called more than once in one process (the dev loop's and ADT activation's cold build run in the façade process, `tools/osd-store.mjs` transpile)
- Expected SAP behaviour: not a system behaviour; the expectation is ours: a generation is named by its inputs, so the same inputs give the same bytes.
- Actual open-abap behaviour: `UniqueIdentifier`'s counters (`unique1…`, `indexBackup1…`) carry on from the earlier run, so `osd-build --force` over a generation the dev loop built in-process reported "NOT reproducible: 415 of 2524 files differ"; the binary's forced rebuilds were byte-identical.
- Impact on open-steamgate: a generation the dev loop built cold differs from a fresh build of the same inputs in the temporary names only; what runs is the same. The warm build (`tools/osd-warm.mjs`) needs the fix and refuses without it.
- Smallest safe workaround: none in the tree; a build in a fresh process (`npm run transpile`, `osd build`) is reproducible.
- Upstream issue: [abaplint/transpiler#1898](https://github.com/abaplint/transpiler/issues/1898), fix offered as [PR #1899](https://github.com/abaplint/transpiler/pull/1899). Fixed upstream by [abaplint/transpiler#1899](https://github.com/abaplint/transpiler/pull/1899), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)
- Regression-test location: `packages/transpiler/test/unique_identifier.ts` in #1899; here `test/warm.mjs`, whose real path is verified against a cold transpile in a separate process

### ANOMALY-2026-09-23-sin-cos-libm — `sin` / `cos` are the C library's on a system and V8's (fdlibm) here, and differ in the last bit

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` as installed (the transpiled `sin( )` / `cos( )` are JavaScript's `Math.sin` / `Math.cos`), Node 24 (V8 14.6)
- Affected ABAP statement, runtime API or adapter: the built-in functions `sin( )` and `cos( )` with an argument of type f
- Minimal ABAP reproducer:
  ```abap
  DATA lv_x TYPE f.
  lv_x = `-4843.784971815272`.
  cl_abap_unit_assert=>fail( msg = |{ sin( lv_x ) }| quit = if_aunit_constants=>no ).
  ```
- Exact command used to run it: an ABAP Unit probe on A4H (throwaway package, deleted after), six arguments chosen where glibc and V8 disagree, each printed with seventeen digits by a string template.
- Expected SAP behaviour: A4H answers `0.52345430641087753` for the argument above, and for all six arguments the value is bit-equal to glibc's `sin` (checked against glibc 2.43 on the host, CPython `math.sin`) and different from V8's in every one.
- Actual open-abap behaviour: `Math.sin` gives `0.5234543064108774`, one unit in the last place away. V8 carries fdlibm (`src/base/ieee754.cc`), which is accurate to under one ulp but not the same function as glibc's; on 200 000 random arguments up to 5e6 the two disagree on a large share of them.
- Impact on open-steamgate: invisible in any single value, decisive in a chain. ZO4D's `constellation`, `ignition` and `ignite_emit` build their stars and particles from `seed = frac( sin( seed * 12345 + i ) * 43758 )`: the first difference in the last bit is multiplied by 43758 and then by 12345 on the next link, and from there the field is a different one. The same build also closes the one open line of `copperbars`. `docs/frame-comparison.md` had recorded the ignition chain as the limit of comparing two floating-point implementations; it is this, and it is reproducible: a build that calls glibc's `sin` / `cos` (the Go spike on `spike/go-backend`, cgo, `-tags libm`) matches all four scenes frame for frame.
- Smallest safe workaround: none, by decision (Alice, 2026-09-23): a **known difference**, not fixed. Why, measured the same day: a correctly rounded sin would not do, since glibc itself differs from the correctly rounded value on 86 of 50 000 arguments (cos 60; V8 on 1 737), so only glibc's own algorithm reproduces a system; porting it (sysdeps/ieee754/dbl-64/s_sin.c) makes LGPL code, which cannot go into this MIT tree except as a separate optional module; and glibc on x86-64 picks an FMA or a non-FMA variant by CPU, which JavaScript cannot follow without a software FMA and which is not measured. A system on another platform uses another C library, also not measured (A4H is Linux x86-64). The Go spike keeps a glibc build as an option (cgo, `-tags libm`).
- Upstream issue: none. Nothing is fixed here, and a different `sin` is a design question for the runtime, not a defect with a small patch.
- Regression-test location: none yet; the six measured values belong in the test that comes with a fix.
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-09-27-action-label -- open-abap-odata's action and action-parameter interfaces have no SET_LABEL_FROM_TEXT_ELEMENT, which SEGW's generated MPC calls on both

- Status: `open`
- Discovery date: `2026-09-27`
- Affected versions: open-abap-odata at `bd9f1fb` (the lib this tree pins)
- Affected ABAP statement, runtime API or adapter: `/IWBEP/IF_MGW_ODATA_ACTION`, `/IWBEP/IF_MGW_ODATA_PARAMETER`: `SET_LABEL_FROM_TEXT_ELEMENT`
- Minimal ABAP reproducer: any `*.stg.yaml` with a `functions:` block, compiled by `npm run stg:compile` and transpiled; the first one here was `src/demo_data/zosd_taxi.stg.yaml` (GenerateYear, ResetData)
- Exact command used to run it: `node tools/osd-build.mjs` -> `check_syntax, Method "set_label_from_text_element" not found` on the generated MPC's `lo_action->...` and `lo_parameter->...` lines
- Expected SAP behaviour: SEGW writes `lo_action->set_label_from_text_element(` for every action and one per input parameter, and A4H activated and served such an MPC (regenerated there 2026-09-19; `tools/segw-gen.mjs` "An open question" block). Properties, entity types and complex types have the method here too, through `/IWBEP/IF_MGW_ODATA_ITEM`
- Actual open-abap behaviour: the two interfaces do not include `/IWBEP/IF_MGW_ODATA_ITEM` or an alias for the method, so the generated MPC does not pass the syntax check; no generated MPC with functions had been transpiled here before (the demo's MPC is hand-written)
- Impact on open-steamgate: a service compiled from YAML with a function import does not build
- Smallest safe workaround: keep that service's MPC in `src/` without the action and parameter label lines (`src/demo_data/zcl_zosd_taxi_mpc.clas.abap`, which says so in its header); `stg-compile --all` leaves an object `src/` holds alone
- Upstream issue: none yet; the fix is an alias (or the item interface) on the two interfaces in open-abap-odata
- Regression-test location: none yet; the taxi data service's own tests fail if its MPC stops building
- Upstream version containing a fix: `unknown`
### ANOMALY-2026-09-29-amc-program-identity — AMC authority checks need the ABAP caller's program

- Status: `open` (Node class calls covered, other callers fail closed)
- Discovery date: `2026-09-29`
- Affected versions: the pinned open-abap runtime and the one-process AMC host in `tools/osd-amc.mjs`
- Affected ABAP statement, runtime API or adapter: `CL_AMC_CHANNEL_MANAGER` at `SEND` and `START_MESSAGE_DELIVERY`; `sy-cprog` is the runtime's fixed `OPEN_ABAP_TODO`, not the caller's program.
- Minimal ABAP reproducer: `test/unit/zcl_osd_amc_test.clas.testclasses.abap` calls `START_MESSAGE_DELIVERY` and `SEND` from a class pool named in `src/amc/zstg_amc_test.samc.xml`.
- Exact command used to run it: `npm run unit` with the AMC host installed by `tools/osd-unit-bootstrap.mjs`; the library's `npm run unit` checks that creating a producer or consumer without a broker raises `CX_AMC_ERROR` with "AMC is not available in this host."
- Expected SAP behaviour: a `SAMC` channel's `PROGRAM_ID` and activity authorise the executing program. P8 observed checks at `SEND` and `START_MESSAGE_DELIVERY`.
- Actual open-abap behaviour: the Node host can identify a directly executing generated class module from its stack frame and turn that class name into the class-pool program ID. It cannot reliably identify report, function group, dynamic or bundled callers this way, and the runtime's `sy-cprog` does not fill the gap. Those callers receive `CX_AMC_ERROR` rather than a guessed identity. The compiled binary's `serve` and `up` routes install the same broker through `mountChannels`, but if bundling removes the generated class frame, authority checks fail closed.
- Impact on open-steamgate: the tested Node class and APC paths work; AMC callers without a generated class frame cannot pass a `SAMC` authority check. Browser preview has no broker until step 9 and producer/consumer creation raises the explicit unavailable-host error.
- Smallest safe workaround: none. The kernel needs an execution-context program identity independent of source paths before this is general.
- Upstream issue: none yet; the one-process AMC adapter is ours.
- Regression-test location: `test/amc.mjs` (program mapping and refused send), `test/unit/zcl_osd_amc_test.clas.testclasses.abap` (authorised and unauthorised sends).
- Upstream version containing a fix: none.

### ANOMALY-2026-10-06-amc-one-process — an AMC message sent from a background job never reaches the server's APC subscribers

- Status: `open` (by design so far: the supervisor broker is step 6 of `docs/abap-daemons.md` and is not built)
- Discovery date: `2026-10-06` (reported by PIA)
- Affected versions: the one-process AMC host in `tools/osd-amc.mjs`, with every background job running in its own `tools/osd-batch-runs.mjs worker` process
- Affected runtime API: `cl_amc_channel_manager=>create_message_producer( )->send( )` in a job step, received by an APC WebSocket bound with `bind_amc_message_consumer` in the serving process
- Expected SAP behaviour: AMC is not tied to a work process. A job (or a daemon) that sends on a channel reaches an APC client bound to it in a dialog work process. PIA's job mode on A4H relies on this. It is reported by PIA and has not been probed by OSG yet.
- Actual open-abap behaviour: each process has its own `AmcBroker`. The worker's `SEND` is delivered to subscribers in the worker only, and the APC client in the server receives nothing. Measured by PIA: the job completed in 34 s and its terminal got no message.
- Impact on open-steamgate: any "job reports progress over AMC" pattern is silent. A sender inside the serving process (an HTTP step, an APC handler, a daemon in the same process) is not affected.
- Smallest safe workaround: send from the serving process. PIA 0.1.1 runs the work inline in the APC handler instead of as a job.
- Regression-test location: none yet; it belongs with the supervisor broker (`docs/backlog/jobs.md`).

### ANOMALY-2026-09-29-amc-scope-assumption — AMC cross-identity delivery has no A4H measurement

- Status: `open` (local policy implemented, system semantics unmeasured)
- Discovery date: `2026-09-29`
- Affected versions: one-process AMC host in `tools/osd-amc.mjs`
- Affected runtime API: `SAMC` scope `C`, `U` and `S` when producer and subscriber differ by client or username.
- Expected SAP behaviour: not established by P8; its one logon observed delivery only within one client and user.
- Actual open-abap behaviour: each subscription records its client and username. `C` delivers within the same client, `U` within the same client and username, and `S` to all subscribers. These are design assumptions awaiting cross-client/user A4H probes.
- Impact on open-steamgate: cross-identity routing may differ from a system until P6/P8 is measured with another logon.
- Regression-test location: `test/amc.mjs` covers each scope with three subscriber identities.

### ANOMALY-2026-09-29-runtime-in-options — `x IN range` evaluates only I EQ, E EQ and I CP, and E EQ alone decides

- Status: `fixed` (2026-09-30: abaplint/transpiler#1928, merged upstream as ac55899212; this tree pins `oisee/transpiler` `local/osd-build-2026-09-30` at `085ab4a9`, upstream main plus two local fixes, until the fix is on npm)
- Discovery date: `2026-09-29`
- Affected versions: `@abaplint/runtime 2.13.89` (`build/src/compare/in.js`), as pinned in this tree
- Affected ABAP statement, runtime API or adapter: the logical expression `dobj IN range_tab` outside Open SQL (`IF`, `CHECK`, `LOOP ... WHERE`); `SELECT ... WHERE f IN range` goes through Open SQL and is not affected
- Minimal ABAP reproducer: `src/osd/zosd_sub_range.prog.abap` with a range row `I BT 3 5`, run through `SUBMIT zosd_sub_range WITH s_num IN lt_range ...`
- Exact command used to run it: `node tools/osd-unit-run.mjs` with that row in `ltcl_batch_report->static_submit_passes_a_range`
- Expected SAP behaviour: every option (EQ NE GT GE LT LE BT NB CP NP) with sign I or E; the value is in the range when it matches some I row (or there are no I rows) and matches no E row
- Actual open-abap behaviour: `compareIn` handles I EQ, E EQ and I CP and throws `compareIn todo` for any other row. It returns true as soon as one row matches, so an E EQ row that the value does not equal makes the whole range true, even when no I row admits the value (`[I EQ 7, E EQ 4]` admits 1)
- Impact on open-steamgate: synchronous and VIA JOB `SUBMIT ... WITH sel IN range` pass the range correctly (`tools/osd-narrow-submit.mjs`, `zcl_osd_submit_ranges`), but a report that tests `IN` in ABAP only gets right answers for I EQ and I CP rows; BT and the other options dump. The job input test checks transport of all ten options for both signs; its report execution comparison uses I EQ.
- Smallest safe workaround: none was needed after the fix; `static_submit_range_bt_and_e` runs `I BT 3 7` with `E EQ 5` and expects 4 hits, and fails on the old pin with `compareIn todo`
- Upstream issue: abaplint/transpiler#1928 (branch `compare-in-all-options`, every option, I rows admit, E rows only exclude; critic SEND, Regression 17/17)
- Regression-test location: `test/unit/zcl_osd_batch_runner_test.clas.testclasses.abap` (`static_submit_passes_a_range`, `static_submit_range_is_checked`, `static_submit_range_bt_and_e`)
- Upstream version containing a fix: abaplint/transpiler main from ac55899212 (2026-09-30); not yet published to npm (2.13.93 is the latest at that date)

### ANOMALY-2026-09-29-job-standard-facade — narrow local job FMs accept standard signatures but reject unsupported semantics

- Status: `open`
- Discovery date: `2026-09-29`
- Affected adapter: `ZOSD_JOBS` implementations of `JOB_OPEN`, `JOB_SUBMIT`, `JOB_CLOSE`, `BP_EVENT_RAISE`, `BP_JOB_READ`, and `BP_JOB_SELECT`
- Expected SAP behaviour: scheduled and periodic starts, job class/group, external programs, targets, and selection options follow their documented FM semantics.
- Actual local behaviour: date/time starts, once or periodic in minutes, hours, days or weeks, and `BP_JOB_DELETE` are supported since 2026-10-01 (docs/job-standard-fms.md, Periodic jobs); `PRDMONTHS`, `EVENT_PERIODIC` and the other remaining options still refuse. Nonempty unsupported options raise declared exceptions; local-owner selection supports `BTCSELECT` job name, count, username, the six status flags (`PRELIM`/`SCHEDUL` included), known step `ABAPNAME`, named-wait `EVENTID`/`EVENTPARM`, and `EQ`/`CP`/`BT` include/exclude ranges. Noninitial `JOBGROUP`, `FROM_DATE`, `FROM_TIME`, `TO_DATE`, `TO_TIME`, `NO_DATE`, and `WITH_PRED` raise `SELECTION_CANCELED` with the field named in the message. Sandbox measurement on 2026-09-29 closed the provisional opcode/status assumptions: `BP_JOB_READ` accepts 19/20/35/36/37 and rejects others; the observed immediate-job status sequence is `P`/`Y`/`R`/`F`, with `A` and `S` observed among other jobs. Opcodes 35/36 share local opcode 20 handling and 37 shares opcode 19 handling; their other field semantics remain unmeasured. Immediate `JOB_CLOSE` exports `JOB_WAS_RELEASED = 'X'`.
- Impact: callers depending on unsupported options activate but receive a declared exception. The observed status letters and accepted opcodes now match the sandbox; the additional opcode fields remain an open measurement.
- Smallest safe workaround: use immediate, predecessor, or named-event ABAP report jobs and the private `ZOSD_JOB_READ` bridge for exact local reads. The `TAIL_EVENT_ID`/`TAIL_EVENT_PARAM` extension on `JOB_CLOSE` does not exist on SAP and code using it will not activate there.
- Measurement: sandbox behaviour probe, 2026-09-29, and active DD03L `BTCSELECT` shape on 2026-09-30; see `.local/probe-facts-2026-09-29-jobs-signatures.md` (private) and `docs/job-standard-fms.md` (public facts and remaining assumptions).
- Regression-test location: `src/jobs/zcl_osd_job_doctor.clas.testclasses.abap`, `test/job-one-step.mjs`.

### ANOMALY-2026-09-29-job-ret-and-step-number — standard job facade output details need measurement

- Status: `open` (local assumptions implemented)
- Discovery date: `2026-09-29`
- Affected adapter: `JOB_OPEN`, `JOB_CLOSE`, `BP_JOB_READ`, `BP_JOB_SELECT`
- Expected SAP behaviour: the four FMs expose optional changing `RET` of type `I`; the precise value semantics and `BP_JOB_READ` step-number error behavior are unmeasured.
- Actual local behaviour: successful calls set `RET` to zero. A noninitial `JOB_STEP_NUMBER` returns only that step, and an index beyond the step count raises `JOB_DOESNT_HAVE_STEPS`.
- Impact: callers relying on other `RET` meanings or edge cases need a sandbox measurement.
- Regression-test location: `test/job-one-step.mjs`.

### ANOMALY-2026-09-29-job-status-z -- observed sandbox status has no local mapping

- Status: `open`
- Discovery date: `2026-09-29`
- Affected adapter: `BP_JOB_READ`, `BP_JOB_SELECT`, and `SHOW_JOBSTATE`
- Expected SAP behaviour: the sandbox had retained jobs with status `Z`, but the behaviour probe did not produce one or establish its meaning.
- Actual local behaviour: no bridge state maps to `Z`; unknown states fall back to `P` in the header and selection facades or `OTHER` in `SHOW_JOBSTATE`.
- Impact: callers that depend on `Z` cannot reproduce it locally yet.
- Smallest safe workaround: leave `Z` unmapped until its state and flags are measured.
- Measurement: sandbox behaviour probe, 2026-09-29; see `docs/job-standard-fms.md`.

### ANOMALY-2026-09-24-escape-json-string-control-characters — `escape( format = e_json_string )` leaves control characters other than a newline raw

- Status: `fixed upstream: abaplint/transpiler#1902, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime 2.13.89` (`builtin/escape.ts`, the `e_json_string` case)
- Affected ABAP statement, runtime API or adapter: `escape( val = v format = cl_abap_format=>e_json_string )`, which open-abap-core's `/UI2/CL_JSON=>SERIALIZE_INT` uses for every c and string it writes
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_jsesc.clas.abap` (branch `ultra/parity-wave1`)
- Exact command used to run it: **measured on A4H, 2026-09-24**, the class as it stands in an ABAP Unit probe ($ZOSG_TMP_0050, deleted afterwards); the runtime side read from `escape.ts`
- Expected SAP behaviour: `\` and `"` escaped; U+0008 U+0009 U+000A U+000C U+000D as `\b \t \n \f \r`; every other character below U+0020 as `\u00XX` with upper-case hex (`\u0000`, `\u000B`, `\u001F`); `/`, `'`, U+007F and everything beyond ASCII (U+2028 included) unchanged; a c operand without its trailing blanks
- Actual open-abap behaviour: only `\`, `"` and U+000A are escaped; a tab, a carriage return and every other control character reach the JSON raw, which makes the document invalid JSON
- Impact on open-steamgate: a string with a tab or a CR in it (source code through the RFC channel, a message text) serializes to JSON a browser's `JSON.parse` refuses on Node and not on a system or on OSGo, which follows A4H (`go/abap/strings.go` EscapeJSONString)
- Smallest safe workaround: none in ABAP; the Go and JS backends of tools/gogen follow A4H
- Upstream issue: not reported yet (goes through the critic gate with the next batch). Fixed upstream by [abaplint/transpiler#1902](https://github.com/abaplint/transpiler/pull/1902), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_JSESC
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: unknown)

### ANOMALY-2026-09-24-empty-string-to-date — an empty string moved into a `d` is eight blanks, not the initial date

- Status: `fixed upstream: abaplint/transpiler#1904, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime 2.13.89` (`types/date.ts`, `set` of a string)
- Affected ABAP statement, runtime API or adapter: `lv_d = lv_string` and the same move into a field symbol bound to a `d`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_genmovd.clas.abap` (branch `ultra/parity-wave1`)
- Exact command used to run it: **measured on A4H, 2026-09-24** in an ABAP Unit probe ($ZOSG_TMP_0050, deleted afterwards); the runtime side read from `date.ts`
- Expected SAP behaviour: a string into a `d` is its first eight characters, blank-filled when shorter, and an **empty** string is the initial date `00000000` (IS INITIAL true). Into a `t` the same with six, and a shorter string is filled with zeros (`abc` is `abc000`; the runtime does this one right)
- Actual open-abap behaviour: `Date.set("")` pads with blanks, so the date is eight blanks, IS INITIAL false
- Impact on open-steamgate: an absent date in a JSON body or an OData request that reaches a `d` through a string is not initial on Node; OSGo follows A4H (`go/abap/conv.go` S2D)
- Smallest safe workaround: `IF lv_s IS INITIAL. CLEAR lv_d. ELSE. lv_d = lv_s. ENDIF.`
- Upstream issue: not reported yet (goes through the critic gate with the next batch). Fixed upstream by [abaplint/transpiler#1904](https://github.com/abaplint/transpiler/pull/1904), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_GENMOVD
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: unknown)

### ANOMALY-2026-09-24-byte-compare-x-length — two `x` fields of different lengths are unequal in the transpiler runtime; a system pads the shorter with 00

- Status: `fixed upstream: abaplint/transpiler#1908, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open (the Go and JS backends of tools/gogen answer as A4H does)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`compare/eq.js`: two `Hex` of different lengths are equal only when both are initial; `lt` / `gt` compare the hex text)
- Affected ABAP statement, runtime API or adapter: `=`, `<>`, `<`, `>` between `x LENGTH m` and `x LENGTH n`, m <> n
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_xcmp.clas.abap`, segment `g` of `RUN1` (`lv_x1 = 'AB'. lv_x2 = 'AB00'. lv_x1 = lv_x2 ...`)
- Exact command used to run it: A4H, the same bodies as ABAP Unit probes ZCL_GOGEN_T_XCMP, _XCMP2, _XCMP3 in `$ZOSG_TMP_0480` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core, `run( )` called from Node (scratch runner, not tracked); the Go and JS backends: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: `g:10010101101` -- `x'AB' = x'AB00'` is true and `x'AB' < x'AB00'` false (the shorter operand is padded with 00 on the right); the rest of the class matches the transpiler: an `xstring` against an `xstring` or an `x` compares the bytes in order and a prefix is the smaller (`x'AB' < xstring AB00`); against `c` or `string` the byte operand becomes its upper-case hex digits and the comparison is one of characters (`x'FF' <> 'ff'`, `x'FF' < 'ff'`, `x'00' <> '0'`, an empty xstring `= ' '`)
- Actual open-abap behaviour: `g:01010101101` -- `x'AB' = x'AB00'` false, `x'AB' < x'AB00'` true
- Impact on open-steamgate: none found (ZCL_OSD_GIT compares xstrings with c literals, which both runtimes answer alike)
- Smallest safe workaround: none needed
- Upstream: was marked needs-issue in abaplint/transpiler (runtime, `compare/eq`, `lt`, `gt` for `Hex`). Fixed upstream by [abaplint/transpiler#1908](https://github.com/abaplint/transpiler/pull/1908), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_XCMP
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-byte-compare-numeric — an `x` or `xstring` against an `i` or `n` is not read as a number in the transpiler runtime

- Status: `open` (the Go and JS backends of tools/gogen answer as A4H does)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`compare/eq.js`, `lt.js`, `gt.js`)
- Affected ABAP statement, runtime API or adapter: `=`, `<`, `>` between an `x` / `xstring` and an `i` (literal or field) or an `n`; all of them activate on A4H
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_xcmpn.clas.abap`
- Exact command used to run it: as ANOMALY-2026-09-24-byte-compare-x-length (A4H probes ZCL_GOGEN_T_XCMP2=>NUM, ZCL_GOGEN_T_XCMP3=>LONG, =>LONG2 in `$ZOSG_TMP_0480`)
- Expected SAP behaviour: `xi:1111110 xn:1 xsi:111 l:1111 l2:11` -- the byte operand is an integer of its last four bytes, 00 on the left, signed: `x'0A' = 10`, `x'0100' = 256`, `x'FF' = 255` (not -1), `x'FFFFFFFF' = -1`, `x LENGTH 5 '0100000002' = 2`, `x'00FFFFFFFF' = -1`; an `xstring` the same by its run-time length (`FFFF = 65535`, empty `= 0`); `x'0A' = n '0010'`
- Actual open-abap behaviour: `xi:1110110 xn:0 xsi:000 l:0000 l2:00` -- `x'FFFFFFFF' = -1` is false, `x'0A' = n '0010'` is false, and every `xstring` against a number is false
- Impact on open-steamgate: none found (no OSG source compares bytes with a number)
- Smallest safe workaround: none needed
- Upstream: **needs an issue** in abaplint/transpiler (runtime, comparisons of `Hex` / `XString` with numbers)
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_XCMPN
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-byte-to-i-move — an empty `xstring` moved into an `i` is NaN, and more than four bytes are not cut, in the transpiler runtime

- Status: `fixed upstream: abaplint/transpiler#1906, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open (the Go and JS backends of tools/gogen answer as A4H does)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (the move of `Hex` / `XString` into `Integer` parses the whole hex text)
- Affected ABAP statement, runtime API or adapter: `lv_i = lv_x.` / `lv_i = lv_xstring.`; in OSG `ZCL_ABAPGIT_CONVERT=>XSTRING_TO_INT` (abapGit's pack header, four bytes: not affected)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_xmovi.clas.abap`
- Exact command used to run it: A4H, the same class as an ABAP Unit probe in `$ZOSG_TMP_0481` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core, `run( )` called from Node (scratch runner, not tracked); the Go and JS backends: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: `a:11 b:-1 c:255 d:258 e:0 f:-2147483648 g:-2 h:255 x5:2 xs5:2` -- the last four bytes, 00 on the left, a signed int32; an empty xstring is 0; no exception for five bytes
- Actual open-abap behaviour: `... e:NaN ... x5:4294967298 xs5:4294967298` -- an empty xstring gives NaN, and five bytes give a value no `i` can hold
- Impact on open-steamgate: none found (abapGit converts exactly four bytes)
- Smallest safe workaround: none needed
- Upstream: was marked needs-issue in abaplint/transpiler (runtime, move of `Hex` / `XString` into `Integer`). Fixed upstream by [abaplint/transpiler#1906](https://github.com/abaplint/transpiler/pull/1906), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_XMOVI
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

The five `ANOMALY-2026-09-24-httpc-*` entries (`CL_HTTP_CLIENT`: body-latin1, failure-dumps, timeout-ignored, status-code-field, post-url-query) were measured on a system; the measured versions are on main (PR #84).

### ANOMALY-2026-09-24-find-section — `FIND ... IN SECTION` and an empty `FIND` pattern differ from A4H in the transpiler runtime

- Status: `open` (the Go and JS backends of tools/gogen answer as A4H does; the transpiler runtime does not)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/transpiler` / `@abaplint/runtime` as installed in the main checkout (2.13.89)
- Affected ABAP statement, runtime API or adapter: `FIND [FIRST OCCURRENCE OF] p IN SECTION [OFFSET o] [LENGTH l] OF s [MATCH OFFSET m] [MATCH LENGTH n]`; `FIND '' IN s`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_findsec.clas.abap` (`s` is `ab<cd<e`, one `sec( )` call per case)
- Exact command used to run it: A4H ABAP Unit probe ZCL_GOGEN_T_FINDSEC in `$ZOSG_TMP_0041` (deleted); the transpiler side by transpiling the same class with open-abap-core and calling `sec( )` per case (scratch runner, not tracked)
- Expected SAP behaviour: MATCH OFFSET counts from the start of `s`; `OFFSET -1`, an offset past the end, `LENGTH` below -1 and a section past the end raise `CX_SY_RANGE_OUT_OF_BOUNDS`; `LENGTH -1` is the rest of `s`; `SECTION LENGTH 3 OF s` finds `<` at 2; an empty pattern is found at the section's start with length 0 (`FIND '' IN s MATCH OFFSET o MATCH LENGTH l` over `abc` is 0/0/0).
- Actual open-abap behaviour: any `SECTION ... LENGTH` form (`OFFSET o LENGTH l OF`, `LENGTH l OF`) takes the wrong operand as the subject: with `OFFSET` it throws a JavaScript `TypeError` (`blah.substr is not a function`), without it the FIND answers 4 where A4H finds (`j`); `OFFSET -1` is sy-subrc 4, not an exception; an empty pattern sets sy-subrc 0 and leaves MATCH OFFSET and MATCH LENGTH as they were (`p: 0/99/98` against A4H `0/1/0`).
- Impact on open-steamgate: none today: `ZCL_STG_SADL_DEF` uses `IN SECTION OFFSET o OF` with valid offsets, which the transpiler answers correctly. A LENGTH section anywhere in OSG's ABAP would crash on Node.
- Smallest safe workaround: none needed in `src/`; avoid `IN SECTION ... LENGTH` in ABAP meant for the Node hosts.
- Upstream issue: not drafted (abaplint/transpiler, `statements/find.ts` reads `IN SECTION OFFSET` only).
- Regression-test location: `tools/gogen/semantics.mjs` (`ZCL_GOGEN_T_FINDSEC`)
- Upstream version containing a fix: unknown

### ANOMALY-2026-09-23-w3mi-edges — WWWDATA_IMPORT and SCMS_BINARY_TO_XSTRING differ from A4H at their edges

- Status: `fixed upstream: open-abap/open-abap-core#1265 and open-abap/open-abap-core#1266, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: open (the Go host of tools/gogen answers as A4H does; the open-abap-core functions do not)
- Discovery date: `2026-09-23`
- Affected versions: open-abap-core `zw3mi` and `zscms` function groups as held in `.local/lars/open-abap-core` (fork branch with #1218)
- Affected ABAP statement, runtime API or adapter: `CALL FUNCTION 'WWWDATA_IMPORT'`, `CALL FUNCTION 'SCMS_BINARY_TO_XSTRING'`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_w3mi.clas.abap` (A4H ran the same calls over an object of its own, found with a SELECT on WWWPARAMS)
- Exact command used to run it: A4H ABAP Unit probe ZCL_GOGEN_T_W3MI in `$ZOSG_TMP_0230` (deleted); locally `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H answered `miss:2/1 rel:1/0 hit:0 rowsdiff:0 pad:00/255 exact:0/X five:5/X zero:0 over:0/0 neg:0/0 empty:0/0`. An unknown object is `IMPORT_ERROR` and **MIME keeps the rows it had**; a `RELID` other than `MI` is `WRONG_OBJECT_TYPE`; `SCMS_BINARY_TO_XSTRING` with `INPUT_LENGTH` 0 or negative returns an **empty** buffer, with more than there is the whole of it, with an empty table an empty (cleared) buffer.
- Actual open-abap behaviour: `WWWDATA_IMPORT` clears MIME before it looks the object up, so a miss empties the caller's table; it never reads `RELID`; `SCMS_BINARY_TO_XSTRING` cuts only when `0 < INPUT_LENGTH * 2 < length`, so 0 or a negative length returns **everything**.
- Impact on open-steamgate: small. The packs pass the size WWWPARAMS holds, which is never 0 for a real object; a caller that retries into the same table after a miss sees it emptied.
- Smallest safe workaround: none needed in `src/`; the Go host (`tools/gogen/go/abap/w3mi.go`) implements the measured rules.
- Upstream issue: not drafted; it belongs with the pending open-abap-core PRs for these two function groups. Fixed upstream by [open-abap/open-abap-core#1265](https://github.com/open-abap/open-abap-core/pull/1265) and [open-abap/open-abap-core#1266](https://github.com/open-abap/open-abap-core/pull/1266), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Regression-test location: `tools/gogen/semantics.mjs` (`ZCL_GOGEN_T_W3MI`)
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked (was: unknown)

### ANOMALY-2026-09-23-dynamic-create-ctor-params — abaplint checks `CREATE OBJECT ... TYPE (name)` against the static type's constructor

- Status: `fixed upstream: gone in @abaplint/core 2.120.62; verified 2026-09-30 by running the reproducer`; before: open
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` 2.120.55
- Affected ABAP statement, runtime API or adapter: `CREATE OBJECT ref TYPE (name)` without `EXPORTING`, where the static type of `ref` has a constructor with a mandatory parameter
- Minimal ABAP reproducer: an abstract class `zcl_base` with `METHODS constructor IMPORTING iv_tag TYPE string`, a subclass `zcl_sub` whose own `constructor` takes no parameters, and `DATA lo TYPE REF TO zcl_base. CREATE OBJECT lo TYPE ('ZCL_SUB').`
- Exact command used to run it: `node tools/gogen/semantics.mjs` with that statement in `tools/gogen/testdata/zcl_gogen_t_inh.clas.abap` (the front end runs abaplint's syntax check first)
- Expected SAP behaviour: measured on A4H ($ZOSG_TMP_0017, 2026-09-23, deleted after): the class activates, and the statement creates a `zcl_sub` and runs `zcl_sub`'s constructor. The class is not known until run time, so neither is its constructor
- Actual open-abap behaviour: abaplint reports `constructor parameter "IV_TAG" must be supplied`. `validateParameters` in `5_syntax/statements/create_object.js` looks up `CONSTRUCTOR` on the static type even when the type is dynamic
- Impact on open-steamgate: none on the served path so far (the gateway's own dynamic creates target types whose constructors take no parameters); it blocks a test from saying what A4H accepts
- Smallest safe workaround: the test creates the object into a reference of the subclass's type and widens it afterwards; no code works around it
- Upstream: was marked needs-issue in abaplint (the check should skip the parameter validation when the type is dynamic). Fixed upstream in @abaplint/core 2.120.62; verified 2026-09-30 by running the reproducer. The finding is gone in @abaplint/core 2.120.62; no issue was filed.
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_INH (the A4H-only line `abl:` is left out of the local copy until abaplint accepts it)
- Upstream version containing a fix: `@abaplint/core 2.120.62` (was: none yet)

### ANOMALY-2026-09-23-string-statements — SPLIT, REPLACE and the string functions differ from A4H in eight places

- Status: `partly fixed upstream: open-abap-core#1261 adds the exception class; runtime items 1 to 8 remain`; before: open
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/transpiler` 2.13.89, `@abaplint/runtime` 2.13.89, open-abap-core as cloned under `.local/lars/`
- Affected ABAP statement, runtime API or adapter: `SPLIT ... INTO f1 f2`, `REPLACE ... IN SECTION`, `REPLACE ... WITH` a regex replacement, `REPLACE` into a c field, `REPLACE ALL OCCURRENCES OF ''`, `repeat( )`, `replace( occ = )`, `shift_right( )`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_str{split,repl,fn,cond,loop}.clas.abap`, each a static `RUN` returning a string; the same code ran on A4H as ABAP Unit probes in `$ZOSG_TMP_0130` (deleted after)
- Exact command used to run it: the testdata classes through `new Transpiler({unknownTypes: "runtimeError"}).runRaw(files)` and the generated `init.mjs`, `RUN` called per class (the harness of `tools/gogen/run.mjs`, without open-abap-core)
- Expected SAP behaviour (A4H, 2026-09-23), against actual open-abap behaviour:
  1. `SPLIT` into a c field too short for its piece cuts it and sets sy-subrc 4; open-abap cuts and sets 0 (`trunc:ab/d/4` against `trunc:ab/d/0`).
  2. `REPLACE ... IN SECTION OFFSET o LENGTH l OF s` replaces only inside the section; open-abap ignores the section and replaces in the whole string (`sect:abca-c` against `sect:a-ca-c`).
  3. In a regex replacement `$0` is the whole match; open-abap passes the text to JavaScript's `String.replace`, which has no `$0` (`groups:baabbaab` against `groups:ba$0ba$0`).
  4. `REPLACE` into a c field whose result is longer than the field cuts it and sets sy-subrc 2 (a cut of trailing blanks only is 0); open-abap sets 0 (`ctrunc:aXYZ/2` against `aXYZ/0`).
  5. `REPLACE ALL OCCURRENCES OF ''` (also `OF ' '`, a c blank being empty) raises `CX_SY_REPLACE_INFINITE_LOOP`, which `CATCH cx_root` takes; open-abap throws a plain JavaScript `Error("REPLACE, zero length input")`, and open-abap-core has no class `CX_SY_REPLACE_INFINITE_LOOP`, so abaplint refuses a `CATCH` that names it.
  6. `repeat( val = ' ' occ = 3 )` is empty, because a c argument loses its trailing blanks; open-abap gives three blanks.
  7. `replace( ... occ = 2 )` replaces the second occurrence and `occ = -1` the last; open-abap replaces nothing for either (`r2:abca-cabc rm1:abcabca-c` against `abcabcabc` twice).
  8. `shift_right( )` is implemented; open-abap raises `Error("shift_right todo")`.
  Not counted here: `a|aX` in `aXbX` takes `aX` on A4H (POSIX, leftmost-longest) and `a` in JavaScript's `RegExp` (leftmost-first). That is the regex engine, shared by the open-abap runtime and by gogen's JS backend, noted in `tools/gogen/semantics.mjs`, and not an open-abap anomaly.
- Impact on open-steamgate: the SEGW generator and the gateway call `replace( ... occ = 0 )`, `repeat( )` and two-target `SPLIT` on string targets, where the two runtimes agree; nothing on the served path is known to hit the eight differences. The Go backend (`tools/gogen`) follows A4H in all eight; for item 5 its front end holds the superclass A4H gives the class (`CX_DYNAMIC_CHECK`), so `CATCH cx_dynamic_check` and `CATCH cx_root` take it there too (`ZCL_GOGEN_T_STRLOOP`).
- Smallest safe workaround: none needed on the served path; do not rely on `IN SECTION`, `occ` other than 0 or 1, or `$0` in code that also runs on open-abap
- Upstream issue: **needs an issue** in `abaplint/transpiler` (the runtime items) and one in `open-abap-core` (the missing class); not sent, the critic pass the upstream rule asks for comes first. Partly fixed upstream: [open-abap/open-abap-core#1261](https://github.com/open-abap/open-abap-core/pull/1261) (merged 2026-09-25) adds `CX_SY_REPLACE_INFINITE_LOOP`; verified 2026-09-30 against open-abap-core main caad035 and abaplint/transpiler main 78e700d. Runtime items 1 to 8 are still wrong; item 2 now answers `abc-`, not `a-ca-c`.
- Regression-test location: `tools/gogen/semantics.mjs` (EXPECT for ZCL_GOGEN_T_STRSPLIT, _STRREPL, _STRFN, _STRCOND, _STRLOOP, _STREDGE, _STRMOVE, _STRLINES)
- Upstream version containing a fix: the exception class in `open-abap-core` main; none yet for the runtime items (was: unknown)

### ANOMALY-2026-09-23-interface-data-value — abaplint accepts `VALUE` on an interface's `DATA`

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` 2.120.55
- Affected ABAP statement, runtime API or adapter: `DATA x TYPE i VALUE 5.` inside `INTERFACE ... ENDINTERFACE`
- Minimal ABAP reproducer: `INTERFACE lif_ia. DATA mv_count TYPE i VALUE 5. ENDINTERFACE.` and a class implementing it
- Exact command used to run it: `node tools/gogen/semantics.mjs` with the VALUE in `tools/gogen/testdata/zif_gogen_t_ia.intf.abap` (the front end runs abaplint's syntax check first)
- Expected SAP behaviour: measured on A4H ($ZOSG_TMP_0120, 2026-09-23, deleted after): the include does not activate, "VALUE cannot be used with attributes (except constants) within interfaces."
- Actual open-abap behaviour: abaplint reports nothing; the gogen front end used to read `zif~attr` inside the implementing class as a CONSTANT with that value (silently wrong: a write to it was lost)
- Impact on open-steamgate: none on the served path; the gogen front end now refuses such an attribute (a statement stub that dumps), since the source could never run on a system
- Smallest safe workaround: none needed; do not write VALUE there
- Upstream: **needs an issue** in abaplint (a syntax error for VALUE on interface DATA / CLASS-DATA)
- Regression-test location: `tools/gogen/semantics.mjs`, the refusal check over `tools/gogen/testdata-refused/` (ZCL_GOGEN_T_RF line 12 must answer the VALUE message; an attribute named `value` must still compile)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-23-catch-after-superclass — abaplint accepts a `CATCH` of a class after a `CATCH` of its superclass

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` 2.120.55
- Affected ABAP statement, runtime API or adapter: `TRY ... CATCH zcx_base ... CATCH zcx_sub ... ENDTRY` where `zcx_sub` inherits from `zcx_base`
- Minimal ABAP reproducer: two exception classes, `zcx_base INHERITING FROM cx_static_check` and `zcx_sub INHERITING FROM zcx_base`, and `TRY. RAISE EXCEPTION TYPE zcx_sub. CATCH zcx_base. r = 'base'. CATCH zcx_sub. r = 'sub'. ENDTRY.`
- Exact command used to run it: the front end of `tools/gogen` (`compileProgram`, which runs abaplint's syntax check first) on that class
- Expected SAP behaviour: measured on A4H ($ZOSG_TMP_0117, 2026-09-23, deleted after): the class does not activate, "The exception class LCX_SUB cannot be used in the CATCH clause, since a CATCH clause already exists in the same TRY BLOCK and this clause uses the superclass LCX_BASE."
- Actual open-abap behaviour: abaplint reports nothing and the program compiles; the second `CATCH` can never be taken
- Impact on open-steamgate: none on the served path (the gateway's `TRY`s list subclasses first); a program that would not activate on a system runs here
- Smallest safe workaround: `tools/gogen` refuses such a `TRY` (a statement stub, `CATCH x after a CATCH of its superclass`); the transpiler path has no workaround
- Upstream: **needs an issue** in abaplint (a syntax error in `5_syntax/structures/try.js` or the `CATCH` statement check)
- Regression-test location: none that runs: the pinned probe `ZCL_GOGEN_T_RAISE` in `tools/gogen/semantics.mjs` leaves the line out because it cannot be activated on A4H
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-23-interface-read-only — abaplint does not check writes to a READ-ONLY interface attribute

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` 2.120.55
- Affected ABAP statement, runtime API or adapter: a write to `DATA x TYPE i READ-ONLY` of an interface: `lo_intf->x = 1`, `lo_obj->zif~x = 1` outside the implementing class, `lo_intf->x = 1` inside it
- Minimal ABAP reproducer: `INTERFACE lif_ia. DATA mv_ro TYPE i READ-ONLY. ENDINTERFACE.`, a class `lcl_obj` implementing it, and elsewhere `DATA lo_i TYPE REF TO lif_ia. lo_i = NEW lcl_obj( ). lo_i->mv_ro = 1.`
- Exact command used to run it: the testdata of ZCL_GOGEN_T_IA with that line added, through `compileProgram` of `tools/gogen/frontend.mjs`
- Expected SAP behaviour: measured on A4H ($ZOSG_TMP_0120, 2026-09-23, deleted after): "Write access to the READ-ONLY attribute "MV_RO" is not allowed outside the class/interface." for a write through an interface reference (also inside the implementing class) and for `lo_obj->lif_ia~mv_ro = 1` outside the class; writes through `me`, through a reference of the class's own type inside the class, and in a subclass activate
- Actual open-abap behaviour: abaplint reports nothing; its `ClassAttribute` of an interface carries no `read_only` in `getMeta()` at all (a class's own READ-ONLY attribute does)
- Impact on open-steamgate: none on the served path; the gogen front end reads READ-ONLY off the DATA statement itself and refuses such a write
- Smallest safe workaround: the front end's own check (`intfRefAttribute`, `classRefIntfAttribute` in `tools/gogen/frontend.mjs`)
- Upstream: **needs an issue** in abaplint (keep READ-ONLY in an interface attribute's meta and check writes against it)
- Regression-test location: the READ-ONLY writes that do activate are in ZCL_GOGEN_T_IA (`tools/gogen/semantics.mjs`); the refusals are the check over `tools/gogen/testdata-refused/` in the same script (ZCL_GOGEN_T_RF lines 13, 14 and 17)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-23-describe-deep-structure — `DESCRIBE FIELD ... TYPE` of a deep structure is `u` in the transpiler runtime, `v` on a system

- Status: `fixed upstream: abaplint/transpiler#1910, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89
- Affected ABAP statement, runtime API or adapter: `DESCRIBE FIELD s TYPE k` where `s` is a structure holding a string, a table or a reference
- Minimal ABAP reproducer: `TYPES: BEGIN OF ty, name TYPE string, n TYPE i, END OF ty. DATA ls TYPE ty. DATA lv_k TYPE c LENGTH 1. DESCRIBE FIELD ls TYPE lv_k.`
- Exact command used to run it: the runtime's `abap.statements.describe` called on a `Structure` of `String` + `Integer` and on one of `Integer` + `Character(2)` from a Node script against `node_modules/@abaplint/runtime` (both answer `u`); on A4H the same statement in `tools/gogen/testdata/zcl_gogen_t_jsgeneric.clas.abap`
- Expected SAP behaviour: measured on A4H ($ZOSG_TMP_0150, 2026-09-23, deleted after): `v` for the structure with a string (deep), `u` for the flat one (`cl_abap_typedescr=>typekind_struct2` / `typekind_struct1`)
- Actual open-abap behaviour: `u` for every structure (`statements/describe.js`: `input.field instanceof types_1.Structure` sets `"u"` with no look at the components)
- Impact on open-steamgate: code that branches on the type kind of a structure (`typekind_struct2`) takes the flat branch on a deep one; nothing on the served path is known to do so. The gogen backends (Go and JS) answer `v` / `u` as A4H does
- Smallest safe workaround: none needed in gogen; the transpiler runtime would have to look at the components (string, xstring, table, reference, or a deep structure inside)
- Upstream: was marked needs-issue in abaplint/transpiler (runtime `describe`). Fixed upstream by [abaplint/transpiler#1910](https://github.com/abaplint/transpiler/pull/1910), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_JSGENERIC (`kinds:...vhl ... flat:u`)
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-23-dbwrite-insert-table-duplicate — `INSERT dbtab FROM TABLE` with a duplicate key returns sy-subrc 4 instead of raising

- Status: `fixed upstream: abaplint/transpiler#1919, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/transpiler` 2.13.89, `@abaplint/runtime` 2.13.89, `@abaplint/database-sqlite`
- Affected ABAP statement, runtime API or adapter: `INSERT dbtab FROM TABLE itab` without `ACCEPTING DUPLICATE KEYS` (`runtime/src/statements/insert_database.ts`)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_dbw.clas.abap` (table `zgogen_t_dbw.tabl.xml` beside it): row A present, then `INSERT zgogen_t_dbw FROM TABLE lt` with B, A, C inside a `TRY ... CATCH cx_sy_open_sql_db`
- Exact command used to run it: the class and the table transpiled on their own with open-abap-core as the one lib (`npx abap_transpile`) and `run` called over `SQLiteDatabaseClient`, in a scratch folder
- Expected SAP behaviour: measured on A4H ($ZOSG_TMP_0140, 2026-09-23, deleted after): `CX_SY_OPEN_SQL_DB` is raised, sy-subrc and sy-dbcnt are left as they were (7/7 before, 7/7 in the CATCH), and **every row without a duplicate is written all the same** (B, C, and a D after a second duplicate). Two rows with the same key inside the table: one written, then the exception. With `ACCEPTING DUPLICATE KEYS`: sy-subrc 4, sy-dbcnt the rows written, no exception. An empty table: 0/0
- Actual open-abap behaviour: no exception; every statement behaves as with `ACCEPTING DUPLICATE KEYS` (`tab:4 /2`), because the runtime inserts row by row and folds the sy-subrc of each into a maximum
- Impact on open-steamgate: a DPC that relies on the exception to reject a batch (or on a `CATCH` to report it) sees success with sy-subrc 4 and goes on
- Smallest safe workaround: none in code; do not rely on the exception
- Upstream: was marked needs-issue in abaplint/transpiler. Fixed upstream by [abaplint/transpiler#1919](https://github.com/abaplint/transpiler/pull/1919), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_DBW (the A4H answer is in the comment above its EXPECT; the gogen backends refuse database writes until the relational IR has the nodes)
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-23-dbwrite-update-from-table — `UPDATE dbtab FROM TABLE itab` is compiled as `UPDATE dbtab FROM wa`

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/transpiler` 2.13.89
- Affected ABAP statement, runtime API or adapter: `UPDATE dbtab FROM TABLE itab`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_dbw.clas.abap`, `updtab`
- Exact command used to run it: as for ANOMALY-2026-09-23-dbwrite-insert-table-duplicate
- Expected SAP behaviour: A4H, rows A (present) and Y (absent): sy-subrc 4, sy-dbcnt 1, A updated
- Actual open-abap behaviour: the generated code reads the key fields off the table itself (`lt.get().mandt`) and dies with `Error: table, no header line`
- Impact on open-steamgate: any mass update dumps
- Smallest safe workaround: `LOOP AT itab INTO wa. UPDATE dbtab FROM wa. ENDLOOP.` (sy-subrc / sy-dbcnt then need summing by hand)
- Upstream: [abaplint/transpiler#1937](https://github.com/abaplint/transpiler/pull/1937), sent 2026-09-30 from the branch `update-from-table` in abaplint/transpiler: the TABLE operand is passed as `table` and the runtime updates row by row (sy-subrc 4 when a row found nothing, sy-dbcnt the rows updated), with a test in `test/database.ts` that fails without it. Not pinned here: the workaround above stays until a release carries it
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_DBW (comment)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-23-dbwrite-delete-from-wa — `DELETE dbtab FROM wa` is compiled as a DELETE on an internal table

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/core` as used by `@abaplint/transpiler` 2.13.89
- Affected ABAP statement, runtime API or adapter: `DELETE dbtab FROM wa`, which abaplint's parser classifies as `DeleteInternal` (it cannot tell it from `DELETE itab FROM idx` without the dictionary)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_dbw.clas.abap`, `delmiss` and `del`
- Exact command used to run it: as for ANOMALY-2026-09-23-dbwrite-insert-table-duplicate
- Expected SAP behaviour: A4H: a missing key gives sy-subrc 4, sy-dbcnt 0; a present one 0 / 1
- Actual open-abap behaviour: `abap.statements.deleteInternal(zgogen_t_dbw, {from: ls})`, which throws `ReferenceError: zgogen_t_dbw is not defined`
- Impact on open-steamgate: the form dumps wherever it is used; the gogen front end sees the same `DeleteInternal` and checks the dictionary for the name before treating it as a database delete
- Smallest safe workaround: `DELETE FROM dbtab WHERE <key> = wa-<key> ...`
- Upstream: **needs an issue** in abaplint (the statement) or the transpiler (resolve by the dictionary)
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_DBW (comment)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-23-dbwrite-delete-from-table — `DELETE dbtab FROM TABLE itab` matches every field, and reports the last row only

- Status: `fixed upstream: abaplint/transpiler#1918, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89 (`statements/delete_database.ts`)
- Affected ABAP statement, runtime API or adapter: `DELETE dbtab FROM TABLE itab` (and `DELETE dbtab FROM wa` once it compiles)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_dbw.clas.abap`, `deltab`: rows D (present, `val` 11 in the database, 18 in the work area) and Q (absent)
- Exact command used to run it: as for ANOMALY-2026-09-23-dbwrite-insert-table-duplicate
- Expected SAP behaviour: A4H: the rows are found by their **primary key**: D deleted, sy-subrc 4 (Q), sy-dbcnt 1
- Actual open-abap behaviour: the WHERE is built from every component of the row, so D is not found because its `val` differs; sy-subrc and sy-dbcnt are those of the last row alone (4 / 0)
- Impact on open-steamgate: a mass delete with work areas that carry anything but the key deletes nothing and says so only through sy-subrc
- Smallest safe workaround: clear the non-key fields of the rows first, or delete with `WHERE` on the key
- Upstream: was marked needs-issue in abaplint/transpiler. Fixed upstream by [abaplint/transpiler#1918](https://github.com/abaplint/transpiler/pull/1918), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs`, ZCL_GOGEN_T_DBW (comment)
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-23-select-count-dbcnt — sy-dbcnt after `SELECT COUNT(*) ... INTO n` is 1 here and the count on a system

- Status: `open`
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89
- Affected ABAP statement, runtime API or adapter: `SELECT COUNT(*) FROM dbtab INTO n`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_dbw.clas.abap`, the `rb` note (ROLLBACK WORK leaves sy-dbcnt alone, measured, so it shows what the SELECT before it set)
- Exact command used to run it: as for ANOMALY-2026-09-23-dbwrite-insert-table-duplicate
- Expected SAP behaviour: A4H: sy-dbcnt 4 after counting 4 rows
- Actual open-abap behaviour: sy-dbcnt 1 (one result row)
- Impact on open-steamgate: none known; found on the way, not looked for
- Smallest safe workaround: read the count, not sy-dbcnt
- Upstream: **needs an issue** in abaplint/transpiler, after one more measurement that counts a number other than the rows of the previous statement
- Regression-test location: none yet
- Upstream version containing a fix: none yet

The same run also showed an `INSERT` taking `mandt` from the work area (999 written; A4H writes the logon client, 001 there): that is ANOMALY-2026-09-11-no-implicit-mandt, not a new entry.

### ANOMALY-2026-09-23-ranges-expand-in — the transpiler runtime's `col IN range` knows five row forms, ORs them all, and reads a CP pattern as LIKE unescaped

- Status: `partly fixed upstream: abaplint/transpiler#1920 and #1928 (SIGN and OPTION in the runtime); the SQL path remains`; before: workaround
- Discovery date: `2026-09-23`
- Affected versions: `@abaplint/runtime` 2.13.89 (`build/src/expand_in.js`, `expandIN`)
- Affected ABAP statement, runtime API or adapter: `SELECT ... WHERE col IN rt_range` (a ranges table of SIGN / OPTION / LOW / HIGH)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_selcnt.clas.abap` (I CP 'A*' with E EQ 'AB'); through the gateway, `GET /sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$filter=Seats%20gt%201` (the demo DPC turns the filter into a range)
- Exact command used to run it: `curl` against a running OSG (`npm start`, the transpiler runtime) and `node tools/gogen/gateway.mjs --compare <origin> <path>` for the Go backend; the runtime's source read in `node_modules/@abaplint/runtime/build/src/expand_in.js`
- Expected SAP behaviour: measured on A4H by foreman-dell (`test/fixtures/ir-pairs/a4h-ranges.json`, 80 cases): every SIGN I / E and OPTION EQ NE GT GE LT LE BT NB CP NP; I rows OR'ed, AND NOT the OR of the E rows; CP with `+` for one character, `#` escaping, a literal `%` / `_` matched literally; a lower-case or initial SIGN / OPTION an uncatchable dump
- Actual open-abap behaviour: only `I EQ`, `I NE`, `I GE`, `I LE`, `I CP` are rendered; any other row (every E row, GT, LT, BT, NB, NP) throws `IN, <sign> <option> not supported`, which OSG answers as a 500 (`$filter=Seats gt 1`, `Status ne 'A'`, `TravelId ge ... and TravelId le ...`: 500 on OSG, 200 with A4H's rows through the Go backend). CP becomes `LIKE` with `*` replaced by `%` and nothing else: `+` and `#` are not read, and a literal `%` or `_` in the pattern is a wildcard (A4H's `50%_off*` would match `50X_off`). Every row, I or E, is joined with OR
- Impact on open-steamgate: an OData `$filter` whose range has any other form fails the request on the Node host; a CP pattern with `_`, `%`, `+` or `#` selects other rows than a system
- Smallest safe workaround: the Go backend (`tools/gogen`) carries the IR's rangesPredicate (`tools/ir-ranges.mjs`, ported in `go/abap/ranges.go`, checked against `ranges.json` and replayed against `a4h-ranges.json`); the Node host has none
- Upstream: **needs an issue** in abaplint/transpiler (runtime `expandIN`). Partly fixed upstream: [abaplint/transpiler#1920](https://github.com/abaplint/transpiler/pull/1920) (merged 2026-09-25) and [#1928](https://github.com/abaplint/transpiler/pull/1928) (merged 2026-09-30) make the runtime's `col IN range` know every SIGN and OPTION; verified 2026-09-30 against abaplint/transpiler main 78e700d. Still open: the SQL path throws on `E CP` / `NP` and does not escape `+ # % _`, and that part still needs an issue.
- Regression-test location: `tools/gogen/go/abap/ranges_test.go` (the rules), `tools/gogen/semantics.mjs` ZCL_GOGEN_T_SELCNT / ZCL_GOGEN_T_SELDUMP
- Upstream version containing a fix: `abaplint/transpiler` main for the runtime part (first release not checked); none yet for the SQL path (was: none yet)

### ANOMALY-2026-09-24-select-loop-sy — `SELECT ... ENDSELECT` in the transpiler runtime leaves sy-subrc and sy-dbcnt as the whole SELECT set them

- Status: `workaround`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/transpiler` 2.13.89 (`build/src/structures/select.js`, `SelectTranspiler`), `@abaplint/runtime` 2.13.89
- Affected ABAP statement, runtime API or adapter: `SELECT ... FROM dbtab INTO wa ... ENDSELECT` (the loop form), with or without `EXIT`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_selloop.clas.abap` (two rows of `ZGOGEN_T_DBW`)
- Exact command used to run it: A4H, the same class with `ZGOGEN_T_DBW` in `$ZOSG_TMP_0195` through an ABAP Unit probe (2026-09-24, both deleted after); the transpiler: `abap_transpile` 2.13.89 over the class, the table and open-abap-core, run with `@abaplint/database-sqlite`; the Go backend: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H answered `n:2 in:1/0,2/0, after:0/2 exit:0/1/A exitmiss:0/1 none:4/0/QQQ cont:0/2/2 corr:5/A elem:A/2 exit2:0/2`: each pass starts with sy-subrc 0 and sy-dbcnt the rows read so far, whatever the body left on the pass before; after ENDSELECT, or an EXIT out of the loop, sy-subrc 0 and sy-dbcnt the rows read, even when the body's last statement set sy-subrc 4; without a row 4 / 0 and the work area untouched. The same statements over T000 (two clients) answered the same shape.
- Actual open-abap behaviour: `n:2 in:2/0,2/4, after:4/2 exit:0/2/A exitmiss:4/2 none:4/0/QQQ cont:0/2/2 corr:5/A elem:   A/2 exit2:0/2`. The rows are read with one `SELECT ... INTO TABLE` before the loop, which sets sy-subrc and sy-dbcnt once (sy-dbcnt the total from the first pass on, also after an EXIT at the first row); nothing in the loop sets sy again, so a pass sees what the body left on the one before and the loop ends with it. The elementary target of `SELECT id ... INTO lv_id` (c10) printed with three leading blanks in the template; not investigated further.
- Impact on open-steamgate: an ABAP loop that counts with sy-dbcnt or tests sy-subrc after ENDSELECT behaves differently on the Node host than on a system. `ZCL_OSD_WEBGUI=>MENU` and `ZCL_OSD_STATUS=>SNAPSHOT` use the loop form but test neither.
- Smallest safe workaround: the Go backend (`tools/gogen`, `select_loop`) sets sy as A4H does; the Node host has none
- Upstream: **needs an issue** in abaplint/transpiler (`SelectTranspiler`)
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_SELLOOP
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-packed-decimals — the transpiler runtime computes packed numbers with decimals in floating point and rounds, converts and overflows them differently from a system

- Status: `partly fixed upstream: abaplint/transpiler#1885, #1923 and #1924 cover pieces; the rest remains`; before: workaround
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/transpiler` 2.13.89, `@abaplint/runtime` 2.13.89 (`types/packed.js`, `operators/*`, `types/integer8.js`, `templateFormatting`)
- Affected ABAP statement, runtime API or adapter: every statement with a `p LENGTH n DECIMALS d` operand or target: moves into and out of p, arithmetic of calculation type p, `DIV` / `MOD`, string templates of p (`DECIMALS =`, `ALIGN`), `abs( )` / `frac( )` of p
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_pdconv.clas.abap`, `_pdcalc`, `_pdfmt`, `_pdprec`, `_pdcmp`, `_pdtpl` (each prints one line)
- Exact command used to run it: A4H, the same classes as ABAP Unit probes in `$ZOSG_TMP_0270` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the classes and open-abap-core, each `lv_x.set(...)` statement of the output wrapped so that a JavaScript `RangeError` / `TypeError` prints `!JS` and the run goes on; the Go and JS backends of `tools/gogen`: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: the EXPECT lines of `tools/gogen/semantics.mjs` (A4H's answers). The rules they pin: `+ - *` exact, `/` to 31 significant digits, 63 integer digits in between, commercial rounding into the field, `CX_SY_ARITHMETIC_OVERFLOW` after arithmetic and `CX_SY_CONVERSION_OVERFLOW` after a move, c -> p with a trailing sign and no exponent, f -> p through seventeen significant digits, `DIV` / `MOD` with a remainder never negative, p -> c right aligned with a sign place, p -> n rounded and unsigned, a string compared with an i converted to i
- Actual open-abap behaviour, where it differs from A4H (A4H in brackets):
  - c -> p(3,2): `'12.5-'` NN (-12.50); `'1E2'` 100.00 (NN); `'999.995'` and `'1000'` 1000.00 (CO); `'- 1'` NN (-1.00); string `` `1e1` `` 10.00 (NN)
  - f -> p(3,2): -0.125 -0.12 (-0.13); 2.675 2.68 (2.67); 999.995, 1000 and 1E300 no overflow (CO), 1E300 written out as 300 digits
  - i 1000 into p(3,2) 1000.00 (CO); p(8,3) -> p(8,2): 1.255 1.25 (1.26), -1.255 -1.25 (-1.26); -2.50 into p(8,0) -2 (-3); 999.995 into p(3,2) 1000.00 (CO)
  - p 3000000000 into i: no overflow (CO); p -2.50 into int8: `RangeError` (-3)
  - p 0.10 into f, in a template: 0.1000000000000000 (0.10000000000000001)
  - p into c(8): `1.5`, `-1.5`, `0` (`   1.50`, `   1.50-`, `   0.00`); into c(3) `123` (`*67`); into c(4)/(5)/(3) of -1.50 `-1.5`, `-1.5`, `-1.` (`1.50-`, `*50-`, `*0-`); p into n(4) 12.50 `0012` (0013), -12.5 `0-12` (0013), 12345.6 `2345` (2346)
  - -7 / 2 into p(8,0) -3 (-4); `1 / 3 * 3` and every `/` whose result is multiplied again: `RangeError` (the quotient is a JS float handed to `BigInt`)
  - DIV / MOD of 7.5 and -7.5 by 2 and -2: 3.00/2.00, -4.00/1.00, -4.00/1.00, 3.00/2.00 (3.00/1.50, -3.00/1.50, -4.00/0.50, 4.00/0.50); 7.5 MOD '0.4' 0.00 (0.30); -7 DIV -2 into p -4 (-3)
  - no overflow anywhere: 31 nines + 1 into p(16,0) 9999999999999999635896294965248 (AO); 5 * 1000 into p(3,2) 5000.00 (AO)
  - `lv_s = '-0.4'. IF lv_s < 0` true (false); `lv_s = '2.6'. IF lv_s = 3` false (true)
  - int8 5000000000 / 3 into p(8,2) 1666666666.00 (1666666666.67)
  - templates: `DECIMALS = 0` of 1.25 and 2.50 prints 1.25 and 2.50 (1, 3); `WIDTH = 8 ALIGN = RIGHT` `1.50    ` (`    1.50`); `abs( )` / `frac( )` of -1.5 print 1.5 / -0.5 (1.50, -0.50); p arithmetic in a template prints sixteen decimals (`2.2500000000000000` for 1.25 + 1, A4H 2.25)
  - equal to A4H: plain templates of p fields, comparisons of p, generic data (DESCRIBE, move to string, IS INITIAL, writes through a field symbol), the products, 1 / 3 and 2 / 3 into p(8,2) and p(16,14), the character-operand calculation type (`'7' / 2 * 2` into i is 7)
- Impact on open-steamgate: every DEC amount on the Node host (`ZSTG_FLIGHTFACT-PRICE`, `ZOSD_TAXIFACT-FARE`) is computed in doubles; sums, divisions and roundings of amounts can differ from a system in the last digit, and a value that overflows its field on a system is stored
- Smallest safe workaround: none on the Node host; the Go and JS backends of `tools/gogen` compute p as A4H does (`go/abap/packed.go`, `js/abap.mjs`)
- Upstream: **needs an issue** in abaplint/transpiler (runtime `Packed` and the operators); large, several issues rather than one. Partly fixed upstream: [abaplint/transpiler#1885](https://github.com/abaplint/transpiler/pull/1885) (DIV and MOD with a negative divisor, merged 2026-09-23), [#1923](https://github.com/abaplint/transpiler/pull/1923) (`round( )`, merged 2026-09-29) and [#1924](https://github.com/abaplint/transpiler/pull/1924) (`nmin( )` / `nmax( )` type, merged 2026-09-29); verified 2026-09-30 against abaplint/transpiler main 78e700d. The rest is open.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_PDCONV, _PDCALC, _PDFMT, _PDPREC, _PDCMP, _PDTPL, _PDTPLM; `go test ./abap -run Packed` in `tools/gogen/go`
- Upstream version containing a fix: pieces in `abaplint/transpiler` main (first release not checked); none yet for the rest (was: none yet)

A2 timestamp observation (2026-10-03): with the installed runtime's bigint-backed
`Packed`, `20261003123456.9980000` moves to a string without losing the
fraction, but `get()` converts the scaled bigint to Number before dividing
and yields `20261003123457`. Consequently `trunc`/`frac` lose the second and
milliseconds. Reproducer: the `clock` ABAP Unit method in
`src/adt/zcl_osd_adt_feeds.clas.testclasses.abap`, run by
`test/adt-abap-a2.mjs`. The route formats the packed timestamp as text first,
then splits its integer and fraction; only the small fraction goes through
millisecond arithmetic. This preserves exact literal stamps and the runtime's
GET TIME STAMP value; the latter already contains the get_time.js floating
point approximation and is format-checked before masking in wire tests.

### ANOMALY-2026-09-24-arith-compared-with-string — abaplint accepts an arithmetic expression compared with a character operand, which does not activate on a system

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/core` as used by OSG's lint (2.13.89 transpiler toolchain)
- Affected ABAP statement, runtime API or adapter: a comparison `arith_expr op char_operand`, e.g. `IF lv_i * 86400 * 1000 > lv_s.` with `lv_s TYPE string`
- Minimal ABAP reproducer: `DATA lv_i TYPE i. DATA lv_s TYPE string. IF lv_i * 2 > lv_s. ENDIF.`
- Exact command used to run it: A4H, creating `ZCL_GOGEN_T_PDCMP` in `$ZOSG_TMP_0270` with that line (2026-09-24): activation refused
- Expected SAP behaviour: syntax error "An arithmetic expression cannot be compared with the non-numeric operand "LV_S". However, "+ LV_S" can be used." (`lv_s + 0` activates; the comparison then runs in calculation type p)
- Actual open-abap behaviour: abaplint reports nothing; OSG's own `src/gateway/zcl_stg_entry_provider.clas.abap` `CONVERT_VALUE` has `IF lv_ms < 0 OR lv_days * 86400 * 1000 > lv_ms.` with `lv_ms TYPE string`, which would not activate on a system
- Impact on open-steamgate: the entry provider's `/Date(ms)/` branch cannot be deployed to a system as it is; the Go backend refuses that comparison with the system's reason (statement stub)
- Smallest safe workaround: none applied (OSG source, `+ 0` or a p variable for `lv_ms` fixes it; not changed from this branch)
- Upstream: **needs an issue** in abaplint/abaplint (syntax check of comparisons)
- Regression-test location: `tools/gogen` front end, `compare( )` (the refusal); the activating form in `ZCL_GOGEN_T_PDCMP`
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-create-data-name-case — `CREATE DATA ... TYPE STANDARD TABLE OF (name)` with a lower-case name raises in the transpiler runtime and works on a system

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`statements/create_data.js`)
- Affected ABAP statement, runtime API or adapter: `CREATE DATA dref TYPE STANDARD TABLE OF (name)` (and `TYPE (name)`) with `name` not in upper case
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_crdyn.clas.abap` (`lv_name = 't000'.`)
- Exact command used to run it: A4H, the same class as an ABAP Unit probe in `$ZOSG_TMP_0270` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core; the Go backend: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H answered `a:0/h b:u/0[] c:2 lower:ok unknown:err kept:0`: the name is found in any case (unlike `CREATE OBJECT ... TYPE (name)`, where lower case is CX_SY_CREATE_OBJECT_ERROR), an unknown name is CX_SY_CREATE_DATA_ERROR and leaves the reference as it was
- Actual open-abap behaviour: `a:0/h b:u/0[] c:2 lower:err unknown:err kept:2`: `'t000'` raises CX_SY_CREATE_DATA_ERROR, so the reference still holds the table of two rows filled before
- Impact on open-steamgate: none today (the producers, `ZCL_OAO_SHLP_DDIC` among them, pass DDIC names in upper case); a name taken from a URL or a lower-case constant would fail on the Node host and work on a system
- Smallest safe workaround: none needed yet; the Go backend looks the name up in any case (`go/abap/tables.go` `TableByName`)
- Upstream: **needs an issue** in abaplint/transpiler (runtime `createData`)
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_CRDYN
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-dynamic-where-pasted — the transpiler runtime pastes `WHERE (cond)` into the SQL text, where a system parses it against the table

- Status: `workaround`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (a dynamic condition of `SELECT ... WHERE (lv_where)` goes into the statement text as it stands)
- Affected ABAP statement, runtime API or adapter: `SELECT ... FROM <table>|(name) ... WHERE (lv_where)`; in OSG the generated readers `gen/cds/zcl_stg_tab_*` / `zcl_stg_cds_*` (SE16 and the SADL DPC go through them) and open-abap-odata's `zcl_oao_shlp_ddic` (value helps)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_dsel.clas.abap` (`1 = 1`, `id='A'`); through the gateway, `GET /sap/opu/odata/sap/ZSTG_SADL_SRV/Zc_Stg_TravelcubeSet?$filter=STATUS%20eq%20%27AX%27`, `GET /sap/opu/odata/sap/ZSTG_DEMO_SRV/StatusVHSet`, `GET /sap/bc/osd/se16/?t=ZSTG_DEMO&f_seats=%3E1`
- Exact command used to run it: OSG on Node (`test/run.mjs`, main 42755c5) and the Go backend (`tools/gogen/osgo.mjs`, branch ultra/osqlwhere) side by side, the same requests with `curl`
- Expected SAP behaviour: measured on A4H over SFLIGHT (docs/osql-where.md, open-steamgate #47): a literal is converted to the column's type (a CHAR literal cut to the column, `'LH X'` against CHAR3 is `'LH'`; NUMC zero-padded; a quoted number against INT4 is the number, a letter an uncatchable runtime error); `1 = 1` and an unknown column raise CX_SY_DYNAMIC_OSQL_SEMANTICS, `carrid='LH'` and `!=` CX_SY_DYNAMIC_OSQL_SYNTAX; AND binds tighter than OR
- Actual open-abap behaviour: the string reaches SQLite unparsed. `STATUS eq 'AX'` against CHAR1 finds nothing on Node (the Go backend, cutting as A4H does, finds the two `A` rows); `1 = 1` reads every row on Node where a system raises (StatusVHSet answers on Node and is CX_SY_DYNAMIC_OSQL_SEMANTICS on the Go backend, because `zcl_oao_shlp_ddic` still writes `'1 = 1'` for an empty condition); `SEATS = '>1'` (SE16, a typed-in `>1`) compares an INTEGER with text and finds nothing on Node, where the measurement names no outcome for that shape (the Go backend refuses it, NOT_COMPILED, "number format"). Every literal is text in the statement rather than bound
- Impact on open-steamgate: a condition that is not in SQLite's own dialect, or one a system would refuse, answers differently on the Node host; a value help whose reader writes `1 = 1` works on Node and not on a system
- Smallest safe workaround: the Go backend parses the condition with the port of `tools/ir-osql-where.mjs` (`tools/gogen/go/abap/osqlwhere.go`, checked against `test/fixtures/ir-pairs/osql-where.json` in four dialects) and binds every text; `zcl_oao_shlp_ddic` should leave an empty condition empty, as cds2ddic does since #48 (an upstream fix in open-abap-odata)
- Not an anomaly, for the record: a read without ORDER BY answers the rows in another order on the two hosts (SE16 over ZOSD_TAXIFACT, ZSTG_STATUS, ZSTG_SBD_MP; Zc_Osd_TaxicubeSet): the Go backend's `MANDT = '123'` lets SQLite walk the primary key, Node scans in insertion order. Neither order is promised, on a system either
- Upstream: **needs an issue** in abaplint/transpiler (runtime, dynamic WHERE); open-abap-odata `zcl_oao_shlp_ddic` (`'1 = 1'`)
- Regression-test location: `tools/gogen/go/abap/osqlwhere_test.go` (the pairs), `tools/gogen/semantics.mjs` ZCL_GOGEN_T_DSEL / ZCL_GOGEN_T_DSELX
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-secondary-key-duplicates — the transpiler runtime orders a non-unique sorted secondary key oldest first, keeps a stale copy after a change in place, and misses a READ with sy-subrc 8 and sy-tabix 0

- Status: `partly fixed upstream: abaplint/transpiler#1916 (the miss) and open-abap-core#1262 (the parser no longer depends on the order); duplicate order and the stale key copy remain`; before: workaround
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`types/table.js` `getSecondaryIndex`, `statements/loop.js`, `statements/read_table.js`), `@abaplint/transpiler` 2.13.89
- Affected ABAP statement, runtime API or adapter: `LOOP AT itab ... USING KEY k [WHERE ...]` and `READ TABLE itab ... WITH KEY k COMPONENTS ...` over a standard table with `WITH [NON-]UNIQUE SORTED KEY k`; open-abap-core's `/UI2/CL_JSON` parser (`LCL_PARSER`, `key_parent` non-unique) reads a JSON array's members through such a key
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_seckey.clas.abap` (five appended rows with repeated `p`, a sixth appended, `p` of one row changed through a field symbol, READs that hit and miss)
- Exact command used to run it: A4H, the same class in `$ZOSG_TMP_0420` through an ABAP Unit probe (2026-09-24; the probe's DUPORD method also ran `INSERT ... INDEX 1` and a table with only the non-unique key: `a:3/1,2/2,1/3, b:3/1,2/2,1/3, c:5/1,4/2,3/3,2/4,1/5, d:..., e:5,4,3,2,1,`); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core, run with `@abaplint/database-sqlite`; the Go and JS backends: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H answered (before the READ INDEX 2 was added) `w:5/3,3/4,1/5, after:5 app:0/3,5/4,3/5,1/6, mod:4/1,3/2,2/3, all:0/1,5/2,4/3,3/4,2/5,1/6, ru:0/3/4 rp:0/0/4 rmiss:8/0/7 rlow:4/0/1 rfs:0/4/3`: rows with an equal key come newest first (by when the row was created: a row inserted at index 1 after the others comes before them, a row whose key was changed in place keeps its place among the new duplicates); sy-tabix is the position in the key's order; a READ that finds nothing leaves the target alone, sets sy-tabix to where the value would go, and sy-subrc 4 when that is before a row, 8 when it is past the last one
- Actual open-abap behaviour: `w:1/3,3/4,5/5, after:5 app:1/3,3/4,5/5,0/6, mod:2/1,4/2,3/4, all:0/1,5/2,4/3,3/4,2/5,1/6, ru:0/3/4 rp:0/5/5 rmiss:8/5/0 rlow:8/5/0 rfs:0/4/3`. The key is a stable sort of a copy, so duplicates come oldest first; the copy is cached per key and not rebuilt after a key changed through a field symbol (`mod` skips position 3 and `rp` answers the row whose key is no longer `b`); a miss is always sy-subrc 8 with sy-tabix 0
- Impact on open-steamgate: `/UI2/CL_JSON=>DESERIALIZE` in open-abap-core takes a JSON array's members through the non-unique `key_parent`, so on a system this parser would fill an internal table from an array in reverse order; on the Node host it keeps the array's order. `ZCL_OSD_STATUS=>REFRESH` numbers the database facts in that order (`ZOSD_DB-SEQ`), so the Go backend, which follows A4H, lists DatabaseSet the other way round from the Node host; the other status tables are read with ORDER BY and do not show it
- Measured again 2026-09-24 by the reviewer of ultra/json (`$ZOSG_TMP_0421`): the rule holds for 3000 duplicates, built lazily or incrementally (newest first); after `SORT ... BY ('N') DESCENDING` through a generic parameter the key keeps creation order (`3/1,2/2,1/3` while the primary order is 3,2,1), and a copy `lt2 = lt` keeps that order too; an `INSERT ... INDEX 1` through a generic parameter comes first. The front end refuses SORT and INSERT INDEX on generic tables, so keyGuard cannot be passed that way. The fix round (`$ZOSG_TMP_0422`) added: sy-tabix after ENDLOOP of a `LOOP ... USING KEY` is its value before the loop (`before:2 ... after:2`, and `2/4` after a loop with no pass), on A4H and on the transpiler alike; the testdata class now reads INDEX 2 before its first loop, so its line says `after:2`, which the old line (`after:5`) could not tell from the last pass's position
- Smallest safe workaround: the Go and JS backends of `tools/gogen` order and read sorted secondary keys as A4H does (`go/abap/seckey.go`, `js/abap.mjs` keyOrder / keyRead), and refuse `INSERT ... INDEX`, `SORT` and `DELETE` on a table with a non-unique sorted key (where "created" and "primary index" part ways) and hashed secondary keys; the Node host has none. The parser in open-abap-core relies on the oldest-first order it gets; a fix of the runtime would reverse its arrays unless the parser stops reading members through `key_parent`
- Upstream: **needs an issue** in abaplint/transpiler (runtime secondary keys); open-abap-core `/UI2/CL_JSON` `LCL_PARSER=>MEMBERS` (depends on the runtime's order). Partly fixed upstream: [abaplint/transpiler#1916](https://github.com/abaplint/transpiler/pull/1916) fixed the miss, and [open-abap/open-abap-core#1262](https://github.com/open-abap/open-abap-core/pull/1262) removed `/UI2/CL_JSON`'s dependence on the order (both merged 2026-09-25); verified 2026-09-30 against abaplint/transpiler main 78e700d and open-abap-core main caad035. Still open: the order of duplicates and the stale key copy.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_SECKEY
- Upstream version containing a fix: the miss in `abaplint/transpiler` main (first release not checked); none yet for the rest (was: none yet)

### ANOMALY-2026-09-24-create-data-like-line-generic — abaplint accepts `CREATE DATA ref LIKE LINE OF data` for a `TYPE data` parameter, which does not activate on a system; open-abap-core's `/UI2/CL_JSON` relies on it

- Status: `fixed upstream: open-abap/open-abap-core#1267, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: workaround
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/core` / `@abaplint/transpiler` 2.13.89; open-abap-core `/UI2/CL_JSON=>_DESERIALIZE` (`#ui2#cl_json.clas.abap`, the `kind_table` branch)
- Affected ABAP statement, runtime API or adapter: `CREATE DATA ref LIKE LINE OF data` where `data` is a generic parameter (`TYPE data` / `TYPE any`), not a table type
- Minimal ABAP reproducer: a method `m CHANGING data TYPE data` whose body is `DATA ref TYPE REF TO data. CREATE DATA ref LIKE LINE OF data.`
- Exact command used to run it: A4H, the method added to the ABAP Unit probe include of `ZCL_GOGEN_T_SECKEY` in `$ZOSG_TMP_0420` through ADT (2026-09-24): the syntax check refused the save; the transpiler: the same method in `/UI2/CL_JSON` is transpiled and runs on every Node host (the line type of the table the parameter holds at run time)
- Expected SAP behaviour: a syntax error, `"DATA" is not an internal table.`; the form that activates is `ASSIGN data TO <at>` (`<at> TYPE ANY TABLE`) and `CREATE DATA ref LIKE LINE OF <at>`, which A4H runs as expected (`ZCL_GOGEN_T_JSONGEN`)
- Actual open-abap behaviour: abaplint reports nothing; the transpiled code creates a line of whatever table the parameter holds
- Impact on open-steamgate: `/UI2/CL_JSON=>DESERIALIZE` into a structure with a table component (`ZCL_OSD_STATUS=>REFRESH`, the system status) would not activate on a system as open-abap-core writes it. The Go backend refuses the statement everywhere but in `/UI2/CL_JSON=>_DESERIALIZE`, where it is compiled with the transpiler's meaning (`tools/gogen/frontend.mjs` `TRANSPILER_MEANING`), so that the status tables are written on OSGo; a decision for the foreman, not a rule
- Smallest safe workaround: the exception in `TRANSPILER_MEANING`; the fix is upstream, one line in open-abap-core (`LIKE LINE OF <at>` after `ASSIGN data TO <at>`, which the method does two lines later anyway), after which the exception goes
- Upstream: was marked needs-issue in abaplint (the syntax check) and a PR in open-abap-core (`/UI2/CL_JSON=>_DESERIALIZE`). Fixed upstream by [open-abap/open-abap-core#1267](https://github.com/open-abap/open-abap-core/pull/1267), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035. The syntax check: @abaplint/core 2.120.62 now reports "data is not an internal table" for the reproducer. The TRANSPILER_MEANING exception this entry names can now be removed (not done in this change).
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_JSONGEN (the form that activates)
- Upstream version containing a fix: `@abaplint/core 2.120.62` (the syntax check) and open-abap-core main (`/UI2/CL_JSON`) (was: none yet)

### ANOMALY-2026-09-24-rtti-lengths — `describe_by_data` in open-abap-core gives an f a length of 0 and an f or a p an output length of 0

- Status: `fixed upstream: open-abap/open-abap-core#1264, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: open
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core `CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA` (the `Float` and `Packed` branches), `@abaplint/runtime` 2.13.89
- Affected ABAP statement, runtime API or adapter: `cl_abap_typedescr=>describe_by_data( )` of an `f` or a `p` field: `length`, `cl_abap_elemdescr->output_length`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_rtti.clas.abap`
- Exact command used to run it: A4H, the same class under the name `ZCL_GOGEN_T_SECKEY` in `$ZOSG_TMP_0420` through an ABAP Unit probe (2026-09-24); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core; the Go backend: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: `f:E/F/0/8/\TYPE=F/F//24 ... p:E/P/2/8/17` (an f is 8 bytes with output length 24; a p LENGTH 8 DECIMALS 2 has output length 17). The rest of the line is the same on both: `c3:E/C/0/6/3 n4:E/N/0/8/4 x2:E/X/0/2/4 d:E/D/0/16/\TYPE=D/D//8 ...`
- Actual open-abap behaviour: `f:E/F/0/0/\TYPE=F/F//0 ... p:E/P/2/8/0`
- Impact on open-steamgate: none known; nothing in the tree reads the length of an f or the output length of a p
- Smallest safe workaround: none needed on the Node host; the Go backend's `describe_by_data` (a host function, `emit-go.mjs` `nativeRttiData`) gives A4H's values
- Upstream: was marked needs-issue in open-abap-core (`CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA`). Fixed upstream by [open-abap/open-abap-core#1264](https://github.com/open-abap/open-abap-core/pull/1264), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_RTTI
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-secondary-key-unique-duplicate — the transpiler runtime appends a row that repeats a unique sorted secondary key's value; a system raises CX_SY_ITAB_DUPLICATE_KEY

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`statements/append.js`, `types/table.js`), `@abaplint/transpiler` 2.13.89
- Affected ABAP statement, runtime API or adapter: `APPEND wa TO itab` where itab is a standard table `WITH UNIQUE SORTED KEY k` and wa repeats a value of k; open-abap-core's `/UI2/CL_JSON` parser keeps its nodes in such a table (`key_full_name`, `key_full_name_upper`), so a JSON object whose member names differ only in case, or in `-` against `_`, repeats a key
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_seckeydup.clas.abap` (one row appended, a second with the same `u` appended inside TRY ... CATCH cx_sy_itab_duplicate_key)
- Exact command used to run it: A4H, the same statements in `ZCL_GOGEN_T_REFEQ2` (`$ZOSG_TMP_0422`) through an ABAP Unit probe (2026-09-24); the transpiler: `abap_transpile` 2.13.89 over the same class and open-abap-core (`.local/ultra-wip/json/tp`)
- Expected SAP behaviour: the APPEND raises the catchable `CX_SY_ITAB_DUPLICATE_KEY`, text "A row was to be added that would have produced a duplicate of the key K_U."; the row is not added
- Actual open-abap behaviour: the row is appended (`appended:2`), nothing is raised
- Impact on open-steamgate: a status snapshot POSTed to `/sap/bc/osd/status/` with keys differing only in case (`{"system":{"sid":..,"Sid":..}}`) answers `{"rows":1}` on the Node host; on a system the parser would raise, and `/UI2/CL_JSON=>DESERIALIZE` does not catch it. The Go and JS backends refuse the APPEND (NOT_COMPILED, a 500 on OSGo), naming the exception, since they do not raise it
- Smallest safe workaround: none on the Node host; the refusal in `go/abap/seckey.go` UniqueKeyCheck and `js/abap.mjs` uniqueKeyCheck. Raising the exception there is the next step once `CX_SY_ITAB_DUPLICATE_KEY` is compiled into the program
- Upstream: **needs an issue** in abaplint/transpiler (runtime unique secondary keys)
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_SECKEYDUP

### ANOMALY-2026-09-24-sort-default-key — `SORT itab` without BY leaves a table of structures unsorted in the transpiler runtime

- Status: `fixed upstream: abaplint/transpiler#1912, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: workaround
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`build/src/statements/sort.js`, `sort` without `by`: whole rows compared with `lt`)
- Affected ABAP statement, runtime API or adapter: `SORT itab [DESCENDING]` without BY on a STANDARD TABLE of structures WITH DEFAULT KEY
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_sortk.clas.abap` (the part after `key:`)
- Exact command used to run it: A4H, the same class in `$ZOSG_TMP_0400` through an ABAP Unit probe (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core, `run()` called with `@abaplint/database-sqlite` (`.local/ultra-wip/itab/tp`); the Go and JS backends: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H sorts by the default key, which for a row `name c(2), n i, s string` is `name` and `s` (the character-like components; the i is not part of it): `key:A2z;a9a;a3y;a4y;a5y;b1x;`. Rows of an elementary type sort by the line, strings by code point with "a" before "a " (`s:<><B><C><a><a ><b>`).
- Actual open-abap behaviour: `key:b1x;a3y;a4y;a5y;a9a;A2z;`, the order the table already had. The elementary cases, `STABLE BY` and mixed directions are equal to A4H.
- Impact on open-steamgate: none seen on a served path; the OSG classes that sort without BY (`ZCL_STG_SEGW_EXPORT=>TAGS`, `ZCL_STG_SEGW_GEN_DPC=>MPC_XML`) sort string tables
- Smallest safe workaround: the Go and JS backends of `tools/gogen` sort by the default key (frontend.mjs, `SORT`; the table type carries its primary key as `skey`); components of other types than c and string in a default key are refused there until measured
- Upstream: was marked needs-issue in abaplint/transpiler (runtime `sort`). Fixed upstream by [abaplint/transpiler#1912](https://github.com/abaplint/transpiler/pull/1912), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_SORTK
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-select-aggregate-position — `SELECT COUNT( * ) col ... INTO TABLE` by position writes 0 for the aggregate in the transpiler runtime

- Status: `workaround`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`build/src/statements/select.js`, the result columns moved into the target)
- Affected ABAP statement, runtime API or adapter: `SELECT COUNT( * ) id val FROM dbtab INTO TABLE itab ... GROUP BY id val` (an aggregate without AS, first in the field list, the target filled by position)
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_grpby.clas.abap` (the part after `two:`)
- Exact command used to run it: as ANOMALY-2026-09-24-sort-default-key (ZCL_GOGEN_T_GRPBY, with the table ZGOGEN_T_DBW in `$ZOSG_TMP_0400`)
- Expected SAP behaviour: `two:3,AB2=1,B2=1,C2=1`, each group counted into the first component
- Actual open-abap behaviour: `two:3,AB2=0,B2=0,C2=0`. The rest of the class (GROUP BY with `COUNT( * ) AS cnt`, INTO CORRESPONDING FIELDS, MAX / MIN / SUM, no rows: sy-subrc 4, sy-dbcnt 0) is equal to A4H.
- Impact on open-steamgate: none on a served path (`ZCL_STG_TRAVEL_CALC` names its count `AS booked`)
- Smallest safe workaround: the Go backend lowers the aggregate through the relational IR and projects the result back into the order of the field list (frontend.mjs, `groupedColumns`)
- Upstream: **needs an issue** in abaplint/transpiler (runtime `select`)
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_GRPBY
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-generic-arith — arithmetic with a generic operand is not computed in the calculation type of its run-time types in the transpiler runtime

- Status: `workaround`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`build/src/operators/*`, `_parse.js`)
- Affected ABAP statement, runtime API or adapter: `lv_i = <any> / 2 * 2`, `<any_target> = lv_i / 2 * 2` and the like: a field symbol TYPE any as operand or as target
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_genar.clas.abap`
- Exact command used to run it: as ANOMALY-2026-09-24-sort-default-key (ZCL_GOGEN_T_GENAR); each arithmetic statement of the transpiled class wrapped so that a JavaScript exception prints `!JS` and the run goes on
- Expected SAP behaviour: `i:8,70,7.00 i8:8 p:8,1.88 c:7 s:7 n:7 f:8 ti:8,-3 tp:7.00,1.75`: the calculation type the static rule gives for the types the operands and the target have at run time (an i: `/` rounds in between, so 7 / 2 * 2 is 8; a c, string, n or p operand, or a p target: p, 7; an f: f, 7.5 rounded into the i: 8)
- Actual open-abap behaviour: `i:7,70,7.00!JS i8:70 p:8,1.88 c:7 s:7 n:7 f:7 ti:7,-3 tp:7.00,1.75`: an i operand and an i target compute without rounding in between (7 instead of 8), an f likewise, and an int8 operand throws `TypeError: val.get is not a function`
- Impact on open-steamgate: `ZCL_STG_TRAVEL_CALC` (the virtual elements of `ZC_STG_TRAVEL`) computes `<lv_seats> * 100 / gc_capacity` and `<lv_seats> - ls_booked-booked`, where the difference does not show for the seed rows (Node and the Go backend answer Zc_Stg_TravelSet byte for byte alike); a `/` whose quotient is not whole, inside such an expression, would compute another value on Node than on a system
- Smallest safe workaround: the Go and JS backends of `tools/gogen` compile one branch per calculation type and choose it at run time (frontend.mjs `genericArith`, go/abap/genarith.go `CalcKind`). Deliberately refused, as NOT_COMPILED when reached, because not measured: a c or string target of an all-integer expression (the static rule would make it p), and any operand or target of a kind other than i, int8, f, p, c, string or n, with or without an f beside it
- Upstream: **needs an issue** in abaplint/transpiler (runtime operators)
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_GENAR
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-uccpi-255 — open-abap-core's `CL_ABAP_CONV_OUT_CE=>UCCPI` weighs the high byte by 255

- Status: `fixed upstream: open-abap/open-abap-core#1263, merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035`; before: workaround
- Discovery date: `2026-09-24`
- Affected versions: open-abap-core at 4eec777 (`src/conv/cl_abap_conv_out_ce.clas.abap`, `uccpi`: `ret = ret + lv_hex+1(1) * 255`)
- Affected ABAP statement, runtime API or adapter: `cl_abap_conv_out_ce=>uccpi( c )` for a character above U+00FF
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_uccp.clas.abap`
- Exact command used to run it: as ANOMALY-2026-09-24-sort-default-key (ZCL_GOGEN_T_UCCP, measured in `$ZOSG_TMP_0400`)
- Expected SAP behaviour: `A/1/65279` (the code point of U+FEFF). The same probe with `uccp( '00e4' )` gave 0 on A4H: lower-case hex is no hex digit to the c -> x move inside `uccp`, which open-abap-core's `uccp` also does, so that is not part of this entry
- Actual open-abap behaviour: `A/1/65025` (0xFE * 255 + 0xFF)
- Impact on open-steamgate: none seen; OSG calls `uccp( 'FEFF' )` (the BOM of `ZCL_STG_SEGW_GEN`) and not `uccpi` above U+00FF
- Smallest safe workaround: the Go and JS backends compute `uccpi` natively (`abap.Uccp`)
- Upstream: was marked needs-PR in open-abap-core (`* 256`), through the fork, as open-abap-core takes PRs. Fixed upstream by [open-abap/open-abap-core#1263](https://github.com/open-abap/open-abap-core/pull/1263), merged 2026-09-25; verified 2026-09-30 by running the reproducer against open-abap-core main caad035.
- Upstream version containing a fix: `open-abap/open-abap-core` main (merged 2026-09-25); first release not checked
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_UCCP

### ANOMALY-2026-09-24-class-events — the transpiler runtime dispatches class events in another order, twice, to handlers added on the way, and passes the actual by reference

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`SET HANDLER`, `RAISE EVENT`)
- Affected ABAP statement, runtime API or adapter: `SET HANDLER h->m [FOR obj | FOR ALL INSTANCES] [ACTIVATION act]`, `RAISE EVENT e EXPORTING p = v`
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_events.clas.abap` and `zcl_gogen_t_events2.clas.abap` (with `zif_gogen_t_evi`, `zcx_gogen_t_rnochk`)
- Exact command used to run it: A4H, the same classes as ABAP Unit probes in `$ZOSG_TMP_0440` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the classes and open-abap-core, `RUN` called from Node; the Go backend: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H answered, for EVENTS, `none:[] order:a.p(2,s)b.q(2)c.p(2,s) other:[] twice:a.p(4,s) off:b.p(5,s) again:a.p(6,s)b.p(6,s) var:a.p(7,s) kill:a.kill kill2:a.kill add:a.add add2:a.addc.p(11,s) boom:a.boom.caught val:a.m(5,105)b.m(105,205) all:a.q(13)c.p(13,x)b.p(14,y)a.q(14)c.p(14,y) both:b.p(15,y)c.p(15,y)a.q(15)c.p(15,y) offone:b.p(16,y)a.q(16)c.p(16,y) offall:b.p(18,y) stat:static(19,s) sev:a.s(20)b.s(20) sev2:b.s(21) intf:a.i(hi,s)` and for EVENTS2 `revive:a.revive allfirst:b.p(2,s)c.p(2,s) nest:a.n1(a.n2()b.p(2,s))b.p(1,s) self:a.self3b.p(3,s)b.p(4,s) rev:c.p(5,s)a.p(5,s)b.q(5)b.p(5,s) back:a.p(6,s)b.p(6,s)c.p(6,s) holes:b.q(7)b.p(7,s)a.q(7) holes2:b.q(8)b.p(8,s)a.q(8)`. The rules read off it: a handler registered twice is called once; the handlers of one sender are a table with holes (a deactivation frees its place, a new registration takes the lowest free one, else it is appended); FOR the sender before FOR ALL INSTANCES whatever the order of registration; a dispatch calls what was active when it started and still is when reached (one added or reactivated on the way is not called); the actual of an event parameter is read anew for each handler (`val`); an exception out of a handler ends the dispatch. A4H-only probe (`ZCL_GOGEN_T_EVGC`, weak references): a registration FOR an object keeps the handler alive as long as the sender lives and does not keep the sender; FOR ALL INSTANCES and a static event keep the handler; a deactivated one is released; a division by zero in a handler arrives as CX_SY_NO_HANDLER (the handler declares no RAISING); SET HANDLER with an initial handler or FOR an initial reference is a runtime abortion CATCH does not take
- Actual open-abap behaviour: EVENTS `... twice:a.p(4,s)a.p(4,s) ... again:b.p(6,s)a.p(6,s) ... add:a.addc.p(10,s) add2:a.addc.p(11,s)c.p(11,s) ... val:a.m(105,105)b.m(205,205) all:a.q(13)c.p(13,x)a.q(14)b.p(14,y)c.p(14,y) both:a.q(15)b.p(15,y)c.p(15,y)c.p(15,y) offone:a.q(16)b.p(16,y)c.p(16,y) ... sev2: ...` and EVENTS2 `revive:a.revivec.p(1,s) allfirst:c.p(2,s)b.p(2,s) ... self:a.self3b.p(3,s) ... back:b.p(6,s)a.p(6,s)c.p(6,s) holes:b.q(7)a.q(7) holes2:b.q(8)a.q(8)`: a duplicate registration is called twice; a re-registration goes to the end; a handler added or reactivated during a dispatch is called in it; FOR ALL INSTANCES before FOR the sender; the actual is the caller's variable (a change by one handler shows as the next handler's parameter and its own); deactivating one static handler (`sev2`) removes both; a handler that deactivates itself leaves out a later handler on the next dispatch (`self`); a deactivation among three removes another handler's registration too (`holes`)
- Impact on open-steamgate: the WEBGUI's GUI control substitutes (open-abap-gui, `cl_gui_html_viewer` raising `sapevent`, abapGit's viewer re-raising it) register one handler per sender, so the sapevent round trip answers the same on both hosts; code that registers a handler twice, reorders handlers or relies on the order against FOR ALL INSTANCES would not
- Smallest safe workaround: none on Node; the Go backend and the IR's JS emitter implement the measured rules (`tools/gogen/go/abap/events.go`, `js/abap.mjs` setHandler / raiseEvent)
- Upstream: **needs an issue** in abaplint/transpiler (runtime, SET HANDLER / RAISE EVENT)
- Also (fix round, 2026-09-24, `$ZOSG_TMP_0441`): `zcl_gogen_t_events3.clas.abap` (with `zcl_gogen_t_evb`, `zcl_gogen_t_evs`) answered `all:b(base)s(sub)b(sub)s(sub2)b(sub2) one:s(sub2)` on A4H: a handler FOR EVENT e OF a subclass, registered FOR ALL INSTANCES, is called for senders of that subclass only, whatever the static type of the raising reference. The transpiler runtime does not get there: `SET HANDLER h->on_s h->on_b FOR ALL INSTANCES ACTIVATION abap_false` raises `ABAPEventing.setHandler: deactivation of multiple methods not supported, todo`
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_EVENTS, ZCL_GOGEN_T_EVENTS2, ZCL_GOGEN_T_EVENTS3
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-24-concatenate-cut-subrc — `CONCATENATE` into a c field too short leaves sy-subrc 0 in the transpiler runtime

- Status: `fixed upstream: abaplint/transpiler#1914, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`statements/concatenate`)
- Affected ABAP statement, runtime API or adapter: `CONCATENATE a b INTO c` with `c` of type c shorter than the result
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_wgui1.clas.abap` (`CONCATENATE 'ab' 'cd' INTO lv_c3.`)
- Exact command used to run it: A4H, the same class as an ABAP Unit probe in `$ZOSG_TMP_0440` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89; the Go backend: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: `[abc]4`: the result is cut to the field and sy-subrc is 4
- Actual open-abap behaviour: `[abc]0`: cut, and sy-subrc 0. Everything else in the class (line_exists, NS / CN, reference comparison, a SORTED table's INSERT INTO TABLE leaving sy-tabix alone, APPEND ... ASSIGNING, the other CONCATENATE forms, FIND ALL OCCURRENCES ... MATCH COUNT with a CL_ABAP_REGEX object, escape( ) for an HTML attribute) answered as A4H
- Impact on open-steamgate: none found in OSG's code, which concatenates into strings
- Smallest safe workaround: none needed; the Go backend sets 4 (`abap.ConcatFit`)
- Upstream: was marked needs-issue in abaplint/transpiler (runtime, CONCATENATE). Fixed upstream by [abaplint/transpiler#1914](https://github.com/abaplint/transpiler/pull/1914), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_WGUI1
- See also: ANOMALY-2026-09-24-concatenate-subrc, the same runtime statement measured from the other side (no cut: A4H sets 0; `concatenate.js` never writes sy-subrc, so the 0 above is the value the statement before left)
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-sorted-read-miss-tabix — a key READ that misses on a SORTED table sets sy-tabix one row short in the transpiler runtime

- Status: `fixed upstream: abaplint/transpiler#1916, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`statements/read_table`)
- Affected ABAP statement, runtime API or adapter: `READ TABLE <sorted> ... WITH [TABLE] KEY ...` that finds nothing, where the key's first component is given
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_sortrd.clas.abap`
- Exact command used to run it: A4H, the same class as an ABAP Unit probe in `$ZOSG_TMP_0441` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core, `RUN` called from Node; the Go backend: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: `hit:0/3/3 mid:4/3/c first:4/1 past:8/5 tk:4/3,8/5 fs:4/4 nf:8/5 nonkey:0/4,4/0 kv:0/3 lead:0/1/1,0/3/3,4/2,8/5,4/1 second:0/3,4/0 tk2:4/4 line:4/2/f,0/2/q,8/3`: a miss is sy-subrc 4 with sy-tabix the row the key would go before, or sy-subrc 8 with sy-tabix lines + 1 when it would go after the last row; a key given only in components outside the table key is a linear search, a miss 4/0; a miss leaves the work area alone
- Actual open-abap behaviour: `... past:8/4 tk:4/3,8/4 ... nf:8/4 ... lead:0/1/1,0/3/3,4/1,8/4,4/1 ... tk2:4/3 line:4/2/f,0/2/q,8/2`: past the last row sy-tabix is lines, not lines + 1; a miss inside a leading part of a two-component key (`a = '1' b = '2'` between `11` and `13`) and a miss of the whole two-component key point one row too early
- Impact on open-steamgate: none found; code that uses sy-tabix after a miss to `INSERT ... INDEX sy-tabix` into a sorted table would place the row wrong or dump
- Smallest safe workaround: none needed; the Go backend and the IR's JS emitter follow A4H (a miss with a key part and a component outside the key, `ZCL_GOGEN_T_SORTRD2`, had no rule derivable from the measurements and is refused)
- Upstream: was marked needs-issue in abaplint/transpiler (runtime, READ TABLE on sorted tables). Fixed upstream by [abaplint/transpiler#1916](https://github.com/abaplint/transpiler/pull/1916), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_SORTRD, ZCL_GOGEN_T_SORTRD2
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-sorted-importing-standard — abaplint accepts a STANDARD table for an IMPORTING parameter typed SORTED, which does not activate on a system

- Status: `open`
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/core` as used by `abap_transpile` 2.13.89
- Affected ABAP statement, runtime API or adapter: a method call passing a STANDARD table to `IMPORTING it TYPE <sorted table type>`
- Minimal ABAP reproducer: `tools/gogen/testdata-refused/zcl_gogen_t_rf_sort.clas.abap`, its last line (`show( lt_t )`)
- Exact command used to run it: A4H, `$ZOSG_TMP_0441` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89
- Expected SAP behaviour: the class does not activate: "LT_T is not type-compatible with formal parameter IT". Without that line A4H answers `mv:ab vl:cd rk:dc empty:0 back:2`: a move and a VALUE into a SORTED table sort the rows, a move between SORTED tables of different keys re-sorts them
- Actual open-abap behaviour: abaplint reports nothing, the transpiler writes it and the run answers `mv:ab vl:cd rk:dc empty:0 back:2 pm:cd`. The moves themselves answer as A4H
- Impact on open-steamgate: none found; a source that passes this check here may fail to activate on a system
- Smallest safe workaround: none needed; the Go backend refuses the call (and, for now, every move or VALUE that would fill a SORTED table from rows in another order)
- Upstream: **needs an issue** in abaplint/abaplint (check_syntax, parameter type compatibility)
- Regression-test location: `tools/gogen/semantics.mjs` REFUSED_SORT

### ANOMALY-2026-09-24-concatenate-subrc — `CONCATENATE` leaves sy-subrc as it was in the transpiler runtime

- Status: `fixed upstream: abaplint/transpiler#1914, merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d`; before: open (the Go backend of tools/gogen sets it; nothing depends on it in OSG yet)
- Discovery date: `2026-09-24`
- Affected versions: `@abaplint/runtime` 2.13.89 (`statements/concatenate.js` never writes `sy-subrc`)
- Affected ABAP statement, runtime API or adapter: `CONCATENATE ... INTO t [IN BYTE MODE]`; in OSG the SMW0 loaders of the Zork and ZO4D packs (`zcl_ork_00_game_loader_smw0`, `zcl_ork_00_script_loader_smw0`, `zcl_o4d_image_handler`), which glue `WWWDATA_IMPORT`'s rows together this way
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_bytecat.clas.abap` (a `READ TABLE ... INDEX 1` on an empty table sets sy-subrc 4, then `CONCATENATE lv_xs lv_x INTO lv_xs IN BYTE MODE`)
- Exact command used to run it: A4H, the same class as an ABAP Unit probe in `$ZOSG_TMP_0460` (2026-09-24, deleted after); the transpiler: `abap_transpile` 2.13.89 over the class and open-abap-core, `run( )` called from Node; the Go and JS backends: `node tools/gogen/semantics.mjs`
- Expected SAP behaviour: A4H `cat:FFAB00CD00/5/0 zeros:0000AB00CD00/6 empty:0/0` -- sy-subrc 0 after the statement (4 is only for a target of fixed length that cut the result); an `x` operand keeps its trailing 00 bytes in byte mode
- Actual open-abap behaviour: `cat:FFAB00CD00/5/4 zeros:0000AB00CD00/6 empty:0/4` -- the bytes are right, sy-subrc is whatever the statement before left
- Impact on open-steamgate: none seen; a program that checks sy-subrc after CONCATENATE into a fixed-length field reads the previous statement's code
- Smallest safe workaround: none needed in OSG; the Go backend writes sy-subrc 0 (`concat_bytes` in `tools/gogen/emit-go.mjs` / `emit-js.mjs`)
- Upstream: was marked needs-issue in abaplint/transpiler (runtime, `concatenate`). Fixed upstream by [abaplint/transpiler#1914](https://github.com/abaplint/transpiler/pull/1914), merged 2026-09-25; verified 2026-09-30 by running the reproducer against abaplint/transpiler main 78e700d.
- Regression-test location: `tools/gogen/semantics.mjs` ZCL_GOGEN_T_BYTECAT
- See also: ANOMALY-2026-09-24-concatenate-cut-subrc (a c target that cuts the result: 4 on A4H)
- Upstream version containing a fix: `abaplint/transpiler` main (merged 2026-09-25); first release not checked (was: none yet)

### ANOMALY-2026-09-24-float-template-digits — an `f` in a string template has sixteen fraction digits in the transpiler runtime, seventeen significant digits on a system

- Status: `open` (the Go backend formats as A4H does; the Node host answers the other digits)
- Discovery date: `2026-09-24` (as a difference between the hosts; the A4H format was measured 2026-09-23 for `tools/gogen`)
- Affected versions: `@abaplint/runtime` 2.13.89 (`template_formatting.js`: a `Float` that is not whole is `raw.toFixed(16)`)
- Affected ABAP statement, runtime API or adapter: `|{ f }|` without formatting options; in OSG every number of the ZO4D channel's JSON (`zcl_o4d_apc_handler`: `"fps":{ mo_demo->get_fps( ) }`, every frame's coordinates)
- Minimal ABAP reproducer: `DATA f TYPE f. f = 152 * 16 / 60. rv = |{ f }|.`; the fifteen values of `tools/gogen/go/abap/fmtf_test.go`
- Exact command used to run it: the ZO4D push channel on OSG (Node, `test/run.mjs`, main 42755c5) and on OSGo (branch ultra/packs) side by side, the same commands (`.local/ultra-packs-pw/wscmp.mjs`, `get_megademo` then frames); A4H: the 2026-09-23 measurement behind `FmtF` (README "The f format of a string template")
- Expected SAP behaviour: seventeen significant digits, always positional, trailing zeros dropped: `40.533333333333331`, `0.39473684210526316`, `0.015625`
- Actual open-abap behaviour: sixteen digits after the point whatever the magnitude, zeros kept: `40.5333333333333314`, `0.3947368421052632`, `0.0156250000000000`; a small number loses significant digits (`0.0246710526315789` for `0.024671052631578948`)
- Impact on open-steamgate: the demo's JSON differs from A4H's in the last digits of most numbers; the page parses them back, so nothing on the screen changes. A value re-read with fewer significant digits is not the same double
- Smallest safe workaround: none in OSG; compare frames numerically (`NUMERIC=1` in the comparison script)
- Upstream: **needs an issue** in abaplint/transpiler (runtime, template formatting of `f`)
- Regression-test location: `tools/gogen/go/abap/fmtf_test.go`
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-25-zip-read-int4 — open-abap-core's `CL_ABAP_ZIP=>LOAD` overflows `i` in `LCL_STREAM=>READ_INT4`, and the transpiler runtime lets it through

- Status: `open` The transpiler runtime's `i` range check: abaplint/transpiler#1955 (open), pinned 2026-10-08 as `libs.lock.json` transpiler oisee/transpiler `local/osd-build-2026-10-08b` 753230cb = the previous pin e2a459b1 plus its four commits.
- Discovery date: `2026-09-25`
- Affected versions: open-abap-core (`src/abap/cl_abap_zip.clas.locals_imp.abap`, as cloned in `.local/lars/open-abap-core`); `@abaplint/runtime` 2.13.89
- Affected ABAP statement, runtime API or adapter: `LCL_STREAM=>READ_INT4` (and `READ_INT2`'s pattern): `DO 4 TIMES. ... lv_factor = lv_factor * 256. ENDDO.`, which after the fourth byte computes 256 ** 4 into an `i`; `CL_ABAP_ZIP=>LOAD` calls it for every header
- Minimal ABAP reproducer: `DATA lv_factor TYPE i VALUE 1. DO 4 TIMES. lv_factor = lv_factor * 256. ENDDO.`
- Exact command used to run it: `node tools/gogen/semantics.mjs` on branch ultra/parity-wave2 with a LOAD in ZCL_GOGEN_T_ZIP (taken out again): Go stops with `CX_SY_ARITHMETIC_OVERFLOW in * at cl_abap_zip.clas.locals_imp.abap:63`
- Expected SAP behaviour: `CX_SY_ARITHMETIC_OVERFLOW` (the rule measured on A4H for ANOMALY-2026-09-23-epoch-ms-overflow: `i` arithmetic is range checked). SAP's own `CL_ABAP_ZIP=>LOAD` is other code and not affected
- Actual open-abap behaviour: the JavaScript runtime computes 4294967296 into the `i` and LOAD works on Node
- Impact on open-steamgate: none today; OSG saves zips (SEGW `RepoSet`, `CL_ABAP_ZIP=>SAVE`) and loads none. A host that checks `i` (OSGo) cannot LOAD a zip through open-abap-core
- Smallest safe workaround: none needed yet; the fix is one line upstream (multiply only while bytes remain)
- Upstream: **needs an issue** in open-abap/open-abap-core (the method), and the runtime's missing range check is the one ANOMALY-2026-09-23-epoch-ms-overflow already names
- Regression-test location: none yet (ZCL_GOGEN_T_ZIP pins SAVE only)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-29-gogen-ir-pairs-behind-main — the Go runtime of gogen does not yet do 20 IR pairs main added after it was branched

- Status: `fixed` (2026-09-30, branch `feat/gogen-known-gaps`: all 104 WHERE and 16 write pairs pass in Go, the known-gap list is empty)
- Discovery date: `2026-09-29`
- Affected versions: `tools/gogen/go/abap` as landed from `spike/osabap-app` (branched from main at `9db735de`, 2026-09-23)
- Affected ABAP statement, runtime API or adapter: Open SQL `WHERE` over packed and RAW columns and `UPSERT ... SELECT`, lowered by the Go runtime and compared with `test/fixtures/ir-pairs/osql-where.json` and `writes.json`
- Minimal ABAP reproducer: the named pairs in those two files
- Exact command used to run it: `cd tools/gogen/go && go test ./abap/ -run 'TestOsqlWherePairs|TestWritesPairs' -v`
- Expected SAP behaviour: as the pairs record it, measured for the Node IR in main #47 and #55 (packed literals), #66 (RAW columns: data errors as outcomes, the PostgreSQL bytea parameter) and #64 (`UPSERT ... SELECT`)
- Actual open-abap behaviour: 18 WHERE pairs and 2 write pairs fail in Go (4 packed, 14 RAW, 2 UPSERT ... SELECT); the RAW data errors panic where the pairs expect an outcome
- Impact on open-steamgate: the Go runtime is not yet a drop-in for those statements; the Node runtime is unaffected
- Smallest safe workaround: while open, `tools/gogen/go/abap/knowngaps_test.go` listed exactly these 20 (a listed pair that starts to pass, or any other failure, turns the test red); the list is empty now
- Upstream issue: not upstream; ported to Go on `feat/gogen-known-gaps`, which removed the entries
- Fix: the Go placeholders follow `tools/sqlscript-lower.mjs` again (SQLite binds a packed value as `CAST(? AS NUMERIC)` and an integer as `CAST(? AS INTEGER)` -- the latter covered by no pair, Go binds integers as int64 anyway --, DuckDB as `CAST(? AS DECIMAL(n,d))`, PostgreSQL a RAW(n) as `varchar(2n)`); a RAW literal that is not exactly its 2n upper-case hex digits is `OsqlWhereData` (CX_SY_OPEN_SQL_DATA_ERROR, catchable from a dynamic SELECT as before) rather than a panic; `UPSERT ... SELECT` and an upsert's `fill` columns render as `lower()` does for SQLite. `knownGaps` stays, empty, for the next time main's pairs run ahead
- Regression-test location: `tools/gogen/go/abap/osqlwhere_test.go`, `writes_test.go`, `knowngaps_test.go`
- Upstream version containing a fix: not applicable

### ANOMALY-2026-09-30-unit-exception-aborts-run — the ordinary transpiler Unit runner stops after the first exception

- Status: `open`
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/transpiler` 2.13.89 (`build/src/unit_test.js`, generated `output/index.mjs`)
- Affected ABAP statement, runtime API or adapter: ABAP Unit lifecycle when a test method raises an uncaught exception or an assertion fails
- Minimal ABAP reproducer: `tools/gogen/testdata-unit/zcl_gogen_unit_fixture.clas.testclasses.abap` has `FAIL`, `EXCEPTION`, and `AFTER_FAILURE` methods with a teardown hook
- Exact command used to inspect it: `sed -n '210,245p' node_modules/@abaplint/transpiler/build/src/unit_test.js`; `node --test tools/gogen/unit.test.mjs` exercises the continuing lifecycle in the Go runner
- Expected SAP behaviour: each method has a fresh instance; teardown runs after a failed method, later methods still run, and class teardown runs at the end ([SAP Help: ABAP Unit test execution](https://help.sap.com/docs/ABAP_PLATFORM_NEW/c238d694b825421f940829321ffa326a/baf1b5eb64254b8e8a4e5e79437cd441.html))
- Actual open-abap behaviour: the generated ordinary Node runner has one outer `run().catch`; an exception in a method skips its teardown, later methods, and class teardown
- Impact on open-steamgate: an ordinary Node Unit run reports only the first failure and misses later outcomes
- Smallest safe workaround: `tools/gogen/node-unit-results.mjs` instruments the same Node metadata but catches per method and runs the remaining lifecycle; `tools/gogen/unit-compare.mjs` uses its per-method rows as the comparison oracle. The ordinary Node path is unchanged
- Upstream: **needs an issue** in abaplint/transpiler (Unit runner exception handling)
- Regression-test location: `tools/gogen/unit.test.mjs` lifecycle fixture
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-dataset-not-supported — every DATASET statement throws "not supported" in the transpiler

- Status: `pinned locally; upstream: backlog` (the hook is on `oisee/transpiler` `local/osd-build-2026-09-30` at `ddb0a993`; the same change as a single commit on branch `dataset-hook` off abaplint/transpiler main passed the critic gate and waits for the maintainer's capacity)
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/transpiler` and `@abaplint/runtime` up to 2.13.93 on npm and abaplint/transpiler main at dd83da9
- Affected ABAP statement, runtime API or adapter: `OPEN DATASET`, `READ DATASET`, `TRANSFER`, `CLOSE DATASET`, `DELETE DATASET`, `GET DATASET`, `SET DATASET` (TRUNCATE and SORT are unchanged)
- Minimal ABAP reproducer: `OPEN DATASET 'f' FOR INPUT IN BINARY MODE.`
- Exact command used to run it: any transpile and run of the reproducer
- Expected SAP behaviour: as measured on A4H on 2026-09-30 by two throwaway probes (docs/dataset.md lists every case): text mode UTF-8 lines, the last without LF, a CR kept, C without trailing blanks; binary mode UTF-16LE for character-like fields; ACTUAL LENGTH, sy-subrc 0/4/8; CX_SY_FILE_OPEN_MODE for READ or TRANSFER on a file not open and TRANSFER on one opened FOR INPUT; CX_SY_FILE_OPEN for OPEN twice; DELETE of an open file closes it
- Actual open-abap behaviour: `throw new Error("OpenDataset, not supported, transpiler")` for every statement
- Impact on open-steamgate: no report that reads or writes a file ran; osabap had no file I/O
- Smallest safe workaround: the pinned hook, with the host `tools/osd-dataset.mjs` installed by `test/setup.mjs`
- Upstream: abaplint/transpiler, branch `dataset-hook` (not pushed yet), one PR when Lars has room. Sent 2026-09-30 as [abaplint/transpiler#1936](https://github.com/abaplint/transpiler/pull/1936) from the branch `dataset-hook`, open; the local pin stays until it is released.
- Regression-test location: `test/dataset.mjs` (the host), `test/statements/dataset.ts` upstream (the statements, 19 cases)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-dataset-authority — the sandbox refuses with sy-subrc 8, where a system's S_DATASET check raises CX_SY_FILE_AUTHORITY

- Status: `open` (by design until measured)
- Discovery date: `2026-09-30`
- Affected versions: `tools/osd-dataset.mjs` as introduced for X0
- Affected ABAP statement, runtime API or adapter: `OPEN DATASET` / `DELETE DATASET` on a name outside `OSD_DATASET_READ` / `OSD_DATASET_WRITE`
- Minimal ABAP reproducer: `OPEN DATASET '/etc/passwd' FOR INPUT IN TEXT MODE ENCODING UTF-8 MESSAGE lv_msg.` with no roots set
- Exact command used to run it: any unit run or server started without the two variables
- Expected SAP behaviour: not measured -- the A4H probe user has full authority, so the authority denial could not be produced there; SAP documents CX_SY_FILE_AUTHORITY for a failed S_DATASET check
- Actual open-abap behaviour: sy-subrc 8 and MESSAGE `Permission denied: <name> is outside the dataset roots`; DELETE outside a write root is sy-subrc 4
- Impact on open-steamgate: a program that CATCHes CX_SY_FILE_AUTHORITY sees no exception and reads sy-subrc instead; one that checks sy-subrc after OPEN, the common shape, behaves as on a missing file
- Smallest safe workaround: the measured "cannot open" shape was chosen deliberately; revisit when a user without S_DATASET can be probed
- Upstream: not upstream, this is our host
- Regression-test location: `test/dataset.mjs` ("with no root, everything is refused")
- Upstream version containing a fix: not applicable

### ANOMALY-2026-09-30-amc-caller-identity — the Go host names the AMC caller when compiling, Node reads it off the stack

- Status: `open` (by design; the two agree on every case measured)
- Discovery date: `2026-09-30`
- Affected versions: `tools/osd-amc.mjs` (Node) and `tools/gogen/go/amc` with `frontend.mjs` `AMC_CALLER` (Go)
- Affected ABAP statement, runtime API or adapter: the SAMC authority check of `CL_AMC_CHANNEL_MANAGER`, `IF_AMC_MESSAGE_PRODUCER_*~SEND` and `IF_AMC_MESSAGE_CONSUMER~START_MESSAGE_DELIVERY`
- Minimal ABAP reproducer: `test/unit/zcl_osd_amc_test.clas.testclasses.abap` `unauthorised_send`
- Exact command used to run it: `node tools/gogen/unit-compare.mjs --class ZCL_OSD_AMC_TEST`
- Expected SAP behaviour: the program in whose code the call stands is checked against the SAMC authorities (its class pool, `ZCL_X====...CP`)
- Actual open-abap behaviour: Node takes the nearest `*.clas(.testclasses).mjs` frame on the JavaScript stack that is not the AMC classes; Go marks at compile time every method of a class whose source names the AMC API (a producer kept in an attribute counts) and enters that class's pool on the session while it runs, the innermost one being the caller. They differ only for a class whose source never names the API but calls it on an object it was handed (a helper that takes `REF TO object`): Go attributes that call to the class that entered last, Node to the helper
- Impact on open-steamgate: none on the suite (8 of 8 the same); only the handed-object helper above could see a difference
- Smallest safe workaround: authorise the class that names the API; typing the helper's parameter as the AMC interface makes Go attribute it to the helper too
- Upstream: not upstream; host code
- Regression-test location: `ZCL_OSD_AMC_TEST` on both hosts (`unit-compare.mjs`), `tools/gogen/go/amc` `TestAuthority`
- Upstream version containing a fix: not applicable

### ANOMALY-2026-09-30-amc-go-wait-holds-work-process — WAIT FOR MESSAGING CHANNELS keeps the Go work process

- Status: `open`
- Discovery date: `2026-09-30`
- Affected versions: `tools/gogen/go/amc` `Wait` as emitted by `emit-go.mjs` `amc_wait`
- Affected ABAP statement, runtime API or adapter: `WAIT FOR MESSAGING CHANNELS UNTIL ... UP TO ... SECONDS` in a step that holds `abap.WorkProcess` (an APC or ICF step of osgo)
- Minimal ABAP reproducer: a handler that WAITs for a message another request sends
- Exact command used to run it: not in a suite yet; the unit run holds no work process and is not affected
- Expected SAP behaviour: WAIT rolls the session out, and other work runs meanwhile (docs/abap-daemons.md: "WAIT releases WorkProcess")
- Actual open-abap behaviour: the waiting goroutine keeps the mutex, so a producer in another step runs only after the WAIT ends or times out
- Impact on open-steamgate: the unit run and single-session use are exact; cross-request AMC on osgo is delayed by up to the WAIT's timeout
- Smallest safe workaround: none needed for the suite; release the work process around the select in `amc.Wait` (a hook the generated code passes) when osgo serves AMC across requests. Related, same condition: nothing calls `amc.Broker.Forget` yet, so a long-running osgo keeps each session's inbox, id and the producer and consumer bindings
- Upstream: not upstream; host code
- Regression-test location: none yet
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-amc-go-delivery-luw — on Go an AMC receiver runs in the waiting session's LUW

- Status: `open` (documented difference between the hosts)
- Discovery date: `2026-09-30`
- Affected versions: `tools/gogen/go/amc` Pump/Wait as emitted by `emit-go.mjs`, against `tools/osd-amc.mjs` `drainAmcSession`
- Affected ABAP statement, runtime API or adapter: `IF_AMC_MESSAGE_RECEIVER_*~RECEIVE` called during `WAIT FOR MESSAGING CHANNELS`
- Minimal ABAP reproducer: a receiver that writes a table row, and a waiting method that rolls back after the WAIT
- Exact command used to run it: not in a suite; found by reading (the critic on #263)
- Expected SAP behaviour: not measured on A4H for this case (P8 measured delivery at SEND and ROLLBACK not retracting a message)
- Actual open-abap behaviour: Node runs each delivery in a dialog step of its own, which commits at its end, and so also commits what the waiter had pending; Go runs RECEIVE inside the waiter's LUW, so its writes stand or fall with the waiter's next COMMIT or ROLLBACK. On Go a subscription stopped inside RECEIVE loses the messages still queued for it; Node keeps delivering them
- Impact on open-steamgate: the suite does not write in a receiver; a program that does and then rolls back keeps the receiver's rows on Node and loses them on Go
- Smallest safe workaround: COMMIT WORK in the receiver when its writes must stand
- Upstream: not upstream; host code
- Regression-test location: none yet
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-macro-argument-dollar — abaplint cannot parse a macro call whose argument contains "$`" or "$'"

- Status: `fixed upstream` in `@abaplint/core` 2.120.62; this tree still locks 2.120.55 and gets it with the next lock update
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/core` 2.120.55 (this tree) and 2.120.61 (upstream `main`, 2026-09-30), `abap/2_statements/expand_macros`
- Affected ABAP statement, runtime API or adapter: a call of a `DEFINE` macro whose literal argument contains `$` followed by a backtick or a quote
- Minimal ABAP reproducer:

  ```abap
  DEFINE m.
    WRITE &1.
  END-OF-DEFINITION.
  m `$`.
  ```

- Exact command used to run it: save the four lines as `zmacro.prog.abap` and run
  `node -e "const a=require('@abaplint/core');const r=new a.Registry().addFile(new a.MemoryFile('zmacro.prog.abap',require('fs').readFileSync('zmacro.prog.abap','utf8'))).parse();console.log(r.findIssues().filter(i=>i.getKey()==='parser_error').map(i=>i.getMessage()))"`
  in this tree; it prints one `parser_error`. Without the macro (`WRITE ` + the literal) there is none.
- Expected SAP behaviour: the macro expands to ``WRITE `$`.``; sbcgua/abap_mustache has such calls in its unit tests, and that code is maintained on SAP systems. Not measured on A4H
- Actual open-abap behaviour: `expandContents` substitutes the placeholders with `str.replace(reg, input)`; a string replacement reads `` $` `` and `$'` as "the text before / after the match", so the argument is spliced with the macro body and the statement does not parse
- Impact on open-steamgate: none in OSG's code; a library that uses such macros does not build
- Smallest safe workaround: none in the tree; avoid `$` next to a quote in macro arguments
- Upstream: [abaplint/abaplint#4342](https://github.com/abaplint/abaplint/pull/4342) (fork PR from oisee/abaplint, after the critic gate), merged 2026-09-30: `str.replace(reg, () => input)` plus a test in `packages/core/test/abap/macros.ts`
- Regression-test location: upstream, `packages/core/test/abap/macros.ts`
- Upstream version containing a fix: `@abaplint/core` 2.120.62 (checked in the npm tarball: `expand_macros.js` line 204)

### ANOMALY-2026-09-30-concatenate-lines-string-trim — `CONCATENATE LINES OF` drops trailing blanks of string rows in the transpiler runtime

- Status: `fixed upstream`, merged 2026-09-30, not yet released (`@abaplint/runtime` 2.13.94 predates the merge)
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/runtime` 2.13.89 (this tree) and abaplint/transpiler `main` 3251a8c (2.13.94); `statements/concatenate`, the LINES branch
- Affected ABAP statement, runtime API or adapter: `CONCATENATE LINES OF itab INTO str [SEPARATED BY sep]` without `RESPECTING BLANKS`, rows of type `string`
- Minimal ABAP reproducer:

  ```abap
  DATA lt TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
  DATA lv TYPE string.
  APPEND `a ` TO lt.
  APPEND `b` TO lt.
  CONCATENATE LINES OF lt INTO lv.
  ASSERT lv = `a b`.
  ```

- Exact command used to run it:

  ```sh
  git clone https://github.com/abaplint/transpiler && cd transpiler
  git checkout 5ecf76bb2f352fa38668c82b577a8368d239051f     # the merge of #1935: fix and tests
  npm run install && npm run compile
  npx mocha --timeout 60000 -g "CONCATENATE LINES OF"       # passes
  git checkout 5ecf76bb^1 -- packages/runtime/src/statements/concatenate.ts
  npm run compile
  npx mocha --timeout 60000 -g "CONCATENATE LINES OF"       # the string-row test fails
  ```

  Without the runtime change the string-row test gets `2` and `a-b` instead of `3` and `a -b`
- Expected SAP behaviour: `a b`. ABAP keyword documentation 7.50, CONCATENATE, `RESPECTING BLANKS`: "If this addition is not used, the blanks are respected for data type string only." Not measured on A4H
- Actual open-abap behaviour: the LINES branch calls `trimEnd()` on every row; the non-LINES branch trims only `Character` operands
- Impact on open-steamgate: none in `src/` or `packs/*/src` (no `CONCATENATE LINES OF` there, grep 2026-09-30); found through abap_mustache, whose `join_strings` uses it over a `string_table`
- Smallest safe workaround: join with a loop and `&&`, or add `RESPECTING BLANKS`
- Upstream: [abaplint/transpiler#1935](https://github.com/abaplint/transpiler/pull/1935) (branch in the repository, after the critic and a heads-up to stoker), merged 2026-09-30; Regression 17 of 17 green in the bot table, performance unchanged. Not pinned locally: nothing here needs it
- Regression-test location: upstream, `test/statements/concatenate.ts`
- Upstream version containing a fix: none released yet

### ANOMALY-2026-09-30-write-date-unformatted — `WRITE d TO c` leaves a date unformatted while `|{ d DATE = ENVIRONMENT }|` formats it, in the transpiler runtime

- Status: `open`
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/runtime` 2.13.89 with open-abap-core `52ba51a5` (`libs.lock.json` on `main` at `ae0ad3e9`)
- Affected ABAP statement, runtime API or adapter: `WRITE <date> TO <c field>` against a string template with `DATE = ENVIRONMENT`
- Minimal ABAP reproducer:

  ```abap
  DATA d TYPE d VALUE '20230528'.
  DATA c TYPE c LENGTH 20.
  WRITE d TO c LEFT-JUSTIFIED.
  ASSERT c = |{ d DATE = ENVIRONMENT }|.
  ```

- Exact command used to run it: save as `test/unit/zcl_tmp_date_probe.clas.abap` and `test/unit/zcl_tmp_date_probe.clas.testclasses.abap`, run `npm run unit`, delete both:

  ```abap
  CLASS zcl_tmp_date_probe DEFINITION PUBLIC FINAL CREATE PUBLIC.
  ENDCLASS.
  CLASS zcl_tmp_date_probe IMPLEMENTATION.
  ENDCLASS.
  ```

  ```abap
  CLASS ltcl DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.
    PRIVATE SECTION.
      METHODS date FOR TESTING.
  ENDCLASS.
  CLASS ltcl IMPLEMENTATION.
    METHOD date.
      DATA d TYPE d VALUE '20230528'.
      DATA c TYPE c LENGTH 20.
      WRITE d TO c LEFT-JUSTIFIED.
      cl_abap_unit_assert=>assert_equals( exp = |{ d DATE = ENVIRONMENT }| act = c ).
    ENDMETHOD.
  ENDCLASS.
  ```

  The assertion fails with `05/28/2023` against `20230528` (first seen as abap_mustache's `find_value_date_and_time`)
- Expected SAP behaviour: both follow the user's date format, so the assertion holds. Not measured on A4H
- Actual open-abap behaviour: `WRITE ... TO` gives the internal `20230528`; the string template gives `05/28/2023`
- Impact on open-steamgate: none found; generated text must not depend on user formats anyway (`docs/abap-templates.md`)
- Smallest safe workaround: format dates explicitly, never through `ENVIRONMENT` or `WRITE TO`
- Upstream: undecided until an A4H probe says which of the two differs from a system
- Regression-test location: none yet
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-find-section-length — `FIND ... IN SECTION OFFSET o LENGTH l OF dobj` searches `l` instead of `dobj` in the transpiler

- Status: `open`, pinned locally by a workaround; upstream: backlog
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/transpiler` 2.13.89 (the FIND statement transpiler)
- Affected ABAP statement, runtime API or adapter: `FIND sub IN SECTION OFFSET off LENGTH len OF dobj MATCH OFFSET moff`
- Minimal ABAP reproducer:

  ```abap
  DATA lv_text TYPE string VALUE `ab{{cd`.
  DATA lv_len TYPE i.
  DATA lv_off TYPE i.
  lv_len = strlen( lv_text ).
  FIND `{{` IN SECTION OFFSET 0 LENGTH lv_len OF lv_text MATCH OFFSET lv_off.
  ASSERT sy-subrc = 0 AND lv_off = 2.
  ```

- Exact command used to run it (in this tree, prints the generated call):

  ```sh
  node --input-type=module -e "import {Transpiler} from '@abaplint/transpiler'; const src = 'REPORT zfind.\nDATA lv_text TYPE string VALUE \`ab{{cd\`.\nDATA lv_len TYPE i.\nDATA lv_off TYPE i.\nlv_len = strlen( lv_text ).\nFIND \`{{\` IN SECTION OFFSET 0 LENGTH lv_len OF lv_text MATCH OFFSET lv_off.\n'; const r = await new Transpiler({ignoreSyntaxCheck: true}).runRaw([{filename: 'zfind.prog.abap', contents: src}]); for (const o of r.objects) console.log(o.chunk.getCode().split('\n').filter(l => l.includes('statements.find')).join('\n'));"
  ```

  It prints `abap.statements.find(lv_len, {find: ..., sectionOffset: abap.IntegerFactory.get(0), offset: lv_off, length: lv_len});`: it searches `lv_len` and would write the match length into it
- Expected SAP behaviour: the search runs in `dobj` from `off` for `len` characters (ABAP keyword documentation, FIND, `IN SECTION`). Not measured on A4H
- Actual open-abap behaviour: the `LENGTH` operand becomes both the searched field and the MATCH LENGTH target; nothing is found in the text
- Impact on open-steamgate: the template engine's first tokenizer found no tags. The two other `IN SECTION` uses (`src/sadl/zcl_stg_sadl_def.clas.abap:101,105`) have no `LENGTH` and transpile correctly
- Smallest safe workaround: the `find( val = ... sub = ... off = ... )` builtin, as `zcl_osd_tpl` does
- Upstream: backlog (Lars is busy this week); needs an issue or a PR in abaplint/transpiler after the critic and a heads-up to stoker
- Regression-test location: none yet
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-fae-one-select-per-row — FOR ALL ENTRIES sends one SELECT per row of the driving table

- Status: `fixed here, pinned locally` (`oisee/transpiler` e97e82c7 on branch `local/osd-build-2026-10-01`: one SELECT per block of 50 driving rows, each row's condition in parentheses under OR; before: open, recorded)
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/transpiler` 2.13.93 and abaplint/transpiler main at dd83da9 (`packages/transpiler/src/statements/select.ts`, the `SQLForAllEntries` branch), as pinned in this tree (`oisee/transpiler` at `ddb0a993`)
- Affected ABAP statement, runtime API or adapter: `SELECT ... FOR ALL ENTRIES IN itab WHERE ...`
- Minimal ABAP reproducer: `zcl_osd_lift_r1_demo=>after` (`src/lift/`) over 50 rows
- Exact command used to run it: `npx mocha test/lift-r1.mjs` (counts `DatabaseClient.select` calls)
- Expected SAP behaviour: the database interface sends the driving table in blocks (profile parameters `rsdb/max_blocking_factor`, `rsdb/max_in_blocking_factor`), so 50 rows need not be 50 statements; how many were sent was not counted. Measured on A4H on 2026-09-30 with R1's two shapes over a standard client-independent text table with a three-field key, 42 driving rows, 20 repetitions: the same rows (a miss keeps the prefilled value, a duplicate key is filled), 17.2 ms for the SELECT SINGLE loop against 1.6 ms for FOR ALL ENTRIES. On the same system, UP TO 3 ROWS with two driving rows returned 3 rows (the limit applies to the whole result, not per driving row), the duplicate removal is over the whole selected row, and an empty driving table ignores the WHERE
- Actual open-abap behaviour: the transpiled code loops over the driving table and runs the statement once per row, appending, then (for a standard target) sorts and deletes adjacent duplicates -- with a hashed target, as in R1, the test with a key asked twice passes; 50 rows are 50 calls, as many as the SELECT SINGLE loop it replaces. The result rows are right (the differential test in `zcl_osd_lift_r1_demo.clas.testclasses.abap` passes)
- Impact on open-steamgate: a set-based rewrite (verified lift recipe R1) makes as many adapter calls as the loop it replaces (50 for 50 rows), so cost evidence for R1 cannot come from this runtime; behaviour is unaffected. Elapsed time on DuckDB, PostgreSQL or HANA is not measured; the number of calls is. How many blocks a system sends depends on its profile (`rsdb/max_blocking_factor`, `rsdb/max_in_blocking_factor`, database-specific)
- Smallest safe workaround: none needed for correctness; cost evidence for FOR ALL ENTRIES recipes waits for a blocking runtime or is measured on a system
- Upstream: abaplint/transpiler, backlog (Lars is busy this week); the change is ready as branch `fae-blocks` (5295317c, on upstream main, `npm test` green with PostgreSQL), not sent yet
- Regression-test location: `test/lift-r1.mjs` ("AFTER asks once per block of driving rows": 50 rows are 1 call; it pinned 50 before the fix); upstream `test/database.ts` ("FOR ALL ENTRIES, more driving rows than one block", 240 rows in three blocks)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-abaplint-key-include-dropped — abaplint reports a key without the key includes it cannot resolve

- Status: `open` (worked around in `tools/lift.mjs`; upstream: needs an issue)
- Discovery date: `2026-09-30`
- Affected versions: `@abaplint/core` 2.120.55 (`build/src/objects/table.js`, `listKeys` and `parseType`)
- Affected ABAP statement, runtime API or adapter: none at run time; the DDIC resolution a tool reads a table's primary key from (`Table.listKeys(reg)`, `Table.parseType(reg)`)
- Minimal ABAP reproducer: a transparent table whose DD03P has key fields `KIND`, `CODE` and a key `.INCLUDE` of `CI_LIFT_MISSING`, which is not in the registry
- Exact command used to run it: `npx mocha test/lift-r1.mjs` ("R1 refuses a key include the DDIC given does not hold, even a CI_ one abaplint skips")
- Expected SAP behaviour: every field of a key include is a key field, a suffixed include (`.INCLU-<suffix>`) included; a table whose include cannot be activated is not active, so its key is not known
- Actual open-abap behaviour: `listKeys` expands only a field named exactly `.INCLUDE`, and only when the include resolves to a structure; an unresolved `.INCLUDE` is left out without a message (a suffixed `.INCLU-xxx` key include is kept as a literal name, which then never resolves). `parseType` skips a missing `CI_`/`SI_` include and returns an unknown type for any other missing include, so only the `CI_`/`SI_` case reaches a caller as a complete-looking key that is a strict prefix of the real one
- Impact on open-steamgate: verified lift R1 took the key from abaplint and certified a partial key as the full primary key, so the generated hashed lookup could lose rows (critic r1d on #271)
- Smallest safe workaround: `tools/lift.mjs` walks the DD03P key fields itself, requires every key include to be a table in the DDIC given (recursively; a view or a suffixed include is refused by name) and refuses when the field list differs from `listKeys`
- Upstream: abaplint/abaplint, needs an issue (Lars is busy: backlog)
- Regression-test location: `test/lift-r1.mjs` (the test above; its CI_ case fails against the provider without the check)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-fae-up-to-per-row — FOR ALL ENTRIES with UP TO n limits each driving row, not the result

- Status: `fixed here, pinned locally` (`oisee/transpiler` e97e82c7: UP TO is taken out of the per-block statements and applied after the duplicate removal; before: open, fix delegated to the transpiler pin owner)
- Discovery date: `2026-09-30`
- Affected versions: abaplint/transpiler as pinned here (`oisee/transpiler` at `ddb0a993`, `packages/transpiler/src/statements/select.ts`, the `SQLForAllEntries` branch)
- Affected ABAP statement, runtime API or adapter: `SELECT ... UP TO n ROWS FOR ALL ENTRIES IN itab WHERE ...`
- Minimal ABAP reproducer: `SELECT * FROM zosd_lift_txt INTO TABLE lt UP TO 3 ROWS FOR ALL ENTRIES IN it_keys WHERE kind = it_keys-kind.` with two driving rows (`STAT`, `OTH`) and four table rows for each
- Exact command used to run it: a throwaway class with that statement in `src/lift/`, `npm run transpile`, then the method called from Node with `DatabaseClient.select` counted (not committed; the same measurement as the R1 cost test in `test/lift-r1.mjs`)
- Expected SAP behaviour: the limit applies to the whole result. Measured on A4H on 2026-09-30 over a standard text table with two driving rows and `UP TO 3 ROWS`: 3 rows
- Actual open-abap behaviour: 6 rows in 2 statements. The transpiled code puts `UP TO n ROWS` into the statement it runs once per driving row, so each row gets its own n; the duplicate removal after the loop does not cut the result back. Duplicate removal over the whole selected row and an empty driving table (whole WHERE ignored) match A4H
- Impact on open-steamgate: a program that reads a sample with FOR ALL ENTRIES and UP TO gets up to n times the number of driving rows here; verified-lift evidence for such a shape would differ from the system
- Smallest safe workaround: none needed with the pin above
- Upstream: abaplint/transpiler, backlog, in the same branch `fae-blocks` as the blocking change
- Regression-test location: upstream `test/database.ts` ("FOR ALL ENTRIES, UP TO counts the whole result, not each driving row": 3 rows; 6 without the fix)
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-unit-statics-across-test-classes — Node ABAP Unit keeps class statics from one test class to the next

- Status: `open` for Node; Go fixed on `feat/gogen-unit-statics-per-class` (this commit)
- Discovery date: `2026-09-30`
- Affected versions: the Node runner (the transpiler's generated unit runner in `output/index.mjs`, run by `npm run unit`, pin `oisee/transpiler` e97e82c7) and the Go runner (`tools/gogen/unit.mjs`) before this commit
- Affected ABAP statement, runtime API or adapter: ABAP Unit test isolation, i.e. `CLASS-DATA` and the class constructor of a class under test across test classes
- Minimal ABAP reproducer: `test/fixtures/unit-statics/` (`ZCL_OSD_STATICS_TEST`: a counter in CLASS-DATA and a class constructor that counts its runs; two test classes `LTC_A` and `LTC_B`, each with `M1_FIRST`, which expects the counter at 1 and one construction, and `M2_SECOND`, which expects the counter at 2)
- Exact command used to run it:
  - Go: `node tools/gogen/unit.mjs --fixture test/fixtures/unit-statics --class ZCL_OSD_STATICS_TEST`.
  - Node: copy the two files into `test/unit/` and run `npm run unit`. The plain runner stops at the first failed assertion (`ANOMALY-2026-09-30-unit-exception-aborts-run`); `tools/gogen/node-unit-results.mjs` runs each method on its own and gives the whole row. The fixture is kept out of the suite so that `npm test` stays green until the runners are fixed.
- Expected SAP behaviour: measured on A4H by foreman-dell, 2026-09-30, with a probe of the same shape (two local test classes, CLASS-DATA plus a class constructor holding a timestamp and a counter). Each test class runs in a fresh internal session: the class constructor runs again and the statics start over, while the methods of one test class share them. So both `M1_FIRST` see 1 and both `M2_SECOND` see 2.
- Actual open-abap behaviour:

  | | `LTC_A` m1 / m2 | `LTC_B` m1 / m2 |
  |---|---|---|
  | A4H | 1 / 2 | 1 / 2 |
  | Node | 1 / 2 | **3** (`Expected '1', got '3'`, and the plain runner stops there) |
  | Go before fix | 1 / 2 | **3 / 4** |
  | Go after fix | 1 / 2 | 1 / 2 |

  Before the Go fix, the class constructor ran once per process and the statics carried on across test classes. On Node the constructor runs at module import. Go now resets generated class statics (including VALUE initializers) and constructor flags before each test class. Its runtime also clears global event registrations and gives each class a fresh `abap.Session`. Database state is outside this reset; U4 step 2 handles database copies. EXPORT/IMPORT TO MEMORY ID and SET/GET PARAMETER have no Go runtime store yet.
- Impact on open-steamgate: Node test classes can pass or fail depending on which test class ran before them. The parity harness identifies the fixture's reviewed Node failures as `nodeAnomaly` when Go agrees with A4H. Parallel class execution still needs U4's session and database isolation.
- Smallest safe workaround on Node: reset the statics a class under test keeps in `setup`/`class_setup`, or read them relative to their value at the start.
- Also found: the Go generator refuses to read another class's public static attribute in an expression (`zcl_x=>gv_attr`) and reports it NOT_COMPILED. That is a gap in the generator, not a difference from SAP, so it lives in `docs/backlog/gogen-osgo.md`. The fixture reads the attribute through a method so the two findings stay apart.
- Upstream: the Node runner is the transpiler's generated unit runner, so abaplint/transpiler needs an issue (per test class: re-initialise the statics and re-run the class constructor). The Go runner is ours (foreman-dell).
- Regression-test location: `test/fixtures/unit-statics/` and `tools/gogen/unit.test.mjs`; the fixture moves to `test/unit/` when Node also passes it
- Upstream version containing a Node fix: none yet

### ANOMALY-2026-09-30-fae-leftovers — four FOR ALL ENTRIES shapes the transpiled code gets wrong, older than the blocking change

- Status: `open` (recorded; upstream: needs an issue, none sent)
- Discovery date: `2026-09-30`
- Affected versions: abaplint/transpiler main as of 2026-09-30 and the pin here (`oisee/transpiler` e97e82c7); all four behave the same before and after the blocking change of ANOMALY-2026-09-30-fae-one-select-per-row (a critic ran each on both builds)
- Affected ABAP statement, runtime API or adapter: `SELECT ... FOR ALL ENTRIES IN itab WHERE ...` (`packages/transpiler/src/statements/select.ts`, the `SQLForAllEntries` branch)
- Minimal ABAP reproducer: over a table of eight rows, with a non-empty driving table:
  1. `APPENDING TABLE lt` into a table that already holds rows: the rows already there are gone (the branch clears the target before the first SELECT)
  2. `ORDER BY id DESCENDING` with `UP TO 2 ROWS`: the rows come back in ascending order, because the duplicate removal sorts by every field after the last SELECT
  3. a dynamic condition, `WHERE (lv_where)` naming a component of the driving table: the SQL names the driving table as a column ("no such column")
  4. a condition with `IN` a range table of the driving row: no rows
- Exact command used to run it: the critic's throwaway programs run through the transpiler's own test harness (`test/_utils.js` `runFiles`, SQLite); not committed
- Expected SAP behaviour: not measured on a system. What SAP documents: APPENDING keeps the target's rows; with FOR ALL ENTRIES only ORDER BY PRIMARY KEY is allowed, so case 2 is a syntax question as much as a runtime one; a dynamic condition and IN are allowed
- Actual open-abap behaviour: as listed above
- Impact on open-steamgate: none found in the tree (no FOR ALL ENTRIES here uses these shapes); a real program that does would read wrong rows
- Smallest safe workaround: avoid the four shapes; for APPENDING, select into a second table and append it
- Upstream: abaplint/transpiler, needs an issue (one issue for the four, after a probe on A4H for cases 1, 3 and 4)
- Regression-test location: none yet
- Upstream version containing a fix: none yet

### ANOMALY-2026-09-30-go-row-binding-model — scalar row bindings use a table version token

- Status: `open` (U4 table-header follow-up)
- Discovery date: `2026-09-30`
- Affected versions: this branch's Go and JavaScript row-binding runtimes
- Affected ABAP statement, runtime API or adapter: `LOOP AT`, `READ TABLE`, and `APPEND ... ASSIGNING` on standard tables with scalar rows
- Binding model: each Go scalar field symbol holds its own row pointer, table identity, index, and version captured at bind time. Each read or write validates that token; rebinding the same slice slot cannot renew an older symbol. JavaScript captures the array, index, and version in the binding. Structural changes invalidate retained bindings. Generic row bindings carry an equivalent validity check.
- Known limits: scalar Go tables remain value slices. A structural change can conservatively reject a binding even when its row survived. `LOOP ... ASSIGNING` followed by `APPEND` in the body and a use of the field symbol after the loop has not been measured on SAP; the current version rule raises `GETWA_NOT_ASSIGNED` on that use. No SAP compatibility claim is made for that case.
- Planned fix: U4's 0.5 table-header representation will put the version on the table itself and replace the present side-table model.
- Regression-test location: `tools/gogen/testdata/zcl_gogen_t_rebind.clas.abap`, `zcl_gogen_t_initbind.clas.abap`, and `tools/gogen/go/abap/row_binding_bench_test.go`

### ANOMALY-2026-10-01-fae-sorts-result — FOR ALL ENTRIES sorts results while removing duplicates

- Status: `recorded`; R2 keeps an explicit sort in its template
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/transpiler` 2.13.93, as pinned in this tree
- Affected ABAP statement, runtime API or adapter: `SELECT ... FOR ALL ENTRIES IN itab` into a standard internal table
- Minimal ABAP reproducer: `zcl_osd_lift_r2_demo=>after` (`src/lift/`), which reads with FAE and then sorts by correlation keys and the DDIC primary key
- Exact command used to inspect it: `npm run transpile`; inspect `output/zcl_osd_lift_r2_demo.clas.mjs` around the generated FAE call
- Expected SAP behaviour: FOR ALL ENTRIES does not itself sort the result; without an explicit `SORT` or `ORDER BY`, row order is not guaranteed. This order behavior was not measured on A4H
- Actual open-abap behaviour: the transpiled FAE path sorts a standard target by every line component before `DELETE ADJACENT DUPLICATES` with `allFields: true`. That makes a differential test pass even if the recipe's explicit sort is removed
- Impact on open-steamgate: the R2 reconstruction depends on rows being grouped by correlation key and ordered by the source table's primary key. The runtime's all-component sort cannot serve as evidence that the template sort is redundant on SAP
- Smallest safe workaround: retain `SORT lt_all BY` correlation keys followed by primary-key fields; this is required on a real system to reconstruct each SELECT result in its original order
- Upstream: not raised
- Regression-test location: `test/lift-r2.mjs` asserts the rendered sort line and its column order
- Upstream version containing a fix: none; the order difference is recorded, not fixed

### ANOMALY-2026-10-01-select-having-dropped — transpiler omits HAVING from SELECT

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected statement: any ABAP `SELECT` with `HAVING`; the measured reproducer uses ABAP 7.02 `SELECT ... COUNT( * ) AS cnt ... INNER JOIN ... GROUP BY ... HAVING COUNT( * ) > 2 INTO CORRESPONDING FIELDS OF TABLE`.
- Minimal reproducer: `docs/probes/dsl-l2/zcl_l2_count_probe.clas.abap` and its test include.
- Exact command: with the probe temporarily in `src/l2demo/`, `flock /tmp/osd-heavy.lock npm run transpile` then `flock /tmp/osd-heavy.lock node tools/osd-unit-run.mjs`.
- Expected: one row (`P001:3`); actual: two rows. The transpiled `output/zcl_l2_count_probe.clas.mjs` SELECT contains `GROUP BY` and `COUNT( * ) AS cnt`, but no `HAVING`. Inspection of `node_modules/@abaplint/transpiler/build` in 2.13.93 (`grep -ri having`) finds no HAVING support, so this applies to any SELECT using HAVING.
- Impact: a DSL count check lowered with HAVING would alert below its threshold. The L2 compiler instead reads matching JOIN rows with one query and counts them in a 7.02 ABAP loop.
- Upstream: needs an issue: HAVING unsupported in abaplint/transpiler.
- Regression: generated L2 count demo and its reference comparison in `test/dsl-l2.mjs`.

### ANOMALY-2026-10-01-collect-does-not-sum — COLLECT never sums: a standard table gains a row, a sorted one keeps its row

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/runtime` 2.13.93, as pinned in this tree; `packages/runtime/src/statements/collect.ts` on transpiler `main` reads the same on 2026-10-01
- Affected ABAP statement, runtime API or adapter: `COLLECT wa INTO itab`
- Minimal ABAP reproducer: `docs/probes/dsl-l2/zcl_l2_outer_probe.clas.abap`, methods `collect_sorted` and `collect_standard`, and their test include: a line `P001` with `cnt = 1` collected twice
- Exact command used to run it: with the probe copied into `src/l2demo/`, `flock /tmp/osd-heavy.lock npm run transpile` then `flock /tmp/osd-heavy.lock node tools/osd-unit-run.mjs` runs its test class; on 2026-10-01 it was transpiled alone with the three fleet tables, the way `loadRule` in `test/dsl-l2.mjs` transpiles a rule, and its methods called
- Expected SAP behaviour: COLLECT looks for a line with the same key (the non-numeric components for a standard table with default key, the table key otherwise) and adds the numeric components into it; the probe expects `P001:2` (ABAP keyword documentation, `COLLECT`). **Not measured on A4H**: ABAP Unit runs there currently return no test classes at all, so the probe could not be run on the system
- Actual open-abap behaviour: `collect` reads the target for a line equal to the work area **as a whole** (`eq(table_line, source)`, every component, the numeric ones included) and calls `insertInternal` when there is none; it never adds. What follows depends on the table kind. A standard table takes the line as a new row: collecting `(P001, 1)` twice leaves one row `(P001, 1)` (the second is equal as a whole and is skipped), and collecting `(P001, 2)` after it adds a second row `(P001, 2)`. A sorted table with a unique key refuses the insert of a duplicate key (`insertSorted` with `isUnique`, `sy-subrc` 4), so it keeps its row `(P001, 1)` unchanged. A hashed table goes through its own unique insert and, by the code, also keeps the first row (not measured). The probe answers `P001:1` for both measured kinds
- Impact on open-steamgate: the first lowering of the slice-5 zero-count check counted the joined rows with COLLECT into a sorted table and alerted on every ship with two or more crew; `check_reference` caught it in every derived case with a count above 1
- Smallest safe workaround: both the one-query equality-only LEFT OUTER JOIN form and the two-query form count with `READ TABLE ... WITH TABLE KEY`, then `ADD 1` and `MODIFY TABLE`, or `INSERT ... INTO TABLE` for a new key; no COLLECT in generated code. The one-query form skips the missing counted side before incrementing
- Upstream: needs an issue: COLLECT does not sum in abaplint/transpiler's runtime
- Regression-test location: `test/dsl-l2.mjs`, "slice 5", every derived case with a count of two or more (`b_count_at`, `b_count_groups`, `b_count_next_zero`) compared with `check_reference`
- Upstream version containing a fix: unknown

### ANOMALY-2026-10-01-outer-join-702-restrictions-unchecked — abaplint accepts in v702 a non-equality in a LEFT OUTER JOIN's ON and a right-table column in WHERE

- Status: `open`
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/core` as pinned here (syntax versions `v702` and `open-abap`); `@abaplint/transpiler` 2.13.93 and `@abaplint/database-sqlite`
- Affected ABAP statement, runtime API or adapter: `SELECT ... FROM a LEFT OUTER JOIN b ON b~x = a~x AND b~col > host` (an operator other than `=` in the ON of an outer join) and `SELECT ... LEFT OUTER JOIN b ... WHERE b~col ...` (a column of the right table in WHERE)
- Minimal ABAP reproducer: `docs/probes/dsl-l2/zcl_l2_outer_probe.clas.abap`, methods `outer_on_greater` and `outer_where_right`; `outer_on_literal` (`AND crew~role = 'C'` in ON) is the legal control
- Exact command used to run it: an abaplint registry over the probe with `parser_error` and `check_syntax` for versions `v702` and `open-abap` reports nothing for any of the three; transpiled and run, they answer what standard SQL answers (a row per for row, the outer side initial where nothing matched; the WHERE on the right table drops those rows)
- Expected SAP behaviour: in the Open SQL of these releases the ON condition of a LEFT OUTER JOIN takes `=` comparisons only, joined by AND, and a column of the right table may not appear in WHERE. An equality with a literal is allowed in ON: SAP's own example has `p~cityfrom = 'FRANKFURT'` there (SAP Help, "Specifying Two or More Database Tables as an Outer Join", https://help.sap.com/saphelp_autoid2007/helpdata/en/fc/eb39c4358411d1829f0000e829fbfe/content.htm?no_cache=true). So `outer_on_literal` is legal and the other two are syntax errors. The later releases lift the restrictions in strict mode only, which needs `@` host variables and the `INTO` clause last. **Not measured on a 7.02 system** (there is none here; A4H is a later release, and its ABAP Unit runs currently return no test classes)
- Actual open-abap behaviour: all three forms pass the syntax check and run, with standard SQL semantics; the outer side of a missing match comes back as the initial value (`''`, `00000000`), which is what a system does with a null
- Impact on open-steamgate: a generator that emitted a non-equality into an outer join's ON, or a right-table column into its WHERE, would be green here and a syntax error on a 7.02 system. DSL L2 `fewer_than` and `exactly` use one LEFT OUTER JOIN only for a pure conjunction of equalities to outer fields or literals, with all counted conditions in ON and only `when` in WHERE. A non-equality, parameter equality, `or`, or `not` keeps two queries (docs/dsl-l2.md, "Slice 5")
- Smallest safe workaround: the compiler selects the one-query form only for 7.02-legal equalities; all other zero-count forms retain two queries. The joined counted table's client key is checked for initial in the counting loop; SAP's implicit current-client handling makes a real row's client noninitial. This runtime lacks implicit client filtering, so manually inserted initial-client rows are outside that guarantee
- Upstream: needs an issue: abaplint's v702 syntax check does not apply the LEFT OUTER JOIN restrictions
- Regression-test location: none; the probe documents the measurement
- Upstream version containing a fix: unknown

### ANOMALY-2026-10-01-transpiler-int8-column — the transpiler's database setup has no column type for INT8

- Status: `open`
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/transpiler` 2.13.93 (the schema generators for SQLite, PostgreSQL and Snowflake)
- Affected ABAP statement, runtime API or adapter: the `CREATE TABLE` the transpiler writes for a transparent table (`output.databaseSetup.schemas`) when a field is DDIC type INT8 (abaplint `Integer8Type`), whether declared by DATATYPE or by a data element
- Minimal ABAP reproducer: `test/fixtures/dsl-l2-pack/zosd_l2_pkship.tabl.xml` (field `ODO`, DATATYPE INT8, LENG 19) in a transpiler registry
- Exact command used to run it: `test/dsl-l2.mjs`'s `runRule` over that table with `fixture: true`; the transpile throws `database_setup: ZOSD_L2_PKSHIP-ODO, todo toType handle: Integer8Type`. `toType` in `src/db/schema_generation/sqlite_database_schema.ts` (and the pg and snowflake ones) handles `IntegerType` and has no branch for `Integer8Type`
- Expected SAP behaviour: a transparent table may have an INT8 field; the database column is an 8-byte integer
- Actual open-abap behaviour: the whole transpile fails on the table, so no table with an INT8 field can be created or read here
- Impact on open-steamgate: a table with an INT8 field cannot be part of the tree. The DSL L2 compiler types such a field (INT8 by DATATYPE resolves since this date) and fills it in derived rows, but its generated tests cannot be run over that table here
- Smallest safe workaround: none in the runtime. `test/dsl-l2.mjs` runs the generated tests of the pack fixture over a copy of the table without its INT8 field and checks INT8 at compile time only
- Upstream: needs an issue: abaplint/transpiler database setup lacks a column type for Integer8Type (SQLite `INTEGER`, PostgreSQL `BIGINT`)
- Regression-test location: `test/dsl-l2.mjs`, "a rule in a pack: built-in typed fields and a stable rule path"
- Upstream version containing a fix: unknown

### ANOMALY-2026-10-01-lenient-abapgit-xml — the toolchain reads malformed abapGit XML that abapGit on a system refuses

- Status: `fixed here` (both files) and guarded (`test/xml-wellformed.mjs`)
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/core` 2.120.x and `@abaplint/transpiler` 2.13.93 as used by `npm run transpile`, and this runtime's DDIC readers
- Affected ABAP statement, runtime API or adapter: reading an object's `*.xml` (abapGit serialisation): `src/l2demo/zosd_l2_cargo.tabl.xml` had no closing `</abapGit>`, and `src/jobs/btch0000.tabl.xml` closed `</asx:abap>` without closing `</asx:values>`
- Minimal ABAP reproducer: either file as it was before this entry (`git show 768eed0c:src/l2demo/zosd_l2_cargo.tabl.xml`)
- Exact command used to run it: `npm run transpile` and every suite passed with both files; on A4H, `zcl_abapgit_repo->deserialize` of an offline repository holding the first file raised `ZCX_ABAPGIT_EXCEPTION: XML parser error: unexpected symbol ... Line 1 Col. 1 File zosd_l2_cargo.tabl.xml` (measured with `NEW zcl_abapgit_xml_input( )` per file: the other 15 XML files of the package parsed)
- Expected SAP behaviour: abapGit parses each file with iXML and refuses the object when it is not well-formed, so the import stops
- Actual open-abap behaviour: the readers here take the elements they need and ignore a missing closing tag, so the table builds, is served and is tested
- Impact on open-steamgate: an object that passes everything here fails to install on a system; found only by importing the package on A4H
- Smallest safe workaround: none needed in the runtime; `test/xml-wellformed.mjs` validates every tracked `*.xml` strictly (`fast-xml-parser` `XMLValidator`, already a dependency), shown failing on both files before the fix
- Upstream: none yet; whether abaplint should report a malformed object file is a question for an issue, not filed
- Regression-test location: `test/xml-wellformed.mjs`
- Upstream version containing a fix: n/a

### ANOMALY-2026-10-01-test-classes-without-with-unit-tests — local test classes run here whether or not the class says it has them

- Status: `fixed here` (23 shipped classes and the L2 generator) and guarded (`test/xml-wellformed.mjs`)
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/transpiler` 2.13.93 and this runtime's ABAP Unit runner
- Affected ABAP statement, runtime API or adapter: a class's `*.clas.testclasses.abap` next to a `*.clas.xml` whose `VSEOCLASS` has no `<WITH_UNIT_TESTS>X</WITH_UNIT_TESTS>`
- Minimal ABAP reproducer: any L2 rule class before this entry, e.g. `src/l2demo/zcl_l2_ship_captain.clas.xml` at `f1357c95`
- Exact command used to run it: here `npm run unit` runs its test methods. On A4H, after an abapGit offline import of `src/l2demo` (status S, 13 objects), `SEOCLASSDF-WITH_UNIT_TESTS` was blank for all eight rule classes, `READ REPORT` of each class's CCAU include returned 0 lines, and the ADT ABAP Unit run (dangerous tests included) returned no test classes
- Expected SAP behaviour: abapGit deserialises the test include only for a class flagged WITH_UNIT_TESTS; an unflagged class arrives without its tests
- Actual open-abap behaviour: the transpiler reads the `.testclasses.abap` file whatever the flag says, so the tests pass here and do not exist there
- Impact on open-steamgate: a class shipped to a system lost its tests silently, so "proved by the same test on OSG and on a system" was not true for the system side. Five shipped classes with test classes have no `clas.xml` at all (two lift demos, two regression classes, `ZCL_OSD_TPL`) and cannot be imported by abapGit; not addressed here
- Smallest safe workaround: the flag in every shipped `clas.xml` with test classes and in `tools/dsl-l2.mjs`'s template; `test/xml-wellformed.mjs` fails on a shipped class with test classes and without the flag
- Upstream: none yet; abaplint could warn about a `.testclasses.abap` file whose class XML lacks the flag. Not filed
- Regression-test location: `test/xml-wellformed.mjs`
- Upstream version containing a fix: n/a

### ANOMALY-2026-10-01-submit-with-selection — called report selection values diverge from A4H

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected adapter: generated one-shot report registry and the open-abap-gui selection host used by `SUBMIT ... WITH`
- Expected A4H behaviour (stoker background job, throwaways deleted): a PARAMETER without DEFAULT starts initial; DEFAULT, including a field such as `sy-datum`, is used; character defaults are truncated to the declared length and upper-cased unless LOWER CASE, including string parameters; a radio group selects its first button unless another declares DEFAULT 'X'; SELECT-OPTIONS DEFAULT produces one `I EQ` row, or `I BT` with DEFAULT ... TO ..., respecting OPTION and SIGN, in both table and header line. Any WITH for a select-option replaces default rows; repeated WITH clauses append in order. `WITH p = ''` clears a parameter default, numeric text converts to the parameter type, and a parameter without LOWER CASE is upper-cased. LOW and HIGH of only the first row of a select-option without LOWER CASE are upper-cased, regardless of option or source (scalar or IN table); later rows preserve case. A4H measured `WITH s_a BETWEEN 'a' AND 'c'` as the only row (C10, no LOWER CASE) yielding `I BT A C`. `SUBMIT ... AND RETURN` leaves the caller's `sy-subrc` untouched. An invalid numeric WITH value terminates with uncaught `CONVT_NO_NUMBER`.
- Actual before fix: the generated registry rejects repeated input names, while the selection host's defaults and input conversion do not consistently apply the A4H rules above. The registry calls the host with raw string values and ranges, so the called declaration is not used to normalize input before report execution.
- Impact: reports can observe missing or extra default rows, incorrect case and type conversion, or rejection of valid repeated WITH clauses.
- Smallest safe workaround: `zcl_osd_submit_semantics` converts defaults and supplied input using the called report's declarations, and the one-shot registry merges repeated select-option rows before the selection host runs. The transpiler's `ty_values` is a sorted table with unique names, so the lowering combines repeated clauses before passing them to the registry.
- Upstream: not raised; the compatibility layer is local to this report host.
- Regression-test location: `test/unit/zcl_osd_batch_runner_test.clas.testclasses.abap`, `test/submit-semantics.mjs`, and `test/narrow-submit.mjs`.

### ANOMALY-2026-10-01-cleanup-ignored — the transpiler drops the CLEANUP block of a TRY

- Status: `workaround`
- Discovery date: `2026-10-01`
- Affected versions: `@abaplint/transpiler e34d6a1` (the generated JS carries the comment `Transpiler todo: CLEANUP ignored`)
- Affected ABAP statement, runtime API or adapter: `TRY. ... CLEANUP. ... ENDTRY.`
- Minimal ABAP reproducer: the L3 runner's replay in `recipes/l3-set/template.tpl` before the workaround; `test/dsl-l3.mjs`, "a rule that raises in the middle of a replay"
- Exact command used to run it: `npx mocha test/dsl-l3.mjs -g "raises in the middle"`
- Expected SAP behaviour: the CLEANUP block runs when an exception leaves the TRY uncaught, then the exception goes on
- Actual open-abap behaviour: the block is dropped, nothing runs
- Impact on open-steamgate: a replay's table restore would be skipped by an exception that escapes
- Smallest safe workaround: `CATCH cx_root INTO lx. restore. RAISE EXCEPTION lx.` in the generated runner (same effect for class-based exceptions; a runtime error that is not a class exception is not caught on a system either way)
- Upstream issue: none yet
- Regression-test location: `test/dsl-l3.mjs`, "a rule that raises in the middle of a replay" and its no-restore mutant
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-01-periodic-jobs-queue — overlapping instances of a periodic job queue instead of running side by side

- Status: `open` (known difference until the multi-work-process dispatcher, 0.6)
- Discovery date: `2026-10-01`
- Affected adapter: `tools/osd-job-scheduler.mjs` and the one work process of `tools/osd-dialog-step.mjs`
- Expected SAP behaviour (sandbox, 2026-10-01, throwaways deleted): a periodic job with `PRDMINS = 1` whose instances run 150 s has two or three instances `R` at once; none is skipped; the number is bounded only by free background work processes, and a due instance waits for one.
- Actual local behaviour: this runtime has one work process (the FIFO lock every dialog step takes), so a due instance waits until the running one ends, and a chain that overruns its period falls further behind with every instance. No instance is skipped, each successor is still due at its predecessor's scheduled time plus the period, and the successor is made when the instance is released, which is when the sandbox would start it with a work process free.
- Impact: a periodic job that overruns finishes its instances later than on a system, and a second job due meanwhile waits too. Which instances run, and the start times they were scheduled for, are the same.
- Smallest safe workaround: none needed for correctness; keep periodic reports shorter than their period. The fixture `no-skip-on-overrun` gates "no instance skipped" and the successor timing, not concurrency.
- Upstream: none; a local runtime difference, lifted by the OSGo dispatcher's several work processes (docs/backlog/gogen-osgo.md, 0.6).
- Regression-test location: `test/job-periodic.mjs` (`no-skip-on-overrun`), fixture `test/fixtures/jobs-periodic/contract.json`.

### ANOMALY-2026-10-01-job-start-tick — a due job starts when the scheduler looks, not at the system's minute tick

- Status: `open` (known difference, by choice)
- Discovery date: `2026-10-01`
- Affected adapter: `tools/osd-job-scheduler.mjs`
- Expected SAP behaviour (sandbox, 2026-10-01): a due job starts at the next run of the background scheduler, which on the sandbox ran at hh:mm:51 every minute, or at once when a background work process frees up for a job already due.
- Actual local behaviour: the scheduler arms a timer for the earliest start time and starts a due job when it fires, or at the worker's next poll (250 ms), so a job usually starts at its time to the second. No tick is emulated.
- Impact: `STRTDATE`/`STRTTIME` of an instance can be up to a minute earlier than on a system. The scheduled times, the chain and the successor times do not depend on it: a successor is the scheduled time plus the period, never the actual start plus the period.
- Smallest safe workaround: do not assert an instance's actual start second against a system's; compare scheduled times (`SDLSTRTDT`/`SDLSTRTTM`).
- Upstream: none; a local runtime choice.
- Regression-test location: `test/job-periodic.mjs` (`successor-at-start` starts the instance 50 s late, as the sandbox's tick did, and checks the successor is still due at scheduled time + period).

### ANOMALY-2026-10-02-update-task-synchronous — IN UPDATE TASK runs at the call, so there is no update window

- Status: `open` (known difference; backlog: an asynchronous update task, 0.6 should)
- Discovery date: `2026-10-02`
- Affected versions: `@abaplint/transpiler-cli 2.13.89`, `@abaplint/runtime 2.13.89`
- Affected ABAP statement: `CALL FUNCTION ... IN UPDATE TASK`, `COMMIT WORK`, `COMMIT WORK AND WAIT`
- Minimal reproducer: the `update-window-*` cases of `test/fixtures/enq/contract.json` (measured on the sandbox,
  docs/enq-contract.md)
- Exact command used to run it: `npx mocha test/osd-enq-abap.mjs`
- Expected SAP behaviour: an update module called `IN UPDATE TASK` is queued and runs after `COMMIT WORK` (V1),
  so between the COMMIT and the end of the update the committed `_SCOPE 2` locks belong to the update task: the
  session itself gets FOREIGN_LOCK (MC 601) on the same key, and DEQUEUE_ALL, ROLLBACK and the end of the session
  leave those locks to the update.
- Actual open-abap behaviour: the transpiler emits a plain call, so the module runs when it is called and
  `COMMIT WORK` finds it done. The lock server (`tools/osd-enq-host.mjs`) marks the LUW as updated when an update
  module (UPDATE_TASK in its `*.fugr.xml`) runs and releases the update owner's locks at the COMMIT: there is no
  window, so the 601 of that window never happens locally. A direct call of an update module (not IN UPDATE
  TASK) marks the LUW too.
- Impact on open-steamgate: code that relies on the update task's lock window (or on an update running after the
  COMMIT, in another LUW) behaves differently; the lock cores (Go `tools/gogen/go/enq`, Node `tools/osd-enq.mjs`)
  do model the window and pass those cases.
- Smallest safe workaround: none needed for ordinary lock use; do not assert the window's 601 against the runtime.
- Upstream issue: not reported yet -- the runtime has no update task to report against; the fix is a feature
  (the transpiler marking `IN UPDATE TASK` calls, or a runtime hook), tracked in docs/backlog/gogen-osgo.md.
- Regression-test location: `test/osd-enq-abap.mjs` (the 4 `update-window-*` cases are skipped by name, with
  this reason in their title)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-jobcount-unique-per-name — JOBCOUNT is hhmmss plus two base-36 digits per name

- Status: `fixed` (in this repository's JOB_* facade; no upstream involved)
- Discovery date: `2026-10-02`
- Affected versions: `tools/osd-job-port.mjs` and `tools/osd-job-scheduler.mjs` before this change
- Affected ABAP statement, runtime API or adapter: `JOB_OPEN` (`JOBCOUNT`), the periodic successor's count
- Minimal reproducer: `JOB_OPEN` 103 times for one name inside one second; then probe deletion of a middle and a top suffix
- Exact command used to run it: `npx mocha test/job-count.mjs`; measured on the sandbox on 2026-10-02
- Expected SAP behaviour: `JOBCOUNT` = creation time `hhmmss` in system time + two base-36 digits (0-9 then A-Z), counted per (job name, second): the same name three times in 03:47:32 gives 03473200, 03473201, 03473202; two other names in that second give 03473200 each; the first name again gives 03473203; six jobs of different names in one second all share 03440000. In 103 opens of one name in one second, the suffixes were 00 ... 09, 0A, ... , 2P (#98), 2Q (#99), 2R (#100), 2S, 2T, 2U, with no refusal. The suffix is max+1 over the existing rows: open 00, 01, 02, delete 01, next open 03; open 00, 01, 02, delete 02, next open 02 again. (Jobname, jobcount) is the key; the count alone collides. Past ZZ is not measured.
- Actual open-abap behaviour: a random eight-digit number, retried until no name had it; so no two jobs ever shared a count, and code that identifies a job by its count alone worked here and not on a system
- Impact on open-steamgate: count-only lookups were invisible locally; a program that sorts or parses JOBCOUNT saw numbers a system never makes. Found by the L3 proof (`stages_mode_p`, #431): `COUNT( DISTINCT job_count )` over six stage 2 piles was 6 here and 1 on the sandbox (`L3_FLEET2_202_0001` to `207_0001` all 03440000); the proof now counts pairs
- Smallest safe workaround: none needed; `tools/osd-job-count.mjs` is the one allocator (JOB_OPEN and the periodic successor), per-name max+1 across days (the key has no date), refusal (`CANT_CREATE_JOB`) past ZZ rather than a wrap, and a job reorganisation (`tools/osd-job-reorg.mjs`, retention 14 days). Our exact clock makes a fixed-second daily chain climb by one every day while its latest instance is kept; it can reach ZZ after about 1296 days despite retention. The scheduler retries a refused successor in a new second. Counts of earlier builds stay valid and are skipped on a clash.
- Upstream issue: none; the facade is this repository's
- Regression-test location: `test/job-count.mjs` (the A4H sequences of `test/fixtures/job-count/contract.json`; mutants: decimal suffix, lowest free, refusal past 99, numeric predecessor parsing)
- Upstream version containing a fix: not applicable

### ANOMALY-2026-10-02-abap-unit-method-order — a system runs the test methods of a class alphabetically, the transpiled runner in declaration order

- Status: `workaround`
- Discovery date: `2026-10-02`
- Affected versions: every transpiled `output/index.mjs` (the runner calls `setup`, the method, `teardown` for each method in the order the class declares them)
- Affected ABAP statement, runtime API or adapter: ABAP Unit, the order of `METHODS ... FOR TESTING` within one test class
- Minimal reproducer: `ZCL_L3_FLEET_PROOF`, whose `ltcl_proof` declared `mode_s` first and `doctor_heals` ninth
- Exact command used to run it: `node tools/osd-prove-on-system.mjs .local/stage/l3demo --unit l3demo` (sandbox, 2026-10-02, slice 5a run 2 and slice 5b runs 1 and 2)
- Expected SAP behaviour: the sandbox ran `DOCTOR_HEALS` first: in 5a run 2 an exception in it was the only method of the class that ran, the nine declared before and after it did not. That is alphabetical order (`doctor_heals` sorts first). Observed through which method ran, not measured with a probe of its own; ABAP Unit documents no order
- Actual open-abap behaviour: declaration order, so locally `doctor_heals` ran after eight methods had left their state behind, and on the system it ran first, against freshly created tables
- Impact on open-steamgate: an order dependence between test methods shows on one side and not on the other. The 5b regression hunt had to rule out a settings leak from `settings_tune` into `doctor_heals` (it cannot happen on the system: `doctor_heals` runs first there)
- Smallest safe workaround: declare test methods in alphabetical order where order could matter (`ZCL_L3_FLEET_PROOF` does now, so `npm run unit` and the system agree), and the L3 harness runs the proof in the order read off the class and sorted (`test/dsl-l3.mjs`, "runs the methods in the order a system runs them"); every proof method resets the settings in `setup` and `teardown`, so its outcome does not depend on order at all
- Upstream issue: none filed; the transpiler's runner order is not documented either way, and a system's order is inferred, not measured
- Regression-test location: `test/dsl-l3.mjs` (the order test, and "a setup that does not reset the settings" mutant, which turns `stages_mode_s` red when a tuned pile size is left behind)
- Upstream version containing a fix: not applicable

### ANOMALY-2026-10-02-icf-shim-static-server — a handler resumed after WAIT sees the request served meanwhile

- Status: `worked around locally` (tools/osd-dialog-step.mjs); upstream fix not sent yet
- Discovery date: `2026-10-02` (reported by a critic reviewing ADT slice 1, reproduced on `main` at `ad99abe0`)
- Affected library: `open-abap/express-icf-shim` at `c1fc3602` (libs.lock.json), `cl_express_icf_shim`
- Affected ABAP statement: `WAIT UP TO` / `WAIT UNTIL` / `WAIT FOR ...` inside an `if_http_extension~handle_request`
- Minimal reproducer: `test/integration/zcl_osd_icf_wait_probe` (reads `~path`, WAITs one second, reads it
  again, answers it); `test/dialog-step-icf.mjs` runs request A (`?wait=X`) and request B through the shim, B
  queued behind A.
- Exact command used to run it: `npx mocha test/dialog-step-icf.mjs`
- Expected SAP behaviour: every ICF request has a server object of its own (`if_http_server` with its own
  `request` and `response`), and a WAIT rolls the session out with all of it; after the roll-in the handler reads
  its own request and writes its own response.
- Actual open-abap behaviour: `cl_express_icf_shim` keeps the server in `CLASS-DATA mi_server` and every `run`
  hangs a new `request` and `response` entity on that one object. The dialog step gives the work process up
  during a WAIT, B runs and replaces both, and A resumes on B's entities. Measured before the workaround: A's
  handler read `/sap/bc/osd_probe/second` after its WAIT, its writes went into B's (already sent) response, and
  the shim answered A's caller with B's status, headers and body; A's own header written before the WAIT was lost.
- Impact on open-steamgate: one caller can be answered with another caller's response on the Node hosts (inline
  and child), for any ICF/OData/ported-ADT handler that WAITs (or whose callee does). A conditional WAIT
  (`WAIT UNTIL`, `WAIT FOR ... UNTIL`) was asked against the other request's entities (sy-subrc 0 where 8 was due),
  and an AMC receiver the WAIT delivered to wrote into the other request's response. Without a WAIT the
  work-process lock serialises the steps and nothing interleaves. The browser preview is not affected for HTTP:
  `web/preview-backend.mjs` queues every request behind the previous one (`serialized()`), so a WAIT there gives
  the work process only to an APC event, which does not go through the shim.
- Smallest safe workaround: the WAIT's roll-out in `tools/osd-dialog-step.mjs` notes the shim's static server and
  its request and response entities on the step's token; every roll-in puts them back: after the WAIT, before
  each evaluation of a WAIT's condition (taken with the work process, released again while it stays false), and
  around an AMC receiver the WAIT delivers to (`inSession`, called by `tools/osd-amc.mjs`, which keeps what the
  receiver leaves for the next delivery and the final roll-in).
- Upstream issue: not filed yet. The fix is a local `DATA li_server` in `run`, passed to `request`/`response`
  instead of the CLASS-DATA (docs/upstream.md, item 8).
- Regression-test location: `test/dialog-step-icf.mjs` (four cases: timed, both timed, conditional, AMC
  receiver; each fails without its half of the workaround)
- Upstream version containing a fix: `none`

### ANOMALY-2026-10-02-job-delete-outbox — BP_JOB_DELETE refused a committed job still in the outbox

- Status: `fixed` (in this repository's JOB_* facade; no upstream involved)
- Discovery date: `2026-10-02` (reported by the DSL research and demo sessions)
- Affected versions: `tools/osd-job-port.mjs` and `src/jobs/zosd_jobs.fugr.bp_job_delete.abap` before this change
- Affected ABAP statement, runtime API or adapter: `BP_JOB_DELETE`
- Minimal reproducer: in one program run `JOB_OPEN`, `JOB_SUBMIT`, `JOB_CLOSE` with a start time ahead, `COMMIT WORK`, `BP_JOB_DELETE`; `test/fixtures/job-delete/contract.json`, case `commit-then-delete`
- Exact command used to run it: `npx mocha test/job-delete.mjs`
- Expected SAP behaviour (sandbox, 2026-10-02, throwaways deleted): the job is `S`, the delete answers rc 0 and TBTCO/TBTCP have no row at once; a later `ROLLBACK WORK` does not bring it back; a second delete raises `JOB_DOES_NOT_EXIST` (BT 127). The same holds before any `COMMIT WORK`, for a job waiting for a predecessor, its predecessor, and a job only opened (`P`). A job released to start at once is `Y` right after `JOB_CLOSE` and is refused with `JOB_IS_ALREADY_RUNNING` (BT 128), as is a running one; a finished one is deleted. With the default `COMMITMODE = 'X'` the delete commits the caller's LUW: a write pending before it survives a later ROLLBACK; with `COMMITMODE = space` the ROLLBACK brings the job back.
- Actual open-abap behaviour: only an imported job could be deleted; one still in the outbox or in the caller's LUW, or only opened, raised `CANT_DELETE_JOB` until a worker had drained the outbox.
- Impact on open-steamgate: an `unschedule( )` right after a `schedule( )` deleted nothing here and its job ran; on a system it is gone.
- Smallest safe workaround: none needed. The delete and an outbox drain (in this process or an independent worker) are fenced in the business database: both start by deleting the job's outbox row under SQLite's write lock, and whoever deletes it owns the job. The drain claims, imports and commits in one business transaction and imports nothing it could not claim; the delete claims the identity, outbox and step rows in the caller's LUW, then asks the operations ledger whether an earlier drain imported the job (its run is marked `DELETED`, or a queued or running one refused). The facade's `COMMIT WORK` (COMMITMODE) makes the delete durable. A ready job without a start condition is refused like a running one. `COMMITMODE = space` is not honoured (ANOMALY-2026-10-02-fm-is-supplied).
- Upstream issue: none, a local facade
- Regression-test location: `test/job-delete.mjs` (fixture cases; a drain blocked inside the delete; three races with an independent worker process; an unacknowledged import), `test/job-one-step.mjs` (claim before import), `test/job-periodic.mjs`, `test/job-count.mjs`
- Upstream version containing a fix: `n/a`

### ANOMALY-2026-10-02-fm-is-supplied — IS SUPPLIED of a function module parameter is always false, and its DEFAULT is not applied

- Status: `workaround`
- Discovery date: `2026-10-02`
- Affected versions: `@abaplint/transpiler 2.13.89` (and `main` of 2026-09-17 in `.local/lars/transpiler`, `packages/transpiler/src/expressions/compare.ts` and `structures/function_module.ts`)
- Affected ABAP statement, runtime API or adapter: `<param> IS SUPPLIED`, `<param> IS NOT SUPPLIED` and the DEFAULT of an optional parameter, inside `FUNCTION ... ENDFUNCTION`
- Minimal ABAP reproducer: `IF commitmode IS NOT SUPPLIED OR commitmode IS NOT INITIAL. COMMIT WORK. ENDIF.` in `BP_JOB_DELETE`, called with `commitmode = space`: the generated test reads `INPUT.commitmode`, while a function module's parameters arrive in `INPUT.exporting` / `INPUT.tables` / `INPUT.changing`; it commits anyway (`test/job-delete.mjs`, case `commitmode-space`, red with that line)
- Exact command used to run it: `npm run transpile && npx mocha test/job-delete.mjs`, then read `zosd_jobs.fugr.mjs` in `output/`
- Expected SAP behaviour: IS SUPPLIED is true when the caller passed the parameter; an omitted optional parameter takes its DEFAULT (`COMMITMODE` of `BP_JOB_DELETE` is `'X'` by FUPARAREF)
- Actual open-abap behaviour: the compare emits `(INPUT && INPUT.<name>)` / `(INPUT === undefined || INPUT.<name> === undefined)`, right for a method and never true / always true for a function module; the module prologue leaves an omitted parameter initial (`// todo, set DEFAULT value`)
- Impact on open-steamgate: `BP_JOB_DELETE` cannot tell an omitted COMMITMODE from a space and always commits; by the generated code, `BP_JOB_SELECT`'s `IF jobname_ext_sel IS SUPPLIED AND ...` (and the username one) never takes the extended selection (not exercised by a test here)
- Smallest safe workaround: do not use IS SUPPLIED in a function module; where the default matters, apply the documented default to an initial value
- Upstream issue: none yet, needs an issue (abaplint/transpiler)
- Regression-test location: `test/job-delete.mjs`, case `commitmode-space` (pending while this is open)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-job-open-commits — JOB_OPEN and JOB_CLOSE commit the caller's LUW on a system

- Status: `open` (known difference of the JOB_* facade)
- Discovery date: `2026-10-02` (inferred in docs/dsl-l3.md, measured here)
- Affected versions: the JOB_* facade (`src/jobs/zosd_jobs.fugr.*`)
- Affected ABAP statement, runtime API or adapter: `JOB_OPEN`, `JOB_CLOSE`
- Minimal reproducer: a sandbox probe, 2026-10-02 (throwaways deleted): INSERT into a table, `JOB_OPEN`, `ROLLBACK WORK`: the row is there and the job still exists (its BP_JOB_DELETE answers rc 0); the same with `JOB_OPEN` + `SUBMIT VIA JOB` + `JOB_CLOSE`: the row is there and the job is `S` with its step in TBTCP
- Exact command used to run it: by hand on the sandbox
- Expected SAP behaviour: the job exists from JOB_OPEN on, whatever the caller does with its LUW, and the caller's pending writes are committed with it
- Actual open-abap behaviour: the job's rows are written in the caller's LUW; a ROLLBACK removes the job, and the caller's other writes stay pending
- Impact on open-steamgate: a program that rolls back after scheduling keeps its job on a system and loses it here; the window docs/dsl-l3.md describes (plan rows visible from the first JOB_OPEN on) never opens here
- Smallest safe workaround: commit before scheduling when the difference matters
- Upstream issue: none, a local facade
- Regression-test location: none yet (`test/fixtures/job-delete/contract.json` records the observation)
- Upstream version containing a fix: `n/a`

### ANOMALY-2026-10-02-wait-off-the-injected-clock — WAIT UP TO waited on the wall clock while sy-uzeit read the injected one

- Status: `fixed` (in `tools/osd-dialog-step.mjs` and `tools/osd-job-scheduler.mjs`)
- Discovery date: `2026-10-02` (DSL L3 slice 5d, the simulated twin)
- Affected versions: this runtime's WAIT inside a dialog step (`installWait` in `tools/osd-dialog-step.mjs`) with the jobs facade's injectable clock (`manualClock`, `installAbapClock` in `tools/osd-job-scheduler.mjs`)
- Affected ABAP statement, runtime API or adapter: `WAIT UP TO n SECONDS` (and `WAIT FOR ... UP TO`) inside a step
- Minimal reproducer: a step that does `WAIT UP TO 3600 SECONDS` after `installAbapClock(abap, manualClock(...))`: the step waited an hour of wall time, and a test that moved the manual clock by an hour did not end it; `sy-uzeit` after it read the manual clock, not one hour on
- Exact command used to run it: `npx mocha test/dsl-l3-sim.mjs --grep "WAIT UP TO"`
- Expected SAP behaviour: a system has one clock: after `WAIT UP TO 10 SECONDS`, `sy-uzeit` and `GET TIME STAMP` are ten seconds on
- Actual open-abap behaviour (before the fix): sy-datum, sy-uzeit and GET TIME STAMP followed the injected clock, WAIT the wall clock, so the two disagreed whenever a test injected a clock
- Impact on open-steamgate: a simulated pile job waits for its simulated duration; a twin of a night on a manual clock would have waited the night
- Smallest safe workaround: none needed; the fix: `installAbapClock` also installs the clock as the WAIT clock (`setWaitClock`), a step's WAIT sleeps on that clock's own timer (which a manual clock fires when a test advances it), and without an injected clock WAIT is the wall clock as before. Two follow-ups (2026-10-02, round 2): `manualClock.advance` no longer awaits a callback that waits on a later timer of its own clock (it stalled when the scheduler's pass awaited a job in WAIT), and a WAIT on an injected clock nobody moves ends at a wall-clock ceiling (`OSD_WAIT_CLOCK_CEILING_MS`, default 120000) with a loud line on stderr
- Upstream issue: none, the step's WAIT and the clock seam are this repository's
- Regression-test location: `test/dsl-l3-sim.mjs` ("WAIT UP TO inside a step waits on the injected clock", and the long twin)
- Upstream version containing a fix: `n/a`

### ANOMALY-2026-10-02-generate-subroutine-pool — GENERATE SUBROUTINE POOL is refused with sy-subrc 8

- Status: `workaround` (a deliberate refusal; the statement cannot be supported without a compiler at run time)
- Discovery date: `2026-10-02`
- Affected versions: `@abaplint/transpiler 2.13.96` (`packages/transpiler/src/statements/generate_subroutine.ts` emits a plain JS `throw new Error(...)`), gogen before this entry (the method holding the statement was NOT_COMPILED)
- Affected ABAP statement, runtime API or adapter: `GENERATE SUBROUTINE POOL itab NAME prog [MESSAGE mess] [LINE lin] [WORD wrd] [...]`, and `PERFORM form IN PROGRAM (prog)` after it
- Minimal ABAP reproducer: `tools/gogen/testdata/zcl_gogen_t_genpool.clas.abap`; `tools/gogen/testdata-unit-generate/`
- Exact command used to run it: `node tools/gogen/semantics.mjs`; `node --test --test-name-pattern="GENERATE SUBROUTINE" tools/gogen/unit.test.mjs`
- Expected SAP behaviour (measured on the sandbox, open-steamgate PR #467, `test/fixtures/kernel-oracle/`): the pool is generated; a semantic error in it is sy-subrc 4 with MESSAGE / LINE / WORD set, a syntax error sy-subrc 4 with WORD `SYS$$INCOMPLETE$$`; no exception either way. SAP documents sy-subrc 8 as "other generation error"
- Actual open-abap behaviour: the transpiler throws an uncatchable JS Error, sy-subrc / NAME / MESSAGE untouched. Now, in gogen (Go and its JS emitter) and on the transpiler branch `generate-subroutine-pool-refusal`: no exception, sy-subrc 8, NAME initial, MESSAGE `GENERATE SUBROUTINE POOL is not supported`, LINE 0, WORD initial, MESSAGE-ID / INCLUDE / OFFSET / SHORTDUMP-ID untouched. A caller checking `sy-subrc <> 0` takes its error path
- PERFORM IN PROGRAM with an initial or unknown name: **UNMEASURED** on a system. Without IF FOUND the transpiler branch raises what SAP documents for PERFORM: `CX_SY_DYN_CALL_ILLEGAL_FORM` for a missing form of a program whose forms are registered, `CX_SY_PROGRAM_NOT_FOUND` when no form of the program is (a string when the class is not loaded, as CALL FUNCTION does); with IF FOUND nothing. The output fields of the GENERATE refusal are ours too, not a system's: SAP documents rollback and short-dump handling for generation errors, which is not imitated. gogen has no PERFORM at all, so a method holding one stays NOT_COMPILED
- Impact on open-steamgate: code that generates a pool and checks sy-subrc now compiles and runs its error path instead of losing the method (gogen) or dumping uncatchably (JS)
- Smallest safe workaround: none needed beyond the refusal
- Upstream issue: none; branch `generate-subroutine-pool-refusal` in abaplint/transpiler, PR held for the critic gate
- Regression-test location: `tools/gogen/semantics.mjs` (`ZCL_GOGEN_T_GENPOOL`), `tools/gogen/unit.test.mjs`; upstream `test/statements/generate_subroutine.ts`, `test/statements/perform.ts`
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-casting-i-from-x-field — ASSIGN … CASTING TYPE i over an x field: a system dumps, the runtime writes nothing

- Status: `open`
- Discovery date: `2026-10-02`
- Affected versions: OSD `vscode-v0.6.1511` (JS runtime); not checked on later tags
- Affected ABAP statement, runtime API or adapter: `ASSIGN <row>+off(4) TO <i> CASTING.` with `<row> TYPE x LENGTH 4096` and `<i> TYPE i`
- Minimal ABAP reproducer: `FIELD-SYMBOLS <row> TYPE x4096. FIELD-SYMBOLS <i> TYPE i. READ TABLE mt_mem INDEX 1 ASSIGNING <row>. ASSIGN <row>+0(4) TO <i> CASTING. <i> = 16909060.` then read the four bytes back with `<row>+0(1)` … `<row>+3(1)`, and read `<i>` back
- Exact command used to run it: oisee/abapiti `abap/bench/zcl_abapiti_bench_mem`, model C (`st_i32` / `ld_i32` with `mv_model = 'C'`), deployed to OSD with vsp and run as ABAP Unit; the same class run on a system (release 758, 2026-10-02) through ABAP Unit
- Expected SAP behaviour: observed on a system, release 758: runtime error `ASSIGN_BASE_WRONG_ALIGNMENT`, already at offset 0 of a table row of type x LENGTH 4096. Whether other x fields or offsets are aligned on 4 was not measured; this is the observation, not a general rule
- Actual open-abap behaviour: no runtime error; the write through `<i>` leaves the bytes unchanged (they read back as 00), and reading `<i>` fails with "Conversion no number"
- Impact on open-steamgate: code that relies on CASTING over byte fields passes or fails differently from a system; a program that would dump on a system runs on with wrong data
- Smallest safe workaround: do not CASTING into i over an x field; move the bytes with offset access and convert x LENGTH 4 to i
- Upstream issue: none yet
- Regression-test location: none yet; abapiti dropped model C after the measurement
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-get-run-time-units — GET RUN TIME FIELD returns milliseconds since the previous call, not microseconds since the first

- Status: `fixed upstream: abaplint/transpiler#1956 (merged 2026-10-03), pinned 2026-10-07` (`libs.lock.json` transpiler oisee/transpiler `local/osd-build-2026-10-07` 2ff0e801 = the previous pin plus a cherry-pick of #1956; microseconds since the first call, monotonic, per ABAP instance; a host resets the origin with `context.runTime = undefined`)
- Discovery date: `2026-10-02`
- Affected versions: OSD `vscode-v0.6.1511` (JS runtime)
- Affected ABAP statement, runtime API or adapter: `GET RUN TIME FIELD lv_t0. … GET RUN TIME FIELD lv_t1. lv_d = lv_t1 - lv_t0.`
- Minimal ABAP reproducer: `GET RUN TIME FIELD lv_t0. <work>. GET RUN TIME FIELD lv_t1. lv_d = lv_t1 - lv_t0.`, repeated; on a system lv_d is the elapsed microseconds
- Exact command used to run it: oisee/abapiti `abap/bench/zcl_abapiti_bench_mem`. On OSD: the console run (`if_oo_adt_classrun`) printed the `GET RUN TIME` differences; separately, the class's ABAP Unit run reported the wall-clock duration per test method. On a system (release 758, 2026-10-02): the same console code through `run( )` three times and `run_one( )` per memory size
- Expected SAP behaviour: microseconds since the first call in the internal session (https://help.sap.com/docs/SUPPORT_CONTENT/abapfaq/3353526147.html), so `t1 - t0` is the elapsed time and never negative
- Actual open-abap behaviour: the runtime's `get_run_time` returns milliseconds since the PREVIOUS call and moves its reference on every call, so `t0` is the time since some earlier reading, `t1` the time since `t0`, and `t1 - t0` is meaningless; with readings such as 0, 10, 2, 6 it goes negative even though the clock only moves forward. Observed on OSD: the ABAP Unit run of model A took 7.7 s (ABAP Unit duration) while the console run's differences for it summed to about 7,800, and several differences were negative (`15-`, `79-`, `132-`, `482-`). A clock going backwards was not shown
- Impact on open-steamgate: timings measured on OSD cannot be compared with a system, and a negative difference can break code that divides by it or uses it as a timeout
- Smallest safe workaround: measure performance on a system or on osgo
- Upstream issue: none yet
- Regression-test location: none yet
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-gogen-int8-x — integer byte conversions

- Status: `fixed` locally in the Go and IR-as-JS backends.
- Discovery date: `2026-10-02`
- Affected path: `tools/gogen/frontend.mjs` conversions and `go/abap/conv.go` `IToX`.
- Reproducer: `tools/gogen/testdata-unit-int8x/`; run `node tools/gogen/unit.mjs --fixture tools/gogen/testdata-unit-int8x --no-cache`.
- Expected SAP behaviour: the six ABAPiti A4H 758 rows pass; integer bytes are right-aligned, left-truncated or zero-padded, even for negative values.
- Actual before fix: int8 to x and back are NOT_COMPILED; i to x wider than four bytes sign-extends a negative value.
- Impact: ABAPiti's 64-bit memory and bit operations cannot compile.
- Fix: pure `go/intbytes` conversions; frontend and emitters use them, with the existing i runtime binding delegating to the same rule. Documentation-backed rows and pending oracle cases are recorded beside the fixtures.
- Upstream: no issue or PR requested; this is the local gogen backend.
- Regression tests: the fixture folder above, `go/intbytes/intbytes_test.go`, and `testdata/zcl_gogen_t_int8x.clas.abap`.
- Round-4 validation: the supplied int8x/int8y oracles remain 6/6 and 4/4 SUCCESS on Go; the IR-as-JS conversion tests and semantics row also pass. An additional `node tools/osgjs-unit.mjs src/zabapiti_tmp --json --class ZCL_ABAPITI_INT8X ZCL_ABAPITI_INT8Y` run (temporary local copies) reports 4/6 and 2/4 SUCCESS in the separate Node-transpiler runtime: positive int8 to x4 retains the wrong bytes, negative int8 to x16 pads on the right, and two x16-to-int8 rows retain unsigned/leading bytes. That runner, its transpile path and runtime dependency pins are unchanged by this branch. The local gogen fix does not cover those Node-runtime discrepancies.

### NOTE-2026-10-02-checkrun-absent-content -- a checkObject without content checks stored source

- Status: `not-an-anomaly` (fixed local Node ADT defect)
- Discovery date: `2026-10-02`
- Affected versions: Node ADT checkruns before slice C1 (`tools/adt-documents.mjs`)
- Affected ABAP statement, runtime API or adapter: Node `checkObjects` request scanner; JavaScript `String.match` returns null when `<chkrun:content>` is absent
- Minimal ABAP reproducer: not applicable; POST `<chkrun:checkObject adtcore:uri="/sap/bc/adt/oo/classes/zcl_check"></chkrun:checkObject>` to `/sap/bc/adt/checkruns`
- Exact command used to run it: `OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh npx mocha test/adt-abap-c1.mjs --grep "empty overlay differs from absent"`
- Expected SAP behaviour: no overlay means check the stored source; system behaviour not measured here
- Actual open-abap behaviour: Node returned HTTP 500 because null passed the `artifact === undefined` check and was indexed; C1 normalizes the absent match with `?? undefined`, and Node now checks stored source and returns HTTP 200
- Impact on open-steamgate: ordinary checkObject requests without inline content work; an explicitly empty content element still supplies an empty overlay
- Smallest safe workaround: none needed; keep the null-to-undefined normalization in `checkObjects`
- Upstream issue: none; a local scanner defect, not an open-abap or transpiler discrepancy
- Regression-test location: `test/adt-abap-c1.mjs`, "7 empty overlay differs from absent"
- Upstream version containing a fix: not applicable


### ANOMALY-2026-10-02-struct-to-string — a structure assigned to a string field is accepted

- Status: `open`
- Discovery date: `2026-10-02`
- Affected versions: OSD main at the run cockpit (JS runtime); abaplint (open-abap profile) does not flag it either
- Affected ABAP statement, runtime API or adapter: `lv_string = zcl_x=>method( ).` where the method returns a flat structure of two `i` components
- Minimal ABAP reproducer: `TYPES: BEGIN OF ty, a TYPE i, b TYPE i, END OF ty. CLASS-METHODS m RETURNING VALUE(rs) TYPE ty.` and in a caller `DATA lv TYPE string. lv = zcl_x=>m( ).`
- Exact command used to run it: the generated `ZCL_ZL3C_FLEET2_DPC_EXT` (`Unschedule` answered `zcl_l3_fleet2=>unschedule( )` into `ls_answer-answer`), `npx mocha test/dsl-l3-cockpit.mjs` on OSD; on a system (release 758, 2026-10-02) the same class imported through abapGit, `SYNTAX-CHECK` of its class pool and an OData call of the service
- Expected SAP behaviour: syntax error "The result type of the functional method cannot be converted into the type of LS_ANSWER-ANSWER"; the class does not load, and every request of the service dumps with `SYNTAX_ERROR` in the DPC factory
- Actual open-abap behaviour: the assignment runs; the test read the answer as a number (`> 0`)
- Impact on open-steamgate: generated code that is green here does not load on a system; one bad line takes the whole service down
- Smallest safe workaround: the generator words the structure (`deleted N, refused M`); prove a generated class on a system (`SYNTAX-CHECK` of the class pool) before calling it done
- Upstream issue: none yet
- Regression-test location: `test/dsl-l3-cockpit.mjs` (the Unschedule answer)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-dynamic-where-literal — a dynamic WHERE of `1 = 1` is accepted

- Status: `open`
- Discovery date: `2026-10-02`
- Affected versions: OSD main at the run cockpit (JS runtime, SQLite)
- Affected ABAP statement, runtime API or adapter: `SELECT * FROM t INTO TABLE lt WHERE col = 'x' AND (lv_where).` with `lv_where = '1 = 1'`
- Minimal ABAP reproducer: `DATA lv_where TYPE string VALUE '1 = 1'. SELECT * FROM zosd_l3_run INTO TABLE lt WHERE (lv_where).`
- Exact command used to run it: the generated cockpit DPC_EXT's entity sets with no `$filter`, `npx mocha test/dsl-l3-cockpit.mjs` on OSD; on a system (release 758, 2026-10-02) `GET RunSet` through the Gateway
- Expected SAP behaviour: the dynamic condition is parsed by the kernel and refused: the Gateway error log says "The parser produced the error: SELECT 484" and the request answers 500; a condition starts with a column
- Actual open-abap behaviour: the condition is passed to SQLite, which evaluates `1 = 1` as true
- Impact on open-steamgate: a generated or hand-written default of `'1 = 1'` works here and fails every unfiltered read on a system
- Smallest safe workaround: put a real column condition first (the cockpit now starts `lv_where` with `SET_NAME = '<set>'` and adds the OData filter only when there is one)
- Upstream issue: none yet
- Regression-test location: `test/dsl-l3-cockpit.mjs` (the set-filter mutant now edits the dynamic condition)
- Upstream version containing a fix: `unknown`

### ANOMALY-2026-10-02-gogen-int8-division-boundaries

- Affected path: Go int8 `/`, DIV and MOD helpers.
- Reproducer: `tools/gogen/testdata/zcl_gogen_t_int8arith.clas.abap`.
- Expected behavior: MIN / -1 and MIN DIV -1 raise
  `CX_SY_ARITHMETIC_OVERFLOW`; MOD is non-negative; integer `/` rounds half
  away from zero at the full int8 limits. These are documentation-backed
  regressions, not new A4H measurements; JS already gives these results.
- Actual before fix: Go returned MIN for both overflowing quotients and
  rounded incorrectly when a signed remainder was doubled or the divisor
  was MIN. Native unary negation also wrapped MIN.
- Fix: unsigned magnitudes and explicit quotient overflow checks in the
  pure `go/intarith` package; the emitter uses checked negation. Integral
  packed arithmetic uses native helpers where eligible, with the original
  packed calculation retained for wider intermediates and fractional trees.
- Tests: the shared Go/JS fixture, `int8arith.test.mjs`, and randomized
  `go/intarith` comparisons against an independent big-integer reference.

### ANOMALY-2026-10-02-regex-space-repeat - only the first POSIX space class is translated

- Status: `open`
- Affected version: `@abaplint/runtime` 2.13.96
- Reproducer: `FIND REGEX '[[:space:]]*interfaces[[:space:]]+if_oo_adt_classrun' IN lv_source.` with source `  interfaces if_oo_adt_classrun.`
- Expected: both POSIX whitespace classes match whitespace.
- Actual: ABAPRegExp.convert uses String.replace without a global flag; the second class remains literal JS regex syntax and the FIND fails.
- Command: `OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh npx mocha test/adt-abap-c5.mjs` (initial C5 run).
- Workaround: construct the whitespace character set explicitly in C5; keep the word boundary explicit for 7.02 as well.
- Regression: C5 source decision ABAP Unit and the source parity cases in `test/adt-abap-c5.mjs`.
- Upstream: needs an issue; no upstream change made in this slice.

### ANOMALY-2026-10-03-local-rfc-dump - NONE did not raise SYSTEM_FAILURE

Observed locally while generating the L3 remote alert sink: `localClient()` let
an unhandled module dump escape `CALL FUNCTION ... DESTINATION 'NONE'
... EXCEPTIONS system_failure = 1`, leaving the pile without an RFC outcome.
The local destination now translates a dumping module to classic SYSTEM_FAILURE
for the pinned transpiler's call-site catch. Direct callers that supply an
exception map receive its numeric subrc. The destination proxy preserves this
contract when the Gateway library re-registers NONE while constructing a DPC;
declared classic exceptions keep their
names when the transpiler supplies no map. No SAP measurement was made for
this slice. `test/dsl-l3-remote.mjs` exercises a copied dumping ABAP module,
SNAPSHOT_MISMATCH and the doctor retry.

### ANOMALY-2026-10-02-kernel-permissive-bit-xstring — kernel compatibility of bit operands and xstring slice writes

- Status: `documented`; a compatibility warning supplements existing compiler diagnostics (`--kernel-strict`)
- Discovery date: `2026-10-02`
- Affected path: `osgo:unit` and `osgjs:unit`, shared `tools/osd-unit-ci.mjs`
- Minimal ABAP reproducer: `DATA n TYPE i. n = n BIT-AND n.` and `DATA mem TYPE xstring. mem+0(1) = '01'.`
- Exact observations: ABAPiti on A4H 758, 2026-10-02: activation rejected BIT-AND with i/int8 operands in the clz32/clz64 helpers; activation rejected xstring offset writes in mem_copy, mem_fill and mem_st_f64. BIT-OR, BIT-XOR and BIT-NOT follow the same byte-operand rule.
- Expected SAP behaviour: bit operands must be x/xstring; offset or length access to an xstring is read-only.
- Actual open-abap behaviour: for BIT-* on integer operands, OSG refuses compilation as the kernel does (NOT_COMPILED); the warning supplements the existing abaplint syntax diagnostic. Restoring the unmodified compiler diagnostics also makes the pinned abaplint reject typed xstring slice writes in both folder Unit runners (NOT_COMPILED). The underlying OSG slice-write permissiveness is intentional, not a bug to fix, but it does not establish that these sources compile. Default warnings leave compiler diagnostics and exit codes unchanged.
- Check limitation: the focused input-only type pass cannot resolve operands typed from libraries or DDIC objects outside the input folder. Void/Unknown types are not checked; an absent warning does not establish kernel compatibility.
- Impact: the warning identifies activation incompatibilities independently of Unit execution. Suppressing the compiler diagnostic would instead move integer BIT-* failures to runtime.
- Smallest safe workaround: use byte operands and replace whole xstrings before deployment; enable `--kernel-strict` to make compatibility warnings ERROR rows (exit 2).
- Upstream: none; intentional local policy, no refusal added to either runtime.
- Regression tests: `test/kernel-compat.mjs`, `tools/testdata-kernel-compat/`, `tools/testdata-kernel-bits/`, `tools/testdata-kernel-valid/`; both runners report warnings in JSON, row alerts and stderr.

### ANOMALY-2026-10-03-sqlite-execute-stack - large setup INSERT overflows sql.js stack

- Status: `workaround`
- Discovery date: `2026-10-03`
- Affected versions: `@abaplint/database-sqlite` 2.13.83 with `sql.js` 1.14.2.
- Affected ABAP statement, runtime API or adapter: `SQLiteDatabaseClient.execute(string)` during generated source-repository INSERTs in `setupDatabase`; sql.js `Database.run()`.
- Expected SAP behaviour: storing source-repository rows completes database setup without a client-side WASM stack limit.
- Actual open-abap behaviour: `execute(string)` calls sql.js `run()`, whose Emscripten string argument is allocated on the WASM stack. A 5,467,880-byte INSERT crashes with `memory access out of bounds`; the fresh module's stack pointer is 5,318,048. This is a single-statement stack overflow, not heap exhaustion or a leak across statements.
- Impact on open-steamgate: large staged source trees crash SQLite database setup before any selected Unit class runs, including when only one class is selected.
- Measurement: the generated ABAPiti folder's DDL has 162 statements / 55,675 bytes; batched generated inserts have 23 statements / 10,882,730 bytes. Statement 176 fails, after 175 statements / 3,321,536 bytes. The same INSERT fails alone after DDL in a fresh database and succeeds with `exec()`, producing a 6,635,520-byte database export.
- Small working folder: 162 DDL statements / 55,675 bytes and 23 generated INSERTs / 8,316,328 bytes; largest INSERT 3,006,977 bytes. The runner initializes twice: including seed, 430 SQL calls / 16,778,608 bytes; its one test passes in 24.78 s.
- Minimal ABAP reproducer: none required; `test/sqlite-heap-execute.mjs` isolates the adapter with a single INSERT carrying a source literal larger than 6 MiB.
- Exact command used to run it: `OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh npx mocha test/sqlite-heap-execute.mjs`.
- Smallest safe workaround: `tools/sqlite-heap-client.mjs` overrides only execute, using sql.js `exec()` (heap allocation with cleanup) rather than `run()`. `test/setup.mjs` uses it for both Node and preview SQLite. SQL strings and statement arrays retain their order and error behavior.
- Upstream issue: needs an issue in abaplint/transpiler (`packages/database-sqlite`); unsent draft in gitignored `.local/jssql-upstream.md`. No dependency files changed; upstream filing is not authorized.
- Regression-test location: `test/sqlite-heap-execute.mjs`; replacing the local client with the pinned adapter makes the large INSERT case fail.
- Upstream version containing a fix: `unknown`
- Validation: selected owner 7/7 SUCCESS in 82.37 s; full folder 48 class sources / 26 Unit owners, 4,077 SUCCESS, zero FAILURE/NOT_COMPILED/ERROR in 86.26 s. Including two setups and seed, the full run executes 430 SQL calls / 21,911,412 bytes. Peak full-run RSS 2,607,208 KiB includes compilation. Focused regression/batching/anomaly checks: 22 passing.

### ANOMALY-2026-10-03-timestampl-float-ms — GET TIME STAMP into TIMESTAMPL is off by up to 2 ms

- Status: `workaround`
- Discovery date: `2026-10-03`
- Affected versions: `@abaplint/runtime` of the pinned transpiler (`libs.lock.json`), `build/src/statements/get_time.js`
- Affected ABAP statement, runtime API or adapter: `GET TIME STAMP FIELD` into a `TIMESTAMPL` (packed, 7 decimals)
- Minimal ABAP reproducer: `GET TIME STAMP FIELD lv_now.` with `lv_now TYPE timestampl`, then compare its milliseconds with the host clock read just before and after
- Exact command used to run it: `node -e` over `get_time.js`'s arithmetic: `20261003123456 + parseFloat("0.<ms>0000")` for every ms in 0..999 differs from the exact value by up to 1.94 ms
- Expected SAP behaviour: the kernel fills the seven decimals exactly; the milliseconds read from the stamp equal the clock's
- Actual open-abap behaviour: the runtime adds the fraction as a float to the 14-digit integer `YYYYMMDDhhmmss`; at that magnitude a double resolves about 1/256 s, so the stored milliseconds are off by up to about 2 ms (a quarter of values round up)
- Impact on open-steamgate: the ADT reentrance ticket (slice A3b) derives its `_` epoch-milliseconds parameter from the stamp; a test bounding it by the host clock failed once in CI by 1 ms
- Smallest safe workaround: the A3b test allows 2 ms either side of the host clock window; the route itself is unchanged
- Upstream issue: not reported yet; the fix belongs in the runtime (`get_time.js`: build the packed value from strings, not a float sum) -- runtime owner (stoker)
- Regression-test location: `test/adt-abap-a3b.mjs` (default clock)
- Upstream version containing a fix: unknown

### ANOMALY-2026-10-03-int8-hex-conversion - int8 byte assignments keep the wrong bytes

- Status: `fixed via pin f3611417; upstream PR #1964 still open`
- Discovery date: `2026-10-03`
- Affected version: `@abaplint/runtime` 2.13.96
- Affected path: int8 -> x, x -> int8, int8 -> xstring; i -> xstring for negative values
- Minimal ABAP reproducer: `DATA n TYPE int8. DATA h TYPE x LENGTH 4. n = 72623859790382856. h = n. ASSERT h = '05060708'.`
- Expected SAP behaviour: A4H 758 measured two's complement, big-endian, right-aligned; shorter x keeps the last bytes, longer x pads with 00 on the left without sign extension. x -> int8 uses the last eight bytes signed. Integer -> xstring uses minimal bytes for non-negative values (zero = 00, no leading 00 for a set top bit), full type width for negatives.
- Actual before fix: the int8 folder has 6/10 SUCCESS, four failures: positive x4 truncates from the right; negative x16 pads on the right; x16 -> int8 is unsigned and retains high bytes. int8 -> xstring throws; negative i -> xstring is invalid hex.
- Smallest safe workaround: use the local upstream runtime for verification; no OSG runtime patch. Fixed-length i -> x and x -> i already follow the four-byte rule and were left unchanged.
- Command: `OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh npm run osgjs:unit -- .local/abapiti/int8 --json` in a disposable checkout with locally linked packages; shared node_modules is untouched.
- Upstream: [abaplint/transpiler#1964](https://github.com/abaplint/transpiler/pull/1964), branch `fix/int8-hex-conversion`; still open.
- Regression tests: upstream `packages/runtime/test/integer_hex.ts`; OSG `test/osgjs-int8.mjs` and `test/fixtures/osgjs-unit-int8/`. Existing `it.skip` upstream-pending convention; `OSD_INT8_UPSTREAM=1` runs the full test against a local build.
- Upstream version containing a fix: fork pin `f36114179f6f39e5abb42d021f2cf5dcc50b45b9` in `libs.lock.json` (packed #1962 plus int8 #1964); no published upstream release yet.
- Verification: int8 folder 10/10 SUCCESS; OSG opt-in harness 1 pass (default 1 pending); upstream 154 new tests, 192 runtime passes, 99 affected ABAP passes with 4 existing pending. All 26 supplied xstring conversion methods pass. Folder 007 is 12/17 overall: five of seven byte/integer equality methods fail in the separate comparison path; folder 008 is 16/16. This fix does not change comparison operators.
- Dependency isolation: proof used core 2.120.64 (declared upstream minimum); 2.120.65 changes CREATE DATA TYPE HANDLE operand nodes and breaks the unchanged compiler on the library tree. The original shared dependencies were already a local 2.13.93 build, not published; their symlink and contents were preserved, and the disposable copy was removed.

### ANOMALY-2026-10-04-sxml-byte-find - XML quote search can match between bytes

- Status: `workaround`
- Discovery: clean-room T12 request XML tests; no SAP system consulted.
- Affected path: open-abap-core `cl_sxml_string_reader` binary parser's `seek`, through runtime `FIND ... IN BYTE MODE`.
- Reproducer: `<chkrun:checkObjectList xmlns:chkrun='http://www.sap.com/adt/checkrun' xmlns:adtcore='http://www.sap.com/adt/core'/>` fails as not well formed, while double quotes succeed. Searching hex `27` can match between byte boundaries in ASCII data; the first attribute is cut short.
- Expected: public XML syntax allows both quote delimiters with identical semantics.
- Original workaround: the ADT reader supplied BOM-marked UTF-16LE to select the character parser. Critic round 1 confirmed more syntax and numeric-reference defects; the reader now uses its own strict tokenizer and does not call sXML. The byte-mode defect remains confirmed; no dependency source is changed.
- Regression: `test/adt-request-xml.mjs`, single quotes on checkruns and virtual folders.
- Upstream: needs an issue in abaplint/transpiler for byte-aligned FIND; no upstream filing requested.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-04-sxml-outside-root - sXML ignores text outside the root

- Status: `workaround`
- Discovery: repository source inspection during the clean-room XML request review; no SAP system consulted.
- Affected path: open-abap-core local XML parser `next`: text with an empty element stack is skipped before entity decoding.
- Reproducer: `<a/>tail` is not a well-formed XML document under the public XML contract, but its trailing text is not returned by sXML.
- Original workaround: a private sXML wrapper exposed outside-root text. Critic round 1 replaced this with a strict tokenizer that checks outside-root XML S and counts roots directly. The sXML defect remains confirmed; sXML is no longer on this request path.
- Regression: `zcl_osd_adt_request_xml` Unit tests and `test/adt-request-xml.mjs` trailing-text rejection with an unchanged state digest.
- Upstream: needs an issue in open-abap-core; no upstream filing requested.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-04-adt-lock-handle-length - ADT handles were 36 characters

- Status: `fixed locally`
- Discovery: black-box wire comparison, W1-lock; only the observed length is used here.
- Affected path: Node ADT LOCK and the ABAP session implementation used by the ABAP lock route.
- Expected SAP behaviour: LOCK_HANDLE is an opaque 40-character value that is passed unchanged to PUT and UNLOCK.
- Actual local behaviour: UUID text produced 36 characters, and ZOSD_ADT_SHDL stored CHAR36.
- Resolution: Node generates 20 random bytes as hex; ABAP combines one UUID's 16 bytes with four bytes of another, then hex-encodes them. Both produce 40 characters with at least the former entropy. The persisted field is CHAR40; consumers retain opaque string equality.
- Regression: T03/T04 for both fronts, persisted session handle checks, and the ABAP-FS write/restore/unlock driver, in both runtime modes.
- Upstream: none; the facade and session storage are local implementations.

### ANOMALY-2026-10-04-sxml-supplementary-ref - numeric references truncate to a BMP code unit

- Status: `workaround`
- Discovery: critic round 1 of T12/T13; independent reader and ABAP Unit probes, no SAP system consulted.
- Affected path: open-abap-core `cl_sxml_string_reader.clas.locals_imp.abap`, local XML parser `decode`, numeric reference conversion through BMP-only `cl_abap_conv_in_ce=>uccpi`.
- Reproducer: `<r>&#x1F680;</r>` and `<r>&#128640;</r>` produce U+F680 instead of U+1F680. Literal supplementary UTF-8 survives; transcoding is not the cause.
- Expected: decimal and hexadecimal references denote the same Unicode scalar value as literal UTF-8, in text and attribute values.
- Workaround: ADT request XML no longer uses sXML. Its strict tokenizer validates the scalar value, constructs the complete UTF-16 surrogate pair, and converts that pair together. No dependency file is changed.
- Regression: the common `test/fixtures/adt-request-xml-corpus.json` exercises both references, literal pairs, text and attributes through Node and the transpiled ABAP class.
- Upstream: needs an issue in open-abap-core; no upstream filing requested.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-06-http-client-send-synchronous - cl_http_client send( ) blocks, receive( ) does nothing

- Status: `fixed in the pin, upstream PR pending` (oisee/open-abap-core `fix/http-client-async-send-upstream` on upstream main; the byte-identical patch (round 6 of review) is in the `osd-build-2026-10-07b` pin 22d31a35, on top of cherry-picks of upstream #1253, #1271, #1268, #1270, #1269 and #1289; `send( )` starts the request, `receive( )` awaits it, construction errors fail in send, request errors and timeouts in receive)
- Discovery: PIA's fan-out probe (ZCL_PIA_PROBE_FAN), measured on A4H (SAP 7.58, background job) and on an OSG instance. It was reported by the PIA session on 2026-10-06; dell confirmed the source.
- Affected path: open-abap-core `src/http/cl_http_client.clas.abap` (pin 8b397be). `if_http_client~send` awaits the whole request (`await postData(...)`, around line 195) and fills the response there. `if_http_client~receive` is empty ("handled in send()").
- Reproducer: create three clients for `http://httpbin.org/delay/2`. Call `send( )` on each, then `receive( )` on each.
- Expected SAP behaviour: `send( )` returns immediately and `receive( )` waits for its own response, so the three requests overlap. On A4H the send phase took 1 ms, the receives 2174 / 1 / 58 ms, and the fan-out 2234 ms in total, against 6525 ms sequentially.
- Actual local behaviour: each `send( )` completes its request (about 7 s for all three) and every `receive( )` returns at once, so a fan-out runs sequentially. Code written in the ZLLM style gains nothing.
- Possible fix: `send` keeps the pending promise without awaiting it; `receive` awaits it and fills the response. `http_communication_failure` then moves from `send` to `receive`, as on SAP. The per-client agent uses `maxSockets: 1`, which is fine per client.
- Workaround: none in the tree. PIA runs its turn in a background unit and makes one LLM call per step. Whether two background units run concurrently in OSG has not been measured.
- Regression: none yet.
- Upstream: [open-abap/open-abap-core#1299](https://github.com/open-abap/open-abap-core/pull/1299) (sent 2026-10-07 after three critic rounds; branch oisee:fix/http-client-async-send-upstream at 6c6dc15e).
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-06-get-run-time-delta - GET RUN TIME returns ms since the previous call

- Status: `duplicate` of ANOMALY-2026-10-02-get-run-time-units: fixed upstream in abaplint/transpiler#1956, pinned 2026-10-07 (2ff0e801)
- Discovery: the same probe printed "A sequential: 6525 ms" on A4H and "7 ms" on OSG, while the OSG wall clock was 13.6 s for six 2-second requests. dell confirmed the source.
- Affected path: `@abaplint/runtime` `build/src/statements/get_run_time.js`. It keeps a module-level `prev`. The first call sets 0; every later call sets `Date.now() - prev` and moves `prev`.
- Expected SAP behaviour: the first `GET RUN TIME FIELD` returns 0 and fixes the origin. Every later call returns the microseconds elapsed since that origin, so the value only grows. After `WAIT UP TO 1 SECONDS` twice, the three calls give 0, about 1000000 and about 2000000.
- Actual local behaviour: milliseconds since the previous call, which here gives 0, about 1000 and about 1000. `( t1 - t0 ) / 1000` yields seconds labelled as milliseconds, and differences between non-adjacent calls are meaningless. The origin is also module-global, shared by every session in the Node process, while on SAP it belongs to the internal session.
- Reproducer: `GET RUN TIME FIELD t0. WAIT UP TO 1 SECONDS. GET RUN TIME FIELD t1. WAIT UP TO 1 SECONDS. GET RUN TIME FIELD t2.` Derived from the source and the probe; this exact snippet has not been run on both systems yet.
- Possible fix: keep a fixed `start`, set `(now - start) * 1000` (or `performance.now()` for sub-millisecond resolution), and scope the origin to the session.
- Workaround: none; measure with `GET TIME STAMP FIELD` of type `timestampl` instead.
- Regression: none yet.
- Upstream: needs an issue in abaplint/transpiler (runtime), after our critic pass; no upstream filing requested.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-06-uccpi-high-byte - cl_abap_conv_out_ce=>uccpi multiplies the high byte by 255

- Status: `duplicate` of ANOMALY-2026-09-24-uccpi-255. The defect was already fixed upstream in open-abap-core#1263 (merged 2026-09-25), but our pin 8b397be predates the fix. Remedy: cherry-pick or move the pin; no new upstream filing. Recorded here by dell without checking the older entry (2026-10-07 correction).
- Discovery: PIA's first deployment to A4H 7.58 (zcl_pia_00_json_util, 29 tests, 29/29 on both systems after fixes), reported by the PIA session on 2026-10-06. dell confirmed the source.
- Affected path: open-abap-core `src/conv/cl_abap_conv_out_ce.clas.abap`, method `uccpi`. It converts to encoding 4103 (UTF-16LE, low byte first), then computes `ret = lv_hex(1)` followed by `ret = ret + lv_hex+1(1) * 255`. The factor must be 256.
- Reproducer: `cl_abap_conv_out_ce=>uccpi( 'Ж' )` and `cl_abap_conv_out_ce=>uccpi( '€' )`.
- Expected SAP behaviour: 1046 (U+0416) and 8364 (U+20AC).
- Actual local behaviour: 1042 and 8332, wrong by the high byte for every character above U+00FF. ASCII and Latin-1 are unaffected, because their high byte is 0.
- Workaround: none in the tree; PIA does not use `uccpi`. ANOMALY-2026-10-04-sxml-supplementary-ref already avoids sXML numeric references, which convert through `cl_abap_conv_in_ce=>uccpi`.
- Regression: none yet.
- Upstream: already fixed in open-abap-core#1263; stoker brings it into our pin branch (osd-build-2026-10-07).
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-06-data-value-variable - DATA ... VALUE accepts a variable

- Status: `open`
- Discovery: PIA's first A4H deployment. Code that compiled in OSG was refused on SAP.
- Affected path: the syntax check that the transpiler runs (abaplint).
- Reproducer: `DATA lv_start TYPE i.` followed by `DATA lv_pos TYPE i VALUE lv_start.`
- Expected SAP behaviour: a syntax error, "LV_START" is not a constant. VALUE takes only a literal, a constant or IS INITIAL.
- Actual local behaviour: it compiles and runs. Code built in OSG then fails to transport to SAP.
- Workaround: none; authors must use a constant or a literal.
- Regression: none yet.
- Upstream: filed as https://github.com/abaplint/abaplint/issues/4392 after the critic pass (2026-10-07). Measured with @abaplint/cli 2.120.70: the VALUE operand is not resolved at all; an undeclared name there also gives 0 issues.
- Upstream version containing a fix: unknown.

Not an anomaly, recorded for porting: on 7.58, `FIND ... REGEX` (POSIX) raises a deprecation that vsp deploy treats as an error. PIA moved to PCRE, which OSG supports.

### ANOMALY-2026-10-06-uccp-lone-surrogate - uccp drops a surrogate code unit

- Status: `fixed in the pin, upstream PR pending` (oisee/open-abap-core `fix/uccp-lone-surrogate`, carried by the pin since 2026-10-07, now `osd-build-2026-10-07b` 22d31a35; `uccp` builds the UTF-16 code unit directly, so a lone surrogate survives and the pair concatenates to U+1F60A)
- Discovery: PIA's test escape_emoji_pair passes 30/30 on A4H 7.58 and fails only in OSG. It was triggered by an emoji in a model answer and reported by the PIA session on 2026-10-06. dell confirmed the path in source.
- Affected path: open-abap-core `src/conv/cl_abap_conv_in_ce.clas.abap`. `uccp` turns the hex into an integer and calls `uccpi`, which decodes the two bytes through a UTF-16LE (4103) converter. A lone surrogate does not survive that decode, and `uccp` swallows `cx_sy_conversion_codepage` (`* todo, hmm`), which leaves the result empty.
- Reproducer: `cl_abap_conv_in_ce=>uccp( 'D83D' ) && cl_abap_conv_in_ce=>uccp( 'DE0A' )`.
- Expected SAP behaviour: each call returns its UTF-16 code unit unchanged, so the concatenation is U+1F60A with strlen 2.
- Actual local behaviour: both halves are lost, so PIA's `unescape(😊)` returns an empty string.
- Related, milder: on SAP, `cl_abap_conv_codepage=>create_out( )->convert( )` of a lone surrogate raises `CX_SY_CONVERSION_CODEPAGE`, while OSG appears to produce `EF BF BD` silently. This is not measured in OSG yet.
- Workaround: none in the tree. The same family as ANOMALY-2026-10-04-sxml-supplementary-ref and ANOMALY-2026-10-06-uccpi-high-byte.
- Regression: none yet.
- Upstream: [open-abap/open-abap-core#1298](https://github.com/open-abap/open-abap-core/pull/1298) (sent 2026-10-07 after our critic; branch oisee:fix/uccp-lone-surrogate-upstream).
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-07-daemon-api-types -- PIA measured typed START and INFO order

- Status: fixed locally (round 1 of ZIP parity).
- Measurement: PIA DD04L/DD03L on A4H 7.58, 2026-10-07.
- Expected contract: IF_ABAP_DAEMON_TYPES instance ID uses ABAP_DAEMON_INSTANCE_ID
  (SSTRING 255), name uses ABAP_DAEMON_NAME (CHAR60), priority uses
  ABAP_DAEMON_PRIORITY (INT4). START priority is VALUE with normal default.
- ABAP_DAEMON_INFO field order: NAME, INSTANCE_ID, CREATOR_CLIENT (CLNT3),
  CREATOR_USER (CHAR12), USED_DEST (ABAP_DAEMON_DESTINATION, CHAR40),
  CREATION_TIME (TIMESTAMP, DEC15), APPLICATION_SERVER (MSNAME2, CHAR40).
  PIA did not name data elements for CREATOR_CLIENT/CREATOR_USER; those remain
  direct types. No additional daemon API signatures were inferred.
- Previously: generic START name/priority and INFO destination after creation
  time, with missing element identities. The merged main had already corrected
  the instance ID's builtin type to SSTRING; it still lacked the measured element.
- Regression: test/daemon-api.mjs, measured DDIC/order/START parameter check;
  test/unit/zcl_osd_daemon_api.clas.abap compiles calls using the interface types.

### ANOMALY-2026-10-07-unit-method-case - a test method not written in lower case is "not a function"

- Status: `fixed locally` (our runner); `open` upstream (the transpiler's own unit script)
- Discovery: PIA's agent on OSG, F1 run of 2026-10-07: RUN_TESTS answered `test.FRIENDS_ACCESS_INSTANCE[declared.method] is not a function`. A repro matrix of 33 classes showed LOCAL FRIENDS has nothing to do with it; the trigger is the case of the declared name.
- Affected path: the transpiler keys `FRIENDS_ACCESS_INSTANCE` in lower case (`traversal.ts` `buildFriendsAccess`) and exports a test include's local classes in lower case (`handlers/handle_abap.ts`), while abaplint's `listClassDefinitions()` keeps names as written. Before this fix `tools/osd-unit.mjs` (the runner behind RUN_TESTS and ADT) looked methods and local classes up by the written name, and `tools/osd-unit-all.mjs` (`npm run unit`), `tools/gogen/node-unit-results.mjs` and `tools/osgjs-unit-run.mjs` each had one such lookup. Upstream, the transpiler's own `unit_test.ts` keeps the method's written spelling (`methods.push(m.name)`, then `FRIENDS_ACCESS_INSTANCE[m.name]()`), though it already lower-cases the class.
- Reproducer: a test class with `METHODS First_Test FOR TESTING.` (or `CLASS LTCL_Probe DEFINITION FOR TESTING`), implementation `METHOD first_test.`; run its tests.
- Expected SAP behaviour: ABAP names are case-insensitive; the method runs.
- Actual local behaviour: the method is a runtime failure ("is not a function"); a mixed-case local class is "not exported".
- Workaround: the lookups lower-case the name (`tools/osd-unit.mjs`, `tools/osd-unit-all.mjs`, `tools/gogen/node-unit-results.mjs`, `tools/osgjs-unit-run.mjs`); the reported name stays upper case.
- Regression: `test/osd-unit.mjs` "a test method or class written in mixed case is looked up the way the transpiler keys it".
- Upstream: needs an issue/PR in abaplint/transpiler (`unit_test.ts` lower-cases the method name as it already does the class), after our critic pass.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-07-sections-nonfinal - a non-final global class with only a PUBLIC SECTION is accepted

- Status: `open`
- Discovery: abapiti's translated abaplint lexer on A4H: none of its 113 generated classes activated, 105 of them reported this error (the rest only follow-up errors); osgo and OSG-JS ran the same classes green.
- Affected path: osgo, the JS runtime (OSG-JS) and the abaplint syntax check (@abaplint/core 2.120.56, v750, check_syntax: no issue on the reproducer or the controls).
- Reproducer: `CLASS zcl_x DEFINITION PUBLIC CREATE PUBLIC. PUBLIC SECTION. METHODS m RETURNING VALUE(rv) TYPE i. ENDCLASS.` with any implementation. Controls: the same class with `FINAL`, or with empty `PROTECTED SECTION.` and `PRIVATE SECTION.`, activates; a class with no section statement at all also activates.
- Expected SAP behaviour (7.58, measured 2026-10-07 in a throwaway package): the class does not activate, "For technical reasons, the statement "PROTECTED SECTION" or "PRIVATE SECTION" must exist in non-final global classes."; subclasses and users then fail with follow-up errors (type unknown, superclass CREATE PRIVATE).
- Actual local behaviour: osgo 3/3 and OSG-JS 3/3 pass the reproducer and both controls; abaplint reports nothing.
- Workaround: generators always write all three sections (abapiti does since this finding).
- Regression: none yet.
- Upstream: https://github.com/abaplint/abaplint/issues/4393 (abaplint check_syntax accepts it; filed 2026-10-07).
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-08-instance-of-initial - IS INSTANCE OF ignores an initial reference's static type; object as the target throws

- Status: `fixed locally` (pinned transpiler); `open` upstream (abaplint/transpiler#1975)
- Discovery: abapiti's translated lexer on three runtimes (its case 032), measured on A4H 7.58 by abapiti on 2026-10-08 in a throwaway package (removed after).
- Affected path: the transpiler's `IS INSTANCE OF` (`packages/transpiler/src/expressions/compare.ts`, `packages/runtime/src/compare/instance_of.ts`); osgo: fixed separately in oisee/open-steamgate#655 (same A4H rows).
- Reproducer: `DATA r TYPE REF TO zcl_a.` (initial) `ASSERT r IS INSTANCE OF zcl_a.`; and a bound `o`: `ASSERT o IS INSTANCE OF object.`
- Expected SAP behaviour (7.58): an initial reference is decided by its static type: true when the static type is the target or a subtype (initial REF TO zcl_a / zcl_a: true; initial REF TO zif_x / zif_x: true; initial REF TO zcl_a / a subclass: false; initial REF TO object / zcl_a: false; an interface the static type does not implement: false); a bound reference `IS INSTANCE OF object` is true.
- Actual local behaviour: OSG-JS gave false for every initial reference and threw "Right-hand side of 'instanceof' is not an object" for `object`.
- Workaround: none needed after the pin; abapiti's generator also writes `x IS BOUND AND x IS INSTANCE OF c`.
- Regression: abaplint/transpiler `test/operators/instance_of.ts` (18 cases, 16 fail before the fix), carried by the pin.
- Upstream: https://github.com/abaplint/transpiler/pull/1975 (branch inside the repository; CI and Regression green, 64/64 rows); pinned 2026-10-08 as `libs.lock.json` transpiler oisee/transpiler `local/osd-build-2026-10-08` e2a459b1 = the previous pin 2ff0e801 plus a cherry-pick of #1975.
- Upstream version containing a fix: unknown.

### ANOMALY-2026-10-08-zip-read-int4 - cl_abap_zip's read_int4 overflows type i, and only the Go runtime notices

- Status: `fixed upstream` (open-abap/open-abap-core#1282, ce4ddaad, 2026-10-02); pinned 2026-10-08 The transpiler runtime's `i` range check: abaplint/transpiler#1955 (open), pinned 2026-10-08 as `libs.lock.json` transpiler oisee/transpiler `local/osd-build-2026-10-08b` 753230cb = the previous pin e2a459b1 plus its four commits.
- Discovery: abapiti's case 033, `cl_abap_zip=>load` raising `CX_SY_ARITHMETIC_OVERFLOW` on osgo for an ordinary 50-file ZIP, while OSG-JS loaded it.
- Affected path: open-abap-core `lcl_stream=>read_int4` (`cl_abap_zip.clas.locals_imp.abap`) before #1282: `rv_int = rv_int + lv_val * lv_factor`, then `lv_factor = lv_factor * 256`, all in `i`; the factor reaches 2^32 after the fourth byte for any input.
- Expected SAP behaviour (7.58): the same method body dumps `COMPUTE_INT_TIMES_OVERFLOW` for both `01020304` and `01020380` (measured on A4H by abapiti on 2026-10-08 in a throwaway package, removed after). SAP's own `cl_abap_zip` is not affected; this is open-abap-core's implementation.
- Actual local behaviour: osgo raised the overflow, as the kernel does; OSG-JS did not, because the JS runtime does not raise on `i * i` here (abaplint/transpiler#1955, open).
- Fix: pin `libs.lock.json` open-abap-core to oisee/open-abap-core `osd-build-2026-10-08` d5aea88b = the previous pin 22d31a35 plus a cherry-pick of ce4ddaad. After the pin a ZIP round trip on osgo gets past `read_int4` and stops at a separate osgo gap: `cl_abap_conv_in_ce=>read` passes a generic `data` parameter (an osgo NOT_COMPILED, tracked with the generic by-reference parameter work).
- Regression: open-abap-core `cl_abap_zip.clas.testclasses.abap` (from #1282), carried by the pin.
- Upstream: https://github.com/open-abap/open-abap-core/pull/1282 (merged); JS overflow: https://github.com/abaplint/transpiler/pull/1955
- Upstream version containing a fix: open-abap-core main after 2026-10-02.

### ANOMALY-2026-10-10-gogen-binary-rows - generic TABLES rows and positional ASSIGN COMPONENT

- Status: fixed locally on `fix/gogen-generic-loop-assign`.
- Discovery: newer open-abap-core `SCMS_BINARY_TO_XSTRING` loops over a generic `BINARY_TAB`, then selects the first component of structured rows.
- Actual local behaviour: Go assigned `*abap.RowBinding[abap.Data]` to `abap.Data`; positional component selection was refused as `ASSIGN COMPONENT by a i`.
- Expected behaviour: unmeasured; ABAP documentation. Generic field symbols bind to the original row storage; positional components are 1-based, and an out-of-range selection returns sy-subrc 4 with an unassigned target. Non-structures follow the existing by-name failure path.
- Related seam: generic binary values moved into a string now use the existing hexadecimal conversion, as SCMS does when joining its parts.
- Regression: `tools/gogen/testdata/zcl_gogen_t_binary.clas.abap` and `ZGOGEN_T_BINARY`: elementary binary rows, structured binary rows, writes through both bindings, positional variable selection, and failed assignment after a successful binding, on Go and IR-JS.
