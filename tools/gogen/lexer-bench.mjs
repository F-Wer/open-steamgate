// Measure only the lexer portion of the supplied phase-3 benchmark.
// node tools/gogen/lexer-bench.mjs --fixture <closure> --out <scratch>
// The input stays read-only. Each sample runs in a fresh process.
import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {compileProgram} from './frontend.mjs';
import {emitJs} from './emit-js.mjs';
import {emitGo,referencedClasses} from './emit-go.mjs';
import {libraryPath} from '../osd-lib-path.mjs';
import {home} from './home.mjs';

const args=process.argv.slice(2);
const value=flag=>args[args.indexOf(flag)+1];
if (args.includes('--execute')) {
  const m=await import(pathToFileURL(resolve(value('--execute'))).href);
  const report={v:''}, s={sy:{index:0,tabix:0,subrc:0,dbcnt:0}};
  const ok=m.ZCL_PHASE3_BENCHMARK.RUN(s,'',report);
  console.log(ok,report.v);
  if(ok!=='X') process.exitCode=1;
} else {
  if(!args.includes('--fixture')) throw new Error('--fixture is required');
  const input=resolve(value('--fixture'));
  const out=resolve(args.includes('--out')?value('--out'):join(home,'tools/gogen/.out/lexer-bench'));
  mkdirSync(out,{recursive:true});
  let source=readFileSync(join(input,'zcl_phase3_benchmark.clas.abap'),'utf8');
  const start=source.indexOf('GET RUN TIME FIELD start.',source.indexOf('tokens = lexed->'));
  const end=source.indexOf('ENDMETHOD.',start);
  const dump=/CALL METHOD [^\n]+EXPORTING [^\n]+ = lexed RECEIVING result = dump\./.exec(source)?.[0];
  const expected=/AND lexer_hash = (`[a-f0-9]{64}`)/.exec(source)?.[1];
  const count=/IF tokens = (\d+)/.exec(source)?.[1];
  if(start<0||end<start||!dump||!expected||!count) throw new Error('unrecognized phase-3 benchmark layout');
  source=source.slice(0,start)+`${dump}
cl_abap_message_digest=>calculate_hash_for_char( EXPORTING if_algorithm = \`SHA256\` if_data = dump IMPORTING ef_hashstring = lexer_hash ).
lexer_hash = to_lower( lexer_hash ).
IF tokens = ${count} AND lexer_hash = ${expected}.
ok = abap_true.
ENDIF.
report = |tokens { tokens } lex_us { lex_us } lexer_hash { lexer_hash }|.
`+source.slice(end);
  const overlay=join(out,'zcl_phase3_benchmark.clas.abap');
  writeFileSync(overlay,source);
  const wanted=new Set(readdirSync(input).filter(f=>/\.(clas|intf)\.abap$/.test(f)).map(f=>f.split('.')[0].replaceAll('#','/').toUpperCase()));
  for(const n of ['CL_HTTP_UTILITY','CL_ABAP_MESSAGE_DIGEST','CX_ROOT']) wanted.add(n);
  let program,registry; const session={};
  for(let round=0;round<12;round++) {
    program=compileProgram({folders:[input,join(libraryPath(home,'open-abap-core'),'src'),out],objects:[...wanted],
      skip:p=>/\.testclasses\.abap$/.test(p)||p===join(input,'zcl_phase3_benchmark.clas.abap'),tolerant:true,registry,session});
    registry=program.reg;
    const supers=[...wanted].map(n=>registry.getObject('CLAS',n)?.getDefinition()?.getSuperClass()).filter(Boolean).map(n=>n.toUpperCase());
    const more=[...referencedClasses(program),...program.missing,...supers].filter(n=>!wanted.has(n)&&!n.includes(':')&&(registry.getObject('CLAS',n)||registry.getObject('INTF',n)));
    if(!more.length) break;
    more.forEach(n=>wanted.add(n));
    if(round===11) throw new Error('closure did not settle');
  }
  writeFileSync(join(out,'diagnostics.json'),JSON.stringify({partial:program.partial,skipped:program.skipped,broken:program.broken},null,2));
  writeFileSync(join(out,'program.mjs'),emitJs(program,pathToFileURL(join(home,'tools/gogen/js/abap.mjs')).href));
  const dir=join(out,'go'); cpSync(join(home,'tools/gogen/go'),dir,{recursive:true});
  mkdirSync(join(dir,'cmd/lexbench'),{recursive:true});
  writeFileSync(join(dir,'cmd/lexbench/program.go'),emitGo(program));
  writeFileSync(join(dir,'cmd/lexbench/main.go'),`package main
import("fmt";"os";"osg/gogen/abap")
func main(){s:=&abap.Session{};var report string;ok:=ZCL_PHASE3_BENCHMARK_RUN(s,"",&report);fmt.Println(ok,report);if ok!="X" {os.Exit(1)}}
`);
  execFileSync('go',['build','-o',join(out,'lexbench'),'./cmd/lexbench'],{cwd:dir,stdio:'inherit'});
  const samples={JS:[],Go:[]};
  for(const host of ['JS','Go']) for(let i=0;i<3;i++) {
    const argv=host==='JS'?['--max-old-space-size=16000',fileURLToPath(import.meta.url),'--execute',join(out,'program.mjs')]:[];
    const text=execFileSync(host==='JS'?'node':join(out,'lexbench'),argv,{encoding:'utf8',maxBuffer:2e6});
    const lexUs=Number(/lex_us\s+(\d+)/.exec(text)?.[1]);
    if(!Number.isFinite(lexUs)||!/X tokens/.test(text)) throw new Error(`invalid sample: ${text}`);
    samples[host].push({lexUs,report:text.trim()});
    console.log(host,i+1,text.trim());
  }
  writeFileSync(join(out,'results.json'),JSON.stringify(samples,null,2));
}
