#pragma once
#include "commands.hpp"

namespace commands::presence_commands
{
    // Registers: get-presence-settings, set-presence-settings (the [Discord] section of a game's
    // fix ini, for the games fix_ini's table gives one; see fix/presence_settings.hpp).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
