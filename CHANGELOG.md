# Changelog

The launcher's version comes from its release tag (`v0.3.2`): premake reads it with `git describe` when it
generates the project, so a release only needs this entry and the tag.

## 0.3.3 (unreleased)

### Added
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

## 0.3.2 (unreleased)

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

## 0.3.1 (unreleased)

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
