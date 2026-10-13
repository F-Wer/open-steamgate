import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compileProgram, convert} from './frontend.mjs';
import {emitGo} from './emit-go.mjs';
import {emitJs} from './emit-js.mjs';
import {libraryPath} from '../osd-lib-path.mjs';
import {home} from './home.mjs';
const root = {k: 'ref', name: 'CX_ROOT'};
const exc = {e: 'var', name: 'X', type: {k: 'exc'}};
const core = join(libraryPath(home, 'open-abap-core'), 'src');
function compile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'exc-frontend-'));
  try {
    writeFileSync(join(dir, 'zcl_exc_probe.clas.abap'), `CLASS zcl_exc_probe DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION. CLASS-METHODS run. ENDCLASS.
CLASS zcl_exc_probe IMPLEMENTATION. METHOD run. DATA zero TYPE i.
TRY. zero = 1 / zero. CATCH cx_root INTO DATA(x). ${body} ENDTRY.
ENDMETHOD. ENDCLASS.`);
    return compileProgram({folders: [dir, core], objects: ['ZCL_EXC_PROBE', 'CX_ROOT', 'CL_ABAP_CLASSDESCR', 'CL_ABAP_OBJECTDESCR'], tolerant: true});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
test('exception widening has exactly two implicit targets', () => {
  for (const type of [root, {k: 'ref', name: 'OBJECT', intf: true}])
    assert.equal(convert(exc, type).e, 'exc_ref');
  for (const name of ['CX_SY_ZERODIVIDE', 'CX_STATIC_CHECK', 'IF_MESSAGE'])
    assert.throws(() => convert(exc, {k: 'ref', name}), new RegExp(`exception widening to REF TO ${name}`));
});
test('PREVIOUS reads and assignment/table widening compile', () => {
  const p = compile(`DATA r TYPE REF TO cx_root. DATA o TYPE REF TO object.
DATA rows TYPE STANDARD TABLE OF REF TO cx_root WITH DEFAULT KEY.
r = x. o = x. r = x->previous. x = x->previous. APPEND x TO rows. IF x->previous IS NOT BOUND. ENDIF.`);
  assert.deepEqual(p.partial.filter(x => x.startsWith('ZCL_EXC_PROBE')), []);
  assert.ok(p.missing.has('CX_SY_ZERODIVIDE'));
  assert.ok(p.missing.has('CX_ROOT'));
});
test('unimplemented exception semantics keep named refusals', () => {
  for (const [body, pattern] of [
    ['DATA text TYPE string. text = x->get_longtext( ).', /exception method/],
    ["DATA text TYPE string. text = x->textid.", /exception attribute TEXTID/],
    ['x->previous = x.', /exception attribute PREVIOUS write/],
    ['DATA r TYPE REF TO cx_sy_zerodivide. r ?= x.', /cast of a exc/],
    ["DATA d TYPE REF TO cl_abap_classdescr. DATA t TYPE REF TO cl_abap_datadescr. t = d->get_attribute_type( 'PREVIOUS' ).", /object RTTI method GET_ATTRIBUTE_TYPE/],
  ]) assert.match(compile(body).partial.join('\n'), pattern, body);
});

test('IR-JS initial, leaf and missing-class behavior agrees with Go', async () => {
  const abap = await import('./js/abap.mjs');
  assert.equal(abap.exceptionRef({}, null), null);
  assert.equal(abap.exceptionPrevious(new abap.AbapError('CX_SY_ZERODIVIDE', '/')), null);
  assert.throws(() => abap.exceptionRef({}, new abap.AbapError('CX_UNCOMPILED_TEST', 'test')), /NOT_COMPILED.*CX_UNCOMPILED_TEST/);
  for (const call of [() => abap.exceptionPrevious(null), () => abap.excText({}, null), () => abap.exceptionClass(null)])
    assert.throws(call, /OBJECTS_OBJREF_NOT_ASSIGNED/);
  for (const member of ['TEXTID', 'KERNEL_ERRID', 'ANY_CX_ATTRIBUTE'])
    assert.throws(() => abap.exceptionRead({$kernelException: {}}, member), new RegExp(`NOT_COMPILED.*exception attribute ${member}`));
});

test('initial PREVIOUS readers and widened metadata reach guarded IR on both hosts', () => {
  for (const body of [
    'x = x->previous. DATA text TYPE string. text = x->get_text( ).',
    'x = x->previous. DATA text TYPE string. text = cl_abap_classdescr=>get_class_name( x ).',
    'x = x->previous. x = x->previous.',
    "DATA r TYPE REF TO cx_root. DATA text TYPE string. r = x. text = 'textid=' && r->textid && '/errid=' && r->kernel_errid.",
  ]) {
    const p = compile(body);
    assert.deepEqual(p.partial.filter(x => x.startsWith('ZCL_EXC_PROBE')), [], body);
    const go = emitGo(p), js = emitJs(p);
    if (body.includes('get_text')) {
      assert.match(go, /x.TextOf\(s\)/); assert.match(js, /abap.excText\(s, x\)/);
    } else if (body.includes('get_class_name')) {
      assert.match(go, /abap.ExceptionClass\(x\)/); assert.match(js, /abap.exceptionClass\(x\)/);
    } else if (body.includes('textid')) {
      for (const member of ['TEXTID', 'KERNEL_ERRID']) {
        assert.ok(go.includes(`abap.ExceptionRead(r, "${member}")`), go);
        assert.ok(js.includes(`abap.exceptionRead(r, "${member}")`), js);
      }
    } else {
      assert.match(go, /abap.ExceptionPrevious\(x\)/); assert.match(js, /abap.exceptionPrevious\(x\)/);
    }
  }
});

// The loaded CX_ROOT declaration has no IS_RESUMABLE: there is no field
// value for either emitter to invent or expose.
test('absent IS_RESUMABLE is refused by its name', () => {
  const p = compile('DATA r TYPE REF TO cx_root. DATA flag TYPE abap_bool. r = x. flag = r->is_resumable.');
  assert.match(JSON.stringify(p.diagnostics), /is_resumable/i);
});

test('ordinary descriptor enumeration compiles with a runtime kernel guard', () => {
  const p = compile('DATA d TYPE REF TO cl_abap_classdescr. READ TABLE d->interfaces TRANSPORTING NO FIELDS WITH KEY name = `IF_OO_ADT_CLASSRUN`.');
  assert.deepEqual(p.partial.filter(x => x.startsWith('ZCL_EXC_PROBE')), []);
  assert.match(emitGo(p), /abap.ObjectRttiRead\(d, "INTERFACES"\)/);
  assert.match(emitJs(p), /abap.objectRttiRead\(d, "INTERFACES"\)/);
});
