#include "std_include.hpp"
#include "remastered_commands.hpp"
#include "cef/cef_ui.hpp"
#include "fix/fix_ini.hpp"
#include "display/remastered_settings.hpp"
#include "updater/folder_work.hpp"
#include "updater/patch_status.hpp"

#include <utils/string.hpp>

namespace commands::remastered_commands
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
            return where.info && where.info->display;
        }

        // Exact strings, null when absent; invalid hand edits remain visible and disabled.
        rapidjson::Value values_json(const std::map<std::string, std::string>& values, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value object(rapidjson::kObjectType);
            for (const auto& key : remastered_settings::keys())
            {
                rapidjson::Value name = make_string(key, allocator);
                const auto it = values.find(key);
                if (it == values.end())
                {
                    object.AddMember(name, rapidjson::Value(rapidjson::kNullType), allocator);
                    continue;
                }

                std::string unused;
                if (const auto flag = remastered_settings::normalise(key, it->second, unused))
                {
                    object.AddMember(name, make_string(*flag, allocator), allocator);
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
            if (!value.IsObject() || !value.HasMember("game") || !value["game"].IsString())
            {
                set_result(response, false, "Choose a game first.");
                return std::nullopt;
            }
            auto where = fix_ini::locate(ctx.get_game_config_from_request(value));
            if (!supported(where))
            {
                set_result(response, false, "This game has no Remastered settings.");
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
        // { supported, installed, fixInstalled, running, fix, file, ini, keys: [Remastered keys],
        //   values: { Remastered keys }, available, requiredFix, fixVersion }
        cef_ui.add_command("get-remastered-settings", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto config = value.IsObject() && value.HasMember("game") && value["game"].IsString()
                ? ctx.get_game_config_from_request(value) : std::nullopt;
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
            for (const auto& key : remastered_settings::keys())
            {
                keys.PushBack(make_string(key, allocator), allocator);
            }
            response.AddMember("keys", keys, allocator);

            std::map<std::string, std::string> values;
            if (fix_installed)
            {
                const auto ini = *where.ini();
                response.AddMember("ini", make_string(utils::string::path_to_utf8(ini), allocator), allocator);
                values = remastered_settings::read(ini);
            }
            response.AddMember("values", values_json(values, allocator), allocator);

            const auto version = fix_installed ? patch_status::installed_version(*where.game_dir / where.info->dll) : std::nullopt;
            response.AddMember("available", remastered_settings::supports_version(version), allocator);
            response.AddMember("requiredFix", make_string(remastered_settings::required_fix, allocator), allocator);
            response.AddMember("fixVersion", make_string(version.value_or(""), allocator), allocator);
        });

        // { game, values: { Enabled | MSAASamples | Anisotropy | AnisotropyOnPointArt | CenteredHud: true | false | 1 | 0 | "1" | "0" | null } }: writes
        // the given keys (null removes one) and answers { success, error, values } with the ini's values
        // after. Any other key is refused, and nothing is written while the builder holds the folder (its
        // ini merge would put the file back as it read it).
        cef_ui.add_command("set-remastered-settings", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto where = ini_or_fail(ctx, value, response);
            if (!where)
            {
                return;
            }
            const auto ini = *where->ini();

            std::vector<remastered_settings::change> changes;
            if (value.HasMember("values") && value["values"].IsObject())
            {
                // (Not GetObject(): windows.h turns that name into GetObjectA.)
                const auto& values = value["values"];
                for (auto it = values.MemberBegin(); it != values.MemberEnd(); ++it)
                {
                    remastered_settings::change change{};
                    change.key.assign(it->name.GetString(), it->name.GetStringLength());
                    if (it->value.IsBool())
                    {
                        change.value = it->value.GetBool() ? "1" : "0";
                    }
                    else if (it->value.IsString())
                    {
                        change.value = std::string(it->value.GetString(), it->value.GetStringLength());
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
                set_result(response, false, "X-Men Legends is being built in this folder. Change Remastered settings when the build has finished.");
                return;
            }

            // Validate the installed Fix immediately before the write while
            // the folder hold excludes a builder's INI merge.
            const auto version = patch_status::installed_version(*where->game_dir / where->info->dll);
            if (!remastered_settings::supports_version(version))
            {
                set_result(response, false, "Remastered needs XML2 Fix 1.12.0 or later. Update the Fix first.");
                return;
            }

            std::string error;
            const auto ok = remastered_settings::write(ini, changes, error);
            set_result(response, ok, error);
            response.AddMember("values", values_json(remastered_settings::read(ini), response.GetAllocator()), response.GetAllocator());
        });
    }
}
