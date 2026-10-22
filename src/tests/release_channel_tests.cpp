#include "std_include.hpp"
#include "test.hpp"

#include "tools/tool_install.hpp"
#include "updater/release_channel.hpp"

// The update channel's one rule (updater/release_channel.hpp): SemVer order, which release Stable
// and Beta take from GitHub's answers, the cache when GitHub can't be asked, and never a silent
// downgrade.
namespace
{
    using release_channel::channel;

    // One entry of GitHub's /releases list (or the /releases/latest answer).
    std::string release_json(const std::string& tag, const bool prerelease, const bool draft = false,
                             const std::vector<std::string>& assets = {"ultimate-legends.json"})
    {
        std::string files;
        for (const auto& name : assets)
        {
            files += std::format(R"({}{{"name":"{}","size":10,"browser_download_url":"https://github.com/ChronoRixun/xml2-fix/releases/download/{}/{}"}})",
                                 files.empty() ? "" : ",", name, tag, name);
        }
        return std::format(R"({{"tag_name":"{}","draft":{},"prerelease":{},"html_url":"https://github.com/ChronoRixun/xml2-fix/releases/tag/{}","assets":[{}]}})",
                           tag, draft ? "true" : "false", prerelease ? "true" : "false", tag, files);
    }

    std::string list_json(const std::vector<std::string>& entries)
    {
        std::string out = "[";
        for (std::size_t i = 0; i < entries.size(); ++i)
        {
            out += (i ? "," : "") + entries[i];
        }
        return out + "]";
    }

    std::optional<release_channel::release> beta_pick(const std::string& json, const std::vector<std::string>& required = {"ultimate-legends.json"})
    {
        std::string error;
        const auto releases = release_channel::parse_releases_json(json, error);
        return release_channel::pick(channel::beta, releases, required);
    }
}

TEST(semver_orders_pre_releases_below_their_release)
{
    using release_channel::compare;
    CHECK(compare("1.8.0-beta.1", "1.8.0-beta.2") < 0);
    CHECK(compare("1.8.0-beta.2", "1.8.0") < 0);
    CHECK(compare("1.8.0", "1.8.0-beta.2") > 0);
    CHECK(compare("1.8.0-beta.2", "1.7.1") > 0);
    CHECK(compare("1.8.0-beta.2", "1.8.0-beta.10") < 0); // numerically, not as text
    CHECK(compare("1.8.0-beta", "1.8.0-beta.1") < 0);    // a longer list wins a tie
    CHECK(compare("1.8.0-alpha.3", "1.8.0-beta.1") < 0);
    CHECK(compare("1.8.0-beta.9", "1.8.0-rc.1") < 0);
    CHECK(compare("1.8.0-1", "1.8.0-beta") < 0);           // a number ranks below text
    CHECK(compare("1.8.0+abc", "1.8.0") == 0);               // build metadata doesn't order
    CHECK(compare("1.8", "1.8.0") == 0);
    CHECK(compare("1.8.0.1", "1.8.0") > 0);                  // a version resource's fourth part
    CHECK(compare("1.10.0", "1.9.9") > 0);
    // Text that isn't a version still orders by its numbers, as before.
    CHECK(compare("dev", "dev") == 0);
}

TEST(semver_parses_versions_and_tags)
{
    CHECK(release_channel::tag_version("v1.8.0-beta.1") == "1.8.0-beta.1");
    CHECK(release_channel::tag_version("V0.4.0") == "0.4.0");
    CHECK(release_channel::tag_version("1.7.1") == "1.7.1");
    CHECK(release_channel::tag_version("latest").empty());
    CHECK(release_channel::tag_version("v1.8.0-").empty());
    CHECK(release_channel::tag_version("v1..0").empty());
    CHECK(release_channel::tag_version("v1.8.0-beta..1").empty());
    CHECK(release_channel::tag_version("v1.8.0-beta.01").empty()); // SemVer: no leading zeros
    CHECK(release_channel::tag_version("v1.8.0 beta").empty());
    CHECK(release_channel::tag_version("v1.2.3.4.5").empty());
    CHECK(release_channel::is_prerelease("1.8.0-beta.2") && !release_channel::is_prerelease("1.8.0"));
    CHECK(release_channel::parse_channel("beta") == channel::beta && release_channel::parse_channel("BETA") == channel::beta);
    CHECK(release_channel::parse_channel("") == channel::stable && release_channel::parse_channel("nightly") == channel::stable);
}

TEST(requirements_understand_pre_releases)
{
    using release_channel::satisfies;
    // The owner's example: a beta fix meets >=1.7.1 but not >=1.8.0.
    CHECK(satisfies("1.8.0-beta.2", ">=1.7.1"));
    CHECK(!satisfies("1.8.0-beta.2", ">=1.8.0"));
    CHECK(satisfies("1.8.0", ">=1.8.0"));
    CHECK(satisfies("1.8.0", "1.8.0"));            // bare: at least
    CHECK(satisfies("1.8.0-beta.2", ">=1.8.0-beta.1"));
    CHECK(satisfies("1.8.0", ">=1.7.1 <2.0.0") && !satisfies("2.0.0", ">=1.7.1, <2.0.0"));
    CHECK(satisfies("1.8.0.0", ">= 1.7.1") && !satisfies("1.8.0-beta.2", ">= 1.8.0")); // a DLL's four parts; a spaced operator
    CHECK(satisfies("1.7.1", "=1.7.1") && satisfies("1.7.1", "==1.7.1") && !satisfies("1.7.2", "=1.7.1"));
    CHECK(satisfies("1.7.0", "") && !satisfies("", ">=1.0.0") && !satisfies("dev", ">=1.0.0"));
    // min_launcher: a beta launcher is not yet the release it leads to.
    CHECK(tool_install::compare_versions("0.5.0-beta.1", "0.5.0") < 0);
    CHECK(tool_install::compare_versions("0.5.0-beta.1", "0.4.0") >= 0);
}

TEST(channel_stable_only_releases)
{
    // Only stable releases: Beta takes the highest, as Stable would.
    const auto picked = beta_pick(list_json({release_json("v1.7.1", false), release_json("v1.7.0", false), release_json("v1.6.0", false)}));
    CHECK(picked && picked->version == "1.7.1" && picked->tag == "v1.7.1");
}

TEST(channel_beta_newer_than_stable)
{
    const auto json = list_json({release_json("v1.8.0-beta.1", true), release_json("v1.8.0-beta.2", true), release_json("v1.7.1", false)});
    const auto picked = beta_pick(json);
    CHECK(picked && picked->version == "1.8.0-beta.2" && picked->prerelease);
    // Its files are fetched by its tag, never releases/latest.
    CHECK(release_channel::download_url("ChronoRixun/xml2-fix", picked->tag, "ultimate-legends.json") ==
          "https://github.com/ChronoRixun/xml2-fix/releases/download/v1.8.0-beta.2/ultimate-legends.json");
    // Stable never takes a pre-release from a list.
    std::string error;
    const auto stable = release_channel::pick(channel::stable, release_channel::parse_releases_json(json, error), {});
    CHECK(stable && stable->version == "1.7.1");
}

TEST(channel_beta_older_than_stable)
{
    // The beta became final (or an old beta is still listed): Beta moves to the release.
    const auto picked = beta_pick(list_json({release_json("v1.8.0-beta.2", true), release_json("v1.8.0", false), release_json("v1.7.1", false)}));
    CHECK(picked && picked->version == "1.8.0" && !picked->prerelease);
    const auto older = beta_pick(list_json({release_json("v1.7.0-beta.3", true), release_json("v1.7.1", false)}));
    CHECK(older && older->version == "1.7.1");
}

TEST(channel_needs_the_release_files)
{
    // The launcher's zip is named by the version: a beta still uploading it isn't taken yet.
    const std::vector<std::string> launcher_files{"ultimate-legends-{version}-win64-portable.zip", "SHA256SUMS.txt"};
    const auto json = list_json({release_json("v0.5.0-beta.2", true, false, {"SHA256SUMS.txt"}),
                                 release_json("v0.5.0-beta.1", true, false, {"ultimate-legends-0.5.0-beta.1-win64-portable.zip", "SHA256SUMS.txt"}),
                                 release_json("v0.4.0", false, false, {"ultimate-legends-0.4.0-win64-portable.zip", "SHA256SUMS.txt"})});
    const auto picked = beta_pick(json, launcher_files);
    CHECK(picked && picked->version == "0.5.0-beta.1");
}

TEST(channel_skips_drafts)
{
    const auto picked = beta_pick(list_json({release_json("v1.9.0-beta.1", true, true), release_json("v1.8.0", false)}));
    CHECK(picked && picked->version == "1.8.0");
}

TEST(channel_ignores_malformed_tags_and_entries)
{
    const auto json = list_json({R"({"tag_name":"nightly","prerelease":true,"assets":[{"name":"ultimate-legends.json"}]})",
                                 R"({"tag_name":"v2.0","prerelease":false})", // no manifest: still uploading
                                 R"({"draft":false})", R"("not an object")", R"({"tag_name":42})",
                                 release_json("v1.8.0-beta..1", true), release_json("v1.8.0-beta.1", true)});
    const auto picked = beta_pick(json);
    CHECK(picked && picked->version == "1.8.0-beta.1");

    std::string error;
    CHECK(release_channel::parse_releases_json("{\"message\":\"API rate limit exceeded\"}", error).empty() && !error.empty());
    error.clear();
    CHECK(!release_channel::parse_release_json(R"({"tag_name":"build-7"})", error) && !error.empty());
    CHECK(!beta_pick("[]"));
}

TEST(channel_parses_the_latest_release)
{
    std::string error;
    const auto latest = release_channel::parse_release_json(release_json("v1.7.1", false, false, {"ultimate-legends.json", "dinput.dll"}), error);
    CHECK(latest && latest->version == "1.7.1" && latest->find("dinput.dll") && latest->find("dinput.dll")->size == 10);
    CHECK(latest && latest->page == "https://github.com/ChronoRixun/xml2-fix/releases/tag/v1.7.1");
    CHECK(release_channel::latest_download_url("ChronoRixun/legends-classic", "xml1-builder.json") ==
          "https://github.com/ChronoRixun/legends-classic/releases/latest/download/xml1-builder.json");
}

TEST(channel_falls_back_to_the_cached_choice)
{
    std::string error;
    const auto cached = release_channel::parse_release_json(release_json("v1.8.0-beta.1", true), error);
    CHECK(cached.has_value());

    // The cache round-trips (it is kept as JSON in the launcher's properties).
    const auto restored = release_channel::release_from_json(release_channel::to_json(*cached));
    CHECK(restored && restored->tag == "v1.8.0-beta.1" && restored->prerelease && restored->find("ultimate-legends.json"));
    CHECK(!release_channel::release_from_json(""));

    // Offline / rate-limited: the cached choice, and why.
    auto outcome = release_channel::settle(std::nullopt, "GitHub's API rate limit was reached (HTTP 403).", restored);
    CHECK(outcome.chosen && outcome.from_cache && outcome.chosen->version == "1.8.0-beta.1");
    CHECK(outcome.error.find("rate limit") != std::string::npos);

    // No cache: the error alone.
    outcome = release_channel::settle(std::nullopt, "no connection", std::nullopt);
    CHECK(!outcome.chosen && !outcome.from_cache && outcome.error == "no connection");

    // Fetched: the cache is not used.
    const auto fresh = release_channel::parse_release_json(release_json("v1.8.0-beta.2", true), error);
    outcome = release_channel::settle(fresh, "", restored);
    CHECK(outcome.chosen && !outcome.from_cache && outcome.chosen->version == "1.8.0-beta.2" && outcome.error.empty());
}

TEST(never_a_silent_downgrade)
{
    using release_channel::may_install;
    CHECK(may_install("", "1.7.1", false));                 // nothing there
    CHECK(may_install("1.7.1", "1.8.0-beta.1", false));     // newer
    CHECK(may_install("1.8.0-beta.2", "1.8.0", false));     // the final release
    CHECK(may_install("1.8.0-beta.2", "1.8.0-beta.2", false)); // a repair
    CHECK(!may_install("1.8.0-beta.2", "1.7.1", false));    // Stable after Beta: only when asked
    CHECK(may_install("1.8.0-beta.2", "1.7.1", true));
    CHECK(!may_install("1.8.0-beta.2", "1.8.0-beta.1", false)); // a stale cache on Beta

    CHECK(release_channel::is_ahead_of("1.8.0-beta.2", "1.7.1"));
    CHECK(!release_channel::is_ahead_of("1.8.0-beta.2", "1.8.0"));
    CHECK(!release_channel::is_ahead_of("1.7.1", "1.7.1"));
    CHECK(!release_channel::is_ahead_of("1.8.0-beta.2", ""));
}

TEST(the_fix_version_comes_from_the_recorded_release)
{
    using release_channel::effective_patch_version;
    const release_channel::patch_record beta{"1.8.0-beta.2", "aaaa"};
    // The file the launcher installed: its release's version, not the numeric resource.
    CHECK(effective_patch_version(std::string("1.8.0"), beta, "aaaa") == std::optional<std::string>("1.8.0-beta.2"));
    // Replaced since (by hand, or another release): the resource.
    CHECK(effective_patch_version(std::string("1.8.0"), beta, "bbbb") == std::optional<std::string>("1.8.0"));
    CHECK(effective_patch_version(std::string("1.7.1"), std::nullopt, "aaaa") == std::optional<std::string>("1.7.1"));
    CHECK(effective_patch_version(std::string(""), std::nullopt, "") == std::optional<std::string>(""));
    // No DLL: none.
    CHECK(!effective_patch_version(std::nullopt, beta, "aaaa").has_value());
    // So a requirement of >=1.8.0 refuses a 1.8.0 beta that reads 1.8.0 (the online check takes 1.8.0's
    // pre-releases on purpose: >=1.8.0-0).
    CHECK(!release_channel::satisfies(*effective_patch_version(std::string("1.8.0"), beta, "aaaa"), ">=1.8.0"));
    CHECK(release_channel::satisfies(*effective_patch_version(std::string("1.8.0"), beta, "aaaa"), ">=1.8.0-0"));
    CHECK(!release_channel::satisfies("1.7.9", ">=1.8.0-0"));
}

TEST(the_launcher_version_comes_from_its_tag)
{
    using release_channel::launcher_build;
    // A stable release tag, as before.
    auto build = launcher_build("v0.4.0", "v0.4.0", "0.4.0");
    CHECK(build.version == "0.4.0" && build.release && !build.prerelease);
    // A beta tag: the suffix stays (VERSION_PRODUCT, the VERSIONINFO's, has only the numbers).
    build = launcher_build("v0.5.0-beta.1", "v0.5.0-beta.1", "0.5.0");
    CHECK(build.version == "0.5.0-beta.1" && build.release && build.prerelease);
    CHECK(tool_install::compare_versions(build.version, "0.5.0") < 0); // not yet the 0.5.0 a builder may need
    build = launcher_build("v0.5.0-rc.2", "v0.5.0-rc.2", "0.5.0");
    CHECK(build.version == "0.5.0-rc.2" && build.release && build.prerelease);
    // Commits after the tag, or uncommitted changes: a development build, still that version.
    build = launcher_build("v0.5.0-beta.1-3-gabc1234", "v0.5.0-beta.1", "0.5.0");
    CHECK(build.version == "0.5.0-beta.1" && !build.release && build.prerelease);
    build = launcher_build("v0.4.0-dirty", "v0.4.0", "0.4.0");
    CHECK(build.version == "0.4.0" && !build.release);
    // No tag at all.
    build = launcher_build("abc1234", "", "0.0.0");
    CHECK(build.version == "0.0.0" && !build.release && !build.prerelease);
}
