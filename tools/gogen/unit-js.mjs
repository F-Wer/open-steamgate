// Minimal synchronous IR-JS ABAP Unit host. Inputs remain read-only.
// node tools/gogen/unit-js.mjs --fixture <closure> [--out <directory>]
import {mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileProgram} from './frontend.mjs';
import {emitJs} from './emit-js.mjs';
import {referencedClasses} from './emit-go.mjs';
import {libraryPath} from '../osd-lib-path.mjs';
import {home} from './home.mjs';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--fixture')) throw new Error('--fixture is required');
const fixture = resolve(value('--fixture'));
const out = resolve(args.includes('--out') ? value('--out') : 'tools/gogen/.out/unit-js');
mkdirSync(out, {recursive: true});
const owners = readdirSync(fixture).filter(f => f.endsWith('.clas.testclasses.abap'))
  .map(f => f.split('.')[0].replaceAll('#', '/').toUpperCase());
const wanted = new Set([...readdirSync(fixture).filter(f => /\.(clas|intf)\.abap$/.test(f))
  .map(f => f.split('.')[0].replaceAll('#', '/').toUpperCase()), 'CL_ABAP_UNIT_ASSERT', 'KERNEL_CX_ASSERT']);
let program, registry;
const session = {};
for (let round = 0; round < 12; round++) {
  program = compileProgram({folders: [fixture, join(libraryPath(home, 'open-abap-core'), 'src')],
    objects: [...wanted], registry, session, includeTests: new Set(owners), tolerant: true});
  registry = program.reg;
  const supers = [...wanted].map(n => registry.getObject('CLAS', n)?.getDefinition()?.getSuperClass()).filter(Boolean).map(n => n.toUpperCase());
  const more = [...referencedClasses(program), ...program.missing, ...supers].filter(n => !wanted.has(n) && !n.includes(':')
    && (program.reg.getObject('CLAS', n) || program.reg.getObject('INTF', n)));
  if (!more.length) break;
  more.forEach(n => wanted.add(n));
  if (round === 11) throw new Error('closure did not settle');
}
writeFileSync(join(out, 'program.mjs'), emitJs(program, pathToFileURL(join(home, 'tools/gogen/js/abap.mjs')).href));
writeFileSync(join(out, 'diagnostics.json'), JSON.stringify({partial: program.partial, skipped: program.skipped, broken: program.broken}, null, 2));
const moduleUrl = pathToFileURL(join(out, 'program.mjs')).href;
const status = e => e.cls === 'NOT_COMPILED' || failure(e).includes('NOT_COMPILED in ') ? 'NOT_COMPILED' : 'FAILED';
const failure = e => e.cls === 'KERNEL_CX_ASSERT' ? e.obj.msg : e.message;
const jsName = n => n.toUpperCase().replace(/=>|~|-/g, '__').replace(/[^A-Z0-9_]/g, '_');
const rows = [];
for (const owner of owners) {
  const obj = program.reg.getObject('CLAS', owner);
  for (const file of obj.getABAPFiles().filter(f => f.getFilename().endsWith('.testclasses.abap'))) {
    for (const def of file.getInfo().listClassDefinitions().filter(d => d.isForTesting && !d.isAbstract && !d.isGlobal)) {
      const name = `${owner}:${def.name.toUpperCase()}`;
      const cls = program.classes.find(c => c.name === name);
      const methods = new Set(cls?.methods.map(m => m.name));
      const s = {sy: {index: 0, tabix: 0, subrc: 0, dbcnt: 0}};
      const mod = await import(`${moduleUrl}?testclass=${encodeURIComponent(name)}`);
      const C = mod[jsName(name)];
      const groupStart = rows.length;
      let classFailure;
      try { if (methods.has('CLASS_SETUP')) C.CLASS_SETUP(s); } catch (e) { classFailure = e; }
      let stopClass = false;
      for (const method of def.methods.filter(m => m.isForTesting)) {
        const row = {class: owner, testclass: def.name.toUpperCase(), method: method.name.toUpperCase(), status: 'SUCCESS', message: ''};
        if (stopClass) { row.status = 'SKIPPED'; row.message = 'stopped after teardown failure'; }
        else if (classFailure) { row.status = status(classFailure); row.message = `class_setup: ${failure(classFailure)}`; }
        else if (!methods.has(row.method)) { row.status = 'NOT_COMPILED'; row.message = 'test method missing'; }
        else {
          let instance;
          try {
            instance = C.$new(s);
            if (methods.has('SETUP')) instance.SETUP(s);
            instance[jsName(row.method)](s);
          } catch (e) { row.status = status(e); row.message = failure(e); }
          finally {
            try { if (instance && methods.has('TEARDOWN')) instance.TEARDOWN(s); }
            catch (e) { if (!row.message) { row.status = status(e); row.message = `teardown: ${failure(e)}`; } if (e.cls === 'KERNEL_CX_ASSERT' && !e.assertionQuitNo) stopClass = true; }
          }
        }
        rows.push(row);

      }
      try { if (methods.has('CLASS_TEARDOWN')) C.CLASS_TEARDOWN(s); }
      catch (e) { for (const row of rows.slice(groupStart)) { row.status = status(e); row.message += ` class_teardown: ${failure(e)}`; } }
    }
  }
}
for (const row of rows) console.log(`${row.status === 'SUCCESS' ? 'PASS' : row.status === 'NOT_COMPILED' ? 'NOT_COMPILED' : 'FAIL'} ${row.class}/${row.testclass}/${row.method} ${row.message}`);
writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 2));
if (!rows.length || rows.some(r => r.status === 'FAILED')) process.exitCode = 1;
else if (rows.some(r => r.status === 'NOT_COMPILED')) process.exitCode = 2;
