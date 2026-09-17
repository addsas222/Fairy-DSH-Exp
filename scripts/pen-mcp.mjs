#!/usr/bin/env node
/**
 * pen-mcp.mjs — 设计工坊：把 pen.dev 的 MCP 自动接到 DSH 的 web profile 上。
 *
 * 用户侧流程（本脚本就是第 2 步的自动化）：
 *   1) 没装 Pen ⇒ 照本脚本打印的指引自行安装（我们**不做**静默安装）；
 *   2) 装好后 ⇒ 跑本脚本，往 `profiles/web/cordis.patch.yml` 的 insert 列表里补一行
 *      `pen` MCP（幂等：已有则跳过），此后 DSH 会话即可用 Pen 的工具；
 *   3) 设计会话由 DSH 自己的 agent + 模型配置驱动（MCP 只是笔刷）——
 *      即「用本体的模型配置启动设计」。
 *
 * 两个前提写进输出里，因为踩过：
 *   · MCP 是**连运行中的应用**，不是独立服务：Pen 没在跑就会报
 *     "failed to connect to running Pencil app"；
 *   · MCP 还要求编辑器里**打开着一个 .pen 文件**，否则报 "a file needs to be open"。
 *
 * 用法：
 *   node scripts/pen-mcp.mjs [--check] [--ensure] [--dry-run]
 *                            [--profile-patch PATH] [--agent NAME]
 *   默认 --ensure（= 探测 + 能配就配 + 配置后打印下一步）。
 * 退出码：0 配好或已存在；3 未装 Pen（已打印安装指引，不视为失败）；1 其他错误。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const log = (m) => console.log(`\u001b[36m[pen-mcp]\u001b[0m ${m}`);
const warn = (m) => console.warn(`\u001b[33m[pen-mcp]\u001b[0m ${m}`);

function parseArgs(argv) {
  const options = { mode: 'ensure', dryRun: false, profilePatch: '', agent: 'dsh', home: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--ensure') options.mode = 'ensure';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--home') options.home = argv[++i];
    else if (arg === '--profile-patch') options.profilePatch = argv[++i];
    else if (arg === '--agent') options.agent = argv[++i];
    else if (arg === '-h' || arg === '--help') { printHelp(); process.exit(0); }
    else { console.error(`[pen-mcp] unknown option: ${arg}`); process.exit(1); }
  }
  return options;
}

function printHelp() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const start = source.findIndex((line) => line.startsWith('/**'));
  const end = source.findIndex((line, index) => index > start && line.startsWith(' */'));
  for (const line of source.slice(start + 1, end)) console.log(line.replace(/^ \* ?/, ''));
}

/** 找 Pen 的 MCP 可执行文件：先看应用自带的那份，再看 ~/.pencil 下的编辑器变体。 */
function findPenMcp() {
  const candidates = [];
  const push = (dir, names) => {
    if (!dir || !existsSync(dir)) return;
    for (const name of names) {
      const hit = join(dir, name);
      if (existsSync(hit)) candidates.push(hit);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) push(join(dir, entry.name), names);
    }
  };
  const names = [
    'mcp-server-windows-x64.exe', 'mcp-server-darwin-arm64', 'mcp-server-darwin-x64',
    'mcp-server-linux-x64', 'mcp-server-linux-arm64',
  ];
  // 本机的 Pen 可能不在当前盘（实测这台在 D:，而 LOCALAPPDATA 指 C:）⇒ 连同用户 profile
  // 所在盘一起探，另留 DSH_PEN_DIR 覆盖口。
  const penDirs = [process.env.DSH_PEN_DIR, join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Pen')].filter(Boolean);
  if (IS_WINDOWS) {
    const profileRoot = (process.env.USERPROFILE ?? '').replace(/^[A-Za-z]:/, '');
    for (const drive of ['C:', 'D:', 'E:']) penDirs.push(join(drive + '\\', profileRoot, 'AppData', 'Local', 'Programs', 'Pen'));
  }
  const appRoots = IS_WINDOWS
    ? penDirs
    : process.platform === 'darwin'
      ? ['/Applications/Pen.app/Contents/Resources', join(homedir(), 'Applications', 'Pen.app', 'Contents', 'Resources')]
      : ['/opt/Pen/resources', '/usr/lib/Pen/resources', join(homedir(), '.local', 'share', 'Pen', 'resources')];
  // Windows 的应用自带 MCP 在 <Pen>\\resources\\app.asar.unpacked\\out（macOS 的 root 已经是 Contents/Resources）。
  for (const root of appRoots) {
    push(join(root, 'resources', 'app.asar.unpacked', 'out'), names);
    push(join(root, 'app.asar.unpacked', 'out'), names);
  }
  // ~/.pencil/mcp/<variant>/ 是**编辑器变体**，只能配同名 -app；排在桌面版之后。
  push(join(homedir(), '.pencil', 'mcp'), names);
  return candidates[0] ?? null;
}

const INSTALL_GUIDE = [
  '未检测到 Pen —— 请先自行安装（我们不做静默安装）：',
  '  1) 打开 https://www.pen.dev/ 下载对应平台的安装包并安装；',
  '  2) 首次启动完成引导，随便新建或打开一个 .pen 文件；',
  '  3) 回到这里重跑本脚本（或重跑安装器）——它会自动把 MCP 配进 DSH 的 web profile。',
  '提醒：MCP 连接的是**运行中的应用**，且要求编辑器里打开着 .pen 文件；',
  '      这两条不满足时 Pen 侧会报 "failed to connect" / "a file needs to be open"。',
].join('\n');

/** 幂等：patch 里已有 pen 行就跳过；否则插到 insert 列表最前面。 */
function ensureProfileRow(patchPath, mcpPath, appId, agent, dryRun) {
  if (!existsSync(patchPath)) {
    warn(`profile patch 不存在：${patchPath}（先跑一次部署，或 --profile-patch 指定）`);
    return false;
  }
  const text = readFileSync(patchPath, 'utf8');
  if (/^\s*-\s*id:\s*mcp-pen\s*$/m.test(text)) {
    log(`pen MCP 已在 profile 里（${patchPath}）：无需改动`);
    return true;
  }
  const command = mcpPath.replace(/\\/g, '\\\\');
  const block = [
    '    # 设计工坊：pen.dev 的 MCP（由 scripts/pen-mcp.mjs 自动写入，幂等）。',
    '    # 前提：Pen 应用在运行，且编辑器里打开着一个 .pen 文件。',
    '    - id: mcp-pen',
    `      name: '@deepseek-ai/dsh-mcp-client'`,
    '      config:',
    // serverName/transport 是 dsh-mcp-client 的必填项（0.1.1 起校验；缺了整棵插件树
    // 都起不来，实测报 invalid config）；failOnStartupError=false 让 Pen 没开时只降级、不炸启动。
    '        serverName: pen',
    '        transport: stdio',
    `        command: '${command}'`,
    '        args:',
    `          - '-app'`,
    `          - '${appId}'`,
    `          - '-agent'`,
    `          - '${agent}'`,
    '        failOnStartupError: false',
    '',
  ].join('\n');
  if (!/^- insert:\s*$/m.test(text)) {
    warn('该 patch 里没有 `- insert:` 段落，未自动改写；请手工把 pen MCP 行加进 profile。');
    return false;
  }
  const next = text.replace(/^- insert:\s*$/m, (line) => `${line}\n${block}`);
  if (dryRun) { console.log(next.slice(next.indexOf('- insert:'), next.indexOf('- insert:') + 400)); return true; }
  writeFileSync(patchPath, next);
  log(`已写入 pen MCP 行（${patchPath}）：${mcpPath}`);
  return true;
}

/** -app 与变体配对：~/.pencil/mcp/<variant>/ 取 <variant>；应用自带的那份取 desktop。 */
export function appIdFor(mcpPath) {
  if (!mcpPath) return 'desktop';
  const variant = /[\\/]\.pencil[\\/]mcp[\\/]([^\\/]+)[\\/]/.exec(String(mcpPath).replace(/\\/g, '/'))?.[1];
  return variant ?? 'desktop';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  // 默认写到**已安装 home** 的 profile patch：它是机器本地文件（部署时被 --preserve 保住），
  // 写它不会把「本机 Pen 路径」带进仓库；仓库那份 patch 保持干净。
  const home = options.home || process.env.DSH_HOME || join(homedir(), '.dsh-fairy');
  const patchPath = resolve(options.profilePatch || join(home, 'profiles', 'web', 'cordis.patch.yml'));
  const mcpPath = findPenMcp();
  if (!mcpPath) {
    console.log(INSTALL_GUIDE);
    process.exit(3);
  }
  // -app 必须与变体配对：应用自带的那份连桌面应用（desktop），
  // ~/.pencil/mcp/<variant>/ 下的只能配同名（visual_studio_code 等）。配错会得到
  // 「装了但连不上」的 MCP（实测报 failed to connect to running Pencil app）。
  const appId = appIdFor(mcpPath);
  log(`找到 Pen MCP：${mcpPath}（-app ${appId}${appId === 'desktop' ? '，桌面版' : '，编辑器变体'}）`);
  if (options.mode === 'check') {
    log('（--check：未做改动）');
    return;
  }
  const ok = ensureProfileRow(patchPath, mcpPath, appId, options.agent, options.dryRun);
  if (!ok) process.exit(1);
  log('下一步：重启 DSH 并确保 Pen 在运行（且打开着一个 .pen 文件），');
  log('        然后在会话里让 agent 用 Pen 起设计稿——设计由 DSH 自己的模型配置驱动。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { findPenMcp, ensureProfileRow, INSTALL_GUIDE };
