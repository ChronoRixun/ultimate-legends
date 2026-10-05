#include "std_include.hpp"
#include "fix_ini.hpp"

#include <utils/io.hpp>
#include <utils/string.hpp>

namespace fix_ini
{
    namespace
    {
        // GetPrivateProfileStringW returns the default when the key is missing; a value no ini would
        // hold tells the two apart.
        constexpr auto absent_marker = L"\x01";

        // The XML2 Fix (github.com/ChronoRixun/xml2-fix). The X-Men Legends port runs on the same
        // fix, with its own xml2-fix.ini in the built folder: the builder writes the port's
        // [Game] and [Limits] keys there, the launcher the player's [Display] and [Discord].
        const fix xml2_fix{
            .name = "XML2 Fix",
            .dll = L"dinput.dll",
            .ini = L"xml2-fix.ini",
            .display = true,
            .presence = true,
            .presence_keys = {"Enabled", "ShowZone", "ShowParty"},
            .comment_chars = L";",
        };

        // MUA Controller Fix (github.com/ChronoRixun/mua-controller-fix), for both MUA games. Its
        // [Discord] section (1.1.0 on) shows the game's own status line, the area and player 1's hero.
        // It reads a value up to the first ';' or '#' (its discord_rules.hpp value_text).
        const fix mua_fix{
            .name = "MUA Controller Fix",
            .dll = L"dinput8.dll",
            .ini = L"mua-controller-fix.ini",
            .display = false,
            .presence = true,
            .presence_keys = {"Enabled", "ShowZone", "ShowHero"},
            .comment_chars = L";#",
        };

        const std::map<std::string, const fix*>& fixes()
        {
            static const std::map<std::string, const fix*> table{
                {"xml2", &xml2_fix},
                {"xml1", &xml2_fix},
                {"mua", &mua_fix},
                {"mua2", &mua_fix},
            };
            return table;
        }

        bool is_space(const wchar_t c)
        {
            return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n';
        }

        // Everything after '=' as the profile API has it (the spaces around it trimmed, an inline
        // comment kept), or nullopt when the key is missing. The buffer grows for a long comment,
        // so a rewrite keeps all of it.
        std::optional<std::wstring> raw_value(const std::wstring& file, const std::wstring& section, const std::wstring& key)
        {
            std::vector<wchar_t> buffer(256);
            DWORD length{};
            while (true)
            {
                length = GetPrivateProfileStringW(section.c_str(), key.c_str(), absent_marker, buffer.data(),
                                                  static_cast<DWORD>(buffer.size()), file.c_str());
                // A value that fills the buffer comes back as size - 1 characters: it may be longer.
                if (length + 1 < buffer.size() || buffer.size() >= 64 * 1024)
                {
                    break;
                }
                buffer.resize(buffer.size() * 4);
            }

            std::wstring text(buffer.data(), length);
            if (text == absent_marker)
            {
                return std::nullopt;
            }
            return text;
        }

        // The value part of `raw`: up to its inline comment (the first of `comments`), trimmed.
        std::wstring value_part(const std::wstring& raw, const std::wstring& comments)
        {
            auto end = std::min(raw.find_first_of(comments), raw.size());
            while (end > 0 && is_space(raw[end - 1]))
            {
                --end;
            }
            std::size_t start = 0;
            while (start < end && is_space(raw[start]))
            {
                ++start;
            }
            return raw.substr(start, end - start);
        }

        // The text to write for a key whose line now reads `raw`: the new value, followed by the old
        // line's inline comment and the spaces before it ("0   ; off for now" -> "1   ; off for now").
        std::wstring with_comment(const std::wstring& value, const std::optional<std::wstring>& raw, const std::wstring& comments)
        {
            if (!raw)
            {
                return value;
            }
            const auto comment = raw->find_first_of(comments);
            if (comment == std::wstring::npos)
            {
                return value;
            }

            auto value_end = comment;
            while (value_end > 0 && is_space((*raw)[value_end - 1]))
            {
                --value_end;
            }
            if (value_end == 0)
            {
                // "Key=   ; note" had no value (the profile API drops the spaces before the ';').
                return value + L" " + raw->substr(comment);
            }
            return value + raw->substr(value_end);
        }
    }

    const fix* find(const std::string& game_key)
    {
        const auto it = fixes().find(game_key);
        return it == fixes().end() ? nullptr : it->second;
    }

    std::filesystem::path ini_path(const std::filesystem::path& game_dir, const fix& fix)
    {
        return game_dir / fix.ini;
    }

    bool installed(const std::filesystem::path& game_dir, const fix& fix)
    {
        return utils::io::file_exists(game_dir / fix.dll);
    }

    std::optional<std::filesystem::path> location::ini() const
    {
        if (!this->info || !this->game_dir)
        {
            return std::nullopt;
        }
        return ini_path(*this->game_dir, *this->info);
    }

    location locate(const std::optional<game_config::game_config_t>& config)
    {
        location result{};
        if (!config)
        {
            return result;
        }
        result.info = find(config->get_game_key());
        if (!result.info)
        {
            return result;
        }

        const auto path = config->get_install_path();
        if (path && !path->empty() && utils::io::directory_exists(*path))
        {
            result.game_dir = *path;
            result.fix_installed = installed(*path, *result.info);
        }
        return result;
    }

    std::string trim(std::string text)
    {
        while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back())))
        {
            text.pop_back();
        }
        std::size_t start = 0;
        while (start < text.size() && std::isspace(static_cast<unsigned char>(text[start])))
        {
            ++start;
        }
        return text.substr(start);
    }

    std::optional<std::string> parse_flag(const std::string& text)
    {
        const auto lower = utils::string::to_lower(trim(text));
        if (lower == "1" || lower == "true" || lower == "on" || lower == "yes")
        {
            return "1";
        }
        if (lower == "0" || lower == "false" || lower == "off" || lower == "no")
        {
            return "0";
        }
        return std::nullopt;
    }

    std::map<std::string, std::string> read(const std::filesystem::path& ini, const std::wstring& section,
                                            const std::vector<std::string>& keys, const std::wstring& comments)
    {
        std::map<std::string, std::string> values;
        const auto file = ini.wstring();
        if (!utils::io::file_exists(ini))
        {
            return values;
        }

        for (const auto& key : keys)
        {
            const auto raw = raw_value(file, section, utils::string::convert(key));
            if (!raw)
            {
                continue;
            }
            // "Enabled=0   ; off for now" is 0, as the fix reads it; "Enabled=   ; note" is not set.
            const auto value = value_part(*raw, comments);
            if (!value.empty())
            {
                values[key] = utils::string::convert(value);
            }
        }
        return values;
    }

    bool write(const std::filesystem::path& ini, const std::wstring& section, const changes& changes, std::string& error,
               const std::wstring& comments)
    {
        if (!utils::io::directory_exists(ini.parent_path()))
        {
            error = "The game folder is missing.";
            return false;
        }

        const auto file = ini.wstring();
        const auto name = utils::string::path_to_utf8(ini.filename());
        for (const auto& [key, value] : changes)
        {
            const auto wide_key = utils::string::convert(key);

            // A null value deletes the key (its line, comment and all); a new value replaces the old
            // one and keeps the line's inline comment. Other keys, sections and comments are kept.
            std::optional<std::wstring> wide_value;
            if (value)
            {
                wide_value = with_comment(utils::string::convert(*value), raw_value(file, section, wide_key), comments);
            }
            if (!WritePrivateProfileStringW(section.c_str(), wide_key.c_str(), wide_value ? wide_value->c_str() : nullptr, file.c_str()))
            {
                error = name + " could not be written (error " + std::to_string(GetLastError()) + ").";
                return false;
            }
        }
        // Flush the profile cache so the game, or anything else, reads the file as written.
        WritePrivateProfileStringW(nullptr, nullptr, nullptr, file.c_str());
        return true;
    }
}
