#include "std_include.hpp"
#include "xml2_display.hpp"
#include "fix/fix_ini.hpp"

#include <utils/string.hpp>

#include <algorithm>
#include <charconv>

namespace xml2_display
{
    namespace
    {
        constexpr auto section = L"Display";

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
    }

    const std::vector<std::string>& keys()
    {
        static const std::vector<std::string> list{"Mode", "Width", "Height", "Topmost", "RunInBackground", "FrameRate", "VSync"};
        return list;
    }

    std::map<std::string, std::string> read(const std::filesystem::path& ini)
    {
        return fix_ini::read(ini, section, keys());
    }

    std::optional<std::string> normalise(const std::string& key, const std::string& raw, std::string& error)
    {
        const auto value = fix_ini::trim(raw);
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
            if (const auto flag = fix_ini::parse_flag(value))
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

    bool write(const std::filesystem::path& ini, const std::vector<change>& changes, std::string& error)
    {
        fix_ini::changes prepared;
        for (const auto& change : changes)
        {
            if (std::find(keys().begin(), keys().end(), change.key) == keys().end())
            {
                error = "Unknown display setting: " + change.key;
                return false;
            }
            std::optional<std::string> value;
            if (change.value)
            {
                value = normalise(change.key, *change.value, error);
                if (!value)
                {
                    return false;
                }
            }
            prepared.emplace_back(change.key, std::move(value));
        }
        return fix_ini::write(ini, section, prepared, error);
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
