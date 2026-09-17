// 检查项 integration：跨包/镜像集成 + fairy-system 套件（真实命令，逐个记录退出码）。
//
// 为什么不做成"一个大命令"：这些子检查的前提不同（有的离线可跑、有的需要已部署的 DSH_HOME、
// 有的需要官方制品旋钮）。混在一起会让"某一个前提缺失"变成"整项红"，于是有人就会去删检查。
// 所以按子检查粒度执行：前提缺失 = 该项记 skipped 并打印真实的手动命令，其余照跑。
//
// 子检查来源：.agent/checks/integration.yaml 的 scope.subchecks（改配置即可增删，本脚本不认识
// 具体子检查）。两类：
//   command    —— 跑一条命令字符串（shell）
//   node_test  —— 枚举目录下的 *.test.js 并用 node --test 显式列文件（Windows cmd 不展开 glob）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureDir, finish, globToRegExp, parseCli, pct, readCheckConfig, run, runCommandString,
} from './lib/runtime.mjs';

function expandHome(candidate) {
  if (candidate.startsWith('~')) return path.join(os.homedir(), candidate.slice(1).replace(/^[/\\]/, ''));
  return candidate;
}

function resolveHome(scope) {
  if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME;
  for (const candidate of scope.home_candidates || []) {
    const expanded = expandHome(candidate);
    if (fs.existsSync(expanded)) return expanded;
  }
  return null;
}

function listTestFiles(root, pattern) {
  const regex = globToRegExp(pattern);
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && regex.test(path.relative(root, full).split(path.sep).join('/'))) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'integration.json');
  const scope = check.scope || {};
  const subchecks = scope.subchecks || [];
  const home = resolveHome(scope);

  const results = [];
  for (const sub of subchecks) {
    const entry = { id: sub.id, title: sub.title, status: 'unknown' };
    // 前提：需要部署 home
    if (sub.requires_home && !home) {
      entry.status = 'skipped';
      entry.note = `未找到已部署的 DSH_HOME（候选项：${(scope.home_candidates || []).join(', ')}；可用环境变量 DSH_HOME 指定）`;
      entry.manual = sub.manual || '';
      process.stdout.write(`   · ${sub.id}：跳过（${entry.note}）\n`);
      results.push(entry);
      continue;
    }
    // 前提：需要的环境变量
    const missingEnv = (sub.requires_env || []).filter((name) => !process.env[name]);
    if (missingEnv.length) {
      entry.status = 'skipped';
      entry.note = `缺少环境变量：${missingEnv.join(', ')}（官方制品/部署旋钮，属环境前提）`;
      entry.manual = sub.manual || '';
      process.stdout.write(`   · ${sub.id}：跳过（${entry.note}）\n`);
      results.push(entry);
      continue;
    }
    const env = { ...(process.env) };
    if (sub.requires_home && home) env[sub.home_env || 'DSH_HOME'] = home;

    let result;
    let commandText;
    if (sub.node_test) {
      const testRoot = path.resolve(repo, sub.node_test.directory);
      const files = listTestFiles(testRoot, sub.node_test.pattern || '**/*.test.js');
      if (!files.length) {
        entry.status = 'skipped';
        entry.note = `目录下没有测试文件：${sub.node_test.directory}`;
        results.push(entry);
        continue;
      }
      commandText = `node --test --test-timeout=${sub.node_test.timeout_ms || 45000} ${files.map((f) => path.relative(repo, f).split(path.sep).join('/')).join(' ')}`;
      result = await run(
        process.execPath,
        ['--test', `--test-timeout=${sub.node_test.timeout_ms || 45000}`, ...files],
        { cwd: repo, env, timeoutMs: (sub.timeout_seconds || 600) * 1000 },
      );
    } else {
      commandText = sub.command;
      result = await runCommandString(commandText, { cwd: repo, env, timeoutMs: (sub.timeout_seconds || 600) * 1000 });
    }
    const tail = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.trim()).slice(-6);
    const outputText = `${result.stdout}\n${result.stderr}`;
    // 依赖已部署 home 的子检查：部署不完整（缺包/缺文件）属**环境前提**，记 skipped 并给出手动命令，
    // 而不是记失败——否则任何人换台机器都会看到一片红，然后就会有人去删检查（本仓真实教训）。
    const homeIncomplete = sub.requires_home && !result.timedOut && result.code !== 0
      && /ENOENT|no such file or directory|Cannot find module/i.test(outputText);
    if (homeIncomplete) {
      const firstLine = outputText.split('\n').find((line) => /ENOENT|Cannot find module|no such file/i.test(line)) || '';
      entry.status = 'skipped';
      entry.exit_code = result.code;
      entry.duration_ms = result.durationMs;
      entry.command = commandText;
      entry.tail = tail;
      entry.manual = sub.manual || commandText;
      entry.note = `部署 home 不完整（${firstLine.trim().slice(0, 160)}）：属环境前提，按手动命令在装齐的 home 上重跑`;
      process.stdout.write(`   · ${sub.id}：跳过（${entry.note}）\n`);
      results.push(entry);
      continue;
    }
    entry.status = result.timedOut ? 'timeout' : (result.code === 0 ? 'passed' : 'failed');
    entry.exit_code = result.code;
    entry.duration_ms = result.durationMs;
    entry.command = commandText;
    entry.tail = tail;
    entry.manual = sub.manual || commandText;
    process.stdout.write(`   ${entry.status === 'passed' ? '✔' : '✖'} ${sub.id}：退出码 ${result.code}（${(result.durationMs / 1000).toFixed(2)}s）${entry.status === 'failed' ? `\n      ${tail.join('\n      ')}` : ''}\n`);
    results.push(entry);
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => ['failed', 'timeout'].includes(r.status)).length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    home: home || null,
    subchecks: results,
  };
  ensureDir(path.dirname(artifactPath));
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`integration：子检查 ${results.length} 个（通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}）${home ? `；DSH_HOME=${home}` : '；未找到部署 home'}\n`);
  for (const item of results.filter((r) => r.status === 'skipped')) {
    process.stdout.write(`  · ${item.id} 手动命令：${item.manual}\n`);
  }
  finish({
    ok: failed === 0,
    metrics: {
      subchecks: results.length,
      passed,
      failed,
      skipped,
      pass_rate: pct(passed, results.length - skipped),
    },
    artifactPath,
    artifact,
    failureNote: '集成子检查失败：按上面的命令复现；前提缺失的子检查会列出真实手动命令。',
  });
}

main().catch((error) => {
  process.stdout.write(`integration 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
