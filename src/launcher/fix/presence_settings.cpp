#include "std_include.hpp"
#include "presence_settings.hpp"
#include "fix_ini.hpp"

namespace presence_settings
{
    const std::vector<std::string>& keys()
    {
        static const std::vector<std::string> list{"Enabled", "ShowZone", "ShowParty"};
        return list;
    }

    std::map<std::string, std::string> read(const std::filesystem::path& ini)
    {
        return fix_ini::read(ini, section, keys());
    }

    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error)
    {
        if (std::find(keys().begin(), keys().end(), key) == keys().end())
        {
            error = "Unknown Discord setting: " + key;
            return std::nullopt;
        }
        if (auto flag = fix_ini::parse_flag(value))
        {
            return flag;
        }
        error = key + " must be 0 or 1.";
        return std::nullopt;
    }

    bool write(const std::filesystem::path& ini, const std::vector<change>& changes, std::string& error)
    {
        fix_ini::changes prepared;
        for (const auto& change : changes)
        {
            std::optional<std::string> value;
            if (change.value)
            {
                value = normalise(change.key, *change.value, error);
                if (!value)
                {
                    return false;
                }
            }
            else if (std::find(keys().begin(), keys().end(), change.key) == keys().end())
            {
                error = "Unknown Discord setting: " + change.key;
                return false;
            }
            prepared.emplace_back(change.key, std::move(value));
        }
        return fix_ini::write(ini, section, prepared, error);
    }
}
