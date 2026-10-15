import {test} from "node:test";
import assert from "node:assert/strict";
import {emitPackedInt8, emitPackedComparison} from "./emit-int8.ts";
const P = {k: "p", len: 16, dec: 0, calc: true}, I8 = {k: "int8"};
const variable = {e: "var", name: "a", type: I8};
const operand = {e: "conv", kind: "i2pc", x: variable, from: I8, to: P, type: P};
const literal = (value) => ({e: "str", value, type: P});
const binary = (op, l = operand, r = literal("4294967296")) => ({e: "bin", op, l, r, type: P});
const convert = (x) => ({e: "conv", kind: "p2i8", from: P, to: I8, x, arith: true, type: I8});
const render = (e) => e === variable ? "a" : "packedSlow";
const emit = (x) => emitPackedInt8(convert(x), render, (h) => h);

test("integral packed arithmetic lowers without formatting or math/big", () => {
 for (const [op, method] of [["+","AddI8"],["-","SubI8"],["*","MulI8"],["/","DivI8"],["DIV","DivIntI8"],["MOD","ModI8"]])
  assert.equal(emit(binary(op)), `abap.${method}(int64(a), int64(4294967296))`);
 assert.equal(emit(literal("-9223372036854775808")), "int64(-9223372036854775808)");
 assert.equal(emitPackedComparison({c:"cmp",type:P,op:">=",l:operand,r:literal("2147483648")},render), "int64(a) >= int64(2147483648)");
});
test("wider intermediates retry packed calculation, fractional intermediates retain it", () => {
 assert.match(emit(binary("-",binary("+"))), /intarith\.Packed\(func\(\) int64.*abap.PToI8\(packedSlow, true\)/);
 assert.equal(emit(binary("*",binary("/"))), null);
 assert.equal(emit(binary("/",binary("+"))), null);
 assert.equal(emit(binary("+",operand,literal("9223372036854775808"))), null);
 assert.equal(emit(binary("+",operand,literal("1.25"))), null);
});
test("calls and reference reads cannot be repeated by overflow fallback", () => {
 const call = {e:"call",method:"RUN",static:true,owner:"C",callee:"C=>RUN",args:[],type:I8};
 for (const x of [call, {e:"static",owner:"C",name:"A",go:"c_a",type:I8}, {...variable,ref:true}, {e:"field",base:call,name:"A",type:I8}])
  assert.equal(emit(binary("+",{...operand,x})), null);
});
test("pure field and conversion operands retain metadata and side-effect checks", () => {
 const field = {e:"field",base:variable,name:"A",type:I8};
 const conversion = {e:"conv",kind:"num",from:I8,to:I8,x:field,type:I8};
 for (const x of [field, conversion, {...conversion,pos:{file:"fixture.abap",row:1}}])
  assert.equal(emit({...operand,x}), "int64(packedSlow)");
 for (const x of [{...conversion,fields:[]}, {...conversion,pairs:[]}, {...field,fromP:P},
   {...field,base:{...variable,ref:true}}])
  assert.equal(emit({...operand,x}), null);
});
