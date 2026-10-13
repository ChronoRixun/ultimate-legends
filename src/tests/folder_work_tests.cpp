#include "std_include.hpp"
#include "test.hpp"

#include "updater/folder_work.hpp"

#include <memory>

// Patch work per folder (review of the 0.3.1 fixes, B1-B3): the X-Men Legends builder must not
// start while an updater worker is alive in its folder, however that worker's progress bar ended.
// These are the registry's answers.
namespace
{
    using updater::folder_busy;
    using updater::folder_work;
}

TEST(a_folder_is_busy_while_its_work_lives)
{
    CHECK(!folder_busy(L"C:\\Games\\X-Men Legends (Port)"));
    {
        const folder_work work(L"C:\\Games\\X-Men Legends (Port)");
        CHECK(folder_busy(L"C:\\Games\\X-Men Legends (Port)"));
        CHECK(!folder_busy(L"C:\\Games\\X-Men Legends II"));
    }
    CHECK(!folder_busy(L"C:\\Games\\X-Men Legends (Port)"));
}

TEST(the_same_folder_however_it_is_spelled)
{
    const folder_work work(L"C:\\Games\\Port");
    CHECK(folder_busy(L"c:\\games\\PORT"));
    CHECK(folder_busy(L"C:\\Games\\Port\\"));
    CHECK(folder_busy(L"C:/Games/Port"));
    CHECK(folder_busy(L"C:\\Games\\Other\\..\\Port"));
    CHECK(!folder_busy(L"C:\\Games\\Port2"));
    CHECK(!folder_busy(L"C:\\Games"));
    CHECK(updater::folder_key(L"D:\\A\\b\\") == updater::folder_key(L"d:/a/B"));
}

TEST(two_workers_in_one_folder_each_count)
{
    // An install still unwinding after a cancel, and the next update queued behind it.
    auto first = std::make_unique<folder_work>(L"C:\\Games\\Port");
    auto second = std::make_unique<folder_work>(L"c:\\games\\port\\");
    first.reset();
    CHECK(folder_busy(L"C:\\Games\\Port"));
    second.reset();
    CHECK(!folder_busy(L"C:\\Games\\Port"));
}

TEST(work_shared_with_a_worker_ends_with_its_last_owner)
{
    // A command registers the work before it starts its thread; the thread holds it to its end.
    auto work = std::make_shared<folder_work>(L"C:\\Games\\Port");
    auto held_by_worker = work;
    work.reset();
    CHECK(folder_busy(L"C:\\Games\\Port"));
    held_by_worker.reset();
    CHECK(!folder_busy(L"C:\\Games\\Port"));
}
