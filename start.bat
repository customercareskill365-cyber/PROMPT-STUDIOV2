@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Video Prompt Studio & Shot Library
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
