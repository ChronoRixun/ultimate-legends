#pragma once
#include "commands.hpp"

namespace commands::mod_commands
{
    // Registers: get-mods, set-mod-enabled, set-mod-order, import-mod, get-mod-import,
    // uninstall-mod, browse-file
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
