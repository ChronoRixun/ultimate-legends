#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

// Mods for the games' own mod loaders (in the XML2 Fix and MUA Controller Fix DLLs). A mod
// is a folder under <game>\mods laid out like the game folder; <game>\mods\load-order.txt
// lists them in load order, lowest priority first:
//
//   +Better HUD      enabled
//   -Old Skin        disabled (kept so its position is remembered)
//
// The launcher keeps that file in step with the folders on disk. The game only ever reads it.

namespace game_mods
{
    struct mod_info
    {
        std::string name; // folder name, UTF-8
        bool enabled{};
        std::uint64_t files{};
        std::uint64_t size{};

        // From the mod's optional mod.json: {"name", "version", "author", "description"}.
        std::string title;
        std::string version;
        std::string author;
        std::string description;
    };

    std::filesystem::path mods_folder(const std::filesystem::path& game_dir);

    // The game's mods in load order. Folders the load order doesn't list yet (e.g. copied in by
    // hand) are appended as enabled; entries whose folder is gone are dropped.
    std::vector<mod_info> list(const std::filesystem::path& game_dir);

    bool set_enabled(const std::filesystem::path& game_dir, const std::string& name, bool enabled, std::string& error);

    // `names` is the complete new order, lowest priority first.
    bool set_order(const std::filesystem::path& game_dir, const std::vector<std::string>& names, std::string& error);

    // Installs a mod from a .zip or a folder and enables it at the top of the load order.
    // Finds the mod's root inside wrapper folders (Mod\, mods\Mod\, Mod\Mod v2\...). Returns
    // the installed mod's name.
    std::optional<std::string> import(const std::filesystem::path& game_dir, const std::filesystem::path& source, bool is_zip, std::string& error);

    // Deletes the mod's folder and its load-order entry.
    bool uninstall(const std::filesystem::path& game_dir, const std::string& name, std::string& error);
}
