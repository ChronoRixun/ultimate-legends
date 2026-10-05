#include "std_include.hpp"
#include "presence_settings.hpp"
#include "fix_ini.hpp"

namespace presence_settings
{
    namespace
    {
        bool known(const fix_ini::fix& fix, const std::string& key)
        {
            const auto& list = keys(fix);
            return std::find(list.begin(), list.end(), key) != list.end();
        }
    }

    const std::vector<std::string>& keys(const fix_ini::fix& fix)
    {
        return fix.presence_keys;
    }

    std::map<std::string, std::string> read(const std::filesystem::path& ini, const fix_ini::fix& fix)
    {
        return fix_ini::read(ini, section, keys(fix));
    }

    std::optional<std::string> normalise(const fix_ini::fix& fix, const std::string& key, const std::string& value, std::string& error)
    {
        if (!known(fix, key))
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

    bool write(const std::filesystem::path& ini, const fix_ini::fix& fix, const std::vector<change>& changes, std::string& error)
    {
        fix_ini::changes prepared;
        for (const auto& change : changes)
        {
            std::optional<std::string> value;
            if (change.value)
            {
                value = normalise(fix, change.key, *change.value, error);
                if (!value)
                {
                    return false;
                }
            }
            else if (!known(fix, change.key))
            {
                error = "Unknown Discord setting: " + change.key;
                return false;
            }
            prepared.emplace_back(change.key, std::move(value));
        }
        return fix_ini::write(ini, section, prepared, error);
    }
}
