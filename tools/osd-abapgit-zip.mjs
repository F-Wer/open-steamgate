// A folder of abapGit-named objects, as a zip abapGit will import.
//
//   node tools/osd-abapgit-zip.mjs <src/…/x.stg.yaml | folder> --out <file.zip>
//                                  [--unit <name>] [--manifest <file>]
//                                  [--data <dir>] [--description "…"]
//
// Only the objects the deploy unit lists in deploy/manifest.json go in, and
// never an SAP-owned name (tools/osd-deploy-manifest.mjs). The unit is the
// one whose `sources` name the input, or the one --unit names.
//
// Why this exists (Alice, 2026-09-19). The last mile of this project is
// "SEGW project offline -> abapGit -> a system", and it is the one arc of the
// README's loop that had never been walked. It stopped on a system with no
// abapGit installed: the three SEGW objects -- IWPR, IWSV, IWMO -- are not
// ADT object types, so nothing else can put them there, and abapGit's own
// standalone report would not activate on that release. So the machine route
// is blocked and the human one is not: a zip, imported by hand.
//
// The shape is the one `zcl_stg_segw_repo` writes, and deliberately so: the
// same repository whether it is built here in JavaScript or there in ABAP.
// `.abapgit.xml` with STARTING_FOLDER /src/ and FOLDER_LOGIC PREFIX, a
// `src/package.devc.xml`, and every object beside it.
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {basename, join, relative, resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {deflateRawSync} from "node:zlib";
import {compileFile} from "./stg-compile.mjs";
import {buildApp} from "./osd-bsp-app.mjs";
import {packAppName} from "./osd-bsp-registry.mjs";
import {runsAs} from "./osd-main.mjs";
import {deliveredAt} from "./osd-nodes.mjs";
import {exclusionsOf} from "./osd-store.mjs";
import {admit, isStructural, loadManifest, refusalMessage, refuseTmp, unitFor} from "./osd-deploy-manifest.mjs";

const BOM = "﻿";

export const abapgitXml = () => BOM +
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 <asx:values>
  <DATA>
   <MASTER_LANGUAGE>E</MASTER_LANGUAGE>
   <STARTING_FOLDER>/src/</STARTING_FOLDER>
   <FOLDER_LOGIC>PREFIX</FOLDER_LOGIC>
  </DATA>
 </asx:values>
</asx:abap>
`;

/** The package description. abapGit asks for the package at import time, so
 *  the name is NOT written here -- putting one in would be a claim about
 *  where it lands that the importer overrides anyway. */
export const devcXml = (description) => BOM +
  `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DEVC>
    <CTEXT>${String(description).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</CTEXT>
   </DEVC>
  </asx:values>
 </asx:abap>
</abapGit>
`;

/** Lay the repository out under `into`, and say what went in.
 *
 *  Reports the objects by name rather than counting files, because one object
 *  is two files (source and XML) and "13 files" tells a reader nothing about
 *  whether the thing they wanted is there. */
/** Table contents, in abapGit's own shape.
 *
 *  It carries them: `zif_abapgit_data_config` names `/data/` as the folder,
 *  `TABU` as the type and json as the format, and
 *  `zcl_abapgit_data_utils=>build_data_filename` writes
 *  `<table>.<type>.json` in lower case. Our `data/*.tabu.json` is that
 *  format already -- CLAUDE.md calls it "abapGit TABU JSON" and it is not a
 *  name we invented.
 *
 *  **A `.tabu.json` without its `.conf.json` is not carried.** The config
 *  says which tables to serialise and with what condition; without it
 *  abapGit has rows and no instruction to take them. So this copies pairs,
 *  and says which ones it could not pair rather than shipping half.
 */
// The client column does not travel, so a row written for another client
// must not either. abapGit deserialises a client-dependent table into the
// **logon client**: our seed says MANDT 123 for the real rows and 001 for
// `T0009 / "Other client, must not leak"`, which exists to prove this
// runtime does not serve another client's rows. On A4H all four arrived as
// MANDT 001, so the fixture did not leak -- it was *moved*, and a demo on a
// real system answered a row labelled "must not leak" (2026-09-19).
//
// It is a fixture for a property of this runtime and it has no meaning on a
// system that decides the client itself, so it stays here. The rule is the
// general one and not a name: a row whose client is not the client the file
// is written for is dropped, and the count is printed, because a package
// that quietly carries fewer rows than the folder is its own trap.
export function withoutOtherClients(rows) {
  const client = (r) => String(r?.MANDT ?? r?.mandt ?? "");
  const clients = rows.map(client).filter((c) => c !== "");
  if (clients.length === 0) {
    return {rows, dropped: 0, client: ""};
  }
  const count = new Map();
  for (const c of clients) count.set(c, (count.get(c) ?? 0) + 1);
  const [own] = [...count].sort((a, b) => b[1] - a[1])[0];
  const kept = rows.filter((r) => client(r) === "" || client(r) === own);
  return {rows: kept, dropped: rows.length - kept.length, client: own};
}

/** The tables whose rows `dataFiles` would carry: a `.tabu.json` with its
 *  `.conf.json` beside it. Read before anything is copied, so the manifest
 *  can refuse a table's rows the same way it refuses an object. */
export function dataTables(from) {
  if (from === undefined || !existsSync(from)) return [];
  const files = readdirSync(from);
  return files.filter((f) => f.endsWith(".tabu.json") && files.includes(f.replace(/\.tabu\.json$/, ".conf.json")))
    .map((f) => f.replace(/\.tabu\.json$/, "")).sort();
}

export function dataFiles(from, into) {
  if (!existsSync(from)) return {carried: [], unpaired: [], dropped: []};
  const files = readdirSync(from);
  const carried = [];
  const unpaired = [];
  const dropped = [];
  for (const f of files.filter((x) => x.endsWith(".tabu.json"))) {
    const conf = f.replace(/\.tabu\.json$/, ".conf.json");
    if (!files.includes(conf)) { unpaired.push(f); continue; }
    mkdirSync(join(into, "data"), {recursive: true});
    // abapGit's TABU JSON is a plain array of rows, lower-case keys
    const table = JSON.parse(readFileSync(join(from, f), "utf8"));
    if (Array.isArray(table) === false) {
      cpSync(join(from, f), join(into, "data", f));
    } else {
      const out = withoutOtherClients(table);
      if (out.dropped > 0) dropped.push(`${f.replace(/\.tabu\.json$/, "")}: ${out.dropped} row(s) not in client ${out.client}`);
      writeFileSync(join(into, "data", f), JSON.stringify(out.rows, undefined, 2) + "\n");
    }
    cpSync(join(from, conf), join(into, "data", conf));
    carried.push(f.replace(/\.tabu\.json$/, ""));
  }
  return {carried, unpaired, dropped};
}

/** A file beside the ABAP that is not an object of the system -- a SEGW
 *  model (compiled here, not copied), a DSL L2 rule, a lift trace, the SAMC
 *  model and declaration a DSL renders the XML from -- never goes into the
 *  zip. The list is abap_transpile.json's `not_in_system`, the one the object
 *  store reads, so the build, the store and the zip cannot disagree. */
function notAnObject(root = process.env.OSD_ROOT ?? process.cwd()) {
  if (!existsSync(join(root, "abap_transpile.json"))) {
    // said, not swallowed: without the list a sidecar is refused as an object
    console.error(`osd-abapgit-zip: no abap_transpile.json in ${root} (set OSD_ROOT): sidecars are not skipped`);
  }
  const excluded = exclusionsOf(root);
  return (file) => excluded.some((re) => re.test(file.replaceAll("\\", "/")));
}

function filesUnder(root, at = root) {
  if (!existsSync(at)) return [];
  return readdirSync(at).sort().flatMap((name) => {
    const full = join(at, name);
    return statSync(full).isDirectory() ? filesUnder(root, full) : [full];
  });
}

const packManifest = (dir) => join(dir, "osd-pack.json");

/** Turn a content pack into the one flat object folder `layout()` consumes.
 *
 * Generated SEGW objects are written first. Authored objects are copied
 * afterwards, by abapGit filename, so a maintained `_DPC_EXT` (or any other
 * authored object) wins over the generator's initial version. A pack's
 * webapp is not copied as loose files: it is serialized as the WAPA + SICF
 * pair a real system imports, using the same builder as `osd-bsp-app`.
 */
export function preparePack(dir, out) {
  const root = resolve(dir);
  const manifestFile = packManifest(root);
  if (!existsSync(manifestFile)) throw new Error(`${dir} is not a pack: osd-pack.json is missing`);
  const declared = JSON.parse(readFileSync(manifestFile, "utf8"));
  const name = String(declared.name ?? basename(root)).toLowerCase();
  const abap = [declared.abap ?? "src"].flat().map((folder) => resolve(root, folder));

  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});

  const compiled = [];
  for (const model of abap.flatMap((folder) => filesUnder(folder)).filter((file) => file.endsWith(".stg.yaml"))) {
    compiled.push(compileFile(model, out));
  }

  // Flatten authored source exactly as abapGit's PREFIX layout requires.
  // The copy happens after compilation deliberately: authored files win.
  const sidecar = notAnObject();
  for (const folder of abap) {
    for (const file of filesUnder(folder)) {
      // read inside the pack, so a pack that itself lives under a folder
      // of the list (a test fixture) still has its objects
      if (file.endsWith(".stg.yaml") || sidecar(`/${relative(root, file)}`)) continue;
      cpSync(file, join(out, basename(file)));
    }
  }

  const webapp = resolve(root, declared.webapp ?? "webapp");
  if (existsSync(webapp)) {
    const app = packAppName(name);
    buildApp({
      from: webapp,
      app,
      out,
      text: String(declared.description ?? `pack ${name}`),
    });
  }

  const data = resolve(root, declared.data ?? "data");
  return {
    objects: out,
    data: existsSync(data) ? data : undefined,
    models: compiled.map((result) => ({project: result.model.project, service: result.model.service})),
  };
}


/** `unit` is the deploy unit of `deploy/manifest.json` this folder is
 *  (`unitFor`); without one nothing may go, because nothing is listed. */
export function layout(from, into, description, data, unit) {
  // fail closed on $TMP before anything is written (tools/osd-tmp.mjs)
  refuseTmp(resolve(process.env.OSD_ROOT ?? process.cwd()), resolve(from));
  rmSync(into, {recursive: true, force: true});
  mkdirSync(join(into, "src"), {recursive: true});
  writeFileSync(join(into, ".abapgit.xml"), abapgitXml());
  writeFileSync(join(into, "src", "package.devc.xml"), devcXml(description));

  // Flat, and it says so. abapGit with FOLDER_LOGIC PREFIX reads a
  // subdirectory of src/ as a sub-package, so a folder here would put the
  // DDIC in a package of its own -- and the objects are meant to land in
  // one. What this used to do instead was drop every subdirectory without a
  // word: a build that nested src/ddic/ produced a zip with no tables in it
  // and printed "23 files" over the hole (2026-09-19).
  const entries = readdirSync(from);
  const nested = entries.filter((f) => statSync(join(from, f)).isDirectory());
  if (nested.length > 0) {
    throw new Error(`${from} has ${nested.length} subdirector${nested.length === 1 ? "y" : "ies"} (${nested.join(", ")}). `
      + "abapGit reads one as a sub-package and this zip puts every object in one package, so flatten them into the folder.");
  }
  const sidecar = notAnObject();
  const all = entries.filter((f) => statSync(join(from, f)).isFile() && !sidecar(f));
  // **A node that would replace a system's own does not go in the zip.**
  //
  // `SAP_DELIVERED` in tools/osd-nodes.mjs names the paths a real system
  // delivers -- the ITS WebGUI and its sapevent, measured against abapGit's
  // own deserialize -- and a `*.sicf.xml` of ours on one of them is an
  // object that, imported, takes that service away from the system. Until
  // now that fact was an annotation two tools read and no packaging path
  // did: this one copied every file of the folder, so `segw:zip src/webgui`
  // carried the WebGUI node verbatim. An adversarial review found it, and
  // "it is written down in the inventory" is not a gate.
  //
  // Refused rather than dropped quietly: a zip missing an object somebody
  // put in the folder is the shape of defect this same function already
  // shouts about one paragraph above.
  const files = [];
  const refused = [];
  for (const f of all) {
    const url = f.endsWith(".sicf.xml")
      ? /<URL>([^<]*)/.exec(readFileSync(join(from, f), "utf8"))?.[1]?.replace(/\/+$/, "")
      : undefined;
    const delivered = url === undefined ? undefined : deliveredAt(url);
    if (delivered !== undefined) {
      refused.push({file: f, url, why: delivered});
      continue;
    }
    files.push(f);
  }
  if (refused.length > 0) {
    throw new Error(`${from} carries ${refused.length} ICF node(s) a real system delivers itself:\n`
      + refused.map((r) => `  ${r.file}  ${r.url}\n    ${r.why}`).join("\n")
      + `\nImporting one would replace that system's own handler. Move them out of the folder this zip is built `
      + `from, or build the zip from a folder that does not contain them.`);
  }
  // **Only what the deploy unit lists, and never an SAP-owned name.** The
  // check above is a blocklist of one kind of object; this one is the
  // allowlist, and it is the only real guarantee that a reimplemented
  // CL_/IF_/CX_, an /IWBEP/ or /UI2/ stand-in, or anything in a foreign
  // namespace does not reach a system (osd-deploy-manifest.mjs says why).
  const refusedByManifest = admit({
    files, read: (f) => readFileSync(join(from, f), "utf8"), tables: dataTables(data), unit,
  });
  if (refusedByManifest.length > 0) throw new Error(refusalMessage(from, refusedByManifest));
  // the folder's own package.devc.xml is not copied over the one written
  // above: the package is named at import and described by --description
  for (const f of files.filter((x) => !isStructural(x))) cpSync(join(from, f), join(into, "src", f));

  // an object is its name up to the first dot; `zstg_demo_srv    0001.iwsv.xml`
  // keeps its spaces, which is how abapGit names an IWSV and is not a mistake
  const objects = new Map();
  for (const f of files.filter((x) => !isStructural(x))) {
    const m = /^(.+?)\.([a-z0-9]+)\./i.exec(f);
    if (m === null) continue;
    const type = m[2].toUpperCase();
    if (!objects.has(type)) objects.set(type, new Set());
    objects.get(type).add(m[1].trim());
  }
  const rows = data === undefined ? {carried: [], unpaired: []} : dataFiles(data, into);
  return {files: files.filter((x) => !isStructural(x)).length + 2 + rows.carried.length * 2, objects, rows};
}

export function zip(dir, out) {
  rmSync(out, {force: true});
  // -X drops the extra file attributes: the zip is then the same bytes for
  // the same content, which is what makes "did anything change" answerable
  execFileSync("zip", ["-r", "-X", "-q", resolve(out), ".abapgit.xml", "src",
    ...(existsSync(join(dir, "data")) ? ["data"] : [])], {cwd: dir});
  return statSync(out).size;
}

/** The same repository as `zip()`, built in this process instead of by the
 *  `zip` binary: deflated entries, files only (no directory entries), sorted
 *  paths, a fixed 1980-01-01 timestamp, so the same content gives the same
 *  bytes. Added for tools/osd-prove-on-system.mjs, whose critic ran in a
 *  sandbox that may not spawn `zip` (EPERM); `zip()` and the CLI are
 *  unchanged. cl_abap_zip, which abapGit's zcl_abapgit_zip=>load uses,
 *  reads deflate (method 8). */
// CRC-32 by hand rather than zlib.crc32, which is Node >= 20.15/22.2 only
// and not something every host this tool is bundled into is known to have
let CRC_TABLE;
function crc32(buf) {
  if (CRC_TABLE === undefined) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipInProcess(dir) {
  const roots = [".abapgit.xml", "src", "data"].filter((p) => existsSync(join(dir, p)));
  const paths = [];
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (statSync(abs).isDirectory()) {
      for (const e of readdirSync(abs).sort()) walk(`${rel}/${e}`);
    } else {
      paths.push(rel);
    }
  };
  for (const r of roots) walk(r);
  paths.sort();
  return zipFiles(paths.map((path) => ({path, bytes: readFileSync(join(dir, path))})), {level: 6});
}

/** Deterministic ZIP over a sorted list of files, shared with OCI layers. */
export function zipFiles(files, {level = 9, method = 8} = {}) {
  if (![0, 8].includes(method)) throw new Error("unsupported ZIP method");
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const {path: p, bytes: data} of files) {
    const packed = method === 0 ? data : deflateRawSync(data, {level});
    const name = Buffer.from(p, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    centrals.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

if (runsAs("osd-abapgit-zip.mjs")) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const input = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
  if (input === undefined) {
    console.error("usage: osd-abapgit-zip.mjs <x.stg.yaml | folder> --out <file.zip> [--unit <deploy unit>] [--manifest <file>] [--data <dir>] [--description …]");
    process.exit(2);
  }
  const out = flag("out", "repo.zip");
  const staging = `${out}.dir`;

  // the unit first: a zip nothing lists fails before anything is compiled
  let unit;
  try {
    unit = unitFor(loadManifest(flag("manifest")), input, flag("unit"));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  let objects = input;
  let data = flag("data") ?? unit.data;
  if (input.endsWith(".stg.yaml")) {
    // a library call and not a spawn: test/osd-binary.mjs forbids starting
    // another tool by process.execPath and a script path, because in a
    // compiled binary there is no script beside the executable
    objects = `${out}.objects`;
    compileFile(input, objects);
  } else if (existsSync(packManifest(input))) {
    objects = `${out}.objects`;
    const prepared = preparePack(input, objects);
    data = data ?? prepared.data;
  } else if (!existsSync(input)) {
    console.error(`no such folder: ${input}`);
    process.exit(2);
  }

  const description = flag("description", `open-steamgate: ${basename(input).replace(/\..*$/, "")}`);
  let laid;
  try {
    laid = layout(objects, staging, description, data, unit);
  } catch (e) {
    rmSync(staging, {recursive: true, force: true});
    if (objects !== input) rmSync(objects, {recursive: true, force: true});
    console.error(e.message);
    process.exit(1);
  }
  const {files, objects: found, rows} = laid;
  const size = zip(staging, out);
  rmSync(staging, {recursive: true, force: true});
  if (objects !== input) rmSync(objects, {recursive: true, force: true});

  console.log(`${out}: ${files} files, ${(size / 1024).toFixed(1)} KB, deploy unit "${unit.name}"`);
  for (const [type, names] of [...found].sort()) {
    console.log(`  ${type.padEnd(5)} ${[...names].sort().join(", ")}`);
  }
  if (rows?.carried.length > 0) console.log(`  DATA  ${rows.carried.sort().join(", ")}`);
  for (const d of rows?.dropped ?? []) {
    console.log(`  NOT carried: ${d} -- abapGit deserialises into the logon client, so another client's row would arrive as this one's`);
  }
  for (const u of rows?.unpaired ?? []) {
    console.log(`  NOT carried: ${u} has no .conf.json, so abapGit has rows and no instruction to take them`);
  }
  console.log(`\nImport it in abapGit: "New Online/Offline" -> Offline -> pick the zip,`);
  console.log(`then give it the package. The zip does not name one, so nothing here`);
  console.log(`decides where it lands.`);
}
