#pragma once

#include "commands.hpp"

namespace commands::info_commands
{
    // Registers: get-update-progress, cancel-update, pause-update, resume-update, get-version,
    //            get-startup-launch, get-startup-deeplink, get-offline-mode, get-portable-mode
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
