#pragma once
#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace muac {
    using values = std::map<std::string, std::string>;
    values read(const std::filesystem::path& folder);
    std::optional<std::string> normalise(const std::string& key, const std::string& value);
    std::vector<std::string> missing_runtime(const std::filesystem::path& folder);
    bool write(const std::filesystem::path& folder, const values& changes, std::string& error);
}
