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
object inventory and source hashes. Tool identity includes `tools/gogen` sources
and the top-level tools' `.mjs`/`.ts` files. It excludes Git HEAD and Git tree
hashes: a docs-only commit preserves identity; changing tool contents changes it.
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
Some supported syntax is still a gogen refusal (including pool constants and
macro-call markers); those refusals are part of the comparison.

For every scenario the harness copies the corpus to scratch, primes the cache in
a fresh child, edits the copy, compiles warm in another fresh child, and compiles
without cache in a third. Each child has a fresh registry. It compares UTF-8 bytes
of Go, JS (or its emitter refusal), broken/skipped/partial/diagnostics/missing, and
final RTTI/table/lock/exception/CDS/AMC/interface metadata. It repeats with
`GOGEN_NOLINE` unset and set. A no-edit control proves disk reuse. Reorder cases
use the supplied-registry API to change only the order of files within an object.

All mutation kinds run individually, followed by a body/pool/INCLUDE multi-edit
sequence and a return to the original corpus. Reports contain the seed, full edit
descriptors, selected real classes and pins, first differing artifact and byte
offset, and `loweredClasses`/`reusedClasses` counts. Each result is saved as it
finishes. The CLI exits 1 on a mismatch and throws on capture/infrastructure errors.
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

`GOGEN_CACHE_ORACLE_FAULT=no-version` is **test-only** and is read solely in the
cache implementation. It removes registry sources from the version digest while
retaining ordinary object keys and replay checks. The implicit pool type mutation
then produces stale reuse and a Go mismatch; the harness's test requires this in
both line modes. Never enable the fault for normal builds.

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
| Definition fingerprints | Replay fingerprints include name/file/start position, not semantic contents. A same-position edit needs the global version today. |

Cached DDIC types/scopes can also hide earlier reads, and global OO resolution
passes make stopping/order behavior a semantic input. Passing mutation tests
does not prove that an incomplete dependency manifest is safe.

## Six-step plan

1. **Regressions and oracle, with global invalidation.** This change: implicit
   pools, same-position definitions, file order, compiler identity, every mutation
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
