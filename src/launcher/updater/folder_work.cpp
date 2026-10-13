#include "std_include.hpp"
#include "folder_work.hpp"

#include <cwctype>
#include <map>
#include <mutex>

namespace updater
{
    namespace
    {
        std::mutex mutex_;
        std::map<std::wstring, int> busy_; // folder key -> workers in it
    }

    std::wstring folder_key(const std::filesystem::path& folder)
    {
        // '/' first: lexically_normal() then folds "a\..\b" the same way on every platform.
        auto text = folder.wstring();
        std::replace(text.begin(), text.end(), L'\\', L'/');
        auto key = std::filesystem::path(text).lexically_normal().wstring();
        std::replace(key.begin(), key.end(), L'/', L'\\');
        while (key.size() > 1 && key.back() == L'\\')
        {
            key.pop_back();
        }
        std::transform(key.begin(), key.end(), key.begin(), [](const wchar_t c)
        {
            return static_cast<wchar_t>(std::towlower(static_cast<std::wint_t>(c)));
        });
        return key;
    }

    folder_work::folder_work(const std::filesystem::path& folder)
        : key_(folder_key(folder))
    {
        std::lock_guard lock(mutex_);
        ++busy_[this->key_];
    }

    folder_work::~folder_work()
    {
        std::lock_guard lock(mutex_);
        const auto it = busy_.find(this->key_);
        if (it != busy_.end() && --it->second <= 0)
        {
            busy_.erase(it);
        }
    }

    bool folder_busy(const std::filesystem::path& folder)
    {
        const auto key = folder_key(folder);
        std::lock_guard lock(mutex_);
        return busy_.contains(key);
    }
}
