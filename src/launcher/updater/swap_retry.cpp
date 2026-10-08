#include "std_include.hpp"
#include "swap_retry.hpp"

namespace launcher_update::swap_retry
{
    namespace
    {
        long long elapsed_ms(const hooks& hooks, const clock::time_point since)
        {
            return std::chrono::duration_cast<std::chrono::milliseconds>(hooks.now() - since).count();
        }

        void log_line(const hooks& hooks, const std::string& line)
        {
            if (hooks.log)
            {
                hooks.log(line);
            }
        }
    }

    bool roll_back(const hooks& hooks, const policy& policy)
    {
        const auto started = hooks.now();
        for (auto attempt = 1;; ++attempt)
        {
            if (hooks.roll_back())
            {
                if (attempt > 1)
                {
                    log_line(hooks, std::format("roll back done on try {} after {} ms", attempt, elapsed_ms(hooks, started)));
                }
                return true;
            }
            if (hooks.now() - started >= policy.roll_back_budget)
            {
                log_line(hooks, std::format("roll back still failing after {} tries and {} ms; giving up", attempt, elapsed_ms(hooks, started)));
                return false;
            }
            log_line(hooks, std::format("roll back try {} failed ({} ms); retrying", attempt, elapsed_ms(hooks, started)));
            hooks.sleep(policy.pause);
        }
    }

    outcome install(const hooks& hooks, const policy& policy)
    {
        const auto started = hooks.now();
        for (auto attempt = 1;; ++attempt)
        {
            if (hooks.swap())
            {
                log_line(hooks, std::format("swap done on try {} after {} ms", attempt, elapsed_ms(hooks, started)));
                return outcome::installed;
            }
            log_line(hooks, std::format("swap try {} failed ({} ms); rolling it back", attempt, elapsed_ms(hooks, started)));
            if (!roll_back(hooks, policy))
            {
                return outcome::stuck;
            }
            if (hooks.now() - started >= policy.swap_budget)
            {
                log_line(hooks, std::format("files still held after {} tries and {} ms; the update waits", attempt, elapsed_ms(hooks, started)));
                return outcome::held;
            }
            hooks.sleep(policy.pause);
        }
    }
}
