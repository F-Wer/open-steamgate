// Node strips erasable syntax; webpack still lowers modules for a classic worker.
const {stripTypeScriptTypes} = require("node:module");

module.exports = function (source) {
  return stripTypeScriptTypes(source, {mode: "strip", sourceUrl: this.resourcePath});
};
