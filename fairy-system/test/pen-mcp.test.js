import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appIdFor, ensureProfileRow, penAppRoots, penRowRefreshReason, registryPenRoots } from '../../scripts/pen-mcp.mjs';

/* mcp-pen 行缺字段会让整棵插件树加载失败、实例起不来（2026-09-17 实测），
 * 而 -app 配错会得到「装了但连不上」的 MCP —— 这两条都在这里钉住。 */

const PATCH_STUB = [
  '# stub profile patch',
  '- id: something',
  '  config:',
  '    a: 1',
  '',
  '- insert:',
  '    - id: context7',
  "      name: '@upstash/context7-mcp'",
  '',
].join('\n');

test('writes a loadable mcp-pen row and uses the derived -app id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pen-mcp-'));
  try {
    const patch = join(dir, 'cordis.patch.yml');
    await writeFile(patch, PATCH_STUB);
    const mcpPath = 'C:\\fake\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe';

    assert.equal(ensureProfileRow(patch, mcpPath, 'visual_studio_code', 'dsh', false), true);
    const text = await readFile(patch, 'utf8');
    assert.match(text, /^\s*- id: mcp-pen\s*$/m, '缺 mcp-pen 行');
    assert.match(text, /serverName: pen/, '缺 serverName（dsh-mcp-client 必填）');
    assert.match(text, /transport: stdio/, '缺 transport（dsh-mcp-client 必填）');
    assert.match(text, /failOnStartupError: false/, '缺 failOnStartupError（Pen 没开时只降级不炸启动）');
    assert.match(text, /- '-app'\n\s+- 'visual_studio_code'/, '-app 必须用推导出的变体 id，不能写死 desktop');
    assert.match(text, /- '-agent'\n\s+- 'dsh'/);
    // YAML 单引号标量不处理转义 ⇒ 路径原样写；多转义一层会让工作坊面板显示 `D:\\Users\\…`。
    assert.ok(text.includes(`command: '${mcpPath}'`), `command 路径必须原样写入，实际：${/command: '[^']*'/.exec(text)?.[0]}`);

    // 幂等：路径仍有效时不再改写文件。
    assert.equal(ensureProfileRow(patch, mcpPath, 'visual_studio_code', 'dsh', false), true);
    assert.equal(await readFile(patch, 'utf8'), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appIdFor pairs ~/.pencil editor variants with their own -app id', () => {
  assert.equal(appIdFor(''), 'desktop');
  assert.equal(appIdFor('C:\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe'), 'desktop');
  assert.equal(appIdFor('/home/u/.pencil/mcp/visual_studio_code/mcp-server-linux-x64'), 'visual_studio_code');
});

/* 换盘 / 重装之后，patch 里留下的是旧路径：插件面板会说「已接入但记录的路径已失效」，
 * 而重跑本脚本原本只回一句「无需改动」—— 于是主人没有任何办法把它修好（2026-09-18 实机）。
 * 现在写路径的那一步会核对存在性，只换 command 一行。 */

test('ensureProfileRow 会把失效的 pen 路径就地改写到当前安装', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pen-mcp-'));
  try {
    const patch = join(dir, 'cordis.patch.yml');
    const stale = 'D:\\Users\\me\\AppData\\Local\\Programs\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe';
    const fresh = 'F:\\Users\\me\\AppData\\Local\\Programs\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe';
    const stubWithPath = (p) => PATCH_STUB.replace("      name: '@upstash/context7-mcp'", `      name: '@upstash/context7-mcp'\n\n- id: mcp-pen\n  config:\n    command: '${p}'`);
    await writeFile(patch, stubWithPath(stale));

    // 新路径同样不存在（测试环境没装 Pen），但探测结果与记录不同 ⇒ 判定为安装位置变了。
    const before = await readFile(patch, 'utf8');
    assert.equal(penRowRefreshReason(before, fresh), `记录的路径已不存在（${stale}），当前探测到的是 ${fresh}`);

    assert.equal(ensureProfileRow(patch, fresh, 'desktop', 'dsh', false), true);
    const after = await readFile(patch, 'utf8');
    assert.ok(after.includes(`command: '${fresh}'`), 'command 没被改写到新路径');
    // 只动那一行：逐行比对，差异必须恰好一行。
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const changed = beforeLines.map((line, index) => (line === afterLines[index] ? null : index)).filter((index) => index !== null);
    assert.equal(changed.length, 1, `应当只改一行，实际改了 ${changed.length} 行`);
    assert.match(afterLines[changed[0]], /command: /);

    // 改完即幂等：同一个路径再来一次不动文件。
    assert.equal(penRowRefreshReason(after, fresh), null);
    assert.equal(ensureProfileRow(patch, fresh, 'desktop', 'dsh', false), true);
    assert.equal(await readFile(patch, 'utf8'), after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('penRowRefreshReason 认得早期写入端留下的双反斜杠路径', () => {
  const fresh = 'F:\\Pen\\out\\mcp-server-windows-x64.exe';
  const legacyLine = `        command: '${fresh.replace(/\\/g, '\\\\')}'`;
  // 双反斜杠解回来就是同一条路径 ⇒ 与探测结果一致 ⇒ 无需刷新（否则每次重跑都会改写文件）。
  assert.equal(penRowRefreshReason(`${legacyLine}\n`, fresh), null);
  assert.match(penRowRefreshReason('- id: mcp-pen\n', fresh), /没有 command/);
});

/* 缺陷现场（2026-09-18 实机）：Pen 1.2.10 装在 F:\Users\...\AppData\Local\Programs\Pen，
 * 而候选目录只列了 C:/D:/E: 三个盘符 —— 装好的 Pen 被判成「未安装」，工作坊面板照实报假。
 * 下面钉住两件事：盘符枚举覆盖整段字母表且顺序固定；非 Windows 平台不掺进 Windows 猜测。 */

test('penAppRoots enumerates every drive letter on Windows', () => {
  const roots = penAppRoots('win32', { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  // 用户 profile 的相对尾段 + 每个盘符各一份；不依赖注册表返回什么（那与本机是否装了 Pen 有关）。
  // C: 那条会出现两次（LOCALAPPDATA 猜测 + 盘符枚举各一份），取**最后**一次即枚举头。
  const cIndex = roots.lastIndexOf('C:\\Users\\me\\AppData\\Local\\Programs\\Pen');
  assert.ok(cIndex >= 0, 'profile 所在盘的候选缺失');
  assert.equal(roots[cIndex + 3], 'F:\\Users\\me\\AppData\\Local\\Programs\\Pen', '盘符必须逐个枚举到 F:（C: 之后是 D:、E:、F:）');
  // 只看假用户的那批候选：真实机器上注册表还会补上真实安装路径（那台装的是真 Pen）。
  const guessed = roots.filter((root) => root.endsWith('\\Users\\me\\AppData\\Local\\Programs\\Pen'));
  assert.equal(new Set(guessed).size, 26, '应为 26 个盘符各一份候选');
  assert.ok(roots.includes('Z:\\Users\\me\\AppData\\Local\\Programs\\Pen'), '盘符枚举只走了一半');
  // 显式覆盖口优先于任何猜测，LOCALAPPDATA 猜测排在它后面。
  const override = penAppRoots('win32', { DSH_PEN_DIR: 'E:\\My Pen', USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.equal(override[0], 'E:\\My Pen');
  assert.equal(override.indexOf('C:\\Users\\me\\AppData\\Local\\Programs\\Pen'), 1);
});

test('penAppRoots keeps Windows guesses out of the unix candidate list', () => {
  const roots = penAppRoots('linux', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.deepEqual(roots, ['/opt/Pen/resources', '/usr/lib/Pen/resources', join(homedir(), '.local', 'share', 'Pen', 'resources')]);
});

test('registryPenRoots returns a root list the probe loop can consume', () => {
  // 非 Windows 上 reg 不存在 ⇒ 空数组（上层继续走枚举兜底）；Windows 上则是机器本地答案。
  const roots = registryPenRoots();
  assert.ok(Array.isArray(roots));
  for (const root of roots) assert.equal(typeof root, 'string');
  assert.equal(new Set(roots).size, roots.length, '同一个根目录不应重复出现');
});
