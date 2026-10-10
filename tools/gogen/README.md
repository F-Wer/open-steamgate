# gogen: a Go backend for transpiled ABAP (spike)

> **On main (2026-09-29/30), landed in three parts:**
> the core (the generator, the IR, the Go runtime `go/abap`, the semantics
> harness, the benchmark runner), then the OSGo host (`osgo.mjs`,
> `osg-build.mjs`, `gateway.mjs`, `go/cmd/osgo`, `go/apc`, parity), then
> osabap (the CLI/TUI binary, `osabap.mjs`, `go/cmd/osabap`,
> `go/termgui`, `apps/`, `docs/osabap-native.md`). CI: `.github/workflows/gogen.yml`
> and the `osgo-host` job of `tests.yml`, which gates every change on one
> gateway request through Go; `osgo-parity` in `gogen.yml` runs OSG's
> suites against OSGo on a manual dispatch only. The OSGo tools need
> the packs fetched (`node tools/osd-fetch.mjs`; `osg-build.mjs` refuses an
> unfetched pack as `UNFETCHED`, as the Node build does) and a generation
> (`npm run transpile`). The root is `OSG_HOME`, else `OSD_ROOT`, else the
> working directory (`home.mjs`).

A measurement, not a product. The question was whether a second backend for
the abaplint transpiler, one that emits Go instead of JavaScript, is worth
building. The rationale is the research page "Куда транспилировать ABAP".
This folder answers it on a small, controlled subset.

```
node tools/gogen/run.mjs            # ABAP -> IR -> Go, and the same ABAP through the JS transpiler
```

Needs Node (`node_modules` of the checkout, for `@abaplint/core` and
`@abaplint/transpiler`) and Go >= 1.26. Nothing is written outside this
folder: `.out/` and `go/cmd/bench/zz_generated.go` are generated and ignored.

## Shape

```
samples/*.clas.abap
  -> @abaplint/core (parse, syntax, scopes)          reused, not rewritten
  -> transpiler's Rearranger (operator precedence)   reused, not rewritten
  -> frontend.mjs: IR                                typed, calculation type decided, conversions explicit
  -> emit-go.mjs: Go                                 spells the IR, decides nothing
  -> go/abap: runtime                                ABAP semantics where Go's differ
```

The IR is the part that matters for the real thing. The calculation type of
every arithmetic expression is fixed in the front end, and it **includes the
target**. That is the rule ANORMALIES measured on A4H: `lv_f = lv_i / 2` is
1.5 and the `i` version is 2. So a backend never tests a type at run time.
Values are plain Go values: `int32` for `i`, `float64` for `f`, a slice for a
standard table. A method is a function taking the `Session` first. The
Session is the roll area and carries `sy`, so any goroutine can run any
session.

Subset, grown until two demo scenes compile unchanged: `i`, `f`, `int8`,
`string`, `c`, `x`; structures and standard tables of anything in the
subset; instance and static classes, attributes, constructors with DEFAULT
parameters, interface methods and constants; `DATA( )` inline, `CONV`,
`VALUE` (nested `VALUE #( )` too), string templates and `&&`; `IF`, `CASE`,
`DO`, `WHILE`, `LOOP AT ... INTO`, `APPEND`, `READ TABLE ... INDEX`,
`TRANSLATE`, `EXIT`, `CONTINUE`, `RETURN`, `CLEAR`; method calls with
positional, named and EXPORTING/IMPORTING parameters; `sin cos tan sqrt exp
log abs sign floor ceil trunc frac nmax nmin lines strlen`;
`sy-index sy-tabix sy-subrc`. Anything else is `Unsupported` with its name,
and a method that calls a refused one is refused in turn. Refused on
purpose until measured: `i` -> `string` (the sign goes to the end there).
Packed numbers came later and are their own section below.

## Measured, 2026-09-23

16-core x86-64 workstation (WSL2), Node 26.9, Go 1.26.0,
`@abaplint/transpiler` 2.13.89 from npm (without the plain-arithmetic flag of
the `transpiler-codegen` fork).

| work (median) | Go | JS | JS / Go | same answer |
| --- | ---: | ---: | ---: | --- |
| plasma frame, 320×200, sin/cos/sqrt per pixel | 1.66 ms | 23–25 ms | 14–15× | yes |
| fib(25), recursive static calls | 0.24 ms | 22–25 ms | 95–105× | yes |
| primes to 50 000, nested WHILE with MOD | 1.6 ms | 91 ms | 55× | yes |
| 1 000 000-row table: APPEND, LOOP, READ INDEX | 8.6–10.7 ms | 330–370 ms | 35× | yes |

Plasma frames per second, one Session per goroutine, nothing shared:

| JS, one thread | Go ×1 | ×2 | ×4 | ×8 | ×16 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 40 | 588 | 1027 | 1661 | 2350 | 2798 |

Build and size: front end + emit 150–190 ms, `go build` 0.16–0.74 s (warm
or cold cache), binary 2.0 MB stripped, of which almost all is the Go
runtime. The generated Go is 4.9 KB; the transpiled JS is 14.2 KB.

Where the time goes, in order of the ratios. A call is the costliest thing
in the JS output: every method is `async`, and every call is an `await` with
boxed arguments (fib, 95–105×). A table row is an object (35×). Arithmetic
through the operator protocol costs 15–55×. Plasma is the smallest gap
because `Math.sin` is the same cost in both.

## Language or model? The same IR emitted as JS

`emit-js.mjs` writes JavaScript from the same IR, with the same value model
as the Go backend: numbers instead of boxed ABAP values, synchronous calls
instead of an `await` on every one, the calculation type decided at compile
time, structures as objects copied on a move. The runtime (`js/abap.mjs`)
follows `go/abap` line for line. It answers the same as Go on all 21
semantic cases and on every frame of both scenes.

| work | transpiler JS | JS from the IR | Go | transpiler / IR | IR / Go |
| --- | ---: | ---: | ---: | ---: | ---: |
| plasma kernel (sample) | 25.5 ms | 3.6 ms | 2.1 ms | ×7 | ×1.7 |
| fib(25) | 24.0 ms | 0.96 ms | 0.24 ms | ×25 | ×4.1 |
| primes to 50 000 | 93 ms | 3.4 ms | 1.6 ms | ×27 | ×2.1 |
| table of 10⁶ rows | 311 ms | 11.3 ms | 8.7 ms | ×28 | ×1.3 |
| scene glitch, a frame | 205 µs | 16.4 µs | 14.2 µs | ×12.5 | ×1.15 |
| scene plasma, a frame | 2527 µs | 218 µs | 117 µs | ×11.6 | ×1.9 |

So most of the gap is the model, not the language: the same IR in JS is
7-28 times faster than today's transpiler output, in the browser too. Go
adds 1.2-4 times on top, most on calls (fib), and every core of the
machine on one session's work.

## Go in the browser (wasm), measured, 2026-09-24

`node tools/gogen/wasm.mjs [plasma glitch] [--frames 1024] [--warmup 256]`
builds one scene three ways and runs each in headless Chromium 151
(Playwright), one after the other, each in a fresh context: the scene through
gogen to Go, `GOOS=js GOARCH=wasm` (`cmd/scenewasm`, a `syscall/js` entry
exporting `goScene.renderFrame(t, gt, pos16)` and `goScene.checksum()`); the
same IR as JS (emit-js + `js/abap.mjs`); and the transpiler's JS with
`@abaplint/runtime`, which runs in a page as it is. The page
(`wasm-page.mjs`) feeds all three the contexts of the A4H recording, computed
once in the page, times every frame alone with `performance.now()` (the page
is cross-origin isolated, so the clock is 5 µs, not 100 µs), and reduces each
frame to one FNV-1a checksum over the fields `scenes.mjs` compares with A4H:
Go computes it in Go, the JS runtimes in JS.

| scene | runtime | median ms/frame | p90 | fps (1/median) | startup ms (load + 1st frame) | frame checksums equal |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| plasma | Go → wasm | 0.59 | 0.87 | 1695 | 198 (191 + 7) | 256 of 256 |
| plasma | JS from the IR | 0.25 | 0.37 | 4082 | 13 (6 + 7) | 256 of 256 |
| plasma | transpiler JS | 2.62 | 3.33 | 382 | 55 (33 + 21) | 249 of 256 |
| glitch | Go → wasm | 0.045 | 0.10 | 22 000 | 155 (151 + 4) | 64 of 64 |
| glitch | JS from the IR | 0.015 | 0.03 | 67 000 | 10 (9 + 1) | 64 of 64 |
| glitch | transpiler JS | 0.18 | 0.30 | 5 600 | 35 (30 + 5) | 64 of 64 |

1024 frames timed after 256 of warm-up, the recording's frames in a cycle;
the machine was shared (load 6-8 on 8 cores), and two more runs put plasma
Go→wasm at 0.73 and 1.01 ms and the rest within ±40 %, the order never
changing. Glitch is close to the clock's 5 µs grain. The seven plasma frames
the transpiler gets different are the seven of
ANOMALY-2026-09-17-integer-division-not-rounded (10, 41, 161, 177, 192,
208, 223); Go→wasm and the IR's JS agree on every frame, and both equal A4H
by `scenes.mjs`. Natively the same Go takes 155 µs (plasma) and 17 µs
(glitch).

So in a browser **the IR's JS is the fast one**: 2-3× Go→wasm, 10× the
transpiler. Go's wasm port is single-threaded, has no goroutine parallelism
to offer here, and allocates through its own GC in linear memory; a plasma
frame builds 4000 `rgb(...)` strings. Go→wasm is still 4-5× the transpiler.

Size (bytes; gzip -9, brotli q11; the JS bundled by Bun, whitespace and
syntax minified, names kept since the runtime looks classes up by name):

| file | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| plasma, Go wasm | 5 357 362 | 1 529 553 | 1 143 885 |
| plasma, Go wasm, `-ldflags="-s -w"` | 5 255 931 | 1 502 020 | 1 127 916 |
| glitch, Go wasm, `-s -w` | 5 193 461 | 1 482 476 | 1 113 013 |
| `wasm_exec.js` (Go's loader) | 16 992 | 4 348 | 3 752 |
| plasma, JS from the IR | 10 229 | 3 275 | 2 964 |
| plasma, transpiler JS + runtime | 523 110 | 81 679 | 68 396 |
| (a `syscall/js` hello with `math.Sin`, `-s -w`) | 1 926 655 | 575 112 | 443 561 |

`-s -w` saves 2 % (wasm has no DWARF worth the name to strip). The Go
runtime is a 1.9 MB floor; the other 3.3 MB is `go/abap` itself, which
imports `net/http`, `crypto/tls`, `database/sql`, `regexp` and
`encoding/json` for the kernel around the scene, and the linker keeps what
an interface or `reflect` can reach. A scene alone does not need them; a
host does. Startup follows size: 150-260 ms to compile and instantiate
5 MB, against 6-12 ms to parse the IR's 10 KB. `go build` for js/wasm:
8 s cold, 0.4 s warm. TinyGo is not installed here and was not tried.

**The database split.** `go/abap` compiles for `js/wasm` and `wasip1/wasm`
because the one non-portable call, the driver, sits behind build tags:
`db_sqlite.go` (`//go:build !wasm`) opens `modernc.org/sqlite`, whose
`modernc.org/libc` has no wasm files; `db_wasm.go` (`//go:build wasm`) has
`openSQL` answer "no database in this build (wasm)", so `OpenDB` and
`OpenDBFile` return that error and a statement then fails with the
existing "the host did not open a database". Everything above `openSQL` is
`database/sql` and does not know which driver it got: a driver that calls
sql.js through `syscall/js` (the database the browser preview already uses),
registered in `db_wasm.go`, is the whole seam. It is not written. The native
build is unchanged.

What a whole OSGo in the browser would still need: that sql.js driver
(`database/sql/driver` over `syscall/js`, synchronous, since sql.js is);
the host's `net/http` server replaced by a service-worker `fetch` handler
calling the ICF dispatcher (the preview's shape, `web/preview-backend.mjs`),
and APC over a `MessageChannel` instead of a WebSocket; the object store,
media (`WWWDATA_IMPORT`) and the file-backed parts read through a host hook
instead of `os` (as `abap.W3MI_LOADER` does for the JS preview); the
`CL_HTTP_CLIENT` path over `fetch`; and, for size, the kernel split so that
a page that only draws does not link `crypto/tls`. Measured here, it would
arrive at 5 MB before the first application class and run slower than the
IR's JS in the same page, so for the browser the IR emitted as JS is the
better target and Go the one for a server.

### Planned: OSGo in the browser (a later wave, decided 2026-09-24)

Speed is not the whole story. Two runtimes cost twice: `js/abap.mjs` follows
`go/abap` line for line, so every semantic rule is written twice. The page
the preview runs today is the transpiler's output, 2.62 ms a plasma frame;
Go → wasm at 0.59 ms is 4.4 times that, with the same semantics as the server
and the Pi. So the direction, once the current order is done (upstream,
daemons, incremental rebuild of Z code, ADT):

- **Go is the one product runtime everywhere**: server, Pi, and the browser
  through wasm.
- **IR-JS is kept as an oracle**, not a product: `semantics.mjs` runs every
  pinned case on Go and on JS against A4H, and a second independent runtime
  keeps catching mistakes. It stays green; it is not grown.
- **What the browser build needs**, each a step of its own:
  1. a `database/sql` driver over sql.js through `syscall/js`, registered in
     `db_wasm.go` (the seam is there);
  2. a service-worker `fetch` handler calling the ICF dispatcher instead of
     the `net/http` server (the shape of `web/preview-backend.mjs`);
  3. APC over a `MessageChannel` instead of a WebSocket;
  4. files and media (`WWWDATA_IMPORT`, the object store) through a host hook
     instead of `os`, as `abap.W3MI_LOADER` does for the JS preview;
  5. `CL_HTTP_CLIENT` over `fetch`;
  6. a kernel split so a page that only draws does not link `crypto/tls`
     (the Go runtime alone is 1.9 MB, 444 KB brotli).

## Demo scenes against A4H

`node tools/gogen/scenes.mjs <scene>` compiles one scene of ZO4D straight out
of `packs/o4d/upstream` (the interface and the class, nothing rewritten),
gives its `render_frame` the context of every frame of the A4H recording
(`t`, `gt`, and `pos_16` computed like `ZCL_O4D_APC_HANDLER=>CALC_BEAT_INFO`),
and compares lines, rects and texts number by number with the recording.

| scene | frames equal to A4H, Go | frames equal to A4H, JS (npm 2.13.89) | Go a frame | JS a frame | JS / Go |
| --- | ---: | ---: | ---: | ---: | ---: |
| glitch | 64 of 64 | spot-checked equal | 14 µs | 205 µs | ×14.5 |
| plasma | **256 of 256** | 249 of 256 | 140 µs | 2527 µs | ×18 |

The seven plasma frames the JS runtime gets wrong (10, 41, 161, 177, 192,
208, 223) are exactly ANOMALY-2026-09-17-integer-division-not-rounded: a
`/` inside an integer expression keeps its fraction there. The Go backend
rounds it, because the IR computes the calculation type of the whole
expression, target included, which is what A4H does.

The f format of a string template was measured on A4H before it was
written (fifteen values, `go/abap/fmtf_test.go`): seventeen significant
digits, always positional, trailing zeros dropped.

### The whole demo, 2026-09-23

`node tools/gogen/demo.mjs [scene ...]` compiles all of ZO4D (83 classes:
the APC handler, the demo director, every effect) into one Go binary and one
JS module, and plays every A4H recording through the handler's own path
(`BUILD_RENDER_CTX`, `GET_EFFECT_AT_BAR`, `RENDER_FRAME`, `FRAME_TO_JSON`).
Each scene runs in a process of its own under a 4 GB / 120 s ceiling, since
a loop the compiler gets wrong grows a table without end (one did, and took
the WSL machine with it).

| | frames equal to A4H | scenes equal frame for frame |
| --- | ---: | ---: |
| Go with sin/cos from glibc (`demo.mjs --libm`) | 3840 of 3840 | 25 of 25 |
| Go, pure (fdlibm port, the default) | 3422 of 3840 | 17 of 25 |
| JS from the same IR (V8's sin/cos) | 3422 of 3840 | 17 of 25 |

Pure Go and JS agree with each other everywhere; where they differ from
A4H it is the last bit of `sin` (a known difference). The triangle order
of amiga_ball, amiga_ball_2 and sierpinski used to differ as well: `SORT
... BY z` without `STABLE` leaves equal keys in the kernel's order
(`[3,2,1,0] [6,7,5,4] ...`). The demo now carries a second key
(vivid-vibes#5, activated in `$ZO4D` and re-recorded on A4H).

What it took, each measured before it was written:
- attribute `VALUE`s set when the object is made (a `mv_scale` left at 0
  stepped a `WHILE` by 0);
- `x IS NOT INITIAL` read its `NOT` twice;
- `DATA(x) = frac( f )` is an f: abaplint types the six numeric built-ins by
  a fixed return (#4302), the IR types the declaration from its source;
- **sin and cos are glibc's on A4H.** The Go build calls glibc only when asked (`node demo.mjs --libm`, cgo); by default it is the pure-Go fdlibm port, the same on every platform, and the difference is known (ANORMALIES sin-cos-libm). The seed chains of constellation and
  ignition (`seed = frac( sin( seed * 12345 + i ) * 43758 )`) diverge from
  V8 at exactly the step where glibc and fdlibm differ, and a build that
  calls glibc through cgo reproduces them frame for frame. Go's own
  `math.Sin` differs from both in the last bit for 43 % of arguments; the
  pure-Go default is a port of fdlibm, bit-equal to V8 on 194 621
  arguments. A pure port of glibc's sin would give JS and cgo-free Go the
  same answer as A4H.
- x fields: `i MOD 256` into x LENGTH 1, `BIT-XOR`, x -> i unsigned, all
  measured on A4H.

Speed, 2026-09-23, each runtime alone on one machine with the same tool
(`tools/o4d-profile.mjs`: the median of 60 frames a scene over the demo's
own WebSocket channel, full frame with `FRAME_TO_JSON`, 26 scenes; the
stands are `o4dserve.mjs` / `o4dserve-js.mjs` in front of an OSG server):
JS from the IR is x2.9 the transpiler runtime (faster on every scene,
x1.2-x8.8), Go x5.8 (x1.5-x29) and x1.9 the IR's JS. A first comparison
against `demo.mjs`'s in-process averages said x1.5 and "slower on four
scenes"; that was two instruments, not two runtimes. Go was ten times
slower than JS on the JSON-heavy scenes until a loop that only appends to
a local string got a `strings.Builder`. Peak memory of a whole recording
(harness keeps every frame): Go 10-430 MB, JS 60-1330 MB.

## Semantics: what the two backends answer

Every row below was measured on A4H with ABAP Unit (2026-09-23).
| case | ABAP rule | Go | JS |
| --- | --- | --- | --- |
| `7 / 2`, `-7 / 2`, `5 / 3`, `-5 / 3` (i) | 4, −4, 2, −2 | same | same |
| `0 / 0`, `1 / 0` | 0, CX_SY_ZERODIVIDE | same | same |
| `7 DIV -2`, `7 MOD -3` | −3, 1 | same | **−4, 2** |
| `-7 DIV -2` | 4 | 4 | **3** |
| `MOD` with negative operands | never negative | same | same |
| f 2.5 / −2.5 / 1.4999 → i | 3 / −3 / 1 | same | same |
| f 3e9 → i | CX_SY_CONVERSION_OVERFLOW | same | **3000000000** |
| i 3 / i 2 into f | 1.5 | 1.5 | 1.5 |

The JS disagreements are recorded in ANORMALIES. DIV and MOD with a
negative divisor are fixed upstream in abaplint/transpiler#1885; f -> i
without an overflow is a question for Lars, not a patch.

## One request of OSG's gateway, 2026-09-23

`node tools/gogen/gateway.mjs` compiles OSG with its libraries (821
classes, open-abap-core, open-abap-odata and the rest), registers the SEGW
services and sends `GET /sap/opu/odata/sap/ZSTG_DEMO_SRV/?$format=json`
through `ZCL_STG_DISPATCHER`. The Go binary answers what OSG answers:

```
200 OK
application/json
{"d":{"EntitySets":["TravelSet","BookingSet","StatusVHSet","PhotoSet"]}}
```

On the way: the SEGW registry, the URL parser (FIND REGEX), the model
registry (`CREATE OBJECT ... TYPE (name)`), the `_MPC_EXT` -> `_MPC` ->
`/IWBEP/CL_MGW_PUSH_ABS_MODEL` chain (inheritance, `SUPER->`, the
constructor chain), the model's `DEFINE` with its entity types, properties,
annotations and actions, and `BIND_STRUCTURE` through RTTI. What that took,
each measured on A4H where the rule could be argued and pinned in
`semantics.mjs`:

- `CREATE OBJECT` static and by name, through a class registry; the name is
  taken as written (lower case is CX_SY_CREATE_OBJECT_ERROR).
- Single inheritance: the superclass embedded, one Go interface per class
  that has subclasses, `self` for the calls a method makes on `me`, `SUPER->`
  bound statically, `?=` / `CAST` checked, an initial reference widened stays
  initial. In a superclass's constructor, `me->m( )` is the superclass's own.
- Classic exceptions: `RAISE name`, `EXCEPTIONS ... = n` / `OTHERS`,
  `RECEIVING`.
- `RETURN`, `EXIT`, `CONTINUE` out of a `TRY` (a closure in Go, so they come
  out as codes); `ASSERT`; structured constants; aliases; interfaces that
  include interfaces; `csequence` / `clike` parameters; call chains.
- Two kernel services in the host, since open-abap-core writes them as
  `WRITE '@KERNEL ...'` JavaScript: `describe_by_name` for structures (from
  a table the compiler builds out of the registry: the dictionary's
  structures and the classes' `TYPES`) and `unescape_url`. Every other
  `@KERNEL` line is a stub that dumps: it was a silent no-op before, which
  ran the ABAP around it on values nobody set.

The call closure from `ZCL_STG_DISPATCHER=>DISPATCH` (`closure.mjs`), as
of 2026-09-23 after class-based exceptions: 116 methods reachable, 114
compiled with 30 statement stubs inside them, 2 whole methods stubbed
(`/IWBEP/CX_MGW_BASE_EXCEPTION=>IF_MESSAGE~GET_TEXT`,
`/IWBEP/CL_MGW_PUSH_ABS_MODEL=>DEFINE`). What is left: `SPLIT` into several
targets (6), `COMMIT` / `ROLLBACK`, `CONDENSE`, `SHIFT`, `d` and `t`
conversions and offsets, a numeric `MSGNO` type. (It was 53 / 47 / 43 / 6
when the service document first answered, with `REF TO data` and `RAISE
EXCEPTION TYPE` among the gaps.)

## Database writes and the LUW, 2026-09-23

`COMMIT WORK [AND WAIT]` and `ROLLBACK WORK` compile: `go/abap/luw.go` keeps
one database transaction per dialog step, and a host runs a step through
`abap.DialogStep`, which commits when the work returns and rolls back when
it dumps (the rule of `tools/osd-dialog-step.mjs`, the kernel's and not the
application's). sy-subrc 0 and sy-dbcnt untouched, measured on A4H. The JS
emitter has no database and refuses both. 3313 -> 3306 statement stubs in
the gateway, 65 -> 62 in the closure of `DISPATCH`.

With a database open and no step running, every statement autocommits, so
`ROLLBACK WORK` there is refused (`NOT_COMPILED`) rather than answered 0
as if it had undone something; `COMMIT WORK` there is a no-op. A step
begun inside a step fails at once (the pool has one connection, so the
second `Begin` would otherwise wait forever), and a rollback that fails
after a dump does not replace the dump. `DELETE <name> FROM ...` goes to
the database only when `<name>` is not a variable: an internal table named
like a TABL is the internal table's, as on A4H (`ZCL_GOGEN_T_DELNAME`).

`INSERT` / `UPDATE` / `MODIFY` / `DELETE` on a table compile through the
write nodes of the shared relational IR (`tools/ir-writes.mjs`, 2026-09-23).
`UPDATE ... SET ... WHERE` and `DELETE FROM ... WHERE` are lowered at build
time by `lower()`; a write whose rows are a work area or an internal table is
built with ir-writes' constructors, lowered once to refuse what the IR
refuses, and its rows are rendered at run time by `go/abap/irsql.go`, a port
of the SQLite rendering checked byte for byte against
`test/fixtures/ir-pairs/writes.json` (14 of 14). sy-subrc and sy-dbcnt are
A4H's (`ZCL_GOGEN_T_DBW` in `semantics.mjs`): a duplicate key of a work
area is 4/0, `INSERT FROM TABLE` writes every other row and raises
`CX_SY_OPEN_SQL_DB` with sy untouched, `ACCEPTING DUPLICATE KEYS` is 4 and
the rows written, `UPDATE` / `DELETE FROM` a work area or a table go by the
primary key one row at a time with the counts summed, MANDT is the logon
client whatever the work area holds, and a field the work area does not set
is its initial value, never NULL. Four of those rules the transpiler's
runtime gets wrong (ANORMALIES `dbwrite-*`). A column of kind p, f, x or
xstring is not written yet (a stub). The JS emitter has no database and
refuses each such statement.

`col IN range` is `rangesPredicate` of `tools/ir-ranges.mjs`: the build
lowers the statement with a `/*@range:<id>*/` marker where the range goes,
and `go/abap/ranges.go`, a port checked against `ranges.json` (44 of 44:
33 renderings byte for byte, 11 outcomes), fills it at run time. Replayed
on SQLite against A4H's own measurement (`a4h-ranges.json`, 80 cases): 65
select A4H's rows, 7 raise what A4H raised (an uncatchable
`SAPSQL_IN_ITAB_ILLEGAL_*` dump, a catchable `CX_SY_OPEN_SQL_DATA_ERROR` /
`CX_SY_DYNAMIC_OSQL_SEMANTICS`), 8 are refused by name (`NOT_COMPILED`).
The Go host keeps the store as HANA does: `PRAGMA case_sensitive_like` on,
CHAR columns right-trimmed after the seed (`go/abap/dbstore.go`). `SELECT
COUNT(*)` compiles; sy-dbcnt is the count, sy-subrc 4 when it is 0; `SELECT
... INTO TABLE` sets sy-dbcnt to the rows and `SELECT SINGLE` to 1 or 0
(A4H, `ZCL_GOGEN_T_SELCNT`). A WHERE takes comparisons, `IN` a range, `AND`,
`OR`, `NOT` and parentheses. `IN` on a `d` column is refused at build time
(ir-ranges does not carry dates). A string, or a c longer than its CHAR
column, compared in a WHERE or written by `SET` is bound right-trimmed when
it fits and refused (`NOT_COMPILED`, `abap.DBCFit`) when it does not,
never cut to the column: A4H raises `CX_SY_OPEN_SQL_DATA_ERROR` for such a
range LOW, and the plain comparison and the `SET` are not measured yet
(`ZCL_GOGEN_T_HOSTFIT`, `ZCL_GOGEN_T_HOSTLONG`).

## What this does not show

- **Known gap, call emission:** a method call without `EXCEPTIONS` leaves
  sy-subrc as it was in both emitters; on A4H it is 0 afterwards
  (`ZCL_GOGEN_T_CALLSUBRC`, pinned to the wrong `call:4`). It is why
  `ZCL_GOGEN_T_DBW` answers `tabcx:4` where A4H answered `tabcx:0`. For
  whoever owns call emission, not the database.

- The database is Go-only: `SELECT ... INTO TABLE` and `SELECT SINGLE`
  (lowered through the relational IR of portable AMDP, run on SQLite in the
  Go host, the logon client added to the WHERE) exist in the Go backend; the
  JS backend refuses both at run time. `SELECT SINGLE` without
  `CORRESPONDING FIELDS` is refused unless each column has its field's type
  and length (a move by layout); a character field takes its column cut to
  its length. `COMMIT WORK` / `ROLLBACK WORK` close the dialog step's
  database transaction. `INSERT` / `UPDATE` / `MODIFY` / `DELETE` on a
  table compile (above); every other SQL form (`FOR ALL ENTRIES`, `JOIN`,
  `GROUP BY`, dynamic clauses, `IS NULL` / `IS INITIAL`) is a
  `NotCompiled` stub.
- `d`, `t` and `n` are declared, copied and compared with initial (`p`:
  see "Packed numbers"); no `decfloat`. No `RAISE RESUMABLE`, no `RAISE
  EXCEPTION ... MESSAGE`, no T100 or OTR texts in `get_text( )`.
- Class statics and constructor flags use a session-selected store. Serialized
  hosts share `abap.ProcessStatics` across requests, alongside the database.
- The handler's `ON_MESSAGE` is still three host lines in the stands; the
  `RETURN` inside its `TRY` that kept it out compiles now.
- Table values: an assignment, `APPEND`, `MODIFY`, `READ ... INTO`, `LOOP
  ... INTO` clone a table or a structure holding one; a composite
  `IMPORTING` by reference is a pointer in Go and the object in JS, a
  `VALUE( )` one is a copy (measured on A4H, pinned by `semantics.mjs`).
  Secondary keys, `SORTED` tables and `READ ... WITH KEY` are not there.

## Class-based exceptions, 2026-09-23

`RAISE EXCEPTION TYPE cls [EXPORTING ...]` and `RAISE EXCEPTION obj` of
any class compiled in the program, `CATCH` by the class hierarchy,
`CATCH ... INTO` with the object's attributes readable, `get_text( )`,
`previous`, and `CLEANUP`. The object travels in the panic (Go:
`*abap.Raised{Obj, Class}`, JS: `abap.Raised`) beside the runtime's own
exceptions (`abap.ArithmeticError` / `abap.AbapError`), which are
unchanged. A `CATCH` of runtime exceptions is still decided by the front
end; one of raised objects walks a table of superclasses at run time
(`abap.RegisterSupers`), since `RAISE EXCEPTION obj` only knows its class
then, and an ancestor outside the program (cx_static_check in a test)
still counts. `INTO` a variable of a `CATCH` that takes only raised objects
receives the object itself; `INTO` one that also takes runtime exceptions
(`CATCH cx_root INTO`) stays an exception value whose one method is
`get_text( )`, the object's own when it was raised.

Measured on A4H and pinned (ZCL_GOGEN_T_RAISE): hierarchy, first fitting
`CATCH`, `CLEANUP` inner then outer then the handler, no `CLEANUP` for an
exception raised inside a `CATCH` of the same `TRY`, a runtime exception
passing a `CLEANUP`, `get_text( )` of a class without a text is `An
exception was raised.` (open-abap's fallback, the same text, served by a
host function; a T100 or OTR text dumps), `RAISE EXCEPTION obj` hands over
the same object. Refused, as a system refuses: a `CATCH` after one of its
superclass (does not activate on A4H; abaplint takes it, ANORMALIES
catch-after-superclass). An initial reference raised aborts, and nothing
catches it. An exception that no `TRY` takes runs no `CLEANUP` at all:
the kernel looks for a handler before it unwinds and dumps at the `RAISE`
(A4H 2026-09-23: the same code in an RFC module, each `CLEANUP` writing a
committed row, `UNCAUGHT_EXCEPTION` at the `RAISE` and no row; the rows of
a handled one did come). Each `TRY` with `CATCH`es registers them in the
session while its body runs (Go `Session.Handlers`, JS `s.handlers`), and a
`CLEANUP` runs only when one further out takes the exception; pinned by
ZCL_GOGEN_T_UNCAUGHT and its reader, and the Go dump names the `RAISE`'s
line, the stack a `TRY` passes on starting at the frame that raised.

`GET /sap/opu/odata/sap/ZSTG_DEMO_SRV/NoSuchSet` through the Go binary:
`404 Not Found`, and the body (132 bytes) byte for byte what OSG answers.
Headers are not compared: the Go host prints the dispatcher's status,
reason, content type and body, and OSG's HTTP layer adds
`dataserviceversion: 2.0` and `; charset=utf-8` on top:
`{"error":{"code":"STG/ENTITY_SET_NOT_FOUND","message":{"lang":"en","value":"Entity set NoSuchSet does not exist in ZSTG_DEMO_SRV"}}}`.

## Native report commands (OSABAP), 2026-09-29

The detailed architecture, lifecycle, frontend modes, Windows build, DIAG
session and current boundaries are in [`docs/osabap-native.md`](../../docs/osabap-native.md).

`node tools/gogen/osabap.mjs [path/to/zreport.prog.abap]` converts a classic
executable report through open-abap-gui, compiles the report lifecycle and its
small host closure with gogen, and writes the stripped self-contained binary
to `.out/osabap`. This is deliberately a different host from OSGo: it has no
HTTP, OData or Fiori entry point. It is built with the `nodatabase` tag, so the
SQLite driver and modernc/libc are not linked; a report which reaches Open SQL
gets an explicit host error instead of silently opening a database.

The selection screen is the command contract. For the checked-in `ZHELLO`
sample these invocations all enter the same `INITIALIZATION` / selection-screen
events / `START-OF-SELECTION` lifecycle:

```
.out/osabap Alice
.out/osabap --name Alice --loud --s-tag one --s-tag two
.out/osabap -params '{"P_NAME":"Alice","P_LOUD":true,"S_TAG":["one","two"]}'
.out/osabap -params @arguments.json
```

Parameters accept their ABAP name (`--p-name`) or the short spelling
(`--name`); non-checkbox parameters become positionals in declaration order.
A repeated select-option flag becomes `I/EQ` range rows. In JSON, scalar array
items do the same, while an object can carry `sign`, `option`, `low`, and
`high` (with `BT` inferred when `high` is present). With no arguments and a
real terminal, the same screen is presented by the `termgui` tcell driver:
Tab/arrows move focus, text fields have a caret, Space toggles a checkbox,
Enter executes, Esc cancels, and mouse clicks move focus. Piped stdin uses a
deterministic line form instead. Comma-separated select-option input becomes
`I/EQ` rows in either form. The interaction model is the one proved in
sap-tui, but the driver consumes the host-neutral report screen rather than
DIAG atoms.

`-sapgui` serves that same host-neutral screen over NI/DIAG to one real SAP
GUI, using the public `open-diag-go` screen and protocol packages. It starts no
SAP application server and performs no logon: the command itself is the local
dispatcher endpoint. By default it binds loopback port 3232 and launches the
platform's installed SAP GUI client:

```
.out/osabap -sapgui
# SAP Logon -> Custom Application Server
# Application Server: 127.0.0.1
# Instance Number:    32
# System ID:          OSG
```

`-sapgui=127.0.0.1:3201` selects another address (the low two port digits are
the instance number). Windows starts `sapgui.exe <host> <instance>`; macOS
opens the `com.sap.platin` bundle with a Java GUI connection string. Set
`OSABAP_SAPGUI` to an explicit client executable, or use
`-sapgui-no-launch` when a remote/manual client should connect. Report flags
may follow `-sapgui` and become initial field values. The GUI receives the
selection parameters, checkboxes and the comma-separated select-option
shorthand; F8, Enter or the Execute button runs the ordinary report lifecycle,
and the next screen contains its messages and `WRITE` lines. Back or closing
the window sends a clean DIAG EOC/EOP and exits the command. A connected
session is capped at five minutes, 64 frames and 64 MiB per frame. The first
vertical slice shows one bounded result page; paging and the full SAP
multiple-selection dialog remain frontend work. Keep the listener on
`127.0.0.1`: this deliberately small rogue-DIAG endpoint has no SAP logon, SNC
or authorization layer.

Cross-compile the self-contained command for a Windows 11 ARM guest with:

```
GOOS=windows GOARCH=arm64 node tools/gogen/osabap.mjs path/to/report.prog.abap
# -> tools/gogen/.out/osabap.exe
```

For native applications the local process is the frontend. The compiled
`CL_GUI_FRONTEND_SERVICES` maps `FILE_EXIST`, `DIRECTORY_EXIST`,
`FILE_GET_SIZE`, `GUI_UPLOAD`, `GUI_DOWNLOAD`, the temporary directory and
current directory onto the OS. Text upload/download moves through the ABAP
internal table; binary mode accepts tables of `x`/`xstring`. The small
`ZCL_OSABAP_RUNTIME=>GETENV( name )` facade exposes one process environment
variable without returning the entire environment. `apps/io/zio.prog.abap`
is the executable example.

Focused check: `node --test tools/gogen/osabap.test.mjs`; the keyed-table
runtime primitive used by the converted lifecycle is also covered by
`go test ./abap -run RowByKey` from `tools/gogen/go`.

## OSGo host, 2026-09-23

`node tools/gogen/osgo.mjs` (heavy: all 822 classes, run it under the
shared lock) builds `.out/osgo`, an HTTP server in front of OSG's own ICF
handler; `node tools/gogen/osgo.mjs --echo` builds `.out/osgo-echo` over
the shim, open-abap-core and a test handler at `/echo` in five seconds.

```
.out/osgo [-port 3095] [-addr 127.0.0.1] [-db file.sqlite] [-root <checkout>]
```

The request path is the one the Node hosts run: express-icf-shim's
`CL_EXPRESS_ICF_SHIM=>RUN`, **compiled as it is**, builds the ICF server,
request and response objects and calls the handler class. Only its eleven
`WRITE '@KERNEL ...'` lines are host functions (`go/abap/icf.go`, listed
line by line in `frontend.mjs` `KERNEL`; the `for (const h in
req.headers)` loop is a `kernel_loop`), and they answer what express
answers: lower-case header names (repeats joined as Node joins them; sorted,
since Go does not keep the order), the raw URL and path, a body only with a
content type (express.raw, 16 MB), `res.append` and `res.send` with the
charset express adds to a text or JSON content type, no body for HEAD, 204
and 304. What that took in the front end: the shim's local server class
compiles (local classes, for the owners in `LOCAL_CLASSES` only), a class
with local classes reads its own scope and not the first one (it read the
local's: `mi_server` "was not an attribute"), `DEFAULT <constant>` resolves
to the constant's value, and `CL_HTTP_ENTITY`'s `get_cdata` / `set_cdata`
are host functions with arguments, because `CL_ABAP_CONV_IN_CE` takes
generic parameters: UTF-8 both ways, bytes that are not UTF-8 raise
`CX_SY_CONVERSION_CODEPAGE`, as open-abap-core's fatal TextDecoder does.

Each ICF request is one dialog step (`abap.DialogStep`) with a fresh
Session, one at a time around the shared database; a dump is the Node host's
500 (`STG/RUNTIME` JSON with the ABAP frames for OData, `<class>: <text>`
for a SICF node), and rolled back. Mounted: `/sap/opu/odata/sap/` with
`ZCL_STG_HTTP_HANDLER`, every SICF node of the tree whose handler class is
compiled (10), `/app` (the tree's `webapp/`, express.static's redirects,
ETag and 304), each pack's `/app/<name>`, `/app/packs.json`,
`/appconfig/fioriSandboxConfig.json`, `/` to the launchpad, and
finalhandler's 404 for the rest. A SICF node whose class is not in this
program (four: `webgui/sapevent`, and `zork`, `zo4d_demo`, `lsd` from the
packs) is mounted too, as a refusal: `501 <path>: <CLASS> is not in this
program`. Without it a request below such a node fell to its parent, and
`webgui/sapevent` ran as a menu request of `ZCL_OSD_WEBGUI`. What express
refuses of a response is a host error (`abap.HostError`, not catchable, not
`NOT_COMPILED`): a second send ("headers already sent") and a second
`Content-Type` (`res.set` of an array). The database is in memory, or `-db`
an SQLite file in WAL mode, seeded once when it has no tables and marked
with a hash of the build's tables and seed rows (`PRAGMA user_version`); a
file another build seeded, or nobody marked, is refused at start rather than
used. `ZOSD_STATUS_SRV` and the webgui read the five status tables, which
the Node hosts refresh before each such request (`withFreshStatus`). OSGo
does the same with a snapshot of its own process (`go/cmd/osgo/status.go`,
the build-time half from `status.mjs` into `zz_status.go`), at start and
before each request under the paths `test/start.mjs` refreshes for
(`ZOSD_STATUS_SRV` and the webgui, read out of that file by `status.mjs`
into `statusFreshPrefixes`), through the compiled
`ZCL_OSD_STATUS=>REFRESH` and open-abap-core's `/UI2/CL_JSON=>DESERIALIZE`
(ultra/json, below). Every row is a fact of the process or of the build:
host kind `abap-go`, its pid, port, sockets and RSS, the program's own
generation (`go:` and a hash of the generated code; `gen_live` is the tree's
Node build, so "in step" says no), the OData services and SICF nodes it
serves, the apps under `-root`, the pack pages it serves, SQLite and the
platform. Left out, not invented: the RFC and DIAG port rows (Node's JS
protocol listeners), push channels, and the services and packs OSGo does
not serve. A POST to `/sap/bc/osd/status/` above 128 KB, raw or inflated,
answers 413 on OSGo (Node takes 16 MB): the Go runtime scans a sorted
secondary key rather than indexing it, so the parse grows with the square
of the members (1000 services 0.4 s, 3000 3.1 s, 6000 14 s under the one
work process lock). An index kept up to date by the writes is the real fix;
an order remembered and checked against the rows before each use was tried
and was slower, since the check is itself a pass over the table.

### JSON into ABAP: `/UI2/CL_JSON=>DESERIALIZE` (ultra/json)

The deserializer of open-abap-core, compiled as it stands, local classes
included (`LOCAL_CLASSES`), with the two pieces that are JavaScript on Node
as host functions: `LCL_JSON_PARSER=>PARSE` (`go/abap/jsonparse.go`,
JSON.parse's grammar, key order and number text, tested against Node's
answers) and `CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA` (`emit-go.mjs`
`nativeRttiData`, A4H's lengths, output lengths and absolute names:
`ZCL_GOGEN_T_RTTI`). What it needed of the front end: sorted secondary
keys (`LOOP ... USING KEY`, `READ ... WITH KEY k COMPONENTS`, duplicates
newest first as A4H orders them: `ZCL_GOGEN_T_SECKEY`), `INSERT INTO TABLE`
and `CREATE DATA ... LIKE LINE OF` of generic tables, `CREATE DATA ref.`,
`LOOP AT ref->* ASSIGNING <typed>`, a variable named `value`, and `=` / `<>`
of two object references (`ZCL_GOGEN_T_JSONGEN`, `_DREFLOOP`). The whole
path is pinned by `ZCL_GOGEN_T_JSONDES`. Two consequences of following A4H:
the parser reads an array's members through a non-unique sorted key, so a
JSON array fills its table in reverse (ANORMALIES
secondary-key-duplicates; the status tables read with ORDER BY do not show
it, DatabaseSet and the services of the object page do), and
`CREATE DATA ref LIKE LINE OF data` on a `TYPE data` parameter does not
activate on A4H: it is refused everywhere but in `/UI2/CL_JSON=>_DESERIALIZE`
(`TRANSPILER_MEANING`, ANORMALIES create-data-like-line-generic). The
reference branch of `_DESERIALIZE` (deserializing into `REF TO data`) stays
statement stubs.

The front-end changes this needed that are not ICF-specific (findScope by
class name, `DEFAULT <constant>`, the flattened block list,
`CX_SY_CONVERSION_CODEPAGE`) are their own commit, ahead of the host
commits, so that another branch touching `frontend.mjs` can rebase onto it.

Against OSG on :3091 (bodies with the same `Host`): the service document,
`TravelSet('T0001')`, `NoSuchSet` (404) and `/` without `$format` are byte
for byte equal; `TravelSet` is equal except T0009, the client-001 row OSG
serves ("Other client, must not leak") and Go filters. The launchpad
(`/` -> `/app/flp.html`) renders its 35 tiles in Chromium and asks this
origin for nine things: seven are answered as OSG answers them, two are
500 where OSG answers 200 -- `/sap/bc/osd/amdp/engine` (a statement stub in
`ZCL_OSD_AMDP_SBX`: `sy` as a whole) and `ZVDB_100_SRV/VectorSet/$count`
(a pack's service, its DPC is not in this program). Opening an app stops
at `$metadata` (a stub in `ZCL_STG_DISPATCHER=>RUN`: `handle( ... )-data`);
the BSP pages stop at a `SELECT` form in `ZCL_OSD_BSP`, the webgui at
`SELECT ... ENDSELECT`, the RFC catalogue at `GET_TYPE_ID`'s kernel line.
Those are the compiler's next steps, not the host's.
## SMW0 media and APC for a Go host, 2026-09-23

Two host services a server built from this compiler mounts.

**SMW0.** `CALL FUNCTION '<literal>'` of a module the host implements
(`NATIVE_FM` in the front end) compiles into a Go call that takes every
actual as generic data and raises the module's classic exceptions by name;
the JS emitter refuses it. `go/abap/w3mi.go` answers `WWWDATA_IMPORT` and
`SCMS_BINARY_TO_XSTRING` out of a media directory beside the binary
(`abap.SetMediaDir`, a flag of the host): `node media.mjs --out <dir>
<folder> ...` copies every W3MI object's data file there with an index
`w3mi.json` (object id, as the object's XML names it, to file and size),
and `media.mjs` also gives the `WWWPARAMS` rows with the real filesize
(`replaceWwwparams`: the transpiler's `DatabaseSetup` writes 0 for an
object whose data file it was not handed; `node --test media.test.mjs`
holds it against `PopulateTables`' own rows, and it throws rather than
duplicate when it recognises no row of an object). What a system answers at the
edges was measured on A4H first and is pinned (`ZCL_GOGEN_T_W3MI`,
ANORMALIES w3mi-edges: open-abap-core differs in three places).
`node mediacheck.mjs` reads the 31 objects of o4d and zork (11.9 MB, the
three MP3s and ZORK-MINI-Z3 among them) through compiled ABAP of the
packs' loader shape and compares them with the files: 31 of 31 equal, and
an unknown object sy-subrc 1, in 37 ms. The packs' own loaders stop before
the call, at `SELECT ... WHERE col = value INTO TABLE` (the o4d handler,
Zork's game loader) and `CONCATENATE ... IN BYTE MODE` (Zork), which the
subset does not have yet.

**APC.** `go/apc` is the socket part of the framework as an
`http.Handler` (`apc.Channel`) for `/sap/bc/apc/sap/<app>`, in a package of
its own so that a program without a push channel links no WebSocket
library; the dialog step (`abap.APCStep`, `abap.WorkProcess`) stays in
`go/abap`. The ABAP part stays ABAP, open-abap-apc's `ZCL_APC_HOST`
(handler by name, `open` = ON_ACCEPT + ON_START, `message`, `close`,
`drain`), which the Node hosts drive too. A program adapts it in a few
lines (`cmd/o4dserve` `apcHost`). A request that is not a WebSocket
handshake (426/400/405) or comes from another origin than the page's own
or `OriginPatterns` (403) is answered before any ABAP runs. One Session per
socket, each call one dialog step under `abap.WorkProcess` and
`DialogStep`, ON_START before the upgrade and its messages written after
it (open before drain), a rejection 403, binary frames refused with 1003,
a broken write closed as 1006. A host that serves HTTP from the same
process takes `abap.WorkProcess` for its own steps (or gives the channel a
`Step` holding its lock). The ZO4D stand runs on it with the handler's own
ON_MESSAGE (`-origins` for a page served from elsewhere); `cmd/apcprobe`
(length and sha256 of every message) finds it equal to the stand at
98d4d1c for the config, the scenario, 300 frames and the JSON and control
commands.

**What this is not yet.** The media host is proved through a stand-in of
the loaders' shape (`testdata-media/zcl_gogen_t_w3miload`), not through the
packs' own `ZCL_O4D_HTTP_HANDLER=>GET_*_FROM_SMW0` and
`ZCL_ORK_00_GAME_LOADER_SMW0`, which still stop at `SELECT ... WHERE` and
`CONCATENATE IN BYTE MODE`; no build calls `media.mjs` yet (the osgo build
is the host's), and there is no Go Zork APC stand. The tiles do not read
their media through Go today; once `SELECT ... WHERE` lands, `mediacheck`
is to be rerun against the packs' loader methods themselves.

## The packs on OSGo: Zork, Vivid Vibes, LSD, 2026-09-24

The osgo build reads the layers the Node build reads (`osg-build.mjs`):
`abap_transpile.json`'s `input_folder` with every pack's ABAP folders before
`gen/` (`tools/osd-packs.mjs` `inputFoldersOf`), `test/` left out as
before, the later folder winning an object two hold (`tools/osd-inputs.mjs`
`layers`); a file a later layer hides is not loaded at all (`compileProgram`
`skip`), which is how the transpiler is handed the winner only. With the
packs fetched that is 945 classes; `ZCL_O4D_HTTP_HANDLER` of `packs/o4d/src`
wins over the upstream copy, as on Node. The packs' rows come with
`test/seed.mjs` and their W3MI objects with `collectMedia` over the layers
(89 objects, 15.6 MB). Every `*.sapc.xml` whose handler is compiled is a
push channel (`tools/osd-icf.mjs` `channels`): an upgrade request at its
path goes to `go/apc` around the compiled `ZCL_APC_HOST` (the adapter is
generated into `zz_boot.go`; the upgrade's query as form fields, in URL
order), with the `X-OSD-Channel` receipt the Node host writes; a channel
whose class is missing is a 501, an upgrade anywhere else a 404, and ICF
requests and channel steps share `abap.WorkProcess`.

What the packs needed of the compiler: `CONCATENATE ... IN BYTE MODE` into
an xstring (the SMW0 loaders of Zork and ZO4D), `cl_http_utility=>
encode_x_base64` as a host function (the LSD channel sends the show so),
and an `x` that is never assigned starting at its length in 00 bytes
(it was Go's empty string). The last one is wider than a local: in the
review round the same held for a structure's `x`/`d`/`t`/`n`/`p`
component, a row appended after `CLEAR`, `CLASS-DATA`, an instance
attribute, a `RETURNING` never set and a component `VALUE #( )` leaves out,
so `zero()` of a structure now sets those components and attributes and
results start there too. All measured on A4H (`ZCL_GOGEN_T_BYTECAT`,
`ZCL_GOGEN_T_B64`, `ZCL_GOGEN_T_XINIT`).

Generated `CLASS-DATA` and `class_constructor` flags live in lazily allocated class
slots in `abap.Statics`, selected by `Session.Statics`. A nil pointer lazily creates
private state; serialized hosts select `abap.ProcessStatics` to retain caches and
constructor state across requests, with concurrent hosts taking `abap.WorkProcess`. ABAP Unit keeps a
fresh private store per test class. Inherited statics use the declaring class's
slot, and references and method-cached pointers stay valid because slot values
never move. `CLASS-EVENTS` and `SET HANDLER ... FOR ALL INSTANCES` registrations
use the same store, so private sessions are isolated and ProcessStatics hosts
retain registrations across requests. Registrations `FOR` an object stay on
that sender object. Only one goroutine may use a Session or its shared store at a time.

Against OSG on Node (`STG_DB=sqlite node test/run.mjs`), in Chromium and on
the sockets: the three pages are byte for byte equal; Zork boots from
`ZORK-MINI.Z3` and ten commands give the same 22 lines, and typed into the
page the same frames; LSD sends the same 225 332 bytes in the same base64
chunks and plays (`Playing 0:05 / 3:28`); Vivid Vibes plays its first part
with the 4.6 MB MP3 loaded (`readyState` 4, playing) and the images equal.
Its frames differ from Node's where Node differs from A4H (the pulse,
the mountains, the tesseract: ANORMALIES 2026-09-16/17) and in the digits of
every `f` (ANOMALY-2026-09-24-float-template-digits); `node demo.mjs`
still has Go equal to the A4H recordings. The second part ("outro") stops
at `ZCL_O4D_GALLERY=>RENDER`, `APPEND LINES OF`, which the subset does not
have yet.

The socket's edges follow the Node host (`tools/osd-apc.mjs`), each chosen
and measured against it in the review round (2026-09-24): a dump in the
constructor or `ON_START` is a 503 `<handler>: <why>`; a dump in
`ON_MESSAGE` closes the socket 1011 `handler failed` (before, Go kept it open
and the outro's page waited on silence); a binary frame is ignored; any
close frame of the client is `ON_CLOSE` with `closed by the client` / 1000;
every origin is let in (`apc.Channel.AnyOrigin`; a same-origin rule would
refuse every page behind a proxy that rewrites Host); the channel is matched
on the path as sent (`apc.RequestPath`, not percent-decoded) and the query
decoded as `URLSearchParams` decodes it (`apc.FormFields`). What still
differs, on purpose or by the library: the close frame sent back to a client
close is `github.com/coder/websocket`'s echo of the client's code (1005 when
it sent none) where Node answers 1000 `bye`, since the library answers the
close itself; Go calls `ON_CLOSE` (with 1006) when a connection breaks
without a close frame, Node calls none; the `<why>` of a 503 is the Go
dump's text. None of this was measured on a system.

## Next, if this is pursued

Ranked with codex gpt-6-sol, 2026-09-23:
1. ~~One request end to end~~ (done, above), and ~~the exceptions,
   interface dispatch and inheritance it needs~~ (done).
2. An entity set: `REF TO data`, `RAISE EXCEPTION TYPE`, then the database.
3. A step budget counted at loop back edges (a goroutine cannot be stopped
   from outside; the OOM of 2026-09-23 is the reason).
4. The DB layer through the shared relational IR and its conformance pairs.
5. ~~Statics per session~~ (implemented for all class attributes and
   constructor flags; shared runtime stores remain separate).

## The Travels app through the Go binary, 2026-09-23

`gateway.mjs` now also takes a request as the ICF hands it over:
`--icf`, `--method`, `--header 'k: v'`, `--body @file`, `--requests
file.json` (a list, each with its own method, headers and body) and
`--steps` (all of them in one process, one dialog step each, on one
database). The Go host does what `cl_express_icf_shim=>run` does -- a
`CL_HTTP_SERVER`, two `CL_HTTP_ENTITY`s, the headers, `~path`, the query
as form fields -- and calls `ZCL_STG_HTTP_HANDLER`, so the CSRF token, the
COMMIT / ROLLBACK brackets and the response headers are the ABAP's own.
`--compare <origin>` checks the status, every header the ABAP set (both
ways: one OSG sent and Go did not is a difference too, apart from the ones
OSG's HTTP layers add) and the body byte for byte; what it forgives it names: express adding `;
charset=utf-8`, the `$batch` boundary counter of the OSG process, and with
`--other-client TravelId=T0009` the rows of client 001 that OSG returns.
`GW_REUSE=1` rebuilds only the host, `GW_REUSE=2` reruns the last binary.

Against OSG, with the requests the Fiori Elements app sends (captured from
the app in Chromium):

| request | Go vs OSG |
| --- | --- |
| `$metadata` (annotations of `ZCL_ZSTG_DEMO_MPC_ANN` included) | equal, 18238 bytes |
| `HEAD` with `x-csrf-token: Fetch` | equal, token `open-steamgate` |
| `$batch` of the list report (`TravelSet?$skip&$top&$select&$inlinecount`) | equal apart from the client-001 row and the boundary counter |
| `PhotoSet('T0001')/$value`, `PhotoSet('T0003')/$value` | equal, 930 / 928 bytes of PNG |
| `TravelSet('T0001')`, key read | equal |
| POST below / MERGE of a travel that does not exist, and the same in a changeset | equal (400, `/IWBEP/CX_MGW_BUSI_EXCEPTION`) |
| `$batch` of the object page (`TravelSet('T0001')/to_Bookings`) | Go: `CX_SY_ARITHMETIC_OVERFLOW` in `ZCL_STG_JSON=>EPOCH_MS`, as A4H (ANORMALIES epoch-ms-overflow); OSG lets it through |
| MERGE / PATCH of a travel, POST of a booking below it (direct and in a changeset) | run to `UPDATE zstg_demo` / `INSERT zstg_demo_bk` in the DPC, which wait for the IR's write nodes |
| `StatusVHSet` (the F4 on Status) | `CREATE DATA ... TYPE STANDARD TABLE OF (name)` and a dynamic `SELECT` in `ZCL_OAO_SHLP_DDIC` |

What it took: the conversions of `cl_abap_conv_in_ce` / `out_ce` as
host functions (Go only, JS refuses); a `DEFAULT` naming a constant; `m( )-comp`; a regex check
that skips bracket expressions (`[^/(?]` is no group); a raw column read
as hex into an xstring; `ASSIGN ref->* TO <typed>` (Go only, JS refuses); `SHIFT s RIGHT
DELETING TRAILING` (A4H, `ZCL_GOGEN_T_SHIFT`); a generic `EXPORTING` as a
binding to the caller's variable and `MOVE-CORRESPONDING` over generic
data (A4H, `ZCL_GOGEN_T_GENEXP`); `sy-mandt`; `n` components of structured
constants; moves between structures of one technical type. 2831 -> 2252
statement stubs over the 821 classes.

## Packed numbers, 2026-09-24

`p LENGTH n DECIMALS d` in both backends (`go/abap/packed.go`,
`js/abap.mjs`), every rule measured on A4H first (`$ZOSG_TMP_0270`,
ZCL_GOGEN_T_PDCONV, _PDCALC, _PDFMT, _PDPREC, _PDCMP, _PDTPL in
`semantics.mjs`; `go test ./abap -run Packed` holds the same values).

Representation: a p value is its decimal text. A field of d decimals holds
exactly d of them (`"1.50"`, `"0.00"`), which is what a template prints, so
a template of a field is the value. An intermediate result is exact and
carries as many decimals as it has; it is rounded only where it lands. A
string was chosen over a scaled big.Int because it is what the generic data
layer, the templates and the database hand over anyway, and the JS runtime
holds the same text (BigInt inside each operation).

| rule | A4H |
| --- | --- |
| calculation type | p when a p is an operand or the target, and when a c or string is an operand (`'7' / 2 * 2` into i is 7); p before int8 (int8 / 3 into p(8,2) is 1666666666.67) |
| + - * | exact |
| / | 31 significant digits, rounded half away from zero (2 * 10^28 / 3 - 6666666666666666666666666666 is 0.667; 1e-14 cubed is exact) |
| in between | 63 integer digits; the 64th is CX_SY_ARITHMETIC_OVERFLOW |
| DIV MOD | as for i: the remainder is never negative (-7.5 DIV 2 is -4, MOD 0.5) |
| into a field | rounded half away from zero (1.5625 -> 1.56, -2.5 -> -3); too many digits: CX_SY_ARITHMETIC_OVERFLOW after arithmetic, CX_SY_CONVERSION_OVERFLOW after a move |
| c / string -> p | blanks around; a sign in front, behind (`12.5-`) or `- 1`; `.5`, `5.`; blanks only 0; exponent, comma, inner blank CX_SY_CONVERSION_NO_NUMBER |
| f -> p | its seventeen significant digits, then rounded (2.345 -> 2.35, 2.675 -> 2.67) |
| p -> i, int8 | rounded half away from zero |
| p -> c | right aligned with a sign place (`   1.50-`); without the sign place when only that fits; `*` and the last digits when short (`*67`, `*50-`) |
| p -> string | the digits and a sign place (`1.50 `, `1.50-`) |
| p -> n | rounded, unsigned, the last digits (12345.6 in n(4) is 2346) |
| templates | the field's decimals; `DECIMALS =` rounds; `NUMBER = RAW` is the plain form; + and - of p print the most decimals of their operands; * and / are refused (1.25 * 2 printed 2.500, 1.25 * 1.25 1.56250: two points do not make the rule) |
| comparisons | p against p, i, c, string numerically; a string against an i alone compares as i (`'-0.4' < 0` is false); an arithmetic side makes a string operand p; an arithmetic side against a bare string does not activate (refused) |
| functions | abs( ) frac( ) keep the type, sign( ) is i, ceil( ) floor( ) trunc( ) have no decimals |

DEC columns: SQLite keeps them with NUMERIC affinity; `abap.DBP` reads the
integer, REAL or text the driver hands over exactly and rounds it into the
field. A REAL has 15 to 17 significant digits, so a DEC of more digits is
not exact on this store (HANA's is). Writing a p column still waits for
`tools/ir-writes.mjs`, which has no P type (`bindValue`); the statement is
a stub, not a guess.

Consumers: `ZCL_STG_SADL_DPC=>SYNTHETIC_KEYS` (MOD in p) and the
`/Date(ms)/` arithmetic of `ZCL_STG_ENTRY_PROVIDER=>CONVERT_VALUE` compile;
`TravelSet('T0001')/to_Bookings` answers through `EPOCH_MS` in p. One line
of the entry provider (`lv_days * 86400 * 1000 > lv_ms`, a string) does not
activate on a system and is refused with that reason (ANORMALIES
arith-compared-with-string). The Flight analytics cube stops before any p:
its source reads through a dynamic SELECT over a view (the next step, the
WHERE parser). Statement stubs over OSG: 1810 -> 1531 (208 of them string
against i comparisons, 24 n in templates).

## The table registry, 2026-09-24

The build writes every TABL and DDIC view the program knows into
`zz_generated.go` (`frontend.mjs` `tableRegistry`, emitted by `emit-go`):
its columns in DDIC order, the key, the client flag, and the Go descriptors
of a row and of a STANDARD TABLE of rows when every column is in the subset.
`go/abap/tables.go` is the runtime side:

```go
abap.TableByName(name) (*abap.Table, bool)   // any case, blanks ignored
t.Columns []abap.Column                      // {Name, Kind, Len, Dec, Key, IR}
t.Key, t.Client, t.View, t.SQLView, t.CDS
t.WhereColumns() map[string]abap.WhereColumn // the WHERE parser's input, as it stands
abap.ClientTable(name)                       // the SQL view of a CDS name (its MANDT), else the table
t.NewRow(), t.NewTable(), abap.NewData(desc) // the generic factory (Type.New)
abap.CreateDataByName(name, table)           // CREATE DATA ... TYPE [STANDARD TABLE OF] (name)
```

`CREATE DATA r TYPE (name)` and `TYPE STANDARD TABLE OF (name)` compile
through it, and `APPEND wa TO <generic table>` with them (A4H
ZCL_GOGEN_T_CRDYN: a new initial value each time, the name in any case, an
unknown name CX_SY_CREATE_DATA_ERROR with the reference kept; the JS emitter
has no registry and refuses). `ZCL_OAO_SHLP_DDIC` line 254 (StatusVHSet)
passes and now stops at `SELECT * FROM (name) WHERE (cond)`, which is the
parser's.

The same facts as JSON, written by `osgo.mjs` to `go/cmd/osgo/zz_tables.json`
(`frontend.mjs` `columnRegistry`):

```json
{"tables": {
   "ZSTG_FLIGHTFACT": {"view": false, "client": true, "key": ["MANDT", "FACT_ID"],
     "columns": {"FACT_ID": {"type": {"abap": "C", "len": 10}, "kind": "NUMC"},
                 "SEATS": {"type": {"abap": "I"}},
                 "PRICE": {"type": {"abap": "P", "len": 15, "dec": 2}}, "...": {}},
     "fields": [{"name": "FACT_ID", "kind": "N", "len": 10, "dec": 0, "key": true}, "..."]},
   "ZC_STG_FLIGHTCUBE": {"view": true, "sqlView": "ZVSTGFLIGHTCUBE", "...": {}}},
 "cdsViews": {"ZC_STG_FLIGHTCUBE": "ZVSTGFLIGHTCUBE", "...": ""}}
```

`tables[T].columns` is the `columns` argument of
`osqlWherePredicate(text, columns)` (`tools/ir-osql-where.mjs`, branch
feat/ir-osql-where) as it is: the IR type of each column
(`sqlscript-ir.mjs` `T`: C/len for CHAR and NUMC, I, INT8, P with its
digits (2n-1 for `P LENGTH n`) and decimals, STRING, D, X/len, XSTRING) and
`kind: "NUMC"`; a column the IR has no type for (t, f) is left out.
`fields` keeps the ABAP facts: kind letter (C N D T I 8 F P g y X), length
in characters (C N X) or bytes (P), decimals, key. `cdsViews` maps a CDS name
to its SQL view (read off the DDLS source), because MANDT is on the SQL view
only (open-steamgate #45): a read under the CDS name takes its client filter
from the SQL view (`abap.ClientTable`). `go test ./abap -run Where` pins the
shape against the pairs file's SFLIGHT-like columns.


## Dynamic Open SQL, 2026-09-24

`go/abap/osqlwhere.go` ports `osqlWherePredicate()` of
`tools/ir-osql-where.mjs` (open-steamgate #47, now on main): the condition
an ABAP program builds as a string, parsed against the columns of the table
it reads, as A4H reads it (docs/osql-where.md). `irsql.go` lowers for all
four dialects of `sqlscript-lower.mjs` (placeholders and LIKE differ;
PostgreSQL always says ESCAPE), so `go test ./abap -run Osql` checks every
pair of `test/fixtures/ir-pairs/osql-where.json`: 85 pairs, 36 outcomes
(the ABAP class, or the refusal reason) and 49 predicates byte for byte in
sqlite, duckdb, postgres and hana. `ranges.json` is checked in the four
dialects too.

`SELECT [*|(fields)|f ...] FROM <table>|(name) INTO [CORRESPONDING FIELDS
OF] TABLE <itab> [WHERE (cond)] [GROUP BY (g)] [ORDER BY (o)|PRIMARY KEY]`
compiles to `select_dyn`; `go/abap/selectdyn.go` runs it:

- the table from the registry, any case; a CDS name reads through its SQL
  view (MANDT); a view over a client-dependent table without MANDT is
  refused, as the static read is;
- the condition through the parser: CX_SY_DYNAMIC_OSQL_SYNTAX and
  _SEMANTICS where A4H raised them (catchable, CX_SY_DYNAMIC_OSQL_ERROR
  takes both), an uncatchable error where A4H dumped, NOT_COMPILED for a
  refusal; an empty condition is every row, `1 = 1` is _SEMANTICS;
- `MANDT = sy-mandt` AND'ed for a client-dependent table, every text bound;
- field lists of columns, `col AS alias` and `SUM / MIN / MAX( col ) AS
  alias`; GROUP BY and ORDER BY of columns; anything else NOT_COMPILED;
- the rows moved into the target through its descriptor (by name with
  CORRESPONDING, else by position), sy-subrc 0 / 4, sy-dbcnt the rows.

Against OSG on Node (main 42755c5, the producers of #48 / #49), the same
requests on both, with the ICF and status rows Node's start writes copied
into the Go database (OSGo has no ICF apply and no status refresh):
ZOSD_ICF_SRV 5 of 5 sets equal, ZOSD_STATUS_SRV 4 of 6 (two carry the
snapshot's time and memory), ZSTG_SEGW_SRV 54 of 55 sets with the editor's
`$filter` and `$orderby` plus 12 of 13 filters (LIKE with `#` escapes,
E-first), the flight cube with and without `$select` aggregation, SE16 90
of 106 pages. Every other difference is named in ANORMALIES
(ANOMALY-2026-09-24-dynamic-where-pasted: a CHAR literal cut, `1 = 1`,
the order of a read without ORDER BY, client 001) or is another subset gap.

## Class events and the WEBGUI's sapevent (ultra/events, 2026-09-24)

`EVENTS` / `CLASS-EVENTS`, `SET HANDLER` (instance and static handlers, FOR
obj / FOR ALL INSTANCES, ACTIVATION) and `RAISE EVENT ... EXPORTING` with the
implicit SENDER, in both emitters, as A4H answered them
(`go/abap/events.go` has the rules; ZCL_GOGEN_T_EVENTS / _EVENTS2 pin
them). A sender carries its own registrations (`abap.Events`, embedded once
per class chain), so a registration FOR an object lives exactly as long as
the sender, as on a system. Class constructors now run at the first use of
their class (ZCL_GOGEN_T_CCTOR); before, none ran.

`/sap/bc/gui/sap/its/webgui/sapevent/` (ZCL_OSD_SAPEVENT: abapGit's HTML
viewer inside open-abap-gui's `cl_gui_html_viewer`, a click coming back as
two RAISE EVENTs) answers byte for byte as on Node, the page and the clicks
(`.local/ultra-wip/events/pw/clicks.mjs` in Playwright). A transaction of
the Easy Access menu (ZOSD_NOTE) still stops where its session row is
written: `tools/ir-writes.mjs` has no initial value for a P column.

Fix round, same day (all measured on A4H in `$ZOSG_TMP_0441`):

- A SORTED table is filled only by `INSERT ... INTO TABLE` (row by row, the
  unique rule) and `APPEND` of an equal-kind table. A move from a table of
  another kind or key, a VALUE with rows and a STANDARD actual for a SORTED
  IMPORTING parameter are refused (testdata-refused/zcl_gogen_t_rf_sort, the
  last one does not even activate on a system).
- `READ TABLE ... WITH [TABLE] KEY` on a SORTED table answers a miss as a
  system does: 4 and the row it would go before, or 8 and lines + 1; only
  components outside the key is a linear search (ZCL_GOGEN_T_SORTRD). A miss
  that names a key part and a component outside it had no rule and is
  refused (ZCL_GOGEN_T_SORTRD2).
- A handler FOR EVENT e OF a subclass, FOR ALL INSTANCES, gets senders of
  that subclass only (ZCL_GOGEN_T_EVENTS3).
- An exception out of a class constructor is a runtime error no CATCH takes
  (ZCL_GOGEN_T_CCBOOM2), as on a system.
- WGUI1 is compiled by the JS emitter too; its string field symbols moved to
  WGUI3, which JS refuses.
- Host functions copied from open-abap-core rather than measured:
  `CL_ABAP_TSTMP=>SUBTRACT` (whole seconds, an int; a TIMESTAMPL argument
  with a fraction is refused) and `CL_ABAP_RANDOM=>CREATE( )->INT( )`
  (unseeded only; a seed is refused, since a seeded generator's sequence is
  the system's and not reproducible here).

## The object store over the files: DESTINATION 'STORE' (ultra/store, 2026-09-24)

The editor screen (`/sap/bc/osd/edit`, ZCL_OSD_EDIT, the WEBGUI's "Editor"
node) reaches the object store with `CALL FUNCTION 'ZOSD_STORE' DESTINATION
'STORE'`. On Node that is `tools/osd-store-destination.mjs` over
`tools/osd-store.mjs`; OSGo refused the call at compile time. Now the front
end maps DESTINATION 'STORE' + ZOSD_STORE (`DESTINATION_FM`) to a host
function, `go/objstore` (adapter in `go/abap/store.go`), which answers over the same files. The files,
named the abapGit way, stay the only copy of a source; git is the history.

- **LIST, READ, WRITE** as Node answers them, field for field: the roots in
  layer order, the libraries from the build's file lists, the build's
  exclusions, the package chains, every scalar filled on every call, the
  tally of what the filter matched, and the order of JavaScript's
  `localeCompare` (ICU root collation: `ZCL_A` before `ZCLA`), which is not
  byte order. The index is walked again for each call (milliseconds), so a
  file a git pull or another editor changed is never answered stale.
- **Library and generated objects are read-only**; a WRITE lands in the
  working tree, CRLF made LF, and is confined to the writable roots
  (`storeConfined`, `store_test.go`).
- **Versions.** Active is what the running generation was built from: the
  build records a sha256 of every file of a writable root
  (`tools/gogen/store.mjs`, into `zz_store.json`), and an object whose files
  still hash to it is active. A file that differs, or one this process
  wrote, is inactive, which is what Node answers after a WRITE.
- **CHECK, ACTIVATE, TOKENS** are the compiler's and the binary carries
  none: `activation needs a new generation (rebuild): ...` as EV_ERROR and
  as one issue that stands (rule `rebuild`; CHECK `no_compiler`), so the
  screen says "activated: 1 issue(s) ... Nothing is active while one of
  these stands" rather than "the system still compiles". TOKENS answers an
  error and the screen shows the source uncoloured.
- `-root` names the tree (default: the checkout the binary was built from);
  a tree without `abap_transpile.json` is answered "no object store here".

Measured against Node over one tree (`node tools/gogen/storecmp.mjs`, the
showcase checkout, 1569 objects): **1598 of 1598 read answers and 14 of 14
write answers equal** (EV_MS left out, and the time of a file each host wrote
itself), and the files the writes leave behind byte-equal; over
`testdata-store/tree` 29 of 29 and 20 of 20. The screen itself, OSGo and a
Node host on one scratch tree: 21 of 22 pages byte-equal (ten lists, eight
text areas, the save page, the list and the text area after a save); the one
that differs is the coloured display, where Node colours through the parser
and OSGo cannot, and with the colour stripped Go's text is the file while
Node's repeats a chained `TYPES:` keyword once per chained statement (a
defect of the colouring on Node, not of the text). `ZCL_GOGEN_T_STORE` in
`semantics.mjs` pins the fixture calls.

## CL_HTTP_CLIENT on OSGo (ultra/httpc, 2026-09-24)

open-abap-core's `CL_HTTP_CLIENT` does its network work in `WRITE '@KERNEL'`
lines of `IF_HTTP_CLIENT~SEND` (Node's `http` / `https`). They are host
functions now (`go/abap/httpc.go`, the `KERNEL` map in `frontend.mjs`, the
ICF shim's pattern); the ABAP around them compiles as it is. Node is the
oracle, including where it differs from a system (none of this is measured
on A4H):

- the request is what Node writes: the entity's header fields in JavaScript
  key order (array-index names first), `Host` without a default port,
  `Connection: keep-alive`, `accept-encoding: gzip` always, and
  `Transfer-Encoding: chunked` with an empty last chunk for a POST or PUT
  without a body. The method is upper-cased.
- the body is `get_cdata( )` written in Node's `binary` encoding, one byte per
  UTF-16 code unit: `€` goes out as `0xAC`, and `content-length` counts UTF-16
  units. A body that `set_data` filled with bytes that are not UTF-8 raises
  `CX_SY_CONVERSION_CODEPAGE` before anything is sent. A system sends UTF-8.
- a form field of a POST becomes the body, and so does the query of a URL
  given to `create_by_url` for a POST (the constructor turns it into form
  fields).
- the answer's header fields are Node's: lower case, latin1, trimmed,
  duplicates joined with `, ` (`; ` for cookie) or the first kept, set-cookie
  left out (an array there). The status reason stays empty, `~status_code`
  is never set (so ZCL_OSD_GIT's 4xx/5xx check never fires, on either host).
- one kept socket per client object; no timeout anywhere (SEND's `TIMEOUT` is
  ignored on Node too). A socket the server closed right after answering is
  redialled on Go; Node, sending again in the same turn of its loop, dumps
  with "socket hang up" there. That is the one documented choice.
- every failure (refused, TLS, protocol, a URL or header Node rejects) is a
  host error, a dump: on Node it is a JavaScript error no CATCH takes, so the
  classic exceptions of SEND and RECEIVE are never raised and sy-subrc is 0.
- a URL the WHATWG parser would rewrite (dot segments, characters it
  escapes, a numeric host it reads as IPv4, credentials, IPv6, IDN) is
  refused as NOT_COMPILED rather than guessed. `create_by_destination` is
  `ASSERT 1 = 'todo'` in open-abap-core and stays that.

`node tools/gogen/httpc.mjs` runs `testdata-httpc/zcl_gogen_t_httpc` on the
transpiler (Node) and on Go against one recording server: 35 of 35 cases,
33 byte for byte the same on the wire and in what the ABAP got back, one
refused on Go (dot segments) and the socket choice above.
`node tools/gogen/httpc-git.mjs` (after a full osgo build) does the same for
ZCL_OSD_GIT against `git http-backend` on 127.0.0.1: the requests Go sends
are Node's byte for byte. Since ultra/bytecmp (below) REFS answers what
Node answers; CLONE stops later, in `ZCL_ABAPGIT_GIT_PACK=>DECODE`.

The front end gained what the path needed: `sy-subrc` as a target,
`concat_lines_of( )` over a table of strings, host-function arguments
through a reference (`LO_ENTITY->MV_DATA`) and kernel lines that are nops;
`cl_abap_gzip=>decompress_binary_with_header` (zlib.gunzipSync: members in
turn, anything else a dump) and `cl_http_utility=>encode_base64` are host
functions. The OSG build went from 1290 to 1201 statement stubs, none new.

## Byte-like comparisons (ultra/bytecmp, 2026-09-24)

A comparison with an `x` or an `xstring` on either side follows what A4H
answered (`$ZOSG_TMP_0480` / `0481`, probes with the bodies of testdata
`ZCL_GOGEN_T_XCMP`, `_XCMPN`, `_XMOVI`):

- `x` against `x` of another length: the shorter is padded with 00 on the
  right (`x'AB' = x'AB00'`);
- `xstring` against `xstring`, or an `x` against an `xstring`: the bytes in
  order, a prefix is the smaller (`x'AB' < xstring AB00`); `v+off(len)` of an
  xstring is an xstring;
- against `c` or `string`, literal or not: the byte operand becomes its hex
  digits in upper case and the comparison is one of characters (`x'FF' <>
  'ff'`, `x'FF' < 'ff'`, `x'00' <> '0'`, an empty xstring `= ' '`);
- against `i` or `n`: the last four bytes, 00 on the left, a signed int32
  (`x'FF' = 255`, `x'FFFFFFFF' = -1`, five bytes `0100000002 = 2`, empty
  `= 0`). A move of an `x` or `xstring` into an `i` is the same rule.

Any other operand with a byte one (p, f, int8, d, t, an arithmetic or bit
expression) is refused. A c literal of upper-case hex pairs now moves into an
xstring, or into an x it fills exactly, as its bytes. The transpiler differs
in three places (ANORMALIES `byte-compare-x-length`, `byte-compare-numeric`,
`byte-to-i-move`); Node's ZCL_OSD_GIT never meets them.

`node tools/gogen/httpc-git.mjs` after this: REFS on Go equals Node, the
three requests are byte for byte the same, and CLONE stops in
`ZCL_ABAPGIT_GIT_PACK=>DECODE` at `GET_TYPE`, whose `iv_x TYPE x` is a
generic-length parameter. Behind it on the clone path: `GET_LENGTH`
compares a `BIT-AND` result, `ZCL_ABAPGIT_ZLIB=>DECOMPRESS` and
`CL_ABAP_MESSAGE_DIGEST` are `@KERNEL` host code, `DECODE_TREE` uses `FIND
... IN BYTE MODE`, `ZCL_ABAPGIT_HASH=>SHA1` needs i -> c and string ->
xstring moves. None of these is small, so the chain stops there. The OSG
build went from 1200 to 1184 statement stubs.

## RAW columns and the zvdb workbench (ultra/zvdb, 2026-09-24)

The zvdb pack (`ZVDB_100_SRV`, `/app/zvdb/`) keeps 8-1536-bit vectors in
`ZVDB_100_VEC-QBITS RAW(192)` and ranks them in ABAP (`ZCL_VDB_100_ANYDB`:
`BIT-XOR` of xstrings and a popcount). What it needed, each measured on A4H
first (`$ZOSG_TMP_0300`, probes pinned in `semantics.mjs`):

- **A RAW(n) column is n bytes.** Written as `x'12000000'` into a RAW(4) it
  reads back into an xstring as four bytes, an initial one as four 00 bytes.
  The store holds upper-case hex of 2n digits, in the transpiler's own
  `NCHAR(2n)` column so the seed loads unchanged; `prepareStore` pads a
  seeded value to 2n digits at open (the TABU rows of zvdb carry 192 digits
  for 192 bytes). Read into `x LENGTH m`: cut or 00-padded
  (`go/abap/dbraw.go`).
- **WHERE**: an x of the same length (another length does not activate), an
  xstring of exactly n bytes (another, empty too, is
  CX_SY_OPEN_SQL_DATA_ERROR), a literal of exactly 2n upper-case hex digits
  (in `WHERE (cond)` anything else is CX_SY_OPEN_SQL_DATA_ERROR); `=`, `<`
  and `ORDER BY` in byte order, which is the order of the hex text. IN and
  BETWEEN on RAW are refused (not measured).
- **SET / INSERT / UPDATE / MODIFY**: any x or xstring cut or 00-padded to n
  bytes, a string by the c -> x move rule. `tools/ir-writes.mjs` binds no
  bytes yet, so the build-time check of a write stands a STRING in for the
  column (`irCheck`); the Go runtime binds the real type (`dbwrite.go`).
- c / string -> x and xstring: the longest prefix of upper-case hex digits,
  an odd count padded with 0 (`CToX`); `SELECT SINGLE ... INTO (a, b)` and
  `(@DATA(a), @DATA(b))` by position, a miss keeps the targets;
  `CORRESPONDING #( s )`; `BIT-XOR` of xstrings, the shorter padded with
  00; a superclass's constant named through a subclass (the SEGW DPCs'
  `/IWBEP/CX_MGW_NOT_IMPL_EXC=>METHOD_NOT_IMPLEMENTED`, which is why an
  unimplemented DPC method now answers 501 as on Node, not 500).

Against OSG on Node (`test/run.mjs`, main 42755c5), request by request with
the port normalised: the service document, `$metadata`, `$count`, both
buckets with `$filter Bucket`, `$orderby Id`, `$top 2500` (1.2 and 1.3 MB),
`substringof` on Payload, `$skip`, `search=`, a single vector and a missing
one, the ANYDB search on both buckets, its three error answers, and 23 steps
of create / update / delete with their error cases: byte for byte the same.
The AMDP engine is CX_SY_DYN_CALL_ILLEGAL_FUNC on both (no SQLScript
database), in a different error body. In Chromium the workbench lists 2002
texts, and a search for the first gives the same 20 rows on both hosts.
Stubs in the zvdb classes: 30 before, 2 after (COMMIT_WORK's generic
`iv_rfc_dest` comparison and LOG_MESSAGE's `MESSAGE ... INTO`, SEGW
boilerplate that only RFC-mapped operations call; zvdb has none); OSG as a
whole 1184 -> 1025.

## NUMC moves, DEC columns written, demo data at boot (ultra/demodata, 2026-09-24)

`ZCL_OSD_DEMO_RANDOM`, `ZCL_OSD_DEMO_TAXI` and `ZCL_OSD_DEMO_DATA`
(`src/demo_data` on main) make the synthetic NYC taxi facts every host
starts with. What they needed, each measured on A4H first (`$ZOSG_TMP_0462`,
testdata `ZCL_GOGEN_T_NUMC`):

- `i` -> `n`: the sign dropped, the last digits kept, zeros in front (42
  into n 10 is `0000000042`, -5 into n 3 is `005`, 123456 into n 3 is
  `456`); `c` or `string` -> `n`: the digits only, right-aligned (`' 12'`
  is `0000000012`, `'a1b2 3'` into n 3 is `123`, `'98765'` is `765`, blank
  is `000`);
- `n` -> `string` keeps the zeros, `n` -> `c` is a move of its characters
  (`0000000042` into a c 8 is `00000000`), `n` -> `i` reads the digits;
  `n` by offset is its digits, as a `c`; `n` in `CONCATENATE` and in a
  template; an `n` constant whose VALUE is exactly its digits; `n` against
  `n` of one length compares the digits;
- a NUMC column `SELECT`ed into an `n` field of its length;
- a DEC column written (`INSERT` / `MODIFY` ... `FROM` a work area or a
  table): bound as the decimal text of the `p` field with the column's
  decimals. `tools/ir-writes.mjs` is main's (its `packedText` and the P and
  D initial values came with #55), and `WriteCol` now carries `Dec`; before,
  a DEC column read back 111.12 as 111.00.

`ZCL_GOGEN_T_DEMODATA` is the generator on both emitters, equal to A4H;
`ZCL_GOGEN_T_DEMODB` writes, rereads and replaces ZOSD_TAXIFACT on Go (the
table does not activate on A4H: its column `ZONE` is a reserved word in the
dictionary there). `semantics.mjs` fails when the testdata copies of the
three classes differ from `$OSG_HOME/src/demo_data`.

OSGo runs `ZCL_OSD_DEMO_DATA=>BOOT( OSD_DEMO_ROWS )` after `boot` in a
dialog step of its own; a dump there is logged and the server starts without
the rows. Measured on the workstation, OSGo built from the demodata tree:
20000 rows written in 571 ms on a new file, 332 ms for the unchanged second
start, checksum 999629773 as on Node and A4H (163171580 since the checksum folds the client, zone and payment in, #65 review); the cube's 555 groups by
borough, payment and hour equal Node's. The OSG build went from 1195 to 1053
statement stubs (11 of them in the demo classes).

Merged with ultra/zvdb, `dbwrite.go` binds both a RAW(n) and a DEC column;
`ZCL_GOGEN_T_RAWDEC` writes a row with one of each by INSERT and MODIFY
FROM TABLE and reads it back (Go only, not an A4H value: each rule is pinned
on its own above).

## Parity with OSG on Node: OSG's own suites against OSGo (ultra/parity, 2026-09-24)

`tools/gogen/parity.mjs` runs the HTTP-level suites of `test/suites.d/*.json`
against OSG on Node and against the osgo binary, the same test files, a fresh
server per suite file and backend. Those suites call `startServer()` from
`test/start.mjs` in their own process and then fetch `localhost:STG_PORT`; a
module hook (`parity/hooks.mjs`) turns `test/start.mjs` into a stub, so the
fetches reach the server the harness started instead. A probe
(`parity/register.mjs`) notes each test's requests (status, and the body of
an error), and a test that sent none is in-process and not compared.
`--e2e` adds the Playwright specs, one server per backend for the whole run.

    # a frozen checkout: a detached worktree of main, transpiled, packs fetched
    OSG_HOME=<checkout> flock <shared lock> node tools/gogen/osgo.mjs   # heavy
    OSG_HOME=<checkout> node tools/gogen/parity.mjs --e2e --out .local/parity/final
    OSG_HOME=<checkout> node tools/gogen/parity.mjs --report-only --out .local/parity/final
    # inside a wave: mocha suites only, Node reused, 4 at a time (~3.5 min)
    OSG_HOME=<checkout> node tools/gogen/parity.mjs --fast --out .local/parity/fast \
        --node-ref .local/parity/final/node-reference.json [--suites a,b] [--changed] [--jobs N]

The Node reference is reused by default: `<ref>.meta.json` records the
checkout commit, a hash of its tracked diff and the suites in it, and the
harness says "reused" or "STALE (why)" and runs only what is missing.
Suites run `--jobs` at a time (default cores / 2), each job with a server
of its own on `--port + 1 + slot` (4721.. by default); a mocha is a
process per suite and its probe notes only its own port, so attribution per
test does not change. `--changed` reruns just the suites OSGo did not pass
in full last time. Wall time is printed and written per phase.

The harness also guards the checkout's `gen/`: `test/shadowed-objects.mjs`
calls `compileAll("src", "gen/stg")` in its `describe` body, so even the
`--dry-run` count of the in-process suites runs it, and its sweep deletes
the `gen/stg` folders of every model it was not given (the four
CDS-published services and `zvdb_100`). The previous full run did that to
the frozen checkout, and an osgo built from it afterwards lost those
classes (CX_SY_CREATE_OBJECT_ERROR on `ZCL_ZVSTGTRAVEL_MPC_EXT`, 9 tests).
`gen/` is now copied aside at the start and put back after any phase that
changed it, with a warning naming what changed; the count is kept in the
reference's meta, so a reused reference does not run it at all.

Measured on main 6327bab, osgo from this branch (953 classes, 31 methods
not compiled): **55.6 %** -- 165 of the 297 HTTP-level tests that pass on
Node pass on OSGo (57.9 % without the 12 known divergences). 14 mocha suites
+ the Playwright specs; 130 suites (1905 tests) are in-process and not
applicable, plus 32 in-process tests inside the HTTP suites and
`zosd-test.mjs`, whose `before` needs the in-process database.

| group | tests |
|---|---:|
| the ADT façade (`/sap/bc/adt`, `/osd/not-served`): a JS module of the Node host, not ABAP, absent from OSGo | 86 |
| `escape( format = cl_abap_format=>e_json_string )` in `/UI2/CL_JSON=>SERIALIZE_INT` (RFC channel, transactions, e2e) | 18 |
| known: implicit MANDT, T0009 of client 001 is filtered by OSGo and served by Node | 12 |
| `ZCL_STG_SEGW_IMPORT=>IMPORT`: comparison of string with data (+ RepoSet and a timeout after it) | 7 |
| `GET_EXPANDED_ENTITYSET`: `SELECT * FROM zstg_demo_bk INTO` form | 2 |
| `DESCRIBE_BY_DATA`: output length of a DDIC type of kind C | 2 |
| the editor's parser colouring and compile check (Node host tools) | 2 |
| move of kind g into generic data of kind D; `ZCL_STG_SEGW_FUGR=>SIGNATURE` comparison; `CALL FUNCTION` without a host implementation | 1 each |

### Wave 1 (ultra/parity-wave1, 2026-09-24)

Seven NOT_COMPILED groups closed, each rule measured on A4H first
($ZOSG_TMP_0050, ABAP Unit probes of the testdata classes as they stand)
and pinned in `semantics.mjs` on Go and JS:

- `escape( format = e_json_string )` (ZCL_GOGEN_T_JSESC): `\\` `"`, `\b \t
  \n \f \r`, every other control character `\u00XX` in upper case; `/ '`,
  U+007F and non-ASCII unchanged; a generic operand read as a string. Node
  escapes only `\\ " \n` (ANORMALIES escape-json-string-control-characters).
- a generic operand compared with a c or a string (ZCL_GOGEN_T_GENCMP): the
  typed rule, both strings and a c without trailing blanks; any other kind
  at run time dumps NOT_COMPILED (`abap.DataChars`).
- a string into a d / t, generic and typed (ZCL_GOGEN_T_GENMOVD): the first
  8 / 6 characters, an empty string the initial value, a short t filled
  with zeros (Node: `''` into d is blanks, ANORMALIES empty-string-to-date).
- `SELECT ... FOR ALL ENTRIES` (ZCL_GOGEN_T_FAE): once per driving row, rows
  unique over the columns selected, sy-dbcnt counts them, an empty driving
  table ignores the whole WHERE; with GROUP BY, aggregates or ORDER BY refused.
- `describe_by_data`'s OUTPUT_LENGTH of a dictionary type
  (ZCL_GOGEN_T_RTTIOL): the domain's OUTPUTLEN, or the data element's
  without a domain, read off the abapGit XML (NUMC data elements included).
- function groups (ZCL_GOGEN_T_FM, ZGOGEN_T_FG): compiled as a pseudo class
  `FUGR:<group>`, a static method per module; CALL FUNCTION maps EXPORTING /
  IMPORTING / TABLES / CHANGING, a VALUE( ) exporting or changing goes
  through a temporary written back only on a normal return (after RAISE
  the caller keeps its values, TABLES rows appended stay). A group with
  global data, a global interface or a DEFAULT is refused.

`parity.mjs` puts two kinds of test apart from the headline:
`go-matches-system` (OSGo answers as a system does, Node's answer is an
ANORMALIES entry: the implicit MANDT) and `adt-deferred` (the ADT facade,
postponed). The headline is passed / (Node-passed - go-matches-system -
adt-deferred), the raw ratio is printed beside it.

**`compiler-deferred`** (rule confirmed by Alice, 2026-09-25, host-tools
review D2): a third class kept apart from the headline, holding **only the
editor's CHECK test** (`test/editor.mjs`, "checks the source it was
POSTED"). Its Node answer needs the compiler inside the running host
(abaplint over the whole registry); OSGo must answer it with an explicit
refusal naming the missing step (`store.go` `storeNoCompiler`, an error and
an issue that stands), never a success. It is out of numerator and
denominator until the incremental rebuild exists, printed on its own line as
`adt-deferred` is, one entry per test, and no other reason admits an entry.
The editor's **colouring is not deferred**: `ZCL_OSD_ABAP_TOKENS` scans in
ABAP (open-steamgate branch `feat/editor-colours-in-abap`), so that test is
expected to pass on OSGo and counts in the headline. The rule replaces the
wave-2 `HOST_TOOL` proposal; `parity.mjs` itself is the parity agent's to
change (note left in `.local/ultra-wip/parity-wave2-PROGRESS.md`).

Follow-ups on this branch from the same review:

- the store answers `CAPABILITIES` with `LIST READ WRITE`
  (`go/objstore` `Capabilities`, `TestStoreCapabilities`), so
  `ZCL_OSD_EDIT` draws no Check or Activate button on OSGo once the
  open-steamgate branch `feat/editor-capabilities` is in
  the tree osgo is built from. Done in this commit.
- `TOKENS` can go once the colouring PR is in that tree: `go/objstore/store.go`
  (the command switch, the `case "CHECK", "ACTIVATE", "TOKENS"` dispatch,
  the `TOKENS` branch of `storeNoCompiler` and the comment above
  `storeNoCompiler` and at the top of the file), the `TOKENS` call in
  `testdata/zcl_gogen_t_store.clas.abap` (line 129) with its part of the
  pinned `ZCL_GOGEN_T_STORE` answer in `semantics.mjs`, the comment in
  `frontend.mjs` (line 757), and `ET_TOKEN` in `storecmp.mjs` `FIELDS` if
  `ZOSD_STORE` drops the parameter. Until then an unknown-command answer
  and the current refusal read the same to the screen.
- `CL_ABAP_GZIP=>COMPRESS_BINARY` as a Go native (review K11): on
  `ultra/parity-wave2` (`go/abap/gzip.go`), not in this commit.

Measured after the wave (osgo from this branch on parity-home 6327bab, 965
classes, 33 methods not compiled; `--e2e`, Node reference reused):
**95.1 %** -- 176 of 185 (297 Node-passed, less 13 go-matches-system and 99
adt-deferred, of which 13 pass on OSGo anyway); raw 63.6 % (189/297). Before
the wave, the same arithmetic: 165/199, 83 %. `--fast` (mocha only): 131/136,
96.3 %. What is left: `CREATE DATA` of a type without a generated
descriptor in ZCL_OSD_WEBGUI (2 mocha + 2 e2e), `ImportSet` being slow on
OSGo (20-50 s a call against 1-5 s; one mocha timeout, the SEGW e2e spec
at 90 s), `CL_ABAP_GZIP=>COMPRESS_BINARY` (@KERNEL, RepoSet), and the
editor's parser colouring and compile check (2, Node host tools).
Wall time with 4 jobs: full 6m45s (the Playwright job alone 6m45s), fast
3m20s (segw-tree alone 3m17s), against ~40 min serial before.

### Wave 2 (ultra/parity-wave2, 2026-09-25)

Each rule measured on A4H first ($ZOSG_TMP_0080-0084, ABAP Unit probes of the
testdata classes, deleted after) and pinned in `semantics.mjs` on Go and JS
(264 ok, 0 FAIL):

- `CREATE DATA ... LIKE LINE OF` a generic table of elementary rows
  (ZCL_GOGEN_T_CRELEM): a new initial value of the row's type (`abap.NewData`
  on a built-in descriptor); /UI2/CL_JSON into ZOSD_NOTE's table of strings.
- `cl_abap_gzip=>compress_binary` / `decompress_binary` (ZCL_GOGEN_T_GZIP,
  go/abap/gzip.go): raw DEFLATE both ways; Node's zlib rules for a cut or a
  trailing stream measured there. Go's encoder writes other bytes than zlib
  (A4H writes zlib's): the stream inflates to the input on all three.
- `CL_ABAP_ZIP=>SAVE` (the SEGW RepoSet zip, ZCL_GOGEN_T_ZIP against SAP's
  own class): LCL_STREAM compiled as a local class, `DATA ... VALUE <local
  constant>`, an x / xstring operand of arithmetic as its move into i and an
  i for the calculation type (ZCL_GOGEN_T_XARITH), `CONCATENATE ... IN BYTE
  MODE` into an x, padded with 00 or cut with sy-subrc 4
  (ZCL_GOGEN_T_BYTECATX), `SHIFT x LEFT CIRCULAR IN BYTE MODE`. LOAD
  overflows i in open-abap-core (ANOMALY-2026-09-25-zip-read-int4).
- text into i and f (ZCL_GOGEN_T_C2NUM, 54 texts): an exponent, nan, inf,
  `1_0` or `0x10` are no number for an i; into an f the first word counts
  (`12 abc` is 12), 1E400 and nan / inf / Infinity overflow. Both backends
  had taken strconv.ParseFloat / Number( ).
- `FIND [FIRST|ALL] [REGEX|PCRE] p IN s [IGNORING CASE] RESULTS r`
  (ZCL_GOGEN_T_FINDRES, _FINDPCRE; open-abap-core's CL_ABAP_MATCHER and
  CL_IXML): POSIX leftmost-longest, PCRE leftmost-first with lazy
  quantifiers, (-1,0) for a group that did not take part, a missed FIRST
  keeps the structure and a missed ALL clears the table, empty matches as
  the kernel lists them. PCRE lookaround, backreferences, atomic groups,
  possessive quantifiers, \K, \G, recursion, conditionals and verbs are
  refused by name (Go's RE2 has none), as is PCRE on a text with line ends.
  JS is leftmost-first for REGEX too (pinned apart). REPLACE ... RESULTS is
  not done.

ImportSet was slow (20-50 s a call) because `FIND ... IN SECTION OFFSET`
converted the whole text to runes on every call, and ZCL_STG_SADL_DEF walks
its XML that way once per request of ZSTG_SEGW_SRV (45 of 60 s of a pprof;
`OSD_PPROF=1` or `-pprof` puts Go's profiler on a separate loopback-only listener; see [profiling](go/profiling/README.md)).
Then a prepared-statement cache that keeps the LUW (a text run twice in a
step is prepared once the step has ended; `TestLUWStatementCache`), and CP
without per-call rune copies (most of the GC). Same instrument on both
hosts, load 10-14 on 8 cores from other sessions:

| | Node | OSGo, wave 1 | OSGo now |
|---|---:|---:|---:|
| one ImportSet push (median of 11) | 42-57 ms | 20-50 s | 9-14 ms |
| one ExportSet pull (median of 11) | 25-32 ms | | 6-10 ms |
| segw-tree.mjs, its 11 HTTP tests | 25-29 s | 3m17s (whole suite) | 4.2-5.1 s |

What is left of a push is the ABAP's own work: CLEAR_PROJECT's 53 dynamic
SELECTs and row-by-row deletes in SQLite, the GC, and ZCL_STG_JSON reading
the body character by character.

Two holes the browser build found (CX_SY_DYNAMIC_OSQL_SEMANTICS on `1 = 1`
in the table sources behind SEGW, status and ICF; NOT_COMPILED
`LT_TAXI-ZONE` in ZCL_ZSTG_SADL_DPC) were the main checkout's stale `gen/`,
generated before #48 and #67: osgo built from a fresh transpile of the same
commit answers every entity set of the four services, and refusing `1 = 1`
is what A4H does (Node accepts it, which is why Node hid the stale code).
`osgo.mjs` and `parity.mjs` now refuse a checkout whose inputs hash to no
Node build (`osg-build.mjs` staleGen; `--stale-gen` overrides). The native
e2e set already covers the apps the preview specs open (launchpad-navigation,
taxi incl. its F4 selection, status, segw, listreport, fcl).

`parity.mjs` has a third class apart from the headline, `compiler-deferred`
(Alice, 2026-09-25): the editor's CHECK only, abaplint over the whole
system on Node, which a built generation cannot answer until the
incremental rebuild exists. The colouring test counts (it moves to ABAP,
ZCL_OSD_ABAP_TOKENS). Headline = passed / (Node-passed - go-matches-system
- adt-deferred - compiler-deferred).

Measured at the end (osgo from this branch on parity-home 6327bab, 968
classes, 31 methods not compiled, 2 objects with syntax errors; Node
reference reused): `--fast` **99.3 %** (134/135) in 10.7 s, full `--e2e`
**98.9 %** (182/184, raw 65.7 %) in 4m05s. Before the wave: 131/136 and
176/185, 200 s and 405 s. Left: the SEGW e2e spec's "Save to gen/" step
(cut from every host by Alice; passes once that PR lands) and the editor's
colouring (ZCL_OSD_ABAP_TOKENS). The one dump OSGo logs, CX_SY_CONVERSION_NO_NUMBER
in a `$batch` of mocha.mjs, is the test's own `Seats = "abc"`.

### Measured on main 63972f9 (ultra/parity-wave3, 2026-09-25)

The frozen checkout moved from 6327bab to 63972f9 (#84-#91: "Save to gen/"
cut, the editor's colouring in ABAP, the editor drawing only the buttons the
host can do, the greyed Workbench tile), transpiled afresh, osgo rebuilt from
this branch (788 classes, 33 methods not compiled, 2 objects with syntax
errors: `CL_APC_TCP_CLIENT_MANAGER`, `ZCL_AJSON`; every class of the Node
output but the ten test classes), Node reference measured again at that
commit. The editor's colouring and the SEGW "Save to gen/" step now pass.

One harness fix: a Playwright spec's requests are not probed, so an e2e test
whose failing assertion stands next to a request to `/sap/bc/adt` (the
snippet Playwright prints) is `adt-deferred` like the mocha ones. That is
launchpad-navigation's "the Workbench tile is live where ADT answers": HEAD
`core/discovery` is a 404 on OSGo, and the greyed tile is what #87 wants.

`--fast` **99.3 %** (136/137) in 55 s with Node run afresh; full `--e2e`
**99.5 %** (185/186, raw 66.0 %, 198/300) in 2m53s with Node reused (5m23s
with Node's e2e included). Apart: go-matches-system 13 (implicit MANDT),
adt-deferred 100 (13 pass on OSGo anyway), compiler-deferred 1. The one
failure left is editor.mjs "draws the buttons the host says it can do, and
on Node that is all three": it asserts Check and Activate, and OSGo draws
Save only because `STORE CAPABILITIES` answers `LIST READ WRITE`, which is
the design; the test assumes Node. Not a gap in OSGo; it is outside
`compiler-deferred` because that class admits the CHECK test only. Node
itself fails two e2e tests at both commits (the status object page's
Services section, the Workbench's "Browse only"), which are not counted.

## ABAP Unit, measured 2026-09-29

`node tools/gogen/unit.mjs` discovers the repository's
`test/unit/*.clas.testclasses.abap` and `src/**/*.clas.testclasses.abap`,
compiles each owner with its call and type closure, and returns JSON rows
`{class, testclass, method, status, message, alerts}`. It compiles test
includes only for selected owners. A reachable stub is listed in `alerts`
even when that branch was not executed. The runner uses the transpiler's
class/method discovery, then calls `class_setup`, `setup`, the test method,
`teardown`, and `class_teardown` in SAP's documented order. Each test
method gets a fresh instance; teardown runs after a failed method, later
methods still run, and class teardown runs at the end. The ordinary Node
runner stops on the first exception (see ANORMALIES). The comparison oracle
is `node-unit-results.mjs`, which instruments the Node metadata and follows
the SAP lifecycle. A DB-using class gets a fresh in-memory
SQLite database built from the transpiler's `DatabaseSetup` schema and
generated rows plus `test/seed.mjs` rows. Explicitly skipped methods remain
`SKIPPED`. An unbuilt owner cannot make another owner disappear; `--per-owner`
builds each owner separately for diagnosis. The normal runner accepts `--jobs N`
(`--jobs 1` keeps the single-process path; the default is the available CPU
count, capped at 16). Each invocation builds in a unique `--out/run-*` Go
tree and writes one seeded SQLite image, then runs test classes in separate
working directories with private temporary and DATASET directories. Shard
scratch and the seed image are removed after the run. `--out` holds
`class-timings.json`, which balances the next run; without timings, classes
are assigned in name order round robin. The report's `buildDir` points to
the run's Go tree for follow-on builds.
The JSON report keeps the single-process row order and schema. Completed
test classes are checkpointed after teardown. If a process dies, unfinished
classes each retry once in their own process; completed results stay intact.
An isolated death reports `runner died: <first stderr line>` and is ERROR
with exit code 2 through `osgo:unit`.
Each test process and the seed image get 120 s; `GOGEN_UNIT_TIMEOUT_MS`
sets another limit in milliseconds (a long benchmark), and a value outside
1..2147483647 (setTimeout's range) refuses the run. `--per-owner` gives each owner
that limit plus a minute for its build.

Run `npm run transpile` first for the Node oracle, then
`node tools/gogen/unit-compare.mjs --class ZCL_OSD_FORM_TEST --class ZCL_OSD_TIMER_TEST`.
The comparison uses the instrumented Node Unit results described above. Its
structured `_unit_open.mjs` path uses a different test-object lifecycle, so
it is not the oracle. The compare output separates same, different,
Node-only, Go-only, and configured skips. `node --test tools/gogen/unit.test.mjs`
checks pass, assertion failure, exception, hook order, and a dropped method.

### CI for generated classes

From an open-steamgate checkout pinned to the SHA your CI uses:

```sh
git checkout <pinned-sha>
npm ci
# GitHub Actions: load source pins into later steps' environment.
node tools/osd-lock.mjs github-env >> "$GITHUB_ENV"
node tools/osd-libs.mjs
node tools/osd-libs.mjs --check
export GOTOOLCHAIN=go1.26.0
npm run osgo:unit -- <generated-classes-dir> --json
```

Install Go 1.26 (and Node) on the runner. `osd-lock github-env` loads the
tracked source pins, as in `.github/workflows/tests.yml`; outside GitHub
Actions, export the assignments it prints before syncing libraries.

The directory is read without recursion; each `*.clas.testclasses.abap` owner with a matching
`*.clas.abap` is selected. `--jobs N` defaults to 4. `--class NAME...`
filters owners; put the directory before the filter. Immediate ABAP/XML
files, including helper classes and local includes, are copied into a
temporary layer after the checkout's inputs and packs. The caller's directory
and `abap_transpile.json` are unchanged, and the staging/build tree is
removed on completion. The underlying runner also accepts repeatable
`--input <dir>` overlays, with the last layer winning the complete object.
Overrides are reported on stderr and in JSON as `{object, input, hidden}`.
All immediate `.abap` files are checked before compilation: lines longer
than 255 characters, including comments and test includes, produce ERROR
(exit 2) without a Go build. Exactly 255 characters is accepted.

Missing class XML gets a default `VSEOCLASS`: EXPOSURE 2, STATE 1,
UNICODE X, FIXPT X, WITH_UNIT_TESTS X, and the class name as DESCRIPT.
Existing XML is copied unchanged. abaplint can discover a class from source
without XML; gogen reads its parsed class/method definitions rather than
requiring XML merely to find tests. Staging supplies explicit metadata for
source-only generators. A real abapGit import creates a class from the
`VSEOCLASS` properties in its XML; source files alone are not a complete
abapGit import repository.

JSON keeps the runner's fields (`classes`, `compiled`, `rows`, `timingMs`,
`layers`, `cache`, `buildDir`, `overrides`) and adds
`totals: {success, failure, not_compiled, error, tests}`. Rows contain
`{class, testclass, method, status, message}` and may include diagnostics.
`FAILED` is normalized to `FAILURE`; runner crashes, skipped methods, and
unknown statuses become `ERROR`. In particular, `SKIPPED` counts as ERROR
(exit 2), because a configured skip provides no evidence that the generated
test passed. `tests` counts method rows. `buildDir`
is diagnostic only: that temporary directory has already been removed.
Human output prints each non-SUCCESS method on one line, then totals.
Use `npm run --silent osgo:unit -- <dir> --json` when piping stdout to a
JSON parser, to suppress npm's script banner.

Exit codes: **0** means at least one test and all SUCCESS; **1** means any
FAILURE without NOT_COMPILED or ERROR; **2** means any NOT_COMPILED or ERROR
(including invocation/infrastructure errors); **3** means no tests found.
NOT_COMPILED/ERROR take precedence over failure or an empty method inventory.

`osd unit --go <dir> [--json]` dispatches the same tool through the osd host
when run from source in a checkout. The compiled binary carries neither
the Go toolchain nor the gogen tree, so this remains a checkout command;
`osd unit --go --help` explains the prerequisite and checkout recipe.

The real-build integration suite is registered in the `gogen` group and
runs in the Go workflow, alongside the gogen JS tests. Locally run
`flock /tmp/osd-heavy.lock node tools/osd-suites.mjs --group gogen`.

On this tree: **44 of 50 local test classes** built and ran at least one
method, across 25 of 28 owners. Of 271 repository methods, 56 matched
Node, 186 differed, 28 were Node-only because three owners did not build,
and one was skipped on both. Go returned 56 successes and 186 failures;
the 255 methods with static stub alerts are a separate risk count and are
not counted as failures unless they executed a stub. The three classes
green on both runtimes have 16 methods. Full method results and first
reasons are in the local report.

AMD Ryzen AI 7 PRO 350 w/ Radeon 860M, `nproc` 8, 2026-09-29. Each
runtime was timed alone under `flock /tmp/osd-heavy.lock` with the same
`/usr/bin/time -f '%e %M'` instrument; entries are medians of three runs.
RSS is KiB. A cold Go build used a new `GOCACHE` each time. The exact
intersection includes a seeded DB class.

| Work | Node wall | Node peak RSS | Go wall | Go peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Same 3 green classes, 16 methods, execution | 1.31 s | 475,540 | 0.23 s | 80,324 |
| Go build, cold | — | — | 14.95 s | 746,544 |
| Go build, warm | — | — | 0.16 s | 30,636 |
| Full sets, separately: Node 278 methods; Go 242 runnable methods in 25 binaries | 10.80 s | 848,816 | 4.60 s | 335,520 |

The full-set row has different populations and process layouts; it is not
a speed ratio. The full Go inventory itself took 7:24.89 and peaked at
1,768,808 KiB in one run (n=1), which kept the full runner out of `gogen.yml`
at U1's five-minute CI threshold. `unit-bench.mjs` and
`unit-full-bench.mjs` reproduce the timing rows.

### Layered Unit build, 2026-09-30

`unit.mjs` now parses the repository and libraries once, grows all 28
owners' closures in that registry, and emits three Go packages:
`generated/core` for libraries and shared types, `generated/app` for
production classes, and `cmd/unit` for test include classes and the one
runner. A class that refers to a higher layer is promoted to that layer;
cross-layer class cycles are kept together and reported in `layers` in the
JSON result. The Go compiler's method-level errors become typed stubs that
raise `NOT_COMPILED` when called, then the same binary is retried. This lets
other methods run. `--per-owner` remains available as an isolation fallback.
The result JSON includes per-round frontend times, emission, Go build and
execution times. `unit-layer-bench.mjs`, run under `flock
/tmp/osd-heavy.lock`, measures cold and warm full inventories and warm
rebuilds after a source edit in one app class or test include; it restores
both files. The app case uses `go build -x` to check whether core compiled.

The complete generated inventory gives the same comparison in the layered
run and the per-owner fallback: 66 SAME, 204 DIFFERENT, 7 Node-only, 0
Go-only, 1 skipped. U1's 56/186/28 baseline preceded this worktree's SEGW
generated sources; the compared method populations differ. There were 172
core classes, 233 app classes and 51 unit classes
in the combined closure. Fourteen library classes were promoted to app
because they use app-owned types; no cross-layer class cycle appeared.

| Full inventory | Wall, seconds | Peak RSS, KiB | Frontend, ms | Rounds | Emit, ms | Go build, ms | Run, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Per-owner fallback, one run | 244.91 | 910,192 | 148,692 | 82 | 2,829 | 76,121 | 5,770 |
| Layered, cold cache, median of 3 | 37.55 | 988,480 | 7,886 | 3 | 1,090 | 22,143 | 5,245 |
| Layered, warm full, median of 3 | 16.56 | 951,184 | 7,930 | 3 | 923 | 1,109 | 5,207 |
| Layered, warm after app edit, median of 3 | 21.36 | 977,800 | 8,003 | 3 | 1,080 | 5,951 | 5,178 |
| Layered, warm after test edit, median of 3 | 17.59 | 1,008,516 | 7,991 | 3 | 1,016 | 1,960 | 5,459 |

Each cold run used a fresh `GOCACHE`; the warm cache was primed before its
three measured runs. The edits added ABAP comment lines before one app class
or one test include, changing generated Go line positions and restoring the
original source after each run. In all three app-edit traces, `go build -x`
compiled app and reused core. The per-owner fallback is a single run, not a
median, and includes 28 Node processes and 28 Go builds; its phase totals
exclude process startup and orchestration overhead.

The warm full build and run are under five minutes, so `gogen.yml` has a
non-blocking `unit-inventory` job that saves the JSON result.

Next gaps in order: generic `CL_ABAP_UNIT_ASSERT` comparisons (45 failed
methods); Go emitter addresses of fields in temporary values and missing
inherited `DEFINE` (28 methods in three unbuilt owners); AJSON parsing
(13 failed methods); and the UUID kernel hook (four DB tests). Parallel
classes were not timed: `go/abap/db.go` still has one process-global DB.
Generated class constructors and class data now belong to each Session.

### Static attribute write targets

`class=>attr` resolves to the declaring class's storage for reads and writes,
including an explicit name of the current class. The target class constructor
runs before an assignment, CLEAR, a table mutation or a reference actual.
The owning class uses its session-owned field after its constructor has run.
External READ-ONLY writes are compilation refusals except for declared friends.
LOCAL FRIENDS test classes may write private and READ-ONLY static attributes;
private-access refusals name the declaring class. REPLACE SECTION supports
byte and character mode; CONCATENATE supports both modes. Fixed hex attributes
also accept offset/length assignment. Offset reads and XSTRLEN use the same
static attribute resolution.

The static oracle fixture covers six ABAPiti cases; the static write fixture
covers constructor ordering, character sections, tables and output actuals.
The chunk fixtures alternate interface calls through static references to depth
2000 and count 2001 calls. Go ABAP Unit and the JS emitter check the same answers.
Public static xstrings keep the string ABI; they are outside owned-buffer
selection. Private static xstrings qualify under the same escape rules as
private instance attributes. The static owned fixture checks constructor
initialization, snapshots, section reads, stores, self-append and reset between
test classes. Friend pools and reference actuals keep string storage. The
generated 16-page equal-length store allocates zero bytes.
