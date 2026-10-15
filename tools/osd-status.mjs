import {rootWebappOf} from "./osd-system.mjs";
// What this system is, right now, as one JSON object.
//
// The façade is the only process that can answer the question. It knows
// which listeners it opened, which children the pool started and on what
// ports, which generation it built and which one is actually serving, what
// the content layers into the tree. The ABAP side owns the tables and the
// service (src/status/, ZOSD_STATUS_SRV) and cannot see any of that, so
// this computes the snapshot and ZCL_OSD_STATUS=>REFRESH writes it.
//
// The shape below is the contract, and the Fiori app is built against it:
//
//   {"system":{"sid","host_kind","gen_live","gen_serving","synced",
//              "workers","started_at","snap_at","root_hint","pid"},
//    "processes":[{"pid","role","port","generation","epoch","since",
//                  "sockets","rss_mb","alive"}],
//    "ports":[{"port","protocol","purpose","state","note"}],
//    "services":[{"path","kind","handler","text","pack"}],
//    "packs":[{"name","order","objects","folders","description"}],
//    "database":[{"section","name","value","note"}]}
//
// Counts and coarse platform labels only. No host names, no user names, no addresses, no absolute
// paths, no identity of whoever is connected: a status page that leaks the
// machine it runs on is a status page nobody can publish, and this one is
// served to anyone who can reach the port. `root_hint` is the tree's
// basename and nothing above it.
import {createConnection} from "node:net";
import {release as kernelRelease} from "node:os";
import {basename, join, relative, resolve} from "node:path";
import {readFileSync, readdirSync} from "node:fs";
import {createRequire} from "node:module";
import {DEFAULT_DATABASE} from "./sqlite-file-client.mjs";
import {liveHash} from "./osd-build.mjs";
import {instances} from "./osd-runtime.mjs";
import {services as icfServices, channels as pushChannels} from "./osd-icf.mjs";
import {registeredServices, segwRegistrations} from "./segw-registry.mjs";
import {generatorFoldersOf, folderOf, packsOf, webappsOf} from "./osd-packs.mjs";
import {layers} from "./osd-inputs.mjs";
import {identity} from "./osd-identity.mjs";
import {databaseDescriptor} from "./osd-database-identity.mjs";

const PAGE = 4096;

/** node, a compiled Bun binary, or a Node single executable */
export function hostKind() {
  if (typeof globalThis.Bun !== "undefined") {
    return "bun";
  }
  try {
    return createRequire(import.meta.url)("node:sea").isSea() ? "sea" : "node";
  } catch {
    return "node";
  }
}

// The local ports of /proc/net/tcp, by state. Cheaper than spawning `ss`
// and it says the same thing; a system without /proc (or one that will not
// let this process read it) falls back to a connect, which is why the
// callers are async.
function procTcp() {
  const rows = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const port = Number.parseInt(parts[1].split(":")[1], 16);
      if (Number.isNaN(port)) {
        continue;
      }
      rows.push({port, state: parts[3]});
    }
  }
  return rows;
}

/** how many connections are established on this port; a count, never a peer */
export function socketsOn(port, rows = procTcp()) {
  return rows.filter((r) => r.port === port && r.state === "01").length;
}

/** is something listening there? /proc first, a connect when it cannot say */
export async function isListening(port, rows = procTcp()) {
  if (rows.length > 0) {
    return rows.some((r) => r.port === port && r.state === "0A");
  }
  return new Promise((done) => {
    const socket = createConnection({host: "127.0.0.1", port});
    const answer = (yes) => {
      socket.destroy();
      done(yes);
    };
    socket.setTimeout(200);
    socket.once("connect", () => answer(true));
    socket.once("timeout", () => answer(false));
    socket.once("error", () => answer(false));
  });
}

/** the resident size of another process, from /proc; undefined when it cannot be read */
export function rssMb(pid) {
  try {
    const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/)[1]);
    return Number.isFinite(pages) ? Math.round((pages * PAGE) / 1048576) : undefined;
  } catch {
    return undefined;
  }
}

/** the runtimes a supervisor holds: a pool has several, a plain one has itself */
function runtimesOf(runtime) {
  if (runtime === undefined) {
    return [];
  }
  return Array.isArray(runtime.runtimes) ? runtime.runtimes : [runtime];
}

// The UI5 applications this tree serves, out of their own manifests.
//
// An app is a folder with a `manifest.json` in it: `webapp/` itself is one
// (stg.travel), every folder below it is another, and a pack that brings a
// webapp is served the same way. The manifest already says everything a
// listing needs -- `sap.app.id` is the component that answers, `title` is
// what a human calls it -- so nothing here is a second list that can drift
// from the first.
//
// The path is the launchpad with the app's own inbound intent
// (`crossNavigation.inbounds`), not the folder: `webapp/booking` has no
// index.html at all and is only ever reached through the launchpad, and a
// system's menu should point where the launchpad points rather than at a
// folder that happens to have a page in it.
export function appsOf(root, env = process.env) {
  const out = [];
  const folders = [{name: "", dir: rootWebappOf(root, env), pack: ""}];
  try {
    for (const entry of readdirSync(rootWebappOf(root, env), {withFileTypes: true})) {
      if (entry.isDirectory()) {
        folders.push({name: entry.name, dir: join(rootWebappOf(root, env), entry.name), pack: ""});
      }
    }
  } catch {
    // no webapp folder: a tree that serves no UI5 app is a tree with no apps
  }
  for (const one of webappsOf(root, env)) {
    folders.push({name: one.name, dir: one.dir, pack: one.name});
  }
  for (const folder of folders) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(folder.dir, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    const app = manifest["sap.app"] ?? {};
    const intent = Object.keys(app.crossNavigation?.inbounds ?? {})[0];
    const page = folder.name === "" ? "/app/index.html" : `/app/${folder.name}/index.html`;
    out.push({
      path: intent === undefined ? page : `/app/flp.html#${intent}`,
      kind: "APP",
      handler: String(app.id ?? ""),
      text: String(app.title ?? app.id ?? folder.name),
      pack: folder.pack,
      dir: folder.dir,
    });
  }
  return out;
}

/** the OData, ICF, push and UI5 services this tree serves, each with its pack */
export function servicesOf(root, env = process.env) {
  return serviceTree(root, env).map(({path, kind, handler, text, pack}) => ({path, kind, handler, text, pack}));
}

/**
 * The same list with what an editor needs to go from a row to its source:
 * the file that declares it (the IWSV, the SICF or SAPC object, the app's
 * manifest folder), relative to the root, and for an OData service its MPC
 * and external name. One inventory: servicesOf is this list with the five
 * columns the status tables keep.
 */
export function serviceTree(root, env = process.env) {
  const out = [];
  const packs = packsOf(root, env);
  const owners = layers(root, undefined, env).owner;
  const packOf = (file) => {
    const at = resolve(root, file);
    return packs.find((p) => p.abap.some((f) => at === resolve(f) || at.startsWith(resolve(f) + "/")))?.name ?? "";
  };
  const rel = (file) => (file === undefined ? undefined : relative(root, resolve(root, file)));
  const folders = generatorFoldersOf(root, env).map((f) => join(root, f));
  for (const one of registeredServices(segwRegistrations(folders))) {
    out.push({
      path: `/sap/opu/odata/sap/${one.external}`,
      kind: "ODATA",
      handler: one.dpc ?? "",
      text: one.description ?? "",
      pack: packOf(owners.get(`CLAS ${one.dpc.toUpperCase()}`) ?? ""),
      name: one.external,
      mpc: one.mpc ?? "",
      source: rel(one.file),
    });
  }
  for (const one of icfServices(root)) {
    if (one.handler === undefined) {
      continue;
    }
    out.push({path: one.path, kind: "ICF", handler: one.handler, text: one.description ?? "", pack: packOf(one.source),
      name: one.name ?? one.path, source: rel(one.source)});
  }
  for (const one of pushChannels(root)) {
    out.push({path: one.path, kind: "APC", handler: one.handler, text: one.description ?? "", pack: packOf(one.source),
      name: one.name ?? one.path, source: rel(one.source)});
  }
  out.push(...appsOf(root, env).map(({dir, ...one}) => ({...one, name: one.handler, source: rel(dir)})));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** the packs layered into this tree, with how many objects each of them owns */
export function packsInfo(root, env = process.env) {
  let owner;
  try {
    owner = layers(root).owner;
  } catch {
    owner = new Map();
  }
  return packsOf(root, env).map((pack) => {
    const folders = pack.abap.map((f) => folderOf(root, f));
    let objects = 0;
    for (const folder of owner.values()) {
      if (folders.includes(folder)) {
        objects = objects + 1;
      }
    }
    return {
      name: pack.name,
      order: pack.order,
      objects,
      folders: folders.join(", "),
      description: pack.description ?? "",
    };
  });
}

/** Safe backend facts. A connected client is authoritative; the environment
 * fallback is explicitly marked configured because the parent façade may
 * refresh status while the serving child owns the actual connection. */
export function databaseFacts({client = globalThis.abap?.context?.databaseConnections?.DEFAULT, env = process.env} = {}) {
  // Explicit null means no observed connection; omitted uses this process.
  const liveClient = client ?? undefined;
  const configured = String(env.STG_DB ?? "file").toLowerCase();
  const rawEngine = String(liveClient?.name ?? (configured === "file" ? "sqlite" : configured)).toLowerCase();
  const engines = {file: "sqlite", sqlite: "sqlite", duckdb: "duckdb", hana: "HDB", hdb: "HDB", postgres: "postgres"};
  const engine = Object.hasOwn(engines, rawEngine) ? engines[rawEngine] : "unknown";
  const path = liveClient === undefined
    ? env.STG_DB_PATH ?? (configured === "file" ? DEFAULT_DATABASE : undefined)
    : liveClient.path;
  const storage = engine === "HDB" || engine === "postgres"
    ? "server"
    : path === undefined || path === "" || path === ":memory:"
      ? "memory"
      : "file";
  const connected = databaseDescriptor(liveClient).connected;
  return databaseRows(engine, storage, connected);
}

function databaseRows(engine, storage, connected) {
  return [
    {section: "Database", name: "Engine", value: engine, note: connected ? "connected backend" : "configured backend; connection not observed"},
    {section: "Database", name: "Storage", value: storage, note: storage === "file" ? "persistent database storage" : storage === "server" ? "external database server" : "process memory"},
  ];
}

// A container's /etc/os-release describes the image, not the host. The
// optional host release must be mounted read-only by its operator.
function osRelease(text) {
  const fields = new Map();
  for (const line of String(text).slice(0, 4096).split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields.set(match[1], value.replace(/\\(["'\\])/g, "$1"));
  }
  const name = fields.get("NAME") ?? fields.get("ID") ?? "";
  const version = fields.get("VERSION_ID") ?? "";
  const codename = fields.get("VERSION_CODENAME") ?? "";
  return [name, version, codename ? `(${codename})` : ""].filter(Boolean).join(" ");
}

function safeLabel(value, max = 120) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Only coarse labels; never a hostname, serial number, address or path. */
export function platformFacts({read = readFileSync, platform = process.platform, arch = process.arch, kernel = kernelRelease()} = {}) {
  const file = (path) => {
    try { return read(path, "utf8"); } catch { return ""; }
  };
  const facts = [
    {section: "Platform", name: "Architecture", value: safeLabel(`${platform}/${arch}`), note: "runtime platform"},
    {section: "Platform", name: "Kernel", value: safeLabel(kernel), note: "host kernel shared with the container"},
  ];
  const runtimeOS = safeLabel(osRelease(file("/etc/os-release")));
  if (runtimeOS) facts.push({section: "Platform", name: "Runtime OS", value: runtimeOS, note: "OS inside the container or local runtime"});
  const hostOS = safeLabel(osRelease(file("/run/host/os-release")));
  if (hostOS) facts.push({section: "Platform", name: "Host OS", value: hostOS, note: "operator-provided read-only host release"});
  const model = safeLabel(file("/run/host/device-model") || file("/proc/device-tree/model") || file("/sys/firmware/devicetree/base/model"));
  if (model) facts.push({section: "Platform", name: "Device", value: model, note: "board model; no serial number"});
  return facts;
}

// Only ask the supervisor's local child, never an environment-supplied URL.
// Failure is an observation, not permission to label configured data connected.
export async function childDatabaseFacts(runtime, {fetcher = fetch, timeoutMs = 1000} = {}) {
  if (!runtime?.url) return undefined;
  try {
    const url = new URL(runtime.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return undefined;
    url.pathname = "/osd/serving";
    url.search = "";
    url.hash = "";
    const res = await fetcher(url, {signal: AbortSignal.timeout(timeoutMs), redirect: "error"});
    if (!res.ok) return undefined;
    const body = await res.json();
    const d = body.databaseIdentity;
    if (body.ready !== true || body.generation !== runtime.generation || d?.connected !== true ||
        !["sqlite", "duckdb", "HDB", "postgres"].includes(d.engine) ||
        !(["HDB", "postgres"].includes(d.engine) ? d.storage === "server" : ["file", "memory"].includes(d.storage))) return undefined;
    return databaseRows(d.engine, d.storage, true);
  } catch {
    return undefined;
  }
}

// The ports this instance has, including the built-in JS protocol listeners.
// They run beside the HTTP façade so the status probe observes their sockets;
// an absent row means STG_PROTOCOLS=0 or startup has not completed.
export async function portsOf(listeners = [], options = {}) {
  const rows = procTcp();
  const out = [];
  const seen = new Set();
  for (const one of listeners) {
    const port = Number(one.port);
    if (!Number.isFinite(port) || seen.has(port)) {
      continue;
    }
    seen.add(port);
    out.push({
      port,
      protocol: String(one.protocol ?? "HTTP"),
      purpose: String(one.purpose ?? ""),
      state: (await isListening(port, rows)) ? "listening" : "absent",
      note: String(one.note ?? ""),
    });
  }
  // the SAP-shaped neighbours of this instance's number, the way the TLS
  // port is 44300 + the instance (test/start.mjs)
  const instance = Number(options.instance ?? 0) % 100;
  const configuredPort = (value, fallback) => {
    const port = Number(value);
    return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : fallback;
  };
  const siblings = [
    {port: configuredPort(options.rfcPort, 3300 + instance), protocol: "RFC", purpose: "RFC-to-ADT gateway", note: "built-in JS protocol listener is disabled or not ready"},
    {port: configuredPort(options.diagPort, 3200 + instance), protocol: "DIAG", purpose: "DIAG tape dispatcher", note: "built-in JS protocol listener is disabled or not ready"},
  ];
  for (const one of siblings) {
    if (seen.has(one.port)) {
      continue;
    }
    seen.add(one.port);
    const up = await isListening(one.port, rows);
    out.push({
      port: one.port,
      protocol: one.protocol,
      purpose: one.purpose,
      state: up ? "listening" : "absent",
      note: up ? "" : one.note,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

/** the whole snapshot, in the shape ZCL_OSD_STATUS=>REFRESH parses */
export async function snapshot(root = process.cwd(), options = {}) {
  const env = options.env ?? process.env;
  const runtime = options.runtime;
  const now = options.now ?? new Date();
  const started = options.startedAt ?? new Date(Date.now() - (options.uptime ?? process.uptime()) * 1000);
  const live = options.genLive ?? liveHash(root) ?? "";
  const serving = runtime?.generation ?? "";
  const children = runtimesOf(runtime);
  const registered = new Map((options.instances ?? instancesOf(root)).map((e) => [e.pid, e]));
  const rows = procTcp();

  const facadePort = Number(options.listeners?.[0]?.port ?? 0);
  const processes = [{
    pid: process.pid,
    role: "facade",
    port: facadePort,
    generation: live,
    epoch: 0,
    since: started.toISOString(),
    sockets: socketsOn(facadePort, rows),
    rss_mb: Math.round((options.rss ?? process.memoryUsage().rss) / 1048576),
    alive: true,
  }];
  for (const one of children) {
    const pid = one.child?.pid;
    if (pid === undefined) {
      continue;
    }
    const entry = registered.get(pid);
    processes.push({
      pid,
      role: "work",
      port: Number(one.port ?? 0),
      generation: String(one.generation ?? ""),
      epoch: Number(one.epoch ?? 0),
      since: String(entry?.since ?? started.toISOString()),
      sockets: socketsOn(Number(one.port ?? 0), rows),
      rss_mb: rssMb(pid) ?? 0,
      alive: one.running === true,
    });
  }

  return {
    system: {
      // one source for what this system is called, shared with the boot that
      // sets sy-sysid and with the ADT façade (tools/osd-identity.mjs)
      sid: identity(env).sid,
      host_kind: options.hostKind ?? hostKind(),
      gen_live: live,
      gen_serving: serving,
      synced: live !== "" && live === serving,
      workers: children.length,
      started_at: started.toISOString(),
      snap_at: now.toISOString(),
      root_hint: basename(resolve(root)),
      // which process these tables are written in, and therefore the process
      // that will answer the read: the façade when it holds the ABAP itself,
      // and otherwise the work process the snapshot is posted to. It is the
      // work process number SAP Easy Access prints where SAP GUI prints the
      // session (src/webgui/), and it is not invented anywhere.
      pid: servingPid(runtime, processes),
    },
    processes,
    ports: await portsOf(options.listeners ?? [], {
      instance: /^\d{2}$/.test(String(env.INSTANCE ?? "")) ? env.INSTANCE : facadePort,
      diagPort: env.STG_DIAG_PORT,
      rfcPort: env.STG_RFC_PORT,
    }),
    services: options.services ?? servicesOf(root, env),
    packs: options.packs ?? packsInfo(root, env),
    database: [...(options.database ?? await childDatabaseFacts(runtime) ?? databaseFacts({client: options.client, env})),
      ...(options.platform ?? platformFacts())],
  };
}

// The process the tables live in. Inline (no child) that is this process;
// with a pool it is the child the façade posts the snapshot to, which is the
// one the proxy forwards the request to — matched by the port of runtime.url,
// because that is the address both of them use.
function servingPid(runtime, processes) {
  if (runtime === undefined) {
    return process.pid;
  }
  let port = 0;
  try {
    port = Number(new URL(String(runtime.url)).port);
  } catch {
    port = 0;
  }
  const work = processes.filter((one) => one.role === "work");
  const found = work.find((one) => one.port === port && port !== 0);
  return Number(found?.pid ?? work[0]?.pid ?? 0);
}

function instancesOf(root) {
  try {
    return instances(root);
  } catch {
    return [];
  }
}

if (process.argv[1] && /osd-status\.mjs$/.test(process.argv[1])) {
  const root = resolve(process.argv[2] ?? process.cwd());
  console.log(JSON.stringify(await snapshot(root, {listeners: [{port: Number(process.env.STG_PORT ?? 3030), protocol: "HTTP", purpose: "OData, apps, ADT"}]}), null, 2));
}
