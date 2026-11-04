#include "std_include.hpp"
#include "runtime_update.hpp"
#include "setup_cleanup.hpp"
#include "updater/release_channel.hpp"
#include <rapidjson/document.h>
#include <rapidjson/prettywriter.h>
#include <fstream>
#include <map>
#include <set>
#include <atomic>
#include <chrono>

namespace muac::runtime {
namespace {
    constexpr std::uint64_t file_limit = 128 * 1024 * 1024;
    const std::set<std::string> required = {"dinput8.dll", "version.dll", "version.json", "muac-fix.ini", "dgVoodoo.conf"};
    const std::set<std::string> optional = {"_muac/THIRD_PARTY.txt", "_muac/licenses/SafeDiscLoader2.txt",
        "_muac/licenses/muac-fix.txt", "_muac/licenses/minhook-BSD.txt", "_muac/licenses/mua-controller-fix-MIT.txt",
        "_muac/licenses/xml2-fix-MIT.txt", "_muac/licenses/SafeDiscLoader2-Minhook.txt", "_muac/licenses/tiny-json-MIT.txt"};
    bool target_allowed(const std::string& name) {
        return required.contains(name) || optional.contains(name) || name == "D3D9.dll" || name == "_muac/runtime.json";
    }
    void require(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }
    std::string text(const rapidjson::Value& value, const char* key) {
        require(value.IsObject() && value.HasMember(key) && value[key].IsString(), "Invalid runtime metadata.");
        const auto& member = value[key];
        std::string out(member.GetString(), member.GetStringLength());
        require(out.find('\0') == std::string::npos, "Invalid runtime metadata string.");
        return out;
    }
    std::uint64_t size(const rapidjson::Value& value, const char* key) {
        require(value.IsObject() && value.HasMember(key) && value[key].IsUint64(), "Invalid runtime file size.");
        const auto out = value[key].GetUint64();
        require(out > 0 && out <= file_limit, "Runtime file exceeds the supported size.");
        return out;
    }
    std::string checksum(const rapidjson::Value& value, const char* key) {
        const auto out = text(value, key);
        require(out.size() == 64 && out.find_first_not_of("0123456789abcdef") == std::string::npos, "Invalid runtime SHA-256.");
        return out;
    }
    rapidjson::Document document(const std::string& json) {
        require(json.size() <= 128 * 1024, "Runtime metadata is too large.");
        rapidjson::Document out; out.Parse(json.data(), json.size());
        require(!out.HasParseError() && out.IsObject(), "Invalid runtime JSON.");
        return out;
    }
    std::string serialize(const rapidjson::Value& value) {
        rapidjson::StringBuffer buffer; rapidjson::PrettyWriter<rapidjson::StringBuffer> writer(buffer);
        value.Accept(writer); return std::string(buffer.GetString(), buffer.GetSize()) + "\n";
    }
    void write_file(const std::filesystem::path& path, const std::string& bytes) {
        guard(path); std::filesystem::create_directories(path.parent_path());
        std::ofstream out(path, std::ios::binary | std::ios::trunc);
        require(static_cast<bool>(out.write(bytes.data(), static_cast<std::streamsize>(bytes.size())).flush()), "Could not stage runtime file.");
    }
    bool safe_relative(const std::string& path) {
        if (path.empty() || path.front() == '/' || path.find_first_of("\\:*?\"<>|") != std::string::npos) return false;
        std::size_t start = 0;
        while (start < path.size()) {
            const auto end = (std::min)(path.find('/', start), path.size());
            const auto part = path.substr(start, end - start);
            if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ') return false;
            start = end + 1;
        }
        return path.back() != '/';
    }
    std::string lower(std::string value) {
        for (auto& c : value) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return value;
    }
    template<class S> S trim(S value) {
        const auto space = [](auto c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
        while (!value.empty() && space(value.back())) value.pop_back();
        std::size_t start = 0; while (start < value.size() && space(value[start])) ++start;
        return value.substr(start);
    }
    template<class S> S fold(S value) {
        // Configuration identifiers are ASCII; leave all user text untouched.
        for (auto& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
        return value;
    }
    template<class S> S merge_ini_text(S original, const S& defaults) {
        using C = typename S::value_type;
        struct key { S section, name, line; };
        std::set<std::pair<S,S>> present;
        std::map<S, std::size_t> sections;
        std::vector<key> additions;
        const auto scan = [&](const S& input, bool existing) {
            S section;
            for (std::size_t start = 0; start < input.size();) {
                const auto nl = input.find(static_cast<C>('\n'), start);
                const auto end = nl == S::npos ? input.size() : nl + 1;
                auto line = trim(input.substr(start, end - start));
                if (!line.empty() && line.front() == '[') {
                    const auto close = line.find(static_cast<C>(']'));
                    require(close != S::npos, "Invalid INI section; settings were kept.");
                    section = fold(trim(line.substr(1, close - 1)));
                    if (existing && !sections.contains(section)) sections[section] = end;
                } else if (!line.empty() && line.front() != ';' && line.front() != '#') {
                    const auto equal = line.find(static_cast<C>('='));
                    if (equal != S::npos) {
                        const auto name = fold(trim(line.substr(0, equal)));
                        require(!section.empty() && !name.empty(), "Invalid INI key; settings were kept.");
                        if (existing) present.emplace(section, name);
                        else if (present.emplace(section, name).second) additions.push_back({section, name, line});
                    }
                }
                start = end;
            }
        };
        scan(original, true); scan(defaults, false);
        std::map<std::size_t, S, std::greater<>> inserts;
        std::map<S, S> new_sections;
        for (const auto& key : additions) {
            S line = key.line; line.push_back('\n');
            if (const auto it = sections.find(key.section); it != sections.end()) inserts[it->second] += line;
            else {
                new_sections[key.section] += line;
            }
        }
        for (const auto& [name, lines] : new_sections) {
            S section; section.push_back('\n'); section.push_back('['); section += name;
            section.push_back(']'); section.push_back('\n'); section += lines;
            inserts[original.size()] += section;
        }
        for (const auto& [offset, bytes] : inserts) {
            S prefix;
            if (offset && original[offset - 1] != '\n') prefix.push_back('\n');
            original.insert(offset, prefix + bytes);
        }
        return original;
    }
    std::string merge_ini(const std::string& original, const std::string& defaults) {
        require(defaults.find('\0') == std::string::npos, "Invalid default INI encoding.");
        if (original.starts_with("\xff\xfe")) {
            require(original.size() % 2 == 0, "Invalid UTF-16 settings; settings were kept.");
            std::u16string old, fresh;
            for (std::size_t i = 2; i < original.size(); i += 2)
                old.push_back(static_cast<char16_t>(static_cast<unsigned char>(original[i]) | (static_cast<unsigned char>(original[i+1]) << 8)));
            for (const auto c : defaults) fresh.push_back(static_cast<unsigned char>(c));
            const auto merged = merge_ini_text(old, fresh);
            std::string out = "\xff\xfe";
            for (const auto c : merged) { out.push_back(static_cast<char>(c & 255)); out.push_back(static_cast<char>(c >> 8)); }
            return out;
        }
        require(original.find('\0') == std::string::npos, "Unsupported settings encoding; settings were kept.");
        const bool bom = original.starts_with("\xef\xbb\xbf");
        return (bom ? "\xef\xbb\xbf" : "") + merge_ini_text(bom ? original.substr(3) : original, defaults);
    }
    bool merge_json(rapidjson::Value& old, const rapidjson::Value& fresh, rapidjson::Document::AllocatorType& a) {
        bool changed = false;
        for (auto it = fresh.MemberBegin(); it != fresh.MemberEnd(); ++it) {
            const auto found = old.FindMember(it->name);
            if (found == old.MemberEnd()) {
                rapidjson::Value name, value; name.CopyFrom(it->name, a); value.CopyFrom(it->value, a);
                old.AddMember(name, value, a); changed = true;
            } else if (found->value.IsObject() && it->value.IsObject()) changed = merge_json(found->value, it->value, a) || changed;
        }
        return changed;
    }
    std::string merge_settings(const std::string& target, const std::string& old, const std::string& fresh) {
        if (target != "version.json") return merge_ini(old, fresh);
        auto original = document(old); const auto defaults = document(fresh);
        return merge_json(original, defaults, original.GetAllocator()) ? serialize(original) : old;
    }
    bool settings(const std::string& target) { return target == "version.json" || target == "muac-fix.ini" || target == "dgVoodoo.conf"; }
    void check(const controls& control) {
        require(!control.running(), "Close MUA 2006 before updating MUA Classic Fix.");
        require(!control.cancelled(), "MUA Classic Fix update cancelled. Existing files were kept.");
    }
    void remove_stage(const std::filesystem::path& game, const std::filesystem::path& stage) {
        std::error_code ec;
        require(muac_setup::cleanup::remove_stage(game, stage, ec), "Could not clean runtime staging: " + ec.message());
    }
    void restore(const std::filesystem::path& game, const std::filesystem::path& stage, const rapidjson::Value& journal) {
        std::error_code ec;
        require(muac_setup::cleanup::safe_stage(game, stage, ec), "Unsafe runtime recovery tree.");
        require(journal.HasMember("files") && journal["files"].IsArray(), "Invalid runtime recovery journal.");
        std::set<std::string> seen;
        for (const auto& item : journal["files"].GetArray()) {
            const auto target = text(item, "target");
            require(target_allowed(target) && seen.insert(target).second && item.HasMember("existed") && item["existed"].IsBool(),
                    "Unsafe runtime recovery journal.");
        }
        // Validate every destination before restoring any of them.
        for (const auto& item : journal["files"].GetArray()) guard(game / text(item, "target"));
        for (const auto& item : journal["files"].GetArray()) {
            const auto target = text(item, "target");
            const auto live = game / target, backup = stage / "old" / target, fresh = stage / "new" / target;
            guard(live); guard(backup); guard(fresh);
            if (std::filesystem::exists(backup)) {
                if (std::filesystem::exists(live)) require(std::filesystem::is_regular_file(live), "Recovery destination is not a file.");
                std::filesystem::remove(live);
                std::filesystem::rename(backup, live);
            } else if (!item["existed"].GetBool() && !std::filesystem::exists(fresh)) {
                if (std::filesystem::exists(live)) require(std::filesystem::is_regular_file(live), "Recovery destination is not a file.");
                std::filesystem::remove(live);
            }
        }
    }
}

void guard(const std::filesystem::path& path) {
    require(path.is_absolute() && path != path.root_path() && path.native().find(std::filesystem::path::value_type{}) == std::filesystem::path::string_type::npos,
            "Choose a full, safe game folder path.");
    for (const auto& part : path) {
        const auto& name = part.native();
        require(part != "." && part != ".." && (part == path.root_name() || name.find(static_cast<std::filesystem::path::value_type>(':')) == std::filesystem::path::string_type::npos), "Unsafe runtime path.");
    }
    std::error_code ec;
    for (auto part = path; !part.empty();) {
        require(!muac_setup::cleanup::linked(part, ec) && !ec, "Runtime updates refuse symbolic links and junctions.");
        const auto parent = part.parent_path(); if (parent == part) break; part = parent;
    }
}
std::string read_file(const std::filesystem::path& path, std::uint64_t maximum) {
    guard(path);
    require(std::filesystem::is_regular_file(path) && std::filesystem::file_size(path) <= maximum, "Missing or oversized runtime file.");
    std::ifstream input(path, std::ios::binary);
    std::string out(static_cast<std::size_t>(std::filesystem::file_size(path)), '\0');
    require(static_cast<bool>(input.read(out.data(), static_cast<std::streamsize>(out.size()))), "Could not read runtime file.");
    return out;
}
package parse_package(const std::string& json, const std::string& expected_version) {
    const auto data = document(json); package out;
    require(data.HasMember("schema") && data["schema"].IsInt() && data["schema"].GetInt() == 1, "Unsupported runtime package schema.");
    out.version = text(data, "version");
    require(release_channel::is_version(out.version) && out.version == expected_version, "The runtime package does not match the selected release.");
    require(data.HasMember("files") && data["files"].IsArray(), "Missing runtime file list.");
    std::set<std::string> seen, sources;
    std::uint64_t total = 0;
    for (const auto& item : data["files"].GetArray()) {
        file entry{text(item, "source"), text(item, "target"), size(item, "size"), checksum(item, "sha256")};
        require(safe_relative(entry.source) && (required.contains(entry.target) || optional.contains(entry.target)) &&
            seen.insert(entry.target).second && sources.insert(lower(entry.source)).second, "Unexpected or duplicate runtime path.");
        total += entry.size; require(total <= 256 * 1024 * 1024, "Runtime package is too large.");
        out.files.push_back(std::move(entry));
    }
    for (const auto& name : required) require(seen.contains(name), "Incomplete runtime package.");
    require(data.HasMember("dgvoodoo"), "Missing graphics dependency.");
    const auto& graphics = data["dgvoodoo"];
    out.graphics_url = text(graphics, "url"); out.graphics_sha256 = checksum(graphics, "sha256"); out.graphics_size = size(graphics, "size");
    out.dll_sha256 = checksum(graphics, "dll_sha256"); out.dll_size = size(graphics, "dll_size");
    require(out.graphics_url.starts_with("https://github.com/dege-diosg/dgVoodoo2/releases/download/") &&
        text(graphics, "member") == "MS/x86/D3D9.dll" && out.dll_size < 32 * 1024 * 1024, "Unsupported graphics dependency.");
    return out;
}
std::optional<std::string> record_version(const std::string& json, const std::string& dll_sha256) {
    try {
        const auto data = document(json);
        if (!data.HasMember("schema") || !data["schema"].IsInt() || data["schema"].GetInt() != 1 ||
            !data.HasMember("prepared") || !data["prepared"].IsBool() || !data["prepared"].GetBool()) return std::nullopt;
        auto version = text(data, "version");
        if (!dll_sha256.empty()) {
            const auto installed = lower(dll_sha256);
            if (!data.HasMember("files") || !data["files"].IsArray()) return std::nullopt;
            int matches = 0;
            for (const auto& item : data["files"].GetArray()) {
                if (text(item, "target") != "dinput8.dll") continue;
                if (++matches != 1 || checksum(item, "sha256") != installed) return std::nullopt;
            }
            if (matches != 1) return std::nullopt;
        }
        return release_channel::is_version(version) ? std::optional(version) : std::nullopt;
    } catch (const std::exception&) { return std::nullopt; }
}
bool newer_compatible(const std::string& installed, const std::string& latest, const std::string& minimum, const std::string& launcher) {
    return release_channel::is_version(latest) && (minimum.empty() || (release_channel::is_version(minimum) && release_channel::compare(launcher, minimum) >= 0)) &&
        (installed.empty() || release_channel::compare(latest, installed) > 0);
}
bool recovery_pending(const std::filesystem::path& game) {
    try {
        guard(game);
        std::error_code ec;
        if (!std::filesystem::exists(game, ec) && !ec) return false;
        for (const auto& entry : std::filesystem::directory_iterator(game)) {
            if (!entry.path().filename().native().starts_with(std::filesystem::path(".muac-stage-update-").native())) continue;
            const auto file = entry.path() / "journal.json";
            if (std::filesystem::exists(file) && text(document(read_file(file, 128 * 1024)), "state") != "committed") return true;
        }
        return false;
    } catch (const std::exception&) { return true; }
}
void recover(const std::filesystem::path& game) {
    guard(game);
    for (const auto& entry : std::filesystem::directory_iterator(game)) {
        if (!entry.path().filename().native().starts_with(std::filesystem::path(".muac-stage-update-").native())) continue;
        const auto stage = entry.path(); std::error_code ec;
        require(muac_setup::cleanup::safe_stage(game, stage, ec), "Unsafe runtime recovery folder.");
        const auto journal_file = stage / "journal.json";
        if (std::filesystem::exists(journal_file)) {
            const auto journal = document(read_file(journal_file, 128 * 1024));
            const auto state = text(journal, "state");
            require(state == "committing" || state == "committed", "Invalid runtime recovery state.");
            if (state == "committing") restore(game, stage, journal);
        }
        remove_stage(game, stage);
    }
}
void update(const std::filesystem::path& game, const std::filesystem::path& bundle, const package& manifest,
            const std::string& graphics_dll, const hash_function& raw_hash, const controls& control) {
    // Production SHA-256 is upper-case hex; package and runtime records are lower-case.
    const auto hash = [&raw_hash](const std::string& bytes) { return lower(raw_hash(bytes)); };
    check(control); guard(game); guard(bundle); recover(game);
    require(graphics_dll.size() == manifest.dll_size && hash(graphics_dll) == manifest.dll_sha256, "Graphics DLL failed SHA-256 verification.");
    static std::atomic_uint counter{};
    const auto stage = game / (".muac-stage-update-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" + std::to_string(++counter));
    require(std::filesystem::create_directory(stage), "Could not create runtime staging.");
    rapidjson::Document journal; journal.SetObject(); auto& a = journal.GetAllocator();
    journal.AddMember("state", "committing", a); rapidjson::Value list(rapidjson::kArrayType);
    bool committing = false;
    try {
        std::map<std::string, std::string> files;
        std::set<std::string> unchanged_settings;
        for (const auto& item : manifest.files) {
            check(control);
            require((required.contains(item.target) || optional.contains(item.target)) && safe_relative(item.source) && !files.contains(item.target), "Unsafe runtime file list.");
            auto bytes = read_file(bundle / item.source);
            require(bytes.size() == item.size && hash(bytes) == item.sha256, "Runtime file failed SHA-256 verification: " + item.target);
            guard(game / item.target);
            if (settings(item.target) && std::filesystem::exists(game / item.target)) {
                const auto original = read_file(game / item.target, 128 * 1024);
                bytes = merge_settings(item.target, original, bytes);
                if (bytes == original) unchanged_settings.insert(item.target);
            }
            files.emplace(item.target, std::move(bytes));
        }
        for (const auto& name : required) require(files.contains(name), "Incomplete runtime package.");
        files.emplace("D3D9.dll", graphics_dll);
        rapidjson::Document record; record.SetObject(); auto& r = record.GetAllocator();
        record.AddMember("schema", 1, r); record.AddMember("prepared", true, r);
        record.AddMember("version", rapidjson::Value(manifest.version.c_str(), r), r);
        rapidjson::Value recorded(rapidjson::kArrayType);
        for (const auto& [target, bytes] : files) {
            rapidjson::Value item(rapidjson::kObjectType);
            item.AddMember("target", rapidjson::Value(target.c_str(), r), r);
            item.AddMember("size", static_cast<std::uint64_t>(bytes.size()), r);
            item.AddMember("sha256", rapidjson::Value(hash(bytes).c_str(), r), r); recorded.PushBack(item, r);
        }
        record.AddMember("files", recorded, r); files.emplace("_muac/runtime.json", serialize(record));
        // Metadata is last: until every file is promoted, the old version remains recorded.
        std::vector<std::string> order;
        for (const auto& [target, bytes] : files)
            if (target != "_muac/runtime.json" && !unchanged_settings.contains(target)) order.push_back(target);
        order.push_back("_muac/runtime.json");
        for (const auto& target : order) {
            const auto live = game / target; guard(live);
            const bool existed = std::filesystem::exists(live);
            require(!existed || std::filesystem::is_regular_file(live), "Runtime destination is not a regular file.");
            write_file(stage / "new" / target, files.at(target));
            rapidjson::Value item(rapidjson::kObjectType);
            item.AddMember("target", rapidjson::Value(target.c_str(), a), a); item.AddMember("existed", existed, a); list.PushBack(item, a);
        }
        journal.AddMember("files", list, a); write_file(stage / "journal.json", serialize(journal));
        check(control); committing = true;
        for (const auto& item : journal["files"].GetArray()) {
            check(control); const auto target = text(item, "target");
            if (control.before_replace) control.before_replace(target);
            const auto live = game / target, backup = stage / "old" / target;
            guard(live); guard(backup); guard(stage / "new" / target);
            std::filesystem::create_directories(live.parent_path()); std::filesystem::create_directories(backup.parent_path());
            if (item["existed"].GetBool()) std::filesystem::rename(live, backup);
            std::filesystem::rename(stage / "new" / target, live);
        }
        check(control);
        journal["state"].SetString("committed", a);
        write_file(stage / "journal.next", serialize(journal));
        // Keep the original journal until a complete replacement is ready.
#ifdef _WIN32
        require(MoveFileExW((stage / "journal.next").c_str(), (stage / "journal.json").c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE,
                "Could not finish runtime transaction.");
#else
        std::filesystem::rename(stage / "journal.next", stage / "journal.json");
#endif
    } catch (const std::exception& error) {
        const std::string reason = error.what();
        try { if (committing) restore(game, stage, journal); remove_stage(game, stage); }
        catch (const std::exception& rollback) { throw std::runtime_error(reason + " Recovery is pending; retry Update before playing. " + rollback.what()); }
        throw std::runtime_error(reason);
    }
    // Once committed, cleanup failure must not turn success into an attempted rollback.
    std::error_code ignored; muac_setup::cleanup::remove_stage(game, stage, ignored);
}
}
