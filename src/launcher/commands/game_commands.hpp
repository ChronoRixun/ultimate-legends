#pragma once

#include "commands.hpp"

namespace commands::game_commands
{
    // Registers: launch-game, is-game-running, stop-game, get-game-install-info, verify-game,
    //            delete-game
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
