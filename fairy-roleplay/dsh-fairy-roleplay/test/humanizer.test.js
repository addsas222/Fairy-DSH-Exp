import assert from 'node:assert/strict';
import test from 'node:test';
import { check, passes, renderReport } from '../lib/humanizer.js';

test('off level disables every check', () => {
  const result = check('值得注意的是，这不是方案A而是方案B。', { level: 'off' });
  assert.equal(result.depth, 0);
  assert.deepEqual(result.hits, []);
  assert.equal(result.score, 100);
});

test('L1 catches banned phrases and shell patterns with fixes', () => {
  const result = check('值得注意的是，这不是方案A而是方案B。', { level: 'l1' });
  const rules = result.hits.map((hit) => hit.rule);
  assert.ok(rules.some((rule) => rule.startsWith('banned:')), `expected a banned hit, got ${rules.join(',')}`);
  assert.ok(rules.includes('contrast-shell'), `expected contrast-shell, got ${rules.join(',')}`);
  for (const hit of result.hits) assert.ok(typeof hit.fix === 'string' && hit.fix.length > 0, `每个命中都要给出改法：${hit.rule}`);
  assert.ok(result.score < 100);
  assert.equal(passes(result), false);
});

test('quoted text is exempt from the word list', () => {
  const clean = check('他原话是「值得注意的是，这个值不能取 0」。', { level: 'l1' });
  assert.deepEqual(clean.hits.filter((hit) => hit.rule.startsWith('banned:')), []);
});

test('english slop only fires for english text', () => {
  const zh = check('我们要 leverage 这个工具。', { level: 'l1', locale: 'zh' });
  assert.equal(zh.hits.some((hit) => hit.rule === 'banned:en'), false);
  const en = check('We should leverage this tool.', { level: 'l1' });
  assert.equal(en.hits.some((hit) => hit.rule === 'banned:en'), true);
});

test('L1 does not report rhythm while L2 does', () => {
  const text = '今天天气真不错呀。明天天气也很好哈。后天看着也还行吧。';
  assert.equal(check(text, { level: 'l1' }).hits.length, 0);
  const l2 = check(text, { level: 'l2' });
  assert.ok(l2.hits.some((hit) => hit.rule === 'rhythm:equal-run'), `got ${JSON.stringify(l2.hits.map((hit) => hit.rule))}`);
});

test('dash abuse is a punctuation hit, one per over-used paragraph', () => {
  const text = '他说——真的——就是——这样。';
  const result = check(text, { level: 'l1' });
  assert.equal(result.hits.filter((hit) => hit.rule === 'punctuation:dash').length, 1);
});

test('L4 asks for a read-through only when nothing mechanical was found', () => {
  const clean = check('嗯，这样就行。', { level: 'l4' });
  assert.equal(clean.hits.length, 0);
  assert.equal(clean.requiresReading, true);
  const dirty = check('值得注意的是，这样就行。', { level: 'l4' });
  assert.equal(dirty.requiresReading, false);
});

test('report renders hits, and stays quiet when the level is off', () => {
  assert.equal(renderReport({ depth: 0, hits: [] }), '去AI味检查已关闭。');
  const report = renderReport(check('综上所述，就这样。', { level: 'l1' }));
  assert.match(report, /命中 \d+ 处/);
  assert.match(report, /综上所述/);
});
