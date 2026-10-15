// Fetch identity belongs to the folder, never to its compiler inputs.
// Shared with the frontend without importing pack discovery and its host graph.
import {basename} from "node:path";

import {SOURCE} from "./osd-source-identity-name.mjs";
export {SOURCE} from "./osd-source-identity-name.mjs";
export const isSourceIdentity = (file) => basename(file) === SOURCE;
