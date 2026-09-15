import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 这一组测试守的是「故障单」里的两条要求：
//   1) 部署具备收敛语义（对账会删掉提交里已删的文件）；
//   2) 存在「镜像 vs 提交」门禁，能分清 多余 / 缺失 / 漂移 三类差异。
// 全部用真实 git 仓库做夹具：清单从 git 对象库取字节，假造不出来。

const require = createRequire(import.meta.url);
const manifest = require('../image-manifest.js');

const SYSTEM_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SYSTEM_DIR, '..', '..');
const GATE = path.join(REPO_ROOT, 'fairy-system', 'image-manifest.js');
const DEPLOY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'deploy-live.sh');
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

// 夹具：一棵假仓库（真的 git 仓库）+ 一份 deploy-live.sh 形态的清单声明。
// 声明格式刻意与真脚本一致：PACKAGES 的引号在行尾收口，EXTRA_PATHS 在同一行
// 中间收口——解析器两者都要吃得下，这是曾经踩过的坑。
function fixture() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'image-manifest-test-'));
  const repo = path.join(sandbox, 'repo');
  const home = path.join(sandbox, 'home');
  // 与真仓库同一条行尾钉子：`* text=auto eol=lf`。**必须有**——本机系统级
  // gitconfig 里是 core.autocrlf=true，没有这条属性时 `git archive` 会把文本
  // 文件按 CRLF 写进归档，落位出来的镜像与提交的 blob 对不上，门禁就会对
  // 每一次部署报「内容漂移」。真仓库靠 .gitattributes 免疫，夹具也要靠它。
  write(path.join(repo, '.gitattributes'), '* text=auto eol=lf\n');
  write(path.join(repo, 'scripts', 'deploy-live.sh'), [
    'PACKAGES="alpha',
    'beta"',
    'PACKAGE_COUNT=2',
    'EXTRA_PATHS="gamma"   # trailing comment on the same line',
    'EXTRA_COUNT=1',
    '',
  ].join('\n'));
  write(path.join(repo, 'alpha', 'one.txt'), 'alpha-one\n');
  write(path.join(repo, 'alpha', 'nested', 'two.txt'), 'alpha-two\n');
  write(path.join(repo, 'beta', 'three.txt'), 'beta-three\n');
  write(path.join(repo, 'gamma', 'four.txt'), 'gamma-four\n');
  git(repo, 'init', '-q');
  // Windows 上 git 可能带 core.autocrlf=true：那样提交里存的是 CRLF、检出到
  // 工作树的是 LF，而镜像里落位的是后者的字节。这不是「漂移」，是夹具没把
  // 换行策略钉死；钉住它，测试在 Windows 与 CI（ubuntu）上才是同一个世界。
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.email', 'image-manifest-test@example.invalid');
  git(repo, 'config', 'user.name', 'image-manifest test');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture');
  return { sandbox, repo, home };
}

// 把提交内容原样落成镜像（即「一次干净的部署」）。
function stage(repo, home, entries = ['alpha/one.txt', 'alpha/nested/two.txt', 'beta/three.txt', 'gamma/four.txt']) {
  for (const entry of entries) {
    const target = path.join(home, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, entry), target);
  }
}

function runNode(script, args, options = {}) {
  return spawnSync(NODE, [script, ...args], { encoding: 'utf8', ...options });
}

test('controlled-path list comes from deploy-live.sh, not a second copy', () => {
  const { sandbox, repo } = fixture();
  try {
    assert.deepEqual(manifest.readControlledPaths(repo), ['alpha', 'beta', 'gamma']);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  // 真仓库：清单必须与真脚本声明逐条一致，否则部署删的与门禁查的不是一回事。
  const declared = manifest.readControlledPaths(REPO_ROOT);
  assert.equal(declared.length, 16, `expected 16 controlled paths in the real checkout, saw ${declared.length}`);
  assert.ok(declared.includes('fairy-roleplay/dsh-fairy-roleplay'));
  assert.ok(declared.includes('profiles/web'));
  const script = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');
  for (const entry of declared) assert.ok(script.includes(entry), `${entry} is missing from deploy-live.sh`);
});

test('a byte-identical image reports no differences, and the gate agrees', () => {
  const { sandbox, repo, home } = fixture();
  try {
    stage(repo, home);
    const result = manifest.plan({ repoRoot: repo, home, source: 'git', controlledPaths: manifest.readControlledPaths(repo) });
    assert.equal(result.metrics.extra + result.metrics.missing + result.metrics.drifted, 0);

    const clean = runNode(GATE, ['check', '--home', home, '--repo', repo]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /^metrics : files 4 checked/m);
    assert.match(clean.stdout, /ok: the image matches the commit/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the gate separates extra, missing, and drifted files and fails on all three', () => {
  const { sandbox, repo, home } = fixture();
  try {
    stage(repo, home);
    write(path.join(home, 'beta', 'stale.txt'), 'stale\n');                       // 多余
    fs.rmSync(path.join(home, 'alpha', 'nested', 'two.txt'));                     // 缺失
    write(path.join(home, 'gamma', 'four.txt'), 'gamma-four-RIFTED\n');           // 漂移

    const result = manifest.plan({ repoRoot: repo, home, source: 'git', controlledPaths: manifest.readControlledPaths(repo) });
    assert.deepEqual(result.extraFiles, ['beta/stale.txt']);
    assert.deepEqual(result.missingFiles, ['alpha/nested/two.txt']);
    assert.deepEqual(result.driftedFiles, ['gamma/four.txt']);
    assert.equal(manifest.hasDifferences(result), true);

    const dirty = runNode(GATE, ['check', '--home', home, '--repo', repo]);
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    assert.match(dirty.stdout, /extra \(镜像里有、清单里没有\) x1:[\s\S]*\+ beta\/stale\.txt/);
    assert.match(dirty.stdout, /missing \(清单里有、镜像里没有\) x1:[\s\S]*- alpha\/nested\/two\.txt/);
    assert.match(dirty.stdout, /drifted \(两边都有、内容不同\) x1:[\s\S]*! gamma\/four\.txt/);
    assert.match(dirty.stdout, /FAIL: the image does not match the commit/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('prune removes the leftovers, leaves dependencies and host files alone, and converges', () => {
  const { sandbox, repo, home } = fixture();
  try {
    stage(repo, home);
    // 上游删除过文件的典型残片（就是 20260828 那两个死 bundle 的形状）
    write(path.join(home, 'alpha', 'dead', 'index.iife.js'), 'dead\n');
    // pnpm 装的依赖：属于跳过策略，既不能报成多余，也不能删
    write(path.join(home, 'beta', 'node_modules', 'dep', 'index.js'), 'dep\n');
    // 受控路径之外的本机文件：一律不碰
    write(path.join(home, 'settings.yaml'), 'host level\n');

    const planned = manifest.plan({ repoRoot: repo, home, source: 'git', controlledPaths: manifest.readControlledPaths(repo) });
    assert.deepEqual(planned.extraFiles, ['alpha/dead/index.iife.js']);
    assert.deepEqual(planned.removableDirectories, ['alpha/dead']);

    const dry = manifest.prune(planned, { dryRun: true });
    assert.deepEqual(dry.removedFiles, ['alpha/dead/index.iife.js']);
    assert.ok(fs.existsSync(path.join(home, 'alpha', 'dead', 'index.iife.js')), '--dry-run must not touch the disk');

    const applied = manifest.prune(planned, { dryRun: false });
    assert.deepEqual(applied.failures, []);
    assert.deepEqual(applied.removedFiles, ['alpha/dead/index.iife.js']);
    assert.deepEqual(applied.removedDirectories, ['alpha/dead']);
    assert.ok(!fs.existsSync(path.join(home, 'alpha', 'dead')), 'an emptied leftover directory must go too');
    assert.ok(fs.existsSync(path.join(home, 'beta', 'node_modules', 'dep', 'index.js')), 'skip policy must survive prune');
    assert.ok(fs.existsSync(path.join(home, 'settings.yaml')), 'files outside the controlled paths must survive prune');

    // 收敛：第二次对账无事可做。
    const second = manifest.plan({ repoRoot: repo, home, source: 'git', controlledPaths: manifest.readControlledPaths(repo) });
    assert.equal(manifest.hasDifferences(second), false);
    const secondPrune = manifest.prune(second, { dryRun: false });
    assert.deepEqual(secondPrune.removedFiles, []);
    assert.deepEqual(secondPrune.removedDirectories, []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('--preserve absorbs declared local adaptations instead of reporting them as drift', () => {
  const { sandbox, repo, home } = fixture();
  try {
    stage(repo, home);
    write(path.join(home, 'gamma', 'four.txt'), 'locally adapted\n');
    const controlledPaths = manifest.readControlledPaths(repo);

    const strict = manifest.plan({ repoRoot: repo, home, source: 'git', controlledPaths });
    assert.deepEqual(strict.driftedFiles, ['gamma/four.txt']);

    const declared = manifest.plan({ repoRoot: repo, home, source: 'git', controlledPaths, preserve: ['gamma/four.txt'] });
    assert.deepEqual(declared.driftedFiles, []);
    assert.deepEqual(declared.allowedFiles, ['gamma/four.txt']);
    assert.equal(manifest.hasDifferences(declared), false);

    const gate = runNode(GATE, ['check', '--home', home, '--repo', repo, '--allow', 'gamma/four.txt']);
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /allowed \(--preserve，本机适配，不计入差异\):[\s\S]*~ gamma\/four\.txt/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('both sources describe the same tree, and the worktree source sees uncommitted edits', () => {
  const { sandbox, repo } = fixture();
  try {
    const controlledPaths = manifest.readControlledPaths(repo);
    const fromHead = manifest.buildManifest({ repoRoot: repo, home: '/nowhere', source: 'git', controlledPaths });
    const fromTree = manifest.buildManifest({ repoRoot: repo, home: '/nowhere', source: 'worktree', controlledPaths });
    assert.equal(fromHead.metrics.files, 4);
    assert.equal(manifest.diffSources(fromHead, fromTree), true);

    // 未提交的新文件必须被工作树形态看见（--from-worktree 的部署语义），
    // 而 git HEAD 形态看不见——否则「部署工作树」与「对账 HEAD」会互相打架。
    write(path.join(repo, 'beta', 'uncommitted.txt'), 'wip\n');
    const dirtyTree = manifest.buildManifest({ repoRoot: repo, home: '/nowhere', source: 'worktree', controlledPaths });
    assert.equal(dirtyTree.files.has('beta/uncommitted.txt'), true);
    assert.equal(manifest.diffSources(fromHead, dirtyTree), false);
    assert.equal(fromHead.files.has('beta/uncommitted.txt'), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a missing or wrong image root fails as a usage error, never as mass deletion', () => {
  const { sandbox, repo } = fixture();
  try {
    const absent = runNode(GATE, ['check', '--home', path.join(sandbox, 'no-such-home'), '--repo', repo]);
    assert.equal(absent.status, 2, absent.stdout + absent.stderr);
    assert.match(absent.stderr, /image root does not exist/);

    const notACheckout = runNode(GATE, ['check', '--home', sandbox, '--repo', sandbox]);
    assert.equal(notACheckout.status, 2, notACheckout.stdout + notACheckout.stderr);
    assert.match(notACheckout.stderr, /is not a Fairy-DSH checkout/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('deploy-live.sh reconciles before staging and gates the result', () => {
  const script = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');
  const pruneAt = script.indexOf('prune --repo');
  const stageAt = script.indexOf('stage $PACKAGES');
  assert.ok(pruneAt > 0 && stageAt > pruneAt, 'the reconcile step must run before staging');
  assert.match(script, /MANIFEST_TOOL="\$REPO_ROOT\/fairy-system\/image-manifest\.js"/);
  // 对账与落位必须取同一个源，否则 --from-worktree 会把未提交的改动当成多余文件删掉。
  assert.match(script, /SOURCE_MODE=git\nif \[ "\$FROM_WORKTREE" = 1 \]; then SOURCE_MODE=worktree; fi/);
  assert.match(script, /check --repo "\$REPO_ROOT" --source "\$SOURCE_MODE" --home "\$DSH_HOME_TARGET"/);
  // 本机适配默认值来自 manifest 模块（唯一副本），不是脚本里再抄一份；并且走
  // `policy --lines` 的平文输出，不在 shell 侧解析 JSON。
  assert.match(script, /node "\$MANIFEST_TOOL" policy --lines/);
  assert.doesNotMatch(script, /JSON\.parse/, 'preserve defaults must not be parsed in shell');
});

test('ponytail skills stay an install slot: synced at deploy, exempt from prune', () => {
  // 技能文本按上游 MIT 不随仓库分发，但部署时要同步进 preset 的槽位；这个槽位必须
  // 同时避开 prune（否则每次部署先删后同步，来回抖动）。
  const script = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');
  assert.match(script, /\.agent-presets\/fairy-full\/skills/, 'deploy must install into the preset skill slot');
  assert.match(script, /DSH_FAIRY_SKILLS_DIR/, 'the install source must be overridable');
  // 只取 ponytail*：技能根里还有十几个与本 preset 无关的私人技能，整目录 cp 会把它们
  // 连 `_ponytail-vendor` 自身一起嵌套塞进 DSH 会话。
  assert.match(script, /for dir in "\$SKILLS_SRC"\/ponytail\*; do/);
  assert.doesNotMatch(script, /cp -R "\$SKILLS_SRC\/\."/, 'must not copy the whole skills root');
  const syncAt = script.indexOf('SKILLS_DEST=');
  const reconcileAt = script.indexOf('prune --repo');
  assert.ok(syncAt > 0 && reconcileAt > syncAt, 'skills must be synced before the reconcile step, or the first deploy reports them as extra');

  // 槽位在跳过策略里（既不删也不报），且理由写明来源
  const { SKIP_POLICY, isSkipped } = manifest;
  const slot = SKIP_POLICY.find((entry) => entry.prefix === '.agent-presets/fairy-full/skills');
  assert.ok(slot, 'the skill slot must be declared in SKIP_POLICY');
  assert.match(slot.reason, /不随仓库分发/);
  assert.equal(isSkipped('.agent-presets/fairy-full/skills/ponytail-help/SKILL.md'), true);
});

test('a converge-shaped deploy leaves the image byte-identical to the source', () => {
  const { sandbox, repo } = fixture();
  try {
    // 这里跑的是**真** deploy-live.sh（不是测试里重写一遍的部署逻辑）：脚本用
    // `dirname $0/..` 认仓库根，所以把它搬进夹具仓库、以夹具仓库为 cwd 就能跑。
    // 唯一改动是重写 PACKAGES/EXTRA_PATHS 的字面量，让受控路径落到夹具里真实
    // 存在的目录上——夹具没有那 16 个包，`git archive` 会直接报 pathspec 不匹配。
    // 重写是显式的、可断言的：脚本形状（对账顺序、门禁调用、源模式选择）没动。
    const source = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');
    const patched = source
      .replace(/^PACKAGES="[\s\S]*?"$/m, 'PACKAGES="alpha\nbeta"')
      .replace(/^PACKAGE_COUNT=\d+$/m, 'PACKAGE_COUNT=2')
      .replace(/^EXTRA_PATHS="[\s\S]*?"$/m, 'EXTRA_PATHS="gamma fairy-system"')
      .replace(/^EXTRA_COUNT=\d+$/m, 'EXTRA_COUNT=2');
    assert.notEqual(patched, source, 'the harness rewrite matched nothing; deploy-live.sh literals moved');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'fairy-system'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'deploy-live.sh'), patched);
    fs.copyFileSync(path.join(REPO_ROOT, 'fairy-system', 'image-manifest.js'), path.join(repo, 'fairy-system', 'image-manifest.js'));
    // 脚本的前置条件要求仓库里存在 verify-build.js；夹具不落位任何插件包，所以
    // 把真文件放进去即可——它不是本用例的考察对象（本用例看的是对账与门禁）。
    fs.copyFileSync(path.join(REPO_ROOT, 'fairy-system', 'verify-build.js'), path.join(repo, 'fairy-system', 'verify-build.js'));
    // 夹具的初始提交发生在 fixture() 里；这里补的文件必须再提交一次，否则
    // `git archive HEAD` 取不到它们（发布形态部署的正是 HEAD 的树）。
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'harness: deploy script + engine');

    const home = path.join(sandbox, 'deployed');
    // --no-verify：夹具只声明 alpha/beta/gamma 三个受控路径，而脚本第 6 步的
    // verify-build.js 会对**真实的 10 个包**做契约检查，夹具里没有它们，那一步
    // 必然失败且与本用例无关。镜像对账（本用例的考察对象）在下面单独跑真检查。
    const deployed = spawnSync('sh', ['scripts/deploy-live.sh', '--home', home, '--skip-install', '--skip-evomap', '--no-verify'], {
      cwd: repo,
      encoding: 'utf8',
    });
    if (deployed.error || deployed.status === 127) return; // 无 sh 的平台上跳过
    assert.equal(deployed.status, 0, `${deployed.stdout}\n${deployed.stderr}`);
    assert.match(deployed.stdout, /step 1\/6: reconciling/);
    assert.match(deployed.stdout, /step 2\/6: staging controlled files/);
    // 门禁本身（真检查，只读）必须对这次部署点头。
    const gated = spawnSync(process.execPath, [path.join(repo, 'fairy-system', 'image-manifest.js'), 'check', '--repo', repo, '--home', home], {
      encoding: 'utf8',
    });
    assert.equal(gated.status, 0, `${gated.stdout}\n${gated.stderr}`);
    assert.match(gated.stdout, /ok: the image matches the commit/);

    // 再注入一次「上游删过的文件」，重跑必须把它清掉并重新通过门禁。
    write(path.join(home, 'alpha', 'dead', 'index.iife.js'), 'dead\n');
    const again = spawnSync('sh', ['scripts/deploy-live.sh', '--home', home, '--skip-install', '--skip-evomap', '--no-verify'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.match(again.stdout, /pruned 1 file\(s\), 1 dir\(s\)/);
    assert.ok(!fs.existsSync(path.join(home, 'alpha', 'dead')), 'the second deploy must converge');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
