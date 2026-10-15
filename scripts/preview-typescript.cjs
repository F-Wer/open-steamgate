const path = require("node:path");

// Deliberate allowlist: tools/gogen/**/*.ts plus the shared SAMC leaf.
const gogen = path.resolve(__dirname, "../tools/gogen") + path.sep;
const samc = path.resolve(__dirname, "../tools/osd-samc.ts");
// A dependency directory never counts as approved, even below tools/gogen.
const inDependencies = file => file.split(/[\\/]/).includes("node_modules");
const includes = [file => file.startsWith(gogen) && file.endsWith(".ts") && !inDependencies(file), samc];
const allowed = file => includes.some(one => typeof one === "string" ? file === one : one(file));

class PreviewTypeScriptBoundaryPlugin {
  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap("PreviewTypeScriptBoundary", factory => {
      factory.hooks.afterResolve.tap("PreviewTypeScriptBoundary", result => {
        // The resolved path, without a ?query or a #fragment either may carry.
        const data = result.createData;
        const file = data.resourceResolveData?.path ?? data.resource.replace(/[?#].*$/, "");
        if (/\.[mc]?ts$/.test(file) && !allowed(file)) {
          throw new Error(`Preview TypeScript outside allowlist: ${path.relative(compiler.context, file)}`);
        }
      });
    });
  }
}

module.exports = {includes, PreviewTypeScriptBoundaryPlugin};
