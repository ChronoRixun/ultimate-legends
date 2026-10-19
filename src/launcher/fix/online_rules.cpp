#include "std_include.hpp"
#include "online_rules.hpp"

namespace online_rules
{
    namespace
    {
        bool has(const std::vector<std::string>& list, const std::string& key)
        {
            return std::find(list.begin(), list.end(), key) != list.end();
        }
    }

    const std::vector<std::string>& keys()
    {
        static const std::vector<std::string> list{"Host", "Public", "RoomName", "JoinCode"};
        return list;
    }

    bool known(const std::string& key)
    {
        return has(keys(), key);
    }

    std::optional<std::string> normalise_code(const std::string_view text)
    {
        std::string code;
        for (const auto c : text)
        {
            if (c == ' ' || c == '-' || c == '\t' || c == '\r' || c == '\n')
            {
                continue;
            }
            const auto upper = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
            if (code_alphabet.find(upper) == std::string_view::npos)
            {
                return std::nullopt;
            }
            code += upper;
        }
        if (code.size() != code_length)
        {
            return std::nullopt;
        }
        return code;
    }

    std::string display_code(const std::string& code)
    {
        if (code.size() != code_length)
        {
            return code;
        }
        return code.substr(0, code_length / 2) + "-" + code.substr(code_length / 2);
    }

    std::optional<mode> parse_mode(const std::string_view text)
    {
        if (text == "normal")
        {
            return mode::normal;
        }
        if (text == "host")
        {
            return mode::host;
        }
        if (text == "join")
        {
            return mode::join;
        }
        return std::nullopt;
    }

    std::optional<std::string> normalise_room_name(const std::string_view text)
    {
        std::size_t start = 0;
        std::size_t end = text.size();
        while (start < end && (text[start] == ' ' || text[start] == '\t'))
        {
            ++start;
        }
        while (end > start && (text[end - 1] == ' ' || text[end - 1] == '\t'))
        {
            --end;
        }
        const auto name = text.substr(start, end - start);
        if (name.size() > room_name_length)
        {
            return std::nullopt;
        }
        for (const auto c : name)
        {
            if (c < 0x20 || c > 0x7E || c == ';' || c == '"')
            {
                return std::nullopt;
            }
        }
        return std::string(name);
    }

    std::vector<change> changes_for(const mode mode, const std::string& code, const std::vector<std::string>& present,
                                    const host_options& options)
    {
        std::vector<change> changes;
        const auto remove = [&](const std::string& key)
        {
            if (has(present, key))
            {
                changes.push_back({key, std::nullopt});
            }
        };

        switch (mode)
        {
        case mode::host:
            changes.push_back({"Host", std::string(host_value)});
            changes.push_back({"Public", options.is_public ? "1" : "0"});
            if (options.is_public && !options.room_name.empty())
            {
                changes.push_back({"RoomName", options.room_name});
            }
            else
            {
                remove("RoomName");
            }
            remove("JoinCode");
            break;
        case mode::join:
            changes.push_back({"JoinCode", code});
            remove("Host");
            remove("Public");
            remove("RoomName");
            break;
        case mode::normal:
            for (const auto& key : keys())
            {
                remove(key);
            }
            break;
        }
        return changes;
    }

    std::string rooms_host(const std::string_view broker)
    {
        std::string_view text = broker;
        while (!text.empty() && (text.front() == ' ' || text.front() == '\t'))
        {
            text.remove_prefix(1);
        }
        while (!text.empty() && (text.back() == ' ' || text.back() == '\t'))
        {
            text.remove_suffix(1);
        }
        if (text.empty())
        {
            return std::string(default_broker_host);
        }
        if (text.front() == '[')
        {
            // [IPv6]:port
            const auto close = text.find(']');
            return close == std::string_view::npos ? std::string(text.substr(1)) : std::string(text.substr(1, close - 1));
        }
        const auto colon = text.find(':');
        if (colon != std::string_view::npos && text.find(':', colon + 1) == std::string_view::npos)
        {
            return std::string(text.substr(0, colon));
        }
        return std::string(text); // a host, or a bare IPv6 address
    }

    std::optional<std::string> normalise_pin(const std::string_view text)
    {
        std::string pin;
        for (const auto c : text)
        {
            if (c == ' ' || c == '\t')
            {
                continue;
            }
            if (!std::isxdigit(static_cast<unsigned char>(c)))
            {
                return std::nullopt;
            }
            pin += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
        if (pin.size() != 64)
        {
            return std::nullopt;
        }
        return pin;
    }

    std::string rooms_pin(const std::string_view broker_pin)
    {
        if (const auto pin = normalise_pin(broker_pin))
        {
            return *pin;
        }
        return std::string(default_broker_pin);
    }
}
