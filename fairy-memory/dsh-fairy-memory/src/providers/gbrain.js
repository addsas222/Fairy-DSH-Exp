/* GBrain adapter - the primary engine. GBrain (garrytan/gbrain) exposes its
 * memory through an MCP server: `gbrain serve --http` speaks JSON-RPC 2.0 with
 * a bearer token, and `--surface verbs` narrows the tool list to the frozen
 * seven memory verbs (recall / remember / entity / synthesize / forget /
 * context_pack / delta). Two things about that transport drive this file:
 * replies may arrive as JSON or as SSE frames, and a session may be required
 * before tools are callable. Both are handled here so the routes stay thin. */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, trimBaseUrl, upstreamMessage } from './http.js';

export const GBRAIN_ID = 'gbrain';

export const GBRAIN_DEFAULTS = Object.freeze({
  // Deliberately empty: the docs do not fix a port for `gbrain serve --http`,
  // and a guessed default would report a dead endpoint as "available".
  baseUrl: '',
  token: '',
  surface: 'verbs',
  visibility: '',
});

/** A probe must be bounded: the card asks for state on every open. */
const PROBE_TIMEOUT_MS = 1_500;

/** One session id per endpoint, as the MCP Streamable HTTP transport expects. */
const sessions = new Map();

function resolveConfig(config = {}) {
  return { ...GBRAIN_DEFAULTS, ...config };
}

function rpcUrl(config) {
  const base = trimBaseUrl(config.baseUrl);
  if (!base) throw providerError(PROVIDER_UNAVAILABLE, '未配置 GBrain 服务地址。');
  const surface = String(config.surface || '').trim();
  if (!surface || /[?&]surface=/.test(base)) return base;
  return `${base}${base.includes('?') ? '&' : '?'}surface=${encodeURIComponent(surface)}`;
}

function headersOf(config, session) {
  const headers = {
    'content-type': 'application/json',
    // The Streamable HTTP transport is allowed to answer with either, so the
    // client has to advertise both or some deployments reject the request.
    accept: 'application/json, text/event-stream',
  };
  const token = String(config.token || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) headers['mcp-session-id'] = session;
  return headers;
}

/** JSON body or `data:` SSE frames - whatever the deployment chose to send. */
function parsePayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  for (const line of raw.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('data:')) continue;
    try {
      return JSON.parse(frame.slice(5).trim());
    } catch {
      continue;
    }
  }
  return null;
}

/** The text out of an MCP tool result, flattened. */
function resultText(message) {
  const content = message?.result?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  if (typeof message?.result === 'string') return message.result;
  if (typeof message?.result?.text === 'string') return message.result.text;
  return '';
}

function parseMaybeJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A tool-level failure carries the protocol error inside the result. */
function toolError(message) {
  if (message?.result?.isError !== true) return null;
  const payload = parseMaybeJson(resultText(message));
  const code = typeof payload?.error === 'string' ? payload.error : 'tool_error';
  const detail = [payload?.message, payload?.suggestion].filter((part) => typeof part === 'string' && part.trim()).join(' ');
  return providerError(PROVIDER_FAILED, `${code}${detail ? `：${detail}` : ''}`);
}

/** Tolerant mapping: GBrain's prose answers and structured answers both fit. */
const RESULT_TEXT_KEYS = ['chunk', 'text', 'fact', 'statement', 'content', 'memory', 'summary'];

function rowText(row) {
  for (const key of RESULT_TEXT_KEYS) {
    const value = row?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function toResults(message) {
  const text = resultText(message);
  const payload = parseMaybeJson(text);
  /* v1 recall answers carry two arms: `facts[]` (saved facts) and `results[]`
   * (page snippets, whose text field is `chunk`). Both are useful to a caller,
   * facts first because they are the durable statements. */
  const structured = message?.result?.structuredContent;
  const facts = payload?.facts ?? structured?.facts ?? null;
  const search = payload?.results ?? structured?.results ?? payload?.memories ?? null;
  const rows = [
    ...(Array.isArray(facts) ? facts.map((row) => ({ ...row, __arm: 'fact' })) : []),
    ...(Array.isArray(search) ? search.map((row) => ({ ...row, __arm: 'search' })) : []),
  ];
  if (rows.length === 0 && Array.isArray(payload)) rows.push(...payload.map((row) => ({ ...row, __arm: 'search' })));
  if (rows.length) {
    return rows.map((row) => ({
      text: rowText(row),
      source: row?.provenance ?? row?.slug ?? row?.entity_slug ?? row?.id ?? row?.path ?? null,
      score: Number.isFinite(row?.score) ? row.score : null,
      updatedAt: row?.valid_from ?? row?.updatedAt ?? row?.created_at ?? null,
      arm: row.__arm,
      ...(typeof row?.evidence === 'string' ? { evidence: row.evidence } : {}),
      ...(typeof row?.create_safety === 'string' ? { createSafety: row.create_safety } : {}),
    })).filter((row) => row.text);
  }
  const value = text.trim();
  return value ? [{ text: value, source: null, score: null, updatedAt: null }] : [];
}

export function createGbrainProvider({ fetchImpl = fetch } = {}) {
  /** One POST; `session` is re-read after a handshake. */
  const post = async (config, body, signal, session) => {
    const url = rpcUrl(config);
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: headersOf(config, session), body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal?.aborted) throw providerError(signal.reason || 'client-aborted', '记忆服务请求已取消。');
      throw providerError(PROVIDER_UNAVAILABLE, '记忆服务连接失败。');
    }
    if (!response || typeof response.ok !== 'boolean') throw providerError(PROVIDER_FAILED, '记忆服务未返回有效响应。');
    const nextSession = typeof response.headers?.get === 'function' ? response.headers.get('mcp-session-id') : null;
    if (nextSession) sessions.set(url, nextSession);
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    const message = parsePayload(text);
    if (!response.ok) {
      throw providerError(PROVIDER_FAILED, upstreamMessage(message) || `记忆服务返回 ${response.status}`);
    }
    if (!message) throw providerError(PROVIDER_FAILED, '记忆服务未返回可解析的响应。');
    if (message.error) throw providerError(PROVIDER_FAILED, String(message.error.message || message.error.code || '记忆服务返回错误。'));
    return message;
  };

  /** `initialize` once per endpoint: some deployments reject bare tools/call. */
  const handshake = async (config, signal) => {
    const url = rpcUrl(config);
    const message = await post(config, {
      jsonrpc: '2.0',
      id: `fairy-init-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-fairy-memory', version: '1.0.0' },
      },
    }, signal, null);
    sessions.set(url, sessions.get(url) || null);
    return message;
  };

  const callTool = async (name, args, config, signal) => {
    const url = rpcUrl(config);
    const body = { jsonrpc: '2.0', id: `fairy-${name}-${Date.now()}`, method: 'tools/call', params: { name, arguments: args } };
    let message;
    try {
      message = await post(config, body, signal, sessions.get(url) || null);
    } catch (error) {
      if (error?.code !== PROVIDER_FAILED || !/session|initialize/i.test(error.message || '')) throw error;
      await handshake(config, signal);
      message = await post(config, body, signal, sessions.get(url) || null);
    }
    // A verb failure comes back as a tool result with isError; every caller
    // deserves the protocol's own diagnosis, so it is raised here once.
    const raised = toolError(message);
    if (raised) throw raised;
    return message;
  };

  return {
    id: GBRAIN_ID,
    /**
     * A configured endpoint gets one bounded `initialize` probe: GBrain is a
     * local service, and the sibling local provider (GPT-SoVITS) is probed the
     * same way. Not configured is its own answer, never a false "available".
     */
    async available(config) {
      const value = resolveConfig(config);
      try {
        rpcUrl(value);
      } catch (error) {
        return {
          available: false,
          reason: `${error.message}先运行 gbrain init --pglite 与 gbrain serve --http（需要 Bun ≥1.3.11；npm 上的 gbrain 是无关包，请用 bun install -g github:garrytan/gbrain 安装）。`,
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('timeout'), PROBE_TIMEOUT_MS);
      try {
        await handshake(value, controller.signal);
        return { available: true, reason: null };
      } catch (error) {
        return { available: false, reason: `GBrain 未响应（${error?.message || '连接失败'}）。确认 gbrain serve --http 正在运行、token 与地址正确。` };
      } finally {
        clearTimeout(timer);
      }
    },
    async remember({ text, tags = [], source = 'dsh-fairy-memory', visibility = '' }, config, signal) {
      const value = String(text || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可写入的记忆内容。');
      const settings = resolveConfig(config);
      const provenance = (tags.length ? `${source} [${tags.join(', ')}]` : source).slice(0, 500);
      const chosen = String(visibility || settings.visibility || '').trim();
      const entity = String(settings.entity || '').trim();
      const kind = String(settings.kind || '').trim();
      const message = await callTool('remember', {
        // v1 names the payload `fact`, and provenance is required: an
        // unattributed write is rejected with `provenance_required`.
        fact: value,
        provenance: provenance || 'dsh-fairy-memory',
        ...(entity ? { entity } : {}),
        ...(kind ? { kind } : {}),
        ...(chosen === 'private' || chosen === 'world' ? { visibility: chosen } : {}),
      }, config, signal);
      const payload = parseMaybeJson(resultText(message));
      const id = payload?.id ?? payload?.fact_id ?? null;
      // `status: duplicate` returns the existing fact's id - same shape to us.
      return { id: typeof id === 'string' ? id : null, status: payload?.status ?? null, raw: payload ?? null };
    },
    async recall({ query, limit = 6 }, config, signal) {
      const value = String(query || '').trim();
      if (!value) throw providerError(PROVIDER_FAILED, '没有可检索的查询词。');
      const message = await callTool('recall', { query: value, limit }, config, signal);
      const results = toResults(message);
      const payload = parseMaybeJson(resultText(message));
      const degraded = typeof payload?.search_degraded === 'string' ? `检索已降级：${payload.search_degraded}（未配置嵌入模型时属正常）。` : null;
      return {
        results,
        ...(results.length === 0 ? { note: degraded || 'GBrain 没有返回匹配内容。' } : degraded ? { note: degraded } : {}),
      };
    },
  };
}
