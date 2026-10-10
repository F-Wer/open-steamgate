# ABAP native hit lists

`node tools/osd-hitlist.mjs cpu.pb.gz` reads symbolized Go pprof protobuf
(gzip or uncompressed), V8 `.cpuprofile`, or this tool's JSON hit list.
No npm dependency or Go subprocess is required. pprof CPU captures already
contain file/line and inline symbols, including the emitter's `//line`
ABAP paths. Namespace owners, local `OWNER:LOCAL` classes and interface
methods are decoded into ABAP identities. Newly emitted local static functions
use an explicit class/method separator; older underscore-only local static
symbols are ambiguous and require a fresh build for reliable attribution.
For an unsymbolized profile, first use
`go tool pprof -proto -output symbolized.pb.gz BINARY PROFILE`.

```
node tools/osd-hitlist.mjs cpu.pb.gz --host osgo --commit <build-sha> --top 20
node tools/osd-hitlist.mjs cpu.pb.gz --tag method=GET --tag path=/sap/opu/odata/sap/ZSTG_DEMO_SRV/ --format json --out before.json
node tools/osd-hitlist.mjs after.pb.gz --format json --out after.json
node tools/osd-hitlist.mjs --diff before.json after.json
node tools/osd-hitlist.mjs cpu.pb.gz --names out/names.json --counts exact.json --min-flat 0.1
```

The columns are rank, ABAP class=>method:line, TS name, TS file:line, flat %,
cumulative %, sample count, top runtime callee, and exact calls. Filters are
applied before aggregation; repeated `--tag key=value` filters are ANDed.
`--top N` and `--min-flat PERCENT` apply after aggregation/diff. `--format`
accepts `markdown` (default) or `json`; `--out` writes instead of stdout.
Host and build commit are explicit provenance, defaulting to the profile
format and `unknown`. Go build IDs are preserved separately: a build ID is
not a Git commit. Profile duration comes from the input, even after filtering.

Flat work is assigned to the nearest ABAP frame, including native runtime
work beneath it. Cumulative work is counted once per distinct ABAP line in
a sample, so recursion does not double-count. Percentages use **all selected
CPU weight**, including runtime-only samples; unassigned work is reported in
the header. Independent GC worker samples cannot be attributed to an ABAP
line, though synchronous alloc/GC work in an ABAP stack can. The top callee
is the runtime frame nearest that ABAP caller, ranked by sample count when known (otherwise metric weight), with
both count and weight retained in JSON. This keeps `ParseI`/`ReplaceStmt` visible even
when their own library callees consume CPU. Sampling does not measure calls.

`names.json` from `abapiti abaplint -o out` maps lowercase generated class
names to `path/file.ts.Symbol.method`. That form has **no TS line number**;
the tool shows `file.ts:?`, never substituting the ABAP line. Enriched entries
may be keyed by class, ABAP identity or `file:line`, with
`{name, file, line, siteId}` for TS location and exact site correlation.
A counts dictionary (or `{counts: dictionary}`) maps site IDs, ABAP identities,
full `file:line`, or basename `file:line` to integers or `{calls}`/`{count}`.
Site IDs require an enriched names entry; absent counts remain null, not zero.

JSON interchange is `schema: "osd-hitlist/v1", kind: "hitlist", metadata,
rows`. Metadata contains host, commit, durationSeconds, metric `{type, unit}`,
totalWeight, totalSamples, tags, and unattributedWeight/Percent. Each row has
key (`CLASS=>METHOD:line`), optional siteId, class/method/file/line, flatWeight,
cumWeight, flatPercent, cumPercent, samples, cumSamples, calls, ts, topCallee.
An A4H converter can provide the same fields (unknown counts/weights as null).
Diff matches shared site IDs first, then ABAP identity, and includes added
and removed lines. Deltas are after minus before; percentage deltas are
percentage points, weight deltas are null across unlike metrics. Compare
similar workload and durations: percent deltas alone are not speedups.
Keep complete JSON for diff: rows removed by `--top` cannot be recovered.

V8 sample parent chains and inline Go frames are leaf-first. V8 uses
`timeDeltas` as CPU weight, falling back to sample count when absent. V8
line numbers are zero-based and converted to one-based. ABAP URLs can be
aggregated directly; ordinary TS/JS profiles have no ABAP location unless
the host supplies ABAP source locations. Such samples stay unattributed.
V8 has no pprof labels and rejects `--tag` rather than silently ignoring it.

Go labels are limited to CPU and goroutine profiles; see
[Go runtime/pprof](https://pkg.go.dev/runtime/pprof). The protobuf reader
follows the [pprof schema](https://github.com/google/pprof/blob/main/proto/profile.proto),
including packed repeated fields and multiple inline lines per location.

Gate: `node node_modules/mocha/bin/mocha.js test/osd-hitlist.mjs`; registered in `gogen-osgo.json`.
See [native capture demonstration](../../docs/abap-hitlist-profiling.md).
