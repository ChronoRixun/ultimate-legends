#pragma once

#include "fix_ini.hpp"

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Test mode of the XML2 Fix (1.6.0 on), for testers: the [TestMode] section of xml2-fix.ini in the
// game folder (which games the launcher offers it for comes from fix_ini's table, fix::test_mode: the
// X-Men Legends port). The fix reads it once, when the game starts:
//
//   [TestMode]
//   ForgeEverywhere = 0 | 1   ; the Forge appears at every Xtraction point. Absent = 0
//   Hotkeys = 0 | 1           ; the F8 / F9 / F10 test hotkeys. Absent = 0
//
// While either is on, the fix refuses online play (by design); nothing in the saves, the content or
// the network protocol changes. Every key defaults to off: the launcher shows an absent key as OFF and
// writes 1 or 0 when the tester flips a toggle, one key at a time through fix_ini (every other key and
// section - the builder's [Game] / [Online], the player's [Display] / [Discord] - stays as it was).
// Values are read as the fix reads them (fix_ini, the fix's comment_chars); an empty or unreadable
// value is the default, OFF.

namespace test_mode_settings
{
    constexpr auto section = L"TestMode";

    // The [TestMode] keys, in the order the launcher shows them.
    const std::vector<std::string>& keys();

    // What an absent key means: every key defaults to off.
    constexpr bool default_value = false;

    // The [TestMode] values present in the ini, by key (as written, without an inline comment,
    // trimmed). Missing or empty = absent.
    std::map<std::string, std::string> read(const std::filesystem::path& ini, const fix_ini::fix& fix);

    // "1" / "0" for one of the keys and a flag value (1/0, true/false, on/off, yes/no), or nullopt
    // with `error` set. Any other key is refused: the UI writes only these two.
    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error);

    struct change
    {
        std::string key;
        std::optional<std::string> value; // nullopt removes the key (back to the default, off)
    };

    // Writes every change (validated first, so nothing is written when one is bad). Creates the
    // ini when it does not exist yet.
    bool write(const std::filesystem::path& ini, const fix_ini::fix& fix, const std::vector<change>& changes, std::string& error);
}
