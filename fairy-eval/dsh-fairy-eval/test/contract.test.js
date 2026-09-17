import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { NAME, ROUTES, apply as applyHost, createTypeSafeHandlers, evaluate, httpFailureFor, maskKey, triageQuestions } from '../lib/index.js';
import { apply as applyEngine } from '../lib/engine.js';
import { TRIAGE_STATE } from '../lib/examples.js';
import { readTypeSafeConfig } from '../lib/config.js';
import { MISSING_KEY_MESSAGE, TypeSafeError } from '../lib/error.js';
import { MOCK_RESPONSE } from '../examples/mock-response.mjs';

const FAKE_KEY = 'ts_live_0123456789abcdef';

const configFor = (overrides = {}) => readTypeSafeConfig({
  env: {},
  dotenv: {},
  overrides: { apiKey: FAKE_KEY, timeoutMs: 1_000, ...overrides },
});

/** 诊断桩：静音但留下调用记录。 */
function stubDiagnostics() {
  const warnings = [];
  return {
    warnings,
    guard: (operation, callback) => callback(),
    guardAsync: async (operation, callback) => callback(),
    metric: () => {},
    info: () => {},
    warn: (operation, context, error) => { warnings.push({ operation, context, error }); },
    error: () => {},
  };
}

function fakeAgentCtx() {
  const tools = [];
  return { tools, ctx: { tools: { register: (tool) => { tools.push(tool); return () => {}; } } } };
}

function fakeHostCtx() {
  const routes = [];
  const ctx = {
    inject(_services, run) {
      run({ effect: (fn) => fn(), webServer: { register: (definition) => { routes.push(definition); return () => {}; } } });
    },
  };
  return { routes, ctx };
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (payload) => { res.body = JSON.parse(payload); };
  return res;
}

function fakeReq(body) {
  const req = new EventEmitter();
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

test('包契约：宿主面导出 NAME/apply/ROUTES，agent 面注册 typesafe_eval', async () => {
  assert.equal(NAME, 'dsh-fairy-eval');
  assert.equal(typeof applyHost, 'function');
  assert.equal(typeof applyEngine, 'function');
  assert.deepEqual([...ROUTES], ['/fairy-eval/status', '/fairy-eval/evaluate']);
  assert.equal(typeof evaluate, 'function');
  assert.equal(typeof maskKey, 'function');
  assert.deepEqual(Object.keys(triageQuestions()), ['is_urgent', 'department', 'frustration']);
});

test('宿主 apply：注册两个 exact 路由', () => {
  const { ctx, routes } = fakeHostCtx();
  applyHost(ctx, { diagnostics: stubDiagnostics() });
  assert.deepEqual(routes.map((route) => route.path), [...ROUTES]);
  assert.deepEqual(routes.map((route) => route.kind), ['exact', 'exact']);
  assert.equal(routes.every((route) => typeof route.handler === 'function'), true);
});

test('agent apply：缺 KEY 时只报「不存在」并给出可操作告警，注册工具照常', () => {
  const { ctx, tools } = fakeAgentCtx();
  const sink = stubDiagnostics();
  applyEngine(ctx, { diagnostics: sink, config: readTypeSafeConfig({ env: {}, dotenv: {} }) });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'typesafe_eval');
  assert.equal(sink.warnings.length, 1);
  assert.equal(sink.warnings[0].context.apiKey, '不存在');
  assert.equal(sink.warnings[0].error.message, MISSING_KEY_MESSAGE);
  assert.equal(JSON.stringify(sink.warnings).includes('Bearer'), false);
});

test('agent apply：有 KEY 时不告警', () => {
  const { ctx, tools } = fakeAgentCtx();
  const sink = stubDiagnostics();
  applyEngine(ctx, { diagnostics: sink, config: configFor() });
  assert.equal(tools.length, 1);
  assert.deepEqual(sink.warnings, []);
});

test('GET /fairy-eval/status：只报 KEY 存在性，缺 KEY 时附可操作帮助', async () => {
  const present = createTypeSafeHandlers({ readConfig: () => configFor(), logger: stubDiagnostics() });
  const resPresent = fakeRes();
  await present.status(fakeReq(), resPresent);
  assert.equal(resPresent.statusCode, 200);
  assert.equal(resPresent.body.ok, true);
  assert.equal(resPresent.body.apiKey, '存在');
  assert.equal(resPresent.body.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(resPresent.body.model, 'jev-latest');
  assert.deepEqual(resPresent.body.questionIds, ['is_urgent', 'department', 'frustration']);
  assert.equal(JSON.stringify(resPresent.body).includes(FAKE_KEY), false, '状态响应不得携带 KEY 原文');
  assert.equal('help' in resPresent.body, false);

  const missing = createTypeSafeHandlers({ readConfig: () => readTypeSafeConfig({ env: {}, dotenv: {} }), logger: stubDiagnostics() });
  const resMissing = fakeRes();
  await missing.status(fakeReq(), resMissing);
  assert.equal(resMissing.body.apiKey, '不存在');
  assert.equal(resMissing.body.help, MISSING_KEY_MESSAGE);
});

test('POST /fairy-eval/evaluate：端到端跑通（mock fetch），默认用内置三问', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(MOCK_RESPONSE) };
  };
  const handlers = createTypeSafeHandlers({ readConfig: () => configFor(), fetchImpl, logger: stubDiagnostics() });
  const res = fakeRes();
  await handlers.evaluate(fakeReq({ state: TRIAGE_STATE }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.model, 'jev-latest');
  assert.equal(res.body.answers.department.choice, 'technical');
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent.questions), ['is_urgent', 'department', 'frustration']);
  assert.equal(sent.state, TRIAGE_STATE);
});

test('POST /fairy-eval/evaluate：缺 state / 非法 JSON / 缺 KEY 各自的状态码与文案', async () => {
  const handlers = createTypeSafeHandlers({ readConfig: () => configFor(), logger: stubDiagnostics() });

  const noState = fakeRes();
  await handlers.evaluate(fakeReq({}), noState);
  assert.equal(noState.statusCode, 400);
  assert.equal(noState.body.code, 'INVALID_ARGS');
  assert.equal(noState.body.exampleState, TRIAGE_STATE);

  const badJson = fakeRes();
  await handlers.evaluate(fakeReq('{not json'), badJson);
  assert.equal(badJson.statusCode, 400);
  assert.equal(badJson.body.code, 'BAD_JSON');

  const noKey = createTypeSafeHandlers({ readConfig: () => readTypeSafeConfig({ env: {}, dotenv: {} }), logger: stubDiagnostics() });
  const missingKeyRes = fakeRes();
  await noKey.evaluate(fakeReq({ state: TRIAGE_STATE }), missingKeyRes);
  assert.equal(missingKeyRes.statusCode, 400);
  assert.equal(missingKeyRes.body.code, 'MISSING_API_KEY');
  assert.equal(missingKeyRes.body.error, MISSING_KEY_MESSAGE);
});

test('POST /fairy-eval/evaluate：上游错误映射成对应 HTTP 状态', async () => {
  const unauthorized = createTypeSafeHandlers({
    readConfig: () => configFor(),
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => '{"error":"nope"}' }),
    logger: stubDiagnostics(),
  });
  const res401 = fakeRes();
  await unauthorized.evaluate(fakeReq({ state: TRIAGE_STATE }), res401);
  assert.equal(res401.statusCode, 401);
  assert.equal(res401.body.code, 'UNAUTHORIZED');
  assert.match(res401.body.error, /重新获取，并更新 TYPESAFE_API_KEY/);
  assert.equal(res401.body.error.includes(FAKE_KEY), false);
});

test('httpFailureFor：code → 状态码映射（含超时与请求体问题）', () => {
  const table = [
    [new TypeSafeError('x', { code: 'MISSING_API_KEY' }), 400],
    [new TypeSafeError('x', { code: 'UNAUTHORIZED' }), 401],
    [new TypeSafeError('x', { code: 'FORBIDDEN' }), 403],
    [new TypeSafeError('x', { code: 'INVALID_REQUEST' }), 422],
    [new TypeSafeError('x', { code: 'RATE_LIMITED' }), 429],
    [new TypeSafeError('x', { code: 'OVERLOADED' }), 529],
    [new TypeSafeError('x', { code: 'TIMEOUT' }), 504],
    [new TypeSafeError('x', { code: 'NETWORK' }), 502],
    [Object.assign(new Error('payload-too-large'), { code: 'payload-too-large' }), 413],
    [new Error('unexpected'), 502],
  ];
  for (const [error, status] of table) {
    const failure = httpFailureFor(error);
    assert.equal(failure.status, status, `${error.code ?? error.message} 应映射到 ${status}`);
    assert.equal(failure.payload.ok, false);
    assert.equal(typeof failure.payload.error, 'string');
  }
  assert.equal(httpFailureFor(new TypeSafeError('上游炸了', { code: 'SERVER_ERROR' })).payload.error, '上游炸了');
});
