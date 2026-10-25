#pragma once

#include "models_args.hpp"

#include "tools/tool_install.hpp"
#include "updater/release_channel.hpp"

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
// <launcher data>\tools\legends-models\<version>\ (tool_install), installed and updated from the GitHub
// releases of ChronoRixun/legends-models (a zip next to legends-models.json) on the launcher's update
// channel: Stable takes the latest release, Beta pre-releases too (updater/release_source.hpp). The page
// offers Install while there is none and Update when the channel has a newer one; nothing is fetched
// with -offline. Debug builds can point the xml1 entry's models-tool property at any program
// (tools\dev\fake-legends-models.cmd for the tests) and models-manifest at a local manifest.
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

    // The tool's releases: ChronoRixun/legends-models, legends-models.json next to the zip.
    constexpr auto tool_repo = "ChronoRixun/legends-models";
    constexpr auto tool_manifest_name = "legends-models.json";
    constexpr auto tool_manifest_url = "https://github.com/ChronoRixun/legends-models/releases/latest/download/legends-models.json";
    // The protocol the page speaks (LAUNCHER-API.md: every event carries "api": 1). A release whose
    // manifest says another one is not installed.
    constexpr int api_version = 1;
    // The community skins' terms the page shows before the first community download (MODELS_TERMS).
    constexpr auto terms_version = "baconwizard17-1";

    // The tool to run, or nullopt when it is not installed.
    std::optional<tool_location> find_tool();

    // The release check / install of the tool, run in the background (check_tool) and polled by the page.
    struct tool_check_state
    {
        bool checking{};
        bool installing{};
        std::uint64_t done{};
        std::uint64_t total{};
        std::string code;  // L_* when the check or the install failed
        std::string error; // its message
        bool not_published{};
        std::optional<tool_install::manifest> latest; // the channel's release, when it was found
        release_channel::channel channel = release_channel::channel::stable;
        bool from_cache{};   // GitHub could not be asked: `latest` is the channel's last release found
        std::string source;  // where the last install came from: download, zip (one the player had)
        std::string installed_now; // the version the last install put in place
        std::string beta_version;  // Stable with no release yet: the Beta channel's pre-release, if there is one
        bool cancel_requested{};   // cancel_tool_install() was asked during this install
    };

    // Asks the update channel for the tool's release and, with `install`, installs it when there is no
    // tool yet or the release is newer than the installed one (waits for a running tool to finish first).
    // `force` asks GitHub even when a recent answer is at hand (Check again). false when a check or
    // install is already running, or with -offline.
    bool check_tool(bool install, bool force = false);
    tool_check_state tool_check();

    // Stops a running install of the tool (its download, or its wait for a run to finish): the install
    // ends with code L_TOOL_CANCELLED and the installed tool (if any) stays. false when none is running.
    bool cancel_tool_install();

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

    // A costume preview the tool named (scan: costume_info.preview, an absolute PNG path) as a data: URL
    // for the page, only when it is a PNG inside the tool's work folder; nullopt otherwise.
    std::optional<std::string> preview_data(const std::string& path);

    // CREDITS.md of each legends-models folder of `group` (all groups when empty), de-duplicated.
    std::vector<std::pair<std::string, std::string>> credits(const std::filesystem::path& port, const std::string& group);
}
