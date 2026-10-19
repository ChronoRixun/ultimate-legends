#include "std_include.hpp"
#include "online_settings.hpp"
#include "fix_ini.hpp"
#include "test_mode_settings.hpp"

#include <utils/io.hpp>
#include <utils/string.hpp>

namespace online_settings
{
    namespace
    {
        // The fix writes a small object; anything much larger is not its file.
        constexpr std::uintmax_t max_status_bytes = 64 * 1024;
    }

    std::map<std::string, std::string> read(const std::filesystem::path& ini, const fix_ini::fix& fix)
    {
        return fix_ini::read(ini, section, online_rules::keys(), fix.comment_chars);
    }

    bool write(const std::filesystem::path& ini, const fix_ini::fix& fix, const std::vector<online_rules::change>& changes,
               std::string& error)
    {
        fix_ini::changes prepared;
        for (const auto& change : changes)
        {
            if (!online_rules::known(change.key))
            {
                error = "Unknown online setting: " + change.key;
                return false;
            }
            std::optional<std::string> value;
            if (change.value && change.key == "Host")
            {
                if (*change.value != online_rules::host_value)
                {
                    error = "Host can only be " + std::string(online_rules::host_value) + ".";
                    return false;
                }
                value = *change.value;
            }
            else if (change.value && change.key == "Public")
            {
                if (*change.value != "0" && *change.value != "1")
                {
                    error = "Public must be 0 or 1.";
                    return false;
                }
                value = *change.value;
            }
            else if (change.value && change.key == "RoomName")
            {
                value = online_rules::normalise_room_name(*change.value);
                if (!value || value->empty())
                {
                    error = "That room name can't be used.";
                    return false;
                }
            }
            else if (change.value)
            {
                value = online_rules::normalise_code(*change.value);
                if (!value)
                {
                    error = "That is not a join code.";
                    return false;
                }
            }
            prepared.emplace_back(change.key, std::move(value));
        }
        if (prepared.empty())
        {
            return true;
        }
        return fix_ini::write(ini, section, prepared, error, fix.comment_chars);
    }

    bool prepare(const std::filesystem::path& ini, const fix_ini::fix& fix, const online_rules::mode mode, const std::string& code,
                 std::string& error, const online_rules::host_options& options)
    {
        std::string normalised;
        if (mode == online_rules::mode::join)
        {
            const auto valid = online_rules::normalise_code(code);
            if (!valid)
            {
                error = "That is not a join code.";
                return false;
            }
            normalised = *valid;
        }
        const auto present = fix_ini::present(ini, section, online_rules::keys());
        return write(ini, fix, online_rules::changes_for(mode, normalised, present, options), error);
    }

    browse_target target(const std::optional<std::filesystem::path>& ini, const fix_ini::fix* fix)
    {
        std::map<std::string, std::string> values;
        if (ini && fix)
        {
            values = fix_ini::read(*ini, section, {"Broker", "BrokerPin", "GameVersion"}, fix->comment_chars);
        }
        const auto value = [&values](const char* key)
        {
            const auto it = values.find(key);
            return it == values.end() ? std::string{} : it->second;
        };
        return {online_rules::rooms_host(value("Broker")), online_rules::rooms_pin(value("BrokerPin")), value("GameVersion")};
    }

    bool test_mode_on(const std::filesystem::path& ini, const fix_ini::fix& fix)
    {
        for (const auto& [key, value] : test_mode_settings::read(ini, fix))
        {
            const auto flag = fix_ini::parse_flag(value);
            if (flag && *flag == "1")
            {
                return true;
            }
        }
        return false;
    }

    std::filesystem::path status_path(const std::filesystem::path& game_dir)
    {
        return game_dir / status_file;
    }

    bool clear_status(const std::filesystem::path& game_dir, std::string& error)
    {
        const auto file = status_path(game_dir);
        std::error_code ec;
        std::filesystem::remove(file, ec);
        if (ec && std::filesystem::exists(file))
        {
            error = utils::string::path_to_utf8(file.filename()) + " could not be deleted (" + ec.message() + ").";
            return false;
        }
        return true;
    }

    std::optional<std::string> read_status(const std::filesystem::path& game_dir)
    {
        const auto file = status_path(game_dir);
        std::error_code ec;
        const auto size = std::filesystem::file_size(file, ec);
        if (ec || size > max_status_bytes)
        {
            return std::nullopt;
        }
        std::string text;
        if (!utils::io::read_file(file, &text))
        {
            return std::nullopt;
        }
        return text;
    }
}
