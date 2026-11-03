# MUA 2006 setup investigation

Base: v0.5.0-beta.3. Work branch: codex/muac-setup.

The separate [muac-fix](https://github.com/ChronoRixun/muac-fix) project holds the
experimental setup helper. It reads the player's ISO, extracted DVD folder or
mounted disc and reconstructs the installation from MSI/CAB metadata without
running the original installer. It also identifies existing game folders.

The retail ISO import and complete hash verification succeeded. The original
executable remains blocked: an app-local SafeDiscShim experiment advanced past
the initial Access Denied failure, but still requested the correct DVD despite
finding the mounted disc. Full gameplay and save/load tests have not happened.

## Planned integration after runtime proof

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

No launcher runtime code has changed. The installed launcher and its release
channels are unaffected. The 2006 card intentionally remains Coming soon until
the executable compatibility gate is resolved.
