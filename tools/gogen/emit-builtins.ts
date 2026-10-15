import type {Builtin} from './emit-go-types.ts';

const P_FN = new Map<string, string>([
  ['ABS', 'abap.AbsP'], ['SIGN', 'abap.SignP'], ['CEIL', 'abap.CeilP'],
  ['FLOOR', 'abap.FloorP'], ['TRUNC', 'abap.TruncP'], ['FRAC', 'abap.FracP'],
]);

// Numeric and logical built-ins; each backend supplies expression text.
export function emitBuiltinGo(e: Builtin, args: readonly string[], FN_F: ReadonlyMap<string, string>, HELPER_IMPORTS: Set<string>): string {
  if (e.name === "BOOLX") { HELPER_IMPORTS.add("intpower"); return `hIntpower.Boolx(${args.join(", ")})`; }
  if (e.name === "IPOW") {
    HELPER_IMPORTS.add("intpower");
    return e.type.k === "p" ? `hIntpower.Packed(${args.join(", ")}, abap.MulP, abap.FToP)` : e.type.k === "f" ? `hIntpower.Float(${args.join(", ")})` : `hIntpower.Integer(${args.join(", ")})`;
  }
  const fn = FN_F.get(e.name);
  if (fn) return `${fn}(${args[0]})`;
  const k = e.type.k;
  const arg = e.args[0];
  if (arg && "type" in arg && arg.type?.k === "p") {
    const packed = P_FN.get(e.name);
    if (packed) return `${packed}(${args[0]})`;
  }
  switch (e.name) {
    case "NMAX": return k === "i" ? `abap.MaxI(${args.join(", ")})` : `abap.MaxF(${args.join(", ")})`;
    case "NMIN": return k === "i" ? `abap.MinI(${args.join(", ")})` : `abap.MinF(${args.join(", ")})`;
    case "ABS": return k === "i" ? `abap.AbsI(${args[0]})` : `math.Abs(${args[0]})`;
    case "SIGN": return k === "i" ? `abap.SignI(${args[0]})` : `abap.SignF(${args[0]})`;
    case "FLOOR": return k === "i" ? args[0] : `math.Floor(${args[0]})`;
    case "CEIL": return k === "i" ? args[0] : `math.Ceil(${args[0]})`;
    case "TRUNC": return k === "i" ? args[0] : `math.Trunc(${args[0]})`;
    case "FRAC": return k === "i" ? "int32(0)" : `abap.FracF(${args[0]})`;
    default: throw new Error(`no Go for function ${e.name}`);
  }
}

export function emitBuiltinJs(e: Builtin, args: readonly string[], FN: ReadonlyMap<string, string>): string {
  if (e.name === "BOOLX") return `boolx(${args.join(", ")}, abap.AbapError)`;
  if (e.name === "IPOW") return `ipow(${args.join(", ")}, ${JSON.stringify(e.type.k)}, abap.MulP, abap.AbapError, abap.FToP)`;
  const fn = FN.get(e.name);
  if (fn) return `${fn}(${args[0]})`;
  const k = e.type.k;
  const arg = e.args[0];
  if (arg && "type" in arg && arg.type?.k === "p") {
    const packed = P_FN.get(e.name);
    if (packed) return `${packed}(${args[0]})`;
  }
  switch (e.name) {
    case "NMAX": return `Math.max(${args.join(", ")})`;
    case "NMIN": return `Math.min(${args.join(", ")})`;
    case "ABS": return k === "i" ? `abap.AbsI(${args[0]})` : `Math.abs(${args[0]})`;
    case "SIGN": return `abap.SignF(${args[0]})`;
    case "FLOOR": return k === "i" ? args[0] : `Math.floor(${args[0]})`;
    case "CEIL": return k === "i" ? args[0] : `Math.ceil(${args[0]})`;
    case "TRUNC": return k === "i" ? args[0] : `Math.trunc(${args[0]})`;
    case "FRAC": return k === "i" ? "0" : `abap.FracF(${args[0]})`;
    default: throw new Error(`no JS for function ${e.name}`);
  }
}
