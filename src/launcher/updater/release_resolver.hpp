#pragma once

#include "release_channel.hpp"

#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

// The update channel's discovery for one repository and channel, shared by the three update paths
// (release_source.hpp gives it the real network and the launcher's properties; the unit tests give it
// doubles):
//
//   Stable  GET <api>/repos/<repo>/releases/latest - a release with every `required` file
//   Beta    GET <api>/repos/<repo>/releases?per_page=30 - release_channel::pick
//
// A valid choice is kept per repository and channel (`store`); when GitHub can't be asked or gives no
// usable answer (no connection, its rate limit, an error, a latest release still uploading its files),
// the last valid choice of the same repository and channel is used and the outcome says why
// (from_cache, error). The other channel's choice never is. A cached choice is only metadata: what it
// names is downloaded and checked like any other. An answer is reused for a few minutes unless `force`.
namespace release_resolver
{
    struct http_answer
    {
        bool reached{};           // false: no connection (`reach_error` says why)
        std::string reach_error;
        unsigned status{};        // the HTTP status when reached
        std::string body;
    };

    struct io
    {
        std::function<http_answer(const std::string& url)> get;
        std::function<std::optional<std::string>(const std::string& key)> load;
        std::function<void(const std::string& key, const std::string& value)> store;
        std::function<std::chrono::steady_clock::time_point()> now;
        std::function<std::string()> api_base; // "https://api.github.com"
    };

    // The property a channel's last valid choice of `repo` is kept under.
    std::string cache_key(const std::string& repo, release_channel::channel channel);

    // Why GitHub's answer can't be used, for the player ("" when it can: HTTP 200).
    std::string describe_failure(const http_answer& answer);

    class resolver
    {
    public:
        explicit resolver(io io);

        release_channel::outcome resolve(const std::string& repo, release_channel::channel channel, const std::vector<std::string>& required,
                                         bool force = false);

        // The last outcome for `repo` and `channel` this run, without asking GitHub.
        std::optional<release_channel::outcome> last(const std::string& repo, release_channel::channel channel);

    private:
        struct kept_answer
        {
            release_channel::outcome outcome;
            std::chrono::steady_clock::time_point at;
        };

        std::optional<release_channel::release> fetch(const std::string& repo, release_channel::channel channel,
                                                      const std::vector<std::string>& required, std::string& error) const;

        io io_;
        std::mutex mutex_;
        std::map<std::string, kept_answer> answers_; // by "<repo>|<channel>"
    };
}
