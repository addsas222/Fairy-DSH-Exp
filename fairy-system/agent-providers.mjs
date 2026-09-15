#!/usr/bin/env node
/**
 * `agent-providers.mjs` —— 外部 agent provider 的**只读**就绪体检。
 *
 * 为什么需要它：DSH 的外部 agent（Codex / Claude Code 这类）要能用，需要**四环同时闭合**：
 *
 *   1) bundle   —— profile 里装了对应的 `@deepseek-ai/dsh-subagent-<id>`，且版本与本机核心**同线**
 *   2) 宿主行   —— host 组合（`profiles/web/cordis.patch.yml`）里为该 provider 摆了 provider 行
 *   3) 原生 CLI —— 那个产品的命令行在 PATH 上（provider 是**驱动**它，不是替代它）
 *   4) preset 行—— 某个 preset 里有 `tool-subagent-<id>`，且没被 `disabled` 挡住
 *
 * 四环里任何一环缺失，行的表现都是「**不激活**」——不报错，只是工具不出现。所以平时看不出缺哪环，
 * 事到临头要一个个试。这个脚本一次把四环都读出来，并明确说「缺哪一环、下一步做什么」。
 *
 * 上游现状（`CHECKED_AT`，实测）：整条 `@deepseek-ai` 发布线**只有** codex 与 claude-code
 * 两个 provider bundle，其余候选名都不存在。所以除「已发布候选」外还维护一份 **CLI 观察名单**：
 * 本机装了命令行、DSH 侧还没有 bundle 的产品。上游一发包，这里的表就该加一行。
 *
 * 两条判定经验（别回退）：
 *   - **同线用「主次版本段相等」，不用 semver range**：上游 bundle 的 `^0.0.1-rc.1` 与本机
 *     `0.1.1-rc.2` 是**不同发布线**——range 判会得出「不满足」，而真正的结论是「根本不该装」。
 *   - **preset 行扫按缩进块**（行边界 = `^\s*-\s*id:`，行尾按 `\r\n|\n|\r` 三分裂），
 *     不用正则前瞻：前瞻版本在同一份 `agent.cordis.yml` 上把行内明明有的 `disabled: true`
 *     判成了 false，且对行尾形态敏感。
 *
 * 用法：
 *   node fairy-system/agent-providers.mjs [--home <DSH_HOME>] [--json]
 *
 * 退出码：0 至少一个 provider 四环闭合 ｜ 1 有候选但都没闭合 ｜ 2 环境不对（找不到 profile）
 *
 * 「生态里还有没有别的候选」是联网结论，本地判不了——候选表硬编码，所以它不参与退出码。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { READY: 0, NOT_CLOSED: 1, USAGE: 2 };

/** 本文件的核对日期：表里两栏（已发布候选 / CLI 观察名单）都在这一天逐包实测过。 */
export const CHECKED_AT = '2026-09-15';

/** 上游**已发布** provider bundle 的候选（实测：整条发布线只有这两个）。 */
export const PUBLISHED = [
  { id: 'codex', cliName: 'codex', label: 'OpenAI Codex' },
  { id: 'claude-code', cliName: 'claude', label: 'Claude Code' },
];

/** CLI 观察名单：本机有命令行、DSH 侧还没有 bundle 的产品。
 *  它们不需要行动，只需要在上游发 bundle 时被想起来（那时把 id 挪进 PUBLISHED）。 */
export const WATCH = [
  { id: 'gemini', cliName: 'gemini', label: 'Gemini CLI' },
  { id: 'qwen', cliName: 'qwen', label: 'Qwen Code' },
  { id: 'opencode', cliName: 'opencode', label: 'opencode' },
  { id: 'aider', cliName: 'aider', label: 'Aider' },
  { id: 'cursor', cliName: 'cursor-agent', label: 'Cursor Agent' },
  { id: 'copilot', cliName: 'copilot', label: 'GitHub Copilot CLI' },
  { id: 'goose', cliName: 'goose', label: 'Goose' },
  { id: 'crush', cliName: 'crush', label: 'Crush' },
  { id: 'droid', cliName: 'droid', label: 'Factory Droid' },
  { id: 'kimi', cliName: 'kimi', label: 'Kimi CLI' },
  { id: 'pi', cliName: 'pi', label: 'pi coding agent' },
  { id: 'codebuddy', cliName: 'codebuddy', label: 'CodeBuddy Code' },
];

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 包可能落在 profile 自己的 node_modules，也可能被提升到 profiles/node_modules —— 两处都看。 */
export function nodeModulesRoots(home) {
  const profile = path.join(home, 'profiles', 'web');
  return [path.join(profile, 'node_modules', '@deepseek-ai'), path.join(home, 'profiles', 'node_modules', '@deepseek-ai')];
}

/** Node 解析顺序：先近后远。 */
export function pkgJson(roots, name) {
  for (const base of roots) {
    const pkg = readJson(path.join(base, name, 'package.json'));
    if (pkg) return pkg;
  }
  return null;
}

/** 同线判定：主次版本段一致（0.1.1-rc.2 与 0.1.1-rc.9 同线；0.0.1-rc.1 不同线）。 */
export function sameLine(left, right) {
  if (!left || !right) return null;
  return String(left).split('-')[0] === String(right).split('-')[0];
}

export function cliLookup(name, run = execFileSync) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const first = run(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim().split(/\r?\n/)[0];
    let version = null;
    for (const args of [['--version'], ['-v'], ['version']]) {
      try {
        version = run(first, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim().split(/\r?\n/)[0].slice(0, 40);
        if (version) break;
      } catch { /* 有的 CLI 不吃这个参数 */ }
    }
    return { present: true, path: first, version };
  } catch { return { present: false, path: null, version: null }; }
}

/** preset 行：谁挂了 `tool-subagent-<id>`，以及是否被 disabled 挡住（按缩进块扫行，见文件头）。 */
export function presetRows(presetsDir, id) {
  const found = [];
  if (!existsSync(presetsDir)) return found;
  const rowStart = /^\s*-\s*id:\s*(\S+)\s*$/;
  const want = `tool-subagent-${id}`;
  for (const entry of readdirSync(presetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(presetsDir, entry.name, 'agent.cordis.yml');
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r\n|\n|\r/);
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(rowStart);
      if (!match || match[1] !== want) continue;
      let disabled = false;
      for (let k = i + 1; k < lines.length; k += 1) {
        if (rowStart.test(lines[k])) break;
        if (/^\s*disabled:\s*true\s*$/.test(lines[k])) disabled = true;
      }
      found.push({ preset: entry.name, line: i + 1, disabled });
    }
  }
  return found;
}

export function hostRow(profileDir, id) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) return false;
  return new RegExp(`provider(Name)?:\\s*${id}\\b`).test(readFileSync(file, 'utf8'));
}

/** 四环一次读完。`run` 可注入（测试用假 CLI 查找）。 */
export function collect({ home, run = execFileSync }) {
  const profile = path.join(home, 'profiles', 'web');
  const roots = nodeModulesRoots(home);
  const core = pkgJson(roots, 'dsh-subagent')?.version ?? null;
  const rows = [];
  for (const candidate of [...PUBLISHED, ...WATCH.map((entry) => ({ ...entry, watch: true }))]) {
    const pkg = pkgJson(roots, `dsh-subagent-${candidate.id}`);
    const bundle = { installed: Boolean(pkg), version: pkg?.version ?? null, peer: pkg?.peerDependencies?.['@deepseek-ai/dsh-subagent'] ?? null };
    const cli = cliLookup(candidate.cliName, run);
    const presets = presetRows(path.join(home, '.agent-presets'), candidate.id);
    const rings = {
      bundle: bundle.installed && sameLine(bundle.version, core) !== false,
      hostRow: hostRow(profile, candidate.id),
      cli: cli.present,
      presetRow: presets.some((entry) => !entry.disabled),
    };
    rows.push({ ...candidate, watch: Boolean(candidate.watch), bundle, cli, presets, rings, closed: Object.values(rings).every(Boolean) });
  }
  return { home, profile, core, rows, usable: rows.filter((row) => !row.watch && row.closed).map((row) => row.id) };
}

export function renderHuman(report) {
  const lines = [];
  const mark = (value) => (value ? '✅' : '· ');
  lines.push(`外部 agent provider 就绪体检（核对日期 ${CHECKED_AT}）   核心 dsh-subagent @ ${report.core ?? '(未找到)'}`);
  lines.push(`home: ${report.home}`);
  lines.push('');
  lines.push('四环 = bundle / 宿主行 / 原生 CLI / preset 行（未 disabled）');
  lines.push('');
  lines.push(`  ${'provider'.padEnd(14)}${'bundle'.padEnd(22)}${'宿主 CLI'.padEnd(20)}${'preset'.padEnd(24)}闭合`);
  lines.push(`  ${'-'.repeat(88)}`);
  for (const row of report.rows) {
    const bundle = row.bundle.installed ? `${row.bundle.version}${sameLine(row.bundle.version, report.core) === false ? ' ⚠异线' : ''}` : '未装';
    const cli = row.cli.present ? (row.cli.version ?? '在') : '未装';
    const presets = row.presets.length ? row.presets.map((entry) => `${entry.preset}${entry.disabled ? '(disabled)' : ''}`).join(',') : '—';
    lines.push(`  ${row.id.padEnd(14)}${`${mark(row.bundle.installed)}${bundle}`.padEnd(22)}${` ${mark(row.rings.hostRow)} ${mark(row.cli.present)}${cli}`.padEnd(20)}${` ${mark(row.rings.presetRow)}${presets}`.padEnd(24)} ${row.closed ? '✅' : ''}${row.watch ? ' 观察' : ''}`);
  }
  lines.push('');
  lines.push('缺环与下一步：');
  const published = report.rows.filter((row) => !row.watch);
  for (const row of published) {
    const missing = Object.entries(row.rings).filter(([, value]) => !value).map(([key]) => key);
    if (!missing.length) { lines.push(`  ${row.id}: 四环闭合，可直接启用。`); continue; }
    const next = [];
    if (missing.includes('bundle')) next.push(`装 @deepseek-ai/dsh-subagent-${row.id}（版本必须落在 ${report.core ?? '当前核心'} 同一线）`);
    if (missing.includes('hostRow')) next.push('在 profiles/web/cordis.patch.yml 摆该 provider 的宿主行');
    if (missing.includes('cli')) next.push(`装 ${row.cliName} 命令行并登录`);
    if (missing.includes('presetRow')) next.push(`preset 里 tool-subagent-${row.id} 去掉 disabled`);
    lines.push(`  ${row.id}: 缺 ${missing.join(' / ')}`);
    lines.push(`      → ${next.join('；')}`);
  }
  lines.push('');
  lines.push('观察名单（本机 CLI 在、DSH 侧还没 bundle；上游一发包就只差装包）：');
  const watching = report.rows.filter((row) => row.watch && row.cli.present);
  if (watching.length) for (const row of watching) lines.push(`  ${row.id.padEnd(12)} ${row.cli.version ?? ''}  ${row.cli.path}`);
  else lines.push('  （无）');
  lines.push('');
  lines.push(`结论：${report.usable.length ? `可用 ${report.usable.length} 个：${report.usable.join(', ')}` : '当前没有任何外部 agent provider 可用。'}`);
  lines.push('启用步骤与前置条件：fairy-system/AGENT-PROVIDERS.md');
  return lines.join('\n');
}

/** 退出码判定（与文件头声明一致）：环境不对 2 / 有候选但都没闭合 1 / 至少一个闭合 0。 */
export function exitCodeFor(report) {
  if (!existsSync(report.profile)) return EXIT.USAGE;
  return report.usable.length ? EXIT.READY : EXIT.NOT_CLOSED;
}

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') options.home = argv[++i];
    else if (argv[i] === '--json') options.json = true;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const report = collect({ home: options.home });
  if (options.json) process.stdout.write(`${JSON.stringify({ checkedAt: CHECKED_AT, core: report.core, usable: report.usable, rows: report.rows }, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(report)}\n`);
  if (!existsSync(report.profile)) {
    if (!options.json) process.stdout.write(`\n环境不对：找不到 profile ${report.profile}（用 --home 指到部署 home）\n`);
  }
  process.exitCode = exitCodeFor(report);
}
