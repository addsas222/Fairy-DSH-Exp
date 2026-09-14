/**
 * doctor 的测试：每个检查都接受注入的入参（runtimeDir / repo / home），所以全用临时夹具，
 * **零外网、不碰真实宿主**。
 *
 * 为什么值得测：doctor 是"自主排障"的入口，它误报的代价是**把人引向错误的修复**
 * （例如把独立版本线的 cordis 报成混版、把 lock 漂移报成混版），漏报的代价是宿主起不来
 * 而报告说全绿。两条都被本会话真实踩过。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { checkVersions, checkNpmProjectRoot, checkTestPrereqs, checkRepo, checkBinary, EXIT } =
  await import(pathToFileURL(path.join(import.meta.dirname, '..', 'doctor.mjs')).href);

/** 造一棵 @deepseek-ai 安装树：{name: version} 或 [name, version]。 */
function tree(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'doctor-'));
  const scope = path.join(root, 'node_modules', '@deepseek-ai');
  mkdirSync(scope, { recursive: true });
  for (const [name, version] of Object.entries(spec)) {
    mkdirSync(path.join(scope, name), { recursive: true });
    writeFileSync(path.join(scope, name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }));
  }
  return { root: path.join(root, 'node_modules'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('混版检测：同线内版本不同 → fail，并给出对齐命令', () => {
  const t = tree({ dsh: '0.1.5-rc.2', 'dsh-settings': '0.1.5-rc.2', 'dsh-fs': '0.1.2-rc.1' });
  try {
    const r = checkVersions(t.root);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /dsh-fs@0\.1\.2-rc\.1/);
    assert.doesNotMatch(r.detail, /dsh-settings/, '同版本的包不该被列进来');
    assert.match(r.fix, /host-align\.js fix/);
  } finally { t.cleanup(); }
});

test('混版检测：独立版本线不误报（cordis/cosmokit/node-addon 本来就跟着别的线）', () => {
  const t = tree({ dsh: '0.1.5-rc.2', 'dsh-fs': '0.1.5-rc.2', cordis: '4.0.2', cosmokit: '1.8.3', 'node-addon-system': '0.1.2' });
  try {
    const r = checkVersions(t.root);
    assert.equal(r.status, 'ok', `不该把独立版本线报成混版，实际：${r.detail}`);
  } finally { t.cleanup(); }
});

test('混版检测：没有 dsh 本体 → fail（而不是 ok）', () => {
  const t = tree({ 'dsh-fs': '0.1.5-rc.2' });
  try {
    assert.equal(checkVersions(t.root).status, 'fail');
  } finally { t.cleanup(); }
});

test('宿主可运行性：夹具缺 lib/bin.js → fail 且给出重装提示', () => {
  const t = tree({ dsh: '0.1.5-rc.2' });
  try {
    const r = checkBinary(t.root);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /找不到/);
  } finally { t.cleanup(); }
});

test('npm 工程根：lock 与盘上不一致要报 warn 并列出差异（这正是"一次 install 拧回旧版"的前置）', () => {
  const t = tree({ dsh: '0.1.5-rc.2', 'dsh-fs': '0.1.5-rc.2' });
  try {
    const root = path.dirname(t.root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/@deepseek-ai/dsh': { version: '0.1.5-rc.2' },
        'node_modules/@deepseek-ai/dsh-fs': { version: '0.1.2-rc.1' },   // 盘上是 0.1.5-rc.2
      },
    }));
    const r = checkNpmProjectRoot(t.root);
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /dsh-fs: lock 0\.1\.2-rc\.1 vs 盘上 0\.1\.5-rc\.2/);
  } finally { t.cleanup(); }
});

test('npm 工程根：一致时 ok；没有 lock 时 skipped', () => {
  const t = tree({ dsh: '0.1.5-rc.2' });
  try {
    const root = path.dirname(t.root);
    assert.equal(checkNpmProjectRoot(t.root).status, 'skipped', '没有 lock 应 skipped');
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3, packages: { 'node_modules/@deepseek-ai/dsh': { version: '0.1.5-rc.2' } },
    }));
    assert.equal(checkNpmProjectRoot(t.root).status, 'ok');
  } finally { t.cleanup(); }
});

test('测试门前提：缺比较对象或缺插件包都要报 warn（环境前提，不是代码回归）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doctor-home-'));
  try {
    const r = checkTestPrereqs(root, path.join(root, 'empty-home'));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /DSH_OFFICIAL_PACKAGE/);
    assert.match(r.detail, /不是代码回归/);
    assert.match(r.fix, /DSH_OFFICIAL_PACKAGE=/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('仓库与部署：本仓此刻应能给出判定（不是"无输出"）', () => {
  const repo = path.resolve(path.join(import.meta.dirname, '..', '..'));
  // offline=true：这条守的是"子进程非零退出码时仍要拿到 stdout"这条回归路径，
  // 不该为了它去碰真网络（代理一抽风就变慢/飘，也违反本套测试"零外网"的招牌）。
  const r = checkRepo(repo, path.join(tmpdir(), 'doctor-no-such-home'), true);
  assert.ok(['ok', 'warn'].includes(r.status), `应力求给出判定，实际 ${r.status}：${r.detail}`);
  // 措辞随分支而定：远端不可达时只报镜像侧结论，正常时两句话都报。
  // 这条守的是"必须给出判定，而不是'无输出'"——正是本会话踩过的退出码/输出缺陷。
  assert.match(r.detail, /仓库|远端|镜像/, 'detail 不能是空话');
  assert.doesNotMatch(r.detail, /^无输出$/, '拿不到结论时要报 `unknown`，不能只写"无输出"');
});

test('仓库与部署：工具缺失时 skipped，不抛异常', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'doctor-norepo-'));
  try {
    assert.equal(checkRepo(empty, empty, false).status, 'skipped');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('退出码语义稳定（0 全绿 / 1 fail / 2 warn / 3 用法）', () => {
  assert.deepEqual(EXIT, { OK: 0, FAIL: 1, WARN: 2, USAGE: 3 });
});

test('「未知」必须影响退出码，且显式成行（不能静默通过）', async () => {
  // 造一个 runtime 目录都不存在的场景：混版检测会返回 unknown（树读不到）。
  const { spawnSync } = await import('node:child_process');
  const empty = mkdtempSync(path.join(tmpdir(), 'doctor-unknown-'));
  try {
    const script = path.join(import.meta.dirname, '..', 'doctor.mjs');
    const r = spawnSync(process.execPath, [script, '--runtime', path.join(empty, 'node_modules'), '--repo', empty, '--home', empty], { encoding: 'utf8', timeout: 300_000 });
    assert.notEqual(r.status, 0, '有未知项时不得返回 0');
    assert.match(r.stdout, /未知/, '摘要里必须显式列出未知项数');
    // 输出里那句是 markdown 强调形式（`**无法判定**`），断言照字面来，别凭印象写。
    assert.match(r.stdout, /\*\*无法判定\*\*/, '必须点明"未知≠正常"');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
