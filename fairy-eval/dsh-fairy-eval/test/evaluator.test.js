import assert from 'node:assert/strict';
import test from 'node:test';
import { readTypeSafeConfig } from '../lib/config.js';
import { createTypeSafeEvaluator, evaluate } from '../lib/evaluator.js';
import { TRIAGE_QUESTIONS } from '../lib/examples.js';
import { MOCK_RESPONSE } from '../examples/mock-response.mjs';

const FAKE_KEY = 'ts_live_0123456789abcdef';
const STATE = '客户：Stripe 接了三天还是失败，我在丢单，请尽快处理。';

const configFor = (overrides = {}) => readTypeSafeConfig({
  env: {},
  dotenv: {},
  overrides: { apiKey: FAKE_KEY, timeoutMs: 1_000, ...overrides },
});

/** 记录调用的 fetch 桩：只回 200 + 官方示例响应。 */
function countingFetch(response = MOCK_RESPONSE) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(response) };
    },
  };
}

test('三类问题（Noul/Choice/Score）一次调用拿全，绝不拆成多次请求', async () => {
  const { fetchImpl, calls } = countingFetch();
  const output = await evaluate(STATE, TRIAGE_QUESTIONS, { config: configFor(), fetchImpl });
  assert.equal(calls.length, 1, '三个问题也只发一个请求（官方 fan-out 口径）');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body).questions), ['is_urgent', 'department', 'frustration']);
  assert.deepEqual(Object.keys(output.answers), ['is_urgent', 'department', 'frustration']);
});

test('统一输出结构：answers / confidence / usage / raw', async () => {
  const { fetchImpl } = countingFetch();
  const output = await evaluate(STATE, TRIAGE_QUESTIONS, { config: configFor(), fetchImpl });

  assert.equal(output.model, 'jev-latest');
  assert.equal(output.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(output.answers.is_urgent, { id: 'is_urgent', type: 'noul', noul: 0.999, yes: true, confidence: null });
  assert.deepEqual(output.answers.department, {
    id: 'department',
    type: 'choice',
    choice: 'technical',
    probabilities: { billing: 0.159, technical: 0.84, sales: 0.001 },
    confidence: 0.596,
  });
  assert.equal(output.answers.frustration.type, 'score');
  assert.equal(output.answers.frustration.score, 1.035);
  assert.deepEqual(output.answers.frustration.legend, { 0: '平静，只是陈述事实', 1: '有些沮丧但保持礼貌', 2: '非常愤怒，措辞激烈' });
  assert.equal(output.answers.frustration.confidence, 0.842);

  assert.deepEqual(output.confidence, { is_urgent: null, department: 0.596, frustration: 0.842 });
  assert.deepEqual(output.usage, { inputTokens: 312, outputTokens: 48 });
  assert.deepEqual(output.raw, MOCK_RESPONSE, 'raw 保留官方响应原文');
});

test('Noul 阈值：≥0.5 判为「是」，置信度如实为 null（官方不给该字段）', async () => {
  const low = { ...MOCK_RESPONSE, answers: { ...MOCK_RESPONSE.answers, is_urgent: { type: 'noul', noul: 0.2 } } };
  const { fetchImpl } = countingFetch(low);
  const output = await evaluate(STATE, TRIAGE_QUESTIONS, { config: configFor(), fetchImpl });
  assert.equal(output.answers.is_urgent.yes, false);
  assert.equal(output.confidence.is_urgent, null);
});

test('问题可用 JSON 文本传入；请求了但没答的问题标记 missing', async () => {
  const { fetchImpl, calls } = countingFetch({ model: 'jev-latest', answers: { is_urgent: { type: 'noul', noul: 0.6 } }, usage: {} });
  const output = await evaluate(STATE, JSON.stringify(TRIAGE_QUESTIONS), { config: configFor(), fetchImpl });
  assert.equal(JSON.parse(calls[0].init.body).questions.department.type, 'choice');
  assert.equal(output.answers.department.type, 'missing');
  assert.equal(output.usage.inputTokens, null);
  assert.equal(output.answers.is_urgent.yes, true);
});

test('model 覆盖走到请求体里', async () => {
  const { fetchImpl, calls } = countingFetch();
  await evaluate(STATE, TRIAGE_QUESTIONS, { config: configFor({ model: 'jev-latest' }), fetchImpl, model: 'jev-experimental' });
  assert.equal(JSON.parse(calls[0].init.body).model, 'jev-experimental');
});

test('入参错误在发请求之前就失败', async () => {
  const { fetchImpl, calls } = countingFetch();
  await assert.rejects(() => evaluate('', TRIAGE_QUESTIONS, { config: configFor(), fetchImpl }),
    (error) => error.code === 'INVALID_ARGS');
  await assert.rejects(() => evaluate(STATE, { bad: { type: 'nope', instructions: 'x' } }, { config: configFor(), fetchImpl }),
    (error) => error.code === 'INVALID_ARGS');
  assert.equal(calls.length, 0);
});

test('evaluator 实例可复用，describe() 不泄露 KEY', async () => {
  const { fetchImpl, calls } = countingFetch();
  const evaluator = createTypeSafeEvaluator({ config: configFor(), fetchImpl });
  await evaluator.evaluate(STATE, TRIAGE_QUESTIONS);
  await evaluator.evaluate(STATE, JSON.stringify({ only: { type: 'noul', instructions: 'x' } }));
  assert.equal(calls.length, 2);
  assert.equal(evaluator.describe().apiKey, '存在');
  assert.equal(JSON.stringify(evaluator.describe()).includes(FAKE_KEY), false);
});
