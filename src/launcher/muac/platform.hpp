#pragma once
#ifdef _WIN32
#include <Windows.h>
#endif

namespace muac::platform {
    inline bool is_wine() {
#ifdef _WIN32
        static const bool wine = [] {
            const auto ntdll = GetModuleHandleW(L"ntdll.dll");
            return ntdll && GetProcAddress(ntdll, "wine_get_version");
        }();
        return wine;
#else
        return false;
#endif
    }
}
