// 检查项 typecheck：TypeScript 类型检查（**当前 enabled: false**）。
//
// 本脚本是真实实现，不是占位：它会
//   1. 找出带 tsconfig.json 的包（或根级 tsconfig.json）；
//   2. 在每个包里找本地的 TypeScript 编译器（node_modules/typescript/bin/tsc，其次是 .bin/tsc）；
//   3. 用 `tsc --noEmit -p <tsconfig>` 做真实类型检查，记录每个包的退出码。
// 缺编译器时**明确报错（exit 2）而不是静默通过**——这正是本检查项目前保持 enabled: false 的原因：
// 本仓没有 tsconfig.json，也没有任何包声明 typescript 依赖（唯一的 TS 输入是两个包的
// tsdown.config.ts 与 fairy-contracts/types.d.ts）。
// 启用步骤见 docs/quality/typecheck.md。
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir, finish, globToRegExp, parseCli, pct, readCheckConfig, run, trackedFiles, writeJson,
} from './lib/runtime.mjs';

function findByGlob(tracked, globs, suffix) {
  const regexes = globs.map((g) => globToRegExp(g));
  return tracked.filter((rel) => rel.endsWith(suffix) && (rel === suffix || regexes.some((re) => re.test(rel))));
}

function findCompiler(packageDir) {
  const candidates = [
    path.join(packageDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(packageDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'typecheck.json');
  const scope = check.scope || {};
  const packageGlobs = scope.package_globs || ['*/dsh-*/package.json', 'package.json'];

  const tracked = await trackedFiles(repo);
  const manifests = findByGlob(tracked, packageGlobs, 'package.json');
  const projects = [];
  for (const manifest of manifests) {
    const dir = path.dirname(manifest);
    const tsconfig = path.join(repo, dir, 'tsconfig.json');
    if (fs.existsSync(tsconfig)) projects.push({ dir, abs: path.join(repo, dir), tsconfig: path.relative(repo, tsconfig).split(path.sep).join('/') });
  }

  const errors = [];
  const results = [];
  if (!projects.length) {
    const message = '仓库里没有任何 tsconfig.json（也就没有可做类型检查的工程）';
    const artifact = {
      generated_at: new Date().toISOString(),
      repo,
      projects: [],
      results: [],
      errors: [message],
      hint: '本检查项应当保持 enabled: false；启用步骤见 docs/quality/typecheck.md',
    };
    ensureDir(path.dirname(artifactPath));
    writeJson(artifactPath, artifact);
    process.stdout.write(`typecheck：${message}\n`);
    process.stdout.write('提示：本检查项在 .agent/checks/typecheck.yaml 里是 enabled: false（文档写了启用步骤）；\n');
    process.stdout.write('      如果配置被改成启用，就必须先落地 tsconfig + typescript，否则这里会如实报错。\n');
    process.exit(2);
  }

  for (const project of projects) {
    const compiler = findCompiler(project.abs);
    if (!compiler) {
      errors.push(`${project.dir}：有 tsconfig.json 但没装 typescript（node_modules/typescript 缺失）`);
      results.push({ dir: project.dir, status: 'error', note: '缺少本地 TypeScript 编译器' });
      continue;
    }
    const result = await run(process.execPath, [compiler, '--noEmit', '-p', 'tsconfig.json'], {
      cwd: project.abs, timeoutMs: Number(scope.timeout_seconds || 900) * 1000,
    });
    const status = result.code === 0 ? 'passed' : 'failed';
    if (status === 'failed') errors.push(`${project.dir}：tsc 退出码 ${result.code}`);
    results.push({
      dir: project.dir,
      status,
      exit_code: result.code,
      duration_ms: result.durationMs,
      tail: `${result.stdout}\n${result.stderr}`.split('\n').filter((l) => l.trim()).slice(-10),
    });
    process.stdout.write(`   ${status === 'passed' ? '✔' : '✖'} ${project.dir}：tsc 退出码 ${result.code}\n`);
  }

  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    projects: projects.map((p) => p.dir),
    results,
    errors,
  };
  ensureDir(path.dirname(artifactPath));
  writeJson(artifactPath, artifact);
  const passed = results.filter((r) => r.status === 'passed').length;
  process.stdout.write(`typecheck：工程 ${projects.length} 个；通过 ${passed}；问题 ${errors.length}\n`);
  finish({
    ok: errors.length === 0,
    metrics: {
      errors: errors.length,
      projects: projects.length,
      passed,
      pass_rate: pct(passed, projects.length),
    },
    artifactPath,
    artifact,
    failureNote: '类型检查失败：先修类型，或者（如果本仓还没有 TS 工程）保持 enabled: false 并在文档里说明。',
  });
}

main().catch((error) => {
  process.stdout.write(`typecheck 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
