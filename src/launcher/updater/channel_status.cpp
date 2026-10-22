#include "std_include.hpp"
#include "channel_status.hpp"
#include "launcher_update.hpp"
#include "patch_channel.hpp"
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

        // The fix in a game's folder, when the game has one set up.
        std::optional<std::string> fix_version(const char* game)
        {
            const auto config = game_config::get_game_config(game);
            const auto folder = config ? config->get_install_path() : std::nullopt;
            if (!config || !folder || folder->empty())
            {
                return std::nullopt;
            }
            return patch_channel::installed_version(*config, *folder);
        }

        void add_item(rapidjson::Value& items, const char* id, const char* game, const std::string& installed, const channel current,
                      rapidjson::Document::AllocatorType& allocator, const bool dev = false)
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
            item.AddMember("ahead", !dev && release_channel::is_ahead_of(installed, stable.version), allocator);
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
            add_item(items, "fix", "xml2", *xml2_fix, current, allocator);
        }
        if (xml1_fix)
        {
            add_item(items, "fix", "xml1", *xml1_fix, current, allocator);
        }
        if (!builder.empty())
        {
            add_item(items, "builder", nullptr, builder, current, allocator);
        }
        out.AddMember("items", items, allocator);
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

    switch_back_result switch_back(const std::vector<std::string>& items)
    {
        switch_back_result result{};
        if (release_source::current_channel() != channel::stable)
        {
            return result;
        }
        const auto wants = [&](const char* id)
        {
            return std::find(items.begin(), items.end(), id) != items.end();
        };

        std::string stable_fix;
        {
            std::lock_guard lock(mutex_);
            if (const auto it = found_.find("fix|stable"); it != found_.end())
            {
                stable_fix = it->second.version;
            }
        }

        if (wants("launcher"))
        {
            result.launcher = launcher_update::start_download(true);
        }
        if (wants("fix"))
        {
            for (const auto* game : {"xml2", "xml1"})
            {
                const auto installed = fix_version(game);
                if (installed && release_channel::is_ahead_of(*installed, stable_fix))
                {
                    patch_channel::allow_downgrade(*game_config::get_game_config(game));
                    result.fix_games.emplace_back(game);
                }
            }
        }
        if (wants("builder"))
        {
            result.builder = xml1_port::check_builder(true, std::nullopt, true);
        }
        utils::logger::write("update channel: switch back to Stable (launcher {}, builder {}, fix in {} folder(s))", result.launcher,
                             result.builder, result.fix_games.size());
        return result;
    }
}
