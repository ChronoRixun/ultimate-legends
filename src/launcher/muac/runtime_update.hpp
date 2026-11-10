#pragma once
#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>
#include "platform.hpp"

namespace muac::runtime {
    inline constexpr auto pending_message = "The last MUA Classic Fix update didn't finish. Choose Update to finish it.";
    inline constexpr auto file_in_use_message = "A MUA Classic Fix file is in use. Close the game or any program using it and try Update again.";
    // Resolve only the selected directory; guard() still rejects links within the tree.
    std::filesystem::path resolve_game_folder(const std::filesystem::path& path);
    struct file {
        std::string source, target;
        std::uint64_t size{};
        std::string sha256;
    };
    struct package {
        std::string version;
        std::vector<file> files;
        std::string graphics_url, graphics_sha256, dll_sha256;
        std::uint64_t graphics_size{}, dll_size{};
    };
    // Only the offline setup package's fixed runtime allowlist is accepted.
    package parse_package(const std::string& json, const std::string& expected_version);
    std::optional<std::string> record_version(const std::string& json, const std::string& dll_sha256 = {});
    bool newer_compatible(const std::string& installed, const std::string& latest,
                          const std::string& minimum, const std::string& launcher, bool wine_migration = false, bool repair = false);
    bool needs_wine_migration(const std::filesystem::path& folder, bool wine = platform::is_wine());
    std::string read_file(const std::filesystem::path& path, std::uint64_t maximum = 128 * 1024 * 1024);
    // For read-only status checks (version record, recovery state): no link guard, size-capped.
    std::string read_status_file(const std::filesystem::path& path, std::uint64_t maximum = 128 * 1024 * 1024);
    // No links, junctions, alternate streams or lexical traversal in any ancestor.
    void guard(const std::filesystem::path& path);
    using hash_function = std::function<std::string(const std::string&)>;
    using recovery_log = std::function<void(const std::string&)>;
    struct controls {
        bool wine = platform::is_wine();
        std::function<bool()> running = [] { return false; };
        std::function<bool()> cancelled = [] { return false; };
        // Filesystem fault injection for transaction regressions; unset in production.
        std::function<void(const std::string&)> before_replace;
        // Called with the destination, same-directory temporary file, and whether
        // publication completed. Tests can interrupt without unwinding the transaction.
        std::function<void(const std::filesystem::path&, const std::filesystem::path&, bool)> on_write;
        recovery_log log;
    };
    // Recovery is performed before preparing another update. A journal remains if
    // rollback cannot finish, so a retry can restore the original files.
    void recover(const std::filesystem::path& game, const recovery_log& log = {});
    bool recovery_pending(const std::filesystem::path& game);
    void update(const std::filesystem::path& game, const std::filesystem::path& bundle,
                const package& manifest, const std::string& graphics_dll,
                const hash_function& hash, const controls& control = {});
}
