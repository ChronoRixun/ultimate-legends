#pragma once

#include "file_info.hpp"
#include "ui_progress_listener.hpp"
#include <game_config.hpp>

namespace client_updater
{
    // Installs, updates and removes a game's patch: the files its manifest lists, all of them
    // inside the game's install folder.
    class client_updater
    {
    public:
        client_updater(const game_config::game_config_t& config, updater::ui_progress_listener* listener = nullptr);

        void run() const;
        void delete_client() const;

        // True when the game has a patch but its manifest could not be fetched or parsed.
        [[nodiscard]] bool manifest_fetch_failed() const { return this->manifest_fetch_failed_; }

        [[nodiscard]] std::vector<updater::file_info> get_outdated_files(const std::vector<updater::file_info>& files) const;

        void update_files(const std::vector<updater::file_info>& outdated_files) const;

    private:
        std::filesystem::path install_path_;
        std::string client_id_;
        std::string update_manifest_url_;
        std::string update_folder_url_;
        std::vector<updater::file_info> manifest_files_;
        updater::ui_progress_listener* progress_listener_;
        bool manifest_fetch_failed_ = false;

        void update_file(const updater::file_info& file) const;

        [[nodiscard]] bool is_outdated_file(const updater::file_info& file) const;
        // Where the file lives in the game's install folder.
        [[nodiscard]] std::filesystem::path get_drive_filename(const std::string& name) const;
        void remove_stale_files() const;
        void store_applied_manifest() const;
        [[nodiscard]] bool is_update_cancelled() const;
    };
}
