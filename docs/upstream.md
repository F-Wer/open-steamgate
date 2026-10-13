# What goes upstream, and how

> **2026-09-17, 06:41–06:49:** Lars merged #1862 (compare), #1864 (rounding)
> and #1867 (APPEND) within the morning; #1863 (MOD) is still open, #1866
> (integer division) unanswered, abaplint/abaplint#4302 open. The npm
> runtime is still 2.13.87; when the next release carries the three, the
> pinned `local/osd-build` loses three of its commits and the preview pin
> moves to a published version plus what remains (core pin, MOD).


The transpiler and the runtime this tree builds with are a local build of
`~/dev/transpiler` (branch `local/osd-build`), which is `@abaplint/transpiler`
plus fixes that are not released yet. Every one of those fixes has an entry
in `ANORMALIES.md` and a branch in that clone, and `npm run parked` prints the
two side by side and complains where they disagree. This is the dossier for
sending them: what each is, what proves it, where the fix lives, and what to
do next. Snapshot of 2026-09-16; `npm run parked` is the live version.

## The procedure, once per fix

1. `git fetch origin` in `~/dev/transpiler`, and move `main` to `origin/main`
   — the parked report compares branches with the local `main`, and today
   that is nine commits behind, so it shows upstream's own commits as if they
   were ours.
2. A branch **inside `abaplint/transpiler`**, never a fork: the regression
   workflow fires on a push to a branch there and not on a pull request from
   a fork (CLAUDE.md, the rule read off the workflows). After pushing, check
   that **Regression** is in the checks, not only **CI**.
3. In that repository's own clone, with nothing uncommitted, run its lint and
   the package's tests before the PR. An em dash in an ABAP comment failed the
   lint once; the prose style used everywhere else here is what breaks it.
4. One small PR per fix, the ANORMALIES entry as the description's source:
   reproducer, expected, actual, where. Lars merges; nothing of ours is
   merged by us there.
5. When it lands: the entry's status becomes `fixed upstream: #NNNN`, and
   when a release carries it, the version line says which. When every entry
   the link exists for says so, `npm run transpiler:published` drops the link.

## Already upstream — update the record, wait for a release

| entry | branch | upstream | in a release? |
| --- | --- | --- | --- |
| `ANOMALY-2026-09-14-float-separator-not-inverse` | `fix/float-separator` | #1847 merged | 2.13.87 |
| `ANOMALY-2026-09-13-paren-before-conv` | `fix/rearranger-constructor-operand` | #1843 merged | 2.13.87 |
| `ANOMALY-2026-09-13-conv-second-in-expression` | `fix/conv-builtin-type-name` | #1842 merged | after 2.13.87 |
| `ANOMALY-2026-09-13-sy-tabix-not-restored` | `fix/sy-tabix-restore` | #1848 merged | after 2.13.87 |
| `ANOMALY-2026-09-14-sy-tabix-hashed` | `fix/sy-tabix-restore` | #1848 merged | after 2.13.87 |

Their statuses in `ANORMALIES.md` were updated with this document. The
branches can be deleted once `main` is moved; `parked` will then stop listing
them.

## Local only — ready to send, in this order

Checked against GitHub on 2026-09-24. What stood here as items 1 to 5 has gone
out and is merged: `fix/w3mi-objid` (abaplint/transpiler#1846),
`fix/percent-in-filename` (#1844), `fix/compare-character-literal` (#1862),
`fix/binary-file-copy` (#1845), and the two builtin anomalies of
`fix/builtin-not-a-method`, which went away upstream in 2.13.88 without our
branch. What is left:

6. **`fix/sy-tabix-restore`, the remaining commit** — "Take the
   class-constructor timing out of …", `ANOMALY-2026-09-14-class-constructor-eager`.
   #1848 took the sy-tabix half. The issue is filed
   (abaplint/transpiler#1849); the commit is still local. Rebase the branch
   on `origin/main`, and it is one commit to offer against #1849.

7. **express-icf-shim: a posted form has no form fields** —
   `ANOMALY-2026-09-19-posted-form-has-no-fields`. `cl_express_icf_shim`
   fills the request's form fields from the query string alone, so a handler
   behind `<form method="post">` reads every field as empty and behaves as
   though nobody typed anything. No branch yet, and no issue yet. The fix is
   small and belongs where the request is assembled: when the method carries
   a body and the content type is `application/x-www-form-urlencoded`, parse
   it into the same fields — and decode `+` as a space, which
   `cl_http_utility=>string_to_fields` does not do (it decodes with
   `decodeURIComponent`). The interface already names the body as a source:
   `get_form_fields_cs` takes `search_option DEFAULT
   co_body_before_query_string`. Workaround here:
   `src/webgui/zcl_osd_form`, with `test/unit/zcl_osd_form_test`, whose last
   test asserts the **gap** so the workaround has an expiry.

8. **express-icf-shim: one static server for every request** —
   `ANOMALY-2026-10-02-icf-shim-static-server`. `cl_express_icf_shim=>run`
   hangs each request's `request` and `response` entities on
   `CLASS-DATA mi_server`, so a handler that is still running when another
   `run` starts -- here, one in a WAIT, which gives the work process up --
   resumes on the other request's entities, and the shim answers its caller
   with the other request's response. No branch and no issue yet. The fix
   is small: a local `DATA li_server TYPE REF TO if_http_server` in `run`,
   created per call and passed to `request` and `response` as a parameter
   (both are private, so nothing outside changes). Workaround here: the
   WAIT's roll-out and roll-in in `tools/osd-dialog-step.mjs` save and
   restore the static server and its two entities; `test/dialog-step-icf.mjs`
   fails without it. When the fix is in the pinned shim, the roll-out's
   shim half goes and the test stays.

9. **`get-run-time-wrap`: GET RUN TIME does not wrap at 2^31** --
   `ANOMALY-2026-10-10-get-run-time-wrap`. Measured on an ABAP 7.5x system:
   the kernel returns non-negative elapsed microseconds that wrap at `2^31`
   (minute 35 `2100029253`, minute 36 `12546088`, then `72546692`). The
   runtime assigns the unwrapped count, and `Integer.set` does not
   range-check, so a `TYPE i` field holds an out-of-range value after about
   35.8 minutes. The fix keeps `context.runTime.last` unwrapped for the
   backward-clock clamp and wraps only at assignment
   (`packages/runtime/src/statements/get_run_time.ts`); two fake-clock tests
   (`performance.now` and `Date.now`) fail without it. Sent as
   abaplint/transpiler#1990; next: record the containing release.

## What we carry, and what we wait for

*Decided 2026-09-17, after the performance work made the question real.*

Divergence from the published packages comes in two kinds, and they are held
oppositely.

**A defect fix is carried.** Without it this tree computes a different answer
from a system, and the oracle says so every time the demo runs. So it lives on
`local/osd-build`, pinned by commit in the preview workflow, with an entry in
`ANORMALIES.md` and a DEBT entry saying the tree is built by something that is
not published. `npm run parked` complains in both directions, and
`npm run transpiler:published` drops the link when a release carries
everything. That machinery exists and works; nothing changes here.

**A performance change is not carried.** It is sent, and it arrives when a
release carries it. Four reasons, in order of weight:

1. **Nothing is broken while we wait.** The only cost of waiting is speed, and
   speed that nobody else can reproduce is not worth a fork.
2. **A patch that lives only here makes our numbers untrue for everyone else.**
   The whole value of this work is that a maintainer can check it. "Fast here"
   would say nothing about what someone who installs the package gets, and the
   demo's frame rate would stop being evidence about anything but us.
3. **Every pin is a standing tax**: rebase it, re-measure it and re-pin it on
   each release, forever, and the public deployment becomes a build nobody can
   reproduce. We already pay this for the defect fixes, which is enough.
4. **It buys no correctness.** A performance change that alters one frame is
   wrong by definition, so carrying it cannot protect the oracle — the thing
   the defect pins exist to protect.

**The exception, and it is the shape to aim for: a flag.** The code-generation
work is built behind a feature flag defaulted off (`feature_flags.ts` in the
transpiler, an empty mechanism waiting for its first user). Once that is
released, turning it on here is a setting, not a fork: upstream owns the code,
we own the choice, and it leaves our accounting entirely. Anything upstream is
willing to offer as a flag should be taken as a flag rather than as a patch.

**Why this was written down.** The critic pass on 2026-09-17 found that the
build the performance numbers were measured on had been described as "2.13.87
plus the three merged fixes" when it was in fact a local branch carrying a
fourth, unmerged one, and the baseline was not `main` either. The files on the
hot path turned out to be identical, so the measurements held, but the
description did not — and that is the ordinary failure mode of a carried
patch. The more we carry, the less any sentence about "the build" means.

So each item in the queue below says which kind it is, and the performance ones
say **wait for a release**.

## The performance track, in sending order

*Opened 2026-09-17 after `docs/demo-profile.md` and `docs/abap-hot-code.md`.*

These are not defects and they have no `ANORMALIES.md` entry, because
nothing here computes a different answer from a real kernel — the answers
are right and they are slow. `npm run parked` therefore does not claim
these branches, so **this section is their only record**, and each branch
carries its reason in `git branch --edit-description`, which is the rule
for a branch that is not a defect fix.

What they are all about: an ABAP arithmetic operation costs about 30 ns
here and about 1 ns in plain JavaScript, and one frame of the demo's
`sdf_blobs` performs 1.97 million of them. The cost is the protocol around
the operation — dispatch on the operand types, parse each operand, allocate
the result — and not the arithmetic. Seven of twenty-six demo scenes miss
their frame budget because of it.

**The order below is by gain against risk, and it is deliberately not the
order somebody would guess.** Each item goes as one issue with the
measurement, then one pull request with one commit, one test and one number,
through the critic gate (CLAUDE.md).

| # | what | where | gain, measured | state |
| --- | --- | --- | --- | --- |
| 0 | the anchor issue: the arithmetic protocol dominates compute-bound ABAP, with the profile and the ranked list | an issue only, `abaplint/transpiler` | — | to write |
| 1 | a constant `Character` remembers the number it parses to | runtime, `types/character.ts` + `operators/_parse.ts` | -35 to -77 % on the operation, below the measurement threshold on the demo | **sent 2026-09-18: issue #1872, PR #1873**, branch `perf/character-constant-numeric` 40cab17c — see below |
| 2 | a `Float`/`Float` branch in `add`/`minus`/`multiply` | runtime, `operators/` | -4 to -13 % of a heavy frame's CPU | **sent 2026-09-17: issue #1868, PR #1869**, branch `perf/float-fast-path` 111d6a93 |
| 3 | plain JavaScript arithmetic when the operand types are proven | transpiler, `expressions/source.ts` + a new type walk, behind a feature flag | 110-200 ns to about 1 | in progress |
| 4 | a synchronous `LOOP AT` when the body contains no `await` | runtime + codegen | 172–349 ns a row to 74 | design question, unwritten |
| 5 | method inlining | transpiler | 123 ns to 67, and 206 to 67 for a structure return | unwritten, high risk |

## A candidate for abaplint, not yet drafted: the AMDP body comes out four times

Found 2026-09-18 while building the AMDP scissors (`docs/amdp-in-hana.md`),
researched against abaplint's own source rather than guessed at.

**The observation.** A class with one AMDP method whose body is twenty lines
yields **four** `NativeSQL` statements, three of them starting on the same
row and nesting inside one another:

```
1  rows 31-46   DECLARE lv_i INTEGER; ...
2  rows 47-47   SELECT lv_i AS id,
3  rows 31-47   DECLARE lv_i INTEGER; ...
4  rows 31-50   DECLARE lv_i INTEGER; ...
```

Concatenating their tokens does not reproduce the source, and neither does
taking the longest: the concatenation drops the original line breaks, and
SQLScript has `--` line comments, so a lost newline changes what is
commented out.

**Why, from the source.** `3_structures/structures/method.ts` says a method
body is `opt(alt(sub(Body), star(sta(NativeSQL))))`. `NativeSQL` is a marker
whose matcher deliberately throws — it is assigned out of band, by
`statement_parser.ts`'s `nativeSQL()` pass, which runs **after**
`lazyUnknown()`. That second pass is an editor-typing recovery heuristic: for
a statement that failed to categorise, it tries every row boundary as a split
point and keeps the first suffix that categorises as something. Neither pass
promises the statements it emits are non-overlapping or exhaustive. So the
AMDP path is not a dedicated extraction mechanism; it is two general-purpose
salvage heuristics meeting.

**The proposal, if it is sent**: make an AMDP body become exactly **one**
`NativeSQL` statement covering the whole span, carved out before
`lazyUnknown` can touch it — which is what `star(sta(NativeSQL))` already
implies in practice, and which makes the built-in path give what every
consumer is otherwise forced to compute from source positions by hand. Ask
in the same breath whether `EXEC SQL ... ENDEXEC` has the same shape, since
`nativeSQL()` handles both.

**It is not a rediscovery.** The three related issues — #743, #1777 and the
still-open #3486 — are all about making the *linter* stop complaining about
AMDP bodies. None is about a consumer needing the verbatim body or a
non-overlapping statement list.

**What is not proven.** The mechanism-level explanation is solid; the exact
step-by-step reconstruction of those four ranges is not, because it was read
rather than traced with an instrumented run. An issue should state the
observation and let the maintainer pick the fix, rather than assert the
internal cause.

Unsent, undrafted, and it goes through the critic like everything else.

Notes that belong with them, so they are not rediscovered:

**Item 1, re-measured against 2.13.89 and sent, 2026-09-18** (issue #1872,
PR #1873; the calculation-type issue that came out of the same work is #1871,
and the A4H measurement behind it is a comment on #1866).** The
branch was held because its numbers were taken against a base that has since
moved; it was rebased (`a284eb2f` -> `40cab17c`, onto `2f011157` = 2.13.89,
which already carries the Float/Float fast path of #1869) and measured again.
Host: i7-10700K, node 26, `intel_pstate` on `powersave` — which boosts itself,
4.9 GHz measured under load, so no governor change was needed. Protocol: the
12 cases of `.local/measure/drafts/bench-operators.mjs`, 2 runtimes, 5 sweeps
interleaved with the column order reversed on alternate sweeps. Both builds
were verified **by content**, not by the build exiting 0: `getNumeric` absent
from the base's built `character.js` and present in the branch's, and the
float fast path present in the base's `add.js`. The first build of the branch
was a false green — `tsc` returned 0 and left yesterday's `build/` in place.

| operation | base 2.13.89 | + cache | delta | five sweeps |
| --- | ---: | ---: | ---: | --- |
| `divide(const '0.5', Float)` | 97.32 ns | 22.37 ns | **-77.0 %** | -77.0 -76.3 -76.8 -77.6 -76.6 |
| `multiply(const '0.5', Float)` | 148.48 ns | 75.71 ns | **-49.0 %** | -49.3 -50.0 -48.0 -49.0 -49.1 |
| `add(const '0.5', Float)` | 170.49 ns | 99.60 ns | **-41.6 %** | -41.9 -42.0 -41.6 -40.8 -41.9 |
| `multiply(Float, const '0.5')` | 224.05 ns | 144.90 ns | **-35.3 %** | -35.0 -36.3 -34.8 -35.7 -34.7 |
| `multiply(Character '0.5', Float)`, not a constant | 149.17 ns | 128.84 ns | -13.6 % | -13.4 -14.2 -13.0 -14.0 -15.0 |
| `Float`/`Float` and `Integer`/`Integer` | 9-21 ns | unchanged | -4.0 to +2.9 % | noise |

The absolute nanoseconds are about twice those in
`.local/measure/drafts/measurement.txt` because that table was taken on the
workstation; ratios within one machine are what compare.

**The verdict, and the wording matters.** Per operation the win is large and
reproducible — a spread of fractions of a percent across five sweeps, against
a harness whose own noise is about 10 %. At whole-program level the
contribution is **below our measurement threshold**, which is not the same
claim as "a few percent": the `both/fast` column of `measurement.txt` cannot
carry that claim, because it measured the *head* placement that was rejected
(its own first line says the shape "is NOT on the branch") and because its
per-round CPU wanders 5890-9890 ms on one scene while the signs disagree
between scenes. `docs/abap-hot-code.md` already states the rule: no absolute
number here may be quoted finer than half a significant figure.

It was parked under Alice's rule of that morning — pure performance without a
roughly twofold win waits, only defect fixes go up — and then **unparked by
her the same day**: "гони в апстрим то что готово и что улучшит
производительность и радость". So it goes, through the critic gate. The
argument that supports sending it, which was recorded while it was still the
counter-argument:
**ABAP 7.02 has no float literal**, so `lv_x = lv_y * '0.5'` is how real code
writes any percentage or rounding, while the author of our demo scenes hoisted
those constants into `DATA` by hand — exactly what the cache makes
unnecessary. Our corpus therefore *understates* the share of constant-literal
arithmetic. It stays weak as an argument because real business ABAP is bound
by the database, not by arithmetic; the niche is compute-bound code.



**What measuring changed about items 1 and 2, 2026-09-17.** Both were
written, tested and measured before either was sent, and both moved:

- The fast path went **under** the integer branch, not at the head of it,
  and `divide` was left alone. At the head it is worth more on the demo
  (-13.9 % against -13.3 % on `sdf_blobs`, -19.2 against -9.8 on
  `quat_julia`) and it takes integer division from 10.4 ns to 16.4, three
  runs running, which is more than two `instanceof` can explain and looks
  like an inlining threshold. A change that speeds up floats by slowing
  integer division is not one to offer, so the branch carries the
  placement that regresses nothing, and the issue puts both columns in
  front of Lars, whose weighting of integer division is not ours to
  assume.
- Item 1 is large per operation (a constant literal operand costs 45 %
  less) and **invisible on the demo, inside the noise**. The draft says so
  rather than hiding it. The reason is the more interesting finding: the
  operators convert a character operand with
  `Number.isInteger(Number(left.get()))` before they ever reach `parse()`,
  so the cache removes the second conversion of two.
- Found while measuring, not implemented and **not yet measured on a
  system**: the calculation type of `lv_i * '2'` depends on which side the
  literal is on (`Integer` on the left, `Float` on the right, and `minus`
  the same), and `divide` has no character branch at all. Until it is
  measured on A4H it is a candidate in an issue and not an anomaly,
  because this project measures a discrepancy before it claims one.

- **Item 1 and item 3 overlap on purpose.** Folding `'0.5'` in code
  generation makes it disappear; caching it in the runtime makes it cheap
  for every caller that the code generator cannot prove. Both are worth
  having, and item 1 is five lines against a project.
- **Item 3's admission rule is the whole safety argument**: every operand
  a `Float`, an `Integer` or a numeric literal, and at least one proven
  `Float`. One proven float means the calculation-type flag can never
  produce an `Integer` result, which is what makes the rest fall away.
  Packed, `decfloat34`, `int8`, hex, date, time and character variables
  are refused.
- **`Integer.set(number)` and `Integer.set(Float)` are equivalent**, both
  through `roundHalfAwayFromZero`, and the integer overflow check below
  them is commented out. Read in the source, 2026-09-17. That is what makes
  handing `.set()` a raw number safe, and it is the fact item 3 rests on.
- **What is deliberately not in this list**, so that nobody proposes it
  again: a lookup table for a function over a proven range, and any
  "fast maths" library. Measured, not argued — `sin( )` is 19 ns and a
  `READ TABLE INDEX` lookup is 71, so a table is four times slower than the
  function it would replace, and no table equals `Math.sin` at the sampled
  points, which breaks the frame comparison against a real system. For the
  same reason, hand-expanding `**` into multiplications is a pessimisation:
  `** 8` is 44 ns and three multiplies are 83.
- **The demo's own ABAP is not part of this stream.** Rewriting three
  scenes by the same rules took 28 to 38 % off a frame with every frame
  identical, which measures the ceiling a compiler could reach on its own.
  It is a measurement, not a patch to send (Alice, 2026-09-17).

**What went out first, and why only that** (2026-09-17). Item 2 alone, as
issue [#1868](https://github.com/abaplint/transpiler/issues/1868) and PR
[#1869](https://github.com/abaplint/transpiler/pull/1869), from a branch
inside the repository so **Regression** runs — confirmed in the checks, beside
build and transpiler, which is the thing a fork's branch never gets. Five
drafts were ready and four were held on purpose: a spare-time maintainer given
five items in one evening answers none of them, and item 2's issue ends on a
question (which placement of the branch he wants) whose answer changes what
the rest should say. Also ready and waiting: an issue for the packed
calculation type with the A4H measurement, and a comment giving #1866 the
measurement it has never had.

Every item's evidence is `docs/demo-profile.md` (where the time goes) and
`docs/abap-hot-code.md` (what each idiom costs, and what the code generator
would have to know). The oracle — `tools/o4d-record.mjs --compare` against a
recording made with the unmodified transpiler — is the acceptance test for
all of them: a performance change that alters one frame is wrong.

## Not for sending

- `fix/conv-builtin-type` — superseded 2026-09-14, split into the branches
  above. Delete.
- `fix/silent-zero-output` — a new failure mode with false positives on
  existing tests; parked on purpose, not a PR.
- `docs/client-handling` — merged upstream as #1850 already. Delete.

## Beside the transpiler

- **`open-abap-gui`, one PR owed (2026-09-18)**: fork branch
  `html-viewer-sapevent` on `oisee/open-abap-gui`, two commits, lint and
  the 496 unit tests of that repository green, the browser spec of the
  HTML viewer example (`zcl_gg_ex_151`) green. The first commit is the
  inbound half of `sapevent` — `cl_gui_html_viewer=>dispatch_sapevent`,
  the raise, the `CNHT` type pool, the rewrite of a document's own
  `<form action="sapevent:X">` and `formaction`, the classic exceptions on
  `load_data` / `show_url` / `set_registered_events` / `set_focus` — with
  five unit tests on the round trip; the second is
  `ANOMALY-2026-09-18-html-viewer-show-url`, `show_url` of what
  `load_data` loaded. The PR would say: nothing raised `sapevent` on the
  viewer, so a handler registered on it could never fire; the scaffold
  host folds the click into its own dispatch, which is not the SAP
  contract abapGit is written against; the shape of `postdata` was
  measured against that consumer (`zcl_abapgit_gui_event`, 256-character
  lines joined respecting blanks, only the pair delimiters escaped). The
  one number nobody has measured on a frontend is the line width SAP GUI
  itself fills; it is one constant. Critic pass before sending, as for
  the rest. Self-merging there is not agreed; it is Lars's to merge.
- **`open-abap-core`, a two-line fix owed and no branch yet (2026-09-18)**:
  `ANOMALY-2026-09-18-system-uuid-window`. `cl_system_uuid`'s private
  `RANDOM` falls back to `rv_str = window.crypto.randomUUID();` when the
  imported `crypto` has no `randomUUID`, which is what webpack's
  `crypto-browserify` polyfill is, and a service worker has no `window` —
  so every `create_uuid_*` throws in the browser deployment. Read off
  `build/preview/sw.js` rather than reasoned about. The same line also
  assigns the JavaScript variable instead of calling `set( )` on it, so a
  plain page, where `window` exists, hands a raw string back where the
  caller's type is a `String`. The fix is `globalThis.crypto` and
  `rv_str.set(…)`. Not written yet because `oisee` has no write access to
  `open-abap-core` and it takes a fork (the exception the tree already
  documents); the workaround is local
  (`zcl_osd_tran_session=>new_id( )`), so nothing is blocked. Critic pass
  before sending, as for the rest.
- **`@abaplint/core`**: one owed, and it is not a table edit.
  `ANOMALY-2026-09-16-numeric-builtins-typed-integer` — `frac`, `abs`,
  `floor`, `ceil`, `trunc` and `sign` are declared with a fixed integer
  return type, and ABAP gives them the type of their argument. It is the
  last three of sixty differing frames of the demo. The return type has to
  come from the argument where the call is typed
  (`expressions/method_call_chain.ts`). Issue abaplint/abaplint#4302, filed
  2026-09-17 with the A4H measurement; the three syntax tests (`frac( f )`
  typed `f`, `abs( f )` typed `f`, `frac( i )` still `i`) sit on
  `fix/numeric-builtins-argument-type` in the fork worktree, without a fix.
  A fork PR when the fix is written.
- **`@abaplint/runtime`, two more, found by probing around it and measured
  on A4H 2026-09-17**: `ANOMALY-2026-09-16-mod-result-integer` (`MOD`
  with a float operand returns an integer; a system says 0.75) is #1860 and
  `ANOMALY-2026-09-16-integer-rounds-negative-half-to-zero` (`-0.5` to `i`
  is 0, `Math.round`; a system says −1) is #1861. Both fixed on a branch
  (`fix/mod-float-result`, `fix/integer-round-half-away`), one commit each
  with the test, runtime tests and lint green; **PRs #1863 and #1864**,
  2026-09-17, from inside the repository.
- **`@abaplint/runtime`, from the plasma scene (2026-09-17)**:
  `ANOMALY-2026-09-17-append-number-rounded` — `APPEND sin( x ) TO` a
  float table rounds every value to an integer, because `cloneRow` wraps
  a raw number as an `Integer` first. Branch `fix/append-number-float`, one commit with a
  test (`packages/runtime/test/statements/append_number.ts`), runtime
  tests and lint green; issue #1865 and **PR #1867**, 2026-09-17, after
  the critic pass Alice asked for. Cherry-picked onto `local/osd-build`.
- **`@abaplint/core`, from the mountains scene (2026-09-17)**:
  `ANOMALY-2026-09-17-character-literal-calc-type` — already fixed
  upstream by #4293 in 2.120.52; the pin was behind. `local/osd-build`
  now takes `^2.120.54` (c148d363), and the transpiler entry in
  `libs.lock.json` has to move with it. Nothing to send.
- **`@abaplint/transpiler`, from the last seven plasma frames (2026-09-17)**:
  `ANOMALY-2026-09-17-integer-division-not-rounded` — in calculation type
  `i` a system rounds every `/` to an integer before the next operation
  (`7 / 2 + 7 / 2` is 8 there, 7 here; measured on A4H). The fix needs
  the statement's calculation type, so it is the transpiler's, not the
  runtime's: put to Lars as issue #1866 with the six measured lines,
  2026-09-17. Not started.
- **How these were found**: `docs/frame-comparison.md`, the demo as an
  oracle, scene by scene.
- **The order was test, issue, fix (Alice, 2026-09-17):** the reproducers
  went first, with the A4H measurement, so the issue could say what a
  system answers; the fixes followed the same day for the two runtime
  ones. The core one (#4302) is still test-only: its fix is not a table
  edit and belongs in the syntax pass.
- **Alice's own repositories, through the packs** (`packs/*/README.md`
  says what each overlay changes): `oisee/vivid-vibes`, one line in
  `zcl_o4d_http_handler` — the megademo page asks `?image=<name>` and the
  handler serves `?img=<NAME>.PNG`, so no picture loads at the pinned
  commit. `oisee/zork-abap` needs nothing: the pack runs its HEAD as is
  (an earlier pack carried five classes from an older commit, which is why
  it looked patched). A PR to vivid-vibes once the line is reviewed; until
  then the overlay is the diff.
- **Filed as issues rather than fixed (Alice, 2026-09-17): "можно пока не
  фиксить … а пока сделать тест и завести как issue."** The tests are the
  measured contract; a fix that passes them is the PR.
- **open-abap-core**: `W3MIMETABTYPE` (#1218) and `get_source_position`
  (#1219) are merged; `SCMS_BINARY_TO_XSTRING` and the `WWWDATA_IMPORT` walk
  are in `.local/lars/open-abap-core` and still to send — a fork there, since
  `oisee` has no write access (CLAUDE.md).
- **Bun** (`oven-sh/bun`): the resolver takes a percent-encoded relative
  specifier literally (`ANOMALY-2026-09-13-bun-percent-encoded-specifier`).
  Worked around in `bin/osd.mjs`; transpiler #1841 would remove the need.
  An issue upstream is worth filing with the two-file reproducer from
  `docs/bun-spike.md` part one.
- **Node**: nothing to send. A single executable could not import a file
  outside itself on 26.3 and can on 26.9 (`docs/bun-spike.md` part four).

## The HANA line, 2026-09-19

Sent in one afternoon, in the order they block each other, and every one of
them went through the critic gate first.

- **transpiler #1877** — `execute()` never opened the LUW on the HANA client.
  `connect()` turns autocommit off, `inTransaction` is set only by the
  modifying path, and `commit()` returns at its first line while it is false,
  so `disconnect()`'s documented implicit commit never happened. One file,
  eight lines. **Before any release of `database-hdb`**: a release without it
  ships silent data loss to anyone with two connections. Invisible on one,
  including in upstream's own `test/_utils.ts:97-99`.
- **open-abap-core #1254** — the three-backend report. 819 test methods:
  SQLite 819/0/0, DuckDB 816/3/0, HANA 815/3/1. Declines separated from
  failures. The one red is diagnosed and it is theirs: `get_location` takes
  the stack frame after the last `cl_abap_unit_assert`, and on HANA the
  awaits reach the event loop, so V8 drops the async user frame and the test
  sees the tick queue. Logs at `.local/hana-report/run-{sqlite,duckdb,hana}.log`
  — keep them, the next session must not re-derive the table.
- **transpiler #1878** — a question, not a PR: `execute()` returns `void`, so
  a procedure's rows have nowhere to go, and nothing in the interface binds a
  parameter. ADBC in open-abap-core is the same gap in their own ecosystem
  (`set_param`, `execute_procedure` are `ASSERT 1 = 'not supported'`). Four
  options for where AMDP support could live; B (the seam only) is the one
  answerable without any AMDP opinion.

**What the critic caught, because the value of the gate is in the misses.**
Two drafts, ten must-fixes between them, and the four that mattered were all
the same kind — a claim I believed because I had not gone to look:

1. "there is no native channel" — `execute()` is one, and our own
   `docs/db-seam-native.md` already said so
2. "the parse is already there, only the emit is missing" — written for a
   repository whose sister tracker holds **our own** open issue saying the
   parse loses colons (abaplint#4307, PR #4312)
3. "one file different between the three runs" — the generated runner was
   patched too, and Lars would have diffed it in ten seconds
4. the one red reported as having no cause — the critic reproduced and
   diagnosed it in five minutes

And one number was cut for being second-hand: a colleague's measurement of
our own suite, which neither the author nor the critic had run. Unverifiable
and about us, not about them.

## Local int8 byte conversion fix (2026-10-03)

`ANOMALY-2026-10-03-int8-hex-conversion` is fixed on
`fix/int8-hex-conversion` in `.local/transpiler`, based on its `main`.
The runtime keeps the low bytes of an int8 assigned to x, zero-pads long
byte targets on the left, decodes the last eight source bytes signed and
converts i/int8 to xstring using the measured source width and minimal-byte
rules. Fixed-length i byte conversions already match and remain unchanged.
The upstream runtime tests include both Hex implementations; OSG's two
oracle classes run through `test/osgjs-int8.mjs`, pending until the pinned
runtime carries the fix (`OSD_INT8_UPSTREAM=1` verifies a local build).
The unsent issue/PR draft is `.local/jsint8-upstream.md`. Nothing is pushed
or sent as part of this task.

Proof: upstream 192 runtime passes (154 new; red proof 119 pass / 35 fail),
99 affected ABAP passes / 4 existing pending, lint; OSG int8 10/10 and all
26 supplied xstring conversion methods. The additional comparison methods
in inbox 007 still fail 5/7; those operators are outside this fix. Validation
uses core 2.120.64 because 2.120.65 changes a CREATE DATA operand node.
The OSG proof used a disposable dependency copy; the original shared local
2.13.93 dependencies were preserved.
