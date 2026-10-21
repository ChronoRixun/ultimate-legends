#include "std_include.hpp"
#include "test.hpp"

#include "fix/online_launch.hpp"
#include "fix/online_status.hpp"

#include <fstream>
#include <map>
#include <stdexcept>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

// The order of a game start of the X-Men Legends port (fix/online_launch.hpp): every way a Host / Join start
// can be refused, cancelled or fail leaves none of the four launch-owned [Online] keys armed and the builder's
// keys untouched; a start that reaches the process keeps them for the XML2 Fix; normal starts still start after
// a failed update. The steps are fakes that record what was done, in order, and an ini held as a map.
namespace
{
    using online_launch::update_result;
    using online_rules::mode;

    struct fake
    {
        std::map<std::string, std::string> ini{{"Broker", "broker.example:7777"}, {"BrokerPin", std::string(64, 'a')},
                                               {"GameVersion", "LC33"}, {"ContentFingerprint", "f00d"}, {"Route", "relay"}};
        bool barrier_free = true;
        bool barrier_held = false;
        bool offline = false;
        bool running = false;
        bool test_mode = false;
        std::optional<std::string> fix_version = std::string("1.8.0");
        bool update_replaces_fix = false; // the update leaves fix_after_update (nullopt: no DLL)
        std::optional<std::string> fix_after_update{};
        bool status_file = true;
        bool status_locked = false;
        bool write_fails = false;
        bool remove_fails = false;
        update_result update = update_result::done;
        online_launch::process_result process{true, false, {}};
        bool process_throws = false;
        std::vector<std::string> log;

        online_launch::steps steps()
        {
            online_launch::steps s{};
            s.offline = [this] { return offline; };
            s.take_barrier = [this]
            {
                log.push_back("barrier");
                if (!barrier_free || barrier_held)
                {
                    return false;
                }
                barrier_held = true;
                return true;
            };
            s.release_barrier = [this]
            {
                log.push_back("release");
                barrier_held = false;
            };
            s.game_running = [this] { return running; };
            s.test_mode_on = [this] { return test_mode; };
            s.fix_version = [this] { return fix_version; };
            s.clear_status = [this](std::string& error)
            {
                log.push_back("clear-status");
                if (status_locked)
                {
                    error = "online-status.json could not be deleted (in use).";
                    return false;
                }
                status_file = false;
                return true;
            };
            s.present = [this]
            {
                std::vector<std::string> keys;
                for (const auto& key : online_rules::keys())
                {
                    if (ini.contains(key))
                    {
                        keys.push_back(key);
                    }
                }
                return keys;
            };
            s.write = [this](const std::vector<online_rules::change>& changes, std::string& error)
            {
                const auto removing = std::all_of(changes.begin(), changes.end(), [](const online_rules::change& c) { return !c.value; });
                log.push_back(removing ? "disarm" : "arm");
                if (removing ? remove_fails : write_fails)
                {
                    error = "xml2-fix.ini is read-only.";
                    return false;
                }
                for (const auto& change : changes)
                {
                    if (!online_rules::known(change.key))
                    {
                        log.push_back("builder key written: " + change.key);
                    }
                    if (change.value)
                    {
                        ini[change.key] = *change.value;
                    }
                    else
                    {
                        ini.erase(change.key);
                    }
                }
                return true;
            };
            s.update = [this](std::string& error)
            {
                log.push_back("update");
                if (update == update_result::failed)
                {
                    error = "hash mismatch";
                }
                if (update_replaces_fix)
                {
                    fix_version = fix_after_update;
                }
                return update;
            };
            s.start_process = [this]
            {
                log.push_back("process");
                if (process_throws)
                {
                    throw std::runtime_error("CreateProcess threw");
                }
                return process;
            };
            return s;
        }

        bool armed() const
        {
            return std::any_of(online_rules::keys().begin(), online_rules::keys().end(), [this](const std::string& key) { return ini.contains(key); });
        }

        bool builder_keys_kept() const
        {
            return ini.at("Broker") == "broker.example:7777" && ini.at("BrokerPin") == std::string(64, 'a') && ini.at("GameVersion") == "LC33" &&
                   ini.at("ContentFingerprint") == "f00d" && ini.at("Route") == "relay";
        }

        bool wrote_builder_key() const
        {
            return std::any_of(log.begin(), log.end(), [](const std::string& entry) { return entry.starts_with("builder key written"); });
        }
    };

    online_launch::request host_request(const bool is_public = false, const std::string& name = {})
    {
        online_launch::request request{};
        request.mode = mode::host;
        request.host.is_public = is_public;
        request.host.room_name = name;
        return request;
    }

    online_launch::request join_request(const std::string& code = "ABCD2345")
    {
        online_launch::request request{};
        request.mode = mode::join;
        request.code = code;
        return request;
    }

    // accept(), then finish() when it was accepted.
    online_launch::result start(fake& f, const online_launch::request& request)
    {
        const auto accepted = online_launch::accept(request, f.steps());
        if (!accepted.ok)
        {
            return accepted;
        }
        return online_launch::finish(request, f.steps());
    }

    // Stale keys from an earlier start that never ran (another launcher, a crash).
    void stale_keys(fake& f)
    {
        f.ini["JoinCode"] = "ZZZZ9999";
        f.ini["Host"] = "broker";
        f.ini["Public"] = "1";
        f.ini["RoomName"] = "old";
    }
}

TEST(the_fix_online_play_needs_is_1_8_0)
{
    CHECK(online_launch::required_fix == "1.8.0");
    CHECK(online_launch::check_fix(std::string("1.8.0")) == online_launch::fix_state::ok);
    CHECK(online_launch::check_fix(std::string("1.8.0.3")) == online_launch::fix_state::ok);
    CHECK(online_launch::check_fix(std::string("1.8.1")) == online_launch::fix_state::ok);
    CHECK(online_launch::check_fix(std::string("1.10.0")) == online_launch::fix_state::ok);
    CHECK(online_launch::check_fix(std::string("2.0.0")) == online_launch::fix_state::ok);
    CHECK(online_launch::check_fix(std::string("1.7.1")) == online_launch::fix_state::old);
    CHECK(online_launch::check_fix(std::string("1.7.9")) == online_launch::fix_state::old);
    CHECK(online_launch::check_fix(std::string("0.9.0")) == online_launch::fix_state::old);
    CHECK(online_launch::check_fix(std::string("")) == online_launch::fix_state::unknown);
    CHECK(online_launch::check_fix(std::string("beta")) == online_launch::fix_state::unknown);
    CHECK(online_launch::check_fix(std::string("1.8.0-rc1")) == online_launch::fix_state::unknown);
    CHECK(online_launch::check_fix(std::nullopt) == online_launch::fix_state::missing);
    CHECK(std::string(online_launch::fix_state_name(online_launch::fix_state::ok)) == "ok");
    CHECK(std::string(online_launch::fix_state_name(online_launch::fix_state::old)) == "old");
    CHECK(std::string(online_launch::fix_state_name(online_launch::fix_state::unknown)) == "unknown");
    CHECK(std::string(online_launch::fix_state_name(online_launch::fix_state::missing)) == "missing");
}

TEST(a_host_start_arms_its_keys_right_before_the_process_and_keeps_them)
{
    fake f;
    f.ini["JoinCode"] = "ZZZZ9999";
    const auto result = start(f, host_request(true, "Saturday"));
    CHECK(result.ok);
    CHECK(f.log == std::vector<std::string>({"barrier", "clear-status", "update", "arm", "process"}));
    CHECK(f.ini.at("Host") == "broker");
    CHECK(f.ini.at("Public") == "1");
    CHECK(f.ini.at("RoomName") == "Saturday");
    CHECK(!f.ini.contains("JoinCode"));
    CHECK(f.builder_keys_kept() && !f.wrote_builder_key());
    CHECK(!f.status_file);
    CHECK(f.barrier_held); // the exit watchdog's now
}

TEST(a_join_start_arms_join_code_only)
{
    fake f;
    stale_keys(f);
    const auto result = start(f, join_request("WXYZ6789"));
    CHECK(result.ok);
    CHECK(f.ini.at("JoinCode") == "WXYZ6789");
    CHECK(!f.ini.contains("Host") && !f.ini.contains("Public") && !f.ini.contains("RoomName"));
    CHECK(f.builder_keys_kept());
}

TEST(a_rejected_barrier_writes_and_removes_nothing)
{
    // Another start owns the barrier, and may have armed the keys a moment ago: they stay its.
    fake f;
    f.barrier_free = false;
    f.ini["Host"] = "broker";
    for (const auto& request : {host_request(), join_request(), online_launch::request{}})
    {
        f.log.clear();
        const auto result = start(f, request);
        CHECK(!result.ok && result.reason == "already_running");
        CHECK(f.log == std::vector<std::string>({"barrier"}));
        CHECK(f.ini.at("Host") == "broker");
        CHECK(f.status_file);
    }
}

TEST(offline_mode_refuses_an_online_start_before_anything)
{
    fake f;
    f.offline = true;
    const auto result = start(f, host_request());
    CHECK(!result.ok && result.reason == "offline");
    CHECK(f.log.empty());
    CHECK(!f.armed());
    // Play still works offline.
    CHECK(start(f, {}).ok);
}

TEST(a_running_game_is_left_alone)
{
    fake f;
    f.running = true;
    f.ini["Host"] = "broker";
    const auto result = start(f, join_request());
    CHECK(!result.ok && result.reason == "running");
    CHECK(f.log == std::vector<std::string>({"barrier", "release"}));
    CHECK(f.ini.at("Host") == "broker");
    CHECK(!f.barrier_held);
}

TEST(refusals_under_the_barrier_leave_no_keys_armed)
{
    // Test mode on, no DLL, a status file that can't be deleted: refused before the update, the stale keys of an
    // earlier start removed, the barrier released.
    {
        fake f;
        stale_keys(f);
        f.test_mode = true;
        const auto result = start(f, host_request());
        CHECK(!result.ok && result.reason == "test_mode_on");
        CHECK(!f.armed() && f.builder_keys_kept() && !f.barrier_held);
        CHECK(f.log == std::vector<std::string>({"barrier", "disarm", "release"}));
    }
    {
        fake f;
        stale_keys(f);
        f.fix_version = std::nullopt;
        const auto result = start(f, join_request());
        CHECK(!result.ok && result.reason == "no_fix");
        CHECK(!f.armed() && !f.barrier_held);
    }
    {
        fake f;
        stale_keys(f);
        f.status_locked = true;
        const auto result = start(f, host_request());
        CHECK(!result.ok && result.reason == "status_locked");
        CHECK(result.error.find("could not be deleted") != std::string::npos);
        CHECK(!f.armed() && !f.barrier_held);
        CHECK(std::find(f.log.begin(), f.log.end(), "arm") == f.log.end());
        CHECK(std::find(f.log.begin(), f.log.end(), "update") == f.log.end());
    }
}

TEST(a_stale_status_file_that_cant_be_deleted_refuses_play_too)
{
    fake f;
    f.status_locked = true;
    const auto result = start(f, {});
    CHECK(!result.ok && result.reason == "status_locked");
    CHECK(std::find(f.log.begin(), f.log.end(), "process") == f.log.end());
    CHECK(!f.barrier_held);
    // Deletable again: Play starts.
    f.status_locked = false;
    f.log.clear();
    CHECK(start(f, {}).ok);
    CHECK(!f.status_file);
}

TEST(play_removes_the_four_keys_and_the_status_before_the_update)
{
    fake f;
    stale_keys(f);
    const auto result = start(f, {});
    CHECK(result.ok);
    CHECK(f.log == std::vector<std::string>({"barrier", "disarm", "clear-status", "update", "process"}));
    CHECK(!f.armed() && f.builder_keys_kept() && !f.wrote_builder_key());
    // A file without them is not written at all.
    fake g;
    CHECK(start(g, {}).ok);
    CHECK(g.log == std::vector<std::string>({"barrier", "clear-status", "update", "process"}));
    // And a removal that fails refuses Play, as before.
    fake h;
    stale_keys(h);
    h.remove_fails = true;
    const auto refused = start(h, {});
    CHECK(!refused.ok && refused.reason == "write_failed" && !h.barrier_held);
}

TEST(an_old_or_unreadable_fix_after_the_update_refuses_the_online_start)
{
    for (const auto& [version, reason] : std::vector<std::pair<std::optional<std::string>, std::string>>{
             {std::string("1.7.1"), "fix_too_old"}, {std::string(""), "fix_unknown"}, {std::nullopt, "no_fix"}})
    {
        for (const auto update : {update_result::done, update_result::skipped, update_result::unreachable})
        {
            fake f;
            stale_keys(f);
            f.fix_version = std::string("1.7.1"); // accepted: the update may still bring it up to date
            f.update_replaces_fix = true;
            f.fix_after_update = version;
            f.update = update;
            const auto result = start(f, host_request());
            CHECK(!result.ok && result.reason == reason);
            CHECK(!f.armed() && f.builder_keys_kept());
            CHECK(std::find(f.log.begin(), f.log.end(), "process") == f.log.end());
            CHECK(std::find(f.log.begin(), f.log.end(), "arm") == f.log.end());
            CHECK(!f.barrier_held);
        }
    }
}

TEST(the_update_bringing_the_fix_to_1_8_0_lets_the_online_start_go_on)
{
    fake f;
    f.fix_version = std::string("1.7.1");
    f.update_replaces_fix = true;
    f.fix_after_update = std::string("1.8.0");
    CHECK(start(f, join_request()).ok);
    CHECK(f.ini.at("JoinCode") == "ABCD2345");
    // A newer one too.
    fake g;
    g.fix_version = std::string("1.9.2");
    CHECK(start(g, host_request()).ok);
}

TEST(a_skipped_update_starts_online_only_with_a_current_fix)
{
    fake f;
    f.update = update_result::skipped;
    CHECK(start(f, host_request()).ok);
    fake g;
    g.update = update_result::skipped;
    g.fix_version = std::string("1.7.1");
    const auto result = start(g, host_request());
    CHECK(!result.ok && result.reason == "fix_too_old" && !g.armed());
}

TEST(a_cancelled_or_failed_update_never_falls_through_to_an_online_start)
{
    {
        fake f;
        stale_keys(f);
        f.update = update_result::cancelled;
        const auto result = start(f, host_request());
        CHECK(!result.ok && result.reason == "update_cancelled");
        CHECK(!f.armed() && !f.barrier_held);
        CHECK(std::find(f.log.begin(), f.log.end(), "process") == f.log.end());
    }
    {
        fake f;
        f.update = update_result::failed;
        const auto result = start(f, join_request());
        CHECK(!result.ok && result.reason == "update_failed" && result.error == "hash mismatch");
        CHECK(!f.armed() && !f.barrier_held);
        CHECK(std::find(f.log.begin(), f.log.end(), "process") == f.log.end());
    }
}

TEST(a_normal_start_still_starts_after_a_failed_update_but_not_a_cancelled_one)
{
    fake f;
    f.update = update_result::failed;
    CHECK(start(f, {}).ok);
    CHECK(f.log.back() == "process");
    fake g;
    g.update = update_result::cancelled;
    const auto result = start(g, {});
    CHECK(!result.ok && result.reason == "update_cancelled" && !g.barrier_held);
    CHECK(g.log.back() == "release");
}

TEST(a_failed_or_cancelled_process_disarms_the_keys_it_armed)
{
    {
        fake f;
        f.process = {false, false, "Failed to launch XMen2.exe. Error code: 5"};
        const auto result = start(f, host_request(true, "Saturday"));
        CHECK(!result.ok && result.reason == "launch_failed" && result.error.find("Error code: 5") != std::string::npos);
        CHECK(!f.armed() && f.builder_keys_kept() && !f.barrier_held);
        CHECK(f.log == std::vector<std::string>({"barrier", "clear-status", "update", "arm", "process", "disarm", "release"}));
        CHECK(result.cleanup_error.empty());
    }
    {
        fake f;
        f.process = {false, true, "X-Men Legends requires administrator permission to launch."};
        const auto result = start(f, join_request());
        CHECK(!result.ok && result.reason == "launch_cancelled");
        CHECK(!f.armed() && !f.barrier_held);
    }
    {
        fake f;
        f.process_throws = true;
        const auto result = start(f, join_request());
        CHECK(!result.ok && result.reason == "launch_failed" && result.error == "CreateProcess threw");
        CHECK(!f.armed() && !f.barrier_held);
    }
}

TEST(a_failed_arm_or_disarm_is_reported)
{
    {
        fake f;
        f.write_fails = true;
        const auto result = start(f, host_request());
        CHECK(!result.ok && result.reason == "write_failed" && result.error == "xml2-fix.ini is read-only.");
        CHECK(std::find(f.log.begin(), f.log.end(), "process") == f.log.end());
        CHECK(!f.barrier_held);
    }
    {
        // The process failed and the keys can't be removed: said, so the page can tell the player.
        fake f;
        f.process = {false, false, "Error code: 2"};
        f.remove_fails = true;
        const auto result = start(f, host_request());
        CHECK(!result.ok && result.reason == "launch_failed");
        CHECK(result.cleanup_error == "xml2-fix.ini is read-only.");
        CHECK(!f.barrier_held);
    }
}

TEST(close_on_launch_closes_the_launcher_after_a_normal_start_only)
{
    CHECK(online_launch::close_after_start(true, mode::normal));
    CHECK(!online_launch::close_after_start(false, mode::normal));
    CHECK(!online_launch::close_after_start(true, mode::host));
    CHECK(!online_launch::close_after_start(true, mode::join));
    CHECK(!online_launch::close_after_start(false, mode::host));
}

// ---- online-status.json on disk ----

namespace
{
    std::filesystem::path scratch_folder(const char* name)
    {
        const auto folder = std::filesystem::temp_directory_path() / ("ul-online-status-" + std::string(name));
        std::error_code ec;
        std::filesystem::remove_all(folder, ec);
        std::filesystem::create_directories(folder);
        return folder;
    }

    void write_status(const std::filesystem::path& folder)
    {
        std::ofstream(online_status::path(folder), std::ios::binary) << R"({"v":1,"role":"host","state":"room","code":"ABCD2345"})";
    }
}

TEST(a_missing_status_file_is_nothing_to_delete)
{
    const auto folder = scratch_folder("missing");
    std::string error;
    CHECK(online_status::clear(folder, error));
    CHECK(error.empty());
    CHECK(!online_status::read(folder));
    std::filesystem::remove_all(folder);
}

TEST(a_status_file_is_read_and_deleted)
{
    const auto folder = scratch_folder("present");
    write_status(folder);
    CHECK(online_status::read(folder) == std::string(R"({"v":1,"role":"host","state":"room","code":"ABCD2345"})"));
    std::string error;
    CHECK(online_status::clear(folder, error));
    CHECK(!std::filesystem::exists(online_status::path(folder)));
    CHECK(!online_status::read(folder));
    std::filesystem::remove_all(folder);
}

#ifdef _WIN32
// The case that let an earlier room survive Play: a program holds the file open with read sharing but no delete
// sharing. clear() reports it (and the start is refused); once the handle closes, it deletes.
TEST(a_status_file_held_without_delete_sharing_is_reported_not_ignored)
{
    const auto folder = scratch_folder("held");
    write_status(folder);
    const auto handle = CreateFileW(online_status::path(folder).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
    CHECK(handle != INVALID_HANDLE_VALUE);
    std::string error;
    CHECK(!online_status::clear(folder, error, 2, std::chrono::milliseconds(10)));
    CHECK(error.find("online-status.json could not be deleted") != std::string::npos);
    CHECK(std::filesystem::exists(online_status::path(folder)));
    CHECK(online_status::read(folder).has_value()); // still readable: it would have been taken for a live room

    CloseHandle(handle);
    error.clear();
    CHECK(online_status::clear(folder, error));
    CHECK(!std::filesystem::exists(online_status::path(folder)));
    std::filesystem::remove_all(folder);
}
#endif
