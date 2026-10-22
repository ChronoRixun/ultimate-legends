#include "std_include.hpp"
#include "online_commands.hpp"
#include "cef/cef_ui.hpp"
#include "fix/fix_ini.hpp"
#include "fix/online_launch.hpp"
#include "fix/online_settings.hpp"
#include "fix/online_status.hpp"
#include "online/public_rooms.hpp"
#include "updater/patch_channel.hpp"
#include "updater/release_source.hpp"
#include "xml1/xml1_port.hpp"

#include <utils/flags.hpp>
#include <utils/string.hpp>

namespace commands::online_commands
{
    namespace
    {
        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        bool supported(const fix_ini::location& where)
        {
            return where.info && where.info->online;
        }

        // Host / JoinCode as the file has them, null when absent.
        rapidjson::Value values_json(const std::map<std::string, std::string>& values, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value object(rapidjson::kObjectType);
            for (const auto& key : online_rules::keys())
            {
                rapidjson::Value name = make_string(key, allocator);
                const auto it = values.find(key);
                if (it == values.end())
                {
                    object.AddMember(name, rapidjson::Value(rapidjson::kNullType), allocator);
                }
                else
                {
                    object.AddMember(name, make_string(it->second, allocator), allocator);
                }
            }
            return object;
        }

        bool playable(const fix_ini::location& where)
        {
            return where.game_dir && xml1_port::is_playable(*where.game_dir);
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { supported, installed, fixInstalled, fixVersion, fixState, requiredFix, playable, buildOnline, running, testMode,
        //   offline, fix, file, ini, values: { Host, Public, RoomName, JoinCode },
        //   status: <online-status.json's object> | null, statusUnreadable }.
        // fixVersion: the XML2 Fix DLL's file version ("" when it has none that reads, null without the DLL);
        // fixState: ok | old | unknown | missing against requiredFix (online_launch::required_fix, the one number
        // the page shows; launch-game checks the DLL again right before an online start's process).
        // updateChannel: stable | beta (Settings > Update channel; on Stable a fix too old points to Beta).
        // The Online section polls it (about every 500 ms) while the game it started runs. Host and Join start
        // with launch-game { online: { mode, code, public, roomName } } (game_commands.cpp).
        cef_ui.add_command("get-online-status", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto config = ctx.get_game_config_from_request(value);
            const auto where = fix_ini::locate(config);
            const auto is_supported = supported(where);
            const auto installed = is_supported && where.game_dir.has_value();
            const auto fix_installed = installed && where.fix_installed;

            response.AddMember("supported", is_supported, allocator);
            response.AddMember("installed", installed, allocator);
            response.AddMember("fixInstalled", fix_installed, allocator);
            std::optional<std::string> fix_version;
            if (installed)
            {
                fix_version = patch_channel::installed_version(*config, *where.game_dir);
            }
            response.AddMember("fixVersion", fix_version ? make_string(*fix_version, allocator) : rapidjson::Value(rapidjson::kNullType), allocator);
            response.AddMember("fixState", rapidjson::StringRef(online_launch::fix_state_name(online_launch::check_fix(fix_version))), allocator);
            response.AddMember("requiredFix", make_string(std::string(online_launch::required_fix), allocator), allocator);
            // Stable has no XML2 Fix with rooms until Legends Classic 0.3.0 is final: the page points there to Beta.
            response.AddMember("updateChannel", rapidjson::StringRef(release_channel::channel_name(release_source::current_channel())), allocator);
            response.AddMember("offline", utils::flags::has_flag("offline"), allocator);
            const auto is_playable = installed && playable(where);
            response.AddMember("playable", is_playable, allocator);
            // The build was made for online play (online_launch::build_supports_online): false asks for a
            // rebuild (a build from an older builder has no rooms, whatever the XML2 Fix).
            response.AddMember("buildOnline", is_playable && online_launch::build_supports_online(
                xml1_port::stamp_requires_xml2fix(*where.game_dir),
                online_settings::target(where.fix_installed ? where.ini() : std::nullopt, where.info).version_token), allocator);
            response.AddMember("running", is_supported && game_config::is_game_process_running(config->id, 1000), allocator);
            if (is_supported)
            {
                response.AddMember("fix", make_string(where.info->name, allocator), allocator);
                response.AddMember("file", make_string(utils::string::convert(where.info->ini), allocator), allocator);
            }

            std::map<std::string, std::string> values;
            auto test_mode = false;
            if (fix_installed)
            {
                const auto ini = *where.ini();
                response.AddMember("ini", make_string(utils::string::path_to_utf8(ini), allocator), allocator);
                values = online_settings::read(ini, *where.info);
                test_mode = online_settings::test_mode_on(ini, *where.info);
            }
            response.AddMember("testMode", test_mode, allocator);
            response.AddMember("values", values_json(values, allocator), allocator);

            // The fix writes the file atomically, so a file that doesn't parse as one object is not one
            // of its states: the page keeps what it showed.
            auto unreadable = false;
            rapidjson::Value status(rapidjson::kNullType);
            if (installed)
            {
                if (const auto text = online_status::read(*where.game_dir))
                {
                    rapidjson::Document parsed;
                    parsed.Parse(text->data(), text->size());
                    if (!parsed.HasParseError() && parsed.IsObject())
                    {
                        status.CopyFrom(parsed, allocator);
                    }
                    else
                    {
                        unreadable = true;
                    }
                }
            }
            response.AddMember("status", status, allocator);
            response.AddMember("statusUnreadable", unreadable, allocator);
        });

        // { game, refresh }: the public game browser (contract v1.3). With refresh, a fetch of the broker's
        // room list starts on a worker (unless one runs, or the launcher is in offline mode: then nothing is
        // fetched at all); the page polls without it until `fetching` is false.
        // Answers { supported, offline, fetching, host, versionToken, result: { ok, error, status, rooms, ts, age } | null }:
        // `rooms` as the broker sent them (at most 50; the page checks each), `age` ms since that fetch ended,
        // `versionToken` the port's [Online] GameVersion ("" when the ini has none).
        cef_ui.add_command("get-public-rooms", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto where = fix_ini::locate(ctx.get_game_config_from_request(value));
            const auto is_supported = supported(where);
            response.AddMember("supported", is_supported, allocator);
            if (!is_supported)
            {
                return;
            }

            const auto target = online_settings::target(where.fix_installed ? where.ini() : std::nullopt, where.info);
            const auto offline = utils::flags::has_flag("offline");
            response.AddMember("offline", offline, allocator);
            if (!offline && value.HasMember("refresh") && value["refresh"].IsBool() && value["refresh"].GetBool())
            {
                public_rooms::refresh(target.host, target.pin);
            }
            const auto snapshot = public_rooms::current();
            response.AddMember("fetching", snapshot.fetching, allocator);
            response.AddMember("host", make_string(target.host, allocator), allocator);
            response.AddMember("versionToken", make_string(target.version_token, allocator), allocator);

            if (!snapshot.last)
            {
                response.AddMember("result", rapidjson::Value(rapidjson::kNullType), allocator);
                return;
            }

            const auto& last = *snapshot.last;
            rapidjson::Value result(rapidjson::kObjectType);
            std::string error = last.error;
            rapidjson::Value rooms(rapidjson::kArrayType);
            std::int64_t ts = 0;
            if (last.ok)
            {
                rapidjson::Document parsed;
                parsed.Parse(last.body.data(), last.body.size());
                // (MemberEnd() on anything but an object throws: rapidjson_config.hpp.)
                const auto object = !parsed.HasParseError() && parsed.IsObject();
                const auto list = object ? parsed.FindMember("rooms") : rapidjson::Document::MemberIterator{};
                if (!object || list == parsed.MemberEnd() || !list->value.IsArray())
                {
                    error = "bad_response";
                }
                else
                {
                    for (auto& room : list->value.GetArray())
                    {
                        if (rooms.Size() >= 50)
                        {
                            break;
                        }
                        if (room.IsObject())
                        {
                            rapidjson::Value copy;
                            copy.CopyFrom(room, allocator);
                            rooms.PushBack(copy, allocator);
                        }
                    }
                    const auto stamp = parsed.FindMember("ts");
                    if (stamp != parsed.MemberEnd() && stamp->value.IsInt64())
                    {
                        ts = stamp->value.GetInt64();
                    }
                }
            }
            const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now() - snapshot.at).count();
            result.AddMember("ok", error.empty(), allocator);
            result.AddMember("error", error.empty() ? rapidjson::Value(rapidjson::kNullType) : make_string(error, allocator), allocator);
            result.AddMember("status", static_cast<std::uint64_t>(last.status), allocator);
            result.AddMember("rooms", rooms, allocator);
            result.AddMember("ts", ts, allocator);
            result.AddMember("age", static_cast<std::int64_t>(age), allocator);
            response.AddMember("result", result, allocator);
        });
    }
}
