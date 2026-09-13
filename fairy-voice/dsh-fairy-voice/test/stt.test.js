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
import { audioFileName, createOpenAiSttProvider, isLoopbackBaseUrl } from '../lib/providers/stt-openai.js';
import { createDeepgramSttProvider } from '../lib/providers/stt-deepgram.js';
import { createAzureSttProvider } from '../lib/providers/stt-azure.js';
import { STT_WHISPER_WEB_DEFAULTS } from '../lib/providers/stt-whisper-web.js';
import { readResponsePath } from '../lib/providers/stt-custom.js';

const MAX_STT_BYTES = 8 * 1024 * 1024;
const STT_IDS = ['browser', 'whisper-web', 'openai', 'deepgram', 'azure', 'custom-http'];

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
  assert.deepEqual(STT_PROVIDER_IDS, STT_IDS);

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

  const deepgram = registry.resolve({ stt: { provider: 'deepgram' } });
  assert.equal(deepgram.id, 'deepgram');
  assert.deepEqual(deepgram.config, { baseUrl: 'https://api.deepgram.com', apiKey: '', model: 'nova-3', language: 'zh-CN' });

  const azure = registry.resolve({ stt: { provider: 'azure', providers: { azure: { endpoint: 'https://rg.api.cognitive.microsoft.com', apiKey: 'k' } } } });
  assert.equal(azure.id, 'azure');
  assert.equal(azure.config.endpoint, 'https://rg.api.cognitive.microsoft.com');
  assert.equal(azure.config.locale, 'zh-CN');

  const whisperWeb = registry.resolve({ stt: { provider: 'whisper-web' } });
  assert.equal(whisperWeb.id, 'whisper-web');
  assert.deepEqual(whisperWeb.config, { ...STT_WHISPER_WEB_DEFAULTS });

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
  assert.deepEqual(empty.map((entry) => entry.id), STT_IDS);
  const byId = (entries, id) => entries.find((entry) => entry.id === id);
  assert.deepEqual(byId(empty, 'browser'), { id: 'browser', available: true });
  // Client-side Whisper needs no host configuration at all.
  assert.deepEqual(byId(empty, 'whisper-web'), { id: 'whisper-web', available: true });
  assert.equal(byId(empty, 'openai').available, false);
  assert.match(byId(empty, 'openai').reason, /API Key/);
  assert.equal(byId(empty, 'deepgram').available, false);
  assert.match(byId(empty, 'deepgram').reason, /API Key/);
  assert.equal(byId(empty, 'azure').available, false);
  assert.match(byId(empty, 'azure').reason, /终结点/);
  assert.equal(byId(empty, 'custom-http').available, false);
  assert.match(byId(empty, 'custom-http').reason, /地址/);

  const configured = await registry.list({
    stt: {
      provider: 'openai',
      providers: {
        openai: { apiKey: 'sk-live-123' },
        deepgram: { apiKey: 'dg-live-123' },
        azure: { endpoint: 'https://rg.api.cognitive.microsoft.com', apiKey: 'az-live-123' },
        customHttp: { url: 'https://stt.example/transcribe' },
      },
    },
  });
  for (const id of ['openai', 'deepgram', 'azure', 'custom-http']) {
    assert.deepEqual(byId(configured, id), { id, available: true });
  }
  // An unparsable endpoint is unavailable, not an invitation to fail at request time.
  const brokenEndpoint = await registry.list({ stt: { providers: { azure: { endpoint: 'not a url', apiKey: 'az-live-123' } } } });
  assert.equal(byId(brokenEndpoint, 'azure').available, false);
  assert.match(byId(brokenEndpoint, 'azure').reason, /无效/);

  const brokenHeaders = await registry.list({ stt: { providers: { customHttp: { url: 'https://stt.example/x', headersJson: '{' } } } });
  assert.equal(byId(brokenHeaders, 'custom-http').available, false);

  // A provider that ignores its abort signal cannot hold the settings card
  // open: the probe budget resolves the entry as a timeout.
  const bounded = createSttRegistry({ fetchImpl: async () => jsonResponse({ text: 'x' }), availabilityTimeoutMs: 15 });
  bounded.PROVIDERS.set('openai', { id: 'openai', available: () => new Promise(() => {}), transcribe: () => {} });
  const killed = await bounded.list({ stt: { providers: { openai: { apiKey: 'sk-live-123' } } } });
  assert.deepEqual(byId(killed, 'openai'), { id: 'openai', available: false, reason: '检查超时。' });
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
  // The upstream status rides along: with six routes configured, "which one
  // failed and how" is the difference between a typo and an outage.
  assert.deepEqual(JSON.parse(upstreamResponse.payload), { error: { code: 'provider-failed', message: '语音识别服务未能完成识别。（语音服务返回 500）' } });

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

test('stt fails to the caller with the text the provider described', async () => {
  const settings = createVoiceSettingsBoundary();
  await settings.write({
    stt: {
      provider: 'deepgram',
      providers: { deepgram: { apiKey: 'dg-live-key', baseUrl: 'https://api.deepgram.com' } },
    },
  });
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async () => jsonResponse({ err_msg: 'Invalid credentials\nbad token' }, false, 401),
  });
  const response = responseDouble();
  await handlers.stt(requestWithAudio(Buffer.from([1]), {}), response);
  assert.equal(response.statusCode, 502);
  const { error } = JSON.parse(response.payload);
  assert.equal(error.code, 'provider-failed');
  // Six routes report through one code, so the description is the diagnosis;
  // it arrives on one line with the framing intact.
  assert.equal(error.message, '语音识别服务未能完成识别。（Invalid credentials bad token）');
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f]/);
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
  assert.deepEqual(JSON.parse(response.payload).map((entry) => entry.id), STT_IDS);
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
      whisperWeb: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.whisperWeb,
      openai: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.openai,
      deepgram: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.deepgram,
      azure: FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.azure,
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
  assert.deepEqual(JSON.parse(response.payload).map((entry) => entry.id), STT_IDS);
  cleanups.forEach((cleanup) => cleanup?.());
});

test('deepgram stt posts raw audio bytes with token auth and reads the transcript', async () => {
  let captured;
  const provider = createDeepgramSttProvider({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({ results: { channels: [{ alternatives: [{ transcript: ' 你好，世界。 ' }] }] } });
    },
  });
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
  const result = await provider.transcribe({
    audio,
    contentType: 'audio/webm',
    language: 'zh-CN',
    config: { apiKey: 'dg-live-123' },
  });
  assert.deepEqual(result, { text: '你好，世界。' });
  assert.equal(captured.url, 'https://api.deepgram.com/v1/listen?model=nova-3&language=zh-CN&smart_format=true&punctuate=true');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Token dg-live-123');
  // No multipart: Deepgram reads the declared container from the raw body.
  assert.equal(captured.options.headers['Content-Type'], 'audio/webm');
  assert.deepEqual([...captured.options.body], [...audio]);
  assert.deepEqual(provider.available({ apiKey: 'dg-live-123' }), { available: true, reason: null });
});

test('deepgram stt falls back to the stored language and surfaces upstream errors', async () => {
  let respond = () => jsonResponse({ results: { channels: [{ alternatives: [{ transcript: 'ありがとう。' }] }] } });
  let lastUrl;
  const provider = createDeepgramSttProvider({
    fetchImpl: async (url) => { lastUrl = url; return respond(); },
  });
  const call = (config, language) => provider.transcribe({ audio: Buffer.from([1]), contentType: 'audio/ogg', language, config });

  assert.deepEqual(await call({ apiKey: 'k', model: 'nova-2', language: 'ja' }), { text: 'ありがとう。' });
  assert.equal(lastUrl, 'https://api.deepgram.com/v1/listen?model=nova-2&language=ja&smart_format=true&punctuate=true');

  respond = () => jsonResponse({ err_code: 'BAD_KEY', err_msg: 'Invalid credentials' }, false, 401);
  await assert.rejects(call({ apiKey: 'k' }), (error) => error.code === 'provider-failed' && error.message === 'Invalid credentials');

  // A 200 that carries an upstream error is still a failure, message included.
  respond = () => jsonResponse({ error: 'Unsupported model' });
  await assert.rejects(call({ apiKey: 'k' }), (error) => error.code === 'provider-failed' && error.message === 'Unsupported model');

  respond = () => jsonResponse({ nonsense: true });
  await assert.rejects(call({ apiKey: 'k' }), (error) => error.code === 'provider-failed' && error.message === '语音识别服务未返回识别结果。');

  respond = () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(call({ apiKey: 'k' }), (error) => error.code === 'provider-unavailable');

  // The inlined boundary keeps the shared cancellation taxonomy: a scope
  // timeout still reaches the route as 504, not as a generic upstream failure.
  const hanging = createDeepgramSttProvider({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = hanging.transcribe({ audio: Buffer.from([1]), contentType: 'audio/webm', config: { apiKey: 'k' }, signal: controller.signal });
  controller.abort('timeout');
  await assert.rejects(pending, (error) => error.code === 'timeout');

  assert.deepEqual(provider.available({}), { available: false, reason: '未配置 Deepgram API Key。' });
  assert.deepEqual(provider.available({ apiKey: 'k', baseUrl: '  ' }), { available: false, reason: '未配置 Deepgram 服务地址。' });
  await assert.rejects(call({ apiKey: '' }), (error) => error.code === 'provider-unavailable' && error.message === '未配置 Deepgram API Key。');
});

test('azure stt posts the fast-transcription multipart body and joins phrases per locale', async () => {
  let captured;
  const provider = createAzureSttProvider({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({ phrases: [{ text: '你好' }, { text: '' }, { text: '世界' }] });
    },
  });
  const audio = Buffer.from([9, 8, 7]);
  const chinese = await provider.transcribe({
    audio,
    contentType: 'audio/webm',
    language: 'zh-CN',
    config: { endpoint: 'https://rg.api.cognitive.microsoft.com/', apiKey: 'az-live-123' },
  });
  // Chinese phrases are concatenated without a joining space, empties dropped.
  assert.deepEqual(chinese, { text: '你好世界' });
  assert.equal(captured.url, 'https://rg.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Ocp-Apim-Subscription-Key'], 'az-live-123');
  // fetch must derive the multipart boundary itself.
  assert.equal(captured.options.headers['Content-Type'], undefined);
  assert.equal(captured.options.body instanceof FormData, true);
  assert.equal(captured.options.body.get('definition'), '{"locales":["zh-CN"]}');
  const blob = captured.options.body.get('audio');
  assert.equal(blob.type, 'audio/webm');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...audio]);

  let url;
  const english = createAzureSttProvider({
    fetchImpl: async (target) => { url = target; return jsonResponse({ phrases: [{ text: 'hello' }, { text: 'world' }] }); },
  });
  assert.deepEqual(await english.transcribe({
    audio,
    contentType: 'audio/wav',
    language: 'en-US',
    config: { endpoint: 'https://x.cognitiveservices.azure.com', apiKey: 'k' },
  }), { text: 'hello world' });
  assert.equal(url, 'https://x.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15');
});

test('azure stt keeps a pasted full endpoint path and maps upstream failures', async () => {
  const urls = [];
  const provider = createAzureSttProvider({
    fetchImpl: async (url) => { urls.push(url); return jsonResponse({ phrases: [] }); },
  });
  const call = (endpoint) => provider.transcribe({ audio: Buffer.from([1]), contentType: 'audio/wav', config: { endpoint, apiKey: 'k' } });
  await call('https://x.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15');
  await call('https://x.cognitiveservices.azure.com/speechtotext/');
  // Neither the request path nor the api-version is appended twice.
  assert.deepEqual(urls, [
    'https://x.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
    'https://x.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
  ]);

  const rejected = createAzureSttProvider({ fetchImpl: async () => jsonResponse({ error: { code: 'BadRequest', message: 'Unsupported locale' } }, false, 400) });
  await assert.rejects(
    rejected.transcribe({ audio: Buffer.from([1]), contentType: 'audio/wav', config: { endpoint: 'https://x.cognitiveservices.azure.com', apiKey: 'k' } }),
    (error) => error.code === 'provider-failed' && error.message === 'Unsupported locale',
  );

  const shapeless = createAzureSttProvider({ fetchImpl: async () => jsonResponse({ text: 'no phrases' }) });
  await assert.rejects(
    shapeless.transcribe({ audio: Buffer.from([1]), contentType: 'audio/wav', config: { endpoint: 'https://x.cognitiveservices.azure.com', apiKey: 'k' } }),
    (error) => error.code === 'provider-failed' && error.message === '语音识别服务未返回识别结果。',
  );

  assert.deepEqual(provider.available({ apiKey: 'k' }), { available: false, reason: '未配置 Azure 语音终结点。' });
  assert.deepEqual(provider.available({ endpoint: 'not a url', apiKey: 'k' }), { available: false, reason: 'Azure 语音终结点无效。' });
  assert.deepEqual(provider.available({ endpoint: 'https://x.cognitiveservices.azure.com' }), { available: false, reason: '未配置 Azure 语音 API Key。' });
  assert.deepEqual(provider.available({ endpoint: 'https://x.cognitiveservices.azure.com', apiKey: 'k' }), { available: true, reason: null });
});

test('whisper-web is a client-side marker: 409 through the route, nothing uploaded', async () => {
  const settings = createVoiceSettingsBoundary();
  await settings.write({ stt: { provider: 'whisper-web' } });
  let calls = 0;
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async () => { calls += 1; return jsonResponse({ text: 'x' }); },
  });
  const response = responseDouble();
  await handlers.stt(requestWithAudio(Buffer.from([1, 2, 3]), { contentType: 'audio/webm' }), response);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.payload), { error: { code: 'client-side', message: '浏览器端语音输入' } });
  assert.equal(calls, 0);

  // The host only stores the client's engine config; transformers.js runs it.
  assert.deepEqual(Object.keys(FAIRY_VOICE_SETTINGS_DEFAULTS.stt.providers.whisperWeb), [
    'moduleUrl', 'modelId', 'device', 'dtype', 'language', 'resourceBase',
  ]);
  assert.equal(STT_WHISPER_WEB_DEFAULTS.modelId, 'onnx-community/whisper-base');
});

test('stt config stores the online and whisper-web sections with masked keys', async () => {
  const settings = createVoiceSettingsBoundary();
  const handlers = createFairyVoiceSttHandlers({ settings, fetchImpl: async () => jsonResponse({ text: 'x' }) });
  const write = responseDouble();
  await handlers.sttConfig({
    method: 'POST',
    ...requestWithAudio(JSON.stringify({
      providers: {
        deepgram: { apiKey: 'dg-live-123', model: 'nova-2', language: 'ja', unknown: 'dropped' },
        azure: { endpoint: 'https://rg.api.cognitive.microsoft.com', apiKey: 'az-live-123', locale: 'en-US' },
        whisperWeb: { modelId: 'onnx-community/whisper-small', resourceBase: 'https://hf-mirror.com' },
        browser: { lang: 'en-US' },
      },
    }), { contentType: 'application/json' }),
  }, write);
  assert.equal(write.statusCode, 200);
  assert.equal(write.payload.includes('dg-live-123'), false);
  assert.equal(write.payload.includes('az-live-123'), false);
  const body = JSON.parse(write.payload);
  assert.deepEqual(body.providers.deepgram, { baseUrl: 'https://api.deepgram.com', apiKey: '***', model: 'nova-2', language: 'ja' });
  assert.deepEqual(body.providers.azure, { endpoint: 'https://rg.api.cognitive.microsoft.com', apiKey: '***', locale: 'en-US' });
  assert.equal(body.providers.whisperWeb.modelId, 'onnx-community/whisper-small');
  assert.equal(body.providers.whisperWeb.resourceBase, 'https://hf-mirror.com');
  assert.equal(body.providers.whisperWeb.moduleUrl, STT_WHISPER_WEB_DEFAULTS.moduleUrl);
  assert.equal(body.providers.browser.lang, 'en-US');
  // Untouched sections keep their defaults, and the stored secrets stay live.
  assert.equal(body.providers.openai.apiKey, '');
  assert.equal(settings.read().stt.providers.deepgram.apiKey, 'dg-live-123');
  assert.equal(settings.read().stt.providers.azure.locale, 'en-US');
});

test('openai stt accepts a keyless loopback server and drops the bearer header', async () => {
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8080/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://localhost:9000/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://[::1]:9000/v1'), true);
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1.evil.com/v1'), false);
  assert.equal(isLoopbackBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(isLoopbackBaseUrl('not a url'), false);

  let captured;
  const provider = createOpenAiSttProvider({
    fetchImpl: async (url, options) => { captured = { url, options }; return jsonResponse({ text: '本地识别。' }); },
  });
  assert.deepEqual(provider.available({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: '' }), { available: true, reason: '本地服务无需密钥。' });
  assert.deepEqual(provider.available({ baseURL: 'https://api.openai.com/v1', apiKey: '' }), { available: false, reason: '未配置 OpenAI API Key。' });
  assert.deepEqual(provider.available({ baseURL: 'http://127.0.0.1.evil.com/v1', apiKey: '' }), { available: false, reason: '未配置 OpenAI API Key。' });

  assert.deepEqual(
    await provider.transcribe({ audio: Buffer.from([1]), contentType: 'audio/webm', config: { baseURL: 'http://127.0.0.1:8080/v1/', apiKey: '' } }),
    { text: '本地识别。' },
  );
  assert.equal(captured.url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
  // An empty `Bearer ` header makes local servers answer 401, so it is omitted.
  assert.equal('Authorization' in captured.options.headers, false);
  assert.equal(captured.options.body instanceof FormData, true);
  assert.equal(captured.options.body.get('model'), 'whisper-1');

  await provider.transcribe({ audio: Buffer.from([1]), contentType: 'audio/webm', config: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-live-123' } });
  assert.equal(captured.options.headers.Authorization, 'Bearer sk-live-123');

  // The route no longer gates a local server behind a key it does not have.
  const settings = createVoiceSettingsBoundary();
  await settings.write({ stt: { provider: 'openai', providers: { openai: { baseURL: 'http://127.0.0.1:8078/v1', apiKey: '' } } } });
  const handlers = createFairyVoiceSttHandlers({
    settings,
    fetchImpl: async (url, options) => { captured = { url, options }; return jsonResponse({ text: '本地识别。' }); },
  });
  const response = responseDouble();
  await handlers.stt(requestWithAudio(Buffer.from([1]), {}), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.payload), { text: '本地识别。' });
  assert.equal('Authorization' in captured.options.headers, false);
});
