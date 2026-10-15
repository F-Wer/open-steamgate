import {expect} from "chai";
import {configuredFor, previewClosure, uncovered, ENTRY} from "../tools/osd-preview-closure.mjs";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

// **`await import()` does not keep a module out of a webpack bundle.**
//
// webpack follows a dynamic import exactly as it follows a static one: it
// makes a chunk, and `LimitChunkCountPlugin({maxChunks: 1})` glues the chunk
// back in. A comment saying "this is lazy so it stays out of the worker"
// describes an intention, and a bundle does not read comments. That is how
// `tools/osd-store.mjs` reached the service worker through `test/setup.mjs`,
// brought `tools/osd-unit.mjs` with it, and through that `require("module")`
// -- no polyfill, no `false` in the fallback list, thirteen webpack errors,
// GitHub Pages red (2026-09-19).
//
// Three green suites did not cover it because none of them bundles. This
// walks the same graph in milliseconds and names the builtins it reaches
// that the config neither polyfills nor stubs.
describe("what the preview bundle can reach", () => {
  it("follows a DYNAMIC import, because webpack does", () => {
    const {modules} = previewClosure();
    // test/setup.mjs is reached from the worker only through
    // `await import("../test/setup.mjs")`
    expect(modules.some((m) => m.endsWith("test/setup.mjs")),
      "a lazy import is still an edge of the graph").to.equal(true);
    expect(modules.length, "and the graph is the whole bundle").to.be.greaterThan(100);
  });

  it("stops at IgnorePlugin, which is the only thing that removes a module", () => {
    const {modules} = previewClosure();
    expect(modules.some((m) => m.endsWith("hana-client.mjs")), "ignored by the config").to.equal(false);
    expect(modules.some((m) => m.endsWith("duckdb-client.mjs"))).to.equal(false);
    for (const name of ["osd-publish-activation", "osd-activation-journal", "osd-store-tests", "osd-store-crud", "osd-build"]) {
      expect(modules.some(m => m.endsWith(`${name}.mjs`)), `${name} requires a source host`).to.equal(false);
    }
  });

  it("loads STORE without statically importing ignored source activation modules", () => {
    const {ignored} = configuredFor();
    for (const file of previewClosure().modules) {
      const source = readFileSync(file, "utf8");
      for (const edge of source.matchAll(/(?:import\s+[^;]*?\s+from|export\s+[^;]*?\s+from|import)\s*["'](\.[^"']+)["']/g)) {
        const target = resolve(file, "..", edge[1]);
        if (/osd-(publish-activation|activation-journal|store-tests|store-crud|build)\.mjs$/.test(target)) {
          expect(ignored.some(pattern => pattern.test(target)), `${file} statically imports ignored ${edge[1]}`).to.equal(false);
        }
      }
    }
  });

  // The half that matters: the check has to be able to see the defect it was
  // written for. Its first version read 1200 characters after `fallback` and
  // swallowed the config's own `module:`, `rules:` and `plugins:` sections,
  // so it reported `module` as covered -- blind to exactly the builtin that
  // broke the build. Only testing it against that defect said so.
  it("reads the fallback OBJECT, not a window of characters around it", () => {
    const {covered} = configuredFor();
    expect(covered.has("fs"), "a real entry").to.equal(true);
    expect(covered.has("module"), "the builtin this check exists for").to.equal(false);
    expect(covered.has("rules"), "a section of the config, not a fallback").to.equal(false);
    expect(covered.has("plugins")).to.equal(false);
  });

  it("names the builtin and every module that reaches it, not just a count", () => {
    for (const one of uncovered()) {
      expect(one.builtin).to.be.a("string");
      expect(one.files, `${one.builtin} must say through what`).to.have.length.greaterThan(0);
    }
  });

  // Deliberately not asserted: that the list is empty today. This suite is
  // about the mechanism; `npm run preview:closure` is what reports the state,
  // and the build itself is what proves it (backlog 8.4).
  it("reports the state rather than asserting it, and says where the entry is", () => {
    expect(ENTRY).to.equal("web/preview-worker.mjs");
    const state = uncovered();
    if (state.length > 0) {
      console.log(`      (uncovered right now: ${state.map((o) => o.builtin).join(", ")})`);
    }
    expect(state).to.be.an("array");
  });
});

// Exercise the actual webpack rule and graph guard, including a plain JS .ts
// file which webpack could otherwise accept without ever running the loader.
describe("preview TypeScript boundary in webpack", function () {
  this.timeout(30000);
  let scratch;
  let webpack;
  let configuration;
  before(async () => {
    const {mkdtempSync, mkdirSync} = await import("node:fs");
    const {createRequire} = await import("node:module");
    const require = createRequire(import.meta.url);
    webpack = require("webpack");
    configuration = require("../webpack.config.cjs");
    mkdirSync(".local", {recursive: true});
    scratch = mkdtempSync(resolve(".local/preview-typescript-"));
  });
  after(async () => {
    const {rmSync} = await import("node:fs");
    rmSync(scratch, {recursive: true, force: true});
  });

  const compile = (entry) => new Promise((fulfil, reject) => {
    const compiler = webpack({
      mode: "development", target: configuration.target, context: process.cwd(), entry,
      output: {path: resolve(scratch, "bundle"), filename: "worker.js"},
      devtool: false, module: configuration.module,
      plugins: configuration.plugins.filter(plugin => plugin.constructor.name === "PreviewTypeScriptBoundaryPlugin"),
    });
    compiler.run((error, stats) => {
      compiler.close(closeError => {
        if (error || closeError) reject(error || closeError);
        else fulfil(stats);
      });
    });
  });

  it("strips both approved paths and keeps classic-worker module lowering", async () => {
    const {writeFileSync} = await import("node:fs");
    const entry = resolve(scratch, "entry.mjs");
    writeFileSync(entry, `import {parseSamc} from "../../tools/osd-samc.ts";
import {typeName} from "../../tools/gogen/go-symbols.ts";
self.result = [parseSamc(""), typeName("a")];`);
    const stats = await compile(entry);
    expect(stats.hasErrors(), stats.toString({errorDetails: true})).to.equal(false);
    const resources = [...stats.compilation.modules].map(module => module.resource).filter(Boolean);
    expect(resources).to.include(resolve("tools/osd-samc.ts"));
    expect(resources).to.include(resolve("tools/gogen/go-symbols.ts"));
    const {runInNewContext} = await import("node:vm");
    const scope = {self: {}};
    runInNewContext(readFileSync(resolve(scratch, "bundle/worker.js"), "utf8"), scope);
    expect(JSON.stringify(scope.self.result)).to.equal('[[],"A"]');
  });

  for (const contents of ["export const value = 1;", "export const value: number = 1;"]) {
    it(`fails the build for an unapproved .ts module (${contents.includes(":") ? "typed" : "plain JS"})`, async () => {
      const {writeFileSync} = await import("node:fs");
      const entry = resolve(scratch, "entry.mjs");
      writeFileSync(resolve(scratch, "unapproved.ts"), contents);
      writeFileSync(entry, 'import {value} from "./unapproved.ts"; self.result = value;');
      const stats = await compile(entry);
      expect(stats.hasErrors()).to.equal(true);
      expect(stats.toString({errorDetails: true})).to.include("Preview TypeScript outside allowlist:")
        .and.to.include("unapproved.ts");
    });
  }
});
