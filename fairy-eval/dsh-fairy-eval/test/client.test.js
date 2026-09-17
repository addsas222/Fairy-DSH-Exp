import assert from 'node:assert/strict';
import test from 'node:test';
import { createTypeSafeClient, readRetryAfterMs, retryDelayMs } from '../lib/client.js';
import { readTypeSafeConfig } from '../lib/config.js';
import { INVALID_KEY_MESSAGE, MISSING_KEY_MESSAGE } from '../lib/error.js';

const FAKE_KEY = 'ts_live_0123456789abcdef';
const QUESTIONS = { is_urgent: { type: 'noul', instructions: '是否紧急？' } };
const OK_BODY = { model: 'jev-latest', answers: { is_urgent: { type: 'noul', noul: 0.999 } }, usage: { input_tokens: 312, output_tokens: 48 } };

const configFor = (overrides = {}) => readTypeSafeConfig({
  env: {},
  dotenv: {},
  overrides: { apiKey: FAKE_KEY, timeoutMs: 1_000, ...overrides },
});

/** 最小 fetch 桩：记录调用，按脚本返回响应。 */
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    return response(step.status, step.body, step.headers);
  };
  return { fetchImpl, calls };
}

/** 官方文档里的响应形态：`text()` 是唯一读取入口（与 undici Response 同形）。 */
function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** 收集退避等待，不真的等。 */
function fakeSleep() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

test('请求形状：POST 官方端点 + Bearer 鉴权 + {state, model, questions}', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: OK_BODY }]);
  const client = createTypeSafeClient({ config: configFor(), fetchImpl });
  const body = await client.requestSystemOne({ state: '工单文本', questions: QUESTIONS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: '工单文本', model: 'jev-latest', questions: QUESTIONS });
  assert.equal(calls[0].init.signal instanceof AbortSignal, true, '每次请求都带超时信号');
  assert.deepEqual(body, OK_BODY);
});

test('缺 KEY：不发请求，直接给 A.md #9 的可操作文案', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: OK_BODY }]);
  const client = createTypeSafeClient({ config: readTypeSafeConfig({ env: {}, dotenv: {} }), fetchImpl });
  await assert.rejects(
    () => client.requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => {
      assert.equal(error.code, 'MISSING_API_KEY');
      assert.equal(error.message, MISSING_KEY_MESSAGE);
      assert.match(error.message, /https:\/\/console\.typesafe\.ai\//);
      assert.match(error.message, /TYPESAFE_API_KEY=你的_api_key/);
      return true;
    },
  );
  assert.equal(calls.length, 0, '缺 KEY 不应该打网络');
});

test('401 / 403：A.md #10 文案 + 掩码 KEY，且原文 KEY 不出现', async () => {
  for (const status of [401, 403]) {
    const { fetchImpl, calls } = scriptedFetch([{ status, body: { error: { message: 'invalid api key' } } }]);
    const client = createTypeSafeClient({ config: configFor(), fetchImpl });
    await assert.rejects(
      () => client.requestSystemOne({ state: 'x', questions: QUESTIONS }),
      (error) => {
        assert.equal(error.code, status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED');
        assert.equal(error.status, status);
        assert.equal(error.retryable, false);
        assert.match(error.message, /可能无效、过期或未设置/);
        assert.match(error.message, /ts_\.\.\.cdef/, '只显示掩码');
        assert.equal(error.message.includes(FAKE_KEY), false, '绝不能出现完整 KEY');
        assert.equal(error.detail, 'invalid api key');
        return true;
      },
    );
    assert.equal(calls.length, 1, '401/403 不重试');
  }
});

test('429：按退避重试并在成功后返回；Retry-After 生效', async () => {
  const { delays, sleep } = fakeSleep();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '2' } },
    { status: 429, body: { error: 'slow down' } },
    { status: 200, body: OK_BODY },
  ]);
  const client = createTypeSafeClient({ config: configFor(), fetchImpl, sleep });
  const body = await client.requestSystemOne({ state: 'x', questions: QUESTIONS });
  assert.deepEqual(body, OK_BODY);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [2000, 1000], '第一次听 Retry-After，第二次按 500ms 起的翻倍退避');
});

test('429 用尽重试后抛出 RATE_LIMITED（默认重试 2 次 = 3 次请求）', async () => {
  const { sleep } = fakeSleep();
  const { fetchImpl, calls } = scriptedFetch([{ status: 429, body: {} }]);
  const client = createTypeSafeClient({ config: configFor(), fetchImpl, sleep });
  await assert.rejects(
    () => client.requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'RATE_LIMITED' && error.retryable === true,
  );
  assert.equal(calls.length, 3);
});

test('529 过载与 5xx：可重试，重试耗尽后给 SERVER_ERROR / OVERLOADED', async () => {
  const overloaded = scriptedFetch([{ status: 529, body: {} }]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: overloaded.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'OVERLOADED' && error.status === 529,
  );
  assert.equal(overloaded.calls.length, 3);

  const serverError = scriptedFetch([{ status: 503, body: 'upstream down' }]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: serverError.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'SERVER_ERROR' && error.status === 503 && error.detail === 'upstream down',
  );
  assert.equal(serverError.calls.length, 3);
});

test('422 与未知 4xx：不重试', async () => {
  const invalid = scriptedFetch([{ status: 422, body: { detail: 'questions.foo.criteria is required' } }]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: invalid.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'INVALID_REQUEST' && error.retryable === false
      && error.message.includes('questions.foo.criteria is required'),
  );
  assert.equal(invalid.calls.length, 1);

  const weird = scriptedFetch([{ status: 418, body: {} }]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: weird.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'HTTP_ERROR' && error.status === 418,
  );
});

test('超时（AbortError/TimeoutError）与网络错误：分类正确且可重试', async () => {
  const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const timedOut = scriptedFetch([abort]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor({ timeoutMs: 5_000 }), fetchImpl: timedOut.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'TIMEOUT' && error.retryable === true && /超过 5 秒/.test(error.message)
      && /TYPESAFE_TIMEOUT_MS/.test(error.message),
  );
  assert.equal(timedOut.calls.length, 3, '超时也走重试');

  const offline = scriptedFetch([new TypeError('fetch failed')]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: offline.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'NETWORK' && error.retryable === true,
  );
});

test('响应解析失败：非 JSON → INVALID_JSON；缺 answers → INVALID_RESPONSE', async () => {
  const broken = scriptedFetch([{ status: 200, body: '<html>gateway</html>' }]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: broken.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'INVALID_JSON' && error.retryable === false && error.message.includes('<html>gateway</html>'),
  );
  assert.equal(broken.calls.length, 1, '解析失败不重试');

  const shaped = scriptedFetch([{ status: 200, body: { model: 'jev-latest' } }]);
  await assert.rejects(
    () => createTypeSafeClient({ config: configFor(), fetchImpl: shaped.fetchImpl, sleep: fakeSleep().sleep })
      .requestSystemOne({ state: 'x', questions: QUESTIONS }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
});

test('maxRetries=0 时不重试；configSummary 用 describe() 只报 KEY 存在性', async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 500, body: {} }]);
  const client = createTypeSafeClient({ config: configFor({ maxRetries: 0 }), fetchImpl, sleep: fakeSleep().sleep });
  await assert.rejects(() => client.requestSystemOne({ state: 'x', questions: QUESTIONS }), (error) => error.code === 'SERVER_ERROR');
  assert.equal(calls.length, 1);
  const summary = client.describe();
  assert.equal(summary.apiKey, '存在');
  assert.equal(JSON.stringify(summary).includes(FAKE_KEY), false);
});

test('Retry-After 解析：毫秒头优先、秒头换算、超长封顶、非法忽略', () => {
  assert.equal(readRetryAfterMs({ get: (name) => (name === 'retry-after' ? '3' : null) }), 3000);
  assert.equal(readRetryAfterMs({ get: (name) => (name === 'retry-after-ms' ? '1500' : '3') }), 1500);
  assert.equal(readRetryAfterMs({ get: () => '99999' }), 30_000, '封顶 30s');
  assert.equal(readRetryAfterMs({ get: () => 'later' }), undefined);
  assert.equal(readRetryAfterMs(undefined), undefined);
  assert.equal(readRetryAfterMs({ get: () => null }), undefined);
});

test('退避节奏：500ms 起、翻倍、封顶 5s，服务端给了 Retry-After 就用它', () => {
  const config = configFor();
  assert.equal(retryDelayMs({}, 0, config), 500);
  assert.equal(retryDelayMs({}, 1, config), 1000);
  assert.equal(retryDelayMs({}, 6, config), 5_000);
  assert.equal(retryDelayMs({ retryAfterMs: 1234 }, 0, config), 1234);
});
