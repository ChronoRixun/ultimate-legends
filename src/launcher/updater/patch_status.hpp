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
    // {installed: "1.1.0" | "" (no version resource) | null (no patch file), latest: "1.2.0" | null,
    //  page: the release's page, checking: bool, updateAvailable: bool}; null for a game with no patch.
    void write_status(const game_config::game_config_t& config, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);
}
