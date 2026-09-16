import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 直接 import 被测模块：main() 只在「作为入口执行」时跑（见文件末尾的守卫），
// 所以这里既能拿到纯函数，也不会顺带发起一次部署。
const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts');
const { baseFor, launcherBody, BASE_RUNTIME_VERSIONS, KNOWN_BASES } = await import(
  new URL(`file://${resolve(scriptsDir, 'install.mjs').replace(/\\/g, '/')}`).href
);

test('底座线按版本号第三段判定（0.1.1 → 011、0.1.5 → 015）', () => {
  // 曾误取第二段（`0.1` 里的 1），把 0.1.5 推成 011 —— 那条线决定 profile 里
  // 抓取通道是否启用，推错会静默改变行为，所以钉死在这里。
  assert.equal(baseFor('0.1.1-rc.2'), '011');
  assert.equal(baseFor('0.1.5-rc.1'), '015');
  assert.equal(baseFor('0.1.5-rc.2'), '015');
  assert.equal(baseFor('0.1.6-alpha.1'), '015');
  assert.equal(baseFor('0.2.0'), '015');
  assert.equal(baseFor('未知名'), '011', '认不出来时按长期运行的那条线');
});

test('各底座线的默认安装版本与线一致', () => {
  assert.deepEqual(KNOWN_BASES, ['011', '015']);
  assert.match(BASE_RUNTIME_VERSIONS['011'], /^0\.1\.1/);
  assert.match(BASE_RUNTIME_VERSIONS['015'], /^0\.1\.5/);
});

test('启动器正文：Windows 用 CRLF、Unix 用 LF，且都写入运行时与底座线', () => {
  const win = launcherBody('win32', { bin: 'C:\\dsh\\lib\\bin.js' }, '011');
  assert.equal((win.match(/\r\n/g) ?? []).length > 0, true, 'Windows 启动器必须 CRLF');
  assert.equal((win.match(/(?<!\r)\n/g) ?? []).length, 0, '不得混入裸 LF（cmd.exe 会错解析）');
  assert.match(win, /set "RUNTIME=C:\\dsh\\lib\\bin\.js"/);
  assert.match(win, /set "DSH_FAIRY_BASE=011"/);
  assert.match(win, /node "%RUNTIME%" --profile web --no-open --port %PORT%/);
  assert.doesNotMatch(win, /[^\x00-\x7F]/, 'Windows 批处理只留 ASCII：不同代码页下中文会显示乱码');

  const unix = launcherBody('linux', { bin: '/opt/dsh/lib/bin.js' }, '015');
  assert.equal((unix.match(/\r\n/g) ?? []).length, 0, 'Unix 启动器不得有 CRLF');
  assert.match(unix, /^#!\/bin\/sh\n/);
  assert.match(unix, /RUNTIME="\/opt\/dsh\/lib\/bin\.js"/);
  assert.match(unix, /DSH_FAIRY_BASE="015"/);
  assert.match(unix, /PORT="\$\{1:-3081\}"/, '端口可用 $1 覆盖，默认 3081');
  assert.match(unix, /exec node "\$RUNTIME" --profile web --no-open --port "\$PORT"/);
  assert.match(unix, /export DSH_FAIRY_PROFILE_ROOT="\$ISO_HOME\/profiles\/web"/);
});

test('install.mjs 只有在被当作入口执行时才跑部署（否则 import 会误触发）', () => {
  const source = readFileSync(resolve(scriptsDir, 'install.mjs'), 'utf8');
  assert.match(source, /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\) main\(\);/);
  assert.match(source, /export \{ baseFor, launcherBody, BASE_RUNTIME_VERSIONS, KNOWN_BASES \};/);
});
