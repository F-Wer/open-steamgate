// Every CATCH asks isSubclass of every wanted class (caughtClasses), so the
// superclass chains are walked lazily once per owner -- the program, or while
// a lowering is recorded its tracking proxy: the first walk in each recording
// still makes the reads a transcript and a cache key need, and later walks
// would only repeat them. A chain is extended exactly as far as the loop it
// replaces would have gone, 20 steps at most; step(c) names c's superclass.
const CHAINS = new WeakMap(), CAUGHT = new WeakMap();
const memo = (map, owner) => map.get(owner) ?? map.set(owner, new Map()).get(owner);

export function chainHas(owner, reg, cls, ancestor, step) {
  if (!cls) return false;
  const chains = memo(CHAINS, owner);
  if (!chains.has(cls)) chains.set(cls, {reg, chain: [cls], done: false});
  const entry = chains.get(cls);
  if (entry.reg !== reg) {
    for (let c = cls, guard = 0; c && guard < 20; guard += 1) {
      if (c === ancestor) return true;
      c = step(c);
    }
    return false;
  }
  for (let i = 0; i < 20; i += 1) {
    if (i >= entry.chain.length) return false;
    const c = entry.chain[i];
    if (c === ancestor) return true;
    if (i + 1 === entry.chain.length && !entry.done) {
      const next = step(c);
      if (next) entry.chain.push(next); else entry.done = true;
    }
  }
  return false;
}

// Iterating wanted is a whole-collection read (encoded in full while a
// lowering is recorded), once per CATCH. wanted only ever grows, so its size
// tells whether a previous answer for the same names still holds.
export function caughtOnce(program, names, compute) {
  const known = memo(CAUGHT, program), key = names.join(","), size = program.wanted.size;
  if (known.get(key)?.size !== size) known.set(key, {size, own: compute()});
  return [...known.get(key).own];
}
