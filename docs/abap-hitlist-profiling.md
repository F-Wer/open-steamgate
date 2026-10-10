# ABAP hit lists from native host profiles

Phase 1 covers OSGo/OSGB native CPU profiles and JSON interchange. Profiling
is opt-in and separate from the application's listener. See
[Go profiling](../tools/gogen/go/profiling/README.md) and
[hit-list input, output and correlation](../tools/hitlist/README.md).

## Reproduce the OData demonstration

Build from the checkout with its pinned libraries and fetched packs. Heavy
commands use the repository's instance-range wrapper. Select your session's
range; the example is the Codex block. Keep scratch under this checkout.

```sh
mkdir -p .local/tmp
export OSD_HEAVY_TMP="$PWD/.local/tmp"
export OSD_HEAVY_RANGE=90-99
node tools/osd-libs.mjs
node tools/osd-fetch.mjs
tools/osd-heavy.sh npm run transpile
tools/osd-heavy.sh node tools/gogen/osgo.mjs
# Record the commit used for the preceding build, not an unrelated current HEAD.
tools/osd-heavy.sh node tools/hitlist/demo.mjs --commit <build-commit> --seconds 3
```

The script launches the real generated host twice: profiling off, then on.
Both application listeners bind to `0.0.0.0`; pprof paths return 404 there.
The enabled profiler opens its own ephemeral `127.0.0.1` listener and serves
standard pprof handlers. The workload is two concurrent loops over the demo
`TravelSet?$top=10`, for two successive captures. Every request must return
200; no synthetic profile supplies the measurement. The script asserts that
both profiles contain ABAP frames and that method/path filtering finds them.
It stops both processes and stores profiles, logs, Markdown and complete
JSON in `.local/hitlist/` (ignored). Do not publish raw operational captures.

```sh
node tools/osd-hitlist.mjs .local/hitlist/before.pb.gz --host osgo --commit <build-commit> --top 10
node tools/osd-hitlist.mjs .local/hitlist/before.pb.gz --tag method=GET --tag path=/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet --top 10
node tools/osd-hitlist.mjs --diff .local/hitlist/before.json .local/hitlist/after.json --top 10
```

The before/after workload is deliberately identical. Differences show
sampling/run variation, not an emitter improvement or a host speedup.
Different profile durations need comparable workload or explicit weight/rate
analysis; the percentage-point delta is only a distribution comparison.

## Measured example

The local native host built from `e98b7d6a` handled 878 and 1019 successful
requests in two three-second captures. The profiles contained 39 and 46
samples; selecting `method=GET` and the query-free `TravelSet` path retained
28 and 27. `go tool pprof -tags` independently reports 280 ms of the first
profile's 390 ms CPU under each request label. The binary's Go VCS stamp is
`e98b7d6a61982f83f9aaf0e4342f8ab57bbe6451`, with `modified=true` while the
hit-list tooling was being added; the compiled native host/package sources
were committed. This is a capture demonstration on a shared host, not a
controlled performance comparison.

First capture, filtered by both labels (TS mappings/counts not supplied):

| Rank | ABAP class=>method:line | Flat % | Cum % | Samples | Top runtime callee |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | ZCL_ZSTG_DEMO_DPC_EXT=>TRAVELSET_GET_ENTITYSET:162 | 14.29 | 14.29 | 4 | osg/gogen/abap.Select |
| 2 | ZCL_ZSTG_DEMO_DPC_EXT=>FILL_STATUS_TEXT:652 | 7.14 | 10.71 | 2 | osg/gogen/abap.Select |
| 3 | ZCL_ZSTG_DEMO_DPC_EXT=>FILL_PHOTO_URL:766 | 7.14 | 7.14 | 2 | osg/gogen/abap.Select |

Unfiltered before/after distribution diff:

| ABAP class=>method:line | Before flat % | After flat % | Delta flat pp | Delta cum pp | Delta samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| ZCL_ZSTG_DEMO_DPC_EXT=>FILL_PHOTO_URL:766 | 5.13 | 2.17 | -2.95 | -2.95 | -1 |
| ZCL_ZSTG_DEMO_DPC_EXT=>FILL_STATUS_TEXT:652 | 5.13 | 2.17 | -2.95 | -5.52 | -1 |
| ZCL_ZSTG_DEMO_DPC_EXT=>TRAVELSET_GET_ENTITYSET:162 | 10.26 | 13.04 | +2.79 | +2.79 | +2 |

Only aggregated public demo facts are tracked. Complete nine-column tables,
JSON interchange and raw native captures stay in the ignored artifact folder.

## Disabled overhead

The host selects `profiling.HTTP` once at startup. Disabled returns the
original handler, so request execution contains no profiling branch, context
copy or label construction. Native report execution similarly retains its
original callback. The allocation test measures an identical no-op handler
before/after selection; this proves **no added profiling allocations**, not
that a whole OData request has no runtime allocations.

The no-op HTTP benchmark measured bare and disabled at 3.138 ns/op, both
0 B/op and 0 allocations/op. Enabled labels measured 591.0 ns/op, 456 B/op
and 4 allocations/op. The unit test also pins handler/callback identity.
These figures describe wrapper overhead, not full request latency.

```sh
cd tools/gogen/go
go test ./profiling -run TestDisabledZeroAllocations -v
go test ./profiling -bench BenchmarkHTTP -benchmem
go vet ./profiling ./osdbind
```

## Scope and limits

OSGo has no Go background-job runner in this revision. The report/job label
helper has tests for both names; OSABAP uses its report label at the top-level
report execution boundary. A future native job host should select that helper
when it starts the job, outside method calls.

The V8 reader is ready for later hosts with ABAP source locations. A V8
profile with only generated JavaScript locations needs source mapping before
it can become an ABAP line hit list; TS/JS line numbers are never silently
reinterpreted as ABAP lines. Ordinary abapiti names dictionaries have no TS
line numbers; the tool preserves the TS file/name and marks the line unknown.
Exact counts keyed only by a site ID require a correlation entry carrying
that site ID. No sample count is presented as an exact invocation count.

Independent GC worker CPU has no ABAP caller and remains unattributed.
Synchronous allocation/GC under an ABAP stack can be attributed. Go build IDs
are retained alongside the explicit build commit, rather than guessed to be
Git SHAs. A4H results can be converted to the documented JSON schema and
compared by ABAP identity or a shared site ID; this change does not contact
or capture an SAP system.
