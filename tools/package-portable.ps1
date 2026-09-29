<#
.SYNOPSIS
    Packages a built Release launcher as a portable zip: unzip anywhere, run ultimate-legends.exe.

.DESCRIPTION
    The launcher loads CEF and its UI from its data folder. In portable mode (the portable.marker file next to
    the exe's ultimate-legends folder) that folder lives beside the executable, so a zip in this layout is a
    complete, self-contained launcher:

        ultimate-legends.exe
        ultimate-legends\portable.marker
        ultimate-legends\data\cef\release\...       the CEF runtime the build produced
        ultimate-legends\data\launcher-ui\...        the UI (src\launcher-ui)

    CI runs this on v* tags and attaches the zip and SHA256SUMS.txt to the release; run it locally after a
    Release build to get the same zip. Nothing from any game is included.

.EXAMPLE
    tools\package-portable.ps1 -Version 0.1.0          # -> dist\ultimate-legends-0.1.0-win64-portable.zip
#>
param(
    [Parameter(Mandatory)] [string] $Version,
    [string] $OutDir = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repo 'dist' }

$exe = Join-Path $repo 'build\bin\x64\Release\ultimate-legends.exe'
$cef = Join-Path $repo 'build\runtime\x64\Release\cef'
$ui = Join-Path $repo 'src\launcher-ui'
foreach ($p in $exe, $cef, $ui) { if (-not (Test-Path $p)) { throw "missing $p - build the Release configuration first" } }

$name = "ultimate-legends-$Version-win64-portable"
$stage = Join-Path $OutDir "stage\$name"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$data = Join-Path $stage 'ultimate-legends\data'
New-Item -ItemType Directory -Force -Path (Join-Path $data 'cef\release'), (Join-Path $data 'launcher-ui') | Out-Null

Copy-Item $exe (Join-Path $stage 'ultimate-legends.exe')
Set-Content -Path (Join-Path $stage 'ultimate-legends\portable.marker') -Value '' -NoNewline
Copy-Item "$cef\*" (Join-Path $data 'cef\release') -Recurse -Force
Copy-Item "$ui\*" (Join-Path $data 'launcher-ui') -Recurse -Force

$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# tar.exe (bsdtar, in every supported Windows) keeps the top-level folder and is faster than Compress-Archive.
Push-Location (Join-Path $OutDir 'stage')
try { tar.exe -a -cf $zip $name } finally { Pop-Location }
Remove-Item (Join-Path $OutDir 'stage') -Recurse -Force

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $name.zip" | Set-Content -Path (Join-Path $OutDir 'SHA256SUMS.txt') -Encoding ascii
$size = (Get-Item $zip).Length
Write-Host ("{0}`n  {1:n0} bytes, sha256 {2}" -f $zip, $size, $hash)
