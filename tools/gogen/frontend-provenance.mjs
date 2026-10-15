// Observational tracing facade. Ordinary compilation never loads the recorder.
import {freshRegistry, finishInputs} from "./frontend-inventory.mjs";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
/** @type {typeof import('./frontend-provenance-recorder.mjs') | undefined} */ let recorder;
function loadRecorder() {
  return recorder ??= require("./frontend-provenance-recorder.mjs");
}

/** @template T @param {() => T} run @param {{expose?: boolean}} options @returns {T} */ export function recordProvenance(run, {expose = true} = {}) {
  return loadRecorder().recordProvenance(run, {expose});
}

/** Disk builds record internally; expanded public reporting stays opt-in. */
/** @param {(options: import('./frontend-session-types.ts').CompileOptions) => import('./frontend-session-types.ts').SessionProgram} compile @returns {(options: import('./frontend-session-types.ts').CompileOptions) => import('./frontend-session-types.ts').SessionProgram} */ export function withProvenance(compile) {
  return (options) => {
    const expose = options.provenance ?? (process.env.GOGEN_PROVENANCE === "1");
    const run = () => {
      if (options.registry) options = {...options, registry: freshRegistry(options.registry, options.session)};
      if (options.registry) recorder?.inventoryProvenance(options.registry);
      const program = compile(options);
      finishInputs(program.reg);
      return program;
    };
    const record = expose || (options.cacheDir && options.provenance !== false);
    return record ? recordProvenance(run, {expose}) : run();
  };
}

/** @param {import('./frontend-session-types.ts').Registry} reg @returns {void} */ export function beginProvenanceCompile(reg) {
  recorder?.beginProvenanceCompile(reg);
}

/** @template T @param {import('./frontend-session-types.ts').RegistryContext} ctx @param {import('./frontend-session-types.ts').ArtifactInput} obj @param {() => T} run @param {string} phase @returns {T} */ export function withArtifact(ctx, obj, run, phase = "lowering") {
  return recorder ? recorder.withArtifact(ctx, obj, run, phase) : run();
}

/** @template {import('./frontend-session-types.ts').RegistryContext} C @template {import('./frontend-session-types.ts').ArtifactInput} O @template {unknown[]} A @template T @param {(ctx: C, obj: O, ...args: A) => T} lower @returns {(ctx: C, obj: O, ...args: A) => T} */ export function artifactLowering(lower) {
  return (ctx, obj, ...args) => withArtifact(ctx, obj, () => lower(ctx, obj, ...args));
}

/** @returns {boolean} */ export function recordingProvenance() {
  return recorder?.recordingProvenance() ?? false;
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').ArtifactInput} obj @returns {import('./frontend-session-types.ts').StoredProvenance | undefined} */ export function storedProvenance(reg, obj) {
  return recorder?.storedProvenance(reg, obj);
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').ArtifactInput} obj @param {import('./frontend-session-types.ts').StoredProvenance | undefined} stored @returns {void} */ export function inheritStoredProvenance(reg, obj, stored) {
  recorder?.inheritStoredProvenance(reg, obj, stored);
}

/** @param {import('./frontend-session-types.ts').LoweringContext} ctx @param {string} name @returns {import('./frontend-session-types.ts').FunctionModule | undefined} */ export function resolvedFunctionModule(ctx, name) {
  return recorder ? recorder.resolvedFunctionModule(ctx, name) : ctx.program.functionModules.get(name);
}

// Same selection order and lookup precedence as the frontend. Keep the named
// FM ownership query beside the gogen scan (normal ABAP syntax only checks FM
// ownership in Cloud language mode).
/** @param {import('./frontend-session-types.ts').Registry} reg @param {string[]} wanted @param {import('./frontend-session-types.ts').SelectionCore} abaplint @returns {void} */ export function expandProgramSelection(reg, wanted, abaplint) {
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
        // Expansion tokens have virtual call-site positions. Select from the
        // original definition instead, including macros that are never invoked.
        const statements = file.getStatements().filter((statement) =>
          !statement.getTokens().some((token) => token.getStart() instanceof abaplint.VirtualPosition));
        // Preserve the per-file order: all FM ownership queries precede static
        // attribute lookups, even when those accesses occur earlier in the file.
        for (const statement of statements) {
          const names = [];
          if (statement.get() instanceof abaplint.MacroContent) {
            const tokens = statement.getTokens();
            for (let i = 0; i + 2 < tokens.length; i++) {
              if (upper(tokens[i].getStr()) === "CALL" && upper(tokens[i + 1].getStr()) === "FUNCTION")
                names.push(tokens[i + 2]);
            }
          } else if (statement.get() instanceof abaplint.Statements.CallFunction
              && upper(statement.getTokens()[1]?.getStr()) === "FUNCTION") {
            names.push(statement.findDirectExpression(abaplint.Expressions.FunctionName)?.getFirstToken());
          }
          for (const name of names) {
            if (!(name instanceof abaplint.Tokens.StringToken)) continue;
            const literal = name.getStr();
            if (!literal.startsWith("'") || !literal.endsWith("'") || literal.length <= 2) continue;
            const functionName = upper(literal.slice(1, -1));
            const group = fmGroups.get(functionName);
            semanticQuery(reg, "function-module-owner", [functionName],
              group ? [`FUGR ${upper(group)}`] : [], {policy: "gogen-last-wins"});
            if (group && !wanted.includes(group)) wanted.push(group);
          }
        }
        // A PUBLIC CLASS-DATA read is a dependency too. Only identifier tokens
        // surrounding a static arrow count; comments and literal text do not.
        for (const statement of statements) {
          const tokens = statement.getTokens();
          for (let i = 1; i + 1 < tokens.length; i++) {
            if (tokens[i].getStr() !== "=>"
                || !(tokens[i - 1] instanceof abaplint.Tokens.Identifier)
                || !(tokens[i + 1] instanceof abaplint.Tokens.Identifier)) continue;
            // Keep the existing lookup spelling for namespaced owners: the
            // former identifier match used the final namespace component.
            const owner = tokens[i - 1].getStr().split("/").at(-1).toLowerCase();
            const attr = upper(tokens[i + 1].getStr());
            const def = reg.getObject("CLAS", owner)?.getDefinition();
            if (def?.getAttributes().getStatic().some((a) => upper(a.getName()) === attr && a.getVisibility?.() === abaplint.Visibility.Public)
                && !wanted.includes(owner)) wanted.push(owner);
          }
        }
      }
    };
    if (recorder) recorder.withSelection(reg, obj, run); else run();
  }
}

/** @param {import('./frontend-session-types.ts').ProvenanceInput} value @param {{internal?: boolean}} options @returns {Map<string, import('./frontend-session-types.ts').Manifest>} */ export function provenanceOf(value, {internal = false} = {}) {
  return recorder?.provenanceOf(value, {internal}) ?? new Map();
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').Query['kind']} kind @param {import('./frontend-session-types.ts').QueryScalar[]} args @param {import('./frontend-session-types.ts').Role} role @param {(obj: import('./frontend-session-types.ts').ArtifactObject) => boolean} predicate @returns {import('./frontend-session-types.ts').ArtifactObject[]} */ export function enumerateObjects(reg, kind, args = [], role = "scheduling", predicate = () => true) {
  return recorder ? recorder.enumerateObjects(reg, kind, args, role, predicate) : [...reg.getObjects()].filter(predicate);
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').Query['kind']} kind @param {import('./frontend-session-types.ts').QueryScalar[]} args @param {import('./frontend-session-types.ts').QueryScalar[]} result @param {Partial<import('./frontend-session-types.ts').Query>} details @returns {void} */ export function semanticQuery(reg, kind, args, result, details = {}) {
  recorder?.semanticQuery(reg, kind, args, result, details);
}

/** @template T @param {import('./frontend-session-types.ts').Role} role @param {() => T} run @returns {T} */ export function withRole(role, run) {
  return recorder ? recorder.withRole(role, run) : run();
}

/** @template T @param {string} purpose @param {() => T} run @returns {T} */ export function auditedBookkeeping(purpose, run) {
  return recorder ? recorder.auditedBookkeeping(purpose, run) : run();
}

/** @template T @param {() => T} run @returns {T} */ export function recordedArtifactBuild(run) {
  return recorder ? recorder.recordedArtifactBuild(run) : run();
}

/** @param {import('./frontend-session-types.ts').Registry} reg @returns {boolean} */ export function auditBuiltArtifacts(reg) {
  return recorder?.auditBuiltArtifacts(reg) ?? false;
}

/** @returns {boolean} */ export function provenanceAuditActive() {
  return recorder?.provenanceAuditActive() ?? false;
}

/** @param {import('./frontend-session-types.ts').ProvenanceInput} value @returns {{scheduling: import('./frontend-session-types.ts').QueryRow[], finalOutput: import('./frontend-session-types.ts').QueryRow[]}} */ export function compilationProvenanceOf(value) {
  return recorder?.compilationProvenanceOf(value) ?? {scheduling: [], finalOutput: []};
}

/** @param {import('./frontend-session-types.ts').Registry} reg @returns {import('./frontend-session-types.ts').ProvenanceGraph | undefined} */ export function provenanceGraph(reg) {
  return recorder?.provenanceGraph(reg);
}
