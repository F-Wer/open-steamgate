const path = require("node:path");
const webpack = require("webpack");
const TerserPlugin = require("terser-webpack-plugin");
const {includes, PreviewTypeScriptBoundaryPlugin} = require("./scripts/preview-typescript.cjs");

// Bundles the transpiled ABAP gateway into the service worker that serves the
// preview deployment (scripts/build-preview.mjs runs it). After
// larshp/hithub's webpack.config.cjs (MIT).
module.exports = {
  mode: "production",
  target: "webworker",
  entry: path.resolve(__dirname, "web/preview-worker.mjs"),
  output: {
    path: path.resolve(__dirname, "build", "preview"),
    filename: "sw.js",
    clean: true,
  },
  devtool: false,
  experiments: {topLevelAwait: true},
  performance: {hints: false},
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          // the runtime looks classes up by name
          keep_classnames: true,
          keep_fnames: true,
          mangle: {keep_classnames: true, keep_fnames: true},
        },
      }),
    ],
  },
  resolve: {
    // Keep a linked package at the path it was linked to rather than at the
    // path it really lives at. The browser polyfills below are resolved from
    // this project's node_modules; a package linked in from another checkout
    // resolves outside it and the build fails on "Can't resolve
    // 'process/browser'" from a directory that has no node_modules of its own.
    // Following the symlink is the default and is right for a normal install;
    // it is wrong for the deliberate divergence recorded as
    // DEBT-2026-09-13-linked-transpiler, and it should not stop a bundle.
    symlinks: false,
    extensions: [".mjs", ".js"],
    alias: {
      // @duckdb/duckdb-wasm 1.32.0 publishes the browser blocking bundle,
      // but its ./blocking export accidentally points to duckdb-node-blocking.mjs
      // (not present in the package). Bind that public specifier to the
      // shipped browser file for this webworker build only.
      "@duckdb/duckdb-wasm/blocking$": path.resolve(__dirname, "node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs"),
      // the asm.js build needs no separate .wasm file to deploy and route
      "sql.js$": require.resolve("sql.js/dist/sql-asm.js"),
    },
    fallback: {
      assert: require.resolve("assert/"),
      buffer: require.resolve("buffer/"),
      constants: require.resolve("constants-browserify"),
      crypto: require.resolve("crypto-browserify"),
      events: require.resolve("events/"),
      http: require.resolve("stream-http"),
      https: require.resolve("https-browserify"),
      os: require.resolve("os-browserify/browser"),
      path: require.resolve("path-browserify"),
      process: require.resolve("process/browser"),
      stream: require.resolve("stream-browserify"),
      string_decoder: require.resolve("string_decoder/"),
      url: require.resolve("url/"),
      util: require.resolve("util/"),
      vm: require.resolve("vm-browserify"),
      zlib: require.resolve("browserify-zlib"),
      fs: false,
      net: false,
      tls: false,
    },
  },
  module: {
    rules: [
      {test: /\.m?js$/, resolve: {fullySpecified: false}},
      {test: /\.ts$/, include: includes, use: path.resolve(__dirname, "scripts/strip-types-loader.cjs")},
    ],
  },
  plugins: [
    new PreviewTypeScriptBoundaryPlugin(),
    // The published browser blocking bundle references __filename while
    // initialising its Emscripten module. In a service worker there is no
    // Node wrapper; give it the script URL, from which it can resolve assets.
    new webpack.DefinePlugin({__filename: "self.location.href"}),
    // A module specifier is a URL, so a percent in a file name is written as
    // %25 and Node decodes it before resolving. webpack does not decode, and
    // looks for a file whose name really contains "%25". Both are defensible
    // and they cannot both be satisfied by one string, so the bundle decodes
    // on the way in. Web Repository objects are the ones that have a percent:
    // abapGit writes ZO4D_06_PLASMA.PNG as zo4d_06_plasma%2epng.
    new (require("webpack").NormalModuleReplacementPlugin)(/%25/, (resource) => {
      resource.request = resource.request.replace(/%25/g, "%");
    }),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
    // The transpiler percent-escapes namespaces in imports (%23iwbep%23...),
    // the files on disk carry the # itself.
    new webpack.NormalModuleReplacementPlugin(/%23/, (resource) => {
      const filename = resource.request.replace(/^\.\//, "").replaceAll("%23", "#");
      resource.request = path.resolve(__dirname, "output", filename);
    }),
    // DuckDB is a native module the browser never takes; keep it out of the bundle
    new webpack.IgnorePlugin({resourceRegExp: /duckdb-client\.mjs$/}),
    // the same for the SQLite file client: STG_DB=file is a process with a
    // disk, and node:sqlite is not a thing a service worker can resolve
    new webpack.IgnorePlugin({resourceRegExp: /sqlite-file-client\.mjs$/}),
    // and for HANA, which is a TCP driver and a node:url the browser polyfill
    // does not have (fileURLToPath). test/setup.mjs installs the AMDP
    // destination whatever the database is, so the graph reaches these two
    // even in a preview that will never have a server to talk to; the
    // destination itself says so when it is called (tools/amdp-destination.mjs).
    new webpack.IgnorePlugin({resourceRegExp: /^hdb$/}),
    new webpack.IgnorePlugin({resourceRegExp: /hana-client\.mjs$/}),
    new webpack.IgnorePlugin({resourceRegExp: /amdp-run\.mjs$/}),
    // and the object store, for the same reason one step further out: the
    // editor screen's destination is installed in every host
    // (test/setup.mjs), and the store it opens pulls in abaplint, the
    // transpiler and node:module. A browser preview serves a BUILT system
    // and has no source tree at all, so the import is one that must never
    // be evaluated there -- and `await import()` does not keep it out of
    // the bundle, which is how this was found: webpack follows a dynamic
    // import as readily as a static one, and the public preview went red on
    // 13 unresolved node builtins (backlog G.8, 2026-09-19).
    //
    // The destination opens the store inside a try, so here the ignore
    // becomes the sentence the screen shows -- "no object store here" --
    // rather than a crash. Same shape as the AMDP destination above.
    new webpack.IgnorePlugin({resourceRegExp: /osd-store\.mjs$/}),
    // and git, which HISTORY / REVISION import on the call: a preview has no
    // worktree and no child_process, and never gets that far (no store)
    new webpack.IgnorePlugin({resourceRegExp: /osd-git-history\.mjs$/}),
    // and the unit plan (ABAP Unit discovery), imported on the call: it spawns
    // test runs and reads build frames, and a preview has no store to plan from
    new webpack.IgnorePlugin({resourceRegExp: /osd-unit\.mjs$/}),
    // STORE activation/completion and test execution require a source host.
    // Keep these entry modules out just like the store itself: dynamic
    // imports are still traversed by webpack. Built preview hosts refuse
    // source commands before reaching any of these modules. Their imports
    // must be dynamic behind that refusal: ignoring a static import leaves
    // a webpackMissingModule call that throws during worker initialization.
    new webpack.IgnorePlugin({resourceRegExp: /osd-(publish-activation|activation-journal|store-tests|store-crud|build)\.mjs$/}),
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
      process: "process/browser",
    }),
    new webpack.optimize.LimitChunkCountPlugin({maxChunks: 1}),
  ],
};
