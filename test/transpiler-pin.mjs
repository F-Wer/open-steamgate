import {strict as assert} from "node:assert";
import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {installPin, pinPath} from "../tools/osd-transpiler-pin.mjs";
import {doctorWarmPin, probe, WARM_PIN_WARNING} from "../tools/osd-warm-capabilities.mjs";
import {hashOf, inputsOf} from "../tools/osd-build.mjs";
import {warmUp} from "../tools/osd-store-warm.mjs";
import {describeTranspiler, packageInUse} from "../tools/osd-transpiler.mjs";

function fixture() {
  // Checkouts used for shard validation may themselves be temporary. The
  // fixture's explicit pins must still live outside temporary storage.
  const base = resolve(process.env.OSD_PIN_TEST_ROOT ?? ".local");
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, "pin-test-"));
  const clone = join(root, "persistent");
  mkdirSync(clone);
  const put = (file, text) => { mkdirSync(join(clone, file, ".."), {recursive: true}); writeFileSync(join(clone, file), text); };
  for (const name of ["transpiler", "runtime", "extras", "cli"]) {
    put(`packages/${name}/package.json`, JSON.stringify({name: `@abaplint/${name}`, version: "0.0.0"}));
    put(`packages/${name}/node_modules/marker`, "installed");
    put(`packages/${name}/build/index.js`, "compiled");
  }
  put("packages/transpiler/build/src/index.js", "this.options?.only?.(obj) === false");
  put("packages/transpiler/build/src/types.d.ts", "only?:");
  put("packages/transpiler/build/src/validation.js", "reg.getConfig().get()) === JSON.stringify(conf.get())\nobj.setDirty()");
  put("packages/transpiler/node_modules/@abaplint/core/package.json", '{"version":"0.0.0"}');
  put("packages/cli/abap_transpile", "#!/bin/sh\nexit 0\n");
  chmodSync(join(clone, "packages/cli/abap_transpile"), 0o755);
  put("node_modules/marker", "installed");
  const git = (...args) => execFileSync("git", args, {cwd: clone, encoding: "utf8"}).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const ref = git("rev-parse", "HEAD");
  writeFileSync(join(root, "libs.lock.json"), JSON.stringify({transpiler: {repo: "test/transpiler", ref}, libraries: []}));
  return {root, clone, ref};
}

describe("local transpiler pin", () => {
  it("refuses temporary paths, scratchpads and symlinks into temporary storage", () => {
    assert.throws(() => pinPath("ref", {TRANSPILER: "/tmp/transpiler"}), /persistent/);
    assert.throws(() => pinPath("ref", {TRANSPILER: resolve("scratchpad/transpiler")}), /persistent/);
    const f = fixture();
    try {
      symlinkSync(tmpdir(), join(f.root, "alias"));
      assert.throws(() => pinPath(f.ref, {TRANSPILER: join(f.root, "alias", "pin")}), /persistent/);
      assert(pinPath(f.ref, {}).endsWith(`.cache/osd/transpiler-${f.ref}`));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("reuses a verified checkout without building and links all four CI packages", () => {
    const f = fixture();
    try {
      // No install/compile scripts exist: attempting a rebuild would fail.
      const before = readFileSync(join(f.clone, "packages/transpiler/build/src/index.js"), "utf8");
      installPin(f.root, {...process.env, TRANSPILER: f.clone});
      for (const [name, path] of [["transpiler", "packages/transpiler"], ["transpiler-cli", "packages/cli"],
        ["runtime", "packages/runtime"], ["core", "packages/transpiler/node_modules/@abaplint/core"]]) {
        assert.equal(realpathSync(join(f.root, "node_modules/@abaplint", name)), join(f.clone, path));
      }
      assert.equal(readFileSync(join(f.clone, "packages/transpiler/build/src/index.js"), "utf8"), before);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("refuses a checkout at the wrong ref before linking", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "libs.lock.json"), JSON.stringify({transpiler: {repo: "test/transpiler", ref: "0".repeat(40)}, libraries: []}));
      assert.throws(() => installPin(f.root, {...process.env, TRANSPILER: f.clone}), /build failed/);
      assert(!existsSync(join(f.root, "node_modules")));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("describes a linked build at the locked ref as pinned", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, "node_modules/@abaplint"), {recursive: true});
      symlinkSync(join(f.clone, "packages/transpiler"), join(f.root, "node_modules/@abaplint/transpiler"));
      assert.equal(describeTranspiler(f.root),
        `transpiler: the pinned build of test/transpiler ${f.ref.slice(0, 8)} (libs.lock.json), at ${join(f.clone, "packages/transpiler")}, calling itself 0.0.0`);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("ignores file-mode-only changes in a linked build", () => {
    const f = fixture();
    const executable = join(f.clone, "packages/cli/abap_transpile");
    try {
      mkdirSync(join(f.root, "node_modules/@abaplint"), {recursive: true});
      symlinkSync(join(f.clone, "packages/transpiler"), join(f.root, "node_modules/@abaplint/transpiler"));
      chmodSync(executable, 0o644);
      assert.equal(packageInUse(f.root, "transpiler").dirty, false);
      writeFileSync(executable, "#!/bin/sh\nexit 1\n");
      chmodSync(executable, 0o755);
      assert.equal(packageInUse(f.root, "transpiler").dirty, true);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  for (const fresh of [true, false]) {
    it(fresh ? "builds a missing pin through CI with fake npm" : "repairs an incomplete clean pin through CI with fake npm", () => {
      const f = fixture();
      try {
        const commands = join(f.root, "commands");
        mkdirSync(commands);
        writeFileSync(join(commands, "npm"), '#!/bin/sh\n echo "$*" >> "$PIN_TEST_LOG"\n');
        chmodSync(join(commands, "npm"), 0o755);
        const log = join(f.root, "npm.log");
        const clone = fresh ? join(f.root, "new-pin") : f.clone;
        if (!fresh) {
          execFileSync("git", ["config", "core.filemode", "false"], {cwd: clone});
          chmodSync(join(clone, "packages/cli/abap_transpile"), 0o644);
        }
        installPin(f.root, {...process.env, TRANSPILER: clone, PATH: `${commands}:${process.env.PATH}`, PIN_TEST_LOG: log,
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${f.clone}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/test/transpiler.git"});
        const calls = readFileSync(log, "utf8").trim().split("\n");
        assert.equal(calls.length, 9);
        assert.equal(calls.filter(line => line.endsWith("run compile")).length, 4);
        assert.equal(realpathSync(join(f.root, "node_modules/@abaplint/runtime")), join(clone, "packages/runtime"));
      } finally { rmSync(f.root, {recursive: true, force: true}); }
    });
  }
});

// A small behavioral fake distinguishes only, registry reuse and config invalidation.
function modules({only = true, reuse = true, config = true} = {}) {
  class Registry {
    objects = [];
    addFile(file) { this.objects.push({getName: () => file.name.split(".")[0].toUpperCase()}); }
    getObject(type, name) { return this.objects.find(o => o.getName() === name); }
  }
  class Transpiler {
    constructor(options) { this.options = options; }
    async run(reg) {
      const changed = reg.last !== this.options.ignoreSyntaxCheck;
      for (const o of reg.objects) {
        if (!reuse || !this.options.only || this.options.only(o) || (changed && config)) o.syntaxResult = {};
      }
      reg.last = this.options.ignoreSyntaxCheck;
      return {objects: reg.objects.filter(o => !only || !this.options.only || this.options.only(o))};
    }
  }
  return {Transpiler, core: {Registry, MemoryFile: class { constructor(name) { this.name = name; } }}};
}

describe("warm pin startup warning", () => {
  for (const [label, options, warning] of [["no only", {only: false}, true], ["no registry reuse", {reuse: false}, true],
    ["no config check", {config: false}, true], ["pinned capabilities", {}, false]]) {
    it(label, async () => {
      const {Transpiler, core} = modules(options);
      const reason = await probe(Transpiler, core);
      const doctor = [];
      await doctorWarmPin(Transpiler, core, line => doctor.push(line), {OSD_WARM: "1"});
      assert.equal(doctor.includes(WARM_PIN_WARNING), warning);
      await doctorWarmPin(Transpiler, core, () => assert.fail("warm is off"), {});
      const lines = [];
      const original = console.log, oldWarm = process.env.OSD_WARM;
      console.log = line => lines.push(line); process.env.OSD_WARM = "1";
      const w = {on: true, compiler: {prime: async () => {
        if (reason) throw Object.assign(new Error(reason), {code: "NOT_WARM", pinMissing: true});
      }, drop: async () => {}}};
      // The real startup fallback, with the expensive compiler replaced.
      const f = fixture();
      writeFileSync(join(f.root, "abap_transpile.json"), JSON.stringify({input_folder: ["src"], libs: [], options: {}}));
      mkdirSync(join(f.root, "src"));
      const store = {root: f.root, warm: () => w, overlay: () => undefined, inactiveSources: () => [],
        sourceKey: () => hashOf(f.root, inputsOf(f.root))};
      try {
        await warmUp(store);
        assert.equal(lines.filter(line => line === WARM_PIN_WARNING).length, warning ? 1 : 0);
        if (warning) assert(lines.includes(`warm: builds stay cold: ${reason}`));
        await warmUp(store);
        assert.equal(lines.filter(line => line === WARM_PIN_WARNING).length, warning ? 1 : 0);
      } finally {
        rmSync(f.root, {recursive: true, force: true});
        console.log = original;
        if (oldWarm === undefined) delete process.env.OSD_WARM; else process.env.OSD_WARM = oldWarm;
      }
    });
  }
});
