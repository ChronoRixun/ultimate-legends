#pragma once

#include <filesystem>
#include <map>
#include <string>
#include <vector>

namespace models_tool
{
    // --port remains the real, read-only input. --game points here so even a killed v0.3.0
    // cannot publish into the game. The caller serializes commit with cancellation.
    class build_transaction
    {
    public:
        build_transaction(const std::filesystem::path& port, const std::string& token);
        ~build_transaction();
        build_transaction(const build_transaction&) = delete;
        build_transaction& operator=(const build_transaction&) = delete;
        const std::filesystem::path& game() const { return game_; }
        void commit();

    private:
        std::filesystem::path mods_, root_, game_;
        std::vector<std::string> original_;
        std::map<std::string, std::string> baseline_;
        bool preserve_recovery_{};
    };
}
