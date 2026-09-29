#pragma once

#include <string>
#include <unordered_map>
#include <vector>
#include <optional>
#include <filesystem>

namespace game_config
{
    class game_config_t
    {
    public:
        // Generic property access methods
        std::optional<std::string> get(const std::string& property_suffix) const;
        void set(const std::string& property_suffix, const std::string& value) const;

        // Convenience methods for common properties
        std::optional<std::filesystem::path> get_install_path() const;
        void set_install_path(const std::filesystem::path& path) const;
        bool is_installed() const;
        void set_installed(bool installed) const;
        std::optional<std::string> get_launch_options() const;

        // Effective "launch as admin" value: user property if set, else requires_elevation default.
        bool launch_elevated() const;

        // Every exe this game can run as: launch exe and known child/companion exes.
        std::vector<std::string> collect_exes() const;

        // The full paths of those exes in the game's install folder; empty when the game has no
        // folder yet. The running check and Stop match processes by these paths, never by name
        // alone: X-Men Legends II and the X-Men Legends port both run an XMen2.exe.
        std::vector<std::filesystem::path> running_images() const;

        // Reset all properties for this game
        void reset() const;

        // Get the game key used for this config
        const std::string& get_game_key() const { return game_key; }

        // Public fields
        std::string game_key;  // The map key ("mua", "mua2", "xml2", etc.) - must be initialized first
        std::string display_name;
        std::string id;
        std::string exe_name;

        // The game's patch (the MUA Controller Fix, the XML2 Fix): a manifest of files that
        // client_updater installs into the game's install folder. Empty = no patch.
        std::string update_manifest_url;
        std::string update_folder_url;

        std::vector<std::string> valid_game_files;
        std::vector<std::string> check_running_exes;

        // Redist group IDs required by this game (from redist_packages.cpp).
        std::vector<std::string> required_redists;

        // Launch via UAC prompt (for games that need admin rights, e.g. HKLM writes).
        bool requires_elevation = false;

        // Steam app ID used to find an existing install in the user's Steam libraries. Empty = not a Steam game.
        std::string steam_app_id;

        // The game is built on the player's PC (the X-Men Legends port, by xml1-builder) rather than
        // found in an existing install: its setup is the build flow, and a folder is only valid when
        // it holds every one of valid_game_files.
        bool built = false;

        // Helper to construct full property key (public to maintain aggregate status)
        std::string make_property_key(const std::string& suffix) const;
    };

    // Forward declarations
    extern const std::unordered_map<std::string, game_config_t> game_configs_;

    // Function declarations
    std::optional<game_config_t> get_game_config(const std::string& game);
    // Lookup by wire id (game_config.id, e.g. "mua"), as tracked for the running game.
    std::optional<game_config_t> get_game_config_by_id(const std::string& id);
    bool validate_game_path(const std::string& game, const std::filesystem::path& path);
    // OS-level check: any of the game's executables is running from the game's install folder
    // (running_images). `game` is the wire id (game_config.id).
    // max_age_ms lets a polling caller reuse a recent process snapshot; 0 always takes a fresh one,
    // which is what anything acting on the answer must use.
    bool is_game_process_running(const std::string& game, unsigned int max_age_ms = 0);
    void reset_all_games();

    // The game's required_redists, deduplicated.
    std::vector<std::string> resolve_required_redists(const std::string& game);
}
