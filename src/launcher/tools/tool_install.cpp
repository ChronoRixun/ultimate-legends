#include "std_include.hpp"
#include "tool_install.hpp"
#include "archive.hpp"

#include <utils/cryptography.hpp>
#include <utils/finally.hpp>
#include <utils/http.hpp>
#include <utils/io.hpp>
#include <utils/logger.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>

namespace tool_install
{
    namespace
    {
        std::string json_string(const rapidjson::Value& object, const char* key)
        {
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }

        bool is_hex(const std::string& text)
        {
            return std::all_of(text.begin(), text.end(), [](const char c)
            {
                return std::isxdigit(static_cast<unsigned char>(c)) != 0;
            });
        }

        bool is_safe_file_name(const std::string& name)
        {
            return !name.empty() && name.find_first_of("/\\:*?\"<>|") == std::string::npos && name != "." && name != "..";
        }

        // The folder part of a URL ("https://host/a/b/file.json" -> "https://host/a/b/").
        std::string url_folder(const std::string& url)
        {
            const auto query = url.find('?');
            const auto path = url.substr(0, query);
            const auto slash = path.rfind('/');
            return slash == std::string::npos ? path + "/" : path.substr(0, slash + 1);
        }

        std::string cache_buster()
        {
            return "?t=" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
        }

        std::filesystem::path make_staging(const std::filesystem::path& root)
        {
            const auto name = std::format(".staging-{}-{}", GetCurrentProcessId(), GetTickCount64());
            const auto staging = root / name;
            std::error_code ignored;
            std::filesystem::create_directories(staging, ignored);
            return staging;
        }

        // The folder holding the tool's exe in an unpacked zip: the top, or a single folder in it.
        std::optional<std::filesystem::path> content_root(const std::filesystem::path& unpacked, const std::string& exe)
        {
            if (utils::io::file_exists(unpacked / exe))
            {
                return unpacked;
            }
            std::error_code error;
            std::optional<std::filesystem::path> only;
            for (const auto& entry : std::filesystem::directory_iterator(unpacked, error))
            {
                if (only)
                {
                    return std::nullopt;
                }
                only = entry.path();
            }
            if (only && std::filesystem::is_directory(*only, error) && utils::io::file_exists(*only / exe))
            {
                return only;
            }
            return std::nullopt;
        }
    }

    std::string download_file(const std::string& url, const std::filesystem::path& file, const std::uint64_t size,
                              const progress_callback& progress, const cancel_check& cancelled, std::string& sha256)
    {
        std::ofstream stream(file, std::ios::binary | std::ios::trunc);
        if (!stream)
        {
            return "Could not write the download into the launcher's data folder.";
        }

        utils::cryptography::sha256::stream hasher;
        std::uint64_t written = 0;
        bool too_big = false;
        const auto result = utils::http::get_data_stream(url, {}, {}, {}, [&](const char* data, const size_t length)
        {
            if (cancelled && cancelled())
            {
                return false;
            }
            written += length;
            // An answer much larger than announced is not the file (a runaway or wrong URL).
            if (size && written > size + 1024 * 1024)
            {
                too_big = true;
                return false;
            }
            stream.write(data, static_cast<std::streamsize>(length));
            hasher.update(data, length);
            if (progress)
            {
                progress(written, size);
            }
            return static_cast<bool>(stream);
        }, {}, 0, 0);
        stream.close();

        if (cancelled && cancelled())
        {
            return "cancelled";
        }
        if (too_big)
        {
            return "The download is larger than the release says; it was stopped.";
        }
        if (!result || result->code != CURLE_OK)
        {
            return std::format("The download failed ({}).", result ? curl_easy_strerror(result->code) : "no connection");
        }
        if (result->response_code != 200)
        {
            return std::format("The download failed (HTTP {}).", result->response_code);
        }
        sha256 = hasher.finish_hex();
        if (size && written != size)
        {
            return std::format("The download is incomplete ({} of {} bytes).", written, size);
        }
        return {};
    }

    std::filesystem::path root(const tool& tool)
    {
        return utils::properties::get_appdata_path() / "tools" / utils::string::utf8_to_path(tool.id);
    }

    bool is_safe_version(const std::string& version)
    {
        if (version.empty() || version.size() > 64 || version.front() == '.' || version.find("..") != std::string::npos)
        {
            return false;
        }
        return std::all_of(version.begin(), version.end(), [](const char c)
        {
            return std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '+' || c == '_';
        });
    }

    int compare_versions(const std::string& a, const std::string& b)
    {
        const auto numbers = [](const std::string& text)
        {
            std::vector<long long> parts;
            std::size_t start = 0;
            while (start <= text.size())
            {
                const auto end = std::min(text.find('.', start), text.size());
                const auto part = text.substr(start, end - start);
                long long value = 0;
                for (const auto c : part)
                {
                    if (!std::isdigit(static_cast<unsigned char>(c)))
                    {
                        break; // "1.2.0-beta" compares as 1.2.0
                    }
                    value = value * 10 + (c - '0');
                }
                parts.push_back(value);
                start = end + 1;
            }
            return parts;
        };

        auto left = numbers(a);
        auto right = numbers(b);
        const auto size = std::max(left.size(), right.size());
        left.resize(size);
        right.resize(size);
        for (std::size_t i = 0; i < size; ++i)
        {
            if (left[i] != right[i])
            {
                return left[i] < right[i] ? -1 : 1;
            }
        }
        return 0;
    }

    std::vector<installed> list(const tool& tool)
    {
        std::vector<installed> versions;
        std::error_code error;
        for (const auto& entry : std::filesystem::directory_iterator(root(tool), error))
        {
            const auto name = utils::string::path_to_utf8(entry.path().filename());
            const auto exe = entry.path() / utils::string::utf8_to_path(tool.exe);
            if (entry.is_directory(error) && is_safe_version(name) && utils::io::file_exists(exe))
            {
                versions.push_back({name, entry.path(), exe});
            }
        }
        std::sort(versions.begin(), versions.end(), [](const installed& a, const installed& b)
        {
            return compare_versions(a.version, b.version) > 0;
        });
        return versions;
    }

    std::optional<installed> find(const tool& tool, const std::string& preferred)
    {
        const auto versions = list(tool);
        if (versions.empty())
        {
            return std::nullopt;
        }
        for (const auto& version : versions)
        {
            if (!preferred.empty() && version.version == preferred)
            {
                return version;
            }
        }
        return versions.front();
    }

    std::optional<manifest> parse_manifest(const std::string& json, const std::string& manifest_url, std::string& error)
    {
        rapidjson::Document document;
        document.Parse(json.data(), json.size());
        if (document.HasParseError() || !document.IsObject())
        {
            error = "The release manifest is not valid JSON.";
            return std::nullopt;
        }

        manifest result{};
        result.version = json_string(document, "version");
        result.zip = json_string(document, "zip");
        result.sha256 = utils::string::to_lower(json_string(document, "sha256"));
        result.min_launcher = json_string(document, "min_launcher");
        result.requires_xml2fix = json_string(document, "requires_xml2fix");
        if (document.HasMember("content_version") && document["content_version"].IsInt())
        {
            result.content_version = document["content_version"].GetInt();
        }
        if (document.HasMember("size") && document["size"].IsUint64())
        {
            result.size = document["size"].GetUint64();
        }

        if (!is_safe_version(result.version))
        {
            error = "The release manifest has no usable version.";
            return std::nullopt;
        }
        if (!is_safe_file_name(result.zip))
        {
            error = "The release manifest names no zip file.";
            return std::nullopt;
        }
        if (result.sha256.size() != 64 || !is_hex(result.sha256))
        {
            error = "The release manifest has no SHA-256 for the zip.";
            return std::nullopt;
        }
        if (!result.size)
        {
            error = "The release manifest has no size for the zip.";
            return std::nullopt;
        }

        const auto url = json_string(document, "url");
        if (url.starts_with("https://") || url.starts_with("http://"))
        {
            result.url = url;
        }
        else
        {
            result.url = url_folder(manifest_url) + utils::string::url_encode_path(result.zip);
        }
        return result;
    }

    std::optional<manifest> fetch_manifest(const tool& tool, std::string& error, bool* not_published)
    {
        if (not_published)
        {
            *not_published = false;
        }
        const auto result = utils::http::get_data(tool.manifest_url + cache_buster(), {}, {}, {}, 15, 1);
        if (!result || result->code != CURLE_OK)
        {
            error = std::format("Could not reach the release page ({}).", result ? curl_easy_strerror(result->code) : "no connection");
            return std::nullopt;
        }
        if (result->response_code == 404)
        {
            if (not_published)
            {
                *not_published = true;
            }
            error = "No release has been published yet.";
            return std::nullopt;
        }
        if (result->response_code != 200)
        {
            error = std::format("The release page answered HTTP {}.", result->response_code);
            return std::nullopt;
        }
        return parse_manifest(result->buffer, tool.manifest_url, error);
    }

    std::optional<installed> install(const tool& tool, const manifest& manifest, const progress_callback& progress,
                                     const cancel_check& cancelled, std::string& error)
    {
        const auto tool_root = root(tool);
        const auto destination = tool_root / utils::string::utf8_to_path(manifest.version);
        const auto exe_name = utils::string::utf8_to_path(tool.exe);
        if (utils::io::file_exists(destination / exe_name))
        {
            return installed{manifest.version, destination, destination / exe_name};
        }

        std::error_code fs_error;
        std::filesystem::create_directories(tool_root, fs_error);
        const auto staging = make_staging(tool_root);
        const auto cleanup = utils::finally([&staging]
        {
            std::error_code ignored;
            std::filesystem::remove_all(staging, ignored);
        });

        const auto archive_path = staging / utils::string::utf8_to_path(manifest.zip);
        std::string sha256;
        std::string failure;
        for (int attempt = 0; attempt < 3; ++attempt)
        {
            failure = download_file(manifest.url, archive_path, manifest.size, progress, cancelled, sha256);
            if (failure.empty() || failure == "cancelled" || failure.starts_with("The download is larger"))
            {
                break;
            }
            utils::logger::write("{} download attempt {} failed: {}", tool.id, attempt + 1, failure);
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        if (failure == "cancelled")
        {
            error = "cancelled";
            return std::nullopt;
        }
        if (!failure.empty())
        {
            error = failure;
            return std::nullopt;
        }
        if (sha256 != manifest.sha256)
        {
            error = "The downloaded file does not match the release's SHA-256, so it was not installed.";
            utils::logger::write("{} {}: SHA-256 {} expected {}", tool.id, manifest.version, sha256, manifest.sha256);
            return std::nullopt;
        }

        const auto unpacked = staging / "unpacked";
        const auto unpack_error = archive::extract_zip(archive_path, unpacked);
        if (!unpack_error.empty())
        {
            error = unpack_error;
            return std::nullopt;
        }
        const auto content = content_root(unpacked, tool.exe);
        if (!content)
        {
            error = "The downloaded zip does not contain " + tool.exe + ".";
            return std::nullopt;
        }

        std::filesystem::remove_all(destination, fs_error); // an earlier, incomplete copy
        std::filesystem::rename(*content, destination, fs_error);
        if (fs_error)
        {
            error = "Could not install into the launcher's tools folder: " + fs_error.message();
            return std::nullopt;
        }
        utils::logger::write("Installed {} {} into {}", tool.id, manifest.version, utils::string::path_to_utf8(destination));
        return installed{manifest.version, destination, destination / exe_name};
    }

    void prune(const tool& tool, const std::vector<std::string>& keep)
    {
        std::error_code error;
        for (const auto& entry : std::filesystem::directory_iterator(root(tool), error))
        {
            const auto name = utils::string::path_to_utf8(entry.path().filename());
            if (!entry.is_directory(error))
            {
                continue;
            }
            const auto leftover = name.starts_with(".staging-");
            const auto kept = std::find(keep.begin(), keep.end(), name) != keep.end();
            if (leftover || (!kept && is_safe_version(name)))
            {
                std::error_code ignored;
                std::filesystem::remove_all(entry.path(), ignored);
            }
        }
    }
}
