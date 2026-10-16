import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createReadStream} from "node:fs";
import {stampStagedPackage} from "../scripts/build-vsix.mjs";
import {root, timeVsixTests} from "./helpers/vsix.mjs";
const {writeTar, unpackTar, seedContentId} = createRequire(import.meta.url)("../editors/vscode/launcher.js");

describe("seed tar", function () {
  timeVsixTests();
  it("round-trips a long path and executable mode", async function () {
    const scratch = mkdtempSync(join(tmpdir(), "osd-tar-"));
    try {
      const source = join(scratch, "source");
      const dest = join(scratch, "dest");
      const name = `${"long/".repeat(24)}run.sh`;
      mkdirSync(join(source, "long/".repeat(24)), {recursive: true});
      writeFileSync(join(source, name), "#!/bin/sh\nexit 0\n", {mode: 0o755});
      const tar = join(scratch, "seed.tar");
      writeTar(source, tar);
      mkdirSync(dest);
      await unpackTar(createReadStream(tar), dest);
      expect(readFileSync(join(dest, name), "utf8")).to.equal("#!/bin/sh\nexit 0\n");
      expect(lstatSync(join(dest, name)).mode & 0o777).to.equal(0o755);
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  });

  // Windows cannot keep POSIX permission bits (lstat reports 0o666/0o777), so
  // the packaged ID is checked against the modes the archive itself recorded.
  it("verifies a seed's content ID with the archive's modes when the file system lost them", async function () {
    const scratch = mkdtempSync(join(tmpdir(), "osd-tar-"));
    try {
      const source = join(scratch, "source");
      const dest = join(scratch, "dest");
      mkdirSync(join(source, "bin"), {recursive: true});
      writeFileSync(join(source, "bin", "run.sh"), "#!/bin/sh\nexit 0\n", {mode: 0o755});
      writeFileSync(join(source, "data.json"), "{}\n", {mode: 0o644});
      const seedId = seedContentId(source);
      const tar = join(scratch, "seed.tar");
      writeTar(source, tar);
      mkdirSync(dest);
      const modes = await unpackTar(createReadStream(tar), dest);
      expect(modes.get("bin/run.sh")).to.equal(lstatSync(join(source, "bin", "run.sh")).mode & 0o7777);
      chmodSync(join(dest, "bin", "run.sh"), 0o666);
      chmodSync(join(dest, "data.json"), 0o666);
      expect(seedContentId(dest, modes)).to.equal(seedId);
      if (process.platform !== "win32") expect(seedContentId(dest)).to.not.equal(seedId);
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  });

  it("rejects traversal before writing outside the destination", async function () {
    const scratch = mkdtempSync(join(tmpdir(), "osd-tar-"));
    try {
      const source = join(scratch, "source");
      mkdirSync(source);
      writeFileSync(join(source, "safe"), "bad");
      const tar = join(scratch, "seed.tar");
      writeTar(source, tar);
      const bytes = readFileSync(tar);
      bytes.fill(0, 0, 100);
      bytes.write("../escaped", 0);
      bytes.fill(32, 148, 156);
      const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
      bytes.write(`${sum.toString(8).padStart(6, "0")}\0`, 148);
      const dest = join(scratch, "dest");
      mkdirSync(dest);
      let error;
      try { await unpackTar([bytes], dest); } catch (caught) { error = caught; }
      expect(error?.message).to.match(/unsafe tar path/);
      expect(existsSync(join(scratch, "escaped"))).to.equal(false);
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  });

  it("closes an extracted file when the tar stream ends mid-file", async function () {
    if (!existsSync("/proc/self/fd")) this.skip();
    const scratch = mkdtempSync(join(tmpdir(), "osd-tar-truncated-"));
    try {
      const source = join(scratch, "source");
      const dest = join(scratch, "dest");
      mkdirSync(source);
      mkdirSync(dest);
      writeFileSync(join(source, "partial.txt"), "abcdef");
      const tar = join(scratch, "seed.tar");
      writeTar(source, tar);
      const before = readdirSync("/proc/self/fd").length;
      let error;
      try { await unpackTar([readFileSync(tar).subarray(0, 515)], dest); } catch (caught) { error = caught; }
      expect(error?.message).to.match(/truncated tar archive/);
      expect(readdirSync("/proc/self/fd").length).to.equal(before);
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  });
});

describe("packaging version stamp", function () {
  timeVsixTests();
  it("stamps the staged package with the commit count and leaves the tracked package untouched", function () {
    const trackedPath = join(root, "editors", "vscode", "package.json");
    const trackedBefore = readFileSync(trackedPath, "utf8");
    const [major, minor] = JSON.parse(trackedBefore).version.split(".");
    const scratch = mkdtempSync(join(tmpdir(), "osd-vsix-version-"));
    try {
      const stagedPath = join(scratch, "package.json");
      copyFileSync(trackedPath, stagedPath);
      const {pkg} = stampStagedPackage(stagedPath, root);
      const commitCount = execFileSync("git", ["rev-list", "--count", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
      expect(pkg.version).to.equal(`${major}.${minor}.${commitCount}`);
      expect(JSON.parse(readFileSync(stagedPath, "utf8")).version).to.equal(pkg.version);
      expect(readFileSync(trackedPath, "utf8")).to.equal(trackedBefore);
    } finally {
      rmSync(scratch, {recursive: true, force: true});
    }
  });
});
