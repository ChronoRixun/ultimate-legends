#pragma once

#include <chrono>
#include <functional>
#include <string>

// The retry policy of the self-update's swap (launcher_update.cpp), apart from the files, so the
// unit tests (src/tests) can run it against a fake clock.
//
// A swap fails while another process holds one of the launcher's files (the previous version's CEF
// helpers for a few seconds, or another program for good); every failed try is rolled back before
// the next one. Both loops are bounded by time, not by a number of tries: a roll back that itself
// has to wait (a scanner holding a file it just saw moved) eats into the swap's budget instead of
// adding to it, so a start gives up after about swap_budget + roll_back_budget whatever happens.
// (With 30 tries of the swap, each followed by up to 30 s of roll back retries, a start could spend
// a quarter of an hour before it carried on: issue #2.)
namespace launcher_update::swap_retry
{
    using clock = std::chrono::steady_clock;

    struct policy
    {
        std::chrono::milliseconds swap_budget{30000};      // keep trying the swap until this has passed
        std::chrono::milliseconds roll_back_budget{30000}; // one roll back may wait this long for held files
        std::chrono::milliseconds pause{1000};             // between tries
    };

    // What the loops need from the outside world: the steps, time, and the log.
    struct hooks
    {
        std::function<bool()> swap;      // one try; false when a rename failed
        std::function<bool()> roll_back; // one try of undoing it; false when something could not move back
        std::function<clock::time_point()> now = [] { return clock::now(); };
        std::function<void(std::chrono::milliseconds)> sleep;
        std::function<void(const std::string&)> log;
    };

    enum class outcome
    {
        installed, // the swap went through
        held,      // still held when the budget ran out; everything was rolled back
        stuck,     // a roll back could not finish: the launcher must not start on half of two versions
    };

    // Tries roll_back until it succeeds or roll_back_budget has passed.
    bool roll_back(const hooks& hooks, const policy& policy = {});

    // Tries the swap until it goes through or swap_budget has passed, rolling back each failed try.
    outcome install(const hooks& hooks, const policy& policy = {});
}
