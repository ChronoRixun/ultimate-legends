#pragma once

#include <game_config.hpp>
#include <rapidjson/document.h>
#include <optional>
#include <vector>
#include <string>

namespace cef
{
    class cef_ui;
}

namespace commands
{
    struct command_context
    {
        cef::cef_ui& cef_ui;

        // Returns nullopt if validation fails (no game in request or invalid game)
        std::optional<game_config::game_config_t> get_game_config_from_request(
            const rapidjson::Value& request) const;
    };

    // Register all commands with the CEF UI
    void register_all_commands(cef::cef_ui& cef_ui);
}
