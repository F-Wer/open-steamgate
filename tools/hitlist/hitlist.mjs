// SPDX-License-Identifier: MIT
import {basename} from "node:path";
import {typeName as encode} from "../gogen/go-symbols.mjs";

const normalized = s => s.replaceAll("\\", "/");

// Emitter functions are CLASS_METHOD or (*CLASS).METHOD; filenames carry
// the ABAP owner. Never infer source lines from generated Go line numbers.
export function abapSite(frame) {
  if (!/\.abap$/i.test(frame.file) || frame.line < 1) return null;
  const owner = basename(normalized(frame.file)).split(".")[0].replaceAll("#", "/").toUpperCase();
  const ownerSymbol = encode(owner);
  const namespace = /^(\/[^/]+\/)/.exec(owner)?.[1];
  const decode = symbol => {
    let value = symbol.toUpperCase();
    if (namespace && value.startsWith(encode(namespace))) value = namespace + value.slice(encode(namespace).length);
    else value = value.replace(/^N_([^_]+)_/, "/$1/");
    return value.replaceAll("__", "~");
  };
  const decodeClass = symbol => {
    const value = symbol.toUpperCase();
    if (value === ownerSymbol) return owner;
    if (value.startsWith(ownerSymbol + "_")) return `${owner}:${value.slice(ownerSymbol.length + 1)}`;
    return decode(value);
  };
  let name = frame.name.replace(/^main\./, "").replace(/\.(?:func|deferwrap|gowrap)\d+(?:\.\d+)*$/, "");
  const receiver = /^\(\*?([^)]*)\)\.(.+)$/.exec(name);
  let cls = owner, method;
  if (receiver) { cls = decodeClass(receiver[1]); method = decode(receiver[2]); }
  else if (name.includes("__OSD_METHOD__")) {
    const [symbol, body] = name.split("__OSD_METHOD__");
    cls = decodeClass(symbol); method = decode(body);
  }
  else if (name.toUpperCase().startsWith(ownerSymbol + "_")) method = decode(name.slice(ownerSymbol.length + 1));
  else if (name === `New_${ownerSymbol}`) method = "CONSTRUCTOR";
  else if (name.startsWith("New_")) { cls = decodeClass(name.slice(4)); method = "CONSTRUCTOR"; }
  else if (name.includes("=>")) [cls, method] = name.toUpperCase().split("=>");
  else method = decode(name);
  return {key: `${cls}=>${method}:${frame.line}`, class: cls,
    method, file: normalized(frame.file), line: frame.line};
}

// A map is authoritative: unlisted frames remain unattributed. Ambiguous
// bare names never select an arbitrary package's symbol.
export function symbolResolver(map) {
  if (map.schema !== "gogen-symbols/1" || typeof map.build !== "string" || !map.symbols || Array.isArray(map.symbols) || typeof map.symbols !== "object")
    throw new Error("invalid gogen-symbols/1 symbol map");
  const bare = new Map();
  for (const entry of Object.values(map.symbols)) {
    if (!entry || typeof entry.go !== "string" || typeof entry.abap !== "string" || typeof entry.file !== "string" || !Number.isSafeInteger(entry.line) || entry.line < 1 || !["method", "form", "fm", "local", "closure"].includes(entry.kind) || (entry.owner !== undefined && typeof entry.owner !== "string"))
      throw new Error("invalid symbol map entry");
    bare.set(entry.go, bare.has(entry.go) ? null : entry);
  }
  return frame => {
    const start = frame.name.lastIndexOf("/") + 1;
    const dot = frame.name.indexOf(".", start);
    const name = dot < 0 ? frame.name : frame.name.slice(dot + 1);
    const entry = (Object.hasOwn(map.symbols, frame.name) ? map.symbols[frame.name] : null) ?? bare.get(frame.name) ?? bare.get(name);
    if (!entry) return null;
    const split = entry.abap.indexOf("=>");
    const cls = entry.owner || (split < 0 ? entry.abap : entry.abap.slice(0, split));
    const method = split < 0 ? entry.abap : entry.abap.slice(split + 2);
    const line = entry.kind !== "closure" && /\.abap$/i.test(frame.file) && frame.line > 0 ? frame.line : entry.line;
    return {key: `${entry.abap}:${line}`, abap: entry.abap, class: cls, method,
      owner: entry.owner ?? null, kind: entry.kind, file: normalized(entry.file), line};
  };
}

function tsName(site, names) {
  const cls = site.class.toLowerCase(), method = site.method.toLowerCase();
  const exact = names[site.key] ?? names[`${site.file}:${site.line}`];
  // Method-body mappings can exist without any class entry.
  const body = site.method.startsWith("Z_") ? names[method] : null;
  if (!exact && body) return tsName({...site, class: method, method: ""}, {[method]: body});
  const entry = exact ?? names[cls] ?? names[cls.replaceAll("/", "#")];
  if (!entry) return null;
  if (typeof entry === "object") {
    return {name: entry.name ?? entry.tsName ?? null, file: entry.file ?? entry.tsFile ?? null,
      line: entry.line ?? entry.tsLine ?? null, siteId: entry.siteId ?? null};
  }
  // abapiti abaplint names.json maps generated class -> "file.ts.Symbol.method".
  // It does not contain TS source line numbers; leave the line unknown.
  const m = /^(.*\.tsx?)(?:[.: ](.*))?$/.exec(entry);
  return {name: m?.[2] ?? entry, file: m?.[1] ?? null, line: null, siteId: null};
}

function exactCalls(row, counts) {
  const keys = [row.siteId, row.key, `${row.file}:${row.line}`, `${basename(row.file)}:${row.line}`].filter(Boolean);
  for (const key of keys) if (Object.hasOwn(counts, key)) {
    const value = counts[key];
    const calls = typeof value === "number" ? value : value.calls ?? value.count;
    if (!Number.isSafeInteger(calls) || calls < 0) throw new Error(`invalid exact count for ${key}`);
    return calls;
  }
  return null;
}

export function hitlist(profile, {tags = [], names = {}, counts = {}, host, commit, symbols} = {}) {
  if (profile.format === "v8" && tags.length) throw new Error("V8 CPU profiles have no pprof labels; --tag is unavailable");
  const filters = tags.map(tag => {
    const pos = tag.indexOf("=");
    if (pos < 1) throw new Error("--tag requires key=value");
    return [tag.slice(0, pos), tag.slice(pos + 1)];
  });
  const siteFor = symbols ? symbolResolver(symbols) : abapSite;
  const rows = new Map();
  let totalWeight = 0, totalSamples = 0, unattributedWeight = 0;
  for (const sample of profile.samples) {
    if (!filters.every(([k, v]) => sample.labels[k]?.includes(v))) continue;
    totalWeight += sample.weight;
    if (sample.samples !== null) totalSamples += sample.samples;
    const seen = new Set();
    let flat = true;
    for (let i = 0; i < sample.frames.length; i++) {
      const site = siteFor(sample.frames[i]);
      if (!site || seen.has(site.key)) continue;
      seen.add(site.key);
      let row = rows.get(site.key);
      if (!row) {
        const ts = tsName(site, names);
        row = {...site, siteId: ts?.siteId ?? null, ts, flatWeight: 0, cumWeight: 0,
          samples: sample.samples === null ? null : 0, cumSamples: sample.samples === null ? null : 0, callees: new Map()};
        rows.set(site.key, row);
      }
      row.cumWeight += sample.weight;
      if (sample.samples !== null) row.cumSamples += sample.samples;
      // Flat is exclusive of nested ABAP lines, inclusive of native runtime
      // beneath this nearest ABAP line. Runtime-only samples stay unattributed.
      if (flat) {
        row.flatWeight += sample.weight;
        if (sample.samples !== null) row.samples += sample.samples;
        flat = false;
      }
      // The runtime frame nearest this ABAP caller (including inlined frames).
      const callee = sample.frames.slice(0, i).reverse().find(f => !siteFor(f));
      if (callee) {
        const c = row.callees.get(callee.name) ?? {name: callee.name, weight: 0, samples: sample.samples === null ? null : 0};
        c.weight += sample.weight;
        if (sample.samples !== null) c.samples += sample.samples;
        row.callees.set(callee.name, c);
      }
    }
    if (!seen.size) unattributedWeight += sample.weight;
  }
  const pct = weight => totalWeight ? 100 * weight / totalWeight : 0;
  const list = [...rows.values()].map(row => {
    const topCallee = [...row.callees.values()].sort((a,b) => (b.samples ?? b.weight) - (a.samples ?? a.weight) || b.weight - a.weight || a.name.localeCompare(b.name))[0] ?? null;
    const {callees, ...rest} = row;
    return {...rest, flatPercent: pct(row.flatWeight), cumPercent: pct(row.cumWeight),
      calls: exactCalls(row, counts.counts ?? counts), topCallee};
  }).sort((a,b) => b.flatWeight - a.flatWeight || b.cumWeight - a.cumWeight || a.key.localeCompare(b.key))
    .map((row, i) => ({rank: i + 1, ...row}));
  return {schema: "osd-hitlist/v1", kind: "hitlist", metadata: {host: host ?? profile.format, commit: commit ?? symbols?.build ?? "unknown",
    identities: symbols ? "exact (symbol map)" : "decoded (lossy, no symbol map)",
    durationSeconds: profile.durationSeconds, format: profile.format, metric: profile.metric, tags,
    buildIds: profile.mappings?.map(m => m.buildId).filter(Boolean) ?? [],
    totalWeight, totalSamples: profile.samples.some(s => s.samples === null) ? null : totalSamples,
    unattributedWeight, unattributedPercent: pct(unattributedWeight)}, rows: list};
}

export function selectRows(report, {top = Infinity, minFlat = 0} = {}) {
  return {...report, rows: report.rows.filter(r => (r.flatPercent ?? Math.max(r.before?.flatPercent ?? 0, r.after?.flatPercent ?? 0)) >= minFlat).slice(0, top)};
}

export function diff(before, after) {
  if (before.schema !== "osd-hitlist/v1" || after.schema !== "osd-hitlist/v1") throw new Error("diff needs osd-hitlist/v1 inputs");
  // Share site IDs when both sides have them; fall back to ABAP identity when
  // only one host knows the site ID. Unshared site IDs fall back to ABAP identity.
  const beforeIds = new Set(before.rows.map(r => r.siteId).filter(Boolean));
  const afterIds = new Set(after.rows.map(r => r.siteId).filter(Boolean));
  const key = r => r.siteId && beforeIds.has(r.siteId) && afterIds.has(r.siteId) ? `site:${r.siteId}` : r.key;
  const map = new Map();
  for (const [side, report] of [["before", before], ["after", after]]) for (const row of report.rows) {
    const id = key(row), entry = map.get(id) ?? {key: row.key, siteId: row.siteId ?? null, before: null, after: null};
    if (entry[side]) throw new Error(`duplicate diff identity ${id}`);
    entry[side] = row; map.set(id, entry);
  }
  const compatible = Boolean(before.metadata.metric?.unit && before.metadata.metric?.type) && before.metadata.metric?.unit === after.metadata.metric?.unit && before.metadata.metric?.type === after.metadata.metric?.type;
  const rows = [...map.values()].map(r => ({...r,
    deltaFlatPercent: (r.after?.flatPercent ?? 0) - (r.before?.flatPercent ?? 0),
    deltaCumPercent: (r.after?.cumPercent ?? 0) - (r.before?.cumPercent ?? 0),
    deltaSamples: (r.before && r.before.samples == null) || (r.after && r.after.samples == null) ? null : (r.after?.samples ?? 0) - (r.before?.samples ?? 0),
    deltaCalls: r.before?.calls == null || r.after?.calls == null ? null : r.after.calls - r.before.calls,
    deltaFlatWeight: compatible && (!r.before || Number.isFinite(r.before.flatWeight)) && (!r.after || Number.isFinite(r.after.flatWeight)) ? (r.after?.flatWeight ?? 0) - (r.before?.flatWeight ?? 0) : null,
  })).sort((a,b) => Math.abs(b.deltaFlatPercent) - Math.abs(a.deltaFlatPercent) || a.key.localeCompare(b.key))
    .map((r,i) => ({rank: i + 1, ...r}));
  return {schema: "osd-hitlist/v1", kind: "diff", metadata: {before: before.metadata, after: after.metadata,
    comparableWeights: compatible}, rows};
}
