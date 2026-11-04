#pragma once
#include <filesystem>
#include <string>
#include <system_error>
#include "platform.hpp"
#include <cstdint>
#ifdef _WIN32
#include <Windows.h>
#endif

namespace muac_setup::cleanup {
    // Shared with the helper's synthetic mount fixtures: only Wine drive roots
    // and directory mount tags resolving to themselves receive an exemption.
    inline bool allowed_wine_reparse(bool wine, bool drive_root, bool directory,
                                      std::uint32_t tag, bool resolves_to_self) {
        return wine && (drive_root || (directory && tag == 0xA0000003 && resolves_to_self));
    }
    // Strictly one reported direct child, never a sibling, glob, alias or output
    // itself. Keep lexical checks separate so untrusted '..' is never normalized
    // into an otherwise permitted path.
    inline bool lexical_stage(const std::filesystem::path& output, const std::filesystem::path& stage) {
        if (!output.is_absolute() || !stage.is_absolute() || output == output.root_path()) return false;
        for (const auto& path : {output, stage}) {
            if (path.native().find(typename std::filesystem::path::value_type{}) != std::filesystem::path::string_type::npos) return false;
            for (const auto& part : path) if (part == "." || part == "..") return false;
        }
        const auto name = stage.filename().string();
        constexpr auto prefix = ".muac-stage-";
        if (!name.starts_with(prefix) || name.size() <= std::char_traits<char>::length(prefix) ||
            name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.") != std::string::npos) return false;
        auto chosen = output.lexically_normal();
        if (chosen.filename().empty()) chosen = chosen.parent_path();
        return stage.parent_path().lexically_normal() == chosen;
    }

    inline bool linked(const std::filesystem::path& path, std::error_code& ec) {
#ifdef _WIN32
        const auto attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            const auto error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) ec = std::error_code(error, std::system_category());
            return false;
        }
        if (!(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
        if (!muac::platform::is_wine()) return true;
        const auto drive = path.root_name().native();
        const bool drive_root = path == path.root_path() && drive.size() == 2 && drive[1] == L':';
        if (drive_root) return false;
        if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) return true;
        const auto tagged = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (tagged == INVALID_HANDLE_VALUE) { ec = std::error_code(GetLastError(), std::system_category()); return true; }
        FILE_ATTRIBUTE_TAG_INFO info{};
        const bool queried = GetFileInformationByHandleEx(tagged, FileAttributeTagInfo, &info, sizeof(info)) != FALSE;
        const auto tag_error = GetLastError(); CloseHandle(tagged);
        if (!queried) { ec = std::error_code(tag_error, std::system_category()); return true; }
        if (info.ReparseTag != 0xA0000003) return true;
        const auto resolved = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS, nullptr);
        if (resolved == INVALID_HANDLE_VALUE) { ec = std::error_code(GetLastError(), std::system_category()); return true; }
        const auto length = GetFinalPathNameByHandleW(resolved, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        std::wstring final(length, L'\0');
        const auto written = length ? GetFinalPathNameByHandleW(resolved, final.data(), length, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) : 0;
        const auto final_error = GetLastError(); CloseHandle(resolved);
        if (!written || written >= length) { ec = std::error_code(final_error ? final_error : ERROR_INVALID_NAME, std::system_category()); return true; }
        final.resize(written);
        if (final.starts_with(L"\\\\?\\UNC\\")) final = L"\\\\" + final.substr(8);
        else if (final.starts_with(L"\\\\?\\")) final.erase(0, 4);
        const auto chosen = path.lexically_normal().native();
        const bool same = CompareStringOrdinal(chosen.c_str(), -1, final.c_str(), -1, TRUE) == CSTR_EQUAL;
        return !allowed_wine_reparse(true, false, true, info.ReparseTag, same);
#else
        const auto status = std::filesystem::symlink_status(path, ec);
        if (ec == std::errc::no_such_file_or_directory) ec.clear();
        return std::filesystem::is_symlink(status);
#endif
    }

    inline bool safe_stage(const std::filesystem::path& output, const std::filesystem::path& stage, std::error_code& ec) {
        ec.clear();
        if (!lexical_stage(output, stage)) return false;
        for (auto part = stage; !part.empty();) {
            if (linked(part, ec) || ec) return false;
            const auto parent = part.parent_path();
            if (parent == part) break;
            part = parent;
        }
        if (!std::filesystem::exists(stage, ec)) return !ec; // Helper already removed it.
        if (ec || !std::filesystem::is_directory(stage, ec) || ec) return false;
        // Refuse junctions and symlinks anywhere in the reported tree too. Do
        // not follow directory links when scanning or when removing the stage.
        for (std::filesystem::recursive_directory_iterator it(stage, ec), end; !ec && it != end; it.increment(ec)) {
            if (linked(it->path(), ec) || ec) return false;
        }
        return !ec;
    }

    inline bool remove_stage(const std::filesystem::path& output, const std::filesystem::path& stage, std::error_code& ec) {
        if (!safe_stage(output, stage, ec)) {
            if (!ec) ec = std::make_error_code(std::errc::permission_denied);
            return false;
        }
        std::filesystem::remove_all(stage, ec);
        return !ec;
    }
}
