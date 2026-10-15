// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {dirname, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";
import * as folding from "../tools/gogen/fold-scalars.ts";
import * as runtime from "../tools/gogen/js/abap.mjs";

// Fixed seed: failures reproduce without retaining generated fixture files.
let seed = 0x502cafe;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const text = [
  "", " ", "   ", "\t", "\n", "\r\n", "\u00a0", "\u2003", "\u2028", "\ufeff",
  "0", "-0", "+0", "0-", "-0.0", "-0e0", "-1e-999", "1e309", "1e-999",
  "2147483647", "2147483648", "-2147483648", "-2147483649",
  "2147483647.4", "2147483647.5", "2147483648.5-", ".4999", ".5", "-.5",
  "999999999999999", "9999999999999999", "00000000000000000000000000001",
  "1.", ".", "1e+2", "1E-2", "1e", "1e+", "1e2e3", "1e2-", "-1-", "+1-",
  "  - 12.5  ", "12 garbage", "12\tgarbage", "12 \tgarbage", "1\n", "1.2.3",
  "nan", "NaN", "NAN", "inf", "INF", "Infinity", "infinity", "-Infinity", "+inf",
  "garbage", "0x10", "1_000", "12,5", "1\0", "１２", "١٢", "²", "😀z",
  "a😀b  ", "\ud83dz", "\ude00z", "\ud83d", "e\u0301", "퀀z", "a\u00a0 ",
  "20260229", "1234567890", "123  ", "9".repeat(400), "a".repeat(4096) + "😀  ",
];
const numbers = [0, -0, 1, -1, 0.5, -0.5, 2147483647, -2147483648,
  2147483648, -2147483649, Number.MIN_VALUE, -Number.MIN_VALUE,
  Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity];
const widths = [-Infinity, -8, -1, -0, 0, 0.5, 1, 2, 3, 6, 8, 16, 64, NaN, Infinity];
const alphabet = ["0", "1", "5", "9", ".", "e", "E", "+", "-", " ", "\t", "\n", "x", "\0", "😀", "\ud83d", "\ude00", "é", "１", "\u00a0"];
for (let i = 0; i < 4096; i++) {
  const n = random(2 ** 32) - 2147483648;
  numbers.push(n, n / 10);
  const sign = ["", "-", "+"][random(3)];
  const mantissa = `${random(1000000000)}.${random(100000)}`;
  text.push(`${sign}${mantissa}${["", "e+2", "E-12", "e309", "-"][random(5)]}`);
  text.push(`${["", " ", "\t"][random(3)]}${n}${["", " ", "-", " x"][random(4)]}`);
  text.push(Array.from({length: random(24)}, () => alphabet[random(alphabet.length)]).join(""));
}

function outcome(fn, args) {
  try { return {value: fn(...args)}; }
  catch (error) {
    assert.ok(error instanceof Error);
    // The port owns a private AbapError; compare its class and inheritance,
    // ABAP exception code and exact message, plus native errors such as RangeError.
    const classes = [];
    for (let p = error; p; p = Object.getPrototypeOf(p)) classes.push(p.constructor.name);
    return {error: {classes, name: error.name, cls: error.cls, message: error.message}};
  }
}
function parity(name, cases) {
  let count = 0;
  for (const args of cases) {
    // deepStrictEqual distinguishes -0 from 0 and preserves NaN and UTF-16 halves.
    assert.deepEqual(outcome(folding[name], args), outcome(runtime[name], args),
      `${name}(${args.map(v => typeof v === "number" && Object.is(v, -0) ? "-0" : JSON.stringify(v)).join(", ")})`);
    count++;
  }
  assert.ok(count > 4000, `${name}: too few differential cases: ${count}`);
}
function* sized(values) {
  for (const value of values) for (const width of widths) yield [value, width];
}

describe("gogen folding scalars match the unchanged emitted runtime", () => {
  it("exports only the eight helpers consumed by constant folding", () => {
    assert.deepEqual(Object.keys(folding).sort(), ["NegI", "ParseF", "ParseI", "CFit", "S2D", "S2T", "CToN", "IToN"].sort());
  });
  for (const name of ["ParseF", "ParseI", "S2D", "S2T"]) {
    it(`${name}: generated and hand-picked text`, () => parity(name, text.map(v => [v])));
  }
  it("NegI: overflow, fractions, non-finite values and signed zero", () => parity("NegI", numbers.map(v => [v])));
  for (const name of ["CFit", "CToN"]) {
    it(`${name}: text and boundary widths`, () => parity(name, sized(text)));
  }
  it("IToN: numeric values and boundary widths", () => parity("IToN", sized(numbers)));
});

// Parse actual import syntax so emitted import strings and comments cannot
// create false edges. Include the frontend's lazy require of the object cache.
function compilerClosure(root) {
  const seen = new Set();
  function walk(file) {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) walk(resolve(dirname(file), specifier.text));
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (const entry of ["frontend.mjs", "emit-go.mjs", "emit-js.mjs", "symbols.ts"]) walk(resolve(root, "tools/gogen", entry));
  return [...seen].map(file => relative(root, file).replaceAll("\\", "/")).sort();
}

describe("gogen compiler import boundary (cut2)", () => {
  it("reaches the typed scalar leaf without importing the emitted runtime", () => {
    const files = compilerClosure(fileURLToPath(new URL("../", import.meta.url)));
    assert.ok(files.includes("tools/gogen/fold-scalars.ts"));
    assert.deepEqual(files.filter(file => file.startsWith("tools/gogen/js/")), []);
  });
});
