#pragma once

#include <rapidjson/document.h>

#include <filesystem>
#include <string>
#include <vector>

// Support page (app/support-view.js): the facts behind Copy diagnostics, the log folders the page
// opens, and the clipboard. Everything here is read locally (no network, nothing written); every
// string of the diagnostics goes through support::redact (no user name, profile folder, computer
// name or Linux home), a game's folder is shown by its name only, and there are no account names,
// IDs, join codes or addresses in it.
namespace support
{
    // { launcher: { version, channel, portable, offline, dataFolder }, system: { wine, wineVersion, steamDeck,
    //   windows, build, monitors, primary: { width, height, refresh, dpi, scale } },
    //   games: [ { id, name, configured, installed, folder, fix: { name, version, runtime }, display: { mode, width,
    //   height, resolution, proton }, build: { builder, builderInstalled, content } } ], logs: [ ...write_logs ] }
    void write_diagnostics(rapidjson::Document& out);

    // Remembers the primary monitor's scaling while its desktop mode is in use (called at launcher start), so
    // a report made while a fullscreen game changed the mode still shows the desktop's scaling.
    void remember_display();

    struct log_location
    {
        std::string id;   // "launcher", "updates", "fix:<game key>", "builder"
        std::string game; // the game key, empty for the launcher's own logs
        std::string file; // the log's file name, as shown ("muac-fix.log")
        bool available{}; // the file is there
        std::filesystem::path path; // the file (never sent to the UI)
    };

    // The launcher's logs, then the companion fix's log of each installed game and the X-Men Legends
    // builder's latest log.
    std::vector<log_location> logs();
    // [ { id, game, file, available } ]
    void write_logs(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);
    // Opens the folder that holds log `id` (with the file selected on Windows). False when the log
    // isn't there or the shell refused.
    bool open_log(const std::string& id);

    // Puts `text` (UTF-8) on the clipboard as Unicode text. False when the clipboard is busy.
    bool copy_text(const std::string& text, void* owner_window);
}
