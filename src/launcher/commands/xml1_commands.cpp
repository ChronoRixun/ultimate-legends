#include "std_include.hpp"
#include "xml1_commands.hpp"
#include "cef/cef_ui.hpp"
#include "xml1/xml1_port.hpp"

#include <utils/string.hpp>

// Commands of the X-Men Legends page and its setup wizard (app/xml1-*.js). Builder runs are
// started here and polled by id; see xml1/xml1_port.hpp.
namespace commands::xml1_commands
{
    namespace
    {
        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
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

        bool json_bool(const rapidjson::Value& value, const char* key, const bool fallback)
        {
            if (!value.IsObject())
            {
                return fallback;
            }
            const auto member = value.FindMember(key);
            return member != value.MemberEnd() && member->value.IsBool() ? member->value.GetBool() : fallback;
        }

        std::optional<std::filesystem::path> json_path(const rapidjson::Value& value, const char* key)
        {
            const auto text = json_string(value, key);
            if (text.empty())
            {
                return std::nullopt;
            }
            return utils::string::utf8_to_path(text);
        }

        // JSON text from the builder as a value (null when it doesn't parse).
        rapidjson::Value parse_json(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Document document(&allocator);
            document.Parse(text.data(), text.size());
            if (document.HasParseError())
            {
                return rapidjson::Value(rapidjson::kNullType);
            }
            rapidjson::Value value;
            value.CopyFrom(document, allocator);
            return value;
        }

        void write_snapshot(const xml1::builder_snapshot& job, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
        {
            out.SetObject();
            out.AddMember("id", job.id, allocator);
            out.AddMember("command", make_string(job.command, allocator), allocator);
            out.AddMember("active", job.active, allocator);
            out.AddMember("finished", job.finished, allocator);
            out.AddMember("cancelRequested", job.cancel_requested, allocator);
            out.AddMember("killed", job.killed, allocator);
            out.AddMember("exitCode", job.exit_code, allocator);
            out.AddMember("version", make_string(job.builder_version, allocator), allocator);
            out.AddMember("contentVersion", job.content_version, allocator);
            out.AddMember("stage", make_string(job.stage, allocator), allocator);
            out.AddMember("overall", job.overall, allocator);
            out.AddMember("stagePct", job.stage_pct, allocator);
            out.AddMember("etaS", static_cast<int64_t>(job.eta_s), allocator);
            out.AddMember("done", job.done, allocator);
            out.AddMember("total", job.total, allocator);
            out.AddMember("unit", make_string(job.unit, allocator), allocator);
            out.AddMember("message", make_string(job.message, allocator), allocator);
            out.AddMember("warnings", job.warnings, allocator);
            out.AddMember("seconds", job.seconds, allocator);

            rapidjson::Value stages(rapidjson::kArrayType);
            for (const auto& stage : job.stages)
            {
                rapidjson::Value item(rapidjson::kObjectType);
                item.AddMember("id", make_string(stage.id, allocator), allocator);
                item.AddMember("title", make_string(stage.title, allocator), allocator);
                item.AddMember("weight", stage.weight, allocator);
                item.AddMember("cached", stage.cached, allocator);
                item.AddMember("state", make_string(stage.state, allocator), allocator);
                item.AddMember("seconds", stage.seconds, allocator);
                stages.PushBack(item, allocator);
            }
            out.AddMember("stages", stages, allocator);

            rapidjson::Value errors(rapidjson::kArrayType);
            for (const auto& error : job.errors)
            {
                rapidjson::Value item(rapidjson::kObjectType);
                item.AddMember("stage", make_string(error.stage, allocator), allocator);
                item.AddMember("code", make_string(error.code, allocator), allocator);
                item.AddMember("msg", make_string(error.msg, allocator), allocator);
                item.AddMember("hint", make_string(error.hint, allocator), allocator);
                item.AddMember("detail", parse_json(error.detail, allocator), allocator);
                errors.PushBack(item, allocator);
            }
            out.AddMember("errors", errors, allocator);

            rapidjson::Value notices(rapidjson::kArrayType);
            for (const auto& notice : job.notices)
            {
                rapidjson::Value item(rapidjson::kObjectType);
                item.AddMember("stage", make_string(notice.stage, allocator), allocator);
                item.AddMember("code", make_string(notice.code, allocator), allocator);
                item.AddMember("msg", make_string(notice.msg, allocator), allocator);
                item.AddMember("count", notice.count, allocator);
                item.AddMember("detail", parse_json(notice.detail, allocator), allocator);
                notices.PushBack(item, allocator);
            }
            out.AddMember("notices", notices, allocator);

            out.AddMember("result", job.result.empty() ? rapidjson::Value(rapidjson::kNullType) : parse_json(job.result, allocator), allocator);

            rapidjson::Value tail(rapidjson::kArrayType);
            for (const auto& line : job.log_tail)
            {
                tail.PushBack(make_string(line, allocator), allocator);
            }
            out.AddMember("logTail", tail, allocator);
        }

        // { success, id } or { success: false, code, error }.
        void write_started(rapidjson::Document& response, const std::optional<int>& id, const xml1_port::failure& error)
        {
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
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context&)
    {
        cef_ui.add_command("get-xml1-status", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            xml1_port::write_status(response, response.GetAllocator());
        });

        // { path } -> { free } (bytes, or null when unknown)
        cef_ui.add_command("xml1-free-space", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            const auto path = json_path(value, "path");
            const auto free = path ? xml1_port::free_space(*path) : std::nullopt;
            if (free)
            {
                response.AddMember("free", *free, response.GetAllocator());
            }
            else
            {
                response.AddMember("free", rapidjson::Value(rapidjson::kNullType), response.GetAllocator());
            }
        });

        // { install }: checks the builder's release in the background (and installs it when asked
        // and it is missing or older); get-xml1-status shows how it went.
        cef_ui.add_command("xml1-builder-check", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            xml1_port::check_builder(json_bool(value, "install", false));
            response.SetBool(true);
        });

        // { iso?, out? }: the builder's `info` (the disc check, the state of a build).
        cef_ui.add_command("xml1-info", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            xml1_port::failure error{};
            const auto id = xml1_port::start_info(json_path(value, "iso"), json_path(value, "out"), error);
            write_started(response, id, error);
        });

        cef_ui.add_command("xml1-verify", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            xml1_port::failure error{};
            const auto id = xml1_port::start_verify(error);
            write_started(response, id, error);
        });

        // { iso, out, movies, keepCache, linkBase }
        cef_ui.add_command("xml1-build-start", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            xml1_port::build_options options{};
            options.iso = json_path(value, "iso").value_or(std::filesystem::path{});
            options.out = json_path(value, "out").value_or(std::filesystem::path{});
            options.movies = json_bool(value, "movies", true);
            options.keep_cache = json_bool(value, "keepCache", true);
            options.link_base = json_bool(value, "linkBase", false);
            xml1_port::failure error{};
            const auto id = xml1_port::start_build(options, error);
            write_started(response, id, error);
        });

        cef_ui.add_command("xml1-build-cancel", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            response.SetBool(xml1_port::cancel_build());
        });

        // { mods, cache }: deletes the build (uninstall's first step).
        cef_ui.add_command("xml1-clean", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            xml1_port::failure error{};
            const auto id = xml1_port::start_clean(json_bool(value, "mods", false), json_bool(value, "cache", false), error);
            write_started(response, id, error);
        });

        cef_ui.add_command("xml1-free-cache", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            xml1_port::failure error{};
            const auto id = xml1_port::start_free_cache(error);
            write_started(response, id, error);
        });

        // { game, cache }: bytes on disk (null when there is no such folder).
        cef_ui.add_command("xml1-sizes", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            const auto sizes = xml1_port::disk_usage();
            const auto add = [&](const char* name, const std::optional<std::uint64_t>& value)
            {
                rapidjson::Value json = value ? rapidjson::Value(*value) : rapidjson::Value(rapidjson::kNullType);
                response.AddMember(rapidjson::StringRef(name), json, allocator);
            };
            add("game", sizes.game);
            add("cache", sizes.cache);
        });

        // { path } -> { exists, empty, builder, launcherOnly }: what a destination folder holds.
        cef_ui.add_command("xml1-folder", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            const auto path = json_path(value, "path");
            const auto facts = path ? xml1_port::inspect_folder(*path) : xml1_port::folder_facts{};
            response.AddMember("exists", facts.exists, allocator);
            response.AddMember("empty", facts.empty, allocator);
            response.AddMember("builder", facts.builder, allocator);
            response.AddMember("launcherOnly", facts.launcher_only, allocator);
        });

        // -> { verifyReport (text or null), verifyReportPath, logTail [lines], logPath }: what "Report
        // a problem" attaches, unmasked (the page masks it).
        cef_ui.add_command("xml1-report-sources", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            const auto sources = xml1_port::read_report_sources(80);
            const auto text_or_null = [&](const std::optional<std::string>& text)
            {
                return text ? make_string(*text, allocator) : rapidjson::Value(rapidjson::kNullType);
            };
            const auto path_or_null = [&](const std::optional<std::filesystem::path>& path)
            {
                return path ? make_string(utils::string::path_to_utf8(*path), allocator) : rapidjson::Value(rapidjson::kNullType);
            };
            response.AddMember("verifyReport", text_or_null(sources.verify_report), allocator);
            response.AddMember("verifyReportPath", path_or_null(sources.verify_report_path), allocator);
            rapidjson::Value tail(rapidjson::kArrayType);
            for (const auto& line : sources.log_tail)
            {
                tail.PushBack(make_string(line, allocator), allocator);
            }
            response.AddMember("logTail", tail, allocator);
            response.AddMember("logPath", path_or_null(sources.log_path), allocator);
        });

        // { text, reveal } -> { success, path, error }: saves a (masked) report for an issue and, with
        // reveal, shows it selected in Explorer so it can be dragged into the issue.
        cef_ui.add_command("xml1-save-report", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            std::string error;
            const auto file = xml1_port::save_report(json_string(value, "text"), error);
            response.AddMember("success", file.has_value(), allocator);
            response.AddMember("path", make_string(file ? utils::string::path_to_utf8(*file) : std::string{}, allocator), allocator);
            response.AddMember("error", make_string(error, allocator), allocator);
            if (file && json_bool(value, "reveal", false))
            {
                const auto parameters = L"/select,\"" + file->wstring() + L"\"";
                ShellExecuteW(nullptr, L"open", L"explorer.exe", parameters.c_str(), nullptr, SW_SHOWNORMAL);
            }
        });

        // Opens the builder's latest log in the default text editor; false when there is none.
        cef_ui.add_command("xml1-open-log", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            const auto log = xml1_port::build_log();
            response.SetBool(log.has_value() &&
                             reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", log->wstring().c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32);
        });

        // { id } -> the run's snapshot, or null when it is unknown.
        cef_ui.add_command("get-xml1-job", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();
            if (!value.IsObject() || !value.HasMember("id") || !value["id"].IsInt())
            {
                return;
            }
            if (const auto job = xml1_port::job(value["id"].GetInt()))
            {
                write_snapshot(*job, response, response.GetAllocator());
            }
        });

        // The last build or clean (null when there was none since the launcher started).
        cef_ui.add_command("get-xml1-build", [](const rapidjson::Value&, rapidjson::Document& response)
        {
            response.SetNull();
            if (const auto job = xml1_port::last_work())
            {
                write_snapshot(*job, response, response.GetAllocator());
            }
        });
    }
}
