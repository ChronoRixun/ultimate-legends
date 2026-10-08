#include "std_include.hpp"
#include "cef/cef_ui.hpp"
#include "commands/commands.hpp"
#include "deep_link.hpp"
#include "redist/redist_worker.hpp"
#include "updater/launcher_update.hpp"
#include "uri_scheme.hpp"

#include <utils/flags.hpp>
#include <utils/named_mutex.hpp>
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>
#include <utils/io.hpp>
#include <utils/nt.hpp>
#include <utils/com.hpp>

#include <crtdbg.h>

namespace
{
    void set_working_directory()
    {
        const auto appdata = utils::properties::get_appdata_path();

        if (!utils::io::directory_exists(appdata / "data"))
        {
            utils::io::create_directory(appdata / "data");
        }

        std::filesystem::current_path(appdata);
    }

    void enable_dpi_awareness()
    {
        const utils::nt::library user32{"user32.dll"};

        const auto set_dpi_awareness_context = user32
            ? user32.get_proc<BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT)>("SetProcessDpiAwarenessContext")
            : nullptr;

        // Minimum: Windows 10, version 1703
        if (set_dpi_awareness_context)
        {
            set_dpi_awareness_context(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            return;
        }

        const utils::nt::library shcore{"shcore.dll"};

        const auto set_dpi_awareness = shcore
            ? shcore.get_proc<HRESULT(WINAPI*)(PROCESS_DPI_AWARENESS)>("SetProcessDpiAwareness")
            : nullptr;

        // Minimum: Windows 8.1
        if (set_dpi_awareness)
        {
            set_dpi_awareness(PROCESS_PER_MONITOR_DPI_AWARE);
            return;
        }

        // Call vista function if nothing else was not resolved
        SetProcessDPIAware();
    }

    bool remove_data_root(const std::filesystem::path& root)
    {
        std::error_code ec;
        std::filesystem::remove_all(root, ec);
        return !std::filesystem::exists(root, ec);
    }

    // Finishes a Settings data move: the new root carries the move marker, the old root gets deleted.
    void remove_previous_data_root()
    {
        const auto current = utils::properties::get_appdata_path();
        const auto move_marker = utils::properties::get_move_marker(current);

        std::error_code ec;
        if (!std::filesystem::exists(move_marker, ec)) return;

        const auto previous = utils::properties::is_portable() ? utils::properties::get_local_root() : utils::properties::get_portable_root();
        const bool can_delete = !utils::io::is_inside_folder(previous, current) &&
                                !utils::io::is_inside_folder(current, previous);

        std::thread([previous, move_marker, can_delete]
        {
            // The old instance's CEF subprocesses hold files open for a few seconds after it exits.
            auto done = !can_delete;
            for (auto attempt = 0; !done && attempt < 15; ++attempt)
            {
                done = remove_data_root(previous);
                if (!done) std::this_thread::sleep_for(1s);
            }

            if (done)
            {
                utils::io::remove_file(move_marker);
            }
        }).detach();
    }

    utils::named_mutex& singleton_mutex()
    {
        static utils::named_mutex mutex{"ultimate-legends"};
        return mutex;
    }

    bool try_become_singleton()
    {
        // Started by the self-update's restart: the previous process lets go of the lock only as it
        // exits, which can take longer than a few seconds on a busy PC.
        return singleton_mutex().try_lock(launcher_update::is_restart() ? 30s : 3s);
    }

    bool is_subprocess()
    {
        return strstr(GetCommandLineA(), "--ul-subprocess");
    }

    void run_watchdog()
    {
        std::thread([]()
        {
            const auto parent = utils::nt::get_parent_pid();
            if (utils::nt::wait_for_process(parent))
            {
                std::this_thread::sleep_for(3s);
                utils::nt::terminate();
            }
        }).detach();
    }

    int run_subprocess(const utils::nt::library& process, const std::filesystem::path& path)
    {
        const cef::cef_ui cef_ui{process, path};
        return cef_ui.run_process();
    }

    // Deep links can arrive before the UI exists (the listener starts before the window); buffer until it does.
    std::mutex deep_link_sink_mutex;
    std::vector<std::string> pending_deep_links;
    std::function<void(const std::string&)> deep_link_sink;

    void on_deep_link(const std::string& url)
    {
        std::lock_guard lock(deep_link_sink_mutex);
        if (deep_link_sink)
        {
            deep_link_sink(url);
        }
        else
        {
            pending_deep_links.push_back(url);
        }
    }

    void show_window(const utils::nt::library& process, const std::filesystem::path& path)
    {
        cef::cef_ui cef_ui{process, path};
        commands::register_all_commands(cef_ui);
        cef_ui.create(path / "data" / "launcher-ui", "main.html");

        // Route forwarded deep links to the UI, delivering anything buffered pre-create.
        {
            std::lock_guard lock(deep_link_sink_mutex);
            deep_link_sink = [&cef_ui](const std::string& url) { cef_ui.dispatch_deep_link(url); };
            for (const auto& url : pending_deep_links) cef_ui.dispatch_deep_link(url);
            pending_deep_links.clear();
        }

        cef::cef_ui::work();

        {
            std::lock_guard lock(deep_link_sink_mutex);
            deep_link_sink = nullptr;
        }
    }

    bool same_path(const std::filesystem::path& a, const std::filesystem::path& b)
    {
        return _wcsicmp(a.lexically_normal().c_str(), b.lexically_normal().c_str()) == 0;
    }

    void create_launcher_shortcut(const std::filesystem::path& launcher_path,
                                  const std::filesystem::path& shortcut_path, const char* created_key)
    {
        if (utils::properties::load(created_key) == "true")
        {
            // User deleted it on purpose — respect that, don't resurrect it.
            if (!std::filesystem::exists(shortcut_path))
            {
                return;
            }

            // Still points at the current exe? Nothing to do.
            const auto current_target = utils::com::read_shortcut_target(shortcut_path);
            if (!current_target.empty() && same_path(current_target, launcher_path))
            {
                return;
            }
        }

        // First run, or exe moved/renamed — (re)write the same .lnk in place.
        if (utils::com::create_shortcut(launcher_path, shortcut_path, "Launch Ultimate Legends"))
        {
            utils::properties::store(created_key, "true");
        }
    }

    void create_shortcuts()
    {
        // Opt-out also skips the Start Menu link.
        if (utils::properties::load(property_keys::AUTO_SHORTCUTS) == "false") return;

        try
        {
            const auto launcher_path = utils::nt::library{}.get_path();

            const auto desktop_path = utils::com::get_desktop_path();
            if (!desktop_path.empty())
            {
                create_launcher_shortcut(launcher_path, desktop_path / "Ultimate Legends.lnk",
                                         property_keys::SHORTCUT_CREATED);
            }

            // Same "Ultimate Legends" Programs folder the game shortcuts use.
            const auto programs = utils::com::get_start_menu_programs_path();
            if (!programs.empty())
            {
                const auto sm_dir = programs / L"Ultimate Legends";
                std::error_code ec;
                std::filesystem::create_directories(sm_dir, ec);
                if (!ec)
                {
                    create_launcher_shortcut(launcher_path, sm_dir / "Ultimate Legends.lnk",
                                             property_keys::START_MENU_SHORTCUT_CREATED);
                }
            }
        }
        catch (...)
        {
            printf("Error creating shortcuts\n");
        }
    }
}

int CALLBACK WinMain(const HINSTANCE instance, HINSTANCE, LPSTR, int)
{
    // Harden DLL search before anything else runs: System32 + AddDllDirectory entries only.
    // Prevents planting via stray DLLs in the launcher's own directory.
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);

#ifdef _DEBUG
    // Test runs (tools\run-test-debug.bat passes -no-assert-dialogs): a failed assertion must never
    // leave a modal dialog on the desktop that stops a launcher thread until someone clicks it. It
    // goes to the debugger output instead and the process ends (exit code 3), which the test sees.
    if (utils::flags::has_flag("no-assert-dialogs"))
    {
        _set_error_mode(_OUT_TO_STDERR);
        _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_DEBUG);
        _CrtSetReportMode(_CRT_ERROR, _CRTDBG_MODE_DEBUG);
        _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    }
#endif

    try
    {
        set_working_directory();

        const utils::nt::library lib{instance};
        const auto path = utils::properties::get_appdata_path();

        if (is_subprocess())
        {
            run_watchdog();
            return run_subprocess(lib, path);
        }

        // Elevated redist install worker: no singleton, no CEF.
        if (const auto redist_ids = utils::flags::get_flag_value("redist-worker"))
        {
            return redist::run_worker(*redist_ids);
        }

        enable_dpi_awareness();

        // An ultimatelegends:// URL may have been passed on the command line (protocol launch).
        const auto deep_link_url = deep_link::get_arg();

#if !defined(DEBUG)
        if (!try_become_singleton())
        {
            // Another instance owns the launcher: hand it the URL instead of erroring out.
            if (deep_link_url.has_value() && deep_link::forward(deep_link_url.value()))
            {
                return 0;
            }
            throw std::runtime_error{"Ultimate Legends is already running"};
        }
#else
        AllocConsole();
        FILE* fp;
        freopen_s(&fp, "CONOUT$", "w", stdout);
        freopen_s(&fp, "CONOUT$", "w", stderr);
        printf("Debug console enabled\n");
#endif

        // A downloaded launcher update (portable installs) goes in now, before CEF loads its files.
        switch (launcher_update::apply_pending())
        {
        case launcher_update::result::relaunch:
#if !defined(DEBUG)
            singleton_mutex().unlock(); // the new launcher takes it
#endif
            if (!launcher_update::relaunch())
            {
                MessageBoxW(nullptr, L"Ultimate Legends could not start itself again after an update step. Start it again.",
                            L"Ultimate Legends", MB_ICONERROR | MB_OK);
                return 1;
            }
            return 0;
        case launcher_update::result::stop:
            return 1;
        case launcher_update::result::none:
            break;
        }
        launcher_update::cleanup();

        remove_previous_data_root();

        // Persistent equivalent of -offline, settable from the Settings page.
        if (utils::properties::load(property_keys::OFFLINE_MODE) == "true") utils::flags::add_flag("offline");

        // Listen for forwarded deep links right away so a link clicked during startup isn't lost.
        deep_link::server deep_link_server{};
        deep_link_server.start(&on_deep_link);

        if (!utils::nt::is_wine_environment())
        {
            create_shortcuts();
            uri_scheme::ensure_registered();
        }
        else
        {
            printf("[Wine/Proton] Running under Wine - some Windows-specific features are disabled\n");
        }

        show_window(lib, path);

        return 0;
    }
    catch (std::exception& e)
    {
        MessageBoxA(nullptr, e.what(), "ERROR", MB_ICONERROR);
    }
    catch (...)
    {
        MessageBoxA(nullptr, "An unknown error occurred", "ERROR", MB_ICONERROR);
    }

    return 1;
}
