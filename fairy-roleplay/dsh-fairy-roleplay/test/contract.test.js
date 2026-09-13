import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoleplayCheckTool, createRoleplayStyleTool } from '../lib/engine.js';
import {
  FAIRY_ROLEPLAY_DEFAULTS,
  createFairyRoleplayHandlers,
  createRoleplaySettingsBoundary,
} from '../lib/index.js';

function fakeRes() {
  const res = { statusCode: 0, headers: {}, writableEnded: false, body: null };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (payload) => { res.writableEnded = true; res.body = JSON.parse(payload); };
  return res;
}

function fakeReq(body) {
  const req = new EventEmitter();
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

const withHome = async (run) => {
  const home = await mkdtemp(join(tmpdir(), 'fairy-roleplay-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
};

test('the settings boundary only accepts known keys and valid levels', async () => {
  const settings = createRoleplaySettingsBoundary();
  const next = await settings.write({ humanizerLevel: 'l9', timingGate: false, bogus: 'x', stylePath: '  C:/tmp/style.json  ' });
  assert.equal(next.humanizerLevel, FAIRY_ROLEPLAY_DEFAULTS.humanizerLevel, 'an unknown level must not be stored');
  assert.equal(next.timingGate, false);
  assert.equal(next.stylePath, 'C:/tmp/style.json', 'strings are trimmed');
  assert.equal('bogus' in next, false);
});

test('the state route reports the config, the level list and the style library location', async () => {
  await withHome(async (home) => {
    const handlers = createFairyRoleplayHandlers({ settings: createRoleplaySettingsBoundary() });
    const res = fakeRes();
    await handlers.state(fakeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.style.count, 0);
    assert.equal(res.body.style.path, join(home, 'fairy-roleplay', 'style.json'));
    assert.ok(res.body.levels.includes('l4'));
  });
});

test('the config route writes through and reports what changed', async () => {
  await withHome(async () => {
    const settings = createRoleplaySettingsBoundary();
    const handlers = createFairyRoleplayHandlers({ settings });
    const res = fakeRes();
    await handlers.config(fakeReq({ humanizerLevel: 'l3', timingGate: false }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.changed.sort(), ['humanizerLevel', 'timingGate']);
    assert.equal(settings.read().humanizerLevel, 'l3');
  });
});

test('the check route runs the same checker the agent tool runs', async () => {
  await withHome(async () => {
    const handlers = createFairyRoleplayHandlers({ settings: createRoleplaySettingsBoundary() });
    const res = fakeRes();
    await handlers.check(fakeReq({ text: '值得注意的是，这不是方案A而是方案B。' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.hits.length >= 2);
    assert.match(res.body.report, /命中/);
  });
});

test('the style route learns entries, deduplicates them, and survives a restart', async () => {
  await withHome(async (home) => {
    const handlers = createFairyRoleplayHandlers({ settings: createRoleplaySettingsBoundary() });
    const first = fakeRes();
    await handlers.style(fakeReq({ entries: [{ situation: '被夸时', style: '这么强' }] }), first);
    assert.equal(first.body.count, 1);
    const second = fakeRes();
    await handlers.style(fakeReq({ entries: [{ situation: '被夸时', style: '这么强' }, { situation: '道别时', style: '溜了溜了' }] }), second);
    assert.equal(second.body.count, 2, 'the repeat must not create a third entry');
    const stored = JSON.parse(await readFile(join(home, 'fairy-roleplay', 'style.json'), 'utf8'));
    assert.equal(stored.entries.length, 2);
    const readBack = fakeRes();
    await handlers.style(fakeReq(undefined), readBack);
    assert.equal(readBack.body.count, 2);
    assert.equal(readBack.body.path, join(home, 'fairy-roleplay', 'style.json'));
  });
});

test('roleplay_check reports hits and rejects an empty text', async () => {
  const tool = createRoleplayCheckTool({ readSettings: async () => ({ ...FAIRY_ROLEPLAY_DEFAULTS, humanizerLevel: 'l1' }) });
  assert.equal(tool.name, 'roleplay_check');
  const result = await tool.execute({ text: '值得注意的是，没问题。' });
  assert.equal(result.passed, false);
  assert.equal(result.level, 'l1');
  assert.ok(result.hits >= 1);
  const override = await tool.execute({ text: '值得注意的是，没问题。', level: 'off' });
  assert.equal(override.passed, true, 'the caller may override the stored level');
  await assert.rejects(() => tool.execute({ text: '   ' }), (error) => error.code === 'INVALID_ARGS');
});

test('roleplay_style lists and learns through the configured file', async () => {
  await withHome(async (home) => {
    const tool = createRoleplayStyleTool({
      readSettings: async () => FAIRY_ROLEPLAY_DEFAULTS,
      stylePath: () => join(home, 'custom', 'style.json'),
    });
    const empty = await tool.execute({ action: 'list' });
    assert.equal(empty.total, 0);
    assert.match(empty.report, /风格库还是空的/);
    const learned = await tool.execute({ action: 'learn', entries: '[{"situation":"被夸时","style":"这么强"}]' });
    assert.equal(learned.added, 1);
    const listed = await tool.execute({ action: 'list' });
    assert.equal(listed.total, 1);
    assert.match(listed.report, /这么强/);
    const ignored = await tool.execute({ action: 'learn', entries: '不是 JSON' });
    assert.equal(ignored.added, 0);
    assert.match(ignored.report, /没有解析到条目/);
    await assert.rejects(() => tool.execute({ action: 'reset' }), (error) => error.code === 'INVALID_ARGS');
  });
});
