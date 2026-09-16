@echo off
rem Fairy-DSH one-click install/deploy (Windows). Logic lives in scripts/install.mjs
rem (same file on every platform). Double-click to run, or pass flags:
rem   install.cmd --home D:\dsh --from-worktree
rem ASCII only on purpose: echo-ing non-ASCII here breaks under some console code pages.
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
where node >nul 2>nul
if errorlevel 1 (
  echo [install] Node.js 22+ is required: https://nodejs.org 1>&2
  pause
  exit /b 1
)
node "%HERE%\scripts\install.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [install] FAILED with exit code %CODE%. See the messages above.
  pause
) else if "%~1"=="" (
  rem Double-click path: keep the window open so the summary is readable.
  pause
)
exit /b %CODE%
