/**
 * Agent half of dsh-fairy-roleplay: the two tools a roleplaying model actually
 * calls. They read the same configuration and style file the host bridge
 * persists (`$DSH_HOME/fairy-roleplay/`), so no cross-plane service lookup is
 * involved and the tools work in every preset.
 *
 * @module dsh-fairy-roleplay/engine
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { FAIRY_ROLEPLAY_DEFAULTS, roleplayConfigPath, roleplayStylePath } from './index.js';
import { readFileSync } from 'node:fs';
import { check, renderReport } from './humanizer.js';
import { buildRoleplayPrefsText } from './prefs.js';
import { mergeStyleEntries, parseStyleEntries, parseStyleFile, renderStyleBlock } from './style.js';

const diagnostics = createFairyDiagnostics('dsh-fairy-roleplay');
const TOOL_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 20_000;

/** 与宿主同路径的配置读取；缺文件即“还没配置过”。 */
export async function readRoleplaySettings(path = roleplayConfigPath()) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return { ...FAIRY_ROLEPLAY_DEFAULTS, ...value };
  } catch {
    return FAIRY_ROLEPLAY_DEFAULTS;
  }
}

async function readStyleFile(path) {
  try {
    return parseStyleFile(await readFile(path, 'utf8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeStyleFile(path, entries) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
}

/**
 * `roleplay_check`: 对候选回复跑确定性的去AI味检查，返回命中项与改法。
 * 检查不通过时模型应改写后重跑，而不是直接发出。
 */
export function createRoleplayCheckTool({ readSettings = readRoleplaySettings } = {}) {
  return {
    name: 'roleplay_check',
    description: 'Check a candidate roleplay reply for AI-sounding Chinese before sending it. '
      + 'Returns every hit (banned phrase, shell pattern, rhythm problem) with the suggested fix, or a pass. '
      + 'Use it right before you answer when the roleplay mode is on.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要自检的候选回复全文。' },
        level: { type: 'string', description: '覆盖档位：off|l1|l2|l3|l4（默认用设置里的档位）。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean' },
          level: { type: 'string' },
          score: { type: 'number' },
          hits: { type: 'number' },
          report: { type: 'string' },
        },
        required: ['passed', 'report'],
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : '';
      if (text.trim() === '') {
        const error = new Error('roleplay_check needs a non-empty text');
        error.code = 'INVALID_ARGS';
        throw error;
      }
      const settings = await readSettings();
      const level = typeof args?.level === 'string' && args.level.trim() !== '' ? args.level.trim() : settings.humanizerLevel;
      const result = check(text.slice(0, MAX_TEXT_CHARS), { level });
      return { passed: result.hits.length === 0, level: result.level, score: result.score, hits: result.hits.length, report: renderReport(result) };
    },
  };
}

/**
 * `roleplay_style`: 读或写角色的语言习惯（「当…时，可以用…」）。
 * 学习阶段交给模型抽取，本工具只做确定性合并与落盘。
 */
export function createRoleplayStyleTool({ readSettings = readRoleplaySettings, stylePath = roleplayStylePath } = {}) {
  return {
    name: 'roleplay_style',
    description: 'Read or extend the roleplay style library: short "situation → expression" habits of the character. '
      + 'action=list returns what is stored; action=learn merges a JSON array of {situation, style} entries (deduplicated, capped).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list 或 learn。' },
        entries: { type: 'string', description: 'learn 时的 JSON 数组文本（可含代码块）：[{"situation":"…","style":"…"}]。' },
        limit: { type: 'number', description: 'list 时最多返回多少条（默认 24）。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          total: { type: 'number' },
          added: { type: 'number' },
          report: { type: 'string' },
        },
        required: ['action', 'total', 'report'],
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
      const path = typeof stylePath === 'function' ? stylePath(await readSettings()) : stylePath;
      const current = await readStyleFile(path);
      if (action === 'list') {
        const limit = Math.max(1, Math.min(64, Number(args?.limit) || 24));
        const block = renderStyleBlock(current.entries, { limit });
        return {
          action: 'list',
          total: current.entries.length,
          added: 0,
          report: block === '' ? '风格库还是空的：先用 action=learn 把本轮学到的表达写进去。' : `风格库共 ${current.entries.length} 条，前 ${Math.min(limit, current.entries.length)} 条：\n${block}`,
        };
      }
      if (action === 'learn') {
        const incoming = parseStyleEntries(args?.entries);
        if (incoming.length === 0) {
          return { action: 'learn', total: current.entries.length, added: 0, report: '没有解析到条目：需要 JSON 数组，元素含 situation 与 style 两个字段。' };
        }
        const merged = mergeStyleEntries(current.entries, incoming);
        await writeStyleFile(path, merged);
        const added = merged.length - current.entries.length;
        diagnostics.metric('roleplay.style.learn', undefined, { incoming: incoming.length, added });
        return {
          action: 'learn',
          total: merged.length,
          added: Math.max(0, added),
          report: `已写入 ${incoming.length} 条（新增 ${Math.max(0, added)}，去重后共 ${merged.length} 条）。`,
        };
      }
      const error = new Error("roleplay_style action must be 'list' or 'learn'");
      error.code = 'INVALID_ARGS';
      throw error;
    },
  };
}

/**
 * Mount the agent half.
 *
 * @param ctx - the agent-scope context this row is loaded into.
 */
export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    ctx.tools.register(createRoleplayCheckTool());
    ctx.tools.register(createRoleplayStyleTool());
    /* 动态段落：文本每轮按设置渲染（官方 plan-mode 用的同一种函数式 text）。顺序排在
     * 模式段落与流水线段落之后；拿不到 section 顺序的 cohort 用 53（plan 政策 50 之后）。 */
    const prefs = createPrefsReader();
    let cached = '';
    ctx.systemPrompt.section({
      name: 'fairy:roleplay-prefs',
      order: typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 3 : 53,
      text: () => cached,
    });
    void prefs().then((text) => { cached = text; });
    ctx.on?.('agent/pre-step', async (_payload, next) => {
      cached = await prefs();
      return next();
    });
  }, { surface: 'agent' });
}

/**
 * 设置卡 → 提示词：偏好段落按当前设置渲染，是那些开关的唯一消费者。
 *
 * ponytail: 1 秒记忆（与 persona 包同一策略）——设置改动最多 1 秒后生效，代价是
 * 每秒至多两次小文件读；升级路径：宿主在 /fairy-roleplay/config 写入后广播失效。
 */
function createPrefsReader({ getSettings = readRoleplaySettings, stylePath = roleplayStylePath } = {}) {
  let cache = { at: 0, text: '' };
  const readStyleEntries = (path) => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  };
  return async () => {
    const now = Date.now();
    if (now - cache.at > 1_000) {
      const settings = await getSettings();
      cache = { at: now, text: buildRoleplayPrefsText(settings, readStyleEntries(stylePath(settings))) };
    }
    return cache.text;
  };
}

export const inject = ['tools', 'systemPrompt'];
