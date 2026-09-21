@echo off
cd /d %~dp0
echo Setting up Room Manager...
echo (Japanese messages will appear below)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
echo.
pause
