import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sinkLocals, generatedBindings} from './sink-locals.ts';
const type = {k: 'i'};
const x = {e: 'var', name: 'X', type};
const y = {e: 'var', name: 'Y', type};
const clear = {s: 'clear', target: x};
const reset = {s: 'assign', target: x, value: {e: 'int', value: 3, type}};
const read = {s: 'assign', target: y, value: x};
const yes = {c: 'initial', x: y};
function method(body) { return {locals: [{name: 'X', type}], body}; }
function branch(body, kind = 'if') { return {s: kind, branches: [{cond: yes, body}], else: null}; }
function sinks(body) { return sinkLocals(method(body), true); }

for (const kind of ['if', 'case', 'do', 'while', 'loop', 'try']) {
  test(`${kind} body with top-level CLEAR sinks`, () => {
    const body = [clear, read];
    const stmt = ['if', 'case'].includes(kind) ? branch(body, kind) : {s: kind, body};
    assert.deepEqual([...sinks([stmt]).keys()], [body]);
  });
}
test('assignment and inline DATA reset; select innermost qualifying block', () => {
  const body = [reset, read];
  assert.deepEqual([...sinks([{s: 'do', body: [branch(body)]}]).keys()], [body]);
});
test('first touch may follow unrelated statements', () => {
  const body = [{s: 'nop'}, reset, read];
  assert.equal(sinks([branch(body)]).has(body), true);
});
for (const [name, body] of [
  ['read before CLEAR in loop', [{s: 'do', body: [read, clear]}]],
  ['use after branch', [branch([clear]), read]],
  ['use in two branches', [{s: 'if', branches: [{cond: yes, body: [clear]}, {cond: yes, body: [read]}], else: null}]],
  ['value carried across iterations', [{s: 'do', body: [{s: 'assign', target: x, value: {e: 'bin', l: x, r: y}}]}]],
  ['conditional reset does not dominate later read', [{s: 'do', body: [branch([clear]), read]}]],
  ['GET REFERENCE', [branch([clear, {s: 'get_ref', value: x, target: y}])]],
  ['ASSIGN', [branch([clear, {s: 'assign_data', value: x, fs: y}])]],
  ['CATCH INTO', [branch([clear, {s: 'try', body: [], catches: [{into: 'X', body: []}]}])]],
  ['closure capture in CATCH', [{s: 'try', body: [clear], catches: [{body: [read]}]}]],
  ['address-of call argument', [branch([clear, {s: 'call', call: {e: 'call', args: [{place: x}]}}])]],
  ['dynamic component name disables whole method', [branch([clear, read]), {s: 'assign_comp', from: y, name: y}]],
  ['event closure capture', [branch([clear, {s: 'raise_event', args: [{value: x}]}])]],
  ['field write is not full reset', [branch([{s: 'clear', target: {e: 'field', base: x}}, read])]],
  ['seq does not introduce Go scope', [{s: 'seq', body: [clear, read]}]],
  ['loop header reads before reset', [{s: 'while', cond: {c: 'initial', x}, body: [clear, read]}]],
  ['VALUE initialised at method entry', [reset, branch([clear, read])]],
]) test(`${name} retains method lifetime`, () => assert.equal(sinks(body).size, 0));
test('VALUE, STATICS, dynamic access and option retain method lifetime', () => {
  for (const local of [{name: 'X', type, value: 7}, {name: 'X', type, static: true}]) {
    assert.equal(sinkLocals({locals: [local], body: [branch([clear, read])]}, true).size, 0);
  }
  const m = method([branch([clear, read])]);
  assert.equal(sinkLocals({...m, sinkUnsafe: true}, true).size, 0);
  assert.equal(sinkLocals(m, false).size, 0);
});

test('frontend and emitter move declarations with their original initial values', async () => {
  const {compileProgram} = await import('./frontend.mjs');
  const {emitGo} = await import('./emit-go.mjs');
  const {mkdtempSync, writeFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sink-emitter-'));
  const previous = process.env.GOGEN_SINK_LOCALS;
  try {
    writeFileSync(join(dir, 'zcl_sink_test.clas.abap'), `
CLASS zcl_sink_test DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_sink_test IMPLEMENTATION.
 METHOD run.
 DO 3 TIMES.
   DATA counter TYPE i.
   DATA date TYPE d.
   DATA byte TYPE x LENGTH 2.
   CLEAR counter.
   CLEAR date.
   CLEAR byte.
   counter = counter + 1.
   rv = rv + counter.
 ENDDO.
 ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [dir], objects: ['ZCL_SINK_TEST']});
    assert.deepEqual(program.partial, []);
    process.env.GOGEN_SINK_LOCALS = '0';
    const before = emitGo(program);
    process.env.GOGEN_SINK_LOCALS = '1';
    const after = emitGo(program);
    assert.match(before, /^\tvar counter int32$/m);
    assert.match(after, /^\t\t\tvar counter int32$/m);
    assert.match(after, /^\t\t\tvar date string = "00000000"$/m);
    const declarations = go => go.split('\n').filter(line => /^\s*var (counter|date|byte_)\b|^\s*_ = (counter|date|byte_)$/.test(line));
    assert.deepEqual(declarations(after).map(line => line.trim()).sort(), declarations(before).map(line => line.trim()).sort());
    const rest = go => go.split('\n').filter(line => !declarations(go).includes(line)).join('\n');
    assert.equal(rest(after), rest(before));
  } finally {
    if (previous === undefined) delete process.env.GOGEN_SINK_LOCALS;
    else process.env.GOGEN_SINK_LOCALS = previous;
    rmSync(dir, {recursive: true, force: true});
  }
});

test('frontend marks dynamic source access even when an unrelated local could sink', async () => {
  const {compileProgram} = await import('./frontend.mjs');
  const {mkdtempSync, writeFileSync, readFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sink-dynamic-'));
  try {
    writeFileSync(join(dir, 'zcl_sink_dynamic.clas.abap'), `
CLASS zcl_sink_dynamic DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run IMPORTING VALUE(name) TYPE string.
ENDCLASS.
CLASS zcl_sink_dynamic IMPLEMENTATION.
 METHOD run.
 DATA ref TYPE REF TO data.
 CREATE DATA ref TYPE (name).
 DO 2 TIMES.
   DATA x TYPE i.
   CLEAR x.
   x = x + 1.
 ENDDO.
 ENDMETHOD.
ENDCLASS.
`);
    const program = compileProgram({folders: [dir], objects: ['ZCL_SINK_DYNAMIC']});
    assert.deepEqual(program.partial, []);
    const m = program.classes[0].methods[0];
    assert.equal(m.sinkUnsafe, true);
    assert.equal(sinkLocals(m, true).size, 0);
    assert.equal(sinkLocals({...m, sinkUnsafe: false}, true).size, 0);
    const file = join(dir, 'zcl_sink_dynamic.clas.abap');
    const headerSource = readFileSync(file, 'utf8').replace('CREATE DATA ref TYPE (name).', '')
      .replace('DO 2 TIMES.', 'DATA tab TYPE STANDARD TABLE OF i WITH DEFAULT KEY.\n DATA row TYPE i.\n LOOP AT tab INTO row USING KEY (name).')
      .replace('ENDDO.', 'ENDLOOP.');
    writeFileSync(file, headerSource);
    const headerProgram = compileProgram({folders: [dir], objects: ['ZCL_SINK_DYNAMIC']});
    assert.deepEqual(headerProgram.partial, []);
    const headerMethod = headerProgram.classes[0].methods[0];
    assert.equal(headerMethod.sinkUnsafe, true);
    assert.equal(sinkLocals(headerMethod, true).size, 0);

  } finally { rmSync(dir, {recursive: true, force: true}); }
});

for (const header of [
  'var collision int', 'collision, ok := next()',
  'for collision := 0; collision < 3; collision++ {',
  'for _, collision := range rows {',
  'func(collision, other int) {', 'func() (collision int) {',
  'collision: for {',
]) test(`generated binding guard: ${header}`, () => {
  assert.equal(generatedBindings(header).has('collision'), true);
});
test('binding guard ignores literals and comments and fails closed on uncertain headers', () => {
  assert.equal(generatedBindings('x := "collision := 1" // var collision int').has('collision'), false);
  assert.equal(generatedBindings('func(\n collision int,\n) {'), null);
  assert.equal(generatedBindings('var (\n collision int\n)'), null);
  assert.equal(generatedBindings('var\n collision int'), null);
  assert.equal(generatedBindings('func(value struct {\n collision int\n}) {'), null);
});
test('emitter retains colliding locals including descendants and enclosing generated bindings', async () => {
  const {compileProgram} = await import('./frontend.mjs');
  const {emitGo} = await import('./emit-go.mjs');
  const {mkdtempSync, writeFileSync, readFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sink-collisions-'));
  const previous = process.env.GOGEN_SINK_LOCALS;
  try {
    // Run both exact counterexamples and put their resets inside IF as well:
    // the generated binding is then in an enclosing construct, not the body.
    const fixture = readFileSync(new URL('./testdata/zcl_gogen_t_blocklocals.clas.abap', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'cx_root.clas.abap'), 'CLASS cx_root DEFINITION PUBLIC. ENDCLASS. CLASS cx_root IMPLEMENTATION. ENDCLASS.');
    for (const nested of [false, true]) {
      const source = nested ? fixture.replace('CLEAR ctl.', 'IF rv = 0. CLEAR ctl. ENDIF.')
        .replace('CLEAR i0.', 'IF rv = 0. CLEAR i0. ENDIF.') : fixture;
      writeFileSync(join(dir, 'zcl_gogen_t_blocklocals.clas.abap'), source);
      const program = compileProgram({folders: [dir], objects: ['ZCL_GOGEN_T_BLOCKLOCALS']});
      process.env.GOGEN_SINK_LOCALS = '1';
      const go = emitGo(program);
      assert.match(go, /^\tvar ctl int32$/m);
      assert.match(go, /^\tvar i0 int32$/m);
      assert.doesNotMatch(go, /^\t{2,}var (ctl|i0) int32$/m);
    }
  } finally {
    if (previous === undefined) delete process.env.GOGEN_SINK_LOCALS;
    else process.env.GOGEN_SINK_LOCALS = previous;
    rmSync(dir, {recursive: true, force: true});
  }
});
