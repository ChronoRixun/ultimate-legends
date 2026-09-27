@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stage-runtime.ps1" -Configuration Release || exit /b 1
start "" "%~dp0..\build\bin\x64\Release\ultimate-legends.exe"
