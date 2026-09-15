/* TTS provider registry: ids, config tables and settings paths; the resolver
 * and the bounded availability probe are shared with STT in ./registry.js. */
import { BROWSER_ID, browserProvider } from './browser.js';
import { POCKET_TTS_DEFAULTS, POCKET_TTS_ID, createPocketTtsProvider } from './pocket-tts.js';
import { KITTEN_WEB_DEFAULTS, KITTEN_WEB_ID, KOKORO_WEB_DEFAULTS, KOKORO_WEB_ID, PIPER_WEB_DEFAULTS, PIPER_WEB_ID, kokoroWebProvider, kittenWebProvider, piperWebProvider } from './client-engines.js';
import { CUSTOM_HTTP_DEFAULTS, CUSTOM_HTTP_ID, createCustomHttpProvider } from './custom-http.js';
import { ELEVENLABS_WS_DEFAULTS, ELEVENLABS_WS_ID, createElevenLabsWsProvider } from './elevenlabs-ws.js';
import { LOCAL_SOVITS_DEFAULTS, LOCAL_SOVITS_ID, createLocalSovitsProvider } from './local-sovits.js';
import { OPENAI_DEFAULTS, OPENAI_ID, createOpenAiProvider } from './openai.js';
import { createAvailabilityRegistry } from './registry.js';

export const PROVIDER_IDS = [
  LOCAL_SOVITS_ID,
  OPENAI_ID,
  ELEVENLABS_WS_ID,
  KOKORO_WEB_ID,
  KITTEN_WEB_ID,
  PIPER_WEB_ID,
  BROWSER_ID,
  CUSTOM_HTTP_ID,
  POCKET_TTS_ID,
];
const PROVIDER_CONFIG_KEYS = {
  [LOCAL_SOVITS_ID]: 'localSovits',
  [OPENAI_ID]: 'openai',
  [ELEVENLABS_WS_ID]: 'elevenlabsWs',
  [KOKORO_WEB_ID]: 'kokoroWeb',
  [KITTEN_WEB_ID]: 'kittenWeb',
  [PIPER_WEB_ID]: 'piperWeb',
  [CUSTOM_HTTP_ID]: 'customHttp',
  [POCKET_TTS_ID]: 'pocketTts',
};
export const PROVIDER_CONFIG_DEFAULTS = {
  localSovits: LOCAL_SOVITS_DEFAULTS,
  openai: OPENAI_DEFAULTS,
  elevenlabsWs: ELEVENLABS_WS_DEFAULTS,
  kokoroWeb: KOKORO_WEB_DEFAULTS,
  kittenWeb: KITTEN_WEB_DEFAULTS,
  piperWeb: PIPER_WEB_DEFAULTS,
  customHttp: CUSTOM_HTTP_DEFAULTS,
  pocketTts: POCKET_TTS_DEFAULTS,
};
export const PROVIDER_CONFIG_FIELDS = {
  localSovits: ['baseURL', 'referenceAudioPath', 'referencePromptPath'],
  openai: ['baseURL', 'apiKey', 'model', 'voice'],
  elevenlabsWs: ['baseUrl', 'apiKey', 'voiceId', 'modelId', 'outputFormat'],
  kokoroWeb: ['moduleUrl', 'modelId', 'dtype', 'device', 'voice', 'resourceBase'],
  kittenWeb: ['moduleUrl', 'modelId', 'voice', 'resourceBase'],
  piperWeb: ['moduleUrl', 'voiceId', 'resourceBase'],
  customHttp: ['url', 'method', 'headersJson', 'bodyTemplate'],
  pocketTts: ['baseUrl', 'voice'],
};

function configForProvider(id, settingsValue) {
  const key = PROVIDER_CONFIG_KEYS[id];
  if (!key) return {};
  return { ...PROVIDER_CONFIG_DEFAULTS[key], ...(settingsValue?.providers?.[key] || {}) };
}

/** The provider settings section a voice binding writes into, or null for providers without one. */
export function configKeyForProvider(id) {
  return PROVIDER_CONFIG_KEYS[id] || null;
}

export function createProviderRegistry({ fetchImpl = fetch, availabilityTimeoutMs, WebSocketImpl } = {}) {
  return createAvailabilityRegistry({
    ids: PROVIDER_IDS,
    providers: new Map([
      [LOCAL_SOVITS_ID, createLocalSovitsProvider({ fetchImpl })],
      [OPENAI_ID, createOpenAiProvider({ fetchImpl })],
      [ELEVENLABS_WS_ID, createElevenLabsWsProvider({ WebSocketImpl })],
      [KOKORO_WEB_ID, kokoroWebProvider],
      [KITTEN_WEB_ID, kittenWebProvider],
      [PIPER_WEB_ID, piperWebProvider],
      [CUSTOM_HTTP_ID, createCustomHttpProvider({ fetchImpl })],
      [POCKET_TTS_ID, createPocketTtsProvider({ fetchImpl })],
      [BROWSER_ID, browserProvider],
    ]),
    configFor: configForProvider,
    requestedOf: (settingsValue) => (typeof settingsValue?.provider === 'string' && settingsValue.provider ? settingsValue.provider : LOCAL_SOVITS_ID),
    fallbackId: LOCAL_SOVITS_ID,
    unknownReason: '未知的语音提供方。',
    warnOperation: 'provider.resolve',
    availabilityTimeoutMs,
  });
}
