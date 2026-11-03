#include "std_include.hpp"
#include "test.hpp"
#include "updater/channel_refresh.hpp"

// Exercises the same gate used by the asynchronous component workers and build admission.
// Removing invalidation, old-result rejection, or success-only readiness breaks these cases.
TEST(channel_refresh_rejects_old_workers_and_queues_the_selected_channel_both_ways)
{
    for (const auto first : {release_channel::channel::stable, release_channel::channel::beta})
    {
        const auto next = first == release_channel::channel::stable ? release_channel::channel::beta : release_channel::channel::stable;
        channel_refresh::gate gate;
        const auto old = gate.begin(first);
        CHECK(old.has_value());
        gate.invalidate();
        CHECK(!gate.current(*old));
        CHECK(!gate.begin(next)); // old worker owns the slot until its final line
        CHECK(!gate.ready(next)); // a build immediately after the switch is refused
        CHECK(gate.finish(*old, true)); // completion requests another check, never publishes the old result
        CHECK(!gate.ready(first));
        CHECK(gate.busy()); // polling must survive the handoff before the new worker begins
        const auto fresh = gate.begin(next);
        CHECK(fresh.has_value());
        CHECK(!gate.finish(*fresh, true));
        CHECK(gate.ready(next));
        CHECK(!gate.ready(first));
    }
}

TEST(channel_refresh_failed_feed_never_makes_a_stale_builder_ready)
{
    channel_refresh::gate gate;
    auto check = gate.begin(release_channel::channel::stable);
    gate.finish(*check, true);
    CHECK(gate.ready(release_channel::channel::stable));
    gate.invalidate();
    check = gate.begin(release_channel::channel::beta);
    CHECK(!gate.finish(*check, false));
    CHECK(!gate.ready(release_channel::channel::beta));
    CHECK(!gate.ready(release_channel::channel::stable));
    check = gate.begin(release_channel::channel::beta);
    gate.finish(*check, true); // successful retry, including a valid same-channel offline cache
    CHECK(gate.ready(release_channel::channel::beta));
}

TEST(channel_refresh_self_update_restart_requires_a_new_check_of_the_persisted_channel)
{
    channel_refresh::gate restarted;
    CHECK(!restarted.ready(release_channel::channel::beta));
    const auto startup = restarted.begin(release_channel::channel::beta);
    CHECK(!restarted.ready(release_channel::channel::beta));
    restarted.finish(*startup, true);
    CHECK(restarted.ready(release_channel::channel::beta));
}

TEST(channel_refresh_rapid_round_trip_does_not_accept_the_original_stable_worker)
{
    channel_refresh::gate gate;
    const auto first = gate.begin(release_channel::channel::stable);
    gate.invalidate(); // Beta
    gate.invalidate(); // Stable again, before the first Stable fetch returned
    CHECK(!gate.current(*first));
    CHECK(gate.finish(*first, true));
    CHECK(!gate.ready(release_channel::channel::stable));
    const auto last = gate.begin(release_channel::channel::stable);
    gate.finish(*last, true);
    CHECK(gate.ready(release_channel::channel::stable));
}

TEST(offline_build_admission_uses_the_selected_channel_cache_without_a_startup_worker)
{
    channel_refresh::gate restarted;
    CHECK(channel_refresh::builder_ready(restarted, release_channel::channel::stable, "0.4.0", "0.4.0", true));
    CHECK(channel_refresh::builder_ready(restarted, release_channel::channel::beta, "0.6.0-beta.1", "0.6.0-beta.1", true));
    CHECK(!channel_refresh::builder_ready(restarted, release_channel::channel::beta, "0.4.0", "0.6.0-beta.1", true));
    CHECK(!channel_refresh::builder_ready(restarted, release_channel::channel::beta, "0.4.0", "", true));
    // Preserve the existing keep-beta policy when Stable's selected release is older.
    CHECK(channel_refresh::builder_ready(restarted, release_channel::channel::stable, "0.6.0-beta.1", "0.4.0", true));
    // Online, a matching version still cannot bypass an unresolved/invalidated check.
    CHECK(!channel_refresh::builder_ready(restarted, release_channel::channel::stable, "0.4.0", "0.4.0", false));
}
