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

REM Open the dashboard in the default browser as a normal window (not fullscreen/kiosk mode).
start "" http://localhost:3000

endlocal
