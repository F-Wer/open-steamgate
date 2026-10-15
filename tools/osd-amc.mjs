// Local AMC broker. SEND publishes outside the database LUW; receiver calls
// are scheduled separately when their session is in a WAIT.
import {readFileSync, readdirSync, statSync} from "node:fs";
import {basename, join} from "node:path";
import {generatorFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {currentStepToken, dialogStep, inSession, outsideStepContext, registerWaitPump} from "./osd-dialog-step.mjs";
import {parseSamc} from "./osd-samc.ts";
export {parseSamc} from "./osd-samc.ts";

const keyOf = (app, path) => `${String(app).trim().toUpperCase()}|${String(path).trim().toLowerCase()}`;

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const file = join(dir, entry);
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (stat.isDirectory()) walk(file, out);
    else if (entry.toLowerCase().endsWith(".samc.xml")) out.push(file);
  }
}

export function amcChannels(root = process.cwd(), roots = generatorFoldersOf(root)) {
  const files = winningByLayer(roots, (dir) => {
    const found = [];
    walk(join(root, dir), found);
    return found;
  }, (file) => basename(file).toUpperCase());
  const definitions = files.flatMap((file) => parseSamc(readFileSync(file, "utf8"), file));
  return [...new Map(definitions.map((row) => [keyOf(row.applicationId, row.path), row])).values()];
}

// A channel extension is CHAR 60 in the ABAP signatures, so trailing blanks
// carry no meaning: a producer passes the padded value while an APC binding
// keeps it in a STRING, which drops them. Compare the meaningful part only:
// the padding is U+0020, so a trailing tab or no-break space still counts.
const channelExtension = (extension) => String(extension ?? "").replace(/ +$/, "");

export class AmcBroker {
  constructor(channels) {
    this.channels = new Map(channels.map((row) => [keyOf(row.applicationId, row.path), row]));
    this.subscribers = new Set();
  }

  channel(app, path, activity, program) {
    const row = this.channels.get(keyOf(app, path));
    if (!row) throw new Error(`AMC channel ${app} ${path} is not defined.`);
    const authorised = row.authorities.some((one) => one.path === row.path
      && one.activity === activity && one.program === program?.toUpperCase());
    if (!authorised) throw new Error(`AMC ${activity === "S" ? "send" : "receive"} is not authorised for ${program ?? "unknown program"}.`);
    return row;
  }

  // activity R = AMC consumer; C = an APC WebSocket bound with bind_amc_message_consumer.
  subscribe({app, path, program, session, receive, extension = "", client, username, activity = "R"}) {
    const channel = this.channel(app, path, activity, program);
    const subscription = {channel, session, receive, extension: channelExtension(extension), client, username, pending: [], active: true};
    this.subscribers.add(subscription);
    return {
      subscription,
      close: () => { subscription.active = false; this.subscribers.delete(subscription); },
    };
  }

  send({app, path, program, session, type, message, suppressEcho = false, extension = "", client, username}) {
    const channel = this.channel(app, path, "S", program);
    if (channel.type !== type) throw new Error(`AMC channel ${path} expects ${channel.type}, got ${type}.`);
    const publication = {type, message, client, username};
    const wanted = channelExtension(extension);
    for (const sub of this.subscribers) {
      if (!sub.active || sub.channel !== channel || sub.extension !== wanted) continue;
      if ((channel.scope === "C" || channel.scope === "U") && sub.client !== client) continue;
      if (channel.scope === "U" && sub.username !== username) continue;
      if (suppressEcho && sub.session === session) continue;
      if (sub.receive) sub.receive(publication);
      else sub.pending.push(publication);
    }
  }
}

let broker;
const defaultSession = {id: "local"};
const sessionIds = new WeakMap();
let nextSessionId = 1;
function sessionId(session) {
  let id = sessionIds.get(session);
  if (id === undefined) {
    id = `osd-amc-${nextSessionId++}`;
    sessionIds.set(session, id);
  }
  return id;
}
export function callerProgram(stack = new Error().stack) {
  for (const line of String(stack).split("\n")) {
    const match = /([a-z][a-z0-9_]+)\.clas(?:\.testclasses)?\.mjs(?:[:?]|$)/i.exec(line);
    if (!match) continue;
    const name = match[1].toUpperCase();
    if (name === "CL_AMC_CHANNEL_MANAGER" || name.startsWith("ZCL_AMC_")) continue;
    return name.padEnd(30, "=") + "CP";
  }
  return undefined;
}
export function installAmc(abap, root = process.cwd()) {
  const Manager = abap.Classes.CL_AMC_CHANNEL_MANAGER;
  if (!Manager || Manager.osdAmcInstalled) return broker;
  broker = new AmcBroker(amcChannels(root));
  Manager.osdAmcInstalled = true;
  registerWaitPump((session) => drainAmcSession(abap, session));
  if (abap.Classes.KERNEL_PUSH_CHANNELS) {
    abap.Classes.KERNEL_PUSH_CHANNELS.wait = async ({seconds, cond}) => {
      if (currentStepToken()) return abap.statements.wait({seconds, cond});
      const until = Date.now() + Number(seconds?.get?.() ?? seconds) * 1000;
      while (Date.now() < until) {
        if (cond() === true) { abap.builtin.sy.get().subrc.set(0); return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
        await drainAmcSession(abap, defaultSession);
      }
      abap.builtin.sy.get().subrc.set(8);
    };
  }
  const Producer = abap.Classes.ZCL_AMC_PRODUCER;
  const Consumer = abap.Classes.ZCL_AMC_CONSUMER;
  const props = new WeakMap();
  const value = (x) => x?.get?.() ?? x;
  const program = () => callerProgram();
  const error = async (reason) => {
    throw await new abap.Classes.CX_AMC_ERROR().constructor_({iv_reason: new abap.types.String().set(reason)});
  };
  const wrap = async (work) => {
    try { return await work(); } catch (e) { return error(e.message); }
  };
  Manager.create_message_producer = async (input) => wrap(() => {
    if (Number(value(input.i_communication_type) ?? 2) === 1) throw new Error("Communication type 1 is not supported.");
    const object = new Producer();
    props.set(object, {app: value(input.i_application_id), path: value(input.i_channel_id),
      extension: value(input.i_channel_extension_id) ?? "", suppressEcho: value(input.i_suppress_echo) === "X",
      session: currentStepToken() ?? defaultSession, program: program()});
    return new abap.types.ABAPObject({qualifiedName: "IF_AMC_MESSAGE_PRODUCER"}).set(object);
  });
  Manager.create_message_consumer = async (input) => wrap(() => {
    const object = new Consumer();
    props.set(object, {app: value(input.i_application_id), path: value(input.i_channel_id),
      extension: value(input.i_channel_extension_id) ?? "", session: currentStepToken() ?? defaultSession, program: program()});
    return new abap.types.ABAPObject({qualifiedName: "IF_AMC_MESSAGE_CONSUMER"}).set(object);
  });
  Manager.get_consumer_session_id = async () =>
    new abap.types.String().set(sessionId(currentStepToken() ?? defaultSession));
  for (const type of ["text", "binary", "pcp"]) {
    Producer.prototype[`if_amc_message_producer_${type}$send`] = async function ({i_message}) { return wrap(() => {
      const details = props.get(this);
      broker.send({...details, program: program(), type: type.toUpperCase(), message: value(i_message),
        client: abap.builtin.sy.get().mandt.get(), username: abap.builtin.sy.get().uname.get()});
    }); };
  }
  Consumer.prototype.if_amc_message_consumer$start_message_delivery = async function ({i_receiver}) {
    return wrap(() => {
      const details = props.get(this);
      const receiver = value(i_receiver);
      this.osdSubscriptions ??= new Map();
      this.osdSubscriptions.get(receiver)?.close();
      const subscription = broker.subscribe({...details, program: program(), receive: undefined,
        client: abap.builtin.sy.get().mandt.get(), username: abap.builtin.sy.get().uname.get()});
      subscription.subscription.receiver = receiver;
      this.osdSubscriptions.set(receiver, subscription);
    });
  };
  Consumer.prototype.if_amc_message_consumer$stop_message_delivery = async function ({i_receiver}) {
    const receiver = value(i_receiver);
    this.osdSubscriptions?.get(receiver)?.close();
    this.osdSubscriptions?.delete(receiver);
  };
  return broker;
}

export async function drainAmcSession(abap, session) {
  if (!broker) return false;
  let delivered = false;
  for (const sub of broker.subscribers) {
    if (sub.session !== session || !sub.active || !sub.receiver) continue;
    while (sub.pending.length) {
      const publication = sub.pending.shift();
      const receiver = sub.receiver;
      if (!receiver) break;
      delivered = true;
      // in the waiting session's shared state (its ICF server), not in
      // whatever the step served meanwhile left there
      await outsideStepContext(() => dialogStep(() => inSession(session, async () => {
        const Context = abap.Classes.ZCL_AMC_MESSAGE_CONTEXT;
        const context = new Context();
        await context.constructor_({iv_client: new abap.types.Character(3).set(publication.client),
          iv_username: new abap.types.Character(12).set(publication.username)});
        await receiver[`if_amc_message_receiver_${publication.type.toLowerCase()}$receive`]({
          i_message: publication.message,
          i_context: new abap.types.ABAPObject({qualifiedName: "IF_AMC_MESSAGE_CONTEXT"}).set(context),
        });
      })));
    }
  }
  return delivered;
}
