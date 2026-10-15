// Generated bodies and inventories can exceed V8's call argument limit.
export function append<T>(target: T[], ...arrays: readonly (readonly T[])[]): void {
  for (const array of arrays) for (const value of array) target.push(value);
}
