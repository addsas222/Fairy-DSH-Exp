@echo off
rem start-fairy.cmd -- launch the isolated Fairy-DSH instance WITHOUT PowerShell.
rem
rem Why this file exists: PowerShell 5.1 hands every .ps1 to AMSI (Windows Defender)
rem before compiling it. Some Defender/AMSI combinations throw
rem AccessViolationException inside AmsiScanBuffer, so the script never starts --
rem the failure happens at compile time and has nothing to do with the script text.
rem A .cmd does not go through AMSI. Keep this file ASCII-only: cmd reads .cmd as
rem GBK here, and non-ASCII bytes after `rem` break the comment into "commands".
rem
rem Usage:  start-fairy.cmd            -> port 3081
rem         start-fairy.cmd 3099       -> given port
rem
rem Same semantics as the host-side start-fairy.ps1 (DSH_HOME / two REPO_ROOT vars
rem / PROFILE_ROOT / pinned runtime). That .ps1 is generated on the host and is
rem not in this repo; keep the two in step manually when either changes.

setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3081"

set "ISO_HOME=%~dp0"
if "%ISO_HOME:~-1%"=="\" set "ISO_HOME=%ISO_HOME:~0,-1%"

rem This copy lives in the repo for reference. It derives DSH_HOME from its own
rem directory (%~dp0), so it is only correct when placed in the DSH_HOME root.
if not exist "%ISO_HOME%\profiles\web\package.json" (
  echo [start-fairy] this launcher must sit in DSH_HOME (no profiles\web found under %ISO_HOME%) 1>&2
  echo [start-fairy] copy it to your isolated home and run it there. 1>&2
  exit /b 1
)

rem 底座线:默认 0.1.1-rc.2(本仓长期运行的那条)。跑 0.1.5 时用环境变量覆盖:
rem   set DSH_FAIRY_RUNTIME=C:\tmp\dsh-015\node_modules\@deepseek-ai\dsh\lib\bin.js
rem   set DSH_FAIRY_BASE=015
rem DSH_FAIRY_BASE 会被 profiles\web\cordis.patch.yml 里的行条件读走
rem (0.1.5 起底座自带 web-fetch-http 行,0.1.1 只能由本仓挂 ⇒ 不能两边都挂)。
set "RUNTIME=%DSH_FAIRY_RUNTIME%"
if "%RUNTIME%"=="" set "RUNTIME=C:\tmp\dsh-011\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "DSH_FAIRY_BASE=%DSH_FAIRY_BASE%"
if "%DSH_FAIRY_BASE%"=="" set "DSH_FAIRY_BASE=011"
if not exist "%RUNTIME%" (
  echo [start-fairy] missing runtime: %RUNTIME% 1>&2
  echo [start-fairy] 0.1.1-rc.2 默认路径是 C:\tmp\dsh-011\...; 跑 0.1.5 请设 DSH_FAIRY_RUNTIME 与 DSH_FAIRY_BASE=015 1>&2
  exit /b 1
)

set "DSH_HOME=%ISO_HOME%"
set "DSH_FAIRY_REPO_ROOT=%ISO_HOME%"
set "DSH_FAIRY_TEST_HOME=%ISO_HOME%"
set "DSH_FAIRY_PROFILE_ROOT=%ISO_HOME%\profiles\web"

echo Fairy-DSH isolated instance
echo   DSH_HOME : %ISO_HOME%
echo   runtime  : %RUNTIME%  (0.1.1-rc.2)
echo   profile  : web
echo   url      : http://127.0.0.1:%PORT%
echo.

node "%RUNTIME%" --profile web --no-open --port %PORT%
