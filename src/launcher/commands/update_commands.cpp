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

        // { launcher?: "<version>", builder?: "<version>" } -> { launcher, builder }: Switch back to Stable,
        // approved for exactly those versions and this attempt (the fix's: verify-game { downgrade }).
        cef_ui.add_command("switch-back-to-stable", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto text = [&](const char* key)
            {
                return value.IsObject() && value.HasMember(key) && value[key].IsString() ? std::string(value[key].GetString()) : std::string{};
            };
            const auto result = channel_status::switch_back(text("launcher"), text("builder"));
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("launcher", result.launcher, allocator);
            response.AddMember("builder", result.builder, allocator);
        });

        // Keep the beta: nothing approved before may still switch back.
        cef_ui.add_command("keep-beta", [](const auto&, rapidjson::Document& response)
        {
            channel_status::keep_beta();
            response.SetBool(true);
        });

        // { downgrade: "<version>" }: Switch back to Stable, the latest release over a newer beta - exactly
        // that version, approved for this attempt.
        cef_ui.add_command("start-launcher-update", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto downgrade = value.IsObject() && value.HasMember("downgrade") && value["downgrade"].IsString()
                                       ? std::string(value["downgrade"].GetString()) : std::string{};
            response.SetBool(launcher_update::start_download(downgrade));
        });
    }
}
