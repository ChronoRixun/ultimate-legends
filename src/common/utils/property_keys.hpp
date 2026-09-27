#pragma once

namespace property_keys
{
    // Launcher settings
    constexpr const char* CLOSE_ON_LAUNCH = "launcher-close-on-launch";
    constexpr const char* SKIP_CLIENT_UPDATE = "launcher-skip-client-update";
    constexpr const char* SHORTCUT_CREATED = "launcher-shortcut-created";
    constexpr const char* START_MENU_SHORTCUT_CREATED = "launcher-start-menu-shortcut-created";
    constexpr const char* AUTO_SHORTCUTS = "launcher-auto-shortcuts";
    constexpr const char* OFFLINE_MODE = "launcher-offline-mode";
    // Only the UI reads these; listed so every launcher key is in one place.
    constexpr const char* SKIP_REDIST_CHECK = "launcher-skip-redist-check";
    constexpr const char* PORTABLE_MODE = "launcher-portable-mode";
    constexpr const char* REDUCE_MOTION = "launcher-reduce-motion";
    constexpr const char* GRAYSCALE_UNINSTALLED = "launcher-grayscale-uninstalled";

    // Game property suffixes (used with game_config_t::get/set)
    constexpr const char* INSTALL = "install";
    constexpr const char* IS_INSTALLED = "is-installed";
    constexpr const char* LAUNCH_OPTIONS = "launch-options";
    constexpr const char* LAUNCH_ADMIN = "launch-admin";
}
