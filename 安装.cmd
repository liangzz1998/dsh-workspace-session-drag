@echo off
chcp 65001 >nul
title dsh-workspace-session-drag installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
