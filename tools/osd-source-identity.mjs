// Fetch identity belongs to the folder, never to its compiler inputs.
// Shared with the frontend without importing pack discovery and its host graph.
import {basename} from "node:path";

export const SOURCE = ".osd-source.json";
export const isSourceIdentity = (file) => basename(file) === SOURCE;
