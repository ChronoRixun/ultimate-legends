#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>

// An isolated launcher for agent and CI checks: `ultimate-legends.exe -portable -test-instance <name>`.
// It runs beside the player's own launcher without touching it:
//   - its single-instance lock, properties lock and deep-link pipe carry "-test-<name>", so it neither
//     hands its start to the player's launcher nor can take the player's ultimatelegends:// links;
//   - it writes nothing to HKCU (no ultimatelegends:// registration, registry::set_hkcu_string and the
//     launcher's other registry writes refuse) and creates no Desktop / Start Menu / game shortcuts;
//   - its window is never activated: created WS_EX_NOACTIVATE (so neither CEF's focus on start nor a click
//     makes it the foreground window), shown with SW_SHOWNOACTIVATE, never maximized, never brought to the
//     front (and a Release build has no console);
//   - the Debug-only dev overrides (builder / patch / models manifests, the release API, ...) used by
//     tools/dev/*_cdp.py work in this mode too, so a Release build can be driven against local fixtures.
// Accepted only together with -portable (the data root is the copy's own folder); --remote-debugging-port
// works as always. Without -test-instance nothing changes.
namespace utils::test_instance
{
    // A name: 1-32 of a-z, 0-9 and '-' (it becomes part of kernel object names).
    bool valid_name(const std::string& name);

    // The instance for these arguments: nullopt without -test-instance; with it, the lower-cased name, or
    // nullopt with `error` set when it is invalid or -portable is missing.
    std::optional<std::string> resolve(const std::optional<std::string>& value, bool portable, std::string& error);

    // `base` with the instance's suffix ("ultimate-legends" -> "ultimate-legends-test-<name>"); `base` itself
    // for the player's launcher (empty name).
    std::string suffixed(const std::string& base, const std::string& name);
    std::wstring suffixed(const std::wstring& base, const std::string& name);

    // What a start does outside the launcher's own folder.
    struct startup_plan
    {
        bool register_uri{};      // HKCU\Software\Classes\ultimatelegends
        bool create_shortcuts{};  // Desktop / Start Menu links
        bool hkcu_writes{};       // any other registry write
        bool activate_window{};   // show / SetForegroundWindow / restore maximized
        bool dev_overrides{};     // the Debug-only fixture properties
    };

    startup_plan plan(const std::string& name, bool debug_build);

    struct startup_steps
    {
        std::function<void()> create_shortcuts;
        std::function<void()> register_uri;
    };

    // The start's side effects outside the launcher's folder (main.cpp): only what `plan` allows runs.
    void run_startup(const startup_plan& plan, const startup_steps& steps);

    // ---- the process's mode (set once, by main.cpp, before anything else uses it; tests set it too) ----
    void set(const std::string& name);
    const std::string& name();
    bool active();
    const startup_plan& current();

    // Registry writes outside the launcher's folder are allowed (false in a test instance).
    bool hkcu_writes_allowed();
    // The Debug-only dev overrides apply (a Debug build, or a test instance).
    bool dev_overrides();
    // The window may be activated / brought to the front (false in a test instance).
    bool may_activate();
    // Extended window styles the launcher window adds: WS_EX_NOACTIVATE (0x08000000) in a test instance, else 0.
    // (SW_SHOWNOACTIVATE alone is not enough: the browser focuses its window when it starts, which activated
    // the test window on the player's desktop for about a minute in the 11-21 real run.)
    std::uint32_t extra_window_ex_style();
}
