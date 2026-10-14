// P0 raw-output contract, registered in groups.gogen and run by gogen CI.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {compareBytes} from "../tools/gogen/typing-proof.mjs";

describe("gogen typing byte proof", function () {
  this.timeout(600000);
  let scratch;
  before(() => {
    mkdirSync(".local", {recursive: true});
    scratch = relative(process.cwd(), mkdtempSync(join(process.cwd(), ".local/typing-proof-suite-")));
  });
  after(() => rmSync(scratch, {recursive: true, force: true}));

  it("records and compares both sink modes and all three cache modes", () => {
    const target = join(scratch, "parent");
    for (const action of ["--record", "--compare"]) {
      const run = spawnSync(process.execPath, [...process.execArgv, "tools/gogen/typing-proof.mjs", action, target],
        {encoding: "utf8", timeout: 290000, maxBuffer: 4e6});
      assert.equal(run.error, undefined);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal((run.stdout.match(/byte-identical artifacts/g) ?? []).length, 6, run.stdout);
    }
  });

  it("rejects whitespace, CRLF, numeric spelling, absent fields, ordering and file-set drift", () => {
    const before = join(scratch, "before"), after = join(scratch, "after");
    mkdirSync(before); mkdirSync(after);
    writeFileSync(join(before, "raw"), '{"a":1,"b":null}\n');
    writeFileSync(join(after, "raw"), '{"a":1,"b":null}\n');
    assert.equal(compareBytes(before, after), 1);
    for (const changed of ['{ "a":1,"b":null}\n', '{"a":1,"b":null}\r\n', '{"a":1.0,"b":null}\n', '{"a":1}\n', '{"b":null,"a":1}\n']) {
      writeFileSync(join(after, "raw"), changed);
      assert.throws(() => compareBytes(before, after), /raw: bytes differ at/);
    }
    writeFileSync(join(after, "extra"), "");
    assert.throws(() => compareBytes(before, after), /artifact list differs/);
    rmSync(join(after, "extra")); rmSync(join(after, "raw"));
    assert.throws(() => compareBytes(before, after), /artifact list differs/);
  });
});
