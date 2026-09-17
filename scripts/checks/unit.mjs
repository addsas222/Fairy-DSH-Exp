// 检查项 unit：全量单元测试（各插件包 node --test，真实执行、真实解析 TAP）。
//
// 仓库现状：每个包自带 `node --test test/*.test.js`（CI 也是这么跑的）。本检查项做的是
// **全量**跑一遍并给出机器可读汇总，而不是抽样或只看退出码：
//   - 包发现：按 yaml 的 scope.package_globs（当前 `*/dsh-*/package.json` + extras）扫描；
//   - 用例文件：包内 test/ 下所有 *.test.js（递归），显式列出文件而不是依赖 shell glob
//     （cmd.exe 不展开通配符，这是 Windows 友好的关键）；
//   - 结果解析：TAP 汇总（tests/pass/fail/skipped/todo）+ 失败用例名；
//   - 门禁：failed=0 且 通过率（跳过不计分母）100%。
// 环境耦合的 fairy-system 套件不在本项里（它需要官方制品/已部署 DSH_HOME），单独作为
// integration 阶段的检查项，见 docs/quality/integration.md。
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir, finish, globToRegExp, listFiles, parseCli, pct, parseTap, readCheckConfig, run, trackedFiles,
} from './lib/runtime.mjs';

function matchGlob(glob, rel) {
  return globToRegExp(glob).test(rel);
}

async function discoverPackages(repo, scope) {
  const globs = scope.package_globs || ['*/dsh-*/package.json'];
  const extras = scope.extra_packages || [];
  const tracked = await trackedFiles(repo);
  const manifests = new Set();
  for (const rel of tracked) {
    if (!rel.endsWith('/package.json')) continue;
    if (globs.some((glob) => matchGlob(glob, rel))) manifests.add(rel);
  }
  for (const extra of extras) {
    const rel = String(extra).split('/').join('/');
    manifests.add(rel.endsWith('package.json') ? rel : `${rel}/package.json`);
  }
  const packages = [];
  for (const manifest of [...manifests].sort()) {
    const dir = path.dirname(manifest);
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(repo, manifest), 'utf8'));
    } catch (error) {
      packages.push({ dir, manifest, error: `package.json 解析失败：${error.message}` });
      continue;
    }
    const testDir = path.join(repo, dir, 'test');
    const testFiles = fs.existsSync(testDir)
      ? listFiles(testDir, { extensions: ['.test.js', '.test.mjs', '.test.cjs'] })
      : [];
    packages.push({
      dir,
      manifest,
      name: pkg.name || dir,
      test_script: pkg.scripts && pkg.scripts.test ? pkg.scripts.test : null,
      test_files: testFiles.map((f) => path.relative(path.join(repo, dir), f).split(path.sep).join('/')),
      dir_abs: path.join(repo, dir),
    });
  }
  return packages;
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'unit.json');
  const scope = check.scope || {};
  const timeoutPerPackage = Number(scope.package_timeout_seconds || 300) * 1000;
  const testTimeout = scope.test_timeout_ms || 45000;

  const packages = await discoverPackages(repo, scope);
  if (!packages.length) {
    process.stdout.write('unit：没有发现任何包（检查 .agent/checks/unit.yaml 的 scope.package_globs）\n');
    process.exit(2);
  }

  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let tests = 0;
  const failures = [];

  for (const pkg of packages) {
    const entry = {
      dir: pkg.dir,
      name: pkg.name,
      test_files: pkg.test_files.length,
      status: 'unknown',
      totals: {},
      failures: [],
      duration_ms: 0,
    };
    if (pkg.error) {
      entry.status = 'error';
      entry.note = pkg.error;
      results.push(entry);
      continue;
    }
    if (!pkg.test_files.length) {
      entry.status = 'error';
      entry.note = '包内没有 test/*.test.js 用例文件（要么补测试，要么把该包写进 scope.exclude 并写明原因）';
      results.push(entry);
      continue;
    }
    // 失败重试一次：区分"真失败"与"flaky"（B.md 的 flaky<=1% 门禁需要这个数字）
    const retries = Number(scope.retries ?? 1);
    const attemptsMax = 1 + retries;
    let result = await run(
      process.execPath,
      ['--test', `--test-timeout=${testTimeout}`, '--test-reporter=tap', ...pkg.test_files],
      { cwd: pkg.dir_abs, timeoutMs: timeoutPerPackage },
    );
    let attempts = 1;
    let flaky = false;
    while (result.code !== 0 && attempts < attemptsMax) {
      attempts += 1;
      result = await run(
        process.execPath,
        ['--test', `--test-timeout=${testTimeout}`, '--test-reporter=tap', ...pkg.test_files],
        { cwd: pkg.dir_abs, timeoutMs: timeoutPerPackage },
      );
      if (result.code === 0) flaky = true;
    }
    entry.attempts = attempts;
    entry.flaky = flaky;
    const tap = parseTap(result.stdout);
    entry.totals = tap.totals;
    entry.failures = tap.failures;
    entry.duration_ms = result.durationMs;
    if (result.timedOut) {
      entry.status = 'timeout';
    } else if (tap.totals.tests === undefined) {
      entry.status = 'error';
      entry.note = `测试进程没有产出 TAP 汇总（退出码 ${result.code}）：${(result.stderr || result.stdout).split('\n').slice(-8).join(' / ')}`;
    } else if ((tap.totals.fail || 0) > 0 || result.code !== 0) {
      entry.status = 'failed';
    } else {
      entry.status = 'passed';
    }
    tests += entry.totals.tests || 0;
    passed += entry.totals.pass || 0;
    failed += entry.totals.fail || 0;
    skipped += entry.totals.skipped || 0;
    todo += entry.totals.todo || 0;
    for (const name of entry.failures) failures.push(`${pkg.name || pkg.dir}: ${name}`);
    process.stdout.write(`   ${entry.status === 'passed' ? '✔' : '✖'} ${(pkg.name || pkg.dir).padEnd(28)} tests=${entry.totals.tests || 0} pass=${entry.totals.pass || 0} fail=${entry.totals.fail || 0} skipped=${entry.totals.skipped || 0} (${(result.durationMs / 1000).toFixed(2)}s${flaky ? '，重试后通过=flaky' : ''})\n`);
    results.push(entry);
    if (entry.status !== 'passed') {
      const tail = `${result.stderr}\n${result.stdout}`.split('\n').filter((l) => l.trim()).slice(-12);
      for (const line of tail) process.stdout.write(`      | ${line}\n`);
    }
  }

  const packagesFailed = results.filter((r) => r.status !== 'passed').length;
  const flakyPackages = results.filter((r) => r.flaky);
  const passRate = pct(passed, Math.max(1, tests - skipped));
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    node: process.version,
    test_timeout_ms: testTimeout,
    packages: results,
    totals: {
      packages: results.length, tests, passed, failed, skipped, todo,
    },
    flaky_packages: flakyPackages.map((r) => r.name),
    pass_rate: passRate,
    failures,
  };
  ensureDir(path.dirname(artifactPath));
  const ok = failed === 0 && packagesFailed === 0 && results.length === packages.length;
  process.stdout.write(`unit 汇总：包 ${results.length} 个（失败包 ${packagesFailed}）；用例 ${tests}（通过 ${passed} / 失败 ${failed} / 跳过 ${skipped} / todo ${todo}）；通过率 ${passRate}%\n`);
  finish({
    ok,
    metrics: {
      packages: results.length,
      packages_failed: packagesFailed,
      tests,
      passed,
      failed,
      skipped,
      todo,
      pass_rate: passRate,
      flaky_packages: flakyPackages.length,
      flaky_rate: pct(flakyPackages.length, results.length),
    },
    artifactPath,
    artifact,
    failureNote: 'unit 要求 failed=0 且通过率 100%（跳过用例不计入分母）。',
  });
}

main().catch((error) => {
  process.stdout.write(`unit 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
