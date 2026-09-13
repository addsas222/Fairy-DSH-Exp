/* Provider registry: one settings-driven resolver plus a bounded availability
 * probe per provider. Settings ownership stays with the host plugin. */
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { BROWSER_ID, browserProvider } from './browser.js';
import { CUSTOM_HTTP_DEFAULTS, CUSTOM_HTTP_ID, createCustomHttpProvider } from './custom-http.js';
import { LOCAL_SOVITS_DEFAULTS, LOCAL_SOVITS_ID, createLocalSovitsProvider } from './local-sovits.js';
import { OPENAI_DEFAULTS, OPENAI_ID, createOpenAiProvider } from './openai.js';

const diagnostics = createFairyDiagnostics('dsh-fairy-voice');

export const PROVIDER_IDS = [LOCAL_SOVITS_ID, OPENAI_ID, BROWSER_ID, CUSTOM_HTTP_ID];
const PROVIDER_CONFIG_KEYS = {
  [LOCAL_SOVITS_ID]: 'localSovits',
  [OPENAI_ID]: 'openai',
  [CUSTOM_HTTP_ID]: 'customHttp',
};
export const PROVIDER_CONFIG_DEFAULTS = {
  localSovits: LOCAL_SOVITS_DEFAULTS,
  openai: OPENAI_DEFAULTS,
  customHttp: CUSTOM_HTTP_DEFAULTS,
};
export const PROVIDER_CONFIG_FIELDS = {
  localSovits: ['baseURL', 'referenceAudioPath', 'referencePromptPath'],
  openai: ['baseURL', 'apiKey', 'model', 'voice'],
  customHttp: ['url', 'method', 'headersJson', 'bodyTemplate'],
};
const AVAILABILITY_TIMEOUT_MS = 3_000;

function configForProvider(id, settingsValue) {
  const key = PROVIDER_CONFIG_KEYS[id];
  if (!key) return {};
  return { ...PROVIDER_CONFIG_DEFAULTS[key], ...(settingsValue?.providers?.[key] || {}) };
}

/** The provider settings section a voice binding writes into, or null for providers without one. */
export function configKeyForProvider(id) {
  return PROVIDER_CONFIG_KEYS[id] || null;
}

export function createProviderRegistry({ fetchImpl = fetch, availabilityTimeoutMs = AVAILABILITY_TIMEOUT_MS } = {}) {
  const PROVIDERS = new Map([
    [LOCAL_SOVITS_ID, createLocalSovitsProvider({ fetchImpl })],
    [OPENAI_ID, createOpenAiProvider({ fetchImpl })],
    [CUSTOM_HTTP_ID, createCustomHttpProvider({ fetchImpl })],
    [BROWSER_ID, browserProvider],
  ]);

  const check = (id, settingsValue, signal) => {
    const provider = PROVIDERS.get(id);
    if (!provider) return Promise.resolve({ id, available: false, reason: '未知的语音提供方。' });
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
    /** Unknown or absent ids fall back to GPT-SoVITS with a diagnostic. */
    resolve(settingsValue) {
      const requested = typeof settingsValue?.provider === 'string' && settingsValue.provider ? settingsValue.provider : LOCAL_SOVITS_ID;
      const provider = PROVIDERS.get(requested);
      if (!provider) {
        diagnostics.warn('provider.resolve', { provider: requested, fallback: LOCAL_SOVITS_ID });
        return { id: LOCAL_SOVITS_ID, provider: PROVIDERS.get(LOCAL_SOVITS_ID), config: configForProvider(LOCAL_SOVITS_ID, settingsValue) };
      }
      return { id: requested, provider, config: configForProvider(requested, settingsValue) };
    },
    check,
    list(settingsValue, { signal } = {}) {
      return Promise.all(PROVIDER_IDS.map((id) => check(id, settingsValue, signal)));
    },
  };
}
