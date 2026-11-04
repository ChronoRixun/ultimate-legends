#pragma once
#include "commands.hpp"
#include <optional>
#include <string>
#include <utility>

namespace commands::artwork_commands {
    void register_commands(cef::cef_ui& ui, command_context& ctx);
    // Only /custom-art/<fixed game>/<fixed kind>/<opaque record> is accepted.
    std::optional<std::pair<std::string, std::string>> resource(const std::string& path);
}
