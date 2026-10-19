#pragma once

#include "fix_ini.hpp"
#include "online_rules.hpp"

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Online play of the X-Men Legends port (which games: fix_ini's table, fix::online), the launcher's
// side of the launcher <-> XML2 Fix contract (v1); the rules are online_rules.hpp's.
//
// - xml2-fix.ini [Online]: Host=broker or JoinCode=<code> for the next game start, written key by key
//   through fix_ini (WritePrivateProfileStringW, like [Display], [Discord] and [TestMode]): every other
//   key and section, the builder's Broker / BrokerPin among them, stays byte for byte.
// - online-status.json next to the game's exe: written by the fix (atomically, on every state change),
//   read by the launcher. The launcher deletes a stale one before a Host or Join start.
namespace online_settings
{
    constexpr auto section = L"Online";
    constexpr auto status_file = L"online-status.json";

    // The Host / JoinCode values present in the ini (as written, without an inline comment, trimmed).
    std::map<std::string, std::string> read(const std::filesystem::path& ini, const fix_ini::fix& fix);

    // Writes `changes` to [Online]. Only Host (= broker) and JoinCode (a valid code, written normalised)
    // are taken, or removed; anything else is refused before a write.
    bool write(const std::filesystem::path& ini, const fix_ini::fix& fix, const std::vector<online_rules::change>& changes,
               std::string& error);

    // The keys for the next start in `mode` (online_rules::changes_for): Host or JoinCode and the other
    // removed, or both removed for a normal start. `code` is the player's text, for join. Nothing is
    // written (and no ini created) when there is nothing to change.
    bool prepare(const std::filesystem::path& ini, const fix_ini::fix& fix, online_rules::mode mode, const std::string& code,
                 std::string& error);

    // The fix's test mode is on (either [TestMode] switch reads as on): the fix then refuses online play.
    bool test_mode_on(const std::filesystem::path& ini, const fix_ini::fix& fix);

    std::filesystem::path status_path(const std::filesystem::path& game_dir);

    // Deletes online-status.json in `game_dir`; true when none is left.
    bool clear_status(const std::filesystem::path& game_dir, std::string& error);

    // The status file's text, or nullopt when there is none (or it is unreasonably large).
    std::optional<std::string> read_status(const std::filesystem::path& game_dir);
}
