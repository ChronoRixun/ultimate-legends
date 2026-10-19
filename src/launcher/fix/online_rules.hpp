#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

// Online play of the X-Men Legends port (Legends Classic 0.3.0, the XML2 Fix's broker rooms): what the
// launcher writes into the [Online] section of the port's xml2-fix.ini for the next game start. The
// launcher <-> XML2 Fix contract (v1.2) is binding:
//
//   [Online]
//   Host = broker          ; this PC hosts a room through the broker at the next game start
//   JoinCode = XXXXXXXX    ; this PC joins that room at the next game start (wins over Host)
//   Broker = host[:port]   ; the builder's defaults: the launcher never writes or removes them
//   BrokerPin = <64 hex>
//   Route = relay          ; testers only: never written either
//
// The launcher writes Host or JoinCode, always removes the other, and removes both for a normal
// (offline / LAN) start, so a later normal start never opens a room. Only those two keys: anything
// else is refused. A code is 8 characters of an alphabet without 0 O 1 I L; the player may type it in
// lower case, with spaces or dashes (it is shown as XXXX-XXXX).
//
// This part looks only at text (no ini, no Windows), so the unit tests (src/tests) build it on their
// own; fix/online_settings.hpp reads and writes the file.
namespace online_rules
{
    constexpr std::string_view code_alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    constexpr std::size_t code_length = 8;
    constexpr std::string_view host_value = "broker";

    // The [Online] keys the launcher writes, in that order. Broker, BrokerPin and Route are not among them.
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

    struct change
    {
        std::string key;
        std::optional<std::string> value; // nullopt removes the key
    };

    // The writes for a start in `mode` (`code` normalised, for join), given which of keys() the
    // section has now (`present`): host writes Host=broker and removes JoinCode, join writes JoinCode
    // and removes Host, normal removes both. A key that is not there is not removed again, so a
    // normal start on a file without them writes nothing at all.
    std::vector<change> changes_for(mode mode, const std::string& code, const std::vector<std::string>& present);
}
