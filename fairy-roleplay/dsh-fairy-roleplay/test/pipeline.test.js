import assert from 'node:assert/strict';
import test from 'node:test';
import { assessReply, buildRoleplayBrief } from '../lib/pipeline.js';

test('the brief carries the persona, the rules and the chosen de-AI level', () => {
  const brief = buildRoleplayBrief({
    persona: { name: 'Fairy', description: '冷静的助理。' },
    settings: { humanizerLevel: 'l2', timingGate: true, styleEnabled: true },
  });
  assert.match(brief, /你扮演「Fairy」/);
  assert.match(brief, /## 时机/);
  assert.match(brief, /## 怎么说话/);
  assert.match(brief, /## 先想后说/);
  assert.match(brief, /L2/);
  assert.equal(brief.includes('时机门已关闭'), false);
});

test('style habits are injected only when the library has entries and is enabled', () => {
  const entries = [{ situation: '被夸时', style: '这么强' }];
  const withStyle = buildRoleplayBrief({ persona: { name: 'Fairy' }, styleEntries: entries, settings: { humanizerLevel: 'l1', styleEnabled: true } });
  assert.match(withStyle, /当被夸时时，可以用「这么强」/);
  const disabled = buildRoleplayBrief({ persona: { name: 'Fairy' }, styleEntries: entries, settings: { humanizerLevel: 'l1', styleEnabled: false } });
  assert.equal(disabled.includes('被夸时'), false);
  const empty = buildRoleplayBrief({ persona: { name: 'Fairy' }, styleEntries: [], settings: { humanizerLevel: 'l1' } });
  assert.equal(empty.includes('语言习惯'), false);
});

test('an unnamed persona still produces a usable brief', () => {
  const brief = buildRoleplayBrief({ settings: { humanizerLevel: 'off' } });
  assert.equal(brief.includes('角色身份'), false);
  assert.match(brief, /去AI味检查已关闭/);
  assert.match(brief, /## 怎么说话/);
});

test('assessReply gates a reply on the configured level', () => {
  const failing = assessReply('值得注意的是，这样就行。', { settings: { humanizerLevel: 'l1' } });
  assert.equal(failing.passed, false);
  assert.ok(failing.check.hits.length >= 1);
  assert.match(failing.report, /命中/);
  const passing = assessReply('嗯，这样就行。', { settings: { humanizerLevel: 'l1' } });
  assert.equal(passing.passed, true);
  const skipped = assessReply('值得注意的是，这样就行。', { settings: { humanizerLevel: 'off' } });
  assert.equal(skipped.passed, true, 'off means the gate is not applied');
});
