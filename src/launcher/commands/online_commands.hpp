#pragma once
#include "commands.hpp"

namespace commands::online_commands
{
    // Registers: get-online-status, prepare-online-start, get-public-rooms (online play of the games fix_ini's table
    // gives it to: the X-Men Legends port; see fix/online_settings.hpp). launch-game removes the
    // [Online] keys for every other start (game_commands.cpp).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
