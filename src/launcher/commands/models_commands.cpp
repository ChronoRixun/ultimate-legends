#include "std_include.hpp"
#include "models_commands.hpp"
#include "cef/cef_ui.hpp"
#include "game_config.hpp"
#include "models/models_tool.hpp"
#include "xml1/xml1_port.hpp"

#include <utils/io.hpp>
#include <utils/string.hpp>

// Commands of the Character models section (app/models-view.js). The page asks for a command and its
// choices; models_tool fills in the folders and models_args checks every value before it becomes an
// argument of legends-models. Runs are started here and polled by id (get-models-job), like the
// builder's.
namespace commands::models_commands
{
    namespace
    {
        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        rapidjson::Value make_path(const std::optional<std::filesystem::path>& path, rapidjson::Document::AllocatorType& allocator)
        {
            return path ? make_string(utils::string::path_to_utf8(*path), allocator) : rapidjson::Value(rapidjson::kNullType);
        }

        std::string json_string(const rapidjson::Value& value, const char* key)
        {
            if (!value.IsObject())
            {
                return {};
            }
            const auto member = value.FindMember(key);
            return member != value.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }

        bool has_string(const rapidjson::Value& value, const char* key)
        {
            return value.IsObject() && value.HasMember(key) && value[key].IsString();
        }

        std::optional<std::filesystem::path> install_of(const char* game)
        {
            const auto config = game_config::get_game_config(game);
            const auto path = config ? config->get_install_path() : std::nullopt;
            return path && utils::io::directory_exists(*path) ? path : std::nullopt;
        }

        // {hero: "ID" | "tier:ID"} from the request (strings only; checked by models_args later).
        std::map<std::string, std::string> request_costumes(const rapidjson::Value& value)
        {
            std::map<std::string, std::string> costumes;
            if (!value.IsObject() || !value.HasMember("costumes") || !value["costumes"].IsObject())
            {
                return costumes;
            }
            for (auto member = value["costumes"].MemberBegin(); member != value["costumes"].MemberEnd(); ++member)
            {
                if (member->name.IsString() && member->value.IsString() && member->value.GetStringLength() > 0)
                {
                    costumes[member->name.GetString()] = member->value.GetString();
                }
            }
            return costumes;
        }

        void write_settings(const models_tool::settings& settings, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
        {
            out.SetObject();
            out.AddMember("mode", make_string(settings.mode, allocator), allocator);
            out.AddMember("mirror", make_string(settings.mirror, allocator), allocator);
            rapidjson::Value costumes(rapidjson::kObjectType);
            for (const auto& [hero, costume] : settings.costumes)
            {
                costumes.AddMember(make_string(hero, allocator), make_string(costume, allocator), allocator);
            }
            out.AddMember("costumes", costumes, allocator);
        }

        void write_job(const models_tool::job_snapshot& job, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
        {
            out.SetObject();
            out.AddMember("id", job.id, allocator);
            out.AddMember("command", make_string(job.command, allocator), allocator);
            out.AddMember("active", job.active, allocator);
            out.AddMember("finished", job.finished, allocator);
            out.AddMember("cancelRequested", job.cancel_requested, allocator);
            out.AddMember("exitCode", job.exit_code, allocator);
            out.AddMember("exitName", make_string(job.finished ? models_args::exit_name(job.exit_code) : std::string{}, allocator), allocator);
            out.AddMember("seconds", job.seconds, allocator);
            out.AddMember("first", static_cast<uint64_t>(job.first), allocator);
            out.AddMember("total", static_cast<uint64_t>(job.total_lines), allocator);
            out.AddMember("startError", make_string(job.start_error, allocator), allocator);
            rapidjson::Value lines(rapidjson::kArrayType);
            for (const auto& line : job.lines)
            {
                lines.PushBack(make_string(line, allocator), allocator);
            }
            out.AddMember("lines", lines, allocator);
            rapidjson::Value tail(rapidjson::kArrayType);
            for (const auto& line : job.stderr_tail)
            {
                tail.PushBack(make_string(line, allocator), allocator);
            }
            out.AddMember("stderrTail", tail, allocator);
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context&)
    {
        // { tool: {found, version, dev, path}, port: {path, built, running}, installs: {mua1, mua2},
        //   settings: {mode, mirror, costumes}, defaultMirror, modsFolder, installed: [{folder, group,
        //   mode, enabled, listed, credits, characters: [{hero, tier, source}]}], busy, xml1Busy, job }
        cef_ui.add_command("get-models-status", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            rapidjson::Value tool(rapidjson::kObjectType);
            const auto location = models_tool::find_tool();
            tool.AddMember("found", location.has_value(), allocator);
            tool.AddMember("version", make_string(location ? location->version : std::string{}, allocator), allocator);
            tool.AddMember("dev", location && location->dev, allocator);
            response.AddMember("tool", tool, allocator);

            const auto config = game_config::get_game_config("xml1");
            const auto port_path = config ? config->get_install_path() : std::nullopt;
            const auto port = models_tool::port_folder();
            rapidjson::Value port_info(rapidjson::kObjectType);
            port_info.AddMember("path", make_path(port_path, allocator), allocator);
            port_info.AddMember("built", port.has_value(), allocator);
            port_info.AddMember("running", config && game_config::is_game_process_running(config->get_game_key(), 1000), allocator);
            response.AddMember("port", port_info, allocator);

            rapidjson::Value installs(rapidjson::kObjectType);
            installs.AddMember("mua1", make_path(install_of("mua"), allocator), allocator);
            installs.AddMember("mua2", make_path(install_of("mua2"), allocator), allocator);
            response.AddMember("installs", installs, allocator);

            rapidjson::Value settings;
            write_settings(models_tool::read_settings(), settings, allocator);
            response.AddMember("settings", settings, allocator);
            response.AddMember("defaultMirror", make_string(models_tool::default_mirror(), allocator), allocator);
            response.AddMember("modsFolder", port ? make_string(utils::string::path_to_utf8(*port / L"mods"), allocator)
                                                  : rapidjson::Value(rapidjson::kNullType), allocator);

            rapidjson::Value installed(rapidjson::kArrayType);
            if (port)
            {
                for (const auto& folder : models_tool::installed(*port))
                {
                    rapidjson::Value item(rapidjson::kObjectType);
                    item.AddMember("folder", make_string(folder.folder, allocator), allocator);
                    item.AddMember("group", make_string(folder.marker.group, allocator), allocator);
                    item.AddMember("mode", make_string(folder.marker.mode, allocator), allocator);
                    item.AddMember("version", make_string(folder.marker.version, allocator), allocator);
                    item.AddMember("listed", folder.listed, allocator);
                    item.AddMember("enabled", folder.enabled, allocator);
                    item.AddMember("credits", folder.has_credits, allocator);
                    rapidjson::Value characters(rapidjson::kArrayType);
                    for (const auto& character : folder.marker.characters)
                    {
                        rapidjson::Value entry(rapidjson::kObjectType);
                        entry.AddMember("hero", make_string(character.hero, allocator), allocator);
                        entry.AddMember("tier", make_string(character.tier, allocator), allocator);
                        entry.AddMember("source", make_string(character.source, allocator), allocator);
                        characters.PushBack(entry, allocator);
                    }
                    item.AddMember("characters", characters, allocator);
                    installed.PushBack(item, allocator);
                }
            }
            response.AddMember("installed", installed, allocator);

            response.AddMember("busy", models_tool::busy(), allocator);
            response.AddMember("xml1Busy", xml1_port::is_working(), allocator);
            if (const auto last = models_tool::last())
            {
                rapidjson::Value job;
                write_job(*last, job, allocator);
                response.AddMember("job", job, allocator);
            }
            else
            {
                response.AddMember("job", rapidjson::Value(rapidjson::kNullType), allocator);
            }
        });

        // { mode?, mirror?, costumes? }: only the fields sent change. -> { success, error?, settings }
        cef_ui.add_command("set-models-settings", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            auto settings = models_tool::read_settings();
            if (has_string(value, "mode"))
            {
                settings.mode = json_string(value, "mode");
            }
            if (has_string(value, "mirror"))
            {
                settings.mirror = json_string(value, "mirror");
            }
            if (value.IsObject() && value.HasMember("costumes") && value["costumes"].IsObject())
            {
                settings.costumes = request_costumes(value);
            }

            std::string error;
            const auto ok = models_tool::write_settings(settings, error);
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", ok, allocator);
            if (!ok)
            {
                response.AddMember("error", make_string(error, allocator), allocator);
            }
            rapidjson::Value stored;
            write_settings(models_tool::read_settings(), stored, allocator);
            response.AddMember("settings", stored, allocator);
        });

        // { command: scan | plan | build | verify | remove, mode?, pack?, costumes?, heroes?, rebuild? }
        // -> { success, id } or { success: false, code, error }. plan / build use the stored costume
        // choices unless the request sends its own.
        cef_ui.add_command("models-run", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            models_args::request request{};
            request.command = json_string(value, "command");
            request.mode = json_string(value, "mode");
            request.pack = json_string(value, "pack");
            request.costumes = value.IsObject() && value.HasMember("costumes") && value["costumes"].IsObject()
                                   ? request_costumes(value)
                                   : models_tool::read_settings().costumes;
            if (value.IsObject() && value.HasMember("heroes") && value["heroes"].IsArray())
            {
                for (const auto& hero : value["heroes"].GetArray())
                {
                    if (hero.IsString())
                    {
                        request.heroes.emplace_back(hero.GetString());
                    }
                }
            }
            request.rebuild = value.IsObject() && value.HasMember("rebuild") && value["rebuild"].IsBool() && value["rebuild"].GetBool();

            models_tool::failure error{};
            std::optional<int> id;
            const auto writes = request.command == "build" || request.command == "remove";
            if (writes && xml1_port::is_working())
            {
                error = {"L_BUILD_RUNNING", "Wait for the X-Men Legends build to finish."};
            }
            else
            {
                id = models_tool::start(std::move(request), error);
            }

            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", id.has_value(), allocator);
            if (id)
            {
                response.AddMember("id", *id, allocator);
            }
            else
            {
                response.AddMember("code", make_string(error.code, allocator), allocator);
                response.AddMember("error", make_string(error.message, allocator), allocator);
            }
        });

        // { id, from } -> the run with its stdout lines from index `from` on, or null.
        cef_ui.add_command("get-models-job", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto id = value.IsObject() && value.HasMember("id") && value["id"].IsInt() ? value["id"].GetInt() : -1;
            const auto from = value.IsObject() && value.HasMember("from") && value["from"].IsUint64() ? value["from"].GetUint64() : 0;
            const auto job = models_tool::job(id, static_cast<std::size_t>(from));
            if (!job)
            {
                response.SetNull();
                return;
            }
            write_job(*job, response, response.GetAllocator());
        });

        cef_ui.add_command("models-cancel", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto id = value.IsObject() && value.HasMember("id") && value["id"].IsInt() ? value["id"].GetInt() : -1;
            response.SetBool(models_tool::cancel(id));
        });

        // { group? } -> { credits: [{folder, text}] }: CREDITS.md of the built pack's folders.
        cef_ui.add_command("get-models-credits", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            rapidjson::Value list(rapidjson::kArrayType);
            if (const auto port = models_tool::port_folder())
            {
                for (const auto& [folder, text] : models_tool::credits(*port, json_string(value, "group")))
                {
                    rapidjson::Value item(rapidjson::kObjectType);
                    item.AddMember("folder", make_string(folder, allocator), allocator);
                    item.AddMember("text", make_string(text, allocator), allocator);
                    list.PushBack(item, allocator);
                }
            }
            response.AddMember("credits", list, allocator);
        });
    }
}
