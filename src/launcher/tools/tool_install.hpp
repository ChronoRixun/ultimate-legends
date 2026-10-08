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
//
// A zip the player already has (downloaded by hand, for a slow or metered connection or when the
// launcher's own download fails) installs the same way: install_from_zip() checks it against the
// same release manifest (its size and SHA-256, before anything is unpacked) and then unpacks and
// places it as install() does. find_local_zip() looks for the release's zip, by its exact name, in
// root() and in the player's Downloads folder.
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

    // A zip the player has, measured against the release's manifest.
    enum class zip_match
    {
        same,       // the release's zip: its size and SHA-256
        older,      // named as an older version than the release ("xml1-builder-0.9.0-win64.zip")
        newer,      // named as a newer version than the release
        other_size, // not the release's zip (an incomplete download?)
        other_hash, // the release's size, not its SHA-256 (damaged, or not the release's file)
    };

    struct zip_facts
    {
        std::string name; // the file's name ("xml1-builder-1.0.0-win64.zip")
        std::uint64_t size{};
        std::string sha256; // lower-case hex; may be empty when the size already differs
    };

    // The version a zip's name gives, by the release's naming: manifest.zip with manifest.version
    // in it ("xml1-builder-1.0.0-win64.zip"); empty when the name doesn't follow it.
    std::string version_in_zip_name(const manifest& manifest, const std::string& name);
    // Only `same` may be installed: the name never overrides the size and the SHA-256.
    zip_match match_zip(const manifest& manifest, const zip_facts& facts);
    // What is wrong with a zip that is not `same`, for the player.
    std::string describe_zip_match(const manifest& manifest, const zip_facts& facts, zip_match match);

    // The first of `candidates` that is the release's zip (match_zip: same), in order; `measure`
    // reads one (nullopt: it could not be read) and `rejected` is told about each one passed over
    // and why. nullopt when none is.
    using measure_zip = std::function<std::optional<zip_facts>(const std::filesystem::path& zip)>;
    using zip_rejected = std::function<void(const std::filesystem::path& zip, const std::string& reason)>;
    std::optional<std::filesystem::path> pick_local_zip(const manifest& manifest, const std::vector<std::filesystem::path>& candidates,
                                                        const measure_zip& measure, const zip_rejected& rejected);

    // The release's zip (manifest.zip, by its exact name) if the player put it in root() or it is in
    // their Downloads folder, checked against `manifest` (size and SHA-256): the first place that has
    // it, in that order. One that doesn't match is logged and the next place is looked at.
    std::optional<std::filesystem::path> find_local_zip(const tool& tool, const manifest& manifest);

    // Checks `zip` against `manifest` (size, then SHA-256) and installs it like install(); the zip
    // itself is only read. nullopt with `error` set on failure; `match` says how the zip compared
    // when it could be read.
    std::optional<installed> install_from_zip(const tool& tool, const manifest& manifest, const std::filesystem::path& zip,
                                              std::optional<zip_match>& match, std::string& error);

    // Deletes every version folder not in `keep`, and leftovers of interrupted installs.
    void prune(const tool& tool, const std::vector<std::string>& keep);

    // Compares dotted versions numerically ("1.10.0" > "1.9.2"); a missing part counts as 0.
    int compare_versions(const std::string& a, const std::string& b);

    // Whether a version string is safe as a folder name (digits, letters, '.', '-', '+', '_').
    bool is_safe_version(const std::string& version);
}
