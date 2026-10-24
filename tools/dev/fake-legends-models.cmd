@echo off
rem The character-model tool's test stand-in (fake_legends_models.py) for Debug builds of the launcher:
rem point the Debug-only models-tool property of X-Men Legends at this file and the launcher runs it
rem instead of an installed legends-models.exe (tools\dev\models_cdp.py does):
rem
rem   window.executeCommand('set-game-property', {game: 'xml1', suffix: 'models-tool', value: '<this file>'})
rem
rem FAKE_LM_PYTHON: the Python to run it with (default: python on PATH). The fake's own knobs
rem (FAKE_LM_DELAY, FAKE_LM_FAIL, FAKE_LM_BUILD_EXIT, FAKE_LM_LOG) are read from the environment.
setlocal
if not defined FAKE_LM_PYTHON set "FAKE_LM_PYTHON=python"
set "PYTHONDONTWRITEBYTECODE=1"
"%FAKE_LM_PYTHON%" -u "%~dp0fake_legends_models.py" %*
exit /b %ERRORLEVEL%
