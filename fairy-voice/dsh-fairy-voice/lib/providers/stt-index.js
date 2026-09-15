/* STT provider registry: ids, config tables and settings paths; the resolver
 * and the bounded availability probe are shared with TTS in ./registry.js. */
import { AZURE_STT_ID, STT_AZURE_DEFAULTS, createAzureSttProvider } from './stt-azure.js';
import { BROWSER_STT_ID, STT_BROWSER_DEFAULTS, browserSttProvider } from './stt-browser.js';
import { CUSTOM_HTTP_STT_ID, STT_CUSTOM_HTTP_DEFAULTS, createCustomSttProvider } from './stt-custom.js';
import { DEEPGRAM_STT_ID, STT_DEEPGRAM_DEFAULTS, createDeepgramSttProvider } from './stt-deepgram.js';
import { OPENAI_STT_ID, STT_OPENAI_DEFAULTS, createOpenAiSttProvider } from './stt-openai.js';
import { STT_WHISPER_WEB_DEFAULTS, WHISPER_WEB_STT_ID, whisperWebSttProvider } from './stt-whisper-web.js';
import { createAvailabilityRegistry } from './registry.js';

/* Client-side markers come first, then the host-side adapters: browser and
 * whisper-web both answer 409 because the audio never leaves the page. */
export const STT_PROVIDER_IDS = [
  BROWSER_STT_ID,
  WHISPER_WEB_STT_ID,
  OPENAI_STT_ID,
  DEEPGRAM_STT_ID,
  AZURE_STT_ID,
  CUSTOM_HTTP_STT_ID,
];

const STT_CONFIG_KEYS = {
  [BROWSER_STT_ID]: 'browser',
  [WHISPER_WEB_STT_ID]: 'whisperWeb',
  [OPENAI_STT_ID]: 'openai',
  [DEEPGRAM_STT_ID]: 'deepgram',
  [AZURE_STT_ID]: 'azure',
  [CUSTOM_HTTP_STT_ID]: 'customHttp',
};

/** Writable `stt.providers.<key>` field names, used by the settings patch. */
export const STT_PROVIDER_CONFIG_FIELDS = {
  browser: ['lang'],
  whisperWeb: ['moduleUrl', 'modelId', 'device', 'dtype', 'language', 'resourceBase'],
  openai: ['baseURL', 'apiKey', 'model', 'language'],
  deepgram: ['baseUrl', 'apiKey', 'model', 'language'],
  azure: ['endpoint', 'apiKey', 'locale'],
  customHttp: ['url', 'headersJson', 'responsePath'],
};

export const STT_DEFAULTS = Object.freeze({
  provider: BROWSER_STT_ID,
  providers: Object.freeze({
    browser: STT_BROWSER_DEFAULTS,
    whisperWeb: STT_WHISPER_WEB_DEFAULTS,
    openai: STT_OPENAI_DEFAULTS,
    deepgram: STT_DEEPGRAM_DEFAULTS,
    azure: STT_AZURE_DEFAULTS,
    customHttp: STT_CUSTOM_HTTP_DEFAULTS,
  }),
});

function configForProvider(id, settingsValue) {
  const key = STT_CONFIG_KEYS[id];
  if (!key) return {};
  return { ...STT_DEFAULTS.providers[key], ...(settingsValue?.stt?.providers?.[key] || {}) };
}

export function createSttRegistry({ fetchImpl = fetch, availabilityTimeoutMs } = {}) {
  return createAvailabilityRegistry({
    ids: STT_PROVIDER_IDS,
    providers: new Map([
      [BROWSER_STT_ID, browserSttProvider],
      [WHISPER_WEB_STT_ID, whisperWebSttProvider],
      [OPENAI_STT_ID, createOpenAiSttProvider({ fetchImpl })],
      [DEEPGRAM_STT_ID, createDeepgramSttProvider({ fetchImpl })],
      [AZURE_STT_ID, createAzureSttProvider({ fetchImpl })],
      [CUSTOM_HTTP_STT_ID, createCustomSttProvider({ fetchImpl })],
    ]),
    configFor: configForProvider,
    requestedOf: (settingsValue) => (typeof settingsValue?.stt?.provider === 'string' && settingsValue.stt.provider ? settingsValue.stt.provider : BROWSER_STT_ID),
    fallbackId: BROWSER_STT_ID,
    unknownReason: '未知的语音识别提供方。',
    warnOperation: 'stt.resolve',
    availabilityTimeoutMs,
  });
}
