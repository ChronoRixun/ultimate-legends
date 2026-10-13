#include "std_include.hpp"
#include "folder_work.hpp"

#include <cwctype>
#include <map>
#include <mutex>

namespace updater
{
    namespace
    {
        struct holds
        {
            int patch{};
            int builder{};
        };

        std::mutex mutex_;
        std::map<std::wstring, holds> held_; // folder key -> its holds
    }

    std::wstring folder_key(const std::filesystem::path& folder)
    {
        // '/' throughout: lexically_normal() then folds "a\..\b" the same way on every platform; and
        // without the long-path prefix a path (a canonical one, say) may carry: the same folder.
        const auto plain = [](std::wstring text)
        {
            std::replace(text.begin(), text.end(), L'\\', L'/');
            if (text.rfind(L"//?/UNC/", 0) == 0)
            {
                return L"//" + text.substr(8);
            }
            if (text.rfind(L"//?/", 0) == 0)
            {
                return text.substr(4);
            }
            return text;
        };
        const std::filesystem::path path(plain(folder.wstring()));
        std::error_code error;
        auto resolved = std::filesystem::weakly_canonical(path, error);
        if (error)
        {
            resolved = std::filesystem::absolute(path, error);
            if (error)
            {
                resolved = path;
            }
        }
        const auto text = plain(resolved.wstring());
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

    folder_work::folder_work(std::wstring key, const folder_use use)
        : key_(std::move(key)), use_(use)
    {
    }

    folder_work::~folder_work()
    {
        // A hold reserve() never committed (it ran out of memory, or the folder was taken) gave nothing
        // to the registry: nothing to give back, and no lock - its caller may hold it.
        if (!this->committed_)
        {
            return;
        }
        std::lock_guard lock(mutex_);
        const auto it = held_.find(this->key_);
        if (it == held_.end())
        {
            return;
        }
        auto& count = this->use_ == folder_use::patch ? it->second.patch : it->second.builder;
        if (count > 0)
        {
            --count;
        }
        if (!it->second.patch && !it->second.builder)
        {
            held_.erase(it);
        }
    }

    std::shared_ptr<folder_work> reserve(const std::filesystem::path& folder, const folder_use use)
    {
        // Every allocation of the hold comes before anything is committed, and no hold is destroyed under
        // the registry's lock: running out of memory anywhere here leaves the registry as it was. The hold
        // first, then its shared ownership (a failure there leaves it with `token`, which frees it
        // uncommitted).
        const auto key = folder_key(folder);
        auto token_key = key;
        std::unique_ptr<folder_work> token(new folder_work(std::move(token_key), use));
        std::shared_ptr<folder_work> hold(std::move(token));

        std::lock_guard lock(mutex_);
        const auto it = held_.find(key);
        if (it != held_.end() && (it->second.builder > 0 || (use == folder_use::builder && it->second.patch > 0)))
        {
            return nullptr; // (`hold`, never committed, goes after the lock)
        }
        auto& holds = held_[key]; // may run out of memory too: nothing is committed yet
        ++(use == folder_use::patch ? holds.patch : holds.builder);
        hold->committed_ = true;
        return hold;
    }

    bool folder_patching(const std::filesystem::path& folder)
    {
        const auto key = folder_key(folder);
        std::lock_guard lock(mutex_);
        const auto it = held_.find(key);
        return it != held_.end() && it->second.patch > 0;
    }
}
