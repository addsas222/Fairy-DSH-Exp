/**
 * Fairy 世界知识检索：按需读本机 world-core 行式索引。
 *
 * 语料来自 ZZZ 官方 TextMap（dimbreath/ZenlessData 镜像，游戏 v3.2.0），
 * 由 C:/tmp/zzz-extract2.mjs 提取为 `world-core/<entity>.jsonl`（每行 {key, text}）。
 * 版权归 miHoYo/HoYoverse：该目录被 .gitignore 挡住，只在本机使用。
 *
 * 为什么做成工具而不是把语料塞进系统提示：单条实体索引就有 1.7 MB（hollow 9339 条），
 * 全量注入会挤爆上下文。工具按 query 逐行扫描、命中即返回，并带上原始 key 作为证据引用。
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const WORLD_CORE_SECTION = 'fairy-world-core';
const WORLD_CORE_ORDER = 48;

function worldCoreDir() {
  const root = String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!root) return null;
  const dir = path.join(root, '.agent-presets', 'fairy', 'world-core');
  return existsSync(path.join(dir, 'MANIFEST.json')) ? dir : null;
}

function manifestOf(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')); } catch { return null; }
}

/** 列出可检索的实体（供工具在无参数时自述能力）。 */
function entitiesOf(dir) {
  const manifest = manifestOf(dir);
  return Object.keys(manifest?.per_entity ?? {});
}

/**
 * 在某个实体的索引里逐行检索。命中即收集，达到 limit 就停——大文件因此不必读完。
 * @returns [{key, text}]
 */
async function searchEntity(dir, entity, needles, limit) {
  const file = path.join(dir, `${entity}.jsonl`);
  if (!existsSync(file)) return [];
  const hits = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!needles.every((n) => row.text.includes(n))) continue;
    hits.push(row);
    if (hits.length >= limit) break;
  }
  rl.close();
  return hits;
}

/** 没有指定实体时，按全部实体扫一遍（较慢，但一次调用就能定位）。 */
async function searchAll(dir, needles, limit) {
  const out = [];
  for (const entity of entitiesOf(dir)) {
    if (out.length >= limit) break;
    const hits = await searchEntity(dir, entity, needles, limit - out.length);
    for (const hit of hits) out.push({ ...hit, entity });
  }
  return out;
}

export const inject = ['tools', 'systemPrompt'];

export async function apply(ctx, config = {}) {
  const dir = worldCoreDir();
  const disposers = [];

  if (dir && typeof ctx?.tools?.register === 'function') {
    const manifest = manifestOf(dir);
    disposers.push(ctx.tools.register({
      name: 'fairy_world_lookup',
      description:
        '查询《绝区零》官方文本（world-core 本地索引，游戏 v3.2.0）。'
        + `可检索实体：${entitiesOf(dir).join('、')}。`
        + '用于核对世界观事实（空洞、绳网、以太、代理人、法厄同、妖怪/幽魂/魔精 等）再落笔，'
        + '不要凭记忆编造；每条结果带原始文本键，可作证据引用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要匹配的原文片段（支持多个词，全部命中才算）' },
          entity: { type: 'string', description: '限定实体（如 fairy/hollow/interknot）；省略则全实体检索' },
          limit: { type: 'number', description: '返回条数上限，默认 8' },
        },
        required: ['query'],
      },
      async execute(args = {}) {
        const raw = String(args.query ?? '').split(/\s+/).filter(Boolean);
        if (raw.length === 0) return { content: [{ type: 'text', text: 'query 不能为空' }] };
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 50);
        const entity = args.entity ? String(args.entity) : null;
        const hits = entity
          ? (await searchEntity(dir, entity, raw, limit)).map((h) => ({ ...h, entity }))
          : await searchAll(dir, raw, limit);
        if (hits.length === 0) {
          return { content: [{ type: 'text', text: `world-core 中未找到匹配：${raw.join(' + ')}${entity ? `（entity=${entity}）` : ''}。不要据此编造，改用其它来源或说明样本不足。` }] };
        }
        const text = [
          `命中 ${hits.length} 条（源：${manifest?.source ?? 'world-core'}，游戏 ${manifest?.game_version ?? '?'}）`,
          ...hits.map((h) => `- [${h.entity}] ${h.text}\n  证据键: ${h.key}`),
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    }));
  }

  // 系统提示里只放"有这份索引 + 怎么用"，不放语料本体
  if (dir && typeof ctx?.systemPrompt?.section === 'function') {
    const manifest = manifestOf(dir);
    const summary = [
      '【Fairy 世界知识（world-core 本地索引）】',
      `源：《绝区零》官方文本 TextMap（游戏 ${manifest?.game_version ?? '?'}），本机索引 ${manifest?.total_entries ?? '?'} 条。`,
      `覆盖实体：${entitiesOf(dir).join('、')}。`,
      '需要世界观事实时用 fairy_world_lookup 检索后再落笔；检索不到就说样本不足，不要凭记忆编造。',
    ].join('\n');
    disposers.push(ctx.systemPrompt.section({ name: WORLD_CORE_SECTION, order: WORLD_CORE_ORDER, text: summary }));
  }

  return () => { for (const d of disposers.splice(0)) { try { d(); } catch {} } };
}
