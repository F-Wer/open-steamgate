import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {BatchRuns} from '../tools/osd-batch-runs.mjs';
import {batchMonitorHandler, batchCountsHandler} from '../tools/osd-batch-monitor.mjs';
import {legacyCountUsed} from '../tools/osd-job-count.mjs';
import {prepareOperationsFileChange, replaceOperationsDatabase} from '../tools/osd-operations-files.mjs';
import {setAsideDatabase, forkDatabase} from '../tools/sqlite-file-client.mjs';

const schema = `CREATE TABLE batch_runs(source_db TEXT, source_client TEXT,
  source_sysid TEXT, job_name TEXT, job_count TEXT, state TEXT)`;
const activeChildren = new Set();
function startChild(code, path) {
  const child = fork(process.execPath, [], {execPath:process.execPath,
    execArgv:['--input-type=module','-e',code],
    env:{...process.env, OSD_LOCK_TEST_PATH:path}, stdio:['ignore','inherit','inherit','ipc']});
  const exit = new Promise((resolve,reject) => {
    child.once('error', reject);
    child.once('exit', (code,signal) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code ?? signal}`)));
  });
  const ready = new Promise((resolve,reject) => {
    child.once('message', resolve);
    exit.then(() => reject(new Error('lock holder exited before readiness')), reject);
  });
  const holder = {child,ready,exit};
  activeChildren.add(holder);
  exit.then(() => activeChildren.delete(holder), () => activeChildren.delete(holder));
  return holder;
}

describe('JOB_OPEN operations reader waits for SQLite locks', function () {
  this.timeout(30000);
  let root, path;
  beforeEach(() => {
    root=mkdtempSync('.local/job-reader-lock-'); path=resolve(root,'operations.sqlite');
  });
  afterEach(async () => {
    // Mocha timeouts do not cancel the test's pending await. Stop its writer
    // before checkpointing or removing files, even on a timed-out assertion.
    const holders = [...activeChildren];
    for (const holder of holders) holder.child.kill();
    await Promise.all(holders.map(holder => holder.exit.catch(() => {})));
    try { prepareOperationsFileChange(path); }
    finally { rmSync(root,{recursive:true,force:true}); }
  });
  const read = () => legacyCountUsed('.', {OSD_OPERATIONS_DB:path, OSD_SID:'ABC'}, 'source','123','DEMO','12000000');

  it('waits for a startup lock released in another process, then reads the committed key', async () => {
    const db=new DatabaseSync(path); db.exec(schema); db.close();
    const holder=startChild(`import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.env.OSD_LOCK_TEST_PATH);
      db.exec("BEGIN EXCLUSIVE; INSERT INTO batch_runs VALUES('source','123','ABC','DEMO','12000000','COMPLETED')");
      process.send('locked');
      setTimeout(()=>{db.exec('COMMIT');db.close();process.disconnect();},250);`,path);
    try {
      await holder.ready;
      assert.equal(read(),true);
      await holder.exit;
    } finally { holder.child.kill(); await holder.exit.catch(()=>{}); }
  });

  for (const monitorFirst of [true, false]) {
    it(`fresh schema is published atomically (${monitorFirst ? 'monitor' : 'writer'} starts first)`, async () => {
      const env={OSD_OPERATIONS_DB:path, OSD_BATCH_READ_TOKEN:'a'.repeat(32)};
      const handlers=[batchMonitorHandler('.',env), batchCountsHandler('.',env)];
      const req={query:{},get:()=>`Bearer ${env.OSD_BATCH_READ_TOKEN}`,socket:{remoteAddress:'127.0.0.1'}};
      let body, status=200;
      const res={set(){return this;},status(code){status=code;return this;},json(value){body=value;return this;}};
      const checkEmpty = () => {
        status=200; handlers[0](req,res);
        assert.equal(status,200,JSON.stringify(body)); assert.deepEqual(body.runs,[]);
        assert.match(body.revision,/^[0-9a-f-]{36}:0$/);
        handlers[1](req,res); assert.deepEqual({...body.counts},{running:0,queued:0});
        assert.equal(read(),false);
      };
      let holder;
      try {
        if (monitorFirst) { checkEmpty(); assert.equal(existsSync(path),false); }
        // Stop the real writer exactly where the old constructor exposed its
        // first table, before the revision/steps/log tables existed.
        holder=startChild(`import {DatabaseSync} from 'node:sqlite';
          import {existsSync} from 'node:fs';
          import {BatchRuns} from './tools/osd-batch-runs.mjs';
          const exec=DatabaseSync.prototype.exec;
          DatabaseSync.prototype.exec=function(sql) {
            const result=exec.call(this,sql);
            if (/CREATE TABLE IF NOT EXISTS batch_runs\\s*\\(/.test(sql)) {
              process.send('first table');
              const deadline=Date.now()+15000;
              while (!existsSync(process.env.OSD_LOCK_TEST_PATH+'.release')) {
                if (Date.now()>deadline) throw new Error('schema probe release timed out');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
              }
            }
            return result;
          };
          const writer=new BatchRuns('.',{OSD_OPERATIONS_DB:process.env.OSD_LOCK_TEST_PATH});
          writer.enqueue({program:'FIRST'}); writer.close(); process.disconnect();`,path);
        await holder.ready;
        const probe=new DatabaseSync(path,{readOnly:true});
        try {
          const before=probe.prepare('SELECT * FROM sqlite_master').all();
          checkEmpty();
          assert.deepEqual(probe.prepare('SELECT * FROM sqlite_master').all(),before,'readers must not create schema');
        } finally { probe.close(); }
        writeFileSync(path+'.release','');
        await holder.exit;
        handlers[0](req,res); assert.equal(body.runs[0].program,'FIRST');
        handlers[1](req,res); assert.deepEqual({...body.counts},{running:0,queued:1});
      } finally {
        writeFileSync(path+'.release','');
        if (holder) { holder.child.kill(); await holder.exit.catch(()=>{}); }
        for (const handler of handlers) handler.close();
      }
    });
  }

  it('monitor reads the committed WAL snapshot while a worker owns the write lock', async () => {
    const env={OSD_OPERATIONS_DB:path, OSD_BATCH_READ_TOKEN:'a'.repeat(32)};
    const store=new BatchRuns('.',env); store.close();
    const holder=startChild(`import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.env.OSD_LOCK_TEST_PATH);
      db.exec('BEGIN IMMEDIATE');process.send('locked');
      process.on('message',()=>{db.exec('COMMIT');db.close();process.disconnect();});`,path);
    try {
      await holder.ready;
      for(const make of [batchMonitorHandler,batchCountsHandler]) {
        let status=200, body;
        const response={set(){return this;},status(code){status=code;return this;},json(value){body=value;return this;}};
        const handler=make('.',env);
        try { handler({query:{},get:()=>`Bearer ${env.OSD_BATCH_READ_TOKEN}`,socket:{remoteAddress:'127.0.0.1'}},response); }
        finally { handler.close?.(); }
        assert.equal(status,200,JSON.stringify(body));
        assert.ok(body.runs || body.counts);
      }
    } finally {
      holder.child.send('release');
      await holder.exit;
    }
  });

  it('keeps WAL alive across worker shutdown and releases it with the server', () => {
    const env={OSD_OPERATIONS_DB:path, OSD_BATCH_READ_TOKEN:'a'.repeat(32)};
    const writer=new BatchRuns('.',env), server=new EventEmitter();
    const run=writer.start({program:'DEMO',input:[],generation:'test'});
    writer.finish(run.id,{status:'COMPLETED',lines:['saved output']});
    writer.db.prepare("UPDATE batch_runs SET source_owner='DEMO' WHERE id=?").run(run.id);
    const handler=batchMonitorHandler('.',env);
    const req={query:{},get:()=>`Bearer ${env.OSD_BATCH_READ_TOKEN}`,socket:{server}};
    let body;
    const res={set(){return this;},status(code){throw new Error(`HTTP ${code}`);},json(value){body=value;return this;}};
    try {
      handler.attachServer(server);
      writer.close();
      assert.equal(existsSync(path+'-wal'),true,'monitor must pin the WAL between requests');
      handler(req,res);
      assert.equal(body.runs[0].user,'DEMO');
      const revision=body.revision;
      req.query={since:revision}; handler(req,res);
      assert.deepEqual(body,{revision,unchanged:true});
      req.query={id:run.id}; handler(req,res);
      assert.equal(body.run.user,'DEMO');
      assert.ok(Array.isArray(body.run.log));
      req.query={id:run.id,output:'1'}; handler(req,res);
      assert.deepEqual(body.output.lines,['saved output']);
      // No read transaction survives the request: a worker can checkpoint.
      const replacement=new DatabaseSync(path);
      try { assert.equal(replacement.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy,0); }
      finally { replacement.close(); }
      server.emit('close');
      // A read-only final close cannot itself clean WAL files; the next writer can.
      const cleanup=new DatabaseSync(path);
      try { cleanup.prepare('SELECT count(*) FROM batch_runs').get(); } finally { cleanup.close(); }
      assert.equal(existsSync(path+'-wal'),false,'server shutdown must release the final handle');
    } finally { handler.close?.(); }
  });

  it('observes a ledger appearing later and reopens a replaced ledger', () => {
    const env={OSD_OPERATIONS_DB:path, OSD_BATCH_READ_TOKEN:'a'.repeat(32)};
    const handler=batchMonitorHandler('.',env);
    let body;
    const req={query:{},get:()=>`Bearer ${env.OSD_BATCH_READ_TOKEN}`,socket:{}};
    const res={set(){return this;},status(code){throw new Error(`HTTP ${code}`);},json(value){body=value;return this;}};
    try {
      handler(req,res); assert.deepEqual(body.runs,[]); assert.equal(existsSync(path),false);
      const writer=new BatchRuns('.',env);
      // Pin the old WAL before the worker's final write (critic sequence).
      handler(req,res); assert.deepEqual(body.runs,[]);
      writer.enqueue({program:'FIRST'}); writer.close();
      handler(req,res); assert.equal(body.runs[0].program,'FIRST');
      const other=path+'.replacement', replacement=new BatchRuns('.',{...env,OSD_OPERATIONS_DB:other});
      replacement.enqueue({program:'SECOND'}); replacement.close();
      replaceOperationsDatabase(other,path);
      handler(req,res); assert.equal(body.runs[0].program,'SECOND');
    } finally { handler.close?.(); }
  });

  it('an absent or newly opened ledger gives empty reads without creating files', () => {
    const env={OSD_OPERATIONS_DB:path};
    for(const opened of [false,true]) {
      if(opened) new DatabaseSync(path).close();
      const store=new BatchRuns('.',env,{readOnly:true});
      try { assert.deepEqual(store.list(),[]); }
      finally { store.close(); }
      assert.equal(existsSync(path),opened);
      assert.equal(existsSync(resolve(root,'batch-output')),false);
    }
  });

  it('deletion closes every retained monitor and counts reader before unlink, then reopens lazily', () => {
    const env={OSD_OPERATIONS_DB:path, OSD_BATCH_READ_TOKEN:'a'.repeat(32)};
    const writer=new BatchRuns('.',env);
    const handlers=[batchMonitorHandler('.',env), batchMonitorHandler('.',env), batchCountsHandler('.',env)];
    const req={query:{},get:()=>`Bearer ${env.OSD_BATCH_READ_TOKEN}`,socket:{remoteAddress:'127.0.0.1'}};
    let body;
    const res={set(){return this;},status(code){throw new Error(`HTTP ${code}`);},json(value){body=value;return this;}};
    try {
      for (const handler of handlers) handler(req,res);
      writer.enqueue({program:'FIRST'}); writer.close();
      assert.equal(existsSync(path+'-wal'),true);
      setAsideDatabase(path);
      for (const handler of handlers) {
        handler(req,res);
        assert.deepEqual(body.runs ?? {...body.counts}, body.runs ? [] : {running:0,queued:0});
      }
      assert.equal(existsSync(path),false,'empty reads must not recreate a deleted ledger');
      const replacement=new BatchRuns('.',env);
      replacement.enqueue({program:'SECOND'}); replacement.close();
      for (const handler of handlers.slice(0,2)) { handler(req,res); assert.equal(body.runs[0].program,'SECOND'); }
      handlers[2](req,res); assert.deepEqual({...body.counts},{running:0,queued:1});
    } finally { for (const handler of handlers) handler.close(); }
  });

  it('a database fork safely overwrites a ledger with a pinned final WAL write', () => {
    const env={OSD_OPERATIONS_DB:path, OSD_BATCH_READ_TOKEN:'a'.repeat(32)};
    const writer=new BatchRuns('.',env), handler=batchMonitorHandler('.',env);
    let body;
    const req={query:{},get:()=>`Bearer ${env.OSD_BATCH_READ_TOKEN}`,socket:{}};
    const res={set(){return this;},status(code){throw new Error(`HTTP ${code}`);},json(value){body=value;return this;}};
    try {
      handler(req,res); writer.enqueue({program:'FIRST'}); writer.close();
      const other=path+'.source', source=new BatchRuns('.',{...env,OSD_OPERATIONS_DB:other});
      source.enqueue({program:'SECOND'}); source.close();
      forkDatabase(other,path);
      assert.equal(existsSync(path+'-wal'),false,'the old WAL must be gone before replacement');
      handler(req,res); assert.equal(body.runs[0].program,'SECOND');
    } finally { handler.close(); }
  });

  it('refuses file deletion while an uncoordinated WAL reader still holds the ledger', () => {
    const store=new BatchRuns('.',{OSD_OPERATIONS_DB:path});
    const reader=new DatabaseSync(path,{readOnly:true});
    reader.prepare('SELECT count(*) FROM batch_runs').get();
    store.enqueue({program:'KEEP'}); store.close();
    try {
      assert.throws(() => setAsideDatabase(path), /locked|busy|open WAL connection/);
      assert.equal(existsSync(path),true);
      assert.equal(reader.prepare('SELECT program FROM batch_runs').get().program,'KEEP');
    } finally { reader.close(); }
    setAsideDatabase(path);
    assert.equal(existsSync(path),false);
  });

  it('survives WAL recovery as a worker repeatedly opens, writes and closes the ledger', async function () {
    // Preserve all 1,500 open/write/close cycles on slower CI filesystems.
    this.timeout(120000);
    const db=new DatabaseSync(path); db.exec(`PRAGMA journal_mode=WAL; ${schema}`); db.close();
    const holder=startChild(`import {DatabaseSync} from 'node:sqlite';
      process.send('ready');
      for(let i=0;i<1500;i++) {
        const db=new DatabaseSync(process.env.OSD_LOCK_TEST_PATH);
        db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO batch_runs VALUES('source','123','ABC','DEMO','12000000','DELETED'); COMMIT");
        db.close();
      }
      process.disconnect();`,path);
    const watchdog = setTimeout(() => holder.child.kill('SIGKILL'), 110000);
    try {
      await holder.ready;
      for(let i=0;i<1500;i++) assert.equal(read(),false);
      await holder.exit;
    } finally { clearTimeout(watchdog); holder.child.kill(); await holder.exit.catch(()=>{}); }
  });
});
