#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The update channel (Settings > Update channel) and the one rule every update path uses to pick a
// release of a GitHub repository with it: the launcher's self-update (this repo), the XML2 Fix
// (ChronoRixun/xml2-fix) and the Legends Classic builder (ChronoRixun/legends-classic).
//
//   stable (the default): GitHub's releases/latest, exactly as before - never a pre-release.
//   beta: GET /repos/{owner}/{repo}/releases?per_page=30, drafts and tags that aren't versions
//         skipped, the highest version by SemVer precedence (1.8.0-beta.1 < 1.8.0-beta.2 < 1.8.0),
//         stable releases included: when a beta becomes final, Beta moves to the final release.
//
// Files of a chosen release are downloaded by its tag (releases/download/<tag>/<asset>), never
// releases/latest, so what was resolved is what is installed. When GitHub can't be asked (offline,
// a rate limit), the last release resolved for the repository and channel is used, and the page
// says so (settle()). Nothing older than what is installed is ever installed unless the player said
// so (may_install()).
//
// No network, files or Windows here (release_source.hpp fetches and caches): the unit tests build it.
namespace release_channel
{
    enum class channel
    {
        stable,
        beta,
    };

    // "beta" (any case) is Beta; anything else, a missing setting included, is Stable.
    channel parse_channel(std::string_view text);
    const char* channel_name(channel value);

    // ---- versions ----

    // A version: 1 to 4 numbers ("1.8", "1.8.0", "1.8.0.2"), then an optional SemVer pre-release
    // ("-beta.2") and build ("+abc", ignored). No leading "v": tag_version() takes it off a tag.
    struct version
    {
        std::vector<std::uint64_t> core;
        std::vector<std::string> pre; // "beta", "2"; empty for a release
    };
    std::optional<version> parse_version(std::string_view text);

    // The version a tag names ("v1.8.0-beta.1" -> "1.8.0-beta.1"); empty when it names none.
    std::string tag_version(std::string_view tag);
    bool is_version(std::string_view text);
    bool is_prerelease(std::string_view text);

    // SemVer precedence: <0, 0, >0. A missing number counts as 0 ("1.0" == "1.0.0"); a pre-release
    // is below its release; pre-release identifiers compare numerically when both are numbers, else
    // as ASCII text, and a longer list wins a tie ("beta" < "beta.1" < "beta.2" < "beta.10" < "rc.1").
    // Text that isn't a version compares by its leading numbers, as the launcher always did.
    int compare(std::string_view a, std::string_view b);

    // Whether `version` meets `requirement`: ">=1.7.1", ">1.7", "<=2", "<2", "=1.8.0", "==1.8.0", or a
    // bare "1.7.1" (meaning >=); several, separated by spaces or commas, must all hold. An empty
    // requirement always holds; a version that isn't one never does. 1.8.0-beta.2 meets ">=1.7.1"
    // but not ">=1.8.0".
    bool satisfies(std::string_view version, std::string_view requirement);

    // ---- releases ----

    struct asset
    {
        std::string name;
        std::string url; // browser_download_url
        std::uint64_t size{};
    };

    struct release
    {
        std::string tag;     // "v1.8.0-beta.1"
        std::string version; // "1.8.0-beta.1"
        bool prerelease{};   // GitHub's flag (the version's own "-..." is what orders it)
        bool draft{};
        std::string page; // html_url (https only)
        std::vector<asset> assets;

        const asset* find(std::string_view name) const;
    };

    // GitHub's answers: one release (releases/latest) or a list (releases?per_page=30). A release
    // whose tag isn't a version is left out (and a list goes on with the next one); nullopt / an
    // empty list with `error` set when the answer isn't one at all.
    std::optional<release> parse_release_json(std::string_view json, std::string& error);
    std::vector<release> parse_releases_json(std::string_view json, std::string& error);

    // Beta's pick from a list: the highest version that is not a draft and has every asset in
    // `required` (a release still uploading its files isn't one yet; "{version}" in a name stands for
    // the release's version: "ultimate-legends-{version}-win64-portable.zip"). Stable's: the same among
    // releases that are neither pre-releases by flag nor by version (releases/latest is what Stable
    // really uses; this is for a list a test or a cache holds).
    std::optional<release> pick(channel value, const std::vector<release>& releases, const std::vector<std::string>& required);

    // https://github.com/<repo>/releases/download/<tag>/<file> and .../releases/latest/download/<file>;
    // `repo` is "owner/name".
    std::string download_url(std::string_view repo, std::string_view tag, std::string_view file);
    std::string latest_download_url(std::string_view repo, std::string_view file);

    // A resolved release, kept so an offline or rate-limited start can still name it.
    std::string to_json(const release& value);
    std::optional<release> release_from_json(std::string_view json);

    // ---- one resolution ----

    struct outcome
    {
        std::optional<release> chosen;
        bool from_cache{}; // GitHub couldn't be asked: the last release resolved for this channel
        std::string error; // why GitHub couldn't be asked (also set with from_cache, for the page)
    };

    // What a resolution ends with: the fetched release, else the cached one (saying why), else the
    // error. A cache from the other channel is never used.
    outcome settle(std::optional<release> fetched, const std::string& fetch_error, const std::optional<release>& cached);

    // ---- installing ----

    // Whether `target` may replace `installed` ("" = nothing installed): yes when nothing is there,
    // when it is the same version (a repair) or newer; an older one only when the player chose it
    // (Switch back to Stable). Never a silent downgrade.
    bool may_install(std::string_view installed, std::string_view target, bool downgrade_confirmed);

    // The installed item is a pre-release newer than `stable`: what the switch-back prompt is for.
    bool is_ahead_of(std::string_view installed, std::string_view stable);

    // The XML2 Fix's own version resource is numeric (1.8.0-beta.2 says 1.8.0), so the release
    // the launcher installed is recorded with the SHA-1 of the file it put there; while the file
    // is still that one, the recorded version is the version. Else (replaced by hand, another
    // install, no record) the version resource is.
    struct patch_record
    {
        std::string version;
        std::string sha1; // lower-case hex
    };
    std::optional<std::string> effective_patch_version(const std::optional<std::string>& dll_version,
                                                       const std::optional<patch_record>& record, std::string_view dll_sha1);
}
