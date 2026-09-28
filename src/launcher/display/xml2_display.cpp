#include "std_include.hpp"
#include "xml2_display.hpp"

#include <utils/io.hpp>
#include <utils/string.hpp>

#include <algorithm>
#include <charconv>

namespace xml2_display
{
    namespace
    {
        constexpr auto section = L"Display";

        // GetPrivateProfileStringW returns the default when the key is missing; a value no ini would
        // hold tells the two apart (an empty value is reported as absent too).
        constexpr auto absent_marker = L"\x01";

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

        std::optional<int> parse_int(const std::string& text)
        {
            if (text.empty() || text.size() > 6)
            {
                return std::nullopt;
            }
            int value{};
            const auto [end, ec] = std::from_chars(text.data(), text.data() + text.size(), value);
            if (ec != std::errc{} || end != text.data() + text.size())
            {
                return std::nullopt;
            }
            return value;
        }

        // 0/1 (and true/false/on/off, for hand-edited files) -> "0" / "1".
        std::optional<std::string> parse_flag(const std::string& text)
        {
            const auto lower = utils::string::to_lower(text);
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
    }

    const std::vector<std::string>& keys()
    {
        static const std::vector<std::string> list{"Mode", "Width", "Height", "Topmost", "RunInBackground", "FrameRate", "VSync"};
        return list;
    }

    std::filesystem::path ini_path(const std::filesystem::path& game_dir)
    {
        return game_dir / ini_name;
    }

    bool fix_installed(const std::filesystem::path& game_dir)
    {
        return utils::io::file_exists(game_dir / fix_dll_name);
    }

    std::map<std::string, std::string> read(const std::filesystem::path& game_dir)
    {
        std::map<std::string, std::string> values;
        const auto ini = ini_path(game_dir).wstring();
        if (!utils::io::file_exists(ini))
        {
            return values;
        }

        for (const auto& key : keys())
        {
            wchar_t buffer[128]{};
            GetPrivateProfileStringW(section, utils::string::convert(key).c_str(), absent_marker, buffer, static_cast<DWORD>(std::size(buffer)), ini.c_str());
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

    std::optional<std::string> normalise(const std::string& key, const std::string& raw, std::string& error)
    {
        const auto value = trim(raw);
        if (key == "Mode")
        {
            const auto lower = utils::string::to_lower(value);
            if (lower == "fullscreen" || lower == "borderless" || lower == "windowed")
            {
                return lower;
            }
            error = "Mode must be fullscreen, borderless or windowed.";
            return std::nullopt;
        }
        if (key == "Width" || key == "Height")
        {
            const auto number = parse_int(value);
            if (number && *number >= 0 && *number <= 16384)
            {
                return std::to_string(*number);
            }
            error = key + " must be a size in pixels, or 0 for the game's own setting.";
            return std::nullopt;
        }
        if (key == "Topmost" || key == "RunInBackground" || key == "VSync")
        {
            if (const auto flag = parse_flag(value))
            {
                return flag;
            }
            error = key + " must be 0 or 1.";
            return std::nullopt;
        }
        if (key == "FrameRate")
        {
            const auto lower = utils::string::to_lower(value);
            if (lower == "refresh")
            {
                return lower;
            }
            const auto number = parse_int(value);
            if (number && *number >= 0 && *number <= 1000)
            {
                return std::to_string(*number);
            }
            error = "FrameRate must be a number of frames per second, 0 for unlimited, or refresh.";
            return std::nullopt;
        }
        error = "Unknown display setting: " + key;
        return std::nullopt;
    }

    bool write(const std::filesystem::path& game_dir, const std::vector<change>& changes, std::string& error)
    {
        std::vector<std::pair<std::wstring, std::optional<std::wstring>>> prepared;
        for (const auto& change : changes)
        {
            if (std::find(keys().begin(), keys().end(), change.key) == keys().end())
            {
                error = "Unknown display setting: " + change.key;
                return false;
            }
            std::optional<std::wstring> value;
            if (change.value)
            {
                const auto normalised = normalise(change.key, *change.value, error);
                if (!normalised)
                {
                    return false;
                }
                value = utils::string::convert(*normalised);
            }
            prepared.emplace_back(utils::string::convert(change.key), std::move(value));
        }

        if (!utils::io::directory_exists(game_dir))
        {
            error = "The game folder is missing.";
            return false;
        }

        const auto ini = ini_path(game_dir).wstring();
        for (const auto& [key, value] : prepared)
        {
            // A null value deletes the key; other keys, sections and comments are kept.
            if (!WritePrivateProfileStringW(section, key.c_str(), value ? value->c_str() : nullptr, ini.c_str()))
            {
                error = "xml2-fix.ini could not be written (error " + std::to_string(GetLastError()) + ").";
                return false;
            }
        }
        // Flush the profile cache so the game, or anything else, reads the file as written.
        WritePrivateProfileStringW(nullptr, nullptr, nullptr, ini.c_str());
        return true;
    }

    std::vector<display_mode> display_modes()
    {
        std::vector<display_mode> modes;
        DEVMODEW dm{};
        dm.dmSize = sizeof(dm);
        for (DWORD i = 0; EnumDisplaySettingsW(nullptr, i, &dm); ++i)
        {
            if (dm.dmBitsPerPel != 32 || dm.dmPelsWidth < 640 || dm.dmPelsHeight < 480)
            {
                continue;
            }
            const display_mode mode{static_cast<int>(dm.dmPelsWidth), static_cast<int>(dm.dmPelsHeight)};
            const auto known = std::any_of(modes.begin(), modes.end(), [&](const display_mode& m) { return m.width == mode.width && m.height == mode.height; });
            if (!known)
            {
                modes.push_back(mode);
            }
        }
        std::sort(modes.begin(), modes.end(), [](const display_mode& a, const display_mode& b)
        {
            return a.width != b.width ? a.width < b.width : a.height < b.height;
        });
        return modes;
    }

    desktop_mode desktop()
    {
        DEVMODEW dm{};
        dm.dmSize = sizeof(dm);
        if (!EnumDisplaySettingsW(nullptr, ENUM_CURRENT_SETTINGS, &dm))
        {
            return {GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN), 0};
        }
        // 0 and 1 both mean "the hardware default" to EnumDisplaySettings.
        const auto refresh = dm.dmDisplayFrequency > 1 ? static_cast<int>(dm.dmDisplayFrequency) : 0;
        return {static_cast<int>(dm.dmPelsWidth), static_cast<int>(dm.dmPelsHeight), refresh};
    }
}
