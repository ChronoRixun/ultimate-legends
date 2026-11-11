#pragma once

#include <optional>
#include <string>

// Support > Copy diagnostics: the choices behind two lines of the report, as pure functions (the native
// tests feed them stubbed values; support/diagnostics.cpp reads the real ones).
namespace support
{
    // ---- the primary monitor ----

    struct display_mode
    {
        int width{};
        int height{};
        int refresh{}; // Hz, 0 when unknown
        bool valid() const { return width > 0 && height > 0; }
        bool same_size(const display_mode& other) const { return width == other.width && height == other.height; }
    };

    struct display_facts
    {
        display_mode desktop;   // the mode saved for the desktop (EnumDisplaySettings ENUM_REGISTRY_SETTINGS)
        display_mode current;   // the mode right now (ENUM_CURRENT_SETTINGS): an exclusive-fullscreen game changes it
        int monitor_dpi{};      // GetDpiForMonitor now; follows the current mode, so wrong while a game changed it
        display_mode remembered_mode; // the mode when the launcher started, if desktop and current matched then
        int remembered_dpi{};         // the monitor's DPI at that moment
        int system_dpi{};             // GetDpiForSystem: the primary monitor's scaling when the user signed in
    };

    enum class scale_source
    {
        none,          // unknown
        now,           // the monitor reports it now (the desktop mode is in use)
        launcher_start, // remembered from when the launcher started in the desktop mode
        sign_in,       // Windows' system DPI: the primary monitor's scaling at sign-in
    };

    struct display_report
    {
        display_mode desktop;  // what the report calls the monitor's mode
        display_mode current;  // set (valid) only when it differs from the desktop mode
        int scale{};           // percent, 0 when unknown
        scale_source source{scale_source::none};
    };

    // The desktop mode (the current one when the saved mode can't be read) and its scaling: the monitor's
    // own DPI when the desktop mode is in use; otherwise the DPI remembered at launcher start in that mode,
    // else the system DPI. A temporary mode (a fullscreen game) is reported as `current`.
    display_report choose_display(const display_facts& facts);

    int scale_percent(int dpi); // 144 -> 150; 0 for 0

    // ---- a companion fix's version ----

    enum class version_source
    {
        none,   // not installed (no DLL)
        dll,    // the DLL's version resource (with the launcher's record for a pre-release, patch_channel)
        record, // the release the launcher recorded when it installed the fix
        log,    // the fix's own log, which starts with "<fix name> <version>"
        unknown // installed, but no version could be read
    };

    struct fix_version
    {
        std::string version;
        version_source source{version_source::none};
    };

    // `dll`: nullopt = the DLL is absent, "" = it has no readable version resource. `recorded`: the version the
    // launcher recorded for that folder ("" when none). `log_head`: the beginning of the fix's log ("" when none).
    fix_version choose_fix_version(const std::optional<std::string>& dll, const std::string& recorded, const std::string& log_head,
                                   const std::string& fix_name);
}
