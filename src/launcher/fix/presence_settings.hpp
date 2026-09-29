#pragma once

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Discord Rich Presence of a game's fix: the [Discord] section of its ini (xml2-fix.ini for the
// XML2 Fix; which games have it comes from fix_ini's table, fix::presence). The fix talks to the
// Discord app on the player's PC while the game runs:
//
//   [Discord]
//   Enabled = 1 | 0     ; show the game on the player's Discord profile. Absent = 1
//   ShowZone = 1 | 0    ; ...with the zone they are in. Absent = 1
//   ShowParty = 1 | 0   ; ...and their party. Absent = 1
//
// Presence is on by default: the launcher shows an absent key as ON and writes 1 or 0 when the
// player flips a toggle, one key at a time through fix_ini (the rest of the file is kept).

namespace presence_settings
{
    constexpr auto section = L"Discord";

    // The [Discord] keys, in the order the launcher shows them.
    const std::vector<std::string>& keys();

    // What an absent key means: every key defaults to on.
    constexpr bool default_value = true;

    // The [Discord] values present in the ini, by key (as written, trimmed). Missing = absent.
    std::map<std::string, std::string> read(const std::filesystem::path& ini);

    // "1" / "0" for a known key and a flag value (1/0, true/false, on/off, yes/no), or nullopt with
    // `error` set.
    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error);

    struct change
    {
        std::string key;
        std::optional<std::string> value; // nullopt removes the key (back to the default, on)
    };

    // Writes every change (validated first, so nothing is written when one is bad). Creates the
    // ini when it does not exist yet.
    bool write(const std::filesystem::path& ini, const std::vector<change>& changes, std::string& error);
}
