// The one source normalization gogen applies to files it loads itself.
// The folder loader in frontend.mjs and the supplied-registry mirror in
// cache-oracle-capture.mjs both call it, so a new step cannot reach one only.
// A registry a caller builds and supplies is the caller's to normalize.
import {lowerBoolx} from "./frontend-boolx.ts";
import {lowerNarrowSubmit} from "../osd-narrow-submit.mjs";

export const normalizeSource = (source, name, abaplint) =>
  lowerNarrowSubmit(lowerBoolx(source, name, abaplint), name, abaplint);
