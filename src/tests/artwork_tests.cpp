#include "std_include.hpp"
#include "test.hpp"
#include "artwork/store.hpp"
#ifdef _WIN32
#include "artwork/decode.hpp"
#endif

namespace {
    const unsigned char fixture[] = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00, 0x15, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x90, 0xb3, 0x89, 0xfa, 0x0f, 0xc2, 0x0c, 0x51, 0x36, 0x72, 0xff, 0x41, 0x18, 0x00, 0x38, 0xac, 0x06, 0xcd, 0x07, 0xee, 0x01, 0x8e, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
    std::string png() { return {reinterpret_cast<const char*>(fixture), sizeof(fixture)}; }
    struct scratch {
        std::filesystem::path root = std::filesystem::absolute("build/artwork-test-" +
            std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        scratch() { std::filesystem::create_directories(root); }
        ~scratch() { std::error_code ec; std::filesystem::remove_all(root, ec); }
    };
}
TEST(artwork_paths_accept_only_fixed_games_kinds_and_opaque_records) {
    scratch work;
    CHECK(artwork::managed_path(work.root, "xml1", "capsule", "abc123.png"));
    CHECK(artwork::managed_path(work.root, "mua", "hero", "ff.jpg"));
    CHECK(artwork::managed_path(work.root, "mua2", "hero", "ff.webp"));
    CHECK(artwork::managed_path(work.root, "muac", "icon", "ff.webp"));
    CHECK(!artwork::managed_path(work.root, "mua", "../icon", "ff.png"));
    CHECK(!artwork::managed_path(work.root, "mua", "icon", "../ff.png"));
    for (const auto record : {"../abc.png", "abc/def.png", "abc.png:stream", "abc.svg", "abc.png/", "C:/abc.png", ".png", "abc.png.bak"})
        CHECK(!artwork::managed_path(work.root, "xml1", "capsule", record));
    CHECK(!artwork::managed_path(work.root, "../xml1", "capsule", "ff.png"));
    CHECK(!artwork::managed_path(work.root, "xml1", "../hero", "ff.png"));
    CHECK(!artwork::managed_path("relative", "xml1", "hero", "ff.png"));
    CHECK(!artwork::managed_path(work.root / ".." / work.root.filename(), "xml1", "hero", "ff.png"));
    CHECK(!artwork::managed_path(work.root.root_path(), "xml1", "hero", "ff.png"));
    CHECK(!artwork::record_id(std::string("ff.png\0suffix", 13)));
}
TEST(artwork_rejects_empty_oversize_and_other_types) {
    CHECK(artwork::image_type(png()) == "png");
    CHECK(artwork::image_type(std::string("\xff\xd8\xff", 3)) == "jpg");
    CHECK(artwork::image_type("RIFF1234WEBP") == "webp");
    CHECK(artwork::image_type("").empty());
    CHECK(artwork::image_type("<svg>not raster</svg>").empty());
    CHECK(artwork::image_type("GIF89a").empty());
    auto bytes = png(); bytes.resize(artwork::max_bytes, 'x');
    CHECK(artwork::image_type(bytes) == "png");
    bytes.push_back('x');
    CHECK(artwork::image_type(bytes).empty());
    scratch work;
    const auto file = work.root / "oversize.png";
    std::ofstream(file, std::ios::binary).write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    CHECK(!artwork::read_image(file));
    CHECK(!artwork::read_image(work.root / "missing.png"));
}
TEST(artwork_reset_removes_only_the_named_managed_file) {
    scratch work;
    const auto card = artwork::managed_path(work.root, "mua", "capsule", "abc.png");
    const auto hero = artwork::managed_path(work.root, "mua", "hero", "def.png");
    CHECK(card && hero);
    std::filesystem::create_directories(card->parent_path());
    std::ofstream(*card, std::ios::binary) << png();
    std::ofstream(*hero, std::ios::binary) << png();
    std::ofstream(work.root / "source.png", std::ios::binary) << png();
    CHECK(artwork::read_image(*card) == png());
    CHECK(!artwork::remove_image(work.root, "mua", "capsule", "../../source.png"));
    CHECK(artwork::remove_image(work.root, "mua", "capsule", "abc.png"));
    CHECK(!artwork::read_image(*card));
    CHECK(std::filesystem::exists(*hero));
    CHECK(std::filesystem::exists(work.root / "source.png"));
    CHECK(artwork::remove_image(work.root, "mua", "capsule", "abc.png"));
    std::filesystem::create_directory(*card);
    CHECK(!artwork::remove_image(work.root, "mua", "capsule", "abc.png"));
}
TEST(artwork_writes_are_staged_and_never_truncate_an_existing_copy) {
    scratch work;
    const auto path = artwork::managed_path(work.root, "xml1", "capsule", "a1.png");
    CHECK(artwork::write_image(work.root, "xml1", "capsule", "a1.png", png()));
    CHECK(artwork::read_image(*path) == png());
    CHECK(!std::filesystem::exists(*artwork::managed_path(work.root, "xml1", "capsule", "0a1.png")));
    CHECK(!artwork::write_image(work.root, "xml1", "capsule", "a1.png", "invalid"));
    CHECK(!artwork::write_image(work.root, "xml1", "capsule", "a1.png", png()));
    CHECK(artwork::read_image(*path) == png());
    CHECK(!artwork::write_image(work.root, "xml1", "capsule", "a2.jpg", png()));
    CHECK(!artwork::write_image(work.root, "../xml1", "capsule", "a2.png", png()));
    const auto blocked = artwork::managed_path(work.root, "xml1", "hero", "a3.png");
    std::filesystem::create_directory(*blocked);
    CHECK(!artwork::write_image(work.root, "xml1", "hero", "a3.png", png()));
    CHECK(std::filesystem::is_directory(*blocked));
    CHECK(artwork::read_image(*path) == png());
}
TEST(artwork_icons_persist_and_reset_independently_of_cards_banners_and_other_games) {
    scratch work;
    for (const auto kind : {"capsule", "hero", "icon"})
        CHECK(artwork::write_image(work.root, "mua", kind, "ab.png", png()));
    CHECK(artwork::write_image(work.root, "xml1", "icon", "ab.png", png()));
    // Reconstruct the managed path from the saved opaque record, as a fresh launcher does.
    const auto reopened = artwork::managed_path(std::filesystem::path(work.root.native()), "mua", "icon", "ab.png");
    CHECK(reopened);
    CHECK(artwork::read_image(*reopened) == png());
    CHECK(!artwork::write_image(work.root, "mua", "icon", "ac.png", "not an image"));
    CHECK(!artwork::write_image(work.root, "mua", "icon", "ac.jpg", png()));
    CHECK(artwork::read_image(*reopened) == png());
    CHECK(artwork::remove_image(work.root, "mua", "icon", "ab.png"));
    CHECK(!artwork::read_image(*reopened));
    for (const auto kind : {"capsule", "hero"})
        CHECK(artwork::read_image(*artwork::managed_path(work.root, "mua", kind, "ab.png")) == png());
    CHECK(artwork::read_image(*artwork::managed_path(work.root, "xml1", "icon", "ab.png")) == png());
}
#ifdef _WIN32
TEST(artwork_real_decoder_refuses_truncated_disguised_and_oversized_images) {
    auto bytes = png();
    CHECK(artwork::decodes(bytes));
    bytes.resize(24);
    CHECK(!artwork::decodes(bytes));
    bytes = std::string("\xff\xd8\xffnot a jpeg", 13);
    CHECK(!artwork::decodes(bytes));
    bytes = "RIFF1234WEBPnot an image";
    CHECK(!artwork::decodes(bytes));
    bytes = png(); bytes.resize(artwork::max_bytes + 1, 'x');
    CHECK(!artwork::decodes(bytes));
}
#endif

#ifdef _WIN32
#include <winioctl.h>
namespace {
    // A directory junction needs no symlink privilege and exercises the same
    // reparse-point escape the Windows setup guard must refuse.
    bool artwork_junction(const std::filesystem::path& link, const std::filesystem::path& target) {
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

TEST(artwork_refuses_junctions_at_the_game_folder_and_root) {
    scratch work;
    const auto target = work.root / "outside";
    std::filesystem::create_directories(target);
    std::ofstream(target / "capsule-ab.png", std::ios::binary) << png();
    std::filesystem::create_directories(work.root / "user" / "art");
    const auto link = work.root / "user" / "art" / "mua";
    CHECK(artwork_junction(link, target));
    CHECK(!artwork::managed_path(work.root, "mua", "capsule", "ab.png"));
    CHECK(!artwork::remove_image(work.root, "mua", "capsule", "ab.png"));
    CHECK(!artwork::write_image(work.root, "mua", "capsule", "ac.png", png()));
    CHECK(!artwork::managed_path(work.root, "mua", "icon", "ab.png"));
    CHECK(!artwork::write_image(work.root, "mua", "icon", "ac.png", png()));
    CHECK(!artwork::remove_image(work.root, "mua", "icon", "ab.png"));
    CHECK(artwork::read_image(target / "capsule-ab.png") == png());
    CHECK(RemoveDirectoryW(link.c_str()) != FALSE);
    const auto alias = work.root / "alias";
    CHECK(artwork_junction(alias, target));
    CHECK(!artwork::managed_path(alias, "mua", "capsule", "ab.png"));
    CHECK(RemoveDirectoryW(alias.c_str()) != FALSE);
}
#endif

#ifdef _WIN32
// A launcher folder BELOW a linked folder (under Proton every Z:\ Linux mount such as Z:\home reads
// as a junction) keeps its artwork; a junction at the root or inside the art tree is still refused
// (artwork_refuses_junctions_at_the_game_folder_and_root).
TEST(artwork_paths_accept_a_launcher_folder_below_a_linked_parent) {
    scratch work;
    const auto real = work.root / "real", parent = work.root / "parent";
    std::filesystem::create_directories(real / "launcher" / "user" / "art");
    if (!artwork_junction(parent, real)) return;  // no junctions here
    CHECK(artwork::managed_path(parent / "launcher", "xml1", "capsule", "ab.png"));
    CHECK(artwork::write_image(parent / "launcher", "xml1", "capsule", "ab.png", png()));
    CHECK(artwork::read_image(real / "launcher" / "user" / "art" / "xml1" / "capsule-ab.png") == png());
    CHECK(artwork::remove_image(parent / "launcher", "xml1", "capsule", "ab.png"));
    CHECK(artwork::write_image(parent / "launcher", "xml1", "icon", "ac.png", png()));
    CHECK(artwork::read_image(real / "launcher" / "user" / "art" / "xml1" / "icon-ac.png") == png());
    CHECK(artwork::remove_image(parent / "launcher", "xml1", "icon", "ac.png"));
    CHECK(RemoveDirectoryW(parent.c_str()) != FALSE);
}
#endif
