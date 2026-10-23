#include "std_include.hpp"
#include "release_resolver.hpp"

namespace release_resolver
{
    namespace
    {
        using release_channel::channel;

        // A successful answer is reused this long (each start checks the launcher, the fix and the
        // builder; Verify and Play check the fix again).
        constexpr auto reuse_for = std::chrono::minutes(10);

        std::string answer_key(const std::string& repo, const channel value)
        {
            return repo + "|" + release_channel::channel_name(value);
        }
    }

    std::string cache_key(const std::string& repo, const channel value)
    {
        return std::string("release-cache-") + release_channel::channel_name(value) + "-" + repo;
    }

    std::string describe_failure(const http_answer& answer)
    {
        if (!answer.reached)
        {
            return "Could not reach GitHub (" + (answer.reach_error.empty() ? std::string("no connection") : answer.reach_error) + ").";
        }
        if (answer.status == 403 || answer.status == 429)
        {
            return std::format("GitHub's limit on update checks was reached (HTTP {}); it resets within an hour.", answer.status);
        }
        if (answer.status == 404)
        {
            return "No release has been published.";
        }
        if (answer.status != 200)
        {
            return std::format("GitHub answered HTTP {}.", answer.status);
        }
        return {};
    }

    resolver::resolver(io io)
        : io_(std::move(io))
    {
    }

    std::optional<release_channel::release> resolver::fetch(const std::string& repo, const channel value, const std::vector<std::string>& required,
                                                            std::string& error) const
    {
        const auto base = this->io_.api_base() + "/repos/" + repo + "/releases";
        const auto reply = this->io_.get(value == channel::stable ? base + "/latest" : base + "?per_page=30");
        error = describe_failure(reply);
        if (!error.empty())
        {
            return std::nullopt;
        }

        if (value == channel::stable)
        {
            auto latest = release_channel::parse_release_json(reply.body, error);
            if (!latest)
            {
                return std::nullopt;
            }
            if (latest->draft || !release_channel::has_files(*latest, required))
            {
                // A release still being published (its files upload after it is created).
                error = "The latest release (" + latest->version + ") does not have all its files yet.";
                return std::nullopt;
            }
            return latest;
        }

        const auto releases = release_channel::parse_releases_json(reply.body, error);
        if (!error.empty())
        {
            return std::nullopt;
        }
        auto chosen = release_channel::pick(value, releases, required);
        if (!chosen)
        {
            error = "No release with all its files has been published.";
        }
        return chosen;
    }

    release_channel::outcome resolver::resolve(const std::string& repo, const channel value, const std::vector<std::string>& required,
                                               const bool force)
    {
        const auto id = answer_key(repo, value);
        {
            std::lock_guard lock(this->mutex_);
            if (const auto found = this->answers_.find(id); !force && found != this->answers_.end() && found->second.outcome.chosen &&
                                                            !found->second.outcome.from_cache && this->io_.now() - found->second.at < reuse_for)
            {
                return found->second.outcome;
            }
        }

        std::string error;
        auto fetched = this->fetch(repo, value, required, error);
        std::optional<release_channel::release> cached;
        if (fetched)
        {
            this->io_.store(cache_key(repo, value), release_channel::to_json(*fetched));
        }
        else if (const auto stored = this->io_.load(cache_key(repo, value)))
        {
            // Only a choice that still has the files asked for (a cache from an older launcher may not).
            cached = release_channel::release_from_json(*stored);
            if (cached && !release_channel::has_files(*cached, required))
            {
                cached.reset();
            }
        }
        auto outcome = release_channel::settle(std::move(fetched), error, cached);

        std::lock_guard lock(this->mutex_);
        this->answers_[id] = {outcome, this->io_.now()};
        return outcome;
    }

    std::optional<release_channel::outcome> resolver::last(const std::string& repo, const channel value)
    {
        std::lock_guard lock(this->mutex_);
        const auto found = this->answers_.find(answer_key(repo, value));
        return found == this->answers_.end() ? std::nullopt : std::optional(found->second.outcome);
    }
}
