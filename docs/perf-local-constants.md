# Local constants evaluated once

Literal method-local `CONSTANTS` use program storage in the gogen IR.
Both backends initialize that storage lazily on first entry into the owning
method, through one guarded helper per method. The guard becomes true only
after every initializer succeeds. A failed conversion therefore raises at
method entry, leaves the guard false, and is retried on the next entry.
Unused methods cannot raise from their local constants during program loading.
Successful initialization is shared by recursive and subsequent entries.
This also applies to literal fields of local constant structures and constants
declared inside loops. Function-module locals use the same lowering path.

No new numeric folding is introduced: float text still uses `ParseF`, int8
text still uses `ParseI8`, and fitting/rounding keeps the existing converters.
Class/interface constants retain their existing behavior. Nonliteral elementary
initializers, including references to another local or class constant, keep
their previous per-entry path; nonliteral structure fields remain unsupported.
Names retain the declaring class prefix for layered builds, followed by
length-prefixed hexadecimal encodings of the full class, method and constant
names. This distinguishes underscores, local-class `OWNER:LOCAL` names and
interface-method `INTF~METH` names. Duplicate constant symbols and conflicts
with generated initializer/guard symbols fail generation loudly.

Constants cannot be assignment targets. JS constant structures are frozen;
moving one into DATA copies the value so the destination remains writable.

The semantics fixtures cover float text (`-2147483648`, `2147483647`,
`1E+2`), packed decimal rounding, both int8 bounds, i, n/d/t/c fitting,
string, x, xstring, a structure, copying that structure, loop use and repeated
method calls. They also cover recursive entry, dependencies on a local and a
class constant, the `A__B/C` versus `A/B__C` collision, unused overflow,
conversion failure and retry before the method body, and function modules.
Emitter tests execute local classes with an interface method and an ordinary
method sharing a constant name in both Go and JS. A conversion-counting JS
probe verifies retry and successful caching during recursive re-entry. A
numeric RUN returns 1 with an unused overflow constant; calling that method
raises `CX_SY_CONVERSION_OVERFLOW` in both backends. FORMs have no lowering
path here. These are regression oracles, not new SAP measurements.

## Lexer measurement

Input: the read-only TS-HA lexer closure at input revision `4032aab`.
The retained lexre harness assembles the original embedded payload and stops
RUN after lexer count, dump and hash validation. The lexer time excludes
assembly, dumping, hashing and compilation. Each timing is a fresh Go
process; the result is the median of three. Before uses the unmodified
frontend/emitter from `7720f6e`; eager hoist uses `be3d8da44`; lazy hoist
uses this fix. All use the same runtime and harness.

| Go | Three lexer samples (µs) | Median (s) |
|---|---|---|
| Before | 2416826, 2350102, 2277261 | 2.350102 |
| Eager hoist | 1738195, 1738357, 1869464 | 1.738357 |
| Lazy hoist (fix) | 1851495, 1909630, 1759769 | 1.851495 |

The lazy fix retains a **21.2%** lexer improvement over the original
median (the eager hoist measured 26.0%). The generated ADD method calls a
guarded initializer instead of converting its bounds on each entry.
The generated binaries use Go 1.26.0. These are lexer-only measurements;
no end-to-end improvement was measured.

All nine retained runs return `X`, 609,647 tokens and SHA-256
`9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40`.
All 953 input files still match lexre's manifest. Runs use
`GOFLAGS=-buildvcs=false`, the shared Go cache, RAM scratch, `nice -n10` and
heavy instance range 50–59. Resource gates require IO some avg10 < 30,
MemAvailable > 20 GiB and load < 12 before samples. Shared-host contention
limits attribution of small timing differences.

## Validation

- Full `semantics.mjs`: 388 Go/JS checks, 0 FAIL, including the entry/retry and byte
  regressions and function-module constants.
- Emitter and frontend-cache tests: 43 passed, 0 failed. They cover lazy
  loading, retry, successful caching, local classes, interface-method names,
  collision refusal, read-only targets and helper cache invalidation.
- `go test ./abap ./intarith ./packedint`, changed size budget and staged
  leak scan all exit 0.

Scratch scripts and logs are retained in `.local/constants-once/`. The new
lexer build and three samples are in RAM scratch `constants-fix`; original
before/after runs remain in `constants-before` and `constants-after`.
No benchmark input or harness source is committed.
