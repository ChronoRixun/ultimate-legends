# Save import: host protocol and release checks

> **Hidden in 0.5.0.** Save import is planned for a later release. `Xml1SaveImport.enabled`
> (`src/launcher-ui/assets/js/app/xml1-save-import.js`) is `false`, so the page has no Import button and
> `open()` / `mount()` show nothing; the commands and tests below are kept and the UI tests set the flag to
> `true`. Turn it on to bring the flow back.

The built X-Men Legends page offers **Import an X-Men Legends save**. This is a
preview integration with the LC `import-xml1-save` command. Player installation
is deliberately disabled in both repositories until the converter's real-save,
checkpoint, native-loader and game save-lock gates pass. No table edit or fake
frontend request bypasses the host gate.

## Current flow

1. Choose **Xbox extracted save folder**, **xemu HDD image**, or **XML1-recomp
   extracted save folder**, then **Choose source**. HDD selection opens a file
   picker for `.qcow2`, `.raw`, `.img`, `.bin`, `.hdd` or any other suffix (the
   converter identifies bytes). It forwards the local image to the r2 CLI for
   bounded, read-only discovery; nothing is mounted, exported or rewritten.
   Recomp selection opens a folder picker and sends `--source-kind recomp` on
   inspection and preview (LC cc67912). Choose the recomp installation, its local
   `UDATA/4156001e`, or an individual campaign folder. Saves normally live at
   `<recomp installation>/UDATA/4156001e/<campaign>/save.dat`; no AppData or
   Documents location is guessed. The LC locator selects installation-local UDATA
   without walking installed assets. Close XML1-recomp before reading its saves.
2. A title folder or HDD image with multiple campaigns requires an explicit
   selection. Image candidates retain the original image path; their exact
   `campaign` is sent as `--campaign` on both reinspection and preview. A unique
   image campaign is selected from its source report. Selecting another campaign
   invalidates the preview and resets its inference opt-in. A source summary shows
   provisional stock heroes, levels, unlocks,
   zone/mission/party and the unchecked Xbox signature. No source is modified.
3. Choose the installation's actual **SaveLC** folder. The launcher does not guess
   from a game folder name or redirect saves to its own data directory. Slot
   scanning includes primary, backup and pending files. Choose an empty slot;
   there is no overwrite flow. Existing slots remain untouched.
4. **Preview import** runs the CLI with `--dry-run`. If it needs experimental
   mappings, review every approximation and explicitly opt in before previewing
   again. **Also merge earned unlocks** defaults off and stays disabled until a
   future core advertises a recoverable profile transaction.
5. Review **Continue from ...**, heroes/levels/progress, preserved facts, every
   approximation/reset and every skipped field. Checkpoint continuation resets
   enemies/props, fog, heard lines and world drops. A preview never says Imported.
   An unvalidated report leaves Import disabled.
6. Future admitted apply requires a matching preview token plus a separate confirm.
   Only a terminal successful apply result, matching process exit, slot, preview
   token, output hash and retained-copy/report paths can display success. Current
   host and core refuse that operation. Changed inputs clear the preview.
7. Previous imports show the retained campaign and report paths. Future admitted
   undo requires a separate confirm and an unchanged slot/copy hash. A changed slot
   or extra game backup refuses. Current undo remains disabled. Archives and the
   report are kept after undo; slots must be rescanned before reuse.

The interface is in English, French and Spanish; converter diagnostics remain
complete English fallback sentences. Converter text and paths are escaped before
rendering. The operation survives page redraws, keeps keyboard focus when possible,
retries missing status without restarting, and remains single-flight through
cancellation and process exit. Cancel before the start reply is delivered once the
job ID arrives; a refused Cancel stays retryable. The port's normal build/launch
controls see pending import work as busy. While the converter runs, its existing
JSONL log message is displayed as progress (escaped, without an invented percent).
`E_XML1_DISK_VERSION` and `E_XML1_DISK_DAMAGED` display the English fallback plus
`detail.reason`, distinguishing encryption/unknown features from corrupt input.

`E_XML1_BUSY` (including a live xemu image writer) or host `L_GAME_RUNNING` shows a
writer-wait explanation and **Retry read operation**. Close the writer and wait for
it to exit, then retry inspection, slot discovery or preview explicitly. There is
no automatic retry or queued import, lock timeout/deletion, or apply/undo retry.
The r2 CLI exposes the `lc-save-writer/1` capability but no read-only live lease
status probe: preview/discovery never acquire or create the lease. The launcher
therefore reports actual refusals and does not claim a free writer lease based
on a capability flag or lock-file existence. Transaction admission remains gated.

## Admission gate and extracted builder input

The single launcher admission switch is
`save_import_args::player_install_enabled = false` in
`src/launcher/xml1/save_import_args.hpp`. `xml1_port::start_save_import` rejects
both `apply` and `undo` with `E_XML1_UNVALIDATED` before starting a child. This
switch is unchanged. UI capability/report checks are additional requirements,
not admission switches. The launcher does not append LC's
`--experimental-save-import` flag. LC retains its independent acceptance gate;
matching LC install/undo work does not enable launcher admission.

In Set up X-Men Legends, **Choose ISO / XISO** and **Choose extracted XML1 folder**
share the existing source path. The folder is passed unchanged as `--iso <folder>`
for info/build/verify, as LC 79dfa87 expects. It must contain the original Xbox
files (including `default.xbe`); recomp overlays and saves are ignored by LC.
The builder checks all consumed originals and reports altered/missing files.
X-Men Legends II **for PC** remains required and the build action remains disabled
until it is set up. Source availability recognizes files and directories so
rebuild/resume/verify retain the folder after setup. LC's verified folder result
shows its verified original-file count.

All import selects are synchronously enhanced with the shared in-page drop-down;
the backing selects are hidden and are never used as native popup controls. Source,
campaign and slot selection retain visible focus through redraws. Every picker is
a normal keyboard/controller button, including the new extracted-folder control.

## Host commands and LC additions

`xml1-import-start` accepts typed `mode` (`inspect`, `slots`, `preview`, `apply`,
`undo`), source, optional `sourceKind` (`auto`, `xemu`, `recomp`; default `auto`),
optional opaque in-image `campaign`, SaveLC folder, slot, opt-ins,
preview token or transaction ID and
explicit `confirmed` for apply/undo. The installed build path comes from the game
entry, not the page. `save_import_args` rejects relative/network/device/traversal/
stream/control-character paths, invalid slots/modes/tokens and missing confirmation.
Campaign values remain individual argv values; the host preserves UTF-8 spelling
and rejects control characters or values over 4096 bytes. The LC reader matches
against its own image discovery and checks file bounds and reparse ancestors.

The host refuses while the game, a build, model conversion or folder update is
running. Reservations for the build and save folders last through process exit,
including cancellation. Import children use `CREATE_NO_WINDOW`, a kill-on-close
job, stdin cancellation and Idle priority. `get-xml1-job` returns the existing
snapshot; `xml1-import-cancel {id}` cancels only that import job. A JSON result that
disagrees with the real process exit produces `E_XML1_PROTOCOL`; no optimistic
success is shown.

Small LC additions are `--inspect-source`, `--list-slots`, capability flags,
hero/progress preview rows, a preflushed independent output copy and conservative
undo/history primitives. See LC's `docs/XML1-SAVE-IMPORT.md` for exact fields and
remaining work. Existing exits are retained: 0 success/read/preview, 2 refusal,
5 cancel, 6 I/O and 70 internal bug. In particular, `--undo-import` still refuses
with `E_XML1_UNVALIDATED`; there is no admitted apply or undo success producer yet.

## Headless checks (safe during a live game check)

Run one command at a time, from an existing populated checkout. No dependency
installation or network is needed. Use the installed MSVC and Node, and keep
scratch on the internal workspace disk.

```powershell
(Get-Process -Id $PID).PriorityClass='Idle'
node src/tests/ui/run.js
python -B tools/dev/save_import_host_checks.py --work-folder O:/your-work/native-checks
```

If submodule headers already exist in another local checkout, pass
`--deps O:/existing/ultimate-legends/deps`. `--syntax` additionally syntax-checks
changed launcher integration using that checkout's existing generated version
header. The helper never runs premake, generates a release identity, installs CEF,
links the full launcher or opens a window. `--skip-host` reuses an already passed
host suite and runs the transport and optional syntax check only.

The ordinary C++ host suite includes request validation. The separate transport
check compiles the production `builder_process.cpp` against a test-only Windows
header and logging/path adapters, without linking CEF. It starts Node's invented
`src/tests/ui/fake_save_import_cli.js` with hidden pipes. It verifies real argv
quoting (spaces, apostrophes and Unicode), Idle priority, successful preview versus
installation, structured refusals, cooperative cancellation, missing result and
process/result mismatch. Recomp inspection and preview verify explicit
`--source-kind recomp` through real argv, JSONL source-kind binding and version
refusals. HDD inspection and preview check the exact Unicode
`--campaign` value; encrypted, unknown, corrupt and locked-image refusals retain
their r2 codes through the production transport. It waits for every process to
finish. The fake CLI never
reads or writes a save. Its `admitted` scenario is only a future-protocol fixture;
it does not establish campaign compatibility.

UI tests use the same fake CLI's events with the repository's small DOM/clock.
They exercise extracted and image campaign selection, retained image paths,
unique campaigns, selector clearing/source changes, occupied/backup slots, preview
contents, opt-in,
token invalidation, confirmations, gate refusal, apply/undo result contracts,
cancel/start races, lost status, escaped text, locales, focus and the real page
button, disk refusals and writer wait/retry. They never touch the Windows clipboard
or open a browser or game.

## Deferred release click-through (do not run during the live game check)

No native window/CDP suite, game/emulator launch, desktop/clipboard input, network,
full launcher package or full LC builder run was used for this task. The release
coordinator should perform the following when those checks are authorized:

1. Build/package the launcher and matching builder using the integration team's
   identity. Stage an isolated test launcher using the repository's normal test
   instructions. Use the existing fake builder override in Debug to exercise the
   new command/result fields; do not point fake apply at player saves. Existing
   CDP suites such as `tools/dev/test_mode_cdp.py` and `tools/dev/models_cdp.py`
   were not run here. Add this import flow to that native UI pass.
2. Open a built game's page, select Import, cancel both pickers, choose an extracted
   Xbox title folder with two campaigns, select one, then choose the actual SaveLC
   folder and an empty slot. Check heroes/levels/progress, signature warning,
   checkpoint and every reset/skip. Repeat with disposable raw and QCOW2 fixtures:
   choose both unique and multiple campaigns and verify the image source stays
   selected. Repeat recomp discovery with an installation root, UDATA/title folder,
   and multiple campaigns; preview must show heroes, checkpoint, every approximation
   and omitted stash/equipment field. Unsupported recomp versions must refuse
   without falling back to the Xbox decoder. Encrypted/unknown/corrupt images,
   malformed saves and absent/mismatched tables must explain their refusal.
   Hold a disposable image open for writing and confirm the writer-wait state;
   close that writer and use Retry. Confirm there is no automatic retry or import.
   Check a running-game host refusal and retained SaveLC lease contention with
   disposable saves once the matching DLL is available.
3. Confirm that every occupied/backup/pending slot is disabled, that changing source,
   target, slot or opt-in discards the preview, and that the current gated converter
   cannot enable Import or Undo. Cancel while starting and while previewing; navigate
   away/back, redraw the page, retry a refused cancel and temporarily lose polling.
   Verify there is one CLI job and no surviving child after cancellation/exit.
4. Check native layout, long paths and translated text, 100/150/200% display scale,
   keyboard and controller navigation, focus after every redraw and error. Check
   missing/old converter handling and that no source paths or contents are uploaded.
5. Only after LC's acceptance gates pass, integrate the real apply/undo result producer,
   game-writer lock and matching host admission gate. Use disposable copies of private
   early/mid/late source saves. Confirm the slot/checkpoint, import, compare all source,
   profile and unrelated-slot hashes, inspect the independent campaign copy/report,
   reopen the page and find its history. Undo an unchanged import; retain both copies
   and report. Load/resave in the game and verify undo refuses changed progress.
6. Inject changed source/build/profile, slot races, disk-full/report/copy failures,
   cancel and launcher exit. Existing saves must remain byte-identical and no partial
   operation may claim success. An occupied target always refuses; do not add overwrite
   support without a separate explicit-confirm/backup transaction.
7. Complete LC's real-save matrix, native W2/economy cycles, checkpoint reward/door/
   return-route checks, a late-game import and late-game host/client transfer before
   enabling player use. Validate recomp builds and real-image compatibility separately.

## Windows and Proton screenshot checklist

For each platform, capture the requirements screen with the adjacent image/folder
buttons and XML2-for-PC wording; folder-picked requirements; the verified-folder
check screen; import with the source menu open; recomp source/help with multiple
campaigns and the campaign menu open; slot menu with occupied entries disabled;
recomp preview with heroes/checkpoint and all losses; unsupported-version refusal;
and writer-wait/retry, progress and cancellation states. Check keyboard Tab/arrows/
Enter/Escape and controller D-pad/A/B, long paths, scaling, and focus restoration.
No native select popup should appear. Confirm Import and Undo remain disabled
with the shipping host, including when an experimental LC build is used. These
live checks and screenshots are deferred; this task does not authorize launches.
