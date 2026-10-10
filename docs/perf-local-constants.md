# Local constants evaluated once

Literal method-local `CONSTANTS` use program storage only when the frontend
can prove their VALUE conversion exception-free at build time. The proof
uses the existing JS runtime converters (`ParseF`, `ParseI`, character,
date/time and numeric-text fitting), not a separate numeric parser. Successful
conversions fold to exact Go/JS literal IR. Unknown conversions, negative zero,
and conversions that raise remain on the ordinary per-entry path, in declaration
order alongside `DATA ... VALUE`. Literal byte and already-folded packed values
also use program storage; int8 conversions currently remain per-entry.

There are no per-method initialization helpers, guards or mutable first-call
state. Package initialization needs only exception-free literal expressions.
Unused methods therefore cannot raise from local constants during program load.
Recursive and subsequent entries share the folded values without a guard.
A local constant structure is hoisted only if every field folds safely;
otherwise all original field initializers stay together in declaration order.
Constants declared inside loops and function-module locals use the same path.

Class/interface constants retain their existing behavior. Nonliteral elementary
initializers, including references to another local or class constant, keep
their previous per-entry path; nonliteral structure fields remain unsupported.
Names retain the declaring class prefix for layered builds, followed by
length-prefixed hexadecimal encodings of the full class, method and constant
names. This distinguishes underscores, local-class `OWNER:LOCAL` names and
interface-method `INTF~METH` names. Duplicate constant symbols fail generation
loudly. Constants cannot be assignment targets. JS hoisted constant structures
are frozen; moving one into DATA copies the value so the destination is writable.

The semantics fixtures cover float text (`-2147483648`, `2147483647`,
`1E+2`), packed decimal rounding, both int8 bounds, i, n/d/t/c fitting,
string, x, xstring, a structure, copying that structure, loop use and repeated
method calls. They also cover recursive entry, dependencies on a local and a
class constant, the `A__B/C` versus `A/B__C` collision, unused overflow,
conversion failure and retry before the method body, and function modules.
The ordering regressions check that invalid integer DATA before an overflowing
float scalar or structure constant raises `CX_SY_CONVERSION_NO_NUMBER`, while
an overflowing structure before invalid DATA raises `CX_SY_CONVERSION_OVERFLOW`.
Each runs twice through Go and JS. Emitter tests execute local classes and
interface methods in both backends; 32 concurrent first calls in a fresh Go
process pass `go test -race` without WorkProcess or a host lock. A JS conversion
counter checks that only fallible conversions execute at entry and retry.
FORMS have no lowering path here. These are regression oracles, not new SAP
measurements.

## Lexer measurement

Input: the read-only TS-HA lexer closure at input revision `4032aab`.
The retained lexre harness assembles the original embedded payload and stops
RUN after lexer count, dump and hash validation. The lexer time excludes
assembly, dumping, hashing and compilation. Each timing is a fresh Go
process; the result is the median of three. Before uses the unmodified
frontend/emitter from `7720f6e`; eager hoist uses `be3d8da44`; lazy hoist
uses `7d0e15f03`; safe folding uses round 3. All use the same runtime and
harness. The final frontend emits byte-identical Go source to the measured build.

| Go | Three lexer samples (µs) | Median (s) |
|---|---|---|
| Before | 2416826, 2350102, 2277261 | 2.350102 |
| Eager hoist | 1738195, 1738357, 1869464 | 1.738357 |
| Lazy hoist (round 2) | 1851495, 1909630, 1759769 | 1.851495 |
| Safe folding (round 3) | 1843536, 1807025, 1826166 | 1.826166 |

Safe folding retains a **22.3%** lexer improvement over the original median.
The generated ADD method reads folded float bounds without a per-entry
conversion or initialization guard.
The generated binaries use Go 1.26.0. These are lexer-only measurements;
no end-to-end improvement was measured.

All twelve retained runs return `X`, 609,647 tokens and SHA-256
`9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40`.
All 953 input files still match lexre's manifest. Runs use
`GOFLAGS=-buildvcs=false`, the shared Go cache, RAM scratch, `nice -n10` and
heavy instance range 50–59. Resource gates require IO some avg10 < 30,
MemAvailable > 20 GiB and load < 12 before samples. Shared-host contention
limits attribution of small timing differences.

## Validation

- Full `semantics.mjs`: 388 Go/JS checks, 0 FAIL, including the entry/retry and byte
  regressions, initializer ordering and function-module constants.
- Emitter and frontend-cache tests: 43 passed, 0 failed. They cover safe
  loading, per-entry retry, literal folding, local classes, interface-method
  names, collision refusal, read-only targets and helper cache invalidation.
  Generated Go passes a 32-concurrent-first-calls race test outside WorkProcess.
- `go test -race ./abap ./intarith ./packedint`, changed size budget and staged
  leak scan all exit 0.

Scratch scripts and logs are retained in `.local/constants-once/`. The new
lexer build and three samples are in RAM scratch `constants-round3`; round 2
remains in `constants-fix`, and original
before/after runs remain in `constants-before` and `constants-after`.
No benchmark input or harness source is committed.
