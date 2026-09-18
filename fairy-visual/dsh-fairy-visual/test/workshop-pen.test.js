import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DRIVE_LETTERS, recordedPenPath, penAppRoots, registryPenRoots } = require('../src/workshop-pen.cjs');

/* 缺陷现场（2026-09-18 实机）：Pen 1.2.10 装在 F:\Users\...\AppData\Local\Programs\Pen，
 * 而候选目录只列了 C:/D:/E: 三个盘符 —— 工作坊面板对已装好的 Pen 报「未安装」。
 * 这里钉住两件事：盘符枚举覆盖整段字母表；非 Windows 平台不掺进 Windows 猜测。 */

test('盘符枚举覆盖 A–Z，且 profile 所在盘之后紧跟下一个字母', () => {
  const roots = penAppRoots('win32', { USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.equal(DRIVE_LETTERS.length, 26);
  // 只看假用户那批：真实机器上注册表会补上真实安装路径（这台装的是真 Pen）。
  const guessed = roots.filter((root) => root.endsWith('\\Users\\me\\AppData\\Local\\Programs\\Pen'));
  assert.equal(new Set(guessed).size, 26, '应为 26 个盘符各一份候选');
  // C: 那条出现两次（LOCALAPPDATA 猜测 + 盘符枚举），取最后一次即枚举头。
  const head = roots.lastIndexOf('C:\\Users\\me\\AppData\\Local\\Programs\\Pen');
  assert.equal(roots[head + 3], 'F:\\Users\\me\\AppData\\Local\\Programs\\Pen', '盘符必须逐个枚举到 F:');
  assert.ok(roots.includes('Z:\\Users\\me\\AppData\\Local\\Programs\\Pen'), '枚举只走了一半');
});

test('显式覆盖口 DSH_PEN_DIR 排在任何猜测之前', () => {
  const roots = penAppRoots('win32', { DSH_PEN_DIR: 'E:\\My Pen', USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.equal(roots[0], 'E:\\My Pen');
  assert.equal(roots[1], 'C:\\Users\\me\\AppData\\Local\\Programs\\Pen');
});

test('非 Windows 平台不掺进 Windows 路径猜测', () => {
  const roots = penAppRoots('linux', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' });
  assert.deepEqual(roots, ['/opt/Pen/resources', '/usr/lib/Pen/resources', require('node:path').join(require('node:os').homedir(), '.local', 'share', 'Pen', 'resources')]);
});

test('注册表探测返回可被逐条探测的根目录列表', () => {
  // 非 Windows 上 reg 不存在 ⇒ 空数组（上层继续走枚举兜底）；Windows 上是机器本地答案。
  const roots = registryPenRoots();
  assert.ok(Array.isArray(roots));
  for (const root of roots) assert.equal(typeof root, 'string');
  assert.equal(new Set(roots).size, roots.length, '同一个根目录不应重复出现');
});

test('patch 里的 MCP 路径：新旧两种写法都解回同一条路径', () => {
  const expected = 'D:\\Users\\Administrator\\AppData\\Local\\Programs\\Pen\\resources\\app.asar.unpacked\\out\\mcp-server-windows-x64.exe';
  // 早期写入端多转义一层留下的双反斜杠。
  const legacy = `        command: '${expected.replace(/\\/g, '\\\\')}'`;
  const current = `        command: '${expected}'`;
  assert.equal(recordedPenPath(legacy), expected);
  assert.equal(recordedPenPath(current), expected);
  assert.equal(recordedPenPath(''), null);
  assert.equal(recordedPenPath(undefined), null);
  assert.equal(recordedPenPath("        command: '/opt/Pen/out/mcp-server-linux-x64'"), '/opt/Pen/out/mcp-server-linux-x64');
});
