#include "std_include.hpp"
#include <rapidjson/writer.h>
#include "property_commands.hpp"
#include "cef/cef_ui.hpp"
#include <utils/io.hpp>
#include <utils/logger.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>
#include <game_config.hpp>
#include "steam_library.hpp"

namespace commands::property_commands
{
    namespace
    {
        // A string member of the page's arguments, or nullopt (missing, null, a number, ...).
        std::optional<std::string> string_member(const rapidjson::Value& value, const char* key)
        {
            if (!value.IsObject())
            {
                return std::nullopt;
            }
            const auto member = value.FindMember(key);
            if (member == value.MemberEnd() || !member->value.IsString())
            {
                return std::nullopt;
            }
            return std::string{member->value.GetString(), member->value.GetStringLength()};
        }

        std::string json_text(const rapidjson::Value& value)
        {
            rapidjson::StringBuffer buffer;
            rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
            value.Accept(writer);
            return {buffer.GetString(), buffer.GetSize()};
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context&)
    {
        cef_ui.add_command("get-property", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();

            if (!value.IsString())
            {
                return;
            }

            const auto key = std::string{ value.GetString() };
            const auto property = utils::properties::load(key);
            if (!property)
            {
                return;
            }

            response.SetString(*property, response.GetAllocator());
        });

        cef_ui.add_command("set-property", [](const rapidjson::Value& value, auto&)
        {
            if (!value.IsObject())
            {
                return;
            }

            const auto _ = utils::properties::lock();

            for (auto i = value.MemberBegin(); i != value.MemberEnd(); ++i)
            {
                if (!i->value.IsString())
                {
                    continue;
                }

                const auto key = std::string{ i->name.GetString() };
                const auto val = std::string{ i->value.GetString() };

                utils::properties::store(key, val);
            }
        });

        cef_ui.add_command("set-game-property", [](const rapidjson::Value& value, auto&)
        {
            const auto game = string_member(value, "game");
            const auto suffix = string_member(value, "suffix");
            const auto val = string_member(value, "value");
            if (!game || !suffix || !val)
            {
                utils::logger::write("set-game-property: ignored, game / suffix / value are not all strings: {}", json_text(value));
                return;
            }

            const auto config = game_config::get_game_config(*game);
            if (!config)
            {
                return; // Invalid game
            }

            config->set(*suffix, *val);
        });

        cef_ui.add_command("get-game-property", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto game = string_member(value, "game");
            const auto suffix = string_member(value, "suffix");
            if (!game || !suffix)
            {
                response.SetNull();
                return;
            }

            const auto config = game_config::get_game_config(*game);
            if (!config)
            {
                response.SetNull();
                return;
            }

            const auto result = config->get(*suffix);
            if (result.has_value())
            {
                response.SetString(result->data(), static_cast<rapidjson::SizeType>(result->length()), response.GetAllocator());
            }
            else
            {
                response.SetNull();
            }
        });

        // Looks for the game in the user's Steam libraries. Returns the folder (only if it is a valid
        // install of the game) or null.
        cef_ui.add_command("find-game-install", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();

            if (!value.IsObject() || !value.HasMember("game") || !value["game"].IsString())
            {
                return;
            }

            const auto game = std::string{value["game"].GetString()};
            const auto config = game_config::get_game_config(game);
            if (!config || config->steam_app_id.empty())
            {
                return;
            }

            const auto install = steam_library::find_app_install(config->steam_app_id);
            if (!install || !game_config::validate_game_path(game, *install))
            {
                return;
            }

            const auto utf8 = utils::string::path_to_utf8(*install);
            response.SetString(utf8.data(), static_cast<rapidjson::SizeType>(utf8.size()), response.GetAllocator());
        });

        // Points the launcher at the player's existing install. Installed flips only once the setup
        // pipeline's patch install (verify-game) succeeds.
        cef_ui.add_command("set-game-path", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetBool(false); // Default to failure

            if (!value.IsObject() || !value.HasMember("game") || !value["game"].IsString() ||
                !value.HasMember("path") || !value["path"].IsString())
            {
                return;
            }

            const auto game = std::string{ value["game"].GetString() };
            const auto path = utils::string::utf8_to_path(value["path"].GetString());

            const auto config = game_config::get_game_config(game);
            if (!config)
            {
                return;
            }

            if (!game_config::validate_game_path(game, path))
            {
                return; // Invalid - no valid game exe found
            }

            // Path is valid, store it (set_install_path serializes to UTF-8 internally)
            config->set_install_path(path);
            response.SetBool(true); // Success
        });

        cef_ui.add_command("reset-game-settings", [](const rapidjson::Value& value, auto&)
        {
            if (!value.IsObject() || !value.HasMember("game") || !value["game"].IsString())
            {
                return;
            }

            const auto game = std::string{ value["game"].GetString() };

            if (game == "all")
            {
                game_config::reset_all_games();
            }
            else
            {
                const auto config = game_config::get_game_config(game);
                if (!config)
                {
                    return; // Invalid game
                }

                config->reset();
            }
        });
    }
}
