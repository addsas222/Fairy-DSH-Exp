/**
 * Agent half of dsh-fairy-memory: the two tools a model actually calls to use
 * long-term memory. They read the same configuration the host bridge persists
 * (`$DSH_HOME/fairy-memory/config.json`), so no cross-plane service lookup is
 * involved and the tools work in every mode and preset.
 *
 * @module dsh-fairy-memory/engine
 */
import { readFile } from 'node:fs/promises';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { FAIRY_MEMORY_DEFAULTS, memoryConfigPath } from './index.js';
import { createMemoryRegistry } from './providers/index.js';

const diagnostics = createFairyDiagnostics('dsh-fairy-memory');
const TOOL_TIMEOUT_MS = 20_000;
const MAX_LIMIT = 20;

/** The mirror the bridge writes; a missing file means "not configured yet". */
export async function readMemorySettings() {
  try {
    const value = JSON.parse(await readFile(memoryConfigPath(), 'utf8'));
    return { ...FAIRY_MEMORY_DEFAULTS, ...value, providers: { ...FAIRY_MEMORY_DEFAULTS.providers, ...(value?.providers || {}) } };
  } catch {
    return FAIRY_MEMORY_DEFAULTS;
  }
}

function renderResults(value) {
  const lines = (value?.results || []).map((row, index) => {
    const source = row.source ? ` _(${row.source})_` : '';
    return `${index + 1}. ${row.text}${source}`;
  });
  if (lines.length === 0) return [`没有匹配的长期记忆。${value?.note ? ` ${value.note}` : ''}`];
  const footer = value?.note ? `\n注：${value.note}` : '';
  return [`长期记忆（${value?.provider || '未知来源'}）命中 ${lines.length} 条：\n${lines.join('\n')}${footer}`];
}

/**
 * `memory_recall`: durable facts the user or earlier sessions wrote, not the
 * transcript of this or another session (that is `session_recall`).
 */
export function createMemoryRecallTool({ registry = createMemoryRegistry({}), readSettings = readMemorySettings } = {}) {
  return {
    name: 'memory_recall',
    description: 'Search long-term memory: durable facts, preferences, decisions and notes that were '
      + 'explicitly written down for this brain (GBrain, mem0, a custom service, or the local markdown store). '
      + 'Use it for "what do I know about X" questions across sessions; use session_recall for what happened '
      + 'in past conversations of this project.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的自然语言查询（中英文皆可）。' },
        limit: { type: 'number', description: `最多返回多少条（1-${MAX_LIMIT}，默认 6）。` },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                text: { type: 'string' },
                source: { type: ['string', 'null'] },
                score: { type: ['number', 'null'] },
              },
              required: ['text'],
            },
          },
          note: { type: 'string' },
        },
        required: ['results'],
      },
      render: (_args, value) => renderResults(value).map((text) => ({ type: 'text', text })),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        const error = new Error('memory_recall needs a non-empty query');
        error.code = 'INVALID_ARGS';
        throw error;
      }
      const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args?.limit) || 6));
      const settings = await readSettings();
      const { id, provider, config } = registry.resolve(settings);
      const answer = await provider.recall({ query, limit }, config, undefined);
      return { provider: id, results: Array.isArray(answer?.results) ? answer.results : [], ...(answer?.note ? { note: answer.note } : {}) };
    },
  };
}

/** `memory_remember`: write one durable fact with its provenance. */
export function createMemoryRememberTool({ registry = createMemoryRegistry({}), readSettings = readMemorySettings } = {}) {
  return {
    name: 'memory_remember',
    description: 'Write one durable fact to long-term memory - a preference, a decision, a commitment, or a '
      + 'note worth having in a later session. Keep it to one fact per call and write it so it still makes '
      + 'sense months later. Ephemeral details (today\'s weather, a transient typo) do not belong here.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的事实本身，一到三句话。' },
        tags: { type: 'array', description: '可选标签，最多 8 个。', items: { type: 'string' } },
        source: { type: 'string', description: '出处（文件、会话或用户原话）。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          provider: { type: 'string' },
          id: { type: ['string', 'null'] },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.ok === true
          ? `已写入长期记忆（${value?.provider || '未知来源'}${value?.id ? `：${value.id}` : ''}）。`
          : '没有写入长期记忆。',
      }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) {
        const error = new Error('memory_remember needs non-empty text');
        error.code = 'INVALID_ARGS';
        throw error;
      }
      const tags = Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 8) : [];
      const source = typeof args?.source === 'string' && args.source.trim() ? args.source.trim().slice(0, 200) : 'agent';
      const settings = await readSettings();
      const { id, provider, config } = registry.resolve(settings);
      const answer = await provider.remember({ text, tags, source }, config, undefined);
      return { ok: true, provider: id, id: answer?.id ?? null };
    },
  };
}

/** Mount the agent half: both tools, in every mode. */
export function apply(ctx) {
  return diagnostics.guard('apply', () => {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(createMemoryRecallTool({}));
      toolCtx.tools.register(createMemoryRememberTool({}));
    });
  }, { surface: 'agent' });
}
