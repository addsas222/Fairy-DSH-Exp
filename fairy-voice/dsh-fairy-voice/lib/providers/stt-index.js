/* STT provider registry: one settings-driven resolver plus a bounded
 * availability probe per provider, mirroring the TTS registry shape. */
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { BROWSER_STT_ID, STT_BROWSER_DEFAULTS, browserSttProvider } from './stt-browser.js';
import { CUSTOM_HTTP_STT_ID, STT_CUSTOM_HTTP_DEFAULTS, createCustomSttProvider } from './stt-custom.js';
import { OPENAI_STT_ID, STT_OPENAI_DEFAULTS, createOpenAiSttProvider } from './stt-openai.js';

const diagnostics = createFairyDiagnostics('dsh-fairy-voice');

export const STT_PROVIDER_IDS = [BROWSER_STT_ID, OPENAI_STT_ID, CUSTOM_HTTP_STT_ID];

const STT_CONFIG_KEYS = {
  [BROWSER_STT_ID]: 'browser',
  [OPENAI_STT_ID]: 'openai',
  [CUSTOM_HTTP_STT_ID]: 'customHttp',
};

export const STT_CONFIG_DEFAULTS = {
  browser: STT_BROWSER_DEFAULTS,
  openai: STT_OPENAI_DEFAULTS,
  customHttp: STT_CUSTOM_HTTP_DEFAULTS,
};

/** Writable `stt.providers.<key>` field names, used by the settings patch. */
export const STT_PROVIDER_CONFIG_FIELDS = {
  browser: ['lang'],
  openai: ['baseURL', 'apiKey', 'model', 'language'],
  customHttp: ['url', 'headersJson', 'responsePath'],
};

export const STT_DEFAULTS = Object.freeze({
  provider: BROWSER_STT_ID,
  providers: Object.freeze({
    browser: STT_BROWSER_DEFAULTS,
    openai: STT_OPENAI_DEFAULTS,
    customHttp: STT_CUSTOM_HTTP_DEFAULTS,
  }),
});

const AVAILABILITY_TIMEOUT_MS = 3_000;

function configForProvider(id, settingsValue) {
  const key = STT_CONFIG_KEYS[id];
  if (!key) return {};
  return { ...STT_CONFIG_DEFAULTS[key], ...(settingsValue?.stt?.providers?.[key] || {}) };
}

export function createSttRegistry({
  fetchImpl = fetch,
  availabilityTimeoutMs = AVAILABILITY_TIMEOUT_MS,
} = {}) {
  const PROVIDERS = new Map([
    [BROWSER_STT_ID, browserSttProvider],
    [OPENAI_STT_ID, createOpenAiSttProvider({ fetchImpl })],
    [CUSTOM_HTTP_STT_ID, createCustomSttProvider({ fetchImpl })],
  ]);

  const check = (id, settingsValue, signal) => {
    const provider = PROVIDERS.get(id);
    if (!provider) return Promise.resolve({ id, available: false, reason: '未知的语音识别提供方。' });
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason || 'client-aborted');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    // The probe budget is a hard bound: a provider that ignores its signal
    // must not be able to hold the settings card open.
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort('timeout');
        resolve({ id, available: false, reason: '检查超时。' });
      }, availabilityTimeoutMs);
    });
    const probe = (async () => {
      try {
        const result = await provider.available(configForProvider(id, settingsValue), { signal: controller.signal });
        if (result?.available === true) return { id, available: true };
        return { id, available: false, reason: String(result?.reason || '不可用。') };
      } catch (error) {
        if (controller.signal.aborted) return { id, available: false, reason: '检查超时。' };
        return { id, available: false, reason: String(error?.message || '不可用。') };
      }
    })();
    return Promise.race([probe, expired]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  };

  return {
    PROVIDERS,
    /** Unknown or absent ids fall back to browser recognition with a diagnostic. */
    resolve(settingsValue) {
      const requested = typeof settingsValue?.stt?.provider === 'string' && settingsValue.stt.provider
        ? settingsValue.stt.provider
        : BROWSER_STT_ID;
      const provider = PROVIDERS.get(requested);
      if (!provider) {
        diagnostics.warn('stt.resolve', { provider: requested, fallback: BROWSER_STT_ID });
        return { id: BROWSER_STT_ID, provider: PROVIDERS.get(BROWSER_STT_ID), config: configForProvider(BROWSER_STT_ID, settingsValue) };
      }
      return { id: requested, provider, config: configForProvider(requested, settingsValue) };
    },
    check,
    list(settingsValue, { signal } = {}) {
      return Promise.all(STT_PROVIDER_IDS.map((id) => check(id, settingsValue, signal)));
    },
  };
}
