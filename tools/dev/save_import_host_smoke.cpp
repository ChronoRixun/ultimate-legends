#include "std_include.hpp"
#include "builder_process.hpp"
#include "save_import_args.hpp"
#include <iostream>
#include <thread>

namespace {
    int failures = 0;
    void check(bool ok, const char* text) { if (!ok) { ++failures; std::cerr << "FAIL " << text << '\n'; } }
    xml1::builder_snapshot exercise(const std::filesystem::path& node, const std::filesystem::path& fake,
        const std::string& scenario, const std::string& mode) {
        save_import_args::request request;
        request.mode = mode; request.source = LR"(C:\Invented\Owen's Ω saves\UDATA\4156001e)";
        if (scenario.starts_with("hdd")) {
            request.source = LR"(C:\Invented\Owen's Ω disk.qcow2)";
            request.campaign = "E:/UDATA/4156001e/Caf\xc3\xa9's campaign";
        }
        if (scenario.starts_with("recomp")) request.source_kind = "recomp";
        request.save_dir = LR"(C:\Invented\SaveLC)"; request.slot = 0;
        std::string error;
        const auto built = save_import_args::build(request, LR"(C:\Invented\Legends Classic)", error);
        check(built.has_value(), "typed arguments accepted");
        auto args = *built;
        args.insert(args.begin(), {fake.wstring(), L"import-xml1-save", L"--events", L"jsonl"});
        args.insert(args.end(), {L"--fake-scenario", std::wstring(scenario.begin(), scenario.end())});
        xml1::builder_process process(1, "import-xml1-save");
        check(process.start(node, args, {}, error), "hidden converter started");
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        bool cancelled = false;
        for (;;) {
            const auto snapshot = process.snapshot();
            if (snapshot.finished) return snapshot;
            if (scenario == "wait" && !cancelled && !snapshot.builder_version.empty()) { process.cancel(); cancelled = true; }
            if (std::chrono::steady_clock::now() > deadline) {
                process.cancel();
                check(false, "converter finished before deadline");
                // The job's own cancel deadline kills an unresponsive fake. Wait
                // for it so no child or waiter survives this test process.
                while (!process.snapshot().finished) std::this_thread::sleep_for(std::chrono::milliseconds(20));
                return process.snapshot();
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 2;
    for (const auto& scenario : {"gated", "inferred", "refused", "wait", "mismatch", "no-result"}) {
        const auto result = exercise(argv[1], argv[2], scenario, "preview");
        check(result.finished && !result.active, "waited for process exit");
        if (std::string(scenario) == "wait") check(result.exit_code == 5 && result.cancel_requested && !result.killed, "cooperative cancellation");
        else if (std::string(scenario) == "inferred" || std::string(scenario) == "refused") check(result.exit_code == 2 && !result.errors.empty(), "structured refusal");
        else if (std::string(scenario) == "mismatch") check(result.exit_code == 3 && !result.errors.empty() && result.errors.back().code == "E_XML1_PROTOCOL", "real exit overrides optimistic result");
        else if (std::string(scenario) == "no-result") check(result.result.empty(), "missing result stays absent");
        else {
            rapidjson::Document document; document.Parse(result.result.c_str());
            check(result.exit_code == 0 && document["dry_run"].GetBool() && !document["imported"].GetBool(), "preview is not installation");
            check(document["test_idle"].GetBool(), "converter ran at Idle priority");
        }
        std::cout << scenario << ": exit " << result.exit_code << '\n';
    }
    const auto source = exercise(argv[1], argv[2], "gated", "inspect");
    rapidjson::Document document; document.Parse(source.result.c_str());
    const auto folder = document["candidates"][0]["folder"].GetString();
    check(std::string(folder).find("Owen's \xce\xa9 saves") != std::string::npos, "spaces/apostrophe/UTF-8 path survived quoting and JSONL");
    for (const auto& mode : {"inspect", "preview"}) {
        const auto image = exercise(argv[1], argv[2], "hdd", mode);
        rapidjson::Document event; event.Parse(image.result.c_str());
        check(image.exit_code == 0 && event["test_idle"].GetBool(), "HDD converter completed at Idle");
        const auto& facts = event[std::string(mode) == "inspect" ? "source_report" : "import_report"];
        check(std::string(facts["source_container"]["campaign"].GetString()) == "E:/UDATA/4156001e/Caf\xc3\xa9's campaign", "exact Unicode campaign argument reached JSONL converter");
        if (std::string(mode) == "inspect") check(std::string(event["candidates"][0]["folder"].GetString()).ends_with("disk.qcow2"), "image source survived quoting");
    }
    for (const auto& scenario : {"hdd-encrypted", "hdd-unknown", "hdd-corrupt", "hdd-locked"}) {
        const auto refusal = exercise(argv[1], argv[2], scenario, "inspect");
        const std::string expected = std::string(scenario) == "hdd-locked" ? "E_XML1_BUSY" :
            std::string(scenario) == "hdd-corrupt" ? "E_XML1_DISK_DAMAGED" : "E_XML1_DISK_VERSION";
        check(refusal.exit_code == 2 && !refusal.errors.empty() && refusal.errors.back().code == expected, "HDD refusal code preserved");
    }
    for (const auto& mode : {"inspect", "preview"}) {
        const auto recomp = exercise(argv[1], argv[2], "recomp", mode);
        rapidjson::Document event; event.Parse(recomp.result.c_str());
        check(recomp.exit_code == 0 && event["test_idle"].GetBool(), "recomp converter completed at Idle");
        check(std::string(event["received_source_kind"].GetString()) == "recomp", "recomp source kind reached the actual CLI argv");
        const auto& facts = event[std::string(mode) == "inspect" ? "source_report" : "import_report"];
        check(std::string(facts["source_container"]["kind"].GetString()) == "recomp", "recomp source container survives JSONL transport");
    }
    const auto recomp_refusal = exercise(argv[1], argv[2], "recomp-version", "inspect");
    check(recomp_refusal.exit_code == 2 && !recomp_refusal.errors.empty() && recomp_refusal.errors.back().code == "E_XML1_RECOMP_VERSION", "recomp version refusal preserved");
    std::cout << "16 hidden transport scenarios, " << failures << " failures\n";
    return failures ? 1 : 0;
}
