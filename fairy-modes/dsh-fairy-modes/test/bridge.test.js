import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/bridge.js';

/** A request double carrying an optional JSON body the handler can read. */
function fakeRequest({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 0,
    writableEnded: false,
    destroyed: false,
    body: '',
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    end(text) {
      this.writableEnded = true;
      this.body = text;
    },
  };
}

/**
 * Host context double: the web-server registry, and whichever of the three
 * resolution services the case composes.
 */
function fakeBridgeHost({ agentPresets, agents, sessionController, projections } = {}) {
  const routes = new Map();
  const provided = new Map([
    ['agents', agents],
    ['agentPresets', agentPresets],
    ['sessionController', sessionController],
    ['sessionProjections', projections],
  ]);
  const ctx = {
    get: (name) => provided.get(name),
    effect: (factory) => factory(),
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        callback({
          effect: (factory) => factory(),
          webServer: {
            register(route) {
              routes.set(route.path, route.handler);
              return () => routes.delete(route.path);
            },
          },
        });
      }
      return null;
    },
  };
  apply(ctx);
  return routes;
}

function modeService(calls) {
  return {
    set(agent, mode) {
      calls.push({ op: 'set', agent, mode });
    },
    get(agent) {
      calls.push({ op: 'get', agent });
      return { mode: 'ptc' };
    },
  };
}

async function call(handler, request) {
  const response = fakeResponse();
  await handler(request, response);
  return { status: response.statusCode, value: response.body === '' ? null : JSON.parse(response.body) };
}

test('POST /fairy-modes/set reaches the session realm service', async () => {
  const calls = [];
  const agent = { session: { id: 's1' } };
  const routes = fakeBridgeHost({
    agents: { get: (id) => (id === 's1' ? agent : undefined) },
    agentPresets: { serviceFor: (target, name) => (name === 'fairyMode' ? modeService(calls) : undefined) },
  });

  const response = await call(routes.get('/fairy-modes/set'), fakeRequest({
    method: 'POST', url: '/fairy-modes/set', body: { sessionId: 's1', mode: 'ptc' },
  }));
  assert.deepEqual(response, { status: 200, value: { ok: true, mode: 'ptc' } });
  assert.deepEqual(calls, [{ op: 'set', agent, mode: 'ptc' }]);
});

test('POST /fairy-modes/set rejects an unknown mode and a bad body before resolving', async () => {
  const calls = [];
  const routes = fakeBridgeHost({
    agentPresets: { serviceFor: () => modeService(calls) },
  });
  const setRoute = routes.get('/fairy-modes/set');

  assert.deepEqual(await call(setRoute, fakeRequest({
    method: 'POST', body: { sessionId: 's1', mode: 'fast' },
  })), { status: 400, value: { ok: false, error: 'mode 必须是 off、explore、ptc、create 或 roleplay。' } });

  const malformed = fakeRequest({ method: 'POST' });
  malformed[Symbol.asyncIterator] = async function* malformedBody() { yield Buffer.from('{not json'); };
  const rejected = await call(setRoute, malformed);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.value.ok, false);

  const wrongMethod = await call(setRoute, fakeRequest({ method: 'GET', url: '/fairy-modes/set' }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(calls.length, 0);
});

test('POST /fairy-modes/set answers 422 for a session with no live Agent', async () => {
  const routes = fakeBridgeHost({
    agents: { get: () => undefined },
    agentPresets: { serviceFor: () => undefined },
  });
  const missing = await call(routes.get('/fairy-modes/set'), fakeRequest({
    method: 'POST', body: { mode: 'ptc' },
  }));
  assert.equal(missing.status, 422);

  const unknown = await call(routes.get('/fairy-modes/set'), fakeRequest({
    method: 'POST', body: { sessionId: 'ghost', mode: 'ptc' },
  }));
  assert.equal(unknown.status, 422);
  assert.match(unknown.value.error, /无法为会话 "ghost" 解析出活动 Agent/);
});

test('POST /fairy-modes/set answers 503 when agent-presets or the mode row is absent', async () => {
  const agent = { session: { id: 's1' } };
  const noRoster = fakeBridgeHost({ agents: { get: () => agent } });
  const roster = await call(noRoster.get('/fairy-modes/set'), fakeRequest({
    method: 'POST', body: { sessionId: 's1', mode: 'ptc' },
  }));
  assert.equal(roster.status, 503);
  assert.match(roster.value.error, /dsh-agent-presets/);

  const unmounted = fakeBridgeHost({
    agents: { get: () => agent },
    agentPresets: { serviceFor: () => undefined },
  });
  const row = await call(unmounted.get('/fairy-modes/set'), fakeRequest({
    method: 'POST', body: { sessionId: 's1', mode: 'ptc' },
  }));
  assert.equal(row.status, 503);
  assert.match(row.value.error, /未挂载 dsh-fairy-modes/);
});

test('GET /fairy-modes/state serves the mode and the official plan view', async () => {
  const agent = { session: { id: 's1' } };
  const calls = [];
  const routes = fakeBridgeHost({
    agents: { get: () => agent },
    agentPresets: { serviceFor: (target, name) => (name === 'fairyMode' ? modeService(calls) : undefined) },
    projections: { stateOf: (session, key) => (key === 'plan' ? { active: true, wanted: null, running: null } : undefined) },
  });

  const response = await call(routes.get('/fairy-modes/state'), fakeRequest({
    url: '/fairy-modes/state?sessionId=s1',
  }));
  assert.deepEqual(response, {
    status: 200,
    value: { ok: true, mode: 'ptc', plan: { active: true, pending: false } },
  });
  assert.deepEqual(calls, [{ op: 'get', agent }]);
});

test('GET /fairy-modes/state reports a pending plan selection and needs a session', async () => {
  const agent = { session: { id: 's1' } };
  const routes = fakeBridgeHost({
    agents: { get: () => agent },
    agentPresets: { serviceFor: () => modeService([]) },
    // A running /plan selection the next step will honour.
    projections: { stateOf: () => ({ active: false, wanted: null, running: { commandId: 'c1', wanted: true } }) },
  });
  const pending = await call(routes.get('/fairy-modes/state'), fakeRequest({ url: '/fairy-modes/state?sessionId=s1' }));
  assert.deepEqual(pending.value.plan, { active: false, pending: true });

  const missing = await call(routes.get('/fairy-modes/state'), fakeRequest({ url: '/fairy-modes/state' }));
  assert.equal(missing.status, 422);
  assert.match(missing.value.error, /缺少 sessionId/);
});

test('cold sessions resolve through the session controller', async () => {
  const agent = { session: { id: 's2' } };
  const routes = fakeBridgeHost({
    agents: { get: () => undefined },
    sessionController: { resolveAgent: async () => ({ agent }) },
    agentPresets: { serviceFor: () => modeService([]) },
  });
  const response = await call(routes.get('/fairy-modes/state'), fakeRequest({ url: '/fairy-modes/state?sessionId=s2' }));
  assert.equal(response.status, 200);
  assert.equal(response.value.mode, 'ptc');

  const failed = fakeBridgeHost({
    agents: { get: () => undefined },
    sessionController: { resolveAgent: async () => ({ error: { code: 'session/not-found' } }) },
    agentPresets: { serviceFor: () => modeService([]) },
  });
  const rejected = await call(failed.get('/fairy-modes/state'), fakeRequest({ url: '/fairy-modes/state?sessionId=s3' }));
  assert.equal(rejected.status, 422);
});
