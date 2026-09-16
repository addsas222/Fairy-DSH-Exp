/**
 * Fairy Search — the search-engine hub and its control surface.
 *
 * One meta search provider (`fairy-search-hub`) is registered with the harness web seam
 * (`ctx.web`). Every request re-reads the `fairy-search` settings namespace and routes to the
 * selected engine, so switching engines in the settings card takes effect on the next search
 * without a restart. The official harness providers are reused as the transports for
 * DeepSeek / Exa / Perplexity; only the OpenAI-shaped `custom` engine is implemented here.
 *
 * @module dsh-fairy-search
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { WebError } from '@deepseek-ai/dsh-web';
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
} from '@deepseek-ai/dsh-web-search-deepseek';
import {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  ExaSearchProvider,
} from '@deepseek-ai/dsh-web-search-exa';
import {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PerplexitySearchProvider,
} from '@deepseek-ai/dsh-web-search-perplexity';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

/** Settings namespace owned by this plugin. */
export const FAIRY_SEARCH_SETTINGS_NAMESPACE = 'fairy-search';

/** Stable id this plugin's meta provider registers under with `ctx.web`. */
export const FAIRY_SEARCH_PROVIDER_ID = 'fairy-search-hub';

/** Settings section version written by the control UI. */
export const FAIRY_SEARCH_SETTINGS_VERSION = 1;

/** Engine ids accepted by the `provider` field, in control-UI order. */
export const FAIRY_SEARCH_PROVIDER_IDS = ['deepseek-official', 'exa', 'perplexity', 'custom'];

/** Query the control card's test button sends. */
export const FAIRY_SEARCH_PROBE_QUERY = 'DeepSeek';

/** Test-route budget: one probe search, then `ok:false`. */
export const FAIRY_SEARCH_TEST_TIMEOUT_MS = 15_000;

/** Test route returns at most this many sources (`tool-web` caps its own results separately). */
export const FAIRY_SEARCH_TEST_MAX_SOURCES = 8;

/**
 * Model sent to a `custom` OpenAI-shaped endpoint. The pinned settings contract carries only
 * `baseURL` + `apiKey`, so the model is a constant rather than a fourth field.
 * // ponytail: one fixed model for custom; a `custom.model` setting is the upgrade path.
 */
export const FAIRY_SEARCH_CUSTOM_MODEL = 'gpt-4o-mini';

const DEEPSEEK_SETTINGS_KEY = 'deepseek';
const CUSTOM_SEARCH_PROMPT = [
  'You are serving as a web search backend.',
  'Search the web for the user\'s query and answer briefly in the query\'s language.',
  'End with the sources you actually used, one markdown link per line: [title](url).',
].join(' ');
const MAX_REQUEST_BYTES = 20_000;
const diagnostics = createFairyDiagnostics('dsh-fairy-search');

/** Registered namespace handle for the `fairy-search` settings section. */
const FAIRY_SEARCH_SETTINGS = settingsNamespace(FAIRY_SEARCH_SETTINGS_NAMESPACE);

/**
 * The `fairy-search` settings schema. The API-key fields are `role('secret')` so no settings
 * read surface (including the browser mirror) can carry a stored key; the control card writes
 * new keys and reads only the host-side availability booleans from `/fairy-search/state`.
 */
export const FairySearchSettings = z.object({
  version: z.number().step(1).default(FAIRY_SEARCH_SETTINGS_VERSION),
  provider: z.union([...FAIRY_SEARCH_PROVIDER_IDS]).default(FAIRY_SEARCH_PROVIDER_IDS[0]),
  deepseek: z.object({
    apiKey: z.string().role('secret').default(''),
  }),
  exa: z.object({
    apiKey: z.string().role('secret').default(''),
  }),
  perplexity: z.object({
    apiKey: z.string().role('secret').default(''),
  }),
  custom: z.object({
    baseURL: z.string().default(''),
    apiKey: z.string().role('secret').default(''),
  }),
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function section(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

/**
 * Defensive read of the settings section. The settings service resolves the schema before this
 * runs; the resolver exists so handler tests (and a plugin mounted without a settings service)
 * read the same defaults.
 *
 * @param value - a raw `fairy-search` section, or anything else.
 * @returns the complete section with schema defaults applied.
 */
export function resolveFairySearchSettings(value) {
  const raw = section(value);
  const deepseek = section(raw.deepseek);
  const exa = section(raw.exa);
  const perplexity = section(raw.perplexity);
  const custom = section(raw.custom);
  return {
    version: Number.isInteger(raw.version) ? raw.version : FAIRY_SEARCH_SETTINGS_VERSION,
    provider: FAIRY_SEARCH_PROVIDER_IDS.includes(raw.provider) ? raw.provider : FAIRY_SEARCH_PROVIDER_IDS[0],
    deepseek: { apiKey: text(deepseek.apiKey) },
    exa: { apiKey: text(exa.apiKey) },
    perplexity: { apiKey: text(perplexity.apiKey) },
    custom: { baseURL: text(custom.baseURL), apiKey: text(custom.apiKey) },
  };
}

/**
 * Flat field names the settings card may write, mapped to whether an empty string is a
 * legitimate value. Secret rows are `false`: an empty input never clears a stored key.
 */
const WRITABLE_SETTINGS_FIELDS = new Map([
  ['provider', true],
  ['deepseek.apiKey', false],
  ['exa.apiKey', false],
  ['perplexity.apiKey', false],
  ['custom.baseURL', true],
  ['custom.apiKey', false],
]);

/**
 * Turn the flat field map posted by the settings card into a nested merge patch.
 *
 * The browser mirror of a settings scope only writes top-level scalars (`set(field, value)`), so
 * a nested row such as `custom.baseURL` cannot be addressed from the page at all; the card posts
 * flat names to this plugin's own route instead and the host merges them. A merge patch leaves
 * every field the card did not send untouched, which is what keeps an unedited secret alive.
 *
 * @param fields - `{ 'custom.baseURL': 'https://…' }` from the request body.
 * @returns `{ patch, changed }`, or `{ error, detail }` when the input is unusable.
 */
export function resolveSettingsPatch(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return { error: 'settings-patch-invalid' };
  const patch = {};
  let changed = false;
  for (const [name, raw] of Object.entries(fields)) {
    const allowEmpty = WRITABLE_SETTINGS_FIELDS.get(name);
    if (allowEmpty === undefined) return { error: 'settings-field-unknown', detail: name };
    if (typeof raw !== 'string') return { error: 'settings-value-invalid', detail: name };
    const value = raw.trim();
    if (value.length === 0 && !allowEmpty) continue;
    const [group, field] = name.split('.');
    if (field === undefined) patch[group] = value;
    else patch[group] = { ...(patch[group] ?? {}), [field]: value };
    changed = true;
  }
  return { patch, changed };
}

/** Availability-key of one engine id (`deepseek-official` reports under `deepseek`). */
export function availabilityKeyFor(provider) {
  return provider === 'deepseek-official' ? DEEPSEEK_SETTINGS_KEY : provider;
}

/** API key for the official DeepSeek engine: the settings override, else the launching env. */
function deepseekApiKey(settings, env) {
  return settings.deepseek.apiKey.length > 0 ? settings.deepseek.apiKey : text(env?.DEEPSEEK_API_KEY);
}

/**
 * Per-engine usability, computed locally from settings plus the launching environment. Never
 * touches the network and never returns key material — only the boolean and the reason shown
 * when the engine is selected but unusable.
 *
 * @param settings - a resolved `fairy-search` section.
 * @param env - environment carrying a possible `DEEPSEEK_API_KEY`.
 * @returns one entry per engine id (`deepseek` / `exa` / `perplexity` / `custom`).
 */
export function providerAvailability(settings, env = process.env) {
  const resolved = resolveFairySearchSettings(settings);
  return {
    deepseek: {
      available: deepseekApiKey(resolved, env).length > 0,
      reason: '未检测到 DEEPSEEK_API_KEY（可在环境变量或本页填入）。',
    },
    exa: {
      available: resolved.exa.apiKey.length > 0,
      reason: '未填写 Exa API Key。',
    },
    perplexity: {
      available: resolved.perplexity.apiKey.length > 0,
      reason: '未填写 Perplexity API Key。',
    },
    custom: {
      available: URL.canParse(resolved.custom.baseURL),
      reason: '未填写有效的自定义服务地址（需为 http(s) 完整地址）。',
    },
  };
}

/** Markdown link, else bare URL, inside an OpenAI-shaped answer. */
const ANSWER_LINK_PATTERN = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)\]]+)/g;

/**
 * Sources recoverable from a plain chat answer: markdown links first, then bare URLs, each URL
 * once (first title wins). A prompt-only backend cannot return structured results, so this is
 * the honest extraction rather than an invented source list.
 *
 * @param content - the answer text.
 * @returns citeable sources in first-mention order.
 */
export function extractAnswerSources(content) {
  const sources = [];
  const seen = new Set();
  for (const match of text(content).matchAll(ANSWER_LINK_PATTERN)) {
    const url = match[2] ?? match[3];
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const title = text(match[1]);
    sources.push({ url, ...title.length > 0 ? { title } : {} });
  }
  return sources;
}

/**
 * The `custom` engine: one OpenAI-compatible chat-completions call used as a search backend.
 *
 * // ponytail: custom stays OpenAI-shaped (plain prompt, no tool declarations, constant model)
 * // because an arbitrary gateway may not implement `web_search`; per-gateway request templates
 * // and a `custom.model` field are the upgrade path.
 *
 * @param options - `baseURL` (`/chat/completions` is appended), optional `apiKey`, fetch impl.
 * @returns the engine the hub routes to; availability is the hub's rule, not this object's.
 */
export function createCustomHttpProvider({ baseURL, apiKey = '', fetchImpl = fetch, model = FAIRY_SEARCH_CUSTOM_MODEL }) {
  const endpoint = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  return {
    id: 'custom',
    async search(request, signal) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {},
          },
          body: JSON.stringify({
            model,
            stream: false,
            temperature: 0,
            messages: [
              { role: 'system', content: CUSTOM_SEARCH_PROMPT },
              { role: 'user', content: request.query },
            ],
          }),
          ...signal !== undefined ? { signal } : {},
        });
      } catch (error) {
        if (isAbortError(error)) throw new WebError('自定义搜索请求已取消。', 'WEB_ABORTED', { cause: error });
        throw new WebError(`自定义搜索请求失败：${describeError(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
      }
      if (!response.ok) {
        throw new WebError(`自定义搜索服务返回 HTTP ${response.status}。`, 'WEB_PROVIDER_ERROR');
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (isAbortError(error)) throw new WebError('自定义搜索请求已取消。', 'WEB_ABORTED', { cause: error });
        throw new WebError('自定义搜索服务返回了无法解析的响应。', 'WEB_PROVIDER_ERROR', { cause: error });
      }
      const content = text(payload?.choices?.[0]?.message?.content);
      const sources = request.maxResults === undefined
        ? extractAnswerSources(content)
        : extractAnswerSources(content).slice(0, request.maxResults);
      // The web seam owns the final `maxResults` truncation, so this engine reports `false`.
      return { ...content.length > 0 ? { content } : {}, sources, truncated: false };
    },
  };
}

/**
 * Build the engine for one resolved settings section. Routing is a function of the settings, so
 * every call site (the hub, the test route) resolves the same engine for the same section.
 *
 * @param settings - a resolved `fairy-search` section.
 * @param options - injected fetch (custom engine only) and the launching environment.
 * @returns a `WebSearchProvider`-shaped engine for the selected id.
 */
export function createRoutedSearchProvider(settings, { fetchImpl = fetch, env = process.env } = {}) {
  const resolved = resolveFairySearchSettings(settings);
  const availability = providerAvailability(resolved, env);
  // 所选引擎没填凭据时退回第一个可用引擎：hub 的职责是路由，用户配了任何一个引擎
  // 就该能用；一个都没有时在调用点报出每项缺什么，而不是静默走一个必然失败的引擎。
  const selected = availability[availabilityKeyFor(resolved.provider)].available
    ? resolved.provider
    : FAIRY_SEARCH_PROVIDER_IDS.find((id) => availability[availabilityKeyFor(id)].available);
  if (selected === undefined) {
    const detail = FAIRY_SEARCH_PROVIDER_IDS
      .map((id) => `${id} ${availability[availabilityKeyFor(id)].reason}`)
      .join(' ');
    throw new WebError(`没有可用的搜索引擎。${detail}`, 'WEB_PROVIDER_ERROR');
  }
  switch (selected) {
    case 'exa':
      return new ExaSearchProvider({
        apiKey: resolved.exa.apiKey,
        baseURL: EXA_DEFAULT_BASE_URL,
        searchType: EXA_DEFAULT_SEARCH_TYPE,
        highlightsPerResult: EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
      });
    case 'perplexity':
      return new PerplexitySearchProvider({
        apiKey: resolved.perplexity.apiKey,
        baseURL: PERPLEXITY_DEFAULT_BASE_URL,
        model: PERPLEXITY_DEFAULT_MODEL,
        maxTokens: PERPLEXITY_DEFAULT_MAX_TOKENS,
      });
    case 'custom':
      return createCustomHttpProvider({
        baseURL: resolved.custom.baseURL,
        apiKey: resolved.custom.apiKey,
        fetchImpl,
      });
    case 'deepseek-official':
    default:
      return new DeepSeekSearchProvider(() => ({
        apiKey: deepseekApiKey(resolved, env),
        baseURL: DEEPSEEK_DEFAULT_BASE_URL,
        model: DEEPSEEK_DEFAULT_MODEL,
        apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
        maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
        maxUses: DEEPSEEK_DEFAULT_MAX_USES,
      }));
  }
}

/**
 * The meta search provider registered with `ctx.web` as `fairy-search-hub`.
 *
 * The official engines own their HTTP transport (they take no fetch injection); the hub's
 * `fetchImpl` seam therefore covers the `custom` engine it implements itself. Delegation keeps
 * the harness's wire formats and `WebError` codes identical to the standalone providers.
 *
 * @param options.getSettings - read the current raw settings section per request.
 * @param options.env - launching environment for `DEEPSEEK_API_KEY`.
 * @param options.fetchImpl - fetch used by the `custom` engine.
 * @returns the provider object `ctx.web.registerSearchProvider` expects.
 */
export function createFairySearchHub({ getSettings = () => undefined, env = process.env, fetchImpl = fetch } = {}) {
  const current = () => resolveFairySearchSettings(getSettings());
  return {
    id: FAIRY_SEARCH_PROVIDER_ID,
    /**
     * 恒可用：hub 自己总能回答——路由到第一个可用引擎，一个引擎都没配时在 `search()`
     * 里报出每项缺什么。harness 把“配置了这个 id 而 `available()` 为 false”当作**配置
     * 错误**硬抛（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`），而 profile 默认就把 provider
     * 钉在 hub 上，所以这里返回 false 会让全新环境连第一次搜索都进不去。
     * 设置卡仍按引擎逐项显示可用性（`providerAvailability`）。
     */
    available() {
      return true;
    },
    async search(request, signal) {
      const startedAt = diagnostics.start();
      const settings = current();
      try {
        const result = await createRoutedSearchProvider(settings, { fetchImpl, env }).search(request, signal);
        diagnostics.metric('search.request', startedAt, {
          provider: settings.provider,
          sources: result.sources.length,
          truncated: result.truncated,
        }, { thresholdMs: 1_000 });
        return result;
      } catch (error) {
        diagnostics.warn('search.request', {
          provider: settings.provider,
          aborted: signal?.aborted === true,
        }, redactedError(error, settings, env));
        throw error;
      }
    },
  };
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
  return true;
}

async function readJson(req, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('payload-too-large'), { code: 'payload-too-large' });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  // The test route takes its provider from the body but must also serve a bare POST.
  if (body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('invalid-json'), { code: 'invalid-json' });
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function describeError(error) {
  const message = text(error?.message);
  return message.length > 0 ? message : String(error);
}

/** Replace every configured secret in an outgoing message: keys never reach the browser. */
function redactSecrets(message, settings, env) {
  let output = String(message);
  for (const secret of [settings.deepseek.apiKey, settings.exa.apiKey, settings.perplexity.apiKey, settings.custom.apiKey, text(env?.DEEPSEEK_API_KEY)]) {
    if (secret.length > 0) output = output.split(secret).join('[redacted]');
  }
  return output;
}

/**
 * Log-safe view of a failure. A gateway may echo the credential it rejected inside its own
 * error message, so the diagnostics record gets the redacted text rather than the raw error.
 */
function redactedError(error, settings, env) {
  return { name: error?.name, code: error?.code, message: redactSecrets(describeError(error), settings, env) };
}

/** Display label for one source: its title, else its hostname. */
function sourceLabel(url, title) {
  if (text(title).length > 0) return title;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** One test search's abort/timeout ownership. */
function createTestScope(timeoutMs) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort('search-timeout'), timeoutMs);
  return {
    signal: controller.signal,
    /** The abort reason, or undefined while the request is still live. */
    reason() {
      return controller.signal.aborted ? String(controller.signal.reason ?? 'search-timeout') : undefined;
    },
    cancel(reason = 'request-complete') {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}

/** Request-level failure code of one test probe: our own timeout, else any abort is a cancel. */
export function testFailureCode(scope, error) {
  const reason = scope.reason();
  if (reason === 'search-timeout') return 'search-timeout';
  if (reason !== undefined) return 'client-aborted';
  return error?.code ?? 'search-failed';
}

/** Chinese message for one test-probe failure; never carries key material. */
export function testFailureMessage(code, error, settings, env) {
  const messages = {
    'search-timeout': `搜索请求超时（${FAIRY_SEARCH_TEST_TIMEOUT_MS / 1_000} 秒）。`,
    'client-aborted': '请求已取消。',
    'unknown-provider': '未知的搜索提供方。',
    'invalid-json': '请求格式无效。',
    'payload-too-large': '请求内容过大。',
    'WEB_PROVIDER_CREDENTIAL_MISSING': '未检测到可用的 API Key。',
    'WEB_ABORTED': '搜索请求被中断。',
  };
  const mapped = code === 'provider-unconfigured'
    // The unconfigured probe carries its own reason: which key or address is missing.
    ? describeError(error)
    : messages[code];
  return redactSecrets(mapped ?? `搜索失败：${describeError(error)}`, settings, env);
}

/**
 * HTTP handlers behind `/fairy-search/*`. Both read the settings section per request; the test
 * route's timeout and fetch implementation are injected so the probe is testable offline.
 *
 * @param options.getSettings - read the current raw settings section per request.
 * @param options.env - launching environment for `DEEPSEEK_API_KEY`.
 * @param options.fetchImpl - fetch used by the `custom` engine.
 * @param options.timeoutMs - test-probe budget.
 * @param options.now - monotonic clock used for the reported latency.
 * @returns the route handlers plus a disposer aborting in-flight probes.
 */
export function createFairySearchHandlers({
  getSettings = () => undefined,
  writeSettings,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = FAIRY_SEARCH_TEST_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const activeScopes = new Set();
  return {
    dispose() {
      for (const scope of activeScopes) scope.cancel('disposed');
      activeScopes.clear();
    },
    /** GET /fairy-search/state — selected engine plus per-engine availability (never keys). */
    state: (_req, res) => {
      const settings = resolveFairySearchSettings(getSettings());
      const availability = providerAvailability(settings, env);
      sendJson(res, 200, {
        provider: settings.provider,
        configured: {
          deepseek: availability.deepseek.available,
          exa: availability.exa.available,
          perplexity: availability.perplexity.available,
          custom: availability.custom.available,
        },
      });
    },
    /** POST /fairy-search/settings — merge the fields the card typed; empty secrets never clear. */
    config: async (req, res) => {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { error: error?.code || 'invalid-json' });
        return;
      }
      const resolved = resolveSettingsPatch(body?.fields);
      if (resolved.error !== undefined) {
        diagnostics.warn('settings.patch', { code: resolved.error }, new Error(resolved.detail || resolved.error));
        sendJson(res, 400, { error: resolved.error, reason: resolved.detail ?? resolved.error });
        return;
      }
      if (resolved.changed) {
        // No writer means the host never registered the namespace: report it instead of
        // answering 200, or the card would claim a save that never reached the document.
        if (typeof writeSettings !== 'function') {
          sendJson(res, 503, { error: 'settings-unavailable', reason: '设置命名空间不可写。' });
          return;
        }
        try {
          await writeSettings(resolved.patch);
        } catch (error) {
          const unavailable = error?.code === 'settings-unavailable';
          if (!unavailable) diagnostics.warn('settings.write', {}, redactedError(error, resolveFairySearchSettings(getSettings()), env));
          sendJson(res, unavailable ? 503 : 500, { error: unavailable ? 'settings-unavailable' : 'settings-write-failed', reason: describeError(error) });
          return;
        }
      }
      sendJson(res, 200, { ok: true, changed: resolved.changed });
    },
    /** POST /fairy-search/test — one probe search with `provider` overriding the selection. */
    test: async (req, res) => {
      const startedAt = diagnostics.start();
      const beganAt = now();
      const scope = createTestScope(timeoutMs);
      activeScopes.add(scope);
      const disconnect = () => scope.cancel('client-aborted');
      const close = () => { if (!res.writableEnded) disconnect(); };
      req.once('aborted', disconnect);
      res.once('close', close);
      let settings = resolveFairySearchSettings(getSettings());
      try {
        const body = await readJson(req);
        const requested = body?.provider === undefined ? settings.provider : body.provider;
        if (!FAIRY_SEARCH_PROVIDER_IDS.includes(requested)) {
          throw Object.assign(new Error('unknown-provider'), { code: 'unknown-provider' });
        }
        settings = { ...settings, provider: requested };
        const availability = providerAvailability(settings, env)[availabilityKeyFor(requested)];
        if (!availability.available) throw Object.assign(new Error(availability.reason), { code: 'provider-unconfigured' });
        const result = await createRoutedSearchProvider(settings, { fetchImpl, env }).search({ query: FAIRY_SEARCH_PROBE_QUERY }, scope.signal);
        const sources = result.sources.slice(0, FAIRY_SEARCH_TEST_MAX_SOURCES).map((source) => ({
          title: sourceLabel(source.url, source.title),
          url: source.url,
        }));
        sendJson(res, 200, { ok: true, latencyMs: Math.max(0, Math.round(now() - beganAt)), sources });
      } catch (error) {
        const code = error?.code === 'invalid-json' || error?.code === 'payload-too-large' || error?.code === 'unknown-provider'
          ? error.code
          : testFailureCode(scope, error);
        const status = code === 'unknown-provider' || code === 'invalid-json' || code === 'payload-too-large' ? 400 : 200;
        if (code !== 'client-aborted') diagnostics.warn('test.request', { code, provider: settings.provider }, redactedError(error, settings, env));
        sendJson(res, status, { ok: false, error: testFailureMessage(code, error, settings, env) });
      } finally {
        diagnostics.metric('test.request', startedAt, { provider: settings.provider });
        activeScopes.delete(scope);
        req.removeListener('aborted', disconnect);
        res.removeListener('close', close);
        scope.cancel('request-complete');
      }
    },
  };
}

/**
 * Register the settings namespace, the `fairy-search-hub` web provider, and the control routes.
 *
 * @param ctx - hosting plugin context.
 */
export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    let readSettings = () => undefined;
    let writeSettings;
    ctx.inject(['settings'], (settingsCtx) => {
      const scope = settingsCtx.settings.register(FAIRY_SEARCH_SETTINGS, FairySearchSettings);
      readSettings = () => scope.get();
      writeSettings = (patch) => scope.update(patch);
    });
    ctx.inject(['web'], (webCtx) => {
      const unregister = webCtx.web.registerSearchProvider(createFairySearchHub({ getSettings: () => readSettings() }));
      webCtx.effect(() => () => unregister(), 'dsh-fairy-search web provider');
    });
    const handlers = createFairySearchHandlers({
      getSettings: () => readSettings(),
      // The namespace registers asynchronously; until then the route answers 503 instead of
      // pretending a save landed.
      writeSettings: (patch) => writeSettings === undefined
        ? Promise.reject(Object.assign(new Error('fairy-search 设置命名空间尚未注册。'), { code: 'settings-unavailable' }))
        : writeSettings(patch),
    });
    ctx.inject(['webServer'], (ws) => ws.effect(() => {
      const unregisterTest = ws.webServer.register({ kind: 'exact', path: '/fairy-search/test', handler: handlers.test });
      const unregisterState = ws.webServer.register({ kind: 'exact', path: '/fairy-search/state', handler: handlers.state });
      const unregisterSettings = ws.webServer.register({ kind: 'exact', path: '/fairy-search/settings', handler: handlers.config });
      return () => {
        handlers.dispose();
        unregisterTest?.();
        unregisterState?.();
        unregisterSettings?.();
      };
    }));
  }, { surface: 'host' });
}
