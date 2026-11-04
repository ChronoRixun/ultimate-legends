#include "std_include.hpp"
#include "test.hpp"
#include "muac/runtime_update.hpp"
#include "muac/setup_cleanup.hpp"
#include <utils/cryptography.hpp>
#include "updater/release_channel.hpp"
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <map>
#include <sstream>

namespace {
    namespace runtime = muac::runtime;
    // An injected deterministic hash keeps these transaction tests independent of
    // the launcher's crypto library; production supplies actual SHA-256.
    std::string hash(const std::string& bytes) {
        std::ostringstream out; out << std::hex << std::setfill('0') << std::setw(64) << std::hash<std::string>{}(bytes); return out.str();
    }
    void put(const std::filesystem::path& file, const std::string& value) {
        std::filesystem::create_directories(file.parent_path()); std::ofstream(file, std::ios::binary) << value;
    }
    std::string get(const std::filesystem::path& file) { return runtime::read_file(file); }
    template<class F> bool refuses(F&& body) { try { body(); return false; } catch (const std::exception&) { return true; } }
    struct fixture {
        std::filesystem::path root, game, bundle;
        std::map<std::string, std::string> payload = {
            {"dinput8.dll", "synthetic input fix"}, {"version.dll", "synthetic compatibility"},
            {"version.json", R"({"logging":false,"nested":{"new":2},"newKey":true})"},
            {"muac-fix.ini", "[Input]\nControllerSupport=1\nNewKey=1\n[New]\nFirst=1\nSecond=2\n"},
            {"dgVoodoo.conf", "[General]\nFullScreenMode=false\nCaptureMouse=false\n[DirectX]\nForceVerticalSync=false\n"},
            {"_muac/licenses/muac-fix.txt", "synthetic notice"}};
        const std::string graphics = "synthetic graphics DLL";
        fixture() {
            static unsigned count{};
            root = std::filesystem::temp_directory_path() / ("ul-runtime-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" + std::to_string(++count));
            game = root / "game"; bundle = root / "bundle";
            std::filesystem::create_directories(game); std::filesystem::create_directories(bundle);
            for (const auto& [target, bytes] : payload) { put(bundle / target, bytes); put(game / target, "old " + target); }
            put(game / "D3D9.dll", "old graphics");
            put(game / "muac-fix.ini", "; owner comment\n[INPUT]\nControllerSupport = 0 ; keep\nCustom=owned\n");
            put(game / "dgVoodoo.conf", "[General]\nFullScreenMode=true\nCaptureMouse=true\n[DirectX]\nForceVerticalSync=true\n");
            put(game / "version.json", R"({"logging":true,"nested":{"custom":1},"owner":42})");
            put(game / "_muac/runtime.json", R"({"schema":1,"version":"0.2.0","prepared":true})");
            put(game / "Game.exe", "synthetic owner executable"); put(game / "saves/keep", "synthetic save");
            put(game / "mods/keep", "synthetic mod"); put(game / "_muac/setup.json", "synthetic import record");
        }
        ~fixture() { std::error_code ignored; std::filesystem::remove_all(root, ignored); }
        std::string json(const runtime::hash_function& digest = hash) const {
            std::string out = R"({"schema":1,"version":"0.2.1","files":[)"; bool comma = false;
            for (const auto& [target, bytes] : payload) {
                if (comma) out += ','; comma = true;
                out += "{\"source\":\"" + target + "\",\"target\":\"" + target + "\",\"size\":" + std::to_string(bytes.size()) + ",\"sha256\":\"" + digest(bytes) + "\"}";
            }
            return out + R"(],"dgvoodoo":{"url":"https://github.com/dege-diosg/dgVoodoo2/releases/download/v-test/graphics.zip","member":"MS/x86/D3D9.dll","size":1,"sha256":")" + digest("archive") +
                "\",\"dll_size\":" + std::to_string(graphics.size()) + ",\"dll_sha256\":\"" + digest(graphics) + "\"}}";
        }
        runtime::package package() const { return runtime::parse_package(json(), "0.2.1"); }
        void update(const runtime::controls& control = {}) { runtime::update(game, bundle, package(), graphics, hash, control); }
        std::map<std::string, std::string> snapshot() const {
            std::map<std::string, std::string> out;
            for (const auto& file : std::filesystem::recursive_directory_iterator(game))
                if (file.is_regular_file()) out.emplace(file.path().lexically_relative(game).generic_string(), get(file.path()));
            return out;
        }
    };
}

TEST(muac_version_record_is_typed_bounded_and_keeps_prerelease) {
    CHECK(runtime::record_version(R"({"schema":1,"prepared":true,"version":"0.2.1-beta.2"})") == "0.2.1-beta.2");
    for (const auto& json : {"broken", "[]", R"({"schema":1,"prepared":true,"version":2})",
        R"({"schema":1,"prepared":"true","version":"0.2.1"})", R"({"schema":2,"prepared":true,"version":"0.2.1"})",
        R"({"schema":1,"prepared":true,"version":"garbage"})", R"({"schema":1,"prepared":true,"version":"0.2.1\u0000bad"})"})
        CHECK(!runtime::record_version(json));
    CHECK(!runtime::record_version(std::string(128 * 1024 + 1, ' ')));
    const auto json = R"({"schema":1,"prepared":true,"version":"0.2.1-beta.2","files":[{"target":"dinput8.dll","sha256":")" + hash("dll") + "\"}]}";
    CHECK(runtime::record_version(json, hash("dll")) == "0.2.1-beta.2");
    CHECK(!runtime::record_version(json, hash("manually replaced dll")));
}
TEST(muac_release_comparison_and_min_launcher_respect_semver) {
    CHECK(runtime::newer_compatible("0.2.0", "0.2.1", "0.5.0-beta.6", "0.5.0-beta.7"));
    CHECK(runtime::newer_compatible("0.2.1-beta.2", "0.2.1-beta.10", "", "0.5.0-beta.7"));
    CHECK(runtime::newer_compatible("0.2.1-beta.2", "0.2.1", "", "0.5.0-beta.7"));
    CHECK(!runtime::newer_compatible("0.2.1", "0.2.1-beta.10", "", "0.5.0-beta.7"));
    CHECK(!runtime::newer_compatible("0.2.1", "0.2.1", "", "0.5.0-beta.7"));
    CHECK(!runtime::newer_compatible("0.2.0", "0.2.1", "0.5.0", "0.5.0-beta.7"));
    CHECK(!runtime::newer_compatible("0.2.0", "0.2.1", "bad", "0.5.0-beta.7"));
    CHECK(runtime::newer_compatible("", "0.2.1", "", "0.5.0-beta.7"));
    CHECK(runtime::newer_compatible("0.2.2", "0.2.2", "0.5.0-beta.8", "0.5.0-beta.8", true));
    CHECK(!runtime::newer_compatible("0.2.1", "0.2.1", "", "0.5.0-beta.8", true));
    CHECK(!runtime::newer_compatible("0.2.2", "0.2.2", "0.5.0-beta.8", "0.5.0-beta.7", true));
    CHECK(!runtime::newer_compatible("0.2.3", "0.2.2", "", "0.5.0", true));
}
TEST(muac_release_channel_requires_setup_manifest_and_picks_latest_beta) {
    std::string error;
    const auto releases = release_channel::parse_releases_json(R"([
        {"tag_name":"v0.2.2-beta.10","prerelease":true,"assets":[{"name":"muac-setup.json"}]},
        {"tag_name":"v0.2.2-beta.2","prerelease":true,"assets":[{"name":"muac-setup.json"}]},
        {"tag_name":"v0.2.3","assets":[{"name":"other.json"}]},
        {"tag_name":"v0.2.1","assets":[{"name":"muac-setup.json"}]}])", error);
    CHECK(error.empty());
    const auto stable = release_channel::pick(release_channel::channel::stable, releases, {"muac-setup.json"});
    const auto beta = release_channel::pick(release_channel::channel::beta, releases, {"muac-setup.json"});
    CHECK(stable && stable->version == "0.2.1"); CHECK(beta && beta->version == "0.2.2-beta.10");
}
TEST(muac_runtime_package_refuses_game_files_traversal_duplicates_and_wrong_release) {
    fixture f; CHECK(f.package().version == "0.2.1");
    CHECK(refuses([&] { runtime::parse_package(f.json(), "0.2.2"); }));
    for (const auto& target : {"Game.exe", "saves/keep", "../dinput8.dll", "DINPUT8.dll", "dinput8.dll:stream"}) {
        auto json = f.json(); const auto at = json.find("\"target\":\"dinput8.dll\"");
        json.replace(at, std::string("\"target\":\"dinput8.dll\"").size(), "\"target\":\"" + std::string(target) + "\"");
        CHECK(refuses([&] { runtime::parse_package(json, "0.2.1"); }));
    }
    auto bad = f.json(); const auto at = bad.find("\"source\":\"dinput8.dll\"");
    bad.replace(at, std::string("\"source\":\"dinput8.dll\"").size(), "\"source\":\"../outside\"");
    CHECK(refuses([&] { runtime::parse_package(bad, "0.2.1"); }));
    f.payload.erase("dinput8.dll"); CHECK(refuses([&] { f.package(); }));
}
TEST(muac_runtime_updates_only_runtime_and_merges_missing_keys) {
    fixture f; const auto before = f.snapshot(); f.update(); const auto after = f.snapshot();
    CHECK(after.at("dinput8.dll") == f.payload.at("dinput8.dll")); CHECK(after.at("D3D9.dll") == f.graphics);
    CHECK(after.at("muac-fix.ini").find("ControllerSupport = 0 ; keep") != std::string::npos);
    CHECK(after.at("muac-fix.ini").find("; owner comment") != std::string::npos);
    CHECK(after.at("muac-fix.ini").find("Custom=owned") != std::string::npos);
    CHECK(after.at("muac-fix.ini").find("NewKey=1") != std::string::npos);
    CHECK(after.at("muac-fix.ini").find("[new]\nFirst=1\nSecond=2\n") != std::string::npos);
    CHECK(after.at("dgVoodoo.conf") == before.at("dgVoodoo.conf"));
    rapidjson::Document json; json.Parse(after.at("version.json").c_str());
    CHECK(json["logging"].GetBool()); CHECK(json["owner"].GetInt() == 42); CHECK(json["nested"]["custom"].GetInt() == 1);
    CHECK(json["nested"]["new"].GetInt() == 2); CHECK(json["newKey"].GetBool());
    CHECK(runtime::record_version(after.at("_muac/runtime.json")) == "0.2.1");
    CHECK(runtime::record_version(after.at("_muac/runtime.json"), hash(after.at("dinput8.dll"))) == "0.2.1");
    for (const auto* file : {"Game.exe", "saves/keep", "mods/keep", "_muac/setup.json"}) CHECK(after.at(file) == before.at(file));
    CHECK(after.size() == before.size()); CHECK(!runtime::recovery_pending(f.game));
}
TEST(muac_wine_update_removes_and_persistently_backs_up_inherited_d3d9) {
    fixture f; const auto before = f.snapshot(); runtime::controls control; control.wine = true;
    // No graphics archive/DLL is consumed on Wine; all other payloads are verified.
    runtime::update(f.game, f.bundle, f.package(), "", hash, control);
    CHECK(!std::filesystem::exists(f.game / "D3D9.dll"));
    const auto record = get(f.game / "_muac/runtime.json");
    rapidjson::Document json; json.Parse(record.c_str());
    CHECK(json["graphics"] == "wine-d3d9");
    CHECK(json["removed_files"].Size() == 1);
    const auto& removed = json["removed_files"][0];
    CHECK(removed["target"] == "D3D9.dll");
    CHECK(removed["sha256"] == hash("old graphics"));
    CHECK(get(f.game / removed["backup"].GetString()) == "old graphics");
    for (const auto& item : json["files"].GetArray()) CHECK(item["target"] != "D3D9.dll");
    for (const auto* file : {"Game.exe", "saves/keep", "mods/keep", "_muac/setup.json", "dgVoodoo.conf"})
        CHECK(get(f.game / file) == before.at(file));
    // A second update neither restores D3D9 nor deletes the retained backup.
    const auto backup = f.game / removed["backup"].GetString();
    runtime::update(f.game, f.bundle, f.package(), "", hash, control);
    CHECK(!std::filesystem::exists(f.game / "D3D9.dll")); CHECK(get(backup) == "old graphics");
    rapidjson::Document again; again.Parse(get(f.game / "_muac/runtime.json").c_str());
    CHECK(again["removed_files"].Size() == 1);
    if (!again["removed_files"].Empty()) CHECK(again["removed_files"][0]["backup"] == removed["backup"]);
}
TEST(muac_wine_backup_collision_is_refused_and_matching_backup_is_kept) {
    fixture f; runtime::controls control; control.wine = true;
    const auto backup = f.game / ("_muac/backups/D3D9-" + hash("old graphics") + ".dll");
    put(backup, "owner file"); const auto before = f.snapshot();
    CHECK(refuses([&] { runtime::update(f.game, f.bundle, f.package(), "", hash, control); }));
    CHECK(f.snapshot() == before);
    put(backup, "old graphics");
    const auto timestamp = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24);
    std::filesystem::last_write_time(backup, timestamp);
    runtime::update(f.game, f.bundle, f.package(), "", hash, control);
    CHECK(get(backup) == "old graphics"); CHECK(std::filesystem::last_write_time(backup) == timestamp);
    CHECK(!std::filesystem::exists(f.game / "D3D9.dll"));
}
TEST(muac_wine_cancel_after_removal_restores_every_original) {
    fixture f; const auto before = f.snapshot(); runtime::controls control; control.wine = true;
    bool cancelled = false; control.cancelled = [&] { return cancelled; };
    control.before_replace = [&](const std::string& target) { if (target == "dinput8.dll") cancelled = true; };
    CHECK(refuses([&] { runtime::update(f.game, f.bundle, f.package(), "", hash, control); }));
    CHECK(f.snapshot() == before); CHECK(!runtime::recovery_pending(f.game));
}
TEST(muac_wine_recovery_restores_removed_dll_and_removes_uncommitted_backup) {
    fixture f; const auto before = f.snapshot(); const auto stage = f.game / ".muac-stage-update-fixture";
    const auto backup = "_muac/backups/D3D9-" + hash("old graphics") + ".dll";
    std::filesystem::create_directories(stage / "old");
    std::filesystem::rename(f.game / "D3D9.dll", stage / "old/D3D9.dll"); put(f.game / backup, "old graphics");
    put(stage / "journal.json", std::string(R"({"state":"committing","files":[{"target":"D3D9.dll","existed":true,"remove":true},{"target":")") +
        backup + R"(","existed":false,"remove":false}]})");
    CHECK(runtime::recovery_pending(f.game)); runtime::recover(f.game);
    CHECK(f.snapshot() == before); CHECK(!runtime::recovery_pending(f.game));
}
TEST(muac_wine_removal_is_rolled_back_when_metadata_promotion_fails) {
    fixture f; const auto before = f.snapshot(); runtime::controls control; control.wine = true;
    control.before_replace = [](const std::string& target) {
        if (target == "_muac/runtime.json") throw std::runtime_error("injected final replacement failure");
    };
    CHECK(refuses([&] { runtime::update(f.game, f.bundle, f.package(), "", hash, control); }));
    CHECK(f.snapshot() == before); CHECK(!runtime::recovery_pending(f.game));
}
TEST(muac_wine_still_refuses_corrupt_payload_and_d3d9_directory) {
    fixture f; const auto before = f.snapshot(); runtime::controls control; control.wine = true;
    put(f.bundle / "version.dll", "corrupt");
    CHECK(refuses([&] { runtime::update(f.game, f.bundle, f.package(), "", hash, control); }));
    CHECK(f.snapshot() == before);
    put(f.bundle / "version.dll", f.payload.at("version.dll"));
    std::filesystem::remove(f.game / "D3D9.dll"); std::filesystem::create_directory(f.game / "D3D9.dll");
    CHECK(refuses([&] { runtime::update(f.game, f.bundle, f.package(), "", hash, control); }));
    CHECK(std::filesystem::is_directory(f.game / "D3D9.dll"));
}
TEST(muac_wine_update_without_existing_d3d9_never_places_one) {
    fixture f; std::filesystem::remove(f.game / "D3D9.dll");
    runtime::controls control; control.wine = true;
    runtime::update(f.game, f.bundle, f.package(), "", hash, control);
    CHECK(!std::filesystem::exists(f.game / "D3D9.dll"));
    CHECK(!std::filesystem::exists(f.game / "_muac/backups"));
    rapidjson::Document record; record.Parse(get(f.game / "_muac/runtime.json").c_str());
    CHECK(record["graphics"] == "wine-d3d9"); CHECK(record["removed_files"].Empty());
}
TEST(muac_runtime_refuses_running_game_before_writes_and_rolls_back_race) {
    fixture f; const auto before = f.snapshot(); runtime::controls control; control.running = [] { return true; };
    CHECK(refuses([&] { f.update(control); })); CHECK(f.snapshot() == before);
    bool running = false; control.running = [&] { return running; };
    control.before_replace = [&](const std::string& target) { if (target == "dinput8.dll") running = true; };
    CHECK(refuses([&] { f.update(control); })); CHECK(f.snapshot() == before);
}
TEST(muac_runtime_failed_copy_and_cancel_restore_every_original_file) {
    fixture f; const auto before = f.snapshot(); runtime::controls control;
    control.before_replace = [](const std::string& target) { if (target == "version.dll") throw std::runtime_error("injected replacement failure"); };
    CHECK(refuses([&] { f.update(control); })); CHECK(f.snapshot() == before);
    bool cancelled = false; control.cancelled = [&] { return cancelled; };
    control.before_replace = [&](const std::string& target) { if (target == "dinput8.dll") cancelled = true; };
    CHECK(refuses([&] { f.update(control); })); CHECK(f.snapshot() == before);
}
TEST(muac_runtime_hash_failure_leaves_install_unchanged) {
    fixture f; const auto before = f.snapshot(); put(f.bundle / "version.dll", "corruption");
    CHECK(refuses([&] { f.update(); })); CHECK(f.snapshot() == before);
    CHECK(refuses([&] { runtime::update(f.game, f.bundle, f.package(), "bad graphics", hash); })); CHECK(f.snapshot() == before);
}
TEST(muac_runtime_recovery_restores_interrupted_commit_and_cleans_committed_stage) {
    fixture f; const auto before = f.snapshot(); const auto stage = f.game / ".muac-stage-update-fixture";
    put(stage / "old/dinput8.dll", before.at("dinput8.dll")); put(f.game / "dinput8.dll", "partial replacement");
    put(f.game / "_muac/THIRD_PARTY.txt", "newly installed notice");
    put(stage / "journal.json", R"({"state":"committing","files":[{"target":"dinput8.dll","existed":true},{"target":"_muac/THIRD_PARTY.txt","existed":false}]})");
    CHECK(runtime::recovery_pending(f.game)); runtime::recover(f.game); CHECK(f.snapshot() == before); CHECK(!runtime::recovery_pending(f.game));
    put(stage / "journal.json", R"({"state":"committed","files":[]})");
    CHECK(!runtime::recovery_pending(f.game)); runtime::recover(f.game); CHECK(f.snapshot() == before);
}
TEST(muac_runtime_refuses_unsafe_recovery_journal_and_paths) {
    fixture f; const auto before = get(f.game / "Game.exe");
    put(f.game / ".muac-stage-update-fixture/journal.json", R"({"state":"committing","files":[{"target":"Game.exe","existed":false}]})");
    CHECK(refuses([&] { runtime::recover(f.game); })); CHECK(get(f.game / "Game.exe") == before);
    CHECK(refuses([&] { runtime::guard(f.game / ".." / "game"); }));
    CHECK(refuses([&] { runtime::resolve_game_folder(f.game / ".." / "game"); }));
    CHECK(refuses([&] { runtime::resolve_game_folder(f.game / "file:stream"); }));
    CHECK(refuses([&] { runtime::resolve_game_folder("relative"); }));
    CHECK(refuses([&] { runtime::guard(f.game / "file:stream"); })); CHECK(refuses([&] { runtime::guard("relative"); }));
}
TEST(muac_runtime_preserves_utf16_ini_settings_and_adds_new_keys) {
    fixture f; const std::u16string old = u"[Input]\nControllerSupport=0\nCustom=\u2603\n";
    std::string bytes = "\xff\xfe";
    for (const auto c : old) { bytes.push_back(static_cast<char>(c & 255)); bytes.push_back(static_cast<char>(c >> 8)); }
    put(f.game / "muac-fix.ini", bytes); f.update(); const auto merged = get(f.game / "muac-fix.ini");
    std::u16string text;
    for (std::size_t i = 2; i < merged.size(); i += 2) text.push_back(static_cast<char16_t>(static_cast<unsigned char>(merged[i]) | (static_cast<unsigned char>(merged[i+1]) << 8)));
    CHECK(text.find(u"ControllerSupport=0") != std::u16string::npos); CHECK(text.find(u"Custom=\u2603") != std::u16string::npos);
    CHECK(text.find(u"NewKey=1") != std::u16string::npos);
}

TEST(muac_runtime_malformed_player_configuration_is_never_overwritten) {
    fixture f; put(f.game / "version.json", "not json"); const auto before = f.snapshot();
    CHECK(refuses([&] { f.update(); })); CHECK(f.snapshot() == before);
}
TEST(muac_runtime_unchanged_settings_are_not_replaced) {
    fixture f;
    put(f.game / "muac-fix.ini", f.payload.at("muac-fix.ini") + "Owner=custom\n");
    put(f.game / "version.json", R"({"logging":true,"nested":{"new":3},"newKey":false,"owner":42})");
    const auto timestamp = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24);
    for (const auto* name : {"muac-fix.ini", "dgVoodoo.conf", "version.json"}) std::filesystem::last_write_time(f.game / name, timestamp);
    const auto before = f.snapshot(); f.update();
    for (const auto* name : {"muac-fix.ini", "dgVoodoo.conf", "version.json"}) {
        CHECK(get(f.game / name) == before.at(name));
        CHECK(std::filesystem::last_write_time(f.game / name) == timestamp);
    }
}
#ifdef _WIN32
TEST(muac_wine_locked_inherited_d3d9_is_kept_with_a_clear_error) {
    fixture f; const auto before = f.snapshot(); runtime::controls control; control.wine = true;
    const auto lock = CreateFileW((f.game / "D3D9.dll").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    CHECK(lock != INVALID_HANDLE_VALUE);
    std::string error;
    try { runtime::update(f.game, f.bundle, f.package(), "", hash, control); } catch (const std::exception& e) { error = e.what(); }
    CloseHandle(lock);
    CHECK(error == runtime::file_in_use_message); CHECK(f.snapshot() == before);
    CHECK(!runtime::recovery_pending(f.game));
}
TEST(muac_runtime_locked_destination_rolls_back_real_rename_failure) {
    fixture f; const auto before = f.snapshot();
    const auto lock = CreateFileW((f.game / "version.dll").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    CHECK(lock != INVALID_HANDLE_VALUE);
    std::string error;
    try { f.update(); } catch (const std::exception& e) { error = e.what(); }
    CloseHandle(lock);
    CHECK(error == runtime::file_in_use_message);
    CHECK(!runtime::recovery_pending(f.game));
    CHECK(f.snapshot() == before);
}
TEST(muac_runtime_failed_rollback_is_recoverable_after_lock_is_released) {
    fixture f; const auto before = f.snapshot(); runtime::controls control;
    HANDLE lock = INVALID_HANDLE_VALUE;
    control.before_replace = [&](const std::string& target) {
        if (target != "version.dll") return;
        lock = CreateFileW((f.game / "D3D9.dll").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
        throw std::runtime_error("injected interruption with locked replacement");
    };
    CHECK(refuses([&] { f.update(control); })); CHECK(lock != INVALID_HANDLE_VALUE);
    CHECK(runtime::recovery_pending(f.game)); CloseHandle(lock);
    runtime::recover(f.game); CHECK(!runtime::recovery_pending(f.game)); CHECK(f.snapshot() == before);
}
TEST(muac_runtime_unicode_installation_and_unrelated_names_are_supported) {
    fixture f; const auto moved = f.root / L"\u2603-game";
    std::filesystem::rename(f.game, moved); f.game = moved;
    put(f.game / L"\u2603-owner.txt", "owner data");
    CHECK(!runtime::recovery_pending(f.game)); f.update();
    CHECK(get(f.game / L"\u2603-owner.txt") == "owner data"); CHECK(get(f.game / "dinput8.dll") == f.payload.at("dinput8.dll"));
}
#endif

// Production passes utils::cryptography::sha256::compute(bytes, true), which is upper-case hex,
// while packages and runtime records carry lower-case SHA-256 (checksum() accepts only those).
TEST(muac_update_accepts_upper_case_production_digests_and_records_lower_case) {
    const auto upper = [](const std::string& bytes) {
        auto out = hash(bytes);
        for (auto& c : out) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        return out;
    };
    fixture f;
    CHECK(!refuses([&] { runtime::update(f.game, f.bundle, f.package(), f.graphics, upper); }));
    const auto record = get(f.game / "_muac/runtime.json");
    CHECK(runtime::record_version(record) == "0.2.1");
    CHECK(runtime::record_version(record, upper(f.payload.at("dinput8.dll"))) == "0.2.1");
    CHECK(runtime::record_version(record, hash(f.payload.at("dinput8.dll"))) == "0.2.1");
    CHECK(get(f.game / "D3D9.dll") == f.graphics);
}

#ifdef _WIN32
// Exercise the exact resolve-once boundary used by start_update, with an NTFS junction.
TEST(muac_linked_install_updates_the_resolved_tree_and_recovers_through_the_link) {
    fixture f;
    const auto link = f.root / "linked";
    const auto command = "cmd /c mklink /J \"" + link.string() + "\" \"" + f.game.string() + "\" >nul 2>nul";
    CHECK(std::system(command.c_str()) == 0);
    CHECK(std::filesystem::exists(link / "Game.exe"));
    if (!std::filesystem::exists(link / "Game.exe")) return;
    CHECK(!runtime::recovery_pending(link));
    CHECK(runtime::record_version(runtime::read_status_file(link / "_muac/runtime.json")) == "0.2.0");
    const auto real = runtime::resolve_game_folder(link);
    CHECK(real == runtime::resolve_game_folder(f.game));
    const auto before = f.snapshot();
    put(real / ".muac-stage-update-fixture/journal.json", R"({"state":"committing","files":[]})");
    CHECK(runtime::recovery_pending(link));
    bool stage_on_real_path = false;
    runtime::controls control;
    control.before_replace = [&](const std::string&) {
        for (const auto& entry : std::filesystem::directory_iterator(real))
            if (entry.path().filename().wstring().starts_with(L".muac-stage-update-")) stage_on_real_path = true;
        // Remove the selected alias mid-transaction: every write must keep using real.
        if (std::filesystem::exists(link)) CHECK(std::filesystem::remove(link));
    };
    runtime::update(real, f.bundle, f.package(), f.graphics, hash, control);
    CHECK(stage_on_real_path);
    CHECK(!runtime::recovery_pending(real));
    CHECK(get(real / "dinput8.dll") == f.payload.at("dinput8.dll"));
    for (const auto* file : {"Game.exe", "saves/keep", "mods/keep", "_muac/setup.json"}) CHECK(get(real / file) == before.at(file));
    // Ancestor junctions are accepted by the same boundary.
    const auto parent_link = f.root / "parent-link";
    const auto parent_command = "cmd /c mklink /J \"" + parent_link.string() + "\" \"" + f.root.string() + "\" >nul 2>nul";
    CHECK(std::system(parent_command.c_str()) == 0);
    CHECK(runtime::resolve_game_folder(parent_link / "game") == real);
    CHECK(std::filesystem::remove(parent_link));
}
TEST(muac_resolved_update_still_refuses_internal_junctions) {
    fixture f; const auto before = f.snapshot();
    const auto metadata = f.root / "metadata";
    std::filesystem::rename(f.game / "_muac", metadata);
    const auto link = f.game / "_muac";
    const auto command = "cmd /c mklink /J \"" + link.string() + "\" \"" + metadata.string() + "\" >nul 2>nul";
    CHECK(std::system(command.c_str()) == 0);
    CHECK(std::filesystem::exists(link / "setup.json"));
    const auto real = runtime::resolve_game_folder(f.game);
    CHECK(refuses([&] { runtime::update(real, f.bundle, f.package(), f.graphics, hash); }));
    CHECK(runtime::read_status_file(metadata / "setup.json") == "synthetic import record");
    CHECK(std::filesystem::remove(link));
    std::filesystem::rename(metadata, f.game / "_muac");
    CHECK(f.snapshot() == before);
    CHECK(!runtime::recovery_pending(real));
}
#endif

TEST(muac_update_uses_production_sha256_with_lowercase_manifest) {
    const auto production = [](const std::string& bytes) { return utils::cryptography::sha256::compute(bytes, true); };
    const auto lower_sha256 = [&](const std::string& bytes) {
        auto out = production(bytes);
        std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return out;
    };
    CHECK(lower_sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    fixture f;
    const auto manifest = runtime::parse_package(f.json(lower_sha256), "0.2.1");
    CHECK(!refuses([&] { runtime::update(f.game, f.bundle, manifest, f.graphics, production); }));
    CHECK(runtime::record_version(get(f.game / "_muac/runtime.json"), production(f.payload.at("dinput8.dll"))) == "0.2.1");
    CHECK(get(f.game / "D3D9.dll") == f.graphics);
}

namespace { struct simulated_power_loss {}; }

TEST(muac_atomic_writes_survive_every_temporary_and_publication_boundary) {
    for (const bool wine : {false, true}) {
    // Discover every actual write, including all payloads, merged configuration,
    // runtime.json, the immutable plan and both versions of the journal.
    std::size_t points = 0;
    { fixture f; runtime::controls c; c.wine = wine;
      c.on_write = [&](const auto&, const auto&, bool) { ++points; }; f.update(c); }
    CHECK(points > 10);
    for (std::size_t crash = 0; crash < points; ++crash) {
        fixture f; const auto before = f.snapshot(); runtime::controls c; c.wine = wine;
        std::size_t point = 0; bool committed = false, interrupted = false;
        c.on_write = [&](const auto& destination, const auto& temporary, bool published) {
            if (point++ != crash) return;
            if (!published) {
                // A death during the write leaves a zero-byte or partial temp.
                put(temporary, crash % 2 ? "{" : "");
                if (destination.filename() == "journal.json" && std::filesystem::exists(destination)) {
                    rapidjson::Document previous; previous.Parse(get(destination).c_str());
                    CHECK(!previous.HasParseError()); CHECK(previous["state"] == "committing");
                }
            } else if (destination.filename() == "journal.json") {
                rapidjson::Document journal; journal.Parse(get(destination).c_str());
                committed = journal["state"] == "committed";
            }
            throw simulated_power_loss{}; // deliberately bypass normal exception rollback
        };
        try { f.update(c); } catch (const simulated_power_loss&) { interrupted = true; }
        CHECK(interrupted);
        runtime::recover(f.game); CHECK(!runtime::recovery_pending(f.game));
        if (committed) CHECK(runtime::record_version(get(f.game / "_muac/runtime.json")) == "0.2.1");
        else CHECK(f.snapshot() == before);
        f.update(runtime::controls{}); // recovery never leaves subsequent Update stuck
    }
    }
}

TEST(muac_corrupt_journal_rolls_back_from_plan_at_every_move_boundary) {
    std::size_t moves = 0;
    { fixture f; runtime::controls c; c.wine = true;
      c.before_replace = [&](const std::string&) { ++moves; }; f.update(c); }
    for (const auto& damage : {std::string{}, std::string("{broken")}) {
        for (std::size_t crash = 0; crash < moves; ++crash) {
            fixture f; const auto before = f.snapshot(); runtime::controls c; c.wine = true;
            std::size_t point = 0; bool interrupted = false;
            c.before_replace = [&](const std::string&) {
                if (point++ != crash) return;
                for (const auto& entry : std::filesystem::directory_iterator(f.game))
                    if (entry.path().filename().string().starts_with(".muac-stage-update-")) put(entry.path() / "journal.json", damage);
                throw simulated_power_loss{};
            };
            try { f.update(c); } catch (const simulated_power_loss&) { interrupted = true; }
            if (!interrupted) break;
            CHECK(runtime::recovery_pending(f.game));
            std::string log;
            runtime::recover(f.game, [&](const auto& line) { log += line; });
            CHECK(log.find("backup set") != std::string::npos);
            CHECK(f.snapshot() == before); CHECK(!runtime::recovery_pending(f.game));
            runtime::recover(f.game); CHECK(f.snapshot() == before);
            f.update(c = runtime::controls{});
        }
    }
}

TEST(muac_legacy_empty_initial_journal_with_complete_stage_is_discarded_and_logged) {
    fixture f; const auto before = f.snapshot(); runtime::controls c;
    c.on_write = [&](const auto& destination, const auto&, bool published) {
        if (published && destination.filename() == "journal.json") {
            std::filesystem::remove(destination.parent_path() / "recovery.json");
            put(destination, ""); throw simulated_power_loss{};
        }
    };
    try { f.update(c); } catch (const simulated_power_loss&) {}
    CHECK(runtime::recovery_pending(f.game));
    std::string log; runtime::recover(f.game, [&](const auto& line) { log += line; });
    CHECK(log.find("update never started") != std::string::npos);
    CHECK(f.snapshot() == before); f.update();
}

TEST(muac_ambiguous_legacy_damage_keeps_backups_for_safe_recovery) {
    fixture f; const auto stage = f.game / ".muac-stage-update-legacy";
    put(stage / "journal.json", "");
    put(stage / "old/dinput8.dll", "original input fix");
    CHECK(refuses([&] { runtime::recover(f.game); }));
    CHECK(get(stage / "old/dinput8.dll") == "original input fix");
    CHECK(runtime::recovery_pending(f.game));
}

TEST(muac_missing_or_damaged_completion_journal_uses_backup_plan) {
    for (const bool missing : {false, true}) {
        fixture f; const auto before = f.snapshot(); runtime::controls c; c.wine = true;
        c.on_write = [&](const auto& destination, const auto&, bool published) {
            if (!published || destination.filename() != "journal.json") return;
            rapidjson::Document journal; journal.Parse(get(destination).c_str());
            if (journal["state"] != "committed") return;
            if (missing) std::filesystem::remove(destination);
            else put(destination, "{");
            throw simulated_power_loss{};
        };
        try { f.update(c); } catch (const simulated_power_loss&) {}
        CHECK(runtime::recovery_pending(f.game));
        runtime::recover(f.game); CHECK(f.snapshot() == before);
        CHECK(!runtime::recovery_pending(f.game));
    }
}

TEST(muac_incomplete_legacy_stage_never_discards_a_possible_move) {
    fixture f; runtime::controls c;
    std::filesystem::path stage;
    c.on_write = [&](const auto& destination, const auto&, bool published) {
        if (published && destination.filename() == "journal.json") {
            stage = destination.parent_path();
            std::filesystem::remove(stage / "recovery.json");
            std::filesystem::remove(stage / "new/dinput8.dll");
            put(destination, ""); throw simulated_power_loss{};
        }
    };
    try { f.update(c); } catch (const simulated_power_loss&) {}
    CHECK(refuses([&] { runtime::recover(f.game); }));
    CHECK(std::filesystem::exists(stage / "journal.json"));
    CHECK(runtime::recovery_pending(f.game));
}

TEST(muac_interrupted_runtime_record_promotion_restores_original_record) {
    fixture f; const auto before = f.snapshot(); runtime::controls c;
    c.before_replace = [&](const std::string& target) {
        if (target != "_muac/runtime.json") return;
        for (const auto& entry : std::filesystem::directory_iterator(f.game)) {
            if (!entry.path().filename().string().starts_with(".muac-stage-update-")) continue;
            const auto backup = entry.path() / "old" / target;
            std::filesystem::create_directories(backup.parent_path());
            std::filesystem::rename(f.game / target, backup);
        }
        throw simulated_power_loss{};
    };
    try { f.update(c); } catch (const simulated_power_loss&) {}
    CHECK(!std::filesystem::exists(f.game / "_muac/runtime.json"));
    CHECK(runtime::recovery_pending(f.game));
    runtime::recover(f.game); CHECK(f.snapshot() == before);
}

TEST(muac_legacy_completion_file_recovers_a_damaged_journal_from_backups) {
    fixture f; const auto before = f.snapshot(); runtime::controls c;
    c.on_write = [&](const auto& destination, const auto&, bool published) {
        if (!published || destination.filename() != "journal.json") return;
        rapidjson::Document journal; journal.Parse(get(destination).c_str());
        if (journal["state"] != "committed") return;
        put(destination.parent_path() / "journal.next", get(destination));
        std::filesystem::remove(destination.parent_path() / "recovery.json");
        put(destination, ""); throw simulated_power_loss{};
    };
    try { f.update(c); } catch (const simulated_power_loss&) {}
    runtime::recover(f.game); CHECK(f.snapshot() == before);
    CHECK(!runtime::recovery_pending(f.game));
}
