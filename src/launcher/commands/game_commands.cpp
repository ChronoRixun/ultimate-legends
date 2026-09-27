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
#include "updater/client_updater.hpp"
#include "updater/game_updater.hpp"
#include "updater/ui_progress_listener.hpp"

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

        // TerminateProcess can't reach an elevated game from a non-elevated launcher, so stop those via elevated taskkill.
        bool stop_game_processes(const game_config::game_config_t& config)
        {
            std::vector<std::string> exes{ config.exe_name };
            for (const auto& exe : config.check_running_exes)
            {
                exes.push_back(exe);
            }

            // Covers configured elevation and the runtime 740 fallback (exe manifest demanded elevation).
            const auto launched_elevated = get_tracked_launch().access<bool>([&](const tracked_launch& t)
            {
                return t.active && t.game_id == config.id && t.elevated;
            });

            if ((config.launch_elevated() || launched_elevated) && !utils::nt::is_elevated())
            {
                std::string args = "/F";
                for (const auto& exe : exes)
                {
                    if (!exe.empty()) args += " /IM \"" + exe + "\"";
                }

                wchar_t system32[MAX_PATH];
                GetSystemDirectoryW(system32, MAX_PATH);
                const auto taskkill = std::filesystem::path(system32) / "taskkill.exe";
                return utils::nt::launch_process_elevated(taskkill, args, {}) != 0;
            }

            bool stopped = false;
            for (const auto& exe : exes)
            {
                if (!exe.empty() && utils::nt::stop_process(exe))
                {
                    stopped = true;
                }
            }
            return stopped;
        }

        std::string tracked_game_id()
        {
            return get_tracked_launch().access<std::string>([](const tracked_launch& t)
            {
                return t.active ? t.game_id : std::string{};
            });
        }

        // Some games exit the launched PID and continue under a child with a different PID, so poll the full exe list.
        void spawn_exit_watchdog(unsigned long pid, const game_config::game_config_t& config, const uint64_t generation)
        {
            std::vector<std::string> tracked_exes{ config.exe_name };
            for (const auto& exe : config.check_running_exes)
            {
                tracked_exes.push_back(exe);
            }

            std::thread([pid, generation, tracked_exes = std::move(tracked_exes)]()
            {
                utils::nt::wait_for_process(pid);

                // Grace period for updater→child handoff before polling.
                std::this_thread::sleep_for(std::chrono::seconds(1));

                int empty_ticks = 0;
                while (empty_ticks < 2)
                {
                    std::this_thread::sleep_for(std::chrono::seconds(1));

                    bool any_running = false;
                    for (const auto& exe : tracked_exes)
                    {
                        if (!exe.empty() && utils::nt::is_process_running(exe))
                        {
                            any_running = true;
                            break;
                        }
                    }

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

        // Assumes the caller already holds the launch barrier and reserved `generation`.
        bool launch_game(const game_config::game_config_t& config, cef::cef_ui& cef_ui, const uint64_t generation)
        {
            // Get game installation path
            const auto game_install = config.get_install_path();
            if (!game_install)
            {
                cef_ui.show_message_box("Game Launch Error", "Failed to get game install path.");
                return false;
            }

            const auto game_directory = *game_install;

            const auto& exe_name = config.exe_name;
            const auto game_exe = game_directory / exe_name;
            if (utils::io::file_exists(game_exe))
            {
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
                        cef_ui.show_message_box("Game Launch Cancelled", config.display_name + " requires administrator permission to launch.");
                        return false;
                    }

                    auto error_msg = std::format("Failed to launch {}. Error code: {}", exe_name, error);
                    if (error == ERROR_ACCESS_DENIED)
                    {
                        error_msg += "\n\nIf this keeps happening, try running the launcher as administrator or check that your antivirus isn't blocking the game.";
                    }
                    printf("Launch failed: %s\n", error_msg.data());
                    cef_ui.show_message_box("Game Launch Error", error_msg);
                    return false;
                }

                set_tracked_launch(pid, config.id, generation, elevate);

                // Check if launcher should close after game starts
                const auto close_on_launch = utils::properties::load(property_keys::CLOSE_ON_LAUNCH);
                if (close_on_launch && *close_on_launch == "true")
                {
                    printf("Close on launch enabled - closing launcher\n");
                    // Close the launcher browser window
                    cef_ui.close_browser();
                    return true;
                }

                spawn_exit_watchdog(pid, config, generation);
                return true;
            }

            cef_ui.show_message_box("Game Launch Error", "Could not find: " + exe_name);
            return false;
        }

        // Patch-update-then-launch sequence; assumes the caller holds the barrier and reserved `generation`.
        void run_launch_worker(game_config::game_config_t config, cef::cef_ui& cef_ui, const uint64_t generation)
        {
            updater::ui_progress_listener progress_listener;
            progress_listener.reset(true);

            bool launched = false;
            try
            {
                const auto skip_client_update_prop = utils::properties::load(property_keys::SKIP_CLIENT_UPDATE);
                const bool skip_client_update = (skip_client_update_prop && *skip_client_update_prop == "true")
                    || utils::flags::has_flag("offline");

                if (skip_client_update)
                {
                    printf("Skip client update enabled - skipping client update check\n");
                }
                else
                {
                    client_updater::run(config, &progress_listener);
                }
                progress_listener.done_update();

                launched = launch_game(config, cef_ui, generation);
            }
            catch (const updater::update_cancelled&)
            {
                progress_listener.cancel_update();
                progress_listener.done_update();
                printf("Update cancelled by user\n");
            }
            catch (const std::exception& e)
            {
                progress_listener.cancel_update();
                progress_listener.done_update();
                printf("Launch error: %s\n", e.what());
                cef_ui.show_message_box("Game Launch Error", e.what());

                launched = launch_game(config, cef_ui, generation); //Attempt to launch game even if error in update
            }
            catch (...)
            {
                progress_listener.cancel_update();
                progress_listener.done_update();
                printf("Unknown launch error\n");
                cef_ui.show_message_box("Game Launch Error", "An unknown error occurred during game launch");

                launched = launch_game(config, cef_ui, generation); //Attempt to launch game even if error in update
            }

            // Release the barrier unless a game process is now running (the exit watchdog or stop-game owns it).
            if (!launched)
            {
                unlock_launch_barrier();
            }
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        cef_ui.add_command("launch-game", [&cef_ui, &ctx](const rapidjson::Value& value, auto&)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            if (!try_lock_launch_barrier())
            {
                const auto running_id = tracked_game_id();
                const auto running_config = running_id.empty()
                    ? std::nullopt
                    : game_config::get_game_config_by_id(running_id);

                std::string message;
                if (running_id == config->id)
                {
                    message = "This game is already launching or running. Please wait for it to finish, or close it before launching again.";
                }
                else if (running_config)
                {
                    message = running_config->display_name + " is already launching or running. Only one game can run at a time, close it before launching another.";
                }
                else
                {
                    message = "Another game is already launching or running. Only one game can run at a time, please wait for it to finish or close it before launching another.";
                }

                cef_ui.show_message_box("Game Launch Error", message);
                return;
            }

            // Run update and launch in a separate thread with progress tracking
            const auto generation = reserve_launch_generation();
            std::thread([config = *config, &cef_ui, generation]()
            {
                run_launch_worker(config, cef_ui, generation);
            }).detach();
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

        // Installs or updates the game's patch files; the game's own files are never touched.
        cef_ui.add_command("verify-game", [&cef_ui, &ctx](const rapidjson::Value& value, auto&)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            // Shared, not a local: this handler returns while the detached worker still reports progress.
            const auto progress_listener = std::make_shared<updater::ui_progress_listener>();
            progress_listener->reset(true);

            // Run verification in a separate thread with progress tracking
            std::thread([config = *config, progress_listener, &cef_ui]()
            {
                try
                {
                    const auto patch_fetched = client_updater::run(config, progress_listener.get());

                    // Installed means the patch files are in place.
                    if (patch_fetched)
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
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Update cancelled by user\n");
                    cef_ui.show_toast(config.display_name + " verification/update cancelled", "info");
                }
                catch (const std::exception& e)
                {
                    // Set error in progress tracker and show error popup in UI
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Update error: %s\n", e.what());
                    cef_ui.show_message_box("Update Error", e.what());
                }
                catch (...)
                {
                    // Set generic error for unknown exceptions
                    progress_listener->cancel_update();
                    progress_listener->done_update();
                    printf("Unknown update error\n");
                    cef_ui.show_message_box("Update Error", "An unknown error occurred during update");
                }
            }).detach();
        });

        // Removes the launcher's patch files and forgets the install; the game itself stays put.
        cef_ui.add_command("delete-game", [&cef_ui, &ctx](const rapidjson::Value& value, auto&)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config)
            {
                return;
            }

            // Check if game is running
            bool is_running = utils::nt::is_process_running(config->exe_name);
            if (!config->check_running_exes.empty())
            {
                for (const auto& exe : config->check_running_exes)
                {
                    if (utils::nt::is_process_running(exe))
                    {
                        is_running = true;
                        break;
                    }
                }
            }

            if (is_running)
            {
                cef_ui.show_message_box("Cannot Uninstall", "Please close the game before uninstalling.");
                return;
            }

            // Shared, not a local: this handler returns while the detached worker still reports progress.
            const auto progress_listener = std::make_shared<updater::ui_progress_listener>();
            progress_listener->reset(true);

            std::thread([config = *config, progress_listener, &cef_ui]()
            {
                try
                {
                    const client_updater::client_updater client_updater(config, progress_listener.get());
                    client_updater.delete_client();

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
