#include "std_include.hpp"
#include "patch_policy.hpp"

namespace patch_policy
{
    decision decide(const std::optional<std::string>& installed, const release_channel::outcome& found, const std::optional<consent>& consent)
    {
        decision result{};
        result.from_cache = found.from_cache;
        result.error = found.error;

        if (!found.chosen)
        {
            if (!installed)
            {
                result.what = action::install_latest;
                result.note = "the update channel can't be checked (" + found.error +
                              ") and there is no earlier result: the latest release's files are installed, each checked by its hash";
                return result;
            }
            result.note = (installed->empty() ? std::string("the fix") : *installed) + " stays: the update channel can't be checked (" +
                          found.error + ") and there is no earlier result";
            return result;
        }

        const auto& target = found.chosen->version;
        const auto cached = found.from_cache ? " (the last result: " + found.error + ")" : std::string{};
        const auto known = installed && release_channel::is_version(*installed);
        if (known && release_channel::compare(target, *installed) < 0)
        {
            // Only exactly what the player approved, for this folder and this attempt.
            if (consent && consent->from == *installed && consent->to == target)
            {
                result.what = action::install;
                result.chosen = found.chosen;
                result.downgrade = true;
                result.note = "switching back from " + *installed + " to " + target + ", as the player chose";
                return result;
            }
            result.note = *installed + " stays: the update channel offers " + target + cached + ", which is older";
            if (consent)
            {
                result.note += "; the switch back approved was " + consent->from + " -> " + consent->to + ", not this: ask again";
            }
            return result;
        }

        result.what = action::install;
        result.chosen = found.chosen;
        result.note = target + cached;
        return result;
    }
}
