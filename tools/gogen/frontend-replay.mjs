// Record the program inputs a lowering actually reads and its ordered effects.
// Registry/file identity is guarded by the enclosing immutable session.
const context = new Set(["currentClass", "currentOwner", "currentTypes"]);
const ignored = new Set(["reg", "frontendCounts"]);
// An abaplint class or interface definition is parsed from registry sources
// the cache version already covers, so where it was defined names it. Encoding
// its whole graph instead was most of the recording time and of the entries'
// size (a local class definition is read once per method that uses it).
const definitions = new Set(["ClassDefinition", "InterfaceDefinition"]);
const definition = (v) => v && typeof v === "object" && definitions.has(v.constructor?.name)
  && typeof v.getName === "function" && typeof v.getFilename === "function" && typeof v.getStart === "function";
function fingerprint(value) {
  return JSON.stringify(value, (_, v) => v instanceof Map ? {map: [...v]} : v instanceof Set ? {set: [...v]}
    : definition(v) ? {definition: [v.constructor.name, v.getName(), v.getFilename(), v.getStart().getRow(), v.getStart().getCol()]} : v);
}
// The items of a Set, Map (key, value, key, value...) or array when every one
// is a primitive, else null. A toJSON anywhere would make the encoding depend
// on more than the items.
const primitive = (x) => x === null || (typeof x !== "object" && typeof x !== "function" && typeof x !== "bigint");
function primitiveItems(value) {
  if (!(value instanceof Set || value instanceof Map || Array.isArray(value)) || "toJSON" in value) return null;
  const items = [];
  if (value instanceof Map) { for (const [k, v] of value) items.push(k, v); }
  else for (const x of Array.isArray(value) ? Array.from(value) : value) items.push(x);
  return items.every(primitive) ? items : null;
}
const clone = (v) => v instanceof Map ? new Map(v) : v instanceof Set ? new Set(v) : Array.isArray(v) ? [...v] : v;
function copy(program) {
  return Object.fromEntries(Object.entries(program).map(([k, v]) => [k, clone(v)]));
}

export function replayLowering(program, cached) {
  if (!cached) return false;
  const trial = copy(program);
  try {
    for (const op of cached.ops) {
      if (op.kind === "measure") {
        if (trial[op.key]?.[op.method] !== op.value) return false;
      } else if (op.kind === "read") {
        const value = op.method ? trial[op.key]?.[op.method](...op.args) : trial[op.key];
        if (fingerprint(value) !== op.value) return false;
      } else if (op.kind === "assign") trial[op.key] = clone(op.value);
      else trial[op.key][op.method](...op.args);
    }
  } catch { return false; }
  for (const key of cached.written) program[key] = trial[key];
  return true;
}

export function recordLowering(program, lower) {
  const ops = [], written = new Set(), borrowed = new Map();
  let safe = true;
  // Encoding a whole collection on every read was most of the recording cost
  // (a lowering iterates the same large collections again and again). A
  // collection of primitives keeps its last encoding with a copy of its items,
  // and a read compares the items before reusing it: equal primitives encode
  // equally, so every read still records the value as it is at that moment.
  // Anything holding an object is encoded afresh, since a nested change made
  // and undone between two reads must still be seen by the second one.
  const encodings = new WeakMap();
  const encode = (value) => {
    const items = primitiveItems(value);
    const known = items && encodings.get(value);
    if (known && known.items.length === items.length && known.items.every((x, i) => Object.is(x, items[i]))) return known.encoded;
    const encoded = fingerprint(value);
    if (items) encodings.set(value, {items, encoded});
    return encoded;
  };
  const read = (key, method, args, value) => {
    try {
      const encoded = encode(value);
      ops.push({kind: "read", key, method, args, value: encoded});
      if (value && typeof value === "object") {
        if (!borrowed.has(value)) borrowed.set(value, encoded);
        else if (borrowed.get(value) !== encoded) safe = false;
      }
    } catch { safe = false; }
    return value;
  };
  const wrappers = new Map();
  const proxy = new Proxy(program, {
    get(target, key) {
      const value = target[key];
      if (ignored.has(key) || context.has(key)) return value;
      // Event registration examines previously emitted classes. Retry it.
      if (key === "classes") { safe = false; return value; }
      if (value instanceof Map || value instanceof Set || Array.isArray(value)) {
        if (!wrappers.has(value)) wrappers.set(value, new Proxy(value, {
          get(collection, method) {
            if (method === "size" || method === "length") {
              ops.push({kind: "measure", key, method, value: collection[method]});
              return collection[method];
            }
            if (["get", "has"].includes(method)) return (...args) => read(key, method, args, collection[method](...args));
            if (["set", "add", "delete", "clear", "push"].includes(method)) return (...args) => {
              written.add(key); ops.push({kind: "effect", key, method, args});
              const result = collection[method](...args);
              return result === collection ? wrappers.get(collection) : result;
            };
            // Iteration/order is an input too; guard the complete collection.
            read(key, undefined, [], collection);
            const member = collection[method];
            return typeof member === "function" ? member.bind(collection) : member;
          },
        }));
        return wrappers.get(value);
      }
      return read(key, undefined, [], value);
    },
    set(target, key, value) {
      // Assignment expressions return the raw RHS: a following .set/.add
      // would bypass the collection proxy and leave an incomplete transcript.
      // Current-class context is restored separately by compileClass.
      if (!ignored.has(key) && !context.has(key)
          && (value instanceof Map || value instanceof Set || value instanceof WeakMap
            || value instanceof WeakSet || Array.isArray(value))) safe = false;
      target[key] = value;
      if (!ignored.has(key)) { written.add(key); ops.push({kind: "assign", key, value: clone(value)}); }
      return true;
    },
  });
  const ir = lower(proxy);
  // Nested changes cannot be represented by collection effects. Retry those
  // lowerings, rather than replaying an incomplete mutation transcript.
  try { for (const [v, encoded] of borrowed) if (fingerprint(v) !== encoded) { safe = false; break; } }
  catch { safe = false; }
  return {ir, replay: safe ? {ops, written} : undefined};
}
