/* Custom HTTP adapter - the escape hatch for every engine that is not gbrain or
 * mem0 (Letta, Zep, a home-grown service, an internal gateway). One URL plus
 * static headers, with dot paths naming where the list and its text live. */
import { PROVIDER_FAILED, providerError, requestJson, trimBaseUrl } from './http.js';

export const CUSTOM_HTTP_ID = 'custom-http';

export const CUSTOM_HTTP_DEFAULTS = Object.freeze({
  url: '',
  headersJson: '{}',
  queryPath: 'results',
  textPath: 'text',
});

function resolveConfig(config = {}) {
  return { ...CUSTOM_HTTP_DEFAULTS, ...config };
}

/** Static headers only: a raw header value is the one place a CR/LF would let a
 * settings value forge extra headers, so it is rejected at parse time. */
export function parseHeaders(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw providerError(PROVIDER_FAILED, '静态请求头不是合法 JSON。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerError(PROVIDER_FAILED, '静态请求头必须是对象。');
  const headers = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || /[\r\n\0]/.test(entry) || /[\r\n\0]/.test(name)) {
      throw providerError(PROVIDER_FAILED, '静态请求头只能是不含换行的字符串。');
    }
    headers[name] = entry;
  }
  return headers;
}

function alongPath(value, path) {
  let current = value;
  for (const key of String(path || '').split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

export function createCustomHttpProvider({ fetchImpl = fetch } = {}) {
  const endpoint = (config) => {
    const url = trimBaseUrl(resolveConfig(config).url);
    if (!url) throw providerError(PROVIDER_FAILED, '未配置自定义记忆服务地址。');
    return url;
  };

  return {
    id: CUSTOM_HTTP_ID,
    available(config) {
      const value = resolveConfig(config);
      if (!trimBaseUrl(value.url)) return { available: false, reason: '未配置自定义记忆服务地址。' };
      try {
        parseHeaders(value.headersJson);
      } catch (error) {
        return { available: false, reason: error.message };
      }
      return { available: true, reason: null };
    },
    async remember({ text, tags = [], source = 'manual' }, config, signal) {
      const value = String(text || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可写入的记忆内容。');
      const settings = resolveConfig(config);
      const payload = await requestJson(fetchImpl, endpoint(config), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...parseHeaders(settings.headersJson) },
        body: JSON.stringify({ action: 'remember', text: value, tags, source }),
      }, signal);
      const id = payload?.id ?? payload?.path ?? payload?.slug ?? null;
      return { id: typeof id === 'string' ? id : null, raw: payload };
    },
    async recall({ query, limit = 6 }, config, signal) {
      const value = String(query || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可检索的查询词。');
      const settings = resolveConfig(config);
      const payload = await requestJson(fetchImpl, endpoint(config), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...parseHeaders(settings.headersJson) },
        body: JSON.stringify({ action: 'recall', query: value, limit }),
      }, signal);
      const found = alongPath(payload, settings.queryPath);
      const rows = Array.isArray(found) ? found : Array.isArray(payload) ? payload : [];
      const results = rows.map((row) => {
        const text = typeof row === 'string' ? row : alongPath(row, settings.textPath);
        return {
          text: String(text ?? '').trim(),
          source: alongPath(row, 'source') ?? alongPath(row, 'id') ?? null,
          score: Number.isFinite(alongPath(row, 'score')) ? alongPath(row, 'score') : null,
          updatedAt: alongPath(row, 'updatedAt') ?? null,
        };
      }).filter((row) => row.text);
      return { results, ...(results.length === 0 ? { note: `没有在 \`${settings.queryPath}\` 找到结果。` } : {}) };
    },
  };
}
