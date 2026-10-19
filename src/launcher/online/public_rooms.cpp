#include "std_include.hpp"
#include "public_rooms.hpp"
#include "fix/online_rules.hpp"

#include <utils/cryptography.hpp>
#include <utils/string.hpp>

#include <thread>
#include <wincrypt.h>
#include <winhttp.h>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "crypt32.lib")

namespace public_rooms
{
    namespace
    {
        // The list is at most 50 small rooms: anything much larger is not the broker's answer.
        constexpr std::size_t max_body = 1024 * 1024;
        constexpr int timeout_ms = 5000;

        struct handle
        {
            HINTERNET value{};
            explicit handle(const HINTERNET h) : value(h) {}
            ~handle()
            {
                if (value)
                {
                    WinHttpCloseHandle(value);
                }
            }
            handle(const handle&) = delete;
            handle& operator=(const handle&) = delete;
            explicit operator bool() const { return value != nullptr; }
        };

        result failure(const std::string& error, const std::string& detail, const unsigned long status = 0)
        {
            result r{};
            r.error = error;
            r.detail = detail;
            r.status = status;
            return r;
        }

        // Why a WinHTTP step failed, in the page's words.
        result network_failure(const char* step)
        {
            const auto code = GetLastError();
            const auto detail = std::string(step) + " failed (WinHTTP error " + std::to_string(code) + ")";
            // A TLS failure other than the unknown CA (a name or date the certificate doesn't have, no TLS at
            // all): the service could not be verified.
            if (code == ERROR_WINHTTP_SECURE_FAILURE || code == ERROR_WINHTTP_SECURE_CHANNEL_ERROR ||
                code == ERROR_WINHTTP_SECURE_INVALID_CERT || code == ERROR_WINHTTP_SECURE_CERT_DATE_INVALID ||
                code == ERROR_WINHTTP_SECURE_CERT_CN_INVALID || code == ERROR_WINHTTP_SECURE_INVALID_CA ||
                code == ERROR_WINHTTP_SECURE_CERT_REV_FAILED || code == ERROR_WINHTTP_SECURE_CERT_REVOKED ||
                code == ERROR_WINHTTP_SECURE_CERT_WRONG_USAGE)
            {
                return failure("bad_pin", detail);
            }
            return failure("unreachable", detail);
        }

        // The SHA-256 (lower-case hex) of the server certificate's SubjectPublicKeyInfo, as DER: the pin's
        // form (openssl x509 -pubkey | openssl pkey -pubin -outform DER | sha256sum).
        std::optional<std::string> spki_sha256(const HINTERNET request)
        {
            PCCERT_CONTEXT cert{};
            DWORD size = sizeof(cert);
            if (!WinHttpQueryOption(request, WINHTTP_OPTION_SERVER_CERT_CONTEXT, &cert, &size) || !cert)
            {
                return std::nullopt;
            }

            std::optional<std::string> hash;
            DWORD length = 0;
            auto* info = &cert->pCertInfo->SubjectPublicKeyInfo;
            if (CryptEncodeObject(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, info, nullptr, &length) && length > 0)
            {
                std::vector<BYTE> der(length);
                if (CryptEncodeObject(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, info, der.data(), &length))
                {
                    hash = utils::string::to_lower(utils::cryptography::sha256::compute(der.data(), length, true));
                }
            }
            CertFreeCertificateContext(cert);
            return hash;
        }

        struct state
        {
            std::mutex mutex;
            bool fetching{};
            std::optional<result> last;
            std::string host;
            std::chrono::system_clock::time_point at{};
        };

        state& shared()
        {
            static state s;
            return s;
        }
    }

    result fetch(const std::string& host, const std::string& pin)
    {
        const handle session(WinHttpOpen(L"UltimateLegends", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                                         WINHTTP_NO_PROXY_BYPASS, 0));
        if (!session)
        {
            return network_failure("WinHttpOpen");
        }
        WinHttpSetTimeouts(session.value, timeout_ms, timeout_ms, timeout_ms, timeout_ms);

        const auto wide_host = utils::string::convert(host);
        const handle connection(WinHttpConnect(session.value, wide_host.c_str(), online_rules::rooms_port, 0));
        if (!connection)
        {
            return network_failure("WinHttpConnect");
        }

        const auto path = utils::string::convert(std::string(online_rules::rooms_path));
        const handle request(WinHttpOpenRequest(connection.value, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER,
                                                WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
        if (!request)
        {
            return network_failure("WinHttpOpenRequest");
        }

        // The broker's certificate is self-signed: accept an unknown CA, and only that. The pin below is what
        // trusts the server.
        DWORD flags = SECURITY_FLAG_IGNORE_UNKNOWN_CA;
        if (!WinHttpSetOption(request.value, WINHTTP_OPTION_SECURITY_FLAGS, &flags, sizeof(flags)))
        {
            return network_failure("WinHttpSetOption");
        }
        // No cookies, no credentials of the Windows user.
        DWORD no_cookies = WINHTTP_DISABLE_COOKIES;
        WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &no_cookies, sizeof(no_cookies));
        DWORD no_logon = WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH;
        WinHttpSetOption(request.value, WINHTTP_OPTION_AUTOLOGON_POLICY, &no_logon, sizeof(no_logon));

        if (!WinHttpSendRequest(request.value, L"Accept: application/json\r\n", static_cast<DWORD>(-1L), WINHTTP_NO_REQUEST_DATA, 0, 0, 0))
        {
            return network_failure("WinHttpSendRequest");
        }
        if (!WinHttpReceiveResponse(request.value, nullptr))
        {
            return network_failure("WinHttpReceiveResponse");
        }

        // The key first: nothing from a server that isn't the pinned one is read.
        const auto key = spki_sha256(request.value);
        if (!key)
        {
            return failure("bad_pin", "the server's certificate could not be read");
        }
        if (*key != pin)
        {
            return failure("bad_pin", "the server's key " + *key + " is not the pinned " + pin);
        }

        DWORD status = 0;
        DWORD status_size = sizeof(status);
        WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status,
                            &status_size, WINHTTP_NO_HEADER_INDEX);

        std::string body;
        for (;;)
        {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(request.value, &available))
            {
                return network_failure("WinHttpQueryDataAvailable");
            }
            if (available == 0)
            {
                break;
            }
            if (body.size() + available > max_body)
            {
                return failure("bad_response", "the answer is larger than " + std::to_string(max_body) + " bytes", status);
            }
            const auto offset = body.size();
            body.resize(offset + available);
            DWORD read = 0;
            if (!WinHttpReadData(request.value, body.data() + offset, available, &read))
            {
                return network_failure("WinHttpReadData");
            }
            body.resize(offset + read);
        }

        if (status == 429)
        {
            return failure("rate_limited", "HTTP 429", status);
        }
        if (status == 503)
        {
            return failure("busy", "HTTP 503: " + body.substr(0, 200), status);
        }
        if (status != 200)
        {
            return failure("bad_response", "HTTP " + std::to_string(status), status);
        }

        result r{};
        r.ok = true;
        r.status = status;
        r.body = std::move(body);
        return r;
    }

    void refresh(const std::string& host, const std::string& pin)
    {
        auto& s = shared();
        {
            std::lock_guard lock(s.mutex);
            if (s.fetching)
            {
                return;
            }
            s.fetching = true;
        }
        std::thread([host, pin]()
        {
            result r;
            try
            {
                r = fetch(host, pin);
            }
            catch (const std::exception& e)
            {
                r = failure("unreachable", e.what());
            }
            if (!r.ok)
            {
                printf("Public rooms from %s: %s (%s)\n", host.c_str(), r.error.c_str(), r.detail.c_str());
            }
            auto& state = shared();
            std::lock_guard lock(state.mutex);
            state.last = std::move(r);
            state.host = host;
            state.at = std::chrono::system_clock::now();
            state.fetching = false;
        }).detach();
    }

    snapshot current()
    {
        auto& s = shared();
        std::lock_guard lock(s.mutex);
        return {s.fetching, s.last, s.host, s.at};
    }
}
