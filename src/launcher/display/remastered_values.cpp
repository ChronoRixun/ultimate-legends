#include "std_include.hpp"
#include "remastered_settings.hpp"
#include "updater/release_channel.hpp"

namespace remastered_settings
{
    const std::vector<std::string>& keys()
    {
        static const std::vector<std::string> list{"Enabled", "MSAASamples", "Anisotropy", "AnisotropyOnPointArt", "CenteredHud"};
        return list;
    }

    bool supports_version(const std::optional<std::string>& version)
    {
        return version && release_channel::is_version(*version) &&
            release_channel::satisfies(*version, ">=1.12.0-0");
    }

    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error)
    {
        // Match the Fix's exact numeric choices, including invalid flag refusal.
        // Never turn hand-edited "true" into an enabled profile while reading.
        const bool flag = key == "Enabled" || key == "AnisotropyOnPointArt" || key == "CenteredHud";
        const bool msaa = key == "MSAASamples", af = key == "Anisotropy";
        if ((flag && (value == "0" || value == "1")) ||
            ((msaa || af) && (value == "0" || value == "2" || value == "4" || value == "8")) ||
            (msaa && value == "6") || (af && value == "16")) return value;
        error = "Unsupported Remastered setting: " + key + "=" + value;
        return std::nullopt;
    }
}
