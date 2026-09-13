import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

/* A CRLF checkout would otherwise defeat every LF-terminated boundary and
 * `[\s\S]*?\n}` extraction below - the assertions are about source content,
 * not about the line ending the platform happened to check out. */
const normalize = (value) => value.replace(/\r\n/g, '\n');
const server = normalize(await readFile(new URL('../lib/index.js', import.meta.url), 'utf8'));
const client = normalize(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const canonicalClientDiagnostics = normalize(await readFile(new URL('../../../fairy-contracts/client-diagnostics.cjs', import.meta.url), 'utf8'));

function embeddedClientDiagnostics(value) {
  const begin = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_BEGIN\n';
  const end = '// DSH_FAIRY_CLIENT_DIAGNOSTICS_END';
  const start = value.indexOf(begin);
  const finish = value.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, 'embedded client diagnostics boundaries should exist');
  return value.slice(start + begin.length, finish);
}

test('embeds the canonical client diagnostics byte for byte', () => {
  assert.equal(embeddedClientDiagnostics(client), canonicalClientDiagnostics);
});

test('is a profile-linked client module with a server-only credential boundary', () => {
  assert.equal(manifest.name, 'dsh-balance-meter');
  assert.match(server, /join\(DSH_HOME, '\.credentials\.yaml'\)/);
  assert.doesNotMatch(client, /credentials|DEEPSEEK_API_KEY|Authorization/);
  assert.match(client, /sidebar\.footer\.action/);
  const parser = server.match(/function parseApiKey\(content\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(parser, 'server-only API key parser should be available');
  const sandbox = {};
  vm.runInNewContext(`${parser}; globalThis.parseApiKey = parseApiKey;`, sandbox);
  assert.equal(sandbox.parseApiKey("DEEPSEEK_API_KEY: 'sk-fake-single'"), 'sk-fake-single');
  assert.equal(sandbox.parseApiKey('DEEPSEEK_API_KEY: "sk-fake-double"'), 'sk-fake-double');
  assert.equal(sandbox.parseApiKey('DEEPSEEK_API_KEY: sk-fake-plain'), 'sk-fake-plain');
  assert.equal(sandbox.parseApiKey('OTHER_KEY: sk-fake-missing'), undefined);
});

test('owns request, polling, observer, and persistence cleanup', () => {
  assert.match(server, /activeBalanceController\?\.abort\('disposed'\)/);
  assert.match(server, /const request = \(async \(\) =>/);
  assert.match(server, /if \(balanceRequest === request\) balanceRequest = null/);
  assert.match(server, /function tokenCount\(value\)/);
  assert.match(server, /todayInput \+= tokenCount\(usage\.inputTokens\)/);
  assert.match(server, /const appliedContexts = new WeakSet\(\)/);
  assert.match(server, /if \(appliedContexts\.has\(ctx\)\) return;/);
  assert.match(server, /disposeBalanceRequests\(\);\s*appliedContexts\.delete\(ctx\);/s);
  assert.match(server, /writeFileSync\(temporary, value, \{ encoding: 'utf8', mode: 0o600 \}\)/);
  assert.match(server, /renameSync\(temporary, DAILY_FILE\)/);
  assert.match(server, /function reportDailyPersistenceError\(operation, error\)/);
  assert.match(server, /error\?\.code !== 'ENOENT'/);
  assert.doesNotMatch(server, /catch \{\}/);
  assert.match(client, /new AbortController\(\)/);
  assert.match(client, /document\.visibilityState === 'hidden'/);
  assert.match(client, /window\.addEventListener\('pagehide', suspend\)/);
  assert.match(client, /window\.addEventListener\('pageshow', resume\)/);
  assert.match(client, /!controller && !timer/);
  assert.match(client, /window\.removeEventListener\('pageshow', resume\)/);
  assert.match(client, /document\.removeEventListener\('visibilitychange', onVisibility\)/);
  assert.match(client, /function createBalancePoller\(setData, sessions\)/);
  assert.match(client, /const poller = createBalancePoller\(setData, sessions\);\s*poller\.start\(\);\s*return \(\) => poller\.dispose\(\);/s);
  assert.match(client, /sessionActive \? POLL_ACTIVE_MS : POLL_IDLE_MS/);
  assert.match(client, /const POLL_ACTIVE_MS = 30_000/);
  assert.match(client, /const POLL_IDLE_MS = 120_000/);
  assert.match(client, /session\?\.getSnapshot\?\.\(\)\.running === true/);
  assert.match(client, /sessions\?\.list\?\.subscribe\?\.\(bindSession\)/);
  assert.match(client, /observer\.disconnect\(\)/);
  assert.doesNotMatch(client, /setInterval/);
  assert.match(client, /\}, 'balance'\)/);
  assert.match(client, /\}, 'daily'\)/);
  assert.match(client, /\}, 'cost'\)/);
});

test('keeps the native label in normal mode and uses Fairy power only in HDD mode', () => {
  assert.match(client, /const readHddMode = \(\) => document\.documentElement\.getAttribute\('data-dsh-fairy-mode'\) === 'hdd'/);
  assert.match(client, /const \[hddMode, setHddMode\] = React\.useState\(readHddMode\)/);
  assert.match(client, /const dailyLabel = hddMode \? '今日电量' : '今日token'/);
  assert.match(client, /const dailySummaryLabel = hddMode \? '今日电量' : '今日 token'/);
  assert.match(client, /new MutationObserver\(syncMode\)/);
  assert.match(client, /attributeFilter: \['data-dsh-fairy-mode'\]/);
  assert.match(client, /observer\.disconnect\(\)/);
});

test('keeps balance credentials server-only and renders remote failures as unavailable', () => {
  assert.match(server, /function readApiKey\(\)/);
  assert.match(server, /Authorization: `Bearer \$\{key\}`/);
  assert.doesNotMatch(client, /DEEPSEEK_API_KEY|credentials|Authorization|readApiKey/);
  assert.match(client, /const BALANCE_UNAVAILABLE_TEXT = 'unavailable'/);
  assert.match(client, /balance: \{ is_available: false \}/);
  assert.match(client, /data\?\.balance\?\.is_available === false \? null/);
  assert.match(client, /const today = typeof data\?\.todayTokens === 'number'/);
  assert.match(client, /const cost = typeof data\?\.todayCost === 'number'/);
  assert.match(client, /今日估算/);
  assert.match(client, /marginLeft: 'auto', textAlign: 'right', whiteSpace: 'nowrap'/);
  assert.doesNotMatch(client, /含迁移估算|migrationText/);
  assert.match(client, /计价源 DeepSeek V4 Flash 官方价/);
  assert.match(server, /PRICING_VERIFIED_DATE = '2026-08-26'/);
  assert.match(server, /PRICING_SOURCE_URL = 'https:\/\/api-docs\.deepseek\.com\/quick_start\/pricing\/'/);
  assert.equal((client.match(/id: 'balance-meter'/g) || []).length, 1);
});

test('uses the official V4 Flash UTC peak/off-peak schedule and rates', async () => {
  const runtime = await import(new URL(`../lib/index.js?pricing-test=${Date.now()}`, import.meta.url));
  assert.equal(runtime.pricingBandForDate(new Date('2026-08-26T02:00:00Z')), 'peak');
  assert.equal(runtime.pricingBandForDate(new Date('2026-08-26T05:00:00Z')), 'offPeak');
  assert.equal(runtime.pricingBandForDate(new Date('2026-08-30T02:00:00Z')), 'offPeak');
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
  assert.equal(runtime.estimateUsageUsd(usage, new Date('2026-08-26T02:00:00Z')), 0.014 + 0.44 + 1.32);
  assert.equal(runtime.estimateUsageUsd(usage, new Date('2026-08-26T05:00:00Z')), 0.007 + 0.22 + 0.66);
});

test('suspends and resumes one visible-page balance request without retaining listeners', () => {
  const match = client.match(/function createBalancePoller\(setData, sessions\) \{[\s\S]*?\n    \}\n\n    function BalanceMeter/);
  assert.ok(match, 'balance poller source is available');
  const pollerSource = match[0].replace(/\n\n    function BalanceMeter$/, '');
  const documentListeners = new Map();
  const windowListeners = new Map();
  const timers = [];
  const requests = [];
  let visibilityState = 'visible';
  const document = {
    get visibilityState() { return visibilityState; },
    addEventListener(name, listener) { documentListeners.set(name, listener); },
    removeEventListener(name, listener) { assert.equal(documentListeners.get(name), listener); documentListeners.delete(name); },
  };
  const window = {
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name, listener) { assert.equal(windowListeners.get(name), listener); windowListeners.delete(name); },
    setTimeout(handler, delay) { timers.push({ handler, delay, cleared: false }); return timers.length; },
  };
  const clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  const fetch = (_url, options) => {
    requests.push(options.signal);
    return new Promise(() => {});
  };
  const sandbox = { AbortController, clearTimeout, document, fetch, window, POLL_ACTIVE_MS: 30_000, POLL_IDLE_MS: 120_000 };
  vm.runInNewContext(`${pollerSource}; globalThis.createBalancePoller = createBalancePoller;`, sandbox);
  const poller = sandbox.createBalancePoller(() => {});

  poller.start();
  assert.equal(requests.length, 1);
  assert.deepEqual([...documentListeners.keys()], ['visibilitychange']);
  assert.deepEqual([...windowListeners.keys()].sort(), ['pagehide', 'pageshow']);

  visibilityState = 'hidden';
  documentListeners.get('visibilitychange')();
  assert.equal(requests[0].aborted, true);

  visibilityState = 'visible';
  windowListeners.get('pageshow')();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].aborted, false);
  assert.equal(timers.length, 0);

  poller.dispose();
  assert.equal(requests[1].aborted, true);
  assert.equal(documentListeners.size, 0);
  assert.equal(windowListeners.size, 0);
});

test('uses a 30s active interval and a 120s idle interval without eager state-change requests', async () => {
  const match = client.match(/function createBalancePoller\(setData, sessions\) \{[\s\S]*?\n    \}\n\n    function BalanceMeter/);
  assert.ok(match, 'adaptive balance poller source is available');
  const pollerSource = match[0].replace(/\n\n    function BalanceMeter$/, '');
  const timers = [];
  let running = false;
  let sessionListener = null;
  const session = {
    getSnapshot: () => ({ running }),
    subscribe(listener) { sessionListener = listener; return () => { sessionListener = null; }; },
  };
  const sessions = {
    list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => () => {} },
    binding: () => ({ session }),
  };
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout(handler, delay) { timers.push({ handler, delay, cleared: false }); return timers.length; },
  };
  const clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return { ok: true, json: async () => ({ balance: { is_available: true } }) };
  };
  const sandbox = { AbortController, clearTimeout, document, fetch, sessions, window, POLL_ACTIVE_MS: 30_000, POLL_IDLE_MS: 120_000 };
  vm.runInNewContext(`${pollerSource}; globalThis.createBalancePoller = createBalancePoller;`, sandbox);
  const poller = sandbox.createBalancePoller(() => {}, sessions);

  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(timers.at(-1).delay, 120_000);

  running = true;
  sessionListener();
  assert.equal(requests, 1);
  assert.equal(timers.at(-1).delay, 30_000);

  running = false;
  sessionListener();
  assert.equal(timers.at(-1).delay, 120_000);
  assert.equal(60_000 / timers.at(-1).delay, 0.5);
  poller.dispose();
});

test('normalizes malformed usage before persisting and serving the daily total', async () => {
  const { mkdtemp, readFile: readFileFs, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'balance-meter-test-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  try {
    const runtime = await import(new URL(`../lib/index.js?usage-test=${Date.now()}`, import.meta.url));
    let eventHandler = null;
    let routeHandler = null;
    let subscriptions = 0;
    let injections = 0;
    let routeRegistrations = 0;
    const cleanups = [];
    const ctx = {
      effect(factory) { const cleanup = factory(); if (cleanup) cleanups.push(cleanup); },
      on(name, listener) { subscriptions += 1; if (name === 'session/event') eventHandler = listener; return () => {}; },
      inject(_deps, callback) {
        injections += 1;
        callback({
          effect(factory) { const cleanup = factory(); if (cleanup) cleanups.push(cleanup); },
          webServer: { register(route) { routeRegistrations += 1; routeHandler = route.handler; return () => {}; } },
        });
      },
    };
    runtime.apply(ctx);
    runtime.apply(ctx);
    assert.equal(subscriptions, 1);
    assert.equal(injections, 1);
    assert.equal(routeRegistrations, 1);
    eventHandler({}, { type: 'assistant/message', time: Date.UTC(2026, 7, 26, 2), data: { usage: {
      inputTokens: '10.9', outputTokens: -7, cacheReadTokens: Number.POSITIVE_INFINITY, cacheWriteTokens: 3.8,
    } } });
    const persisted = JSON.parse(await readFileFs(join(directory, 'balance-meter-daily.json'), 'utf8'));
    assert.deepEqual({
      inputTokens: persisted.inputTokens,
      outputTokens: persisted.outputTokens,
      cacheReadTokens: persisted.cacheReadTokens,
      cacheWriteTokens: persisted.cacheWriteTokens,
    }, { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3 });
    let payload = '';
    await routeHandler({}, {
      writableEnded: false,
      destroyed: false,
      setHeader() {},
      end(value) { payload = String(value); this.writableEnded = true; },
    });
    const served = JSON.parse(payload);
    assert.equal(served.todayTokens, 13);
    assert.ok(Math.abs(served.todayCost - (13 * 0.44 / 1_000_000 * 7.2)) < 1e-12);
    assert.deepEqual({
      model: served.pricing.model,
      verifiedDate: served.pricing.verifiedDate,
      estimateComplete: served.pricing.estimateComplete,
    }, { model: 'deepseek-v4-flash', verifiedDate: '2026-08-26', estimateComplete: true });
    cleanups.reverse().forEach((cleanup) => cleanup());
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  }
});
