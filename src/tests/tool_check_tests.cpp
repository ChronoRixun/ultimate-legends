#include "std_include.hpp"
#include "test.hpp"

#include "tools/tool_install.hpp"

// A builder zip the player already has (issue #4) is measured against the release's manifest
// exactly like a download: its size and its SHA-256. These are the decisions on what was measured.
namespace
{
    using tool_install::zip_match;

    const auto release_sha = std::string(64, 'a');

    tool_install::manifest release()
    {
        tool_install::manifest manifest{};
        manifest.version = "1.1.0";
        manifest.zip = "xml1-builder-1.1.0-win64.zip";
        manifest.size = 20971520;
        manifest.sha256 = release_sha;
        return manifest;
    }

    tool_install::zip_facts zip(const std::string& name, const std::uint64_t size, const std::string& sha256)
    {
        return {name, size, sha256};
    }
}

TEST(the_release_zip_matches)
{
    CHECK(tool_install::match_zip(release(), zip("xml1-builder-1.1.0-win64.zip", 20971520, release_sha)) == zip_match::same);
    CHECK(tool_install::describe_zip_match(release(), zip("xml1-builder-1.1.0-win64.zip", 20971520, release_sha), zip_match::same).empty());
}

TEST(the_name_does_not_matter_when_the_bytes_match)
{
    // A browser's "xml1-builder-1.1.0-win64 (1).zip" is still the release's file.
    CHECK(tool_install::match_zip(release(), zip("xml1-builder-1.1.0-win64 (1).zip", 20971520, release_sha)) == zip_match::same);
}

TEST(a_wrong_hash_is_refused_whatever_the_name)
{
    const auto other = std::string(64, 'b');
    CHECK(tool_install::match_zip(release(), zip("xml1-builder-1.1.0-win64.zip", 20971520, other)) == zip_match::other_hash);
    CHECK(tool_install::match_zip(release(), zip("builder.zip", 20971520, other)) == zip_match::other_hash);
    // Not hashed (the size already differed): never the release's file.
    CHECK(tool_install::match_zip(release(), zip("xml1-builder-1.1.0-win64.zip", 20971520, "")) == zip_match::other_hash);
    const auto text = tool_install::describe_zip_match(release(), zip("builder.zip", 20971520, other), zip_match::other_hash);
    CHECK(text.find("SHA-256") != std::string::npos && text.find("not installed") != std::string::npos);
}

TEST(a_wrong_size_is_refused)
{
    const auto facts = zip("xml1-builder-1.1.0-win64.zip", 1000, "");
    CHECK(tool_install::match_zip(release(), facts) == zip_match::other_size);
    const auto text = tool_install::describe_zip_match(release(), facts, zip_match::other_size);
    CHECK(text.find("1000 bytes") != std::string::npos && text.find("20971520") != std::string::npos);
}

TEST(an_older_zip_says_which_versions)
{
    const auto facts = zip("xml1-builder-1.0.0-win64.zip", 18000000, "");
    CHECK(tool_install::match_zip(release(), facts) == zip_match::older);
    const auto text = tool_install::describe_zip_match(release(), facts, zip_match::older);
    CHECK(text.find("1.0.0") != std::string::npos && text.find("older") != std::string::npos);
    CHECK(text.find("1.1.0") != std::string::npos && text.find("xml1-builder-1.1.0-win64.zip") != std::string::npos);
    // Older by its name even when its size happens to be the release's.
    CHECK(tool_install::match_zip(release(), zip("xml1-builder-1.0.9-win64.zip", 20971520, std::string(64, 'c'))) == zip_match::older);
    CHECK(tool_install::match_zip(release(), zip("XML1-Builder-1.0.0-WIN64.ZIP", 1, "")) == zip_match::older);
}

TEST(a_newer_zip_than_the_release_is_refused)
{
    const auto facts = zip("xml1-builder-1.10.0-win64.zip", 1, "");
    CHECK(tool_install::match_zip(release(), facts) == zip_match::newer);
    CHECK(tool_install::describe_zip_match(release(), facts, zip_match::newer).find("1.10.0") != std::string::npos);
}

TEST(the_version_in_a_zip_name)
{
    CHECK(tool_install::version_in_zip_name(release(), "xml1-builder-1.0.0-win64.zip") == "1.0.0");
    CHECK(tool_install::version_in_zip_name(release(), "xml1-builder-2.0.0-rc1-win64.zip") == "2.0.0-rc1");
    CHECK(tool_install::version_in_zip_name(release(), "xml1-builder-1.0.0-win64 (1).zip").empty());
    CHECK(tool_install::version_in_zip_name(release(), "xml1-builder--win64.zip").empty());
    CHECK(tool_install::version_in_zip_name(release(), "xml1-builder-..-win64.zip").empty());
    CHECK(tool_install::version_in_zip_name(release(), "other-1.0.0-win64.zip").empty());
    auto unversioned = release();
    unversioned.zip = "xml1-builder.zip";
    CHECK(tool_install::version_in_zip_name(unversioned, "xml1-builder.zip").empty());
}

TEST(versions_compare_numerically)
{
    CHECK(tool_install::compare_versions("1.10.0", "1.9.2") > 0);
    CHECK(tool_install::compare_versions("1.0", "1.0.0") == 0);
    CHECK(tool_install::compare_versions("1.2.0-beta", "1.2.0") == 0);
    CHECK(tool_install::compare_versions("0.9.0", "1.0.0") < 0);
    CHECK(tool_install::is_safe_version("1.0.0") && !tool_install::is_safe_version("../1") && !tool_install::is_safe_version(""));
}

TEST(a_damaged_zip_in_the_tools_folder_does_not_hide_the_one_in_downloads)
{
    // find_local_zip looks in tools\xml1-builder, then Downloads: the first that is the release's zip is used.
    const std::filesystem::path tools_zip = "tools/xml1-builder/xml1-builder-1.1.0-win64.zip";
    const std::filesystem::path downloads_zip = "Downloads/xml1-builder-1.1.0-win64.zip";
    std::vector<std::filesystem::path> measured;
    std::vector<std::string> rejected;
    const auto picked = tool_install::pick_local_zip(release(), {tools_zip, downloads_zip}, [&](const std::filesystem::path& file)
    {
        measured.push_back(file);
        return std::optional{zip(file.filename().string(), 20971520, file == tools_zip ? std::string(64, 'b') : release_sha)};
    }, [&](const std::filesystem::path& file, const std::string& reason)
    {
        rejected.push_back(file.string() + ": " + reason);
    });
    CHECK(picked == downloads_zip);
    CHECK(measured.size() == 2);
    CHECK(rejected.size() == 1 && rejected[0].find("tools/xml1-builder") != std::string::npos && rejected[0].find("SHA-256") != std::string::npos);
}

TEST(a_local_zip_is_picked_in_order_or_none_is)
{
    const std::filesystem::path tools_zip = "tools/xml1-builder/xml1-builder-1.1.0-win64.zip";
    const std::filesystem::path downloads_zip = "Downloads/xml1-builder-1.1.0-win64.zip";
    int measured = 0;
    std::vector<std::string> rejected;
    const auto on_rejected = [&](const std::filesystem::path&, const std::string& reason)
    {
        rejected.push_back(reason);
    };

    // Both good: the tools folder's, and Downloads isn't read.
    auto picked = tool_install::pick_local_zip(release(), {tools_zip, downloads_zip}, [&](const std::filesystem::path& file)
    {
        ++measured;
        return std::optional{zip(file.filename().string(), 20971520, release_sha)};
    }, on_rejected);
    CHECK(picked == tools_zip && measured == 1 && rejected.empty());

    // Unreadable, then incomplete: none, each with its reason (the release is downloaded).
    picked = tool_install::pick_local_zip(release(), {tools_zip, downloads_zip}, [&](const std::filesystem::path& file)
    {
        return file == tools_zip ? std::optional<tool_install::zip_facts>{} : std::optional{zip(file.filename().string(), 1000, "")};
    }, on_rejected);
    CHECK(!picked);
    CHECK(rejected.size() == 2 && rejected[0].find("could not be read") != std::string::npos
          && rejected[1].find("1000 bytes") != std::string::npos);

    CHECK(!tool_install::pick_local_zip(release(), {}, [](const std::filesystem::path&) { return std::optional<tool_install::zip_facts>{}; },
                                        on_rejected));
}
