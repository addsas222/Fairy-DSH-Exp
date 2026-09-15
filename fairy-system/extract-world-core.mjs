/**
 * 把《绝区零》官方 TextMap 抽成 fairy preset 的 world-core 行式索引。
 *
 * 用法：
 *   node fairy-system/extract-world-core.mjs --src <TextMap 目录> [--out <输出目录>]
 * 默认：src = $ZZZ_TEXT_DIR 或 C:/tmp/zzz-text；out = .agent-presets/fairy-lite/world-core（被 .gitignore 挡住）
 *
 * 输入：TextMapTemplateTb.json + TextMapOverwriteTemplateTb.json（**简体源**；同 dump 另有
 *   TextMap_CHT* 繁体版，本项目不用，也不做繁→简机转——那会让证据键指向与源字节不符的内容）。
 *   来源：dimbreath/ZenlessData（git.mero.moe 镜像）。
 * 输出：<out>/<entity>.jsonl（每行 {key, text}，key 为游戏原始文本键，可作证据引用）+ MANIFEST.json
 *
 * 为什么按行输出：3.5 万条 / 6MB，runtime 检索时全量 JSON.parse 不划算；行式可逐行扫描、按需中断。
 *
 * 实体词头（ENTITIES）是本文档的**策展**部分：按游戏内实际用词写的简繁成对表，
 * 且**顺序即优先级**（先命中先归属）——例如 proxy（绳匠/代理人）必须排在 interknot（绳网）之前，
 * 否则「绳匠」会被 interknot 抢走。改词头前先跑一次看各实体条数，0 条或异常低通常意味着词头不对
 * （历史案例：第六街→六分街 0→1347 条；HDD 漏了 H.D.D. 写法 67→390 条）。
 *
 * 版权：游戏文本归 miHoYo/HoYoverse，仅本机使用，不随仓库/部署分发。
 */
import { createReadStream, mkdirSync, writeFileSync, statSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: {
  src: { type: 'string' }, out: { type: 'string' },
}, allowPositional: true });
const SRC_DIR = values.src ?? process.env.ZZZ_TEXT_DIR ?? 'C:/tmp/zzz-text';
const OUT_DIR = values.out ?? '.agent-presets/fairy-lite/world-core';
const FILES = ['TextMapTemplateTb.json', 'TextMapOverwriteTemplateTb.json'];

const ENTITIES = {
  fairy: ['Fairy', '许愿精灵', '許願精靈', 'Ⅲ型总序集成泛用人工智能', 'Ⅲ型總序集成泛用人工智慧'],
  youkai: ['妖怪', 'Youkai', '妖鬼'],
  ghost: ['幽魂', 'Ghost'],
  jinni: ['魔精', 'Jinni'],
  phaethon: ['法厄同', 'Phaethon'],
  wise: ['哲', 'Wise'],
  belle: ['铃', '鈴', 'Belle'],
  hdd: ['H.D.D.', 'HDD', '空洞深潜系统', '空洞深潛系統'],
  proxy: ['绳匠', '繩匠', '代理人'],
  interknot: ['绳网', '繩網', 'Inter-Knot'],
  hollow: ['空洞', '零号空洞', '零號空洞'],
  ether: ['以太', '乙太'],
  newEridu: ['新艾利都'],
  sixStreet: ['六分街'],
  randomPlay: ['Random Play', '随机播放', '隨機播放'],
};

mkdirSync(OUT_DIR, { recursive: true });
const streams = {};
for (const id of Object.keys(ENTITIES)) streams[id] = createWriteStream(path.join(OUT_DIR, `${id}.jsonl`), { encoding: 'utf8' });

const counts = {};
const seen = new Set();
let scanned = 0;

for (const file of FILES) {
  const full = path.join(SRC_DIR, file);
  const rl = createInterface({ input: createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    scanned++;
    const m = /^\s*"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    if (key.startsWith('//')) continue;
    let value;
    try { value = JSON.parse(`"${m[2]}"`); } catch { continue; }
    if (!value || value.length < 2) continue;

    for (const [id, needles] of Object.entries(ENTITIES)) {
      if (!needles.some((n) => value.includes(n))) continue;
      const dedupe = `${id}\u0000${value}`;
      if (seen.has(dedupe)) break;
      seen.add(dedupe);
      counts[id] = (counts[id] ?? 0) + 1;
      streams[id].write(`${JSON.stringify({ key, text: value.slice(0, 400) })}\n`);
      break;
    }
  }
  console.log(`${file}: 扫描 ${scanned} 行`);
}
for (const s of Object.values(streams)) s.end();
await new Promise((r) => setTimeout(r, 400));

writeFileSync(path.join(OUT_DIR, 'MANIFEST.json'), JSON.stringify({
  schema_version: '1.0',
  format: 'jsonl（每行 {key, text}，key 即游戏原始文本键，可作证据引用）',
  source: 'dimbreath/ZenlessData（git.mero.moe 镜像）· 简体源 TextMapTemplateTb.json + TextMapOverwriteTemplateTb.json（同 dump 的简体版，非机器转换）',
  game_version: '3.2.0',
  license_note: '游戏文本版权归 miHoYo/HoYoverse；仅本机使用，不随仓库/部署分发（.gitignore 已挡）。',
  extracted_at: new Date().toISOString(),
  scanned_lines: scanned,
  total_entries: Object.values(counts).reduce((a, b) => a + b, 0),
  per_entity: counts,
}, null, 2));

console.log('\n行式索引:');
for (const [id, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id.padEnd(12)} ${String(n).padStart(6)} 条  ${(statSync(path.join(OUT_DIR, `${id}.jsonl`)).size / 1024).toFixed(0)} KB`);
}
