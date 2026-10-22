#pragma once

#include "update_cancelled.hpp"
#include "patch_policy.hpp"
#include "ui_progress_listener.hpp"
#include <game_config.hpp>

namespace client_updater
{
    // Installs or updates the game's patch. Returns false when the game has a patch whose
    // manifest could not be fetched. `install_path`: another folder than the game's install path
    // (the X-Men Legends port's next build folder, before the build makes it the install path).
    bool run(const game_config::game_config_t& config, updater::ui_progress_listener* listener = nullptr,
             const std::optional<std::filesystem::path>& install_path = std::nullopt);

    // One patch update and what it did, for a caller that must know (Switch back to Stable: a started
    // update is not an installed release). `consent`: an older release approved for this attempt only.
    struct attempt
    {
        bool fetched{};      // false: the patch has a manifest that could not be fetched
        bool kept{};         // the update channel left the patch as it was (`note`)
        bool downgrade{};    // it installed an older release, by the consent
        std::string version; // the release it installed, when known
        std::string note;
    };
    attempt run_attempt(const game_config::game_config_t& config, updater::ui_progress_listener* listener,
                        const std::optional<std::filesystem::path>& install_path, const std::optional<patch_policy::consent>& consent);
}
