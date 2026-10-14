// The one binary: the workbench, its serving child, the builder and every
// tool it starts, as modes of a single executable (SP4).
//
//   osd up            the workbench on STG_PORT (test/run.mjs)
//   osd serve         the serving runtime, as the supervisor starts it
//   osd build [...]   tools/osd-build.mjs
//   osd fetch         the folders the packs declare as sources
//   osd gen <tool>    one generator, as the builder starts it
//   osd unit ...      a detached ABAP Unit run, as the façade starts it
//   osd run <prog>    a report built by osabap, run with its arguments
//   osd protocols     built-in DIAG 32nn and RFC-to-ADT 33nn listeners
//   osd compiler --stdio  compiler-provider NDJSON sidecar
//   osd ready         one-shot readiness check for launchers
//
// Two things a binary has to do that a checkout gets for free. First, code
// generated after the binary was built imports "@abaplint/runtime" by name
// and "../test/setup.mjs" by path, and neither is on disk beside it: a Bun
// runtime plugin answers both with the binary's own copies, so the
// generated code and the host run one runtime. Second, every bundled
// module shares one import.meta.url, so the "am I the script being run"
// guards of the tools would all fire on import: argv[1] is set to a name
// no module ends with, and the modes are dispatched here.
import * as runtime from "@abaplint/runtime";
import * as core from "@abaplint/core";
import {Transpiler, Chunk} from "@abaplint/transpiler";
import {config as validationConfig} from "@abaplint/transpiler/build/src/validation.js";
import {CallFunctionTranspiler} from "@abaplint/transpiler/build/src/statements/call_function.js";
import * as guiConverter from "../.local/lars/open-abap-gui/converter/src/api.mjs";
import * as setup from "../test/setup.mjs";
import {pathToFileURL} from "node:url";
import {dirname, resolve} from "node:path";
import {createRequire} from "node:module";
import {buildIdentity} from "../tools/osd-transpiler.mjs";
import {systemId} from "../tools/osd-identity.mjs";
import {compiled, setHostModules, dataDirOf, ensureBinaryHome, homesIn, isCheckout, layerList} from "../tools/osd-host.mjs";

// Bundles retain the identity of the packages actually embedded at build
// time. Reading a later checkout here would falsely describe old code.
const toolchainIdentity = typeof __OSD_TOOLCHAIN_IDENTITY__ !== "undefined"
  ? __OSD_TOOLCHAIN_IDENTITY__ : buildIdentity(process.cwd());
const embeddedSeed = typeof __OSD_BINARY_SEEDED__ !== "undefined" && __OSD_BINARY_SEEDED__;
const [, , mode = "up", ...rawArgs] = process.argv;
// Usage is not startup: do this before validating/mounting layers or
// materializing a standalone system home, let alone building/listening.
if (mode === "up" && rawArgs.includes("--help")) {
  console.log(`Usage: osd up [--layer <folder|zip>] [--help]

Build and start the local workbench and serving runtime.
  --layer <folder|zip>  Add an ABAP source layer (repeatable).
  --help                Print this usage without starting the system.

Environment: OSD_WARM=1 enables warm activation; STG_PORT sets the HTTP port.`);
  process.exit(0);
}
// a report's arguments are its own: --layer there is not osd's
const {folders: userLayers, rest} = mode === "run" ? {folders: [], rest: rawArgs} : layerList(rawArgs);
if (userLayers.length > 0) process.env.OSD_LAYERS = userLayers.join(process.platform === "win32" ? ";" : ":");
if (compiled && !isCheckout(process.cwd()) && process.env.OSD_BINARY_HOME !== process.cwd()
    && mode !== "ready" && mode !== "doctor" && mode !== "compiler" && !(mode === "unit" && rest.includes("--go"))) {
  if (!embeddedSeed) throw new Error("checkout-mode binary requires an open-steamgate checkout; build with --seed for standalone use");
  const home = await ensureBinaryHome(resolve(import.meta.dir, "osd-seed.tar.gz"), dataDirOf());
  process.chdir(home);
  process.env.OSD_ROOT = home;
  process.env.OSD_BINARY_HOME = home;
  console.log(`osd: system home ${home}`);
}


// how to start this program again, for every tool that starts a tool
// (tools/osd-host.mjs): the executable alone when this IS the executable
// (a Bun binary, a Node single executable), node plus this file otherwise
const sea = (() => {
  try {
    return createRequire(import.meta.url)("node:sea").isSea();
  } catch {
    return false;
  }
})();
process.env.OSD_SELF = JSON.stringify(compiled || sea ? [process.execPath] : [process.execPath, resolve(process.argv[1])]);

// The bundle renames a top-level class whose name collides with another
// (types.Date became Date2, types.String String2, measured with `osd
// doctor`), and the runtime tells types apart by constructor.name in some
// four hundred places, so RTTI took every string for "todo". webpack keeps
// class names on request; Bun has no such switch, and a function's name is
// a configurable property, so it is put back here, before anything runs.
for (const [key, value] of Object.entries(runtime.types ?? {})) {
  if (typeof value === "function" && value.name !== key) {
    Object.defineProperty(value, "name", {value: key});
  }
}

if (typeof Bun !== "undefined") {
  Bun.plugin({
    name: "osd-host",
    setup(build) {
      build.module("@abaplint/runtime", () => ({exports: runtime, loader: "object"}));
      build.onResolve({filter: /\/test\/setup\.mjs$/}, () => ({path: "osd:setup", namespace: "osd-host"}));
      // the transpiler writes a namespace as %23 in an import and as # in
      // the file name (a URL against a path), and Bun's resolver takes the
      // specifier literally: decoded here, against the importing module
      build.onResolve({filter: /%(23|25)/}, (args) => ({path: resolve(dirname(args.importer), decodeURIComponent(args.path))}));
      build.onLoad({filter: /.*/, namespace: "osd-host"}, () => ({exports: setup, loader: "object"}));
    },
  });
}
setHostModules({identity: toolchainIdentity, Transpiler, Chunk, core, CallFunctionTranspiler, validationConfig, guiConverter: embeddedSeed ? guiConverter : undefined, plugin: undefined, where: "bundled", version: "bundled"});

const GENERATORS = {
  "osd-layer.mjs": () => import("../tools/osd-layer.mjs"),
  "osd-leak-scan.mjs": () => import("../tools/osd-leak-scan.mjs"),
  "gogen-unit.mjs": () => import(pathToFileURL(resolve(process.cwd(), "tools/gogen/unit.mjs")).href),
  "osd-transpiler.mjs": () => import("../tools/osd-transpiler.mjs"),
  "osd-inputs.mjs": () => import("../tools/osd-inputs.mjs"),
  "cds2ddic.mjs": () => import("../tools/cds2ddic.mjs"),
  "stg-compile.mjs": () => import("../tools/stg-compile.mjs"),
  "segw-registry.mjs": () => import("../tools/segw-registry.mjs"),
  "segw-shlp.mjs": () => import("../tools/segw-shlp.mjs"),
  "amdp-gen.mjs": () => import("../tools/amdp-gen.mjs"),
  "amdp-tablefunc.mjs": () => import("../tools/amdp-tablefunc.mjs"),
  "osd-fm-registry.mjs": () => import("../tools/osd-fm-registry.mjs"),
  "osd-ddic-binary.mjs": () => import("../tools/osd-ddic-binary.mjs"),
  "osd-bsp-registry.mjs": () => import("../tools/osd-bsp-registry.mjs"),
  "osd-tran-registry.mjs": () => import("../tools/osd-tran-registry.mjs"),
  "osd-gui-convert.mjs": () => import("../tools/osd-gui-convert.mjs"),
  // not a generator: the warm build's comparison with a cold transpile
  "osd-warm.mjs": () => import("../tools/osd-warm.mjs"),
  "osd-warm-worker.mjs": () => import("../tools/osd-warm-worker.mjs"),
  // not a generator: osabap, for `osd run`; a checkout's tool, so imported
  // by a computed URL the bundler leaves alone rather than carried in it
  "osabap.mjs": () => import(new URL("../tools/gogen/osabap.mjs", import.meta.url).href),
};

switch (mode) {
  case "compiler": {
    const {main} = await import("../tools/osd-compiler-sidecar.mjs");
    process.exitCode = await main(rest);
    break;
  }
  case "up": {
    const {userLayersOf} = await import('../tools/osd-source-layers.mjs');
    const {reportOrphanedOverlays} = await import('../tools/osd-orphan-overlays.mjs');
    const layerRoot = process.env.OSD_ROOT ?? process.cwd();
    userLayersOf(layerRoot); reportOrphanedOverlays(layerRoot);
    process.argv = [process.argv[0], "osd-host", ...rest];
    const {main} = await import("../tools/osd-build.mjs");
    const status = await main([]);
    if (status !== 0) process.exit(status);
    await import("../test/run.mjs");
    break;
  }
  case "serve": {
    process.argv = [process.argv[0], "osd-host", ...rest];
    await import("../tools/osd-serve.mjs");
    break;
  }
  case "build": {
    process.argv = [process.argv[0], "osd-host", ...rest];
    const {main} = await import("../tools/osd-build.mjs");
    process.exit(await main(rest));
    break;
  }
  case "gen": {
    const {installGeneratorView} = await import("../tools/osd-generator-view.mjs");
    installGeneratorView();
    const [name, ...args] = rest;
    if (GENERATORS[name] === undefined) {
      console.error(`osd gen: not a generator: ${name}`);
      process.exit(2);
    }
    // the generator's own guard sees its name and runs its main
    // Store diagnostics can import CDS parsing before generator dispatch.
    // Invoke its entry explicitly even when the module is already cached.
    process.argv = [process.argv[0], name === "cds2ddic.mjs" ? "osd-host" : name, ...args];
    const generator = await GENERATORS[name]();
    if (name === "cds2ddic.mjs") generator.main();
    break;
  }
  case "fetch": {
    // a pack's declared sources, into the pack (tools/osd-fetch.mjs)
    process.argv = [process.argv[0], "osd-fetch", ...rest];
    const {main} = await import("../tools/osd-fetch.mjs");
    process.exit(await main(rest));
    break;
  }
  case "run": {
    // a report built by osabap and run as a command (tools/osd-run.mjs)
    const {main} = await import("../tools/osd-run.mjs");
    process.exit(main(rest));
    break;
  }
  case "unit": {
    if (rest.includes("--go")) {
      const {main} = await import("../tools/osgo-unit.mjs");
      process.exit(await main(rest.filter((arg) => arg !== "--go")));
    }
    process.argv = [process.argv[0], "osd-host", ...rest];
    const {main} = await import("../tools/osd-unit.mjs");
    process.exit(await main(rest));
    break;
  }
  case "protocols": {
    process.argv = [process.argv[0], "osd-protocols", ...rest];
    const {main} = await import("../tools/protocols/server.mjs");
    await main();
    break;
  }
  case "ready": {
    try {
      const port = process.env.STG_PORT ?? "3030";
      const response = await fetch(`http://127.0.0.1:${port}/osd/ready`, {signal: AbortSignal.timeout(2000)});
      const body = response.ok ? await response.json() : undefined;
      process.exit(body?.ready === true ? 0 : 1);
    } catch {
      process.exit(1);
    }
    break;
  }
  case "doctor": {
    const {orphanedOverlays, overlayWarning} = await import('../tools/osd-orphan-overlays.mjs');
    const orphanHomes = [process.env.OSD_ROOT ?? process.cwd(), ...homesIn(dataDirOf())];
    for (const home of [...new Set(orphanHomes)]) {
      for (const overlay of orphanedOverlays(home)) console.log(`orphaned overlay (${home}): ${overlayWarning(overlay)}`);
    }
    console.log(`binary mode: ${embeddedSeed ? "seeded (embedded system seed)" : "checkout (no embedded system seed)"}`);
    // where a seeded binary keeps the system it works on, and whether one
    // has been materialized there yet (the first `osd up` does it)
    const dataDir = dataDirOf();
    const homes = homesIn(dataDir);
    console.log(`data dir: ${dataDir}`);
    console.log(`system home: ${homes.length === 0 ? "none yet" : homes.join(", ")}`);
    // the address every listener of `osd up` takes (tools/osd-bind.mjs)
    const {bindHint, describeBind} = await import("../tools/osd-bind.mjs");
    console.log(`bind: ${describeBind()}${bindHint() === undefined ? "  (reachable from the network)" : "  (OSD_BIND=0.0.0.0 for the network)"}`);
    // the one system id (tools/osd-identity.mjs) and what chose it: the
    // setting OSD_SID, its alias STG_ADT_SID, or the default
    try {
      const {sid, source} = systemId();
      console.log(`system id: ${sid} (${source === "default" ? "default" : `setting ${source}`})`);
    } catch (error) {
      console.log(`system id: invalid -- ${error.message}`);
      process.exitCode = 1;
    }
    const {doctorWarmPin} = await import("../tools/osd-warm-capabilities.mjs");
    await doctorWarmPin(Transpiler, core);
    // what the bundle did to the runtime: a class the runtime looks up by
    // its name must still carry that name after bundling
    const renamed = [];
    for (const [group, members] of Object.entries({types: runtime.types ?? {}, runtime: runtime})) {
      for (const [key, value] of Object.entries(members)) {
        if (typeof value === "function" && value.name !== key && /^[A-Z]/.test(key)) {
          renamed.push(`${group}.${key} is named ${JSON.stringify(value.name)}`);
        }
      }
    }
    console.log(`runtime classes renamed by the bundle: ${renamed.length}`);
    for (const line of renamed.slice(0, 20)) {
      console.log("  " + line);
    }
    break;
  }
  default:
    console.error(`osd: unknown mode ${mode}; one of up, serve, build, fetch, gen, unit, run, protocols, compiler, ready, doctor`);
    process.exit(2);
}
