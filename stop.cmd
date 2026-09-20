@echo off
rem Pure ASCII on purpose: cmd.exe reads .bat/.cmd in the OEM code page,
rem so all Chinese messages live in scripts\stop.ps1 (UTF-8 with BOM).
title Lab Report Wizard - Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" %*
echo.
echo Press any key to close this window
pause >nul
