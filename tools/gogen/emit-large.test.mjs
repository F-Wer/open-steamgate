import {test} from "node:test";
import assert from "node:assert/strict";
import {emitGo} from "./emit-go.mjs";
import {emitJs} from "./emit-js.mjs";

// More lines than V8 accepts as arguments, without parsing a huge source file.
const count = 300000;
for (const [backend, emit, line] of [["Go", emitGo, "lv = int32(7)"], ["JS", emitJs, "lv = 7;"]]) {
  for (const nested of [false, true]) {
    test(`${backend} emits ${count} statements in a ${nested ? "nested" : "flat"} method`, {timeout: 10000}, () => {
      const target = {e: "var", name: "LV", type: {k: "i"}};
      const value = {e: "int", value: 7, type: {k: "i"}};
      const body = Array.from({length: count}, () => ({s: "assign", target, value}));
      body[0] = {s: "assign", target, value: {...value, value: 11}};
      body[count - 1] = {s: "assign", target, value: {...value, value: 19}};
      const cond = {c: "cmp", op: "=", l: value, r: value};
      const program = {
        structs: new Map(), consts: new Map(),
        classes: [{name: "ZCL_LARGE", attributes: [], interfaces: [], constructor: null, methods: [{
          name: "RUN", static: true, returning: null, params: [], locals: [{name: "LV", type: {k: "i"}}], fieldSymbols: [],
          body: nested ? [{s: "if", branches: [{cond, body}], else: null}] : body,
        }]}],
      };
      const source = emit(program);
      // Check completeness as well as the absence of RangeError.
      assert.equal(source.split("\n").filter((s) => s.trim() === line).length, count - 2);
      const statements = source.split("\n").map((s) => s.trim()).filter((s) => /^lv = /.test(s));
      assert.equal(statements[0], backend === "Go" ? "lv = int32(11)" : "lv = 11;");
      assert.equal(statements.at(-1), backend === "Go" ? "lv = int32(19)" : "lv = 19;");
    });
  }
}

test("Go inserts 150000 local declarations without spreading call arguments", {timeout: 10000}, () => {
  const locals = Array.from({length: 150000}, (_, i) => ({name: `V${i}`, type: {k: "i"}}));
  const program = {
    structs: new Map(), consts: new Map(),
    classes: [{name: "ZCL_LOCALS", attributes: [], interfaces: [], constructor: null, methods: [{
      name: "RUN", static: true, returning: null, params: [], locals, fieldSymbols: [], body: [],
    }]}],
  };
  assert.equal(emitGo(program).match(/\tvar v\d+ int32/g).length, locals.length);
});

test("JS emits a 300000-byte static xstring through emitJs", {timeout: 10000}, () => {
  const program = {
    structs: new Map(), consts: new Map(),
    classes: [{name: "ZCL_BYTES", interfaces: [], constructor: null, methods: [],
      attributes: [{name: "BYTES", static: true, type: {k: "xstring"}, value: "AB".repeat(count)}]}],
  };
  const source = emitJs(program);
  assert.ok(source.includes(`  static bytes = ${JSON.stringify("\u00ab".repeat(count))};`));
});
