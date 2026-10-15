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


## Semantic provenance (step 2)

`compileProgram({provenance: true, ...})` records semantic resolution before
`reg.parse()`, through global definition passes, syntax checking and lowering.
Recording is **off by default**, including with `cacheDir`. Enable it with
`provenance: true` or `GOGEN_PROVENANCE=1`; explicit `provenance: false`
overrides the environment. This stays opt-in until step 4 consumes the data.
This is observation only: cache keys, source hashes, replay validation and the
whole-registry version guard are unchanged. Resolved-artifact digests and
selective per-entry keys remain steps 3 and 4.

The implementation lives in `frontend-provenance.mjs` and its version-specific
`frontend-provenance-hooks.mjs` adapters. Scoped synchronous hooks restore the
original descriptors in `finally`, including on errors. The frontend's FM
selection walk was moved unchanged into the recorder module so its index reads
and named ownership queries can be attributed to each consumer. Function-group
signature/lowering work and class lowering have explicit artifact contexts.
`frontend.mjs` shrinks by 20 physical lines.

```js
import {compileProgram} from "./tools/gogen/frontend.mjs";
import {provenanceOf, recordProvenance} from "./tools/gogen/frontend-provenance.mjs";
const program = compileProgram({folders: ["src"], objects: ["ZCL_READER"], provenance: true});
const manifest = provenanceOf(program).get("CLAS ZCL_READER");
// With a supplied registry, wrap its construction/parse too:
recordProvenance(() => { registry.parse(); return compileProgram({registry, folders: [], objects}); });
```

`provenanceOf(program)`, `provenanceOf(session)` and `provenanceOf(registry)`
return a `Map` keyed by uppercase `TYPE NAME`, including non-selected registry
objects. Each value is `{hits: [], misses: [], scans: [], unknownScans: []}`.
A named-query row has `artifact` (the original owner), `phase`, `kind`, `args`
and `result`. An empty result is a miss, rather than an omitted dependency:

```json
{"artifact":"DTEL ZORACLE_NUM","phase":"ddic-type","kind":"getObject",
 "args":["DOMA","ZORACLE_NUM"],"result":["DOMA ZORACLE_NUM"]}
```

Scans additionally have `scan` (`getObjects` or `getObjectsByType`), ordered
visited `result` object keys and `complete`. `complete: false` preserves early
termination at the winning candidate. `queryArgs`, where available, identify
the enclosing semantic query separately from the iterator's arguments.
For example, a `cds-alias` scan has `args: ["DDLS"]` and
`queryArgs: ["ZSQLALIAS"]`. Unknown scans have `kind: "unknown-scan"` and a
short `site` stack. Names used in case-insensitive resolution are normalized
for inspection; filenames in results retain their actual spelling.

The recorder covers named object/file/filename-owner/first-object lookups;
implicit type-pool type and constant prefixes; FUGR module ownership and
includes; CDS definition/SQL-view aliases; include parents and sibling macro
context; ENHS/BAdI scans and BDEF lookups. Recursive `parseType` artifact edges
retain TABL/DTEL/DOMA, TTYP, VIEW, structure INCLUDE and APPEND dependencies.
The FM index preserves gogen's last-wins enumeration, while core's ownership
and alias scans preserve their first-match prefix order.

Artifact reads add edges even when an abaplint getter or `SyntaxLogic.run()`
returns a cached result. Manifests expand these stored edges at inspection
time, inheriting the provider's queries with their original owner/phase.
A second cached TABL consumer therefore still shows the DTEL's DOMA lookup.
Disk IR and memory-session entries carry only the owner's own rows and edges:
`{rows: [...], edges: ["TYPE NAME", ...]}`. They never persist a transitive
closure. Replay restores these rows/edges, and `provenanceOf()` expands them
against the current registry's provider artifacts on demand. The transcript
still does not participate in cache validation.

Artifact identities (syntax result, parsed type, definition, parsed files and
FM/include metadata) are snapshotted at the end of each recording session.
An artifact subsequently built with recording off gets an `untraced-artifact`
marker on its owner, even when a retained syntax session bypasses checking.
Artifacts first encountered after they were built receive
`artifact-built-before-recording`. Memory/disk replay without an own-row
transcript receives `lowering-built-before-recording`.

Inventory snapshots copy filenames and SHA-256 content hashes; they do not
retain core's mutable file array. Replacing, adding or removing a file, or
changing registry configuration, prunes old query/edge rows and marks retained
artifacts incomplete (`retained-registry-edit` / `retained-registry-config-edit`).
This does not repair abaplint's caches or implement parser invalidation.

Actual lowering reads of `program.functionModules` add a named
`function-module-owner` query and provider edge, including CALL FUNCTION
expanded from a macro. Unknown scan sites use repo-relative or module-relative
paths (external frames use `<external>/basename`); absent/unrecognised stack
frames remain unknown scans. Folder mode reads `.asddls` for gogen's CDS
metadata but does not register it in core. CDS alias provenance therefore
requires supplied registries containing DDLS files; this limitation is unchanged.

Registry orchestration has no single object owner. Such rows use
`artifact: "<registry>"` and are conservatively included in every object's
manifest. An unclassified iterator remains in `unknownScans`, even if nested
inside a known syntax pass. These manifests **are not evidence that the global
guard can be removed**. A later key implementation must retain the global guard
or decline reuse for every entry with unknown/incomplete provenance.

```sh
node tools/gogen/frontend-provenance.mjs <folders...> \
  --objects ZCL_READER --show 'CLAS ZCL_READER'
node --test tools/gogen/frontend-provenance.test.mjs
# Run the combined frontend/cache suites sequentially: ownership tests generate
# temporary tools/**/*.mjs, which intentionally enter compiler identity.
node --test --test-concurrency=1 tools/gogen/frontend-*.test.mjs tools/gogen/cache-oracle.test.mjs
GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh \
  node tools/gogen/frontend-provenance-bench.mjs --rounds 3 \
  --report .local/provenance-300.json
# Pinned complete library trees; every real class is selected, tolerant refusals retained.
GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh \
  node tools/gogen/frontend-provenance-bench.mjs --real --rounds 3 \
  --report .local/provenance-real.json
```

The focused gates exercise each channel above, named/scan misses, candidate
order and early stopping, cached DDIC inheritance, disk replay inheritance,
unknown scans and exception-safe restoration. On/off comparisons include Go,
JS or its refusal, class IR, diagnostics/refusals/missing members and all final
metadata compared by the cache oracle.

### Fix-round validation and recording cost

The focused regression gates cover opt-in/environment precedence, own-row disk
storage/replay, recording gaps in syntax/DDIC/memory/disk lowering, immutable
replace/add/remove snapshots and stale-row pruning, configuration edits, empty
stack frames in a child process, portable sites, macro-expanded FM signatures,
and owner isolation for sibling INCLUDE macros. The hook sweep runs one adapter
mutation at a time in a disposable copy and verifies a passing baseline first:

```sh
GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh \
  node tools/gogen/frontend-provenance-mutations.mjs \
  --report .local/provfix-mutations.json
```

The 48-mutation sweep kills 42 mutations. It kills every specifically requested
hook: query/link edges (separately and together), selection artifact context,
all artifact reads, owners-map lookup, getModule/getInclude adapters and their
named queries, pool constants, procedural includes and cross-include consumer
attribution. The combined edge mutation fails the subclass DDIC and implicit
pool interface fixture too. Every fail-closed marker mutation is killed.
The six survivors preserve dependency linkage through another wrapped method
in this pinned core (they are redundant observations, not uncovered leaf reads):

| Surviving removed getter hook | Remaining path to the same provider owner |
| --- | --- |
| `getClassDefinition` | Calls wrapped `getMainABAPFile`, which calls wrapped `getABAPFiles`. |
| `getMainABAPFile` | Calls wrapped `getABAPFiles`. |
| `getIncludeFiles` | Calls wrapped `getIncludes` and `getABAPFiles`. |
| `getSequencedFiles` | Calls wrapped `getABAPFiles` for classes; wrapped `getMainABAPFile`/`getModules`/`getABAPFiles` for groups. |
| `getSQLViewName` | Calls wrapped DDLS `parse`, including for cached data. |
| `getDefinitionName` | Calls wrapped DDLS `parse`, including for cached data. |

Isolated cached `getDefinition`, `getIncludes`, `getModules` and
`listBadiDefinitions` reads each kill their own getter-hook mutation. A survivor
without an explicit redundancy explanation makes the sweep exit nonzero.
Scratch is removed in `finally`. The local JSON report names the failing tests
for every killed hook.

| Review item | Regression / red evidence |
| --- | --- |
| 1. Opt-in and storage | Default/env/explicit-false test; decode persisted binary entries to check own rows plus edges and warm DDIC inheritance. Both fail on the original implementation. |
| 2. Untraced artifacts | Parse while recording, compile with recording off, reuse syntax/session with recording on; also rebuild cached DDIC off. Both fail on the original implementation; marker-removal mutations fail too. |
| 3. Retained edits | Replace/add/remove files, remove an object, and change config; assert markers and prune obsolete queries. All fail before the fix. |
| 4. Empty stack | Child with `--stack-trace-limit=0`, including iteration without owner context; originally throws. Stack-fallback/unknown-scan mutations fail. |
| 5. FM lowering | Macro-expanded CALL FUNCTION, DDIC signature chain, DOMA INT4→INT8 changes Go; original manifest lacks the lowering ownership row. Removing the new lowering query fails. |
| 6. Hook sensitivity | Consumer-owned selection, cached reads, superclass DDIC, implicit pool interface, group getters, constants/includes and unrelated-object isolation; all requested hook-removal mutations fail. |
| 7. Portable sites/CDS | External absolute frame and cwd/module paths must be scrubbed; original code and site-normalization removal fail. Folder-mode DDLS limitation documented above. |

The final combined sequential frontend/CI-oracle run passes **211 tests** in
280.6 s, including 37 provenance tests. The separately recording-enabled
CI oracle passes all six tests in 111.8 s. In each oracle run: 58 observations,
56 validated mutations, zero mismatches; the no-version negative control
still produces the required mismatches in both line modes. The changed-file
size budget, explicit-path leak scan and suite registration all exit zero.
`frontend.mjs` has zero net added lines in this fix round (the branch remains
20 lines smaller than the step-1 base). The sole default-off scalar-entry
shape failure discovered during validation was fixed and its 52-test targeted
recheck and final combined run both pass.

Three fresh-process runs per scenario, median frontend milliseconds,
Node 26.9.0, pinned libraries from `libs.lock.json`:

| Corpus | Scenario | Recording off | Recording on | Overhead |
| --- | --- | --- | --- | --- |
| open-abap-core + ajson | No cache | 1,448.1 ms | 1,748.4 ms | +20.7% |
| open-abap-core + ajson | cacheDir cold | 1,697.1 ms | 2,096.2 ms | +23.5% |
| open-abap-core + ajson | cacheDir warm | 1,513.0 ms | 1,859.1 ms | +22.9% |
| Oracle 300 + fixtures | No cache | 301.4 ms | 367.3 ms | +21.8% |
| Oracle 300 + fixtures | cacheDir cold | 494.3 ms | 553.4 ms | +11.9% |
| Oracle 300 + fixtures | cacheDir warm | 359.8 ms | 414.8 ms | +15.3% |

| Corpus | Cache bytes off | Cache bytes on | Growth |
| --- | --- | --- | --- |
| open-abap-core + ajson | 526,812 | 694,009 | +31.7% |
| Oracle 300 + fixtures | 265,987 | 301,662 | +13.4% |

All 18 runs per corpus have identical artifact/class-IR digests across recording
and cache modes. The real registry has 651 objects / 272 lowered classes with
zero diagnostics; every warm run reuses 251 classes and lowers 21. The synthetic
warm runs reuse 325 and lower one. Warm cache still costs more than no-cache
compilation on these corpora; recording remains opt-in until its consumers
and performance gates are implemented. Reports remain local as
`.local/provfix-perf-real-final.json`, `.local/provfix-perf-300-final.json`, and
`.local/provfix-mutations.json`. Benchmark cache sizes count actual file bytes, not allocated blocks;
timing covers source loading, normalization, parse, syntax and lowering, and
excludes emission and diagnostic closure expansion. Warm children follow cold
primes in a separate process. Each mode's on/off emitted artifacts and class IR
must have the same SHA-256 digest. No library checkout is edited.

The real corpus still exposes unknown registry orchestration scans: supplied
parameter discovery, local class/interface collection, selected groups and
class dispatch, lock construction (twice), RTTI, table metadata and source
ownership. With cacheDir, disk-session preparation, cache inventory and session
finalization add three further unclassified sites. These rows remain global
and conservatively appear in all manifests. No claim of selective invalidation
or permission to remove the global guard follows from these results.

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
2. **Semantic provenance and resolution queries before parsing.** Implemented: attribute
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

Steps 3–6 are plans. Step 2 adds observation and deliberately implements no
selective per-class reuse across different registry versions.
