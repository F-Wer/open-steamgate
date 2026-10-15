#!/usr/bin/env node
// Inspect either current resolved artifacts or dependency snapshots saved on disk.
import {createHash} from "node:crypto";
import {readFileSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {deserialize} from "node:v8";
import {inflateRawSync} from "node:zlib";
import {pathToFileURL} from "node:url";
import {expandDependencyMetadata} from "./frontend-provenance-metadata.mjs";
import {artifactDigestsOf, artifactDigestStats} from "./frontend-artifact-digests.mjs";

export function cacheDigestMetadata(root, name) {
  const found = [];
  for (const version of readdirSync(root).filter((n) => /^[a-f0-9]{64}$/.test(n)).sort()) {
    for (const file of readdirSync(join(root, version)).filter((n) => n.endsWith(".bin")).sort()) {
      try {
        const bytes = readFileSync(join(root, version, file)), payload = bytes.subarray(65);
        if (bytes.subarray(0, 64).toString() !== createHash("sha256").update(payload).digest("hex")) continue;
        const entry = deserialize(inflateRawSync(payload));
        if (entry.metadata?.graph) {
          const graphBytes = readFileSync(join(root, version, `${entry.metadata.graph}.provenance`));
          if (createHash("sha256").update(graphBytes).digest("hex") !== entry.metadata.graph) continue;
          entry.metadata = expandDependencyMetadata(entry.metadata, deserialize(inflateRawSync(graphBytes)));
        }
        if (entry.value.name === name.toUpperCase() || entry.metadata?.owner === name.toUpperCase())
          found.push({version, file, ...(entry.metadata ?? {entry: entry.value.name, unavailable: "provenance recording was off or entry predates digest metadata"})});
      } catch { /* Same corruption/missing-entry fallback as compilation. */ }
    }
  }
  return found;
}
async function main() {
  const args = process.argv.slice(2), folders = [], objects = [];
  let show, cacheDir, entry;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--show") show = args.shift();
    else if (arg === "--cache-dir") cacheDir = args.shift();
    else if (arg === "--entry") entry = args.shift();
    else if (arg === "--objects") {
      while (args.length && !args[0].startsWith("--")) objects.push(...args.shift().split(","));
    } else folders.push(arg);
  }
  if (cacheDir && entry) {
    const entries = cacheDigestMetadata(resolve(cacheDir), entry);
    if (!entries.length) throw new Error(`no cache entry: ${entry}`);
    console.log(JSON.stringify(entries, null, 2)); return;
  }
  if (!folders.length) throw new Error("usage: frontend-artifact-digests-cli.mjs <folders...> [--objects names] [--show 'TYPE NAME'] | --cache-dir dir --entry name");
  const {compileProgram} = await import("./frontend.mjs");
  const program = compileProgram({folders, objects, tolerant: true});
  const digests = [...artifactDigestsOf(program)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (show && !digests.some(([k]) => k === show.toUpperCase())) throw new Error(`unknown artifact: ${show}`);
  console.log(JSON.stringify({digests: Object.fromEntries(show ? digests.filter(([k]) => k === show.toUpperCase()) : digests),
    stats: artifactDigestStats(program)}, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
