#include "std_include.hpp"
#include "commands.hpp"
#include "cef/cef_ui.hpp"

#include "ui_commands.hpp"
#include "property_commands.hpp"
#include "info_commands.hpp"
#include "game_commands.hpp"
#include "mod_commands.hpp"
#include "display_commands.hpp"
#include "presence_commands.hpp"
#include "xml1_commands.hpp"
#include "update_commands.hpp"

namespace commands
{
    std::optional<game_config::game_config_t> command_context::get_game_config_from_request(
        const rapidjson::Value& request) const
    {
        if (!request.IsObject() || !request.HasMember("game"))
        {
            return std::nullopt;
        }

        const auto game = std::string{ request["game"].GetString() };
        return game_config::get_game_config(game);
    }

    void register_all_commands(cef::cef_ui& cef_ui)
    {
        // Create shared command context
        static command_context ctx{ cef_ui };

        // Register all command groups
        ui_commands::register_commands(cef_ui, ctx);
        property_commands::register_commands(cef_ui, ctx);
        info_commands::register_commands(cef_ui, ctx);
        game_commands::register_commands(cef_ui, ctx);
        mod_commands::register_commands(cef_ui, ctx);
        display_commands::register_commands(cef_ui, ctx);
        presence_commands::register_commands(cef_ui, ctx);
        xml1_commands::register_commands(cef_ui, ctx);
        update_commands::register_commands(cef_ui, ctx);
    }
}
