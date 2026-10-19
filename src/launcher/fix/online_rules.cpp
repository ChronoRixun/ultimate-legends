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
        static const std::vector<std::string> list{"Host", "JoinCode"};
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

    std::vector<change> changes_for(const mode mode, const std::string& code, const std::vector<std::string>& present)
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
            remove("JoinCode");
            break;
        case mode::join:
            changes.push_back({"JoinCode", code});
            remove("Host");
            break;
        case mode::normal:
            remove("Host");
            remove("JoinCode");
            break;
        }
        return changes;
    }
}
