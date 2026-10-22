#include "std_include.hpp"
#include "update_commands.hpp"
#include "cef/cef_ui.hpp"
#include "updater/channel_status.hpp"
#include "updater/launcher_update.hpp"

// The launcher's own update (app/launcher-update.js): the UI asks for checks and polls the state. And
// the update channel (app/update-channel.js), which the launcher, the XML2 Fix and the builder follow.
namespace commands::update_commands
{
    void register_commands(cef::cef_ui& cef_ui, command_context&)
    {
        cef_ui.add_command("get-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            launcher_update::write_status(response, response.GetAllocator());
        });

        // The page calls this once it has rendered: a new version's first start went well.
        cef_ui.add_command("confirm-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            launcher_update::confirm_started();
            response.SetBool(true);
        });

        cef_ui.add_command("check-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            launcher_update::check();
            launcher_update::write_status(response, response.GetAllocator());
        });

        // { downgrade: true }: Switch back to Stable, the latest release over a newer beta.
        cef_ui.add_command("start-launcher-update", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto downgrade = value.IsObject() && value.HasMember("downgrade") && value["downgrade"].IsBool() && value["downgrade"].GetBool();
            response.SetBool(launcher_update::start_download(downgrade));
        });

        cef_ui.add_command("restart-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            std::string error;
            const auto ok = launcher_update::restart(error);
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("ok", ok, allocator);
            rapidjson::Value value;
            value.SetString(error.data(), static_cast<rapidjson::SizeType>(error.size()), allocator);
            response.AddMember("error", value, allocator);
        });

        // Settings > Update channel (updater/channel_status.hpp, app/update-channel.js).
        cef_ui.add_command("get-update-channel", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            if (value.IsObject() && value.HasMember("refresh") && value["refresh"].IsBool() && value["refresh"].GetBool())
            {
                channel_status::refresh();
            }
            channel_status::write_status(response, response.GetAllocator());
        });

        // { channel: "stable" | "beta" }
        cef_ui.add_command("set-update-channel", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            if (value.IsObject() && value.HasMember("channel") && value["channel"].IsString())
            {
                channel_status::set_channel(value["channel"].GetString());
            }
            channel_status::write_status(response, response.GetAllocator());
        });

        // { items: ["launcher", "fix", "builder"] } -> { launcher, builder, fixGames: ["xml2", "xml1"] }
        cef_ui.add_command("switch-back-to-stable", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            std::vector<std::string> items;
            if (value.IsObject() && value.HasMember("items") && value["items"].IsArray())
            {
                for (const auto& item : value["items"].GetArray())
                {
                    if (item.IsString())
                    {
                        items.emplace_back(item.GetString());
                    }
                }
            }
            const auto result = channel_status::switch_back(items);
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("launcher", result.launcher, allocator);
            response.AddMember("builder", result.builder, allocator);
            rapidjson::Value games(rapidjson::kArrayType);
            for (const auto& game : result.fix_games)
            {
                games.PushBack(rapidjson::Value(game.data(), static_cast<rapidjson::SizeType>(game.size()), allocator), allocator);
            }
            response.AddMember("fixGames", games, allocator);
        });
    }
}
