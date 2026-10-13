# Transpiler pin move 2

Alice authorized this move on 2026-10-13. The builder worked locally; dell reviewed, re-authored the transpiler branch and pushed both, and rebased the OSG change onto main (the rebased-core gaps landed there as #713).

## Source pins

The fetched OSG base is `origin/fix/rebased-core-gaps` at
`a1f7456d64254021b14735f8b763ddc89953e56f`, still not an ancestor of
`origin/main`. It includes #711 (`7a84b0f8`) and the JSON-key and mixed-byte
fixes in `a1f7456d`. The requested `454bc67c3` was not the fetched tip.

The background's transpiler ref `0263e42892063be5008eab42a5f836bc19385b82`
is the tip of `origin/local/osd-build`. The actual fetched OSG base already
pins the newer integration branch `local/osd-build-2026-10-10` at
`ee5c2cd1a45aaac6be503a46fc903ce95a946877`. Its additional fork fixes were
reviewed and preserved where upstream does not provide them.

| Pin | Before | After |
| --- | --- | --- |
| oisee/transpiler | `ee5c2cd1a45aaac6be503a46fc903ce95a946877` | `6f2119b85b496d537aedb6d33a91392c3f60231f` (`local/osd-build-2`) |
| oisee/open-abap-core | `d5aea88bdb3c8abfe3d57d35b686e933a2bdcfae` | `84125c41c22e4c0d45e8037e8b60c691bb64de8d` (`osd/core-rebase-2026-10-10`) |
| Parser: OSG CLI/core and transpiler root/library/CLI | OSG and actual linked old build: `2.120.59` | exact `2.120.73` |

The transpiler branch starts from upstream main
`c8a493c30d8fd65704c8415650f9e529d5fc3bc8`, version 2.14.3. Both transpiler and
runtime move together through the lock and package links. Workflow env vars
come from `libs.lock.json` via `tools/osd-lock.mjs`; there are no independent
workflow SHA copies to change.

The three source pin sets were reviewed together. Pack content needs no
change for this compiler/core move; its manifests retain these verified refs:

| Pack source | Retained commit |
| --- | --- |
| o4d/upstream: oisee/vivid-vibes | `9f45fe0b00c537643ff49c5ddf86838a42e130a0` |
| zork/upstream and zork/games: oisee/zork-abap | `0c8d96b908f88fc3207e7f9a00bc43f724b32b6f` |
| gui-examples/upstream: oisee/open-abap-gui | `b65c4431d71c7b23468d08bd955b18785fd2ca6c` |

`osd-fetch` verifies all four fetched source folders. `osd-libs --check`
verifies all seven library refs. Historical benchmark and anomaly refs remain
historical; the active documentation now points to the new integration pin.

## Fork history

Rebased the own commits of `origin/local/osd-build`, resolving against current
upstream behavior rather than restoring obsolete code.

| Original commit | Disposition |
| --- | --- |
| `1b91a1ad` four fixes | Partially retained as `c965b2b7`: builtin/type fallback and builtin tests. Upstream already has arithmetic rearranging and escaped imports. |
| `29a86367` binary copy | Dropped: upstream `39af3f1c`, #1845. |
| `058df744` LOOP restores tabix | Dropped: upstream `7d259222`, #1848. |
| `34979b67` W3MI object name | Dropped: upstream `8a0df788`, #1846. |
| `8f53f996` float readback | Automatically dropped as patch-equivalent: upstream `9d9e5953`, #1847. |
| `cd135f31` builtin argument names | Retained as `5612be55`. |
| `c5a2290f` hashed tabix | Dropped: upstream `7d259222`, #1848. |
| `88ab8539` char literal versus float | Automatically dropped as patch-equivalent: upstream `f142fefa`, #1862. |
| `c148d363` parser 2.120.54 | Dropped as obsolete; final parser is 2.120.73. |
| `10ecbe14` APPEND float fraction | Automatically dropped as patch-equivalent: upstream `71a75787`, #1867. |
| `bd1d258d` float MOD | Dropped: upstream `148cee5f`, #1863, with newer MOD changes retained. |
| `0263e428` negative-half rounding | Dropped: upstream `9e09f25b`, #1864. |

The actual OSG pin's later fork commits were also audited:

| Old commit | New commit or upstream disposition |
| --- | --- |
| `c453886c`, `085ab4a9` builtin fixes | Already retained above as `c965b2b7`, `5612be55`; no second copy. |
| `ddb0a993` DATASET host | Upstream `a696c609`, #1936; retained upstream's newer dataset implementation. |
| `ac372675`, `e97e82c7`, `e34d6a1f` FAE batching/trimming/order | Upstream `1181ca6e`, #1944, including hashed surplus trimming and ordering guards. |
| `32666ade` only option | `65768721` |
| `60c1dd75` registry reuse | `c8c5bb4d` |
| `4360eff5` exact packed arithmetic | `f82d1434`; merged with upstream int8 calculation and Date/Time/field-symbol conversions. |
| `f3611417` int8/integer byte conversions | `03747e00` |
| `2ff0e80` monotonic GET RUN TIME | Upstream `2fae9326`, #1956. |
| `e2a459b1` initial IS INSTANCE OF | Upstream `1d7d38b5`, #1975, plus newer interface support. |
| `cb210b60` integer overflow | `99343d6a`; preserve upstream conversion-clearing behavior and type dispatch. |
| `41f5c919` position overflow/template tests | `371c4d4b` |
| `f9eb5fb4` LOOP TO 0 and overflow tests | `1a4248af` |
| `753230cb` unmeasured case labels | `403020c8` |
| `ee5c2cd1` GET RUN TIME wrap | Upstream `f039f1d9`, #1990. |

Final adaptation commit `6f2119b8` pins the parser, removes references to the
upstream-removed plugin API in the only/reuse patches, restores Date-to-integer
dispatch, and updates an explicitly unmeasured packed quotient test.

OSG's CI builder now compiles runtime/transpiler/CLI: upstream removed the
extras package. It checks parser requirements before installing and checks
resolved parser versions on cache hits too. The external `RESULT2.md` was not
available; this check was implemented from the repository manifests and tested
with a deliberately mismatched cached parser.

## Verification

Commands used the repository's heavy-run wrapper for OSG transpile, ABAP Unit,
mocha and semantics. Local runtime: Node 26.9.0; CI uses Node 22, which was not
separately exercised. Targeted checks follow `tests.yml` and `gogen.yml`; the
entire optional integration/browser matrix was not run.

| Check | Before | After |
| --- | --- | --- |
| OSG transpile | Pass, 2,344 objects | Pass, 2,375 objects; final generation `126af3ad14386392` |
| OSG ABAP Unit | 803 methods, 96 classes, zero failures | 803 methods, 96 classes, zero failures on the final config |
| OSG semantics | 406 checks, zero FAIL, exit 0 | 406 checks, zero FAIL, exit 0 |
| OSG lint | Before core-library move, parser already upgraded: 79 warnings, no errors | 79 warnings, no errors after removing duplicate PROGNAME |
| Targeted mocha: pin, fetch, wire, OSGo unit | Not run on old pin | 61 passed, zero failures on stable inputs |
| gogen unit fixture | Not run on old pin | 42/42 classes compiled, 127 SUCCESS, no other statuses |
| Go runtime unit packages from gogen CI | Not run on old pin | Pass |
| gogen frontend/emitter CI tests | Not run on old pin | 79 passed, zero failed |
| Transpiler compile and own lint | Not run on old pin | Both pass |
| Transpiler complete `npm test` | Not run on old pin | 2,995 passed, 29 pending, 142 failed; every failure is a PostgreSQL connection failure |
| Transpiler tests excluding PostgreSQL suite | Not run on old pin | 2,991 passed, 27 pending, zero failures |
| Clean CI-style transpiler build and gate | Not run on old pin | Pass; installed and compiled from a clean clone, matching parser versions |
| Library/pack verification | Pass | Pass |

The complete transpiler test command exited 142. Docker and PostgreSQL are not
installed, so all 142 cases in `Top level tests, Database` that request a
PostgreSQL connection fail in `pg-pool`. They remain enabled; no test was
skipped in the full command. SQLite coverage runs in the passing local tests.
The green local test command explicitly excluded that PostgreSQL suite; it
is not a claim that the complete upstream CI matrix passed.

Regressions and corrections encountered:

- OSG lint: rebased core adds `PROGNAME`, also selected from abapGit deps.
  Removed that redundant abapGit selection from both lint and transpile
  configs. Core supplies the type; duplicate detection remains enabled.
- Transpiler compile: upstream removed its plugin API, so replayed only/reuse
  guards referenced nonexistent fields. Adapted the guards to the new API.
- Transpiler Date tests: the overflow patch missed upstream Date dispatch.
  Restored it; all three failing Date cases now pass.
- Packed int8 quotient: exact packed calculation now gives 3.5 for 7 / 2 into
  `p DECIMALS 1`, where an upstream UNMEASURED snapshot expected 3. Updated
  the snapshot to 3.5, preserving the UNMEASURED label. No new SAP reference
  measurement is claimed.
- An initial OSGo mocha run's source-preservation hook detected the config
  edit made during that run. This was a concurrent-edit artifact, not an
  emitter failure; rerun with stable inputs is recorded above.

No remaining OSG behavior regression was observed in the completed targeted
checks. Expected refusal/NOT_COMPILED results in semantics retain their
existing expectations, including the JS native Go-host conversion path.

## Absolute regex anchors

The tiny probe was transpiled and executed through both the actual old pin
(parser 2.120.59) and the new pin (parser 2.120.73). Its essential ABAP is:

```abap
REPORT zregex_probe.
DATA rc TYPE i.
FIND PCRE '\Aabc\z' IN 'abc'.
rc = sy-subrc.
WRITE / rc.
FIND PCRE '\Aabc\z' IN 'Aabcz'.
rc = sy-subrc.
WRITE / rc.
FIND PCRE '\Aabc\z' IN 'xabc'.
rc = sy-subrc.
WRITE / rc.
FIND PCRE '\Aabc\z' IN 'abcx'.
rc = sy-subrc.
WRITE / rc.
```

| Input | Expected sy-subrc | Old pin | New pin |
| --- | --- | --- | --- |
| `abc` | 0 | 4 | 4 |
| `Aabcz` | 4 | 0 | 0 |
| `xabc` | 4 | 4 | 4 |
| `abcx` | 4 | 4 | 4 |

Both compilers preserve the backslashes in generated JS. The runtime's PCRE
path treats them as JS identity escapes, effectively literal A and z. The pin
move does **not** fix these anchors; abapiti's withdrawal remains justified.
This is an existing limitation, separate from the AST/core migration.

## Remaining handoff

The transpiler PostgreSQL suite still needs its CI service. Node 22 and the
full browser/optional integration matrix remain unverified locally. Absolute
PCRE anchors remain unsupported. No observed targeted OSG failure remains in the final stable-input reruns.

Dell must review and push `local/osd-build-2` to oisee/transpiler before the OSG
branch can build on GitHub: its locked SHA is currently local-only. Then push
`fix/transpiler-pin-2` for one OSG PR containing the core, parser, transpiler,
JSON expectation, and verified pack pin set. No push or PR creation was
attempted here.

The transpiler branch was re-authored to "Alice V." before publishing (same tree); the pin is its new tip `6f2119b8`.
