#pragma once

#include "game_config.hpp"

#include <filesystem>
#include <optional>
#include <string>

// The XML2 Fix on the update channel (release_source.hpp). A game whose patch has a repository
// (game_config_t::patch_repo: X-Men Legends II and the X-Men Legends port) installs:
//
//   Stable: releases/latest/download/ultimate-legends.json, as always - except over a beta newer
//           than the latest release, which stays until the player says Switch back to Stable.
//   Beta:   the channel's release, by its tag (releases/download/<tag>/...); when GitHub can't be
//           asked, the last one found. Never one older than the fix in the folder.
//
// The fix's version resource is numeric (1.8.0-beta.2 says 1.8.0), so the release installed is
// recorded (client_store::write_release) and is the fix's version while the file is that one
// (installed_version()). The MUA Controller Fix has no repository here and stays as it was.
namespace patch_channel
{
    struct source
    {
        std::string manifest_url; // empty: leave the patch in the folder as it is (`note` says why)
        std::string folder_url;
        std::string version; // the release's version when known ("" for releases/latest)
        std::string note;
    };

    // Where the patch for `folder` comes from now.
    source resolve(const game_config::game_config_t& config, const std::filesystem::path& folder);

    // After a patch update finished in `folder`: the release it installed (`version`, maybe "") and
    // the SHA-1 the manifest gave the patch's main file. Clears a Switch back to Stable that was
    // waiting for it.
    void record(const game_config::game_config_t& config, const std::filesystem::path& folder, const std::string& version,
                const std::string& patch_sha1);

    // The fix in `folder`: the recorded release while the file is the one recorded, else its version
    // resource ("" when unreadable); nullopt when there is no fix file.
    std::optional<std::string> installed_version(const game_config::game_config_t& config, const std::filesystem::path& folder);

    // The player chose Switch back to Stable: the next patch update may install the latest release
    // over a newer beta (once; record() clears it).
    void allow_downgrade(const game_config::game_config_t& config);
}
