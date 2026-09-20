@echo off
rem Pure ASCII on purpose: cmd.exe reads .bat/.cmd in the OEM code page,
rem so all Chinese messages live in scripts\serve.ps1 (UTF-8 with BOM).
title Lab Report Wizard - Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1" %*
echo.
echo Press any key to close this window (the web page keeps running in background)
pause >nul
