import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoleplayPrefsText } from '../lib/prefs.js';

const settings = (over = {}) => ({
  humanizerLevel: 'l1',
  timingGate: true,
  styleEnabled: true,
  autoCheck: true,
  memoryImpression: true,
  ...over,
});

test('the timing gate speaks in both states — an off switch must be able to override the base rules', () => {
  assert.match(buildRoleplayPrefsText(settings(), []), /时机门开启/);
  assert.match(buildRoleplayPrefsText(settings({ timingGate: false }), []), /时机门已关闭/);
});

test('the style library is injected when enabled and explicitly dropped when not', () => {
  const entries = [{ situation: '被夸时', style: '这么强' }];
  const on = buildRoleplayPrefsText(settings(), entries);
  assert.match(on, /这么强/);
  const off = buildRoleplayPrefsText(settings({ styleEnabled: false }), entries);
  assert.equal(off.includes('这么强'), false, 'a disabled library must not leak into the prompt');
  assert.match(off, /风格库已关闭/);
  assert.equal(buildRoleplayPrefsText(settings(), []).includes('语言习惯'), false, 'no entries, no block');
});

test('the de-AI level selects the self-check instruction, and off drops the check line', () => {
  assert.match(buildRoleplayPrefsText(settings({ humanizerLevel: 'l3' }), []), /L3/);
  const off = buildRoleplayPrefsText(settings({ humanizerLevel: 'off' }), []);
  assert.match(off, /去AI味自检：关闭/);
  assert.equal(off.includes('roleplay_check'), false, 'no level, no self-check instruction');
  const unknown = buildRoleplayPrefsText(settings({ humanizerLevel: 'nonsense' }), []);
  assert.match(unknown, /L1/, 'an unknown level falls back to L1');
});

test('the self-check and memory toggles switch their instruction off', () => {
  assert.match(buildRoleplayPrefsText(settings(), []), /roleplay_check/);
  assert.match(buildRoleplayPrefsText(settings({ autoCheck: false }), []), /自检已关闭/);
  assert.match(buildRoleplayPrefsText(settings(), []), /memory_remember/);
  assert.match(buildRoleplayPrefsText(settings({ memoryImpression: false }), []), /不要为这段对话写长期记忆/);
});

test('every state still renders one scoped section with a stable heading', () => {
  const text = buildRoleplayPrefsText(settings(), []);
  const lines = text.split('\n');
  assert.equal(lines[0], '## 角色扮演偏好（设置卡）');
  assert.ok(lines.slice(1).every((line) => line.startsWith('- ') || line.startsWith('## ')), 'body is bullets or a style sub-block');
  assert.equal(buildRoleplayPrefsText(undefined, []).startsWith('## 角色扮演偏好（设置卡）'), true, 'missing settings still render defaults');
});
