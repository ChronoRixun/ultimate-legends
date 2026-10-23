#pragma once

#include "game_config.hpp"

#include <rapidjson/document.h>

// What a game's page shows about its patch (the MUA Controller Fix, the XML2 Fix): the release
// installed in the game folder, read from the version resource of the patch's DLL, and the
// patch's latest release on GitHub. The latest release is checked in the background, at most once
// an hour per patch (MUA and MUA2 share one; never with -offline), so a page asks again while the
// check is running. Nothing is installed here: client_updater installs a newer release when the
// game is launched from the launcher or verified.
namespace patch_status
{
    // {installed: "1.1.0" | "1.8.0-beta.2" (the release the launcher installed) | "" (no version resource)
    //  | null (no patch file), latest: "1.2.0" | null (the update channel's), page: the release's page,
    //  checking: bool, updateAvailable: bool, channel: "stable" | "beta", prerelease: bool,
    //  aheadOfStable: bool, fromCache: bool, error: string}; null for a game with no patch.
    // The patch release the file says it is: "1.1.0" from FILEVERSION 1,1,0,0 (a fourth part only when it
    // isn't 0); "" when the file has no version resource that can be read; nullopt when it isn't there. The
    // X-Men Legends port's Online section checks the XML2 Fix with it (fix/online_launch.hpp).
    std::optional<std::string> installed_version(const std::filesystem::path& file);

    void write_status(const game_config::game_config_t& config, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);
}
