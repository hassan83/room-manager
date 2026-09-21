@echo off
cd /d %~dp0
echo Uninstalling Room Manager...
echo (Japanese messages will appear below)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
echo.
pause
