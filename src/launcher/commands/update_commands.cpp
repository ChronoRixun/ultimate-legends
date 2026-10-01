#include "std_include.hpp"
#include "update_commands.hpp"
#include "cef/cef_ui.hpp"
#include "updater/launcher_update.hpp"

// The launcher's own update (app/launcher-update.js): the UI asks for checks and polls the state.
namespace commands::update_commands
{
    void register_commands(cef::cef_ui& cef_ui, command_context&)
    {
        cef_ui.add_command("get-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            launcher_update::write_status(response, response.GetAllocator());
        });

        cef_ui.add_command("check-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            launcher_update::check();
            launcher_update::write_status(response, response.GetAllocator());
        });

        cef_ui.add_command("start-launcher-update", [](const auto&, rapidjson::Document& response)
        {
            response.SetBool(launcher_update::start_download());
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
    }
}
