#include "test.hpp"
#include "muac/setup_admission.hpp"
#include "muac/setup_cleanup.hpp"
#include <fstream>
#include <algorithm>
#include <chrono>

namespace {
    constexpr auto complete = R"({"ok":true,"exit":0,"prepared":true,"files_complete":true,"install":"fixture"})";
    auto key(const std::string& value) { return std::wstring(value.begin(), value.end()); }
    bool ready(int exit = 0, bool process_cancelled = false, bool killed = false, bool cancelled = false,
               std::string_view json = complete) {
        return muac_setup::admission::ready(exit, process_cancelled, killed, cancelled, json, L"fixture", key);
    }
}
TEST(muac_setup_checks_actual_process_exit_despite_stdout_success) {
    CHECK(ready(muac_setup::admission::process_exit(0, false)));
    CHECK(!ready(muac_setup::admission::process_exit(7, false)));
    CHECK(!ready(muac_setup::admission::process_exit(0, true)));
    CHECK(!ready(0, false, true));
}
TEST(muac_setup_cancel_between_promotion_and_registration_refuses_admission) {
    CHECK(ready()); // The complete folder/result can exist before cancellation.
    CHECK(!ready(0, false, false, true)); // Recheck under the registration lock.
    CHECK(!ready(0, true));
}
TEST(muac_setup_requires_matching_path_and_complete_typed_result) {
    CHECK(!ready(0, false, false, false, R"({"ok":true,"prepared":true,"files_complete":true,"install":"other"})"));
    CHECK(!ready(0, false, false, false, R"({"ok":true,"prepared":true,"files_complete":true,"install":"fixture\u0000other"})"));
    CHECK(!ready(0, false, false, false, R"({"ok":true,"prepared":"true","files_complete":true,"install":"fixture"})"));
    CHECK(!ready(0, false, false, false, R"({"ok":true,"install":"fixture"})"));
    CHECK(!ready(0, false, false, false, "broken"));
}

TEST(muac_cleanup_requires_one_exact_direct_child) {
    const auto output = std::filesystem::absolute("synthetic-output");
    using muac_setup::cleanup::lexical_stage;
    CHECK(lexical_stage(output, output / ".muac-stage-abc_123"));
    CHECK(lexical_stage(output / "", output / ".muac-stage-abc_123"));
    for (const auto& path : {output, output.parent_path() / ".muac-stage-abc",
            output / "nested" / ".muac-stage-abc", output / "ordinary",
            output / ".muac-stage-", output / ".muac-stage-abc:stream",
            output / ".." / output.filename() / ".muac-stage-abc",
            output / "." / ".muac-stage-abc", output / ".muac-stage-abc" / ""})
        CHECK(!lexical_stage(output, path));
    CHECK(!lexical_stage(output, ".muac-stage-relative"));
    CHECK(!lexical_stage("relative", output / ".muac-stage-abc"));
    CHECK(!lexical_stage(output.root_path(), output.root_path() / ".muac-stage-abc"));
    auto nul = (output / ".muac-stage-abc").native();
    nul.push_back(0); nul += std::filesystem::path("suffix").native();
    CHECK(!lexical_stage(output, std::filesystem::path(nul)));
}
TEST(muac_cleanup_removes_only_reported_stage_and_preserves_everything_else) {
    const auto root = std::filesystem::temp_directory_path() /
        ("ul-cleanup-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    const auto output = root / "output", stage = output / ".muac-stage-reported";
    const auto other = output / ".muac-stage-player-folder";
    std::filesystem::create_directories(stage / "nested");
    std::filesystem::create_directories(other);
    std::ofstream(stage / "nested" / "partial") << "synthetic";
    std::ofstream(other / "keep") << "owner";
    std::ofstream(output / "keep") << "owner";
    std::error_code ec;
    CHECK(!muac_setup::cleanup::remove_stage(output, root, ec));
    CHECK(std::filesystem::exists(stage));
    CHECK(!muac_setup::cleanup::remove_stage(output, output / "keep", ec));
    CHECK(muac_setup::cleanup::remove_stage(output, stage, ec));
    CHECK(!std::filesystem::exists(stage));
    CHECK(std::filesystem::exists(other / "keep"));
    CHECK(std::filesystem::exists(output / "keep"));
    CHECK(muac_setup::cleanup::remove_stage(output, stage, ec)); // Already cleaned by helper.
    std::ofstream(stage) << "ordinary file with a stage-like name";
    CHECK(!muac_setup::cleanup::remove_stage(output, stage, ec));
    CHECK(std::filesystem::is_regular_file(stage));
    std::filesystem::remove_all(root);
}

#ifdef _WIN32
#include <winioctl.h>
namespace {
    // A directory junction needs no symlink privilege and exercises the same
    // reparse-point escape the Windows setup guard must refuse.
    bool junction(const std::filesystem::path& link, const std::filesystem::path& target) {
        std::filesystem::create_directory(link);
        const auto handle = CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
        if (handle == INVALID_HANDLE_VALUE) return false;
        struct mount_point {
            DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
            WORD length{}, reserved{}, substitute_offset{}, substitute_length{}, print_offset{}, print_length{};
            WCHAR names[2048]{};
        } buffer;
        const auto substitute = std::wstring(L"\\??\\") + target.native();
        const auto display = target.native();
        buffer.substitute_length = static_cast<WORD>(substitute.size() * sizeof(WCHAR));
        buffer.print_offset = static_cast<WORD>((substitute.size() + 1) * sizeof(WCHAR));
        buffer.print_length = static_cast<WORD>(display.size() * sizeof(WCHAR));
        buffer.length = static_cast<WORD>(8 + buffer.print_offset + buffer.print_length + sizeof(WCHAR));
        std::copy(substitute.begin(), substitute.end(), buffer.names);
        std::copy(display.begin(), display.end(), buffer.names + substitute.size() + 1);
        DWORD returned{};
        const bool ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &buffer, buffer.length + 8,
            nullptr, 0, &returned, nullptr) != FALSE;
        CloseHandle(handle);
        return ok;
    }
}
TEST(muac_cleanup_refuses_junction_stage_descendant_and_ancestor) {
    const auto root = std::filesystem::temp_directory_path() /
        ("ul-junction-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    const auto output = root / "output", outside = root / "outside";
    const auto stage = output / ".muac-stage-reported";
    std::filesystem::create_directories(output);
    std::filesystem::create_directories(outside);
    std::ofstream(outside / "keep") << "owner";
    std::error_code ec;
    CHECK(junction(stage, outside));
    CHECK(!muac_setup::cleanup::remove_stage(output, stage, ec));
    CHECK(std::filesystem::exists(outside / "keep"));
    CHECK(RemoveDirectoryW(stage.c_str()) != FALSE);
    std::filesystem::create_directory(stage);
    CHECK(junction(stage / "escape", outside));
    CHECK(!muac_setup::cleanup::remove_stage(output, stage, ec));
    CHECK(std::filesystem::exists(outside / "keep"));
    CHECK(RemoveDirectoryW((stage / "escape").c_str()) != FALSE);
    const auto alias = root / "alias";
    CHECK(junction(alias, output));
    CHECK(!muac_setup::cleanup::remove_stage(alias, alias / stage.filename(), ec));
    CHECK(std::filesystem::exists(stage));
    CHECK(RemoveDirectoryW(alias.c_str()) != FALSE);
    std::filesystem::remove_all(root);
}
#endif
