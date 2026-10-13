import {append} from "./append.mjs";
// Process scheduling and crash recovery for the ABAP Unit runner.
import {spawn, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {performance} from "node:perf_hooks";

// One test process (and the seed image) gets this long before it is killed;
// a long benchmark raises it through the environment.
export function processTimeout() {
  const raw = process.env.GOGEN_UNIT_TIMEOUT_MS;
  if (raw === undefined) return 120000;
  // setTimeout fires at once above 2^31-1 ms (about 24.8 days)
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 2147483647)
    throw new Error(`GOGEN_UNIT_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, got '${raw}'`);
  return Number(raw);
}

export async function runUnit({bin, groups, ready, jobs, out, runDir}) {
  const timeoutMs = processTimeout();
  const runStarted = performance.now();
  const runDetail = {seedImageMs: 0, shards: [], mergeMs: 0};
  // One class is the scheduling unit: its hooks and methods stay in one Go
  // process. Keep the old single-process path for --jobs 1 and existing binary
  // callers. Shards share only immutable generated code, media and seed bytes.
  const timingFile = join(out, "class-timings.json");
  const oldTimings = existsSync(timingFile) ? JSON.parse(readFileSync(timingFile, "utf8")) : {};
  const saveTimings = (latest) => {
    const lock = `${timingFile}.lock`;
    const configuredTimeout = Number(process.env.GOGEN_UNIT_TIMING_LOCK_TIMEOUT_MS ?? 30000);
    const deadline = Date.now() + (Number.isFinite(configuredTimeout) && configuredTimeout >= 0 ? configuredTimeout : 30000);
    while (true) {
      try { mkdirSync(lock); break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A killed writer leaves the directory behind. Only its recorded owner
        // can be reclaimed; an empty directory may belong to a new writer.
        let pid;
        try { pid = readFileSync(join(lock, "pid"), "utf8").trim(); }
        catch (readError) { if (readError.code !== "ENOENT") throw readError; }
        if (pid && /^[1-9]\d*$/.test(pid) && Number.isSafeInteger(Number(pid))) {
          let dead = false;
          try { process.kill(Number(pid), 0); }
          catch (probeError) {
            if (probeError.code === "ESRCH") dead = true;
            else if (probeError.code !== "EPERM") throw probeError;
          }
          if (dead) {
            try { unlinkSync(join(lock, "pid")); rmdirSync(lock); }
            catch (removeError) { if (removeError.code !== "ENOENT") throw removeError; }
            continue;
          }
        }
        if (Date.now() >= deadline) throw new Error(`timing lock timed out: ${lock}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      writeFileSync(join(lock, "pid"), `${process.pid}\n`);
      const current = existsSync(timingFile) ? JSON.parse(readFileSync(timingFile, "utf8")) : {};
      const temp = join(runDir, "class-timings.json");
      writeFileSync(temp, JSON.stringify({...current, ...latest}, null, 2));
      renameSync(temp, timingFile);
    } finally { rmSync(lock, {recursive: true}); }
  };
  const saveTimingsOrWarn = (latest) => {
    try { saveTimings(latest); }
    catch (error) { console.error(`warning: class timings were not saved: ${error.message}`); }
  };
  const shards = Array.from({length: Math.min(jobs, groups.length)}, () => ({keys: [], weight: 0}));
  const orderedGroups = [...groups].sort((a, b) => a.key.localeCompare(b.key));
  const knownWeights = Object.values(oldTimings).filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const middle = Math.floor(knownWeights.length / 2);
  const fallbackWeight = knownWeights.length ? (knownWeights[middle] + knownWeights[(knownWeights.length - 1) >> 1]) / 2 : 1;
  const weightOf = (key) => typeof oldTimings[key] === "number" && Number.isFinite(oldTimings[key]) && oldTimings[key] > 0
    ? oldTimings[key] : fallbackWeight;
  if (knownWeights.length) orderedGroups.sort((a, b) =>
    weightOf(b.key) - weightOf(a.key) || a.key.localeCompare(b.key));
  for (const [index, group] of orderedGroups.entries()) {
    const shard = knownWeights.length
      ? shards.reduce((best, next) => next.weight < best.weight ? next : best)
      : shards[index % shards.length];
    shard.keys.push(group.key);
    shard.weight += weightOf(group.key);
  }
  const runner = process.env.GOGEN_UNIT_RUNNER ?? bin;
  let interrupted = false;
  const runFailure = (run) => run.error?.message || (run.signal ? `terminated by ${run.signal}` : "") || run.stderr || `exit ${run.status}`;
  const runProcess = (argv, env, cwd) => new Promise((resolveRun) => {
    if (interrupted) { resolveRun({killReason: "interrupted"}); return; }
    const child = spawn(runner, argv, {encoding: "utf8", env: {...env, GOGEN_UNIT_BINARY: bin}, cwd, detached: true});
    let stdout = "", stderr = "", error, killReason;
    const kill = (reason) => {
      if (killReason) return;
      killReason = reason;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (e) { if (e.code !== "ESRCH") throw e; }
      }
    };
    const onSignal = () => { interrupted = true; kill("interrupted"); };
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
    const timer = setTimeout(() => kill(`timeout after ${timeoutMs} ms`), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 20e6) kill("stdout limit exceeded (20 MB)"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 20e6) kill("stderr limit exceeded (20 MB)"); });
    child.on("error", (e) => { error = e; });
    child.on("close", (status, signal) => { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); clearTimeout(timer); resolveRun({status, signal, stdout, stderr, error, killReason}); });
  });
  // A checkpoint contains only whole classes, including their teardown.
  const readJSON = (file, fallback) => {
    try { return JSON.parse(readFileSync(file, "utf8")) ?? fallback; } catch { return fallback; }
  };
  const completed = (keys, run, resultsFile) => {
    let reported;
    try { reported = JSON.parse(run.stdout); } catch { /* use the last checkpoint */ }
    const checkpoint = readJSON(resultsFile, {});
    if (Array.isArray(checkpoint.rows)) reported = checkpoint.rows;
    if (!Array.isArray(reported)) reported = [];
    const complete = groups.filter((g) => keys.includes(g.key) && g.methods.every((method) =>
      reported.some((row) => row && row.class === method.class && row.testclass === method.testclass
        && row.method === method.method && ["SUCCESS", "FAILED", "SKIPPED", "NOT_COMPILED"].includes(row.status))));
    const completeKeys = complete.map((g) => g.key);
    return {rows: reported.filter((row) => row && completeKeys.includes(`${row.class}:${row.testclass}`)),
      pending: keys.filter((key) => !completeKeys.includes(key)), durations: checkpoint.durations ?? {},
      started: keys.includes(checkpoint.active)};
  };
  const died = (run) => {
    const firstLine = run.stderr?.trim().split("\n")[0];
    return run.killReason || run.error?.message
      || (run.signal ? `terminated by ${run.signal}${firstLine ? `: ${firstLine}` : ""}` : firstLine) || runFailure(run);
  };
  let retryIndex = 0;
  const recover = async (keys, run, resultsFile, seedFile) => {
    const result = completed(keys, run, resultsFile);
    const failPending = (pending, reason) => {
      for (const key of pending) append(result.rows, groups.find((g) => g.key === key).methods.map((r) =>
        ({...r, source: "harness", status: "FAILED", message: `runner died: ${reason}`})));
    };
    const emptyCheckpoint = result.rows.length === 0 && !result.started;
    let firstRetry = true;
    // One isolated re-run per unfinished class. This is deliberately not recursive.
    for (const [index, key] of result.pending.entries()) {
      if (interrupted || run.killReason === "interrupted" || run.error) {
        failPending(result.pending.slice(index), interrupted ? "interrupted" : died(run));
        break;
      }
      const retryDir = join(runDir, `retry-${retryIndex++}`);
      const tempDir = join(retryDir, "tmp"), datasetDir = join(retryDir, "dataset");
      mkdirSync(tempDir, {recursive: true}); mkdirSync(datasetDir);
      const classesFile = join(retryDir, "classes.json"), retryResults = join(retryDir, "results.json");
      writeFileSync(classesFile, JSON.stringify([key]));
      const env = {...process.env, GOGEN_UNIT_MEDIA_DIR: join(runDir, "media"), TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
        OSD_DATASET_READ: datasetDir, OSD_DATASET_WRITE: datasetDir, OSD_DATASET_HOME: datasetDir,
        OSD_DATASET_AUDIT: join(datasetDir, "audit.ndjson")};
      const retry = await runProcess(["--classes-file", classesFile, "--results-out", retryResults,
        ...(seedFile ? ["--seed-image", seedFile] : [])], env, retryDir);
      const own = completed([key], retry, retryResults);
      append(result.rows, own.rows);
      Object.assign(result.durations, own.durations);
      if (own.pending.length) append(result.rows, groups.find((g) => g.key === key).methods.map((r) =>
        ({...r, source: "harness", status: "FAILED", message: `runner died: ${retry.status === 0 && !retry.killReason ? "incomplete result" : died(retry)}`})));
      rmSync(retryDir, {recursive: true, force: true});
      // An empty checkpoint followed by the same initial failure indicates a
      // broken startup, not a class-specific crash. Do not retry every class.
      if (retry.killReason === "interrupted" || retry.error
        || (firstRetry && emptyCheckpoint && !own.started && own.pending.length
          && (retry.status !== 0 || retry.killReason) && died(retry) === died(run))) {
        failPending(result.pending.slice(index + 1), died(retry));
        break;
      }
      firstRetry = false;
    }
    runDetail.retries = retryIndex;
    return result;
  };
  let actual = [];
  let durations = {};
  if (shards.length <= 1) {
    const started = performance.now();
    const phasesFile = join(runDir, "phases.json");
    const singleDir = join(runDir, "single");
    mkdirSync(singleDir);
    const tempDir = join(singleDir, "tmp");
    const datasetDir = join(singleDir, "dataset");
    mkdirSync(tempDir); mkdirSync(datasetDir);
    const env = {...process.env, GOGEN_UNIT_BINARY: bin, GOGEN_UNIT_MEDIA_DIR: join(runDir, "media"), TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
      OSD_DATASET_READ: datasetDir, OSD_DATASET_WRITE: datasetDir, OSD_DATASET_HOME: datasetDir,
      OSD_DATASET_AUDIT: join(datasetDir, "audit.ndjson")};
    const runTimingsFile = join(runDir, "timings.json");
    const resultsFile = join(singleDir, "results.json");
    const run = await runProcess(["--timings-out", runTimingsFile, "--phases-out", phasesFile, "--results-out", resultsFile], env, singleDir);
    const result = await recover(groups.map((g) => g.key), run, resultsFile);
    actual = result.rows;
    const latestTimings = {...readJSON(runTimingsFile, {}), ...result.durations};
    saveTimingsOrWarn(latestTimings);
    runDetail.shards.push({index: 0, startMs: Math.round(started - runStarted), endMs: Math.round(performance.now() - runStarted),
      classes: groups.length, startupSeedMs: readJSON(phasesFile, {}).startupSeedMs,
      classMs: Object.values(latestTimings).reduce((a, b) => a + b, 0)});
    rmSync(singleDir, {recursive: true, force: true});
  } else {
    const seedStarted = performance.now();
    const scratchDir = join(runDir, "shards");
    mkdirSync(scratchDir);
    const seedFile = join(scratchDir, "seed.sqlite");
    const seed = spawnSync(runner, ["--seed-image-out", seedFile], {
      encoding: "utf8", timeout: timeoutMs, maxBuffer: 20e6, cwd: scratchDir, env: {...process.env, GOGEN_UNIT_BINARY: bin, GOGEN_UNIT_MEDIA_DIR: join(runDir, "media")},
    });
    runDetail.seedImageMs = Math.round(performance.now() - seedStarted);
    const seedHeader = existsSync(seedFile) ? readFileSync(seedFile).subarray(0, 16).toString("utf8") : "";
    const seedError = seed.status !== 0 ? runFailure(seed)
      : !existsSync(seedFile) ? "seed image missing"
        : ready.some((r) => r.db) ? (seedHeader !== "SQLite format 3\0" ? "invalid SQLite seed image" : "")
          : seedHeader ? "unexpected seed image for a database-free run" : "";
    if (seedError) {
      for (const r of ready) { r.source = "harness"; r.status = "FAILED"; r.message = `seed image: ${seedError}`; }
      rmSync(scratchDir, {recursive: true, force: true});
      return {actual: ready, runDetail};
    }
    const results = await Promise.all(shards.map(async (shard, index) => {
      const started = performance.now();
      const shardDir = join(scratchDir, `shard-${index}`);
      const tempDir = join(shardDir, "tmp");
      const datasetDir = join(shardDir, "dataset");
      mkdirSync(tempDir, {recursive: true}); mkdirSync(datasetDir, {recursive: true});
      const classesFile = join(shardDir, "classes.json");
      const durationsFile = join(shardDir, "timings.json");
      const phasesFile = join(shardDir, "phases.json");
      const resultsFile = join(shardDir, "results.json");
      writeFileSync(classesFile, JSON.stringify(shard.keys));
      const env = {...process.env, GOGEN_UNIT_MEDIA_DIR: join(runDir, "media"), TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
        OSD_DATASET_READ: datasetDir, OSD_DATASET_WRITE: datasetDir, OSD_DATASET_HOME: datasetDir,
        OSD_DATASET_AUDIT: join(datasetDir, "audit.ndjson")};
      const run = await runProcess(["--classes-file", classesFile, "--seed-image", seedFile,
        "--timings-out", durationsFile, "--phases-out", phasesFile, "--results-out", resultsFile], env, shardDir);
      const phase = {index, startMs: Math.round(started - runStarted), classes: shard.keys.length};
      runDetail.shards.push(phase);
      const result = await recover(shard.keys, run, resultsFile, seedFile);
      phase.endMs = Math.round(performance.now() - runStarted);
      const latest = {...readJSON(durationsFile, {}), ...result.durations};
      phase.classMs = Object.values(latest).reduce((a, b) => a + b, 0);
      phase.startupSeedMs = readJSON(phasesFile, {}).startupSeedMs;
      return {rows: result.rows, durations: latest};
    }));
    const mergeStarted = performance.now();
    for (const result of results) { append(actual, result.rows); Object.assign(durations, result.durations); }
    saveTimingsOrWarn(durations);
    runDetail.mergeMs = Math.round(performance.now() - mergeStarted);
    rmSync(scratchDir, {recursive: true, force: true});
  }
  return {actual, runDetail};
}
