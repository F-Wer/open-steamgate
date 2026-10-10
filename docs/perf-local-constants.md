# Local constants evaluated once

Literal method-local `CONSTANTS` now use program constants in the gogen IR.
Their initializers run once at Go package initialization or JS module loading,
using the same VALUE conversion expressions as local DATA. This includes
literal fields of a local `CONSTANTS: BEGIN OF ... END OF` structure and
constants declared inside loops. Reads refer to the program value directly;
there is no initialization at method entry. Function-module locals use the
same lowering path.

No new numeric folding is introduced: float text still uses `ParseF`, int8
text still uses `ParseI8`, and fitting/rounding keeps the existing converters.
Class/interface constants already have package/module scope and keep their
existing behavior. Nonliteral elementary initializers keep their previous
path; nonliteral structure fields remain unsupported. Hoisted names retain
the declaring class prefix for layered builds.

Constants cannot be assignment targets. JS constant structures are frozen;
moving one into DATA copies the value so the destination remains writable.

The semantics fixture covers float text (`-2147483648`, `2147483647`,
`1E+2`), packed decimal rounding, both int8 bounds, i, n/d/t/c fitting,
string, a structure, copying that structure, loop use and repeated method
calls. Expected values are a regression oracle from the existing conversions,
not a new SAP measurement. The emission regression checks both backends and
was confirmed red against the original Go method-body `ParseF` assignment.

## Lexer measurement

Input: the read-only TS-HA lexer closure at input revision `4032aab`.
The retained lexre harness assembles the original embedded payload and stops
RUN after lexer count, dump and hash validation. The lexer time excludes
assembly, dumping, hashing and compilation. Each timing is a fresh Go
process; the result is the median of three. Before uses the unmodified
frontend/emitter from `7720f6e`; after uses this change with the same runtime.

| Go | Three lexer samples (µs) | Median (s) |
|---|---|---|
| Before | 2416826, 2350102, 2277261 | 2.350102 |
| After | 1738195, 1738357, 1869464 | 1.738357 |

Lexer time decreased by **26.0%**. The generated ADD method no longer
contains either bound constant's `ParseF` initializer. The generated binaries
use Go 1.26.0.

All six retained runs return `X`, 609,647 tokens and SHA-256
`9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40`.
All 953 input files still match lexre's manifest. Runs use
`GOFLAGS=-buildvcs=false`, the shared Go cache, RAM scratch, `nice -n10` and
heavy instance range 50–59. Resource gates require IO some avg10 < 30,
MemAvailable > 20 GiB and load < 12 before samples. Shared-host contention
limits attribution of small timing differences.

## Validation

- Full `semantics.mjs`: 384 Go/JS checks, 0 FAIL, including padding,
  repeated calls and modification of a DATA copy of the constant structure.
- Original frontend/emitter fixture replay: identical Go and JS output;
  the formerly unsupported local structure uses the old equivalent DATA
  field assignments for this comparison.
- Emitter and frontend-cache tests cover the hoist, read-only targets and
  invalidation when either new helper changes. The cache fixture now writes
  valid JSON for the configuration read by pack discovery.
- `go test ./abap ./intarith ./packedint`, changed size budget and leak scan.

Scratch scripts and logs are retained in `.local/constants-once/`; generated
lexer builds and all six sample records are in RAM scratch `constants-before`
and `constants-after`. No benchmark input or harness source is committed.
