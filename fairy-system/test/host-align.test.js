/**
 * host-align 的测试：只验 `check` 的判定与退出码（`fix` 会改动官方安装，不在测试里跑）。
 *
 * 为什么值得测：这条判定的**误报代价很高**（会把独立版本线的 cordis/cosmokit 也当成
 * 混版、或用真实安装做实验），漏报代价同样高（宿主混版时 DSH 直接起不来，而报错
 * 指向别处）。夹具用临时目录伪造两套安装。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'host-align.js');

/** 造一个假的 @deepseek-ai 安装：{name: version}。 */
function fakeRuntime(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'host-align-'));
  const scope = path.join(root, 'node_modules', '@deepseek-ai');
  for (const [name, version] of Object.entries(spec)) {
    const dir = path.join(scope, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }));
  }
  return { root: path.join(root, 'node_modules'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

test('check passes on an aligned install (exit 0)', () => {
  const rt = fakeRuntime({ dsh: '0.1.5-rc.2', 'dsh-settings': '0.1.5-rc.2', 'dsh-fs': '0.1.5-rc.2', cordis: '4.0.2' });
  try {
    const r = run(['check', '--runtime', rt.root]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /版本一致/);
  } finally { rt.cleanup(); }
});

test('check flags a mixed install and names the stale packages (exit 1)', () => {
  const rt = fakeRuntime({
    dsh: '0.1.5-rc.2',
    'dsh-session-query': '0.1.2-rc.1',          // 实证会让宿主的 sqlite 包 import 失败
    'dsh-settings': '0.1.5-rc.2',
    cordis: '4.0.2',                            // 独立版本线：不该被算作混版
    cosmokit: '1.8.3',
  });
  try {
    const r = run(['check', '--runtime', rt.root]);
    assert.equal(r.code, 1, '混版必须非 0 退出');
    assert.match(r.stdout, /dsh-session-query@0\.1\.2-rc\.1/, '要指出具体过期的包');
    assert.doesNotMatch(r.stdout, /- @deepseek-ai\/cordis@/, '独立版本线不应被列为不一致');
    assert.match(r.stdout, /独立版本线/, '要说明为什么它们不参与对齐');
  } finally { rt.cleanup(); }
});

test('dry-run never touches the install and still reports the plan', () => {
  const rt = fakeRuntime({ dsh: '0.1.5-rc.2', 'dsh-settings': '0.1.2-rc.1' });
  try {
    const r = run(['fix', '--runtime', rt.root, '--dry-run']);
    assert.match(r.stdout, /would install @deepseek-ai\/dsh-settings@0\.1\.5-rc\.2/);
    // 版本必须没变
    const after = run(['check', '--runtime', rt.root]);
    assert.equal(after.code, 1, 'dry-run 不应改动安装');
    assert.match(after.stdout, /dsh-settings@0\.1\.2-rc\.1/);
  } finally { rt.cleanup(); }
});

test('a --runtime without the dsh package is rejected as usage error', () => {
  const rt = fakeRuntime({ 'dsh-settings': '0.1.5-rc.2' });   // 没有 dsh 本体 → 取不到目标版本
  try {
    const r = run(['check', '--runtime', rt.root]);
    assert.equal(r.code, 2, '用法/前置错误应与"混版"区分（退出码 2）');
    assert.match(r.stdout + r.stdout, /dsh|找不到/);
  } finally { rt.cleanup(); }
});
