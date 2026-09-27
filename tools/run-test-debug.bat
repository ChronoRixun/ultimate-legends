@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stage-runtime.ps1" -Configuration Debug || exit /b 1
start "" "%~dp0..\build\bin\x64\Debug\ultimate-legends.exe"
