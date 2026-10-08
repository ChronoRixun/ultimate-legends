#include "std_include.hpp"
#include "tool_install.hpp"

// The parts of tool_install that only compare text and numbers (no files, no network), so the unit
// tests (src/tests) build them on their own.
namespace tool_install
{
    namespace
    {
        bool equals_ignoring_case(const std::string& a, const std::string& b)
        {
            return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](const char x, const char y)
            {
                return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
            });
        }
    }

    bool is_safe_version(const std::string& version)
    {
        if (version.empty() || version.size() > 64 || version.front() == '.' || version.find("..") != std::string::npos)
        {
            return false;
        }
        return std::all_of(version.begin(), version.end(), [](const char c)
        {
            return std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '+' || c == '_';
        });
    }

    int compare_versions(const std::string& a, const std::string& b)
    {
        const auto numbers = [](const std::string& text)
        {
            std::vector<long long> parts;
            std::size_t start = 0;
            while (start <= text.size())
            {
                const auto end = std::min(text.find('.', start), text.size());
                const auto part = text.substr(start, end - start);
                long long value = 0;
                for (const auto c : part)
                {
                    if (!std::isdigit(static_cast<unsigned char>(c)))
                    {
                        break; // "1.2.0-beta" compares as 1.2.0
                    }
                    value = value * 10 + (c - '0');
                }
                parts.push_back(value);
                start = end + 1;
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


    std::string version_in_zip_name(const manifest& manifest, const std::string& name)
    {
        const auto at = manifest.version.empty() ? std::string::npos : manifest.zip.find(manifest.version);
        if (at == std::string::npos)
        {
            return {};
        }
        const auto prefix = manifest.zip.substr(0, at);
        const auto suffix = manifest.zip.substr(at + manifest.version.size());
        if (name.size() <= prefix.size() + suffix.size() || !equals_ignoring_case(name.substr(0, prefix.size()), prefix) ||
            !equals_ignoring_case(name.substr(name.size() - suffix.size()), suffix))
        {
            return {};
        }
        const auto version = name.substr(prefix.size(), name.size() - prefix.size() - suffix.size());
        return is_safe_version(version) && std::isdigit(static_cast<unsigned char>(version.front())) ? version : std::string{};
    }

    zip_match match_zip(const manifest& manifest, const zip_facts& facts)
    {
        if (facts.size == manifest.size && !facts.sha256.empty() && facts.sha256 == manifest.sha256)
        {
            return zip_match::same;
        }
        const auto version = version_in_zip_name(manifest, facts.name);
        if (!version.empty() && compare_versions(version, manifest.version) < 0)
        {
            return zip_match::older;
        }
        if (!version.empty() && compare_versions(version, manifest.version) > 0)
        {
            return zip_match::newer;
        }
        return facts.size != manifest.size ? zip_match::other_size : zip_match::other_hash;
    }

    std::string describe_zip_match(const manifest& manifest, const zip_facts& facts, const zip_match match)
    {
        const auto version = version_in_zip_name(manifest, facts.name);
        switch (match)
        {
        case zip_match::same:
            return {};
        case zip_match::older:
            return std::format("{} is version {}, older than the latest release ({}), so it was not installed. "
                               "Download {} from the release, or let the launcher download it.",
                               facts.name, version, manifest.version, manifest.zip);
        case zip_match::newer:
            return std::format("{} is named as version {}, but the latest release is {}: it can't be checked against "
                               "the release, so it was not installed.", facts.name, version, manifest.version);
        case zip_match::other_size:
            return std::format("{} is not the release's {}: it is {} bytes, the release's is {} (an incomplete download?). "
                               "It was not installed.", facts.name, manifest.zip, facts.size, manifest.size);
        case zip_match::other_hash:
            break;
        }
        return std::format("{} does not match the SHA-256 of the release's {} (a damaged download, or not the release's "
                           "file), so it was not installed.", facts.name, manifest.zip);
    }
}
