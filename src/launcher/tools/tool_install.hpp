#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

// Helper programs the launcher downloads and runs, such as the X-Men Legends builder
// (BUILDER_DESIGN.md sections 3.2 and 4.5): a zip published on GitHub releases next to a small
// manifest, installed into <launcher data>\tools\<id>\<version>\.
//
//   xml1-builder.json: {"version": "1.0.0", "content_version": 3, "zip": "xml1-builder-1.0.0-win64.zip",
//                       "size": 20971520, "sha256": "...", "min_launcher": "0.1.0", "requires_xml2fix": ">=1.2.0",
//                       "url": "(optional) where the zip is; default: next to the manifest"}
//
// Installing streams the zip to a staging folder beside the versions (tools\<id>\.staging-*),
// checks its size and SHA-256, unpacks it (archive::extract_zip) and renames the result to
// tools\<id>\<version>\, so a version folder is either complete or absent. Older versions stay
// until the caller prunes them (the builder keeps the previous one until a build with the new one
// has succeeded).
namespace tool_install
{
    struct tool
    {
        std::string id;           // folder name under tools\ ("xml1-builder")
        std::string exe;          // the program inside a version folder ("xml1-builder.exe")
        std::string manifest_url; // the release's manifest (xml1-builder.json)
    };

    struct manifest
    {
        std::string version;
        int content_version{};
        std::string zip;
        std::string url; // the zip's download URL
        std::uint64_t size{};
        std::string sha256; // lower-case hex
        std::string min_launcher;
        std::string requires_xml2fix;
    };

    struct installed
    {
        std::string version;
        std::filesystem::path folder;
        std::filesystem::path exe;
    };

    // <launcher data>\tools\<id>
    std::filesystem::path root(const tool& tool);

    // The installed version to use: `preferred` when it is installed, else the newest one.
    std::optional<installed> find(const tool& tool, const std::string& preferred = {});

    // Every installed version, newest first.
    std::vector<installed> list(const tool& tool);

    // Fetches and checks the manifest; nullopt with `error` set (and `not_published` when the
    // release or the manifest doesn't exist: HTTP 404).
    std::optional<manifest> fetch_manifest(const tool& tool, std::string& error, bool* not_published = nullptr);
    // Parses a manifest (exposed for tests and for manifests read from disk).
    std::optional<manifest> parse_manifest(const std::string& json, const std::string& manifest_url, std::string& error);

    using progress_callback = std::function<void(std::uint64_t done, std::uint64_t total)>;
    using cancel_check = std::function<bool()>;

    // Streams `url` into `file`, computing its SHA-256 (lower-case hex) on the way. `size` is the
    // expected size (0: unknown); a download that differs from it fails. Returns "" on success,
    // "cancelled", or a message for the user. Used by install() and the launcher's self-update.
    std::string download_file(const std::string& url, const std::filesystem::path& file, std::uint64_t size,
                              const progress_callback& progress, const cancel_check& cancelled, std::string& sha256);

    // Downloads, checks and unpacks `manifest` into root\<version>; returns the installed version
    // (at once when that folder is already complete). nullopt with `error` set on failure or cancel.
    std::optional<installed> install(const tool& tool, const manifest& manifest, const progress_callback& progress,
                                     const cancel_check& cancelled, std::string& error);

    // Deletes every version folder not in `keep`, and leftovers of interrupted installs.
    void prune(const tool& tool, const std::vector<std::string>& keep);

    // Compares dotted versions numerically ("1.10.0" > "1.9.2"); a missing part counts as 0.
    int compare_versions(const std::string& a, const std::string& b);

    // Whether a version string is safe as a folder name (digits, letters, '.', '-', '+', '_').
    bool is_safe_version(const std::string& version);
}
