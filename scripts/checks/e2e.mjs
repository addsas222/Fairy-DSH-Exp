// 检查项 e2e：端到端跑**真正的 CLI 子进程**（不是进程内调用），验证扩展闭环与报告产物。
//
// 为什么 e2e 和 gherkin 都要有：gherkin 在进程内验证 lib API 的行为；这里验证用户真正会用的入口
// （scripts/verify.mjs + 包装脚本语义）：参数解析、退出码、报告落盘、安装脚本生成、部分运行语义。
// 夹具仓库建在系统临时目录，跑完即删；每个场景断言的是"可观察结果"（退出码 + 真落盘的 JSON）。
//
// 场景：
//   1. 发现并执行新增检查项 → 退出码 0、报告 gate=pass、检查项 passed
//   2. 检查项失败 → 退出码 1、报告 gate=fail
//   3. 配置有错 → 退出码 2、明确报错、不生成报告（不静默跳过）
//   4. --list 列出发现的检查项（阶段与 required 状态）
//   5. --dry-run 打印将要执行的平台命令
//   6. --generate-install 真的生成 scripts/install.ps1（UTF-8 BOM + CRLF）与 install.sh（LF、无 sudo），
//      winget 带三件套参数、choco 只出现在注释里
//   7. 部分运行语义：默认只记警告；--strict-partial 判失败
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRepo } from './lib/fixture-repo.mjs';
import {
  ensureDir, finish, parseCli, pct, readCheckConfig, run, writeJson,
} from './lib/runtime.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERIFY = path.join(REPO_ROOT, 'scripts', 'verify.mjs');

const BROKEN_CHECK = `schema_version: 1
id: demo-broken
title: 故意缺 windows_command 的检查项
stage: static
type: static
enabled: true
required: true
tags: [demo]
command: 'node -e "process.exit(0)"'
unix_command: 'node -e "process.exit(0)"'
cwd: \${repo}
env: {}
timeout: 60
threshold:
  metrics: []
artifacts: []
requires: []
install: []
docs: docs/quality/demo-broken.md
owner: fixture
allow_failure: false
`;

const REQUIRES_BLOCK = `requires:
  - kind: tool
    name: demo-tool
    probe: node --version
    reason: 夹具：用于验证安装脚本生成的工具条目
    install:
      - strategy: winget
        command: winget install --id Example.Demo --source winget
        admin: false
      - strategy: scoop
        command: scoop install demo
        admin: false
      - strategy: choco
        command: choco install demo -y
        admin: true
        reason: 需要管理员权限：只写文档
    manual: 手动安装 demo 工具
`;

class ScenarioFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new ScenarioFailure(message);
}

async function cli(fixture, args) {
  const result = await run(process.execPath, [VERIFY, '--repo', fixture.dir, ...args], {
    cwd: REPO_ROOT,
    timeoutMs: 300_000,
  });
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
    report() {
      const file = path.join(fixture.dir, 'reports', 'quality-report.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    check(id) {
      const report = this.report();
      return report ? report.checks.find((c) => c.id === id) : null;
    },
  };
}

const scenarios = [
  {
    name: '发现并执行新增检查项（退出码 0、报告 gate=pass）',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-pass' });
      try {
        fixture.addCheck({ id: 'demo-ok', command: fixture.command('demo-ok'), metrics: { ok: 1 }, exitCode: 0 });
        const result = await cli(fixture, []);
        assert(result.code === 0, `退出码应为 0，实际 ${result.code}\n${result.output}`);
        const report = result.report();
        assert(report, '没有生成 reports/quality-report.json');
        assert(report.gate.status === 'pass', `报告 gate 应为 pass，实际 ${report.gate.status}`);
        const check = result.check('demo-ok');
        assert(check && check.status === 'passed', `demo-ok 状态应为 passed，实际 ${JSON.stringify(check)}`);
        assert(check.exit_code === 0, 'exit_code 应记录为 0');
        assert((check.threshold_results || []).length > 0, '报告里应有阈值判定明细');
        const logPath = path.join(fixture.dir, 'reports', 'verify.log');
        assert(fs.existsSync(logPath), '没有追加 reports/verify.log');
        assert(fs.readFileSync(logPath, 'utf8').includes('demo-ok'), 'verify.log 里没有这次运行的记录');
        return { exit_code: result.code, gate: report.gate.status };
      } finally {
        fixture.cleanup();
      }
    },
  },
  {
    name: '检查项失败 → 退出码 1、报告 gate=fail',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-fail' });
      try {
        fixture.addCheck({ id: 'demo-fail', command: fixture.command('demo-fail'), metrics: { ok: 0 }, exitCode: 1 });
        const result = await cli(fixture, []);
        assert(result.code === 1, `退出码应为 1，实际 ${result.code}\n${result.output}`);
        const report = result.report();
        assert(report && report.gate.status === 'fail', '报告 gate 应为 fail');
        const check = result.check('demo-fail');
        assert(check && check.status === 'failed', `demo-fail 状态应为 failed，实际 ${JSON.stringify(check && check.status)}`);
        return { exit_code: result.code, gate: report.gate.status };
      } finally {
        fixture.cleanup();
      }
    },
  },
  {
    name: '配置有错 → 退出码 2、明确报错且不生成报告',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-broken' });
      try {
        fixture.addRawCheck('demo-broken', BROKEN_CHECK);
        fixture.writeFile('docs/quality/demo-broken.md', '# 故意缺字段\n');
        const result = await cli(fixture, []);
        assert(result.code === 2, `退出码应为 2（内部错误），实际 ${result.code}\n${result.output}`);
        assert(/windows_command/.test(result.output), '报错信息里应指出缺 windows_command');
        assert(!fs.existsSync(path.join(fixture.dir, 'reports', 'quality-report.json')), '配置有错时不应生成报告');
        return { exit_code: result.code, matched_error: 'windows_command' };
      } finally {
        fixture.cleanup();
      }
    },
  },
  {
    name: '--list 列出发现的检查项',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-list' });
      try {
        fixture.addCheck({ id: 'demo-ok', command: fixture.command('demo-ok') });
        const result = await cli(fixture, ['--list']);
        assert(result.code === 0, `--list 退出码应为 0，实际 ${result.code}\n${result.output}`);
        assert(result.output.includes('demo-ok'), '--list 输出里应包含检查项 id');
        assert(result.output.includes('static'), '--list 输出里应包含阶段');
        return { exit_code: result.code };
      } finally {
        fixture.cleanup();
      }
    },
  },
  {
    name: '--dry-run 打印平台命令',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-dry' });
      try {
        fixture.addCheck({ id: 'demo-ok', command: fixture.command('demo-ok') });
        const result = await cli(fixture, ['--dry-run']);
        assert(result.code === 0, `--dry-run 退出码应为 0，实际 ${result.code}\n${result.output}`);
        assert(result.output.includes('demo-ok') && result.output.includes('cmd:'), '--dry-run 应打印检查项与命令');
        assert(!fs.existsSync(path.join(fixture.dir, 'reports', 'quality-report.json')), '--dry-run 不应生成报告');
        return { exit_code: result.code };
      } finally {
        fixture.cleanup();
      }
    },
  },
  {
    name: '--generate-install 生成安装脚本（BOM/CRLF、winget 三件套、choco 只写文档）',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-install' });
      try {
        fixture.addCheck({
          id: 'demo-install',
          command: fixture.command('demo-install'),
          requiresRaw: REQUIRES_BLOCK,
        });
        const result = await cli(fixture, ['--generate-install']);
        assert(result.code === 0, `--generate-install 退出码应为 0，实际 ${result.code}\n${result.output}`);
        const ps1 = path.join(fixture.dir, 'scripts', 'install.ps1');
        const sh = path.join(fixture.dir, 'scripts', 'install.sh');
        assert(fs.existsSync(ps1) && fs.existsSync(sh), '应生成 scripts/install.ps1 与 scripts/install.sh');
        const ps1Bytes = fs.readFileSync(ps1);
        assert(ps1Bytes.slice(0, 3).toString('hex') === 'efbbbf', 'install.ps1 必须是 UTF-8 with BOM');
        assert(ps1Bytes.includes(Buffer.from('\r\n')), 'install.ps1 必须是 CRLF');
        const ps1Text = ps1Bytes.toString('utf8');
        for (const flag of ['--accept-source-agreements', '--accept-package-agreements', '--scope user']) {
          assert(ps1Text.includes(flag), `install.ps1 的 winget 步骤缺少 ${flag}`);
        }
        const chocoLines = ps1Text.split(/\r?\n/).filter((line) => line.includes('choco install demo'));
        assert(chocoLines.length > 0, 'install.ps1 应记录 choco 手动命令');
        assert(chocoLines.every((line) => line.trim().startsWith('#')), 'choco 命令只能出现在注释里（永不提权）');
        const shText = fs.readFileSync(sh, 'utf8');
        assert(!shText.includes('\r\n'), 'install.sh 必须是 LF');
        const sudoCommands = shText.split('\n').filter((line) => /^\s*sudo\b/.test(line));
        assert(sudoCommands.length === 0, `install.sh 里不得实际调用 sudo（发现 ${sudoCommands.length} 行）`);
        assert(shText.includes('deps-install.mjs') || shText.includes('winget'), 'install.sh 应包含可执行步骤');
        return { exit_code: result.code, ps1_bom: true, choco_documented_only: true };
      } finally {
        fixture.cleanup();
      }
    },
  },
  {
    name: '部分运行语义：默认只记警告，--strict-partial 判失败',
    async run() {
      const fixture = createFixtureRepo({ schemaFrom: REPO_ROOT, name: 'e2e-partial' });
      try {
        fixture.addCheck({ id: 'demo-ok', command: fixture.command('demo-ok') });
        fixture.addCheck({ id: 'demo-ok2', command: fixture.command('demo-ok2') });
        const partial = await cli(fixture, ['--only', 'demo-ok']);
        assert(partial.code === 0, `部分运行默认退出码应为 0，实际 ${partial.code}\n${partial.output}`);
        const report = partial.report();
        const warned = (report.gate.warnings || []).some((w) => w.id === 'demo-ok2');
        assert(warned, `报告应把未执行的 required 检查项列为警告：${JSON.stringify(report.gate.warnings)}`);
        const strict = await cli(fixture, ['--only', 'demo-ok', '--strict-partial']);
        assert(strict.code === 1, `--strict-partial 退出码应为 1，实际 ${strict.code}\n${strict.output}`);
        return { exit_code: partial.code, strict_exit_code: strict.code };
      } finally {
        fixture.cleanup();
      }
    },
  },
];

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || REPO_ROOT);
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'e2e.json');

  const results = [];
  for (const scenario of scenarios) {
    try {
      const detail = await scenario.run();
      results.push({ name: scenario.name, status: 'passed', detail });
      process.stdout.write(`   ✔ ${scenario.name}\n`);
    } catch (error) {
      const detail = { message: String(error && error.message), stack: String(error && error.stack).split('\n').slice(0, 4).join('\n') };
      results.push({ name: scenario.name, status: 'failed', detail });
      process.stdout.write(`   ✖ ${scenario.name}\n      ${detail.message}\n`);
    }
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    verify_entry: VERIFY,
    scenarios: results,
    passed,
    failed,
  };
  ensureDir(path.dirname(artifactPath));
  writeJson(artifactPath, artifact);
  process.stdout.write(`e2e：场景 ${results.length} 个（通过 ${passed} / 失败 ${failed}）\n`);
  finish({
    ok: failed === 0,
    metrics: {
      scenarios: results.length,
      passed,
      failed,
      pass_rate: pct(passed, results.length),
    },
    artifactPath,
    artifact,
    failureNote: '端到端场景失败：上面每条都带真实命令与真实输出，按它复现即可。',
  });
}

main().catch((error) => {
  process.stdout.write(`e2e 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
