#pragma once
#include "commands.hpp"

namespace commands::remastered_commands
{
    // Registers the version-gated [Remastered] settings of XML2 Fix 1.12.0.
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
