#!/usr/bin/env node
// Dev proof only: all registry traffic stays in the in-process loopback fixture.
import {spawn, execFileSync} from "node:child_process";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {registry, listening} from "../test/helpers/oci-registry.mjs";
import {build} from "../tools/osd-layer.mjs";
import {MEDIA, push, pushManifest, sha256} from "../tools/osd-oci.mjs";
import {fetchSystem} from "../tools/osd-system-fetch.mjs";
import {packsOf} from "../tools/osd-packs.mjs";
import {readLock} from "../tools/osd-lock.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";
import {abapgitXml} from "../tools/osd-abapgit-zip.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now(), temp = mkdtempSync(join(process.env.OSD_ROUNDTRIP_DIR ?? tmpdir(), "system-roundtrip-"));
const log = message => console.log(`system-roundtrip: ${message}`);
const run = (cwd, args) => new Promise((done, reject) => {
  const child = spawn(process.execPath, args, {cwd, env: {...process.env, OSD_ROOT: cwd}, stdio: ["ignore", "pipe", "pipe"]});
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  child.on("error", reject); child.on("close", code => {
    writeFileSync(join(temp, `${cwd === root ? "normal" : "scratch"}-${args.at(-1).split("/").at(-1)}.log`), output);
    if (code !== 0) reject(new Error(`exit ${code}: ${args.join(" ")}\n${output.slice(-6000)}`)); else done(output);
  });
});
const tree = folder => {
  const files = new Map();
  const walk = (at, rel = "") => {
    for (const entry of readdirSync(at, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), path);
      else files.set(path, sha256(readFileSync(join(at, entry.name))));
    }
  }; walk(folder); return files;
};
let r;
try {
  log(`logs and scratch: ${temp}`);
  if (!existsSync(join(root, ".local/lars"))) await run(root, ["tools/osd-libs.mjs", "--sync"]);
  await run(root, ["tools/osd-fetch.mjs"]);
  r = registry(); const host = await listening(r), target = `${host}/proof/system`;
  const layers = [];
  const add = async (folder, name, kind) => {
    const l = build(folder, {name, kind});
    const digest = await push(`${target}:${name}`, l);
    layers.push({name, kind, digest, size: l.manifestBytes.length, zipBytes: l.zip.length, files: l.files.length});
    log(`${kind} ${name}: ${l.files.length} files, ${l.zip.length} bytes`);
  };
  for (const lib of readLock(root).libraries) await add(realpathSync(libraryPath(root, lib.folder)), lib.folder, "lib");
  // The src layer is a repository with src/ and the tree's seed rows/pages.
  const own = join(temp, "own"); mkdirSync(own);
  for (const folder of ["src", "data", "webapp"]) if (existsSync(join(root, folder))) cpSync(join(root, folder), join(own, folder), {recursive: true});
  writeFileSync(join(own, ".abapgit.xml"), abapgitXml());
  await add(own, "src", "input");
  await add(join(root, "test"), "test", "input");
  for (const pack of packsOf(root)) {
    if (pack.missing.length) throw new Error(`unfetched pack: ${pack.name}`);
    const folder = join(temp, "resolved-packs", pack.name);
    cpSync(pack.dir, folder, {recursive: true, filter: path => ![".osd-source.json", ".osd-fetched.json"].includes(path.split("/").at(-1))});
    const declared = JSON.parse(readFileSync(join(folder, "osd-pack.json")));
    // Preserve fetched folders, including sources not listed in the ABAP projection.
    delete declared.sources;
    writeFileSync(join(folder, "osd-pack.json"), JSON.stringify(declared, null, 2) + "\n");
    await add(folder, pack.name, "pack");
  }
  const lock = readLock(root), index = {schemaVersion: 2, mediaType: MEDIA.index, artifactType: "application/vnd.osd.system.v1",
    manifests: layers.map((l, order) => ({mediaType: MEDIA.manifest, digest: l.digest, size: l.size,
      annotations: {"org.osd.layer.name": l.name, "org.osd.layer.kind": l.kind, "org.osd.layer.order": String(order)}})),
    annotations: {"org.osd.osg.commit": execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim(), "org.osd.transpiler": `${lock.transpiler.repo}@${lock.transpiler.ref}`}};
  // Low-level upload is intentional: this dev fixture exercises installation,
  // including repository-allowed pack vectors. Real publication uses the leak gate.
  const digest = await pushManifest(`${target}:v1`, Buffer.from(JSON.stringify(index)));
  const scratch = join(temp, "scratch"); mkdirSync(scratch);
  const archive = join(temp, "checkout.tar");
  execFileSync("git", ["archive", "HEAD", "-o", archive], {cwd: root});
  execFileSync("tar", ["-xf", archive, "-C", scratch, "--exclude=src", "--exclude=packs", "--exclude=data", "--exclude=webapp", "--exclude=gen"]);
  // Overlay the current implementation, so a pre-commit proof tests the changes.
  for (const folder of ["tools", "scripts", "test"]) cpSync(join(root, folder), join(scratch, folder), {recursive: true});
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  if (existsSync(join(root, ".local/transpiler.json"))) {
    mkdirSync(join(scratch, ".local"), {recursive: true}); cpSync(join(root, ".local/transpiler.json"), join(scratch, ".local/transpiler.json"));
  }
  await fetchSystem(scratch, `${target}@${digest}`, {log});
  log("building normal checkout");
  await run(root, ["tools/osd-build.mjs"]);
  log("building scratch from system digest");
  const scratchLog = await run(scratch, ["tools/osd-build.mjs"]);
  const verified = /system layers verified: (\d+) layers, (\d+) files, (\d+) bytes in ([\d.]+) ms/.exec(scratchLog);
  if (!verified) throw new Error("scratch build did not report installed layer verification");
  const layerVerification = {layers: Number(verified[1]), files: Number(verified[2]), bytes: Number(verified[3]), ms: Number(verified[4])};
  const normal = tree(join(root, "output")), installed = tree(join(scratch, "output"));
  const differences = [...new Set([...normal.keys(), ...installed.keys()])].sort().filter(p => normal.get(p) !== installed.get(p));
  const objects = cwd => JSON.parse(readFileSync(join(cwd, "build/live/manifest.json"))).objects;
  const sameObjects = objects(root) === objects(scratch);
  const report = {digest, layers: layers.length, zipBytes: layers.reduce((n,l) => n + l.zipBytes, 0), layerSizes: layers,
    objects: {normal: objects(root), system: objects(scratch)}, outputFiles: {normal: normal.size, system: installed.size},
    identical: differences.length === 0 && sameObjects, differences, layerVerification, ms: Date.now() - started, scratch};
  writeFileSync(join(temp, "report.json"), JSON.stringify(report, null, 2) + "\n");
  log(JSON.stringify(report, null, 2));
  if (!report.identical) process.exitCode = 1;
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally { if (r) await new Promise(done => r.server.close(done)); }
