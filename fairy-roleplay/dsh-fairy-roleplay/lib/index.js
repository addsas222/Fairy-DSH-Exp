/**
 * Host half of dsh-fairy-roleplay: the settings namespace, the style library
 * location, and the four routes the settings card uses. Nothing here talks to
 * an agent — the rules themselves are prompt data, and both the card and the
 * agent tools read the same files under `$DSH_HOME/fairy-roleplay/`.
 *
 * The roleplay *mode* itself lives in dsh-fairy-modes (`/mode roleplay`); this
 * package supplies what that mode leans on: the de-AI checker, the style
 * library, and the timing/reply/planner rule text.
 *
 * @module dsh-fairy-roleplay
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { check, renderReport } from './humanizer.js';
import { HUMANIZER_LEVELS } from './rules.js';
import { mergeStyleEntries, parseStyleEntries, parseStyleFile, renderStyleBlock } from './style.js';

export const FAIRY_ROLEPLAY_SETTINGS_NAMESPACE = 'fairy-roleplay';
const FAIRY_ROLEPLAY_SETTINGS = settingsNamespace(FAIRY_ROLEPLAY_SETTINGS_NAMESPACE);
const diagnostics = createFairyDiagnostics('dsh-fairy-roleplay');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 20_000;

/** DSH 家目录：与 fairy-voice/fairy-persona 同一约定。 */
export function roleplayHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : configured;
}

/** 宿主与 agent 工具共读的配置文件。 */
export function roleplayConfigPath() {
  return join(roleplayHome(), 'fairy-roleplay', 'config.json');
}

/**
 * 风格库路径：设置里可以指到任意位置（例如跟着仓库走），空值用家目录默认。
 *
 * @param settings - 当前设置。
 * @returns 绝对路径。
 */
export function roleplayStylePath(settings) {
  const configured = typeof settings?.stylePath === 'string' ? settings.stylePath.trim() : '';
  return configured === '' ? join(roleplayHome(), 'fairy-roleplay', 'style.json') : configured;
}

/** 默认档位只在 L1：先保证不出现套话，节奏与内容交给更大的档位。 */
export const FAIRY_ROLEPLAY_DEFAULTS = Object.freeze({
  version: 1,
  humanizerLevel: 'l1',
  stylePath: '',
});

export const FairyRoleplaySettings = z.object({
  version: z.number().step(1).default(1),
  humanizerLevel: z.string().default(FAIRY_ROLEPLAY_DEFAULTS.humanizerLevel),
  stylePath: z.string().default(FAIRY_ROLEPLAY_DEFAULTS.stylePath),
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createRoleplaySettingsBoundary(initial = FAIRY_ROLEPLAY_DEFAULTS) {
  let current = cloneJson(initial);
  const boundary = {
    read: () => current,
    async write(patch) {
      current = sanitizePatch(current, patch);
      return current;
    },
    attach(scope) {
      current = { ...cloneJson(FAIRY_ROLEPLAY_DEFAULTS), ...scope.get() };
      boundary.read = () => scope.get();
      boundary.write = async (patch) => {
        await scope.update(patch);
        return scope.get();
      };
    },
  };
  return boundary;
}

/** 只接受已知键，档位取值必须合法：设置面的输入不可信。 */
function sanitizePatch(current, patch) {
  const next = { ...current };
  const level = typeof patch?.humanizerLevel === 'string' ? patch.humanizerLevel.trim().toLowerCase() : '';
  if (HUMANIZER_LEVELS.includes(level)) next.humanizerLevel = level;
  if (typeof patch?.stylePath === 'string') next.stylePath = patch.stylePath.trim().slice(0, 400);
  return next;
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body-too-large'), { code: 'payload-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(Object.assign(error, { code: 'bad-json' }));
      }
    });
    req.on('error', reject);
  });
}

async function readStyle(settings) {
  const path = roleplayStylePath(settings);
  try {
    return { path, store: parseStyleFile(await readFile(path, 'utf8')) };
  } catch {
    return { path, store: { version: 1, entries: [] } };
  }
}

async function writeStyle(path, entries) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
}

const statusFor = (code) => (code === 'payload-too-large' ? 413 : code === 'bad-json' ? 400 : 502);

/**
 * 设置卡的四个路由。`check` 与 `style` 让设置界面能在不发消息的情况下自检与
 * 查看风格库——它们与 agent 工具跑的是同一份实现。
 *
 * @param options.settings - 设置边界。
 * @returns 路由处理器表。
 */
export function createFairyRoleplayHandlers({ settings = createRoleplaySettingsBoundary() } = {}) {
  const state = async (_req, res) => {
    try {
      const value = settings.read();
      const { path, store } = await readStyle(value);
      sendJson(res, 200, {
        ok: true,
        config: value,
        style: { path, count: store.entries.length, preview: renderStyleBlock(store.entries, { limit: 5 }) },
        levels: HUMANIZER_LEVELS,
      });
    } catch (error) {
      diagnostics.warn('roleplay.state', {}, error);
      sendJson(res, 502, { ok: false, error: '读取角色扮演设置失败。' });
    }
  };
  const config = async (req, res) => {
    try {
      const patch = await readJson(req, MAX_BODY_BYTES);
      const before = settings.read();
      const next = await settings.write(patch || {});
      const changed = Object.keys(patch || {}).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]));
      sendJson(res, 200, { ok: true, config: next, changed });
    } catch (error) {
      const code = error?.code || 'config-invalid';
      diagnostics.warn('roleplay.config', { code }, error);
      sendJson(res, statusFor(code), { ok: false, error: code === 'payload-too-large' ? '设置请求体过大。' : '设置写入失败。' });
    }
  };
  const checkText = async (req, res) => {
    try {
      const body = await readJson(req, MAX_BODY_BYTES);
      const text = typeof body?.text === 'string' ? body.text : '';
      if (text.trim() === '') throw Object.assign(new Error('empty-text'), { code: 'bad-json' });
      const value = settings.read();
      const level = typeof body?.level === 'string' && body.level.trim() !== '' ? body.level.trim() : value.humanizerLevel;
      const result = check(text.slice(0, MAX_TEXT_CHARS), { level });
      sendJson(res, 200, { ok: true, level: result.level, score: result.score, hits: result.hits, report: renderReport(result) });
    } catch (error) {
      const code = error?.code || 'check-failed';
      sendJson(res, statusFor(code), { ok: false, error: code === 'payload-too-large' ? '自检文本过长。' : '自检失败。' });
    }
  };
  const style = async (req, res) => {
    try {
      const value = settings.read();
      if (req.method === 'GET') {
        const { path, store } = await readStyle(value);
        sendJson(res, 200, { ok: true, path, count: store.entries.length, entries: store.entries.slice(0, 64) });
        return;
      }
      const body = await readJson(req, MAX_BODY_BYTES);
      const incoming = parseStyleEntries(typeof body?.entries === 'string' ? body.entries : JSON.stringify(body?.entries ?? []));
      const { path, store } = await readStyle(value);
      const merged = incoming.length === 0 ? store.entries : mergeStyleEntries(store.entries, incoming);
      if (incoming.length > 0) await writeStyle(path, merged);
      sendJson(res, 200, { ok: true, path, count: merged.length, added: Math.max(0, merged.length - store.entries.length) });
    } catch (error) {
      const code = error?.code || 'style-failed';
      diagnostics.warn('roleplay.style', { code }, error);
      sendJson(res, statusFor(code), { ok: false, error: code === 'payload-too-large' ? '风格库请求体过大。' : '风格库操作失败。' });
    }
  };
  return { state, config, check: checkText, style };
}

/**
 * Mount the host half: settings namespace plus the four routes.
 *
 * @param ctx - the host-scope context this row is loaded into.
 */
export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    const settings = createRoleplaySettingsBoundary();
    const handlers = createFairyRoleplayHandlers({ settings });
    ctx.inject(['settings'], (settingsCtx) => {
      settings.attach(settingsCtx.settings.register(FAIRY_ROLEPLAY_SETTINGS, FairyRoleplaySettings));
    }, { surface: 'host' });
    ctx.inject(['webServer'], (ws) => {
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-roleplay/state', handler: handlers.state }), 'dsh-fairy-roleplay: state');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-roleplay/config', handler: handlers.config }), 'dsh-fairy-roleplay: config');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-roleplay/check', handler: handlers.check }), 'dsh-fairy-roleplay: check');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: '/fairy-roleplay/style', handler: handlers.style }), 'dsh-fairy-roleplay: style');
    }, { surface: 'host' });
  }, { surface: 'host' });
}
