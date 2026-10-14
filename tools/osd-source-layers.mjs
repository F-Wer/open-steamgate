import {activeSystem} from "./osd-system.mjs";
// Explicit user layers: folders retain their write policy; ZIPs are immutable
// content-named sources with a persistent writable overlay immediately above.
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, delimiter, dirname, join, relative, resolve} from 'node:path';
import {repositoryConfig, sourceFolder} from './osd-abapgit-config.mjs';
import {writable} from './osd-source-write-check.mjs';
import {archiveFiles} from './osd-source-zip.mjs';

const slash = p => p.replaceAll('\\', '/');
const folderOf = (root, dir) => slash(relative(root, dir)) || '.';
const textTag = (text, name) => new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(text)?.[1];
export function declaredPackage(folder) {
  const file = join(folder, 'package.devc.xml');
  if (!existsSync(file)) return undefined;
  const xml = readFileSync(file, 'utf8');
  return (textTag(xml, 'DEVCLASS') ?? textTag(xml, 'PACKAGE'))?.toUpperCase();
}
export function rootPackage(folder, fallback) {
  const named = declaredPackage(folder);
  if (named) return named;
  const devc = readdirSync(folder).sort().find(n => n !== 'package.devc.xml' && n.endsWith('.devc.xml'));
  if (devc) return devc.slice(0, -9).toUpperCase();
  // abapGit omits the root name: SAP asks the importing user. For a standalone
  // one-prefix repository use that prefix; ambiguous repositories need a setting.
  const names = readdirSync(folder).sort().filter(n => /\.(clas|intf|prog)\.(abap|xml)$/.test(n));
  const prefixes = new Set(names.map(n => /^(?:zcl_|zif_|z)?([a-z0-9]+)_/i.exec(n)?.[1]?.toUpperCase()).filter(Boolean));
  if (prefixes.size === 1) return '$Z' + [...prefixes][0];
  return fallback;
}
function materialize(root, archive) {
  const bytes = readFileSync(archive);
  const id = createHash('sha256').update(bytes).digest('hex');
  const base = join(root, 'build', 'source-layers');
  const target = join(base, id), marker = join(target, '.osd-source-id');
  if (!existsSync(marker)) {
    const files = archiveFiles(bytes); // verify the whole archive before extracting
    mkdirSync(base, {recursive: true});
    const stage = mkdtempSync(join(base, '.extract-'));
    try {
      for (const [name, content] of files) {
        const file = join(stage, name);
        mkdirSync(dirname(file), {recursive: true});
        writeFileSync(file, content);
      }
      if (!existsSync(join(stage, '.abapgit.xml'))) throw new Error('source ZIP has no root .abapgit.xml');
      const config = repositoryConfig(stage);
      if (!existsSync(sourceFolder(stage, config))) throw new Error('source ZIP starting folder does not exist');
      writeFileSync(join(stage, '.osd-source-id'), id + '\n');
      if (!existsSync(target)) renameSync(stage, target);
    } finally {
      rmSync(stage, {recursive: true, force: true});
    }
    for (const file of files.keys()) chmodSync(join(target, file), 0o444);
    chmodSync(marker, 0o444);
  }
  if (readFileSync(marker, 'utf8').trim() !== id) throw new Error(`source ZIP cache identity mismatch: ${target}`);
  return {dir: target, id};
}
export function userLayersOf(root, env = process.env) {
  if (activeSystem(root, env)) return [];
  const layers = [], mounts = {};
  for (const input of (env.OSD_LAYERS ?? '').split(delimiter).filter(Boolean)) {
    const archive = resolve(root, input);
    if (!existsSync(archive)) {
      if (/\.zip$/i.test(archive)) throw new Error(`source layer does not exist: ${archive}`);
      // Folder discovery has always allowed a not-yet-created writable root.
      // The CLI separately verifies --layer inputs before startup.
      layers.push({path: folderOf(root, archive), writable: true, library: false});
      continue;
    }
    const zipped = statSync(archive).isFile() && /\.zip$/i.test(archive);
    if (!zipped && !statSync(archive).isDirectory()) throw new Error(`layer is not a folder or ZIP: ${archive}`);
    const {dir, id} = zipped ? materialize(root, archive) : {dir: archive};
    const config = repositoryConfig(dir);
    const source = config.declared ? sourceFolder(dir, config) : dir;
    if (!existsSync(source)) throw new Error(`abapGit starting folder does not exist: ${source}`);
    const path = folderOf(root, source);
    const pkg = config.declared ? rootPackage(source, env.OSD_LAYER_PACKAGE ?? (zipped ? undefined : '$' + basename(dir).toUpperCase().replace(/[^A-Z0-9_]/g, '_'))) : undefined;
    if (config.declared && !pkg) throw new Error('unnamed abapGit root package is ambiguous; set OSD_LAYER_PACKAGE');
    const meta = config.declared ? {package: pkg, abapgit: config, imported: true} : {};
    if (!zipped) {
      layers.push({path, writable: true, library: false, ...meta});
      continue;
    }
    // Each archive revision owns its overlay. Reusing identical bytes also
    // reuses edits; replacing the base starts clean, preserving the old revision.
    const overlay = join('local', 'overlays', id);
    if (!writable(root, overlay, join(overlay, '.osd-overlay.txt'), true)) {
      throw new Error(`ZIP overlay is redirected through a link: ${overlay}`);
    }
    mkdirSync(join(root, overlay), {recursive: true});
    // Establish all warm-editable object inputs before hashing/priming, not
    // just package headers. A first save copies the COMPLETE object; adding
    // its source/XML/includes while startup prime is reading forces a retry
    // whose live-input proof cannot undo that new overlay topology. Copies
    // are independent (never hard links into the immutable base), and an
    // existing overlay file is always preserved, including inactive edits.
    const seedInputs = folder => {
      for (const entry of readdirSync(folder, {withFileTypes: true}).sort((left, right) => left.name.localeCompare(right.name))) {
        const from = join(folder, entry.name);
        if (entry.isDirectory()) seedInputs(from);
        else if (entry.name.endsWith('.devc.xml') || /\.(?:clas|intf)\./i.test(entry.name)) {
          const to = join(root, overlay, relative(source, from));
          if (!writable(root, overlay, relative(root, to), true)) throw new Error(`ZIP overlay input is redirected through a link: ${to}`);
          if (!existsSync(to)) {
            mkdirSync(dirname(to), {recursive: true});
            copyFileSync(from, to);
            chmodSync(to, 0o644);
          }
        }
      }
    };
    seedInputs(source);
    // Keep every configured revision, including simultaneous ZIPs of one package.
    (mounts[pkg] ??= []).push(id);
    const metadata = join(root, 'local/overlays', id + '.meta.txt');
    if (!existsSync(metadata)) writeFileSync(metadata, JSON.stringify({key: pkg, archiveId: id}));
    layers.push({path, writable: false, library: false, ...meta, archiveId: id, overlay});
    layers.push({path: overlay, writable: true, library: false, ...meta, overlayOf: path});
  }
  // Reconcile the complete configuration, dropping historical mounts.
  const mountsFile = join(root, 'local/overlays/.osd-mounts.txt');
  if (env.OSD_LAYER_DISCOVERY_ONLY !== "1" && existsSync(dirname(mountsFile))) {
    const content = JSON.stringify(mounts);
    if (!existsSync(mountsFile) || readFileSync(mountsFile, 'utf8') !== content) {
      const temp = mountsFile + `.${process.pid}.tmp`;
      writeFileSync(temp, content); renameSync(temp, mountsFile);
    }
  }
  return layers;
}
