# Where the demo's time goes

*Backlog E.7, measured 2026-09-17. A 16-core x86-64 workstation, Node 26,
the transpiled tree of generation `2c602ef3`, SQLite file client. Nothing
in `src/`, `packs/` or `webapp/` was changed to take these numbers; the
recordings and profiles are captures and stay under `.local/`.*

*Which runtime, exactly, because the ranked list below is an argument about
it: `local/osd-build` at `0263e428`, which is `abaplint/transpiler` main at
`71a75787` plus one unmerged local fix (#1860, `operators/mod.ts`), and
without three commits merged after this build was taken (`create_data`,
`create_object`, the two `contains_any_of` builtins). Every file on the
arithmetic hot path — the four operators, `_parse`, `Float`, `Integer`,
`Character`, `Structure`, `loop` — is byte-identical to main, checked with
`git diff`, which is what makes the numbers a statement about main.*

The demo is the only workload this tree has that is pure ABAP arithmetic in
a loop: ZO4D draws itself, one frame per tick, and the page waits for each
frame. So it answers two questions nobody had asked with numbers — which
scenes cannot answer inside a tick, and what the process is doing while it
fails to.

The short version. **The time is not in the channel, the JSON, the database
or the proxy; it is in the arithmetic protocol of `@abaplint/runtime`.** One
frame of `sdf_blobs` performs **1.97 million** ABAP arithmetic operations.
Each one costs about 30 ns — an `instanceof` chain that fails eight times, two
calls to `parse`, and a fresh `Float` — where the same expression in plain
JavaScript costs about 1 ns. The runtime is 51–69 % of the busy time of a
heavy frame, the demo's own generated code is 18–26 %, the garbage collector
6–10 %, and everything else together is under 7 %.

## How it was measured

`tools/o4d-profile.mjs` opens the demo's push channel
(`/sap/bc/apc/sap/zo4d_demo`), asks for **one** tick, waits for the frame,
and asks for the next: the wall clock between the two is one frame's work
with nothing queued behind it. The clock is read before the frame is parsed,
because parsing ten thousand rectangles is the tool's work and not the
server's. Each frame says how much it drew (`rc` rectangles, `lc` lines,
`tric` triangles, `cc` circles, `ic` images, `tc` texts), so the table carries
both the raw milliseconds and the milliseconds per thousand primitives.

Which scene a tick belongs to is the demo's answer, not the tool's: the first
tick of `fps * bar_sec * start_bar` is sometimes still the scene before (tick
6144 is `quat_julia` although `sdf_blobs` starts at bar 96), so a frame from
another scene is asked again one tick later rather than counted.

```
node tools/o4d-profile.mjs http://127.0.0.1:3090 --ticks 60 --json .local/try/profile.json
node tools/o4d-profile.mjs --scene sdf_blobs --ticks 200 --same     # the warm-up question
```

The demo runs at 40.53 fps, so **the budget is 24.7 ms a frame**.

## Scene by scene, 60 frames each

| scene | median ms | min | p95 | max | fps | primitives | ms per 1000 | frame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sdf_blobs | 126.3 | 118.8 | 153.9 | 168.4 | 7.9 | 1001 | 126.2 | 48 KB |
| quat_julia | 99.2 | 94.6 | 112.0 | 137.5 | 10.1 | 4974 | 19.9 | 427 KB |
| torus_3d | 81.6 | 72.3 | 113.9 | 129.9 | 12.3 | 4001 | 20.4 | 191 KB |
| sierpinski | 75.9 | 61.1 | 108.2 | 122.7 | 13.2 | 4801 | 15.8 | 804 KB |
| julia_morph | 57.7 | 53.0 | 87.2 | 99.5 | 17.3 | 10242 | 5.6 | 781 KB |
| rotozoom | 52.5 | 43.8 | 83.1 | 87.5 | 19.1 | 7170 | 7.3 | 305 KB |
| rotozoom_plasma | 37.8 | 32.4 | 52.7 | 74.4 | 26.5 | 4001 | 9.4 | 170 KB |
| voxel_landscape | 13.5 | 9.9 | 19.9 | 22.5 | 73.8 | 935 | 14.5 | 104 KB |
| neon_city | 7.8 | 6.1 | 10.8 | 12.5 | 128.4 | 520 | 15.0 | 58 KB |
| cell120 | 6.2 | 4.2 | 9.3 | 26.8 | 162.3 | 642 | 9.6 | 84 KB |
| plasma | 5.7 | 4.6 | 8.0 | 11.2 | 175.5 | 642 | 8.9 | 34 KB |
| sierpinski_tet | 5.2 | 4.4 | 7.7 | 9.2 | 191.0 | 258 | 20.3 | 46 KB |
| twistzoomer | 3.9 | 3.2 | 6.2 | 7.3 | 253.8 | 338 | 11.7 | 41 KB |
| amiga_ball | 3.5 | 2.7 | 9.9 | 13.0 | 288.0 | 295 | 11.8 | 35 KB |
| amiga_ball_2 | 3.5 | 2.7 | 6.2 | 8.0 | 288.9 | 279 | 12.4 | 32 KB |
| copperbars | 3.2 | 2.4 | 4.0 | 6.4 | 310.3 | 386 | 8.3 | 21 KB |
| ignition | 2.2 | 1.8 | 5.0 | 7.2 | 453.1 | 100 | 22.1 | 8 KB |
| mountains_oops | 1.9 | 1.4 | 4.0 | 4.1 | 521.6 | 283 | 6.8 | 22 KB |
| constellation | 1.9 | 1.2 | 4.5 | 5.3 | 523.0 | 160 | 12.0 | 19 KB |
| ignite_emit | 1.7 | 1.4 | 2.7 | 3.2 | 605.4 | 82 | 20.1 | 7 KB |
| joydivision | 1.5 | 0.7 | 4.3 | 8.6 | 662.1 | 167 | 9.0 | 19 KB |
| cell24 | 1.5 | 1.2 | 3.4 | 5.5 | 676.4 | 98 | 15.1 | 12 KB |
| glitch | 1.4 | 0.9 | 3.5 | 3.8 | 710.9 | 157 | 9.0 | 8 KB |
| tesseract | 1.2 | 1.0 | 2.7 | 5.6 | 842.9 | 49 | 24.2 | 6 KB |
| Sales Dance | 1.0 | 0.8 | 1.7 | 4.9 | 986.8 | 5 | 202.7 | 1 KB |
| cell16 | 0.8 | 0.7 | 1.7 | 3.4 | 1214.8 | 22 | 37.4 | 2 KB |

**Seven of twenty-six scenes miss the frame budget**, and nineteen are inside
it with room to spare — the median scene answers in under 4 ms, which is
7 % of a tick.

The two columns say different things, which is the point of having both.
`julia_morph` draws **ten thousand** rectangles in 57.7 ms — 5.6 ms per
thousand, the cheapest per primitive in the table — and is slow because it
draws a lot. `sdf_blobs` draws **one thousand** in 126.3 ms — 126 ms per
thousand, twenty-two times more expensive per primitive — and is slow because
every one of those thousand pixels is a ray march. The frame it sends is
48 KB against `sierpinski`'s 804 KB, and it takes 1.7 times as long. Nothing
about a slow scene is visible in what it puts on the wire.

## What the process is doing

A CPU profile of the process that runs the ABAP (`tools/osd-serve.mjs`,
started under `--cpu-prof` and quiesced cleanly so the profile is written),
one profile per scene, 60 frames each, sampling window starting at the first
rendered frame so the boot is not counted:

| | sdf_blobs | quat_julia | torus_3d |
| --- | ---: | ---: | ---: |
| `@abaplint/runtime` | **69.1 %** | **63.1 %** | **59.0 %** |
| the demo's own generated ABAP | 20.0 % | 20.4 % | 25.7 % |
| garbage collector | 5.8 % | 10.3 % | 8.6 % |
| native (JSON, string, Math, V8) | 4.9 % | 5.8 % | 6.1 % |
| node builtins | 0.2 % | 0.2 % | 0.4 % |
| the database | 0.07 % | 0.09 % | 0.09 % |
| the push channel (`tools/osd-apc.mjs`) | 0.03 % | 0.04 % | 0.08 % |
| express | — | 0.05 % | 0.02 % |

### The top five hot spots, with their origin

| self time | where | what it is |
| ---: | --- | --- |
| 8–13 % | `parse` — **runtime** `operators/_parse.js:6` | every arithmetic operator calls it once per operand. For a `Float` it is a type test and a field read; for a **character literal** it falls to the bottom of its own `instanceof` chain, reads the string out and calls `parseFloat` — on every single operation |
| 7–11 % | `multiply` — **runtime** `operators/multiply.js:7` | eight failing `instanceof` tests, then `new Float().set(parse(l) * parse(r))` |
| 5–8 % | `set` — **runtime** `types/structure.js:100` | a structure assignment: `Object.keys` on both sides, then field by field, with a `clone()` for every nested table or structure |
| 5–7 % | `set` — **runtime** `types/float.js:61` | the write half of every operator result and every `DATA(x) = …` |
| 4–13 % | `#scene_sdf` — **demo** `zcl_o4d_sdf_blobs.clas.mjs:113`, `#julia_test` `zcl_o4d_quat_julia.clas.mjs:191`, `zif_o4d_effect$render_frame` `zcl_o4d_torus_3d.clas.mjs:430` | the generated bodies themselves: the per-call parameter type checks and the work area a `LOOP` allocates fresh on every call |

Then `add` (5–8 %), the garbage collector (6–10 %), `minus` (4–9 %), and — on
`sdf_blobs` only — `loop` (`statements/loop.js`, 4.5 %) together with
`runMicrotasks` (4.5 %), because `LOOP AT` is an **async generator** and every
row costs a microtask. `scene_sdf` loops over seven blobs per march step.

Inclusive time inside the demo's own ABAP, which names the ABAP rather than
the JavaScript:

- `sdf_blobs`: `scene_sdf` 74.9 %, of which `smooth_min` 36.9 %; `render_frame` 8.6 %.
- `quat_julia`: `julia_test` 52.7 %, `render_frame` 29.7 %, `quat_square` 20.8 %, `quat_mag_sq` 8.4 %.
- `torus_3d`: `render_frame` 70.6 %, `rotate_y` 10.7 %, `rotate_x` 9.4 %, `torus_sdf` 7.7 %.

Building the frame's JSON in ABAP (`zcl_o4d_apc_handler=>frame_to_json` plus
`send_frame`) is 1.3 % on `sdf_blobs`, 5.4 % on `quat_julia` and 6.1 % on
`torus_3d` — it scales with the frame, as it should, and it is never the
problem.

### How many operations a frame is

Counted by wrapping the four arithmetic operators and rendering one frame of
each effect in-process (the counts and the render times match what the server
answers):

| | operations per frame | `Float`/`Float` | with a character operand |
| --- | ---: | ---: | ---: |
| sdf_blobs | 1 967 748 | 76 % | **9.2 %** |
| quat_julia | 1 662 319 | 85 % | 0.0 % |
| torus_3d | 838 193 | 75 % | 0.3 % |

Measured cost of the individual operations, three million each:

| operation | ns |
| --- | ---: |
| `multiply(Float, Float)` | 31 |
| `add(Float, Float)` | 28 |
| `minus(Float, Float)` | 26 |
| `add(Integer, Integer)` | 15 |
| **`multiply(Character '0.5', Float)`** | **92** |
| **`add(Character '0.5', Float)`** | **103** |
| `Float.set(number)` | 3 |
| `compare.gt(Float, Float)` | 17 |
| the body of `smooth_min`, nine operators | 533 |
| the body of `smooth_min`, plain JavaScript | ~1 |

Two million operations at 30 ns is 60 ms, which is half of a `sdf_blobs`
frame; the profile's 69 % for the runtime says the same thing from the other
side. **A character literal operand costs three times a float one**, and
`'0.5'` is how ABAP writes a float constant — this is idiomatic code, not a
demo quirk.

### What a fix would be worth, measured

Two prospective fixes were put in front of the real operators and the same
frame rendered again, so these are measurements and not estimates:

| change | sdf_blobs | quat_julia | torus_3d |
| --- | ---: | ---: | ---: |
| a `Float`/`Float` fast path in `add`/`minus`/`multiply`/`divide` | −9…−12 % | −17 % | −13…−15 % |
| plus a cached numeric value for constant `Character`s | **−31 %** total | (no character operands) | (no character operands) |

The fast path is two `instanceof` tests in front of the existing chain:
`if (left instanceof Float && right instanceof Float) return new
Float().set(left.getRaw() * right.getRaw())`. It changes no semantics — it is
exactly what the fall-through already computes — and it removes eight failing
type tests and two `parse` calls from the most common operation in the
language. A wrapper pays for an extra closure call that a real patch would
not, so these are lower bounds.

## The warm-up question

Asked as 200 frames of one tick — the same question two hundred times, so the
answer is about the process and not about the scene, which draws differently
at the end of a bar than at the start — on a process that had served nothing
before:

| | frame 1 | 2–5 | 6–20 | 21–50 | 51–100 | 101–200 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| quat_julia | 168.1 | 124.6 | 108.7 | 107.3 | 102.8 | 97.8 |
| sdf_blobs | 213.2 | 135.7 | 118.6 | 139.1 | 118.3 | 111.9 |

**The first frame of a scene costs 1.7 to 1.9 times the steady one — about
+70 to +100 ms, once.** By the sixth frame the process is within 10 % of
where it ends up, and the last 10 % arrives slowly over the next two hundred
frames, which is V8 tiering and not anything a warm-up can hurry.

So a warm-up pass — asking a scene for a few frames before it is shown —
buys one thing: it removes a visible 70–100 ms hitch at every scene change.
It does not buy frame rate. Five frames is enough; two hundred is not better
than five in any way that matters. Whether it is worth doing depends on
whether the hitch is visible, and at a scene change on a beat, it is.

## The seam, the pool and the proxy

The demo's socket is proxied by the façade to the work process. Measured
through the façade against the same frames asked directly of the work
process: `sdf_blobs` 126.3 against 120.3 ms, `quat_julia` 99.2 against 100.6,
`torus_3d` 81.6 against 75.4, `julia_morph` 57.7 against 55.3, `plasma` 5.7
against 5.0. **The proxy costs 0 to 6 ms a frame, 1–5 %, roughly with the
payload** — worth knowing, not worth removing.

More work processes cannot help a slow scene: a push channel is pinned to one
runtime for the life of the socket by design (`tools/osd-pool.mjs`), because
the handler holds the demo it loaded. Splitting one frame across processes
would need the effect to be splittable, which it is not.

One real defect found on the way. `tools/osd-runtime.mjs` accumulates
**every byte** the work process ever writes to stdout or stderr into a single
string, and only ever reads the last 2000 of it:

```js
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); });
```

The demo's handler writes one line per frame, so a façade that serves the
demo grows by about 2.5 KB a second and never gives it back. It costs no
frame time; it costs memory for as long as the process lives.

## Ranked, with where the change lives

1. **A `Float`/`Float` branch in three of the four arithmetic operators.**
   Upstream, `@abaplint/runtime`, `src/operators/{add,minus,multiply}.ts`.
   Measured 9–17 % off every heavy frame, and it touches every ABAP program
   that computes with floats, not only this demo. **This is the one to do
   first**, and it is an issue and a PR, not a local patch.

   Written and measured on 2026-09-17, and it came out smaller than this
   entry asked for. Two lines at the *head* of all four operators is what
   this said; the branch that exists is seven lines **after** the
   Integer/Integer case in three of them, because at the head the two type
   tests cost integer arithmetic 12–24 % and integer division 60 %
   (10.4 → 16.4 ns, repeatably), which a change that speeds up floats has no
   business doing. `divide` is left alone for the same reason. See branch
   `perf/float-fast-path` and its draft in `.local/measure/drafts/pr-1.md`;
   the issue puts both placements in front of Lars, whose weighting of
   integer division is not ours to assume.
2. **A constant `Character` should remember the number it parses to.**
   Upstream, `@abaplint/runtime`, `src/operators/_parse.ts` with
   `src/types/character.ts` (`setConstant`) or a `WeakMap` beside
   `CharacterFactory`. Measured a further 22 % on `sdf_blobs` — 31 % with the
   fast path — and nothing at all on scenes that use no decimal literals.
   Since `'0.5'` is how ABAP spells a float constant, the scenes that see
   nothing are the unusual ones.
3. **Stop the façade from keeping the child's whole log.** Ours,
   `tools/osd-runtime.mjs`, the two `out +=` handlers in `#spawn`: keep the
   last few KB. No frame time, bounded memory, five lines.
4. **`LOOP AT` as an async generator.** Upstream, runtime
   `src/statements/loop.ts` plus the transpiler that emits `for await`. Worth
   4–9 % on loop-heavy scenes (`loop` 4.5 % plus `runMicrotasks` 4.5 % on
   `sdf_blobs`), and nothing where the loops are shallow. A synchronous loop
   when the body contains no `await` is a real design change with a real
   regression surface; it is the right thing eventually and the wrong thing
   to start with.
5. **The CJS barrels.** Upstream, runtime: `operators/*` and `compare/*`
   reach their types through `types/index.js`, whose re-exports are
   accessors, so every `instanceof` pays for a getter — 1.1–1.6 % of busy
   time in `get@types/index.js:6` and `get@compare/index.js:6`. Importing the
   concrete modules instead removes it. Small, cheap, uncontroversial.
6. **A five-frame warm-up before a scene is shown.** Ours, but it lives in
   the demo's handler or its page, which are a pack's and not this tree's.
   Removes a 70–100 ms hitch per scene change; buys no frame rate.
7. **Structure assignment and the per-call work area.** Upstream, runtime
   `types/structure.ts` `set`/`clone`, and the transpiler, which allocates a
   `LOOP` work area and re-checks every parameter's type on every call to a
   method — visible as the 4–13 % self time inside the demo's own generated
   bodies. Worth something; needs a design before it is worth an issue.

### Not worth it

- **A "fast math" library, or a different numeric representation.** The
  evidence says the time is not in the math. `Math.sin`, `Math.cos` and
  `Math.sqrt` together are 0.7–1.6 % of a frame, and the actual floating
  point multiply inside a 31 ns operator call is about 1 ns of it. What costs
  30 ns is the **protocol** around the operation — dispatch on the operand
  types, parse each operand, allocate the result. A decimal or fixed-point
  library would add to that, not remove it.
- **The channel, the JSON and the wire.** `tools/osd-apc.mjs` is 0.03–0.08 %
  of a frame, express is 0.02–0.05 %, and the client's own `JSON.parse` of an
  800 KB frame is 1.8 ms. Building the JSON in ABAP is 1–6 % and scales with
  the frame.
- **The database.** 0.07–0.09 % while frames are being served; the SQLite work
  in the profile is the boot seeding, not the demo.
- **More work processes for one demo.** A socket is one session and one
  runtime by design.
- **Lowering the ray-march resolution.** It would work — `sdf_blobs` at
  `iv_resolution = 40` is the slowest scene by a wide margin — but that is a
  change to the demo, which is a pack of its own, and it hides the finding
  instead of fixing it.
