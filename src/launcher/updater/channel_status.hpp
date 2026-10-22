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
    //  installed, dev, prerelease, stable, beta, ahead, fromCache, error}], repos: [{id, version, fromCache,
    //  error}] (the current channel's answer per repository, installed or not)}
    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);

    // Asks GitHub again in the background (answers are reused for a few minutes; never -offline).
    void refresh();

    // Stores the channel ("stable" / "beta"), tells the launcher's update and starts a refresh.
    void set_channel(const std::string& channel);

    // Switch back to Stable, approved by the player for exactly these versions and this attempt only:
    // the launcher's download of `launcher_to`, the builder's install of `builder_to` ("" for neither).
    // The fix's goes with each folder's Verify (verify-game { downgrade: { from, to } }). What started.
    struct switch_back_result
    {
        bool launcher{};
        bool builder{};
    };
    switch_back_result switch_back(const std::string& launcher_to, const std::string& builder_to);

    // Keep the beta: revokes what an earlier Switch back approved and has not installed yet.
    void keep_beta();
}
