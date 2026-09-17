import assert from 'node:assert/strict';
import test from 'node:test';
import { choice, normalizeQuestions, normalizeState, noul, score, validateQuestion } from '../lib/schema.js';
import { TRIAGE_QUESTIONS, triageQuestions } from '../lib/examples.js';

test('三类问题的构造器产出官方字段形状', () => {
  assert.deepEqual(noul('是否紧急？'), { type: 'noul', instructions: '是否紧急？' });
  assert.deepEqual(noul('是否紧急？', { true: '有压力', false: '无压力' }), {
    type: 'noul', instructions: '是否紧急？', criteria: { true: '有压力', false: '无压力' },
  });
  assert.deepEqual(choice('哪个团队？', { billing: '支付', technical: null }), {
    type: 'choice', instructions: '哪个团队？', criteria: { billing: '支付', technical: null },
  });
  assert.deepEqual(score('沮丧程度？', ['平静', '暴怒']), {
    type: 'score', instructions: '沮丧程度？', criteria: ['平静', '暴怒'],
  });
  const built = triageQuestions();
  assert.deepEqual(Object.keys(built), ['is_urgent', 'department', 'frustration']);
  assert.equal(built.is_urgent.type, 'noul');
  assert.equal(built.department.type, 'choice');
  assert.equal(built.frustration.type, 'score');
  assert.equal(TRIAGE_QUESTIONS.frustration.criteria.length, 3);
});

test('校验：类型、instructions、Choice 选项数、Score 级数、Noul criteria 键', () => {
  assert.deepEqual(validateQuestion('ok', { type: 'noul', instructions: 'x' }), []);
  assert.match(validateQuestion('q', { type: 'single', instructions: 'x' })[0], /type 必须是/);
  assert.match(validateQuestion('q', { type: 'noul', instructions: '   ' })[0], /instructions/);
  assert.match(validateQuestion('q', { type: 'choice', instructions: 'x' }).join('；'), /criteria 必须是/);
  assert.match(validateQuestion('q', { type: 'choice', instructions: 'x', criteria: { a: 'A' } }).join('；'), /至少要有 2 个选项/);
  assert.match(validateQuestion('q', { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 3 } }).join('；'), /必须是字符串或 null/);
  assert.match(validateQuestion('q', { type: 'score', instructions: 'x', criteria: ['一级'] }).join('；'), /至少要有 2 个等级/);
  assert.match(validateQuestion('q', { type: 'score', instructions: 'x', criteria: '平静' }).join('；'), /有序字符串数组/);
  assert.match(validateQuestion('q', { type: 'noul', instructions: 'x', criteria: { yes: 'y' } }).join('；'), /只接受 true \/ false/);
  assert.match(validateQuestion('q', null)[0], /必须是对象/);
});

test('normalizeQuestions 接受对象与带代码块的 JSON 文本', () => {
  const fromObject = normalizeQuestions({ a: { type: 'noul', instructions: 'x' } });
  assert.equal(fromObject.a.type, 'noul');
  const fromText = normalizeQuestions('```json\n{"a":{"type":"score","instructions":"x","criteria":["低","高"]}}\n```');
  assert.deepEqual(fromText.a.criteria, ['低', '高']);
  assert.throws(() => normalizeQuestions('{oops'), (error) => error.code === 'INVALID_ARGS' && /不是合法 JSON/.test(error.message));
  assert.throws(() => normalizeQuestions({}), (error) => error.code === 'INVALID_ARGS' && /至少要有一个问题/.test(error.message));
  assert.throws(() => normalizeQuestions({ a: { type: 'noul' } }), (error) => error.code === 'INVALID_ARGS' && /校验失败/.test(error.message));
});

test('问题条数上限：超过 64 个直接拒绝', () => {
  const many = Object.fromEntries(Array.from({ length: 65 }, (_value, index) => [`q${index}`, { type: 'noul', instructions: 'x' }]));
  assert.throws(() => normalizeQuestions(many), (error) => error.code === 'INVALID_ARGS' && /最多 64 个问题/.test(error.message));
});

test('normalizeState 接受字符串/对象/数组，拒绝空与超长', () => {
  assert.equal(normalizeState('  文本  '), '  文本  ');
  assert.deepEqual(normalizeState({ turns: [] }), { turns: [] });
  assert.deepEqual(normalizeState(['a']), ['a']);
  assert.throws(() => normalizeState('   '), (error) => error.code === 'INVALID_ARGS' && /不能是空字符串/.test(error.message));
  assert.throws(() => normalizeState(42), (error) => error.code === 'INVALID_ARGS' && /字符串、对象或数组/.test(error.message));
  assert.throws(() => normalizeState('x'.repeat(20_001)), (error) => error.code === 'INVALID_ARGS' && /state 过长/.test(error.message));
});
