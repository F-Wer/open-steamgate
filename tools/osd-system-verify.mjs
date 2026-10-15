// Recheck the installed bytes once per build, including non-ABAP assets.
import {lstatSync, readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {treeDigest} from "./osd-oci.mjs";
import {layerDir, LAYER_ID} from "./osd-system.mjs";

export function verifySystem(root, system, log = () => {}) {
  if (!system) return undefined;
  const start = performance.now();
  let files = 0, bytes = 0;
  for (const layer of system.layers) {
    try {
      const entries = [];
      const walk = (path = "") => {
        const full = join(layerDir(root, layer), path), stat = lstatSync(full);
        if (stat.isDirectory()) {
          for (const name of readdirSync(full)) {
            if (!path && name === LAYER_ID) continue;
            walk(path ? `${path}/${name}` : name);
          }
        } else if (stat.isFile()) {
          const content = readFileSync(full);
          entries.push([path, content]);
          files++; bytes += content.length;
        } else throw new Error("nonregular entry");
      };
      walk();
      if (treeDigest(entries) !== layer.treeDigest) throw new Error("treeDigest differs");
    } catch (cause) {
      const error = new Error(`system layer ${layer.name} (${layer.kind}) was modified or is unreadable; run osd-fetch --system again`, {cause});
      error.code = "SYSTEM_MODIFIED";
      throw error;
    }
  }
  const ms = performance.now() - start;
  log(`system layers verified: ${system.layers.length} layers, ${files} files, ${bytes} bytes in ${ms.toFixed(1)} ms`);
  return {layers: system.layers.length, files, bytes, ms};
}
