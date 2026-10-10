// SPDX-License-Identifier: MIT
// Minimal reader of https://github.com/google/pprof/blob/main/proto/profile.proto.
// Unknown fields are skipped; packed and unpacked repeated integers are accepted.
import {gunzipSync} from "node:zlib";

function varint(buf, state) {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (state.i >= buf.length) throw new Error("truncated protobuf varint");
    const byte = buf[state.i++];
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) {
      if (value > 0xffffffffffffffffn) throw new Error("protobuf varint overflow");
      return value;
    }
  }
  throw new Error("protobuf varint overflow");
}
function message(buf) {
  const out = new Map(), state = {i: 0};
  while (state.i < buf.length) {
    const tag = Number(varint(buf, state)), field = tag >>> 3, wire = tag & 7;
    if (!field) throw new Error("invalid protobuf field");
    let value;
    if (wire === 0) value = varint(buf, state);
    else if (wire === 2) {
      const len = Number(varint(buf, state));
      if (!Number.isSafeInteger(len) || len > buf.length - state.i) throw new Error("truncated protobuf bytes");
      value = buf.subarray(state.i, state.i + len); state.i += len;
    } else if (wire === 1 || wire === 5) {
      state.i += wire === 1 ? 8 : 4;
      if (state.i > buf.length) throw new Error("truncated protobuf fixed field");
      continue;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (!out.has(field)) out.set(field, []);
    out.get(field).push(value);
  }
  return out;
}
const all = (m, f) => m.get(f) ?? [];
const one = (m, f) => all(m, f)[0] ?? 0n;
function integer(value, signed = false) {
  if (typeof value !== "bigint") throw new Error("expected protobuf integer");
  const n = Number(signed ? BigInt.asIntN(64, value) : value);
  if (!Number.isSafeInteger(n)) throw new Error("profile integer exceeds JavaScript safe range");
  return n;
}
function repeated(m, f, signed = false) {
  return all(m, f).flatMap(value => {
    if (typeof value === "bigint") return [integer(value, signed)];
    const state = {i: 0}, out = [];
    while (state.i < value.length) out.push(integer(varint(value, state), signed));
    return out;
  });
}

export function parsePprof(input) {
  const buf = input[0] === 31 && input[1] === 139 ? gunzipSync(input) : input;
  const p = message(buf), strings = all(p, 6).map(b => b.toString("utf8"));
  if (strings[0] !== "") throw new Error("invalid pprof string table");
  const str = id => {
    const value = strings[integer(id)];
    if (value === undefined) throw new Error("invalid pprof string reference");
    return value;
  };
  const types = all(p, 1).map(b => {const t = message(b); return {type: str(one(t, 1)), unit: str(one(t, 2))};});
  if (!types.length) throw new Error("pprof has no sample types");
  const cpu = types.findIndex(t => t.type === "cpu" && t.unit === "nanoseconds");
  const preferred = str(one(p, 14));
  const chosen = types.findIndex(t => t.type === preferred);
  const weightIndex = cpu >= 0 ? cpu : chosen >= 0 ? chosen : types.length - 1;
  const countIndex = types.findIndex(t => t.type === "samples" && t.unit === "count");
  const functions = new Map(all(p, 5).map(b => {
    const f = message(b);
    return [integer(one(f, 1)), {name: str(one(f, 2)), file: str(one(f, 4))}];
  }));
  const locations = new Map(all(p, 4).map(b => {
    const loc = message(b);
    return [integer(one(loc, 1)), all(loc, 4).map(b => {
      const line = message(b), fn = functions.get(integer(one(line, 1)));
      if (!fn) throw new Error("unknown pprof function");
      return {...fn, line: integer(one(line, 2), true)};
    })];
  }));
  const samples = all(p, 2).map(b => {
    const s = message(b), values = repeated(s, 2, true), labels = {};
    if (values.length !== types.length || values.some(v => v < 0)) throw new Error("invalid pprof sample values");
    for (const b of all(s, 3)) {
      const l = message(b), key = str(one(l, 1));
      const value = l.has(2) ? str(one(l, 2)) : String(integer(one(l, 3), true));
      (labels[key] ??= []).push(value);
    }
    const frames = repeated(s, 1).flatMap(id => {
      if (!locations.has(id)) throw new Error("unknown pprof location");
      return locations.get(id);
    });
    return {frames, labels, weight: values[weightIndex], samples: countIndex >= 0 ? values[countIndex] : null};
  });
  const mappings = all(p, 3).map(b => {const m = message(b);return {file: str(one(m, 5)), buildId: str(one(m, 6))};});
  return {format: "pprof", durationSeconds: integer(one(p, 10), true) / 1e9,
    metric: types[weightIndex], mappings, samples};
}
