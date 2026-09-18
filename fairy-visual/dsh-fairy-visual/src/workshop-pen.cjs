/**
 * 创作工坊的纯函数：pen 定位候选与 profile patch 里的路径解码。
 *
 * 为什么单独一个文件：宿主 index.js 顶层 import 了 `@deepseek-ai/dsh-settings`（只有部署树里
 * 装得到），于是任何直接 import 它的测试在仓库树里必然 ERR_MODULE_NOT_FOUND。把判据挪到这里，
 * 两份文件系统都能跑同一套断言；宿主与 scripts/pen-mcp.mjs 共享同一串盘符顺序（contract 测试
 * 钉住两边一致）。
 *
 * @module dsh-fairy-visual/workshop-pen
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

/** 全盘枚举顺序：C: 打头，其余字母顺次 —— 与 scripts/pen-mcp.mjs 的 DRIVE_LETTERS 同一串。 */
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
const PEN_MCP_NAMES = [
  'mcp-server-windows-x64.exe', 'mcp-server-darwin-arm64', 'mcp-server-darwin-x64',
  'mcp-server-linux-x64', 'mcp-server-linux-arm64',
];

/**
 * 从 profile patch 的 mcp-pen 行里取出写下的 MCP 路径，存不存在由调用方判断。
 * patch 里是 YAML 单引号标量：反斜杠是字面量、本该原样写，但早期写入端多转义了一层，
 * 于是本机留下的是双反斜杠 —— 两种都收：按分隔符切段、丢掉空段再拼回来。
 */
function recordedPenPath(patchText) {
  const raw = /\bcommand:\s*'([^']*mcp-server-[^']*)'/.exec(patchText ?? '')?.[1];
  return raw ? raw.split(/\\+/).filter(Boolean).join('\\') : null;
}

/**
 * Windows 上 Pen 的 MCP **只可能**在盘符 + 用户 profile 相对路径两段里，而盘符由用户
 * 安装时选（实测这台装在 F:，早先写死 C:/D:/E: 会把装好的 Pen 报成「未安装」）。
 * 所以先问注册表的卸载键要真实安装路径，拿不到再全盘枚举 —— 顺序即优先级。
 * 32/64 位注册表各自可能有一份，两份都读；读不到（非 Windows / 键缺失）就当没有。
 */
function registryPenRoots() {
  const roots = [];
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    let out = '';
    try {
      // 键不存在时 reg 会往 stderr 抱怨，只认 stdout 即可。
      out = execFileSync('reg', ['query', key, '/s', '/f', 'Pen', '/d'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    // InstallLocation 优先；本机实测它是空的，退而取卸载器路径里的安装目录。
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*(InstallLocation|UninstallString)\s+REG_[A-Z_]+\s+(.+?)\s*$/i.exec(line);
      if (!match) continue;
      if (match[1].toLowerCase() === 'installlocation') { roots.unshift(match[2]); continue; }
      const fromExe = /^"?([^"]+\.exe)/.exec(match[2].trim())?.[1];
      if (fromExe && dirname(fromExe) !== '.') roots.push(dirname(fromExe));
    }
  }
  return roots.filter((root, index) => root && roots.indexOf(root) === index);
}

/** Pen 各平台的候选安装根目录（应用自带 MCP 在 <root>/resources/app.asar.unpacked/out）。 */
function penAppRoots(platform = process.platform, env = process.env) {
  const dirs = [];
  if (platform === 'win32') {
    // DSH_PEN_DIR 是显式覆盖口，排在任何猜测之前；LOCALAPPDATA 猜测只在 Windows 上有意义。
    if (env.DSH_PEN_DIR) dirs.push(env.DSH_PEN_DIR);
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs', 'Pen'));
    dirs.push(...registryPenRoots());
    const profileTail = (env.USERPROFILE ?? '').replace(/^[A-Za-z]:/, '');
    if (profileTail) for (const letter of DRIVE_LETTERS) dirs.push(join(`${letter}:\\`, profileTail, 'AppData', 'Local', 'Programs', 'Pen'));
  } else if (platform === 'darwin') {
    dirs.push('/Applications/Pen.app/Contents/Resources', join(homedir(), 'Applications', 'Pen.app', 'Contents', 'Resources'));
  } else {
    dirs.push('/opt/Pen/resources', '/usr/lib/Pen/resources', join(homedir(), '.local', 'share', 'Pen', 'resources'));
  }
  return dirs;
}

/** 找 Pen 的 MCP 可执行文件：先看应用自带的那份，再看 ~/.pencil 下的编辑器变体。 */
function findPenMcp() {
  let hit = null;
  const probe = (dir) => {
    if (hit || !dir || !existsSync(dir)) return;
    for (const name of PEN_MCP_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) { hit = candidate; return; }
    }
  };
  for (const root of penAppRoots()) {
    probe(join(root, 'resources', 'app.asar.unpacked', 'out'));
    probe(join(root, 'app.asar.unpacked', 'out'));
  }
  const pencilRoot = join(homedir(), '.pencil', 'mcp');
  probe(pencilRoot);
  if (!hit && existsSync(pencilRoot)) {
    for (const entry of readdirSync(pencilRoot)) probe(join(pencilRoot, entry));
  }
  return hit;
}

module.exports = { DRIVE_LETTERS, PEN_MCP_NAMES, recordedPenPath, registryPenRoots, penAppRoots, findPenMcp };
