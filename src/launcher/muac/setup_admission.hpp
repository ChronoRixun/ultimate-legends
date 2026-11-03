#pragma once
#include <functional>
#include <string>
#include <string_view>
#include <rapidjson/document.h>

namespace muac_setup::admission {
    // The caller supplies the OS process exit, not a claimed exit in stdout.
    inline int process_exit(unsigned long actual, bool killed) { return killed ? 5 : static_cast<int>(actual); }

    inline bool ready(int exit_code, bool process_cancelled, bool killed, bool cancelled,
                      std::string_view json, const std::wstring& expected,
                      const std::function<std::wstring(const std::string&)>& folder_key) {
        if (exit_code != 0 || process_cancelled || killed || cancelled) return false;
        rapidjson::Document result;
        result.Parse(json.data(), json.size());
        if (result.HasParseError() || !result.IsObject()) return false;
        for (const auto* key : {"ok", "prepared", "files_complete"}) {
            if (!result.HasMember(key) || !result[key].IsBool() || !result[key].GetBool()) return false;
        }
        if (!result.HasMember("install") || !result["install"].IsString()) return false;
        const std::string path(result["install"].GetString(), result["install"].GetStringLength());
        return !path.empty() && path.find('\0') == std::string::npos && folder_key(path) == expected;
    }
}
