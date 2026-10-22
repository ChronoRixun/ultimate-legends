#include "std_include.hpp"
#include "test.hpp"

#include "fix/online_launch.hpp"
#include "updater/patch_policy.hpp"
#include "updater/release_resolver.hpp"

#include <map>

// The update channel's discovery (updater/release_resolver.hpp) and the XML2 Fix's install rule
// (updater/patch_policy.hpp), run for real against an in-memory GitHub and property store: Stable and
// Beta keep their own last valid choice and fall back to it (never to the other channel's) when GitHub
// can't be asked; files come from the chosen release's tag even when "latest" moves; and an older fix is
// installed only with a consent for exactly that switch back, never from one approved earlier.
namespace
{
    using release_channel::channel;
    using release_resolver::http_answer;

    constexpr auto fix_repo = "ChronoRixun/xml2-fix";
    const std::vector<std::string> fix_files{"ultimate-legends.json"};

    std::string release_json(const std::string& tag, const bool prerelease, const std::vector<std::string>& assets = {"ultimate-legends.json"})
    {
        std::string files;
        for (const auto& name : assets)
        {
            files += std::format(R"({}{{"name":"{}","size":10,"browser_download_url":"https://github.com/{}/releases/download/{}/{}"}})",
                                 files.empty() ? "" : ",", name, fix_repo, tag, name);
        }
        return std::format(R"({{"tag_name":"{}","draft":false,"prerelease":{},"html_url":"https://github.com/{}/releases/tag/{}","assets":[{}]}})",
                           tag, prerelease ? "true" : "false", fix_repo, tag, files);
    }

    http_answer ok(const std::string& body)
    {
        return {true, {}, 200, body};
    }

    // GitHub and the launcher's properties, in memory.
    struct fake
    {
        std::map<std::string, http_answer> answers; // by URL
        std::map<std::string, std::string> properties;
        std::vector<std::string> asked;
        std::chrono::steady_clock::time_point clock{};

        release_resolver::io io()
        {
            return {
                [this](const std::string& url)
                {
                    this->asked.push_back(url);
                    const auto it = this->answers.find(url);
                    return it == this->answers.end() ? http_answer{false, "no connection", 0, {}} : it->second;
                },
                [this](const std::string& key) -> std::optional<std::string>
                {
                    const auto it = this->properties.find(key);
                    return it == this->properties.end() ? std::nullopt : std::optional(it->second);
                },
                [this](const std::string& key, const std::string& value)
                {
                    this->properties[key] = value;
                },
                [this]
                {
                    return this->clock;
                },
                []
                {
                    return std::string("https://api.github.com");
                },
            };
        }

        void latest(const http_answer& answer)
        {
            this->answers[std::string("https://api.github.com/repos/") + fix_repo + "/releases/latest"] = answer;
        }

        void list(const http_answer& answer)
        {
            this->answers[std::string("https://api.github.com/repos/") + fix_repo + "/releases?per_page=30"] = answer;
        }

        void later()
        {
            this->clock += std::chrono::minutes(11); // past the answers' reuse
        }
    };

    // patch_channel::resolve's manifest URL for a decision.
    std::string manifest_url(const patch_policy::decision& decision)
    {
        return release_channel::download_url(fix_repo, decision.chosen->tag, "ultimate-legends.json");
    }
}

// ---- discovery and its fallback ----

TEST(stable_falls_back_to_its_own_last_choice)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    auto found = resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(found.chosen && found.chosen->version == "1.7.1" && !found.from_cache && found.error.empty());

    // GitHub's rate limit, then its other limit, then no connection: the same choice, saying why.
    for (const auto& failure : {http_answer{true, {}, 403, "{\"message\":\"API rate limit exceeded\"}"}, http_answer{true, {}, 429, {}},
                                http_answer{false, "Could not resolve host", 0, {}}})
    {
        github.later();
        github.latest(failure);
        found = resolver.resolve(fix_repo, channel::stable, fix_files);
        CHECK(found.chosen && found.chosen->version == "1.7.1" && found.from_cache);
        CHECK(!found.error.empty());
    }
    CHECK(found.error.find("Could not reach GitHub") != std::string::npos);

    // A restart (a new resolver, the same properties) still has it.
    release_resolver::resolver restarted{github.io()};
    found = restarted.resolve(fix_repo, channel::stable, fix_files);
    CHECK(found.chosen && found.chosen->version == "1.7.1" && found.from_cache);
}

TEST(beta_falls_back_to_its_own_last_choice_never_stables)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    CHECK(resolver.resolve(fix_repo, channel::stable, fix_files).chosen);

    // First use of Beta, GitHub limited: no beta known - and Stable's choice is not used for it.
    github.list({true, {}, 403, {}});
    auto found = resolver.resolve(fix_repo, channel::beta, fix_files);
    CHECK(!found.chosen && !found.from_cache && found.error.find("HTTP 403") != std::string::npos);

    // A later retry that works; then GitHub fails again: that beta, from the last check.
    github.later();
    github.list(ok("[" + release_json("v1.8.0-beta.2", true) + "," + release_json("v1.7.1", false) + "]"));
    found = resolver.resolve(fix_repo, channel::beta, fix_files);
    CHECK(found.chosen && found.chosen->version == "1.8.0-beta.2" && !found.from_cache);
    github.later();
    github.list({false, "no connection", 0, {}});
    found = resolver.resolve(fix_repo, channel::beta, fix_files);
    CHECK(found.chosen && found.chosen->version == "1.8.0-beta.2" && found.from_cache);

    // And Stable, failing too, keeps Stable's (not the beta).
    github.later();
    github.latest({true, {}, 500, {}});
    found = resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(found.chosen && found.chosen->version == "1.7.1" && found.from_cache && found.error == "GitHub answered HTTP 500.");
}

TEST(a_bad_answer_is_a_failure_with_its_reason)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok("not json"));
    auto found = resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(!found.chosen && !found.error.empty());

    // The latest release still uploading its files is not a choice (and not cached).
    github.later();
    github.latest(ok(release_json("v1.7.2", false, {"dinput.dll"})));
    found = resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(!found.chosen && found.error.find("does not have all its files") != std::string::npos);
    CHECK(github.properties.empty());

    github.later();
    github.list(ok("{\"message\":\"Not Found\"}"));
    found = resolver.resolve(fix_repo, channel::beta, fix_files);
    CHECK(!found.chosen && !found.error.empty());
}

TEST(an_answer_is_reused_for_a_while_unless_forced)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    resolver.resolve(fix_repo, channel::stable, fix_files);
    resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(github.asked.size() == 1);
    resolver.resolve(fix_repo, channel::stable, fix_files, true);
    CHECK(github.asked.size() == 2);
    github.later();
    resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(github.asked.size() == 3);
}

TEST(files_come_from_the_chosen_tag_even_when_latest_moves)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    const auto found = resolver.resolve(fix_repo, channel::stable, fix_files);
    const auto decision = patch_policy::decide(std::string("1.7.0"), found, std::nullopt);
    CHECK(decision.what == patch_policy::action::install && decision.chosen->tag == "v1.7.1");

    // GitHub's latest becomes 1.7.2 after the choice: the manifest and the files it lists still come
    // from v1.7.1 (the folder URL is the manifest's), never from releases/latest.
    github.latest(ok(release_json("v1.7.2", false)));
    const auto manifest = manifest_url(decision);
    CHECK(manifest == "https://github.com/ChronoRixun/xml2-fix/releases/download/v1.7.1/ultimate-legends.json");
    CHECK(manifest.substr(0, manifest.rfind('/') + 1) == "https://github.com/ChronoRixun/xml2-fix/releases/download/v1.7.1/");
    CHECK(manifest.find("/latest/") == std::string::npos);

    // The builder's manifest and the launcher's files likewise (their zip and SHA256SUMS.txt are the
    // release's own browser_download_url, which GitHub gives by tag).
    CHECK(release_channel::download_url("ChronoRixun/legends-classic", "v0.3.0-beta.1", "xml1-builder.json") ==
          "https://github.com/ChronoRixun/legends-classic/releases/download/v0.3.0-beta.1/xml1-builder.json");
    std::string error;
    const auto launcher = release_channel::parse_release_json(release_json("v0.4.0", false, {"ultimate-legends-0.4.0-win64-portable.zip", "SHA256SUMS.txt"}), error);
    CHECK(launcher && launcher->find("SHA256SUMS.txt")->url.find("/releases/download/v0.4.0/") != std::string::npos);
}

// ---- the XML2 Fix: never older without the player's word for exactly that ----

TEST(stable_never_installs_an_older_fix_over_a_final_one)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    const auto found = resolver.resolve(fix_repo, channel::stable, fix_files);
    // A final 1.8.0 in the folder (from Beta, once it went final) and Stable still at 1.7.1.
    auto decision = patch_policy::decide(std::string("1.8.0"), found, std::nullopt);
    CHECK(decision.what == patch_policy::action::keep && !decision.chosen);
    decision = patch_policy::decide(std::string("1.7.1"), found, std::nullopt);
    CHECK(decision.what == patch_policy::action::install && !decision.downgrade); // the same: a repair
    decision = patch_policy::decide(std::nullopt, found, std::nullopt);
    CHECK(decision.what == patch_policy::action::install);                       // no fix yet
    decision = patch_policy::decide(std::string(""), found, std::nullopt);
    CHECK(decision.what == patch_policy::action::install);                       // a version that can't be read
}

TEST(a_switch_back_consent_counts_for_one_attempt_only)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    auto found = resolver.resolve(fix_repo, channel::stable, fix_files);
    const std::string beta = "1.8.0-beta.2";

    // Switch back approved: that attempt installs 1.7.1, by its tag.
    const patch_policy::consent approved{beta, "1.7.1"};
    auto decision = patch_policy::decide(beta, found, approved);
    CHECK(decision.what == patch_policy::action::install && decision.downgrade && decision.chosen->version == "1.7.1");
    CHECK(manifest_url(decision).find("/download/v1.7.1/") != std::string::npos);

    // The attempt fails or is cancelled (the folder still has the beta). Then: a restart, Beta and back
    // to Stable, Keep the beta - and a normal Play / Verify. Nothing carries the old approval: it keeps.
    release_resolver::resolver restarted{github.io()};
    github.later();
    found = restarted.resolve(fix_repo, channel::stable, fix_files);
    for (auto i = 0; i < 3; ++i)
    {
        decision = patch_policy::decide(beta, found, std::nullopt);
        CHECK(decision.what == patch_policy::action::keep && !decision.chosen && !decision.downgrade);
    }

    // A fresh approval, then a successful switch back: the folder has 1.7.1, and a later Play is a repair.
    decision = patch_policy::decide(beta, found, patch_policy::consent{beta, "1.7.1"});
    CHECK(decision.what == patch_policy::action::install && decision.downgrade);
    decision = patch_policy::decide(std::string("1.7.1"), found, std::nullopt);
    CHECK(decision.what == patch_policy::action::install && !decision.downgrade);
}

TEST(a_consent_is_for_exactly_its_folder_and_versions)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest(ok(release_json("v1.7.1", false)));
    const auto found = resolver.resolve(fix_repo, channel::stable, fix_files);

    // X-Men Legends II's folder has beta.2, the port's beta.1: the approval given for the one is not the other's.
    const patch_policy::consent xml2{"1.8.0-beta.2", "1.7.1"};
    CHECK(patch_policy::decide(std::string("1.8.0-beta.2"), found, xml2).downgrade);
    const auto port = patch_policy::decide(std::string("1.8.0-beta.1"), found, xml2);
    CHECK(port.what == patch_policy::action::keep && port.note.find("ask again") != std::string::npos);
    CHECK(patch_policy::decide(std::string("1.8.0-beta.1"), found, patch_policy::consent{"1.8.0-beta.1", "1.7.1"}).downgrade);

    // Stable moved on since the player was shown 1.7.1: not 1.7.0, not 1.7.2 - ask again.
    fake moved;
    release_resolver::resolver other{moved.io()};
    moved.latest(ok(release_json("v1.7.0", false)));
    const auto older = other.resolve(fix_repo, channel::stable, fix_files);
    CHECK(patch_policy::decide(std::string("1.8.0-beta.2"), older, xml2).what == patch_policy::action::keep);
}

TEST(beta_never_installs_an_older_cached_beta)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.list(ok("[" + release_json("v1.8.0-beta.1", true) + "]"));
    resolver.resolve(fix_repo, channel::beta, fix_files);
    github.later();
    github.list({true, {}, 429, {}});
    const auto found = resolver.resolve(fix_repo, channel::beta, fix_files);
    CHECK(found.from_cache);
    // The folder already has beta.2 (installed on another PC's check, or by hand): the cached beta.1 isn't installed.
    const auto decision = patch_policy::decide(std::string("1.8.0-beta.2"), found, std::nullopt);
    CHECK(decision.what == patch_policy::action::keep && decision.from_cache && decision.note.find("the last result") != std::string::npos);
}

TEST(no_choice_and_no_cache_installs_only_into_an_empty_folder)
{
    fake github;
    release_resolver::resolver resolver{github.io()};
    github.latest({true, {}, 403, {}});
    const auto found = resolver.resolve(fix_repo, channel::stable, fix_files);
    CHECK(!found.chosen);
    // No fix yet: the latest release's files, each still checked against the manifest's hash.
    CHECK(patch_policy::decide(std::nullopt, found, std::nullopt).what == patch_policy::action::install_latest);
    // A fix there: it stays, and says why.
    const auto kept = patch_policy::decide(std::string("1.7.1"), found, std::nullopt);
    CHECK(kept.what == patch_policy::action::keep && kept.note.find("HTTP 403") != std::string::npos);
    // Even a switch back: without a release to install it is nothing.
    CHECK(patch_policy::decide(std::string("1.8.0-beta.2"), found, patch_policy::consent{"1.8.0-beta.2", "1.7.1"}).what ==
          patch_policy::action::keep);
}

// ---- the companion releases' contracts ----

namespace
{
    // tools/freeze_builder.py's xml1-builder.json for `version`, with legends-classic's B2 correction
    // (owner, 2026-10-22): a beta or rc builder writes requires_xml2fix ">=1.8.0-0" (and the same
    // requires.xml2fix into a build's stamp); a stable builder keeps ">=1.8".
    std::string builder_manifest(const std::string& version, const std::string& requires_xml2fix)
    {
        return std::format(R"({{"version":"{}","content_version":24,"zip":"xml1-builder-{}-win64.zip","size":20971520,)"
                           R"("sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",)"
                           R"("min_launcher":"0.0.0","requires_xml2fix":"{}"}})",
                           version, version, requires_xml2fix);
    }
}

TEST(the_builder_manifest_of_legends_classic_0_3_0_beta_1)
{
    // The field set and values as emitted (exactly these seven keys; no leading v; the zip named by the version).
    const auto emitted = builder_manifest("0.3.0-beta.1", ">=1.8.0-0");
    rapidjson::Document manifest;
    manifest.Parse(emitted.data(), emitted.size());
    CHECK(!manifest.HasParseError() && manifest.IsObject() && manifest.MemberCount() == 7);
    for (const auto* key : {"version", "content_version", "zip", "size", "sha256", "min_launcher", "requires_xml2fix"})
    {
        CHECK(manifest.HasMember(key));
    }
    const std::string version = manifest["version"].GetString();
    CHECK(release_channel::is_prerelease(version) && version.front() != 'v');
    CHECK(std::string(manifest["zip"].GetString()) == "xml1-builder-" + version + "-win64.zip");
    CHECK(release_channel::tag_version("v0.3.0-beta.1") == version); // the tag's version is the manifest's
    CHECK(release_channel::satisfies("0.4.0", manifest["min_launcher"].GetString()));

    // A beta builder accepts the beta fix it ships with (the X-Men Legends page's stamp check, xml1_port's
    // fix.ok) - as online play does - and every later 1.8.0 pre-release and the release; not 1.7.x.
    const std::string requirement = manifest["requires_xml2fix"].GetString();
    CHECK(requirement == ">=1.8.0-0");
    for (const auto* fix : {"1.8.0-beta.1", "1.8.0-beta.2", "1.8.0-beta.10", "1.8.0-rc.1", "1.8.0", "1.8.0.0", "1.8.1"})
    {
        CHECK(release_channel::satisfies(fix, requirement));
    }
    CHECK(!release_channel::satisfies("1.7.1", requirement) && !release_channel::satisfies("1.7.9-beta.1", requirement));
    CHECK(online_launch::check_fix(std::string("1.8.0-beta.1")) == online_launch::fix_state::ok);
}

TEST(rc_and_stable_builders_require_their_fix)
{
    // An rc builder: the same pre-release bound.
    CHECK(release_channel::satisfies("1.8.0-beta.1", ">=1.8.0-0") && release_channel::tag_version("v0.3.0-rc.1") == "0.3.0-rc.1");
    rapidjson::Document rc;
    const auto rc_json = builder_manifest("0.3.0-rc.1", ">=1.8.0-0");
    rc.Parse(rc_json.data(), rc_json.size());
    CHECK(!rc.HasParseError() && std::string(rc["requires_xml2fix"].GetString()) == ">=1.8.0-0");

    // A stable builder keeps ">=1.8": the released fix (1.8.0, or the numeric 1.8.0.0 a DLL reads), never a beta.
    rapidjson::Document stable;
    const auto stable_json = builder_manifest("0.3.0", ">=1.8");
    stable.Parse(stable_json.data(), stable_json.size());
    const std::string requirement = stable["requires_xml2fix"].GetString();
    CHECK(!release_channel::is_prerelease(stable["version"].GetString()));
    CHECK(release_channel::satisfies("1.8.0", requirement) && release_channel::satisfies("1.8.0.0", requirement));
    CHECK(!release_channel::satisfies("1.8.0-beta.1", requirement) && !release_channel::satisfies("1.8.0-rc.1", requirement));
    CHECK(!release_channel::satisfies("1.7.1", requirement));

    // The launcher's comparison stays strict: an explicit >=1.8.0 never takes a pre-release.
    CHECK(!release_channel::satisfies("1.8.0-beta.1", ">=1.8.0"));
}

TEST(the_xml2_fix_manifest_stays_a_bare_array)
{
    // ultimate-legends.json, identical for stable, beta, rc and dev builds (xml2-fix feature/beta-tags
    // 58a61c4): no envelope, no version in it - the version is the chosen release's tag.
    const std::string emitted = R"([["dinput.dll",2647040,"0123456789ABCDEF0123456789ABCDEF01234567","game"]])";
    rapidjson::Document manifest;
    manifest.Parse(emitted.data(), emitted.size());
    CHECK(!manifest.HasParseError() && manifest.IsArray() && manifest.Size() == 1);
    const auto& entry = manifest[0];
    // client_updater's parse_file_infos: ["name", size, "sha1"(, ignored destination)].
    CHECK(entry.IsArray() && entry.Size() >= 3 && entry[0].IsString() && entry[1].IsInt64() && entry[2].IsString());
    CHECK(std::string(entry[2].GetString()).size() == 40);
}

// ---- release tags, stricter than DLL versions (L1) ----

TEST(release_tags_are_strict_dll_versions_are_not)
{
    CHECK(release_channel::tag_version("v01.8.0").empty());
    CHECK(release_channel::tag_version("v1.08.0").empty());
    CHECK(release_channel::tag_version("v1.8.0+..").empty());
    CHECK(release_channel::tag_version("v1.8.0+").empty());
    CHECK(release_channel::tag_version("v1.8.0+build.7") == "1.8.0+build.7");
    CHECK(release_channel::tag_version("v0.4.0") == "0.4.0" && release_channel::tag_version("v0.0.1") == "0.0.1");
    CHECK(release_channel::tag_version("v1.8.0-beta.10") == "1.8.0-beta.10");
    // A version resource: two or four numbers, read as before.
    CHECK(release_channel::is_version("1.8") && release_channel::is_version("1.8.0.2"));
    CHECK(release_channel::compare("1.8.0.0", "1.8.0") == 0);
    // SemVer precedence unchanged: beta.2 < beta.10 < rc.1 < final.
    CHECK(release_channel::compare("1.8.0-beta.2", "1.8.0-beta.10") < 0);
    CHECK(release_channel::compare("1.8.0-beta.10", "1.8.0-rc.1") < 0);
    CHECK(release_channel::compare("1.8.0-rc.1", "1.8.0") < 0);
}
