#include "std_include.hpp"
#include "patch_policy.hpp"

namespace patch_policy
{
    bool same_numbers(const std::string& a, const std::string& b)
    {
        const auto x = release_channel::parse_version(a);
        const auto y = release_channel::parse_version(b);
        if (!x || !y)
        {
            return false;
        }
        for (std::size_t i = 0; i < 3; ++i)
        {
            const auto left = i < x->core.size() ? x->core[i] : std::uint64_t{0};
            const auto right = i < y->core.size() ? y->core[i] : std::uint64_t{0};
            if (left != right)
            {
                return false;
            }
        }
        return true;
    }

    bool offers_switch_back(const std::string& installed, const bool recorded, const std::string& stable)
    {
        if (recorded)
        {
            return release_channel::is_ahead_of(installed, stable);
        }
        return release_channel::is_version(installed) && release_channel::is_version(stable) && !same_numbers(installed, stable) &&
               release_channel::compare(installed, stable) > 0;
    }

    decision decide(const std::optional<std::string>& installed, const release_channel::outcome& found, const std::optional<consent>& consent,
                    const bool recorded)
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
        // No record for these files: their numeric VERSIONINFO can't tell 1.8.0-beta.N from 1.8.0, so a
        // release with the same numbers is a repair (the channel's choice, checked by its hashes).
        if (known && !recorded && same_numbers(target, *installed))
        {
            result.what = action::install;
            result.chosen = found.chosen;
            result.note = target + cached + " over " + *installed + ", which has no install record (a repair)";
            return result;
        }
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
