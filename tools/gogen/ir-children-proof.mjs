// Run from either checkout root with the SAME driver:
//   cd .local/p4c-parent
//   node /work/tools/gogen/ir-children-proof.mjs --record .local/ir-children-parent
//   cd /work
//   node tools/gogen/ir-children-proof.mjs --compare .local/p4c-parent/.local/ir-children-parent
// No instrumentation or product edits in the parent worktree are needed.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Frozen from b9132d5f (PR #770's parent), not derived from ir-children.ts.
// emit-table-move.mjs walkMove: Object.values, no exclusions, including arrays.
const moveChildren = (node) => Object.values(node);
// ir-children.ts children, used by frontend-owned.mjs reject/read/ownObject.
const ownedChildren = (node) => Object.keys(node).filter((key) => !['type', 'pos'].includes(key)).map((key) => node[key]);
// sink-locals.mjs children and scan; array iteration is handled by the caller.
const sinkChildren = (node) => Object.entries(node).filter(([key]) => !['type', 'pos', 'token'].includes(key)).map(([, value]) => value);
// someExpression/legacy emitter predicates exclude only type.
const expressionChildren = (node) => Object.keys(node).filter((key) => key !== 'type').map((key) => node[key]);
const legacyEntries = (node) => Object.entries(node);
const coreObjects = ['CX_SY_ZERODIVIDE', 'CX_SY_ARITHMETIC_ERROR', 'CX_SY_CONVERSION_NO_NUMBER', 'CX_SY_CONVERSION_ERROR',
  'KERNEL_INTERNAL_NAME', 'CX_ROOT', 'CX_STATIC_CHECK', 'CX_DYNAMIC_CHECK', 'CX_NO_CHECK', 'CL_MESSAGE_HELPER',
  'CL_ABAP_CONV_OUT_CE', 'CL_ABAP_CONV_IN_CE', 'CL_ABAP_REGEX', 'CL_HTTP_UTILITY', 'ZCL_AJSON', 'ZIF_AJSON',
  'ZIF_AJSON_TYPES', 'ZCX_AJSON_ERROR', 'CL_ABAP_MESSAGE_DIGEST', 'CX_ABAP_MESSAGE_DIGEST', 'CL_ABAP_TYPEDESCR',
  'CL_ABAP_DATADESCR', 'CL_ABAP_ELEMDESCR', 'CL_ABAP_COMPLEXDESCR', 'CL_ABAP_STRUCTDESCR', 'CL_ABAP_TABLEDESCR',
  'CL_ABAP_REFDESCR', 'CL_ABAP_OBJECTDESCR', 'CL_ABAP_CLASSDESCR', 'CL_ABAP_INTFDESCR', '/UI2/CL_JSON',
  'CL_SXML_STRING_READER', 'CX_SXML_PARSE_ERROR', 'CX_SXML_ERROR', 'CL_ABAP_CODEPAGE', 'CL_ABAP_GZIP', 'CL_ABAP_ZIP'];
const load = (name) => import(pathToFileURL(resolve('tools', name)).href);
const names = (suffix) => readdirSync('tools/gogen/testdata').filter((f) => f.endsWith(suffix))
  .map((f) => f.split('.')[0].replaceAll('#', '/').toUpperCase()).sort();
const files = (dir) => readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const objectName = (file) => file.split('/').at(-1).split('.')[0].replaceAll('#', '/').toUpperCase();

function compareIdentities(actual, expected, context) {
  assert.equal(actual.length, expected.length, `${context}: length`);
  // deepEqual alone would miss replacement of an identity token or body array
  // by an equal-looking clone, which changes the storage analyses.
  actual.forEach((value, i) => assert.equal(value, expected[i], `${context}: child ${i}`));
}

function checkGraph(roots, helpers) {
  const seen = new Set(), counts = new Map();
  let arrays = 0, maps = 0, wrappers = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const kinds = ['e', 's', 'c', 'k'].filter((key) => typeof node[key] === 'string').map((key) => `${key}:${node[key]}`);
    kinds.forEach((kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1));
    if (Array.isArray(node)) arrays++;
    else if (node instanceof Map) maps++;
    else if (!kinds.length) wrappers++;
    if (helpers) {
      const context = kinds.join('/') || (Array.isArray(node) ? 'array' : 'wrapper');
      const entries = helpers.irEntries(node);
      const expected = legacyEntries(node);
      compareIdentities(entries.map(([k]) => k), expected.map(([k]) => k), `${context}: entry keys`);
      compareIdentities(entries.map(([, v]) => v), expected.map(([, v]) => v), `${context}: entry values`);
      for (const [legacy, excluded] of [[moveChildren, []], [ownedChildren, ['type', 'pos']],
        [sinkChildren, ['type', 'pos', 'token']], [expressionChildren, ['type']]]) {
        compareIdentities(helpers.irChildren(node, excluded), legacy(node), `${context}: exclusions ${excluded}`);
      }
      compareIdentities(helpers.irChildren(node), ownedChildren(node), `${context}: defaults`);
      // sink-locals uses the generic exports; check these call sites too.
      compareIdentities(helpers.children(node, ['type', 'pos', 'token']), sinkChildren(node), `${context}: sinking`);
      compareIdentities(helpers.entries(node).map(([, v]) => v), expected.map(([, v]) => v), `${context}: sinking entries`);
    }
    // Discover with the OLD unfiltered traversal, never the candidate helper.
    // Maps/Sets are compiler containers: enumerate their contents explicitly at
    // this boundary. Neither legacy Object.entries nor irChildren flattens them.
    if (node instanceof Map) for (const [key, value] of node) { visit(key); visit(value); }
    else if (node instanceof Set) for (const value of node) visit(value);
    else for (const value of moveChildren(node)) visit(value);
  };
  roots.forEach(visit);
  return {nodes: seen.size, arrays, maps, wrappers, kinds: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))};
}

function irRoots(program) {
  // Include declarations, constructors, abstracts/signatures/stubs, constants,
  // struct/type graphs, interfaces, and lowered FM methods. Keep parser graphs
  // (reg, FunctionGroup, spaghetti, interface definitions) outside the IR walk.
  const roots = [program.classes, program.structs, program.consts, program.tables,
    program.interfaceMethods, program.intfOwnAttrs, program.interfaceAttrs, program.sigs, program.events];
  for (const fm of program.functionModules?.values() ?? []) {
    roots.push(fm.sig);
    if (fm.module?.body) roots.push(fm.module);
  }
  return roots;
}

export async function captureCorpus({checkTraversal = true, diagnostic = console.log} = {}) {
  // Resolve product modules in cwd, so --record genuinely runs the parent's
  // frontend-owned implementation in a separate worktree and process.
  const [{compileProgram}, {provenanceGraph}, {unitInputs}, {libraryPath}, {referencedClasses}] = await Promise.all([
    load('gogen/frontend.mjs'), load('gogen/frontend-provenance.mjs'), load('gogen/unit-inputs.mjs'),
    load('osd-lib-path.mjs'), load('gogen/emit-go.mjs'),
  ]);
  const helpers = checkTraversal ? await load('gogen/ir-children.ts') : null;
  const core = join(libraryPath('.', 'open-abap-core'), 'src');
  const ajson = join(libraryPath('.', 'ajson'), 'src/core');
  const config = JSON.parse(readFileSync('abap_transpile.json', 'utf8'));
  const env = {...process.env, OSD_TMP: 'off'};
  for (const key of ['OSD_PACKS', 'OSD_WEB_PACKS', 'OSD_LAYERS']) delete env[key];
  const {sources, folders, skip} = unitInputs({home: '.', config, fixture: 'tools/gogen/testdata', env, extraPacks: false});
  const owners = [...new Set(sources.map(objectName))].sort();
  const unitObjects = files('tools/gogen/testdata').filter((f) => /\.(clas\.abap|fugr\.xml)$/.test(f)).map(objectName);
  assert.ok(owners.length > 0, 'no unit fixture owners');
  const cases = [
    {name: 'unit', folders, skip, objects: [...unitObjects, 'CL_ABAP_UNIT_ASSERT', 'KERNEL_CX_ASSERT'],
      includeTests: new Set(owners), tolerant: true},
    {name: 'semantics', folders: ['tools/gogen/testdata', core, ajson],
      objects: [...names('.clas.abap'), ...names('.fugr.xml'), ...coreObjects]},
    // semantics.mjs compiles these separately, preserving refusal boundaries.
    ...[['ZCL_GOGEN_T_RF', 'ZCL_GOGEN_T_RF_OBJ', 'ZCL_GOGEN_T_RF_OWN'], ['ZCL_GOGEN_T_RF_SORT'],
      ['ZCL_GOGEN_T_RF_DELFROM'], ['ZCL_GOGEN_T_RF_SECKEYH'], ['ZCL_GOGEN_T_RF_WHEREI8'],
      ['ZCL_GOGEN_T_RF_RESUME', 'CX_SY_ZERODIVIDE']].map((objects, i) => ({name: `semantics-refused-${i}`,
      folders: ['tools/gogen/testdata-refused', core], objects, tolerant: true})),
  ];
  const payloads = {}, coverage = {};
  for (const {name, ...options} of cases) {
    let program;
    if (name === 'unit') {
      // Grow the actual unit dependency closure, just as unit.mjs does, while
      // retaining EVERY fixture class (not only owners with a test include).
      const wanted = new Set(options.objects);
      for (let round = 0; round < 12; round++) {
        program = compileProgram({...options, objects: [...wanted], provenance: true});
        const refs = new Set([...referencedClasses(program), ...program.missing]);
        for (const cls of program.classes) {
          const sup = program.reg.getObject('CLAS', cls.name)?.getDefinition()?.getSuperClass();
          if (sup) refs.add(sup.toUpperCase());
        }
        const added = [...refs].filter((ref) => !wanted.has(ref));
        if (!added.length) break;
        assert.ok(round < 11, 'unit dependency closure did not converge');
        added.forEach((ref) => wanted.add(ref));
      }
    } else program = compileProgram({...options, provenance: true});
    for (const owner of owners) if (name === 'unit') {
      assert.ok(program.classes.some((cls) => cls.name === owner), `unit owner omitted: ${owner}`);
      assert.ok(program.classes.some((cls) => cls.name.startsWith(`${owner}:`)), `unit test include omitted: ${owner}`);
    }
    // Inspect the direct recorded rows, without provenanceOf's inherited-edge
    // expansion/deduplication and without sorting names or rewriting payloads.
    const graph = provenanceGraph(program.reg);
    const rows = [...graph.artifacts.values(), ...graph.lowerings.values(), graph.global]
      .flatMap((entry) => [...entry.queries.values()]).filter((row) => row.kind === 'ownershipSafety');
    assert.ok(rows.length > 0, `${name}: no ownership provenance`);
    assert.ok(rows.some((row) => row.names.length > 0), `${name}: no names payload`);
    assert.ok(rows.some((row) => row.dynamic), `${name}: no dynamic payload`);
    payloads[name] = rows;
    coverage[name] = {...checkGraph(irRoots(program), helpers), classes: program.classes.length, unitOwners: name === 'unit' ? owners.length : 0,
      queries: rows.length, dynamicQueries: rows.filter((row) => row.dynamic).length};
    diagnostic(`${name}: ${coverage[name].nodes} nodes compared; ${Object.keys(coverage[name].kinds).length} kinds; ${rows.length} ownership payloads`);
    diagnostic(`${name} kind counts: ${JSON.stringify(coverage[name].kinds)}`);
  }
  return {payload: Buffer.from(JSON.stringify(payloads, null, 2) + '\n'), coverage};
}

async function main() {
  const [action, target, ...extra] = process.argv.slice(2);
  assert.ok(['--record', '--compare'].includes(action) && target && !extra.length,
    'usage: ir-children-proof.mjs --record <dir> | --compare <dir> (run from checkout root)');
  const {payload, coverage} = await captureCorpus({checkTraversal: action !== '--record'});
  if (action === '--record') {
    mkdirSync(target); // exclusive: preserve earlier evidence
    writeFileSync(join(target, 'ownership.json'), payload);
    writeFileSync(join(target, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');
  } else {
    const parent = readFileSync(join(target, 'ownership.json'));
    assert.ok(parent.equals(payload), `ownership provenance differs (${parent.length} parent / ${payload.length} candidate bytes)`);
    assert.deepEqual(coverage, JSON.parse(readFileSync(join(target, 'coverage.json'))), 'parent/candidate IR coverage differs');
    console.log(`ownership provenance: ${payload.length} byte-identical bytes (names/dynamic and complete query rows)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
