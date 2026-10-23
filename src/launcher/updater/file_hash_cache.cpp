#include "std_include.hpp"
#include "file_hash_cache.hpp"

namespace updater
{
    file_hash_cache::file_hash_cache(std::function<std::string(const std::filesystem::path&)> hash)
        : hash_(std::move(hash))
    {
    }

    std::string file_hash_cache::get(const std::filesystem::path& file)
    {
        std::error_code error;
        const auto size = std::filesystem::file_size(file, error);
        const auto written = error ? std::filesystem::file_time_type{} : std::filesystem::last_write_time(file, error);
        if (error)
        {
            std::lock_guard lock(this->mutex_);
            this->entries_.erase(file);
            return {};
        }
        {
            std::lock_guard lock(this->mutex_);
            if (const auto it = this->entries_.find(file); it != this->entries_.end() && it->second.size == size && it->second.written == written)
            {
                return it->second.hash;
            }
        }

        auto hash = this->hash_(file);
        std::lock_guard lock(this->mutex_);
        if (hash.empty())
        {
            this->entries_.erase(file);
        }
        else
        {
            this->entries_[file] = {size, written, hash};
        }
        return hash;
    }
}
