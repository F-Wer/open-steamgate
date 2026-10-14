import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";

const program = () => ({wanted: new Set(["BASE"]), sigs: new Map(), skipped: [], currentClass: undefined});
test("replay checks dependency membership and preserves ordered effects atomically", () => {
  const first = program();
  const cached = recordLowering(first, (p) => {
    p.currentClass = "CALLER";
    p.sigs.set("CALLER=>RUN", {type: "i"});
    assert.equal(p.sigs.get("CALLER=>RUN").type, "i");
    if (!p.wanted.has("DEPENDENCY")) p.skipped.push("dependency absent");
    return {name: "CALLER"};
  });
  assert.ok(cached.replay);
  const next = program();
  next.wanted.add("UNRELATED");
  assert.ok(replayLowering(next, cached.replay));
  assert.deepEqual(next.sigs, first.sigs);
  assert.deepEqual(next.skipped, first.skipped);
  assert.ok(next.wanted.has("UNRELATED"));
  const changed = program();
  changed.wanted.add("DEPENDENCY");
  assert.equal(replayLowering(changed, cached.replay), false);
  assert.equal(changed.sigs.size, 0);
  assert.equal(changed.currentClass, undefined);
  assert.deepEqual(changed.skipped, []);
});

test("nested mutations and previous-class traversal refuse caching", () => {
  const p = program();
  p.sigs.set("BASE=>RUN", {type: "i"});
  assert.equal(recordLowering(p, (p) => { p.sigs.get("BASE=>RUN").type = "int8"; }).replay, undefined);
  p.classes = [];
  assert.equal(recordLowering(p, (p) => p.classes.length).replay, undefined);
});

test("a reused read encoding never hides a nested change", () => {
  const p = program();
  p.sigs.set("BASE=>RUN", {type: "i"});
  // the second read reuses the first encoding; the final check still sees the change
  assert.equal(recordLowering(p, (p) => {
    const sig = p.sigs.get("BASE=>RUN");
    sig.type = "int8";
    return p.sigs.get("BASE=>RUN").type;
  }).replay, undefined);
  // repeated reads of an unchanged input replay, and refuse a changed one
  const cached = recordLowering(program(), (p) => [...p.wanted].length + [...p.wanted].length);
  assert.equal(cached.replay.ops.filter((op) => op.kind === "read").length, 2);
  assert.ok(replayLowering(program(), cached.replay));
  const changed = program();
  changed.wanted.add("OTHER");
  assert.equal(replayLowering(changed, cached.replay), false);
});

test("assigning a collection refuses replay, including a first chained write", () => {
  for (const value of [new Map(), new Set(), new WeakMap(), new WeakSet(), []]) {
    const first = program();
    const cached = recordLowering(first, (p) => {
      const raw = (p.output ??= value);
      if (raw instanceof Map) raw.set("TYPE", 80);
      if (raw instanceof Set) raw.add("TYPE");
      if (Array.isArray(raw)) raw.push("TYPE");
    });
    assert.equal(cached.replay, undefined);
    assert.equal(replayLowering(program(), cached.replay), false);
  }
});

test("frontend program state is initialized eagerly", () => {
  for (const file of readdirSync(import.meta.dirname).filter((f) => /^frontend.*\.mjs$/.test(f))) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"),
      /\b(?:program|PROGRAM)\s*\.\s*\w+\s*\?\?=/, file);
  }
});
