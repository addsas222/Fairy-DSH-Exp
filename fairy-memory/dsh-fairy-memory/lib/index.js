/**
 * Host half of dsh-fairy-memory: the settings namespace, the provider registry,
 * and the four routes the settings card and any external client use. GBrain is
 * the primary engine; mem0, a custom HTTP endpoint, and the local markdown
 * store are the alternatives. Nothing here talks to an agent: memory is host
 * state, and both the CLI and the agent tools read the same configuration.
 *
 * @module dsh-fairy-memory
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import {
  MEMORY_PROVIDER_DEFAULTS,
  MEMORY_PROVIDER_FIELDS,
  MEMORY_PROVIDER_IDS,
  MEMORY_SECRET_FIELDS,
  createMemoryRegistry,
} from './providers/index.js';

export const FAIRY_MEMORY_SETTINGS_NAMESPACE = 'fairy-memory';
const FAIRY_MEMORY_SETTINGS = settingsNamespace(FAIRY_MEMORY_SETTINGS_NAMESPACE);
const diagnostics = createFairyDiagnostics('dsh-fairy-memory');

const MAX_QUERY_CHARS = 2_000;
const MAX_REMEMBER_CHARS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 20_000;

export const FAIRY_MEMORY_DEFAULTS = Object.freeze({
  version: 1,
  // Free-form on purpose: an id from a newer plugin degrades to the local
  // store instead of failing the namespace registration on host startup.
  provider: 'gbrain',
  autoRecall: false,
  providers: Object.freeze({
    gbrain: Object.freeze({ ...MEMORY_PROVIDER_DEFAULTS.gbrain }),
    mem0: Object.freeze({ ...MEMORY_PROVIDER_DEFAULTS.mem0 }),
    customHttp: Object.freeze({ ...MEMORY_PROVIDER_DEFAULTS.customHttp }),
    localMarkdown: Object.freeze({ ...MEMORY_PROVIDER_DEFAULTS.localMarkdown }),
  }),
});

const section = (fields) => z.object(Object.fromEntries(fields.map((field) => [field, z.string().default('')])));

export const FairyMemorySettings = z.object({
  version: z.number().step(1).default(1),
  provider: z.string().default(FAIRY_MEMORY_DEFAULTS.provider),
  autoRecall: z.boolean().default(false),
  providers: z.object({
    gbrain: section(MEMORY_PROVIDER_FIELDS.gbrain),
    mem0: section(MEMORY_PROVIDER_FIELDS.mem0),
    customHttp: section(MEMORY_PROVIDER_FIELDS.customHttp),
    localMarkdown: section(MEMORY_PROVIDER_FIELDS.localMarkdown),
  }).default({}),
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergePatch(under, patch) {
  const next = { ...under, ...patch };
  if (patch.providers) {
    next.providers = { ...(under.providers || {}) };
    for (const [key, fields] of Object.entries(patch.providers)) {
      next.providers[key] = { ...(next.providers[key] || {}), ...(fields || {}) };
    }
  }
  return next;
}

export function createMemorySettingsBoundary(initial = FAIRY_MEMORY_DEFAULTS) {
  let current = cloneJson(initial);
  const boundary = {
    read: () => current,
    async write(patch) {
      current = mergePatch(current, patch);
      return current;
    },
    attach(scope) {
      current = scope.get();
      boundary.read = () => scope.get();
      boundary.write = async (patch) => {
        await scope.update(patch);
        return scope.get();
      };
    },
  };
  return boundary;
}

/** `***` means "keep what is stored"; it must survive a round trip. */
function maskProviderSections(sections) {
  const masked = {};
  for (const [key, fields] of Object.entries(sections || {})) {
    const secrets = MEMORY_SECRET_FIELDS[key] || [];
    masked[key] = Object.fromEntries(Object.entries(fields || {}).map(([name, value]) => [
      name,
      secrets.includes(name) && typeof value === 'string' && value !== '' ? '***' : value,
    ]));
  }
  return masked;
}

function sanitize(value) {
  return {
    version: value.version,
    provider: value.provider,
    autoRecall: value.autoRecall === true,
    providers: maskProviderSections(value.providers),
  };
}

/** Drop `***` placeholder writes and unknown keys before they reach settings. */
function buildPatch(body = {}) {
  const patch = {};
  if (typeof body.provider === 'string' && body.provider) patch.provider = body.provider;
  if (typeof body.autoRecall === 'boolean') patch.autoRecall = body.autoRecall;
  if (body.providers && typeof body.providers === 'object') {
    patch.providers = {};
    for (const [key, fields] of Object.entries(body.providers)) {
      if (!MEMORY_PROVIDER_DEFAULTS[key]) continue;
      const allowed = MEMORY_PROVIDER_FIELDS[key] || [];
      const next = {};
      for (const [name, value] of Object.entries(fields || {})) {
        if (!allowed.includes(name) || typeof value !== 'string') continue;
        if (MEMORY_SECRET_FIELDS[key]?.includes(name) && value === '***') continue;
        next[name] = value;
      }
      if (Object.keys(next).length) patch.providers[key] = next;
    }
  }
  return patch;
}

/** `$DSH_HOME/fairy-memory/config.json`: the mirror the CLI and the agent tools read. */
export function memoryConfigPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'fairy-memory', 'config.json');
}

async function writeConfigMirror(value) {
  try {
    const file = memoryConfigPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ provider: value.provider, autoRecall: value.autoRecall === true, providers: value.providers }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    diagnostics.warn('memory.mirror', {}, error);
  }
}

function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return false;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
  return true;
}

/**
 * DSH request objects are async iterables; the repo's other packages read them
 * the same way, and the error carries its own code so no caller has to sniff a
 * message to pick a status.
 */
async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('payload-too-large');
      error.code = 'payload-too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('invalid-json');
    error.code = 'invalid-json';
    throw error;
  }
}

const STATUS_BY_CODE = {
  'invalid-json': 400,
  'empty-text': 400,
  'provider-config-invalid': 400,
  'text-too-large': 413,
  'payload-too-large': 413,
  'client-aborted': 499,
  'provider-failed': 502,
  'provider-unavailable': 503,
  timeout: 504,
};

function statusFor(code) {
  return STATUS_BY_CODE[code] || 502;
}

function publicError(code, detail) {
  const fixed = {
    'invalid-json': '请求体不是合法 JSON。',
    'empty-text': '没有可写入的记忆内容。',
    'text-too-large': `单条记忆不能超过 ${MAX_REMEMBER_CHARS} 字符。`,
    'payload-too-large': '请求体超过大小上限。',
    'provider-config-invalid': '记忆服务配置无效。',
    'client-aborted': '请求已取消。',
    'provider-unavailable': '记忆服务不可用或未配置。',
    'provider-failed': '记忆服务未能完成操作。',
    timeout: '记忆服务超时。',
  }[code] || '记忆服务未能完成操作。';
  // The upstream text is what separates a bad key from an unreachable host.
  if (code === 'provider-failed' && typeof detail === 'string') {
    const trimmed = detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
    if (trimmed && trimmed !== fixed) return { code, message: `${fixed}（${trimmed}）` };
  }
  return { code, message: fixed };
}

/**
 * The four routes. `state` doubles as the availability view, so the card can
 * refresh it without a second round trip.
 */
export function createFairyMemoryHandlers({ settings = createMemorySettingsBoundary(), registry = createMemoryRegistry({}), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const withScope = async (task) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      return await task(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    state: async (_req, res) => {
      const startedAt = diagnostics.start();
      try {
        const value = settings.read();
        const { provider, config, id, fallback } = registry.resolve(value);
        const providers = await registry.list(value);
        const entry = providers.find((item) => item.id === id);
        let count = null;
        if (entry?.available === true && typeof provider.count === 'function') {
          count = await withScope((signal) => provider.count(config, signal)).catch(() => null);
        }
        sendJson(res, 200, {
          provider: id,
          fallback,
          available: entry?.available === true,
          reason: entry?.reason ?? null,
          count: Number.isFinite(count) ? count : null,
          providers,
        });
      } catch (error) {
        diagnostics.warn('memory.state', {}, error);
        sendJson(res, 200, { provider: null, available: false, reason: '无法读取记忆状态。', count: null, providers: [] });
      } finally {
        diagnostics.metric('memory.state.request', startedAt, {}, { thresholdMs: 100 });
      }
    },
    config: async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, sanitize(settings.read()));
          return;
        }
        const body = await readJson(req, MAX_BODY_BYTES);
        await settings.write(buildPatch(body));
        const next = settings.read();
        await writeConfigMirror(next);
        sendJson(res, 200, sanitize(next));
      } catch (error) {
        const code = error?.code || 'provider-config-invalid';
        diagnostics.warn('memory.config', { code }, error);
        sendJson(res, statusFor(code), { error: publicError(code) });
      }
    },
    recall: async (req, res) => {
      const startedAt = diagnostics.start();
      try {
        const body = await readJson(req, MAX_BODY_BYTES);
        const query = typeof body?.query === 'string' ? body.query.trim() : '';
        if (!query) throw Object.assign(new Error('empty-query'), { code: 'empty-text' });
        if (query.length > MAX_QUERY_CHARS) throw Object.assign(new Error('query-too-large'), { code: 'text-too-large' });
        const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body?.limit) || 6));
        const value = settings.read();
        const { provider, config, id, fallbackReason } = registry.resolve(value);
        const answer = await withScope((signal) => provider.recall({ query, limit }, config, signal));
        const notes = [fallbackReason, answer?.note].filter((note) => typeof note === 'string' && note);
        sendJson(res, 200, {
          provider: id,
          results: Array.isArray(answer?.results) ? answer.results : [],
          ...(notes.length ? { note: notes.join(' ') } : {}),
        });
      } catch (error) {
        const code = error?.code || 'provider-failed';
        if (!['client-aborted', 'timeout'].includes(code)) diagnostics.warn('memory.recall', { code }, error);
        if (!res.writableEnded) sendJson(res, statusFor(code), { error: publicError(code, error?.message) });
      } finally {
        diagnostics.metric('memory.recall.request', startedAt, {}, { thresholdMs: 500 });
      }
    },
    remember: async (req, res) => {
      const startedAt = diagnostics.start();
      try {
        const body = await readJson(req, MAX_BODY_BYTES);
        const text = typeof body?.text === 'string' ? body.text.trim() : '';
        if (!text) throw Object.assign(new Error('empty-text'), { code: 'empty-text' });
        if (text.length > MAX_REMEMBER_CHARS) throw Object.assign(new Error('text-too-large'), { code: 'text-too-large' });
        const tags = Array.isArray(body?.tags) ? body.tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 8) : [];
        const source = typeof body?.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 200) : 'manual';
        const value = settings.read();
        const { provider, config, id, fallbackReason } = registry.resolve(value);
        const answer = await withScope((signal) => provider.remember({ text, tags, source, visibility: body?.visibility }, config, signal));
        sendJson(res, 200, { ok: true, provider: id, id: answer?.id ?? null, ...(fallbackReason ? { note: fallbackReason } : {}) });
      } catch (error) {
        const code = error?.code || 'provider-failed';
        if (!['client-aborted', 'timeout'].includes(code)) diagnostics.warn('memory.remember', { code }, error);
        if (!res.writableEnded) sendJson(res, statusFor(code), { error: publicError(code, error?.message) });
      } finally {
        diagnostics.metric('memory.remember.request', startedAt, {}, { thresholdMs: 500 });
      }
    },
  };
}

export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    const settings = createMemorySettingsBoundary();
    const handlers = createFairyMemoryHandlers({ settings });
    ctx.inject(['settings'], (settingsCtx) => {
      settings.attach(settingsCtx.settings.register(FAIRY_MEMORY_SETTINGS, FairyMemorySettings));
      void writeConfigMirror(settings.read());
    }, { surface: 'host' });
    ctx.inject(['webServer'], (ws) => {
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-memory/state', handler: handlers.state }), 'dsh-fairy-memory: state');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-memory/config', handler: handlers.config }), 'dsh-fairy-memory: config');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-memory/recall', handler: handlers.recall }), 'dsh-fairy-memory: recall');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-memory/remember', handler: handlers.remember }), 'dsh-fairy-memory: remember');
    }, { surface: 'host' });
  }, { surface: 'host' });
}
