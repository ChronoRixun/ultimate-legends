#include "registry.hpp"

#include <Windows.h>

namespace utils::registry
{
    std::optional<std::wstring> get_hkcu_string(const std::wstring& subkey, const std::wstring& value_name)
    {
        HKEY key{};
        if (RegOpenKeyExW(HKEY_CURRENT_USER, subkey.data(), 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS)
        {
            return std::nullopt;
        }

        DWORD type = 0;
        DWORD size = 0;
        auto status = RegQueryValueExW(key, value_name.data(), nullptr, &type, nullptr, &size);
        if (status != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ) || size == 0)
        {
            RegCloseKey(key);
            return std::nullopt;
        }

        std::wstring buffer(size / sizeof(wchar_t), L'\0');
        status = RegQueryValueExW(key, value_name.data(), nullptr, nullptr,
                                  reinterpret_cast<BYTE*>(buffer.data()), &size);
        RegCloseKey(key);

        if (status != ERROR_SUCCESS)
        {
            return std::nullopt;
        }

        buffer.resize(wcslen(buffer.c_str()));
        return buffer;
    }

    bool set_hkcu_string(const std::wstring& subkey, const std::wstring& value_name, const std::wstring& value)
    {
        HKEY key{};
        if (RegCreateKeyExW(HKEY_CURRENT_USER, subkey.data(), 0, nullptr, REG_OPTION_NON_VOLATILE,
                            KEY_WRITE, nullptr, &key, nullptr) != ERROR_SUCCESS)
        {
            return false;
        }

        const auto byte_size = static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t));
        const auto status = RegSetValueExW(key, value_name.data(), 0, REG_SZ,
                                           reinterpret_cast<const BYTE*>(value.data()), byte_size);
        RegCloseKey(key);

        return status == ERROR_SUCCESS;
    }
}
