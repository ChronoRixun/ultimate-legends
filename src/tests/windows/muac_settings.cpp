#include "std_include.hpp"
#include "muac/settings.hpp"
#include "game_config.hpp"
#include <cstdio>
#include <fstream>
#include <iterator>

// fix_ini::locate is not used by this test target; avoid bringing in the launcher.
std::optional<std::filesystem::path> game_config::game_config_t::get_install_path() const { return std::nullopt; }

namespace {
    int failures{};
    void check(bool ok, const char* expression, int line) {
        if (!ok) { ++failures; std::printf("FAIL %d: %s\n", line, expression); }
    }
#define CHECK(...) check((__VA_ARGS__), #__VA_ARGS__, __LINE__)
    std::string bytes(const std::filesystem::path& file) {
        std::ifstream input(file, std::ios::binary);
        return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
    }
    struct fixture {
        std::filesystem::path folder;
        std::wstring key = L"Software\\UltimateLegendsTests\\MUAC\\native-" + std::to_wstring(GetCurrentProcessId());
        fixture() {
            folder = std::filesystem::temp_directory_path() /
                ("ul-muac-test-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()));
            if (!std::filesystem::create_directory(folder)) throw std::runtime_error("Test folder exists");
        }
        ~fixture() {
            // Only the newly created fixture and this test process's dedicated key.
            std::error_code ignored;
            std::filesystem::remove_all(folder, ignored);
            RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str());
        }
    };
}

int main() {
    fixture test;
    CHECK(muac::normalise("CaptureMouse", " YES ") == "1");
    CHECK(muac::normalise("FrameLimit", "060") == "60");
    CHECK(!muac::normalise("FrameLimit", "19"));
    CHECK(!muac::normalise("FrameLimit", "60fps"));
    CHECK(!muac::normalise("Resolution", "1920x1080x1"));
    CHECK(muac::normalise("Resolution", "1920x1080") == "1920x1080");
    CHECK(muac::normalise("Resolution", "3840x2160") == "3840x2160");
    CHECK(!muac::normalise("Resolution", "7681x4320") && !muac::normalise("Resolution", "639x480"));
    // Without the 0.1.2 guard only Game.exe's own 14 sizes start (#31): 1600x900 crashes too.
    for (const auto* resolution : {"640x480", "1280x1024", "1680x1050", "1920x1080", "1920x1200", "2048x1536"})
        CHECK(muac::retail_resolution(resolution) && muac::resolution_supported(resolution, false));
    for (const auto* resolution : {"3840x2160", "2560x1440", "2560x1080", "2048x1152", "1600x900", "1921x1080"})
        CHECK(!muac::resolution_supported(resolution, false) && muac::resolution_supported(resolution, true));
    CHECK(!muac::resolution_supported("invalid", true) && !muac::resolution_supported("8000x4000", true));
    CHECK(!muac::resolution_guard(test.folder));
    CHECK(!muac::normalise("OnlineService", "custom"));
    CHECK(!muac::normalise("unknown", "1"));
    auto values = muac::read(test.folder);
    CHECK(values.at("Mode") == "fullscreen");
    CHECK(values.at("CaptureMouse") == "1" && values.at("Watermark") == "1");
    CHECK(values.at("Resolution") == "800x600");

    const auto graphics = test.folder / "dgVoodoo.conf", input = test.folder / "muac-fix.ini";
    std::ofstream(graphics) << "; keep graphics comment\n[General]\nFullScreenMode=true\nUnrelated=keep\n";
    std::ofstream(input) << "; keep input comment\n[Input]\nCaptureMouse=1\n[Online]\nDomain=off\nServer=192.0.2.1\n";
    CHECK(muac::read(test.folder).at("OnlineService") == "custom");
    std::string error;
    CHECK(muac::write(test.folder, {{"Mode","borderless"},{"Resolution","1920x1080"},{"FrameLimit","60"},
        {"VSync","1"},{"Watermark","0"},{"ControllerSupport","1"},{"CaptureMouse","0"},
        {"RunInBackground","0"},{"OnlineService","openspy"}}, error));
    values = muac::read(test.folder);
    CHECK(values.at("Mode") == "borderless" && values.at("Resolution") == "1920x1080");
    CHECK(values.at("FrameLimit") == "60" && values.at("VSync") == "1");
    CHECK(values.at("Watermark") == "0" && values.at("CaptureMouse") == "0");
    CHECK(values.at("ControllerSupport") == "1" && values.at("RunInBackground") == "0");
    CHECK(values.at("OnlineService") == "openspy");
    CHECK(bytes(graphics).find("Unrelated=keep") != std::string::npos);
    CHECK(bytes(graphics).find("; keep graphics comment") != std::string::npos);
    // dgVoodoo must list the saved size or libIGGfx gets no device (#31); keeping it in sync is idempotent.
    CHECK(bytes(graphics).find("[DirectXExt]") != std::string::npos);
    CHECK(bytes(graphics).find("ExtraEnumeratedResolutions=1920x1080@60") != std::string::npos);
    CHECK(muac::dgvoodoo_mode("3840x2160") == "3840x2160@60");
    {
        const auto synced = bytes(graphics);
        CHECK(muac::enumerate_saved_resolution(test.folder, error, false));
        CHECK(bytes(graphics) == synced);
        CHECK(muac::enumerate_saved_resolution(test.folder, error, true));
    }
    CHECK(bytes(input).find("; keep input comment") != std::string::npos);
    CHECK(bytes(input).find("Server=") == std::string::npos);
    const auto before_graphics = bytes(graphics), before_input = bytes(input);
    CHECK(!muac::write(test.folder, {{"CaptureMouse","1"},{"Resolution","3840x2160"}}, error));
    CHECK(error == muac::resolution_message);
    CHECK(muac::read(test.folder).at("Resolution") == "1920x1080");
    CHECK(bytes(graphics) == before_graphics && bytes(input) == before_input);
    CHECK(!muac::write(test.folder, {{"CaptureMouse","1"},{"Resolution","invalid"}}, error));
    CHECK(bytes(graphics) == before_graphics && bytes(input) == before_input);

    // CaptureMouse writes the input INI first, then the wrapper. Deny the second
    // write through a real Windows file handle and check that the first is undone.
    const HANDLE locked = CreateFileW(graphics.c_str(), GENERIC_READ, FILE_SHARE_READ,
                                     nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    CHECK(locked != INVALID_HANDLE_VALUE);
    if (locked != INVALID_HANDLE_VALUE) {
        CHECK(!muac::write(test.folder, {{"CaptureMouse","1"},{"Resolution","1280x720"}}, error));
        CloseHandle(locked);
        CHECK(bytes(graphics) == before_graphics && bytes(input) == before_input);
        CHECK(muac::read(test.folder).at("Resolution") == "1920x1080");
    }
    const auto prior_failures = failures;
    const auto missing_wine = muac::missing_runtime(test.folder, true);
    const auto missing_windows = muac::missing_runtime(test.folder, false);
    CHECK(std::find(missing_wine.begin(), missing_wine.end(), "D3D9.dll") == missing_wine.end());
    CHECK(std::find(missing_windows.begin(), missing_windows.end(), "D3D9.dll") != missing_windows.end());
    CHECK(std::find(missing_wine.begin(), missing_wine.end(), "version.dll") != missing_wine.end());
    CHECK(!muac::write(test.folder, {{"Mode","borderless"}}, error, true));
    CHECK(!muac::write(test.folder, {{"Resolution","1280x800"}}, error, true));
    CHECK(bytes(graphics) == before_graphics && bytes(input) == before_input);
    CHECK(muac::write(test.folder, {{"ControllerSupport","0"},{"CaptureMouse","0"}}, error, true));
    CHECK(bytes(graphics) == before_graphics);
    CHECK(muac::read(test.folder, true).at("ControllerSupport") == "0");
    CHECK(muac::read(test.folder, true).at("CaptureMouse") == "0");
    std::printf("MUAC Wine settings: %d failures\n", failures - prior_failures);
    std::printf("MUAC native settings: %d failures\n", failures);
    return failures ? 1 : 0;
}
