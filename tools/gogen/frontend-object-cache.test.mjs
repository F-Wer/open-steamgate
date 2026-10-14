import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {deserialize} from "node:v8";
import {inflateRawSync} from "node:zlib";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {home} from "./home.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {captureInChild, syntheticCorpus} from "./cache-oracle.mjs";
import {orderedRegistry} from "./cache-oracle-capture.mjs";

const source = (name, body) => `CLASS ${name} DEFINITION PUBLIC.
PUBLIC SECTION. CLASS-METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
METHOD run. ${body} ENDMETHOD.
ENDCLASS.`;

test("implicit pool types invalidate: prefix resolution precedes lowering-time reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-pool-regression-"));
  try {
    const input = join(dir, "input"), cacheDir = join(dir, "cache"); mkdirSync(input);
    const pool = join(input, "zorc.type.abap");
    writeFileSync(pool, "TYPE-POOL zorc. TYPES zorc_value TYPE i.");
    writeFileSync(join(input, "zcl_pool.clas.abap"), source("zcl_pool", "rv = 7.").replace("TYPE i", "TYPE zorc_value"));
    const args = {folders: [input], objects: ["ZCL_POOL"]};
    const before = captureInChild({...args, cacheDir}, dir);
    assert.deepEqual(captureInChild({...args, cacheDir}, dir).counts.reusedClasses, ["ZCL_POOL"]);
    writeFileSync(pool, readFileSync(pool, "utf8").replace("TYPE i", "TYPE int8"));
    const warm = captureInChild({...args, cacheDir}, dir), cold = captureInChild(args, dir);
    assert.equal(warm.artifacts.emitGo, cold.artifacts.emitGo);
    assert.notEqual(cold.artifacts.emitGo, before.artifacts.emitGo);
    assert.deepEqual(warm.counts.reusedClasses, []); // Today's global guard.
    assert.match(cold.artifacts.emitGo, /int64/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("changed same-position local definitions cannot replay across the global version", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-definition-regression-"));
  try {
    const corpus = syntheticCorpus({classes: 4}), input = join(dir, "input"), cacheDir = join(dir, "cache");
    mkdirSync(input);
    for (const file of ["zcl_control_0000.clas.abap", "zcl_control_0000.clas.testclasses.abap"]) writeFileSync(join(input, file), corpus.files[file]);
    const args = {folders: [input], objects: ["ZCL_CONTROL_0000"]};
    const before = captureInChild({...args, cacheDir}, dir);
    const unchanged = captureInChild({...args, cacheDir}, dir);
    assert.ok(unchanged.counts.reusedClasses.includes("ZCL_CONTROL_0000:LCL_SAME"));
    const file = join(input, "zcl_control_0000.clas.testclasses.abap");
    // Same filename, definition name, start row and column. Replay fingerprints
    // alone accept this definition; the source version is the semantic guard.
    writeFileSync(file, readFileSync(file, "utf8").replace("VALUE 1", "VALUE 9"));
    const warm = captureInChild({...args, cacheDir}, dir), cold = captureInChild(args, dir);
    assert.equal(warm.artifacts.emitGo, cold.artifacts.emitGo);
    assert.notEqual(warm.artifacts.emitGo, before.artifacts.emitGo);
    assert.deepEqual(warm.counts.reusedClasses, []);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("within-object file order changes first-wins macro expansion and the cache key", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-order-regression-"));
  try {
    const corpus = syntheticCorpus({classes: 4}), input = join(dir, "input"), cacheDir = join(dir, "cache");
    mkdirSync(input);
    for (const [file, raw] of Object.entries(corpus.files).filter(([f]) => f.startsWith("zcl_order_macro."))) writeFileSync(join(input, file), raw);
    const args = {folders: [input], objects: ["ZCL_ORDER_MACRO"]};
    const before = captureInChild({...args, cacheDir}, dir);
    assert.deepEqual(captureInChild({...args, cacheDir}, dir).counts.reusedClasses, ["ZCL_ORDER_MACRO"]);
    const order = ["zcl_order_macro.clas.macros.abap", "zcl_order_macro.clas.locals_def.abap"];
    const registry = orderedRegistry([input], order);
    assert.deepEqual(registry.getObject("CLAS", "ZCL_ORDER_MACRO").getFiles().map((f) => f.getFilename()),
      ["zcl_order_macro.clas.abap", ...order]);
    const warm = captureInChild({...args, cacheDir, order}, dir), cold = captureInChild({...args, order}, dir);
    assert.notEqual(cold.artifacts.emitGo, before.artifacts.emitGo, "the cold macro expansion must actually change");
    assert.equal(warm.artifacts.emitGo, cold.artifacts.emitGo);
    assert.deepEqual(warm.counts.reusedClasses, []);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("session without cacheDir preserves main's scalar entries and fast path", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-memory-session-"));
  try {
    writeFileSync(join(dir, "zcl_scalar.clas.abap"), source("zcl_scalar", "rv = 7."));
    const args = {folders: [dir], objects: ["ZCL_SCALAR"]}, session = {};
    // A default-off process must never load cache code or its module state.
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {registerHooks} from "node:module";
      registerHooks({load(url, context, next) {
        if (/frontend-(object-cache|source-key)\\.mjs$/.test(url)) throw new Error("cache module loaded without cacheDir");
        return next(url, context);
      }});
      const {compileProgram} = await import(${JSON.stringify(new URL("frontend.mjs", import.meta.url).href)});
      const args = ${JSON.stringify(args)}, session = {};
      const first = compileProgram({...args, session});
      compileProgram({...args, session, registry: first.reg});
    `], {encoding: "utf8"});
    assert.equal(child.status, 0, child.stderr);
    const first = compileProgram({...args, session});
    assert.equal(Object.hasOwn(first, "localDefs"), false);
    assert.equal(Object.hasOwn(first, "faeN"), false);
    // origin/main's elementary entry stores own signatures and diagnostics,
    // without an observed-read transcript or disk-cache session fields.
    assert.deepEqual(Object.keys(session).sort(),
      ["registry", "config", "files", "classes", "issues", "ownershipSafety"].sort());
    assert.deepEqual([...session.classes.keys()], ["ZCL_SCALAR"]);
    const entry = session.classes.get("ZCL_SCALAR");
    assert.deepEqual(Object.keys(entry).sort(),
      ["file", "structure", "ir", "sigs", "supplied", "current", "skipped", "partial"].sort());
    assert.equal(entry.file, first.reg.getObject("CLAS", "ZCL_SCALAR").getMainABAPFile());
    assert.equal(entry.structure, entry.file.getStructure());
    assert.equal(entry.ir, first.classes[0]);
    assert.deepEqual(entry.sigs, []);
    assert.equal(entry.supplied, "[]");
    assert.deepEqual(entry.skipped, []);
    assert.deepEqual(entry.partial, []);
    const next = compileProgram({...args, registry: first.reg, session});
    assert.deepEqual(next.frontendCounts.reusedClasses, ["ZCL_SCALAR"]);
    assert.equal(session.classes.get("ZCL_SCALAR"), entry);
    assert.equal(emitGo(next), emitGo(first));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("disk lowerings survive a fresh process, match cold bytes and conservatively invalidate registry artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-object-cache-")), cacheDir = join(dir, "cache");
  const objects = ["ZCL_BASE", "ZCL_READER", "ZCL_TRANSITIVE", "ZCL_OTHER"];
  const args = {folders: [dir], objects};
  const warm = () => compileProgram({...args, cacheDir});
  try {
    for (const [name, body] of [["zcl_base", "rv = 7."], ["zcl_reader", "rv = zcl_base=>run( )."],
      ["zcl_transitive", "rv = zcl_reader=>run( )."], ["zcl_other", "rv = 3."]])
      writeFileSync(join(dir, `${name}.clas.abap`), source(name, body));
    const expected = emitGo(compileProgram(args));
    const first = warm();
    assert.equal(emitGo(first), expected);
    assert.deepEqual(first.frontendCounts.loweredClasses, [...objects].sort());
    const next = warm();
    assert.equal(emitGo(next), expected);
    assert.deepEqual(next.frontendCounts.reusedClasses, [...objects].sort());
    // The child loads only the disk entries, with no retained objects/session.
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {compileProgram} from ${JSON.stringify(new URL("frontend.mjs", import.meta.url).href)};
      import {emitGo} from ${JSON.stringify(new URL("emit-go.mjs", import.meta.url).href)};
      const p = compileProgram(${JSON.stringify({...args, cacheDir})});
      console.log(JSON.stringify({go:emitGo(p), counts:p.frontendCounts}));
    `], {encoding: "utf8", maxBuffer: 5e6});
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.go, expected);
    assert.deepEqual(result.counts.reusedClasses, [...objects].sort());
    const file = join(dir, "zcl_base.clas.abap");
    writeFileSync(file, readFileSync(file, "utf8").replace("rv = 7", "rv = 9"));
    const edited = warm();
    assert.deepEqual(edited.frontendCounts.loweredClasses, [...objects].sort());
    assert.deepEqual(edited.frontendCounts.reusedClasses, []);
    assert.equal(emitGo(edited), emitGo(compileProgram(args)));
    assert.notEqual(emitGo(edited), expected);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("old version directories are pruned, recent and foreign ones kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-object-prune-")), cacheDir = join(dir, "cache");
  try {
    writeFileSync(join(dir, "zcl_base.clas.abap"), source("zcl_base", "rv = 7."));
    const args = {folders: [dir], objects: ["ZCL_BASE"], cacheDir};
    compileProgram(args);
    const [current] = readdirSync(cacheDir);
    const version = (i) => String(i).padStart(64, "0"), hours = (h) => new Date(Date.now() - h * 3600e3);
    // six stale versions (2..7 hours old), five opened within the hour, one foreign directory
    const at = (name, h) => { mkdirSync(join(cacheDir, name)); utimesSync(join(cacheDir, name), hours(h), hours(h)); };
    for (let i = 2; i <= 7; i++) at(version(i), i);
    const recent = [11, 12, 13, 14, 15].map(version);
    recent.forEach((name, i) => at(name, (i + 1) / 10));
    mkdirSync(join(cacheDir, "notes"));
    utimesSync(join(cacheDir, current), hours(9), hours(9));
    const next = compileProgram(args);
    assert.deepEqual(next.frontendCounts.reusedClasses, ["ZCL_BASE"]);
    // keep 4 = the current one + three others by last use; more recent ones than
    // that are kept as well, and the current one was marked used by opening it
    assert.deepEqual(readdirSync(cacheDir).sort(), [...recent, current, "notes"].sort());
    assert.ok(Date.now() - statSync(join(cacheDir, current)).mtimeMs < 60e3);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a superclass edit changes what a cached CATCH takes, warm equal to cold", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-object-catch-")), cacheDir = join(dir, "cache");
  const cx = (name, sup) => `CLASS ${name} DEFINITION PUBLIC INHERITING FROM ${sup} CREATE PUBLIC.
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
ENDCLASS.`;
  const objects = ["ZCX_BASE", "ZCX_OTHER", "ZCX_LEAF", "ZCX_HIDDEN", "ZCL_CATCHER", "ZCL_CATCHER2", "CX_ROOT", "CX_STATIC_CHECK"];
  const args = {folders: [dir, join(libraryPath(home, "open-abap-core"), "src")], objects, tolerant: true};
  try {
    writeFileSync(join(dir, "zcx_base.clas.abap"), cx("zcx_base", "cx_static_check"));
    writeFileSync(join(dir, "zcx_other.clas.abap"), cx("zcx_other", "cx_static_check"));
    // named by no catcher: only the hierarchy walk of each CATCH reads it
    writeFileSync(join(dir, "zcx_hidden.clas.abap"), cx("zcx_hidden", "zcx_base"));
    writeFileSync(join(dir, "zcl_catcher2.clas.abap"), source("zcl_catcher2", "TRY. rv = 1. CATCH zcx_base. rv = 2. ENDTRY."));
    writeFileSync(join(dir, "zcl_catcher.clas.abap"), source("zcl_catcher",
      "TRY. RAISE EXCEPTION TYPE zcx_leaf. CATCH zcx_base. rv = 1. CATCH zcx_other. rv = 2. ENDTRY. TRY. rv = rv + 1. CATCH zcx_base. rv = 3. ENDTRY."));
    const outputs = [];
    for (const sup of ["zcx_base", "zcx_other"]) {
      writeFileSync(join(dir, "zcx_leaf.clas.abap"), cx("zcx_leaf", sup));
      const cold = emitGo(compileProgram(args));
      const first = compileProgram({...args, cacheDir}), warm = compileProgram({...args, cacheDir});
      assert.equal(emitGo(first), cold);
      assert.equal(emitGo(warm), cold);
      assert.ok(warm.frontendCounts.reusedClasses.includes("ZCL_CATCHER"));
      outputs.push(cold);
    }
    // the edit moved ZCX_LEAF from the first CATCH to the second
    assert.notEqual(outputs[0], outputs[1]);
    // and the entry's key names the hierarchy it read, not only the global version
    const entries = readdirSync(cacheDir, {recursive: true}).filter((f) => f.endsWith(".bin"))
      .map((f) => deserialize(inflateRawSync(readFileSync(join(cacheDir, f)).subarray(65))));
    for (const name of ["ZCL_CATCHER", "ZCL_CATCHER2"]) {
      const catcher = entries.filter((e) => e.value.name === name);
      assert.ok(catcher.length > 0, name);
      for (const e of catcher) assert.ok(e.reads.includes("CLAS ZCX_HIDDEN"), `${name} reads ZCX_HIDDEN`);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("cached refusals retry as the closure grows and a corrupt cache falls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-object-closure-")), cacheDir = join(dir, "cache");
  try {
    writeFileSync(join(dir, "zcl_base.clas.abap"), source("zcl_base", "rv = 7."));
    writeFileSync(join(dir, "zcl_reader.clas.abap"), source("zcl_reader", "rv = zcl_base=>run( )."));
    const args = {folders: [dir], objects: ["ZCL_READER"], tolerant: true, cacheDir};
    const first = compileProgram(args);
    assert.ok(first.missing.has("ZCL_BASE"));
    const repeat = compileProgram(args);
    assert.ok(repeat.frontendCounts.reusedClasses.includes("ZCL_READER"));
    assert.deepEqual(repeat.skipped, first.skipped);
    const all = {...args, objects: ["ZCL_READER", "ZCL_BASE"]};
    const complete = compileProgram(all);
    assert.ok(complete.frontendCounts.loweredClasses.includes("ZCL_READER"));
    assert.equal(emitGo(complete), emitGo(compileProgram({...all, cacheDir: undefined})));
    const entry = readdirSync(cacheDir, {recursive: true}).find((f) => f.endsWith(".bin"));
    writeFileSync(join(cacheDir, entry), "corrupt cache entry");
    assert.equal(emitGo(compileProgram(all)), emitGo(complete));
    rmSync(cacheDir, {recursive: true});
    writeFileSync(cacheDir, "unwritable cache directory");
    assert.equal(emitGo(compileProgram(all)), emitGo(complete));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("source cycles and transitive readers invalidate without disturbing unrelated keys", async () => {
  const {sourceKeys} = await import("./frontend-source-key.mjs");
  const objects = new Map([
    ["CLAS A", {hash: "a", words: new Set(["B"])}],
    ["CLAS B", {hash: "b", words: new Set(["A"])}],
    ["CLAS C", {hash: "c", words: new Set(["A"])}],
    ["CLAS D", {hash: "d", words: new Set()}],
  ]);
  const names = (o) => new Map([...o.keys()].map((k) => [k.slice(5), [k]]));
  const before = sourceKeys(objects, names(objects), "version");
  const added = new Map([["CLAS NEW", {hash: "new", words: new Set()}], ...objects]);
  const withNew = sourceKeys(added, names(added), "version");
  for (const key of objects.keys()) assert.equal(withNew(key, []), before(key, []));
  objects.set("CLAS A", {...objects.get("CLAS A"), hash: "changed"});
  const after = sourceKeys(objects, names(objects), "version");
  for (const key of ["CLAS A", "CLAS B", "CLAS C"]) assert.notEqual(after(key, []), before(key, []));
  assert.equal(after("CLAS D", []), before("CLAS D", []));
});

test("whole-closure readers reuse the matching variant in both growing rounds", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-object-variants-")), cacheDir = join(dir, "cache");
  try {
    writeFileSync(join(dir, "cx_root.clas.abap"), source("cx_root", "rv = 1."));
    writeFileSync(join(dir, "zcl_try.clas.abap"), source("zcl_try", "TRY. rv = 1. CATCH cx_root. rv = 2. ENDTRY."));
    writeFileSync(join(dir, "zcl_other.clas.abap"), source("zcl_other", "rv = 3."));
    const args = {folders: [dir], objects: ["CX_ROOT", "ZCL_TRY"], cacheDir};
    const session = {}, first = compileProgram({...args, session});
    const all = {...args, objects: [...args.objects, "ZCL_OTHER"]};
    const second = compileProgram({...all, registry: first.reg, session});
    assert.ok(second.frontendCounts.loweredClasses.includes("ZCL_TRY"));
    const freshSession = {}, repeatedFirst = compileProgram({...args, session: freshSession});
    assert.equal(emitGo(repeatedFirst), emitGo(first));
    assert.ok(repeatedFirst.frontendCounts.reusedClasses.includes("ZCL_TRY"));
    const repeatedSecond = compileProgram({...all, registry: repeatedFirst.reg, session: freshSession});
    assert.equal(emitGo(repeatedSecond), emitGo(second));
    assert.ok(repeatedSecond.frontendCounts.reusedClasses.includes("ZCL_TRY"));
    assert.equal(emitGo(repeatedSecond), emitGo(compileProgram({...all, cacheDir: undefined})));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("compacted replay retains input guards across writes and rejects changed inputs atomically", async () => {
  const {compactLowering} = await import("./frontend-object-cache.mjs");
  const {recordLowering, replayLowering} = await import("./frontend-replay.mjs");
  const program = () => ({wanted: new Set(["BASE"]), sigs: new Map(), skipped: []});
  const first = program();
  const value = recordLowering(first, (p) => {
    for (let i = 0; i < 100; i++) { assert.equal(p.wanted.size, 1); assert.equal(p.wanted.has("BASE"), true); }
    p.wanted.add("ADDED");
    assert.equal(p.wanted.size, 2); assert.equal(p.wanted.has("ADDED"), true);
    p.sigs.set("BASE=>RUN", {type: "i"});
    return {name: "BASE"};
  });
  const compact = compactLowering(value);
  assert.ok(compact.replay.ops.length < value.replay.ops.length / 10);
  const next = program();
  assert.ok(replayLowering(next, compact.replay));
  assert.deepEqual(next, first);
  const changed = program();
  changed.wanted.delete("BASE");
  changed.wanted.add("UNEXPECTED");
  const before = structuredClone(changed);
  assert.equal(replayLowering(changed, compact.replay), false);
  assert.deepEqual(changed, before);
});

for (const variant of ["class macro", "include", "macro from another object"]) {
  test(`fresh-process closure shrink guards a static call hidden in ${variant}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "gogen-hidden-read-")), cacheDir = join(dir, "cache");
    const run = (objects, cached) => {
      const args = {folders: [dir], objects, tolerant: true, cacheDir: cached ? cacheDir : undefined};
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import {compileProgram} from ${JSON.stringify(new URL("frontend.mjs", import.meta.url).href)};
        import {emitGo} from ${JSON.stringify(new URL("emit-go.mjs", import.meta.url).href)};
        const p = compileProgram(${JSON.stringify(args)});
        console.log(JSON.stringify({go: emitGo(p), counts: p.frontendCounts, diagnostics: p.diagnostics}));
      `], {encoding: "utf8", maxBuffer: 5e6});
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    try {
      writeFileSync(join(dir, "zcl_base.clas.abap"), source("zcl_base", "rv = 7."));
      writeFileSync(join(dir, "zcl_primer.clas.abap"), source("zcl_primer", "rv = zcl_base=>run( )."));
      writeFileSync(join(dir, "zcl_reader.clas.abap"), source("zcl_reader", "read_base."));
      if (variant === "class macro") writeFileSync(join(dir, "zcl_reader.clas.macros.abap"),
        "DEFINE read_base. rv = zcl_base=>run( ). END-OF-DEFINITION.");
      if (variant === "include") {
        writeFileSync(join(dir, "zcl_reader.clas.locals_def.abap"), "INCLUDE zread_body.");
        writeFileSync(join(dir, "zread_body.prog.abap"), "DEFINE read_base. rv = zcl_base=>run( ). END-OF-DEFINITION.");
      }
      if (variant === "macro from another object") {
        writeFileSync(join(dir, "zcl_reader.clas.macros.abap"), "INCLUDE zread_macros.");
        writeFileSync(join(dir, "zread_macros.prog.abap"), "DEFINE read_base. rv = zcl_base=>run( ). END-OF-DEFINITION.");
      }
      const all = ["ZCL_BASE", "ZCL_PRIMER", "ZCL_READER"];
      const filled = run(all, true);
      assert.equal(filled.diagnostics.length, 0, JSON.stringify(filled.diagnostics));
      assert.match(filled.go, /ZCL_BASE_RUN/);
      const warm = run(["ZCL_READER"], true), cold = run(["ZCL_READER"], false);
      assert.equal(warm.go, cold.go);
      assert.match(cold.go, /ZCL_BASE is not compiled in this program/);
      assert.deepEqual(warm.counts.loweredClasses, ["ZCL_READER"]);
      const repeated = run(["ZCL_READER"], true);
      assert.equal(repeated.go, cold.go);
      assert.deepEqual(repeated.counts.reusedClasses, ["ZCL_READER"]);
      // Editing a resolved include/macro must also invalidate parsed artifacts.
      const dep = variant === "class macro" ? "zcl_reader.clas.macros.abap"
        : variant === "include" ? "zread_body.prog.abap" : "zread_macros.prog.abap";
      writeFileSync(join(dir, dep), readFileSync(join(dir, dep), "utf8").replace("zcl_base=>run( )", "9"));
      const edited = run(["ZCL_READER"], true);
      assert.equal(edited.go, run(["ZCL_READER"], false).go);
      assert.deepEqual(edited.counts.loweredClasses, ["ZCL_READER"]);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}


test("a fresh process initializes tracked context before supplied-parameter discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-supplied-init-"));
  try {
    writeFileSync(join(dir, "zcl_supplied.clas.abap"), source("zcl_supplied",
      "rv = 1. IF iv IS SUPPLIED. rv = iv. ENDIF.").replace(
        "run RETURNING", "run IMPORTING iv TYPE i OPTIONAL RETURNING"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {compileProgram} from ${JSON.stringify(new URL("frontend.mjs", import.meta.url).href)};
      import {emitGo} from ${JSON.stringify(new URL("emit-go.mjs", import.meta.url).href)};
      const args = ${JSON.stringify({folders: [dir], objects: ["ZCL_SUPPLIED"], cacheDir: join(dir, "cache")})};
      const first = emitGo(compileProgram(args)), next = emitGo(compileProgram(args));
      if (first !== next) throw new Error("supplied replay differs");
    `], {encoding: "utf8"});
    assert.equal(child.status, 0, child.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
