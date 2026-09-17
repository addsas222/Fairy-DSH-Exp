// 项目本地依赖安装器（local 策略，零依赖）：逐包 pnpm install，免提权。
//
// 为什么用它而不是脚本里塞两条平台命令：仓库的安装单位是**每个包各自的 lockfile**
// （AGENTS.md §1.1：每个包自带 lockfile、逐包安装），而且要跳过已经装好的包，
// 这样 `scripts/install.ps1` / `install.sh` 里只需要引用这一条命令。
// 它同时是两个平台的等价实现（Node 跨平台），因此不需要 windows/unix 两套命令。
//
// 用法：node scripts/checks/lib/deps-install.mjs [--repo <dir>] [--dry-run]
// 退出码：0 = 全部就绪或安装成功；1 = 有包安装失败（打印失败包与手动命令）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseCli } from './runtime.mjs';

function findPackages(repo) {
  const packages = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, 'package.json'))) packages.push(full);
      if (entry.name !== 'profiles') walk(full, depth + 1);
    }
  };
  walk(repo, 0);
  return packages;
}

function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const dryRun = Boolean(args['dry-run']);
  const packages = findPackages(repo).filter((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {}).length > 0;
  });
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const failures = [];
  for (const dir of packages) {
    const rel = path.relative(repo, dir).split(path.sep).join('/');
    if (fs.existsSync(path.join(dir, 'node_modules'))) {
      process.stdout.write(`deps-install：跳过（已装）${rel}\n`);
      continue;
    }
    const command = `${pnpm} install --frozen-lockfile --ignore-scripts`;
    if (dryRun) {
      process.stdout.write(`deps-install：dry-run 将在 ${rel} 执行 ${command}\n`);
      continue;
    }
    process.stdout.write(`deps-install：${rel} → ${command}\n`);
    const result = spawnSync(command, { cwd: dir, shell: true, stdio: 'inherit' });
    if (result.status !== 0) failures.push({ rel, command, status: result.status });
  }
  if (failures.length) {
    process.stdout.write(`deps-install：${failures.length} 个包安装失败\n`);
    for (const failure of failures) {
      process.stdout.write(`  ✖ ${failure.rel}（退出码 ${failure.status}）：手动执行 (cd ${failure.rel} && ${failure.command})\n`);
    }
    process.exit(1);
  }
  process.stdout.write('deps-install：全部包的依赖已就绪\n');
  process.exit(0);
}

main();
