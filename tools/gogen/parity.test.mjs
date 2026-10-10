// Direct runtime parity: the Go host remains the contract, including refusals.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import * as A from './js/abap.mjs';
import {decodeText, convertOut} from './js/codepage.mjs';

const decoders = [
  ...['utf-16be','UTF8','utf-8','windows-1252','bogus'].map(enc=>({enc,hex:'4100',ignore:false})),
  ...['utf16le','utf-16le'].flatMap(enc=>['41','00D8','00DC','00D84100','00D800D8'].flatMap(hex=>[false,true].map(ignore=>({enc,hex,ignore})))),
  ...['FFFF','FFFE41FF','E08080','EDA080','F4908080','EFBFBD','EFBBBF','F09F9880','C3A4'].flatMap(hex=>[false,true].map(ignore=>({enc:'utf8',hex,ignore}))),
  {enc:'utf16le',hex:'3DD800DEFFFE',ignore:false},
  {enc:'iso-8859-1',hex:'80818D8F909DFF',ignore:false},
];
const val=(k,v,len=0,dec=0)=>({k,v:String(v),len,dec});
const byte=(hex,k='X')=>val(k,hex,hex.length/2);
const pairs = [
  [byte('AB'),byte('AB00')], [byte('AB','y'),byte('AB00')], [byte('FF'),byte('FE')],
  [byte('10'),val('I',16)], [byte('FFFFFFFF'),val('I',-1)],
  [byte('0100000000'),val('P',0,8)], [byte('0000000010'),val('F',16)],
  [byte('0100000000000010'),val('8','72057594037927952')],
  [byte('FFFFFFFFFFFFFFFF'),val('8',-1)], [byte('010000000000000000'),val('8',0)],
  [byte('10','y'),val('N','00016',5)], [byte('FFFFFFFF'),val('N','99999999999999999999',20)],
  [byte('AB'),val('C','AB',2)], [byte('AB'),val('g','ab')],
  [byte('10'),val('D','00000000')], [byte('10'),val('T','000000')],
  [val('u',''),val('I',0)],
];
const dumpers=[val('D',''),val('T',''),val('N','',3),val('N','',0),val('N','001',3),val('D','20261010')];
const binary=hex=>Buffer.from(hex,'hex').toString('latin1');
function data(d) {
  const t={kind:d.k,len:d.len,dec:d.dec,comps:[]};
  const v=['X','y'].includes(d.k)?binary(d.v):d.k==='8'?BigInt(d.v):['I','F'].includes(d.k)?Number(d.v):d.v;
  return A.cell(v,t);
}
const outcome=fn=>{try{return String(fn());}catch(e){return e.message;}};
let oracle;
function go() {
  if (oracle) return oracle;
  const dir=mkdtempSync(join(tmpdir(),'irjs-parity-'));
  try {
    writeFileSync(join(dir,'cases.json'),JSON.stringify({decoders,pairs,dumpers}));
    writeFileSync(join(dir,'main.go'),`package main
import("encoding/json";"encoding/hex";"os";"fmt";"strconv";"osg/gogen/abap")
type V struct {K,V string; Len,Dec int}
type D struct {Enc,Hex string; Ignore bool}
func bytes(h string) string { b,_:=hex.DecodeString(h);return string(b) }
func data(v V) abap.Data {
 t:=&abap.Type{Kind:v.K[0],Len:v.Len}; s:=v.V
 switch v.K {case "X","y":s=bytes(s);case "P":t=abap.TP(v.Len,v.Dec);case "I":n,_:=strconv.ParseInt(s,10,32);x:=int32(n);return abap.Data{P:&x,T:abap.TI};case "8":x,_:=strconv.ParseInt(s,10,64);return abap.Data{P:&x,T:abap.TInt8};case "F":x,_:=strconv.ParseFloat(s,64);return abap.Data{P:&x,T:abap.TF}}
 return abap.Data{P:&s,T:t}
}
func caught(f func() string)(s string){defer func(){if r:=recover();r!=nil {if e,ok:=r.(abap.ArithmeticError);ok{s=e.Error()}else{panic(r)}}}();return f()}
func main(){b,_:=os.ReadFile(os.Args[1]);var cases struct{Decoders []D;Pairs [][2]V;Dumpers []V};if err:=json.Unmarshal(b,&cases);err!=nil{panic(err)}
 out:=map[string][]string{}
 for _,d:=range cases.Decoders {out["decode"]=append(out["decode"],caught(func()string{return abap.XToHex(abap.EncodeText("utf8",abap.DecodeText(d.Enc,d.Ignore,bytes(d.Hex))))}))}
 for _,p:=range cases.Pairs {for _,q:=range [][2]V{p,{p[1],p[0]}} {out["compare"]=append(out["compare"],caught(func()string{return fmt.Sprint(abap.CmpData(data(q[0]),data(q[1])))}))}}
 for _,d:=range cases.Dumpers {out["dump"]=append(out["dump"],abap.UnitDumpToString(nil,data(d)))}
 for _,s:=range []string{"😀",abap.UTF16String([]uint16{0xD800})} {for _,enc:=range []string{"utf8","utf16le"} {for _,n:=range []int32{-1,0,1,2,3} {out["encode"]=append(out["encode"],caught(func()string{return abap.XToHex(abap.EncodeText(enc,abap.SubS(s,0,n)))}))}}}
 var a,bref abap.Data; x:=int32(7);a=abap.Data{P:&x,T:abap.TI};bref=a;c:=int32(7);other:=abap.Data{P:&c,T:abap.TI};z:=abap.Data{}
 for _,p:=range [][2]abap.Data{{z,z},{a,bref},{a,other},{a,z}} {u,v:=p[0],p[1];out["refs"]=append(out["refs"],fmt.Sprint(abap.CmpData(abap.Data{P:&u,T:abap.TRef},abap.Data{P:&v,T:abap.TRef})))}
 json.NewEncoder(os.Stdout).Encode(out)
}`);
    oracle=JSON.parse(execFileSync('go',['run',join(dir,'main.go'),join(dir,'cases.json')],{cwd:resolve('tools/gogen/go'),encoding:'utf8',timeout:120000}));
    return oracle;
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('decoder whitelist, UTF-16 refusals and UTF-8 replacement match Go',()=>{
  assert.deepEqual(decoders.map(d=>outcome(()=>A.XToHex(Buffer.from(decodeText(d.enc,d.ignore,binary(d.hex)),'utf8').toString('latin1')))),go().decode);
});
test('output N uses UTF-16 units and UTF-8 preserves lone surrogates as Go WTF-8',()=>{
  const got=[];
  for(const text of ['😀','\ud800']) for(const enc of ['utf8','utf16le']) for(const n of [-1,0,1,2,3])
    got.push(outcome(()=>{const b={v:''};convertOut({},enc,text,n,b,'X');return A.XToHex(b.v);}));
  assert.deepEqual(got,go().encode);
  assert.throws(()=>convertOut({},'utf8','a',2,{v:''},'X'),/CX_SY_RANGE_OUT_OF_BOUNDS/);
});
test('generic byte pairs, numeric widths, text, NUMC and data-reference identity match Go',()=>{
  assert.deepEqual(pairs.flatMap(([a,b])=>[[a,b],[b,a]].map(([x,y])=>outcome(()=>A.CmpData(data(x),data(y))))),go().compare);
  const target=A.cell(7,A.TI), other=A.cell(7,A.TI);
  const root={};
  const first=A.RefBinding(A.cell(7,A.TI),root,['field']);
  const again=A.RefBinding(A.cell(7,A.TI),root,['field']);
  assert.equal(A.CmpData(A.cell(first,A.TRef),A.cell(again,A.TRef)),0);
  assert.equal(A.CmpData(A.cell(A.copy(first),A.TRef),A.cell(again,A.TRef)),0);
  assert.deepEqual([[null,null],[target,target],[target,other],[target,null]].map(([a,b])=>outcome(()=>A.CmpData(A.cell(a,A.TRef),A.cell(b,A.TRef)))),go().refs);
});
test('initial date/time/NUMC assertion dumps match Go',()=>{
  assert.deepEqual(dumpers.map(d=>A.UnitDumpToString({},data(d))),go().dump);
});

test('unit host distinguishes refusals in all phases and retains first-error precedence',async()=>{
  // Exercise the real runner with an in-memory compiled module and registry.
  const source=readFileSync('tools/gogen/unit-js.mjs','utf8').replace(/^import .*;\n/gm,'');
  for(const phase of ['CLASS_SETUP','SETUP','TEST','TEARDOWN','CLASS_TEARDOWN']) {
    for(const refusal of [false,true]) for(const teardownRefusal of phase === 'TEST' ? [undefined,false,true] : [undefined]) {
      const hooks=['CLASS_SETUP','SETUP','TEST','TEARDOWN','CLASS_TEARDOWN'];
      const moduleSource=`export class Z_LTCL_PROBE {static $new(){return new this()} ${hooks.map(h=>`${h.startsWith('CLASS_')?'static ':''}${h}(){${h===phase || h==='TEARDOWN' && teardownRefusal!==undefined ? `const e=new Error('${(h===phase?refusal:teardownRefusal)?'NOT_COMPILED in stub':'ordinary failure'}');e.cls='${(h===phase?refusal:teardownRefusal)?'NOT_COMPILED':'CX_SY_ZERODIVIDE'}';throw e;`:''}}`).join(' ')}}`;
      const def={isForTesting:true,name:'LTCL_PROBE',methods:[{isForTesting:true,name:'TEST'}]};
      const obj={getDefinition:()=>({getSuperClass:()=>undefined}),getABAPFiles:()=>[{getFilename:()=> 'z.clas.testclasses.abap',getInfo:()=>({listClassDefinitions:()=>[def]})}]};
      const program={classes:[{name:'Z:LTCL_PROBE',methods:hooks.map(name=>({name}))}],reg:{getObject:()=>obj},missing:[]};
      const url='data:text/javascript,'+encodeURIComponent(moduleSource);
      const script=source.replace("const moduleUrl = pathToFileURL(join(out, 'program.mjs')).href;",`const moduleUrl = ${JSON.stringify(url)};`).replace('await import(`${moduleUrl}?testclass=${encodeURIComponent(name)}`)','await import(moduleUrl)')+'\nreturn rows;';
      const env={process:{argv:['node','unit-js','--fixture','fake']},console:{log:()=>{}},mkdirSync:()=>{},readdirSync:()=>['z.clas.abap','z.clas.testclasses.abap'],writeFileSync:()=>{},resolve,join,pathToFileURL:()=>({href:''}),compileProgram:()=>program,emitJs:()=>'',referencedClasses:()=>[],libraryPath:()=>'',home:''};
      const fn=new (Object.getPrototypeOf(async function(){}).constructor)(...Object.keys(env),script);
      const rows=await fn(...Object.values(env));
      assert.equal(rows[0].status,refusal?'NOT_COMPILED':'FAILED',phase);
      assert.equal(env.process.exitCode,refusal?2:1,phase);
      if (phase === 'TEST') assert.equal(rows[0].message,refusal?'NOT_COMPILED in stub':'ordinary failure');
    }
  }
});


test('compiled runtime refusals have the same lifecycle status on Go and JS hosts', {timeout:120000}, () => {
  const dir=mkdtempSync(join(tmpdir(),'irjs-unit-parity-'));
  const fixture=join(dir,'input'); mkdirSync(fixture);
  writeFileSync(join(fixture,'zcl_irjs_refusal.clas.abap'),`CLASS zcl_irjs_refusal DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS.
CLASS zcl_irjs_refusal IMPLEMENTATION. ENDCLASS.`);
  const phases=['CLASS_SETUP','SETUP','TEST','TEARDOWN','CLASS_TEARDOWN'];
  const source=phases.map((phase,i)=>{
    const hook=phase==='TEST'?'probe':phase.toLowerCase();
    const definition=phase==='TEST'?'':`${phase.startsWith('CLASS_')?'CLASS-METHODS':'METHODS'} ${hook}.`;
    const body=`DATA refused TYPE i. refused = find( val = 'a' sub = 'a' occ = 0 ).`;
    return `CLASS ltcl_phase_${i} DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
PRIVATE SECTION.
${definition}
METHODS probe FOR TESTING.
ENDCLASS.
CLASS ltcl_phase_${i} IMPLEMENTATION.
METHOD probe. ${phase==='TEST'?body:''} ENDMETHOD.
${phase==='TEST'?'':`METHOD ${hook}. ${body} ENDMETHOD.`}
ENDCLASS.`;
  }).join('\n');
  writeFileSync(join(fixture,'zcl_irjs_refusal.clas.testclasses.abap'),source);
  try {
    const statuses={};
    for(const host of ['Go','JS']) {
      const out=join(dir,host);
      const run=spawnSync('node',['--max-old-space-size=16000',host==='Go'?'tools/gogen/unit.mjs':'tools/gogen/unit-js.mjs','--fixture',fixture,'--out',out,...(host==='Go'?['--jobs','1']:[])],{encoding:'utf8',timeout:55000,maxBuffer:2e6});
      assert.equal(run.status,2,run.stderr||run.stdout);
      const rows=host==='JS'?JSON.parse(readFileSync(join(out,'results.json'),'utf8')):JSON.parse(run.stdout.trim().split('\n').at(-1)).rows;
      statuses[host]=rows.map(r=>r.status);
      assert.deepEqual(statuses[host],phases.map(()=>'NOT_COMPILED'),run.stdout);
    }
    assert.deepEqual(statuses.JS,statuses.Go);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
