import {omittedFactoryCall} from './frontend.mjs';

// Resolve all omitted constructor arguments before emitting declarations:
// DEFAULT may register a structured constant or an anonymous type.
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
      const args = canOmit && params.length ? omittedFactoryCall(program, at,
        {name: 'CONSTRUCTOR', params, returning: {type: {k: 'ref', name: cls.name}}}).args : [];
      result.set(cls.name, {canOmit, args});
    }
  } finally { program.currentOwner = saved; }
  return result;
}
