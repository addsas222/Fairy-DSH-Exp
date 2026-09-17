// 安装脚本生成器：从检查项的 requires/install 字段生成 scripts/install.ps1 与 scripts/install.sh。
//
// 规则（B.md / AGENTS.md §5 硬约束落到代码上）：
//   - 优先级：项目本地依赖(local) > winget --scope user > scoop > choco（choco 只写文档）
//   - winget 一律带 --accept-source-agreements --accept-package-agreements --scope user
//   - 永不提权：admin: true 或 choco 的步骤只写进注释与手动命令文档，不执行
//   - Windows：用 Join-Path / $env: / Test-Path，不用 sudo；POSIX：sh + 不用 export/chmod/grep/sed/awk
//   - 所有尝试都写 reports/install.log；不确定的一律不执行
// 主入口 --generate-install 调用本模块；生成的脚本头部标注"勿手改，改 requires 后重新生成"。

import fs from 'node:fs';
import path from 'node:path';

const GENERATED_NOTICE = '由 scripts/verify.mjs --generate-install 依据 .agent/checks/*.yaml 的 requires/install 生成；请勿手改，改配置后重新生成。';

function collectRequirements(checks, config) {
  const entries = new Map();
  for (const check of checks) {
    for (const req of check.requires || []) {
      const key = `${req.kind}:${req.name || req.env || req.path || req.id || ''}`;
      if (!entries.has(key)) {
        entries.set(key, {
          key, req, checks: [], steps: [], manual: req.manual || '',
        });
      }
      const entry = entries.get(key);
      if (!entry.checks.includes(check.id)) entry.checks.push(check.id);
      // 同一条 require 由多个检查项声明（11 个检查项的 node/pnpm/git 安装矩阵逐字相同），
      // 步骤按 (strategy, command) 去重，只保留首个 —— 重复步骤只会生成重复分支，行为完全相同。
      const addStep = (step) => {
        if (!entry.steps.some((s) => s.command === step.command && s.strategy === step.strategy)) entry.steps.push(step);
      };
      for (const step of req.install || []) addStep(step);
      // 检查项自带的 install 段（不挂在某条 require 上）也纳入：作为该检查项的前置安装
      for (const step of check.install || []) addStep(step);
    }
  }
  const order = config?.install?.strategy_order || ['local', 'winget', 'scoop', 'choco', 'manual'];
  for (const entry of entries.values()) {
    entry.steps.sort((a, b) => order.indexOf(a.strategy) - order.indexOf(b.strategy));
  }
  return [...entries.values()];
}

function wingetCommand(command, flags) {
  let cmd = command;
  for (const flag of flags) {
    if (!cmd.includes(flag)) cmd += ` ${flag}`;
  }
  return cmd;
}

function isExecutableStep(step, config) {
  if (step.admin) return false;
  if (step.strategy === 'choco') return false;
  if (step.strategy === 'manual') return false;
  if (config?.install?.never_elevate === false) return true;
  return ['local', 'winget', 'scoop'].includes(step.strategy);
}

function decorate(step, config) {
  const flags = config?.install?.winget_flags || [];
  const command = step.strategy === 'winget' && step.command ? wingetCommand(step.command, flags) : step.command;
  return { ...step, effectiveCommand: command };
}

function renderSh(entries, config) {
  const lines = [];
  lines.push('#!/bin/sh');
  lines.push(`# ${GENERATED_NOTICE}`);
  lines.push('#');
  lines.push('# 用法：sh scripts/install.sh [--dry-run]');
  lines.push('# 约定：只做项目本地依赖与免提权安装；需要提权的步骤只打印手动命令（永不 sudo）。');
  lines.push('set -u');
  lines.push('DRY_RUN=0');
  lines.push('for arg in "$@"; do');
  lines.push('  case "$arg" in');
  lines.push('    --dry-run) DRY_RUN=1 ;;');
  lines.push('    *) printf \'未知参数：%s\\n\' "$arg" ;;');
  lines.push('  esac');
  lines.push('done');
  lines.push('SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)');
  lines.push('REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)');
  lines.push('LOG_DIR="$REPO_ROOT/reports"');
  lines.push('LOG_FILE="$LOG_DIR/install.log"');
  lines.push('mkdir -p "$LOG_DIR"');
  lines.push('log() {');
  lines.push('  printf \'%s %s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG_FILE"');
  lines.push('}');
  lines.push('have() { command -v "$1" >/dev/null 2>&1; }');
  lines.push('run() {');
  lines.push('  if [ "$DRY_RUN" = "1" ]; then log "dry-run：$1"; return 0; fi');
  lines.push('  log "执行：$1"');
  lines.push('  sh -c "$1" >>"$LOG_FILE" 2>&1 || log "失败（继续）：$1"');
  lines.push('}');
  lines.push('log "== Fairy-DSH 质量体系安装脚本（POSIX sh）=="');
  entries.forEach((entry, index) => {
    const { req } = entry;
    const label = `${req.kind}:${req.name || req.env || req.path || req.id || ''}`;
    lines.push('');
    lines.push(`# ---- [${index + 1}/${entries.length}] ${label} —— ${req.reason || ''}`);
    if (entry.checks.length) lines.push(`# 使用方检查项：${entry.checks.join(', ')}`);
    const executable = entry.steps
      .map((s) => decorate(s, config))
      .filter((s) => isExecutableStep(s, config) && s.effectiveCommand);
    const blocked = entry.steps.filter((s) => !isExecutableStep(s, config));
    if (req.probe) lines.push(`# 探测：${req.probe}`);
    if (!executable.length) {
      lines.push('# 无可自动执行的步骤：全部需要人工确认或提权，见 docs/QUALITY.md 与本文件注释。');
    } else {
      lines.push(`if ${req.kind === 'tool' && req.name ? `have ${req.name}` : 'true'}; then`);
      lines.push(`  log "${label} 已就绪，跳过"`);
      lines.push('else');
      executable.forEach((step, i) => {
        lines.push(`  ${i === 0 ? 'if' : 'elif'} ${step.strategy === 'winget' ? 'have winget' : (step.strategy === 'scoop' ? 'have scoop' : 'true')}; then`);
        const command = step.strategy === 'local' ? shLocalCommand(step.effectiveCommand) : step.effectiveCommand;
        lines.push(`    run "${command.replace(/"/g, '\\"')}"`);
      });
      lines.push('  else');
      lines.push(`    log "无法自动安装 ${label}：没有可用的安装器"`);
      lines.push('  fi');
      lines.push('fi');
    }
    for (const step of blocked) {
      lines.push(`# 需人工执行（${step.strategy}${step.admin ? '，需要管理员权限' : ''}）：${step.effectiveCommand || step.command || ''}`);
      if (step.reason) lines.push(`#   原因：${step.reason}`);
    }
    if (entry.manual) lines.push(`# 手动命令：${entry.manual}`);
  });
  lines.push('');
  lines.push('log "== 安装脚本结束：需要人工确认的步骤见上方注释与 docs/QUALITY.md =="');
  lines.push('exit 0');
  return `${lines.join('\n')}\n`;
}

function shLocalCommand(command) {
  // local 策略在仓库根下执行（相对路径依赖解析到 repo 根）
  return `cd "$REPO_ROOT" && ${command}`;
}

function renderPs1(entries, config) {
  const lines = [];
  lines.push('# ' + GENERATED_NOTICE);
  lines.push('#');
  lines.push('# 用法：powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [--dry-run]');
  lines.push('# 约定：只用 Join-Path / $env: / Test-Path；winget 一律 --scope user；永不提权，不做 sudo。');
  lines.push("param([switch]$DryRun = $false)");
  lines.push("$ErrorActionPreference = 'Continue'");
  lines.push('$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path');
  lines.push("$RepoRoot = Split-Path -Parent $ScriptDir");
  lines.push("$LogDir = Join-Path $RepoRoot 'reports'");
  lines.push('if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }');
  lines.push("$LogFile = Join-Path $LogDir 'install.log'");
  lines.push('function Write-Log {');
  lines.push('  param([string]$Message)');
  lines.push("  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message");
  lines.push('  Write-Host $line');
  lines.push('  Add-Content -Path $LogFile -Value $line');
  lines.push('}');
  lines.push('function Test-Tool {');
  lines.push('  param([string]$Name)');
  lines.push('  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)');
  lines.push('}');
  lines.push('function Invoke-Step {');
  lines.push('  param([string]$Command)');
  lines.push('  if ($DryRun) { Write-Log "dry-run：$Command"; return }');
  lines.push('  Write-Log "执行：$Command"');
  lines.push('  try {');
  lines.push('    $output = & $env:ComSpec /d /s /c $Command 2>&1');
  lines.push('    if ($output) { Add-Content -Path $LogFile -Value $output }');
  lines.push('    if ($LASTEXITCODE -ne 0) { Write-Log "失败（继续）：$Command（退出码 $LASTEXITCODE）" }');
  lines.push('  } catch { Write-Log "异常（继续）：$Command —— $_" }');
  lines.push('}');
  lines.push("Write-Log '== Fairy-DSH 质量体系安装脚本（Windows PowerShell）=='");
  entries.forEach((entry, index) => {
    const { req } = entry;
    const label = `${req.kind}:${req.name || req.env || req.path || req.id || ''}`;
    lines.push('');
    lines.push(`# ---- [${index + 1}/${entries.length}] ${label} —— ${req.reason || ''}`);
    if (entry.checks.length) lines.push(`# 使用方检查项：${entry.checks.join(', ')}`);
    if (req.probe) lines.push(`# 探测：${req.probe}`);
    const decorated = entry.steps.map((s) => decorate(s, config));
    const executable = decorated.filter((s) => isExecutableStep(s, config) && s.effectiveCommand);
    const blocked = decorated.filter((s) => !isExecutableStep(s, config));
    if (!executable.length) {
      lines.push('# 无可自动执行的步骤：全部需要人工确认或提权，见 docs/QUALITY.md 与本文件注释。');
    } else {
      const toolName = req.kind === 'tool' && req.name ? req.name : null;
      lines.push(toolName ? `if (Test-Tool '${toolName}') {` : 'if ($true) {');
      if (toolName) lines.push(`  Write-Log '${label} 已就绪，跳过'`);
      lines.push('} else {');
      executable.forEach((step, i) => {
        const condition = step.strategy === 'winget' ? "Test-Tool 'winget'" : (step.strategy === 'scoop' ? "Test-Tool 'scoop'" : '$true');
        lines.push(`  ${i === 0 ? 'if' : 'elseif'} (${condition}) {`);
        const command = step.strategy === 'local'
          ? `Set-Location (Join-Path $RepoRoot '.') ; ${step.effectiveCommand}`
          : step.effectiveCommand;
        lines.push(`    Invoke-Step '${command.replace(/'/g, "''")}'`);
      });
      lines.push('  } else {');
      lines.push(`    Write-Log '无法自动安装 ${label}：没有可用的安装器'`);
      lines.push('  }');
      lines.push('}');
    }
    for (const step of blocked) {
      lines.push(`# 需人工执行（${step.strategy}${step.admin ? '，需要管理员权限' : ''}）：${step.effectiveCommand || step.command || ''}`);
      if (step.reason) lines.push(`#   原因：${step.reason}`);
    }
    if (entry.manual) lines.push(`# 手动命令：${entry.manual}`);
  });
  lines.push('');
  lines.push("Write-Log '== 安装脚本结束：需要人工确认的步骤见上方注释与 docs/QUALITY.md =='");
  lines.push('exit 0');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * 生成 scripts/install.ps1 与 scripts/install.sh。
 * @returns {string[]} 生成的文件路径
 */
export function generateInstallScripts({ repo, config, checks }) {
  const entries = collectRequirements(checks, config);
  const shPath = path.join(repo, 'scripts', 'install.sh');
  const ps1Path = path.join(repo, 'scripts', 'install.ps1');
  // .ps1 必须是 UTF-8 + BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，中文注释会吞掉后面的代码
  fs.writeFileSync(ps1Path, `\uFEFF${renderPs1(entries, config)}`, 'utf8');
  fs.writeFileSync(shPath, renderSh(entries, config), 'utf8');
  return [ps1Path, shPath];
}
