#pragma once

#include <cstdarg>
#include <cstdio>

// The unit tests' stand-in for src/common's utils/string.hpp, for the launcher files they build that only format
// text with va() (updater/progress_tracker.cpp): the same signature, on the standard library.
namespace utils::string
{
    inline const char* va(const char* fmt, ...)
    {
        thread_local char buffer[4096];
        va_list args;
        va_start(args, fmt);
        std::vsnprintf(buffer, sizeof(buffer), fmt, args);
        va_end(args);
        return buffer;
    }
}
