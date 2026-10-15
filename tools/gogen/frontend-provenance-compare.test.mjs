import {test} from "node:test";
import assert from "node:assert/strict";
import {canonicalManifests, canonicalQueries} from "./frontend-provenance-compare.mjs";

const scan = {role: "artifact", artifact: "CLAS ZREADER", phase: "syntax", kind: "cds-alias",
  scan: "getObjectsByType", args: ["DDLS"], queryArgs: ["ZALIAS"], result: ["DDLS ZFIRST", "DDLS ZSECOND"], complete: false};

test("canonical comparison ignores query dictionary order and object property order", () => {
  const miss = {kind: "getObject", args: ["CLAS", "ZABSENT"], result: []};
  const left = new Map([["CLAS ZA", {hits: [], misses: [miss], scans: [scan], unknownScans: []}],
    ["CLAS ZB", {hits: [scan, miss], misses: [], scans: [], unknownScans: []}]]);
  const reverseProperties = (q) => Object.fromEntries(Object.entries(q).reverse());
  const right = new Map([...left].reverse().map(([owner, m]) => [owner,
    Object.fromEntries(Object.entries(m).map(([kind, rows]) => [kind, rows.slice().reverse().map(reverseProperties)]))]));
  const compilation = {scheduling: [scan, miss], finalOutput: []};
  assert.deepEqual(canonicalManifests(left, compilation), canonicalManifests(right,
    {...compilation, scheduling: [reverseProperties(miss), reverseProperties(scan)]}));
});

test("canonical comparison preserves resolution order, empty answers and completeness", () => {
  for (const edit of [
    {result: [...scan.result].reverse()}, {result: []}, {complete: true}, {queryArgs: ["ZOTHER"]},
    {args: ["ENHS"]}, {phase: "lowering"}, {artifact: "CLAS ZOTHER"}, {role: "scheduling"},
    {kind: "unknown-scan"}, {policy: "last-wins"}, {site: ["<external>/unknown.mjs:1:1"]},
  ]) assert.notDeepEqual(canonicalQueries([scan]), canonicalQueries([{...scan, ...edit}]), JSON.stringify(edit));
  assert.notDeepEqual(canonicalQueries([scan]), canonicalQueries([scan, scan]), "duplicate rows remain visible");
});
