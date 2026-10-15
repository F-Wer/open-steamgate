// Observational tracing only: no cache key, parser invalidation or replay decisions.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {installHooks} from "./frontend-provenance-hooks.mjs";
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve("@abaplint/transpiler/package.json"));
const core = coreRequire("@abaplint/core");
const registryObjects = core.Registry.prototype.getObjects;
const registries = new WeakMap(), results = new WeakMap();
let active;
const keyOf = (obj) => obj?.getType ? `${obj.getType()} ${obj.getName().toUpperCase()}` : undefined;
const empty = () => ({queries: new Map(), edges: new Set()});
// Identity snapshots of core's cached artifacts: no getter calls or graph walks.
const artifactFields = ["syntaxResult", "parsedType", "def", "definition", "parsed", "modules", "includes"];
const artifacts = (obj) => artifactFields.map((name) => obj[name]);
const fileSnapshot = (obj) => obj.getFiles().map((f) => [f.getFilename(),
  createHash("sha256").update(f.getRaw()).digest("hex")]);

class Recorder {
  constructor() {
    this.stack = [];
    this.contexts = [];
    this.states = new Set();
    this.suppressed = 0;
  }
  state(reg) {
    let state = registries.get(reg);
    if (!state) {
      state = {reg, config: reg.getConfig(), entries: new Map(), global: empty(), files: new Map(), artifacts: new Map()};
      registries.set(reg, state);
    }
    this.states.add(state);
    return state;
  }
  entry(state, key) {
    if (!key) return state.global;
    if (!state.entries.has(key)) state.entries.set(key, empty());
    return state.entries.get(key);
  }
  current(state) {
    return this.stack.findLast((f) => f.state === state);
  }
  query(state, query, owner = this.current(state)?.key) {
    const row = {artifact: owner ?? "<registry>", phase: this.current(state)?.phase ?? "registry", ...query};
    const entry = this.entry(state, owner);
    entry.queries.set(JSON.stringify(row), row);
    if (owner && !row.scan) for (const key of row.result) {
      if (key !== owner && state.entries.has(key)) entry.edges.add(key);
    }
  }
  link(state, obj) {
    const key = keyOf(obj), from = this.current(state)?.key;
    if (key) {
      this.entry(state, key);
      if (from && from !== key) this.entry(state, from).edges.add(key);
    }
    return key;
  }
  checkArtifact(state, obj, key) {
    if (this.checked?.has(obj)) return;
    this.checked ??= new WeakSet();
    this.checked.add(obj);
    const previous = state.artifacts.get(obj);
    if (previous && artifacts(obj).some((value, i) => value !== previous[i])) {
      this.query(state, {kind: "unknown-scan", args: ["untraced-artifact"], result: []}, key);
    } else if (!previous && (obj.syntaxResult || obj.parsedType || obj.def || obj.definition || obj.isDirty?.() === false)) {
      this.query(state, {kind: "unknown-scan", args: ["artifact-built-before-recording"], result: []}, key);
    }
  }
  artifact(reg, obj, phase, run) {
    const state = this.state(reg), key = this.link(state, obj);
    if (!key) return run();
    this.checkArtifact(state, obj, key);
    this.stack.push({state, key, phase});
    try { return run(); } finally { this.stack.pop(); }
  }
  context(kind, args, run) {
    const frame = {kind, args};
    this.contexts.push(frame);
    try { return run(frame); } finally { this.contexts.pop(); }
  }
  // A retained artifact first encountered after it was built cannot be proven
  // complete. Keep an explicit fail-closed marker instead of guessing its reads.
  inventory(reg, objects) {
    const state = this.state(reg);
    const configEdited = state.config && state.config !== reg.getConfig();
    const snapshots = new Map(objects.map((obj) => [keyOf(obj), fileSnapshot(obj)]));
    const changed = [...snapshots].filter(([key, files]) => state.files.has(key)
      && JSON.stringify(files) !== JSON.stringify(state.files.get(key))).map(([key]) => key);
    const removed = [...state.files.keys()].filter((key) => !snapshots.has(key));
    const added = [...snapshots.keys()].some((key) => !state.files.has(key));
    const edited = changed.length || removed.length || (state.files.size && added);
    if (configEdited || edited) {
      // Old resolutions (including misses and global scans) must not survive an
      // inventory/config change. Core may still serve stale artifacts: fail closed.
      state.entries.clear();
      state.global = empty();
      this.query(state, {kind: "unknown-scan", args: [configEdited
        ? "retained-registry-config-edit" : "retained-registry-edit"], result: []});
      for (const key of changed) this.query(state, {kind: "unknown-scan",
        args: ["retained-registry-edit"], result: []}, key);
    }
    state.config = reg.getConfig();
    for (const obj of objects) {
      const key = keyOf(obj);
      this.checkArtifact(state, obj, key);
      this.entry(state, key);
    }
    state.files = snapshots;
    for (const obj of state.artifacts.keys()) if (!snapshots.has(keyOf(obj))) state.artifacts.delete(obj);
    return state;
  }
}

/** Scope hooks synchronously and restore every descriptor even on a refusal. */
export function recordProvenance(run) {
  if (active) return run();
  const recorder = new Recorder();
  const restore = installHooks(core, coreRequire, recorder);
  active = recorder;
  try {
    const value = run();
    if (value && typeof value === "object") results.set(value, recorder.states);
    return value;
  } finally {
    for (const state of recorder.states) for (const obj of registryObjects.call(state.reg)) {
      if (recorder.checked?.has(obj)) state.artifacts.set(obj, artifacts(obj));
    }
    active = undefined; restore();
  }
}

/** Recording is opt-in until step 4 consumes it; cache guards are unchanged. */
export function withProvenance(compile) {
  return (options) => options.provenance ?? (process.env.GOGEN_PROVENANCE === "1")
    ? recordProvenance(() => {
      // A supplied session may bypass findIssues(), including our inventory
      // hook. Inspect it before any cached scope/IR can be served.
      if (options.registry) active.inventory(options.registry, [...registryObjects.call(options.registry)]);
      return compile(options);
    }) : compile(options);
}

export function withArtifact(ctx, obj, run, phase = "lowering") {
  return active ? active.artifact(ctx.reg, obj.obj ?? obj, phase, run) : run();
}

export function artifactLowering(lower) {
  return (ctx, obj, ...args) => withArtifact(ctx, obj, () => lower(ctx, obj, ...args));
}

// Disk IR replay performs no lowering lookups. Carry its stored observation
// transcript too, without using it to validate or change any cache key.
export function storedProvenance(reg, obj) {
  if (!active) return;
  const state = active.state(reg), entry = active.entry(state, keyOf(obj.obj ?? obj));
  return {rows: [...entry.queries.values()], edges: [...entry.edges]};
}

export function inheritStoredProvenance(reg, obj, stored) {
  if (!active) return;
  const state = active.state(reg), key = keyOf(obj.obj ?? obj);
  if (!stored || !Array.isArray(stored.rows) || !Array.isArray(stored.edges)) {
    active.query(state, {kind: "unknown-scan", args: ["lowering-built-before-recording"], result: []}, key);
    return;
  }
  const entry = active.entry(state, key);
  for (const row of stored.rows) active.query(state, row, key);
  for (const edge of stored.edges) entry.edges.add(edge);
}

// Expanded macros bypass the raw-source selection scan. Observe the actual
// lowering lookup, including the signature owner's cached DDIC provenance.
export function resolvedFunctionModule(ctx, name) {
  const value = ctx.program.functionModules.get(name);
  if (active) {
    const state = active.state(ctx.reg);
    if (value) active.link(state, value.group);
    active.query(state, {kind: "function-module-owner", args: [name],
      result: value ? [keyOf(value.group)] : []});
  }
  return value;
}

// Same selection order and lookup precedence as the frontend. Keep the named
// FM ownership query beside the gogen scan (normal ABAP syntax only checks FM
// ownership in Cloud language mode).
export function expandProgramSelection(reg, wanted, abaplint) {
  const upper = (s) => String(s).toUpperCase();
  const fmGroups = new Map();
  const index = () => {
    for (const g of reg.getObjects()) if (g instanceof abaplint.Objects.FunctionGroup) {
      for (const m of g.getModules()) fmGroups.set(upper(m.getName()), g.getName().toLowerCase());
    }
  };
  if (active) active.context("function-module-index", [], index); else index();
  for (let i = 0; i < wanted.length; i++) {
    const obj = reg.getObject("CLAS", wanted[i]) ?? reg.getObject("FUGR", wanted[i]);
    const run = () => {
      for (const file of obj?.getABAPFiles() ?? []) {
        for (const match of file.getRaw().matchAll(/\bCALL\s+FUNCTION\s+'([^']+)'/gi)) {
          const group = fmGroups.get(upper(match[1]));
          if (active) active.query(active.state(reg), {kind: "function-module-owner", args: [upper(match[1])],
            result: group ? [`FUGR ${upper(group)}`] : []});
          if (group && !wanted.includes(group)) wanted.push(group);
        }
        // A PUBLIC CLASS-DATA read is a dependency too: its class constructor
        // and storage must be emitted even when no method of that class is called.
        for (const match of file.getRaw().matchAll(/\b([a-z_][\w]*)=>([a-z_]\w*)/gi)) {
          const owner = match[1].toLowerCase();
          const attr = upper(match[2]);
          const def = reg.getObject("CLAS", owner)?.getDefinition();
          if (def?.getAttributes().getStatic().some((a) => upper(a.getName()) === attr && a.getVisibility?.() === abaplint.Visibility.Public)
              && !wanted.includes(owner)) wanted.push(owner);
        }
      }
    };
    if (active && obj) active.artifact(reg, obj, "selection", run); else run();
  }
}

/** No fields are added to IR, abaplint objects or replay-tracked program state.
 * Queries stay on their original owner; expand edges at inspection time so
 * cached definitions/types/scopes inherit even subsequently collected reads. */
export function provenanceOf(value) {
  // Source normalization can create temporary registries for the same object.
  // A program/session manifest belongs only to its actual compiler registry.
  const state = registries.get(value?.reg ?? value?.registry ?? value);
  const states = state ? new Set([state]) : results.get(value) ?? new Set();
  const output = new Map();
  for (const state of states) for (const owner of state.entries.keys()) {
    const seen = new Set(), queries = new Map(state.global.queries);
    const visit = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      const entry = state.entries.get(key);
      if (!entry) return;
      for (const [id, row] of entry.queries) queries.set(id, row);
      for (const edge of entry.edges) visit(edge);
    };
    visit(owner);
    const manifest = {hits: [], misses: [], scans: [], unknownScans: []};
    for (const row of queries.values()) {
      if (row.kind === "unknown-scan") manifest.unknownScans.push(row);
      else if (row.scan) manifest.scans.push(row);
      else manifest[row.result.length ? "hits" : "misses"].push(row);
    }
    output.set(owner, manifest);
  }
  return output;
}

async function main() {
  const args = process.argv.slice(2), folders = [], objects = [];
  let show;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--show") show = args.shift();
    else if (arg === "--objects") {
      while (args.length && !args[0].startsWith("--")) objects.push(...args.shift().split(","));
    } else folders.push(arg);
  }
  if (!folders.length || !objects.length || !show) throw new Error("usage: frontend-provenance.mjs <folders...> --objects <names...> --show <TYPE NAME|NAME>");
  const {compileProgram} = await import("./frontend.mjs");
  const program = compileProgram({folders, objects, tolerant: true, provenance: true});
  const manifests = provenanceOf(program);
  const key = [...manifests.keys()].find((k) => k === show.toUpperCase() || k.split(" ").slice(1).join(" ") === show.toUpperCase());
  if (!key) throw new Error(`object not found: ${show}`);
  console.log(JSON.stringify({object: key, ...manifests.get(key)}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
