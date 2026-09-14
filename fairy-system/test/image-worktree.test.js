import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * `--from-worktree` 的两个口径差：清单（git 视图）与落位（tar / 文件系统视图）
 * 必须说同一件事，否则要么崩、要么永不收敛。两条都是故障单「部署不收敛」的
 * 变体，且都不在 git 形态（`git archive HEAD`）里出现：
 *
 *   ① 已删未提交的 tracked 文件仍在 `git ls-files --cached --others` 里，
 *      而磁盘上已经没有它。清单若照单全收地 readFileSync，第 1 步就 ENOENT 崩掉
 *      ——「先删文件、再部署」是开发回路里最常见的动作。
 *   ② tar 只排除了 node_modules/.git，会把**被忽略**的文件（`alpha/.env`、
 *      `alpha/logs/`）落进镜像；清单用的是 `--exclude-standard`（不含被忽略
 *      文件）。于是第 6 步报 extra、prune 删掉、下一次 stage 又加回来——两次
 *      部署之间镜像永远在抖。
 *
 * 这一组用真 git 仓库 + 真 deploy-live.sh 跑，不重写部署逻辑。
 */

const SYSTEM_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SYSTEM_DIR, '..', '..');
const MANIFEST = path.join(REPO_ROOT, 'fairy-system', 'image-manifest.js');
const NODE = process.execPath;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function imageFiles(home) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(home, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(home)) walk(home);
  return out.sort();
}

/**
 * 夹具：git 仓库 + **真** deploy-live.sh（受控路径改成夹具里存在的 alpha/beta，
 * 其余逻辑原样——对账顺序、忽略语义、门禁调用都是被测对象），忽略规则落在
 * .gitignore，fairy-system/image-manifest.js 用真身。
 */
function fixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-worktree-'));
  const repo = path.join(sandbox, 'repo');
  const home = path.join(sandbox, 'home');
  // 只改字面量，不改结构：脚本自己读 PACKAGES/EXTRA_PATHS 来决定落位与对账范围，
  // 夹具里没有那 16 个真包，`git archive` 会报 pathspec 不匹配。
  const deploySource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'deploy-live.sh'), 'utf8');
  const patched = deploySource
    .replace(/^PACKAGES="[\s\S]*?"$/m, 'PACKAGES="alpha"')
    .replace(/^PACKAGE_COUNT=\d+$/m, 'PACKAGE_COUNT=1')
    .replace(/^EXTRA_PATHS="[\s\S]*?"$/m, 'EXTRA_PATHS="beta fairy-system"')
    .replace(/^EXTRA_COUNT=\d+$/m, 'EXTRA_COUNT=2');
  assert.notEqual(patched, deploySource, 'the fixture rewrite matched nothing; deploy-live.sh literals moved');
  write(path.join(repo, 'scripts', 'deploy-live.sh'), patched);
  write(path.join(repo, '.gitignore'), 'node_modules/\n.env\n.env.*\nlogs/\n');
  write(path.join(repo, 'alpha', 'tracked.txt'), 'tracked\n');
  write(path.join(repo, 'alpha', '.env'), 'SECRET=1\n');
  write(path.join(repo, 'alpha', 'logs', 'run.log'), 'noise\n');
  write(path.join(repo, 'beta', 'b.txt'), 'b\n');
  write(path.join(repo, 'fairy-system', 'image-manifest.js'), fs.readFileSync(MANIFEST));
  // 脚本的前置条件要求仓库里有 verify-build.js（它会把它一并落位到镜像），
  // 缺了它脚本在第 0 步就退出，本用例想考察的对账/裁剪根本跑不到。
  write(path.join(repo, 'fairy-system', 'verify-build.js'), fs.readFileSync(path.join(REPO_ROOT, 'fairy-system', 'verify-build.js')));
  git(repo, 'init', '-q', '-b', 'main');
  // 与另一个用例同理：钉死换行策略，否则 Windows 与 CI 会替 git 决定字节。
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.email', 'worktree-test@example.invalid');
  git(repo, 'config', 'user.name', 'image-manifest worktree test');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture');
  return { sandbox, repo, home };
}

function deploy(repo, home, extra = []) {
  return spawnSync(
    'sh',
    ['scripts/deploy-live.sh', '--home', home, '--from-worktree', '--skip-install', '--skip-evomap', '--no-verify', ...extra],
    { cwd: repo, encoding: 'utf8' },
  );
}

function check(repo, home) {
  return spawnSync(NODE, [MANIFEST, 'check', '--repo', repo, '--home', home, '--source', 'worktree'], { encoding: 'utf8' });
}

test('a tracked file deleted from the worktree does not crash the worktree source', () => {
  const { sandbox, repo, home } = fixture();
  try {
    fs.rmSync(path.join(repo, 'alpha', 'tracked.txt'));
    // 把夹具自己的 fairy-system/ 一并落位：清单一视同仁地要求它，缺了会以 missing
    // 报出来，掩盖本用例真正要看的那个文件。
    for (const file of ['image-manifest.js', 'verify-build.js']) {
      write(path.join(home, 'fairy-system', file), fs.readFileSync(path.join(repo, 'fairy-system', file)));
    }
    write(path.join(home, 'beta', 'b.txt'), fs.readFileSync(path.join(repo, 'beta', 'b.txt')));

    const result = check(repo, home);
    // 关键区别：不是 ENOENT 崩溃，而是一份正常报告（该文件已经不在工作树里，
    // 所以既不是缺失也不是漂移——它不在清单里）。
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.match(result.stdout, /^metrics\s*:/m);
    assert.ok(!result.stdout.includes('alpha/tracked.txt'), `deleted tracked file leaked into the manifest:\n${result.stdout}`);
    assert.match(result.stdout, /missing 0/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('worktree staging and the manifest agree about ignored files', () => {
  const { sandbox, repo, home } = fixture();
  try {
    const first = deploy(repo, home);
    if (first.error || first.status === 127) return; // 无 sh 的平台上跳过
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    const files = imageFiles(home);
    assert.ok(files.includes('alpha/tracked.txt'), `the tracked file must land: ${JSON.stringify(files)}`);
    assert.ok(!files.some((file) => file.includes('.env')), `an ignored .env must not be staged: ${JSON.stringify(files)}`);
    assert.ok(!files.some((file) => file.includes('logs/')), `an ignored directory must not be staged: ${JSON.stringify(files)}`);

    const gated = check(repo, home);
    assert.equal(gated.status, 0, `${gated.stdout}\n${gated.stderr}`);
    assert.match(gated.stdout, /extra 0, missing 0, drifted 0/);

    // 收敛语义：第二次部署必须无事可做（此前被忽略文件会让 prune 与 stage 互相打架，
    // 每次都报 extra x2 并反复删/加）。
    const second = deploy(repo, home);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /already convergent|pruned 0 file/);
    const gatedAgain = check(repo, home);
    assert.equal(gatedAgain.status, 0, `${gatedAgain.stdout}\n${gatedAgain.stderr}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('an ignored file that appears after the first deploy does not break convergence', () => {
  const { sandbox, repo, home } = fixture();
  try {
    const first = deploy(repo, home);
    if (first.error || first.status === 127) return;
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    // 开发者在工作树里加了本机专属的忽略产物（例如包内的 logs/ 与 .env），再部署。
    // 注意选的必须是 git 真正忽略的路径：`.gitignore` 的 `.env` 只匹配叫 .env 的
    // 文件（`alpha/.env.local` 并不被忽略，落位它是**正确**行为，用 git check-ignore
    // 判断，不靠直觉）。
    const ignoredInRepo = path.join(repo, 'alpha', 'logs', 'verbose.log');
    write(ignoredInRepo, 'more noise\n');
    const ignoreCheck = spawnSync('git', ['check-ignore', '-q', 'alpha/logs/verbose.log'], { cwd: repo });
    assert.equal(ignoreCheck.status, 0, 'the fixture file must be genuinely ignored before this test means anything');

    const second = deploy(repo, home);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.ok(!imageFiles(home).some((file) => file.includes('logs/')), 'ignored files must stay out of the image');

    const gated = check(repo, home);
    assert.equal(gated.status, 0, `${gated.stdout}\n${gated.stderr}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
