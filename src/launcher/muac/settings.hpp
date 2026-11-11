#pragma once
#include <cstdint>
#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>
#include "platform.hpp"

namespace muac {
    // Without MUA Classic Fix 0.1.2 the retail game only knows 14 sizes (640x480 ... 1920x1200,
    // 2048x1536); any other saved size makes its startup mode lookup read past its list (#31).
    inline constexpr auto resolution_message = "This MUA Classic Fix version can start MUA 2006 only at the game's original resolutions (up to 1920x1200, plus 2048x1536). Other sizes, such as 2560x1440 or 3840x2160, crash at startup without MUA Classic Fix 0.1.2 or newer. Choose an original resolution or update MUA Classic Fix.";
    inline constexpr std::uint64_t resolution_guard_version = 0x0000000100020000ULL; // 0.1.2
    bool retail_resolution(const std::string& value);
    // dgVoodoo [DirectXExt] ExtraEnumeratedResolutions entry for a saved size.
    std::string dgvoodoo_mode(const std::string& resolution);
    bool resolution_supported(const std::string& value, bool guard);
    // True when the installed dinput8.dll is MUA Classic Fix 0.1.2 or newer (resolution guard).
    bool resolution_guard(const std::filesystem::path& folder);
    using values = std::map<std::string, std::string>;
    values read(const std::filesystem::path& folder, bool wine = platform::is_wine());
    std::optional<std::string> normalise(const std::string& key, const std::string& value);
    std::vector<std::string> missing_runtime(const std::filesystem::path& folder, bool wine = platform::is_wine());
    bool write(const std::filesystem::path& folder, const values& changes, std::string& error, bool wine = platform::is_wine());
    // Keeps dgVoodoo listing the saved size (for values saved by the game or an older launcher).
    bool enumerate_saved_resolution(const std::filesystem::path& folder, std::string& error, bool wine = platform::is_wine());
}
