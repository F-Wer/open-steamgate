import {writeGo} from "./symbols.mjs";
// SMW0 media through the Go host, checked by bytes: every W3MI object of the
// o4d and zork packs is copied into a media directory (media.mjs), read back
// by compiled ABAP (testdata-media/zcl_gogen_t_w3miload: WWWDATA_IMPORT, then
// SCMS_BINARY_TO_XSTRING, the shape of the packs' own loaders) through
// go/abap/w3mi.go, and compared with the pack's file.
//
//   node tools/gogen/mediacheck.mjs
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {home} from "./home.mjs";
import {collectMedia, writeMedia} from "./media.mjs";

const here = import.meta.dirname;
const objects = collectMedia([`${home}/packs/o4d/upstream`, `${home}/packs/zork/games`]);
const media = join(here, ".out", "mediacheck", "media");
writeMedia(objects, media);
const program = compileProgram({folders: [join(here, "testdata-media"), `${home}/.local/lars/open-abap-core/src`], objects: ["zcl_gogen_t_w3miload"]});
if (program.skipped.length || program.partial.length) throw new Error(`not compiled: ${[...program.skipped, ...program.partial].join("; ")}`);
const dir = join(here, "go", "cmd", "mediacheck");
mkdirSync(dir, {recursive: true});
writeGo(join(dir, "zz_generated.go"), program);
// the originals, not the copies: what is compared is the pack's file
writeFileSync(join(dir, "zz_cases.json"), JSON.stringify([...objects.map((o) => ({id: o.id, size: o.size, file: o.file, audio: /\.(mp3|m4a|ogg|wav)$/i.test(o.name)})),
  {id: "ZGOGEN_NO_SUCH_OBJECT", size: 10, file: "", audio: false}]));
execFileSync("gofmt", ["-w", dir]);
execFileSync("go", ["build", "-o", join(here, ".out", "mediacheck", "mediacheck"), "./cmd/mediacheck"], {cwd: join(here, "go"), stdio: "inherit"});
const out = execFileSync(join(here, ".out", "mediacheck", "mediacheck"), ["-media", media, "-cases", join(dir, "zz_cases.json")]).toString();
process.stdout.write(out);
process.exit(/^FAIL/m.test(out) ? 1 : 0);
