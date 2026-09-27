#pragma once

#include <filesystem>
#include <optional>
#include <string>

namespace steam_library
{
    // Folder of an installed Steam app, found by reading the user's Steam libraries
    // (libraryfolders.vdf and each library's appmanifest_<app_id>.acf). Empty if Steam
    // isn't installed or none of its libraries has the app.
    std::optional<std::filesystem::path> find_app_install(const std::string& app_id);
}
