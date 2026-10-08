#include "std_include.hpp"
#include "xml1_port.hpp"

#include "display/xml2_display.hpp"
#include "game_config.hpp"

#include <utils/io.hpp>
#include <utils/nt.hpp>
#include <utils/logger.hpp>
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>
#include <utils/string.hpp>

#include <version.hpp>

#include <map>
#include <thread>

#pragma comment(lib, "Version.lib")

namespace xml1_port
{
    namespace
    {
        std::mutex mutex_;
        int next_id_ = 1;
        std::map<int, std::shared_ptr<xml1::builder_process>> jobs_;
        int work_id_ = 0;
        constexpr std::size_t kept_jobs = 16;

        // The background manifest check / builder install.
        struct builder_check
        {
            bool checking{};
            bool installing{};
            std::uint64_t done{};
            std::uint64_t total{};
            std::string code;
            std::string error;
            bool not_published{};
            std::optional<tool_install::manifest> latest;
            std::string source; // where the last install came from: "download", or "zip" (one the player had)
        };
        builder_check check_;

        game_config::game_config_t config()
        {
            return *game_config::get_game_config(game_key);
        }

        bool flag(const game_config::game_config_t& game, const char* suffix, const bool fallback)
        {
            const auto value = game.get(suffix);
            return value && !value->empty() ? *value == "true" : fallback;
        }

        std::string property(const game_config::game_config_t& game, const char* suffix)
        {
            return game.get(suffix).value_or(std::string{});
        }

        tool_install::tool builder_tool()
        {
            tool_install::tool tool{"xml1-builder", "xml1-builder.exe", builder_manifest_url};
#ifdef _DEBUG
            // Debug builds only: the CDP tests publish a fake builder from a local server.
            if (const auto manifest = config().get(property_keys::DEV_BUILDER_MANIFEST); manifest && !manifest->empty())
            {
                tool.manifest_url = *manifest;
            }
#endif
            return tool;
        }

        struct builder_exe
        {
            std::filesystem::path exe;
            std::string version;
            bool dev{};
        };

        std::optional<builder_exe> find_builder()
        {
            const auto game = config();
#ifdef _DEBUG
            if (const auto exe = game.get(property_keys::DEV_BUILDER_EXE); exe && !exe->empty())
            {
                const auto path = utils::string::utf8_to_path(*exe);
                if (utils::io::file_exists(path))
                {
                    return builder_exe{path, "dev", true};
                }
            }
#endif
            const auto installed = tool_install::find(builder_tool(), property(game, property_keys::BUILDER_VERSION));
            if (!installed)
            {
                return std::nullopt;
            }
            return builder_exe{installed->exe, installed->version, false};
        }

        // The XML2 install the launcher knows (its xml2 entry), when it still holds the game.
        std::optional<std::filesystem::path> xml2_folder()
        {
            const auto xml2 = game_config::get_game_config("xml2");
            const auto path = xml2 ? xml2->get_install_path() : std::nullopt;
            if (!path || path->empty() || !game_config::validate_game_path("xml2", *path))
            {
                return std::nullopt;
            }
            return path;
        }

        std::filesystem::path cache_folder()
        {
            const auto custom = property(config(), property_keys::BUILD_CACHE);
            if (!custom.empty())
            {
                return utils::string::utf8_to_path(custom);
            }
            return utils::properties::get_appdata_path() / "cache" / "xml1";
        }

        std::optional<std::filesystem::path> output_folder()
        {
            const auto path = config().get_install_path();
            if (!path || path->empty())
            {
                return std::nullopt;
            }
            return path;
        }

        std::optional<std::filesystem::path> iso_path()
        {
            const auto iso = property(config(), property_keys::BUILD_ISO);
            if (iso.empty())
            {
                return std::nullopt;
            }
            return utils::string::utf8_to_path(iso);
        }

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        std::string path_text(const std::optional<std::filesystem::path>& path)
        {
            return path ? utils::string::path_to_utf8(*path) : std::string{};
        }

        // Registers a new run; old finished runs are forgotten.
        std::shared_ptr<xml1::builder_process> new_job(const std::string& command)
        {
            const auto id = next_id_++;
            auto job = std::make_shared<xml1::builder_process>(id, command);
            jobs_[id] = job;
            while (jobs_.size() > kept_jobs)
            {
                const auto oldest = std::find_if(jobs_.begin(), jobs_.end(), [](const auto& entry)
                {
                    return !entry.second->active() && entry.first != work_id_;
                });
                if (oldest == jobs_.end())
                {
                    break;
                }
                jobs_.erase(oldest);
            }
            return job;
        }

        // Starts `builder <command> --events jsonl <args>`. The caller holds mutex_.
        std::optional<int> run_locked(const std::string& command, std::vector<std::wstring> args, xml1::builder_process::finish_callback on_finish,
                                      failure& error, const bool work)
        {
            const auto builder = find_builder();
            if (!builder)
            {
                error = {"L_BUILDER_MISSING", "The X-Men Legends builder is not installed yet."};
                return std::nullopt;
            }

            args.insert(args.begin(), {utils::string::convert(command), L"--events", L"jsonl"});
            const auto job = new_job(command);
            std::string start_error;
            const auto builder_version = builder->version;
            auto finish = [on_finish = std::move(on_finish), builder_version](const xml1::builder_snapshot& snapshot)
            {
                if (snapshot.content_version > 0 && builder_version != "dev")
                {
                    config().set(property_keys::BUILDER_CONTENT, std::to_string(snapshot.content_version));
                }
                if (on_finish)
                {
                    on_finish(snapshot);
                }
            };
            if (!job->start(builder->exe, args, std::move(finish), start_error))
            {
                utils::logger::write("xml1-builder: {}", start_error);
                job->fail("L_BUILDER_START", start_error);
                error = {"L_BUILDER_START", start_error};
                return std::nullopt;
            }
            const auto id = job->snapshot().id;
            if (work)
            {
                work_id_ = id;
            }
            return id;
        }

        bool work_active_locked()
        {
            const auto it = jobs_.find(work_id_);
            return it != jobs_.end() && it->second->active();
        }

        // The version of a DLL's VERSIONINFO ("1.2.0.0"), or "" when it has none.
        std::string file_version(const std::filesystem::path& file)
        {
            DWORD handle = 0;
            const auto size = GetFileVersionInfoSizeW(file.wstring().c_str(), &handle);
            if (!size)
            {
                return {};
            }
            std::vector<std::uint8_t> data(size);
            if (!GetFileVersionInfoW(file.wstring().c_str(), 0, size, data.data()))
            {
                return {};
            }
            VS_FIXEDFILEINFO* info = nullptr;
            UINT length = 0;
            if (!VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &length) || !info)
            {
                return {};
            }
            return std::format("{}.{}.{}.{}", HIWORD(info->dwFileVersionMS), LOWORD(info->dwFileVersionMS),
                               HIWORD(info->dwFileVersionLS), LOWORD(info->dwFileVersionLS));
        }

        std::optional<rapidjson::Document> read_json(const std::filesystem::path& file)
        {
            std::string text;
            if (!utils::io::read_file(file, &text))
            {
                return std::nullopt;
            }
            rapidjson::Document document;
            document.Parse(text.data(), text.size());
            if (document.HasParseError() || !document.IsObject())
            {
                return std::nullopt;
            }
            return document;
        }

        // What the launcher and the player own at the top of the port's folder, which the builder
        // never touches (BUILDER_DESIGN.md F3): dinput.dll, xml2-fix.* and mods\.
        bool launcher_owned(const std::filesystem::path& name)
        {
            const auto text = utils::string::to_lower(utils::string::path_to_utf8(name));
            return text == "dinput.dll" || text == "mods" || text.rfind("xml2-fix.", 0) == 0;
        }

        // The disc the build in `out` was made from (its stamp, or the build under way): the name of
        // its folder in the build cache, or "" when unknown.
        std::string build_disc_id(const std::filesystem::path& out)
        {
            for (const auto* name : {L"stamp.json", L"building.json"})
            {
                const auto document = read_json(out / L"_build" / name);
                if (!document)
                {
                    continue;
                }
                const auto inputs = document->FindMember("inputs");
                if (inputs == document->MemberEnd() || !inputs->value.IsObject())
                {
                    continue;
                }
                const auto disc = inputs->value.FindMember("disc");
                if (disc == inputs->value.MemberEnd() || !disc->value.IsObject())
                {
                    continue;
                }
                const auto id = disc->value.FindMember("disc_id");
                if (id == disc->value.MemberEnd() || !id->value.IsString())
                {
                    continue;
                }
                std::string text = id->value.GetString();
                // A folder name, never a path.
                if (!text.empty() && text.size() <= 64 &&
                    std::all_of(text.begin(), text.end(), [](const char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-'; }))
                {
                    return text;
                }
            }
            return {};
        }

        // The last `count` lines of a text file (it reads at most its last 256 KB).
        std::vector<std::string> tail_lines(const std::filesystem::path& file, const std::size_t count)
        {
            std::vector<std::string> lines;
            std::ifstream stream(file, std::ios::binary);
            if (!stream)
            {
                return lines;
            }
            stream.seekg(0, std::ios::end);
            const auto size = static_cast<std::uint64_t>(stream.tellg());
            constexpr std::uint64_t window = 256 * 1024;
            const auto start = size > window ? size - window : 0;
            stream.seekg(static_cast<std::streamoff>(start), std::ios::beg);
            std::string text(static_cast<std::size_t>(size - start), '\0');
            stream.read(text.data(), static_cast<std::streamsize>(text.size()));
            text.resize(static_cast<std::size_t>(stream.gcount()));

            std::size_t position = 0;
            if (start > 0)
            {
                // The first line of the window is cut off.
                const auto newline = text.find('\n');
                position = newline == std::string::npos ? text.size() : newline + 1;
            }
            while (position < text.size())
            {
                auto newline = text.find('\n', position);
                if (newline == std::string::npos)
                {
                    newline = text.size();
                }
                auto line = text.substr(position, newline - position);
                if (!line.empty() && line.back() == '\r')
                {
                    line.pop_back();
                }
                lines.push_back(std::move(line));
                position = newline + 1;
            }
            if (lines.size() > count)
            {
                lines.erase(lines.begin(), lines.end() - static_cast<std::ptrdiff_t>(count));
            }
            return lines;
        }

        // Writes the play-build display defaults the first time a build finishes (design 3.5):
        // borderless at the desktop's size, running in the background. Never over the player's own.
        void write_display_defaults(const std::filesystem::path& out)
        {
            const auto ini = out / L"xml2-fix.ini";
            if (!xml2_display::read(ini).empty())
            {
                return;
            }
            std::string error;
            if (!xml2_display::write(ini, {{"Mode", "borderless"}, {"Width", "0"}, {"Height", "0"}, {"RunInBackground", "1"}}, error))
            {
                utils::logger::write("xml1: could not write the display defaults: {}", error);
            }
        }

        // What `clean` leaves to the launcher once the build is gone: the fix's own settings and
        // log, and the folder itself when nothing else is in it (dinput.dll goes with delete-game).
        void remove_fix_leftovers(const std::filesystem::path& out)
        {
            std::error_code ignored;
            for (const auto* name : {L"xml2-fix.ini", L"xml2-fix.log"})
            {
                std::filesystem::remove(out / name, ignored);
            }
        }

        void set_check(const std::function<void(builder_check&)>& change)
        {
            std::lock_guard lock(mutex_);
            change(check_);
        }
    }

    folder_facts inspect_folder(const std::filesystem::path& folder)
    {
        folder_facts facts{};
        std::error_code error;
        facts.exists = std::filesystem::is_directory(folder, error);
        if (!facts.exists)
        {
            return facts;
        }
        facts.builder = utils::io::file_exists(folder / L"_build" / L"stamp.json") || utils::io::file_exists(folder / L"_build" / L"building.json");
        bool any = false;
        bool only_owned = true;
        for (std::filesystem::directory_iterator it(folder, std::filesystem::directory_options::skip_permission_denied, error), end;
             !error && it != end; it.increment(error))
        {
            any = true;
            const auto name = it->path().filename();
            // _build without a stamp or a build under way holds nothing of a build either.
            if (launcher_owned(name) || (!facts.builder && utils::string::to_lower(utils::string::path_to_utf8(name)) == "_build"))
            {
                continue;
            }
            only_owned = false;
        }
        facts.empty = !any;
        facts.launcher_only = any && only_owned && !facts.builder;
        return facts;
    }

    report_sources read_report_sources(const std::size_t log_lines)
    {
        report_sources sources{};
        if (const auto out = output_folder())
        {
            const auto file = *out / L"_build" / L"verify-report.json";
            std::string text;
            if (utils::io::read_file(file, &text))
            {
                sources.verify_report = std::move(text);
                sources.verify_report_path = file;
            }
        }
        if (const auto log = build_log())
        {
            sources.log_tail = tail_lines(*log, log_lines);
            sources.log_path = *log;
        }
        return sources;
    }

    std::optional<std::filesystem::path> save_report(const std::string& text, std::string& error)
    {
        const auto folder = utils::properties::get_appdata_path() / L"reports";
        std::error_code fs_error;
        std::filesystem::create_directories(folder, fs_error);
        if (fs_error)
        {
            error = fs_error.message();
            return std::nullopt;
        }
        SYSTEMTIME now{};
        GetLocalTime(&now);
        const auto file = folder / std::format(L"xml1-report-{:04}{:02}{:02}-{:02}{:02}{:02}.txt", now.wYear, now.wMonth, now.wDay,
                                               now.wHour, now.wMinute, now.wSecond);
        if (!utils::io::write_file(file, text, false))
        {
            error = "the report could not be written";
            return std::nullopt;
        }
        return file;
    }

    bool is_playable(const std::filesystem::path& folder)
    {
        return utils::io::file_exists(folder / L"XMen2.exe") && utils::io::file_exists(folder / L"_build" / L"stamp.json") &&
               !utils::io::file_exists(folder / L"_build" / L"building.json");
    }

    sizes disk_usage()
    {
        const auto folder_bytes = [](const std::filesystem::path& folder) -> std::optional<std::uint64_t>
        {
            std::error_code error;
            if (!std::filesystem::is_directory(folder, error))
            {
                return std::nullopt;
            }
            std::uint64_t total = 0;
            for (std::filesystem::recursive_directory_iterator it(folder, std::filesystem::directory_options::skip_permission_denied, error), end;
                 !error && it != end; it.increment(error))
            {
                if (it->is_regular_file(error) && !it->is_symlink(error))
                {
                    total += it->file_size(error);
                }
            }
            return total;
        };

        sizes result{};
        if (const auto out = output_folder())
        {
            result.game = folder_bytes(*out);
        }
        result.cache = folder_bytes(cache_folder());
        return result;
    }

    std::optional<std::filesystem::path> build_log()
    {
        if (const auto out = output_folder())
        {
            const auto log = *out / L"_build" / L"builder.log";
            if (utils::io::file_exists(log))
            {
                return log;
            }
        }

        std::optional<std::filesystem::path> newest;
        std::filesystem::file_time_type newest_time{};
        std::error_code error;
        for (const auto& entry : std::filesystem::directory_iterator(cache_folder() / L"logs", error))
        {
            if (entry.is_regular_file(error) && entry.path().extension() == L".log")
            {
                const auto time = entry.last_write_time(error);
                if (!newest || time > newest_time)
                {
                    newest = entry.path();
                    newest_time = time;
                }
            }
        }
        return newest;
    }

    std::optional<std::filesystem::path> default_output()
    {
        const auto xml2 = xml2_folder();
        if (!xml2)
        {
            return std::nullopt;
        }
        auto parent = xml2->lexically_normal();
        if (!parent.has_filename())
        {
            parent = parent.parent_path(); // "D:\Games\XML2\" -> "D:\Games\XML2"
        }
        return parent.parent_path() / L"X-Men Legends (Port)";
    }

    std::optional<std::uint64_t> free_space(const std::filesystem::path& path)
    {
        auto existing = path;
        std::error_code error;
        while (!existing.empty() && !std::filesystem::exists(existing, error))
        {
            const auto parent = existing.parent_path();
            if (parent == existing)
            {
                break;
            }
            existing = parent;
        }
        ULARGE_INTEGER free{};
        if (existing.empty() || !GetDiskFreeSpaceExW(existing.wstring().c_str(), &free, nullptr, nullptr))
        {
            return std::nullopt;
        }
        return free.QuadPart;
    }

    std::optional<int> start_info(const std::optional<std::filesystem::path>& iso, const std::optional<std::filesystem::path>& out,
                                  failure& error)
    {
        std::vector<std::wstring> args;
        if (iso)
        {
            args.insert(args.end(), {L"--iso", iso->wstring()});
        }
        if (const auto xml2 = xml2_folder())
        {
            args.insert(args.end(), {L"--xml2", xml2->wstring()});
        }
        if (out)
        {
            args.insert(args.end(), {L"--out", out->wstring()});
        }
        args.insert(args.end(), {L"--cache", cache_folder().wstring()});

        std::lock_guard lock(mutex_);
        return run_locked("info", std::move(args), {}, error, false);
    }

    std::optional<int> start_verify(failure& error)
    {
        const auto out = output_folder();
        if (!out)
        {
            error = {"L_NOT_SET_UP", "X-Men Legends has not been built yet."};
            return std::nullopt;
        }
        std::vector<std::wstring> args{L"--out", out->wstring()};
        if (const auto xml2 = xml2_folder())
        {
            args.insert(args.end(), {L"--xml2", xml2->wstring()});
        }
        if (const auto iso = iso_path(); iso && utils::io::file_exists(*iso))
        {
            args.insert(args.end(), {L"--iso", iso->wstring()});
        }

        std::lock_guard lock(mutex_);
        return run_locked("verify", std::move(args), {}, error, false);
    }

    std::optional<int> start_build(const build_options& options, failure& error)
    {
        const auto xml2 = xml2_folder();
        if (!xml2)
        {
            error = {"L_XML2_NOT_SET_UP", "Set up X-Men Legends II in the launcher first."};
            return std::nullopt;
        }
        // Without a disc image the builder takes the disc from the build cache (it keeps it after a
        // first build, design 2.6), and says so (E_USAGE / E_CACHE_*) when it can't.
        if (options.out.empty())
        {
            error = {"L_USAGE", "Choose a disc image and a folder first."};
            return std::nullopt;
        }
        // The builder writes into the folder: the port must not be running from it.
        if (utils::nt::is_any_image_running({options.out / L"XMen2.exe"}, 0))
        {
            error = {"L_GAME_RUNNING", "Close X-Men Legends before building it again."};
            return std::nullopt;
        }

        std::lock_guard lock(mutex_);
        if (work_active_locked())
        {
            error = {"L_BUILD_RUNNING", "A build is already running."};
            return std::nullopt;
        }

        // Remember the choices now, so a cancelled or failed build can be resumed.
        const auto game = config();
        game.set_install_path(options.out);
        game.set_installed(false);
        if (!options.iso.empty())
        {
            game.set(property_keys::BUILD_ISO, utils::string::path_to_utf8(options.iso)); // (a build from the cache keeps the old one)
        }
        game.set(property_keys::BUILD_MOVIES, options.movies ? "true" : "false");
        game.set(property_keys::BUILD_KEEP_CACHE, options.keep_cache ? "true" : "false");
        game.set(property_keys::BUILD_LINK_BASE, options.link_base ? "true" : "false");

        std::vector<std::wstring> args;
        if (!options.iso.empty())
        {
            args.insert(args.end(), {L"--iso", options.iso.wstring()});
        }
        args.insert(args.end(), {L"--xml2", xml2->wstring(), L"--out", options.out.wstring(), L"--cache", cache_folder().wstring(),
                                 options.movies ? L"--movies" : L"--no-movies", options.keep_cache ? L"--keep-cache" : L"--drop-cache"});
        if (options.link_base)
        {
            args.emplace_back(L"--link-base");
        }

        const auto out = options.out;
        return run_locked("build", std::move(args), [out](const xml1::builder_snapshot& snapshot)
        {
            if (snapshot.exit_code != 0)
            {
                return;
            }
            write_display_defaults(out);
            // The build worked with this builder: older versions can go (design 4.1).
            const auto game = config();
            const auto builder = find_builder();
            if (builder && !builder->dev)
            {
                game.set(property_keys::BUILDER_VERSION, builder->version);
                std::lock_guard lock(mutex_);
                if (!check_.installing)
                {
                    tool_install::prune(builder_tool(), {builder->version});
                }
            }
        }, error, true);
    }

    std::optional<int> start_clean(const bool mods, const bool cache, failure& error)
    {
        const auto out = output_folder();
        if (!out)
        {
            error = {"L_NOT_SET_UP", "X-Men Legends has not been built yet."};
            return std::nullopt;
        }
        if (utils::nt::is_any_image_running({*out / L"XMen2.exe"}, 0))
        {
            error = {"L_GAME_RUNNING", "Close X-Men Legends first."};
            return std::nullopt;
        }

        std::vector<std::wstring> args{L"--out", out->wstring()};
        if (mods)
        {
            args.emplace_back(L"--mods");
        }
        if (cache)
        {
            args.insert(args.end(), {L"--cache", cache_folder().wstring()});
        }

        std::lock_guard lock(mutex_);
        if (work_active_locked())
        {
            error = {"L_BUILD_RUNNING", "A build is running."};
            return std::nullopt;
        }
        const auto folder = *out;
        return run_locked("clean", std::move(args), [folder](const xml1::builder_snapshot& snapshot)
        {
            if (snapshot.exit_code == 0)
            {
                remove_fix_leftovers(folder);
            }
        }, error, true);
    }

    std::optional<int> start_free_cache(failure& error)
    {
        std::lock_guard lock(mutex_);
        if (work_active_locked())
        {
            error = {"L_BUILD_RUNNING", "A build is running."};
            return std::nullopt;
        }
        return run_locked("clean", {L"--cache", cache_folder().wstring()}, {}, error, true);
    }

    bool cancel_build()
    {
        std::lock_guard lock(mutex_);
        const auto it = jobs_.find(work_id_);
        if (it == jobs_.end() || !it->second->active())
        {
            return false;
        }
        it->second->cancel();
        return true;
    }

    std::optional<xml1::builder_snapshot> job(const int id)
    {
        std::lock_guard lock(mutex_);
        const auto it = jobs_.find(id);
        if (it == jobs_.end())
        {
            return std::nullopt;
        }
        return it->second->snapshot();
    }

    std::optional<xml1::builder_snapshot> last_work()
    {
        return job(work_id_);
    }

    bool is_working()
    {
        std::lock_guard lock(mutex_);
        return work_active_locked();
    }

    bool check_builder(const bool install, const std::optional<std::filesystem::path>& zip)
    {
        {
            std::lock_guard lock(mutex_);
            if (check_.checking || check_.installing)
            {
                return false;
            }
            check_.checking = true;
            check_.code.clear();
            check_.error.clear();
            check_.not_published = false;
            check_.source.clear();
        }

        std::thread([install, zip]
        {
            const auto tool = builder_tool();
            std::string error;
            bool not_published = false;
            const auto latest = tool_install::fetch_manifest(tool, error, &not_published);
            if (!latest)
            {
                utils::logger::write("xml1-builder: manifest {}: {}", tool.manifest_url, error);
                set_check([&](builder_check& check)
                {
                    check.checking = false;
                    check.latest.reset(); // what an earlier check found no longer holds
                    check.not_published = not_published;
                    // A zip the player has is checked against the release, so it needs the manifest too.
                    check.code = not_published ? "L_BUILDER_UNPUBLISHED" : zip ? "L_BUILDER_ZIP_OFFLINE" : "L_BUILDER_OFFLINE";
                    check.error = error;
                });
                return;
            }

            const std::string launcher_version = VERSION_PRODUCT;
            if (!latest->min_launcher.empty() && launcher_version != "0.0.0" &&
                tool_install::compare_versions(launcher_version, latest->min_launcher) < 0)
            {
                set_check([&](builder_check& check)
                {
                    check.checking = false;
                    check.latest = latest;
                    check.code = "L_LAUNCHER_TOO_OLD";
                    check.error = "This builder needs Ultimate Legends " + latest->min_launcher + " or newer.";
                });
                return;
            }

            // A zip the player chose is always checked (and installed when it is the release's).
            const auto installed = find_builder();
            const auto wanted = zip || (install && (!installed || (!installed->dev && tool_install::compare_versions(latest->version, installed->version) > 0)));
            set_check([&](builder_check& check)
            {
                check.checking = false;
                check.latest = latest;
                check.installing = wanted;
                check.done = 0;
                check.total = latest->size;
            });
            if (!wanted)
            {
                return;
            }

            // Never while a build runs with the current version (its folder must stay).
            while (is_working())
            {
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }

            std::optional<tool_install::installed> result;
            std::string code;
            std::string source;
            if (zip)
            {
                std::optional<tool_install::zip_match> match;
                result = tool_install::install_from_zip(tool, *latest, *zip, match, error);
                source = "zip";
                code = !match ? "L_BUILDER_ZIP_UNREADABLE"
                     : *match == tool_install::zip_match::older ? "L_BUILDER_ZIP_OLD"
                     : *match != tool_install::zip_match::same ? "L_BUILDER_ZIP_MISMATCH"
                     : "L_BUILDER_EXTRACT";
            }
            else
            {
                // The release's zip already on this PC (put in tools\xml1-builder or in Downloads by
                // hand): used when it checks out, else downloaded as usual.
                if (const auto local = tool_install::find_local_zip(tool, *latest))
                {
                    std::optional<tool_install::zip_match> match;
                    std::string local_error;
                    result = tool_install::install_from_zip(tool, *latest, *local, match, local_error);
                    source = "zip";
                    if (!result)
                    {
                        utils::logger::write("xml1-builder: {} not used ({}); downloading the release", utils::string::path_to_utf8(*local),
                                             local_error);
                    }
                }
                if (!result)
                {
                    result = tool_install::install(tool, *latest, [](const std::uint64_t done, const std::uint64_t total)
                    {
                        set_check([&](builder_check& check)
                        {
                            check.done = done;
                            check.total = total;
                        });
                    }, {}, error);
                    source = "download";
                    code = error.find("SHA-256") != std::string::npos ? "L_BUILDER_HASH"
                         : error.find("zip") != std::string::npos || error.find("unpack") != std::string::npos ? "L_BUILDER_EXTRACT"
                         : "L_BUILDER_DOWNLOAD";
                }
            }

            if (result)
            {
                const auto game = config();
                game.set(property_keys::BUILDER_VERSION, result->version);
                game.set(property_keys::BUILDER_CONTENT, std::to_string(latest->content_version));
            }
            set_check([&](builder_check& check)
            {
                check.installing = false;
                if (result)
                {
                    check.source = source;
                }
                else
                {
                    utils::logger::write("xml1 builder install failed: {}", error);
                    check.code = code;
                    check.error = error;
                }
            });
        }).detach();
        return true;
    }

    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
    {
        out.SetObject();
        const auto game = config();

        // X-Men Legends II, which the port is built from.
        {
            rapidjson::Value xml2(rapidjson::kObjectType);
            const auto folder = xml2_folder();
            xml2.AddMember("setUp", folder.has_value(), allocator);
            xml2.AddMember("path", make_string(path_text(folder), allocator), allocator);
            out.AddMember("xml2", xml2, allocator);
        }

        const auto folder = output_folder();
        const auto facts = folder ? inspect_folder(*folder) : folder_facts{};
        const auto exists = facts.exists;
        const auto empty = !exists || facts.empty;
        const auto iso = iso_path();
        out.AddMember("install", make_string(path_text(folder), allocator), allocator);
        out.AddMember("exists", exists && !empty, allocator);
        // Only the XML2 Fix / its settings / mods in it: nothing is built there (the builder takes it).
        out.AddMember("launcherOnly", facts.launcher_only, allocator);
        out.AddMember("isInstalled", game.is_installed(), allocator);
        out.AddMember("iso", make_string(path_text(iso), allocator), allocator);
        out.AddMember("isoExists", iso && utils::io::file_exists(*iso), allocator);
        out.AddMember("movies", flag(game, property_keys::BUILD_MOVIES, true), allocator);
        out.AddMember("keepCache", flag(game, property_keys::BUILD_KEEP_CACHE, true), allocator);
        out.AddMember("linkBase", flag(game, property_keys::BUILD_LINK_BASE, false), allocator);
        out.AddMember("cache", make_string(utils::string::path_to_utf8(cache_folder()), allocator), allocator);
        // The build cache still holds the disc of the build in the folder: a rebuild, a repair or a
        // resume works without the disc image (the builder reads the disc from the cache).
        {
            const auto disc_id = folder ? build_disc_id(*folder) : std::string{};
            out.AddMember("discId", make_string(disc_id, allocator), allocator);
            out.AddMember("cacheHasDisc", !disc_id.empty() && utils::io::file_exists(cache_folder() / disc_id / L"disc" / L"stage.json"),
                          allocator);
        }
        out.AddMember("defaultOut", make_string(path_text(default_output()), allocator), allocator);
        out.AddMember("running", folder.has_value() && utils::nt::is_any_image_running({*folder / L"XMen2.exe"}, 1000), allocator);

        // The build in the folder, as its files say (the builder's `info` says more).
        int stamp_content = 0;
        std::string required_fix;
        {
            rapidjson::Value build(rapidjson::kObjectType);
            const auto stamp = folder ? read_json(*folder / L"_build" / L"stamp.json") : std::nullopt;
            const auto building = folder && utils::io::file_exists(*folder / L"_build" / L"building.json");
            build.AddMember("stamp", stamp.has_value(), allocator);
            build.AddMember("building", building, allocator);
            if (stamp)
            {
                const auto& doc = *stamp;
                if (doc.HasMember("builder") && doc["builder"].IsObject())
                {
                    const auto& builder = doc["builder"];
                    if (builder.HasMember("content_version") && builder["content_version"].IsInt())
                    {
                        stamp_content = builder["content_version"].GetInt();
                    }
                    if (builder.HasMember("version") && builder["version"].IsString())
                    {
                        build.AddMember("builderVersion", make_string(builder["version"].GetString(), allocator), allocator);
                    }
                }
                if (doc.HasMember("finished") && doc["finished"].IsString())
                {
                    build.AddMember("finished", make_string(doc["finished"].GetString(), allocator), allocator);
                }
                if (doc.HasMember("profile") && doc["profile"].IsObject() && doc["profile"].HasMember("movies") && doc["profile"]["movies"].IsBool())
                {
                    build.AddMember("movies", doc["profile"]["movies"].GetBool(), allocator);
                }
                if (doc.HasMember("requires") && doc["requires"].IsObject() && doc["requires"].HasMember("xml2fix") &&
                    doc["requires"]["xml2fix"].IsString())
                {
                    required_fix = doc["requires"]["xml2fix"].GetString();
                }
                if (doc.HasMember("outputs") && doc["outputs"].IsObject() && doc["outputs"].HasMember("bytes") && doc["outputs"]["bytes"].IsUint64())
                {
                    build.AddMember("bytes", doc["outputs"]["bytes"].GetUint64(), allocator);
                }
            }
            build.AddMember("contentVersion", stamp_content, allocator);
            out.AddMember("build", build, allocator);
        }

        // The XML2 Fix in the built folder, against what the build needs.
        {
            rapidjson::Value fix(rapidjson::kObjectType);
            const auto dll = folder ? *folder / L"dinput.dll" : std::filesystem::path{};
            const auto installed = folder && utils::io::file_exists(dll);
            const auto version = installed ? file_version(dll) : std::string{};
            auto required = required_fix;
            required.erase(0, required.find_first_of("0123456789") == std::string::npos ? required.size() : required.find_first_of("0123456789"));
            const auto ok = installed && (required.empty() || (!version.empty() && tool_install::compare_versions(version, required) >= 0));
            fix.AddMember("installed", installed, allocator);
            fix.AddMember("version", make_string(version, allocator), allocator);
            fix.AddMember("required", make_string(required, allocator), allocator);
            fix.AddMember("ok", ok, allocator);
            out.AddMember("fix", fix, allocator);
        }

        // The builder: installed, the latest release, a check or install in progress.
        int builder_content = 0;
        {
            rapidjson::Value builder(rapidjson::kObjectType);
            const auto found = find_builder();
            try
            {
                builder_content = std::stoi(property(game, property_keys::BUILDER_CONTENT));
            }
            catch (...)
            {
            }
            builder.AddMember("installed", found.has_value(), allocator);
            builder.AddMember("version", make_string(found ? found->version : std::string{}, allocator), allocator);
            builder.AddMember("dev", found && found->dev, allocator);
            builder.AddMember("contentVersion", builder_content, allocator);

            std::lock_guard lock(mutex_);
            builder.AddMember("checking", check_.checking, allocator);
            builder.AddMember("installing", check_.installing, allocator);
            builder.AddMember("done", check_.done, allocator);
            builder.AddMember("total", check_.total, allocator);
            builder.AddMember("code", make_string(check_.code, allocator), allocator);
            builder.AddMember("error", make_string(check_.error, allocator), allocator);
            builder.AddMember("notPublished", check_.not_published, allocator);
            builder.AddMember("source", make_string(check_.source, allocator), allocator);
            if (check_.latest)
            {
                rapidjson::Value latest(rapidjson::kObjectType);
                latest.AddMember("version", make_string(check_.latest->version, allocator), allocator);
                latest.AddMember("contentVersion", check_.latest->content_version, allocator);
                latest.AddMember("size", check_.latest->size, allocator);
                builder.AddMember("latest", latest, allocator);
                builder.AddMember("updateAvailable", found && !found->dev && tool_install::compare_versions(check_.latest->version, found->version) > 0,
                                  allocator);
            }
            else
            {
                builder.AddMember("latest", rapidjson::Value(rapidjson::kNullType), allocator);
                builder.AddMember("updateAvailable", false, allocator);
            }
            out.AddMember("builder", builder, allocator);
        }

        // The last build or clean.
        const auto work = last_work();
        if (work)
        {
            rapidjson::Value brief(rapidjson::kObjectType);
            brief.AddMember("id", work->id, allocator);
            brief.AddMember("command", make_string(work->command, allocator), allocator);
            brief.AddMember("active", work->active, allocator);
            brief.AddMember("exitCode", work->exit_code, allocator);
            out.AddMember("work", brief, allocator);
        }
        else
        {
            out.AddMember("work", rapidjson::Value(rapidjson::kNullType), allocator);
        }

        // One state for the buttons (design 2.7 and 4.3); `info` and `verify` refine it in the UI.
        std::string state;
        const auto stamp = folder && utils::io::file_exists(*folder / L"_build" / L"stamp.json");
        const auto building = folder && utils::io::file_exists(*folder / L"_build" / L"building.json");
        if (work && work->active && work->command == "build")
        {
            state = "building";
        }
        else if (!folder)
        {
            state = "not-setup";
        }
        else if (!exists || empty || facts.launcher_only)
        {
            state = "absent";
        }
        else if (building || !stamp)
        {
            state = "incomplete";
        }
        else if (!game.is_installed())
        {
            state = "needs-fix";
        }
        else if (builder_content > 0 && stamp_content > 0 && stamp_content < builder_content)
        {
            state = "stale";
        }
        else
        {
            state = "ready";
        }
        out.AddMember("state", make_string(state, allocator), allocator);
    }
}
