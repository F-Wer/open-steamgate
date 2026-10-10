// Synchronous CONV_*_CE adapters: go/abap/codepage.go is the contract.
// Text is UTF-16 in JS; xstrings store bytes directly. Preserve lone
// surrogates as WTF-8 on output, and refuse them on UTF-16 input like Go.
import {Buffer} from 'buffer';
import {AbapError} from './abap.mjs';

const refused = (op, reason) => { throw new AbapError('NOT_COMPILED', `CL_ABAP_CONV_${op}_CE=>CONVERT: ${reason}`); };
export function encodeText(encoding, text) {
  if (encoding === 'utf16le' || encoding === 'utf-16le') return Buffer.from(text, 'utf16le').toString('latin1');
  if (encoding !== 'utf8') refused('OUT', `encoding ${encoding}`);
  // Buffer replaces lone surrogates. Encode those units explicitly instead.
  if (!/[\uD800-\uDFFF]/u.test(text)) return Buffer.from(text, 'utf8').toString('latin1');
  let out = '';
  for (const c of text) {
    const u = c.charCodeAt(0);
    out += c.length === 1 && u >= 0xD800 && u <= 0xDFFF
      ? String.fromCharCode(0xE0 | u >> 12, 0x80 | u >> 6 & 63, 0x80 | u & 63)
      : Buffer.from(c, 'utf8').toString('latin1');
  }
  return out;
}

export function decodeText(encoding, ignoreErrors, bytes) {
  if (encoding === 'utf16le' || encoding === 'utf-16le') {
    if (bytes.length % 2) refused('IN', 'an odd number of UTF-16 bytes');
    const text = Buffer.from(bytes, 'latin1').toString('utf16le');
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      if (u < 0xD800 || u > 0xDFFF) continue;
      const next = text.charCodeAt(i + 1);
      if (u < 0xDC00 && next >= 0xDC00 && next < 0xE000) { i++; continue; }
      refused('IN', 'an unpaired UTF-16 surrogate');
    }
    return text;
  }
  // Xstrings already hold one code unit per byte; C1 bytes remain controls.
  if (encoding === 'iso-8859-1') return bytes;
  if (encoding !== 'utf8') refused('IN', `encoding ${encoding}`);
  const input = Buffer.from(bytes, 'latin1');
  try { return new TextDecoder('utf8', {fatal: true, ignoreBOM: true}).decode(input); }
  catch { if (!ignoreErrors) throw new AbapError('CX_SY_CONVERSION_CODEPAGE', 'CL_ABAP_CONV_IN_CE=>CONVERT'); }
  // strings.ToValidUTF8 replaces each contiguous run of invalid bytes once.
  let out = '', invalid = false;
  for (let i = 0; i < input.length;) {
    const b = input[i];
    let n = b < 0x80 ? 1 : b >= 0xC2 && b <= 0xDF ? 2 : b >= 0xE0 && b <= 0xEF ? 3 : b >= 0xF0 && b <= 0xF4 ? 4 : 0;
    if (i + n > input.length) n = 0;
    for (let j = 1; j < n; j++) if (input[i+j] < 0x80 || input[i+j] > 0xBF) { n = 0; break; }
    const next = input[i+1];
    if (n > 1 && (b === 0xE0 && next < 0xA0 || b === 0xED && next >= 0xA0 || b === 0xF0 && next < 0x90 || b === 0xF4 && next >= 0x90)) n = 0;
    if (!n) { if (!invalid) out += '\uFFFD'; invalid = true; i++; }
    else { out += input.subarray(i, i+n).toString('utf8'); invalid = false; i += n; }
  }
  return out;
}

export function convertOut(s, encoding, data, n, buffer, supplied) {
  if (supplied === undefined && n !== 0) refused('OUT', 'N given');
  if (supplied !== undefined && supplied !== '') {
    if (n > data.length) throw new AbapError('CX_SY_RANGE_OUT_OF_BOUNDS', 'offset/length');
    data = n < 0 ? data : data.slice(0, n);
  }
  buffer.v = encodeText(encoding, data);
}

export function convertIn(s, encoding, ignoreErrors, input, n, data) {
  if (n !== 0) refused('IN', 'N given (open-abap ignores it)');
  data.v = decodeText(encoding, ignoreErrors, input);
}
