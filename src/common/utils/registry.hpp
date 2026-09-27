#pragma once

#include <optional>
#include <string>

namespace utils::registry
{
    std::optional<std::wstring> get_hkcu_string(const std::wstring& subkey, const std::wstring& value_name);

    bool set_hkcu_string(const std::wstring& subkey, const std::wstring& value_name, const std::wstring& value);
}
