// The size budget's rules (tools/osd-size-budget.mjs) on made-up sizes: a
// breach, a new file in go/abap, an oversize file, a package without a
// README or importing go/abap, a raise without a reason, and --update
// lowering budgets but never recording what needs a reason; and --changed,
// the pre-push mode, blocking only on what the branch touched, run for real
// in a throwaway repository. The tree itself
// is not checked here: a breach stops a push (.githooks/pre-push) and is
// advisory in CI (Alice, 2026-10-02), never a red suite.
import {expect} from "chai";
import {execFileSync, spawnSync} from "node:child_process";
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {attribute, check, checkKeyed, update} from "../tools/osd-size-budget.mjs";

const base = () => ({
  fileLimits: {go: 800, mjs: 1000},
  watched: ["tools/big.mjs"],
  budgets: {
    "go:abap": {lines: 100, reason: "b"},
    "tools/gogen/go/abap/a.go": {lines: 100, reason: "b"},
    "tools/big.mjs": {lines: 2000, reason: "b"},
    "go:enq": {lines: 50, reason: "b"},
  },
  readmeMissing: [],
  importsAbap: {},
});

describe("the size budget", function () {
  it("passes what is within", () => {
    expect(check(base(), {"go:abap": 100, "tools/gogen/go/abap/a.go": 100, "tools/big.mjs": 1999})).to.deep.equal([]);
  });

  it("fails a file or package over its budget, naming both numbers", () => {
    const errors = check(base(), {"go:abap": 101, "tools/big.mjs": 2001});
    expect(errors).to.have.length(2);
    expect(errors[0]).to.match(/go:abap: 101 lines, budget 100 -- carve it/);
  });

  it("gives a new file in go/abap budget 0", () => {
    const errors = check(base(), {"tools/gogen/go/abap/new.go": 3});
    expect(errors[0]).to.match(/a new file in go\/abap \(budget 0\)/);
  });

  it("wants a budget for an oversize file and for a new package", () => {
    const errors = check(base(), {"tools/gogen/go/x/y.go": 801, "tools/z.mjs": 1001, "tools/z.ts": 1001, "go:x": 801});
    expect(errors.join("\n")).to.match(/y\.go: 801 lines, over 800/).and.match(/z\.mjs: 1001 lines, over 1000/).and.match(/z\.ts: 1001 lines, over 1000/).and.match(/go:x: a package without a budget/);
  });

  it("refuses a raise without a new reason against the base", () => {
    const now = base();
    now.budgets["go:abap"] = {lines: 120, reason: "b"};
    expect(check(now, {"go:abap": 110}, {base: base()})[0]).to.match(/budget raised 100 -> 120 without a new reason/);
    now.budgets["go:abap"].reason = "the SQL layer moved in from cmd/osgo (#999)";
    expect(check(now, {"go:abap": 110}, {base: base()})).to.deep.equal([]);
  });

  it("wants a reason for a big new budget the base did not have (a renamed package that grew)", () => {
    const now = base();
    now.budgets["go:cmd/osgo2"] = {lines: 1879, reason: "recorded by --update"};
    expect(check(now, {"go:cmd/osgo2": 1879}, {base: base()}).join("\n")).to.match(/a new budget of 1879 lines without a reason/);
    now.budgets["go:cmd/osgo2"].reason = "cmd/osgo renamed and given the gateway's routes (#999)";
    expect(check(now, {"go:cmd/osgo2": 1879}, {base: base()})).to.deep.equal([]);
  });

  it("lets the exemption lists and the limits only shrink against the base", () => {
    const now = base();
    now.readmeMissing = ["enq"];
    now.importsAbap = {enq: "why not"};
    now.fileLimits = {go: 900, mjs: 1000};
    now.watched = [];
    const errors = check(now, {}, {base: base()}).join("\n");
    expect(errors).to.match(/readmeMissing: enq added/).and.match(/importsAbap: enq added/).and.match(/fileLimits.go raised/);
  });

  it("refuses a dependency on go/abap unless the package is exempt", () => {
    const deps = new Map([["enq", true]]);
    expect(check(base(), {"go:enq": 10}, {deps}).join("\n")).to.match(/enq: depends on osg\/gogen\/abap/);
    const b = base();
    b.importsAbap.enq = "baseline";
    expect(check(b, {"go:enq": 10}, {deps}).join("\n")).to.not.match(/depends on/);
  });

  it("lowers budgets on --update and records new packages, never a go/abap file", () => {
    const b = update(base(), {"go:abap": 90, "tools/gogen/go/abap/a.go": 90, "tools/gogen/go/abap/new.go": 5, "go:fresh": 20, "tools/big.mjs": 1500, "go:enq": 50});
    expect(b.budgets["go:abap"].lines).to.equal(90);
    expect(b.budgets["tools/big.mjs"].lines).to.equal(1500);
    expect(b.budgets["go:fresh"]).to.include({lines: 20});
    expect(b.budgets["tools/gogen/go/abap/new.go"]).to.equal(undefined);
  });

  it("attributes a breach to the branch only when it touched the file or the package", () => {
    const keyed = checkKeyed(base(), {"go:abap": 101, "tools/gogen/go/abap/a.go": 101, "tools/big.mjs": 2001});
    const {own, inherited} = attribute(keyed, new Set(["tools/gogen/go/abap/b.go"]));
    expect(own).to.have.length(1);
    expect(own[0]).to.match(/^go:abap: 101/);
    expect(inherited.join("\n")).to.match(/a\.go: 101/).and.match(/big\.mjs: 2001/);
    // a file in a sub-package is not the parent package's
    expect(attribute(keyed, new Set(["tools/gogen/go/abap/sub/c.go"])).own).to.deep.equal([]);
    // an edit of the budget file is judged against the base: always the branch's
    const now = base();
    now.budgets["go:abap"] = {lines: 120, reason: "b"};
    expect(attribute(checkKeyed(now, {}, {base: base()}), new Set()).own[0]).to.match(/budget raised/);
  });

  it("charges the branch for a breach it caused through the budget file, and for a transitive go/abap dependency", () => {
    const now = base();
    now.budgets["tools/big.mjs"] = {lines: 1500, reason: "b"};
    const keyed = checkKeyed(now, {"tools/big.mjs": 1600});
    expect(attribute(keyed, new Set(["tools/osd-size-budget.json"]), {budget: now, base: base()}).own).to.have.length(1);
    delete now.budgets["tools/big.mjs"];
    expect(attribute(checkKeyed(now, {"tools/big.mjs": 1600}), new Set(), {budget: now, base: base()}).own[0]).to.match(/over 1000 without a budget/);
    const deps = checkKeyed(base(), {"go:enq": 10}, {deps: new Map([["enq", true]])});
    expect(attribute(deps, new Set(["tools/gogen/go/other/x.go"])).own[0]).to.match(/enq: depends/);
    expect(attribute(deps, new Set(["docs/a.md"])).inherited[0]).to.match(/enq: depends/);
  });

  describe("--changed in a repository", function () {
    this.timeout(20000);
    let dir;
    const git = (...a) => execFileSync("git", a, {cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
    const run = () => {
      const env = {...process.env};
      delete env.CI;
      delete env.GITHUB_ACTIONS;
      return spawnSync(process.execPath, ["tools/osd-size-budget.mjs", "--changed", "main"], {cwd: dir, encoding: "utf8", env});
    };
    const write = (file, n) => writeFileSync(join(dir, file), "x\n".repeat(n));

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "osd-size-budget-"));
      mkdirSync(join(dir, "tools", "gogen", "go"), {recursive: true});
      copyFileSync(new URL("../tools/osd-size-budget.mjs", import.meta.url), join(dir, "tools", "osd-size-budget.mjs"));
      writeFileSync(join(dir, "tools", "osd-size-budget.json"), JSON.stringify({
        fileLimits: {go: 800, mjs: 1000}, watched: [], readmeMissing: [], importsAbap: {},
        budgets: {"tools/big.mjs": {lines: 1100, reason: "b"}, "tools/other.mjs": {lines: 1100, reason: "b"}},
      }));
      write("tools/big.mjs", 1100);
      write("tools/other.mjs", 1100);
      git("init", "-q", "-b", "main");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
      // main breaks the budget after the branch left it (CI is advisory)
      git("checkout", "-q", "-b", "topic");
      git("checkout", "-q", "main");
      write("tools/big.mjs", 1103);
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "big grows on main");
      git("checkout", "-q", "topic");
      git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "main");
    });
    afterEach(() => rmSync(dir, {recursive: true, force: true}));

    it("lets an unrelated branch through past a breach already on main", () => {
      writeFileSync(join(dir, "README.md"), "unrelated\n");
      const r = run();
      expect(r.status, r.stderr).to.equal(0);
      expect(r.stderr).to.match(/does not touch \(on main already/).and.match(/big\.mjs: 1103 lines/);
    });

    it("does not charge the branch for a budget main raised without a reason", () => {
      git("checkout", "-q", "main");
      const b = JSON.parse(execFileSync("git", ["show", "HEAD:tools/osd-size-budget.json"], {cwd: dir, encoding: "utf8"}));
      b.budgets["tools/big.mjs"].lines = 1103;
      writeFileSync(join(dir, "tools", "osd-size-budget.json"), JSON.stringify(b));
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "raise on main, same reason");
      git("checkout", "-q", "topic");
      git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "main");
      const r = run();
      expect(r.status, r.stderr).to.equal(0);
      expect(r.stderr).to.not.match(/budget raised/);
    });

    it("judges the whole tree, raises included, when there is no merge base", () => {
      git("checkout", "-q", "--orphan", "lonely");
      const b = JSON.parse(execFileSync("git", ["show", "main:tools/osd-size-budget.json"], {cwd: dir, encoding: "utf8"}));
      b.budgets["tools/other.mjs"].lines = 1200;
      writeFileSync(join(dir, "tools", "osd-size-budget.json"), JSON.stringify(b));
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unrelated history");
      const r = run();
      expect(r.status).to.equal(1);
      expect(r.stderr).to.match(/no merge base/).and.match(/big\.mjs: 1103 lines/).and.match(/other\.mjs: budget raised 1100 -> 1200/);
    });

    it("measures tracked TypeScript and reports a breach of its budget", () => {
      const b = JSON.parse(execFileSync("git", ["show", "HEAD:tools/osd-size-budget.json"], {cwd: dir, encoding: "utf8"}));
      b.budgets["tools/typed.ts"] = {lines: 20, reason: "typed pilot fixture"};
      writeFileSync(join(dir, "tools", "osd-size-budget.json"), JSON.stringify(b));
      write("tools/typed.ts", 21);
      git("add", "tools/typed.ts");
      const r = run();
      expect(r.status, r.stderr).to.equal(1);
      expect(r.stderr).to.match(/tools\/typed\.ts: 21 lines, budget 20/);
    });

    it("applies the JavaScript file limit to unbudgeted TypeScript", () => {
      write("tools/typed.ts", 1001);
      git("add", "tools/typed.ts");
      const r = run();
      expect(r.status, r.stderr).to.equal(1);
      expect(r.stderr).to.match(/tools\/typed\.ts: 1001 lines, over 1000 without a budget/);
    });

    it("stops a branch that touches the file over its budget", () => {
      write("tools/big.mjs", 1104);
      const r = run();
      expect(r.status).to.equal(1);
      expect(r.stderr).to.match(/1 breach\(es\):\n {2}tools\/big\.mjs: 1104 lines/);
    });

    it("stops a branch's own breach elsewhere and still names main's as inherited", () => {
      write("tools/other.mjs", 1101);
      const r = run();
      expect(r.status).to.equal(1);
      expect(r.stderr).to.match(/other\.mjs: 1101 lines/).and.match(/on main already/);
    });
  });
});
