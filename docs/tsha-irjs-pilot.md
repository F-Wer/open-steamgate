# TS-HA on IR-JS: compile and runtime seams

Step 1+2, measured on 2026-10-10 against the same read-only TS-HA native
report and library input as the earlier `irjs/report.md` measurement.
The starting revision is `e7dd62ce276f489d723b3925270eb89fe63c0e58`.
The report was **not executed**. There is no SQL or GUI implementation here.

| Compile-only measurement | Before | After |
|---|---:|---:|
| Frontend classes / method bodies | 2,127 / 14,338 | 2,127 / 14,338 |
| Frontend statement refusal sites | 199 | 190 |
| Skipped untyped methods | 7 | 7 |
| JS-only refusal sites / normalized groups | 1,291 / 33 | 37 / 26 |
| Total emitted JS refusal sites | 2,153 (diagnostic continuation) | 759 (production emitter) |
| Total emitted Go refusal sites | 871 | 731 |
| Required dynamic-constructor guards | 627 (all parameterized constructors) | 496 (required parameters only) |
| DELETE range bounds below 1 guards | 36 | 36 |
| Raw shared `@KERNEL` statement refusal sites | 124 | 124 |
| Completed production JS module | no | yes |
| `node --check` / dynamic import | fail / fail (diagnostic module) | pass / pass |

The before numbers come from the diagnostic continuation because the original
production emitter aborts at its first INSTANCE OF. The after numbers count
literal refusal sites in ordinary production output. The same normalization
removes method/location labels, aligns DELETE punctuation, and compares JS
reason groups with Go's; counts are static sites, not runtime hits. The
message-text reason difference still counts as JS-only despite equivalent
conditional limitations in both hosts. Generic runtime-library guards are
excluded, as in the original measurement.

Changes:

- INSTANCE OF uses the frontend's initial-reference result and the same class,
  superclass and interface fit as CAST. OBJECT fits every object. Static
  attributes use the resolved owner and attribute, preserving `__` in names.
- Both emitters resolve omitted optional/default constructor arguments before
  emitting type/constant declarations, including inherited constructors and
  IS SUPPLIED flags. Required-parameter constructors retain Go's refusal.
- DELETE keeps Go's exact source-of-truth guard: **“index below 1 was not
  measured”**. This checkout contains no measured lower-bound rule to substitute.
  Empty-table DELETE FROM without TO is covered by the same guard.
- Writes to supported numeric/message `sy` fields and nonliteral UCCP compile.
  UCCP follows open-abap-core's SIMPLE → x(2) → i conversions and preserves an
  individual UTF-16 unit, including an unpaired surrogate.
- Keyed table expressions, GET RUN TIME and CHECK were needed to finish emission.
  A keyed miss raises CX_SY_ITAB_LINE_NOT_FOUND. CHECK continues the innermost
  loop or returns from the method. GET RUN TIME uses monotonic microseconds
  from the first call, with signed-i wrapping, as Go does.
- The synchronous CONV_IN_CE / CONV_OUT_CE adapters use the Buffer/TextDecoder
  primitives in open-abap-core's kernel bodies. IR-JS bytes are Latin-1 strings,
  rather than the vanilla runtime's hex strings. BOM preservation, fatal/ignored
  decode errors, supplied output N and Go's explicit input-N refusal are retained.
  Generators stage the companion codepage module beside the existing runtime.

Reachability was inspected from START_OF_SELECTION, LOAD_OF_PROGRAM and
INITIALIZATION, following calls, virtual implementations, NEW, class
constructors, and implicit exception-text helpers. This gives 1,664 methods
and three native adapters: the two converters and the existing message-text
fallback. **None of the 124 raw shared kernel refusal sites is on that graph.**
Character utilities are constants already lowered by the frontend; their
kernel class constructor is deliberately excluded by both emitters. UCCP
calls use the intrinsic, rather than the generic kernel body.

There is one variable-name dynamic CREATE fallback in the input's class
factory. Its known class-name CASE arms construct explicitly and are included
in the graph; an arbitrary external name cannot be proven reachable by this
static analysis. This is a compile-only reachability estimate, not a runtime
trace or a proof of complete TS-HA execution.

Remaining entry-path gaps are the 12 DATASET sites for the step-3 JS host and
one shared frontend `IS INSTANCE OF a exc` refusal in the error handler.
The message-text adapter still refuses T100/OTR texts, as Go does. The remaining
25 JS-only sites outside DATASET include filesystem/environment host services,
RTTI and other unused native adapters. No GUI compatibility class was changed.
Required constructors, DELETE bounds below 1, input conversion N, and the seven
untyped methods remain explicit limitations. Matching vanilla report output
is reserved for step 3.

Validation:

- `node tools/gogen/semantics.mjs`: 190 Go + 190 JS results, all `ok`, 0 FAIL;
  existing refusal suites also pass. TRAVCONV now has one shared successful
  oracle. ZIP and JSONDES progress to their next explicit DEFLATE/JSON-parser
  refusals, and retain those expected limitations.
- `node --test tools/gogen/pilot.test.mjs`: eight tests covering compilation,
  module import and execution of small fixtures, initial/interface/class/object
  fit, CAST errors, static spelling, constructors, DELETE guards, keyed access,
  sy writes, CHECK, clock use and codepage behavior. The original emitter was
  replayed locally to confirm failures for the newly supported paths.
- Static, IS SUPPLIED and Go host-exception-factory regression suites: 12 pass.
- Size budget `--changed origin/main` and changed-file leak scan: exit 0.
  The size checker reports two inherited breaches outside this change.

The reused throwaway driver and measurement/load artifacts are under
`.local/tsha-pilot/`: `driver.mjs`, `frontend-after.json`, `program-after.json`,
`zabaplint.mjs`, `counts.log`, `reachable.json`, `load-check.json` and test logs.
The exact input remained read-only. Heavy runs used the requested wrapper,
16 GB Node heap, Go cache and scratch roots after checking resource thresholds.


## Layer 1: lexer execution (2026-10-10)

Measured from `b230f6e45` on `feat/irjs-tsha-pilot`, using the read-only
lexer input supplied by abapiti (`perf/upper-ascii`, `7072517`). The lexer
closure has 72 files; the benchmark closure has 882 files. No input file was
modified. This section executes the lexer; the earlier report measurements
above remain compile-only.

| Layer | PASS/hash | IR-JS | Go | Vanilla Node |
|---|---|---:|---:|---:|
| Lexer cases | PASS: 44/44, 4,663 tokens | 44/44 | 44/44 | Embedded token-stream oracle |
| Lexer, zabapgit | 609,647 tokens + SHA-256 match, 3/3 on each host | **14,079,925 µs** | **3,625,147 µs** | 338,372 µs |
| Statements | Not executed in this lexer step | — | — | 2,097,152 µs |
| Structures | Not executed in this lexer step | — | — | 9,885,785 µs |

The 44 cases contain 4,663 tokens. The original ABAP Unit include has one
`TOKENS FOR TESTING` method containing all cases, plus a teardown that requires
44 completions; it passes on both hosts. For individual verdicts, a scratch
copy also splits the same case blocks into 44 methods, retaining the original
combined test and completion teardown. Both hosts pass all 45 methods,
including the original virtual-position assertion.

| Case | IR-JS | Go |
|---|---|---|
| 01 `empty` | PASS | PASS |
| 02 `single_dot` | PASS | PASS |
| 03 `two_tokens_backtick_pragma` | PASS | PASS |
| 04 `two_tokens_no_space` | PASS | PASS |
| 05 `arrow_whitespace` | PASS | PASS |
| 06 `string_template_braces` | PASS | PASS |
| 07 `string_template_text` | PASS | PASS |
| 08 `string_template_error` | PASS | PASS |
| 09 `string_template_error2` | PASS | PASS |
| 10 `two_comments_same_column` | PASS | PASS |
| 11 `write_string` | PASS | PASS |
| 12 `comment_star` | PASS | PASS |
| 13 `comment_quote_trailing` | PASS | PASS |
| 14 `colon_chain` | PASS | PASS |
| 15 `colon_chain_multiline` | PASS | PASS |
| 16 `field_symbols` | PASS | PASS |
| 17 `dashes_and_comp` | PASS | PASS |
| 18 `instance_arrow` | PASS | PASS |
| 19 `static_arrow` | PASS | PASS |
| 20 `arrow_variants` | PASS | PASS |
| 21 `parens_brackets` | PASS | PASS |
| 22 `paren_w` | PASS | PASS |
| 23 `numbers` | PASS | PASS |
| 24 `punctuation` | PASS | PASS |
| 25 `pragmas` | PASS | PASS |
| 26 `ping_string` | PASS | PASS |
| 27 `ping_escaped` | PASS | PASS |
| 28 `escaped_quote` | PASS | PASS |
| 29 `template_nested` | PASS | PASS |
| 30 `template_multiline` | PASS | PASS |
| 31 `macro_definition` | PASS | PASS |
| 32 `whitespace_mixed` | PASS | PASS |
| 33 `crlf` | PASS | PASS |
| 34 `concat_expression` | PASS | PASS |
| 35 `at_data` | PASS | PASS |
| 36 `sql_host` | PASS | PASS |
| 37 `string_then_comment` | PASS | PASS |
| 38 `star_no_newline_before` | PASS | PASS |
| 39 `long_identifier` | PASS | PASS |
| 40 `unicode_bmp` | PASS | PASS |
| 41 `template_brace_in_text` | PASS | PASS |
| 42 `real_wasm_compiler` | PASS | PASS |
| 43 `real_bench_mem` | PASS | PASS |
| 44 `real_abapgit` | PASS | PASS |

`tools/gogen/unit-js.mjs` is the minimal synchronous host beside
`semantics.mjs`: it discovers concrete local classes and methods `FOR TESTING`
from the frontend registry, grows the dependency and superclass closure,
emits JS, and creates a fresh instance per test. It runs class setup/teardown
and instance setup/teardown, reports assertion messages, honors explicit
teardown `QUIT = NO`, and reloads generated statics for each test class. It
uses compiled `CL_ABAP_UNIT_ASSERT` bodies, rather than replacing the oracle.
It does not provide Go's database, crash-retry or sharded-host facilities.

The blocking JS comparison gap was fixed by selecting the generic
comparison type from both operands, as Go does. Assertion dump helpers and
UTF-8 base64 adapters now have JS bindings. Repeated string sections now use
a bounded four-input memo for surrogate classification and code-point indices,
avoiding repeated classification of long immutable inputs while preserving the
existing string indexing semantics. An interrupted preliminary run is excluded
from the three recorded samples; no before/after speedup is claimed for the memo.

Benchmark times are the **median of three fresh-process runs**, using the
ABAP `GET RUN TIME` interval around the unchanged lexer call. Compilation,
input assembly, token dump and hashing are outside that interval. The runner
copies `ZCL_PHASE3_BENCHMARK` into scratch and ends its `RUN` after the lexer
count and original lexer dump/hash; it retains all embedded input methods.
It does not execute statements or structures or substitute a host lexer.

| Sample | IR-JS `lex_us` | Go `lex_us` |
|---|---:|---:|
| 1 | 12,409,730 | 3,625,147 |
| 2 | 20,486,408 | 3,948,780 |
| 3 | 14,079,925 | 3,604,087 |

All six runs report `ok = X`, 609,647 tokens and this lexer SHA-256:
`9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40`.
IR-JS is about 41.6× the supplied vanilla lexer time, Go about 10.7×;
IR-JS is about 3.9× Go on these medians. These are loaded-host measurements:
benchmark processes and verification shared the two heavy slots. Observed
one-minute load was 3.74–8.83, IO `some avg10` 0.00–0.09, and available memory
64–87 GB. Launch checks satisfied IO < 30, memory > 20 GB and load < 12.
The wide JS sample range should not be interpreted as idle-host stability.
The hosts were Node v26.9.0 and Go 1.22.2 on Linux amd64; Node used the
requested 16 GB heap, and all heavy runs used `nice -n10` and range 50–59.

Reproduction (prefix heavy commands with the resource-gated wrapper below):

```sh
GOFLAGS=-buildvcs=false GOCACHE=/mnt/ssd-510/osg/go-build \
OSD_HEAVY_TMP=/mnt/ram/stoker OSD_HEAVY_RANGE=50-59 \
nice -n10 tools/osd-heavy.sh node --max-old-space-size=16000 <command>
```

- `tools/gogen/unit-js.mjs --fixture <input>/lexer-cases --out .local/tsha-lexer/js-unit`
- `tools/gogen/unit.mjs --fixture <input>/lexer-cases --out .local/tsha-lexer/go-unit --jobs 1`
- `tools/gogen/lexer-bench.mjs --fixture <input>/zabapgit-bench --out .local/tsha-lexer/replay`

Remaining gaps: **0 executed lexer blockers, 0 failed cases, 0 token/hash
mismatches**. Statements and structures are **2 unmeasured layers**, not
passes. The benchmark closure still has **12 shared frontend refusal sites**:
8 raw kernel statements, 2 time conversions, 1 generic APPEND form and
1 generic-to-fixed-byte move; **0 skipped untyped methods, 0 broken objects**.
The generated JS has 155 literal refusal sites, including 127 required
dynamic-constructor guards and 3 unused native adapters (byte base64 encode,
byte base64 decode, URL unescape). These are static closure counts, not
executed lexer failures. No statements/structures gap was chased.

Validation:

- Final original ABAP Unit run: IR-JS PASS, including the 44-completion
  teardown; Go PASS. Individual scratch methods: 44/44 PASS on both.
- `node tools/gogen/semantics.mjs`: 190 Go + 190 JS results, all `ok`,
  **0 FAIL**, including the existing refusal suites; exit 0.
- `node --test tools/gogen/unit-js.test.mjs tools/gogen/pilot.test.mjs`:
  **12 pass, 0 fail**. Tests cover lifecycle/failure handling, teardown QUIT,
  compiled mixed numeric and structure assertions and their error messages,
  exact packed comparisons, UTF-8 base64, Unicode cache eviction, and the
  earlier pilot paths.
- Size budget `--changed origin/main`: exit 0. The JS runtime budget increases
  from 1,699 to 1,785 lines with an explicit reason for the tested lexer/unit
  bindings and string memo; two inherited, untouched Go breaches remain.
- Changed-file leak scan: 8 files, 0 matches, exit 0. `git diff --check`: exit 0.

Raw measurements, per-case copies, frontend diagnostics, emitted modules,
binaries and logs remain gitignored under `.local/tsha-lexer/`. The supplied
vanilla Node times are reference measurements, not new median-of-three runs
on this host.
