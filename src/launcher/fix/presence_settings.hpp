#pragma once

#include "fix_ini.hpp"

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Discord Rich Presence of a game's fix: the [Discord] section of its ini (xml2-fix.ini for the
// XML2 Fix, mua-controller-fix.ini for MUA Controller Fix; which games have it, and which switches,
// comes from fix_ini's table, fix::presence and fix::presence_keys). The fix talks to the Discord
// app on the player's PC while the game runs:
//
//   [Discord]
//   Enabled = 1 | 0     ; show the game on the player's Discord profile. Absent = 1
//   ShowZone = 1 | 0    ; ...with where they are in it. Absent = 1
//   ShowParty = 1 | 0   ; ...and their party (the XML2 Fix). Absent = 1
//   ShowHero = 1 | 0    ; ...and their hero (MUA Controller Fix). Absent = 1
//
// Presence is on by default: the launcher shows an absent key as ON and writes 1 or 0 when the
// player flips a toggle, one key at a time through fix_ini (the rest of the file is kept). Values
// are read as the fix reads them (fix_ini, the fix's comment_chars): an inline comment is ignored
// ("Enabled=0 ; x" is OFF; for MUA Controller Fix "Enabled=0 # x" too), and an empty or unreadable
// value is the default, ON.

namespace presence_settings
{
    constexpr auto section = L"Discord";

    // The fix's [Discord] keys, in the order the launcher shows them.
    const std::vector<std::string>& keys(const fix_ini::fix& fix);

    // What an absent key means: every key defaults to on.
    constexpr bool default_value = true;

    // The fix's [Discord] values present in the ini, by key (as written, without an inline comment,
    // trimmed). Missing or empty = absent.
    std::map<std::string, std::string> read(const std::filesystem::path& ini, const fix_ini::fix& fix);

    // "1" / "0" for one of the fix's keys and a flag value (1/0, true/false, on/off, yes/no), or
    // nullopt with `error` set.
    std::optional<std::string> normalise(const fix_ini::fix& fix, const std::string& key, const std::string& value, std::string& error);

    struct change
    {
        std::string key;
        std::optional<std::string> value; // nullopt removes the key (back to the default, on)
    };

    // Writes every change (validated first, so nothing is written when one is bad). Creates the
    // ini when it does not exist yet.
    bool write(const std::filesystem::path& ini, const fix_ini::fix& fix, const std::vector<change>& changes, std::string& error);
}
