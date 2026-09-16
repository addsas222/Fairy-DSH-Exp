#!/usr/bin/env node
/**
 * install.mjs — Fairy-DSH 的跨平台一键部署/安装入口（Windows / macOS / Linux）。
 *
 * 它不重复 deploy-live.sh 的任何工作，只解决三件在别的平台/别的机器上总会踩到的事：
 *   1) **找对 shell**：deploy-live.sh 是 POSIX sh 脚本。Windows 上必须用 Git 自带的
 *      bash（`C:\Program Files\Git\bin\bash.exe`），且不能是 WSL 的 bash——WSL 里
 *      `C:/...` 路径不存在，会把文件落进 Linux 子系统而用户毫不知情。这里显式只认
 *      Git 的 bash，认不出来就给出装 Git 的指引，绝不猜。
 *   2) **找对运行时**：DSH 运行时（`@deepseek-ai/dsh` 的 bin.js）与底座线（0.1.1 / 0.1.5）
 *      决定 profile 里哪些行该启用。没有现成运行时就用 pnpm 装一个到 `<home>/runtime`，
 *      底座线由版本号推出并写进启动器，不靠用户记环境变量。
 *   3) **把启动器写进 home**：仓库里那份 start-fairy.cmd 是**参考副本**、部署不会更新它，
 *      于是「手抄的旧启动器」会静默丢掉新加的行为（本仓 2026-09-16 实测过一次：
 *      抓取通道按底座条件挂载后，手抄启动器不会带 DSH_FAIRY_BASE）。这里每次部署都
 *      按本次解析出的运行时重写启动器（旧的不同则先备份 .bak）。
 *
 * 用法（任何平台同一条）：
 *   node scripts/install.mjs [--home DIR] [--runtime DIR|BIN] [--base 011|015]
 *                            [--from-worktree] [--install-runtime [VERSION]]
 *                            [--evomap] [--no-verify] [--dry-run] [--skip-launcher]
 * 也支持平台双击入口：install.cmd（Windows）/ install.sh（macOS、Linux）。
 *
 * 退出码：0 成功；1 前置条件不满足或部署/门禁失败（与 deploy-live.sh 同语义）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_HOME = join(homedir(), '.dsh-fairy');
/** 底座线 → profile 行条件用的标记（见 profiles/web/cordis.patch.yml）。 */
const KNOWN_BASES = ['011', '015'];
/** 各底座线的默认安装版本（--install-runtime 不带版本号时用）。 */
const BASE_RUNTIME_VERSIONS = { '011': '0.1.1-rc.2', '015': '0.1.5-rc.1' };

const log = (message) => console.log(`\u001b[36m[install]\u001b[0m ${message}`);
const warn = (message) => console.warn(`\u001b[33m[install]\u001b[0m ${message}`);
const fail = (message) => { console.error(`\u001b[31m[install]\u001b[0m ${message}`); process.exit(1); };

function parseArgs(argv) {
  const options = {
    home: process.env.DSH_HOME || DEFAULT_HOME,
    runtime: process.env.DSH_FAIRY_RUNTIME || '',
    // 底座线**只**由运行时版本与 --base 决定：环境变量是启动器给应用用的，
    // installer 若也读它，会在 shell 里残留旧值时把线推错（实测踩到）。
    base: '',
    fromWorktree: false,
    installRuntime: '',
    evomap: false,
    noVerify: false,
    dryRun: false,
    skipLauncher: false,
    passthrough: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--home': options.home = argv[++index]; break;
      case '--runtime': options.runtime = argv[++index]; break;
      case '--base': options.base = argv[++index]; break;
      case '--from-worktree': options.fromWorktree = true; break;
      case '--install-runtime': {
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) { options.installRuntime = next; index += 1; } else options.installRuntime = 'auto';
        break;
      }
      case '--evomap': options.evomap = true; break;
      case '--no-verify': options.noVerify = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--skip-launcher': options.skipLauncher = true; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
      default: fail(`unknown option: ${arg} (try --help)`);
    }
  }
  options.home = resolve(options.home);
  return options;
}

function printHelp() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('/**'));
  const end = lines.findIndex((line, index) => index > start && line.startsWith(' */'));
  for (const line of lines.slice(start + 1, end)) console.log(line.replace(/^ \* ?/, ''));
}

/**
 * Windows 上只认 Git 自带的 bash。
 * WSL 的 bash 能跑通脚本，但会在 Linux 侧解释 `C:/...`，把文件落到用户看不见的地方——
 * 所以这里连 PATH 上的 bash 也只接受路径里带 `Git` 的那种。
 */
function findBash() {
  if (!IS_WINDOWS) {
    for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
      if (existsSync(candidate)) return candidate;
    }
    return 'bash';
  }
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  const found = spawnSync('where bash', { encoding: 'utf8', shell: true });
  const hit = String(found.stdout || '').split(/\r?\n/).find((line) => /Git/i.test(line) && line.trim());
  if (hit) return hit.trim();
  fail([
    'Windows 上需要 Git 自带的 bash（deploy-live.sh 是 POSIX sh 脚本）。',
    '  装 Git for Windows：https://git-scm.com/download/win',
    '  装好后重跑：node scripts/install.mjs',
    '  （刻意不认 WSL 的 bash：它会在 Linux 侧解释 C:/ 路径，把文件落到你看不见的地方。）',
  ].join('\n'));
}

function requireCommand(command, hint) {
  const probe = IS_WINDOWS
    ? spawnSync(`${command} --version`, { encoding: 'utf8', shell: true })
    : spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) fail(`${command} not found on PATH. ${hint}`);
  return String(probe.stdout || '').split('\n')[0].trim();
}

/** 从 `…/@deepseek-ai/dsh/lib/bin.js` 或包目录反查运行时信息。 */
function inspectRuntime(input) {
  if (!input) return null;
  const bin = resolve(input);
  const packageRoot = bin.endsWith('.js') ? resolve(bin, '../..') : bin;
  const manifest = join(packageRoot, 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    if (parsed.name !== '@deepseek-ai/dsh' || !parsed.version) return null;
    const binPath = join(packageRoot, 'lib', 'bin.js');
    if (!existsSync(binPath)) return null;
    return { bin: binPath, version: parsed.version, root: packageRoot };
  } catch { return null; }
}

/** 底座线：0.1.5 起 profile 的抓取通道由底座自带，行条件据此开关。 */
function baseFor(version) {
  // 底座线看版本号的**次版本第三段**：0.1.1 → 011、0.1.5 → 015；更高的线（0.2+）按新形态算。
  // 曾误取第二段（`0.1` 里的 1），把 0.1.5 推成 011。
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return '011';
  const [, major, minor, patch] = match.map(Number);
  return (major > 0 || minor > 1 || patch >= 5) ? '015' : '011';
}

function detectRuntime(options) {
  const explicit = inspectRuntime(options.runtime);
  if (explicit) return explicit;
  if (options.runtime) {
    warn(`--runtime 指向的不是 @deepseek-ai/dsh 包：${options.runtime}`);
  }
  const homeLocal = inspectRuntime(join(options.home, 'runtime', 'node_modules', '@deepseek-ai', 'dsh'));
  if (homeLocal) return homeLocal;
  // 本仓开发机上常见的两个位置（非 Windows 上不存在，跳过即可）。
  for (const guess of ['C:\\tmp\\dsh-011\\node_modules\\@deepseek-ai\\dsh', join(homedir(), 'node_modules', '@deepseek-ai', 'dsh')]) {
    const found = inspectRuntime(guess);
    if (found) return found;
  }
  return null;
}

function installRuntime(options, base) {
  const root = join(options.home, 'runtime');
  // 缺版本号时按底座线选（默认 011 ⇒ 0.1.1-rc.2），而不是 npm 的 latest——
  // 装成什么线就决定 profile 的行条件与 DSH_FAIRY_BASE，两者必须同源。
  const version = options.installRuntime && options.installRuntime !== 'auto' ? options.installRuntime : BASE_RUNTIME_VERSIONS[base];
  const spec = `@deepseek-ai/dsh@${version}`;
  log(`安装运行时：pnpm add ${spec}（到 ${root}）`);
  if (options.dryRun) { console.log(`  would run: pnpm add ${spec}  # cwd ${root}`); return null; }
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, 'package.json'))) writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2) + '\n');
  const result = IS_WINDOWS
    ? spawnSync(`pnpm add ${spec}`, { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync('pnpm', ['add', spec], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail('运行时安装失败（检查网络与 pnpm 版本 ≥ 11）');
  const installed = inspectRuntime(join(root, 'node_modules', '@deepseek-ai', 'dsh'));
  if (!installed) fail('运行时装完了但找不到 @deepseek-ai/dsh/lib/bin.js');
  return installed;
}

/**
 * 启动器正文（纯函数：按平台产出，Windows 用 CRLF、其余 LF）。
 * 抽出来是为了能在任何平台上验证 Unix 分支——否则「macOS/Linux 装完能不能跑」只有
 * 到那台机器上才知道（本机冒烟只在 Windows 上做得到）。
 */
function launcherBody(platform, runtime, base, port = 3081) {
  if (platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'rem Generated by scripts/install.mjs on every deploy.',
      'rem The copy in the repo (scripts/start-fairy.cmd) is a reference only.',
      'set "PORT=%~1"',
      `if "%PORT%"=="" set "PORT=${port}"`,
      'set "ISO_HOME=%~dp0"',
      'if "%ISO_HOME:~-1%"=="\\" set "ISO_HOME=%ISO_HOME:~0,-1%"',
      `set "RUNTIME=${runtime.bin}"`,
      `set "DSH_FAIRY_BASE=${base}"`,
      'set "DSH_HOME=%ISO_HOME%"',
      'set "DSH_FAIRY_REPO_ROOT=%ISO_HOME%"',
      'set "DSH_FAIRY_TEST_HOME=%ISO_HOME%"',
      'set "DSH_FAIRY_PROFILE_ROOT=%ISO_HOME%\\profiles\\web"',
      'echo Fairy-DSH  %ISO_HOME%  port %PORT%  base %DSH_FAIRY_BASE%',
      'node "%RUNTIME%" --profile web --no-open --port %PORT%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# Generated by scripts/install.mjs on every deploy.',
    'set -eu',
    `RUNTIME="${runtime.bin}"`,
    `DSH_FAIRY_BASE="${base}"`,
    `PORT="\${1:-${port}}"`,
    'ISO_HOME="$(cd "$(dirname "$0")" && pwd)"',
    'export DSH_HOME="$ISO_HOME"',
    'export DSH_FAIRY_REPO_ROOT="$ISO_HOME"',
    'export DSH_FAIRY_TEST_HOME="$ISO_HOME"',
    'export DSH_FAIRY_PROFILE_ROOT="$ISO_HOME/profiles/web"',
    'echo "Fairy-DSH  $ISO_HOME  port $PORT  base $DSH_FAIRY_BASE"',
    'exec node "$RUNTIME" --profile web --no-open --port "$PORT"',
    '',
  ].join('\n');
}

/** 启动器按本次解析结果重写：仓库里那份只是参考副本，手抄的旧副本会静默丢新行为。 */
function writeLauncher(options, runtime, base) {
  const launcher = join(options.home, IS_WINDOWS ? 'start-fairy.cmd' : 'start-fairy.sh');
  const body = launcherBody(process.platform, runtime, base);
  if (existsSync(launcher)) {
    const current = readFileSync(launcher, 'utf8');
    if (current === body) { log(`启动器已是最新：${launcher}`); return launcher; }
    copyFileSync(launcher, `${launcher}.bak`);
    log(`启动器已更新（旧版备份为 ${launcher}.bak）：${launcher}`);
  } else {
    log(`启动器已写入：${launcher}`);
  }
  writeFileSync(launcher, body, { mode: IS_WINDOWS ? 0o644 : 0o755 });
  return launcher;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(join(REPO_ROOT, 'fairy-system', 'verify-build.js'))) {
    fail('这个脚本必须在 Fairy-DSH 源码检出里运行（找不到 fairy-system/verify-build.js）');
  }
  requireCommand('node', '安装 Node ≥ 22：https://nodejs.org');
  requireCommand('git', '安装 Git：https://git-scm.com');
  requireCommand('pnpm', '安装 pnpm ≥ 11：corepack enable pnpm（或 npm i -g pnpm）');

  let runtime = detectRuntime(options);
  if (!runtime) {
    // 一键安装的默认行为：找不到就自己装到 <home>/runtime（与平台无关的目录），
    // 版本线由 --base 决定（默认 011 ⇒ 0.1.1-rc.2）。
    const wanted = KNOWN_BASES.includes(options.base) ? options.base : '011';
    log(`没有找到 DSH 运行时；按底座线 ${wanted} 装一个到 <home>/runtime`);
    runtime = installRuntime(options, wanted);
  }
  if (!runtime) fail('缺少运行时：--runtime <@deepseek-ai/dsh 包目录或 lib/bin.js>，或 --install-runtime [版本]');
  const base = KNOWN_BASES.includes(options.base) ? options.base : baseFor(runtime.version);
  if (options.base && !KNOWN_BASES.includes(options.base)) warn(`--base ${options.base} 不是已知底座线，按运行时版本推断为 ${base}`);

  const bash = findBash();
  log(`repo      : ${REPO_ROOT}`);
  log(`home      : ${options.home}`);
  log(`runtime   : ${runtime.version}  (${runtime.bin})`);
  log(`base flag : DSH_FAIRY_BASE=${base}${base === baseFor(runtime.version) ? '' : '（显式指定）'}`);
  log(`shell     : ${bash}`);

  // 交给 deploy-live.sh：它是唯一的落位实现（对账/落位/装依赖/门禁都在里面）。
  const deployArgs = ['scripts/deploy-live.sh', '--home', options.home.replace(/\\/g, '/'), '--skip-evomap'];
  if (options.fromWorktree) deployArgs.push('--from-worktree');
  if (options.noVerify) deployArgs.push('--no-verify');
  if (options.dryRun) deployArgs.push('--dry-run');
  if (options.evomap) deployArgs.splice(deployArgs.indexOf('--skip-evomap'), 1);
  const command = `cd ${posix.join(REPO_ROOT.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1'), '')} && sh ${deployArgs.join(' ')}`;
  log(`${options.dryRun ? '（dry-run）将要执行' : '部署'}：bash -lc "${command}"`);
  const deployed = spawnSync(bash, ['-lc', command], { stdio: 'inherit' });
  if (deployed.status !== 0) fail('部署失败（见上方输出）');

  let launcher = null;
  if (!options.skipLauncher && !options.dryRun) launcher = writeLauncher(options, runtime, base);
  else if (options.dryRun) log('（dry-run）跳过启动器写入');

  log('完成。下一步：');
  if (launcher) {
    console.log(IS_WINDOWS
      ? `  双击或运行：${launcher}    （可带端口参数，默认 3081）`
      : `  运行：${launcher}    （可带端口参数，默认 3081）`);
  }
  console.log(`  或手动：DSH_HOME="${options.home}" DSH_FAIRY_BASE=${base} node "${runtime.bin}" --profile web --no-open`);
  console.log(`  镜像对账（只读）：node fairy-system/image-manifest.js check --repo "${REPO_ROOT}" --home "${options.home}"`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { baseFor, launcherBody, BASE_RUNTIME_VERSIONS, KNOWN_BASES };
