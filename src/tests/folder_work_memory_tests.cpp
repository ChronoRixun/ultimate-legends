#include "std_include.hpp"
#include "test.hpp"

#include "updater/folder_work.hpp"

#include <cstdlib>
#include <new>

// A hold that runs out of memory while it is being taken (review of the 0.3.1 fixes, R3): the
// registry must be as it was - the next reservation of the folder succeeds - and nothing may lock
// the registry twice (a hang, or the process ending). This file replaces the test program's
// operator new with one that can fail a chosen allocation of one reserve() call; unarmed (every
// other test) it is plain malloc.
namespace
{
    struct allocation_probe
    {
        bool armed = false;
        int count = 0;
        int fail_at = -1;
        void* pointers[1024]{};
    };

    allocation_probe probe;
}

void* operator new(const std::size_t size)
{
    if (probe.armed)
    {
        const auto index = probe.count++;
        if (index == probe.fail_at)
        {
            throw std::bad_alloc();
        }
        void* memory = std::malloc(size ? size : 1);
        if (!memory)
        {
            throw std::bad_alloc();
        }
        if (index < 1024)
        {
            probe.pointers[index] = memory;
        }
        return memory;
    }
    if (void* memory = std::malloc(size ? size : 1))
    {
        return memory;
    }
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept
{
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept
{
    std::free(memory);
}

namespace
{
    using updater::folder_patching;
    using updater::folder_use;
    using updater::reserve;

    // Long enough that no string of it fits in a small-string buffer: every copy allocates.
    const std::filesystem::path folder = L"C:\\Games\\A folder for the allocation probe\\X-Men Legends (Port)";

    struct run
    {
        bool out_of_memory = false;
        int allocations = 0;
        int hold_allocation = -1; // the hold object's own allocation (its address is the hold's)
    };

    // One reserve() of `folder` for `use` with allocation `fail_at` failing (-1: none); a hold it
    // returns is let go at once.
    run reserve_failing(const folder_use use, const int fail_at)
    {
        run result{};
        probe = {};
        probe.fail_at = fail_at;
        probe.armed = true;
        try
        {
            auto hold = reserve(folder, use);
            probe.armed = false;
            for (int i = 0; i < probe.count && i < 1024; ++i)
            {
                if (hold && probe.pointers[i] == hold.get())
                {
                    result.hold_allocation = i;
                }
            }
        }
        catch (const std::bad_alloc&)
        {
            probe.armed = false;
            result.out_of_memory = true;
        }
        result.allocations = probe.count;
        return result;
    }

    // The folder is free again: no hold left behind, and a builder can take it (then lets it go).
    bool folder_free()
    {
        if (folder_patching(folder))
        {
            return false;
        }
        const auto next = reserve(folder, folder_use::builder);
        return next != nullptr;
    }
}

TEST(out_of_memory_for_the_hold_itself_leaves_its_folder_free)
{
    for (const auto use : {folder_use::patch, folder_use::builder})
    {
        const auto clean = reserve_failing(use, -1);
        CHECK(!clean.out_of_memory && clean.hold_allocation >= 0);
        const auto failed = reserve_failing(use, clean.hold_allocation);
        CHECK(failed.out_of_memory);
        CHECK(folder_free());
    }
}

TEST(out_of_memory_for_the_holds_shared_ownership_leaves_its_folder_free_without_a_hang)
{
    // The allocation right after the hold's: shared_ptr's control block. Its failure destroys the
    // hold, which must neither give back a count it never took nor lock the registry again.
    for (const auto use : {folder_use::patch, folder_use::builder})
    {
        const auto clean = reserve_failing(use, -1);
        CHECK(clean.hold_allocation >= 0 && clean.hold_allocation + 1 < clean.allocations);
        const auto failed = reserve_failing(use, clean.hold_allocation + 1);
        CHECK(failed.out_of_memory);
        CHECK(folder_free());
    }
}

TEST(out_of_memory_at_any_allocation_of_a_reservation_leaves_its_folder_free)
{
    for (const auto use : {folder_use::patch, folder_use::builder})
    {
        const auto clean = reserve_failing(use, -1);
        for (int fail_at = 0; fail_at < clean.allocations; ++fail_at)
        {
            reserve_failing(use, fail_at);
            CHECK(folder_free());
        }
    }
}

TEST(out_of_memory_beside_a_live_hold_takes_nothing_from_it)
{
    // A failed patch reservation next to one that is alive: the live one still holds the folder.
    const auto live = reserve(folder, folder_use::patch);
    const auto clean = reserve_failing(folder_use::patch, -1);
    for (int fail_at = 0; fail_at < clean.allocations; ++fail_at)
    {
        reserve_failing(folder_use::patch, fail_at);
        CHECK(folder_patching(folder));
        CHECK(reserve(folder, folder_use::builder) == nullptr);
    }
}
