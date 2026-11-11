#include "std_include.hpp"
#include "redact.hpp"

#include <algorithm>

namespace support
{
    namespace
    {
        char fold(const char c)
        {
            if (c == '/') return '\\';
            if (c >= 'A' && c <= 'Z') return static_cast<char>(c - 'A' + 'a');
            return c;
        }

        bool word_char(const char c)
        {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
        }

        bool matches_at(const std::string& text, const std::size_t at, const std::string& value)
        {
            if (value.empty() || at + value.size() > text.size()) return false;
            for (std::size_t i = 0; i < value.size(); ++i)
            {
                if (fold(text[at + i]) != fold(value[i])) return false;
            }
            // Whole values only: a word character next to the match continues another word.
            if (at > 0 && word_char(value.front()) && word_char(text[at - 1])) return false;
            const auto end = at + value.size();
            if (end < text.size() && word_char(value.back()) && word_char(text[end])) return false;
            return true;
        }

        std::string trim_separators(std::string value)
        {
            while (value.size() > 1 && (value.back() == '\\' || value.back() == '/')) value.pop_back();
            return value;
        }

        std::string backslashes(std::string value)
        {
            std::replace(value.begin(), value.end(), '/', '\\');
            return value;
        }
    }

    std::vector<redaction> make_redactions(const std::string& profile, const std::string& user, const std::string& computer,
                                           const std::string& unix_home)
    {
        std::vector<redaction> out;
        const auto add = [&](const std::string& value, const char* placeholder)
        {
            const auto trimmed = trim_separators(value);
            if (trimmed.size() < 2) return;
            // A drive root or "/" as a "profile" would hide every path.
            if (trimmed == "/" || (trimmed.size() == 2 && trimmed[1] == ':')) return;
            out.push_back({trimmed, placeholder});
        };

        add(profile, "%USERPROFILE%");
        if (!unix_home.empty() && unix_home.front() == '/')
        {
            add(unix_home, "%HOME%");
            add("Z:" + backslashes(trim_separators(unix_home)), "%HOME%");
            // The Linux user name, which Wine's own user name (steamuser) doesn't show.
            const auto home = trim_separators(unix_home);
            if (home.rfind("/home/", 0) == 0 && home.find('/', 6) == std::string::npos) add(home.substr(6), "%USERNAME%");
        }
        add(user, "%USERNAME%");
        add(computer, "%COMPUTERNAME%");

        // Longest first: the profile folder before the user name inside it.
        std::stable_sort(out.begin(), out.end(), [](const redaction& a, const redaction& b) { return a.value.size() > b.value.size(); });
        return out;
    }

    std::string redact(const std::string& text, const std::vector<redaction>& redactions)
    {
        std::string out;
        out.reserve(text.size());
        for (std::size_t i = 0; i < text.size();)
        {
            const auto found = std::find_if(redactions.begin(), redactions.end(), [&](const redaction& r) { return matches_at(text, i, r.value); });
            if (found != redactions.end())
            {
                out += found->placeholder;
                i += found->value.size();
                continue;
            }
            out.push_back(text[i]);
            ++i;
        }
        return out;
    }

    std::string folder_name(const std::string& path)
    {
        const auto trimmed = trim_separators(path);
        if (trimmed.size() <= 3 && trimmed.size() >= 2 && trimmed[1] == ':') return trimmed.substr(0, 2);
        const auto slash = trimmed.find_last_of("\\/");
        return slash == std::string::npos ? trimmed : trimmed.substr(slash + 1);
    }
}
