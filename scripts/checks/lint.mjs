// 检查项 lint：语法解析 + 项目自定规则（零依赖，Node 内建 vm 解析）。
//
// 仓库没有 eslint（也没打算引根级依赖），但"没有 lint"不等于"不能真检查"。
// 这里做两件真事：
//   1. 解析校验：每个跟踪的 .js/.mjs/.cjs 都按它真实的模块类型解析一遍（CJS 用 vm.Script，
//      ESM 用 vm.SourceTextModule——所以命令里带 --experimental-vm-modules）。语法错误 = 错误级。
//   2. 规则检查：高信号、且**当前代码库本来就满足**的项目规则（写进来的规则如果在存量代码上
//      就红，那不是门禁而是噪声）：
//        no-debugger             任何地方不得留 debugger
//        no-eval-in-production   lib/ 与 src/ 里不得出现 eval( / new Function(
//        no-console-in-production lib/ 与 src/ 里不得出现 console.log/console.debug
//        no-focused-tests        test/ 里不得出现 .only(（会把整包测试收窄成一条）
//        no-empty-catch          不得有空的 catch 块（吞异常）
// 说明：测试夹具里的 new Function（解析客户端 bundle）是合法用法，所以规则只作用于
// **生产代码路径** lib/、src/；`fairy-system/*.js` 属工具而非产物，规则同样不管它。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  ensureDir, finish, parseCli, pct, readCheckConfig, repoRelative, scannedFiles,
} from './lib/runtime.mjs';

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

const MODULE_SYNTAX_HINTS = /(Cannot use import statement outside a module|Unexpected token 'export'|await is only valid in async|Cannot use 'import\.meta')/;

/** 判定模块类型：扩展名 → 最近的 package.json type → Node 的模块语法探测（与运行期一致）。 */
function baseModuleType(repo, file) {
  if (file.endsWith('.mjs')) return 'esm';
  if (file.endsWith('.cjs')) return 'cjs';
  let dir = path.dirname(path.join(repo, file));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const type = JSON.parse(fs.readFileSync(pkg, 'utf8')).type;
        if (type === 'module') return 'esm';
        if (type === 'commonjs') return 'cjs';
        return 'detect';
      } catch {
        return 'detect';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'detect';
    dir = parent;
  }
}

/**
 * 与 Node 运行期一致地解析一个文件：
 *   - 明确类型 → 按类型解析；
 *   - detect → 先按 CJS 解析，报"模块语法"类错误时改按 ESM 解析（Node 22+ 的模块语法探测）。
 */
function parseFile(source, declared, filename) {
  if (declared === 'esm') {
    const result = parseSource(source, 'esm', filename);
    return { ...result, moduleType: 'esm' };
  }
  const asCjs = parseSource(source, 'cjs', filename);
  if (asCjs.ok || declared === 'cjs') return { ...asCjs, moduleType: 'cjs' };
  if (MODULE_SYNTAX_HINTS.test(asCjs.message)) {
    const asEsm = parseSource(source, 'esm', filename);
    return { ...asEsm, moduleType: 'esm' };
  }
  return { ...asCjs, moduleType: 'cjs' };
}

function isProduction(rel) {
  return /(^|\/)(lib|src)\//.test(rel);
}

const RULES = [
  {
    id: 'no-debugger',
    severity: 'error',
    matches: () => true,
    // 要求分号：真正的调试语句写法带分号，这样规则不会误伤注释与文档里提到的那个关键字
    pattern: /(^|[^.\w$])debugger\s*;/,
    message: '不得保留调试语句（关键字后跟分号）',
  },
  {
    id: 'no-eval-in-production',
    severity: 'error',
    matches: (rel) => isProduction(rel),
    pattern: /(^|[^.\w$])eval\s*\(|new\s+Function\s*\(/,
    message: '生产代码不得使用 eval( / new Function(（测试夹具解析 bundle 的场景请放在 test/ 下）',
  },
  {
    id: 'no-console-in-production',
    severity: 'error',
    matches: (rel) => isProduction(rel),
    pattern: /console\.(log|debug)\s*\(/,
    message: '生产代码不得用 console.log/console.debug（应走模块自己的日志面）',
  },
  {
    id: 'no-focused-tests',
    severity: 'error',
    matches: (rel) => /(^|\/)test\//.test(rel) || /\.test\.(m|c)?js$/.test(rel),
    pattern: /(^|[^.\w$])(describe|it|test)\.only\s*\(/,
    message: '测试里不得出现 .only(（会把整包测试收窄成一条）',
  },
  {
    id: 'no-empty-catch',
    // 提示级：本仓清理器里 `try { dispose(); } catch {}` 是有意为之的幂等释放模式，
    // 存量命中 10 处（见产物 JSON）。规则保留为信号，不参与门禁——第一次跑就红的规则
    // 是噪声而不是门禁。
    severity: 'warning',
    matches: () => true,
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    message: '空 catch 块（吞掉异常）——确认是有意忽略再保留',
  },
];

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

let esmFallbackCount = 0;

/**
 * 没有 vm.SourceTextModule 时的真实回退：源码写成 .mjs 临时文件跑 node --check。
 * 有这条回退，"配置里漏了 --experimental-vm-modules" 就不会变成整仓 216 个假解析错误。
 */
function parseEsmByCheck(source) {
  const tempFile = path.join(os.tmpdir(), 'fairy-lint-' + process.pid + '-' + esmFallbackCount + '.mjs');
  esmFallbackCount += 1;
  fs.writeFileSync(tempFile, source, 'utf8');
  try {
    const result = spawnSync(process.execPath, ['--check', tempFile], { encoding: 'utf8', timeout: 60000 });
    if (result.status === 0) return { ok: true };
    const message = (result.stderr || result.stdout || '').split('\n').filter((l) => l.trim())[0] || ('node --check 退出码 ' + result.status);
    return { ok: false, message };
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

function parseSource(source, moduleType, filename) {
  if (moduleType === 'esm') {
    if (typeof vm.SourceTextModule !== 'function') {
      return parseEsmByCheck(source);
    }
    try {
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(source, { identifier: filename });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error && error.message) };
    }
  }
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error && error.message) };
  }
}

async function main() {
  const args = parseCli();
  const repo = path.resolve(args.repo || process.cwd());
  const check = readCheckConfig(args.check);
  const reportDir = args['report-dir'] || path.join(repo, 'reports');
  const artifactPath = args.artifact || path.join(reportDir, 'artifacts', 'lint.json');
  const scope = check.scope || {};
  const extraExclude = new Set((scope.exclude || []).map((p) => p.split('/').join('/')));

  const files = (await scannedFiles(repo)).filter((rel) => CODE_EXTENSIONS.has(path.extname(rel)));
  if (files.length === 0) {
    process.stdout.write('lint 内部错误：扫描面为空（没有任何 .js/.mjs/.cjs）——不接受假通过\n');
    process.exit(2);
  }
  const findings = [];
  const parseFindings = [];
  let scanned = 0;
  const ruleHits = {};
  const moduleTypes = {};

  for (const rel of files) {
    if (extraExclude.has(rel)) continue;
    scanned += 1;
    const full = path.join(repo, rel);
    const source = fs.readFileSync(full, 'utf8');
    const declared = baseModuleType(repo, rel);
    const parsed = parseFile(source, declared, rel);
    if (!parsed.ok) {
      parseFindings.push({
        path: rel, rule: 'parse', detail: parsed.message, declared_module_type: declared, module_type: parsed.moduleType,
      });
      continue;
    }
    moduleTypes[parsed.moduleType] = (moduleTypes[parsed.moduleType] || 0) + 1;
    for (const rule of RULES) {
      if (!rule.matches(rel)) continue;
      const match = rule.pattern.exec(source);
      if (!match) continue;
      ruleHits[rule.id] = (ruleHits[rule.id] || 0) + 1;
      findings.push({
        path: rel,
        rule: rule.id,
        severity: rule.severity,
        line: lineOf(source, match.index),
        snippet: source.split('\n')[lineOf(source, match.index) - 1].trim().slice(0, 160),
        message: rule.message,
      });
    }
  }

  const errors = [...parseFindings, ...findings.filter((f) => f.severity === 'error')];
  const advisories = findings.filter((f) => f.severity !== 'error');
  const artifact = {
    generated_at: new Date().toISOString(),
    repo,
    files_scanned: scanned,
    module_types: moduleTypes,
    vm_modules: typeof vm.SourceTextModule === 'function',
    esm_check_fallbacks: esmFallbackCount,
    errors,
    advisories,
    rule_hits: ruleHits,
  };
  ensureDir(path.dirname(artifactPath));
  const ok = errors.length === 0;
  if (ok) {
    process.stdout.write(`lint：解析 ${scanned} 个跟踪 JS 文件全部通过（${Object.entries(moduleTypes).map(([k, v]) => `${k} ${v}`).join(' / ')}）；错误级命中 0；提示级 ${advisories.length} 条（vm.SourceTextModule=${typeof vm.SourceTextModule === 'function' ? '可用' : '不可用'}）\n`);
    for (const item of advisories.slice(0, 15)) process.stdout.write(`  · ${item.path}:${item.line} [${item.rule}] ${item.message}\n`);
  } else {
    process.stdout.write(`lint：${errors.length} 处问题\n`);
    for (const item of errors.slice(0, 40)) {
      process.stdout.write(`  ✖ ${item.path}${item.line ? `:${item.line}` : ''} [${item.rule}] ${item.detail || item.message} ${item.snippet ? `\n      ${item.snippet}` : ''}\n`);
    }
    if (errors.length > 40) process.stdout.write(`  … 其余 ${errors.length - 40} 条见产物 JSON\n`);
  }
  finish({
    ok,
    metrics: {
      files_scanned: scanned,
      errors: errors.length,
      parse_errors: parseFindings.length,
      rule_findings: findings.length,
      advisories: advisories.length,
      error_rate: pct(errors.length, scanned),
    },
    artifactPath,
    artifact,
    failureNote: 'lint 错误必须为 0；确需豁免的存量点请加进 .agent/checks/lint.yaml 的 scope.exclude 并写明原因。',
  });
}

main().catch((error) => {
  process.stdout.write(`lint 内部错误：${error && error.stack ? error.stack : error}\n`);
  process.exit(2);
});
