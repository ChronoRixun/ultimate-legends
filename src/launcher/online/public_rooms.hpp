#pragma once

#include <chrono>
#include <optional>
#include <string>

// The public game browser's room list (contract v1.3): GET https://<broker host>:10021/v1/rooms, read
// only, no authentication. The broker's certificate is self-signed, so Windows' own check can't vouch
// for it: the pin is the trust anchor (contract v1.4). WinHTTP lets an unknown CA, a name mismatch and
// a date outside the certificate's through, and the launcher then compares the SHA-256 of the
// certificate's SubjectPublicKeyInfo with the pin (the port's [Online] BrokerPin, or the project
// broker's): those errors are accepted only when it matches. A server whose key isn't the pinned one
// is never read: its answer is dropped unread. (The request itself, a GET with no credentials or
// cookies, goes out with the handshake: acceptable, v1.4.)
//
// Commands run on CEF's IO thread, so the fetch runs on a worker of its own: refresh() starts one
// unless one is under way, and the page polls current().
namespace public_rooms
{
    struct result
    {
        bool ok{};
        // unreachable | rate_limited (429) | busy (503) | bad_pin (not the pinned key, or no TLS) |
        // bad_response (another status, or a body too large); "" when ok
        std::string error;
        std::string detail; // English, for logs
        unsigned long status{};
        std::string body; // the answer's body when ok (JSON, unchecked)
    };

    // Blocking, up to a few seconds per step.
    result fetch(const std::string& host, const std::string& pin);

    struct snapshot
    {
        bool fetching{};
        std::optional<result> last;
        std::string host; // where `last` came from
        std::chrono::system_clock::time_point at{};
    };

    // Starts a fetch on a worker thread unless one is already running.
    void refresh(const std::string& host, const std::string& pin);
    snapshot current();
}
