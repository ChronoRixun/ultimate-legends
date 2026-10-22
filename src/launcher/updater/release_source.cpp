#include "std_include.hpp"
#include "release_source.hpp"
#include "release_resolver.hpp"

#include <utils/http.hpp>
#include <utils/logger.hpp>
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>

namespace release_source
{
    namespace
    {
        using release_channel::channel;

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

        release_resolver::http_answer get(const std::string& url)
        {
            const utils::http::headers headers{
                {"Accept", "application/vnd.github+json"},
                {"User-Agent", "ultimate-legends-launcher"},
                {"X-GitHub-Api-Version", "2022-11-28"},
            };
            const auto result = utils::http::get_data(url, {}, headers, {}, 20, 1);
            release_resolver::http_answer answer{};
            if (!result || result->code != CURLE_OK)
            {
                answer.reach_error = result ? curl_easy_strerror(result->code) : "no connection";
                return answer;
            }
            answer.reached = true;
            answer.status = result->response_code;
            answer.body = result->buffer;
            return answer;
        }

        release_resolver::resolver& shared()
        {
            static release_resolver::resolver resolver{{
                get,
                [](const std::string& key)
                {
                    return utils::properties::load(key);
                },
                [](const std::string& key, const std::string& value)
                {
                    utils::properties::store(key, value);
                },
                []
                {
                    return std::chrono::steady_clock::now();
                },
                api_base,
            }};
            return resolver;
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
        auto outcome = shared().resolve(repo, value, required, force);
        if (!outcome.chosen || outcome.from_cache)
        {
            utils::logger::write("release channel: {} ({}): {}{}", repo, release_channel::channel_name(value), outcome.error,
                                 outcome.from_cache ? " - using the last release found, " + outcome.chosen->version : std::string{});
        }
        return outcome;
    }

    std::optional<release_channel::outcome> last(const std::string& repo, const channel value)
    {
        return shared().last(repo, value);
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
