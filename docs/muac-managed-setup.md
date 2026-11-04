# Managed MUA 2006 setup

The MUAC setup page accepts an owned retail PC ISO or an extracted/mounted DVD folder.
It writes only to a new or empty output folder. A previously prepared working installation
can still be selected through the existing installation flow.

The launcher resolves `ChronoRixun/muac-fix` using its selected Stable/Beta channel and requires
the `muac-setup.json` asset. The manifest's version must match that release, `api` must be 1,
and `min_launcher` must be satisfied. The existing tool installer checks package size and
SHA-256 before extraction. A local matching package in the tool cache or Downloads is accepted.
Offline setup requires previously resolved/cached metadata, helper and graphics archive.

The helper's runtime/package.json pins the original dgVoodoo archive and x86 DLL by hash.
Only the official upstream GitHub release path is accepted for that download. The helper is
offline: it checks all runtime bytes again, checks the known retail Game.exe, reads the disc's
MSI/CAB layout without executing installer actions, verifies imported files, adds runtimes,
and renames its staging folder into place. It never installs a protection driver or system DLL.

An exclusive folder reservation covers downloading, import and final registration. The process
runs in the existing job-object runner, including cancellation and kill-on-launcher-exit.
Readiness requires the actual process exit to be zero, a matching complete/prepared result,
and native installation/runtime checks. Errors and cancellation leave the previous selected
installation unchanged. The companion helper cleans its own managed staging on handled
failure/cancellation. Managed helpers with the contained-stage contract create
`<output>/.muac-stage-*` and report that exact path in an `extract` stage event.
After ending an unresponsive helper's job and draining its pipes, the launcher
finishes deletion only for that reported direct child, with no linked ancestors
or descendants. The popup shows "Cleaning up..." and retains the folder reservation
until deletion ends. Cleanup errors are shown instead of claiming success. An empty
output container may remain and can be reused. Retries use a new or empty destination.

This fallback requires the companion contained-stage helper change intended for
muac-fix 0.2.1. Older helpers (including 0.2.0) report sibling stages; the launcher
refuses to delete those paths. Pair the two changes when integrating. The helper
continues to verify and prepare before promotion by same-volume directory renames.
Wine drive-root mappings are allowed only when Wine's ntdll export is present;
links below a drive root remain forbidden in both helper and launcher cleanup.
Resume and repair of a partially imported folder are not claimed.

Default settings: windowed, 60 FPS, free cursor, watermark off, Xbox support and background
running enabled, OpenSpy redirection enabled. Gameplay/multiplayer certification is separate
from byte verification and dependency preparation.

Release coordination: publish a reviewed muac-fix setup artifact and manifest before shipping
this launcher feature to users. The packaging workflow uploads CI artifacts only; it does not
create tags or publish releases. This launcher branch does not silently choose another channel
when the selected channel has no setup release.

Debug integration: `muac-dev-setup-manifest` permits a local manifest; Release ignores it.
`tools/dev/muac_setup_cdp.py` drives the real backend through an isolated Debug launcher and
restores its game properties. Its explicit source/output arguments opt into importing local
files; it never launches a game. The independent source helper tests generate synthetic data.

## In-place runtime updates

The MUA 2006 patch line reads `_muac/runtime.json` (`schema: 1`, `prepared: true`, `version`), already written
by setup packages 0.2.0 and 0.2.1, when its recorded DLL hash still matches. Without a valid record it reads `dinput8.dll` VERSIONINFO; a DLL without
a readable version is shown as version unknown. Stable resolves `ChronoRixun/muac-fix` releases/latest;
Beta resolves the highest release including prereleases. Both require `muac-setup.json`, a matching
manifest version, API 1 and a satisfied `min_launcher` before offering Update.

`start-muac-update` uses the configured installation, the same setup-package download/size/SHA-256 checks,
and the pinned dgVoodoo archive. It never runs the importer or setup helper. The native transaction
validates `runtime/package.json` and each file's size/hash, then stages only `dinput8.dll`, `version.dll`,
`D3D9.dll`, the three configuration files and the manifest's allowlisted `_muac` notices/licenses.
Existing INI/CONF keys are preserved case-insensitively; missing keys are added. `version.json` merges
missing object members recursively. Unchanged settings are not replaced, preserving custom keys and
comments. A malformed configuration refuses the update rather than replacing player settings.

The exclusive folder hold prevents launcher operations from overlapping. Running-game checks happen
before preparation and throughout replacement. Same-volume renames retain original files under a guarded
`.muac-stage-update-*` folder until commit. Errors and cancellation restore the originals; a persistent
journal allows the next Update to recover after interruption. Play and option writes refuse a pending
transaction. The new runtime record is promoted last and records the hashes of the actual merged configs.
Updates never downgrade a newer installed release just because the channel was switched to Stable.

This works with the existing 0.2.0/0.2.1 package contract. The companion helper is unchanged; no 0.2.2
release is needed for this feature. GUI, external-process running checks and live package validation must
also be exercised by the release coordinator; native and UI tests use synthetic data.
