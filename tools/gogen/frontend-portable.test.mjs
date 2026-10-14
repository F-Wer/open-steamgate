import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {portable, compactLowering, objectCache, compileDiskClass} from "./frontend-object-cache.mjs";
import {recordLowering} from "./frontend-replay.mjs";

const budget = 1 << 20;

test("portable retains primitive, prototype, Map-key and cyclic/shared verdicts", () => {
  const cycle = {}; cycle.self = cycle;
  const shared = {value: new Set([cycle])};
  for (const value of [null, undefined, "text", NaN, Infinity, true, [], {}, Object.create(null),
    cycle, [shared, shared], new Map([[null, shared], ["key", new Set([1])]])]) assert.equal(portable(value), true);
  for (const value of [() => {}, Symbol(), 1n, new (class {})(), new Date(), new WeakMap(),
    Object.create({}), new Map([[{}, 1]]), new Map([[cycle, 1]]), new Map([[Symbol(), 1]]),
    [1n], {value: Symbol()}, new Set([() => {}])]) assert.equal(portable(value), false);
  // Symbol/non-enumerable properties remain outside Object.values' verdict.
  assert.equal(portable(Object.defineProperty({[Symbol()]: 1n}, "hidden", {value: 1n})), true);
  const sharedMany = Array(budget + 1).fill(shared);
  assert.equal(portable(sharedMany), true);
});

test("portable walks 200,000 nested arrays without a call-stack overflow", () => {
  let value = null;
  for (let i = 0; i < 200_000; i++) value = [value];
  assert.equal(portable(value), true);
});

test("portable refuses graphs past the object budget without RangeError", () => {
  const value = Array.from({length: budget - 1}, () => ({}));
  assert.equal(portable(value), true); // The containing array counts too.
  value.push({});
  assert.equal(portable(value), false);
});

test("unreadable objects refuse caching without throwing", () => {
  assert.equal(portable({get value() { throw new Error("unreadable"); }}), false);
  const {proxy, revoke} = Proxy.revocable({}, {}); revoke();
  assert.equal(portable(proxy), false);
});

test("oversized stores and disk replays fall back to ordinary class lowering", () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-portable-"));
  const structure = {}, file = {getStructure: () => structure};
  const obj = {getName: () => "LARGE", getType: () => "CLAS", getMainABAPFile: () => file};
  const registry = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
  const large = {nodes: Array.from({length: budget}, () => ({}))};
  const program = () => ({wanted: new Set(["LARGE"]), supplied: new Map(),
    frontendCounts: {lowered: 0, reused: 0, loweredClasses: [], reusedClasses: []}});
  try {
    const disk = objectCache(registry, root);
    let lowered = 0;
    const compile = (ir, cached = disk) => {
      const p = program(), session = {classes: new Map(), disk: cached};
      const result = compileDiskClass({program: p}, obj, () => { lowered++; return ir; }, session);
      assert.equal(result, ir);
      assert.equal(p.frontendCounts.lowered, 1);
      assert.equal(p.frontendCounts.reused, 0);
      return session.classes.get("LARGE");
    };
    compile(large);
    compile(large); // Fresh sessions cannot replay an oversized store.
    assert.equal(lowered, 2);
    assert.deepEqual(readdirSync(root, {recursive: true}), []);
    compile(large, null); // Same lowering result with the disk cache disabled.

    // Seed a valid key/transcript, then emulate an oversized entry from an older writer.
    const small = compile({name: "IR"});
    assert.ok(small.replay);
    const path = join(root, readdirSync(root, {recursive: true}).find((f) => f.endsWith(".bin")));
    const entry = deserialize(inflateRawSync(readFileSync(path).subarray(65)));
    entry.value.ir = large;
    const payload = deflateRawSync(serialize(entry), {level: 1});
    const checksum = createHash("sha256").update(payload).digest("hex");
    writeFileSync(path, Buffer.concat([Buffer.from(checksum + "\n"), payload]));
    assert.equal(disk.read("CLAS LARGE", "LARGE", program()), undefined);
    compile(large);
    assert.equal(lowered, 5);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// Exercise the real recording, disk write/read and replay path with fresh sessions.
function cacheFixture(root) {
  const structure = {}, file = {getStructure: () => structure};
  const obj = {getName: () => "REPEATED", getType: () => "CLAS", getMainABAPFile: () => file};
  const registry = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
  const disk = objectCache(registry, root);
  const program = () => ({wanted: new Set(["X"]), supplied: new Map(), skipped: [],
    frontendCounts: {lowered: 0, reused: 0, loweredClasses: [], reusedClasses: []}});
  const compile = (p, lower, cached = disk) => compileDiskClass({program: p}, obj, lower,
    {classes: new Map(), disk: cached});
  return {disk, program, compile};
}

test("StructureType read arguments are refused before expensive serialization", () => {
  const require = createRequire(import.meta.url);
  const {BasicTypes} = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
  let type = BasicTypes.IntegerType.get();
  for (let i = 0; i < 10; i++) type = new BasicTypes.StructureType([
    {name: "A", type}, {name: "B", type},
  ]);
  const root = mkdtempSync(join(tmpdir(), "gogen-compact-type-"));
  try {
    const {disk, program, compile} = cacheFixture(root);
    const makeProgram = () => ({...program(), anonStructs: new Map([[type, "S"]])});
    const lower = ({program: p}) => {
      const names = [];
      for (let i = 0; i < 16; i++) names.push(p.anonStructs.get(type));
      return {name: "IR", names};
    };
    const p = makeProgram(), expected = lower({program: p});
    const value = {name: "REPEATED", ...recordLowering(p, (tracked) => lower({program: tracked}))};
    assert.equal(value.replay.ops.length, 16);
    assert.equal(portable(value), false);
    const start = performance.now();
    disk.write("CLAS REPEATED", value, [], p);
    assert.ok(performance.now() - start < 75, "refusing class arguments must take less than 75 ms");
    for (let i = 0; i < 2; i++) {
      const fresh = makeProgram();
      assert.deepEqual(compile(fresh, lower), expected);
      assert.equal(fresh.frontendCounts.lowered, 1);
      assert.equal(fresh.frontendCounts.reused, 0);
    }
    assert.deepEqual(readdirSync(root, {recursive: true}), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("non-portable instances inside read arguments are never inspected", () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-compact-trap-"));
  let inspected = 0;
  const trap = () => { inspected++; throw new Error("instance properties must not be read"); };
  const instance = new Proxy(new (class {})(), {get: trap, ownKeys: trap});
  try {
    const {disk, program, compile} = cacheFixture(root);
    for (const arg of [instance, {nested: [instance]}, new Map([["type", instance]]), new Set([instance])]) {
      const lower = ({program: p}) => ({name: "IR", found: p.wanted.has(arg)});
      const p = program(), expected = compile(p, lower, null);
      const value = {name: "REPEATED", ...recordLowering(p, (tracked) => lower({program: tracked}))};
      assert.doesNotThrow(() => disk.write("CLAS REPEATED", value, [], p));
      const fresh = program();
      assert.deepEqual(compile(fresh, lower), expected);
      assert.equal(fresh.frontendCounts.lowered, 1);
    }
    assert.equal(inspected, 0);
    assert.deepEqual(readdirSync(root, {recursive: true}), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("read argument validation shares one object budget across operations", () => {
  const first = Array.from({length: budget / 2}, () => ({}));
  const second = Array.from({length: budget / 2}, () => ({}));
  const op = (args, method) => ({kind: "read", key: "wanted", method, args, value: "false"});
  const value = (args) => ({replay: {ops: [op(first, "has"), op(args, "get")], written: new Set()}});
  assert.equal(portable(first), true);
  assert.equal(portable(second), true);
  assert.throws(() => compactLowering(value(second)), /Non-portable replay arguments/);
  // Shared objects count once even when read by distinct operations.
  assert.equal(compactLowering(value(first)).replay.ops.length, 2);
});

test("over-budget repeated reads are compacted before validation and replay identically", () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-compact-"));
  try {
    const {disk, program, compile} = cacheFixture(root);
    let lowered = 0;
    const lower = ({program: p}) => {
      lowered++;
      let matches = 0;
      // Each read records a fresh op and args array: 2,200,000 objects, more
      // than the budget even counting the args arrays alone.
      for (let i = 0; i < 1_100_000; i++) if (p.wanted.has("X")) matches++;
      p.skipped.push("effect");
      return {name: "IR", matches};
    };
    const cold = program(), expected = compile(cold, lower, null);
    const first = program();
    assert.deepEqual(compile(first, lower), expected);
    const stored = disk.read("CLAS REPEATED", "REPEATED", program());
    assert.ok(stored, "the repeated-read lowering must be written");
    assert.equal(stored.replay.ops.length, 2); // one read, one effect
    const warm = program();
    assert.deepEqual(compile(warm, lower), expected);
    assert.deepEqual(warm.skipped, cold.skipped);
    assert.equal(warm.frontendCounts.reused, 1);
    assert.equal(lowered, 2);
    // A changed input must still reject replay.
    const changed = program(); changed.wanted.delete("X");
    assert.deepEqual(compile(changed, lower), {name: "IR", matches: 0});
    assert.equal(changed.frontendCounts.lowered, 1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("compaction leaves oversized IR uncached and lowering unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-compact-budget-"));
  try {
    const {program, compile} = cacheFixture(root);
    const ir = {nodes: Array.from({length: budget}, () => ({}))};
    const lower = ({program: p}) => { p.wanted.has("X"); p.wanted.has("X"); return ir; };
    for (let i = 0; i < 2; i++) {
      const p = program();
      assert.equal(compile(p, lower), ir);
      assert.equal(p.frontendCounts.lowered, 1);
    }
    assert.deepEqual(readdirSync(root, {recursive: true}), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("throwing compaction skips caching without changing compilation", () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-compact-throw-"));
  try {
    const {disk, program, compile} = cacheFixture(root);
    const cycle = {}; cycle.self = cycle;
    for (const arg of [cycle, 1n]) {
      const value = {name: "REPEATED", replay: {ops: [
        {kind: "read", key: "wanted", method: "has", args: [arg], value: "false"},
      ], written: new Set()}};
      assert.throws(() => compactLowering(value), TypeError);
      assert.doesNotThrow(() => disk.write("CLAS REPEATED", value, [], program()));
      const ir = {name: "IR"};
      const lower = ({program: p}) => { p.wanted.has(arg); return ir; };
      for (let i = 0; i < 2; i++) {
        const p = program();
        assert.equal(compile(p, lower), ir);
        assert.equal(p.frontendCounts.lowered, 1);
      }
    }
    assert.deepEqual(readdirSync(root, {recursive: true}), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("ordinary small entries retain the legacy compacted file bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-compact-bytes-"));
  try {
    const {disk, program} = cacheFixture(root);
    const value = {name: "REPEATED", ir: {name: "IR"}, replay: {ops: [
      {kind: "read", key: "wanted", method: "has", args: ["X"], value: "true"},
      {kind: "read", key: "wanted", method: "has", args: ["X"], value: "true"},
      {kind: "effect", key: "wanted", method: "delete", args: ["X"]},
      {kind: "read", key: "wanted", method: "has", args: ["X"], value: "false"},
      {kind: "read", key: "wanted", method: "has", args: ["X"], value: "false"},
    ], written: new Set(["wanted"])}};
    assert.equal(portable(value), true); // Accepted by the old order.
    disk.write("CLAS REPEATED", value, [], program());
    const bin = (dir) => readFileSync(join(dir, readdirSync(dir, {recursive: true}).find((f) => f.endsWith(".bin"))));
    const bytes = bin(root), entry = deserialize(inflateRawSync(bytes.subarray(65)));
    // The old writer checked portable(value), then serialized compactLowering(value).
    const expected = {...value, replay: {...value.replay, ops: [
      value.replay.ops[0], value.replay.ops[2], value.replay.ops[3],
    ]}};
    const payload = deflateRawSync(serialize({key: entry.key, reads: [], value: expected}), {level: 1});
    const checksum = createHash("sha256").update(payload).digest("hex");
    assert.deepEqual(bytes, Buffer.concat([Buffer.from(checksum + "\n"), payload]));
    assert.equal(entry.value.replay.ops.length, 3); // The mutation fences reads.
    // Optional actual origin/main module copied by the red-before harness.
    if (process.env.GOGEN_CACHE_BASELINE) {
      const baseline = await import(process.env.GOGEN_CACHE_BASELINE);
      const oldRoot = join(root, "old");
      const registry = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
      baseline.objectCache(registry, oldRoot).write("CLAS REPEATED", value, [], program());
      assert.deepEqual(bytes, bin(oldRoot));
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
