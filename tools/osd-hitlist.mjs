#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {readFileSync, writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {parsePprof} from "./hitlist/pprof.mjs";
import {parseV8} from "./hitlist/v8.mjs";
import {diff, hitlist, selectRows} from "./hitlist/hitlist.mjs";
import {markdown} from "./hitlist/markdown.mjs";

const json = file => JSON.parse(readFileSync(file, "utf8"));
export function readProfile(file) {
  const buf = readFileSync(file);
  if (/^[\s]*[\[{]/.test(buf.subarray(0, 64).toString())) {
    const p = JSON.parse(buf.toString());
    if (p.schema === "osd-hitlist/v1") {
      if (p.kind !== "hitlist" || !p.metadata || !Array.isArray(p.rows)) throw new Error("input must be a hit list, not a diff");
      for (const r of p.rows) {
        if (typeof r.key !== "string" || !Number.isFinite(r.flatPercent) || !Number.isFinite(r.cumPercent)) throw new Error("invalid hit-list row");
      }
      return p;
    }
    return parseV8(p);
  }
  return parsePprof(buf);
}
export function run(args) {
  const {values: v, positionals} = parseArgs({args, allowPositionals: true, options: {
    names: {type: "string"}, counts: {type: "string"}, tag: {type: "string", multiple: true},
    top: {type: "string"}, "min-flat": {type: "string"}, format: {type: "string", default: "markdown"},
    host: {type: "string"}, commit: {type: "string"}, out: {type: "string"}, diff: {type: "boolean"},
    help: {type: "boolean"},
  }});
  if (v.help) return "Usage: node tools/osd-hitlist.mjs [--diff] PROFILE [AFTER] [--names names.json] [--counts counts.json] [--tag key=value] [--top N] [--min-flat PERCENT] [--host HOST] [--commit SHA] [--format markdown|json] [--out FILE]\n";
  const isDiff = v.diff || positionals.length === 2;
  if (positionals.length !== (isDiff ? 2 : 1)) throw new Error("supply one profile, or two for --diff");
  if (!["markdown", "json"].includes(v.format)) throw new Error("--format must be markdown or json");
  const top = v.top === undefined ? Infinity : Number(v.top), minFlat = Number(v["min-flat"] ?? 0);
  if ((top !== Infinity && (!Number.isSafeInteger(top) || top < 1)) || v.top === "Infinity") throw new Error("--top must be a positive integer");
  if (!Number.isFinite(minFlat) || minFlat < 0 || minFlat > 100) throw new Error("--min-flat must be between 0 and 100");
  const options = {tags: v.tag ?? [], names: v.names ? json(v.names) : {}, counts: v.counts ? json(v.counts) : {}, host: v.host, commit: v.commit};
  const reports = positionals.map(file => {
    const p = readProfile(file);
    if (p.schema === "osd-hitlist/v1") {
      if (v.tag?.length || v.names || v.counts) throw new Error("--tag/--names/--counts require raw profiles; convert each input first");
      return p;
    }
    return hitlist(p, options);
  });
  const report = selectRows(isDiff ? diff(...reports) : reports[0], {top, minFlat});
  const text = v.format === "json" ? JSON.stringify(report, null, 2) + "\n" : markdown(report);
  if (v.out) {writeFileSync(v.out, text); return "";}
  return text;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(run(process.argv.slice(2)));}
  catch (e) {console.error(`osd-hitlist: ${e.message}`); process.exitCode = 1;}
}
