#!/usr/bin/env node
// Fairy-DSH 质量体系主入口。
//
// 它只做四件事，且**不认识任何具体检查项**：
//   1. 读配置：.agent/quality.yaml（用 .agent/quality.schema.json 真实校验）
//   2. 自动发现：.agent/checks/*.yaml（每个检查项一个文件，主入口零硬编码）
//   3. 按阶段执行：按 stages 的 order/并发执行，按平台挑 windows_command / unix_command
//   4. 汇总报告与门禁：reports/quality-report.{md,json}、reports/verify.log、逐项产物日志
//
// 扩展新检查项无需改本文件：加 .agent/checks/<id>.yaml + scripts/checks/<id>.mjs
// + docs/quality/<id>.md。生成/刷新安装脚本：node scripts/verify.mjs --generate-install。
//
// 用法（Windows / POSIX 等价）：
//   node scripts/verify.mjs                 # 全量按阶段跑
//   node scripts/verify.mjs --stage static  # 只跑某阶段
//   node scripts/verify.mjs --only unit,format
//   node scripts/verify.mjs --list          # 只列出发现的检查项
//   node scripts/verify.mjs --dry-run       # 只打印将要执行的命令
//   node scripts/verify.mjs --generate-install
// 包装脚本：scripts/verify.cmd（Windows，推荐）、scripts/verify.ps1（Windows）、
// scripts/verify.sh（POSIX sh）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './checks/lib/yaml.mjs';
import { validateAgainstSchema } from './checks/lib/schema.mjs';
import { generateInstallScripts } from './checks/lib/install-gen.mjs';
import {
  EXIT, METRICS_MARKER, ensureDir, parseCli, run, runCommandString, writeJson,
} from './checks/lib/runtime.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..');
const IS_WINDOWS = process.platform === 'win32';
const PLATFORM = IS_WINDOWS ? 'windows' : 'unix';

const STATUS_LABEL = {
  passed: '通过',
  failed: '失败',
  error: '错误',
  timeout: '超时',
  blocked: '阻塞',
  skipped: '跳过',
  unsupported: '平台不支持',
  disabled: '未启用',
};

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

function findConfig(repo, explicit) {
  if (explicit) return path.resolve(repo, explicit);
  const candidate = path.join(repo, '.agent', 'quality.yaml');
  if (!fs.existsSync(candidate)) {
    throw new Error(`找不到质量配置：${candidate}（可用 --config 指定）`);
  }
  return candidate;
}

function loadSchema(repo) {
  const schemaPath = path.join(repo, '.agent', 'quality.schema.json');
  if (!fs.existsSync(schemaPath)) throw new Error(`找不到 schema：${schemaPath}`);
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function loadConfig(repo, configPath) {
  let config;
  try {
    config = parseYaml(fs.readFileSync(configPath, 'utf8'), { filename: configPath });
  } catch (error) {
    throw new Error(`质量配置解析失败：${error.message}`);
  }
  const schema = loadSchema(repo);
  const errors = validateAgainstSchema(config, schema.$defs.qualityConfig, path.basename(configPath), schema);
  if (errors.length) throw new Error(`质量配置不符合 schema：\n  - ${errors.join('\n  - ')}`);
  return config;
}

function discoverChecks(config, repo, overrides = {}) {
  const checksDir = path.resolve(repo, overrides.checksDir || config.discovery.checks_dir);
  if (!fs.existsSync(checksDir)) throw new Error(`检查项目录不存在：${checksDir}`);
  const pattern = overrides.pattern || config.discovery.pattern || '*.yaml';
  const exclude = new Set(config.discovery.exclude || []);
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  const files = fs.readdirSync(checksDir)
    .filter((name) => regex.test(name) && !exclude.has(name))
    .sort()
    .map((name) => path.join(checksDir, name));
  return { checksDir, files };
}

function validateCheck(check, { file, config, repo, schema }) {
  const errors = validateAgainstSchema(check, schema.$defs.checkItem, path.basename(file), schema);
  const stageIds = new Set(config.stages.map((s) => s.id));
  if (check.stage && !stageIds.has(check.stage)) {
    errors.push(`stage "${check.stage}" 未在 .agent/quality.yaml 的 stages 里定义`);
  }
  const declaredWindows = check.platform_support && check.platform_support.windows;
  const declaredUnix = check.platform_support && check.platform_support.unix;
  if (!check.windows_command && !declaredWindows) {
    errors.push('缺 windows_command，且未用 platform_support.windows 声明不支持及原因');
  }
  if (!check.unix_command && !declaredUnix) {
    errors.push('缺 unix_command，且未用 platform_support.unix 声明不支持及原因');
  }
  if (check.docs && !fs.existsSync(path.resolve(repo, check.docs))) {
    errors.push(`docs 指向的文件不存在：${check.docs}`);
  }
  for (const artifact of check.artifacts || []) {
    if (path.isAbsolute(artifact)) errors.push(`artifacts 必须是仓库相对路径：${artifact}`);
  }
  for (const req of check.requires || []) {
    if (req.kind === 'tool' && !req.probe) errors.push(`requires(kind=tool) 缺少 probe：${req.name || '?'}`);
    if (req.kind === 'tool' && !req.name) errors.push('requires(kind=tool) 缺少 name');
    if (req.kind === 'env' && !req.env) errors.push('requires(kind=env) 缺少 env');
    if (req.kind === 'path' && !req.path) errors.push('requires(kind=path) 缺少 path');
    if (req.kind === 'check' && !req.id) errors.push('requires(kind=check) 缺少 id');
  }
  return errors;
}

export function buildVars(ctx, check) {
  const artifactDir = path.join(ctx.reportDir, 'artifacts');
  return {
    repo: ctx.repo,
    repoNative: ctx.repo.split('/').join(path.sep),
    config: ctx.configPath,
    check: check.file,
    checkDir: path.dirname(check.file),
    reportDir: ctx.reportDir,
    artifactDir,
    artifact: path.join(artifactDir, `${check.id}.json`),
    checkLog: path.join(artifactDir, `${check.id}.log`),
    node: process.execPath.split('\\').join('/'),
    npm: IS_WINDOWS ? 'npm.cmd' : 'npm',
    pnpm: IS_WINDOWS ? 'pnpm.cmd' : 'pnpm',
    python: IS_WINDOWS ? 'py -3' : 'python3',
    os: PLATFORM,
    tmp: os.tmpdir().split('\\').join('/'),
    stage: check.stage,
    id: check.id,
    schemaVersion: String(ctx.config.schema_version),
  };
}

function substitute(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\$\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) => {
    if (!(name in vars)) throw new Error(`未知模板变量 ${match}（可用：${Object.keys(vars).sort().join(', ')}）`);
    return String(vars[name]);
  });
}

export function resolveCommand(check, vars) {
  const support = check.platform_support && check.platform_support[PLATFORM];
  if (support && support.supported === false) {
    return { unsupported: true, reason: support.reason };
  }
  const preferred = PLATFORM === 'windows' ? check.windows_command : check.unix_command;
  const command = preferred || check.command;
  if (!command) {
    return { unsupported: true, reason: `未提供 ${PLATFORM === 'windows' ? 'windows_command' : 'unix_command'}` };
  }
  return { command: substitute(command, vars), cwd: substitute(check.cwd || vars.repo, vars) };
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function missingRequirements(check, ctx) {
  const missing = [];
  for (const req of check.requires || []) {
    const vars = ctx.varsFor(check);
    if (req.kind === 'tool') {
      const result = await runCommandString(substitute(req.probe, vars), { cwd: ctx.repo, timeoutMs: 120_000 });
      if (result.code !== 0) {
        missing.push({ req, detail: `探测命令 \`${req.probe}\` 退出码 ${result.code}` });
      } else if (req.min_version) {
        const text = `${result.stdout} ${result.stderr}`;
        const found = (text.match(/\d+(\.\d+)*/) || [null])[0];
        if (found && compareVersions(found, req.min_version) < 0) {
          missing.push({ req, detail: `版本 ${found} 低于要求的 ${req.min_version}` });
        }
      }
    } else if (req.kind === 'env') {
      if (!process.env[req.env]) missing.push({ req, detail: `环境变量 ${req.env} 未设置` });
    } else if (req.kind === 'path') {
      const target = path.resolve(ctx.repo, substitute(req.path, vars));
      if (!fs.existsSync(target)) missing.push({ req, detail: `路径不存在：${req.path}` });
    } else if (req.kind === 'check') {
      const dep = ctx.results.get(req.id);
      if (!dep) missing.push({ req, detail: `依赖的检查项 ${req.id} 未执行（不在本轮筛选范围内）` });
      else if (!['passed', 'disabled'].includes(dep.status)) {
        missing.push({ req, detail: `依赖的检查项 ${req.id} 状态是 ${dep.status}` });
      }
    } else if (req.kind === 'home') {
      const home = process.env[req.env || 'DSH_HOME'] || path.join(os.homedir(), req.name || '.dsh');
      if (!fs.existsSync(home)) missing.push({ req, detail: `目录不存在：${home}` });
    }
  }
  return missing;
}

export function parseMetrics(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith(METRICS_MARKER)) {
      try {
        return JSON.parse(lines[i].slice(METRICS_MARKER.length).trim());
      } catch (error) {
        return { metrics_parse_error: String(error && error.message) };
      }
    }
  }
  return {};
}

export function evaluateThreshold(check, metrics) {
  const spec = check.threshold || {};
  const results = [];
  for (const rule of spec.metrics || []) {
    const value = metrics[rule.name];
    if (value === undefined || value === null) {
      results.push({
        name: rule.name, label: rule.label || rule.name, ok: Boolean(rule.optional), missing: true, value: null, min: rule.min, max: rule.max,
      });
      continue;
    }
    let ok = true;
    if (rule.min !== undefined && value < rule.min) ok = false;
    if (rule.max !== undefined && value > rule.max) ok = false;
    results.push({
      name: rule.name, label: rule.label || rule.name, ok, missing: false, value, min: rule.min, max: rule.max, unit: rule.unit || '',
    });
  }
  return results;
}

/** 起一个可整组终止的子进程（超时连子孙一起杀：node --test 会再拉子进程）。 */
function runTree(command, options) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: true,
        detached: !IS_WINDOWS,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: -1, stdout: '', stderr: String(error && error.message), durationMs: 0, timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    if (options.timeoutMs > 0) {
      timer = setTimeout(async () => {
        timedOut = true;
        if (IS_WINDOWS) await runCommandString(`taskkill /pid ${child.pid} /T /F`, { timeoutMs: 30_000 });
        else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
        }
      }, options.timeoutMs);
    }
    child.on('error', (error) => { stderr += `\n[spawn error] ${error.message}`; });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? -2 : (code === null ? -1 : code),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

async function executeCheck(check, ctx) {
  const artifactDir = path.join(ctx.reportDir, 'artifacts');
  ensureDir(artifactDir);
  const logFile = path.join(artifactDir, `${check.id}.log`);
  const started = Date.now();
  const base = {
    id: check.id,
    title: check.title,
    stage: check.stage,
    type: check.type,
    required: check.required,
    allow_failure: Boolean(check.allow_failure),
    tags: check.tags || [],
    owner: check.owner,
    docs: check.docs,
    description: check.description || '',
  };
  if (!check.enabled) {
    fs.writeFileSync(logFile, `检查项 ${check.id} 未启用（enabled: false）。${check.enabled_reason || ''}\n`, 'utf8');
    return {
      ...base, status: 'disabled', duration_ms: 0, metrics: {}, threshold_results: [], note: check.enabled_reason || '', log: logFile,
    };
  }
  const resolved = resolveCommand(check, ctx.varsFor(check));
  if (resolved.unsupported) {
    fs.writeFileSync(logFile, `平台 ${PLATFORM} 不支持：${resolved.reason}\n`, 'utf8');
    return {
      ...base,
      status: 'unsupported',
      duration_ms: 0,
      metrics: { skip_reason: resolved.reason },
      threshold_results: [],
      note: `平台 ${PLATFORM} 不支持（配置显式声明）：${resolved.reason}`,
      log: logFile,
    };
  }
  const missing = await missingRequirements(check, ctx);
  if (missing.length) {
    // 前提缺失的终态：required 检查项默认阻塞门禁（block），可选检查项默认跳过（skip）。
    const onMissing = check.on_missing || (check.required ? 'block' : 'skip');
    const detail = missing.map((m) => `${m.req.kind}:${m.req.name || m.req.env || m.req.path || m.req.id} -> ${m.detail}`).join('; ');
    const nextSteps = missing
      .map((m) => [m.req.manual, ...(m.req.install || []).map((s) => s.command || s.windows_command).filter(Boolean)].filter(Boolean).join(' && '))
      .filter(Boolean);
    fs.writeFileSync(logFile, `前提缺失（on_missing=${onMissing}）：\n${detail}\n${nextSteps.length ? `手动命令：\n${nextSteps.join('\n')}\n` : ''}`, 'utf8');
    const status = onMissing === 'fail' ? 'failed' : (onMissing === 'block' ? 'blocked' : 'skipped');
    return {
      ...base,
      status,
      on_missing: onMissing,
      explicit_skip: Boolean(check.on_missing),
      duration_ms: 0,
      metrics: { skip_reason: detail, prerequisites_missing: missing.length },
      threshold_results: [],
      note: detail,
      next_steps: nextSteps,
      log: logFile,
    };
  }
  const env = { ...(ctx.config.defaults?.env || {}) };
  for (const [key, value] of Object.entries(check.env || {})) env[key] = substitute(String(value), ctx.varsFor(check));
  const timeoutMs = Number(check.timeout || ctx.config.defaults?.timeout || 1800) * 1000;
  log(`→ [${check.stage}] ${check.id}：${check.title}`);
  const result = await runTree(resolved.command, { cwd: resolved.cwd, env, timeoutMs });
  const duration = Date.now() - started;
  fs.writeFileSync(
    logFile,
    `# 检查项：${check.id}（${check.title}）\n# 命令：${resolved.command}\n# cwd：${resolved.cwd}\n# 退出码：${result.code}${result.timedOut ? '（超时被杀）' : ''}\n# 耗时：${duration}ms\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
    'utf8',
  );
  const metrics = parseMetrics(result.stdout);
  const thresholdResults = evaluateThreshold(check, metrics);
  let status;
  if (result.timedOut) status = 'timeout';
  else if (result.code === EXIT.SKIP) status = 'skipped';
  else if (result.code === EXIT.PASS) status = 'passed';
  else if (result.code === EXIT.FAIL) status = 'failed';
  else status = 'error';
  if (status === 'passed' && thresholdResults.filter((t) => !t.ok && !t.optional).length) status = 'failed';
  return {
    ...base,
    status,
    // 退出码 3 = 脚本自己声明"跳过"（例如变异测试没有可变异目标）：把配置里的 on_missing 带出来，
    // 门禁才能按 check.yaml 的声明判定（否则 required 项被脚本跳过会一律算失败）。
    on_missing: check.on_missing,
    duration_ms: duration,
    exit_code: result.code,
    metrics,
    threshold_results: thresholdResults,
    command: resolved.command,
    cwd: resolved.cwd,
    note: metrics.skip_reason || '',
    next_steps: [],
    log: logFile,
  };
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

function summarizeMetrics(metrics) {
  const keys = Object.keys(metrics || {}).filter((k) => !['skip_reason', 'metrics_parse_error'].includes(k));
  return keys.slice(0, 6).map((k) => `${k}=${metrics[k]}`).join(', ');
}

export function thresholdDetail(check) {
  const bad = (check.threshold_results || []).filter((t) => !t.ok && !t.optional);
  if (!bad.length) return '';
  return bad.map((t) => {
    const bound = [];
    if (t.min !== undefined) bound.push(`>=${t.min}`);
    if (t.max !== undefined) bound.push(`<=${t.max}`);
    return `${t.label}${t.missing ? ' 缺失' : `=${t.value}`}（要求 ${bound.join(' 且 ')}）`;
  }).join('；');
}

export function buildGate(config, checks, options = {}) {
  const failures = [];
  const warnings = [];
  const counts = {};
  for (const check of checks) counts[check.status] = (counts[check.status] || 0) + 1;
  for (const check of checks) {
    if (check.status === 'unsupported') {
      // 平台不支持 = 配置里显式声明的决定（不是"跳过"更不是失败）
      warnings.push({ id: check.id, status: 'unsupported', reason: check.note || '' });
      continue;
    }
    if (check.status === 'disabled') {
      // 未启用是配置里显式声明的决定（必须写 enabled_reason + 文档写启用步骤），记警告。
      // 防"把检查项全关掉"的兜底是 gate.min_enabled_checks / max_disabled_checks，
      // 以及 repo-contracts 对 enabled_reason 与文档的校验。
      warnings.push({ id: check.id, status: 'disabled', reason: check.note || '未启用' });
      continue;
    }
    if (check.status === 'skipped' || check.status === 'blocked') {
      const entry = { id: check.id, status: check.status, note: check.note || '' };
      // 显式写了 on_missing: skip = 有意接受前提缺失，只记警告；其余 required 情形算失败
      if (check.required && check.on_missing !== 'skip') {
        failures.push({ ...entry, reason: `required 检查项处于 ${check.status}：${check.note || ''}` });
      } else {
        warnings.push({ ...entry, reason: check.note || '' });
      }
      continue;
    }
    if (['failed', 'error', 'timeout'].includes(check.status)) {
      const entry = {
        id: check.id, status: check.status, note: check.note || '', detail: thresholdDetail(check),
      };
      if (check.allow_failure && config.gate.allow_failure_downgrades !== false) {
        warnings.push({ ...entry, reason: 'allow_failure 已降级为警告' });
      } else if (config.gate.fail_on.includes(check.status)) {
        failures.push(entry);
      } else {
        warnings.push(entry);
      }
    }
  }
  const unexecutedRequired = options.unexecutedRequired || 0;
  if (unexecutedRequired > 0 && !options.allowPartial) {
    failures.push({
      id: '<gate>',
      status: 'blocked',
      reason: `${unexecutedRequired} 个 required 检查项本轮未执行（被 --stage/--only/--tags 排除）：部分运行不算全绿`,
    });
  }
  // 注意：这两个下限/上限按**配置整体**判定（options.configChecks），不能按本轮执行集合——
  // 否则 `--only X` 这种部分运行会被"启用的检查项只有 1 个"误判为门禁失败。
  const configChecks = options.configChecks || checks;
  const enabledCount = configChecks.filter((c) => c.status !== 'disabled').length;
  const disabledCount = configChecks.filter((c) => c.status === 'disabled').length;
  if (config.gate.min_enabled_checks !== undefined && enabledCount < config.gate.min_enabled_checks) {
    failures.push({
      id: '<gate>', status: 'blocked', reason: `启用的检查项只有 ${enabledCount} 个，少于门禁下限 ${config.gate.min_enabled_checks}`,
    });
  }
  if (config.gate.max_disabled_checks !== undefined && disabledCount > config.gate.max_disabled_checks) {
    failures.push({
      id: '<gate>', status: 'blocked', reason: `未启用的检查项有 ${disabledCount} 个，多于门禁上限 ${config.gate.max_disabled_checks}`,
    });
  }
  return {
    status: failures.length ? 'fail' : 'pass',
    failures,
    warnings,
    counts,
    enabled_checks: enabledCount,
    disabled_checks: disabledCount,
  };
}

function renderMarkdown(run) {
  const lines = [];
  lines.push('# Fairy-DSH 质量报告');
  lines.push('');
  lines.push(`- 生成时间：${run.generated_at}`);
  lines.push(`- 仓库：\`${run.repo}\``);
  lines.push(`- 平台：${run.platform}（Node ${run.node_version}）`);
  if (run.git && run.git.commit) {
    lines.push(`- 提交：\`${run.git.commit}\`（分支 ${run.git.branch}${run.git.dirty ? '，工作树有未提交改动' : ''}）`);
  }
  lines.push(`- 筛选：阶段=${run.selection.stages.join('/') || '全部'}；检查项=${run.selection.only.join('/') || '全部'}；标签=${run.selection.tags.join('/') || '全部'}`);
  lines.push(`- 门禁：**${run.gate.status === 'pass' ? 'PASS（全绿）' : 'FAIL'}**`);
  lines.push('');
  lines.push(`汇总：共 ${run.checks.length} 项 —— ${Object.entries(run.gate.counts).map(([k, v]) => `${statusLabel(k)} ${v}`).join(' / ') || '无'}`);
  lines.push('');
  const byStage = new Map();
  for (const check of run.checks) {
    if (!byStage.has(check.stage)) byStage.set(check.stage, []);
    byStage.get(check.stage).push(check);
  }
  for (const stage of [...run.config.stages].sort((a, b) => a.order - b.order)) {
    const items = byStage.get(stage.id) || [];
    if (!items.length) continue;
    lines.push(`## 阶段 ${stage.id} — ${stage.title}`);
    lines.push('');
    lines.push('| 检查项 | 状态 | 耗时 | 关键指标 | 阈值判定 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const check of items) {
      const threshold = (check.threshold_results || []).length
        ? (check.threshold_results.every((t) => t.ok) ? '全部满足' : `未满足：${thresholdDetail(check)}`)
        : '—';
      lines.push(`| \`${check.id}\` ${check.title} | ${statusLabel(check.status)} | ${(check.duration_ms / 1000).toFixed(1)}s | ${summarizeMetrics(check.metrics) || '—'} | ${threshold} |`);
    }
    lines.push('');
  }
  if (run.gate.failures.length) {
    lines.push('## 门禁失败');
    lines.push('');
    for (const failure of run.gate.failures) {
      lines.push(`- \`${failure.id}\`（${statusLabel(failure.status)}）：${failure.reason || failure.detail || failure.note || '见日志'}`);
    }
    lines.push('');
  }
  if (run.gate.warnings.length) {
    lines.push('## 警告（不阻断门禁）');
    lines.push('');
    for (const warning of run.gate.warnings) {
      lines.push(`- \`${warning.id}\`（${statusLabel(warning.status)}）：${warning.reason || warning.detail || ''}`);
    }
    lines.push('');
  }
  const skipped = run.checks.filter((c) => ['skipped', 'blocked'].includes(c.status));
  if (skipped.length) {
    lines.push('## 跳过 / 阻塞项与前提');
    lines.push('');
    for (const check of skipped) {
      lines.push(`- \`${check.id}\`：${check.note || '前提缺失'}`);
      for (const step of check.next_steps || []) lines.push(`  - 手动命令：\`${step}\``);
    }
    lines.push('');
  }
  const disabled = run.checks.filter((c) => c.status === 'disabled');
  if (disabled.length) {
    lines.push('## 未启用的检查项');
    lines.push('');
    for (const check of disabled) lines.push(`- \`${check.id}\` ${check.title}：${check.note || '未启用'}（启用步骤见 ${check.docs}）`);
    lines.push('');
  }
  lines.push('## 明细与复现');
  lines.push('');
  lines.push('- 每项检查的完整 stdout/stderr 与真实退出码：`reports/artifacts/<id>.log`');
  lines.push('- 本轮机器可读结果：`reports/quality-report.json`；历史追加：`reports/verify.log`');
  lines.push('- 安装依赖的生成脚本：`scripts/install.ps1` / `scripts/install.sh`（由 `--generate-install` 从检查项的 requires 生成）');
  lines.push('- 新增检查项见 `docs/EXTENDING.md`（模板 + 自动发现，无需改主入口）');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function appendVerifyLog(ctx, run) {
  const lines = [];
  lines.push(`[${run.generated_at}] run status=${run.gate.status} platform=${run.platform} node=${run.node_version} checks=${run.checks.length}`);
  lines.push(`  selection stages=${run.selection.stages.join(',') || '*'} only=${run.selection.only.join(',') || '*'}`);
  for (const check of run.checks) {
    lines.push(`  - ${check.status.padEnd(8)} ${check.id.padEnd(18)} ${(check.duration_ms / 1000).toFixed(1)}s ${summarizeMetrics(check.metrics)}`);
  }
  for (const failure of run.gate.failures) lines.push(`  ! FAIL ${failure.id}: ${failure.reason || failure.detail || failure.note || ''}`);
  fs.appendFileSync(ctx.logPath, `${lines.join('\n')}\n`, 'utf8');
}

async function gitInfo(repo) {
  const commit = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo });
  if (commit.code !== 0) return null;
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
  const dirty = await run('git', ['status', '--porcelain'], { cwd: repo });
  return {
    commit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    dirty: dirty.stdout.trim().length > 0,
  };
}

/**
 * 读配置 + 发现检查项 + 校验（不给任何具体检查项编码）。
 * 既是 CLI 的第一步，也是 lib 形态的入口——features/steps 直接调用它来断言"自动发现"行为。
 */
export function loadProject({ repo, configPath, checksDir, pattern }) {
  const resolvedRepo = path.resolve(repo || DEFAULT_REPO);
  const resolvedConfigPath = findConfig(resolvedRepo, configPath);
  const config = loadConfig(resolvedConfigPath ? resolvedRepo : resolvedRepo, resolvedConfigPath);
  const schema = loadSchema(resolvedRepo);
  const discovered = discoverChecks(config, resolvedRepo, { checksDir, pattern });
  const checks = [];
  const configErrors = [];
  for (const file of discovered.files) {
    let parsed;
    try {
      parsed = parseYaml(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (error) {
      configErrors.push(`解析失败 ${path.basename(file)}：${error.message}`);
      continue;
    }
    const errors = validateCheck(parsed, { file, config, repo: resolvedRepo, schema });
    if (errors.length) configErrors.push(`${path.basename(file)}：${errors.join('；')}`);
    else checks.push({ ...parsed, file });
  }
  const duplicates = checks.map((c) => c.id).filter((id, i, arr) => arr.indexOf(id) !== i);
  if (duplicates.length) configErrors.push(`检查项 id 重复：${[...new Set(duplicates)].join(', ')}`);
  return {
    repo: resolvedRepo, config, configPath: resolvedConfigPath, checks, configErrors, checksDir: discovered.checksDir,
  };
}

/** 过滤：阶段 / 检查项 id / 标签。 */
export function selectChecks(checks, { stage, only, tags } = {}) {
  const stageFilter = stage ? String(stage).split(',').map((s) => s.trim()) : null;
  const onlyFilter = only ? String(only).split(',').map((s) => s.trim()) : null;
  const tagFilter = tags ? String(tags).split(',').map((s) => s.trim()) : null;
  return checks.filter((check) => {
    if (stageFilter && !stageFilter.includes(check.stage)) return false;
    if (onlyFilter && !onlyFilter.includes(check.id)) return false;
    if (tagFilter && !(check.tags || []).some((tag) => tagFilter.includes(tag))) return false;
    return true;
  });
}

/** 按阶段执行选中的检查项并汇总（不写报告、不退出，供 lib 与 CLI 共用）。 */
export async function executeSelection({
  repo, config, configPath, reportDir, selected, failFast = false, quiet = false,
}) {
  ensureDir(reportDir);
  ensureDir(path.join(reportDir, 'artifacts'));
  const write = quiet ? () => {} : log;
  const ctx = {
    repo,
    config,
    configPath,
    reportDir,
    results: new Map(),
    varsFor(check) { return buildVars(ctx, check); },
    logPath: path.join(reportDir, config.report.log),
  };
  const results = [];
  for (const stage of [...config.stages].sort((a, b) => a.order - b.order)) {
    const stageChecks = selected.filter((c) => c.stage === stage.id);
    if (!stageChecks.length) continue;
    write(`\n== 阶段 ${stage.id} — ${stage.title}（${stageChecks.length} 项）==`);
    const stageResults = await runPool(stageChecks, stage.concurrency || 1, async (check) => {
      const result = await executeCheck(check, ctx);
      ctx.results.set(check.id, result);
      const mark = result.status === 'passed' ? '✔' : (['disabled', 'skipped'].includes(result.status) ? '·' : '✖');
      write(`   ${mark} ${check.id} — ${statusLabel(result.status)}（${(result.duration_ms / 1000).toFixed(1)}s）${summarizeMetrics(result.metrics) ? ` ${summarizeMetrics(result.metrics)}` : ''}`);
      if (['failed', 'error', 'timeout'].includes(result.status)) {
        const detail = thresholdDetail(result);
        if (detail) write(`      阈值未满足：${detail}`);
        write(`      详情：${result.log}`);
      }
      if (result.status === 'blocked' || result.status === 'skipped') write(`      原因：${result.note}`);
      return result;
    });
    results.push(...stageResults);
    if (failFast && stageResults.some((r) => ['failed', 'error', 'timeout', 'blocked'].includes(r.status))) break;
  }
  return { ctx, results };
}

/** 组装报告对象并落盘（markdown + json + verify.log 追加）。 */
export function writeRunReport({
  repo, config, configPath, reportDir, selectedResults, notRun, selection, gate, startedAt, git = null,
}) {
  const run = {
    schema_version: config.schema_version,
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    repo,
    platform: PLATFORM,
    node_version: process.version,
    config_path: configPath,
    config: {
      stages: config.stages.map((s) => ({ id: s.id, title: s.title, order: s.order })),
      gate: config.gate,
      checks_dir: config.discovery.checks_dir,
    },
    git,
    selection,
    checks: [...selectedResults, ...notRun],
    executed: selectedResults.length,
    gate,
  };
  const jsonPath = path.join(reportDir, config.report.json);
  const mdPath = path.join(reportDir, config.report.markdown);
  const logPath = path.join(reportDir, config.report.log);
  writeJson(jsonPath, run);
  fs.writeFileSync(mdPath, renderMarkdown(run), 'utf8');
  appendVerifyLog({ logPath }, run);
  return { run, jsonPath, mdPath, logPath };
}

/**
 * CLI 主流程：解析参数 → loadProject → 过滤 → 执行 → 报告 → 退出码。
 * 所有行为都能通过 loadProject/selectChecks/executeSelection/writeRunReport 在进程内复现
 * （features/steps 就是这么断言"自动发现 + 真实执行"的，不必再起一次子进程）。
 */
async function main() {
  const args = parseCli();
  const project = loadProject({
    repo: args.repo || DEFAULT_REPO,
    configPath: args.config,
    checksDir: args['checks-dir'],
    pattern: args.pattern,
  });
  const {
    repo, config, configPath, checks, configErrors,
  } = project;
  if (configErrors.length) {
    log('质量配置有错误，未执行任何检查：');
    for (const error of configErrors) log(`  - ${error}`);
    process.exit(EXIT.ERROR);
  }
  const reportDir = path.resolve(repo, args['report-dir'] || config.report.dir);
  const selectionArgs = { stage: args.stage, only: args.only, tags: args.tags };
  const selected = selectChecks(checks, selectionArgs);

  if (args['generate-install']) {
    const written = generateInstallScripts({ repo, config, checks });
    for (const file of written) log(`已生成安装脚本：${file}`);
    process.exit(EXIT.PASS);
  }

  if (args.list) {
    log(`配置：${configPath}`);
    log(`发现 ${checks.length} 个检查项（目录 ${config.discovery.checks_dir}）：`);
    for (const stage of [...config.stages].sort((a, b) => a.order - b.order)) {
      const items = checks.filter((c) => c.stage === stage.id);
      if (!items.length) continue;
      log(`  [${stage.id}] ${stage.title}`);
      for (const check of items) {
        const state = check.enabled ? (check.required ? 'required' : 'optional') : 'disabled';
        log(`    - ${check.id.padEnd(20)} ${state.padEnd(9)} ${check.title}`);
      }
    }
    process.exit(EXIT.PASS);
  }

  if (args['dry-run']) {
    const dryCtx = { repo, config, configPath, reportDir, varsFor(check) { return buildVars(dryCtx, check); } };
    for (const check of selected) {
      const resolved = resolveCommand(check, dryCtx.varsFor(check));
      log(`[${check.stage}] ${check.id}${check.enabled ? '' : '（未启用，不会执行）'}${check.required ? '（required）' : ''}`);
      log(`  cwd: ${resolved.cwd || ''}`);
      log(`  cmd: ${resolved.command || `平台不支持：${resolved.reason}`}`);
    }
    process.exit(EXIT.PASS);
  }

  const startedAt = new Date().toISOString();
  log(`Fairy-DSH 质量体系：配置 ${configPath}`);
  log(`平台 ${PLATFORM} / Node ${process.version} / 仓库 ${repo}`);
  const { ctx, results } = await executeSelection({
    repo,
    config,
    configPath,
    reportDir,
    selected,
    failFast: Boolean(args['fail-fast']),
  });

  const executed = new Set(results.map((c) => c.id));
  const notRun = checks.filter((c) => !executed.has(c.id)).map((c) => skippedStub(c));
  const unexecutedRequired = notRun.filter((c) => c.required && c.status !== 'disabled' && !c.allow_failure).length;
  // 显式筛选（--stage/--only/--tags）视为"部分运行"：未执行的 required 项记警告并在报告里列出；
  // 加 --strict-partial 可以让部分运行也判失败。
  const allowPartial = (!args['strict-partial'] && Boolean(args.only || args.stage || args.tags)) || Boolean(args['allow-partial']);
  const gate = buildGate(config, results, {
    unexecutedRequired,
    allowPartial,
    configChecks: checks.map((c) => ({ id: c.id, status: c.enabled ? 'skipped' : 'disabled', required: c.required, note: c.enabled ? '' : (c.enabled_reason || '未启用') })),
  });
  if (allowPartial) {
    for (const stub of notRun.filter((c) => c.required && c.status !== 'disabled')) {
      gate.warnings.push({
        id: stub.id,
        status: stub.status,
        reason: `${stub.note}：required 检查项本轮未执行（--stage/--only/--tags 筛选），本轮的 PASS 只覆盖已执行的项`,
      });
    }
  }
  const { run, jsonPath, mdPath, logPath } = writeRunReport({
    repo,
    config,
    configPath,
    reportDir,
    selectedResults: results,
    notRun,
    selection: {
      stages: args.stage ? String(args.stage).split(',').map((s) => s.trim()) : [],
      only: args.only ? String(args.only).split(',').map((s) => s.trim()) : [],
      tags: args.tags ? String(args.tags).split(',').map((s) => s.trim()) : [],
    },
    gate,
    startedAt,
    git: await gitInfo(repo),
  });
  void ctx;
  void run;

  log(`\n== 门禁：${gate.status === 'pass' ? 'PASS' : 'FAIL'} ==`);
  log(`报告：${mdPath}`);
  log(`JSON：${jsonPath}`);
  log(`日志：${logPath}（历史追加）`);
  if (gate.failures.length) {
    log('失败项：');
    for (const failure of gate.failures) log(`  - ${failure.id}：${failure.reason || failure.detail || failure.note || ''}`);
  }
  process.exit(gate.status === 'pass' ? EXIT.PASS : EXIT.FAIL);
}

/** 本轮没被选中的检查项（也进报告，状态按 enabled 区分）。 */
export function skippedStub(check) {
  return {
    id: check.id,
    title: check.title,
    stage: check.stage,
    type: check.type,
    required: check.required,
    allow_failure: Boolean(check.allow_failure),
    tags: check.tags || [],
    owner: check.owner,
    docs: check.docs,
    status: check.enabled ? 'skipped' : 'disabled',
    duration_ms: 0,
    metrics: { skip_reason: check.enabled ? '被 --stage/--only/--tags 筛选排除' : 'enabled: false' },
    threshold_results: [],
    note: check.enabled ? '本轮筛选未执行' : (check.enabled_reason || '未启用'),
    next_steps: [],
    log: null,
  };
}

const IS_DIRECT_RUN = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
})();

if (IS_DIRECT_RUN) {
  main().catch((error) => {
    log(`质量体系主入口内部错误：${error && error.stack ? error.stack : error}`);
    process.exit(EXIT.ERROR);
  });
}
