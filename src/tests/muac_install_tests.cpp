#include "test.hpp"
#include "muac/install.hpp"
#include <fstream>
#include <chrono>

TEST(muac_existing_install_accepts_game_root_without_importer_or_runtime_files) {
    const auto folder = std::filesystem::temp_directory_path() /
        ("ul-muac-existing-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    CHECK(!muac::valid_install(folder));
    for (const auto* file : {"Game.exe", "libIGCore.dll", "libIGGfx.dll", "data/herostat.engb", "build.ini"}) {
        const auto path = folder / file;
        std::filesystem::create_directories(path.parent_path());
        std::ofstream(path) << "synthetic fixture";
    }
    CHECK(muac::valid_install(folder));
    CHECK(!muac::valid_install(folder.parent_path())); // Select the actual root, not its parent.
    CHECK(!muac::valid_install(folder / "data"));
    std::filesystem::remove(folder / "Game.exe");
    std::ofstream(folder / "Marvel.exe") << "2016 fixture";
    CHECK(!muac::valid_install(folder));
    std::filesystem::create_directory(folder / "Game.exe");
    CHECK(!muac::valid_install(folder)); // A directory is not an executable marker.
    std::filesystem::remove_all(folder);
}
