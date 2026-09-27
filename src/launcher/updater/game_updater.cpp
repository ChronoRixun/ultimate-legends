#include <std_include.hpp>

#include "game_updater.hpp"

namespace game_updater
{
    game_updater::game_updater(const game_config::game_config_t& config)
        : game_key_(config.game_key)
    {
        if (const auto install_path = config.get_install_path())
        {
            this->install_path_ = *install_path;
        }
    }

    bool game_updater::is_install_valid() const
    {
        return !this->install_path_.empty() && game_config::validate_game_path(this->game_key_, this->install_path_);
    }
}
