#include "std_include.hpp"
#include "online_commands.hpp"
#include "cef/cef_ui.hpp"
#include "fix/fix_ini.hpp"
#include "fix/online_settings.hpp"
#include "updater/folder_work.hpp"
#include "xml1/xml1_port.hpp"

#include <utils/string.hpp>

namespace commands::online_commands
{
    namespace
    {
        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        bool supported(const fix_ini::location& where)
        {
            return where.info && where.info->online;
        }

        // Host / JoinCode as the file has them, null when absent.
        rapidjson::Value values_json(const std::map<std::string, std::string>& values, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value object(rapidjson::kObjectType);
            for (const auto& key : online_rules::keys())
            {
                rapidjson::Value name = make_string(key, allocator);
                const auto it = values.find(key);
                if (it == values.end())
                {
                    object.AddMember(name, rapidjson::Value(rapidjson::kNullType), allocator);
                }
                else
                {
                    object.AddMember(name, make_string(it->second, allocator), allocator);
                }
            }
            return object;
        }

        // { success: false, reason, error }: `reason` is what the page words (online-view.js), `error`
        // the English text for logs.
        void fail(rapidjson::Document& response, const std::string& reason, const std::string& error)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", false, allocator);
            response.AddMember("reason", make_string(reason, allocator), allocator);
            response.AddMember("error", make_string(error, allocator), allocator);
        }

        bool playable(const fix_ini::location& where)
        {
            return where.game_dir && xml1_port::is_playable(*where.game_dir);
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { supported, installed, fixInstalled, playable, running, testMode, fix, file, ini,
        //   values: { Host, JoinCode }, status: <online-status.json's object> | null, statusUnreadable }.
        // The Online section polls it (about every 500 ms) while the game it started runs.
        cef_ui.add_command("get-online-status", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto config = ctx.get_game_config_from_request(value);
            const auto where = fix_ini::locate(config);
            const auto is_supported = supported(where);
            const auto installed = is_supported && where.game_dir.has_value();
            const auto fix_installed = installed && where.fix_installed;

            response.AddMember("supported", is_supported, allocator);
            response.AddMember("installed", installed, allocator);
            response.AddMember("fixInstalled", fix_installed, allocator);
            response.AddMember("playable", installed && playable(where), allocator);
            response.AddMember("running", is_supported && game_config::is_game_process_running(config->id, 1000), allocator);
            if (is_supported)
            {
                response.AddMember("fix", make_string(where.info->name, allocator), allocator);
                response.AddMember("file", make_string(utils::string::convert(where.info->ini), allocator), allocator);
            }

            std::map<std::string, std::string> values;
            auto test_mode = false;
            if (fix_installed)
            {
                const auto ini = *where.ini();
                response.AddMember("ini", make_string(utils::string::path_to_utf8(ini), allocator), allocator);
                values = online_settings::read(ini, *where.info);
                test_mode = online_settings::test_mode_on(ini, *where.info);
            }
            response.AddMember("testMode", test_mode, allocator);
            response.AddMember("values", values_json(values, allocator), allocator);

            // The fix writes the file atomically, so a file that doesn't parse as one object is not one
            // of its states: the page keeps what it showed.
            auto unreadable = false;
            rapidjson::Value status(rapidjson::kNullType);
            if (installed)
            {
                if (const auto text = online_settings::read_status(*where.game_dir))
                {
                    rapidjson::Document parsed;
                    parsed.Parse(text->data(), text->size());
                    if (!parsed.HasParseError() && parsed.IsObject())
                    {
                        status.CopyFrom(parsed, allocator);
                    }
                    else
                    {
                        unreadable = true;
                    }
                }
            }
            response.AddMember("status", status, allocator);
            response.AddMember("statusUnreadable", unreadable, allocator);
        });

        // { game, mode: "host" | "join" | "normal", code }: the [Online] keys for the next game start
        // (Host=broker or JoinCode=<code>, the other removed; both removed for "normal") and, for host and
        // join, a stale online-status.json deleted. The page then starts the game with launch-game
        // { online: true }. Answers { success, values, code } or { success: false, reason, error } with
        // reason one of not_supported, not_installed, no_fix, not_built, running, test_mode_on, bad_code,
        // bad_mode, busy, write_failed. Nothing is written while the builder holds the folder.
        cef_ui.add_command("prepare-online-start", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            const auto where = fix_ini::locate(config);
            if (!supported(where))
            {
                fail(response, "not_supported", "This game has no online play through the launcher.");
                return;
            }
            if (!where.game_dir)
            {
                fail(response, "not_installed", "Set up the game first.");
                return;
            }
            if (!where.fix_installed)
            {
                fail(response, "no_fix", "Install the " + where.info->name + " first.");
                return;
            }

            // Writing the fix's settings is patch work in the folder, for as long as the write takes (and a
            // build in it is the reason first: its building.json makes the folder unplayable meanwhile).
            const auto hold = updater::reserve(*where.game_dir, updater::folder_use::patch);
            if (!hold)
            {
                fail(response, "busy", "X-Men Legends is being built in this folder. Host or join when the build has finished.");
                return;
            }
            if (!playable(where))
            {
                fail(response, "not_built", config->display_name + " has not finished building.");
                return;
            }

            const auto mode_text = value.HasMember("mode") && value["mode"].IsString() ? std::string(value["mode"].GetString()) : std::string{};
            const auto mode = online_rules::parse_mode(mode_text);
            if (!mode)
            {
                fail(response, "bad_mode", "Unknown online mode: " + mode_text);
                return;
            }
            const auto code_text = value.HasMember("code") && value["code"].IsString() ? std::string(value["code"].GetString()) : std::string{};
            std::optional<std::string> code;
            if (*mode == online_rules::mode::join)
            {
                code = online_rules::normalise_code(code_text);
                if (!code)
                {
                    fail(response, "bad_code", "That is not a join code.");
                    return;
                }
            }

            const auto ini = *where.ini();
            const auto& fix = *where.info;
            if (*mode != online_rules::mode::normal)
            {
                if (game_config::is_game_process_running(config->id))
                {
                    fail(response, "running", config->display_name + " is running. Close it to host or join a game.");
                    return;
                }
                if (online_settings::test_mode_on(ini, fix))
                {
                    fail(response, "test_mode_on", "Test mode is on: the " + fix.name + " refuses online play. Turn test mode off first.");
                    return;
                }
            }

            std::string error;
            if (!online_settings::prepare(ini, fix, *mode, code.value_or(""), error))
            {
                fail(response, "write_failed", error);
                return;
            }
            if (*mode != online_rules::mode::normal && !online_settings::clear_status(*where.game_dir, error))
            {
                fail(response, "write_failed", error);
                return;
            }

            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", true, allocator);
            response.AddMember("values", values_json(online_settings::read(ini, fix), allocator), allocator);
            if (code)
            {
                response.AddMember("code", make_string(*code, allocator), allocator);
            }
        });
    }
}
