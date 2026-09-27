#pragma once

#include <filesystem>
#include <set>
#include <string>
#include <vector>

namespace client_store
{
    // The last patch manifest applied to a game, so the next run knows which files it installed.
    std::filesystem::path manifest_cache_path(const std::string& client_id);

    // The file names recorded for `client_id`, or nothing when the cache is missing, unreadable,
    // written by an older launcher, or was recorded for a different install folder (the player
    // moved the game), since those names then say nothing about the current folder.
    std::vector<std::string> read_manifest_cache(const std::string& client_id, const std::filesystem::path& install_path);
    bool write_manifest_cache(const std::string& client_id, const std::filesystem::path& install_path,
                              const std::vector<std::string>& names);

    // True when `path` lies strictly inside `folder` (never the folder itself).
    bool is_below(const std::filesystem::path& path, const std::filesystem::path& folder);

    // Deepest-first, so a nested directory is gone before its parent is tested.
    void prune_empty_directories(const std::set<std::filesystem::path>& directories);
}
