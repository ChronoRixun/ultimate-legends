#pragma once

#include "game_config.hpp"
#include "patch_policy.hpp"

#include <filesystem>
#include <optional>
#include <string>

// The XML2 Fix on the update channel (release_source.hpp). A game whose patch has a repository
// (game_config_t::patch_repo: X-Men Legends II and the X-Men Legends port) installs the channel's
// release - Stable: GitHub's latest release; Beta: pre-releases too - by its tag
// (releases/download/<tag>/ultimate-legends.json and the files it lists), under patch_policy.hpp's
// rule: never older than the fix in the folder unless the player approved exactly that switch back
// for this one attempt; the last choice of the channel when GitHub can't be asked.
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
        std::string version;  // the release's version ("" for a releases/latest fallback, which has none)
        bool downgrade{};     // an older release, by the attempt's consent
        std::string note;
    };

    // Where the patch for `folder` comes from now. `consent`: Switch back to Stable, approved for this
    // attempt only (verify-game { downgrade: { from, to } }); never stored.
    source resolve(const game_config::game_config_t& config, const std::filesystem::path& folder,
                   const std::optional<patch_policy::consent>& consent = std::nullopt);

    // After a patch update finished in `folder`: the release it installed (`version`, maybe "") and
    // the SHA-1 the manifest gave the patch's main file.
    void record(const game_config::game_config_t& config, const std::filesystem::path& folder, const std::string& version,
                const std::string& patch_sha1);

    // The fix in `folder`: the recorded release while the file is the one recorded, else its version
    // resource ("" when unreadable); nullopt when there is no fix file.
    std::optional<std::string> installed_version(const game_config::game_config_t& config, const std::filesystem::path& folder);
}
