import {describe, it} from "mocha";
import assert from "node:assert/strict";
import {gzipSync} from "node:zlib";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parsePprof} from "../tools/hitlist/pprof.mjs";
import {parseV8} from "../tools/hitlist/v8.mjs";
import {abapSite, diff, hitlist, selectRows} from "../tools/hitlist/hitlist.mjs";
import {markdown} from "../tools/hitlist/markdown.mjs";
import {emitGo, funcName, typeName} from "../tools/gogen/emit-go.mjs";
import {run} from "../tools/osd-hitlist.mjs";

const vint = n => {
  let x = BigInt.asUintN(64, BigInt(n)); const b = [];
  do {b.push(Number(x & 127n) | (x > 127n ? 128 : 0)); x >>= 7n;} while (x);
  return Buffer.from(b);
};
const number = (f, n) => Buffer.concat([vint(f*8), vint(n)]);
const bytes = (f, b) => {b = Buffer.from(b);return Buffer.concat([vint(f*8+2), vint(b.length), b]);};
const packed = (f, ns) => bytes(f, Buffer.concat(ns.map(vint)));
const msg = (...bs) => Buffer.concat(bs);
function fixture(packedFields = true) {
  const strings = ["", "samples", "count", "cpu", "nanoseconds", "main.ZDEMO_RUN", "src/zdemo.clas.abap", "osg/gogen/abap.ParseI", "go/abap/convert.go", "method", "GET", "POST", "path", "/odata", "main.ZDEMO_CALLER"];
  const type = (name, unit) => bytes(1,msg(number(1,name),number(2,unit)));
  const fn = (id, name, file) => bytes(5,msg(number(1,id),number(2,name),number(4,file)));
  const loc = (id, fn, line, inline) => bytes(4,msg(number(1,id), bytes(4,msg(number(1,fn),number(2,line))), ...(inline ? [bytes(4,msg(number(1,inline[0]),number(2,inline[1])))] : [])));
  const label = (key,value) => bytes(3,msg(number(1,key),number(2,value)));
  const sample = (ids, values, method) => bytes(2,msg(
    ...(packedFields ? [packed(1,ids),packed(2,values)] : [...ids.map(n=>number(1,n)),...values.map(n=>number(2,n))]),
    label(9,method),label(12,13)));
  return msg(type(1,2),type(3,4),
    sample([1,3], [3,30],10), sample([2,3], [2,20],11), sample([4], [5,50],10),
    loc(1,2,10,[1,42]),loc(2,1,43),loc(3,3,50),loc(4,2,20),
    fn(1,5,6),fn(2,7,8),fn(3,14,6),...strings.map(s=>bytes(6,s)),number(10,2000000000));
}
const parsed = () => parsePprof(gzipSync(fixture()));

describe("native ABAP hit lists", () => {
  it("decodes receiver/interface methods, constructors and generated closures", () => {
    assert.equal(abapSite({name:"main.(*ZDEMO).IF_REQUEST__RUN.func1",file:"zdemo.clas.abap",line:42}).key,"ZDEMO=>IF_REQUEST~RUN:42");
    assert.equal(abapSite({name:"main.New_ZDEMO",file:"zdemo.clas.abap",line:42}).key,"ZDEMO=>CONSTRUCTOR:42");
    assert.equal(abapSite({name:"main.(*N_DEMO_CL).RUN",file:"#demo#cl.clas.abap",line:42}).key,"/DEMO/CL=>RUN:42");
  });
  it("roundtrips the emitter's owner, namespace, local and interface symbols", () => {
    for (const owner of ["ZDEMO", "/NS/CL_DEMO", "/MY_NS/CL_DEMO"]) {
      const file = `${owner.toLowerCase().replaceAll("/", "#")}.clas.locals_imp.abap`;
      for (const cls of [owner, `${owner}:LCL_HELPER`]) {
        for (const method of ["RUN", "DO_WORK", "INTF~METH", "/NS/INTF~DO_WORK", `${owner.startsWith("/") ? owner.slice(0, owner.lastIndexOf("/") + 1) : "/NS/"}INTF~METH`]) {
          for (const symbol of [funcName(cls, method), `(*${typeName(cls)}).${typeName(method)}`]) {
            const site = abapSite({name:`main.${symbol}.func1`, file, line:42});
            assert.equal(site.key, `${cls}=>${method}:42`, symbol);
          }
        }
        assert.equal(abapSite({name:`main.New_${typeName(cls)}`,file,line:42}).key,`${cls}=>CONSTRUCTOR:42`);
      }
    }
  });
  it("emits the same local static identity at its definition and call", () => {
    const cls = "ZDEMO:LCL_HELPER", method = "DO_WORK";
    const run = {name:"CALL_WORK",static:true,returning:null,params:[],locals:[],body:[{s:"call",call:{e:"call",owner:cls,method,args:[],type:{k:"void"}}}]};
    const body = {name:method,static:true,returning:null,params:[],locals:[],body:[]};
    const source = emitGo([{name:cls,methods:[run,body],attributes:[],constructor:null}]);
    assert.ok(source.includes(`func ${funcName(cls, method)}(s *abap.Session)`));
    assert.ok(source.includes(`; ${funcName(cls, method)}(s) }()`));
    assert.equal(abapSite({name:funcName(cls, method),file:"zdemo.clas.locals_imp.abap",line:42}).key,`${cls}=>${method}:42`);
  });
  it("looks up namespace/local names and method bodies without a class entry", () => {
    const frame = {name:`main.${funcName("/NS/CL_DEMO:LCL_HELPER", "INTF~METH")}`,file:"#ns#cl_demo.clas.locals_imp.abap",line:42};
    const profile = {format:"pprof",samples:[{frames:[frame],labels:{},weight:1,samples:1}]};
    for (const key of ["/ns/cl_demo:lcl_helper", "#ns#cl_demo:lcl_helper"]) {
      assert.equal(hitlist(profile,{names:{[key]:"src/demo.ts.Helper.run"}}).rows[0].ts.name,"Helper.run");
    }
    const method = "Z_METHOD_BODY";
    profile.samples[0].frames[0] = {...frame,name:`main.${funcName("/NS/CL_DEMO", method)}`};
    for (const names of [{z_method_body:"src/demo.ts.Demo.body"}, {"#ns#cl_demo":"src/class.ts.Demo",z_method_body:"src/demo.ts.Demo.body"}]) {
      assert.deepEqual(hitlist(profile,{names}).rows[0].ts,{name:"Demo.body",file:"src/demo.ts",line:null,siteId:null});
    }
  });
  it("matches cross-host diffs by decoded namespace/local/interface identity", () => {
    const cls = "/NS/CL_DEMO:LCL_HELPER", method = "/NS/INTF~DO_WORK";
    const file = "#ns#cl_demo.clas.locals_imp.abap";
    const profile = name => ({format:"pprof",samples:[{frames:[{name,file,line:42}],labels:{},weight:1,samples:1}]});
    const go = hitlist(profile(`main.${funcName(cls, method)}`),{host:"osgo"});
    const js = hitlist(profile(`${cls}=>${method}`),{host:"node"});
    const rows = diff(go,js).rows;
    assert.equal(rows.length,1);
    assert.equal(rows[0].key,`${cls}=>${method}:42`);
    assert.ok(rows[0].before && rows[0].after);
    assert.equal(rows[0].deltaFlatPercent,0);
  });
  it("parses compressed/uncompressed, packed/unpacked protobuf and inline frames", () => {
    assert.deepEqual(parsePprof(fixture(false)), parsed());
    const r = hitlist(parsed());
    assert.equal(r.metadata.durationSeconds,2);
    assert.equal(r.metadata.totalSamples,10);
    assert.equal(r.metadata.totalWeight,100);
    assert.equal(r.metadata.unattributedPercent,50);
    const line = r.rows.find(r=>r.line===42);
    assert.equal(line.key,"ZDEMO=>RUN:42");
    assert.equal(line.flatPercent,30);
    assert.equal(line.samples,3);
    assert.equal(line.topCallee.name,"osg/gogen/abap.ParseI");
    const caller = r.rows.find(r=>r.line===50);
    assert.equal(caller.flatPercent,0);
    assert.equal(caller.cumPercent,50);
    assert.equal(caller.cumSamples,5);
  });
  it("ANDs labels before aggregation and keeps runtime-only weight", () => {
    const r = hitlist(parsed(), {tags:["method=GET","path=/odata"]});
    assert.equal(r.metadata.totalWeight,80);
    assert.equal(r.rows[0].flatPercent,37.5);
    assert.equal(r.metadata.unattributedPercent,62.5);
    assert.equal(hitlist(parsed(),{tags:["method=missing"]}).rows.length,0);
    assert.throws(()=>hitlist(parsed(),{tags:["bad"]}),/key=value/);
  });
  it("deduplicates recursion and ranks native callees by sample count", () => {
    const f={name:"main.ZDEMO_RUN",file:"zdemo.clas.abap",line:42};
    const p={format:"pprof", samples:[
      {frames:[{name:"ParseI",file:"convert.go",line:1},f,f],weight:10,samples:5,labels:{}},
      {frames:[{name:"REPLACE",file:"strings.go",line:2},f],weight:30,samples:3,labels:{}},
    ]};
    const r=hitlist(p);
    assert.equal(r.rows[0].cumWeight,40);
    assert.equal(r.rows[0].flatWeight,40);
    assert.equal(r.rows[0].topCallee.name,"ParseI");
    assert.equal(r.rows[0].topCallee.samples,5);
  });
  it("maps actual abapiti names and exact counts without inventing TS lines or calls", () => {
    const r=hitlist(parsed(), {names:{zdemo:"src/file.ts.Demo.run"},counts:{"zdemo.clas.abap:42":500}});
    assert.deepEqual(r.rows[0].ts,{name:"Demo.run",file:"src/file.ts",line:null,siteId:null});
    assert.equal(r.rows[0].calls,500);
    assert.equal(r.rows.find(r=>r.line===43).calls,null);
    const byId=hitlist(parsed(),{names:{"ZDEMO=>RUN:42":{name:"Demo.run",file:"src/file.ts",line:10,siteId:"site-1"}},counts:{counts:{"site-1":{calls:42}}}});
    assert.equal(byId.rows[0].calls,42);
    assert.equal(byId.rows[0].ts.line,10);
    assert.throws(()=>hitlist(parsed(),{counts:{"zdemo.clas.abap:42":-1}}),/invalid exact/);
  });
  it("matches diffs by identity or shared site ID including additions/removals", () => {
    const a=hitlist(parsed()), b=hitlist(parsed(),{tags:["method=POST"]});
    const d=diff(a,b);
    assert.equal(d.rows.find(r=>r.key.endsWith(":43")).deltaFlatPercent,80);
    assert.equal(d.rows.find(r=>r.key.endsWith(":42")).deltaSamples,-3);
    const changed=structuredClone(a); changed.rows[0].key="ZOTHER=>RUN:99";
    a.rows[0].siteId=changed.rows[0].siteId="site-1";
    assert.equal(diff(a,changed).rows.length,a.rows.length);
    changed.metadata.metric.unit="microseconds";
    assert.equal(diff(a,changed).rows[0].deltaFlatWeight,null);
    assert.match(markdown(d),/Δ flat pp/);
  });
  it("parses V8 sample chains, zero-based lines, time weights and duration", () => {
    const p={startTime:0,endTime:1000,nodes:[
      {id:1,callFrame:{functionName:"ZDEMO_RUN",url:"zdemo.clas.abap",lineNumber:41},children:[2]},
      {id:2,callFrame:{functionName:"MOVE",url:"runtime.js",lineNumber:0}},
    ],samples:[2,1],timeDeltas:[100,300]};
    const r=hitlist(parseV8(p));
    assert.equal(r.metadata.durationSeconds,0.001);
    assert.equal(r.rows[0].key,"ZDEMO=>RUN:42");
    assert.equal(r.rows[0].samples,2);
    assert.equal(r.rows[0].flatWeight,400);
    assert.throws(()=>hitlist(parseV8(p),{tags:["method=GET"]}),/no pprof labels/);
    p.nodes[1].children=[1];
    assert.throws(()=>parseV8(p),/cycle/);
  });
  it("roundtrips CLI JSON, markdown, filters and JSON diff", () => {
    const dir=mkdtempSync(join(tmpdir(),"hitlist-"));
    try {
      const profile=join(dir,"cpu.pb.gz"), out=join(dir,"out.json");
      writeFileSync(profile,gzipSync(fixture()));
      assert.equal(run([profile,"--host","osgo","--commit","abc","--format","json","--out",out]),"");
      const r=JSON.parse(readFileSync(out));
      assert.equal(r.metadata.host,"osgo");
      assert.equal(r.metadata.commit,"abc");
      assert.match(run([profile,"--top","1"]),/ZDEMO=>RUN:42/);
      assert.equal(selectRows(r,{minFlat:25,top:1}).rows.length,1);
      assert.match(run(["--diff",out,out]),/\+0/);
      assert.equal(JSON.parse(run([profile,profile,"--format","json"])).kind,"diff");
      assert.throws(()=>run([profile,"--top=-1"]),/positive integer/);
      assert.throws(()=>run([out,"--tag","method=GET"]),/require raw profiles/);
      assert.throws(()=>run([profile,"--bogus"]));
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it("rejects malformed protobuf instead of silently generating a report", () => {
    for (const b of [Buffer.from([10,50,1]),Buffer.from([128]),Buffer.alloc(0),Buffer.from([0])]) assert.throws(()=>parsePprof(b));
  });
});
