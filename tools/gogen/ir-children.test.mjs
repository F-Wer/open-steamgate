import {test} from 'node:test';
import assert from 'node:assert/strict';
import {children, someExpression} from './ir-children.ts';

const legacyChildren = (node) => Object.entries(node).filter(([key]) => !['type', 'pos'].includes(key)).map(([, value]) => value);
const variable = (name) => ({e: 'var', name, type: {k: 'i'}});

test('ownership children retain wrapper identity, insertion order and exclusions', () => {
  const wrappers = [{value: variable('VALUE'), place: null}, {wrap: variable('WRAP')}];
  const node = {receiving: variable('RECEIVING'), pos: {file: 'fixture', row: 1},
    args: wrappers, type: {k: 'void'}, receiver: variable('RECEIVER'), e: 'call'};
  assert.deepEqual(children(node), legacyChildren(node));
  assert.equal(children(node)[1], wrappers);
  assert.deepEqual(children(wrappers), legacyChildren(wrappers));
});

test('expression traversal retains legacy order through arguments, conditions and templates', () => {
  const node = {e: 'cond', else: variable('ELSE'), branches: [{
    value: {e: 'template', parts: [{text: 'literal'}, {value: variable('TEMPLATE'), opts: {}}], type: {k: 'string'}},
    cond: {c: 'cmp', r: variable('RIGHT'), l: {e: 'call', args: [{place: variable('PLACE'), value: variable('VALUE'), wrap: variable('WRAP')}],
      receiving: variable('RECEIVING'), receiver: variable('RECEIVER'), type: {k: 'i'}}, type: {k: 'i'}},
  }], type: {k: 'i'}};
  const expected = [], actual = [];
  const legacy = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.e === 'var') expected.push(value.name);
    for (const [key, child] of Object.entries(value)) if (key !== 'type') legacy(child);
  };
  legacy(node);
  assert.equal(someExpression(node, (child) => { if (child.e === 'var') actual.push(child.name); return false; }), false);
  assert.deepEqual(actual, expected);
  const visited = [];
  assert.equal(someExpression(node, (child) => { visited.push(child.e); return child.e === 'var'; }), true);
  assert.deepEqual(visited, ['cond', 'var']);
});
