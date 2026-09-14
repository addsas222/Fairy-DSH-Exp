#!/usr/bin/env node
/**
 * `host-align.js` —— 检查并对齐 DSH 官方安装的包版本。
 *
 * 为什么需要它：**混版安装会让 DSH 直接起不来**，而报错信息完全指向别处。实测形态：
 *   `@deepseek-ai/dsh-session-query-sqlite@0.1.5-rc.2` import
 *   `@deepseek-ai/dsh-session-query` 的某个导出，而后者还是 `0.1.2-rc.1`——
 *   ESM 报的是 "does not provide an export named …"，看起来像代码 bug，
 *   实际是同一批 `@deepseek-ai/*` 装的不是同一个版本。
 *
 * 这类混版在"只把顶层 dsh 升级、依赖树没全量重装"之后很常见（本机修复前就是：
 * 208 个包已是 0.1.5-rc.2，另有 20+ 个仍是 0.1.2-rc.1；逐包清点确认后才对齐）。
 * 修复后的实测形态（2026-09-14，供对照）：240 个包里 231 个是 0.1.5-rc.2，其余 9 个
 * 全部落在独立版本线——cordis/cosmokit/schemastery 系，以及原生构建物
 * `node-addon-system@0.1.2`（受 `dsh-sandbox-local` 的 `^0.1.2` 约束、平台包 pin 0.1.2，
 * **不是混版**，故 check 报的 ✅ 是诚实的）。
 *
 * 用法：
 *   node fairy-system/host-align.js check [--home <DSH_HOME>] [--runtime <安装目录>]
 *   node fairy-system/host-align.js fix   [--home <DSH_HOME>] [--runtime <安装目录>] [--dry-run]
 *
 * 默认 runtime 目录解析顺序：$DSH_OFFICIAL_PACKAGE 的父目录 → <home>/../node_modules →
 * 常见全局安装位（npm 前缀 / NVM）。`fix` 会把过期包就地重装到与 `@deepseek-ai/dsh`
 * **同版本**（registry 可达时）；`check` 只读、退出码非 0 表示存在混版。
 *
 * 边界：本脚本修改的是 **DSH 官方安装**（AGENTS §5.1 的只读边界）。它只在
 * 宿主已经混版、且用户明确要求对齐时使用；不要放进 CI 或自动部署链。
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  registry: 'https://registry.npmjs.org',
  scope: '@deepseek-ai',
};

function parseArgs(argv) {
  const options = { verb: argv[0], home: process.env.DSH_HOME ?? '', runtimeDir: '', dryRun: false, target: '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') options.home = argv[++i];
    else if (a === '--runtime') options.runtimeDir = argv[++i];
    else if (a === '--target') options.target = argv[++i];
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--include-addons') options.includeAddons = true;
    else if (a === '-h' || a === '--help') options.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

/** 定位官方安装目录（含 @deepseek-ai 的那层 node_modules）。 */
function resolveRuntimeDir(options) {
  const candidates = [];
  if (options.runtimeDir) candidates.push(options.runtimeDir);
  if (process.env.DSH_OFFICIAL_PACKAGE) {
    // 仓库约定传的是**文件路径**（`…/@deepseek-ai/dsh/package.json`，见 test-isolated.sh:51
    // 与 preflight-build.js:13），传目录也容忍。原来的 `path.join(pkg, '..', '..')` 只对
    // 「传包目录」成立：对文件路径算出 `…/@deepseek-ai`，再拼 `@deepseek-ai/dsh` 永远不存在
    // ——**这个旋钮一直是死的**，只是没被发现（宿主混版排查时走的是 --runtime）。
    const pkgDir = path.dirname(process.env.DSH_OFFICIAL_PACKAGE);
    for (const base of [pkgDir, process.env.DSH_OFFICIAL_PACKAGE]) {
      candidates.push(path.join(base, '..'));              // …/node_modules
      candidates.push(path.join(base, '..', '..'));        // 传目录形态下的老算法
    }
  }
  if (options.home) candidates.push(path.join(options.home, '..', 'node_modules'));
  candidates.push(path.join(process.cwd(), 'node_modules'));
  for (const c of candidates) {
    if (c && existsSync(path.join(c, DEFAULTS.scope, 'dsh', 'package.json'))) return path.resolve(c);
  }
  throw new Error('找不到官方安装目录（试过 --runtime / $DSH_OFFICIAL_PACKAGE / <home>/../node_modules / ./node_modules）');
}

/** 读取某目录下所有 @deepseek-ai 包的版本。 */
function inventory(runtimeDir) {
  const dir = path.join(runtimeDir, DEFAULTS.scope);
  const versions = new Map();
  for (const name of readdirSync(dir)) {
    const pj = path.join(dir, name, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const j = JSON.parse(readFileSync(pj, 'utf8'));
      if (j.name?.startsWith(DEFAULTS.scope) || name === 'dsh') versions.set(j.name ?? `${DEFAULTS.scope}/${name}`, j.version);
    } catch { /* 忽略损坏的 manifest */ }
  }
  return versions;
}

/** 定位 npm 的 CLI 入口：Windows 上 `npm` 是 .cmd，execFileSync 直接调用会 ENOENT；
 *  改用 `node <npm-cli.js>`，既绕开 shell 也避开引号/注入面。 */
function resolveNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

async function registryHas(name, version) {
  const url = `${DEFAULTS.registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
      if (res.status === 200) return true;
      if (res.status === 404) return false;    // 明确不存在，不必重试
    } catch { /* 网络抖动：重试 */ }
    await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  return false;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.verb) {
    process.stdout.write(
      'usage: host-align.js <check|fix> [--home DIR] [--runtime DIR] [--dry-run]\n'
      + '  check  只读报告：官方安装内 @deepseek-ai/* 的版本分布与混版清单\n'
      + '  fix    把过期包重装到与 @deepseek-ai/dsh 相同版本\n',
    );
    return options.verb ? 0 : 2;
  }

  const runtimeDir = resolveRuntimeDir(options);
  const versions = inventory(runtimeDir);
  // 目标版本：--target 优先；否则取 dsh 本体版本。注意 dsh 本体可能已被上一次失败的对齐降级，
  // 所以 fix 时应显式 --target（check 不受影响）。
  const target = options.target || versions.get(`${DEFAULTS.scope}/dsh`);
  if (!target) throw new Error(`${runtimeDir} 下没有 ${DEFAULTS.scope}/dsh`);

  const distribution = new Map();
  for (const v of versions.values()) distribution.set(v, (distribution.get(v) ?? 0) + 1);
  const train = target.split('-')[0].split('.').slice(0, 2).join('.');   // 0.1.5-rc.2 → 0.1
  const inTrain = ([, v]) => v.split('-')[0].split('.').slice(0, 2).join('.') === train;
  const stale = [...versions.entries()].filter(([, v]) => v !== target && inTrain([, v]))
    // 默认只对齐 dsh-* 家族：node-addon-* 是原生构建物，版本线不同、重装风险更大，需显式开启
    .filter(([name]) => options.includeAddons || name.startsWith(`${DEFAULTS.scope}/dsh-`))
    .sort();
  const foreign = [...versions.entries()].filter(([, v]) => !inTrain([, v]));

  process.stdout.write(`runtime : ${runtimeDir}\n`);
  process.stdout.write(`目标版本: ${target}（取自 ${DEFAULTS.scope}/dsh）\n`);
  process.stdout.write(`版本分布: ${[...distribution.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join('  ')}\n`);
  process.stdout.write(`不一致  : ${stale.length} 个包（同一版本线 ${train}.x）\n`);
  if (foreign.length) process.stdout.write(`独立版本线: ${foreign.length} 个（如 cordis/cosmokit/schemastery，不参与对齐）\n`);
  for (const [name, v] of stale) process.stdout.write(`  - ${name}@${v}\n`);

  if (options.verb === 'check') {
    if (stale.length === 0) { process.stdout.write('\n✅ 官方安装版本一致\n'); return 0; }
    process.stdout.write('\n⚠️  官方安装混版——DSH 可能直接起不来（典型症状：ESM "does not provide an export named …"）\n');
    process.stdout.write('   对齐：node fairy-system/host-align.js fix\n');
    return 1;
  }

  if (options.verb !== 'fix') throw new Error(`unknown verb: ${options.verb}`);
  if (stale.length === 0) { process.stdout.write('\n无需对齐\n'); return 0; }

  // 先探 registry，缺版本就直接报（不要动了一半）
  const unavailable = [];
  if (!options.dryRun) {
    for (const [name] of stale) { if (!(await registryHas(name, target))) unavailable.push([name]); }
  }
  if (unavailable.length) {
    process.stdout.write(`\n❌ ${unavailable.length} 个包在 registry 上找不到 ${target}，未做任何修改：\n`);
    for (const [name] of unavailable) process.stdout.write(`  - ${name}\n`);
    return 1;
  }

  // 一次事务装齐：逐包装会被 npm 的整树协调反复打乱（实测：装一个包会连带把顶层
  // `@deepseek-ai/dsh` 降级、并把别的包删掉）。这里把所有待对齐包 + dsh 本体一起显式钉版本
  // 交给 npm，让它在一个事务里解析。
  const specs = [...new Set([`${DEFAULTS.scope}/dsh@${target}`, ...stale.map(([name]) => `${name}@${target}`)])];
  process.stdout.write(`\n一次性安装 ${specs.length} 个包（同一事务）…\n`);
  if (options.dryRun) {
    for (const spec of specs) process.stdout.write(`  would install ${spec}\n`);
    return 0;
  }
  const npmCli = resolveNpmCli();
  if (!npmCli) throw new Error('找不到 npm-cli.js，无法执行安装');
  try {
    // --force + --legacy-peer-deps：就地补丁式对齐（邻居包可能仍是旧版），
    // 严格 peer 校验会因邻居未同步而拒绝；--no-save 避免在该目录生成 package.json 契约。
    // 必须显式把**工程根**（含 @deepseek-ai 的那层 node_modules 的父目录）当项目根：
    // 只给 `cwd: runtimeDir` 时 npm 会从 `<root>/node_modules` 向上找到 `<root>/package.json`，
    // 于是按**那里**的 manifest/lock 去 reify 整棵树——`--no-save` 只保得住 package.json，
    // 保不住树里其它包。
    //
    // 事故记录（2026-09-14）：本机曾观测到 21 个包处于 0.1.2-rc.1，修复后逐包比对确认无损。
    // **机制未证实**：事后查 `~/package-lock.json`，里面 0 命中 0.1.2-rc.1 且 mtime 早于事故，
    // 所以"按陈旧 lock 收敛"只是推断、证据不支持——别把它当结论写进报告。
    // 能确证的是：run 期间有两个失控的 `npm install`（工程根 = `~`）在写树，且 doctor 的
    // "残留安装进程"就是为盯这类进程而设。
    // `--prefix` 与 cwd 都指过去，避免依赖 npm 的上溯行为。
    const projectRoot = path.dirname(runtimeDir);
    const output = execFileSync(process.execPath, [
      npmCli, 'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
      '--legacy-peer-deps', '--force', '--prefix', projectRoot, ...specs,
    ], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 });
    const summary = String(output).split('\n').filter((l) => /added|changed|removed/i.test(l)).join(' ');
    if (summary) process.stdout.write(`  ${summary.trim()}\n`);
  } catch (error) {
    const text = String(error.stderr ?? error.message);
    const line = text.split('\n').filter((l) => /npm error/i.test(l)).slice(0, 3).join(' / ') || text.split('\n')[0];
    process.stdout.write(`安装失败：${String(line).trim().slice(0, 300)}\n`);
  }

  const after = inventory(runtimeDir);
  // 与前面同一判据：只统计同版本线的 dsh-* 家族（独立版本线不应出现在"剩余不一致"里）
  const remaining = [...after.entries()].filter(([name, v]) => v !== target && inTrain([, v]) && (options.includeAddons || name.startsWith(`${DEFAULTS.scope}/dsh-`)));
  process.stdout.write(`\n剩余不一致 ${remaining.length} 个\n`);
  if (remaining.length) for (const [name, v] of remaining.sort()) process.stdout.write(`  - ${name}@${v}\n`);
  return remaining.length === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; })
    .catch((error) => {
      const line = `host-align: ${error.message}\n`;
      process.stderr.write(line);
      process.stdout.write(line);
      process.exitCode = 2;
    });
}

module.exports = { resolveRuntimeDir, inventory };
