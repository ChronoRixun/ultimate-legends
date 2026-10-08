#pragma once

#include <rapidjson/document.h>

#include <string>

// The launcher's self-update. A portable install (the release zip: ultimate-legends.exe next to
// ultimate-legends\portable.marker and ultimate-legends\data\{cef,launcher-ui}) checks GitHub's
// latest release, and when it is newer and the player says Update:
//
//   1. downloads the release's portable zip into ultimate-legends\updates\.staging-*, checks its
//      size and its SHA-256 against the release's SHA256SUMS.txt, unpacks it, and renames the
//      result to updates\ready\ (ultimate-legends.exe, data\..., update.json written last), so
//      updates\ready is either complete or absent. Nothing of the running launcher changes.
//   2. on the next start (or Restart now), before CEF loads and while it is the only launcher
//      process, swaps the executable and each folder of data\ (cef, launcher-ui) with the new ones
//      by renames on the same drive: the old ones go to updates\previous\, with a journal
//      (updates\applying.json, written durably) first. A failed rename rolls every step back; a
//      start that finds the journal (a crash or power cut mid-swap) rolls back too, working out
//      what moved from the disk. Then the new launcher starts; updates\previous\ stays until its
//      page is shown, and after two starts that never got that far the next one restores it.
//
// Never touched: user\ (settings, CEF profile), tools\, cache\, mods, logs, portable.marker, and
// the %LOCALAPPDATA% data of a non-portable launcher (that one only links to the release page).
// Development builds (Debug, or not built exactly at a release tag) never update.
namespace launcher_update
{
    enum class result
    {
        none,     // carry on starting
        relaunch, // the executable changed: start it (relaunch()) and exit
        stop,     // a swap could not be undone and the player was told what to do: exit
    };

    // Startup, before CEF and after the single-instance lock: rolls back an interrupted swap or a
    // new version whose first start never got its window up, installs a downloaded update.
    result apply_pending();

    // Starts the launcher's executable again with this process's -flags (tried a few times); false
    // when it could not be started, so the caller must not leave the player without a launcher.
    bool relaunch();

    // A start by relaunch(): the previous process may still hold the single-instance lock for a moment.
    bool is_restart();

    // Startup, after apply_pending(): reads what an earlier start left for the UI, deletes
    // interrupted downloads and leftovers.
    void cleanup();

    // The page is shown (main.js says so as soon as it is): a new version's first start
    // succeeded, so the previous version, kept as its way back until now, is deleted.
    void confirm_started();

    // Checks the latest release in the background (no-op while a check or download runs).
    void check();

    // Downloads, verifies and unpacks the latest release into updates\ready, in the background.
    // False when there is nothing to download or this install can't update itself.
    bool start_download();

    // Restart now: false with `error` ("busy", "not-ready") when it can't; else the process ends
    // shortly after (so the command's answer still reaches the UI) and the new start installs it.
    bool restart(std::string& error);

    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);
}
