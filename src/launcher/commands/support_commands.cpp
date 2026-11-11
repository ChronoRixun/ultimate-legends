#include "std_include.hpp"
#include "support_commands.hpp"
#include "cef/cef_ui.hpp"

#include "support/diagnostics.hpp"

namespace commands::support_commands
{
    namespace
    {
        void set_success(rapidjson::Document& response, const bool success)
        {
            response.SetObject();
            response.AddMember("success", success, response.GetAllocator());
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context&)
    {
        // Support > Copy diagnostics: local facts only, redacted (support/diagnostics.hpp).
        cef_ui.add_command("get-support-diagnostics", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            support::write_diagnostics(response);
        });

        // Support > Logs: which log files are there; never their paths.
        cef_ui.add_command("get-support-logs", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            response.SetObject();
            rapidjson::Value logs;
            support::write_logs(logs, response.GetAllocator());
            response.AddMember("logs", logs, response.GetAllocator());
        });

        // { id } -> { success }: the folder is resolved here from the id, never taken from the page.
        cef_ui.add_command("open-support-log", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const bool valid = value.IsObject() && value.HasMember("id") && value["id"].IsString();
            set_success(response, valid && support::open_log(std::string(value["id"].GetString(), value["id"].GetStringLength())));
        });

        // { text } -> { success }: plain text for the clipboard (the diagnostics report), at most 64 KiB.
        cef_ui.add_command("copy-to-clipboard", [&cef_ui](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const bool valid = value.IsObject() && value.HasMember("text") && value["text"].IsString() && value["text"].GetStringLength() <= 65536;
            set_success(response, valid && support::copy_text(std::string(value["text"].GetString(), value["text"].GetStringLength()), cef_ui.get_window()));
        });
    }
}
