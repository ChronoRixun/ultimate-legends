#include "std_include.hpp"
#include "test.hpp"

#include <utils/registry.hpp>
#include <utils/test_instance.hpp>

#include <cstdlib>
#include <fstream>
#include <string>

// The launcher's test-instance mode (common/utils/test_instance.hpp, wired in main.cpp, deep_link.cpp,
// properties.cpp, registry.cpp, com.cpp, muac/settings.cpp, cef_ui.cpp and the show command): accepted only with
// -portable, its own lock / pipe names, no ultimatelegends:// registration, shortcuts or other HKCU writes, no
// window activation, and the Debug-only dev overrides. The registry check writes nothing: it proves the refusal.
namespace utils::com
{
    bool create_shortcut(const std::filesystem::path& target_path, const std::filesystem::path& shortcut_path,
                         const std::string& description, const std::filesystem::path& working_directory);
}

namespace
{
    namespace ti = utils::test_instance;

    // Restores the player's mode after a test that switched the process into a test instance.
    struct scoped_mode
    {
        explicit scoped_mode(const std::string& name) { ti::set(name); }
        ~scoped_mode() { ti::set({}); }
    };
}

TEST(test_instance_is_accepted_only_with_portable_and_a_safe_name)
{
    std::string error;
    CHECK(!ti::resolve(std::nullopt, false, error) && error.empty());
    CHECK(!ti::resolve(std::nullopt, true, error) && error.empty());
    CHECK(ti::resolve(std::string("agent-1"), true, error) == std::optional<std::string>("agent-1") && error.empty());
    CHECK(ti::resolve(std::string("UL-Tabs"), true, error) == std::optional<std::string>("ul-tabs"));
    CHECK(!ti::resolve(std::string("agent-1"), false, error) && error.find("-portable") != std::string::npos);
    for (const auto* bad : {"", "two words", "../x", "a\\b", "name_with_underscore", "x:y",
                            "abcdefghijklmnopqrstuvwxyz0123456"})
    {
        CHECK(!ti::resolve(std::string(bad), true, error) && !error.empty());
    }
    CHECK(ti::valid_name("abcdefghijklmnopqrstuvwxyz012345"));
}

TEST(test_instance_has_its_own_lock_and_deep_link_pipe_names)
{
    CHECK(ti::suffixed("ultimate-legends", "") == "ultimate-legends");
    CHECK(ti::suffixed("ultimate-legends", "agent-1") == "ultimate-legends-test-agent-1");
    CHECK(ti::suffixed("ultimate-legends-properties-lock", "agent-1") == "ultimate-legends-properties-lock-test-agent-1");
    CHECK(ti::suffixed(std::wstring(L"\\\\.\\pipe\\ultimate-legends-deeplink"), "agent-1") ==
          L"\\\\.\\pipe\\ultimate-legends-deeplink-test-agent-1");
    CHECK(ti::suffixed(std::wstring(L"\\\\.\\pipe\\ultimate-legends-deeplink"), "") == L"\\\\.\\pipe\\ultimate-legends-deeplink");
}

TEST(test_instance_plan_touches_nothing_outside_its_folder)
{
    const auto player = ti::plan({}, false);
    CHECK(player.register_uri && player.create_shortcuts && player.hkcu_writes && player.activate_window);
    CHECK(!player.dev_overrides);
    CHECK(ti::plan({}, true).dev_overrides); // a Debug build, as before
    const auto test = ti::plan("agent-1", false);
    CHECK(!test.register_uri && !test.create_shortcuts && !test.hkcu_writes && !test.activate_window);
    CHECK(test.dev_overrides);
}

// The startup main.cpp runs: in a test instance neither the ultimatelegends:// registration nor the shortcuts run.
TEST(test_instance_startup_never_registers_the_url_scheme_or_creates_shortcuts)
{
    int registered = 0, shortcuts = 0;
    const ti::startup_steps steps{[&] { ++shortcuts; }, [&] { ++registered; }};
    ti::run_startup(ti::plan("agent-1", false), steps);
    CHECK(registered == 0);
    CHECK(shortcuts == 0);
    ti::run_startup(ti::plan({}, false), steps);
    CHECK(registered == 1 && shortcuts == 1);

    // The process's own mode, as main.cpp sets it.
    {
        const scoped_mode mode("agent-1");
        registered = shortcuts = 0;
        ti::run_startup(ti::current(), steps);
        CHECK(registered == 0 && shortcuts == 0);
        CHECK(ti::active() && ti::name() == "agent-1");
        CHECK(!ti::hkcu_writes_allowed() && !ti::may_activate() && ti::dev_overrides());
        CHECK(ti::extra_window_ex_style() == 0x08000000u); // WS_EX_NOACTIVATE: never the foreground window
    }
    CHECK(!ti::active() && ti::hkcu_writes_allowed() && ti::may_activate());
    CHECK(ti::extra_window_ex_style() == 0u); // the player's launcher: unchanged
}

TEST(test_instance_registry_and_shortcut_writes_are_refused)
{
    const scoped_mode mode("agent-1");
    const std::wstring key = L"Software\\UltimateLegendsTests\\TestInstance-" + std::to_wstring(std::rand());
    CHECK(!utils::registry::set_hkcu_string(key, L"", L"must not be written"));
    CHECK(!utils::registry::get_hkcu_string(key, L"").has_value());

    const auto folder = std::filesystem::temp_directory_path() / ("ul-test-instance-" + std::to_string(std::rand()));
    std::filesystem::create_directories(folder);
    const auto target = folder / "target.txt";
    std::ofstream(target) << "x";
    const auto link = folder / "Ultimate Legends.lnk";
    CHECK(!utils::com::create_shortcut(target, link, "test", {}));
    CHECK(!std::filesystem::exists(link));
    std::error_code ec;
    std::filesystem::remove_all(folder, ec);
}
