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
//      (updates\applying.json) written first. A failed rename rolls every step back; a start that
//      finds the journal (a crash or power cut mid-swap) rolls back too. Then the new launcher is
//      started and deletes updates\previous\.
//
// Never touched: user\ (settings, CEF profile), tools\, cache\, mods, logs, portable.marker, and
// the %LOCALAPPDATA% data of a non-portable launcher (that one only links to the release page).
// Development builds (Debug, or not built exactly at a release tag) never update.
namespace launcher_update
{
    // Startup, before CEF and after the single-instance lock: rolls back an interrupted swap,
    // installs a downloaded update. True when the executable changed: the caller must start it
    // (relaunch()) and exit.
    bool apply_pending();

    // Starts the launcher's executable again with this process's -flags.
    void relaunch();

    // Startup, after apply_pending(): deletes what an earlier update left (the previous version,
    // interrupted downloads) in the background.
    void cleanup();

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
