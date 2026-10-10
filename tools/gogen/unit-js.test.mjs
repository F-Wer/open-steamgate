import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cell,TI,TF,TP,TC,TString,CmpData,UnitDumpToString,EncodeBase64,DecodeBase64,SubS,Strlen,ParseI,ParseF,CFit,FindStmt,FindResults,ReplaceFn,bindRow,bumpTable,Row} from './js/abap.mjs';

test('numeric and flat-string fast paths preserve boundaries and fallbacks', () => {
  assert.equal(ParseI('2147483647'),2147483647);
  assert.equal(ParseI('-2147483648'),-2147483648);
  for (const v of ['2147483648','-2147483649'])
    assert.throws(()=>ParseI(v),/CX_SY_CONVERSION_OVERFLOW/);
  assert.throws(()=>ParseI('1234567890\n'),/CX_SY_CONVERSION_NO_NUMBER/);
  assert.ok(Object.is(ParseI('-0'),-0));
  assert.equal(ParseI(' 1.5- '),-2);
  assert.equal(ParseI('0000000000001'),1);
  assert.equal(ParseF('+999999999999999'),999999999999999);
  assert.equal(ParseF('1E+2'),100);
  assert.equal(ParseF('1 2'),1);
  assert.throws(()=>ParseF('Infinity'),/CX_SY_CONVERSION_OVERFLOW/);
  assert.throws(()=>ParseF('NaN'),/NOT_COMPILED/);
  assert.equal(CFit('abc ',3),'abc');
  assert.equal(CFit('ä z',2),'ä');
  // UTF-16 units, as Go's Strlen/SubS (#712): a cut pair keeps its high half
  assert.equal(CFit('a😀z',2),'a\ud83d');
  assert.equal(CFit('\ud800z',1),'\ud800');
  assert.equal(CFit('abc',0),'');
});

test('generic comparison chooses the pair type and keeps packed precision', () => {
  assert.equal(CmpData(cell(-1,TF),cell(-1,TI)),0);
  assert.equal(CmpData(cell(5,TI),cell('4.9',TString)),0);
  assert.equal(CmpData(cell('9007199254740993',TP(10,0)),cell('9007199254740992',TP(10,0))),1);
  assert.equal(CmpData(cell('a',TC(3)),cell('a',TString)),0);
  assert.throws(()=>CmpData(cell(0,TI),cell('abc',TString)),/CONVT_NO_NUMBER/);
  assert.equal(UnitDumpToString({},cell(1.5,TF)).trim(),'1.5');
  const text='hello ä😀'; assert.equal(DecodeBase64({},EncodeBase64({},text)),text);
});

test('large string sections retain Unicode indexing across cache eviction', () => {
  const input='a'.repeat(5000)+'😀'+'z';
  assert.equal(Strlen(input),5002);
  assert.equal(SubS(input,5000,1),'😀');
  for (let i=0;i<6;i++) assert.equal(SubS('b'.repeat(5000)+i,5000,1),String(i));
  assert.equal(SubS(input,5001,1),'z');
  assert.throws(()=>SubS(input,5002,1),/CX_SY_RANGE_OUT_OF_BOUNDS/);
});

test('IR-JS unit lifecycle catches failures and honors teardown QUIT', {timeout:120000}, () => {
  const out=mkdtempSync(join(tmpdir(),'irjs-unit-'));
  try {
    const run=spawnSync('node',['--max-old-space-size=16000','tools/gogen/unit-js.mjs','--fixture','tools/gogen/testdata-unit','--out',out],{encoding:'utf8',timeout:110000,maxBuffer:2e6});
    assert.equal(run.status,1,run.stderr||run.stdout);
    const rows=JSON.parse(readFileSync(join(out,'results.json'),'utf8'));
    assert.deepEqual(rows.map(r=>r.status),['SUCCESS','FAILED','FAILED','SUCCESS','SUCCESS','FAILED','FAILED','SKIPPED','FAILED','SKIPPED','FAILED','SUCCESS']);
    assert.equal(rows[1].message,'intentional failure');
    assert.equal(rows[6].message,'teardown: stop second');
    assert.match(rows[2].message,/CX_SY_ZERODIVIDE/);
  } finally {rmSync(out,{recursive:true,force:true});}
});


test('compiled ASSERT_EQUALS formats failures and compares structures', {timeout:120000}, () => {
  const dir=mkdtempSync(join(tmpdir(),'irjs-assert-'));
  const fixture=join(dir,'input'); mkdirSync(fixture);
  writeFileSync(join(fixture,'zcl_irjs_assert.clas.abap'),`CLASS zcl_irjs_assert DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS.
CLASS zcl_irjs_assert IMPLEMENTATION. ENDCLASS.`);
  writeFileSync(join(fixture,'zcl_irjs_assert.clas.testclasses.abap'),`CLASS ltcl_assert DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
PRIVATE SECTION.
METHODS mixed FOR TESTING.
METHODS differs FOR TESTING.
ENDCLASS.
CLASS ltcl_assert IMPLEMENTATION.
METHOD mixed.
DATA floating TYPE f VALUE '2'.
cl_abap_unit_assert=>assert_equals( act = floating exp = 2 ).
ENDMETHOD.
METHOD differs.
TYPES: BEGIN OF ty_row, number TYPE i, text TYPE string, END OF ty_row.
DATA a TYPE ty_row.
DATA b TYPE ty_row.
a-number = 1.
b-number = 2.
cl_abap_unit_assert=>assert_equals( act = a exp = b ).
ENDMETHOD.
ENDCLASS.`);
  try {
    const out=join(dir,'out');
    const run=spawnSync('node',['--max-old-space-size=16000','tools/gogen/unit-js.mjs','--fixture',fixture,'--out',out],{encoding:'utf8',timeout:110000,maxBuffer:2e6});
    assert.equal(run.status,1,run.stderr||run.stdout);
    const rows=JSON.parse(readFileSync(join(out,'results.json'),'utf8'));
    assert.deepEqual(rows.map(r=>r.status),['SUCCESS','FAILED']);
    assert.equal(rows[1].message,"Expected 'number: 2, text: ', got 'number: 1, text: '");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('POSIX regex syntax guards ignore escaped literals and bracket contents', () => {
  const find = (text, pattern) => FindStmt(text, pattern, true, false, 0);
  assert.deepEqual(find('*', String.raw`^\*?$`), [true, 0, 1, []]);
  assert.deepEqual(find('?', String.raw`^[*+?]*$`), [true, 0, 1, []]);
  assert.deepEqual(find('#', String.raw`^[\#]$`), [true, 0, 1, []]);
  assert.deepEqual(find('\\#', String.raw`^\\#$`), [true, 0, 2, []]);
  assert.equal(find('?', String.raw`[^/(?]*`)[0], true);
  assert.deepEqual(find('a', '(?:a)'), [true, 0, 1, []]);
  assert.deepEqual(FindResults('*', String.raw`\*?`, 'R', false, false), [[0, 1]]);
  assert.equal(ReplaceFn('*', String.raw`\*?`, 'x', true, 1), 'x');
  for (const pattern of ['a*?', 'a+?', 'a??', String.raw`[\]]+?`])
    assert.throws(() => find('a', pattern), /CX_SY_INVALID_REGEX/);
  for (const pattern of ['(?=a)', '(?!a)', '(?i:a)'])
    assert.throws(() => find('a', pattern), /NOT_COMPILED/);
  assert.throws(() => find('a\rb', '^b'), /NOT_COMPILED/);
  assert.deepEqual(find('a\nb', '^b'), [true, 2, 1, []]);
});

test('lazy table epochs invalidate existing bindings after mutation or replacement', () => {
  let table = [1, 2];
  for (let i = 0; i < 10; i++) bumpTable(table); // no binding yet
  const first = bindRow(() => table, 0);
  assert.equal(first.get(), 1);
  first.set(7);
  assert.equal(first.get(), 7); // replacing an elementary value keeps its slot
  table.push(3); bumpTable(table);
  assert.throws(() => first.get(), /GETWA_NOT_ASSIGNED/);
  assert.throws(() => first.set(9), /GETWA_NOT_ASSIGNED/);
  const second = bindRow(() => table, 0);
  assert.equal(second.get(), 7);
  table = table.slice();
  assert.throws(() => second.get(), /GETWA_NOT_ASSIGNED/);
  const third = bindRow(() => table, 0);
  assert.equal(third.get(), 7);
  const generic = Row({get: () => table, t: {row: TI}}, 1);
  assert.equal(generic.get(), 2);
  table.splice(0, 1); bumpTable(table);
  assert.throws(() => third.get(), /GETWA_NOT_ASSIGNED/);
  assert.throws(() => generic.get(), /GETWA_NOT_ASSIGNED/);
  assert.equal(bindRow(() => table, 0).get(), 2);
});
