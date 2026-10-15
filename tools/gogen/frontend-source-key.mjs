// Hash the source graph once. Cycles share a component hash; readers include
// their dependencies' hashes. Unrelated additions do not renumber cache keys.
import {createHash} from "node:crypto";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function sourceKeys(objects, byName, version, drop) {
  const edges = new Map([...objects].map(([key, obj]) => [key,
    new Set([...obj.words].flatMap((word) => byName.get(word) ?? []).filter((dep) => !drop?.test(dep)))]));
  const index = new Map(), low = new Map(), stack = [], active = new Set(), component = new Map(), groups = [];
  function visit(key) {
    index.set(key, index.size); low.set(key, index.get(key));
    stack.push(key); active.add(key);
    for (const dep of edges.get(key)) {
      if (!index.has(dep)) { visit(dep); low.set(key, Math.min(low.get(key), low.get(dep))); }
      else if (active.has(dep)) low.set(key, Math.min(low.get(key), index.get(dep)));
    }
    if (low.get(key) === index.get(key)) {
      const members = [];
      let member;
      do { member = stack.pop(); active.delete(member); component.set(member, groups.length); members.push(member); } while (member !== key);
      groups.push(members.sort());
    }
  }
  for (const key of objects.keys()) if (!index.has(key)) visit(key);
  const hashes = new Map();
  function hash(id) {
    if (!hashes.has(id)) {
      const deps = new Set(groups[id].flatMap((key) => [...edges.get(key)].map((dep) => component.get(dep))));
      deps.delete(id);
      hashes.set(id, digest([groups[id].map((key) => [key, objects.get(key).hash]), [...deps].map(hash).sort()]));
    }
    return hashes.get(id);
  }
  for (let id = 0; id < groups.length; id++) hash(id);
  return (owner, reads) => digest([version, [...new Set([owner, ...reads])].sort().map((key) =>
    [key, component.has(key) ? hashes.get(component.get(key)) : null])]);
}
