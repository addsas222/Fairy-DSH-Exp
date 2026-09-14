#!/usr/bin/env node
/**
 * `repo-update.mjs` —— 检查并应用**本仓库自身**的更新。
 *
 * 边界（AGENTS §4/§5 把它钉死在哪）：
 *   - 只动这份仓库的代码：远端是否有更新 → `git ls-remote` 比 HEAD；应用 = `pull --ff-only`
 *     + 复用 `scripts/deploy-live.sh` 落位（对账与两道门禁都在那条链里，这里不重写）。
 *   - **DSH / `@deepseek-ai/*` 的版本不在本工具的职责里**：§4 要求走
 *     `upgrade-candidate-preflight.sh` + accepted baseline 人工验收，§5.2 禁 `--accept`，
 *     §5.1 官方安装只读。本工具对宿主版本一个字都不动（那是 `host-align.js` 的 `check` 面）。
 *   - 无人值守路径**必须** `--skip-evomap`：`deploy-live.sh` 对默认 home 会走第 4 步，
 *     而 §5.3 禁止在任何自动化里跑 `evomap join`（外网注册 + 本机凭据）。
 *
 * 用法：
 *   node fairy-system/repo-update.mjs check [--json] [--remote NAME] [--branch NAME]
 *   node fairy-system/repo-update.mjs apply [--dry-run] [--home DIR] [--yes] [--remote NAME] [--branch NAME]
 *
 * 退出码（**离线绝不与"已最新"同码**——这台机器 GitHub 通路时通时断，同码会让检查静默说谎）：
 *   0 已最新 | 1 远端有更新（或 apply 后镜像仍需人工处理）| 2 网络/远端不可达 | 3 用法或前置条件错误
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { CURRENT: 0, BEHIND: 1, OFFLINE: 2, USAGE: 3 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT = path.resolve(HERE, '..');

/** git 调用：永远不可交互（无人值守下不能卡在凭据提示上）。 */
function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
        timeout: 120_000,
      }).trim(),
    };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, out: '', stderr: String(error.stderr ?? error.message).trim() };
  }
}

/** 定位仓库根与分支；不在 git 仓库里就抛带 usage 标记的错误。 */
export function resolveRepo(cwd, branch) {
  const top = git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top.ok) { const e = new Error(`${cwd} 不是 git 仓库`); e.usage = true; throw e; }
  const head = git(top.out, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
  const name = branch || (head.ok && head.out !== 'HEAD' ? head.out : 'main');
  return { root: top.out, branch: name };
}

/** 读本地 HEAD 的提交 SHA。 */
export function localHead(repo) {
  const r = git(repo, ['rev-parse', 'HEAD'], { allowFailure: true });
  return r.ok ? r.out : '';
}

/**
 * 探远端同分支的 SHA。
 *
 * 用 `ls-remote` 而不是 `fetch`：只问一个 ref 的 SHA，不下载对象、不改本地 refs，
 * 因此 `check` 是纯粹只读的（fetch 会写 FETCH_HEAD 与远程跟踪分支）。
 * 失败分两类：git 自己的"远端无此 ref"（exit 2）算**远端异常**，其余网络类失败算离线。
 */
export function remoteHead({ repo, remote, branch }) {
  const r = git(repo, ['ls-remote', '--exit-code', remote, branch], { allowFailure: true });
  if (r.ok) {
    const sha = r.out.split('\n').map((l) => l.split('\t')[0]).filter(Boolean)[0];
    return sha ? { state: 'ok', sha } : { state: 'missing', detail: `远端 ${remote} 上找不到分支 ${branch}` };
  }
  const detail = String(r.stderr ?? '').split('\n').filter(Boolean).slice(0, 2).join(' / ');
  // exit 2 = ls-remote 找到 0 个匹配 ref；其余（认证、DNS、超时、代理）都归"不可达"
  const missing = /exited with code 2\b|no matching ref/i.test(detail) || /no such|not found/i.test(detail);
  return { state: missing ? 'missing' : 'offline', detail };
}

/** 本地是否有远端那个提交（即「本地领先」）。只读本地对象库，不联网。 */
function isLocalAncestorOfRemote(repo, remoteSha) {
  return git(repo, ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { allowFailure: true }).ok;
}

/**
 * 本地与远端的相对位置：current / behind / ahead / diverged / unknown。
 *
 * 只读 `ls-remote` 拿不到祖先关系，但**本地对象库里通常已经有远端那个提交**
 * （上一次 fetch/pull 留下的），所以用 `merge-base --is-ancestor` 就能判方向：
 *   - 远端是本地祖先 → ahead（本地领先，远端没有新提交）
 *   - 本地是远端祖先 → behind（远端领先）
 *   - 都不是 → diverged（分叉，需要人工合）
 * 本地对象库里没有该提交时无法判定（`git commit-tree` 造的夹具、浅克隆），退回 unknown。
 *
 * 为什么必须分方向：本仓常态就是「刚提交未推送」= ahead。这时报「远端有更新、本地落后」
 * 是假话——而 `--ff-only` 在 ahead 下其实是 `Already up to date`，无害。
 */
export function compare(repo, local, remote) {
  if (!local || !remote) return 'unknown';
  if (local === remote) return 'current';
  if (isLocalAncestorOfRemote(repo, remote)) return 'ahead';
  if (git(repo, ['merge-base', '--is-ancestor', local, remote], { allowFailure: true }).ok) return 'behind';
  // 两者都判不出：要么分叉，要么本地根本没有远端那个对象。用 cat-file 区分——后者才是 unknown。
  return git(repo, ['cat-file', '-e', `${remote}^{commit}`], { allowFailure: true }).ok ? 'diverged' : 'unknown';
}

/**
 * 本机适配清单（`--preserve`）：默认取 `image-manifest.js policy --lines`，
 * 与 `deploy-live.sh` 同一来源——不另立第二份列表，否则镜像判定会与部署各说各话
 * （实测：不带 preserve 时对账把本机的 msedge 适配报成漂移）。
 */
function defaultPreserve(repo) {
  const manifest = path.join(repo, 'fairy-system', 'image-manifest.js');
  if (!existsSync(manifest)) return '';
  try {
    return execFileSync(process.execPath, [manifest, 'policy', '--lines'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim();
  } catch { return ''; }
}

/** 镜像是否落后于仓库提交（复用现成的对账引擎，不另起一套）。
 *
 * `image-manifest check --source git` 默认比对 HEAD 的树，正是"镜像 vs 提交"的语义；
 * 它自己已有 0/1/2 的退出码，这里把它折叠成 current / behind / unknown + 摘要，不重判。
 */
export function mirrorState({ repo, home, preserve = '' }) {
  const manifest = path.join(repo, 'fairy-system', 'image-manifest.js');
  if (!home || !existsSync(manifest)) return { state: 'skipped' };
  const args = [manifest, 'check', '--source', 'git', '--home', home, '--repo', repo];
  for (const p of preserve.split(',').map((s) => s.trim()).filter(Boolean)) args.push('--preserve', p);
  try {
    const out = execFileSync(process.execPath, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    });
    return { state: 'current', detail: lastLine(out) };
  } catch (error) {
    const code = error.status;
    const text = `${error.stdout ?? ''}`;
    if (code === 1) {
      // 取 metrics 行：`extra 0, missing 0, drifted 1` 本身就把三类差异说清了。
      // （原来按 /多余|缺失|漂移/ 过滤中文，而 image-manifest 输出的是英文
      //  `extra (…)` / `missing (…)` / `drifted (…)`——一个都不匹配，detail 永远退化成
      //  "see the sections above" 这句空话。）
      const metrics = text.split('\n').find((l) => /metrics\s*:/.test(l));
      return { state: 'behind', detail: metrics ? metrics.trim() : lastLine(text) };
    }
    return { state: 'unknown', detail: String(error.stderr ?? error.message).split('\n')[0] };
  }
}

function lastLine(text) {
  return String(text).trim().split('\n').filter(Boolean).pop() ?? '';
}

/** 是否作为脚本直接运行。注意不能用 `process.argv[1] === …`——本模块是 ESM，
 *  在依赖解析期间 `process.argv[1]` 还是 undefined，直接比较会把入口整段跳过
 *  （实测：所有 verb 静默退出 0）。 */
export function isEntrypoint(argv1, moduleUrl) {
  if (!argv1) return false;
  return path.resolve(argv1) === fileURLToPath(moduleUrl);
}

export function parseArgs(argv) {
  const options = { verb: '', repo: REPO_DEFAULT, home: process.env.DSH_HOME ?? '', remote: 'origin', branch: '', json: false, dryRun: false, yes: false, skipEvomap: true, preserve: null };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('-')) { options.verb = argv[0]; i = 1; }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') options.repo = argv[++i];
    else if (a === '--home') options.home = argv[++i];
    else if (a === '--remote') options.remote = argv[++i];
    else if (a === '--branch') options.branch = argv[++i];
    else if (a === '--json') options.json = true;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--yes') options.yes = true;
    else if (a === '--preserve') options.preserve = argv[++i];
    else if (a === '--with-evomap') options.skipEvomap = false;   // 明确反对默认值时才允许
    else if (a === '-h' || a === '--help') options.help = true;
    else { const e = new Error(`unknown argument: ${a}`); e.usage = true; throw e; }
  }
  return options;
}

const USAGE = `usage: repo-update.mjs <check|apply> [options]
  check  只读：远端是否有更新（git ls-remote 比 HEAD）+ 镜像是否落后于提交
  apply  有更新时 git pull --ff-only，再走 scripts/deploy-live.sh 落位

options:
  --repo DIR     仓库根（默认本文件的上两级）
  --home DIR     镜像根（默认 $DSH_HOME，再默认 ~/.dsh）
  --remote NAME  远端名（默认 origin）
  --branch NAME  分支（默认当前分支）
  --json         机器可读输出（只有 check；apply 是动作，输出给人看）
  --dry-run      只打印将执行的动作，不落任何改动
  --yes          跳过 apply 前的交互确认
  --preserve LIST  逗号分隔的仓库相对路径（本机适配，默认取 image-manifest policy --lines）
  --with-evomap  允许部署链走 evomap 第 4 步（默认**不带**——AGENTS §5.3；传了才会去掉 --skip-evomap）

exit: 0 已最新 | 1 有更新或不一致（远端领先/本地领先/镜像落后） | 2 网络或远端不可达 | 3 用法或前置条件错误（含分叉）`;

/** 各状态的人读说法。分开写是因为"本地领先"与"远端领先"的**动作完全不同**
 *  （前者要 push，后者才 pull），把它们都说成"远端有更新"是假话。 */
const STATE_TEXT = {
  ahead: (sha) => `\n⬆️  本地领先远端 ${sha.slice(0, 7)}——远端**没有**新提交（本仓常态：提交后未推送）\n   要做的是 push，不是 pull；apply 在 --ff-only 下是 "Already up to date"。\n`,
  behind: (sha) => `\n⬆️  远端有更新（本地落后 ${sha.slice(0, 7)}）\n`,
  diverged: (sha) => `\n⚠️  本地与远端分叉（${sha.slice(0, 7)}）：两边各有对方没有的提交\n   --ff-only 一定失败，需要人工合或 rebase。本工具不猜。\n`,
  unknown: (sha) => `\n⚠️  本地与远端 SHA 不同但判不出方向（远端 ${sha.slice(0, 7)}）\n   本地对象库里没有远端那个提交（浅克隆或从未 fetch？）——先 fetch 再判。\n`,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.verb) { process.stdout.write(`${USAGE}\n`); return options.help ? EXIT.CURRENT : EXIT.USAGE; }
  if (options.verb !== 'check' && options.verb !== 'apply') { const e = new Error(`unknown verb: ${options.verb}`); e.usage = true; throw e; }
  const { root, branch } = resolveRepo(options.repo, options.branch);
  const local = localHead(root);
  const remote = remoteHead({ repo: root, remote: options.remote, branch });
  const home = options.home || path.join(os.homedir(), '.dsh');

  if (remote.state === 'offline' || remote.state === 'missing') {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ verb: options.verb, repo: root, branch, remote: options.remote, home, local, state: remote.state, detail: remote.detail }, null, 2)}\n`);
    } else {
      process.stdout.write(`仓库   : ${root}（${branch}）\n镜像根 : ${home}${process.env.DSH_HOME ? '（$DSH_HOME）' : '（默认 ~/.dsh——要查隔离实例请显式 --home）'}\n远端   : ${options.remote}\n`);
      process.stdout.write(`\n⚠️  远端不可达，**无法判断是否有更新**（不是"已最新"）：\n  ${remote.detail}\n`);
      process.stdout.write('   网络恢复后重跑；离线状态与"已最新"必须分得清，否则检查会静默说谎。\n');
    }
    return EXIT.OFFLINE;
  }

  const state = compare(root, local, remote.sha);
  const preserve = options.preserve ?? defaultPreserve(root);
  const mirror = mirrorState({ repo: root, home, preserve });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ verb: options.verb, repo: root, branch, remote: options.remote, home, local, remoteHead: remote.sha, state, preserve, mirror }, null, 2)}\n`);
    return state === 'current' ? EXIT.CURRENT : EXIT.BEHIND;
  }

  process.stdout.write(`仓库   : ${root}（${branch} → ${options.remote}/${branch}）\n`);
  // 必须回显 home：默认是 ~/.dsh，而隔离实例在别处——不回显时"镜像落后"看不出是在说谁
  // （实测踩过：对 .dsh-fairy 部署完，CLI 报落后，其实查的是主环境 ~/.dsh）。
  process.stdout.write(`镜像根 : ${home}${process.env.DSH_HOME ? '（$DSH_HOME）' : '（默认 ~/.dsh——要查隔离实例请显式 --home）'}\n`);
  process.stdout.write(`本机适配: ${preserve || '(无)'}\n`);
  process.stdout.write(`本地   : ${local.slice(0, 12)}\n远端   : ${remote.sha.slice(0, 12)}\n`);
  if (mirror.state === 'behind') process.stdout.write(`镜像   : 落后于提交（${mirror.detail}）\n`);
  else if (mirror.state === 'current') process.stdout.write('镜像   : 与提交一致\n');
  else if (mirror.state === 'unknown') process.stdout.write(`镜像   : 无法判定（${mirror.detail}）\n`);

  if (state === 'current') {
    process.stdout.write('\n✅ 已是最新（本地 HEAD 与远端一致）\n');
    if (mirror.state === 'behind') {
      process.stdout.write('   但镜像落后：node scripts/deploy-live.sh --home <镜像> --skip-evomap\n');
      return EXIT.BEHIND;
    }
    return EXIT.CURRENT;
  }

  if (state === 'ahead' || state === 'diverged' || state === 'unknown') {
    process.stdout.write(STATE_TEXT[state](remote.sha));
    return state === 'ahead' ? EXIT.BEHIND : EXIT.USAGE;
  }

  process.stdout.write(STATE_TEXT.behind(remote.sha));
  if (options.verb === 'check') {
    process.stdout.write('   应用：node fairy-system/repo-update.mjs apply\n');
    return EXIT.BEHIND;
  }

  // --- apply ---
  const deploy = path.join(root, 'scripts', 'deploy-live.sh');
  const deployArgs = ['--home', home];
  if (options.skipEvomap) deployArgs.push('--skip-evomap');
  if (preserve) deployArgs.push('--preserve', preserve);
  const blockers = [];
  const dirty = git(root, ['status', '--porcelain'], { allowFailure: true }).out.split('\n').filter((l) => l.trim() && !l.startsWith('??'));
  if (dirty.length) blockers.push(`工作树有未提交改动（${dirty.length} 个文件）——--ff-only 下会留下半成品`, ...dirty.slice(0, 5));
  if (!existsSync(deploy)) blockers.push(`找不到 ${deploy}（apply 靠它落位，不另写一套部署）`);
  if (blockers.length) {
    process.stdout.write(`\n❌ 不能执行 apply：\n${blockers.map((l) => `  ${l}`).join('\n')}\n`);
    return EXIT.USAGE;
  }
  process.stdout.write(`\n将执行：\n  git -C ${root} pull --ff-only ${options.remote} ${branch}\n  sh ${deploy} ${deployArgs.join(' ')}\n`);
  if (options.dryRun) { process.stdout.write('\n（--dry-run：以上均未执行）\n'); return EXIT.BEHIND; }
  if (!options.yes) { process.stdout.write('\n（未加 --yes：上面就是全部动作，确认后加 --yes 执行）\n'); return EXIT.BEHIND; }

  const pull = git(root, ['pull', '--ff-only', options.remote, branch], { allowFailure: true });
  if (!pull.ok) {
    const text = pull.stderr;
    const diverged = /not possible to fast-forward|divergent|no common ancestor|refusing to merge unrelated/i.test(text);
    process.stdout.write(`\n❌ pull 失败（未改动镜像）：\n  ${text.split('\n').slice(0, 3).join('\n  ')}\n`);
    if (diverged) {
      process.stdout.write('   ↑ 这是**分叉**（两边各有提交），不是网络问题——需要人工合或 rebase。\n');
      return EXIT.USAGE;
    }
    return EXIT.OFFLINE;
  }
  process.stdout.write(`\n✅ 已拉到 ${localHead(root).slice(0, 7)}，开始落位…\n`);

  try {
    // Windows 上 bash 常被 WSL 抢占，而 deploy-live.sh 写成 POSIX sh：用 sh 跑。
    const out = execFileSync('sh', [deploy, ...deployArgs], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 });
    process.stdout.write(String(out).split('\n').slice(-12).join('\n'));
  } catch (error) {
    process.stdout.write(`\n❌ 部署失败：\n${String(error.stdout ?? error.message).split('\n').slice(-12).join('\n')}\n`);
    return EXIT.USAGE;
  }
  const after = mirrorState({ repo: root, home, preserve });
  process.stdout.write(`\n镜像   : ${after.state === 'current' ? '与提交一致 ✅' : `仍需处理（${after.state}）${after.detail ? `：${after.detail}` : ''}`}\n`);
  return after.state === 'current' ? EXIT.CURRENT : EXIT.BEHIND;
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`repo-update: ${error.message}\n`);
    process.exitCode = error.usage === true ? EXIT.USAGE : EXIT.OFFLINE;
  });
}
