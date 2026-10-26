@echo off
chcp 65001 >nul
title dsh-workspace-session-drag uninstaller
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
