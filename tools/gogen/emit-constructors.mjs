import {omittedFactoryCall, Unsupported} from './frontend.mjs';

// Resolve all omitted constructor arguments before emitting declarations:
// DEFAULT may register a structured constant or an anonymous type. A class
// whose DEFAULT is outside the subset keeps the CREATE OBJECT ... TYPE (name)
// refusal at run time instead of failing the whole build.
export function constructorFactories(program) {
  const classes = new Map(program.classes.map((c) => [c.name, c]));
  const result = new Map();
  const saved = program.currentOwner;
  try {
    for (const cls of program.classes) {
      let at = cls;
      while (at && !at.constructor && !at.ctorParams) at = classes.get(at.super);
      const params = at?.constructor?.params ?? at?.ctorParams ?? [];
      const canOmit = params.every((p) => p.optional || p.default !== undefined || p.suppliedOf);
      program.currentOwner = cls.name;
      try {
        const args = canOmit && params.length ? omittedFactoryCall(program, at,
          {name: 'CONSTRUCTOR', params, returning: {type: {k: 'ref', name: cls.name}}}).args : [];
        result.set(cls.name, {canOmit, args});
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        result.set(cls.name, {canOmit: false, args: []});
      }
    }
  } finally { program.currentOwner = saved; }
  return result;
}
