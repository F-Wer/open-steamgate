import {expect} from 'chai';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync} from 'node:fs';
import * as abaplintCore from '@abaplint/core';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {compileSet, renderSet} from '../tools/dsl-l3.mjs';
import {dialogStep} from '../tools/osd-dialog-step.mjs';
import {daemonHost} from '../tools/osd-daemon-host.mjs';
import {BatchRuns, workQueuedBatch} from '../tools/osd-batch-runs.mjs';
import {drainJobOutbox} from '../tools/osd-job-outbox.mjs';
import {manualClock, installAbapClock} from '../tools/osd-job-scheduler.mjs';
const SET = 'src/l2demo/fleet2.l3.yaml';
const tables = ['pile','stage','work','run','doctor','kill','conf','conf_log','run_conf','budget','event','object','alert','runstat','watch'].map((s) => `zosd_l3_${s}`);
describe('DSL L3 5e: autonomous doctor', function () {
  this.timeout(900000);
  let abap, dir, native, store, clock, restore, client, env, prior, priorContext, classes;
  const cls = () => abap.Classes.ZCL_L3_FLEET2;
  const str = (s) => new abap.types.String().set(s);
  const sql = async (s) => client.execute(s);
  const read = (s, ...args) => native.prepare(s).all(...args);
  async function abandonJobs() {
    // Every preceding invocation has joined its worker; discard only this test fixture's abandoned jobs.
    await sql('DELETE FROM zosd_job_step');
    await sql('DELETE FROM zosd_job_outbox');
    store.db.prepare("UPDATE batch_runs SET state='FAILED' WHERE state IN ('QUEUED','RUNNING','WAITING')").run();
  }
  // probe: called after every job and every drain (the lane oracle samples there)
  let probe = null;
  async function work(limit = 1000) {
    await daemonHost(abap).idle();
    await drainJobOutbox(store);
    probe?.();
    for (let i=0; i<limit; i++) {
      const outcome = await workQueuedBatch(process.cwd(), store);
      await daemonHost(abap).idle();
      const drained = await drainJobOutbox(store);
      probe?.();
      if (!['completed','failed','step','running'].includes(outcome.kind) && !drained.imported) break;
    }
  }
  async function initialPassFirst() {
    await daemonHost(abap).idle();await drainJobOutbox(store);
    store.db.prepare("UPDATE batch_runs SET queued_at='2000-01-01T00:00:00Z' WHERE state='QUEUED' AND program='ZL3_FLEET2_DOC'").run();
    await work(1);
  }
  // fleet2 releases by event: a pile job waits on ZOSD_L3_RELEASE until the first pass releases it
  async function releasedPile() {
    await run();await initialPassFirst();await drainJobOutbox(store);
  }
  // one release pass as a job report makes it: the claims in one step (committed), the raises in the next
  async function release() {
    const claimed=await dialogStep(()=>cls().release_claim());
    await dialogStep(()=>cls().release_raise({it_claimed:claimed}));
  }
  const run = (day='20261001', bind='') => dialogStep(() => cls().run({iv_date: new abap.types.Date().set(day), iv_mode: str('P'), iv_bind: str(bind)}));
  async function mutant(name, className, edit, check) {
    const original=abap.Classes[className.toUpperCase()];
    const source=readFileSync(`output/${className}.clas.mjs`,'utf8');
    const changed=edit(source);
    expect(changed,`${name} changes executable code`).not.to.equal(source);
    const folder=join(dir,name);await (await import('node:fs/promises')).mkdir(folder,{recursive:true});
    const outputUrl=pathToFileURL(join(process.cwd(),'output')+'/').href;
    const copy=changed.replace(/(?:from |import\()(["'])\.\/([^"']+)\1/g,(m,q,file)=>m.replace(`${q}./${file}${q}`,`${q}${outputUrl}${file}${q}`));
    const file=join(folder,`${className}.clas.mjs`);writeFileSync(file,copy);
    await import(pathToFileURL(file).href);
    try {await check();} finally {await daemonHost(abap).close();abap.Classes[className.toUpperCase()]=original;}
  }
  before(async () => {
    await import('./start.mjs');
    // the suite re-initializes the runtime on its own file database; the next suite in the same
    // process gets the context, connections and classes it had (as dsl-l3-harden does)
    prior = globalThis.abap;
    priorContext = {...prior.context, databaseConnections: {...prior.context.databaseConnections}, RFCDestinations: {...prior.context.RFCDestinations}};
    dir = mkdtempSync(join(tmpdir(), 'l3-autodoctor-'));
    env = Object.fromEntries(['STG_DB','STG_DB_PATH','OSD_OPERATIONS_DB'].map((k)=>[k, process.env[k]]));
    process.env.STG_DB='file'; process.env.STG_DB_PATH=join(dir,'business.sqlite'); process.env.OSD_OPERATIONS_DB=join(dir,'operations.sqlite');
    await (await import('../output/init.mjs')).initializeABAP();
    abap=globalThis.abap; client=abap.context.databaseConnections.DEFAULT; classes={...abap.Classes};
    native = new DatabaseSync(process.env.STG_DB_PATH);
    store=new BatchRuns(process.cwd(),process.env);
    clock=manualClock('2026-10-01T00:00:00Z');restore=installAbapClock(abap,clock);
  });
  beforeEach(async () => {
    await daemonHost(abap).close();
    clock.set(Date.parse('2026-10-01T00:00:00Z'));
    await abandonJobs();
    for (const table of tables) await sql(`DELETE FROM ${table}`);
    for (const table of ['ship','voy','crew','cargo']) await sql(`DELETE FROM zosd_l2_${table}`);
    await sql("INSERT INTO zosd_l2_ship (mandt,ship_id,name,status) VALUES ('123','S001','Ship','A')");
    await sql("INSERT INTO zosd_l2_voy (mandt,voyage_id,ship_id,dep_date) VALUES ('123','V00001','S001','20261005')");
  });
  after(async () => {
    if (abap) await daemonHost(abap).close();
    restore?.();store?.close();native?.close();await client?.disconnect();
    if (abap && classes) { for (const key of Object.keys(abap.Classes)) if (!(key in classes)) delete abap.Classes[key]; Object.assign(abap.Classes, classes); }
    if (prior) { Object.assign(prior.context, priorContext); globalThis.abap = prior; }
    for (const [k,v] of Object.entries(env ?? {})) if (v===undefined) delete process.env[k];else process.env[k]=v;
    if(dir)rmSync(dir,{recursive:true,force:true});
  });
  it('mode P starts one daemon per set; messages advance the gate; final run stops it with audit', async () => {
    await run(); await run('20261002');
    expect(daemonHost(abap).instances.size).to.equal(1);
    await initialPassFirst();
    await work();
    expect(read("SELECT status FROM zosd_l3_stage WHERE stage_no=2").map(r=>r.status.trim())).to.deep.equal(['DONE','DONE']);
    expect(read("SELECT status FROM zosd_l3_run").map(r=>r.status.trim())).to.deep.equal(['RELEASED','RELEASED']);
    await clock.advance(10000); await daemonHost(abap).idle();
    expect(daemonHost(abap).instances.size).to.equal(0);
    expect(read("SELECT * FROM zosd_l3_doctor WHERE doc_action='DMN-STOP'")).to.have.length(1);
    expect(daemonHost(abap).errors.map(e=>String(e))).to.deep.equal([]);
  });
  it('aborted jobs heal on tick before stale; manual race audits once', async () => {
    const original=abap.Classes.ZCL_L2_SHIP_BUSY.keys;
    abap.Classes.ZCL_L2_SHIP_BUSY.keys=async()=>{throw new Error('simulated dump');};
    try { await run();await initialPassFirst();await work(); } finally { abap.Classes.ZCL_L2_SHIP_BUSY.keys=original; }
    expect(read("SELECT * FROM zosd_l3_doctor WHERE doc_action='FAILED'")).to.have.length(0);
    await clock.advance(10000);
    await Promise.all([work(),dialogStep(()=>cls().doctor({})),dialogStep(()=>cls().doctor({}))]);
    const failed=read("SELECT * FROM zosd_l3_doctor WHERE doc_action='FAILED'");
    expect(failed).to.have.length(1);
    await Promise.all([dialogStep(()=>cls().doctor({})),dialogStep(()=>cls().doctor({}))]);
    expect(read("SELECT * FROM zosd_l3_doctor WHERE doc_action='FAILED'")).to.have.length(1);
    await clock.advance(60000); await work();
    expect(read("SELECT status FROM zosd_l3_stage WHERE stage_no=2")[0].status.trim()).to.equal('DONE');
  });
  // A twin run over `ships` ships with piles.lanes = `lanes` on a host of eight background processes
  // (computed: 3/4 of 8 = 6 > lanes, so the set cap is what binds). After every job and every drain the
  // probe counts the pile jobs released and not ended: queued or running in the batch store (retries
  // are jobs of their own, so they count), and RUNNING or EVENT-SENT in the pile table.
  async function cappedRun(ships, lanes) {
    const workers=process.env.OSD_BG_WORKERS;process.env.OSD_BG_WORKERS='8';
    const peak={jobs:0,piles:0};
    probe=()=> {
      const jobs=store.db.prepare("SELECT count(*) n FROM batch_runs WHERE job_name GLOB 'L3_FLEET2_[0-9]*' AND state IN ('QUEUED','RUNNING')").get().n;
      const piles=read("SELECT count(*) n FROM zosd_l3_pile WHERE status='RUNNING' OR (status='PLANNED' AND reason='EVENT-SENT')")[0].n;
      peak.jobs=Math.max(peak.jobs,jobs);peak.piles=Math.max(peak.piles,piles);
    };
    try {
    for (const [name,value] of [['budget.glass','100000'],['retry.max','99'],['retry.backoff','0'],['simulate.time_scale','0'],['piles.lanes',String(lanes)]]) {
      const ok = await dialogStep(()=>cls().set_setting({iv_param:str(name),iv_value:str(value),iv_note:str('test policy')}));
      expect(ok.get(),name).to.equal('X');
    }
    await dialogStep(async()=> {
      await sql('DELETE FROM zosd_l2_ship');await sql('DELETE FROM zosd_l2_voy');
      for(let i=0;i<ships;i++) {
        const ship=`S${String(i).padStart(3,'0')}`;
        await sql(`INSERT INTO zosd_l2_ship (mandt,ship_id,name,status) VALUES ('123','${ship}','Ship','A')`);
        await sql(`INSERT INTO zosd_l2_voy (mandt,voyage_id,ship_id,dep_date) VALUES ('123','V${String(i).padStart(5,'0')}','${ship}','20261005')`);
      }
    });
    await run('20261001','work=sim');
    await work();
    for(let i=0;i<20 && read("SELECT * FROM zosd_l3_run WHERE status='HELD'").length;i++) {await clock.advance(10000);await work();}
    } finally {probe=null;if(workers===undefined)delete process.env.OSD_BG_WORKERS;else process.env.OSD_BG_WORKERS=workers;}
    return peak;
  }
  it('the 100-pile twin reaches stage 2 and completes without manual doctor or resume, never more than 3 piles released at once', async () => {
    const peak=await cappedRun(200,3);
    expect(read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')).to.have.length(100);
    expect(peak).to.deep.equal({jobs:3,piles:3});
    expect(read('SELECT * FROM zosd_l3_pile WHERE attempt>1').length,'retries ran').to.be.greaterThan(0);
    expect(read("SELECT status FROM zosd_l3_stage WHERE stage_no=2")[0].status.trim()).to.equal('DONE');
    expect(read("SELECT * FROM zosd_l3_run WHERE status='HELD'")).to.have.length(0);
    expect(read("SELECT * FROM zosd_l3_doctor WHERE stage_no=1 AND doc_action='FAILED'").length).to.be.greaterThan(20);
  });
  it('daemon jobs keep run-scoped chaos overrides after live settings change', async () => {
    const tune = async (name,value) => {
      expect((await dialogStep(() => cls().set_setting({iv_param:str(name),iv_value:str(value),iv_note:str('chaos snapshot')}))).get()).to.equal('X');
    };
    for (const [name,value] of [['budget.glass','100000'],['retry.max','0'],['simulate.time_scale','0'],
      ['simulate.dump','0'],['simulate.hang','0'],['simulate.slow','0']]) await tune(name,value);
    const first = (await run('20261001','work=sim')).get().run_id.get().trim();
    await tune('simulate.dump','1000');
    await work();
    expect(read('SELECT status FROM zosd_l3_pile WHERE run_id=?',first).map(p=>p.status.trim())).to.satisfy(rows=>rows.length>0 && rows.every(s=>s==='DONE'));
    expect(read("SELECT param_val FROM zosd_l3_run_conf WHERE run_id=? AND param_name='simulate.dump'",first)[0].param_val.trim()).to.equal('0');
    const second = (await run('20261002','work=sim')).get().run_id.get().trim();
    await work();await clock.advance(10000);await work();
    expect(read('SELECT status,attempt FROM zosd_l3_pile WHERE run_id=? AND stage_no=1',second).map(p=>[p.status.trim(),p.attempt])).to.deep.equal([['FAILED',1]]);
    expect(read("SELECT param_val FROM zosd_l3_run_conf WHERE run_id=? AND param_name='simulate.dump'",second)[0].param_val.trim()).to.equal('1000');
    expect(daemonHost(abap).errors.map(e=>String(e))).to.deep.equal([]);
  });
  it('a silent live job stays running before stale and is failed after stale', async () => {
    await releasedPile();
    const pile=read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0];
    const claimed=store.claimNext();
    expect(claimed.run.jobName).to.equal(pile.job_name.trim());
    await dialogStep(()=>sql("UPDATE zosd_l3_pile SET status='RUNNING', started='20261001000000' WHERE stage_no=1"));
    await dialogStep(()=>cls().doctor({}));
    expect(read('SELECT status FROM zosd_l3_pile WHERE stage_no=1')[0].status.trim()).to.equal('RUNNING');
    clock.set(Date.parse('2026-10-01T00:16:00Z'));
    await dialogStep(()=>cls().doctor({}));
    expect(read('SELECT status FROM zosd_l3_pile WHERE stage_no=1')[0].status.trim()).to.equal('FAILED');
    expect(read("SELECT * FROM zosd_l3_doctor WHERE reason='JOB-SILENT' AND doc_action='FAILED'")).to.have.length(1);
    expect(store.get(claimed.run.id).state).to.equal('INTERRUPTED');
    expect(read("SELECT * FROM zosd_l3_doctor WHERE doc_action='JOB-ABORT'")).to.have.length(1);
    // Save the old attempt's snapshot, then let the retry claim its row.
    await clock.advance(60000);
    await dialogStep(()=>cls().doctor({}));
    await dialogStep(()=>sql("UPDATE zosd_l3_pile SET status='RUNNING' WHERE stage_no=1"));
    const retry=read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0];
    expect(retry.attempt).to.equal(pile.attempt+1);
    expect(retry.job_count).not.to.equal(pile.job_count);
    // Even a late tail called with the complete old row cannot overwrite the retry.
    const row = new abap.types.Structure(Object.fromEntries(Object.entries(retry).map(([key,value])=>
      [key, typeof value==='number' ? (Math.abs(value) <= 2147483647 ? new abap.types.Integer().set(value) : new abap.types.Packed({length: 16, decimals: 0}).set(value)) : new abap.types.String().set(String(value ?? ''))])));
    row.get().attempt.set(pile.attempt);row.get().job_name.set(pile.job_name);row.get().job_count.set(pile.job_count);
    row.get().status.set('DONE');
    await dialogStep(()=>cls().save_pile({is_pile:row,iv_owned:str('X')}));
    expect(read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0]).to.deep.equal(retry);
  });
  async function lateAttempt(checkRule = false) {
    await run();await daemonHost(abap).idle();
    await daemonHost(abap).close();
    if (checkRule) await work();
    const pile=read(`SELECT * FROM zosd_l3_pile WHERE stage_no=${checkRule?2:1}`)[0];
    await dialogStep(async()=> {
      await sql("UPDATE zosd_l3_run SET status='HELD'");
      await sql("UPDATE zosd_l3_budget SET state='RUNNING'");
      await sql(`UPDATE zosd_l3_pile SET status='PLANNED' WHERE run_id='${pile.run_id}' AND rule_name='${pile.rule_name}' AND pile_no=${pile.pile_no}`);
    });
    const beforeWork=read('SELECT * FROM zosd_l3_work'), beforeAlerts=read('SELECT * FROM zosd_l3_alert');
    const l2=abap.Classes[checkRule?'ZCL_L2_MAINTENANCE_SHIP':'ZCL_L2_SHIP_BUSY'];
    const method=checkRule?'check':'keys', original=l2[method];
    l2[method]=async(input)=> {
      const result=await original.call(l2,input);
      await sql(`UPDATE zosd_l3_pile SET attempt=attempt+1, job_count='99999999', status='RUNNING' WHERE run_id='${pile.run_id}' AND rule_name='${pile.rule_name}' AND pile_no=${pile.pile_no}`);
      return result;
    };
    let answer, sinkWrites=0;
    const sink=abap.Classes.ZCL_L3_FLEET2_ALERTS_LOG.prototype, put=sink.zif_l3_fleet2_alerts$put;
    sink.zif_l3_fleet2_alerts$put=async function(input){sinkWrites++;return put.call(this,input);};
    try { answer=await dialogStep(()=>cls().run_rule({iv_rule:str(pile.rule_name.trim()),iv_run:str(pile.run_id.trim()),
      iv_date:new abap.types.Date().set('20261001'),iv_pile:new abap.types.Integer().set(pile.pile_no),iv_bind:str('')})); }
    finally {l2[method]=original;sink.zif_l3_fleet2_alerts$put=put;}
    return {sinkWrites,status:answer.get().status.get().trim(), beforeWork,beforeAlerts,
      work:read('SELECT * FROM zosd_l3_work'),alerts:read('SELECT * FROM zosd_l3_alert'),
      pile:read('SELECT * FROM zosd_l3_pile WHERE run_id=? AND rule_name=? AND pile_no=?',pile.run_id,pile.rule_name,pile.pile_no)[0]};
  }
  it('a superseded attempt writes neither filter keys nor alerts nor the pile tail', async()=> {
    const filter=await lateAttempt();
    expect(filter.status).to.equal('STALE-JOB');expect(filter.work).to.deep.equal(filter.beforeWork);
    expect(filter.pile.status.trim()).to.equal('RUNNING');expect(filter.pile.job_count.trim()).to.equal('99999999');
    for(const table of tables)await sql(`DELETE FROM ${table}`);
    await abandonJobs();
    const check=await lateAttempt(true);
    expect(check.status).to.equal('STALE-JOB');expect(check.alerts).to.deep.equal(check.beforeAlerts);expect(check.sinkWrites).to.equal(0);
    expect(check.pile.status.trim()).to.equal('RUNNING');
  });
  async function quietHour(kind,ticks=360) {
    const runId=(await run()).get().run_id.get().trim();
    await initialPassFirst();
    if(kind==='kill') {
      expect((await dialogStep(()=>cls().set_kill({iv_reason:str('operator pause')}))).get()).to.equal('X');
      await daemonHost(abap).idle();
    } else await dialogStep(()=>sql("UPDATE zosd_l3_budget SET state='GLASS'"));
    const count=()=>store.db.prepare("SELECT count(*) n FROM batch_runs WHERE job_name='L3_FLEET2_PASS'").get().n;
    const before=count();
    for(let i=0;i<ticks;i++){await clock.advance(10000);await work();}
    return {runId, passes:count()-before};
  }
  it('kill stops and audits the daemon; an hour submits no passes; clear_kill restarts healing',async()=> {
    const quiet=await quietHour('kill');expect(quiet.passes).to.be.at.most(1);
    expect(daemonHost(abap).instances.size).to.equal(0);
    expect(read("SELECT * FROM zosd_l3_doctor WHERE doc_action='DMN-KILL'")).to.have.length(1);
    await dialogStep(()=>cls().clear_kill({iv_reason:str('operator continue')}));
    await work();await clock.advance(10000);await work();
    expect(read("SELECT * FROM zosd_l3_run WHERE status='HELD'")).to.have.length(0);
  });
  it('GLASS sleeps for an hour without passes; continue_glass resumes healing',async()=> {
    const quiet=await quietHour('glass');expect(quiet.passes).to.be.at.most(1);
    const ok=await dialogStep(()=>cls().continue_glass({iv_run:str(quiet.runId),iv_reason:str('operator continue'),iv_new_glass:new abap.types.Integer().set(10000)}));
    expect(ok.get()).to.equal('X');await work();await clock.advance(10000);await work();
    expect(read("SELECT * FROM zosd_l3_run WHERE status='HELD'")).to.have.length(0);
  });
  async function stoppingRace() {
    const manager=abap.Classes.CL_ABAP_DAEMON_CLIENT_MANAGER;
    const info=manager.get_daemon_info;let saved;
    manager.get_daemon_info=async(input)=> {const result=await info.call(manager,input);if(result.array().length)saved=result.clone();return result;};
    try {
      await run();await daemonHost(abap).idle();
      await dialogStep(()=>cls().start_daemon());
      // The last old run ends, and its daemon decides to stop.
      await dialogStep(()=>sql("UPDATE zosd_l3_run SET status='RELEASED'"));
      await clock.advance(10000);await daemonHost(abap).idle();
    }finally{manager.get_daemon_info=info;}
    expect(saved.array()).to.have.length(1);
    // Retain the stopped instance in GET_DAEMON_INFO, as SAP does until ON_STOP.
    await daemonHost(abap).close();
    await abandonJobs();
    manager.get_daemon_info=async()=>saved;
    try {
      await run('20261002');expect(daemonHost(abap).instances.size).to.equal(0);
      await work();
      expect(read("SELECT status FROM zosd_l3_stage WHERE check_date='20261002' AND stage_no=2")[0].status.trim()).to.equal('DONE');
    }finally{manager.get_daemon_info=info;}
  }
  it('a run started while the old daemon awaits ON_STOP still advances through the job tail',stoppingRace);
  it('RunStat equals an independent oracle over every DONE pile', async () => {
    await run();await work();
    await dialogStep(async()=> {
      const piles=read("SELECT * FROM zosd_l3_pile WHERE status='DONE'");
      for (const [index,pile] of piles.entries()) {
        const ended=index % 2 ? '20261001000111' : '20261001000105';
        await sql(`UPDATE zosd_l3_pile SET started='20261001000059', ended='${ended}' WHERE run_id='${pile.run_id}' AND rule_name='${pile.rule_name}' AND pile_no=${Number(pile.pile_no)}`);
      }
      await cls().doctor({});
    });
    const oracle=()=> {
      const rows=read('SELECT * FROM zosd_l3_pile');
    const done=rows.filter(r=>r.status.trim()==='DONE');
    const epoch=(value)=>{const t=String(value);return Date.parse(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}Z`)/1000;};
    const seconds=done.map(r=>epoch(r.ended)-epoch(r.started)).sort((a,b)=>a-b);
    const stats=read('SELECT * FROM zosd_l3_runstat')[0];
    expect(Number(stats.piles_done)).to.equal(done.length);
    expect(Number(stats.piles_failed)).to.equal(rows.filter(r=>r.status.trim()==='FAILED'||r.status.trim()==='FUSED').length);
    expect(Number(stats.piles_running)).to.equal(rows.filter(r=>r.status.trim()==='RUNNING').length);
    expect(Number(stats.piles_held)).to.equal(rows.filter(r=>r.status.trim()==='HELD').length);
    expect(Number(stats.mean_secs)).to.equal(Number((seconds.reduce((a,b)=>a+b,0)/seconds.length).toFixed(3)));
    const n=seconds.length; expect(Number(stats.median_secs)).to.equal((seconds[Math.floor((n-1)/2)]+seconds[Math.floor(n/2)])/2);
    };
    oracle();
    // Four remaining DONE piles exercise the even median; include each other counter.
    await dialogStep(async()=> {
      const piles=read('SELECT * FROM zosd_l3_pile');
      for (const [index,status] of ['HELD','FAILED','RUNNING'].entries()) {
        const pile=piles[index];
        await sql(`UPDATE zosd_l3_pile SET status='${status}' WHERE run_id='${pile.run_id}' AND rule_name='${pile.rule_name}' AND pile_no=${Number(pile.pile_no)}`);
      }
      await cls().doctor({});
    });
    oracle();
  });
  it('mutants by copy: no start, no notification, no healing, no counting, no self-stop each breaks its assertion', async () => {
    const cases=[
      ['no-start','zcl_l3_fleet2',t=>t.replace('static async start_daemon(INPUT) {','static async start_daemon(INPUT) { return new abap.types.Character(1);'),async()=>{
        await run();expect(daemonHost(abap).instances.size).to.equal(0);
      }],
      ['no-message','zcl_l3_fleet2',t=>t.replace('static async pile_done(INPUT) {','static async pile_done(INPUT) { return;'),async()=>{
        await run();await initialPassFirst();await work();expect(read("SELECT * FROM zosd_l3_runstat")[0].piles_done).to.equal(0);
      }],
      ['no-heal','zcl_l3_fleet2',t=>t.replace("lv_reason.set(abap.CharacterFactory.get(9, 'JOB-ENDED'));","lv_reason.clear();"),async()=>{
        const original=abap.Classes.ZCL_L2_SHIP_BUSY.keys;abap.Classes.ZCL_L2_SHIP_BUSY.keys=async()=>{throw new Error('dump');};
        try {await run();await work();await clock.advance(10000);await work();}finally{abap.Classes.ZCL_L2_SHIP_BUSY.keys=original;}
        expect(read("SELECT * FROM zosd_l3_doctor WHERE doc_action='FAILED'")).to.have.length(0);
      }],
      ['no-count','zcl_l3_fleet2',t=>t.replace('static async count_runs() {','static async count_runs() { return;'),async()=>{
        await run();await work();expect(read('SELECT * FROM zosd_l3_runstat')).to.have.length(0);
      }],
      ['no-stop','zcl_l3_fleet2_dmn',t=>t.replace("if_abap_daemon_context$stop();", "if_abap_daemon_context$get_instance_id();"),async()=>{
        await run();await work();await clock.advance(10000);await daemonHost(abap).idle();expect(daemonHost(abap).instances.size).to.equal(1);
      }],
    ];
    for (const [name,clsName,edit,check] of cases) {
      for(const table of tables) await sql(`DELETE FROM ${table}`);
      await mutant(name,clsName,edit,check);
      // Settle abandoned queued jobs before installing the next mutant.
      await abandonJobs();
    }
  });
  it('P2 mutants by copy: missing sink fence, tail fence, abort, GLASS sleep, kill stop or fallback fail their oracles',async()=> {
    const reset=async()=> {
      await daemonHost(abap).close();
      for(const table of tables)await sql(`DELETE FROM ${table}`);
      await abandonJobs();
      clock.set(Date.parse('2026-10-01T00:00:00Z'));
    };
    await reset();
    await mutant('no-sink-fence','zcl_l3_fleet2',t=>t.replaceAll('if (abap.compare.eq((await this.owns_pile({is_pile: ls_pile, rv_ok: 1})), abap.builtin.abap_false)) {','if (false) {'),async()=> {
      const late=await lateAttempt();expect(late.status).not.to.equal('STALE-JOB');expect(late.work).not.to.deep.equal(late.beforeWork);
    });
    await reset();
    await mutant('no-alert-fence','zcl_l3_fleet2',t=>t.replaceAll('if (abap.compare.eq((await this.owns_pile({is_pile: ls_pile, rv_ok: 1})), abap.builtin.abap_false)) {','if (false) {'),async()=> {
      const late=await lateAttempt(true);expect(late.sinkWrites).to.be.greaterThan(0);
    });
    await reset();
    await mutant('no-tail-fence','zcl_l3_fleet2',t=>t.replace('if (abap.compare.eq(iv_owned, abap.builtin.abap_true) &&', 'if (false &&'),async()=> {
      await run();await daemonHost(abap).idle();
      const pile=read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0];
      const row=new abap.types.Structure(Object.fromEntries(Object.entries(pile).map(([key,value])=>
        [key,typeof value==='number'?(Math.abs(value)<=2147483647?new abap.types.Integer().set(value):new abap.types.Packed({length:16,decimals:0}).set(value)):str(String(value??''))])));
      row.get().status.set('DONE');row.get().attempt.set(pile.attempt-1);
      await dialogStep(()=>cls().save_pile({is_pile:row,iv_owned:str('X')}));
      expect(read('SELECT status FROM zosd_l3_pile WHERE stage_no=1')[0].status.trim()).to.equal('DONE');
    });
    await reset();
    await mutant('no-abort','zcl_l3_fleet2',t=>t.replace("await abap.FunctionModules['BP_JOB_ABORT']({exporting: {jobname: ls_pile.get().job_name, jobcount: ls_pile.get().job_count}});",'abap.builtin.sy.get().subrc.set(0);'),async()=> {
      await releasedPile();
      const claimed=store.claimNext(), pile=read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0];
      expect(claimed.run.jobName).to.equal(pile.job_name.trim());expect(claimed.run.jobCount).to.equal(pile.job_count.trim());
      await dialogStep(()=>sql("UPDATE zosd_l3_pile SET status='RUNNING', started='20261001000000' WHERE stage_no=1"));
      clock.set(Date.parse('2026-10-01T00:16:00Z'));await dialogStep(()=>cls().doctor({}));
      expect(store.get(claimed.run.id).state).to.equal('RUNNING');
    });
    await reset();
    await mutant('no-glass-sleep','zcl_l3_fleet2',t=>t.replace('if (abap.compare.eq((await this.budget_state({iv_run: ls_run.get().run_id, rv_state: 1})), abap.CharacterFactory.get(5, \'GLASS\'))) {','if (false) {'),async()=> {
      const quiet=await quietHour('glass',3);expect(quiet.passes).to.be.greaterThan(1);
    });
    await reset();
    await mutant('no-kill-stop','zcl_l3_fleet2',t=>t.replace('await this.stop_daemon();','await this.daemon_status();'),async()=> {
      await run();await daemonHost(abap).idle();
      await dialogStep(()=>cls().set_kill({iv_reason:str('operator pause')}));await daemonHost(abap).idle();
      expect(daemonHost(abap).instances.size).to.equal(1);
    });
    await reset();
    await mutant('no-tail-advance','zcl_osd_gui_l3_fleet2',t=>t.replace("await abap.Classes['ZCL_L3_FLEET2'].advance(","await abap.Classes['ZCL_L3_FLEET2'].pile_done("),async()=> {
      let failure;try{await stoppingRace();}catch(error){failure=error;}
      expect(failure?.message).to.include("expected 'WAITING' to equal 'DONE'");
    });
    await reset();
  });
  it('generic BP_JOB_ABORT refuses unknown, foreign and non-running jobs and preserves the business LUW',async()=> {
    await releasedPile();
    const claimed=store.claimNext(), pile=read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0];
    expect(claimed.run.jobName).to.equal(pile.job_name.trim());expect(claimed.run.jobCount).to.equal(pile.job_count.trim());
    const abort=()=>abap.FunctionModules.BP_JOB_ABORT({exporting:{jobname:str(pile.job_name.trim()),jobcount:str(pile.job_count.trim())}});
    await dialogStep(async()=> {
      await sql("UPDATE zosd_job_identity SET owner='OTHER' WHERE jobname='"+pile.job_name.trim()+"'");
    });
    let refused;try{await dialogStep(abort);}catch(error){refused=error;}
    expect(String(refused?.classic).toUpperCase()).to.equal('NO_ABORT_AUTHORITY');expect(store.get(claimed.run.id).state).to.equal('RUNNING');
    await dialogStep(()=>sql("UPDATE zosd_job_identity SET owner='"+abap.builtin.sy.get().uname.get().trim()+"' WHERE jobname='"+pile.job_name.trim()+"'"));
    await dialogStep(async()=> {
      await client.beginTransaction();
      await sql("INSERT INTO zosd_l3_kill (mandt,set_name) VALUES ('123','rollback-probe')");
      await abort();
      throw new Error('roll back business LUW');
    }).catch(error=>expect(error.message).to.equal('roll back business LUW'));
    expect(read("SELECT * FROM zosd_l3_kill WHERE set_name='rollback-probe'")).to.have.length(0);
    expect(store.get(claimed.run.id).state).to.equal('INTERRUPTED');
    for(const count of [pile.job_count.trim(),'99999999']) {
      let error;try{await dialogStep(()=>abap.FunctionModules.BP_JOB_ABORT({exporting:{jobname:str(pile.job_name.trim()),jobcount:str(count)}}));}catch(e){error=e;}
      expect(String(error?.classic).toUpperCase()).to.equal(count===pile.job_count.trim()?'JOB_NOT_RUNNING':'JOB_DOES_NOT_EXIST');
    }
  });
  it('a generic worker recognizes an aborted claim and cannot record a late success',async()=> {
    await releasedPile();
    const pile=read('SELECT * FROM zosd_l3_pile WHERE stage_no=1')[0];
    const outcome=await workQueuedBatch(process.cwd(),store,async()=> {
      await dialogStep(()=>abap.FunctionModules.BP_JOB_ABORT({exporting:{jobname:str(pile.job_name.trim()),jobcount:str(pile.job_count.trim())}}));
      return {status:'COMPLETED',lines:[]};
    });
    expect(outcome.kind).to.equal('interrupted');expect(outcome.run.state).to.equal('INTERRUPTED');
    expect(outcome.run.steps[0].state).to.equal('INTERRUPTED');
  });
  it('event release plans waiting jobs and enforces lanes, kill and GLASS before completing both stages', async()=> {
    {
      for (const [name,value] of [['budget.glass','1000'],['piles.lanes','2']])
        expect((await dialogStep(()=>cls().set_setting({iv_param:str(name),iv_value:str(value),iv_note:str('release fixture capacity')}))).get()).to.equal('X');
      for(let i=1;i<8;i++) {
        await sql(`INSERT INTO zosd_l2_ship (mandt,ship_id,name,status) VALUES ('123','E${String(i).padStart(3,'0')}','Ship','A')`);
        await sql(`INSERT INTO zosd_l2_voy (mandt,voyage_id,ship_id,dep_date) VALUES ('123','E${String(i).padStart(5,'0')}','E${String(i).padStart(3,'0')}','20261005')`);
      }
      await run();await daemonHost(abap).idle();await drainJobOutbox(store);
      expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-WAIT'")).to.have.length(4);
      await initialPassFirst();
      expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-SENT'")).to.have.length(2);
      expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-WAIT'")).to.have.length(2);
      await dialogStep(()=>sql("UPDATE zosd_l3_budget SET state='GLASS'"));
      await release();
      expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-SENT'")).to.have.length(2);
      await dialogStep(()=>sql("UPDATE zosd_l3_budget SET state='NARROW'"));
      await release();
      expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-SENT'")).to.have.length(2);
      await dialogStep(()=>sql("UPDATE zosd_l3_budget SET state='RUNNING'"));
      // A set kill suppresses a release while a lane is free: the operator raises the cap from 2 to 3
      // under the kill, and only clearing it releases the third pile.
      await dialogStep(()=>sql("INSERT INTO zosd_l3_kill (mandt,set_name) VALUES ('123','fleet2')"));
      expect((await dialogStep(()=>cls().set_setting({iv_param:str('piles.lanes'),iv_value:str('3'),iv_note:str('one lane more')}))).get()).to.equal('X');
      await release();
      expect(read("SELECT * FROM zosd_l3_pile WHERE status='PLANNED' AND reason='EVENT-SENT'")).to.have.length(2);
      await dialogStep(()=>sql('DELETE FROM zosd_l3_kill'));
      await release();
      expect(read("SELECT * FROM zosd_l3_pile WHERE status='PLANNED' AND reason='EVENT-SENT'")).to.have.length(3);
      await work();
      for(let i=0;i<8 && read("SELECT * FROM zosd_l3_run WHERE status='HELD'").length;i++){await clock.advance(10000);await work();}
      expect(read("SELECT status FROM zosd_l3_stage WHERE stage_no=2")[0].status.trim(), JSON.stringify(read('SELECT status,reason FROM zosd_l3_pile'))).to.equal('DONE');
    }
  });
  // A pass whose report dumps after its first raise and before its last commit. BP_EVENT_RAISE outlives
  // the rollback; the claims must too, or the released job runs on a lane the next pass counts as free.
  // After every step every pile job released (queued or running in the batch store) belongs to a pile
  // counted active; the raise the dump lost is made again by a pass a minute after the claim.
  // two lanes, four stage-1 piles planned waiting for their event
  async function fourWaiting(note) {
    for (const [name,value] of [['budget.glass','1000'],['piles.lanes','2']])
      expect((await dialogStep(()=>cls().set_setting({iv_param:str(name),iv_value:str(value),iv_note:str(note)}))).get()).to.equal('X');
    for(let i=1;i<8;i++) {
      await sql(`INSERT INTO zosd_l2_ship (mandt,ship_id,name,status) VALUES ('123','E${String(i).padStart(3,'0')}','Ship','A')`);
      await sql(`INSERT INTO zosd_l2_voy (mandt,voyage_id,ship_id,dep_date) VALUES ('123','E${String(i).padStart(5,'0')}','E${String(i).padStart(3,'0')}','20261005')`);
    }
    await run();await daemonHost(abap).idle();await drainJobOutbox(store);
    expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-WAIT'")).to.have.length(4);
  }
  // the pile jobs released (queued or running in the batch store), and those whose pile is not counted active
  const released=()=>store.db.prepare("SELECT job_name,job_count FROM batch_runs WHERE job_name GLOB 'L3_FLEET2_[0-9]*' AND state IN ('QUEUED','RUNNING')").all();
  const unreserved=()=>released().filter(job=>!read("SELECT * FROM zosd_l3_pile WHERE job_name=? AND job_count=? AND (status='RUNNING' OR (status='PLANNED' AND reason='EVENT-SENT'))",job.job_name,job.job_count).length);
  async function dumpAfterFirstRaise() {
    await fourWaiting('dump fixture');
    const original=abap.FunctionModules.BP_EVENT_RAISE;let raises=0;
    abap.FunctionModules.BP_EVENT_RAISE=async(input)=> {
      if(String(input.exporting.eventid.get()).trim()==='ZOSD_L3_RELEASE' && raises++===1) throw new Error('simulated dump after the first raise');
      return original(input);
    };
    try {await initialPassFirst();} finally {abap.FunctionModules.BP_EVENT_RAISE=original;}
    await drainJobOutbox(store);
    expect(raises,'the second raise dumped').to.equal(2);
    expect(released(),'the first raise released its job').to.have.length(1);
    expect(unreserved(),'a released job without its claim').to.deep.equal([]);
    expect(read("SELECT * FROM zosd_l3_pile WHERE status='PLANNED' AND reason='EVENT-SENT'")).to.have.length(2);
    // the next pass finds both lanes taken; within the grace it leaves the lost raise alone
    await release();await drainJobOutbox(store);
    expect(read("SELECT * FROM zosd_l3_pile WHERE reason='EVENT-SENT'")).to.have.length(2);
    expect(released()).to.have.length(1);
    // past the grace the job still waits for its event: raised again
    await clock.advance(61000);await release();await drainJobOutbox(store);
    expect(released(),'the lost raise made again').to.have.length(2);
    expect(unreserved()).to.deep.equal([]);
    // and a raise for a job that has left the wait does nothing
    const before=store.db.prepare("SELECT id,state FROM batch_runs ORDER BY id").all();
    for(const job of released()) await dialogStep(()=>abap.FunctionModules.BP_EVENT_RAISE({exporting:{eventid:str('ZOSD_L3_RELEASE'),eventparm:str(`${job.job_name.trim()}/${job.job_count.trim()}`)}}));
    await drainJobOutbox(store);
    expect(store.db.prepare("SELECT id,state FROM batch_runs ORDER BY id").all()).to.deep.equal(before);
    await work();
    for(let i=0;i<8 && read("SELECT * FROM zosd_l3_run WHERE status='HELD'").length;i++){await clock.advance(10000);await work();}
    expect(read("SELECT status FROM zosd_l3_stage WHERE stage_no=2")[0].status.trim(), JSON.stringify(read('SELECT status,reason FROM zosd_l3_pile'))).to.equal('DONE');
  }
  it('a release that dumps after a raise keeps its claims, and the lost raise is made again after the grace', dumpAfterFirstRaise);
  // A claims and commits, then stalls past the grace; B's pass raises A's claims again and their jobs
  // are released; the kill switch is set; A goes on. A committed claim is never put back: A raises
  // nothing under the kill and leaves its claims, so once the kill is cleared every released job is
  // still counted and no pass releases past the lanes. A failed raise leaves its claim as well.
  async function killAfterRecovery() {
    await fourWaiting('kill fixture');
    const claimed=await dialogStep(()=>cls().release_claim());
    expect(claimed.array()).to.have.length(2);
    await clock.advance(61000);
    const none=await dialogStep(()=>cls().release_claim());
    expect(none.array(),'both lanes are claimed').to.have.length(0);
    await dialogStep(()=>cls().release_raise({it_claimed:none}));await drainJobOutbox(store);
    expect(released(),'the recovery raise released both jobs').to.have.length(2);
    await dialogStep(()=>sql("INSERT INTO zosd_l3_kill (mandt,set_name) VALUES ('123','fleet2')"));
    await dialogStep(()=>cls().release_raise({it_claimed:claimed}));
    await dialogStep(()=>sql('DELETE FROM zosd_l3_kill'));
    expect(unreserved(),'a released job outside the count after the kill').to.deep.equal([]);
    await release();await drainJobOutbox(store);
    expect(released(),'no lane past the two').to.have.length(2);
    // a failed raise: the claim stays, and the pass after the grace raises it
    const original=abap.FunctionModules.BP_EVENT_RAISE;
    // one lane more, whose raise fails
    expect((await dialogStep(()=>cls().set_setting({iv_param:str('piles.lanes'),iv_value:str('3'),iv_note:str('one lane more')}))).get()).to.equal('X');
    abap.FunctionModules.BP_EVENT_RAISE=async()=>{abap.builtin.sy.get().subrc.set(1);};
    let failed;
    try {failed=await dialogStep(()=>cls().release_claim());await dialogStep(()=>cls().release_raise({it_claimed:failed}));}
    finally {abap.FunctionModules.BP_EVENT_RAISE=original;}
    expect(failed.array(),'the third lane was claimed').to.have.length(1);
    for(const pile of failed.array()) expect(read('SELECT reason FROM zosd_l3_pile WHERE job_name=? AND job_count=?',pile.get().job_name.get(),pile.get().job_count.get())[0].reason.trim(),'a failed raise keeps its claim').to.equal('EVENT-SENT');
    expect(released()).to.have.length(2);
    await clock.advance(61000);await release();await drainJobOutbox(store);
    expect(released(),'the failed raise made again').to.have.length(3);
    expect(unreserved()).to.deep.equal([]);
    await work();
    for(let i=0;i<8 && read("SELECT * FROM zosd_l3_run WHERE status='HELD'").length;i++){await clock.advance(10000);await work();}
    expect(read("SELECT status FROM zosd_l3_stage WHERE stage_no=2")[0].status.trim(), JSON.stringify(read('SELECT status,reason FROM zosd_l3_pile'))).to.equal('DONE');
  }
  it('a committed claim is never put back: a kill after another pass raised it again leaves every released job counted; a failed raise keeps its claim', killAfterRecovery);
  it('release mutants by copy: raise before the claims commit, a kill that puts claims back, no second raise', async()=> {
    // each mutant must fail at its own assertion, not at a fixture left over from the one before
    const fails=async(check,message)=> {let failure;try{await check();}catch(error){failure=error;}expect(failure,'the oracle catches the mutant').to.be.instanceOf(Error);expect(failure.message).to.include(message);};
    const reset=async()=> {
      await daemonHost(abap).close();
      clock.set(Date.parse('2026-10-01T00:00:00Z'));
      await abandonJobs();
      for(const table of tables)await sql(`DELETE FROM ${table}`);
      for(const table of ['ship','voy','crew','cargo'])await sql(`DELETE FROM zosd_l2_${table}`);
      await sql("INSERT INTO zosd_l2_ship (mandt,ship_id,name,status) VALUES ('123','S001','Ship','A')");
      await sql("INSERT INTO zosd_l2_voy (mandt,voyage_id,ship_id,dep_date) VALUES ('123','V00001','S001','20261005')");
    };
    await reset();
    await mutant('raise-before-commit','zcl_osd_gui_l3_fleet2_doc',t=>t.replace("release_claim({rt_claimed: 1})));\n    await abap.statements.commit();","release_claim({rt_claimed: 1})));"),()=>fails(dumpAfterFirstRaise,'a released job without its claim'));
    await reset();
    // the reset of round 2, by copy: under the kill the claims not yet raised go back to EVENT-WAIT
    const reset2=(text)=> {
      const at=text.indexOf('static async release_raise(');
      const kill='if (abap.compare.eq((await this.killed({rv_killed: 1})), abap.builtin.abap_true)) {';
      const k=text.indexOf(kill,at);
      expect(k).to.be.greaterThan(at);
      const back="for (const row of it_claimed.array()) {const r=row.get();await abap.context.databaseConnections.DEFAULT.execute(`UPDATE zosd_l3_pile SET reason='EVENT-WAIT' WHERE rtrim(set_name)='fleet2' AND rtrim(run_id)='${r.run_id.get().trimEnd()}' AND rtrim(rule_name)='${r.rule_name.get().trimEnd()}' AND pile_no=${r.pile_no.get()} AND rtrim(status)='PLANNED' AND rtrim(reason)='EVENT-SENT'`);}";
      return text.slice(0,k+kill.length)+back+text.slice(k+kill.length);
    };
    await mutant('kill-puts-claims-back','zcl_l3_fleet2',reset2,()=>fails(killAfterRecovery,'a released job outside the count after the kill'));
    await reset();
    await mutant('no-second-raise','zcl_l3_fleet2',t=>t.replace(/(if \(abap\.compare\.eq\(abap\.builtin\.sy\.get\(\)\.subrc, abap\.IntegerFactory\.get\(0\)\) && abap\.compare\.eq\(lv_waiting, abap\.CharacterFactory\.get\(1, 'X'\)\)\) \{)/,'if (false) {'),()=>fails(dumpAfterFirstRaise,'the lost raise made again'));
    await reset();
  });
  // Every SELECT SINGLE FOR UPDATE of the generated L3 sources names the whole primary key of its table
  // (KEYFLAG in the table's definition): a system locks no row by part of a key. Read with abaplint.
  function forUpdateMisses(files) {
    const keys=new Map();
    const walk=(folder)=>readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(folder,e.name)):[join(folder,e.name)]);
    const all=walk('src');
    for(const file of all.filter(f=>f.endsWith('.tabl.xml'))) {
      const fields=[...readFileSync(file,'utf8').matchAll(/<DD03P>([\s\S]*?)<\/DD03P>/g)].map(m=>m[1]).filter(b=>/<KEYFLAG>X<\/KEYFLAG>/.test(b))
        .map(b=>b.match(/<FIELDNAME>([^<]*)<\/FIELDNAME>/)[1].toLowerCase()).filter(f=>f!=='mandt');
      keys.set(file.split('/').pop().replace('.tabl.xml','').toLowerCase(),fields);
    }
    const misses=[];let seen=0;
    for(const [name,text] of files) {
      const registry=new abaplintCore.Registry();registry.addFile(new abaplintCore.MemoryFile(name,text));registry.parse();
      for(const file of registry.getObjects().flatMap(o=>o.getABAPFiles())) for(const statement of file.getStatements()) {
        const source=statement.concatTokens().replace(/\s+/g,' ');
        if(!/^SELECT SINGLE FOR UPDATE /i.test(source)) continue;
        const table=source.match(/\bFROM (\w+)/i)[1].toLowerCase();
        expect(keys.has(table),`${name}:${statement.getStart().getRow()} locks ${table}, whose definition is not under src`).to.equal(true);
        seen++;
        const where=source.split(/\bWHERE\b/i)[1]??'';
        const missing=keys.get(table).filter(field=>!new RegExp(`(?<![\\w-])${field}\\s*=`,'i').test(where));
        if(missing.length) misses.push(`${name}:${statement.getStart().getRow()} ${table} without ${missing.join(', ')}`);
      }
    }
    return {misses,seen};
  }
  it('every SELECT SINGLE FOR UPDATE of the generated L3 sources names its table\'s whole primary key; the old run lock does not', async()=> {
    const model=compileSet(SET), rendered=await renderSet(model);
    const generated=Object.entries(rendered.files).filter(([name])=>name.endsWith('.abap'));
    const committed=readdirSync('src/l2demo').filter(n=>/^(zcl_l3_|zl3_|zcl_zl3c_).*\.abap$/.test(n)).map(n=>[n,readFileSync(join('src/l2demo',n),'utf8')]);
    const result=forUpdateMisses([...generated,...committed]);
    expect(result.seen,'statements checked').to.be.greaterThan(10);
    expect(result.misses).to.deep.equal([]);
    // mutant by copy: the run lock as it was, by set and run id
    const runner=rendered.files[`${model.class}.clas.abap`];
    const fixed='SELECT SINGLE FOR UPDATE * FROM zosd_l3_run INTO ls_run WHERE set_name = c_set AND check_date = ls_pile-check_date.';
    expect(runner).to.include(fixed);
    const old=runner.replace(fixed,"SELECT SINGLE FOR UPDATE * FROM zosd_l3_run INTO ls_run WHERE set_name = c_set AND run_id = ls_pile-run_id AND status = 'HELD'.");
    expect(forUpdateMisses([['old.clas.abap',old]]).misses).to.have.length(1).and.match(/zosd_l3_run without check_date/);
  });
  // TH_WPINFO as the sandbox answered it (2026-10-03): 15 work processes, 7 DIA, 1 UPD, 5 BGD of which
  // 4 are Waiting, 1 SPO, 1 UP2. Every non-background process is idle here, so only a filter on the type
  // counts 4; an older kernel says BTC and Wait.
  const MEASURED=[...Array(7).fill(['DIA','Waiting']),['UPD','Waiting'],['BGD','Running'],...Array(4).fill(['BGD','Waiting']),['SPO','Waiting'],['UP2','Waiting']];
  async function withWplist(rows, fn) {
    const original=abap.FunctionModules.TH_WPINFO;
    abap.FunctionModules.TH_WPINFO=async(input)=> {
      const table=input.tables.wplist;table.clear();
      for(const [type,status] of rows){const row=table.getRowType().clone();row.get().wp_typ.set(type);row.get().wp_status.set(status);table.append(row);}
    };
    try {return await fn();} finally {abap.FunctionModules.TH_WPINFO=original;}
  }
  async function lanesFor(rows, {cap='0', running=0}={}) {
    await dialogStep(async()=> {
      await sql("DELETE FROM zosd_l3_pile");
      for(let i=1;i<=running;i++) await sql(`INSERT INTO zosd_l3_pile (mandt,run_id,rule_name,pile_no,set_name,stage_no,status) VALUES ('123','LANES','x',${i},'fleet2',1,'RUNNING')`);
      for(let i=1;i<=2;i++) await sql(`INSERT INTO zosd_l3_pile (mandt,run_id,rule_name,pile_no,set_name,stage_no,status,reason) VALUES ('123','LANES','x',${10+i},'fleet2',1,'PLANNED','EVENT-WAIT')`);
    });
    expect((await dialogStep(()=>cls().set_setting({iv_param:str('piles.lanes'),iv_value:str(cap),iv_note:str('lane fixture')}))).get()).to.equal('X');
    return withWplist(rows, async()=> {
      const lanes=new abap.types.Integer(), source=new abap.types.String();
      await dialogStep(()=>cls().lanes({ev_lanes:lanes,ev_source:source}));
      const status=(await dialogStep(()=>cls().lanes_status())).get();
      return {lanes:lanes.get(),source:source.get(),status};
    });
  }
  const laneOracle={
    measured:async()=>expect(await lanesFor(MEASURED)).to.deep.equal({lanes:3,source:'COMPUTED',status:'LANES 3 COMPUTED RELEASED 0 WAITING 2'}),
    older:async()=>expect((await lanesFor([['DIA','Wait'],...Array(4).fill(['BTC','Wait']),['BTC','Run']])).lanes).to.equal(3),
    cap:async()=>expect(await lanesFor(MEASURED,{cap:'2'})).to.deep.equal({lanes:2,source:'SET',status:'LANES 2 SET RELEASED 0 WAITING 2'}),
    capAbove:async()=>expect((await lanesFor(MEASURED,{cap:'5'})).source).to.equal('COMPUTED'),
    // two of the four idle BGD now run this set's piles: 2 idle + 2 own = 4, 3 lanes, as before they started
    own:async()=>expect(await lanesFor(MEASURED.map((row,i)=>i===9||i===10?['BGD','Running']:row),{running:2})).to.deep.equal({lanes:3,source:'COMPUTED',status:'LANES 3 COMPUTED RELEASED 2 WAITING 2'}),
    floor:async()=>expect(await lanesFor(MEASURED.map(([type])=>[type,'Running']))).to.deep.equal({lanes:1,source:'FLOOR',status:'LANES 1 FLOOR RELEASED 0 WAITING 2'}),
  };
  it('lanes in force from the measured TH_WPINFO rows: 3/4 of the idle BGD, own running piles, the set cap, a floor of one', async()=> {
    for(const [name,check] of Object.entries(laneOracle)) {
      try {await check();} catch(error) {error.message=`${name}: ${error.message}`;throw error;}
    }
  });
  it('lane mutants by copy: the old BTC/Wait filter, no cap, no floor, own piles not counted, no lane check, no first pass, no tail release', async()=> {
    const fails=async(check)=> {let failure;try{await check();}catch(error){failure=error;}expect(failure,'the oracle catches the mutant').to.be.instanceOf(Error);};
    const reset=async()=> {
      await daemonHost(abap).close();
      for(const table of tables)await sql(`DELETE FROM ${table}`);
      await abandonJobs();
      clock.set(Date.parse('2026-10-01T00:00:00Z'));
    };
    const filter="(abap.compare.eq(I.wp_typ, abap.CharacterFactory.get(3, 'BGD')) || abap.compare.eq(I.wp_typ, abap.CharacterFactory.get(3, 'BTC'))) && (abap.compare.eq(I.wp_status, abap.CharacterFactory.get(7, 'Waiting')) || abap.compare.eq(I.wp_status, abap.CharacterFactory.get(4, 'Wait')))";
    await mutant('btc-wait-only','zcl_l3_fleet2',t=>t.replace(filter,"abap.compare.eq(I.wp_typ, abap.CharacterFactory.get(3, 'BTC')) && abap.compare.eq(I.wp_status, abap.CharacterFactory.get(4, 'Wait'))"),()=>fails(laneOracle.measured));
    await mutant('no-cap','zcl_l3_fleet2',t=>t.replace('if (abap.compare.gt(lv_cap, abap.IntegerFactory.get(0)) && abap.compare.le(lv_cap, ev_lanes)) {','if (false) {'),()=>fails(laneOracle.cap));
    await mutant('no-floor','zcl_l3_fleet2',t=>t.replace('if (abap.compare.lt(ev_lanes, abap.IntegerFactory.get(1))) {','if (false) {'),()=>fails(laneOracle.floor));
    await mutant('own-not-counted','zcl_l3_fleet2',t=>t.replace('abap.operators.add(lv_free,lv_running)','lv_free'),()=>fails(laneOracle.own));
    await reset();
    await mutant('no-lane-check','zcl_l3_fleet2',t=>t.replace('if (abap.compare.ge(lv_active, lv_lanes)) {','if (false) {'),async()=> {
      const peak=await cappedRun(20,3);expect(peak.jobs).to.be.greaterThan(3);
    });
    await reset();
    await mutant('no-first-pass','zcl_l3_fleet2',t=>t.replace(/^([ \t]*)await this\.start_daemon\(\);\n\1await this\.watcher_pass\(\);/m,'$1await this.start_daemon();'),()=>fails(stoppingRace));
    await reset();
    await mutant('no-tail-release','zcl_osd_gui_l3_fleet2',t=>t.replace("this.#lt_released.set((await abap.Classes['ZCL_L3_FLEET2'].release_claim({rt_claimed: 1})));",';'),()=>fails(stoppingRace));
    await reset();
  });
  it('SAP_END_OF_JOB releases an exact name/count watcher on success, abort and interruption', async () => {
    const folder=join(dir,'kernel-end');const isolated=new BatchRuns(folder,{OSD_OPERATIONS_DB:join(dir,'kernel-end.sqlite')});
    const uuid=()=>randomUUID().replaceAll('-','');const instance=uuid();
    const intent=(name,count,extra={})=>({intentId:uuid(),sourceDb:join(folder,'business.sqlite'),client:'123',sysid:'OSG',owner:'TESTER',
      jobname:name,jobcount:count,program:'Z_FIRST',generation:'test',sourceInstance:instance,steps:[{number:1,program:'Z_FIRST'}],...extra});
    try {
      for(const [index,status] of ['COMPLETED','FAILED','INTERRUPTED'].entries()) {
        const name=`PILE_${index}`, count=`0000000${index+1}`;
        const parent=isolated.importIntent(intent(name,count)).run;
        const watcher=isolated.importIntent(intent(`WATCH_${index}`,`0000000${index+4}`,{namedEvent:{id:'SAP_END_OF_JOB',param:name.padEnd(32,' ')+count,sourceInstance:instance,seq:isolated.reserveSignalSeq()}})).run;
        expect(watcher.state).to.equal('WAITING');isolated.claimNext();
        if(status==='INTERRUPTED')isolated.interruptQueued(parent.id);else isolated.finishStep(parent.id,1,{status});
        expect(isolated.get(watcher.id).state).to.equal('QUEUED');
        const signal=isolated.db.prepare("SELECT * FROM batch_named_events WHERE event_id='SAP_END_OF_JOB' AND event_param=?").get(name.padEnd(32,' ')+count);
        expect(signal.intent_id).to.match(/^[0-9a-f]{32}$/);
        isolated.claimNext();isolated.finishStep(watcher.id,1,{status:'COMPLETED'});
      }
    }finally{isolated.close();}
  });
  it('manifest validation names the line; job-only retains legacy runner and job bytes', async () => {
    const file=`src/l2demo/zz_autodoctor_${process.pid}.l3.yaml`;
    // the doctor without a daemon cannot release by event (refused below): those variants pin release: submit
    const text=readFileSync(SET,'utf8'), submit=text.replace('piles: {release: event}','piles: {release: submit}').replace(/, piles\.lanes(?=[,\]])/, '');
    expect(submit).not.to.equal(text);
    try {
      for(const [from,to] of [['tick: 10','tick: 0'],['[daemon]','[daemon, daemon]'],['[daemon]','[unknown]']]) {
        writeFileSync(file,text.replace(from,to));
        expect(()=>compileSet(file)).to.throw(/doctor/).and.match(/:\d+:/);
      }
      writeFileSync(file,text.replace('[daemon]','[job]').replace('doctor.tick, ',''));
      const releaseLine=text.split('\n').findIndex(line=>line.startsWith('piles: {release: event}'))+1;
      expect(()=>compileSet(file)).to.throw(new RegExp(`:${releaseLine}: event release needs a daemon doctor`));
      const eventOnly=submit.replace('[daemon]','[event]').replace('doctor.tick, ','');
      writeFileSync(file,eventOnly);
      const eventLine=eventOnly.split('\n').findIndex(line=>line.includes('doctor: {as: [event]'))+1;
      expect(()=>compileSet(file)).to.throw(new RegExp(`:${eventLine}: doctor.as needs daemon or job`));
      const source=readFileSync('tools/dsl-l3-resilience.mjs','utf8');
      const copied=source.replace('if (!mechanisms.includes("daemon") && !mechanisms.includes("job")) {','if (false) {');
      expect(copied).not.to.equal(source);
      const copy=join(dir,'event-only-validator.mjs');writeFileSync(copy,copied);
      const validationMutant=await import(pathToFileURL(copy).href);
      const accepted=validationMutant.compileResilience({resilience:{doctor:{as:['event']},stale:900,keep:{days:30}}},
        {id:'fixture',set:'fixture',line:()=>eventLine,fail:(line,message)=>{throw new Error(`:${line}: ${message}`);},
          staged:true,sink:{name:'alerts',variants:[{name:'capture',generated:true,class:'z_capture'}]}});
      expect(accepted.doctor.mechanisms).to.deep.equal(['event']);
      writeFileSync(file,submit.replace('[daemon]','[job]').replace('doctor.tick, ',''));
      const model=compileSet(file); const rendered=await renderSet(model);
      expect(model.daemon).to.equal(undefined);
      expect(rendered.files[`${model.report}.prog.abap`]).to.include('=>advance(');
      expect(rendered.files[`${model.class}.clas.abap`]).not.to.include('start_daemon');
      expect(rendered.files[`${model.class}.clas.abap`]).to.include("WITH p_mode = 'H'");
      for(const mechanisms of ['[event, job]','[daemon, event, job]']) {
        writeFileSync(file,(mechanisms.includes('daemon') ? text : submit).replace('[daemon]',mechanisms));
        const combined=compileSet(file), built=await renderSet(combined);
        expect(built.files[`${combined.class}.clas.abap`]).include("event_id = 'SAP_END_OF_JOB'").and.include('arm_doctor_job( ).');
        expect(built.findings.filter(f=>f.severity==='E')).to.have.length(0);
        if(mechanisms==='[event, job]') {
          expect(built.files[`${combined.class}.clas.abap`]).not.to.include('cl_abap_daemon_client_manager');
          expect(built.files[`${combined.report}.prog.abap`]).not.to.include('pile_done');
        }
      }
      // Compare the periodic-job method to the pre-slice implementation, byte for byte; a shallow
      // clone (CI) has no pre-slice commit, and only this comparison is left out there
      const history=spawnSync('git',['cat-file','-e','28d17e752:src/l2demo/zcl_l3_fleet2.clas.abap']).status===0;
      if(history) {
      const oldRunner=execFileSync('git',['show','28d17e752:src/l2demo/zcl_l3_fleet2.clas.abap'],{encoding:'utf8'});
      const method=(text)=>text.match(/  METHOD schedule_doctor\.[\s\S]*?  ENDMETHOD\./)[0];
      expect(method(rendered.files[`${model.class}.clas.abap`])).to.equal(method(oldRunner));
      const oldJob=execFileSync('git',['show','28d17e752:src/l2demo/zl3_fleet2.prog.abap'],{encoding:'utf8'});
      // Source filenames and the configurable parameter numbering are outside the doctor's tail.
      const tail=(text)=>text.slice(text.indexOf('  WRITE: / ls_rule-rule, ls_rule-status, ls_rule-alerts.'));
      expect(tail(rendered.files[`${model.report}.prog.abap`])).to.equal(tail(oldJob));
      }

    } finally {rmSync(file,{force:true});}
  });
});
