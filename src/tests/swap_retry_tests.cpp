#include "std_include.hpp"
#include "test.hpp"

#include "updater/swap_retry.hpp"

// The self-update's swap with a held file (issue #2), on a fake clock: every sleep and every
// try's own duration move it, so a run takes no real time and its length can be checked.
namespace
{
    namespace swap_retry = launcher_update::swap_retry;
    using std::chrono::milliseconds;

    struct fake_world
    {
        swap_retry::clock::time_point now{};
        int swaps = 0;
        int roll_backs = 0;
        std::vector<std::string> log;

        swap_retry::hooks hooks(std::function<bool(int)> swap, std::function<bool(int)> roll_back,
                                const milliseconds swap_takes = milliseconds(5), const milliseconds roll_back_takes = milliseconds(5))
        {
            swap_retry::hooks result;
            result.swap = [this, swap, swap_takes]
            {
                now += swap_takes;
                return swap(++swaps);
            };
            result.roll_back = [this, roll_back, roll_back_takes]
            {
                now += roll_back_takes;
                return roll_back(++roll_backs);
            };
            result.now = [this]
            {
                return now;
            };
            result.sleep = [this](const milliseconds pause)
            {
                now += pause;
            };
            result.log = [this](const std::string& line)
            {
                log.push_back(line);
            };
            return result;
        }

        long long seconds() const
        {
            return std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count();
        }

        bool logged(const std::string& text) const
        {
            return std::any_of(log.begin(), log.end(), [&](const std::string& line)
            {
                return line.find(text) != std::string::npos;
            });
        }
    };

    bool always(int)
    {
        return true;
    }

    bool never(int)
    {
        return false;
    }
}

TEST(a_free_swap_goes_through_at_once)
{
    fake_world world;
    CHECK(swap_retry::install(world.hooks(always, always)) == swap_retry::outcome::installed);
    CHECK(world.swaps == 1 && world.roll_backs == 0);
    CHECK(world.logged("swap done on try 1"));
}

TEST(helpers_that_let_go_after_a_few_seconds)
{
    // The previous version's CEF helpers hold its files for a few seconds after it exits.
    fake_world world;
    const auto outcome = swap_retry::install(world.hooks([](const int attempt) { return attempt >= 4; }, always));
    CHECK(outcome == swap_retry::outcome::installed);
    CHECK(world.swaps == 4 && world.roll_backs == 3);
    CHECK(world.seconds() < 5);
}

TEST(a_file_held_for_good_gives_up_after_the_budget)
{
    // Another program keeps data\cef\release\icudtl.dat open: each try fails at once and rolls back.
    fake_world world;
    const auto outcome = swap_retry::install(world.hooks(never, always));
    CHECK(outcome == swap_retry::outcome::held);
    CHECK(world.seconds() >= 30 && world.seconds() <= 32);
    CHECK(world.roll_backs == world.swaps);
    CHECK(world.logged("files still held after"));
}

TEST(slow_roll_backs_do_not_add_up)
{
    // Each failed try's roll back has to wait 10 s (a scanner holding what was just moved). With 30
    // tries, each followed by its own 30 s of roll back retries, this took over 5 minutes; the
    // start now gives up after the swap budget plus at most one roll back.
    fake_world world;
    const auto outcome = swap_retry::install(world.hooks(never, [](const int attempt) { return attempt % 11 == 0; }));
    CHECK(outcome == swap_retry::outcome::held);
    CHECK(world.seconds() <= 30 + 30 + 2);
    CHECK(world.logged("roll back try 1 failed") && world.logged("roll back done on try 11"));
}

TEST(a_roll_back_that_never_finishes_is_stuck_in_bounded_time)
{
    fake_world world;
    const auto outcome = swap_retry::install(world.hooks(never, never));
    CHECK(outcome == swap_retry::outcome::stuck);
    CHECK(world.swaps == 1);
    CHECK(world.seconds() >= 30 && world.seconds() <= 32);
    CHECK(world.logged("giving up"));
}

TEST(slow_tries_count_against_the_budget)
{
    // A try that itself takes long (a scanner slowing every rename) still ends the loop on time.
    fake_world world;
    const auto outcome = swap_retry::install(world.hooks(never, always, milliseconds(20000), milliseconds(20000)));
    CHECK(outcome == swap_retry::outcome::held);
    CHECK(world.swaps == 1 && world.seconds() <= 41);
}

TEST(roll_back_on_its_own)
{
    fake_world world;
    CHECK(swap_retry::roll_back(world.hooks(always, [](const int attempt) { return attempt == 3; })));
    CHECK(world.roll_backs == 3 && world.seconds() == 2);

    fake_world stuck;
    CHECK(!swap_retry::roll_back(stuck.hooks(always, never)));
    CHECK(stuck.seconds() >= 30 && stuck.seconds() <= 31);
}
