#!/usr/bin/env node
/**
 * Memory CLI: the same providers the host bridge and the agent tools use,
 * reachable from any shell. It exists because a harness that cannot load agent
 * tools (or a person at a terminal) still needs a way to write and read durable
 * memory, and because it is the shortest honest way to verify an engine works.
 *
 * Usage:
 *   node lib/memory-cli.js recall "query" [--limit 6]
 *   node lib/memory-cli.js remember "text" [--tag a --tag b] [--source note]
 *   node lib/memory-cli.js count
 *   node lib/memory-cli.js doctor
 *   node lib/memory-cli.js candidates [id]
 *   node lib/memory-cli.js evomap status
 *   node lib/memory-cli.js evomap join [--name "My Agent"] [--model <model-id>]
 *
 * `evomap join` follows Layer 1 of https://evomap.ai/skill.md and stops there:
 * it recovers an existing node or registers one, then prints the claim URL for
 * the user to open. It never prints the node secret and never starts the
 * heartbeat or task layers - those need their own explicit request.
 */
import { createMemoryRegistry } from './providers/index.js';
import { readMemorySettings } from './engine.js';
import { MEMORY_CANDIDATES, buildInstallPlan, findCandidate, renderInstallPlan } from './candidates.js';
import { evoMapStatus, joinEvoMap, withTimeout } from './evomap.js';

function parseArgs(argv) {
  const positionals = [];
  const flags = { tags: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--limit' || arg === '--source' || arg === '--tag' || arg === '--name' || arg === '--model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} 需要一个取值` };
      if (arg === '--limit') flags.limit = Number(value);
      else if (arg === '--source') flags.source = value;
      else if (arg === '--name') flags.name = value;
      else if (arg === '--model') flags.model = value;
      else flags.tags.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `未知参数 ${arg}` };
    positionals.push(arg);
  }
  return { positionals, flags };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const [argument] = parsed.positionals;
  // 候选目录不需要运行中的实例、也不碰配置：先把这条命令摘出来。
  if (command === 'candidates') {
    if (argument) {
      const plan = buildInstallPlan(findCandidate(argument));
      if (!plan) {
        process.stderr.write(`未知候选：${argument}（用不带参数的 candidates 看全部）\n`);
        return 2;
      }
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n\n${renderInstallPlan(plan)}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify({ candidates: MEMORY_CANDIDATES }, null, 2)}\n`);
    return 0;
  }
  const registry = createMemoryRegistry({});
  const settings = await readMemorySettings();
  const { id, provider, config, fallback } = registry.resolve(settings);

  if (command === 'evomap') {
    const action = argument || 'status';
    if (action === 'status') {
      process.stdout.write(`${JSON.stringify(await evoMapStatus(), null, 2)}\n`);
      return 0;
    }
    if (action === 'join') {
      const result = await withTimeout((signal) => joinEvoMap({
        name: parsed.flags.name || '',
        model: parsed.flags.model || '',
        signal,
      }));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.claimUrl) {
        process.stdout.write(`\n打开这个链接即可把节点绑定到你的 EvoMap 账号：\n${result.claimUrl}\n`);
      }
      return result.status === 'unreachable' || result.status === 'failed' ? 1 : 0;
    }
    process.stderr.write('用法：evomap <status|join> [--name X] [--model Y]\n');
    return 2;
  }
  if (command === 'doctor') {
    const providers = await registry.list(settings);
    process.stdout.write(`${JSON.stringify({ provider: id, fallback, config: { ...config, token: config.token ? '***' : '', apiKey: config.apiKey ? '***' : '' }, providers }, null, 2)}\n`);
    return 0;
  }
  if (command === 'count') {
    if (typeof provider.count !== 'function') {
      process.stdout.write(`${JSON.stringify({ provider: id, count: null, note: '该提供方不支持计数。' })}\n`);
      return 0;
    }
    const count = await provider.count(config, undefined);
    process.stdout.write(`${JSON.stringify({ provider: id, count })}\n`);
    return 0;
  }
  if (command === 'recall') {
    if (!argument) {
      process.stderr.write('用法：recall "查询词" [--limit N]\n');
      return 2;
    }
    const limit = Math.max(1, Math.min(20, Number(parsed.flags.limit) || 6));
    const answer = await provider.recall({ query: argument, limit }, config, undefined);
    process.stdout.write(`${JSON.stringify({ provider: id, ...answer }, null, 2)}\n`);
    return 0;
  }
  if (command === 'remember') {
    if (!argument) {
      process.stderr.write('用法：remember "要记住的内容" [--tag a] [--source note]\n');
      return 2;
    }
    const answer = await provider.remember({
      text: argument,
      tags: parsed.flags.tags,
      source: parsed.flags.source || 'cli',
    }, config, undefined);
    process.stdout.write(`${JSON.stringify({ ok: true, provider: id, id: answer?.id ?? null })}\n`);
    return 0;
  }
  process.stderr.write('用法：memory-cli.js <recall|remember|count|doctor|candidates|evomap> ...\n');
  return 2;
}

const exitCode = await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error?.message || '记忆命令失败。'}\n`);
  return 1;
});
process.exit(exitCode);
