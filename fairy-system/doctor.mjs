#!/usr/bin/env node
/**
 * `doctor.mjs` —— 自主排障：一次跑完本机部署的**只读**诊断，按严重度汇总，并给出可执行的下一步。
 *
 * 为什么需要它：这套部署的故障几乎都以"别处的症状"出现（混版报的是 ESM 导出名、
 * 半成品镜像全绿通过、npm 的工程根跑偏会把宿主拧回旧版）。查一次要跨 5 个工具，
 * 且**手工查的顺序会漏项**——本会话就漏报过一次"宿主未受影响"（两次检查之间有别的
 * 进程改了树）。所以把判定固化下来，人只负责执行它给出的命令。
 *
 * **铁律：doctor 绝不写任何东西。** 它不装包、不落位、不删文件、不改真实 home。
 * 唯一允许写的是 `--report <file>` 指定的那份报告（默认不写，只打印）。
 * 修复动作全部以命令形式给出，由人决定是否执行。
 *
 * 用法：
 *   node fairy-system/doctor.mjs [--home <DSH_HOME>] [--repo <仓库根>] [--runtime <安装目录>]
 *                                [--json] [--report FILE] [--offline]
 *
 * 退出码：0 全绿 ｜ 1 有 fail ｜ 2 有 warn（无 fail）｜ 3 用法/前置错误
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT = path.resolve(HERE, '..');
const require_ = createRequire(import.meta.url);

export const EXIT = { OK: 0, FAIL: 1, WARN: 2, USAGE: 3 };

function run(cmd, args, options = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout ?? 120_000,
        env: { ...process.env, ...(options.env ?? {}) }, cwd: options.cwd,
      }).trim(),
    };
  } catch (error) {
    // 非零退出码**也是数据**：子工具用退出码表达状态（repo-update：0 最新/1 有更新/2 离线/3 用法）。
    // 只 `catch { out: '' }` 会把"镜像落后"这类正常结论误报成"无输出"——同一类缺陷在本会话
    // 的 repo-update 里也犯过一次。所以这里保留 stdout，由调用方结合 status 判断。
    return {
      ok: false,
      status: error.status,
      out: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? error.message).trim(),
    };
  }
}

export function parseArgs(argv) {
  const options = {
    home: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    repo: REPO_DEFAULT, runtimeDir: '', json: false, report: '', offline: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') options.home = argv[++i];
    else if (a === '--repo') options.repo = argv[++i];
    else if (a === '--runtime') options.runtimeDir = argv[++i];
    else if (a === '--report') options.report = argv[++i];
    else if (a === '--json') options.json = true;
    else if (a === '--offline') options.offline = true;
    else if (a === '-h' || a === '--help') options.help = true;
    else { const e = new Error(`unknown argument: ${a}`); e.usage = true; throw e; }
  }
  return options;
}

/** 读一份安装树：返回 name → version 的 Map（读不到就返回 null）。 */
function readTree(nodeModules) {
  const scope = path.join(nodeModules, '@deepseek-ai');
  if (!existsSync(scope)) return null;
  const out = new Map();
  for (const dir of readdirSync(scope)) {
    const pj = path.join(scope, dir, 'package.json');
    if (!existsSync(pj)) continue;
    try { const j = JSON.parse(readFileSync(pj, 'utf8')); out.set(j.name ?? dir, j.version); } catch { /* 半写的 manifest */ }
  }
  return out;
}

/** 版本线：`0.1.5-rc.2` → `0.1`（判"同线内不一致"用）。 */
const train = (v) => String(v).split('-')[0].split('.').slice(0, 2).join('.');

/**
 * ① 混版：同一版本线（如 `dsh-*` 家族的 0.1.x）内出现多个版本，就是混版。
 * 独立版本线（cordis/cosmokit/schemastery）与原生构建物（node-addon-*）不参与——
 * 它们本就跟着别的线走，误报会把人引向错误的修复。
 */
export function checkVersions(runtimeDir) {
  const tree = readTree(runtimeDir);
  if (!tree) return { status: 'unknown', name: '混版检测', detail: `${path.join(runtimeDir, '@deepseek-ai')} 不存在`, fix: '' };
  const dsh = tree.get('@deepseek-ai/dsh');
  if (!dsh) return { status: 'fail', name: '混版检测', detail: '安装树里没有 @deepseek-ai/dsh（宿主本体缺失）', fix: '重装官方 @deepseek-ai/dsh' };
  const line = train(dsh);
  const stale = [...tree.entries()]
    .filter(([n, v]) => n.startsWith('@deepseek-ai/dsh-') && train(v) === line && v !== dsh)
    .sort();
  if (!stale.length) return { status: 'ok', name: '混版检测', detail: `${tree.size} 个包，同线内全部 ${dsh}`, fix: '' };
  return {
    status: 'fail',
    name: '混版检测',
    detail: `${stale.length} 个包落在同一版本线但版本不同（宿主 ${dsh}）：\n    ` + stale.map(([n, v]) => `${n}@${v}`).join('\n    '),
    // 修复入口指向既有的对齐工具，doctor 自己不动手
    fix: `node fairy-system/host-align.js fix --target ${dsh} --runtime ${runtimeDir}`,
  };
}

/** ② 新进程实测：在跑的宿主是内存态，盘上坏没坏它测不出来。必须起新进程跑真二进制。 */
export function checkBinary(runtimeDir) {
  const bin = path.join(runtimeDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(bin)) return { status: 'fail', name: '宿主可运行性（新进程）', detail: `找不到 ${bin}`, fix: '重装官方 @deepseek-ai/dsh' };
  const r = run(process.execPath, [bin, '--version'], { timeout: 60_000 });
  const ver = r.out.split('\n').filter(Boolean).pop() ?? '';
  if (r.ok && /^\d+\.\d+/.test(ver)) return { status: 'ok', name: '宿主可运行性（新进程）', detail: `新进程启动正常，报告 ${ver}`, fix: '' };
  return { status: 'fail', name: '宿主可运行性（新进程）', detail: `新进程启动失败：${(r.stderr || r.out).split('\n').slice(0, 3).join(' / ')}`, fix: '看上面报错；混版通常报 ESM "does not provide an export named …"' };
}

/** ③ 模块解析：点名几个跨包引用最密的，逐个真 import（混版会在这里现形）。 */
const IMPORTS = ['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-sandbox', '@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-workflow'];
export function checkImports(runtimeDir) {
  const broken = [];
  for (const name of IMPORTS) {
    const r = run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(name)})`], { cwd: runtimeDir, timeout: 60_000 });
    if (!r.ok) broken.push(`${name}: ${(r.stderr || r.out).split('\n')[0].slice(0, 90)}`);
  }
  if (!broken.length) return { status: 'ok', name: '关键包解析', detail: `${IMPORTS.length} 个包都能被新进程 import`, fix: '' };
  return { status: 'fail', name: '关键包解析', detail: broken.join('\n    '), fix: '多为混版症状；先跑混版检测' };
}

/**
 * ④ npm 工程根跑偏：`npm install` 会向上找最近的 package.json 当工程根。
 * 若那份 lock 与实际树不一致，一次 install 就可能把整棵树按 lock 收敛（版本回退）。这里只读比对。
 */
export function checkNpmProjectRoot(nodeModules) {
  const root = path.dirname(nodeModules);
  const lock = path.join(root, 'package-lock.json');
  if (!existsSync(lock)) return { status: 'skipped', name: 'npm 工程根', detail: '该层没有 package-lock.json', fix: '' };
  let lockPkgs;
  try { lockPkgs = JSON.parse(readFileSync(lock, 'utf8')).packages ?? {}; } catch { return { status: 'warn', name: 'npm 工程根', detail: 'package-lock.json 读不动（半写？）', fix: `检查 ${lock}` }; }
  const installed = new Map();
  for (const [p, meta] of Object.entries(lockPkgs)) {
    const m = /^node_modules\/(@?[^/]+(?:\/[^/]+)?)$/.exec(p);
    if (m && meta.version) installed.set(m[1], meta.version);
  }
  const drift = [];
  for (const [name, version] of installed) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    const pj = path.join(nodeModules, name, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const actual = JSON.parse(readFileSync(pj, 'utf8')).version;
      if (actual !== version) drift.push(`${name}: lock ${version} vs 盘上 ${actual}`);
    } catch { /* 忽略 */ }
  }
  const n = [...installed.keys()].filter((k) => k.startsWith('@deepseek-ai/')).length;
  if (!drift.length) return { status: 'ok', name: 'npm 工程根', detail: `${root} 下 lock 与盘上一致（抽查 ${n} 个 @deepseek-ai 包）`, fix: '' };
  return {
    status: 'warn',
    name: 'npm 工程根',
    detail: `lock 与盘上不一致（${drift.length} 个）：\n    ` + drift.slice(0, 6).join('\n    '),
    fix: `在 ${root} 跑 npm install 会按 **lock** 收敛；先确认要不要，再决定跑不跑`,
  };
}

/**
 * 这条命令行像不像"正在写 node_modules 的包管理器"？
 *
 * **不只 npm**：`deploy-live.sh` 第 3/4 步跑的是 `pnpm install`（输出重定向进 /dev/null，
 * 卡住时无回显），pnpm 既可能是 node 子进程、也可能是独立的 pnpm.exe。只认
 * `node.exe` + `npm-cli.js` 会整类漏掉——这正是本机那次"以为取消了、其实还在写树"的形态。
 * 抽成纯函数是为了能被直接钉住（进程扫描本身依赖真机，测不动）。
 */
export function isInstallLikeCommand(cmdLine) {
  if (!cmdLine) return false;
  const s = String(cmdLine);
  if (/get-ciminstance|win32_process|tasklist/i.test(s)) return false;   // 扫描器自身
  // 落位脚本本身就是"会写环境"的进程，与包管理器并列判——别让它被包管理器那道闸挡住
  // （`sh scripts/deploy-live.sh …` 里没有包管理器名字）。
  if (/\bdeploy-live\b/i.test(s)) return true;
  const pm = /\b(npm(-cli\.js)?|pnpm|yarn|bun)\b/i.test(s);
  if (!pm) return false;
  return /\b(install|add|ci|link|rebuild)\b/i.test(s) || /npm-cli\.js/i.test(s);
}

/** ⑤ 残留安装进程：被取消/超时的安装可能仍在跑，且随时写树。按**命令行签名**认，不按进程名。 */
export function checkStrayInstalls() {
  const hits = [];
  let scanned = 0;
  let note = '';
  if (process.platform === 'win32') {
    // 全进程扫描（含 pnpm.exe 这类非 node 进程），再逐条取命令行
    const list = run('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -match \'^(node|pnpm|yarn|bun|sh|bash|cmd)\\.exe$\' } | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
    ], { timeout: 60_000 });
    if (!list.ok) { note = '无法列进程'; }
    else {
      for (const line of list.out.split('\n')) {
        const [pid, ...rest] = line.split('\t');
        const cl = rest.join('\t');
        if (!pid || !cl) continue;
        scanned++;
        if (Number(pid) !== process.pid && isInstallLikeCommand(cl)) hits.push({ pid, cl: cl.replace(/\s+/g, ' ').slice(0, 110) });
      }
    }
  } else {
    // Unix：ps 的 COMMAND 列本身就是命令行
    const list = run('ps', ['-eo', 'pid=,args='], { timeout: 60_000 });
    if (!list.ok) { note = '无法列进程（ps 不可用）'; }
    else {
      for (const line of list.out.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        scanned++;
        if (Number(m[1]) !== process.pid && isInstallLikeCommand(m[2])) hits.push({ pid: m[1], cl: m[2].slice(0, 110) });
      }
    }
  }
  if (note) return { status: 'unknown', name: '残留安装进程', detail: note, fix: '' };
  if (!hits.length) return { status: 'ok', name: '残留安装进程', detail: `无（扫了 ${scanned} 个候选进程）`, fix: '' };
  return {
    status: 'fail',
    name: '残留安装进程',
    detail: `有安装/落位进程仍在跑，随时会写树：\n    ` + hits.map((h) => `PID ${h.pid}: ${h.cl}`).join('\n    '),
    // 实测教训：job/会话里的"取消"不等于进程终止；必须按 PID 杀整个进程树
    fix: hits.map((h) => `taskkill /PID ${h.pid} /T /F`).join('  &&  '),
  };
}

/**
 * 这个 home 是不是**本仓的部署**？判据是部署会落下的三样标记：受控工具目录 + 系统目录 + 预设。
 *
 * 为什么必须判：`--home` 缺省是 `$DSH_HOME` 再 `~/.dsh`，而本机 `~/.dsh` 是**另一条工作线**
 * （app-boot + dsh-web + @dsh-external/*），不是本仓的镜像。若不加这道闸，doctor 会为它报
 * "镜像 behind" 并建议 `deploy-live.sh --home ~/.dsh`——**恰好是 AGENTS 明令禁止的操作**
 * （会覆盖那条工作线的 manifest）。
 */
export function looksLikeRepoDeployment(home) {
  if (!home || !existsSync(home)) return false;
  return [
    path.join(home, 'fairy-system', 'image-manifest.js'),
    path.join(home, 'fairy-contracts', 'package.json'),
    path.join(home, '.agent-presets', 'ponytail'),
  ].every((p) => existsSync(p));
}

/** ⑥ 仓库与部署：远端是否有更新、镜像是否落后（复用 repo-update 的只读判定，不另起一套）。 */
export function checkRepo(repo, home, offline) {
  const tool = path.join(repo, 'fairy-system', 'repo-update.mjs');
  if (!existsSync(tool)) return { status: 'skipped', name: '仓库与部署', detail: '没有 repo-update.mjs', fix: '' };
  if (!looksLikeRepoDeployment(home)) {
    return {
      status: 'warn',
      name: '仓库与部署',
      detail: `${home} 不像本仓的部署（缺 fairy-system/ / fairy-contracts/ / .agent-presets/ponytail 之一）\n`
        + '    → 不对它做镜像判定，**也不会**给出部署命令：对它跑 deploy-live.sh 会覆盖那一侧的 manifest',
      fix: '隔离实例显式传 --home（本机部署是 ~/.dsh-fairy）',
    };
  }
  const args = ['check', '--repo', repo, '--home', home, '--json'];
  if (offline) args.push('--remote', '__offline__');
  const r = run(process.execPath, [tool, ...args], { timeout: 180_000 });
  let payload = null;
  try { payload = JSON.parse(r.out); } catch { /* 非 JSON */ }
  if (!payload) return { status: 'unknown', name: '仓库与部署', detail: (r.stderr || r.out).split('\n').slice(0, 2).join(' / ') || '无输出', fix: '' };
  const parts = [`仓库 ${payload.state}`, `镜像 ${payload.mirror?.state ?? '?'}`];
  if (payload.state === 'offline' || payload.state === 'missing') return { status: 'warn', name: '仓库与部署', detail: `远端不可达，无法判断是否有更新（${parts.join('，')}）`, fix: '网络恢复后重跑；离线≠已最新' };
  const problems = [];
  if (payload.state !== 'current') problems.push(`仓库处于 ${payload.state}`);
  if (payload.mirror?.state && payload.mirror.state !== 'current' && payload.mirror.state !== 'skipped') problems.push(`镜像 ${payload.mirror.state}`);
  if (!problems.length) return { status: 'ok', name: '仓库与部署', detail: `仓库与远端一致，镜像与提交一致（home=${payload.home}）`, fix: '' };
  return {
    status: 'warn',
    name: '仓库与部署',
    detail: problems.join('；'),
    fix: payload.state === 'behind' ? 'node fairy-system/repo-update.mjs apply --yes' : `node scripts/deploy-live.sh --home ${home} --skip-evomap`,
  };
}

/**
 * ⑦ 测试门的前提：`preflight`/`upgrade` 两组要一份**0.1.1-rc.2 比较对象**与一份装齐的 profile。
 *
 * 这条不做"缺了就警告"的懒判定——合适的对象本机往往**就有**（隔离部署、别处的制品目录）。
 * 所以它自己找候选、逐项**校验 pin**（候选的 `dsh-client-runtime/lib/client.js` 的 sha256
 * 必须等于 `preflight-build.js` 里 pin 的值——那才是测试门真正比对的东西；版本号只作展示，
 * 因为它是标签、可被改写）。
 * 只有真找不到/校验不过时才是 warn，且说明差在哪。
 */
export function checkTestPrereqs(repo, home) {
  const preflightSrc = path.join(repo, 'fairy-system', 'preflight-build.js');
  let pinned = '';
  try { pinned = /runtimeSha256:\s*'([0-9a-f]{64})'/.exec(readFileSync(preflightSrc, 'utf8'))?.[1] ?? ''; } catch { /* 读不到就只校验版本 */ }

  const candidates = [
    process.env.DSH_OFFICIAL_PACKAGE,                                          // ① 显式旋钮
    path.join(os.homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/package.json'),  // ② 仓库测试的默认位
    ...discoverArtifacts(),                                                    // ③ 约定目录（本机 C:/tmp/dsh-011 就在这类位置）
  ].filter(Boolean);
  const found = [];
  for (const pkg of [...new Set(candidates)]) {
    if (!existsSync(pkg)) continue;
    const root = path.dirname(pkg);
    let version = '';
    try { version = JSON.parse(readFileSync(pkg, 'utf8')).version ?? ''; } catch { /* 半写 */ }
    const runtime = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js');
    const hasRuntime = existsSync(runtime);
    const hash = hasRuntime ? crypto.createHash('sha256').update(readFileSync(runtime)).digest('hex') : '';
    found.push({ pkg, runtime, version, hasRuntime, hash, hashOk: pinned ? hash === pinned : hasRuntime });
  }
  // 「可用」= 有嵌套 runtime 且其 sha256 与 pin 一致（版本只做展示：pin 的是制品字节，
  // 版本号是标签、可被改写，两者不是一回事——注释按实际校验口径写）。
  const usable = found.find((f) => f.hasRuntime && f.hashOk);

  // 装齐的 profile：当前 home 优先，其次同级的隔离部署（本机 `~/.dsh-fairy` 就是那种）
  const planted = ['dsh-fairy-persona', 'dsh-reasoning-effort', 'dsh-message-edit'];
  const homes = [home, ...readdirSafe(path.dirname(home)).map((d) => path.join(path.dirname(home), d))]
    .filter((h, i, arr) => h && arr.indexOf(h) === i && existsSync(path.join(h, 'profiles', 'web', 'package.json')));
  const suitHome = homes.find((h) => planted.every((n) => existsSync(path.join(h, 'profiles', 'web', 'node_modules', n))));

  const run = 'node --test fairy-system/test/*.test.js';
  if (usable && suitHome) {
    return {
      status: 'ok',
      name: '测试门前提',
      detail: `比较对象 ${path.dirname(usable.pkg)}（${usable.version}，runtime sha256 ${pinned ? '与 pin 一致' : '未校验'}）\n`
        + `    profile：${suitHome}`,
      fix: `DSH_OFFICIAL_PACKAGE="${usable.pkg}" DSH_OFFICIAL_RUNTIME="${usable.runtime}" DSH_HOME="${suitHome}" DSH_CAPABILITY_MATRIX="${path.join(repo, 'fairy-system/capability-matrix.json')}" ${run}`,
    };
  }
  const why = [];
  if (!found.length) why.push('没找到 0.1.1-rc.2 制品（找过 $DSH_OFFICIAL_PACKAGE 与 ~/.local/lib/…）');
  else if (!usable) {
    const bad = found.map((f) => `${f.pkg}（版本 ${f.version || '?'}${f.hasRuntime ? (f.hashOk ? '' : '，runtime sha256 与 pin 不符') : '，缺嵌套 runtime'}）`);
    why.push(`候选都不合用：${bad.join('；')}`);
  }
  if (!suitHome) why.push(`没有装齐的 profile（找过 ${homes.length} 个 home，逐个缺 ${planted.join('/')} 之一）`);
  return {
    status: 'warn',
    name: '测试门前提',
    detail: `${why.join('\n    ')}\n    → preflight/upgrade 两组会整组红，属环境前提（不是代码回归）`,
    fix: '按 AGENTS §3 指旋钮：DSH_OFFICIAL_PACKAGE / DSH_OFFICIAL_RUNTIME / DSH_HOME / DSH_CAPABILITY_MATRIX',
  };
}

/** 读目录名，失败就返回空数组（不是所有父目录都读得了）。 */
function readdirSafe(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

/** 制品搜索根：系统临时目录 + 约定目录（Windows 上 `/tmp` 并非 `os.tmpdir()`）。 */
export function artifactRoots() {
  return [...new Set([
    os.tmpdir(),
    process.env.TMPDIR,
    process.platform === 'win32' ? 'C:/tmp' : '/tmp',
  ].filter(Boolean))];
}

/**
 * 在约定目录里找现成的 0.1.1-rc.2 制品（`<搜索根>/dsh-<任意后缀>` 下的
 * `node_modules/@deepseek-ai/dsh/package.json`）。本机的 `C:/tmp/dsh-011` 就是这类——
 * 测试门要的比较对象往往早就在机器上，让体检**自己找**比逼人去装一份新的合理。
 */
export function discoverArtifacts() {
  const out = [];
  for (const root of artifactRoots()) {
    for (const dir of readdirSafe(root)) {
      if (!/^dsh[-_.]/i.test(dir)) continue;
      const pkg = path.join(root, dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      if (existsSync(pkg)) out.push(pkg);
    }
  }
  return out;
}

/** 跑全部检查。任何单个检查抛错都降级成 fail，不影响其余检查。 */
export function diagnose(options) {
  const runtimeDir = options.runtimeDir;
  const checks = [];
  const add = (fn, ...args) => {
    try { checks.push(fn(...args)); }
    catch (error) { checks.push({ status: 'fail', name: fn.name || '检查', detail: `检查本身出错：${error.message}`, fix: '' }); }
  };
  add(checkVersions, runtimeDir);
  add(checkStrayInstalls);
  add(checkBinary, runtimeDir);
  add(checkImports, runtimeDir);
  add(checkNpmProjectRoot, runtimeDir);
  add(checkRepo, options.repo, options.home, options.offline);
  add(checkTestPrereqs, options.repo, options.home);
  return checks;
}

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', unknown: '❓', skipped: '· ' };

/**
 * 检查结果 → 退出码。抽成纯函数是为了**能被直接钉住**：批跑夹具里常同时有 fail，
 * 那时 `status != 0` 被 fail 满足，unknown→非零 这条映射就算写坏也照样过（假绿）。
 * fail 优先于 warn/unknown；`unknown` 与 `warn` 同码——"查不清"不该被当成通过。
 */
export function exitFor(checks) {
  if (checks.some((c) => c.status === 'fail')) return EXIT.FAIL;
  if (checks.some((c) => c.status === 'warn' || c.status === 'unknown')) return EXIT.WARN;
  return EXIT.OK;
}

function render(checks, context) {
  const lines = [`DSH 部署体检  home=${context.home}  runtime=${context.runtimeDir}`, ''];
  for (const c of checks) lines.push(`${ICON[c.status] ?? '· '} ${c.name}：${c.detail}`);
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const unknowns = checks.filter((c) => c.status === 'unknown');
  const oks = checks.filter((c) => c.status === 'ok');
  const skipped = checks.filter((c) => c.status === 'skipped');
  lines.push('', `合计 ${checks.length} 项：${oks.length} 正常 / ${warns.length} 警告 / ${fails.length} 失败`
    + ` / ${unknowns.length} 未知 / ${skipped.length} 跳过`);
  // 「未知」必须显式成行、且影响退出码：体检工具把"查不清"静默算作通过，是最要命的失效形态
  // （本会话就发生过——报告说全绿，实际两次检查之间有别的进程改了树）。
  // 这里不用 markdown 强调符：终端里 `**` 只是字面星号，留着只会让断言多两个字符的噪声。
  if (unknowns.length) lines.push(`⚠️  有 ${unknowns.length} 项无法判定（不等于正常）：${unknowns.map((c) => c.name).join('、')}`);
  const fixes = [...fails, ...warns].map((c) => c.fix).filter(Boolean);
  if (fixes.length) { lines.push('', '下一步（doctor 只报不做，执行与否由你定）：'); for (const f of [...new Set(fixes)]) lines.push(`  ${f}`); }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: doctor.mjs [--home DIR] [--repo DIR] [--runtime DIR] [--json] [--report FILE] [--offline]\n'
      + '  只读体检：混版 / 残留安装进程 / 宿主可运行性（新进程）/ 关键包解析 / npm 工程根 / 仓库与部署 / 测试门前提\n'
      + '  退出码：0 全绿 ｜ 1 有 fail ｜ 2 有 warn ｜ 3 用法错误\n');
    return EXIT.OK;
  }
  // 与 host-align 同一条解析链（$DSH_OFFICIAL_PACKAGE → $DSH_HOME/../node_modules → ./node_modules）
  const { resolveRuntimeDir } = require_(path.join(HERE, 'host-align.js'));
  let runtimeDir = options.runtimeDir;
  if (!runtimeDir) {
    try { runtimeDir = resolveRuntimeDir({ runtimeDir: '', home: options.home }); }
    catch { runtimeDir = path.join(path.dirname(options.home), 'node_modules'); }
  }
  const checks = diagnose({ ...options, runtimeDir });
  const text = render(checks, { home: options.home, runtimeDir });
  process.stdout.write(`${text}\n`);
  if (options.report) {
    mkdirSync(path.dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${text}\n`, 'utf8');
    process.stdout.write(`报告已写入 ${options.report}\n`);
  }
  if (options.json) process.stdout.write(`${JSON.stringify({ home: options.home, runtimeDir, checks }, null, 2)}\n`);
  return exitFor(checks);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`doctor: ${error.message}\n`); process.exitCode = error.usage ? EXIT.USAGE : EXIT.FAIL; });
}
