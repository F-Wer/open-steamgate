import {rootWebappOf} from "../tools/osd-system.mjs";
import {servingFront} from "../tools/osd-serving-front.mjs";
import {randomUUID} from "node:crypto";
import {requestXMLBodyError, XML_BODY_LIMIT} from "../tools/adt-request-xml.mjs";
import {parentAdtSnapshot} from "../tools/adt-runtime-state.mjs";
import {databasePath} from "../tools/osd-persist.mjs";
import {dialogStep, lockedClient} from "../tools/osd-dialog-step.mjs";
import {ensureDemoData} from "../tools/osd-demo-data.mjs";
import express from "express";
import {StoreDestination} from "../tools/osd-store-destination.mjs";
import {existsSync} from "node:fs";
import {generatorFoldersOf, tilesOf, webappsOf} from "../tools/osd-packs.mjs";
import {packApplications} from "../tools/osd-bsp-registry.mjs";
import {mountRemoteServices} from "../tools/osd-remote-service.mjs";
import {segwRegistrations} from "../tools/segw-registry.mjs";
import {createServer as createHttpsServer} from "node:https";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {adtRouter} from "../tools/adt-facade.mjs";
import {abapRunner} from "../tools/adt-abap-front.mjs";
import {kernelFreshness} from "../tools/adt-abap-kernel.mjs";
import {liveHash} from "../tools/osd-build.mjs";
import {warmUnitPlan} from "../tools/osd-unit.mjs";
import {closeWarm} from "../tools/osd-store-warm.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";
import {Data} from "../tools/osd-data.mjs";
import {DEFAULT_DATABASE} from "../tools/sqlite-file-client.mjs";
import {credentials as tlsCredentials, fingerprint as tlsFingerprint, dirOf as tlsDirOf} from "../tools/osd-tls.mjs";
import {odataProxy, upgradeProxy} from "../tools/osd-proxy.mjs";
import {inspectPortOf} from "../tools/osd-inspector.mjs";
import {devLoop} from "../tools/osd-dev.mjs";
import {mountServices, services as icfServices, servicesFromRows, channels as pushChannels} from "../tools/osd-icf.mjs";
import {mountChannels} from "../tools/osd-apc.mjs";
import {mountHost, nodes} from "../tools/osd-nodes.mjs";
import {applyAtStartup, currentRows} from "../tools/osd-icf-apply.mjs";
import {seedAtStartup} from "../tools/osd-xref-seed.mjs";
import {snapshot as statusSnapshot} from "../tools/osd-status.mjs";
import {request as httpRequest, createServer as createHttpServer} from "node:http";
import {bindAddresses, bindHint, describeBind, listenBound, relisten} from "../tools/osd-bind.mjs";
import {serveSandboxConfig} from "../tools/osd-sandbox-config.mjs";
import {mountPortableCells} from "../tools/sqlscript-to-procedure-ir.mjs";

// Two shapes of one listener, and the difference is whether this process
// contains an ABAP system.
//
// Inline is the old shape: the transpiled modules are imported here and
// answer here. It is what a test wants — no child, no second database —
// and what the browser preview is built from. Its limit is why the other
// shape exists: Node pins a module graph for the life of a process, so code
// activated through the façade, or saved on disk, is never live here.
//
// Child is the workbench: this process is the façade, the static files and
// a proxy, and loads no ABAP at all. The system runs in tools/osd-serve.mjs,
// a process the supervisor replaces after a successful build — OData, every
// ICF service, the push channels, and the door the data preview reads
// through. One generation, one database, and every consumer on them.
// STG_SERVE=child asks for it; test/run.mjs, the way a server is started,
// defaults to it; a suite that calls startServer() itself stays inline.
// Owned by the front, independent of runtime generations and worker PIDs.
const launcherIdentity = process.env.OSD_LAUNCHER_IDENTITY ?? randomUUID();
delete process.env.OSD_LAUNCHER_IDENTITY;
const MODE = process.env.STG_SERVE === "child" ? "child" : "inline";

/** the close of the last server this module started, so the next bind can
 *  wait for it however its suite happened to write the hook */
let closing;

async function loadInline() {
  const {ensureSourceBuild} = await import("../tools/osd-source-build-view.mjs");
  await ensureSourceBuild(process.cwd());
  const from = (file) => import(new URL(`../output/${file}`, import.meta.url).href);
  const {initializeABAP} = await from("init.mjs");
  const {cl_express_icf_shim} = await from("cl_express_icf_shim.clas.mjs");
  const {zcl_osd_adt_handler} = await from("zcl_osd_adt_handler.clas.mjs");
  const {zcl_stg_segw_registry} = await from("zcl_stg_segw_registry.clas.mjs");
  const {zcl_stg_shlp_registry} = await from("zcl_stg_shlp_registry.clas.mjs");
  const {zcl_apc_host} = await from("zcl_apc_host.clas.mjs");
  // the system-status writer; inline there is no child to post a snapshot to,
  // so the facade writes the tables itself (src/status/)
  const {zcl_osd_status} = await from("zcl_osd_status.clas.mjs");
  await initializeABAP();
  // the ICF nodes into ICFSERVICE/ICFHANDLER -- see tools/osd-icf-apply.mjs
  // and docs/registry-drift.md. Awaited, so a registry that could not be
  // applied is reported before the listener claims to be up. `quiet` is not
  // in scope here -- this runs once at module load, not per startServer() --
  // and a suite that starts a hundred servers still applies once.
  const registry = await applyAtStartup(globalThis.abap.context.databaseConnections.DEFAULT, {root: process.cwd()});
  if (registry === undefined) throw new Error("the ICF registry could not be applied");
  const icf = servicesFromRows(await currentRows(globalThis.abap.context.databaseConnections.DEFAULT));
  // the cross-reference (CROSS, WBCROSSGT, WBCROSSGTX, D010INC), derived from
  // the files per generation -- one module for every host, tools/osd-xref-seed.mjs
  await seedAtStartup(globalThis.abap.context.databaseConnections.DEFAULT, {root: process.cwd()});
  // the SEGW registration objects (IWSV/IWMO in src/) say which service is
  // served by which MPC/DPC classes; tools/segw-registry.mjs generated this
  await zcl_stg_segw_registry.register();
  // the search help objects (*.shlp.xml in src/) become value help providers;
  // tools/segw-shlp.mjs generated this
  await zcl_stg_shlp_registry.register();
  // the synthetic taxi facts, made by ZCL_OSD_DEMO_DATA (tools/osd-demo-data.mjs)
  const {zcl_osd_demo_data} = await from("zcl_osd_demo_data.clas.mjs");
  await ensureDemoData(zcl_osd_demo_data);
  return {cl_express_icf_shim, zcl_osd_adt_handler, zcl_apc_host, zcl_osd_status, icf};
}
if (MODE === "child") {
  const {ensureSourceBuild} = await import("../tools/osd-source-build-view.mjs");
  await ensureSourceBuild(process.cwd());
}
const inline = MODE === "inline" ? await loadInline() : undefined;

// The child-mode parent runs no system, but it runs the ADT front: the ADT
// classes and nothing else, with their own database in memory and the lock
// server in this process, so the ADT sessions and their locks outlive every
// recycle of the serving child (tools/adt-abap-kernel.mjs). OSD_ADT=js is the
// way out when the ABAP front itself is broken: Node's sessions and routes
// answer everything, as before slice 3.
async function loadChildKernel() {
  try {
    const {loadAdtKernel} = await import("../tools/adt-abap-kernel.mjs");
    const setup = await import("./setup.mjs");
    const output = process.env.OSD_OUTPUT ?? join(process.env.OSD_ROOT ?? process.cwd(), "output");
    return {...await loadAdtKernel({output, setup}), output};
  } catch (e) {
    console.error(`ADT front: the ABAP kernel did not load, so Node's sessions and routes answer ADT (${e?.message ?? e}); OSD_ADT=js says so on purpose`);
    return undefined;
  }
}
const adtKernel = MODE === "child" && process.env.OSD_ADT !== "js" && process.env.OSD_ADT_ONE_RUNTIME !== "1" ? await loadChildKernel() : undefined;


/** Host memory only; child readiness starts with its first running generation. */
export function readinessAnswer(mode, store) {
  const ready = mode === "inline" || store.served?.running === true;
  return {status: ready ? 200 : 503, body: {ready}};
}

export function startServer(quiet) {
  const PORT = Number(process.env.STG_PORT ?? 3030);

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  // an IWPR of a real SEGW project is a few hundred KB (ImportSet takes it as JSON)
  app.use(express.raw({type: "*/*", limit: XML_BODY_LIMIT}));
  app.use(requestXMLBodyError);
  if (MODE === "inline") mountPortableCells(app, () => globalThis.abap.context.databaseConnections.DEFAULT,
    (work) => dialogStep(work, "SQLScript notebook cell"));

  // **What this host answers is declared in src/icf/nodes.json.** It used to
  // be this list of app.get/app.use lines, which is how three hosts came to
  // disagree by construction -- each one carrying its own idea of what the
  // system exposes. The registry has the list now, and what follows only
  // says how each entry attaches: those are genuinely different express
  // shapes (an exact GET, a static prefix, a POST with a parameter, a router
  // with no path at all) and flattening them would have meant inventing a
  // field per shape. mountHost() below registers them longest path first and
  // refuses a handler no node declares -- and `node tools/osd-routes.mjs`
  // checks the other direction.
  const hostNodes = {};

  // The port's front door is the launchpad when there is one: every app and
  // every demo this system serves is a tile on it, which is what a person
  // opening a system expects to find rather than a paragraph of paths.
  hostNodes.root = (a, node) => a.get(node.path, function (req, res) {
    if (existsSync(join(rootWebappOf(process.cwd()), "flp.html"))) {
      res.redirect(302, "/app/flp.html");
      return;
    }
    res.send('open-steamgate: OData v2 services live under /sap/opu/odata/sap/, the demo Fiori app under <a href="/app/index.html">/app/</a>');
  });

  // the Fiori Elements demo app, same origin as the service: no proxy, no CORS
  // the tree's webapp, not the module's: in a binary the module has no folder
  hostNodes["app-static"] = (a, node) => a.use(node.path, express.static(rootWebappOf(process.cwd())));
  serveSandboxConfig(app);
  // what the launchpad asks for at start: the tiles the packs declare, so a
  // pack appears on it without anybody editing webapp/flp.html (backlog E.2)
  hostNodes["pack-tiles"] = (a, node) => a.get(node.path, function (req, res) {
    res.json({tiles: tilesOf(process.cwd()), applications: packApplications(process.cwd())});
  });
  // a pack brings its own static files, served under its name (backlog E.2).
  // One handler, many nodes: the nodes are DERIVED from the packs
  // (tools/osd-nodes.mjs packNodes), because a pack already says its name
  // and already carries a webapp/, and asking it to repeat that in a second
  // file is the extra registry this whole track removes.
  const packDirs = new Map(webappsOf(process.cwd()).map((pack) => [`/app/${pack.name}`, pack.dir]));
  if (packDirs.size > 0) {
    hostNodes["pack-static"] = (a, node) => a.use(node.path, express.static(packDirs.get(node.path)));
  }

  // a service on another system, answered on this origin. A page this system
  // serves may then read it the way it reads ours, which a proxy on another
  // port cannot demonstrate -- see tools/osd-remote-service.mjs. Local
  // services always win: this is mounted before them and refuses any name the
  // registry has.
  // "local wins" asks the same registry the dispatcher asks, so a
  // destination can never shadow a service this system actually has
  const ours = new Set(segwRegistrations(generatorFoldersOf(process.cwd())).map((r) => r.external || r.service));
  const remote = mountRemoteServices(app, (name) => ours.has(name));
  if (remote.length > 0) {
    console.log(`remote services (a destination answers these): ${remote.join(", ")}`);
  }

  // the ADT façade: /sap/bc/adt/** answered by OSD, the off-stack
  // doppelgänger. Node rather than ABAP, because it reads the file system
  // and spawns abaplint and the transpiler, which transpiled ABAP cannot do;
  // the OData path below stays ABAP behind the ICF shim as it always was.
  // Both fronts share this listener, which is why a client points at one
  // address for both. docs/adt-facade.md is the contract.
  // the data layer of OSD boots its own runtime when it is used from a
  // command line; here one is already up, so it is handed the connection
  // rather than starting a second and re-running the seed under a live server
  // OSD_SID (or its alias STG_ADT_SID) renames the system this façade says
  // it is, and the rest of the system with it (tools/osd-identity.mjs).
  //
  // A client keys its cached compatibility metadata by system id, not by
  // project — which is why creating project after project against a system
  // whose graph had changed kept reading the graph from the first time it
  // asked, and why "make a new project" never helped. A different id is a
  // different cache entry, and the cheapest way to tell a stale cache from a
  // wrong answer.
  const store = new ObjectStore({root: process.cwd()});
  // the database is named here and handed to the child, so the registry and
  // the build endpoint say the same file the child opens — including the
  // default one, which used to be chosen inside the child and reported as
  // "memory" outside it
  // asked, not decided: tools/osd-persist.mjs holds the one answer to "does
  // this backend keep its rows in a file, and which one". This line used to
  // decide for itself, read STG_DB_PATH and never ask STG_DB, and in the
  // container -- which sets STG_DB_PATH for the volume -- that meant
  // STG_DB=hana seeded HANA and served an empty SQLite file.
  const database = databasePath(DEFAULT_DATABASE);
  const runtime = MODE === "child"
    ? store.serving({root: process.cwd(), database})
    : undefined;
  if (runtime !== undefined && adtKernel !== undefined) {
    (runtime.primary ?? runtime).adtSnapshot = parentAdtSnapshot;
  }
  if (runtime !== undefined && process.env.OSD_ADT_ONE_RUNTIME === "1") {
    for (const worker of runtime.runtimes ?? [runtime]) {
      worker.storeDestination = new StoreDestination({store});
    }
  }
  const data = MODE === "child"
    ? new Data({root: process.cwd(), runtime})
    // the facade's reads share the one connection with the steps, so they
    // wait for the work process like a step (tools/osd-dialog-step.mjs)
    : new Data({client: lockedClient(abap.context.databaseConnections["DEFAULT"], "the ADT facade's data preview")});
  // the ABAP front of the façade (ADR 0007, tools/adt-abap-front.mjs), in
  // both shapes: inline over the system's own classes, in child mode over
  // the ADT kernel above. Every ADT request enters ZCL_OSD_ADT_HANDLER, and
  // the sessions are ZCL_OSD_ADT_SESSION through AbapSessions, which
  // adtRouter makes for it (slice 3, option B, docs/adt-abap-port/
  // slice-3-front.md). OSD_ADT=js turns the front off in both.
  const adtHandler = MODE === "inline" ? inline.zcl_osd_adt_handler : adtKernel?.handler;
  // the kernel is loaded once; a generation that changes the front's classes
  // or tables is said (X-OSD-Front-Stale, one console line) until a restart
  const adtAbap = runtime !== undefined && process.env.OSD_ADT_ONE_RUNTIME === "1" && process.env.OSD_ADT !== "js"
    ? abapRunner({remote: runtime}) : adtHandler !== undefined && process.env.OSD_ADT !== "js"
    ? abapRunner({handler: adtHandler, step: dialogStep, stale: adtKernel === undefined ? undefined
      : kernelFreshness({output: adtKernel.output, loaded: adtKernel.hash, generation: () => liveHash(process.env.OSD_ROOT ?? process.cwd())})})
    : undefined;
  const facade = adtRouter({
    store,
    data,
    abap: adtAbap,
  });
  // the façade claims no path of its own -- it is a router that answers
  // /sap/bc/adt/** and passes everything else on -- so the node says the
  // prefix it answers and the registration ignores it
  hostNodes["adt-facade"] = (a) => a.use(facade.router);
  // Host memory only: this probe must answer while ABAP holds the FIFO.
  hostNodes.ready = (a, node) => a.get(node.path, (req, res) => {
    const answer = readinessAnswer(MODE, store);
    res.status(answer.status).json(answer.body);
  });
  // What a client asked the facade for and did not get.
  hostNodes["not-served"] = (a, node) => a.get(node.path, function (req, res) {
    res.json([...facade.missed.values()].sort((a, b) => b.count - a.count));
  });

  // the debugger on demand (tools/osd-inspector.mjs): POST {open, port}
  // opens or closes the serving child's inspector, GET says whether it is
  // open. Whoever may open an inspector may run code in the process, so the
  // door answers a program on this machine and nothing else:
  //  - the socket is loopback;
  //  - the Host is loopback too, which a DNS-rebound page cannot fake (its
  //    Host is its own name);
  //  - no browser: a request with an Origin, or a Sec-Fetch-Site other than
  //    none, is a web page, and a POST must be application/json, which a
  //    cross-origin page cannot send without a preflight nobody answers;
  //  - the answer carries the port and not the inspector's URL, whose uuid
  //    is the one thing that keeps a page from its WebSocket.
  // (Traced by the critic of this change, by reading and not by running a
  // browser: without the last three, a page on this machine could open the
  // inspector through a rebound name and read the URL back.)
  hostNodes.inspector = (a, node) => a.all(node.path, async function (req, res) {
    const remote = req.socket.remoteAddress ?? "";
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    const site = req.headers["sec-fetch-site"];
    const refused = !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ? "the inspector is opened from this machine only"
      : !["localhost", "127.0.0.1", "[::1]"].includes(host) ? "the inspector is opened through a loopback name only"
        : req.headers.origin !== undefined || (site !== undefined && site !== "none") ? "the inspector is not opened from a web page"
          : req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "") ? "the inspector door takes application/json"
            : undefined;
    if (refused !== undefined) {
      res.status(403).json({error: refused});
      return;
    }
    if (runtime === undefined) {
      res.status(409).json({error: "this listener serves inline, in its own process: start it with STG_SERVE=child, or with OSD_INSPECT=<port>"});
      return;
    }
    if (req.method === "GET") {
      const inspecting = (runtime.runtimes?.[0] ?? runtime).inspecting;
      const port = inspecting === null ? undefined : inspecting?.port ?? inspectPortOf(process.env.OSD_INSPECT);
      res.json({open: port !== undefined, port});
      return;
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "GET, POST").end();
      return;
    }
    let request;
    try {
      request = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
    } catch {
      res.status(400).json({error: "the body is not JSON: {\"open\": true, \"port\": <port>}"});
      return;
    }
    try {
      const answer = await runtime.inspector({open: request?.open === true, port: request?.port});
      res.json({open: answer.open, port: answer.port, ...(answer.pending ? {pending: true} : {}),
        ...(answer.recycled ? {recycled: true, recovering: answer.recovering === true} : {})});
    } catch (e) {
      res.status(409).json({error: String(e?.message ?? e)});
    }
  });

  // and now everything the registry declares for this host, in its order
  const declaredNodeList = nodes(process.cwd(), {proxies: false});
  mountHost(app, declaredNodeList, hostNodes, {host: "test/start.mjs"});
  // SICF: every other ICF service this tree carries.
  //
  // The OData front is one if_http_extension on one path; a system has many,
  // and which class answers which URL is what SICF holds. A repository that
  // brings a *.sicf.xml brings its own route with it, so an application can
  // be imported and served without this file learning its name. Mounted
  // before the OData front only so the claimed prefixes below are meaningful.
  // the paths another registry already owns -- the OData front and the ADT
  // façade -- asked of that registry instead of written out again here. The
  // same two strings used to sit in this file and in tools/osd-serve.mjs,
  // equal by nobody's effort.
  const claimed = declaredNodeList.filter((n) => n.source.endsWith("nodes.json")).map((n) => n.path);
  // SAP Easy Access reads the same five tables ZOSD_STATUS_SRV reads
  // (src/webgui/, docs/webgui.md), so it pays for the same refresh. It is
  // registered here, before the SICF mount below, because that mount answers
  // the request instead of passing it on: a middleware added after it would
  // never run.
  app.all("/sap/bc/gui/sap/its/webgui*", withFreshStatus);
  let icf;
  if (MODE === "inline") {
    icf = mountServices(app, (args) => dialogStep(() => inline.cl_express_icf_shim.run({
      ...args,
      base: new abap.types.String().set(args.base),
    }), `ICF ${args.base}`), {root: process.cwd(), claimed, from: inline.icf});
  } else {
    // **The child owns the registry, so the parent forwards the branch and
    // does not keep a list of its own.**
    //
    // This used to derive the paths from the `*.sicf.xml` files and mount
    // one proxy each, which made the parent a second registry -- and a
    // wrong one the moment the child's differed. The child mounts from
    // `ICFSERVICE` now (tools/osd-serve.mjs), so a node deactivated from
    // /sap/bc/osd/sicf/ was still advertised here and 404'd there, and a
    // node that existed only as a row would have been unreachable however
    // correctly the registry described it.
    //
    // One forward for the ICF branch, minus what a declared node already
    // owns, and the child decides. That is what a system does: the parent
    // is a dispatcher, not an inventory.
    const forwarded = (req, res, next) =>
      (claimed.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))
        ? next()
        : odataProxy(runtime)(req, res, next));
    app.all("/sap/bc/*", forwarded);
    // what the files say, for the startup line only: the parent no longer
    // decides with it, and a difference from the child is now a thing the
    // registry screen shows rather than a route that is missing
    icf = icfServices(process.cwd()).filter((s) => s.handler !== undefined && s.type === "ABAP"
      && claimed.some((prefix) => s.path === prefix || s.path.startsWith(`${prefix}/`)) === false);
  }
  if (quiet !== true && icf.length > 0) {
    for (const service of icf) {
      console.log(`ICF service  on http://localhost:${PORT}${service.path}  (${service.handler})${MODE === "child" ? "  [proxied]" : ""}`);
    }
  }

  // The system status, refreshed by the read that asks for it.
  //
  // ZOSD_STATUS_SRV is five tables, and ABAP cannot fill them: the pool's
  // children, the listeners this process opened and the generation it built
  // are facts of the facade. So a request for that service — and only that
  // service, because nothing else should pay for it — computes the snapshot
  // (tools/osd-status.mjs) and posts it to the work process the proxy is
  // about to forward to, which is the one whose connection will answer.
  //
  // A refresh that fails never fails the read. The rows are still there from
  // the last one, and a status page a few seconds stale is worth more than a
  // 500 that says nothing about the system it was asked about.
  const listeners = [];

  function postSnapshot(url, body) {
    return new Promise((resolve, reject) => {
      const asked = httpRequest({
        hostname: "127.0.0.1",
        port: Number(new URL(url).port),
        path: "/sap/bc/osd/status/",
        method: "POST",
        headers: {"content-type": "application/json", "content-length": Buffer.byteLength(body)},
      }, (answer) => {
        let text = "";
        answer.on("data", (d) => {
          text = text + d.toString();
        });
        answer.on("end", () => (answer.statusCode === 200 ? resolve(text) : reject(new Error(`/sap/bc/osd/status/ answered ${answer.statusCode}: ${text.slice(0, 200)}`))));
      });
      asked.on("error", reject);
      asked.end(body);
    });
  }

  async function refreshStatus() {
    const body = JSON.stringify(await statusSnapshot(process.cwd(), {runtime, listeners}));
    if (runtime === undefined) {
      // inline: this process holds the tables
      await dialogStep(() => inline.zcl_osd_status.refresh({iv_json: body}), "the status refresh");
      return;
    }
    await runtime.ensure();
    // the address odataProxy forwards to: a pool answers for its primary,
    // so the snapshot lands in the process that is about to be asked
    const url = runtime.url;
    if (url === undefined) {
      throw new Error("no serving runtime to refresh the status in");
    }
    await postSnapshot(url, body);
  }

  // A refresh that fails never fails the read: see above.
  async function withFreshStatus(req, res, next) {
    // still booting: no refresh (it would wait for the whole boot); the
    // proxy then answers "starting"
    if (runtime?.booting !== undefined && runtime.running !== true) {
      next();
      return;
    }
    try {
      await refreshStatus();
    } catch (e) {
      console.error(`status refresh: ${e?.message ?? e}`);
    }
    next();
  }

  app.all("/sap/opu/odata/sap/ZOSD_STATUS_SRV*", withFreshStatus);

  // The OData front, in one of two places.
  //
  // Inline is this process: the modules imported at the top of this file
  // answer the request. It is what a test wants, because it costs no child
  // and no second database, and it is what the browser preview is built
  // from. Its limit is the reason the other mode exists: Node pins a module
  // graph for the life of a process, so code activated through the façade is
  // never live here until somebody restarts the whole listener, and that
  // restart takes the developer's ADT session with it.
  //
  // Child is a process the façade supervises and replaces after a successful
  // transpile (tools/osd-runtime.mjs), which is the only way an activation
  // can honestly report that the code is live. STG_SERVE=child asks for it;
  // npm run osd:serve sets it, and nothing else does, so a suite that never
  // activates anything pays nothing for the ability.

  if (runtime !== undefined) {
    app.all("/sap/opu/odata/sap/*", odataProxy(runtime));
    // the doors the child implements itself (/osd/serving, /osd/dumps,
    // /osd/sql) are declared for tools/osd-serve.mjs, and a client of this
    // listener -- an editor's status bar, a dump list -- asks here, not at
    // the child's loopback port. Forwarded by what the registry says that
    // host serves, so a door added there needs no line here.
    // /osd/serving is the child's answer plus what only this process knows:
    // the warm build (tools/osd-warm.mjs), which lives here with the store;
    // still the declared node, forwarded like the others, with one field more
    // The launcher owns this front PID, not the recyclable runtime worker PID.
    // Editors use it to reject a different system that later takes this port.
    const withWarm = servingFront(runtime, {launcherIdentity,
      warmStatus: () => facade.store.warmStatus(), bind: bindAddresses});
    const localBatch = (proxy) => (req, res, next) => {
      const address = req.socket.remoteAddress ?? "";
      if (address !== "::1" && !/^127\./.test(address) && !/^::ffff:127\./.test(address)) {
        res.status(403).json({error: {code: "LOCAL_ONLY"}});
        return;
      }
      proxy(req, res, next);
    };
    app.get("/osd/job-counts", localBatch(odataProxy(runtime)));
    for (const node of declaredNodeList.filter((n) => !n.internal && n.type === "HOST" && n.implementedIn === "tools/osd-serve.mjs")) {
      const proxy = odataProxy(runtime);
      app.all(node.path, node.path === "/osd/serving" ? withWarm
        : node.path === "/osd/batch-runs" ? localBatch(proxy) : proxy);
    }
    // STG_DEV=1: the disk is the other editor. A save becomes a check, a
    // build and a recycle of this runtime (tools/osd-dev.mjs), and the
    // runtime is started now rather than at the first request, so the first
    // save has something to recycle and the app is up when you look.
    if (process.env.STG_DEV === "1") {
      devLoop({store: facade.store});
    }
    // OSD_WARM=1: the registry is kept, and a save of a class or an
    // interface is built and swapped in without a new process
    // (tools/osd-warm.mjs); primed once the runtime is up
    if (process.env.OSD_WARM === "1") {
      runtime.start().then(() => facade.store.warmUp(), () => undefined);
    }
    // the system comes up with the listener, not at the first request: the
    // app is there when you look, the registry names it, and the build
    // endpoint has a serving generation to compare with from the start
    runtime.start().then(
      (r) => {
        // a pool answers with one entry per work process; one runtime with
        // an answer of its own, as before (tools/osd-pool.mjs)
        const started = Array.isArray(r) ? r : [r];
        if (quiet === true) {
          return;
        }
        for (const one of started) {
          console.log(`serving generation ${one.generation} on ${one.url} (${one.pid}), rows in ${database ?? "memory"}`);
        }
        if (started.length > 1) {
          console.log(`${started.length} work processes; a push channel is pinned to one for the life of its socket`);
        }
        // the status tables have something in them before anybody asks
        refreshStatus().catch((error) => console.error(`status refresh: ${error?.message ?? error}`));
      },
      (e) => console.error(`runtime: ${e.message}`),
    );
  } else {
    app.all("/sap/opu/odata/sap/*", async function (req, res) {
      try {
        // the kernel's end of a dialog step: commit when the work is done,
        // roll back when it ends in an exception nobody declared. Without it
        // a request that dumps leaves its rows pending on the connection and
        // the next modifying request's fencing COMMIT WORK adopts them
        // (tools/osd-dialog-step.mjs)
        await dialogStep(() => inline.cl_express_icf_shim.run({
          req,
          res,
          class: "ZCL_STG_HTTP_HANDLER",
          base: new abap.types.String().set("/sap/opu/odata/sap"),
        }));
      } catch (e) {
        // a runtime (kernel) error is not an ABAP exception the dispatcher can
        // catch; answer instead of leaving the client hanging
        if (!res.headersSent) {
          res.status(500).type("application/json").send(JSON.stringify({error: {code: "STG/RUNTIME", message: {lang: "en", value: String(e?.message?.get?.() ?? e?.message ?? e)}}}));
        }
        console.error("runtime error:", e);
      }
    });
  }

  // **The port is a property of the run, and the hooks cannot be trusted to
  // free it.** `close()` was made awaitable earlier tonight so that
  // `after(() => server?.close())` would wait -- and three suites write it
  // that way while twelve write `after(() => { server?.close(); })`, which
  // returns undefined and waits for nothing. Fixing the mechanism and
  // leaving the callers to use it correctly is the defect this tree has
  // recorded seven times; the eighth was mine, four hours after I wrote the
  // rule down.
  //
  // So binding does not depend on how a hook was written: if the port is
  // still held by a server this module started, wait for that close and try
  // again. Measured before: a full suite run on a free port answered
  // EADDRINUSE twenty-four times.
  //
  // The host is OSD_BIND, loopback unless said otherwise (tools/osd-bind.mjs):
  // the ADT facade takes any credentials, which is only fine while nothing
  // but this machine reaches it. A container sets OSD_BIND=0.0.0.0.
  const server = listenBound(createHttpServer(app), PORT);
  server.on("error", (error) => {
    if (error?.code !== "EADDRINUSE" || closing === undefined) throw error;
    void closing.then(() => relisten(server, PORT));
  });

  // Push channels: the websocket half of what a repository declares.
  //
  // A *.sapc.xml names a path, a handler class and whether it is stateful,
  // and tools/osd-apc.mjs drives that handler through zcl_apc_host, so a
  // class written for cl_apc_wsp_ext_stateful_base runs here unchanged. The
  // upgrade is answered on this listener rather than proxied to the serving
  // child, which is a limit worth knowing: an activated push channel does
  // not go live until this process restarts, the way the OData path did
  // before it was proxied. Written down in docs/adt-facade.md.
  const declared = pushChannels(process.cwd());
  let channels;
  if (MODE === "inline") {
    channels = mountChannels(server, declared, {
      host: inline.zcl_apc_host,
      log: (line) => console.error(line),
    });
  } else {
    // the upgrade is proxied to the child, which answers it with the
    // handler of the generation it runs; an activated channel goes live
    // with the recycle, which the inline shape could never do
    channels = declared;
    if (declared.length > 0) {
      server.on("upgrade", upgradeProxy(runtime, declared.map((c) => c.path), (line) => console.error(line)));
    }
  }
  if (quiet !== true) {
    for (const channel of channels) {
      console.log(`Push channel on ws://localhost:${PORT}${channel.path}  (${channel.handler})${MODE === "child" ? "  [proxied]" : ""}`);
    }
  }

  // HTTPS beside it, on the SAP-shaped port for this instance. Eclipse
  // refuses a plain-HTTP project outright, so without TLS that client cannot
  // reach OSD at all; other clients keep the plain port and lose nothing.
  // The certificate is self-signed and lives outside this repository.
  const TLS_PORT = Number(process.env.STG_TLS_PORT ?? 44300 + (PORT % 100));
  const tls = process.env.STG_TLS === "0" ? undefined : tlsCredentials();
  let secure;
  if (tls !== undefined) {
    secure = listenBound(createHttpsServer(tls, app), TLS_PORT);
  }

  // Open the sockets first. Discovery waits for this same warm-up on both
  // fronts, with a silence bound. This parent registry serves ADT Unit plans
  // and risk/xref reads independently of the compiler registry. Keep both
  // (measured RSS in docs/warm-compile.md). The synchronous parse still blocks
  // readiness and unrelated routes until it finishes. Bind-only tests opt out.
  if (quiet !== true && process.env.OSD_UNIT_WARM !== "0") {
    facade.store.unitReady = new Promise((resolve) => setImmediate(resolve))
      .then(() => warmUnitPlan(facade.store))
      .then((warmed) => {
        console.log(`unit plan: pre-warmed ${warmed.objects} objects and xref graph in ${Math.round(warmed.ms)} ms`);
      }).catch((error) => {
        console.error(`unit plan: pre-warm failed: ${error?.message ?? error}`);
      });
  }

  // what the snapshot reports as this instance's ports: what was opened here
  const bound = `bound to ${describeBind()}`;
  listeners.push({port: PORT, protocol: "HTTP", purpose: "OData, apps, ADT", note: bound});
  if (secure !== undefined) {
    listeners.push({port: TLS_PORT, protocol: "HTTPS", purpose: "the same, for a client that refuses plain HTTP", note: bound});
  }

  if (quiet !== true) {
    console.log("Listening on http://localhost:" + PORT + "/sap/opu/odata/sap/  (bound to " + describeBind() + ")");
    if (bindHint() !== undefined) {
      console.log(bindHint());
    }
    console.log("ADT façade   on http://localhost:" + PORT + "/sap/bc/adt/core/discovery");
    if (secure === undefined) {
      console.log("No TLS: run `npm run osd:tls` to make a certificate, for a client that refuses plain HTTP");
    } else {
      console.log("HTTPS        on https://localhost:" + TLS_PORT + "  (self-signed, sha256 " + tlsFingerprint() + ")");
      console.log("             the certificate is " + tlsDirOf(process.cwd()) + "/osd.crt; a client will ask once whether to trust it");
    }
  }

  const close = server.close.bind(server);
  // **Returns a promise when called without a callback**, and that is what
  // makes the suites wait. Every one of them writes `after(() =>
  // server?.close())`, and a mocha hook waits for what its function returns;
  // this returned the server object, so the hook finished while the listener
  // was still closing and the next file's `before` met the port still bound.
  //
  // Measured on HANA, where closing takes longer because the connections do:
  // 28 of 26 failures in a full run were `EADDRINUSE`, on this port and on
  // the supervised runtime's. Not on SQLite, where the race is simply won --
  // which is why this sat unnoticed while one backend was fast enough.
  //
  // `runtime.stop()` is awaited for the same reason it exists: the child
  // holds the port and the database the next listener needs, and `void` on
  // it meant "start stopping and carry on".
  server.close = (cb) => {
    closing = (async () => {
      await closeWarm(facade.store);
      await new Promise((resolve) => (secure === undefined ? resolve() : secure.close(resolve)));
      await runtime?.stop();
      await new Promise((resolve) => close(resolve));
    })();
    if (typeof cb === "function") {
      closing.then(() => cb(), error => cb(error));
      return server;
    }
    return closing;
  };
  return server;
}
