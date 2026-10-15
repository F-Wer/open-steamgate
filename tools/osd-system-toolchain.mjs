import {execFileSync} from "node:child_process";
const warned = new Set();
const toolRoot = decodeURIComponent(new URL("../", import.meta.url).pathname);
export function warnSystemToolchain(root, system, log = console.error) {
  const expected = system?.annotations?.["org.osd.osg.commit"];
  if (!expected) return;
  let actual;
  try { actual = execFileSync("git", ["rev-parse", "HEAD"], {cwd: toolRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim(); }
  catch { return; }
  if (actual !== expected && !warned.has(`${root}:${system.digest}:${actual}`)) {
    warned.add(`${root}:${system.digest}:${actual}`);
    log(`warning: system ${system.digest} records OSG ${expected}; running OSG ${actual}`);
  }
}
