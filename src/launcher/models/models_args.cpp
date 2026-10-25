#include "std_include.hpp"
#include "models_args.hpp"

#include <rapidjson/writer.h>

#include <array>

namespace models_args
{
    namespace
    {
        constexpr std::array<std::pair<const char*, const char*>, 4> modes{{
            {"community", "Models-Community"},
            {"upgraded", "Models-Upgraded"},
            {"xml2", "Models-XML2-Look"},
            {"sharpen", "Models-Sharpened"},
        }};

        constexpr std::array<const char*, 5> tiers{"mua2", "mua1", "xml2", "community", "sharpen"};

        bool ascii_alnum(const char c)
        {
            return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
        }

        bool valid_costume_id(const std::string& id)
        {
            if (id.empty() || id.size() > 48 || id.front() == ' ' || id.back() == ' ' || id.front() == '-')
            {
                return false;
            }
            return std::ranges::all_of(id, [](const char c)
            {
                return ascii_alnum(c) || c == ' ' || c == '-' || c == '_' || c == '.' || c == '(' || c == ')' || c == '\'' || c == '&';
            });
        }

        std::string member_string(const rapidjson::Value& object, const char* key)
        {
            if (!object.IsObject())
            {
                return {};
            }
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }
    }

    bool valid_mode(const std::string& mode)
    {
        return std::ranges::any_of(modes, [&](const auto& entry) { return mode == entry.first; });
    }

    std::string pack_for_mode(const std::string& mode)
    {
        for (const auto& [name, pack] : modes)
        {
            if (mode == name)
            {
                return pack;
            }
        }
        return {};
    }

    bool valid_hero(const std::string& hero)
    {
        return !hero.empty() && hero.size() <= 32 && std::ranges::all_of(hero, [](const char c)
        {
            return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
        });
    }

    bool valid_tier(const std::string& tier)
    {
        return std::ranges::any_of(tiers, [&](const char* name) { return tier == name; });
    }

    bool valid_costume(const std::string& costume)
    {
        const auto colon = costume.find(':');
        if (colon == std::string::npos)
        {
            return valid_costume_id(costume);
        }
        return valid_tier(costume.substr(0, colon)) && valid_costume_id(costume.substr(colon + 1));
    }

    bool valid_pack(const std::string& pack)
    {
        if (pack.empty() || pack.size() > 64 || pack.front() == '.' || pack.front() == '-')
        {
            return false;
        }
        return std::ranges::all_of(pack, [](const char c) { return ascii_alnum(c) || c == '-' || c == '_' || c == '.'; });
    }

    bool valid_mirror(const std::string& mirror)
    {
        if (mirror.empty())
        {
            return true;
        }
        constexpr std::string_view scheme = "https://";
        if (mirror.size() > 512 || mirror.size() <= scheme.size() || !mirror.starts_with(scheme))
        {
            return false;
        }
        // The host: at least one character before any path.
        if (mirror[scheme.size()] == '/' )
        {
            return false;
        }
        return std::ranges::none_of(mirror, [](const char c)
        {
            const auto u = static_cast<unsigned char>(c);
            return u <= 0x20 || u == 0x7f || c == '"' || c == '\'' || c == '<' || c == '>' || c == '\\' || c == '`' || c == '^' ||
                   c == '{' || c == '}' || c == '|';
        });
    }

    std::optional<std::vector<std::string>> build_args(const request& request, std::string& error)
    {
        const auto& command = request.command;
        if (command != "scan" && command != "plan" && command != "build" && command != "verify" && command != "remove")
        {
            error = "Unknown command.";
            return std::nullopt;
        }
        if (request.port.empty())
        {
            error = "No Legends Classic folder.";
            return std::nullopt;
        }
        if (request.work.empty())
        {
            error = "No work folder.";
            return std::nullopt;
        }

        std::vector<std::string> args{command, "--json", "--port", request.port, "--work", request.work};
        if (!request.mua1.empty())
        {
            args.insert(args.end(), {"--mua1", request.mua1});
        }
        if (!request.mua2.empty())
        {
            args.insert(args.end(), {"--mua2", request.mua2});
        }

        if (command == "plan" || command == "build")
        {
            if (!valid_mode(request.mode))
            {
                error = "Unknown appearance mode.";
                return std::nullopt;
            }
            args.insert(args.end(), {"--mode", request.mode});
            for (const auto& [hero, costume] : request.costumes)
            {
                if (!valid_hero(hero) || !valid_costume(costume))
                {
                    error = "A costume choice is not valid: " + hero;
                    return std::nullopt;
                }
                args.insert(args.end(), {"--costume", hero + "=" + costume});
            }
            if (request.offline)
            {
                args.emplace_back("--offline");
            }
        }

        if (command == "build")
        {
            for (const auto& hero : request.heroes)
            {
                if (!valid_hero(hero))
                {
                    error = "Unknown hero: " + hero;
                    return std::nullopt;
                }
                args.insert(args.end(), {"--hero", hero});
            }
            if (!request.pack.empty())
            {
                if (!valid_pack(request.pack))
                {
                    error = "The pack name is not valid.";
                    return std::nullopt;
                }
                args.insert(args.end(), {"--pack", request.pack});
            }
            if (!request.mirror.empty())
            {
                if (!valid_mirror(request.mirror))
                {
                    error = "The mirror must be an https:// address.";
                    return std::nullopt;
                }
                args.insert(args.end(), {"--mirror", request.mirror});
            }
            if (request.rebuild)
            {
                args.emplace_back("--rebuild");
            }
        }

        if (command == "verify" || command == "remove")
        {
            if (!valid_pack(request.pack))
            {
                error = "No pack to " + command + ".";
                return std::nullopt;
            }
            args.insert(args.end(), {"--pack", request.pack});
        }
        return args;
    }

    std::map<std::string, std::string> parse_costumes(const std::string& json)
    {
        std::map<std::string, std::string> costumes;
        if (json.empty())
        {
            return costumes;
        }
        rapidjson::Document document;
        document.Parse(json.data(), json.size());
        if (document.HasParseError() || !document.IsObject())
        {
            return costumes;
        }
        for (auto member = document.MemberBegin(); member != document.MemberEnd(); ++member)
        {
            if (!member->name.IsString() || !member->value.IsString())
            {
                continue;
            }
            std::string hero = member->name.GetString();
            std::string costume = member->value.GetString();
            if (valid_hero(hero) && valid_costume(costume))
            {
                costumes[std::move(hero)] = std::move(costume);
            }
        }
        return costumes;
    }

    std::string costumes_json(const std::map<std::string, std::string>& costumes)
    {
        rapidjson::StringBuffer buffer;
        rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
        writer.StartObject();
        for (const auto& [hero, costume] : costumes)
        {
            writer.Key(hero.data(), static_cast<rapidjson::SizeType>(hero.size()));
            writer.String(costume.data(), static_cast<rapidjson::SizeType>(costume.size()));
        }
        writer.EndObject();
        return {buffer.GetString(), buffer.GetSize()};
    }

    std::optional<marker> parse_marker(const std::string& json)
    {
        rapidjson::Document document;
        document.Parse(json.data(), json.size());
        if (document.HasParseError() || !document.IsObject() || member_string(document, "generator") != "legends-models")
        {
            return std::nullopt;
        }

        marker result{};
        result.pack = member_string(document, "pack");
        result.group = member_string(document, "group");
        if (result.group.empty())
        {
            result.group = result.pack;
        }
        result.mode = member_string(document, "mode");
        result.version = member_string(document, "version");

        const auto characters = document.FindMember("characters");
        if (characters != document.MemberEnd() && characters->value.IsObject())
        {
            for (auto entry = characters->value.MemberBegin(); entry != characters->value.MemberEnd(); ++entry)
            {
                if (!entry->name.IsString() || !entry->value.IsObject())
                {
                    continue;
                }
                marker_character character{};
                character.hero = entry->name.GetString();
                character.tier = member_string(entry->value, "tier");
                character.source = member_string(entry->value, "source");
                result.characters.push_back(std::move(character));
            }
        }
        return result;
    }

    std::string exit_name(const int code)
    {
        switch (code)
        {
        case 0: return "ok";
        case 10: return "partial";
        case 11: return "nothing";
        case 3: return "missing_input";
        case 20: return "download";
        case 30: return "verify_mismatch";
        case 31: return "stale";
        case 40: return "unsafe";
        case 2: return "usage";
        case 1: return "bug";
        case 130: return "cancelled";
        default: return "unknown";
        }
    }
}
