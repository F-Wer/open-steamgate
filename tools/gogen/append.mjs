// Generated bodies and inventories can exceed V8's call argument limit.
export function append(target, ...arrays) {
  for (const array of arrays) for (const value of array) target.push(value);
}
