# 由 scripts/verify.mjs --generate-install 依据 .agent/checks/*.yaml 的 requires/install 生成；请勿手改，改配置后重新生成。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [--dry-run]
# 约定：只用 Join-Path / $env: / Test-Path；winget 一律 --scope user；永不提权，不做 sudo。
param([switch]$DryRun = $false)
$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $RepoRoot 'reports'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir 'install.log'
function Write-Log {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}
function Test-Tool {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}
function Invoke-Step {
  param([string]$Command)
  if ($DryRun) { Write-Log "dry-run：$Command"; return }
  Write-Log "执行：$Command"
  try {
    $output = & $env:ComSpec /d /s /c $Command 2>&1
    if ($output) { Add-Content -Path $LogFile -Value $output }
    if ($LASTEXITCODE -ne 0) { Write-Log "失败（继续）：$Command（退出码 $LASTEXITCODE）" }
  } catch { Write-Log "异常（继续）：$Command —— $_" }
}
Write-Log '== Fairy-DSH 质量体系安装脚本（Windows PowerShell）=='

# ---- [1/4] tool:node —— 质量体系的检查脚本全部用 Node 内建能力（CI 固定 Node 22）
# 使用方检查项：coverage, e2e, format, gherkin, integration, lint, mutation, repo-contracts, secret-scan, typecheck, unit
# 探测：node --version
if (Test-Tool 'node') {
  Write-Log 'tool:node 已就绪，跳过'
} else {
  if (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install nodejs-lts'
  } else {
    Write-Log '无法自动安装 tool:node：没有可用的安装器'
  }
}
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 手动命令：手动安装 Node 22+（nodejs.org 安装包，或 winget install OpenJS.NodeJS.LTS --scope user）

# ---- [2/4] tool:pnpm —— 各包自带 lockfile，依赖必须用 pnpm 逐包安装（AGENTS.md §1.1）
# 使用方检查项：coverage, unit
# 探测：pnpm --version
if (Test-Tool 'pnpm') {
  Write-Log 'tool:pnpm 已就绪，跳过'
} else {
  if (Test-Tool 'winget') {
    Invoke-Step 'winget install --id pnpm.pnpm --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id pnpm.pnpm --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install pnpm'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install pnpm'
  } else {
    Write-Log '无法自动安装 tool:pnpm：没有可用的安装器'
  }
}
# 手动命令：手动启用 pnpm：corepack enable pnpm（Node 自带 corepack）或 npm install -g pnpm

# ---- [3/4] tool:package-deps —— 各包通过 link: 依赖 dsh-fairy-contracts，必须先逐包安装依赖（否则 ERR_MODULE_NOT_FOUND）
# 使用方检查项：coverage, mutation, unit
# 探测：node "${repo}/scripts/checks/lib/deps-probe.mjs" --repo "${repo}"
if (Test-Tool 'package-deps') {
  Write-Log 'tool:package-deps 已就绪，跳过'
} else {
  if ($true) {
    Invoke-Step 'Set-Location (Join-Path $RepoRoot ''.'') ; node "scripts/checks/lib/deps-install.mjs" --repo .'
  elseif ($true) {
    Invoke-Step 'Set-Location (Join-Path $RepoRoot ''.'') ; node "scripts/checks/lib/deps-install.mjs" --repo .'
  elseif ($true) {
    Invoke-Step 'Set-Location (Join-Path $RepoRoot ''.'') ; node "scripts/checks/lib/deps-install.mjs" --repo .'
  } else {
    Write-Log '无法自动安装 tool:package-deps：没有可用的安装器'
  }
}
# 手动命令：node scripts/checks/lib/deps-install.mjs --repo .

# ---- [4/4] tool:git —— 检查脚本用 git ls-files / git diff 判定跟踪文件与变更行（只读）
# 使用方检查项：format, gherkin, integration, lint, mutation, repo-contracts, secret-scan
# 探测：git --version
if (Test-Tool 'git') {
  Write-Log 'tool:git 已就绪，跳过'
} else {
  if (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'winget') {
    Invoke-Step 'winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  elseif (Test-Tool 'scoop') {
    Invoke-Step 'scoop install git'
  } else {
    Write-Log '无法自动安装 tool:git：没有可用的安装器'
  }
}
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 手动命令：手动安装 Git（git-scm.com，或 winget install Git.Git --scope user）

Write-Log '== 安装脚本结束：需要人工确认的步骤见上方注释与 docs/QUALITY.md =='
exit 0
