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


## Resolved-artifact digests (step 3)

A cache/session compilation installs an empty digest memo after syntax checking.
The ordered replay seam requests a `gogen-resolved-artifact-2` SHA-256 digest
only when fingerprinting a read that contains a definition; repeated reads reuse
that owner's digest. Unread owners are never projected on the normal compile path.
Without cacheDir or a recording session, compilation does no digest work.
Explicit inspection (`artifactDigestsOf` / the digest CLI) requests a full
snapshot after compilation; diagnostic dependency metadata requests its hit
owners separately when provenance recording is enabled. `frontend-artifact-digests.mjs` owns the projections
and stores them in a registry-keyed weak table; no digest fields enter IR or
replay-tracked program state. A new table replaces the previous compile's memo.

The digest hashes canonical JSON tuples containing the uppercase `TYPE NAME`,
ordered effective files (portable filenames, raw-source hashes), expanded
syntax tree shapes and token text/positions (including macro virtual positions),
global/local definitions, typed scopes and resolved DDIC types through core's
`parseType(registry)` contract. Definitions include resolved parameter,
attribute, constant and named types, parameter directions/defaults/optional
flags, visibility, aliases, superclass/interfaces/friends, method flags and
events/handler parameters. Scopes include local/inline types, deferred names
and symbolic resolution references. Object-reference types use symbolic
locations rather than recursively importing another definition's graph.

Dictionary keys use code-point sorting; arrays preserve semantic/source order.
Filenames strip directory prefixes. Expanded statements, definitions and
recursively shared types are projected and hashed once within a compile.
Statement hashes include token text and real/virtual positions; structure
projections reuse those hashes instead of repeating token graphs. Source
expressions use their token sequence (including parentheses) so the transpiler's
in-place arithmetic precedence regrouping cannot change a digest according to
whether its owner has been lowered or replayed. This canonicalization is the
format-2 change; the rest of the resolved projection is retained. Parent links, registries,
object identities, parser caches and Map insertion order never enter this
format. The digest is a snapshot of what core actually resolved, including
Unknown/Void types, rather than a claim that resolution succeeded. Unsupported
shapes produce a `null` digest plus an inspection error; definitions belonging
to such an owner decline replay. The global source/version guard remains
unchanged, including for unknown or incomplete provenance.

Replay definition fingerprints now contain location **plus** `{owner, digest}`.
A same-name/file/start definition with changed semantic contents rejects replay
atomically. Repeated reads reuse the owner's digest rather than serializing its
graph. Definitions without a registry/owner digest refuse persistence.

Disk builds record `gogen-dependency-digests-1` metadata only with provenance
recording (`GOGEN_PROVENANCE=1` / `provenance: true`, or an explicit enclosing
`recordProvenance` session). Explicit `provenance: false` overrides the environment.
Metadata contains the owner/entry name, owner digest, a sorted
`dependencyDigests` dictionary from the final expanded manifest's **hits**, and
`provenanceComplete`. Filename hits map back to their owning artifact. These
opt-in diagnostic reads request digests on demand as well; dense manifests can
request most of the registry. Writes wait until final metadata passes and freeze
the lowering snapshot so later mutations cannot change it. Without recording,
writes persist immediately without cloning, provenance hooks or dependency
metadata. Metadata is **not in the key or a replacement for miss/scan guards**.
Unknown scans or unavailable digests make completeness false. Inspection labels
entries without metadata unavailable, including entries built with recording off.
Enabling recording while reusing such an entry retains the explicit
`lowering-built-before-recording` marker; it does not invent a transcript.

```sh
# All current artifact digests, or one artifact (no cache needed).
node tools/gogen/frontend-artifact-digests-cli.mjs src --show 'CLAS ZCL_READER'
# Inspect the dependency digests stored for an entry, across retained versions.
node tools/gogen/frontend-artifact-digests-cli.mjs --cache-dir .local/cache --entry ZCL_READER
node --test tools/gogen/frontend-artifact-digests.test.mjs
```

The cross-object gate uses a real global class definition and a separate reader
at the ordered replay/cache seam. The provider's constant changes `1` to `9`
without changing filename, name or start. The reader borrows the pre-resolved
definition through a program map, without source-word or lowering lookup edges.
Under `no-version`, semantic fingerprints give EQUAL in both line modes;
`no-version,fingerprint-location-only` gives MISMATCH on the supplemental
`borrowedDefinitionReplay` artifact. The corpus also contains an ordinary global
constant reader whose Go/JS cold output changes. This controlled seam is
explicitly **not a normal cross-object local-class lowering path**: local
class names are `OWNER:LOCAL`, local interfaces are `OWNER|LOCAL`, and ABAP local
names resolve within their own class pool. No cross-pool local-definition read
has been constructed. The seam isolates the fingerprint invariant that ordinary
global word/getObject guards would otherwise mask.

An eight-interface forward type chain exercises repeated global-definition
passes and its unchanged class reader. A terminal type mutation must change
cold Go/JS. The within-object first-wins macro reorder remains in the oracle.
These gates use fresh registries/processes and compare warm with fresh cold;
they do not implement retained-registry parser invalidation.

### Initial step 3 validation and cost (before the performance round)

The combined sequential frontend/cache/CI-oracle run passes **221 tests**.
The latest digest/CI recheck passes **16 tests**, followed by three focused
checks for snapshot preservation, the cross-object fault, and backward-compatible
`drop:` regular expressions containing commas. All have zero failures/skips.
The CI oracle has **62 observations / 60 validated mutations, zero mismatches**,
with lines on/off. The full 27-kind sensitivity matrix has 14 covered fault
rows / 28 expected mismatches and 13 documented uncovered rows. The strengthened
cross-object control is EQUAL under `no-version` in both line modes. Global type
passes and first-wins macro order are covered; reversing global-definition
candidate insertion preserves per-object digests, and the changed inventory's
warm output matches its own fresh cold output under the retained global guard.

The typing-proof record was captured on `543b1053` before implementation edits.
Comparison passes **239 raw artifacts in each of six modes** (sink 0/1 times
no-cache/cold/warm), with no normalization. Digest stability passes on both the
small oracle corpus and all **651** real-library objects: two fresh processes
per Node 26.9.0 / Bun 1.4.2 and provenance-off/on combination, eight processes per corpus.
The real runs have no unsupported digest shapes. Size budget
`--changed origin/main`, explicit-path leak scan, whitespace and suite-list
checks exit zero; `frontend.mjs` remains **7,055 lines**, zero net growth.

Three fresh-process runs per scenario/reporting setting, medians on Node
26.9.0, pinned open-abap-core + ajson, every real class selected. Both the parent
and candidate use `OSD_HEAVY_TMP=/mnt/ram/stoker`, with the shared Go build cache.
The parent is an isolated source copy of `543b1053`. Digests are always on in
the candidate; disk builds also collect internal provenance. Times include
source loading, normalization, parse, syntax, digest projection, lowering,
replay and final dependency-metadata expansion; emission and public report
inspection are outside the frontend timer. Digest cost includes snapshot setup
and is measured directly, rather than inferred from total-time subtraction.

| Scenario, public reporting off | Parent total | Step 3 total | Digest projection | Total overhead |
| --- | --- | --- | --- | --- |
| No cache | 1,448.6 ms | 1,807.0 ms | 413.1 ms | +24.7% |
| cacheDir cold | 1,697.6 ms | 3,344.6 ms | 375.2 ms | +97.0% |
| cacheDir warm | 1,485.5 ms | 2,415.3 ms | 372.4 ms | +62.6% |

With public provenance reporting on, candidate totals are
2,155.9 / 3,399.6 / 2,516.3 ms
(no-cache/cold/warm); direct digest costs are
373.5 / 371.0 / 376.7 ms.
All 18 candidate captures have identical resolved digests and emitted artifacts /
class IR, and their emitted-artifact/IR hash equals all 18 parent captures.
Every warm run reuses 251 classes and lowers 21, matching the parent; there are
272 lowered classes in cold/no-cache runs and zero diagnostics.

Cache file bytes grow from 526,839 to 6,436,245
with public reporting off, and from 694,040 to 6,534,884
with it on. The dependency dictionaries conservatively include registry-level
hits inherited by every manifest, so they are dense. Warm caching remains slower
than cache-disabled compilation on this corpus. These measurements leave the
cost visible for step 4; no selective-reuse or performance-benefit claim follows.
Reports remain local: `.local/digest-perf-parent-ram.json`,
`.local/digest-perf-ram-final.json`, `.local/digest-real-stability.json`, and
`.local/digest-sensitivity-final.json`. Scratch/cache copies are removed; the
pinned library checkouts are unchanged.

### Step 3 performance round

Three fresh Node processes per scenario and recording setting, medians on
Node 26.9.0, complete pinned open-abap-core + ajson, same RAM scratch and shared
Go build cache. Parent `543b1053` was remeasured in an isolated source copy;
"initial step 3" is the preceding round's recorded measurement at `025f26c2`.
The frontend timer includes loading, parsing, syntax, lowering/replay and cache
writes. Full digest inspection and emission occur after the timer. The benchmark
checks all inspection results for completeness/unsupported shapes separately from
its lazy compile counters, and rejects any uncached digest projection.

| Recording off | Parent, remeasured | Initial step 3 | Lazy step 3 | Over parent |
| --- | --- | --- | --- | --- |
| No cache | 1,458.8 ms | 1,807.0 ms | 1,427.7 ms | -2.1% |
| cacheDir cold | 1,721.8 ms | 3,344.6 ms | 1,820.5 ms | +5.7% |
| cacheDir warm | 1,535.0 ms | 2,415.3 ms | 1,599.3 ms | +4.2% |
| Cache file bytes | 526,839 | 6,436,245 | 531,461 | 1.009x |

All requested default-path limits pass. Uncached compilation has **zero** digest
projections. Cold and warm each fingerprint **five of 651 owners**, projecting
5,355 shared nodes in 76.2 / 75.7 ms (including the sub-millisecond filename
inventory). Median owner costs are roughly AJSON 31 ms, SXML reader 16–18 ms,
JSON 11–13 ms, ZIP 10 ms and Unit assertions 5 ms. Each owner is projected once
per compile; 1,000 repeated fingerprints reuse its memo. Resetting a retained
registry's compile discards that memo, and an uncached compile removes it.

A fresh cold CPU profile attributes approximately 35% of classified samples to
registry parsing, 16% to syntax checks, 26% to lowering/final metadata, 12% to
disk-cache/replay work, 4% to digests, 4% to GC and 3% to loading. Parser
combinators remain the largest individual parser site. Cache costs include
fingerprint JSON, portable validation, compression and serialization; further
work there is independent of selective cache keys. Profiles are diagnostic
samples rather than additional timing runs.

| Recording on | Total | Added over recording off | Digest projection | Cache bytes |
| --- | --- | --- | --- | --- |
| No cache | 1,793.2 ms | 365.5 ms (+25.6%) | 0 ms | 0 |
| cacheDir cold | 3,458.6 ms | 1,638.0 ms (+90.0%) | 348.0 ms | 6,550,285 |
| cacheDir warm | 2,217.2 ms | 617.9 ms (+38.6%) | 87.3 ms | 6,550,285 |

Provenance diagnostics retain their separate cost: a cold recorded build requests
492 owners through dense dependency-hit metadata. Its profile is dominated by
manifest expansion, metadata assembly, snapshot cloning and serialization/write
work; these operations are absent from ordinary cache writes. A warm recorded
build requests the five fingerprint owners and reuses stored metadata. The
metadata remains conservative, incomplete where unknown scans exist, and outside
the key. Recording is an explicit diagnostic choice.

All 18 candidate captures have identical emitted-artifact/class-IR hashes,
matching all 18 parent captures. Full post-compile digest inspection also agrees
across all 18 candidate runs, including provenance on/off and cold/warm/no-cache.
Every warm run reuses 251 classes and lowers 21; cold/no-cache lower 272, with
zero diagnostics. Arithmetic regrouping has an explicit regression so lazy
snapshots cannot depend on whether lowering has visited their owner.

The complete sequential frontend/cache/CI-oracle check passes **225 tests**, with
zero failures or skips. The obsolete always-record regression now decodes cache
files to assert that recording-off entries have neither transcript nor metadata,
and that recorded replay marks them incomplete; its 25-test suite passes.
The CI oracle has **62 observations / 60 validated mutations, zero mismatches**.
The full sensitivity matrix passes 14 covered rows / 28 expected mismatches,
with 13 documented coverage limits. The cross-object semantic fingerprint
remains EQUAL under `no-version`, while
location-only fingerprints give MISMATCH in both line modes. All **651** real
objects agree across eight fresh Node/Bun processes (two per runtime and
provenance setting). The isolated unedited `543b1053` typing-proof record compares
byte-for-byte: **239 raw artifacts in each of six modes**. Changed-file budgets,
explicit-path leak scan, whitespace and suite registration pass; `frontend.mjs`
remains **7,055 lines**. The budget command also reports the existing unrelated
`go:charsearch` breach on origin/main; no changed path exceeds its budget.

Reports are local: `.local/digest-lazy-parent-perf-final.json`,
`.local/digest-lazy-perf-final.json`, and `.local/digest-lazy-profile-{off,on}.json`.

## Semantic provenance (step 2)

`compileProgram({provenance: true, ...})` records semantic resolution before
`reg.parse()`, through global definition passes, syntax checking and lowering.
Recording is **off by default**, including disk builds. Enable it with
`provenance: true` or `GOGEN_PROVENANCE=1`; explicit `provenance: false`
overrides the environment. An explicit enclosing `recordProvenance` session
also enables recording.
Provenance remains observational: it supplies step 3 metadata, without changing
cache keys, source hashes or the whole-registry version guard. Selective
per-entry keys remain step 4.

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
The disk IR and memory-session `provenance` field carries only the owner's own rows and edges:
`{rows: [...], edges: ["TYPE NAME", ...]}`. It never persists a transitive query
closure; step 3 separately saves the deduplicated dependency digests. Replay restores these rows/edges, and `provenanceOf()` expands them
against the current registry's provider artifacts on demand. The transcript
still does not participate in cache validation.

Artifact identities (syntax result, parsed type, definition, parsed files and
FM/include metadata) are snapshotted at the end of each recording session.
An artifact subsequently built with recording off gets an `untraced-artifact`
marker on its owner, even when a retained syntax session bypasses checking.
Artifacts first encountered after they were built receive
`artifact-built-before-recording`. Memory/disk replay without an own-row
transcript receives `lowering-built-before-recording`. Disk builds with recording off store no transcript; subsequent recorded replay
marks such entries `lowering-built-before-recording`.

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

### Fix-round validation and recording cost (historical step 2)

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

The cache and replay instrumentation read `GOGEN_CACHE_ORACLE_FAULT`. Its exact accepted values are
**test-only**:

- `no-version`: omit registry sources from the version digest.
- `drop:<regex>`: do the same, and remove object keys matching that JavaScript
  regular expression from word-graph dependency edges and recorded `getObject`
  reads, including misses. Keys use uppercase `TYPE NAME`; the regex has no
  flags. The owner's own source hash and replay checks remain intact.
- `fingerprint-location-only`: restore the old location-only definition
  fingerprint. It may be combined with `no-version` as
  `no-version,fingerprint-location-only` to expose the borrowed-definition seam.
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
| cross-object-same-position-definition | `no-version,fingerprint-location-only` | yes | Covered at the controlled replay seam with a real global definition; strengthened fingerprints stay EQUAL under `no-version`. No cross-pool local borrowing path exists. | `borrowedDefinitionReplay` |
| global-definition-passes | `drop:^INTF ZIF_PASS_` | yes | Covered: eight global interface type passes; terminal resolved type changes unchanged reader lowering. | `emitGo`, `emitJs`; `ZCL_PASS_READER` |
| file-order | `sorted-files` | yes | Covered; first-wins macro expansion changes. | `emitGo`, `emitJs`; `ZCL_ORDER_MACRO` |

The former `same-position-definition` case is now truthfully titled
`same-object-local-definition`, including its regression test. It changes local
constant contents at identical filename/name/start coordinates, and verifies
invalidation both with the global guard and under `no-version`. This establishes
owner-source invalidation only. A cross-object borrowed local-definition
fixture has not been established: frontend local definitions are qualified as
`OWNER:LOCAL` and ABAP local names resolve in their owning class pool. Global
named definitions get ordinary source-word/getObject dependencies. Step 3 covers the fingerprint invariant at the controlled global-definition
replay seam described above; the unavailable cross-pool local path remains
explicitly outside that claim.

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
| Definition fingerprints | Step 3 now guards the owner's semantic digest alongside location; controlled cross-object global-definition replay coverage is established. Normal cross-pool local borrowing remains unavailable. This alone does not cover incomplete provenance. |

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
3. **Resolved-artifact digests and stronger definition fingerprints.** Implemented:
   resolved semantic snapshots, location plus owner digest, dependency digest
   metadata and inspection; global resolution/order and replay sensitivity gates.
4. **Per-entry schema-v3 keys for complete manifests.** Keep global guards for
   incomplete entries. Require the fresh-process oracle and exact control reuse
   assertions (for example, ten dependent classes lower while 290 others reuse).
5. **Bounded real-corpus and performance gates.** Compare unchanged/edited warm,
   cold and recording costs; require zero byte mismatches and measured benefit.
6. **Incremental parser invalidation and dependency precision separately.**
   Test retained registries against fresh cold after multi-edit/inventory/config
   sequences; narrow body/interface hashes only after dedicated cases pass.

Steps 4–6 remain plans. Steps 2–3 add provenance, resolved digests and stronger
replay guards; they implement no selective reuse across registry versions.
