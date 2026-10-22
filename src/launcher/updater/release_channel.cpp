#include "std_include.hpp"
#include "release_channel.hpp"

#include <rapidjson/writer.h>

namespace release_channel
{
    namespace
    {
        bool is_digit(const char c)
        {
            return c >= '0' && c <= '9';
        }

        bool is_identifier_char(const char c)
        {
            return is_digit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-';
        }

        bool all_digits(const std::string_view text)
        {
            return !text.empty() && std::all_of(text.begin(), text.end(), is_digit);
        }

        std::vector<std::string_view> split(const std::string_view text, const char separator)
        {
            std::vector<std::string_view> parts;
            std::size_t start = 0;
            for (;;)
            {
                const auto end = text.find(separator, start);
                parts.push_back(text.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start));
                if (end == std::string_view::npos)
                {
                    return parts;
                }
                start = end + 1;
            }
        }

        // The comparison the launcher used before pre-releases had an order: leading numbers only.
        int compare_numbers(const std::string_view a, const std::string_view b)
        {
            const auto numbers = [](const std::string_view text)
            {
                std::vector<std::uint64_t> parts;
                for (const auto part : split(text, '.'))
                {
                    std::uint64_t value = 0;
                    for (const auto c : part)
                    {
                        if (!is_digit(c))
                        {
                            break;
                        }
                        value = value * 10 + static_cast<std::uint64_t>(c - '0');
                    }
                    parts.push_back(value);
                }
                return parts;
            };
            auto left = numbers(a);
            auto right = numbers(b);
            const auto size = std::max(left.size(), right.size());
            left.resize(size);
            right.resize(size);
            for (std::size_t i = 0; i < size; ++i)
            {
                if (left[i] != right[i])
                {
                    return left[i] < right[i] ? -1 : 1;
                }
            }
            return 0;
        }

        int compare_parsed(const version& a, const version& b)
        {
            const auto size = std::max(a.core.size(), b.core.size());
            for (std::size_t i = 0; i < size; ++i)
            {
                const auto x = i < a.core.size() ? a.core[i] : std::uint64_t{0};
                const auto y = i < b.core.size() ? b.core[i] : std::uint64_t{0};
                if (x != y)
                {
                    return x < y ? -1 : 1;
                }
            }

            // A release ranks above its pre-releases.
            if (a.pre.empty() || b.pre.empty())
            {
                return a.pre.empty() == b.pre.empty() ? 0 : a.pre.empty() ? 1 : -1;
            }
            for (std::size_t i = 0; i < std::min(a.pre.size(), b.pre.size()); ++i)
            {
                const auto& x = a.pre[i];
                const auto& y = b.pre[i];
                const auto x_number = all_digits(x);
                const auto y_number = all_digits(y);
                if (x_number && y_number)
                {
                    // Without leading zeros (parse_version), the longer number is the larger.
                    if (x.size() != y.size())
                    {
                        return x.size() < y.size() ? -1 : 1;
                    }
                    if (x != y)
                    {
                        return x < y ? -1 : 1;
                    }
                    continue;
                }
                if (x_number != y_number)
                {
                    return x_number ? -1 : 1; // numbers rank below text
                }
                if (x != y)
                {
                    return x < y ? -1 : 1;
                }
            }
            return a.pre.size() == b.pre.size() ? 0 : a.pre.size() < b.pre.size() ? -1 : 1;
        }

        std::string json_string(const rapidjson::Value& object, const char* key)
        {
            if (!object.IsObject())
            {
                return {};
            }
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString()
                       ? std::string(member->value.GetString(), member->value.GetStringLength())
                       : std::string{};
        }

        bool json_bool(const rapidjson::Value& object, const char* key)
        {
            if (!object.IsObject())
            {
                return false;
            }
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsBool() && member->value.GetBool();
        }

        std::optional<release> release_from_value(const rapidjson::Value& value)
        {
            if (!value.IsObject())
            {
                return std::nullopt;
            }
            release result{};
            result.tag = json_string(value, "tag_name");
            result.version = tag_version(result.tag);
            if (result.version.empty())
            {
                return std::nullopt;
            }
            result.draft = json_bool(value, "draft");
            result.prerelease = json_bool(value, "prerelease");
            result.page = json_string(value, "html_url");
            if (!result.page.starts_with("https://"))
            {
                result.page.clear();
            }

            const auto assets = value.FindMember("assets");
            if (assets != value.MemberEnd() && assets->value.IsArray())
            {
                for (const auto& entry : assets->value.GetArray())
                {
                    asset file{};
                    file.name = json_string(entry, "name");
                    file.url = json_string(entry, "browser_download_url");
                    if (entry.IsObject())
                    {
                        const auto size = entry.FindMember("size");
                        if (size != entry.MemberEnd() && size->value.IsUint64())
                        {
                            file.size = size->value.GetUint64();
                        }
                    }
                    if (!file.name.empty())
                    {
                        result.assets.push_back(std::move(file));
                    }
                }
            }
            return result;
        }

        bool is_stable_release(const release& value)
        {
            return !value.prerelease && !is_prerelease(value.version);
        }

        std::string_view trim(std::string_view text)
        {
            while (!text.empty() && (text.front() == ' ' || text.front() == '\t'))
            {
                text.remove_prefix(1);
            }
            while (!text.empty() && (text.back() == ' ' || text.back() == '\t'))
            {
                text.remove_suffix(1);
            }
            return text;
        }
    }

    channel parse_channel(const std::string_view text)
    {
        std::string lower(text);
        std::transform(lower.begin(), lower.end(), lower.begin(), [](const char c)
        {
            return static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        });
        return lower == "beta" ? channel::beta : channel::stable;
    }

    const char* channel_name(const channel value)
    {
        return value == channel::beta ? "beta" : "stable";
    }

    std::optional<version> parse_version(std::string_view text)
    {
        if (text.empty() || text.size() > 64)
        {
            return std::nullopt;
        }
        if (const auto plus = text.find('+'); plus != std::string_view::npos)
        {
            // Build metadata: dot-separated identifiers, none empty ("+abc.1"; not "+" or "+..").
            for (const auto part : split(text.substr(plus + 1), '.'))
            {
                if (part.empty() || !std::all_of(part.begin(), part.end(), is_identifier_char))
                {
                    return std::nullopt;
                }
            }
            text = text.substr(0, plus);
        }

        version result{};
        const auto dash = text.find('-');
        const auto core = text.substr(0, dash);
        const auto parts = split(core, '.');
        if (parts.size() > 4)
        {
            return std::nullopt;
        }
        for (const auto part : parts)
        {
            if (!all_digits(part) || part.size() > 9)
            {
                return std::nullopt;
            }
            result.core.push_back(std::stoull(std::string(part)));
        }

        if (dash != std::string_view::npos)
        {
            for (const auto part : split(text.substr(dash + 1), '.'))
            {
                if (part.empty() || !std::all_of(part.begin(), part.end(), is_identifier_char) ||
                    (all_digits(part) && part.size() > 1 && part.front() == '0'))
                {
                    return std::nullopt;
                }
                result.pre.emplace_back(part);
            }
        }
        return result;
    }

    std::string tag_version(std::string_view tag)
    {
        if (tag.starts_with('v') || tag.starts_with('V'))
        {
            tag.remove_prefix(1);
        }
        // Pre-release identifiers are lower case (tools/release_tag.py publishes only those): "v1.8.0-Beta.1"
        // is not a release tag, so it can never sort against "beta" by ASCII ("Beta" < "beta").
        if (std::ranges::any_of(tag, [](const char c) { return c >= 'A' && c <= 'Z'; }))
        {
            return {};
        }
        // A release tag is stricter than a DLL's version resource: no leading zero in its numbers
        // ("v01.8.0" is not one; "1.08" from a resource still compares as 1.8).
        const auto core = tag.substr(0, std::min(tag.find('-'), tag.find('+')));
        for (const auto part : split(core, '.'))
        {
            if (part.size() > 1 && part.front() == '0')
            {
                return {};
            }
        }
        return is_version(tag) ? std::string(tag) : std::string{};
    }

    bool is_version(const std::string_view text)
    {
        return parse_version(text).has_value();
    }

    bool is_prerelease(const std::string_view text)
    {
        const auto parsed = parse_version(text);
        return parsed && !parsed->pre.empty();
    }

    int compare(const std::string_view a, const std::string_view b)
    {
        const auto left = parse_version(a);
        const auto right = parse_version(b);
        if (!left || !right)
        {
            return compare_numbers(a, b);
        }
        return compare_parsed(*left, *right);
    }

    bool satisfies(const std::string_view version, const std::string_view requirement)
    {
        if (!is_version(version))
        {
            return false;
        }
        // Terms separated by spaces or commas; an operator may stand apart from its version (">= 1.7.1").
        std::string list;
        for (const auto c : requirement)
        {
            const auto blank = c == ' ' || c == '\t' || c == ',';
            if (blank && !list.empty() && (list.back() == '>' || list.back() == '<' || list.back() == '='))
            {
                continue;
            }
            list += blank ? ' ' : c;
        }
        for (auto term : split(list, ' '))
        {
            term = trim(term);
            if (term.empty())
            {
                continue;
            }
            std::string_view op = ">=";
            for (const std::string_view candidate : {">=", "<=", "==", ">", "<", "="})
            {
                if (term.starts_with(candidate))
                {
                    op = candidate;
                    term.remove_prefix(candidate.size());
                    break;
                }
            }
            // Anything else in front of the number ("v1.7", "~1.7") reads as at least that version, as before.
            const auto first = term.find_first_of("0123456789");
            if (first == std::string_view::npos)
            {
                return false;
            }
            term.remove_prefix(first);
            const auto order = compare(version, term);
            const auto ok = op == ">=" ? order >= 0 : op == "<=" ? order <= 0 : op == ">" ? order > 0 : op == "<" ? order < 0 : order == 0;
            if (!ok)
            {
                return false;
            }
        }
        return true;
    }

    build_version launcher_build(const std::string_view describe, const std::string_view tag, const std::string_view product)
    {
        build_version result{};
        const auto tagged = tag_version(tag);
        result.version = tagged.empty() ? std::string(product) : tagged;
        result.release = !tagged.empty() && product != "0.0.0" && describe == tag;
        result.prerelease = is_prerelease(result.version);
        return result;
    }

    const asset* release::find(const std::string_view name) const
    {
        for (const auto& file : this->assets)
        {
            if (file.name == name)
            {
                return &file;
            }
        }
        return nullptr;
    }

    std::optional<release> parse_release_json(const std::string_view json, std::string& error)
    {
        rapidjson::Document document;
        document.Parse(json.data(), json.size());
        if (document.HasParseError() || !document.IsObject())
        {
            error = "GitHub's answer is not a release.";
            return std::nullopt;
        }
        auto result = release_from_value(document);
        if (!result)
        {
            error = "The release's tag (" + json_string(document, "tag_name") + ") is not a version number.";
        }
        return result;
    }

    std::vector<release> parse_releases_json(const std::string_view json, std::string& error)
    {
        rapidjson::Document document;
        document.Parse(json.data(), json.size());
        if (document.HasParseError() || !document.IsArray())
        {
            error = "GitHub's answer is not a list of releases.";
            return {};
        }
        std::vector<release> releases;
        for (const auto& value : document.GetArray())
        {
            if (auto entry = release_from_value(value))
            {
                releases.push_back(std::move(*entry));
            }
        }
        return releases;
    }

    bool has_files(const release& value, const std::vector<std::string>& required)
    {
        return std::all_of(required.begin(), required.end(), [&](const std::string& name)
        {
            auto file = name;
            if (const auto at = file.find("{version}"); at != std::string::npos)
            {
                file.replace(at, 9, value.version);
            }
            return value.find(file) != nullptr;
        });
    }

    std::optional<release> pick(const channel value, const std::vector<release>& releases, const std::vector<std::string>& required)
    {
        const release* best = nullptr;
        for (const auto& entry : releases)
        {
            if (entry.draft || !is_version(entry.version) || (value == channel::stable && !is_stable_release(entry)))
            {
                continue;
            }
            if (!has_files(entry, required))
            {
                continue;
            }
            if (!best || compare(entry.version, best->version) > 0)
            {
                best = &entry;
            }
        }
        return best ? std::optional<release>(*best) : std::nullopt;
    }

    std::string download_url(const std::string_view repo, const std::string_view tag, const std::string_view file)
    {
        return std::format("https://github.com/{}/releases/download/{}/{}", repo, tag, file);
    }

    std::string latest_download_url(const std::string_view repo, const std::string_view file)
    {
        return std::format("https://github.com/{}/releases/latest/download/{}", repo, file);
    }

    std::string to_json(const release& value)
    {
        rapidjson::Document document(rapidjson::kObjectType);
        auto& allocator = document.GetAllocator();
        const auto text = [&](const std::string& s)
        {
            return rapidjson::Value(s.data(), static_cast<rapidjson::SizeType>(s.size()), allocator);
        };
        document.AddMember("tag_name", text(value.tag), allocator);
        document.AddMember("prerelease", value.prerelease, allocator);
        document.AddMember("html_url", text(value.page), allocator);
        rapidjson::Value assets(rapidjson::kArrayType);
        for (const auto& file : value.assets)
        {
            rapidjson::Value entry(rapidjson::kObjectType);
            entry.AddMember("name", text(file.name), allocator);
            entry.AddMember("browser_download_url", text(file.url), allocator);
            entry.AddMember("size", file.size, allocator);
            assets.PushBack(entry, allocator);
        }
        document.AddMember("assets", assets, allocator);

        rapidjson::StringBuffer buffer;
        rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
        document.Accept(writer);
        return std::string(buffer.GetString(), buffer.GetLength());
    }

    std::optional<release> release_from_json(const std::string_view json)
    {
        std::string ignored;
        return json.empty() ? std::nullopt : parse_release_json(json, ignored);
    }

    outcome settle(std::optional<release> fetched, const std::string& fetch_error, const std::optional<release>& cached)
    {
        outcome result{};
        if (fetched)
        {
            result.chosen = std::move(fetched);
            return result;
        }
        result.error = fetch_error.empty() ? std::string("GitHub could not be asked.") : fetch_error;
        if (cached)
        {
            result.chosen = cached;
            result.from_cache = true;
        }
        return result;
    }

    bool may_install(const std::string_view installed, const std::string_view target, const bool downgrade_confirmed)
    {
        return installed.empty() || compare(target, installed) >= 0 || downgrade_confirmed;
    }

    bool is_ahead_of(const std::string_view installed, const std::string_view stable)
    {
        return !installed.empty() && !stable.empty() && is_prerelease(installed) && compare(installed, stable) > 0;
    }

    std::optional<std::string> effective_patch_version(const std::optional<std::string>& dll_version,
                                                       const std::optional<patch_record>& record, const std::string_view dll_sha1)
    {
        if (!dll_version)
        {
            return std::nullopt;
        }
        if (record && is_version(record->version) && !record->sha1.empty() && record->sha1 == dll_sha1)
        {
            return record->version;
        }
        return dll_version;
    }
}
