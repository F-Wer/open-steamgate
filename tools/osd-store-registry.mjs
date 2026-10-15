import {activeSystem, matchesSourcePath} from "./osd-system.mjs";
import {layers} from "./osd-inputs.mjs";
// Registry construction, diagnostics and temporary source borrowing.
import {readFileSync, readdirSync, realpathSync, statSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import * as abaplint from "@abaplint/core";
import {ddlsIssues} from "./osd-store-ddls.mjs";
import {config as publicationValidation} from "@abaplint/transpiler/build/src/validation.js";
import {TYPES} from "./osd-store-types.mjs";
import {OBJECT_NAME_PATTERN} from "./osd-object-name.mjs";

// The parse is shared per root. Known source mutations queue only their files;
// configuration/root changes invalidate the whole registry.
const PARSED = new Map();
const INPUTS = new WeakMap();
export const registryInputs = registry => INPUTS.get(registry);
const PENDING = new Map();
const REFERENCES = new WeakMap();
const REVISIONS = new WeakMap();
export const registryRevision = registry => REVISIONS.get(registry) ?? 0;

export function forgetRegistry(store, files) {
  if (files !== undefined && PARSED.has(store.root)) {
    const dirty = PENDING.get(store.root) ?? new Set();
    for (const file of files) dirty.add(file);
    PENDING.set(store.root, dirty);
  } else {
    store.parsed = undefined;
    PARSED.delete(store.root);
    PENDING.delete(store.root);
  }
}

// A lexical reverse index deliberately includes comments and strings. Extra
// candidates cost a check; missed readers would reuse stale syntax results.
function indexObject(index, object) {
  for (const word of index.words.get(object) ?? []) {
    const readers = index.readers.get(word);
    readers?.delete(object);
    if (!readers?.size) index.readers.delete(word);
  }
  const words = new Set(object.getFiles().flatMap(file =>
    file.getRaw().toUpperCase().match(new RegExp(OBJECT_NAME_PATTERN, "g")) ?? []));
  index.words.set(object, words);
  for (const word of words) {
    if (!index.readers.has(word)) index.readers.set(word, new Set());
    index.readers.get(word).add(object);
  }
}
function referenceIndex(registry) {
  let index = REFERENCES.get(registry);
  if (!index) {
    index = {words: new Map(), readers: new Map()};
    for (const object of registry.getObjects()) indexObject(index, object);
    REFERENCES.set(registry, index);
  }
  return index;
}
// One closure for cache invalidation and activation checking. Stop collecting
// candidates at the check limit; its caller then checks the full registry.
function readerClosure(index, names, limit = Infinity) {
  const reached = new Set(names);
  const queue = [...reached];
  const affected = new Set();
  for (const name of queue) {
    for (const reader of index.readers.get(name) ?? []) {
      if (affected.has(reader)) continue;
      affected.add(reader);
      if (affected.size > limit) return undefined;
      const key = reader.getName().toUpperCase();
      if (!reached.has(key)) {reached.add(key); queue.push(key);}
    }
  }
  return affected;
}

// Update/add/remove only the changed object's files and dirty its transitive
// readers before parsing. Both sides of temporary overlays use this too, so
// a cached caller cannot survive either the substitution or its restoration.
export function updateRegistryFiles(registry, replacements) {
  const index = referenceIndex(registry);
  const changed = new Set();
  for (const [filename, source] of replacements) {
    const before = registry.getFileByName(filename);
    if (before?.getRaw() === source || before === undefined && source === undefined) continue;
    const file = source === undefined ? before : new abaplint.MemoryFile(filename, source);
    const previousObject = registry.getObject(file.getObjectType(), file.getObjectName());
    changed.add(file.getObjectName().toUpperCase());
    if (source === undefined) registry.removeFile(before);
    else if (before === undefined) registry.addFile(file);
    else registry.updateFile(file);
    const object = registry.getObject(file.getObjectType(), file.getObjectName());
    if (previousObject && previousObject !== object) {
      for (const word of index.words.get(previousObject) ?? []) index.readers.get(word)?.delete(previousObject);
      index.words.delete(previousObject);
    }
    if (object) indexObject(index, object);
  }
  const affected = readerClosure(index, changed);
  if (changed.size) REVISIONS.set(registry, registryRevision(registry) + 1);
  for (const object of affected) object.setDirty();
  registry.parse();
}

export function walkStoreFiles(store, dir, out, system = activeSystem(store.root)) {
  let entries;
  try {
    // sorted, so two walks of one tree index it the same way
    entries = readdirSync(join(store.root, dir)).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const relative = join(dir, entry);
    if (statSync(join(store.root, relative)).isDirectory()) {
      walkStoreFiles(store, relative, out, system);
    } else {
      // the build's exclusions, matched the way the transpiler matches them
      // -- against the path with a leading slash
      if (matchesSourcePath(store.root, system ? join(store.root, relative) : "/" + relative, store.excluded, system ?? null)) {
        continue;
      }
      out.push(relative);
    }
  }
  return out;
}

// Keep publication validation synchronous without rereading the system on
// WRITE -> ACTIVATE. Initial parsing is cold; subsequent known edits are not.
export function configuredRegistry(store, configPath = "abaplint.jsonc") {
  const collectInputs = store.registryInputs === true;
  const configFile = collectInputs ? realpathSync(join(store.root, configPath)) : join(store.root, configPath);
  const configRaw = readFileSync(configFile);
  const text = configRaw.toString("utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const config = JSON.parse(text);
  // The publication validator owns these rules. Keep identifier and
  // structural checks identical for saved includes and compiled includes.
  const validation = structuredClone(publicationValidation);
  validation.rules.check_syntax = true;
  validation.rules.forbidden_identifier.check = ["^unique\\d+$"];
  const registry = new abaplint.Registry(new abaplint.Config(JSON.stringify({
    global: {files: "/**/*.*"},
    syntax: config.syntax,
    // DDLS/SRVD are generator inputs excluded from the transpiler; their
    // dedicated checks below remain authoritative for those source types.
    rules: {...validation.rules, allowed_object_types: {...validation.rules.allowed_object_types,
      allowed: [...validation.rules.allowed_object_types.allowed, "DDLS", "SRVD", "SAPC", "SAMC"]}},
  })));
  return {registry, configFile, configSha: createHash("sha256").update(configRaw).digest("hex")};
}

export function buildRegistry(store, configPath = "abaplint.jsonc") {
  const shared = PARSED.get(store.root);
  if (shared !== undefined) {
    const files = PENDING.get(store.root);
    if (files?.size) {
      updateRegistryFiles(shared, [...files].filter(file => /\.(abap|xml|asddls)$/.test(file)).map(file => {
        let source;
        try {source = readFileSync(join(store.root, file), "utf8");}
        catch (error) {if (error.code !== "ENOENT") throw error;}
        return ["/" + file, source];
      }));
      PENDING.delete(store.root);
    }
    store.parsed = shared;
    return shared;
  }
  const configured = configuredRegistry(store, configPath);
  const registry = configured.registry;
  const paths = store.registryInputs === true ? new Map() : undefined;
  if (paths !== undefined) INPUTS.set(registry, {configFile: configured.configFile, configSha: configured.configSha, paths});
  // everything, not only what the index calls an object: a class needs its
  // local includes, and a type pool is not an ADT object but the check
  // still needs it
  const hidden = new Set(layers(store.root, {input_folder: store.roots.map(r => r.path)}, process.env, {discoveryOnly: true}).hidden);
  for (const root of [...store.roots, ...store.libs]) {
    for (const file of root.files ?? walkStoreFiles(store, root.path, [])) {
      if (hidden.has(file) || /\.(abap|xml|asddls)$/.test(file) === false) {
        continue;
      }
      const path = paths !== undefined ? realpathSync(join(store.root, file)) : join(store.root, file);
      if (paths !== undefined) paths.set("/" + file, path);
      registry.addFile(new abaplint.MemoryFile("/" + file, readFileSync(path, "utf8")));
    }
  }
  registry.parse();
  referenceIndex(registry);
  store.parsed = registry;
  PARSED.set(store.root, registry);
  return registry;
}

export function registryDependents(registry, type, name) {
  const index = referenceIndex(registry);
  const self = registry.getObject(TYPES[type]?.sameFileAs ?? type, name);
  const limit = 256;
  const closure = readerClosure(index, [String(name).toUpperCase()], limit);
  if (!closure) console.warn(`activation ${type} ${name}: dirty reader closure exceeds ${limit} objects; falling back to a full registry check`);
  return [...(closure ?? registry.getObjects())]
    .filter(object => object !== self)
    .map(object => ({type: object.getType(), name: object.getName()}));
}

// the issues of one object, in the shape the façade returns
export function registryIssues(registry, type, name, options = undefined) {
  const {endCoordinates = false} = options ?? {};
  // an include is a program to abaplint: the registry files it as PROG,
  // and asking for INCL finds nothing and calls a clean include broken
  const object = registry.getObject(TYPES[type]?.sameFileAs ?? type, name);
  if (object === undefined) {
    return {type, name, issues: [{severity: "E", message: `${type} ${name} is not in the registry`, line: 1, column: 1}]};
  }
  // **A CDS view was checked by nobody.** `findIssuesObject` answers `[]`
  // for a DDLS whatever it contains: measured on `ZC_OSD_PACK` mangled to
  // `definnnne vieeew` and on one selecting from a table that does not
  // exist -- both "no issues", and `npm run lint` agreed, 0 of 416. The
  // build then failed naming a CONSUMER (`zcl_zosd_status_dpc:43`, "ZC_OSD_PACK
  // not found") and never the file somebody had just edited. For a screen
  // with a Check button that is the worst of the three: it says fine, and
  // Activate fails somewhere else (2026-09-19).
  //
  // The generator already reads these, and its refusals are named. So the
  // check asks it: "the check passed" now means "the thing that has to
  // read this can", which is what activation will need anyway.
  const extra = type === "DDLS" ? ddlsIssues(registry, object) : [];
  const issues = [...extra, ...registry.findIssuesObject(object).map((issue) => ({
    severity: "E",
    rule: issue.getKey(),
    message: issue.getMessage(),
    file: issue.getFilename(),
    line: issue.getStart().getRow(),
    column: issue.getStart().getCol(),
    ...(endCoordinates ? {
      endLine: issue.getEnd().getRow(),
      endColumn: issue.getEnd().getCol(),
    } : {}),
  }))];
  return {type, name, issues};
}

// the given text stands in for one file, for the length of one call. The
// shared parse is borrowed rather than rebuilt, because rebuilding it is
// seconds and a human is waiting; the file goes back in a finally, and
// nothing between the two lines is asynchronous, so no other caller can
// see the substitution. abaplint reparses only what the swap dirtied.
export function withSource(store, file, source, fn) {
  const registry = store.registry();
  const filename = "/" + file;
  const before = registry.getFileByName(filename);
  try {
    updateRegistryFiles(registry, [[filename, source]]);
    return fn(registry);
  } finally {
    updateRegistryFiles(registry, [[filename, before?.getRaw()]]);
  }
}
