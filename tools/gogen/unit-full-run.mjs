import {append} from "./append.ts";
// Re-run the binaries of an isolated full inventory, one owner at a time.
// Only classes with a built binary enter this measurement; the inventory
// JSON names every skipped class and method.
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {home} from "./home.mjs";

const args = process.argv.slice(2);
const plan = JSON.parse(readFileSync(args[0] ?? join(home, ".local", "gogen-unit-full.json"), "utf8"));
const dirs = new Set(plan.rows.map((r) => r.class.toLowerCase()));
const rows = [];
let binaries = 0;
for (const owner of dirs) {
  const bin = join(home, "tools", "gogen", ".out", "unit", owner, "unit");
  if (!existsSync(bin)) continue;
  const result = spawnSync(bin, [], {encoding: "utf8", timeout: 120000, maxBuffer: 20e6});
  if (result.status !== 0) throw new Error(`${owner} binary failed: ${result.stderr || result.error?.message}`);
  binaries++;
  append(rows, JSON.parse(result.stdout));
}
console.log(JSON.stringify({binaries, methods: rows.length, success: rows.filter((r) => r.status === "SUCCESS").length,
  failed: rows.filter((r) => r.status === "FAILED").length}));
