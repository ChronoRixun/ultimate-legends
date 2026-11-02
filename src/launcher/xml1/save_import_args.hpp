#pragma once
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

// Typed requests only; UI text never becomes a shell command. The converter
// independently validates links, source bounds, slot occupancy and preview hashes.
namespace save_import_args
{
    // Deliberate release gate, matching the LC core. Real-save/native/game-lock
    // acceptance is required before changing this at integration.
    constexpr bool player_install_enabled = false;
    struct request
    {
        std::string mode; // inspect | slots | preview | apply | undo
        std::filesystem::path source;
        std::string source_kind = "auto"; // auto | xemu | recomp (LC --source-kind)
        std::string campaign; // opaque in-image path returned by CLI discovery
        std::filesystem::path save_dir;
        int slot = -1;
        bool merge_unlocks{};
        bool allow_inferred{};
        bool confirmed{};
        std::string preview_token;
        std::string transaction_id;
    };
    std::optional<std::vector<std::wstring>> build(const request& request,
        const std::filesystem::path& installed_build, std::string& error);
}
