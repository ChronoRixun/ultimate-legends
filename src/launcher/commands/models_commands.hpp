#pragma once
#include "commands.hpp"

namespace commands::models_commands
{
    // Registers: get-models-status, set-models-settings, models-run, get-models-job, models-cancel,
    // get-models-credits (the Character models section of the X-Men Legends page, app/models-view.js).
    void register_commands(cef::cef_ui& cef_ui, command_context& ctx);
}
