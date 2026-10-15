// Source-only analyses, keyed by the immutable parsed/rearranged node.
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {parseSamc} from "../osd-samc.ts";

const trees = new WeakMap();
const inlineTables = new WeakMap();
export function rearrangedClass(node, Rearranger) {
  if (!trees.has(node)) trees.set(node, new Rearranger().run("CLAS", node));
  return trees.get(node);
}

export function inlineTableLocals(body) {
  if (!body) return new Set();
  if (!inlineTables.has(body)) {
    // Keep the old token-text recognition (including refused statements),
    // but join and search once per method instead of once per local.
    const names = [...body.concatTokens().matchAll(/\bINTO\s+TABLE\s+@DATA\s*\(\s*(\w+)\s*\)/gi)].map((m) => m[1].toUpperCase());
    inlineTables.set(body, new Set(names));
  }
  return inlineTables.get(body);
}

// The later folder wins each AMC channel name, as the runtime layers do.
export function samcOf(folders) {
  const byName = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.toLowerCase().endsWith(".samc.xml")) byName.set(e.name.toUpperCase(), join(dir, e.name));
    }
  };
  for (const f of folders) walk(f);
  const rows = [...byName.values()].flatMap((file) => parseSamc(readFileSync(file, "utf8"), file));
  return [...new Map(rows.map((r) => [`${r.applicationId}|${r.path}`, r])).values()];
}

// A CDS view entity has no SQL view name and is left out.
export function cdsSqlViews(sources) {
  const out = {};
  for (const src of sources) {
    const sql = /@AbapCatalog\.sqlViewName\s*:\s*'([^']+)'/i.exec(src)?.[1];
    const cds = /\bdefine\s+(?:root\s+)?view\s+(?!entity\b)([\w\/]+)/i.exec(src)?.[1];
    if (sql && cds) out[cds.toUpperCase()] = sql.toUpperCase();
  }
  return out;
}
