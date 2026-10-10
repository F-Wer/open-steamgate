// Synchronous adapters for open-abap-core's CONV_*_CE @KERNEL bodies.
// Buffer/TextDecoder are the same primitives used by the vanilla transpiler;
// IR-JS xstrings contain bytes directly, rather than hexadecimal text.
import {Buffer} from 'buffer';
import {AbapError, SubS} from './abap.mjs';

export function encodeText(encoding, text) {
  if (!['utf8', 'utf16le', 'utf-16le'].includes(encoding))
    throw new AbapError('NOT_COMPILED', `CL_ABAP_CONV_OUT_CE=>CONVERT encoding ${encoding}`);
  return Buffer.from(text, encoding === 'utf-16le' ? 'utf16le' : encoding).toString('latin1');
}

export function decodeText(encoding, ignoreErrors, bytes) {
  try {
    // ignoreBOM preserves U+FEFF, as open-abap-core's CONVERT does.
    return new TextDecoder(encoding, {fatal: !ignoreErrors, ignoreBOM: true})
      .decode(Buffer.from(bytes, 'latin1'));
  } catch {
    throw new AbapError('CX_SY_CONVERSION_CODEPAGE', 'CL_ABAP_CONV_IN_CE=>CONVERT');
  }
}

export function convertOut(s, encoding, data, n, buffer, supplied) {
  if (supplied === undefined && n !== 0) throw new AbapError('NOT_COMPILED', 'CL_ABAP_CONV_OUT_CE=>CONVERT N given');
  if (supplied !== undefined && supplied !== '') data = SubS(data, 0, n);
  buffer.v = encodeText(encoding, data);
}

export function convertIn(s, encoding, ignoreErrors, input, n, data) {
  // Go deliberately refuses N: open-abap-core's decoder ignores it.
  if (n !== 0) throw new AbapError('NOT_COMPILED', 'CL_ABAP_CONV_IN_CE=>CONVERT N given (open-abap ignores it)');
  data.v = decodeText(encoding, ignoreErrors, input);
}
