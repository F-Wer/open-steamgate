const path = require("node:path");

// Deliberate allowlist: tools/gogen/**/*.ts plus the shared SAMC leaf.
const gogen = path.resolve(__dirname, "../tools/gogen") + path.sep;
const samc = path.resolve(__dirname, "../tools/osd-samc.ts");
const includes = [file => file.startsWith(gogen) && file.endsWith(".ts"), samc];
const allowed = file => includes.some(one => typeof one === "string" ? file === one : one(file));

class PreviewTypeScriptBoundaryPlugin {
  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap("PreviewTypeScriptBoundary", factory => {
      factory.hooks.afterResolve.tap("PreviewTypeScriptBoundary", result => {
        const file = result.createData.resource.split("?")[0];
        if (file.endsWith(".ts") && !allowed(file)) {
          throw new Error(`Preview TypeScript outside allowlist: ${path.relative(compiler.context, file)}`);
        }
      });
    });
  }
}

module.exports = {includes, PreviewTypeScriptBoundaryPlugin};
