#include "std_include.hpp"
#include "test.hpp"
#include "xml1/save_import_args.hpp"

namespace {
    save_import_args::request import_request() {
        save_import_args::request r;
        r.mode = "preview"; r.source = LR"(C:\Owned\Xbox saves\UDATA\4156001e)";
        r.save_dir = LR"(C:\Player\SaveLC)"; r.slot = 0;
        return r;
    }
    const std::filesystem::path installed_build = LR"(C:\Games\Legends Classic)";
}
TEST(save_import_preview_is_a_typed_read_only_command) {
    auto r = import_request(); std::string error;
    const auto args = save_import_args::build(r, installed_build, error);
    const std::vector<std::wstring> expected{r.source.wstring(), L"--build", installed_build.wstring(), L"--save-dir", r.save_dir.wstring(), L"--slot", L"0", L"--dry-run"};
    CHECK(args.has_value()); CHECK(error.empty()); CHECK(*args == expected);
    CHECK(!save_import_args::player_install_enabled);
    r.allow_inferred = true; r.merge_unlocks = true;
    const auto opted = save_import_args::build(r, installed_build, error);
    CHECK(std::find(opted->begin(), opted->end(), L"--allow-inferred") != opted->end());
    CHECK(std::find(opted->begin(), opted->end(), L"--merge-unlocks") != opted->end());
}
TEST(save_import_discovery_and_slot_scan_have_no_apply_flags) {
    auto r = import_request(); std::string error;
    r.mode = "inspect"; r.save_dir.clear(); r.slot = -1;
    const auto source = save_import_args::build(r, installed_build, error);
    CHECK(source.has_value()); CHECK(source->size() == 2); CHECK(source->at(1) == L"--inspect-source");
    r.mode = "slots"; r.source.clear(); r.save_dir = LR"(C:\Player\SaveLC)";
    const auto slots = save_import_args::build(r, installed_build, error);
    CHECK(slots.has_value()); CHECK(slots->size() == 3); CHECK(slots->at(0) == L"--list-slots");
}
TEST(save_import_apply_and_undo_require_explicit_confirmation_and_exact_tokens) {
    auto r = import_request(); std::string error; r.mode = "apply"; r.preview_token = std::string(64, 'a');
    CHECK(!save_import_args::build(r, installed_build, error));
    r.confirmed = true; CHECK(save_import_args::build(r, installed_build, error).has_value());
    for (const auto& token : {"", "--dry-run", "a\nb", "../escape"}) {
        r.preview_token = token; CHECK(!save_import_args::build(r, installed_build, error));
    }
    r.mode = "undo"; r.transaction_id = std::string(32, 'b');
    CHECK(save_import_args::build(r, installed_build, error).has_value());
    r.confirmed = false; CHECK(!save_import_args::build(r, installed_build, error));
    r.confirmed = true; r.transaction_id = "../escape"; CHECK(!save_import_args::build(r, installed_build, error));
}
TEST(save_import_rejects_unsupported_modes_slots_and_unsafe_paths) {
    std::string error;
    for (const auto& path : {LR"(relative)", LR"(\\server\share)", LR"(\\?\C:\Owned)", LR"(C:\Owned\..\Player)", LR"(C:\Owned:stream)", L"C:\\bad\nname"}) {
        auto r = import_request(); r.source = path;
        CHECK(!save_import_args::build(r, installed_build, error));
        r = import_request(); r.save_dir = path;
        CHECK(!save_import_args::build(r, installed_build, error));
    }
    auto nul = import_request(); nul.source = std::filesystem::path(std::wstring(L"C:\\Owned\0hidden", 15));
    CHECK(!save_import_args::build(nul, installed_build, error));
    auto r = import_request(); r.mode = "build --delete"; CHECK(!save_import_args::build(r, installed_build, error));
    r = import_request(); r.slot = -1; CHECK(!save_import_args::build(r, installed_build, error));
    r.slot = 10; CHECK(!save_import_args::build(r, installed_build, error));
    r.slot = 0; CHECK(!save_import_args::build(r, {}, error));
}

TEST(save_import_image_campaign_is_forwarded_as_one_argument_for_reads) {
    auto r = import_request(); std::string error;
    r.source = LR"(C:\Owned\xemu disk.qcow2)";
    r.campaign = "E:/UDATA/4156001e/Caf\xc3\xa9's campaign";
    for (const auto& mode : {"inspect", "preview"}) {
        r.mode = mode;
        const auto args = save_import_args::build(r, installed_build, error);
        CHECK(args.has_value()); CHECK(args->front() == r.source.wstring());
        CHECK(args->at(args->size() - 2) == L"--campaign");
        CHECK(args->back() == L"E:/UDATA/4156001e/Caf\u00e9's campaign");
    }
    r.mode = "inspect";
    for (const auto& bad : {std::string("a\nb"), std::string("a\0b", 3), std::string(4097, 'a'), std::string("\xff")}) {
        r.campaign = bad; CHECK(!save_import_args::build(r, installed_build, error));
    }
}

TEST(save_import_recomp_kind_is_explicit_and_never_a_shell_fragment) {
    auto r = import_request(); std::string error;
    r.source_kind = "recomp";
    for (const auto& mode : {"inspect", "preview"}) {
        r.mode = mode;
        const auto args = save_import_args::build(r, installed_build, error);
        CHECK(args.has_value());
        if (args) {
            CHECK(args->at(args->size() - 2) == L"--source-kind");
            CHECK(args->back() == L"recomp");
            CHECK(args->front() == r.source.wstring());
        }
    }
    for (const auto& bad : {"unknown", "recomp --dry-run", "recomp\nxemu"}) {
        r.source_kind = bad; CHECK(!save_import_args::build(r, installed_build, error));
    }
}
