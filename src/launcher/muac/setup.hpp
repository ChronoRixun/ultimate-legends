#pragma once
#include <filesystem>
#include <string>
#include <rapidjson/document.h>

namespace muac_setup {
    bool start(const std::filesystem::path& source, const std::filesystem::path& output, std::string& error);
    bool start_update(std::string& error, bool repair = false);
    void cancel();
    void state(rapidjson::Document& out);
}
