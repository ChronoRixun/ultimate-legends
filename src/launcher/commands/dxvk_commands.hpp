#pragma once
#include "commands.hpp"

namespace commands::dxvk_commands
{
    // Registers the opt-in DXVK renderer of the XML2-engine games (display/dxvk.hpp).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
