import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeStyleEntries,
  parseStyleEntries,
  parseStyleFile,
  renderStyleBlock,
} from '../lib/style.js';

test('parseStyleEntries tolerates code fences and drops incomplete rows', () => {
  const entries = parseStyleEntries('```json\n[{"situation":"被夸时","style":"这么强"},{"situation":"","style":"空情境"},{"style":"缺情境"}]\n```');
  assert.deepEqual(entries.map((entry) => [entry.situation, entry.style]), [['被夸时', '这么强']]);
});

test('parseStyleEntries returns nothing for unparseable input', () => {
  assert.deepEqual(parseStyleEntries('看不懂的内容'), []);
  assert.deepEqual(parseStyleEntries(undefined), []);
});

test('mergeStyleEntries deduplicates identical habits and counts repeats', () => {
  const first = mergeStyleEntries([], [{ situation: '被夸时', style: '这么强' }]);
  assert.equal(first.length, 1);
  assert.equal(first[0].weight, 1);
  const second = mergeStyleEntries(first, [{ situation: '被夸时', style: '这么强' }, { situation: '表示同意', style: '对对对' }]);
  assert.equal(second.length, 2);
  const repeated = second.find((entry) => entry.style === '这么强');
  assert.equal(repeated.weight, 2, 'a repeated habit must gain weight rather than duplicate');
  assert.equal(second[0].style, '这么强', 'higher weight sorts first');
});

test('mergeStyleEntries caps the library and truncates long fields', () => {
  const many = Array.from({ length: 12 }, (_value, index) => ({ situation: `情境${index}`, style: '表达' }));
  const merged = mergeStyleEntries([], many, { limit: 5 });
  assert.equal(merged.length, 5);
  const truncated = mergeStyleEntries([], [{ situation: '这是一个非常非常非常非常非常非常长的情境描述', style: '表达' }]);
  assert.ok(truncated[0].situation.length <= 20, `expected a bounded situation, got ${truncated[0].situation.length}`);
});

test('parseStyleFile degrades to an empty library on corrupt input', () => {
  assert.deepEqual(parseStyleFile('{ not json').entries, []);
  assert.deepEqual(parseStyleFile('{"entries":[{"situation":"吃饭前","style":"干饭了"}]}').entries.length, 1);
});

test('renderStyleBlock is empty for an empty library and readable otherwise', () => {
  assert.equal(renderStyleBlock([]), '');
  const block = renderStyleBlock([{ situation: '被夸时', style: '这么强' }]);
  assert.match(block, /当被夸时时，可以用「这么强」/);
});
