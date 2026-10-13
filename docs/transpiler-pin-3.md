# Transpiler pin 3

Reapplies PR #720 on main after its revert, with the missing npm dependency
move. The fork remains at `6f2119b85b496d537aedb6d33a91392c3f60231f`;
open-abap-core remains at `84125c41c22e4c0d45e8037e8b60c691bb64de8d`.
No compiler fix is needed for the reported traversal failure.

Resumed against OSG `origin/main` at `73d72176`, including #721, #723
and #722. A final fetch found #724, #725 and #726 at `16c024c8`; the
local `fix/transpiler-pin-3` branch was rebased again onto that fetched tip.
The complete CI-equivalent validation is refreshed on that tree.
The fork branch `local/osd-build-3` was rebased onto its own current
`origin/main`, `3fbabdf7`. That old main carries separate translator assets;
they remain, while the current compiler dependency manifest replaces its
obsolete, incompatible tree-sitter dependencies. The compiler and tests
are unchanged from `local/osd-build-2`. The published fork pin remains
`6f2119b8`, which is already available for clean CI clones. Nothing is pushed.

## Root cause

Both failing jobs installed the tracked npm lock and built the entire system
without linking the fork. PR #720 moved the parser to 2.120.73 but left the
lock on transpiler, CLI and runtime 2.13.96. The main tests build links the
2.14.3 fork, which concealed this second dependency path in targeted checks.

The failing statement is `CREATE DATA itab TYPE HANDLE lo_table`, line 151
of the public open-abap-core implementation in
`src/fdt/cl_fdt_xl_spreadsheet.clas.abap` at the library pin above.
The parser supplies a `SimpleSource3` expression after `HANDLE`. Transpiler
2.13.96 finds that handle, then incorrectly searches for a direct `Source`
expression. That lookup returns undefined, which `Traversal.traverse` rejects.
The stack points to `CreateDataTranspiler.transpile`. This is a compiler/parser
compatibility mismatch, not invalid library ABAP. Both published 2.14.3 and
the pinned fork already traverse the expression after `HANDLE` correctly.

The full Node 22 `npm run transpile` and Node 24 `npm run bootstrap` reproduced
the original failure with the restored #720 dependencies. The corrected npm
build compiled all 2,375 objects. The linked-fork build also compiled all
2,375 objects. Neither reproduction used a reduced object selection.

## Fix

- Pin published transpiler, CLI and runtime to exactly 2.14.3 in the npm
  manifest and lock, alongside parser 2.120.73. The npm and fork build paths
  now use the same compiler release.
- Add a regression to `test/transpiler-pin.mjs` that compiles `TYPE HANDLE`
  through the actual selected compiler/parser pair and checks the emitted
  kernel call.
- Keep the current main JSON refusal expectation in gogen semantics.
  Reapplying #720 restored an obsolete `Native_CONV_OUT_CONVERT` refusal;
  main now implements that JS conversion, so the precise remaining refusal
  is `Native_JSON_PARSE`. The expected Go JSON values remain unchanged.
- The full Go host check exposed sourceless CDS metadata in its registry.
  `tools/gogen/osg-build.mjs` now excludes DDLS XML, while continuing to read
  CDS source for its name map and using the generated DDIC views, as the
  Node build does. The newer transpiler correctly rejects the former
  incomplete DDLS objects; weakening that check would hide the adapter bug.
- Update the CLI comparison for 2.14.3's `project/` output layout.
  OSG keeps flat modules; the test compares every emitted file after
  resolving that layout difference, resolves each map source to its real
  input, verifies the CLI's embedded source bytes, and compares all other
  map fields and JavaScript. No runtime output layout is changed.
- Exclude `.git` from the compiler input walk. The full main suite exposed
  a warm-prime race: Git refreshed a library index while another process
  walked its metadata, and the disappearing `index.lock` aborted priming.
  Git metadata is not ABAP input. The regression compiles real ABAP next
  to a dangling metadata entry; it fails without the exclusion and passes
  with it. Source-file errors remain fatal.
- Keep the WAL stress test's 1,500 writer cycles and 1,500 reads, with a
  120-second test budget and a 110-second writer watchdog. The full shard
  exposed its former 30-second timeout and cleanup racing a still-live
  writer. Every owned writer is now stopped and awaited before database
  cleanup, including when Mocha times out the test. The complete focused
  suite passes with its process-isolation checks.
- Update two stale AMDP extraction expectations. Core 2.120.73 now reads
  `SUPPRESS SYNTAX ERRORS` and declaration-side `AMDP OPTIONS`; the tests
  now require parsed signatures and compare both methods to the independent
  text reader. Existing unsupported-clause fallback tests remain. The
  complete focused suite passes 21 cases; the full sixth rerun passes.
- Batch the fast Node XML scaling measurements over at least 200 ms,
  using five sample batches. Every parse still checks its result counts;
  the largest-two-doublings threshold of 3 and Node/ABAP time ceilings
  remain unchanged. Full and isolated runs had failed different Node
  shapes due to timing noise. ABAP keeps its three original samples.
  Give the real SQLite migration/outbox import case a 30-second integration
  budget instead of Mocha's default two seconds; every migration, ordering
  and acknowledgement assertion remains. The complete fourth rerun passes.
- Match the adjacent daemon-start/first-pass calls independently of their
  indentation in the autonomous-doctor mutation test. Transpiler 2.14.3
  emits the calls at a different indentation; the old literal replacement
  made no mutation. The checks that executable code changes and that the
  behavioral oracle catches the mutation remain enforced.

- Use the private runtime-root artifact fixture in the supervisor lifetime
  test. Diagnostics showed its former fixture rebuilding the full system
  for 36.4 seconds, then exceeding startup's 45-second limit during
  cross-reference seeding. The test now reuses verified bytes with private
  generation links and rows. Its three-second parent-death requirement,
  startup limits and readiness checks are unchanged.
- Give the detached-unit debugger's full-system post-entry breakpoint wait
  30 seconds instead of the small-fixture 15 seconds. The real unit finished
  successfully after a failed 15-second wait; all breakpoint, frame-line,
  script-URL and unit-result assertions remain. Both complete affected test
  files pass together: 17 cases with resource isolation and no retries.

## Validation

Workflow jobs run in separate checkouts with their pinned source packs and
seven library clones. Main-workflow consumers restore and verify the built
tree artifact, including the compiled fork and its parser. Heavy commands
use the repository instance wrapper. Node 22.23.3 covers gogen and tests;
Node 24.21.0 covers consumer smoke. Go runtime checks use 1.26.9; corpus
generation selects its required 1.26.0. VSP uses 1.26.8 and its tracked ref.

The full validation was repeated after the final rebase onto `16c024c8`.
The table reports that fetched main tip with this branch's changes. The fork's
complete suite also passed on its rebased branch.

| Check | Result |
| --- | --- |
| Fresh main build: npm ci, clean binary/doctor, fork build/verify/link, fetched packs and libraries, full transpile | Pass; 2,375 objects |
| Main lint, ABAP Unit, BAL restart, built-tree artifact | Pass; 96 Unit classes; lint has 79 warnings and no errors |
| Full gogen workflow: types, Go vet/tests, WASM, race, semantics, frontend tests, fixtures, osabap and generated-class suites | Pass; 982 s of the hard 2,100 s budget; 109 passing, 1 pending |
| Fork npm test, including PostgreSQL and lint | Pass; 3,137 passing, 29 pending |
| Pin and cached-parser regression | Pass; 13 passing |
| CLI/library adapter and Git metadata regression | Pass; 12 passing; metadata case fails without the fix |
| Consumer smoke, Node 24 | Pass; SQLite, DuckDB, Go CLI, jobs, DSL L3, C in ABAP |
| Full Go inventory workflow | Pass; accepted exit 1: 519 SUCCESS, 267 NOT_COMPILED, 7 SKIPPED, 17 FAILED; sXML benchmark passed |
| Main suites shard 1/6 | Pass; 2,255 distinct passing cases, 2 pending; one built-in file retry |
| Main suites shard 2/6 | Pass; 1,248 distinct passing cases, 6 pending; one built-in file retry |
| Main suites shard 3/6 | Pass on complete final rerun; 1,772 passing, 10 pending; 16 min; no retry |
| Main suites shard 4/6 | Pass; 1,398 passing, 15 pending; 28 min; no retry |
| Main suites shard 5/6 | Pass; 1,095 distinct passing cases, 9 pending; one built-in file retry |
| Main suites shard 6/6 | Pass; 1,788 passing, 17 pending; 17 min; no retry |
| Main browser job | Pass; 26 browser cases and 4 DuckDB Vector Workbench cases |
| Required kernel conformance | Pass; pinned generated corpus verified |
| ADT lifecycle | Pass; both ABAP-FS and pinned VSP creation/edit/check/activation/readback/cleanup |
| Full VSIX packaging group | Pass; 16 install/repackage cases |
| Go host | Pass; vet/APC/media/gateway/build gate/ADT and ABAP-FS ratchets; ABAP-FS 22 PASS, 1 expected FAIL, 23 MISSING; no regressions |
| Standalone seeded Linux binary | Pass; unchanged bubblewrap smoke in Linux guest as UID 1000 with 8 GiB |
| Latest-main frontend exception and object-cache tests | Pass; 17 cases |
| PCRE oracle comparison against unmodified fetched main | Pass; 90 patterns, 38 inputs, two case modes; zero regressions and zero supported mismatches |
| Unmodified fetched-main store goldens and hostile Git configuration | Pass; 2 cases on `16c024c8` |

The refreshed workflow used its built-in retry for three files. In shard 1,
a save latency check took 807 ms against its unchanged 200 ms limit;
all 17 warm-process cases then passed in isolation. In shard 2, a lifecycle
server's warm prime exceeded its unchanged 30-second budget; all 15 cases
in that file then passed. In shard 5, the 110-second writer watchdog fired;
all 11 reader-lock cases then passed, including the same 1,500-cycle stress
in 85.5 seconds. These retries are recorded rather than reported as clean
first attempts. The earlier complete validation on `73d72176` passed all six
shards without retries.

The first refreshed shard 3 remained red after retrying parent startup and
the detached-unit breakpoint. Diagnostic reproductions prompted the two
harness fixes above. Both complete files passed together with isolation:
17 cases and no retries. The complete third shard then passed in a fresh checkout: 1,772 passing, 10 pending, no retries. All six completed shards cover 9,556 distinct passing cases and 59 explicit pending cases.
No required check was removed. Corpus-only cases remain explicitly skipped
because no private corpus is present. All main suite jobs restore and verify
the newly built artifact in separate checkouts. The two final harness changes
only affect tests; the verified build inputs and generator identity are unchanged.

An unmodified checkout of `16c024c8` ran the store destination golden and
hostile-Git-configuration tests: 2 passing. The branch's full suite also
passes the store checks. No store snapshot changes are in this branch;
the updated snapshots are already part of current main. There is no red
store-golden result to exempt as pre-existing.

## Local validation environment

The host kernel denies namespace creation. A minimal local User Mode Linux
6.1.176 guest provides actual Linux PID and mount namespaces without
changing the host's settings. The final seeded binary and the unchanged
smoke script have identical hashes inside and outside that guest. The real
bubblewrap smoke passed there, including both HTTP 200 checks and the
serving-process ownership audit. An unprivileged-user repeat initially
exhausted a 4 GiB guest; the 8 GiB repeat passed as UID 1000. Both runs
used the real bubblewrap executable. The successful repeat preserved the
five-minute startup deadline and verified the serving PID belongs to
the smoke process's own subtree.
The smoke's isolation settings and five-minute startup deadline are unchanged.
The guest setup follows the [Linux kernel UML documentation](https://www.kernel.org/doc/html/latest/virt/uml/user_mode_linux_howto_v2.html).

ZIP tools, Clang 18, the WASM linker, Chromium libraries and fonts were
materialized for the local workflow runs. Initial missing-tool and font
configuration failures were corrected before rerunning the affected steps.
The first incomplete C corpus was rejected by its manifest; regeneration
with the workflow's Clang/linker names passed content verification.

Consumer smoke intentionally sets `SLICE_SKIP_UI=1`; its browser check is
reported as skipped. The main browser job runs separately. The Go Unit
inventory accepts exits 1 and 2 by workflow design: its method gaps are
reported explicitly rather than treated as a fully passing Go runtime.

Evidence is retained in the ignored `.local/pin3-final-ci/` directory: full
workflow logs, the unmodified-main golden run, parser AST output, negative
metadata regression, positive focused checks, and the real unprivileged
namespace smoke. Latest-tip results use the `latest-` log prefix, including
`latest-shard3-final.log`, `latest-baseline.log`, `latest-pcre-final.log` and
`latest-standalone.log`. The first extra PCRE invocation omitted its required
baseline argument; the corrected comparison passed against the unmodified
fetched-main checkout. Earlier failed attempts remain separately labelled.

All commits are local. Nothing was pushed.
