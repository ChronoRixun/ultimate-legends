#pragma once

#include "updater/release_channel.hpp"
#include <string>
#include <vector>

namespace xml1
{
    // CLI.md in Legends Classic: build --classic-conversation off|xml1 first works in
    // 0.6.0-beta.3. 0.6.0-beta.2's builder parses the option but does not implement it
    // (off is a no-op, xml1 fails with E_USAGE), so beta.2 and older never see it: below the
    // gate the option is not sent at all. As for legends-models' optional CLI arguments, gate
    // on the installed release, never the available release. Unversioned development
    // builders stay hidden.
    inline bool supports_classic_conversation(const std::string& version)
    {
        return release_channel::is_version(version) && release_channel::compare(version, "0.6.0-beta.3") >= 0;
    }

    inline std::vector<std::wstring> conversation_arguments(const std::string& version, const bool classic)
    {
        if (!supports_classic_conversation(version)) return {};
        return {L"--classic-conversation", classic ? L"xml1" : L"off"};
    }
}
