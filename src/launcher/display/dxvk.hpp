#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The optional Vulkan renderer of the XML2-engine games (X-Men Legends II and the X-Men Legends port):
// DXVK's 32-bit d3d8.dll and d3d9.dll next to the game's XMen2.exe. Never bundled: the player opts in on
// the game's page and the launcher downloads ONE pinned official release (pinned(): the URL, size and
// SHA-256 of DXVK 3.1.1's dxvk-3.1.1.tar.gz on github.com/doitsujin/dxvk, and the SHA-256 of the two
// files taken from it - the ones the 0.7 graphics tests ran). Nothing from the archive is used unless
// the archive and each file match the pin.
//
// Which files are "ours" is decided by content alone: a d3d8.dll / d3d9.dll in the game folder whose
// SHA-256 is the pinned one. Anything else under those names (another wrapper, a hand-copied DXVK) is
// the player's: never replaced, never removed. Installing writes beside the target and renames; removing
// deletes only our files. No Windows, CEF or network in here: the unit tests build it on their own
// (src/tests/dxvk_tests.cpp) and inject the download.
namespace dxvk
{
    struct pinned_file
    {
        std::string member;   // path inside the archive ("dxvk-3.1.1/x32/d3d8.dll")
        std::wstring name;    // name next to the game's exe (L"d3d8.dll")
        std::uint64_t size{};
        std::string sha256;   // lower-case hex
    };

    struct release
    {
        std::string version;  // "3.1.1"
        std::string url;      // the official release asset
        std::string archive;  // its file name, also the name it is kept under in the cache
        std::uint64_t size{};
        std::string sha256;   // lower-case hex
        std::vector<pinned_file> files;
    };

    // DXVK 3.1.1 (O:/Projects/agent-work/dxvk-pin/v3.1.1/PIN.md): the only release the launcher installs.
    const release& pinned();

    std::string sha256_file(const std::filesystem::path& file);

    // The archive in the cache is the pinned one (size, then SHA-256).
    bool archive_valid(const std::filesystem::path& archive, const release& release);

    // The pinned members of a .tar.gz, by exact path (a leading "./" is accepted), each checked against
    // its pinned size and SHA-256. Bounded: at most 256 MB unpacked; nothing is written to disk.
    std::optional<std::map<std::string, std::string>> extract(std::string_view gzip, const release& release, std::string& error);
    std::optional<std::map<std::string, std::string>> extract_file(const std::filesystem::path& archive, const release& release, std::string& error);

    enum class files_state
    {
        none,    // neither file is in the folder
        ours,    // both files, each the pinned one
        partial, // some of the pinned files, the others absent
        foreign, // a file under one of the names that is not the pinned one
    };

    const char* to_string(files_state state);
    files_state inspect(const std::filesystem::path& game_dir, const release& release);

    // Puts `contents` (from extract) next to the game. Refuses when a foreign file is there. "" on success.
    std::string install(const std::filesystem::path& game_dir, const release& release, const std::map<std::string, std::string>& contents);

    // Deletes the pinned files from the folder; a foreign file under the same name stays. "" on success.
    std::string remove(const std::filesystem::path& game_dir, const release& release);

    // The download, as the launcher does it (tool_install::download_file): `url` into `file`, `size`
    // expected, the SHA-256 of what arrived in `sha256`; "" on success, "cancelled" or a message.
    using download_fn = std::function<std::string(const std::string& url, const std::filesystem::path& file,
                                                   std::uint64_t size, std::string& sha256)>;

    struct enable_steps
    {
        download_fn download;
        std::function<void(const std::string& phase)> phase; // "download", "verify", "install"
        std::function<bool()> cancelled;
        bool offline{};
    };

    // Turns DXVK on for `game_dir`: the pinned archive from `cache` (downloaded into it first when it is
    // missing or not the pinned one; a download that doesn't match is deleted), then its two files checked
    // and installed. "" on success, "cancelled", or a message for the player.
    std::string enable(const std::filesystem::path& game_dir, const std::filesystem::path& cache, const release& release,
                       const enable_steps& steps);
}
