// Controlled replay seam: real core global definition, independent reader owner.
// Normal lowering qualifies local definitions by owner and cannot borrow another
// class pool's local. Keep this separate from claims about that unavailable path.
import {join} from "node:path";
import {objectCache} from "./frontend-object-cache.mjs";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";
export function borrowedDefinitionArtifact(program, cacheDir) {
  const def = program.reg.getObject("CLAS", "ZCL_BORROW_PROVIDER")?.getDefinition();
  if (!def) return;
  const state = {reg: program.reg, wanted: new Set(["ZCL_BORROW_SEAM"]),
    definitions: new Map([["selected", def]])};
  const lower = (p) => p.definitions.get("selected").getAttributes().getConstants()[0].getValue();
  const cache = cacheDir && objectCache(program.reg, join(cacheDir, "borrowed-definition"));
  const stored = cache?.read("CLAS ZCL_BORROW_SEAM", "ZCL_BORROW_SEAM", state);
  let value;
  if (stored && replayLowering(state, stored.replay)) value = stored.ir;
  else {
    const result = recordLowering(state, lower);
    value = result.ir;
    if (result.replay) {
      cache?.write("CLAS ZCL_BORROW_SEAM", {name: "ZCL_BORROW_SEAM", ...result}, [], state);
      cache?.finish(program);
    }
  }
  return `const borrowedValue = ${JSON.stringify(value)};\n`;
}
