#include "std_include.hpp"
#include "test.hpp"
#include "support/report_rules.hpp"

// Support > Copy diagnostics (support/report_rules.hpp) with stubbed values: the primary monitor's desktop mode
// and scaling while an exclusive-fullscreen game changed the mode, and where a fix's version comes from.
namespace
{
    support::display_facts four_k_at_150()
    {
        support::display_facts facts;
        facts.desktop = {3840, 2160, 60};
        facts.current = {3840, 2160, 60};
        facts.monitor_dpi = 144;
        facts.system_dpi = 144;
        return facts;
    }
}

TEST(support_display_desktop_mode_in_use_reports_the_monitor_now)
{
    const auto report = support::choose_display(four_k_at_150());
    CHECK(report.desktop.width == 3840 && report.desktop.height == 2160 && report.desktop.refresh == 60);
    CHECK(!report.current.valid());
    CHECK(report.scale == 150);
    CHECK(report.source == support::scale_source::now);
}

TEST(support_display_fullscreen_game_mode_is_current_not_the_monitor)
{
    // Owen's case: a game in exclusive fullscreen at 2560x1440 on the 4K primary; Windows then says 96 DPI.
    auto facts = four_k_at_150();
    facts.current = {2560, 1440, 60};
    facts.monitor_dpi = 96;
    facts.remembered_mode = {3840, 2160, 60};
    facts.remembered_dpi = 144;
    const auto report = support::choose_display(facts);
    CHECK(report.desktop.width == 3840 && report.desktop.height == 2160);
    CHECK(report.current.width == 2560 && report.current.height == 1440);
    CHECK(report.scale == 150);
    CHECK(report.source == support::scale_source::launcher_start);

    // Started while the game was already fullscreen: nothing remembered, so the scaling at sign-in.
    facts.remembered_mode = {};
    facts.remembered_dpi = 0;
    const auto signed_in = support::choose_display(facts);
    CHECK(signed_in.scale == 150 && signed_in.source == support::scale_source::sign_in);

    // A remembered reading for another desktop size (the monitor was changed since) is not used.
    facts.remembered_mode = {2560, 1440, 144};
    facts.remembered_dpi = 96;
    CHECK(support::choose_display(facts).source == support::scale_source::sign_in);

    // Nothing known at all.
    facts.system_dpi = 0;
    CHECK(support::choose_display(facts).scale == 0);
}

TEST(support_display_without_a_saved_mode_uses_the_current_one)
{
    auto facts = four_k_at_150();
    facts.desktop = {};
    facts.current = {1280, 800, 60};
    facts.monitor_dpi = 96;
    const auto report = support::choose_display(facts);
    CHECK(report.desktop.width == 1280 && report.desktop.height == 800);
    CHECK(!report.current.valid());
    CHECK(report.scale == 100 && report.source == support::scale_source::now);
    CHECK(support::scale_percent(120) == 125 && support::scale_percent(168) == 175 && support::scale_percent(0) == 0);
}

TEST(support_fix_version_sources)
{
    using support::version_source;
    const std::string log = "[11:13:10.443] XML2 Fix 1.11.0\n[11:13:10.444] input: CacheDeviceScan=1\n";
    // No DLL: not installed, whatever else is there.
    CHECK(support::choose_fix_version(std::nullopt, "1.10.0", log, "XML2 Fix").source == version_source::none);
    // The DLL's resource first.
    auto v = support::choose_fix_version(std::string("1.11.0"), "1.10.0", log, "XML2 Fix");
    CHECK(v.version == "1.11.0" && v.source == version_source::dll);
    // No resource: the launcher's record, else the log's first line.
    v = support::choose_fix_version(std::string(), "1.10.0", log, "XML2 Fix");
    CHECK(v.version == "1.10.0" && v.source == version_source::record);
    v = support::choose_fix_version(std::string(), "", log, "XML2 Fix");
    CHECK(v.version == "1.11.0" && v.source == version_source::log);
    v = support::choose_fix_version(std::string(), "", "[17:43:03.913] MUA Controller Fix 2.0.0-beta.1\n", "MUA Controller Fix");
    CHECK(v.version == "2.0.0-beta.1" && v.source == version_source::log);
    // A log without the fix's name and version line, or another fix's log: unknown, not "not installed".
    v = support::choose_fix_version(std::string(), "", "[00:00:00.000] bindings: added 92\n", "XML2 Fix");
    CHECK(v.version.empty() && v.source == version_source::unknown);
    CHECK(support::choose_fix_version(std::string(), "", "XML2 Fix 1.11.0\n", "MUA Controller Fix").source == version_source::unknown);
    CHECK(support::choose_fix_version(std::string(), "", "", "XML2 Fix").source == version_source::unknown);
}
