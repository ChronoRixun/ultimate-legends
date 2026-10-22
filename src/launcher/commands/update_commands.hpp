#pragma once

#include "commands.hpp"

namespace commands::update_commands
{
    // Registers: get-launcher-update, confirm-launcher-update, check-launcher-update, start-launcher-update,
    //            restart-launcher-update (the launcher's self-update, updater/launcher_update.hpp),
    //            get-update-channel, set-update-channel, switch-back-to-stable, keep-beta (updater/channel_status.hpp)
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
