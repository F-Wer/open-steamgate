# Native profiling

Standard-library-only opt-in pprof listener and HTTP/report labels. OSGo
selects this at startup with `-pprof` or `OSD_PPROF=1`. `-pprof-addr`
selects a separate listener (default `127.0.0.1:6060`); legacy
`OSGO_PPROF=6060` or `OSGO_PPROF=127.0.0.1:6060` also enables it.
The listener accepts only numeric loopback addresses (or `localhost`,
normalized to IPv4 loopback). Wildcards and network addresses are refused
with a clear startup error, regardless of `OSD_BIND` or `-addr`.
No profiler handler is mounted on the application HTTP or HTTPS listener.

HTTP labels are `method` and `path` (escaped path, query omitted). Report
labels are `report` and, when supplied by a job host, `job`. No body, query,
user or selection-screen values become labels. OSABAP enables report labels
when `OSABAP_CPUPROFILE` is set or `OSD_PPROF=1`; it retains its existing
file-based CPU capture. OSGo currently has no background-job execution seam;
`Report` is ready for that host to select at job startup.

`HTTP(false, next)` returns `next` itself; `Report(false, ..., next)` returns
`next` itself. There is no disabled execution wrapper or per-call label
allocation. `go test ./profiling` checks labels, listener isolation and
allocation equality; `go test ./profiling -bench . -benchmem` compares the
bare and disabled paths. Enabled labels intentionally allocate. Labels are
used by CPU and goroutine profiles; heap/GC worker samples often have no
request label and cannot be assigned to an ABAP caller.

Capture: `curl -o cpu.pb.gz 'http://127.0.0.1:6060/debug/pprof/profile?seconds=5'`.
Convert with [osd-hitlist](../../../hitlist/README.md).
