<#
.SYNOPSIS
    Copies the built CEF runtime and the launcher UI into Ultimate Legends' data folder.

.DESCRIPTION
    The launcher loads CEF and its UI from %LOCALAPPDATA%\ultimate-legends[_debug]\data rather
    than from next to the executable. Released launchers ship them in the portable zip (and update
    them along with the exe: src\launcher\updater\launcher_update.hpp); for local runs of a build,
    this script stages them.

.EXAMPLE
    tools\stage-runtime.ps1                       # Release
    tools\stage-runtime.ps1 -Configuration Debug
#>
param(
    [ValidateSet('Release', 'Debug')] [string] $Configuration = 'Release',
    # Copy only the UI (works while the launcher is running; CEF files are locked then).
    [switch] $UiOnly
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$appData = Join-Path $env:LOCALAPPDATA ($(if ($Configuration -eq 'Debug') { 'ultimate-legends_debug' } else { 'ultimate-legends' }))

# Debug launcher builds also run on the Release CEF binaries (as upstream's data\cef\release
# did): CEF's debug binaries stop on internal assertions during normal use.
$cefSource = Join-Path $repo 'build\runtime\x64\Release\cef'
if (-not (Test-Path $cefSource)) {
    throw "No CEF runtime at $cefSource - build the Release configuration first."
}

# CONFIG_NAME in std_include.hpp is "release" for every configuration.
$cefTarget = Join-Path $appData 'data\cef\release'
$uiTarget = Join-Path $appData 'data\launcher-ui'

New-Item -ItemType Directory -Force -Path $cefTarget | Out-Null
if (-not $UiOnly) {
    Copy-Item -Path "$cefSource\*" -Destination $cefTarget -Recurse -Force
}

# Mirror the UI rather than copying over it, so files deleted from src\launcher-ui don't linger.
# The launcher reads these per request and never holds them open, so this is safe while it runs.
if (Test-Path $uiTarget) {
    Remove-Item -Path $uiTarget -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $uiTarget | Out-Null
Copy-Item -Path (Join-Path $repo 'src\launcher-ui\*') -Destination $uiTarget -Recurse -Force

Write-Host "Staged $Configuration runtime into $appData\data"
