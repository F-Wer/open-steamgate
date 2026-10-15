// A WebSocket with no socket, and no runtime in the page either.
//
// A page written for APC opens `ws://host/sap/bc/apc/sap/<application>` and
// expects a handler on a system. In the preview deployment there is no
// system and no network, so something has to stand in. open-abap-apc's
// web/apc-socket.mjs does exactly this by driving `zcl_apc_host` in the
// page — which is right when the page is the only place the runtime lives.
//
// Here it is not. The transpiled runtime is twenty-odd megabytes and it is
// already in the service worker, answering the ICF and OData paths. Loading
// a second copy into the page to answer websockets would double the
// download to serve the smaller half. So this keeps the WebSocket shape in
// the page and puts the handler where the runtime already is: each socket
// is a conversation with the worker over a MessagePort.
//
// The page does not know any of that. It calls `new WebSocket(url)`, gets
// `onopen`, `onmessage` and `onclose`, and the frames it receives are what
// the ABAP handler pushed.
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

let counter = 0;

// the worker is the only party that can answer; without one there is nobody
// to talk to and the honest thing is a clean close rather than a hang
function controller() {
  return navigator.serviceWorker?.controller ?? undefined;
}

export class PreviewSocket extends EventTarget {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(url, protocols) {
    super();
    this.url = String(url);
    this.readyState = CONNECTING;
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? "") : (protocols ?? "");
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.extensions = "";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    this.CONNECTING = CONNECTING;
    this.OPEN = OPEN;
    this.CLOSING = CLOSING;
    this.CLOSED = CLOSED;

    this.id = `apc-${counter += 1}`;
    this.#open();
  }

  #emit(type, detail) {
    const event = type === "message"
      ? new MessageEvent("message", {data: detail})
      : new (type === "close" ? CloseEvent : Event)(type, detail);
    this[`on${type}`]?.call(this, event);
    this.dispatchEvent(event);
  }

  async #open() {
    const worker = controller();
    if (worker === undefined) {
      // the page was loaded without the worker in control, which is the
      // first-visit case; say so rather than wait for a socket that cannot
      // arrive
      this.readyState = CLOSED;
      queueMicrotask(() => {
        this.#emit("error", {});
        this.#emit("close", {code: 1006, reason: "no service worker is in control", wasClean: false});
      });
      return;
    }

    // the path is what the worker matches a channel on; the origin is ours
    const path = new URL(this.url, self.location.href).pathname;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => this.#receive(event.data);
    worker.postMessage({apc: "open", id: this.id, path}, [channel.port2]);
  }

  #receive(message) {
    if (message?.apc === "open") {
      this.readyState = OPEN;
      this.#emit("open", {});
      return;
    }
    if (message?.apc === "message") {
      this.#emit("message", message.text);
      return;
    }
    if (message?.apc === "error") {
      this.#emit("error", {});
      return;
    }
    if (message?.apc === "close") {
      this.readyState = CLOSED;
      this.#emit("close", {code: message.code ?? 1000, reason: message.reason ?? "", wasClean: message.code === 1000});
      this.port?.close();
    }
  }

  send(data) {
    if (this.readyState !== OPEN) {
      throw new DOMException("the socket is not open", "InvalidStateError");
    }
    this.port.postMessage({apc: "message", text: String(data)});
  }

  close(code = 1000, reason = "") {
    if (this.readyState === CLOSED || this.readyState === CLOSING) {
      return;
    }
    this.readyState = CLOSING;
    this.port?.postMessage({apc: "close", code, reason});
  }
}

// Only the APC paths are taken over. A page that also talks to a real
// websocket somewhere keeps it, which matters because taking over more than
// we can answer would turn a working connection into a silent one.
export function install(options = {}) {
  const paths = options.paths ?? [];
  const real = globalThis.WebSocket;
  if (real?.__previewInstalled === true) {
    return;
  }
  const shim = function WebSocket(url, protocols) {
    const path = new URL(String(url), self.location.href).pathname;
    if (paths.some((p) => path === p || path.startsWith(p + "/"))) {
      return new PreviewSocket(url, protocols);
    }
    return new real(url, protocols);
  };
  shim.CONNECTING = CONNECTING;
  shim.OPEN = OPEN;
  shim.CLOSING = CLOSING;
  shim.CLOSED = CLOSED;
  shim.__previewInstalled = true;
  globalThis.WebSocket = shim;
}
