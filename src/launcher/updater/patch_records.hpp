#pragma once

#include "release_channel.hpp"
#include <rapidjson/document.h>
#include <optional>
#include <string>

namespace patch_records
{
    inline std::string text(const rapidjson::Value& object, const char* key)
    {
        const auto member = object.FindMember(key);
        return member != object.MemberEnd() && member->value.IsString()
            ? std::string(member->value.GetString(), member->value.GetStringLength()) : std::string{};
    }

    // Keys are canonical folder paths supplied by client_store. Keep the legacy root record
    // until its own folder is forgotten; writing another folder must never replace it.
    inline std::optional<release_channel::patch_record> read(const rapidjson::Value& doc,
                                                            const std::string& key, const bool legacy_matches)
    {
        if (!doc.IsObject()) return std::nullopt;
        const auto folders = doc.FindMember("folders");
        if (folders != doc.MemberEnd() && folders->value.IsObject())
        {
            const auto found = folders->value.FindMember(key.c_str());
            if (found != folders->value.MemberEnd() && found->value.IsObject())
                return release_channel::patch_record{text(found->value, "version"), text(found->value, "sha1")};
        }
        if (legacy_matches) return release_channel::patch_record{text(doc, "version"), text(doc, "sha1")};
        return std::nullopt;
    }

    inline void write(rapidjson::Document& doc, const std::string& key, const release_channel::patch_record& record)
    {
        if (!doc.IsObject()) doc.SetObject();
        auto& allocator = doc.GetAllocator();
        if (!doc.HasMember("folders")) doc.AddMember("folders", rapidjson::Value(rapidjson::kObjectType), allocator);
        auto& folders = doc["folders"];
        if (!folders.IsObject()) folders.SetObject();
        rapidjson::Value value(rapidjson::kObjectType);
        value.AddMember("version", rapidjson::Value(record.version.c_str(), allocator), allocator);
        value.AddMember("sha1", rapidjson::Value(record.sha1.c_str(), allocator), allocator);
        folders.RemoveMember(key.c_str());
        folders.AddMember(rapidjson::Value(key.c_str(), allocator), value, allocator);
    }

    inline void preserve_legacy(rapidjson::Document& doc, const std::string& legacy_key)
    {
        if (!doc.IsObject() || legacy_key.empty()) return;
        // A newer folder entry is authoritative over an older root mirror.
        if (read(doc, legacy_key, false)) return;
        write(doc, legacy_key, {text(doc, "version"), text(doc, "sha1")});
    }

    // Keep the active installation readable by older launchers after Switch back. A prep
    // for a different, not-yet-admitted folder must not move this backward-compatible mirror.
    inline void mirror_active(rapidjson::Document& doc, const std::string& install,
                              const release_channel::patch_record& record)
    {
        auto& allocator = doc.GetAllocator();
        const auto set = [&](const char* key, const std::string& value)
        {
            doc.RemoveMember(key);
            doc.AddMember(rapidjson::Value(key, allocator), rapidjson::Value(value.c_str(), allocator), allocator);
        };
        set("install", install);
        set("version", record.version);
        set("sha1", record.sha1);
    }

    inline void forget(rapidjson::Document& doc, const std::string& key, const bool legacy_matches)
    {
        if (!doc.IsObject()) return;
        if (doc.HasMember("folders") && doc["folders"].IsObject()) doc["folders"].RemoveMember(key.c_str());
        if (legacy_matches)
        {
            doc.RemoveMember("install");
            doc.RemoveMember("version");
            doc.RemoveMember("sha1");
        }
    }
}
