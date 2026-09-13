import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAIRY_VOICE_SETTINGS_DEFAULTS,
  FAIRY_VOICE_SETTINGS_NAMESPACE,
  FairyVoiceSettings,
  createFairyVoiceHandlers,
  createVoiceSettingsBoundary,
  personaVoicePatch,
} from '../lib/index.js';
import { REFERENCE_PROMPT_FALLBACK, createLocalSovitsProvider } from '../lib/providers/local-sovits.js';
import { createOpenAiProvider } from '../lib/providers/openai.js';
import { parseStaticHeaders, renderCustomBody, createCustomHttpProvider } from '../lib/providers/custom-http.js';
import { createProviderRegistry } from '../lib/providers/index.js';

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
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[String(name).toLowerCase()] = String(value); };
  response.write = () => { response.headersSent = true; return true; };
  response.end = (value) => { response.payload = value === undefined ? response.payload : String(value); response.writableEnded = true; };
  response.destroy = () => { response.destroyed = true; };
  return response;
}

function pcmResponse(contentType = 'audio/raw') {
  return {
    ok: true,
    headers: { get: () => contentType },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from([0, 0]); } },
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

test('the registered namespace and schema agree with the fallback defaults', async () => {
  const { settingsNamespace } = await import('@deepseek-ai/dsh-settings');
  assert.equal(settingsNamespace(FAIRY_VOICE_SETTINGS_NAMESPACE), 'fairy-voice');
  assert.throws(() => settingsNamespace('FairyVoice'), /must match/);
  // A missing user section must resolve exactly like the in-memory fallback,
  // or the host would answer differently before and after the scope attaches.
  assert.deepEqual(FairyVoiceSettings({}), JSON.parse(JSON.stringify(FAIRY_VOICE_SETTINGS_DEFAULTS)));
  const partial = FairyVoiceSettings({ provider: 'openai', providers: { openai: { apiKey: 'sk-live-1234567890' } } });
  assert.equal(partial.provider, 'openai');
  assert.equal(partial.providers.openai.apiKey, 'sk-live-1234567890');
  assert.equal(partial.providers.localSovits.baseURL, FAIRY_VOICE_SETTINGS_DEFAULTS.providers.localSovits.baseURL);
  // An unknown provider must not fail registration: the registry degrades it.
  assert.equal(FairyVoiceSettings({ provider: 'bogus' }).provider, 'bogus');
  const registry = createProviderRegistry({ fetchImpl: async () => pcmResponse() });
  assert.equal(registry.resolve({ provider: 'bogus' }).id, 'local-sovits');
});

test('provider registry resolves known ids and falls back to GPT-SoVITS for unknown ones', () => {
  const registry = createProviderRegistry({ fetchImpl: async () => pcmResponse() });
  const local = registry.resolve({ provider: 'local-sovits' });
  assert.equal(local.id, 'local-sovits');
  assert.equal(local.config.baseURL, 'http://127.0.0.1:9880');
  assert.equal(registry.resolve({ provider: 'openai' }).id, 'openai');
  assert.equal(registry.resolve({ provider: 'browser' }).id, 'browser');
  assert.deepEqual(registry.resolve({ provider: 'custom-http' }).config, FAIRY_VOICE_SETTINGS_DEFAULTS.providers.customHttp);
  assert.equal(registry.resolve({}).id, 'local-sovits');

  const captured = captureConsoleWarn();
  try {
    const fallback = registry.resolve({ provider: 'nope' });
    assert.equal(fallback.id, 'local-sovits');
    assert.equal(fallback.config.baseURL, 'http://127.0.0.1:9880');
    assert.equal(captured.entries.some((entry) => entry.includes('provider.resolve') && entry.includes('nope')), true);
  } finally {
    captured.restore();
  }
});

test('provider availability is reported per provider without leaking config', async () => {
  const registry = createProviderRegistry({ fetchImpl: async () => ({ ok: true }) });
  const list = await registry.list(FAIRY_VOICE_SETTINGS_DEFAULTS);
  assert.deepEqual(list.map((entry) => entry.id), ['local-sovits', 'openai', 'browser', 'custom-http']);
  assert.deepEqual(list[0], { id: 'local-sovits', available: true });
  assert.deepEqual(list[1], { id: 'openai', available: false, reason: '未配置 OpenAI API Key。' });
  assert.deepEqual(list[2], { id: 'browser', available: true });
  assert.deepEqual(list[3], { id: 'custom-http', available: false, reason: '未配置自定义语音服务地址。' });

  const unreachable = createProviderRegistry({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(await unreachable.list(FAIRY_VOICE_SETTINGS_DEFAULTS), [
    { id: 'local-sovits', available: false, reason: '本地 Fairy 服务未启动。' },
    { id: 'openai', available: false, reason: '未配置 OpenAI API Key。' },
    { id: 'browser', available: true },
    { id: 'custom-http', available: false, reason: '未配置自定义语音服务地址。' },
  ]);
});

test('a provider that never answers is reported unavailable within the 3s probe budget', async () => {
  const registry = createProviderRegistry({ fetchImpl: () => new Promise(() => {}) });
  const started = Date.now();
  const [local] = await registry.list(FAIRY_VOICE_SETTINGS_DEFAULTS);
  assert.equal(local.available, false);
  assert.ok(Date.now() - started < 6_000, 'probe must be bounded');
});

test('openai provider sends the documented /audio/speech request', async () => {
  let captured;
  const provider = createOpenAiProvider({
    fetchImpl: async (url, options) => { captured = { url, options }; return pcmResponse('audio/pcm'); },
  });
  const stream = await provider.stream('你好。', { baseURL: 'https://api.example.com/v1/', apiKey: 'sk-live-1234567890', model: 'gpt-4o-mini-tts', voice: 'nova' }, { signal: new AbortController().signal });
  assert.equal(captured.url, 'https://api.example.com/v1/audio/speech');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer sk-live-1234567890');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), { model: 'gpt-4o-mini-tts', voice: 'nova', input: '你好。', response_format: 'pcm' });
  assert.equal(stream.response.ok, true);
  assert.equal(stream.sampleRate, 24_000);
  assert.deepEqual(provider.available({ apiKey: '' }), { available: false, reason: '未配置 OpenAI API Key。' });
  assert.deepEqual(provider.available({ apiKey: 'sk-live-1234567890' }), { available: true, reason: null });
});

test('custom-http provider interpolates the template and sends only static headers', async () => {
  const template = '{"input":"{{text}}","voice":"fairy"}';
  assert.equal(renderCustomBody(template, '他说“你好”'), '{"input":"他说“你好”","voice":"fairy"}');
  assert.equal(JSON.parse(renderCustomBody(template, 'a"b\\c')).input, 'a"b\\c');
  assert.equal(renderCustomBody('text={{text}}&x={{text}}', 'A B'), 'text=A B&x=A B');
  assert.deepEqual(parseStaticHeaders('{"X-Static":"1","Bad":"a\\r\\nb","Num":3}'), { 'X-Static': '1' });
  assert.throws(() => parseStaticHeaders('{oops'), /请求头/);

  let captured;
  const provider = createCustomHttpProvider({
    fetchImpl: async (url, options) => { captured = { url, options }; return pcmResponse('audio/wav'); },
  });
  const stream = await provider.stream('一段话', {
    url: 'http://127.0.0.1:9100/speak',
    method: 'put',
    headersJson: '{"X-Voice":"fairy"}',
    bodyTemplate: '{"text":"{{text}}"}',
  }, { signal: new AbortController().signal });
  assert.equal(captured.url, 'http://127.0.0.1:9100/speak');
  assert.equal(captured.options.method, 'PUT');
  assert.equal(captured.options.headers['X-Voice'], 'fairy');
  assert.equal(captured.options.body, '{"text":"一段话"}');
  assert.equal(stream.response.ok, true);
  assert.equal(stream.sampleRate, null);
  assert.deepEqual(provider.available({ url: 'not-a-url' }), { available: false, reason: '自定义语音服务地址无效。' });
});

test('browser provider marks synthesis as client-side', async () => {
  const handlers = createFairyVoiceHandlers({
    settings: (() => {
      const boundary = createVoiceSettingsBoundary();
      boundary.write({ provider: 'browser' });
      return boundary;
    })(),
  });
  const response = responseDouble();
  await handlers.tts(requestWithJson({ text: '浏览器朗读。' }), response);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.payload), { error: { code: 'client-side', message: '浏览器端朗读' } });
});

test('status reports the active provider alongside availability', async () => {
  const settings = createVoiceSettingsBoundary();
  await settings.write({ provider: 'openai', providers: { openai: { apiKey: 'sk-live-1234567890' } } });
  const handlers = createFairyVoiceHandlers({ settings, fetchImpl: async () => ({ ok: true }) });
  const response = responseDouble();
  await handlers.status({}, response);
  assert.deepEqual(JSON.parse(response.payload), { available: true, reason: null, provider: 'openai' });

  const local = createFairyVoiceHandlers({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  const localResponse = responseDouble();
  await local.status({}, localResponse);
  assert.deepEqual(JSON.parse(localResponse.payload), { available: false, reason: '本地 Fairy 服务未启动。', provider: 'local-sovits' });
});

test('tts announces a non-native sample rate for remote providers', async () => {
  const settings = createVoiceSettingsBoundary();
  await settings.write({ provider: 'openai', providers: { openai: { apiKey: 'sk-live-1234567890' } } });
  const handlers = createFairyVoiceHandlers({ settings, fetchImpl: async () => pcmResponse('audio/pcm') });
  const response = responseDouble();
  await handlers.tts(requestWithJson({ text: '测试。' }), response);
  assert.equal(response.headers['x-fairy-sample-rate'], '24000');
  assert.equal(response.headers['content-type'], 'audio/pcm');
});

test('provider config reads and writes stay sanitized and never clobber a stored key', async () => {
  const settings = createVoiceSettingsBoundary();
  const handlers = createFairyVoiceHandlers({ settings, fetchImpl: async () => ({ ok: true }) });
  const write = responseDouble();
  await handlers.providerConfig(requestWithJson({
    provider: 'openai',
    providers: { openai: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-live-1234567890', model: 'tts-1-hd' } },
  }), write);
  assert.equal(write.statusCode, 200);
  assert.equal(write.payload.includes('sk-live-1234567890'), false);
  assert.deepEqual(JSON.parse(write.payload), {
    provider: 'openai',
    providers: {
      localSovits: FAIRY_VOICE_SETTINGS_DEFAULTS.providers.localSovits,
      openai: { baseURL: 'https://api.example.com/v1', apiKey: '***', model: 'tts-1-hd', voice: 'alloy' },
      customHttp: FAIRY_VOICE_SETTINGS_DEFAULTS.providers.customHttp,
    },
  });

  // A masked field means "unchanged"; an empty value means "clear".
  const masked = responseDouble();
  await handlers.providerConfig(requestWithJson({ providers: { openai: { apiKey: '***', voice: 'nova' } } }), masked);
  const stored = JSON.parse(masked.payload).providers.openai;
  assert.equal(stored.apiKey, '***');
  assert.equal(stored.voice, 'nova');
  assert.equal(settings.read().providers.openai.apiKey, 'sk-live-1234567890');

  const cleared = responseDouble();
  await handlers.providerConfig(requestWithJson({ providers: { openai: { apiKey: '' } } }), cleared);
  assert.equal(settings.read().providers.openai.apiKey, '');
  assert.equal(settings.read().providers.openai.model, 'tts-1-hd');

  const unknown = responseDouble();
  await handlers.providerConfig(requestWithJson({ provider: 'bogus' }), unknown);
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(JSON.parse(unknown.payload), { error: { code: 'provider-unknown', message: '未知的语音提供方。' } });
});

test('provider config lists every provider availability entry for the settings card', async () => {
  const handlers = createFairyVoiceHandlers({ fetchImpl: async () => ({ ok: true }) });
  const response = responseDouble();
  await handlers.providers({}, response);
  assert.deepEqual(JSON.parse(response.payload).map((entry) => entry.id), ['local-sovits', 'openai', 'browser', 'custom-http']);
});

test('persona voice bindings write provider settings without importing the voice schema', () => {
  assert.deepEqual(personaVoicePatch({ provider: 'openai', config: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-live-1234567890', model: 'tts-1', voice: 'nova' } }), {
    provider: 'openai',
    providers: { openai: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-live-1234567890', model: 'tts-1', voice: 'nova' } },
  });
  assert.deepEqual(personaVoicePatch({ provider: 'browser', config: {} }), { provider: 'browser' });
  assert.deepEqual(personaVoicePatch({ provider: 'local-sovits', config: { baseURL: 'http://127.0.0.1:9999', unknown: 'ignored', apiKey: '' } }), {
    provider: 'local-sovits',
    providers: { localSovits: { baseURL: 'http://127.0.0.1:9999' } },
  });
  assert.equal(personaVoicePatch(null), null);
  assert.equal(personaVoicePatch({ provider: 'nope', config: {} }), null);
});

test('persona changes reach the registered namespace through the plugin event', async () => {
  const { apply } = await import('../lib/index.js');
  const routes = new Map();
  const listeners = new Map();
  const cleanups = [];
  let stored = structuredClone(FAIRY_VOICE_SETTINGS_DEFAULTS);
  const scope = {
    get: () => stored,
    update: async (patch) => {
      stored = patch.providers
        ? { ...stored, ...patch, providers: { ...stored.providers, ...patch.providers } }
        : { ...stored, ...patch };
      return stored;
    },
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
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event); },
  };
  apply(context);
  assert.equal(typeof routes.get('/fairy-voice/provider-config'), 'function');

  await listeners.get('fairy-persona/change')({ packId: 'fairy', voice: { provider: 'openai', config: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-live-1234567890' } } });
  assert.equal(stored.provider, 'openai');
  assert.equal(stored.providers.openai.apiKey, 'sk-live-1234567890');

  // A pack without a voice block must leave the binding untouched.
  await listeners.get('fairy-persona/change')({ packId: 'plain', voice: null });
  assert.equal(stored.provider, 'openai');

  const read = responseDouble();
  routes.get('/fairy-voice/provider-config')({ method: 'GET' }, read);
  assert.equal(read.payload.includes('sk-live-1234567890'), false);
  assert.equal(JSON.parse(read.payload).providers.openai.apiKey, '***');
  cleanups.forEach((cleanup) => cleanup?.());
});

test('local provider reads the configured reference transcript once per path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fairy-voice-reference-'));
  let captured;
  const provider = createLocalSovitsProvider({
    fetchImpl: async (_url, options) => { captured = options; return { ok: true, status: 200 }; },
  });
  try {
    await provider.stream('测试。', {
      baseURL: 'http://127.0.0.1:9880',
      referenceAudioPath: join(directory, 'ref.wav'),
      referencePromptPath: join(directory, 'missing.txt'),
    }, { signal: new AbortController().signal });
    assert.equal(JSON.parse(captured.body).prompt_text, REFERENCE_PROMPT_FALLBACK);
    assert.equal(JSON.parse(captured.body).ref_audio_path, join(directory, 'ref.wav'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
