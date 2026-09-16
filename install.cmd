@echo off
rem Fairy-DSH 一键安装/部署（Windows）。真正的逻辑在 scripts/install.mjs —— 跨平台同一份。
rem 双击即可；带参数时：install.cmd --home D:\dsh --from-worktree
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
where node >nul 2>nul
if errorlevel 1 (
  echo [install] 需要 Node.js ^(22+^)：https://nodejs.org 1>&2
  pause
  exit /b 1
)
node "%HERE%\scripts\install.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [install] 失败，退出码 %CODE%。上面有具体原因。
  pause
)
exit /b %CODE%
