#include "std_include.hpp"
#include "patch_channel.hpp"
#include "client_store.hpp"
#include "patch_status.hpp"
#include "release_source.hpp"

#include <utils/cryptography.hpp>
#include <utils/flags.hpp>
#include <utils/io.hpp>
#include <utils/logger.hpp>
#include <utils/string.hpp>

namespace patch_channel
{
    namespace
    {
        constexpr auto manifest_name = "ultimate-legends.json";

        source as_configured(const game_config::game_config_t& config, const std::string& note = {})
        {
            return {config.update_manifest_url, config.update_folder_url, {}, false, note};
        }
    }

    source resolve(const game_config::game_config_t& config, const std::filesystem::path& folder,
                   const std::optional<patch_policy::consent>& consent)
    {
        // No repository (the MUA Controller Fix), or a Debug build's local stand-in for the patch.
        if (config.patch_repo.empty() || config.update_manifest_url != release_channel::latest_download_url(config.patch_repo, manifest_name))
        {
            return as_configured(config);
        }

        const auto installed = installed_version(config, folder);
        const auto channel = release_source::current_channel();
        const auto found = release_source::resolve(config.patch_repo, channel, {manifest_name});
        const auto decision = patch_policy::decide(installed, found, consent);
        utils::logger::write("XML2 Fix update ({}, {}): {}", config.game_key, release_channel::channel_name(channel), decision.note);

        switch (decision.what)
        {
        case patch_policy::action::install:
        {
            // The manifest and every file it lists, from the chosen release's tag.
            const auto manifest = release_source::file_url(config.patch_repo, *decision.chosen, manifest_name);
            return {manifest, manifest.substr(0, manifest.rfind('/') + 1), decision.chosen->version, decision.downgrade, decision.note};
        }
        case patch_policy::action::install_latest:
            return as_configured(config, decision.note);
        case patch_policy::action::keep:
            break;
        }
        return {{}, {}, {}, false, decision.note};
    }

    void record(const game_config::game_config_t& config, const std::filesystem::path& folder, const std::string& version,
                const std::string& patch_sha1)
    {
        if (config.patch_repo.empty())
        {
            return;
        }
        client_store::write_release(config.game_key, folder, {version, utils::string::to_lower(patch_sha1)});
    }

    std::optional<std::string> installed_version(const game_config::game_config_t& config, const std::filesystem::path& folder)
    {
        const auto file = folder / utils::string::utf8_to_path(config.patch_file);
        const auto resource = patch_status::installed_version(file);
        if (!resource || config.patch_repo.empty())
        {
            return resource;
        }
        const auto record = client_store::read_release(config.game_key, folder);
        if (!record || record->version.empty())
        {
            return resource;
        }
        std::string data;
        const auto sha1 = utils::io::read_file(file, &data) ? utils::string::to_lower(utils::cryptography::sha1::compute(data, true)) : std::string{};
        return release_channel::effective_patch_version(resource, record, sha1);
    }
}
