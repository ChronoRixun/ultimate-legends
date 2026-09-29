@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stage-runtime.ps1" -Configuration Debug || exit /b 1
rem -no-assert-dialogs: a failed assertion ends the launcher instead of leaving a modal dialog on the desktop.
start "" "%~dp0..\build\bin\x64\Debug\ultimate-legends.exe" -no-assert-dialogs
