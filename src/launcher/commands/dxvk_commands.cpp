#include "std_include.hpp"
#include "dxvk_commands.hpp"
#include "cef/cef_ui.hpp"
#include "display/dxvk.hpp"
#include "muac/platform.hpp"
#include "tools/tool_install.hpp"
#include "updater/folder_work.hpp"

#include <utils/flags.hpp>
#include <utils/logger.hpp>
#include <utils/string.hpp>

#include <atomic>
#include <mutex>
#include <thread>

namespace commands::dxvk_commands
{
    namespace
    {
        // The DXVK work of one game: one job at a time (turning on downloads and installs in the background).
        struct job
        {
            std::mutex mutex;
            bool busy{};
            std::string phase;
            std::uint64_t done{};
            std::uint64_t total{};
            std::string error; // the last job's failure, until the next one starts
            std::atomic<bool> cancel{};
        };

        std::mutex jobs_mutex;
        std::map<std::string, std::shared_ptr<job>> jobs;

        std::shared_ptr<job> job_of(const std::string& game)
        {
            std::lock_guard lock(jobs_mutex);
            auto& entry = jobs[game];
            if (!entry) entry = std::make_shared<job>();
            return entry;
        }

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        bool supported(const std::optional<game_config::game_config_t>& config)
        {
            return config && (config->get_game_key() == "xml1" || config->get_game_key() == "xml2");
        }

        // The folder the game's XMen2.exe runs from, when it is set and exists.
        std::optional<std::filesystem::path> game_dir(const std::optional<game_config::game_config_t>& config)
        {
            if (!supported(config)) return std::nullopt;
            const auto path = config->get_install_path();
            std::error_code ec;
            if (!path || path->empty() || !std::filesystem::is_directory(*path, ec)) return std::nullopt;
            return *path;
        }

        std::filesystem::path cache()
        {
            return tool_install::root({"dxvk", "", ""});
        }

        bool wanted(const game_config::game_config_t& config)
        {
            const auto value = config.get("dxvk");
            return value && *value == "true";
        }

        void set_result(rapidjson::Document& response, const bool success, const std::string& error = {})
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", success, allocator);
            if (!error.empty()) response.AddMember("error", make_string(error, allocator), allocator);
        }

        // The game can't have DXVK changed right now: why, or "".
        std::string blocked(const game_config::game_config_t& config)
        {
            if (game_config::is_game_process_running(config.id)) return "Close the game first: its files are in use.";
            return {};
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { game } -> { supported, installed, wine, offline, version, url, size, files: none|ours|partial|foreign,
        //   wanted, cached, running, busy, phase, done, total, error }
        cef_ui.add_command("get-dxvk-state", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            const auto config = ctx.get_game_config_from_request(value);
            const auto& release = dxvk::pinned();
            const auto dir = game_dir(config);

            response.AddMember("supported", supported(config), allocator);
            response.AddMember("installed", dir.has_value(), allocator);
            response.AddMember("wine", muac::platform::is_wine(), allocator);
            response.AddMember("offline", utils::flags::has_flag("offline"), allocator);
            response.AddMember("version", make_string(release.version, allocator), allocator);
            response.AddMember("url", make_string(release.url, allocator), allocator);
            response.AddMember("size", rapidjson::Value(static_cast<std::uint64_t>(release.size)), allocator);
            response.AddMember("files", make_string(dir ? dxvk::to_string(dxvk::inspect(*dir, release)) : "none", allocator), allocator);
            response.AddMember("wanted", supported(config) && wanted(*config), allocator);
            response.AddMember("cached", dxvk::archive_valid(cache() / release.archive, release), allocator);
            response.AddMember("running", supported(config) && game_config::is_game_process_running(config->id), allocator);

            const auto work = supported(config) ? job_of(config->get_game_key()) : nullptr;
            std::lock_guard lock(work ? work->mutex : jobs_mutex);
            response.AddMember("busy", work && work->busy, allocator);
            response.AddMember("phase", make_string(work ? work->phase : "", allocator), allocator);
            response.AddMember("done", rapidjson::Value(work ? work->done : 0), allocator);
            response.AddMember("total", rapidjson::Value(work ? work->total : 0), allocator);
            response.AddMember("error", make_string(work ? work->error : "", allocator), allocator);
        });

        // { game, enabled: true | false } -> { success, error }. On: starts the background job (download
        // when not cached, verify, install); its progress is in get-dxvk-state. Off: removes the files now.
        cef_ui.add_command("set-dxvk", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!supported(config))
            {
                set_result(response, false, "This game has no DXVK option.");
                return;
            }
            if (!value.HasMember("enabled") || !value["enabled"].IsBool())
            {
                set_result(response, false, "Say whether DXVK should be on or off.");
                return;
            }
            const auto dir = game_dir(config);
            if (!dir)
            {
                set_result(response, false, "Set up the game first.");
                return;
            }
            const bool enable = value["enabled"].GetBool();
            if (enable && muac::platform::is_wine())
            {
                set_result(response, false, "Proton already runs the game through its own DXVK.");
                return;
            }
            if (const auto why = blocked(*config); !why.empty())
            {
                set_result(response, false, why);
                return;
            }
            const auto work = job_of(config->get_game_key());
            {
                std::lock_guard lock(work->mutex);
                if (work->busy)
                {
                    set_result(response, false, "DXVK is already being changed for this game.");
                    return;
                }
            }
            // The folder for as long as the job writes it: never alongside a build (the builder's merge).
            auto hold = updater::reserve(*dir, updater::folder_use::patch);
            if (!hold)
            {
                set_result(response, false, "The game is being built in this folder. Change DXVK when the build has finished.");
                return;
            }

            const auto& release = dxvk::pinned();
            if (!enable)
            {
                const auto error = dxvk::remove(*dir, release);
                config->set("dxvk", "false");
                {
                    std::lock_guard lock(work->mutex);
                    work->error = error;
                }
                utils::logger::write("DXVK {} removed from {}: {}", release.version, utils::string::path_to_utf8(*dir), error.empty() ? "ok" : error);
                set_result(response, error.empty(), error);
                return;
            }

            {
                std::lock_guard lock(work->mutex);
                work->busy = true;
                work->phase = "verify";
                work->done = 0;
                work->total = release.size;
                work->error.clear();
                work->cancel = false;
            }
            config->set("dxvk", "true");
            const auto folder = *dir;
            const auto game = *config;
            std::thread([work, folder, game, hold = std::move(hold)]() mutable
            {
                const auto& release = dxvk::pinned();
                dxvk::enable_steps steps;
                steps.offline = utils::flags::has_flag("offline");
                steps.cancelled = [work] { return work->cancel.load(); };
                steps.phase = [work](const std::string& phase)
                {
                    std::lock_guard lock(work->mutex);
                    work->phase = phase;
                };
                steps.download = [work](const std::string& url, const std::filesystem::path& file, const std::uint64_t size, std::string& sha256)
                {
                    return tool_install::download_file(url, file, size, [work](const std::uint64_t done, const std::uint64_t total)
                    {
                        std::lock_guard lock(work->mutex);
                        work->done = done;
                        work->total = total;
                    }, [work] { return work->cancel.load(); }, sha256);
                };
                std::string error;
                try
                {
                    error = dxvk::enable(folder, cache(), release, steps);
                }
                catch (const std::exception& e)
                {
                    error = std::string("DXVK could not be installed: ") + e.what();
                }
                if (!error.empty())
                {
                    // Nothing half-done stays behind; the player's choice goes back to off.
                    dxvk::remove(folder, release);
                    game.set("dxvk", "false");
                }
                utils::logger::write("DXVK {} for {}: {}", release.version, utils::string::path_to_utf8(folder), error.empty() ? "installed" : error);
                {
                    std::lock_guard lock(work->mutex);
                    work->busy = false;
                    work->phase.clear();
                    work->error = error == "cancelled" ? std::string{} : error;
                }
                hold.reset();
            }).detach();
            set_result(response, true);
        });

        // { game } -> { success }: stops a download that is under way (the job removes what it wrote).
        cef_ui.add_command("cancel-dxvk", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!supported(config))
            {
                set_result(response, false, "This game has no DXVK option.");
                return;
            }
            job_of(config->get_game_key())->cancel = true;
            set_result(response, true);
        });
    }
}
