// SPDX-License-Identifier: MIT
// Folding-only copies of the eight scalar helpers used by frontend-local-constants.
// Keep their behavior aligned with js/abap.mjs via test/gogen-fold-scalars.mjs;
// the emitted runtime stays independent and is copied unchanged.
class AbapError extends Error {
  cls: string;

  constructor(cls: string, op: string) {
    super(`${cls} in ${op}`);
    this.cls = cls;
  }
}

const MAX = 2147483647;
const MIN = -2147483648;
const check = (v: number, op: string): number => {
  if (v > MAX || v < MIN) throw new AbapError("CX_SY_ARITHMETIC_OVERFLOW", op);
  return v;
};

export const NegI = (a: number): number => check(-a, "-");

// character-like values: a c field is stored without its trailing blanks
export function CFit(v: string, n: number): string {
  // Go's Strlen/SubS count UTF-16 units, preserve cut halves; negative n keeps v.
  return (n >= 0 && v.length > n ? v.slice(0, n) : v).replace(/ +$/, "");
}

interface NumberSign {
  neg: boolean;
  body: string;
  ok: boolean;
}

function numSign(t: string): NumberSign {
  let signs = 0;
  let neg = false;
  if (t !== "" && (t[0] === "+" || t[0] === "-")) { signs++; neg = t[0] === "-"; t = t.slice(1); }
  if (t !== "" && t.endsWith("-")) { signs++; neg = true; t = t.slice(0, -1); }
  return {neg, body: t, ok: signs <= 1};
}
const decimalDigits = (t: string): boolean => /^(\d+\.?\d*|\.\d+)$/.test(t);
export function ParseF(v: string): number {
  // Exact, bounded integer text avoids the decimal/exponent grammar below.
  if (/^[+-]?\d{1,15}(?![\s\S])/.test(v)) return Number(v);
  let t = v.replace(/^ +/, "");
  if (t === "") return 0;
  const sp = t.indexOf(" ");
  if (sp >= 0) t = t.slice(0, sp);
  if (t === "nan" || t === "inf" || t === "Infinity") throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->f");
  for (const w of ["nan", "inf", "infinity"]) {
    if (t.toLowerCase().includes(w)) notCompiled(`move to f: a text naming ${w} in a spelling not measured: ${t}`);
  }
  const {neg, body, ok} = numSign(t);
  const m = /^([^Ee]*)(?:[Ee]([+-]?)(\d+))?$/.exec(body);
  if (!ok || m === null || !decimalDigits(m[1])) throw new AbapError("CX_SY_CONVERSION_NO_NUMBER", "c->f");
  const f = Number(body);
  if (!Number.isFinite(f)) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->f");
  return neg ? -f : f;
}
export function ParseI(v: string): number {
  // Common integer text needs neither decimal rounding nor sign/space copies.
  // Ten digits are still exact as a Number; retain the ABAP i range check.
  if (/^[+-]?\d{1,10}(?![\s\S])/.test(v)) {
    const n = Number(v);
    if (n > MAX || n < MIN) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->i");
    return n;
  }
  const t = v.replace(/^ +| +$/g, "");
  if (t === "") return 0;
  const {neg, body: raw, ok} = numSign(t);
  const body = raw.replace(/^ +| +$/g, "");
  if (!ok || !decimalDigits(body)) throw new AbapError("CX_SY_CONVERSION_NO_NUMBER", "c->i");
  const dot = body.indexOf(".");
  const whole = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+/, "");
  const frac = dot < 0 ? "" : body.slice(dot + 1);
  if (whole.length > 10) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->i");
  let n = whole === "" ? 0 : Number(whole);
  if (frac !== "" && frac[0] >= "5") n++;
  if (neg) n = -n;
  if (n > 2147483647 || n < -2147483648) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->i");
  return n;
}

// NUMC moves, as go/abap/conv.go IToN / CToN (A4H, ZCL_GOGEN_T_NUMC): the
// digits right-aligned in k places, zeros in front, the last k kept; an i
// loses its sign, a c its other characters
const nFit = (digits: string, k: number): string => (digits.length > k ? digits.slice(digits.length - k) : "0".repeat(k - digits.length) + digits);
export const IToN = (v: number, k: number): string => nFit(String(Math.abs(v)), k);
export const CToN = (s: string, k: number): string => nFit(String(s).replace(/[^0-9]/g, ""), k);

// String into a date or time, retaining the runtime's different Unicode rules.
export const S2D = (v: string): string => (v === "" ? "00000000" : CFit(v, 8));
export const S2T = (v: string): string => (v === "" ? "000000" : [...v].slice(0, 6).join("").padEnd(6, "0"));

function notCompiled(why: string): never { throw new AbapError("NOT_COMPILED", why); }
