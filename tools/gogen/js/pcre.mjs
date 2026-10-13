import {notCompiled} from "./abap.mjs";

// Names are syntax, never atoms. References remain subject to engine refusals.
function pcreName(p, i) {
  return /^(?:\(\?<[^=!][^>]*>|\(\?P<[^>]+>|\(\?'[^']+'|\\[kg](?:<[^>]+>|\{[^}]+\}|'[^']+'))/.exec(p.slice(i))?.[0];
}
export function pcreSyntax(p, escapes = false) {
  let out = "";
  for (let i=0; i<p.length; i++) {
    const name = pcreName(p,i);
    if (name) { out += name[0] === "\\" ? name.slice(0,3) : "_"; i += name.length-1; }
    else if (p[i] === "[") { i = pcreClassItems(p,i,notCompiled).end; out += "_"; }
    else if (p[i] === "\\") {
      const scalar = /^\\x\{[0-9a-f]+\}/.exec(p.slice(i));
      if (scalar) { i += scalar[0].length-1; out += "_"; }
      else { out += escapes && p[i+1] !== "\\" ? p.slice(i,i+2) : "_"; i++; }
    } else out += p[i];
  }
  return out;
}

export const PCRE_REFUSED = [[/\(\?=/, "a lookahead (?=...)"], [/\(\?!/, "a negative lookahead (?!...)"], [/\(\?<=/, "a lookbehind (?<=...)"],
  [/\(\?<!/, "a negative lookbehind (?<!...)"], [/\(\?>/, "an atomic group (?>...)"], [/\\[1-9]|\\g\{?-?\d|\\k[<{']/, "a backreference"],
  [/[*+?}]\+/, "a possessive quantifier"], [/\\K/, "\\K"], [/\\G/, "\\G"], [/\\Z/, "\\Z"], [/\(\?(R|\d|&|P>|\()/, "a recursion or a conditional"],
  [/\(\*/, "a verb (*...)"], [/\\[ceoNXRhHvV]/, "an escape RE2 reads differently or not at all"]];
function pcreHex(p, x) {
  let end = x + 1, value = 0;
  const braced = p[end] === "{";
  if (braced) end++;
  const start = end;
  while (end < p.length && /[0-9a-f]/i.test(p[end]) && (braced || end - start < 2)) {
    if (value <= 0x10ffff) value = value * 16 + parseInt(p[end], 16);
    end++;
  }
  if (braced) {
    if (end === start || p[end] !== "}") notCompiled("FIND PCRE: a malformed braced hex escape");
    end++;
  }
  if (!braced && end === start) notCompiled("FIND PCRE: \\x without hex digits");
  if (value > 0x10ffff) notCompiled("FIND PCRE: a hex escape above U+10FFFF");
  if (value >= 0xd800 && value <= 0xdfff) notCompiled("FIND PCRE: a surrogate hex escape (U+D800-U+DFFF)");
  return ["\\x{" + value.toString(16) + "}", end - 1]; // Validate before JS translation.
}

// Unmeasured: ABAP PCRE extended mode by documentation; measure on A4H before changing
export function extendedPCRE(p, anchors) {
  const extended = !p.startsWith("(?-x)");
  if (!extended) p = p.slice(5);
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const name = pcreName(p,i);
    if (name) {
      out += name.startsWith("(?P<") ? "(?<" + name.slice(4) : name.startsWith("(?'") ? "(?<" + name.slice(3,-1) + ">" : name;
      i += name.length-1; continue;
    }
    const c = p[i];
    if (c === "[") {
      const parsed = pcreClassItems(p,i,notCompiled);
      out += "[" + (parsed.neg ? "^" : "") + parsed.items.map(t => t.kind === "g" ? "\\"+t.text : t.raw ?? t.text).join("") + "]";
      i = parsed.end; continue;
    }
    if (c === "\\" && i + 1 < p.length) {
      const next = p[++i];
      if (next === "Q" || next === "E") notCompiled("FIND PCRE: unsupported quoting escape \\" + next);
      if (next === "x") {
        const [hex, end] = pcreHex(p, i);
        out += hex;
        i = end;
        continue;
      }
      if (next === "A" || next === "z") {
        anchors.push([out.length, next]);
      }
      out += /[ \t\n\r\f\v#]/.test(next) ? next : c + next;
      continue;
    }
    if (extended) {
      if (/[ \t\n\r\f\v]/.test(c)) continue;
      if (c === "#") {
        while (i + 1 < p.length && !/[\r\n]/.test(p[i + 1])) i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}

function pcreClassItems(p, start, refuse) {
  const fail = reason => refuse("FIND PCRE: " + reason);
  let i = start + 1;
  const neg = p[i] === "^";
  if (neg) i++;
  const tokens = [];
  let first = true;
  const scalar = n => `\\u{${n.toString(16)}}`;
  const posix = {alpha: "A-Za-z", alnum: "A-Za-z0-9", ascii: "\\u{0}-\\u{7f}", blank: " \\t",
    cntrl: "\\u{0}-\\u{1f}\\u{7f}", digit: "0-9", graph: "!-~", lower: "a-z", print: " -~",
    punct: "!-/:-@\\u{5b}-`{-~", space: " \\t\\n\\r\\f\\v", upper: "A-Z", word: "A-Za-z0-9_", xdigit: "A-Fa-f0-9"};
  while (i < p.length && (p[i] !== "]" || first)) {
    first = false;
    let c = p[i];
    if (c === "[" && /[:.=]/.test(p[i+1] ?? "")) {
      if (p[i+1] !== ":") fail("unsupported character class collating or equivalence item");
      const end = p.indexOf(":]", i+2);
      if (end < 0) fail("unterminated POSIX class");
      const name = p.slice(i+2,end);
      if (!Object.hasOwn(posix,name)) fail("an unsupported POSIX class: " + name);
      tokens.push({kind: "p", text: posix[name], raw: p.slice(i,end+2)});
      i = end+2;
      continue;
    }
    if (c === "-") { tokens.push({kind: "h"}); i++; continue; }
    let n = p.codePointAt(i);
    i += n > 0xffff ? 2 : 1;
    if (c === "\\") {
      if (i >= p.length) fail("unterminated character class escape");
      c = String.fromCodePoint(p.codePointAt(i));
      i += c.length;
      if (/^[sSdDwW]$/.test(c)) { tokens.push({kind: "g", text: c}); continue; }
      const controls = {a:7, b:8, t:9, n:10, v:11, f:12, r:13};
      if (Object.hasOwn(controls,c)) n = controls[c];
      else if (c === "Q" || c === "E") fail("unsupported quoting escape \\" + c);
      else if (c === "A" || c === "z") fail("unsupported anchor escape in character class \\" + c);
      else if (c === "8" || c === "9") n = c.codePointAt(0);
      else if (/[0-7]/.test(c)) {
        const digits = c + (/^[0-7]{0,2}/.exec(p.slice(i))[0]);
        n = parseInt(digits,8); i += digits.length-1;
      } else if (c === "o" && p[i] === "{") {
        const end = p.indexOf("}",i), oct = p.slice(i+1,end);
        if (end < 0 || !/^[0-7]+$/.test(oct) || parseInt(oct,8)>0x10ffff || parseInt(oct,8)>=0xd800 && parseInt(oct,8)<=0xdfff) fail("invalid character class octal escape");
        n = parseInt(oct,8); i = end+1;
      } else if (c === "x") {
        const [hex,end] = pcreHex(p,i-1);
        n = parseInt(hex.slice(3,-1),16); i = end+1;
      } else if (c === "u" && p[i] === "{") {
        const end = p.indexOf("}",i);
        const hex = p.slice(i+1,end);
        if (end < 0 || !/^[0-9a-f]+$/i.test(hex) || parseInt(hex,16)>0x10ffff) fail("invalid character class scalar escape");
        n = parseInt(hex,16); i = end+1;
      } else {
        if (/[a-z0-9]/i.test(c)) fail("unsupported character class escape \\" + c);
        n = c.codePointAt(0);
      }
    }
    tokens.push({kind: "l", text: scalar(n)});
  }
  if (i >= p.length) fail("unterminated character class");
  const items = [];
  for (let j=0; j<tokens.length; j++) {
    let t = tokens[j];
    if (t.kind === "h") t = {kind: "l", text: scalar(45)};
    if (j+2 < tokens.length && tokens[j+1].kind === "h") {
      let hi = tokens[j+2];
      if (hi.kind === "h") hi = {kind: "l", text: scalar(45)};
      if (t.kind === "g" || hi.kind === "g") fail("a generic type as a character range endpoint");
      if (t.kind !== "l" || hi.kind !== "l") fail("a POSIX class as a character range endpoint");
      t = {kind: "l", text: t.text + "-" + hi.text};
      j += 2;
    }
    items.push(t);
  }
  return {items, neg, end: i};
}

function genericPCRE(p, notCompiled, icase = false) {
  const word = "(?=[\\x00-\\x7f])[A-Za-z0-9_]";
  const previous = "(?<=[A-Za-z0-9_])(?<![ſK])";
  const noPrevious = "(?:(?<![A-Za-z0-9_])|(?<=[ſK]))";
  const types = {s: "[\\t\\n\\x0b\\f\\r ]", d: "[0-9]", w: word};
  for (const c of "sdw") types[c.toUpperCase()] = "(?:(?!" + types[c] + ")[\\s\\S])";
  types.b = "(?:" + noPrevious + "(?=" + word + ")|" + previous + "(?!" + word + "))";
  types.B = "(?:" + previous + "(?=" + word + ")|" + noPrevious + "(?!" + word + "))";
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const name = pcreName(p,i);
    if (name) {
      out += name.startsWith("(?P<") ? "(?<" + name.slice(4) : name.startsWith("(?'") ? "(?<" + name.slice(3,-1) + ">" : name;
      i += name.length-1; continue;
    }
    if (p[i] === "\\" && i + 1 < p.length) {
      const scalar = /^\\x\{[0-9a-f]+\}/.exec(p.slice(i));
      if (scalar) { out += "\\u" + scalar[0].slice(2); i += scalar[0].length-1; continue; }
      out += types[p[i + 1]] ?? p.slice(i, i + 2);
      i++;
      continue;
    }
    if (p[i] !== "[") { out += p[i]; continue; }
    const parsed = pcreClassItems(p, i, notCompiled);
    i = parsed.end;
    const neg = parsed.neg, members = [], ordinary = [];
    for (const item of parsed.items) {
      if (item.kind === "g") members.push(types[item.text]);
      else if (item.kind === "p") {
        const atom = "[" + item.text + "]";
        members.push(icase ? "(?=[\\x00-\\x7f])" + foldedPCREAtom(atom) : atom);
      } else ordinary.push(item.text);
    }
    if (ordinary.length) {
      const atom = "[" + ordinary.join("") + "]";
      members.push(icase ? foldedPCREAtom(atom) : atom);
    }
    const union = "(?:" + members.join("|") + ")";
    out += neg ? "(?:(?!" + union + ")[\\s\\S])" : union;
  }
  return out;
}

// Materialize the host's Unicode simple case folding before generic rewriting,
// then compile without i so generic sets and boundaries stay strictly ASCII.
const pcreFoldCache = new Map();
function foldedPCREAtom(atom) {
  if (pcreFoldCache.has(atom)) return pcreFoldCache.get(atom);
  const re = new RegExp("^(?:" + atom + ")$", "iu");
  const ranges = [];
  let first = -1, last = -1;
  for (let n = 0; n <= 0x10ffff; n++) {
    if (n >= 0xd800 && n <= 0xdfff) continue;
    if (!re.test(String.fromCodePoint(n))) continue;
    if (n !== last + 1 && first !== -1) { ranges.push([first, last]); first = -1; }
    if (first === -1) first = n;
    last = n;
  }
  if (first !== -1) ranges.push([first, last]);
  const result = ranges.length ? "[" + ranges.map(([a,b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]" : "(?!)";
  pcreFoldCache.set(atom, result);
  return result;
}
function foldPCRE(p) {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const name = pcreName(p,i);
    if (name) {
      out += name.startsWith("(?P<") ? "(?<" + name.slice(4) : name.startsWith("(?'") ? "(?<" + name.slice(3,-1) + ">" : name;
      i += name.length-1; continue;
    }
    if (p[i] === "[") {
      const parsed = pcreClassItems(p, i, notCompiled);
      out += p.slice(i, parsed.end + 1);
      i = parsed.end;
    } else if (p[i] === "\\") {
      const m = /^\\(?:[xu]\{[0-9a-f]+\}|[pP]\{[^}]+\})/.exec(p.slice(i));
      if (m) { out += foldedPCREAtom(m[0].replace(/^\\x/, "\\u")); i += m[0].length-1; }
      else { out += p.slice(i,i+2); i++; }
    } else {
      const c = String.fromCodePoint(p.codePointAt(i));
      out += /\p{L}/u.test(c) ? foldedPCREAtom(c) : c;
      i += c.length-1;
    }
  }
  return out;
}

export function normalizePCREGenerics(p, icase, notCompiled) {
  return genericPCRE(icase ? foldPCRE(p) : p, notCompiled, icase);
}
