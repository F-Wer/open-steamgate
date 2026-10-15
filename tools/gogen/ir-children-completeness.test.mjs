import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {irChildren, irEntries} from './ir-children.ts';
import {captureCorpus} from './ir-children-proof.mjs';

const contract = fileURLToPath(new URL('./ir.ts', import.meta.url));

// The checker, rather than a hand-maintained list of syntax forms, resolves
// intersections, aliases, optional members, nested records and container values.
export function declaredShapes(file = contract) {
  const program = ts.createProgram([file], {strict: true, noEmit: true,
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext});
  const source = program.getSourceFile(file), checker = program.getTypeChecker();
  assert.deepEqual(program.getSyntacticDiagnostics(source), []);
  const local = (symbol) => symbol?.declarations?.some((d) => d.getSourceFile() === source);
  const propertyType = (p) => checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations?.[0] ?? source);
  const parts = (t) => t.isUnion() ? t.types : [t];
  const properties = (t) => checker.getPropertiesOfType(t).filter(local);
  const containers = (t) => {
    if (checker.isArrayType(t) || checker.isTupleType(t)
        || ['Map', 'ReadonlyMap', 'Set', 'ReadonlySet'].includes(t.symbol?.name)) {
      return checker.getTypeArguments(t);
    }
    return checker.getIndexInfosOfType(t).map((i) => i.type);
  };
  const tags = (t) => ['e', 's', 'c', 'k'].flatMap((key) => {
    const prop = checker.getPropertyOfType(t, key);
    return prop ? parts(propertyType(prop)).filter((p) => p.isStringLiteral()).map((p) => [key, p.value]) : [];
  });
  const containsNode = (t, seen = new Set()) => {
    if (seen.has(t)) return false;
    seen.add(t);
    if (tags(t).length) return true;
    return (t.isUnion() ? t.types : [...containers(t), ...properties(t).map(propertyType)])
      .some((child) => containsNode(child, seen));
  };
  const declarations = source.statements.filter((d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d));
  const labels = new Map();
  for (const declaration of declarations) {
    const type = checker.getTypeAtLocation(declaration);
    if (!labels.has(type)) labels.set(type, declaration.name.text);
    parts(type).forEach((part, i) => {
      if (!labels.has(part)) labels.set(part, `${declaration.name.text}[${tags(part).map(([k, v]) => `${k}:${v}`).join('|') || i}]`);
    });
  }
  const shapes = [], seen = new Set();
  const visit = (t, path) => {
    if (seen.has(t)) return;
    seen.add(t);
    path = labels.get(t) ?? path;
    if (t.isUnion()) { t.types.forEach((p, i) => visit(p, `${path}[${i}]`)); return; }
    containers(t).forEach((p, i) => visit(p, `${path}<${i}>`));
    const props = properties(t);
    const index = t.flags & ts.TypeFlags.Object ? checker.getIndexInfoOfType(t, ts.IndexKind.String) : undefined;
    if (!props.length && !index) return; // primitives, opaque tokens and external parser objects
    const discriminants = tags(t);
    const keys = props.map((p) => p.name);
    const childKeys = props.filter((p) => containsNode(propertyType(p))).map((p) => p.name);
    if (index) {
      keys.push('$index');
      if (containsNode(index.type)) childKeys.push('$index');
    }
    shapes.push({shape: path, kinds: discriminants.map(([k, v]) => `${k}:${v}`), keys, childKeys, discriminants});
    props.forEach((p) => visit(propertyType(p), `${path}.${p.name}`));
  };
  // Start every declaration, including Type/struct, Condition, Program, Class,
  // Method and the untagged SQL/argument/catch/template/record wrappers.
  for (const declaration of declarations) visit(checker.getTypeAtLocation(declaration), declaration.name.text);
  return shapes;
}

test('every declared IR shape exposes all child-bearing keys', (t) => {
  const shapes = declaredShapes();
  const inventory = shapes.map(({discriminants, ...shape}) => shape);
  // Deliberate review gate: adding a kind/key to ir.ts changes this inventory,
  // even while the current fully generic runtime helper already handles it.
  assert.deepEqual(inventory, JSON.parse(readFileSync(new URL('./fixtures/ir-children-shapes.json', import.meta.url))),
    'IR declarations changed; review and regenerate the declared-shape inventory');
  const kinds = new Set(shapes.flatMap((s) => s.kinds));
  for (const {shape, keys, childKeys, discriminants} of shapes) {
    // Populate optional properties too. Unique values make key omissions,
    // duplicates, substitutions and reordering observable by identity.
    const variants = discriminants.length ? discriminants : [[null, null]];
    for (const [tag, value] of variants) for (const order of [keys, [...keys].reverse()]) {
      const node = Object.fromEntries(order.map((key) => [key, key === tag ? value : Object.freeze({shape, key})]));
      // JavaScript enumerates integer keys first (ArithmeticBranches has '8').
      const enumerationOrder = Object.keys(node);
      const values = new Map(Object.entries(node).map(([key, v]) => [v, key]));
      const actualEntries = irEntries(node);
      assert.deepEqual(actualEntries.map(([key]) => key), enumerationOrder, shape);
      actualEntries.forEach(([key, v]) => assert.equal(v, node[key], `${shape}.${key}`));
      for (const excluded of [[], ['type'], ['type', 'pos'], ['type', 'pos', 'token']]) {
        const actual = irChildren(node, excluded).map((v) => values.get(v));
        assert.deepEqual(actual, enumerationOrder.filter((k) => !excluded.includes(k)), shape);
        assert.deepEqual(actual.filter((k) => childKeys.includes(k)),
          enumerationOrder.filter((k) => childKeys.includes(k) && !excluded.includes(k)), `${shape}: IR child keys`);
      }
      assert.deepEqual(irChildren(node), irChildren(node, ['type', 'pos']), `${shape}: default exclusions`);
    }
  }
  t.diagnostic(`static: ${kinds.size} tagged kinds, ${shapes.length} declared object shapes, ${shapes.reduce((n, s) => n + s.childKeys.length, 0)} child-bearing keys`);
});

test('declaration discovery detects new nested, indexed, optional and mapped children', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-children-contract-'));
  try {
    const file = join(dir, 'ir.ts');
    writeFileSync(file, `type Expr = {e: 'leaf'};
      type Stmt = {s: 'new-kind'; added?: readonly {nested: ReadonlyMap<string, Expr>}[];
        dictionary: Readonly<Record<string, {value: Expr}>>; tuple: readonly [string, Expr]};`);
    const shapes = declaredShapes(file);
    assert.deepEqual(shapes.find((s) => s.kinds.includes('s:new-kind')).childKeys, ['added', 'dictionary', 'tuple']);
    assert.ok(shapes.some((s) => s.childKeys.includes('nested')));
    assert.ok(shapes.some((s) => s.childKeys.includes('$index')));
    assert.ok(shapes.some((s) => s.childKeys.includes('value')));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('unit fixture and semantics IR retain every legacy child in order', async (t) => {
  await captureCorpus({diagnostic: (message) => t.diagnostic(message)});
});
