#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <string>

// A file's hash, computed again only when the file changed (its size or last write time), so a page that
// asks every 500 ms (the Online section's get-online-status reads the XML2 Fix's version, which needs the
// DLL's SHA-1) doesn't read and hash a 2.6 MB DLL each time. No Windows here: the unit tests run it.
namespace updater
{
    class file_hash_cache
    {
    public:
        // `hash` reads the file and returns its hash ("" when it can't be read).
        explicit file_hash_cache(std::function<std::string(const std::filesystem::path&)> hash);

        // The hash of `file` ("" when it isn't there or can't be read; never cached then).
        std::string get(const std::filesystem::path& file);

    private:
        struct entry
        {
            std::uintmax_t size{};
            std::filesystem::file_time_type written{};
            std::string hash;
        };

        std::function<std::string(const std::filesystem::path&)> hash_;
        std::mutex mutex_;
        std::map<std::filesystem::path, entry> entries_;
    };
}
