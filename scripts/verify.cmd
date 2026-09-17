@echo off
rem Fairy-DSH quality gate entry (Windows cmd wrapper). ASCII only: the console
rem code page would otherwise swallow the line after any non-ASCII byte.
rem Use this when PowerShell/AMSI blocks scripts/verify.ps1.
rem
rem Usage:  scripts\verify.cmd            (full run)
rem         scripts\verify.cmd --list
rem         scripts\verify.cmd --stage static
setlocal
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "REPO_ROOT=%%~fI"
where node >nul 2>nul
if errorlevel 1 (
  echo [quality] node not found on PATH. Install Node.js 22+ first; see docs\QUALITY.md
  exit /b 2
)
node "%SCRIPT_DIR%\verify.mjs" --repo "%REPO_ROOT%" %*
exit /b %ERRORLEVEL%
