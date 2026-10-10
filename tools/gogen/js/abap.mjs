// The runtime of JS emitted from the gogen IR (tools/gogen/emit-js.mjs): the
// same semantics as go/abap, line for line, with plain JS values. i and f
// are numbers, c / x / string are strings, a structure is an object and a
// table an array. Nothing here tests a type at run time: the IR decided.

export class AbapError extends Error {
  constructor(cls, op) {
    super(`${cls} in ${op}`);
    this.cls = cls;
  }
}

const MAX = 2147483647;
const MIN = -2147483648;
const check = (v, op) => {
  if (v > MAX || v < MIN) throw new AbapError("CX_SY_ARITHMETIC_OVERFLOW", op);
  return v;
};

export const AddI = (a, b) => check(a + b, "+");
export const SubI = (a, b) => check(a - b, "-");
export const MulI = (a, b) => check(a * b, "*");
export const NegI = (a) => check(-a, "-");

// `/` with calculation type i: the quotient rounded half away from zero,
// and 0 / 0 = 0
export function DivI(a, b) {
  if (b === 0) {
    if (a === 0) return 0;
    throw new AbapError("CX_SY_ZERODIVIDE", "/");
  }
  const r = a % b;
  let q = (a - r) / b;
  if (2 * Math.abs(r) >= Math.abs(b)) q += (a < 0) !== (b < 0) ? -1 : 1;
  return check(q, "/");
}

// DIV and MOD keep the remainder in [0, |b|)
export function DivIntI(a, b) {
  if (b === 0) {
    if (a === 0) return 0;
    throw new AbapError("CX_SY_ZERODIVIDE", "DIV");
  }
  let r = a % b;
  if (r < 0) r += Math.abs(b);
  return check((a - r) / b, "DIV");
}

export function ModI(a, b) {
  if (b === 0) {
    if (a === 0) return 0;
    throw new AbapError("CX_SY_ZERODIVIDE", "MOD");
  }
  let r = a % b;
  if (r < 0) r += Math.abs(b);
  return r;
}

export function DivF(a, b) {
  if (b === 0) {
    if (a === 0) return 0;
    throw new AbapError("CX_SY_ZERODIVIDE", "/");
  }
  return a / b;
}

// for f, the quotient that leaves a - b * q non-negative, and MOD computed
// from it: what A4H does (abaplint/transpiler#1885)
const quotF = (a, b) => (b > 0 ? Math.floor(a / b) : -Math.floor(a / -b));
export function DivIntF(a, b) {
  if (b === 0) {
    if (a === 0) return 0;
    throw new AbapError("CX_SY_ZERODIVIDE", "DIV");
  }
  return quotF(a, b);
}
export function ModF(a, b) {
  if (b === 0) {
    if (a === 0) return 0;
    throw new AbapError("CX_SY_ZERODIVIDE", "MOD");
  }
  const v = a - b * quotF(a, b);
  return v === 0 ? 0 : v;
}

// f -> i: half away from zero, and out of range is an overflow
export function F2I(f) {
  const r = f < 0 ? -Math.round(-f) : Math.round(f);
  if (Number.isNaN(r) || r > MAX || r < MIN) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "f->i");
  return r === 0 ? 0 : r;
}

export const AbsI = (a) => check(Math.abs(a), "abs");
export const SignI = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const SignF = SignI;
export const FracF = (v) => v - Math.trunc(v);
export const MaxI = Math.max;
export const MinI = Math.min;
export const MaxF = Math.max;
export const MinF = Math.min;
export function SqrtF(v) {
  if (v < 0) throw new AbapError("CX_SY_ARG_OUT_OF_DOMAIN", "sqrt");
  return Math.sqrt(v);
}
export function LogF(v) {
  if (v <= 0) throw new AbapError("CX_SY_ARG_OUT_OF_DOMAIN", "log");
  return Math.log(v);
}

// character-like values: a c field is stored without its trailing blanks
export function CFit(v, n) {
  const chars = [...v];
  return (chars.length > n ? chars.slice(0, n).join("") : v).replace(/ +$/, "");
}
export const FmtI = (v) => String(v);
// Integer-width two's complement; fixed x is zero-padded, never sign-extended.
export function IToX(v, n, width = 4) {
  let bytes = BigInt.asUintN(width * 8, BigInt(v)).toString(16).padStart(width * 2, "0").match(/../g).map((b) => String.fromCharCode(parseInt(b, 16))).join("");
  if (n !== undefined) return n <= width ? bytes.slice(width - n) : "\0".repeat(n - width) + bytes;
  return bytes.replace(/^\0+(?=.)/s, ""); // Keep 00 for zero; oracle confirms 5/6-byte int8.
}
export const XToHex = (v) => [...v].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
// text into f and into i, as A4H does (parity-wave2, ZCL_GOGEN_T_C2NUM;
// the rules are written out at go/abap/conv.go ParseF / ParseI)
function numSign(t) {
  let signs = 0;
  let neg = false;
  if (t !== "" && (t[0] === "+" || t[0] === "-")) { signs++; neg = t[0] === "-"; t = t.slice(1); }
  if (t !== "" && t.endsWith("-")) { signs++; neg = true; t = t.slice(0, -1); }
  return {neg, body: t, ok: signs <= 1};
}
const decimalDigits = (t) => /^(\d+\.?\d*|\.\d+)$/.test(t);
export function ParseF(v) {
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
export function ParseI(v) {
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
// ParseI8: ParseI for an int8 target, as go/abap conv.go (a BigInt)
export function ParseI8(v) {
  const t = v.replace(/^ +| +$/g, "");
  if (t === "") return 0n;
  const {neg, body: raw, ok} = numSign(t);
  const body = raw.replace(/^ +| +$/g, "");
  if (!ok || !decimalDigits(body)) throw new AbapError("CX_SY_CONVERSION_NO_NUMBER", "c->int8");
  const dot = body.indexOf(".");
  const whole = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+/, "");
  const frac = dot < 0 ? "" : body.slice(dot + 1);
  if (whole.length > 19) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->int8");
  let n = whole === "" ? 0n : BigInt(whole);
  if (frac !== "" && frac[0] >= "5") n++;
  if (neg) n = -n;
  if (n > 9223372036854775807n || n < -9223372036854775808n) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "c->int8");
  return n;
}
export const ToUpper = (v) => v.toUpperCase();
export const ToLower = (v) => v.toLowerCase();
// A string without surrogates has one UTF-16 unit per character, so its
// offsets are the characters' (go/abap conv.go isASCII/memoOf does the same
// for bytes): the fast path, measured on the editor's tokenizer (80 KB, 7840
// tokens): 117-138 ms a scan with a spread per call, 27-30 ms without
const SURROGATE = /[\uD800-\uDFFF]/;
const flat = (v) => !SURROGATE.test(v);
export const Strlen = (v) => (flat(v) ? v.length : [...v].length);

// f in a string template, as measured on A4H: seventeen significant digits,
// positional, trailing zeros of the fraction dropped
export function FmtF(v) {
  if (v === 0) return "0";
  const neg = v < 0;
  const [mant, exp] = Math.abs(v).toExponential(16).split("e");
  const digits = mant.replace(".", "");
  const point = Number(exp) + 1;
  let intPart;
  let frac;
  if (point <= 0) { intPart = "0"; frac = "0".repeat(-point) + digits; }
  else if (point >= digits.length) { intPart = digits + "0".repeat(point - digits.length); frac = ""; }
  else { intPart = digits.slice(0, point); frac = digits.slice(point); }
  frac = frac.replace(/0+$/, "");
  return (neg ? "-" : "") + intPart + (frac === "" ? "" : `.${frac}`);
}

// value semantics: a structure or table moved out of a place is copied
export function copy(v) {
  if (Array.isArray(v)) return v.map(copy);
  // a structure is a plain object and is copied; an object of a class is a
  // reference and is shared, as ABAP moves a TYPE REF TO
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const k in v) o[k] = copy(v[k]);
    return o;
  }
  return v;
}

export function Idx(n, i) {
  if (i < 1 || i > n) throw new AbapError("CX_SY_ITAB_LINE_NOT_FOUND", "table expression");
  return i - 1;
}

export function PowF(a, b) {
  if (a < 0 && b !== Math.trunc(b)) throw new AbapError("CX_SY_ARG_OUT_OF_DOMAIN", "**");
  if (a === 0 && b < 0) throw new AbapError("CX_SY_ZERODIVIDE", "**");
  return a ** b;
}

// WIDTH / ALIGN / PAD, as measured on A4H: padded, never cut
export function Pad(v, width, align, pad) {
  const n = Strlen(v);
  if (n >= width) return v;
  const fill = width - n;
  if (align === "RIGHT") return pad.repeat(fill) + v;
  if (align === "CENTER") return pad.repeat(fill >> 1) + v + pad.repeat(fill - (fill >> 1));
  return v + pad.repeat(fill);
}

// DECIMALS = n of an f, as measured on A4H (see go/abap FmtFDec)
export function FmtFDec(v, n) {
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);
  let intPart;
  let frac;
  if (a >= 1e21) { intPart = FmtF(a); frac = "0".repeat(100); }
  else { [intPart, frac] = a.toFixed(100).split("."); }
  const digits = intPart.replace(/^0+/, "").length;
  if (digits > 0 && n > 17 - digits) n = Math.max(0, 17 - digits);
  const b = (intPart + frac.slice(0, n)).split("");
  if (frac[n] >= "5") {
    let i = b.length - 1;
    for (; i >= 0; i--) {
      if (b[i] === "9") { b[i] = "0"; continue; }
      b[i] = String(Number(b[i]) + 1);
      break;
    }
    if (i < 0) b.unshift("1");
  }
  const s = b.join("");
  const ip = s.slice(0, s.length - n).replace(/^0+/, "") || "0";
  return (neg ? "-" : "") + ip + (n > 0 ? `.${s.slice(s.length - n)}` : "");
}

// BIT-AND / BIT-OR / BIT-XOR of two x fields of one length
// BitXS: BIT-XOR of two xstrings, the shorter padded with 00 (go/abap conv.go)
export function BitXS(op, a, b) {
  const n = Math.max(a.length, b.length);
  return BitX(op, XFit(a, n), XFit(b, n));
}
export function BitX(op, a, b) {
  let out = "";
  for (let i = 0; i < a.length; i++) {
    const x = a.charCodeAt(i); const y = b.charCodeAt(i);
    out += String.fromCharCode(op === "BIT-AND" ? x & y : op === "BIT-OR" ? x | y : x ^ y);
  }
  return out;
}
// Last 4/8 bytes, zero-extended and then interpreted as a signed integer.
export function XToI8(v, width = 8) {
  const r = [...v.slice(-width)].reduce((bits, b) => (bits << 8n) | BigInt(b.charCodeAt(0)), 0n);
  return BigInt.asIntN(width * 8, r);
}
export const XToI = (v) => Number(XToI8(v, 4));
const rangeError = () => { throw new AbapError("CX_SY_RANGE_OUT_OF_BOUNDS", "offset/length"); };
// FIND p IN [SECTION OFFSET off OF] s IN BYTE MODE: the byte offset of p in
// the xstring s from off on, -1 when it is not there (as abap.FindBytes)
export function FindBytes(s, p, off) {
  if (off < 0 || off > s.length) rangeError();
  return s.indexOf(p, off);
}

// v+off(len) of a string in characters; len -1 is the rest; out of range raises
export function SubS(v, off, len) {
  if (flat(v)) {
    if (off < 0 || off > v.length) rangeError();
    if (len < 0) return v.slice(off);
    if (off + len > v.length) rangeError();
    return v.slice(off, off + len);
  }
  const r = [...v];
  if (off < 0 || off > r.length) rangeError();
  if (len < 0) return r.slice(off).join("");
  if (off + len > r.length) rangeError();
  return r.slice(off, off + len).join("");
}
// v+off(len) of a c field of length n: read padded, stored trimmed
export const SubC = (v, n, off, len) => SubS(v.padEnd(n, " ").slice(0, n), off, len).replace(/ +$/, "");
// bytes of an x or xstring (one char per byte)
export function SubX(v, off, len) {
  if (off < 0 || off > v.length) rangeError();
  if (len < 0) return v.slice(off);
  if (off + len > v.length) rangeError();
  return v.slice(off, off + len);
}
export const XFit = (v, n) => (v.length >= n ? v.slice(0, n) : v + "\u0000".repeat(n - v.length));
// characters moved into x / xstring (go/abap conv.go CToX): the longest
// prefix of upper-case hex digits, an odd count padded with 0, as bytes
export const CToX = (v) => {
  const m = /^[0-9A-F]*/.exec(v)[0];
  const h = m.length % 2 === 1 ? m + "0" : m;
  let out = "";
  for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return out;
};
export const Uccpi = (v) => String.fromCodePoint(v).replace(/ +$/, "");
// find( val sub off ), as measured on A4H: offset or -1, empty sub raises
export function Find(v, sub, off) {
  if (sub === "") throw new AbapError("CX_SY_STRG_PAR_VAL", "find");
  if (flat(v)) {
    if (off < 0 || off > v.length) rangeError();
    return v.indexOf(sub, off);
  }
  const r = [...v];
  if (off < 0 || off > r.length) rangeError();
  const rest = r.slice(off).join("");
  const i = rest.indexOf(sub);
  return i < 0 ? -1 : off + [...rest.slice(0, i)].length;
}
export function FindOcc(v, sub, occ) {
  if (sub === "") return Find(v, sub, 0);
  if (occ === 0) throw new AbapError("NOT_COMPILED", "find( ) OCC = 0 was not measured");
  const positions = [];
  for (let at = 0; at <= v.length;) {
    const i = v.indexOf(sub, at);
    if (i < 0) break;
    positions.push([...v.slice(0, i)].length);
    at = i + sub.length;
  }
  return positions[occ > 0 ? occ - 1 : positions.length + occ] ?? -1;
}
export const Reverse = (v) => [...v].reverse().join("");
export const CO = (a, b) => [...a].every((c) => b.includes(c));
export const CS = (a, b) => b === "" || a.toUpperCase().includes(b.toUpperCase());
export function DateAdd(date, days) {
  if (!/^\d{8}$/.test(date) || date < "15821015" || !Number.isInteger(days)) throw notCompiled("date arithmetic: date or days outside the measured range");
  const y = Number(date.slice(0, 4)), m = Number(date.slice(4, 6)), d = Number(date.slice(6));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw notCompiled("date arithmetic: an invalid date");
  t.setUTCDate(t.getUTCDate() + days);
  const out = `${String(t.getUTCFullYear()).padStart(4, "0")}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
  if (out < "15821015" || out > "99991231") throw notCompiled("date arithmetic: a result outside the measured range");
  return out;
}
export function CSWithPos(s, a, b, fixed = false) {
  if ((a === "" || (fixed && a.replace(/ +$/, "") === "")) && b !== "") {
    s.sy.fdpos = a.length;
    return false;
  }
  const upper = a.toUpperCase();
  const pos = upper.indexOf(b.toUpperCase());
  s.sy.fdpos = pos < 0 ? upper.length : pos;
  return pos >= 0;
}
// i into a string, as A4H moves it: 42 is "42 ", -5 is "5-"
export const IToString = (v) => (v < 0 ? `${-v}-` : `${v} `);
// NUMC moves, as go/abap/conv.go IToN / CToN (A4H, ZCL_GOGEN_T_NUMC): the
// digits right-aligned in k places, zeros in front, the last k kept; an i
// loses its sign, a c its other characters
const nFit = (digits, k) => (digits.length > k ? digits.slice(digits.length - k) : "0".repeat(k - digits.length) + digits);
export const IToN = (v, k) => nFit(String(Math.abs(v)), k);
export const CToN = (s, k) => nFit(String(s).replace(/[^0-9]/g, ""), k);
// code point of a character; the blank c, stored empty, is 32
export const Uccp = (v) => (v.length === 0 ? 32 : v.codePointAt(0));
// SPLIT ... INTO TABLE as A4H does it
export function Split(v, sep) {
  if (v === "") return [];
  // an empty separator does not split (measured: abc is one row)
  if (sep === "") return [v];
  const parts = v.split(sep);
  if (v.endsWith(sep)) parts.pop();
  return parts;
}
// an unseeded cl_abap_random_int: any number in [min, max]
let seeded = false;
let state = 0;
// harnesses only: the same xorshift32 as the Go runtime
export function SeedRandom(seed) { seeded = true; state = seed >>> 0; }
export function RandomInt(min, max) {
  if (!seeded) return min + Math.floor(Math.random() * (max - min + 1));
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return min + (state % (max - min + 1));
}
// FIND [REGEX] p IN s: [found, offset, length, submatches]. A JS RegExp is
// leftmost-first where ABAP's POSIX is leftmost-longest: an alternation whose
// shorter branch matches first (a|ab) differs; the Go runtime is the exact one.
export function FindStmt(s, p, regex, icase, n) {
  const subs = new Array(n).fill("");
  if (!regex) {
    // an empty substring is found at the start (A4H 2026-09-24, ZCL_GOGEN_T_FINDSEC)
    if (p === "") return [true, 0, 0, subs];
    const i = (icase ? s.toUpperCase() : s).indexOf(icase ? p.toUpperCase() : p);
    return i < 0 ? [false, 0, 0, subs] : [true, Strlen(s.slice(0, i)), Strlen(p), subs];
  }
  // non-greedy is invalid on A4H; (?:...) and lookahead are valid there and here
  if (/\*\?|\+\?|\?\?/.test(p)) throw new AbapError("CX_SY_INVALID_REGEX", p);
  const m = abapRegExp(p, s, icase, "", "FIND REGEX").exec(s);
  if (!m) return [false, 0, 0, subs];
  for (let i = 0; i < n; i++) subs[i] = m[i + 1] ?? "";
  return [true, Strlen(s.slice(0, m.index)), Strlen(m[0]), subs];
}

// FIND p IN SECTION [OFFSET off] [LENGTH n] OF s, a substring: go/abap FindSection
export function FindSection(s, p, icase, off, n, nsub) {
  if (flat(s)) {
    if (off < 0 || off > s.length || n < -1) rangeError();
    let end = s.length;
    if (n >= 0) {
      if (off + n > end) rangeError();
      end = off + n;
    }
    const [ok, o, l, subs] = FindStmt(s.slice(off, end), p, false, icase, nsub);
    return ok ? [true, off + o, l, subs] : [false, 0, 0, subs];
  }
  const r = [...s];
  if (off < 0 || off > r.length || n < -1) rangeError();
  let end = r.length;
  if (n >= 0) {
    if (off + n > end) rangeError();
    end = off + n;
  }
  const [ok, o, l, subs] = FindStmt(r.slice(off, end).join(""), p, false, icase, nsub);
  return ok ? [true, off + o, l, subs] : [false, 0, 0, subs];
}

// FIND [REGEX] p IN TABLE itab of strings: go/abap FindTable
export function FindTable(rows, p, regex, icase, nsub) {
  if (!regex && p === "") throw new AbapError("NOT_COMPILED", "FIND IN TABLE: an empty pattern in a table is not measured");
  for (let i = 0; i < rows.length; i++) {
    const [ok, o, l, subs] = FindStmt(rows[i], p, regex, icase, nsub);
    if (ok) return [true, i + 1, o, l, subs];
  }
  return [false, 0, 0, 0, new Array(nsub).fill("")];
}

// An ABAP regex as a JS RegExp, with the lines of the Go runtime: ^ and $
// are the start and end of a line and . is any character (A4H 2026-09-23),
// where lines end at \n only. JS's m flag also ends one at \r, U+2028 and
// U+2029, so the anchors are rewritten rather than flagged; an anchored
// pattern on a text holding one of those is NOT_COMPILED, as in Go
// (checkLines: A4H's own rule there is not Go's and not JS's).
function abapRegExp(p, s, icase, g, where) {
  let out = "", anchored = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") { out += c + (p[i + 1] ?? ""); i++; continue; }
    if (c === "^") { out += "(?:^|(?<=\n))"; anchored = true; continue; }
    if (c === "$") { out += "(?:$|(?=\n))"; anchored = true; continue; }
    if (c !== "[") { out += c; continue; }
    let j = i + 1;
    if (p[j] === "^") j++;
    if (p[j] === "]") j++;
    for (; j < p.length && p[j] !== "]"; j++) {
      if (p[j] === "[" && ":=.".includes(p[j + 1] ?? "x")) {
        const end = p[j + 1];
        for (j += 2; j + 1 < p.length && !(p[j] === end && p[j + 1] === "]"); j++);
        j++;
      }
    }
    out += p.slice(i, j + 1);
    i = j;
  }
  if (anchored && /[\r\u2028\u2029]/.test(s)) throw nc(where, `^ or $ in a text with a line end other than \\n is not measured: ${p}`);
  try { return new RegExp(out, (icase ? "i" : "") + g + "su"); } catch { throw new AbapError("CX_SY_INVALID_REGEX", p); }
}

// CREATE OBJECT ... TYPE (name): every compiled class registers what it is
// (its own name and its interfaces) and a constructor without arguments. The
// fit is checked before the constructor runs, as in the kernel.
const classes = new Map();
export function registerClass(name, is, make) { classes.set(name, {is: new Set(is), make}); }
export function createAs(s, name, target) {
  const c = classes.get(String(name).replace(/ +$/, ""))  // as written: lower case is unknown (A4H);
  if (c === undefined) throw new AbapError("CX_SY_CREATE_OBJECT_ERROR", `CREATE OBJECT TYPE (${name})`);
  if (!c.is.has(target)) throw new AbapError("CX_SY_MOVE_CAST_ERROR", `CREATE OBJECT TYPE (${name})`);
  return c.make(s);
}

// ?= and CAST: an initial reference casts to initial; anything else must be
// the target class or interface (the class's $is), or CX_SY_MOVE_CAST_ERROR
export function cast(x, target) {
  if (x === null || x === undefined) return null;
  if (!x.constructor?.$is?.has(target)) throw new AbapError("CX_SY_MOVE_CAST_ERROR", "?=");
  return x;
}

// RAISE name, taken only by the caller's EXCEPTIONS list (see the Go runtime)
export class ClassicException extends Error {
  constructor(name, method) { super(`RAISE_EXCEPTION ${name} in ${method}`); this.exName = name; this.method = method; }
}
export function classic(s, e, method, map, others) {
  if (e instanceof ClassicException && e.method === method) {
    if (map[e.exName] !== undefined) { s.sy.subrc = map[e.exName]; return; }
    if (others >= 0) { s.sy.subrc = others; return; }
  }
  throw e;
}

// CP and CA: see the Go runtime (conv.go), measured on A4H
export function CP(a, p, cpat, csubject = false) {
  if (cpat && p === "") p = " ";
  const ps = [];
  const pr = [...p];
  for (let i = 0; i < pr.length; i++) {
    if (pr[i] === "#" && i + 1 < pr.length) ps.push({r: pr[++i], k: "e"});
    else if (pr[i] === "*") ps.push({k: "*"});
    else if (pr[i] === "+") ps.push({k: "+"});
    else ps.push({r: pr[i], k: "l"});
  }
  if (cpat) while (ps.length > 1 && ps.at(-1).k === "l" && ps.at(-1).r === " ") ps.pop();
  const ar = [...a];
  const eq = (t, c) => (t.k === "+" ? true : t.k === "e" ? t.r === c : t.r.toUpperCase() === c.toUpperCase());
  let i = 0, j = 0, star = -1, mark = 0;
  while (i < ar.length) {
    if (j === ps.length && csubject && ar.slice(i).every((c) => c === " ")) return true;
    if (j < ps.length && ps[j].k !== "*" && eq(ps[j], ar[i])) { i++; j++; }
    else if (j < ps.length && ps[j].k === "*") { star = j; mark = i; j++; }
    else if (star >= 0) { j = star + 1; mark++; i = mark; }
    else return false;
  }
  while (j < ps.length && ps[j].k === "*") j++;
  return j === ps.length;
}
export function CA(a, b) { return b !== "" && [...a].some((c) => b.includes(c)); }

export function notCompiled(why) { throw new AbapError("NOT_COMPILED", why); }
export function Condense(s, noGaps) { return noGaps ? s.replaceAll(" ", "") : s.split(" ").filter((x) => x !== "").join(" "); }

// ---- strings (measured on A4H 2026-09-23, see go/abap/strings.go) ----
const nc = (where, why) => new AbapError("NOT_COMPILED", `${where}: ${why}`);
// a c value at its full length: SPLIT's separator keeps its trailing blanks
export const PadC = (v, n) => { const c = [...v].length; return c < n ? v + " ".repeat(n - c) : v; };
// SPLIT v AT sep INTO t1 .. tn: the last target takes the rest
export function SplitInto(v, sep, n) {
  const out = new Array(n).fill("");
  if (v === "") return out;
  if (sep === "") { out[0] = v; return out; }
  const parts = v.split(sep);
  for (let i = 0; i < n && i < parts.length; i++) out[i] = i === n - 1 ? parts.slice(i).join(sep) : parts[i];
  return out;
}
export const SplitSubrc = (pieces, lens) => (pieces.some((p, i) => lens[i] >= 0 && [...p].length > lens[i]) ? 4 : 0);
// every match of an ABAP regex, in REPLACE ALL's order (see rxAll in Go).
// A JS RegExp is leftmost-first where ABAP's POSIX is leftmost-longest, as
// in FindStmt: an alternation whose shorter branch matches first differs.
function rxAll(s, p, icase, first) {
  if (/\*\?|\+\?|\?\?/.test(p)) throw new AbapError("CX_SY_INVALID_REGEX", p);
  const re = abapRegExp(p, s, icase, "g", "REPLACE REGEX");
  const out = [];
  let pos = 0;
  while (pos <= s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) break;
    out.push(m);
    if (first) break;
    const end = m.index + m[0].length;
    if (end > m.index) { pos = end; if (pos === s.length) break; continue; }
    if (m.index >= s.length) break;
    pos = m.index + (s.codePointAt(m.index) > 0xffff ? 2 : 1);
  }
  return out;
}
function plainAll(s, sub, icase, first) {
  if (icase) return rxAll(s, sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), true, first);
  const out = [];
  for (let pos = 0; pos <= s.length;) {
    const i = s.indexOf(sub, pos);
    if (i < 0) break;
    const m = [sub]; m.index = i; out.push(m);
    if (first) break;
    pos = i + sub.length;
  }
  return out;
}
function rxWith(wth, m) {
  if (!/[$\\]/.test(wth)) return wth;
  const r = [...wth];
  let b = "";
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "\\" && i + 1 < r.length) { b += r[++i]; continue; }
    if (r[i] === "$" && /[0-9]/.test(r[i + 1] ?? "")) {
      if (/[0-9]/.test(r[i + 2] ?? "")) throw nc("REPLACE REGEX", `a replacement $nn of two digits is not measured: ${wth}`);
      b += m[Number(r[++i])] ?? "";
      continue;
    }
    if (r[i] === "$" && r[i + 1] === "&") { b += m[0]; i++; continue; }
    if (r[i] === "$" || r[i] === "\\") throw nc("REPLACE REGEX", `a replacement ${r.slice(i).join("")} is not measured`);
    b += r[i];
  }
  return b;
}
function splice(s, ms, wth) {
  let b = "", last = 0;
  for (const m of ms) { b += s.slice(last, m.index) + wth(m); last = m.index + m[0].length; }
  return b + s.slice(last);
}
export const NoLength = -2147483648;
// REPLACE ... IN [SECTION ...] v WITH w; [value, sy-subrc]
export function ReplaceStmt(v, p, wth, regex, all, icase, off, ln, cLen) {
  if (cLen >= 0) v = PadC(v, cLen);
  const cs = [...v];
  const n = cs.length;
  if (ln === NoLength) ln = n - off;
  else if (ln < 0) throw nc("REPLACE", "a SECTION of negative LENGTH is not measured");
  if (off < 0 || off > n || off + ln > n) rangeError();
  const head = cs.slice(0, off).join(""), sec = cs.slice(off, off + ln).join(""), tail = cs.slice(off + ln).join("");
  let ms;
  if (regex) ms = rxAll(sec, p, icase, !all);
  else {
    if (p === "" && all) throw new AbapError("CX_SY_REPLACE_INFINITE_LOOP", "REPLACE ALL OCCURRENCES OF ''");
    ms = plainAll(sec, p, icase, !all);
  }
  if (ms.length === 0) return [cLen >= 0 ? v.replace(/ +$/, "") : v, 4];
  const out = head + splice(sec, ms, (m) => (regex ? rxWith(wth, m) : wth)) + tail;
  if (cLen >= 0) {
    const oc = [...out];
    if (oc.length > cLen) {
      return [CFit(out, cLen), oc.slice(cLen).join("").replace(/ +$/, "") === "" ? 0 : 2];
    }
    return [out.replace(/ +$/, ""), 0];
  }
  return [out, 0];
}
// replace( val sub|regex with occ )
export function ReplaceFn(v, p, wth, regex, occ) {
  if (p === "") {
    if (regex) throw nc("replace( )", "an empty regex is not measured");
    throw new AbapError("CX_SY_STRG_PAR_VAL", "replace");
  }
  let ms = regex ? rxAll(v, p, false, occ === 1) : plainAll(v, p, false, occ === 1);
  if (occ > 0) ms = occ <= ms.length ? [ms[occ - 1]] : [];
  else if (occ < 0) ms = -occ <= ms.length ? [ms[ms.length + occ]] : [];
  return splice(v, ms, (m) => (regex ? rxWith(wth, m) : wth));
}
export function Repeat(v, occ) {
  if (occ < 0) throw new AbapError("CX_SY_STRG_PAR_VAL", "repeat");
  return v.repeat(occ);
}
export function CondenseFn(v, del, from, to) {
  let r = [...v];
  while (r.length && del.includes(r[0])) r.shift();
  while (r.length && del.includes(r[r.length - 1])) r.pop();
  if (from === "") return r.join("");
  const rep = to === "" ? "" : [...to][0];
  let b = "", inRun = false;
  for (const c of r) {
    if (from.includes(c)) { if (!inRun) b += rep; inRun = true; continue; }
    inRun = false; b += c;
  }
  return b;
}
export function ShiftFn(v, left, kind, n, sub) {
  const r = [...v];
  const l = r.length;
  if (kind === "") return left ? v.replace(/^ +/, "") : v.replace(/ +$/, "");
  if (kind === "places") {
    if (n < 0 || n > l) rangeError();
    return (left ? r.slice(n) : r.slice(0, l - n)).join("");
  }
  if (kind === "circular") {
    if (n < 0) throw nc("shift( )", "a negative circular is not measured");
    if (n > l) rangeError();
    return left ? r.slice(n).join("") + r.slice(0, n).join("") : r.slice(l - n).join("") + r.slice(0, l - n).join("");
  }
  if (sub === "") throw nc("shift( )", "an empty sub is not measured");
  while (left && v.startsWith(sub)) v = v.slice(sub.length);
  while (!left && v.endsWith(sub)) v = v.slice(0, v.length - sub.length);
  return v;
}
export function ToMixed(v, sep, hasCase, cs, min) {
  if ([...sep].length !== 1) throw nc("to_mixed( )", "a sep that is not one character is not measured");
  if (min < 1) throw nc("to_mixed( )", "a min below 1 is not measured");
  const r = [...v];
  let b = "";
  for (let i = 0; i < r.length; i++) {
    if (i === 0) {
      if (!hasCase) b += r[0];
      else { const c = [...cs][0] ?? ""; b += c !== "" && c === c.toUpperCase() && c !== c.toLowerCase() ? r[0].toUpperCase() : r[0].toLowerCase(); }
    } else if (r[i] === sep && i >= min && i + 1 < r.length) b += r[++i].toUpperCase();
    else b += r[i].toLowerCase();
  }
  return b;
}

// RAISE EXCEPTION: the object and its class travel in a throw, beside the
// runtime's own AbapError (see raise.go)
export class Raised extends Error {
  constructor(obj, cls) { super(`UNCAUGHT_EXCEPTION ${cls}`); this.obj = obj; this.cls = cls; }
}
const supers = new Map();
export function registerSupers(m) { for (const [k, v] of Object.entries(m)) supers.set(k, v); }
export function isA(cls, ancestor) {
  for (let c = cls, n = 0; c && n < 40; c = supers.get(c), n += 1) if (c === ancestor) return true;
  return false;
}
export function RefEq(a, b) {
  const object = (v) => v instanceof Raised ? v.obj : v ?? null;
  return object(a) === object(b);
}
export function raise(obj, cls) {
  // A runtime catch stores the exception wrapper, while a class catch stores
  // its object. Re-raising either retains its original class and identity.
  if (!cls && (obj instanceof Raised || obj instanceof AbapError)) return obj;
  if (obj === null || obj === undefined) throw new AbapError("OBJECTS_OBJREF_NOT_ASSIGNED", "RAISE EXCEPTION of an initial reference");
  const c = cls || obj.constructor?.$abap;
  if (!c) throw new AbapError("NOT_COMPILED", "RAISE EXCEPTION: the class of the object is not registered");
  return new Raised(obj, c);
}
// the CATCH clauses of the active TRYs of a session and Handled( ): see
// raise.go; a CLEANUP runs only when a TRY further out takes the exception
export function pushHandler(s, f) { const h = (s.handlers ??= []); const n = h.length; h.push(f); return n; }
export function popHandler(s, n) { if (s.handlers) s.handlers.length = n; }
export function handled(s, e) {
  const h = s.handlers ?? [];
  for (let i = h.length - 1; i >= 0; i--) if (h[i](e)) return true;
  return false;
}
export function classBased(e) {
  return e instanceof Raised || (e instanceof AbapError && e.cls.startsWith("CX_"));
}
export function catchable(e) { return classBased(e); }
// get_text( ) of a value a CATCH INTO received that also takes runtime
// exceptions: a raised object's own get_text, else the class and the operation
export function excText(s, x) {
  if (x instanceof Raised) {
    if (typeof x.obj.IF_MESSAGE__GET_TEXT !== "function") throw new AbapError("NOT_COMPILED", `${x.cls}=>GET_TEXT: get_text( ) of the class is not compiled`);
    return x.obj.IF_MESSAGE__GET_TEXT(s);
  }
  return x.message;
}
// Generic data: TYPE any, TYPE data, ANY TABLE and REF TO data, as in
// go/abap/data.go. A generic value is a binding to the slot it stands for,
// {get, set, t}: get reads the slot, set writes it, t is the descriptor of
// the slot's ABAP type. Never a copy, so a write through a field symbol or a
// data reference reaches the original. An unassigned field symbol and an
// initial reference are null. Descriptors of structures and tables are
// generated with the program ({kind, comps: [{name, key, t}], row, zero});
// elementary ones are here.
const sizedTypes = new Map();
const sizedType = (kind, len, dec = 0) => {
  const key = `${kind}:${len}:${dec}`;
  if (!sizedTypes.has(key)) sizedTypes.set(key, {kind, len, dec});
  return sizedTypes.get(key);
};
export const TI = {kind: "I", len: 4};
export const TInt8 = {kind: "8", len: 8};
export const TF = {kind: "F", len: 8};
export const TString = {kind: "g"};
export const TXString = {kind: "y"};
export const TD = {kind: "D", len: 8};
export const TT = {kind: "T", len: 6};
export const TRef = {kind: "l"};
export const TObj = {kind: "r"};
export const TC = (n) => sizedType("C", n);
export const TX = (n) => sizedType("X", n);
export const TP = (n, dec) => sizedType("P", n, dec);
export const TN = (n) => sizedType("N", n);

// a value that is no place of its own, seen as generic data: a slot of its own
export function cell(v, t, table) {
  const c = {v};
  const check = () => { if (table && !table.includes(v)) throw new AbapError("GETWA_NOT_ASSIGNED", "reference to a deleted table row"); };
  return {get: () => { check(); return c.v; }, set: (x) => { check(); c.v = x; }, t};
}

const notAssigned = (op) => new AbapError("GETWA_NOT_ASSIGNED", op);

// ASSIGN COMPONENT name or 1-based position: null (sy-subrc 4) for a
// non-structure or missing component; names are case-insensitive (A4H).
// The component is reached through d each time, so it stays the field of
// whatever structure d's slot holds.
export function Component(d, name) {
  if (d === null || (d.t.kind !== "u" && d.t.kind !== "v")) return null;
  const n = String(name).replace(/ +$/, "").toUpperCase();
  const c = typeof name === "number" ? (name > 0 ? d.t.comps[name - 1] : undefined) : d.t.comps.find((x) => x.name === n);
  if (c === undefined) return null;
  return {get: () => d.get()[c.key], set: (v) => { d.get()[c.key] = v; }, t: c.t};
}

// lines( ) of a generic table
export function Lines(d) {
  if (d === null || d.t.kind !== "h") throw new AbapError("NOT_COMPILED", "lines( ): of a generic value that is not a table");
  return d.get().length;
}

// DELETE <generic table> INDEX i: false (sy-subrc 4) without a row i
export function DeleteIndex(d, i) {
  const n = Lines(d);
  if (i < 1 || i > n) return false;
  d.get().splice(i - 1, 1);
  bumpTable(d.get());
  return true;
}

// APPEND v TO a generic standard table: a new initial row, v moved into it;
// the new row's index (sy-tabix), as go/abap AppendData
export function AppendData(t, v) {
  if (t.t.noAppend) throw new AbapError("NOT_COMPILED", "APPEND: to a generic table that is not a standard table");
  const n = Lines(t);
  const rt = t.t.row;
  const zero = rt.zero ? rt.zero() : ({I: 0, F: 0, 8: 0n, D: "00000000", T: "000000", P: FmtP("", rt.dec ?? 0), X: "\u0000".repeat(rt.len ?? 0), N: "0".repeat(rt.len ?? 0)})[rt.kind] ?? "";
  t.get().push(zero);
  bumpTable(t.get());
  MoveData(Row(t, n), v);
  return n + 1;
}

// INSERT v INTO TABLE <generic table> and CREATE DATA LIKE LINE OF one
// (ultra/json), as go/abap/data.go: a standard table appends; the JS
// descriptors carry no table kind, so a table whose descriptor says hashed is refused
export function InsertData(t, v) {
  if (t === null) throw notAssigned("INSERT INTO TABLE");
  if (t.t.kind !== "h") notCompiled("INSERT INTO TABLE: a generic value that is not a table");
  if (t.t.hashed) notCompiled("INSERT INTO TABLE: a generic table that is not a standard table");
  AppendData(t, v);
}

export function NewLine(t) {
  if (t === null) throw notAssigned("CREATE DATA LIKE LINE OF");
  if (t.t.kind !== "h") notCompiled("CREATE DATA LIKE LINE OF: a generic value that is not a table");
  const rt = t.t.row;
  const zero = rt.zero ? rt.zero() : ({I: 0, F: 0, 8: 0n, D: "00000000", T: "000000", P: FmtP("", rt.dec ?? 0), X: "\u0000".repeat(rt.len ?? 0), N: "0".repeat(rt.len ?? 0)})[rt.kind] ?? "";
  return cell(zero, rt);
}

// row i (from 0) of a generic table, bound to the row itself
export function Row(d, i) {
  const a = d.get();
  const version = tableVersion(a);
  const value = a[i];
  const check = () => {
    if (d.get() !== a || tableVersion(a) !== version || i >= a.length || (value !== null && typeof value === "object" && a[i] !== value))
      throw new AbapError("GETWA_NOT_ASSIGNED", "table row binding after structural mutation");
  };
  return {get: () => { check(); return a[i]; }, set: (v) => { check(); a[i] = v; }, t: d.t.row};
}

const tableVersions = new WeakMap();
const tableVersion = (table) => tableVersions.get(table) ?? 0;
export function bumpTable(table) { tableVersions.set(table, tableVersion(table) + 1); }
export function bindRow(current, index) {
  const table = current();
  const version = tableVersion(table);
  return {get: () => {
    if (current() !== table || tableVersion(table) !== version || index >= table.length)
      throw new AbapError("GETWA_NOT_ASSIGNED", "table row binding after structural mutation");
    return table[index];
  }, set: (v) => {
    if (current() !== table || tableVersion(table) !== version || index >= table.length)
      throw new AbapError("GETWA_NOT_ASSIGNED", "table row binding after structural mutation");
    table[index] = v;
  }};
}

// An elementary REFERENCE INTO uses the same row slot and validity as
// ASSIGNING. A plain cell would only change its private copy of the value.
export function rowCell(current, index, t) {
  return {...bindRow(current, index), t};
}

// a generic elementary value moved into a string
export function DataString(d) {
  if (d === null) throw notAssigned("move");
  switch (d.t.kind) {
    case "g": case "C": case "D": case "T": case "N": return d.get();
    case "X": case "y": return XToHex(d.get()); case "I": return IToString(d.get());
    case "P": return PToString(d.get(), d.t.dec);
    default: throw new AbapError("NOT_COMPILED", `move: a generic value of type kind ${d.t.kind} into a string`);
  }
}

// go/abap DataChars: a generic operand compared with a character operand
export function DataChars(d) {
  if (d === null) throw notAssigned("comparison");
  if (d.t.kind === "g" || d.t.kind === "C") return d.get();
  throw new AbapError("NOT_COMPILED", `comparison: a generic value of type kind ${d.t.kind} with a character operand`);
}

// go/abap S2D / S2T: a string into a d or a t
export const S2D = (v) => (v === "" ? "00000000" : CFit(v, 8));
export const S2T = (v) => (v === "" ? "000000" : [...v].slice(0, 6).join("").padEnd(6, "0"));

// a generic value moved into an i
export function DataI(d) {
  if (d === null) throw notAssigned("move");
  if (d.t.kind === "I") return d.get();
  throw new AbapError("NOT_COMPILED", `move: a generic value of type kind ${d.t.kind} into an i`);
}

// a generic value in a string template
export function FmtData(d) {
  if (d === null) throw notAssigned("string template");
  switch (d.t.kind) {
    case "I": return FmtI(d.get());
    case "8": return String(d.get());
    case "F": return FmtF(d.get());
    case "g": case "C": case "D": case "T": case "N": return d.get();
    case "X": case "y": return XToHex(d.get());
    case "P": return FmtP(d.get(), d.t.dec);
    default: throw new AbapError("NOT_COMPILED", `string template: a generic value of type kind ${d.t.kind}`);
  }
}

// IS INITIAL of a generic value
export function IsInitialData(d) {
  if (d === null) return true;
  const v = d.get();
  switch (d.t.kind) {
    case "I": case "F": return v === 0;
    case "8": return v === 0n;
    case "g": case "y": case "C": return v === "";
    case "D": return v === "" || v === "00000000";
    case "T": return v === "" || v === "000000";
    case "N": return /^0*$/.test(v);
    case "X": return /^\u0000*$/.test(v);
    case "P": return v.replaceAll(".", "").replace(/^[0-]+/, "") === "";
    case "h": return v.length === 0;
    case "u": case "v": return d.t.comps.every((c) => IsInitialData({get: () => v[c.key], t: c.t}));
    case "l": case "r": return v === null;
    default: throw new AbapError("NOT_COMPILED", `IS INITIAL: a generic value of type kind ${d.t.kind}`);
  }
}

export function DataBound(d) {
  if (d === null) return false;
  if (d.t.kind === "l" || d.t.kind === "r") return d.get() != null;
  throw new AbapError("NOT_COMPILED", `IS BOUND: a generic value of type kind ${d.t.kind}`);
}

// A structure or table written through generic data is written in place, as
// Go writes through the pointer: the object in the slot stays the same
// object, so a typed field symbol holding it (LOOP ASSIGNING, READ TABLE
// ASSIGNING) and a binding that fixed it (the row, the object of a
// reference, a typed field symbol) still see it afterwards. A nested
// structure or table is written in place too. src is a fresh value.
export function Overwrite(t, dst, src) {
  if (t.kind === "h") {
    dst.length = 0;
    for (const r of src) dst.push(r);
    return;
  }
  for (const c of t.comps) {
    const k = c.t.kind;
    if ((k === "u" || k === "v" || k === "h") && dst[c.key] !== null && typeof dst[c.key] === "object") Overwrite(c.t, dst[c.key], src[c.key]);
    else dst[c.key] = src[c.key];
  }
}

// dst = src for a generic dst: converted to the type of the slot dst is bound
// to and written there, never rebound. The pairs of go/abap MoveData; any
// other dumps NOT_COMPILED rather than guess.
export function MoveData(dst, src) {
  if (dst === null) throw notAssigned("move into a field symbol");
  if (src === null) throw notAssigned("move from a field symbol");
  const dk = dst.t.kind;
  const sk = src.t.kind;
  const v = src.get();
  // packed numbers either way (go/abap MoveData)
  if (dk === "P" && sk !== "u" && sk !== "v" && sk !== "h") return dst.set(PFit(DataP(src), dst.t.len, dst.t.dec, false));
  if (sk === "P") {
    if (dk === "I") return dst.set(PToI(v, false));
    if (dk === "8") return dst.set(PToI8(v, false));
    if (dk === "F") return dst.set(PToF(v));
    if (dk === "g") return dst.set(PToString(v, src.t.dec));
    if (dk === "C") return dst.set(PToC(v, src.t.dec, dst.t.len));
    if (dk === "N") return dst.set(PToN(v, dst.t.len));
  }
  switch (dk) {
    case "u": case "v": case "h":
      if (dst.t === src.t) {
        if (dk === "h") bumpTable(dst.get());
        return Overwrite(dst.t, dst.get(), copy(v));
      }
      break;
    case "I":
      if (sk === "I") return dst.set(v);
      if (sk === "F") return dst.set(F2I(v));
      if (sk === "C" || sk === "g") return dst.set(ParseI(v));
      break;
    case "F":
      if (sk === "I" || sk === "F") return dst.set(v);
      if (sk === "C" || sk === "g") return dst.set(ParseF(v));
      break;
    case "8":
      if (sk === "8") return dst.set(v);
      break;
    case "g":
      if (sk === "g" || sk === "C") return dst.set(v);
      if (sk === "I") return dst.set(IToString(v));
      break;
    case "C":
      if (sk === "g" || sk === "C") return dst.set(CFit(v, dst.t.len));
      break;
    case "X":
      if (sk === "X") return dst.set(XFit(v, dst.t.len));
      break;
    case "N": {
      // digits that fit, zero-padded (go/abap MoveData)
      if (sk === "g" || sk === "C" || (sk === "N" && src.t.len <= dst.t.len)) {
        const x = sk === "C" ? v.replace(/ +$/, "") : v;
        if (/^[0-9]+$/.test(x) && x.length <= dst.t.len) return dst.set(x.padStart(dst.t.len, "0"));
      }
      break;
    }
    case "D": case "T":
      // go/abap MoveData: a string by S2D / S2T, a c cut to the length
      if (sk === dk) return dst.set(v);
      if (sk === "g") return dst.set(dk === "D" ? S2D(v) : S2T(v));
      if (sk === "C") return dst.set(CFit(v, dk === "D" ? 8 : 6));
      break;
    case "y":
      if (sk === dk) return dst.set(v);
      break;
    case "l":
      if (sk === "l") return dst.set(v);
      break;
    default: break;
  }
  throw new AbapError("NOT_COMPILED", `move: a value of type kind ${sk} into generic data of type kind ${dk}`);
}

// CLEAR of a generic value: the slot it is bound to becomes initial
export function ClearData(d) {
  if (d === null) throw notAssigned("CLEAR of a field symbol");
  switch (d.t.kind) {
    case "I": case "F": return d.set(0);
    case "8": return d.set(0n);
    case "g": case "y": case "C": return d.set("");
    case "D": return d.set("00000000");
    case "T": return d.set("000000");
    case "P": return d.set(FmtP("", d.t.dec));
    case "X": return d.set("\u0000".repeat(d.t.len));
    case "l": return d.set(null);
    case "u": case "v": case "h": {
      if (d.t.kind === "h") bumpTable(d.get());
      return Overwrite(d.t, d.get(), d.t.zero());
    }
    default: throw new AbapError("NOT_COMPILED", `CLEAR: generic data of type kind ${d.t.kind}`);
  }
}

// CALL METHOD (class)=>m, as go/abap CallStatic: the classes the program
// compiled, the ones the registry has (a class that exists but was not
// compiled dumps instead of reading as unknown), and an adapter per static
// method a dynamic call names, reading its arguments out of generic data.
const compiledClasses = new Set();
const registryClasses = new Set();
const statics = new Map();
export function knownClasses(compiled, known) {
  for (const c of compiled) compiledClasses.add(c);
  for (const c of known) registryClasses.add(c);
}
export function registerStatic(name, params, call) { statics.set(name, {params: new Set(params), call}); }
export function CallStatic(s, cls, method, args) {
  const c = String(cls).replace(/ +$/, "");
  if (!compiledClasses.has(c)) {
    if (registryClasses.has(c)) throw new AbapError("NOT_COMPILED", `CALL METHOD (${c})=>${method}: the class exists but is not compiled in this program`);
    throw new AbapError("CX_SY_DYN_CALL_ILLEGAL_CLASS", `CALL METHOD (${c})=>${method}`);
  }
  const e = statics.get(`${c}=>${method}`);
  if (e === undefined) throw new AbapError("CX_SY_DYN_CALL_ILLEGAL_METHOD", `CALL METHOD (${c})=>${method}`);
  for (const n of Object.keys(args)) if (!e.params.has(n)) throw new AbapError("CX_SY_DYN_CALL_PARAM_NOT_FOUND", `${c}=>${method} ${n}`);
  e.call(s, args);
}
export function paramMissing(op) { throw new AbapError("CX_SY_DYN_CALL_PARAM_MISSING", op); }
// t -> i: mirror go/abap/datesplit.go, including invalid digit/length moves.
export function TToI(v) {
  if (!/^\d{6}$/.test(v)) return 0;
  return Number(v.slice(0, 2)) * 3600 + Number(v.slice(2, 4)) * 60 + Number(v.slice(4, 6));
}

// d -> i, measured on A4H (go/abap/datesplit.go DToI says how)
export function DToI(v) {
  if (!/^\d{8}$/.test(v)) return 0;
  const y = Number(v.slice(0, 4)), m = Number(v.slice(4, 6)), d = Number(v.slice(6, 8));
  if (y < 1 || m < 1 || m > 12 || d < 1) return 0;
  const key = y * 10000 + m * 100 + d;
  const julian = key < 15821015;
  if (key > 15821004 && julian) throw new AbapError("NOT_COMPILED", "d -> i: a date of the ten days skipped in October 1582 is not measured");
  let leap = y % 4 === 0;
  if (!julian) leap = leap && (y % 100 !== 0 || y % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > days[m]) return 0;
  const a = Math.trunc((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  let jdn = d + Math.trunc((153 * mm + 2) / 5) + 365 * yy + Math.trunc(yy / 4);
  jdn += julian ? -32083 : -Math.trunc(yy / 100) + Math.trunc(yy / 400) - 32045;
  return jdn - 1721424;
}
// SPLIT ... INTO n fields (go/abap/datesplit.go SplitN)
export function SplitN(v, sep, n) {
  if (sep === "") throw new AbapError("NOT_COMPILED", "SPLIT: at an empty separator is not measured");
  const out = new Array(n).fill("");
  const parts = v.split(sep);
  for (let i = 0; i < n && i < parts.length; i += 1) out[i] = i === n - 1 ? parts.slice(i).join(sep) : parts[i];
  return out;
}
export function SplitFit(s, piece, n) {
  if ([...piece.replace(/ +$/, "")].length > n) s.sy.subrc = 4;
  return CFit(piece, n);
}

// IS INITIAL of a d, t or n value: "" (never set) or its typed zero
export const InitialCh = (v, z) => v === "" || v === z;
// IS INITIAL of a structure or table: compared with its initial value
// component by component, a table by its lines
export function IsInitialDeep(v, z) {
  if (Array.isArray(z)) return v.length === 0;
  if (z !== null && typeof z === "object") return Object.keys(z).every((k) => IsInitialDeep(v[k], z[k]));
  if (typeof z === "string") return v === z || v === "";
  return v === z;
}

// SHIFT s RIGHT DELETING TRAILING mask on a string (see go/abap/shift.go)
export function ShiftRightTrailing(s, mask) {
  if ([...mask].length !== 1) throw new AbapError("NOT_COMPILED", "SHIFT RIGHT DELETING TRAILING: a mask of other than one character");
  const r = [...s];
  let n = r.length;
  while (n > 0 && mask.includes(r[n - 1])) n -= 1;
  return " ".repeat(r.length - n) + r.slice(0, n).join("");
}

// SHIFT s LEFT DELETING LEADING mask on a string or a c (see go/abap/shift.go)
export function ShiftLeftLeading(s, mask) {
  const r = [...s];
  let i = 0;
  while (i < r.length && mask.includes(r[i])) i += 1;
  return r.slice(i).join("");
}

// sy-mandt: the transpiler runtime's logon client (see go/abap/select.go, ANORMALIES)
export const Mandt = "123";

// MOVE-CORRESPONDING over generic data (see go/abap/movecorr.go)
export function MoveCorrespondingData(dst, src) {
  if (dst === null) throw notAssigned("MOVE-CORRESPONDING into a field symbol");
  if (src === null) throw notAssigned("MOVE-CORRESPONDING from a field symbol");
  const isStruct = (t) => t && (t.kind === "u" || t.kind === "v");
  if (!isStruct(dst.t) || !isStruct(src.t)) throw new AbapError("NOT_COMPILED", "MOVE-CORRESPONDING: generic data that is not a structure");
  const deep = (t) => ["u", "v", "h"].includes(t.kind);
  for (const dc of dst.t.comps) {
    const sc = src.t.comps.find((x) => x.name === dc.name);
    if (!sc) continue;
    if (deep(dc.t) || deep(sc.t)) throw new AbapError("NOT_COMPILED", `MOVE-CORRESPONDING: a deep component ${dc.name}`);
    MoveData(Component(dst, dc.name), Component(src, sc.name));
  }
}

// packed numbers, line for line go/abap/packed.go (the rules and their A4H
// evidence are written there): a p value is its decimal text, a field's
// with exactly its decimals, an intermediate result exact
const pParse = (a) => {
  a = String(a ?? "");
  if (a === "") return {v: 0n, s: 0};
  const neg = a[0] === "-";
  if (neg) a = a.slice(1);
  const [ip, fp = ""] = a.split(".");
  if (!/^\d*$/.test(ip + fp) || ip + fp === "") throw new AbapError("NOT_COMPILED", `packed number: the value ${JSON.stringify(a)} is not a packed number`);
  const v = BigInt(ip + fp);
  return {v: neg ? -v : v, s: fp.length};
};
const pow10 = (n) => 10n ** BigInt(n);
const babs = (v) => (v < 0n ? -v : v);
const roundDiv = (n, m) => {
  let q = n / m;
  const r = n % m;
  if (babs(r) * 2n >= m) q += n < 0n ? -1n : 1n;
  return q;
};
const pScale = (d, dec) => {
  if (d.s === dec) return d;
  if (d.s < dec) return {v: d.v * pow10(dec - d.s), s: dec};
  return {v: roundDiv(d.v, pow10(d.s - dec)), s: dec};
};
const pText = (d) => {
  if (d.s <= 0) return (d.v * pow10(-d.s)).toString();
  let t = babs(d.v).toString();
  if (t.length <= d.s) t = "0".repeat(d.s - t.length + 1) + t;
  const ip = t.slice(0, t.length - d.s);
  const fp = t.slice(t.length - d.s).replace(/0+$/, "");
  let out = fp === "" ? ip : `${ip}.${fp}`;
  if (d.v < 0n && out !== "0") out = `-${out}`;
  return out;
};
const pFixed = (d, dec) => {
  d = pScale(d, dec);
  let t = babs(d.v).toString();
  if (dec > 0) {
    if (t.length <= dec) t = "0".repeat(dec - t.length + 1) + t;
    t = `${t.slice(0, t.length - dec)}.${t.slice(t.length - dec)}`;
  }
  return d.v < 0n ? `-${t}` : t;
};
const intDigits = (d) => {
  let ip = babs(d.v);
  if (d.s > 0) ip /= pow10(d.s);
  else if (d.s < 0) ip *= pow10(-d.s);
  return ip === 0n ? 0 : ip.toString().length;
};
const pCalc = (d, op) => {
  if (intDigits(d) > 63) throw new AbapError("CX_SY_ARITHMETIC_OVERFLOW", op);
  return pText(d);
};
const pAlign = (a, b) => (a.s < b.s ? [pScale(a, b.s), b] : b.s < a.s ? [a, pScale(b, a.s)] : [a, b]);
export const AddP = (a, b) => { const [x, y] = pAlign(pParse(a), pParse(b)); return pCalc({v: x.v + y.v, s: x.s}, "+"); };
export const SubP = (a, b) => { const [x, y] = pAlign(pParse(a), pParse(b)); return pCalc({v: x.v - y.v, s: x.s}, "-"); };
export const MulP = (a, b) => { const x = pParse(a); const y = pParse(b); return pCalc({v: x.v * y.v, s: x.s + y.s}, "*"); };
export const NegP = (a) => { const x = pParse(a); return pText({v: -x.v, s: x.s}); };
export function DivP(a, b) {
  const x = pParse(a);
  const y = pParse(b);
  if (y.v === 0n) {
    if (x.v === 0n) return "0";
    throw new AbapError("CX_SY_ZERODIVIDE", "/");
  }
  if (x.v === 0n) return "0";
  let n = x.v * pow10(y.s);
  let m = y.v * pow10(x.s);
  if (m < 0n) { n = -n; m = -m; }
  const an = babs(n);
  let e = an.toString().length - m.toString().length;
  const [lhs, rhs] = e >= 0 ? [an, m * pow10(e)] : [an * pow10(-e), m];
  if (lhs < rhs) e -= 1;
  const scale = 30 - e;
  const q = scale >= 0 ? roundDiv(n * pow10(scale), m) : roundDiv(n, m * pow10(-scale));
  return pCalc({v: q, s: scale}, "/");
}
const pDivMod = (a, b, op) => {
  const [x, y] = pAlign(pParse(a), pParse(b));
  if (y.v === 0n) {
    if (x.v === 0n) return [{v: 0n, s: 0}, {v: 0n, s: 0}];
    throw new AbapError("CX_SY_ZERODIVIDE", op);
  }
  const ay = babs(y.v);
  let r = x.v % ay;
  if (r < 0n) r += ay;
  return [{v: (x.v - r) / y.v, s: 0}, {v: r, s: x.s}];
};
export const DivIntP = (a, b) => pCalc(pDivMod(a, b, "DIV")[0], "DIV");
export const ModP = (a, b) => pCalc(pDivMod(a, b, "MOD")[1], "MOD");
// CmpP compares two packed values: -1, 0 or 1
export const CmpP = (a, b) => { const [x, y] = pAlign(pParse(a), pParse(b)); return x.v < y.v ? -1 : x.v > y.v ? 1 : 0; };
// TYPE numeric parameters retain their caller's type. Packed and integer
// values compare exactly; floating point follows ABAP's floating comparison.
export function CmpNumericData(a, b) {
  const ka = a.t.kind, kb = b.t.kind;
  const av = a.get(), bv = b.get();
  if (ka === "F" || kb === "F") {
    const x = ka === "P" ? Number(av) : av;
    const y = kb === "P" ? Number(bv) : bv;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return CmpP(av, bv);
}
export const IToP = (i) => String(i);
export function PFit(a, n, dec, arith) {
  const d = pScale(pParse(a), dec);
  if (intDigits(d) > 2 * n - 1 - dec) throw new AbapError(arith ? "CX_SY_ARITHMETIC_OVERFLOW" : "CX_SY_CONVERSION_OVERFLOW", arith ? "=" : "p");
  return pFixed(d, dec);
}
export function CToP(v) {
  let t = String(v).replace(/^ +| +$/g, "");
  if (t === "") return "0";
  let neg = false;
  if (t.endsWith("-")) { neg = true; t = t.slice(0, -1).replace(/ +$/, ""); } else if (t.startsWith("-")) { neg = true; t = t.slice(1).replace(/^ +/, ""); } else if (t.startsWith("+")) t = t.slice(1).replace(/^ +/, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] + (m[2] ?? "")) === "") throw new AbapError("CX_SY_CONVERSION_NO_NUMBER", "c->p");
  const x = pParse(`${m[1] || "0"}.${m[2] ?? ""}`.replace(/\.$/, ""));
  return pText(neg ? {v: -x.v, s: x.s} : x);
}
const pParseExp = (t) => {
  const [mant, exp] = String(t).toLowerCase().split("e");
  const d = pParse(mant);
  if (exp !== undefined) d.s -= Number(exp);
  return d.s < 0 ? {v: d.v * pow10(-d.s), s: 0} : d;
};
export function FToP(f) {
  if (!Number.isFinite(f)) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "f->p");
  return pText(pParseExp(f.toExponential(16)));
}
export function PToI(a, arith) {
  const v = pScale(pParse(a), 0).v;
  if (v > 2147483647n || v < -2147483648n) throw new AbapError(arith ? "CX_SY_ARITHMETIC_OVERFLOW" : "CX_SY_CONVERSION_OVERFLOW", arith ? "=" : "p->i");
  return Number(v);
}
export function PToI8(a, arith) {
  const v = pScale(pParse(a), 0).v;
  if (v > 9223372036854775807n || v < -9223372036854775808n) throw new AbapError(arith ? "CX_SY_ARITHMETIC_OVERFLOW" : "CX_SY_CONVERSION_OVERFLOW", arith ? "=" : "p->int8");
  return v;
}
export const PToF = (a) => Number(pText(pParse(a)));
export function PToString(a, dec) {
  const d = pScale(pParse(a), dec);
  return d.v < 0n ? `${pFixed({v: -d.v, s: d.s}, dec)}-` : `${pFixed(d, dec)} `;
}
export function PToC(a, dec, n) {
  const d = pScale(pParse(a), dec);
  const neg = d.v < 0n;
  const t = pFixed({v: babs(d.v), s: d.s}, dec);
  let out;
  if (t.length + 1 <= n) out = " ".repeat(n - t.length - 1) + t + (neg ? "-" : " ");
  else if (!neg && t.length === n) out = t;
  else {
    const keep = Math.max(0, n - 1 - (neg ? 1 : 0));
    out = `*${keep === 0 ? "" : t.slice(t.length - keep)}${neg ? "-" : ""}`.slice(0, n);
  }
  return out.replace(/ +$/, "");
}
export function PToN(a, k) {
  const t = babs(pScale(pParse(a), 0).v).toString();
  return t.length > k ? t.slice(t.length - k) : t.padStart(k, "0");
}
export const FmtP = (a, dec) => pFixed(pScale(pParse(a), dec), dec);
export const FmtPDec = (a, n) => pFixed(pScale(pParse(a), n), n);
export const AbsP = (a) => { const x = pParse(a); return pText({v: babs(x.v), s: x.s}); };
export const SignP = (a) => { const v = pParse(a).v; return v < 0n ? -1 : v > 0n ? 1 : 0; };
const pInteger = (a, mode) => {
  const x = pParse(a);
  if (x.s <= 0) return pText(x);
  const m = pow10(x.s);
  let q = x.v / m;
  if (x.v % m !== 0n) {
    if (mode > 0 && x.v > 0n) q += 1n;
    if (mode < 0 && x.v < 0n) q -= 1n;
  }
  return q.toString();
};
export const CeilP = (a) => pInteger(a, 1);
export const FloorP = (a) => pInteger(a, -1);
export const TruncP = (a) => pInteger(a, 0);
export const FracP = (a) => SubP(a, TruncP(a));
// a generic elementary value as a packed value (go/abap DataP)
export function DataP(d) {
  if (d === null) throw notAssigned("move");
  const v = d.get();
  switch (d.t.kind) {
    case "P": return v;
    case "I": case "8": return String(v);
    case "F": return FToP(v);
    case "C": case "g": case "N": return CToP(v);
    default: throw new AbapError("NOT_COMPILED", `move: a generic value of type kind ${d.t.kind} into a p`);
  }
}
export const SysID = (() => { for (const n of ["OSD_SID", "STG_ADT_SID"]) { const v = String(globalThis.process?.env?.[n] ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""); if (v === "") continue; if (!/^[A-Za-z][A-Za-z0-9]{2}$/.test(v)) throw new Error(`${n}=${JSON.stringify(v)} is not a system id: exactly three characters, A-Z or 0-9, the first a letter`); return v.toUpperCase(); } return "OSD"; })(); // the rule of tools/osd-identity.mjs, said here because this file is copied beside emitted code
export const UName = "DEVELOPER";
// sy-dbsys / sy-saprl (go/abap/sysinfo.go)
export const DBSys = "sqlite";
export const SapRl = "OPEN";
export const Datum = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
export const Uzeit = () => new Date().toISOString().slice(11, 19).replaceAll(":", "");

// Sorted secondary keys (ultra/json), as go/abap/seckey.go: components
// ascending, equal keys newest (higher index) first, measured on A4H
// 2026-09-24. Strings compare by code point, as Go compares UTF-8 bytes.
export function cmpKey(a, b) {
  if (typeof a === "string") {
    const x = Array.from(a, (c) => c.codePointAt(0));
    const y = Array.from(b, (c) => c.codePointAt(0));
    for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function keyOrder(tb, c, unique) {
  const ord = tb.map((_, i) => tb.length - 1 - i);
  ord.sort((x, y) => c(tb[x], tb[y]));
  if (unique) for (let i = 1; i < ord.length; i++) if (c(tb[ord[i - 1]], tb[ord[i]]) === 0) notCompiled(`secondary key ${unique}: a unique key holds a value twice`);
  return ord;
}

export function keyRead(tb, c, unique) {
  let less = 0, pick = -1, equal = 0;
  tb.forEach((r, i) => {
    const x = c(r);
    if (x < 0) less++;
    else if (x === 0) { equal++; if (i > pick) pick = i; }
  });
  if (unique && equal > 1) notCompiled(`secondary key ${unique}: a unique key holds a value twice`);
  if (pick >= 0) return [pick, less + 1, 0];
  return [-1, less + 1, less === tb.length ? 8 : 4];
}

// keyFind: go/abap/seckey.go KeyFind
export function keyFind(tb, eq, key) {
  let pick = -1;
  tb.forEach((r, i) => {
    if (!eq(r)) return;
    if (pick >= 0) notCompiled(`secondary key ${key}: a unique key holds a value twice`);
    pick = i;
  });
  return pick;
}

export function uniqueKeyCheck(tb, dup, key) {
  if (tb.some(dup)) notCompiled(`APPEND: a row repeating the value of the unique secondary key ${key}: A4H raises the catchable CX_SY_ITAB_DUPLICATE_KEY (2026-09-24), which this runtime does not`);
}

// ---------------------------------------------------------------- class events
// ultra/events: SET HANDLER / RAISE EVENT, line for line go/abap/events.go
// (the rules measured on A4H are written there). A sender keeps its
// registrations in a property of its own, $ev, so they live as long as it.
function handlerTableSet(t, obj, method, filter, fn, on) {
  let free = -1;
  for (let i = 0; i < t.length; i += 1) {
    const e = t[i];
    if (e === null) { if (free < 0) free = i; continue; }
    if (e.obj === obj && e.method === method) {
      if (!on) { e.dead = true; t[i] = null; }
      return;
    }
  }
  if (!on) return;
  const e = {obj, method, filter, fn, dead: false};
  if (free >= 0) t[free] = e; else t.push(e);
}
const allHandlers = new Map();
const staticHandlers = new Map();
export function activation(v) {
  if (v === "X") return true;
  if (v === "" || v === " ") return false;
  throw new AbapError("NOT_COMPILED", "SET HANDLER: ACTIVATION with a value that is neither 'X' nor blank is not measured");
}
export function setHandler(s, event, forObj, all, isStatic, obj, method, filter, fn, on) {
  let m;
  if (isStatic || all) {
    m = isStatic ? staticHandlers : allHandlers;
  } else {
    if (forObj === null || forObj === undefined) throw new AbapError("OBJECTS_OBJREF_NOT_ASSIGNED", "SET HANDLER ... FOR an initial reference");
    if (!Object.prototype.hasOwnProperty.call(forObj, "$ev")) Object.defineProperty(forObj, "$ev", {value: new Map(), enumerable: false});
    m = forObj.$ev;
  }
  if (!m.has(event)) m.set(event, []);
  handlerTableSet(m.get(event), obj, method, filter, fn, on);
}
// the handler object of SET HANDLER h->m: an initial one is a runtime abortion
export function boundHandler(o) {
  if (o === null || o === undefined) throw new AbapError("OBJECTS_OBJREF_NOT_ASSIGNED", "SET HANDLER with an initial handler reference");
  return o;
}
export function raiseEvent(s, event, sender, isStatic, args) {
  const lists = [];
  if (isStatic) lists.push([...(staticHandlers.get(event) ?? [])]);
  else {
    if (sender?.$ev) lists.push([...(sender.$ev.get(event) ?? [])]);
    lists.push([...(allHandlers.get(event) ?? [])]);
  }
  for (const l of lists) {
    for (const e of l) {
      if (e === null || e.dead) continue;
      if (e.filter && !e.filter(sender)) continue;
      e.fn(s, sender, args());
    }
  }
}

// int8 (ultra/itab): BigInt values, overflow checked as go/abap conv.go
const MAX8 = 9223372036854775807n;
const MIN8 = -9223372036854775808n;
const check8 = (v, op) => {
  if (v > MAX8 || v < MIN8) throw new AbapError("CX_SY_ARITHMETIC_OVERFLOW", op);
  return v;
};
const abs8 = (v) => (v < 0n ? -v : v);
export const AddI8 = (a, b) => check8(a + b, "+");
export const SubI8 = (a, b) => check8(a - b, "-");
export const MulI8 = (a, b) => check8(a * b, "*");
export const NegI8 = (a) => check8(-a, "-");
export function DivI8(a, b) {
  if (b === 0n) {
    if (a === 0n) return 0n;
    throw new AbapError("CX_SY_ZERODIVIDE", "/");
  }
  let q = a / b;
  const r = a % b;
  if (r !== 0n && 2n * abs8(r) >= abs8(b)) q += (a < 0n) !== (b < 0n) ? -1n : 1n;
  return check8(q, "/");
}
export function DivIntI8(a, b) {
  if (b === 0n) {
    if (a === 0n) return 0n;
    throw new AbapError("CX_SY_ZERODIVIDE", "DIV");
  }
  let q = a / b;
  if (a % b < 0n) q += b > 0n ? -1n : 1n;
  return check8(q, "DIV");
}
export function ModI8(a, b) {
  if (b === 0n) {
    if (a === 0n) return 0n;
    throw new AbapError("CX_SY_ZERODIVIDE", "MOD");
  }
  let r = a % b;
  if (r < 0n) r += abs8(b);
  return r;
}
export function I8ToI(v) {
  if (v > 2147483647n || v < -2147483648n) throw new AbapError("CX_SY_ARITHMETIC_OVERFLOW", "int8->i");
  return Number(v);
}
export function F2I8(f) {
  const r = Math.sign(f) * Math.round(Math.abs(f));
  if (Number.isNaN(r) || r >= 9.223372036854775807e18 || r < -9.223372036854775808e18) throw new AbapError("CX_SY_CONVERSION_OVERFLOW", "f->int8");
  return BigInt(r);
}

// generic arithmetic (ultra/itab): as go/abap genarith.go
export function CalcKind(statics, charTarget, target, leaves) {
  const ks = statics.split("");
  for (const d of leaves) {
    if (d === null) throw notAssigned("arithmetic");
    ks.push(d.t.kind);
  }
  if (target !== null) {
    const k = target.t.kind;
    if ("I8FP".includes(k)) ks.push(k);
    else if (k === "C" || k === "g") charTarget = true;
    else if (k === "X") ks.push("I");
    else return "";
  }
  const has = (set) => ks.some((k) => set.includes(k));
  // a kind outside I 8 F P C g N is refused with or without an f operand,
  // so the refusal is uniform (critic fix); a character target of an
  // integer result is refused below until measured
  if (ks.some((k) => !"I8FPCgN".includes(k))) return "";
  if (has("F")) return "F";
  if (has("PCgN")) return "P";
  if (charTarget) return "";
  if (has("8")) return "8";
  return "I";
}
export function DataI8(d) {
  if (d.t.kind === "I") return BigInt(d.get());
  if (d.t.kind === "8") return d.get();
  throw new AbapError("NOT_COMPILED", `move: a generic value of type kind ${d.t.kind} into an int8`);
}
export function DataF(d) {
  const v = d.get();
  switch (d.t.kind) {
    case "I": case "F": return v;
    case "8": return Number(v);
    case "P": return PToF(v);
    case "C": case "g": case "N": return ParseF(v);
    default: throw new AbapError("NOT_COMPILED", `move: a generic value of type kind ${d.t.kind} into an f`);
  }
}

// ultra/events: CONCATENATE into its target, FIND ALL ... MATCH COUNT,
// escape( ) for an HTML attribute: go/abap strings.go
export function ConcatFit(v, n) {
  if (n < 0) return [v, 0];
  const r = [...v];
  const rc = r.length > n ? 4 : 0;
  return [r.slice(0, n).join("").replace(/ +$/, ""), rc];
}
export function FindAllCount(s, p, regex, icase) {
  if (p === "") throw new AbapError("NOT_COMPILED", "FIND ALL OCCURRENCES: an empty pattern is not measured");
  const ms = regex ? rxAll(s, p, icase, false) : plainAll(s, p, icase, false);
  if (ms.some((m) => m[0] === "")) throw new AbapError("NOT_COMPILED", "FIND ALL OCCURRENCES: a regex that matches the empty string is not measured");
  return ms.length;
}
// go/abap EscapeJSONString (A4H ZCL_GOGEN_T_JSESC)
const JSON_ESC = {"\\": "\\\\", '"': '\\"', "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"};
export const EscapeJSONString = (v) => v.replace(/[\u0000-\u001f"\\]/g, (c) => JSON_ESC[c] ?? `\\u00${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
export const EscapeHTMLAttr = (v) => v.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);

// ultra/events: APPEND INITIAL LINE TO <generic table> ASSIGNING <fs>, and
// describe_by_data( )->length: go/abap data.go
export function AppendInitialData(t) {
  if (t.t.noAppend) throw new AbapError("NOT_COMPILED", "APPEND INITIAL LINE: to a generic table that is not a standard table");
  const n = Lines(t);
  const rt = t.t.row;
  const zero = rt.zero ? rt.zero() : ({I: 0, F: 0, 8: 0n, D: "00000000", T: "000000", P: FmtP("", rt.dec ?? 0), X: "\u0000".repeat(rt.len ?? 0), N: "0".repeat(rt.len ?? 0)})[rt.kind] ?? "";
  t.get().push(zero);
  bumpTable(t.get());
  return [Row(t, n), n + 1];
}
export function DescrLength(d) {
  if (d === null) throw new AbapError("NOT_COMPILED", "describe_by_data( )->length: of an unassigned field symbol");
  switch (d.t.kind) {
    case "C": case "N": return 2 * d.t.len;
    case "X": return d.t.len;
    case "I": return 4;
  }
  throw new AbapError("NOT_COMPILED", `describe_by_data( )->length: of type kind ${d.t.kind}`);
}
// substring_before / _after( val sub ): go/abap strings.go
export function SubstringBefore(v, sub) {
  if (sub === "") throw new AbapError("NOT_COMPILED", "substring_before( ): an empty sub is not measured");
  const i = v.indexOf(sub);
  return i >= 0 ? v.slice(0, i) : "";
}
export function SubstringAfter(v, sub) {
  if (sub === "") throw new AbapError("NOT_COMPILED", "substring_after( ): an empty sub is not measured");
  const i = v.indexOf(sub);
  return i >= 0 ? v.slice(i + sub.length) : "";
}
// GET TIME STAMP FIELD (ultra/events): go/abap sysinfo.go TimeStamp
export function TimeStamp(dec) {
  const d = new Date();
  const ts = d.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return dec === 7 ? `${ts}.${String(d.getUTCMilliseconds()).padStart(3, "0")}0000` : ts;
}

// ultra/events (fix round): an exception out of a class constructor is a
// runtime error no CATCH takes (A4H ZCL_GOGEN_T_CCBOOM2); see CctorGuard in
// raise.go. Anything that is not class-based goes on as it is
export function cctorDump(cls, e) {
  if (!classBased(e)) return e;
  return new AbapError("RUNTIME_ERROR", `${cls}=>CLASS_CONSTRUCTOR: ${e.message}`);
}
// concat_lines_of( table = t sep = sep ) over a table of strings (go/abap ConcatLinesOf)
export function ConcatLinesOf(t, sep) {
  return t.join(sep);
}

// FIND ... RESULTS (parity-wave2): go/abap FindResults, the same iteration
// (after a match at its end, after an empty one a character on, an empty
// match at the end found) and the same answer shape, offsets in code points.
// A JS RegExp is leftmost-first: for PCRE ('P') that is the engine; for
// REGEX ('R', POSIX leftmost-longest) an alternation whose shorter branch
// matches first differs, as in FindStmt (a|ab in xabab: JS 1,1 3,1, A4H
// 1,2 3,2); the Go runtime is the exact one. PCRE's refusals are Go's.
const PCRE_REFUSED = [[/\(\?=/, "a lookahead (?=...)"], [/\(\?!/, "a negative lookahead (?!...)"], [/\(\?<=/, "a lookbehind (?<=...)"],
  [/\(\?<!/, "a negative lookbehind (?<!...)"], [/\(\?>/, "an atomic group (?>...)"], [/\\[1-9]|\\g\{?-?\d|\\k[<{']/, "a backreference"],
  [/[*+?}]\+/, "a possessive quantifier"], [/\\K/, "\\K"], [/\\G/, "\\G"], [/\(\?(R|\d|&|P>|\()/, "a recursion or a conditional"],
  [/\(\*/, "a verb (*...)"], [/\\[cexoNXRhHvV]/, "an escape RE2 reads differently or not at all"]];
export function FindResults(s, p, kind, icase, all) {
  if (p === "") notCompiled("FIND ... RESULTS: an empty pattern is not measured");
  const cp = (i) => [...s.slice(0, i)].length;
  if (kind === "" && !icase) {
    const out = [];
    const n = [...p].length;
    for (let pos = 0; pos <= s.length;) {
      const i = s.indexOf(p, pos);
      if (i < 0) break;
      out.push([cp(i), n]);
      if (!all) break;
      pos = i + p.length;
    }
    return out;
  }
  let re;
  if (kind === "P") {
    const plain = p.replaceAll("\\\\", "");
    for (const [r, what] of PCRE_REFUSED) if (r.test(plain)) notCompiled(`FIND PCRE: ${what} is not in Go's RE2: ${p}`);
    if (/[\n\r]/.test(s)) notCompiled("FIND PCRE: a text with line ends: PCRE's ^ $ and . around them are not measured");
    try { re = new RegExp(p, (icase ? "i" : "") + "gdu"); } catch { notCompiled(`FIND PCRE: the pattern does not compile here: ${p}`); }
  } else {
    const pat = kind === "" ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p;
    if (/\*\?|\+\?|\?\?/.test(pat)) throw new AbapError("CX_SY_INVALID_REGEX", pat);
    re = abapRegExp(pat, s, icase, "gd", "FIND REGEX");
  }
  const out = [];
  for (let pos = 0; pos <= s.length;) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) break;
    const r = [];
    for (const ix of m.indices) {
      if (ix === undefined) { r.push(-1, 0); continue; }
      const o = cp(ix[0]);
      r.push(o, cp(ix[1]) - o);
    }
    out.push(r);
    if (!all) break;
    const end = m.index + m[0].length;
    if (end > m.index) { pos = end; continue; }
    if (m.index >= s.length) break;
    pos = m.index + (s.codePointAt(m.index) > 0xffff ? 2 : 1);
  }
  return out;
}
