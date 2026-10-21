#pragma once

#include "online_rules.hpp"

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The order of a game start of the X-Men Legends port (the game with launcher-led online play), owned by the
// backend from the click to the process (launch-game, game_commands.cpp), so a start that is refused, cancelled
// or fails never leaves a room request in xml2-fix.ini for a later start from Steam or the exe (the launcher <->
// XML2 Fix contract: Host / Public / RoomName / JoinCode are one-shot).
//
//   accept()  on the command, with the folder held for patch work: the launch barrier taken, then (online) the
//             game not running, test mode off; the stale online-status.json deleted (every start); a normal start
//             also removes the four keys. Nothing of the room is written yet. Refused: the barrier released, and
//             (once it was taken) the four keys removed, so nothing is left armed.
//   finish()  on the worker: the patch update, then (online) the XML2 Fix in the folder checked again - the one
//             that will run, after any update, at least required_fix - and only then the keys written (armed),
//             and the process started. Every way out but a started game removes the four keys again (disarmed)
//             and releases the barrier; a failed removal is reported (cleanup_error).
//
// The barrier is held from the first write to the process start, so no other launcher start can arm or disarm
// the keys in between. The builder's keys (Broker, BrokerPin, GameVersion, ContentFingerprint, Route) are never
// written: `write` gets only online_rules::changes_for's.
//
// Windows-free (the unit tests build it on their own, src/tests/online_launch_tests.cpp): game_commands.cpp
// gives it the real steps.
namespace online_launch
{
    // The first XML2 Fix with broker rooms, Legends Classic 0.3.0's (1.7.x has none). The one number: the
    // Online section shows the one get-online-status sends.
    constexpr std::string_view required_fix = "1.8.0";

    enum class fix_state
    {
        ok,      // required_fix or later
        old,     // older: no rooms
        unknown, // the DLL is there but its version can't be read
        missing, // no DLL
    };

    // `version`: the DLL's file version ("1.8.0"), "" when it has none that can be read, nullopt when there is
    // no DLL.
    fix_state check_fix(const std::optional<std::string>& version);

    // "ok", "old", "unknown", "missing".
    const char* fix_state_name(fix_state state);

    struct request
    {
        online_rules::mode mode{online_rules::mode::normal};
        std::string code{}; // normalised, for join
        online_rules::host_options host{};
    };

    enum class update_result
    {
        done,        // up to date now
        unreachable, // the patch's manifest could not be fetched: the folder is as it was
        skipped,     // the launcher's setting, or -offline
        cancelled,   // the player cancelled it
        failed,      // it threw
    };

    // The patch update as a start sees it (game_commands.cpp gives it client_updater and the progress tracker).
    // The updater returns normally from a cancelled transfer (an aborted download is not an error), so whether the
    // player cancelled is read from `cancelled` - the tracker's flag, kept across the update's phases - after
    // `run` returns, throws or is skipped: a cancel always wins.
    struct update_steps
    {
        bool skip{};                       // the launcher's setting, or -offline
        std::function<bool()> run;         // the updater: true when its manifest was fetched; may throw
        std::function<bool()> cancelled;   // the player cancelled this operation
        std::function<void(bool cancelled)> finished; // the progress bar ends, as cancelled or not
    };
    update_result run_update(const update_steps& steps, std::string& error);

    struct process_result
    {
        bool started{};
        bool cancelled{}; // the UAC prompt declined
        std::string error{};
    };

    // What a start needs from the launcher. Every step is set (game_commands.cpp; the tests' fakes).
    struct steps
    {
        std::function<bool()> offline;
        std::function<bool()> take_barrier;
        std::function<void()> release_barrier;
        std::function<bool()> game_running;
        std::function<bool()> test_mode_on;
        std::function<std::optional<std::string>()> fix_version;
        std::function<bool(std::string& error)> clear_status;
        // Which of online_rules::keys() the [Online] section has now, and writing changes to it.
        std::function<std::vector<std::string>()> present;
        std::function<bool(const std::vector<online_rules::change>& changes, std::string& error)> write;
        std::function<update_result(std::string& error)> update;
        // The player cancelled the start (asked again right before the keys are written and the process starts).
        std::function<bool()> cancelled;
        std::function<process_result()> start_process;
    };

    struct result
    {
        bool ok{};
        // Why not, for the page (online-view.js words each): offline, already_running, running, test_mode_on,
        // status_locked, write_failed, update_cancelled, update_failed, no_fix, fix_too_old, fix_unknown,
        // launch_cancelled, launch_failed.
        std::string reason{};
        std::string error{};         // English, for the log and the details line
        std::string cleanup_error{}; // the four keys could not be removed after the refusal
    };

    result accept(const request& request, const steps& steps);
    result finish(const request& request, const steps& steps);

    // Close on launch (the launcher's setting) closes it after a normal start only: an online start keeps it
    // open, to show and copy the room's code and follow the session. The setting itself stays as it is.
    bool close_after_start(bool setting_on, online_rules::mode mode);
}
