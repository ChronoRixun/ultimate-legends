#pragma once

#include "release_channel.hpp"

#include <optional>
#include <string>

// What a patch update may install into one folder, on the update channel (patch_channel.hpp applies it;
// no files, network or Windows here, so the unit tests run the real rule):
//
//   - the channel's release (`found`, from release_resolver), by its tag, when it is at least as new
//     as the fix in the folder (or the folder has none, or one whose version can't be read);
//   - an older release only with a `consent` for exactly this attempt: the player chose Switch back to
//     Stable for this folder, from exactly the version installed to exactly the release offered. A
//     consent is never stored: a failed or cancelled attempt, a later Play or Verify, a restart, Keep
//     the beta or a channel change all start again without one;
//   - when GitHub can't be asked and there is no earlier choice for the channel: nothing over a fix
//     already there; into a folder without one, the latest release's files (as launcher 0.3 did), each
//     still checked against the manifest's hash.
namespace patch_policy
{
    struct consent
    {
        std::string from; // the version in the folder when the player said Switch back ("1.8.0-beta.2")
        std::string to;   // the release they were shown ("1.7.1")
    };

    enum class action
    {
        install,        // `chosen`, by its tag
        install_latest, // releases/latest/download: no choice could be made and the folder has no fix
        keep,           // leave the folder as it is (`note` says why)
    };

    struct decision
    {
        action what = action::keep;
        std::optional<release_channel::release> chosen;
        bool downgrade{};  // an older release, by the consent
        bool from_cache{}; // `chosen` is the channel's last choice: GitHub couldn't be asked (`error`)
        std::string error; // why GitHub couldn't be asked
        std::string note;  // for the log and the page
    };

    // `installed`: the fix in the folder (patch_channel::installed_version: nullopt without one, "" when
    // its version can't be read).
    decision decide(const std::optional<std::string>& installed, const release_channel::outcome& found,
                    const std::optional<consent>& consent);
}
