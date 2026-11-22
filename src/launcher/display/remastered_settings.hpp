#pragma once

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

// XML2 Fix 1.12.0: process-restart presentation settings. Reading never creates
// an INI. Writes validate the whole request before touching individual keys.
namespace remastered_settings
{
    inline constexpr auto section = L"Remastered";
    inline constexpr auto required_fix = "1.12.0";
    struct change { std::string key; std::optional<std::string> value; };
    const std::vector<std::string>& keys();
    bool supports_version(const std::optional<std::string>& version);
    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error);
    std::map<std::string, std::string> read(const std::filesystem::path& ini);
    bool write(const std::filesystem::path& ini, const std::vector<change>& changes, std::string& error);
}
