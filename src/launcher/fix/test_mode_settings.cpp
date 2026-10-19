#include "std_include.hpp"
#include "test_mode_settings.hpp"
#include "fix_ini.hpp"

namespace test_mode_settings
{
    namespace
    {
        bool known(const std::string& key)
        {
            const auto& list = keys();
            return std::find(list.begin(), list.end(), key) != list.end();
        }
    }

    const std::vector<std::string>& keys()
    {
        static const std::vector<std::string> list{"ForgeEverywhere", "Hotkeys"};
        return list;
    }

    std::map<std::string, std::string> read(const std::filesystem::path& ini, const fix_ini::fix& fix)
    {
        return fix_ini::read(ini, section, keys(), fix.comment_chars);
    }

    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error)
    {
        if (!known(key))
        {
            error = "Unknown test mode setting: " + key;
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
                value = normalise(change.key, *change.value, error);
                if (!value)
                {
                    return false;
                }
            }
            else if (!known(change.key))
            {
                error = "Unknown test mode setting: " + change.key;
                return false;
            }
            prepared.emplace_back(change.key, std::move(value));
        }
        return fix_ini::write(ini, section, prepared, error, fix.comment_chars);
    }
}
