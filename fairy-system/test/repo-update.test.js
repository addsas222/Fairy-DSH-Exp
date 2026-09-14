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
  git(repo, 'config', 'user.email', 'repo-update-test@example.invalid');
  git(repo, 'config', 'user.name', 'repo-update test');
  return {
    root, remote, repo, seed,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    /** 往远端推一个新提交（本地因此落后）。先移动 seed 的分支，再让 bare 仓取它
     *  （bare 仓不能 push 到 checked-out 分支，也不会经 update-ref 认外部对象）。 */
    advanceRemote() {
      const sha = commit(seed, 'second');
      git(seed, 'update-ref', 'refs/heads/main', sha);
      git(remote, 'fetch', '-q', seed, 'main:refs/heads/main');
      return sha;
    },
    /** 只保留 git 目录之外的一个假家目录（用于镜像判定）。 */
    fakeHome() { const home = path.join(root, 'home'); mkdirSync(home, { recursive: true }); return home; },
  };
}

/** 跑工具，返回 { code, stdout }。 */
function run(args) {
  const result = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: 0, stdout: result };
}

function runAllowFailure(args) {
  try { return run(args); } catch (error) { return { code: error.status ?? -1, stdout: `${error.stdout ?? ''}` }; }
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
    const ahead = f.advanceRemote();
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
    f.advanceRemote();
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
    f.advanceRemote();
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
    f.advanceRemote();
    rmSync(path.join(f.repo, 'scripts', 'deploy-live.sh'));
    const before = git(f.repo, 'rev-parse', 'HEAD');
    const r = runAllowFailure(['apply', '--repo', f.repo, '--yes', '--home', f.fakeHome()]);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /找不到 .*deploy-live\.sh/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
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
