#pragma once

#include "update_cancelled.hpp"
#include "ui_progress_listener.hpp"
#include <game_config.hpp>

namespace client_updater
{
    // Installs or updates the game's patch. Returns false when the game has a patch whose
    // manifest could not be fetched.
    bool run(const game_config::game_config_t& config, updater::ui_progress_listener* listener = nullptr);
}
