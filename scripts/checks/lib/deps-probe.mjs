// 依赖就绪探测（跨平台，零依赖）。
//
// 为什么需要它：克隆下来的仓库没有 node_modules，而各包通过 `link:` 依赖 dsh-fairy-contracts，
// 直接跑包测试会得到 `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-fairy-contracts'`。
// 本脚本按"包有 dependencies 但没有 node_modules"判定未就绪，供检查项的 requires 用作 probe：
//   退出码 0 = 就绪；1 = 有包未安装（打印缺哪些包与手动命令）。
// 这是**前提探测**，不是安装器；安装走 scripts/checks/lib/deps-install.mjs（local 策略）。
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
      const manifest = path.join(full, 'package.json');
      if (fs.existsSync(manifest)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (pkg.name && pkg.name.startsWith('dsh-')) packages.push({ dir: full, name: pkg.name, pkg });
        } catch { /* 忽略坏 manifest，lint 会报 */ }
      }
      if (entry.name !== 'profiles') walk(full, depth + 1);
    }
  };
  walk(repo, 0);
  return packages;
}

function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const packages = findPackages(repo);
  const missing = [];
  for (const pkg of packages) {
    const deps = Object.keys(pkg.pkg.dependencies || {});
    if (!deps.length) continue;
    if (!fs.existsSync(path.join(pkg.dir, 'node_modules'))) missing.push(pkg);
  }
  if (!missing.length) {
    process.stdout.write(`deps-probe：${packages.length} 个包的依赖已就绪\n`);
    process.exit(0);
  }
  process.stdout.write(`deps-probe：${missing.length}/${packages.length} 个包未安装依赖\n`);
  for (const pkg of missing) {
    process.stdout.write(`  - ${path.relative(repo, pkg.dir).split(path.sep).join('/')}\n`);
  }
  process.stdout.write('手动命令（项目本地安装，免提权）：\n');
  for (const pkg of missing) {
    const rel = path.relative(repo, pkg.dir).split(path.sep).join('/');
    process.stdout.write(`  (cd ${rel} && pnpm install --frozen-lockfile --ignore-scripts)\n`);
  }
  process.exit(1);
}

main();
