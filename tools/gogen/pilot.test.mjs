import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileProgram} from './frontend.mjs';
import {emitJs} from './emit-js.mjs';
import {emitGo} from './emit-go.mjs';
import * as abap from './js/abap.mjs';
import {emitCondition} from './emit-js-condition.mjs';
import {decodeText, encodeText, convertIn, convertOut} from './js/codepage.mjs';

const runtime = new URL('./js/abap.mjs', import.meta.url).href;
const fixture = new URL('./testdata/', import.meta.url).pathname;
async function load(program) {
  const dir = mkdtempSync(join(tmpdir(), 'irjs-pilot-'));
  try {
    const file = join(dir, 'program.mjs');
    writeFileSync(file, emitJs(program, runtime));
    return await import(pathToFileURL(file).href);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('emission and import: double underscores, INSTANCE OF, inherited optional constructor, codepage, sy and CHECK', async () => {
  const program = compileProgram({folders: [fixture, new URL('../../.local/lars/open-abap-core/src', import.meta.url).pathname],
    objects: ['zcl_gogen_t__pilot', 'zcl_gogen_t_pilchild', 'cl_abap_codepage', 'cl_abap_conv_in_ce', 'cl_abap_conv_out_ce']});
  assert.deepEqual(program.partial.filter((reason) => reason.startsWith("ZCL_GOGEN_T_")), []);
  assert.doesNotMatch(emitGo(program), /CREATE OBJECT by name of a class whose constructor has parameters/);
  const m = await load(program);
  assert.equal(m.ZCL_GOGEN_T__PILOT.RUN({sy: {index: 0}}), '7/1/X/X/X///7/C3A4/00D8/AA/007/hello/2');
});

const I = {k: 'i'}, S = {k: 'string'};
function tiny(body, locals = []) {
  return {structs: new Map(), consts: new Map(), classes: [{name: 'Z_PILOT', attributes: [], constructor: null,
    methods: [{name: 'RUN', static: true, params: [], locals, body, returning: {name: 'RV', type: S}}]}]};
}

test('DELETE below 1 retains the Go refusal, including an empty table and TO below 1', async () => {
  const table = {e: 'var', name: 'ROWS', type: {k: 'table', row: I}};
  for (const [from, to] of [[0, 1], [1, 0], [-1, 3], [1, null]]) {
    const program = tiny([{s: 'delete_range', table, from: {e: 'int', value: from, type: I},
      to: to === null ? null : {e: 'int', value: to, type: I}}], [{name: 'ROWS', type: table.type}]);
    assert.match(emitGo(program), /index below 1 was not measured/);
    const m = await load(program);
    assert.throws(() => m.Z_PILOT.RUN({sy: {}}), /index below 1 was not measured/);
  }
});

test('required dynamic constructor arguments retain the Go guard', async () => {
  const program = tiny([]);
  program.classes[0].constructor = {params: [{name: 'COUNT', type: I, dir: 'importing'}], locals: [], body: []};
  for (const code of [emitGo(program), emitJs(program)]) assert.match(code, /CREATE OBJECT by name of a class whose constructor has parameters/);
});

test('keyed table expressions read and write rows, and a miss raises CX_SY_ITAB_LINE_NOT_FOUND', async () => {
  const table = {e: 'var', name: 'ROWS', type: {k: 'table', row: I}};
  const key = {e: 'row_key', base: table, keys: [{line: true, value: {e: 'int', value: 7, type: I}}], type: I};
  const program = tiny([{s: 'assign', target: table, value: {e: 'table_lit', rows: [{e: 'int', value: 7, type: I}], type: table.type}},
    {s: 'assign', target: key, value: {e: 'int', value: 9, type: I}},
    {s: 'assign', target: {e: 'var', name: 'RV', type: S}, value: {e: 'template', parts: [{value: {e: 'row', base: table, index: {e: 'int', value: 1, type: I}, type: I}}], type: S}},
    {s: 'assign', target: key, value: {e: 'int', value: 10, type: I}}], [{name: 'ROWS', type: table.type}]);
  const m = await load(program);
  assert.throws(() => m.Z_PILOT.RUN({sy: {}}), /CX_SY_ITAB_LINE_NOT_FOUND/);
  program.classes[0].methods[0].body.pop();
  assert.equal((await load(program)).Z_PILOT.RUN({sy: {}}), '9');
});

test('synchronous codepages preserve the Go byte and N contracts', () => {
  for (const encoding of ['utf8', 'utf16le']) for (const text of ['', 'ä€🙂', '\uFEFFab'])
    assert.equal(encodeText(encoding, text), Buffer.from(text, encoding).toString('latin1'));
  assert.equal(encodeText('utf8', '\ud800'), '\xED\xA0\x80');
  assert.equal(encodeText('utf16le', '\ud800'), '\x00\xD8');
  assert.equal(decodeText('utf8', false, '\xEF\xBB\xBFa'), '\uFEFFa');
  assert.equal(decodeText('iso-8859-1', false, '\x80'), '€');
  assert.throws(() => decodeText('utf8', false, '\xFF'), /CX_SY_CONVERSION_CODEPAGE/);
  assert.equal(decodeText('utf8', true, '\xFF'), '\uFFFD');
  const result = {v: 'before'};
  convertOut({}, 'utf8', 'abc', 0, result, 'X'); assert.equal(result.v, '');
  convertOut({}, 'utf8', 'abc', 0, result); assert.equal(result.v, 'abc');
  assert.throws(() => convertOut({}, 'utf8', 'abc', 1, result), /N given/);
  assert.throws(() => convertIn({}, 'utf8', false, 'abc', 1, result), /N given/);
  assert.equal(result.v, 'abc');
});


test('static owner spelling survives double underscores before a numeric suffix', async () => {
  const program = tiny([]);
  const cls = program.classes[0]; cls.name = 'Z_PILOT__123';
  cls.attributes = [{static: true, name: 'COUNTER', type: I}];
  cls.methods[0].body = [{s: 'assign', target: {e: 'static', owner: cls.name, name: 'COUNTER', go: 'Z_PILOT__123__COUNTER', type: I}, value: {e: 'int', value: 9, type: I}}];
  const m = await load(program); m.Z_PILOT__123.RUN({sy: {}});
  assert.equal(m.Z_PILOT__123.counter, 9);
});

test('INSTANCE OF evaluates once and matches class/interface metadata and OBJECT', () => {
  const compile = (initial, target) => {
    const code = emitCondition({c: 'instance_of', x: {}, type: {name: target}, initial}, {}, {expr: () => 'get()'});
    return new Function('get', `return ${code};`);
  };
  let calls = 0;
  const value = {constructor: {$is: new Set(['Z_CHILD', 'Z_PARENT', 'ZIF_PILOT'])}};
  assert.equal(compile(false, 'ZIF_PILOT')(() => { calls++; return value; }), true);
  assert.equal(calls, 1);
  assert.equal(compile(false, 'Z_OTHER')(() => value), false);
  assert.equal(compile(false, 'OBJECT')(() => value), true);
  assert.equal(compile(true, 'Z_PARENT')(() => null), true);
  assert.equal(compile(false, 'Z_CHILD')(() => undefined), false);
});

test('generic OBJECT fits dynamic creation and CAST, mismatched CAST raises', async () => {
  const m = await load(tiny([]));
  const value = abap.createAs({sy: {}}, 'Z_PILOT', 'OBJECT');
  assert.equal(value instanceof m.Z_PILOT, true);
  assert.equal(abap.cast(value, 'OBJECT'), value);
  assert.throws(() => abap.cast(value, 'Z_OTHER'), /CX_SY_MOVE_CAST_ERROR/);
  assert.equal(abap.cast(null, 'Z_OTHER'), null);
});
