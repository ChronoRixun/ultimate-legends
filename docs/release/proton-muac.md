# MUA 2006 on Wine / Proton

Companion: muac-fix 0.2.2, minimum launcher 0.5.0-beta.8 (or final 0.5.0).
No launcher version is assigned by this change. Package/release integration remains a coordinator task.

Wine is detected by the ntdll `wine_get_version` export, without environment heuristics.
Wine drive roots and directory mount tags (`0xA0000003`) resolving to their own path are accepted.
All other reparse points remain refused during cleanup and runtime Update, including redirected
junctions and symlinks inside the game tree. The helper and launcher carry identical synthetic
mount-point test vectors.

Initial setup delegates disc extraction and runtime placement to muac-setup. In-place Update is
entirely native in `muac/runtime_update.cpp`; it does not run the helper. Both paths use Wine D3D9
and skip the pinned dgVoodoo archive/DLL on Wine. Native Windows retains the verified wrapper path.
`dgVoodoo.conf` remains in the common runtime bundle, but is inactive on Wine. The options page
hides wrapper-backed mode/resolution/frame-limit/VSync/watermark controls. CaptureMouse reads and
writes only the native fix INI on Wine, alongside controller, background and online settings.

A Windows-made install may contain `D3D9.dll`. The options page offers Update and explains why
runtime 0.2.2 or newer is needed. A compatible same-version migration is allowed; older installed
releases update normally, and a newer installed release is never downgraded. Availability still
depends on the selected channel, cached/online package and launcher version floor.

Before removal, Update stages the original DLL in its transaction and a persistent copy under
`_muac/backups/D3D9-<sha256>.dll`. A conflicting backup with different bytes refuses the update.
The runtime record identifies `graphics: wine-d3d9`, omits live D3D9.dll from its file list and
records the removal's target, backup, size and SHA-256. Metadata is promoted last. Cancellation,
locks and copy/rename errors roll back; an interrupted transaction is recovered by retrying Update.
No game executable, disc file, save, mod or registry display setting is changed by the update.

## Coordinator live checks (not run by this implementation task)

1. Build/package muac-fix 0.2.2 and this launcher with an assigned identity satisfying the floor.
   Serve the matching manifest/package through the coordinator's isolated release feed or existing
   test seams. Use a fresh Proton prefix and a game/output path on a native ext4 filesystem;
   avoid WSL `/mnt`, NTFS and network mounts. Use the owner's retail ISO, never a fixture DLL.
2. Run the launcher with the coordinator's chosen Proton (the prior investigation reached the
   menu with GE-Proton11-12). Set up the complete ISO into a new empty folder below a real mount
   such as the Linux home or an ext4 test volume. Verify full copy and hash checks, registration,
   no live D3D9.dll, `graphics: wine-d3d9`, and all other runtime components/notices present.
3. Play to the main menu, capture evidence, then exit. Check controller input separately; reaching
   the menu does not validate gameplay, saves, multiple pads or online host/join.
4. On a disposable Windows-made installation, snapshot game/save/mod/config hashes and retain
   its original D3D9.dll hash. Under Proton confirm migration advice, choose Update to 0.2.2,
   and verify the live DLL is absent, the persistent backup matches the original hash, and
   runtime.json records the backend/removal. Check game/save/mod files and custom config values
   remain intact, then play to the menu again. Repeat on a Windows-made 0.2.2 installation to
   exercise same-version migration. Never downgrade a newer installed runtime.
5. Cancel an update and interrupt one during replacement on disposable copies. Retry Update;
   confirm originals recover before any new update and Play is blocked while recovery is pending.
   Verify a real junction/symlink within the disc/game tree is refused, while the ext4 mount is
   accepted. Check Wine display advice, all remaining options, and keyboard/controller focus.
6. On native Windows, setup/update must still verify and place dgVoodoo and expose its controls.

Automated synthetic/native/UI tests do not prove Proton filesystem APIs, actual CEF rendering,
hardware controls or game startup. No games, GUI, WSL or downloads are part of this task's checks.
