import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {CFit} from "./js/abap.mjs";

const units = (v) => v.split("").map((c) => c.charCodeAt(0));
test("CFit preserves UTF-16 units, cut halves and the flat string path in Go/JS", () => {
  const cases = [
    ["😀z", 1, "\ud83d"], ["😀z", 2, "😀"], ["😀z", 3, "😀z"],
    ["\ud83dz", 1, "\ud83d"], ["\ude00z", 1, "\ude00"],
    ["\ud83d", 2, "\ud83d"], ["😀 ", 3, "😀"], ["퀀z", 1, "퀀"],
    ["abc  ", 3, "abc"], ["abc  ", 4, "abc"], ["abc  ", 9, "abc"],
    ["abc", 0, ""], ["", 1, ""], ["abc  ", -1, "abc"],
    ["a".repeat(100000) + "  ", 100001, "a".repeat(100000)],
  ];
  const expected = cases.map(([, , want]) => units(want));
  assert.deepEqual(cases.map(([v, n]) => units(CFit(v, n))), expected);
  const dir = mkdtempSync(join(tmpdir(), "cfit-parity-"));
  try {
    const source = join(dir, "main.go");
    writeFileSync(source, `package main
import ("encoding/json"; "os"; "osg/gogen/abap")
func main() {
  out := [][]uint16{}
  ${cases.map(([v, n]) => `out = append(out, append([]uint16{}, abap.UTF16Units(abap.CFit(abap.UTF16String([]uint16{${units(v).join(",")}}), ${n}))...))`).join("\n")}
  if err := json.NewEncoder(os.Stdout).Encode(out); err != nil { panic(err) }
}`);
    const go = JSON.parse(execFileSync("go", ["run", source], {
      cwd: fileURLToPath(new URL("./go", import.meta.url)), encoding: "utf8", maxBuffer: 4e6,
    }));
    assert.deepEqual(go, expected);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
