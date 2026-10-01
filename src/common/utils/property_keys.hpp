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
    // Debug builds only (tools/dev/launcher_update_cdp.py): the self-update's release JSON (the
    // shape of GitHub's releases/latest) and the version the launcher claims to be.
    constexpr const char* DEV_LAUNCHER_RELEASE = "dev-launcher-release";
    constexpr const char* DEV_LAUNCHER_VERSION = "dev-launcher-version";

    // Game property suffixes (used with game_config_t::get/set)
    constexpr const char* INSTALL = "install";
    constexpr const char* IS_INSTALLED = "is-installed";
    constexpr const char* LAUNCH_OPTIONS = "launch-options";
    constexpr const char* LAUNCH_ADMIN = "launch-admin";

    // Built games (the X-Men Legends port, "xml1-..."): INSTALL is the output folder the builder
    // writes, IS_INSTALLED turns true once a build finished and the XML2 Fix is in it.
    constexpr const char* BUILD_ISO = "iso";                         // the disc image the last build used
    constexpr const char* BUILD_MOVIES = "movies";                   // "true" / "false"; default true
    constexpr const char* BUILD_KEEP_CACHE = "keep-cache";           // "true" / "false"; default true
    constexpr const char* BUILD_LINK_BASE = "link-base";             // "true" / "false"; default false
    constexpr const char* BUILD_CACHE = "cache";                     // the build cache folder; default <launcher data>\cache\xml1
    constexpr const char* BUILDER_VERSION = "builder-version";       // the installed builder to use
    constexpr const char* BUILDER_CONTENT = "builder-content";       // that builder's content_version
    // Debug builds only (the CDP tests): where to fetch the builder's manifest, a builder exe to
    // run instead of an installed one, and the game's patch manifest.
    constexpr const char* DEV_BUILDER_MANIFEST = "builder-manifest";
    constexpr const char* DEV_BUILDER_EXE = "builder-exe";
    constexpr const char* DEV_PATCH_MANIFEST = "patch-manifest";
}
