#pragma once

#include "commands.hpp"

namespace commands::update_commands
{
    // Registers: get-launcher-update, confirm-launcher-update, check-launcher-update, start-launcher-update,
    //            restart-launcher-update (the launcher's self-update, updater/launcher_update.hpp)
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
