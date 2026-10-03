#pragma once

#include <filesystem>
#include <string>

namespace archive
{
    // Unpacks a .zip into `into` (created when missing) with the bundled miniz, so it works where
    // Windows' tar.exe is missing (Wine/Proton, e.g. the Steam Deck). Refuses absolute paths, drive
    // letters and ".." entries. Returns an empty string on success, else a message for the user.
    std::string extract_zip(const std::filesystem::path& archive, const std::filesystem::path& into);
}
