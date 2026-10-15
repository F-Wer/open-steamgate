// Observational tracing only: no cache key, parser invalidation or replay decisions.
import {inputSnapshot, freshRegistry, finishInputs, objectKey} from "./frontend-inventory.mjs";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {installHooks} from "./frontend-provenance-hooks.mjs";
const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve("@abaplint/transpiler/package.json"));
const core = coreRequire("@abaplint/core");
const registryObjects = core.Registry.prototype.getObjects;
const registries = new WeakMap(), results = new WeakMap(), published = new WeakMap();
let active;
const keyOf = (obj) => obj?.getType ? objectKey(obj) : undefined;
const empty = () => ({queries: new Map(), edges: new Set()});
// Identity snapshots of core's cached artifacts: no getter calls or graph walks.
const artifactFields = ["syntaxResult", "parsedType", "def", "definition", "parsed", "modules", "includes"];
const artifacts = (obj) => artifactFields.map((name) => obj[name]);

class Recorder {
  constructor(expose) {
    this.expose = expose;
    this.stack = [];
    this.contexts = [];
    this.states = new Set();
    this.suppressed = 0;
    this.auditDepth = 0;
    this.roles = [];
  }
  state(reg) {
    let state = registries.get(reg);
    if (!state) {
      state = {reg, config: reg.getConfig(), entries: new Map(), lowerings: new Map(), scheduling: empty(), finalOutput: empty(), global: empty(), files: new Map(), artifacts: new Map()};
      registries.set(reg, state);
    }
    if (this.states.has(state)) return state;
    // Internal disk observation must not mutate an already published manifest.
    if (!this.expose && state.exposed && !this.states.has(state)) {
      const copy = (entry) => ({queries: new Map(entry.queries), edges: new Set(entry.edges)});
      state = {...state, entries: new Map([...state.entries].map(([k, e]) => [k, copy(e)])),
        lowerings: new Map([...state.lowerings].map(([k, e]) => [k, copy(e)])),
        scheduling: copy(state.scheduling), finalOutput: copy(state.finalOutput), global: copy(state.global), files: new Map(state.files), artifacts: new Map(state.artifacts)};
      registries.set(reg, state);
    }
    state.exposed = this.expose;
    if (this.expose) published.set(reg, state);
    this.states.add(state);
    return state;
  }
  entry(state, key, lowering = false) {
    if (!key) return state.global;
    const entries = lowering ? state.lowerings : state.entries;
    if (!entries.has(key)) entries.set(key, empty());
    return entries.get(key);
  }
  own(state, key) { return this.entry(state, key, this.current(state)?.lowering); }
  role(state) { return this.current(state) ? "artifact" : this.roles.at(-1) ?? "artifact"; }
  current(state) {
    const top = this.stack.at(-1);
    return top?.state === state ? top : this.stack.findLast((f) => f.state === state);
  }
  query(state, query, owner = this.current(state)?.key) {
    if (this.auditDepth) return;
    const role = query.role ?? this.role(state), frame = this.current(state);
    const phase = query.phase ?? frame?.phase ?? "registry";
    const entry = role === "scheduling" ? state.scheduling : role === "final-output" ? state.finalOutput : this.own(state, owner);
    const simple = ["getObject", "getFileByName", "findObjectForFile", "getFirstObject"].includes(query.kind);
    const id = simple ? `${role}\0${phase}\0${owner ?? "<registry>"}\0${query.kind}\0${query.args.join("\0")}\u0001${query.result.join("\0")}`
      : JSON.stringify([role, phase, owner, query]);
    if (entry.queries.has(id)) return;
    const row = {role, artifact: owner ?? "<registry>", phase, ...query};
    entry.queries.set(id, row);
    if (role === "artifact" && owner && !row.scan) for (const key of [...row.result, ...row.providers ?? []]) {
      if (key !== owner && state.entries.has(key)) entry.edges.add(key);
    }
  }

  link(state, obj) {
    const key = keyOf(obj), from = this.current(state)?.key;
    if (key) {
      this.entry(state, key);
      if (from && from !== key) this.own(state, from).edges.add(key);
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
    const key = keyOf(obj), top = this.stack.at(-1);
    if (!key) return run();
    if (top?.state.reg === reg && top.key === key && phase === "artifact-read") return run();
    const state = this.state(reg);
    this.link(state, obj);
    this.entry(state, key, phase === "lowering" || phase === "selection");
    this.checkArtifact(state, obj, key);
    this.stack.push({state, key, obj, phase, lowering: phase === "lowering" || phase === "selection"});
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
    const snapshots = new Map([...inputSnapshot(reg).objects].map(([key, {sources}]) => [key, sources.map((s) => [s.name, s.raw])]));
    const changed = [...snapshots].filter(([key, files]) => state.files.has(key)
      && JSON.stringify(files) !== JSON.stringify(state.files.get(key))).map(([key]) => key);
    const removed = [...state.files.keys()].filter((key) => !snapshots.has(key));
    const added = [...snapshots.keys()].some((key) => !state.files.has(key));
    const edited = changed.length || removed.length || (state.files.size && added);
    if (configEdited || edited) {
      // Old resolutions (including misses and global scans) must not survive an
      // inventory/config change. Core may still serve stale artifacts: fail closed.
      state.entries.clear(); state.lowerings.clear();
      state.scheduling = empty(); state.finalOutput = empty();
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
export function recordProvenance(run, {expose = true} = {}) {
  if (active) return run();
  const recorder = new Recorder(expose);
  const restore = installHooks(core, coreRequire, recorder);
  active = recorder;
  try {
    const value = run();
    if (value && typeof value === "object") results.set(value, {states: recorder.states, exposed: recorder.expose});
    return value;
  } finally {
    // AUDITED recorder finalization: snapshot cached identities, no resolution.
    for (const state of recorder.states) for (const obj of registryObjects.call(state.reg)) {
      if (recorder.checked?.has(obj)) state.artifacts.set(obj, artifacts(obj));
    }
    active = undefined; restore();
  }
}

/** Recording and dependency metadata are opt-in, including for disk builds. */
export function withProvenance(compile) {
  return (options) => {
    const expose = options.provenance ?? (process.env.GOGEN_PROVENANCE === "1");
    const run = () => {
      if (options.registry) options = {...options, registry: freshRegistry(options.registry, options.session)};
      if (options.registry && active) active.inventory(options.registry, [...registryObjects.call(options.registry)]);
      const program = compile(options);
      finishInputs(program.reg);
      return program;
    };
    return expose ? recordProvenance(run, {expose}) : run();
  };
}

export function beginProvenanceCompile(reg) {
  if (!active) return;
  const state = active.state(reg);
  // Retain provider-building observations, never a previous entry's transcript.
  state.lowerings.clear();
  state.finalOutput = empty();
  state.scheduling.queries = new Map([...state.scheduling.queries].filter(([, row]) =>
    row.kind.startsWith("registry-") || ["global-definitions", "include-macro-context"].includes(row.kind)));
}

export function withArtifact(ctx, obj, run, phase = "lowering") {
  return active ? active.artifact(ctx.reg, obj.obj ?? obj, phase, run) : run();
}

export function artifactLowering(lower) {
  return (ctx, obj, ...args) => withArtifact(ctx, obj, () => lower(ctx, obj, ...args));
}

// Disk IR replay performs no lowering lookups. Carry its stored observation
// transcript too, without using it to validate or change any cache key.
export const recordingProvenance = () => !!active;

export function storedProvenance(reg, obj) {
  if (!active) return;
  const state = active.state(reg), key = keyOf(obj.obj ?? obj);
  const entries = [active.entry(state, key), active.entry(state, key, true)];
  return {rows: entries.flatMap((e) => [...e.queries.values()]), edges: [...new Set(entries.flatMap((e) => [...e.edges]))]};
}

export function inheritStoredProvenance(reg, obj, stored) {
  if (!active) return;
  const state = active.state(reg), key = keyOf(obj.obj ?? obj);
  if (!stored || !Array.isArray(stored.rows) || !Array.isArray(stored.edges)) {
    active.query(state, {kind: "unknown-scan", args: ["lowering-built-before-recording"], result: []}, key);
    return;
  }
  const entry = active.entry(state, key, true);
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
      result: value ? [keyOf(value.group)] : [], policy: "gogen-last-wins"});
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
    for (const g of enumerateObjects(reg, "function-module-index", [], "scheduling", (o) => o instanceof abaplint.Objects.FunctionGroup)) {
      for (const m of g.getModules()) fmGroups.set(upper(m.getName()), g.getName().toLowerCase());
    }
  };
  withRole("scheduling", index);
  for (let i = 0; i < wanted.length; i++) {
    const obj = withRole("scheduling", () => reg.getObject("CLAS", wanted[i]) ?? reg.getObject("FUGR", wanted[i]));
    const run = () => {
      for (const file of obj?.getABAPFiles() ?? []) {
        for (const match of file.getRaw().matchAll(/\bCALL\s+FUNCTION\s+'([^']+)'/gi)) {
          const group = fmGroups.get(upper(match[1]));
          if (active) active.query(active.state(reg), {kind: "function-module-owner", args: [upper(match[1])],
            result: group ? [`FUGR ${upper(group)}`] : [], policy: "gogen-last-wins"});
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
export function provenanceOf(value, {internal = false} = {}) {
  // Source normalization can create temporary registries for the same object.
  // A program/session manifest belongs only to its actual compiler registry.
  const reg = value?.reg ?? value?.registry ?? value;
  const result = results.get(value);
  const state = (internal || active ? registries : published).get(reg);
  const states = internal || active ? (state ? new Set([state]) : new Set())
    : result ? (result.exposed ? result.states : new Set()) : state ? new Set([state]) : new Set();
  const output = new Map();
  for (const state of states) if ((!value?.reg && !value?.registry || state.reg === reg)
      && (internal || state.exposed)) for (const owner of state.entries.keys()) {
    const seen = new Set(), queries = new Map(state.global.queries);
    const lowering = state.lowerings.get(owner);
    for (const [id, row] of lowering?.queries ?? []) queries.set(id, row);
    const visit = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      const entry = state.entries.get(key);
      if (!entry) return;
      for (const [id, row] of entry.queries) queries.set(id, row);
      for (const edge of entry.edges) visit(edge);
    };
    visit(owner);
    for (const edge of lowering?.edges ?? []) visit(edge);
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

// Explicit, audited enumeration: these APIs classify a single call site, never
// grant an exemption to other calls from the same file or an enclosing pass.
export function enumerateObjects(reg, kind, args = [], role = "scheduling", predicate = () => true) {
  const objects = [...registryObjects.call(reg)].filter(predicate);
  if (active) {
    const state = active.state(reg);
    for (const obj of objects) active.entry(state, keyOf(obj));
    active.query(state, {kind, args, role, scan: "getObjects", result: objects.map(keyOf), complete: true});
  }
  return objects;
}
export function semanticQuery(reg, kind, args, result, details = {}) {
  if (active) active.query(active.state(reg), {kind, args, result, ...details});
}
export function withRole(role, run) {
  if (!active) return run();
  active.roles.push(role);
  try { return run(); } finally { active.roles.pop(); }
}
export function auditedBookkeeping(purpose, run) {
  // Only named call sites with a local rationale may use this exclusion.
  if (!active) return run();
  active.auditDepth++;
  try { return run(); } finally { active.auditDepth--; }
}
export function compilationProvenanceOf(value) {
  const reg = value?.reg ?? value?.registry ?? value;
  const state = (active ? registries : published).get(reg);
  return {scheduling: [...state?.scheduling.queries.values() ?? []], finalOutput: [...state?.finalOutput.queries.values() ?? []]};
}
export function provenanceGraph(reg) {
  const state = registries.get(reg);
  if (!state) return;
  return {artifacts: state.entries, lowerings: state.lowerings, global: state.global};
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
