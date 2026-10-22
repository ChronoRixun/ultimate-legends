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
        constexpr auto downgrade_ok = "patch-downgrade-ok";

        source by_tag(const game_config::game_config_t& config, const release_channel::release& chosen)
        {
            const auto manifest = release_source::file_url(config.patch_repo, chosen, manifest_name);
            return {manifest, manifest.substr(0, manifest.rfind('/') + 1), chosen.version, {}};
        }

        source as_configured(const game_config::game_config_t& config)
        {
            return {config.update_manifest_url, config.update_folder_url, {}, {}};
        }

        source keep(const std::string& note)
        {
            utils::logger::write("XML2 Fix update: {}", note);
            return {{}, {}, {}, note};
        }
    }

    source resolve(const game_config::game_config_t& config, const std::filesystem::path& folder)
    {
        // No repository (the MUA Controller Fix), or a Debug build's local stand-in for the patch.
        if (config.patch_repo.empty() || config.update_manifest_url != release_channel::latest_download_url(config.patch_repo, manifest_name))
        {
            return as_configured(config);
        }

        const auto installed = installed_version(config, folder).value_or("");
        const auto confirmed = config.get(downgrade_ok).value_or("") == "true";
        const auto beta_installed = release_channel::is_prerelease(installed);

        if (release_source::current_channel() == release_channel::channel::stable)
        {
            // As always, unless a beta is in the folder: then only a release at least as new, or the
            // latest one when the player chose to switch back.
            if (!beta_installed)
            {
                return as_configured(config);
            }
            const auto latest = release_source::resolve(config.patch_repo, release_channel::channel::stable, {manifest_name});
            if (!latest.chosen)
            {
                return keep("the beta " + installed + " stays: the latest release can't be checked (" + latest.error + ")");
            }
            if (!release_channel::may_install(installed, latest.chosen->version, confirmed))
            {
                return keep("the beta " + installed + " stays: it is newer than the latest release, " + latest.chosen->version +
                            " (Settings > Update channel offers to switch back)");
            }
            return by_tag(config, *latest.chosen);
        }

        const auto beta = release_source::resolve(config.patch_repo, release_channel::channel::beta, {manifest_name});
        if (!beta.chosen)
        {
            if (beta_installed)
            {
                return keep("the beta " + installed + " stays: the beta channel can't be checked (" + beta.error + ")");
            }
            utils::logger::write("XML2 Fix update: the beta channel can't be checked ({}); the latest release is used", beta.error);
            return as_configured(config);
        }
        if (!release_channel::may_install(installed, beta.chosen->version, false))
        {
            return keep(installed + " stays: the beta channel's release, " + beta.chosen->version + (beta.from_cache ? " (from the last check)" : "") +
                        ", is older");
        }
        return by_tag(config, *beta.chosen);
    }

    void record(const game_config::game_config_t& config, const std::filesystem::path& folder, const std::string& version,
                const std::string& patch_sha1)
    {
        if (config.patch_repo.empty())
        {
            return;
        }
        client_store::write_release(config.game_key, folder, {version, utils::string::to_lower(patch_sha1)});
        config.set(downgrade_ok, "");
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

    void allow_downgrade(const game_config::game_config_t& config)
    {
        config.set(downgrade_ok, "true");
    }
}
