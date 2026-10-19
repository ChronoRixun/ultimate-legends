#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

// Online play of the X-Men Legends port (Legends Classic 0.3.0, the XML2 Fix's broker rooms): what the
// launcher writes into the [Online] section of the port's xml2-fix.ini for the next game start. The
// launcher <-> XML2 Fix contract (v1.4) is binding:
//
//   [Online]
//   Host = broker          ; this PC hosts a room through the broker at the next game start
//   Public = 1 | 0         ; with Host: list the room in the public game browser (default 0, code only)
//   RoomName = <text>      ; with Host: its name in the browser (empty: the fix makes "<name>'s game")
//   JoinCode = XXXXXXXX    ; this PC joins that room at the next game start (wins over Host)
//   Broker = host[:port]   ; the builder's defaults: the launcher never writes or removes them
//   BrokerPin = <64 hex>
//   GameVersion = <token>  ; the build's version token (the browser greys out other builds); read only
//   Route = relay          ; testers only: never written either
//
// The launcher writes Host (with Public and RoomName) or JoinCode, always removes the others, and removes
// all four for a normal (offline / LAN) start, so a later normal start never opens a room. Only those
// four keys: anything else is refused. A code is 8 characters of an alphabet without 0 O 1 I L; the
// player may type it in lower case, with spaces or dashes (it is shown as XXXX-XXXX).
//
// The public room list comes from the broker over HTTPS (GET https://<Broker's host>:10021/v1/rooms),
// its self-signed certificate checked against BrokerPin (the SHA-256 of its SubjectPublicKeyInfo): the
// pin is the trust anchor.
//
// This part looks only at text (no ini, no Windows), so the unit tests (src/tests) build it on their
// own; fix/online_settings.hpp reads and writes the file, online/public_rooms.hpp fetches the list.
namespace online_rules
{
    constexpr std::string_view code_alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    constexpr std::size_t code_length = 8;
    constexpr std::string_view host_value = "broker";
    constexpr std::size_t room_name_length = 32;

    // The project broker, for an ini without Broker / BrokerPin: its host and the SPKI SHA-256 pin of its
    // self-signed certificate. The room list is on its own port and path.
    constexpr std::string_view default_broker_host = "broker.aethyrion.org";
    constexpr std::string_view default_broker_pin = "ac569104f671775703f3e36a8109519f4e219fb1e8bc68aaa77793cfb3dbad09";
    constexpr unsigned short rooms_port = 10021;
    constexpr std::string_view rooms_path = "/v1/rooms";

    // The [Online] keys the launcher writes, in that order. Broker, BrokerPin, GameVersion and Route are
    // not among them.
    const std::vector<std::string>& keys();
    bool known(const std::string& key);

    // `text` upper-cased, without spaces or dashes, when that is 8 characters of the alphabet; else nullopt.
    std::optional<std::string> normalise_code(std::string_view text);

    // "ABCD2345" -> "ABCD-2345" (anything else is returned as it is).
    std::string display_code(const std::string& code);

    // What the next game start is: a normal one (no room), hosting a room, or joining one.
    enum class mode
    {
        normal,
        host,
        join,
    };

    // "normal" / "host" / "join".
    std::optional<mode> parse_mode(std::string_view text);

    // A room name as the launcher writes it: trimmed, at most 32 characters of printable ASCII, without
    // ';' (it starts a comment in the ini) or '"' (the profile API drops quotes around a value). "" is
    // no name (the fix's default); nullopt when it can't be written.
    std::optional<std::string> normalise_room_name(std::string_view text);

    // What a host start asks for besides Host=broker.
    struct host_options
    {
        bool is_public{};
        std::string room_name{}; // normalised; only written for a public room
    };

    struct change
    {
        std::string key;
        std::optional<std::string> value; // nullopt removes the key
    };

    // The writes for a start in `mode` (`code` normalised, for join; `options` for host), given which of
    // keys() the section has now (`present`): host writes Host=broker, Public=1|0 and the RoomName of a
    // public room and removes JoinCode (and a RoomName it doesn't write); join writes JoinCode and removes
    // Host, Public and RoomName; normal removes all four. A key that is not there is not removed again,
    // so a normal start on a file without them writes nothing at all.
    std::vector<change> changes_for(mode mode, const std::string& code, const std::vector<std::string>& present,
                                    const host_options& options = {});

    // The room list's host: Broker's host without its port ("broker.example.org:7777" ->
    // "broker.example.org", "[::1]:7777" -> "::1"), or the project broker's when Broker is empty.
    std::string rooms_host(std::string_view broker);

    // 64 hex characters, lower-cased; nullopt for anything else.
    std::optional<std::string> normalise_pin(std::string_view text);

    // The pin the room list is checked against: BrokerPin when it is one, else the project broker's.
    std::string rooms_pin(std::string_view broker_pin);
}
