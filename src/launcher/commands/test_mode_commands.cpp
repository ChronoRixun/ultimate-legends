#include "std_include.hpp"
#include "test_mode_commands.hpp"
#include "cef/cef_ui.hpp"
#include "fix/fix_ini.hpp"
#include "fix/test_mode_settings.hpp"
#include "updater/folder_work.hpp"

#include <utils/string.hpp>

namespace commands::test_mode_commands
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
            return where.info && where.info->test_mode;
        }

        // The keys as the UI wants them: true/false, null when the key is absent (off), or the text as
        // written when it is not a flag.
        rapidjson::Value values_json(const std::map<std::string, std::string>& values, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value object(rapidjson::kObjectType);
            for (const auto& key : test_mode_settings::keys())
            {
                rapidjson::Value name = make_string(key, allocator);
                const auto it = values.find(key);
                if (it == values.end())
                {
                    object.AddMember(name, rapidjson::Value(rapidjson::kNullType), allocator);
                    continue;
                }

                std::string unused;
                if (const auto flag = test_mode_settings::normalise(key, it->second, unused))
                {
                    object.AddMember(name, *flag == "1", allocator);
                }
                else
                {
                    object.AddMember(name, make_string(it->second, allocator), allocator);
                }
            }
            return object;
        }

        void set_result(rapidjson::Document& response, const bool success, const std::string& error = {})
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", success, allocator);
            if (!error.empty())
            {
                response.AddMember("error", make_string(error, allocator), allocator);
            }
        }

        // The game's fix and its ini to write, or nullopt with the response set to why not.
        std::optional<fix_ini::location> ini_or_fail(const command_context& ctx, const rapidjson::Value& value, rapidjson::Document& response)
        {
            auto where = fix_ini::locate(ctx.get_game_config_from_request(value));
            if (!supported(where))
            {
                set_result(response, false, "This game has no test mode.");
                return std::nullopt;
            }
            if (!where.game_dir)
            {
                set_result(response, false, "Set up the game first.");
                return std::nullopt;
            }
            if (!where.fix_installed)
            {
                set_result(response, false, "Install the " + where.info->name + " first.");
                return std::nullopt;
            }
            return where;
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { supported, installed, fixInstalled, running, fix, file, ini, keys: [ForgeEverywhere, Hotkeys],
        //   values: { ForgeEverywhere, Hotkeys }, defaults: { same, all false } }
        cef_ui.add_command("get-test-mode-settings", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
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
            response.AddMember("running", is_supported && game_config::is_game_process_running(config->id), allocator);
            if (is_supported)
            {
                response.AddMember("fix", make_string(where.info->name, allocator), allocator);
                response.AddMember("file", make_string(utils::string::convert(where.info->ini), allocator), allocator);
            }

            rapidjson::Value keys(rapidjson::kArrayType);
            for (const auto& key : test_mode_settings::keys())
            {
                keys.PushBack(make_string(key, allocator), allocator);
            }
            response.AddMember("keys", keys, allocator);

            std::map<std::string, std::string> values;
            if (fix_installed)
            {
                const auto ini = *where.ini();
                response.AddMember("ini", make_string(utils::string::path_to_utf8(ini), allocator), allocator);
                values = test_mode_settings::read(ini, *where.info);
            }
            response.AddMember("values", values_json(values, allocator), allocator);

            rapidjson::Value defaults(rapidjson::kObjectType);
            for (const auto& key : test_mode_settings::keys())
            {
                rapidjson::Value name = make_string(key, allocator);
                defaults.AddMember(name, test_mode_settings::default_value, allocator);
            }
            response.AddMember("defaults", defaults, allocator);
        });

        // { game, values: { ForgeEverywhere | Hotkeys: true | false | 1 | 0 | "1" | "0" | null } }: writes
        // the given keys (null removes one) and answers { success, error, values } with the ini's values
        // after. Any other key is refused, and nothing is written while the builder holds the folder (its
        // ini merge would put the file back as it read it).
        cef_ui.add_command("set-test-mode-settings", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto where = ini_or_fail(ctx, value, response);
            if (!where)
            {
                return;
            }
            const auto& fix = *where->info;
            const auto ini = *where->ini();

            std::vector<test_mode_settings::change> changes;
            if (value.HasMember("values") && value["values"].IsObject())
            {
                // (Not GetObject(): windows.h turns that name into GetObjectA.)
                const auto& values = value["values"];
                for (auto it = values.MemberBegin(); it != values.MemberEnd(); ++it)
                {
                    test_mode_settings::change change{};
                    change.key = it->name.GetString();
                    if (it->value.IsBool())
                    {
                        change.value = it->value.GetBool() ? "1" : "0";
                    }
                    else if (it->value.IsString())
                    {
                        change.value = it->value.GetString();
                    }
                    else if (it->value.IsInt64())
                    {
                        change.value = std::to_string(it->value.GetInt64());
                    }
                    else if (!it->value.IsNull())
                    {
                        set_result(response, false, "Unsupported value for " + change.key + ".");
                        return;
                    }
                    changes.push_back(std::move(change));
                }
            }
            if (changes.empty())
            {
                set_result(response, false, "Nothing to change.");
                return;
            }

            // Writing the fix's settings is patch work in the folder, for as long as the write takes.
            const auto hold = updater::reserve(*where->game_dir, updater::folder_use::patch);
            if (!hold)
            {
                set_result(response, false, "X-Men Legends is being built in this folder. Change test mode when the build has finished.");
                return;
            }

            std::string error;
            const auto ok = test_mode_settings::write(ini, fix, changes, error);
            set_result(response, ok, error);
            response.AddMember("values", values_json(test_mode_settings::read(ini, fix), response.GetAllocator()), response.GetAllocator());
        });
    }
}
