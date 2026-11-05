#pragma once
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <string_view>
#include "muac/setup_cleanup.hpp"

namespace artwork {
    inline constexpr size_t max_bytes = 20 * 1024 * 1024;
    inline bool game_id(std::string_view game) {
        return game == "mua" || game == "mua2" || game == "xml2" || game == "muac" || game == "xml1";
    }
    inline bool kind_id(std::string_view kind) { return kind == "capsule" || kind == "hero" || kind == "icon"; }
    inline std::string image_type(std::string_view bytes) {
        if (bytes.empty() || bytes.size() > max_bytes) return {};
        if (bytes.starts_with(std::string_view("\x89PNG\r\n\x1a\n", 8))) return "png";
        if (bytes.size() >= 3 && bytes.substr(0, 3) == std::string_view("\xff\xd8\xff", 3)) return "jpg";
        if (bytes.size() >= 12 && bytes.substr(0, 4) == "RIFF" && bytes.substr(8, 4) == "WEBP") return "webp";
        return {};
    }
    inline bool record_id(std::string_view record) {
        const auto dot = record.find('.');
        if (dot == std::string_view::npos || dot == 0 || dot > 32) return false;
        if (record.substr(0, dot).find_first_not_of("0123456789abcdef") != std::string_view::npos) return false;
        const auto ext = record.substr(dot + 1);
        return ext == "png" || ext == "jpg" || ext == "webp";
    }
    // Construct paths only from fixed IDs and opaque records, never from a saved absolute path.
    // Refuse junctions/symlinks on the file, inside the art tree and at the launcher root itself.
    // Folders ABOVE the launcher root may be linked: under Proton every Z:\ Linux mount (Z:\home)
    // reads as one, which made artwork impossible there; on Windows a linked parent folder.
    inline std::optional<std::filesystem::path> managed_path(const std::filesystem::path& root,
        std::string_view game, std::string_view kind, std::string_view record) {
        if (!root.is_absolute() || root == root.root_path() || !game_id(game) || !kind_id(kind) || !record_id(record)) return {};
        for (const auto& part : root) if (part == "." || part == ".." || part.native().find(typename std::filesystem::path::value_type{}) != std::filesystem::path::string_type::npos) return {};
        const auto path = root / "user" / "art" / game / (std::string(kind) + "-" + std::string(record));
        std::error_code ec;
        for (auto part = path; !part.empty();) {
            if (muac_setup::cleanup::linked(part, ec) || ec) return {};
            if (part == root) break;
            const auto parent = part.parent_path();
            if (parent == part) break;
            part = parent;
        }
        return path;
    }
    inline std::optional<std::string> read_image(const std::filesystem::path& path) {
        std::ifstream file(path, std::ios::binary | std::ios::ate);
        if (!file) return {};
        const auto size = file.tellg();
        if (size <= 0 || size > static_cast<std::streamoff>(max_bytes)) return {};
        std::string bytes(static_cast<size_t>(size), '\0');
        file.seekg(0);
        if (!file.read(bytes.data(), size) || image_type(bytes).empty()) return {};
        return bytes;
    }
    inline bool remove_image(const std::filesystem::path& root, std::string_view game,
        std::string_view kind, std::string_view record) {
        const auto path = managed_path(root, game, kind, record);
        if (!path) return false;
        std::error_code ec;
        if (!std::filesystem::exists(*path, ec)) return !ec;
        if (!std::filesystem::is_regular_file(*path, ec) || ec) return false;
        std::filesystem::remove(*path, ec);
        return !ec;
    }
    inline bool write_image(const std::filesystem::path& root, std::string_view game,
        std::string_view kind, const std::string& record, std::string_view bytes) {
        const auto type = image_type(bytes);
        if (type.empty() || !record.ends_with("." + type)) return false;
        const auto path = managed_path(root, game, kind, record);
        const auto stage_record = "0" + record;
        const auto stage = managed_path(root, game, kind, stage_record);
        if (!path || !stage) return false;
        try {
            // Every selection gets a new name. Never truncate an existing managed copy.
            if (std::filesystem::exists(*path) || std::filesystem::exists(*stage)) return false;
            std::filesystem::create_directories(path->parent_path());
            if (!managed_path(root, game, kind, stage_record)) return false;
            std::ofstream file(*stage, std::ios::binary | std::ios::trunc);
            file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
            file.close();
            if (!file || !managed_path(root, game, kind, record)) {
                remove_image(root, game, kind, stage_record); return false;
            }
#ifdef _WIN32
            const bool renamed = MoveFileExW(stage->c_str(), path->c_str(), MOVEFILE_WRITE_THROUGH) != FALSE;
#else
            std::error_code ec;
            std::filesystem::rename(*stage, *path, ec);
            const bool renamed = !ec;
#endif
            if (!renamed) remove_image(root, game, kind, stage_record);
            return renamed;
        } catch (...) { remove_image(root, game, kind, stage_record); return false; }
    }
}
