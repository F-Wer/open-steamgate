import {expect} from "chai";
import {spawn} from "node:child_process";
import {readFileSync, rmSync} from "node:fs";
import {copyRuntimeRoot} from "./helpers/runtime-root.mjs";
import {once} from "node:events";

// A reparented child can remain a zombie until the host's init reaps it.
// That process has exited and no longer holds memory or listening sockets.
function alive(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z";
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function waitFor(check, ms, message) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= until) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("serving child supervisor lifetime", function () {
  this.timeout(60000);
  let root;
  before(() => {
    // This probes supervisor lifetime after boot. Reuse the verified bytes
    // with private generation links instead of timing a full cold compile.
    root = copyRuntimeRoot();
  });
  after(() => { if (root) rmSync(root, {recursive: true, force: true}); });
  it("exits within three seconds when its booted parent is SIGKILLed", async () => {
    // A real IPC parent and the real serving entry point, with its own rows.
    const parent = spawn(process.execPath, ["--input-type=module", "-e", `
      import {fork} from "node:child_process";
      const child = fork("tools/osd-serve.mjs", ["0"], {silent:true,execArgv:[]});
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      child.on("message", (message) => {
        if (message.type === "ready") console.log("CHILD_READY " + child.pid);
      });
      child.on("exit", (code) => process.exit(code ?? 1));
    `], {cwd:root,env:{...process.env,OSD_ROOT:root,STG_DB:"sqlite"},stdio:["ignore","pipe","pipe"]});
    let log = "", pid;
    parent.stdout.on("data", (chunk) => {log += chunk;});
    parent.stderr.on("data", (chunk) => {log += chunk;});
    try {
      await waitFor(() => {
        pid = Number(/CHILD_READY (\d+)/.exec(log)?.[1]);
        if (parent.exitCode !== null) throw new Error(log);
        return pid > 0;
      }, 45000, `child did not boot: ${log}`);
      expect(alive(pid)).to.equal(true);
      const exited = once(parent,"exit");
      parent.kill("SIGKILL");
      await exited;
      await waitFor(() => !alive(pid), 3000, `orphan child ${pid} is still running`);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      if (pid && alive(pid)) process.kill(pid,"SIGKILL");
    }
  });

  for (const warm of ["1", "0"]) it(`measures first /osd/ready answer after listen (OSD_UNIT_WARM=${warm})`, async () => {
    const parent = spawn(process.execPath,["test/run.mjs"], {
      cwd:root,env:{...process.env,OSD_ROOT:root,STG_SERVE:"child",STG_TLS:"0",STG_PROTOCOLS:"0",STG_DB:"sqlite",OSD_UNIT_WARM:warm},
      stdio:["ignore","pipe","pipe"],
    });
    let log="", request;
    const collect = (chunk) => {
      log += chunk;
      if (!request && /Listening on/.test(log)) {
        const started=performance.now();
        // The log follows listen(), before its asynchronous bind completes.
        // Retry refused connections, keeping the original timestamp.
        request=(async () => {
          for (;;) {
            try {
              return await fetch(`http://127.0.0.1:${process.env.STG_PORT}/osd/ready`,{signal:AbortSignal.timeout(30000)});
            } catch (error) {
              if (error.cause?.code !== "ECONNREFUSED" || performance.now()-started > 30000) throw error;
              await new Promise((resolve) => setTimeout(resolve,10));
            }
          }
        })().then(async (response) => {
            await response.arrayBuffer();
            const ms=Math.round(performance.now()-started);
            console.log(`first /osd/ready after listen: ${ms} ms (OSD_UNIT_WARM=${warm}, HTTP ${response.status})`);
            return response.status;
          });
        request.catch(() => {});
      }
    };
    parent.stdout.on("data",collect);
    parent.stderr.on("data",collect);
    try {
      await waitFor(() => {
        if (parent.exitCode !== null) throw new Error(log);
        return request !== undefined;
      },45000,`front did not listen: ${log}`);
      expect(await request).to.be.oneOf([200,503]);
    } finally {
      const exited=once(parent,"exit");
      parent.kill("SIGTERM");
      const kill=setTimeout(() => parent.kill("SIGKILL"),5000);
      await exited;
      clearTimeout(kill);
    }
  });
});
