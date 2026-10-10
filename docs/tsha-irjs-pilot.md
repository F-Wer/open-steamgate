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
