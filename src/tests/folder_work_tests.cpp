#include "std_include.hpp"
#include "test.hpp"

#include "updater/folder_work.hpp"

// Who may write a game folder (review of the 0.3.1 fixes, B1-B3, R1, R2): the X-Men Legends
// builder (a build, or a clean of its folder) alone, patch work (verify, install, uninstall of a
// game's patch) alongside other patch work only, by folder - never by game entry. These are the
// registry's answers; every launcher command takes its hold through reserve().
namespace
{
    using updater::folder_patching;
    using updater::folder_use;
    using updater::reserve;

    const std::filesystem::path port = L"C:\\Games\\X-Men Legends (Port)";
}

TEST(patch_work_holds_its_folder_while_it_lives)
{
    CHECK(!folder_patching(port));
    {
        const auto work = reserve(port, folder_use::patch);
        CHECK(work != nullptr);
        CHECK(folder_patching(port));
        CHECK(!folder_patching(L"C:\\Games\\X-Men Legends II"));
    }
    CHECK(!folder_patching(port));
}

TEST(the_same_folder_however_it_is_spelled)
{
    const auto work = reserve(L"C:\\Games\\Port", folder_use::patch);
    CHECK(folder_patching(L"c:\\games\\PORT"));
    CHECK(folder_patching(L"C:\\Games\\Port\\"));
    CHECK(folder_patching(L"C:/Games/Port"));
    CHECK(folder_patching(L"C:\\Games\\Other\\..\\Port"));
    CHECK(!folder_patching(L"C:\\Games\\Port2"));
    CHECK(!folder_patching(L"C:\\Games"));
    CHECK(updater::folder_key(L"D:\\A\\b\\") == updater::folder_key(L"d:/a/B"));
    // The long-path prefix a canonical path may carry.
    CHECK(updater::folder_key(L"\\\\?\\C:\\Games\\Port") == updater::folder_key(L"C:\\Games\\Port"));
}

TEST(patch_work_shares_a_folder_with_patch_work)
{
    // An install still unwinding after a cancel, and the next update queued behind it: as before.
    auto first = reserve(port, folder_use::patch);
    auto second = reserve(L"c:\\games\\x-men legends (port)\\", folder_use::patch);
    CHECK(first && second);
    first.reset();
    CHECK(folder_patching(port));
    second.reset();
    CHECK(!folder_patching(port));
}

TEST(a_build_waits_for_patch_work_in_its_folder)
{
    auto verify = reserve(port, folder_use::patch);
    CHECK(reserve(port, folder_use::builder) == nullptr);
    // A clean of the folder (Uninstall) too: the same hold.
    CHECK(reserve(L"C:/Games/X-Men Legends (Port)", folder_use::builder) == nullptr);
    verify.reset();
    CHECK(reserve(port, folder_use::builder) != nullptr);
}

TEST(no_patch_work_in_a_folder_the_builder_holds_whatever_entry_asks)
{
    // R2: an X-Men Legends build, then Verify Files for an X-Men Legends II entry pointed at the
    // port's folder - a request from a non-built entry, the same folder.
    const auto build = reserve(port, folder_use::builder);
    CHECK(build != nullptr);
    CHECK(reserve(L"c:\\games\\x-men legends (port)", folder_use::patch) == nullptr);
    CHECK(reserve(port, folder_use::patch) == nullptr);
    CHECK(reserve(port, folder_use::builder) == nullptr);
    CHECK(!folder_patching(port));
}

TEST(separate_installs_are_not_held_by_a_build)
{
    // MUA, MUA2 and X-Men Legends II in their own folders behave as before during a port build.
    const auto build = reserve(port, folder_use::builder);
    const auto xml2 = reserve(L"C:\\Games\\X-Men Legends II", folder_use::patch);
    const auto mua = reserve(L"D:\\Steam\\steamapps\\common\\Marvel Ultimate Alliance", folder_use::patch);
    CHECK(xml2 != nullptr && mua != nullptr);
    // Not even a folder inside the port's, or the one holding it: only the folder itself.
    CHECK(reserve(L"C:\\Games", folder_use::patch) != nullptr);
}

TEST(a_hold_shared_with_a_worker_ends_with_its_last_owner)
{
    // A command takes the hold before it starts its thread; the thread keeps it to its end.
    auto work = reserve(port, folder_use::patch);
    auto held_by_worker = work;
    work.reset();
    CHECK(folder_patching(port));
    CHECK(reserve(port, folder_use::builder) == nullptr);
    held_by_worker.reset();
    CHECK(!folder_patching(port));
    const auto build = reserve(port, folder_use::builder);
    CHECK(build != nullptr);
}
