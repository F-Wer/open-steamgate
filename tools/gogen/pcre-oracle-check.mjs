// Compare both runtime adapters against the same real PCRE2 table and baseline.
// Usage: node tools/gogen/pcre-oracle-check.mjs /path/to/origin-main-export
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(new URL('../..', import.meta.url).pathname);
const table = JSON.parse(readFileSync(join(root,'tools/gogen/pcre-class-oracle.json')));
const cases = table.rows.flatMap(row => table.inputs.map((subject,i) => ({...row, subject, expected: row.spans?.[i]})));
const scratch = mkdtempSync(join(tmpdir(),'pcre-oracle-'));
const source = `package main
import ("encoding/json"; "os"; "osg/gogen/abap")
type Case struct {Pattern, Subject string; Icase bool}
type Answer struct {Spans [][]int32; Text string; RC int32; Refused bool}
func run(c Case) (a Answer) {
 defer func(){ if recover()!=nil { a.Refused=true } }()
 a.Spans=abap.FindResults(c.Subject,c.Pattern,'P',c.Icase,true)
 a.Text,a.RC=abap.ReplaceStmt(c.Subject,c.Pattern,"X",true,true,c.Icase,0,abap.NoLength,-1,true)
 return
}
func main(){ var cases []Case; json.NewDecoder(os.Stdin).Decode(&cases); out:=[]Answer{}; for _,c:=range cases {out=append(out,run(c))}; json.NewEncoder(os.Stdout).Encode(out) }
`;
writeFileSync(join(scratch,'main.go'),source);
async function hosts(dir) {
  const a = await import(pathToFileURL(join(dir,'tools/gogen/js/abap.mjs')));
  const js = cases.map(c => {
    try {
      const Spans = a.FindResults(c.subject,c.pattern,'P',c.icase,true);
      const [Text,RC] = a.ReplaceStmt(c.subject,c.pattern,'X',true,true,c.icase,0,a.NoLength,-1,true);
      return {Spans,Text,RC};
    } catch { return {Refused:true}; }
  });
  const go = JSON.parse(execFileSync('go',['run',join(scratch,'main.go')], {
    cwd:join(dir,'tools/gogen/go'),env:{...process.env,GOCACHE:process.env.GOCACHE ?? join(scratch,'cache')},input:JSON.stringify(cases),maxBuffer:20e6,encoding:'utf8',
  }));
  return {js,go};
}
function agrees(a,c) {
  if (c.matches === null) return !!a.Refused;
  if (a.Refused) return false;
  const spans = a.Spans ?? [];
  const text = c.expected.reduceRight((s,r) => s.slice(0,r[0])+'X'+s.slice(r[0]+r[1]),c.subject);
  return JSON.stringify(spans)===JSON.stringify(c.expected) && a.Text===text && a.RC===(spans.length ? 0 : 4);
}
try {
  const branch = await hosts(root), main = await hosts(resolve(process.argv[2]));
  let regressions=0, mismatches=0;
  for (const host of ['go','js']) {
    let baselineMatches=0;
    for (const [i,c] of cases.entries()) {
      const before=agrees(main[host][i],c), after=agrees(branch[host][i],c);
      if (before) baselineMatches++;
      if (before && !after) { console.error('REGRESSION',host,c.pattern,c.icase,JSON.stringify(c.subject)); regressions++; }
      if (c.supported && !after) { console.error('MISMATCH',host,c.pattern,c.icase,JSON.stringify(c.subject)); mismatches++; }
      if (!c.supported) assert.ok(branch[host][i].Refused,'unsupported reference must refuse');
    }
    console.log(host+': baseline agrees '+baselineMatches+'/'+cases.length+' cases');
  }
  console.log(table.rows.length/2+' patterns x '+table.inputs.length+' inputs x 2 case modes; main-vs-branch regressions: '+regressions+'; supported mismatches: '+mismatches);
  assert.equal(regressions,0); assert.equal(mismatches,0);
} finally { rmSync(scratch,{recursive:true,force:true}); }
