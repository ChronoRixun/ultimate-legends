#include "std_include.hpp"
#include "test.hpp"

#include "updater/file_hash_cache.hpp"
#include "updater/patch_policy.hpp"

#include <fstream>

// The XML2 Fix in a folder the launcher has no matching install record for (FB1): a hand-copied test kit
// whose DLL reads 1.8.0 (or 1.8.0.0, 1.8.0.2) - the numbers every 1.8.0-beta.N also reads. And the DLL hash
// the fix's version needs, computed only when the file changed (FS3: the Online section asks every 500 ms).
namespace
{
    release_channel::outcome offered(const std::string& tag)
    {
        release_channel::release chosen{};
        chosen.tag = tag;
        chosen.version = release_channel::tag_version(tag);
        chosen.prerelease = release_channel::is_prerelease(chosen.version);
        chosen.assets.push_back({"ultimate-legends.json", "https://github.com/ChronoRixun/xml2-fix/releases/download/" + tag + "/ultimate-legends.json", 10});
        return {chosen, false, {}};
    }
}

TEST(a_hand_copied_test_kit_gets_the_beta_on_beta)
{
    const auto beta = offered("v1.8.0-beta.1");
    for (const auto* dll : {"1.8.0", "1.8.0.0", "1.8.0.2"})
    {
        // No record: the DLL's numbers only. The beta is the same 1.8.0: installed (a repair, hash-checked).
        const auto decision = patch_policy::decide(std::string(dll), beta, std::nullopt, false);
        CHECK(decision.what == patch_policy::action::install && decision.chosen && decision.chosen->version == "1.8.0-beta.1");
        CHECK(!decision.downgrade && decision.note.find("no install record") != std::string::npos);
    }
    // A later beta too, and a newer kit's numbers keep their order (1.8.1 is not repaired with 1.8.0-beta.2).
    CHECK(patch_policy::decide(std::string("1.8.0"), offered("v1.8.0-beta.2"), std::nullopt, false).what == patch_policy::action::install);
    CHECK(patch_policy::decide(std::string("1.8.1"), offered("v1.8.0-beta.2"), std::nullopt, false).what == patch_policy::action::keep);
    CHECK(patch_policy::decide(std::string("1.7.0"), beta, std::nullopt, false).what == patch_policy::action::install);
}

TEST(a_matching_record_keeps_the_strict_rule)
{
    const auto beta = offered("v1.8.0-beta.1");
    // The launcher installed the final 1.8.0 (recorded): a 1.8.0 beta is older and is not installed.
    auto decision = patch_policy::decide(std::string("1.8.0"), beta, std::nullopt, true);
    CHECK(decision.what == patch_policy::action::keep && !decision.chosen);
    // The recorded beta.2 is not "repaired" with beta.1 either.
    decision = patch_policy::decide(std::string("1.8.0-beta.2"), beta, std::nullopt, true);
    CHECK(decision.what == patch_policy::action::keep);
    // The default is the strict rule.
    CHECK(patch_policy::decide(std::string("1.8.0"), beta, std::nullopt).what == patch_policy::action::keep);
}

TEST(a_hand_copied_test_kit_is_offered_the_switch_back_on_stable)
{
    using patch_policy::offers_switch_back;
    // No record, newer numbers than Stable's 1.7.1: Settings offers Switch back to Stable.
    CHECK(offers_switch_back("1.8.0", false, "1.7.1"));
    CHECK(offers_switch_back("1.8.0.0", false, "1.7.1"));
    CHECK(offers_switch_back("1.8.0.2", false, "1.7.1"));
    // ... but never for Stable's own numbers, or an older fix, or when Stable is unknown.
    CHECK(!offers_switch_back("1.7.1", false, "1.7.1") && !offers_switch_back("1.7.1.0", false, "1.7.1"));
    CHECK(!offers_switch_back("1.7.0", false, "1.7.1") && !offers_switch_back("1.8.0", false, ""));
    // With a record: only a pre-release newer than Stable (a recorded final 1.8.0 is Stable's own, later).
    CHECK(offers_switch_back("1.8.0-beta.2", true, "1.7.1"));
    CHECK(!offers_switch_back("1.8.0", true, "1.7.1"));

    // Stable, no record, no approval: the kit stays (nothing is downgraded silently).
    const auto stable = offered("v1.7.1");
    CHECK(patch_policy::decide(std::string("1.8.0"), stable, std::nullopt, false).what == patch_policy::action::keep);
    // With the approval for exactly that folder's version: 1.7.1 is installed.
    const auto decision = patch_policy::decide(std::string("1.8.0"), stable, patch_policy::consent{"1.8.0", "1.7.1"}, false);
    CHECK(decision.what == patch_policy::action::install && decision.downgrade);
    // Stable's own numbers without a record: a repair, as before.
    CHECK(patch_policy::decide(std::string("1.7.1"), stable, std::nullopt, false).what == patch_policy::action::install);
}

TEST(the_dll_hash_is_computed_again_only_when_the_file_changed)
{
    const auto folder = std::filesystem::temp_directory_path() / std::format("ul-hash-cache-{}", std::chrono::steady_clock::now().time_since_epoch().count());
    std::filesystem::create_directories(folder);
    const auto file = folder / "dinput.dll";
    const auto write = [&](const std::string& text)
    {
        std::ofstream(file, std::ios::binary | std::ios::trunc) << text;
    };
    auto computed = 0;
    updater::file_hash_cache cache([&](const std::filesystem::path& path)
    {
        ++computed;
        std::ifstream in(path, std::ios::binary);
        std::string data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        return in || in.eof() ? "h:" + data : std::string{};
    });

    write("one");
    CHECK(cache.get(file) == "h:one");
    for (auto i = 0; i < 10; ++i)
    {
        CHECK(cache.get(file) == "h:one"); // the 500 ms polls
    }
    CHECK(computed == 1);

    // Another size: hashed again.
    write("three");
    CHECK(cache.get(file) == "h:three" && computed == 2);

    // The same size, other bytes, another write time: hashed again.
    write("thref");
    std::filesystem::last_write_time(file, std::filesystem::last_write_time(file) + std::chrono::seconds(5));
    CHECK(cache.get(file) == "h:thref" && computed == 3);
    CHECK(cache.get(file) == "h:thref" && computed == 3);

    // Gone: nothing, and nothing kept.
    std::filesystem::remove(file);
    CHECK(cache.get(file).empty() && computed == 3);
    write("one");
    CHECK(cache.get(file) == "h:one" && computed == 4);

    // A hash that couldn't be computed is not kept.
    updater::file_hash_cache failing([&](const std::filesystem::path&)
    {
        ++computed;
        return std::string{};
    });
    CHECK(failing.get(file).empty() && failing.get(file).empty() && computed == 6);

    std::error_code ignored;
    std::filesystem::remove_all(folder, ignored);
}
