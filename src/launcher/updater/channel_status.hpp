#pragma once

#include <rapidjson/document.h>

#include <string>
#include <vector>

// Settings > Update channel (app/update-channel.js): the channel, and for each item it updates - the
// launcher, the XML2 Fix in X-Men Legends II's folder and in the X-Men Legends port's, the Legends
// Classic builder - the version installed (a beta's whole version: the fix's recorded release), the
// latest release and, on Beta, the channel's release, checked in the background. An item that is a
// beta newer than the latest release is "ahead": switching back to Stable asks before anything is
// installed (switch_back()), and nothing is ever downgraded without that.
namespace channel_status
{
    // {channel, offline, checking, items: [{id: "launcher" | "fix" | "builder", game?: "xml2" | "xml1",
    //  installed, prerelease, stable, beta, ahead, fromCache, error}]}
    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);

    // Asks GitHub again in the background (answers are reused for a few minutes; never -offline).
    void refresh();

    // Stores the channel ("stable" / "beta"), tells the launcher's update and starts a refresh.
    void set_channel(const std::string& channel);

    // Switch back to Stable for the items named ("launcher", "fix", "builder"): the latest release may
    // replace the beta. The launcher's download and the builder's install start here; the fix installs
    // with the next Verify of each game in `fix_games` (the page runs it). What started is reported.
    struct switch_back_result
    {
        bool launcher{};
        bool builder{};
        std::vector<std::string> fix_games;
    };
    switch_back_result switch_back(const std::vector<std::string>& items);
}
