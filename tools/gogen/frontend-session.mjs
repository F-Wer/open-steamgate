import {artifactLowering, storedProvenance, inheritStoredProvenance} from "./frontend-provenance.mjs";
import {append} from "./append.ts";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";
// A unit closure keeps one immutable registry. Reuse lowering only for
// elementary classes directly. Dependency-sensitive classes record their
// program reads and effects and retry whenever a recorded input changes.
const scalarKinds = new Set(["i", "int8", "f", "p", "c", "x", "n", "d", "t", "string", "xstring", "void"]);
const sensitiveSource = /=>|->|~|\b(?:TYPES|CONSTANTS|INTERFACES|INHERITING|NEW|CATCH|RAISE|ASSIGN|SELECT|INSERT|DELETE|UPDATE|MODIFY|APPEND|COLLECT|SUBMIT|DESCRIBE)\b|\b(?:CALL\s+FUNCTION|IS\s+(?:NOT\s+)?SUPPLIED|SET\s+HANDLER|GET\s+REFERENCE)\b/i;
const current = new Set(["currentClass", "currentOwner", "currentTypes"]);
const effects = new Set(["skipped", "partial"]);

/** @param {import('./frontend-session-types.ts').SessionInput} session @param {import('./frontend-session-types.ts').Registry} registry @returns {void} */ export function prepareSession(session, registry) {
  if (!session) return;
  // Non-ABAP artifacts can remain dirty after parse(). File identity and
  // immutable Config identity detect actual edits without clearing a valid
  // session on every closure round because of those unrelated artifacts.
  /** @type {import('./frontend-session-types.ts').SourceFile[]} */ const files = [...registry.getObjects()].flatMap((o) => o.getFiles());
  if (session.registry !== registry || session.config !== registry.getConfig()
      || files.length !== session.files?.length || files.some((f, i) => f !== session.files[i])) {
    for (const key of Object.keys(session)) delete session[key];
    Object.assign(session, {registry, config: registry.getConfig(), files, classes: new Map()});
  }
}

/** @param {unknown} value @param {string} self @param {Set<object>} seen @returns {boolean} */ function elementary(value, self, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  if (value.k && !scalarKinds.has(value.k) && !(value.k === "ref" && !value.intf && value.name === self)) return false;
  const children = value instanceof Map ? [...value.values()] : Object.values(value);
  return children.every((v) => elementary(v, self, seen));
}

/** @param {import('./frontend-session-types.ts').SessionProgram} program @returns {import('./frontend-session-types.ts').ProgramSnapshot} */ function snapshot(program) {
  return new Map(Object.entries(program).filter(([key]) => !current.has(key) && !effects.has(key)).map(([key, value]) =>
    [key, value instanceof Map ? new Map(value) : value instanceof Set ? new Set(value) : value]));
}

/** @param {import('./frontend-session-types.ts').ProgramSnapshot} before @param {import('./frontend-session-types.ts').SessionProgram} program @returns {boolean} */ function unchanged(before, program) {
  const keys = Object.keys(program).filter((key) => !current.has(key) && !effects.has(key));
  if (keys.length !== before.size) return false;
  for (const key of keys) {
    if (key === "sigs") continue;
    const a = before.get(key), b = program[key];
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)) return false;
    } else if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size || [...a].some((v) => !b.has(v))) return false;
    } else if (a !== b) return false;
  }
  return true;
}

/** @param {import('./frontend-session-types.ts').Signatures} before @param {import('./frontend-session-types.ts').Signatures} after @param {string} owner @returns {import('./frontend-session-types.ts').SignatureChanges | undefined} */ function ownSignatures(before, after, owner) {
  if ([...before.keys()].some((k) => !after.has(k))) return;
  const changes = [...after].filter(([k, v]) => before.get(k) !== v);
  return changes.every(([k, v]) => k.startsWith(`${owner}=>`) && elementary(v, owner)) ? changes : undefined;
}

/** @param {import('./frontend-session-types.ts').SessionProgram} program @param {string} owner @returns {string} */ function suppliedKey(program, owner) {
  return JSON.stringify([...program.supplied].filter(([k]) => k.startsWith(`${owner}=>`)).map(([k, v]) => [k, [...v]]));
}

export const compileClass = artifactLowering(/** @param {import('./frontend-session-types.ts').LoweringContext} ctx @param {import('./frontend-session-types.ts').ClassObject} obj @param {import('./frontend-session-types.ts').ClassLowering} lower @param {import('./frontend-session-types.ts').CacheSession | undefined} session @returns {import('./frontend-session-types.ts').ClassIR} */ function compileClass(ctx, obj, lower, session) {
  const program = ctx.program;
  const counts = program.frontendCounts;
  const file = obj.getMainABAPFile();
  const key = obj.getName().toUpperCase();
  /** @type {import('./frontend-session-types.ts').SessionEntry | undefined} */ const cached = session?.classes.get(key);
  if (cached && cached.file === file && cached.structure === file.getStructure() && cached.supplied === suppliedKey(program, key) && (!cached.replay || replayLowering(program, cached.replay))) {
    inheritStoredProvenance(program.reg, obj, cached.provenance);
    Object.assign(program, cached.current);
    for (const [k, sig] of cached.sigs ?? []) program.sigs.set(k, sig);
    if (!cached.replay) {
      append(program.skipped, cached.skipped);
      append(program.partial, cached.partial);
    }
    counts.reused++;
    counts.reusedClasses.push(key);
    return cached.ir;
  }
  counts.lowered++;
  counts.loweredClasses.push(key);
  // The source guard rejects hidden closure dependencies even in refused
  // bodies. The IR check rejects composites and references to other classes. Finally, reject
  // any lowering that changed shared program state; only diagnostics and
  // current-class context and elementary own-method signatures can be
  // replayed without changing naming/order.
  /** @type {boolean | undefined} */ const candidate = session && !sensitiveSource.test(file.getRaw());
  /** @type {import('./frontend-session-types.ts').ProgramSnapshot | undefined} */ const before = candidate ? snapshot(program) : undefined;
  const start = {skipped: program.skipped.length, partial: program.partial.length};
  /** @type {import('./frontend-session-types.ts').RecordedLowering | undefined} */ const recorded = session && !candidate && !/\bFOR\s+ALL\s+ENTRIES\b/i.test(file.getRaw()) ? recordLowering(program, (tracked) => lower({...ctx, program: tracked}, obj)) : undefined;
  /** @type {import('./frontend-session-types.ts').ClassIR} */ const ir = recorded ? recorded.ir : lower(ctx, obj);
  /** @type {import('./frontend-session-types.ts').SignatureChanges | undefined} */ const sigs = candidate ? ownSignatures(before.get("sigs"), program.sigs, key) : undefined;
  if (candidate && sigs && unchanged(before, program) && elementary(ir, key)) {
    session.classes.set(key, {file, structure: file.getStructure(), ir, sigs, supplied: suppliedKey(program, key),
      current: Object.fromEntries([...current].map((k) => [k, program[k]])),
      skipped: program.skipped.slice(start.skipped), partial: program.partial.slice(start.partial)});
  }
  if (recorded?.replay) session.classes.set(key, {file, structure: file.getStructure(), ir,
    replay: recorded.replay, supplied: suppliedKey(program, key),
    current: Object.fromEntries([...current].map((k) => [k, program[k]]))});
  /** @type {import('./frontend-session-types.ts').SessionEntry | undefined} */ const entry = session?.classes.get(key);
  /** @type {import('./frontend-session-types.ts').StoredProvenance | undefined} */ const provenance = entry && storedProvenance(program.reg, obj);
  if (provenance) entry.provenance = provenance;
  return ir;
});

/** @param {import('./frontend-session-types.ts').SessionInput} session @param {import('./frontend-session-types.ts').Registry} registry @returns {void} */ export function finishSession(session, registry) {
  // Abaplint can synthesize registry files while resolving dictionary types.
  // These belong to this completed pass, rather than to an external edit.
  if (session) session.files = [...registry.getObjects()].flatMap((o) => o.getFiles());
}
