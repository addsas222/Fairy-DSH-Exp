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
import { KITTEN_WEB_DEFAULTS } from '../lib/providers/client-engines.js';
import { createProviderRegistry } from '../lib/providers/index.js';
import { KOKORO_WEB_DEFAULTS, PIPER_WEB_DEFAULTS } from '../lib/providers/client-engines.js';
import { ELEVENLABS_WS_DEFAULTS, createElevenLabsWsProvider } from '../lib/providers/elevenlabs-ws.js';

/** Minimal WebSocket double: tests drive open/message/error/close explicitly. */
class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.({});
  }

  open() {
    this.onopen?.({});
  }

  message(data) {
    this.onmessage?.({ data });
  }

  fail() {
    this.onerror?.({});
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
  const registry = createProviderRegistry({ fetchImpl: async () => ({ ok: true }), WebSocketImpl: FakeWebSocket });
  const list = await registry.list(FAIRY_VOICE_SETTINGS_DEFAULTS);
  assert.deepEqual(list.map((entry) => entry.id), [
    'local-sovits',
    'openai',
    'elevenlabs-ws',
    'kokoro-web',
    'kitten-web',
    'piper-web',
    'browser',
    'custom-http',
  ]);
  assert.deepEqual(list[0], { id: 'local-sovits', available: true });
  assert.deepEqual(list[1], { id: 'openai', available: false, reason: '未配置 OpenAI API Key。' });
  assert.deepEqual(list[2], { id: 'elevenlabs-ws', available: false, reason: '未配置 ElevenLabs API Key。' });
  // Browser engines answer `ready`: only the browser can judge WebGPU/memory,
  // and their failure path degrades to system speech.
  assert.deepEqual(list[3], { id: 'kokoro-web', available: true });
  assert.deepEqual(list[4], { id: 'kitten-web', available: true });
  assert.deepEqual(list[5], { id: 'piper-web', available: true });
  assert.deepEqual(list[6], { id: 'browser', available: true });
  assert.deepEqual(list[7], { id: 'custom-http', available: false, reason: '未配置自定义语音服务地址。' });

  const unreachable = createProviderRegistry({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, WebSocketImpl: FakeWebSocket });
  assert.deepEqual(await unreachable.list(FAIRY_VOICE_SETTINGS_DEFAULTS), [
    { id: 'local-sovits', available: false, reason: '本地 Fairy 服务未启动。' },
    { id: 'openai', available: false, reason: '未配置 OpenAI API Key。' },
    { id: 'elevenlabs-ws', available: false, reason: '未配置 ElevenLabs API Key。' },
    { id: 'kokoro-web', available: true },
    { id: 'kitten-web', available: true },
    { id: 'piper-web', available: true },
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
      elevenlabsWs: FAIRY_VOICE_SETTINGS_DEFAULTS.providers.elevenlabsWs,
      kokoroWeb: FAIRY_VOICE_SETTINGS_DEFAULTS.providers.kokoroWeb,
      kittenWeb: FAIRY_VOICE_SETTINGS_DEFAULTS.providers.kittenWeb,
      piperWeb: FAIRY_VOICE_SETTINGS_DEFAULTS.providers.piperWeb,
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
  assert.deepEqual(JSON.parse(response.payload).map((entry) => entry.id), [
    'local-sovits',
    'openai',
    'elevenlabs-ws',
    'kokoro-web',
    'kitten-web',
    'piper-web',
    'browser',
    'custom-http',
  ]);
});

test('pocket-tts posts the documented form and strips the RIFF header', async () => {
  // 本仓宿主 TTS 契约是裸 PCM（客户端按 pcmBytesToSamples/schedulePcm 直接播），
  // 而 Pocket TTS 回 WAV：这条用例就是"WAV 头被当采样播成噪声"的防线。
  const { readWavHeader, createPocketTtsProvider } = await import('../lib/providers/pocket-tts.js');
  const wav = new Uint8Array(44 + 8);
  const view = new DataView(wav.buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  write(36, 'data'); view.setUint32(40, 8, true);
  assert.deepEqual(readWavHeader(wav), { sampleRate: 24_000, dataOffset: 44 });
  assert.equal(readWavHeader(new Uint8Array([1, 2, 3, 4])), null);

  const seen = [];
  const provider = createPocketTtsProvider({
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { ok: true, status: 200, headers: { get: () => 'audio/wav' }, async arrayBuffer() { return wav.buffer; }, async text() { return ''; } };
    },
  });
  const answer = await provider.stream('你好', { baseUrl: 'http://127.0.0.1:8000', voice: 'alba' }, {});
  assert.equal(seen[0].url, 'http://127.0.0.1:8000/tts');
  assert.equal(seen[0].options.method, 'POST');
  assert.equal(seen[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([...new URLSearchParams(seen[0].options.body).entries()], [['text', '你好'], ['voice_url', 'alba']]);
  assert.equal(answer.sampleRate, 24_000);
  assert.equal((await answer.response.arrayBuffer()).byteLength, 8);
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

test('browser engine providers answer client-side and keep their configuration', async () => {
  const registry = createProviderRegistry({ fetchImpl: async () => ({ ok: true }) });
  const kokoro = registry.resolve({ provider: 'kokoro-web', providers: { kokoroWeb: { voice: 'af_bella' } } });
  assert.equal(kokoro.id, 'kokoro-web');
  assert.equal(kokoro.config.voice, 'af_bella');
  assert.equal(kokoro.config.modelId, KOKORO_WEB_DEFAULTS.modelId);
  await assert.rejects(
    () => kokoro.provider.stream('hi', kokoro.config, {}),
    (error) => error.code === 'client-side',
  );

  const kitten = registry.resolve({ provider: 'kitten-web', providers: { kittenWeb: { voice: 'Luna' } } });
  assert.equal(kitten.id, 'kitten-web');
  assert.equal(kitten.config.voice, 'Luna');
  assert.equal(kitten.config.modelId, KITTEN_WEB_DEFAULTS.modelId);
  await assert.rejects(
    () => kitten.provider.stream('hi', kitten.config, {}),
    (error) => error.code === 'client-side',
  );

  const piper = registry.resolve({ provider: 'piper-web', providers: { piperWeb: { voiceId: 'zh_CN-huayan-medium' } } });
  assert.equal(piper.config.voiceId, 'zh_CN-huayan-medium');
  assert.equal(piper.config.moduleUrl, PIPER_WEB_DEFAULTS.moduleUrl);
});

test('the /tts route answers 409 for a browser engine provider too', async () => {
  const boundary = createVoiceSettingsBoundary();
  boundary.write({ provider: 'kokoro-web' });
  const handlers = createFairyVoiceHandlers({ settings: boundary });
  const response = responseDouble();
  await handlers.tts(requestWithJson({ text: '浏览器端合成。' }), response);
  assert.equal(response.statusCode, 409);
  // One shared body for the whole client-side family: the browser routes by
  // its own selected engine id, so the message stays generic.
  assert.deepEqual(JSON.parse(response.payload), { error: { code: 'client-side', message: '浏览器端朗读' } });
});

test('elevenlabs-ws settles when the socket never opens', async () => {
  // A refused connection used to leave the open promise pending forever: the
  // request hung, its controller stayed registered, and even abort could not
  // release it. Every path must settle, so race each one against a timer.
  class DeadSocket {
    constructor() {
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      setTimeout(() => { if (this.onerror) this.onerror(new Error('ECONNREFUSED')); }, 5);
    }
    send() {}
    close() { if (this.onclose) this.onclose({}); }
  }
  const provider = createElevenLabsWsProvider({ WebSocketImpl: DeadSocket });
  const outcome = await Promise.race([
    provider.stream('hi', { apiKey: 'k'.repeat(20) }, {}).then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
  ]);
  assert.equal(outcome, 'provider-unavailable');

  // Aborting while the socket is still connecting must settle too.
  class HangingSocket {
    constructor() { this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; }
    send() {}
    close() { if (this.onclose) this.onclose({}); }
  }
  const hanging = createElevenLabsWsProvider({ WebSocketImpl: HangingSocket });
  const controller = new AbortController();
  const aborted = hanging.stream('hi', { apiKey: 'k'.repeat(20) }, { signal: controller.signal });
  abortSoon(controller);
  const abortOutcome = await Promise.race([
    aborted.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 1_000)),
  ]);
  assert.equal(abortOutcome, 'client-aborted');
  assert.ok(hanging);
});

function abortSoon(controller) {
  setTimeout(() => controller.abort('client-aborted'), 5);
}

test('elevenlabs-ws streams base64 frames as PCM over a Response-like body', async () => {
  FakeWebSocket.reset();
  const provider = createElevenLabsWsProvider({ WebSocketImpl: FakeWebSocket });
  const pending = provider.stream('你好，世界', { apiKey: 'xi-test', voiceId: 'voice-1' }, {});
  const socket = FakeWebSocket.last;
  assert.match(socket.url, /^wss:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice-1\/stream-input\?/);
  assert.match(socket.url, /output_format=pcm_32000/);

  socket.open();
  const upstream = await pending;
  assert.equal(upstream.response.ok, true);
  assert.equal(upstream.response.headers.get('content-type'), 'audio/raw');
  assert.equal(upstream.sampleRate, 32_000);
  assert.equal(socket.sent.length, 3);
  const init = JSON.parse(socket.sent[0]);
  assert.equal(init.xi_api_key, 'xi-test');
  assert.equal(init.text, ' ');
  assert.equal(init.voice_settings.stability, 0.5);
  assert.deepEqual(init.generation_config.chunk_length_schedule, [120, 160, 250, 290]);
  assert.deepEqual(JSON.parse(socket.sent[1]), { text: '你好，世界 ', try_trigger_generation: true });
  assert.deepEqual(JSON.parse(socket.sent[2]), { text: '' });

  const chunks = [];
  const drained = (async () => {
    for await (const chunk of upstream.response.body) chunks.push(Buffer.from(chunk));
  })();
  socket.message(JSON.stringify({ audio: Buffer.from([1, 2]).toString('base64') }));
  socket.message(Buffer.from(JSON.stringify({ audio: Buffer.from([3, 4]).toString('base64') })));
  socket.message(JSON.stringify({ isFinal: true }));
  await drained;
  assert.deepEqual(chunks.map((chunk) => [...chunk]), [[1, 2], [3, 4]]);
  assert.equal(socket.closed.code, 1000);

  upstream.release();
});

test('elevenlabs-ws surfaces vendor errors and early closes as provider failures', async () => {
  FakeWebSocket.reset();
  const provider = createElevenLabsWsProvider({ WebSocketImpl: FakeWebSocket });
  const first = provider.stream('hi', { apiKey: 'xi-test', voiceId: 'v' }, {});
  FakeWebSocket.last.open();
  const upstream = await first;
  const failure = (async () => {
    for await (const _chunk of upstream.response.body) { /* drain */ }
  })();
  FakeWebSocket.last.message(JSON.stringify({ error: 'quota exceeded' }));
  await assert.rejects(() => failure, (error) => error.code === 'provider-failed' && /quota exceeded/.test(error.message));

  FakeWebSocket.reset();
  const second = provider.stream('hi', { apiKey: 'xi-test', voiceId: 'v' }, {});
  FakeWebSocket.last.open();
  const secondUpstream = await second;
  const dropped = (async () => {
    for await (const _chunk of secondUpstream.response.body) { /* drain */ }
  })();
  FakeWebSocket.last.close(1006, 'dropped');
  await assert.rejects(() => dropped, (error) => error.code === 'provider-failed');
});

test('elevenlabs-ws refuses to start without a key and closes the socket on abort', async () => {
  FakeWebSocket.reset();
  const provider = createElevenLabsWsProvider({ WebSocketImpl: FakeWebSocket });
  assert.deepEqual(
    provider.available({ ...ELEVENLABS_WS_DEFAULTS, apiKey: '' }),
    { available: false, reason: '未配置 ElevenLabs API Key。' },
  );

  const controller = new AbortController();
  const pending = provider.stream('hi', { apiKey: 'xi-test', voiceId: 'v' }, { signal: controller.signal });
  FakeWebSocket.last.open();
  const upstream = await pending;
  const ended = (async () => {
    for await (const _chunk of upstream.response.body) { /* drain */ }
  })();
  controller.abort('client-aborted');
  await ended;
  assert.equal(FakeWebSocket.last.closed.reason, 'aborted');
});
