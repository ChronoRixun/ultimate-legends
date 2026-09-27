#include <std_include.hpp>

#include "client_store.hpp"

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
