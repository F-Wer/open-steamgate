// A resolved pack can refer only to directories inside its own layer.
import {OciError} from "./osd-oci.mjs";
export function validatePack(files, name) {
  const fail = message => { throw new OciError("BAD_PACK", message); };
  const entry = files.find(f => f.path === "osd-pack.json");
  if (!entry) fail("a pack layer needs osd-pack.json at its root");
  const pack = JSON.parse(entry.bytes);
  if (pack.name !== name || pack.sources !== undefined && (!Array.isArray(pack.sources) || pack.sources.length)) {
    fail("pack name must match --name and sources must be resolved and stripped");
  }
  for (const path of [pack.abap, pack.data, pack.ddic, pack.webapp].flat().filter(p => p !== undefined && p !== null && p !== false)) {
    if (typeof path !== "string" || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.split("/").includes("..")) fail(`pack folder escapes its layer: ${path}`);
  }
}
