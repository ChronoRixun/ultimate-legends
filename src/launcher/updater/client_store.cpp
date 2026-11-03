#include <std_include.hpp>

#include "client_store.hpp"
#include "patch_records.hpp"
#include <mutex>

#include <utils/io.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>

#include <rapidjson/writer.h>

namespace client_store
{
    namespace
    {
        // Case-insensitive, separator-normalised form of a path, for comparing folders.
        std::wstring path_key(const std::filesystem::path& path)
        {
            std::error_code code{};
            const auto resolved = std::filesystem::absolute(path, code);
            auto text = (code ? path : resolved).lexically_normal().wstring();

            while (!text.empty() && (text.back() == L'\\' || text.back() == L'/'))
            {
                text.pop_back();
            }

            if (!text.empty())
            {
                ::CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
            }

            return text;
        }
    }

    std::filesystem::path manifest_cache_path(const std::string& client_id)
    {
        return utils::properties::get_appdata_path() / "clients" / (client_id + ".json");
    }

    // Cache format: {"install": "<install folder>", "files": ["name", ...]}
    std::vector<std::string> read_manifest_cache(const std::string& client_id, const std::filesystem::path& install_path)
    {
        std::string data{};
        if (!utils::io::read_file(manifest_cache_path(client_id), &data) || data.empty())
        {
            return {};
        }

        rapidjson::Document doc{};
        doc.Parse(data.data(), data.size());
        if (doc.HasParseError() || !doc.IsObject())
        {
            return {};
        }

        const auto install = doc.FindMember("install");
        const auto files = doc.FindMember("files");
        if (install == doc.MemberEnd() || !install->value.IsString() ||
            files == doc.MemberEnd() || !files->value.IsArray())
        {
            return {};
        }

        const auto cached_install = utils::string::utf8_to_path(
            std::string{install->value.GetString(), install->value.GetStringLength()});
        if (path_key(cached_install) != path_key(install_path))
        {
            return {};
        }

        std::vector<std::string> names{};
        names.reserve(files->value.Size());
        for (const auto& element : files->value.GetArray())
        {
            if (element.IsString())
            {
                names.emplace_back(element.GetString(), element.GetStringLength());
            }
        }

        return names;
    }

    bool write_manifest_cache(const std::string& client_id, const std::filesystem::path& install_path,
                              const std::vector<std::string>& names)
    {
        rapidjson::Document doc{rapidjson::kObjectType};
        auto& allocator = doc.GetAllocator();

        const auto install = utils::string::path_to_utf8(install_path);
        rapidjson::Value install_value{};
        install_value.SetString(install.data(), static_cast<rapidjson::SizeType>(install.size()), allocator);
        doc.AddMember("install", install_value, allocator);

        rapidjson::Value files{rapidjson::kArrayType};
        for (const auto& name : names)
        {
            rapidjson::Value value{};
            value.SetString(name.data(), static_cast<rapidjson::SizeType>(name.size()), allocator);
            files.PushBack(value, allocator);
        }
        doc.AddMember("files", files, allocator);

        rapidjson::StringBuffer buffer{};
        rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
        doc.Accept(writer);

        return utils::io::write_file(manifest_cache_path(client_id), std::string{buffer.GetString(), buffer.GetSize()}, false);
    }

    namespace
    {
        std::filesystem::path release_path(const std::string& client_id)
        {
            return utils::properties::get_appdata_path() / "clients" / (client_id + "-release.json");
        }

        std::string member_string(const rapidjson::Value& object, const char* key)
        {
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString()
                       ? std::string{member->value.GetString(), member->value.GetStringLength()}
                       : std::string{};
        }
    }

    namespace
    {
        std::mutex release_mutex;

        rapidjson::Document load_releases(const std::string& client_id)
        {
            std::string data;
            rapidjson::Document doc;
            if (utils::io::read_file(release_path(client_id), &data)) doc.Parse(data.data(), data.size());
            if (doc.HasParseError() || !doc.IsObject()) doc.SetObject();
            return doc;
        }

        bool legacy_matches(const rapidjson::Value& doc, const std::filesystem::path& folder)
        {
            const auto install = member_string(doc, "install");
            return !install.empty() && path_key(utils::string::utf8_to_path(install)) == path_key(folder);
        }

        std::string release_key(const std::filesystem::path& folder)
        {
            return utils::string::path_to_utf8(std::filesystem::path(path_key(folder)));
        }

        bool save_releases(const std::string& client_id, const rapidjson::Document& doc)
        {
            rapidjson::StringBuffer buffer;
            rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
            doc.Accept(writer);
            const auto file = release_path(client_id);
            auto staged = file;
            staged += L".tmp";
            std::error_code error;
            std::filesystem::create_directories(file.parent_path(), error);
            if (error) return false;
            std::ofstream stream(staged, std::ios::binary | std::ios::trunc);
            stream.write(buffer.GetString(), static_cast<std::streamsize>(buffer.GetSize()));
            stream.flush();
            const auto written = stream.good();
            stream.close();
            if (!written || stream.fail())
            {
                utils::io::remove_file(staged);
                return false;
            }
            if (MoveFileExW(staged.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
            utils::io::remove_file(staged);
            return false;
        }
    }

    // Folder records coexist in the existing file. A beta prep in a second destination,
    // including one whose build is refused, never discards the original port's full version.
    std::optional<release_channel::patch_record> read_release(const std::string& client_id, const std::filesystem::path& install_path)
    {
        std::lock_guard lock(release_mutex);
        const auto doc = load_releases(client_id);
        return patch_records::read(doc, release_key(install_path), legacy_matches(doc, install_path));
    }

    bool write_release(const std::string& client_id, const std::filesystem::path& install_path,
                       const release_channel::patch_record& record, const bool active_install)
    {
        std::lock_guard lock(release_mutex);
        auto doc = load_releases(client_id);
        const auto legacy = member_string(doc, "install");
        if (!legacy.empty()) patch_records::preserve_legacy(doc, release_key(utils::string::utf8_to_path(legacy)));
        patch_records::write(doc, release_key(install_path), record);
        if (active_install) patch_records::mirror_active(doc, utils::string::path_to_utf8(install_path), record);
        return save_releases(client_id, doc);
    }

    void forget_release(const std::string& client_id, const std::filesystem::path& install_path)
    {
        std::lock_guard lock(release_mutex);
        auto doc = load_releases(client_id);
        patch_records::forget(doc, release_key(install_path), legacy_matches(doc, install_path));
        save_releases(client_id, doc);
    }

    bool is_below(const std::filesystem::path& path, const std::filesystem::path& folder)
    {
        return utils::io::is_inside_folder(path, folder) && path_key(path) != path_key(folder);
    }

    void prune_empty_directories(const std::set<std::filesystem::path>& directories)
    {
        std::vector<std::filesystem::path> sorted_dirs(directories.begin(), directories.end());
        std::sort(sorted_dirs.begin(), sorted_dirs.end(), [](const auto& a, const auto& b) {
            return std::distance(a.begin(), a.end()) > std::distance(b.begin(), b.end());
        });

        for (const auto& dir : sorted_dirs)
        {
            std::error_code ec;
            if (std::filesystem::exists(dir, ec) && std::filesystem::is_empty(dir, ec))
            {
                std::filesystem::remove(dir, ec);
                if (!ec)
                {
                    printf("Removed empty directory: %s\n", dir.filename().string().data());
                }
            }
        }
    }
}
