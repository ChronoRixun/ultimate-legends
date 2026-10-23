#include <std_include.hpp>

#include "updater.hpp"
#include "client_updater.hpp"

namespace client_updater
{
    bool run(const game_config::game_config_t& config, updater::ui_progress_listener* listener,
             const std::optional<std::filesystem::path>& install_path)
    {
        const client_updater client_updater{config, listener, install_path};
        client_updater.run();
        return !client_updater.manifest_fetch_failed();
    }

    attempt run_attempt(const game_config::game_config_t& config, updater::ui_progress_listener* listener,
                        const std::optional<std::filesystem::path>& install_path, const std::optional<patch_policy::consent>& consent)
    {
        const client_updater client_updater{config, listener, install_path, consent};
        client_updater.run();
        return {!client_updater.manifest_fetch_failed(), client_updater.kept(), client_updater.downgrade(), client_updater.release_version(),
                client_updater.note()};
    }
}
