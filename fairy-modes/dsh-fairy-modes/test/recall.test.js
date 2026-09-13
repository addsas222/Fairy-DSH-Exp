import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RECALL_TOOL_NAME, createSessionRecallTool } from '../lib/recall.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const INDEX_DISABLED = Object.assign(new Error('session search is disabled'), {
  code: 'SESSION_QUERY_SEARCH_DISABLED',
});

/**
 * The registry validates a tool's returned value against `output.schema` before
 * rendering, so every value below is checked the same way. Narrowed to the JSON
 * Schema subset this tool declares (object/array/string/number/boolean/integer,
 * `required`, `additionalProperties: false`).
 */
function schemaViolations(schema, value, path = 'value') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`];
    const violations = [];
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) violations.push(...schemaViolations(child, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${path}.${key} is not declared`);
      }
    }
    return violations;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    return value.flatMap((item, index) => schemaViolations(schema.items ?? {}, item, `${path}[${index}]`));
  }
  if (schema.type === 'integer') return Number.isInteger(value) ? [] : [`${path} must be an integer`];
  return typeof value === schema.type ? [] : [`${path} must be a ${schema.type}`];
}

/** Assert one returned value is dispatchable: schema-clean and renderable. */
function assertDispatchable(tool, value) {
  assert.deepEqual(schemaViolations(tool.output.schema, value), []);
  const rendered = tool.output.render({}, value);
  assert.equal(Array.isArray(rendered) && rendered[0]?.type, 'text');
  return rendered[0].text;
}

/** A session-query engine double: only the methods a case composes exist. */
function fakeEngine({ searchSessions, listSessions, readTitleSnapshots } = {}) {
  const calls = [];
  return {
    calls,
    ...(searchSessions === undefined ? {} : { searchSessions(request, exec) { calls.push(['searchSessions', request, exec]); return searchSessions(request, exec); } }),
    ...(listSessions === undefined ? {} : { listSessions(signal) { calls.push(['listSessions', signal]); return listSessions(signal); } }),
    ...(readTitleSnapshots === undefined ? {} : { readTitleSnapshots(ids, signal) { calls.push(['readTitleSnapshots', ids, signal]); return readTitleSnapshots(ids, signal); } }),
  };
}

/** One indexed hit as `searchSessions` returns it. */
function hit(sessionId, seq, snippet, createdAt = 1_700_000_000_000) {
  return {
    header: { id: sessionId, createdAt, isSeeded: false, version: 3 },
    live: false,
    persisted: true,
    bestMatch: { sessionId, seq, type: 'assistant/message', time: createdAt, surface: { kind: 'append' }, snippet },
  };
}

function titles(pairs) {
  return pairs.map(([sessionId, title, updatedAt]) => ({
    sessionId,
    status: 'fulfilled',
    value: { session: { id: sessionId }, title: { title, updatedAt, eventSeq: 1, messageSeqs: [], source: 'provider' } },
  }));
}

test('the package carries no harness dependency', () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-fairy-contracts']);
});

test('the definition is a raw ToolDefinition with plain JSON Schema', () => {
  const tool = createSessionRecallTool(fakeEngine());
  assert.equal(tool.name, RECALL_TOOL_NAME);
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要查找的字面文本（大小写不敏感；按数据处理，不作为检索语法）。' },
      limit: { type: 'number', description: '最多返回多少个会话（1-10，默认 5）。' },
    },
    required: ['query'],
  });
  assert.deepEqual(tool.output.schema, {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        description: '每个会话一条：最强匹配事件及其摘录。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            title: { type: 'string' },
            seq: { type: 'integer' },
            snippet: { type: 'string' },
            updatedAt: { type: 'integer' },
          },
          required: ['sessionId', 'snippet'],
        },
      },
      truncated: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: ['results', 'truncated'],
  });
  assert.equal(tool.timeoutMs, 30_000);
  assert.equal(tool.isConcurrencySafe({ query: 'x' }), true);
});

test('the indexed path projects hits, folds titles, and renders bullets', async () => {
  const engine = fakeEngine({
    async searchSessions(request) {
      assert.deepEqual(request, { query: 'ponytail', limit: 5 });
      return { items: [hit('session-a', 42, '  ponytail 规则集已落地  '), hit('session-b', 7, '另一处提到 ponytail')] };
    },
    async readTitleSnapshots(ids) {
      assert.deepEqual(ids, ['session-a', 'session-b']);
      return titles([['session-a', 'Ponytail 优化', 1_700_000_100_000]]);
    },
  });
  const tool = createSessionRecallTool(engine);
  const value = await tool.execute({ query: 'ponytail' }, { signal: undefined });

  assert.deepEqual(value, {
    results: [
      { sessionId: 'session-a', title: 'Ponytail 优化', seq: 42, snippet: 'ponytail 规则集已落地', updatedAt: 1_700_000_100_000 },
      { sessionId: 'session-b', seq: 7, snippet: '另一处提到 ponytail' },
    ],
    truncated: false,
  });
  assert.equal(
    assertDispatchable(tool, value),
    '• [Ponytail 优化] (session-a) seq 42: ponytail 规则集已落地\n• (session-b) seq 7: 另一处提到 ponytail',
  );
});

test('a continuation cursor and extra hits report truncation', async () => {
  const engine = fakeEngine({
    async searchSessions() {
      return { items: [hit('a', 1, 'x'), hit('b', 2, 'y'), hit('c', 3, 'z')], nextCursor: 'cursor-2' };
    },
  });
  const tool = createSessionRecallTool(engine);
  const value = await tool.execute({ query: 'x', limit: 2 }, {});
  assert.deepEqual(value.results.map(row => row.sessionId), ['a', 'b']);
  assert.equal(value.truncated, true);
  assertDispatchable(tool, value);
});

test('an empty index result explains itself', async () => {
  const engine = fakeEngine({ async searchSessions() { return { items: [] }; } });
  const tool = createSessionRecallTool(engine);
  const value = await tool.execute({ query: 'nothing' }, {});
  assert.deepEqual(value.results, []);
  assert.equal(value.truncated, false);
  assert.match(value.note, /没有匹配的历史记录/);
  assert.match(assertDispatchable(tool, value), /（没有匹配的历史记录）/);
});

test('a disabled index degrades to the title scan and names the fix', async () => {
  const engine = fakeEngine({
    async searchSessions() { throw INDEX_DISABLED; },
    async listSessions() {
      return [
        { header: { id: 's1', createdAt: 20, isSeeded: false, version: 3 }, live: true, persisted: true },
        { header: { id: 's2', createdAt: 10, isSeeded: false, version: 3 }, live: false, persisted: true },
      ];
    },
    async readTitleSnapshots() {
      return titles([['s1', 'Ponytail 优化', 1_700_000_200_000], ['s2', '别的会话', 1_700_000_000_000]]);
    },
  });
  const tool = createSessionRecallTool(engine);
  const value = await tool.execute({ query: 'ponytail' }, {});

  assert.deepEqual(value, {
    results: [{ sessionId: 's1', title: 'Ponytail 优化', snippet: 'Ponytail 优化', updatedAt: 1_700_000_200_000 }],
    truncated: false,
    note: '会话全文索引未打开（session-query-sqlite 的 openAt 为 "never"），本次只按标题匹配。'
      + '把 profiles/web/cordis.patch.yml 里 session-query-sqlite.openAt 设为 first-search 即可恢复全文回忆。',
  });
  assert.match(assertDispatchable(tool, value), /注：会话全文索引未打开/);
  assert.equal(engine.calls.some(call => call[0] === 'listSessions'), true);
});

test('an engine without search methods scans titles and says the backend is absent', async () => {
  const engine = fakeEngine({
    async listSessions() {
      return [{ header: { id: 's1', createdAt: 20, isSeeded: false, version: 3 }, live: false, persisted: true }];
    },
  });
  const value = await createSessionRecallTool(engine).execute({ query: 'fairy', limit: 3 }, {});
  assert.deepEqual(value.results, []);
  assert.match(value.note, /本部署未组合会话检索后端/);
  assert.match(value.note, /标题里也没有匹配的词/);
});

test('an engine with no corpus reader at all still answers', async () => {
  const value = await createSessionRecallTool(fakeEngine()).execute({ query: 'fairy' }, {});
  assert.deepEqual(value, {
    results: [],
    truncated: false,
    note: '本部署未组合会话检索后端，本次只按标题匹配。（本部署也没有可用的会话列表接口。）',
  });
});

test('an unrelated engine failure is not swallowed', async () => {
  const engine = fakeEngine({
    async searchSessions() { throw Object.assign(new Error('persistence down'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }); },
  });
  await assert.rejects(
    createSessionRecallTool(engine).execute({ query: 'x' }, {}),
    /persistence down/,
  );
});

test('a blank query is an ordinary tool failure and limit is bounded', async () => {
  const engine = fakeEngine({
    async searchSessions(request) { return { items: [hit('a', 1, 'x')], limit: request.limit }; },
  });
  const tool = createSessionRecallTool(engine);
  await assert.rejects(tool.execute({ query: '   ' }, {}), /需要一个非空的 query/);
  // Missing limit defaults; oversized limit clamps instead of failing the call.
  await tool.execute({ query: 'x' }, {});
  assert.equal(engine.calls.at(-1)[1].limit, 5);
  await tool.execute({ query: 'x', limit: 99 }, {});
  assert.equal(engine.calls.at(-1)[1].limit, 10);
  await tool.execute({ query: 'x', limit: 0 }, {});
  assert.equal(engine.calls.at(-1)[1].limit, 1);
  await tool.execute({ query: 'x', limit: 2.7 }, {});
  assert.equal(engine.calls.at(-1)[1].limit, 2);
});

test('malformed arguments fail before the engine is touched', async () => {
  const engine = fakeEngine({ async searchSessions() { return { items: [] }; } });
  const tool = createSessionRecallTool(engine);
  // The registry's own schema-walk wording, so a rejected call reads like any
  // built-in typed tool's rejection.
  await assert.rejects(tool.execute({ limit: 3 }, {}), /invalid arguments: missing required property "query"/);
  await assert.rejects(tool.execute({ query: 42 }, {}), /invalid arguments: "query" must be a string/);
  await assert.rejects(tool.execute({ query: 'x', limit: '3' }, {}), /invalid arguments: "limit" must be a number/);
  await assert.rejects(tool.execute('fairy', {}), /invalid arguments: "arguments" must be an object/);
  await assert.rejects(tool.execute({ query: 'x', limit: Number.NaN }, {}), /invalid arguments: "limit" must be a finite JSON number/);
  assert.deepEqual(engine.calls, []);
});

test('a title-only scan reports the newest-first slice and its bound', async () => {
  const records = Array.from({ length: 4 }, (_unused, index) => ({
    header: { id: `s${index}`, createdAt: 100 - index, isSeeded: false, version: 3 },
    live: false,
    persisted: true,
  }));
  const engine = fakeEngine({
    async listSessions() { return records; },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId, index) => ({
        sessionId,
        status: 'fulfilled',
        value: { session: { id: sessionId }, title: { title: `fairy 会话 ${index}`, updatedAt: 500 - index, eventSeq: 1, messageSeqs: [], source: 'provider' } },
      }));
    },
  });
  const tool = createSessionRecallTool(engine);
  const value = await tool.execute({ query: 'fairy 会话', limit: 2 }, {});
  assert.deepEqual(value.results.map(row => row.sessionId), ['s0', 's1']);
  assert.equal(value.truncated, true);
  assertDispatchable(tool, value);
  // A missing title on one session never fails the batch.
  const partial = fakeEngine({
    async listSessions() { return records; },
    async readTitleSnapshots(ids) {
      return [{ sessionId: ids[0], status: 'rejected', error: new Error('gone') }];
    },
  });
  const empty = await createSessionRecallTool(partial).execute({ query: 'fairy' }, {});
  assert.deepEqual(empty.results, []);
});
