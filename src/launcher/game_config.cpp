#include "std_include.hpp"
#include "game_config.hpp"
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>
#include <utils/io.hpp>
#include <utils/nt.hpp>
#include <utils/string.hpp>
#include <unordered_set>

// Patch files for MUA and MUA2 (the controller fix: dinput8.dll), installed into the game folder.
// Each release of github.com/ChronoRixun/mua-controller-fix publishes the DLL and a patch manifest.
#define CONTROLLER_FIX_RELEASE "https://github.com/ChronoRixun/mua-controller-fix/releases/latest/download/"
// X-Men Legends II gets the same from github.com/ChronoRixun/xml2-fix (dinput.dll: controller
// bindings and the OpenSpy redirect for online play).
#define XML2_FIX_RELEASE "https://github.com/ChronoRixun/xml2-fix/releases/latest/download/"

namespace game_config
{
    // Property access method implementations
    std::string game_config_t::make_property_key(const std::string& suffix) const
    {
        return this->game_key + "-" + suffix;
    }

    std::optional<std::string> game_config_t::get(const std::string& property_suffix) const
    {
        return utils::properties::load(this->make_property_key(property_suffix));
    }

    void game_config_t::set(const std::string& property_suffix, const std::string& value) const
    {
        utils::properties::store(this->make_property_key(property_suffix), value);
    }

    // Convenience methods
    std::optional<std::filesystem::path> game_config_t::get_install_path() const
    {
        const auto value = this->get(property_keys::INSTALL);
        if (!value)
        {
            return std::nullopt;
        }

        return utils::string::utf8_to_path(*value);
    }

    void game_config_t::set_install_path(const std::filesystem::path& path) const
    {
        this->set(property_keys::INSTALL, utils::string::path_to_utf8(path));
    }

    bool game_config_t::is_installed() const
    {
        auto value = this->get(property_keys::IS_INSTALLED);
        return value && value.value() == "true";
    }

    void game_config_t::set_installed(bool installed) const
    {
        this->set(property_keys::IS_INSTALLED, installed ? "true" : "false");
    }

    std::optional<std::string> game_config_t::get_launch_options() const
    {
        return this->get(property_keys::LAUNCH_OPTIONS);
    }

    bool game_config_t::launch_elevated() const
    {
        const auto value = this->get(property_keys::LAUNCH_ADMIN);
        if (value && !value->empty())
        {
            return *value == "true";
        }
        return this->requires_elevation;
    }

    std::vector<std::string> game_config_t::collect_exes() const
    {
        std::vector<std::string> exes{ this->exe_name };
        for (const auto& exe : this->check_running_exes)
        {
            exes.push_back(exe);
        }
        return exes;
    }

    std::vector<std::filesystem::path> game_config_t::running_images() const
    {
        std::vector<std::filesystem::path> images;
        const auto folder = this->get_install_path();
        if (!folder || folder->empty())
        {
            return images;
        }

        for (const auto& exe : this->collect_exes())
        {
            if (exe.empty())
            {
                continue;
            }
            auto image = *folder / utils::string::utf8_to_path(exe);
            if (std::find(images.begin(), images.end(), image) == images.end())
            {
                images.push_back(std::move(image));
            }
        }
        return images;
    }

    void game_config_t::reset() const
    {
        // Clear all properties for this game
        this->set(property_keys::INSTALL, "");
        this->set(property_keys::IS_INSTALLED, "");
        this->set(property_keys::LAUNCH_OPTIONS, "");
        this->set(property_keys::LAUNCH_ADMIN, "");
    }

    // Game configurations
    // The games Ultimate Legends supports. MUA, MUA2 and XML2 run from an install the user already
    // has; the launcher only installs its patch files into it and never downloads, repairs or
    // deletes the game itself. X-Men Legends is a community port that the player's PC builds from
    // their own Xbox disc image and their XML2 install (xml1-builder, xml1/xml1_port.hpp); the
    // builder is the only code that writes or deletes its files, and it runs on the XML2 engine
    // with the same XML2 Fix. Marvel: Ultimate Alliance (2006 PC) is listed in the UI as coming
    // soon and gets an entry here once its executable has been checked against real installs.
    const std::unordered_map<std::string, game_config_t> game_configs_ = {
        {
            "mua",
            {
                .game_key = "mua",
                .display_name = "Marvel: Ultimate Alliance",
                .id = "mua",
                .exe_name = "Marvel.exe",
                .update_manifest_url = CONTROLLER_FIX_RELEASE "ultimate-legends.json",
                .update_folder_url = CONTROLLER_FIX_RELEASE,
                .valid_game_files = {"Marvel.exe"},
                .check_running_exes = {"Marvel.exe"},
                .required_redists = {"vcr2012"},
                .steam_app_id = "433300"
            }
        },
        {
            "mua2",
            {
                .game_key = "mua2",
                .display_name = "Marvel: Ultimate Alliance 2",
                .id = "mua2",
                .exe_name = "Alliance.exe",
                .update_manifest_url = CONTROLLER_FIX_RELEASE "ultimate-legends.json",
                .update_folder_url = CONTROLLER_FIX_RELEASE,
                .valid_game_files = {"Alliance.exe"},
                .check_running_exes = {"Alliance.exe"},
                .required_redists = {"vcr2012"},
                .steam_app_id = "433320"
            }
        },
        {
            "xml2",
            {
                .game_key = "xml2",
                .display_name = "X-Men Legends II: Rise of Apocalypse",
                .id = "xml2",
                .exe_name = "XMen2.exe",
                .update_manifest_url = XML2_FIX_RELEASE "ultimate-legends.json",
                .update_folder_url = XML2_FIX_RELEASE,
                .valid_game_files = {"XMen2.exe"},
                .check_running_exes = {"XMen2.exe"}
            }
        },
        {
            "xml1",
            {
                .game_key = "xml1",
                .display_name = "X-Men Legends",
                .id = "xml1",
                // XML2's engine: the port runs XMen2.exe too, from its own folder (so the running
                // check and Stop go by path, game_config_t::running_images).
                .exe_name = "XMen2.exe",
                .update_manifest_url = XML2_FIX_RELEASE "ultimate-legends.json",
                .update_folder_url = XML2_FIX_RELEASE,
                // A folder the builder finished: the exe and its stamp, written last.
                .valid_game_files = {"XMen2.exe", "_build/stamp.json"},
                .check_running_exes = {"XMen2.exe"},
                .built = true
            }
        },
    };

    std::optional<game_config_t> get_game_config(const std::string& game)
    {
        const auto it = game_configs_.find(game);
        if (it != game_configs_.end())
        {
#ifdef _DEBUG
            // Debug builds only: the CDP tests serve a stand-in patch from a local server
            // (<game>-patch-manifest = its manifest URL; the files sit next to it).
            if (const auto manifest = it->second.get(property_keys::DEV_PATCH_MANIFEST); manifest && !manifest->empty())
            {
                auto config = it->second;
                config.update_manifest_url = *manifest;
                config.update_folder_url = manifest->substr(0, manifest->rfind('/') + 1);
                return config;
            }
#endif
            return it->second;
        }
        return std::nullopt;
    }

    // Lookup by wire id (game_config.id, e.g. "mua"), as tracked for the running game.
    std::optional<game_config_t> get_game_config_by_id(const std::string& id)
    {
        for (const auto& [game_key, config] : game_configs_)
        {
            if (config.id == id)
            {
                return config;
            }
        }
        return std::nullopt;
    }

    bool validate_game_path(const std::string& game, const std::filesystem::path& path)
    {
        const auto config = get_game_config(game);
        if (!config)
        {
            return false;
        }

        // A built game's folder needs all of its files (an XML2 folder has an XMen2.exe too, but
        // no build stamp); an existing install needs any one of its executables.
        const auto has = [&](const std::string& file)
        {
            return utils::io::file_exists(path / utils::string::utf8_to_path(file));
        };
        if (config->built)
        {
            return !config->valid_game_files.empty() && std::all_of(config->valid_game_files.begin(), config->valid_game_files.end(), has);
        }
        return std::any_of(config->valid_game_files.begin(), config->valid_game_files.end(), has);
    }

    bool is_game_process_running(const std::string& game, const unsigned int max_age_ms)
    {
        const auto config = get_game_config_by_id(game);
        if (!config)
        {
            return false;
        }

        return utils::nt::is_any_image_running(config->running_images(), max_age_ms);
    }

    void reset_all_games()
    {
        // Reset properties for all games
        for (const auto& [game_key, config] : game_configs_)
        {
            config.reset();
        }
    }

    std::vector<std::string> resolve_required_redists(const std::string& game)
    {
        const auto config = get_game_config(game);
        if (!config) return {};

        std::vector<std::string> result;
        std::unordered_set<std::string> seen;
        for (const auto& id : config->required_redists)
        {
            if (seen.insert(id).second) result.push_back(id);
        }

        return result;
    }
}
