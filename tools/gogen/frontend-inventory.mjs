// One ordered effective-input snapshot shared by freshness, tracing and digests.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
/** @type {typeof import("@abaplint/core")} */ export const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
/** @type {import("@abaplint/core").Registry["getObjects"]} */ const enumerate = core.Registry.prototype.getObjects;
const /** @type {WeakMap<import("./frontend-session-types.ts").Registry, import("./frontend-session-types.ts").InputSnapshot>} */ snapshots = new WeakMap(), /** @type {WeakMap<import("./frontend-session-types.ts").Registry, import("./frontend-session-types.ts").InputSnapshot>} */ parsed = new WeakMap(), /** @type {WeakMap<import("./frontend-session-types.ts").Registry, import("./frontend-cache-types.ts").Replacement>} */ replacements = new WeakMap(), /** @type {WeakMap<import("./frontend-session-types.ts").Registry, import("./frontend-session-types.ts").Registry>} */ origins = new WeakMap(), /** @type {WeakMap<Pick<import("./frontend-session-types.ts").ArtifactObject, "getType" | "getName">, string>} */ keys = new WeakMap();
const artifactFields = ["syntaxResult", "parsedType", "def", "definition", "parsed", "modules", "includes"];
/** @param {import("./frontend-session-types.ts").ArtifactObject} obj @returns {import("./frontend-session-types.ts").ArtifactIdentity} */ export const artifactIdentity = (obj) => artifactFields.map((name) => obj[name]);
/** @param {import("./frontend-session-types.ts").ArtifactIdentity | undefined} a @param {import("./frontend-session-types.ts").ArtifactIdentity} b @returns {boolean | undefined} */ export const sameArtifactIdentity = (a, b) => a?.every((value, i) => value === b[i]);
/** @param {import("./frontend-session-types.ts").InputSnapshot} inputs @returns {boolean} */ const hasBuiltArtifacts = (inputs) => [...inputs.objects.values()].some(({obj}) =>
  obj.syntaxResult || obj.def || obj.definition || obj.parsedType || obj.isDirty?.() === false);
/** @param {string} s @returns {string} */ const hash = (s) => createHash("sha256").update(s).digest("hex");
/** @param {Pick<import("./frontend-session-types.ts").ArtifactObject, "getType" | "getName">} obj @returns {string} */ export function objectKey(obj) {
  if (!keys.has(obj)) keys.set(obj, `${obj.getType()} ${obj.getName().toUpperCase()}`);
  return keys.get(obj);
}

/** @param {import("./frontend-session-types.ts").Registry} reg @param {boolean} refresh @returns {import("./frontend-session-types.ts").InputSnapshot} */ export function inputSnapshot(reg, refresh = false) {
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

/** @param {import("./frontend-session-types.ts").Registry} reg @param {import("./frontend-session-types.ts").SessionInput} session @returns {import("./frontend-session-types.ts").Registry} */ export function freshRegistry(reg, session) {
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

/** @param {import("./frontend-session-types.ts").Registry} reg @returns {import("./frontend-session-types.ts").Registry} */ export const inputOrigin = (reg) => origins.get(reg) ?? reg;

/** @param {import("./frontend-session-types.ts").Registry} reg @returns {import("./frontend-session-types.ts").InputSnapshot} */ export function finishInputs(reg) {
  // AUDITED bookkeeping: core may synthesize files during DDIC resolution.
  const snapshot = inputSnapshot(reg, true);
  parsed.set(reg, snapshot);
  return snapshot;
}

// Collect superclass descriptions in the existing RTTI inventory traversal.
/** @template {import("@abaplint/core").IObject} T @param {Iterable<T>} objects @param {Map<string, string | null>} classSupers @returns {Generator<T>} */ export function* rttiClassInventory(objects, classSupers) {
  for (const obj of objects) {
    if (obj instanceof core.Objects.Class) classSupers.set(obj.getName().toUpperCase(), obj.getDefinition()?.getSuperClass()?.toUpperCase() ?? null);
    yield obj;
  }
}

/** @param {Map<string, string | null>} classSupers @param {{classes: readonly {name: string, super: string | null}[]}} program @returns {Map<string, string | null>} */ export function rttiLocalSupers(classSupers, program) {
  // Compiled local classes use the same POOL:LOCAL internal name as object RTTI.
  for (const cls of program.classes) if (cls.name.includes(":")) classSupers.set(cls.name, cls.super);
  return classSupers;
}

// Sources intentionally kept outside abaplint's registry. Preserve the exact
// load order and raw text, including malformed sources and empty inventories.
/** @type {WeakMap<import("./frontend-session-types.ts").Registry, import("./frontend-cache-types.ts").CdsInputs>} */ const cdsInputs = new WeakMap();
/** @param {import("./frontend-session-types.ts").Registry} reg @param {readonly import("./frontend-cache-types.ts").CdsSource[]} sources @returns {boolean} */ export function setCdsInputs(reg, sources) {
  const ordered = sources.map((input, index) => {
    const {filename, source} = typeof input === "string"
      ? {filename: `gogen_${index}.ddls.asddls`, source: input} : input;
    if (typeof filename !== "string" || typeof source !== "string")
      throw new TypeError("CDS inputs require string filename and source");
    return [filename, source];
  });
  const origin = inputOrigin(reg), previous = cdsInputs.get(origin);
  if (previous?.ordered.length === ordered.length && ordered.every(([file, source], i) =>
    previous.ordered[i][0] === file && previous.ordered[i][1] === source)) return false;
  cdsInputs.set(origin, {ordered});
  return true;
}
// Stable until the ordered raw inputs change; sessions retain their own identity.
/** @param {import("./frontend-session-types.ts").Registry} reg @returns {import("./frontend-cache-types.ts").CdsInputs} */ export function cdsInputIdentity(reg) {
  const origin = inputOrigin(reg);
  if (!cdsInputs.has(origin)) cdsInputs.set(origin, {ordered: []});
  return cdsInputs.get(origin);
}
/** @param {import("./frontend-session-types.ts").Registry} reg @returns {string} */ export function cdsInputDigest(reg) {
  const inputs = cdsInputIdentity(reg);
  // Keep absolute filenames in the digest: refusal messages embed them.
  return inputs.digest ??= hash(JSON.stringify(inputs.ordered));
}

/** @param {import("./frontend-session-types.ts").Registry} reg @param {import("./frontend-cache-types.ts").CdsSource[]} ddls @param {boolean} refresh @param {WeakMap<import("./frontend-session-types.ts").Registry, Record<string, string>>} cdsViewsByRegistry @returns {void} */ export function prepareCdsRegistry(reg, ddls, refresh, cdsViewsByRegistry) {
  /** @type {Pick<typeof import("./frontend-analysis.mjs"), "cdsSqlViews" | "bindCdsRegistry">} */ const {cdsSqlViews, bindCdsRegistry} = require("./frontend-analysis.mjs");
  // An empty folder list with a supplied registry reuses its complete inputs.
  const origin = inputOrigin(reg), changedCds = refresh && setCdsInputs(reg, ddls);
  if (changedCds || !cdsViewsByRegistry.has(origin)) {
    cdsViewsByRegistry.set(origin, cdsSqlViews(ddls));
  }
  const views = cdsViewsByRegistry.get(origin);
  cdsViewsByRegistry.set(reg, views);
  /** @type {Pick<typeof import("./frontend-provenance.mjs"), "recordingProvenance" | "semanticQuery">} */ const {recordingProvenance, semanticQuery} = require("./frontend-provenance.mjs");
  bindCdsRegistry(views, (name) => {
    if (recordingProvenance()) semanticQuery(reg, "cds-mapping", [name], [],
      {descriptor: cdsInputDigest(reg), policy: "ordered-raw-ddls"});
  });
}

/** @param {import("./frontend-session-types.ts").SessionInput} session @param {import("./frontend-session-types.ts").Registry} reg @returns {import("./frontend-cache-types.ts").CdsInputs} */ export function prepareCdsSession(session, reg) {
  const cdsIdentity = cdsInputIdentity(reg);
  if (session && session.cdsInputs !== cdsIdentity) {
    // Compare what this session cached, even if another compile updated the origin.
    const root = session.cacheDir;
    for (const key of Object.keys(session)) delete session[key];
    if (root) session.cacheDir = root;
  }
  // Preparation can clear session fields, so the caller retains this identity afterwards.
  return cdsIdentity;
}
