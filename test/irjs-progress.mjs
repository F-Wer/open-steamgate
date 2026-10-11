import {expect} from 'chai';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as nodeTest from 'node:test';
import {parseRun, measure, median, countRefusals} from '../tools/gogen/irjs-progress.mjs';
import {page} from '../tools/osd-metrics-page.mjs';
// The suite fragment uses Mocha; a focused node --test invocation also works.
const {describe, it, beforeEach, afterEach} = globalThis.describe ? globalThis : nodeTest;

// Shapes copied from bench-js-1.log, fix1-1.log and structures-js.log.
const lexerHash = '9b118dd1e5ed640bbe07f1e8f4848b8fcaaa6a25c5ab126a12f018c46664df40';
const statementHash = '45f74b5baafb93d256155c19321ecceeb19e20f1207eb159d8f445264c41cd22';
const lex = us => `X tokens 609647 lex_us ${us} lexer_hash ${lexerHash}`;
const statements = `${lex(6101360)} statements 92500 statements_us 14599791 statements_hash ${statementHash}`;
const structures = 'X STAGETIME OK tokens 609647 statements 92500 structures 88312 issues 0 lex_us 6486198 statements_us 14429981 structures_us 112361834 dump_hash_us 2000001';
const snapshot = {commit: 'abc', date: '2026-10-10T00:00:00Z', go: {}, js: {}};

describe('IR-JS progress measurements', function () {
  // The CLI cases spawn node; a loaded runner needs more than mocha's 2 s.
  if (this && typeof this.timeout === 'function') this.timeout(60000);
  let scratch;
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'irjs-progress-test-')); });
  afterEach(() => { rmSync(scratch, {recursive: true, force: true}); });
  const cli = (...args) => spawnSync(process.execPath, ['tools/gogen/irjs-progress.mjs', ...args], {encoding: 'utf8'});
  const log = (name, text) => writeFileSync(join(scratch, name), text + '\n');

  it('parses direct and bench wrapper reports, ignoring launcher/resource lines', () => {
    expect(parseRun('osd-heavy: launcher\nresource gate 0.0 73729020 4.72\n' + lex(12409730), 'lexer'))
      .to.deep.equal({units: 609647, us: 12409730, hashMatch: true, pass: true});
    expect(parseRun('JS 1 ' + statements, 'statements')).to.include({units: 92500, us: 14599791, pass: true});
    expect(parseRun('Go 2 ' + lex(3625147), 'lexer').pass).to.equal(true);
    expect(parseRun(structures, 'structures')).to.include({units: 88312, us: 112361834, hashMatch: true, pass: true, source: 'doc'});
  });

  it('computes odd/even medians, ratios and consecutive JS passes', () => {
    [30, 10, 20].forEach((us, i) => log(`lexer-js-${i + 1}.log`, lex(us)));
    log('lexer-go-1.log', lex(90));
    log('statements-js-1.log', statements);
    log('structures-js-1.log', structures);
    const row = measure({runs: scratch, vanilla: {lexer: 10}, input: 'abapiti@test'});
    expect(row).to.include({schema: 'irjs-progress/1', passed: 3, input: 'abapiti@test', refusals: null});
    expect(row.osg).to.match(/^[a-f0-9]{40}$/);
    expect(row.layers.find(l => l.host === 'js' && l.layer === 'lexer')).to.include({runs: 3, medianUs: 20, vsVanilla: 2});
    expect(row.layers.find(l => l.layer === 'statements').vsVanilla).to.equal(null);
    expect(median([8, 2, 4, 6])).to.equal(5);
    log('lexer-js-4.log', lex(10).replace(lexerHash, '0'.repeat(64)));
    expect(measure({runs: scratch}).passed).to.equal(0);
  });

  it('fails a layer on a wrong hash, count, ok flag or full-stage verdict', () => {
    expect(parseRun(lex(10).replace(lexerHash, '0'.repeat(64)), 'lexer')).to.include({hashMatch: false, pass: false});
    expect(parseRun(lex(10).replace('609647', '609646'), 'lexer').pass).to.equal(false);
    expect(parseRun(lex(10).slice(2), 'lexer').pass).to.equal(false);
    expect(parseRun(structures.replace('OK', 'FAIL'), 'structures').pass).to.equal(false);
    expect(parseRun(structures.replace('issues 0', 'issues 1'), 'structures').pass).to.equal(false);
    log('lexer-js-1.log', lex(10));
    log('structures-js-1.log', structures);
    expect(measure({runs: scratch}).passed).to.equal(1); // missing statements
    log('statements-go-1.log', statements);
    expect(measure({runs: scratch}).passed).to.equal(1); // Go does not advance JS
  });

  for (const [name, report, layer, hashMatch] of [
    ['statements token count', statements.replace('tokens 609647', 'tokens 1'), 'statements', true],
    ['statements lexer hash', statements.replace(lexerHash, '0'.repeat(64)), 'statements', false],
    ['structures token count', structures.replace('tokens 609647', 'tokens 1'), 'structures', true],
    ['structures statement count', structures.replace('statements 92500', 'statements 1'), 'structures', true],
    ['full report statement count while measuring lexer', structures.replace('statements 92500', 'statements 1'), 'lexer', true],
    ['full report issues while measuring statements', structures.replace('issues 0', 'issues 1'), 'statements', true],
  ]) {
    it(`rejects contradictory ${name} despite the success flag`, () => {
      expect(parseRun(report, layer)).to.include({pass: false, hashMatch});
      log('lexer-js-1.log', lex(10));
      log('statements-js-1.log', statements);
      log('structures-js-1.log', structures);
      log(`${layer}-js-1.log`, report);
      expect(measure({runs: scratch}).passed).to.equal(['lexer', 'statements', 'structures'].indexOf(layer));
    });
  }

  it('returns exit 2 with a filename and writes no row on an unrecognized log', () => {
    log('lexer-js-1.log', 'osd-heavy: interrupted');
    const append = join(scratch, 'history.ndjson');
    const result = cli('--runs', scratch, '--append', append);
    expect(result.status).to.equal(2);
    expect(result.stderr).to.contain('lexer-js-1.log').and.contain('no recognisable');
    expect(result.stdout).to.equal('');
    expect(() => readFileSync(append)).to.throw();
    expect(() => parseRun(lex(10).replace('lex_us 10', ''), 'lexer')).to.throw('lex_us');
  });

  it('supports custom vanilla references and appends exactly one line per invocation', () => {
    log('lexer-js-1.log', lex(100));
    const vanilla = join(scratch, 'vanilla.json'), append = join(scratch, 'history.ndjson');
    writeFileSync(vanilla, '{"lexer":25}');
    for (let i = 0; i < 2; i++) {
      const result = cli('--runs', scratch, '--vanilla', vanilla, '--input', 'abapiti@test', '--append', append);
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.equal('');
    }
    const rows = readFileSync(append, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).to.have.length(2);
    expect(rows[0].layers[0].vsVanilla).to.equal(4);
    writeFileSync(vanilla, '{"lexer":0}');
    expect(cli('--runs', scratch, '--vanilla', vanilla).status).to.equal(2);
  });

  it('counts literal emitted sites, frontend sites and normalized JS-only reasons', () => {
    mkdirSync(join(scratch, 'go'));
    const jsSite = reason => `throw new abap.AbapError("NOT_COMPILED", ${JSON.stringify(reason)});`;
    writeFileSync(join(scratch, 'program.mjs'), 'export class Test {}\n' + [
      'ZCL_A=>RUN (zcl_a.clas.abap:10): @KERNEL: host code of the transpiler runtime',
      'ZCL_A=>CONSTRUCTOR: CREATE OBJECT by name of a class whose constructor has parameters',
      'DELETE range: index below 1 was not measured', 'JS-only reason', 'JS-only reason',
    ].map(jsSite).join('\n'));
    writeFileSync(join(scratch, 'go/program.go'), `package main
abap.NotCompiled("ZCL_B=>RUN (zcl_b.clas.abap:20)", "@KERNEL: host code of the transpiler runtime")
abap.NotCompiled("ZCL_B=>CONSTRUCTOR", "CREATE OBJECT by name of a class whose constructor has parameters")
abap.NotCompiled("DELETE range", "index below 1 was not measured")`);
    writeFileSync(join(scratch, 'go/runtime.go'), 'package abap\nabap.NotCompiled("helper", "excluded")');
    expect(countRefusals(scratch)).to.deep.equal({js: 5, go: 3, frontend: 1, jsOnly: 2});
  });

  it('keeps the original page byte-identical with omitted or empty IR-JS history', () => {
    const html = page([snapshot]);
    expect(createHash('sha256').update(html).digest('hex')).to.equal('7888c35c13463390a48e0c9e8fbf887cadef5eb7dc9989a0506bae2e269d6eb3');
    expect(page([snapshot], [])).to.equal(html);
    const history = join(scratch, 'metrics.ndjson'), empty = join(scratch, 'empty.ndjson');
    writeFileSync(history, JSON.stringify(snapshot) + '\n');
    writeFileSync(empty, '\n');
    for (const extra of [[], ['--irjs', empty]]) {
      const result = spawnSync(process.execPath, ['tools/osd-metrics-page.mjs', history, ...extra], {encoding: 'utf8'});
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.equal(html);
    }
  });

  it('adds the optional section, small-history table, log chart and refusal trend', () => {
    log('lexer-js-1.log', lex(10));
    log('lexer-go-1.log', lex(20));
    const row = {...measure({runs: scratch}), refusals: {js: 759, go: 731, frontend: 190, jsOnly: 37}};
    const html = page([snapshot], [row]);
    expect(html).to.contain('TS-HA on IR-JS').and.contain('Median µs').and.contain('Layers passed over time').and.contain('Refusal sites over time');
    const rows = [0, 1, 2].map(i => ({...row, date: `2026-10-10T0${i}:00:00Z`}));
    const trend = page([snapshot], rows);
    expect(trend).to.contain('(log scale)').and.contain('lexer js').and.contain('lexer go').and.contain('stroke-dasharray="5 3"').and.contain('1 run (probe)');
    const missing = {...rows[1], layers: rows[1].layers.filter(l => l.host !== 'go'), refusals: null};
    const gaps = page([snapshot], [rows[0], missing, rows[2]]);
    expect(gaps).to.match(/<path d="M[^"L]+ M[^"L]+" fill="none" stroke-width="1.5" stroke-dasharray="5 3"/);
    const history = join(scratch, 'metrics.ndjson'), irjs = join(scratch, 'progress.ndjson');
    writeFileSync(history, JSON.stringify(snapshot) + '\n');
    writeFileSync(irjs, JSON.stringify(row) + '\n');
    const result = spawnSync(process.execPath, ['tools/osd-metrics-page.mjs', history, '--irjs', irjs], {encoding: 'utf8'});
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal(html);
    const unsafe = {...row, layers: row.layers.map(l => ({...l, layer: '</script><img src=x>'}))};
    expect(page([snapshot], [unsafe])).to.contain('&lt;/script&gt;');
  });

  it('escapes the runs field in the small-history table', () => {
    const attack = '<img src=x onerror=alert(1)>';
    const row = {schema: 'irjs-progress/1', date: snapshot.date, passed: 1, refusals: null,
      layers: [{layer: 'lexer', host: 'js', runs: attack, medianUs: 10, vsVanilla: 1, pass: true}]};
    const history = join(scratch, 'metrics.ndjson'), irjs = join(scratch, 'progress.ndjson');
    writeFileSync(history, JSON.stringify(snapshot) + '\n');
    writeFileSync(irjs, JSON.stringify(row) + '\n');
    const result = spawnSync(process.execPath, ['tools/osd-metrics-page.mjs', history, '--irjs', irjs], {encoding: 'utf8'});
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.contain('<td>&lt;img src=x onerror=alert(1)&gt;</td>');
    expect(result.stdout).not.to.contain(attack);
  });
});
