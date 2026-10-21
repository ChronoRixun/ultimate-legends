#include "std_include.hpp"
#include "online_status.hpp"

#include <fstream>
#include <iterator>
#include <thread>

namespace online_status
{
    namespace
    {
        constexpr std::uintmax_t max_bytes = 64 * 1024;

        // Still there, as far as anyone can tell (a file whose state can't be read counts as there).
        bool present(const std::filesystem::path& file)
        {
            std::error_code ec;
            const auto status = std::filesystem::symlink_status(file, ec);
            if (ec)
            {
                return ec != std::errc::no_such_file_or_directory;
            }
            return std::filesystem::exists(status);
        }
    }

    std::filesystem::path path(const std::filesystem::path& game_dir)
    {
        return game_dir / file_name;
    }

    bool clear(const std::filesystem::path& game_dir, std::string& error, const int attempts, const std::chrono::milliseconds wait)
    {
        const auto file = path(game_dir);
        std::error_code ec;
        for (auto attempt = 0; attempt < std::max(attempts, 1); ++attempt)
        {
            if (attempt)
            {
                std::this_thread::sleep_for(wait);
            }
            ec.clear();
            std::filesystem::remove(file, ec);
            if (!present(file))
            {
                return true;
            }
        }
        error = "online-status.json could not be deleted (" + (ec ? ec.message() : std::string("it is still there")) + ").";
        return false;
    }

    std::optional<std::string> read(const std::filesystem::path& game_dir)
    {
        const auto file = path(game_dir);
        std::error_code ec;
        const auto size = std::filesystem::file_size(file, ec);
        if (ec || size > max_bytes)
        {
            return std::nullopt;
        }
        std::ifstream stream(file, std::ios::binary);
        if (!stream)
        {
            return std::nullopt;
        }
        std::string text((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        if (stream.bad())
        {
            return std::nullopt;
        }
        return text;
    }
}
