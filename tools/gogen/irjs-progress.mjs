// Aggregate existing lexer-bench samples; never compile or execute a benchmark.
import {execFileSync} from 'node:child_process';
import {appendFileSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ORDER = ['lexer', 'statements', 'structures', 'check'];
export const VANILLA = {lexer: 338372, statements: 2097152, structures: 9885785};
// The embedded zabapgit oracle, documented in docs/tsha-irjs-pilot.md.
const ORACLE = {
  lexer: [609647, '9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40'],
  statements: [92500, '45f74b5baafb93d256155c19321ecceeb19e20f1207eb159d8f445264c41cd22'],
  structures: [88312, '1a6cc2f2c4da2231c208a8aef6e9227a4b2c2a8ad3bb18afbdb700dacd2da469'],
};
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function parseRun(text, layer) {
  // Direct --execute/Go reports and lexer-bench's "JS 1 X tokens ..." wrapper.
  const reports = text.split('\n').filter(line => /^\s*(?:(?:JS|Go) \d+ )?(?:X )?(?:STAGETIME (?:OK|FAIL) )?tokens \d+\b/.test(line));
  if (reports.length !== 1 || !ORACLE[layer]) throw new Error(`no recognisable single ${layer} result`);
  const report = reports[0];
  const number = key => {
    const hit = new RegExp(`\\b${key} (\\d+)\\b`).exec(report);
    if (!hit || !Number.isSafeInteger(Number(hit[1]))) throw new Error(`missing or invalid ${key} in ${layer} result`);
    return Number(hit[1]);
  };
  const units = number(layer === 'lexer' ? 'tokens' : layer);
  const us = number(layer === 'lexer' ? 'lex_us' : `${layer}_us`);
  const ok = /^\s*(?:(?:JS|Go) \d+ )?X /.test(report);
  const hash = new RegExp(`\\b${layer}_hash ([a-f0-9]{64})\\b`).exec(report)?.[1];
  const full = report.includes('STAGETIME ');
  if (!hash && !full) throw new Error(`missing ${layer}_hash in ${layer} result`);
  // The full bench omits hashes from its report. STAGETIME OK checks all
  // three embedded hashes. Mark that evidence as doc, never synthesize runs.
  let hashMatch = hash ? hash === ORACLE[layer][1] : ok && report.includes('STAGETIME OK ');
  let countsMatch = units === ORACLE[layer][0];
  // A multi-stage report must agree with every oracle field it reports,
  // even when collecting only one of its timing intervals.
  for (const [stage, [count, expectedHash]] of Object.entries(ORACLE)) {
    const key = stage === 'lexer' ? 'tokens' : stage;
    if (new RegExp(`\\b${key} `).test(report) && number(key) !== count) countsMatch = false;
    const reportedHash = new RegExp(`\\b${stage}_hash (\\S+)`).exec(report)?.[1];
    if (reportedHash !== undefined && reportedHash !== expectedHash) hashMatch = false;
  }
  if ((layer === 'structures' || /\bissues /.test(report)) && number('issues') !== 0) countsMatch = false;
  return {units, us, hashMatch, pass: ok && (!full || report.includes('STAGETIME OK ')) && countsMatch && hashMatch,
    ...(!hash ? {source: 'doc'} : {})};
}

// Port of .local/tsha-pilot/analyze.py's literal-site rule and norm(),
// with the field-symbol grouping from irjs2/report.py. The statements-pilot
// analyze.py is a CPU-profile analyzer, not a refusal counter. Count sites,
// not unique methods; JS-only means its normalized reason is absent in Go.
export function normalize(reason) {
  return reason.replace(/[\w/#:]+=>[\w~/#]+(?: \([^)]*\.abap:\d+\))?:\s*/g, '')
    .replace(/\(?[\w/.-]+\.abap:\d+\)?/g, '<location>')
    .replace(/\b(?:ZCL_|CL_|CX_|ZIF_|IF_)[A-Z0-9_]+(?= is not compiled|, which is not compiled)/g, '<class>')
    .replace(/^[A-Z0-9_]+: (sy is not a local)/, '<method>: $1')
    .replace('DELETE range index below 1 was not measured', 'DELETE range: index below 1 was not measured')
    .replace(/field symbol <[^>]+>/g, 'field symbol <name>').trim();
}
export function countRefusals(dir) {
  const reasons = {js: [], go: []};
  const q = '"(?:\\\\.|[^"\\\\])*"';
  const patterns = {
    js: new RegExp('new abap\\.AbapError\\("NOT_COMPILED", (' + q + ')\\)', 'g'),
    go: new RegExp('abap\\.NotCompiled\\((' + q + '), (' + q + ')', 'g'),
  };
  let emitted = 0;
  const walk = path => {
    for (const entry of readdirSync(path, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      const host = entry.name.endsWith('.mjs') ? 'js' : entry.name.endsWith('.go') && !entry.name.endsWith('_test.go') ? 'go' : null;
      if (!host) continue;
      const text = readFileSync(file, 'utf8');
      // Ignore companion runtime/helper libraries: only emitted programs.
      if (!(host === 'js' ? /^export class \w+/m : /^package main\b/m).test(text)) continue;
      emitted++;
      for (const match of text.matchAll(patterns[host])) {
        reasons[host].push(JSON.parse(match[1]) + (host === 'go' ? ': ' + JSON.parse(match[2]) : ''));
      }
    }
  };
  walk(dir);
  if (!emitted) throw new Error('no emitted programs in refusal build directory');
  const goGroups = new Set(reasons.go.map(normalize));
  return {js: reasons.js.length, go: reasons.go.length,
    frontend: reasons.js.filter(r => /\([^()]+\.abap:\d+\)/.test(r)).length,
    jsOnly: reasons.js.filter(r => !goGroups.has(normalize(r))).length};
}

export function measure({runs, refusals, vanilla = VANILLA, input = '', date = new Date().toISOString()}) {
  const groups = new Map();
  for (const name of readdirSync(runs).sort()) {
    const match = /^(lexer|statements|structures|check)-(js|go)-(\d+)\.log$/.exec(name);
    if (!match) continue;
    const [, layer, host] = match, key = `${layer}-${host}`;
    let sample;
    try { sample = parseRun(readFileSync(join(runs, name), 'utf8'), layer); }
    catch (e) { throw new Error(`${name}: ${e.message}`); }
    if (!groups.has(key)) groups.set(key, {layer, host, samples: []});
    groups.get(key).samples.push(sample);
  }
  if (!groups.size) throw new Error('no recognisable run logs');
  const layers = [...groups.values()].sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer) || a.host.localeCompare(b.host)).map(({layer, host, samples}) => {
    const us = samples.map(s => s.us), medianUs = median(us), reference = vanilla[layer];
    if (reference !== undefined && (!Number.isFinite(reference) || reference <= 0)) throw new Error(`invalid vanilla time for ${layer}`);
    return {layer, host, runs: samples.length, pass: samples.every(s => s.pass),
      units: samples.every(s => s.units === samples[0].units) ? samples[0].units : null,
      hashMatch: samples.every(s => s.hashMatch), us, medianUs,
      vsVanilla: reference === undefined ? null : medianUs / reference,
      ...(samples.some(s => s.source === 'doc') ? {source: 'doc'} : {})};
  });
  let passed = 0;
  for (const layer of ORDER) {
    if (!layers.find(l => l.layer === layer && l.host === 'js')?.pass) break;
    passed++;
  }
  return {schema: 'irjs-progress/1', date, osg: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    input, layers, passed, refusals: refusals ? countRefusals(refusals) : null};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = {}, args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!['runs', 'refusals', 'vanilla', 'input', 'append'].includes(key) || !args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid option ${args[i]}`);
      options[key] = args[i + 1];
    }
    if (!options.runs) throw new Error('--runs is required');
    if (options.vanilla) options.vanilla = JSON.parse(readFileSync(options.vanilla, 'utf8'));
    const line = JSON.stringify(measure(options)) + '\n';
    if (options.append) appendFileSync(options.append, line);
    else process.stdout.write(line);
  } catch (e) {
    console.error(`irjs-progress: ${e.message}`);
    process.exitCode = 2;
  }
}
