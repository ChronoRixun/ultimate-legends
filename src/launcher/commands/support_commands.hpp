#pragma once

#include "commands.hpp"

namespace commands::support_commands
{
    // Registers: get-support-diagnostics, get-support-logs, open-support-log, copy-to-clipboard
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
