#include "io.hpp"
#include "nt.hpp"
#include "finally.hpp"

#include <algorithm>
#include <fstream>
#include <optional>

namespace utils::io
{
    namespace
    {
        // Attributes only: no handle open, so a file the running game holds open still reports its size
        std::optional<std::size_t> query_file_size(const std::filesystem::path& file)
        {
            WIN32_FILE_ATTRIBUTE_DATA data{};
            if (!GetFileAttributesExW(file.c_str(), GetFileExInfoStandard, &data) ||
                (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
            {
                return std::nullopt;
            }

            // A symlink reports its own size (0), so follow it to the target
            if (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
            {
                std::error_code ec;
                const auto size = std::filesystem::file_size(file, ec);
                if (ec)
                {
                    return std::nullopt;
                }
                return static_cast<std::size_t>(size);
            }

            return static_cast<std::size_t>(
                (static_cast<std::uint64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow);
        }
    }

    bool remove_file(const std::filesystem::path& file)
    {
        return DeleteFileW(file.wstring().data()) == TRUE;
    }

    bool move_file(const std::filesystem::path& src, const std::filesystem::path& target)
    {
        return MoveFileW(src.wstring().data(), target.wstring().data()) == TRUE;
    }

    bool file_exists(const std::filesystem::path& file)
    {
        return query_file_size(file).has_value();
    }

    bool write_file(const std::filesystem::path& file, const std::string& data, const bool append)
    {
        if (file.has_parent_path())
        {
            utils::io::create_directory(file.parent_path());
        }

        std::ofstream stream(file, std::ios::binary | std::ofstream::out | (append ? std::ofstream::app : 0));

        if (stream.is_open())
        {
            stream.write(data.data(), static_cast<std::streamsize>(data.size()));
            stream.close();
            return true;
        }

        return false;
    }

    std::string read_file(const std::filesystem::path& file)
    {
        std::string data;
        read_file(file, &data);
        return data;
    }

    bool read_file(const std::filesystem::path& file, std::string* data)
    {
        if (!data) return false;
        data->clear();

        if (file_exists(file))
        {
            std::ifstream stream(file, std::ios::binary);
            if (!stream.is_open()) return false;

            stream.seekg(0, std::ios::end);
            const std::streamsize size = stream.tellg();
            stream.seekg(0, std::ios::beg);

            if (size > -1)
            {
                data->resize(static_cast<std::string::size_type>(size));
                stream.read(data->data(), size);
                stream.close();
                return true;
            }
        }

        return false;
    }

    std::size_t file_size(const std::filesystem::path& file)
    {
        return query_file_size(file).value_or(0);
    }

    bool create_directory(const std::filesystem::path& directory)
    {
        return std::filesystem::create_directories(directory);
    }

    bool directory_exists(const std::filesystem::path& directory)
    {
        return std::filesystem::is_directory(directory);
    }

    bool directory_is_empty(const std::filesystem::path& directory)
    {
        return std::filesystem::is_empty(directory);
    }

    std::vector<std::filesystem::path> list_files(const std::filesystem::path& directory, const bool recursive)
    {
        std::vector<std::filesystem::path> files;

        if (recursive)
        {
            for (auto& file : std::filesystem::recursive_directory_iterator(directory))
            {
                files.push_back(file.path());
            }
        }
        else
        {
            for (auto& file : std::filesystem::directory_iterator(directory))
            {
                files.push_back(file.path());
            }
        }

        return files;
    }

    void copy_folder(const std::filesystem::path& src, const std::filesystem::path& target)
    {
        std::filesystem::copy(src, target,
                              std::filesystem::copy_options::overwrite_existing |
                              std::filesystem::copy_options::recursive);
    }

    bool is_inside_folder(const std::filesystem::path& file, const std::filesystem::path& folder)
    {
        std::error_code code{};
        const auto relative = std::filesystem::relative(file, folder, code);
        if (code)
        {
            return false;
        }

        const auto start = relative.begin();
        return start != relative.end() && start->native() != L"..";
    }
}
