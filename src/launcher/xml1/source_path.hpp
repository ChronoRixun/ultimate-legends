#pragma once
#include <filesystem>
#include <system_error>

namespace xml1
{
    // --iso accepts an image or an extracted install. The builder validates its
    // contents; this availability check also serves rebuild/resume and verify.
    inline bool source_path_exists(const std::filesystem::path& path)
    {
        std::error_code error;
        const auto status = std::filesystem::status(path, error);
        return !error && (std::filesystem::is_regular_file(status) || std::filesystem::is_directory(status));
    }
}
