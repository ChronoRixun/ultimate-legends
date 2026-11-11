#pragma once
#include <array>
#include <filesystem>
#include <string_view>

namespace muac {
    // The 2006 PC game root, independent of the retailer, importer or runtime stamp.
    // Marvel.exe belongs to the separate 2016 Steam release.
    inline bool valid_install(const std::filesystem::path& folder) {
        constexpr std::array<std::string_view, 5> files = {
            "Game.exe", "libIGCore.dll", "libIGGfx.dll", "data/herostat.engb", "build.ini"
        };
        for (const auto file : files) {
            std::error_code error;
            if (!std::filesystem::is_regular_file(folder / file, error) || error) return false;
        }
        return true;
    }
}
