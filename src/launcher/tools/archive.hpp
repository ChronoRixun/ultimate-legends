#pragma once

#include <filesystem>
#include <string>

namespace archive
{
    // Unpacks a .zip into `into` (created when missing) with Windows' own tar.exe (bsdtar, in
    // System32 since Windows 10 1803), which refuses absolute paths and ".." entries. Returns an
    // empty string on success, else a message for the user.
    std::string extract_zip(const std::filesystem::path& archive, const std::filesystem::path& into);
}
