#include "std_include.hpp"
#include "test.hpp"
#include "xml1/build_requirements.hpp"
#include "updater/staged_patch.hpp"

#include <fstream>

namespace
{
    struct fixture
    {
        std::filesystem::path root = std::filesystem::temp_directory_path() /
            ("ul-fix-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fixture() { std::filesystem::create_directories(root); }
        ~fixture() { std::error_code ignored; std::filesystem::remove_all(root, ignored); }
    };
    void write(const std::filesystem::path& file, const std::string& text)
    {
        std::filesystem::create_directories(file.parent_path());
        std::ofstream(file, std::ios::binary) << text;
    }
    std::string read(const std::filesystem::path& file)
    {
        std::ifstream stream(file, std::ios::binary);
        return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
    }
    template <typename F> bool failed(F&& call)
    {
        try { call(); return false; } catch (const std::exception&) { return true; }
    }
}

TEST(build_requires_fix_before_first_resume_and_rebuild_on_beta)
{
    const std::optional<std::string> required = ">=1.11.0-beta.1";
    CHECK(!xml1::build_fix_ready(required, std::nullopt));
    CHECK(!xml1::build_fix_ready(required, ""));
    CHECK(!xml1::build_fix_ready(required, "1.8.1"));
    CHECK(!xml1::build_fix_ready(required, "1.8.2"));
    CHECK(xml1::build_fix_ready(required, "1.11.0-beta.1"));
    CHECK(xml1::build_fix_ready(required, "1.11.0-beta.2"));
}

TEST(build_stable_companion_and_keep_beta_use_semver_without_downgrading)
{
    CHECK(xml1::build_fix_ready(">=1.8.0", "1.8.1"));
    CHECK(xml1::build_fix_ready(">=1.8.0", "1.8.2"));
    CHECK(xml1::build_fix_ready(">=1.8.0", "1.11.0-beta.1"));
    CHECK(!xml1::build_fix_ready(">=1.8.0", "1.8.0-beta.1"));
    CHECK(!xml1::build_fix_ready(std::nullopt, "1.11.0-beta.1"));
    CHECK(!xml1::build_fix_ready("", std::nullopt));
    CHECK(xml1::build_fix_ready("", "")); // old companion contract without a minimum
}

TEST(fresh_fix_download_failure_leaves_output_absent)
{
    fixture f;
    const auto out = f.root / "new" / "port";
    CHECK(failed([&] {
        updater::staged_patch::apply(out, {"dinput.dll", "support.dat"}, [&](const auto& stage) {
            write(stage / "dinput.dll", "downloaded");
            throw std::runtime_error("second download failed");
        }, [] { return false; });
    }));
    CHECK(!std::filesystem::exists(f.root / "new"));
}

TEST(fresh_fix_cancel_keeps_preexisting_empty_folder_clean)
{
    fixture f;
    const auto out = f.root / "port";
    std::filesystem::create_directory(out);
    CHECK(failed([&] {
        updater::staged_patch::apply(out, {"dinput.dll"}, [&](const auto& stage) {
            write(stage / "dinput.dll", "downloaded");
        }, [] { return true; });
    }));
    CHECK(std::filesystem::is_empty(out));
}

TEST(fix_commit_failure_restores_existing_dll_settings_and_game)
{
    fixture f;
    const auto out = f.root / "port";
    write(out / "dinput.dll", "old DLL");
    write(out / "xml2-fix.ini", "player settings");
    write(out / "XMen2.exe", "game stand-in");
    CHECK(failed([&] {
        updater::staged_patch::apply(out, {"dinput.dll", "new-folder/missing.dat"}, [&](const auto& stage) {
            write(stage / "dinput.dll", "new DLL");
        }, [] { return false; });
    }));
    CHECK(read(out / "dinput.dll") == "old DLL");
    CHECK(read(out / "xml2-fix.ini") == "player settings");
    CHECK(read(out / "XMen2.exe") == "game stand-in");
    CHECK(std::distance(std::filesystem::directory_iterator(out), std::filesystem::directory_iterator()) == 3);
}

TEST(fix_commit_cancel_rolls_back_already_published_files)
{
    fixture f;
    const auto out = f.root / "port";
    write(out / "dinput.dll", "old");
    int checks = 0;
    CHECK(failed([&] {
        updater::staged_patch::apply(out, {"dinput.dll", "new-folder/extra.dat"}, [&](const auto& stage) {
            write(stage / "dinput.dll", "new");
            write(stage / "new-folder/extra.dat", "extra");
        }, [&] { return ++checks == 3; });
    }));
    CHECK(read(out / "dinput.dll") == "old");
    CHECK(!std::filesystem::exists(out / "new-folder"));
    CHECK(std::distance(std::filesystem::directory_iterator(out), std::filesystem::directory_iterator()) == 1);
}

TEST(fix_preparation_publishes_complete_pair_and_keeps_player_files)
{
    fixture f;
    const auto out = f.root / "port";
    write(out / "xml2-fix.ini", "player settings");
    write(out / "mods/skin.txt", "player mod");
    updater::staged_patch::apply(out, {"dinput.dll", "support/extra.dat"}, [&](const auto& stage) {
        write(stage / "dinput.dll", "new DLL");
        write(stage / "support/extra.dat", "support");
        CHECK(!std::filesystem::exists(out / "dinput.dll"));
    }, [] { return false; });
    CHECK(read(out / "dinput.dll") == "new DLL");
    CHECK(read(out / "support/extra.dat") == "support");
    CHECK(read(out / "xml2-fix.ini") == "player settings");
    CHECK(read(out / "mods/skin.txt") == "player mod");
    CHECK(std::distance(std::filesystem::directory_iterator(out), std::filesystem::directory_iterator()) == 4);
}
