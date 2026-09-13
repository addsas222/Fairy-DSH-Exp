import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  FAIRY_VOICE_SETTINGS_DEFAULTS,
  createFairyVoiceSttHandlers,
  createVoiceSettingsBoundary,
} from '../lib/index.js';
import {
  STT_PROVIDER_IDS,
  createSttRegistry,
} from '../lib/providers/stt-index.js';
import { audioFileName } from '../lib/providers/stt-openai.js';
import { readResponsePath } from '../lib/providers/stt-custom.js';

const MAX_STT_BYTES = 8 * 1024 * 1024;

/** Raw-body request double: audio bytes plus the headers the route reads. */
function requestWithAudio(audio, { contentType = 'audio/webm', language } = {}) {
  const request = new EventEmitter();
  request.headers = {};
  if (contentType !== undefined) request.headers['content-type'] = contentType;
  if (language !== undefined) request.headers['x-fairy-language'] = language;
  request[Symbol.asyncIterator] = async function* () {
    yield Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  };
  return request;
}

function responseDouble() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[String(name).toLowerCase()] = String(value); };
  response.end = (value) => { response.payload = value === undefined ? response.payload : String(value); response.writableEnded = true; };
  return response;
}

function jsonResponse(value, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return value; },
  };
}

function captureConsoleWarn() {
  const previous = console.warn;
  const entries = [];
  console.warn = (...args) => { entries.push(args.join(' ')); };
  return {
    entries,
    restore() { console.warn = previous; },
  };
}

function openAiSettings(overrides = {}) {
  return {
    stt: {
      provider: 'openai',
      providers: { openai: { apiKey: 'sk-live-stt-key-123456', ...overrides } },
    },
  };
}

test('stt registry resolves known ids, merges stored config, and falls back to browser', () => {
  const registry = createSttRegistry({ fetchImpl: async () => jsonResponse({ text: 'x' }) });
  assert.deepEqual(STT_PROVIDER_IDS, ['browser', 'openai', 'custom-http']);

  const browser = registry.resolve({});
  assert.equal(browser.id, 'browser');
  assert.deepEqual(browser.config, { lang: 'zh-CN' });

  const openai = registry.resolve({ stt: { provider: 'openai', providers: { openai: { model: 'gpt-4o-transcribe' } } } });
  assert.equal(openai.id, 'openai');
  assert.equal(openai.config.model, 'gpt-4o-transcribe');
  assert.equal(openai.config.baseURL, 'https://api.openai.com/v1');
  assert.equal(openai.config.language, 'zh');

  const custom = registry.resolve({ stt: { provider: 'custom-http' } });
  assert.equal(custom.id, 'custom-http');
  assert.deepEqual(custom.config, { url: '', headersJson: '{}', responsePath: 'text' });

  const captured = captureConsoleWarn();
  try {
    const fallback = registry.resolve({ stt: { provider: 'nope' } });
    assert.equal(fallback.id, 'browser');
    assert.equal(fallback.config.lang, 'zh-CN');
    assert.equal(captured.entries.some((entry) => entry.includes('stt.resolve') && entry.includes('nope')), true);
  } finally {
    captured.restore();
  }
});

test('stt availability probes are settings-driven, complete, and hard-bounded', async () => {
  const registry = createSttRegistry({ fetchImpl: async () => jsonResponse({ text: 'x' }) });
  const empty = await registry.list({ stt: { provider: 'browser' } });
  assert.deepEqual(empty.map((entry) => entry.id), ['browser', 'openai', 'custom-http']);
  assert.deepEqual(empty[0], { id: 'browser', available: true });
  assert.equal(empty[1].available, false);
  assert.match(empty[1].reason, /API Key/);
  assert.equal(empty[2].available, false);
  assert.match(empty[2].reason, /地址/);

  const configured = await registry.list({
    stt: {
      provider: 'openai',
      providers: { openai: { apiKey: 'sk-live-123' }, customHttp: { url: 'https://stt.example/transcribe' } },
    },
  });
  assert.deepEqual(configured.find((entry) => entry.id === 'openai'), { id: 'openai', available: true });
  assert.deepEqual(configured.find((entry) => entry.id === 'custom-http'), { id: 'custom-http', available: true });

  const brokenHeaders = await registry.list({ stt: { providers: { customHttp: { url: 'https://stt.example/x', headersJson: '{' } } } });
  assert.equal(brokenHeaders.find((entry) => entry.id === 'custom-http').available, false);

  // A provider that ignores its abort signal cannot hold the settings card
  // open: the probe budget resolves the entry as a timeout.
  const bounded = createSttRegistry({ fetchImpl: async () => jsonResponse({ text: 'x' }), availabilityTimeoutMs: 15 });
  bounded.PROVIDERS.set('openai', { id: 'openai', available: () => new Promise(() => {}), transcribe: () => {} });
  const killed = await bounded.list({ stt: { providers: { openai: { apiKey: 'sk-live-123' } } } });
  assert.deepEqual(killed.find((entry) => entry.id === 'openai'), { id: 'openai', available: false, reason: '检查超时。' });
});

test('openai stt posts a real multipart body with model, language, and bearer auth', async () => {
  let captured;
  const settings = createVoiceSettingsBoundary();
  await settings.write(openAiSettings());
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({ text: '你好，Fairy。' });
    },
  });
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
  const response = responseDouble();
  await handlers.stt(requestWithAudio(audio, { contentType: 'audio/webm;codecs=opus', language: 'zh-CN' }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.payload), { text: '你好，Fairy。' });
  assert.equal(captured.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(captured.options.headers.Authorization, 'Bearer sk-live-stt-key-123456');
  // fetch must derive the multipart boundary itself.
  assert.equal(captured.options.headers['Content-Type'], undefined);
  assert.equal(captured.options.body instanceof FormData, true);
  assert.equal(captured.options.body.get('model'), 'whisper-1');
  assert.equal(captured.options.body.get('language'), 'zh-CN');
  const file = captured.options.body.get('file');
  assert.equal(file.name, 'audio.webm');
  assert.equal(file.type, 'audio/webm');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [...audio]);
});

test('openai stt falls back to the stored language and picks a sniffable filename', async () => {
  assert.equal(audioFileName('audio/webm'), 'audio.webm');
  assert.equal(audioFileName('audio/mp4'), 'audio.m4a');
  assert.equal(audioFileName('audio/x-wav'), 'audio.wav');
  assert.equal(audioFileName('application/octet-stream'), 'audio.bin');

  let captured;
  const settings = createVoiceSettingsBoundary();
  await settings.write(openAiSettings({ language: 'ja' }));
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async (_url, options) => { captured = options; return jsonResponse({ text: 'はい。' }); },
  });
  await handlers.stt(requestWithAudio(Buffer.from([1]), { contentType: 'audio/ogg', language: 'bad lang;drop' }), responseDouble());
  assert.equal(captured.body.get('language'), 'ja');
  assert.equal(captured.body.get('file').name, 'audio.ogg');
});

test('custom-http stt forwards raw bytes and static headers and reads a nested response path', async () => {
  let captured;
  const settings = createVoiceSettingsBoundary();
  await settings.write({
    stt: {
      provider: 'custom-http',
      providers: {
        customHttp: {
          url: 'https://stt.example/transcribe',
          headersJson: JSON.stringify({ 'x-api-key': 'k1', 'X-Fairy-Language': 'fixed' }),
          responsePath: 'data.result.text',
        },
      },
    },
  });
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({ data: { result: { text: '识别结果。' } } });
    },
  });
  const audio = Buffer.from([9, 8, 7]);
  const response = responseDouble();
  await handlers.stt(requestWithAudio(audio, { contentType: 'audio/wav', language: 'zh' }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.payload), { text: '识别结果。' });
  assert.equal(captured.url, 'https://stt.example/transcribe');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['x-api-key'], 'k1');
  // The operator's static header wins over the request header.
  assert.equal(captured.options.headers['X-Fairy-Language'], 'fixed');
  assert.equal(captured.options.headers['Content-Type'], 'audio/wav');
  assert.deepEqual([...captured.options.body], [...audio]);
});

test('custom-http stt reports a missing response path as an upstream failure', async () => {
  const settings = createVoiceSettingsBoundary();
  await settings.write({ stt: { provider: 'custom-http', providers: { customHttp: { url: 'https://stt.example/x', responsePath: 'data.result.text' } } } });
  const handlers = createFairyVoiceSttHandlers({ settings, fetchImpl: async () => jsonResponse({ data: {} }) });
  const response = responseDouble();
  await handlers.stt(requestWithAudio(Buffer.from([1]), {}), response);
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.payload).error.code, 'provider-failed');

  assert.equal(readResponsePath({ a: { b: [{ c: 'deep' }] } }, 'a.b.0.c'), 'deep');
  assert.equal(readResponsePath({ a: 1 }, 'a.b'), undefined);
  assert.equal(readResponsePath({ a: 1 }, ''), undefined);
  assert.equal(readResponsePath('text', 'text'), undefined);
});

test('stt maps client-side, unconfigured, upstream, and timeout failures to their statuses', async () => {
  const browser = createFairyVoiceSttHandlers({ settings: createVoiceSettingsBoundary() });
  const browserResponse = responseDouble();
  await browser.stt(requestWithAudio(Buffer.from([1]), {}), browserResponse);
  assert.equal(browserResponse.statusCode, 409);
  assert.deepEqual(JSON.parse(browserResponse.payload), { error: { code: 'client-side', message: '浏览器端语音输入' } });

  const unconfigured = createVoiceSettingsBoundary();
  await unconfigured.write({ stt: { provider: 'openai' } });
  const missingKey = createFairyVoiceSttHandlers({ settings: unconfigured, fetchImpl: async () => jsonResponse({ text: 'x' }) });
  const missingKeyResponse = responseDouble();
  await missingKey.stt(requestWithAudio(Buffer.from([1]), {}), missingKeyResponse);
  assert.equal(missingKeyResponse.statusCode, 503);
  assert.equal(JSON.parse(missingKeyResponse.payload).error.code, 'provider-unavailable');

  const settings = createVoiceSettingsBoundary();
  await settings.write(openAiSettings());
  const upstream = createFairyVoiceSttHandlers({ settings, fetchImpl: async () => jsonResponse({}, false, 500) });
  const upstreamResponse = responseDouble();
  await upstream.stt(requestWithAudio(Buffer.from([1]), {}), upstreamResponse);
  assert.equal(upstreamResponse.statusCode, 502);
  assert.deepEqual(JSON.parse(upstreamResponse.payload), { error: { code: 'provider-failed', message: '语音识别服务未能完成识别。' } });

  const unreachable = createFairyVoiceSttHandlers({ settings, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const unreachableResponse = responseDouble();
  await unreachable.stt(requestWithAudio(Buffer.from([1]), {}), unreachableResponse);
  assert.equal(unreachableResponse.statusCode, 503);

  // The scope timer aborts the upstream request with reason `timeout`, and
  // requestProvider keeps that reason so the status stays 504.
  const hanging = createFairyVoiceSttHandlers({
    settings,
    timeoutMs: 15,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: options.signal.reason })), { once: true });
    }),
  });
  const timeoutResponse = responseDouble();
  await hanging.stt(requestWithAudio(Buffer.from([1]), {}), timeoutResponse);
  assert.equal(timeoutResponse.statusCode, 504);
  assert.deepEqual(JSON.parse(timeoutResponse.payload), { error: { code: 'timeout', message: '语音识别超时。' } });
});

test('stt rejects non-audio bodies with 415 before buffering them', async () => {
  const handlers = createFairyVoiceSttHandlers({ settings: createVoiceSettingsBoundary() });
  const json = responseDouble();
  await handlers.stt(requestWithAudio(Buffer.from('{"text":"x"}'), { contentType: 'application/json' }), json);
  assert.equal(json.statusCode, 415);
  assert.deepEqual(JSON.parse(json.payload), { error: { code: 'unsupported-audio-type', message: '请求体必须是音频数据（audio/*）。' } });

  const missing = responseDouble();
  const bare = requestWithAudio(Buffer.from([1]));
  delete bare.headers['content-type'];
  await handlers.stt(bare, missing);
  assert.equal(missing.statusCode, 415);
});

test('stt caps the uploaded body at 8 MiB with 413', async () => {
  const settings = createVoiceSettingsBoundary();
  await settings.write(openAiSettings());
  let calls = 0;
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async () => { calls += 1; return jsonResponse({ text: 'x' }); },
  });
  const response = responseDouble();
  await handlers.stt(requestWithAudio(Buffer.alloc(MAX_STT_BYTES + 1), {}), response);
  assert.equal(response.statusCode, 413);
  assert.deepEqual(JSON.parse(response.payload), { error: { code: 'audio-too-large', message: '音频数据不能超过 8 MiB。' } });
  assert.equal(calls, 0);
});

test('stt providers endpoint lists every provider in registry order', async () => {
  const handlers = createFairyVoiceSttHandlers({
    settings: createVoiceSettingsBoundary(),
    fetchImpl: async () => jsonResponse({ text: 'x' }),
  });
  const response = responseDouble();
  await handlers.sttProviders({}, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.payload).map((entry) => entry.id), ['browser', 'openai', 'custom-http']);
});

test('stt config reads and writes the stt section with masked keys that mean "unchanged"', async () => {
  const settings = createVoiceSettingsBoundary();
  const handlers = createFairyVoiceSttHandlers({ settings, fetchImpl: async () => jsonResponse({ text: 'x' }) });

  const read = responseDouble();
  await handlers.sttConfig({ method: 'GET' }, read);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(JSON.parse(read.payload), {
    provider: 'browser',
    providers: {
      browser: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.browser,
      openai: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.openai,
      customHttp: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.customHttp,
    },
  });

  const write = responseDouble();
  await handlers.sttConfig({
    method: 'POST',
    ...requestWithAudio(JSON.stringify({
      provider: 'openai',
      providers: {
        openai: { apiKey: 'sk-live-stt-key-123456', model: 'gpt-4o-transcribe', language: 'en', unknown: 'dropped' },
        nope: { url: 'https://ignored' },
      },
    }), { contentType: 'application/json' }),
  }, write);
  assert.equal(write.statusCode, 200);
  assert.equal(write.payload.includes('sk-live-stt-key-123456'), false);
  const written = JSON.parse(write.payload);
  assert.equal(written.provider, 'openai');
  assert.equal(written.providers.openai.apiKey, '***');
  assert.equal(written.providers.openai.model, 'gpt-4o-transcribe');
  assert.equal(written.providers.openai.language, 'en');
  assert.equal('unknown' in written.providers.openai, false);
  assert.equal('nope' in written.providers, false);
  assert.equal(settings.read().stt.providers.openai.apiKey, 'sk-live-stt-key-123456');

  const masked = responseDouble();
  await handlers.sttConfig({
    method: 'POST',
    ...requestWithAudio(JSON.stringify({ providers: { openai: { apiKey: '***', language: 'zh' } } }), { contentType: 'application/json' }),
  }, masked);
  assert.equal(JSON.parse(masked.payload).providers.openai.language, 'zh');
  assert.equal(settings.read().stt.providers.openai.apiKey, 'sk-live-stt-key-123456');

  const cleared = responseDouble();
  await handlers.sttConfig({
    method: 'POST',
    ...requestWithAudio(JSON.stringify({ providers: { openai: { apiKey: '' } } }), { contentType: 'application/json' }),
  }, cleared);
  assert.equal(settings.read().stt.providers.openai.apiKey, '');
  assert.equal(settings.read().stt.providers.openai.model, 'gpt-4o-transcribe');

  // An unknown provider id is ignored rather than rejected: the rest of the
  // request still saves.
  const tolerant = responseDouble();
  await handlers.sttConfig({
    method: 'POST',
    ...requestWithAudio(JSON.stringify({ provider: 'nope', providers: { browser: { lang: 'en-US' } } }), { contentType: 'application/json' }),
  }, tolerant);
  assert.equal(tolerant.statusCode, 200);
  const tolerantBody = JSON.parse(tolerant.payload);
  assert.equal(tolerantBody.provider, 'openai');
  assert.equal(tolerantBody.providers.browser.lang, 'en-US');
});

test('stt config rejects malformed JSON and oversized settings payloads', async () => {
  const handlers = createFairyVoiceSttHandlers({ settings: createVoiceSettingsBoundary(), fetchImpl: async () => jsonResponse({ text: 'x' }) });
  const malformed = responseDouble();
  await handlers.sttConfig({ method: 'POST', ...requestWithAudio('{not json', { contentType: 'application/json' }) }, malformed);
  assert.equal(malformed.statusCode, 400);
  assert.equal(JSON.parse(malformed.payload).error.code, 'invalid-json');

  const oversized = responseDouble();
  await handlers.sttConfig({ method: 'POST', ...requestWithAudio(JSON.stringify({ pad: 'x'.repeat(20_001) }), { contentType: 'application/json' }) }, oversized);
  assert.equal(oversized.statusCode, 400);
});

test('the plugin registers the four stt endpoints alongside the tts routes', async () => {
  const { apply } = await import('../lib/index.js');
  const routes = new Map();
  const cleanups = [];
  const scope = {
    get: () => structuredClone(FAIRY_VOICE_SETTINGS_DEFAULTS),
    update: async () => scope.get(),
  };
  const context = {
    inject(names, callback) {
      if (names.includes('settings')) callback({ settings: { register: () => scope } });
      if (names.includes('webServer')) {
        callback({
          effect: (register) => { cleanups.push(register()); },
          webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path); } },
        });
      }
    },
    effect(callback) { cleanups.push(callback()); },
    on(_event, listener) { return () => listener; },
  };
  apply(context);
  for (const path of ['/fairy-voice/stt-providers', '/fairy-voice/stt-config', '/fairy-voice/stt']) {
    assert.equal(typeof routes.get(path), 'function', `${path} must be registered`);
  }
  const response = responseDouble();
  await routes.get('/fairy-voice/stt-providers')({ method: 'GET' }, response);
  assert.deepEqual(JSON.parse(response.payload).map((entry) => entry.id), ['browser', 'openai', 'custom-http']);
  cleanups.forEach((cleanup) => cleanup?.());
});
