# Changelog

The launcher's version comes from its release tag (`v0.3.2`): premake reads it with `git describe` when it
generates the project, so a release only needs this entry and the tag.

## 0.5.0 (2026-11-05)

The stable release of the eight 0.5.0 betas (below): character models for X-Men Legends, Marvel: Ultimate Alliance
(2006 PC) setup, options, MUA Classic Fix version line and in-place Update, MUA 2006 on Steam Deck / Proton (MUA
Classic Fix 0.2.2), custom artwork and game order, in-page drop-downs, and the beta.3 / beta.4 build fixes. Tagged
as `v0.5.0-rc.1` and `v0.5.0-rc.2` (pre-releases for the Beta update channel; rc.2 adds the two fixes from the
rc.1 real-pad check), then as `v0.5.0` on rc.2's commit. The release
notes are `docs/release/v0.5.0-notes.md`.

### Changed
- **The save-import preview is hidden.** The X-Men Legends **Import an X-Men Legends save** button and its screens
  (beta.4 to beta.8, installing and Undo turned off) are not shown in 0.5.0; save import is planned for a later
  release. The code, the launcher commands and the tests stay: `Xml1SaveImport.enabled` (off) gates the page's
  button, `open()` and the panel, and the UI tests turn it on to keep covering the preview.
- **Character models on the Stable channel** use the first stable legends-models release, 0.3.0 (the tool of
  0.3.0-beta.3). Stable takes only `releases/latest`, so before it the section said the tool was not published yet
  and pointed at the Beta channel.

### Fixed
- **Controller: every Character models control and every Mods row can be reached with the pad** (found in the
  rc.1 real-pad check: with a models set installed, focus skipped the model controls and Up could not leave the
  section; Mods rows lost focus after a redraw on the X-Men Legends, MUA and MUA2 pages).
- **Cancel stops a Character models build.** It used to show Cancelling... while the conversion went on; now the
  build runs in a private staging folder, Cancel stops the tool within a few seconds and nothing changes in the game
  (models and load order stay as they were).
- **The Classic conversation box needs Legends Classic builder 0.6.0-beta.3 or newer** (beta.4 to beta.8 said
  0.6.0-beta.2). 0.6.0-beta.2's builder parses `--classic-conversation` but does not implement it, so beta.2 and
  older keep the option hidden and are never sent the argument; the refusal text names 0.6.0-beta.3.

## 0.5.0-beta.8 (2026-11-04: a pre-release for the Beta update channel)

### Added
- **Marvel: Ultimate Alliance (2006 PC) on Steam Deck / Linux (Proton).** Automatic setup from your own disc,
  Update and Play now work under Proton. Needs MUA Classic Fix 0.2.2 (the setup package the launcher downloads),
  whose manifest in turn requires this launcher or newer. Put the game folder on a Linux filesystem (the Deck's
  internal storage, an ext4 SD card or your home folder), not an NTFS or network drive.
- Under Proton, the game uses Proton's own D3D9 instead of dgVoodoo2 (whose `D3D9.dll` crashes under Wine):
  setup and Update skip the dgVoodoo2 archive and DLL, and `_muac/runtime.json` records `graphics: wine-d3d9`.
  Native Windows keeps the verified dgVoodoo2 setup and its display options.
- **A Windows-made MUA 2006 installation moved to Steam Deck / Linux: choose Update.** The options page explains
  why and offers **Update**, also when the installation is already on MUA Classic Fix 0.2.2 ("Update (removes
  D3D9.dll for Proton)"). Update keeps a backup of the installation's `D3D9.dll` at
  `_muac/backups/D3D9-<sha256>.dll`, records the removal and removes the live DLL inside the same staged,
  rolled-back-on-failure transaction as every runtime update. `Game.exe`, the other game files, saves, mods and
  settings are kept, the removal is remembered by later updates, and a newer installed runtime is never
  downgraded. On Windows, Update keeps `D3D9.dll` as it is.
- Under Proton, the options page hides the dgVoodoo2 display options (mode, resolution, frame limit, VSync,
  watermark) and says "Your Steam Deck / Proton handles display mode."; controller, Run in background, mouse
  capture and online options stay editable. The credits name DXVK/Proton there, and Run in background has
  Proton-specific help.
- Setup, cleanup and Update recognize Wine (`ntdll!wine_get_version`) and accept Wine drive roots and Linux mount
  points (`/home`, an SD card), which Wine shows as linked folders. Redirected junctions and symbolic links inside
  the disc or game tree are still refused.

### Fixed
- **A launcher stopped while it writes an update journal no longer leaves MUA 2006 stuck.** In beta.7, a crash
  at that moment could leave an empty journal: Play stayed refused and every Update retry failed with "Invalid
  runtime JSON.". Every update payload, merged setting, runtime record and journal is now written to a flushed
  temporary file beside it and atomically put in place, and an immutable recovery plan written before any game
  file moves lets the next Update roll back or finish from its backups even if the journal is missing or
  unreadable. An empty journal left by beta.7 is discarded only after the staged files and backups show nothing
  was published yet; recovery decisions are logged, and damage that can't be resolved safely keeps the staging
  and backups for manual recovery instead of guessing.

### Known issues
- MUA 2006 under Proton was tested under GE-Proton 11 on Linux (setup from the ISO, Update of a Windows-made
  installation, starting the game to its main menu), not yet on a real Steam Deck. Gameplay past the menu,
  controllers through Steam Input, saves and online play are not certified there yet.
- Under Proton, completing **Change artwork...** through Wine's file dialog is still unverified (artwork you
  already chose is kept).

## 0.5.0-beta.7 (2026-11-04: a pre-release for the Beta update channel)

### Added
- **MUA 2006 shows its MUA Classic Fix version and offers Update.** The version comes from setup's runtime
  record, with the DLL version as a fallback for manually prepared installations. Prereleases have a Beta
  badge; the latest compatible setup package follows Settings > Update channel.
- **Update compatibility components in place.** Update downloads and verifies the same package as setup,
  then replaces only its runtime DLLs and notices. Existing configuration values are kept; missing keys are
  added. No disc is needed, Game.exe and saves stay untouched, and a running game refuses the update.
  Files are staged first, failed replacements roll back, and an interrupted transaction is recovered when
  Update is retried. No companion helper update is required.

### Fixed
- **Text stays readable over custom artwork.** Player-chosen cards have a bottom Ink fade behind their
  titles, year tags and actions, plus a subtle title shadow. The fade starts higher and stays darker
  behind the title on bright pictures, including dimmed uninstalled cards. Custom banners receive the same
  protection under the game-page and Home text. Built-in artwork keeps its existing appearance.
- **Custom artwork works under Proton / Steam Deck.** A chosen picture was dropped at the next start
  when the launcher folder sits below a linked folder (under Proton every Linux folder such as
  `/home` is one). Links inside the launcher's own artwork folder are still refused.
- **MUA Classic Fix Update works through a junction or symbolic link to the game folder** on Windows. The
  launcher resolves the real folder once before updating; links inside the runtime tree are still refused.
- **Update errors explain how to continue.** A locked runtime file asks you to close the game or the
  program using it and try Update again. Play and options tell you to choose Update after an interrupted
  update.

### Known issues
- MUA 2006 under Proton / Steam Deck is still not supported: automatic setup and Update refuse Linux
  folders and the game does not start under Proton yet. The launcher's MUA 2006 page shows its version there.

## 0.5.0-beta.6 (2026-11-03: a pre-release for the Beta update channel)

### Added
- **Choose your own game artwork.** Right-click a game's card (or open its menu with the keyboard or a
  controller) and pick **Change artwork...** for the library card or **Change banner...** for the page banner.
  Pick a PNG, JPG or WebP picture of up to 20 MB from your PC, check the centred preview, and keep it with
  **Use artwork**. The launcher keeps its own copy in its user folder, so moving or deleting the original does
  not matter; **Reset artwork** brings the default pictures back. Pictures are never fetched online; files that
  are too large or are not real pictures are refused and the current art stays.
- **Rearrange your games.** Drag cards in the Library or icons in the sidebar to put the games in your order,
  or use **Move earlier** / **Move later** from a card's menu with the keyboard or a controller. The order is
  kept across restarts and used by the Library filters and the sidebar. **Settings > Maintenance > Reset game
  order** puts the default order back and keeps your artwork.
- **New X-Men Legends card art** drawn from the same sunrise motif as the other games.

### Fixed
- **Cancelling MUA 2006 setup cleans up after itself.** The popup shows **Cleaning up...** while the copied files
  are removed. If the setup helper's own cleanup takes longer than the cancel grace (slow USB or network
  drives), the launcher removes the helper's staging folder inside your chosen game folder itself, so no
  `.muac-stage-*` folder is left behind. Nothing is registered.
- Needs the MUA Classic Fix setup package 0.2.1 or newer, which keeps its staging folder inside the chosen game
  folder.

### Known issues
- MUA 2006 under Proton / Steam Deck is not supported yet: setup still stops with "Linked folders are not supported
  for setup." (Wine shows Linux mount points such as `/home` as linked folders), and the game does not start under
  Proton (SafeDiscLoader2 fails there). X-Men Legends and the 2016 games are not affected.
- Choosing a picture for artwork under Proton opens Wine's own file dialog; it has been checked on Windows only.

## 0.5.0-beta.5 (2026-11-03: a pre-release for the Beta update channel)

### Added
- **Marvel: Ultimate Alliance (2006 PC) options page.** Once the game is set up, its page offers display mode,
  resolution, frame rate limit, VSync, Xbox controller support, mouse capture, Run in background, OpenSpy online
  and the diagnostic graphics watermark (off). Every control works with the mouse, keyboard or a controller and
  is drawn inside the launcher's page. Changes are written one setting at a time and keep the rest of the game's
  configuration and comments; the launcher refuses changes while the game is running and says which
  compatibility files are missing when the folder is not ready.
- **Automatic MUA 2006 setup from your own disc.** Choose **Set up**, pick your retail PC DVD ISO or an
  extracted/mounted DVD folder, and a new or empty game folder. The launcher downloads the MUA Classic Fix setup
  package from your update channel (size and SHA-256 checked) and the original dgVoodoo2 archive from its
  author's GitHub release (pinned SHA-256), then imports and verifies the game files on your PC without running
  the original installer. The package includes MUA Classic Fix and a source-built SafeDiscLoader2 (by
  nckstwrt); dgVoodoo2 is by Dege. Game.exe is not changed, and no game files are downloaded or shipped.
  Cancelling or a failed import registers nothing; a folder that is not empty is refused. Only a completed,
  verified setup makes the game ready to play.
- Needs the MUA Classic Fix setup package 0.2.0 or newer, published separately.

### Known issues
- Cancelling setup can leave a `.muac-stage-*` folder when the setup helper's cleanup takes longer than the
  launcher's 15 s cancel grace (slow destination drives); nothing is registered.
- Managed MUA 2006 setup is refused under Proton/Wine ("Linked folders are not supported for setup.").

## 0.5.0-beta.4 (2026-11-03: a pre-release for the Beta update channel)

### Added
- **Classic conversation box (XML1 look)** under X-Men Legends' Appearance and advanced build options.
  It starts off. Turn it on and rebuild to use the blue background from your own XML1 source; turn it off
  and rebuild to restore the PC look. It appears only with an installed Legends Classic builder
  0.6.0-beta.2 or newer; an available update alone does not enable it. The companion builder must ship separately.
- Setup can read an extracted XML1 install folder as well as an ISO/XISO. X-Men Legends II for PC is still required.
- Save-import preview screens and transport are included for testing. Player save installation and Undo remain
  disabled pending companion and real-save acceptance.

### Fixed
- Cancelling Rebuild before the builder changes a completed build keeps it ready. A build that has started
  changing the folder still offers Resume build.
- Preparing the XML2 Fix in a second build folder keeps the first folder's recorded release, including its beta
  version. Removing a fix clears only that folder's record.
- An installed XML2 Fix that is too old has an **Install the XML2 Fix** recovery button after a refused Rebuild.
- The wizard says a newer builder **will be installed when you build**, instead of claiming installation has begun.
- The local X-Men Legends CDP test uses its fake release answer as well as its fake download, so real Sandbox
  internet cannot change the test's expected XML2 Fix version.
- Character-model progress retains accepted-cache/refit explanations and reports a completed installation when
  cancellation arrives after publication has begun.

## 0.5.0-beta.3 (2026-11-02: a pre-release for the Beta update channel)

### Fixed
- **A first X-Men Legends build installs the XML2 Fix before it starts.** New folders, Resume and Rebuild now
  prepare the fix from your update channel after checking the builder. The launcher checks the fix against what
  that builder needs before starting; a cancelled or failed download leaves no partial fix in the folder.
- **Changing update channel refreshes every component without a restart.** The X-Men Legends page, setup wizard
  and Character models section now show the builder and model tool offered by the channel you just chose. Every
  build checks the builder again before it starts, so switching to Beta does not reuse an old Stable answer.
- **Switch back to Stable is the highlighted action** in the beta confirmation, with Keep the beta as the
  secondary choice. Escape / B still keeps what is installed. The update-channel box keeps keyboard/controller
  focus while checking the new channel.
- **Every drop-down opens under Proton / Wine (Steam Deck, Linux).** Clicking a drop-down there showed nothing: the
  list is a separate popup window that Proton closes before it is drawn, so the update channel could only be changed
  blind from the keyboard. Every drop-down is now drawn inside the launcher's own page instead: Settings' language,
  theme and **update channel**, the X-Men Legends and X-Men Legends II **Display** rows (display mode, resolution,
  frame rate, VSync) and the **Character models** costume choosers. They work the same on Windows. Mouse, touch,
  keyboard and controller all open them: Enter / Space / A opens the list, Up / Down (or Home / End, or the first
  letters of an option) move through it, Enter / A picks, Escape / Backspace / B closes it without a change. The
  choice is made only when you pick it, not while you move through the list. The list opens upwards when there is no
  room below and closes when you click elsewhere or the window loses focus. Settings are saved exactly as before.
- Tests: UI `dropdown.test.js` in the UI suite (the shared list's keyboard, mouse, pad and ARIA behaviour; each
  drop-down in Settings, Display and Models); `tools/dev/dropdown_ui_test.py`, the same in a headless Chromium
  with the real settings and display code.

### Docs
- README: what Settings > Updates > **Update channel** (Stable / Beta) does, what follows it and how switching back
  works.

## 0.5.0-beta.2 (2026-10-25: a pre-release for the Beta update channel)

### Added
- **The character models' work shows in the Downloads tab.** Each Apply / Rebuild / Remove / Off of the Character
  models section and each install / update of the legends-models tool is one entry there while it runs, drawn from
  the section's own job (one job model, the tab and the page always agree): its phase in words (downloading a
  community skin with its costume, expected size and source; converting hero N of M; installing into the mods
  folder; removing a group; the tool's zip downloading with bytes done / total and its update channel, then checked
  and unpacked), its progress bar, and the skins downloaded so far with file, size, source and SHA-256. **Cancel**
  on the entry is the section's Cancel (the same question for a build; the tool's install stops at once and the
  installed tool, if any, stays); the section's own progress has Cancel for the tool's install too. A Remove / Off is
  not cancelled half way. The sidebar badge counts these entries.
- **Recent in the Downloads tab.** Finished work goes to Recent, newest first, with Finished / Finished, with notes /
  Failed / Cancelled and the reason in the section's own words (a model run's outcome, a patch's error), and the
  downloads it made; patch installs, updates and removals go there the same way (a queued one cancelled from its row
  too). Running entries are listed in the order they started, then the queued patch items. Recent lasts until the
  launcher closes, or **Clear**.
- Native: `models-tool-cancel`; `get-models-status.toolRelease` gives the release's `latestZip`, `latestSha256` and
  `cancelRequested`; an install cancelled while it waits for a running conversion stops too (`L_TOOL_CANCELLED`).
- Tests: UI `downloads.test.js` (Apply's phases, both Cancels, a failure, Rebuild / Remove, the tool's install
  cancelled and finished, patch and models ordering and Recent); `models_cdp.py` checks the Downloads tab through a
  fake Apply and the tool's install (a throttled fake GitHub download, `fake_github.py /__mode?throttle=`; the fake
  tool's `FAKE_LM_DOWNLOAD_DELAY`).

## 0.5.0-beta.1 (2026-10-25: a pre-release for the Beta update channel)

### Added
- **Character models for X-Men Legends (Legends Classic port).** A Character models section on the port's page runs
  the legends-models tool (LAUNCHER-API v1) against the player's own installs: Off / Community pack (suggested) /
  Upgraded (greyed until Marvel: Ultimate Alliance or Marvel: Ultimate Alliance 2 is set up) and, under More,
  Sharpened classic / XML2 look; a per-hero table (source tier and why, a costume dropdown with its author or source,
  status planned / built / failed with the reason / original); Apply with a per-hero progress bar, downloads with
  file, size, source and SHA-256, and a plain-words outcome; Cancel; Remove / Off; Verify when the page opens; the
  built pack's CREDITS.md whenever community skins are used; a Download source (mirror) field. While it runs, a port
  build, Uninstall and the Mods list's changes wait; it refuses to write while the game or a build runs.
- **The legends-models tool installs and updates like the builder.** From the GitHub releases of
  ChronoRixun/legends-models (`legends-models-<version>-win64.zip` next to `legends-models.json`: version, zip, size,
  sha256, min_launcher, api) on the update channel: Stable takes the latest release, Beta pre-releases too. With no
  tool the section shows what the channel offers ("a beta on your Beta update channel" when it is one) and
  **Install** with its progress, or "not published yet" / the failure in plain words with **Check again**; with one,
  its version and **Update** when the channel has a newer one. The zip's size and SHA-256 are checked, a release for
  another protocol (`api`) or a newer launcher (`min_launcher`, the whole version: 0.5.0-beta.1 is not 0.5.0) is not
  installed, a zip already in `tools\legends-models` or Downloads is used when it matches, the previous version is
  removed after the install, an older version is never installed over a newer one (Switch back to Stable keeps a
  beta tool), and nothing runs while it installs. `-offline`: no check. Debug builds take `models-tool` (a program
  to run instead) and `models-manifest` (a local manifest) properties.
- **The community skins' terms before the first download.** BaconWizard17's terms (don't share the files outside
  marvelmods.com, don't sell them, credit him) are shown before the first build that uses community skins; declined,
  nothing is downloaded; accepted once (stored with the terms' version).
- Follows legends-models 0.3.0's launcher API: costume labels and credits per source (MUA1 / MUA2 costumes by name,
  "from your own copy of ..."), the author in the costume dropdown, the author's character-select portrait as a
  preview once a skin is downloaded (read through the launcher, only a PNG from the tool's work folder); downloads
  list hero, costume, file, size, source and SHA-256; `--offline` passed with `-offline` (heroes whose community skin
  isn't downloaded take their next source or the original model, and the section says so); Verify's `stale` (exit 31:
  the port was rebuilt since the models were made) and packs from before 0.3.0 offer **Rebuild**; the tool's one-time
  renames of 0.2.x folders (`MUA-Storm` -> `Upgraded-MUA-Storm`, load-order line kept in place) are announced after the
  build and the Mods list refreshed.

## 0.4.0 (2026-10-23)

A normal stable release with the Online section and the Beta update channel (below). Online play needs XML2 Fix 1.8.0
(Legends Classic 0.3.0's, which reads the keys below: the launcher <-> XML2 Fix contract, v1.5) in the port's folder;
1.7.x has no rooms. XML2 Fix 1.8.0 and Legends Classic 0.3.0 come out as betas first (`v1.8.0-beta.1`,
`v0.3.0-beta.1`), so until they are final online play needs the Beta update channel, and a 1.8.0 beta counts as
1.8.0. Play, LAN and Connect by IP work with any fix, as before. It also brings controller and keyboard navigation to
the whole launcher (below).

### Added
- **Online play for X-Men Legends (Legends Classic port), without ini edits or the Connect by IP box.** An Online
  section on the port's page:
  - **Host a game**: one button. It deletes a stale `online-status.json`, writes `[Online] Host=broker` in the port's
    `xml2-fix.ini` (and removes `JoinCode`) right before the game's process starts, then shows what the XML2 Fix reports:
    *Connecting...*; once the game is up, "Open Play Online in the game – your code appears here" (the room opens when
    the player enters Play Online); then the room's code, large, as `XXXX-XXXX`, with **Copy** and "Send this code to
    your friends. In the game: Play Online → Host.", and the number of players as it changes (the host included; "3 of
    4" when the fix gives the room's size); "Connected – playing together" once the session runs.
  - **Join a game**: a code field that takes lower case, spaces and dashes (pasted from a chat), checks the 8
    characters (no 0 O 1 I L) with an inline error, and **Join** (or Enter). It writes `JoinCode` (and removes `Host`),
    starts the game and shows *Looking for the game...*, "Open Play Online → Join Game in the game" once it is up, then
    "Found it. In the game: Play Online → Join Game, pick the game." and "Connected – playing together".
  - **Public games** (contract v1.3): Host has **List my game publicly** (off by default) and an optional room name
    (up to 32 characters), written as `Public` and `RoomName` with `Host=broker`. The room card says Public or Private
    (and the room's name) as the XML2 Fix reports it.
  - **The code goes on the clipboard by itself** the first time it appears, with a small "Copied to the clipboard"
    note; Copy stays.
  - **Browse games** under Host / Join: the public games of everyone with the launcher, from the online service
    (`https://<broker>:10021/v1/rooms`, its self-signed certificate checked against the pinned key - `BrokerPin`, or
    the project broker's, the trust anchor - and never read otherwise). Each row: the room's name, its host, the mode
    and level (the name the game gives the area, sent with the room), "2 of 4", **In progress**, and **Join** - the
    code flow with that room's code. Another game version, a full room or one that can't take a player now: no Join,
    and the row says why; a build too old for online play greys out every row ("Rebuild to play online"). Rooms with
    a password are not listed. Refresh, and every 10 s while the
    page shows the list; the empty list, the service unreachable, busy or rate-limited, and a key that isn't the pinned
    one in plain words.
  - Every error the fix reports in plain words (the ten ids of contract v1.5): code not found, code expired, the game
    full (`room_full`: every place taken), "That game can't take new players right now. Try again in a moment."
    (`room_closed`: the room exists but isn't taking players - drop-in off, a level loading, the host closing), a
    different game version, the online service unreachable or turning the version away, test mode on, the service not
    verified, an internal error - also when the first the launcher reads is the `ended` state carrying the error;
    an id it doesn't know yet gets a generic text with the id; also the game closing or not starting.
  - **Joining a campaign already in progress**: wait on the game's Joined Game screen; you come in at the next level
    change, and the party needs enough heroes for everyone. Said in How online works and when you join a public game
    marked In progress; during a solo story segment, players without a hero stay connected and watch.
  - **Public games connect players directly**, so they can see each other's internet address: one line says so by
    List my game publicly, under Browse games and in How online works ("Share a private code to play only with
    friends").
  - **How online works**: two cards, Host a game and Join a game, of three short steps with an icon each (the
    game's menus named in English: Play Online, Host, Join Game), always shown; under them **Good to know** (the
    same version for everyone, no port forwarding, public games and your internet address, solo story parts,
    enough heroes, the launcher kept open, test mode, LAN and Connect by IP with Play, when the room opens,
    sending the code, and what this page says once you've joined) and **What the messages
    mean**, each a fold that the keyboard and a controller open and close.
  - Host and Join are off, with the reason, while the game isn't built, a build or an XML2 Fix update holds its
    folder, the folder's XML2 Fix is older than 1.8.0 or its version can't be read (**Verify Files** updates it), Test
    mode is on (with **Turn test mode off** right there) or the game is running. The launcher reads the DLL's version
    itself, and checks it again right before an online start's process, after the start's patch update: an update that
    is skipped, fails or is cancelled never falls through to an online start with an older DLL (Play still starts).
  - A start that is refused, cancelled (the patch update - also mid-download, which used to look like a finished
    update -, the administrator prompt) or fails starts nothing and leaves none of the four
    `[Online]` keys behind, so a later start from Steam or the exe never opens or joins a room by surprise; the
    section says why, and says so if the keys could not be removed. A start already running is never disturbed.
  - **Offline mode** fetches nothing (the public list says it is offline, not that there are no games); Host, Join
    and Refresh offer to restart the launcher online first. Play works offline as before.
  - **Close launcher after game launch** applies to Play only: Host and Join keep the launcher open, to show and copy
    the room's code and follow the session (the setting itself is unchanged; Settings and How online works say so).
  - Buttons and text fields in the Tab order with a focus ring (How online works' two folds too); the focus follows
    what replaces a control (Copy when the code is up, Try again after an error, the same row's Join after a refresh of
    the list), and a slow Refresh gives the focus back only if you haven't moved it.
  - en, fr, es.
- Each key is written on its own (WritePrivateProfileStringW, like Display, Discord and Test mode): every other key
  and section of the file stays byte for byte. Only `Host`, `Public`, `RoomName` and `JoinCode` are written; the
  builder's `Broker` / `BrokerPin` / `GameVersion` / `ContentFingerprint` / `Route` never are.
- **Controller and keyboard navigation across the whole launcher**, so a Steam Deck's D-pad and buttons (or any
  Xbox-style pad) drive every page, not only the touchscreen and trackpad:
  - The arrow keys move the focus to the nearest control that way (sidebar, Home, Library, game pages, Downloads,
    Support, Settings); Enter or Space presses it; Escape or Backspace closes the popup on top, or goes back to the
    previous page and the control you left there. Up and Down stay in the sidebar or the page; Left and Right cross.
  - Library and Home cards, the sidebar's pages and games, the Library's filters and Downloads rows are reachable
    (they were mouse-only). The context menu key (or Shift+F10) opens a card's menu.
  - In an OFF / ON toggle, Left and Right switch it. A drop-down is picked in place: Enter, then Up / Down, Enter
    keeps the choice and Escape puts the old one back.
  - Popups (the message box, setup, Manage install, Client settings, the redistributables, the X-Men Legends
    wizard and uninstall dialog, the card menu) take the focus when they open, keep the arrows and Tab inside, and
    give the focus back to the control that opened them.
  - A pad read through the Gamepad API works without Steam Input: D-pad or left stick to move, A to press, B to go
    back, Y for a card's menu, LB / RB for the previous / next sidebar page. It is ignored while another window
    (a game) is in front, and when Steam Input already sends the same presses as keys.
  - One focus ring for every control, drawn inside it so a clipped group can't hide it, shown while the keyboard
    or a pad is in use and hidden again by the mouse or a touch.
  - (Developed as 0.3.3 in PR #11; 0.3.3 was never released on its own: this ships first in 0.4.0.)
- **Update channel: Stable (the default) or Beta** (Settings > Updates), for testers: Beta gets the pre-releases of
  the launcher, the XML2 Fix and the Legends Classic builder through the launcher, instead of test kits copied by
  hand. Stable is GitHub's latest release (it never sees a pre-release). Beta takes the highest version of each
  repository's releases by SemVer, pre-releases included (`1.8.0-beta.2` < `1.8.0-beta.10` < `1.8.0-rc.1` <
  `1.8.0`), so a beta that becomes final moves Beta to the release; drafts, tags that aren't versions and releases
  still uploading their files are skipped. On both channels, every path (the launcher, the XML2 Fix, the builder)
  downloads the chosen release's files by its tag - never `releases/latest/download` once a release was chosen, so
  a manifest and its files always come from one release - with the same checks as before (SHA256SUMS.txt for the
  launcher, the manifests' hashes for the fix and the builder). When GitHub can't be asked (offline, its limit on
  checks), each channel uses its own last choice for that repository and Settings says so; a check that failed
  with no earlier result is said too ("could not check …, and there is no earlier result to use"). Only into a
  folder with no XML2 Fix (or a PC with no builder) does an unanswered check fall back to the latest release's
  files, as 0.3 did, still checked by their hashes.
  - Every version comparison orders pre-releases now, `min_launcher` and the build's `requires.xml2fix` included:
    the XML2 Fix `1.8.0-beta.2` meets `>=1.7.1` but not `>=1.8.0` (online play takes 1.8.0's own betas on purpose:
    they have the rooms). The fix's own version resource is numeric, so the launcher records the release it
    installed and that is the fix's version while the DLL is still that file. A fix the launcher has no matching
    record for (a test kit copied by hand, reading `1.8.0` or `1.8.0.0`) is known only by its numbers: a release
    with the same three numbers (`1.8.0-beta.2`) installs over it as a repair on Beta, and on Stable Settings offers
    Switch back to Stable for it.
  - Nothing is ever installed over a newer version without asking, on either channel (an older Stable release
    never replaces a newer final fix either). Switching back to Stable with a beta newer than the latest release
    asks "You're on a beta (x). Switch back to y?": **Switch back** installs exactly the versions shown - the
    launcher's download, Verify in each XML2 Fix folder, the builder - each approved for that one attempt only (a
    Verify carries its folder's approval; nothing is stored). What each really did is read back: an item that
    failed or was cancelled stays as it was and is listed with why, and Switch back to Stable stays offered (it
    asks again). **Rebuild** is offered only once the builder and the port's fix it needed have both switched.
    **Keep the beta**, a channel change or a failed attempt revokes any approval not yet installed, so a later
    Play, Verify, retry or restart never downgrades.
  - Settings lists the launcher, the XML2 Fix (in each game's folder) and the builder with their exact versions;
    a pre-release has a **Beta** badge there, in the version line (with the channel), on the XML2 Fix line of a
    game page and in the X-Men Legends page's fix and builder rows.
  - **Online play on Stable:** with an XML2 Fix older than 1.8.0, the Online section says "Online play arrives with
    Legends Classic 0.3.0. Want to try it now? Switch Update channel to Beta in Settings." and has **Open Update
    channel** (Settings, the focus on the setting) instead of Verify Files, which has nothing newer to install on
    Stable. On Beta the Verify Files message stays.
  - **Online needs a build made for it:** with a 1.8 XML2 Fix in a port built by an older builder (its stamp's
    `requires.xml2fix` below `1.8.0-0`, whatever `GameVersion` the build has: 0.2.4 and 0.2.5 builds have one; a
    stamp without a requirement needs both `GameVersion` and `Broker` in `[Online]`), the Online section says "Rebuild to play online: this
    build is older than your XML2 Fix" with **Rebuild**, and Host and Join are refused by the launcher too.
  - **Launcher pre-releases:** a `v<x.y.z>-beta.<n>` or `-rc.<n>` tag publishes a GitHub pre-release that is never
    the latest release, with the same asset names (`ultimate-legends-<version>-win64-portable.zip`,
    `SHA256SUMS.txt`), its notes `docs/release/v<base>-notes.md` under a "Beta - test build" banner
    (`tools/release_tag.py`, self-tested in every Build run). Stable `v*` tags publish as before; any other suffix,
    and upper case (`-Beta.1`), is refused. After publishing, the job checks what GitHub shows and fails unless the
    tag's release has its pre-release flag and every file and, for a pre-release, `releases/latest` is unchanged; a
    re-run uploads the files again with `--clobber` instead of making a new release (`tools/publish_release.py`). A launcher built at such a tag calls itself `x.y.z-beta.n` wherever it shows or compares its own
    version; its VERSIONINFO stays numeric.

### Changed
- **Play (and every start that isn't the Online section's: the library, `-launch`, `ultimatelegends://play`) removes
  `[Online]` `Host`, `Public`, `RoomName` and `JoinCode`** from the port's `xml2-fix.ini` before the start, so a
  normal start never opens a room (the XML2 Fix also removes them when the game starts). A file without them is not touched. A leftover
  `online-status.json` is deleted before every start the launcher makes; when it can't be (another program holds it
  open), the start is refused with a message instead of going ahead with an earlier game's room in place.

## 0.3.2 - 2026-10-18

### Added
- **Test mode for X-Men Legends (Legends Classic port), for testers.** A Test mode section on the port's page
  switches the XML2 Fix's `[TestMode]` keys in the port's `xml2-fix.ini`, so nobody has to edit the file by hand
  (on a Steam Deck, say):
  - **Forge at every Xtraction point** (`ForgeEverywhere`) and **Test hotkeys F8/F9/F10** (`Hotkeys`), off by
    default. Each toggle writes its own key, as `1` or `0`, and nothing else: every other key and section of the
    file (the builder's `[Game]` / `[Limits]` / `[Online]`, the player's `[Display]` / `[Discord]`) stays byte for
    byte, comments included.
  - While either is on, the XML2 Fix turns online play off; the section says so, and a **Test mode on** badge
    under Play shows it, with **Turn test mode off**.
  - The game reads the keys when it starts. They need XML2 Fix 1.6.0 or later; with an older fix in the folder,
    the section says the switches are ignored.
  - The toggles are buttons the keyboard reaches (Tab, then Enter or Space), with a visible focus ring, so a
    controller mapped to the keyboard, a touchscreen or a mouse all work.
  - Nothing is written while a build runs in the folder. Rebuild, Repair, Verify Files and the XML2 Fix update
    before a build keep the keys; Uninstall deletes `xml2-fix.ini`, test mode with it, as before.

### Fixed
- **X-Men Legends: Display and Discord changes are no longer lost to a build.** The builder merges its own keys into
  the port's `xml2-fix.ini` (it reads the file, changes it and puts it back), so a Display or Discord change saved
  while it held the folder could be overwritten with the file as the builder had read it. Like Test mode:
  - The launcher writes neither section while the builder holds the folder. A change that reaches it anyway (a
    build started between the click and the save) is refused with a message, and the section shows the file again.
  - On the X-Men Legends page, the Display and Discord controls are disabled while a build runs or starts, with a
    status line, and come back with what the file holds when it ends.
  - X-Men Legends II, MUA and MUA2 in their own folders are not affected. The `[Display]` defaults a first build
    writes are still written.

## 0.3.1 - 2026-10-18

### Added
- The X-Men Legends builder installs from a zip the player already has (chosen in the setup, or found in Downloads
  or `tools\xml1-builder`), checked like a download; a damaged one in `tools\xml1-builder` no longer hides the one in
  Downloads.
- Verify Files for an unfinished X-Men Legends build: installs or updates its XML2 Fix without marking the game
  playable.
- The page shows `W_XML2FIX_OLD` (an XML2 Fix older than the build needs) with its count, in en/fr/es.

### Fixed
- A build first brings the XML2 Fix in its folder up to date, and nothing else writes that folder meanwhile: one
  hold per folder for the builder and every updater (Verify, a launch's update, Uninstall, the pre-build update),
  whatever game entry asks. Rebuild, Resume, Repair, Install the XML2 Fix and Verify Files wait for patch work under
  way; Uninstall waits for it before the clean.
- Display: Fullscreen clears Width/Height to the game's own Video options; Fullscreen left again before the save
  keeps the windowed size.
- Self-update: the swap's retries are bounded in time, and every start logs to `updates\update.log`.
- Rebuild wording for an update available; fr/es get their first X-Men Legends strings.

## 0.3.0 (2026-10-04)

### Added
- Game pages show the patch's installed release and offer a newer one.
- A Discord section on the MUA and MUA2 pages (MUA Controller Fix's `[Discord]`: Rich Presence, the area, the hero);
  the pages mention Discord and mods.

### Fixed
- `mua-controller-fix.ini` values are read as MUA Controller Fix reads them: a comment starts at `;` or `#`.
