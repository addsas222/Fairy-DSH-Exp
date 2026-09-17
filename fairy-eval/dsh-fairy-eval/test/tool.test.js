import assert from 'node:assert/strict';
import test from 'node:test';
import { readTypeSafeConfig } from '../lib/config.js';
import { INVALID_KEY_MESSAGE, MISSING_KEY_MESSAGE, maskKey } from '../lib/error.js';
import { createTypeSafeEvaluator } from '../lib/evaluator.js';
import { EVAL_TOOL_NAME, TOOL_TIMEOUT_MS, createTypeSafeEvalTool } from '../lib/tool.js';
import { MOCK_RESPONSE } from '../examples/mock-response.mjs';

const FAKE_KEY = 'ts_live_0123456789abcdef';
const STATE = '客户：Stripe 接了三天还是失败，我在丢单，请尽快处理。';
const CUSTOM_QUESTIONS = {
  sentiment: { type: 'score', instructions: '情绪有多负面？', criteria: ['正面', '中性', '负面'] },
};

const configFor = (overrides = {}) => readTypeSafeConfig({
  env: {},
  dotenv: {},
  overrides: { apiKey: FAKE_KEY, timeoutMs: 1_000, ...overrides },
});

function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: () => null },
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)),
    };
  };
  return { fetchImpl, calls };
}

const toolFor = ({ config = configFor(), fetchImpl, evaluator } = {}) => createTypeSafeEvalTool({
  config,
  ...(fetchImpl === undefined ? {} : { fetchImpl }),
  ...(evaluator === undefined ? {} : { evaluator }),
  sleep: async () => {},
});

test('工具元数据：名字、必填 state、超时与并发安全标记', () => {
  const tool = toolFor();
  assert.equal(tool.name, EVAL_TOOL_NAME);
  assert.equal(tool.name, 'typesafe_eval');
  assert.deepEqual(tool.parameters.required, ['state']);
  assert.equal(tool.parameters.properties.questions.type, 'string');
  assert.equal(tool.timeoutMs, TOOL_TIMEOUT_MS);
  assert.equal(tool.isConcurrencySafe(), true);
  assert.equal(tool.output.schema.required.includes('report'), true);
  assert.equal(typeof tool.output.render, 'function');
});

test('一次调用三问，报告里三类答案都能读出来', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: MOCK_RESPONSE }]);
  const tool = toolFor({ fetchImpl });
  const result = await tool.execute({ state: STATE });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body).questions), ['is_urgent', 'department', 'frustration']);
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(result.model, 'jev-latest');
  assert.match(result.report, /is_urgent（noul）：是（0\.999/);
  assert.match(result.report, /department（choice）：technical（confidence 0\.596/);
  assert.match(result.report, /frustration（score）：1\.035（confidence 0\.842/);
  assert.match(result.report, /用量：input 312 \/ output 48 tokens/);
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.report }]);
});

test('自定义问题（JSON 文本）覆盖默认三问', async () => {
  const { fetchImpl, calls } = scriptedFetch([{
    status: 200,
    body: { model: 'jev-latest', answers: { sentiment: { type: 'score', score: 2, legend: { 0: '正面', 1: '中性', 2: '负面' }, probabilities: { 0: 0, 1: 0, 2: 1 }, confidence: 0.99 } }, usage: {} },
  }]);
  const tool = toolFor({ fetchImpl });
  const result = await tool.execute({ state: STATE, questions: JSON.stringify(CUSTOM_QUESTIONS) });
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body).questions), ['sentiment']);
  assert.equal(result.answers.sentiment.score, 2);
  assert.equal(result.confidence.sentiment, 0.99);
});

test('缺 KEY：返回 ok:false + A.md #9 文案，且不打网络', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: MOCK_RESPONSE }]);
  const tool = toolFor({ config: readTypeSafeConfig({ env: {}, dotenv: {} }), fetchImpl });
  const result = await tool.execute({ state: STATE });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MISSING_API_KEY');
  assert.equal(result.report, `TypeSafe 评估失败（MISSING_API_KEY）：${MISSING_KEY_MESSAGE}`);
  assert.match(result.report, /https:\/\/console\.typesafe\.ai\//);
  assert.match(result.report, /在项目根目录 \.env 中添加 TYPESAFE_API_KEY=你的_api_key/);
  assert.equal(calls.length, 0);
});

test('401：返回 A.md #10 文案，只带掩码 KEY', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 401, body: { error: 'unauthorized' } }]);
  const tool = toolFor({ fetchImpl });
  const result = await tool.execute({ state: STATE, questions: JSON.stringify(CUSTOM_QUESTIONS) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNAUTHORIZED');
  assert.equal(result.report, `TypeSafe 评估失败（UNAUTHORIZED）：${INVALID_KEY_MESSAGE}（当前使用的 Key：ts_...cdef）`);
  assert.equal(result.report.includes(FAKE_KEY), false, '报告里绝不能出现完整 KEY');
});

test('403 / 429 / 超时：各自归类，报告仍是中文可操作文案', async () => {
  const forbidden = await toolFor({ fetchImpl: scriptedFetch([{ status: 403, body: {} }]).fetchImpl })
    .execute({ state: STATE, questions: JSON.stringify(CUSTOM_QUESTIONS) });
  assert.equal(forbidden.code, 'FORBIDDEN');
  assert.match(forbidden.report, /重新获取，并更新 TYPESAFE_API_KEY 后重启插件/);

  const limited = await toolFor({ fetchImpl: scriptedFetch([{ status: 429, body: {} }]).fetchImpl })
    .execute({ state: STATE, questions: JSON.stringify(CUSTOM_QUESTIONS) });
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.match(limited.report, /限流（429 Too Many Requests）/);

  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const timedOut = scriptedFetch([{ status: 200, body: MOCK_RESPONSE }]);
  const timingFetch = async (url, init) => {
    timedOut.calls.push({ url, init });
    throw abort;
  };
  const timeout = await toolFor({ fetchImpl: timingFetch }).execute({ state: STATE, questions: JSON.stringify(CUSTOM_QUESTIONS) });
  assert.equal(timeout.code, 'TIMEOUT');
  assert.match(timeout.report, /请求超时/);
});

test('参数错误按仓库惯例抛出 INVALID_ARGS；异常实现归为 UNEXPECTED', async () => {
  const tool = toolFor();
  await assert.rejects(() => tool.execute({ state: '   ' }), (error) => error.code === 'INVALID_ARGS' && /non-empty|非空/.test(error.message));
  await assert.rejects(() => tool.execute({ state: STATE, questions: '{oops' }), (error) => error.code === 'INVALID_ARGS');

  const brokenEvaluator = createTypeSafeEvaluator({
    config: configFor(),
    client: { config: configFor(), requestSystemOne: async () => { throw new Error('boom'); }, describe: () => ({}) },
  });
  const broken = await toolFor({ evaluator: brokenEvaluator }).execute({ state: STATE });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'UNEXPECTED');
  assert.match(broken.report, /boom/);
});

test('掩码：形如 sk-...abcd；短输入与空输入不泄露任何内容', () => {
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-...abcd');
  assert.equal(maskKey('ts_live_0123456789abcdef'), 'ts_...cdef');
  assert.equal(maskKey('short'), '…');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(undefined), '');
  const long = 'x'.repeat(64);
  assert.notEqual(maskKey(long), long);
  assert.equal(maskKey(long).includes('x'.repeat(10)), false);
});
