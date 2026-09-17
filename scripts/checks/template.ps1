# 检查脚本模板（PowerShell 版）。复制到 scripts/checks/<id>.ps1 后实现真实检查。
#
# 契约与 .mjs 版一致：参数 --check/--repo/--report-dir/--artifact，
# 末行输出 `<<<QUALITY-METRICS>>> {json}`，退出码 0/1/2/3。
# 本文件必须 UTF-8 with BOM + CRLF（PS 5.1 的编码要求，见 AGENTS.md 第 6 节）。
#
# 注意：Windows 上禁用 sudo、不用 export/chmod/symlink；路径一律 Join-Path。
param(
  [string]$Check = '',
  [string]$Repo = '.',
  [string]$ReportDir = '',
  [string]$Artifact = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -Path $Repo).Path
if (-not $ReportDir) { $ReportDir = Join-Path $RepoRoot 'reports' }
if (-not $Artifact) { $Artifact = Join-Path (Join-Path $ReportDir 'artifacts') 'check.json' }
$ArtifactDir = Split-Path -Parent $Artifact
if (-not (Test-Path $ArtifactDir)) { New-Item -ItemType Directory -Path $ArtifactDir | Out-Null }

# TODO: 替换成真实检查
$result = [ordered]@{ generated_at = (Get-Date).ToUniversalTime().ToString('o'); repo = $RepoRoot; errors = @() }
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $Artifact -Encoding UTF8

Write-Host "template.ps1：未实现真实检查（这是模板）"
Write-Host '<<<QUALITY-METRICS>>> {"errors":0}'
exit 0
