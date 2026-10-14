// Mocha's normal spec output, with elapsed wall time for each suite file.
const {writeFileSync} = require("node:fs");
const Mocha = require("mocha");
const {isAbsolute, relative} = require("node:path");

module.exports = class SuiteTimingReporter extends Mocha.reporters.Spec {
  constructor(runner, options) {
    super(runner, options);
    const timings = {};
    const failures = [];
    const internalRetries = [];
    runner.on("retry", (test) => {
      internalRetries.push({title: test.fullTitle()});
      console.error(`osd-suites: forbidden internal retry: ${test.fullTitle()}`);
    });
    const fileTests = {};
    const tests = {};
    const records = new Map();
    // relative to where the run started: a test that chdirs (into a scratch
    // root) must not move its own results to another file name
    const base = process.cwd();
    const fileOf = (test) => test.file && (isAbsolute(test.file) ? relative(base, test.file) : test.file).replace(/^\.\//, "");
    runner.suite.eachTest((test) => {
      const file = fileOf(test);
      if (file) {
        (fileTests[file] ??= {registered: 0, passed: 0, pending: 0, failed: 0}).registered++;
        const record = {titlePath: test.titlePath(), outcome: null};
        (tests[file] ??= []).push(record);
        records.set(test, record);
      }
    });
    for (const [event, field] of [["pass", "passed"], ["pending", "pending"], ["fail", "failed"]]) {
      runner.on(event, (test) => {
        if (test.type !== "test") return;
        const counts = fileTests[fileOf(test)];
        if (counts) counts[field]++;
        const record = records.get(test);
        if (record) record.outcome = field;
      });
    }
    let current;
    let began;
    const finish = () => {
      if (current) timings[current] = (timings[current] ?? 0) + Number(process.hrtime.bigint() - began) / 1e9;
    };
    runner.on("suite", (suite) => {
      if (!suite.file || !suite.parent?.root) return;
      const file = (isAbsolute(suite.file) ? relative(process.cwd(), suite.file) : suite.file).replace(/^\.\//, "");
      if (file === current) return;
      finish();
      current = file;
      began = process.hrtime.bigint();
    });
    runner.on("fail", (test, error) => {
      let owner = test;
      while (owner && !owner.file) owner = owner.parent;
      const path = owner?.file;
      const file = path ? (isAbsolute(path) ? relative(process.cwd(), path) : path).replace(/^\.\//, "") : null;
      failures.push({file, title: test.fullTitle(), ...(error?.code === 'OSD_TEST_ISOLATION' ? {isolation: true} : {})});
    });
    runner.on("end", () => {
      finish();
      writeFileSync(process.env.OSD_SUITE_TIMINGS_FILE, JSON.stringify({
        measuredAt: new Date().toISOString(),
        note: "Wall time including hooks and inter-file work; excludes module loading before the first suite.",
        completed: true,
        bail: Boolean(runner.suite._bail),
        fileTests,
        tests,
        failures,
        internalRetries,
        totalFailures: runner.failures,
        seconds: Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b))),
      }, null, 2) + "\n");
    });
  }
}
