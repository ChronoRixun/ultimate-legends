# MUA 2006 setup investigation

Base: v0.5.0-beta.3. Work branch: codex/muac-setup.

The separate [muac-fix](https://github.com/ChronoRixun/muac-fix) project holds the
experimental setup helper. It reads the player's ISO, extracted DVD folder or
mounted disc and reconstructs the installation from MSI/CAB metadata without
running the original installer. It also identifies existing game folders.

The retail ISO import and complete hash verification succeeded. SafeDiscShim
alone did not pass the disc check, but a subsequent source-built SafeDiscLoader2
test starts the unchanged retail executable. dgVoodoo 2.87.6 with General
FullScreenMode=false AND DirectX AppControlledScreenMode=false produces a real
1080p window and leaves the desktop at its saved resolution. Full gameplay and
save/load tests have not happened; runtime packaging is not implemented.

## Current preview implementation

The MUAC entry now accepts a prepared existing installation and exposes eight
options: display mode, resolution, frame limit, VSync, Xbox controller support,
mouse capture, OpenSpy selection and diagnostic graphics watermark. The watermark
is off in the test installation. Settings writes validate the entire request,
preserve unrelated configuration/comments, roll back write failures and refuse
changes while the game or another folder operation is active. Both graphics and
engine capture settings are written together.

The runtime is a new x86 dinput8.dll built in muac-fix. One Bluetooth controller
was detected as a wired Xbox 360 controller; ambiguous multiple-XInput mappings
are deliberately not synthesized. Actual in-game button bindings need a human
check. OpenSpy DNS/adapter rules were ported from XML2 Fix; full hosting/joining
testing was explicitly waived by the user.

Validation: Debug/Release launcher builds; 133 existing native tests; the MUAC
CEF integration checks (all eight controls, readback, comments, invalid requests,
custom server precedence, running-game refusal); two failed-save UI regressions;
native input/routing tests in muac-fix. The installed beta 3 is not replaced.

## Remaining managed setup work

1. Use the existing `muac` UI entry and register its own `game.exe` configuration.
2. Offer ISO, extracted-disc folder and existing-game-folder sources; recognize
   each by its contents and supported executable profile.
3. Package the helper separately and reuse the tool-download checks and builder
   process lifecycle. Adapt its JSON events to the launcher protocol; its current
   CLI is a prototype, not yet a drop-in XML1 builder replacement.
4. Keep file completeness distinct from runtime readiness. Do not enable Play
   merely because extraction succeeded or Game.exe exists.
5. Apply proven display defaults/dependencies and install a dedicated 2006 fix.
   Keep the beta 3 stable/beta release selection and downgrade rules intact.
6. Test cancellation, failed extraction, repair, updates and uninstall, preserving
   player saves and mods, before enabling this entry in a launcher release.

No MUAC runtime release/download manifest is configured yet. The existing stable/
beta selection logic for other games is unchanged. The preview requires prepared
runtime components and refuses Play when they are missing; automated disc import
and runtime dependency packaging remain separate follow-up work.
