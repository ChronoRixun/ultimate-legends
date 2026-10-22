#include "std_include.hpp"
#include "channel_status.hpp"
#include "launcher_update.hpp"
#include "patch_channel.hpp"
#include "patch_policy.hpp"
#include "release_source.hpp"

#include "game_config.hpp"
#include "xml1/xml1_port.hpp"

#include <utils/flags.hpp>
#include <utils/logger.hpp>

#include <map>
#include <thread>

namespace channel_status
{
    namespace
    {
        using release_channel::channel;

        struct repo_spec
        {
            const char* id;
            const char* repo;
            std::vector<std::string> required;
        };

        const std::vector<repo_spec>& repos()
        {
            static const std::vector<repo_spec> list{
                {"launcher", release_source::launcher_repo, {"ultimate-legends-{version}-win64-portable.zip", "SHA256SUMS.txt"}},
                {"fix", release_source::xml2_fix_repo, {"ultimate-legends.json"}},
                {"builder", release_source::builder_repo, {xml1_port::builder_manifest_name}},
            };
            return list;
        }

        struct found
        {
            std::string version;
            bool from_cache{};
            std::string error;
        };

        std::mutex mutex_;
        bool checking_{};
        std::map<std::string, found> found_; // by "<id>|<channel>"

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        // The fix in a game's folder, when the game has one set up (and whether its version is the
        // launcher's install record or only the DLL's numeric VERSIONINFO).
        std::optional<patch_channel::installed_state> fix_version(const char* game)
        {
            const auto config = game_config::get_game_config(game);
            const auto folder = config ? config->get_install_path() : std::nullopt;
            if (!config || !folder || folder->empty())
            {
                return std::nullopt;
            }
            const auto state = patch_channel::installed_fix(*config, *folder);
            return state.version ? std::optional(state) : std::nullopt;
        }

        void add_item(rapidjson::Value& items, const char* id, const char* game, const std::string& installed, const channel current,
                      rapidjson::Document::AllocatorType& allocator, const bool dev = false, const bool recorded = true)
        {
            const auto get = [&](const channel value) -> found
            {
                const auto it = found_.find(std::string(id) + "|" + release_channel::channel_name(value));
                return it == found_.end() ? found{} : it->second;
            };
            const auto stable = get(channel::stable);
            const auto beta = get(channel::beta);
            const auto& mine = current == channel::beta ? beta : stable;

            rapidjson::Value item(rapidjson::kObjectType);
            item.AddMember("id", rapidjson::StringRef(id), allocator);
            if (game)
            {
                item.AddMember("game", rapidjson::StringRef(game), allocator);
            }
            item.AddMember("installed", make_string(installed, allocator), allocator);
            item.AddMember("dev", dev, allocator); // a development build of the launcher: it never updates
            item.AddMember("prerelease", release_channel::is_prerelease(installed), allocator);
            item.AddMember("stable", make_string(stable.version, allocator), allocator);
            item.AddMember("beta", make_string(current == channel::beta ? beta.version : std::string{}, allocator), allocator);
            // A recorded beta newer than the latest release, or a fix with no install record whose numbers
            // are (a hand-copied 1.8.0 test kit): Switch back to Stable is offered for either.
            item.AddMember("ahead", !dev && patch_policy::offers_switch_back(installed, recorded, stable.version), allocator);
            item.AddMember("fromCache", mine.from_cache, allocator);
            item.AddMember("error", make_string(mine.error, allocator), allocator);
            items.PushBack(item, allocator);
        }
    }

    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
    {
        const auto current = release_source::current_channel();
        // Read before the lock: the fix's version reads its DLL.
        const auto launcher = launcher_update::running_version();
        const auto launcher_dev = launcher_update::installed_version().empty();
        const auto xml2_fix = fix_version("xml2");
        const auto xml1_fix = fix_version("xml1");
        const auto builder = xml1_port::installed_builder_version();

        out.SetObject();
        out.AddMember("channel", rapidjson::StringRef(release_channel::channel_name(current)), allocator);
        out.AddMember("offline", utils::flags::has_flag("offline"), allocator);

        std::lock_guard lock(mutex_);
        out.AddMember("checking", checking_, allocator);
        rapidjson::Value items(rapidjson::kArrayType);
        add_item(items, "launcher", nullptr, launcher, current, allocator, launcher_dev);
        if (xml2_fix)
        {
            add_item(items, "fix", "xml2", *xml2_fix->version, current, allocator, false, xml2_fix->recorded);
        }
        if (xml1_fix)
        {
            add_item(items, "fix", "xml1", *xml1_fix->version, current, allocator, false, xml1_fix->recorded);
        }
        if (!builder.empty())
        {
            add_item(items, "builder", nullptr, builder, current, allocator);
        }
        out.AddMember("items", items, allocator);

        // What GitHub said for each repository on the current channel, installed or not (a first check
        // that failed with no earlier result is said too): {id, version, fromCache, error}.
        rapidjson::Value checked(rapidjson::kArrayType);
        for (const auto& spec : repos())
        {
            const auto it = found_.find(std::string(spec.id) + "|" + release_channel::channel_name(current));
            if (it == found_.end())
            {
                continue;
            }
            rapidjson::Value repo(rapidjson::kObjectType);
            repo.AddMember("id", rapidjson::StringRef(spec.id), allocator);
            repo.AddMember("version", make_string(it->second.version, allocator), allocator);
            repo.AddMember("fromCache", it->second.from_cache, allocator);
            repo.AddMember("error", make_string(it->second.error, allocator), allocator);
            checked.PushBack(repo, allocator);
        }
        out.AddMember("repos", checked, allocator);
    }

    void refresh()
    {
        if (utils::flags::has_flag("offline"))
        {
            return;
        }
        {
            std::lock_guard lock(mutex_);
            if (checking_)
            {
                return;
            }
            checking_ = true;
        }

        std::thread([]
        {
            const auto current = release_source::current_channel();
            std::vector<channel> channels{channel::stable};
            if (current == channel::beta)
            {
                channels.push_back(channel::beta);
            }
            std::map<std::string, found> results;
            for (const auto& spec : repos())
            {
                for (const auto value : channels)
                {
                    const auto outcome = release_source::resolve(spec.repo, value, spec.required);
                    results[std::string(spec.id) + "|" + release_channel::channel_name(value)] =
                        found{outcome.chosen ? outcome.chosen->version : std::string{}, outcome.from_cache, outcome.error};
                }
            }

            std::lock_guard lock(mutex_);
            for (auto& [key, value] : results)
            {
                found_[key] = std::move(value);
            }
            checking_ = false;
        }).detach();
    }

    void set_channel(const std::string& value)
    {
        const auto next = release_channel::parse_channel(value);
        const auto before = release_source::current_channel();
        release_source::set_channel(next);
        if (next != before)
        {
            utils::logger::write("update channel: {} -> {}", release_channel::channel_name(before), release_channel::channel_name(next));
            launcher_update::channel_changed();
        }
        refresh();
    }

    switch_back_result switch_back(const std::string& launcher_to, const std::string& builder_to)
    {
        switch_back_result result{};
        if (release_source::current_channel() != channel::stable)
        {
            return result;
        }
        // Each approved for exactly the version the player was shown, and for this attempt only: the
        // fix's goes with each folder's Verify (verify-game { downgrade }).
        if (!launcher_to.empty())
        {
            result.launcher = launcher_update::start_download(launcher_to);
        }
        if (!builder_to.empty())
        {
            result.builder = xml1_port::check_builder(true, std::nullopt, builder_to);
        }
        utils::logger::write("update channel: switch back to Stable (launcher {} -> {}, builder {} -> {})", launcher_to.empty() ? "-" : launcher_to,
                             result.launcher, builder_to.empty() ? "-" : builder_to, result.builder);
        return result;
    }

    void keep_beta()
    {
        // Keep the beta: nothing approved earlier and still pending may switch back.
        launcher_update::revoke_downgrade();
        utils::logger::write("update channel: the player kept the beta");
    }
}
