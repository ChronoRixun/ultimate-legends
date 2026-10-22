#pragma once

#include "release_channel.hpp"

#include <string>
#include <vector>

// Asks GitHub which release of a repository the update channel takes (release_channel.hpp's rule)
// for the three update paths: the launcher's self-update, the XML2 Fix and the Legends Classic
// builder. Unauthenticated GitHub API calls are limited (60 an hour per address), so an answer is
// reused for a few minutes, and Beta's last answer per repository is kept in the launcher's
// properties for when GitHub can't be asked: then that release is used and the outcome says why
// (from_cache, error). Stable never falls back: it asks releases/latest as it always did. Never
// called with -offline.
namespace release_source
{
    constexpr auto launcher_repo = "ChronoRixun/ultimate-legends";
    constexpr auto xml2_fix_repo = "ChronoRixun/xml2-fix";
    constexpr auto builder_repo = "ChronoRixun/legends-classic";

    // The setting (launcher-update-channel): Stable unless the player chose Beta.
    release_channel::channel current_channel();
    void set_channel(release_channel::channel value);

    // The release of `repo` for `channel` with every file in `required` (Beta skips a release still
    // uploading them; Stable reports it, as before). `force` asks GitHub even when a recent answer
    // is at hand (Check for updates).
    release_channel::outcome resolve(const std::string& repo, release_channel::channel channel, const std::vector<std::string>& required,
                                     bool force = false);

    // The last outcome for `repo` and `channel` this run, without asking GitHub (nullopt: none yet).
    std::optional<release_channel::outcome> last(const std::string& repo, release_channel::channel channel);

    // Where a file of `chosen` is: by its tag (never releases/latest).
    std::string file_url(const std::string& repo, const release_channel::release& chosen, const std::string& file);
}
