#include "std_include.hpp"
#include "archive.hpp"

#include <utils/io.hpp>
#include <utils/string.hpp>

#include <miniz.h>

namespace archive
{
    namespace
    {
        // A relative path made only of plain names: no root, drive, "." or ".." part.
        std::optional<std::filesystem::path> safe_relative(std::string name)
        {
            std::replace(name.begin(), name.end(), '\\', '/');
            if (name.empty() || name.front() == '/' || name.find(':') != std::string::npos)
            {
                return std::nullopt;
            }
            std::filesystem::path result;
            std::size_t start = 0;
            while (start <= name.size())
            {
                const auto end = std::min(name.find('/', start), name.size());
                const auto part = name.substr(start, end - start);
                if (part == "." || part == "..")
                {
                    return std::nullopt;
                }
                if (!part.empty())
                {
                    result /= utils::string::utf8_to_path(part);
                }
                start = end + 1;
            }
            if (result.empty())
            {
                return std::nullopt;
            }
            return result;
        }

        size_t write_to_stream(void* opaque, mz_uint64, const void* data, const size_t size)
        {
            auto& stream = *static_cast<std::ofstream*>(opaque);
            stream.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
            return stream ? size : 0;
        }
    }

    std::string extract_zip(const std::filesystem::path& archive, const std::filesystem::path& into)
    {
        std::error_code error;
        const auto archive_size = std::filesystem::file_size(archive, error);
        FILE* file = nullptr;
        if (error || _wfopen_s(&file, archive.c_str(), L"rb") != 0 || !file)
        {
            return "Could not open the zip to unpack it.";
        }
        mz_zip_archive zip{};
        if (!mz_zip_reader_init_cfile(&zip, file, archive_size, 0))
        {
            fclose(file);
            return "The file is not a valid zip archive.";
        }

        std::string failure;
        std::filesystem::create_directories(into, error);
        if (!utils::io::directory_exists(into))
        {
            failure = "Could not create a folder to unpack into.";
        }

        const auto count = mz_zip_reader_get_num_files(&zip);
        for (mz_uint index = 0; failure.empty() && index < count; ++index)
        {
            mz_zip_archive_file_stat stat{};
            if (!mz_zip_reader_file_stat(&zip, index, &stat))
            {
                failure = "The zip archive is damaged, so it could not be unpacked.";
                break;
            }
            const auto relative = safe_relative(stat.m_filename);
            if (!relative)
            {
                failure = std::format("The zip archive holds an unsafe path ({}), so it was not unpacked.", stat.m_filename);
                break;
            }
            const auto target = into / *relative;
            if (stat.m_is_directory)
            {
                std::filesystem::create_directories(target, error);
                continue;
            }
            std::filesystem::create_directories(target.parent_path(), error);
            std::ofstream stream(target, std::ios::binary | std::ios::trunc);
            if (!stream)
            {
                failure = std::format("Could not write {} while unpacking.", stat.m_filename);
                break;
            }
            if (!mz_zip_reader_extract_to_callback(&zip, index, write_to_stream, &stream, 0) || !stream.flush())
            {
                failure = std::format("Could not unpack {} ({}).", stat.m_filename, mz_zip_get_error_string(mz_zip_get_last_error(&zip)));
            }
        }

        mz_zip_reader_end(&zip);
        fclose(file);
        return failure;
    }
}
