# osdbind

Which address OSGo listens on, the Go half of `tools/osd-bind.mjs`.

- `-addr` given: that address only.
- `OSD_BIND` unset or `localhost`: loopback, `127.0.0.1` plus `::1` when the
  host has IPv6, so a client resolving `localhost` either way connects.
- `OSD_BIND=0.0.0.0` (containers) or any other address: that address.

`Selected` picks the addresses, `ListenAll` opens one port on each (the first
must open, a missing IPv6 loopback is skipped), profiling uses its own loopback-only
listener in `go/profiling`, `ListenFlag` opens a `-listen` value (a
bare port takes the bind), `Hint` is the loopback-only startup line and
`Describe` the log line.
No imports outside the standard library; `go test ./osdbind/...`.
