import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFairyMemoryHandlers, createMemorySettingsBoundary } from '../lib/index.js';
import { createMemoryRegistry } from '../lib/providers/index.js';
import { createGbrainProvider } from '../lib/providers/gbrain.js';
import { createMem0Provider } from '../lib/providers/mem0.js';
import { createCustomHttpProvider, parseHeaders } from '../lib/providers/custom-http.js';
import { createLocalMarkdownProvider } from '../lib/providers/local-markdown.js';
import { buildMemoryRecallText, createMemoryRecallTool, createMemoryRememberTool } from '../lib/engine.js';
import { MEMORY_CANDIDATES, buildInstallPlan, buildMemorySetupText, findCandidate, renderInstallPlan } from '../lib/candidates.js';

async function withTempDir(prefix, body) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function requestWithJson(value) {
  const request = new EventEmitter();
  request[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(value));
  };
  return request;
}

function responseDouble() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.setHeader = () => {};
  response.on = () => response;
  response.removeListener = () => response;
  response.end = (body) => {
    response.payload = body === undefined ? null : String(body);
    response.writableEnded = true;
  };
  return response;
}

function jsonResponse(value, ok = true, status = 200, headers = {}) {
  return { ok, status, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null }, async json() { return value; }, async text() { return JSON.stringify(value); } };
}

test('the local markdown store round-trips a fact with provenance', async () => {
  await withTempDir('fairy-memory-local-', async (directory) => {
    const provider = createLocalMarkdownProvider({});
    const config = { directory };
    assert.deepEqual(provider.available(), { available: true, reason: null });
    const written = await provider.remember({ text: '用户偏好简短的中文回答。', tags: ['偏好'], source: 'test' }, config);
    assert.match(written.id, /^\d{4}\/\d{2}\/\d{8}T\d+Z-[0-9a-f]{8}\.md$/);
    assert.equal(await provider.count(config), 1);

    const hit = await provider.recall({ query: '中文回答偏好', limit: 5 }, config);
    assert.equal(hit.results.length, 1);
    assert.match(hit.results[0].text, /中文回答/);
    assert.equal(hit.results[0].source, 'test');

    const miss = await provider.recall({ query: 'quantum chromodynamics', limit: 5 }, config);
    assert.deepEqual(miss.results, []);
    assert.match(miss.note, /没有匹配项/);

    // Provenance is on disk, not only in memory.
    const page = await readFile(join(directory, written.id), 'utf8');
    assert.match(page, /^---\ncreated: \d{4}-\d{2}-\d{2}T/);
    assert.match(page, /source: test/);
    assert.match(page, /tags: \[偏好\]/);
  });
});

test('an unconfigured provider degrades to the local store, loudly', async () => {
  const registry = createMemoryRegistry({});
  assert.equal(registry.resolve({ provider: 'mem0-typo', providers: {} }).id, 'local-markdown');
  // The default engine is gbrain, but an endpoint-less gbrain cannot answer:
  // recall must still work, and the answer has to say which engine served it.
  const unconfigured = registry.resolve({ provider: 'gbrain', providers: {} });
  assert.equal(unconfigured.id, 'local-markdown');
  assert.match(unconfigured.fallbackReason, /gbrain 尚未配置服务地址/);
  const configured = registry.resolve({ provider: 'gbrain', providers: { gbrain: { baseUrl: 'http://127.0.0.1:3131/mcp' } } });
  assert.equal(configured.id, 'gbrain');
  assert.equal(configured.fallback, false);
  const entries = await registry.list({ providers: {} });
  assert.deepEqual(entries.map((entry) => entry.id), ['gbrain', 'mem0', 'custom-http', 'local-markdown']);
  assert.equal(entries.find((entry) => entry.id === 'local-markdown').available, true);
});

test('gbrain speaks MCP verbs with a bearer token and reads SSE replies', async () => {
  const seen = [];
  const provider = createGbrainProvider({
    fetchImpl: async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body), headers: options.headers });
      const frame = {
        jsonrpc: '2.0',
        id: seen.length,
        result: {
          content: [{ type: 'text', text: JSON.stringify({
            protocol_version: 1,
            facts: [{ id: 'fact_1', fact_id: 'fact_1', statement: 'Alice 负责 Acme 的工程。', provenance: 'meeting 2026-05-01' }],
            results: [{ slug: 'people/alice', chunk: 'Alice 在 Acme 负责工程。', evidence: 'alias_hit', create_safety: 'exists' }],
          }) }],
        },
      };
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'mcp-session-id' ? 'session-1' : null) },
        async json() { return frame; },
        async text() { return `event: message\ndata: ${JSON.stringify(frame)}\n\n`; },
      };
    },
  });
  const config = { baseUrl: 'https://brain.example/mcp', token: 'gbrain_test', surface: 'verbs' };
  const answer = await provider.recall({ query: 'Alice', limit: 3 }, config, undefined);
  // Facts come first, then the page-snippet arm, and `chunk` is where the
  // search arm keeps its text.
  assert.deepEqual(answer.results, [
    { text: 'Alice 负责 Acme 的工程。', source: 'meeting 2026-05-01', score: null, updatedAt: null, arm: 'fact' },
    { text: 'Alice 在 Acme 负责工程。', source: 'people/alice', score: null, updatedAt: null, arm: 'search', evidence: 'alias_hit', createSafety: 'exists' },
  ]);
  assert.equal(seen[0].url, 'https://brain.example/mcp?surface=verbs');
  assert.equal(seen[0].body.method, 'tools/call');
  assert.deepEqual(seen[0].body.params, { name: 'recall', arguments: { query: 'Alice', limit: 3 } });
  assert.equal(seen[0].headers.authorization, 'Bearer gbrain_test');

  // v1 `remember` takes `fact` plus a REQUIRED provenance; `tags` ride provenance.
  await provider.remember({ text: '记住：周五交付。', tags: ['交付'], source: 'chat' }, config, undefined);
  assert.equal(seen[1].body.params.name, 'remember');
  assert.deepEqual(seen[1].body.params.arguments, { fact: '记住：周五交付。', provenance: 'chat [交付]' });
  assert.equal(seen[1].body.params.arguments.provenance.length <= 500, true);
});

test('gbrain retries once through initialize when the session is unknown', async () => {
  const calls = [];
  const provider = createGbrainProvider({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.method);
      if (body.method === 'tools/call' && calls.filter((method) => method === 'tools/call').length === 1) {
        return { ok: true, status: 200, headers: { get: () => null }, async json() { return {}; }, async text() { return JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Missing session; call initialize first' } }); } };
      }
      return { ok: true, status: 200, headers: { get: () => null }, async json() { return {}; }, async text() { return JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } }); } };
    },
  });
  const answer = await provider.recall({ query: 'x' }, { baseUrl: 'https://brain.example/mcp' }, undefined);
  assert.deepEqual(calls, ['tools/call', 'initialize', 'tools/call']);
  assert.equal(answer.results[0].text, 'ok');
});

test('a rejected gbrain call surfaces the upstream text', async () => {
  const provider = createGbrainProvider({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      async json() { return { error: { message: 'invalid token' } }; },
      async text() { return JSON.stringify({ error: { message: 'invalid token' } }); },
    }),
  });
  await assert.rejects(
    provider.recall({ query: 'x' }, { baseUrl: 'https://brain.example/mcp' }, undefined),
    (error) => error.code === 'provider-failed' && /invalid token/.test(error.message),
  );
});

test('mem0 posts to its memories API and tolerates envelope variants', async () => {
  const seen = [];
  const provider = createMem0Provider({
    fetchImpl: async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return jsonResponse({ results: [{ id: 'm1', memory: '用户是后端工程师。', score: 0.9 }] });
    },
  });
  const config = { baseUrl: 'https://api.mem0.ai', apiKey: 'k', userId: 'fairy' };
  const answer = await provider.recall({ query: '职业', limit: 4 }, config, undefined);
  assert.equal(seen[0].url, 'https://api.mem0.ai/v1/memories/search/');
  assert.equal(seen[0].headers.authorization, 'Token k');
  assert.deepEqual(seen[0].body, { query: '职业', user_id: 'fairy', limit: 4 });
  assert.deepEqual(answer.results, [{ text: '用户是后端工程师。', source: 'm1', score: 0.9, updatedAt: null }]);
  await provider.remember({ text: '记住这个。' }, config, undefined);
  assert.equal(seen[1].url, 'https://api.mem0.ai/v1/memories/');
  assert.equal(seen[1].body.user_id, 'fairy');
});

test('the custom HTTP provider validates headers and follows dot paths', async () => {
  assert.throws(() => parseHeaders('{"X-A":"a\\r\\nX-B: b"}'), /换行/);
  assert.deepEqual(parseHeaders('{"X-A":"a"}'), { 'X-A': 'a' });
  const provider = createCustomHttpProvider({
    fetchImpl: async () => jsonResponse({ data: { items: [{ content: '自定义引擎返回的记忆', source: 'srv' }] } }),
  });
  const config = { url: 'https://mem.example/api', headersJson: '{"X-A":"1"}', queryPath: 'data.items', textPath: 'content' };
  assert.deepEqual(provider.available(config), { available: true, reason: null });
  const answer = await provider.recall({ query: 'x', limit: 3 }, config, undefined);
  assert.equal(answer.results.length, 1);
  assert.equal(answer.results[0].text, '自定义引擎返回的记忆');
});

test('gbrain reports itself unconfigured instead of inventing an endpoint', async () => {
  const provider = createGbrainProvider({ fetchImpl: async () => { throw new Error('must not be called'); } });
  const answer = await provider.available({});
  assert.equal(answer.available, false);
  assert.match(answer.reason, /Bun ≥1\.3\.11|npm 上的 gbrain 是无关包/);
  // A configured endpoint is probed, and a dead one says so.
  const dead = createGbrainProvider({ fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => null }, async json() { return {}; }, async text() { return 'nope'; } }) });
  const probed = await dead.available({ baseUrl: 'http://127.0.0.1:3131/mcp' });
  assert.equal(probed.available, false);
  assert.match(probed.reason, /gbrain serve --http/);
});

test('a tool-level error becomes a provider failure with the protocol suggestion', async () => {
  const provider = createGbrainProvider({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() { return {}; },
      async text() {
        return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'provenance_required', message: 'provenance is required', suggestion: 'pass provenance=<source>' }) }] } });
      },
    }),
  });
  await assert.rejects(
    provider.remember({ text: 'x' }, { baseUrl: 'http://127.0.0.1:3131/mcp' }, undefined),
    (error) => error.code === 'provider-failed' && /provenance_required/.test(error.message) && /pass provenance/.test(error.message),
  );
});

test('the auto-recall switch renders both prompt states', () => {
  assert.match(buildMemoryRecallText({ autoRecall: true }), /自动回忆已开启：回答前先用 `memory_recall`/);
  assert.match(buildMemoryRecallText({ autoRecall: false }), /自动回忆未开启/);
  assert.match(buildMemoryRecallText(undefined), /自动回忆未开启/, '缺配置时按默认关闭处理');
});

test('the vetted candidate list is complete, unique, and installable as written', () => {
  const ids = MEMORY_CANDIDATES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, '候选 id 不能重复');
  for (const entry of MEMORY_CANDIDATES) {
    for (const field of ['name', 'kind', 'summary', 'repo', 'listing', 'stars', 'license', 'language', 'lastPush', 'install', 'requires', 'verify', 'wire']) {
      assert.ok(typeof entry[field] === 'string' && entry[field].length > 0, `${entry.id}.${field} 必填`);
    }
    assert.match(entry.install, /^dsh plugin --profile web add /, `${entry.id} 的安装命令必须是可直接执行的一条`);
    assert.match(entry.repo, /^https:\/\/github\.com\//);
  }
});

test('the install plan states the steps and guards the shared runtime', () => {
  const plan = buildInstallPlan(findCandidate('mneme'));
  assert.equal(plan.id, 'mneme');
  const text = renderInstallPlan(plan);
  assert.match(text, /@modusensus\/dsh-mneme/);
  assert.match(text, /fairy-memory\/install/, '收尾步骤要教它清掉请求');
  assert.match(text, /不要自行重启实例/, '重启会掐断它自己的会话，必须交给用户');
  assert.equal(buildInstallPlan(findCandidate('nothing-here')), null);
});

test('the setup section only directs the agent when a request is pending', () => {
  assert.match(buildMemorySetupText({ installRequest: '' }), /无待办/);
  const text = buildMemorySetupText({ installRequest: 'hindsight' });
  assert.match(text, /Hindsight/);
  assert.match(text, /@vectorize-io\/hindsight-coding-agents/);
  assert.match(text, /用户的明确授权/);
  assert.match(buildMemorySetupText({ installRequest: 'ghost-candidate' }), /不在已审核清单/);
});

test('the host routes report state, mask secrets, and map failures', async () => {
  await withTempDir('fairy-memory-routes-', async (directory) => {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = directory;
    try {
      const settings = createMemorySettingsBoundary();
      await settings.write({ provider: 'local-markdown', providers: { localMarkdown: { directory: join(directory, 'pages') }, gbrain: { token: 'secret-token' } } });
      const handlers = createFairyMemoryHandlers({ settings });

      const read = responseDouble();
      await handlers.config({ method: 'GET' }, read);
      const masked = JSON.parse(read.payload);
      assert.equal(masked.providers.gbrain.token, '***');
      assert.equal(masked.provider, 'local-markdown');

      // `***` must not overwrite the stored secret; other fields still land.
      const saved = responseDouble();
      await handlers.config(requestWithJson({ provider: 'local-markdown', autoRecall: true, providers: { gbrain: { token: '***', surface: 'full' } } }), saved);
      assert.equal(saved.statusCode, 200);
      assert.equal(settings.read().providers.gbrain.token, 'secret-token');
      assert.equal(settings.read().providers.gbrain.surface, 'full');
      assert.equal(settings.read().autoRecall, true);

      // The CLI mirror is what the agent half reads（自动回忆开关也必须随镜像过去，
      // 否则设置卡的这一格在 agent 面永远无效——它曾是本仓的真机缺陷）。
      const mirror = JSON.parse(await readFile(join(directory, 'fairy-memory', 'config.json'), 'utf8'));
      assert.equal(mirror.providers.gbrain.token, 'secret-token');
      assert.equal(mirror.autoRecall, true);

      const remembered = responseDouble();
      await handlers.remember(requestWithJson({ text: '本项目的发布分支是 ponytail。', tags: ['发布'] }), remembered);
      assert.equal(remembered.statusCode, 200);
      assert.equal(JSON.parse(remembered.payload).ok, true);

      const recalled = responseDouble();
      await handlers.recall(requestWithJson({ query: '发布分支', limit: 3 }), recalled);
      const hit = JSON.parse(recalled.payload);
      assert.equal(hit.provider, 'local-markdown');
      assert.match(hit.results[0].text, /ponytail/);

      const state = responseDouble();
      await handlers.state({ method: 'GET' }, state);
      const view = JSON.parse(state.payload);
      assert.equal(view.provider, 'local-markdown');
      assert.equal(view.count, 1);
      assert.equal(view.providers.length, 4);

      const empty = responseDouble();
      await handlers.remember(requestWithJson({ text: '   ' }), empty);
      assert.equal(empty.statusCode, 400);
      assert.equal(JSON.parse(empty.payload).error.code, 'empty-text');

      // The per-fact cap fires first for an oversized text field...
      const tooLarge = responseDouble();
      await handlers.remember(requestWithJson({ text: 'x'.repeat(21_000) }), tooLarge);
      assert.equal(tooLarge.statusCode, 413);
      assert.equal(JSON.parse(tooLarge.payload).error.code, 'text-too-large');

      // ...and the body cap for a request that never becomes a fact at all.
      const hugeBody = responseDouble();
      await handlers.remember(requestWithJson({ text: 'ok', padding: 'x'.repeat(70 * 1024) }), hugeBody);
      assert.equal(hugeBody.statusCode, 413);
      assert.equal(JSON.parse(hugeBody.payload).error.code, 'payload-too-large');
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});

test('the candidates route serves the catalog and the install route round-trips the request', async () => {
  await withTempDir('fairy-memory-candidates-', async (directory) => {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = directory;
    try {
      const settings = createMemorySettingsBoundary();
      const handlers = createFairyMemoryHandlers({ settings });

      const listing = responseDouble();
      await handlers.candidates({ method: 'GET' }, listing);
      assert.equal(listing.statusCode, 200);
      assert.equal(JSON.parse(listing.payload).candidates.length, MEMORY_CANDIDATES.length);
      assert.equal(JSON.parse(listing.payload).installRequest, '');

      const set = responseDouble();
      await handlers.install(requestWithJson({ id: 'engramory' }), set);
      assert.equal(set.statusCode, 200);
      assert.equal(JSON.parse(set.payload).installRequest, 'engramory');
      const mirror = JSON.parse(await readFile(join(directory, 'fairy-memory', 'config.json'), 'utf8'));
      assert.equal(mirror.installRequest, 'engramory', '请求必须随镜像到达 agent 面');

      // 未知 id 是 400，且不得覆盖已有请求。
      const unknown = responseDouble();
      await handlers.install(requestWithJson({ id: 'not-a-candidate' }), unknown);
      assert.equal(unknown.statusCode, 400);
      assert.equal(JSON.parse(unknown.payload).error.code, 'unknown-candidate');
      assert.equal(settings.read().installRequest, 'engramory');

      const cleared = responseDouble();
      await handlers.install(requestWithJson({ id: '' }), cleared);
      assert.equal(cleared.statusCode, 200);
      assert.equal(settings.read().installRequest, '');
      const mirrorAfter = JSON.parse(await readFile(join(directory, 'fairy-memory', 'config.json'), 'utf8'));
      assert.equal(mirrorAfter.installRequest, '');
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});

test('a failing provider becomes a 502 with the upstream text attached', async () => {
  const settings = createMemorySettingsBoundary();
  await settings.write({ provider: 'custom-http', providers: { customHttp: { url: 'https://mem.example/api', queryPath: 'results', textPath: 'text' } } });
  const handlers = createFairyMemoryHandlers({
    settings,
    registry: createMemoryRegistry({ fetchImpl: async () => jsonResponse({ error: 'quota exceeded' }, false, 429) }),
  });
  const response = responseDouble();
  await handlers.recall(requestWithJson({ query: 'x' }), response);
  assert.equal(response.statusCode, 502);
  const body = JSON.parse(response.payload);
  assert.equal(body.error.code, 'provider-failed');
  assert.match(body.error.message, /quota exceeded/);
});

test('EvoMap join registers through a fake hub and keeps the secret local', async () => {
  await withTempDir('fairy-evomap-', async (directory) => {
    const previous = process.env.EVOMAP_HOME;
    process.env.EVOMAP_HOME = directory;
    try {
      const { joinEvoMap, evoMapStatus, recoverIdentity } = await import('../lib/evomap.js');
      const calls = [];
      const hub = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              payload: {
                your_node_id: 'node_fake123',
                node_secret: 'f'.repeat(64),
                claim_url: 'https://evomap.ai/claim/fake-token',
                heartbeat_interval_ms: 60_000,
              },
            };
          },
        };
      };

      // No credentials yet: register, store, and hand back the claim URL.
      const registered = await joinEvoMap({ name: 'Probe Agent', model: 'probe-1', fetchImpl: hub });
      assert.equal(registered.status, 'registered');
      assert.equal(registered.nodeId, 'node_fake123');
      assert.equal(registered.claimUrl, 'https://evomap.ai/claim/fake-token');
      // The secret never appears in what a caller would print.
      assert.equal(JSON.stringify(registered).includes('f'.repeat(64)), false);
      assert.equal(calls[0].url, 'https://evomap.ai/a2a/hello');
      assert.equal(calls[0].headers.authorization, undefined, 'a first hello carries no credential');
      assert.equal(calls[0].body.payload.name, 'Probe Agent');
      assert.equal(calls[0].body.payload.env_fingerprint.platform, process.platform);

      // It lands under EVOMAP_HOME only - never in the user's home.
      const stored = await recoverIdentity();
      assert.deepEqual({ found: stored.found, id: stored.id, source: stored.source }, { found: true, id: 'node_fake123', source: 'file' });

      // A second join probes the stored identity instead of registering again.
      const probedCalls = [];
      const probed = await joinEvoMap({
        fetchImpl: async (url, options) => {
          probedCalls.push({ url, headers: options.headers });
          return { ok: true, status: 200, async json() { return { payload: { claimed: false, claim_url: 'https://evomap.ai/claim/fake-token' } }; } };
        },
      });
      assert.equal(probed.status, 'claim-required');
      assert.equal(probedCalls.length, 1, 'a recovered identity is probed, not re-registered');
      assert.equal(probedCalls[0].headers.authorization, `Bearer ${'f'.repeat(64)}`);

      // An invalid secret is reported as-is: this command never rotates it.
      const invalid = await joinEvoMap({
        fetchImpl: async () => ({ ok: false, status: 403, async json() { return { payload: { error: 'node_secret_invalid' } }; } }),
      });
      assert.equal(invalid.status, 'invalid-secret');
      assert.match(invalid.note, /不会自动轮换/);

      const status = await evoMapStatus();
      assert.equal(status.configured, true);
      assert.equal(status.nodeId, 'node_fake123');
      assert.equal(JSON.stringify(status).includes('f'.repeat(64)), false);
    } finally {
      if (previous === undefined) delete process.env.EVOMAP_HOME;
      else process.env.EVOMAP_HOME = previous;
    }
  });
});

test('the agent tools write and read through the same configuration', async () => {
  await withTempDir('fairy-memory-tools-', async (directory) => {
    const settings = { provider: 'local-markdown', providers: { localMarkdown: { directory } } };
    const readSettings = async () => settings;
    const remember = createMemoryRememberTool({ readSettings });
    const recall = createMemoryRecallTool({ readSettings });

    assert.equal(remember.name, 'memory_remember');
    assert.equal(recall.name, 'memory_recall');
    assert.deepEqual(remember.parameters.required, ['text']);
    assert.deepEqual(recall.parameters.required, ['query']);

    const written = await remember.execute({ text: '用户的名字是 Fairy。', source: 'test' });
    assert.equal(written.ok, true);
    assert.equal(written.provider, 'local-markdown');

    const found = await recall.execute({ query: '用户的名字' });
    assert.equal(found.results.length, 1);
    assert.match(found.results[0].text, /Fairy/);
    assert.match(recall.output.render({}, found)[0].text, /长期记忆（local-markdown）/);

    await assert.rejects(recall.execute({ query: '  ' }), (error) => error.code === 'INVALID_ARGS');
    await assert.rejects(remember.execute({ text: '' }), (error) => error.code === 'INVALID_ARGS');
  });
});
