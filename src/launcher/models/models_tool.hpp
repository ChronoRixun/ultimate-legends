#pragma once

#include "models_args.hpp"

#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

// Runs the character-model tool (legends-models, LAUNCHER-API.md) for the Character models section of
// the X-Men Legends page (app/models-view.js). One run at a time: the launcher starts
// `legends-models <command> --json ...` with its own pipes in a job object that kills the tool and its
// converter processes when the run ends, is cancelled, or the launcher exits; it keeps every JSON line
// of stdout for the page (which reads them from an index, so a long build's events are each delivered
// once) and the last lines of stderr for the launcher log and a failed run's details.
//
// Where the tool comes from: like the X-Men Legends builder, a frozen legends-models.exe in
// <launcher data>\tools\legends-models\<version>\ (tool_install). It is not published yet, so the page
// shows "not installed" until it is; Debug builds can point the xml1 entry's models-tool property at
// any program (tools\dev\fake-legends-models.cmd for the tests).
//
// The tool's inputs are the port's folder (the xml1 entry's install), the MUA1 / MUA2 folders of the
// launcher's mua / mua2 entries when they are set up, and a private work folder under
// <launcher data>\cache\legends-models. It writes only <port>\mods (its own marked folders and
// load-order lines).
namespace models_tool
{
    struct failure
    {
        std::string code; // L_* (the page words it)
        std::string message;
    };

    struct job_snapshot
    {
        int id{};
        std::string command;
        bool active{};
        bool finished{};
        bool cancel_requested{};
        int exit_code = -1; // 130 when cancelled by the launcher
        std::size_t first{};            // the index of lines[0] (older lines were dropped)
        std::vector<std::string> lines; // stdout JSON lines from `from` on
        std::size_t total_lines{};
        std::deque<std::string> stderr_tail;
        std::string start_error;
        double seconds{};
    };

    struct tool_location
    {
        std::filesystem::path exe;
        std::string version;
        bool dev{};
    };

    // The tool to run, or nullopt when it is not installed.
    std::optional<tool_location> find_tool();

    // <launcher data>\cache\legends-models
    std::filesystem::path work_folder();

    // The port folder (the xml1 entry's install) when it holds a finished build.
    std::optional<std::filesystem::path> port_folder();

    // The appearance settings, stored on the xml1 entry: models-mode, models-mirror, models-costumes.
    struct settings
    {
        std::string mode;   // "", off, community, upgraded, xml2, sharpen
        std::string mirror; // "" = the default mirror
        std::map<std::string, std::string> costumes;
    };
    settings read_settings();
    bool write_settings(const settings& settings, std::string& error);

    // The default community mirror (our GitHub release, once it exists; empty until then: the
    // author's links only).
    std::string default_mirror();

    // A run of `request.command` with the launcher's own inputs filled in (port, work, MUA1/MUA2,
    // the stored mirror). nullopt with `error` when it can't start.
    std::optional<int> start(models_args::request request, failure& error);

    // The run `id` with its stdout lines from index `from` on.
    std::optional<job_snapshot> job(int id, std::size_t from);

    // The newest run (any state), without its lines.
    std::optional<job_snapshot> last();

    bool cancel(int id);

    // A run is active (the X-Men Legends builder and the Mods tab's writes wait for it).
    bool busy();

    struct installed_folder
    {
        std::string folder;
        bool listed{};
        bool enabled{};
        bool has_credits{};
        models_args::marker marker;
    };

    // The legends-models folders in <port>\mods (by their markers) and their load-order state,
    // read only (nothing is reconciled or written).
    std::vector<installed_folder> installed(const std::filesystem::path& port);

    // CREDITS.md of each legends-models folder of `group` (all groups when empty), de-duplicated.
    std::vector<std::pair<std::string, std::string>> credits(const std::filesystem::path& port, const std::string& group);
}
