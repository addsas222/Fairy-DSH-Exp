/**
 * repo-update 的测试：本地 bare 仓做远端（零外网，AGENTS §5.6）。
 *
 * 为什么值得测：
 *   - "远端不可达" 与 "已最新" **必须不同退出码**——这台机器 GitHub 通路时通时断，
 *     同码会让检查静默说谎（这正是本工具存在的理由）；
 *   - `apply` 在脏工作树上必须**拒绝**而不是留下半成品；
 *   - 镜像判定要复用 image-manifest 的语义，不能凭"目录存在"就报一致。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'repo-update.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * 在仓库里追加一个提交，返回新 SHA。
 *
 * 走 `commit-tree`（+ 临时 index）而不是 add+commit：夹具需要在**非 git 目录**
 * 上也能被安全调用（"非 git 目录是用法错误"那条）、且不需要工作树干净。
 * 身份用 -c 显式传入，避免依赖使用者的全局 gitconfig。
 */
function commit(repo, message) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(repo, '.git', 'fixture-index') };
  // 必须先 stage：空的临时 index 上 `write-tree` 返回的是空树 SHA（实测 4b825dc…），
  // 于是提交里什么都没有，clone 出来的仓库缺文件。
  execFileSync('git', ['add', '-A'], { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8', env }).trim();
  // 首次调用时仓库还没有 HEAD，`rev-parse --verify HEAD` 会以 128 退出——用 spawnSync 容忍它。
  const probe = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const head = probe.status === 0 ? probe.stdout.trim() : '';
  const args = ['-c', 'user.email=repo-update-test@example.invalid', '-c', 'user.name=repo-update test', 'commit-tree', tree, '-m', message];
  if (head) args.push('-p', head);
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/**
 * 造一对夹具：bare 远端 + 从它 clone 出来的本地仓库。
 * 本地停在 `main`；远端可以再往前推一个提交来制造"有更新"。
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-update-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', seed], { stdio: 'ignore' });
  git(seed, 'config', 'core.autocrlf', 'false');
  git(seed, 'config', 'user.email', 'repo-update-test@example.invalid');
  git(seed, 'config', 'user.name', 'repo-update test');
  // 夹具要带一个 deploy-live.sh：apply 靠它落位，缺了会被拦阻项挡住（那条另有用例）。
  mkdirSync(path.join(seed, 'scripts'), { recursive: true });
  writeFileSync(path.join(seed, 'scripts', 'deploy-live.sh'), '#!/bin/sh\necho "fixture deploy"\n');
  git(seed, 'update-ref', 'refs/heads/main', commit(seed, 'first'));
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
  // 工作副本从 bare 远端克隆（origin 指向远端），模拟"同事往远端推"的真实形态
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 'repo-update-test@example.invalid');
  git(repo, 'config', 'user.name', 'repo-update test');
  return {
    root, remote, repo, seed, work,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    /** 往远端推一个新提交（本地因此落后）。先移动 seed 的分支，再让 bare 仓取它
     *  （bare 仓不能 push 到 checked-out 分支，也不会经 update-ref 认外部对象）。 */
    advanceRemote() {
      const sha = commit(seed, 'second');
      git(seed, 'update-ref', 'refs/heads/main', sha);
      git(remote, 'fetch', '-q', seed, 'main:refs/heads/main');
      return sha;
    },
    /** 同事/别处往远端推一个提交——本地**对象库**会（像真实 fetch 那样）看到它，
     *  但本地分支不动：这是"远端领先"的真实形态，本工具要能判出方向。 */
    colleaguePushes() {
      const sha = commit(work, 'colleague');
      git(work, 'update-ref', 'refs/heads/main', sha);
      git(work, 'push', '-q', 'origin', 'main');
      git(repo, 'fetch', '-q', 'origin');
      return sha;
    },
    /** 让**本地**多一个提交（远端不动）——本地领先，也是本仓"提交后未推送"的常态。 */
    advanceLocal() {
      const sha = commit(repo, 'local-only');
      git(repo, 'update-ref', 'refs/heads/main', sha);
      return sha;
    },
    /** 两边各有对方没有的提交（分叉）。 */
    diverged() {
      const local = this.advanceLocal();
      const remoteSha = this.colleaguePushes();
      return { local, remote: remoteSha };
    },
    /** 把远端分支指向一个本地没有的全新提交（模拟"远端有本地从未 fetch 过的提交"）。
     *  bare 仓没有工作树，不能用 commit 助手（它会 git add）；直接写一个空树提交。 */
    rewindToUnknownRemote() {
      const tree = execFileSync('git', ['mktree'], { cwd: remote, encoding: 'utf8', input: '' }).trim();
      const sha = execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit-tree', tree, '-m', 'outside'], { cwd: remote, encoding: 'utf8' }).trim();
      git(remote, 'update-ref', 'refs/heads/main', sha);
      return sha;
    },
    /** 只保留 git 目录之外的一个假家目录（用于镜像判定）。 */
    fakeHome() { const home = path.join(root, 'home'); mkdirSync(home, { recursive: true }); return home; },
  };
}

/** 跑工具，返回 { code, stdout }。env 可覆盖环境（用于验证 $DSH_HOME 缺失时的文案）。 */
function run(args, env) {
  const result = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
  return { code: 0, stdout: result };
}

function runAllowFailure(args, env) {
  try { return run(args, env); } catch (error) { return { code: error.status ?? -1, stdout: `${error.stdout ?? ''}` }; }
}

test('本地与远端一致时 check 退出 0，且 JSON 报 current', () => {
  const f = fixture();
  try {
    const r = run(['check', '--repo', f.repo, '--json']);
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.state, 'current');
    assert.equal(payload.remoteHead, payload.local);
  } finally { f.cleanup(); }
});

test('远端有新提交时 check 退出 1（而不是 0/2），apply --dry-run 不改动工作树', () => {
  const f = fixture();
  try {
    const ahead = f.colleaguePushes();
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const r = runAllowFailure(['check', '--repo', f.repo, '--json']);
    assert.equal(r.code, 1, '远端有更新必须是独立退出码 1');
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.state, 'behind');
    assert.equal(payload.remoteHead, ahead);

    const dry = runAllowFailure(['apply', '--repo', f.repo, '--dry-run', '--home', f.fakeHome()]);
    assert.equal(dry.code, 1);
    assert.match(dry.stdout, /git -C .* pull --ff-only origin main/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, '--dry-run 不得移动 HEAD');
  } finally { f.cleanup(); }
});

test('本地领先（提交后未推送）时报"本地领先"而不是"远端有更新"', () => {
  const f = fixture();
  try {
    const localOnly = f.advanceLocal();
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const r = runAllowFailure(['check', '--repo', f.repo, '--json']);
    assert.equal(r.code, 1, '本地领先仍是"不一致"，但不是"已最新"');
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.state, 'ahead', '方向必须判出来——报 behind 是假话');
    assert.equal(payload.local, localOnly);
    assert.notEqual(payload.remoteHead, payload.local);

    // 人读的输出里不能说"远端有更新"
    const human = runAllowFailure(['check', '--repo', f.repo]);
    assert.match(human.stdout, /本地领先远端/);
    assert.doesNotMatch(human.stdout, /远端有更新/);
    // apply 不应把 ahead 当落后：--ff-only 下是 Already up to date，且不该动盘
    const dry = runAllowFailure(['apply', '--repo', f.repo, '--dry-run', '--home', f.fakeHome()]);
    assert.equal(dry.code, 1);
    assert.match(dry.stdout, /本地领先远端/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  } finally { f.cleanup(); }
});

test('远端不可达时退出 2，且不与"已最新"同码', () => {
  const f = fixture();
  try {
    const r = runAllowFailure(['check', '--repo', f.repo, '--remote', path.join(f.root, 'nowhere.git')]);
    assert.equal(r.code, 2, '网络/远端失败必须与 CURRENT(0) 区分');
    assert.match(r.stdout, /无法判断是否有更新/);
  } finally { f.cleanup(); }
});

test('远端没有该分支时也退出 2（远端异常 ≠ 已最新）', () => {
  const f = fixture();
  try {
    const r = runAllowFailure(['check', '--repo', f.repo, '--branch', 'does-not-exist']);
    assert.equal(r.code, 2);
  } finally { f.cleanup(); }
});

test('脏工作树时 apply 拒绝执行（退出 3），不 pull 不留半成品', () => {
  const f = fixture();
  try {
    f.colleaguePushes();
    const before = git(f.repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(f.repo, 'scripts', 'deploy-live.sh'), '#!/bin/sh\necho dirty\n');   // 已跟踪文件被改
    const r = runAllowFailure(['apply', '--repo', f.repo, '--yes', '--home', f.fakeHome()]);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /未提交改动/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, '拒绝时必须原地不动');
  } finally { f.cleanup(); }
});

test('未加 --yes 时 apply 只打印将执行的动作', () => {
  const f = fixture();
  try {
    f.colleaguePushes();
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const r = runAllowFailure(['apply', '--repo', f.repo, '--home', f.fakeHome()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /未加 --yes/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  } finally { f.cleanup(); }
});

test('缺 deploy-live.sh 时 apply 拦阻（退出 3），不 pull', () => {
  const f = fixture();
  try {
    f.colleaguePushes();
    rmSync(path.join(f.repo, 'scripts', 'deploy-live.sh'));
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const r = runAllowFailure(['apply', '--repo', f.repo, '--yes', '--home', f.fakeHome()]);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /找不到 .*deploy-live\.sh/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  } finally { f.cleanup(); }
});

test('JSON 与文本两条分支的退出码一致（镜像落后、分叉各自对齐）', () => {
  const f = fixture();
  try {
    // ① 分叉：按 USAGE 是前置条件错误（3），两条分支都要 3
    f.diverged();
    const textDiv = runAllowFailure(['check', '--repo', f.repo]);
    const jsonDiv = runAllowFailure(['check', '--repo', f.repo, '--json']);
    assert.equal(JSON.parse(jsonDiv.stdout).state, 'diverged');
    assert.equal(textDiv.code, 3, '分叉不是"有更新"（1）——人工合是前置条件问题');
    assert.equal(jsonDiv.code, 3, 'JSON 分支此前落到 1');
    assert.equal(textDiv.code, jsonDiv.code);
    assert.match(textDiv.stdout, /分叉/);
  } finally { f.cleanup(); }
});

test('镜像落后时 JSON 与文本同码（仓库最新 ≠ 全部最新）', () => {
  const f = fixture();
  try {
    // 不碰真仓库、不碰网络：夹具的远端就是本地 bare 仓（当前已一致），
    // 镜像侧造一个假 image-manifest 让它报"落后"。
    const dir = path.join(f.repo, 'fairy-system');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'image-manifest.js'), `
if (process.argv[2] === 'policy') { process.exit(0); }
// 真 image-manifest 把报告写在 **stdout**（只有"命令行用法错"才走 stderr）——照它来，
// 否则测不到 mirrorState 的 stdout 解析路径。
process.stdout.write('missing (清单里有、镜像里没有) x1:\\n  - x\\n');
process.stdout.write('metrics : files 3 checked, extra 0, missing 1, drifted 0, allowed 0\\n');
process.stdout.write('FAIL: the image does not match the commit\\n');
process.exit(1);
`);
    const args = ['check', '--repo', f.repo, '--home', f.fakeHome()];
    const text = runAllowFailure(args);
    const json = runAllowFailure([...args, '--json']);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.state, 'current', '夹具的远端此刻一致');
    assert.equal(payload.mirror.state, 'behind');
    assert.match(payload.mirror.detail, /missing 1/, 'detail 要带 metrics，不是空话');
    assert.equal(text.code, json.code, 'JSON 与文本必须同码');
    assert.equal(text.code, 1, '仓库最新但镜像落后 → 1，不是 0');
  } finally { f.cleanup(); }
});

test('本地领先时 JSON 与文本都报 1', () => {
  const f = fixture();
  try {
    f.advanceLocal();
    const text = runAllowFailure(['check', '--repo', f.repo]);
    const json = runAllowFailure(['check', '--repo', f.repo, '--json']);
    assert.equal(JSON.parse(json.stdout).state, 'ahead');
    assert.equal(text.code, 1);
    assert.equal(json.code, 1, '方向未知不得被当成"已最新"或"用法错"');
    assert.equal(text.code, json.code);
  } finally { f.cleanup(); }
});

test('方向未知时 check 退出 3——判不出方向就不猜，也不冒充"已最新"', () => {
  const f = fixture();
  try {
    f.rewindToUnknownRemote();   // 远端指向本地没有的提交
    const r = runAllowFailure(['check', '--repo', f.repo]);
    assert.equal(r.code, 3, '"判不出方向"与"已最新"必须分得清');
    assert.match(r.stdout, /判不出方向/);
    // check 只读：不 fetch、不写 FETCH_HEAD
    const fetchHead = spawnSync('git', ['rev-parse', '--verify', '-q', 'FETCH_HEAD'], { cwd: f.repo, encoding: 'utf8' });
    assert.notEqual(fetchHead.status, 0, 'check 不该产生 FETCH_HEAD');
  } finally { f.cleanup(); }
});

test('--home 是显式指定时，回显不该再叫用户"请显式 --home"', () => {
  const f = fixture();
  try {
    const home = f.fakeHome();
    const noEnv = { ...process.env };
    delete noEnv.DSH_HOME;   // 关键：清掉 $DSH_HOME，否则测的是 env 那条文案

    const withFlag = runAllowFailure(['check', '--repo', f.repo, '--home', home], noEnv);
    assert.match(withFlag.stdout, /镜像根 : .*（--home）/);
    assert.doesNotMatch(withFlag.stdout, /请显式 --home/);

    const viaEnv = runAllowFailure(['check', '--repo', f.repo], { ...noEnv, DSH_HOME: home });
    assert.match(viaEnv.stdout, /镜像根 : .*（\$DSH_HOME）/);

    // 两者都没有时才提示（这条提示本身要保留）
    const fallback = runAllowFailure(['check', '--repo', f.repo], noEnv);
    assert.match(fallback.stdout, /默认 ~\/\.dsh/);
  } finally { f.cleanup(); }
});

test('apply 不因"方向未知"卡死：pull 本身含 fetch，正是解开它的动作', () => {
  const f = fixture();
  try {
    f.rewindToUnknownRemote();   // 远端前移、本地没 fetch 过 —— 最常见的那条路
    const before = git(f.repo, 'rev-parse', 'HEAD');
    // check 保持只读、判 3（不猜方向）
    assert.equal(runAllowFailure(['check', '--repo', f.repo]).code, 3);
    // apply --dry-run 必须走到 pull 计划，而不是被自己的前置条件挡下
    const dry = runAllowFailure(['apply', '--repo', f.repo, '--dry-run', '--home', f.fakeHome()]);
    assert.match(dry.stdout, /pull --ff-only/, 'apply 必须给出 pull 计划');
    assert.doesNotMatch(dry.stdout, /不能执行 apply/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, '--dry-run 不动 HEAD');
  } finally { f.cleanup(); }
});

test('ahead 时 apply 只说不必 pull，不推进任何东西', () => {
  const f = fixture();
  try {
    f.advanceLocal();
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const r = runAllowFailure(['apply', '--repo', f.repo, '--yes', '--home', f.fakeHome()]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /本地领先远端/);
    assert.doesNotMatch(r.stdout, /pull --ff-only/, 'ahead 不该走 pull 路径');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  } finally { f.cleanup(); }
});

test('默认 preserve 走 policy --lines（换行分隔），两个条目都要被逐条传给对账', () => {
  const f = fixture();
  try {
    // 夹具里没有 fairy-system/，默认 preserve 会退化成 ''——这里造一个假的 image-manifest，
    // 让它按**真实来源的形态**吐两行，验证分隔口径与传递条数。
    const dir = path.join(f.repo, 'fairy-system');
    mkdirSync(dir, { recursive: true });
    const log = path.join(f.root, 'manifest-args.txt');
    writeFileSync(path.join(dir, 'image-manifest.js'), `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (args[0] === 'policy') { process.stdout.write('profiles/web/a.yml\\nprofiles/web/b.yml\\n'); process.exit(0); }
process.exit(0);   // check：报"一致"
`);
    const r = runAllowFailure(['check', '--repo', f.repo, '--home', f.fakeHome()]);
    assert.equal(r.code, 0, '镜像报一致 → 0');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const checkCall = calls.find((l) => l.startsWith('check')) ?? '';
    assert.match(checkCall, /--preserve profiles\/web\/a\.yml/, '第一个条目要作为独立参数');
    assert.match(checkCall, /--preserve profiles\/web\/b\.yml/, '第二个条目也要——换行分隔必须被切开');
    assert.doesNotMatch(checkCall, /a\.yml\nb\.yml|a\.yml b\.yml/, '不能把两条并成一个路径');
  } finally { f.cleanup(); }
});

test('非 git 目录是用法错误（退出 3）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-update-nogit-'));
  try {
    const r = runAllowFailure(['check', '--repo', dir]);
    assert.equal(r.code, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('用法：没有 verb 退出 3，--help 退出 0', () => {
  assert.equal(runAllowFailure([]).code, 3);
  assert.equal(run(['--help']).code, 0);
});
