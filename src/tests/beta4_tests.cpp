#include "std_include.hpp"
#include "test.hpp"
#include "xml1/build_appearance.hpp"
#include "xml1/build_recovery.hpp"
#include "updater/patch_records.hpp"
#include <rapidjson/writer.h>
#include <fstream>

namespace
{
    struct fixture
    {
        std::filesystem::path out = std::filesystem::temp_directory_path() /
            ("ul-rebuild-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fixture()
        {
            std::filesystem::create_directories(out / "_build");
            write("XMen2.exe", "synthetic exe");
            write("dinput.dll", "synthetic fix");
            write("_build/stamp.json", R"({"builder":{"version":"fixture"}})");
        }
        ~fixture() { std::error_code ignored; std::filesystem::remove_all(out, ignored); }
        void write(const char* name, const std::string& contents) { std::ofstream(out / name, std::ios::binary) << contents; }
    };
    rapidjson::Document roundtrip(const rapidjson::Document& doc)
    {
        rapidjson::StringBuffer buffer;
        rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
        doc.Accept(writer);
        rapidjson::Document parsed;
        parsed.Parse(buffer.GetString());
        return parsed;
    }
}

TEST(classic_conversation_uses_the_installed_builder_release_not_an_available_update)
{
    for (const auto* version : {"", "dev", "garbage", "0.4.0", "0.6.0-beta.1"})
        CHECK(!xml1::supports_classic_conversation(version));
    for (const auto* version : {"0.6.0-beta.2", "0.6.0-beta.10", "0.6.0-rc.1", "0.6.0", "0.7.0"})
        CHECK(xml1::supports_classic_conversation(version));
}

TEST(classic_conversation_passes_explicit_off_and_xml1_only_to_supported_builders)
{
    CHECK(xml1::conversation_arguments("0.6.0-beta.1", false).empty());
    CHECK(xml1::conversation_arguments("0.6.0-beta.1", true).empty());
    const std::vector<std::wstring> on{L"--classic-conversation", L"xml1"};
    const std::vector<std::wstring> off{L"--classic-conversation", L"off"};
    CHECK(xml1::conversation_arguments("0.6.0-beta.2", true) == on);
    CHECK(xml1::conversation_arguments("0.6.0-beta.2", false) == off);
}

TEST(early_cancel_or_process_start_failure_can_restore_an_unchanged_ready_build)
{
    fixture f;
    const auto before = xml1::completed_build_stamp(f.out);
    CHECK(before.has_value());
    CHECK(xml1::unchanged_completed_build(f.out, before));
    CHECK(!xml1::unchanged_completed_build(f.out, std::nullopt)); // never promote a previously unfinished install
}

TEST(cancel_after_builder_writes_marker_requires_resume)
{
    fixture f;
    const auto before = xml1::completed_build_stamp(f.out);
    f.write("_build/building.json", "{}");
    CHECK(!xml1::unchanged_completed_build(f.out, before));
}

TEST(changed_stamp_or_missing_executable_or_fix_never_restores_ready)
{
    for (const auto* missing : {"XMen2.exe", "dinput.dll", "_build/stamp.json"})
    {
        fixture f;
        const auto before = xml1::completed_build_stamp(f.out);
        std::filesystem::remove(f.out / missing);
        CHECK(!xml1::unchanged_completed_build(f.out, before));
    }
    fixture f;
    const auto before = xml1::completed_build_stamp(f.out);
    f.write("_build/stamp.json", "changed stamp");
    CHECK(!xml1::unchanged_completed_build(f.out, before));
}

TEST(second_folder_fix_prep_preserves_legacy_beta_record_even_if_build_is_refused)
{
    rapidjson::Document doc;
    doc.Parse(R"({"install":"first","version":"1.11.0-beta.1","sha1":"beta-hash"})");
    patch_records::write(doc, "second", {"1.8.1", "stable-hash"});
    const auto persisted = roundtrip(doc);
    const auto first = patch_records::read(persisted, "first", true);
    const auto second = patch_records::read(persisted, "second", false);
    CHECK(first && first->version == "1.11.0-beta.1" && first->sha1 == "beta-hash");
    CHECK(second && second->version == "1.8.1" && second->sha1 == "stable-hash");
    CHECK(!patch_records::read(persisted, "third", false));
}

TEST(folder_release_updates_and_uninstall_preserve_other_folders)
{
    rapidjson::Document doc(rapidjson::kObjectType);
    patch_records::write(doc, "first", {"1.11.0-beta.1", "old"});
    patch_records::write(doc, "second", {"1.8.1", "stable"});
    patch_records::write(doc, "first", {"1.11.0-beta.2", "new"});
    auto persisted = roundtrip(doc);
    CHECK(patch_records::read(persisted, "first", false).value().version == "1.11.0-beta.2");
    patch_records::forget(persisted, "second", false);
    CHECK(!patch_records::read(persisted, "second", false));
    CHECK(patch_records::read(persisted, "first", false).value().sha1 == "new");
}

TEST(forgetting_legacy_folder_does_not_remove_new_folder_records)
{
    rapidjson::Document doc;
    doc.Parse(R"({"install":"first","version":"1.11.0-beta.1","sha1":"beta-hash"})");
    patch_records::write(doc, "second", {"1.8.1", "stable-hash"});
    patch_records::forget(doc, "first", true);
    CHECK(!patch_records::read(doc, "first", false));
    CHECK(patch_records::read(doc, "second", false).value().version == "1.8.1");
    CHECK(!doc.HasMember("install"));
}

TEST(malformed_folder_records_are_ignored_and_writable_again)
{
    rapidjson::Document doc;
    doc.Parse(R"({"folders":{"first":42}})");
    CHECK(!patch_records::read(doc, "first", false));
    patch_records::write(doc, "first", {"1.8.1", "hash"});
    CHECK(patch_records::read(doc, "first", false).value().version == "1.8.1");
}

TEST(active_folder_mirror_remains_readable_by_old_launchers_without_losing_other_folders)
{
    rapidjson::Document doc;
    doc.Parse(R"({"install":"first","version":"1.11.0-beta.1","sha1":"beta"})");
    patch_records::preserve_legacy(doc, "first");
    patch_records::write(doc, "second", {"1.8.1", "stable"}); // refused prep: no mirror move
    CHECK(patch_records::text(doc, "install") == "first");
    CHECK(patch_records::text(doc, "version") == "1.11.0-beta.1");
    patch_records::mirror_active(doc, "second", {"1.8.1", "stable"}); // successful build/Verify now active there
    CHECK(patch_records::text(doc, "install") == "second");
    CHECK(patch_records::text(doc, "version") == "1.8.1");
    CHECK(patch_records::read(doc, "first", false).value().version == "1.11.0-beta.1");
    patch_records::write(doc, "second", {"1.8.2", "new"});
    patch_records::preserve_legacy(doc, "second"); // stale mirror must not replace newer folder entry
    CHECK(patch_records::read(doc, "second", false).value().version == "1.8.2");
}
