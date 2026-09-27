#include "std_include.hpp"
#include "mod_commands.hpp"
#include "cef/cef_ui.hpp"
#include "mods/game_mods.hpp"

#include <utils/com.hpp>
#include <utils/io.hpp>
#include <utils/nt.hpp>
#include <utils/string.hpp>

#include <thread>

namespace commands::mod_commands
{
    namespace
    {
        // One import at a time per game; the UI polls get-mod-import.
        struct import_job
        {
            bool active{};
            bool finished{};
            std::string name;
            std::string error;
        };

        std::mutex jobs_mutex_;
        std::unordered_map<std::string, import_job> jobs_;

        std::string json_string(const rapidjson::Value& value, const char* key)
        {
            if (!value.IsObject())
            {
                return {};
            }
            const auto member = value.FindMember(key);
            return member != value.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
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

        // The game's install folder, or answers the request with an error.
        std::optional<std::filesystem::path> game_dir_or_fail(const command_context& ctx, const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            const auto path = config ? config->get_install_path() : std::nullopt;
            if (!path || !utils::io::directory_exists(*path))
            {
                set_result(response, false, "Set up the game first.");
                return std::nullopt;
            }
            return path;
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { installed, running, folder, mods: [{ name, enabled, files, size, title, version, author, description }] }
        // in load order, lowest priority first.
        cef_ui.add_command("get-mods", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto config = ctx.get_game_config_from_request(value);
            const auto path = config ? config->get_install_path() : std::nullopt;
            const auto installed = path && utils::io::directory_exists(*path);
            response.AddMember("installed", installed, allocator);
            response.AddMember("running", config && game_config::is_game_process_running(config->get_game_key()), allocator);

            rapidjson::Value mods(rapidjson::kArrayType);
            if (installed)
            {
                response.AddMember("folder", make_string(utils::string::path_to_utf8(game_mods::mods_folder(*path)), allocator), allocator);
                for (const auto& mod : game_mods::list(*path))
                {
                    rapidjson::Value item(rapidjson::kObjectType);
                    item.AddMember("name", make_string(mod.name, allocator), allocator);
                    item.AddMember("enabled", mod.enabled, allocator);
                    item.AddMember("files", mod.files, allocator);
                    item.AddMember("size", mod.size, allocator);
                    item.AddMember("title", make_string(mod.title, allocator), allocator);
                    item.AddMember("version", make_string(mod.version, allocator), allocator);
                    item.AddMember("author", make_string(mod.author, allocator), allocator);
                    item.AddMember("description", make_string(mod.description, allocator), allocator);
                    mods.PushBack(item, allocator);
                }
            }
            response.AddMember("mods", mods, allocator);
        });

        cef_ui.add_command("set-mod-enabled", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto path = game_dir_or_fail(ctx, value, response);
            if (!path)
            {
                return;
            }

            const auto enabled = value.HasMember("enabled") && value["enabled"].IsBool() && value["enabled"].GetBool();
            std::string error;
            const auto ok = game_mods::set_enabled(*path, json_string(value, "name"), enabled, error);
            set_result(response, ok, error);
        });

        // { game, names: [...] }: the complete order, lowest priority first.
        cef_ui.add_command("set-mod-order", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto path = game_dir_or_fail(ctx, value, response);
            if (!path)
            {
                return;
            }

            std::vector<std::string> names;
            if (value.HasMember("names") && value["names"].IsArray())
            {
                for (const auto& name : value["names"].GetArray())
                {
                    if (name.IsString())
                    {
                        names.emplace_back(name.GetString());
                    }
                }
            }

            std::string error;
            const auto ok = game_mods::set_order(*path, names, error);
            set_result(response, ok, error);
        });

        // { game, path, kind: "zip" | "folder" }: starts the import; poll get-mod-import.
        cef_ui.add_command("import-mod", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            const auto path = game_dir_or_fail(ctx, value, response);
            if (!config || !path)
            {
                return;
            }

            const auto source = utils::string::utf8_to_path(json_string(value, "path"));
            const auto is_zip = json_string(value, "kind") == "zip";
            {
                std::lock_guard lock(jobs_mutex_);
                auto& job = jobs_[config->get_game_key()];
                if (job.active)
                {
                    set_result(response, false, "A mod is already being installed for this game.");
                    return;
                }
                job = {true, false, {}, {}};
            }

            std::thread([game = config->get_game_key(), game_dir = *path, source, is_zip]
            {
                std::string error;
                std::optional<std::string> name;
                try
                {
                    name = game_mods::import(game_dir, source, is_zip, error);
                }
                catch (const std::exception& e)
                {
                    error = std::string("The mod could not be installed: ") + e.what();
                }

                std::lock_guard lock(jobs_mutex_);
                auto& job = jobs_[game];
                job.active = false;
                job.finished = true;
                job.name = name.value_or(std::string{});
                job.error = name ? std::string{} : (error.empty() ? "The mod could not be installed." : error);
            }).detach();

            set_result(response, true);
        });

        // { active, finished, name, error }
        cef_ui.add_command("get-mod-import", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto config = ctx.get_game_config_from_request(value);
            import_job job{};
            if (config)
            {
                std::lock_guard lock(jobs_mutex_);
                job = jobs_[config->get_game_key()];
            }
            response.AddMember("active", job.active, allocator);
            response.AddMember("finished", job.finished, allocator);
            response.AddMember("name", make_string(job.name, allocator), allocator);
            response.AddMember("error", make_string(job.error, allocator), allocator);
        });

        cef_ui.add_command("uninstall-mod", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto path = game_dir_or_fail(ctx, value, response);
            if (!path)
            {
                return;
            }

            std::string error;
            const auto ok = game_mods::uninstall(*path, json_string(value, "name"), error);
            set_result(response, ok, error);
        });

        // { title, filters: [{ name, pattern }] } -> path or null
        cef_ui.add_command("browse-file", [&cef_ui](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();

            std::vector<utils::com::file_filter> filters{};
            if (value.IsObject() && value.HasMember("filters") && value["filters"].IsArray())
            {
                for (const auto& filter : value["filters"].GetArray())
                {
                    const auto name = json_string(filter, "name");
                    const auto pattern = json_string(filter, "pattern");
                    if (!name.empty() && !pattern.empty())
                    {
                        filters.push_back({name, pattern});
                    }
                }
            }

            auto title = json_string(value, "title");
            if (title.empty())
            {
                title = "Select a File";
            }

            try
            {
                std::string file{};
                if (utils::com::select_file(file, title, filters))
                {
                    response.SetString(file, response.GetAllocator());
                }
            }
            catch (const std::exception& e)
            {
                printf("browse-file failed: %s\n", e.what());
                if (utils::nt::is_wine_environment())
                {
                    cef_ui.show_message_box("Browse Failed", "File browser is not available under Wine.");
                }
            }
        });
    }
}
