#include "std_include.hpp"
#include "remastered_settings.hpp"
#include "fix/fix_ini.hpp"

namespace remastered_settings
{
    std::map<std::string, std::string> read(const std::filesystem::path& ini)
    {
        return fix_ini::read(ini, section, keys());
    }

    bool write(const std::filesystem::path& ini, const std::vector<change>& changes, std::string& error)
    {
        fix_ini::changes prepared;
        for (const auto& item : changes)
        {
            if (std::find(keys().begin(), keys().end(), item.key) == keys().end())
            {
                error = "Unknown Remastered setting: " + item.key;
                return false;
            }
            auto value = item.value;
            if (value)
            {
                value = normalise(item.key, *value, error);
                if (!value) return false;
            }
            prepared.emplace_back(item.key, std::move(value));
        }
        return fix_ini::write(ini, section, prepared, error);
    }
}
