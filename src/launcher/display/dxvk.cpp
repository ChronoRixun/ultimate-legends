#include "std_include.hpp"
#include "dxvk.hpp"

#include <utils/cryptography.hpp>

#include <miniz.h>

#include <fstream>
#include <system_error>

namespace dxvk
{
    namespace
    {
        constexpr std::uint64_t max_unpacked = 256ull * 1024 * 1024;
        constexpr std::uint64_t max_archive = 64ull * 1024 * 1024;

        std::string lower(std::string text)
        {
            std::transform(text.begin(), text.end(), text.begin(), [](const unsigned char c) { return static_cast<char>(std::tolower(c)); });
            return text;
        }

        std::string hash(const std::string& bytes)
        {
            return lower(utils::cryptography::sha256::compute(bytes, true));
        }

        std::optional<std::string> read_file(const std::filesystem::path& file, const std::uint64_t limit)
        {
            std::error_code ec;
            const auto size = std::filesystem::file_size(file, ec);
            if (ec || size > limit)
            {
                return std::nullopt;
            }
            std::ifstream stream(file, std::ios::binary);
            if (!stream)
            {
                return std::nullopt;
            }
            std::string bytes(static_cast<size_t>(size), '\0');
            if (size && !stream.read(bytes.data(), static_cast<std::streamsize>(size)))
            {
                return std::nullopt;
            }
            return bytes;
        }

        // gzip (RFC 1952), one member: the header, the raw deflate stream, then CRC-32 and the size.
        std::optional<std::string> gunzip(const std::string_view gzip, std::string& error)
        {
            const auto* data = reinterpret_cast<const unsigned char*>(gzip.data());
            const auto size = gzip.size();
            if (size < 18 || data[0] != 0x1f || data[1] != 0x8b || data[2] != 8)
            {
                error = "The DXVK download is not a .tar.gz archive.";
                return std::nullopt;
            }
            const auto flags = data[3];
            size_t offset = 10;
            if (flags & 0x04) // FEXTRA
            {
                if (offset + 2 > size) return error = "The DXVK archive is damaged.", std::nullopt;
                offset += 2 + (data[offset] | (data[offset + 1] << 8));
            }
            for (const auto bit : {0x08, 0x10}) // FNAME, FCOMMENT: zero-terminated
            {
                if (!(flags & bit)) continue;
                while (offset < size && data[offset] != 0) ++offset;
                ++offset;
            }
            if (flags & 0x02) offset += 2; // FHCRC
            if (offset + 8 > size)
            {
                error = "The DXVK archive is damaged.";
                return std::nullopt;
            }

            mz_stream stream{};
            if (mz_inflateInit2(&stream, -MZ_DEFAULT_WINDOW_BITS) != MZ_OK)
            {
                error = "The DXVK archive could not be unpacked.";
                return std::nullopt;
            }
            std::string out;
            stream.next_in = data + offset;
            stream.avail_in = static_cast<unsigned int>(size - offset - 8);
            std::vector<unsigned char> chunk(1 << 20);
            int status = MZ_OK;
            while (status == MZ_OK)
            {
                stream.next_out = chunk.data();
                stream.avail_out = static_cast<unsigned int>(chunk.size());
                status = mz_inflate(&stream, MZ_NO_FLUSH);
                const auto produced = chunk.size() - stream.avail_out;
                if (out.size() + produced > max_unpacked)
                {
                    status = MZ_DATA_ERROR;
                    break;
                }
                out.append(reinterpret_cast<const char*>(chunk.data()), produced);
                if (status == MZ_BUF_ERROR && produced)
                {
                    status = MZ_OK;
                }
            }
            mz_inflateEnd(&stream);
            if (status != MZ_STREAM_END)
            {
                error = "The DXVK archive is damaged or too large.";
                return std::nullopt;
            }
            const auto* tail = data + size - 8;
            const auto crc = static_cast<std::uint32_t>(tail[0] | (tail[1] << 8) | (tail[2] << 16) | (static_cast<std::uint32_t>(tail[3]) << 24));
            const auto isize = static_cast<std::uint32_t>(tail[4] | (tail[5] << 8) | (tail[6] << 16) | (static_cast<std::uint32_t>(tail[7]) << 24));
            const auto actual = static_cast<std::uint32_t>(mz_crc32(MZ_CRC32_INIT, reinterpret_cast<const unsigned char*>(out.data()), out.size()));
            if (crc != actual || isize != static_cast<std::uint32_t>(out.size()))
            {
                error = "The DXVK archive is damaged (checksum).";
                return std::nullopt;
            }
            return out;
        }

        std::uint64_t octal(const char* field, const size_t length)
        {
            std::uint64_t value = 0;
            for (size_t i = 0; i < length && field[i]; ++i)
            {
                if (field[i] == ' ') continue;
                if (field[i] < '0' || field[i] > '7') break;
                value = value * 8 + static_cast<std::uint64_t>(field[i] - '0');
            }
            return value;
        }

        std::string field(const char* text, const size_t length)
        {
            size_t end = 0;
            while (end < length && text[end]) ++end;
            return std::string(text, end);
        }

        std::string normal_member(std::string name)
        {
            while (name.rfind("./", 0) == 0) name.erase(0, 2);
            return name;
        }

        std::filesystem::path target(const std::filesystem::path& game_dir, const pinned_file& file)
        {
            return game_dir / file.name;
        }

        enum class one_file
        {
            absent,
            ours,
            foreign,
        };

        one_file look(const std::filesystem::path& path, const pinned_file& file)
        {
            std::error_code ec;
            if (!std::filesystem::exists(path, ec))
            {
                return ec ? one_file::foreign : one_file::absent;
            }
            if (!std::filesystem::is_regular_file(path, ec) || std::filesystem::file_size(path, ec) != file.size || ec)
            {
                return one_file::foreign;
            }
            return sha256_file(path) == file.sha256 ? one_file::ours : one_file::foreign;
        }
    }

    bool offered_for(const std::string_view game_key)
    {
        return game_key == "xml1";
    }

    const release& pinned()
    {
        static const release dxvk_3_1_1{
            "3.1.1",
            "https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz",
            "dxvk-3.1.1.tar.gz",
            18041512,
            "40565b4a724aadc4433fa4e010b4b23916d9b1f1baeee64e17186db94f54e608",
            {
                {"dxvk-3.1.1/x32/d3d8.dll", L"d3d8.dll", 1687566, "9152ba43386e756790a66f61cdcee01b3287d156d4161c7456d816faa82fc364"},
                {"dxvk-3.1.1/x32/d3d9.dll", L"d3d9.dll", 7856142, "265888c31ca78dffa290c39cb7e50bfb02762590e41927906e46fb32f01497fa"},
            },
        };
        return dxvk_3_1_1;
    }

    std::string sha256_file(const std::filesystem::path& file)
    {
        std::ifstream stream(file, std::ios::binary);
        if (!stream)
        {
            return {};
        }
        utils::cryptography::sha256::stream hasher;
        std::vector<char> chunk(1 << 20);
        while (stream)
        {
            stream.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
            const auto got = stream.gcount();
            if (got > 0) hasher.update(chunk.data(), static_cast<size_t>(got));
        }
        if (!stream.eof())
        {
            return {};
        }
        return lower(hasher.finish_hex());
    }

    bool archive_valid(const std::filesystem::path& archive, const release& release)
    {
        std::error_code ec;
        if (!std::filesystem::is_regular_file(archive, ec) || std::filesystem::file_size(archive, ec) != release.size || ec)
        {
            return false;
        }
        return sha256_file(archive) == release.sha256;
    }

    std::optional<std::map<std::string, std::string>> extract(const std::string_view gzip, const release& release, std::string& error)
    {
        const auto tar = gunzip(gzip, error);
        if (!tar)
        {
            return std::nullopt;
        }

        std::map<std::string, std::string> found;
        std::string long_name;
        size_t offset = 0;
        while (offset + 512 <= tar->size())
        {
            const char* header = tar->data() + offset;
            if (std::all_of(header, header + 512, [](const char c) { return c == 0; }))
            {
                break; // the end-of-archive blocks
            }
            const auto size = octal(header + 124, 12);
            const auto type = header[156];
            const auto data = offset + 512;
            const auto blocks = (size + 511) / 512;
            if (data + size > tar->size() || size > max_unpacked)
            {
                error = "The DXVK archive is damaged.";
                return std::nullopt;
            }

            std::string name = field(header, 100);
            if (std::string(header + 257, 5) == "ustar")
            {
                const auto prefix = field(header + 345, 155);
                if (!prefix.empty()) name = prefix + "/" + name;
            }
            if (!long_name.empty())
            {
                name = long_name;
                long_name.clear();
            }

            if (type == 'L') // GNU long name: the next entry's name
            {
                long_name = field(tar->data() + data, static_cast<size_t>(size));
            }
            else if (type == '0' || type == '\0')
            {
                name = normal_member(name);
                for (const auto& file : release.files)
                {
                    if (name != file.member) continue;
                    if (found.contains(file.member))
                    {
                        error = "The DXVK archive holds " + file.member + " twice.";
                        return std::nullopt;
                    }
                    found.emplace(file.member, tar->substr(data, static_cast<size_t>(size)));
                }
            }
            offset = data + static_cast<size_t>(blocks * 512);
        }

        for (const auto& file : release.files)
        {
            const auto it = found.find(file.member);
            if (it == found.end())
            {
                error = "The DXVK archive does not contain " + file.member + ".";
                return std::nullopt;
            }
            if (it->second.size() != file.size || hash(it->second) != file.sha256)
            {
                error = file.member + " in the DXVK archive is not the pinned file (SHA-256).";
                return std::nullopt;
            }
        }
        return found;
    }

    std::optional<std::map<std::string, std::string>> extract_file(const std::filesystem::path& archive, const release& release, std::string& error)
    {
        const auto bytes = read_file(archive, max_archive);
        if (!bytes)
        {
            error = "The DXVK download could not be read.";
            return std::nullopt;
        }
        return extract(*bytes, release, error);
    }

    const char* to_string(const files_state state)
    {
        switch (state)
        {
        case files_state::ours: return "ours";
        case files_state::partial: return "partial";
        case files_state::foreign: return "foreign";
        default: return "none";
        }
    }

    files_state inspect(const std::filesystem::path& game_dir, const release& release)
    {
        size_t ours = 0;
        for (const auto& file : release.files)
        {
            const auto state = look(target(game_dir, file), file);
            if (state == one_file::foreign) return files_state::foreign;
            if (state == one_file::ours) ++ours;
        }
        if (ours == 0) return files_state::none;
        return ours == release.files.size() ? files_state::ours : files_state::partial;
    }

    std::string install(const std::filesystem::path& game_dir, const release& release, const std::map<std::string, std::string>& contents)
    {
        std::error_code ec;
        if (!std::filesystem::is_directory(game_dir, ec))
        {
            return "The game folder is not there.";
        }
        if (inspect(game_dir, release) == files_state::foreign)
        {
            return "Another d3d8.dll or d3d9.dll is in the game folder. The launcher does not replace it.";
        }
        for (const auto& file : release.files)
        {
            const auto it = contents.find(file.member);
            if (it == contents.end() || it->second.size() != file.size || hash(it->second) != file.sha256)
            {
                return "The DXVK files are not the pinned ones; nothing was installed.";
            }
        }

        // Each file beside its target first, then renamed into place: a file is either whole or absent.
        std::vector<std::pair<std::filesystem::path, std::filesystem::path>> staged;
        const auto drop_staged = [&] {
            for (const auto& [temp, _] : staged) std::filesystem::remove(temp, ec);
        };
        for (const auto& file : release.files)
        {
            const auto final_path = target(game_dir, file);
            auto temp = final_path;
            temp += L".ul-dxvk-new";
            {
                std::ofstream out(temp, std::ios::binary | std::ios::trunc);
                const auto& bytes = contents.at(file.member);
                if (!out || !out.write(bytes.data(), static_cast<std::streamsize>(bytes.size())))
                {
                    staged.emplace_back(temp, final_path);
                    drop_staged();
                    return "Could not write DXVK into the game folder.";
                }
            }
            staged.emplace_back(temp, final_path);
        }
        for (const auto& [temp, final_path] : staged)
        {
            std::filesystem::rename(temp, final_path, ec);
            if (ec)
            {
                drop_staged();
                return "Could not place DXVK in the game folder (" + ec.message() + "). Is the game running?";
            }
        }
        return inspect(game_dir, release) == files_state::ours ? std::string{} : "DXVK was written but does not read back as the pinned files.";
    }

    std::string remove(const std::filesystem::path& game_dir, const release& release)
    {
        std::string failure;
        for (const auto& file : release.files)
        {
            const auto path = target(game_dir, file);
            if (look(path, file) != one_file::ours) continue; // absent, or the player's own file
            std::error_code ec;
            std::filesystem::remove(path, ec);
            if (ec && failure.empty())
            {
                failure = "Could not remove " + path.filename().string() + " (" + ec.message() + "). Is the game running?";
            }
        }
        // A staged file an interrupted install left behind.
        for (const auto& file : release.files)
        {
            auto temp = target(game_dir, file);
            temp += L".ul-dxvk-new";
            std::error_code ec;
            std::filesystem::remove(temp, ec);
        }
        return failure;
    }

    std::string enable(const std::filesystem::path& game_dir, const std::filesystem::path& cache, const release& release,
                       const enable_steps& steps)
    {
        const auto phase = [&](const char* name) {
            if (steps.phase) steps.phase(name);
        };
        const auto cancelled = [&] { return steps.cancelled && steps.cancelled(); };

        std::error_code ec;
        std::filesystem::create_directories(cache, ec);
        const auto archive = cache / release.archive;
        if (!archive_valid(archive, release))
        {
            std::filesystem::remove(archive, ec);
            if (steps.offline)
            {
                return "The launcher is offline. Connect to the internet to download DXVK " + release.version + ".";
            }
            if (!steps.download)
            {
                return "DXVK " + release.version + " is not downloaded.";
            }
            phase("download");
            auto partial = archive;
            partial += L".partial";
            std::string sha256;
            const auto failure = steps.download(release.url, partial, release.size, sha256);
            if (!failure.empty())
            {
                std::filesystem::remove(partial, ec);
                return failure;
            }
            phase("verify");
            if (lower(sha256) != release.sha256 || !archive_valid(partial, release))
            {
                std::filesystem::remove(partial, ec);
                return "The DXVK " + release.version + " download did not match its pinned SHA-256, so it was deleted and nothing was installed.";
            }
            std::filesystem::rename(partial, archive, ec);
            if (ec)
            {
                std::filesystem::remove(partial, ec);
                return "Could not keep the DXVK download in the launcher's data folder.";
            }
        }
        if (cancelled())
        {
            return "cancelled";
        }

        phase("verify");
        std::string error;
        const auto contents = extract_file(archive, release, error);
        if (!contents)
        {
            std::filesystem::remove(archive, ec);
            return error;
        }
        if (cancelled())
        {
            return "cancelled";
        }
        phase("install");
        return install(game_dir, release, *contents);
    }
}
