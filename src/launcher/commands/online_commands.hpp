#pragma once
#include "commands.hpp"

namespace commands::online_commands
{
    // Registers: get-online-status, get-public-rooms (online play of the games fix_ini's table gives it to: the
    // X-Men Legends port; see fix/online_settings.hpp). Host and Join start through launch-game { online },
    // which writes the [Online] keys right before the process and removes them for every other start and
    // after one that didn't happen (game_commands.cpp, fix/online_launch.hpp).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
