# How to write hot ABAP for this runtime

*Measured 2026-09-17 on one 16-core x86-64 workstation under Node 26, against
the transpiler checkout described in "Which version this is" below. The
companion document [`docs/demo-profile.md`](demo-profile.md) answered where
the demo's time goes — the arithmetic protocol of `@abaplint/runtime`, about
30 ns an operation. This answers the other half: what the **ABAP** can do
about it.*

**This is a measurement, not a proposal to change the demo.** The rewritten
scenes exist to put an **upper bound on what the ABAP side is worth**, so
that the value of fixing the compiler can be compared against the value of
rewriting every program that runs on it. The demo's own ABAP is not being
changed. Several of the rules below are things nobody should have to write,
and the last section is the list of what the transpiler would have to learn
so that the slow spelling costs what the fast one does.

The short version — three costs, one of them invisible in the source:

1. **A character literal as an arithmetic operand costs three to four times a
   float variable.** `'0.5'` is how ABAP spells a non-integer constant, so
   this is idiomatic code, not a quirk.
2. **`LOOP AT` costs 170–350 ns a row before the body runs**, because it is
   transpiled to an async generator; `DO … READ TABLE INDEX sy-index` is 2.3
   to 4.7 times cheaper for the same walk.
3. **A method call costs about 60 ns of protocol before it computes
   anything** — 123 ns against 67 ns for the same arithmetic written in place
   — and one that returns a four-field structure costs 206 ns.

Applying these to the demo's three slowest scenes took **23 to 30 % off the
fastest frame of each**, with **every frame byte-identical**. It did not make
any of them fast: all three are still **2.0 to 3.6 times over** the 24.7 ms
frame budget afterwards.

---

## Which version this is

Every transpiler and runtime citation below is read from the working tree of
the local checkout `/home/alice/dev/transpiler`, branch `local/osd-build` at
commit `0263e428`, which is what `node_modules/@abaplint/{runtime,transpiler}`
is symlinked to and therefore what every number here was measured against.
Its `package.json` says **2.13.86**, but it carries twelve local commits on
top of the published release, several since merged upstream. **Two of them
change facts quoted in the last section**, and both are called out where they
appear:

- `Integer.set` rounds **half away from zero** here (`types/integer.ts:87,97`,
  local commit `0263e428`, upstream #1864). In **published 2.13.86** it is
  plain `Math.round`, so `-0.5` becomes `-0` rather than `-1`.
- `mod` can return a `Float` here (`operators/mod.ts:45`, local commit
  `bd1d258d`). In **published 2.13.86** it never does — float `MOD` rounds
  its remainder to an integer, which is a defect
  (`ANORMALIES.md`, ANOMALY-2026-09-16-mod-result-integer, fixed locally, PR
  open), not a semantic subtlety.

---

## How it was measured

The harness is `.local/hotabap/` and **is not published** — it is a
measurement, and measurements live under `.local/` here like every capture.
That means a stranger cannot re-run the table from this repository; the
method is described in enough detail to rebuild it, and if the harness is
wanted as a tracked fixture it should be moved to `test/` deliberately rather
than left where it is.

A single ABAP class, `ZCL_HOTBENCH`, one static method per idiom; each method
is a `DO iv_n TIMES` loop around one statement and returns a sink so nothing
can be folded away. It is transpiled on its own — no libraries, no database,
one object — so nothing in this tree's build is touched. The harness picks
`n` so a call takes about 200 ms, repeats it fifteen times and keeps **the
minimum**: a repetition can be made slower by something else on the machine
and never faster. `globalThis.gc()` runs between repetitions, because every
ABAP operation allocates a result object.

**One process per case.** The first run put all the cases through one process
and two numbers came out impossible — the inlined arithmetic measured
*slower* than the same arithmetic behind a method call. Every case shares one
`abap.operators.multiply`, so its inline caches see `Float`/`Float`,
`Float`/`Integer`, `Character`/`Float` and `Packed`/`Packed` in whatever order
the cases happen to run, and V8 de-optimises a call site that has seen too
many shapes. So each case now gets a process that has seen only that idiom.
**Real code is polymorphic and pays more than these numbers, not less.**

### What these numbers can and cannot resolve

Three different uncertainties, measured rather than assumed, smallest first.

**Repeating one case: ±6 %.** `z1_control`, `z2_control` and `z3_control` are
`a3_local_f` copied letter for letter; their transpiled JavaScript is
identical apart from the variable numbers. They came in at 42.7, 47.4 and
42.5 ns against the original's 45.4.

**The same case in two different runs: up to 53 %.** Between the two isolated
runs the median case moved 22 % and the worst moved 53 % (`m3_smin_inline`,
257 → 394 ns); `a1_char_literal` and `a2_constant_f` both moved 43 %. **So no
absolute number in the table should be quoted to better than about half a
significant figure.**

**Two different cases that generate the same statement: 1.64×.** Ten cases in
the table compile to `lv_x.set(abap.operators.multiply(lv_x, lv_k))` with two
`f` operands and differ only in which `Float` object is read and what value it
holds. In one run they measured:

| 28.9 | 31.9 | 32.8 | 33.3 | 33.7 | 42.5 | 42.7 | 44.2 | 45.4 | 47.4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| h4 | f4 | f2 | k1 | b3 | z3 | z1 | a6 | a3 | z2 |

The split is not random: the four fastest multiply by a value that keeps the
result an integer or a normal double, and the six slowest drive the value
down through the denormals to zero. **The operand values change the cost of
an identical statement by a factor of 1.6**, which is larger than most of the
differences anybody would want to read out of a table like this.

**The consequence, and the rule used throughout below: compare only within a
lettered group.** Each group was written so that its cases use the same
constants and reach the same value regime, so a ratio inside a group is
controlled. A ratio between groups is not, and the two places where the first
version of this document took one are corrected below. The **ratios inside a
group are far more stable than the absolutes**: across three runs
`a1_char_literal` divided by `a3_local_f` was 3.60, 3.82 and 4.43 while both
absolutes moved by 43 %.

---

## The idiom table

Nanoseconds per loop iteration, minimum of 15 repetitions, one process per
case, the clean isolated run. The empty `DO n TIMES. ENDDO.` is 1.0 ns, so
loop overhead is in none of these numbers in any meaningful amount. Read the
**ratios inside a lettered group**, not the absolutes and not comparisons
across groups.

| case | ns | median | what one iteration is |
| --- | ---: | ---: | --- |
| | | | **A — the operand of one multiply** (all `* 0.500001`-ish, value → 0) |
| a0_empty | 1.0 | 1.1 | `DO n TIMES. ENDDO.` |
| a1_char_literal | **201.1** | 222.6 | `lv_x = lv_x * '0.500001'.` |
| a7_char_const | 197.6 | 252.8 | `lv_x = lv_x * c_char.` — `CONSTANTS … TYPE string` |
| a5_conv_in_loop | 158.4 | 195.5 | `lv_x = lv_x * CONV f( '0.500001' ).` |
| a2_constant_f | 51.8 | 70.0 | `lv_x = lv_x * c_half.` — `CONSTANTS … TYPE f` |
| a3_local_f | **45.4** | 48.7 | `lv_x = lv_x * lv_k.` — `DATA … TYPE f`, set once |
| a6_attribute_f | 44.2 | 54.9 | `lv_x = lv_x * gv_factor.` — `CLASS-DATA … TYPE f` |
| a4_int_literal | 35.0† | 48.7 | `lv_x = lv_x * 1.` — an integer literal |
| | | | **B — divide against multiply by the reciprocal** (all `2.000001`-ish, value → 0) |
| b1_div_char | 81.9 | 91.5 | `lv_x = lv_x / '2.000001'.` |
| b2_div_local | **27.8** | 30.7 | `lv_x = lv_x / lv_k.` |
| b3_mul_recip | 33.7 | 47.3 | `lv_x = lv_x * lv_inv.` |
| | | | **C — inline `DATA( )` against a declared variable** |
| c1_inline | 68.7 | 80.8 | `DATA(lv_t) = lv_x * lv_k.` inside the loop |
| c2_declared | 58.9 | 87.4 | the same with `lv_t` declared above |
| | | | **D — a subexpression written twice or once** |
| d1_twice | 110.3 | 120.0 | `lv_x = ( a * b + c ) * ( a * b + c ).` — five operators |
| d2_once | **70.1** | 93.3 | `lv_t = a * b + c. lv_x = lv_t * lv_t.` — three operators |
| | | | **E — the colour string of a rectangle** |
| e1_template | 85.0 | 99.6 | `lv_s = \|rgb({ r },{ g },{ b })\|.` |
| e2_concatenate | 163.1 | 187.5 | `CONCATENATE` with three `i`→`string` conversions |
| e4_one_field | 34.3 | 35.8 | `lv_s = \|{ lv_r }\|.` |
| e3_palette | 70.7 | 75.6 | `READ TABLE lt_pal INDEX i INTO lv_s.` |
| e5_const_string | **8.1** | 8.7 | `lv_s = '#0a0a12'.` |
| | | | **F — a structure field or a scalar** |
| f1_struct_field | 33.8 | 35.7 | `ls-x = ls-x * lv_k.` |
| f2_scalar | 32.8 | 34.0 | `lv_x = lv_x * lv_k.`, `ls-x` written once after |
| f3_struct_read | 32.0 | 36.7 | `lv_x = lv_x * ls-x.` |
| f4_scalar_read | 31.9 | 34.5 | `lv_x = lv_x * lv_k.` |
| | | | **G — walking an 8-row table, per pass** |
| g1_into | **2790.1** | 3143.1 | `LOOP AT lt INTO ls.` (349 ns a row) |
| g2_assigning | 1372.8 | 1470.1 | `LOOP AT lt ASSIGNING <ls>.` (172 ns a row) |
| g3_reference | 1679.6 | 2070.0 | `LOOP AT lt REFERENCE INTO lr.` (210 ns a row) |
| g4_do_index | **594.9** | 656.9 | `DO. READ TABLE lt INDEX sy-index ASSIGNING <ls>.` (74 ns a row) |
| g5_unrolled | 2636.7 | 2958.7 | `ASSIGNING`, four fields read instead of one |
| | | | **H — integer against float against packed** |
| h1_int_add | 16.6 | 19.6 | `lv_i = lv_i + 7.` (`i`) |
| h2_float_add | 33.1 | 35.7 | `lv_x = lv_x + lv_k.` (`f`) |
| h3_int_mul | 19.1 | 20.6 | `lv_i = lv_i * lv_k.` (`i`) |
| h4_float_mul | 28.9† | 32.7 | `lv_x = lv_x * lv_k.` (`f`) |
| h5_packed_mul | **129.7** | 162.5 | `lv_p = lv_p * lv_k.` (`p LENGTH 8 DECIMALS 4`) |
| | | | **I — powers and the builtins** |
| i1_power_2 | 29.2 | 36.1 | `lv_x = lv_a ** 2.` |
| i2_mul_self | 34.0 | 41.1 | `lv_x = lv_a * lv_a.` |
| i6_power_8 | 43.6 | 48.8 | `lv_x = lv_a ** 8.` |
| i7_mul_8 | 82.6 | 107.9 | three multiplies that make `** 8` |
| i3_sqrt | **10.4** | 12.8 | `lv_x = sqrt( lv_a ).` |
| i4_power_half | 75.1 | 86.8 | `lv_x = lv_a ** '0.5'.` |
| i5_sin | 19.3 | 22.1 | `lv_x = sin( lv_a ).` |
| | | | **J — the cost of a method call** |
| j1_call_static | 122.8 | 145.6 | `lv_x = helper( a b k )`, one multiply inside |
| j2_inlined | **66.5** | 73.8 | the same multiply written in place |
| j3_call_table | 94.5 | 105.8 | a call with a table parameter (8 rows) |
| j4_call_struct | **205.8** | 228.7 | a call returning a four-field structure |
| | | | **K — `DO` against `WHILE`** |
| k1_do | 33.3 | 34.6 | `DO iv_n TIMES.` around one multiply |
| k2_while | 59.8 | 64.5 | `WHILE lv_i < iv_n.` around the same |
| | | | **L — appending a row** |
| l1_append_value | 518.2 | 694.5 | `APPEND VALUE ty_row( … ) TO lt.` |
| l2_append_ref | **336.5** | 405.7 | `APPEND INITIAL LINE … ASSIGNING <ls>.` then four writes |
| | | | **M — the demo's `smooth_min`, three ways** |
| m1_smin_orig | 699.6 | 860.6 | as upstream writes it |
| m2_smin_const | 489.6 | 556.9 | the same with `CONSTANTS TYPE f` |
| m3_smin_inline | **394.2** | 467.6 | the same, inlined into the caller |
| | | | **Z — repeatability: `a3_local_f` copied letter for letter** |
| z1_control | 42.7 | 46.7 | |
| z2_control | 47.4 | 51.9 | |
| z3_control | 42.5 | 47.9 | |

† `a4_int_literal` and `h4_float_mul` multiply by 1, so their values stay
integral and V8 never boxes a heap number. They are understated relative to
the rest of their groups by roughly the 1.64× described above, and no
conclusion below rests on either.

### The two comparisons the first version of this document got wrong

- **Division against multiplication** was quoted as `b2_div_local` (27.8)
  against `h4_float_mul` (28.9) — a cross-group comparison against one of the
  two understated cases, which made it look like a 1.04× wash. Compared
  within a matched value regime it is much clearer: **27.8 against
  `a3_local_f`'s 45.4 is 1.63×, and `b1_div_char`'s 81.9 against
  `a1_char_literal`'s 201.1 is 2.46×.** Division really is the cheaper
  operation here, and the reason is in the source: `divide`'s type dispatch
  is two `instanceof` tests long and `multiply`'s is eight.
- **`** 2` against `x * x`** is 29.2 against 34.0, a 1.16× difference that is
  **inside the noise** and must not be read as "the power operator is
  faster". The direction was the same in all three runs (1.22×, 1.18×,
  1.16×), so the defensible claim is the negative one: *hand-expanding
  `** 2` into a multiplication does not buy anything.* `** 8` against three
  multiplies is 43.6 against 82.6, 1.89×, which is a real difference.

---

## Where a rewrite changes what is computed

Six of the wins are not free, and the table would mislead without this list.

1. **Replacing a character literal by a float constant is safe on this
   runtime and NOT safe on a real kernel.** Measured on A4H the same day
   (`ANORMALIES.md`, ANOMALY-2026-09-17-character-operand-calculation-type):
   a character-like operand makes the calculation type **`P(8,0)`**,
   symmetrically on either side, for `*`, `-`, `+` and `/` alike. So on a
   system `lv_i * '2.5'` is computed in packed with **no decimals**, and
   `'0.5' + '0.5' * ( a - b ) / k` is a different computation from the same
   expression with `CONSTANTS c_half TYPE f VALUE '0.5'`. On this runtime the
   character operand only ever produces a `Float` or an `Integer`, so the
   substitution is exact — which is what the frame comparison below proves,
   and it proves it *here* and not on a kernel.
2. **Replacing an integer literal by a float constant** is the same question
   with a worse answer: an integer-valued literal takes the
   `Character`-and-`Integer` branches of `add`/`multiply` and yields an
   `Integer` whose calculation type governs whether a later `/` is rounded. It
   is only safe where the expression already has a float operand, so that no
   `Integer` result can arise at all. Two such substitutions are in the
   rewrite below and are called out there.
3. **`ASSIGNING` instead of `INTO` is not equivalent when the loop body writes
   the work area.** With `INTO`, writes land in a copy and are thrown away at
   the end of the pass; with `ASSIGNING` they modify the table row. Silent,
   and a data-corrupting change if the original relied on the copy. Safe only
   for a body that reads.
4. **Preferring `i` to `f` changes results.** Every assignment to an `i`
   rounds, so a chain of integer arithmetic accumulates rounding that the
   float version does not have. This is a change of meaning, not a change of
   spelling, and it is the one rule in the list that should never be applied
   to make something faster.
5. **`DO … READ TABLE INDEX sy-index`** sets `sy-subrc` and `sy-tabix`, which
   `LOOP AT` also sets but to different values, and it consumes `sy-index` for
   the row number, so a nested `DO` or any `sy-index` read in the body means
   something else. Safe only in a loop that reads none of the three.
6. **`lv_x * lv_inv` for `lv_x / lv_k`** changes the answer, because `1/k` is
   not exact in binary — and on this runtime it is slower as well, so there is
   no reason to write it. The same applies to any `**`↔`*` swap: `lv_a ** 8`
   and three multiplications give different doubles.

---

## The rules, with their measured cost

Fifteen of them, ordered by what they were worth in the demo. Each says
whether the number is a firm ratio (a controlled within-group comparison well
clear of the uncertainties above) or a soft one.

1. **Never put a character literal in an arithmetic expression that runs more
   than once.** `lv_x * '0.5'` is 201 ns; the same value as
   `CONSTANTS … TYPE f` is 52 ns and as a `DATA … TYPE f` set outside the loop
   is 45 ns — **3.6 to 4.4× across three runs, firm.** `CONV f( '0.5' )`
   *inside* the loop is 158 ns and does not help; `CONSTANTS … TYPE string` is
   198 ns and is the same trap spelled differently. **See caveat 1: this is
   not a safe substitution on a real kernel.**
2. **Walk a table with `ASSIGNING`, not `INTO`** — 172 ns a row against
   349 ns, **2.0×, firm** — because `INTO` copies the work area field by field
   (`types/structure.js` `set` is 5–8 % of a heavy frame in the profile).
   `REFERENCE INTO` is 210 ns, between the two. **See caveat 3.**
3. **In the hottest loop only, replace `LOOP AT` with `DO lines( ) TIMES` plus
   `READ TABLE … INDEX sy-index ASSIGNING`** — 74 ns a row against 172,
   **2.3×, firm**; against `INTO` it is 4.7×. `LOOP AT` is transpiled to
   `for await` over an async generator and every row costs a microtask. **See
   caveat 5**, and do not do this anywhere it has not been measured to matter.
4. **Inline a small method that is called a hundred thousand times a frame.**
   A static call with three float parameters is 123 ns against 67 ns for the
   same arithmetic in place (**1.85×, firm**); a method that returns a
   structure is 206 ns (**3.1×**). The demo's `smooth_min` is 700 ns as
   written and 394 ns inlined with float constants.
5. **Pass scalars, not structures, to a method in a hot path.** The structure
   is built by the caller and copied by the callee; the four-field return
   above is the measurement.
6. **Hoist anything that does not change with the loop variable — across
   method boundaries too.** This is the rule with no row in the table and the
   largest single win in one scene: `torus_3d` called
   `rotate_x( is_p = … iv_a = - lv_rot_x )` inside its ray march, and
   `rotate_x` computes `cos( iv_a )` and `sin( iv_a )` of an angle that is
   constant for the whole frame — on every one of roughly 128 000 march steps.
7. **Compute a repeated subexpression once.** 110 ns for five operators
   against 70 ns for three: **22 ns and 23 ns per operator**, i.e. the cost is
   simply per operation and writing the subexpression twice evaluates it
   twice. There is no extra penalty and no discount.
8. **Do not turn a division into a multiplication by the reciprocal.**
   Division is 28 ns against 45 ns for the multiplication in the matched
   comparison (**1.6×, firm**), and with a character operand 82 against 201
   (**2.5×**), because `divide`'s dispatch chain is two tests and
   `multiply`'s is eight. The reciprocal form measured 34 ns — slower — and it
   changes the answer.
9. **Avoid `p` in a hot loop**: packed is 130 ns against 29 ns for a float
   multiply, **4.5×, firm**, because `Packed` is a `bigint` scaled by
   `10^decimals`. The other half of this rule — *prefer `i` to `f`*, 17 ns
   against 33 ns for an addition — **is a change of meaning and should not be
   applied for speed**; see caveat 4.
10. **The builtins are cheap; the operators are not.** `sqrt( )` is 10 ns and
    `sin( )` is 19 ns, *less than a single multiply*, because a builtin is one
    function call and one allocation with no type dispatch. So **do not
    hand-expand a power** (`** 8` is 44 ns, three multiplies are 83) and **do
    not build a lookup table for a trigonometric function** — the table lookup
    alone is 71 ns, nearly four times what `sin( )` costs. Hand-expanding
    `** 2` is neither better nor worse; see above.
11. **String building is not the problem it looks like.** A three-field
    template is 85 ns, a constant string assignment is 8 ns, and
    `CONCATENATE` with the conversions it needs is 163 ns — twice the
    template. The demo builds one colour string per rectangle, so a thousand
    of them is 85 µs out of a 126 ms frame. Leave it alone.
12. **`DO n TIMES` beats `WHILE i < n`** — 33 ns against 60 ns, **1.8×** —
    because `DO` becomes a plain `for` and `WHILE` pays a `compare.lt` and an
    addition per iteration.
13. **`APPEND INITIAL LINE … ASSIGNING` beats `APPEND VALUE #( … )`** —
    337 ns against 518 ns, 1.54×, which is **soft**: it is barely above what
    this harness resolves between two different cases.
14. **Inline `DATA( )` in a loop costs nothing.** The transpiler hoists the
    declaration out of the loop, and the generated JavaScript for `c1` and
    `c2` is identical apart from the variable numbers — their 69 ns and 59 ns
    are the uncertainty, not a finding. Write whichever reads better. (On a
    real kernel this is *not* a free choice, for a different reason: the
    inferred type of `DATA(x) = lv_i * '2.5'` is `P(8,0)` and the value is 8,
    while an `f` target gets 7.5 — the A4H measurement again.)
15. **A structure field is as fast as a scalar** to read (32 against 32 ns)
    and to write (34 against 33). What costs is copying the *whole* structure
    — as a parameter, a return value, or a `LOOP AT … INTO` work area — not
    touching one field of it.

### Would any of this help on a real ABAP kernel?

**This column is reasoning, not measurement.** One row has been probed on
A4H and says so; the other fourteen are inferences from what the rules are
working around, and none of them has been timed on a real system. They are
here so that nobody carries a runtime artefact into production code believing
it was measured there.

| rule | on a real kernel | basis |
| --- | --- | --- |
| 1 character literals | **no — and it changes the result**: a character operand makes the calculation type `P(8,0)` | **measured on A4H**, ANOMALY-2026-09-17-character-operand-calculation-type |
| 2 `ASSIGNING` over `INTO` | probably yes, smaller — the work-area copy is real work anywhere | reasoning |
| 3 `DO`+`READ TABLE` over `LOOP AT` | no, and it is worse style — this is the async generator | reasoning |
| 4 inlining a method | no, or barely | reasoning |
| 5 scalars over structures | probably yes, smaller | reasoning |
| 6 hoisting loop-invariant work | yes — this is work removed, not protocol avoided | reasoning |
| 7 subexpression once | yes, for the same reason | reasoning |
| 8 do not use the reciprocal | no — on a kernel the reciprocal is the faster one | reasoning |
| 9 avoid `p` | yes — packed is genuinely expensive everywhere | reasoning |
| 9b prefer `i` to `f` | no, and it changes results either way | reasoning |
| 10 builtins cheap, no lookup tables | no — inverted here | reasoning |
| 11 templates over `CONCATENATE` | neutral | reasoning |
| 12 `DO` over `WHILE` | no | reasoning |
| 13 `APPEND … ASSIGNING` | probably yes, smaller | reasoning |
| 14 inline `DATA( )` is free | no — it changes the inferred type, hence the value | **measured on A4H**, same anomaly |
| 15 structure field as fast as a scalar | probably yes | reasoning |

So **five rules of fifteen — 2, 5, 6, 7 and 13 — are expected to carry over**,
plus the `p` half of rule 9, and four of those five are the ones that remove
work rather than avoid protocol. Everything else is this runtime's shape, and
three of them invert the usual advice.

---

## What it is worth on the demo

The three slowest scenes of ZO4D, rewritten with rules 1, 2, 4, 5, 6 and 7
and nothing else — the same arithmetic in the same order, no change to
resolution, iteration count or output — and measured with
`node tools/o4d-profile.mjs`, 60 frames a scene, one tick at a time, in a
detached git worktree so that nothing in the working tree and nothing serving
on 3030 moved.

**The estimator, stated once and used everywhere below: the minimum of 60
frames, compared against the lowest of the three independent baselines of the
unchanged code.** The minimum is used because a frame can be made slower by
something else on the machine and never faster; the lowest baseline is used
because taking the most favourable "before" would flatter the result.

There are three baselines because the unchanged code was measured three
times: twice by this work (nine minutes apart, either side of the rewritten
run) and once, on a different day and generation, by
[`docs/demo-profile.md`](demo-profile.md). **They disagree by 20, 32 and 15 %**
— so the second baseline's 20 % disagreement with the first is the ordinary
noise level of this measurement and not an anomaly of one scene.

| scene | baseline minima (three runs) | best | rewritten | **change, min** | best median | rewritten median | change, median |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sdf_blobs | 118.8 / 140.3 / 142.1 | 118.8 | 88.2 | **−26 %** | 126.3 | 125.5 | −1 % |
| quat_julia | 94.6 / 125.0 / 100.8 | 94.6 | 72.9 | **−23 %** | 99.2 | 81.2 | −18 % |
| torus_3d | 72.3 / 80.7 / 83.0 | 72.3 | 50.4 | **−30 %** | 81.6 | 56.7 | −30 % |

Milliseconds. The first baseline of each is from `demo-profile.md`.

**`torus_3d` is robust and `sdf_blobs` is not.** Torus improves by about 30 %
on every estimator — minimum, median, and median of the last thirty frames —
against every one of the three baselines. `sdf_blobs` improves by 26 % on the
minimum but by **1 %** on the median against the best baseline (it is −37 %
on the minimum and −18 % on the median against *this work's* baselines, which
is why quoting one's own baseline flatters it). Its distribution is wide and
its tail did not move: the rewritten build's slowest frame, 231.5 ms, is
slower than 56 of the 60 frames of this work's first baseline and slower than
**every** frame of the other two. **"N % off every frame" is not what was
measured for any of the three scenes** and was wrong in the first version of
this document.

**None of this makes the scenes fast.** Against the 24.7 ms budget the
rewritten minima are **3.6× over for `sdf_blobs`, 3.0× for `quat_julia` and
2.0× for `torus_3d`**. The ABAP side is worth roughly a quarter to a third of
a frame; it is not worth a playable frame rate.

### The picture is unchanged, over the whole of each scene

The first version of this document compared 60 frames a scene. The comparison
has since been re-run over **each scene's entire window** on the same cached
builds, and the recordings are not merely equal within a tolerance — they are
**byte-identical files**:

```
sdf_blobs    256 frames compared (256 vs 256 recorded): 0 differ   byte-identical
quat_julia   256 frames compared (256 vs 256 recorded): 0 differ   byte-identical
torus_3d     512 frames compared (512 vs 512 recorded): 0 differ   byte-identical
```

Every coordinate and every colour string of between 1 000 and 5 000
primitives a frame — 1 001 for `sdf_blobs`, 4 974 for `quat_julia`, 4 001 for
`torus_3d` — is identical. That is the whole test: a rewrite that changes a
frame changed the maths and does not count.

Two things about those recordings that would mislead anybody reading the
files, because `o4d-record.mjs` records whatever the demo answers and does
not filter by scene the way `o4d-profile.mjs` does:

- The `sdf_blobs` recordings hold **255 frames of the scene and one frame of
  `quat_julia`**: the scene boundary is not exactly at
  `fps * bar_sec * start_bar`, and tick 6144 is still the previous scene.
  (The same off-by-one puts one stray frame in each of the 60-frame
  recordings, which are therefore 59 frames of the scene.)
- The 512-tick `torus_3d` recording runs **past the end of the scene**: it is
  **256 frames of `torus_3d` followed by 256 of `julia_morph`**, because the
  torus window is 256 ticks. So that comparison checks the rewritten scene
  over its whole window *and*, incidentally, checks that an untouched scene
  is still bit-for-bit what it was.

Both sides of every comparison carry the same strays, so none of this weakens
the result — but "512 frames of `torus_3d`" would have been wrong.

### What each scene's rewrite is

- **`sdf_blobs`** — `LOOP AT it_blobs INTO DATA(ls_b)` became `ASSIGNING`
  (the body only reads, so caveat 3 does not apply); `smooth_min` was inlined
  into `scene_sdf`, where it is called once per blob per march step and where
  the profile put 37 % of the frame; **four character literals** became
  `CONSTANTS … TYPE f`, **and two integer literals** (`0` and `1` in
  `IF lv_h < 0`, `IF lv_h > 1` and `1 - lv_h`) became float constants. Those
  last two are the substitution caveat 2 warns about, and they are safe here
  for a stated reason: every one of those expressions already has a `Float`
  operand, so no `Integer` result and no integer calculation type can arise
  either way. The frame comparison is the check on that reasoning, not the
  argument for it.
- **`quat_julia`** — `quat_square` and `quat_mag_sq`, both structure-passing
  methods called in the innermost loop, were inlined onto scalars inside
  `julia_test`; `julia_test` takes three floats instead of a `ty_v3` the
  caller built for each of 13 824 sample points; `rotate( )`'s six
  trigonometric calls were hoisted to once a frame.
- **`torus_3d`** — `rotate_x`/`rotate_y` were inlined at the two call sites in
  the march with their `cos`/`sin` hoisted out of roughly 128 000 steps a
  frame; `torus_sdf` gained a scalar twin so that `calc_normal` stops building
  six structures per lit pixel; **six character literals** became constants.

---

## What the transpiler could do instead

Rules 1, 3, 4, 8, 9b, 10 and 12 are all the programmer working around the
compiler. This is what it would take for the slow spelling to cost what the
fast one does. File and line are from the checkout named at the top.

### Where the decision is made today

`packages/transpiler/src/expressions/arith_operator.ts:8-36` maps the operator
token to a name — `"*"` → `"abap.operators.multiply"` (`:17-18`) — by a string
switch **with no type information at all**.
`packages/transpiler/src/expressions/source.ts:94` wraps it into a prefix
call. The precedence tree is already built by `rearranger.ts`, so by emission
time the expression is a left-to-right binary tree — a good place to hang a
pass.

The traversal **does** have the syntax result:
`handlers/handle_abap.ts:24` constructs it with
`new abaplint.SyntaxLogic(reg, obj).run().spaghetti`, and `traversal.ts`
resolves a scope at any token. It already branches on a proven static type
elsewhere — `statements/loop.ts:52-56` emits `.assign(x.getPointer())` instead
of `.set(x)` when `determineType` says the target is a `DataReference`. What
is missing is a type for a whole `Source` subtree: abaplint core exports no
`getTypeOfSource(node)`, so the transpiler would have to compute one
bottom-up itself (variables, components, attributes, literals, `CONV`/`VALUE`,
method return types) and fall back where it cannot. The assignment target's
type is a two-line change: `traversal.determineType` (`traversal.ts:1026`)
already handles that node shape and `statements/move.ts` never calls it. Note
that `SourceTranspiler.transpile` already carries a `context?: AbstractType`
parameter (`source.ts:43`) and **ignores it for arithmetic**.

There is **no optimiser of any kind** in the transpiler today —
`feature_flags.ts` is empty, and a grep for `optimi|fold|peephole` finds two
`// todo` comments. The runtime, by contrast, already has hand-written fast
paths (`compare/eq.ts`, `operators/_parse.ts`), which is the precedent to
point at.

### The big one: raw JavaScript arithmetic when the types are proven

**Can the transpiler emit `lv_h.set(0.5 + 0.5 * (a - b) / k)` on raw doubles
instead of four calls into the operator protocol?** The measurement says this
is worth more than everything else combined: a statement with five operators
costs 110 ns today and the same expression in plain JavaScript costs about
1 ns.

What it needs, and whether it is there:

| needs | there? |
| --- | --- |
| the declared type of each operand | yes for variables, components and attributes; **no** for a subexpression or a method call — that computation has to be written |
| the declared type of the target | yes, `traversal.determineType`, simply not called from `move.ts` |
| whether a literal is a compile-time constant | yes, trivially |
| whether an expression is loop-invariant | no, and not needed for this |

What would be emitted: for a statement where no operand is character-like,
packed, `decfloat34`, `int8`, hex, date or time, and at least one is `f`,
`target.set(<plain JS expression over .getRaw() values>)`. The `.set()` stays,
and it is correct for **three** target types and not for any: `Integer.set(number)`
and `Integer.set(Float)` go through the same rounding function as each other,
and `Packed.set(number)` and `Packed.set(Float)` both go through
`numberToScaled` (`types/packed.ts`), so `f`, `i` and `p` targets are safe.
(Which rounding function that is depends on the version — `Math.round` in
published 2.13.86, half-away-from-zero on this checkout — but it is the same
one on both sides of the equivalence either way, which is what the argument
needs.)

**A character target is not safe, and an earlier draft of this document said
it was** (corrected 2026-09-17, when the change was implemented and the claim
checked rather than reasoned about). `Character.set(Float)` writes what
`Float.get()` returns, which is exponential notation —
`"5,0000000000000000E+00"` — while `Character.set(number)` writes `value + ""`,
which is `"5"`. Handing a raw number to a character target would silently
change what the program prints. The same risk class applies to `Numc`, `Date`,
`Time` and `Hex`. So the target whitelist is `f`, `i`, `p`, and that is a rule
about `set()` implementations rather than about arithmetic.

What would break, and the answer to each:

- **The calculation type.** `Integer` carries `integerCalculationType`
  (`types/integer.ts`) and `Float` carries it false by default; `divide`
  sets it when both operands are integers, `add` and `multiply` clear it when
  a character operand joins in. It is read by exactly five builtins — `abs`,
  `ceil`, `floor`, `frac`, `trunc` — through `Float.getCalculationValue()`.
  **If at least one operand is statically `f`, no `Integer` result is ever
  produced and the flag is false either way, so the whole rule falls away.**
  That is the narrowing that makes this tractable: not "both operands are `f`"
  but "no operand is character-like, packed, decfloat or int8, and at least
  one is `f`".
- **Division by zero.** `divide` returns `0` for `0 / 0` and throws
  `CX_SY_ZERODIVIDE` otherwise; raw `/` gives `NaN` and `Infinity`. So `/`
  needs a guard — `(r === 0 ? abap.operators.divide(l, r) : l / r)` or a
  two-line helper. Cheap, and it must not be forgotten.
- **`**`.** `operators/power.ts` is `Math.pow(parse(l), parse(r))` for
  everything that is not `int8`, so it folds with no special cases.
- **`MOD` and `DIV`.** `div` floors rather than truncating, and `mod` does
  `((l % r) + r) % r` then an absolute value. **In published 2.13.86 `mod`
  also returns an `Integer` for float operands, which is a defect** — see
  "Which version this is". A fast path must encode the fixed semantics, not
  the shipped ones, so these two should be left out of a first version
  entirely.
- **Integer overflow.** Nothing to reproduce — the check is commented out
  (`types/integer.ts:114-118`).
- **The tests.** `packages/transpiler/test/single_statements.ts` asserts the
  **exact emitted JavaScript** for 243 statements, a dozen of them
  arithmetic; every one would have to be updated deliberately, which is the
  right kind of friction. Behind them sit roughly 2 000 executed tests, about
  200 of them in `test/operators/`.

**Verdict: feasible, and the largest item on the list by a wide margin.** The
work is a bottom-up type computation inside the transpiler plus a
zero-divisor guard; the risk is contained by a narrow admission rule and by
243 exact-string tests that cannot change by accident.

### The cheap one: a numeric literal should not be a `Character`

`'0.5'` is emitted as `abap.CharacterFactory.get(3, '0.5')`
(`expressions/constant.ts:96`), and `operators/_parse.ts` calls `parseFloat`
on it **on every evaluation**, at the bottom of a chain of failed `instanceof`
tests. That is rule 1's 3.6–4.4×, and `sdf_blobs` spends 9.2 % of its
operations there.

Two independent ways:

- **Compiler side.** In an arithmetic context a character literal is always
  numeric, so emit a cached `Float`. Safe **only for a literal containing a
  decimal point**: an integer-valued one takes the `Character`-and-`Integer`
  branches of `add`/`multiply` and yields an `Integer` with the calculation
  type cleared, and turning it into a `Float` would change the inferred type
  of an inline `DATA(x) = '1' * 18`. The plumbing exists — the `context`
  parameter above.
- **Runtime side.** `CharacterFactory` returns a shared `setConstant()`
  object; it could carry the parsed number and have `parse()` read it. No
  compiler change at all. `docs/demo-profile.md` measured this at −22 % on
  `sdf_blobs`.

**Best ratio of gain to risk on the whole list.** Do it in the runtime first,
because it is five lines and needs no type analysis. Note that neither
version makes the transpiler agree with a kernel, which computes the whole
expression in `P(8,0)` — that is a separate and larger question, and it is
ANOMALY-2026-09-17-character-operand-calculation-type and transpiler #1866.

### The one that is nearly free: order the operator chain for floats

`add`, `minus` and `multiply` all begin with
`left instanceof Integer && right instanceof Integer` and reach
`Float`/`Float` only after eight tests, which is why an integer addition is
17 ns and a float addition 33 ns, and why `divide` — whose chain is two tests
— is *cheaper* than `multiply`. A `Float && Float` test as the second branch
changes no semantics and is two lines per operator;
`docs/demo-profile.md` measured 9–17 % off a heavy frame for exactly this.

### Is there room for a real arithmetic optimiser?

Ranked by gain over risk, with the numbers rather than the enthusiasm.

1. **Constant folding of numeric literals** — above. Gain: 3.6–4.4× on the
   operation, about 20 % of an `sdf_blobs` frame by the profile's separate
   measurement. Analysis needed: "is this token a numeric literal with a
   decimal point in an arithmetic context". Almost none. **Do it.**
2. **Typed emission for statically-float expressions** — the big one above.
   Gain: the profile measured 9–17 % for the runtime-side half alone; the
   compiler-side version removes the intermediate allocations too. Analysis
   needed: a bottom-up type for a `Source` subtree. **Do it second; it is a
   project, not a patch.**
3. **A synchronous `LOOP AT` when the body contains no `await`.** Not
   arithmetic, but 74 ns a row against 172 is **2.3× on every table loop in
   every ABAP program**. Analysis needed: prove the body performs no database
   access, no `CALL FUNCTION` and no method call that could be async — which
   for the transpiler means no method call at all, since every generated
   method is `async`. That restricts it to leaf loops over pure arithmetic,
   which is `scene_sdf` and not a great deal else.
4. **Method inlining.** Gain: 123 → 67 ns for the simplest case, 206 → 67 for
   a structure-returning one, and it is the precondition for anything across a
   call boundary. Analysis needed: aliasing of exporting parameters,
   `sy-subrc`, exceptions, recursion, and the fact that every method is
   `async`. **High gain, high risk, no obvious first step.**
5. **Hoisting loop-invariant subexpressions.** Gain in this code: **almost
   nothing.** The demo's per-frame setup is already outside its pixel loops,
   and the one enormous invariant — `cos( - lv_rot_x )` recomputed 128 000
   times a frame — is *behind a method call*, which LICM cannot see without
   item 4. It would also have to prove the subexpression reads no variable
   written in the loop, calls nothing with a side effect, and raises nothing
   that changes control flow: hoisting a division out of a loop that would
   have exited before reaching it turns a correct program into one that throws
   `CX_SY_ZERODIVIDE`. **Not worth it before inlining.**
6. **Precomputed tables for a function over a proven range.** **No, and the
   measurement says so twice.** `sin( )` costs 19 ns and a `READ TABLE …
   INDEX` lookup costs 71 ns, so the table is nearly four times slower than
   the thing it would replace. And no table of doubles is exactly equal to
   `Math.sin` at the sampled points, so it changes what the program computes —
   the one thing the frame comparison exists to forbid. The only exact form is
   memoisation on the exact double, which is the same 71 ns lookup. **Do
   not.**

---

## Reproducing this

The idiom harness lives in `.local/hotabap/` and **is not tracked**, so this
table cannot be re-run from a clone of this repository. That is deliberate
for a capture and wrong for a benchmark somebody may want to defend or
extend; if it is to be kept, it belongs in `test/` as a fixture with the
scene comparison wired to it, and that is a decision rather than an
oversight.

What the harness does is described above in enough detail to rebuild: one
ABAP class of single-statement loops, transpiled alone through
`tools/osd-transpile.mjs` with a config of its own, timed from JavaScript,
one process per case, minimum of fifteen repetitions.

The scene measurement uses only tracked tools — `tools/o4d-profile.mjs` and
`tools/o4d-record.mjs` — against a server started from a **detached git
worktree**, so that neither the working tree nor anything serving on 3030
moves:

```
git worktree add --detach .local/worktrees/hotabap HEAD
# symlink node_modules, .local/lars, .local/tls and packs/*/upstream into it
node tools/osd-build.mjs && STG_SERVE=child STG_PORT=3092 node test/run.mjs
node tools/o4d-profile.mjs http://127.0.0.1:3092 --scene torus_3d --ticks 60
node tools/o4d-record.mjs  http://127.0.0.1:3092 --scene torus_3d --ticks 512 --out …
```

The rewritten classes are an override pack under `.local/`, layered with
`OSD_PACKS` so they win their names over `packs/o4d/upstream` without any
file in this tree or in the demo's own repository being touched.
