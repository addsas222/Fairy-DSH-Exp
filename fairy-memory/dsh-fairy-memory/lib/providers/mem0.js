/* mem0 adapter - the first backup engine. mem0 keeps its own service
 * (`/v1/memories/`), so this is a plain REST client; the parsing is
 * deliberately tolerant (`results`, `memories`, or a bare array) because
 * self-hosted forks ship slightly different envelopes. */
import { PROVIDER_FAILED, providerError, requestJson, trimBaseUrl } from './http.js';

export const MEM0_ID = 'mem0';

export const MEM0_DEFAULTS = Object.freeze({
  baseUrl: 'https://api.mem0.ai',
  apiKey: '',
  userId: 'fairy',
});

function resolveConfig(config = {}) {
  return { ...MEM0_DEFAULTS, ...config };
}

function baseOf(config) {
  const base = trimBaseUrl(resolveConfig(config).baseUrl);
  if (!base) throw providerError(PROVIDER_FAILED, '未配置 mem0 服务地址。');
  return base;
}

function headersOf(config) {
  const headers = { 'content-type': 'application/json' };
  const key = String(resolveConfig(config).apiKey || '').trim();
  if (key) headers.authorization = `Token ${key}`;
  return headers;
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.memories)) return payload.memories;
  return [];
}

export function createMem0Provider({ fetchImpl = fetch } = {}) {
  return {
    id: MEM0_ID,
    available(config) {
      const value = resolveConfig(config);
      if (!trimBaseUrl(value.baseUrl)) return { available: false, reason: '未配置 mem0 服务地址。' };
      // A self-hosted mem0 usually runs without auth; the cloud API needs a key.
      const host = (() => {
        try {
          return new URL(value.baseUrl).hostname;
        } catch {
          return '';
        }
      })();
      const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      if (!local && !String(value.apiKey || '').trim()) return { available: false, reason: '未配置 mem0 API Key。' };
      return { available: true, reason: local ? '本地服务无需密钥。' : null };
    },
    async remember({ text, tags = [] }, config, signal) {
      const value = String(text || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可写入的记忆内容。');
      const settings = resolveConfig(config);
      const payload = await requestJson(fetchImpl, `${baseOf(config)}/v1/memories/`, {
        method: 'POST',
        headers: headersOf(config),
        body: JSON.stringify({
          messages: [{ role: 'user', content: value }],
          user_id: settings.userId,
          ...(tags.length ? { metadata: { tags } } : {}),
        }),
      }, signal);
      const first = rowsOf(payload)[0];
      return { id: typeof first?.id === 'string' ? first.id : null, raw: payload };
    },
    async recall({ query, limit = 6 }, config, signal) {
      const value = String(query || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可检索的查询词。');
      const payload = await requestJson(fetchImpl, `${baseOf(config)}/v1/memories/search/`, {
        method: 'POST',
        headers: headersOf(config),
        body: JSON.stringify({ query: value, user_id: resolveConfig(config).userId, limit }),
      }, signal);
      const results = rowsOf(payload).map((row) => ({
        text: String(row?.memory ?? row?.text ?? row?.content ?? '').trim(),
        source: row?.id ?? null,
        score: Number.isFinite(row?.score) ? row.score : null,
        updatedAt: row?.created_at ?? row?.updated_at ?? null,
      })).filter((row) => row.text);
      return { results, ...(results.length === 0 ? { note: 'mem0 没有返回匹配内容。' } : {}) };
    },
  };
}
