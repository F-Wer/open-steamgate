#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Exercise an already-built OSGo binary; captures remain in ignored scratch.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {parseArgs} from "node:util";
import {readProfile} from "../osd-hitlist.mjs";
import {hitlist, diff, selectRows} from "./hitlist.mjs";
import {markdown} from "./markdown.mjs";

const {values: v} = parseArgs({options: {
  osgo: {type:"string",default:"tools/gogen/.out/osgo"}, out: {type:"string",default:".local/hitlist"},
  seconds:{type:"string",default:"3"}, commit:{type:"string"},
  path:{type:"string",default:"/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$top=10"},
}});
const seconds=Number(v.seconds), port=Number(process.env.STG_PORT);
if (!Number.isInteger(seconds) || seconds<1 || seconds>60) throw new Error("--seconds must be from 1 to 60");
if (!Number.isInteger(port) || port<1 || port>65535) throw new Error("run with STG_PORT, preferably under tools/osd-heavy.sh");
const out=resolve(v.out);mkdirSync(out,{recursive:true});
const env={...process.env,OSD_PPROF:"0",OSGO_PPROF:""};
const start = args => {
  const child=spawn(resolve(v.osgo),["-port",String(port),"-root",process.cwd(),...args],{env,stdio:["ignore","ignore","pipe"]});
  let log="";child.stderr.on("data",b=>log+=b);
  return {child, log:()=>log, stop:async()=>{
    if(child.exitCode!==null || child.signalCode!==null)return;
    const exited=new Promise(r=>child.once("exit",r));child.kill();await exited;
  }};
};
const origin=`http://127.0.0.1:${port}`;
async function ready(host) {
  for(let i=0;i<600;i++) {
    if(host.child.exitCode!==null)throw new Error(host.log());
    try {const r=await fetch(origin+"/health");if(r.ok)return await r.json();}catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error("OSGo readiness timeout: "+host.log());
}

const disabled=start(["-addr","0.0.0.0"]);
try {
  await ready(disabled);
  assert.equal((await fetch(origin+"/debug/pprof/")).status,404);
  assert.doesNotMatch(disabled.log(),/pprof: http/);
} finally {await disabled.stop();writeFileSync(join(out,"disabled.log"),disabled.log());}

const enabled=start(["-addr","0.0.0.0","-pprof","-pprof-addr","127.0.0.1:0"]);
try {
  const health=await ready(enabled);
  const profiler=/pprof: (http:\/\/127\.0\.0\.1:\d+)\/debug/.exec(enabled.log())?.[1];
  assert.ok(profiler,"separate loopback profiler logged");
  for(const path of ["", "profile", "heap"]) assert.equal((await fetch(origin+"/debug/pprof/"+path)).status,404);
  assert.equal((await fetch(profiler+"/debug/pprof/")).status,200);
  const reports=[];
  for(const name of ["before","after"]) {
    const capture=fetch(`${profiler}/debug/pprof/profile?seconds=${seconds}`);
    let running=true, requests=0;
    const pump=async()=>{
      while(running){const r=await fetch(origin+v.path);const body=await r.text();assert.equal(r.status,200,body);requests++;}
    };
    const pumps=[pump(),pump()];
    // Attach rejection handlers immediately, including on a failing workload.
    const pumped=Promise.allSettled(pumps);
    let response;
    try {response=await capture;assert.equal(response.status,200);writeFileSync(join(out,`${name}.pb.gz`),Buffer.from(await response.arrayBuffer()));}
    finally {running=false;}
    for(const r of await pumped) if(r.status==="rejected")throw r.reason;
    const p=readProfile(join(out,`${name}.pb.gz`));
    const metadata={host:"osgo",commit:v.commit ?? health.commit};
    const report=hitlist(p,metadata);
    assert.ok(report.rows.length,"profile must contain ABAP frames");
    reports.push(report);
    writeFileSync(join(out,`${name}.json`),JSON.stringify(report,null,2)+"\n");
    writeFileSync(join(out,`${name}.md`),markdown(selectRows(report,{top:10})));
    const filtered=hitlist(p,{...metadata,tags:["method=GET",`path=${new URL(v.path,origin).pathname}`]});
    assert.ok(filtered.rows.length,"request labels must survive CPU capture");
    assert.ok(filtered.metadata.totalWeight<=report.metadata.totalWeight);
    writeFileSync(join(out,`${name}-filtered.json`),JSON.stringify(filtered,null,2)+"\n");
    writeFileSync(join(out,`${name}-filtered.md`),markdown(selectRows(filtered,{top:10})));
    console.log(`${name}: ${requests} requests, ${report.metadata.totalSamples} samples, ${filtered.metadata.totalSamples} selected with method/path tags`);
  }
  const delta=diff(...reports);
  writeFileSync(join(out,"diff.json"),JSON.stringify(delta,null,2)+"\n");
  writeFileSync(join(out,"diff.md"),markdown(selectRows(delta,{top:10})));
  console.log(`generated OSGo: disabled pprof absent, wildcard app pprof=404, separate loopback pprof=200; artifacts ${out}`);
} finally {await enabled.stop();writeFileSync(join(out,"enabled.log"),enabled.log());}
