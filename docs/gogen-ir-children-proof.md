# IR traversal proof for #770

Parent: `b9132d5f4c3fca45ea54e62154a4df2811a6967d`, in the unchanged detached
worktree `.local/p4c-parent`. Candidate: `feat/gogen-typing-p4c`. Node 26.9.0,
TypeScript 5.9.3, dependencies from `package-lock.json`, libraries from
`libs.lock.json`. This follow-up changes tests, proof artifacts and CI only.
No traversal gap was found; `ir-children.ts` and the analyses are unchanged.

The compiler-API test creates a TypeScript program over `ir.ts`, resolves
unions/intersections, optional properties, arrays, tuples, maps, indexed
records and nested local objects, and lists every shape's keys and the subset
that can contain tagged IR. The [declared-shape inventory](../tools/gogen/fixtures/ir-children-shapes.json)
contains **216 tagged kinds, 343 object shapes and 794 child-bearing keys**.
Changing a declared key/kind fails the inventory assertion until reviewed.
Each shape is probed with every optional key present and both property insertion
orders. The test verifies key/value identities, entries and all four exclusion
policies, including JavaScript's integer-key enumeration order. A synthetic
contract checks discovery of newly added nested, indexed, optional, mapped and
tuple children.

The corpus proof independently discovers nodes using the parent's unfiltered
`Object.values` walk, including type metadata, declarations, constructors,
signature/stub methods, constants, struct maps, wrappers, arrays and lowered
function-module methods. Maps/Sets are explicitly opened at the compiler
container boundary; neither the old object walker nor `irChildren` flattens
their entries. Parser/registry graphs are outside the IR walk. Each node is
checked against the exact parent policies: table moves exclude nothing,
ownership excludes `type`/`pos`, sinking excludes `type`/`pos`/`token`, and
expression predicates exclude `type`. Entry keys, values, ordering and object
identity must match. Discovery never depends on the candidate traversal.

| Compilation | Nodes compared | Observed kinds | Ownership query rows |
| --- | ---: | ---: | ---: |
| Recursive unit fixture, all 47 owners (445 compiled classes including local test classes and dependencies) | 119,503 | 198 | 1,484 |
| Complete semantics corpus (308 compiled classes) | 96,692 | 197 | 972 |
| Semantics refused 0 | 1,565 | 19 | 647 |
| Semantics refused 1 | 1,709 | 26 | 647 |
| Semantics refused 2 | 1,570 | 18 | 647 |
| Semantics refused 3 | 1,540 | 14 | 647 |
| Semantics refused 4 | 1,521 | 17 | 647 |
| Semantics refused 5 | 1,536 | 18 | 647 |
| Total | **225,636** | **198 distinct** | **6,338** |

Counts deduplicate object identities within each compilation, then sum across
compilations. The [per-kind counts](../tools/gogen/fixtures/ir-children-coverage.json)
record this parent/candidate run; the executable proof reports fresh counts on
every invocation. Of the observed kinds, 197 are declared in `ir.ts` and
`e:float` is the existing runtime extension in `emit-go-types.ts`.

Nineteen declared kinds are covered statically but absent dynamically:
`c:in_range`, `c:true`, `e:row_key`, `e:type_length`, `e:type_kind`, `e:cond`,
`e:random`, `e:nop_call`, `s:note_update_task`, `s:amc`, `s:call_enq`,
`s:kernel_loop`, `s:shift_places`, `s:amc_wait`, `s:get_timestamp`,
`s:select_aggregate`, `s:assign_deref_typed`, `s:dataset_set_position`,
`s:find_bytes_all`.

The same driver runs the product modules resolved from each checkout's working
directory. The parent capture disables candidate traversal checks and uses the
parent frontend-owned implementation. The candidate compares the recorded
query file with `Buffer.equals`: **2,777,297 byte-identical bytes**. Complete
direct `ownershipSafety` rows are serialized in recording order, including
`names`, `dynamic`, providers, policy and query metadata. No sorting,
normalization or inherited-edge expansion is applied. Both nonempty names and
dynamic queries are required in every compilation. Parent payload SHA-256:
`2cd951d22645cfdcd0eefc788be1847410907d92977e1bdaf8d5fcc41c0a4fec`.

Commands used (the parent worktree already has the same installed dependencies
and pinned libraries available):

```sh
cd /work/.local/p4c-parent
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node /work/tools/gogen/ir-children-proof.mjs --record .local/ir-children-parent-all
cd /work
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/gogen/ir-children-proof.mjs --compare .local/p4c-parent/.local/ir-children-parent-all
OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node --test tools/gogen/ir-children.test.mjs tools/gogen/ir-children-completeness.test.mjs
GOGEN_TYPING_SINKS=0,1 OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh node tools/gogen/typing-proof.mjs --compare .local/p4c-parent/.local/p4c-parent-record
npx tsc -p tsconfig.gogen.json
node tools/osd-suites.mjs --check
```

The new suite is included in the existing gogen workflow. All five traversal
tests pass, with no skipped tests. Type checking and suite registration pass.
The existing typing proof passed: 239 byte-identical raw artifacts for each of
sink modes 0/1 and no/cold/warm cache modes against the pre-PR parent record. Keep all
files under `tools/` frozen during that proof: adding the coverage JSON during
an initial run invalidated the warm-cache identity; the final run uses the
completed tree.

Raw parent payloads/coverage remain in
`.local/p4c-parent/.local/ir-children-parent-all`; the final logs are
`.local/p4c-ir-children-parent-all.log`, `.local/p4c-ir-children-final-compare.log`,
`.local/p4c-ir-children-final-tests.log`, and
`.local/p4c-ir-children-typing-proof-final.log`.
