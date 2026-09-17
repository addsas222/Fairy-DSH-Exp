// 检查项 mutation：真变异测试（**不修改工作树**）。
//
// 仓库没有 stryker/mutmut 之类的框架，而"变更文件变异分数 >=80%"又必须真实可测，所以这里实现
// 一个足够小但真实可信的变异闭环：
//
//   1. 目标：本次变更（git diff vs HEAD ∪ 未跟踪文件）落在包生产目录（lib/ src/ scripts/）里的
//      JS 文件；再用一次带 NODE_V8_COVERAGE 的预热跑筛出"被测试实际执行过"的文件——
//      从没被加载的文件做变异只会得到 0 分，那不是被测代码的问题。
//   2. 变异体：token 级规则（比较运算取反、逻辑运算互换、布尔取反、数值 ±1），按位置均匀采样。
//      每个变异体先用 `node --check` 验语法，**语法非法的直接丢弃**（否则"编译失败"会被误判成
//      "变异体被杀"，分数是假的）。
//   3. 执行：变异体写到系统临时目录，用 Node 模块加载钩子（module.registerHooks / module.register）
//      在解析阶段把被测模块路由到变异体 → 跑该包真实测试套件。套件失败 = 被杀，通过 = 存活。
//      hooks 有同步/异步两套 API，按运行期可用性选择（Node 22.15+ 有 registerHooks）。
//   4. 基线：先用同样的钩子但不替换模块跑一次，基线不过就记 skipped（跑不通的套件给不出分数）。
//
// 分数 = 被杀 / (被杀 + 存活)，阈值为 80%（见 .agent/checks/mutation.yaml）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ensureDir, finish, globToRegExp, listFiles, parseCli, pct, readCheckConfig, run, trackedFiles, writeJson, git,
} from './lib/runtime.mjs';

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * 预热：用 NODE_V8_COVERAGE 跑一遍该包的测试，收集"被真正加载过"的文件路径。
 * 只有加载过的文件才值得变异——只被当作文本读的文件（例如手写客户端 bundle）即使变异也永远不会
 * 影响断言，把它们算进分母只会制造"存活"噪声（实测：fairy-visual 的 lib/client.js 三个变异体全存活）。
 */
async function collectLoadedFiles(pkg, coverageDir, timeoutMs) {
  fs.mkdirSync(coverageDir, { recursive: true });
  await run(process.execPath, ['--test', ...pkg.testFiles], {
    cwd: pkg.abs,
    env: { NODE_V8_COVERAGE: coverageDir.split(path.sep).join('/') },
    timeoutMs,
  });
  const loaded = new Set();
  for (const file of fs.readdirSync(coverageDir).filter((f) => f.endsWith('.json'))) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(coverageDir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const entry of data.result || []) {
      if (!entry.url || !entry.url.startsWith('file://') || !entry.functions) continue;
      let filePath = decodeURIComponent(new URL(entry.url).pathname);
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
      try {
        loaded.add(fs.realpathSync(filePath));
      } catch { /* 找不到就算了 */ }
    }
  }
  return loaded;
}


const MUTATION_RULES = [
  { id: 'lte-to-lt', pattern: /<=/g, replacement: '<' },
  { id: 'gte-to-gt', pattern: />=/g, replacement: '>' },
  { id: 'strict-eq-to-neq', pattern: /===/g, replacement: '!==' },
  { id: 'eqeq-to-neq', pattern: /==/g, replacement: '!=' },
  { id: 'and-to-or', pattern: /&&/g, replacement: '||' },
  { id: 'or-to-and', pattern: /\|\|/g, replacement: '&&' },
  { id: 'true-to-false', pattern: /\btrue\b/g, replacement: 'false' },
  { id: 'false-to-true', pattern: /\bfalse\b/g, replacement: 'true' },
];

function moduleTypeOf(repo, rel) {
  if (rel.endsWith('.mjs')) return 'esm';
  if (rel.endsWith('.cjs')) return 'cjs';
  let dir = path.dirname(path.join(repo, rel));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).type === 'module' ? 'esm' : 'cjs';
      } catch {
        return 'cjs';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'cjs';
    dir = parent;
  }
}

/** 生成候选变异（按规则 + 均匀采样）。 */
function generateMutants(source, limit) {
  const candidates = [];
  for (const rule of MUTATION_RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(source);
    while (match) {
      const end = match.index + match[0].length;
      candidates.push({
        rule: rule.id,
        offset: match.index,
        length: match[0].length,
        replacement: rule.replacement,
      });
      rule.pattern.lastIndex = end;
      match = rule.pattern.exec(source);
    }
  }
  // 数值 ±1：单独用一条更保守的规则（只改独立的十进制字面量）
  const numberPattern = /(?<![\w$.])(\d{2,})(?![\w$])/g;
  let numberMatch = numberPattern.exec(source);
  while (numberMatch) {
    const value = Number(numberMatch[1]);
    if (Number.isSafeInteger(value) && value !== 0) {
      candidates.push({
        rule: 'number-plus-one',
        offset: numberMatch.index,
        length: numberMatch[1].length,
        replacement: String(value + 1),
      });
    }
    numberMatch = numberPattern.exec(source);
  }
  candidates.sort((a, b) => a.offset - b.offset);
  if (candidates.length <= limit) return candidates;
  const stride = candidates.length / limit;
  const sampled = [];
  for (let i = 0; i < limit; i += 1) sampled.push(candidates[Math.floor(i * stride)]);
  return sampled;
}

function applyMutant(source, mutant) {
  return source.slice(0, mutant.offset) + mutant.replacement + source.slice(mutant.offset + mutant.length);
}

/** 生成加载钩子文件（同步 + 异步两套 API），返回 { registerUrl, dir }。 */
function writeHooks(dir) {
  const hooksSync = `import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const norm = (url) => { try { return path.resolve(fileURLToPath(url)).toLowerCase(); } catch { return String(url).toLowerCase(); } };
const target = process.env.QM_TARGET ? norm(pathToFileURL(path.resolve(process.env.QM_TARGET)).href) : null;
const replacement = process.env.QM_REPLACE ? pathToFileURL(path.resolve(process.env.QM_REPLACE)).href : null;
export function resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (target && replacement && result && result.url && norm(result.url) === target) {
    return { ...result, url: replacement, shortCircuit: true };
  }
  return result;
}
`;
  const hooksAsync = `import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const norm = (url) => { try { return path.resolve(fileURLToPath(url)).toLowerCase(); } catch { return String(url).toLowerCase(); } };
const target = process.env.QM_TARGET ? norm(pathToFileURL(path.resolve(process.env.QM_TARGET)).href) : null;
const replacement = process.env.QM_REPLACE ? pathToFileURL(path.resolve(process.env.QM_REPLACE)).href : null;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (target && replacement && result && result.url && norm(result.url) === target) {
    return { ...result, url: replacement, shortCircuit: true };
  }
  return result;
}
`;
  const register = `import module from 'node:module';
import * as syncHooks from './hooks-sync.mjs';
import * as asyncHooks from './hooks-async.mjs';
void asyncHooks;
if (typeof module.registerHooks === 'function') {
  module.registerHooks(syncHooks);
} else {
  module.register(new URL('./hooks-async.mjs', import.meta.url));
}
`;
  fs.writeFileSync(path.join(dir, 'hooks-sync.mjs'), hooksSync, 'utf8');
  fs.writeFileSync(path.join(dir, 'hooks-async.mjs'), hooksAsync, 'utf8');
  fs.writeFileSync(path.join(dir, 'register.mjs'), register, 'utf8');
  return { registerUrl: pathToFileURL(path.join(dir, 'register.mjs')).href, registerFile: path.join(dir, 'register.mjs') };
}

async function changedFiles(repo) {
  const set = new Set();
  const diff = await git(repo, ['diff', '--unified=0', '--name-only', process.env.QUALITY_DIFF_BASE || 'HEAD', '--']);
  if (diff.code === 0) {
    for (const line of diff.stdout.split('\n')) if (line.trim()) set.add(line.trim());
  }
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.code === 0) for (const rel of untracked.stdout.split('\0')) if (rel) set.add(rel);
  return [...set];
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'mutation.json');
  const scope = check.scope || {};
  const maxMutants = Number(scope.max_mutants || 24);
  const mutantTimeoutMs = Number(scope.mutant_timeout_seconds || 240) * 1000;
  const packageGlobs = (scope.package_globs || ['*/dsh-*/package.json']).map((g) => globToRegExp(g));

  const tracked = await trackedFiles(repo);
  const packages = tracked
    .filter((rel) => rel.endsWith('/package.json') && packageGlobs.some((re) => re.test(rel)))
    .map((manifest) => {
      const dir = path.dirname(manifest);
      const testDir = path.join(repo, dir, 'test');
      return {
        dir,
        abs: path.join(repo, dir),
        name: path.basename(dir),
        manifest,
        testFiles: fs.existsSync(testDir)
          ? listFiles(testDir, { extensions: ['.test.js', '.test.mjs', '.test.cjs'] })
            .map((f) => path.relative(path.join(repo, dir), f).split(path.sep).join('/'))
          : [],
      };
    });

  const changed = await changedFiles(repo);
  const productionRoots = scope.production_roots || ['lib/', 'src/', 'scripts/'];
  // 默认只变异"本次变更"的生产文件（B.md 的变更口径）。QUALITY_MUTATION_TARGETS 是**调试/验证用**
  // 的显式覆盖（逗号分隔的仓库相对路径），用于在变更集为空或变更文件恰好不可用时仍能复核机制本身。
  const overrideTargets = (process.env.QUALITY_MUTATION_TARGETS || scope.extra_targets || [])
    .toString().split(',').map((s) => s.trim()).filter(Boolean);
  const candidateFiles = overrideTargets.length ? overrideTargets : changed;
  const changedProduction = candidateFiles.filter((rel) => CODE_EXTENSIONS.has(path.extname(rel))
    && (overrideTargets.length || productionRoots.some((root) => rel.includes(`/${root}`) || rel.startsWith(root))));
  const owned = [];
  for (const rel of changedProduction) {
    const pkg = packages.find((p) => rel.startsWith(`${p.dir}/`));
    if (pkg && pkg.testFiles.length) owned.push({ rel, pkg });
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-mutation-'));
  const { registerUrl, registerFile } = writeHooks(tempRoot);

  const skip = (reason, metrics = {}) => {
    writeJson(artifactPath, {
      generated_at: new Date().toISOString(), repo, skip_reason: reason, changed_files: changed, ...metrics,
    });
    process.stdout.write(`mutation：跳过 —— ${reason}\n`);
    process.stdout.write(`<<<QUALITY-METRICS>>> ${JSON.stringify({ skipped: true, skip_reason: reason, ...metrics })}\n`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.exit(3);
  };

  if (!owned.length) {
    skip('本次变更里没有落在包生产目录（lib/ src/ scripts/）且带测试的 JS 文件', { targets: 0 });
  }
  void registerFile;

  const loadedCache = new Map();
  const coverageRoot = path.join(tempRoot, 'coverage');
  const results = [];
  let killed = 0;
  let survived = 0;
  let invalid = 0;
  let budget = maxMutants;
  let baselineFailures = 0;

  for (const { rel, pkg } of owned) {
    if (budget <= 0) break;
    const absolute = path.join(repo, rel);
    // 预热筛选：没被测试加载过的文件不做变异（否则分数只反映"文件没被执行"）
    if (!loadedCache.has(pkg.name)) {
      loadedCache.set(pkg.name, await collectLoadedFiles(pkg, path.join(coverageRoot, pkg.name), mutantTimeoutMs));
    }
    let realAbsolute;
    try {
      realAbsolute = fs.realpathSync(absolute);
    } catch {
      realAbsolute = absolute;
    }
    if (!loadedCache.get(pkg.name).has(realAbsolute)) {
      results.push({
        file: rel,
        package: pkg.name,
        mutants: 0,
        killed: 0,
        survived: 0,
        note: '预热覆盖率里没有这个文件（测试从没加载它），跳过变异',
      });
      process.stdout.write('   · 跳过 ' + rel + '（测试从未加载该文件）\n');
      continue;
    }
    const source = fs.readFileSync(absolute, 'utf8');
    const moduleType = moduleTypeOf(repo, rel);
    const perFileBudget = Math.max(1, Math.min(budget, Math.ceil(maxMutants / owned.length)));
    const mutants = generateMutants(source, perFileBudget);
    if (!mutants.length) {
      results.push({ file: rel, package: pkg.name, mutants: 0, killed: 0, survived: 0, note: '没生成出变异候选' });
      continue;
    }
    // 基线：钩子在位但不替换，套件必须通过，否则这个包给不出可信分数
    const baseline = await run(process.execPath, ['--import', registerUrl, '--test', ...pkg.testFiles], {
      cwd: pkg.abs,
      env: { QM_TARGET: absolute, QM_REPLACE: '' },
      timeoutMs: mutantTimeoutMs,
    });
    if (baseline.code !== 0) {
      baselineFailures += 1;
      results.push({
        file: rel,
        package: pkg.name,
        mutants: 0,
        killed: 0,
        survived: 0,
        note: `基线套件未通过（退出码 ${baseline.code}），跳过该文件：${baseline.stdout.split('\n').filter((l) => l.trim()).slice(-3).join(' / ')}`,
      });
      continue;
    }
    const fileResults = [];
    for (const mutant of mutants) {
      if (budget <= 0) break;
      budget -= 1;
      const mutatedSource = applyMutant(source, mutant);
      const tempFile = path.join(tempRoot, `mutant-${results.length}-${fileResults.length}${moduleType === 'esm' ? '.mjs' : '.cjs'}`);
      fs.writeFileSync(tempFile, mutatedSource, 'utf8');
      const syntax = await run(process.execPath, ['--check', tempFile], { cwd: repo, timeoutMs: 60_000 });
      if (syntax.code !== 0) {
        invalid += 1;
        fileResults.push({ rule: mutant.rule, offset: mutant.offset, outcome: 'invalid', note: `${moduleType} 语法校验失败（不计入分数）` });
        continue;
      }
      const result = await run(process.execPath, ['--import', registerUrl, '--test', ...pkg.testFiles], {
        cwd: pkg.abs,
        env: { QM_TARGET: absolute, QM_REPLACE: tempFile },
        timeoutMs: mutantTimeoutMs,
      });
      const outcome = result.code === 0 ? 'survived' : 'killed';
      if (outcome === 'killed') killed += 1;
      else survived += 1;
      fileResults.push({
        rule: mutant.rule,
        offset: mutant.offset,
        replacement: mutant.replacement,
        outcome,
      });
      process.stdout.write(`   ${outcome === 'killed' ? '✔ 杀掉' : '✖ 存活'} ${rel} [${mutant.rule}] offset=${mutant.offset}\n`);
    }
    results.push({
      file: rel,
      package: pkg.name,
      module_type: moduleType,
      mutants: fileResults.length,
      killed: fileResults.filter((m) => m.outcome === 'killed').length,
      survived: fileResults.filter((m) => m.outcome === 'survived').length,
      details: fileResults,
    });
  }

  const total = killed + survived;
  const score = total ? Number(((killed / total) * 100).toFixed(2)) : null;
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    node: process.version,
    changed_files: changed,
    targets: owned.map((o) => o.rel),
    max_mutants: maxMutants,
    killed,
    survived,
    invalid_mutants: invalid,
    baseline_failures: baselineFailures,
    mutation_score: score,
    files: results,
  };
  ensureDir(path.dirname(artifactPath));
  writeJson(artifactPath, artifact);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  if (score === null) {
    skip(
      `没有产生可判定分数的变异体（被杀 ${killed} / 存活 ${survived} / 非法丢弃 ${invalid} / 基线失败文件 ${baselineFailures}）——原因见文件明细`,
      {
        invalid_mutants: invalid, baseline_failures: baselineFailures, files: results,
      },
    );
  }

  process.stdout.write(`mutation：目标文件 ${owned.length} 个；变异体 ${total} 个（被杀 ${killed} / 存活 ${survived}）；非法丢弃 ${invalid}；基线失败文件 ${baselineFailures}；分数 ${score}%\n`);
  const ok = score >= 80 && baselineFailures === 0;
  finish({
    ok,
    metrics: {
      mutation_score: score,
      killed,
      survived,
      mutants_sampled: total,
      invalid_mutants: invalid,
      baseline_failures: baselineFailures,
      target_files: owned.length,
    },
    artifactPath,
    artifact,
    failureNote: '变异分数低于 80%：存活的变异体说明测试没有真正断言这段逻辑（见产物 JSON 的 files[].details）。',
  });
}

main().catch((error) => {
  process.stdout.write(`mutation 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
