#include "std_include.hpp"
#include "game_commands.hpp"
#include <utils/property_keys.hpp>
#include "cef/cef_ui.hpp"

#include <utils/concurrency.hpp>
#include <utils/flags.hpp>
#include <utils/io.hpp>
#include <utils/nt.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>
#include <game_config.hpp>

#include "updater/updater.hpp"
#include "updater/folder_work.hpp"
#include "mods/game_mods.hpp"
#include "updater/client_updater.hpp"
#include "updater/patch_channel.hpp"
#include "updater/patch_policy.hpp"
#include "updater/patch_status.hpp"
#include "updater/game_updater.hpp"
#include "updater/ui_progress_listener.hpp"
#include "xml1/xml1_port.hpp"
#include "fix/fix_ini.hpp"
#include "fix/online_launch.hpp"
#include "fix/online_settings.hpp"
#include "fix/online_status.hpp"

#include <map>

namespace commands::game_commands
{
    namespace
    {
        std::atomic_bool* get_launch_barrier()
        {
            static std::atomic_bool barrier{ false };
            return &barrier;
        }

        bool try_lock_launch_barrier()
        {
            auto* barrier = get_launch_barrier();
            auto expected = false;
            return barrier->compare_exchange_strong(expected, true);
        }

        void unlock_launch_barrier()
        {
            auto* barrier = get_launch_barrier();
            barrier->store(false);
        }

        // Switch back to Stable's patch updates (verify-game { downgrade }): what each one really did, for
        // get-patch-attempt. A started update is not an installed release.
        struct patch_attempt
        {
            std::string state = "running"; // running, done (the approved release is in the folder), kept, cancelled, failed
            std::string installed;          // the fix's version in the folder afterwards
            std::string error;
        };

        std::mutex attempts_mutex_;
        std::map<int, patch_attempt> attempts_;
        int next_attempt_ = 1;

        int begin_attempt()
        {
            std::lock_guard lock(attempts_mutex_);
            const auto id = next_attempt_++;
            attempts_[id] = {};
            while (attempts_.size() > 32)
            {
                attempts_.erase(attempts_.begin());
            }
            return id;
        }

        void end_attempt(const int id, const std::string& state, const std::string& installed, const std::string& error)
        {
            std::lock_guard lock(attempts_mutex_);
            attempts_[id] = {state, installed, error};
        }

        // { downgrade: { from, to } }: an older release approved for this one attempt (patch_policy::consent).
        std::optional<patch_policy::consent> downgrade_consent(const rapidjson::Value& value)
        {
            if (!value.IsObject() || !value.HasMember("downgrade") || !value["downgrade"].IsObject())
            {
                return std::nullopt;
            }
            const auto& downgrade = value["downgrade"];
            if (!downgrade.HasMember("from") || !downgrade["from"].IsString() || !downgrade.HasMember("to") || !downgrade["to"].IsString())
            {
                return std::nullopt;
            }
            return patch_policy::consent{downgrade["from"].GetString(), downgrade["to"].GetString()};
        }

        // Monotonic launch id; each launch reserves a fresh one so an older launch's exit watchdog can't release a newer launch's barrier.
        std::atomic<uint64_t>& launch_generation()
        {
            static std::atomic<uint64_t> gen{0};
            return gen;
        }

        uint64_t reserve_launch_generation()
        {
            return ++launch_generation();
        }

        bool is_current_generation(const uint64_t generation)
        {
            return launch_generation().load() == generation;
        }

        // The single launched game's PID + id (one game at a time via the launch barrier).
        struct tracked_launch
        {
            unsigned long pid{0};
            std::string game_id{};
            bool active{false};
            uint64_t generation{0};
            bool elevated{false};
        };

        utils::concurrency::container<tracked_launch>& get_tracked_launch()
        {
            static utils::concurrency::container<tracked_launch> tracked{};
            return tracked;
        }

        void set_tracked_launch(unsigned long pid, const std::string& game_id, const uint64_t generation, const bool elevated)
        {
            get_tracked_launch().access([&](tracked_launch& t)
            {
                t.pid = pid;
                t.game_id = game_id;
                t.active = true;
                t.generation = generation;
                t.elevated = elevated;
            });
        }

        void clear_tracked_launch()
        {
            get_tracked_launch().access([](tracked_launch& t)
            {
                t = {};
            });
        }

        // Stops only the processes running this game's exes from its own folder (never another
        // game's exe of the same name). TerminateProcess can't reach an elevated game from a
        // non-elevated launcher, so those are stopped by process id through an elevated taskkill.
        bool stop_game_processes(const game_config::game_config_t& config)
        {
            const auto images = config.running_images();

            // Covers configured elevation and the runtime 740 fallback (exe manifest demanded elevation).
            const auto launched_elevated = get_tracked_launch().access<bool>([&](const tracked_launch& t)
            {
                return t.active && t.game_id == config.id && t.elevated;
            });

            if ((config.launch_elevated() || launched_elevated) && !utils::nt::is_elevated())
            {
                const auto pids = utils::nt::find_processes_by_image(images, 0);
                if (pids.empty())
                {
                    return false;
                }

                std::string args = "/F";
                for (const auto pid : pids)
                {
                    args += " /PID " + std::to_string(pid);
                }

                wchar_t system32[MAX_PATH];
                GetSystemDirectoryW(system32, MAX_PATH);
                const auto taskkill = std::filesystem::path(system32) / "taskkill.exe";
                return utils::nt::launch_process_elevated(taskkill, args, {}) != 0;
            }

            return utils::nt::stop_processes_by_image(images);
        }

        std::string tracked_game_id()
        {
            return get_tracked_launch().access<std::string>([](const tracked_launch& t)
            {
                return t.active ? t.game_id : std::string{};
            });
        }

        // Some games exit the launched PID and continue under a child with a different PID, so poll
        // the full exe list (by path, in the game's folder).
        void spawn_exit_watchdog(unsigned long pid, const game_config::game_config_t& config, const uint64_t generation)
        {
            std::thread([pid, generation, tracked_images = config.running_images()]()
            {
                utils::nt::wait_for_process(pid);

                // Grace period for updater→child handoff before polling.
                std::this_thread::sleep_for(std::chrono::seconds(1));

                int empty_ticks = 0;
                while (empty_ticks < 2)
                {
                    std::this_thread::sleep_for(std::chrono::seconds(1));

                    const bool any_running = utils::nt::is_any_image_running(tracked_images, 0);
                    empty_ticks = any_running ? 0 : empty_ticks + 1;
                }

                // A newer launch (e.g. after stop-game) superseded us; it owns the barrier now.
                if (!is_current_generation(generation))
                {
                    return;
                }

                clear_tracked_launch();
                unlock_launch_barrier();
            }).detach();
        }

        std::string trim_ws(std::string s)
        {
            const auto first = s.find_first_not_of(" \t\r\n");
            if (first == std::string::npos) return "";
            const auto last = s.find_last_not_of(" \t\r\n");
            return s.substr(first, last - first + 1);
        }

        // Starts the game's exe; assumes the caller holds the launch barrier and reserved `generation`. Says
        // nothing itself: the caller tells the player (a message box for Play, the Online section's own
        // words for Host / Join). Close on launch closes the launcher after a normal start only
        // (online_launch::close_after_start): an online one needs it to show the room's code.
        online_launch::process_result start_game_process(const game_config::game_config_t& config, cef::cef_ui& cef_ui, const uint64_t generation,
                                                         const online_rules::mode mode)
        {
            // Get game installation path
            const auto game_install = config.get_install_path();
            if (!game_install)
            {
                return {false, false, "Failed to get game install path."};
            }

            const auto game_directory = *game_install;

            const auto& exe_name = config.exe_name;
            const auto game_exe = game_directory / exe_name;
            if (!utils::io::file_exists(game_exe))
            {
                return {false, false, "Could not find: " + exe_name};
            }

            // Record mods copied into <game>\mods by hand in its load order (enabled), so the
            // game's mod loader and the Mods section agree.
            if (utils::io::directory_exists(game_mods::mods_folder(game_directory)))
            {
                game_mods::list(game_directory);
            }

            const auto launch_args = trim_ws(config.get_launch_options().value_or(""));

            printf("Launching %s with args: %s\n", exe_name.data(), launch_args.data());

            // The non-elevated path still ends up at a UAC prompt when the exe itself demands elevation (740).
            auto elevate = config.launch_elevated() && !utils::nt::is_elevated();
            const auto pid = elevate
                ? utils::nt::launch_process_elevated(game_exe, launch_args, game_directory)
                : utils::nt::launch_process_maybe_elevated(game_exe, launch_args, game_directory, &elevate);

            if (pid == 0)
            {
                const auto error = GetLastError();
                if (elevate && error == ERROR_CANCELLED)
                {
                    return {false, true, config.display_name + " requires administrator permission to launch."};
                }

                auto error_msg = std::format("Failed to launch {}. Error code: {}", exe_name, error);
                if (error == ERROR_ACCESS_DENIED)
                {
                    error_msg += "\n\nIf this keeps happening, try running the launcher as administrator or check that your antivirus isn't blocking the game.";
                }
                printf("Launch failed: %s\n", error_msg.data());
                return {false, false, error_msg};
            }

            set_tracked_launch(pid, config.id, generation, elevate);

            // Check if launcher should close after game starts
            const auto close_on_launch = utils::properties::load(property_keys::CLOSE_ON_LAUNCH);
            if (online_launch::close_after_start(close_on_launch && *close_on_launch == "true", mode))
            {
                printf("Close on launch enabled - closing launcher\n");
                // Close the launcher browser window
                cef_ui.close_browser();
                return {true, false, {}};
            }

            spawn_exit_watchdog(pid, config, generation);
            return {true, false, {}};
        }

        // Takes the game's folder for the patch work a command is about to start there
        // (updater/folder_work.hpp); its worker holds `work` to its last line. By folder, whatever the
        // entry: false while the X-Men Legends builder holds that folder (a build or a clean of it),
        // also for an X-Men Legends II entry pointed at the port's folder. Separate installs are never
        // held by it, so for them nothing changes.
        bool begin_patch_work(const game_config::game_config_t& config, std::shared_ptr<updater::folder_work>& work)
        {
            const auto folder = config.get_install_path();
            if (!folder || folder->empty())
            {
                return true;
            }
            work = updater::reserve(*folder, updater::folder_use::patch);
            return work != nullptr;
        }

        // Why patch work can't start in the game's folder now.
        std::string folder_held(const game_config::game_config_t& config, const std::string& then)
        {
            return config.built ? config.display_name + " is being built. " + then
                                : "X-Men Legends is being built in the folder of " + config.display_name + ". " + then;
        }

        // The last start's outcome, for the Online section (get-launch-outcome): pending until the worker has
        // started the game or given up. One at a time, like the barrier.
        struct launch_outcome
        {
            uint64_t id{0};
            bool pending{false};
            online_launch::result result{};
        };

        utils::concurrency::container<launch_outcome>& get_launch_outcome()
        {
            static utils::concurrency::container<launch_outcome> outcome{};
            return outcome;
        }

        void record_outcome(const uint64_t id, const bool pending, const online_launch::result& result)
        {
            get_launch_outcome().access([&](launch_outcome& o)
            {
                o.id = id;
                o.pending = pending;
                o.result = result;
            });
        }

        // What a start of `config` does, for online_launch (fix/online_launch.hpp): the barrier, the game's
        // [Online] keys and online-status.json - for the game with launcher-led online play (the X-Men Legends
        // port, fix_ini's table); every other game has neither, so those steps do nothing. The worker adds
        // the update and the process.
        online_launch::steps launch_steps(const game_config::game_config_t& config)
        {
            online_launch::steps steps{};
            steps.offline = []
            {
                return utils::flags::has_flag("offline");
            };
            // (The worker asks the progress tracker; accept() runs before the update and never asks.)
            steps.cancelled = []
            {
                return false;
            };
            steps.take_barrier = []
            {
                return try_lock_launch_barrier();
            };
            steps.release_barrier = []
            {
                unlock_launch_barrier();
            };
            steps.game_running = [id = config.id]
            {
                return game_config::is_game_process_running(id);
            };

            const auto where = fix_ini::locate(config);
            if (!where.info || !where.info->online || !where.game_dir)
            {
                steps.test_mode_on = []
                {
                    return false;
                };
                steps.fix_version = []
                {
                    return std::optional<std::string>{};
                };
                steps.clear_status = [](std::string&)
                {
                    return true;
                };
                steps.present = []
                {
                    return std::vector<std::string>{};
                };
                steps.write = [](const std::vector<online_rules::change>&, std::string&)
                {
                    return true;
                };
                return steps;
            }

            const auto* fix = where.info;
            const auto folder = *where.game_dir;
            const auto ini = *where.ini();
            steps.test_mode_on = [ini, fix]
            {
                return online_settings::test_mode_on(ini, *fix);
            };
            // The release the launcher installed when the DLL is still that one (a beta's resource is numeric).
            steps.fix_version = [config, folder]
            {
                return patch_channel::installed_version(config, folder);
            };
            steps.clear_status = [folder](std::string& error)
            {
                return online_status::clear(folder, error);
            };
            steps.present = [ini]
            {
                return online_settings::present(ini);
            };
            steps.write = [ini, fix](const std::vector<online_rules::change>& changes, std::string& error)
            {
                return online_settings::write(ini, *fix, changes, error);
            };
            return steps;
        }

        // Patch-update-then-launch sequence (online_launch::finish); assumes accept() took the barrier and the
        // caller reserved `generation`. finish() releases the barrier unless the game started (then the exit
        // watchdog or stop-game owns it) and, for Host / Join, removes the [Online] keys again on every way out
        // but a started game.
        void run_launch_worker(game_config::game_config_t config, cef::cef_ui& cef_ui, const uint64_t generation, const online_launch::request request)
        {
            // (The progress tracker was reset for this start by launch-game itself, before it answered: a cancel the
            // player sends from then on is this start's, and the tracker keeps it across the update's phases.)
            updater::ui_progress_listener progress_listener;
            const auto online = request.mode != online_rules::mode::normal;

            auto steps = launch_steps(config);
            steps.update = [&](std::string& error)
            {
                const auto skip_client_update_prop = utils::properties::load(property_keys::SKIP_CLIENT_UPDATE);
                online_launch::update_steps update{};
                update.skip = (skip_client_update_prop && *skip_client_update_prop == "true") || utils::flags::has_flag("offline");
                if (update.skip)
                {
                    printf("Skip client update enabled - skipping client update check\n");
                }
                update.run = [&]
                {
                    return client_updater::run(config, &progress_listener);
                };
                // A cancelled download returns normally: the tracker's flag says it was cancelled.
                update.cancelled = [&]
                {
                    return progress_listener.is_update_cancelled();
                };
                update.finished = [&](const bool cancelled)
                {
                    if (cancelled)
                    {
                        progress_listener.cancel_update();
                    }
                    progress_listener.done_update();
                };

                const auto updated = online_launch::run_update(update, error);
                if (updated == online_launch::update_result::cancelled)
                {
                    printf("Update cancelled by user\n");
                }
                else if (updated == online_launch::update_result::failed)
                {
                    printf("Launch error: %s\n", error.data());
                    // A normal start goes on after telling the player (the game may still run); an online one
                    // stops here (online_launch::finish), and the Online section says why.
                    if (!online)
                    {
                        cef_ui.show_message_box("Game Launch Error", error);
                    }
                }
                return updated;
            };
            steps.cancelled = [&]
            {
                return progress_listener.is_update_cancelled();
            };
            steps.start_process = [&]
            {
                return start_game_process(config, cef_ui, generation, request.mode);
            };

            const auto result = online_launch::finish(request, steps);
            record_outcome(generation, false, result);
            if (!result.cleanup_error.empty())
            {
                printf("Online settings not removed after a failed start: %s\n", result.cleanup_error.data());
            }
            if (!result.ok && !online && (result.reason == "launch_cancelled" || result.reason == "launch_failed"))
            {
                cef_ui.show_message_box(result.reason == "launch_cancelled" ? "Game Launch Cancelled" : "Game Launch Error", result.error);
            }
        }

        // Why the barrier is taken, as Play has always said it.
        std::string already_running_message(const game_config::game_config_t& config)
        {
            const auto running_id = tracked_game_id();
            const auto running_config = running_id.empty()
                ? std::nullopt
                : game_config::get_game_config_by_id(running_id);

            if (running_id == config.id)
            {
                return "This game is already launching or running. Please wait for it to finish, or close it before launching again.";
            }
            if (running_config)
            {
                return running_config->display_name + " is already launching or running. Only one game can run at a time, close it before launching another.";
            }
            return "Another game is already launching or running. Only one game can run at a time, please wait for it to finish or close it before launching another.";
        }

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        // launch-game's answer: { accepted, launch } or { accepted: false, reason, error, cleanupError }.
        void answer(rapidjson::Document& response, const online_launch::result& result, const uint64_t launch = 0)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("accepted", result.ok, allocator);
            if (result.ok)
            {
                response.AddMember("launch", launch, allocator);
                return;
            }
            response.AddMember("reason", make_string(result.reason, allocator), allocator);
            response.AddMember("error", make_string(result.error, allocator), allocator);
            response.AddMember("cleanupError", make_string(result.cleanup_error, allocator), allocator);
        }

        online_launch::result refusal(const std::string& reason, const std::string& error)
        {
            return {false, reason, error, {}};
        }

        // launch-game's { online: { mode, code, public, roomName } }: Host or Join from the Online section.
        // Without it (Play, the library, -launch, ultimatelegends://play), a normal start.
        std::optional<online_launch::result> read_request(const rapidjson::Value& value, online_launch::request& request)
        {
            if (!value.IsObject() || !value.HasMember("online") || !value["online"].IsObject())
            {
                return std::nullopt;
            }
            const auto& online = value["online"];
            const auto text = [&online](const char* key)
            {
                return online.HasMember(key) && online[key].IsString() ? std::string(online[key].GetString()) : std::string{};
            };
            const auto mode = online_rules::parse_mode(text("mode"));
            if (!mode || *mode == online_rules::mode::normal)
            {
                return refusal("bad_mode", "Unknown online mode: " + text("mode"));
            }
            request.mode = *mode;
            if (*mode == online_rules::mode::join)
            {
                const auto code = online_rules::normalise_code(text("code"));
                if (!code)
                {
                    return refusal("bad_code", "That is not a join code.");
                }
                request.code = *code;
                return std::nullopt;
            }
            request.host.is_public = online.HasMember("public") && online["public"].IsBool() && online["public"].GetBool();
            const auto name = online_rules::normalise_room_name(text("roomName"));
            if (!name)
            {
                return refusal("bad_room_name", "That room name can't be used.");
            }
            request.host.room_name = *name;
            return std::nullopt;
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { game, online?: { mode: "host" | "join", code, public, roomName } } -> { accepted, launch } or
        // { accepted: false, reason, error, cleanupError }. Every start goes through online_launch (fix/online_launch.hpp):
        // accept() here, finish() on the worker. Play's refusals are also shown as before (a message box);
        // the Online section words its own (online-view.js), and follows an accepted start with
        // get-launch-outcome { launch } until the game started or the start gave up.
        cef_ui.add_command("launch-game", [&cef_ui, &ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                answer(response, refusal("not_supported", "Unknown game."));
                return;
            }

            online_launch::request request{};
            if (const auto bad = read_request(value, request))
            {
                answer(response, *bad);
                return;
            }
            const auto online = request.mode != online_rules::mode::normal;
            const auto refuse = [&](const online_launch::result& result, const std::string& message)
            {
                if (!online)
                {
                    cef_ui.show_message_box("Game Launch Error", message);
                }
                answer(response, result);
            };

            if (online)
            {
                const auto where = fix_ini::locate(config);
                if (!where.info || !where.info->online)
                {
                    answer(response, refusal("not_supported", "This game has no online play through the launcher."));
                    return;
                }
                if (!where.game_dir)
                {
                    answer(response, refusal("not_installed", "Set up the game first."));
                    return;
                }
                if (!where.fix_installed)
                {
                    answer(response, refusal("no_fix", "Install the " + where.info->name + " first."));
                    return;
                }
            }

            // A built game starts only from a finished build, and never while its builder writes the
            // folder; the launch's patch update is patch work there, so no build starts during it.
            std::shared_ptr<updater::folder_work> work;
            if (!begin_patch_work(*config, work))
            {
                const auto message = folder_held(*config, "Wait for the build to finish, or cancel it, before playing.");
                refuse(refusal("busy", message), message);
                return;
            }
            if (config->built)
            {
                const auto folder = config->get_install_path();
                if (!folder || !xml1_port::is_playable(*folder))
                {
                    const auto message = config->display_name + " has not finished building. Resume the build on its page first.";
                    refuse(refusal("not_built", message), message);
                    return;
                }
            }

            // The barrier, then (online) the game not running, test mode off; the stale status deleted; for a
            // normal start the [Online] keys removed. Nothing of a room is written here.
            const auto accepted = online_launch::accept(request, launch_steps(*config));
            if (!accepted.ok)
            {
                std::string message = accepted.error;
                if (accepted.reason == "already_running")
                {
                    message = already_running_message(*config);
                }
                else if (accepted.reason == "write_failed")
                {
                    message = "The online settings could not be reset for a normal start: " + accepted.error;
                }
                else if (accepted.reason == "status_locked")
                {
                    message = "A file an earlier online game left (online-status.json) could not be deleted: " + accepted.error +
                              "\n\nClose any program that has it open (or wait a moment), then try again.";
                }
                refuse(accepted, message);
                return;
            }

            // Run update and launch in a separate thread with progress tracking. The tracker starts this
            // operation here, before the answer: the page's Cancel can only come after it, so the worker never
            // clears a cancel it hasn't read (online_launch::run_update reads it after the update returns).
            updater::ui_progress_listener{}.reset(true);
            const auto generation = reserve_launch_generation();
            record_outcome(generation, true, {});
            answer(response, accepted, generation);
            std::thread([config = *config, &cef_ui, generation, request, work = std::move(work)]()
            {
                run_launch_worker(config, cef_ui, generation, request);
            }).detach();
        });

        // { launch } -> { launch, state: pending | launched | failed | unknown, reason, error, cleanupError }:
        // what became of the start launch-game accepted (unknown: not the last one).
        cef_ui.add_command("get-launch-outcome", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto wanted = value.IsObject() && value.HasMember("launch") && value["launch"].IsUint64() ? value["launch"].GetUint64() : 0;
            const auto outcome = get_launch_outcome().access<launch_outcome>([](const launch_outcome& o)
            {
                return o;
            });
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("launch", wanted, allocator);
            const auto known = wanted != 0 && outcome.id == wanted;
            const char* state = !known ? "unknown" : outcome.pending ? "pending" : outcome.result.ok ? "launched" : "failed";
            response.AddMember("state", rapidjson::StringRef(state), allocator);
            response.AddMember("reason", make_string(known ? outcome.result.reason : std::string{}, allocator), allocator);
            response.AddMember("error", make_string(known ? outcome.result.error : std::string{}, allocator), allocator);
            response.AddMember("cleanupError", make_string(known ? outcome.result.cleanup_error : std::string{}, allocator), allocator);
        });

        cef_ui.add_command("is-game-running", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetBool(false); // Default to not running

            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            // Polled constantly by the UI; a snapshot up to a second old is plenty and keeps the
            // process-table walk off the critical path for every game on screen.
            response.SetBool(game_config::is_game_process_running(config->id, 1000));
        });

        cef_ui.add_command("stop-game", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetBool(false); // Default to failure

            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            // Attempt to stop any of the game's executables
            const bool stopped = stop_game_processes(*config);
            response.SetBool(stopped);

            // If we successfully stopped the game, unlock the launch barrier
            if (stopped)
            {
                clear_tracked_launch();
                unlock_launch_barrier();
            }
        });

        // What the install and manage screens show: the stored folder, whether it still holds the
        // game, and whether the game has a patch to install.
        cef_ui.add_command("get-game-install-info", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();

            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            const game_updater::game_updater updater(*config);
            const auto path = utils::string::path_to_utf8(updater.install_path());

            response.SetObject();
            auto& allocator = response.GetAllocator();
            rapidjson::Value path_value{};
            path_value.SetString(path.data(), static_cast<rapidjson::SizeType>(path.size()), allocator);
            response.AddMember("path", path_value, allocator);
            response.AddMember("valid", updater.is_install_valid(), allocator);
            response.AddMember("hasPatch", !config->update_manifest_url.empty(), allocator);
        });

        // The game page's patch line: the release installed in the game folder and the latest one
        // (checked in the background; the page asks again while `checking`). Null without a patch.
        cef_ui.add_command("get-patch-status", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();
            if (const auto config = ctx.get_game_config_from_request(value))
            {
                patch_status::write_status(*config, response, response.GetAllocator());
            }
        });

        // Installs or updates the game's patch files; the game's own files are never touched.
        // { game, downgrade?: { from, to } } -> { accepted, attempt?, reason? }. `downgrade`: Switch back to
        // Stable approved for this one attempt (update-channel.js); get-patch-attempt says what it did.
        cef_ui.add_command("verify-game", [&cef_ui, &ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }
            const auto consent = downgrade_consent(value);
            response.SetObject();
            auto& allocator = response.GetAllocator();

            // Patch work in the game's folder until the worker's last line (never during a built game's build).
            std::shared_ptr<updater::folder_work> work;
            if (!begin_patch_work(*config, work))
            {
                cef_ui.show_toast(folder_held(*config, "Verify its files when the build has finished."), "error");
                response.AddMember("accepted", false, allocator);
                response.AddMember("reason", "busy", allocator);
                return;
            }

            // Shared, not a local: this handler returns while the detached worker still reports progress.
            const auto progress_listener = std::make_shared<updater::ui_progress_listener>();
            progress_listener->reset(true);
            const auto attempt = consent ? begin_attempt() : 0;
            response.AddMember("accepted", true, allocator);
            if (attempt)
            {
                response.AddMember("attempt", attempt, allocator);
            }

            // Run verification in a separate thread with progress tracking
            std::thread([config = *config, progress_listener, &cef_ui, work = std::move(work), consent, attempt]()
            {
                // An attempt's result: the approved release in the folder, read from the disk afterwards.
                const auto finish = [&](const std::string& state, const std::string& error)
                {
                    if (!attempt)
                    {
                        return;
                    }
                    const auto folder = config.get_install_path();
                    const auto installed = folder ? patch_channel::installed_version(config, *folder).value_or("") : std::string{};
                    end_attempt(attempt, state == "done" && installed != consent->to ? "failed" : state, installed,
                                state == "done" && installed != consent->to ? "The folder still has " + installed + "." : error);
                };
                try
                {
                    const auto result = client_updater::run_attempt(config, progress_listener.get(), std::nullopt, consent);
                    const auto patch_fetched = result.fetched;
                    finish(progress_listener->is_update_cancelled() ? "cancelled" : !result.fetched ? "failed" : result.kept ? "kept" : "done",
                           !result.fetched ? "The update could not be reached." : result.note);

                    // Installed means the patch files are in place (and, for a built game, that
                    // the build in its folder finished: Verify Files also runs on an unfinished one,
                    // whose folder may still hold the stamp of the build before).
                    const auto folder = config.get_install_path();
                    const auto complete = !config.built || (folder && xml1_port::is_playable(*folder));
                    if (patch_fetched && complete)
                    {
                        config.set_installed(true);
                    }

                    progress_listener->done_update();

                    if (patch_fetched)
                    {
                        cef_ui.show_toast(config.display_name + " verification/update complete!", "success");
                    }
                    else
                    {
                        cef_ui.show_toast(config.display_name + ": the patch update check could not be reached. Please verify again later.", "error");
                    }
                }
                catch (const updater::update_cancelled&)
                {
                    finish("cancelled", "Cancelled.");
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Update cancelled by user\n");
                    cef_ui.show_toast(config.display_name + " verification/update cancelled", "info");
                }
                catch (const std::exception& e)
                {
                    finish("failed", e.what());
                    // Set error in progress tracker and show error popup in UI
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Update error: %s\n", e.what());
                    cef_ui.show_message_box("Update Error", e.what());
                }
                catch (...)
                {
                    finish("failed", "An unknown error occurred during update");
                    // Set generic error for unknown exceptions
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Unknown update error\n");
                    cef_ui.show_message_box("Update Error", "An unknown error occurred during update");
                }
            }).detach();
        });

        // { attempt } -> { state: running | done | kept | cancelled | failed, installed, error }; null when unknown.
        cef_ui.add_command("get-patch-attempt", [](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetNull();
            if (!value.IsObject() || !value.HasMember("attempt") || !value["attempt"].IsInt())
            {
                return;
            }
            patch_attempt found;
            {
                std::lock_guard lock(attempts_mutex_);
                const auto it = attempts_.find(value["attempt"].GetInt());
                if (it == attempts_.end())
                {
                    return;
                }
                found = it->second;
            }
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("state", make_string(found.state, allocator), allocator);
            response.AddMember("installed", make_string(found.installed, allocator), allocator);
            response.AddMember("error", make_string(found.error, allocator), allocator);
        });

        // Removes the launcher's patch files and forgets the install; the game itself stays put.
        cef_ui.add_command("delete-game", [&cef_ui, &ctx](const rapidjson::Value& value, auto&)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            // Check if the game is running (from its own folder)
            if (game_config::is_game_process_running(config->id))
            {
                cef_ui.show_message_box("Cannot Uninstall", "Please close the game before uninstalling.");
                return;
            }

            // Patch work in the game's folder until the worker's last line (never during a built game's build).
            std::shared_ptr<updater::folder_work> work;
            if (!begin_patch_work(*config, work))
            {
                cef_ui.show_message_box("Cannot Uninstall", folder_held(*config, "Wait for the build to finish, or cancel it, before uninstalling."));
                return;
            }

            // Shared, not a local: this handler returns while the detached worker still reports progress.
            const auto progress_listener = std::make_shared<updater::ui_progress_listener>();
            progress_listener->reset(true);

            std::thread([config = *config, progress_listener, &cef_ui, work = std::move(work)]()
            {
                try
                {
                    const client_updater::client_updater client_updater(config, progress_listener.get());
                    client_updater.delete_client();

                    // A built game's folder is the launcher's to tidy once the builder has deleted
                    // the build (xml1-clean) and the patch is gone: remove it when nothing is left.
                    if (config.built)
                    {
                        std::error_code error;
                        if (const auto folder = config.get_install_path(); folder && std::filesystem::is_empty(*folder, error) && !error)
                        {
                            std::filesystem::remove(*folder, error);
                        }
                    }

                    // Clear installation status
                    config.reset();

                    progress_listener->done_update();
                    cef_ui.show_toast(config.display_name + " uninstalled successfully.", "success");
                }
                catch (const updater::update_cancelled&)
                {
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Uninstall cancelled by user\n");
                    cef_ui.show_toast(config.display_name + " uninstall cancelled", "info");
                }
                catch (const std::exception& e)
                {
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Uninstall error: %s\n", e.what());
                    cef_ui.show_message_box("Uninstall Error", e.what());
                }
                catch (...)
                {
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Unknown uninstall error\n");
                    cef_ui.show_message_box("Uninstall Error", "An unknown error occurred during uninstall");
                }
            }).detach();
        });
    }
}
