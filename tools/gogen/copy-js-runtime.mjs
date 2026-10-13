// Keep standalone generated programs together with every runtime module.
import {copyFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const runtime = fileURLToPath(new URL('./js/', import.meta.url));
export function copyJsRuntime(out) {
  for (const name of readdirSync(runtime).sort()) {
    if (name.endsWith('.mjs')) copyFileSync(join(runtime,name),join(out,name));
  }
}
