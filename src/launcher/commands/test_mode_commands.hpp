#pragma once
#include "commands.hpp"

namespace commands::test_mode_commands
{
    // Registers: get-test-mode-settings, set-test-mode-settings (the XML2 Fix's [TestMode] section, for
    // the games fix_ini's table gives it to: the X-Men Legends port; see fix/test_mode_settings.hpp).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
