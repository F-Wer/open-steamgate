// Resolved snapshots, never registry graphs. A lazy table is installed per compile;
// definitions and types are projected/hash-consed once within that table.
import {inputSnapshot, core, artifactIdentity, sameArtifactIdentity} from "./frontend-inventory.mjs";
import {recordedArtifactBuild, auditedBookkeeping} from "./frontend-provenance.mjs";
import {createHash} from "node:crypto";
import {basename} from "node:path";
const tables = new WeakMap();
export const artifactKey = (obj) => `${obj.getType()} ${obj.getName().toUpperCase()}`;
export const portableFilename = (name) => name == null ? null : basename(name.replaceAll("\\", "/"));
const pos = (p) => p ? [p.getRow(), p.getCol(), p.vrow ?? null, p.vcol ?? null] : null;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Sort dictionaries with code-point order, not locale or insertion order.
export function canonical(value) {
  if (value === undefined) return null;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError(`unsupported semantic data: ${value.constructor?.name}`);
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
}
const entries = (dict, project) => Object.keys(dict ?? {}).sort().map((k) => [k, project(dict[k])]);
const all = (container) => [...(container?.getAll() ?? [])];
const location = (id) => [id.constructor.name, id.getName(), portableFilename(id.getFilename()), pos(id.getStart())];

class Digests {
  constructor(registry) {
    this.registry = registry;
    this.memo = new WeakMap();
    this.building = new WeakSet();
    this.values = new Map();
    this.identities = new Map();
    this.errors = new Map();
    this.timings = new Map();
    this.stats = {objects: 0, nodes: 0, milliseconds: 0, inventoryMilliseconds: 0};
  }
  inventory() {
    if (this.objects) return;
    const start = performance.now();
    // AUDITED digest inventory: shared source ownership, no semantic scan.
    const snapshot = inputSnapshot(this.registry);
    this.objects = new Map([...snapshot.objects].map(([key, {obj}]) => [key, obj]));
    this.owners = snapshot.fileOwners;
    this.stats.inventoryMilliseconds = performance.now() - start;
    this.stats.milliseconds += this.stats.inventoryMilliseconds;
  }
  memoized(value, project) {
    if (!value) return null;
    if (this.memo.has(value)) return this.memo.get(value);
    if (this.building.has(value)) throw new TypeError("recursive semantic shape");
    this.building.add(value);
    try {
      const digest = hash(project());
      this.memo.set(value, digest); this.stats.nodes++;
      return digest;
    } finally { this.building.delete(value); }
  }
  syntax(node) {
    if (!node) return null;
    return this.memoized(node, () => {
      const project = (n) => {
        const inner = n.get?.();
        // The pinned parser also produces TokenNodeRegex, with empty children.
        if (typeof inner?.getStr === "function") return this.token(inner);
        // Rearranger mutates Source expression grouping in place during lowering.
        // Tokens (including parentheses and positions) canonically describe the
        // same expression before/after precedence regrouping, without cloning or
        // walking unread owners. Types/resolution are projected separately below.
        if (n.constructor.name === "ExpressionNode" && inner?.constructor.name === "Source")
          return ["Source", n.getTokens().map((t) => this.token(t))];
        // Structure and statement inventories share statements. Hash each once,
        // without allocating a hash/memo entry for every expression and token.
        if (n !== node && n.constructor.name === "StatementNode") return ["statement", this.syntax(n)];
        return [n.constructor.name, inner?.constructor.name ?? null,
          n.getChildren().map(project), n.getPragmas?.().map((t) => this.token(t)) ?? null,
          n.getColon?.() ? this.token(n.getColon()) : null];
      };
      return project(node);
    });
  }
  token(t) { return [t.constructor.name, t.getStr(), pos(t.getStart()), pos(t.getEnd())]; }
  type(t) {
    return this.memoized(t, () => {
      const common = [t.constructor.name, canonical(t.getAbstractTypeData())];
      switch (t.constructor.name) {
        case "StructureType": return [...common, t.getComponents().map((c) => [c.name, this.type(c.type), c.asInclude ?? null, c.suffix ?? null])];
        case "TableType": return [...common, this.type(t.getRowType()), canonical(t.getOptions())];
        case "DataReference": return [...common, this.type(t.getType())];
        // Object references are symbolic edges, never recursively expand their definition.
        case "ObjectReferenceType": return [...common, location(t.getIdentifier())];
        default: {
          const fields = Object.keys(t).filter((k) => k !== "data").sort();
          return [...common, fields.map((k) => [k, canonical(t[k])])];
        }
      }
    });
  }
  identifier(id) {
    if (!id) return null;
    return [location(id), this.type(id.getType()), canonical(id.getMeta?.()),
      canonical(id.getValue?.()), id.getVisibility?.() ?? null];
  }
  definition(def) {
    return this.memoized(def, () => [location(def),
      ["isGlobal", "isFinal", "isAbstract", "isForTesting", "isSharedMemory", "getCreateVisibility", "getSuperClass", "getFriends", "getImplementing"]
        .map((k) => [k, canonical(def[k]?.())]),
      def.getAliases().map((a) => [location(a), a.getComponent(), a.getVisibility()]),
      def.getAttributes().getAll().map((a) => this.identifier(a)),
      def.getAttributes().getConstants().map((a) => this.identifier(a)),
      all(def.getTypeDefinitions()).map((t) => [t.visibility, this.identifier(t.type)]),
      all(def.getMethodDefinitions()).map((m) => {
        const p = m.getParameters();
        return [location(m), ["getVisibility", "getClassName", "isRedefinition", "isAbstract", "isStatic", "isEventHandler", "getEventName", "getEventClass", "getRaising", "getExceptions"]
          .map((k) => [k, canonical(m[k]())]),
        ["getImporting", "getExporting", "getChanging"].map((k) => p[k]().map((id) => this.identifier(id))),
        this.identifier(p.getReturning()), p.getOptional(), p.getDefaultImporting(), p.getExceptions(),
        p.getAll().map((id) => [id.getName(), this.syntax(p.getParameterDefault(id.getName()))])];
      }),
      def.getEvents().map((e) => [location(e), e.isStatic(), e.getParameters().map((id) => this.identifier(id))])]);
  }
  scope(s) {
    const id = s.getIdentifier(), d = s.getData();
    return [[id.stype, id.sname, portableFilename(id.filename), pos(id.start), pos(id.end)],
      entries(d.vars, (v) => this.identifier(v)), entries(d.types, (v) => this.identifier(v)),
      entries(d.extraLikeTypes, (v) => this.identifier(v)), entries(d.cdefs, (v) => this.definition(v)),
      entries(d.idefs, (v) => this.definition(v)),
      // References identify their targets without importing foreign definition graphs.
      d.references.map((r) => [r.referenceType, location(r.position), r.resolved ? location(r.resolved) : null, canonical(r.extra)]),
      entries(d.deferred, (v) => [this.token(v.token), v.ooType]),
      d.forms.map((f) => location(f)), canonical(d.sqlConversion),
      s.getChildren().map((c) => this.scope(c))];
  }
  get(key) {
    this.inventory();
    const obj = this.objects.get(key);
    if (!obj) return null;
    if (this.values.has(key) && sameArtifactIdentity(this.identities.get(key), artifactIdentity(obj))) return this.values.get(key);
    const start = performance.now();
    let digest;
    try {
      // Never project a lazy ABAP artifact as source-only. Construction remains
      // recorded, including TYPE-pool syntax and recursive DDIC reads.
      const type = recordedArtifactBuild(() => {
        if (obj instanceof core.ABAPObject && !obj.syntaxResult) new core.SyntaxLogic(this.registry, obj).run();
        return typeof obj.parseType === "function" ? obj.parseType(this.registry) : undefined;
      });
      digest = auditedBookkeeping("resolved-artifact-projection", () => {
        const files = inputSnapshot(this.registry).objects.get(key).sources.map((s) => [portableFilename(s.name), s.artifactHash]);
        const expanded = (obj.getABAPFiles?.() ?? []).map((f) => [portableFilename(f.getFilename()),
          this.syntax(f.getStructure()), f.getStatements().map((s) => this.syntax(s))]);
        const def = obj.def ?? obj.definition;
        const scopes = obj.syntaxResult?.spaghetti?.getTop();
        return hash(["gogen-resolved-artifact-2", key, files, expanded, def ? this.definition(def) : null,
          scopes ? this.scope(scopes) : null, type ? this.type(type) : null]);
      });
    } catch (error) {
      // Unknown shapes are inspectable and cannot yield a semantic fingerprint.
      this.errors.set(key, `${error.name}: ${error.message}`); digest = null;
    }
    this.identities.set(key, artifactIdentity(obj));
    this.values.set(key, digest); this.stats.objects++; this.timings.set(key, performance.now() - start); this.stats.milliseconds += this.timings.get(key);
    return digest;
  }
}

// Reset even for retained registries; a previous compile's memo must never leak.
// The ordinary uncached path only deletes a possible old table: no inventory,
// hashing, syntax or type projection takes place.
export function prepareArtifactDigests(registry, enabled = true) {
  if (!enabled) { tables.delete(registry); return; }
  const table = new Digests(registry);
  tables.set(registry, table);
  return table;
}
const registryOf = (value) => value?.reg ?? value?.registry ?? value;
const tableOf = (registry) => tables.get(registry) ?? prepareArtifactDigests(registry);
// Explicit inspection requests a complete snapshot, outside normal compilation.
export function artifactDigestsOf(value) {
  const table = tableOf(registryOf(value));
  table.inventory();
  for (const key of table.objects.keys()) table.get(key);
  return new Map(table.values);
}
export function artifactDigestOf(value, key) {
  return tableOf(registryOf(value)).get(key);
}
export function artifactDigestStats(value) {
  const table = tables.get(value?.reg ?? value?.registry ?? value);
  return table ? {...table.stats, owners: Object.fromEntries(table.timings), errors: Object.fromEntries(table.errors)} : undefined;
}
export function definitionFingerprint(registry, def) {
  const table = tableOf(registry);
  table.inventory();
  const owner = table.owners.get(def.getFilename());
  const digest = owner && table.get(owner);
  if (!digest) throw new TypeError("definition has no resolved owner digest");
  return {definition: [def.constructor.name, def.getName(), portableFilename(def.getFilename()), def.getStart().getRow(), def.getStart().getCol()], owner, digest};
}
