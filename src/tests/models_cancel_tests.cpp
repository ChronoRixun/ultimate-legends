#include "std_include.hpp"
#include "test.hpp"
#include "models/build_transaction.hpp"
#include "models/process_wait.hpp"

#include <fstream>
#include <iterator>
#include <thread>

namespace
{
    namespace fs = std::filesystem;
    void write(const fs::path& file, const std::string& text)
    {
        fs::create_directories(file.parent_path());
        std::ofstream(file, std::ios::binary) << text;
    }
    std::string read(const fs::path& file)
    {
        std::ifstream in(file, std::ios::binary);
        return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
    }
    void model(const fs::path& mods, const std::string& name, const std::string& bytes)
    {
        write(mods / name / "legends-models.json", R"({"generator":"legends-models"})");
        write(mods / name / "Actors" / "synthetic.IGB", bytes);
    }
    struct fixture
    {
        fs::path root = fs::current_path() / (".models-cancel-test-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()));
        fs::path port = root / "port", mods = port / "mods";
        fixture()
        {
            model(mods, "Community-Beast", "old complete model");
            write(mods / "Other Mod" / "settings.txt", "user bytes");
            write(mods / "load-order.txt", "; user comment\r\n+Other Mod\r\n+Community-Beast\r\n");
        }
        ~fixture() { std::error_code ec; fs::remove_all(root, ec); }
    };

    PROCESS_INFORMATION start_fixture(const fs::path& root, const bool child)
    {
        wchar_t exe[32768]{};
        GetModuleFileNameW(nullptr, exe, 32768);
        std::wstring command = L"\"" + std::wstring(exe) + L"\" --models-cancel-fixture \"" + root.wstring() + L"\"";
        if (child) command += L" child";
        STARTUPINFOW startup{sizeof(startup)};
        PROCESS_INFORMATION process{};
        const auto ok = CreateProcessW(exe, command.data(), nullptr, nullptr, FALSE,
                                      CREATE_NO_WINDOW | (child ? 0 : CREATE_SUSPENDED), nullptr, nullptr, &startup, &process);
        CHECK(ok);
        return process;
    }
}

// A synthetic converter tree that ignores the cancel file and writes only to the fixture.
// Invoked only by this test executable, never by the launcher or a game.
std::optional<int> models_cancel_fixture(const int argc, char** argv)
{
    if (argc < 3 || std::string(argv[1]) != "--models-cancel-fixture") return std::nullopt;
    const fs::path root = argv[2];
    if (argc == 3)
    {
        const auto child = start_fixture(root, true);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        write(root / "child.pid", std::to_string(child.dwProcessId));
    }
    for (;;)
    {
        write(root / (argc == 3 ? "parent-tick" : "child-tick"), "partial converted output");
        Sleep(20);
    }
}

TEST(models_cancel_discards_partial_and_already_published_staging_then_retry_commits)
{
    fixture f;
    const auto before = read(f.mods / "load-order.txt");
    fs::path scratch;
    {
        models_tool::build_transaction build(f.port, "cancelled");
        scratch = build.game().parent_path();
        model(build.game() / "mods", "Community-Beast", "half-written replacement");
        model(build.game() / "mods", "Community-Storm", "completed but not committed");
        write(build.game() / "mods" / "load-order.txt", "+Community-Storm\n");
        // Cancel, even after v0.3.0 has published internally: destructor discards everything.
    }
    CHECK(!fs::exists(scratch));
    CHECK(read(f.mods / "Community-Beast/Actors/synthetic.IGB") == "old complete model");
    CHECK(!fs::exists(f.mods / "Community-Storm"));
    CHECK(read(f.mods / "load-order.txt") == before);
    {
        models_tool::build_transaction retry(f.port, "retry");
        model(retry.game() / "mods", "Community-Beast", "complete replacement");
        model(retry.game() / "mods", "Community-Storm", "complete new model");
        write(retry.game() / "mods" / "load-order.txt", before + "+Community-Storm\n");
        retry.commit();
    }
    CHECK(read(f.mods / "Community-Beast/Actors/synthetic.IGB") == "complete replacement");
    CHECK(read(f.mods / "Community-Storm/Actors/synthetic.IGB") == "complete new model");
    CHECK(read(f.mods / "Other Mod/settings.txt") == "user bytes");
    CHECK(read(f.mods / "load-order.txt") == before + "+Community-Storm\n");
}

TEST(models_publication_rolls_back_when_load_order_is_locked)
{
    fixture f;
    const auto before = read(f.mods / "load-order.txt");
    models_tool::build_transaction build(f.port, "rollback");
    model(build.game() / "mods", "Community-Beast", "new model");
    const auto locked = CreateFileW((f.mods / "load-order.txt").c_str(), GENERIC_READ, FILE_SHARE_READ,
                                    nullptr, OPEN_EXISTING, 0, nullptr);
    CHECK(locked != INVALID_HANDLE_VALUE);
    bool refused = false;
    try { build.commit(); } catch (const std::exception&) { refused = true; }
    CloseHandle(locked);
    CHECK(refused);
    CHECK(read(f.mods / "Community-Beast/Actors/synthetic.IGB") == "old complete model");
    CHECK(read(f.mods / "load-order.txt") == before);
}

TEST(models_publication_preserves_unowned_name_collision)
{
    fixture f;
    models_tool::build_transaction build(f.port, "collision");
    model(build.game() / "mods", "Other-Mod", "must not replace user data");
    write(f.mods / "Other-Mod/settings.txt", "keep me");
    bool refused = false;
    try { build.commit(); } catch (const std::exception&) { refused = true; }
    CHECK(refused);
    CHECK(read(f.mods / "Other-Mod/settings.txt") == "keep me");
    CHECK(!fs::exists(f.mods / "Other-Mod/legends-models.json"));
}

TEST(models_publication_refuses_external_edits_during_conversion)
{
    fixture f;
    models_tool::build_transaction build(f.port, "edited");
    model(build.game() / "mods", "Community-Beast", "new model");
    write(f.mods / "Community-Beast/Actors/synthetic.IGB", "edited outside launcher");
    bool refused = false;
    try { build.commit(); } catch (const std::exception&) { refused = true; }
    CHECK(refused);
    CHECK(read(f.mods / "Community-Beast/Actors/synthetic.IGB") == "edited outside launcher");
}

TEST(models_cancel_watchdog_stops_uncooperative_process_tree_before_cleanup)
{
    fixture f;
    models_tool::build_transaction build(f.port, "watchdog");
    const auto root = build.game() / "mods";
    const auto job = CreateJobObjectW(nullptr, nullptr);
    CHECK(job != nullptr);
    const auto process = start_fixture(root, false);
    CHECK(AssignProcessToJobObject(job, process.hProcess));
    ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    const auto ready_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while ((!fs::exists(root / "child-tick") || read(root / "child.pid").empty()) && std::chrono::steady_clock::now() < ready_deadline) Sleep(10);
    CHECK(fs::exists(root / "child-tick"));
    const auto pid = read(root / "child.pid");
    HANDLE child = pid.empty() ? nullptr : OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(std::stoul(pid)));
    CHECK(child != nullptr);
    const auto start = std::chrono::steady_clock::now();
    CHECK(models_tool::wait_for_process(process.hProcess, job, [] { return true; }, std::chrono::milliseconds(100)) == 130);
    CHECK(std::chrono::steady_clock::now() - start < std::chrono::seconds(2));
    CHECK(WaitForSingleObject(child, 0) == WAIT_OBJECT_0);
    CHECK(read(f.mods / "Community-Beast/Actors/synthetic.IGB") == "old complete model");
    CloseHandle(child);
    CloseHandle(process.hProcess);
    CloseHandle(job);
}
