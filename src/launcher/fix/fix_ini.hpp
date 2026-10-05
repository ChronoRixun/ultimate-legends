#pragma once

#include <game_config.hpp>

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The settings file of a game's fix: the XML2 Fix (dinput.dll) reads xml2-fix.ini next to the
// game's exe, MUA Controller Fix (dinput8.dll) mua-controller-fix.ini. The launcher's sections for
// them (Display, Discord) all go through here, so a game whose fix reads the same kind of file only
// needs an entry in the table in fix_ini.cpp: the X-Men Legends port runs on the XML2 engine with
// the same fix, and both MUA games share MUA Controller Fix.
//
// Files are read and written with the Windows profile API (Get/WritePrivateProfileStringW), the
// same one the fixes use, one key at a time: every other key, section, comment and blank line
// stays exactly where it was, and the file is created when it does not exist yet.
//
// A value is read the way the XML2 Fix reads it (its ini_rules.hpp, one rule for every key): the
// text after '=' up to the first ';' (the Windows INI comment character), trimmed, so
// "Enabled=0   ; off for now" is 0. A '#' is part of the value: "Enabled=0 # later" is not a flag,
// so the key's default, as in the game. A missing or empty value is "not set" (the key's default).
// Rewriting a value keeps the line's inline comment.

namespace fix_ini
{
    struct fix
    {
        std::string name; // as the UI names it: "XML2 Fix"
        std::wstring dll; // the fix itself, next to the game's exe; without it nothing reads the ini
        std::wstring ini; // the settings file, in the same folder

        // The sections the launcher edits for this fix.
        bool display{};  // [Display], display/xml2_display.hpp (the XML2 engine's Direct3D 8 options)
        bool presence{}; // [Discord], fix/presence_settings.hpp

        // The [Discord] switches the launcher shows for this fix, in order: Enabled, then what it
        // shares (the XML2 Fix's ShowZone and ShowParty, MUA Controller Fix's ShowZone and ShowHero).
        std::vector<std::string> presence_keys{};
    };

    // The fix of the game with this key (game_config's game_key), or nullptr when the game's fix
    // has no settings file the launcher edits.
    const fix* find(const std::string& game_key);

    std::filesystem::path ini_path(const std::filesystem::path& game_dir, const fix& fix);
    bool installed(const std::filesystem::path& game_dir, const fix& fix);

    // A game's fix, as far as the game's setup goes.
    struct location
    {
        const fix* info{};                             // nullptr: no settings file (or no such game)
        std::optional<std::filesystem::path> game_dir; // set when the game's folder exists
        bool fix_installed{};

        std::optional<std::filesystem::path> ini() const;
    };

    location locate(const std::optional<game_config::game_config_t>& config);

    std::string trim(std::string text);

    // 0/1 (and true/false, on/off, yes/no, in any case, for hand-edited files) -> "0" / "1".
    std::optional<std::string> parse_flag(const std::string& text);

    // The values of `keys` present in [section], as written without an inline comment ("0   ; off"
    // -> "0"), trimmed. A missing key, or one with an empty value, is left out (the fixes read both
    // as "not set").
    std::map<std::string, std::string> read(const std::filesystem::path& ini, const std::wstring& section,
                                            const std::vector<std::string>& keys);

    // key -> value; nullopt removes the key.
    using changes = std::vector<std::pair<std::string, std::optional<std::string>>>;

    // Writes each key into [section] (creating the section, and the file, when needed) and flushes
    // the profile cache, so the game reads the file as written. A key's inline comment stays after
    // its new value ("0   ; off for now" -> "1   ; off for now"); removing a key removes its line.
    // Validation is the caller's, and a value must not hold a ';' itself.
    bool write(const std::filesystem::path& ini, const std::wstring& section, const changes& changes, std::string& error);
}
