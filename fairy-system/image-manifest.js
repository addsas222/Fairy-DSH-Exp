#!/usr/bin/env node
'use strict';

// 镜像清单引擎：把「部署镜像应该是哪些文件、每个文件的字节长什么样」这件事
// 变成一份可计算的清单，供两个调用方共用——
//
//   * scripts/deploy-live.sh 第 1 步：落位**之前**按清单做一次对账，删掉镜像里
//     不在本次清单上的受控文件（否则上游删过的文件永远留在镜像里，见
//     AGENTS.md §2.2 与故障单「半成品镜像」）；
//   * 只读对账（本文件的 check verb）：报出多余文件 / 缺失文件 / 内容漂移
//     三类差异，非 0 退出。
//
// 两者共用同一份策略与同一份清单，所以不会出现「部署删的」与「门禁查的」不是
// 一回事的情况。
//
// 用法（node image-manifest.js <verb> [options]）：
//   prune   按清单删掉镜像里的多余受控文件（--dry-run 只打印）
//   check   只读对账，输出文本报告；有差异 exit 1，参数/前置条件错误 exit 2
//   count   只打印本轮清单的文件数
//   paths   只打印受控路径清单（每行一条）
//   policy  打印清理策略（跳过的路径模式 + 原因按需）
//   --self-test  内建自检，不碰任何真实目录
//
// 选项：
//   --home DIR        镜像根（默认 $DSH_HOME，再默认 ~/.dsh）
//   --repo DIR        仓库根（默认本文件的上两级）
//   --source MODE     git（默认，取 HEAD 的树）| worktree（含未提交改动）
//   --preserve PATH   相对路径（可重复）：该路径的内容可以偏离清单，且不参与清理。
//                     本机适配（例如未装 Chrome 时 profiles/web/cordis.patch.yml
//                     改用 msedge）就走这里，而不是改提交或关掉门禁。
//   --fresh-lock      额外放行 profiles/web/pnpm-lock.yaml 的漂移（只给
//                     scripts/test-isolated.sh 的 `--no-frozen-lockfile` 回路用）
//   --dry-run         prune 只报告不落盘
//   --json            以 JSON 输出
//   --lines           policy 只印本机适配路径（一行一条，供脚本取默认值）
//   -h, --help
//
// 退出码：0 = 无差异（prune 成功）；1 = 有差异；2 = 参数或前置条件错误。
//
// 清理策略（为什么这些路径可以「多出来」）：镜像不是一份纯代码副本，pnpm 装的
// node_modules、插件的运行期状态、私有部署资产都会落在受控目录里。清单只对
// 「受控路径下、且不在 skip 策略里」的文件负责；其余文件既不删也不报。
// 策略是路径前缀精确匹配，不是模式通配——漏掉的路径会以「多余文件」报出来，
// 比静默放过安全。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SELF = path.resolve(__filename);
const DEFAULT_REPO = path.resolve(__dirname, '..');

// ── 受控路径清单的来源 ─────────────────────────────────────────────────────
// 唯一真源是 scripts/deploy-live.sh 里的 PACKAGES / EXTRA_PATHS（那是落位动作
// 实际用的清单）。这里解析它，而不是抄一份：抄一份就会漂。
// 解析失败 = 清单未知，此时两个调用方都必须硬失败，绝不能退化成「空清单」——
// 空清单在 prune 里意味着删掉镜像的每一个受控文件。
function readControlledPaths(repoRoot) {
  const script = path.join(repoRoot, 'scripts', 'deploy-live.sh');
  let text;
  try {
    text = fs.readFileSync(script, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the controlled-path list from ${script}: ${error.message}`);
  }
  const named = {};
  for (const name of ['PACKAGES', 'EXTRA_PATHS']) {
    // 值可能在行尾收口，也可能像 EXTRA_PATHS 那样在同一行的中间收口
    // （`EXTRA_PATHS="a b c"` 后面还跟着 `PACKAGE_COUNT=10` 之类的注释行），
    // 且 PACKAGES 这类列表**跨行**。三条要求合起来只有一个写法：^NAME=" 打头、
    // 一路吃到下一个引号（[^"] 允许换行）。禁止跨行会连真实文件都匹配不上，
    // 匹配到别处会得到空清单，两者都会让 prune 变成一次删除。
    const match = text.match(new RegExp(`^${name}="([^"]*)"`, 'gm'));
    if (!match || match.length === 0) throw new Error(`${script} no longer defines ${name}; the image manifest has no controlled paths`);
    if (match.length > 1) throw new Error(`${script} defines ${name} more than once`);
    named[name] = match[0].slice(name.length + 2, -1)
      .split(/\s+/)
      .filter((line) => line.length > 0);
  }
  const paths = named.PACKAGES.concat(named.EXTRA_PATHS);
  if (paths.length === 0) throw new Error(`${script} declares no controlled paths`);
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw new Error(`${script} declares a duplicated controlled path`);
  for (const entry of unique) {
    const segments = entry.split('/');
    if (path.isAbsolute(entry) || entry.endsWith('/') || segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
      throw new Error(`${script} declares a controlled path that is not a plain relative path: ${JSON.stringify(entry)}`);
    }
  }
  return unique;
}

// 提交树里的入口类型：只认普通文件（可执行位不影响字节）。符号链接与 submodule
// 不进清单——镜像里没有它们，报出来只会是噪声。
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

function usageError(message) {
  // 带 usage 标记的错误 = 「命令没法执行」（参数/前置条件），退出码 2；
  // 不带标记的 = 「镜像确实不对」，退出码 1。调用方靠这个区分该修命令还是修镜像。
  return Object.assign(new Error(message), { usage: true });
}

// ── 跳过策略 ───────────────────────────────────────────────────────────────
// 每一条都附「为什么它不可能由提交决定」。两种匹配：
//   * prefix —— 相对镜像根的路径前缀（受控目录下的复现路径）；
//   * segment —— 裸目录名，出现在路径的**任意**一段即命中（node_modules 在每个
//     包自己的目录下，不在镜像根；漏了它，五千多个依赖文件会被报成「多余」）；
//   * file —— 相对镜像根的精确路径。
// 策略刻意写成「精确前缀 + 固定目录名」，不是模式通配：漏掉的路径会以
// 「多余文件」报出来，比静默放过安全。
const SKIP_POLICY = [
  { segment: 'node_modules', reason: '每包 pnpm install 的产物（含 profiles/web/node_modules）' },
  { segment: '.git', reason: '镜像不是 git 工作树' },
  { prefix: '.dsh-test-home', reason: 'scripts/test-isolated.sh 的隔离 home' },
  { prefix: 'accepted-baselines', reason: '运行时接受的基线快照' },
  { prefix: 'logs', reason: '运行期日志' },
  { prefix: 'sessions', reason: '运行期会话数据' },
  { prefix: 'runtime', reason: '运行期状态目录' },
  { prefix: 'playwright-profile', reason: '浏览器 profile（运行期生成）' },
  { prefix: 'browser-evidence', reason: '运行期截图证据' },
  { prefix: 'world-core', reason: '运行期世界模型数据' },
  { prefix: 'benchmarks', reason: '运行期基准输出' },
  { file: 'browser-dock/control-token', reason: 'browser-dock 运行期控制令牌（64 字节随机值）' },
  { prefix: '.agent-presets/fairy/runtime', reason: 'fairy 预设的私有部署资产（不进公开仓库）' },
  // ponytail 规则技能：按上游 MIT 在本机安装，由 deploy-live.sh 落位时同步进这个槽位。
  // 仓库里没有它（不随仓库分发），所以清单里也不会列出它——不豁免的话，prune 会把它当成
  // 「镜像多出来的文件」删掉，下次部署又同步回来，形成抖动。
  { prefix: '.agent-presets/ponytail/skills', reason: 'ponytail 规则技能的本机安装槽位（不随仓库分发）' },
  // fairy world-core：本机从游戏文本提取的索引（版权归 miHoYo），由 deploy-live.sh 同步。
  // 与技能槽位同理：清单里没有它，不豁免的话每次部署都会被 prune 删掉再同步回来。
  { prefix: '.agent-presets/fairy/world-core', reason: 'fairy 世界知识索引（本机提取，不随仓库分发）' },
];

// 镜像里被接受为「可以多出来」的路径。默认只有一条：本机适配过的 profile。
// 判断方式是精确路径相等，不做通配。
const LOCAL_ADAPTATIONS = {
  'profiles/web/cordis.patch.yml': '本机适配（例如把 --browser chrome 换成已安装的通道）',
  // 注：`.agent-presets/fairy/runtime/` 下**不放**条目——那个前缀已在 SKIP_POLICY 里整目录排除
  // （"私有部署资产，不进公开仓库"），对账本就不看它，所以私有真身 drop-in 天然不会判漂移。
  // 一条路径不可能既 skip 又 allow；写在这里只会误导。
};

function isSkipped(relative) {
  return skipReason(relative) !== null;
}

function skipReason(relative) {
  for (const entry of SKIP_POLICY) {
    if (entry.file !== undefined) {
      if (relative === entry.file) return entry.file;
      continue;
    }
    if (entry.segment !== undefined) {
      if (relative.split('/').includes(entry.segment)) return entry.segment;
      continue;
    }
    if (relative === entry.prefix || relative.startsWith(`${entry.prefix}/`)) return entry.prefix;
  }
  return null;
}

const VERBS = ['prune', 'check', 'count', 'paths', 'policy'];

// ── 选项 ───────────────────────────────────────────────────────────────────
function parseArgs(argv, { verbs }) {
  const options = {
    verb: null,
    home: null,
    repo: DEFAULT_REPO,
    source: 'git',
    preserve: [],
    freshLock: false,
    dryRun: false,
    json: false,
    lines: false,
    quiet: false,
    selfTest: false,
    allowExtra: [],
  };
  const queue = argv.slice();
  while (queue.length > 0) {
    const arg = queue.shift();
    switch (arg) {
      case '-h': case '--help': options.help = true; break;
      case '--home': options.home = requireValue(arg, queue); break;
      case '--repo': options.repo = requireValue(arg, queue); break;
      case '--source': options.source = requireValue(arg, queue); break;
      // `--allow` 是 `--preserve` 的同义词：fairy-system/verify-image.js 曾用前者，
      // 合并成一个入口后两个拼写都留着，免得旧命令行失效。
      case '--preserve': case '--allow': options.preserve.push(requireValue(arg, queue)); break;
      case '--allow-extra': options.allowExtra.push(requireValue(arg, queue)); break;
      case '--fresh-lock': options.freshLock = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--json': options.json = true; break;
      case '--quiet': options.quiet = true; break;
      case '--lines': options.lines = true; break;
      case '--self-test': options.selfTest = true; break;
      default:
        if (arg.startsWith('--')) throw usageError(`unknown option: ${arg}`);
        if (options.verb !== null) throw usageError(`unexpected argument: ${arg}`);
        if (!verbs.includes(arg)) throw usageError(`unknown verb: ${arg} (expected one of ${verbs.join(', ')})`);
        options.verb = arg;
    }
  }
  if (options.source !== 'git' && options.source !== 'worktree') {
    throw usageError(`--source must be git or worktree, got ${JSON.stringify(options.source)}`);
  }
  if (options.freshLock) options.preserve.push('profiles/web/pnpm-lock.yaml');
  return options;
}

function requireValue(flag, queue) {
  const value = queue.shift();
  if (value === undefined) throw usageError(`${flag} needs a value`);
  return value;
}

function requirePreserve(list) {
  const entries = [];
  for (const raw of list) {
    const value = String(raw).replace(/\\/g, '/');
    const relative = value.startsWith('./') ? value.slice(2) : value;
    if (relative.length === 0 || path.isAbsolute(relative) || relative.startsWith('/')) {
      throw usageError(`--preserve needs a repo-relative path, got ${JSON.stringify(raw)}`);
    }
    if (relative.split('/').some((segment) => segment === '..')) {
      throw usageError(`--preserve cannot escape the image root: ${JSON.stringify(raw)}`);
    }
    if (!entries.includes(relative)) entries.push(relative);
  }
  return entries;
}

function resolveHome(value) {
  return path.resolve(value || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

// ── 清单构建 ───────────────────────────────────────────────────────────────
// 两侧必须用**同一个**哈希口径，否则「内容漂移」判定的不是内容。
//
// 口径 = git 的 blob 对象名：sha1("blob <len>\0" + 内容)。选它而不是裸 sha256，
// 是因为它和 `git ls-tree` / `git hash-object` 说的是同一件事：受控文件来自
// `git archive`（或工作树），其规范形式就是 blob 内容。清单侧三种来源（提交
// blob、工作树文件、镜像文件）因此都归到同一个式子里，不会出现「提交侧算 blob
// 哈希、镜像侧算裸哈希」——那样每个文件都会报成漂移，门禁永远红，于是没人再
// 看它（本模块第一版就长这样）。
//
// 反作用也成立：镜像里的文件若被别的工具按平台改写（CRLF、重编码），blob 口径
// 会如实报成漂移。
function hashBytes(buffer) {
  return require('node:crypto').createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`, 'utf8'), buffer]))
    .digest('hex');
}

function hashFile(absolute) {
  try {
    return hashBytes(fs.readFileSync(absolute));
  } catch (error) {
    return { error: error.message };
  }
}

function git(repoRoot, args, { maxBuffer = 512 * 1024 * 1024, input } = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer, input });
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function listGitSource(repoRoot, paths) {
  const listing = git(repoRoot, ['ls-tree', '-r', '--full-tree', 'HEAD', '--', ...paths]);
  const entries = [];
  for (const line of listing.split('\n')) {
    if (line.length === 0) continue;
    const match = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/);
    if (!match) throw new Error(`cannot parse git ls-tree line: ${JSON.stringify(line)}`);
    const [, mode, type, hash, file] = match;
    if (type !== 'blob' || !REGULAR_FILE_MODES.has(mode)) continue;
    entries.push({ path: file, hash });
  }
  return entries;
}

// 工作树形态：已跟踪文件 + 未跟踪但**未被忽略**的文件，内容按原始字节取
// sha256——与 git 形态对 blob 的取法完全同构，两种 source 因此可以直接互比。
// 刻意不走 `git ls-files -s`：它只给已跟踪文件带索引信息，未跟踪文件那一行
// 没有 mode/hash，解析必然失败（实测报 `cannot parse git ls-files line`）。
//
// 被忽略的文件必须显式剔除：`--cached --others --exclude-standard` 会**包含**
// 被忽略的文件（`--exclude-standard` 只挡「未跟踪的目录」这类，不挡已列出的
// 忽略文件），而落位用的 `tar --exclude-from` 在同一台机器上并不总是生效
// （GNU tar 1.35 在 Windows 风格仓库路径下不匹配这些模式——实测仓库在
// `C:/Users/.../repo` 时会漏掉 `alpha/.env`，在 `/tmp/...` 下却能正确排除）。
// 两侧都按同一份枚举结果来，就不必依赖 tar 的模式语义：源与镜像一致，
// 也不会出现「prune 删掉、下次 stage 又加回来」的抖动。
function listWorktreeSource(repoRoot, paths) {
  const ignored = new Set(
    git(repoRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...paths])
      .split('\0')
      .filter((file) => file.length > 0),
  );
  const listing = git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths]);
  return listing.split('\0')
    .filter((file) => file.length > 0 && !ignored.has(file) && !isSkipped(file))
    .sort();
}

// git 对象库→镜像：提交里的每个 blob 都在一次 git cat-file --batch 里取出，
// 用 blob 的 sha1 做键。清单里的「期望字节」因此来自提交本身，而不是工作树
// 的换行符或行尾转换。
function readGitBlobs(repoRoot, hashes) {
  const contents = new Map();
  if (hashes.length === 0) return contents;
  const result = spawnSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: `${hashes.join('\n')}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git cat-file --batch failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch exited ${result.status}: ${(result.stderr || '').toString().trim()}`);
  }
  const buffer = result.stdout;
  let offset = 0;
  const newline = Buffer.from('\n');
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf(newline, offset);
    if (headerEnd < 0) throw new Error('git cat-file --batch returned a truncated header');
    const header = buffer.toString('utf8', offset, headerEnd);
    const match = header.match(/^([0-9a-f]+) (\w+) (\d+)$/);
    if (!match) throw new Error(`unexpected git cat-file header: ${JSON.stringify(header)}`);
    const [, hash, type, size] = match;
    const start = headerEnd + 1;
    if (type !== 'blob') throw new Error(`git object ${hash} is a ${type}, not a blob`);
    contents.set(hash, buffer.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1; // 跳过对象内容后的分隔换行
  }
  return contents;
}

function buildManifest({ repoRoot, home, source, controlledPaths }) {
  const files = new Map();
  let totalBytes = 0;
  if (source === 'worktree') {
    for (const file of listWorktreeSource(repoRoot, controlledPaths)) {
      // 已删但尚未提交的 tracked 文件仍在 `git ls-files --cached --others` 的清单里
      // （索引不知道磁盘删了它），而落位走的是文件系统（tar / git archive 都不会
      // 落一个不存在的文件）。这里必须按**磁盘**判断存在性：不存在就当它不在清单
      // 里。否则 `--from-worktree` 在第 1 步直接 ENOENT 崩掉，而「先删文件再部署」
      // 恰恰是开发回路里最常见的动作。
      let buffer;
      try {
        buffer = fs.readFileSync(path.join(repoRoot, file));
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') continue;
        throw new Error(`cannot read worktree file ${file}: ${error.message}`);
      }
      files.set(file, { hash: hashBytes(buffer), bytes: buffer.length });
      totalBytes += buffer.length;
    }
  } else {
    const entries = listGitSource(repoRoot, controlledPaths);
    const contents = readGitBlobs(repoRoot, [...new Set(entries.map((entry) => entry.hash))].sort());
    for (const entry of entries) {
      const buffer = contents.get(entry.hash);
      if (buffer === undefined) throw new Error(`git did not return blob ${entry.hash} (${entry.path})`);
      files.set(entry.path, { hash: hashBytes(buffer), bytes: buffer.length });
      totalBytes += buffer.length;
    }
  }
  return {
    repoRoot,
    home,
    source,
    controlledPaths,
    files,
    metrics: { files: files.size, bytes: totalBytes },
  };
}

// ── 镜像侧 ─────────────────────────────────────────────────────────────────
function walk(root, relative, into) {
  let dirents;
  try {
    dirents = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot list ${path.join(root, relative)}: ${error.message}`);
  }
  for (const dirent of dirents) {
    const child = relative.length === 0 ? dirent.name : `${relative}/${dirent.name}`;
    // isDirectory() 对符号链接为假，所以链接本身按「文件」处理：清理时删链接
    // 不删链接指向的内容（Node 的 rmSync 对链接不跟随）。
    if (dirent.isDirectory()) walk(root, child, into);
    else if (dirent.isFile() || dirent.isSymbolicLink()) into.add(child);
  }
}

function readTarget(home, controlledPaths, preserve = new Set()) {
  const present = new Set();
  for (const relative of controlledPaths) {
    const absolute = path.join(home, relative);
    let stats;
    try {
      stats = fs.lstatSync(absolute);
    } catch {
      continue; // 受控路径整体缺失：清单里每一项都会报「缺失文件」
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) walk(home, relative, present);
    else present.add(relative);
  }
  const files = new Map();
  let skipped = 0;
  for (const relative of present) {
    if (isSkipped(relative)) {
      // 跳过策略命中的路径既不是差异也不是清理对象：一个标记，不是一次删除。
      files.set(relative, { skipped: skipReason(relative) });
      skipped += 1;
      continue;
    }
    if (preserve.has(relative)) {
      // 本机适配：内容允许偏离，但仍在镜像里可被引用。
      const allowed = hashFile(path.join(home, relative));
      files.set(relative, typeof allowed === 'string' ? { allowed: true, hash: allowed } : { allowed: true, ...allowed });
      continue;
    }
    const hashed = hashFile(path.join(home, relative));
    files.set(relative, typeof hashed === 'string' ? { hash: hashed } : hashed);
  }
  files.meta = { skipped };
  return files;
}

// ── 差异 ───────────────────────────────────────────────────────────────────
function diffSources(gitManifest, worktreeManifest) {
  if (gitManifest.metrics.files !== worktreeManifest.metrics.files) return false;
  for (const [file, entry] of gitManifest.files) {
    const other = worktreeManifest.files.get(file);
    if (other === undefined || other.hash !== entry.hash) return false;
  }
  return true;
}

function plan({ repoRoot, home, source, preserve = [], controlledPaths }) {
  const preserveSet = new Set(preserve);
  const manifest = buildManifest({ repoRoot, home, source, controlledPaths });
  const target = readTarget(home, controlledPaths, preserveSet);

  const extraFiles = [];
  for (const [relative, actual] of target) {
    if (actual.skipped !== undefined) continue; // 跳过策略命中
    if (actual.allowed === true) continue;      // --preserve 命中
    if (manifest.files.has(relative)) continue;
    extraFiles.push(relative);
  }
  const missingFiles = [];
  const driftedFiles = [];
  for (const [relative, expected] of manifest.files) {
    if (preserveSet.has(relative)) continue; // 已声明的本机适配，见下方 allowedFiles
    const actual = target.get(relative);
    if (actual === undefined) missingFiles.push(relative);
    else if (actual.hash !== undefined && actual.hash !== expected.hash) driftedFiles.push(relative);
  }
  // 本机适配只在「镜像里真有这个文件」时才算「已声明」；否则它已经以缺失文件
  // 报出来了，再列一次只会让人以为它没事。
  const allowedFiles = [];
  for (const relative of preserveSet) {
    const actual = target.get(relative);
    if (actual !== undefined && actual.skipped === undefined) allowedFiles.push(relative);
  }
  extraFiles.sort();
  missingFiles.sort();
  driftedFiles.sort();
  allowedFiles.sort();

  // 可删目录 = 「我们造出来的、且清单不再需要它」的目录。三条排除规则，缺一条
  // 就会去删不该删的东西：
  //   * 受控路径本身永不删（shippedRoots）——它由 §1 的落位清单定义，删掉它
  //     等于删掉一个包；
  //   * 目录下还有清单文件（fileDirectories）就不删——那是真正被引用的目录，
  //     例如 alpha/（还有 alpha/one.txt）；
  //   * 目录下还有跳过策略命中的后代（protected prefixes）就不删——例如
  //     profiles/web/node_modules/ 里还有依赖。
  // prune 另外还会在删除前复查「目录确已为空」，两道闸门互相独立。
  const shippedRoots = new Set(controlledPaths);
  const fileDirectories = new Set();
  for (const relative of manifest.files.keys()) {
    const segments = relative.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      fileDirectories.add(segments.slice(0, index).join('/'));
    }
  }
  const directories = new Set();
  for (const relative of extraFiles) {
    const segments = relative.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  const holdsProtected = (directory) => [...target.keys()].some(
    (relative) => relative.startsWith(`${directory}/`) && target.get(relative).skipped !== undefined,
  );
  const removableDirectories = [...directories]
    .filter((directory) => !shippedRoots.has(directory))
    .filter((directory) => !fileDirectories.has(directory))
    .filter((directory) => !preserveSet.has(directory))
    .filter((directory) => !holdsProtected(directory))
    .sort((left, right) => right.length - left.length || (left < right ? 1 : -1));

  return {
    manifest,
    target,
    extraFiles,
    missingFiles,
    driftedFiles,
    allowedFiles,
    removableDirectories,
    metrics: {
      files: manifest.metrics.files,
      bytes: manifest.metrics.bytes,
      skipped: target.meta.skipped,
      extra: extraFiles.length,
      missing: missingFiles.length,
      drifted: driftedFiles.length,
      allowed: allowedFiles.length,
      removable: extraFiles.length + removableDirectories.length,
    },
  };
}

function prune(result, { dryRun }) {
  const removedFiles = [];
  const removedDirectories = [];
  const failures = [];
  for (const relative of result.extraFiles) {
    if (dryRun) { removedFiles.push(relative); continue; }
    const absolute = path.join(result.manifest.home, relative);
    try {
      // 先 lstat 再删：删的是链接本身，不跟随链接指向目录（rmSync 对链接不递归）。
      fs.lstatSync(absolute);
      fs.rmSync(absolute, { force: true });
      removedFiles.push(relative);
    } catch (error) {
      failures.push(`${relative}: ${error.message}`);
    }
  }
  for (const relative of result.removableDirectories) {
    if (dryRun) { removedDirectories.push(relative); continue; }
    const absolute = path.join(result.manifest.home, relative);
    try {
      const stats = fs.lstatSync(absolute);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      const remaining = fs.readdirSync(absolute);
      if (remaining.length > 0) {
        failures.push(`${relative}: still holds ${remaining.length} entr(y|ies) after the file sweep`);
        continue;
      }
      fs.rmdirSync(absolute);
      removedDirectories.push(relative);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      failures.push(`${relative}: ${error.message}`);
    }
  }
  return { removedFiles, removedDirectories, failures };
}

// ── 报告 ───────────────────────────────────────────────────────────────────
function describe(result) {
  const { metrics } = result;
  const lines = [
    `image   : ${result.manifest.home}`,
    `source  : ${result.manifest.source === 'git' ? 'git HEAD' : 'working tree'} @ ${result.manifest.repoRoot}`,
    `metrics : files ${metrics.files} checked, ${metrics.skipped} skipped, extra ${metrics.extra}, missing ${metrics.missing}, drifted ${metrics.drifted}, allowed ${metrics.allowed}`,
  ];
  if (result.allowedFiles.length > 0) {
    lines.push('allowed (--preserve，本机适配，不计入差异):');
    for (const relative of result.allowedFiles) {
      lines.push(`  ~ ${relative}${LOCAL_ADAPTATIONS[relative] ? `  [${LOCAL_ADAPTATIONS[relative]}]` : ''}`);
    }
  }
  if (result.extraFiles.length > 0) {
    lines.push(`extra (镜像里有、清单里没有) x${result.extraFiles.length}:`);
    for (const relative of result.extraFiles) lines.push(`  + ${relative}`);
  }
  if (result.missingFiles.length > 0) {
    lines.push(`missing (清单里有、镜像里没有) x${result.missingFiles.length}:`);
    for (const relative of result.missingFiles) lines.push(`  - ${relative}`);
  }
  if (result.driftedFiles.length > 0) {
    lines.push(`drifted (两边都有、内容不同) x${result.driftedFiles.length}:`);
    for (const relative of result.driftedFiles) {
      const expected = result.manifest.files.get(relative);
      const actual = result.target.get(relative);
      const actualHash = actual === undefined ? 'absent' : (actual.error ? `unreadable(${actual.error})` : actual.hash.slice(0, 12));
      lines.push(`  ! ${relative}  source ${expected.hash.slice(0, 12)} vs image ${actualHash}`);
    }
  }
  return lines.join('\n');
}

function toJson(result, extra = {}) {
  return JSON.stringify({
    home: result.manifest.home,
    repo: result.manifest.repoRoot,
    source: result.manifest.source,
    metrics: result.metrics,
    extra: result.extraFiles,
    missing: result.missingFiles,
    drifted: result.driftedFiles,
    allowed: result.allowedFiles,
    removableDirectories: result.removableDirectories,
    ...extra,
  }, null, 2);
}

function hasDifferences(result) {
  return result.metrics.extra > 0 || result.metrics.missing > 0 || result.metrics.drifted > 0;
}

// 结论行是部署脚本与 verify-image.js 共用的判词（两边各写一份必然漂）。
// 零差异时给出可断言的一行：`scripts/deploy-live.sh` 的第 6 步与本地巡检都
// grep 它，比解析 metrics 稳。
function verdict(result) {
  const target = result.manifest.source === 'git' ? 'the commit' : 'the working tree';
  return hasDifferences(result)
    ? `FAIL: the image does not match ${target} — see the sections above`
    : `ok: the image matches ${target} (${result.metrics.files} controlled files)`;
}

// ── 自检 ───────────────────────────────────────────────────────────────────
// 造一棵假镜像 + 一个假仓库（真实 git 仓库，因此两种 source 都能真跑），覆盖：
// 内容一致 / 漂移 / 多余 / 缺失 / 受控路径外不动 / 跳过策略 / prune 收敛。
function selfTest() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'image-manifest-selftest-'));
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    const repoRoot = path.join(sandbox, 'repo');
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'alpha', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'beta'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'deploy-live.sh'), [
      '# fixture: same shape as the real script — PACKAGES closes at end of line,',
      '# EXTRA_PATHS closes mid-line (that difference is what the parser must survive).',
      'PACKAGES="alpha',
      'beta"',
      'PACKAGE_COUNT=2',
      'EXTRA_PATHS="gamma"   # trailing comment on the same line',
      'EXTRA_COUNT=1',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(repoRoot, 'gamma'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'gamma', 'four.txt'), 'gamma-four\n');
    fs.writeFileSync(path.join(repoRoot, 'alpha', 'one.txt'), 'alpha-one\n');
    fs.writeFileSync(path.join(repoRoot, 'alpha', 'nested', 'two.txt'), 'alpha-two\n');
    fs.writeFileSync(path.join(repoRoot, 'beta', 'three.txt'), 'beta-three\n');

    const gitArgs = ['-C', repoRoot];
    const gitRun = (...args) => {
      const result = spawnSync('git', [...gitArgs, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`self-test git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout;
    };
    gitRun('init', '-q');
    gitRun('config', 'user.email', 'self-test@example.invalid');
    gitRun('config', 'user.name', 'image-manifest self-test');
    gitRun('add', '-A');
    gitRun('commit', '-qm', 'fixture');

    // 受控路径清单也从 fixture 的 deploy-live.sh 里读——这是真实用例的取值方式。
    const controlledPaths = readControlledPaths(repoRoot);
    check(controlledPaths.join(',') === 'alpha,beta,gamma', 'controlled paths do not round-trip through deploy-live.sh');

    const clean = plan({ repoRoot, home, source: 'git', controlledPaths });
    check(clean.metrics.files === 4, `expected 4 manifest files, saw ${clean.metrics.files}`);
    check(clean.metrics.missing === 4, `empty image must report 4 missing, saw ${clean.metrics.missing}`);

    // 落位一份正确的镜像，再逐类制造差异。
    for (const entry of ['alpha/one.txt', 'alpha/nested/two.txt', 'beta/three.txt', 'gamma/four.txt']) {
      const target = path.join(home, entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, entry), target);
    }
    const identical = plan({ repoRoot, home, source: 'git', controlledPaths });
    check(!hasDifferences(identical), `byte-identical image reported differences: ${JSON.stringify(identical.metrics)}`);

    fs.writeFileSync(path.join(home, 'beta', 'three.txt'), 'beta-three-DRIFTED\n');
    fs.writeFileSync(path.join(home, 'beta', 'stale.txt'), 'stale\n');
    fs.mkdirSync(path.join(home, 'alpha', 'dead'), { recursive: true });
    fs.writeFileSync(path.join(home, 'alpha', 'dead', 'index.iife.js'), 'dead\n');
    fs.rmSync(path.join(home, 'alpha', 'nested', 'two.txt'));
    fs.writeFileSync(path.join(home, 'settings.yaml'), 'host level\n'); // 受控路径之外
    fs.mkdirSync(path.join(home, 'beta', 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(home, 'beta', 'node_modules', 'x', 'index.js'), 'dep\n');

    const dirty = plan({ repoRoot, home, source: 'git', controlledPaths });
    check(
      dirty.extraFiles.join(',') === 'alpha/dead/index.iife.js,beta/stale.txt',
      `extra set drifted: ${JSON.stringify(dirty.extraFiles)}`,
    );
    check(!dirty.extraFiles.includes('beta/node_modules/x/index.js'), 'node_modules must not be reported as extra');
    check(!dirty.extraFiles.includes('settings.yaml'), 'files outside the controlled paths must not be reported');
    check(dirty.missingFiles.join(',') === 'alpha/nested/two.txt', `missing set drifted: ${JSON.stringify(dirty.missingFiles)}`);
    check(dirty.driftedFiles.join(',') === 'beta/three.txt', `drift set drifted: ${JSON.stringify(dirty.driftedFiles)}`);
    check(dirty.removableDirectories.join(',') === 'alpha/dead', `removable directories drifted: ${JSON.stringify(dirty.removableDirectories)}`);

    const preserved = plan({ repoRoot, home, source: 'git', controlledPaths, preserve: ['beta/three.txt', 'beta/stale.txt'] });
    check(!preserved.driftedFiles.includes('beta/three.txt'), '--preserve must absorb content drift');
    check(!preserved.extraFiles.includes('beta/stale.txt'), '--preserve must protect a file from pruning');
    check(preserved.allowedFiles.join(',') === 'beta/stale.txt,beta/three.txt', `allowed list drifted: ${JSON.stringify(preserved.allowedFiles)}`);

    const dry = prune(dirty, { dryRun: true });
    check(fs.existsSync(path.join(home, 'beta', 'stale.txt')), '--dry-run must not delete anything');
    check(dry.removedFiles.length === 2, `dry-run should report 2 files, saw ${JSON.stringify(dry.removedFiles)}`);
    check(dry.removedDirectories.join(',') === 'alpha/dead', `dry-run should report 1 directory, saw ${JSON.stringify(dry.removedDirectories)}`);

    const applied = prune(plan({ repoRoot, home, source: 'git', controlledPaths }), { dryRun: false });
    check(applied.failures.length === 0, `prune reported failures: ${JSON.stringify(applied.failures)}`);
    const converged = plan({ repoRoot, home, source: 'git', controlledPaths });
    check(converged.metrics.extra === 0, `prune did not converge: ${JSON.stringify(converged.extraFiles)}`);
    check(!fs.existsSync(path.join(home, 'alpha', 'dead')), 'prune must remove emptied directories');
    check(fs.existsSync(path.join(home, 'beta', 'node_modules', 'x', 'index.js')), 'prune must keep skipped paths');
    check(fs.existsSync(path.join(home, 'settings.yaml')), 'prune must not touch anything outside the controlled paths');

    // 二次 prune 必须无事可做（收敛语义）。
    const second = prune(plan({ repoRoot, home, source: 'git', controlledPaths }), { dryRun: false });
    check(second.removedFiles.length === 0 && second.removedDirectories.length === 0, 'second prune must be a no-op');

    // 两种 source 在「工作树 == HEAD」时必须得到同一份清单。
    const fromHead = buildManifest({ repoRoot, home, source: 'git', controlledPaths });
    const fromTree = buildManifest({ repoRoot, home, source: 'worktree', controlledPaths });
    check(diffSources(fromHead, fromTree), 'git and worktree sources disagree on a clean checkout');
    fs.writeFileSync(path.join(repoRoot, 'beta', 'three.txt'), 'uncommitted\n');
    const dirtyTree = buildManifest({ repoRoot, home, source: 'worktree', controlledPaths });
    check(!diffSources(fromHead, dirtyTree), 'worktree source must see uncommitted edits');

    // prune 的安全性：受控路径整体缺失时清单为空 → 不允许删任何东西。
    const empty = plan({ repoRoot, home: path.join(sandbox, 'nowhere'), source: 'git', controlledPaths });
    check(empty.extraFiles.length === 0 && empty.removableDirectories.length === 0, 'a missing image must not be treated as removable');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    throw new Error(`${failures.length} self-test assertion(s) failed`);
  }
  process.stdout.write('image-manifest self-test passed (7 scenarios)\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────
function usage() {
  const text = fs.readFileSync(SELF, 'utf8');
  const start = text.indexOf('// 用法（node image-manifest.js');
  const end = text.indexOf('\n\nconst fs =');
  return `${text.slice(start, end).replace(/^\/\/ ?/gm, '')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2), { verbs: VERBS });
  if (options.help === true) {
    process.stdout.write(usage());
    return 0;
  }
  if (options.selfTest) {
    selfTest();
    return 0;
  }
  if (options.verb === null) {
    process.stderr.write(usage());
    return 1;
  }
  // 清理动作默认不允许「顺手加个例外」：受控路径清单来自仓库脚本，--allow-extra
  // 只放开「多出来的清单项」这一种失败（用于把新目录挂进受控清单前的过渡）。
  const repoRoot = path.resolve(options.repo);
  const home = resolveHome(options.home);
  // 前置条件查得越早，报错越像人话：镜像根不存在、指到了一个不是本仓的目录，
  // 都必须在「对账」之前失败，而不是变成 290 项缺失。（原来是 verify-image.js
  // 的前置检查，合并入口时搬进来。）
  if (!fs.existsSync(path.join(repoRoot, 'scripts', 'deploy-live.sh'))) {
    throw usageError(`${repoRoot} is not a Fairy-DSH checkout (no scripts/deploy-live.sh)`);
  }
  if (options.verb !== 'paths') {
    let stats;
    try {
      stats = fs.statSync(home);
    } catch {
      throw usageError(`image root does not exist: ${home}`);
    }
    if (!stats.isDirectory()) throw usageError(`image root is not a directory: ${home}`);
  }
  const controlledPaths = readControlledPaths(repoRoot).filter((entry) => !options.allowExtra.includes(entry));
  const preserve = requirePreserve(options.preserve);

  if (options.verb === 'paths') {
    for (const entry of controlledPaths) process.stdout.write(`${entry}\n`);
    return 0;
  }
  if (options.verb === 'policy') {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ skip: SKIP_POLICY, localAdaptations: LOCAL_ADAPTATIONS }, null, 2)}\n`);
      return 0;
    }
    if (options.lines) {
      // 只印本机适配的路径，一行一条：调用方（deploy-live.sh 的 --preserve 默认值）
      // 要的就是这份清单，不必再起第二个进程解析 JSON。
      for (const key of Object.keys(LOCAL_ADAPTATIONS)) process.stdout.write(`${key}\n`);
      return 0;
    }
    for (const entry of SKIP_POLICY) {
      // 策略有三种形状（segment / prefix / file），只印 prefix 会打出 `skip undefined`。
      const key = entry.segment ?? entry.prefix ?? entry.file ?? '(unset)';
      const shape = entry.segment ? 'segment' : entry.prefix ? 'prefix' : 'file';
      process.stdout.write(`skip  ${shape.padEnd(7)} ${key}\t${entry.reason}\n`);
    }
    for (const [key, reason] of Object.entries(LOCAL_ADAPTATIONS)) process.stdout.write(`allow ${key}\t${reason}\n`);
    return 0;
  }

  const result = plan({ repoRoot, home, source: options.source, preserve, controlledPaths });
  if (options.verb === 'count') {
    process.stdout.write(options.json ? `${toJson(result)}\n` : `${result.metrics.files}\n`);
    return 0;
  }
  if (options.verb === 'check') {
    const clean = !hasDifferences(result);
    if (options.json) {
      process.stdout.write(`${toJson(result)}\n`);
    } else if (!options.quiet || !clean) {
      // --quiet：只在有差异时输出（CI 里按键读日志用），与 verify-image.js 同义。
      process.stdout.write(`${describe(result)}\n`);
      process.stdout.write(`${verdict(result)}\n`);
    }
    return clean ? 0 : 1;
  }
  // prune
  if (options.dryRun) {
    const preview = prune(result, { dryRun: true });
    if (options.json) {
      process.stdout.write(`${toJson(result, { dryRun: true, removedFiles: preview.removedFiles, removedDirectories: preview.removedDirectories })}\n`);
    } else if (preview.removedFiles.length === 0 && preview.removedDirectories.length === 0) {
      process.stdout.write(`image is already convergent with ${options.source === 'git' ? 'git HEAD' : 'the working tree'} (nothing to prune)\n`);
    } else {
      process.stdout.write(`would prune ${preview.removedFiles.length} file(s), ${preview.removedDirectories.length} dir(s) from ${home}:\n`);
      for (const relative of preview.removedFiles) process.stdout.write(`  + ${relative}\n`);
      for (const relative of preview.removedDirectories) process.stdout.write(`  - ${relative}/\n`);
    }
    return 0;
  }
  const applied = prune(result, { dryRun: false });
  if (applied.failures.length > 0) {
    for (const failure of applied.failures) process.stderr.write(`  ! ${failure}\n`);
    throw new Error(`prune could not converge ${applied.failures.length} path(s)`);
  }
  if (options.json) {
    process.stdout.write(`${toJson(result, { dryRun: false, removedFiles: applied.removedFiles, removedDirectories: applied.removedDirectories })}\n`);
  } else if (applied.removedFiles.length === 0 && applied.removedDirectories.length === 0) {
    process.stdout.write(`image is already convergent with ${options.source === 'git' ? 'git HEAD' : 'the working tree'} (nothing to prune)\n`);
  } else {
    process.stdout.write(`pruned ${applied.removedFiles.length} file(s), ${applied.removedDirectories.length} dir(s) from ${home}:\n`);
    for (const relative of applied.removedFiles) process.stdout.write(`  + ${relative}\n`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`image-manifest: ${error.message}\n`);
    // 用法/前置条件错误与「对账有差异」必须分开：调用方（CI、部署脚本）靠退出码
    // 区分「镜像不对，去修镜像」和「命令本身没法执行，去修命令」。precondition
    // 抛出的错都带 usage 标记，其余按 1。
    process.exitCode = error.usage === true ? 2 : 1;
  }
}

module.exports = {
  DEFAULT_REPO,
  LOCAL_ADAPTATIONS,
  SKIP_POLICY,
  buildManifest,
  describe,
  diffSources,
  hasDifferences,
  isSkipped,
  plan,
  prune,
  readControlledPaths,
  readTarget,
  selfTest,
  skipReason,
  toJson,
  verdict,
};
