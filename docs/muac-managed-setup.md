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
installation unchanged. Interrupted staging folders remain available for diagnosis; retries
use a new or empty destination. Resume and repair of a partially imported folder are not claimed.

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
