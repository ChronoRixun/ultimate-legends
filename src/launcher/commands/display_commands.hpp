#pragma once
#include "commands.hpp"

namespace commands::display_commands
{
    // Registers: get-display-settings, set-display-settings (the XML2 Fix's [Display] section of
    // xml2-fix.ini; see display/xml2_display.hpp).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
