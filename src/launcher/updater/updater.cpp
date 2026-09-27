#include <std_include.hpp>

#include "updater.hpp"
#include "client_updater.hpp"

namespace client_updater
{
    bool run(const game_config::game_config_t& config, updater::ui_progress_listener* listener)
    {
        const client_updater client_updater{config, listener};
        client_updater.run();
        return !client_updater.manifest_fetch_failed();
    }
}
