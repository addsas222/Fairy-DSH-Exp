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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // 拿真仓库当"仓库侧"，把 home 指到一个受控的隔离目录：那里的模块清单必然对不上。
    // （假 git 仓里没有 fairy-system/，镜像判定会被跳过——所以要换一边受控。）
    const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const home = path.join(f.root, 'past-home');
    mkdirSync(home, { recursive: true });
    const args = ['check', '--repo', repo, '--home', home];
    const text = runAllowFailure(args);
    const json = runAllowFailure([...args, '--json']);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.state, 'current', '这个仓库自己与远端一致（否则另说）');
    assert.equal(payload.mirror.state, 'behind', '空 home 必然对不上清单');
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

test('方向未知时退出 3——先 fetch 才能判，不是"已最新"', () => {
  const f = fixture();
  try {
    f.rewindToUnknownRemote();   // 远端指向本地没有的提交
    const r = runAllowFailure(['check', '--repo', f.repo]);
    assert.equal(r.code, 3, '"判不出方向"与"已最新"必须分得清');
    assert.match(r.stdout, /先 fetch/);
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
