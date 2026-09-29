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

        // The XML2 Fix (github.com/ChronoRixun/xml2-fix). The X-Men Legends port will run on the
        // same fix: its entry gets the same fix, with the sections its build supports.
        const fix xml2_fix{
            .name = "XML2 Fix",
            .dll = L"dinput.dll",
            .ini = L"xml2-fix.ini",
            .display = true,
            .presence = true,
        };

        const std::map<std::string, const fix*>& fixes()
        {
            static const std::map<std::string, const fix*> table{
                {"xml2", &xml2_fix},
            };
            return table;
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
                                            const std::vector<std::string>& keys)
    {
        std::map<std::string, std::string> values;
        const auto file = ini.wstring();
        if (!utils::io::file_exists(ini))
        {
            return values;
        }

        for (const auto& key : keys)
        {
            wchar_t buffer[256]{};
            GetPrivateProfileStringW(section.c_str(), utils::string::convert(key).c_str(), absent_marker, buffer,
                                     static_cast<DWORD>(std::size(buffer)), file.c_str());
            const std::wstring wide{buffer};
            if (wide == absent_marker)
            {
                continue;
            }
            const auto value = trim(utils::string::convert(wide));
            if (!value.empty())
            {
                values[key] = value;
            }
        }
        return values;
    }

    bool write(const std::filesystem::path& ini, const std::wstring& section, const changes& changes, std::string& error)
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
            const auto wide_value = value ? std::optional{utils::string::convert(*value)} : std::nullopt;

            // A null value deletes the key; other keys, sections and comments are kept.
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
