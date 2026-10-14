# Gogen typing triage

Alice, 2026-10-14; owner: stoker. Analysis of OSG `3ee404ca1260464221f5eba7d86a06a38eabc6c4`; no generator changes in this task.
Recommendation: type the generator, simplify incidental JS, and retain its recursive IR. Do not make abapiti implement the whole OSG host merely because a parser lives beside a broker.
Inputs: abapiti [union plan](https://github.com/oisee/abapiti/blob/6ed0e12230c7e491c32f04775d23f6bdff6a374e/docs/union-abi-plan.md) and [recon JSON](https://github.com/oisee/abapiti/blob/6ed0e12230c7e491c32f04775d23f6bdff6a374e/docs/evidence/union-abi-recon.json), cloned as `.abapiti` at `6ed0e122`. The measured compiler is `6e942068`; measured OSG is `0abbef3f`. **All 51 implementation hashes still match this checkout.**
The four TS files pass the upstream checker; `allowJs: true, checkJs: false` does not type their imported JS. The public pilot has 76 findings (70 roots, six cascades); the full untrapped closure panics. Its 6,692 repair-note records comprise 69 pilot, 11 external declaration, and 6,612 untriaged implementation records. They are neither independent defects nor 6,692 union failures.

## Blocker decisions

G = cheaper OSG change; A = capability abapiti needs for ordinary typed TS. Hours below are engineering estimates, including focused proof, not measurements. Compiler efforts overlap and must not be summed.

| Pilot group | Decision and smallest useful action | OSG effort / estimated pilot reduction | A work still needed |
| --- | --- | --- | --- |
| Recursive aliases / metadata intersections: 31 | **A**; keep literal `k/e/s/c` tags, metadata and recursive payloads | 0 / **0** | Named recursive graph, structural identity, narrowing and payload views: union plan's 2–4 days |
| Callable/import: 22 | **A**, with G for five missing local implementation/import findings; type frontend/emitter contracts and separate naming from emission | 4–8h boundary work plus conversions below / **up to 5**; these already disappear in the measured full closure | Typed callbacks, constructors, imports, `instanceof`, abaplint implementations and Node adapters: 3–8 days initial contracts; complete parser/host execution unestimated |
| `Extract` / indexed access: 6 | **A**; keep checker-resolved subset aliases and map field types | 0 / **0** | Resolve utilities to retained recursive layouts: 1–2 days after union ABI; spelling duplicate interfaces would only hide the requirement |
| Nullable/truthiness: 1 | **G**; constructor `every` predicate returns boolean: `p.optional === true`, default presence, or supplied name neither undefined nor empty | 1h / **1 candidate** | Null/undefined/optional fields, `??`, optional chains remain **A**, 1–2 days initial support; preserve all 11 documented mixed-absence fields |
| Other: 16 | **G**, partly; property `??=` is **A and done** (abapiti #162), so gogen keeps those sites. Map/Set from iterables and spreads of keys/values are **A** (abapiti, after M1); rewriting those gogen sites is optional, only if it unblocks earlier | 4–8h / **7 direct candidates**, up to six dependent cascades; two `canOmit` findings also depend on the nullable fix | Generic Map/Set, arrays, numeric/string operations and filesystem calls remain **A**; 1–3 days for container cases, adapters separate |
| Tag narrowing / shared discriminants: 0 / 0 | **A**; zero visible findings because failed signatures conceal bodies | 0 / **0** | Test recursive guards, shared tags and multi-literal alternatives as part of union ABI |

Pilot G opportunity: roughly **13 direct records**, potentially six cascades, conditional on A dependencies; do not promise 19 net removals. New bodies can expose new failures. The 11 abaplint namespace declarations are an A library boundary issue, outside the 76; annotations cannot supply their executable implementations. abapiti's partial-HIR panic is fixed (abapiti #161): the full raw inventory at `0abbef3f` is now 5,829 blocking findings (2,925 roots) and 4,728 HIR errors in 32 files.

## Every file in the measured closure

Paths are under `tools/`; `g/` means `gogen/`. R = observed full-closure repair records (51 rows sum to 6,681; the other 11 are external declarations). Δ = estimated records a G change could remove, **not a measured net compiler improvement**; ranges are hypotheses from the source, and exclude A dependencies. Do not add Δ to pilot reductions.
`cut1` removes the AMC import edge by moving `parseSamc` unchanged into a typed shared leaf; **14 files / 533 records** leave the generator closure. `cut2` replaces the constant folder's whole-runtime import with a small typed port of its eight scalar helpers; **two files / 900 records** leave. These cuts do not claim those runtime bodies now compile. Cut rows cost 0h individually; their shared PR costs are P1/P2. Keep host and emitted-runtime behavior intact.

| File | R | G/A: action | Hours | Δ / PR |
| --- | ---: | --- | ---: | --- |
| `adt-single-select.mjs` | 7 | G: cut1; keep runtime SQL adapter | 0 | 7 / P1 |
| `g/append.mjs` | 1 | G: generic arrays, explicit `void` | 1–2 | 1 / P3 |
| `g/emit-builtins.mjs` | 18 | G: tagged builtin Expr, typed renderer and lookup maps | 2–4 | 10–16 / P4 |
| `g/emit-bytes.mjs` | 16 | G: statement subset and renderer context | 2–4 | 10–14 / P4 |
| `g/emit-constructors.ts` | 4 | G: explicit Map population and boolean predicate; A recursive args/imports | 2–3 | 1–2 / P8 |
| `g/emit-exception.mjs` | 20 | G: Program/Class and explicit helper interface | 3–5 | 12–18 / P4 |
| `g/emit-go.mjs` | 531 | G: typed emitter state, tag switches, explicit returns; remove property-bag walks | 24–40 | 250–400 / P9 |
| `g/emit-int8.mjs` | 8 | G: narrowed Expr, typed operator Map, explicit child traversal | 2–4 | 4–7 / P4 |
| `g/emit-local-constants.mjs` | 10 | G: explicit constant/init variants | 1–2 | 6–9 / P4 |
| `g/emit-owned.mjs` | 53 | G: ownership and renderer interfaces | 3–6 | 30–45 / P4 |
| `g/emit-packedint.mjs` | 14 | G: tagged operations, typed rendering callbacks | 1–3 | 8–12 / P4 |
| `g/emit-table-move.mjs` | 21 | G: typed paths/bindings and exhaustive IR visitor | 4–8 | 12–18 / P4 |
| `g/frontend-analysis.mjs` | 18 | G: cut1, typed WeakMaps/node results; CDS names as Map | 3–5 | 8–14 / P1,P6 |
| `g/frontend-boolx.mjs` | 8 | G: typed token edits and parser boundary | 2–3 | 4–7 / P3 |
| `g/frontend-builtins.mjs` | 48 | G: helper interface, literal type factories, operator Map | 4–6 | 25–40 / P6 |
| `g/frontend-bytes.mjs` | 94 | G: typed node/helpers and narrowed statement results | 4–8 | 45–75 / P6 |
| `g/frontend-diagnostics.mjs` | 8 | G: Registry/session/Diagnostic signature | 1–2 | 3–6 / P3 |
| `g/frontend-find-results.ts` | 13 | A: already typed; retain parser constructors, callbacks and Extract | 0 | 0; shared A work |
| `g/frontend-hierarchy.mjs` | 25 | G: typed WeakMap entries and callback returns | 2–4 | 15–22 / P3 |
| `g/frontend-literals.mjs` | 15 | G: named token/helper interfaces, literal return tags | 2–3 | 8–12 / P3 |
| `g/frontend-local-constants.mjs` | 47 | G: cut2, tagged literal values, typed field Map | 4–8 | 20–35 / P2,P6 |
| `g/frontend-object-cache.mjs` | 118 | G: tagged cache entry/frames, typed session, validated deserialization | 12–20 | 50–90 / P7 |
| `g/frontend-owned.mjs` | 30 | G: declared ownership sets and typed IR child visitor | 4–8 | 15–25 / P6 |
| `g/frontend-replay.mjs` | 15 | G: replace Proxy/method strings with typed access/effect wrappers and tagged operations | 16–24 | 8–13 / P7 |
| `g/frontend-session.mjs` | 89 | G: explicit snapshot fields and scalar/replay entry union | 6–12 | 40–70 / P7 |
| `g/frontend-source-key.mjs` | 15 | G: typed graph Maps, numbered components, explicit arrays | 2–4 | 8–13 / P3 |
| `g/frontend-static.mjs` | 31 | G: typed lookup context, dependencies and slot return | 4–6 | 15–25 / P6 |
| `g/frontend.mjs` | 3,582 | G: compile options/context/state, typed parser loader, factories, tag switches and Maps | 64–112 | 1,600–2,600 / P8 |
| `g/ir.ts` | 34 | A: recursive unions, utility subsets and external parser contracts are legitimate TS | 0 | 0; shared A work |
| `g/js/abap.mjs` | 824 | G: cut2; leave emitted JS runtime file unchanged | 0 | 824 / P2 |
| `g/js/pcre.mjs` | 76 | G: cut2; regex runtime no longer in generator closure | 0 | 76 / P2 |
| `g/sink-locals.mjs` | 25 | G: explicit Expr/Stmt visitor, typed block/identity Maps | 4–8 | 12–20 / P4 |
| `g/symbols.ts` | 18 | G: simple ordered collections, explicit init, typed emitter import; keep real fs adapter | 4–8 | 6–12 / P0,P9 |
| `ir-ranges.mjs` | 68 | G: range-row, predicate and options interfaces; A SQL union/nullable semantics | 6–10 | 30–50 / P5 |
| `ir-writes.mjs` | 52 | G: typed write union, column/value Maps and return types | 6–12 | 25–40 / P5 |
| `osd-abapgit-config.mjs` | 16 | G: cut1; keep repository config reader | 0 | 16 / P1 |
| `osd-amc.mjs` | 64 | G: cut1; re-export typed parser, retain broker | 0 | 64 / P1 |
| `osd-cockpit-apps.mjs` | 5 | G: cut1; host application discovery | 0 | 5 / P1 |
| `osd-daemon-context.mjs` | 3 | G: cut1; async host context | 0 | 3 / P1 |
| `osd-dialog-step.mjs` | 110 | G: cut1; LUW/WAIT host outside generator | 0 | 110 / P1 |
| `osd-lock.mjs` | 19 | G: cut1; host lockfile discovery | 0 | 19 / P1 |
| `osd-main.mjs` | 1 | G: cut1; host entry detection | 0 | 1 / P1 |
| `osd-narrow-submit.mjs` | 26 | G: typed parser/token edit result | 3–5 | 12–20 / P5 |
| `osd-object-name.mjs` | 1 | G: cut1; host object-name validation | 0 | 1 / P1 |
| `osd-packs.mjs` | 88 | G: cut1; keep layer discovery outside compiler core | 0 | 88 / P1 |
| `osd-source-layers.mjs` | 56 | G: cut1; host layer/config handling | 0 | 56 / P1 |
| `osd-source-write-check.mjs` | 19 | G: cut1; host filesystem checks | 0 | 19 / P1 |
| `osd-source-zip.mjs` | 91 | G: cut1; ZIP/Buffer host implementation | 0 | 91 / P1 |
| `osd-tmp.mjs` | 53 | G: cut1; temporary-package host policy | 0 | 53 / P1 |
| `sqlscript-ir.mjs` | 78 | G: recursive relational/expression union, explicit factories; A recursive ABI | 8–16 | 30–55 / P5 |
| `sqlscript-lower.mjs` | 95 | G: dialect/context interfaces, recursive typed SQL renderer | 12–20 | 40–70 / P5 |

Full-closure reductions must be remeasured. The two boundary cuts target 1,433/6,692 records, leaving a historical 5,259-record workload before new leaf diagnostics; new typed helper records will replace some. Other Δ ranges are coarse budgeting aids, not a causal attribution of the 6,612 findings. The 303 `KindIdentifier`, 241 `kids`, 161 spread and 140 dynamic `get` records illustrate why annotations can help but cannot predict net counts.

## Small PR sequence (all proposed, no PRs opened)

Use named interfaces, explicit return types and literal-tag factories (`satisfies` where useful); typed `Map<K,V>` for computed dictionaries. No `any`, double casts through `unknown`, broad index-signature escape hatches, `@ts-ignore`, enums, parameter properties or runtime namespaces. Use `unknown` only at IO boundaries with actual validation. Preserve property presence and insertion order when serializing Maps. Distinguish mutable frontend state from readonly finished IR; today's Program interface does not cover every JS mutation.

1. **P0, proof/contracts (4–8h):** add the byte comparison driver described below; pin direct Node declarations, explicit `types: ["node"]`, `verbatimModuleSyntax`, and keep strict/erasable/noEmit. Extract pure naming from `symbols.ts` into `go-symbols.ts`, retain compatibility exports in `go-symbols.mjs`; emitter imports the pure leaf, breaking the symbols/emitter runtime cycle. Shared helper contracts use type-only imports. Make the TS check required once this baseline is green; extend tsconfig's explicit include list with every converted/shared TS leaf in its PR.
2. **P1, SAMC boundary (4–6h):** new `tools/osd-samc.ts` pure parser, re-export from `osd-amc.mjs`, redirect frontend analysis. Keep absent fields/authority filtering exactly. This is the cheapest cut; add focused parser equivalence coverage and preview proof because the host also consumes it.
3. **P2, scalar folding boundary (8–16h):** new typed folding-only scalar leaf; port NegI, ParseF, ParseI, CFit, S2D, S2T, CToN, IToN plus their private dependencies. Keep `js/abap.mjs`, `js/pcre.mjs` and copied runtime bytes unchanged; differential tests against those functions cover overflow, whitespace, Unicode, negative zero and exceptions. The small deliberate duplication needs parity tests to prevent drift.
4. **P3, six leaf files:** append; diagnostics + literals; source-key + hierarchy; boolx. One semicolon-separated slice per PR, ~2–8h each. Type callbacks against shared contracts; preserve WeakMap key identity and source ordering.
5. **P4, emitter leaves:** packedint before owned; local-constants + builtins; bytes + int8; exception; table-move; sink-locals. Each slice ≤2 files (~2–12h). Share an exhaustive typed child visitor with ownership analysis; preserve its old traversal order and exclusions.
6. **P5, shared SQL:** sqlscript-ir, then sqlscript-lower, then ir-writes, then ir-ranges, then narrow-submit (five PRs, ~3–20h each). These are real generator dependencies and shared Node/preview code: update consumers and run SQL pair/conformance suites as well as gogen proof.
7. **P6, frontend leaves:** analysis; owned; static; builtins; bytes; local-constants (six PRs, ~3–8h each). Finish `.mjs` → `.ts` only after runtime dependencies have moved or been cut; helper interfaces avoid importing frontend values.
8. **P7, cache (three PRs, ~34–56h total):** typed replay accessors/effects first, session snapshots next, object-cache last. Replace Proxy instrumentation with explicit typed reads/writes across frontend; preserve ordered read validation, nested-mutation rejection, fallback, default-off allocation behavior and fresh-process reuse. This is a semantic refactor with a proof gate, not an annotation-only rename.
9. **P8, frontend (6–10 PRs, ~64–112h total):** type loader/options/state first; extract/types/signatures, literals/conversions, expressions/calls, conditions, statements/SQL in successive cohesive slices, then rename the remaining driver. Hoist Unsupported and omitted-constructor contracts into typed leaves to remove the constructor/frontend back-edge; finish `emit-constructors.ts` without a fake callable cast. Do not leave half-typed exported boundaries.
10. **P9, emitter (3–5 PRs, ~24–40h plus symbols):** typed rendering context and type/place routines, expression groups, statement groups, then `.ts` entry and symbols' direct typed call; delete its `as unknown as` shim. Preserve module-state reset, helper registration and deterministic output order.
11. **P10, callers (2–4 PRs, 8–16h, beyond the measured 51):** type `osg-build.mjs` and `osabap.mjs`, then remaining closure/build drivers as separately measured. Preserve public CLI `.mjs` launchers where paths are contracts; wrappers call typed `main()` explicitly. CLI tests, host dispatch and cache invalidation travel with each rename.

Budget: roughly **5–9 engineer-weeks** for the chosen generator work, plus abapiti ABI/adapters and review; re-estimate after P3/P5. P1/P2 and P3/P4 are useful independently. Stop using raw diagnostic-count decline as the acceptance criterion: checker success, byte equality and executed semantics are the gates.

## Proof commands and CI

Existing goldens are semantic: `semantics.mjs`'s EXPECT over `testdata/` (both Go and IR-JS), `test/fixtures/ir-pairs`, unit fixtures and named emitted-source assertions. `frontend-object-cache.test.mjs` explicitly checks cold/warm/fresh-process `emitGo` byte equality; replay/portable tests exercise invalidation and oversized/corrupt data. **There is no complete parent-versus-candidate raw-output golden today.** P0 must add `tools/gogen/typing-proof.mjs` before conversion, covering the semantics corpus, constructor defaults, local constants, layered emission, refusal lists and cold/warm/fresh-process cache paths.
The new driver records raw `emitGo`/`emitJs` strings, stable-build `writeSymbols(..., "typing-proof")` JSON and copied runtime bytes, then compares exact bytes before formatting. Run base and candidate in the same checkout with identical relative fixtures, toolchain, options and environment; capture each PR's parent before editing. Do not normalize generated code, diagnostic order, null/absence, paths or numeric text; only supply the same explicit provenance build to both runs. Cache keys and `symbols.json`'s ordinary HEAD provenance intentionally change with source commits, so cache blob identity is not the output contract.

```sh
# Bootstrap prerequisites: npm ci; node tools/osd-libs.mjs; Go 1.26; pinned libraries.
# NEW P0 interface, unavailable at this documentation commit; record parent, compare candidate:
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/gogen/typing-proof.mjs --record .local/gogen-typing-parent
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/gogen/typing-proof.mjs --compare .local/gogen-typing-parent
npx tsc -p tsconfig.gogen.json
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node --test tools/gogen/emit-large.test.mjs tools/gogen/frontend-owned.test.mjs tools/gogen/frontend-bytes.test.mjs tools/gogen/emit-go.test.mjs tools/gogen/emit-sink-locals.test.mjs tools/gogen/symbols.test.mjs tools/gogen/local-constants.test.mjs tools/gogen/cfit.test.mjs tools/gogen/session-statics.test.mjs tools/gogen/frontend-supplied.test.mjs tools/gogen/sink-locals.test.mjs
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node --test tools/gogen/frontend-cache.test.mjs tools/gogen/frontend-object-cache.test.mjs tools/gogen/frontend-replay.test.mjs tools/gogen/frontend-portable.test.mjs
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/gogen/semantics.mjs
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/gogen/unit.mjs --fixture tools/gogen/testdata --jobs 4
OSD_HEAVY_RANGE=90-99 OSABAP_STRICT_PINS=1 tools/osd-heavy.sh node --test tools/gogen/builtins.test.mjs tools/gogen/lib-pins.test.mjs tools/gogen/osabap-f4.test.mjs tools/gogen/osabap.test.mjs tools/gogen/osabap-sql-corpus.test.mjs tools/gogen/unit.test.mjs
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/osd-suites.mjs --group gogen
node tools/osd-suites.mjs --check
```

Run focused commands during each slice, the applicable gogen commands before its PR, and raw comparison on **both Node 22 and 24**. `.github/workflows/gogen.yml`: `gogen` runs these suites, Go vet/tests/race/wasm checks; its TS step currently has `continue-on-error: true`. `unit-inventory` is advisory and tolerates reported gaps; `osgo-parity` is manual only. `.github/workflows/tests.yml`'s `osgo-host` builds the gateway and tests a real request; the aggregate `test` and leak `scan` remain required. Retain Go gates exactly as written in gogen.yml; never turn a failure into a skip. A TS conversion touches shipped `tools/`, selecting full packaging by `docs/ci-tests.md`; keep the registered suite groups. New `test/*.mjs` suites go in `test/suites.d/*.json`.
For P5 run `OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/sqlscript-conformance.mjs` and `OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh npx mocha test/sqlscript-ir.mjs test/ir-writes.mjs test/ir-ranges.mjs`. For shared host/packaging changes additionally use `OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh npm run e2e:preview`, `OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/osd-suites.mjs --group packaging`, and `bun scripts/build-binary.mjs build/osd-typing` then `build/osd-typing doctor`; retain CI's seeded binary isolation smoke (`bun scripts/build-binary.mjs --seed build/osd-typing-seeded bun-linux-x64-baseline`, then `node scripts/smoke-binary.mjs build/osd-typing-seeded` on Linux with working namespaces). Full OSGo parity, when warranted: build fetched packs/generation, `node tools/gogen/osgo.mjs`, then `node tools/gogen/parity.mjs --fast --out .local/gogen-typing-parity`, through the heavy wrapper.

## Runtime and migration risks

- **Node:** `.nvmrc` selects 24; CI selects 22; `tools/osd-node-version.mjs` accepts 22.14+ and 24 (other newer majors warn). [Node 22 docs](https://nodejs.org/docs/latest-v22.x/api/typescript.html) enable unflagged stripping at **22.18**, while [Node 24](https://nodejs.org/docs/latest-v24.x/api/typescript.html) supports it by default. Existing TS imports already expose the 22.14–17 gap. P0 must choose explicitly: keep supported 22.14 with `--experimental-strip-types` propagated to child processes, or separately approve/document raising the minimum to 22.18; do not silently narrow support. Test minimum 22.14 with the flag, 22.18 unflagged, and 24. Runtime Node ignores tsconfig; use explicit `.ts` specifiers and `import type`, erasable syntax only. TS under `node_modules` cannot be stripped; VSIX ships `osd/tools`, but an npm distribution would need emitted JS.
- **Bun binary:** `scripts/build-binary.mjs` uses [Bun.build compile](https://bun.sh/docs/bundler/executables) on `bin/osd.mjs` (CI Bun 1.4.2), which can parse erasable TS. No global loader change is needed for static typed leaves. Gogen is checkout tooling: `bin/osd.mjs` dispatches `gogen-unit.mjs` via a computed checkout import and `osabap.mjs` via URL; `tools/osgo-unit.mjs` explicitly rejects a compiled host. Do not claim the binary embeds Go or the generator. Preserve `toolCommand`/GENERATOR aliases, no bundled `import.meta.url` path assumptions; smoke actual binaries and Node bundles after shared-host changes.
- **Webpack preview:** worker entry is `web/preview-worker.mjs`. The existing `previewClosure()` audit reaches **94 present source modules and zero gogen files** here (generated/dependency modules absent locally); IgnorePlugin cuts store/build/test paths. Thus gogen-only TS needs no preview TS loader. Shared AMC/SQL/host dependencies do reach preview; P1's shared TS parser takes a narrow webpack loader built on `node:module` `stripTypeScriptTypes` (Node 22.13+), applied only to the typed leaves the preview reaches, with no new dependencies and no generated JS (stoker, 2026-10-14). The SAMC leaf sits outside `tools/gogen/`, so the loader's include list names it explicitly. Adding `.ts` to `resolve.extensions` alone cannot parse TS. Keep webpack and its classic-worker lowering; verify a fresh preview, not a stale bundle.
- **Path consumers:** `tools/osd-run.mjs` spawns `tools/gogen/osabap.mjs` through `toolCommand`; `tools/osgo-unit.mjs` targets `unit.mjs`; `test/osgo-unit.mjs` spawns unit/unit-js; `test/osgo-exc-previous.mjs` constructs both paths. Gogen's own tests/CI invoke osabap, unit, semantics, run, gateway, osgo and other drivers by `.mjs` path. `test/dsl-report.mjs` reads osabap source. Keep CLI shims or migrate every literal/computed path and source assertion atomically; do not rename drivers merely to reduce file counts.
- **Less visible consumers:** frontend uses `require("./frontend-object-cache.mjs")` only with cacheDir: update to `.ts` while preserving synchronous lazy loading and no top-level await. `copy-js-runtime.mjs` copies only `.mjs`; emitted JS expects `abap.mjs`, so P2 leaves runtime files intact. `frontend-cache.mjs` hashes `.mjs`/Go but **omits `.ts`**: fix its file selection in P0, including shared tools; object-cache identity already hashes both. Migrate size-budget path keys with renames, preserving limits. Keep parser/core identity from the transpiler's own `createRequire`; an unchecked require result is not a typed parser boundary.

Validation of this plan: checked all 51 source hashes/counts/import edges, inspected test assertions and workflow commands, ran the repository's preview-closure audit. No generator, compiler, runtime or dependency code changed; no code suites or byte-equivalence runs claimed. Local Node is 26.9.0; the requested 22/24 matrix remains an implementation gate.
