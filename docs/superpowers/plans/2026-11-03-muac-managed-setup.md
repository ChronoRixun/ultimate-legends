# MUAC managed setup implementation plan

> Execute inline using the executing-plans workflow. The owner explicitly requested the complete ISO/extracted-disc launcher flow after merging the prepared-install preview.

**Goal:** Select an owned MUA 2006 ISO or extracted DVD folder, choose a new output folder, and obtain a prepared installation without manual DLL copying or Python installation.

**Architecture:** Reuse the launcher's channel-aware, hash-checked tool installer and job-object process runner. Publish a self-contained `muac-setup.exe` package with our x86 fix and pinned source-built SafeDiscLoader2. Download the original pinned dgVoodoo archive separately for this game's setup. The offline helper validates all runtime payloads and the supported retail executable, imports and prepares a staging folder, then promotes it atomically. Register the install only after a successful process result and native readiness checks.

**Tech stack:** Existing C++/CEF launcher, Python importer frozen with PyInstaller, MSVC Win32 runtime builds, JSONL process protocol, GitHub release manifests.

## Decisions and scope

- Build on merged main (including beta 4), on `codex/muac-managed-setup` in both repositories.
- Downloaded helper versus embedding everything: use a versioned helper, matching Legends Classic's update architecture and avoiding a large launcher binary.
- Dependencies: tested SafeDiscLoader2 commit `91b6b89da8296276c36ff1a8fea2456c892ca865`, dgVoodoo 2.87.6, and this repository's MUA Classic Fix. Retain corresponding source and license notices in distributable artifacts.
- No game files, protection drivers, system DLL changes, installer custom actions, or foreground game launch during automated verification.
- Download orchestration belongs in the launcher. The helper is offline. Stable/Beta resolves one release by tag; missing releases produce a clear setup error.
- Only the known supported retail executable receives this automatic runtime configuration. Existing prepared-install selection remains available; unknown/modded executables are not rewritten.
- Default windowed mode, watermark off, free cursor, Xbox support on, background running on, OpenSpy on. Preserve original Game.exe.
- Output must be new or empty. Cancellation/failure never marks it installed. Keep the exact failed staging path for diagnosis; do not delete arbitrary directories.
- Prepare distributable artifacts and PRs; publishing a release is a final, concrete owner approval step.

## Tasks

- [x] Helper: add offline `setup` command, verified runtime bundle/dependency inputs, cooperative cancellation and compatible JSONL events. Extend import with a pre-promotion preparation callback. Test corrupt payload, wrong executable, cancellation, filename traversal and failed preparation.
- [x] Packaging: build pinned SafeDiscLoader2 and our x86 runtime; freeze the helper; create payload hashes, licenses, source archives, tool manifest, SHA256 sums. CI produces artifacts without publishing. Test packaged helper without site-installed Python.
- [x] Backend: implement asynchronous MUAC setup state/start/cancel using existing release/tool/process APIs, folder reservation, download hash verification and explicit final readiness admission. Add Debug-only local manifest support for integration tests.
- [x] UI: ISO/extracted folder and output pickers, progress, cancel/hide, retry, completed setup refresh. Preserve keyboard/pad focus and use existing popup/navigation conventions.
- [ ] Validate real ISO and extracted-folder source detection, full staged setup into a new local test directory, unchanged retail executable, native/UI regressions, content guards, and separate preview. Open companion PRs and present release artifacts for review.

## Review focus

Wrong/modified source, damaged cached downloads, cancellation during CAB extraction, process exits with a misleading result, and a nonempty destination must all fail without registering a playable installation. Tests belong with the helper or setup coordinator that owns each behavior.

## Validation ledger

- Real ISO and mounted/extracted-folder imports both completed through the launcher into separate new directories, registered only on success, and passed runtime/defaults checks. Game.exe SHA-256 remained equal to the retail disc.
- Cancellation from a folder source left the existing selected installation unchanged. An existing nonempty destination was refused, with a persistent UI error.
- 26 helper tests, 150 launcher native tests, native settings tests, 322 existing UI tests and four new MUAC setup UI tests passed. Debug and Release builds passed.
- Independent review findings (exit-code contract, progress labels, error persistence, stale success and LGPL source delivery) were fixed and re-reviewed with no remaining blocker.
- Final artifact/PR publication and CI verification follow this implementation commit. No game launch or multiplayer test was performed in this packaging pass.
