#pragma once

#include "release_channel.hpp"

#include <filesystem>
#include <optional>
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

    // The patch release the launcher last installed into `install_path`: its version (empty when it
    // came from releases/latest, whose tag the update didn't need) and the SHA-1 of the patch's main
    // file (release_channel::effective_patch_version). Nothing for another folder, as above.
    std::optional<release_channel::patch_record> read_release(const std::string& client_id, const std::filesystem::path& install_path);
    bool write_release(const std::string& client_id, const std::filesystem::path& install_path, const release_channel::patch_record& record);
    void forget_release(const std::string& client_id);

    // True when `path` lies strictly inside `folder` (never the folder itself).
    bool is_below(const std::filesystem::path& path, const std::filesystem::path& folder);

    // Deepest-first, so a nested directory is gone before its parent is tested.
    void prune_empty_directories(const std::set<std::filesystem::path>& directories);
}
