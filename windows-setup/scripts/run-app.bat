@echo off
REM This file is copied into the install folder and run by Task Scheduler at logon.
setlocal
set "SCRIPT_DIR=%~dp0"

REM Use bundled Node.js (node-runtime) if present, otherwise fall back to PATH.
set "NODE_EXE=%SCRIPT_DIR%node-runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

REM Check GitHub for an update before starting (skips silently if offline; never blocks startup for long).
if exist "%SCRIPT_DIR%update-check.js" (
  "%NODE_EXE%" "%SCRIPT_DIR%update-check.js" >> "%SCRIPT_DIR%update-check.log" 2>&1
)

start "room-manager-server" /min "%NODE_EXE%" "%SCRIPT_DIR%server.js"

REM Wait for the server to come up.
timeout /t 3 /nobreak >nul

REM Look for Chrome and launch in kiosk mode; otherwise open the default browser.
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --kiosk --kiosk-printing http://localhost:3000
) else (
  start "" http://localhost:3000
)

endlocal
