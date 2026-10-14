// Exercise osd-host's hosted tool invocation from an isolated test checkout.
import {spawnSync} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
const args = process.argv.slice(2);
const root = args[0] === "gen" ? join(dirname(fileURLToPath(import.meta.url)), "../..") : args.shift();
if (args.shift() !== "gen") throw new Error("expected hosted gen invocation");
const result = spawnSync(process.execPath, [join(root, "tools", args.shift()), ...args], {stdio: "inherit"});
process.exit(result.status ?? 1);
