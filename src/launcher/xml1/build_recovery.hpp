#pragma once

#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>

namespace xml1
{
    inline std::optional<std::string> completed_build_stamp(const std::filesystem::path& out)
    {
        std::error_code error;
        if (std::filesystem::exists(out / "_build" / "building.json", error) || error ||
            !std::filesystem::is_regular_file(out / "XMen2.exe", error) || error ||
            !std::filesystem::is_regular_file(out / "dinput.dll", error) || error) return std::nullopt;
        std::ifstream stream(out / "_build" / "stamp.json", std::ios::binary);
        if (!stream) return std::nullopt;
        const auto size = std::filesystem::file_size(out / "_build" / "stamp.json", error);
        if (error || size == 0 || size > 1024 * 1024) return std::nullopt;
        std::string stamp(static_cast<std::size_t>(size), '\0');
        stream.read(stamp.data(), static_cast<std::streamsize>(stamp.size()));
        if (!stream || stream.peek() != std::char_traits<char>::eof()) return std::nullopt;
        return stamp;
    }

    // The builder writes building.json before changing the game and replaces stamp.json on
    // completion. An early cancellation/start failure leaves the existing completed stamp intact.
    inline bool unchanged_completed_build(const std::filesystem::path& out, const std::optional<std::string>& before)
    {
        return before && completed_build_stamp(out) == before;
    }
}
