@echo off
rem ============================================================
rem  Open the GCORES local control panel.
rem
rem  Double-click this file (or run it from a terminal). It starts
rem  a tiny local web server on 127.0.0.1 and opens your default
rem  browser at the panel. Closing that console window stops it.
rem
rem  Keep this file ASCII-only: cmd.exe reads .cmd as the OEM code
rem  page, so non-ASCII text here would be garbled.
rem ============================================================
setlocal
chcp 65001 >nul 2>&1
title GCORES control panel (close this window to stop)

call "%~dp0gc.cmd" ui
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [gc] The panel exited with code %CODE%.
  pause
)
endlocal
