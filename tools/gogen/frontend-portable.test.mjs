import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {portable, objectCache, compileDiskClass} from "./frontend-object-cache.mjs";

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
