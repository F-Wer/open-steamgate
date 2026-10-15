# Global-first object-cache checks (step 4b.1)

Ordinary disk-cache compilation tries the existing exact global source guard and
ordered program replay before consulting v3 candidates. A successful replay
returns the cached lowering without creating a v3 key computer, resolving its
namespace, reading its candidate index or reconstructing K3. A global/replay miss
still takes the existing observational v3 path and ordinary production lowering.
Selective production reuse across source versions remains future work.

`GOGEN_CACHE_SHADOW_VALIDATE=1` preserves exhaustive predictions, including global
hits, and compares each successful prediction with an isolated cold lowering at
the class seam. `GOGEN_CACHE_SHADOW_EXHAUSTIVE=1` requests exhaustive probing
without the extra cold lowerings, for audit diagnostics. Neither setting enables
production v3 reuse or relaxes completeness. K3 inputs, completeness reconstruction,
audit refusals, supplied/program replay and independent cache-disabled output
comparison keep their existing contracts.

The existing generation-directory hash is the content certificate; another
manifest or cache payload format is unnecessary. It hashes the ordered effective
loaded objects, their dependency roles, and ordered filename/raw-text hashes,
alongside registry config and actual tool identity. JSON framing separates names
and contents. The new `gogen-global-content-1` domain ignores older generation
keys. The loaded immutable snapshot binds the certificate to the registry
inputs used by compilation, rather than to a preliminary disk scan. Known gap,
present on main before this step and not changed by it: CDS sources
(`.ddls.asddls`) are read outside the registry for the SQL view mapping and are
not in the snapshot, so an edit to one is not seen by the global guard (follow-up
fix: hash them into the generation key). Mtimes and file sizes
are never reuse authority. Effective additions, removals, provider changes and
object/file/layer order changes invalidate it. Selection and other program inputs
remain checked by replay; excluded test sources do not enter the loaded snapshot.

Tool identity hashes actual tool sources, locks and installed transpiler/core
builds, with filenames and content hashes framed separately. Its common portion
also binds Node/V8 identity. The global and source-independent variants share
that common file hashing; only the global variant includes source-library pins.
The v3 variant is resolved lazily. New tool-identity domain separation naturally
isolates old v3 namespaces while leaving K3's semantic definition unchanged.

Entry publication and verification are unchanged: successful portable lowerings
are written atomically with a payload checksum and a key bound to the certificate.
A damaged key, payload, graph, missing file or interrupted write causes a miss.
A failed compile cannot manufacture a reusable unchecked entry. Entries persisted
for an edited generation take the global path on its next unchanged compilation.
There is no new independent certificate file whose generation could race with an
entry, and no need to rewrite successfully replayed entries.

Changes are in `frontend-object-cache.mjs` (guard, shared tool hashing and order),
`frontend-v3-shadow.mjs` (lazy namespace/key setup), `frontend-v3-bench.mjs`
(explicit timing modes), and the v3 audit/global-first tests. `frontend.mjs`,
`frontend-session.mjs` and provenance modules are unchanged.

The new tests cover global-first versus exhaustive behavior, a same-size edit
with restored mtime, effective layer order, dependency roles, new named
implementor/FM-owner inputs, certificate corruption, missing payloads, and a
same-version actual tool-source edit in fresh processes. Existing sensitivity
faults still have to produce real cold disagreements.

## Measurement

Use the repository heavy wrapper with `GOCACHE=/mnt/ssd-510/osg/go-build`,
`TMPDIR=/mnt/ram/stoker`, `OSD_HEAVY_RANGE=50-59`, and the benchmark scratch
TMPDIR under `/mnt/ram/stoker/keyprof`, as in the local profiling report.

```sh
node tools/gogen/frontend-v3-bench.mjs --rounds 3 --production --compare-global --report <path>
node tools/gogen/frontend-v3-bench.mjs --rounds 3 --global-only --report <path>
node tools/gogen/frontend-v3-bench.mjs --rounds 3 --report <path>
```

The default mode remains exhaustive and requires nonzero cold-validated
predictions. `--production` times ordinary compilation; `--global-only` times
`provenance:false` as a contemporaneous global-cache reference. All modes use
three fresh-process rounds per unchanged, method-comment and interface-constant
scenario, each independently primed and checked against a fresh cold output hash.
`--compare-global` adds an independently primed global-only reference beside each
production sample, alternating their execution order between rounds. Output hashes
cover emitted artifacts and per-class IR. `recomputeMs` measures
v3 probing, including candidate I/O, saved/current checks and trial replay; lazy
key-computer initialization now falls inside that timer. Whole-frontend time
includes setup, lowering and persistence but excludes final artifact capture.

Measured on Node v26.9.0 against the same pinned public corpus as the local
profile, in three fresh-process rounds per scenario. The before production run
uses the original cache implementation plus the benchmark's explicit timing
option; both before and after exclude exhaustive cold lowerings from the timed
compile. The after column is the paired campaign. Values are medians in ms.

| Scenario | Key check before | Key check after | Frontend before | Frontend after |
| --- | ---: | ---: | ---: | ---: |
| Unchanged | 1,613.8 | 1.0 | 3,761.5 | 2,416.3 |
| Method comment | 1,919.7 | 1,606.5 | 5,816.7 | 4,818.7 |
| Interface constant | 1,675.8 | 1,691.2 | 5,812.5 | 5,236.9 |

All nine paired production outputs and all nine reference outputs equal their
fresh cold outputs. Actual production reuse/lowering remains 251/21 unchanged
and 0/272 after either edit. The unchanged probe time covers only the 21 ordinary
fallbacks: the 251 global hits perform no v3 candidate/key/query/digest work.
Edited v3 predictions remain 234/38 and 231/41; they are observational.

The paired unchanged global-only median is 2,409.9 ms, making production
**1.003x**, within the requested 1.10x relative median target. This is not robust
latency acceptance: the three adjacent production/global pairs were
5,391.6/7,444.6, 2,305.6/1,781.4 and 2,416.3/2,409.9 ms. Host load reached about
66 on 16 threads and even repository reads stalled. The historical report's
1,965.4 ms global median implies a 2,162.0 ms absolute budget; this campaign's
2,416.3 ms median **misses that historical absolute budget** (1.229x).

The first, unpaired after campaign also remains recorded: key checks
1.0/1,822.7/1,795.7 ms and frontends 2,613.1/5,506.9/5,524.4 ms for the three
scenarios respectively. Its unchanged range was 2,148.2–2,902.7 ms. A separate
three-round global-only campaign measured 1,765.9 ms unchanged. These differing
groups show why an unqualified performance pass would overstate the evidence.
Edited whole-frontend medians improved in both after campaigns; the interface
key-check median is essentially unchanged and remains expensive. Finer edited
validation and recorder overhead remain separate work.

Raw reports and logs are local under `.local/keyprof/`: `global-first-before.json`
(exhaustive baseline), `global-first-before-production.json`,
`global-first-after-production.json`, `global-first-global-reference.json`,
`global-first-after-paired.json`, and `global-first-after-exhaustive.json`.

## Gates

- Requested cache/oracle/provenance/replay/query/digest suites, with
  `--test-concurrency=1`: **139 passed, zero failures/skips**. The independent CI
  oracle ran 60 mutations with zero mismatches in both line modes. The sensitivity
  matrix detected all 14 covered fault rows (13 existing explicit exceptions).
- Strengthened final global-first regressions: **6 passed**, including exactly
  equal restored mtime and same-size changed content.
- `node tools/gogen/semantics.mjs`: passed.
- `npx tsc -p tsconfig.gogen.json`: passed.
- `npx mocha test/gogen-host-io.mjs`: 3 passed; its sole failure is the explicitly
  allowed local `../gperf/node_modules/@abaplint/core/build/src/rules/downport.js:38:
  crypto` path. No additional builtin-import violation was found.
- `node tools/osd-size-budget.mjs --changed origin/main`: exit 0; only the existing
  untouched `go:charsearch` overage on `origin/main` is reported.

The default exhaustive three-round benchmark also passed all nine fresh cold
comparisons: **2,148 predictions cold-validated**, with zero disagreements and the
same 251/21, 234/38 and 231/41 prediction counts. Its key/frontend medians were
1,623.1/4,470.7, 1,699.9/5,352.9 and 1,609.9/5,342.7 ms. Exhaustive mode deliberately
retains the full validation cost even on global hits.

The final changed-file leak scan (`--paths`) passed: **7 files, zero findings**.
The size-budget check exited 0. Logs are `global-first-leak.log` and
`global-first-size.log`.
