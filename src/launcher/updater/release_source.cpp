#include "std_include.hpp"
#include "release_source.hpp"

#include <utils/http.hpp>
#include <utils/logger.hpp>
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>

#include <map>

namespace release_source
{
    namespace
    {
        using release_channel::channel;

        // A successful answer is reused this long (each start checks the launcher, the fix and the
        // builder; Verify and Play check the fix again).
        constexpr auto reuse_for = std::chrono::minutes(10);

        struct answer
        {
            release_channel::outcome outcome;
            std::chrono::steady_clock::time_point at;
        };

        std::mutex mutex_;
        std::map<std::string, answer> answers_; // by "<repo>|<channel>"

        std::string key(const std::string& repo, const channel value)
        {
            return repo + "|" + release_channel::channel_name(value);
        }

        std::string cache_property(const std::string& repo, const channel value)
        {
            return std::string("release-cache-") + release_channel::channel_name(value) + "-" + repo;
        }

        std::string api_base()
        {
#ifdef _DEBUG
            // Debug builds only (the CDP tests): a local server standing in for api.github.com.
            if (const auto base = utils::properties::load(property_keys::DEV_RELEASE_API); base && !base->empty())
            {
                return *base;
            }
#endif
            return "https://api.github.com";
        }

        std::optional<std::string> get(const std::string& url, std::string& error)
        {
            const utils::http::headers headers{
                {"Accept", "application/vnd.github+json"},
                {"User-Agent", "ultimate-legends-launcher"},
                {"X-GitHub-Api-Version", "2022-11-28"},
            };
            const auto result = utils::http::get_data(url, {}, headers, {}, 20, 1);
            if (!result || result->code != CURLE_OK)
            {
                error = std::format("Could not reach GitHub ({}).", result ? curl_easy_strerror(result->code) : "no connection");
                return std::nullopt;
            }
            if (result->response_code == 403 || result->response_code == 429)
            {
                error = std::format("GitHub's limit on update checks was reached (HTTP {}); it resets within an hour.", result->response_code);
                return std::nullopt;
            }
            if (result->response_code == 404)
            {
                error = "No release has been published.";
                return std::nullopt;
            }
            if (result->response_code != 200)
            {
                error = std::format("GitHub answered HTTP {}.", result->response_code);
                return std::nullopt;
            }
            return result->buffer;
        }

        std::optional<release_channel::release> fetch(const std::string& repo, const channel value, const std::vector<std::string>& required,
                                                      std::string& error)
        {
            const auto base = api_base() + "/repos/" + repo + "/releases";
            if (value == channel::stable)
            {
                const auto body = get(base + "/latest", error);
                return body ? release_channel::parse_release_json(*body, error) : std::nullopt;
            }

            const auto body = get(base + "?per_page=30", error);
            if (!body)
            {
                return std::nullopt;
            }
            const auto releases = release_channel::parse_releases_json(*body, error);
            if (!error.empty())
            {
                return std::nullopt;
            }
            auto chosen = release_channel::pick(value, releases, required);
            if (!chosen)
            {
                error = "No release has been published.";
            }
            return chosen;
        }
    }

    channel current_channel()
    {
        return release_channel::parse_channel(utils::properties::load(property_keys::UPDATE_CHANNEL).value_or(""));
    }

    void set_channel(const channel value)
    {
        utils::properties::store(property_keys::UPDATE_CHANNEL, release_channel::channel_name(value));
    }

    release_channel::outcome resolve(const std::string& repo, const channel value, const std::vector<std::string>& required, const bool force)
    {
        const auto id = key(repo, value);
        {
            std::lock_guard lock(mutex_);
            if (const auto found = answers_.find(id); !force && found != answers_.end() && found->second.outcome.chosen &&
                                                       !found->second.outcome.from_cache &&
                                                       std::chrono::steady_clock::now() - found->second.at < reuse_for)
            {
                return found->second.outcome;
            }
        }

        std::string error;
        auto fetched = fetch(repo, value, required, error);
        std::optional<release_channel::release> cached;
        if (value == channel::beta)
        {
            if (fetched)
            {
                utils::properties::store(cache_property(repo, value), release_channel::to_json(*fetched));
            }
            else
            {
                cached = release_channel::release_from_json(utils::properties::load(cache_property(repo, value)).value_or(""));
            }
        }
        auto outcome = release_channel::settle(std::move(fetched), error, cached);
        if (!outcome.chosen || outcome.from_cache)
        {
            utils::logger::write("release channel: {} ({}): {}{}", repo, release_channel::channel_name(value), outcome.error,
                                 outcome.from_cache ? " - using the last release found, " + outcome.chosen->version : std::string{});
        }

        std::lock_guard lock(mutex_);
        answers_[id] = {outcome, std::chrono::steady_clock::now()};
        return outcome;
    }

    std::optional<release_channel::outcome> last(const std::string& repo, const channel value)
    {
        std::lock_guard lock(mutex_);
        const auto found = answers_.find(key(repo, value));
        return found == answers_.end() ? std::nullopt : std::optional(found->second.outcome);
    }

    std::string file_url(const std::string& repo, const release_channel::release& chosen, const std::string& file)
    {
#ifdef _DEBUG
        if (const auto* const asset = chosen.find(file); asset && (asset->url.starts_with("http://127.0.0.1:") || asset->url.starts_with("http://localhost:")))
        {
            return asset->url; // the test's local server
        }
#endif
        return release_channel::download_url(repo, chosen.tag, file);
    }
}
