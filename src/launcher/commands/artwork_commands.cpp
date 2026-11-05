#include "std_include.hpp"
#include "artwork_commands.hpp"
#include "artwork/store.hpp"
#include "cef/cef_ui.hpp"
#include <utils/com.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>
#include "artwork/decode.hpp"
#include <chrono>
#include <thread>

namespace commands::artwork_commands {
    namespace {
        std::mutex mutex;
        struct candidate { std::string game, kind, record, bytes; };
        std::optional<candidate> pending;
        std::string member(const rapidjson::Value& value, const char* key) {
            if (!value.IsObject() || !value.HasMember(key) || !value[key].IsString()) return {};
            return {value[key].GetString(), value[key].GetStringLength()};
        }
        std::string property(const std::string& kind) { return "artwork-" + kind; }
        std::string url(const std::string& game, const std::string& kind, const std::string& record) {
            return "/custom-art/" + game + "/" + kind + "/" + record;
        }
        void describe(const std::string& game, rapidjson::Document& response) {
            response.SetObject();
            const auto config = game_config::get_game_config(game);
            if (!config) return;
            const auto root = utils::properties::get_appdata_path();
            for (const auto kind : {"capsule", "hero", "icon"}) {
                const auto record = config->get(property(kind)).value_or("");
                if (record.empty()) continue;
                const auto path = artwork::managed_path(root, game, kind, record);
                auto bytes = path ? artwork::read_image(*path) : std::nullopt;
                if (!bytes || !artwork::decodes(*bytes)) { config->set(property(kind), ""); continue; }
                rapidjson::Value value;
                value.SetString(url(game, kind, record), response.GetAllocator());
                response.AddMember(rapidjson::StringRef(kind), value, response.GetAllocator());
            }
        }
    }
    std::optional<std::pair<std::string, std::string>> resource(const std::string& path) {
        std::lock_guard lock(mutex);
        if (!path.starts_with("/custom-art/")) return {};
        const auto rest = path.substr(12);
        const auto slash = rest.find('/');
        if (slash == std::string::npos) return {};
        const auto game = rest.substr(0, slash);
        const auto second = rest.find('/', slash + 1);
        if (second == std::string::npos) return {};
        const auto kind = rest.substr(slash + 1, second - slash - 1);
        const auto record = rest.substr(second + 1);
        const auto file = artwork::managed_path(utils::properties::get_appdata_path(), game, kind, record);
        if (!file) return {};
        std::optional<std::string> bytes;
        if (pending && pending->game == game && pending->kind == kind && pending->record == record) bytes = pending->bytes;
        else {
            const auto config = game_config::get_game_config(game);
            if (!config || config->get(property(kind)).value_or("") != record) return {};
            bytes = artwork::read_image(*file);
        }
        if (!bytes) return {};
        const auto type = artwork::image_type(*bytes);
        return std::pair{std::move(*bytes), type == "jpg" ? "image/jpeg" : "image/" + type};
    }
    void register_commands(cef::cef_ui& ui, command_context&) {
        ui.add_command("get-artwork", [](const rapidjson::Value& value, rapidjson::Document& response) {
            std::lock_guard lock(mutex);
            describe(member(value, "game"), response);
        });
        ui.add_command("pick-artwork", [](const rapidjson::Value& value, rapidjson::Document& response) {
            std::lock_guard lock(mutex);
            response.SetObject();
            const auto game = member(value, "game"), kind = member(value, "kind");
            if (!artwork::game_id(game) || !artwork::kind_id(kind)) return;
            pending.reset();
            try {
                std::string selected;
                bool accepted = false, failed = false;
                const auto title = member(value, "title");
                // CEF's command thread need not be a COM STA. Give the native dialog its
                // own apartment, and keep the selected path entirely in the backend.
                std::thread picker([&] {
                    const auto init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
                    if (FAILED(init)) { failed = true; return; }
                    try { accepted = utils::com::select_file(selected, title, {{"PNG / JPEG / WebP", "*.png;*.jpg;*.jpeg;*.webp"}}); }
                    catch (...) { failed = true; }
                    CoUninitialize();
                });
                picker.join();
                if (failed) { response.AddMember("error", true, response.GetAllocator()); return; }
                if (!accepted) return;
                auto bytes = artwork::read_image(utils::string::utf8_to_path(selected));
                if (!bytes || (artwork::image_type(*bytes) != "webp" && !artwork::decodes(*bytes))) {
                    response.AddMember("error", true, response.GetAllocator()); return;
                }
                static uint64_t serial = 0;
                const auto record = std::format("{:x}{:x}.{}", static_cast<uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()), ++serial, artwork::image_type(*bytes));
                pending = candidate{game, kind, record, std::move(*bytes)};
                response.AddMember("preview", rapidjson::Value(url(game, kind, record), response.GetAllocator()), response.GetAllocator());
                response.AddMember("record", rapidjson::Value(record, response.GetAllocator()), response.GetAllocator());
                response.AddMember("convert", artwork::image_type(pending->bytes) == "webp", response.GetAllocator());
            } catch (...) { response.AddMember("error", true, response.GetAllocator()); }
        });
        ui.add_command("confirm-artwork", [](const rapidjson::Value& value, rapidjson::Document& response) {
            std::lock_guard lock(mutex);
            response.SetBool(false);
            if (!pending || pending->game != member(value, "game") || pending->kind != member(value, "kind") || pending->record != member(value, "record")) return;
            auto chosen = std::move(*pending); pending.reset();
            if (value.HasMember("cancel") && value["cancel"].IsBool() && value["cancel"].GetBool()) { response.SetBool(true); return; }
            if (artwork::image_type(chosen.bytes) == "webp") {
                // Chromium decodes WebP on Windows and Proton without an optional WIC codec.
                // Its canvas supplies PNG; validate and decode those exact bytes before storing.
                const auto png = member(value, "png");
                if (png.size() > (artwork::max_bytes * 4 / 3 + 4)) return;
                const auto decoded = CefBase64Decode(png);
                if (!decoded || decoded->GetSize() > artwork::max_bytes) return;
                chosen.bytes.resize(decoded->GetSize());
                if (decoded->GetData(chosen.bytes.data(), chosen.bytes.size(), 0) != chosen.bytes.size()) return;
                if (artwork::image_type(chosen.bytes) != "png" || !artwork::decodes(chosen.bytes)) return;
                chosen.record = chosen.record.substr(0, chosen.record.find('.')) + ".png";
            }
            const auto root = utils::properties::get_appdata_path();
            if (!artwork::write_image(root, chosen.game, chosen.kind, chosen.record, chosen.bytes)) return;
            try {
                const auto config = game_config::get_game_config(chosen.game);
                const auto previous = config->get(property(chosen.kind)).value_or("");
                config->set(property(chosen.kind), chosen.record);
                if (config->get(property(chosen.kind)).value_or("") != chosen.record) {
                    artwork::remove_image(root, chosen.game, chosen.kind, chosen.record); return;
                }
                if (!previous.empty()) artwork::remove_image(root, chosen.game, chosen.kind, previous);
                response.SetBool(true);
            } catch (...) { artwork::remove_image(root, chosen.game, chosen.kind, chosen.record); }
        });
        ui.add_command("reset-artwork", [](const rapidjson::Value& value, rapidjson::Document& response) {
            std::lock_guard lock(mutex);
            response.SetBool(false);
            const auto game = member(value, "game");
            const auto config = game_config::get_game_config(game);
            if (!config) return;
            const auto requested = member(value, "kind");
            const auto expected = member(value, "record");
            bool cleared = true;
            for (const auto kind : {"capsule", "hero", "icon"}) {
                if (!requested.empty() && requested != kind) continue;
                const auto previous = config->get(property(kind)).value_or("");
                if (!expected.empty() && previous != expected) continue;
                config->set(property(kind), "");
                if (!config->get(property(kind)).value_or("").empty()) { cleared = false; continue; }
                if (!previous.empty()) artwork::remove_image(utils::properties::get_appdata_path(), game, kind, previous);
            }
            // A stale image error may arrive while a replacement is being previewed.
            if (pending && pending->game == game && requested.empty()) pending.reset();
            response.SetBool(cleared);
        });
    }
}
