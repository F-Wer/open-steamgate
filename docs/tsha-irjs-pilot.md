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
- The synchronous CONV_IN_CE / CONV_OUT_CE adapters mirror Go's codepage
  contract. IR-JS bytes are Latin-1 strings, rather than the vanilla runtime's
  hex strings. The PR #708 fix round below pins encoding refusals, BOM
  preservation, invalid-byte replacement, UTF-16 output N and WTF-8 output.
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
The hosts were Node v26.9.0 and Go 1.26.0 on Linux amd64 (the Go 1.22.2
launcher selected the module's newer toolchain); Node used the
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

## Lexer CPU-profile follow-up (2026-10-10)

Starting HEAD: `14bb3080fa87468fc221b7f47b67c5c7d21b9d68`. The abapiti
input stayed read-only. This change touches only the JS runtime and its tests;
it does not change the ABAP lexer, shared IR or either emitter.

The main cost was **numeric text conversion**, not table lookup or string
sectioning. The baseline lexer interval attributes 40.41% inclusive CPU
samples to `ParseI`, 14.82% to `ParseF`, and 9.22% to `CFit`. P and A (mapped
below) repeatedly call these helpers for generated text constants such as
`"0"`, `"1"` and `"-1"`, as well as runtime values. In particular, integer
text previously ran trimming, sign-object allocation, decimal grammar,
zero trimming and rounding logic. `CFit` spread every string into an array,
even when its characters were ordinary UTF-16 units.

Three fixes, applied cumulatively, each measured in three fresh processes:

1. `ParseI`: signed text of 1–10 digits uses `Number`, followed by the same
   signed 32-bit overflow check. Other spellings retain the original parser.
2. `ParseF`: signed text of 1–15 digits uses `Number`; other spellings retain
   the original decimal/exponent parser and its refusals. The digit bounds
   keep these fast paths exact and finite. The expressions require the entire
   string, including rejecting a trailing newline.
3. `CFit`: strings without surrogates use `length`/`slice` and the existing
   blank trimming. Surrogate-containing strings retain the code-point spread
   path, including unpaired surrogates. This is O(n) surrogate classification,
   with O(1) offset selection on flat strings; it is not an O(1) classifier.

| Runtime | Three `lex_us` samples | Median | Incremental change |
|---|---|---:|---:|
| Baseline | 12,737,854; 11,789,074; 11,885,851 | 11,885,851 | — |
| + integer `ParseI` | 7,717,478; 8,399,249; 7,652,336 | 7,717,478 | −35.1% |
| + integer `ParseF` | 6,055,094; 6,164,614; 6,141,370 | 6,141,370 | −20.4% |
| + flat `CFit` | 5,782,144; 6,089,937; 5,771,558 | 5,782,144 | −5.8% |

Overall: **2.06× faster / 51.4% less lexer time**.
The final median is 1.60× the supplied Go median and
17.1× the supplied vanilla Node lexer time. The earlier 14.080 s / 3.625 s / 0.338 s medians remain
reference measurements, not a simultaneous comparison on an idle machine.
All twelve retained benchmark samples returned `X`, 609,647 tokens and lexer hash
`9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40`.
The final original input-assembly path also returned the identical hash,
with `lex_us = 6,229,060`.

For repeated samples, the scratch runner joins the same embedded base64
chunks and decodes them before execution, then supplies the resulting string
before the original timed lexer call. The lexer call, token dump and hash
check are unchanged. The decoded input is 5,185,150 UTF-16 units and its UTF-8
SHA-256 is `aa57853bb7839dd06c946ece94c22c8da1f16cef36e546e3c430be0ce47a2124`.
This avoids minutes of repeated concatenation *outside* the measured interval.
It also changes pre-lexer heap state, so comparisons to the earlier original
assembly medians need that caveat. The retained stages ran sequentially with post-slot IO `avg10 = 0.00`,
available memory about 84 GiB, and one-minute load 4.06–5.47. Each runtime
stage is snapshotted; later
edits cannot change earlier samples. Timing excludes profiling, assembly,
dump and hashing. The host is shared; these are not idle-host distributions.

Profiling used `node --cpu-prof --trace-gc` with the same 16 GB heap and the
requested heavy wrapper. A full original-path profile returned the correct
hash with `lex_us = 12,460,314`. A separate baseline profile marked the lexer
start/end using monotonic microseconds, stopping after the token count to
exclude the subsequent dump/hash. Its lexer interval was 18.656 s; the final
marked profile was 6.720 s. Samples between those markers, rather than the
whole process, produce the following rankings. The original-path call-tree
profile independently found the same leading helpers (ParseI 28.85% self,
ParseF 9.63%, CFit 7.60%); it omits root GC samples, so it is not used for
GC-share estimates. Inclusive totals deduplicate recursive function labels
per sampled stack, and include child helpers. They must not be summed.

Coarse, disjoint self-sample categories:

| Category | Baseline | After 3 fixes | Attribution limit |
|---|---:|---:|---|
| String sectioning/offsets (`Strlen`, `SubS`, `sectionOf`, `flat`, surrogate regex) | 6.65% | 16.05% | Shared surrogate regex also serves final CFit |
| String fitting (`CFit`, trailing-blank regex) | 9.22% | 16.36% | Does not isolate native spread allocation |
| Allocations/GC: sampled collector | 4.33% | 4.32% | Allocation itself is charged to allocating methods/helpers |
| Table/collection operations | 0.83% | 1.74% | Compiled array/set methods plus named table helpers |
| Other: numeric conversions and their regex/sign helpers | 58.62% | 29.52% | Includes f/int8/i range and rounding conversions |
| Other: generated control flow, constructors and remaining helpers | 20.35% | 32.01% | Includes costs that cannot be separated below |
| `b.v` boxes / per-call try-finally / dispatch | Not separately measurable | Not separately measurable | Inlined property reads, allocations and calls are charged to their enclosing functions |

The trace records 457 GC events / 688.91 ms of reported pauses in the baseline
lexer interval (3.69% of wall time), versus 166 / 261.19 ms (3.89%) finally.
The sampled collector fell from 0.808 s to 0.290 s. GC percentages do not show
allocation throughput, retained heap, or all concurrent collector work; this
was a CPU/GC investigation, not a leak or retained-heap profile.

The emitter's `callStmt` still creates output/changing parameter boxes and
emits a `try/finally` even when there is nothing to restore. Its by-value
output parameters have an additional copy-out box. IMPORTING scalar
parameters already pass as plain values; eliminating their boxes is therefore
not an applicable fix. Reference write-back on exceptional return and VALUE
copy-out only on normal return are semantic requirements. Sampling cannot
price an empty finally or a `b.v` access separately from P/A. No unsupported
zero-cost claim is made for them, and they were not changed within this
three-fix limit. Direct virtual calls and constructors remain in P/A's cost.

Baseline top 30 (self and inclusive total; totals overlap):

| # | Function | Self % | Function | Total % |
|---:|---|---:|---|---:|
| 1 | `RT::ParseI` | 26.99 | `(root)` | 100.00 |
| 2 | `P` | 11.84 | `RUN` | 95.34 |
| 3 | `RT::ParseF` | 9.10 | `(anonymous) [native/node]` | 95.34 |
| 4 | `RT::CFit` | 7.64 | `H` | 95.31 |
| 5 | `RegExp: ^(\d+\.?\d*\|\.\d+)$` | 5.66 | `P` | 93.76 |
| 6 | `RT::decimalDigits` | 4.70 | `RT::ParseI` | 40.41 |
| 7 | `RT::sectionOf` | 4.36 | `A` | 27.28 |
| 8 | `(garbage collector)` | 4.33 | `RT::ParseF` | 14.82 |
| 9 | `A` | 3.76 | `RT::decimalDigits` | 10.35 |
| 10 | `RegExp: ^ +\| +$` | 2.84 | `RT::CFit` | 9.22 |
| 11 | `RegExp: ^0+` | 2.28 | `RegExp: ^(\d+\.?\d*\|\.\d+)$` | 5.66 |
| 12 | `RT::numSign` | 1.96 | `RT::sectionOf` | 5.01 |
| 13 | `RegExp:  +$` | 1.59 | `(garbage collector)` | 4.33 |
| 14 | `H` | 1.44 | `RT::Strlen` | 4.21 |
| 15 | `RT::I8ToI` | 1.33 | `RegExp: ^ +\| +$` | 2.84 |
| 16 | `RT::F2I` | 1.19 | `RT::SubS` | 2.44 |
| 17 | `RegExp: ^([^Ee]*)(?:[Ee]([+-]?)(\d+))?$` | 1.07 | `RegExp: ^0+` | 2.28 |
| 18 | `RT::ReplaceStmt` | 0.85 | `RT::numSign` | 1.96 |
| 19 | `SET=>HAS` | 0.79 | `RT::flat` | 1.71 |
| 20 | `RT::Strlen` | 0.79 | `RegExp:  +$` | 1.59 |
| 21 | `RT::SubS` | 0.73 | `RT::I8ToI` | 1.33 |
| 22 | `RegExp: [\uD800-\uDFFF]` | 0.65 | `RT::F2I` | 1.19 |
| 23 | `RegExp: ^ +` | 0.62 | `COUNT` | 1.14 |
| 24 | `RT::Uccp` | 0.60 | `RegExp: ^([^Ee]*)(?:[Ee]([+-]?)(\d+))?$` | 1.07 |
| 25 | `RT::F2I8` | 0.58 | `C506=>CONSTRUCTOR` | 0.94 |
| 26 | `RT::CO.every callback` | 0.33 | `RT::ReplaceStmt` | 0.85 |
| 27 | `RT::check8` | 0.30 | `SET=>HAS` | 0.79 |
| 28 | `RT::CO` | 0.25 | `CB22=>$new` | 0.74 |
| 29 | `RT::ToUpper` | 0.22 | `CB22=>CONSTRUCTOR` | 0.70 |
| 30 | `(program)` | 0.20 | `RegExp: [\uD800-\uDFFF]` | 0.65 |

After three fixes top 30 (self and inclusive total; totals overlap):

| # | Function | Self % | Function | Total % |
|---:|---|---:|---|---:|
| 1 | `P` | 19.89 | `(root)` | 100.00 |
| 2 | `RT::CFit` | 13.51 | `(anonymous) [native/node]` | 95.17 |
| 3 | `RT::sectionOf` | 9.24 | `RUN` | 95.17 |
| 4 | `RT::ParseI` | 8.99 | `H` | 95.14 |
| 5 | `RT::ParseF` | 5.45 | `P` | 93.22 |
| 6 | `RegExp: ^[+-]?\d{1,10}(?![\s\S])` | 5.23 | `A` | 23.84 |
| 7 | `(garbage collector)` | 4.32 | `RT::CFit` | 18.88 |
| 8 | `A` | 3.93 | `RT::ParseI` | 14.23 |
| 9 | `RegExp: [\uD800-\uDFFF]` | 3.43 | `RT::sectionOf` | 10.15 |
| 10 | `RegExp: ^[+-]?\d{1,15}(?![\s\S])` | 2.85 | `RT::Strlen` | 9.08 |
| 11 | `RegExp:  +$` | 2.85 | `RT::ParseF` | 8.31 |
| 12 | `RT::I8ToI` | 2.48 | `RegExp: ^[+-]?\d{1,10}(?![\s\S])` | 5.23 |
| 13 | `RT::F2I` | 2.09 | `RT::SubS` | 4.43 |
| 14 | `RT::ReplaceStmt` | 1.99 | `(garbage collector)` | 4.32 |
| 15 | `SET=>HAS` | 1.71 | `RegExp: [\uD800-\uDFFF]` | 3.43 |
| 16 | `H` | 1.67 | `RT::flat` | 2.99 |
| 17 | `RT::F2I8` | 1.66 | `RegExp: ^[+-]?\d{1,15}(?![\s\S])` | 2.85 |
| 18 | `RT::Strlen` | 1.65 | `RegExp:  +$` | 2.85 |
| 19 | `RT::SubS` | 1.44 | `RT::I8ToI` | 2.48 |
| 20 | `RT::CO.every callback` | 1.01 | `C506=>CONSTRUCTOR` | 2.47 |
| 21 | `RT::CO` | 0.78 | `RT::F2I` | 2.09 |
| 22 | `RT::check8` | 0.76 | `CB22=>$new` | 2.03 |
| 23 | `RT::Uccp` | 0.68 | `CB22=>CONSTRUCTOR` | 2.00 |
| 24 | `RT::ToUpper` | 0.40 | `RT::ReplaceStmt` | 1.99 |
| 25 | `RT::check` | 0.37 | `RT::CO` | 1.79 |
| 26 | `RT::flat` | 0.29 | `SET=>HAS` | 1.71 |
| 27 | `RT::AddI` | 0.27 | `RT::F2I8` | 1.66 |
| 28 | `(program)` | 0.18 | `RT::CO.every callback` | 1.01 |
| 29 | `CB22=>CONSTRUCTOR` | 0.13 | `RT::AddI8` | 0.76 |
| 30 | `C506=>CONSTRUCTOR` | 0.08 | `RT::check8` | 0.76 |

Mapping key (generated JS class/method spellings equal the ABAP class/method spellings):

- `P` = `Z_SRC_ABAP_1_L_22309FB1998E15=>Z_MEMBER_PROCE_57F9D1E4B4E34E`.
- `A` = `Z_SRC_ABAP_1_L_22309FB1998E15=>Z_MEMBER_ADD_51C1BB18694A11`.
- `H` = `Z_HARNESS_STRU_2FF666D6BA45A6=>Z_MEMBER_LEX_C6C26EC28914CA`.
- `RUN` = `ZCL_PHASE3_BENCHMARK=>RUN`.
- `COUNT` = `Z_SRC_ABAP_1_L_CCA5BD2C711D39=>Z_MEMBER_COUNT_AEF1818D79C2BF`.
- `SET=>HAS` = `Z_RUNTIME_SET__44559CF8BCC45E=>HAS`.
- `C506=>CONSTRUCTOR` = `Z_SRC_ABAP_1_L_506101B34E5CC0=>CONSTRUCTOR`.
- `CB22=>CONSTRUCTOR` = `Z_SRC_ABAP_1_L_B22FDB51F8F4F0=>CONSTRUCTOR`.
- `CB22=>$new` is the JS allocation factory for the CB22 ABAP class; it calls its ABAP `CONSTRUCTOR`.
- `RT::name` = `tools/gogen/js/abap.mjs` function `name`; these are host helpers, not ABAP methods. `RT::CO.every callback` is the anonymous predicate inside `CO` (baseline runtime line 371, final line 381).
- `RegExp:` frames belong to the invoking runtime helper: decimal grammar → `decimalDigits`/`ParseI`/`ParseF`; sign/zero/space expressions → numeric parsing; trailing-space expression → `CFit`; surrogate expression → `sectionOf` and, after fix 3, `CFit`; bounded integer expressions → `ParseI`/`ParseF`.
- `(root)`, `(program)`, GC and Node anonymous frames have no ABAP method. RUN invokes H, H invokes P; P invokes A and the string/numeric helpers. A invokes the token constructors and numeric helpers.

Go comparison: a scratch copy of the same emitted Go lexer calls
`pprof.StartCPUProfile` just before the timed lexer and stops profiling just
after it. It also uses the preassembled input and retains the original
hash check. The run returned `X`, the identical hash and `lex_us = 4,145,020`;
this is one **profiled** sample, not a new Go median. Go recorded 4.77 CPU
seconds during 4.15 wall seconds because concurrent GC workers also count.
`ParseI` is 0.78 s / 16.35% inclusive, `ParseF` 1.07 s / 22.43%, `CFit`
0.33 s / 6.92%, `SubS` 0.21 s / 4.40%, `Strlen` 0.36 s / 7.55%, and the
GC background worker 0.72 s / 15.09%. P costs 83.44% inclusive and A 31.45%.
Thus Go also pays for the lowered numeric/string representation; it is not
executing the vanilla TS lexer. CPU-GC percentages are not comparable to JS
wall-pause percentages.

Toolchain correction to the earlier section: the launcher reports
`go version go1.22.2`, but `go version -m` on **both** the prior benchmark
binary and this profile binary reports **go1.26.0** (the generated module's
`go 1.26.0` directive selects it). Node is v26.9.0. Reading the launcher
version alone understated the actual Go toolchain used.

Go top 30 (same ABAP P/A/H/RUN mappings; `funcN` denotes a generated call wrapper in that method, not a separate ABAP method; `osg/gogen/abap.X` corresponds to JS `RT::X`):

| # | Go function | Self % | Go function | Total % |
|---:|---|---:|---|---:|
| 1 | `P` | 6.71% | `P` | 83.44% |
| 2 | `indexbytebody` | 6.29% | `RUN` | 83.44% |
| 3 | `runtime.tryDeferToSpanScan` | 5.87% | `RUN.func1` | 83.44% |
| 4 | `runtime.scanObjectsSmall` | 4.82% | `H` | 83.44% |
| 5 | `osg/gogen/abap.ParseI` | 3.56% | `H.func3` | 83.44% |
| 6 | `strings.ToLower` | 3.56% | `main.main` | 83.44% |
| 7 | `internal/strconv.readFloat` | 3.35% | `runtime.main` | 83.44% |
| 8 | `internal/stringslite.Index` | 2.94% | `A` | 31.45% |
| 9 | `osg/gogen/abap.SubS` | 2.94% | `P.func16` | 28.72% |
| 10 | `A` | 2.73% | `osg/gogen/abap.ParseF` | 22.43% |
| 11 | `osg/gogen/abap.memoOf` | 2.73% | `osg/gogen/abap.ParseI` | 16.35% |
| 12 | `osg/gogen/abap.ParseF` | 2.52% | `runtime.systemstack` | 16.14% |
| 13 | `unicode/utf8.RuneCountInString (inline)` | 2.52% | `runtime.gcBgMarkWorker` | 15.09% |
| 14 | `strings.Trim` | 2.31% | `runtime.gcBgMarkWorker.func2` | 15.09% |
| 15 | `strings.TrimLeft` | 2.31% | `runtime.gcDrain` | 15.09% |
| 16 | `indexbody` | 2.10% | `runtime.scanSpan` | 12.37% |
| 17 | `math.Round (inline)` | 2.10% | `runtime.scanObjectsSmall` | 11.74% |
| 18 | `strings.TrimRight` | 2.10% | `runtime.newobject` | 10.48% |
| 19 | `osg/gogen/abap.Strlen` | 1.89% | `internal/stringslite.IndexByte (inline)` | 9.01% |
| 20 | `internal/bytealg.IndexByteString` | 1.68% | `runtime.gcDrainMarkWorkerDedicated (inline)` | 9.01% |
| 21 | `runtime.mallocgcSmallScanNoHeader` | 1.68% | `runtime.mallocgc` | 9.01% |
| 22 | `osg/gogen/abap.count16` | 1.47% | `strings.IndexByte (inline)` | 9.01% |
| 23 | `runtime.(*mspan).writeHeapBitsSmall` | 1.47% | `P.func15` | 8.39% |
| 24 | `runtime.newobject` | 1.47% | `runtime.mallocgcSmallScanNoHeader` | 7.97% |
| 25 | `osg/gogen/abap.CFit` | 1.26% | `osg/gogen/abap.Strlen` | 7.55% |
| 26 | `internal/strconv.atof64` | 1.05% | `runtime.tryDeferToSpanScan` | 7.55% |
| 27 | `internal/stringslite.IndexByte (inline)` | 1.05% | `osg/gogen/abap.CFit` | 6.92% |
| 28 | `osg/gogen/abap.decimalDigits` | 1.05% | `indexbytebody` | 6.29% |
| 29 | `strings.IndexAny` | 1.05% | `internal/strconv.ParseFloat` | 6.08% |
| 30 | `strings.trimLeftByte (inline)` | 1.05% | `runtime.gcDrainMarkWorkerIdle (inline)` | 6.08% |

No fourth fix was attempted. Plausible next experiments are compile-time
folding of proven numeric text constants, caching/avoiding repeated string
classification, and removing empty call-finally regions without touching
exceptional reference write-back. Those are plans, not measured improvements.
In the final profile the two main parsers together account for 22.54%
inclusive CPU: even magically removing them leaves about 77% of the current
work, around **4.5 s** on the 5.782 s median. That is an illustrative Amdahl
calculation, not a predicted benchmark or a hard floor. Fitting and sectioning
still matter and the large generated P body hides inlined operations.
**About 4–5 s seems a defensible next target; approaching 3.6 s Go is plausible
but unproven.** There is no evidence for reaching 0.338 s vanilla through
runtime-local patches: the final gap is still ~17×, and eliminating parsers
alone leaves ~13×. Reaching that layer would likely require specialization
of the lowered numeric/string/object representation and much less generated
work, beyond this three-fix scope.

Validation: original compiled ABAP Unit PASS; individual lexer cases
**44/44 PASS**, including the original combined test and teardown; focused
unit-js/pilot tests **13 pass, 0 fail**; semantics **190 Go + 190 JS results,
all ok, 0 FAIL**, plus the expected refusal checks, exit 0. A differential
scratch test compares **40,074 numeric outcomes** to the starting runtime,
including error class/message, negative zero, boundaries, whitespace, decimal,
exponent, special values and trailing-newline inputs; Unicode/unpaired-surrogate
and negative/zero-length fitting comparisons also pass. Size budget and
explicit changed-file leak scan exit 0; the same two untouched inherited
size breaches remain. The runtime ceiling increases by exactly 10 lines with
a measured/tested reason. No failing check was removed.

All heavy runs used `GOFLAGS=-buildvcs=false`, the requested Go cache and
RAM scratch, range 50–59, `nice -n10`, and the resource gate. IO and available
memory remained within the requested bounds at recorded launch checks;
load excursions above 12 delayed launches. All retained timing samples and final runs recheck the
limits after obtaining their heavy slot. Preliminary timing logs from the
before-queue-only gate were saved as `prequeue-*` and excluded from this table.
The final stage was also replayed immediately after the gated first two stages;
its earlier gated samples are saved as `earlier-*` and excluded from the table. No unrelated process was signalled.

Reproduction artifacts remain gitignored in `.local/lexer-profile/`:
`run.py`/`gate.py`, baseline and three runtime/module snapshots, three logs
per stage, `baseline.cpuprofile` (original full run),
`lexer-baseline.cpuprofile` (marked lexer), `final.cpuprofile`, GC logs,
`analyze.py`, top-30 summaries, Go `go.cpu`/`go-profile` and self/total
pprof reports, differential script and validation logs. Profiles use:

```sh
node --max-old-space-size=16000 --cpu-prof --cpu-prof-dir=<scratch> \
  --cpu-prof-name=<stage>.cpuprofile --trace-gc \
  tools/gogen/lexer-bench.mjs --execute <scratch-module>
# Prepend the same resource-gated heavy wrapper as above.
go tool pprof -top -nodecount=30 <scratch-go-binary> <scratch>/go.cpu
go tool pprof -top -cum -nodecount=30 <scratch-go-binary> <scratch>/go.cpu
```

The final original assembly/hash replay is recorded in `final-original.log`.
Nothing was pushed; statements and structures remain unmeasured here.


## PR #708 parity fix round (2026-10-10)

The last critic verdict identified five runtime/host mismatches and the stale
IR-JS growth policy. The fixes preserve Go as the contract:

- Decoding accepts only Go's encoding labels. Odd UTF-16 lengths and unpaired
  surrogates always refuse with `NOT_COMPILED`, including with ignored errors.
  Ignored invalid UTF-8 replaces each contiguous invalid-byte run once; the
  ISO-8859-1 adapter uses Go's Windows-1252 control table, including its undefined
  entries. BOMs are retained.
- Output N slices UTF-16 units, including half a supplementary character.
  UTF-8 output retains lone surrogates as WTF-8; negative N retains the full
  input as Go's `SubS` does. Out-of-range N raises the same range error.
- Generic comparisons cover fixed-byte right padding, xstring prefix ordering,
  uppercase hex against text, signed last-four/last-eight-byte numeric conversion,
  exact NUMC comparison, and data-reference target equality. Binding address
  identities survive repeated `GET REFERENCE`, component/row bindings and
  structure copies containing references.
- Every unit lifecycle phase distinguishes `NOT_COMPILED` from `FAILED`.
  Teardown keeps an earlier setup/test error; class teardown replaces the status
  as Go does. Refusals print separately and return exit 2; failures return exit 1.
- Assertion dumps normalize initial dates, times and NUMC to their width's zeros.
  The README records Alice's decision to grow IR-JS for TS-HA layer by layer,
  matching Go's semantics and refusals.

`tools/gogen/parity.test.mjs` has one regression per runtime/host finding.
All five failed against `4309d5f96` before the fixes. Four compare values and
error messages directly with `go/abap`; the lifecycle regression runs the actual
JS host with an in-memory compiled class, exercising ordinary failures and
refusals in all five phases and simultaneous test/teardown errors. An additional
compiled fixture triggers `FIND` with `OCC = 0` in each lifecycle phase and
compares both real unit hosts' statuses and refusal exit codes. The new
`REFCMP` semantics fixture checks initial references, repeated addresses,
different equal-valued targets, reference assignment and references in copied
structures through both emitters. These are Go-contract regressions, not new
A4H measurements. The prior Buffer replacement expectation was corrected to
Go's WTF-8 contract; no failing check was skipped.

Reproduce with the same resource-gated heavy wrapper above:

```sh
node --test tools/gogen/parity.test.mjs tools/gogen/unit-js.test.mjs tools/gogen/pilot.test.mjs
node tools/gogen/semantics.mjs
```

Logs, the pre-fix failures and fresh lexer replay artifacts remain gitignored
under `.local/irjs-fix/`. The runtime size allowance grows by 29 lines for the
ported comparison/address/dump rules and their regression coverage; the emitter
stays within its existing allowance. Nothing is pushed.

Final verification: focused tests **19 pass, 0 fail**; semantics **191 Go +
191 JS outcomes, all ok, 0 FAIL**, including the existing refusal suites;
individual lexer cases **44/44 on both hosts**, plus the original combined
case and its completion teardown. Three fresh-process zabapgit samples per
host all return `X`, **609,647 tokens**, and the unchanged SHA-256
`9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40`.
Size budget (`--changed origin/main`) and the explicit changed-file leak scan
exit 0; the same two untouched inherited size breaches remain. All heavy
commands used the requested cache, RAM scratch, range 50-59 and `nice -n10`.
The post-slot resource gates recorded IO `some avg10` 0.00-0.18, available
memory above 81 GB and load below 8.1. No unrelated process was signalled.


### PR #708, fix round 2: reference identity refusal

IR-JS refuses data-reference comparisons with `NOT_COMPILED` and the reason
`data reference identity is not modelled in IR-JS`. Generic comparisons,
including references nested in structures or table rows, use this refusal.
Object-reference equality and byte comparisons retain their existing behavior.
The access-path and table-index address machinery from round 1 is removed:
parameter aliases, shifted rows and reused indices cannot supply stable identity.

The `REFCMP` semantics fixture retains Go's `11011` result and records the
expected JS-only refusal. Focused regressions cover forwarded component aliases,
row deletion shifting a retained row, and deletion followed by index reuse,
with equality, inequality and ordered generic comparisons.
