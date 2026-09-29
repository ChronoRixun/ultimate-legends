@echo off
rem The REAL X-Men Legends builder (Legends Classic's xml1builder), run from its source tree, for
rem Debug builds of the launcher: point the Debug-only builder-exe property of X-Men Legends at this
rem file and the launcher runs it instead of an installed release (tools\dev\xml1_cdp.py --real does):
rem
rem   window.executeCommand('set-game-property', {game: 'xml1', suffix: 'builder-exe', value: '<this file>'})
rem
rem The launcher starts it with its own pipes (JSON-lines events on stdout, human text on stderr, a
rem "cancel" line on stdin) in a job object, so cmd.exe, Python and the builder's worker processes all
rem end with it. Settings (environment):
rem   XML1_PORT_TOOLS      the tools folder of the port's checkout (holds xml1builder\ and xml1build\);
rem                        default: ..\..\..\legends-classic\tools, else ..\..\..\xml1-port\tools
rem   XML1_BUILDER_PYTHON  the Python to run it with (3.12+, numpy); default: python on PATH
setlocal
if not defined XML1_PORT_TOOLS (
    if exist "%~dp0..\..\..\legends-classic\tools\xml1builder\__main__.py" (
        set "XML1_PORT_TOOLS=%~dp0..\..\..\legends-classic\tools"
    ) else (
        set "XML1_PORT_TOOLS=%~dp0..\..\..\xml1-port\tools"
    )
)
if not exist "%XML1_PORT_TOOLS%\xml1builder\__main__.py" (
    echo xml1-builder-src: no xml1builder in "%XML1_PORT_TOOLS%" ^(set XML1_PORT_TOOLS^) 1>&2
    exit /b 70
)
if not defined XML1_BUILDER_PYTHON set "XML1_BUILDER_PYTHON=python"
set "PYTHONPATH=%XML1_PORT_TOOLS%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"
"%XML1_BUILDER_PYTHON%" -u -m xml1builder %*
exit /b %ERRORLEVEL%
