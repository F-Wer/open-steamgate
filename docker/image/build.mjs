import {execFileSync} from "node:child_process";
import {readFileSync, mkdirSync, existsSync, chmodSync} from "node:fs";
import {resolve} from "node:path";
import {imagePacks} from "./packs.mjs";

const selectedPacks = imagePacks(process.cwd(), process.env.OSD_IMAGE_PACKS ?? "");
process.env.OSD_WEB_PACKS = selectedPacks.map((pack) => pack.name).join(",");

const sources = JSON.parse(readFileSync("docker/image/sources.json", "utf8"));
const lock = JSON.parse(readFileSync("libs.lock.json", "utf8"));
const libraries = new Map(lock.libraries.map((source) => [source.folder, source]));
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, {cwd, stdio: "inherit"});
function checkout(source, folder) {
  if (existsSync(folder)) throw new Error(`Build requires a fresh source folder: ${folder}`);
  mkdirSync(folder, {recursive: true});
  run("git", ["init", "--quiet", folder]);
  run("git", ["-C", folder, "remote", "add", "origin", `https://github.com/${source.repo}.git`]);
  run("git", ["-C", folder, "fetch", "--depth", "1", "origin", source.ref]);
  run("git", ["-C", folder, "checkout", "--detach", "FETCH_HEAD"]);
  const actual = execFileSync("git", ["-C", folder, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  if (actual !== source.ref) throw new Error(`Source revision mismatch: ${source.repo}`);
}
checkout(lock.transpiler, "../transpiler");
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], resolve("../transpiler"));
for (const name of ["runtime", "transpiler", "cli"]) {
  run("npm", ["install", "--no-audit", "--no-fund"], resolve(`../transpiler/packages/${name}`));
}
for (const name of ["runtime", "transpiler", "cli"]) {
  run("npm", ["run", "compile"], resolve(`../transpiler/packages/${name}`));
}
chmodSync("../transpiler/packages/cli/abap_transpile", 0o755);
for (const [name, path] of [
  ["runtime", "packages/runtime"],
  ["transpiler", "packages/transpiler"],
  ["transpiler-cli", "packages/cli"],
  ["core", "packages/transpiler/node_modules/@abaplint/core"],
]) {
  run("node", ["tools/osd-link.mjs", name, path]);
}
for (const source of sources.libraries) {
  const pin = libraries.get(source.folder);
  if (pin === undefined) throw new Error(`No libs.lock.json entry for ${source.folder}`);
  checkout(pin, `.local/lars/${source.folder}`);
}
// Fetch only the selected pinned pack sources. The empty default remains the
// small core image; adding packs changes the compiled generation.
if (selectedPacks.length) run("node", ["tools/osd-fetch.mjs"]);
// a published image: $TMP is left out (tools/osd-tmp.mjs)
run("node", ["tools/osd-build.mjs", "--publish"]);
run("node", ["docker/image/assemble.mjs", "/image"]);
