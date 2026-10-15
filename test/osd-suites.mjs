// The reporter that says what a run could not look at. Both branches, because
// the branch that matters is the one a runner takes and a workstation never
// does -- and a reporter checked only where everything is present reports on
// the specimen made for it.
import {expect} from "chai";
import {OPTIONAL, reportSkips, listDrift, suitesOnDisk, hasSuites, assignShards, loadSuites, suggestSuiteFragment, runWithRetries, runWithRetries as realRunWithRetries} from "../tools/osd-suites.mjs";
import {timingDrift, latestShardArtifacts, downloadTrustedTimings} from "../tools/osd-suites-refresh.mjs";
import {mergeTimings} from "../tools/osd-suites-timings.mjs";
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync, symlinkSync, readdirSync} from "node:fs";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";

describe("tools/osd-suites: a run says what it could not see", () => {
  it("names every absent input and why it mattered", () => {
    const said = [];
    const absent = reportSkips([["/nowhere/corpus", "the oracle"], ["/nowhere/two", "the other one"]], (l) => said.push(l));
    expect(absent.map(([p]) => p)).to.deep.equal(["/nowhere/corpus", "/nowhere/two"]);
    expect(said.join("\n")).to.contain("NOT looked at");
    expect(said.join("\n")).to.contain("/nowhere/corpus");
    expect(said.join("\n"), "the reason travels with the path").to.contain("the oracle");
  });

  it("and says so plainly when it saw everything", () => {
    const said = [];
    expect(reportSkips([[".", "this directory, which exists"]], (l) => said.push(l))).to.deep.equal([]);
    expect(said.join("\n")).to.contain("the wide one");
  });

  it("the real list names paths that are not in this repository", () => {
    expect(OPTIONAL.map(([p]) => p)).to.include.members([".local/corpus", ".local/lars"]);
    for (const [, why] of OPTIONAL) {
      expect(why, "every entry says what is lost without it").to.have.length.greaterThan(10);
    }
  });
});

// The list of suites, checked as the hand-kept list it is.
//
// It went ten files out of date without anybody noticing, and the ten all
// passed when run -- so nothing was hiding in them and a green run was simply
// answering a narrower question than it was read as. That is the direction
// drift always takes: the one that reads as progress.
describe("the suite list against the tree", () => {
  it("sorts merged suites alphabetically and refuses duplicates across files and groups", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-suites-"));
    const dir = join(root, "test", "suites.d");
    try {
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, "z.json"), JSON.stringify({files: ["test/a.mjs"], groups: {packaging: ["test/z-package.mjs", "test/a-package.mjs"]}}));
      writeFileSync(join(dir, "a.json"), JSON.stringify({files: ["test/z.mjs"]}));
      expect(loadSuites(root)).to.deep.equal({files: ["test/a.mjs", "test/z.mjs"], groups: {packaging: ["test/a-package.mjs", "test/z-package.mjs"]}});
      writeFileSync(join(dir, "a.json"), JSON.stringify({files: ["test/a-package.mjs"]}));
      expect(() => loadSuites(root)).to.throw("duplicate suite test/a-package.mjs");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("suggests the most specific feature fragment for new suite files", () => {
    expect(suggestSuiteFragment("test/osd-job-next.mjs")).to.equal("jobs.json");
    expect(suggestSuiteFragment("test/osd-apc-next.mjs")).to.equal("apc-daemons.json");
    expect(suggestSuiteFragment("test/osd-dataset-next.mjs")).to.equal("infra-misc.json");
    expect(suggestSuiteFragment("test/vscode-next.mjs")).to.equal("vscode.json");
    expect(suggestSuiteFragment("test/unclassified-next.mjs")).to.equal("infra-misc.json");
    expect(suggestSuiteFragment("test/tie-next.mjs", {"z.json": ["tie-"], "a.json": ["tie-"]})).to.equal("a.json");
  });

  it("names every file under test/ that has suites in it", () => {
    const {files, groups} = loadSuites();
    const listed = [...files, ...Object.values(groups).flat()];
    const drift = listDrift(suitesOnDisk("test"), listed);
    expect(drift.unlisted, `suites nobody runs: ${drift.unlisted.join(", ")}`).to.deep.equal([]);
    expect(drift.absent, `named but not there: ${drift.absent.join(", ")}`).to.deep.equal([]);
  });

  it("accepts the helper without a describe and lists packaging in its named group", () => {
    expect(hasSuites(readFileSync("test/helpers/vsix.mjs", "utf8"))).to.equal(false);
    const {files, groups} = loadSuites();
    expect(groups.packaging).to.deep.equal(["test/vscode-vsix-packaging.mjs"]);
    expect(files).not.to.include(groups.packaging[0]);
  });

  it("counts a file as a suite by the describe in it, not by a list of exceptions", () => {
    // test/setup.mjs, test/start.mjs, test/run.mjs and test/seed.mjs are
    // harness modules. They drop out because they have no `describe` of their
    // own, which is why the rule needs no exception list -- and an exception
    // list is the thing that drifts.
    expect(hasSuites("describe('x', () => {})")).to.equal(true);
    expect(hasSuites("import x from 'y';\ndescribe('y', () => {})")).to.equal(true);
    expect(hasSuites("export function startServer() {} // a describe( mentioned mid-line"),
      "a mention inside a line is not a suite").to.equal(false);
    expect(hasSuites("  describe('indented, so it is inside something else', () => {})"),
      "and neither is one nested in another block").to.equal(false);
  });

  it("reads the directory through its arguments, so it can be asked about a tree that is not this one", () => {
    const read = (p) => (p === "d/a.mjs" ? "describe('x', () => {})" : "export const x = 1;");
    expect(suitesOnDisk("d", read, () => ["a.mjs", "harness.mjs", "notes.md"])).to.deep.equal(["d/a.mjs"]);
  });

  it("complains in both directions, because one direction is half a checker", () => {
    expect(listDrift(["test/a.mjs"], []).unlisted).to.deep.equal(["test/a.mjs"]);
    expect(listDrift([], ["test/gone.mjs"]).absent).to.deep.equal(["test/gone.mjs"]);
    expect(listDrift(["test/a.mjs"], ["./test/a.mjs"]), "a leading ./ is the same file").to.deep.equal({unlisted: [], absent: []});
  });
});


describe("suite sharding", () => {
  it("partitions the real list into six disjoint shards", () => {
    const files = loadSuites().files;
    const seconds = JSON.parse(readFileSync("test/suites-timings.json", "utf8"));
    const all = assignShards(files, seconds, 6).flatMap((shard) => shard.files);
    expect(all.slice().sort()).to.deep.equal(files.slice().sort());
    expect(new Set(all).size).to.equal(files.length);
    expect(all).not.to.include("test/vscode-vsix-packaging.mjs");
  });
  it("rejects an unknown group", () => {
    const run = spawnSync(process.execPath, ["tools/osd-suites.mjs", "--group", "missing"], {encoding: "utf8"});
    expect(run.status).to.equal(2);
    expect(run.stderr).to.contain("unknown suite group missing");
  });
  it("covers every file exactly once and assigns unknown files the median weight", () => {
    const files = ["a", "b", "c", "d", "new"];
    const shards = assignShards(files, {a: 20, b: 8, c: 4, d: 2}, 4);
    const all = shards.flatMap((shard) => shard.files);
    expect(all.slice().sort()).to.deep.equal(files.slice().sort());
    expect(new Set(all).size).to.equal(files.length);
    expect(all).to.include("new");
    expect(shards.reduce((sum, shard) => sum + shard.seconds, 0)).to.equal(40);
    expect(assignShards(files.slice().reverse(), {a: 20, b: 8, c: 4, d: 2}, 4).map((s) => s.files.slice().sort()))
      .to.deep.equal(shards.map((s) => s.files.slice().sort()));
  });
});


describe("bounded file retries", () => {
  const execute = realRunWithRetries;
  const runWithRetries = (files, run, options) => execute(files, (selected, phase) => ({
    ...run(selected, phase),
    fileTests: Object.fromEntries(selected.map((file) => [file, {registered: 1, passed: 1, pending: 0, failed: 0}])),
    tests: Object.fromEntries(selected.map((file) => [file, [{titlePath: ["first failure"], outcome: "passed"}]])),
  }), options);
  const failed = (files) => ({status: 1, completed: true, internalRetries: [], totalFailures: files.length,
    failures: files.map((file) => ({file, title: "first failure"}))});
  const passed = {status: 0, completed: true, internalRetries: [], totalFailures: 0, failures: []};
  it("retries a whole group together rather than recovering files separately", () => {
    const calls = [];
    const result = runWithRetries(["a", "b"], (files, phase) => {
      calls.push(files);
      return phase === "first" || files.length === 2 ? failed(["a"]) : passed;
    }, {group: "shared"});
    expect(result.status).to.equal(1);
    expect(calls).to.deep.equal([["a", "b"], ["a", "b"]]);
  });
  it("does not rerun a passing shard", () => {
    const calls = [];
    expect(runWithRetries(["a"], (files) => { calls.push(files); return passed; }).status).to.equal(0);
    expect(calls).to.deep.equal([["a"]]);
  });
  it("retries each failing file once alone, preserving its first title", () => {
    const calls = [];
    const result = runWithRetries(["a", "b", "c"], (files, phase) => {
      calls.push(files);
      return phase === "first" ? failed(["b", "c"]) : passed;
    });
    expect(calls).to.deep.equal([["a", "b", "c"], ["b"], ["c"]]);
    expect(result.status).to.equal(0);
    expect(result.lines.join("\n")).to.contain("flaky / order-dependent: `b` — first failure");
  });
  it("keeps a persistent failure red even when another file recovers", () => {
    const result = runWithRetries(["a", "b"], (files, phase) => phase === "first" ? failed(files) : files[0] === "a" ? passed : failed(files));
    expect(result.status).to.equal(1);
    expect(result.retries).to.have.length(2);
    expect(result.lines).to.have.length(1);
  });
  it("permits exactly three failing files but refuses four", () => {
    for (const count of [3, 4]) {
      const files = Array.from({length: count}, (_, i) => String(i));
      const result = runWithRetries(files, (selected, phase) => phase === "first" ? failed(selected) : passed);
      expect(result.retries.length).to.equal(count === 3 ? 3 : 0);
      expect(result.status).to.equal(count === 3 ? 0 : 1);
    }
  });
  it("fails closed on a crash, missing metadata or unattributed hook failures", () => {
    for (const first of [{status: 1}, {...failed(["a"]), crashed: true}, {...failed(["a"]), completed: false}, failed([null]),
      failed(["unknown"]), {...failed(["a"]), totalFailures: 2}]) {
      const result = runWithRetries(["a"], () => first);
      expect(result.status).to.equal(1);
      expect(result.retries).to.deep.equal([]);
    }
  });
  it("does not accept a retry without a complete zero-failure report", () => {
    const result = runWithRetries(["a"], (_, phase) => phase === "first" ? failed(["a"]) : {status: 0});
    expect(result.status).to.equal(1);
  });
  it("deduplicates test and hook failures in one file", () => {
    const result = runWithRetries(["a"], (_, phase) => phase === "first" ? failed(["a", "a"]) : passed);
    expect(result.retries).to.have.length(1);
    expect(result.status).to.equal(0);
  });
});

describe("timing weights", () => {
  it("uses longest first with deterministic ties and preserves execution order", () => {
    const shards = assignShards(["c", "b", "a", "d"], {a: 10, b: 10, c: 2, d: 2}, 2);
    expect(shards).to.deep.equal([{files: ["c", "a"], seconds: 12}, {files: ["b", "d"], seconds: 12}]);
  });
  it("uses a median for invalid or absent timings and one second for an empty seed", () => {
    expect(assignShards(["a", "b", "c"], {a: 2, b: -1}, 1)[0].seconds).to.equal(6);
    expect(assignShards(["a"], {}, 1)[0].seconds).to.equal(1);
    expect(() => assignShards([], {}, 0)).to.throw("positive");
  });
  it("merges partial artifacts, using the median across runs and ignoring retry metadata", () => {
    expect(mergeTimings({"test/old.mjs": 7}, [
      {seconds: {"test/a.mjs": 4}, retries: [{seconds: 999}]},
      {seconds: {"test/a.mjs": 8}},
    ])).to.deep.equal({"test/a.mjs": 6, "test/old.mjs": 7});
    expect(() => mergeTimings({}, [{seconds: {"test/a.mjs": -1}}])).to.throw("invalid timing");
  });
});


describe("weekly timing refresh", () => {
  const repository = "oisee/open-steamgate";
  const trusted = {event: "push", head_branch: "main", repository: {full_name: repository}, conclusion: "success"};
  it("filters main pushes in the API and rechecks each run immediately before download", () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-trusted-timings-"));
    const calls = [];
    const sample = {seconds: {"test/a.mjs": 60}};
    try {
      const gh = (args) => {
        calls.push(args);
        if (calls.length === 1) return JSON.stringify({workflow_runs: [{id: 1}, {id: 2}]});
        if (args[0] === "api") return JSON.stringify(trusted);
        const artifact = join(args.at(-1), "suite-results-1-attempt-1");
        mkdirSync(artifact, {recursive: true});
        writeFileSync(join(artifact, "timings.json"), JSON.stringify(sample));
      };
      expect(downloadTrustedTimings(gh, repository, dir)).to.deep.equal([sample, sample]);
      expect(calls).to.deep.equal([
        ["api", `repos/${repository}/actions/workflows/tests.yml/runs?event=push&branch=main&status=success&per_page=5`],
        ...[1, 2].flatMap((id) => [
          ["api", `repos/${repository}/actions/runs/${id}`],
          ["run", "download", String(id), "--repo", repository, "--pattern", "suite-results-*", "--dir", join(dir, String(id))],
        ]),
      ]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
  for (const [field, value] of [["event", "pull_request"], ["head_branch", "feature"],
    ["repository", {full_name: "other/open-steamgate"}], ["repository", undefined], ["conclusion", "failure"]]) {
    it(`refuses untrusted ${field} metadata before downloading`, () => {
      const calls = [];
      const gh = (args) => {
        calls.push(args);
        return JSON.stringify(calls.length === 1 ? {workflow_runs: [{id: 1}]} : {...trusted, [field]: value});
      };
      expect(() => downloadTrustedTimings(gh, repository, "/unused")).to.throw("Untrusted timing run 1");
      expect(calls.map((args) => args[0])).to.deep.equal(["api", "api"]);
    });
  }
  const files = ["test/a.mjs", "test/b.mjs", "test/c.mjs", "test/d.mjs"];
  const old = Object.fromEntries(files.map((file) => [file, 60]));
  it("does not refresh balanced growth and uses a strict two-minute threshold", () => {
    expect(timingDrift(files, old, Object.fromEntries(files.map((f) => [f, 300])), 2).refresh).to.equal(false);
    const boundary = {...old, "test/a.mjs": 300};
    expect(timingDrift(files, old, boundary, 2).drift).to.equal(120);
    expect(timingDrift(files, old, boundary, 2).refresh).to.equal(false);
    expect(timingDrift(files, old, {...boundary, "test/a.mjs": 302}, 2).refresh).to.equal(true);
  });
  it("detects stale assignment imbalance that a fresh assignment would hide", () => {
    const result = timingDrift(files, old, {...old, "test/a.mjs": 400, "test/c.mjs": 400}, 2);
    expect(result.current).to.deep.equal([800, 120]);
    expect(result.balanced).to.deep.equal([460, 460]);
    expect(result.refresh).to.equal(true);
  });
  it("refreshes missing or invalid timings even with balanced shards", () => {
    for (const value of [undefined, 0, -1, NaN]) {
      expect(timingDrift(files, {...old, "test/a.mjs": value}, old, 2).missing).to.deep.equal(["test/a.mjs"]);
    }
    const result = timingDrift(files, old, {"test/a.mjs": 60}, 2);
    expect(result.refresh).to.equal(true);
    expect(result.missing).to.have.length(3);
    expect(result.balanced).to.deep.equal([120, 120]);
  });
  it("takes the latest retained attempt once per shard and refuses no evidence", () => {
    expect(latestShardArtifacts(["suite-results-1-attempt-1", "suite-results-1-attempt-2",
      "suite-results-2-attempt-1", "built-tree"])).to.deep.equal(["suite-results-1-attempt-2", "suite-results-2-attempt-1"]);
    expect(() => latestShardArtifacts(["built-tree"])).to.throw("No shard timing artifacts");
  });
});


function fixtureRun(source, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "osd-fail-closed-"));
  const file = relative(process.cwd(), join(dir, "fixture.mjs"));
  writeFileSync(file, source);
  const reports = [];
  try {
    const result = runWithRetries([file], (files) => {
      const output = join(dir, `report-${reports.length}.json`);
      const child = spawnSync(process.execPath, ["node_modules/mocha/bin/mocha.js", ...files,
        "--reporter", "tools/osd-suite-timing-reporter.cjs", "--retries", "0",
        ...(options.allowInternalRetries ? [] : ["--require", "tools/osd-suite-no-retries.cjs"]), ...(options.extra ?? [])],
        {encoding: "utf8", env: {...process.env, OSD_SUITE_TIMINGS_FILE: output}});
      const metadata = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : {};
      reports.push({...metadata, stdout: child.stdout});
      return {...metadata, status: child.status};
    }, options);
    return {result, reports};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

describe("fail closed regressions", () => {
  it("keeps packaging failures red without an unpublished recovery", () => {
    const {result, reports} = fixtureRun('import {existsSync, writeFileSync} from "node:fs"; const marker = new URL("./marker", import.meta.url); describe("packaging", () => { it("transient failure", () => { if (!existsSync(marker)) { writeFileSync(marker, "failed"); throw Error("first"); } }); });', {group: "packaging"});
    expect(result.status).to.equal(1);
    expect(reports).to.have.length(1);
    expect(result.lines).to.deep.equal([]);
  });
  it("accepts explicitly all-pending files and records their counts", () => {
    const {result, reports} = fixtureRun('describe.skip("optional", () => { it("requires local data", () => {}); });');
    expect(result.status).to.equal(0);
    expect(Object.values(reports[0].fileTests)).to.deep.equal([{registered: 1, passed: 0, pending: 1, failed: 0}]);
  });
  it("counts a test that chdirs into a scratch root under its own file", () => {
    const {result, reports} = fixtureRun('import {mkdtempSync, rmSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; let cwd, dir; describe("moves", () => { beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "osd-chdir-")); process.chdir(dir); }); afterEach(() => { process.chdir(cwd); rmSync(dir, {recursive: true, force: true}); }); it("passes while elsewhere", () => {}); });');
    expect(Object.values(reports[0].fileTests)).to.deep.equal([{registered: 1, passed: 1, pending: 0, failed: 0}]);
    expect(result.status).to.equal(0);
  });
  it("rejects an empty first run", () => {
    expect(fixtureRun('describe("empty", () => {});').result.status).to.equal(1);
  });
  it("rejects recovery when the isolated retry registers zero tests", () => {
    const {result, reports} = fixtureRun('import {existsSync, writeFileSync} from "node:fs"; const marker = new URL("./marker", import.meta.url); describe("empty retry", () => { if (!existsSync(marker)) it("first failure", () => { writeFileSync(marker, "failed"); throw Error("first"); }); });');
    expect(reports).to.have.length(2);
    expect(result.status).to.equal(1);
    expect(result.lines).to.deep.equal([]);
  });
  for (const replacement of [false, true]) {
    it(`rejects a vanished failing test${replacement ? " even when replaced at the same count" : ""}`, () => {
      const {result, reports} = fixtureRun(`import {existsSync, writeFileSync} from "node:fs";
        const marker = new URL("./marker", import.meta.url);
        const retried = existsSync(marker);
        describe("identity fixture", () => {
          it("always passes", () => {});
          if (!retried) it("original failure", () => { writeFileSync(marker, "failed"); throw Error("first"); });
          ${replacement ? 'if (retried) it("replacement", () => {});' : ''}
        });`);
      expect(reports).to.have.length(2);
      expect(Object.values(reports[0].fileTests)[0].registered).to.equal(2);
      expect(Object.values(reports[1].fileTests)[0].registered).to.equal(replacement ? 2 : 1);
      expect(result.status).to.equal(1);
      expect(result.lines.join("\n")).to.contain("vanished").and.contain("original failure");
      expect(result.lines.join("\n")).not.to.contain("passed once");
    });
  }
  for (const group of [undefined, "shared"]) {
    it(`rejects a previously failing test that turns pending on ${group ? "group" : "isolated"} retry`, () => {
      const {result, reports} = fixtureRun(`import {existsSync, writeFileSync} from "node:fs";
        const marker = new URL("./marker", import.meta.url);
        describe("pending recovery", () => { it("must pass", function () {
          if (existsSync(marker)) this.skip();
          writeFileSync(marker, "failed"); throw Error("first");
        }); });`, {group});
      expect(reports).to.have.length(2);
      expect(Object.values(reports[1].fileTests)[0]).to.deep.equal({registered: 1, passed: 0, pending: 1, failed: 0});
      expect(result.status).to.equal(1);
      expect(result.lines.join("\n")).to.contain("pending").and.contain("must pass");
      expect(result.lines.join("\n")).not.to.contain("passed once");
    });
  }
  it("prevents test-level retries from silently recovering", () => {
    const {result} = fixtureRun('let attempts = 0; describe("retry fixture", function () { this.retries(2); it("recovers internally", function () { this.retries(2); if (++attempts < 3) throw Error("retry"); }); });');
    expect(result.status).to.equal(1);
    expect(result.lines).to.deep.equal([]);
  });
  it("fails red and names any internal retry observed by the reporter", () => {
    const {result, reports} = fixtureRun('let attempts = 0; describe("retry event", () => { it("unexpected retry", function () { this.retries(2); if (++attempts < 3) throw Error("retry"); }); });', {allowInternalRetries: true});
    expect(result.status).to.equal(1);
    expect(reports[0].internalRetries[0].title).to.equal("retry event unexpected retry");
  });
  it("rejects a failing test followed by process.exit(0)", () => {
    const {result, reports} = fixtureRun('describe("exit fixture", () => { it("fails", () => { throw Error("failure"); }); after(() => process.exit(0)); });');
    expect(reports[0].completed).to.equal(undefined);
    expect(result.status).to.equal(1);
    expect(result.lines).to.deep.equal([]);
  });
  it("never recovers a process isolation failure in a clean retry", () => {
    const attempts = [];
    const result = runWithRetries(["test/leaking.mjs"], (files, phase) => {
      attempts.push(phase);
      return {status: 1, failures: [{file: files[0], title: "process invariants", isolation: true}]};
    });
    expect(result.status).to.equal(1);
    expect(attempts).to.deep.equal(["first"]);
    expect(result.retries).to.deep.equal([]);
  });
  it("rejects zero exit with inconsistent failure metadata", () => {
    for (const metadata of [{status: 0}, {status: 0, completed: true, failures: [], totalFailures: 1},
      {status: 0, completed: true, failures: [{file: "a", title: "bad"}], totalFailures: 0}]) {
      expect(runWithRetries(["a"], () => metadata).status).to.equal(1);
    }
  });
});

describe("early-stop CLI regressions", () => {
  it("disables bail retries even when only the failing file was selected", () => {
    const {result, reports} = fixtureRun(`import {existsSync, writeFileSync} from "node:fs";
      const marker = new URL("./marker", import.meta.url);
      describe("single bail", () => { it("transient", () => {
        if (!existsSync(marker)) { writeFileSync(marker, "failed"); throw Error("first"); }
      }); });`, {extra: ["--bail"]});
    expect(result.status).to.equal(1);
    expect(reports).to.have.length(1);
    expect(reports[0].bail).to.equal(true);
  });
  it("refuses recovery when another file has unaccounted tests without a bail flag", () => {
    const result = runWithRetries(["a", "z"], (files, phase) => ({
      status: phase === "first" ? 1 : 0, completed: true, internalRetries: [],
      totalFailures: phase === "first" ? 1 : 0,
      failures: phase === "first" ? [{file: "a", title: "transient"}] : [],
      fileTests: Object.fromEntries(files.map((file) => [file, {registered: 1,
        passed: phase === "retry" ? 1 : 0, failed: phase === "first" && file === "a" ? 1 : 0, pending: 0}])),
      tests: Object.fromEntries(files.map((file) => [file, [{titlePath: [file === "a" ? "transient" : "unexecuted"],
        outcome: phase === "retry" ? "passed" : file === "a" ? "failed" : null}]])),
    }));
    expect(result.status).to.equal(1);
    expect(result.retries).to.deep.equal([]);
    expect(result.lines.join("\n")).to.contain("unexecuted").and.contain("z");
  });
  for (const option of ["--bail", "-b", "--bail=true", "config"]) {
    it(`disables recovery for ${option}, retaining an unexecuted later failure`, function () {
      this.timeout(10000);
      const dir = mkdtempSync(join(tmpdir(), "osd-bail-cli-"));
      try {
        mkdirSync(join(dir, "tools"));
        mkdirSync(join(dir, "test", "suites.d"), {recursive: true});
        for (const file of ["osd-suites.mjs", "osd-suite-timing-reporter.cjs", "osd-suite-no-retries.cjs", "osd-test-isolation.cjs", "osd-test-resources.cjs", "osd-test-isolation-allow.json"])
          copyFileSync(join("tools", file), join(dir, "tools", file));
        symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
        for (const name of readdirSync("tools")) {
          if (name.endsWith(".mjs") && name !== "osd-suites.mjs") symlinkSync(resolve("tools", name), join(dir, "tools", name));
        }
        writeFileSync(join(dir, "test", "suites.d", "fixtures.json"), JSON.stringify({files: ["test/a.mjs", "test/z.mjs"]}));
        writeFileSync(join(dir, "test", "suites-timings.json"), "{}");
        writeFileSync(join(dir, "test", "a.mjs"), `import {existsSync, writeFileSync} from "node:fs";
          const marker = new URL("./marker", import.meta.url);
          describe("early", () => { it("transient", () => {
            if (!existsSync(marker)) { writeFileSync(marker, "failed"); throw Error("first"); }
          }); });`);
        writeFileSync(join(dir, "test", "z.mjs"), 'describe("later", () => { it("persistent failure", () => { throw Error("persistent"); }); });');
        if (option === "config") writeFileSync(join(dir, ".mocharc.json"), JSON.stringify({bail: true}));
        const child = spawnSync(process.execPath, ["tools/osd-suites.mjs", ...(option === "config" ? [] : [option]), "--timings", "first.json"],
          {cwd: dir, encoding: "utf8", env: {...process.env, GITHUB_STEP_SUMMARY: ""}});
        const first = JSON.parse(readFileSync(join(dir, "first.json"), "utf8"));
        expect(first.fileTests["test/z.mjs"]).to.deep.equal({registered: 1, passed: 0, pending: 0, failed: 0});
        expect(child.status, child.stdout + child.stderr).to.equal(1);
        expect(child.stdout).not.to.contain("osd-suites: retry");
        expect(child.stdout).not.to.contain("passed once");
      } finally { rmSync(dir, {recursive: true, force: true}); }
    });
  }
});

describe("Mocha file reports", () => {
  it("captures an order failure and retries the whole file with a fresh process", function () {
    this.timeout(10000);
    const dir = mkdtempSync(join(tmpdir(), "osd-reporter-"));
    try {
      const before = relative(process.cwd(), join(dir, "before.mjs"));
      const victim = relative(process.cwd(), join(dir, "victim.mjs"));
      writeFileSync(before, 'describe("before", () => { it("sets state", () => { globalThis.dirty = true; }); });');
      writeFileSync(victim, 'describe("victim", () => { it("clean state", () => { if (globalThis.dirty) throw Error("dirty"); }); it("also runs", () => {}); });');
      const reports = [];
      const result = runWithRetries([before, victim], (files) => {
        const output = join(dir, `report-${reports.length}.json`);
        const run = spawnSync(process.execPath, ["node_modules/mocha/bin/mocha.js", ...files,
          "--reporter", "tools/osd-suite-timing-reporter.cjs", "--retries", "0"],
          {encoding: "utf8", env: {...process.env, OSD_SUITE_TIMINGS_FILE: output}});
        const report = JSON.parse(readFileSync(output, "utf8"));
        reports.push(report);
        return {...report, status: run.status};
      });
      expect(result.status).to.equal(0);
      expect(reports).to.have.length(2);
      expect(reports[0].failures).to.deep.equal([{file: victim, title: "victim clean state"}]);
      expect(Object.keys(reports[0].seconds)).to.deep.equal([before, victim]);
      expect(reports[1].totalFailures).to.equal(0);
      expect(result.lines[0]).to.contain("order-dependent");
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
  it("attributes before hooks to their file", function () {
    this.timeout(10000);
    const dir = mkdtempSync(join(tmpdir(), "osd-hook-report-"));
    try {
      const file = relative(process.cwd(), join(dir, "hook.mjs"));
      const output = join(dir, "report.json");
      writeFileSync(file, 'describe("hook fixture", () => { before(() => { throw Error("hook failed"); }); it("never runs", () => {}); });');
      const run = spawnSync(process.execPath, ["node_modules/mocha/bin/mocha.js", file,
        "--reporter", "tools/osd-suite-timing-reporter.cjs"],
        {encoding: "utf8", env: {...process.env, OSD_SUITE_TIMINGS_FILE: output}});
      expect(run.status).to.equal(1);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report.completed).to.equal(true);
      expect(report.failures[0].file).to.equal(file);
      expect(report.failures[0].title).to.contain('"before all" hook');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
});


describe("required PR retry reports", () => {
  const workflow = readFileSync(".github/workflows/tests.yml", "utf8");
  const script = workflow.split("          script: |\n").at(-1).split("\n").map((line) => line.replace(/^            /, "")).join("\n");
  const expectedShards = workflow.match(/shard: \[(.*?)\]/)[1].split(',').map((s) => Number(s.trim()));
  const requiredResults = {build: {result: "success"}, suites: {result: "success"}, packaging: {result: "skipped"}, e2e: {result: "success"}, "osgo-host": {result: "success"}, "kernel-conformance": {result: "success"}, "adt-lifecycle": {result: "success"}};
  const execute = async (mode, attempt = 1, canComment = true) => {
    const lifecycleGate = mode === "lifecycle-skipped" ? "skip" : "run";
    const nativeRequire = createRequire(import.meta.url);
    const fs = nativeRequire("node:fs");
    const current = expectedShards.map((i) => `suite-results-${i}-attempt-${attempt}`);
    const mockedFs = {...fs,
      readdirSync: (dir) => {
        if (dir === "adt-lifecycle-results") return mode === "lifecycle-skipped" ? [] : [`adt-lifecycle-attempt-${mode === "stale-lifecycle-report" ? 1 : attempt}`];
        if (mode === "missing-directory") throw Error("ENOENT suite-results");
        if (mode === "missing-shard") return current.slice(0, 1);
        if (mode === "missing-rerun-report") return expectedShards.map((i) => `suite-results-${i}-attempt-1`);
        if (mode === "retained") return ["suite-results-1-attempt-2", ...expectedShards.map((i) => `suite-results-${i}-attempt-1`)];
        return current;
      },
      readFileSync: (file) => {
        if (file.startsWith("adt-lifecycle-results/")) return mode === "missing-lifecycle-report" ? "" :
          mode === "lifecycle-warning" ? "### ADT lifecycle: PASS\n\n#### Timing advisory: ⚠️ WARN\nABAP-FS/CLAS/activate-edit: 4000 ms, main 2000 ms, normalized 2.000x" :
          mode === "lifecycle-failed" ? "### ADT lifecycle: FAIL\nActive readback mismatch" : "### ADT lifecycle: PASS";
        if (mode === "unreadable") throw Error("unreadable report");
        return mode === "retained" && file.includes("suite-results-1-attempt-1") ? "flaky: earlier isolation recovery" : "";
      },
    };
    let body;
    const calls = [];
    const github = {
      paginate: async (method, args) => {
        if (method === github.rest.issues.listComments) return [];
        calls.push(args);
        if (args.attempt_number === 1 && attempt > 1) {
          if (mode === "api-error") throw Error("fixture API error");
          return [{name: "suites (1)", conclusion: "failure"}];
        }
        return [{name: "suites (1)", conclusion: "success"},
          {name: "kernel-conformance", conclusion: mode === "kernel-failed" ? "failure" : "success"},
          {name: "adt-lifecycle", conclusion: mode === "lifecycle-skipped" ? "skipped" : mode === "lifecycle-failed" ? "failure" : "success"}];
      },
      rest: {actions: {listJobsForWorkflowRunAttempt() {}}, issues: {
        listComments() {}, createComment(args) { body = args.body; }, updateComment(args) { body = args.body; },
      }},
    };
    const context = {repo: {owner: "fixture", repo: "fixture"}, payload: {pull_request: {head: {sha: "12345678"}}}, issue: {number: 1}, runId: 1};
    const results = structuredClone(requiredResults);
    if (mode === "kernel-failed") results["kernel-conformance"].result = "failure";
    if (mode === "lifecycle-skipped") results["adt-lifecycle"].result = "skipped";
    if (mode === "lifecycle-failed") results["adt-lifecycle"].result = "failure";
    if (mode.startsWith("missing-job:")) delete results[mode.slice("missing-job:".length)];
    try {
      await new (Object.getPrototypeOf(async function () {}).constructor)("require", "github", "context", "process", "console", script)(
        (name) => name === "node:fs" ? mockedFs : nativeRequire(name), github, context,
        {env: {EXPECTED_SHARDS: expectedShards.join(","), GITHUB_RUN_ATTEMPT: String(attempt), CAN_COMMENT: String(canComment), JOB_RESULTS: JSON.stringify(results), VSIX_PROFILE: "fast", ADT_LIFECYCLE: lifecycleGate}},
        {log() {}, error() {}});
    } catch (error) {
      error.body = body;
      throw error;
    }
    return {body, calls};
  };
  for (const mode of ["missing-directory", "missing-shard", "unreadable", "missing-lifecycle-report"]) {
    it(`fails publication for ${mode}`, async () => {
      let error;
      try { await execute(mode); } catch (caught) { error = caught; }
      expect(error, "publication must fail closed").to.be.instanceOf(Error);
    });
  }
  it("rejects old lifecycle evidence when the job ran in the new attempt", async () => {
    let error; try { await execute("stale-lifecycle-report",2); } catch(caught) { error=caught; }
    expect(error?.message).to.equal("Missing current lifecycle measurements");
  });
  it("accepts every shard’s readable empty report", async () => { await execute("complete"); });
  it("accepts a lifecycle job the gate skipped, with no measurements", async () => {
    const {body} = await execute("lifecycle-skipped");
    expect(body).to.contain("| adt-lifecycle | ⚪ skipped |");
    expect(body).not.to.contain("🔴 fail");
  });
  it("keeps lifecycle timing warnings visible with a green functional row and PR gate", async () => {
    const {body} = await execute("lifecycle-warning");
    expect(body).to.contain("### PR tests: 🟢 pass").and.contain("| adt-lifecycle | 🟢 pass |");
    expect(body).to.contain("Timing advisory: ⚠️ WARN").and.contain("normalized 2.000x");
  });
  it("shows functional lifecycle failures as red in the PR row and gate", async () => {
    const {body} = await execute("lifecycle-failed");
    expect(body).to.contain("### PR tests: 🔴 fail").and.contain("| adt-lifecycle | 🔴 fail |");
    expect(body).to.contain("Active readback mismatch");
  });
  it("reports a failed required kernel job as red", async () => {
    const {body} = await execute("kernel-failed");
    expect(body).to.contain("### PR tests: 🔴 fail");
    expect(body).to.contain("| kernel-conformance | 🔴 fail |");
    const gate = workflow.split("  test:\n")[1].split("  # One comment")[0];
    const shell = gate.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^          /, "")).join("\n");
    const env = {...process.env, BUILD_RESULT: "success", SUITES_RESULT: "success", E2E_RESULT: "success", OSGO_RESULT: "success", PACKAGING_RESULT: "skipped", VSIX_PROFILE: "fast", ADT_LIFECYCLE: "run", EVENT_NAME: "pull_request", REPORT_RESULT: "success", LIFECYCLE_RESULT: "success"};
    expect(spawnSync("bash", ["-e", "-c", shell], {env: {...env, KERNEL_RESULT: "success"}}).status).to.equal(0);
    expect(spawnSync("bash", ["-e", "-c", shell], {env: {...env, KERNEL_RESULT: "failure"}}).status).to.equal(1);
  });
  it("rejects a failed lifecycle job in the required gate", () => {
    const gate = workflow.split("  test:\n")[1].split("  # One comment")[0];
    const shell = gate.split("        run: |\n")[1].split("\n").map(line => line.replace(/^          /, "")).join("\n");
    const env = {...process.env, BUILD_RESULT:"success", SUITES_RESULT:"success", E2E_RESULT:"success", OSGO_RESULT:"success", KERNEL_RESULT:"success", PACKAGING_RESULT:"skipped", VSIX_PROFILE:"fast", EVENT_NAME:"pull_request", REPORT_RESULT:"success"};
    const run = (gate, result) => spawnSync("bash", ["-e", "-c", shell], {env:{...env,ADT_LIFECYCLE:gate,LIFECYCLE_RESULT:result}}).status;
    expect(run("run", "success")).to.equal(0);
    expect(run("run", "failure")).to.equal(1);
    // a skip is accepted only where the gate said skip, and only as skipped
    expect(run("skip", "skipped")).to.equal(0);
    expect(run("run", "skipped")).to.equal(1);
    expect(run("skip", "success")).to.equal(1);
    expect(run("run", "cancelled")).to.equal(1);
  });
  for (const job of Object.keys(requiredResults)) {
    it(`rejects a missing required job result: ${job}`, async () => {
      let error;
      try { await execute(`missing-job:${job}`, 1, false); } catch (caught) { error = caught; }
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal(`Missing required job result: ${job}`);
    });
  }
  it("shows failed jobs recovered by a GitHub rerun and retained flaky reports", async () => {
    const {body, calls} = await execute("retained", 2);
    expect(body).to.contain("flaky: rerun suites (1) failed in attempt 1, passed in attempt 2");
    expect(body).to.contain("flaky: earlier isolation recovery");
    expect(calls.map((c) => c.attempt_number)).to.deep.equal([2, 1]);
    expect(calls.every((c) => c.owner === "fixture" && c.repo === "fixture" && c.run_id === 1)).to.equal(true);
    expect(workflow).to.contain("name: suite-results-${{ matrix.shard }}-attempt-${{ github.run_attempt }}");
  });
  it("does not let retained evidence hide a missing report from a rerun shard", async () => {
    let error;
    try { await execute("missing-rerun-report", 2); } catch (caught) { error = caught; }
    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal("Missing current-attempt shard report 1");
  });
  it("queries every earlier attempt even without retained artifacts", async () => {
    const {body, calls} = await execute("complete", 3);
    expect(calls.map((c) => c.attempt_number)).to.deep.equal([3, 1, 2]);
    expect(body).to.contain("flaky: rerun suites (1) failed in attempt 1, passed in attempt 2");
  });
  for (const canComment of [true, false]) {
    it(`fails closed on unreadable earlier attempts (comments ${canComment})`, async () => {
      let error;
      try { await execute("api-error", 2, canComment); } catch (caught) { error = caught; }
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.equal("rerun: earlier attempts unreadable");
      if (canComment) {
        expect(error.body).to.contain("flaky: rerun: earlier attempts unreadable");
        expect(error.body).to.contain("### PR tests: 🔴 fail");
      }
    });
  }
  it("keeps expected reports in step with the shard matrix", () => {
    const shards = workflow.match(/shard: \[(.*?)\]/)[1].split(',').map((s) => s.trim());
    expect(workflow).to.contain(`EXPECTED_SHARDS: '${shards.join(',')}'`);
  });
  it("makes publication a PR prerequisite of the required test gate", () => {
    const gate = workflow.split("  test:\n")[1].split("  # One comment")[0];
    expect(gate).to.contain("pr-report]");
    expect(gate).to.contain('"$REPORT_RESULT" == success');
    const report = workflow.split("  pr-report:\n")[1];
    const needed = report.match(/needs: \[(.*?)\]/)[1].split(',').map((job) => job.trim());
    expect(needed.sort()).to.deep.equal(Object.keys(requiredResults).sort());
    expect(gate).to.contain("kernel-conformance");
    expect(gate).to.contain('"$KERNEL_RESULT" == success');
    expect(report).not.to.contain("continue-on-error: true");
    expect(report).not.to.contain("needs: [test]");
  });
});
