import {writeGo} from "./symbols.mjs";
// Reproducible benchmarks over frontend-generated owned-memory methods.
// Run under osd-heavy; the positional output directory preserves generated Go.
import {cpSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {compileProgram} from './frontend.mjs';
const out = resolve(process.argv[2] ?? 'tools/gogen/.out/owned-bench');
const program = compileProgram({folders: [join(import.meta.dirname, 'testdata')], objects: ['ZCL_GOGEN_T_OWNEDBENCH']});
if (program.partial.length || program.broken.length) throw new Error(JSON.stringify(program.partial));
cpSync(join(import.meta.dirname, 'go'), out, {recursive: true});
mkdirSync(join(out, 'ownedbench'), {recursive: true});
writeGo(join(out, 'ownedbench/generated.go'), program, 'ownedbench', null, false, {}, 'osg/gogen/ownedbench');
writeFileSync(join(out, 'ownedbench/generated_test.go'), `package ownedbench
import ("testing"; "fmt"; "strings"; "osg/gogen/abap")
var result int32
func TestMemoryAllocs(t *testing.T) {
 s := &abap.Session{}; me := &ZCL_GOGEN_T_OWNEDBENCH{}
 me.INIT(s, strings.Repeat("\\x01", 16*65536))
 for index, run := range []func(*abap.Session) int32{me.W1,me.W2,me.W3} {
  if n:=testing.AllocsPerRun(5, func(){result=run(s)}); n!=0 {t.Fatalf("allocs: %g", n)}
  if result != []int32{1,16843009,16843009}[index] {t.Fatal(result)}
 }
}
func BenchmarkMemory(b *testing.B) {
 for _, pages := range []int{1,4,16} {
  for _, width := range []int{1,4,8} {
   b.Run(fmt.Sprintf("W%d/%dpages", map[int]int{1:1,4:2,8:3}[width], pages), func(b *testing.B) {
    s := &abap.Session{}
    me := &ZCL_GOGEN_T_OWNEDBENCH{}
    me.INIT(s, strings.Repeat("\\x01", pages*65536))
    run := me.W1; if width==4 {run=me.W2}; if width==8 {run=me.W3}
    b.ReportAllocs(); b.ResetTimer()
    for i:=0; i<b.N; i++ {result=run(s)}
   })
  }
 }
}
`);
console.log(out);
