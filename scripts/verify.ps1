# Fairy-DSH 质量体系入口（Windows PowerShell 包装）。
#
# 为什么是 .ps1 + .cmd 两份：PS 5.1 会把 .ps1 交给 AMSI 扫描，某些 Defender 组合会让脚本在
# 编译阶段崩（AccessViolationException），此时用 verify.cmd 绕开；反过来 .cmd 的中文注释会
# 被控制台码页吞掉，所以 .cmd 里不写中文。
#
# 本文件必须：UTF-8 with BOM + CRLF（无 BOM 时 PS 5.1 按 ANSI 解码，中文注释会吞掉后续代码）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Stage static
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -Args '--only','unit','--allow-partial'
param(
  [string]$Stage = '',
  [string]$Only = '',
  [string]$Tags = '',
  [switch]$List,
  [switch]$DryRun,
  [switch]$GenerateInstall,
  [string[]]$Args = @()
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$Verify = Join-Path $ScriptDir 'verify.mjs'

if (-not (Test-Path $Verify)) {
  Write-Host "找不到主入口：$Verify"
  exit 2
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '找不到 node：请先安装 Node.js 22+（手动命令见 docs/QUALITY.md；winget 需要 --scope user）'
  exit 2
}

$forward = New-Object System.Collections.Generic.List[string]
$forward.Add($Verify) | Out-Null
$forward.Add('--repo') | Out-Null
$forward.Add($RepoRoot) | Out-Null
if ($Stage) { $forward.Add('--stage'); $forward.Add($Stage) }
if ($Only) { $forward.Add('--only'); $forward.Add($Only) }
if ($Tags) { $forward.Add('--tags'); $forward.Add($Tags) }
if ($List) { $forward.Add('--list') }
if ($DryRun) { $forward.Add('--dry-run') }
if ($GenerateInstall) { $forward.Add('--generate-install') }
foreach ($extra in $Args) { $forward.Add($extra) }

Write-Host "运行质量门禁：node $Verified" -ErrorAction SilentlyContinue | Out-Null
& $node.Source @forward
exit $LASTEXITCODE
