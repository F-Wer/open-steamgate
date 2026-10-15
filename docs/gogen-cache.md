# Gogen object cache and warm/cold oracle

The disk object cache is opt-in through `compileProgram({cacheDir, ...})`.
It persists portable class IR and an ordered transcript of program-state reads
and effects. The registry still parses and checks normally. Step 1 retains the
whole-registry version guard: an edit creates a new version and lowers every
selected class. This is a correctness baseline, not selective reuse after edits.
Reverting exactly to an earlier version can reuse that version's entries.

## Keys today

The version hashes the cache schema, effective abaplint config, actual tool
contents, lockfiles, installed transpiler/core builds, and the registry's ordered
object inventory and source hashes. Tool identity hashes every
`tools/**/*.{mjs,ts,cjs,json}` file, including nested directories a future
frontend import might use. A fresh-process measurement took 65 ms on this
workstation; the result is memoized within the process. It excludes Git HEAD
and Git tree hashes: a docs-only commit preserves identity; changing tool contents changes it.
Lockfile changes still invalidate globally in this step.

Each object's hash includes its filenames and raw contents **in registry input
order**. abaplint macro collection uses that order and keeps the first definition.
Sorting filenames at this point hid semantic changes even from the global guard.
Folder compilation already sorts its directory walk; supplied registries can
have a different order and are tested explicitly.

Within a version, a class key also includes its source-word dependency closure
(with cycles grouped), lowering-time `getObject` reads, and missing lookup results.
Replay validates program-state inputs atomically before applying effects.
Whole-selection readers have closure variants; supplied parameters are guarded.
Nonportable graphs, nested mutations, corrupt entries and unavailable caches fall
back to lowering. Final interfaces, RTTI, tables and other metadata are rebuilt.
Neither source words nor lowering-time reads cover every semantic dependency.

## Oracle

`tools/gogen/cache-oracle.mjs` exports corpus generation, mutation application,
fresh-child capture, comparison and orchestration functions, and provides a CLI.
The default seed is 719, with 300 generated control classes, split between
disconnected classes and a seeded DAG. Additional fixtures cover inheritance,
interfaces/aliases, exception hierarchies and CATCH, events, constants/defaults,
explicit and implicit type-pool consumers, class/INCLUDE macros, TABL/DTEL/DOMA
typing and SELECT, and a function module whose name differs from its FUGR.
Macro-call markers are retained refusals alongside their lowered expansion.
Pool constants cannot currently lower: `variable()` in `frontend.mjs` resolves
locals, parameters and class attributes, but not pool constants. Both explicit
and implicit constant consumers are present; their unchanged refusal makes
`pool-constant` unsupported, excluded from the validated mutation count.

For every scenario the harness copies the corpus to scratch, primes the cache in
a fresh child, edits the copy, compiles warm in another fresh child, and compiles
without cache in a third. Each child has a fresh registry. It compares UTF-8 bytes
of Go, JS (or its emitter refusal), broken/skipped/partial/diagnostics/missing, and
final RTTI/table/lock/exception/CDS/AMC/interface metadata. It repeats with
`GOGEN_NOLINE` unset and set. A no-edit control asserts that **every feature
fixture** reuses, except
`ZCL_FUNCTION` (CALL FUNCTION reads a `functionModules` descriptor containing
circular registry/syntax graphs, so recording cannot fingerprint that input) and `ZORACLE_GROUP` (function-group IR is rebuilt
outside the class cache). The unchanged real corpus may have additional
uncacheable library classes; these are reported in counts, not claimed as
feature coverage. Reorder cases
use the supplied-registry API to change only the order of files within an object.

All mutation kinds run individually, followed by a body/pool/INCLUDE multi-edit
sequence and a return to the original corpus. Reports contain the seed, full edit
descriptors, selected real classes and pins, first differing artifact and byte
offset, and `loweredClasses`/`reusedClasses` counts. Each result is saved as it
finishes. `mutationAttempts` includes unsupported attempts; `mutationsRun`
excludes `pool-constant`. Every row compares its cold artifacts with the previous
cold capture (a separate cache-disabled baseline for the first step), and throws
on a dead mutation unless it is in the explicit expected-no-change list below.
Signature/remove/rename additionally require the stable `ZCL_CONTROL_READER`
reverse dependent's cold lowering to change; add-object requires the same for
`ZCL_ABSENT_READER`. The control target is always `ZCL_CONTROL_0001`, with a
reverse dependent at every allowed corpus size. The superclass parents declare
`shared` as `i` versus `int8`, read by the grandchild; defaults have a caller
that omits the argument.

The missing-provider fixture starts with `ZCL_ADDED` absent, then adds it. The
oracle supplies a registry whose error namespace excludes only that name,
modeling an external provider: abaplint leaves it unresolved so gogen records a
lookup miss and a cached refusal instead of excluding the consumer at syntax
checking. Every other name remains syntax-checked. The CLI exits 1 on a mismatch and throws on capture/infrastructure errors.
Scratch copies and caches are removed in `finally`; reports remain at the chosen
destination.

```sh
# Local full run: the pinned libraries must be available through libraryPath.
node tools/osd-libs.mjs --sync
GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh \
  node tools/gogen/cache-oracle.mjs --classes 300 --seed 719 --real \
  --report .local/cache-oracle.json

# Replay the saved mutation descriptors (same tool/build/library inputs).
node tools/gogen/cache-oracle.mjs --reproduce .local/cache-oracle.json \
  --report .local/cache-oracle-reproduction.json

# Test-only negative control: this command must report mismatches and exit 1.
GOGEN_CACHE_ORACLE_FAULT=no-version \
  node tools/gogen/cache-oracle.mjs --classes 8 --seed 719 \
  --report .local/cache-oracle-fault.json

# CI-sized run: 8 controls, every mutation, both line modes, fault assertion.
node --test tools/gogen/cache-oracle.test.mjs

# Slower local matrix: a dedicated narrowed fault for each kind, both line modes.
GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh \
  node tools/gogen/cache-oracle.mjs --sensitivity --classes 4 --seed 719 \
  --report .local/cache-oracle-sensitivity.json
# Equivalent assertion suite; kept out of the fast CI step.
node --test tools/gogen/cache-oracle-sensitivity.test.mjs
```

`--real` copies both complete pinned `open-abap-core/src` and `ajson/src` trees
through `libraryPath`, selects every real class, and adds real-source comment and
constant mutations. It uses the real exception root instead of the synthetic
stand-in. It never edits library checkouts. Tolerant compilation compares the
real corpus's refusals as well as successfully lowered methods. This oracle
measures emission equality, not runtime ABAP semantics or incremental parser
correctness. `typing-proof.mjs` was unavailable on the Step 1 base; the capture
module uses the same fresh-process, byte-comparison pattern described in its
review, without importing an absent file.

The cache alone reads `GOGEN_CACHE_ORACLE_FAULT`. Its exact accepted values are
**test-only**:

- `no-version`: omit registry sources from the version digest.
- `drop:<regex>`: do the same, and remove object keys matching that JavaScript
  regular expression from word-graph dependency edges and recorded `getObject`
  reads, including misses. Keys use uppercase `TYPE NAME`; the regex has no
  flags. The owner's own source hash and replay checks remain intact.
- `sorted-files`: retain the global guard but restore the old sorted-by-filename
  object hash, hiding within-object file-order edits.

Unknown values or invalid regular expressions throw. No other environment
variable enables these faults. Normal builds must leave this variable unset.
The CI negative control still requires the implicit pool mutation to mismatch
under `no-version` in both line modes.

### Cold observability exceptions

The explicit expected-no-change list is `pool-constant` (unsupported operand,
unchanged refusal), plus `comment-only` and `whitespace` **only with
GOGEN_NOLINE enabled** (only emitted source lines change). With lines enabled,
those text edits must change cold output. All other kinds, including FUGR,
revert and real-corpus edits, must change a cold artifact. Cold observability
alone does not establish stale-reuse sensitivity.

### Sensitivity matrix (seed 719, four controls, both line modes)

Every generated kind runs under its dedicated fault, even the uncovered ones.
A covered row must produce at least one warm/cold **MISMATCH** for that kind;
a zero-mismatch row without a documented reason fails the matrix. The CLI and
local test enforce this rule. Each report saves the fault, both observations,
cold changes, reuse lists, all differing artifacts and class IR, first byte
offset and runtime. The matrix names that evidence for every covered row.
The full matrix is a slower local mode; ordinary CI runs the normal oracle and the focused
`no-version` negative control under the three-minute oracle budget.

| Kind | Fault | MISMATCH | Coverage / reason if not covered | Differing warm/cold artifacts; class IR |
| --- | --- | --- | --- | --- |
| comment-only | `drop:^CLAS ZCL_CONTROL_0001$` | no | Not covered: only owner's lines change; call consumers do not inline provider text. Owner hash stays guarded. | None |
| whitespace | `drop:^CLAS ZCL_CONTROL_0001$` | no | Not covered: same source-line-only behavior. | None |
| method-body | `drop:^CLAS ZCL_CONTROL_0001$` | no | Not covered: calls do not inline bodies; owner's source hash forces lowering. | None |
| signature | `drop:^CLAS ZCL_CONTROL_0001$` | yes | Covered; dependent cold lowering changes. | `emitGo`, `emitJs`; `ZCL_CONTROL_0003`, `ZCL_CONTROL_READER` |
| class-constant | `drop:^CLAS ZCL_DEFAULTS$` | yes | Covered; external constant consumer reuses stale value. | `emitGo`, `emitJs` |
| parameter-default | `drop:^CLAS ZCL_DEFAULTS$` | yes | Covered; caller omits argument. | `emitGo`, `emitJs`; `ZCL_DEFAULT_READER` |
| superclass | `drop:^CLAS ZCL_(PARENT\|CHILD)` | yes | Covered; grandchild reads inherited storage with a different type. | `emitGo`, `emitJs`; `ZCL_GRANDCHILD` |
| exception-superclass | `drop:^CLAS ZCX_` | no | Not covered: `ZCL_CATCH` is reused with identical IR; CATCH checks the hierarchy at runtime. Only edited `ZCX_LEAF` IR and `exceptionSupers` (rebuilt outside replay) change. | None |
| interface | `drop:^INTF` | yes | Covered. | `emitGo`, `emitJs`; `ZCL_INTERFACE` |
| alias | `drop:^CLAS ZCL_INTERFACE$` | no | Not covered: used alias disappears, making edited class syntax-broken before replay. | None |
| event | `drop:^CLAS ZCL_EVENTS$` | no | Not covered: declaration and consumers share an owner, whose hash invalidates. | None |
| add-object | `drop:^CLAS ZCL_ADDED$` | yes | Covered: dropped recorded miss leaves cached absent-provider refusal. | `emitGo`, `emitJs`, `partial`; `ZCL_ABSENT_READER` |
| remove-object | `drop:^CLAS ZCL_CONTROL_0001$` | no | Not covered: dependent becomes syntax-broken before replay; dependent cold output does change. | None |
| rename | `drop:^CLAS ZCL_CONTROL_0001$` | no | Not covered: same syntax exclusion as removal. | None |
| ddic-field | `drop:^(TABL\|DTEL\|DOMA)` | yes | Covered. | `emitGo`, `emitJs`, `tables`; `ZCL_DDIC` |
| ddic-type | `drop:^(TABL\|DTEL\|DOMA)` | yes | Covered for stale successful lowering versus unsupported INT8 SELECT refusal. | `emitGo`, `emitJs`, `partial`; `ZCL_DDIC` |
| ddic-key | `drop:^(TABL\|DTEL\|DOMA)` | no | Cold coverage via final metadata: adds VALUE to the key while retaining ID. `ZCL_DDIC.RUN` lowers with identical class IR; `tables` and its Go emission change. Not covered for stale reuse: final metadata is rebuilt outside replay. | None |
| ddic-data-element | `drop:^(TABL\|DTEL\|DOMA)` | yes | Covered: switches from a domain reference to built-in CHAR(10), clears REFKIND; warm and cold `ZCL_DDIC.RUN` must still lower without refusals. | `emitGo`, `emitJs`; `ZCL_DDIC` |
| class-macro | `drop:^CLAS ZCL_LOCAL_MACRO$` | no | Not covered: reader owns macro, so owner hash invalidates. | None |
| include-macro | `drop:^PROG` | yes | Covered: provider lives in another object. | `emitGo`, `emitJs`; `ZCL_INCLUDE_MACRO` |
| pool-type | `drop:^TYPE` | yes | Covered: explicit and implicit consumers lower. | `emitGo`, `emitJs`; `ZCL_POOL_EXPLICIT`, `ZCL_POOL_IMPLICIT` |
| pool-constant | `drop:^TYPE` | no | Not covered / unsupported: neither explicit nor implicit constant operand lowers. | None |
| fugr-signature | `drop:^FUGR` | no | Not covered: caller never caches because its functionModules input contains circular registry/syntax graphs that cannot be fingerprinted; group lowering is outside class replay. | None |
| same-object-local-definition | `no-version` | no | Not covered: reader owns definition, so its object hash invalidates even without global guard. | None |
| file-order | `sorted-files` | yes | Covered; first-wins macro expansion changes. | `emitGo`, `emitJs`; `ZCL_ORDER_MACRO` |

The former `same-position-definition` case is now truthfully titled
`same-object-local-definition`, including its regression test. It changes local
constant contents at identical filename/name/start coordinates, and verifies
invalidation both with the global guard and under `no-version`. This establishes
owner-source invalidation only. A cross-object borrowed local-definition
fixture has not been established: frontend local definitions are qualified as
`OWNER:LOCAL` and ABAP local names resolve in their owning class pool. Global
named definitions get ordinary source-word/getObject dependencies. The
location-only fingerprint gap therefore remains **not covered**, rather than
being presented as a global-guard regression.

### Round-one measurements (historical)

Local Node runs, seed 719, both line modes. The full oracle and matrix shared
machine capacity; timings include fresh process startup and disk identity work.

| Run | Attempts / validated | Result | Runtime |
| --- | --- | --- | --- |
| CI: eight controls, multi-edit/revert, all kinds | 58 / 56 | Zero mismatches; edits reuse zero classes; unchanged/revert reuse 33 classes per line mode. | 122 s |
| Full: 300 controls + pinned open-abap-core/ajson | 62 / 60 | Zero mismatches; edits reuse zero; unchanged/revert reuse 575 classes and lower 22 per line mode. | 635 s |
| CLI sensitivity: four controls, all 25 kinds | 50 / 48 | 13 covered kinds, 26 mismatches; 12 explicitly not covered. | 201 s |
| Focused no-version negative control | Two pool-type observations | Two mismatches, including cached implicit consumer. | 5.8 s |

The final combined check passed all 47 tests in 164 s, including the separate
local matrix suite (164 s). The size budget, leak scan and suite registration
checks also passed.

The full run lowered 35,854 classes across mutation observations and reused
1,150 (the two reverts). Unsupported pool-constant attempts are the difference
between attempted and validated counts. The complete kind/fault/results matrix
and reasons are above; JSON reports remain local under `.local/`.

### Round-two measurements

Seed 719, both line modes. The revised 25-kind sensitivity matrix has 12 covered
kinds / 24 mismatches and 13 explicitly not covered kinds (149 s). The valid
key edit changes final metadata but cannot expose stale class reuse. The
exception row confirms catcher reuse and identical catcher IR, rather than
replay rejection. Reports now name every differing artifact and class IR;
the table above records this evidence even when emitted output changes without
class IR changes (the external constant case).

The separate local sensitivity test also passes in 150 s.
All 47 focused tests pass in 115 s, including the normal CI oracle (58 attempts,
56 validated, zero mismatches, 108 s) and the no-version negative control
(two mismatches). The DDIC assertions reject absent/dropped RUN and any
ZCL_DDIC broken/skipped/partial refusal; baseline, warm and cold must all pass.

The full 300-control plus pinned open-abap-core/ajson oracle passes all
62 attempts / 60 validated observations with zero mismatches in
534.8 s. Edits reuse zero classes; each revert reuses 575 and lowers 22.
Across mutation observations it lowers 35,854 classes and reuses
1,150. Size-budget and changed-file leak checks pass.

## Why the global guard remains

The [local design review's numbered plan](../.local/codex-queue/cachekey.log)
and coverage tables identify these unresolved paths. That log is local review
material and is not distributed in a clean checkout.

| Gap | Why words and lowering-time reads do not suffice |
| --- | --- |
| Implicit type pools | `POOL_TYPE` need not name the `POOL` object as a word; resolved signatures can precede recording. |
| Sibling/parent INCLUDE macros | Macro discovery follows filenames and including contexts; resolution can happen before lowering. |
| FUGR scans | Function-module names differ from group names; ownership resolution scans groups without `getObject`. |
| CDS aliases | SQL-view aliases are resolved by scanning DDLS providers. |
| BAdI definitions | ENHS/BAdI lookup is a type-wide scan and can affect syntax acceptance before gogen refuses a statement. |
| Definition fingerprints | Replay fingerprints include name/file/start position, not semantic contents. Borrowed definitions need a semantic guard; cross-object oracle coverage is not established. |

Cached DDIC types/scopes can also hide earlier reads, and global OO resolution
passes make stopping/order behavior a semantic input. Passing mutation tests
does not prove that an incomplete dependency manifest is safe.

## Six-step plan

1. **Regressions and oracle, with global invalidation.** This change: implicit
   pools, same-object local definitions, file order, compiler identity, every mutation
   category, and the existing cache/replay/portability gates. Retained-registry
   parser invalidation is outside this step; all edited captures rebuild registries.
2. **Semantic provenance and resolution queries before parsing.** Attribute
   named lookups, misses, filename/alias/scan resolution and cached-artifact reads
   to their owners. Unknown paths fail closed.
3. **Resolved-artifact digests and stronger definition fingerprints.** Include
   semantic contents alongside location and guard global resolution/order effects.
4. **Per-entry schema-v3 keys for complete manifests.** Keep global guards for
   incomplete entries. Require the fresh-process oracle and exact control reuse
   assertions (for example, ten dependent classes lower while 290 others reuse).
5. **Bounded real-corpus and performance gates.** Compare unchanged/edited warm,
   cold and recording costs; require zero byte mismatches and measured benefit.
6. **Incremental parser invalidation and dependency precision separately.**
   Test retained registries against fresh cold after multi-edit/inventory/config
   sequences; narrow body/interface hashes only after dedicated cases pass.

Steps 2–6 are plans. This change deliberately implements no selective per-class
reuse across different registry versions and adds nothing to `frontend.mjs`.
