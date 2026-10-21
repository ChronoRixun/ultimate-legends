#pragma once

#include <chrono>
#include <filesystem>
#include <optional>
#include <string>

// online-status.json next to the X-Men Legends port's exe: written by the XML2 Fix (atomically, on every state
// change), read by the launcher's Online section, and deleted by the launcher before every start it makes (the
// launcher <-> XML2 Fix contract), so the page never takes an earlier game's room for this one.
//
// Only the standard library (the unit tests build it on their own, also on Windows, where a file held open
// without delete sharing is the case that matters: src/tests/online_launch_tests.cpp).
namespace online_status
{
    constexpr auto file_name = L"online-status.json";

    std::filesystem::path path(const std::filesystem::path& game_dir);

    // Deletes the file in `game_dir`; true when none is left. A file that can't be deleted (held open by another
    // program without delete sharing, read-only...) is tried again a few times, `wait` apart, then reported in
    // `error` - the start that needed it gone is then refused, never made with the old file in place.
    bool clear(const std::filesystem::path& game_dir, std::string& error, int attempts = 5,
               std::chrono::milliseconds wait = std::chrono::milliseconds(40));

    // The file's text, or nullopt when there is none (or it is unreasonably large: the fix writes a small object).
    std::optional<std::string> read(const std::filesystem::path& game_dir);
}
