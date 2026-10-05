#include "std_include.hpp"
#include "patch_status.hpp"

#include "tools/tool_install.hpp"

#include <utils/flags.hpp>
#include <utils/http.hpp>
#include <utils/logger.hpp>
#include <utils/string.hpp>

#include <chrono>
#include <cstddef>
#include <thread>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "version.lib")

namespace patch_status
{
    namespace
    {
        using clock = std::chrono::steady_clock;

        // A successful check holds for an hour; a failed one is retried sooner.
        constexpr auto recheck_after = std::chrono::hours(1);
        constexpr auto retry_after = std::chrono::minutes(10);

        // The file a patch release must carry for client_updater to install it (the release's
        // workflow uploads it last): until it is there, the release isn't offered.
        constexpr auto patch_manifest_name = "ultimate-legends.json";

        struct release_check
        {
            bool checking = false;
            std::optional<clock::time_point> checked;
            bool failed = false;
            std::string version; // empty until a check found a release
            std::string page;
        };

        std::mutex mutex_;
        std::unordered_map<std::string, release_check> checks_; // by release URL

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        std::string json_string(const rapidjson::Value& object, const char* key)
        {
            if (!object.IsObject())
            {
                return {};
            }
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }

        // A release version: numbers and dots only ("1.2.0"), so compare_versions() orders it exactly.
        bool is_release_version(const std::string& version)
        {
            return !version.empty() && version.size() <= 32 && std::isdigit(static_cast<unsigned char>(version.front())) &&
                   std::isdigit(static_cast<unsigned char>(version.back())) && version.find("..") == std::string::npos &&
                   std::all_of(version.begin(), version.end(), [](const char c)
                   {
                       return std::isdigit(static_cast<unsigned char>(c)) || c == '.';
                   });
        }

        // The patch release the file says it is: "1.1.0" from FILEVERSION 1,1,0,0 (a fourth part
        // only when it isn't 0); "" when the file has no version resource; nullopt when it isn't there.
        std::optional<std::string> installed_version(const std::filesystem::path& file)
        {
            std::error_code error;
            if (!std::filesystem::is_regular_file(file, error))
            {
                return std::nullopt;
            }

            DWORD ignored = 0;
            const auto size = GetFileVersionInfoSizeW(file.c_str(), &ignored);
            if (!size)
            {
                return std::string{};
            }
            std::vector<std::byte> data(size);
            VS_FIXEDFILEINFO* info = nullptr;
            UINT length = 0;
            if (!GetFileVersionInfoW(file.c_str(), 0, size, data.data()) ||
                !VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &length) || !info || length < sizeof(VS_FIXEDFILEINFO))
            {
                return std::string{};
            }

            const auto major = HIWORD(info->dwFileVersionMS);
            const auto minor = LOWORD(info->dwFileVersionMS);
            const auto patch = HIWORD(info->dwFileVersionLS);
            const auto build = LOWORD(info->dwFileVersionLS);
            return build ? std::format("{}.{}.{}.{}", major, minor, patch, build) : std::format("{}.{}.{}", major, minor, patch);
        }

        // GitHub's latest release of the patch: its version (the tag without its "v") and page, when
        // the release carries the patch manifest.
        bool fetch_latest(const std::string& url, std::string& version, std::string& page)
        {
            const utils::http::headers headers{
                {"Accept", "application/vnd.github+json"},
                {"User-Agent", "ultimate-legends-launcher"},
                {"X-GitHub-Api-Version", "2022-11-28"},
            };
            const auto result = utils::http::get_data(url, {}, headers, {}, 15, 1);
            if (!result || result->code != CURLE_OK || result->response_code != 200)
            {
                const std::string reason = !result ? "no connection"
                                           : result->code != CURLE_OK ? curl_easy_strerror(result->code)
                                                                      : std::format("HTTP {}", result->response_code);
                utils::logger::write("Patch release check failed: {} ({})", url, reason);
                return false;
            }

            rapidjson::Document document;
            document.Parse(result->buffer.data(), result->buffer.size());
            if (document.HasParseError() || !document.IsObject())
            {
                utils::logger::write("Patch release check: {} isn't a release", url);
                return false;
            }

            const auto tag = json_string(document, "tag_name");
            const auto tag_version = tag.starts_with('v') || tag.starts_with('V') ? tag.substr(1) : tag;
            if (!is_release_version(tag_version))
            {
                utils::logger::write("Patch release check: tag {} is not a plain version number", tag);
                return false;
            }

            auto published = false;
            if (document.HasMember("assets") && document["assets"].IsArray())
            {
                for (const auto& asset : document["assets"].GetArray())
                {
                    published = published || json_string(asset, "name") == patch_manifest_name;
                }
            }
            if (!published)
            {
                utils::logger::write("Patch release check: {} has no {} (yet)", tag, patch_manifest_name);
                return false;
            }

            version = tag_version;
            page = json_string(document, "html_url");
            if (!page.starts_with("https://"))
            {
                page.clear();
            }
            return true;
        }

        // Starts a background check of `url` when none is running and the last one is stale.
        // Called with mutex_ held.
        void check_if_stale(const std::string& url, release_check& check)
        {
            const auto now = clock::now();
            if (check.checking || (check.checked && now - *check.checked < (check.failed ? retry_after : recheck_after)))
            {
                return;
            }

            check.checking = true;
            std::thread([url]
            {
                std::string version;
                std::string page;
                const auto ok = fetch_latest(url, version, page);

                std::lock_guard lock(mutex_);
                auto& done = checks_[url];
                done.checking = false;
                done.checked = clock::now();
                done.failed = !ok;
                if (ok)
                {
                    done.version = version;
                    done.page = page;
                }
            }).detach();
        }
    }

    void write_status(const game_config::game_config_t& config, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
    {
        out.SetNull();
        if (config.patch_file.empty())
        {
            return;
        }

        std::optional<std::string> installed;
        if (const auto folder = config.get_install_path(); folder && !folder->empty())
        {
            installed = installed_version(*folder / utils::string::utf8_to_path(config.patch_file));
        }

        std::string latest;
        std::string page;
        auto checking = false;
        if (!config.patch_release_url.empty() && !utils::flags::has_flag("offline"))
        {
            std::lock_guard lock(mutex_);
            auto& check = checks_[config.patch_release_url];
            check_if_stale(config.patch_release_url, check);
            latest = check.version;
            page = check.page;
            checking = check.checking;
        }

        // A patch file without a version resource isn't one the launcher can date: it is replaced
        // at the next launch anyway, so any release counts as newer.
        const auto update_available = installed && !latest.empty() &&
                                      (installed->empty() || tool_install::compare_versions(latest, *installed) > 0);

        out.SetObject();
        out.AddMember("installed", installed ? make_string(*installed, allocator) : rapidjson::Value(rapidjson::kNullType), allocator);
        out.AddMember("latest", latest.empty() ? rapidjson::Value(rapidjson::kNullType) : make_string(latest, allocator), allocator);
        out.AddMember("page", make_string(page, allocator), allocator);
        out.AddMember("checking", checking, allocator);
        out.AddMember("updateAvailable", update_available, allocator);
    }
}
