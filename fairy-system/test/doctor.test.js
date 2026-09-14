/**
 * doctor 的测试：每个检查都接受注入的入参（runtimeDir / repo / home），所以全用临时夹具，
 * **零外网、不碰真实宿主**。
 *
 * 为什么值得测：doctor 是"自主排障"的入口，它误报的代价是**把人引向错误的修复**
 * （例如把独立版本线的 cordis 报成混版、把 lock 漂移报成混版），漏报的代价是宿主起不来
 * 而报告说全绿。两条都被本会话真实踩过。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { checkVersions, checkNpmProjectRoot, checkTestPrereqs, checkRepo, checkBinary, exitFor, EXIT } =
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

test('测试门前提：没有可用对象 / 没有装齐的 profile 时报 warn（环境前提，不是代码回归）', () => {
  // 夹具 home 与 repo 都是临时目录：没有装齐的 profile，也没有可校验的制品。
  // 注意"制品发现"会扫约定目录——本机确有 C:/tmp/dsh-011 时它会找到、于是只报 profile 侧缺，
  // 那正是期望行为（能让体检自己找到就不该逼人从零装一份）。
  const root = mkdtempSync(path.join(tmpdir(), 'doctor-home-'));
  try {
    const r = checkTestPrereqs(root, path.join(root, 'empty-home'));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /profile|制品/, '要说清差在哪一侧');
    assert.match(r.detail, /不是代码回归/);
    assert.match(r.fix, /DSH_OFFICIAL_PACKAGE|旋钮/);
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

test('退出码映射：unknown→2、warn→2、fail 优先→1、全绿→0（合成数组直断）', () => {
  // 直接喂合成数组：批跑夹具里常同时有 fail，`status != 0` 会被 fail 满足，
  // 那时 unknown→非零 这条映射写坏也照样过——所以必须单独钉。
  const c = (status) => ({ status, name: status, detail: '', fix: '' });
  assert.equal(exitFor([c('ok')]), EXIT.OK);
  assert.equal(exitFor([c('skipped'), c('ok')]), EXIT.OK);
  assert.equal(exitFor([c('warn')]), EXIT.WARN);
  assert.equal(exitFor([c('unknown')]), EXIT.WARN, '未知必须非零——"查不清"不等于通过');
  assert.equal(exitFor([c('fail')]), EXIT.FAIL);
  assert.equal(exitFor([c('unknown'), c('warn')]), EXIT.WARN);
  assert.equal(exitFor([c('fail'), c('unknown'), c('warn')]), EXIT.FAIL, 'fail 优先');
  assert.equal(exitFor([]), EXIT.OK);
});

test('未知项在输出里显式成行（spawn 守渲染；退出码由上面的映射直断守着）', async () => {
  const { spawnSync } = await import('node:child_process');
  const empty = mkdtempSync(path.join(tmpdir(), 'doctor-unknown-'));
  try {
    const script = path.join(import.meta.dirname, '..', 'doctor.mjs');
    const r = spawnSync(process.execPath, [script, '--runtime', path.join(empty, 'node_modules'), '--repo', empty, '--home', empty], { encoding: 'utf8', timeout: 300_000 });
    assert.match(r.stdout, /未知/, '摘要里必须显式列出未知项数');
    assert.match(r.stdout, /无法判定（不等于正常）/, '必须点明"未知≠正常"');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('制品发现：约定目录里真放一份就能被找到（不是只验搜索根的长度）', async () => {
  const { artifactRoots, discoverArtifacts } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'doctor.mjs')).href);
  const roots = artifactRoots();
  // 不写死数量：Linux 上 os.tmpdir() 本身就是 /tmp，去重后只剩一项（写 >=2 会在那边挂）。
  assert.ok(roots.length >= 1, `搜索根不该为空：${JSON.stringify(roots)}`);
  assert.ok(roots.some((r) => /tmp$/i.test(r)), `应含约定根：${JSON.stringify(roots)}`);

  // 夹具落在 `os.tmpdir()` 下、**恰好一层** `dsh-*`（与真实制品目录同形：
  // `<搜索根>/dsh-<后缀>/node_modules/@deepseek-ai/dsh/package.json`）。
  // 多套一层就不在发现规则的射程内——第一版正是这么写错的。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-'));
  try {
    const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(pkgDir, { recursive: true });
    const pkg = path.join(pkgDir, 'package.json');
    writeFileSync(pkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));
    // 路径形态可能因 8.3 短名（`ADMINI~1`）与长名混用而字符串不等，用 realpath 归一后比。
    const found = discoverArtifacts();
    assert.ok(Array.isArray(found), 'discoverArtifacts 必须返回数组（找不到也不抛）');
    const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
    assert.ok(found.some((f) => same(f, pkg)), `夹具应被找到。\n  夹 具: ${pkg}\n  发现: ${JSON.stringify(found, null, 1)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
