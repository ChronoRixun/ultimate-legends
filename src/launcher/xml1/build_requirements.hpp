#pragma once

#include "updater/release_channel.hpp"
#include <optional>
#include <string>

namespace xml1
{
    // Unknown builder contract is distinct from an older manifest with no minimum. Even
    // the latter needs an installed DLL. Used at native admission after all patch work ends.
    inline bool build_fix_ready(const std::optional<std::string>& required, const std::optional<std::string>& installed)
    {
        return required && installed && (required->empty() || release_channel::satisfies(*installed, *required));
    }
}
