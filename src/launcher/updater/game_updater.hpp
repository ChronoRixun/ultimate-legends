#pragma once

#include <filesystem>
#include <string>
#include <game_config.hpp>

namespace game_updater
{
    // Checks the install the player already has. Ultimate Legends never downloads, repairs or
    // deletes game files; the launcher's own patch files are client_updater's job.
    class game_updater
    {
    public:
        explicit game_updater(const game_config::game_config_t& config);

        // The stored install folder; empty when the game has not been set up.
        [[nodiscard]] const std::filesystem::path& install_path() const { return this->install_path_; }

        // True while the install folder still holds the game's executable.
        [[nodiscard]] bool is_install_valid() const;

    private:
        std::string game_key_;
        std::filesystem::path install_path_;
    };
}
