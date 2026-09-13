import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  FAIRY_SEARCH_CUSTOM_MODEL,
  FAIRY_SEARCH_PROBE_QUERY,
  FAIRY_SEARCH_PROVIDER_ID,
  FairySearchSettings,
  apply,
  availabilityKeyFor,
  createCustomHttpProvider,
  createFairySearchHandlers,
  createFairySearchHub,
  createRoutedSearchProvider,
  extractAnswerSources,
  providerAvailability,
  resolveFairySearchSettings,
} from '../lib/index.js';

function requestWithJson(value) {
  const request = new EventEmitter();
  request[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(value));
  };
  return request;
}

function requestWithBody(text) {
  const request = new EventEmitter();
  request[Symbol.asyncIterator] = async function* () {
    if (text) yield Buffer.from(text);
  };
  return request;
}

function responseDouble() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.headers = {};
  response.body = undefined;
  response.setHeader = (name, value) => { response.headers[name] = value; };
  response.end = (chunk) => {
    response.writableEnded = true;
    response.body = chunk === undefined ? undefined : JSON.parse(chunk);
  };
  return response;
}

async function dispatch(handler, request) {
  const response = responseDouble();
  await handler(request, response);
  return response;
}

function fetchResponse(value, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return value; } };
}

function abortError() {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** The official engines build their own `fetch` calls, so delegation is observed here. */
async function withGlobalFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      signal: init.signal,
    };
    calls.push(call);
    return handler(call);
  };
  impl.calls = calls;
  return impl;
}

/** A transport that only settles when its request is aborted. */
function hangingFetch(_url, init = {}) {
  return new Promise((_resolve, reject) => {
    if (init.signal?.aborted === true) {
      reject(abortError());
      return;
    }
    init.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

const EXA_SETTINGS = resolveFairySearchSettings({ provider: 'exa', exa: { apiKey: 'exa-key' }, custom: { baseURL: 'https://gw.example/v1' } });

test('the settings section resolves every engine default and falls back on an unknown provider', () => {
  assert.deepEqual(FairySearchSettings({}), resolveFairySearchSettings({}));
  assert.deepEqual(resolveFairySearchSettings(undefined), {
    version: 1,
    provider: 'deepseek-official',
    deepseek: { apiKey: '' },
    exa: { apiKey: '' },
    perplexity: { apiKey: '' },
    custom: { baseURL: '', apiKey: '' },
  });
  const resolved = resolveFairySearchSettings({ provider: 'not-an-engine', exa: { apiKey: ' e ' }, custom: { baseURL: 'https://gw.example/v1' } });
  assert.equal(resolved.provider, 'deepseek-official');
  assert.equal(resolved.exa.apiKey, 'e');
  assert.equal(resolved.custom.baseURL, 'https://gw.example/v1');
});

test('availability follows each engine own key or address rule', () => {
  const empty = providerAvailability(resolveFairySearchSettings({}), {});
  assert.deepEqual(
    [empty.deepseek.available, empty.exa.available, empty.perplexity.available, empty.custom.available],
    [false, false, false, false],
  );
  const fromEnv = providerAvailability(resolveFairySearchSettings({}), { DEEPSEEK_API_KEY: 'env-key' });
  assert.equal(fromEnv.deepseek.available, true);
  const fromSettings = providerAvailability(resolveFairySearchSettings({ deepseek: { apiKey: 'settings-key' } }), { DEEPSEEK_API_KEY: 'env-key' });
  assert.equal(fromSettings.deepseek.available, true);
  // A keyless local gateway is still a usable custom engine; a malformed address is not.
  const custom = providerAvailability(resolveFairySearchSettings({ custom: { baseURL: 'https://gw.example/v1' } }), {});
  assert.equal(custom.custom.available, true);
  const malformed = providerAvailability(resolveFairySearchSettings({ custom: { baseURL: 'gw.example' } }), {});
  assert.equal(malformed.custom.available, false);
  assert.match(malformed.custom.reason, /自定义服务地址/);
  assert.equal(availabilityKeyFor('deepseek-official'), 'deepseek');
  assert.equal(availabilityKeyFor('perplexity'), 'perplexity');
});

test('the hub reports availability for the selected engine only', () => {
  const hub = createFairySearchHub({ getSettings: () => ({ provider: 'exa' }), env: { DEEPSEEK_API_KEY: 'env-key' } });
  assert.equal(hub.id, FAIRY_SEARCH_PROVIDER_ID);
  assert.equal(hub.available(), false);
  const configured = createFairySearchHub({ getSettings: () => ({ provider: 'exa', exa: { apiKey: 'exa-key' } }), env: {} });
  assert.equal(configured.available(), true);
});

test('the routing table sends each engine to its own transport', async () => {
  const responses = {
    exa: fetchResponse({ results: [{ url: 'https://a.example/1', title: 'A', highlights: ['alpha snippet'], publishedDate: '2026-01-02' }] }),
    perplexity: fetchResponse({ choices: [{ message: { content: 'generated answer' } }], search_results: [{ url: 'https://b.example/1', title: 'B', snippet: 'beta snippet', date: '2026-01-03' }] }),
    deepseek: fetchResponse({
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://c.example/1', title: 'C', page_age: '2026-01-04' }] },
        { type: 'text', text: 'context', citations: [{ url: 'https://c.example/1', cited_text: 'gamma snippet' }] },
      ],
    }),
  };

  const exa = recordingFetch(() => responses.exa);
  await withGlobalFetch(exa, async () => {
    const result = await createFairySearchHub({ getSettings: () => EXA_SETTINGS, env: {} }).search({ query: 'routing probe' });
    assert.equal(exa.calls[0].url, 'https://api.exa.ai/search');
    assert.equal(exa.calls[0].headers.authorization, 'Bearer exa-key');
    assert.deepEqual(exa.calls[0].body, { query: 'routing probe', type: 'auto', contents: { highlights: { highlightsPerUrl: 1 } } });
    assert.deepEqual(result.sources, [{ url: 'https://a.example/1', title: 'A', snippet: 'alpha snippet', publishedAt: '2026-01-02' }]);
    assert.equal(result.truncated, false);
  });

  const perplexitySettings = resolveFairySearchSettings({ provider: 'perplexity', perplexity: { apiKey: 'pplx-key' } });
  const perplexity = recordingFetch(() => responses.perplexity);
  await withGlobalFetch(perplexity, async () => {
    const result = await createFairySearchHub({ getSettings: () => perplexitySettings, env: {} }).search({ query: 'routing probe' });
    assert.equal(perplexity.calls[0].url, 'https://api.perplexity.ai/chat/completions');
    assert.equal(perplexity.calls[0].body.model, 'sonar');
    assert.deepEqual(perplexity.calls[0].body.messages, [{ role: 'user', content: 'routing probe' }]);
    assert.equal(result.content, 'generated answer');
    assert.deepEqual(result.sources, [{ url: 'https://b.example/1', title: 'B', snippet: 'beta snippet', publishedAt: '2026-01-03' }]);
  });

  const deepseek = recordingFetch(() => responses.deepseek);
  await withGlobalFetch(deepseek, async () => {
    const hub = createFairySearchHub({ getSettings: () => ({ provider: 'deepseek-official', deepseek: { apiKey: 'ds-key' } }), env: {} });
    const result = await hub.search({ query: 'routing probe' });
    assert.equal(deepseek.calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(deepseek.calls[0].headers['x-api-key'], 'ds-key');
    assert.equal(deepseek.calls[0].body.model, 'deepseek-v4-flash');
    assert.deepEqual(deepseek.calls[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    assert.deepEqual(result.sources, [{ url: 'https://c.example/1', title: 'C', snippet: 'gamma snippet', publishedAt: '2026-01-04' }]);
  });
});

test('the custom engine sends an OpenAI chat body and derives sources from the answer', async () => {
  const fetchImpl = recordingFetch(() => fetchResponse({
    choices: [{ message: { content: '结论见 [文档](https://docs.example/a)。另见 https://news.example/b 与 [重复](https://docs.example/a)' } }],
  }));
  const result = await createFairySearchHub({
    getSettings: () => ({ provider: 'custom', custom: { baseURL: 'https://gw.example/v1/', apiKey: 'gw-key' } }),
    env: {},
    fetchImpl,
  }).search({ query: '自定义查询' });

  assert.equal(createRoutedSearchProvider(resolveFairySearchSettings({ provider: 'custom' }), { fetchImpl }).id, 'custom');
  assert.equal(fetchImpl.calls[0].url, 'https://gw.example/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer gw-key');
  assert.deepEqual(Object.keys(fetchImpl.calls[0].body), ['model', 'stream', 'temperature', 'messages']);
  assert.equal(fetchImpl.calls[0].body.model, FAIRY_SEARCH_CUSTOM_MODEL);
  assert.equal(fetchImpl.calls[0].body.messages[1].content, '自定义查询');
  assert.match(fetchImpl.calls[0].body.messages[0].content, /web search backend/);
  assert.deepEqual(result.sources, [
    { url: 'https://docs.example/a', title: '文档' },
    { url: 'https://news.example/b' },
  ]);
  assert.equal(result.content.includes('结论'), true);
  assert.equal(result.truncated, false);
});

test('the custom engine omits authorization for a keyless gateway and honors maxResults', async () => {
  const fetchImpl = recordingFetch(() => fetchResponse({
    choices: [{ message: { content: '[一](https://one.example) [二](https://two.example) [三](https://three.example)' } }],
  }));
  const engine = createCustomHttpProvider({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: '', fetchImpl });
  assert.equal(engine.available(), true);
  const result = await engine.search({ query: 'local', maxResults: 2 });
  assert.equal('authorization' in fetchImpl.calls[0].headers, false);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(extractAnswerSources(''), []);
});

test('the state route reports availability booleans and never key material', async () => {
  const { state } = createFairySearchHandlers({
    getSettings: () => ({
      provider: 'perplexity',
      deepseek: { apiKey: 'ds-secret-value' },
      exa: { apiKey: 'exa-secret-value' },
      perplexity: { apiKey: 'pplx-secret-value' },
      custom: { baseURL: 'https://gw.example/v1', apiKey: 'gw-secret-value' },
    }),
    env: {},
  });
  const response = await dispatch(state, new EventEmitter());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    provider: 'perplexity',
    configured: { deepseek: true, exa: true, perplexity: true, custom: true },
  });
  const serialized = JSON.stringify(response.body);
  for (const secret of ['ds-secret-value', 'exa-secret-value', 'pplx-secret-value', 'gw-secret-value']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('the test route probes the selected engine through the hub and reports latency plus sources', async () => {
  const fetchImpl = recordingFetch(() => fetchResponse({
    choices: [{ message: { content: '[结果](https://result.example/page)' } }],
  }));
  const { test: probe } = createFairySearchHandlers({
    getSettings: () => ({ provider: 'custom', custom: { baseURL: 'https://gw.example/v1' } }),
    env: {},
    fetchImpl,
    now: () => 1_000,
  });
  const response = await dispatch(probe, requestWithJson({ provider: 'custom' }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.latencyMs, 0);
  assert.deepEqual(response.body.sources, [{ title: '结果', url: 'https://result.example/page' }]);
  assert.equal(fetchImpl.calls[0].body.messages[1].content, FAIRY_SEARCH_PROBE_QUERY);
});

test('the test route maps the probe timeout on the delegated engine', async () => {
  const { test: probe } = createFairySearchHandlers({
    getSettings: () => ({ provider: 'deepseek-official', deepseek: { apiKey: 'ds-key' } }),
    env: {},
    timeoutMs: 20,
  });
  const response = await withGlobalFetch(hangingFetch, () => dispatch(probe, requestWithJson({ provider: 'deepseek-official' })));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, '搜索请求超时（15 秒）。');
});

test('the test route refuses an unconfigured engine without any request', async () => {
  const fetchImpl = recordingFetch(() => fetchResponse({}));
  const { test: probe } = createFairySearchHandlers({
    getSettings: () => ({ provider: 'exa' }),
    env: {},
    fetchImpl,
  });
  const response = await dispatch(probe, requestWithJson({ provider: 'exa' }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: false, error: '未填写 Exa API Key。' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('the test route rejects an unknown engine, an invalid body, and redacts failures', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (...args) => { logged.push(args.map((value) => String(value)).join(' ')); });
  const handlers = createFairySearchHandlers({ getSettings: () => ({ provider: 'custom', custom: { baseURL: 'https://gw.example/v1' } }), env: {} });
  const unknown = await dispatch(handlers.test, requestWithJson({ provider: 'bing' }));
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.body, { ok: false, error: '未知的搜索提供方。' });

  const invalid = await dispatch(handlers.test, requestWithBody('{oops'));
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { ok: false, error: '请求格式无效。' });

  const failing = createFairySearchHandlers({
    getSettings: () => ({ provider: 'custom', custom: { baseURL: 'https://gw.example/v1', apiKey: 'gw-secret-value' } }),
    env: {},
    fetchImpl: async () => { throw new Error('gateway rejected key gw-secret-value'); },
  });
  const leaked = await dispatch(failing.test, requestWithJson({}));
  assert.equal(leaked.statusCode, 200);
  assert.equal(leaked.body.ok, false);
  assert.equal(leaked.body.error.includes('gw-secret-value'), false);
  assert.match(leaked.body.error, /\[redacted\]/);
  // The diagnostics record may not carry the credential either.
  assert.equal(logged.some((line) => line.includes('gw-secret-value')), false);
  assert.equal(logged.some((line) => line.includes('DSH_FAIRY_LOG')), true, 'failures must still be logged');
});

test('the test route takes its engine from settings for a body-less POST', async () => {
  const fetchImpl = recordingFetch(() => fetchResponse({ choices: [{ message: { content: 'ok' } }] }));
  const { test: probe } = createFairySearchHandlers({
    getSettings: () => ({ provider: 'custom', custom: { baseURL: 'https://gw.example/v1' } }),
    env: {},
    fetchImpl,
  });
  const response = await dispatch(probe, requestWithBody(''));
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.sources, []);
  assert.equal(fetchImpl.calls.length, 1);
});

test('apply wires the settings namespace, the hub provider, and both control routes', async () => {
  const registered = { namespaces: [], providers: [], routes: [], cleanups: [] };
  const section = { provider: 'custom', custom: { baseURL: 'https://gw.example/v1' } };
  const scope = { get: () => section };
  const services = {
    settings: {
      register: (ns, schema) => {
        registered.namespaces.push({ ns, schema });
        return scope;
      },
    },
    web: {
      registerSearchProvider: (provider) => {
        registered.providers.push(provider);
        return () => { registered.providerDisposed = true; };
      },
    },
    webServer: {
      register: (route) => {
        registered.routes.push(route);
        return () => { registered.routes.pop(); };
      },
    },
  };
  const ctx = {
    inject(deps, callback) {
      for (const dep of deps) {
        if (dep in services) {
          callback({ [dep]: services[dep], effect: (effect) => { registered.cleanups.push(effect()); } });
        }
      }
    },
  };
  // The hub captures its transport when the plugin is constructed, so the stub is
  // installed before apply() runs; the registered provider reads the live settings
  // section through the injected scope.
  const fetchImpl = recordingFetch(() => fetchResponse({ choices: [{ message: { content: '[来源](https://live.example/1)' } }] }));
  const result = await withGlobalFetch(fetchImpl, async () => {
    assert.doesNotThrow(() => apply(ctx));
    return registered.providers[0].search({ query: 'live' });
  });
  assert.equal(fetchImpl.calls[0].url, 'https://gw.example/v1/chat/completions');
  assert.deepEqual(result.sources, [{ url: 'https://live.example/1', title: '来源' }]);

  assert.equal(String(registered.namespaces[0].ns), 'fairy-search');
  assert.equal(typeof registered.namespaces[0].schema, 'function', 'the namespace registers its schema');
  assert.equal(registered.providers.length, 1);
  assert.equal(registered.providers[0].id, FAIRY_SEARCH_PROVIDER_ID);
  assert.deepEqual(registered.routes.map((route) => [route.kind, route.path]), [
    ['exact', '/fairy-search/test'],
    ['exact', '/fairy-search/state'],
  ]);
  assert.equal(registered.routes.every((route) => typeof route.handler === 'function'), true);

  const state = await dispatch(registered.routes.find((route) => route.path === '/fairy-search/state').handler, new EventEmitter());
  assert.equal(state.body.provider, 'custom');
  assert.equal(state.body.configured.custom, true);

  // Disposing the plugin's effects releases the registrations.
  for (const cleanup of registered.cleanups) if (typeof cleanup === 'function') cleanup();
  assert.equal(registered.providerDisposed, true);
});

test('handler disposal aborts in-flight probes', async () => {
  const handlers = createFairySearchHandlers({
    getSettings: () => ({ provider: 'deepseek-official', deepseek: { apiKey: 'ds-key' } }),
    env: {},
    timeoutMs: 60_000,
  });
  await withGlobalFetch(hangingFetch, async () => {
    const pending = dispatch(handlers.test, requestWithJson({}));
    handlers.dispose();
    const response = await pending;
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, '请求已取消。');
  });
});
