#include "std_include.hpp"
#include "steam_library.hpp"

#include <utils/io.hpp>
#include <utils/registry.hpp>
#include <utils/string.hpp>

#include <regex>
#include <vector>

namespace steam_library
{
    namespace
    {
        std::optional<std::filesystem::path> get_steam_root()
        {
            const auto steam_path = utils::registry::get_hkcu_string(L"Software\\Valve\\Steam", L"SteamPath");
            if (!steam_path || steam_path->empty())
            {
                return {};
            }
            return std::filesystem::path(*steam_path);
        }

        // Every value of `key` in a VDF (Valve KeyValues) text file, with \\ unescaped.
        std::vector<std::string> read_vdf_values(const std::filesystem::path& file, const std::string& key)
        {
            std::string data;
            if (!utils::io::read_file(file, &data))
            {
                return {};
            }

            std::vector<std::string> values;
            const std::regex pattern("\"" + key + "\"\\s+\"((?:[^\"\\\\]|\\\\.)*)\"", std::regex::icase);
            for (auto it = std::sregex_iterator(data.begin(), data.end(), pattern); it != std::sregex_iterator(); ++it)
            {
                std::string value;
                const auto raw = (*it)[1].str();
                for (size_t i = 0; i < raw.size(); ++i)
                {
                    if (raw[i] == '\\' && i + 1 < raw.size())
                    {
                        ++i;
                    }
                    value.push_back(raw[i]);
                }
                values.push_back(std::move(value));
            }
            return values;
        }

        std::vector<std::filesystem::path> get_library_folders(const std::filesystem::path& steam_root)
        {
            std::vector<std::filesystem::path> libraries{steam_root};
            for (const auto& path : read_vdf_values(steam_root / "steamapps" / "libraryfolders.vdf", "path"))
            {
                const auto library = utils::string::utf8_to_path(path);
                std::error_code ec;
                if (std::ranges::none_of(libraries, [&](const auto& known) { return std::filesystem::equivalent(known, library, ec); }))
                {
                    libraries.push_back(library);
                }
            }
            return libraries;
        }
    }

    std::optional<std::filesystem::path> find_app_install(const std::string& app_id)
    {
        if (app_id.empty())
        {
            return {};
        }

        const auto steam_root = get_steam_root();
        if (!steam_root)
        {
            return {};
        }

        for (const auto& library : get_library_folders(*steam_root))
        {
            const auto manifest = library / "steamapps" / ("appmanifest_" + app_id + ".acf");
            const auto install_dirs = read_vdf_values(manifest, "installdir");
            if (install_dirs.empty())
            {
                continue;
            }

            const auto install = library / "steamapps" / "common" / utils::string::utf8_to_path(install_dirs.front());
            if (utils::io::directory_exists(install))
            {
                return install;
            }
        }

        return {};
    }
}
