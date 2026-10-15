// One ordered effective-input snapshot shared by freshness, tracing and digests.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
export const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
const enumerate = core.Registry.prototype.getObjects;
const snapshots = new WeakMap(), parsed = new WeakMap(), replacements = new WeakMap(), origins = new WeakMap(), keys = new WeakMap();
const hasBuiltArtifacts = (inputs) => [...inputs.objects.values()].some(({obj}) =>
  obj.syntaxResult || obj.def || obj.definition || obj.parsedType || obj.isDirty?.() === false);
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function objectKey(obj) {
  if (!keys.has(obj)) keys.set(obj, `${obj.getType()} ${obj.getName().toUpperCase()}`);
  return keys.get(obj);
}

export function inputSnapshot(reg, refresh = false) {
  if (!refresh && snapshots.has(reg)) return snapshots.get(reg);
  // AUDITED bookkeeping: enumerate effective inputs, never semantic resolution.
  const objects = new Map(), fileOwners = new Map(), files = [], signature = [];
  for (const obj of reg instanceof core.Registry ? enumerate.call(reg) : reg.getObjects()) {
    const key = objectKey(obj), dependency = reg.isDependency?.(obj) ?? false;
    const sources = obj.getFiles().map((file) => {
      const source = {file, name: file.getFilename(), raw: file.getRaw()};
      Object.defineProperties(source, {
        rawHash: {get() { return this._rawHash ??= hash(this.raw); }},
        // Artifact format 2 hashes the JSON string, not just raw bytes.
        artifactHash: {get() { return this._artifactHash ??= hash(JSON.stringify(this.raw)); }},
      });
      fileOwners.set(source.name, key); files.push(file);
      return source;
    });
    objects.set(key, {obj, dependency, sources});
    signature.push([key, dependency, sources.map((s) => [s.name, s.raw])]);
  }
  const config = JSON.stringify(reg.getConfig?.().get() ?? {});
  const snapshot = {objects, fileOwners, files, config, configObject: reg.getConfig?.(),
    signature: JSON.stringify([config, signature])};
  snapshots.set(reg, snapshot);
  return snapshot;
}

// Observe parse boundaries even when callers prepare registries before compile.
// Re-parsing an edited registry does not certify its retained consumer caches.
for (const method of ["parse", "parseAsync"]) {
  const original = core.Registry.prototype[method];
  core.Registry.prototype[method] = function(...args) {
    const before = inputSnapshot(this, true), previous = parsed.get(this);
    // The first observed parse cannot vouch for artifacts built before observation.
    const untrusted = !previous && hasBuiltArtifacts(before);
    const finish = () => {
      if (!untrusted && (!previous || previous.signature === before.signature && previous.configObject === before.configObject)) parsed.set(this, inputSnapshot(this, true));
    };
    const result = original.apply(this, args);
    if (result?.then) return result.then((value) => { finish(); return value; });
    finish(); return result;
  };
}

export function freshRegistry(reg, session) {
  const inputs = inputSnapshot(reg, true), previous = parsed.get(reg);
  const retained = replacements.get(reg);
  if (retained?.signature === inputs.signature && retained.configObject === inputs.configObject
      && inputSnapshot(retained.reg, true).signature === inputs.signature) return retained.reg;
  if (previous?.signature === inputs.signature && previous.configObject === inputs.configObject) return reg;
  // A never-parsed registry can be parsed in place. A prebuilt registry without
  // an observed boundary must be rebuilt, as must every edited retained one.
  const built = hasBuiltArtifacts(inputs);
  if (!previous && !built) { reg.parse(); return reg; }
  const fresh = new core.Registry(new core.Config(inputs.config));
  for (const {dependency, sources} of inputs.objects.values()) for (const source of sources) {
    const file = new core.MemoryFile(source.name, source.raw);
    if (dependency) fresh.addDependency(file); else fresh.addFile(file);
  }
  if (session) for (const key of Object.keys(session)) delete session[key];
  fresh.parse();
  origins.set(fresh, inputOrigin(reg));
  replacements.set(reg, {signature: inputs.signature, configObject: inputs.configObject, reg: fresh});
  return fresh;
}

export const inputOrigin = (reg) => origins.get(reg) ?? reg;

export function finishInputs(reg) {
  // AUDITED bookkeeping: core may synthesize files during DDIC resolution.
  const snapshot = inputSnapshot(reg, true);
  parsed.set(reg, snapshot);
  return snapshot;
}
