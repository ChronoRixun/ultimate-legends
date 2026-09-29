#pragma once

#include "builder_process.hpp"
#include "tools/tool_install.hpp"

#include <filesystem>
#include <optional>
#include <string>

// The X-Men Legends library entry (game key "xml1"): a community port that the player's PC builds
// from their own Xbox disc image and their X-Men Legends II install, with xml1-builder
// (BUILDER_DESIGN.md sections 2 and 4). The launcher installs the builder from its GitHub release
// (tools/tool_install.hpp), runs it (builder_process.hpp) and shows its progress; it never builds,
// patches or deletes game files itself. After a build the existing patch path (verify-game)
// installs the XML2 Fix into the built folder, as for XML2.
//
// Runs are identified by id: queries (info, verify) can run side by side; one "work" run at a time
// (build or clean) owns the output folder. Everything is polled by the UI, like mod imports.
namespace xml1_port
{
    constexpr auto game_key = "xml1";

    // Where the builder's release lives. The repo name is the design's working name (Q7).
    constexpr auto builder_manifest_url = "https://github.com/ChronoRixun/legends-classic/releases/latest/download/xml1-builder.json";

    // A launcher-side failure, before or instead of a builder run: L_* codes (the UI translates them).
    struct failure
    {
        std::string code;
        std::string message;
    };

    struct build_options
    {
        std::filesystem::path iso;
        std::filesystem::path out;
        bool movies = true;
        bool keep_cache = true;
        bool link_base = false;
    };

    // Start a builder run; the id to poll with job(), or nullopt with `error`.
    std::optional<int> start_info(const std::optional<std::filesystem::path>& iso, const std::optional<std::filesystem::path>& out,
                                  failure& error);
    std::optional<int> start_verify(failure& error);
    std::optional<int> start_build(const build_options& options, failure& error);
    // Deletes the build (builder clean): the registered files, the synced base files and _build;
    // mods only with `mods`; the build cache of its disc with `cache`. After it, the launcher
    // removes the fix's own files it left (xml2-fix.ini / .log) and the folder when empty.
    std::optional<int> start_clean(bool mods, bool cache, failure& error);
    // Deletes the build cache only (keeps the game).
    std::optional<int> start_free_cache(failure& error);

    bool cancel_build();

    std::optional<xml1::builder_snapshot> job(int id);
    // The last build or clean run (the one a page shows), if any.
    std::optional<xml1::builder_snapshot> last_work();
    // A build or clean is running: the port must not start, and nothing else may write its folder.
    bool is_working();

    // Fetches the builder's manifest in the background and, with `install`, installs it when it is
    // missing or older. Progress and errors show in write_status().
    void check_builder(bool install);

    // Everything the X-Men Legends page and the setup wizard show, as one JSON object.
    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator);

    // A finished build is in `folder`: its stamp is there and no build is under way or broken off
    // (_build\building.json, design 2.7), so the port may start from it.
    bool is_playable(const std::filesystem::path& folder);

    // What a folder holds, as a destination for a build. launcher_only: only what the launcher and
    // the player own (dinput.dll, xml2-fix.*, mods\ - the builder never touches them), so nothing
    // is built there and the builder accepts it (its `info` and `verify` call it "absent").
    struct folder_facts
    {
        bool exists{};
        bool empty{};
        bool builder{};       // _build\stamp.json or _build\building.json: the builder made it
        bool launcher_only{};
    };
    folder_facts inspect_folder(const std::filesystem::path& folder);

    // What "Report a problem" offers (design 4.7): the last verification (_build\verify-report.json:
    // relative paths, sizes, hashes, codes - no game content) and the end of the build log. Raw:
    // the page masks profile paths before anything leaves the PC.
    struct report_sources
    {
        std::optional<std::string> verify_report;
        std::optional<std::filesystem::path> verify_report_path;
        std::vector<std::string> log_tail;
        std::optional<std::filesystem::path> log_path;
    };
    report_sources read_report_sources(std::size_t log_lines);
    // Saves a report the player can attach to an issue: <launcher data>\reports\xml1-report-<time>.txt.
    std::optional<std::filesystem::path> save_report(const std::string& text, std::string& error);

    // Bytes in the built game's folder and in the build cache (nullopt when there is none), for
    // the uninstall dialog.
    struct sizes
    {
        std::optional<std::uint64_t> game;
        std::optional<std::uint64_t> cache;
    };
    sizes disk_usage();

    // The builder's latest log: <out>\_build\builder.log, else the newest one in the cache's logs
    // folder (a run that failed before the output folder existed).
    std::optional<std::filesystem::path> build_log();

    // The folder the setup suggests: "X-Men Legends (Port)" next to the XML2 install.
    std::optional<std::filesystem::path> default_output();
    // Free bytes on the volume holding `path` (or its nearest existing parent).
    std::optional<std::uint64_t> free_space(const std::filesystem::path& path);
}
