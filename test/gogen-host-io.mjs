// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {createRequire, isBuiltin} from "node:module";
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import * as host from "../tools/gogen/host-io.ts";
import * as compat from "../tools/gogen/host-io-compat.mjs";
import {isSourceIdentity, SOURCE} from "../tools/osd-source-identity.mjs";

const roots = ["frontend.mjs", "emit-go.mjs", "emit-js.mjs", "symbols.ts", "go-symbols.ts"]
  .map((file) => `tools/gogen/${file}`);

// Exact imports, not file-wide exemptions: a new builtin/API still fails.
const exceptions = {
  // The npm parser exports its downport rule too; that leaf uses SHA-1 only.
  "node_modules/@abaplint/core/build/src/rules/downport.js": {crypto: ["*"]},
  // Parser module loading still requires callable Node require adapters.
  // This is not a filesystem API with a primitive-valued contract.
  "tools/gogen/frontend-base.mjs": {"node:module": ["createRequire"]},
  "tools/gogen/frontend-analysis.mjs": {"node:module": ["createRequire"]},
  // Pure deep comparison of IR, with no host I/O. Keep its exact semantics.
  "tools/gogen/emit-table-move.ts": {"node:util": ["isDeepStrictEqual"]},
  // Not a host-io gap: the object cache (and its provenance/digest files) is an
  // optional HOST module injected through session/cacheDir, outside the compiler
  // closure that compileProgram loads without a cacheDir. abapiti/Go builds run
  // without it. Do not route these through host-io.ts (stoker + dell, 2026-10-15).
  "tools/gogen/frontend-object-cache.mjs": {
    "node:crypto": ["createHash", "randomUUID"], "node:module": ["createRequire"],
    "node:fs": ["existsSync", "mkdirSync", "readFileSync", "readdirSync", "renameSync", "rmSync", "statSync", "utimesSync", "writeFileSync"],
    "node:path": ["join", "resolve"], "node:v8": ["serialize", "deserialize"],
    "node:zlib": ["deflateRawSync", "inflateRawSync"],
  },
  "tools/gogen/frontend-provenance.mjs": {
    "node:crypto": ["createHash"], "node:module": ["createRequire"], "node:url": ["pathToFileURL"],
  },
  "tools/gogen/frontend-provenance-hooks.mjs": {"node:path": ["relative", "isAbsolute"], "node:url": ["fileURLToPath"]},
  "tools/gogen/frontend-source-key.mjs": {"node:crypto": ["createHash"]},
  "tools/gogen/frontend-artifact-digests.mjs": {"node:crypto": ["createHash"], "node:path": ["basename"]},
  "tools/gogen/frontend-inventory.mjs": {"node:crypto": ["createHash"], "node:module": ["createRequire"]},
  "tools/gogen/frontend-v3-shadow.mjs": {
    "node:fs": ["mkdirSync", "readFileSync", "writeFileSync", "renameSync", "rmSync"], "node:path": ["join"],
    "node:crypto": ["createHash", "randomUUID"], "node:v8": ["serialize", "deserialize"],
    "node:zlib": ["deflateRawSync", "inflateRawSync"],
  },
  "tools/gogen/frontend-v3-key.mjs": {"node:crypto": ["createHash"]},
  "tools/gogen/frontend-v3-queries.mjs": {"node:module": ["createRequire"]},
};
const hostImports = {"node:fs": ["readFileSync", "readdirSync", "writeFileSync"],
  "node:path": ["*"], "node:child_process": ["execFileSync"]};

// Follow repository sources, including reexports and the opt-in require() cache
// edge, plus installed npm parser implementations. Type-only imports still
// get inspected. The TS parser ignores
// comments and emitted-code string literals containing fake import statements.
function importsInClosure(entries) {
  const seen = new Set(), imports = [];
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.[cm]?[jt]s$/.test(file)) return; // package metadata has no imports
    const source = readFileSync(file, "utf8"), fileRequire = createRequire(path.resolve(file));
    function edge(spec, node, names) {
      if (isBuiltin(spec)) imports.push({file, spec, names,
        line: typeof node === "number" ? source.slice(0, node).split("\n").length
          : ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1});
      else visit(path.relative(".", fileRequire.resolve(spec)));
    }
    // Dependencies are compiled CommonJS. The TS import scanner recognizes
    // their literal require edges without building thousands of full ASTs.
    if (file.split(path.sep).includes("node_modules")) {
      for (const ref of ts.preProcessFile(source, true, true).importedFiles) {
        // AMD wrappers name these injected parameters as pseudo dependencies.
        if (ref.fileName === "require" || ref.fileName === "exports") continue;
        edge(ref.fileName, ref.pos, ["*"]);
      }
      return;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
        const names = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          ? bindings.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"];
        if (ts.isImportDeclaration(node) && node.importClause?.name) names.push("default");
        edge(node.moduleSpecifier.text, node, names);
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const expr = node.expression;
        if (expr.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(expr) && /require$/i.test(expr.text)
            || ts.isPropertyAccessExpression(expr) && expr.name.text === "resolve" && /require$/i.test(expr.expression.getText(ast)))
          edge(node.arguments[0].text, node, ["*"]);
      }
      ts.forEachChild(node, scan);
    }
    scan(ast);
  }
  entries.forEach(visit);
  return {seen, imports};
}

function forbidden(imports) {
  return imports.filter(({file, spec, names}) => {
    const allowed = (file === "tools/gogen/host-io.ts" ? hostImports : exceptions[file])?.[spec];
    return !allowed || names.some((name) => !allowed.includes(name));
  }).map(({file, spec, line}) => `${file}:${line}: ${spec}`);
}

describe("gogen compiler host boundary", () => {
  let scratch;
  before(() => {
    mkdirSync(".local", {recursive: true});
    scratch = mkdtempSync(".local/host-io-test-");
  });
  after(() => rmSync(scratch, {recursive: true, force: true}));

  it("walks every compiler root, including the optional disk cache, and enforces exact builtin exceptions", () => {
    const {seen, imports} = importsInClosure(roots);
    assert.ok(seen.has("tools/gogen/frontend-object-cache.mjs"), "missed require() cache edge");
    assert.ok(seen.has("tools/gogen/host-io.ts"));
    assert.deepEqual(forbidden(imports), []);
    for (const file of Object.keys(exceptions)) assert.ok(seen.has(file), `stale exception: ${file}`);
  });

  it("finds forbidden static imports, reexports, dynamic imports, require and bare builtins through transitive edges", () => {
    const entry = path.join(scratch, "root.ts"), leaf = path.join(scratch, "leaf.mjs");
    writeFileSync(entry, 'export * from "./leaf.mjs";\n// import "node:os";\nconst emitted = `import "node:net";`;');
    writeFileSync(leaf, 'import {readFileSync as read} from "node:fs";\nexport {join} from "node:path";\nimport("node:http");\nrequire("node:child_process");\nimport "fs";');
    const {imports} = importsInClosure([entry]);
    assert.deepEqual(imports.map((i) => i.spec), ["node:fs", "node:path", "node:http", "node:child_process", "fs"]);
    assert.equal(forbidden(imports).length, 5);
    const vendor = path.join(scratch, "node_modules/vendor");
    mkdirSync(vendor, {recursive: true});
    writeFileSync(path.join(vendor, "index.js"), 'define(["require", "exports", "node:net"], function () {}); const emitted = `require("node:os")`;');
    const vendorImports = importsInClosure([path.join(vendor, "index.js")]).imports;
    assert.deepEqual(vendorImports.map((i) => i.spec), ["node:net"]);
    assert.equal(forbidden(vendorImports).length, 1);
    assert.equal(forbidden([{file: "tools/gogen/frontend.mjs", spec: "node:fs", names: ["writeFileSync"], line: 1}]).length, 1);
  });

  it("preserves UTF-8 bytes, errors, native entry order and directory-symlink classification", () => {
    const dir = path.join(scratch, "entries");
    mkdirSync(dir);
    host.writeText(path.join(dir, "z.txt"), "é😀\n");
    mkdirSync(path.join(dir, "a-dir"));
    symlinkSync("a-dir", path.join(dir, "link"), "dir");
    assert.equal(host.readText(path.join(dir, "z.txt")), "é😀\n");
    assert.equal(compat.readFileSync(path.join(dir, "z.txt"), "utf8"), "é😀\n");
    assert.deepEqual(readFileSync(path.join(dir, "z.txt")), Buffer.from("é😀\n", "utf8"));
    assert.deepEqual(host.listDir(dir), readdirSync(dir));
    assert.deepEqual(host.listEntries(dir), readdirSync(dir, {withFileTypes: true}).map((e) => [e.name, e.isDirectory()]));
    assert.deepEqual(compat.readdirSync(dir), readdirSync(dir));
    assert.deepEqual(compat.readdirSync(dir, {withFileTypes: true}).map((e) => [e.name, e.isDirectory()]), host.listEntries(dir));
    assert.equal(host.listEntries(dir).find(([name]) => name === "link")[1], false);
    for (const fn of [host.readText, host.listDir, host.listEntries]) assert.throws(() => fn(path.join(dir, "missing")), {code: "ENOENT"});
    assert.throws(() => host.writeText(path.join(dir, "missing/file"), ""), {code: "ENOENT"});
    for (const file of ["", SOURCE, `a/${SOURCE}`, `a/${SOURCE}/`, `${SOURCE}.bak`, "a/../file", `a\\${SOURCE}`]) {
      assert.equal(compat.isSourceIdentity(file), isSourceIdentity(file));
      assert.equal(host.basename(file), path.basename(file));
    }
    assert.equal(host.dirname(""), path.dirname(""));
    assert.equal(host.join("a", "..", "b/"), path.join("a", "..", "b/"));
    assert.equal(host.join(), path.join());
  });

  it("keeps git failure fallback and live empty/absent environment values", () => {
    assert.equal(host.gitHead("."), execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim());
    assert.equal(host.gitHead(path.join(scratch, "missing-cwd")), undefined);
    const key = "GOGEN_HOST_IO_TEST", previous = process.env[key];
    try {
      delete process.env[key]; assert.equal(host.env(key), undefined);
      process.env[key] = ""; assert.equal(host.env(key), "");
      process.env[key] = "0"; assert.equal(host.env(key), "0");
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });
});
