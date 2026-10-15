import {inputSnapshot} from "./frontend-inventory.mjs";
// The frontend's explicit query contracts. Discovery indexes are compile-local;
// consuming a named answer, including an empty answer, belongs to its reader.
import {enumerateObjects, semanticQuery, withArtifact, withRole, recordingProvenance} from "./frontend-provenance.mjs";
const suppliedIndexes = new WeakMap();
const localAnswers = new WeakMap();
const keyOf = (obj) => `${obj.getType()} ${obj.getName().toUpperCase()}`;

export function suppliedIndex(reg, wanted, core, methodsOf, declaringClass) {
  localAnswers.set(reg, new Map());
  const out = new Map(), providers = new Map(), declarations = new Map(), recording = recordingProvenance();
  for (const obj of enumerateObjects(reg, "supplied-index", [], "scheduling",
    (o) => o instanceof core.Objects.Class && wanted.has(o.getName().toUpperCase()))) {
    withArtifact({reg}, obj, () => {
      const file = obj.getMainABAPFile();
      for (const {name, found} of file ? methodsOf(file) : []) {
        if (!recording && !found.length) continue;
        const key = name.includes("~") ? name.replace("~", "=>")
          : `${declaringClass(reg, obj.getName().toUpperCase(), name, "method") ?? obj.getName().toUpperCase()}=>${name}`;
        if (recording) {
          declarations.set(`${obj.getName().toUpperCase()}=>${name}`, key);
          if (!providers.has(key)) providers.set(key, new Set());
          providers.get(key).add(keyOf(obj));
        }
        if (found.length) out.set(key, new Set([...(out.get(key) ?? []), ...found]));
      }
    }, "supplied-index");
  }
  suppliedIndexes.set(reg, recording ? {reg, providers, declarations} : undefined);
  return out;
}

export function suppliedAnswer(program, key) {
  const set = program.supplied?.get(key), index = suppliedIndexes.get(program.reg);
  if (index) semanticQuery(index.reg, "supplied", key.split("=>"), set?.size ? [...index.providers.get(key) ?? []] : [],
    {parameters: [...set ?? []], providers: [...index.providers.get(key) ?? []], policy: "selected-contributions"});
  return set;
}

export function localDiscovery(reg, obj, includeTests, run) {
  return withArtifact({reg}, obj, () => {
    const value = run();
    if (!localAnswers.has(reg)) localAnswers.set(reg, new Map());
    localAnswers.get(reg).set(JSON.stringify([obj.getName().toUpperCase(), !!includeTests]), value.names);
    semanticQuery(reg, "locals", [obj.getName().toUpperCase(), !!includeTests], value.names,
      {providers: [keyOf(obj)], policy: "ordered-qualified-definitions"});
    return value.value;
  }, "local-definitions");
}

// These indexes were rebuilt from the current parsed registry/selection before
// the class seam. Never answer from a persisted query's former providers.
export function currentQueryAnswer(program, query) {
  if (query.kind === "supplied") {
    const key = query.args.join("=>"), index = suppliedIndexes.get(program.reg);
    if (!index) throw new Error("supplied index unavailable");
    const parameters = [...program.supplied.get(key) ?? []], providers = [...index.providers.get(key) ?? []];
    return {result: parameters.length ? providers : [], parameters, providers};
  }
  if (query.kind === "locals") {
    const result = localAnswers.get(program.reg)?.get(JSON.stringify(query.args));
    if (!result) throw new Error("locals discovery unavailable");
    return {result, providers: [`CLAS ${query.args[0]}`]};
  }
  if (query.kind === "lock") {
    const provider = `ENQU ${query.args[0]}`, descriptor = program.lockObjects.get(query.args[0]);
    return {result: descriptor ? [provider] : [], descriptor: descriptor ?? "MISSING",
      providers: inputSnapshot(program.reg).objects.has(provider) ? [provider] : []};
  }
}

export function lockAnswer(ctx, name) {
  const lock = ctx.program.lockObjects?.get(name);
  const provider = `ENQU ${name}`;
  semanticQuery(ctx.reg, "lock", [name], lock ? [provider] : [],
    {descriptor: lock ?? "MISSING", providers: inputSnapshot(ctx.reg).objects.has(provider) ? [provider] : [], policy: "named-lock"});
  return lock;
}

export const finalOutput = (reg, kind, run) => withRole("final-output", () => {
  const value = run();
  semanticQuery(reg, kind, [], [], {role: "final-output", policy: "rebuilt-every-compile"});
  return value;
});

export function rttiProjection(reg, obj, project) {
  if (!recordingProvenance()) return;
  const [known, structs] = project();
  semanticQuery(reg, "rtti-owner", [obj.getName().toUpperCase()], [keyOf(obj)],
    {role: "final-output", known, structs, policy: "owner-type-projection"});
}


// A signature memo is a program-state value, not another entry's artifact.
// Re-observe the named supplied answer for every consumer of that value.
export function suppliedSignature(ctx, owner, name, signature) {
  if (!recordingProvenance() || !signature?.params) return signature;
  const index = suppliedIndexes.get(ctx.reg);
  if (!index) return signature;
  let key = index.declarations.get(`${owner}=>${name}`);
  if (name.includes("~")) key = name.replace("~", "=>");
  if (!key) {
    let current = owner;
    const objects = inputSnapshot(ctx.reg).objects;
    for (let depth = 0; current && depth < 30; depth++) {
      // Read the indexed artifact directly: provenance hooks retain the owner
      // edge, without introducing another lowering-time getObject/key input.
      const definition = objects.get(`CLAS ${current}`)?.obj.getDefinition();
      const method = definition?.getMethodDefinitions().getByName(name);
      if (method && !method.isRedefinition()) { key = `${current}=>${name}`; break; }
      current = definition?.getSuperClass()?.toUpperCase();
    }
  }
  suppliedAnswer(ctx.program, key ?? `${owner}=>${name}`);
  return signature;
}
