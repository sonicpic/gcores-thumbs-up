@echo off
rem ============================================================
rem  GCORES auto-like launcher.
rem
rem  Pure ASCII on purpose: cmd.exe reads .cmd as the OEM code
rem  page, so non-ASCII text here would be garbled.
rem
rem  Resolves a usable Node.js runtime (preferring stable system
rem  locations over any machine-specific install) and then runs
rem  src\cli.js with whatever arguments were passed in.
rem
rem  Usage:  gc.cmd run --quiet
rem          gc.cmd doctor
rem          gc.cmd ui
rem ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "CLI=%ROOT%\src\cli.js"

if not exist "%CLI%" (
  echo [gc] Cannot find "%CLI%"
  exit /b 2
)

set "PF86=%ProgramFiles(x86)%"
set "NODE_EXE="

if not "%GC_NODE%"=="" if exist "%GC_NODE%" set "NODE_EXE=%GC_NODE%"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%PF86%\nodejs\node.exe" set "NODE_EXE=%PF86%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%P in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
if not defined NODE_EXE if exist "%ROOT%\tools\node-path.txt" (
  set /p REC=<"%ROOT%\tools\node-path.txt"
  if exist "!REC!" set "NODE_EXE=!REC!"
)

if not defined NODE_EXE (
  echo [gc] Node.js 18+ not found.
  echo [gc] Install Node.js, or set GC_NODE to the full path of node.exe.
  exit /b 9009
)

set "GC_LAUNCHER=%NODE_EXE%"
"%NODE_EXE%" "%CLI%" %*
exit /b %ERRORLEVEL%
