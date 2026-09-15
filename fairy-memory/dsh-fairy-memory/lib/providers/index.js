/* Provider registry: one settings-driven resolver plus an availability answer
 * per provider. GBrain is the primary engine; mem0 and a custom HTTP endpoint
 * are the backups; the local markdown store is always available so the feature
 * never depends on a running service. */
import { CUSTOM_HTTP_DEFAULTS, CUSTOM_HTTP_ID, createCustomHttpProvider } from './custom-http.js';
import { GBRAIN_DEFAULTS, GBRAIN_ID, createGbrainProvider } from './gbrain.js';
import { LOCAL_MARKDOWN_DEFAULTS, LOCAL_MARKDOWN_ID, createLocalMarkdownProvider } from './local-markdown.js';
import { MEM0_DEFAULTS, MEM0_ID, createMem0Provider } from './mem0.js';

export const MEMORY_PROVIDER_IDS = [GBRAIN_ID, MEM0_ID, CUSTOM_HTTP_ID, LOCAL_MARKDOWN_ID];

const CONFIG_KEYS = {
  [GBRAIN_ID]: 'gbrain',
  [MEM0_ID]: 'mem0',
  [CUSTOM_HTTP_ID]: 'customHttp',
  [LOCAL_MARKDOWN_ID]: 'localMarkdown',
};

export const MEMORY_PROVIDER_DEFAULTS = Object.freeze({
  gbrain: GBRAIN_DEFAULTS,
  mem0: MEM0_DEFAULTS,
  customHttp: CUSTOM_HTTP_DEFAULTS,
  localMarkdown: LOCAL_MARKDOWN_DEFAULTS,
});

/** Which settings keys each provider owns; the schema and the card agree here. */
export const MEMORY_PROVIDER_FIELDS = Object.freeze({
  gbrain: Object.freeze(['baseUrl', 'token', 'surface', 'visibility']),
  mem0: Object.freeze(['baseUrl', 'apiKey', 'userId']),
  customHttp: Object.freeze(['url', 'headersJson', 'queryPath', 'textPath']),
  localMarkdown: Object.freeze(['directory']),
});

/** Secret fields never leave the host: the card shows `***` and writes it back. */
export const MEMORY_SECRET_FIELDS = Object.freeze({ gbrain: Object.freeze(['token']), mem0: Object.freeze(['apiKey']) });

function configFor(id, settingsValue) {
  const key = CONFIG_KEYS[id];
  if (!key) return {};
  return { ...MEMORY_PROVIDER_DEFAULTS[key], ...(settingsValue?.providers?.[key] || {}) };
}

export function createMemoryRegistry({ fetchImpl = fetch } = {}) {
  const providers = new Map([
    [GBRAIN_ID, createGbrainProvider({ fetchImpl })],
    [MEM0_ID, createMem0Provider({ fetchImpl })],
    [CUSTOM_HTTP_ID, createCustomHttpProvider({ fetchImpl })],
    [LOCAL_MARKDOWN_ID, createLocalMarkdownProvider({ fetchImpl })],
  ]);

  /** A service provider with no endpoint is not usable; the local store always
   *  is. The fallback is reported, never silent, so the card can say why. */
  const isConfigured = (id, settingsValue) => {
    const config = configFor(id, settingsValue);
    if (id === CUSTOM_HTTP_ID) return Boolean(String(config.url || '').trim());
    return Boolean(String(config.baseUrl || '').trim());
  };

  const resolve = (settingsValue) => {
    const requested = typeof settingsValue?.provider === 'string' && settingsValue.provider ? settingsValue.provider : GBRAIN_ID;
    let id = providers.has(requested) ? requested : LOCAL_MARKDOWN_ID;
    let fallbackReason = id !== requested ? '未知的提供方，已改用本地 markdown 记忆。' : null;
    if (id !== LOCAL_MARKDOWN_ID && !isConfigured(id, settingsValue)) {
      fallbackReason = `${id} 尚未配置服务地址，本次使用本地 markdown 记忆。`;
      id = LOCAL_MARKDOWN_ID;
    }
    const provider = providers.get(id);
    return { id, provider, config: configFor(id, settingsValue), fallback: fallbackReason !== null, fallbackReason, requested };
  };

  const list = async (settingsValue) => {
    const entries = [];
    for (const id of MEMORY_PROVIDER_IDS) {
      const provider = providers.get(id);
      const answer = await provider.available(configFor(id, settingsValue));
      entries.push({ id, available: answer?.available === true, reason: answer?.reason ?? null });
    }
    return entries;
  };

  return { resolve, list };
}
